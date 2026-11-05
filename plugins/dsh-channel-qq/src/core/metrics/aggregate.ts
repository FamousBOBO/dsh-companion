/** 指标聚合（C1/C2）：纯函数，输入样本与"现在"，输出页面直接渲染的数字。
 *
 * 为什么放在 `core/`：分位数、时间窗、按房间汇总都是可以逐条测的算术；把它们
 * 埋在后台页里就只能靠肉眼看图。这里不读时钟、不碰 IO——"今天"由 `dayKey` 注入。
 */

/** 一个回合的样本（metrics.jsonl 的一行）。 */
export interface MetricSample {
  readonly at: number
  readonly room: string
  readonly ms: number
  /** 这一轮是否以网关错误收场（重试成功后仍算失败，失败率看的是可靠性）。 */
  readonly ok: boolean
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

export interface UsageTotals {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

export interface RoomMetrics extends UsageTotals {
  readonly room: string
  readonly turns: number
  readonly failed: number
  readonly p50: number
  readonly p90: number
}

export interface DayMetrics extends UsageTotals {
  readonly day: string
  readonly turns: number
}

export interface MetricsAggregate extends UsageTotals {
  readonly turns: number
  readonly failed: number
  readonly p50: number
  readonly p90: number
  readonly rooms: readonly RoomMetrics[]
  readonly days: readonly DayMetrics[]
}

/** 最近邻分位数（0–100）。空数组返回 0。 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.ceil((Math.min(100, Math.max(0, p)) / 100) * sorted.length) - 1
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))] ?? 0
}

const DAY_MS = 86_400_000

/** 按房间与天聚合最近 `days` 天；`dayKey` 决定"一天"的边界（本地时区由调用方给）。 */
export function aggregateMetrics(
  samples: readonly MetricSample[],
  now: number,
  dayKey: (at: number) => string,
  days = 7,
): MetricsAggregate {
  const since = now - days * DAY_MS
  const window = samples.filter((sample) => sample.at >= since)
  const empty: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const rooms = new Map<string, MetricSample[]>()
  const daysMap = new Map<string, MetricSample[]>()
  const totals = { ...empty, turns: 0, failed: 0, ms: [] as number[] }
  for (const sample of window) {
    rooms.set(sample.room, [...(rooms.get(sample.room) ?? []), sample])
    const key = dayKey(sample.at)
    daysMap.set(key, [...(daysMap.get(key) ?? []), sample])
    totals.turns += 1
    if (!sample.ok) totals.failed += 1
    totals.ms.push(sample.ms)
    totals.input += sample.input
    totals.output += sample.output
    totals.cacheRead += sample.cacheRead
    totals.cacheWrite += sample.cacheWrite
  }
  const roomRows: RoomMetrics[] = [...rooms.entries()]
    .map(([room, list]) => ({
      room,
      turns: list.length,
      failed: list.filter((sample) => !sample.ok).length,
      p50: percentile(list.map((sample) => sample.ms), 50),
      p90: percentile(list.map((sample) => sample.ms), 90),
      ...sumUsage(list),
    }))
    .sort((a, b) => b.turns - a.turns)
  const dayRows: DayMetrics[] = []
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const key = dayKey(now - offset * DAY_MS)
    const list = daysMap.get(key) ?? []
    dayRows.push({ day: key, turns: list.length, ...sumUsage(list) })
  }
  return {
    turns: totals.turns,
    failed: totals.failed,
    p50: percentile(totals.ms, 50),
    p90: percentile(totals.ms, 90),
    input: totals.input,
    output: totals.output,
    cacheRead: totals.cacheRead,
    cacheWrite: totals.cacheWrite,
    rooms: roomRows,
    days: dayRows,
  }
}

function sumUsage(samples: readonly MetricSample[]): UsageTotals {
  const out = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  for (const sample of samples) {
    out.input += sample.input
    out.output += sample.output
    out.cacheRead += sample.cacheRead
    out.cacheWrite += sample.cacheWrite
  }
  return out
}
