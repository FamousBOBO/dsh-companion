import { readFileSync } from 'node:fs'
import { dmRoom } from '../../core/room.js'
import * as path from 'node:path'
/** 分享候选 → contact 的**唯一**入口（P2.5-3B 前置）。
 *
 * 背景（A5 审计）：runtime 把候选写进 `p2_share_candidates` 与 `share-candidates.jsonl`，
 * 但**消费端 0%**——因为 contact 的服务只注册进自己的 ServiceBag，到不了 DSH ctx，
 * foundation 的 `contactSharePort` 用 `ctx.get('companionContactShare') ?? ctx.get('companionContact')`
 * 永远取不到，只能退化成 JSONL sink（没人读）。
 *
 * 这个文件只做一件事：把"runtime 递过来的分享候选"翻译成 contact **已有的**候选提交
 * （`ContactService.propose()`），再让既有 worker 走一次闸门/账本/outbox。**没有新的发送路径**。
 *
 * 三条硬约束（写在类型里，也写在行为里）：
 *   1. **开关先行**：`p2.share.enabled !== true`（生产就是 false）⇒ 直接 `share-disabled`，
 *      连候选都不建、更不碰 outbox；
 *   2. **永不抛错**：这是跨插件调用，抛错会把 runtime 的候选生产搞挂 ⇒ 一律翻译成
 *      `{ok:false, code:'internal', reason}`；
 *   3. **如实回话**：闸门拦下时把真实 reason 带回去（`quiet-hours` / `quota:global` /
 *      `cooldown:room` / `draft:unavailable`…），不要编一个"已提交"。
 */

import type { ContactAuthorization, ContactScope, ContactTarget, ProposeContactInput, ProposeContactResult } from './types.js'

/** runtime 递过来的候选（形状取自 `companion-runtime/lib/p2.mjs::submitShareCandidate` 的 `port.submit({...})`）。 */
export interface ShareCandidate {
  readonly scope?: string
  readonly candidateId?: string
  readonly kind?: string
  readonly title?: string
  readonly body?: string
  readonly sourceRef?: string
}

/** 回给 runtime 的结论（它只认 `ok` 与 `code`：`ok=false` 会把候选标成 rejected）。 */
export interface SubmitShareResult {
  readonly ok: boolean
  readonly code?: string
  readonly reason?: string
}

export interface SharePortDeps {
  /** **活取**开关：runtime 的 `p2.share.enabled`（生产 false）。每次提交都读，不缓存。 */
  readonly enabled: () => boolean
  /** contact 既有的候选入口（`ContactService.propose`）。 */
  readonly propose: (input: ProposeContactInput) => Promise<ProposeContactResult>
  /** 让既有 worker 立刻跑一拍（闸门 → 起草 → outbox）。不新开发送路径。 */
  readonly attempt: () => Promise<void>
  /** 候选要落到哪个房间（当前实现：绑定主人私聊）。 */
  readonly target: () => { readonly scope: ContactScope; readonly target: ContactTarget; readonly authorization: ContactAuthorization } | null
  readonly now: () => number
  readonly log: (line: string) => void
  /** 分享候选在池里最多等多久（毫秒；来自 contact.shareTtlMs，缺省 6 小时）。 */
  readonly ttlMs?: () => number
  /**
   * 共享闸门（可选）：拒绝时用来拿真实原因（终审 B6）。纯判定、不消耗任何东西；
   * 拿不到就回落 rejected（绝不编一个可重试的假原因）。
   */
  readonly budget?: (room: string) => Promise<{ readonly allowed: boolean; readonly reason?: string }>
}

/** 发布的端口面：既有 `submitShare`，也提供 foundation 实际探测的 `submitShareCandidate`。 */
export interface SharePort {
  submitShare: (candidate: ShareCandidate) => Promise<SubmitShareResult>
  submitShareCandidate: (candidate: ShareCandidate) => Promise<SubmitShareResult>
}

/**
 * 一条分享候选在 contact 里活多久；过了就自动过期（不让分享意图无限期悬着）。
 *
 * 默认 6 小时，理由写在配置字段 `contact.shareTtlMs` 的 help 里：分享有时效
 * （"这一会儿想给你看的东西"），但太短会被免打扰/冷却这类**正常等待**把候选等死。
 * 可配置；这里只留默认与下限兜底。
 */
const DEFAULT_TTL_MS = 6 * 3600_000
const MIN_TTL_MS = 60_000

/** 配置里的有效期（缺省/坏值回落默认，且不低于 1 分钟）。 */
function ttlOf(deps: SharePortDeps): number {
  const raw = deps.ttlMs?.() ?? DEFAULT_TTL_MS
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TTL_MS
  return Math.max(MIN_TTL_MS, Math.round(raw))
}

/**
 * 造端口。**所有分支都不抛错**（跨插件边界）。
 *
 * 退避顺序固定：开关 → 取目标 → 建候选（幂等 dedupe）→ 跑一拍闸门 → 如实回话。
 */
/**
 * 拒绝时问一次共享闸门，把**真实原因**带回去（终审 B6）。
 *
 * 为什么不能一律 `rejected`：runtime 有一张 retryable 表（`quiet-hours` / `quota:*` /
 * `cooldown:*` / `rate-limited` / `timeout`），压成 `rejected` 就等于告诉它"别重试了"，
 * 候选被永久丢掉。这里只做**只读判定**：`outboundBudget` 不消耗配额、不写账本；
 * 问不出来就返回空串（绝不编一个"可重试"的假原因）。
 */
async function gateReasonOf(deps: SharePortDeps, room: string): Promise<string> {
  if (deps.budget === undefined) return ''
  try {
    const verdict = await deps.budget(room)
    if (verdict !== null && verdict !== undefined && verdict.allowed === false
      && typeof verdict.reason === 'string' && verdict.reason !== '') {
      return verdict.reason
    }
    return ''
  } catch {
    return ''
  }
}

export function createSharePort(deps: SharePortDeps): SharePort {
  const submitShare = async (candidate: ShareCandidate): Promise<SubmitShareResult> => {
    try {
      if (!deps.enabled()) {
        // 生产就是这条：候选只留在 runtime 的库里，QQ 侧**一条都不发**。
        return { ok: false, code: 'share-disabled', reason: '分享开关关闭（p2.share.enabled=false），不外发' }
      }
      const where = deps.target()
      if (where === null) {
        return { ok: false, code: 'no-target', reason: '没有可用的分享房间（主人私聊未绑定）' }
      }
      const now = deps.now()
      const id = String(candidate.candidateId ?? '').trim()
      const title = String(candidate.title ?? '').trim().slice(0, 200)
      if (title === '') return { ok: false, code: 'invalid-input', reason: '候选没有标题' }
      const proposed = await deps.propose({
        // 账本词表里给分享预留的就是 `share-intent`（`contact/ledger.ts` 的 SOURCES 白名单）。
        source: 'share-intent',
        reason: title,
        // 诊断面要能一眼看出这条来自 P2 分享链（任务书里的 `p2-share` 落在证据来源上）。
        evidenceSource: 'p2-share',
        evidenceIds: id === '' ? [] : [id],
        scope: where.scope,
        target: where.target,
        earliestAt: now,
        expiresAt: now + ttlOf(deps),
        // 幂等键按候选 id：同一条候选重复提交不会在账本里长出第二条。
        dedupeKey: id === '' ? `share:${title}` : `share:${id}`,
        authorization: where.authorization,
      })
      // 既有 worker 跑一拍：闸门（免打扰/配额/冷却/dedupe/通道）在这里生效。
      await deps.attempt()
      const note = String(proposed.note ?? '').slice(0, 160)
      deps.log(`share: 候选 ${id || '(无 id)'} → contact ${proposed.outcome}${note === '' ? '' : `（${note}）`}`)
      if (proposed.outcome !== 'rejected') {
        return {
          ok: true,
          code: proposed.outcome === 'duplicate' ? 'duplicate' : 'accepted',
          ...(note === '' ? {} : { reason: note }),
        }
      }
      // **终审 B6**：拒绝时把**真实原因**透传出去，别一律压成 `rejected`。
      // runtime 有一张 retryable 表（`quiet-hours` / `quota:*` / `cooldown:*` / `rate-limited` /
      // `timeout`）——压成 `rejected` 就把"过一会儿还能发"当成了终态，候选被永久丢掉。
      // 先问一次共享闸门（不消耗任何东西），把它的 reason 作为 code 返回；问不出再回落 `rejected`。
      const gate = await gateReasonOf(deps, where.target.room)
      const code = gate !== '' ? gate : 'rejected'
      return { ok: false, code, reason: note === '' ? code : note }
    } catch (error) {
      // 跨插件调用：抛错会把 runtime 的候选生产搞挂，所以一律吞掉并如实说"内部错误"。
      const message = error instanceof Error ? error.message : String(error)
      deps.log(`share: 提交候选失败（对外报 internal）：${message}`)
      return { ok: false, code: 'internal', reason: message.slice(0, 200) }
    }
  }
  return { submitShare, submitShareCandidate: submitShare }
}

/**
 * 读 runtime 的分享开关（`<dshHome>/home/companion/runtime.config.json` 的 `p2.share.enabled`）。
 *
 * **只读**，读不到就是 `false`（生产现状）——绝不因为读失败就放行。
 * 用 `readFileSync` 而不是缓存：UI/运维改完开关，下一次提交就要生效。
 */
export function readShareEnabled(configPath: string, read: (file: string) => string = (file) => readFileSync(file, 'utf8')): boolean {
  try {
    const parsed = JSON.parse(read(configPath)) as { p2?: { share?: { enabled?: unknown } } }
    return parsed?.p2?.share?.enabled === true
  } catch {
    return false
  }
}

/** runtime 配置文件的位置（`dshHome/home/companion/runtime.config.json`）。 */
export function runtimeConfigPath(dshHome: string): string {
  return path.join(dshHome, 'home', 'companion', 'runtime.config.json')
}

/**
 * 分享候选落到哪个房间：**绑定主人的私聊**。
 *
 * 为什么是私聊：分享是"她想给主人看的东西"，不是群聊发言；群发要另外的授权语境。
 * 没有主人（`admins` 为空）⇒ 返回 null，端口如实回 `no-target`，不猜房间。
 */
export function shareTargetOf(input: {
  readonly owner: number | undefined
  readonly personaId: string
}): { scope: ContactScope; target: ContactTarget; authorization: ContactAuthorization } | null {
  const owner = input.owner
  if (owner === undefined || !Number.isFinite(owner) || owner <= 0) return null
  const now = Date.now()
  return {
    scope: { userId: owner, personaId: input.personaId, worldId: '' },
    target: { channel: 'qq', room: dmRoom(owner), isGroup: false, chatId: owner },
    // 分享链的授权是"她自己决定分享"（standing），不是用户原话，所以 kind 不能写 explicit。
    authorization: { kind: 'standing', by: owner, at: now, quote: null },
  }
}

/** 装配侧用的一步到位工厂（让 `contact/index.ts` 只多两行，别把那个文件撑过 400 行）。 */
export function sharePortFor(input: {
  readonly dshHome: string
  readonly owner: number | undefined
  readonly personaId: string
  readonly propose: (candidate: ProposeContactInput) => Promise<ProposeContactResult>
  readonly tick: () => Promise<void>
  /** 共享闸门（只读判定）：被拒时用它把真实原因透传给 runtime（终审 B6）。 */
  readonly budget?: (room: string) => Promise<{ readonly allowed: boolean; readonly reason?: string }>
  readonly now: () => number
  readonly log: (line: string) => void
  /** 分享候选在池里最多等多久（毫秒；来自 contact.shareTtlMs，缺省 6 小时）。 */
  readonly ttlMs?: () => number
}): SharePort {
  const configPath = runtimeConfigPath(input.dshHome)
  return createSharePort({
    enabled: () => readShareEnabled(configPath),
    propose: input.propose,
    attempt: input.tick,
    target: () => shareTargetOf({ owner: input.owner, personaId: input.personaId }),
    now: input.now,
    log: input.log,
    ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
    ...(input.budget === undefined ? {} : { budget: input.budget }),
  })
}
