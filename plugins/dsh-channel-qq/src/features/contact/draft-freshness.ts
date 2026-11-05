import { contextBudgetFor } from './draft-budget.js'
/** 起草**新鲜度**（Codex 预发布审查 P1/R5）：把"起草那一刻的世界"冻成可比较的 `revision`，
 *  在**发送前**逐项复核；对不齐就作废这份草稿。
 *
 * 为什么需要这个文件：C0 第一版只比了两个 `>`（`candidate.updatedAt > draftedAt`、
 * `lastUserMessageAt > draftedAt`）。审查指出四个漏网场景，全都不是"时间更大"能表达的：
 *
 * | 场景 | 为什么旧闸拦不住 | 现在靠什么 |
 * |---|---|---|
 * | **同毫秒 patch**（证据合并与起草落在同一毫秒） | `updatedAt > draftedAt` 为假 | `candidate.version !== 冻结版本`（每次 patch 必 +1） |
 * | **同秒入站消息**（`record.lastEvent.time` 是**秒**级） | 时间戳相等，`>` 不成立 | 房间游标 `queueDepth`（`registry` 里未成包的行数）+ `lastUserAt` **相等性**比较 |
 * | **会话/绑定重绑**（room/chatId/persona/world 换了） | 时间戳完全不变 | `binding` 逐项比较 |
 * | **人设更新 / 证据正文修订**（未 patch 候选的源资料变了） | 候选上没有任何时间戳变 | `personaDigest`（发送前重读 preset 文档）+ `historyCursor`（条数@尾条时刻#尾条摘要） |
 *
 * 三条纪律：
 *   1. **缺失 = 拒绝**：`revision` 整个缺席、或其中某项是空串（`NO_FROZEN_VALUE`）时记
 *      `draft:stale:unverifiable`，**不放行**。C0 的 `direct` 装配由 `requireDraftRevision`
 *      强制要求带上 revision（`index.ts`），漏接会当场被拦。
 *   2. **复核不做网络往返**：异步那一段只读 preset 文件与 history **缓存**（`collect:false`）。
 *      一次检索（`memoryEvidence`）可能打远端 rerank，因此**记忆正文不做发送前复核**——
 *      这是有意的取舍，见 REPORT 的残余风险。
 *   3. **同步闸永远是最后一道**：`precheck.finalSyncGuard` 里跑的是 {@link compareRevision}
 *      的同步部分（零 `await`）；异步部分只在 `recheckAtSend` 里、`finalSyncGuard` 之前。
 */

import { DRAFT_CONTEXT_BUDGET } from './draft-context.js'
import { historyOf, personaOf } from './draft-readers.js'
import type { DraftBinding, DraftContextDeps, DraftRevision } from './draft-context.js'
import type { ContactGuardVerdict, ContactSendRequest } from './sender.js'
import type { ContactCandidate, ContactRuntimeFacts } from './types.js'

/**
 * 缺失哨兵：`revision` 里任何一项等于它，就表示"起草时这一项本来就没有/没有采到"，
 * 复核时**无法比较** → 保守拒绝（`draft:stale:unverifiable`）。
 */
export const NO_FROZEN_VALUE = ''

/** 32 位 FNV-1a（纯函数、零依赖、跨进程稳定）。只用来"发现内容变了"，不当安全哈希。 */
export function digestOf(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * 历史尾游标：`<条数>@<尾条时刻>#<尾条正文摘要>`。
 *
 * 为什么不能只存"最后一条的时间"：`record.lastEvent.time` 是秒级，而历史条目也是秒级，
 * 两条消息落在同一秒时时间戳完全相同；正文摘要才是"内容真的变了"的证据。
 * 空历史返回 `0`（唯一合法值——空历史不可能起草出草稿，见 `sufficientContext`）。
 */
export function historyCursorOf(history: readonly { readonly at: number; readonly text: string; readonly id?: string }[]): string {
  const tail = history[history.length - 1]
  if (tail === undefined) return '0'
  return `${String(history.length)}@${String(tail.at)}#${digestOf(tail.text + (tail.id ?? ''))}`
}

/** 绑定是否与起草时一致（房间 / 收件人 / 群私 / 人格 / 世界）。 */
export function sameBinding(binding: DraftBinding, candidate: ContactCandidate): boolean {
  return binding.room === candidate.target.room
    && binding.chatId === candidate.target.chatId
    && binding.isGroup === candidate.target.isGroup
    && binding.personaId === candidate.scope.personaId
    && binding.worldId === candidate.scope.worldId
}

/**
 * **冻结**起草那一刻的世界（`buildDraftContext` 唯一调用点）。
 *
 * 摘要取的是**模型实际看到的那份内容**（人设已截断、历史已裁剪），所以"人设只改了被截掉
 * 的那一段"不会误判成过期——判据要跟"看到的东西"对齐。
 */
export function freezeRevision(
  candidate: ContactCandidate,
  seen: { readonly persona: string | null; readonly history: readonly { readonly at: number; readonly text: string }[] },
  facts: { readonly lastUserMessageAt: number | null; readonly queueDepth?: number | null } | undefined,
): DraftRevision {
  const lastUserAt = facts?.lastUserMessageAt ?? null
  return {
    candidateVersion: candidate.version,
    candidateUpdatedAt: candidate.updatedAt,
    lastUserAt,
    binding: {
      room: candidate.target.room,
      chatId: candidate.target.chatId,
      isGroup: candidate.target.isGroup,
      personaId: candidate.scope.personaId,
      worldId: candidate.scope.worldId,
    },
    roomCursor: { lastUserAt, queueDepth: facts?.queueDepth ?? null },
    personaDigest: seen.persona === null ? NO_FROZEN_VALUE : digestOf(seen.persona),
    historyCursor: historyCursorOf(seen.history),
  }
}

/**
 * **同步**部分的复核（零 `await`，可在 `finalSyncGuard` 里跑）。
 *
 * 返回 `null` = 与起草时一致；否则是"如果现在停下该记成什么"（一律 `deferred`：下一拍
 * 会重新起草，候选不丢）。
 */
export function compareRevision(
  req: ContactSendRequest,
  candidate: ContactCandidate,
  runtime: ContactRuntimeFacts,
): ContactGuardVerdict | null {
  const frozen = req.revision
  const room = req.delivery.target.room
  const lastUserAt = runtime.lastUserMessageAtByRoom[room] ?? null
  const draftedAt = req.draftedAt ?? req.now
  if (frozen === undefined) {
    // 没有任何冻结版本 = **无法比较**。C0 的 direct 装配要求必须有（见 `freshnessIssue`
    // 的 `requireRevision`）：那条路径下这里会先被拦掉，走不到这两个旧判据。
    if (candidate.updatedAt > draftedAt) return stale('draft:stale')
    return lastUserAt !== null && lastUserAt > draftedAt ? stale('draft:stale:new-message') : null
  }
  // ① 候选被 patch 过：version 是**每次必 +1** 的，能抓住同一毫秒内的改动。
  if (candidate.version !== frozen.candidateVersion) return stale('draft:stale:version')
  // ② 候选时间戳变了（内容不变也算变化——保守）。
  if (candidate.updatedAt !== frozen.candidateUpdatedAt) return stale('draft:stale:patched')
  // ③ 房间里来人了：时刻与"未成包行数"一起比，覆盖同秒消息与乱序到达。
  const queueDepth = runtime.queueDepthByRoom?.[room] ?? null
  if (lastUserAt !== frozen.roomCursor.lastUserAt || queueDepth !== frozen.roomCursor.queueDepth) {
    return stale('draft:stale:new-message')
  }
  // ④ 会话/绑定重绑（换房间、换人格、换世界）。
  if (!sameBinding(frozen.binding, candidate)) return stale('draft:stale:binding')
  // ⑤ 冻结值本身缺失 ⇒ 无法比较 ⇒ 拒绝（不许静默放行）。
  if (frozen.personaDigest === NO_FROZEN_VALUE) return stale('draft:stale:unverifiable')
  if (frozen.historyCursor === NO_FROZEN_VALUE) return stale('draft:stale:unverifiable')
  return null
}

/**
 * **异步**部分的复核（只读廉价资料）：人设文档是否被改过、历史缓存是否长出新东西。
 *
 * 装配侧注入到 `ContactSenderDeps.verifyDraft`，只在 `recheckAtSend`（执行点、`finalSyncGuard`
 * **之前**）跑一次；没有 `revision`（`turn` 模式、历史用例）时直接放行，由同步闸按老口径判。
 */
export function createRevisionVerifier(deps: DraftContextDeps): (req: ContactSendRequest) => Promise<ContactGuardVerdict | null> {
  return async (req) => {
    const frozen = req.revision
    if (frozen === undefined) return null
    const persona = await personaOf(deps, req.candidate.scope.personaId, DRAFT_CONTEXT_BUDGET.personaChars)
    const nowDigest = persona.persona === null ? NO_FROZEN_VALUE : digestOf(persona.persona.document)
    if (nowDigest !== frozen.personaDigest) return stale('draft:stale:persona')
    const budget = contextBudgetFor(req.candidate)
    const history = await historyOf(
      deps,
      req.candidate,
      budget.historyLines,
      budget.historyChars,
      budget.lineChars,
      { collect: false },
    )
    if (historyCursorOf(history.history) !== frozen.historyCursor) return stale('draft:stale:history')
    return null
  }
}

function stale(detail: string): ContactGuardVerdict {
  return { state: 'deferred', detail }
}
