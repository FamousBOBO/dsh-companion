/** **一次**社交决策的完整流程：组提示词 → 调模型 → 严格解析 → 代码校验 → 复核限频 → 发一句 → 记账。
 *
 * 为什么与 `presence-runtime.ts` 分家：两件事的生命周期不一样。
 *   - 这里是一次**有始有终**的流程（说完就结束，最长活一次模型超时的时间）；
 *   - 那边是**常驻状态机**（每群游标、合批定时器、限频状态、卸载）。
 *
 * P2（§6.5）之后的边界更清楚：模型只**提**决策（`silent/observe/reply/join/react`），
 * 代码负责验证动作、目标消息、时间窗、长度、限频，并且只有拿到平台回执才算"说过话"。
 *
 * 四条口径（这里说的话，是通道**直接**发到群里的，没有回合、没有工具、没有人复核）：
 *   1. **只有真实回执才算说过话**：`message_id` 是 number 才 `recordSpeak` + 记 sent-log；
 *      失败/无回执只推进失败计数（连续失败由 `core/presence.ts` 暂停一阵），**不重试、不连发**。
 *   2. **发之前复核两遍**：决策本身的合法性（目标在不在、长度对不对）与限频（冷却/额度）。
 *   3. **每条出口都是可判别结果**（`spoke` / `silent` / `failed`），**绝不抛**。
 *   4. **`reply` 用引用段**（`{type:'reply'}`），其余动作用纯文本：引用是"回谁"的唯一可见标记，
 *      而 `join`/`react` 本来就不针对某一条。
 */

import {
  recordJudge,
  recordSpeak,
  speakVerdict,
  type PresenceLimits,
  type PresenceState,
} from '../../core/presence.js'
import type { Clock } from '../../ports/clock.js'
import type { ChatPlatform } from '../../ports/platform.js'
import type { JudgeEntry } from './presence-judge.js'
import type { GroupPersonaSnapshot } from './group-persona.js'
import type { PresenceSettings } from './ambient-store.js'
import {
  parseSocialDecision,
  sendsMessage,
  validateSocialDecision,
  type DecisionContext,
  type SocialDecision,
} from './group-social-decision.js'
import { buildSocialPrompt } from './group-social-prompt.js'
import { EMPTY_RECALL, type GroupMemoryRecall } from './group-memory-contract.js'

// ── 一次纯补全的端口（实现在 `adapters/dsh-host/completion.ts`） ──────────────
//
// 端口**类型**放在消费者这一侧：`app/` 不许 import `adapters/`（分层检查 R8），
// 所以适配器实现它、装配侧把它们接起来。

/** 一次纯补全的入参：没有会话、没有工具、没有历史；一个请求 = 至多一次生成。 */
export interface CompleteRequest {
  readonly prompt: string
  readonly maxTokens: number
  readonly timeoutMs: number
  /** 稳定会话 id（provider 会拒没有会话头的请求；也用于归属账单）。 */
  readonly sessionId?: string
  /** 想要的推理档位（默认 `low`；适配层按模型声明裁剪）。 */
  readonly preferredEffort?: string
}

/** 一次补全的**可判别结果**（绝不抛）。 */
export type CompleteResult =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'no-route'; readonly detail?: string }
  | { readonly kind: 'failed'; readonly detail: string }
  | { readonly kind: 'timeout'; readonly detail?: string }

/** 纯补全端口（单次、不重试）。 */
export interface CompletePort {
  complete(request: CompleteRequest): Promise<CompleteResult>
}

/** 本模块要用的 `presence.*` 字段（结构类型：不把整份配置拖进来）。 */
export interface PresenceView extends PresenceSettings {
  /** 合批静默窗口（毫秒）：一批消息攒这么久再判断。缺省走 {@link DEFAULTS.batchQuietMs}。 */
  readonly batchQuietMs?: number
  /** 一批消息等待判断的上限（毫秒）：只用于饥饿告警，不改变调度。 */
  readonly judgeMaxWaitMs?: number
  readonly judgeIntervalMs: number
  readonly judgeMaxEntries: number
  readonly judgeMaxChars: number
  readonly judgeTimeoutMs: number
  readonly judgeMaxTokens: number
  readonly speakMinIntervalMs: number
  readonly speakMaxPerHour: number
  readonly replyMaxChars: number
  /** 允许引用的时间窗（毫秒）：太老的消息不引（P2 §6.5 第 3 条）。 */
  readonly replyWindowMs?: number
  /** 记忆段字数预算（§5.4 建议 600–800）；缺省 800。 */
  readonly memoryBudgetChars?: number
  /** 是否允许在自主发言之后配一张表情包（P4 §8.2）；缺省 `false`。 */
  readonly stickers?: boolean
  /** 两张图之间的最小间隔（毫秒）；缺省 10 分钟。 */
  readonly stickerMinIntervalMs?: number
  /** 每小时最多几张图；缺省 1。 */
  readonly stickerMaxPerHour?: number
}

/** 默认值：配置给坏了也不能把这条路径弄崩。 */
export const DEFAULTS = {
  /**
   * 合批静默窗口（P3 §7.3 的 `batchQuietMs`，5–8 秒起步）。
   *
   * 与 `judgeIntervalMs` **分开**：那个管"两次判断之间至少隔多久"（省钱），这个管
   * "一批消息要等多久再判"（读得懂上下文）。两者合成一个参数时，缩短它就同时变贵。
   */
  batchQuietMs: 6_000,
  /** 活跃群里允许一批消息等待判断的最长时间（§7.3）；超过就记一次饥饿告警。 */
  judgeMaxWaitMs: 25_000,
  judgeIntervalMs: 50_000,
  judgeMaxEntries: 15,
  judgeMaxChars: 1_200,
  judgeTimeoutMs: 25_000,
  judgeMaxTokens: 320,
  speakMinIntervalMs: 300_000,
  speakMaxPerHour: 3,
  replyMaxChars: 70,
  replyWindowMs: 600_000,
  memoryBudgetChars: 800,
} as const

/** 正数才认，否则给默认值（配置手滑不能把这条路径弄成 NaN 定时器）。 */
export function positiveOr(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback
}

/** 限频参数（`core/presence.ts` 自己会再夹一遍安全值）。 */
export function limitsOf(settings: PresenceView): PresenceLimits {
  return {
    judgeIntervalMs: settings.judgeIntervalMs,
    speakMinIntervalMs: settings.speakMinIntervalMs,
    speakMaxPerHour: settings.speakMaxPerHour,
  }
}

/** 一次判断的输入（背景已由调用方按条数/字数裁好、时间正序）。 */
export interface CycleInput {
  readonly groupId: number
  readonly settings: PresenceView
  /** 判断之前的记账状态（不可变对象）。 */
  readonly state: PresenceState
  readonly background: readonly JudgeEntry[]
  /** 她最近在群里说过的话（防重复）。 */
  readonly sentLines: readonly string[]
  /** 提示词里的"现在几点"（由调用方用注入时钟格式化）。 */
  readonly nowLabel: string
  /** 群聊可见的人格快照（P0 §4.2）；`null` = 拿不到，提示词里明说降级。 */
  readonly persona: GroupPersonaSnapshot | null
  /** 这一轮召回的记忆（P1）。缺省 = 没有（`EMPTY_RECALL`）。 */
  readonly memory?: GroupMemoryRecall
}

/** 这一次流程能碰到的外部世界（全部注入，测试里全是假件）。 */
export interface CycleDeps {
  readonly clock: Clock
  readonly log: (line: string) => void
  /** **每次现取**：热加载后旧客户端会被换掉，缓存它等于抓着死对象。 */
  readonly platform: () => ChatPlatform
  readonly complete: CompletePort
  readonly recordSent: (groupId: number, messageId: number | null, text: string) => Promise<void>
  /**
   * 记一条时间线事件（P3 §7.2）；缺省 = 不记（旧装配/测试）。
   *
   * 为什么由流程来记而不是调用方：**只有拿到回执**才知道发成功了，而"发成功了"才是
   * "这条该进时间线"的判据。放在外面记会变成"发之前就记上"，失败时会留下假事件。
   */
  readonly recordEvent?: (event: { kind: 'proactive_message' | 'agent_reply'; messageId: number; text: string; atMs: number; targetMessageId?: number }) => void
}

/**
 * 一次判断的结局（三种，穷尽）。
 *
 * 每种都带**记账之后**的 `state`：调用方只负责把它放回去，不再自己算账——
 * 两处都记账是"失败被记成一次发言"的典型来源。
 */
export type CycleOutcome =
  | {
    readonly kind: 'spoke'
    readonly action: 'reply' | 'join' | 'react'
    readonly text: string
    readonly messageId: number
    readonly selfId: number | null
    readonly targetMessageId?: number
    readonly state: PresenceState
  }
  | { readonly kind: 'silent'; readonly reason: string; readonly state: PresenceState; readonly action?: 'silent' | 'observe' }
  | { readonly kind: 'failed'; readonly detail: string; readonly state: PresenceState }

/**
 * 跑一次判断（**绝不抛**）。
 *
 * 分档：模型正常回答"沉默/观察"是**成功**；输出形状不对（坏 JSON / 空正文 / 超长 / 带 @）
 * 或目标不合格（编造的消息号）算**失败**——连续失败会触发暂停，这样"模型一直胡说"
 * 不会变成"每 50 秒花一次钱"。
 */
export async function runPresenceCycle(input: CycleInput, deps: CycleDeps): Promise<CycleOutcome> {
  const replyMaxChars = positiveOr(input.settings.replyMaxChars, DEFAULTS.replyMaxChars)
  const memory = input.memory ?? EMPTY_RECALL
  const prompt = buildSocialPrompt({
    groupId: input.groupId,
    persona: input.persona,
    background: input.background,
    sentLines: input.sentLines,
    groupMemory: memory.group,
    memberMemory: memory.member,
    topic: memory.topic,
    replyMaxChars,
    nowLabel: input.nowLabel,
    memoryBudgetChars: positiveOr(input.settings.memoryBudgetChars ?? DEFAULTS.memoryBudgetChars, DEFAULTS.memoryBudgetChars),
  })
  const result = await deps.complete.complete({
    prompt,
    maxTokens: positiveOr(input.settings.judgeMaxTokens, DEFAULTS.judgeMaxTokens),
    timeoutMs: positiveOr(input.settings.judgeTimeoutMs, DEFAULTS.judgeTimeoutMs),
    sessionId: `presence-judge-${String(input.groupId)}`,
    preferredEffort: 'low',
  })
  if (result.kind !== 'text') {
    return failed(input, deps, `判断调用不可用：${result.kind}${detailTail(result)}`)
  }
  const ctx: DecisionContext = {
    messages: input.background.map((entry) => ({ messageId: entry.messageId, atMs: entry.atMs })),
    replyMaxChars,
    nowMs: deps.clock.now(),
    windowMs: positiveOr(input.settings.replyWindowMs ?? DEFAULTS.replyWindowMs, DEFAULTS.replyWindowMs),
  }
  const outcome = parseSocialDecision(result.text, ctx)
  if (outcome.kind === 'invalid') return failed(input, deps, `判断输出不可用（${outcome.reason}）`)
  if (outcome.kind === 'silent') return silent(input, deps, `判断为不说话（${outcome.reason}）`, 'silent')
  const decision = outcome.decision
  if (!sendsMessage(decision.action)) {
    const label = decision.action === 'observe' ? '观察' : '沉默'
    const topic = decision.action === 'observe' && decision.topic !== undefined ? `；关注话题「${decision.topic}」` : ''
    return silent(input, deps, `判断为${label}（${decision.reason}）${topic}`, decision.action === 'observe' ? 'observe' : 'silent')
  }
  const checked = validateSocialDecision(decision, ctx)
  if (!checked.ok) return failed(input, deps, `决策被代码拦下（${checked.reason}）`)
  return await speak(input, deps, decision as SpeakingDecision)
}

/** 三个"要发消息"的动作共用的最小面（`validateSocialDecision` 已经排除了不发的那两个）。 */
type SpeakingDecision = Extract<SocialDecision, { text: string }>

/** 说：先复核发言限频，再发；**只有拿到回执**才记账（成功/失败都要有一行日志）。 */
async function speak(input: CycleInput, deps: CycleDeps, decision: SpeakingDecision): Promise<CycleOutcome> {
  const before = deps.clock.now()
  const verdict = speakVerdict(input.state, before, limitsOf(input.settings))
  if (!verdict.ok) return silent(input, deps, `判断说可以，但这一轮不开口（${String(verdict.reason)}）`)
  const sent = await send(input, deps, decision)
  if (sent.kind === 'failed') return sent.outcome
  const atMs = deps.clock.now()
  const state = recordSpeak(recordJudge(input.state, atMs, 'spoke', limitsOf(input.settings)), atMs)
  const target = decision.action === 'reply' ? `，引用 #${String(decision.targetMessageId)}` : ''
  deps.log(
    `presence: 群 ${String(input.groupId)} 已自主发言 ${decision.action} #${String(sent.messageId)}`
    + `（${String([...decision.text].length)} 字${target}）`,
  )
  try {
    await deps.recordSent(input.groupId, sent.messageId, decision.text)
  } catch (error) {
    deps.log(`presence: 群 ${String(input.groupId)} sent-log 写入失败（已忽略）：${describe(error)}`)
  }
  try {
    deps.recordEvent?.({
      kind: 'proactive_message',
      messageId: sent.messageId,
      text: decision.text,
      atMs,
      ...(decision.action === 'reply' ? { targetMessageId: decision.targetMessageId } : {}),
    })
  } catch (error) {
    deps.log(`presence: 群 ${String(input.groupId)} 事件记账失败（已忽略）：${describe(error)}`)
  }
  return {
    kind: 'spoke',
    action: decision.action,
    text: decision.text,
    messageId: sent.messageId,
    selfId: sent.selfId,
    ...(decision.action === 'reply' ? { targetMessageId: decision.targetMessageId } : {}),
    state,
  }
}

/** 真的把这一句发出去。`message_id` 不是 number 一律当没成（不重试、不连发）。 */
async function send(
  input: CycleInput,
  deps: CycleDeps,
  decision: SpeakingDecision,
): Promise<
  | { readonly kind: 'sent'; readonly messageId: number; readonly selfId: number | null }
  | { readonly kind: 'failed'; readonly outcome: CycleOutcome }
> {
  let platform: ChatPlatform
  try {
    platform = deps.platform()
  } catch (error) {
    return { kind: 'failed', outcome: failed(input, deps, `取平台失败：${describe(error)}`) }
  }
  // `reply` 用引用段：这是"在回哪一条"唯一的可见标记（也是模型给的号唯一被用到的地方）。
  // 引用段里的 id 只接受**本轮已经通过校验**的那个号——绝不把模型给的原样塞进去。
  const message = decision.action === 'reply'
    ? [{ type: 'reply' as const, data: { id: String(decision.targetMessageId) } }, { type: 'text' as const, data: { text: decision.text } }]
    : [{ type: 'text' as const, data: { text: decision.text } }]
  try {
    const receipt = await platform.api.sendGroupMessage(input.groupId, message)
    const id = receipt?.message_id
    if (typeof id !== 'number') {
      return { kind: 'failed', outcome: failed(input, deps, '自主发言没有 message_id 回执（不记成功、不重试）') }
    }
    return { kind: 'sent', messageId: id, selfId: platform.selfId }
  } catch (error) {
    return { kind: 'failed', outcome: failed(input, deps, `自主发言发送失败（不重试）：${describe(error)}`) }
  }
}

/** 记一次"不说话"（判断成功但结论是不说/观察，或复核被限频挡下）。 */
function silent(input: CycleInput, deps: CycleDeps, reason: string, action?: 'silent' | 'observe'): CycleOutcome {
  deps.log(`presence: 群 ${String(input.groupId)} ${reason}`)
  const state = recordJudge(input.state, deps.clock.now(), 'silent', limitsOf(input.settings))
  return { kind: 'silent', reason, state, ...(action === undefined ? {} : { action }) }
}

/** 记一次失败（**绝不**记成一次自主发言：失败只影响 `failures`）。 */
function failed(input: CycleInput, deps: CycleDeps, detail: string): CycleOutcome {
  deps.log(`presence: 群 ${String(input.groupId)} ${detail}`)
  const state = recordJudge(input.state, deps.clock.now(), 'failed', limitsOf(input.settings))
  return { kind: 'failed', detail, state }
}

/** 端口结果里的 `detail` 只在一部分档位上存在，取不到就当没有。 */
function detailTail(result: CompleteResult): string {
  return result.kind === 'failed' || result.kind === 'no-route' || result.kind === 'timeout'
    ? `（${result.detail ?? '无详情'}）`
    : ''
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
