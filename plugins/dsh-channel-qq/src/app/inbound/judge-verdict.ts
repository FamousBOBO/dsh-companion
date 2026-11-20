/** 把 typed 打分结果折成 {@link JudgeVerdict}：门 → 决策表 → 短语 → 目标 → 校验。
 *
 * 为什么单独一个文件而不是并进 `judge-gates.ts`：那个文件是**纯业务规则**
 * （问句、决策表、短语库），一句 IO 都没有、改它只改"判断口径"；
 * 这里是**装配**——它要知道阈值、时间窗、消息号，还要把结果收成端口契约的形状。
 * 两件事混在一起时，改一个阈值就得读整张决策表。
 *
 * 三条硬口径：
 *   1. 短语没把握（`topProbability < phraseMinProbability`）→ 这一轮不说，
 *      记 `phrase-low-confidence`；**不降级成别的短语**，因为那是"拿低置信度的选择去说话"；
 *   2. `reply` 的目标必须在本轮真实消息里且还在时间窗内，否则降级 `react`
 *      （与 `parseSocialDecision` 的旧格式行为一致：一句反应仍然成立，不该让这一轮白跑）；
 *   3. 正文再过一遍字符约束（长度 / `@` / `[CQ:`）——短语库是人写的，但配置可以改，
 *      而"发出去才发现超长"是不可逆的。
 *
 * 关键形状：短语是**按场景**分别打分的（每个库一次 choice）。决策表决定用哪个场景，
 * 折判才从那个库的结果里取——这样"技术话题"不会被"笑一笑"那张库的低概率拖下水。
 */

import { cleanText, isPlaceholder } from './presence-judge.js'
import {
  SCENES,
  gateFactsFrom,
  phraseTextOf,
  phrasesOf,
  ruleTable,
  type GateFacts,
  type GateId,
  type Scene,
  type TableOutcome,
} from './judge-gates.js'
import type { JudgeLine, JudgeRequest, JudgeVerdict } from './judge-port.js'

/** 一个问句的打分结果（打分器给的原始形状里挑出来的两项）。 */
export interface ScoredAnswer {
  /** 选中的选项名（`noul` 是 `'true'`/`'false'`）。 */
  readonly answer: string
  /** 选中项的概率（0–1）。 */
  readonly topProbability: number
}

/** 一次判断的全部 typed 结果（缺项表示那个问句没问/没返回）。 */
export interface TypedAnswers {
  /** 九门的答案，按 id 索引；缺的按 `false` 处理（见 `gateFactsFrom`）。 */
  readonly gates: Readonly<Partial<Record<GateId, ScoredAnswer>>>
  /** 每个场景的短语选择结果（只对启用到的场景有值）。 */
  readonly phrases: Readonly<Partial<Record<Scene, ScoredAnswer>>>
  /** 目标消息选择的结果。 */
  readonly target?: ScoredAnswer | undefined
}

/** 折判需要的阈值（来自 `judge.*` 与 `presence.*` 配置，由调用方解析）。 */
export interface VerdictLimits {
  /** 短语选择的最优概率门槛。 */
  readonly phraseMinProbability: number
  /** 正文长度上限（码点）。 */
  readonly replyMaxChars: number
  /** 允许引用的时间窗（毫秒）。 */
  readonly windowMs: number
}

/** 折判的结果：verdict + 进 shadow 账本的两项观测。 */
export interface FoldOutcome {
  readonly verdict: JudgeVerdict
  /** 这一轮用到的场景（不说话时 `null`）。 */
  readonly scene: Scene | null
  /** 短语 id 与概率（没选短语时 `null`）。 */
  readonly phrase: { readonly name: string; readonly probability: number } | null
}

/** 码点长度（emoji 不算两个字）。 */
function lengthOf(text: string): number {
  return [...text].length
}

/**
 * 本轮可以作为引用目标的消息号。
 *
 * 三条排除：`null` 号（合成消息）、她自己发的、超出时间窗的。
 * `self` 必须排除：引用自己刚说的话在群里看着像自言自语。
 */
export function candidateTargets(
  lines: readonly JudgeLine[],
  nowMs: number,
  windowMs: number,
  maxCount: number,
): number[] {
  const window = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 0
  const out: number[] = []
  for (const line of lines) {
    if (line.self) continue
    if (line.messageId === null) continue
    if (window > 0 && nowMs - line.atMs > window) continue
    out.push(line.messageId)
  }
  return maxCount > 0 ? out.slice(-maxCount) : out
}

/** 九门答案 → 事实向量（只认 `'true'`）。 */
export function factsOf(answers: TypedAnswers): GateFacts {
  const raw: Partial<Record<GateId, boolean>> = {}
  for (const [id, scored] of Object.entries(answers.gates)) {
    raw[id as GateId] = scored?.answer === 'true'
  }
  return gateFactsFrom(raw)
}

/**
 * 把答案折成 verdict（**绝不抛**）。
 *
 * 分档表（每一档都能在日志里一眼看出来）：
 *
 * | 情况 | verdict |
 * |---|---|
 * | 决策表说 `silent` | `decision: silent`（`why` 是具名理由） |
 * | 决策表说说话，但那个场景没给短语答案 | `invalid: phrase-missing` |
 * | 短语概率低于门槛 | `decision: silent`（`phrase-low-confidence`） |
 * | 短语 id 不在库里 | `invalid: phrase-unknown` |
 * | 正文空 / 超长 / 带 `@` / 带 `[CQ:` | `invalid: …` |
 * | `reply` 但目标号不可用 | 降级 `react`（不带目标，行为与旧格式一致） |
 * | `join` 但没有话题 | 用场景名当话题（短语库是按场景切的，话题就是它） |
 */
export function foldVerdict(
  answers: TypedAnswers,
  request: JudgeRequest,
  limits: VerdictLimits,
  maxTargets = 12,
): FoldOutcome {
  const table = ruleTable(factsOf(answers))
  if (table.action === 'silent') {
    return {
      verdict: { kind: 'decision', action: 'silent', reason: table.why },
      scene: null,
      phrase: null,
    }
  }
  const scene = table.scene
  if (scene === null) return invalid('scene-missing', null)
  const chosen = answers.phrases[scene]
  if (chosen === undefined) return invalid('phrase-missing', scene)
  if (!(chosen.topProbability >= limits.phraseMinProbability)) {
    return {
      verdict: { kind: 'decision', action: 'silent', reason: `phrase-low-confidence:${table.why}` },
      scene,
      phrase: { name: chosen.answer, probability: chosen.topProbability },
    }
  }
  const phrase = { name: chosen.answer, probability: chosen.topProbability }
  const text = phraseTextOf(scene, chosen.answer)
  if (text === null) return invalid(`phrase-unknown:${clip(chosen.answer)}`, scene)
  const body = bodyOf(text)
  if ('problem' in body) return invalid(body.problem, scene)
  const cap = Number.isFinite(limits.replyMaxChars) && limits.replyMaxChars > 0
    ? Math.trunc(limits.replyMaxChars)
    : 0
  if (cap > 0 && lengthOf(body.text) > cap) return invalid(`text-too-long:${String(lengthOf(body.text))}`, scene)
  return speakOut(table, scene, body.text, phrase, answers, request, limits, maxTargets)
}

/** 三个"要发消息"分支的收尾（`react` / `reply` 各自处理目标号）。 */
function speakOut(
  table: TableOutcome,
  scene: Scene,
  text: string,
  phrase: { readonly name: string; readonly probability: number },
  answers: TypedAnswers,
  request: JudgeRequest,
  limits: VerdictLimits,
  maxTargets: number,
): FoldOutcome {
  const targets = candidateTargets(request.lines, request.nowMs, limits.windowMs, maxTargets)
  const target = usableTarget(answers.target, targets)
  if (table.action === 'join') {
    return {
      verdict: { kind: 'decision', action: 'join', topic: scene, text, reason: table.why },
      scene, phrase,
    }
  }
  if (table.action === 'react') {
    return {
      verdict: {
        kind: 'decision', action: 'react', text, reason: table.why,
        ...(target === null ? {} : { targetMessageId: target }),
      },
      scene, phrase,
    }
  }
  // reply：目标必须是本轮真实消息号；拿不到就降级成 react（不带目标）。
  if (target === null) {
    return {
      verdict: { kind: 'decision', action: 'react', text, reason: `reply-degraded:${table.why}` },
      scene, phrase,
    }
  }
  return {
    verdict: { kind: 'decision', action: 'reply', text, reason: table.why, targetMessageId: target },
    scene, phrase,
  }
}

/** 目标号：必须是本轮候选里的某一个（模型编出来的号一律不认）。 */
function usableTarget(scored: ScoredAnswer | undefined, candidates: readonly number[]): number | null {
  if (scored === undefined) return null
  const id = Number(scored.answer)
  if (!Number.isSafeInteger(id) || id <= 0) return null
  return candidates.includes(id) ? id : null
}

/** 一句短语的清洗与基本检查（与 `group-social-decision.ts` 的 `textOf` 同一口径）。 */
function bodyOf(raw: string): { text: string } | { problem: string } {
  const text = cleanText(raw)
  if (text === '') return { problem: 'text-empty' }
  if (text.includes('@') || /\[cq:/i.test(text)) return { problem: 'text-mention' }
  if (isPlaceholder(text)) return { problem: 'text-placeholder' }
  return { text }
}

function invalid(reason: string, scene: Scene | null): FoldOutcome {
  return { verdict: { kind: 'invalid', reason }, scene, phrase: null }
}

/** 日志里的选项名也压一下（模型输出不可信，不能让它带换行进来）。 */
function clip(text: string): string {
  return cleanText(text).slice(0, 20)
}

/** 把一条 verdict 压成一句可读日志（调用方只在这一处拼字符串）。 */
export function describeVerdict(verdict: JudgeVerdict): string {
  switch (verdict.kind) {
    case 'no-route':
      return `判断不可用（${verdict.detail}）`
    case 'invalid':
      return `判断结果不可用（${verdict.reason}）`
    case 'decision': {
      const target = 'targetMessageId' in verdict && verdict.targetMessageId !== undefined
        ? `，引用 #${String(verdict.targetMessageId)}`
        : ''
      const len = 'text' in verdict ? `（${String(lengthOf(verdict.text))} 字${target}）` : ''
      return `${verdict.action}${len}：${verdict.reason}`
    }
    default:
      return '判断结果形状未知'
  }
}

/** 短语库与场景清单的一致性（测试用它钉"库没被清空、场景没漏库"）。 */
export function phraseInventory(): Array<{ scene: Scene; count: number }> {
  return SCENES.map((scene) => ({ scene, count: Object.keys(phrasesOf(scene)).length }))
}
