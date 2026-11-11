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
  /**
   * 表情（mface / 收藏表情 / 动图表情）的元数据，与 `imageUrls` **互斥**。
   *
   * 表情在 OneBot 里也是 `image` 段，但它表达的是**一句话**（`[困]` = 我困了），
   * 不是一幅画。分开记之后：渲染层写 `[表情：困]`、采集层能按 `key` 认出
   * 「这个表情以前见过」从而复用它的意思，而不是每次重新描述一遍画面。
   */
  stickers: StickerSeg[]
  /** 表情图的地址（只为下载用；不进 `imageUrls`，避免被当成照片处理）。 */
  stickerUrls: string[]
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
    stickers: [],
    stickerUrls: [],
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

/**
 * 一个「表情」段（QQ 的 mface / 收藏表情 / 动图表情）的元数据。
 *
 * 为什么要单独认出来：表情在 NapCat 里也是 `image` 段，`summary` 里写着 `[动画表情]` 或
 * `[困]`。原来把这些一并当图片，渲染成 `[图片][图片含义：[动画表情]]` —— 模型读到的
 * 是「我看到了一张图，图里写着动画表情」，于是它会去**描述**这张图。表情不是图，
 * 它是**一句话**：`[困]` 意思是「我困了」。所以这里把它拆出来，让渲染层能写成
 * `[表情：困]`，并在没认出时如实写 `[表情：不认识]`，而不是编一段画面描述。
 */
export interface StickerSeg {
  /** 稳定指纹（不含 QQ 号）：优先 NapCat 的 file 名，其次 summary 文本，最后 url 末段。 */
  key: string
  /** `summary` 里透出来的字面（`困` / `开心`）；泛称（`动画表情`）时为空串。 */
  label: string
  /** `summary` 只是泛称：这条没有可用的意思。 */
  generic: boolean
  /** 动图线索（GIF/WebP/APNG 或 summary 里写了动画）。 */
  animated: boolean
  /**
   * 段类型。恒为 `'sticker'`，**存在的意义是让下游不必靠猜**：`imageUrls` 里的是图
   * （可能要让 Bot 看内容），`stickers` 里的是话（默认在表达情绪）。
   */
  kind: 'sticker'
  /**
   * 语义处置口径。恒为 `'emotion-support'`：表情是**情绪辅助表达**，不是待描述的图。
   *
   * 为什么把它写成字段而不是只写进提示词：模型侧的行为由两处决定——提示词怎么说，
   * 以及它可以引用哪些事实。字段进了入站行，模型才能看到一个明确的「按情绪理解」标记，
   * 而不是被要求从 `[表情：困]` 里自己推断「这到底算不算图」。
   */
  semanticPolicy: 'emotion-support'
}


/** `summary` 里这些词只说明「这是个表情」，不是表情的意思。 */
const GENERIC_STICKER_LABELS = new Set(['动画表情', '表情', '图片', '照片', '动图', 'gif', 'sticker'])

/** `sub_type`（下划线，QQNT 的）为 1 就是表情；`subtype` 是历史拼写，入站也认。 */
function stickerSubType(data: Record<string, unknown>): boolean {
  const raw = data.sub_type ?? data.subtype
  return raw === 1 || raw === '1'
}

/** `summary` 去掉方括号后的文本；`[图片]` 这种纯占位符返回 `null`。 */
function summaryInner(summary: string): string | null {
  const text = summary.trim().replace(/^\[/, '').replace(/\]$/, '').trim()
  if (text === '') return null
  if (text === '图片' || text === '照片') return null
  return text
}

/** 从 url 里取文件名（去查询串），没有就空串。 */
function urlStem(url: string): string {
  try {
    const base = new URL(url).pathname.split('/').filter(Boolean).pop() ?? ''
    return base.replace(/\.[a-z0-9]{1,5}$/i, '')
  } catch {
    return ''
  }
}

/**
 * 段里能当指纹的东西，按稳定性排序：`file` 的 stem → mface 的 `key` → 字面 → url 末段。
 *
 * 为什么不直接用 url：QQ 的图片地址带有时效签名（`rkey=…`），同一个表情每次都不一样，
 * 拿它当键等于每次都是新的。`file` 与 mface `key` 才是「这张图」的稳定标识。
 */
function stickerKeyOf(data: Record<string, unknown>, label: string): string {
  const file = typeof data.file === 'string' ? data.file : ''
  const stem = file.replace(/^.*[\\/]/, '').replace(/\.[a-z0-9]{1,5}$/i, '').trim()
  if (stem !== '') return `f:${stem}`
  const marketKey = typeof data.key === 'string' ? data.key.trim() : ''
  if (marketKey !== '') return `k:${marketKey}`
  if (label !== '') return `s:${label}`
  const fromUrl = urlStem(String(data.url ?? ''))
  return fromUrl === '' ? '' : `u:${fromUrl}`
}

/**
 * 判定一个 `image` 段是不是表情；是就返回元数据，不是返回 `null`。
 *
 * 三个来源都认（实测同一台 NapCat 三种都会出现）：`sub_type=1`、`summary` 带方括号、
 * 以及 mface 那几个字段（`emoji_id` / `emoji_package_id` / `key`）。
 */
export function stickerOf(data: Record<string, unknown>): StickerSeg | null {
  const summary = typeof data.summary === 'string' ? data.summary.trim() : ''
  const inner = summaryInner(summary)
  const marketFace = [data.emoji_id, data.emoji_package_id, data.key].some(
    (value) => typeof value === 'string' && value.trim() !== '',
  )
  const bracketed = /^\[[^\]]+\]$/.test(summary)
  if (!stickerSubType(data) && !marketFace && !bracketed) return null
  const lowered = (inner ?? '').toLowerCase()
  const generic = inner === null || GENERIC_STICKER_LABELS.has(lowered)
  const animated = /动画|动图|gif/i.test(summary) || /\.gif(\?|$)/i.test(String(data.url ?? ''))
  return {
    key: stickerKeyOf(data, generic ? '' : (inner ?? '')),
    label: generic ? '' : (inner ?? ''),
    generic,
    animated,
    kind: 'sticker',
    semanticPolicy: 'emotion-support',
  }
}


/**
 * 图片段：URL 与文字摘要是两件事（摘要可能来自 NapCat，也可能是模型给的），显示位放占位符。
 *
 * 表情走另一条：`[表情：困]` / `[表情：不认识]`，**不进 `imageSummaries`**。原来它进的是
 * `[图片含义：…]`，模型于是把「动画表情」当成画面内容去描述——表情是话，不是画。
 */
function pushImage(
  seg: { readonly data: Record<string, unknown> },
  parsed: ParsedInbound,
  parts: string[],
): void {
  const url = typeof seg.data.url === 'string' ? seg.data.url : ''
  const sticker = stickerOf(seg.data)
  if (sticker !== null) {
    if (url) parsed.stickerUrls.push(url)
    parsed.stickers.push(sticker)
    parts.push(stickerDisplay(sticker))
    return
  }
  if (url) parsed.imageUrls.push(url)
  // `[图片]` 这种占位符不是含义，收进来只会污染 `[图片含义：…]`。
  const summary = typeof seg.data.summary === 'string' ? seg.data.summary : ''
  if (summary && summary !== '[图片]') parsed.imageSummaries.push(summary)
  parts.push('[图片]')
}

/**
 * 表情在消息行里的写法：`[表情：困｜key=f:0AB4…]`。
 *
 * 为什么把 key 一起印出来：模型要能在**下一轮**用工具把意思记到这张表情上（`expression_sticker_note`
 * 只认这个指纹，不认路径/URL）。不带 key 的话每次都得重新描述画面——正是要避免的那件事。
 * 认不出字面时写 `[表情：不认识｜key=…]`，让它知道该问一句，而不是编。
 */
export function stickerDisplay(sticker: StickerSeg): string {
  const name = sticker.label === '' ? '不认识' : sticker.label
  return sticker.key === '' ? `[表情：${name}]` : `[表情：${name}｜key=${sticker.key}]`
}

/** @：分三种——@全体、@我、@了别人（记下 QQ 号，好让模型指名回应）。 */
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
