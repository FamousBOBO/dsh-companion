/** 记忆记录的存储：`knowledge/records.jsonl`（09 §4.3）。
 *
 * 三个决定值得写下来：
 *
 *   1. **追加式（append-only）+ 定期压缩**。一条记忆的一生里会被改很多次（召回计数、
 *      强度、`supersededBy`），每次改动都把整份文件重写一遍既慢又危险（写一半断电
 *      就没有历史了）。所以：改动 = 往文件尾追一行新版本，**读的时候后写胜出**；
 *      追加累计到阈值再整体重写一次（压缩）。这正是 KB Lite / Generative Agents 那
 *      一类系统在文件方案上的通用做法。
 *   2. **不引入数据库**（09 §10 的取舍）：条目量级是数千到数万，JSONL + 内存倒排索引
 *      足够；`node:sqlite` 在 Node 22 还是实验特性，共享服务器上不值得为一个"可能
 *      会大"的担忧付运维代价。真要超过 20 万条再换——届时数据结构不用改。
 *   3. **旧文件照旧可读**（e1 的双写）：`entries.json` 是后台"长期记忆"页与
 *      `qq_recall_memory` 的数据源。新记录同时写一份老形状进 `KnowledgeStore`，
 *      这样换开关那天不会出现"记忆页空了"。
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { atomicWriteFile, readTextFileOrNull } from '../../adapters/fs-store/atomic.js'
import { withLock } from '../../adapters/fs-store/mutex.js'
import { bigrams } from '../../core/memory/score.js'
import { makeRecord, type MemoryRecord, type NewRecordInput } from '../../core/memory/model.js'

/** 追加多少行之后压缩一次。太小会频繁重写，太大则文件里攒满历史版本。 */
const COMPACT_EVERY = 200

/** 一行 JSONL 解析失败时的上限日志（避免坏文件刷屏）。 */
const MAX_PARSE_WARNINGS = 5

export interface MemoryStoreOptions {
  readonly workspacePath: string | null
  readonly dshHome: string
  readonly log: (line: string) => void
}

export class MemoryStore {
  /** `knowledge/records.jsonl`，与老 `entries.json` 同目录。 */
  readonly dir: string
  readonly file: string

  private readonly byId = new Map<string, MemoryRecord>()
  /** 倒排索引：检索词 → 记录 id。候选生成靠它，不靠全表扫描。 */
  private readonly inverted = new Map<string, Set<string>>()
  private pendingAppends = 0
  /** 上次读/写时文件的 mtime，用于惰性重载检测。 */
  private loadedMtimeMs = 0

  constructor(private readonly opts: MemoryStoreOptions) {
    this.dir = path.join(opts.workspacePath ?? path.join(opts.dshHome, 'channel-qq'), 'knowledge')
    this.file = path.join(this.dir, 'records.jsonl')
  }

  /** 读全库并重建索引。坏行跳过并记一行日志——一条烂记录不该让整个记忆库打不开。 */
  async load(): Promise<number> {
    this.byId.clear()
    this.inverted.clear()
    this.pendingAppends = 0
    const raw = await readTextFileOrNull(this.file)
    if (raw === null) return 0
    let bad = 0
    for (const line of raw.split('\n')) {
      const text = line.trim()
      if (text === '') continue
      try {
        const parsed = JSON.parse(text) as MemoryRecord
        if (typeof parsed?.id !== 'string') throw new Error('缺少 id')
        // 后写胜出：同一 id 的后续行覆盖前面的（追加式存储的核心约定）。
        this.byId.set(parsed.id, parsed)
      } catch {
        bad += 1
        if (bad <= MAX_PARSE_WARNINGS) {
          this.opts.log(`memory: 跳过一条读不懂的记录（第 ${this.byId.size + bad} 行附近）：${text.slice(0, 80)}`)
        }
      }
    }
    this.rebuildIndex()
    await this.stampMtime()
    return this.byId.size
  }

  /** 记下当前文件 mtime，作为「我读到的是这一版」的凭据。 */
  private async stampMtime(): Promise<void> {
    try { this.loadedMtimeMs = (await fs.stat(this.file)).mtimeMs } catch { this.loadedMtimeMs = 0 }
  }

  /**
   * 库文件被别的进程改过就重读，让外部写入（夜间蒸馏、迁移脚本）当轮可见。
   *
   * 必须与 `put()/compact()` 用同一把锁：否则可能在 append 的半途重读，
   * 把刚写进内存的那几条丢掉。拿锁后再看一次 mtime，避免等锁期间白读。
   */
  async refreshIfChanged(): Promise<boolean> {
    let mtime = 0
    try { mtime = (await fs.stat(this.file)).mtimeMs } catch { return false }
    if (mtime === 0 || mtime === this.loadedMtimeMs) return false
    return await withLock(this.file, async () => {
      let latest = 0
      try { latest = (await fs.stat(this.file)).mtimeMs } catch { return false }
      if (latest === 0 || latest === this.loadedMtimeMs) return false
      const before = this.byId.size
      await this.load()
      this.opts.log(`memory: 库文件已被外部更新，重载 ${before} → ${this.byId.size} 条`)
      return true
    })
  }

  private rebuildIndex(): void {
    this.inverted.clear()
    for (const record of this.byId.values()) this.indexOne(record)
  }

  private indexOne(record: MemoryRecord): void {
    for (const term of indexTerms(record)) {
      const bucket = this.inverted.get(term)
      if (bucket === undefined) this.inverted.set(term, new Set([record.id]))
      else bucket.add(record.id)
    }
  }

  private unindexOne(record: MemoryRecord): void {
    for (const term of indexTerms(record)) this.inverted.get(term)?.delete(record.id)
  }

  all(): MemoryRecord[] {
    return [...this.byId.values()]
  }

  get(id: string): MemoryRecord | undefined {
    return this.byId.get(id)
  }

  size(): number {
    return this.byId.size
  }

  /**
   * 关键词候选：命中任意检索词的记录。**只做召回，不做排序**——排序是
   * `core/memory/score.ts` 的事，两者分开才能各自单独测。
   */
  candidatesByTerms(terms: readonly string[]): MemoryRecord[] {
    const ids = new Set<string>()
    for (const term of terms) {
      for (const id of this.inverted.get(term) ?? []) ids.add(id)
    }
    const out: MemoryRecord[] = []
    for (const id of ids) {
      const record = this.byId.get(id)
      if (record !== undefined) out.push(record)
    }
    return out
  }

  /**
   * 某个检索词的信息量权重（P6e·e4 的 IDF）。
   *
   * `log(1 + N/(1+df))`，下限 0.5。**不设上限**：3146 条语料上实测，若把上限压在 3，
   * 所有查询词的权重会一起撞顶（df ≤ 156 的词全都算 3.0）——IDF 就白加了。
   * 罕见词的高权重不会失控：`keepKnown` 已经把"库里根本没有的词"挡在查询之外，
   * 能进来的词至少命中过一条记录。
   *
   * 数据就取自倒排索引（term → 记录 id 集合），不额外维护统计。
   */
  idfOf(term: string): number {
    const df = this.inverted.get(term.toLowerCase())?.size ?? 0
    const total = Math.max(1, this.byId.size)
    return Math.max(0.5, Math.log(1 + total / (df + 1)))
  }

  /**
   * 去掉**库里一次都没出现过**的检索词（df = 0）。
   *
   * 中文二元组大多跨词边界（"学弟为什么" → 弟为 / 为什 / 么不），它们在语料里
   * 通常不出现。留着它们不会命中任何记录，却会把相关性的分母撑大——于是"命中
   * 一个真关键词"的记录与"一个都没命中"的记录分数被压到同一个量级（P6e·e4 实测）。
   * 删掉它们不改变**能**命中的记录集合，只是不再让不可能的匹配稀释分数。
   *
   * 全被删光时退回原样：宁可带着噪声查，也不要变成空查询。
   */
  keepKnown(terms: readonly string[]): string[] {
    const kept = terms.filter((t) => (this.inverted.get(t.toLowerCase())?.size ?? 0) > 0)
    return kept.length > 0 ? kept : [...terms]
  }

  /** 建档并落盘。 */
  async remember(input: NewRecordInput, now: number, roll: () => number): Promise<MemoryRecord> {
    const record = makeRecord(input, now, roll)
    // id 撞了就换一个：`makeRecord` 的随机后缀来自注入的随机源，而随机源坏掉
    // （常量、被测试替身固定、将来换成有偏差的实现）时**后来的记录会静默顶掉前一条**
    // ——那是记忆系统里最不该发生的失败。宁可多花一次查找。
    const unique = this.disambiguate(record.id)
    const final = unique === record.id ? record : { ...record, id: unique }
    await this.put(final)
    return final
  }

  /** 在已被占用的 id 后面加 `-N`，直到不冲突（确定性、必然终止）。 */
  private disambiguate(id: string): string {
    if (!this.byId.has(id)) return id
    for (let i = 1; i < 1000; i++) {
      const candidate = `${id}-${i}`
      if (!this.byId.has(candidate)) return candidate
    }
    return `${id}-${this.byId.size}`
  }

  /** 写入（新增或更新）若干条记录。 */
  async put(...records: MemoryRecord[]): Promise<void> {
    if (records.length === 0) return
    await withLock(this.file, async () => {
      await fs.mkdir(this.dir, { recursive: true })
      const lines = records.map((r) => JSON.stringify(r)).join('\n') + '\n'
      await fs.appendFile(this.file, lines, 'utf8')
      for (const record of records) {
        const previous = this.byId.get(record.id)
        if (previous !== undefined) this.unindexOne(previous)
        this.byId.set(record.id, record)
        this.indexOne(record)
      }
      this.pendingAppends += records.length
    })
    await this.stampMtime()
    if (this.pendingAppends >= COMPACT_EVERY) await this.compact()
  }

  /**
   * 压缩：把内存里的当前状态整体重写成文件（原子替换）。
   *
   * 顺带把 `archived` 的记录留在文件里（不删）——归档是"不再检索"，不是"忘掉"。
   * 真正移走归档文件是 e3 的事。
   */
  async compact(): Promise<{ kept: number }> {
    await withLock(this.file, async () => {
      await fs.mkdir(this.dir, { recursive: true })
      const body = this.all().map((r) => JSON.stringify(r)).join('\n')
      await atomicWriteFile(this.file, body === '' ? '' : body + '\n')
      this.pendingAppends = 0
    })
    await this.stampMtime()
    return { kept: this.byId.size }
  }
}

/**
 * 一条记录进倒排索引的检索词：关键词、标签、正文二元组。
 *
 * 正文也进索引是有意的：模型给的关键词不总是够用（"不吃香菜"可能只被标了
 * `饮食`），而二元组索引的代价很小（一条 200 字的记录 ≈ 200 个桶）。
 */
export function indexTerms(record: MemoryRecord): string[] {
  const terms = new Set<string>()
  for (const k of record.keywords) terms.add(k.toLowerCase())
  for (const t of record.tags) terms.add(t.toLowerCase())
  for (const term of bigrams(record.content.toLowerCase())) terms.add(term)
  return [...terms]
}
