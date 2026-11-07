/** 点歌的文字通知适配器：受理回执与失败说明都从这里出去。
 *
 * 为什么与 `voice.ts` 分开：两者的失败代价不同。
 *   - 语音条发失败要**记账**（`unknown-send` 之后禁止重发），所以它必须走三态回执；
 *   - 一句文字没发出去只是"没解释清楚"，绝不能因此把整条点歌记成失败——
 *     也不能因为它失败就重发语音条。
 *
 * 所以这里刻意**不重试、不超时兜底**：`out.push` 的结果原样分类成"成了/没成"，
 * 一句没送出去的说明留在日志里就够了。多一次重试只会在 NapCat 不稳的时候
 * 往私聊里灌重复的句子。
 *
 * 与 `voice.ts` 共用同一条发送路径（`out.push` + `send_private_msg` / `send_group_msg` +
 * 速率限制，按 `room` 选哪一个），所以两者不会绕过同一套限速。
 */

import type { OutboundQueue } from '../../outbound.js'
import { splitRoom } from '../../core/room.js'
import type { QQApi } from '../../ports/platform.js'
import type { OneBotMessageSegment } from '../../types.js'
import type { NoticePort } from '../../features/song/types.js'

export interface NoticePortOptions {
  readonly api: QQApi
  readonly out: OutboundQueue
  readonly log: (line: string) => void
}

export function createNoticePort(options: NoticePortOptions): NoticePort {
  const { api, out, log } = options

  return {
    async sendText(room: string, chatId: number, text: string) {
      const body = text.trim()
      if (body === '') return { ok: false, detail: '没有内容可发' }
      const message: OneBotMessageSegment[] = [{ type: 'text', data: { text: body } }]
      // 与语音条同一条判据：发回**点歌的那个房间**。群里点歌的失败说明要是发到私聊，
      // 群友永远看不到"为什么没做成"，而那句说明正是这次操作唯一的回执。
      const split = splitRoom(room)
      const chatIdOf = split?.chatId ?? chatId
      try {
        await out.push(() => split?.isGroup === true
          ? api.sendGroupMessage(chatIdOf, message)
          : api.sendPrivateMessage(chatIdOf, message))
        log(`song-notice: ${room} 已发送说明（${String(body.length)} 字）`)
        return { ok: true, detail: '' }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        // 不重试：一句说明重复出现比没出现更难解释。
        log(`song-notice: ${room} 说明没发出去（${detail}）`)
        return { ok: false, detail }
      }
    },
  }
}
