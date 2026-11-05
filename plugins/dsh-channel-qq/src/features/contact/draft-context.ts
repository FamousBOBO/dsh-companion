import { contextBudgetFor } from './draft-budget.js'
/** 主动消息起草的**上下文**（P2.5-3D / Slice C0）：词汇、预算、装配入口与"够不够起草"。
 *
 * 为什么必须有这一层：修复前 `direct` 链路的真实模型请求里**一个字的上下文都没有**
 * （`draft-host.ts` 的七行只有时间、候选理由、字数要求）。于是生产上真的发出去过
 * "好久没聊了，最近过得咋样？"——看起来像角色，实际上跟角色、历史、记忆全无关系。
 * 审计 A2 的结论是"ID 存在不等于正文注入"：`evidenceIds` 里那条聊天指针**从来没有解析器**。
 *
 * 六个资料分区，三种命运（改之前先读这张表）：
 *
 * | 分区 | 有没有拥有者接口 | 做法（见 `draft-readers.ts`） |
 * |---|---|---|
 * | A 人设 | 有（`bridge.presetRegistry().readDocument`） | 读快照、截断、进提示词 |
 * | B 近期对话 | 有条件有（`history.search` 缓存 / `collect` 回源） | 先缓存、空则**有界**回源一次 |
 * | C1 长期记忆 | 有（`memoryEvidence`） | 按候选理由检索；空 = `memory:empty`（不是故障） |
 * | C2 未完成事项 | **没有**（在 `companion-runtime`） | **不伪造**：恒记 `pending:unsupported` |
 * | C3 `mentionPolicy` | **没有**（在 `companion-memory`） | **不伪造**：恒记 `mentionPolicy:unsupported` |
 * | D 候选证据正文 | **没有解析器** | 不解析 id；退化成"最近一条对话"，记 `evidence:unresolved` |
 * | E 最近主动外发 | 有（sent-log + 投递状态 + 未回复计数） | 拼成"她上次说了什么、对方接没接" |
 * | F 时间 | 有（`zoneClock`） | 与门控**同一份** `config.timezone`，不再硬编码上海 |
 *
 * 三条纪律（每个分区都适用）：
 *   1. **每个分区自己 catch**：读失败只产出一条 `gap`，绝不让整轮起草抛出去；
 *   2. **缺口要进提示词**：模型必须知道"这块没拿到"，否则它会顺着人设编一段经历出来；
 *   3. **诊断里没有正文**：`describeDraftContext` 只输出条数/字数/来源 id/裁剪与缺失原因，
 *      生产日志不落私聊原文或记忆原文（隔离测试才捕获完整请求）。
 *
 * 文件分工：本文件 = 词汇 + 预算 + 装配入口；取数在 `draft-readers.ts`；
 * 拼提示词段落与裁剪在 `draft-sections.ts`（三份都各自贴着 400 行硬上限）。
 */

import type { ContactConfig } from '../../config/sections/contact.js'
import type { Clock } from '../../ports/clock.js'
import { clockOf, evidenceOf, historyOf, memoryOf, mentionPolicyGap, outboundOf, pendingOf, personaOf } from './draft-readers.js'
import { NO_FROZEN_VALUE } from './draft-budget.js'
import { BASE_PROMPT_RESERVE, DRAFT_CONTEXT_BUDGET } from './draft-budget.js'
import type { DraftContextBudget } from './draft-budget.js'
import { freezeRevision } from './draft-freshness.js'
import { renderContextSections } from './draft-sections.js'
import type { ContactRoomFacts } from './transitions.js'
import type { ContactCandidate, ContactCounters, ContactDelivery } from './types.js'

// ── 词汇 ────────────────────────────────────────────────────────────────────

/** 分区名（诊断、缺口、裁剪顺序都用它，稳定短串）。 */
export type DraftPartition = 'persona' | 'history' | 'memory' | 'pending' | 'mentionPolicy' | 'evidence' | 'outbound' | 'clock'

/** 一个分区"没拿到"的**结构化**记录：为什么没拿到、谁该来补。 */
export interface DraftContextGap {
  readonly partition: DraftPartition
  /** 稳定串（grep 用）：`persona:missing` / `history:empty` / `pending:unsupported` … */
  readonly code: string
  /** 人话：到底哪一步失败了。 */
  readonly reason: string
  /** 谁该提供这块（下一片接手时要找的人/包/导出）。 */
  readonly ownerHint: string
}

/** 人设快照（已截断；`document` 是整份 preset 文档的前 N 字）。 */
export interface DraftPersona {
  readonly personaId: string
  readonly document: string
  readonly truncated: boolean
}

/** 一条对话行。`who` 只按**已知 id** 判，判不出来就是 `other`（不猜）。 */
export interface DraftLine {
  readonly id?: string
  readonly who: 'user' | 'self' | 'other'
  readonly text: string
  readonly at: number
  readonly speaker: string
}

/** 候选证据正文（C0 恒来自"最近一条对话"，因为 id 没有解析器）。 */
export interface DraftEvidence {
  readonly source: string
  readonly text: string
}

/** 最近一次主动外发：说了什么、平台怎么记的、对方接没接。 */
export interface DraftOutbound {
  readonly text: string
  readonly state: string
  readonly at: number
  readonly replied: boolean
}

/** 起草时刻（与门控同一个时区口径，见 `local-time.zoneClock`）。 */
export interface DraftClock {
  /** 生效的 IANA 时区（`''` = 跟随宿主）。 */
  readonly tz: string
  /** 写进提示词的标签（空串时说明"宿主本地"）。 */
  readonly tzLabel: string
  readonly dayKey: string
  /** `HH:mm`（与 `zoneClock` 的同一分钟，不从别处再算一次）。 */
  readonly hhmm: string
  readonly minutes: number
  readonly period: string
}

/** 起草时的**绑定标识**：房间/收件人/群私/人格/世界（任一项变了就是另一段对话）。 */
export interface DraftBinding {
  readonly room: string
  readonly chatId: number
  readonly isGroup: boolean
  readonly personaId: string
  readonly worldId: string
}

/**
 * 起草时的**房间游标**。
 *
 * `lastUserAt` 是 `registry.lastEvent.time`（**秒**级）；`queueDepth` 是同一记录里"尚未成包
 * 的行数"（`ConversationRecord.queue.length`）。两个一起记才能覆盖"同一秒内又来了消息"——
 * 那种情况下时间戳完全相等，只比 `>` 是拦不住的（Codex 预发布审查 R5）。
 */
export interface DraftRoomCursor {
  readonly lastUserAt: number | null
  readonly queueDepth: number | null
}

/**
 * 起草用的**新鲜度标记**（Codex P1/R5 之后不再只是时间戳）。
 *
 * 逐项含义与"漏网场景"的对应关系写在 `draft-freshness.ts` 的文件头表格里。
 * 判据在 `draft-freshness.compareRevision`（同步，进 `finalSyncGuard`）与
 * `createRevisionVerifier`（异步，进 `recheckAtSend`）。
 */
export interface DraftRevision {
  readonly candidateVersion: number
  readonly candidateUpdatedAt: number
  /** 保留 A2 §5.5 的原字段（与 `roomCursor.lastUserAt` 同值，便于老断言/诊断读取）。 */
  readonly lastUserAt: number | null
  readonly binding: DraftBinding
  readonly roomCursor: DraftRoomCursor
  /** 人设正文（**已截断**后的那份，即模型真看到的内容）的摘要；没读到人设 = `NO_FROZEN_VALUE`。 */
  readonly personaDigest: string
  /** 历史尾游标 `条数@尾条时刻#尾条摘要`（见 `historyCursorOf`）。 */
  readonly historyCursor: string
}

/** 一次起草的全部资料。**每个分区都可能缺席**（缺席进 `gaps`，不进异常）。 */
export interface DraftContext {
  readonly persona: DraftPersona | null
  /** 旧 → 新。 */
  readonly history: readonly DraftLine[]
  readonly memory: string | null
  /** 未完成事项：C0 恒为空（没有拥有者接口）。 */
  readonly pending: readonly string[]
  readonly evidence: readonly DraftEvidence[]
  readonly outbound: readonly DraftOutbound[]
  /** 她最近发过的原话（`sent-log.render()` 的块，已截断）。 */
  readonly sentBlock: string | null
  readonly unansweredStreak: number
  readonly clock: DraftClock | null
  readonly revision: DraftRevision
  readonly gaps: readonly DraftContextGap[]
  /** 排好序、裁好的提示词段落（`draft-host` 直接追加到既有七行之后）。 */
  readonly sections: readonly string[]
  readonly trimmed: readonly DraftPartition[]
  /** 裁到上限还超 = 这一轮不许调模型（`draft:no-context` / `context:over-budget`）。 */
  readonly overBudget: boolean
}

// ── 预算与缺失哨兵：常量搬到了 `draft-budget.ts`（避免运行时循环 import），这里再导出一次 ──

export { BASE_PROMPT_RESERVE, DRAFT_CONTEXT_BUDGET } from './draft-budget.js'
export type { DraftContextBudget } from './draft-budget.js'

// ── 拥有者端口的**窄面**（只写结构，不 import 别人的实现） ─────────────────────

/** `features/history` 的两条只读入口（`search` 读本地缓存，`collect` 强制回源）。 */
export interface DraftHistoryPort {
  search(room: string, filter: { keyword?: string | null; sender?: number | null; since?: string | null; until?: string | null }):
    Promise<readonly { readonly id: number; readonly time: number; readonly userId: number; readonly name: string; readonly text: string }[]>
  collect(room: string, isGroup: boolean, target: number, count?: number): Promise<number>
}

/** `sent-log.ts` 的 hub（她最近说过什么）。 */
export interface DraftSentLogHub {
  for(room: string): Promise<{ render(): string }>
}

/** 宿主人格预设注册表的最小面（`host.bridge.presetRegistry()`）。 */
export interface DraftPresetRegistry {
  readDocument(agentPreset: string): Promise<{ content: string }>
}

/** `ports/memory.ts` 的证据端口（空串 = 什么都没想起来）。 */
export type DraftMemoryEvidence = (input: {
  text: string
  room: string
  isGroup: boolean
  speakerId?: number
}) => Promise<string>

/** 组装器要的全部依赖（**全部惰性/可缺**：缺哪个就记哪个缺口）。 */
export interface DraftContextDeps {
  /** 服务袋惰性取值（照 `features/inbound/lazy-evidence.ts` 的范式，不缓存）。 */
  readonly get: (name: string) => unknown
  readonly preset: () => DraftPresetRegistry | undefined
  readonly config: () => ContactConfig
  /** 账本里的投递（只读；`outbound` 分区的"送达状态"来源）。 */
  readonly deliveries?: () => readonly ContactDelivery[]
  readonly counters?: () => ContactCounters
  readonly roomFacts?: (room: string) => ContactRoomFacts
  readonly clock?: Clock
  readonly log?: (line: string) => void
  readonly budget?: Partial<DraftContextBudget>
}

// ── 组装 ────────────────────────────────────────────────────────────────────

/** 一次把六个分区读完（**内部有界、绝不抛**：每个分区自己 catch 并落 gap）。 */
export async function buildDraftContext(
  deps: DraftContextDeps,
  candidate: ContactCandidate,
  now: number,
): Promise<DraftContext> {
  const budget: DraftContextBudget = { ...contextBudgetFor(candidate), ...(deps.budget ?? {}) }
  const gaps: DraftContextGap[] = []
  const persona = await personaOf(deps, candidate.scope.personaId, budget.personaChars)
  if (persona.gap !== null) gaps.push(persona.gap)
  const history = await historyOf(deps, candidate, budget.historyLines, budget.historyChars, budget.lineChars)
  if (history.gap !== null) gaps.push(history.gap)
  const memory = await memoryOf(deps, candidate, budget.memoryChars)
  if (memory.gap !== null) gaps.push(memory.gap)
  const pending = pendingOf()
  gaps.push(pending.gap)
  gaps.push(mentionPolicyGap())
  const evidence = evidenceOf(candidate, history.history, budget.evidenceChars)
  if (evidence.gap !== null) gaps.push(evidence.gap)
  const outbound = await outboundOf(deps, candidate, budget.outboundRows, budget.outboundChars)
  if (outbound.gap !== null) gaps.push(outbound.gap)
  const clock = clockOf(deps, now)
  if (clock.gap !== null) gaps.push(clock.gap)
  const dressed = renderContextSections({
    persona: persona.persona,
    history: history.history,
    memory: memory.memory,
    pending: pending.pending,
    evidence: evidence.evidence,
    sentBlock: outbound.sentBlock,
    outbound: outbound.outbound,
    unansweredStreak: outbound.unansweredStreak,
    clock: clock.clock,
    gaps,
  }, budget.promptChars - BASE_PROMPT_RESERVE)
  return {
    persona: persona.persona,
    history: history.history,
    memory: memory.memory,
    pending: pending.pending,
    evidence: evidence.evidence,
    outbound: outbound.outbound,
    sentBlock: outbound.sentBlock,
    unansweredStreak: outbound.unansweredStreak,
    clock: clock.clock,
    // 响应式冻结（Codex P1/R5）：判据与漏网场景见 `draft-freshness.ts` 的文件头表格。
    revision: freezeRevision(candidate, { persona: persona.persona?.document ?? null, history: history.history }, deps.roomFacts?.(candidate.target.room)),
    gaps,
    sections: dressed.sections,
    trimmed: dressed.trimmed,
    overBudget: dressed.overBudget,
  }
}

/**
 * 上下文够不够起草（A2 §5.6 的"不可降级"那一列）。
 *
 * **"最近对话"是硬条件**：读不到就没有"接着聊"可言，那不叫降级，那叫退回修复前的事故。
 * 人设缺失只记 `persona:missing` 但**允许继续**（有对话就还能判断该不该开口）；
 * 时区算不出来一律不开口（与 `gate.ts` 的 `timezone-invalid` 同一 fail-closed）。
 */
export function sufficientContext(context: DraftContext): { ok: boolean; detail: string } {
  if (context.clock === null) return { ok: false, detail: 'clock:timezone-invalid' }
  if (context.history.length === 0) {
    return { ok: false, detail: context.gaps.find((gap) => gap.partition === 'history')?.code ?? 'history:empty' }
  }
  if (context.overBudget) return { ok: false, detail: 'context:over-budget' }
  return { ok: true, detail: 'ok' }
}

/** 诊断一行（**只有条数/字数/来源 id/缺失原因**，绝不带正文或记忆原文）。 */
export function describeDraftContext(context: DraftContext): string {
  const size = (text: string | null): string => (text === null ? '0' : `${String([...text].length)}c`)
  const historyChars = context.history.reduce((total, line) => total + [...line.text].length, 0)
  return [
    'draft-context:',
    `persona=${context.persona === null ? 'none' : size(context.persona.document)}${context.persona?.truncated === true ? '(cut)' : ''}`,
    `history=${String(context.history.length)}/${String(historyChars)}c`,
    `memory=${size(context.memory)}`,
    `evidence=${String(context.evidence.length)}`,
    `outbound=${String(context.outbound.length)}/${size(context.sentBlock)}`,
    `streak=${String(context.unansweredStreak)}`,
    `clock=${context.clock === null ? 'none' : `${context.clock.tzLabel}@${context.clock.dayKey}${context.clock.hhmm}`}`,
    `rev=v${String(context.revision.candidateVersion)}@${String(context.revision.candidateUpdatedAt)}`,
    `trimmed=${context.trimmed.join(',') || '-'}`,
    `gaps=${context.gaps.map((gap) => gap.code).join(',') || '-'}`,
  ].join(' ')
}

/**
 * 组装器的**装配侧入口**：`index.ts` 只需把宿主那几样东西塞进闭包，业务不落到装配里。
 *
 * 之所以做成"对象 + build"，是因为 `attempt.ts` 只在**门控放行之后**才调用它
 * （H2 心跳 / 被门控挡住的候选一次都不该读库、更不该调模型）。
 */
export function createDraftContextSource(deps: DraftContextDeps): { build(candidate: ContactCandidate, now: number): Promise<DraftContext> } {
  return {
    build: async (candidate, now) => {
      try {
        return await buildDraftContext(deps, candidate, now)
      } catch (error) {
        // 组装器内部已经逐分区 catch，走到这里说明是"框架级"意外（连 config/counters 都抛）：
        // **宁可这一轮不发**，也不许退回到没有上下文的泛化问候（那正是要修的事故）。
        deps.log?.(`contact: 起草上下文组装失败（${describe(error)}），这一轮不调模型`)
        return {
          persona: null, history: [], memory: null, pending: [], evidence: [], outbound: [],
          sentBlock: null, unansweredStreak: 0, clock: null, sections: [], trimmed: [],
          // 组装失败 = **没有任何可比较的冻结值**：把 revision 填成"全缺失"，让发送前的
          // 版本闸按保守口径拒绝（而不是拿一份空 revision 蒙过去）。
          revision: {
            candidateVersion: candidate.version,
            candidateUpdatedAt: candidate.updatedAt,
            lastUserAt: null,
            binding: {
              room: candidate.target.room, chatId: candidate.target.chatId, isGroup: candidate.target.isGroup,
              personaId: candidate.scope.personaId, worldId: candidate.scope.worldId,
            },
            roomCursor: { lastUserAt: null, queueDepth: null },
            personaDigest: NO_FROZEN_VALUE,
            historyCursor: NO_FROZEN_VALUE,
          },
          gaps: [{ partition: 'history', code: 'history:missing', reason: `组装器抛错：${describe(error)}`, ownerHint: 'features/contact/draft-context.ts' }],
          overBudget: true,
        }
      }
    },
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
