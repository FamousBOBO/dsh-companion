/** 指标子插件（C1/C2）：采集、落盘、给后台「指标」页供数。
 *
 * 数据只在本机（`<dshHome>/channel-qq/metrics.json`）；开关关着时不采集、不写盘。
 */

import * as path from 'node:path'
import { aggregateMetrics } from '../../core/metrics/aggregate.js'
import { localDayKey } from '../../core/schedule/stamp.js'
import { MetricsService } from './service.js'
import { MetricsStore } from './store.js'
import type { SubPlugin } from '../plugin-kit.js'

/** flush 间隔：回合频率低，30 秒合并一次足够。 */
const FLUSH_MS = 30_000

export const metricsPlugin: SubPlugin = {
  name: 'metrics',
  watches: ['metrics'],
  requires: ['platform'],
  async apply(host) {
    const file = path.join(host.dshHome, 'channel-qq', 'metrics.json')
    const store = new MetricsStore(file, host.log)
    await store.load()
    const service = new MetricsService({
      enabled: () => host.config.metrics.enabled,
      now: () => Date.now(),
      usage: () => host.bridge.usage?.(),
      store,
      log: host.log,
    })
    host.provide('metrics', service)
    host.registerResource('metrics', {
      label: '指标',
      list: () => {
        const now = Date.now()
        const aggregate = aggregateMetrics(store.list(), now, (at) => localDayKey(new Date(at)), 7)
        const tools = host.bridge.toolStats?.() ?? { calls: 0, failures: 0 }
        return {
          enabled: host.config.metrics.enabled,
          samples: store.list().length,
          counters: { ...service.counters(), toolCalls: tools.calls, toolFailures: tools.failures },
          ...aggregate,
        }
      },
    })
    const timer = setInterval(() => { void store.flush() }, FLUSH_MS)
    timer.unref?.()
    return () => {
      clearInterval(timer)
      void store.flush()
    }
  },
}
