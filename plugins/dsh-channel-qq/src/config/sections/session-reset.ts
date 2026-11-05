/** 会话换血（自动）：会话请求 token 接近模型窗口时，备份历史、重开会话。
 *
 * 为什么需要它：上下文压缩（compaction）在历史**已经超过窗口**时救不回来——
 * 它自己的摘要请求也超窗。换血是最后一道防线，必须在压缩之前生效。
 */

import { b, n, s, type FieldGroup } from '../dsl.js'

export interface SessionResetConfig {
  /** 总开关。 */
  enabled: boolean
  /** 触发比例：tokens ≥ 窗口 × ratio 时换血（0.1–0.95）。 */
  thresholdRatio: number
  /** 检查间隔（分钟）。 */
  checkIntervalMin: number
  /** 定期换血：多少天强制换一次（0 = 关闭）。 */
  maxAgeDays: number
  /** 单回合最长运行时间（分钟）；超时强制换血（0 = 关闭）。 */
  maxTurnMinutes: number
  /** 需要更激进阈值的房间（逗号分隔：`dm-1000000002,group-1000000004`）。 */
  strictRooms: string
  /** 上面这些房间使用的更低比例。 */
  strictThresholdRatio: number
  /** 续接种子（空 = 用内置文案）。 */
  seed: string
}

export const SESSION_RESET_GROUPS: FieldGroup[] = [
  {
    id: 'sessionReset',
    label: '会话换血',
    page: 'messages',
    fields: {
      enabled: b('自动换血', true, {
        hot: 'live',
        help: '会话 token 接近模型窗口时自动备份历史并重开会话；关掉后只能手动跑 deploy/session-reset.mjs。',
      }),
      thresholdRatio: n('触发比例', 0.85, {
        hot: 'live', min: 0.1, max: 0.95, step: 0.05,
        help: '按模型声明的窗口计算。默认 0.85：让宿主的上下文压缩（约 0.8）先跑，压缩失败时这里才兜底换血。',
      }),
      checkIntervalMin: n('检查间隔', 5, {
        hot: 'live', min: 1, max: 60, unit: 'min',
        help: '每轮检查活跃会话的体积；只在回合空闲时动手。',
      }),
      maxAgeDays: n('定期换血', 7, {
        hot: 'live', min: 0, max: 365, unit: '天',
        help: '距上次换血超过这么多天就重置一次（0 = 关闭）。上下文腐化是渐进的，定期重置比等出事便宜。',
      }),
      maxTurnMinutes: n('回合超时', 10, {
        hot: 'live', min: 0, max: 240, unit: '分钟',
        help: '一个回合跑这么久还没结束就强制换血（0 = 关闭）。用来兜住「等待审批」这类永久挂起的回合。',
      }),
      strictRooms: s('激进房间', '', {
        hot: 'live',
        help: '图片/工具特别多的房间，逗号分隔；这些房间用下面的更低比例。',
      }),
      strictThresholdRatio: n('激进比例', 0.6, {
        hot: 'live', min: 0.1, max: 0.95, step: 0.05,
        help: '「激进房间」使用的触发比例；默认 0.6，比常规的 0.85 更早换血。',
      }),
      seed: s('续接种子', '', {
        hot: 'live', advanced: true,
        help: '换血后注入下一轮的一句话（留空用内置文案：上下文已清空、人格与长期记忆不变）。',
      }),
    },
  },
]
