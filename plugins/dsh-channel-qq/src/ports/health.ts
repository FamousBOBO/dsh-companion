/** 发送侧健康探测的端口类型（只有类型，没有实现）。
 *
 * 为什么需要它：端口通 ≠ 消息发得出去。2026-10-19 的事故里，3000/3001 一直
 * 能连上、日志也没有异常，但六个多小时一条消息都发不出去。`get_status` 是
 * 一次**不产生消息**的往返，落在同一条协议链路上——它失败才说明"这条链路断了"。
 */

/** 一次探测的结果。字段都是给人和脚本一起看的：`ok` 给脚本，其余给排查。 */
export interface HealthReport {
  /** 这次探测是否通过（脚本只看这个）。 */
  readonly ok: boolean
  /** socket 是否处于 OPEN。 */
  readonly connected: boolean
  /** `get_status` 的 `online`（实现没给时为 null）。 */
  readonly online: boolean | null
  /** `get_status` 的 `good`（实现没给时为 null）。 */
  readonly good: boolean | null
  /** 探测耗时（毫秒）。 */
  readonly latencyMs: number
  /** 探测时刻（Unix ms）。 */
  readonly checkedAt: number
  /** 最近一次收到任何帧的时刻（Unix ms）；0 = 还没收到过。 */
  readonly lastActivityAt: number
  /** 机器人 QQ 号；未知为 null。 */
  readonly selfId: number | null
  /** 失败原因（`ok=true` 时为空串）。 */
  readonly detail: string
}

/** 健康探测器。 */
export interface HealthProbe {
  check(): Promise<HealthReport>
}
