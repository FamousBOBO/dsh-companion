/** 发送侧健康探测：一次 `get_status` 往返，不产生任何消息。
 *
 * 判据的分层（顺序无关紧要，但每条都要给出来，方便排查）：
 *   1. socket 不 OPEN → 直接失败（连协议端都断了）；
 *   2. `get_status` 抛错/超时 → 失败（登录态假活、协议端无响应）；
 *   3. `online === false` 或 `good === false` → 失败（连上了但送不出去）。
 *
 * **不要**给它加"发一条消息试试"的兜底：那会打扰人，而且文档里已经写明
 * 「一条消息送达只能证明那一刻通」——探针的价值在于随时可跑、不打扰。
 */

import type { HealthProbe, HealthReport } from '../../ports/health.js'
import type { QQApi } from '../../ports/platform.js'

/** 探测依赖：都是取值函数，探测器本身不持有连接。 */
export interface HealthProbeDeps {
  readonly api: QQApi
  readonly connected: () => boolean
  readonly lastActivityAt: () => number
  readonly selfId: () => number | null
  readonly now: () => number
}

/** 建一个探测器（单例由 platform 子插件提供）。 */
export function createHealthProbe(deps: HealthProbeDeps): HealthProbe {
  return {
    async check(): Promise<HealthReport> {
      const started = deps.now()
      const base = {
        connected: deps.connected(),
        lastActivityAt: deps.lastActivityAt(),
        selfId: deps.selfId(),
      }
      if (!base.connected) {
        return {
          ...base, ok: false, online: null, good: null,
          latencyMs: 0, checkedAt: started, detail: 'socket 未连接（连协议端都断了）',
        }
      }
      try {
        const status = await deps.api.getStatus()
        const online = typeof status?.online === 'boolean' ? status.online : null
        const good = typeof status?.good === 'boolean' ? status.good : null
        const detail = online === false ? 'get_status 返回 online=false（登录态不健康）'
          : good === false ? 'get_status 返回 good=false（链路不可用）'
            : ''
        return {
          ...base, ok: detail === '', online, good,
          latencyMs: deps.now() - started, checkedAt: started, detail,
        }
      } catch (error) {
        return {
          ...base, ok: false, online: null, good: null,
          latencyMs: deps.now() - started, checkedAt: started,
          detail: `get_status 失败：${error instanceof Error ? error.message : String(error)}`,
        }
      }
    },
  }
}
