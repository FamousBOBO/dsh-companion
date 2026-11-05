/** 服务端消息历史段（A4）。
 *
 * 默认关：打开后 `qq_search_history` 在本地日志没有命中时会向协议端拉最近 N 条，
 * 落盘到 `<dshHome>/channel-qq/history/<room>.json` 供检索与群日报复用。
 */

import { b, n, type FieldGroup } from '../dsl.js'

export interface HistoryConfig {
  serverBackfill: boolean
  maxMessages: number
}

export const HISTORY_GROUPS: FieldGroup[] = [
  {
    id: 'history',
    label: '服务端历史',
    page: 'messages',
    help: '本地日志只覆盖机器人启动后的消息；打开后可按需从协议端补最近的历史。',
    fields: {
      // 读法：`qq_search_history` 每次现取（live）。
      serverBackfill: b('本地没有时回源服务端', false, {
        hot: 'live',
        help: '默认关。打开后检索本地无命中时拉一次服务端历史（按房间 60 秒节流）。',
      }),
      maxMessages: n('每次最多拉几条', 100, {
        min: 1, max: 500, hot: 'live',
        help: '一次拉取的条数上限；拉回来的会去重并按房间保留最近 500 条。',
        hiddenIf: { field: 'history.serverBackfill', equals: false },
      }),
    },
  },
]
