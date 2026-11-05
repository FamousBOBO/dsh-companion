/**
 * **把"输入"变成一条合规的提醒**（round8：从 `store.ts` 抽出来压行数）。
 *
 * 校验口径与 `normalizeReminder()` 一致：不合规就**抛错**（新建时）或**当没有绑定**（绑定字段），
 * 绝不写半截字段——半截字段会让后面每次读盘都在两个形状之间摇摆。
 */

import { shortId } from '../../adapters/dsh-host/tools.js'
import type { Repeat } from './reminder-model.js'

/** 新建一条提醒的入参（`at` 是 Unix 毫秒；调用方负责把 "YYYY-MM-DD HH:mm" 解析好）。 */
export interface AddInput {
  text: string
  at: number
  room: 'group' | 'dm'
  target: number
  createdBy: number
  repeat?: Repeat
  /** **日程绑定**（P2.5-3A-4）：由工具在**建日程之后**传进来。 */
  occurrence?: { id: string; revision: number } | null
}

/** 归一化后的提醒（与 `store.ts::Reminder` 同形状；这里只用到新建需要的字段）。 */
export interface BuiltReminder {
  id: string
  text: string
  at: number
  room: 'group' | 'dm'
  target: number
  createdBy: number
  created: number
  fired: boolean
  firedAt: number | null
  repeat: Repeat
  occurrence?: { id: string; revision: number }
}

/** 校验并造出这条提醒（**不落盘**；落盘由调用方负责）。 */
export function buildReminder(input: AddInput): BuiltReminder {
  const text = String(input.text ?? '').trim()
  if (text === '') throw new Error('提醒内容不能为空：告诉咱要到点提醒你什么。')
  const at = Number(input.at)
  if (!Number.isFinite(at) || at <= 0) throw new Error('提醒时间无效：请给 Unix 毫秒时间戳或 "YYYY-MM-DD HH:mm"。')
  const item: BuiltReminder = {
    id: shortId('r'),
    text,
    at,
    room: input.room,
    target: Number(input.target),
    createdBy: Number(input.createdBy ?? 0),
    created: Date.now(),
    fired: false,
    firedAt: null,
    repeat: input.repeat ?? 'none',
  }
  // 与 `normalizeReminder()` 同一套校验：不合规就当"没有绑定"（诚实降级，不写半截字段）。
  const occurrence = input.occurrence ?? null
  if (occurrence !== null && typeof occurrence.id === 'string' && occurrence.id !== ''
    && Number.isFinite(occurrence.revision)) {
    item.occurrence = { id: occurrence.id, revision: occurrence.revision }
  }
  return item
}
