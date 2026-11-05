/** 纪念日与生日：让"今天是特殊的一天"成为记忆的一部分（P3）。
 *
 * 调研来源：dsh-relationship 的"礼赠时机/联系人时间线"。我们的范围刻意小：
 * 只认**记忆记录**里的两类标记——`tags` 含 `birthday`（生日）与 `anniversary`
 * （纪念日），日期取 `validFrom` 的月/日（建档那天就是那一天；年不重要，
 * 纪念日年年都是那一天）。人物档（people）的手动生辰走同一个 tag 写进来。
 *
 * 为什么不存独立生日表：数据已经有双时间轴与出处，再开一张表就要回答
 * "两处不一致听谁的"。`qq_person_note` 工具写一条 `tags:['birthday']` 的
 * person 记录，生日就是一条可检索、可审核、可追溯的普通记忆。
 *
 * R8：纯函数，"今天"由参数传进来。
 */

import type { MemoryRecord } from './model.js'

/** 一个今天到期的纪念日。 */
export interface Occasion {
  readonly record: MemoryRecord
  readonly kind: 'birthday' | 'anniversary'
  /** 建档以来过了几个整数年（0 = 今年第一次）；生日用它说"第 N 个"。 */
  readonly years: number
}

/** 本地时区的月日（服务器是 UTC，所以要显式传偏移——与 event-book 同一课）。 */
export function monthDayOf(at: number, tzOffsetMinutes: number): { month: number; day: number } {
  const local = new Date(at + tzOffsetMinutes * 60_000)
  return { month: local.getUTCMonth() + 1, day: local.getUTCDate() }
}

function occasionKind(record: MemoryRecord): 'birthday' | 'anniversary' | null {
  if (record.tags.includes('birthday')) return 'birthday'
  if (record.tags.includes('anniversary')) return 'anniversary'
  return null
}

/**
 * 今天到期的纪念日（`today` 用本地时区的毫秒表示，内部自取月日）。
 *
 * 容差 0：纪念日是"今天"，提前提醒交给主动回合的场景素材，不在这抢戏。
 * 一条记录既标 birthday 又标 anniversary 时按 birthday 算（生日更具体）。
 */
export function dueOccasions(records: readonly MemoryRecord[], today: number, tzOffsetMinutes: number): Occasion[] {
  const now = monthDayOf(today, tzOffsetMinutes)
  const out: Occasion[] = []
  for (const record of records) {
    if (record.status !== 'active') continue
    const kind = occasionKind(record)
    if (kind === null) continue
    const then = monthDayOf(record.validFrom, tzOffsetMinutes)
    if (then.month !== now.month || then.day !== now.day) continue
    out.push({ record, kind, years: yearsBetween(record.validFrom, today) })
  }
  out.sort((a, b) => a.record.id.localeCompare(b.record.id))
  return out
}

function yearsBetween(from: number, to: number): number {
  const a = new Date(from)
  const b = new Date(to)
  let years = b.getUTCFullYear() - a.getUTCFullYear()
  const anniversaryThisYear = new Date(Date.UTC(b.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate()))
  if (anniversaryThisYear.getTime() > to) years -= 1
  return Math.max(0, years)
}

/** 渲染成注入行（与证据块同一风格：说明这是记忆，不是指令）。 */
export function renderOccasions(occasions: readonly Occasion[], renderTime: (at: number) => string): string {
  if (occasions.length === 0) return ''
  const lines = occasions.slice(0, 3).map(({ record, kind, years }) => {
    const what = kind === 'birthday' ? '生日' : '纪念日'
    const nth = years > 0 ? `（第 ${years + 1} 年）` : ''
    return `- ${what}${nth}：${record.content}（${renderTime(record.validFrom)} 记下）`
  })
  return ['[记忆 · 今天的日子]', ...lines].join('\n')
}
