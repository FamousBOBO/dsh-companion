/** 语音子插件（P5.1）：edge-tts 免 key 音色 → 语音条，只注册工具面。
 *
 * 语音转写（STT）不在这里——那是入站图片/语音处理的一部分，由 inbound 装配。
 */

import { registerTtsTools } from './tts.js'
import type { SubPlugin } from '../plugin-kit.js'

export const voicePlugin: SubPlugin = {
  name: 'voice',
  watches: [],
  requires: ['platform'],
  apply(host) {
    const { api, out } = host.need('platform')
    return registerTtsTools(host.bridge.toolHost(), host.config, api, out, host.log)
  },
}
