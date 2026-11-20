/** opencode **云端 Jev** 的线协议（`POST /inference/systemone/v1/systemone`）。
 *
 * 纯函数、零 IO：这样"问句怎么组、答案怎么读"能单独测，也不需要显卡或网络。
 *
 * 与 `jev-score` 本地协议的三处**结构差异**（照抄会静默出错，所以逐条记）：
 *
 *   1. **一次请求就是一组具名问句**：本地是 `questions: [{ids, slots, rows}]`（要求调用方
 *      自己算 token 位置），云端是 `questions: {名字: {type, instructions, criteria}}`——
 *      分词、位置、logits 全在对端。所以渲染器在这里**不参与**，`request.state` 原样当
 *      `state` 发过去。
 *   2. **答案的信任字段不同**：`noul` 直接给 `p(true)`（已校准）；`choice` 给
 *      `choice` + `confidence` + `probabilities`。**`confidence` 不等于 `max(probabilities)`**
 *      （实测 0.51 vs 0.63），而折判的 `phraseMinProbability` 门槛按 `max(probabilities)`
 *      标定过，所以这里只用 `max(probabilities)`，不用 `confidence`。
 *   3. **`criteria` 允许 `null`**（描述可省），单个选项也合法——本地渲染器本来就是这么传的，
 *      所以两边能共用同一份 `GATE_QUESTIONS` / `PHRASE_BANKS` / 目标候选。
 *
 * 认证与传输的坑在 `hosted-judge.ts` 的文件头（UA、key 引用名、错误映射）。
 */

import type { GateId, Scene } from '../../app/inbound/judge-gates.js'
import { GATE_QUESTIONS, phrasesOf } from '../../app/inbound/judge-gates.js'
import type { ScoredAnswer, TypedAnswers } from '../../app/inbound/judge-verdict.js'
import type { JudgeLine, JudgeRequest } from '../../app/inbound/judge-port.js'

/** 云端认的一道问句。`criteria` 可以是选项字典，也可以省（`noul` 用）。 */
export interface HostedQuestion {
  readonly type: 'noul' | 'choice'
  readonly instructions: string
  readonly criteria?: Readonly<Record<string, string | null>>
}

/** 一次判断要发的全部问句（键就是答案的键）。 */
export type HostedQuestions = Readonly<Record<string, HostedQuestion>>

/** 短语选择的问句（四个场景共用同一句：问法一致，概率才可比）。 */
export const PHRASE_QUESTION = '她插一句最合适的是哪一句'
/** 目标选择的问句。 */
export const TARGET_QUESTION = '她最自然的做法是回应哪一条消息'

/** 短语库问句的键前缀（`phrase:tech` 之类）。 */
export const PHRASE_KEY = 'phrase:'
/** 目标问句的键。 */
export const TARGET_KEY = 'target'

/** 本轮可以用作引用目标的消息号（排除她自己发的与合成消息）。 */
export function targetIdsOf(request: JudgeRequest, maxTargets: number): number[] {
  const ids: number[] = []
  for (const line of request.lines) {
    if (line.self) continue
    if (typeof line.messageId !== 'number' || !Number.isSafeInteger(line.messageId)) continue
    ids.push(line.messageId)
  }
  return maxTargets > 0 ? ids.slice(-maxTargets) : ids
}

/**
 * 组这一轮的全部问句。
 *
 * 顺序无关（云端按名字回），但**键集合必须稳定**：折判按 `phrase:<scene>` 取值，
 * 少一个场景就等于那一轮"该说话却没有短语可挑"（会退化成 `invalid: phrase-missing`）。
 */
export function buildQuestions(input: {
  readonly gates: readonly GateId[]
  readonly scenes: readonly Scene[]
  readonly targets: readonly number[]
}): HostedQuestions {
  const questions: Record<string, HostedQuestion> = {}
  for (const gate of input.gates) {
    // `noul` 不带 `criteria`：带一个空字典会被对端当成"要选一个都不存在的选项"。
    questions[gate] = { type: 'noul', instructions: GATE_QUESTIONS[gate] }
  }
  for (const scene of input.scenes) {
    questions[`${PHRASE_KEY}${scene}`] = {
      type: 'choice',
      instructions: PHRASE_QUESTION,
      criteria: phrasesOf(scene),
    }
  }
  if (input.targets.length > 0) {
    // 目标选项名就是消息号，描述留空：候选之间没有语义差别，写描述只会给对端额外噪声。
    const criteria: Record<string, string | null> = {}
    for (const id of input.targets) criteria[String(id)] = null
    questions[TARGET_KEY] = { type: 'choice', instructions: TARGET_QUESTION, criteria }
  }
  return questions
}

/** 云端一次 `noul` 的答案。 */
interface NoulAnswer {
  readonly type?: string
  readonly noul?: unknown
}

/** 云端一次 `choice` 的答案。 */
interface ChoiceAnswer {
  readonly type?: string
  readonly choice?: unknown
  readonly probabilities?: Record<string, unknown>
}

/** 从 `noul` 答案里读 `p(true)`（不是数字 → `null`，调用方按形状错处理）。 */
function probabilityOf(answer: unknown): number | null {
  if (answer === null || typeof answer !== 'object') return null
  const value = (answer as NoulAnswer).noul
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.min(1, Math.max(0, value))
}

/** `p(true)` → 折判认的 `ScoredAnswer`（阈值 0.5，与本地 `noul` 的语义一致）。 */
function noulAnswer(answer: unknown): ScoredAnswer | null {
  const p = probabilityOf(answer)
  if (p === null) return null
  const picksTrue = p >= 0.5
  return { answer: picksTrue ? 'true' : 'false', topProbability: picksTrue ? p : 1 - p }
}

/**
 * 从 `choice` 答案里读选中项与**它自己的概率**。
 *
 * 为什么不用 `confidence`：实测它比 `max(probabilities)` 低（0.51 vs 0.63），而
 * `phraseMinProbability` 是照后者标定的——用 `confidence` 会让门槛系统性收紧，
 * 表现是"该说话时总说置信度不够"。`probabilities` 缺失时退回 `confidence`（总比没有强）。
 */
function choiceAnswer(answer: unknown, allowed: readonly string[]): ScoredAnswer | null {
  if (answer === null || typeof answer !== 'object') return null
  const body = answer as ChoiceAnswer
  const picked = typeof body.choice === 'string' ? body.choice : ''
  if (picked === '' || !allowed.includes(picked)) return null
  const table = body.probabilities !== null && typeof body.probabilities === 'object'
    ? body.probabilities
    : {}
  let best = -1
  for (const name of allowed) {
    const value = table[name]
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    if (value > best) best = value
  }
  if (best < 0) return null
  return { answer: picked, topProbability: Math.min(1, Math.max(0, best)) }
}

/** 读答案时要的全部上下文（哪个场景、哪个目标、哪些门）。 */
export interface AnswerShape {
  readonly gates: readonly GateId[]
  readonly scenes: readonly Scene[]
  /** 目标候选（顺序无关；用来校验"选中的号在不在候选里"）。 */
  readonly targets: readonly number[]
}

/**
 * 云端回复 → {@link TypedAnswers}（折判的入参）。
 *
 * **形状不对返回 `null`**，由调用方折成 `invalid:shape`（那是我们自己的错，不是对端的）。
 * 缺一条门不算错：`gateFactsFrom` 会把缺席的按 `false` 处理——那是保守方向（更容易不说话）。
 */
export function answersOf(payload: unknown, shape: AnswerShape): TypedAnswers | null {
  if (payload === null || typeof payload !== 'object') return null
  const table = (payload as { answers?: unknown }).answers
  if (table === null || typeof table !== 'object') return null
  const map = table as Record<string, unknown>

  const gates: Partial<Record<GateId, ScoredAnswer>> = {}
  for (const gate of shape.gates) {
    const scored = noulAnswer(map[gate])
    if (scored !== null) gates[gate] = scored
  }

  const phrases: Partial<Record<Scene, ScoredAnswer>> = {}
  for (const scene of shape.scenes) {
    const allowed = Object.keys(phrasesOf(scene))
    const scored = choiceAnswer(map[`${PHRASE_KEY}${scene}`], allowed)
    if (scored !== null) phrases[scene] = scored
  }

  const targetNames = shape.targets.map((id) => String(id))
  const target = targetNames.length === 0
    ? undefined
    : (choiceAnswer(map[TARGET_KEY], targetNames) ?? undefined)

  return {
    gates,
    phrases,
    ...(target === undefined ? {} : { target }),
  }
}

/** 云端用量（`usage` 段，实测字段名就是这些）。 */
export interface HostedUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  /** 这次花了多少钱（美元；免费 id 恒为 0）。 */
  readonly costUsd: number
  /** `balance`（付费）/ `free`（免费入口）。 */
  readonly billing: string
}

/** 从 `usage` 里读用量；缺字段给 0（诊断用，不该因为少一个数字就判形状错）。 */
export function usageOf(payload: unknown): HostedUsage {
  const root = payload !== null && typeof payload === 'object' ? (payload as { usage?: unknown }) : {}
  const usage = root.usage !== null && typeof root.usage === 'object' ? root.usage as Record<string, unknown> : {}
  const opencode = usage['opencode'] !== null && typeof usage['opencode'] === 'object'
    ? usage['opencode'] as Record<string, unknown>
    : {}
  const numberAt = (source: Record<string, unknown>, key: string): number => {
    const value = source[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : 0
  }
  return {
    inputTokens: numberAt(usage, 'input_tokens'),
    outputTokens: numberAt(usage, 'output_tokens'),
    costUsd: numberAt(usage, 'cost'),
    billing: typeof opencode['billing_source'] === 'string' ? opencode['billing_source'] : '',
  }
}

/** 请求体：`{model, state, questions}`（**没有** `messages`，Jev 不是聊天模型）。 */
export function bodyOf(model: string, state: string, questions: HostedQuestions): string {
  return JSON.stringify({ model, state, questions })
}

/** `nowLabel` 的形状（`judge-state.ts` 用的那种）；只在这里用来提醒调用方传字符串。 */
export type NowLabel = string
