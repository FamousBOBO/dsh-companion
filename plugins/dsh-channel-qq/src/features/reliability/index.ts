/** 回合告知子插件（A2）。 */

import { Reliability } from './service.js'
import type { SubPlugin } from '../plugin-kit.js'

export const reliabilityPlugin: SubPlugin = {
  name: 'reliability',
  watches: ['reliability'],
  requires: ['platform', 'persona'],
  apply(host) {
    const reliability = new Reliability({
      api: () => host.get('platform')?.api ?? null,
      out: () => host.get('platform')?.out ?? null,
      config: () => host.config.reliability,
      persona: () => host.get('persona')?.pack ?? null,
      log: host.log,
      now: () => Date.now(),
    })
    host.provide('reliability', reliability)
    return () => reliability.dispose()
  },
}
