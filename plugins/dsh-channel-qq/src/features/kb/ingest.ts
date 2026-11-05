/** 摄取：扫描来源目录 → 哈希判变 → 解析 → 分块 → 归档旧块 → 写新块。
 *
 * 四条约定：
 *   1. **串行**：一次只处理一个文件。扫描是定时任务，和聊天共用 CPU/磁盘，
 *      并发解析只会让两边都变慢；
 *   2. **哈希增量**：路径 + 内容哈希都没变就跳过；解析失败的同一份文件也不反复
 *      重试（手动「重新扫描」会带 `force`）；
 *   3. **先归档后写入**：文件变短时，多出来的旧块必须归档，否则检索会命中已经
 *      不存在的内容；
 *   4. **单文件失败不中断整轮**：错误写进文档表（`status: error` + 原因），
 *      后台能看到是哪份文件、为什么。
 */

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { chunkText, collectionOf, stableHash, titleOf } from '../../core/kb/chunk.js'
import type { KbChunk, KbDocument } from '../../core/kb/model.js'
import type { KbIngestStatus } from '../../ports/kb.js'
import { parseBytes } from './parse.js'
import { listSources, parseDirs, withinDirs, type SourceFile } from './sources.js'
import { chunkIdOf, docIdOf, type KbStore } from './store.js'

/** 单文档最多切多少块（防止一份巨型手册把内存与检索都拖垮）。 */
const MAX_CHUNKS_PER_DOC = 2000

export interface IngestDeps {
  readonly store: KbStore
  readonly workspace: string
  readonly dirs: string
  readonly maxBytes: number
  readonly doclingUrl: string
  readonly log: (line: string) => void
}

export type IngestProgress = KbIngestStatus

type Outcome = 'added' | 'updated' | 'skipped' | 'failed'

function idle(): IngestProgress {
  return {
    running: false, total: 0, done: 0, current: '', added: 0, updated: 0, skipped: 0,
    failed: 0, removed: 0, startedAt: 0, finishedAt: 0, note: '',
  }
}

export class KbIngestor {
  private state: IngestProgress = idle()
  private inflight: Promise<IngestProgress> | null = null

  constructor(private readonly deps: IngestDeps) {}

  status(): IngestProgress {
    return this.state
  }

  /** 跑一轮；已经在跑时直接返回同一轮的 promise（不排队堆积）。 */
  run(force = false): Promise<IngestProgress> {
    if (this.inflight !== null) return this.inflight
    this.inflight = this.execute(force).finally(() => { this.inflight = null })
    return this.inflight
  }

  private async execute(force: boolean): Promise<IngestProgress> {
    const startedAt = Date.now()
    const files = await listSources({
      workspace: this.deps.workspace,
      dirs: this.deps.dirs,
      binary: this.deps.doclingUrl.trim() !== '',
      log: this.deps.log,
    })
    this.state = { ...idle(), running: true, total: files.length, startedAt }
    const counts = { added: 0, updated: 0, skipped: 0, failed: 0 }
    for (let i = 0; i < files.length; i += 1) {
      const file = files[i]!
      this.state = { ...this.state, current: file.rel, done: i }
      const outcome = await this.ingestOne(file, force)
      counts[outcome] += 1
    }
    const removed = await this.dropMissing(files)
    this.state = {
      ...this.state,
      running: false,
      done: files.length,
      current: '',
      ...counts,
      removed,
      finishedAt: Date.now(),
      note: '',
    }
    this.deps.log(`kb: 扫描完成——新增 ${counts.added}、更新 ${counts.updated}、跳过 ${counts.skipped}、失败 ${counts.failed}、移除 ${removed}（${files.length} 个文件）`)
    if (files.length > 0 || removed > 0) await this.deps.store.compact().catch(() => {})
    return this.state
  }

  /** 处理一个文件：读一次字节，算哈希，解析、分块、归档、写入。 */
  private async ingestOne(file: SourceFile, force: boolean): Promise<Outcome> {
    const now = Date.now()
    const existing = this.deps.store.docByPath(file.rel)
    let bytes: Buffer
    try {
      bytes = await fs.readFile(file.abs)
    } catch (error) {
      return await this.recordFailure(existing, file, '', now, `读取失败：${(error as Error).message}`)
    }
    const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 32)
    if (!force && existing?.hash === hash && (existing.status === 'active' || existing.status === 'error')) {
      return 'skipped'
    }
    const docId = existing?.id ?? docIdOf(file.rel)
    try {
      const fileName = file.rel.split('/').pop() ?? file.rel
      const parsed = await parseBytes(bytes, fileName, {
        maxBytes: this.deps.maxBytes,
        doclingUrl: this.deps.doclingUrl,
      })
      const chunks = buildChunks(docId, parsed.text, this.deps.log, file.rel)
      if (chunks.length === 0) throw new Error('没有可索引的文本')
      const doc = makeDoc(existing, {
        id: docId, hash, path: file.rel, text: parsed.text, parser: parsed.parser,
        bytes: bytes.length, mtime: (await fs.stat(file.abs)).mtimeMs, now,
        ...(parsed.pages === undefined ? {} : { pages: parsed.pages }),
      })
      await this.deps.store.archiveChunks(docId)
      await this.deps.store.putDocument(doc)
      await this.deps.store.putChunks(chunks)
      return existing === undefined ? 'added' : 'updated'
    } catch (error) {
      return await this.recordFailure(existing, file, hash, now, (error as Error).message)
    }
  }

  private async recordFailure(
    existing: KbDocument | undefined,
    file: SourceFile,
    hash: string,
    now: number,
    message: string,
  ): Promise<Outcome> {
    const docId = existing?.id ?? docIdOf(file.rel)
    await this.deps.store.archiveChunks(docId)
    const doc: KbDocument = {
      ...(existing ?? baseDoc(docId, file.rel, now)),
      hash,
      status: 'error',
      error: message.slice(0, 300),
      updatedAt: now,
    }
    await this.deps.store.putDocument(doc)
    this.deps.log(`kb: ${file.rel} 解析失败：${message}`)
    return 'failed'
  }

  /** 磁盘上消失的文件：只处理**扫描目录确实存在**的那部分，避免目录暂时不可用就清库。 */
  private async dropMissing(files: readonly SourceFile[]): Promise<number> {
    const dirs = parseDirs(this.deps.dirs)
    const roots: string[] = []
    for (const dir of dirs) {
      try {
        const stat = await fs.stat(path.join(this.deps.workspace, dir))
        if (stat.isDirectory()) roots.push(dir)
      } catch { /* 目录不在 → 这轮不做删除判断 */ }
    }
    if (roots.length === 0) return 0
    const present = new Set(files.map((file) => file.rel))
    let removed = 0
    for (const doc of this.deps.store.documents()) {
      if (doc.status === 'deleted' || present.has(doc.path)) continue
      if (!withinDirs(doc.path, roots)) continue
      await this.deps.store.removeDocument(doc.id, Date.now())
      removed += 1
    }
    return removed
  }
}

/** 切块并补上出处字段。超上限时截断（记一行日志）。 */
export function buildChunks(docId: string, text: string, log: (line: string) => void, relPath: string): KbChunk[] {
  const pieces = chunkText(text)
  if (pieces.length > MAX_CHUNKS_PER_DOC) {
    log(`kb: ${relPath} 切出 ${pieces.length} 块，超过上限 ${MAX_CHUNKS_PER_DOC}，只索引前 ${MAX_CHUNKS_PER_DOC} 块`)
  }
  return pieces.slice(0, MAX_CHUNKS_PER_DOC).map((piece, seq) => ({
    id: chunkIdOf(docId, seq),
    docId,
    seq,
    text: piece.text,
    heading: piece.heading,
    line: piece.line,
    page: piece.page,
    hash: stableHash(piece.text),
    archived: false,
  }))
}

/** 文档记录的形状（新增与更新共用）。 */
function makeDoc(
  existing: KbDocument | undefined,
  input: {
    id: string; hash: string; path: string; text: string; parser: string
    bytes: number; mtime: number; now: number; pages?: number
  },
): KbDocument {
  return {
    ...(existing ?? baseDoc(input.id, input.path, input.now)),
    hash: input.hash,
    title: titleOf(input.path, input.text),
    collection: collectionOf(input.path),
    mime: mimeOf(input.path),
    bytes: input.bytes,
    mtime: input.mtime,
    updatedAt: input.now,
    status: 'active',
    parser: input.parser,
    ...(input.pages === undefined ? {} : { pages: input.pages }),
    error: '',
  }
}

function baseDoc(id: string, relPath: string, now: number): KbDocument {
  return {
    id, hash: '', path: relPath, title: relPath.split('/').pop() ?? relPath,
    collection: collectionOf(relPath), mime: mimeOf(relPath), bytes: 0, mtime: 0,
    addedAt: now, updatedAt: now, status: 'active', parser: 'text',
  }
}

/** 粗粒度 MIME（只用于后台展示与 Docling 的判断说明）。 */
function mimeOf(relPath: string): string {
  const ext = path.extname(relPath).toLowerCase()
  const table: Record<string, string> = {
    '.md': 'text/markdown', '.markdown': 'text/markdown', '.txt': 'text/plain',
    '.html': 'text/html', '.htm': 'text/html', '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.csv': 'text/csv', '.json': 'application/json',
  }
  return table[ext] ?? 'application/octet-stream'
}
