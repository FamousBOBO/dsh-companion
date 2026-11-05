/**
 * **"平台已发出 / 待补发"这三个字段的语义**（终审 B3b）。
 *
 * task-66 起这里的写操作全部是**同步 reducer**：只改传进来的草稿，不碰盘、不回滚。
 * 落盘交给事务层（`store-transaction.ts`）——事务失败就丢草稿，所以这里不存在"写失败要回滚"的问题。
 */

import type { Reminder } from './reminder-model.js'
import type { Edit } from './store-contract.js'
import { edited, rejected, unchanged } from './store-contract.js'

/**
 * **补发 `occurrence-dispatched` 的次数上限**（终审跟进：无上限重试 + 无告警 = 既不收敛也没人知道）。
 *
 * 到顶就转**终态**（`dispatchAbandonedAt` + 原因），不再每拍重试。10 次 ≈ 默认 30 秒一拍的 5 分钟。
 */
export const DISPATCH_MAX_ATTEMPTS = 10

const findRow = (draft: Reminder[], id: string): Reminder | undefined => draft.find((row) => row.id === id)

/** **记"平台已发出"**：写 `sentFor/sentAt`（在写 `occurrence-dispatched` **之前**）。 */
export function reduceMarkSent(
  draft: Reminder[],
  id: string,
  forAt: number,
  now: () => number = Date.now,
): Edit<Reminder> {
  const item = findRow(draft, id)
  if (item === undefined) return rejected('NOT_FOUND', `没有 id=${id} 的提醒`)
  item.sentFor = forAt
  item.sentAt = now()
  return edited({ ...item })
}

/** 这一轮（`forAt`）是否已经发过。 */
export function sentForRound(item: Reminder | undefined, forAt: number): boolean {
  return item !== undefined && typeof item.sentFor === 'number' && item.sentFor === forAt
}

/** **记待办**：`attempts=1`、`since` 给诊断算年龄。 */
export function reduceSetPending(
  draft: Reminder[],
  id: string,
  payload: { occurrenceId: string; revision: number; at: number },
  now: () => number = Date.now,
): Edit<Reminder> {
  const item = findRow(draft, id)
  if (item === undefined) return rejected('NOT_FOUND', `没有 id=${id} 的提醒`)
  item.pendingDispatch = { ...payload, attempts: 1, since: now() }
  return edited({ ...item })
}

/**
 * **补发又失败一次**：次数 +1；到上限转终态（删待办、记 `dispatchAbandonedAt/Reason`）。
 *
 * 为什么要终态：无限留待办 ⇒ 每拍重试、日志被刷、状态永远"待补"，却没人知道已经放弃。
 */
export function reduceBumpPending(
  draft: Reminder[],
  id: string,
  now: () => number = Date.now,
): Edit<{ attempts: number; abandoned: boolean }> {
  const item = findRow(draft, id)
  if (item === undefined) return rejected('NOT_FOUND', `没有 id=${id} 的提醒`)
  const pending = item.pendingDispatch ?? null
  if (pending === null) return rejected('NOT_APPLICABLE', '这条没有待补发的事件')
  const attempts = (pending.attempts ?? 0) + 1
  if (attempts < DISPATCH_MAX_ATTEMPTS) {
    item.pendingDispatch = { ...pending, attempts }
    return edited({ attempts, abandoned: false })
  }
  delete item.pendingDispatch
  item.dispatchAbandonedAt = now()
  item.dispatchAbandonReason = `attempts-exhausted:${String(attempts)}`
  return edited({ attempts, abandoned: true })
}

/** **清待办**：本来就没有 ⇒ `unchanged`（不写盘）。 */
export function reduceClearPending(draft: Reminder[], id: string): Edit<boolean> {
  const item = findRow(draft, id)
  if (item === undefined) return rejected('NOT_FOUND', `没有 id=${id} 的提醒`)
  if (item.pendingDispatch === undefined || item.pendingDispatch === null) return unchanged(true)
  delete item.pendingDispatch
  return edited(true)
}

/** 有待补发 dispatched 的那些提醒。 */
export function pendingDispatchesOf(items: readonly Reminder[]): Reminder[] {
  return items.filter((item) => item.pendingDispatch !== undefined && item.pendingDispatch !== null)
}

/**
 * **诊断指标**（后台 `reminders.pendingDispatch`）：待补发条数、最老待办等了多久、已放弃条数。
 */
export function dispatchMetricsOf(
  items: readonly Reminder[],
  now: number,
): { value: number; oldestAgeMs: number; overLimit: number } {
  const pending = pendingDispatchesOf(items)
  let oldest = 0
  for (const item of pending) {
    const since = item.pendingDispatch?.since ?? now
    const age = now - since
    if (age > oldest) oldest = age
  }
  const abandoned = items.filter((item) => typeof item.dispatchAbandonedAt === 'number').length
  return { value: pending.length, oldestAgeMs: Math.max(0, oldest), overLimit: abandoned }
}

/**
 * 洗盘上那三个字段（**只在盘上有的时候才带**）。
 *
 * 为什么这么啰嗦：`reminders.json` 是用户可能手改过的文件，而且老文件的落盘字节被
 * `test/store-migration.test.ts` 钉住——加字段不能让"从没写过的老文件"多出 `null` 行。
 */
export function carrySentFields(raw: Record<string, unknown>, base: Reminder): void {
  const sentFor = Number(raw.sentFor ?? 0)
  if (typeof raw.sentFor === 'number' && Number.isFinite(sentFor)) base.sentFor = sentFor
  const sentAt = Number(raw.sentAt ?? 0)
  if (typeof raw.sentAt === 'number' && Number.isFinite(sentAt)) base.sentAt = sentAt
  const pending = raw.pendingDispatch
  if (pending === null || typeof pending !== 'object') {
    const abandonedAt = Number(raw.dispatchAbandonedAt ?? 0)
    if (typeof raw.dispatchAbandonedAt === 'number' && Number.isFinite(abandonedAt)) base.dispatchAbandonedAt = abandonedAt
    if (typeof raw.dispatchAbandonReason === 'string') base.dispatchAbandonReason = raw.dispatchAbandonReason
    return
  }
  const occurrenceId = (pending as { occurrenceId?: unknown }).occurrenceId
  const revision = Number((pending as { revision?: unknown }).revision)
  const at = Number((pending as { at?: unknown }).at)
  if (typeof occurrenceId === 'string' && occurrenceId !== '' && Number.isFinite(revision) && Number.isFinite(at)) {
    const attempts = Number((pending as { attempts?: unknown }).attempts)
    const since = Number((pending as { since?: unknown }).since)
    base.pendingDispatch = {
      occurrenceId,
      revision,
      at,
      ...(Number.isFinite(attempts) ? { attempts } : {}),
      ...(Number.isFinite(since) ? { since } : {}),
    }
  }
}

/** 有定论了（已触发/未确认）：撤掉"为崩溃恢复留的已发出事实"。 */
export function clearSentFields(item: Reminder): void {
  delete item.sentFor
  delete item.sentAt
}
