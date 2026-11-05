/** 账本的状态迁移：**只改账本、只调 store**，不知道门控、不知道发送、不持定时器。
 *
 * 从 `worker.ts` 拆出来的判据：worker 管"什么时候看、看几条、按什么顺序"；这些函数管
 * "看到之后账本该变成什么样"。它们的共同输入只有 `(store, 配置, 现在, 代次)`，所以
 * 可以在没有 sender、没有平台、没有定时器的测试里逐条复现——这正是它们的价值：
 * 状态机是这套东西里最该被钉住的部分（"取消/过期不复活"、"跨日归零"、"未回复退避"）。
 *
 * 两条贯穿的规则：
 *   1. **同一个原因连续出现只写一次盘**（`deferCandidate`）：夜里一条被免打扰挡住的候选
 *      每分钟写一次盘、写一行日志，信息量是零；
 *   2. **记原因要能 grep**：`recentReasons` 里的字符串是稳定词表（`drop:<reason>` /
 *      `defer:<reason>` / `sent:<state>` / `<id> <reason>`），不拼花文本——面板与验收
 *      脚本都按它断言。
 */

import type { ContactConfig } from '../../config/sections/contact.js'
import { StaleLeaseError, type ContactStore } from './store.js'
import type { ContactCandidate, ContactCandidateState, ContactDelivery, ContactDeliveryState } from './types.js'

/** 一个房间的现取事实（由 index 从 platform/inbound 取，本文件不碰宿主）。 */
export interface ContactRoomFacts {
  readonly connected: boolean
  readonly roomBound: boolean
  readonly turnRunning: boolean
  readonly lastUserMessageAt: number | null
  /** 尚未成包的入站行数（秒级时间戳之外的第二个游标，见 `ContactRuntimeFacts.queueDepthByRoom`）。 */
  readonly queueDepth?: number | null
}

/** 迁移函数共用的依赖：只有账本、日志与"怎么问房间"。 */
export interface TransitionDeps {
  readonly store: ContactStore
  readonly log: (line: string) => void
  readonly roomFacts: (room: string) => ContactRoomFacts
  /** 同一条投递最多试几次（超过就放弃这条候选）。 */
  readonly maxSendAttempts: number
}

/**
 * 过期与补算视界：标过期、**不发**。
 *
 * `maxCatchupHours = 0` = **关闭**补算视界判定（与 `gate.ts` 的 `horizonMs > 0` 同一口径：
 * 同一个字段在两边含义不一致，就是"配了却没按预期生效"的来源）。
 */
export async function expireStale(
  deps: TransitionDeps,
  now: number,
  epoch: number,
  config: ContactConfig,
): Promise<number> {
  const hours = config.maxCatchupHours
  const horizon = hours > 0 ? now - hours * 3_600_000 : null
  let expired = 0
  for (const candidate of deps.store.listCandidates()) {
    if (candidate.state !== 'pending' && candidate.state !== 'deferred') continue
    const overdue = now >= candidate.expiresAt
    const stale = horizon !== null && candidate.earliestAt < horizon
    if (!overdue && !stale) continue
    const reason = overdue ? 'expired' : 'stale:restart'
    await deps.store.patchCandidate(candidate.id, { state: 'expired', lastSuppressedReason: reason }, now, epoch)
    await deps.store.noteReason(`${candidate.id} ${reason}`, now, epoch)
    deps.log(`contact: 候选 ${candidate.id} 判过期（${reason}），不补发`)
    expired += 1
  }
  return expired
}

/** 候选池上限：超了先丢低优先级、再丢早过期的（`maxCandidates`）。 */
export async function capCandidates(
  deps: TransitionDeps,
  now: number,
  epoch: number,
  config: ContactConfig,
): Promise<number> {
  const live = deps.store.listCandidates().filter((row) => row.state === 'pending' || row.state === 'deferred')
  const over = live.length - Math.max(1, config.maxCandidates)
  if (over <= 0) return 0
  const doomed = [...live]
    .sort((a, b) => (b.priority - a.priority) || (a.expiresAt - b.expiresAt))
    .slice(0, over)
  for (const candidate of doomed) {
    await deps.store.patchCandidate(candidate.id, { state: 'expired', lastSuppressedReason: 'capped' }, now, epoch)
  }
  deps.log(`contact: 候选池超过上限，丢弃 ${String(doomed.length)} 条（低优先级/早过期）`)
  return doomed.length
}

/** 用户又说话了 → 那个房间的"连续未回复"计数归零（收到消息就是回复）。 */
export async function settleStreaks(deps: TransitionDeps, now: number, epoch: number): Promise<number> {
  const counters = deps.store.state.counters
  const streaks = counters.unansweredStreakByRoom
  const reset: Record<string, number> = {}
  for (const [room, streak] of Object.entries(streaks)) {
    if (streak <= 0) continue
    const lastUserAt = deps.roomFacts(room).lastUserMessageAt
    if (lastUserAt !== null && lastUserAt > (counters.lastSentAtByRoom[room] ?? 0)) reset[room] = 0
  }
  if (Object.keys(reset).length === 0) return 0
  await deps.store.patchCounters({ unansweredStreakByRoom: { ...streaks, ...reset } }, epoch)
  deps.log(`contact: ${String(Object.keys(reset).length)} 个房间收到回复，未回复计数归零`)
  void now
  return Object.keys(reset).length
}

/** 门控说 drop：候选到此为止（`expired` 保留原状态名，其余归 `cancelled`）。 */
export async function dropCandidate(
  deps: TransitionDeps,
  candidate: ContactCandidate,
  reason: string,
  now: number,
  epoch: number,
): Promise<void> {
  if (candidate.state !== 'pending' && candidate.state !== 'deferred') return
  const state: ContactCandidateState = reason === 'expired' ? 'expired' : 'cancelled'
  await deps.store.patchCandidate(candidate.id, { state, lastSuppressedReason: reason }, now, epoch)
  await deps.store.noteReason(`${candidate.id} drop:${reason}`, now, epoch)
  deps.log(`contact: 候选 ${candidate.id} 放弃（${reason}）`)
}

/**
 * 缓一缓：同一个原因连续出现只记第一次（与 `proactive/executor` 的 `noteSkip` 同一范式）。
 *
 * `reason` 直接透传 sender/门控给的稳定串（`dry-run` / `settle:user-active` / `no-channel`…），
 * 不再自己拼前缀——多套拼法会让 `recentReasons` 变成不可 grep 的花文本。
 */
export async function deferCandidate(
  deps: TransitionDeps,
  candidate: ContactCandidate,
  reason: string,
  now: number,
  epoch: number,
): Promise<boolean> {
  if (candidate.state === 'deferred' && candidate.lastSuppressedReason === reason) return false
  await deps.store.patchCandidate(candidate.id, {
    state: 'deferred',
    lastSuppressedReason: reason,
    attempts: candidate.attempts + 1,
  }, now, epoch)
  await deps.store.noteReason(`${candidate.id} defer:${reason}`, now, epoch)
  deps.log(`contact: 候选 ${candidate.id} 延后（${reason}）`)
  return true
}

/** "已经交给平台"的三种终态（`unknown` 也算发出去了：回执丢了不等于没发）。 */
function sentState(state: ContactDeliveryState): boolean {
  return state === 'confirmed' || state === 'submitted' || state === 'unknown'
}

/**
 * 发出去了：额度、冷却、未回复计数与候选终态。
 *
 * 单独成函数只为让 `afterSend` 读起来是一条分支树（每次改结算规则都要在一屏里看全
 * "发成功改哪几处、失败改哪几处"）。
 */
async function markSent(
  deps: TransitionDeps,
  candidate: ContactCandidate,
  state: ContactDeliveryState,
  now: number,
  epoch: number,
): Promise<void> {
  const room = candidate.target.room
  const counters = deps.store.state.counters
  await deps.store.patchCounters({
    sentTodayGlobal: counters.sentTodayGlobal + 1,
    sentTodayByRoom: { ...counters.sentTodayByRoom, [room]: (counters.sentTodayByRoom[room] ?? 0) + 1 },
    lastSentAt: now,
    lastSentAtByRoom: { ...counters.lastSentAtByRoom, [room]: now },
    unansweredStreakByRoom: {
      ...counters.unansweredStreakByRoom,
      [room]: (counters.unansweredStreakByRoom[room] ?? 0) + 1,
    },
  }, epoch)
  await deps.store.patchCandidate(candidate.id, { state: 'consumed', lastSuppressedReason: `sent:${state}` }, now, epoch)
}

/**
 * 结算之后改账本：发出去了记额度与未回复计数，没发出去按次数决定重试还是放弃。
 *
 * `unknown` 也计入"已花掉的额度"（诚实口径）：回执丢了不等于没发出去，按没发算会让
 * 下一次门控以为今天还很空。
 */
export async function afterSend(
  deps: TransitionDeps,
  candidate: ContactCandidate,
  state: ContactDeliveryState,
  detail: string,
  attempts: number,
  now: number,
  epoch: number,
  accounted = false,
): Promise<void> {
  const room = candidate.target.room
  if (accounted && (sentState(state) || state === 'cancelled')) {
    // R5-3: settleDeliveryAndAccount already wrote the quota/candidate in the same
    // transaction as the delivery row. Only the diagnostic note remains.
    await deps.store.noteReason(`${candidate.id} sent:${state} (${detail})`, now, epoch)
    deps.log(`contact: ${room} 投递完成 ${state}（${detail}）`)
    return
  }
  if (sentState(state)) {
    await markSent(deps, candidate, state, now, epoch)
    await deps.store.noteReason(`${candidate.id} sent:${state} (${detail})`, now, epoch)
    deps.log(`contact: ${room} 投递完成 ${state}（${detail}）`)
    return
  }
  if (state === 'cancelled') {
    // **过期与取消要分开写**：门控那侧过期落 `expired`（见 `dropCandidate`），执行点才发现
    // "自然过期"（入队后等过了 `expiresAt`）也必须落同一个终态、**同一个 reason 串**——
    // 同一种事实在账本上有两种名字，诊断与验收口径就会各读一半（Codex 第四轮 P2）。
    // "在执行点才发现"这个阶段信息留在日志与投递记录的 detail 里，不写进 reason。
    if (detail === 'candidate:expired') {
      await deps.store.patchCandidate(candidate.id, { state: 'expired', lastSuppressedReason: 'expired' }, now, epoch)
      await deps.store.noteReason(`${candidate.id} expired (at send)`, now, epoch)
      deps.log(`contact: ${candidate.id} 在执行点自然过期（没有发出去）`)
      return
    }
    await deps.store.patchCandidate(candidate.id, { state: 'cancelled', lastSuppressedReason: detail }, now, epoch)
    await deps.store.noteReason(`${candidate.id} cancelled:${detail}`, now, epoch)
    deps.log(`contact: ${candidate.id} 取消（${detail}）`)
    return
  }
  if (state === 'failed' && attempts >= deps.maxSendAttempts) {
    await deps.store.patchCandidate(candidate.id, {
      state: 'cancelled',
      lastSuppressedReason: `give-up:${detail}`,
    }, now, epoch)
    await deps.store.noteReason(`${candidate.id} give-up after ${String(attempts)} attempt(s): ${detail}`, now, epoch)
    deps.log(`contact: ${candidate.id} 连续 ${String(attempts)} 次失败，放弃`)
    return
  }
  await deferCandidate(deps, candidate, detail, now, epoch)
}

/**
 * 清掉很旧的终态投递（保留最近 `keep` 条），否则账本无界增长。
 *
 * 放在这里而不是 `store.ts`：它是一次**状态迁移**（哪些记录可以扔），不是 IO 事务；
 * `running`/`pending`/`deferred` 一律留下——它们还可能是"可能已经发出去"或"下一轮要发"。
 */
export async function pruneOldDeliveries(store: ContactStore, before: number, keep = 200): Promise<number> {
  let removed = 0
  await store.write((ledger) => {
    const terminal = Object.values(ledger.outbox)
      .filter((row) => row.state !== 'running' && row.state !== 'pending' && row.state !== 'deferred')
      .sort((a, b) => b.updatedAt - a.updatedAt)
    for (const row of terminal.slice(keep)) {
      if (row.updatedAt >= before) continue
      delete ledger.outbox[row.id]
      removed += 1
    }
    return removed > 0
  })
  return removed
}

/** 把"要不要放弃"的判据暴露给日志以外的调用方（测试直接断言这条边界）。 */
export async function guarded<T>(run: () => Promise<T>, log: (line: string) => void): Promise<T | null> {  try {
    return await run()
  } catch (error) {
    if (error instanceof StaleLeaseError) {
      log(`contact: 租约已失效，本次账本操作被拒：${error.message}`)
      return null
    }
    throw error
  }
}

/** 一条投递的"还能不能重试"判据（`worker` 与测试共用）。 */
export function retryable(state: ContactDelivery['state']): boolean {
  return state === 'failed' || state === 'deferred' || state === 'pending'
}
