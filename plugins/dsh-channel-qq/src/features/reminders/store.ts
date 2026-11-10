/**
 * **ReminderStore**（task-66 起按设计重写）：所有变更都走
 * `store-transaction.ts` 的事务——串行队列 + copy-on-write + 写盘成功后发布。
 *
 * 对外三条规矩：① **业务拒绝**回 `{ ok:false, code, message }`（没改状态、没写盘）；
 * ② **基础设施故障**（锁定 / 保存失败 / 队列满 / 重入 / 关闭）⇒ **reject**；③ **查询不排队**，
 * 读最近一次已发布的**冻结**快照（写盘期间看到旧状态是允许的）。
 *
 * **第二轮 P1-A**：写事务外面套了一把**跨进程写锁**（`adapters/fs-store/process-lock.ts`），
 * 事务基线改成**锁内重读的磁盘内容**。改之前两个独立进程可以各自读到 `claim=null`、
 * 各自写 claim、各自发送——盘上最终只剩一个 claim，但两条消息都发出去了。
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
import type {
  Edit, Mutation, ProcessMutex, RecoveryReport, ReminderPersistence, StoreState, ValidationIssue,
} from './store-contract.js'
import { ReminderStoreFault, storeFault } from './store-contract.js'
import { deepFreeze } from './store-freeze.js'
import { ReminderFile } from './store-io.js'
import { SqliteProcessMutex, processLockAvailable } from '../../adapters/fs-store/process-lock.js'
import { reduceMarkUnknown, reducePruneFired, reduceRemove, reduceResolve } from './store-admin.js'
import { reduceMarkFired, reduceMarkFiredRebound } from './store-rounds.js'
import { reduceClaim, reduceReleaseClaim, reduceRenewClaim, reduceResolveStaleClaim } from './claim.js'
import type { ClaimExpectation, StaleClaimExpectation } from './claim.js'
import { nudgeIfChanged } from './nudge.js'
import type { LoadReport, ReadFailure, StoreIo } from './store-boot.js'
import { loadFromDisk, recoverFromDisk } from './store-boot.js'
export type { Reminder, Repeat } from './reminder-model.js'
import {
  dispatchMetricsOf, pendingDispatchesOf, reduceBumpPending, reduceClearPending, reduceMarkSent,
  reduceSetPending, sentForRound,
} from './sent-marker.js'

/** `ReadFailure` / `LoadReport` 的形状住在 `store-boot.ts`（加载流程那边才是它们的家）。 */
export type { ReadFailure, LoadReport } from './store-boot.js'

/** 一个提醒文件只允许一个活跃 Store（内存状态不同，只共用队列不够）。 */
const OWNERS = new Map<string, ReminderStore>()

/** 宿主侧给的最小上下文；`workspacePath` 允许为 `null`（那时退回 `dshHome`）。 */
type StoreHostContext = { workspacePath: string | null; dshHome: string; log: (line: string) => void }
const storeOptions = (host: StoreHostContext): StoreHostContext => host

/**
 * 本进程的**写入模型**（诊断面必须如实说，不许"看起来支持多进程"）：
 *
 * - `cross-process-lock`：所有写事务过同一把内核级锁（正常路径）；
 * - `unavailable`：本运行时**根本没有**可用的跨进程锁（`node:sqlite` 缺失等）⇒ **拒绝写入**
 *   （fail-closed）。这是**不自愈**的装配故障，不是"竞争激烈"；
 * - `in-process-only`：**调用方明确**传入 `mutex: null` 才可能出现（测试替身 / 明确的单进程
 *   兼容路径）。生产构造**永远不会**自动落到这一档——那等于偷偷把"防重复外发"关掉。
 */
export type WriteModel = 'cross-process-lock' | 'unavailable' | 'in-process-only'

export class ReminderStore {
  private readonly io: ReminderPersistence
  private readonly queue = new SerialQueue()
  private readonly log: (line: string) => void
  private readonly ownerKey: string
  /** 演练模式（`config.reminders.dryRun !== false`）：认领类写**整笔不发生**（见 `claim()`）。 */
  private readonly dryRun: boolean
  /** **跨进程写锁**（第二轮 P1-A）。`null` = 调用方明确要求的单进程语义（见 `writeModel`）。 */
  private readonly mutex: ProcessMutex | null
  /** 写入模型。构造时定死，运行期不变（能力不会自己长出来）。 */
  private readonly model: WriteModel
  private state: StoreState | null = null
  private lock: ReadFailure | null = null
  private issues: readonly ValidationIssue[] = []
  private report: LoadReport = { status: 'missing', loaded: 0 }

  constructor(
    config: QQChannelConfig['reminders'],
    host: StoreHostContext,
    persistence?: ReminderPersistence,
    mutex?: ProcessMutex | null,
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
    // 锁文件与提醒文件**同目录同前缀**：同一个 `dataDir` 一定是同一把锁，不用再传参数。
    this.mutex = mutex === undefined ? new SqliteProcessMutex(file, this.log) : mutex
    // **不许静默降级**（第三轮 P2）：只有"调用方显式给了 null"才允许单进程语义；
    // 否则先探一次能力——探不到就是 `unavailable`，写事务一律拒绝（详见 `assertLockUsable`）。
    this.model = this.mutex === null
      ? 'in-process-only'
      : (processLockAvailable() ? 'cross-process-lock' : 'unavailable')
    this.ownerKey = path.resolve(file)
    const existing = OWNERS.get(this.ownerKey)
    if (existing !== undefined && existing !== this) {
      throw storeFault('OWNER_CONFLICT', 'constructor', `同一个提醒文件已有活跃 Store：${this.ownerKey}`)
    }
    if (this.model === 'unavailable') {
      // **启动即说清楚**：这台机器永远写不了提醒，别等到第一次写才炸得莫名其妙。
      this.log('reminders: **本运行时没有可用的跨进程写锁**（node:sqlite 缺失）→ 提醒写入将一律被拒绝（fail-closed）。'
        + '不自动降级成"无锁写入"：那会重复外发。要恢复请装回完整 Node 运行时。')
    }
    OWNERS.set(this.ownerKey, this)
  }

  get file(): string { return this.ownerKey }

  /** 写入模型（诊断面/测试都读它，见 `WriteModel` 三档语义）。 */
  writeModel(): WriteModel {
    return this.model
  }

  // ── 事务入口 ─────────────────────────────────────────────────────────────

  private async edit<T>(operation: string, reducer: (draft: Reminder[]) => Edit<T>): Promise<Mutation<T>> {
    // **task-66（真 bug 修复）**：锁定检查必须在这里——以前只有 `add()` 查，于是
    // `resolve`/`pruneFired`/`remove`/`markSent` 在只读锁下**照样改内存**（R11-1/R11-2/R12-6 抓到的就是这个）。
    this.assertWritable(operation)
    // **fail-closed（第三轮 P2）**：没有可用的跨进程锁就一个字都不写。放在这里而不是只靠适配器，
    // 是因为"能力不可用"是装配事实，早拒比让 20 个写方法各自撞一遍更可诊断。
    if (this.model === 'unavailable') {
      throw storeFault('LOCK_UNAVAILABLE', operation,
        '本运行时没有可用的跨进程写锁（node:sqlite 缺失）：拒绝在无锁状态下写入')
    }
    return await transact<T>({
      queue: this.queue,
      state: () => this.state,
      publish: (next) => { this.state = next },
      persistence: this.io,
      mutex: this.mutex === null ? undefined : this.mutex,
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

  /** `loadFromDisk()` / `recoverFromDisk()` 需要的最小上下文（见 `store-boot.ts`）。 */
  private bootIo(): StoreIo {
    return {
      ownerKey: this.ownerKey,
      log: this.log,
      readRaw: async () => {
        const read = await this.io.readOnce()
        if (read.kind === 'present') return { kind: 'present', raw: read.raw }
        if (read.kind === 'missing') return { kind: 'missing' }
        return { kind: 'failed', failure: read.failure as ReadFailure }
      },
      readMarker: async () => await this.io.readMarker(),
      writeMarker: async (failure) => { await this.io.writeMarker(failure) },
      removeMarker: async () => { await this.io.removeMarker() },
      current: () => this.state?.items ?? [],
      publish: (items) => { this.state = deepFreeze({ items }) },
    }
  }

  /** 初始化（同一队列）。**重复调用返回当前报告**，不当作隐式重载或解锁入口。 */
  async load(): Promise<LoadReport> {
    if (this.state !== null || this.lock !== null) return this.report
    return await this.queue.run('load', async () => {
      const report = await loadFromDisk(this.bootIo())
      // `loadFromDisk` 的 `failure` 就是"要不要锁定"的唯一判据（三档：新装/正常/锁定）。
      this.lock = report.failure ?? null
      this.issues = report.issues ?? []
      this.report = report
      return report
    })
  }

  /**
   * **恢复**（同一队列）：流程在 `store-boot.ts::recoverFromDisk`（单次读 + 完整解码 →
   * 删 sidecar → 同步发布）。文件不存在**默认拒绝**；坏结构/坏行/读失败 ⇒ 旧状态与锁都不动。
   */
  async clearReadLock(options: { allowMissingAsEmpty?: boolean } = {}): Promise<RecoveryReport> {
    return await this.queue.run('clearReadLock', async () => {
      const report = await recoverFromDisk(this.bootIo(), this.lock !== null, options)
      // **发布之后才解锁**：`recoverFromDisk` 已经在删 sidecar 成功之后 publish 过了，
      // 这里补的是"锁与报告"这一半——顺序仍是"先状态、后解锁"。
      this.lock = null
      this.report = { status: 'loaded', loaded: report.loaded }
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
    return this.edit('markFired', (draft) => reduceMarkFired(draft, id, now))
  }

  markFiredRebound(id: string, occurrence: { id: string; revision: number } | null, now = Date.now()): Promise<Mutation<Reminder>> {
    return this.edit('markFiredRebound', (draft) => reduceMarkFiredRebound(draft, id, occurrence, now))
  }

  // ── 原子领取（2026-11-10 第二轮；快照 CAS 是第三轮补的） ────────────────────
  // 语义、四态、为什么"过期不重发"全在 `claim.ts`。这里只强调两条纪律：
  //   ① **演练下这四笔写整个不发生**（返回 `changed:false`）——"dryRun 全程零写入"是硬不变量，
  //      不能依赖调用方记得传探针；
  //   ② `expect` / `expectStale` 是**锁内 CAS 的预期值**：reducer 拿到的是锁内重读的磁盘草稿，
  //      与预期不符就回 `STALE_STATE`、不写盘。不给预期时退化成第一轮语义，**只为兼容旧调用点**。

  /** **领一次**（一次事务：读-判-写）。成功时 `value` 是**锁内最新那一行**，调用方必须用它继续投递。 */
  claim(id: string, owner: string, now = Date.now(), ttlMs?: number, expect?: ClaimExpectation): Promise<Mutation<Reminder>> {
    if (this.dryRun) return Promise.resolve(this.dryRunSkip(id, 'claim'))
    return this.edit('claim', (draft) => reduceClaim(draft, id, owner, now, ttlMs, expect))
  }

  /** **放回**（`skipped` / `dry-run` 之后）。带 `owner` 就只放自己的：替别人放回等于让对方重发一遍。 */
  releaseClaim(id: string, owner?: string): Promise<Mutation<Reminder>> {
    if (this.dryRun) return Promise.resolve(this.dryRunSkip(id, 'releaseClaim'))
    return this.edit('releaseClaim', (draft) => reduceReleaseClaim(draft, id, owner))
  }

  /**
   * **续租**：发送比 TTL 还慢时把到期间往后推。只有当前认领者能续（`by` 对不上 ⇒ `STALE_STATE`）。
   * 续租失败**不算发送失败**：消息可能已经发出去了，调用方只记日志、不当成"没发"。
   */
  renewClaim(id: string, owner: string, now = Date.now(), ttlMs?: number): Promise<Mutation<Reminder>> {
    if (this.dryRun) return Promise.resolve(this.dryRunSkip(id, 'renewClaim'))
    return this.edit('renewClaim', (draft) => reduceRenewClaim(draft, id, owner, now, ttlMs))
  }

  /** **收敛过期认领**（`unknown`，不重试）。`expect` 让"我看到的过期"必须等于"锁内看到的过期"。 */
  resolveStaleClaim(id: string, now = Date.now(), expect?: StaleClaimExpectation): Promise<Mutation<Reminder>> {
    if (this.dryRun) return Promise.resolve(this.dryRunSkip(id, 'resolveStaleClaim'))
    if (expect === undefined) {
      return this.edit('resolveStaleClaim', (draft) => reduceMarkUnknown(draft, id, 'claim-expired:unknown', now))
    }
    return this.edit('resolveStaleClaim', (draft) => reduceResolveStaleClaim(draft, id, expect, now))
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
    // **顺序是设计的不变量**：先关队列 → **排空** → 才释放注册表与跨进程锁。
    // 反过来（先释放再排空）会让"旧实例还在写、新实例已经建起来写同一文件"——
    // 那是**静默双写**，比 `OWNER_CONFLICT` 明确拒绝糟得多。测试侧必须 `await store.close()`。
    try {
      await this.queue.drain()
    } finally {
      // 锁最后关：排空之后已无在途事务（锁本身是"每次 acquire 一个事务"，这里只拒绝后续 acquire）。
      this.mutex?.close()
      if (OWNERS.get(this.ownerKey) === this) OWNERS.delete(this.ownerKey)
    }
  }
}

/** 恢复报告的比较搬到 `store-recovery.ts`（`store.ts` 要守 400 行硬上限）。 */
export { toMutation }
export type { Mutation, ReminderStoreFault }
