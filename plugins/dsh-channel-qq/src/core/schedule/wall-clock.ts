/** 墙上时间 ↔ 绝对时刻：**时区显式**，不依赖运行机器的隐式本地时区。
 *
 * 为什么必须显式：提醒是"到点必须准"的东西，而 `new Date(y, m, d, h, min)` 用的是
 * **宿主进程的 TZ**。宿主机换一台、容器里 `TZ=UTC`、或者主人把笔记本时区改成
 * 别的城市，同一条"明天9点"就会落到另一个瞬间——日志里一切正常，到点却没响。
 * 提醒的墙上时间只有一个合法归属：**`REMINDER_ZONE`（Asia/Shanghai）**。
 *
 * 为什么自己算：`Intl.DateTimeFormat` 给的是"某个瞬间在某个时区是几点"（这是可靠的，
 * ICU 数据随 Node 走），反方向"某个时区的几点是哪个瞬间"没人提供，只能反解。
 * 反解必须**验算**：夏令时往前跳的那一小时在墙上根本不存在，反解会给出一个
 * 似是而非的瞬间。本模块的做法是解完之后**回代**（`epochToWallClock` 必须还原出
 * 同一组墙上时间），还原不出就返回 `null`——**绝不静默换一个瞬间**。
 *
 * 纯函数：时间一律作为参数传进来，不读全局时钟（`check-layers` 的 R8）。
 * 所以这里只有 `new Date(<参数>)`，没有 `new Date()` / `Date.now()`。
 */

/** 提醒的墙上时间所属时区；显式写死，不跟随宿主 TZ。 */
export const REMINDER_ZONE = 'Asia/Shanghai'

/** 墙上时间的一组分量（`second` 可省，按 0 算）。 */
export interface WallClockParts {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
  readonly minute: number
  readonly second?: number
}

/** 某个瞬间在某个时区里的墙上时间；`weekday` 与 `Date.getDay()` 同口径（0=周日）。 */
export interface WallClock {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
  readonly minute: number
  readonly second: number
  /** 0=周日 … 6=周六（与 `Date.getDay()` 一致，方便直接替换旧写法）。 */
  readonly weekday: number
}

/** `Date` 能表示的范围（毫秒）：超出的瞬间连格式化都没有意义。 */
const MAX_EPOCH_MS = 8.64e15
const DAY_MS = 86_400_000

/**
 * 时区名 → 格式化器。`null` 表示这个名字 `Intl` 不认识。
 *
 * 允许缓存：缓存的是"时区名到 ICU 规则的映射"，与"现在几点"无关，
 * 同样的输入永远给出同样的输出（R8 要的可重放性不受影响）。
 */
const FORMATTERS = new Map<string, Intl.DateTimeFormat | null>()

/**
 * 取一个**固定格式**的格式化器：只用来读分量，所以分隔符/顺序都无所谓，
 * 关键是 `hourCycle: 'h23'`（否则午夜会给出 `24:00`）与 `latn` 数字。
 */
function formatterFor(zone: string): Intl.DateTimeFormat | null {
  const cached = FORMATTERS.get(zone)
  if (cached !== undefined) return cached
  let made: Intl.DateTimeFormat | null = null
  try {
    made = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      numberingSystem: 'latn',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    // `RangeError: Invalid time zone specified: ...`：名字不认识就如实说不知道。
    made = null
  }
  FORMATTERS.set(zone, made)
  return made
}

/** 从 `formatToParts` 里取出六个分量；缺任何一个都当"换算不出来"。 */
function fieldsOf(ms: number, zone: string): WallClockParts | null {
  const formatter = formatterFor(zone)
  if (formatter === null) return null
  const got: Partial<Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', number>> = {}
  for (const part of formatter.formatToParts(new Date(ms))) {
    if (part.type !== 'year' && part.type !== 'month' && part.type !== 'day'
      && part.type !== 'hour' && part.type !== 'minute' && part.type !== 'second') continue
    got[part.type] = Number(part.value)
  }
  const { year, month, day, hour, minute, second } = got
  if (year === undefined || month === undefined || day === undefined
    || hour === undefined || minute === undefined || second === undefined) return null
  return { year, month, day, hour, minute, second }
}

/**
 * "把墙上时间当成 UTC"得到的毫秒数——本模块所有算式的公共坐标系。
 *
 * 它不是真正的瞬间（差一个未知偏移），但两个这样的数相减就是墙上时间的差，
 * 且 `Date` 的进位规则（2 月 30 日 → 3 月 2 日）在这里照样成立，与旧写法一致。
 */
function asUtcMs(parts: WallClockParts): number {
  const d = new Date(0)
  d.setUTCFullYear(parts.year, parts.month - 1, parts.day)
  d.setUTCHours(parts.hour, parts.minute, parts.second ?? 0, 0)
  return d.getTime()
}

function usable(parts: WallClockParts): boolean {
  return Number.isFinite(parts.year) && Number.isFinite(parts.month) && Number.isFinite(parts.day)
    && Number.isFinite(parts.hour) && Number.isFinite(parts.minute)
    && Number.isFinite(parts.second ?? 0)
}

/**
 * 某个瞬间在 `zone` 里是几点（含 `weekday`）。未知时区 / 超出可表示范围 ⇒ `null`。
 *
 * `weekday` 用"墙上日期"算（而不是瞬间的 UTC 日）：19:00 UTC 在东京已经是次日，
 * 用户说的"周几"永远是**他看到的那一天**。
 */
export function epochToWallClock(ms: number, zone: string): WallClock | null {
  if (!Number.isFinite(ms) || Math.abs(ms) > MAX_EPOCH_MS) return null
  const fields = fieldsOf(ms, zone)
  if (fields === null) return null
  const midnight = asUtcMs({ ...fields, hour: 0, minute: 0, second: 0 })
  return {
    year: fields.year,
    month: fields.month,
    day: fields.day,
    hour: fields.hour,
    minute: fields.minute,
    second: fields.second ?? 0,
    weekday: new Date(midnight).getUTCDay(),
  }
}

/**
 * `ms` 这一刻 `zone` 相对 UTC 的偏移（毫秒；东八区是 `+28800000`）。
 *
 * 未知时区或非法瞬间 ⇒ `null`。夏令时切换点两侧各取各的偏移，不看"当前"。
 */
export function offsetMsAt(ms: number, zone: string): number | null {
  const wall = epochToWallClock(ms, zone)
  if (wall === null) return null
  // 偏移是整分钟的，先把瞬间的毫秒截掉，避免 `wall` 丢掉毫秒后算出错位。
  return asUtcMs(wall) - Math.floor(ms / 1000) * 1000
}

/** 墙上日历日的序号（1970-01-01 为 0）：只用来算"差几天"，别当瞬间用。 */
export function wallDayIndex(parts: Pick<WallClockParts, 'year' | 'month' | 'day'>): number {
  return Math.floor(asUtcMs({ ...parts, hour: 0, minute: 0, second: 0 }) / DAY_MS)
}

/**
 * 把某个瞬间沿**墙上日历**推 `days` 天。
 *
 * 为什么不是 `+ days * 86400000`：有夏令时的时区里那一天只有 23 或 25 小时，
 * 加固定毫秒会把"明天 9 点"变成"明天 8 点"。换到墙上日期再换回来就没有这个问题。
 */
export function shiftWallDays(ms: number, days: number, zone: string): number | null {
  const wall = epochToWallClock(ms, zone)
  if (wall === null) return null
  return wallClockToEpoch(
    { year: wall.year, month: wall.month, day: wall.day + days, hour: wall.hour, minute: wall.minute, second: wall.second },
    zone,
  )
}

/**
 * **旧行为的补丁**：`new Date(y, …)` 把 `0 ≤ y ≤ 99` 解释成 `1900 + y`
 * （ECMA-262 `MakeDay` 的两位年份规则）。解析器收的是四位数字年份，于是旧实现里
 * `0050-01-01 09:00` 落到 **1950** 年。
 *
 * 这个映射是**既有行为**，与"时区显式化"无关，也不该顺手改掉：改掉会让同一句
 * `0050-01-01 09:00` 从 1950 年跳到公元 50 年，那是另一个行为变更。所以换算器
 * 本身保持"墙上时间就是墙上时间"的语义，由调用方显式套这条规则。
 */
export function legacyDateYear(year: number): number {
  return year >= 0 && year <= 99 ? year + 1900 : year
}

/**
 * 墙上时间 → 绝对时刻（毫秒）。
 *
 * 三种"算不出来"一律返回 `null`：
 *   1. `zone` 不认识；
 *   2. 分量不是有限数字；
 *   3. **墙上时间在该时区不存在**（夏令时往前跳的那一小时）——回代验算发现还原不出
 *      同一组墙上时间，就绝不"就近取一个"。
 *
 * 分量越界（2 月 30 日、`25:99`）**不报错**，按 `Date` 的进位规则归一化——这与
 * 旧实现 `new Date(y, m, d, h, min)` 逐字一致，属"必须保持"的既有行为。
 * 唯一的例外是**两位年份**（`0 ≤ year ≤ 99` 会被 `new Date` 当成 `1900+year`）：
 * 换算器不做这个映射，"调用方若要保持旧行为就套 `legacyDateYear()`"。
 *
 * 夏令时**重复**的那一小时（回拨）取**较早**的那一次；`Asia/Shanghai` 无夏令时，
 * 提醒路径永远碰不到这个歧义。
 */
export function wallClockToEpoch(parts: WallClockParts, zone: string): number | null {
  if (!usable(parts)) return null
  if (formatterFor(zone) === null) return null
  const target = asUtcMs(parts)
  if (!Number.isFinite(target)) return null
  const guess = offsetMsAt(target, zone)
  if (guess === null) return null
  // 先按"假装墙上时间就是 UTC"那一刻的偏移猜一次，再用猜出来的瞬间的偏移校正一次。
  const candidates = [target - guess]
  const refined = offsetMsAt(target - guess, zone)
  if (refined !== null && refined !== guess) candidates.push(target - refined)
  for (const candidate of candidates) {
    const back = epochToWallClock(candidate, zone)
    if (back !== null && asUtcMs(back) === target) return candidate
  }
  return null
}
