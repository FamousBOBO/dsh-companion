/** 触发判定：这一条消息要不要理它、理它的概率是多少、语气提示是什么。
 *
 * 抽出来的原因不是"好看"，而是这三件事原来藏在 `ConversationBridge` 的私有方法
 * 里，只能通过构造一整个 bridge（带宿主、带网络、带 WS）才能测。它们是纯判定：
 * 输入一条消息 + 一份配置，输出一个布尔或一个数。搬到 `core/` 之后可以直接
 * 列表测，而且黄金快照里的 `[@咱]`、概率分支因此有了单元级的护栏。
 */

import type { OneBotEvent } from '../types.js'
import { rawText, type ParsedInbound } from './message/parse.js'

/** 触发判定用到的那几项配置。`QQChannelConfig` 结构上满足它。 */
export interface TriggerConfig {
  readonly keywordTriggers: readonly string[]
  readonly keywordReactions: ReadonlyArray<{ keywords: string[]; reaction: string }>
  readonly primaryGroup: number | null
  readonly talkValue: number
  readonly primaryTalkValue?: number | null | undefined | undefined
}

/**
 * 确定性的"叫我"：@ 或命中关键词（私聊永远算直接对话）。
 *
 * 判据是**显示渲染** `text`（含 `[图片]`），不是 `plainText`：所以"发图"这种
 * 关键词在只有一张图、正文为空的调用里也能命中。
 */
export function isCalled(event: OneBotEvent, parsed: ParsedInbound, config: TriggerConfig): boolean {
  if (event.message_type === 'private') return true
  if (parsed.isAtBot) return true
  const raw = rawText(event).trim()
  if (raw === '') return false
  for (const keyword of config.keywordTriggers) {
    if (raw.includes(keyword)) return true
  }
  return false
}

/** 这一轮"要不要搭话"的骰子面值：主群可以单独设一个（更活跃或更安静）。 */
export function talkChanceOf(config: TriggerConfig, room: { readonly isGroup: boolean; readonly chatId: number }): number {
  return config.primaryGroup !== null && room.isGroup && room.chatId === config.primaryGroup
    ? (config.primaryTalkValue ?? config.talkValue)
    : config.talkValue
}

/**
 * 关键词 → 语气提示。
 *
 * 只在**被叫到时**才追加到入站行里（见 `renderMessageLine` 的 `reactionHint`）：
 * 悄悄话式的语气提示混进无关消息里，模型会照着演。
 */
export function reactionHintOf(config: TriggerConfig, event: OneBotEvent): string | null {
  const raw = rawText(event)
  for (const rule of config.keywordReactions) {
    if (rule.keywords.some((keyword) => raw.includes(keyword))) return rule.reaction
  }
  return null
}
