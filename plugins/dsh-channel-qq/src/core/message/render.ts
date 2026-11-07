/** 入站消息 → **给模型看的那一行**。
 *
 * 这一行是模型理解群聊的全部输入：谁在说话（昵称 / 群名片 / 群主 / 管理员 /
 * 头衔）、几点说的、消息编号、是不是在叫我、引用了谁、语音说了什么、收了什么文件、
 * 图片是什么含义。它原来是 `ConversationBridge` 的一个私有方法——一个把配置、网络
 * 结果、时间全揉进去的位置，改一个字都可能影响模型行为却没有测试盯着。
 *
 * 现在它是纯函数：给同样的输入，出同样的字符串（黄金快照逐字节钉住它）。
 *
 * 三个刻意的取法，别改回去：
 *   - 正文取 `plainText` 而不是 `text`。显示渲染里有 `[图片]` / `[表情:5]`，
 *     放进正文槽位模型会以为那是用户打的字。`[图片]` 只留作**无文字配图的兜底**；
 *   - `[@我]` 只在被叫到时出现，语气提示同理——它们会改变模型的说话方式；
 *   - 时间带**年月日**（本地）：`2026-10-30 02:44`。本地补丁 COMPANION-QQ-PATCH-4
 *     把上游的 `HH:MM` 扩成完整日期——跨天/隔很久再聊时，只有时分会让模型把
 *     「昨天说的」和「刚才说的」混在一起；年月日是一眼可判的锚点。
 */

import type { OneBotEvent } from '../../types.js'
import type { ParsedInbound } from './parse.js'
import { stickerDisplay } from './parse.js'

export interface RenderInput {
  readonly event: OneBotEvent
  readonly parsed: ParsedInbound
  /** 这一条是否被叫到（@ / 关键词 / 私聊）。 */
  readonly called: boolean
  /** 引用上下文前缀（`fetchQuoted` 的产物），没有则 null。 */
  readonly quoted: string | null
  /** 语音条转写出来的文字；没转写则 null。 */
  readonly voiceText?: string | null
  /** 合并转发展开后的内容行（pipeline 调 `get_forward_msg` 拿的）；没有则 null。 */
  readonly forwardText?: string | null
  /** 已存进工作区 inbox 的文件路径。 */
  readonly receivedFiles?: readonly string[]
  /** 被叫到时查询到的语气提示；没被叫到或没命中则 null。 */
  readonly reactionHint?: string | null
  /** `event.time` 缺失时用来兜底的"现在"（毫秒）。调用方注入，纯函数不读时钟。 */
  readonly nowMs: number
}

/**
 * 渲染一行；这一行没有任何可说的内容时返回 `null`（纯媒体消息由调用方决定怎么办）。
 */
export function renderMessageLine(input: RenderInput): string | null {
  const { event, parsed, called } = input
  const senderName = event.sender?.card?.trim() || event.sender?.nickname || `QQ${event.user_id}`
  // Body from `plainText`: the display rendering would put `[图片]` / `[表情:5]`
  // in the body slot, which reads to the model as if the user typed those
  // words. `[图片]` survives only as the fallback for a caption-less image.
  //
  // 表情单独兜底：一条只有表情的消息（`[表情：困]`）没有正文，但那**就是**它的内容。
  // 以前这里会退到 `[图片]` 甚至 `(无文字)`，模型于是拿不到「他困了」这个意思。
  const stickerText = parsed.stickers.length > 0 ? parsed.stickers.map(stickerDisplay).join('') : ''
  const content = parsed.plainText !== ''
    ? parsed.plainText
    : (parsed.imageUrls.length > 0 ? '[图片]' : (stickerText !== '' ? stickerText : null))
  // 纯合并转发（无文字无图但有展开内容）也是"有得说"的消息。
  if (content === null && parsed.imageSummaries.length === 0 && (input.forwardText ?? '') === '') return null
  const time = new Date((event.time || Math.floor(input.nowMs / 1000)) * 1000)
  const hhmm = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`
  // COMPANION-QQ-PATCH-4：消息行的时间戳带年月日（本地时区）。
  const stamp = `${time.getFullYear()}-${String(time.getMonth() + 1).padStart(2, '0')}-${String(time.getDate()).padStart(2, '0')} ${hhmm}`
  const msgId = typeof event.message_id === 'number' ? ` #${event.message_id}` : ''
  // 群身份：群主/管理员/头衔让她知道谁在说话（主人=群主一眼可辨）
  const role = event.sender?.role
  const roleTag = role === 'owner' ? '[群主]' : role === 'admin' ? '[管理员]' : ''
  const title = event.sender?.title ? `[头衔:${event.sender.title}]` : ''
  const parts = [`${input.quoted ?? ''}${stamp} ${senderName}(${event.user_id})${roleTag}${title}${msgId}${called ? ' [@我]' : ''}：${content ?? '(无文字)'}`]
  if (parsed.atIds.length > 0) {
    const names = parsed.atIds.map((id) => `#${id}`).join('、')
    parts.push(`[@了 ${names}${parsed.isAtBot ? '（含我）' : '（不是我）'}]`)
  }
  if (input.voiceText !== undefined && input.voiceText !== null) parts.push(`[语音条说：${input.voiceText}]`)
  if (input.forwardText !== undefined && input.forwardText !== null) parts.push(`[合并转发的内容：${input.forwardText}]`)
  for (const file of input.receivedFiles ?? []) parts.push(`[文件已收到，存放在：${file}]`)
  // A caption-less image already shows as `[图片]` in the body; an image *with*
  // a caption and no vision summary would otherwise leave the model unaware
  // that a picture came along (imageRecognition is off by default).
  if (parsed.imageSummaries.length > 0) parts.push(`[图片含义：${parsed.imageSummaries.join('；')}]`)
  else if (parsed.imageUrls.length > 0 && parsed.plainText !== '') parts.push(`[随消息附了${parsed.imageUrls.length}张图]`)
  // 表情的处置口径写在这一行里，而不是指望模型自己悟：先想「以前发过没有」，
  // 没有就诚实说不认识，**不许照着画面描述**。私聊里可以直接问对方是什么意思。
  if (parsed.stickers.length > 0) {
    const unknown = parsed.stickers.filter(s => s.label === '').length
    const animated = parsed.stickers.some(s => s.animated)
    parts.push(
      '[表情处置：先在记忆里找这个表情以前出现过没有（同一张图会认出是同一张）；'
      + '认得出就直接按它原来的意思理解，不要描述画面。'
      + (unknown > 0 ? '认不出的就说不认识，别猜画面内容' : '')
      + '；私聊里可以直接问对方「这个表情是什么意思」，问清楚之后再用表情记录工具把意思记下来'
      + (animated ? '（动图同样按这个办法，不需要逐帧看）' : '')
      + ']',
    )
  }
  if (called && input.reactionHint !== undefined && input.reactionHint !== null) {
    parts.push(`（语气提示：${input.reactionHint}）`)
  }
  return parts.join('')
}
