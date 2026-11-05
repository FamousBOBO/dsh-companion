/** 主动消息的**本地时间换算**：时区、免打扰区间、跨日额度。
 *
 * 为什么从 `gate.ts` 拆出来：门控本身要读起来像一张判定表（顺序 + reason），
 * 时区换算这类"把毫秒变成当地几点"的细节放在中间会把表冲散；另外门控文件已经贴着
 * 400 行硬上限（`scripts/check-size.mjs`）。拆开之后这里的每个函数都能单独测：
 * 给定时区 + 毫秒，算出当地分钟数与日键，与业务无关。
 *
 * 全部是纯函数：不读时钟、不读盘、不抛（时区名不认识返回 `null`，让调用方 fail-closed）。
 */

import { parseHhMm, type QuietRange } from '../../core/schedule/due.js'
import { localDayKey } from '../../core/schedule/stamp.js'
import { emptyCounters, type ContactCounters } from './types.js'

/** 一个时刻在配置时区里的"当日分钟数 + 本地日键"。 */
export interface ZoneClock {
  /** 当日分钟数（0–1439）。 */
  readonly minutes: number
  /** 本地日键 `YYYY-MM-DD`（额度按它跨日归零）。 */
  readonly day: string
}

/**
 * 时钟换算。
 *
 * `timeZone` 为空 = 跟随宿主 TZ（用 `Date` 的本地字段）；给了 IANA 名就走 `Intl`。
 * 不认识的名字返回 `null`，让调用方 fail-closed——在一个算不出"现在几点"的时区里
 * 猜安静时段，正是半夜两点发消息的由来。
 *
 * 参数里的 `new Date(nowMs)` 是**确定性构造**（给定毫秒数），不是读时钟。
 */
export function zoneClock(nowMs: number, timeZone: string): ZoneClock | null {
  if (timeZone === '') {
    const at = new Date(nowMs)
    return { minutes: at.getHours() * 60 + at.getMinutes(), day: localDayKey(at) }
  }
  try {
    const format = new Intl.DateTimeFormat('en-CA', {
      timeZone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    })
    let year = ''
    let month = ''
    let day = ''
    let hour = ''
    let minute = ''
    for (const part of format.formatToParts(new Date(nowMs))) {
      if (part.type === 'year') year = part.value
      else if (part.type === 'month') month = part.value
      else if (part.type === 'day') day = part.value
      else if (part.type === 'hour') hour = part.value
      else if (part.type === 'minute') minute = part.value
    }
    const h = Number(hour) % 24
    const m = Number(minute)
    if (year === '' || month === '' || day === '' || !Number.isFinite(h) || !Number.isFinite(m)) return null
    return { minutes: h * 60 + m, day: `${year}-${month}-${day}` }
  } catch {
    return null
  }
}

/** 是否落在任一安静时段里（半开区间 `[from, to)`；`from > to` = 跨午夜，如 `23:00→08:00`）。 */
export function inQuiet(minutes: number, ranges: readonly QuietRange[]): boolean {
  for (const range of ranges) {
    const from = parseHhMm(range.from)
    const to = parseHhMm(range.to)
    if (from === null || to === null || from === to) continue
    const hit = from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to
    if (hit) return true
  }
  return false
}

/**
 * 按配置时区的"今天"取计数：计数的 `day` 与今日不一致时，视作零（跨日归零）。
 *
 * 归零放在这里而不是只依赖 store：store 也会写，但门控不能因为"落盘的 day 还没更新"
 * 就把昨天的额度算进今天。时区算不出来时原样返回（调用方在免打扰那一步已经拦过了）。
 */
export function countsForToday(counters: ContactCounters, nowMs: number, timeZone: string): ContactCounters {
  const clock = zoneClock(nowMs, timeZone)
  if (clock === null || counters.day === clock.day) return counters
  return emptyCounters(clock.day)
}
