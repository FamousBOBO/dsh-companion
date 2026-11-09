/**
 * **下一次该在什么时候醒来**（2026-11-10 修复：到点精度；第二轮修 1ms 空转）。
 *
 * 为什么需要它：以前 runner 只有一条固定 `setInterval(30_000)`，于是"提醒在计划时间附近
 * 发出"在结构上就做不到——**误差下界就是轮询间隔**。实测事故日志里那 84 次被拦的记录
 * 间隔稳定在 30 s 上下（`docs/reminders-dispatch-timing.md`），正是这条定时器。
 *
 * 修法不是把间隔改小（拿 CPU 换精度），而是**按到期时刻定时**：算出下一条未触发提醒的
 * `at`，只在它到点时醒来；没有未来提醒时退回心跳。心跳不能省——它兜三件事：时钟漂移、
 * 系统休眠/唤醒（`setTimeout` 不保证跨休眠按墙钟走）、以及被外部手改过的提醒文件。
 *
 * ## 第二轮：为什么"已经到点"不能一律排 1 ms
 *
 * 第一版对**任何**过去时刻都排 `MIN_WAKEUP_MS`。这只在"这一拍一定会消费掉它"时成立。
 * 而现实里有大量不消费的路径：`dryRun`（按设计零写入）、通道暂不可用 / 房间不许发
 * （`skipped`）、日程暂时阻断、以及积压超过 `MAX_CATCH_UP_PER_TICK` 只发了一部分。
 * 那些情况下下一拍仍看到同一条 due ⇒ 又一个 1 ms ⇒ **空转 + 日志刷屏**。
 *
 * 所以到期项现在分两种排法（`planWakeup`）：
 *
 *   - **立刻**：启动后的第一拍、`nudge`（刚建/刚改/刚删提醒）——那时"还没试过"，必须马上试；
 *   - **退避**：上一拍之后**仍有**到期项没被消费 ⇒ 至少 `BACKLOG_GAP_MS`，并在**没有进展**
 *     的连续拍上按 2 倍增长到心跳。有进展时维持 `BACKLOG_GAP_MS`（积压要按节奏继续发，
 *     但不能一口气喷完，也不能 1 ms 冲刷）。
 *
 * 注意：**不要只把 `MIN_WAKEUP_MS` 改大**。那只是把空转频率降下来，"这一拍有没有进展"
 * 这个调度语义仍然不存在——积压批次与通道故障会共用同一个固定间隔，两边都不对。
 *
 * 纯函数、无 IO、无全局时钟：`now` 一律由调用方注入，于是"到点精度"能在假时钟上逐毫秒
 * 钉住，而不是靠 `sleep(150)` 猜。
 */

import type { Reminder } from './reminder-model.js'

/** 任何一次唤醒都不许比它更密（防"at 已经过去"时把定时器排成 0ms 死循环）。 */
export const MIN_WAKEUP_MS = 1

/**
 * **积压批次之间的基础间隔**（第二轮 P2：节流）。
 *
 * 为什么需要它：第一轮把固定轮询改成精确定时后，`MAX_CATCH_UP_PER_TICK = 3` 不再自动
 * 等于"每 30 秒最多 3 条"——只要 due 还在，下一拍就可能紧接着来，于是"恢复瞬间喷 20 条"
 * 变成结构上可能。1 s 让"每批 3 条"对应约 3 条/秒的上限，比"一口气全发"像人得多；
 * 真正的出口限速仍然只有 `out.push()` / `rateLimitMs` 一处（这里不重复造限速器）。
 */
export const BACKLOG_GAP_MS = 1_000

/** 退避上限就是心跳：再慢就会让"通道恢复"这类事件等超过一个心跳才被看见。 */
export interface WakeupPlanInput {
  /** 尚未触发且仍在补发窗口内的提醒时刻（毫秒；含过去时刻）。 */
  readonly ats: readonly number[]
  readonly now: number
  readonly heartbeatMs: number
  /**
   * **到期但未消费**的那些项这一拍该隔多久再试（毫秒）。
   * `undefined` = 立刻（启动 / nudge / 无退避状态）。
   */
  readonly overdueGapMs?: number
}

/**
 * **下一次醒来的延迟**（毫秒）。到期项与未来项分开算，取更早的那个：
 *
 *   - 未来项 ⇒ 正好在它的 `at` 醒来（受心跳上限约束）；
 *   - 到期项 ⇒ `overdueGapMs`（缺省 `MIN_WAKEUP_MS` = 立刻，只用于启动/nudge）；
 *   - 都没有 ⇒ 心跳。
 *
 * 分开算是必须的：一条 15 秒后的新提醒不该因为旁边还有一条积压就等到退避间隔之后。
 */
export function planWakeup(input: WakeupPlanInput): number {
  const heartbeat = Math.max(MIN_WAKEUP_MS, Math.floor(input.heartbeatMs))
  const gap = Math.max(MIN_WAKEUP_MS, Math.floor(input.overdueGapMs ?? MIN_WAKEUP_MS))
  let future = Number.POSITIVE_INFINITY
  let overdue = false
  for (const at of input.ats) {
    if (!Number.isFinite(at)) continue
    if (at > input.now) { if (at < future) future = at; continue }
    overdue = true
  }
  const candidates: number[] = []
  if (overdue) candidates.push(Math.min(gap, heartbeat))
  if (Number.isFinite(future)) candidates.push(Math.max(MIN_WAKEUP_MS, Math.min(future - input.now, heartbeat)))
  if (candidates.length === 0) return heartbeat
  return Math.max(MIN_WAKEUP_MS, Math.min(...candidates))
}

/**
 * `planWakeup()` 的"立刻"变体（启动 / nudge / 单次测试用）。
 *
 * 保留这个入口是为了让"立刻"这件事**有名字**：它是"还没试过，马上试"，
 * 而不是"已经试过但没成功也马上再来一次"（那是空转，见文件头）。
 */
export function nextWakeupDelayMs(input: {
  readonly ats: readonly number[]
  readonly now: number
  readonly heartbeatMs: number
}): number {
  return planWakeup({ ...input, overdueGapMs: MIN_WAKEUP_MS })
}

/**
 * 从提醒表里取出"定时器该关心的那些 `at`"。
 *
 * 两条过滤，与投递侧同一套判据（否则定时器会为一个永远不会投递的时刻反复醒来）：
 *   - `fired` 的不算（已经响过，或已被收成终态 `skipped-expired:*`）；
 *   - 早于补发窗口下界的一次性提醒不算（`catch-up.ts` 会把它们收成终态，不由这里决定）。
 *
 * **过去的时刻照样返回**：由 `planWakeup` 判成立刻醒还是退避醒——"停机期间到期"的提醒
 * 因此下一拍就会被看见，而不是等一个心跳。
 */
export function wakeupAtsOf(items: readonly Reminder[], windowMs: number, now: number): number[] {
  const floor = now - windowMs
  const out: number[] = []
  for (const item of items) {
    if (item.fired) continue
    if (item.repeat === 'none' && item.at < floor) continue
    out.push(item.at)
  }
  return out
}

/**
 * **到期未消费时的退避间隔**（纯函数；runner 只负责记"连续几拍没进展"）。
 *
 * 增长条件只有一条：**上一拍之后到期项还在，且没少**（`passes` 由调用方数）。
 * 有进展 ⇒ `passes` 是 0 ⇒ 基础间隔 `BACKLOG_GAP_MS`（积压按节奏继续，不快到刷屏）。
 * 没进展 ⇒ 2 倍增长，上限心跳：`dryRun` / 通道断开这类"永远消费不掉"的现场
 * 因此稳定在心跳上，既不会 1 ms 空转，也不会长时间不看一眼（通道恢复后最多等一个心跳）。
 */
export function overdueGapMs(input: { readonly passes: number; readonly heartbeatMs: number }): number {
  const heartbeat = Math.max(MIN_WAKEUP_MS, Math.floor(input.heartbeatMs))
  const passes = Math.max(0, Math.floor(input.passes))
  if (passes === 0) return Math.min(BACKLOG_GAP_MS, heartbeat)
  const grown = BACKLOG_GAP_MS * 2 ** Math.min(passes, 16)
  return Math.min(heartbeat, grown)
}
