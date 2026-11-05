/** 事件书的状态落盘（P6f）：`<dshHome>/channel-qq/proactive-state.json`。
 *
 * 磁盘格式：`{version:1, events:{ [id]: { lastKey, lastRunAt, lastOutcome, lastSkipReason, runs } }}`
 * （规格来自 05 §9.2；**读写两侧必须是同一形状**——见 `load()` 里的注记）。
 * "先写状态再执行"——跑之前先把幂等键落盘，重启才不会重复（修 B1）；所以这里的
 * `setEntry` 由执行器在**执行前**调用，写完立刻原子落盘（`persist` 由执行器负责）。
 *
 * 读盘容错照 SchedulerState 的范式：文件不存在/损坏 → 空表，绝不抛。
 * 迁移：第一次跑时（状态文件还不存在）把旧 `scheduler-state.json` 里"今天做过了"
 * 的标记读进来，避免升级当天早报/梦再发一遍（见 `migrateLegacyMarks`）。
 */

import { readFileSync } from 'node:fs'
import { SchedulerState } from '../../scheduler-state.js'

export interface EventStateEntry {
  /** 上一次执行/判定用的幂等键（`id:floor(now/every)` 或 `id:YYYY-MM-DD`）。 */
  lastKey: string | null
  /** 上一次真正开始执行的时刻（ISO）；没跑过为 null。 */
  lastRunAt: string | null
  /** `ran` / `skipped:<原因>` / `failed:<错误>`；进程死于执行中时读盘后改写为 `failed:interrupted`。 */
  lastOutcome: string | null
  /** 上一次跳过的原因（与 lastOutcome 的 skipped: 前缀同一份信息，方便面板单列）。 */
  lastSkipReason: string | null
  /** 开始执行的累计次数（跳过不计）。 */
  runs: number
}

export type EventStateMap = Record<string, EventStateEntry>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class ProactiveState {
  private entries: EventStateMap = {}
  private loaded = false
  private existedOnDisk = false
  private readonly file: string
  private readonly log: (line: string) => void

  constructor(opts: { file: string; log: (line: string) => void }) {
    this.file = opts.file
    this.log = opts.log
  }

  /** 盘上本来就有这份状态文件吗（迁移与"第一次跑"判据）。 */
  get existed(): boolean {
    return this.existedOnDisk
  }

  get stateFile(): string {
    return this.file
  }

  /** 读盘一次；读不到/读坏了都当空表（第一次跑的常态）。 */
  load(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf-8'))
      if (!isRecord(parsed)) return
      this.existedOnDisk = true
      // 磁盘格式与写盘侧（executor.persist）必须一致：`{version, events:{id → 条目}}`。
      // 少了这层包装的解析会让每个事件都读成"从没跑过"——同一桶在每次重启后重发一遍。
      const events = isRecord(parsed.events) ? parsed.events : {}
      for (const [id, raw] of Object.entries(events)) {
        if (!isRecord(raw)) continue
        this.entries[id] = {
          lastKey: typeof raw.lastKey === 'string' ? raw.lastKey : null,
          lastRunAt: typeof raw.lastRunAt === 'string' ? raw.lastRunAt : null,
          // 进程在"running"状态下死掉：读盘时改写成一个说得清的结果，别让面板永远挂着"运行中"。
          lastOutcome: raw.lastOutcome === 'running'
            ? 'failed:interrupted'
            : (typeof raw.lastOutcome === 'string' ? raw.lastOutcome : null),
          lastSkipReason: typeof raw.lastSkipReason === 'string' ? raw.lastSkipReason : null,
          runs: typeof raw.runs === 'number' && Number.isFinite(raw.runs) ? Math.max(0, Math.floor(raw.runs)) : 0,
        }
      }
    } catch {
      /* 文件不存在或损坏：当作空表，本轮该跑什么就跑什么 */
    }
  }

  get(id: string): EventStateEntry | undefined {
    return this.entries[id]
  }

  setEntry(id: string, entry: EventStateEntry): void {
    this.entries[id] = entry
  }

  /** 落盘用的快照副本（条目本身不可变，浅拷贝够）。 */
  snapshot(): EventStateMap {
    return { ...this.entries }
  }

  size(): number {
    return Object.keys(this.entries).length
  }
}

/**
 * 把旧调度器的"今天做过了"标记迁移进事件书状态（只在状态文件不存在时调用）。
 *
 * 映射（旧键 → 事件 id）：`morning-<日>` → `morning-report`、`dream-<日>` → `dream`、
 * `kn-<日>` → `knowledge-extract`。种子写成 `skipped:migrated-legacy`——它没在
 * 事件书里跑过，但今天这一份确实已经由旧调度器发出去了，不能再发一遍。
 *
 * @returns 迁移的事件 id 清单（空数组 = 没有可迁移的）
 */
export function migrateLegacyMarks(state: ProactiveState, legacyFile: string, today: string): string[] {
  const legacy = new SchedulerState({ file: legacyFile })
  legacy.load()
  if (legacy.size() === 0) return []
  const mapping: ReadonlyArray<readonly [string, string]> = [
    ['morning', 'morning-report'],
    ['dream', 'dream'],
    ['kn', 'knowledge-extract'],
  ]
  const migrated: string[] = []
  for (const [prefix, id] of mapping) {
    if (!legacy.has(`${prefix}-${today}`)) continue
    const key = `${id}:${today}`
    if (state.get(id)?.lastKey === key) continue
    state.setEntry(id, {
      lastKey: key,
      lastRunAt: null,
      lastOutcome: 'skipped:migrated-legacy',
      lastSkipReason: 'migrated-legacy',
      runs: 0,
    })
    migrated.push(id)
  }
  return migrated
}
