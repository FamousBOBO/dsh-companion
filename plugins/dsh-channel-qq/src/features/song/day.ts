/** 点歌的"今天"：一律按 `Asia/Shanghai` 算自然日。
 *
 * 为什么不复用 `features/contact/local-time.ts` 的 `zoneClock()`：那个函数属于主动消息
 * 子系统，读的是 `contact.timezone`（默认跟随宿主 TZ）。点歌的日上限是**独立的**一件事
 * ——它不该因为有人在别处改了主动消息的时区就换个日子。所以这里固定
 * `Asia/Shanghai`，并且自己实现（`features/` 之间不互相 import 是本仓库的约定）。
 *
 * 纯函数：`new Date(nowMs)` 是给定毫秒的确定性构造，不是读时钟（`check-layers` 的 R8
 * 只禁无参 `new Date()`）。
 */

/** 点歌日上限使用的时区。写成常量而不是配置项：一天一首的判据不该随部署漂移。 */
export const SONG_TIMEZONE = 'Asia/Shanghai'

/**
 * `nowMs` 在 `Asia/Shanghai` 的日期键（`YYYY-MM-DD`）。
 *
 * 用 `Intl` 而不是手算偏移：Windows 上 `Asia/Shanghai` 从来没有夏令时，
 * 手算 +8 也能对；但写法一旦依赖"这个时区不会有 DST"这个事实，它在别的时区就
 * 静默错了。`Intl` 把这件事交给运行时，代价是一次 `formatToParts`。
 *
 * 时区名非法时**返回 null**：调用方据此 fail-closed（算不出"今天"就不发），
 * 而不是退回 UTC 悄悄多算或少算一天。
 */
export function songDayKey(nowMs: number, timeZone: string = SONG_TIMEZONE): string | null {
  if (!Number.isFinite(nowMs)) return null
  try {
    const format = new Intl.DateTimeFormat('en-CA', {
      timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
    })
    let year = ''
    let month = ''
    let day = ''
    for (const part of format.formatToParts(new Date(nowMs))) {
      if (part.type === 'year') year = part.value
      else if (part.type === 'month') month = part.value
      else if (part.type === 'day') day = part.value
    }
    if (year === '' || month === '' || day === '') return null
    return `${year}-${month}-${day}`
  } catch {
    return null
  }
}

/**
 * 给定日键里取一个稳定的轮换下标（同一天永远是同一首）。
 *
 * 用日键的字符和而不是哈希后的对象：`2026-11-07` → 固定数字，任何人手算都能复现，
 * 出了问题能立刻回答"为什么今天是这一首"。
 */
export function rotationIndex(dayKey: string, size: number): number {
  if (size <= 0) return 0
  let sum = 0
  for (let i = 0; i < dayKey.length; i += 1) sum = (sum + dayKey.charCodeAt(i) * (i + 1)) % 1_000_003
  return sum % size
}
