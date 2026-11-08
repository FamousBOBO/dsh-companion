/** 群聊**社交决策**（P2 §6.1–§6.5）：把"要不要说话"升级成"该怎样参与"，并且由**代码**校验模型提的决策。
 *
 * 为什么决策与执行必须分开（这一条是整个 P2 的地基）：模型负责"想说什么"，代码负责"能不能发"。
 * 模型可以编造一个不存在的消息号，也可能在争执里插一句；只要发送前逐条复核，最坏结果是
 * **这一轮不说话**，而不是发出错的话。
 *
 * 五个动作（§6.1）：
 *   动作      含义                                  能不能发消息
 *   --------  ------------------------------------  ------------
 *   silent    当前没有合适的参与机会                    不发
 *   observe   先不发言，但保留对话题的关注              不发
 *   reply     回应某一条具体消息（必须给目标消息号）      发
 *   join      加入当前正在进行的话题（必须给话题）        发
 *   react     用一句短话/轻量表达作出反应                发
 *
 * 解析与校验都**严格**：任何一处不对就收敛成"这一轮不说话"，并且区分"模型正常说沉默"（成功）
 * 与"输出不可用"（失败）——两者的记账不同：前者只推进判断时刻，后者累积失败、连坏几次就暂停。
 *
 * 兼容一档：P0/P1 的旧输出 `{"speak":true,"reply":"…","why":"…"}` 仍然被接受，映射成
 * `reply`（没有目标号时降级为 `react`）。理由不是"懒得改"——热重载期间新旧提示词可能同时
 * 在跑，解析器不认识旧格式就会把一次正常的判断记成失败。
 */

import { cleanText, isPlaceholder } from './presence-judge.js'

/** 五个动作（§6.1）。 */
export type SocialAction = 'silent' | 'observe' | 'reply' | 'join' | 'react'

/** 一次决策。可判别联合：每个分支的必填字段都不一样，调用方 switch 一次就能穷尽。 */
export type SocialDecision =
  | { readonly action: 'silent'; readonly reason: string }
  | { readonly action: 'observe'; readonly topic?: string; readonly reason: string }
  | { readonly action: 'reply'; readonly targetMessageId: number; readonly text: string; readonly reason: string }
  | { readonly action: 'join'; readonly topic: string; readonly text: string; readonly reason: string }
  | { readonly action: 'react'; readonly targetMessageId?: number; readonly text: string; readonly reason: string }

/** 一次判断里**真实存在**的消息（决策只能从中选目标）。 */
export interface PresentMessage {
  readonly messageId: number | null
  readonly atMs: number
}

/** 解析与校验共用的上下文：目标必须在这里面。 */
export interface DecisionContext {
  /** 本轮实际提供给模型的消息（顺序无关）。 */
  readonly messages: readonly PresentMessage[]
  /** 正文长度上限（群里一句话）。 */
  readonly replyMaxChars: number
  /** 现在几点（毫秒）。 */
  readonly nowMs: number
  /** 允许引用的时间窗（毫秒）：太老的消息不引，否则会对着旧话题说话。 */
  readonly windowMs: number
}

/** 解析结果：要么给出决策，要么给出**可进日志的理由**（绝不抛）。 */
export type ParseOutcome =
  | { readonly kind: 'decision'; readonly decision: SocialDecision }
  | { readonly kind: 'invalid'; readonly reason: string }
  /** 模型正常回答了"不说话"（`speak:false` 或 `action:"silent"`）：这是**成功**，不是失败。 */
  | { readonly kind: 'silent'; readonly reason: string }

/** 校验结果：能不能真的执行。 */
export type ValidateOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }

const OK: ValidateOutcome = { ok: true }

function invalid(reason: string): ValidateOutcome {
  return { ok: false, reason }
}

/** 码点长度（emoji 不算两个字）。 */
function lengthOf(text: string): number {
  return [...text].length
}

/** 从一段模型输出里取出一个 JSON 对象文本（去围栏、取最外层 `{…}`；数组一律不认）。 */
function jsonObjectOf(raw: string): string | null {
  const text = raw.replace(/```[a-zA-Z]*\s*/g, '').trim()
  // 数组 = 结构不对。不许从里面掏对象：那会把一次坏输出变成一次成功发言。
  if (text.startsWith('[')) return null
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  return text.slice(start, end + 1)
}

/** 正整数的消息号才认（`"123"` 不认：模型最爱的形状错误之一）。 */
function messageIdOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

/** 一句话的清洗与基本检查（空、占位、@、CQ 码）。返回 `null` 表示不可用。 */
function textOf(value: unknown): { text: string } | { problem: string } {
  if (typeof value !== 'string') return { problem: 'text-not-string' }
  const text = cleanText(value)
  if (text === '') return { problem: 'text-empty' }
  // `@` 与 `[CQ:` 是**不清洗**的：留在正文里就是发错对象/漏码，只能整条不发。
  if (text.includes('@') || /\[cq:/i.test(text)) return { problem: 'text-mention' }
  if (isPlaceholder(text)) return { problem: 'text-placeholder' }
  return { text }
}

/**
 * 解析模型输出（**严格、绝不抛**）。
 *
 * 分档（每一档都能在日志里一眼看出来）：
 *
 * | 观测 | 结果 |
 * |---|---|
 * | 找不到 JSON / `JSON.parse` 失败 / 不是对象 / 是数组 | `invalid:no-json` / `json-invalid` / `not-object` |
 * | `action` 是合法动作 | 继续按动作校验必填字段 |
 * | 旧格式 `speak:false` | `silent`（成功） |
 * | 旧格式 `speak:true` + 正文 | `decision: reply`（无目标号 → `react`） |
 * | `action` 不认识 / 缺字段 / 类型不对 | `invalid:…`（失败，累积后会暂停） |
 *
 * **注意**：这里只判"形状"，目标消息号是否存在、是否在时间窗内，交给
 * {@link validateSocialDecision}——两件事分开，才好在日志里区分"模型说错"与"代码拦住"。
 */
export function parseSocialDecision(raw: string, ctx: DecisionContext): ParseOutcome {
  void ctx
  const json = jsonObjectOf(raw)
  if (json === null) return { kind: 'invalid', reason: 'no-json' }
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return { kind: 'invalid', reason: 'json-invalid' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'invalid', reason: 'not-object' }
  }
  const shape = parsed as Record<string, unknown>
  const reason = reasonOf(shape)
  const action = shape['action']
  // 旧格式先判：热重载期间新旧提示词可能同时在跑，认不出会把一次正常判断记成失败。
  if (action === undefined && shape['speak'] !== undefined) return parseLegacy(shape, reason)
  if (typeof action !== 'string') return { kind: 'invalid', reason: 'action-missing' }
  return parseAction(action, shape, reason)
}

/** `reason`（新格式）或 `why`（旧格式）压成一行、截到 60 字（日志里不能出现多行注入文本）。 */
function reasonOf(shape: Record<string, unknown>): string {
  const raw = typeof shape['reason'] === 'string' ? shape['reason'] : shape['why']
  return typeof raw === 'string' ? cleanText(raw).slice(0, 60) : ''
}

/**
 * 旧格式 `{speak, reply, why}`（P0/P1）。
 *
 * 热重载期间新旧提示词可能同时在跑；不认旧格式就等于把一次正常判断记成失败——
 * 连续几次会触发暂停，群里就会安静十分钟，而原因只是"解析器换代了"。
 */
function parseLegacy(shape: Record<string, unknown>, reason: string): ParseOutcome {
  if (shape['speak'] === false) {
    return { kind: 'silent', reason: reason === '' ? 'speak-false' : `speak-false:${reason}` }
  }
  if (shape['speak'] !== true) return { kind: 'invalid', reason: 'speak-not-boolean' }
  const body = textOf(shape['reply'])
  if ('problem' in body) return { kind: 'invalid', reason: body.problem }
  const target = messageIdOf(shape['targetMessageId'])
  if (target !== null) {
    return { kind: 'decision', decision: { action: 'reply', targetMessageId: target, text: body.text, reason } }
  }
  // 旧格式没有目标号：一句反应仍然成立，不该让这一轮白跑。
  return { kind: 'decision', decision: { action: 'react', text: body.text, reason } }
}

/** 五动作的分派（每个分支的必填字段都不一样，所以逐个判）。 */
function parseAction(action: string, shape: Record<string, unknown>, reason: string): ParseOutcome {
  switch (action) {
    case 'silent':
      return { kind: 'silent', reason: reason === '' ? 'action-silent' : `action-silent:${reason}` }
    case 'observe': {
      const topic = typeof shape['topic'] === 'string' ? cleanText(shape['topic']).slice(0, 40) : ''
      return { kind: 'decision', decision: { action: 'observe', ...(topic === '' ? {} : { topic }), reason } }
    }
    case 'reply': {
      const target = messageIdOf(shape['targetMessageId'])
      // `reply` 没有目标号 = 不知道在回谁。降级成 `react`（一句反应仍然成立），
      // 而不是当成失败：模型想参与，只是没给号，代码不该让它这一轮白跑。
      const body = textOf(shape['text'])
      if ('problem' in body) return { kind: 'invalid', reason: body.problem }
      if (target === null) return { kind: 'decision', decision: { action: 'react', text: body.text, reason } }
      return { kind: 'decision', decision: { action: 'reply', targetMessageId: target, text: body.text, reason } }
    }
    case 'join': {
      const topic = typeof shape['topic'] === 'string' ? cleanText(shape['topic']).slice(0, 60) : ''
      if (topic === '') return { kind: 'invalid', reason: 'topic-empty' }
      const body = textOf(shape['text'])
      if ('problem' in body) return { kind: 'invalid', reason: body.problem }
      return { kind: 'decision', decision: { action: 'join', topic, text: body.text, reason } }
    }
    case 'react': {
      const body = textOf(shape['text'])
      if ('problem' in body) return { kind: 'invalid', reason: body.problem }
      const target = messageIdOf(shape['targetMessageId'])
      return {
        kind: 'decision',
        decision: { action: 'react', ...(target === null ? {} : { targetMessageId: target }), text: body.text, reason },
      }
    }
    default:
      return { kind: 'invalid', reason: `action-unknown:${cleanText(action).slice(0, 20)}` }
  }
}

/**
 * 发送前的**最后一道闸**（§6.5 的 1–6 条里与决策有关的部分）。
 *
 * 逐条判据：
 *   1. `silent` / `observe` 永远合法（它们本来就不发东西）；
 *   2. `reply` / `react` 的目标消息号必须**在本轮提供的消息里**（不能是模型编的）；
 *   3. 目标必须还在时间窗内（`windowMs`）：引一条十分钟前的消息等于答非所问；
 *   4. 正文：非空、不超长、没有 `@` 与 `[CQ:`（截断会发出半句话，所以超长直接不发）；
 *   5. `join` 必须有话题名（否则"加入话题"没有指称对象）。
 *
 * 限频与冷却**不在这里**：那是 `core/presence.ts` 的 `speakVerdict`，因为那里才有记账状态，
 * 而这里是纯函数、只看一次决策。
 */
export function validateSocialDecision(decision: SocialDecision, ctx: DecisionContext): ValidateOutcome {
  if (decision.action === 'silent' || decision.action === 'observe') return OK
  const cap = Number.isFinite(ctx.replyMaxChars) && ctx.replyMaxChars > 0 ? Math.trunc(ctx.replyMaxChars) : 0
  const length = lengthOf(decision.text)
  if (length === 0) return invalid('text-empty')
  if (cap > 0 && length > cap) return invalid(`text-too-long:${String(length)}>${String(cap)}`)
  if (decision.action === 'join' && decision.topic.trim() === '') return invalid('topic-empty')
  const target = decision.action === 'reply'
    ? decision.targetMessageId
    : (decision.action === 'react' ? decision.targetMessageId : undefined)
  if (decision.action === 'reply' && target === undefined) return invalid('target-missing')
  if (target === undefined) return OK
  const present = ctx.messages.filter((message) => message.messageId === target)
  if (present.length === 0) return invalid(`target-not-present:${String(target)}`)
  const window = Number.isFinite(ctx.windowMs) && ctx.windowMs > 0 ? ctx.windowMs : 0
  if (window > 0) {
    // 取同一号里最新的一条去比：同一条消息号重复出现时，只要有一条在窗内就认。
    const freshest = Math.max(...present.map((message) => message.atMs))
    if (Number.isFinite(freshest) && ctx.nowMs - freshest > window) return invalid(`target-too-old:${String(target)}`)
  }
  return OK
}

/** 一次能真的发出去的动作（记账用：`observe` 与 `silent` 都不发）。 */
export function sendsMessage(action: SocialAction): boolean {
  return action === 'reply' || action === 'join' || action === 'react'
}
