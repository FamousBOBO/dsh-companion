/** 旁听采集的**轻活**：一条群消息 → 进环的旁听行；以及被叫到时取回"尚未交付的背景"。
 *
 * 为什么单独一个文件：旁听要"便宜"。被 @ 的那条走的是完整取材（下载图片、转写语音、
 * 展开转发、拉引用），而群里 99% 的消息只是路过——给它们付一遍下载与识图的代价，
 * 等于为了让模型"可能看得到背景"而给每条消息收费。
 *
 * 这里只做纯渲染与记账的**搬运**：不碰网络、不碰盘、不碰模型。附件在背景里只留标记
 * （`[图片]` / `[语音]`），需要看内容时就等真的被 @ 了再说。
 *
 * 环的**唯一写入者**是这里（`captureAmbient`）：`presence` 执行器只读（`peekAfter`），
 * 两条写路径会让同一条消息进两次、游标也会错位。
 */

import { renderMessageContent, renderMessageLine } from '../../core/message/render.js'
import type { ParsedInbound } from '../../core/message/parse.js'
import type { OneBotEvent } from '../../types.js'
import {
  ambientLimitsOf, type AmbientStore, type PresenceSettings,
} from './ambient-store.js'

/** 自主接话执行器（可缺省）：流水线只通知"这个群又有一条新的旁听"。 */
export interface PresenceObserver {
  observe(groupId: number): void
}

/** 本模块要用的 `presence` 配置项（判断与背景共用同一组投射上限）。 */
export type AmbientPresenceSettings = PresenceSettings & {
  readonly judgeMaxEntries: number
  readonly judgeMaxChars: number
}

/** 这条消息是不是她自己发的（NapCat 会把自己的消息也回推上来）。 */
export function isSelfMessage(event: OneBotEvent, selfId: number | undefined): boolean {
  return typeof selfId === 'number' && event.user_id === selfId
}

/**
 * 旁听行：与入站行同一套渲染（发送者 QQ 号、时间、消息号都在里面），但**不带**
 * 语气提示、不展开引用与转发、不转写语音——那些都要花钱或要网络。
 *
 * 只有语音/文件/卡片这类"没有正文但有内容"的消息，才把显示占位符当作正文渲染，
 * 否则背景里会出现一行"某人 12:00 说了什么也没说"的空白。
 *
 * 返回 `null` 表示这条没有任何可留的内容（纯表情、空正文），不必进缓冲。
 */
export function ambientTextOf(event: OneBotEvent, parsed: ParsedInbound, nowMs: number): string | null {
  // 没有真实文字、但有 `[语音]`/`[文件…]`/`[卡片]` 这类占位：把它们当正文用（只用于背景）。
  const effective = parsed.plainText.trim() === '' && parsed.text.trim() !== ''
    ? { ...parsed, plainText: parsed.text }
    : parsed
  const line = renderMessageLine({
    event,
    parsed: effective,
    called: false,
    // 引用不展开：拉一次 `get_msg` 换一行前缀不值得；被 @ 时那条会照常展开。
    quoted: null,
    // 语音不转写：转写要调服务，背景不值得为它排队（占位符 `[语音]` 已经说明有语音）。
    voiceText: null,
    nowMs,
  })
  if (line === null) return null
  return line.replace(/\s+$/, '')
}

/**
 * 一条旁听的**正文**：与 {@link ambientTextOf} 同一套取法（`renderMessageContent`），
 * 但不带发送者抬头。没有正文时返回 `null`（与整行同一条判据）。
 */
export function ambientBodyOf(parsed: ParsedInbound): string | null {
  const body = renderMessageContent(parsed)
  return body === null ? null : body.replace(/\s+$/, '')
}

export interface CaptureInput {
  readonly ambient?: AmbientStore | undefined
  readonly presence?: PresenceObserver | undefined
  readonly settings: AmbientPresenceSettings
  readonly groupId: number
  readonly event: OneBotEvent
  readonly parsed: ParsedInbound
  readonly selfId?: number | undefined
  readonly nowMs: number
}

/**
 * 记一条旁听。
 *
 * 自己的消息也记（`self: true`）：她刚说过什么正是判断"要不要接着说"的依据；
 * 但**不**拿它去触发自主判断，否则自己发的消息会把自己再叫一遍。
 */
export function captureAmbient(input: CaptureInput): void {
  const store = input.ambient
  if (store === undefined) return
  const text = ambientTextOf(input.event, input.parsed, input.nowMs)
  if (text === null) return
  const self = isSelfMessage(input.event, input.selfId)
  const ring = store.ring(input.groupId, ambientLimitsOf(input.settings))
  const body = ambientBodyOf(
    input.parsed.plainText.trim() === '' && input.parsed.text.trim() !== ''
      ? { ...input.parsed, plainText: input.parsed.text }
      : input.parsed,
  )
  const outcome = ring.add({
    messageId: typeof input.event.message_id === 'number' ? input.event.message_id : null,
    userId: input.event.user_id ?? 0,
    name: input.event.sender?.card?.trim() || input.event.sender?.nickname || '',
    text,
    ...(body === null ? {} : { body }),
    atMs: input.nowMs,
    self,
  })
  if (outcome !== 'added' || self) return
  input.presence?.observe(input.groupId)
}

export interface BackgroundInput {
  readonly ambient?: AmbientStore | undefined
  readonly settings: AmbientPresenceSettings
  readonly groupId: number | null
  readonly messageId: number | undefined
  readonly nowMs: number
  /** 这个会话当前攒批队列里有几行（非空说明"待回块"已经有内容）。 */
  readonly queueLength: number
}

/**
 * 被叫到时带上的"旁听背景"：游标之后、尚未交付过的最近一段。
 *
 * 只在**队列是空的**时候取：队列非空说明这一包已经有"待回块"，同一批消息再从旁听
 * 里出现一遍就是同一句话喂两遍。当前这条消息自己按 `messageId` 排除。
 */
export function takeBackground(input: BackgroundInput): string {
  const store = input.ambient
  if (store === undefined || input.groupId === null) return ''
  if (input.queueLength > 0) return ''
  const ring = store.ring(input.groupId, ambientLimitsOf(input.settings))
  const entries = ring.take(input.nowMs, {
    excludeMessageId: typeof input.messageId === 'number' ? input.messageId : null,
    maxEntries: input.settings.judgeMaxEntries,
    maxChars: input.settings.judgeMaxChars,
  })
  return entries.map((entry) => entry.text).join('\n')
}
