/** 人物档子插件：按房间记录"一个人怎么说话"的手动笔记。
 *
 * 工具侧：`qq_person_note` 支持 get / set / list（默认关，`people.enabled`
 * 为 true 才注册，golden 工具快照不含它）。
 */

import { registerPeopleTools } from './tools.js'
import type { SubPlugin } from '../plugin-kit.js'

export const peoplePlugin: SubPlugin = {
  name: 'people',
  watches: ['people'],
  apply(host) {
    return registerPeopleTools(host.bridge.toolHost(), host.config, host.log)
  },
}
