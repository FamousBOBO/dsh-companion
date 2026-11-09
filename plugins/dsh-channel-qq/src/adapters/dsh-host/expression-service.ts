/** 群聊**表情包**的消费端（P4 §8.2）：问图库要候选、按图库的策略发一张。
 *
 * 与 `expression-bridge.ts` 的关系：那个文件是**入站**旁路（把群友的表情元数据递给图库，
 * 让它学会"这张在这个群是什么意思"），本文件是**出站**（她要不要、以及能不能发一张）。
 * 两个方向共用同一枚进程级 symbol，但读的是不同的服务面：
 *
 *   - 入站：`{ version, ingest/observe, offers }`
 *   - 出站：`ctx.get('companionExpression')` 或图库的 `service`（`candidates/reply`）
 *
 * 三条不可谈判的边界（都来自图库自己的设计，这里只是遵守它）：
 *   1. **不接受路径参数**：只传 `assetId` / `mode` / `text` / `target`，绝不拼 stage 路径或 URL；
 *   2. **能不能发由图库决定**：它的 `delivery.enabled` 默认 false，未授权/冷却/审核未过都会
 *      返回 `send:false`——这里**不重试、不绕过**，直接吞下理由；
 *   3. **没有回执不算发过**：`reply` 的返回里没有 `messageId` 就当没发（与文字同一条口径）。
 */

import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 图库服务的最小面（`companionExpression`）。 */
export interface ExpressionService {
  candidates(input: { isGroup: boolean; target: string; query: string; limit?: number }): unknown
  reply(input: {
    assetId: string
    mode: string
    text?: string
    isGroup: boolean
    target: string
  }): unknown
}

/** 一次发图的结局：发出去了（带回执）/ 图库说不发 / 没有图库。 */
export type StickerOutcome =
  | { readonly kind: 'sent'; readonly messageId: number; readonly assetId: string }
  | { readonly kind: 'declined'; readonly reason: string }
  | { readonly kind: 'unavailable'; readonly reason: string }

/** 一次发图尝试的输入。 */
export interface StickerAttempt {
  readonly groupId: number
  readonly query: string
  readonly text: string
  readonly mode: 'sticker_only' | 'text_then_sticker'
  readonly log: (line: string) => void
}

let cached: { service: ExpressionService | null; reason: string } | null = null

/**
 * 取图库服务（**绝不抛**；拿不到就 `null`）。
 *
 * 两路：`ctx.get('companionExpression')`（同子树时最直接）→ 进程级注册表的裸键
 * （图库把服务挂在 `process[PORT_SYMBOL]` 上，形状是 `{ version, service, candidates… }`）。
 */
export function expressionServiceOf(context: () => unknown): { service: ExpressionService | null; reason: string } {
  if (cached !== null) return cached
  try {
    const ctx = context() as { get?: (name: string) => unknown } | null | undefined
    if (typeof ctx?.get === 'function') {
      const local = asExpressionService(ctx.get('companionExpression'))
      if (local !== null) {
        cached = { service: local, reason: 'ctx' }
        return cached
      }
    }
  } catch {
    /* 继续试注册表 */
  }
  try {
    const holder: unknown = Reflect.get(process, Symbol.for('dsh.companion.expression.v1'))
    const raw = holder instanceof Map
      ? holder.get(String(process.env.DSH_COMPANION_DATA_DIR ?? ''))
      : holder
    const service = asExpressionService((raw as { service?: unknown } | null)?.service ?? raw)
    cached = service === null ? { service: null, reason: 'registry-miss' } : { service, reason: 'registry' }
    return cached
  } catch {
    cached = { service: null, reason: 'registry-threw' }
    return cached
  }
}

/** 形状判定：两个方法都是函数才算接上。 */
function asExpressionService(raw: unknown): ExpressionService | null {
  if (raw === null || typeof raw !== 'object') return null
  const shape = raw as { candidates?: unknown; reply?: unknown }
  if (typeof shape.candidates !== 'function' || typeof shape.reply !== 'function') return null
  return shape as ExpressionService
}

/** 测试用：丢掉缓存。 */
export function resetExpressionServiceCache(): void {
  cached = null
}

/**
 * 试着发一张图。
 *
 * 顺序刻意是"先问候选、再让它发"：图库的 `candidates` 会返回 `send` 与 `abstain`，
 * 直接 `reply` 一个它没推荐过的 id 等于绕过它的策略（授权、冷却、审核都在那里面）。
 */
export function sendSticker(service: ExpressionService | null, attempt: StickerAttempt): StickerOutcome {
  if (service === null) return { kind: 'unavailable', reason: 'no-service' }
  let assetId = ''
  try {
    const found = service.candidates({ isGroup: true, target: String(attempt.groupId), query: attempt.query, limit: 3 }) as {
      ok?: boolean
      candidates?: Array<{ assetId?: unknown }>
      reasonCode?: unknown
    }
    if (found?.ok !== true) return { kind: 'declined', reason: String(found?.reasonCode ?? 'candidates-failed') }
    const first = Array.isArray(found.candidates) ? found.candidates[0] : undefined
    const candidate = typeof first?.assetId === 'string' ? first.assetId : ''
    // 图库没给候选就是"这个群没有贴题的图"——不做"随便挑一张"的兜底。
    if (candidate === '') return { kind: 'declined', reason: 'no-candidate' }
    assetId = candidate
  } catch (error) {
    attempt.log(`presence: 群 ${String(attempt.groupId)} 表情候选检索抛错（已忽略）：${describe(error)}`)
    return { kind: 'unavailable', reason: 'candidates-threw' }
  }
  try {
    const sent = service.reply({
      assetId,
      mode: attempt.mode,
      ...(attempt.mode === 'text_then_sticker' ? { text: attempt.text } : {}),
      isGroup: true,
      target: String(attempt.groupId),
    }) as { ok?: boolean; messageId?: unknown; reasonCode?: unknown; delivered?: unknown }
    if (sent?.ok !== true) return { kind: 'declined', reason: String(sent?.reasonCode ?? 'reply-failed') }
    const messageId = typeof sent.messageId === 'number' ? sent.messageId : Number(sent.messageId)
    if (!Number.isSafeInteger(messageId) || messageId <= 0) {
      // 没有回执：不算发过（与文字同一条口径），也不重试。
      return { kind: 'declined', reason: 'no-receipt' }
    }
    attempt.log(`presence: 群 ${String(attempt.groupId)} 发了一张表情包 ${assetId} #${String(messageId)}`)
    return { kind: 'sent', messageId, assetId }
  } catch (error) {
    attempt.log(`presence: 群 ${String(attempt.groupId)} 表情发送抛错（已忽略）：${describe(error)}`)
    return { kind: 'unavailable', reason: 'reply-threw' }
  }
}

/** 找一个 `companion-expression` 的入口文件（找不到就是没有；不猜路径）。 */
export function findExpressionModule(): string | null {
  try {
    let dir = path.dirname(fileURLToPath(import.meta.url))
    for (let i = 0; i < 8; i += 1) {
      const sibling = path.join(path.dirname(dir), 'companion-expression', 'index.mjs')
      if (existsSync(sibling)) return sibling
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch {
    /* 找不到就是没有 */
  }
  return null
}

/** 保留：某些布局下图库只能靠 require 加载（当前未使用，导出供诊断）。 */
export function requireExpressionModule(): unknown {
  const file = findExpressionModule()
  if (file === null) return null
  try {
    return createRequire(import.meta.url)(file)
  } catch {
    return null
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
