/** 把协议端的一条历史消息收敛成可检索的一条(不可信数据的边界在这里)。
 *
 * 历史接口返回的是 OneBot 消息事件对象，字段不固定；这里只取需要的四个字段，
 * 其余一律丢弃——落盘的历史只用于检索与统计，不参与任何判定。
 */

export interface HistoryEntry {
  readonly id: number
  readonly time: number
  readonly userId: number
  readonly name: string
  readonly text: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/** 消息段数组 → 纯文本（图片/语音只留占位符，避免检索命中空）。 */
function textOfMessage(message: unknown): string {
  if (!Array.isArray(message)) return ''
  const parts: string[] = []
  for (const segment of message) {
    const record = asRecord(segment)
    if (record === null) continue
    const type = record.type
    const data = asRecord(record.data)
    if (type === 'text' && data !== null && typeof data.text === 'string') parts.push(data.text)
    else if (type === 'image') parts.push('[图片]')
    else if (type === 'record') parts.push('[语音]')
    else if (type === 'file') parts.push('[文件]')
  }
  return parts.join('')
}

/** 一条原始消息 → 历史条目；缺 message_id 或正文为空时返回 null。 */
export function normalizeHistoryMessage(raw: unknown): HistoryEntry | null {
  const record = asRecord(raw)
  if (record === null) return null
  const id = typeof record.message_id === 'number' ? record.message_id : null
  if (id === null) return null
  const sender = asRecord(record.sender)
  const text = textOfMessage(record.message)
    || (typeof record.raw_message === 'string' ? record.raw_message.replace(/\[CQ:[^\]]*\]/g, '').trim() : '')
  if (text === '') return null
  return {
    id,
    time: typeof record.time === 'number' ? record.time : 0,
    userId: typeof record.user_id === 'number' ? record.user_id : 0,
    name: typeof sender?.card === 'string' && sender.card !== ''
      ? sender.card
      : (typeof sender?.nickname === 'string' ? sender.nickname : ''),
    text,
  }
}
