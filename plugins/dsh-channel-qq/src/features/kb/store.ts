/** 知识库存储：`kb/documents.jsonl` + `kb/chunks.jsonl`（追加式、后写胜出、定期压缩）。
 *
 * 为什么与记忆分开存：知识库块是**用户给的原文**，不参与记忆的衰减、反思与审核；
 * 混进 `records.jsonl` 会让"个人记忆"里塞满八百字的说明书。两份 JSONL 都在工作区
 * `kb/` 下，现有的工作区备份直接覆盖。
 *
 * 与 `MemoryStore` 同一条持久化约定：改动 = 追加一行新版本，读的时候后写胜出；
 * 累计到阈值再整体原子重写（压缩）。归档是软删除（`archived: true`），历史可查。
 *
 * 检索不建倒排索引：块文本本来就长（600–1200 字），中文二元组的桶会膨胀到
 * 每块上千个；直接按 `includes` 扫全库在几千块的量级上只要几十毫秒，内存却省下
 * 一个数量级。超过五万块再考虑索引。
 */

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { atomicWriteFile, readTextFileOrNull } from '../../adapters/fs-store/atomic.js'
import type { KbChunk, KbCollection, KbDocStatus, KbDocument } from '../../core/kb/model.js'

/** 追加多少行之后压缩一次（文档与块分开计）。 */
const COMPACT_DOCS = 100
const COMPACT_CHUNKS = 500
const MAX_PARSE_WARNINGS = 5

export interface KbStoreOptions {
  /** 工作区根（`kb/` 建在它下面）。 */
  readonly root: string
  readonly log: (line: string) => void
}

/** 文档 id：由相对路径决定，文件内容变化不换 id（后台的删除/归档因此稳定）。
 *
 * 用 sha256 而不是 djb2：几万份文档时 32 位哈希的生日碰撞概率不可忽略，而 id
 * 撞了会让一份文档**静默覆盖**另一份。
 */
export function docIdOf(relPath: string): string {
  return `d-${createHash('sha256').update(relPath).digest('hex').slice(0, 16)}`
}

/** 块 id：文档 id + 段序号。 */
export function chunkIdOf(docId: string, seq: number): string {
  return `${docId}:${seq}`
}

export class KbStore {
  readonly dir: string
  readonly docsFile: string
  readonly chunksFile: string

  private readonly docs = new Map<string, KbDocument>()
  private readonly chunks = new Map<string, KbChunk>()
  /** 文档 id → 块 id 集合（后台列表/预览按文档取块，不能每次扫全表）。 */
  private readonly byDoc = new Map<string, Set<string>>()
  /** 相对路径 → 文档 id（摄取时每个文件都要查；扫全表会变成 O(n²)）。 */
  private readonly byPath = new Map<string, string>()
  /** 活跃块缓存（每次写操作后置空）。 */
  private activeCache: KbChunk[] | null = null
  private pendingDocs = 0
  private pendingChunks = 0

  constructor(private readonly opts: KbStoreOptions) {
    this.dir = path.join(opts.root, 'kb')
    this.docsFile = path.join(this.dir, 'documents.jsonl')
    this.chunksFile = path.join(this.dir, 'chunks.jsonl')
  }

  /** 读全库。坏行跳过并记日志——一条烂记录不该让整个知识库打不开。 */
  async load(): Promise<{ docs: number; chunks: number }> {
    this.docs.clear()
    this.chunks.clear()
    this.byDoc.clear()
    this.byPath.clear()
    this.activeCache = null
    const badDocs = await this.loadDocs()
    const badChunks = await this.loadChunks()
    if (badDocs > 0) this.opts.log(`kb: documents.jsonl 有 ${badDocs} 行读不懂，已跳过`)
    if (badChunks > 0) this.opts.log(`kb: chunks.jsonl 有 ${badChunks} 行读不懂，已跳过`)
    return { docs: this.docs.size, chunks: this.chunks.size }
  }

  private async loadDocs(): Promise<number> {
    const raw = await readTextFileOrNull(this.docsFile)
    if (raw === null) return 0
    let bad = 0
    for (const line of raw.split('\n')) {
      const text = line.trim()
      if (text === '') continue
      try {
        const doc = JSON.parse(text) as KbDocument
        if (typeof doc?.id !== 'string' || typeof doc.path !== 'string') throw new Error('缺少 id/path')
        this.docs.set(doc.id, doc)
        this.byPath.set(doc.path, doc.id)
      } catch {
        bad += 1
        if (bad <= MAX_PARSE_WARNINGS) this.opts.log(`kb: 跳过一条读不懂的文档记录：${text.slice(0, 80)}`)
      }
    }
    return bad
  }

  private async loadChunks(): Promise<number> {
    const raw = await readTextFileOrNull(this.chunksFile)
    if (raw === null) return 0
    let bad = 0
    for (const line of raw.split('\n')) {
      const text = line.trim()
      if (text === '') continue
      try {
        const chunk = JSON.parse(text) as KbChunk
        if (typeof chunk?.id !== 'string' || typeof chunk.docId !== 'string') throw new Error('缺少 id/docId')
        this.chunks.set(chunk.id, chunk)
        this.indexChunk(chunk.id, chunk.docId)
      } catch {
        bad += 1
        if (bad <= MAX_PARSE_WARNINGS) this.opts.log(`kb: 跳过一条读不懂的块记录：${text.slice(0, 80)}`)
      }
    }
    return bad
  }

  documents(): KbDocument[] {
    return [...this.docs.values()]
  }

  getDoc(id: string): KbDocument | undefined {
    return this.docs.get(id)
  }

  docByPath(relPath: string): KbDocument | undefined {
    const id = this.byPath.get(relPath)
    return id === undefined ? undefined : this.docs.get(id)
  }

  /** 活跃块（软删除的不在内）。 */
  activeChunks(): readonly KbChunk[] {
    if (this.activeCache === null) {
      this.activeCache = [...this.chunks.values()].filter((chunk) => !chunk.archived)
    }
    return this.activeCache
  }

  chunksOf(docId: string): KbChunk[] {
    const ids = this.byDoc.get(docId)
    if (ids === undefined) return []
    const out: KbChunk[] = []
    for (const id of ids) {
      const chunk = this.chunks.get(id)
      if (chunk !== undefined) out.push(chunk)
    }
    return out.sort((a, b) => a.seq - b.seq)
  }

  private indexChunk(id: string, docId: string): void {
    const bucket = this.byDoc.get(docId)
    if (bucket === undefined) this.byDoc.set(docId, new Set([id]))
    else bucket.add(id)
  }

  /** 写入（新增或更新）一份文档。 */
  async putDocument(doc: KbDocument): Promise<void> {
    await withAppend(this.docsFile, [doc])
    const previous = this.docs.get(doc.id)
    if (previous !== undefined && previous.path !== doc.path) this.byPath.delete(previous.path)
    this.docs.set(doc.id, doc)
    this.byPath.set(doc.path, doc.id)
    this.pendingDocs += 1
    if (this.pendingDocs >= COMPACT_DOCS) await this.compactDocs()
  }

  /** 写入若干块（同 id 覆盖，旧版本在文件里留痕）。 */
  async putChunks(chunks: readonly KbChunk[]): Promise<void> {
    if (chunks.length === 0) return
    await withAppend(this.chunksFile, chunks)
    for (const chunk of chunks) {
      this.chunks.set(chunk.id, chunk)
      this.indexChunk(chunk.id, chunk.docId)
    }
    this.activeCache = null
    this.pendingChunks += chunks.length
    if (this.pendingChunks >= COMPACT_CHUNKS) await this.compactChunks()
  }

  /** 归档一份文档的全部块（文档被删/被替换/解析失败时）。 */
  async archiveChunks(docId: string): Promise<number> {
    const live = this.chunksOf(docId).filter((chunk) => !chunk.archived)
    if (live.length === 0) return 0
    const archived = live.map((chunk): KbChunk => ({ ...chunk, archived: true }))
    await this.putChunks(archived)
    return archived.length
  }

  /** 软删除：文档标记 deleted，块归档。 */
  async removeDocument(id: string, now: number): Promise<boolean> {
    const doc = this.docs.get(id)
    if (doc === undefined) return false
    await this.putDocument({ ...doc, status: 'deleted', updatedAt: now })
    await this.archiveChunks(id)
    return true
  }

  /** 恢复：文档回到 active，块取消归档（下一次扫描会按文件重新校验）。 */
  async restoreDocument(id: string, now: number): Promise<boolean> {
    const doc = this.docs.get(id)
    if (doc === undefined) return false
    await this.putDocument({ ...doc, status: 'active', updatedAt: now })
    const archived = this.chunksOf(id).filter((chunk) => chunk.archived)
    if (archived.length > 0) await this.putChunks(archived.map((chunk) => ({ ...chunk, archived: false })))
    return true
  }

  /** 集合汇总（只算 active 文档）。 */
  collections(): KbCollection[] {
    const byName = new Map<string, { docs: number; chunks: number }>()
    for (const doc of this.docs.values()) {
      if (doc.status !== 'active') continue
      const bucket = byName.get(doc.collection) ?? { docs: 0, chunks: 0 }
      bucket.docs += 1
      bucket.chunks += this.chunksOf(doc.id).filter((chunk) => !chunk.archived).length
      byName.set(doc.collection, bucket)
    }
    return [...byName.entries()]
      .map(([name, value]) => ({ name, docCount: value.docs, chunkCount: value.chunks }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  stats(): { docs: number; activeDocs: number; chunks: number; activeChunks: number; bytes: number; collections: number } {
    let activeDocs = 0
    let bytes = 0
    for (const doc of this.docs.values()) {
      if (doc.status !== 'active') continue
      activeDocs += 1
      bytes += doc.bytes
    }
    return {
      docs: this.docs.size,
      activeDocs,
      chunks: this.chunks.size,
      activeChunks: this.activeChunks().length,
      bytes,
      collections: this.collections().length,
    }
  }

  /** 全量压缩（后台「整理」按钮/启动收尾都可以调）。 */
  async compact(): Promise<void> {
    await this.compactDocs()
    await this.compactChunks()
  }

  private async compactDocs(): Promise<void> {
    const body = this.documents().map((doc) => JSON.stringify(doc)).join('\n')
    await atomicWriteFile(this.docsFile, body === '' ? '' : `${body}\n`)
    this.pendingDocs = 0
  }

  private async compactChunks(): Promise<void> {
    const body = [...this.chunks.values()].map((chunk) => JSON.stringify(chunk)).join('\n')
    await atomicWriteFile(this.chunksFile, body === '' ? '' : `${body}\n`)
    this.pendingChunks = 0
  }
}

/** 追加若干 JSON 行。 */
async function withAppend(file: string, rows: readonly unknown[]): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.appendFile(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')
}

/** 文档状态的一句话说明（后台表格用）。 */
export function statusLabel(status: KbDocStatus): string {
  return status === 'active' ? '已索引' : status === 'deleted' ? '已删除' : '解析失败'
}
