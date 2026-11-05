/** 刷屏风控子插件（P5.1）：判定器 + 工具面。
 *
 * 判定器随本插件出现（构造时起清扫定时器，unref 掉），旁路观察经 `flood`
 * 服务取值函数取用；卸载时必须 dispose，否则清扫定时器挂着不放。
 */

import { FloodGuard } from './guard.js'
import { registerFloodTools } from './tools.js'
import type { SubPlugin } from '../plugin-kit.js'

export const floodPlugin: SubPlugin = {
  name: 'flood',
  watches: [],
  requires: ['platform'],
  apply(host) {
    const guard = new FloodGuard(host.config, host.log)
    host.provide('flood', guard)
    const { api, out } = host.need('platform')
    const disposeTools = registerFloodTools(host.bridge.toolHost(), host.config, api, out, host.log, guard)
    return () => {
      disposeTools()
      guard.dispose()
    }
  },
}
