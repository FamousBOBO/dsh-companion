/** 会话视角：把宿主 session id 还原成"哪个房间、谁在说话"。
 *
 * 技能可见范围是**按房间现算**的，所以每次工具调用/触发都要这一步。发起人身份
 * 不来自消息文字，而来自信任账本（`turnTrust`）——它由组包与提交流程落账，
 * 与工具闸门读的是同一份。
 */

import { SESSION_PREFIX, splitRoom } from '../../core/room.js'
import { turnTrust } from '../../core/trust.js'
import type { SkillViewer } from '../../core/skills/model.js'

/** 会话 id → 视角。系统回合（没有 `qq-` 前缀）只看得见全局技能。 */
export function viewerOf(sessionId: string, admins: readonly number[]): SkillViewer {
  if (!sessionId.startsWith(SESSION_PREFIX)) {
    return { room: null, userId: null, isAdmin: false, admins }
  }
  const room = sessionId.slice(SESSION_PREFIX.length)
  const parsed = splitRoom(room)
  const trust = turnTrust.get(sessionId)
  const isAdmin = trust === 'master' || trust === 'admin'
  return {
    room,
    userId: parsed !== null && !parsed.isGroup ? parsed.chatId : null,
    isAdmin,
    admins,
  }
}
