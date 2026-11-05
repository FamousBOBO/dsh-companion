/** 服务端历史服务（A4）：按房间节流拉取、合并、检索。
 *
 * 这不是"每来一条消息就同步"——那是给协议端加负担。只在工具/日报需要时按需拉，
 * 同一房间 60 秒内只拉一次；失败只写日志，检索退回本地已有的部分。
 */

import type { QQChannelConfig } from '../../config.js'
import { localDayKey } from '../../core/schedule/stamp.js'
import type { QQApi } from '../../ports/platform.js'
import { normalizeHistoryMessage, type HistoryEntry } from './normalize.js'
import type { HistoryStore } from './store.js'

/** 同一房间两次回源的最小间隔。 */
const SYNC_COOLDOWN_MS = 60_000

export interface HistoryFilter {
  readonly keyword?: string | null
  readonly sender?: number | null
  readonly since?: string | null
  readonly until?: string | null
}

export interface HistoryDeps {
  readonly api: () => QQApi | null
  readonly config: () => QQChannelConfig['history']
  readonly store: HistoryStore
  readonly now: () => number
  readonly log: (line: string) => void
}

export class HistoryService {
  private readonly lastSync = new Map<string, number>()

  constructor(private readonly deps: HistoryDeps) {}

  /** 回源一次（节流）；返回新增条数。关着/失败都返回 0。 */
  async sync(room: string, isGroup: boolean, target: number, force = false): Promise<number> {
    if (!this.deps.config().serverBackfill) return 0
    const now = this.deps.now()
    if (!force && now - (this.lastSync.get(room) ?? 0) < SYNC_COOLDOWN_MS) return 0
    return await this.collect(room, isGroup, target)
  }

  /**
   * 强制回源一次（不看 `history.serverBackfill`，也不节流）。
   *
   * 只给群日报这类"明确要数据"的调用方用；检索路径仍走 `sync`，开关语义不变。
   */
  async collect(room: string, isGroup: boolean, target: number, count?: number): Promise<number> {
    const api = this.deps.api()
    if (api === null) return 0
    const limit = count ?? this.deps.config().maxMessages
    this.lastSync.set(room, this.deps.now())
    try {
      const result = isGroup
        ? await api.getGroupMsgHistory(target, limit)
        : await api.getFriendMsgHistory(target, limit)
      const entries = (result.messages ?? [])
        .map((raw) => normalizeHistoryMessage(raw))
        .filter((entry): entry is HistoryEntry => entry !== null)
      const added = await this.deps.store.merge(room, entries)
      this.deps.log(`history: ${room} 回源 ${entries.length} 条，新增 ${added}`)
      return added
    } catch (error) {
      this.deps.log(`history: ${room} 回源失败：${error instanceof Error ? error.message : String(error)}`)
      return 0
    }
  }

  /** 按条件检索（时间升序）；空条件 = 最近的全部。 */
  async search(room: string, filter: HistoryFilter): Promise<HistoryEntry[]> {
    const entries = await this.deps.store.list(room)
    const keyword = filter.keyword === undefined || filter.keyword === null ? '' : filter.keyword
    return entries.filter((entry) => {
      if (keyword !== '' && !entry.text.includes(keyword)) return false
      if (typeof filter.sender === 'number' && entry.userId !== filter.sender) return false
      const day = entry.time === 0 ? '' : localDayKey(new Date(entry.time * 1000))
      if (filter.since !== undefined && filter.since !== null && filter.since !== '' && day < filter.since) return false
      if (filter.until !== undefined && filter.until !== null && filter.until !== '' && day > filter.until) return false
      return true
    })
  }

  /** 房间条目数（后台资源用）。 */
  async count(room: string): Promise<number> {
    return (await this.deps.store.list(room)).length
  }
}
