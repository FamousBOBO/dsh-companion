/** 知识库检索的打分（纯函数）：关键词 + 向量两路，标题单独加权。
 *
 * 与记忆打分的区别：
 *   - 没有重要性/新近度——资料的"价值"不随时间衰减，也不该由模型给自己打分；
 *   - **标题命中比正文命中值钱**：用户问"安装依赖"，命中标题 `安装 > 依赖` 的那块
 *     通常就是答案，而正文里顺带提到这两个字的地方未必；
 *   - 分数保持天然 [0,1] 尺度，阈值才能跨查询可比（同 `core/memory/score.ts`
 *     文件头讲的道理）。
 *
 * 第三路"实体"不单列：中文没有分词，所谓实体无非是标题/高频专名里那几个字，
 * 已经在标题加权与二元组里覆盖。强行造一路只会增加参数而没有可测的收益。
 */

import { queryTerms } from '../memory/score.js'
import type { KbChunk } from './model.js'

/** 标题命中的权重（正文命中是 0.6）。 */
const HEADING_WEIGHT = 1
const BODY_WEIGHT = 0.6

/** 检索用的最小块视图（存储层不必把整个 KbChunk 交进来）。 */
export interface ScorableChunk {
  readonly text: string
  readonly heading: string
}

/** IDF：`log(1 + N/(df+1))`，下限 0.5（与记忆一致）。 */
export function idfOf(df: number, total: number): number {
  return Math.max(0.5, Math.log(1 + Math.max(1, total) / (df + 1)))
}

/** 块里有没有这个词：标题 / 正文。 */
export function termPlacement(chunk: ScorableChunk, term: string): { heading: boolean; body: boolean } {
  const heading = chunk.heading.toLowerCase().includes(term)
  const body = chunk.text.toLowerCase().includes(term)
  return { heading, body }
}

/** 关键词覆盖率（0..1）：按 IDF 加权，命中标题算满、命中正文算 0.6。 */
export function keywordScore(
  terms: readonly string[],
  chunk: ScorableChunk,
  idf: (term: string) => number,
): number {
  if (terms.length === 0) return 0
  let hit = 0
  let total = 0
  for (const term of terms) {
    const weight = idf(term)
    total += weight
    const where = termPlacement(chunk, term)
    if (where.heading) hit += weight
    else if (where.body) hit += weight * BODY_WEIGHT
  }
  return total <= 0 ? 0 : clamp01(hit / total)
}

/** 标题覆盖率（诊断用：说明这块为什么排前面）。 */
export function headingCoverage(
  terms: readonly string[],
  chunk: ScorableChunk,
  idf: (term: string) => number,
): number {
  if (terms.length === 0) return 0
  let hit = 0
  let total = 0
  for (const term of terms) {
    const weight = idf(term)
    total += weight
    if (termPlacement(chunk, term).heading) hit += weight
  }
  return total <= 0 ? 0 : clamp01(hit / total)
}

/**
 * 二阶重排（B6）：把"稠密相似度 + 标题覆盖"再混一次。
 *
 * 与融合不同，这一刀只看**与关键词路径无关的信号**：向量余弦与标题覆盖。权重 0
 * 时原样返回（关着时排序逐字节不变）。
 */
export function rerankScore(
  base: number,
  cosine: number | null,
  heading: number,
  weight: number,
): number {
  const w = clamp01(weight)
  if (w === 0) return base
  const dense = cosine === null ? 0 : clamp01(cosine)
  return clamp01(base * (1 - w) + w * (0.7 * dense + 0.3 * clamp01(heading)))
}

/**
 * 两路融合：`weight × 余弦 + (1 − weight) × 关键词`。
 *
 * 没有向量（未开 embed、索引里没这块）时**整项退回关键词**——缺向量不该让一块
 * 文档直接消失。权重来自 `kb.vectorWeight`。
 */
export function fuseScore(keyword: number, cosine: number | null, vectorWeight: number): number {
  const kw = clamp01(keyword)
  if (cosine === null) return kw
  const w = clamp01(vectorWeight)
  return clamp01(w * clamp01(cosine) + (1 - w) * kw)
}

/** 查询词（去掉虚词；库里一个都没有的词由调用方剔除）。
 *
 * 只取尾部 800 字并封顶 48 个词：自动注入传进来的是**整包上下文**，问题通常在后部；
 * 对三千字全量切二元组会让候选筛选变成上千万次 `includes`（每回合都跑）。
 */
export function kbQueryTerms(text: string): string[] {
  const terms = queryTerms(String(text ?? '').slice(-800))
  return [...new Set(terms)].slice(0, 48)
}

/**
 * 集合可见范围：`{"inbox":["group-123"]}`。坏 JSON 当"没有范围限制"并返回原因
 * ——一条配置写错不该让知识库整个搜不到。
 */
export function parseScopes(raw: string): { scopes: Record<string, readonly string[]>; error: string } {
  const text = String(raw ?? '').trim()
  if (text === '') return { scopes: {}, error: '' }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { scopes: {}, error: `集合可见范围不是合法 JSON：${(error as Error).message}` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { scopes: {}, error: '集合可见范围必须是对象：{"集合名": ["group-123"]}' }
  }
  const scopes: Record<string, readonly string[]> = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue
    const rooms = value.map((item) => String(item).trim()).filter((item) => /^(group|dm)-\d+$/.test(item))
    if (rooms.length > 0) scopes[key] = rooms
  }
  return { scopes, error: '' }
}

/** 会话 id（`qq-group-123`）→ 房间键（`group-123`）；不是 QQ 会话返回 null。 */
export function roomOfSession(sessionId: string | undefined | null): string | null {
  const match = /^qq-(group|dm)-(\d+)$/.exec(sessionId ?? '')
  return match === null ? null : `${match[1]}-${match[2]}`
}

/** 这一块对某个房间是否可见（集合级白名单，纯函数）。 */
export function chunkVisible(
  chunk: KbChunk,
  collection: string,
  room: string | null,
  scopes: Readonly<Record<string, readonly string[]>>,
): boolean {
  const allowed = scopes[collection]
  if (allowed === undefined || allowed.length === 0) return true
  return room !== null && allowed.includes(room)
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}
