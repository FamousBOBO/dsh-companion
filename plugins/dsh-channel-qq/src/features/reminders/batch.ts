/**
 * **取本拍要发的那一批**（防雪崩的三道闸：终审 B7 + Lead 裁定的总量闸）。
 *
 * 顺序是硬约定（每一步都记日志，既不静默丢弃，也不在恢复瞬间刷屏）：
 *   ① 太旧的收终态（`skipped-expired:too-old`）；
 *   ② 积压超过 `CATCH_UP_MAX_TOTAL` 按**最老优先**丢弃（`skipped-expired:backlog-overflow`）；
 *   ③ 只取 `MAX_CATCH_UP_PER_TICK` 条一次性提醒（周期提醒不占这个额度——它们本来就不会被淘汰）。
 *
 * 为什么单独一个文件：这段是"这一拍发哪几条"的策略，与"下一拍什么时候醒"无关，
 * 而 `runner.ts` 贴着 400 行硬上限（`scripts/check-size.mjs`）。
 */

import type { Reminder } from './reminder-model.js'
import type { ReminderStore } from './store.js'
import { CATCH_UP_MAX_TOTAL } from './catch-up.js'
import { logDroppedBacklog } from './runner-log.js'

/** 每拍最多补发几条一次性提醒（`runner.ts` 再导出这个常量）。 */
export const MAX_CATCH_UP_PER_TICK = 3

export interface BatchInput {
  readonly store: ReminderStore
  /** **必须**是注入的时钟（`Date.now()` 在假时钟下会让 due/expire/cap 读到另一个时间）。 */
  readonly now: number
  readonly dryRun: boolean
  readonly log: (line: string) => void
}

export async function takeBatch(input: BatchInput): Promise<Reminder[]> {
  const { store, now, log } = input
  // **演练模式：一行持久状态都不写**（round5 D4）。淘汰/收编都是写操作，必须整个跳过——
  // 否则"dryRun 开着"也会把超期的 daily/weekly 收成终态 ⇒ 永久停掉周期提醒。
  if (input.dryRun) return store.due(now)
  // **task-66（设计 §6 调用方规则）**：收编失败是**存储故障**（reject）⇒ **终止本拍投递**，
  // 不能捕获后继续用空数组绕过防雪崩。业务拒绝（NOT_APPLICABLE）才算"没有要收的"。
  const expiredMutation = await store.expireStale(now)
  const expired = expiredMutation.ok ? expiredMutation.value.map((row) => row.id) : []
  if (expired.length > 0) {
    log(`reminders: ${String(expired.length)} 条已超出补发窗口（${String(store.catchUpWindowMs)}ms）`
      + ' → 收成终态 skipped-expired:too-old（不补发、也不假装还在等）')
  }
  const overflowMutation = await store.capBacklog(now)
  const overflow = overflowMutation.ok ? overflowMutation.value.map((row) => row.id) : []
  if (overflow.length > 0) {
    logDroppedBacklog({ dropped: overflow.length, store, now, maxTotal: CATCH_UP_MAX_TOTAL, log })
  }
  const backlog = store.due(now)
  // **错过这一轮的周期提醒也要进本拍**（round5 D4）：它们不在 `due()` 里（`at` 已滑出窗口），
  // 但需要被"推进到下一轮"——否则会永远卡在过去的时刻（既不响也不再走）。
  const missed = typeof store.missedRounds === 'function' ? store.missedRounds(now) : []
  // **每拍上限只对一次性提醒计数**（round5 D4）：周期提醒不该被"积压"挤掉。
  const repeats = backlog.filter((item) => item.repeat !== 'none')
  const oneShots = backlog.filter((item) => item.repeat === 'none')
  const pending = [...missed, ...repeats, ...oneShots.slice(0, MAX_CATCH_UP_PER_TICK)]
  if (oneShots.length > MAX_CATCH_UP_PER_TICK) {
    log(`reminders: 本拍到点 ${String(oneShots.length)} 条一次性提醒，按每拍上限 ${String(MAX_CATCH_UP_PER_TICK)} 条先发；`
      + `其余 ${String(oneShots.length - MAX_CATCH_UP_PER_TICK)} 条下一拍继续（不丢弃、不插队）`)
  }
  return pending
}
