/**
 * **"这一轮结束了"两个 reducer**（从 `store.ts` 抽出：那边要守 400 行硬上限）。
 *
 * 两者语义不同，不能合并：
 *   - `reduceMarkFired`：一次性/周期提醒"这一轮**发过了**"；
 *   - `reduceMarkFiredRebound`：周期提醒发过之后**同时**把 `at` 推进到下一轮、
 *     把 `occurrence` 换成新 revision（推进与换绑**必须同一次写盘**，否则会留下
 *     "新 at + 旧 revision"这种自造故障）。
 *
 * 共同的收尾是 `clearClaim()`：一轮结束就要放掉认领，否则周期提醒的下一轮会被自己的
 * 旧认领挡到 TTL 之后。
 */

import type { Reminder } from './reminder-model.js'
import type { Edit } from './store-contract.js'
import { rejected } from './store-contract.js'
import { clearClaim } from './claim.js'

/** 下一轮的时刻（严格大于 `now`：推进到"还没到"的那一刻，而不是原地不动）。 */
export function nextRoundAt(item: Reminder, now: number): number {
  const step = item.repeat === 'daily' ? 86_400_000 : 7 * 86_400_000
  let next = item.at
  do { next += step } while (next <= now)
  return next
}

/** **这一轮发过了**：一次性 ⇒ `fired`；周期 ⇒ 推进 `at`、`fired` 保持 false。 */
export function reduceMarkFired(draft: Reminder[], id: string, now: number): Edit<Reminder> {
  const item = draft.find((row) => row.id === id)
  if (item === undefined) return rejected('NOT_FOUND', `没有 id=${id} 的提醒`)
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
  clearClaim(item)
  return { kind: 'changed', value: { ...item } }
}

/**
 * **周期提醒发过了 + 换绑**：`at` 推进与 `occurrence` 换绑在**同一次写盘**里完成。
 *
 * `occurrence === null` ⇒ 解绑（拿不到下一轮时就该清空，别留一个必然过期的 revision）。
 */
export function reduceMarkFiredRebound(
  draft: Reminder[],
  id: string,
  occurrence: { id: string; revision: number } | null,
  now: number,
): Edit<Reminder> {
  const item = draft.find((row) => row.id === id)
  if (item === undefined) return rejected('NOT_FOUND', `没有 id=${id} 的提醒`)
  item.at = nextRoundAt(item, now)
  item.fired = false
  item.firedAt = now
  delete item.sentFor
  delete item.sentAt
  if (occurrence === null) delete item.occurrence
  else item.occurrence = { ...occurrence }
  clearClaim(item)
  return { kind: 'changed', value: { ...item } }
}
