/** 原始文档分块索引：把工作区的 md 切成 600 字块（重叠 100）作为"原始层"记录。
 *
 * 为什么需要：结构化记录是"一句话事实"，而证据往往藏在长段落里。实测（2026-10-18，
 * 同一份日记 / 同一个 embed 模型 / 同一套 60 题）：
 *
 *     句子级记录 + 向量   recall 0.14
 *     600 字块            recall 0.28
 *
 * 块覆盖的行多，命中面更大。所以把 md 原文也切成记录，与结构化记忆并存：
 *   - 稳定 id（文件 + 块序号哈希）：重建索引是幂等的，内容没变就不动；
 *   - 文件里消失的块标 `archived`（不删除，历史可查）；
 *   - `tags: ['chunk']` 让检索/审核能区分"原文块"与"提炼出的记忆"。
 *
 * 纯计算部分（`chunkMarkdown`）不读时钟、不掷随机，可按 R8 单测。
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { makeRecord, type MemoryRecord } from '../../core/memory/model.js'
import type { MemoryStore } from './store.js'

/** 块的字符上限（与 KB Lite 实测一致）。 */
export const CHUNK_SIZE = 600
/** 相邻块的重叠字符数。 */
export const CHUNK_OVERLAP = 100
/** 单文件上限：超了跳过（和 KB Lite 的 600KB 一致）。 */
const MAX_FILE_BYTES = 600 * 1024
/** 收录的目录（相对工作区）；根目录的 md 也收。 */
const INCLUDE_DIRS = ['memory', 'knowledge', 'learning'] as const
const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', 'backups', 'downloads', 'tmp'])

export interface Chunk {
  readonly text: string
  /** 块首行在原文里的行号（1 起）。 */
  readonly line: number
}

/** 按行切块，块内保留换行；块间重叠尾部 `overlap` 个字符左右。 */
export function chunkMarkdown(text: string, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP): Chunk[] {
  if (String(text).trim() === '') return []
  const lines = String(text).split('\n')
  const out: Chunk[] = []
  let buf: string[] = []
  let len = 0
  let start = 1
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    if (len + line.length + 1 > size && buf.length > 0) {
      out.push({ text: buf.join('\n'), line: start })
      // 重叠：从尾部往回保留，直到超过 overlap
      const keep: string[] = []
      let keepLen = 0
      for (let j = buf.length - 1; j >= 0; j -= 1) {
        const candidate = buf[j] ?? ''
        if (keepLen + candidate.length + 1 > overlap) break
        keep.unshift(candidate)
        keepLen += candidate.length + 1
      }
      buf = keep
      len = keepLen
      start = i - keep.length + 1
    }
    buf.push(line)
    len += line.length + 1
  }
  if (buf.length > 0) out.push({ text: buf.join('\n'), line: start })
  return out
}

/** djb2：稳定的块 id 用（不追求抗碰撞，只要求同输入同输出）。 */
export function hashOf(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i += 1) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0
  return h.toString(36)
}

async function walk(dir: string, rel: string, out: string[]): Promise<void> {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      if (rel === '' && !INCLUDE_DIRS.includes(entry.name as typeof INCLUDE_DIRS[number]) && entry.name !== 'inbox') continue
      await walk(path.join(dir, entry.name), childRel, out)
      continue
    }
    if (!entry.name.endsWith('.md')) continue
    if (rel !== '' && rel !== 'inbox' && !INCLUDE_DIRS.includes(rel as typeof INCLUDE_DIRS[number])) continue
    out.push(childRel)
  }
}

export interface ChunkIndexResult {
  readonly files: number
  readonly chunks: number
  readonly archived: number
}

/**
 * 重建工作区的块索引（幂等）。
 *
 * `now`/`roll` 由调用方注入（core 的规矩：不读时钟、不掷随机）。
 */
export async function indexWorkspaceChunks(
  store: MemoryStore,
  opts: { workspace: string; now: number; roll: () => number; log: (line: string) => void },
): Promise<ChunkIndexResult> {
  const relFiles: string[] = []
  await walk(opts.workspace, '', relFiles)
  let chunks = 0
  let archived = 0
  const seen = new Set<string>()

  for (const rel of relFiles) {
    const abs = path.join(opts.workspace, rel)
    let text: string
    let mtimeMs: number
    try {
      const stat = await fs.stat(abs)
      if (stat.size > MAX_FILE_BYTES) { opts.log(`chunks: 跳过超大文件 ${rel}（${stat.size}B）`); continue }
      mtimeMs = stat.mtimeMs
      text = await fs.readFile(abs, 'utf-8')
    } catch (error) {
      opts.log(`chunks: 读不了 ${rel}：${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    const pieces = chunkMarkdown(text)
    for (let i = 0; i < pieces.length; i += 1) {
      const piece = pieces[i]!
      const id = `chunk-${hashOf(`${rel}#${i}`)}`
      seen.add(id)
      const existing = store.get(id)
      if (existing !== undefined && existing.content === piece.text.trim() && existing.status === 'active') { chunks += 1; continue }
      const record: MemoryRecord = {
        ...makeRecord({
          kind: 'fact',
          subject: { type: 'world' },
          content: piece.text,
          tags: ['chunk'],
          source: { kind: 'diary', file: rel, line: piece.line },
          importance: 5,
          confidence: 0.7,
          validFrom: mtimeMs,
        }, opts.now, opts.roll),
        id,
      }
      await store.put(record)
      chunks += 1
    }
  }

  // 文件里消失的块（或整文件被删）：标归档，不删除。
  for (const record of store.all()) {
    if (!record.tags.includes('chunk')) continue
    if (record.status !== 'active' || seen.has(record.id)) continue
    await store.put({ ...record, status: 'archived' })
    archived += 1
  }

  opts.log(`chunks: ${relFiles.length} 个文件 / ${chunks} 块（归档 ${archived}）`)
  return { files: relFiles.length, chunks, archived }
}
