/** 群通知 → 一行中文。
 *
 * 这些行是喂给模型的**话题素材**（谁进群了、谁被禁言了、谁撤回了什么），
 * 所以要写得像人话。纯函数：一条 OneBot 通知进去，一行字或 null 出来。
 *
 * `null` 的意思是"这条通知没什么可说的"——不要把它和"不认识这种通知"混为一谈：
 * 前者是内容为空（例如荣誉类型未知），后者由 `noticeKind` 返回 null 表示。
 */

import type { OneBotEvent } from '../../types.js'

/** 一条 OneBot 通知对应 `eventMonitor.kinds` 里的哪个 token；不认识则为 null。 */
export function noticeKind(event: OneBotEvent): string | null {
  const type = event.notice_type
  if (type === 'notify') {
    if (event.sub_type === 'poke') return 'poke'
    if (event.sub_type === 'honor') return 'group_honor'
    return null
  }
  if (type === 'group_increase' || type === 'group_decrease' || type === 'group_admin'
    || type === 'group_ban' || type === 'group_recall' || type === 'group_card'
    || type === 'friend_add') {
    return type
  }
  return null
}

/** 一行中文；这条通知没什么可说的时为 null。 */
export function describeNotice(event: OneBotEvent, kind: string): string | null {
  const actor = event.user_id !== undefined ? `QQ${event.user_id}` : '某人'
  const operator = event.operator_id !== undefined ? `QQ${event.operator_id}` : null
  switch (kind) {
    case 'group_increase':
      return operator !== null && operator !== actor ? `${actor} 被 ${operator} 拉进群了` : `${actor} 进群了`
    case 'group_decrease':
      if (event.sub_type === 'kick_me') return '咱自己被踢出群了'
      if (event.sub_type === 'kick') return operator !== null ? `${actor} 被 ${operator} 踢出群了` : `${actor} 被踢出群了`
      return `${actor} 退群了`
    case 'group_admin':
      return event.sub_type === 'unset' ? `${actor} 被取消管理员了` : `${actor} 成了管理员`
    case 'group_ban':
      if (event.sub_type === 'lift_ban') return `${actor} 被解除禁言了`
      if (event.user_id === 0) return `全员禁言开启了（${event.duration ?? 0} 秒）`
      return `${actor} 被禁言 ${event.duration ?? 0} 秒`
    case 'group_recall': {
      const by = operator !== null && operator !== actor ? `（${operator} 代撤回）` : ''
      return `${actor} 撤回了一条消息${by}`
    }
    case 'group_card': {
      const from = event.card_old !== undefined && event.card_old !== '' ? `（原来是「${event.card_old}」）` : ''
      return `${actor} 的群名片改成了「${event.card_new ?? ''}」${from}`
    }
    case 'friend_add':
      return `QQ${event.user_id ?? '?'} 加了咱好友`
    case 'group_honor':
      return `群荣誉：${actor} 拿到了 ${event.honor_type ?? '未知'}`
    default:
      return null
  }
}
