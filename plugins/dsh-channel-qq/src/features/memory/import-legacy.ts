/** 旧知识库（`entries.json`）→ 结构化记忆（`records.jsonl`）的一次性导入。
 *
 * 为什么需要：`memory.v2` 一打开，`qq_recall_memory` 就改读新库；而新库初始是空的，
 * 于是旧库里的上百条知识会**看起来全丢了**（它们其实好好躺在 `entries.json` 里）。
 * 2026-10-18 的审计把这条列为"修 v2 之前必须先补"。
 *
 * 策略是**只增不改**：按 `content` 去重，已存在的一律跳过；导入来的记录标
 * `source.kind = 'migration'`，重要度 5、置信度 0.6（比模型现提取的保守一点）。
 */

import { makeRecord, type MemoryKind, type MemoryRecord } from '../../core/memory/model.js'
import type { MemoryStore } from './store.js'

/** 旧库条目的最小形状（只读它真正用到的字段）。 */
export interface LegacyEntryLike {
  readonly type?: string
  readonly content?: unknown
  readonly tags?: unknown
  readonly source?: unknown
  readonly created?: unknown
}

const KINDS = new Set<MemoryKind>(['fact', 'preference', 'event', 'person', 'skill', 'procedure', 'trait'])

function kindOf(raw: string | undefined): MemoryKind {
  return raw !== undefined && KINDS.has(raw as MemoryKind) ? raw as MemoryKind : 'fact'
}

/**
 * 把旧条目导入新库；返回导入条数。
 *
 * `now`/`roll` 由调用方注入（core 层不读时钟、不掷随机），重复导入同一份不会产生重复记录。
 */
export async function importLegacyEntries(
  store: MemoryStore,
  entries: readonly LegacyEntryLike[],
  opts: { now: number; roll: () => number; log: (line: string) => void },
): Promise<number> {
  const known = new Set(store.all().map((record) => record.content))
  const fresh: MemoryRecord[] = []
  let index = 0
  for (const entry of entries) {
    index += 1
    const content = typeof entry.content === 'string' ? entry.content.trim() : ''
    if (content === '' || known.has(content)) continue
    try {
      fresh.push(makeRecord({
        kind: kindOf(entry.type),
        subject: { type: 'world' },
        content,
        tags: Array.isArray(entry.tags) ? entry.tags.filter((t): t is string => typeof t === 'string').slice(0, 8) : [],
        source: { kind: 'migration', file: 'entries.json' },
        importance: 5,
        confidence: 0.6,
        validFrom: typeof entry.created === 'number' ? entry.created : opts.now,
        keywords: typeof entry.source === 'string' ? [entry.source.slice(0, 20)] : [],
      }, opts.now, () => (opts.roll() + index / 10_000) % 1))
    } catch (error) {
      opts.log(`memory import: 跳过一条（${error instanceof Error ? error.message : String(error)}）`)
    }
  }
  if (fresh.length > 0) await store.put(...fresh)
  opts.log(`memory import: 旧库 ${entries.length} 条 → 导入 ${fresh.length} 条（已存在 ${entries.length - fresh.length}）`)
  return fresh.length
}
