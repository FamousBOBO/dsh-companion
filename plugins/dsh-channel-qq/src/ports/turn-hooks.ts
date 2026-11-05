/** 回合生命周期钩子（A1）。
 *
 * 交互提示（输入状态 / 表情回应）需要在"一个回合开始/结束"这两个时刻做动作，而
 * 回合状态归 `app/conversation` 管。把这两个时刻收成一个端口之后：
 *
 *   - `app/` 只认这个接口，不知道 QQ 动作、不知道表情 id；
 *   - `features/interaction/` 实现它，配置关着时整条路径不产生任何协议调用。
 *
 * `begin` 只在**用户消息引起的回合**调用；主动/定时/后台回合没有"对方正等着"这回事。
 */

import type { OneBotEvent } from '../types.js'

export interface TurnHooks {
  /** 一个用户回合刚被提交；`event` 是触发它的那条消息（带 message_id / user_id）。 */
  begin(room: string, event: OneBotEvent): void
  /** 回合结束（成功、失败或会话被释放都会走到）；没开始过的房间应当是空操作。 */
  end(room: string): void
  /** 宿主报错；`kind` 说明还会不会重试，真正的收尾仍走 `end`。 */
  error?(room: string, kind: 'retry' | 'permanent'): void
}
