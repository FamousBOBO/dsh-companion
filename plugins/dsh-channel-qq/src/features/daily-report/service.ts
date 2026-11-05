/** 群日报（B1）：拉当天历史 → 统计 → 发一条文字。
 *
 * 数据用 `history.collect`（强制回源，不看检索开关），只写 history 仓库；
 * 发送走同一个出站队列（限速/失败日志与其它消息一致）。
 */

import { splitRoom, groupRoom, dmRoom } from '../../core/room.js'
import { buildDailyReport, renderDailyReport, type ReportEntry } from '../../core/report/daily.js'
import { localDayKey } from '../../core/schedule/stamp.js'
import type { QQChannelConfig } from '../../config.js'
import type { HistoryService } from '../history/service.js'
import type { QQApi } from '../../ports/platform.js'
import type { OutboundQueue } from '../../outbound.js'

export interface DailyReportDeps {
  readonly api: () => QQApi | null
  readonly out: () => OutboundQueue | null
  readonly history: () => HistoryService | null
  readonly config: () => QQChannelConfig['dailyReport']
  readonly primaryGroup: () => number | null
  readonly now: () => number
  readonly log: (line: string) => void
}

export interface DailyReportResult {
  readonly sent: boolean
  readonly text?: string
  readonly reason?: string
  readonly room?: string
}

/** 解析 `primary-group` / `group:<号>` / `dm:<号>`。 */
export function targetOf(target: string, primaryGroup: number | null): { room: string; isGroup: boolean; chatId: number } | null {
  const value = target.trim()
  if (value === 'primary-group') {
    return primaryGroup === null ? null : { room: groupRoom(primaryGroup), isGroup: true, chatId: primaryGroup }
  }
  const group = /^group:(\d+)$/.exec(value)
  if (group !== null) return { room: groupRoom(Number(group[1])), isGroup: true, chatId: Number(group[1]) }
  const dm = /^dm:(\d+)$/.exec(value)
  if (dm !== null) return { room: dmRoom(Number(dm[1])), isGroup: false, chatId: Number(dm[1]) }
  return null
}

export class DailyReport {
  constructor(private readonly deps: DailyReportDeps) {}

  /** 生成并发送（`day` 只给测试/手动补发用）。 */
  async run(dayKey?: string, force = false): Promise<DailyReportResult> {
    const config = this.deps.config()
    if (!config.enabled && !force) return { sent: false, reason: 'disabled' }
    const target = targetOf(config.target, this.deps.primaryGroup())
    if (target === null) return { sent: false, reason: 'bad-target' }
    const history = this.deps.history()
    const api = this.deps.api()
    const out = this.deps.out()
    if (history === null || api === null || out === null) return { sent: false, reason: 'unwired' }
    await history.collect(target.room, target.isGroup, target.chatId, 200)
    const day = dayKey ?? localDayKey(new Date(this.deps.now()))
    const entries = (await history.search(target.room, { since: day, until: day }))
      .map((entry): ReportEntry => ({ userId: entry.userId, name: entry.name, time: entry.time, text: entry.text }))
    if (entries.length === 0) return { sent: false, reason: 'no-messages', room: target.room }
    const text = renderDailyReport(day, buildDailyReport(entries))
    await out.push(() => api.sendTo(target.isGroup, target.chatId, [{ type: 'text', data: { text } }]))
    this.deps.log(`daily-report: ${target.room} ${day} 已发送（${entries.length} 条消息）`)
    return { sent: true, text, room: target.room }
  }
}
