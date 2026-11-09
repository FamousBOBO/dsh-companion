/**
 * **ReminderStore**（task-66 起按设计重写）：所有变更都走
 * `store-transaction.ts` 的事务——串行队列 + copy-on-write + 写盘成功后发布。
 *
 * 对外三条规矩：
 *   1. **业务拒绝**回 `{ ok:false, code, message }`（没改状态、没写盘）；
 *   2. **基础设施故障**（锁定 / 保存失败 / 队列满 / 重入 / 关闭）⇒ **reject** `ReminderStoreFault`；
 *   3. **查询不排队**，读最近一次已发布的**冻结**快照（写盘期间看到旧状态是允许的）。
 */

import * as path from 'node:path'
import type { QQChannelConfig } from '../../config.js'
import type { Reminder } from './reminder-model.js'
import { buildReminder, type AddInput } from './reminder-build.js'
import {
  CATCH_UP_WINDOW_MS, DROPPED_ITEMS_LIMIT, catchUpMetricsOf, droppedItemsOf, dueOf, missedRoundsOf,
  reduceCapBacklog, reduceExpireStale, reduceSkipRound,
} from './catch-up.js'
import { decodeReminderFile } from './store-load.js'
import { toMutation, transact, SerialQueue } from './store-transaction.js'
import type { Edit, Mutation, RecoveryReport, ReminderPersistence, StoreState, ValidationIssue } from './store-contract.js'
import { ReminderStoreFault, storeFault } from './store-contract.js'
import { deepFreeze } from './store-freeze.js'
import { ReminderFile } from './store-io.js'
import { reduceMarkUnknown, reducePruneFired, reduceRemove, reduceResolve } from './store-admin.js'
import { clearClaim, reduceClaim, reduceReleaseClaim } from './claim.js'
import { nudgeIfChanged } from './nudge.js'
export type { Reminder, Repeat } from './reminder-model.js'
import {
  dispatchMetricsOf, pendingDispatchesOf, reduceBumpPending, reduceClearPending, reduceMarkSent,
  reduceSetPending, sentForRound,
} from './sent-marker.js'

/** 读失败的现场（sidecar 里也存一份）。 */
export interface ReadFailure {
  at: number
  reason: 'unreadable' | 'permission'
  source: string
  detail: string
}

export interface LoadReport {
  status: 'loaded' | 'missing' | 'locked'
  loaded: number
  failure?: ReadFailure
  issues?: readonly ValidationIssue[]
}

/** 一个提醒文件只允许一个活跃 Store（内存状态不同，只共用队列不够）。 */
const OWNERS = new Map<string, ReminderStore>()

/** 宿主侧给的最小上下文；`workspacePath` 允许为 `null`（那时退回 `dshHome`）。 */
type StoreHostContext = { workspacePath: string | null; dshHome: string; log: (line: string) => void }
const storeOptions = (host: StoreHostContext): StoreHostContext => host

export class ReminderStore {
  private readonly io: ReminderPersistence
  private readonly queue = new SerialQueue()
  private readonly log: (line: string) => void
  private readonly ownerKey: string
  /** 演练模式（`config.reminders.dryRun !== false`）：认领类写**整笔不发生**（见 `claim()`）。 */
  private readonly dryRun: boolean
  private state: StoreState | null = null
  private lock: ReadFailure | null = null
  private issues: readonly ValidationIssue[] = []
  private report: LoadReport = { status: 'missing', loaded: 0 }

  constructor(
    config: QQChannelConfig['reminders'],
    host: StoreHostContext,
    persistence?: ReminderPersistence,
  ) {
    const opts = storeOptions(host)
    // **路径必须与老代码逐字一致**：`workspacePath` 为 null 时落到 `<dshHome>/channel-qq`。
    // 生产 `plugins/dsh-channel-qq/cordis.patch.yml:23` 就是 `workspacePath: null`，
    // 真实文件在 `home/channel-qq/reminders.json` —— 这里差一个字，既有提醒就全部读不到。
    const base = opts.workspacePath ?? path.join(opts.dshHome, 'channel-qq')
    const configured = config.file
    const file = configured === null || configured === undefined
      ? path.join(base, 'reminders.json')
      : (path.isAbsolute(configured) ? configured : path.join(base, configured))
    this.log = opts.log
    this.dryRun = config.dryRun !== false
    this.io = persistence ?? new ReminderFile(file, this.log)
    this.ownerKey = path.resolve(file)
    const existing = OWNERS.get(this.ownerKey)
    if (existing !== undefined && existing !== this) {
      throw storeFault('OWNER_CONFLICT', 'constructor', `同一个提醒文件已有活跃 Store：${this.ownerKey}`)
    }
    OWNERS.set(this.ownerKey, this)
  }

  get file(): string { return this.ownerKey }

  // ── 事务入口 ─────────────────────────────────────────────────────────────

  private async edit<T>(operation: string, reducer: (draft: Reminder[]) => Edit<T>): Promise<Mutation<T>> {
    // **task-66（真 bug 修复）**：锁定检查必须在这里——以前只有 `add()` 查，于是
    // `resolve`/`pruneFired`/`remove`/`markSent` 在只读锁下**照样改内存**（R11-1/R11-2/R12-6 抓到的就是这个）。
    this.assertWritable(operation)
    return await transact<T>({
      queue: this.queue,
      state: () => this.state,
      publish: (next) => { this.state = next },
      persistence: this.io,
    }, operation, reducer)
  }

  private assertWritable(operation: string): void {
    if (this.lock !== null) {
      // 拒绝写入**必须留痕**：用户看到的是"点了没生效"，日志里不能什么都没有。
    // 只记 operation 与原因（提醒正文是隐私，日志会被贴进 issue）。
    this.log(`reminders: 写入被拒绝（${operation}）：读失败锁生效${this.lock?.reason ?? 'unknown'} —— 存储处于只读锁定`)
    throw storeFault('READ_LOCKED', operation,
        `提醒存储处于只读锁定（${this.lock.reason}：${this.lock.detail}）；先修好文件再 clearReadLock()`)
    }
  }

  // ── 加载 / 恢复 ──────────────────────────────────────────────────────────

  /** 初始化（同一队列）。**重复调用返回当前报告**，不当作隐式重载或解锁入口。 */
  async load(): Promise<LoadReport> {
    if (this.state !== null || this.lock !== null) return this.report
    return await this.queue.run('load', async () => {
      const marker = await this.io.readMarker()
      const read = await this.io.readOnce()
      if (read.kind === 'missing') {
        this.state = deepFreeze({ items: [] as Reminder[] })
        this.lock = marker === null ? null : { ...marker, reason: marker.reason === 'permission' ? 'permission' : 'unreadable' }
        this.report = { status: this.lock === null ? 'missing' : 'locked', loaded: 0, ...(this.lock === null ? {} : { failure: this.lock }) }
        if (this.lock === null) this.log('reminders: 盘上还没有提醒文件（新装）→ 空表起步、可写；**不在启动时创建**')
        return this.report
      }
      if (read.kind === 'failed') {
        this.lock = read.failure as ReadFailure
        this.state = deepFreeze({ items: [] as Reminder[] })
        await this.io.writeMarker(this.lock)
        this.report = { status: 'locked', loaded: 0, failure: this.lock }
        this.log(`reminders: 提醒文件读不出来（${this.lock.reason}：${this.lock.detail}）→ **锁定所有写入（只读）**，不重建主文件；`
          + `现场保留，故障记在 ${this.ownerKey}.readonly.json`)
        return this.report
      }
      const decoded = decodeReminderFile(read.raw)
      if (!decoded.ok) {
        this.issues = decoded.issues
        this.lock = { at: Date.now(), reason: 'unreadable', source: this.ownerKey, detail: `结构不合法：${decoded.issues[0]?.path ?? ''} ${decoded.issues[0]?.message ?? ''}` }
        this.state = deepFreeze({ items: [] as Reminder[] })
        await this.io.writeMarker(this.lock)
        this.report = { status: 'locked', loaded: 0, failure: this.lock, issues: decoded.issues }
        this.log(`reminders: 提醒文件结构不合法（${String(decoded.issues.length)} 处，首处 ${decoded.issues[0]?.path ?? ''}）→ **锁定所有写入（只读）**，不重建主文件`)
        return this.report
      }
      this.state = deepFreeze({ items: decoded.items })
      this.lock = marker === null ? null : { ...marker, reason: marker.reason === 'permission' ? 'permission' : 'unreadable' }
      this.report = { status: this.lock === null ? 'loaded' : 'locked', loaded: decoded.items.length, ...(this.lock === null ? {} : { failure: this.lock }) }
      this.log(`reminders: loaded ${String(decoded.items.length)} item(s)`)
      return this.report
    })
  }

  /**
   * **恢复**（同一队列）：单次读 + 完整解码 → 删 sidecar → **同步发布**。
   *
   * 文件不存在**默认拒绝**（防"误删文件后一恢复就把数据清空"）；要解释成空表必须显式传
   * `{ allowMissingAsEmpty: true }`。坏结构/坏行/读失败 ⇒ 旧状态与锁都不动。
   */
  async clearReadLock(options: { allowMissingAsEmpty?: boolean } = {}): Promise<RecoveryReport> {
    return await this.queue.run('clearReadLock', async () => {
      if (this.lock === null) throw storeFault('RECOVERY_INVALID', 'clearReadLock', '当前没有锁定，无需恢复')
      const read = await this.io.readOnce()
      if (read.kind === 'failed') {
        throw storeFault('RECOVERY_READ_FAILED', 'clearReadLock', `文件仍然读不出来：${read.failure.detail}`)
      }
      if (read.kind === 'missing' && options.allowMissingAsEmpty !== true) {
        throw storeFault('RECOVERY_INVALID', 'clearReadLock', '文件不存在：默认拒绝恢复（确需清空请传 { allowMissingAsEmpty: true }）')
      }
      const decoded = read.kind === 'missing' ? { ok: true as const, items: [] as Reminder[], notes: [] } : decodeReminderFile(read.raw)
      if (!decoded.ok) {
        throw storeFault('RECOVERY_INVALID', 'clearReadLock',
          `结构不合法（${String(decoded.issues.length)} 处，首处 ${decoded.issues[0]?.path ?? ''}）：拒绝恢复`)
      }
      const previous = this.state?.items ?? []
      const next = deepFreeze({ items: decoded.items })
      const report = diffOf(previous, next.items)
      await this.io.removeMarker()
      // 删 marker 成功之后才发布（删不掉 ⇒ 保持旧状态与锁）。
      this.state = next
      this.lock = null
      this.report = { status: 'loaded', loaded: next.items.length }
      this.log(`reminders: 已恢复并解锁（${String(report.loaded)} 条；removed ${String(report.removed.length)}、replaced ${String(report.replaced.length)}、added ${String(report.added.length)}）`)
      return report
    })
  }

  // ── 状态自省 ─────────────────────────────────────────────────────────────

  isReadLocked(): boolean { return this.lock !== null }
  readFailure(): ReadFailure | null { return this.lock }
  validationIssues(): readonly ValidationIssue[] { return this.issues }
  lastReport(): LoadReport { return this.report }

  // ── 业务变更（全部进事务） ───────────────────────────────────────────────

  async add(input: AddInput): Promise<Mutation<Reminder>> {
    this.assertWritable('add')
    const mutation = await this.edit('add', (draft) => {
      const item = buildReminder(input)
      if (draft.some((row) => row.id === item.id)) return { kind: 'reject', code: 'INVALID_INPUT', message: 'id 冲突' }
      draft.push(item)
      return { kind: 'changed', value: item }
    })
    // **立刻重排定时器**（2026-11-10）：见 `nudge.ts::nudgeIfChanged`（含"为什么必须挂在写入侧"）。
    nudgeIfChanged(mutation, 'add')
    return mutation
  }

  remove(id: string): Promise<Mutation<boolean>> {
    return this.edit('remove', (draft) => reduceRemove(draft, id)).then((mutation) => {
      // 删掉的也许正是"下一次要醒来的那一条" ⇒ 也重排（否则会为一个不存在的时刻白醒）。
      nudgeIfChanged(mutation, 'remove')
      return mutation
    })
  }

  resolve(id: string, outcome: 'confirmed' | 'failed'): Promise<Mutation<Reminder>> {
    return this.edit('resolve', (draft) => reduceResolve(draft, id, outcome)).then((mutation) => {
      // 人工收敛成 `failed` ⇒ 这条重新变成"可投递"，立刻一拍（否则要等心跳）。
      if (outcome === 'failed') nudgeIfChanged(mutation, 'resolve-failed')
      return mutation
    })
  }

  pruneFired(now = Date.now(), keepMs = 7 * 86_400_000): Promise<Mutation<Reminder[]>> {
    return this.edit('pruneFired', (draft) => reducePruneFired(draft, now, keepMs))
  }

  markUnknown(id: string, reason: string, now = Date.now()): Promise<Mutation<Reminder>> {
    return this.edit('markUnknown', (draft) => reduceMarkUnknown(draft, id, reason, now))
  }

  skipRound(id: string, now = Date.now()): Promise<Mutation<Reminder>> {
    return this.edit('skipRound', (draft) => reduceSkipRound(draft, id, now))
  }

  expireStale(now = Date.now()): Promise<Mutation<Reminder[]>> {
    return this.edit('expireStale', (draft) => reduceExpireStale(draft, now))
  }

  capBacklog(now = Date.now()): Promise<Mutation<Reminder[]>> {
    return this.edit('capBacklog', (draft) => reduceCapBacklog(draft, now))
  }

  markFired(id: string, now = Date.now()): Promise<Mutation<Reminder>> {
    return this.edit('markFired', (draft) => {
      const item = draft.find((row) => row.id === id)
      if (item === undefined) return { kind: 'reject', code: 'NOT_FOUND', message: `没有 id=${id} 的提醒` }
      if (item.repeat === 'none') {
        item.fired = true
        item.firedAt = now
      } else {
        item.at = nextRoundAt(item, now)
        item.fired = false
        item.firedAt = now
      }
      delete item.sentFor
      delete item.sentAt
      // 一轮结束了 ⇒ 放掉认领（否则要等 TTL 过期，周期提醒的下一轮会被自己的旧认领挡住）。
      clearClaim(item)
      return { kind: 'changed', value: { ...item } }
    })
  }

  markFiredRebound(id: string, occurrence: { id: string; revision: number } | null, now = Date.now()): Promise<Mutation<Reminder>> {
    return this.edit('markFiredRebound', (draft) => {
      const item = draft.find((row) => row.id === id)
      if (item === undefined) return { kind: 'reject', code: 'NOT_FOUND', message: `没有 id=${id} 的提醒` }
      item.at = nextRoundAt(item, now)
      item.fired = false
      item.firedAt = now
      delete item.sentFor
      delete item.sentAt
      if (occurrence === null) delete item.occurrence
      else item.occurrence = { ...occurrence }
      clearClaim(item)
      return { kind: 'changed', value: { ...item } }
    })
  }

  // ── 原子领取（2026-11-10：多 worker / 多次扫描只发一次） ─────────────────
  // 语义、四态、为什么"过期不重发"全在 `claim.ts`。这里只强调一条：**演练下这三笔写整个不发生**
  //（返回 `changed:false`）——"dryRun 全程零写入"是硬不变量，不能依赖调用方记得传探针。

  /** **领一次**（落盘一次事务：读-判-写原子完成）。业务拒绝 `STALE_STATE` = 别人在发，不是故障。 */
  claim(id: string, owner: string, now = Date.now(), ttlMs?: number): Promise<Mutation<Reminder>> {
    if (this.dryRun) return Promise.resolve(this.dryRunSkip(id, 'claim'))
    return this.edit('claim', (draft) => reduceClaim(draft, id, owner, now, ttlMs))
  }

  /** **放回**：`skipped` / `dry-run` 之后立刻调用，让这条下一拍还能被领。 */
  releaseClaim(id: string): Promise<Mutation<Reminder>> {
    if (this.dryRun) return Promise.resolve(this.dryRunSkip(id, 'releaseClaim'))
    return this.edit('releaseClaim', (draft) => reduceReleaseClaim(draft, id))
  }

  /** **收敛过期认领**：盘上分不清"发之前崩"还是"发之后崩" ⇒ 按 `unknown` 收（不重试）。 */
  resolveStaleClaim(id: string, now = Date.now()): Promise<Mutation<Reminder>> {
    if (this.dryRun) return Promise.resolve(this.dryRunSkip(id, 'resolveStaleClaim'))
    return this.edit('resolveStaleClaim', (draft) => reduceMarkUnknown(draft, id, 'claim-expired:unknown', now))
  }

  /** 演练下的"认领类写"：**不写盘**，返回当前行（`changed:false`）。 */
  private dryRunSkip(id: string, operation: string): Mutation<Reminder> {
    const item = this.rows().find((row) => row.id === id)
    this.log(`reminders: 演练模式不落盘：跳过 ${operation}（${id}）`)
    if (item === undefined) return { ok: false, code: 'NOT_FOUND', message: `没有 id=${id} 的提醒` }
    return { ok: true, changed: false, value: { ...item } }
  }

  markSent(id: string, forAt: number): Promise<Mutation<Reminder>> {
    return this.edit('markSent', (draft) => reduceMarkSent(draft, id, forAt))
  }

  setPendingDispatch(id: string, payload: { occurrenceId: string; revision: number; at: number }): Promise<Mutation<Reminder>> {
    return this.edit('setPendingDispatch', (draft) => reduceSetPending(draft, id, payload))
  }

  clearPendingDispatch(id: string): Promise<Mutation<boolean>> {
    return this.edit('clearPendingDispatch', (draft) => reduceClearPending(draft, id))
  }

  bumpPendingDispatch(id: string): Promise<Mutation<{ attempts: number; abandoned: boolean }>> {
    return this.edit('bumpPendingDispatch', (draft) => reduceBumpPending(draft, id))
  }

  // ── 查询（不排队；返回冻结对象） ─────────────────────────────────────────

  private rows(): readonly Reminder[] { return this.state?.items ?? [] }

  list(limit = 50): Reminder[] {
    return this.rows().map((row) => ({ ...row }))
      .sort((a, b) => (Number(a.fired) - Number(b.fired)) || (a.at - b.at))
      .slice(0, Math.max(0, limit))
  }

  due(now = Date.now()): Reminder[] { return dueOf(this.rows(), now).map((row) => ({ ...row })) }
  missedRounds(now = Date.now()): Reminder[] { return missedRoundsOf(this.rows(), now).map((row) => ({ ...row })) }
  readonly catchUpWindowMs = CATCH_UP_WINDOW_MS
  catchUpDiagnostics(now = Date.now()): ReturnType<typeof catchUpMetricsOf> { return catchUpMetricsOf(this.rows(), now) }
  droppedItems(limit = DROPPED_ITEMS_LIMIT): ReturnType<typeof droppedItemsOf> { return droppedItemsOf(this.rows(), limit) }
  sentForRound(id: string, forAt: number): boolean { return sentForRound(this.rows().find((row) => row.id === id), forAt) }
  pendingDispatches(): Reminder[] { return pendingDispatchesOf(this.rows()).map((row) => ({ ...row })) }
  dispatchDiagnostics(now = Date.now()): { value: number; oldestAgeMs: number; overLimit: number } {
    return dispatchMetricsOf(this.rows(), now)
  }

  /** 还在跑的事务数（给卸载排空用）。 */
  queueSize(): number { return this.queue.size }

  /** 关停：拒绝新写入并**排空**已受理的事务（没有"卸载补存"这回事）。 */
  async close(): Promise<void> {
    this.queue.close()
    // **顺序是设计的不变量**：先关队列 → **排空** → 才释放注册表。
    // 反过来（先释放再排空）会让"旧实例还在写、新实例已经建起来写同一文件"——
    // 那是**静默双写**，比 `OWNER_CONFLICT` 明确拒绝糟得多。
    // 测试侧必须 `await store.close()`；rig 助手要 async，不能靠 `void close()`。
    try {
      await this.queue.drain()
    } finally {
      if (OWNERS.get(this.ownerKey) === this) OWNERS.delete(this.ownerKey)
    }
  }
}

function nextRoundAt(item: Reminder, now: number): number {
  const step = item.repeat === 'daily' ? 86_400_000 : 7 * 86_400_000
  let next = item.at
  do { next += step } while (next <= now)
  return next
}

/** 恢复报告：**完整内容**比较（同 id 内容变化要算 `replaced`，不能只按 id 存在性计数）。 */
function diffOf(before: readonly Reminder[], after: readonly Reminder[]): RecoveryReport {
  const beforeById = new Map(before.map((row) => [row.id, row]))
  const afterById = new Map(after.map((row) => [row.id, row]))
  const removed = before.filter((row) => !afterById.has(row.id))
  const added = after.filter((row) => !beforeById.has(row.id))
  const replaced = after
    .filter((row) => beforeById.has(row.id) && JSON.stringify(beforeById.get(row.id)) !== JSON.stringify(row))
    .map((row) => ({ before: beforeById.get(row.id) as Reminder, after: row }))
  return { loaded: after.length, removed, replaced, added }
}

export { toMutation }
export type { Mutation, ReminderStoreFault }
