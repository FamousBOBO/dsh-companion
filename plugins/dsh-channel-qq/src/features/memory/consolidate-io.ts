/** 巩固的落盘面（P1）：冲突冻结队列 + 决策凭证账本。
 *
 * 两个文件都在 `knowledge/` 下，与 `records.jsonl` 同目录：
 *   - `conflicts.jsonl`：疑似冲突对（**冻结待裁决**——mneme 的"冲突不自动处理"）。
 *     夜间扫描发现一对就记一行；主人在后台拍板后标记 `resolved`，不再出现在待处理里。
 *     之前 `memory-pending` 页是**每次现算**（`findConflicts` 全库 O(n²)），裁决后
 *     两条都还 active 的对会反复出现——队列版把"检出"与"裁决"解耦。
 *   - `consolidation-log.jsonl`：**append-only 决策凭证**（merge/resolve/archive 各一行）。
 *     巩固不留凭证 = 白巩固：一个月后"这两条为什么变成了一条"必须有答案。
 *
 * IO 规矩与 `nightly-io.ts` 相同：读不到 = 空，绝不抛穿；追加写；坏行跳过。
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { atomicWriteFile } from '../../adapters/fs-store/atomic.js'
import { conflictKey } from '../../core/memory/consolidate.js'
import type { ConflictPair } from '../../core/memory/nightly.js'

/** 队列里的一对冻结冲突。 */
export interface FrozenConflict {
  readonly key: string
  readonly leftId: string
  readonly rightId: string
  readonly overlap: number
  readonly foundAt: number
  /** 裁决时间与结果；null = 还挂着。 */
  readonly resolvedAt: number | null
  readonly resolution?: 'kept-left' | 'kept-right' | 'both'
}

/** 凭证账本的一行。 */
export interface ConsolidationEntry {
  readonly at: number
  readonly action: 'merge' | 'resolve' | 'archive'
  readonly note: string
}

function fileOf(dir: string, name: string): string {
  return path.join(dir, name)
}

async function readJsonl<T>(file: string): Promise<T[]> {
  const raw = await fs.readFile(file, 'utf-8').catch(() => '')
  if (raw === '') return []
  const out: T[] = []
  for (const line of raw.split('\n')) {
    const text = line.trim()
    if (text === '') continue
    try {
      out.push(JSON.parse(text) as T)
    } catch { /* 坏行跳过 */ }
  }
  return out
}

/** 读冲突队列（按发现时间倒序：新的先看）。 */
export async function readConflicts(dir: string): Promise<FrozenConflict[]> {
  const rows = await readJsonl<FrozenConflict>(fileOf(dir, 'conflicts.jsonl'))
  return rows.sort((a, b) => b.foundAt - a.foundAt)
}

/** 读还没裁决的冲突。 */
export async function readOpenConflicts(dir: string): Promise<FrozenConflict[]> {
  return (await readConflicts(dir)).filter((row) => row.resolvedAt === null)
}

/**
 * 把新检出的冲突对追加进队列（已有同 key 的——无论裁决与否——不重复记）。
 * 返回实际新增了几对。
 */
export async function freezeConflicts(
  dir: string,
  pairs: readonly ConflictPair[],
  now: number,
): Promise<number> {
  if (pairs.length === 0) return 0
  const file = fileOf(dir, 'conflicts.jsonl')
  const existing = new Set((await readConflicts(dir)).map((row) => row.key))
  const fresh: string[] = []
  for (const pair of pairs) {
    const key = conflictKey(pair)
    if (existing.has(key)) continue
    existing.add(key)
    const row: FrozenConflict = {
      key,
      leftId: pair.left.id,
      rightId: pair.right.id,
      overlap: Number(pair.overlap.toFixed(3)),
      foundAt: now,
      resolvedAt: null,
    }
    fresh.push(JSON.stringify(row))
  }
  if (fresh.length === 0) return 0
  await fs.mkdir(dir, { recursive: true })
  await fs.appendFile(file, fresh.join('\n') + '\n', 'utf-8')
  return fresh.length
}

/** 裁决一对冲突：整行重写（队列文件小，几百行级，重写比追改正行便宜且简单）。 */
export async function resolveFrozenConflict(
  dir: string,
  key: string,
  resolution: FrozenConflict['resolution'],
  now: number,
): Promise<boolean> {
  const file = fileOf(dir, 'conflicts.jsonl')
  const rows = await readConflicts(dir)
  let hit = false
  const next = rows.map((row) => {
    if (row.key !== key || row.resolvedAt !== null) return row
    hit = true
    return { ...row, resolvedAt: now, ...(resolution === undefined ? {} : { resolution }) }
  })
  if (!hit) return false
  await fs.mkdir(dir, { recursive: true })
  await atomicWriteFile(file, next.map((row) => JSON.stringify(row)).join('\n') + '\n')
  return true
}

/** 追加一条决策凭证。失败只记日志——凭证是给事后追责的，不该让巩固本身失败。 */
export async function appendConsolidationLog(
  dir: string,
  entry: ConsolidationEntry,
  log: (line: string) => void,
): Promise<void> {
  try {
    await fs.mkdir(dir, { recursive: true })
    await fs.appendFile(fileOf(dir, 'consolidation-log.jsonl'), JSON.stringify(entry) + '\n', 'utf-8')
  } catch (error) {
    log(`memory: 凭证落盘失败（巩固已完成）：${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 读凭证（后台/排查用；新的在前）。 */
export async function readConsolidationLog(dir: string, limit = 100): Promise<ConsolidationEntry[]> {
  const rows = await readJsonl<ConsolidationEntry>(fileOf(dir, 'consolidation-log.jsonl'))
  return rows.slice(-limit).reverse()
}
