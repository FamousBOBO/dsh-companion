/** 人格子插件（P5.1）：人格包 + 组包器。
 *
 * 它们原来在 `ChannelQQ` 构造函数里造——现在归这里，其余子插件经 `persona`
 * 服务取用（inbound 的组包器、proactive 的三段主动文案、通知抬头）。
 * 包目录可用 `CHANNEL_QQ_PERSONA_DIR` 指到别处（见 fs-pack.ts）。
 */

import { createPersonaPack } from '../../adapters/persona/fs-pack.js'
import { PromptComposer } from '../../app/conversation/prompt-composer.js'
import { rewriteLegacyToolNames } from '../tools-v2/mapping.js'
import type { SubPlugin } from '../plugin-kit.js'

export const personaPlugin: SubPlugin = {
  name: 'persona',
  watches: [],
  apply(host) {
    const pack = createPersonaPack()
    host.provide('persona', {
      pack,
      // 房间指令与所有模板都要跟着工具面走：tools.v2 下旧工具名全部作废。
      composer: new PromptComposer(
        pack,
        () => host.config.tools?.v2 === true,
        rewriteLegacyToolNames,
      ),
    })
  },
}
