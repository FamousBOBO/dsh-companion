/**
 * **事务级串行化 + copy-on-write + 提交后发布**（设计 §1.4/§1.5；第二轮 P1-A 加入跨进程锁）。
 *
 * 固定的六步，**没有"回滚"**：
 * 进队列 → **抢跨进程写锁** → **锁内重读盘上最新状态当基线** → 同步 reducer 改草稿 →
 * 校验/冻结/序列化（所有可能失败的事都在写盘前）→ 唯一写出口落盘（rename 成功 = 提交点）
 * → 提交后**不再 await**，同步发布新不可变引用 → 释放锁。
 *
 * ## 第二轮为什么要动这里
 *
 * 第一轮只有 `claim` 字段，互斥全靠**进程内**的 `SerialQueue` + `OWNERS` 那个 Map。
 * 两个独立进程各自 `load()` 到 `claim=null`、各自写 `claim`、各自 rename：
 * 盘上最后只剩一个 claim，但**两条 QQ 消息都已经发出去了**。磁盘上的最终状态
 * 不能证明"只发了一次"。
 *
 * 现在写事务的基线**不再是本进程内存快照**，而是**锁内重读的磁盘内容**：
 * 进程 A 认领并写盘后，进程 B 拿到锁重读时看到的已经是 `claim=<A>`，
 * 它的 reducer 于是拒绝（`STALE_STATE`）——这才是"同一轮只有一个发送者"。
 *
 * ## 为什么写盘失败就把草稿丢掉
 *
 * 已发布状态从未改变，所以"失败撤销别人的成功"这类事故在结构上不存在。
 * 反过来，**锁内重读到坏数据**时也直接失败（`REFRESH_FAILED`）：绝不许拿旧快照硬写，
 * 那会把对方刚写的 claim 覆盖掉。
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { deepFreeze } from './store-freeze.js'
import type { Edit, Mutation, MutexLease, ReminderPersistence, StoreState, ProcessMutex } from './store-contract.js'
import { storeFault } from './store-contract.js'
import { decodeReminderFile, serializeV1 } from './store-load.js'
import type { Reminder } from './reminder-model.js'

export const QUEUE_LIMIT = 256

/** 串行队列：tail 链 + 未完成计数 + 重入检测；失败不毒化队列。 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve()
  private outstanding = 0
  private accepting = true
  private readonly scope = new AsyncLocalStorage<{ active: true }>()

  get size(): number { return this.outstanding }
  get isAccepting(): boolean { return this.accepting }

  run<T>(operation: string, job: () => Promise<T>): Promise<T> {
    if (this.scope.getStore() !== undefined) {
      return Promise.reject(storeFault('REENTRANT', operation, '同一事务里又调了存储操作（事务内只许用同步 reducer）'))
    }
    if (!this.accepting) return Promise.reject(storeFault('CLOSED', operation, '存储已关闭，不再受理写入'))
    if (this.outstanding >= QUEUE_LIMIT) {
      return Promise.reject(storeFault('QUEUE_FULL', operation, `未完成操作已达上限 ${String(QUEUE_LIMIT)}`))
    }
    this.outstanding += 1
    const run = this.tail.then(async () => await this.scope.run({ active: true }, job))
    this.tail = run.then(() => undefined, () => undefined)
    return run.finally(() => { this.outstanding -= 1 })
  }

  /**
   * 关闭受理入口（已入队的事务照常跑完）。
   * **调用方必须 `close()` 之后再 `await drain()`** —— 只 `close()` 不会等待在跑的写。
   */
  close(): void { this.accepting = false }
  async drain(): Promise<void> { await this.tail }
}

export interface TxContext {
  queue: SerialQueue
  state: () => StoreState | null
  publish: (state: StoreState) => void
  persistence: ReminderPersistence
  /**
   * **跨进程写锁**（第二轮 P1-A）。给了就必须拿到锁才写；`undefined` = 本次部署不支持
   * 跨进程写（退化，调用方在日志里说明）。
   */
  mutex?: ProcessMutex
  /** 抢锁超时（毫秒）。 */
  lockTimeoutMs?: number
}

/** 业务结果/失败契约转换（只有真正"业务拒绝"才回 `ok:false`）。 */
export function toMutation<T>(edit: Edit<T>): Mutation<T> {
  if (edit.kind === 'reject') return { ok: false, code: edit.code, message: edit.message }
  return { ok: true, changed: edit.kind === 'changed', value: edit.value }
}

/** 校验候选：整体能被解码器接受，且行数不丢（防止 reducer 造出坏行）。 */
function validateCandidateOrThrow(items: readonly Reminder[], operation: string): void {
  const decoded = decodeReminderFile(items)
  if (!decoded.ok) {
    throw storeFault('INVALID_CANDIDATE', operation, `候选状态不合法（reducer 写了坏行，不会写盘）：${decoded.issues[0]?.path ?? ''} ${decoded.issues[0]?.message ?? ''}`)
  }
}

/**
 * **锁内基线**（第二轮 P1-A）：重新读盘，读不到就失败。
 *
 * 三种情况分开处理：
 *   - `missing` ⇒ **空表**。规则与首轮 `load()` 一致（新装不重建文件）；
 *     但注意：`load()` 之后被别人删了文件也会走到这里——那按空表继续写是唯一合理选择
 *     （否则一次误删就永久卡住），并且会照常把新内容落盘。
 *   - `failed` ⇒ `REFRESH_FAILED`（**不许**拿旧快照硬写）。
 *   - 解码不合法 ⇒ `REFRESH_FAILED`（同上；也不在这里写只读锁，那是 `load()` 的职责）。
 */
export async function readBaseline(
  persistence: ReminderPersistence,
  operation: string,
): Promise<readonly Reminder[]> {
  const read = await persistence.readOnce()
  if (read.kind === 'missing') return []
  if (read.kind === 'failed') {
    throw storeFault('REFRESH_FAILED', operation,
      `锁内重读盘上状态失败（${read.failure.reason}：${read.failure.detail}）：不许拿旧内存快照继续写`)
  }
  const decoded = decodeReminderFile(read.raw)
  if (!decoded.ok) {
    throw storeFault('REFRESH_FAILED', operation,
      `锁内重读到的状态不合法（首处 ${decoded.issues[0]?.path ?? ''} ${decoded.issues[0]?.message ?? ''}）：不许拿旧内存快照继续写`)
  }
  return decoded.items
}

/**
 * 跑一笔事务。`edit` 必须是**同步**函数：只许改草稿，不许 I/O、不许调本 store 的其它方法。
 *
 * `edit` 收到的草稿**来自锁内重读的磁盘内容**（不是本进程内存），这一点是第二轮的不变量：
 * 两个进程同时改同一条时，后拿到锁的那个看到的是前一个的结果。
 */
export async function transact<T>(
  ctx: TxContext,
  operation: string,
  edit: (draft: Reminder[]) => Edit<T>,
): Promise<Mutation<T>> {
  return await ctx.queue.run(operation, async () => {
    const loaded = ctx.state()
    if (loaded === null) throw storeFault('NOT_LOADED', operation, '存储还没 load()，拒绝写入')

    const lease = await acquireLease(ctx, operation)
    try {
      // **基线 = 锁内重读的盘上内容**（不是 `loaded`：那可能已经过期好几拍了）。
      // 没有跨进程锁时退回内存快照（单进程语义，与第一轮一致）。
      const baseline = lease === null ? loaded.items : await readBaseline(ctx.persistence, operation)
      const draft: Reminder[] = structuredClone(baseline) as Reminder[]
      const editResult = edit(draft)
      if (editResult.kind === 'reject') return toMutation(editResult)
      if (editResult.kind === 'unchanged') {
        // 没改动也要把内存对齐到刚读到的盘上状态，否则下一拍还在用旧快照做判断。
        if (lease !== null) ctx.publish(deepFreeze({ items: baseline.map((row) => deepFreeze(row)) }))
        return toMutation(editResult)
      }

      // 所有可能失败的准备都在写盘之前。
      validateCandidateOrThrow(draft, operation)
      const next: StoreState = deepFreeze({ items: draft.map((row) => deepFreeze(row)) })
      const bytes = serializeV1(next.items)

      await ctx.persistence.replaceSerialized(bytes)

      // 提交后到发布之间：不 await、不打日志、不调回调。
      ctx.publish(next)
      return { ok: true, changed: true, value: editResult.value }
    } finally {
      // **写成功之后才释放**（`release()` 内部按归属校验；失败路径也走这里 ⇒ 只回滚）。
      lease?.release()
    }
  })
}

/**
 * 抢跨进程锁（`null` = 调用方明确不要跨进程锁，退回单进程语义）。
 *
 * **两种失败必须分开报**（第三轮 P2）：
 *   - `LOCK_TIMEOUT`：另一个进程正在写，**稍后再试会好**（不停表、也不许无锁写）；
 *   - `LOCK_UNAVAILABLE`：本运行时没有可用的锁（`node:sqlite` 缺失 / 锁文件打不开），
 *     **不会自愈**。混成超时会让"永远写不了"看起来像"竞争激烈"，运维会一直等下去。
 *
 * 两者都 **fail-closed**：绝不允许降级成"没锁也写"——凭内存快照写盘会把对方刚写的 claim
 * 覆盖掉，那正是要防的重复外发。
 */
async function acquireLease(ctx: TxContext, operation: string): Promise<MutexLease | null> {
  if (ctx.mutex === undefined) return null
  try {
    return await ctx.mutex.acquire(ctx.lockTimeoutMs)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    if (isLockUnavailable(error)) {
      throw storeFault('LOCK_UNAVAILABLE', operation, `跨进程写锁能力不可用（${detail}）：拒绝在无锁状态下写入`, error)
    }
    // 超时与其他暂时性"锁不可用"语义相同：这一笔**没发生**，不许无锁写入。
    throw storeFault('LOCK_TIMEOUT', operation, `跨进程写锁不可用（${detail}）：拒绝在无锁状态下写入`, error)
  }
}

/** 判据只有一条：错误自己声明了 `LOCK_UNAVAILABLE`（适配器抛出，不靠文案匹配）。 */
function isLockUnavailable(error: unknown): boolean {
  return String((error as { code?: unknown }).code ?? '') === 'LOCK_UNAVAILABLE'
}
