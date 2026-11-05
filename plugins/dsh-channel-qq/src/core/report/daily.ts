/** 群日报的纯渲染（B1）：一组历史条目 → 一段文字。
 *
 * 不读时钟、不碰 IO；"今天几点到几点"由调用方算好传进来。
 */

export interface ReportEntry {
  readonly userId: number
  readonly name: string
  readonly time: number
  readonly text: string
}

export interface DailyReport {
  readonly messages: number
  readonly people: number
  readonly topSenders: ReadonlyArray<{ readonly name: string; readonly count: number }>
  readonly quotes: readonly string[]
}

/** 统计 + 挑金句（长而有内容的句子，去重，最多 3 条）。 */
export function buildDailyReport(entries: readonly ReportEntry[], top = 5): DailyReport {
  const senders = new Map<string, { name: string; count: number }>()
  for (const entry of entries) {
    const key = String(entry.userId)
    const row = senders.get(key) ?? { name: entry.name === '' ? key : entry.name, count: 0 }
    row.count += 1
    senders.set(key, row)
  }
  const topSenders = [...senders.values()]
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, top)
  const quotes: string[] = []
  const seen = new Set<string>()
  for (const entry of [...entries].sort((a, b) => b.text.length - a.text.length)) {
    const text = entry.text.replace(/\s+/g, ' ').trim()
    if (text.length < 8 || seen.has(text)) continue
    seen.add(text)
    quotes.push(text.slice(0, 80))
    if (quotes.length >= 3) break
  }
  return { messages: entries.length, people: senders.size, topSenders, quotes }
}

/** 渲染成一条可直接发出去的文字日报。 */
export function renderDailyReport(day: string, stats: DailyReport): string {
  const lines = [
    `【群日报 ${day}】`,
    `消息 ${stats.messages} 条 · 参与 ${stats.people} 人`,
  ]
  if (stats.topSenders.length > 0) {
    lines.push('最活跃：' + stats.topSenders.map((row) => `${row.name}(${row.count})`).join('、'))
  }
  if (stats.quotes.length > 0) {
    lines.push('金句：')
    stats.quotes.forEach((quote, index) => lines.push(`${index + 1}. ${quote}`))
  }
  if (stats.messages === 0) lines.push('（今天还没有消息）')
  return lines.join('\n')
}
