/** 房间：一次对话的标识（群聊一个、每个私聊对象一个）。
 *
 * 这个字符串的拼法是**承重结构**，不是随手起的名字：同一时刻它同时是
 *
 *   - 会话 id 的后缀（`qq-<key>`，见 `sessionIdOf`）；
 *   - 磁盘上会话目录的名字（`<sessionsRoot>/qq-<key>/`）；
 *   - 后台「重建会话」按钮的入参；
 *   - 定时任务（巡逻 / 做梦 / 早报）落点。
 *
 * 所以改动它等于**把所有人的聊天历史弄丢**（新 id = 新目录 = 新会话）。P3 只把
 * 它从 `bridge.ts` 搬到这里，拼法一个字符没动；要改得等 06 §P7
 * 的运维阶段配一次迁移脚本。
 *
 * 纯函数、零 IO、零宿主依赖：`bridge.ts` 的黄金快照包含这些字符串，
 * 这里写错的代价是快照全红，而不是线上才发现。
 */

import type { OneBotEvent } from '../types.js'

/** 会话 id 的前缀；与磁盘目录名、`qq-` 开头的会话名一致。 */
export const SESSION_PREFIX = 'qq-'

/** 群聊房间键。 */
export function groupRoom(groupId: number): string {
  return `group-${groupId}`
}

/** 私聊房间键。 */
export function dmRoom(userId: number): string {
  return `dm-${userId}`
}

/** 会话 id（宿主侧的 `SessionId`，这里只给字符串；品牌化在 `adapters/dsh-host`）。 */
export function sessionIdOf(room: string): string {
  return `${SESSION_PREFIX}${room}`
}

/** 从一条入站消息推出房间键；既不是群聊也不是私聊时为 `null`。 */
export function roomOf(event: OneBotEvent): string | null {
  if (event.message_type === 'group' && typeof event.group_id === 'number') return groupRoom(event.group_id)
  if (event.message_type === 'private' && typeof event.user_id === 'number') return dmRoom(event.user_id)
  return null
}

/**
 * 房间键 → 它指向哪个房间。
 *
 * 定时任务可能在**任何一条消息到达之前**就触发（刚部署、群里还没人说话），
 * 那时房间记录得凭键本身合成出来，而不是等一条真实消息。
 */
export function splitRoom(room: string): { isGroup: boolean; chatId: number } | null {
  const group = /^group-(\d+)$/.exec(room)
  if (group !== null) return { isGroup: true, chatId: Number(group[1]) }
  const dm = /^dm-(\d+)$/.exec(room)
  if (dm !== null) return { isGroup: false, chatId: Number(dm[1]) }
  return null
}
