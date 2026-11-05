/** 合并转发段（A3）：长回复改发一张聊天记录卡片，而不是连刷 N 条。
 *
 * 默认关（阈值 0）。打开后只在「分段条数 ≥ 阈值 且 不超过 maxNodes」时改发；
 * 超上限或转发失败都回退为逐条发送——**不能因为一张卡片丢掉内容**。
 */

import { n, type FieldGroup } from '../dsl.js'

export interface ForwardConfig {
  /** 分段后条数达到这个值就改合并转发；0 = 关闭。 */
  longReplyThreshold: number
  /** 单次合并转发最多几条；超过时回退逐条发送。 */
  maxNodes: number
}

export const FORWARD_GROUPS: FieldGroup[] = [
  {
    id: 'forward',
    label: '合并转发',
    page: 'messages',
    help: '长回复（清单/日志/总结）改发一张聊天记录卡片，避免连刷。',
    fields: {
      // 读法：`qq_send_text` 每次发送现取（live）。
      longReplyThreshold: n('超过几条改合并转发', 0, {
        min: 0, max: 20, hot: 'live',
        help: '0 = 关闭。分段后条数达到这个值就改用合并转发；默认关。',
      }),
      maxNodes: n('单次最多几条', 20, {
        min: 1, max: 100, hot: 'live',
        help: '超过这个条数就回退逐条发送，避免卡片被截断丢内容。',
        hiddenIf: { field: 'forward.longReplyThreshold', equals: 0 },
      }),
    },
  },
]
