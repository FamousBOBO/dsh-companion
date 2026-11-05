/** 生图子插件（P5.1）：群内 AI 生图，只注册工具面。
 *
 * 注册函数需要平台端口（连接状态决定注册时的一行日志），所以取 `platform`
 * 而不是只取 `api`。
 */

import { registerImageGenTools } from './tools.js'
import type { SubPlugin } from '../plugin-kit.js'

export const imagegenPlugin: SubPlugin = {
  name: 'imagegen',
  watches: [],
  requires: ['platform'],
  apply(host) {
    const { platform, out } = host.need('platform')
    return registerImageGenTools(host.bridge.toolHost(), host.config, platform, out, host.log)
  },
}
