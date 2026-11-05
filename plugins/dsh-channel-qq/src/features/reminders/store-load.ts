/**
 * **统一解码器**（设计 §3）：替代旧的 `shapeOf()` + `itemsFrom()`。
 *
 * 接收：裸数组；`{ version: 1, reminders: [...] }`；**缺省 version 的历史对象**（明确兼容规则）。
 * 拒绝：`{}` / `null` / `reminders` 类型不对 / **声明了但不等 1 的版本** / **任意一行不合法** /
 *       **重复 id**。任何一条不满足 ⇒ `ok:false`，调用方据此**锁定所有写入（只读）**，不许当空表。
 */

import type { Reminder } from './reminder-model.js'
import { validateRow } from './reminder-validate.js'
import type { ValidationIssue, ValidationNote } from './store-contract.js'

export type DecodeResult =
  | { ok: true; items: Reminder[]; notes: readonly ValidationNote[] }
  | { ok: false; issues: readonly ValidationIssue[] }

const containerOf = (raw: unknown): { ok: true; rows: unknown[] } | { ok: false; issues: ValidationIssue[] } => {
  if (Array.isArray(raw)) return { ok: true, rows: raw }
  if (raw !== null && typeof raw === 'object') {
    const cast = raw as { version?: unknown; reminders?: unknown }
    if (cast.version !== undefined) {
      if (typeof cast.version !== 'number' || !Number.isFinite(cast.version)) {
        return { ok: false, issues: [{ path: 'version', message: '必须是数字' }] }
      }
      // **只接受 1**：以前 version 99 会被接受并悄悄降写为 v1，等于吞掉未来版本的语义。
      if (cast.version !== 1) {
        return { ok: false, issues: [{ path: 'version', message: `只支持 version 1（读到 ${String(cast.version)}）` }] }
      }
    }
    if (!Array.isArray(cast.reminders)) {
      return { ok: false, issues: [{ path: 'reminders', message: '必须是数组（对象里没有 reminders 数组 ⇒ 不是提醒文件）' }] }
    }
    return { ok: true, rows: cast.reminders }
  }
  return { ok: false, issues: [{ path: '', message: '既不是数组，也不是带 reminders 数组的对象' }] }
}

export function decodeReminderFile(raw: unknown): DecodeResult {
  const container = containerOf(raw)
  if (!container.ok) return { ok: false, issues: container.issues }

  const items: Reminder[] = []
  const issues: ValidationIssue[] = []
  const notes: ValidationNote[] = []
  const seen = new Map<string, number>()

  container.rows.forEach((entry, index) => {
    const result = validateRow(entry, `reminders[${String(index)}]`)
    issues.push(...result.issues)
    notes.push(...result.notes)
    if (result.row === undefined) return
    const first = seen.get(result.row.id)
    if (first !== undefined) {
      issues.push({ path: `reminders[${String(index)}].id`, message: `id 与第 ${String(first)} 行重复：${result.row.id}` })
      return
    }
    seen.set(result.row.id, index)
    items.push(result.row)
  })

  if (issues.length > 0) return { ok: false, issues }
  return { ok: true, items, notes }
}

/** 序列化成盘上的 V1 形状（**唯一**的写盘格式；缩进 2 + 结尾换行是既有约定）。 */
export function serializeV1(items: readonly Reminder[]): string {
  return `${JSON.stringify({ version: 1, reminders: items }, null, 2)}\n`
}
