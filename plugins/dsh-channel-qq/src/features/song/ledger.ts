/** 点歌账本：任务的阶段、去重、日上限与"发过没发过"。
 *
 * 为什么需要落盘而不是纯内存：一次点歌要跑两三分钟，而机器人是会被重启的。
 * 内存里记着"这首已经发出去了"，重启之后就是"没发过"——于是同一个入站消息
 * 可能被再处理一遍、再发一条语音条。**去重必须活过重启**，这是这个文件的全部理由。
 *
 * 三条刻意的边界：
 *
 *   1. **账本只记终态与阶段，不记音频路径**。产物路径在 `workRoot` 下、任务结束就删；
 *      把路径写进账本只会在重启后留下一个指向已删文件的值。要听歌请点歌，不要读账本。
 *   2. **去重键是**入站 `message_id` 或 `auto:<日键>`。这是"同一条消息不会出现两次"
 *      的判据；它不看歌名（同一个人在两小时内点同一首歌是两次点歌，不是重复）。
 *   3. **`unknown-send` 与 `sent` 一样是终态**，并且都算"今天发过"。理由很简单：
 *      回执未知的那条可能已经到了对方手机上。把它算作没发，下一轮就会再发一条。
 *
 * 读写在 `adapters/fs-store/atomic.ts`（原子写 + fsync + rename）；这里只做合并与裁剪。
 * 账本上限 200 条、保留 14 天：点歌是低频功能，这个上限够用一整年，超了丢最旧的。
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { atomicWriteJson } from '../../adapters/fs-store/atomic.js'
import type { Clock } from '../../ports/clock.js'
import type { SongEntry, SongStage, SongTaskStatus } from './types.js'

/** 账本里一条记录。与 `SongTaskStatus` 同形（对外就暴露它）。 */
export type SongLedgerRow = SongTaskStatus

export interface SongLedgerData {
  /** 版本号：将来换形状时靠它判断"这份能不能读"。 */
  readonly version: 1
  readonly tasks: readonly SongLedgerRow[]
  /** 日上限用的计数：`day` 与今天的日键不一致时视为 0（跨日归零）。 */
  readonly autoDay: string
  readonly autoCount: number
}

/** 账本上限（条）与保留期（毫秒）。 */
const MAX_ROWS = 200
const RETENTION_MS = 14 * 24 * 3_600_000

/** 空账本。 */
export function emptyLedger(): SongLedgerData {
  return { version: 1, tasks: [], autoDay: '', autoCount: 0 }
}

/** 是不是"发出去过"（回执未知也算）。 */
export function countsAsSent(row: SongLedgerRow): boolean {
  return row.stage === 'sent' || row.stage === 'unknown-send'
}

/** 是不是终态（终态之后不再改，除非显式 reopen）。 */
export function isTerminal(stage: SongStage): boolean {
  return stage === 'sent' || stage === 'failed' || stage === 'unknown-send'
    || stage === 'cancelled' || stage === 'dry-run'
}

/** 从磁盘读；不存在 / 坏 JSON / 形状不对 → 空账本（不抛，坏账本不该拦住启动）。 */
export async function loadLedger(file: string, log: (line: string) => void): Promise<SongLedgerData> {
  let text: string
  try {
    text = await fs.readFile(file, 'utf8')
  } catch {
    return emptyLedger()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    log('song: 账本不是合法 JSON，按空账本开始（旧记录不会让点歌停摆）')
    return emptyLedger()
  }
  if (parsed === null || typeof parsed !== 'object') {
    log('song: 账本形状不对（不是对象），按空账本开始')
    return emptyLedger()
  }
  const record = parsed as Record<string, unknown>
  const tasks = Array.isArray(record['tasks']) ? record['tasks'] : []
  const rows: SongLedgerRow[] = []
  for (const item of tasks) {
    const row = toRow(item)
    if (row !== null) rows.push(row)
  }
  const autoDay = typeof record['autoDay'] === 'string' ? record['autoDay'] : ''
  const autoCount = typeof record['autoCount'] === 'number' && Number.isFinite(record['autoCount'])
    ? Math.max(0, Math.round(record['autoCount']))
    : 0
  return { version: 1, tasks: rows, autoDay, autoCount }
}

/** 单条校验：缺字段/类型不对的行直接丢（一行坏数据不该让整本账不可读）。 */
function toRow(value: unknown): SongLedgerRow | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const id = typeof row['id'] === 'string' ? row['id'] : ''
  if (id === '') return null
  const stage = typeof row['stage'] === 'string' ? row['stage'] : ''
  const stages: readonly string[] = [
    'queued', 'downloading', 'chorus', 'covering', 'sending', 'sent',
    'dry-run', 'failed', 'unknown-send', 'cancelled',
  ]
  if (!stages.includes(stage)) return null
  const entry = row['entry'] === 'auto' ? 'auto' : 'dm'
  const num = (key: string): number | null => {
    const raw = row[key]
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : null
  }
  return {
    id,
    entry: entry as SongEntry,
    room: typeof row['room'] === 'string' ? row['room'] : '',
    song: typeof row['song'] === 'string' ? row['song'] : '',
    artist: typeof row['artist'] === 'string' ? row['artist'] : '',
    stage: stage as SongStage,
    bvid: typeof row['bvid'] === 'string' ? row['bvid'] : null,
    chorusStart: num('chorusStart'),
    seconds: num('seconds'),
    keyUp: num('keyUp'),
    detail: typeof row['detail'] === 'string' ? row['detail'] : null,
    createdAt: num('createdAt') ?? 0,
    updatedAt: num('updatedAt') ?? 0,
    messageId: num('messageId'),
  }
}

/**
 * 合并并裁剪。
 *
 * `upsert` 语义是**按 id 覆盖整行**：一个任务的状态机只该往前走，覆盖比补丁更容易
 * 保证"没有半新半旧的记录"。裁剪按 `updatedAt` 倒序留最新的若干条。
 */
export function mergeLedger(
  current: SongLedgerData,
  change: {
    readonly upsert?: readonly SongLedgerRow[]
    readonly autoDay?: string
    readonly autoCount?: number
  },
  now: number,
): SongLedgerData {
  const byId = new Map<string, SongLedgerRow>()
  for (const row of current.tasks) byId.set(row.id, row)
  for (const row of change.upsert ?? []) byId.set(row.id, row)
  const kept = [...byId.values()]
    .filter((row) => now - row.updatedAt <= RETENTION_MS)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_ROWS)
  return {
    version: 1,
    tasks: kept,
    autoDay: change.autoDay ?? current.autoDay,
    autoCount: change.autoCount ?? current.autoCount,
  }
}

/** 这一条去重键是不是已经在账本里（且不是"可重来时"的失败态）。 */
export function dedupeHit(ledger: SongLedgerData, dedupeKey: string): SongLedgerRow | null {
  for (const row of ledger.tasks) {
    if (row.id === dedupeKey) return row
  }
  return null
}

/** 今天（日键）已用掉的自主点歌额度。日键不等 = 0（跨日归零）。 */
export function autoUsedToday(ledger: SongLedgerData, dayKey: string): number {
  if (dayKey === '' || ledger.autoDay !== dayKey) return 0
  return ledger.autoCount
}

/** 写账本（原子写）。失败不抛给用户，只记一行日志：账本丢了顶多重发判断失准，不该停摆。 */
export async function saveLedger(
  file: string,
  data: SongLedgerData,
  log: (line: string) => void,
): Promise<boolean> {
  try {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await atomicWriteJson(file, data)
    return true
  } catch (error) {
    log(`song: 账本写入失败（${error instanceof Error ? error.message : String(error)}）`)
    return false
  }
}

/** 给一条任务做"现在是什么阶段"的构造。集中一处，免得每个阶段都手抄 11 个字段。 */
export function rowOf(
  base: SongLedgerRow,
  patch: Partial<SongLedgerRow> & { readonly stage: SongStage },
  clock: Clock,
): SongLedgerRow {
  return { ...base, ...patch, updatedAt: clock.now() }
}
