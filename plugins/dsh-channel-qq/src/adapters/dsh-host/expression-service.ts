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

/** 端口注册表的键（与 `features/expression-bridge.ts` 用同一个符号）。 */
const PORT_SYMBOL = Symbol.for('dsh.companion.expression.v1')

/**
 * 最近一次解析的**结果快照**，只用于诊断（`expressionServiceState()`）。
 *
 * 它**不是**缓存：`expressionServiceOf()` 每次都用它覆盖，从不据此提前返回。
 * 之所以留这份记录，是因为「配图没发生」最需要回答的问题是「最后一次看的时候
 * 图库在不在、走的是哪一路、什么时候」——复用 `sendSticker` 的返回值解释不了这个。
 */
let lastResolved: { available: boolean; reason: string; at: number } | null = null

/**
 * 取图库服务（**绝不抛**；拿不到就 `null`）。
 *
 * 两路，**每次调用都重新走一遍**：
 *   1. `ctx.get('companionExpression')`（同子树时最直接）；
 *   2. 进程级注册表 `process[PORT_SYMBOL]`（图库把服务挂在那里；两种形态都认：
 *      裸对象 `{ version, service, … }`，或按数据根分区的 `Map<dataRoot, 那个对象>`）。
 *
 * 为什么**失败绝不缓存**（2026-11-11 修）：`companion-expression` 常常比 QQ 通道
 * 晚挂载。原实现在首次解析失败时把 `registry-miss` 永久写进模块级缓存，于是
 * 「QQ 先起来、图库后起来」这个最普通的启动顺序里，出站配图**一辈子**接不上——
 * 日志里只会看到 `no-service`，而模块其实早就就绪了。
 *
 * 同理，成功结果也**不能**无限信任：图库被卸载/重新挂载后是新对象，旧对象上的
 * `reply` 不再是当下那个服务。所以缓存只是「这一次解析成功后留个记录」，
 * 下一次调用照样先问两路；只有这两路都拿不到时才返回 `null`（并把缓存清掉，
 * 免得诊断里看到一个其实已经不存在的服务）。
 *
 * @param context 取宿主上下文的函数（`host.bridge.tagContext()` 之类）；抛错按"没有"处理
 */
export function expressionServiceOf(context: () => unknown): { service: ExpressionService | null; reason: string } {
  const viaContext = resolveFromContext(context)
  if (viaContext !== null) {
    record(true, 'ctx')
    return { service: viaContext, reason: 'ctx' }
  }
  const viaRegistry = resolveFromRegistry()
  if (viaRegistry.service !== null) {
    record(true, viaRegistry.reason)
    return { service: viaRegistry.service, reason: viaRegistry.reason }
  }
  // 两路都没接上：**不缓存**这次失败（否则后挂载就永远看不到）。
  record(false, viaRegistry.reason)
  return { service: null, reason: viaRegistry.reason }
}

/** 记下这一次解析的结局（诊断用；永不抛、永不参与判定）。 */
function record(available: boolean, reason: string): void {
  try {
    lastResolved = { available, reason, at: Date.now() }
  } catch {
    /* 诊断失败不影响任何东西 */
  }
}

/**
 * 出站表情服务的**最后已知状态**（只读诊断；不含路径、URL、token、消息内容）。
 *
 * 字段刻意只有四个：能不能发、为什么、什么时候看的、以及服务面暴露了哪些能力。
 * 后台「表情包」页与 `npm run doctor` 的输出都从这里取，避免两处各写一套口径。
 *
 * `capabilities` 是从服务对象上**探测**到的函数名（`candidates`/`reply` 必有；
 * `stickerNote`/`stats` 等有就列出来）——它回答「这个服务是不是完整的那一个」，
 * 而不是「它这次发了什么」。
 */
export function expressionServiceState(): {
  available: boolean
  reason: string
  checkedAt: number
  capabilities: string[]
} {
  const snapshot = lastResolved
  return {
    available: snapshot?.available === true,
    reason: snapshot?.reason ?? 'never-resolved',
    checkedAt: snapshot?.at ?? 0,
    capabilities: lastResolved?.available === true ? probeCapabilities() : [],
  }
}

/** 探测当前进程里那个服务面有哪些能力（只读；拿不到就是空数组）。 */
function probeCapabilities(): string[] {
  try {
    const raw: unknown = Reflect.get(process, PORT_SYMBOL)
    const holder = raw instanceof Map ? raw.values().next().value : raw
    const service = (holder as { service?: unknown } | null | undefined)?.service ?? holder
    if (service === null || typeof service !== 'object') return []
    const names = ['candidates', 'reply', 'feedback', 'stats', 'stickerNote', 'observe', 'offers']
    return names.filter((name) => typeof (service as Record<string, unknown>)[name] === 'function')
  } catch {
    return []
  }
}

/** 第一路：`ctx.get('companionExpression')`。读不到/抛错/形状不对都返回 `null`。 */
function resolveFromContext(context: () => unknown): ExpressionService | null {
  try {
    const ctx = context() as { get?: (name: string) => unknown } | null | undefined
    if (typeof ctx?.get !== 'function') return null
    return asExpressionService(ctx.get('companionExpression'))
  } catch {
    return null
  }
}

/**
 * 第二路：进程级注册表。
 *
 * 键是数据根（与图库 publish 时一致）。`DSH_COMPANION_DATA_DIR` 没设时注册表通常
 * 是裸对象；如果它仍然是个 `Map` 且**只有一个**分区，就用那一个——单进程单数据根
 * 是最常见的部署形态，而这时拿不到服务只可能是"还没挂载"，不是"有歧义"。
 */
function resolveFromRegistry(): { service: ExpressionService | null; reason: string } {
  let raw: unknown
  try {
    raw = Reflect.get(process, PORT_SYMBOL)
  } catch {
    return { service: null, reason: 'registry-threw' }
  }
  if (raw === undefined || raw === null) return { service: null, reason: 'registry-miss' }
  if (!(raw instanceof Map)) {
    const service = asExpressionService((raw as { service?: unknown }).service ?? raw)
    return service === null ? { service: null, reason: 'registry-shape' } : { service, reason: 'registry' }
  }
  const key = String(process.env.DSH_COMPANION_DATA_DIR ?? '').trim()
  const candidates: string[] = [key]
  if (key === '' && raw.size === 1) {
    const only = raw.keys().next()
    if (only.done !== true && typeof only.value === 'string') candidates.push(only.value)
  }
  for (const candidate of candidates) {
    const entry = raw.get(candidate)
    const service = asExpressionService((entry as { service?: unknown } | null | undefined)?.service ?? entry)
    if (service !== null) return { service, reason: 'registry' }
  }
  return { service: null, reason: 'registry-miss' }
}

/** 形状判定：两个方法都是函数才算接上。 */
function asExpressionService(raw: unknown): ExpressionService | null {
  if (raw === null || typeof raw !== 'object') return null
  const shape = raw as { candidates?: unknown; reply?: unknown }
  if (typeof shape.candidates !== 'function' || typeof shape.reply !== 'function') return null
  return shape as ExpressionService
}

/** 测试用：丢掉诊断快照（缓存已经不存在，保留这个导出是为了不破坏调用方）。 */
export function resetExpressionServiceCache(): void {
  lastResolved = null
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
