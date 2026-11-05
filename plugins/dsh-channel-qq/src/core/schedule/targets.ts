/** 事件书的 `target` → 房间键（P6f）：纯函数，零 IO。
 *
 * 事件书是数据，`target` 是它指名"这条要往哪儿发"的写法（05 §9.2 的四种）。
 * 房间键的拼法必须与 `core/room.ts` 完全一致（`group-123` / `dm-456`）——后台
 * 看到的、日志里印的、会话注册表里查的，是同一个字符串，不能各自拼一份。
 *
 * 解析失败返回**具名原因**而不是 null：这个原因会进日志与状态（`target:没配置主群`），
 * 配错时能一眼看出是哪一边缺了，不用去猜"为什么这条事件从来不跑"。
 */

import { dmRoom, groupRoom } from '../room.js'

/** 解析 target 需要的两个号（都来自配置；没配就是 null）。 */
export interface TargetDirectory {
  readonly primaryGroup: number | null
  /** 主人（`admins[0]`）；没配为 null。 */
  readonly masterId: number | null
}

export type TargetResolution =
  | { readonly ok: true; readonly room: string }
  | { readonly ok: false; readonly reason: string }

const EXPLICIT = /^(group|dm):(\d+)$/

/** 四种 target：`primary-group` / `master-dm` / `group:<号>` / `dm:<号>`。 */
export function resolveTarget(target: string, dir: TargetDirectory): TargetResolution {
  if (target === 'primary-group') {
    return dir.primaryGroup === null
      ? { ok: false, reason: '没配置主群（primaryGroup）' }
      : { ok: true, room: groupRoom(dir.primaryGroup) }
  }
  if (target === 'master-dm') {
    return dir.masterId === null
      ? { ok: false, reason: '没配置主人（admins 为空）' }
      : { ok: true, room: dmRoom(dir.masterId) }
  }
  const match = EXPLICIT.exec(target)
  if (match === null) return { ok: false, reason: `认不出的 target「${target}」` }
  const id = Number(match[2])
  return { ok: true, room: match[1] === 'group' ? groupRoom(id) : dmRoom(id) }
}
