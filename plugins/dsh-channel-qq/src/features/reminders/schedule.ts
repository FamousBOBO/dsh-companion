/**
 * **下一次该在什么时候醒来**（2026-11-10 修复：到点精度）。
 *
 * 为什么需要它：以前 runner 只有一条固定 `setInterval(30_000)`，于是"提醒在计划时间附近
 * 发出"在结构上就做不到——**误差下界就是轮询间隔**。实测事故日志里那 84 次被拦的记录
 * 间隔稳定在 30 s 上下（`docs/reminders-dispatch-timing.md`），正是这条定时器。
 *
 * 修法不是把间隔改小（拿 CPU 换精度），而是**按到期时刻定时**：算出下一条未触发提醒的
 * `at`，只在它到点时醒来；没有未来提醒时退回心跳。心跳不能省——它兜三件事：时钟漂移、
 * 系统休眠/唤醒（`setTimeout` 不保证跨休眠按墙钟走）、以及被外部手改过的提醒文件。
 *
 * 纯函数、无 IO、无全局时钟：`now` 一律由调用方注入，于是"到点精度"能在假时钟上逐毫秒
 * 钉住，而不是靠 `sleep(150)` 猜。
 */

import type { Reminder } from './reminder-model.js'

/** 任何一次唤醒都不许比它更密（防"at 已经过去"时把定时器排成 0ms 死循环）。 */
export const MIN_WAKEUP_MS = 1

/**
 * **下一次醒来的延迟**（毫秒）。
 *
 *   - 有未来提醒 ⇒ 正好在它的 `at` 醒来（`remaining <= 0` ⇒ 立刻醒，交给调用方去发）；
 *   - 没有 ⇒ 心跳；
 *   - 提醒排在心跳之外 ⇒ 心跳那一拍会重新算一次（新增提醒最迟一个心跳就被看见）。
 */
export function nextWakeupDelayMs(input: {
  /** 尚未触发且仍在补发窗口内的提醒时刻（毫秒；含过去时刻 ⇒ 立刻醒）。 */
  readonly ats: readonly number[]
  readonly now: number
  readonly heartbeatMs: number
}): number {
  const heartbeat = Math.max(MIN_WAKEUP_MS, Math.floor(input.heartbeatMs))
  let next = Number.POSITIVE_INFINITY
  for (const at of input.ats) {
    if (Number.isFinite(at) && at < next) next = at
  }
  if (!Number.isFinite(next)) return heartbeat
  const remaining = next - input.now
  if (remaining <= 0) return MIN_WAKEUP_MS
  return Math.max(MIN_WAKEUP_MS, Math.min(remaining, heartbeat))
}

/**
 * 从提醒表里取出"定时器该关心的那些 `at`"。
 *
 * 两条过滤，与投递侧同一套判据（否则定时器会为一个永远不会投递的时刻反复醒来）：
 *   - `fired` 的不算（已经响过，或已被收成终态 `skipped-expired:*`）；
 *   - 早于补发窗口下界的一次性提醒不算（`catch-up.ts` 会把它们收成终态，不由这里决定）。
 *
 * **过去的时刻照样返回**：由 `nextWakeupDelayMs` 判成立刻醒——"停机期间到期"的提醒因此
 * 下一拍就会被看见，而不是等一个心跳。
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
