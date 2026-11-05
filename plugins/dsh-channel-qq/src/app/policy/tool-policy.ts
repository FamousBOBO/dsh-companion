/** 工具策略（P6c `policy.v2`）：信任分级 × 工具放行表的**纯决策**，与入站侧接线。
 *
 * 本文件装三件事：
 *   1. `decideToolCall`——给"信任 + 工具 + 参数"，回答放行还是拒绝；这就是 05 §5
 *      的整张放行表。拒绝只给 reason key（`policy.…`），面向模型的文案从人格包
 *      `guards/*.txt` 取（映射见 `guardTemplateKey`）；
 *   2. 每回合信任的入站侧：`TrustTrackingTurns`（提交时把"发起人档位 + 包污点"
 *      合流）与 `createPolicyScreening`（组包时扫描特征并预登记污点）；
 *   3. 开关与档位映射（`policyEnabled` / `trustForOrigin`）。
 *
 * 其余接线各有一处家，别在这里重复造：
 *   - 信任账本与全局单例：`core/trust.ts`（`turnTrust`）；
 *   - 工具闸门的两个回调与装/卸控制器：`features/qq-tools/register.ts`；
 *   - 宿主监听器（`tools/pre-execute` / `tools/post-execute`）：
 *     `adapters/dsh-host/services.ts` 的 `installToolGate`；
 *   - 根服务只在 `policy.v2` 打开时安装闸门：`plugin.ts`。
 *
 * 6d（工具合并 86→17）已落地：`toolActionOf` 与 `textSentBy` 都是**两级匹配**——
 * 旧名分支（今天的现役表面）与合并后的"工具名 + action"分支并存，由 tools.v2
 * 决定哪一半在跑。旧名分支不能先删：tools.v2 默认关，它们就是现役表面；等旧面
 * 整体退役（tools.v2 成为唯一表面）时再逐条勾掉。
 */

import { taintOfText, trustOfSender, type Trust, type TurnTrustLedger } from '../../core/trust.js'
import { OUTPUT_SIGNATURE_REASONS, type OutputSignatureReason } from '../../core/guards/output-signatures.js'
import { PROACTIVE, type TurnOrigin } from '../conversation/origins.js'
import { TurnLauncher, type TurnLauncherDeps } from '../conversation/turns.js'
import type { ConversationRecord } from '../conversation/registry.js'
import type { InjectionScanner, InjectionSignal } from '../../ports/injection.js'

// ── reason key 与人格模板 ────────────────────────────────────────────────────

/** 策略拒绝的 reason key（面向模型的文案在人格包里，代码只递这个键）。 */
export const POLICY_REASONS = {
  groupMasterOnly: 'policy.group-admin.master-only',
  groupBan: 'policy.group-ban.master-or-admin',
  groupFile: 'policy.group-file.master-only',
  affection: 'policy.affection.master-dm-only',
  workspaceWrite: 'policy.workspace-write.master-only',
  workspacePath: 'policy.workspace-write.path-not-allowed',
  // tools.v2 的会话档位拒绝（P6d）：规则在 features/tools-v2/tiers.ts，
  // 但 reason key 与文案映射和其它策略走同一条通道（所以收在这里）。
  toolTierGroup: 'policy.tool-tier.group',
  toolTierSystem: 'policy.tool-tier.system',
} as const

export type PolicyReasonKey =
  | (typeof POLICY_REASONS)[keyof typeof POLICY_REASONS]
  | OutputSignatureReason

/** reason key → 人格包模板键；人格包换说法不改代码。 */
export function guardTemplateKey(reasonKey: string): string | null {
  switch (reasonKey) {
    case POLICY_REASONS.groupMasterOnly: return 'guards/denied-group-admin'
    case POLICY_REASONS.groupBan: return 'guards/denied-group-ban'
    case POLICY_REASONS.groupFile: return 'guards/denied-group-file'
    case POLICY_REASONS.affection: return 'guards/denied-affection'
    case POLICY_REASONS.workspaceWrite:
    case POLICY_REASONS.workspacePath: return 'guards/denied-workspace-write'
    case POLICY_REASONS.toolTierGroup: return 'guards/denied-tool-tier-group'
    case POLICY_REASONS.toolTierSystem: return 'guards/denied-tool-tier-system'
    case OUTPUT_SIGNATURE_REASONS.adPrefix: return 'guards/output-ad-prefix'
    case OUTPUT_SIGNATURE_REASONS.repeatOpening: return 'guards/output-repeat-opening'
    default: return null
  }
}

// ── 开关 ─────────────────────────────────────────────────────────────────────

/**
 * 读 `policy.v2` 的结构形状。
 *
 * 为什么用结构类型而不是直接 import `QQChannelConfig`：`src/app/` 只依赖
 * core/ports（R8 的 import 判据），而这里只要一个布尔。`QQChannelConfig` 天然
 * 满足这个形状，调用方直接传即可。
 */
export interface PolicyConfigLike {
  readonly policy?: { readonly v2?: boolean }
}

/** `policy.v2` 开着吗（每处现取，后台改完立即生效）。 */
export function policyEnabled(config: PolicyConfigLike): boolean {
  return config.policy?.v2 === true
}

// ── 放行表：工具名（+action）→ 动作 ─────────────────────────────────────────

/** 动作 id；与下面 `toolActionOf` 的匹配和 `decideToolCall` 的判定一一对应。 */
export type ToolAction =
  | 'group.master-only'
  | 'group.ban'
  | 'group-file.write'
  | 'affection'
  | 'memory.write'
  | 'workspace.write'

/** 「踢人、全员禁言、设管理员、设精华、改群名片」→ 仅 master（05 §5）。 */
const MASTER_ONLY_TOOLS = new Set([
  'qq_group_kick', 'qq_group_whole_ban', 'qq_set_group_admin',
  'qq_set_group_card', 'qq_set_essence', 'qq_delete_essence',
])

/** 群文件写操作（上传/移动/改名/删除；建文件夹也算写）。 */
const GROUP_FILE_WRITE_TOOLS = new Set([
  'qq_upload_group_file', 'qq_create_file_folder', 'qq_move_group_file',
  'qq_rename_group_file', 'qq_delete_group_file',
])

/** 好感度记账/阶段/仪表盘 → 仅 master 且仅私聊回合。 */
const AFFECTION_TOOLS = new Set(['qq_set_affection', 'qq_set_stage', 'qq_write_dashboard'])

/** 宿主文件工具里"写工作区"的两个（`write` / `edit`，参数都带 `file_path`）。 */
const HOST_FILE_WRITE_TOOLS = new Set(['write', 'edit'])

/** 6d：合并后 `qq_group_file` 的写操作 action 名。 */
const GROUP_FILE_WRITE_ACTIONS = new Set(['upload', 'mkdir', 'move', 'rename', 'delete'])

/**
 * 两级匹配：先认现在的工具名，再认 6d 合并后的 `工具名 + action`。
 *
 * 表里没列的工具一律返回 null = 不拦（"四档全放"的那些：发消息/查信息/表情/
 * 语音/点歌/链接/语录/提醒/记忆召回，以及宿主自己的 read/bash 等——它们归
 * `permissionPreset` 管）。
 */
export function toolActionOf(tool: string, args: Readonly<Record<string, unknown>>): ToolAction | null {
  if (MASTER_ONLY_TOOLS.has(tool)) return 'group.master-only'
  // 这个工具的时长被 run 夹在 60–300 秒（≤5 分钟），所以 master/admin 都放。
  if (tool === 'qq_group_ban') return 'group.ban'
  if (tool === 'qq_group_mute_user') return banActionOf(secondsOf(args.seconds, 60))
  if (GROUP_FILE_WRITE_TOOLS.has(tool)) return 'group-file.write'
  if (AFFECTION_TOOLS.has(tool)) return 'affection'
  if (tool === 'qq_memorize_fact') return 'memory.write'
  if (HOST_FILE_WRITE_TOOLS.has(tool)) return 'workspace.write'
  // ── 6d 合并后的名字（tools.v2 打开时生效；旧面退役前上面那一半不能删） ────
  if (tool === 'qq_group_admin') return groupAdminActionOf(String(args.action ?? ''), args)
  if (tool === 'qq_group_file') {
    return GROUP_FILE_WRITE_ACTIONS.has(String(args.action ?? '')) ? 'group-file.write' : null
  }
  if (tool === 'qq_affection') return 'affection'
  if (tool === 'qq_memory') return args.action === 'memorize' ? 'memory.write' : null
  return null
}

function groupAdminActionOf(action: string, args: Readonly<Record<string, unknown>>): ToolAction | null {
  switch (action) {
    case 'kick':
    case 'whole_ban':
    case 'set_admin':
    case 'set_card':
    case 'set_essence':
    case 'unset_essence':
      return 'group.master-only'
    case 'ban':
      return banActionOf(secondsOf(args.duration, 60))
    case 'mute_flooder':
      return banActionOf(secondsOf(args.seconds, 60))
    default:
      return null
  }
}

/** 禁言 ≤ 5 分钟（300 秒）→ master/admin；更长的禁言收窄到仅 master。 */
function banActionOf(seconds: number): ToolAction {
  return seconds > 300 ? 'group.master-only' : 'group.ban'
}

function secondsOf(value: unknown, fallback: number): number {
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds > 0 ? seconds : fallback
}

// ── 纯决策 ───────────────────────────────────────────────────────────────────

export interface ToolCallFacts {
  readonly trust: Trust
  readonly tool: string
  readonly args: Readonly<Record<string, unknown>>
  /** 这次调用属于我们的 QQ 会话吗（宿主文件工具只拦 QQ 会话的，别人的不归咱管）。 */
  readonly isQqSession: boolean
  /** 回合作业的房间是群还是私聊（"仅私聊回合"一行的判据；判不出按群 = 更严）。 */
  readonly isGroupTurn: boolean
  readonly workspacePath: string | null
}

export type PolicyVerdict =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly reasonKey: PolicyReasonKey }

const ALLOW: PolicyVerdict = { kind: 'allow' }
const deny = (reasonKey: PolicyReasonKey): PolicyVerdict => ({ kind: 'deny', reasonKey })

/** 05 §5 的放行表本体；纯函数，给同样的输入永远给同样的结论。 */
export function decideToolCall(facts: ToolCallFacts): PolicyVerdict {
  const action = toolActionOf(facts.tool, facts.args)
  if (action === null) return ALLOW
  switch (action) {
    case 'workspace.write':
      // 别的 agent（非 QQ 会话）的文件工具不归本策略管——它们有自己的权限档位。
      return facts.isQqSession ? workspaceWriteVerdict(facts) : ALLOW
    case 'group.master-only':
      return facts.trust === 'master' ? ALLOW : deny(POLICY_REASONS.groupMasterOnly)
    case 'group.ban':
      return facts.trust === 'master' || facts.trust === 'admin' ? ALLOW : deny(POLICY_REASONS.groupBan)
    case 'group-file.write':
      return facts.trust === 'master' ? ALLOW : deny(POLICY_REASONS.groupFile)
    case 'affection':
      return facts.trust === 'master' && !facts.isGroupTurn ? ALLOW : deny(POLICY_REASONS.affection)
    case 'memory.write':
      // 表里"master 直接提交 / 其他档候选"规定的是**写入去向**，落点在记忆服务
      // （D12，随 memory.v2 的 e2 接线）；策略层这一行现在只做到"不拦"。
      return ALLOW
  }
}

/** 宿主文件工具写工作区：master 交给 permissionPreset；system 只放白名单目录。 */
function workspaceWriteVerdict(facts: ToolCallFacts): PolicyVerdict {
  if (facts.trust === 'master') return ALLOW
  if (facts.trust !== 'system') return deny(POLICY_REASONS.workspaceWrite)
  const raw = facts.args.file_path
  if (typeof raw !== 'string' || !pathAllowedForSystem(raw, facts.workspacePath)) {
    return deny(POLICY_REASONS.workspacePath)
  }
  return ALLOW
}

// ── system 档的路径判据（工作区内、`memory/` 与 `persona/` 之外） ────────────

/** 工作区第一层里"不许 system 写"的目录名（记忆与人格各自有专门的写入通道）。 */
const SYSTEM_WRITE_EXCLUDED = new Set(['memory', 'persona'])

/** 把路径切成段；`..` 与 `.` 留给调用方逐段处理（`..` 出现在这里说明要往上走）。 */
function pathSegments(raw: string): { absolute: boolean; parts: string[] } {
  const unix = raw.replace(/\\/g, '/')
  const absolute = unix.startsWith('/') || /^[A-Za-z]:\//.test(unix)
  return { absolute, parts: unix.split('/').filter((seg) => seg !== '' && seg !== '.') }
}

function pathAllowedForSystem(raw: string, workspacePath: string | null): boolean {
  if (workspacePath === null || workspacePath.trim() === '') return false
  const workspace = pathSegments(workspacePath).parts
  if (workspace.length === 0) return false
  const { absolute, parts } = pathSegments(raw)
  const target = absolute ? [] : [...workspace]
  for (const seg of parts) {
    if (seg === '..') {
      if (target.length === 0) return false // 越过根：不可判定，拒绝
      target.pop()
      continue
    }
    target.push(seg)
  }
  if (target.length < workspace.length) return false
  for (let i = 0; i < workspace.length; i += 1) {
    // 大小写不敏感比较：Windows 上路径大小写会漂，判据放宽一档、方向仍是拒绝优先。
    if (target[i]!.toLowerCase() !== workspace[i]!.toLowerCase()) return false
  }
  const first = target[workspace.length]?.toLowerCase()
  return first === undefined || !SYSTEM_WRITE_EXCLUDED.has(first)
}

// ── 发起人 → 基础档位 ────────────────────────────────────────────────────────

export function trustForOrigin(origin: TurnOrigin, admins: readonly number[]): Trust {
  switch (origin.kind) {
    case 'user':
    case 'notice':
      // 戳一戳等通知也是"谁戳的谁发起"；member 戳出来的回合就是 member 回合。
      return trustOfSender(origin.userId, admins)
    case 'admin':
      return 'master' // 后台注入按 master 处理（§5）；审计在后台侧
    case 'proactive':
      // 定时任务（巡逻/做梦/自省）是事件书（P6f）的现有化身：没有群友作为发起人，
      // 但要读写自己的工作区文件——所以是 system 档，写文件仅限白名单。
      return 'system'
  }
}

// ── 回合包装：提交时合并"发起人 + 包污点" ────────────────────────────────────

export interface TrustTrackingDeps {
  readonly ledger: TurnTrustLedger
  readonly admins: () => readonly number[]
  readonly enabled: () => boolean
}

/**
 * 回合发起包装：每次 submit 前把本回合信任落账。
 *
 * 包污点（组包时 stage 的）在这里被消费——`compose → submit` 是相邻的一对调用，
 * 污点不会跨回合；预登记没被消费（如 ensure 失败）时也只是多降一档的保守方向。
 */
export class TrustTrackingTurns extends TurnLauncher {
  constructor(deps: TurnLauncherDeps, private readonly trustDeps: TrustTrackingDeps) {
    super(deps)
  }

  override submit(
    conversation: ConversationRecord,
    prompt: string,
    imageRefs: readonly unknown[] = [],
    origin: TurnOrigin = PROACTIVE,
  ): void {
    if (this.trustDeps.enabled()) {
      const base = trustForOrigin(origin, this.trustDeps.admins())
      // 后台注入按 master 处理，不看包内容（§5 的口径），但预登记要清掉。
      this.trustDeps.ledger.commit(conversation.sessionId, base, origin.kind === 'admin')
    }
    super.submit(conversation, prompt, imageRefs, origin)
  }
}

// ── 组包包装用到的小组件（特征扫描 + 污点预登记） ────────────────────────────

export interface PolicyScreeningDeps {
  readonly enabled: () => boolean
  readonly scanner: () => InjectionScanner | null
  readonly admins: () => readonly number[]
  readonly ledger: TurnTrustLedger
}

/** `ScreeningPacketComposer`（features/inbound）只管转发，逻辑在这里、可单测。 */
export interface PolicyScreening {
  scan(text: string): readonly InjectionSignal[]
  merge<T extends { readonly signals?: readonly InjectionSignal[] }>(input: T, scan: readonly InjectionSignal[]): T
  stage(sessionId: string, text: string): void
}

export function createPolicyScreening(deps: PolicyScreeningDeps): PolicyScreening {
  return {
    scan(text) {
      if (!deps.enabled()) return []
      const scanner = deps.scanner()
      return scanner === null ? [] : scanner.scan(text)
    },
    merge(input, scan) {
      if (scan.length === 0) return input
      return { ...input, signals: [...(input.signals ?? []), ...scan] }
    },
    stage(sessionId, text) {
      if (!deps.enabled()) return
      // 污点提取是纯函数，放在 core/trust.ts（信任的分级与合并都归它）。
      deps.ledger.stage(sessionId, taintOfText(text, deps.admins()))
    },
  }
}
