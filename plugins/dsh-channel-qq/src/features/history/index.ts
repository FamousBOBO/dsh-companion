/** 服务端历史子插件（A4）：按房间落盘，供检索与群日报复用。 */

import * as path from 'node:path'
import { HistoryService } from './service.js'
import { HistoryStore } from './store.js'
import type { SubPlugin } from '../plugin-kit.js'

export const historyPlugin: SubPlugin = {
  name: 'history',
  watches: ['history'],
  requires: ['platform'],
  async apply(host) {
    const dir = path.join(host.dshHome, 'channel-qq', 'history')
    const store = new HistoryStore(dir, host.log)
    const service = new HistoryService({
      api: () => host.get('platform')?.api ?? null,
      config: () => host.config.history,
      store,
      now: () => Date.now(),
      log: host.log,
    })
    host.provide('history', service)
    host.registerResource('history', {
      label: '服务端历史',
      list: async () => {
        const rooms = ['group-' + String(host.config.primaryGroup ?? 'none')]
        const counts: Record<string, number> = {}
        for (const room of rooms) counts[room] = await service.count(room)
        return { enabled: host.config.history.serverBackfill, counts }
      },
    })
  },
}
