/** 按房间存服务端历史（A4）：去重、按时间升序、保留最近 500 条。
 *
 * 一份房间一个 JSON 文件；写入走 JsonStore（原子 + 串行 + .bak）。
 */

import * as path from 'node:path'
import { JsonStore } from '../../adapters/fs-store/json-store.js'
import type { HistoryEntry } from './normalize.js'

/** 每个房间保留的条数上限。 */
export const MAX_HISTORY_ENTRIES = 500

function isEntry(value: unknown): value is HistoryEntry {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'number'
    && typeof record.time === 'number'
    && typeof record.userId === 'number'
    && typeof record.name === 'string'
    && typeof record.text === 'string'
}

export class HistoryStore {
  private readonly rooms = new Map<string, HistoryEntry[]>()
  private readonly stores = new Map<string, JsonStore<HistoryEntry[]>>()

  constructor(private readonly dir: string, private readonly log: (line: string) => void) {}

  private storeFor(room: string): JsonStore<HistoryEntry[]> {
    const existing = this.stores.get(room)
    if (existing !== undefined) return existing
    const file = path.join(this.dir, `${room}.json`)
    const store = new JsonStore<HistoryEntry[]>(file, {
      log: this.log,
      validate: (value): value is HistoryEntry[] => Array.isArray(value) && value.every(isEntry),
    })
    this.stores.set(room, store)
    return store
  }

  /** 读一个房间的历史；没读过就从盘上读（坏文件 = 空）。 */
  async list(room: string): Promise<readonly HistoryEntry[]> {
    const cached = this.rooms.get(room)
    if (cached !== undefined) return cached
    const loaded = await this.storeFor(room).load([])
    const entries = loaded.filter(isEntry).sort((a, b) => a.time - b.time).slice(-MAX_HISTORY_ENTRIES)
    this.rooms.set(room, entries)
    return entries
  }

  /** 合并一批条目，返回新增条数；有新增才写盘。 */
  async merge(room: string, incoming: readonly HistoryEntry[]): Promise<number> {
    const current = [...await this.list(room)]
    const seen = new Set(current.map((entry) => entry.id))
    let added = 0
    for (const entry of incoming) {
      if (seen.has(entry.id)) continue
      seen.add(entry.id)
      current.push(entry)
      added += 1
    }
    if (added === 0) return 0
    current.sort((a, b) => a.time - b.time)
    const next = current.slice(-MAX_HISTORY_ENTRIES)
    this.rooms.set(room, next)
    await this.storeFor(room).save(next)
    return added
  }
}
