/** OneBot v11 wire types (subset used by the channel), ported from the OpenClaw qq extension. */

export type OneBotMessageSegment =
  | { type: 'text'; data: { text: string } }
  // `sub_type`（下划线）是 QQNT/NapCat 认的那个：0 = 普通图片，1 = 表情。
  // `subtype`（无下划线）是历史遗留的拼写，发送时 NapCat 不认，只有入站解析会读它。
  // 见 `core/message/sticker.ts` 的实测表。
  | { type: 'image'; data: { file: string; url?: string; subtype?: number; sub_type?: number; summary?: string } }
  | { type: 'at'; data: { qq: string } }
  | { type: 'reply'; data: { id: string } }
  | { type: 'face'; data: { id: number } }
  // `path` / `url` 是 NapCat 额外给的：`path` 是已经落盘的 silk 绝对路径，
  // 直接读它就不必让协议端调 ffmpeg 转码（本机没有 ffmpeg）。
  | { type: 'record'; data: { file: string; path?: string; url?: string } }
  | { type: 'file'; data: { file: string; name?: string; url?: string; file_id?: string; file_size?: number | string } }
  | { type: 'video'; data: { file: string } }
  | { type: 'forward'; data: { id: string } }
  | { type: 'json'; data: { data: string } }
  | { type: 'ark'; data: { data: string } }
  | { type: 'tts'; data: { text: string } }
  // `music` 一直在发（`qq_send_music`），但类型联合里漏了它：以前走的是
  // `call(action, Record<string, unknown>)`，编译器看不见，漏了也不会报。
  | { type: 'music'; data: { type: string; id: string } }

export type OneBotMessage = OneBotMessageSegment[] | string

export interface OneBotSender {
  user_id: number
  nickname: string
  card?: string
  /** owner / admin / member */
  role?: string
  /** 群头衔 (NapCat) */
  title?: string
  /** 等级 (NapCat) */
  level?: string
}

export interface OneBotEvent {
  time: number
  self_id: number
  post_type: string
  meta_event_type?: string
  message_type?: 'private' | 'group'
  sub_type?: string
  message_id?: number
  user_id?: number
  group_id?: number
  message?: OneBotMessage
  raw_message?: string
  sender?: OneBotSender
  target_id?: number
  operator_id?: number
  notice_type?: string
  sub_type_alt?: string
  /** group_ban: mute length in seconds (sub_type ban). */
  duration?: number
  /** group_card: the new / previous group nickname. */
  card_new?: string
  card_old?: string
  /** notify/honor: 荣誉类型 e.g. talkative / performer / emotion. */
  honor_type?: string
  /** request 事件（好友申请 / 群邀请）。 */
  request_type?: 'friend' | 'group'
  /** 原样回传给 set_*_add_request 的凭据（request 事件）。 */
  flag?: string
  /** request 事件的验证消息。 */
  comment?: string
  /** request/group 邀请里的群名。 */
  group_name?: string
  /** group_recall: id of the withdrawn message. */
  message_seq?: number
}

export interface OneBotActionPayload {
  action: string
  params: Record<string, unknown>
  echo?: string
}

export interface OneBotApiResponse {
  status: 'ok' | 'async' | 'failed'
  retcode: number
  data?: unknown
  msg?: string
  wording?: string
  echo?: string
}
