/**
 * **恢复报告的比较**（从 `store.ts` 抽出：那边要守 400 行硬上限）。
 *
 * 为什么必须比**内容**而不是比 id 是否存在：`clearReadLock()` 的价值就在于"修好文件之后
 * 到底换了什么"——只按 id 计数会把"同一条被整段改写"报成 `loaded: n / 什么都没变`，
 * 于是恢复动作在日志里看起来什么都没做（R11/R12 复审抓过这类"报告说谎"）。
 */

import type { Reminder } from './reminder-model.js'
import type { RecoveryReport } from './store-contract.js'

export function diffOf(before: readonly Reminder[], after: readonly Reminder[]): RecoveryReport {
  const beforeById = new Map(before.map((row) => [row.id, row]))
  const afterById = new Map(after.map((row) => [row.id, row]))
  const removed = before.filter((row) => !afterById.has(row.id))
  const added = after.filter((row) => !beforeById.has(row.id))
  const replaced = after
    .filter((row) => beforeById.has(row.id) && JSON.stringify(beforeById.get(row.id)) !== JSON.stringify(row))
    .map((row) => ({ before: beforeById.get(row.id) as Reminder, after: row }))
  return { loaded: after.length, removed, replaced, added }
}
