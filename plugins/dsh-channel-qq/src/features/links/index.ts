/** 链接卡片子插件（P5.1）：四个站点的解析器 + 工具面。
 *
 * 自动出卡（白名单群）不走这里，是 observers 的旁路工作（`autoResolveLinks`）；
 * 本插件只注册工具面。
 */

import { registerLinkTools } from './tools.js'
import type { SubPlugin } from '../plugin-kit.js'

export const linksPlugin: SubPlugin = {
  name: 'links',
  watches: [],
  requires: ['platform'],
  apply(host) {
    const { api, out } = host.need('platform')
    return registerLinkTools(host.bridge.toolHost(), host.config, api, out, host.log)
  },
}
