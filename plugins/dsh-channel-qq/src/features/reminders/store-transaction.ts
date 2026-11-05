/**
 * **事务级串行化 + copy-on-write + 提交后发布**（设计 §1.4/§1.5）。
 *
 * 固定的六步，**没有"回滚"**：
 * 进队列 → 克隆已发布状态为草稿 → 同步 reducer 改草稿 → 校验/冻结/序列化（所有可能失败的事都在写盘前）
 * → 唯一写出口落盘（rename 成功 = 提交点）→ 提交后**不再 await**，同步发布新不可变引用。
 *
 * 写盘失败就把草稿丢掉——已发布状态从未改变，所以"失败撤销别人的成功"这类事故在结构上不存在。
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { deepFreeze } from './store-freeze.js'
import type { Edit, Mutation, ReminderPersistence, StoreState } from './store-contract.js'
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
 * 跑一笔事务。`edit` 必须是**同步**函数：只许改草稿，不许 I/O、不许调本 store 的其它方法。
 */
export async function transact<T>(
  ctx: TxContext,
  operation: string,
  edit: (draft: Reminder[]) => Edit<T>,
): Promise<Mutation<T>> {
  return await ctx.queue.run(operation, async () => {
    const base = ctx.state()
    if (base === null) throw storeFault('NOT_LOADED', operation, '存储还没 load()，拒绝写入')
    const draft: Reminder[] = structuredClone(base.items) as Reminder[]
    const editResult = edit(draft)
    if (editResult.kind === 'reject') return toMutation(editResult)
    if (editResult.kind === 'unchanged') return toMutation(editResult)

    // 所有可能失败的准备都在写盘之前。
    validateCandidateOrThrow(draft, operation)
    const next: StoreState = deepFreeze({ items: draft.map((row) => deepFreeze(row)) })
    const bytes = serializeV1(next.items)

    await ctx.persistence.replaceSerialized(bytes)

    // 提交后到发布之间：不 await、不打日志、不调回调。
    ctx.publish(next)
    return { ok: true, changed: true, value: editResult.value }
  })
}
