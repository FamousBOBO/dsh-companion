/** 会话档位（05 §6.2，tools.v2）：把 17 个合并工具按会话切成三档。
 *
 * 用**拒绝**实现（走 6c 的 `tools/pre-execute` 闸门，理由 key + 人格包文案）：
 * 不省 token、只省风险——模型手里没有的那几类工具，在它误调时被拦下并给一句
 * 可读的理由。两条已核实的备选都不用：预设裁剪不追溯已有会话（09 V3 的硬约束），
 * `deferLoading` 是"会话中途追加工具"的更新机制字段、不是"只推迟定义"（见报告）。
 */

import { POLICY_REASONS } from '../../app/policy/tool-policy.js'
import { SESSION_PREFIX, splitRoom } from '../../core/room.js'
import type { Trust } from '../../core/trust.js'
import { isMergedToolName } from './mapping.js'

export type ToolTier = 'group' | 'master-dm' | 'system'

/** 群档开放的工具（§6.2 的十个）。组管理员动作不在这里：它由策略按信任拒。 */
const GROUP_TIER_TOOLS: ReadonlySet<string> = new Set([
  'qq_message', 'qq_lookup', 'qq_sticker', 'qq_voice', 'qq_music',
  'qq_link', 'qq_image', 'qq_quote', 'qq_remind', 'qq_memory',
])

/** 系统档开放的工具（事件书 P6f 预留）。 */
const SYSTEM_TIER_TOOLS: ReadonlySet<string> = new Set(['qq_message', 'qq_memory', 'qq_lookup'])

/**
 * 会话 id + 本回合信任档 → 档位；不是 QQ 会话返回 null（不归本规则管）。
 *
 * **判据的优先级**（P6f 修正）：先看**本回合的信任档**——事件书回合同的是一条群会话
 * （`qq-group-…`），靠 id 前缀判不出"这是系统在做事"；`turnTrust` 已经为每一个回合
 * 记下了发起人（`trustForOrigin`：proactive → system），所以它才是准的。
 * system 比会话形状**更严**，所以它优先：主人私聊里跑的事件书回合也按系统档收敛
 * （早报/主动私聊只需要发消息，够用）。会话 id 只是**兜底**：没有账本（policy.v2
 * 关着）时按房间形状判。
 */
export function tierOfSession(
  sessionId: string,
  admins: readonly number[],
  trust: Trust | null = null,
): ToolTier | null {
  // 档位规则只管 QQ 会话——这条边界不能因为新增的信任判据而破。
  if (!sessionId.startsWith(SESSION_PREFIX)) return null
  if (trust === 'system') return 'system'
  const room = sessionId.slice(SESSION_PREFIX.length)
  if (room.startsWith('system')) return 'system' // 形状上的系统会话（无前缀账本时的兜底）
  const parsed = splitRoom(room)
  if (parsed === null) return 'group' // 解析不出来按群档（更严）
  if (parsed.isGroup) return 'group'
  // 私聊：主人的私聊走全量档，其他人的私聊按群档（保守）。
  return admins[0] !== undefined && parsed.chatId === admins[0] ? 'master-dm' : 'group'
}

/**
 * 这次调用该不该被档位拦下？返回 reason key（不拦 = null）。
 * 只对 QQ 会话 + 17 个合并工具生效；宿主工具与表外名字一律不拦。
 *
 * `trust` 是**本回合**的信任档（`turnTrust.get(sessionId)`；拿不到就传 null）。
 */
export function tierDenyFor(
  call: { readonly name: string; readonly agentId: string | undefined },
  admins: readonly number[],
  trust: Trust | null = null,
): string | null {
  if (call.agentId === undefined || !isMergedToolName(call.name)) return null
  const tier = tierOfSession(call.agentId, admins, trust)
  if (tier === null || tier === 'master-dm') return null
  const allowed = tier === 'group' ? GROUP_TIER_TOOLS : SYSTEM_TIER_TOOLS
  if (allowed.has(call.name)) return null
  // 群档里的 qq_group_admin 不按档位拒：交给策略按"本回合是谁发起的"判（仅 master）。
  if (tier === 'group' && call.name === 'qq_group_admin') return null
  return tier === 'group' ? POLICY_REASONS.toolTierGroup : POLICY_REASONS.toolTierSystem
}
