/** 表情/图片的视觉打标：把一张图的字节变成 `{desc, tags}`。
 *
 * 从 `emoji-library.ts` 拆出来（体量棘轮），也把三个容易踩的坑集中在一处：
 *
 *   1. **消息形状**：宿主 `llm.stream` 的图片是 `{type:'image', attachment}`，
 *      附件必须先用 `attachments.saveImage` 落盘。曾经写成 OpenAI 的
 *      `image_url` + data URL，模型收到的消息里没有图，于是回「未收到图片」，
 *      整库标签退化成「疑问/无语/尴尬」（2026-10-21 线上）。
 *   2. **媒体类型**：QQ 的表情包经常是 `.png` 后缀装 GIF/WebP，HTTP 头也常是
 *      `application/octet-stream`；声明错时宿主直接拒绝附件。这里按文件头判断。
 *   3. **输出合规**：默认模型有时先输出思考过程再写 JSON。第一次解析失败就换
 *      一句更短的提示再试一次；仍不合规就放弃（不落库，避免污染标签）。
 */

export interface TaggingLlm {
  stream(options: Record<string, unknown>): AsyncIterable<{ readonly text?: string }>
}

export interface TaggingAttachments {
  saveImage(input: { data: Uint8Array; mediaType: string; name?: string }): Promise<unknown>
}

export interface TaggingSelection {
  readonly provider: string
  readonly model: string
}

export interface TagResult {
  readonly desc: string
  readonly tags: string[]
}

export interface TagImageInput {
  readonly attachments: TaggingAttachments
  readonly llm: TaggingLlm
  readonly selection: TaggingSelection
  readonly data: Buffer | Uint8Array
  readonly mediaType: string
  readonly name: string
  readonly log: (line: string) => void
}

const TAG_PROMPT = [
  '你是表情包索引员。看这张表情包/图片，输出一行 JSON（不要多余文字）：',
  '{"desc":"<20字内描述画面内容>","tags":["<情绪/用途标签1>","<标签2>","<标签3>"]}',
  'tags 从这些常用维度挑3-5个：开心 大笑 哭 委屈 生气 嘲讽 无语 尴尬 害羞 点赞 摸鱼 吃瓜 惊讶 害怕 疑问 加油 睡觉。若图片有文字也写进 desc。',
].join('\n')

/** 第二次尝试：第一次输出了思考过程时，用最短的话把它逼回 JSON。 */
const TAG_RETRY_PROMPT = '不要思考过程。只输出一行 JSON：{"desc":"画面内容","tags":["情绪1","情绪2","情绪3"]}'

/** 模型说"没看到图"时的措辞：不要落库。 */
const NO_IMAGE = /未(收到|提供)图片|无法识别|没有(收到|提供)图片/

/** 情绪词表（与 TAG_PROMPT 一致）：散文兜底时从中挑标签。 */
const MOOD_WORDS = [
  '开心', '大笑', '哭', '委屈', '生气', '嘲讽', '无语', '尴尬', '害羞',
  '点赞', '摸鱼', '吃瓜', '惊讶', '害怕', '疑问', '加油', '睡觉',
]

/** 散文里"画面是什么"的起点（推理模型常常先写一段"用户想要…"再描述）。 */
const PROSE_MARKERS: RegExp =
  /(?:需要(?:观察|基于)|观察)图片[:：]?|图片(?:是|显示|里|中|上)[:：]?|画面(?:是|中|里)[:：]?|这张图(?:是|显示)[:：]?|The image (?:is|shows)[:：]?/gi

/** 元叙述句：不是画面描述，拼进 desc 只会让检索变脏。 */
const META_SENTENCE = /需要|JSON|json|输出|标签|思考|用户|我们|回答|精简|不能有/

/**
 * 散文兜底：模型没给 JSON，但通常已经在文字里描述了画面。
 *
 * 为什么要它：默认模型是推理模型，约一半的图片会先输出思考过程再写 JSON，
 * 甚至完全不写 JSON（2026-10-21 实测：67 张里只有 10 张一次成功）。这些文字
 * 本身包含"图片是…""需要观察图片：…"的可读描述，丢掉它们等于白调一次视觉模型。
 *
 * 规则：从**最后一个**内容标记之后取描述，丢掉元叙述句与"标签："尾巴；标签只
 * 从固定情绪词表里找（不做自由创作，避免又回到"疑问/无语"的污染）。
 */
export function readProseReply(text: string, log: (line: string) => void): TagResult | null {
  let body = text.trim()
  if (body === '' || NO_IMAGE.test(body)) return null
  let start = -1
  for (const match of body.matchAll(PROSE_MARKERS)) start = (match.index ?? 0) + match[0].length
  if (start >= 0) body = body.slice(start)
  const tail = body
  const kept = body
    .split(/(?<=[。！？!?])\s*/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== '' && !META_SENTENCE.test(sentence))
  body = kept.join(' ').split(/标签[:：]/)[0]?.trim() ?? ''
  if (body.length < 6) body = tail.split(/标签[:：]/)[0]?.trim() ?? ''
  if (body.length < 6) return null
  const tags = MOOD_WORDS.filter((word) => text.includes(word)).slice(0, 3)
  const desc = body.replace(/\s+/g, ' ').slice(0, 120)
  log(`emoji tagged (prose) [${tags.join(',')}] ${desc}`)
  return { desc, tags }
}

/** 从模型输出里抠出 JSON：容忍 ```json 围栏、前后多余文字、多个候选。 */
export function parseTagJson(text: string): { desc?: unknown; tags?: unknown } | null {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim()
  const candidates = [cleaned]
  for (const match of cleaned.matchAll(/\{[^{}]*\}/g)) candidates.push(match[0])
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate) as unknown
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        return value as { desc?: unknown; tags?: unknown }
      }
    } catch { /* 试下一个候选 */ }
  }
  return null
}

/** 模型把提示词里的占位符当标签抄回来的情况（`情绪1`/`标签2`）。 */
export function isPlaceholderTag(tag: string): boolean {
  return /^(情绪|标签|tag|mood)\d*$/i.test(tag.trim())
}

/** 把模型回复变成结果；不是 JSON / 说没看到图 → null。 */
export function readTagReply(text: string, log: (line: string) => void): TagResult | null {
  const parsed = parseTagJson(text)
  if (parsed === null) {
    log(`emoji tagging skipped: 响应不是 JSON：${text.slice(0, 80)}`)
    return null
  }
  const desc = typeof parsed.desc === 'string' ? parsed.desc.trim() : ''
  if (NO_IMAGE.test(desc)) {
    log(`emoji tagging skipped: 模型没有看到图片（${desc.slice(0, 40)}）`)
    return null
  }
  const tags = Array.isArray(parsed.tags)
    ? parsed.tags
      .map((tag) => String(tag).toLowerCase().slice(0, 12))
      .filter((tag) => tag !== '' && !isPlaceholderTag(tag))
      .slice(0, 5)
    : []
  return { desc: desc.slice(0, 120), tags }
}

/**
 * 用文件头判断真实媒体类型。
 *
 * 为什么不信扩展名/HTTP 头：QQ 的表情包经常是 `.png` 后缀里装着 GIF 或 WebP，
 * 偷取时 `content-type` 也常是 `application/octet-stream`。声明错类型时宿主会
 * 拒绝附件（`Declared image type does not match its bytes`），打标就整批失败。
 */
export function sniffImageMediaType(data: Uint8Array): string | null {
  const b = data
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif'
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp'
  return null
}

/** 收完一次流式输出。 */
async function collectText(stream: AsyncIterable<{ readonly text?: string }>): Promise<string> {
  let text = ''
  for await (const chunk of stream) if (typeof chunk?.text === 'string') text += chunk.text
  return text
}

/** 打标入口：存附件 → 最多两次请求 → `{desc, tags}` 或 null。 */
export async function tagImage(input: TagImageInput): Promise<TagResult | null> {
  const mediaType = sniffImageMediaType(input.data) ?? input.mediaType
  const attachment = await input.attachments.saveImage({
    data: input.data,
    mediaType,
    name: input.name,
  })
  const attempts: ReadonlyArray<readonly [string, number]> = [[TAG_PROMPT, 260], [TAG_RETRY_PROMPT, 180]]
  for (let i = 0; i < attempts.length; i += 1) {
    const [prompt, maxTokens] = attempts[i]!
    const text = await collectText(input.llm.stream({
      provider: input.selection.provider,
      model: input.selection.model,
      maxTokens,
      messages: [{
        role: 'user',
        content: [{ type: 'image', attachment }, { type: 'text', text: prompt }],
      }],
    }))
    const strict = readTagReply(text, input.log)
    if (strict !== null) return strict
    // 最后一轮还拿不到 JSON：从散文里抠描述（推理模型的常见输出）。
    if (i === attempts.length - 1) return readProseReply(text, input.log)
  }
  return null
}
