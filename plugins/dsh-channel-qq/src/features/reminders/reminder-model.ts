/**
 * **单条提醒的洗数据**（从 `store.ts` 搬出来：那边要守 400 行硬上限）。
 *
 * 磁盘上的东西不可信（手改过 / 旧版本 / 半截写入），所以逐字段校验；
 * 可选字段**盘上有才带**——老文件的落盘字节被 `test/store-migration.test.ts` 钉住，
 * 不能因为加字段而凭空多出 `null` 行。
 */

import { carrySentFields } from './sent-marker.js'

/** 重复方式（`store.ts` 从这里再导出，避免两处定义）。 */
export interface Reminder {
  id: string
  text: string
  at: number
  room: 'group' | 'dm'
  target: number
  createdBy: number
  created: number
  fired: boolean
  firedAt: number | null
  repeat: 'none' | 'daily' | 'weekly'
  /**
   * **未确认态**（P2.5-3A-2）：试着投过、但拿不到平台回执（或直接抛错）。与 contact 的 `unknown`
   * 同语义：**不自动重试**（`fired` 同时置真）、只记一次、等人工收敛。以前这里什么都没有，
   * 于是发送失败会每 30 秒无限重试，"已发出但回执丢了"的那条会被重复发出去。
   */
  unknownAt?: number | null
  unknownReason?: string | null
  /**
   * **日程绑定**（P2.5-3A-4）：来自 runtime 的 `agenda_occurrences`，存 `id + revision`，
   * **发送前**用 revision 做 CAS：日程被取消/改期/时区变更后 revision 不再匹配 ⇒ 这一条不投。
   */
  occurrence?: { id: string; revision: number } | null
  /**
   * **平台已确认发出了这一轮**（终审 B3b）：`sentFor` = 哪一个 `at`、`sentAt` = 落盘时刻。
   * 写入时机：**平台回执之后、写 dispatched 之前**——崩在中间也能凭它认定"这一轮发过"。
   */
  sentFor?: number | null
  sentAt?: number | null
  /** **dispatched 待补发**（终审 B3b）：结论仍是 `sent`，只是事件没写成；runner 下一拍补，补上就删。 */
  pendingDispatch?: { occurrenceId: string; revision: number; at: number; attempts?: number; since?: number } | null
  /** **补发到上限后的终态**（终审跟进）：不再重试，只留给诊断数出来。 */
  dispatchAbandonedAt?: number | null
  dispatchAbandonReason?: string | null
  /** **过期未补发的终态**（终审 B7）：skipped-expired:too-old，不静默丢弃。 */
  expiredAt?: number | null
  expiredReason?: string | null
  /**
   * **投递认领**（2026-11-10 修复：原子领取 / 多实例防重复发送）。
   *
   * `by` 认领者标识（进程+实例），`at` 认领时刻，`until` 认领到期时刻。认领**先落盘再真发**，
   * 所以第二个扫描者看到的是一条"别人正在发"的行，不会重复发（以前只有进程内的 `running`
   * 布尔量，跨进程/多实例毫无保护）。
   *
   * 到期没清有两种可能，盘上**无法区分**：进程在发送前崩了（这一轮确实没发）、还是发送后
   * 记账前崩了（不确定发没发）。所以过期认领按 `claim.ts` 的规矩一律收敛成 `unknown`，
   * **不盲目重发**——与 store 现有的 unknown 语义、contact 的 unknown 口径一致。
   */
  claim?: { by: string; at: number; until: number } | null
  /** **这一轮的投递尝试次数**（1 起，与 `pendingDispatch.attempts` 无关）：结构化日志用。 */
  attempts?: number | null
}
export type Repeat = 'none' | 'daily' | 'weekly'

export function normalizeReminder(value: unknown, index: number): Reminder | null {
  if (value === null || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const text = typeof raw.text === 'string' ? raw.text.trim() : ''
  const at = Number(raw.at ?? 0)
  if (text === '' || !Number.isFinite(at) || at <= 0) return null
  const repeat = raw.repeat === 'daily' || raw.repeat === 'weekly' ? raw.repeat : 'none'
  const created = Number(raw.created ?? 0)
  const firedAt = Number(raw.firedAt ?? 0)
  const base: Reminder = {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : `r_recovered_${String(index)}`,
    text,
    at,
    room: raw.room === 'dm' ? 'dm' : 'group',
    target: Number(raw.target ?? 0),
    createdBy: Number(raw.createdBy ?? 0),
    created: Number.isFinite(created) ? created : Date.now(),
    fired: raw.fired === true,
    firedAt: typeof raw.firedAt === 'number' && Number.isFinite(firedAt) ? firedAt : null,
    repeat,
  }
  // 3A-2 / 3A-4 的字段**只在盘上有的时候才带上**：老文件的落盘字节（被
  // `test/store-migration.test.ts` 钉住）不能因为这次加字段而变。
  const unknownAt = Number(raw.unknownAt ?? 0)
  if (typeof raw.unknownAt === 'number' && Number.isFinite(unknownAt)) base.unknownAt = unknownAt
  // 终审 B7：过期终态也要洗（老文件没有就不带，字节不变）。
  const expiredAt = Number(raw.expiredAt ?? 0)
  if (typeof raw.expiredAt === 'number' && Number.isFinite(expiredAt)) base.expiredAt = expiredAt
  if (typeof raw.expiredReason === 'string') base.expiredReason = raw.expiredReason
  if (typeof raw.unknownReason === 'string') base.unknownReason = raw.unknownReason
  const occurrence = raw.occurrence
  if (occurrence !== null && typeof occurrence === 'object') {
    const id = (occurrence as { id?: unknown }).id
    const revision = Number((occurrence as { revision?: unknown }).revision)
    if (typeof id === 'string' && id !== '' && Number.isFinite(revision)) base.occurrence = { id, revision }
  }
  // 终审 B3b 的三个字段同样是"盘上有才带"（零 migration：老文件字节不变）；洗法见 sent-marker。
  carrySentFields(raw, base)
  // 2026-11-10：认领与尝试次数同理——老文件没有就不带，盘上字节不变。
  const claim = raw.claim
  if (claim !== null && typeof claim === 'object') {
    const by = (claim as { by?: unknown }).by
    const at0 = Number((claim as { at?: unknown }).at)
    const until = Number((claim as { until?: unknown }).until)
    if (typeof by === 'string' && by !== '' && Number.isFinite(at0) && Number.isFinite(until)) {
      base.claim = { by, at: at0, until }
    }
  }
  const attempts = Number(raw.attempts ?? 0)
  if (typeof raw.attempts === 'number' && Number.isFinite(attempts)) base.attempts = attempts
  return base
}
