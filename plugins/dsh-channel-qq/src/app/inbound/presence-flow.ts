/** 社交决策的**判断层**：组提示词 → 调模型 → 严格解析 → 代码校验。
 *
 * 分工（P5-B 之后按"想 / 做"切开，两个文件的失败模式完全不同）：
 *   - **本文件**：想。模型只**提**决策（`silent/observe/reply/join/react`），代码验证动作、
 *     目标消息、时间窗、长度。这里**不发任何东西**。
 *   - `presence-send.ts`：做。限频复核 → 模式闸门 → 发送 → 记账（只有拿到 `message_id` 才算说过）。
 *   - `presence-runtime.ts`：常驻状态机（每群游标、合批定时器、限频状态、卸载）。
 *
 * 为什么想与做必须分开：想的时候会花一次模型调用，做的时候会往群里发东西。把两者写在
 * 同一个函数里，"我以为只改了判断"就会变成"实际改了发送"——这正是 P5 要防的事。
 *
 * 三条口径：
 *   1. **每条出口都是可判别结果**（`spoke` / `silent` / `shadow` / `failed`），**绝不抛**；
 *   2. **判断失败与模型沉默分开记账**：前者累积、连坏几次暂停，后者是正常成功；
 *   3. **被模式拦下不是失败**：见 `presence-send.ts` 的 `shadowed`。
 */

import type { PresenceLimits, PresenceState } from '../../core/presence.js'
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
import { renderScene, runSocialGuard } from './presence-scene.js'
import { EMPTY_RECALL, type GroupMemoryRecall } from './group-memory-contract.js'
import { failed, silent, speak } from './presence-send.js'

// 重新导出：这些是判断层的公开面（runtime / cycle / 测试都从这里取），
// 真正的实现在 `presence-send.ts`（"做"的那一半）。
export { failed, silent, speak } from './presence-send.js'

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
  readonly starvationWarnMs?: number
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
  starvationWarnMs: 25_000,
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
  /**
   * 她最近说过的话**带时间**（P6-B 的复读复核要用真实间隔）。
   *
   * 与 {@link sentLines} 分开：那个是**给提示词看的纯文本**（提示词不需要时间），
   * 这个是给判定看的。缺省时退回 `sentLines` 并假定"刚刚说的"——保守方向是**多拦**，
   * 而 warn 档又不拦，所以缺省不会误伤。
   */
  readonly selfSaid?: ReadonlyArray<{ text: string; atMs: number }>
  /**
   * 这条想回的消息上**已有的回答**（P6-B 的"重复抢答"复核）。
   *
   * 由调用方从时间线里取（引用了那条问句、或直接回到提问者的消息）。缺省 = 没有，
   * 于是 G10 那条规则不生效——它只拦"换个人把同一句再说一遍"，不拦真正的新信息。
   */
  readonly existingAnswers?: readonly string[]
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
  /**
   * **最后一道发送闸门**（P5-B）：每一次真的要发之前现取当前运行模式。
   *
   * 为什么是函数而不是装配时定下的布尔：管理员把 `live` 改成 `shadow` 的那一刻，
   * 可能正好有一次模型调用在飞。装配时读一次的做法会让那次调用回来照发——这正是
   * 计划 §7.1 点名的最高风险。所以这里每次重新问一遍。
   *
   * 缺省 = `undefined`，含义是"没有闸门"（旧装配与单测）；此时按 `live` 处理，
   * 保持 P1–P4 的行为不变。
   */
  readonly sendGate?: () => string
  /**
   * 影子日志（`shadow` 模式下"本来想发什么、为什么"）；缺省 = 不记。
   *
   * 只记动作与文本，**不带 message_id**——它没发出去，不能当成"说过话"。
   */
  readonly recordShadow?: (decision: {
    groupId: number
    action: 'reply' | 'join' | 'react'
    text: string
    targetMessageId?: number
    reason: string
    atMs: number
    blockedBy: string
  }) => void
  /**
   * 她自己的 QQ 号（P6-A）：社交场景要判"有没有人真的 @ 了我"。
   *
   * 缺省 = `undefined`：`buildSocialScene` 会把 `askedMe` 保守地判成 false，
   * 而不是拿 0 或别人的号顶替——那种"猜一个自己"的错误会直接变成"以为在叫她"。
   */
  readonly selfId?: () => number
  /**
   * 语义复核的档位（P6-B）：`off` / `warn` / `enforce`。
   *
   * 缺省 = `warn`（只记不拦）：这一层是 P6 新增的，阈值未经真实样本校准，
   * 默认拦会把"她少说话了"变成没人能解释的现象。见 `core/group-social-guard.ts`。
   */
  readonly guardMode?: () => string
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
  /**
   * 判断通过、校验通过、但运行模式不允许发送（`shadow` / `off`）。
   *
   * **不是失败**：模型与代码都正常，只是被闸门拦下。所以它按"判断成功"记账
   * （不累积 failures、不占发言额度、不推进发言冷却），另外留一条影子日志。
   * 把它记成失败，会让 shadow 跑一会儿就把自己暂停掉。
   */
  | {
    readonly kind: 'shadow'
    readonly action: 'reply' | 'join' | 'react'
    readonly text: string
    readonly targetMessageId?: number
    readonly blockedBy: string
    readonly state: PresenceState
  }
  | { readonly kind: 'failed'; readonly detail: string; readonly state: PresenceState }

/**
 * 跑一次判断（**绝不抛**）。
 *
 * 分档：模型正常回答"沉默/观察"是**成功**；输出形状不对（坏 JSON / 空正文 / 超长 / 带 @）
 * 或目标不合格（编造的消息号）算**失败**——连续失败会触发暂停，这样"模型一直胡说"
 * 不会变成"每 50 秒花一次钱"。
 *
 * 社交场景（P6-A）与语义复核（P6-B）在 `presence-scene.ts`：它们共用同一批事实，
 * 但一个负责"让模型看懂"，一个负责"这一句能不能发"。
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
    // 社交结构（P6-A）：只给**事实**，不给结论；判不准就是 uncertain。
    scene: renderScene(input, deps),
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
  // 语义复核（P6-B）：四条"代码能判的事实"规则。`warn` 档只记不拦（默认档，
  // 理由见 `core/group-social-guard.ts` 的模式注释：阈值未经真实样本校准）。
  const guard = runSocialGuard(input, deps, decision as SpeakingDecision)
  if (!guard.ok) return silent(input, deps, `语义复核拦下（${guard.reason}）：${guard.detail}`, 'silent')
  return await speak(input, deps, decision as SpeakingDecision)
}

/** 三个"要发消息"的动作共用的最小面（`validateSocialDecision` 已经排除了不发的那两个）。 */
export type SpeakingDecision = Extract<SocialDecision, { text: string }>

/** 端口结果里的 `detail` 只在一部分档位上存在，取不到就当没有。 */
function detailTail(result: CompleteResult): string {
  return result.kind === 'failed' || result.kind === 'no-route' || result.kind === 'timeout'
    ? `（${result.detail ?? '无详情'}）`
    : ''
}