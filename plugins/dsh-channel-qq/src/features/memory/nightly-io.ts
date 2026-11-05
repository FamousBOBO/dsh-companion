/** 夜间任务的 IO 辅助（P6e·e3）：读日记、写归档、写 DIGEST、抽取结果转记录。
 *
 * 与 `nightly.ts`（编排与判据）分开是行数纪律：`check-size` 的 400 行/60 行是
 * 硬上限，而这两块各自都有话要说。
 *
 * 三条 IO 规矩：
 *   - 读不到 = 空/跳过，**绝不抛穿**（夜间任务失败不该让机器人次日早上起不来）；
 *   - 写归档用 **gzip 追加**（`records.archive.jsonl.gz`，§4.3）：归档文件只增不改，
 *     追加一段 gzip 成员是合法的 gzip 流（`zcat` 与 `gunzip` 都能读整份）；
 *   - DIGEST 用原子写（临时文件 + rename）：它会被模型整读，半截文件比没有更糟。
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { createGzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { atomicWriteFile } from '../../adapters/fs-store/atomic.js'
import { overlapOf } from '../../core/memory/nightly.js'
import type { MemoryRecord, MemorySource, NewRecordInput, MemoryKind } from '../../core/memory/model.js'
import type { MemoryStore } from './store.js'

/** 判定"重复"的重叠门槛（无向量时的近似：§6.1 的 0.92 用二元组重叠代理）。 */
export const DUPLICATE_OVERLAP = 0.9

/** 读一天的日记；没有就空串。 */
export async function readDiary(workspace: string | null, day: string): Promise<string> {
  if (workspace === null || workspace === '') return ''
  return await fs.readFile(path.join(workspace, 'memory', `${day}.md`), 'utf-8').catch(() => '')
}

/** 写 `memory/DIGEST.md`（原子写）。 */
export async function writeDigestFile(workspace: string | null, text: string): Promise<string> {
  const dir = path.join(workspace ?? '', 'memory')
  const file = path.join(dir, 'DIGEST.md')
  await fs.mkdir(dir, { recursive: true })
  await atomicWriteFile(file, text)
  return file
}

/**
 * 把记录追加进归档文件（`knowledge/records.archive.jsonl.gz`）。
 *
 * 每行是 `{record, note, archivedAt}`——归档是"不再检索"，不是"删掉"，所以整条
 * 记录原样保留，附一句"为什么归档"。
 */
export async function appendArchive(
  dir: string,
  entries: ReadonlyArray<{ record: MemoryRecord; note: string }>,
  archivedAt: number,
): Promise<string> {
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, 'records.archive.jsonl.gz')
  const body = entries.map((e) => JSON.stringify({ record: e.record, note: e.note, archivedAt })).join('\n') + '\n'
  // gzip 追加以"一个成员"为单位：多次追加 = 多个成员串联，gzip 规范允许。
  const gz = createGzip()
  const chunks: Buffer[] = []
  const collector = (async (): Promise<void> => {
    for await (const chunk of gz) chunks.push(chunk as Buffer)
  })()
  await pipeline(Readable.from([body]), gz)
  await collector
  await fs.appendFile(file, Buffer.concat(chunks))
  return file
}

/** 抽取器给的条目形状（`knowledge.ts` 的 `KnowledgeEntry` 去掉管理字段）。 */
export interface ExtractedItem {
  readonly type: string
  readonly content: string
  readonly tags: string[]
  readonly source: string
}

const KINDS: readonly MemoryKind[] = ['fact', 'preference', 'event', 'person', 'skill', 'procedure', 'trait']

/** 抽取器的 `type` 词表 → 记忆 kind（对不上算 fact，与旧管线同一口径）。 */
export function asKind(raw: string): MemoryKind {
  const value = raw.trim().toLowerCase()
  return (KINDS as readonly string[]).includes(value) ? (value as MemoryKind) : 'fact'
}

/** 抽取条目 → 建档输入（出处带上"从哪一天/哪个来源抽的"）。 */
export function toNewRecord(
  item: ExtractedItem,
  source: MemorySource,
  opts: { importance?: number; status?: NewRecordInput['status'] } = {},
): NewRecordInput {
  return {
    kind: asKind(item.type),
    subject: { type: 'group' },
    content: item.content,
    source,
    tags: item.tags,
    importance: opts.importance ?? 5,
    ...(opts.status === undefined ? {} : { status: opts.status }),
  }
}

/**
 * 库里有没有一条"其实就是这段内容"的记录（重叠 ≥ 0.9）。
 *
 * 这是 §6.1 的去重判据在**没有向量**时的近似：设计要的是"相似度 > 0.92 视为重复"，
 * 那需要嵌入；关键词重叠是它的保守代理（同一条内容反复抽取时重叠接近 1）。
 * 命中返回那条记录（调用方 `withHit` 强化它），没命中返回 null。
 */
export function findNearDuplicate(store: MemoryStore, content: string): MemoryRecord | null {
  for (const record of store.all()) {
    // `candidate` 也要算：反思每次从同一批高重要性记录归纳，不查候选就会每天多一条
    // 一模一样的候选（它们在后台列表里越堆越高）。
    if (record.status !== 'active' && record.status !== 'candidate') continue
    if (record.content === content) return record
    if (overlapOf(record.content, content) >= DUPLICATE_OVERLAP) return record
  }
  return null
}
