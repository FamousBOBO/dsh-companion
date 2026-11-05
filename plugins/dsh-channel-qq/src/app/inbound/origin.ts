/** 入站消息的发起人：群友 / 私聊对象。回合账本用它判断"谁让这一轮跑起来的"。 */

import type { OneBotEvent } from '../../types.js'
import type { TurnOrigin } from '../conversation/origins.js'

export function userOrigin(event: OneBotEvent): TurnOrigin {
  return { kind: 'user', userId: event.user_id ?? 0 }
}
