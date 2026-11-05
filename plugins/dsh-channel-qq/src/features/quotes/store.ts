/** 群语录库：把群里说过的金句存下来，按关键词精准投放回去。
 *
 * 群梗和"活人感"的来源 —— 但语录库最容易坏在两个地方：
 * 1) 同一条语录被反复存进来（模型忘性大），所以 add() 严格按 text 去重，
 *    命中已存在的条目只加 hits，不新插一条；
 * 2) 老语录被新语录盖过去，于是 search() 里 hits 与时间都参与打分，
 *    random() 则用 hits 反比加权 —— 冷门语录也得有机会出场，否则群里
 *    永远只有那三句最热的梗。
 *
 * 存储：<dir>/quotes.json（dir 见 QuoteStore 构造函数的解析规则），
 * 读写容错照 sent-log 的范式：读失败 → 空库并重建文件，绝不抛。
 */

import * as path from 'node:path'
import type { QuoteConfig } from '../../config.js'
import { shortId } from '../../adapters/dsh-host/tools.js'
import { JsonStore } from '../../adapters/fs-store/json-store.js'

export interface QuoteEntry {
  id: string
  text: string
  speaker: string
  speakerId: number
  groupId: number
  time: number
  tags: string[]
  note: string
  hits: number
}

/** 语录文本长度闸门：太短不构成"梗"，太长发回群里是刷屏。 */
const MIN_TEXT_LEN = 4
const MAX_TEXT_LEN = 300
/** 上限：语录是长期资产，但也不能无限涨（每条 ≈ 几百字节）。 */
const MAX_QUOTES = 2000

/** 存取用的序列化源数据（旧版本可能直接是数组，这里两种都吃）。 */
function extractQuotes(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw
  if (raw !== null && typeof raw === 'object') {
    const list = (raw as { quotes?: unknown }).quotes
    if (Array.isArray(list)) return list
  }
  return []
}

/** 逐字段洗数据：磁盘上可能是手改过的、旧版本的、半截写入的 JSON。 */
function normalizeQuote(value: unknown, index: number): QuoteEntry | null {
  if (value === null || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const text = typeof raw.text === 'string' ? raw.text.trim() : ''
  if (text === '') return null
  const tags = Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === 'string') : []
  const speakerId = Number(raw.speakerId ?? 0)
  const groupId = Number(raw.groupId ?? 0)
  const time = Number(raw.time ?? 0)
  const hits = Number(raw.hits ?? 0)
  return {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : `q_recovered_${String(index)}`,
    text,
    speaker: typeof raw.speaker === 'string' ? raw.speaker : '',
    speakerId: Number.isFinite(speakerId) ? speakerId : 0,
    groupId: Number.isFinite(groupId) ? groupId : 0,
    time: Number.isFinite(time) ? time : Date.now(),
    tags,
    note: typeof raw.note === 'string' ? raw.note : '',
    hits: Number.isFinite(hits) ? hits : 0,
  }
}

/** 中文语料的"词"切分：连续汉字算一个整体，所以"退网"能命中"我要退网了"。 */
function tokenize(query: string): string[] {
  return query
    .split(/[^\p{L}\p{N}]+/u)
    .map((t) => t.trim())
    // 单个汉字是有意义的检索词（"网"要能搜到"退网"），单字母/单数字不是。
    .filter((t) => t.length >= 2 || /^\p{Script=Han}$/u.test(t))
}

/**
 * 超出上限时"最该丢"的条目下标。
 *
 * 丢最旧且最冷的：先按 hits 升序，再按 time 升序 —— 一条刚存进来还没被
 * 用过的冷门语录会先被牺牲，而"复读过很多次的老梗"反而留得住，因为它的
 * hits 高。这正是语录库想要的取舍：容量换给真正有生命力的梗。
 */
function pickEvictionIndex(quotes: QuoteEntry[]): number {
  let worst = 0
  for (let i = 1; i < quotes.length; i++) {
    const a = quotes[i]!
    const b = quotes[worst]!
    if (a.hits < b.hits || (a.hits === b.hits && a.time < b.time)) worst = i
  }
  return worst
}

export class QuoteStore {
  private readonly file: string
  private readonly store: JsonStore<unknown>
  private readonly log: (line: string) => void
  private quotes: QuoteEntry[] = []

  constructor(config: QuoteConfig, opts: { workspacePath: string | null; dshHome: string; log: (l: string) => void }) {
    this.log = opts.log
    const base = opts.workspacePath ?? path.join(opts.dshHome, 'channel-qq')
    const dir = config.dir ?? path.join(base, 'quotes')
    this.file = path.join(dir, 'quotes.json')
    this.store = new JsonStore<unknown>(this.file, { log: opts.log })
  }

  async load(): Promise<void> {
    const raw = await this.store.load(null)
    if (raw === null) {
      // 文件不存在/读不出来：空库起步，并把文件补出来，下次启动就不算"缺文件"。
      this.quotes = []
      try {
        await this.store.save({ version: 1, quotes: [] })
      } catch (error) {
        this.log(`quotes: rebuild failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    } else {
      this.quotes = extractQuotes(raw)
        .map((item, index) => normalizeQuote(item, index))
        .filter((item): item is QuoteEntry => item !== null)
    }
    this.log(`quotes: loaded ${String(this.quotes.length)} entr(ies)`)
  }

  /**
   * 落盘；**失败抛错**。
   *
   * 工具路径必须用它：旧实现把异常吞掉、只记一行日志，于是「存语录」在磁盘满/
   * 权限错时会回 `ok:true` + 完整条目——用户以为存上了，其实没有（2026-10-19 排查）。
   */
  private async persist(): Promise<void> {
    await this.store.save({ version: 1, quotes: this.quotes })
  }

  /** 尽力而为的落盘（自动收录、热度计数用）：失败只记日志，不影响主流程。 */
  async save(): Promise<void> {
    try {
      await this.persist()
    } catch (error) {
      this.log(`quotes save failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * 存一条语录。按 text 去重：同一条金句在群里被说好几次只该有一条记录，
   * 重复出现记成 hits —— 那恰恰说明它是真梗。
   */
  async add(input: {
    text: string
    speaker: string
    speakerId: number
    groupId: number
    tags?: string[]
    note?: string
  }): Promise<QuoteEntry> {
    const text = String(input.text ?? '').trim()
    if (text.length < MIN_TEXT_LEN) throw new Error(`语录太短了（至少 ${String(MIN_TEXT_LEN)} 个字），这种存下来也没梗。`)
    if (text.length > MAX_TEXT_LEN) throw new Error(`语录太长（最多 ${String(MAX_TEXT_LEN)} 个字），挑最精彩的那一句存。`)
    // 按 (text, groupId) 去重：同一句话在不同群出现不该合并成一条——否则
    // 「谁说的、在哪个群」会被第一次出现永久固定（2026-10-19 排查）。
    const existing = this.quotes.find((q) => q.text === text && q.groupId === Number(input.groupId ?? 0))
    if (existing !== undefined) {
      existing.hits += 1
      await this.persist()
      return existing
    }
    const entry: QuoteEntry = {
      id: shortId('q'),
      text,
      speaker: String(input.speaker ?? '').trim(),
      speakerId: Number(input.speakerId ?? 0),
      groupId: Number(input.groupId ?? 0),
      time: Date.now(),
      tags: Array.isArray(input.tags) ? input.tags.map((t) => String(t).trim()).filter((t) => t !== '') : [],
      note: String(input.note ?? '').trim(),
      hits: 0,
    }
    this.quotes.push(entry)
    while (this.quotes.length > MAX_QUOTES) this.quotes.splice(pickEvictionIndex(this.quotes), 1)
    await this.persist()
    return entry
  }

  /** 关键词命中 text(+3) / tags(+2) / speaker(+1)，再叠加 hits 与新鲜度排序。 */
  search(query: string, limit = 5): QuoteEntry[] {
    const tokens = tokenize(query)
    if (tokens.length === 0) return this.quotes.slice(0, Math.max(0, limit))
    const now = Date.now()
    const scored = this.quotes.map((q) => {
      let score = 0
      for (const token of tokens) {
        if (q.text.includes(token)) score += 3
        if (q.tags.some((tag) => tag.includes(token))) score += 2
        if (q.speaker.includes(token)) score += 1
      }
      if (score === 0) return { q, score: 0 }
      // hits 权重刻意压低：否则一条被复读过 50 次的老梗会压过任何精准关键词命中。
      score += Math.min(q.hits, 10) * 0.2
      const ageDays = (now - q.time) / 86_400_000
      score += Math.max(0, 1 - ageDays / 90) // 三个月内逐渐掉新鲜度
      return { q, score }
    })
    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(0, limit))
      .map((s) => s.q)
  }

  /** 随机出梗：按 hits 反比加权，杜绝"永远只有最热那三句"。 */
  random(tag?: string): QuoteEntry | null {
    const wanted = typeof tag === 'string' ? tag.trim() : ''
    const pool = wanted === ''
      ? this.quotes
      : this.quotes.filter((q) => q.tags.some((t) => t === wanted || t.includes(wanted)))
    if (pool.length === 0) return null
    const weights = pool.map((q) => 1 / (1 + q.hits))
    const total = weights.reduce((sum, w) => sum + w, 0)
    if (total <= 0) return pool[Math.floor(Math.random() * pool.length)] ?? null
    let roll = Math.random() * total
    for (let i = 0; i < pool.length; i++) {
      roll -= weights[i]!
      if (roll <= 0) return pool[i]!
    }
    return pool[pool.length - 1] ?? null
  }

  async remove(id: string): Promise<boolean> {
    const before = this.quotes.length
    this.quotes = this.quotes.filter((q) => q.id !== id)
    if (this.quotes.length === before) return false
    await this.persist()
    return true
  }

  /** 列表默认按时间倒序：刚存进来的梗最该被看见。 */
  list(limit = 100): QuoteEntry[] {
    return [...this.quotes].sort((a, b) => b.time - a.time).slice(0, Math.max(0, limit))
  }

  /** 投放/检索后记一次使用：hits 同时喂养 search 的权重与 random 的反比。 */
  async touch(id: string): Promise<void> {
    const entry = this.quotes.find((q) => q.id === id)
    if (entry === undefined) return
    entry.hits += 1
    await this.save()
  }

  stats(): { total: number; topTags: Array<[string, number]>; topSpeakers: Array<[string, number]> } {
    const tags = new Map<string, number>()
    const speakers = new Map<string, number>()
    for (const q of this.quotes) {
      for (const tag of q.tags) tags.set(tag, (tags.get(tag) ?? 0) + 1)
      if (q.speaker !== '') speakers.set(q.speaker, (speakers.get(q.speaker) ?? 0) + 1)
    }
    const rank = (map: Map<string, number>, top: number): Array<[string, number]> =>
      [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, top)
    return { total: this.quotes.length, topTags: rank(tags, 10), topSpeakers: rank(speakers, 10) }
  }
}
