/** QQ 工具面子插件（P5.1）：把十组核心工具（57 个）接起来注册。
 *
 * 为什么仍是"一整组"：注册顺序属于提示词内容（见 `../qq-tools.js` 的
 * `REGISTRATION_ORDER`），而那张顺序表是跨组交错的——拆成十个子插件会把
 * 历史顺序打散，等于换一份系统提示词。P6d 重新设计工具面（86 → 17）时
 * 再按新顺序拆。
 *
 * 依赖的五个服务都是**注册时就取**的（工具闭包直接引用它们），所以写进
 * `requires`；它们分别由 stickers / memory / affection / inbound 提供，
 * 装载顺序见 `src/sections.ts`。
 */

import { registerQQTools } from './register.js'
import type { SubPlugin } from '../plugin-kit.js'

export const qqToolsPlugin: SubPlugin = {
  name: 'qq-tools',
  // 工具面在注册时就定死：这两个开关一变必须重挂，否则后台标着「自动重载」却要等重启。
  //   - tools.v2：58 个旧工具是上宿主还是被收编成 17 个合并工具；
  //   - memory.v2：qq_recall_memory / qq_memory_search 拿到的是结构化服务还是旧库。
  watches: ['tools.v2', 'memory.v2', 'imageRecognition.serverOcr'],
  requires: ['platform', 'emoji', 'affection', 'sentLog', 'knowledge'],
  apply(host) {
    const { config } = host
    const { api, out } = host.need('platform')
    const library = host.need('emoji').library
    const affection = host.need('affection')
    const sentLog = host.need('sentLog')
    const sentLogHub = host.get('sentLogHub')
    const { store: knowledge, extract } = host.need('knowledge')
    return registerQQTools(
      host.bridge.toolHost(), config, api, out, host.log, library, affection, sentLog, knowledge, extract,
      host.get('memory'), host.get('memorySearch'), sentLogHub, host.get('history'),
    )
  },
}
