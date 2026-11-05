/** 事件书的"到点了没有"（P6f）：纯时间判定，零 IO。
 *
 * `core/` 的硬规矩（check-layers 的 R8）：不读全局时钟、不读随机——"现在"
 * 由参数传进来，同一份输入永远判出同一个结果，测试才能逐条钉住边界。
 *
 * 三种时间语义（规格见 05 §9.2）：
 *   - **interval**：幂等键 `id:floor(now / every)`——同一个 `everyMin` 桶里只跑
 *     一次；`jitterMin` 把开跑时刻在桶内**确定性地**挪一个偏移（hash 而不是
 *     `Math.random`：重启不改判定，测试也能算出确切时刻）；
 *   - **window**：幂等键 `id:YYYY-MM-DD`（本地日）——窗口 `[from, to]` 闭区间、
 *     分钟粒度（`06:00–11:59` 覆盖到 11:59:59），一天只跑一次；
 *   - **quietHours**：半开区间 `[from, to)`，`from > to` 表示跨午夜（`23:00→07:00`）。
 */

import { localDayKey } from './stamp.js'

/** 安静时段（半开区间；支持跨午夜）。 */
export interface QuietRange {
  readonly from: string
  readonly to: string
}

/** interval 触发（已归一化：`jitterMin` / `runOnBoot` 都有值）。 */
export interface IntervalTrigger {
  readonly type: 'interval'
  readonly everyMin: number
  readonly jitterMin: number
  /** 启动时不立刻补跑（默认 false，修 B2：部署重启日不再多跑十几遍）。 */
  readonly runOnBoot: boolean
}

/** window 触发：每天 `[from, to]` 内一次。 */
export interface WindowTrigger {
  readonly type: 'window'
  readonly from: string
  readonly to: string
}

export type Trigger = IntervalTrigger | WindowTrigger

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/

/** `HH:MM` → 当日分钟数；格式不对返回 null。 */
export function parseHhMm(text: string): number | null {
  const match = HHMM.exec(text)
  if (match === null) return null
  return Number(match[1]) * 60 + Number(match[2])
}

/** 当日的分钟数（本地时间）。 */
export function minutesOf(when: Date): number {
  return when.getHours() * 60 + when.getMinutes()
}

/** 现在是否落在任一安静时段里（半开区间 `[from, to)`，支持跨午夜）。 */
export function inQuietHours(ranges: readonly QuietRange[], when: Date): boolean {
  const nowMin = minutesOf(when)
  for (const range of ranges) {
    const from = parseHhMm(range.from)
    const to = parseHhMm(range.to)
    if (from === null || to === null || from === to) continue
    const hit = from < to ? nowMin >= from && nowMin < to : nowMin >= from || nowMin < to
    if (hit) return true
  }
  return false
}

/** 窗口是否开放（闭区间 `[from, to]`、分钟粒度）。 */
export function inWindow(from: string, to: string, when: Date): boolean {
  const start = parseHhMm(from)
  const end = parseHhMm(to)
  if (start === null || end === null || start > end) return false
  const nowMin = minutesOf(when)
  return nowMin >= start && nowMin <= end
}

/**
 * 确定性的桶内抖动（FNV-1a）：同一个 `id` 与桶永远算出同一个偏移。
 *
 * 用 hash 而不是 `Math.random` 的两个理由：重启不改判定（幂等键的语义不因
 * 重启漂移）；测试能直接算出"这个桶在几分几秒开跑"，不用放宽断言。
 */
function hash32(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** `id`+桶 → `[0, jitterMin)` 分钟内的毫秒偏移。 */
export function jitterOffsetMs(id: string, bucket: number, jitterMin: number): number {
  if (jitterMin <= 0) return 0
  return hash32(`${id}#${bucket}`) % Math.round(jitterMin * 60_000)
}

/** interval 的幂等键：`id:floor(now / every)`。 */
export function intervalKey(id: string, everyMin: number, nowMs: number): string {
  return `${id}:${Math.floor(nowMs / (everyMin * 60_000))}`
}

/** 一次判定的结论。 */
export type DueVerdict =
  | { readonly kind: 'due'; readonly key: string }
  | { readonly kind: 'consumed'; readonly key: string }
  | { readonly kind: 'wait'; readonly key: string; readonly until: number }
  | { readonly kind: 'outside'; readonly key: string }

/**
 * 到点了吗？
 *
 * @param id 事件 id（幂等键的前半段）
 * @param trigger 归一化后的触发
 * @param lastKey 状态里记的上一次幂等键
 * @param now 现在（调用方注入）
 */
export function decideDue(id: string, trigger: Trigger, lastKey: string | null, now: Date): DueVerdict {
  if (trigger.type === 'interval') {
    const everyMs = trigger.everyMin * 60_000
    const bucket = Math.floor(now.getTime() / everyMs)
    const key = `${id}:${bucket}`
    if (lastKey === key) return { kind: 'consumed', key }
    const dueAt = bucket * everyMs + jitterOffsetMs(id, bucket, trigger.jitterMin)
    if (now.getTime() < dueAt) return { kind: 'wait', key, until: dueAt }
    return { kind: 'due', key }
  }
  const key = `${id}:${localDayKey(now)}`
  if (lastKey === key) return { kind: 'consumed', key }
  if (!inWindow(trigger.from, trigger.to, now)) return { kind: 'outside', key }
  return { kind: 'due', key }
}

/**
 * 后台"下次时间"的预估（毫秒时间戳）。
 *
 * 只是给面板看的排期位置：**不含** quietHours / requires 这类门（那些要等
 * 那一刻才知道），所以文案上写"下次判定"而不是保证。
 */
export function nextRunAt(id: string, trigger: Trigger, lastKey: string | null, now: Date): number {
  if (trigger.type === 'interval') {
    const everyMs = trigger.everyMin * 60_000
    const bucket = Math.floor(now.getTime() / everyMs)
    if (lastKey === `${id}:${bucket}`) {
      const next = bucket + 1
      return next * everyMs + jitterOffsetMs(id, next, trigger.jitterMin)
    }
    const dueAt = bucket * everyMs + jitterOffsetMs(id, bucket, trigger.jitterMin)
    return Math.max(dueAt, now.getTime())
  }
  const start = parseHhMm(trigger.from)
  const end = parseHhMm(trigger.to)
  if (start === null || end === null) return now.getTime()
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (lastKey !== `${id}:${localDayKey(now)}`) {
    const nowMin = minutesOf(now)
    if (nowMin < start) return midnight + start * 60_000
    if (nowMin <= end) return now.getTime()
  }
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime()
  return tomorrow + start * 60_000
}
