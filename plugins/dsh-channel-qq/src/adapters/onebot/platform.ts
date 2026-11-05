/** 把一个 `OneBotClient` 包成 `ChatPlatform`（端口实现）。
 *
 * 这是"传输对象"与"业务看到的东西"之间唯一的那道缝。业务代码不该知道
 * WebSocket、心跳、重连、echo 关联的存在；它只该知道"能发消息"和"连上没有"。
 *
 * `selfId` 做成 getter 而不是快照：NapCat 重连之后 selfId 会变，
 * 快照会把旧值一直留在业务里。
 */

import type { OneBotClient } from '../../onebot.js'
import type { ChatPlatform, QQApi } from '../../ports/platform.js'
import { createQQApi } from './qq-api.js'

export function platformOf(client: OneBotClient): ChatPlatform {
  const api: QQApi = createQQApi(client)
  return {
    api,
    get selfId(): number | null {
      return client.selfId
    },
    isConnected: (): boolean => client.isConnected(),
  }
}
