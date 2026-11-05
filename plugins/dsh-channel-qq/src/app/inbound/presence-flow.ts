/** **一次**兴趣判断的完整流程：组提示词 → 调模型 → 严格解析 → 复核限频 → 发一句 → 记账。
 *
 * 为什么与 `presence-runtime.ts` 分家：两件事的生命周期不一样。
 *   - 这里是一次**有始有终**的流程（说完就结束，最长活一次模型超时的时间）；
 *   - 那边是**常驻状态机**（每群游标、合批定时器、限频状态、卸载）。
 * 混在一起时，"发送失败要不要重试""谁推进游标""dispose 之后还会不会发"这些问题
 * 会同时出现在 400 行里，读的人只能靠猜。
 *
 * 三条口径（这里说的话，是通道**直接**发到群里的，没有回合、没有工具、没有人复核）：
 *   1. **只有真实回执才算说过话**：`message_id` 是 number 才 `recordSpeak` + 记 sent-log；
 *      失败/无回执只推进失败计数（连续失败由 `core/presence.ts` 暂停一阵），
 *      **不重试、不连发**——重试属于模型预算层，这里再叠一层就是两套账。
 *   2. **发之前再复核一次**：判断花掉的那几秒里，别人可能已经说过话、可能已经到冷却、
 *      可能已经被暂停。`speakVerdict` 就是这最后一道闸。
 *   3. **每条出口都是可判别结果**（`spoke` / `silent` / `failed`），**绝不抛**：
 *      判断这条路径上"模型坏了"必须等于"这一轮不说话"，不是异常。
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
import { buildJudgePrompt, parseJudgeReply, type JudgeEntry } from './presence-judge.js'
import type { PresenceSettings } from './ambient-store.js'

// ── 一次纯补全的端口（实现在 `adapters/dsh-host/completion.ts`） ──────────────
//
// 端口**类型**放在消费者这一侧：`app/` 不许 import `adapters/`（分层检查 R8），
// 所以适配器实现它、装配侧把它们接起来（与 `features/contact/model.ts` 把 `DraftPort`
// 放在消费者一侧是同一个道理）。

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
  readonly judgeIntervalMs: number
  readonly judgeMaxEntries: number
  readonly judgeMaxChars: number
  readonly judgeTimeoutMs: number
  readonly judgeMaxTokens: number
  readonly speakMinIntervalMs: number
  readonly speakMaxPerHour: number
  readonly replyMaxChars: number
}

/** 默认值：配置给坏了也不能把这条路径弄崩。 */
export const DEFAULTS = {
  judgeIntervalMs: 50_000,
  judgeMaxEntries: 15,
  judgeMaxChars: 1_200,
  judgeTimeoutMs: 25_000,
  judgeMaxTokens: 320,
  speakMinIntervalMs: 300_000,
  speakMaxPerHour: 3,
  replyMaxChars: 70,
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
}

/** 这一次流程能碰到的外部世界（全部注入，测试里全是假件）。 */
export interface CycleDeps {
  readonly clock: Clock
  readonly log: (line: string) => void
  /** **每次现取**：热加载后旧客户端会被换掉，缓存它等于抓着死对象。 */
  readonly platform: () => ChatPlatform
  readonly complete: CompletePort
  readonly recordSent: (groupId: number, messageId: number | null, text: string) => Promise<void>
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
    readonly text: string
    readonly messageId: number
    readonly selfId: number | null
    readonly state: PresenceState
  }
  | { readonly kind: 'silent'; readonly reason: string; readonly state: PresenceState }
  | { readonly kind: 'failed'; readonly detail: string; readonly state: PresenceState }

/**
 * 跑一次判断（**绝不抛**）。
 *
 * 分档：`speak:false` 是**成功**（模型正常回答"不说"）；输出形状不对（坏 JSON / 空正文 /
 * 超长 / 带 @）算**失败**——连续失败会触发暂停，这样"模型一直胡说"不会变成"每 50 秒花一次钱"。
 */
export async function runPresenceCycle(input: CycleInput, deps: CycleDeps): Promise<CycleOutcome> {
  const replyMaxChars = positiveOr(input.settings.replyMaxChars, DEFAULTS.replyMaxChars)
  const prompt = buildJudgePrompt({
    groupId: input.groupId,
    background: input.background,
    sentLines: input.sentLines,
    replyMaxChars,
    nowLabel: input.nowLabel,
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
  const outcome = parseJudgeReply(result.text, replyMaxChars)
  if (outcome.kind === 'silent') {
    if (!outcome.reason.startsWith('speak-false')) {
      return failed(input, deps, `判断输出不可用（${outcome.reason}）`)
    }
    return silent(input, deps, `判断为不说话（${outcome.reason}）`)
  }
  return await speak(input, deps, outcome.text)
}

/** 说：先复核发言限频，再发；**只有拿到回执**才记账（成功/失败都要有一行日志）。 */
async function speak(input: CycleInput, deps: CycleDeps, text: string): Promise<CycleOutcome> {
  const before = deps.clock.now()
  const verdict = speakVerdict(input.state, before, limitsOf(input.settings))
  if (!verdict.ok) return silent(input, deps, `判断说可以，但这一轮不开口（${String(verdict.reason)}）`)
  const sent = await send(input, deps, text)
  if (sent.kind === 'failed') return sent.outcome
  const atMs = deps.clock.now()
  const state = recordSpeak(recordJudge(input.state, atMs, 'spoke', limitsOf(input.settings)), atMs)
  deps.log(`presence: 群 ${String(input.groupId)} 已自主发言 #${String(sent.messageId)}（${String([...text].length)} 字）`)
  try {
    await deps.recordSent(input.groupId, sent.messageId, text)
  } catch (error) {
    deps.log(`presence: 群 ${String(input.groupId)} sent-log 写入失败（已忽略）：${describe(error)}`)
  }
  return { kind: 'spoke', text, messageId: sent.messageId, selfId: sent.selfId, state }
}

/** 真的把这一句发出去。`message_id` 不是 number 一律当没成（不重试、不连发）。 */
async function send(
  input: CycleInput,
  deps: CycleDeps,
  text: string,
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
  try {
    const receipt = await platform.api.sendGroupMessage(input.groupId, [{ type: 'text', data: { text } }])
    const id = receipt?.message_id
    if (typeof id !== 'number') {
      return { kind: 'failed', outcome: failed(input, deps, '自主发言没有 message_id 回执（不记成功、不重试）') }
    }
    return { kind: 'sent', messageId: id, selfId: platform.selfId }
  } catch (error) {
    return { kind: 'failed', outcome: failed(input, deps, `自主发言发送失败（不重试）：${describe(error)}`) }
  }
}

/** 记一次"不说话"（判断成功但结论是不说，或复核被限频挡下）。 */
function silent(input: CycleInput, deps: CycleDeps, reason: string): CycleOutcome {
  deps.log(`presence: 群 ${String(input.groupId)} ${reason}`)
  const state = recordJudge(input.state, deps.clock.now(), 'silent', limitsOf(input.settings))
  return { kind: 'silent', reason, state }
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
