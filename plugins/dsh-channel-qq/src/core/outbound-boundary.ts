/** 出站边界（P1-05）：**不依赖 `policy.v2`** 的授权边界。
 *
 * 为什么单独一层：`policy.v2` 关着时（本 profile 的现状）以前只有三道很软的检查——
 * "私聊只发管理员"（`assertTargetAllowed`）、"群必须是我加入的"、以及高危群管的总闸门
 * `groupAdmin.dangerous`。它们都回答不了这三个问题：
 *
 *   1. 群被**按群关掉**了（`groupEnabled=false` 或 `rooms[].enabled=false`），
 *      工具还能不能往里发、还能不能改群名片/禁言/动群文件？
 *   2. 一个**私聊回合**（可能是陌生人，pairing 放行的）能不能替主人去操作群？
 *   3. 发给谁——私聊发文件时目标是不是主人自己？
 *
 * 这一层是纯函数：输入是工具名、参数、**回合来源**与配置，输出 `allow` 或
 * `deny(code, reason)`。`reason` 是给模型看的中文，**可解释、可恢复**（说清是哪一条、
 * 主人要怎么改配置才能放行），不含隐藏开关。
 *
 * 约定（**终审 B8 收紧**）：`origin === null` 表示"解析不出这次调用属于哪个会话"。
 * 它**不再等于放行**：写类动作（发消息/群操作/文件/戳一戳/点赞/撤回）一律拒绝
 * （`origin-unknown`），只有只读工具还照旧放行。
 */

import { resolveRoomPolicy, type RoomPolicyConfig } from './room-policy.js'

/** 这条调用对外的"动作类型"。 */
export type OutboundAction = 'send' | 'group-write' | 'file' | 'read'

/** 回合来源（由会话 id 解析：`qq-dm-10001` / `qq-group-1000000003`）。 */
export interface OutboundOrigin {
  readonly isGroup: boolean
  /** 群号（群回合）或对方 QQ 号（私聊回合）。 */
  readonly chatId: number
}

export interface OutboundBoundaryConfig extends RoomPolicyConfig {
  readonly admins: readonly number[]
}

export type OutboundDenyCode =
  | 'group-disabled'
  | 'dm-group-op'
  | 'dm-cross-file'
  | 'cross-group'
  | 'group-write-unknown-target'
  | 'origin-unknown'

export type OutboundVerdict =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly code: OutboundDenyCode; readonly reason: string }

const ALLOW: OutboundVerdict = { kind: 'allow' }

/**
 * 带 `groupId` 的**写**动作（终审 B8）：`qq_send_poke` / `qq_delete_msg`。
 *
 * 它们以前被列进 `READ_TOOLS`，于是群开关校验之前就 `allow` 了——可戳一戳、撤回都会
 * 改变群里/他人看到的状态。归类到写之后，这里负责把 `groupId` 解析成目标群，
 * 让 `groupEnabled` 与"跨群"两条判定真正生效。
 *
 * `qq_send_like` 不在此列：它的入参是私聊对象（`userId`），没有群可解析；
 * 群回合里由下面的"关群"判定按**来源群**兜住。
 */
const GROUP_ID_TOOLS: readonly string[] = ['qq_send_poke', 'qq_delete_msg']

/** 会**改变群状态**的工具（禁言/踢人/名片/精华/群文件写/全体禁言/设管理员）。 */
const GROUP_WRITE_TOOLS: readonly string[] = [
  'qq_set_group_card',
  'qq_group_ban',
  'qq_group_kick',
  'qq_group_whole_ban',
  'qq_set_group_admin',
  'qq_set_essence',
  'qq_delete_essence',
  'qq_upload_group_file',
  'qq_create_file_folder',
  'qq_move_group_file',
  'qq_rename_group_file',
  'qq_delete_group_file',
]

/** 会把**本地文件内容**发出去的工具（工作区边界见 `local-file.napcatFileArg`）。 */
const FILE_TOOLS: readonly string[] = [
  'qq_send_private_file',
  'qq_save_private_file',
  'qq_upload_group_file',
  'qq_download_group_file',
  'qq_send_voice',
  'qq_send_sticker',
  'qq_send_emoji',
  'qq_get_file_url',
]

/** 只读工具：一律放行（读不到就是读不到，不构成越权写的风险）。 */
const READ_PREFIXES: readonly string[] = ['qq_get_', 'qq_list_', 'qq_search_', 'qq_can_', 'qq_emoji_stats', 'qq_memory_search']
const READ_TOOLS: readonly string[] = [
  'qq_netease_status',
  'qq_music_lyrics',
  'qq_music_playlist',
  'qq_kugou_search',
  'qq_search_music',
  'qq_resolve_music',
  'retrieve_knowledge',
  'extract_knowledge',
  'qq_recall_memory',
  'qq_memorize_fact',
  'qq_set_affection',
  'qq_set_stage',
  'qq_write_dashboard',
]

export function actionOf(tool: string, args: Readonly<Record<string, unknown>>): OutboundAction {
  if (GROUP_WRITE_TOOLS.includes(tool)) return 'group-write'
  if (FILE_TOOLS.includes(tool)) return 'file'
  if (READ_TOOLS.includes(tool)) return 'read'
  if (READ_PREFIXES.some((prefix) => tool.startsWith(prefix))) return 'read'
  // 其余都是"发消息"（qq_send_text / qq_reply_quote / qq_send_music_card / …），
  // 目标由 `targetGroupOf()` 判。宁可把未知工具归到 send（更严），也不要漏成 read。
  void args
  return 'send'
}

/** 这条调用打的是哪个群；不是群目标时为 `null`。 */
export function targetGroupOf(tool: string, args: Readonly<Record<string, unknown>>): number | null {
  const groupId = Number(args.groupId ?? args.group_id)
  if (Number.isFinite(groupId) && groupId > 0
    && (GROUP_WRITE_TOOLS.includes(tool) || GROUP_ID_TOOLS.includes(tool) || tool === 'qq_get_group_member_info')) {
    return groupId
  }
  if (args.isGroup === true || args.is_group === true) {
    const target = Number(args.target)
    return Number.isFinite(target) && target > 0 ? target : null
  }
  return null
}

/** 私聊文件的"收件人"（`userId` 或 `target`）。 */
function fileTargetOf(args: Readonly<Record<string, unknown>>): number | null {
  const id = Number(args.userId ?? args.user_id ?? args.target)
  return Number.isFinite(id) && id > 0 ? id : null
}

const why = (code: OutboundDenyCode, reason: string): OutboundVerdict => ({ kind: 'deny', code, reason })

/**
 * 判定一条出站调用。
 *
 * 顺序（先判"群是不是关着的"，再判"谁让它干的"）：
 *   1. 群被关掉（全局 `groupEnabled=false` 或按群 `rooms[].enabled=false`）→ 一律拒；
 *   2. 私聊回合要动群（发群消息 / 群写 / 群文件）→ 发起人必须 ∈ `admins`；
 *   3. 群回合要动**别的**群 → 拒（一个群里的人不该借她之手去改另一个群）；
 *   4. 私聊回合发文件 → 收件人必须 ∈ `admins`（她只往主人手里递文件）。
 */
/** 群态检查：来源群与目标群都得是开着的；群写工具还得看得出目标群。 */
function groupVerdict(
  input: { readonly tool: string; readonly args: Readonly<Record<string, unknown>>; readonly origin: OutboundOrigin | null; readonly config: OutboundBoundaryConfig },
  action: OutboundAction,
  group: number | null,
): OutboundVerdict | null {
  // 目标群关着 → 拒；**来源群**关着也拒（戳一戳/点赞/撤回都算"在这个群里动手"）。
  // 只读工具在上面已经放行，所以这一段只影响写动作。
  const scopeGroup = input.origin !== null && input.origin.isGroup ? input.origin.chatId : null
  if (scopeGroup !== null && !resolveRoomPolicy(input.config, scopeGroup).enabled) {
    return why('group-disabled',
      `这次调用发生在群 ${String(scopeGroup)}，而那个群现在是关闭状态（groupEnabled=false 或 rooms 里给它关了），`
      + '所以不能在里头发消息、戳人、点赞或撤回消息。要放行，请主人在后台把那个群重新打开。')
  }
  if (group !== null && !resolveRoomPolicy(input.config, group).enabled) {
    return why('group-disabled',
      `群 ${String(group)} 现在是关闭状态（groupEnabled=false 或 rooms 里给它关了），`
      + `所以既不能在里头发消息，也不能改它的名片/禁言/动它的群文件。`
      + `要放行，请主人在后台把那个群重新打开。`)
  }
  if (action === 'group-write' && group === null) {
    return why('group-write-unknown-target',
      `${input.tool} 会改变群状态，但这次调用看不出目标群（缺 groupId/groupId）。`
      + `请显式给出群号再试。`)
  }
  return null
}

/**
 * 来源判定（**终审 B8，fail-closed**）：解析不出会话就**拒绝**，不再默认放行。
 *
 * 旧行为 `return ALLOW` 的理由是"定时任务/系统回合没有陌生人可归属"。问题是：只要 agentId
 * 缺失、或它不是 QQ 会话 id，**任何**工具调用都会落到这条路上——包括会改变群/他人可见
 * 状态的动作（戳一戳、点赞、撤回）。"看不出谁在动"更该拒绝，不是更该放行。真正的系统回合
 * 要么带得出会话 id，要么走 contact/提醒的专用通道，不依赖这条兜底。
 */
function originVerdict(
  input: { readonly origin: OutboundOrigin | null },
): OutboundVerdict | null {
  if (input.origin !== null) return null
  return why('origin-unknown',
    '这次调用看不出是从哪个会话发起的（没有可解析的会话 id），'
    + '所以不能替任何人发消息或改变群状态。'
    + '请在主人所在的会话里发；定时任务请走 contact/提醒通道。')
}

export function decideOutbound(input: {
  readonly tool: string
  readonly args: Readonly<Record<string, unknown>>
  readonly origin: OutboundOrigin | null
  readonly config: OutboundBoundaryConfig
}): OutboundVerdict {
  const action = actionOf(input.tool, input.args)
  if (action === 'read') return ALLOW
  const group = targetGroupOf(input.tool, input.args)
  // 群态检查（目标群 + 来源群）与"群写缺目标"都拆到 `groupVerdict` 里，判据不变。
  const groupDenial = groupVerdict(input, action, group)
  if (groupDenial !== null) return groupDenial
  // 来源不明 ⇒ 拒（fail-closed，见 `originVerdict`）；判据与文案都在那边。
  const originDenial = originVerdict(input)
  if (originDenial !== null) return originDenial
  const origin = input.origin as OutboundOrigin
  const isAdmin = input.config.admins.includes(origin.chatId)
  if (origin.isGroup) {
    if (group !== null && group !== origin.chatId) {
      return why('cross-group',
        `这个回合发生在群 ${String(origin.chatId)}，不能替别的群（${String(group)}）做写操作/发消息。`
        + `要跨群操作，请主人在自己的私聊里说。`)
    }
    return ALLOW
  }
  // 私聊回合
  if (action === 'file') {
    const to = fileTargetOf(input.args)
    if (!isAdmin && (to === null || !input.config.admins.includes(to))) {
      return why('dm-cross-file',
        `私聊里发文件的目标只能是主人（admins）。这次的目标是 ${to === null ? '空' : String(to)}，`
        + `不是主人——先别发，把文件路径发在主人自己的私聊里再让她递。`)
    }
    if (group === null) return ALLOW
  }
  if (group !== null && !isAdmin) {
    return why('dm-group-op',
      `这是个私聊回合，发起人 ${String(origin.chatId)} 不是主人（admins），`
      + `所以不能替主人往群 ${String(group)} 发消息或改群状态。`
      + `要她这么做，请主人在自己的私聊里说。`)
  }
  return ALLOW
}
