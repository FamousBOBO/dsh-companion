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
  /**
   * 表情词典的**只读**取值函数：给一个表情指纹，回它记下的意思（没记过回 `null`）。
   *
   * 为什么由调用方注入而不是在这里读库：`renderMessageLine` 是纯函数（黄金快照靠它），
   * 而词典在 `companion-expression` 的 SQLite 里。注入让「有词典」与「没词典」成为
   * 两种显式行为，也让这条路径可以离线测。
   *
   * 约定：**只读**。渲染一条入站行不该产生"这个表情又被看见一次"的副作用——
   * 那个计数决定"要不要问一句"，它属于真正收到消息的观察者，不属于渲染。
   * 取不到 / 抛错 / 回空串一律按「不认识」处理。
   */
  readonly stickerMeanings?: (stickerKey: string) => string | null
}

/**
 * 一条消息的**正文**（不含发送者抬头、时间、消息号、@ 标记）。
 *
 * 为什么单独导出：P0 之后背景块要把"谁说的"和"说了什么"分开渲染（发送者身份只出现一次）。
 * 从前那条背景行只有一种形态（整行），于是判断提示词里身份出现两遍，模型得猜哪个是真的。
 * 现在两处用同一个函数算正文，拼法就不可能再漂。
 *
 * 取法与整行渲染完全一致：正文取 `plainText`；没有正文时用 `[图片]` / 表情字面兜底；
 * 都没有则返回 `null`（纯空消息不值得占旁听额度）。
 */
export function renderMessageContent(parsed: ParsedInbound): string | null {
  const stickerText = parsed.stickers.length > 0 ? parsed.stickers.map(stickerDisplay).join('') : ''
  return parsed.plainText !== ''
    ? parsed.plainText
    : (parsed.imageUrls.length > 0 ? '[图片]' : (stickerText !== '' ? stickerText : null))
}

/** 取一个表情记下的意思（没有/抛错/空串都算「不认识」）。 */
function meaningOf(
  sticker: ParsedInbound['stickers'][number],
  lookup: ((key: string) => string | null) | undefined,
): string | null {
  if (typeof lookup !== 'function') return null
  try {
    const value = lookup(sticker.key)
    const text = typeof value === 'string' ? value.trim() : ''
    return text === '' ? null : text
  } catch {
    // 词典查询失败不该让一条消息渲染不出来：按「不认识」继续（模型会走未知口径）。
    return null
  }
}

/**
 * 一个表情的机器可读标注：`[表情标记：kind=sticker｜stickerKey=f:…｜semanticPolicy=emotion-support｜knownMeaning=…]`。
 *
 * 为什么把 `knownMeaning` 放进**机器可读**的那一段而不是只写在散文里：模型要能一眼
 * 分清「这张我有记录」与「这张我不知道」，而不是从一整段规则里推测自己该不该解释。
 * 没有记录时**不输出** `knownMeaning=`（而不是输出一个空值）——空字段会被读成
 * 「记过一条空意思」，那比没有更难纠正。
 */
export function stickerSemanticTag(
  sticker: ParsedInbound['stickers'][number],
  meaning: string | null,
): string {
  const fields = [
    'kind=sticker',
    sticker.key === '' ? '' : `stickerKey=${sticker.key}`,
    `semanticPolicy=${sticker.semanticPolicy}`,
    meaning === null ? '' : `knownMeaning=${meaning}`,
    sticker.animated ? 'animated=1' : '',
  ].filter(Boolean)
  return `[表情标记：${fields.join('｜')}]`
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
  const content = renderMessageContent(parsed)
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
  // 表情的处置口径写在这一行里，而不是指望模型自己悟。
  //
  // 口径（docs/11 P1，2026-11-11）：**用户发来的表情首先是一句情绪或态度表达**。
  // 旧文案要求模型「先在记忆里找这个表情以前出现过没有，认不出就说不认识」——它把
  // 表情当成一件需要检索的**资料**，于是模型要么去描述画面、要么去揣度动机。现在改成：
  // 已知意思就直接按那个情绪理解；认不出就接住语气/卖萌/带过/沉默，不描画面、不揣度；
  // 只有用户**明确追问**"这是什么意思"时才解释。
  //
  // 每个表情都带两个机器可读的标注（`kind=sticker` / `semanticPolicy=emotion-support`）：
  // 它们是模型可以引用的事实，比在散文里要求"把表情当情绪"更难被忽略。
  if (parsed.stickers.length > 0) {
    for (const sticker of parsed.stickers) {
      const meaning = meaningOf(sticker, input.stickerMeanings)
      parts.push(stickerSemanticTag(sticker, meaning))
    }
    const animated = parsed.stickers.some(s => s.animated)
    parts.push(
      '[表情语义：表情包是对方的情绪辅助表达，不是一幅需要解释的图。'
      + '不默认解释图片内容、不描述画面、不猜测对方在问什么；'
      + '词典里记过意思（knownMeaning）就直接按那个情绪理解，不重复解释；'
      + '认不出（没有 knownMeaning）时接住语气、卖萌、轻轻带过或沉默：别猜、不揣度，也不要把猜测当成事实。'
      + '只有用户明确问「这是什么意思」时才解释：先用 expression_sticker_note 的 action=lookup 查词典，'
      + '仍没有记录就承认不确定并问一句。'
      + '用户发普通图片与发表情不是一回事：图片可能是让 Bot 看内容，表情默认是在表达情绪'
      + (animated ? '（动图表情同样只按情绪理解，不需要逐帧看）' : '')
      + '。]',
    )
  }
  if (called && input.reactionHint !== undefined && input.reactionHint !== null) {
    parts.push(`（语气提示：${input.reactionHint}）`)
  }
  return parts.join('')
}
