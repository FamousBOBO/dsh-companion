/** 指标段（C1/C2）：回合耗时、token 用量、发送/工具失败。
 *
 * 默认关：采集本身会读宿主投影、写一份指标文件，属于额外行为；关着时一个采样都不记。
 */

import { b, type FieldGroup } from '../dsl.js'

export interface MetricsConfig {
  enabled: boolean
}

export const METRICS_GROUPS: FieldGroup[] = [
  {
    id: 'metrics',
    label: '指标采集',
    page: 'metrics',
    help: '回合耗时、token 用量、发送/工具失败；数据只在本机。',
    fields: {
      // 读法：每回合现取（live）；打开后从下一回合开始记。
      enabled: b('启用', false, {
        hot: 'live',
        help: '打开后每个回合结束记一条（房间、耗时、token 四个桶），保留最近 5000 条；默认关。',
      }),
    },
  },
]
