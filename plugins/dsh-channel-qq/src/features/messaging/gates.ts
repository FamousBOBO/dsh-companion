/** 发送前三道闸门：窗口 / 内容 / 目标。
 *
 * 它们原来内联在 `qq_send_text` 的 run 里，一个函数 67 行、四件事混在一起：
 * "窗口对不对""内容能不能进群""目标合不合法"和"发"。拆成三个函数之后，每一道
 * 闸门都能单独读、单独测，而 `qq_send_text` 只剩"取文本 → 过闸门 → 发"。
 *
 * 单独放在一个文件里是体量的原因：`tools.ts` 有 400 行硬上限
 * （`scripts/check-size.mjs`），而这三道闸门的注记（两条禁令各是一次事故的判据）
 * 必须留在代码旁边——搬走可以，删掉不行。
 */

import { looksLikeCode } from '../../core/guards/code.js'
import { isInnerMonologueLeak } from '../../core/guards/monologue.js'
import type { QQToolDeps } from '../tool-deps.js'

/**
 * 闸门 1：**窗口存在吗**。
 *
 * 先问 QQ"这个群/这个人是不是真的"，再发——发错窗口是大事故（见
 * `core/room.ts` 里 2026-10-14 那次误发的记录）。群要能查到群名，私聊要求对方
 * 是好友或者是主人本人。
 */
export async function assertWindowReachable(deps: QQToolDeps, args: Record<string, unknown>): Promise<void> {
  const { api, config } = deps
  if (args.isGroup === true) {
    const gi = await api.getGroupInfo(Number(args.target)).catch(() => null) as { group_name?: string } | null
    if (!gi || !gi.group_name) throw new Error(`窗口验证失败：群 ${args.target} 不存在或不可达。别发了，先核对窗口。`)
    return
  }
  const target = Number(args.target)
  // 本地补丁 COMPANION-QQ-PATCH-8：目标是管理员（主人本人）时**不拉好友表**。
  // 上游无条件先 `getFriendList()`，那是一次 8 秒超时 + 最多 12 秒重连宽限的往返，
  // 实测让每条私聊在**发出第一条消息之前**空转约 24 秒（2026-10-31 实测：turn 的
  // 工具耗时 27–33 秒，其中 23.5–24.6 秒都花在这一步之前）。而对主人发消息本来就
  // 被 `assertTargetAllowed()` 的「只发管理员」规则覆盖，好友表在这条路径上没有
  // 任何额外信息量。
  if (config.admins.map(Number).includes(target)) return
  const friend = await friendListHas(deps, target)
  if (!friend) {
    throw new Error(`窗口验证失败：${args.target} 不是我的好友也不是主人。别给陌生人发私聊。`)
  }
}

/** 好友表缓存（COMPANION-QQ-PATCH-8）：5 分钟内复用，避免每条非管理员私聊都打一次慢接口。 */
let friendCache: { at: number; ids: Set<number> } | null = null
const FRIEND_CACHE_MS = 5 * 60_000

async function friendListHas(deps: QQToolDeps, target: number): Promise<boolean> {
  if (friendCache !== null && Date.now() - friendCache.at < FRIEND_CACHE_MS) return friendCache.ids.has(target)
  const raw = await deps.api.getFriendList().catch(() => null) as Array<{ user_id?: number }> | null
  if (!Array.isArray(raw)) return false
  const ids = new Set<number>()
  for (const entry of raw) {
    const id = Number(entry?.user_id)
    if (Number.isFinite(id)) ids.add(id)
  }
  friendCache = { at: Date.now(), ids }
  return ids.has(target)
}

/**
 * 闸门 2：**这段内容能进群吗**。
 *
 * 三条禁令各有来历：
 *   - **代码不进群**：群聊里贴代码既刷屏又容易泄露工作区内容，让她改成私信主人审核；
 *   - **内心戏不进群**：一次真实事故——她决定"本轮先不说话"，然后把这个决定本身
 *     当成消息发了出去（判据见 `core/guards/monologue.ts`）；
 *   - **长文不进群**（2026-11-06）：群聊和私聊的规矩不一样。私聊可以写长、可以分段，
 *     群聊整轮正文默认上限 120 字，超了直接拒；允许在这份总预算内自然拆成最多三条。
 */
export const GROUP_TEXT_MAX_CHARS = 120

export function assertGroupTextLength(text: string,maxChars=GROUP_TEXT_MAX_CHARS): void {
  const length = [...text].length
  if (length <= maxChars) return
  throw new Error(`群聊一轮不超过 ${String(maxChars)} 字（现在是 ${String(length)} 字）。可自然分成一至三条短消息，总正文仍需简短。`)
}

export function assertGroupTextAllowed(deps: QQToolDeps, text: string, isGroup: boolean): void {
  if (!isGroup) return
  if (looksLikeCode(text)) {
    throw new Error('群聊禁止发代码。请改用 qq_send_code_review 把代码私信给主人审核，群里只回一句"已私信主人审核"。')
  }
  if (isInnerMonologueLeak(text)) {
    deps.log(`blocked inner-monologue leak: ${text.slice(0, 40)}`)
    throw new Error('这条是我的内部盘算/舞台指示，不是要说的话，已拦下。要么把真正要对群里说的那句话发出来，要么不调用任何发送工具直接结束回合。')
  }
  assertGroupTextLength(text,deps.config.segmentation.groupMaxChars??GROUP_TEXT_MAX_CHARS)
}

/**
 * 闸门 3：**目标合不合法**。
 *
 * 群必须是**我确实是成员**的群（`knownGroups` 缓存了 `get_group_list`）；私聊只发
 * 管理员。这里以前只认 `[config.primaryGroup]`，于是除主群以外的群一律抛错——而
 * `qq_reply_quote` 用的是"群真实存在即可"，同一个动作两套规则、互相矛盾。
 */
export async function assertTargetAllowed(deps: QQToolDeps, args: Record<string, unknown>): Promise<void> {
  const { config } = deps
  if (args.isGroup === true) {
    const target = Number(args.target)
    const known = await deps.knownGroups()
    if (!known.has(target)) {
      throw new Error(`目标群 ${target} 不是我加入的群（已知：${[...known].join(',') || '无'}）。发错窗口是大事故，先核对。`)
    }
    return
  }
  const master = config.admins[0]
  if (master !== undefined && Number(args.target) !== master && !config.admins.includes(Number(args.target))) {
    throw new Error(`私聊目标 ${args.target} 不是管理员。除主人外不要私聊陌生人。`)
  }
}
