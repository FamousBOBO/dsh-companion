/**
 * **后台/housekeeping 的同步 reducer**（task-66：从 `store.ts` 抽出，且**只改草稿**）。
 *
 * 它们不再持有持久化函数、不再回滚：落盘与发布由 `store-transaction.ts` 的事务负责。
 */

import type { Reminder } from './reminder-model.js'
import type { Edit } from './store-contract.js'
import { edited, rejected, unchanged } from './store-contract.js'

const findRow = (draft: Reminder[], id: string): Reminder | undefined => draft.find((row) => row.id === id)

/**
 * **人工收敛**（P2.5-3A-2）：把一条 `unknown` 收成确定结论。
 *
 * - `confirmed`：确实发出去了 → 清标记，保持"已触发"，不会再发；
 * - `failed`：确实没发出去 → 清标记并**重新排一次**（`fired=false`），下一拍按正常路径再试。
 */
export function reduceResolve(draft: Reminder[], id: string, outcome: 'confirmed' | 'failed'): Edit<Reminder> {
  const item = findRow(draft, id)
  if (item === undefined) return rejected('NOT_FOUND', `没有 id=${id} 的提醒`)
  if ((item.unknownAt ?? null) === null) return rejected('NOT_APPLICABLE', '这条不是"未确认"状态，无需收敛')
  item.unknownAt = null
  item.unknownReason = null
  if (outcome === 'failed') {
    item.fired = false
    item.firedAt = null
  }
  return edited({ ...item })
}

/**
 * 清理早已触发的一次性提醒（默认 7 天）。返回**被删掉的那些行**（完整内容，供调用方记日志）。
 */
export function reducePruneFired(draft: Reminder[], now: number, keepMs: number): Edit<Reminder[]> {
  // **终审 D2**：还有 pendingDispatch 的行不许删——删了等于把那条事件永久丢掉。
  const kept = draft.filter((row) => !(row.fired && row.repeat === 'none' && row.pendingDispatch === undefined
    && (row.firedAt ?? row.at) < now - keepMs))
  if (kept.length === draft.length) return unchanged([])
  const removed = draft.filter((row) => !kept.includes(row)).map((row) => ({ ...row }))
  draft.splice(0, draft.length, ...kept)
  return edited(removed)
}

/** 删除一条提醒。 */
export function reduceRemove(draft: Reminder[], id: string): Edit<boolean> {
  const index = draft.findIndex((row) => row.id === id)
  if (index < 0) return rejected('NOT_FOUND', `没有 id=${id} 的提醒`)
  draft.splice(index, 1)
  return edited(true)
}

/** **未确认**（3A-2）：拿不到可信回执 ⇒ 不再自动重试，留 `unknownAt/Reason` 等人工收敛。 */
export function reduceMarkUnknown(draft: Reminder[], id: string, reason: string, now = Date.now()): Edit<Reminder> {
  const item = findRow(draft, id)
  if (item === undefined) return rejected('NOT_FOUND', `没有 id=${id} 的提醒`)
  item.unknownAt = now
  item.unknownReason = reason
  // 有定论了（哪怕是"不知道"）：撤掉为崩溃恢复留的"已发出"事实。
  delete item.sentFor
  delete item.sentAt
  if (item.repeat === 'none') {
    item.fired = true
    item.firedAt = now
  } else {
    const step = item.repeat === 'daily' ? 86_400_000 : 7 * 86_400_000
    let next = item.at
    do { next += step } while (next <= now)
    item.at = next
    item.fired = false
    item.firedAt = now
  }
  return edited({ ...item })
}
