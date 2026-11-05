/** 群聊口癖仓库 (P1-7)：攒下群友反复说的短句，让模型说话"像群里人"。
 * （P4.2：从 src/learn.ts 拆出，本文件只装类型 + 仓库；runner 在 ./runner.ts、
 * 工具面在 ./tools.ts。）
 *
 * 为什么这么设计：
 * - `observe` 是高频路径（每条群消息都过一遍），所以只累积在内存里，绝不落盘；
 *   落盘交给 `flush()`（由 `LearnRunner` 每 5 分钟调一次）。每条消息都写一次
 *   JSON 文件，在活跃群里就是磁盘轰炸。
 * - `count >= 2` 才落盘：一句话只出现一次八成是噪音，攒够两次才值得留。
 * - 整条消息 ≤ 20 字时整条当候选（"笑死我了"这种），长消息只取结尾的 2–8 字
 *   短句——口癖几乎都长在句尾（"……真的会谢"）。
 * - 候选直接喂给模型时要求"自然用出来"，不要生硬堆砌；`note` 带上最近一次出现
 *   的语境，模型才判断得出这句该在什么时候说。
 */

import * as path from 'node:path'
import type { LearnConfig } from '../../config.js'
import { JsonStore } from '../../adapters/fs-store/json-store.js'
import { MEDIA_PLACEHOLDER_PATTERN } from '../../core/message/parse.js'

/** 一条学到的短语。key = groupId + text（同一个梗在不同群算两条）。 */
export interface LearnedPhrase {
  text: string
  /** 出现次数（同一人重复说也算）。 */
  count: number
  /** 说过这句的 QQ 号（去重）。 */
  speakers: number[]
  /** 第一次听到的时间戳。 */
  first: number
  /** 最近一次听到的时间戳。 */
  last: number
  groupId: number
  /** 最近一次出现在什么语境里（原文片段），给模型判断用法用。 */
  note: string
  /** `slang` = 黑话词条（带释义）；缺省/`phrase` = 口癖。 */
  kind?: 'phrase' | 'slang'
  /** 黑话释义（只有 slang 有）。 */
  meaning?: string
}

/** 内存里最多跟踪多少候选：超出就丢 count 最低的，防止长跑进程内存膨胀。 */
const MAX_TRACKED = 5_000
/** 落盘上限：按 count 从高到低截断，文件不会无限长。 */
const MAX_PERSISTED = 2_000
/** 整条消息不超过这个长度时，整条当候选。 */
const WHOLE_MESSAGE_MAX = 20
/** 长消息只取结尾的短句，长度落在这个区间。 */
const TAIL_MIN = 2
const TAIL_MAX = 8

/**
 * 去噪：CQ 码 / 非文字占位符 / URL / @提及 / emoji / 多余空白。
 * 不做分词——口癖是"原话"，切词反而会把整句拆散。
 *
 * 占位符这一条是必需的，不是保险：`[图片]`/`[语音]`/`[文件：…]` 曾经被当成
 * 口癖学进来（来源是展示用的渲染文本）。上游已经改用 `plainText`，但手动
 * `qq_learn_phrase` 是模型传参，它完全可能把 `[图片]` 递进来，所以这里再拦一道。
 */
function normalizePhraseSource(text: string): string {
  return text
    .replace(MEDIA_PLACEHOLDER_PATTERN, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\bwww\.[^\s]+/gi, ' ')
    .replace(/@[^\s@]{0,20}/g, ' ')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{FE0F}\u{200D}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 掐掉两头的标点/符号：口癖不会以"…""！"开头或结尾。 */
function stripEdges(text: string): string {
  return text.replace(/^[\p{P}\p{S}\s]+/u, '').replace(/[\p{P}\p{S}\s]+$/u, '')
}

/** 从一条群消息里抽候选短语（0 或 1 条）。 */
function extractCandidates(raw: string): string[] {
  const cleaned = stripEdges(normalizePhraseSource(raw))
  // 纯表情/纯标点/太短：学不来。
  if (cleaned.length < TAIL_MIN) return []
  if (!/[\p{L}\p{N}]/u.test(cleaned)) return []
  if (cleaned.length <= WHOLE_MESSAGE_MAX) return [cleaned]
  const chunks = cleaned
    .split(/[。！？!?…~～；;，,、\s]+/u)
    .map(stripEdges)
    .filter((chunk) => chunk.length >= TAIL_MIN)
  // 显式标成 string | undefined 再判空：noUncheckedIndexedAccess=false 时索引
  // 结果是 string，直接 `=== undefined` 会被 strict 当成无重叠比较。
  const tail: string | undefined = chunks[chunks.length - 1]
  if (tail === undefined || tail === '') return []
  const phrase = tail.length > TAIL_MAX ? tail.slice(-TAIL_MAX) : tail
  return phrase.length >= TAIL_MIN ? [phrase] : []
}

function keyOf(groupId: number, text: string): string {
  return `${groupId}\u0000${text}`
}

/** 群聊口癖仓库：内存累积 + 定期合并落盘。 */
export class LearnStore {
  /** 落盘文件（绝对路径）。 */
  readonly file: string
  /** 所有在跟踪的候选（已落盘的 + 还没够格的）。 */
  private entries = new Map<string, LearnedPhrase>()
  /** 上一轮真的写进文件里的 key，用于 stats 和"已落盘就别丢"的判断。 */
  private persistedKeys = new Set<string>()
  /** 有变化才写盘（每 5 分钟一次的 flush 不该空转）。 */
  private dirty = false
  /** 读盘失败过：此后拒绝写盘，绝不拿空内存覆盖一份读不懂的文件。 */
  private loadFailed = false
  private readonly store: JsonStore<unknown>
  private readonly log: (line: string) => void

  constructor(
    private readonly config: LearnConfig,
    opts: { workspacePath: string | null; dshHome: string; log: (line: string) => void },
  ) {
    this.log = opts.log
    // 没有 agent 工作区时退到 <dshHome>/channel-qq，和 sent-log 一个位置。
    const base = opts.workspacePath ?? path.join(opts.dshHome, 'channel-qq')
    // 显式标成 string | null | undefined：config.file 的类型是 string | null，
    // 直接和 undefined 比较会被 strict 判成"无重叠比较"（脏配置里真可能是 undefined）。
    const configured: string | null | undefined = config.file
    this.file = configured === null || configured === undefined || configured.trim() === ''
      ? path.join(base, 'learned-phrases.json')
      // 相对路径按工作区解析：配置里写 'data/phrases.json' 也能落到预期位置。
      : (path.isAbsolute(configured) ? configured : path.resolve(base, configured))
    this.store = new JsonStore<unknown>(this.file, { log: opts.log })
  }

  /** 读文件；任何损坏都降级成"从零开始"，绝不把启动带崩（同 sent-log）。 */
  async load(): Promise<void> {
    this.entries = new Map()
    this.persistedKeys = new Set()
    this.dirty = false
    try {
      const parsed: unknown = await this.store.load(null)
      // 兼容两种历史写法：裸数组，或 { version, phrases: [...] }。
      // 全程按 unknown 逐字段校验：磁盘上的东西不可信，坏一条不能带崩整库。
      const container: unknown = Array.isArray(parsed) ? parsed : (parsed as { phrases?: unknown } | null)?.phrases
      const list: unknown[] = Array.isArray(container) ? container : []
      for (const item of list) {
        if (item === null || typeof item !== 'object') continue
        const record = item as Record<string, unknown>
        const text = typeof record.text === 'string' ? record.text.trim() : ''
        // `Number(null)` 是 0，而 0 会被当成"合法的群号"——真实群号不可能是 0。
        // 缺失/为空的 groupId 直接跳过（2026-10-19 排查）。
        const rawGroup = record.groupId
        if (typeof rawGroup !== 'number' && typeof rawGroup !== 'string') continue
        if (typeof rawGroup === 'string' && rawGroup.trim() === '') continue
        const groupId = Number(rawGroup)
        if (text === '' || !Number.isFinite(groupId) || groupId <= 0) continue
        const count = Number(record.count)
        const first = Number(record.first)
        const last = Number(record.last)
        const phrase: LearnedPhrase = {
          text,
          count: Number.isFinite(count) ? Math.max(1, Math.round(count)) : 1,
          speakers: Array.isArray(record.speakers) ? record.speakers.map(Number).filter((id) => Number.isFinite(id)) : [],
          first: Number.isFinite(first) ? first : Date.now(),
          last: Number.isFinite(last) ? last : Date.now(),
          groupId,
          note: typeof record.note === 'string' ? record.note : '',
          ...(record.kind === 'slang' ? { kind: 'slang' as const } : {}),
          ...(typeof record.meaning === 'string' && record.meaning !== '' ? { meaning: record.meaning } : {}),
        }
        const key = keyOf(phrase.groupId, phrase.text)
        this.entries.set(key, phrase)
        this.persistedKeys.add(key)
      }
      this.log(parsed === null
        ? 'learn: 没有可读的短语库，从零开始'
        : `learn: 载入 ${this.entries.size} 条口癖候选（${this.file}）`)
    } catch (error) {
      this.loadFailed = true
      this.log(`learn: 短语库读取失败（本次运行不会写盘，避免覆盖原文件）：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 写盘：只写"够格的"（已落盘过 或 count >= 2），按 count 从高到低截断。 */
  async save(): Promise<void> {
    if (!this.dirty) return
    // 读盘失败过就别写：内存是空的，写出去等于把原文件抹成 []。
    if (this.loadFailed) return
    const keep = [...this.entries.entries()]
      .filter(([key, phrase]) => this.persistedKeys.has(key) || phrase.count >= 2)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, MAX_PERSISTED)
    this.persistedKeys = new Set(keep.map(([key]) => key))
    try {
      await this.store.save({ version: 1, phrases: keep.map(([, phrase]) => phrase) })
      this.dirty = false
    } catch (error) {
      this.log(`learn: 短语库写盘失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * 记一条群消息的候选短语。纯内存，不落盘——这是每条消息都要走的路径。
   * 配置里关掉学习或关掉被动采集时直接返回。
   */
  observe(input: { text: string; userId: number; groupId: number }): void {
    if (!this.config.enabled || !this.config.autoCapture) return
    const candidates = extractCandidates(input.text)
    if (candidates.length === 0) return
    const now = Date.now()
    const snippet = input.text.trim().slice(0, 40)
    for (const candidate of candidates) {
      const key = keyOf(input.groupId, candidate)
      const existing = this.entries.get(key)
      if (existing !== undefined) {
        existing.count += 1
        existing.last = now
        existing.note = snippet
        if (!existing.speakers.includes(input.userId)) {
          existing.speakers.push(input.userId)
          // 一个群几百号人，speakers 只留最近 20 个，够判断"是口癖还是个人口头禅"。
          if (existing.speakers.length > 20) existing.speakers = existing.speakers.slice(-20)
        }
      } else {
        this.entries.set(key, {
          text: candidate,
          count: 1,
          speakers: [input.userId],
          first: now,
          last: now,
          groupId: input.groupId,
          note: snippet,
        })
      }
      this.dirty = true
    }
    this.prune()
  }

  /** 把内存里的候选合并落盘（主控定期调；count < 2 的一次性噪音不写）。 */
  async flush(): Promise<void> {
    if (!this.dirty) return
    let promoted = 0
    for (const [key, phrase] of this.entries) {
      if (!this.persistedKeys.has(key) && phrase.count >= 2) promoted += 1
    }
    await this.save()
    if (promoted > 0) this.log(`learn: 落盘 ${promoted} 条新口癖候选`)
  }

  /**
   * 手动记住一句（模型判断某个梗值得学）。手动动作低频，直接落盘不等 flush；
   * count 直接抬到 `minOccurrences`，否则刚学会的短语在 top() 里排不上，等于没学。
   */
  /** 记一条黑话词条（带释义）。与口癖分开存、分开查。 */
  async rememberWord(text: string, meaning: string, groupId: number, note = '模型记下的黑话'): Promise<LearnedPhrase> {
    const word = stripEdges(text).slice(0, 20)
    if (word.length < TAIL_MIN) throw new Error('词条太短或全是标点；写群里实际用的那个词。')
    const gloss = meaning.trim().slice(0, 200)
    if (gloss === '') throw new Error('黑话要带一句释义，写清它在群里是什么意思。')
    const now = Date.now()
    const key = keyOf(groupId, word)
    const floor = Math.max(1, Math.round(this.config.minOccurrences))
    const existing = this.entries.get(key)
    let phrase: LearnedPhrase
    if (existing !== undefined) {
      existing.count = Math.max(existing.count + 1, floor)
      existing.last = now
      existing.note = note
      existing.kind = 'slang'
      existing.meaning = gloss
      phrase = existing
    } else {
      phrase = { text: word, count: floor, speakers: [], first: now, last: now, groupId, note, kind: 'slang', meaning: gloss }
      this.entries.set(key, phrase)
    }
    this.dirty = true
    this.prune()
    await this.save()
    return { ...phrase, speakers: [...phrase.speakers] }
  }

  /** 黑话词条（按出现次数降序）。 */
  slang(limit = 50, groupId?: number): LearnedPhrase[] {
    return [...this.entries.values()]
      .filter((phrase) => phrase.kind === 'slang')
      .filter((phrase) => groupId === undefined || phrase.groupId === groupId)
      .sort((a, b) => b.count - a.count)
      .slice(0, limit)
      .map((phrase) => ({ ...phrase, speakers: [...phrase.speakers] }))
  }

  async remember(text: string, groupId: number, note = '模型手动记下的'): Promise<LearnedPhrase> {
    const candidate = stripEdges(normalizePhraseSource(text)).slice(0, WHOLE_MESSAGE_MAX)
    if (candidate.length < TAIL_MIN) throw new Error('这句太短或者全是表情/标点，学不了——换成群里真实说过的那句短话。')
    const now = Date.now()
    const key = keyOf(groupId, candidate)
    const floor = Math.max(1, Math.round(this.config.minOccurrences))
    const existing = this.entries.get(key)
    let phrase: LearnedPhrase
    if (existing !== undefined) {
      existing.count = Math.max(existing.count + 1, floor)
      existing.last = now
      existing.note = note
      phrase = existing
    } else {
      phrase = { text: candidate, count: floor, speakers: [], first: now, last: now, groupId, note }
      this.entries.set(key, phrase)
    }
    this.dirty = true
    this.prune()
    await this.save()
    return { ...phrase, speakers: [...phrase.speakers] }
  }

  /** 忘掉某个短语（所有群一起忘）。返回是否真的删掉了。 */
  async forget(text: string): Promise<boolean> {
    const target = text.trim()
    if (target === '') return false
    let removed = 0
    for (const key of [...this.entries.keys()]) {
      const phrase = this.entries.get(key)
      if (phrase !== undefined && phrase.text === target) {
        this.entries.delete(key)
        this.persistedKeys.delete(key)
        removed += 1
      }
    }
    if (removed === 0) return false
    this.dirty = true
    await this.save()
    return true
  }

  /** 高频口癖优先（count >= minOccurrences 的排在前面），同档按 count、最近一次排序。 */
  top(limit = 20, groupId?: number): LearnedPhrase[] {
    const floor = Math.max(1, Math.round(this.config.minOccurrences))
    return [...this.entries.values()]
      .filter((phrase) => (phrase.kind ?? 'phrase') === 'phrase')
      .filter((phrase) => groupId === undefined || phrase.groupId === groupId)
      .sort((a, b) => {
        const aQualified = a.count >= floor ? 1 : 0
        const bQualified = b.count >= floor ? 1 : 0
        if (aQualified !== bQualified) return bQualified - aQualified
        if (b.count !== a.count) return b.count - a.count
        return b.last - a.last
      })
      .slice(0, Math.max(0, limit))
      // 返回浅拷贝：调用方（工具/主控）不该拿到内部对象去改。
      .map((phrase) => ({ ...phrase, speakers: [...phrase.speakers] }))
  }

  stats(): { tracked: number; persisted: number } {
    return { tracked: this.entries.size, persisted: this.persistedKeys.size }
  }

  /** 超过上限时丢 count 最低、最久没出现的（落盘那份也会在下一次 save 时同步缩）。 */
  private prune(): void {
    if (this.entries.size <= MAX_TRACKED) return
    const overflow = this.entries.size - MAX_TRACKED
    const ordered = [...this.entries.entries()]
      .sort((a, b) => (a[1].count - b[1].count) || (a[1].last - b[1].last))
    for (const [key] of ordered.slice(0, overflow)) {
      this.entries.delete(key)
      this.persistedKeys.delete(key)
    }
  }
}
