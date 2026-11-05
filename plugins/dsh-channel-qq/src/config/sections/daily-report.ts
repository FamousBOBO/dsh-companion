/** 群日报段（B1）：每天固定时间把当天的消息统计发到群里。
 *
 * 默认关。数据来自服务端历史（`features/history` 的 collect，不看检索开关），
 * 只发一条文字；不做图片海报（不引无头浏览器依赖）。
 */

import { b, s, type FieldGroup } from '../dsl.js'

export interface DailyReportConfig {
  enabled: boolean
  /** 本地时间 HH:MM。 */
  time: string
  /** `primary-group` / `group:<号>` / `dm:<号>`。 */
  target: string
}

export const DAILY_REPORT_GROUPS: FieldGroup[] = [
  {
    id: 'dailyReport',
    label: '群日报',
    page: 'proactive',
    help: '每天固定时间把当天的消息统计（条数/活跃人/金句）发一条。',
    fields: {
      enabled: b('启用', false, { hot: 'live', help: '默认关。' }),
      time: s('发送时间', '22:30', {
        hot: 'live',
        help: '本地时间 HH:MM。错过当天不再补发。',
        hiddenIf: { field: 'dailyReport.enabled', equals: false },
      }),
      target: s('发送到', 'primary-group', {
        hot: 'live',
        help: 'primary-group / group:<群号> / dm:<QQ号>。',
        hiddenIf: { field: 'dailyReport.enabled', equals: false },
      }),
    },
  },
]
