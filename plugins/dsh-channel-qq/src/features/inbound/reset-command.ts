/** 管理员私聊的 `/换血` 指令：确定性处理，不经模型。
 *
 * 为什么不让模型自己触发：模型能看到的输入包含群友的文字，让它可以清空历史
 * 等于把"上下文删除"交给不可信输入。这里只认管理员 QQ 号 + 固定指令。
 */

import { isResetCommand } from '../../core/session-reset.js'
import { dmRoom } from '../../core/room.js'
import type { OneBotEvent } from '../../types.js'
import type { PlatformParts, SubHost } from '../plugin-kit.js'

/** 从事件里取纯文本（只拼文本段；没有就用 raw_message）。 */
function textOfEvent(event: OneBotEvent): string {
  if (typeof event.raw_message === 'string' && event.raw_message !== '') return event.raw_message
  const segments = Array.isArray(event.message) ? event.message : []
  return segments
    .map((segment) => segment?.type === 'text' ? String((segment.data as { text?: unknown })?.text ?? '') : '')
    .join('')
}

/**
 * 管理员私聊里的 `/换血`。
 * @returns 是否已经接管这条消息（是则不再进流水线）。
 */
export function maybeHandleResetCommand(host: SubHost, parts: PlatformParts, event: OneBotEvent): boolean {
  if (event.post_type !== 'message' || event.message_type !== 'private') return false
  const userId = event.user_id ?? 0
  if (!host.config.admins.includes(userId)) return false
  if (!isResetCommand(textOfEvent(event))) return false
  const service = host.get('sessionReset')
  void (async () => {
    const result = service === undefined
      ? { ok: false, note: '换血服务未就绪' }
      : await service.reset(dmRoom(userId), 'admin command')
    const text = result.ok ? `换血完成：${result.note}` : `换血失败：${result.note}`
    host.log(`session-reset: /换血 from ${userId} → ${text}`)
    try {
      await parts.api.sendPrivateMessage(userId, [{ type: 'text', data: { text } }])
    } catch (error) {
      host.log(`session-reset: 回执发送失败：${(error as Error).message}`)
    }
  })()
  return true
}
