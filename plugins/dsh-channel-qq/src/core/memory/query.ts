/** 查询构造：把"本回合的几句话"变成检索条件（09 §5.1）。
 *
 * 对应 LongMemEval 的 time-aware query expansion。三件事：
 *
 *   1. **相对时间归一化**："上次 / 昨天 / 前天 / 上周 / 上个月 / 刚才 / 那件事" →
 *      一个时间范围或"偏时间"的信号。词表刻意复用 reminders 的那一套思路，但不
 *      共用代码：那边要把它解析成绝对时刻（用于定时），这边只需要知道"这句在问时间"。
 *   2. **时间偏好**：命中时间词时把 recency 权重抬起来（"上周我们聊过什么"里，
 *      时间本身就是相关性）。
 *   3. **主体偏好**：提到学弟的昵称或 QQ 号时，把 `subject=user:<主人>` 的权重抬高。
 *
 * 纯函数、不读时钟——`now` 由调用方给。
 */

import { bigrams } from './score.js'

/** 命中时间词时给出的时间范围（毫秒级，半开区间）。 */
export interface TimeHint {
  /** 命中的词，便于日志与测试。 */
  readonly term: string
  /** 只保留这个区间内"成立"的记录；null 表示不限制。 */
  readonly from: number | null
  readonly to: number | null
}

export interface MemoryQuery {
  /** 检索词（中文二元组 + 英文整词），喂给 `keywordRelevance`。 */
  readonly terms: readonly string[]
  /** 原始文本，调试与日志用。 */
  readonly text: string
  /** 命中的时间词（可能多个，取最窄的那个用）。 */
  readonly timeHints: readonly TimeHint[]
  /** 是否要抬高 recency 权重。 */
  readonly preferRecent: boolean
  /** 优先的主体（例如主人的 QQ 号）。 */
  readonly preferredSubject: { readonly type: 'user'; readonly id: string } | null
}

const DAY = 86_400_000
const HOUR = 3_600_000

/**
 * 相对时间词表 → 时间范围。
 *
 * 顺序有意义：先匹配更具体的（"前天" 比 "天" 具体），否则"前天"会被当成"最近"。
 * `undefined` 的 offset 表示"不限定区间，只是偏好最近"。
 */
const TIME_TERMS: ReadonlyArray<{ readonly term: string; readonly ms?: number; readonly label: string }> = [
  { term: '刚才', ms: 2 * HOUR, label: '刚才' },
  { term: '刚刚', ms: 2 * HOUR, label: '刚刚' },
  { term: '今天', ms: DAY, label: '今天' },
  { term: '昨天', ms: 2 * DAY, label: '昨天' },
  { term: '前天', ms: 3 * DAY, label: '前天' },
  { term: '上周', ms: 14 * DAY, label: '上周' },
  { term: '上个月', ms: 45 * DAY, label: '上个月' },
  { term: '上次', ms: 30 * DAY, label: '上次' },
  { term: '最近', ms: 7 * DAY, label: '最近' },
  { term: '之前', ms: 30 * DAY, label: '之前' },
  { term: '以前', ms: 90 * DAY, label: '以前' },
  { term: '那件事', ms: 30 * DAY, label: '那件事' },
  { term: '那次', ms: 30 * DAY, label: '那次' },
]

/**
 * 造一个查询。
 *
 * @param text 本回合最新几条消息拼起来的文本（调用方决定拼几条）。
 * @param now 当前时刻（注入，R8）。
 * @param opts.aliases 主人的昵称/别名；出现即视为"在问关于他的事"。
 */
export function buildQuery(
  text: string,
  now: number,
  opts: { aliases?: readonly string[]; masterId?: number | string } = {},
): MemoryQuery {
  const hints: TimeHint[] = []
  for (const entry of TIME_TERMS) {
    if (!text.includes(entry.term)) continue
    const from = entry.ms === undefined ? null : now - entry.ms
    hints.push({ term: entry.label, from, to: entry.ms === undefined ? null : now })
  }
  const preferred = preferredSubjectOf(text, opts)
  return {
    terms: [...bigrams(text.toLowerCase())],
    text,
    timeHints: hints,
    preferRecent: hints.length > 0,
    preferredSubject: preferred,
  }
}

/** 最窄的时间范围（有区间的优先；都没有就退回 null = 不限制）。 */
export function narrowestRange(query: MemoryQuery): { from: number; to: number } | null {
  let best: TimeHint | null = null
  for (const hint of query.timeHints) {
    if (hint.from === null || hint.to === null) continue
    if (best === null || (hint.to - hint.from) < (best.to! - best.from!)) best = hint
  }
  if (best === null) return null
  return { from: best.from!, to: best.to! }
}

function preferredSubjectOf(
  text: string,
  opts: { aliases?: readonly string[]; masterId?: number | string },
): MemoryQuery['preferredSubject'] {
  const masterId = opts.masterId
  if (masterId === undefined) return null
  const id = String(masterId)
  for (const alias of opts.aliases ?? []) {
    if (alias !== '' && text.includes(alias)) return { type: 'user', id }
  }
  if (id !== '' && text.includes(id)) return { type: 'user', id }
  return null
}

/**
 * 主体加权：命中的记录若正好是"优先主体"，相关性乘一个系数。
 *
 * 为什么不直接过滤：问"我上次说啥"时，相关记录也可能属于"世界"（那天群里发生的事）。
 * 加权是"抬一抬"，不是"排掉"。
 */
export const SUBJECT_BOOST = 1.35

export function boostRelevance(relevance: number, record: { subject: { type: string; id?: number | string } }, query: MemoryQuery): number {
  if (query.preferredSubject === null) return relevance
  const want = query.preferredSubject
  const same = record.subject.type === want.type && String(record.subject.id ?? '') === want.id
  return same ? Math.min(1, relevance * SUBJECT_BOOST) : relevance
}
