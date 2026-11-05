/**
 * **提醒行的逐行校验**（设计 §3）：任意一行不合法 ⇒ **整体拒绝**，不许 filter 坏行。
 *
 * 为什么这么严：坏行被"归一化"掉之后，`{"reminders":[{}]}` 会变成空表并解锁——
 * 下一次保存就把用户的提醒**合法地**清空。所以这里只回答"这一行是否完全合法"。
 */

import type { Reminder } from './reminder-model.js'
import type { ValidationIssue, ValidationNote } from './store-contract.js'

const ROOMS = new Set(['group', 'dm'])
const REPEATS = new Set(['none', 'daily', 'weekly'])
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/** 校验并造出一条**合法**提醒（不合法就返回 issues，绝不"修好它"）。 */
export function validateRow(raw: unknown, path: string): { row?: Reminder; issues: ValidationIssue[]; notes: ValidationNote[] } {
  const issues: ValidationIssue[] = []
  const notes: ValidationNote[] = []
  const bad = (field: string, message: string): void => { issues.push({ path: `${path}.${field}`, message }) }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    issues.push({ path, message: '不是对象' })
    return { issues, notes }
  }
  const row = raw as Record<string, unknown>

  if (typeof row.id !== 'string' || row.id.trim() === '') bad('id', '必须是非空字符串')
  if (typeof row.text !== 'string') bad('text', '必须是字符串')
  if (!isFiniteNumber(row.at)) bad('at', '必须是有限数字')
  if (typeof row.room !== 'string' || !ROOMS.has(row.room)) bad('room', '只能是 group / dm')
  if (!isFiniteNumber(row.target) || row.target <= 0) bad('target', '必须是正数')
  // **task-66 兼容规则**（设计 §3）：早期存量行只有 `id/text/at/room/target`，缺
  // `createdBy/created/fired/firedAt/repeat` —— 这些**缺省可补**（值存在但不合法照样拒绝）。
  if (row.createdBy === undefined) notes.push({ path: `${path}.createdBy`, message: '缺省', filled: '0' })
  else if (!isFiniteNumber(row.createdBy)) bad('createdBy', '必须是有限数字')
  if (row.created === undefined) notes.push({ path: `${path}.created`, message: '缺省', filled: 'at' })
  else if (!isFiniteNumber(row.created)) bad('created', '必须是有限数字')
  if (row.fired === undefined) notes.push({ path: `${path}.fired`, message: '缺省', filled: 'false' })
  else if (typeof row.fired !== 'boolean') bad('fired', '必须是布尔')
  if (row.firedAt !== undefined && row.firedAt !== null && !isFiniteNumber(row.firedAt)) bad('firedAt', '必须是有限数字或 null')
  if (row.repeat === undefined) notes.push({ path: `${path}.repeat`, message: '缺省', filled: 'none' })
  else if (typeof row.repeat !== 'string' || !REPEATS.has(row.repeat)) bad('repeat', '只能是 none / daily / weekly')

  checkOptionalFields(row, path, issues)

  // 缺省可选字段：只是"没写"，不算坏（记一笔 note 便于诊断，不改内容）。
  for (const field of ['unknownAt', 'sentFor', 'sentAt']) {
    if (row[field] === undefined) notes.push({ path: `${path}.${field}`, message: '缺省', filled: 'undefined→null（读时不补写）' })
  }

  if (issues.length > 0) return { issues, notes }
  // 归一化：只补**缺省**字段，不改已给出的值，也不写回盘。
  const normalized = raw as Reminder
  if (row.createdBy === undefined) normalized.createdBy = 0
  if (row.created === undefined) normalized.created = normalized.at
  if (row.fired === undefined) normalized.fired = false
  if (row.repeat === undefined) normalized.repeat = 'none'
  return { row: normalized, issues, notes }
}

/** 可选字段：**存在就必须合法**（不许静默删掉，尤其别把 pendingDispatch 洗掉后当正常提醒）。 */
function checkOptionalFields(row: Record<string, unknown>, path: string, issues: ValidationIssue[]): void {
  const bad = (field: string, message: string): void => { issues.push({ path: `${path}.${field}`, message }) }
  // 可选的安全相关字段：**存在就必须合法**（不许静默删掉）。
  const optionalNumber = (field: string): void => {
    const value = row[field]
    if (value === undefined || value === null) return
    if (!isFiniteNumber(value)) bad(field, '必须是有限数字或 null')
  }
  const optionalString = (field: string): void => {
    const value = row[field]
    if (value === undefined || value === null) return
    if (typeof value !== 'string') bad(field, '必须是字符串或 null')
  }
  optionalNumber('unknownAt'); optionalString('unknownReason')
  optionalNumber('sentFor'); optionalNumber('sentAt')
  optionalNumber('dispatchAbandonedAt'); optionalString('dispatchAbandonReason')
  optionalNumber('expiredAt'); optionalString('expiredReason')

  const occurrence = row.occurrence
  if (occurrence !== undefined && occurrence !== null) {
    if (typeof occurrence !== 'object' || Array.isArray(occurrence)) bad('occurrence', '必须是对象或 null')
    else {
      const cast = occurrence as Record<string, unknown>
      if (typeof cast.id !== 'string' || cast.id.trim() === '') bad('occurrence.id', '必须是非空字符串')
      if (!isFiniteNumber(cast.revision)) bad('occurrence.revision', '必须是有限数字')
    }
  }

  const pending = row.pendingDispatch
  if (pending !== undefined && pending !== null) {
    if (typeof pending !== 'object' || Array.isArray(pending)) bad('pendingDispatch', '必须是对象或 null')
    else {
      const cast = pending as Record<string, unknown>
      if (typeof cast.occurrenceId !== 'string') bad('pendingDispatch.occurrenceId', '必须是字符串')
      if (!isFiniteNumber(cast.revision)) bad('pendingDispatch.revision', '必须是有限数字')
      if (!isFiniteNumber(cast.at)) bad('pendingDispatch.at', '必须是有限数字')
      if (cast.attempts !== undefined && !isFiniteNumber(cast.attempts)) bad('pendingDispatch.attempts', '必须是有限数字')
      if (cast.since !== undefined && !isFiniteNumber(cast.since)) bad('pendingDispatch.since', '必须是有限数字')
    }
  }


}

