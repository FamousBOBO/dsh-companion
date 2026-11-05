/** 自然语言时间解析："明天9点" → 绝对时间戳。纯规则 + 纯函数。
 *
 * 为什么不用 LLM：提醒的关键时刻是"到点必须准"，而模型给的相对时间
 * （"明天9点"）经常少一年/多一天，而且要额外一轮调用。parseWhen 可单测、
 * 零依赖、零延迟，解析不出来就返回 null，把显式时间交给 qq_remind_at
 * 那条路，绝不猜。
 *
 * P4 搬迁注记：从 `src/reminders.ts` 原样搬来；原 122 行的 parseWhen 按语义拆
 * 成"剥周期 / 剥相对时间 / 剥日期 / 剥时刻 + 三个出口"，**判定逻辑与优先级顺序
 * 逐字保留**。行为判据是 `test/golden/pure/parse-when.txt` 的逐字节快照。
 *
 * 为什么不放 `src/core/`：parseWhen 的默认参数是无参 `new Date()`，而 `core/`
 * 有 R8 铁律禁止读全局时钟——这条留给 P6 决定。
 */

import type { Repeat } from './store.js'

type Period = 'morning' | 'noon' | 'afternoon' | 'evening' | 'night' | 'latenight'

/** 毫秒常量：一天 / 一周。重复提醒的推进与相对时间解析都用它。 */
export const DAY_MS = 86_400_000
export const WEEK_MS = 604_800_000

/** 只给时间段（"明早"/"今天晚上10点"）时的锚点小时。 */
const PERIOD_ANCHOR: Record<Period, number> = {
  morning: 7,
  noon: 12,
  afternoon: 15,
  evening: 18,
  night: 20,
  latenight: 23,
}

/** 每个时间段允许的小时区间；修掉"晚上15点"这种越界写法。 */
const PERIOD_HOURS: Record<Period, [number, number]> = {
  morning: [5, 10],
  noon: [11, 13],
  afternoon: [13, 17],
  evening: [17, 19],
  night: [19, 23],
  latenight: [23, 23],
}

function formatMDHM(d: Date): string {
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * 给人看的一句确认。跨年的日期补上年份 —— 否则"已定在 10-15 09:00"
 * 分不清是今年还是明年，用户根本没法核对。
 */
function buildNote(at: number, now: Date, repeat: Repeat): string {
  const d = new Date(at)
  const year = d.getFullYear() !== now.getFullYear() ? `${String(d.getFullYear())}-` : ''
  const label = repeat === 'daily' ? '（每天）' : repeat === 'weekly' ? '（每周）' : ''
  return `已定在 ${year}${humanTime(at, now)}${label}`
}

/** 单次提醒里，一个能"看出是今天还是明天"的时刻文本。 */
export function humanTime(at: number, now: Date): string {
  const d = new Date(at)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
    - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / DAY_MS)
  if (days === 0) return `今天 ${hm}`
  if (days === 1) return `明天 ${hm}`
  if (days === 2) return `后天 ${hm}`
  return formatMDHM(d)
}

/** 从文本里取星期几：周一=1 … 周日=7；下周X 记额外 +7 天。 */
function extractWeekday(input: string): { weekday: number; nextWeek: boolean } | null {
  const nextWeek = /下(?:个)?\s*(?:周|星期|礼拜)/.test(input)
  const cn = /(?:周|星期|礼拜)([一二三四五六日天])/.exec(input)
  if (cn !== null) {
    const map: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 }
    const weekday = map[cn[1]!]
    if (weekday !== undefined) return { weekday, nextWeek }
  }
  const num = /(?:周|星期|礼拜)([1-7])/.exec(input)
  if (num !== null) return { weekday: Number(num[1]), nextWeek }
  return null
}

/** 从前缀词判定时间段：明早/明晚这类词同时告诉你小时该落哪。 */
function periodFromPrefix(input: string): Period | null {
  if (/半夜|凌晨/.test(input)) return 'latenight'
  if (/晚上|今晚|明晚|夜间/.test(input)) return 'night'
  if (/傍晚/.test(input)) return 'evening'
  if (/下午|午后/.test(input)) return 'afternoon'
  if (/中午|正午/.test(input)) return 'noon'
  if (/早上|早饭|明早|今早|早晨|一大早|上午|一早/.test(input)) return 'morning'
  return null
}

/** 呼应给定的时间段的写法，视作同一节拍。 */
function periodFromTimeOfDay(input: string, hour: number): Period | null {
  if (input.includes('中午') || hour === 12) return 'noon'
  if (input.includes('下午') || hour === 15) return 'afternoon'
  if (input.includes('傍晚') || hour === 18) return 'evening'
  if (input.includes('晚上') || input.includes('今晚') || input.includes('明晚') || hour === 20) return 'night'
  if (input.includes('半夜') || hour === 23) return 'latenight'
  if (input.includes('早上') || input.includes('上午') || input.includes('明早') || input.includes('今早') || hour === 7) return 'morning'
  return null
}

/** 中文时段词 → 小时；有"下午/晚上"这种词就 +12 翻到 24 小时制。 */
function resolveHour(rawHour: number, period: Period | null): number | null {
  if (rawHour < 0 || rawHour > 24) return null
  let hour = rawHour
  if (period === 'afternoon' || period === 'evening' || period === 'night') {
    if (hour < 12) hour += 12
    if (hour >= 24) hour -= 12 // "晚上24点"= 次日 0 点，退化成 12 点太蠢，留给调用方判断
  }
  if (hour > 23) return null
  if (period !== null) {
    const [lo, hi] = PERIOD_HOURS[period]
    if (hour < lo || hour > hi) return null // 越界（如"晚上3点"）就认不出来，交给显式时间
  }
  return hour
}

/**
 * 把解析出的 hour/minute 落成绝对时间。
 *
 * 顺延只发生在"只给时刻"（dayShift === 0）的情况：用户说"9点"绝不会指
 * 已经过去的那个 9 点。显式说了"明天/后天"就照他说的算，不再自作主张。
 */
function resolveDay(now: Date, dayShift: number, hour: number, minute: number): number {
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayShift, hour, minute, 0, 0)
  if (dayShift === 0 && at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1)
  return at.getTime()
}

/** 第 3 步的状态：日期（绝对日期 / 相对日 / 周几）与剥完的文本。 */
interface DayStep {
  text: string
  absDate: { year: number; month: number; day: number } | null
  dayShift: number | null
  weekdayInfo: { weekday: number; nextWeek: boolean } | null
  /** 是否给了完整年份——只给"10-15"时要判跨年顺延（见 resolveAbsDate）。 */
  hasFullYear: boolean
}

/** 第 4 步的状态：时刻（HH:MM / 9点半 / 9点）与剥完的文本。 */
interface ClockStep {
  text: string
  hour: number | null
  minute: number
  hasMinute: boolean
}

/** 第 1 步：周期。句中出现"每天/每日"→ daily，"每周/每星期"→ weekly。 */
function extractRepeat(raw: string): { text: string; repeat: Repeat } {
  let repeat: Repeat = 'none'
  if (/每(天|日)/.test(raw)) repeat = 'daily'
  else if (/每(周|星期|礼拜|个?星期)/.test(raw)) repeat = 'weekly'
  // 注意：只剥"每"字，把"周一"这种星期词留给第 3 步 —— 剥掉"每"之后
  // "每周一晚上8点" 还是认不出星期几，那样"每周X"的锚点就丢了。
  return { text: raw.replace(/每/g, ''), repeat }
}

/** 第 2 步：相对时间优先剥离，含"后"的表达式语义最明确，不能被"下午"的"后"搅乱。 */
function stripRelative(text: string): { text: string; offsetMs: number } {
  let offsetMs = 0
  const rel = /(\d+)\s*(秒钟|秒|分钟|分|小时|钟头|个小时|天|日|个?星期|周)/.exec(text)
  if (rel !== null && /后|之后|以后/.test(text.replace(rel[0], ''))) {
    const amount = Number(rel[1])
    const unit = rel[2]!
    if (/秒/.test(unit)) offsetMs = amount * 1000
    else if (/分/.test(unit)) offsetMs = amount * 60_000
    else if (/小时|钟头/.test(unit)) offsetMs = amount * 3_600_000
    else if (/星期|周/.test(unit)) offsetMs = amount * WEEK_MS
    else offsetMs = amount * DAY_MS
    text = text.replace(rel[0], '').replace(/之后|以后|后/g, '')
  }
  return { text, offsetMs }
}

/** 第 3 步：绝对日期（2026-10-15 / 10-15 / 10月15日 / 15号）或相对日（今天/明天/后天/周X）。 */
function extractDay(text: string, now: Date): DayStep {
  let absDate: DayStep['absDate'] = null
  let dayShift: number | null = null
  let weekdayInfo: DayStep['weekdayInfo'] = null
  let hasFullYear = false
  const full = /(?:^|[^\d])(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(text)
  const short = /(?:^|[^\d])(\d{1,2})[-/.](\d{1,2})(?![-\d])/.exec(text)
  const cnDate = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/.exec(text)
  const dayOnly = /(\d{1,2})\s*[日号]/.exec(text)
  if (full !== null) {
    absDate = { year: Number(full[1]), month: Number(full[2]), day: Number(full[3]) }
    hasFullYear = true
    text = text.replace(full[0], ' ')
  } else if (cnDate !== null) {
    absDate = { year: now.getFullYear(), month: Number(cnDate[1]), day: Number(cnDate[2]) }
    text = text.replace(cnDate[0], ' ')
  } else if (short !== null) {
    absDate = { year: now.getFullYear(), month: Number(short[1]), day: Number(short[2]) }
    text = text.replace(short[0], ' ')
  } else if (dayOnly !== null) {
    absDate = { year: now.getFullYear(), month: now.getMonth() + 1, day: Number(dayOnly[1]) }
    text = text.replace(dayOnly[0], ' ')
  } else {
    weekdayInfo = extractWeekday(text)
    if (weekdayInfo !== null) text = text.replace(/(?:下周|下个星期|下个礼拜|周|星期|礼拜)[一二三四五六日天1-7]/g, ' ')
    else if (/(后天)/.test(text)) { dayShift = 2; text = text.replace(/后天/g, ' ') }
    else if (/(明天|明日|明早|明晚|明儿|明个)/.test(text)) { dayShift = 1; text = text.replace(/明天|明日|明早|明晚|明儿|明个/g, ' ') }
    else if (/(今天|今日|今早|今晚|今儿)/.test(text)) { dayShift = 0; text = text.replace(/今天|今日|今早|今晚|今儿/g, ' ') }
  }
  return { text, absDate, dayShift, weekdayInfo, hasFullYear }
}

/** 第 4 步：时刻。HH:MM 优先，其次"9点半/9点15分"，再次"9点"。 */
function extractClock(text: string): ClockStep {
  let hour: number | null = null
  let minute = 0
  let hasMinute = false
  const hm = /(\d{1,2})\s*[:：]\s*(\d{1,2})/.exec(text)
  const cn = /(\d{1,2})\s*点(?:\s*(\d{1,2})\s*分?|半|一刻)?/.exec(text)
  if (hm !== null) {
    hour = Number(hm[1])
    minute = Number(hm[2])
    hasMinute = true
    text = text.replace(hm[0], ' ')
  } else if (cn !== null) {
    hour = Number(cn[1])
    if (cn[2] !== undefined) {
      minute = Number(cn[2])
      hasMinute = true
    } else if (cn[0].includes('半')) {
      minute = 30
      hasMinute = true
    } else if (cn[0].includes('一刻')) {
      minute = 15
      hasMinute = true
    }
    text = text.replace(cn[0], ' ')
  }
  return { text, hour, minute, hasMinute }
}

/**
 * 解析中文/数字时间写法 → 绝对时间戳。纯本地规则，不调 LLM。
 *
 * @returns null 表示认不出来（调用方应该让模型改用显式时间工具）。
 */
export function parseWhen(input: string, now = new Date()): { at: number; repeat: Repeat; note: string } | null {
  const raw = String(input ?? '').trim()
  if (raw === '') return null

  const repeated = extractRepeat(raw)
  const rel = stripRelative(repeated.text)
  const day = extractDay(rel.text, now)
  const clock = extractClock(day.text)

  const prefixPeriod = periodFromPrefix(raw)
  const period = prefixPeriod ?? (clock.hour !== null ? periodFromTimeOfDay(raw, clock.hour) : null)

  if (rel.offsetMs > 0) {
    const at = now.getTime() + rel.offsetMs
    return { at, repeat: repeated.repeat, note: buildNote(at, now, repeated.repeat) }
  }

  if (day.absDate !== null) return resolveAbsDate(now, repeated.repeat, day.absDate, day.hasFullYear, clock, period)
  if (day.weekdayInfo !== null) return resolveWeekday(now, repeated.repeat, day.weekdayInfo, clock, period)
  return resolveClockOnly(now, repeated.repeat, day.dayShift, clock, period)
}

/** 出口 1：绝对日期（越界即拒）；只给"10-15"没给年份时，别把已经过去的日期放到去年（过年场景）。 */
function resolveAbsDate(
  now: Date,
  repeat: Repeat,
  absDate: { year: number; month: number; day: number },
  hasFullYear: boolean,
  clock: ClockStep,
  period: Period | null,
): { at: number; repeat: Repeat; note: string } | null {
  if (absDate.month < 1 || absDate.month > 12 || absDate.day < 1 || absDate.day > 31) return null
  const anchor = PERIOD_ANCHOR[period ?? 'morning']
  const useHour = clock.hour === null ? anchor : (resolveHour(clock.hour, period) ?? anchor)
  const at = new Date(absDate.year, absDate.month - 1, absDate.day, useHour, clock.minute, 0, 0)
  if (!hasFullYear && at.getTime() < now.getTime() - DAY_MS) at.setFullYear(at.getFullYear() + 1)
  return { at: at.getTime(), repeat, note: buildNote(at.getTime(), now, repeat) }
}

/** 出口 2：周几。每周X 的"X"是周期锚点：首次就从那天开始，别因为"今天正好也是那一刻"提前开跑。 */
function resolveWeekday(
  now: Date,
  repeat: Repeat,
  info: { weekday: number; nextWeek: boolean },
  clock: ClockStep,
  period: Period | null,
): { at: number; repeat: Repeat; note: string } {
  const anchor = PERIOD_ANCHOR[period ?? 'morning']
  const useHour = clock.hour === null ? anchor : (resolveHour(clock.hour, period) ?? anchor)
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), useHour, clock.hasMinute ? clock.minute : 0, 0, 0)
  const delta = (info.weekday + 7 - at.getDay()) % 7
  at.setDate(at.getDate() + delta + (info.nextWeek ? 7 : 0))
  if (at.getTime() <= now.getTime() && !(repeat === 'weekly' && info.weekday === at.getDay())) {
    at.setDate(at.getDate() + 7)
  }
  return { at: at.getTime(), repeat, note: buildNote(at.getTime(), now, repeat) }
}

/** 出口 3：只说了时间段（"明早"/"半夜"）没给点数：用该时间段的锚点小时。 */
function resolveClockOnly(
  now: Date,
  repeat: Repeat,
  dayShiftIn: number | null,
  clock: ClockStep,
  period: Period | null,
): { at: number; repeat: Repeat; note: string } | null {
  let dayShift = dayShiftIn
  if (clock.hour === null && dayShift === null && period !== null) dayShift = 0
  if (clock.hour === null && dayShift === null) return null
  if (clock.minute > 59 || clock.minute < 0) return null

  const anchor = PERIOD_ANCHOR[period ?? 'morning']
  const useHour = clock.hour === null ? anchor : (resolveHour(clock.hour, period) ?? anchor)
  const at = resolveDay(now, dayShift ?? 0, useHour, clock.hasMinute ? clock.minute : 0)
  return { at, repeat, note: buildNote(at, now, repeat) }
}
