/** 合批等待与**饥饿告警**的算术（P7-B）：两个纯函数，一个文件。
 *
 * P7-B 的问题是命名名不副实：配置项原来叫 `judgeMaxWaitMs`，读起来像"判断本身最多等多久"，
 * 实际上它**只用于告警**，不参与调度。计划 §4.2 给了两条路，这里走**保守方案**：
 *
 *   > 保留当前调度，但把配置更名/文档明确为 `starvationWarnMs`，消除命名歧义；
 *   > 真实数据确定确实存在延迟问题后再改。
 *
 * 理由是实测过的：把上限真的接到调度上（`min(batchQuietMs, batchMaxWaitMs)`）会**缩短**
 * 默认的合批窗口——默认 `batchQuietMs=6s` 时没人受影响，但只要有人把安静窗口调到 25 秒以上，
 * 上限就会静默把它砍回 25 秒，而"我设了 40 秒为什么是 25 秒"没人能从日志里看出来。
 * 一个只在特定配置下生效、还会悄悄改变节奏的上限，比一个说清了自己只是告警的阈值危险。
 *
 * 所以这里保留两件事，都不改调度：
 *   1. `quietWaitMs`：这一次该等多久（就是 `batchQuietMs`，缺省退回 `judgeIntervalMs`）；
 *   2. `starvedOf`：这一批是不是已经等超了告警阈值（用于日志与观测）。
 *
 * 纯函数：不读时钟、不起定时器（R8）。
 */

import { DEFAULTS, positiveOr, type PresenceView } from './presence-flow.js'

/** 这次该等多久再判（毫秒）。`batchQuietMs` 是主参数，缺省退回判断间隔（旧配置兼容）。 */
export function quietWaitMs(settings: PresenceView): number {
  return positiveOr(settings.batchQuietMs ?? settings.judgeIntervalMs, DEFAULTS.batchQuietMs)
}

/** 饥饿告警阈值（毫秒）：一批消息等超这个时长仍未判，就在日志里说明白。 */
export function starvationWarnMs(settings: PresenceView | null): number {
  return positiveOr(settings?.starvationWarnMs ?? DEFAULTS.starvationWarnMs, DEFAULTS.starvationWarnMs)
}

/**
 * 这一批是不是"饿着"（等超阈值）。
 *
 * 只对**真的还有待判内容**的批次成立：`pending === 0` 时"等了很久"没有意义（没人说话）。
 */
export function starvedOf(input: {
  readonly nowMs: number
  readonly batchStartedAtMs: number
  readonly pending: number
  readonly warnMs: number
}): boolean {
  if (input.pending <= 0) return false
  if (input.batchStartedAtMs <= 0) return false
  return input.nowMs - input.batchStartedAtMs >= positiveOr(input.warnMs, DEFAULTS.starvationWarnMs)
}
