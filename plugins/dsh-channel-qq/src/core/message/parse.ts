/** OneBot message segment ↔ text conversions for the agent boundary. */

import type { OneBotEvent, OneBotMessage, OneBotMessageSegment } from '../../types.js'

export interface ParsedInbound {
  /**
   * Display rendering: real text *plus* human-readable placeholders for
   * non-text segments (`[图片]`, `[表情:5]`, `[语音]`, `[文件：x]`, `[视频]`).
   *
   * This is what the agent's intake line shows, and what trigger matching runs
   * against — the model must be able to see that an image was sent.
   */
  text: string
  /**
   * Only the real text segments.
   *
   * Anything that treats `text` as *content* must use this instead: the
   * placeholders in `text` are UI, not words. They were once learned as group
   * slang (`[图片]` became a "口癖") and counted as flood spam, because both fed
   * on the display rendering.
   */
  plainText: string
  imageUrls: string[]
  imageSummaries: string[]
  isAtBot: boolean
  replyToMessageId: number | null
  hasAtAll: boolean
  /** Voice-bar segments present (STT candidates). */
  recordCount: number
  /** QQ ids @-ed in the message (excluding the bot and @全体). */
  atIds: number[]
  /** Inbound files: [fileName, url, fileId]. */
  files: Array<{ name: string; url: string; fileId: string }>
  /** 合并转发段：只有容器 id，内容要调 `get_forward_msg` 展开（pipeline 做）。 */
  forwards: Array<{ id: string }>
  /** 小程序 / JSON / Ark 卡片：从 meta 里提取的标题与摘要（纯本地，零请求）。 */
  cards: Array<{ title: string; text: string }>
}

/**
 * The placeholder forms `parseInbound` can put into `text`.
 *
 * Exported so the learn store can strip them as a second line of defence: the
 * model can also hand `[图片]` to the manual `qq_learn_phrase` tool, and a
 * phrase library that contains placeholders is worse than an empty one.
 */
export const MEDIA_PLACEHOLDER_PATTERN =
  /\[(?:图片|语音|视频|动画表情|表情(?::\d+)?|文件[：:][^\]]*|文件|回复|合并转发|音乐|位置|链接|卡片|小程序|JSON|XML|CQ:[^\]]*)\]/g

function log_reply_parse(raw: unknown): void {
  // Non-numeric reply ids (rare gateway variants) are surfaced via console;
  // the bridge logs the failed get_msg anyway.
  console.warn(`[dsh-channel-qq] unparseable reply id: ${JSON.stringify(raw)}`)
}

function segmentsOf(message: OneBotMessage | undefined): OneBotMessageSegment[] {
  if (message === undefined) return []
  if (typeof message === 'string') {
    return message.trim() === '' ? [] : [{ type: 'text', data: { text: message } }]
  }
  return message
}

/**
 * 每个字段都从这里出发，字段就漏不掉；也让 `parseInbound` 本身只剩"过一遍消息段"
 * 那一件事（单函数超过 60 行会被 `check-size` 拦住，而 79 行的 switch 正是那种
 * "再加一个段类型就没人敢动"的形状）。
 */
function emptyParsed(): ParsedInbound {
  return {
    text: '',
    plainText: '',
    imageUrls: [],
    imageSummaries: [],
    isAtBot: false,
    replyToMessageId: null,
    hasAtAll: false,
    recordCount: 0,
    files: [],
    forwards: [],
    cards: [],
    atIds: [],
  }
}

/** 文字段：正文同时进"显示渲染"与"纯文字"两份，空串不入列。 */
function pushText(seg: { readonly data: { text: string } }, parts: string[], plainParts: string[]): void {
  const text = seg.data.text.trim()
  if (text === '') return
  parts.push(text)
  plainParts.push(text)
}

/** 图片段：URL 与文字摘要是两件事（摘要可能来自 NapCat，也可能是模型给的），显示位放占位符。 */
function pushImage(
  seg: { readonly data: { url?: string; summary?: string } },
  parsed: ParsedInbound,
  parts: string[],
): void {
  if (seg.data.url) parsed.imageUrls.push(seg.data.url)
  // `[图片]` 这种占位符不是含义，收进来只会污染 `[图片含义：…]`。
  if (seg.data.summary && seg.data.summary !== '[图片]') parsed.imageSummaries.push(seg.data.summary)
  parts.push('[图片]')
}

/** @：分三种——@全体、@咱、@了别人（记下 QQ 号，好让模型指名回应）。 */
function applyAt(data: { readonly qq: string }, event: OneBotEvent, parsed: ParsedInbound): void {
  if (data.qq === 'all') { parsed.hasAtAll = true; return }
  if (data.qq === String(event.self_id)) { parsed.isAtBot = true; return }
  const id = Number(data.qq)
  if (Number.isSafeInteger(id) && id > 0 && !parsed.atIds.includes(id)) parsed.atIds.push(id)
}

/** 引用段：只认正整数消息号。 */
function applyReply(data: { readonly id: string }, parsed: ParsedInbound): void {
  const rawId = data.id
  const id = typeof rawId === 'number' ? rawId : Number(String(rawId ?? '').trim())
  if (Number.isSafeInteger(id) && id > 0) parsed.replyToMessageId = id
  else log_reply_parse(rawId)
}

/** 合并转发段：占位 + 留下容器 id（展开要走 `get_forward_msg`，pipeline 做）。 */
function pushForward(data: { readonly id?: string }, parsed: ParsedInbound, parts: string[]): void {
  parts.push('[合并转发]')
  const id = data.id ?? ''
  if (id !== '') parsed.forwards.push({ id })
}

/**
 * 小程序 / JSON / Ark 卡片：只解析 `meta` 里的标题与摘要（news / music / miniapp /
 * structured 四种形态都见过），正文是 JSON 字符串，坏 JSON 兜底显示前 80 字。
 */
function pushJson(data: { readonly data?: string }, parsed: ParsedInbound, parts: string[]): void {
  const raw = (data.data ?? '').trim()
  let title = ''
  let text = ''
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>
    const meta = (obj.meta ?? {}) as Record<string, Record<string, unknown>>
    const detail = meta.news ?? meta.music ?? meta.miniapp ?? meta.structured ?? null
    if (detail !== null) {
      title = String(detail.title ?? detail.prompt ?? '')
      text = String(detail.desc ?? detail.summary ?? detail.jump_url ?? '')
    } else {
      title = String(obj.prompt ?? obj.title ?? '')
      text = String(obj.desc ?? '')
    }
  } catch {
    text = raw.slice(0, 80)
  }
  title = title.replace(/\s+/g, ' ').trim().slice(0, 60)
  text = text.replace(/\s+/g, ' ').trim().slice(0, 120)
  parts.push(title === '' ? '[卡片]' : `[卡片]${title}`)
  if (title !== '' || text !== '') parsed.cards.push({ title, text })
}

/** 文件段：显示成 `[文件：名字(大小)]`，同时留下下载所需的三元组。 */
function pushFile(
  data: { readonly file?: string; readonly url?: string; readonly file_id?: string; readonly id?: string; readonly file_size?: number | string },
  parsed: ParsedInbound,
  parts: string[],
): void {
  const name = data.file ?? '文件'
  const sizeNum = typeof data.file_size === 'string' ? Number(data.file_size) : data.file_size
  const sizeStr = typeof sizeNum === 'number' && sizeNum > 0 ? `(${Math.round(sizeNum / 1024)}KB)` : ''
  parts.push(`[文件：${name}${sizeStr}]`)
  // JSON 段的字段是 file_id；CQ 码解析出来的叫 id——两个名字都认。
  parsed.files.push({ name, url: data.url ?? '', fileId: data.file_id ?? data.id ?? '' })
}

export function parseInbound(event: OneBotEvent): ParsedInbound {
  const parsed = emptyParsed()
  const parts: string[] = []
  // Real text only, in segment order. Kept separate from `parts` so consumers
  // that care about words never see the placeholders (see `plainText`).
  const plainParts: string[] = []
  for (const seg of segmentsOf(event.message)) {
    switch (seg.type) {
      case 'text': pushText(seg, parts, plainParts); break
      case 'image': pushImage(seg, parsed, parts); break
      case 'at': applyAt(seg.data, event, parsed); break
      case 'reply': applyReply(seg.data, parsed); break
      case 'forward': pushForward(seg.data, parsed, parts); break
      case 'json': case 'ark': pushJson(seg.data, parsed, parts); break
      case 'face': parts.push(`[表情:${seg.data.id}]`); break
      case 'record': parsed.recordCount += 1; parts.push('[语音]'); break
      case 'file': pushFile(seg.data, parsed, parts); break
      case 'video': parts.push('[视频]'); break
      default: break
    }
  }
  // Keyword triggers run against this rendering so name calls in plain text
  // match even when the event carries no text segment, and so a "发图" trigger
  // still sees that an image arrived.
  parsed.text = parts.join(' ')
  parsed.plainText = plainParts.join(' ')
  return parsed
}

/** Flattened raw text (for trigger matching), tolerating string-only messages. */
export function rawText(event: OneBotEvent): string {
  if (typeof event.message === 'string') return event.message
  return parseInbound(event).text
}
