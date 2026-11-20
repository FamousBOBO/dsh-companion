/** `macjev-render-v1` **渲染器**（TS 实现）：把"群聊状态 + 一道 typed 问句"变成打分器认的 token 位置。
 *
 * 为什么必须与 Python 参考实现逐 token 一致：打分器只读指定槽位上的 `yes` / `no` logit，
 * 槽位偏一个 token，概率就整份作废——而且不会报错，只会给出**看起来合理**的错答案。
 * 所以这里不是"照文档写一遍"，而是照 `jev_style_decision_gguf.py` 的每一步抄，
 * 并由 `test/jev-render-parity.test.ts` 拿金样逐 id 比对（金样是用 Python 侧产出的）。
 *
 * 渲染的形状（`Renderer.render`）：
 *
 *   prefix = enc('State:\n') + enc(state) + enc('\n\n')
 *   suffix = enc(`Question [${type}]: ${ins}\nOptions:\n`)
 *          + Σ( enc('- ') + enc(option) + enc('\n') )
 *          + enc('Judge each option:\n')
 *          + Σ( enc(option) + enc(' ->') + enc('\n') )
 *
 * 关键点：**选项在 `Options:` 段里出现一次，在读数段里再出现一次**——第二个出现的位置
 * 才是槽位（`->` 之前那个 token）。所以 `slots` 不是行尾，是 `->` 前面。
 * 这个细节抄错一次，整份概率就会偏，但不会报错。
 *
 * 分词必须**逐段独立编码再拼接**，不能把整段字符串一次编码：
 * 字节级 BPE 在段边界上的合并行为与分别编码不同（参考实现就是这么写的，
 * 见 `prefix_ids` / `render` 里的多次 `self.enc(...)`）。
 */

import type { Encoding } from '@huggingface/tokenizers'

/**
 * 只用分词器的 `encode`。
 *
 * 为什么声明成结构类型而不是 `Tokenizer`：`@huggingface/tokenizers` 的类型是 class，
 * 直接写它的名字会把"这个包怎么构造"绑进来（构造要读 `tokenizer.json` 与
 * `tokenizer_config.json` 两份，那是装配的事）。这里只要"给文本、拿 id"这一件事。
 */
export interface EncodePort {
  encode(text: string, options: { add_special_tokens: boolean }): Encoding
}

/** 一道问句（与打分器/参考实现同形）。 */
export interface RenderQuestion {
  /** `choice` / `score` / `noul`。 */
  readonly t: string
  /** 问句正文。 */
  readonly ins: string
  /** 选项：`choice` 是 `{name: 描述|null}`，`score` 是等级描述数组，`noul` 是 `null` 或 `{false,true}`。 */
  readonly crit: unknown
}

/** 一次渲染的结果。 */
export interface Rendered {
  /** 完整 token 序列（`prefix + suffix`）。 */
  readonly ids: readonly number[]
  /** prefix 的长度（`ids` 里前这么多是状态）。 */
  readonly prefixLen: number
  /** 要读 logit 的绝对槽位（升序，长度 = 选项数）。 */
  readonly slots: readonly number[]
  /** 槽位对应的选项名（顺序与 `slots` 一致）。 */
  readonly names: readonly string[]
  /** 问句 + 选项 + 读数段的 token 数（head 预算用的是它）。 */
  readonly headTokens: number
}

/** 读数字段（`readout_config.json` 里与渲染有关的那几项）。 */
export interface ReadoutConfig {
  readonly yes: number
  readonly no: number
  readonly arrow: number
}

/** 渲染预算超限（**不截断**，直接报错）。 */
export class RenderBudgetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RenderBudgetError'
  }
}

/** 问句形状不对。 */
export class RenderQuestionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RenderQuestionError'
  }
}

/** 参考实现的硬上限（`jev_style_decision_gguf.py` 的 `CONTEXT_LIMIT` / `HARD_HEAD_MAX`）。 */
export const CONTEXT_LIMIT = 25_600
export const HARD_HEAD_MAX = 2_048

/** 渲染器。 */
export interface Renderer {
  /** 状态段（不含问句）。 */
  prefixIds(state: string): readonly number[]
  /** 渲染一道问句。 */
  render(state: string, question: RenderQuestion, budgets?: { headMax?: number; maxLen?: number }): Rendered
  /** 读数行（`yes` / `no` 两个 token id）。 */
  readonly rows: readonly [number, number]
  /** 校验分词器与读数字段是否自洽（构造时就做，错一次以后全是错）。 */
  verify(): void
}

/** 从 `readout_config.json` 里读渲染要用的三项。 */
export function readoutOf(config: Record<string, unknown>): ReadoutConfig {
  const slots = config['slot_tokens']
  if (slots === null || typeof slots !== 'object') {
    throw new RenderBudgetError('readout_config.json 缺 slot_tokens')
  }
  const pick = (key: string): number => {
    const node = (slots as Record<string, unknown>)[key]
    if (node === null || typeof node !== 'object') throw new RenderBudgetError(`slot_tokens 缺 ${key}`)
    const id = (node as Record<string, unknown>)['id']
    if (typeof id !== 'number' || !Number.isSafeInteger(id)) {
      throw new RenderBudgetError(`slot_tokens.${key}.id 不是整数`)
    }
    return id
  }
  return { yes: pick('yes'), no: pick('no'), arrow: pick('verdict_slot') }
}

/** 选项名（顺序 = 概率顺序）。形状不对就抛，与参考实现同口径。 */
export function optionNames(question: RenderQuestion): string[] {
  if (typeof question.ins !== 'string' || question.ins.trim() === '') {
    throw new RenderQuestionError("question text ('ins') must be a non-empty string")
  }
  const crit = question.crit
  if (question.t === 'choice') {
    if (crit === null || typeof crit !== 'object' || Array.isArray(crit)) {
      throw new RenderQuestionError('choice needs a non-empty dict {option name: description or null}')
    }
    const names = Object.keys(crit)
    if (names.length === 0) throw new RenderQuestionError('choice needs at least one option')
    return names
  }
  if (question.t === 'score') {
    if (!Array.isArray(crit) || crit.length < 2 || crit.length > 10) {
      throw new RenderQuestionError('score needs a list of 2..10 level descriptions')
    }
    return crit.map((_, index) => String(index))
  }
  if (question.t === 'noul') {
    if (crit !== null && typeof crit !== 'object') {
      throw new RenderQuestionError('noul criteria must be null or {false: …, true: …}')
    }
    return ['false', 'true']
  }
  throw new RenderQuestionError(`unknown question type ${JSON.stringify(question.t)}`)
}

/**
 * 一个选项的渲染文本（`choice` 是 `name: 描述`，`score` 是 `level i: 描述`）。
 *
 * 描述不是字符串时按 `json.dumps(value, ensure_ascii=False, separators=(", ", ": "), default=str)`
 * 的格式序列化——**分隔符也要一致**：多一个空格就多一个 token，槽位全偏。
 * 本项目实际只传字符串与 `null`，这条路径是为"将来有人加结构化选项"留的正确实现。
 */
function criterionOf(value: unknown): string {
  if (typeof value === 'string') return value
  return pythonJsonDumps(value)
}

/** Python `json.dumps` 的等价写法（只覆盖 JSON 值；`default=str` 用 `String` 近似）。 */
function pythonJsonDumps(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NaN'
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => pythonJsonDumps(item)).join(', ')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}: ${pythonJsonDumps(item)}`).join(', ')}}`
  }
  return JSON.stringify(String(value))
}

/** 选项列表（与 `render_options` 逐字一致）。 */
export function renderOptions(question: RenderQuestion): string[] {
  const crit = question.crit
  if (question.t === 'choice') {
    return Object.entries(crit as Record<string, unknown>)
      .map(([name, value]) => (value === null || value === '' ? name : `${name}: ${criterionOf(value)}`))
  }
  if (question.t === 'score') {
    return (crit as unknown[]).map((level, index) => `level ${String(index)}: ${criterionOf(level)}`)
  }
  const pair = (crit ?? {}) as Record<string, unknown>
  const falseText = pair['false']
  const trueText = pair['true']
  return [
    'false: ' + (falseText === undefined || falseText === null || falseText === ''
      ? 'no, the statement does not hold'
      : criterionOf(falseText)),
    'true: ' + (trueText === undefined || trueText === null || trueText === ''
      ? 'yes, the statement holds'
      : criterionOf(trueText)),
  ]
}

/** 一段问句的固定前后缀（一次渲染里复用的那几个常量）。 */
interface Pieces {
  readonly enc: (text: string) => number[]
  readonly newline: readonly number[]
  readonly dash: readonly number[]
  readonly judge: readonly number[]
  readonly arrow: readonly number[]
}

/**
 * 把选项清单排成 `Options:` 段（选项在前，读数在后）。
 *
 * **槽位落在 `->` 的最后一个 token 上，不是选项的最后一个 token、也不是行尾**——
 * 参考实现是 `suffix += o + self.arrow; rel.append(len(suffix) - 1)`：
 * 打分器在"箭头已经就位"这个位置读 `yes` / `no` 的 logit，即在问"箭头后面该接哪个词"。
 * 这个细节抄错一次，整份概率就会偏，但不会报错。
 */
function suffixOf(
  pieces: Pieces,
  question: RenderQuestion,
  optionIds: readonly (readonly number[])[],
): { readonly suffix: number[]; readonly slotsRel: number[] } {
  const suffix: number[] = [...pieces.enc(`Question [${question.t}]: ${question.ins}\nOptions:\n`)]
  for (const ids of optionIds) suffix.push(...pieces.dash, ...ids, ...pieces.newline)
  suffix.push(...pieces.judge)
  const slotsRel: number[] = []
  for (const ids of optionIds) {
    suffix.push(...ids, ...pieces.arrow)
    slotsRel.push(suffix.length - 1)
    suffix.push(...pieces.newline)
  }
  return { suffix, slotsRel }
}

/** 超预算就抛（**不截断**：截断会静默改变槽位与语义）。 */
function checkBudgets(tokenCount: number, headTokens: number, head: number, limit: number): void {
  if (headTokens > head) {
    throw new RenderBudgetError(
      `question + options + readout need ${String(headTokens)} tokens; the head budget is ${String(head)}`
      + '（参考实现不截断，所以这里也直接报错）',
    )
  }
  if (tokenCount > limit) {
    throw new RenderBudgetError(
      `input needs ${String(tokenCount)} tokens; the limit is ${String(limit)}`
      + '（shorten the state, nothing was truncated）',
    )
  }
}

/** 校验 `yes` / `no` / `->` 都是单 token 且 id 与 `readout_config.json` 一致。 */
function verifyConstants(pieces: Pieces, readout: ReadoutConfig): void {
  const checks: ReadonlyArray<readonly [string, number]> = [
    [' yes', readout.yes],
    [' no', readout.no],
    [' ->', readout.arrow],
  ]
  for (const [text, want] of checks) {
    const got = pieces.enc(text)
    if (got.length !== 1 || got[0] !== want) {
      throw new RenderBudgetError(
        `tokenizer 与 readout_config 不自洽：${JSON.stringify(text)} 编码成 [${got.join(',')}]，`
        + `readout_config 期望 [${String(want)}]`,
      )
    }
  }
}

/**
 * 造一个渲染器。
 *
 * `maxLen` / `headMax` 的默认值来自参考实现：整个输入 ≤ 25600，问句 + 选项 + 读数 ≤ 2048。
 * 超了**不截断**，直接抛——截断会静默改变槽位与语义。
 */
export function createRenderer(
  tokenizer: EncodePort,
  readout: ReadoutConfig,
  budgets: { maxLen?: number; headMax?: number } = {},
): Renderer {
  const maxLen = budgets.maxLen ?? CONTEXT_LIMIT
  const headMax = budgets.headMax ?? HARD_HEAD_MAX
  // 单段编码（不特殊 token）——与参考实现的 `TextEncoder.__call__` 同一口径。
  const enc = (text: string): number[] =>
    tokenizer.encode(text, { add_special_tokens: false }).ids.map((id: number) => Number(id))
  const pieces: Pieces = {
    enc,
    newline: enc('\n'),
    dash: enc('- '),
    judge: enc('Judge each option:\n'),
    arrow: enc(' ->'),
  }
  const prefixOf = (state: string): number[] => [...enc('State:\n'), ...enc(state), ...enc('\n\n')]

  return {
    rows: [readout.yes, readout.no],
    verify(): void { verifyConstants(pieces, readout) },
    prefixIds: (state) => prefixOf(state),
    render(state, question, innerBudgets = {}): Rendered {
      const head = innerBudgets.headMax ?? headMax
      const limit = Math.min(innerBudgets.maxLen ?? maxLen, maxLen)
      if (head > HARD_HEAD_MAX) throw new RenderBudgetError(`head_max may not exceed ${String(HARD_HEAD_MAX)}`)
      const names = optionNames(question)
      const optionIds = renderOptions(question).map((option) => enc(option))
      const { suffix, slotsRel } = suffixOf(pieces, question, optionIds)
      const prefix = prefixOf(state)
      const ids = [...prefix, ...suffix]
      checkBudgets(ids.length, suffix.length, head, limit)
      return {
        ids,
        prefixLen: prefix.length,
        slots: slotsRel.map((rel) => prefix.length + rel),
        names,
        headTokens: suffix.length,
      }
    },
  }
}


