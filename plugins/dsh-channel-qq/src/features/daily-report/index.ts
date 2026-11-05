/** 群日报子插件（B1）：定时器 + 手动触发 + 上次发送记录。 */

import * as path from 'node:path'
import { JsonStore } from '../../adapters/fs-store/json-store.js'
import { localDayKey } from '../../core/schedule/stamp.js'
import { DailyReport } from './service.js'
import type { SubPlugin } from '../plugin-kit.js'

/** 检查间隔：每分钟一拍，命中 HH:MM 才发。 */
const TICK_MS = 30_000

interface LastRun { day: string; at: number }

export const dailyReportPlugin: SubPlugin = {
  name: 'daily-report',
  watches: ['dailyReport'],
  requires: ['platform', 'history'],
  async apply(host) {
    const store = new JsonStore<LastRun>(path.join(host.dshHome, 'channel-qq', 'daily-report.json'), { log: host.log })
    let last = await store.load({ day: '', at: 0 })
    const report = new DailyReport({
      api: () => host.get('platform')?.api ?? null,
      out: () => host.get('platform')?.out ?? null,
      history: () => host.get('history') ?? null,
      config: () => host.config.dailyReport,
      primaryGroup: () => host.config.primaryGroup,
      now: () => Date.now(),
      log: host.log,
    })
    const maybeSend = async (force: boolean): Promise<{ sent: boolean; reason?: string }> => {
      const config = host.config.dailyReport
      if (!force) {
        if (!config.enabled) return { sent: false, reason: 'disabled' }
        const now = new Date()
        const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
        const day = localDayKey(now)
        if (hhmm !== config.time || last.day === day) return { sent: false, reason: 'not-due' }
      }
      const result = await report.run(undefined, force)
      if (!result.sent) return { sent: false, reason: result.reason }
      last = { day: localDayKey(new Date()), at: Date.now() }
      await store.save(last).catch(() => {})
      return { sent: true }
    }
    host.registerResource('daily-report', {
      label: '群日报',
      list: () => ({ enabled: host.config.dailyReport.enabled, time: host.config.dailyReport.time, target: host.config.dailyReport.target, lastDay: last.day }),
      actions: { run: async () => await maybeSend(true) },
    })
    const timer = setInterval(() => { void maybeSend(false).catch((error: unknown) => host.log(`daily-report: ${error instanceof Error ? error.message : String(error)}`)) }, TICK_MS)
    timer.unref?.()
    return () => { clearInterval(timer) }
  },
}
