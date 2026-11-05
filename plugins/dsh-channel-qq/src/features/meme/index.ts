/** 表情包配字子插件（P5.1）：ffmpeg drawtext 现场配字，只注册工具面。 */

import { registerMemeTools } from './tools.js'
import type { SubPlugin } from '../plugin-kit.js'

export const memePlugin: SubPlugin = {
  name: 'meme',
  watches: [],
  requires: ['platform'],
  apply(host) {
    const { api, out } = host.need('platform')
    return registerMemeTools(host.bridge.toolHost(), host.config, api, out, host.log)
  },
}
