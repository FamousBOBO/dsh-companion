/** 记忆检索的打分（09 §5.2）。
 *
 * 公式来自 Generative Agents 的三因子加权，但**去掉了论文里的 min-max 归一化**，
 * 理由是本项目实测出来的一个问题（写第一版时踩的）：
 *
 *   三个因子各自已经天然落在 [0,1]——相关性是命中比例/余弦，重要性是 `1..10 / 10`，
 *   新近度是 `0.995^小时`。再按**批次**做一次 min-max，等于把"这批里最好的那个"
 *   抬到 1、"最差的"压到 0：于是批次一变，同一条记忆的分数就变。而阈值
 *   （`SCORE_THRESHOLD`）必须跨批次可比，否则"≥0.35 才注入"在小批次里形同虚设
 *   ——两条候选时，一条相关性 0、重要性和新近度都最高的记录能拿到 1.4，
 *   直接越过阈值。所以：**用天然尺度打分，让阈值在每一批里含义相同**。
 *
 * 相关性之外的第二个把关点是"零相关性永不注入"（见 `select.ts`）：重要性高只
 * 说明这条值得记住，不说明它和**这一回合**有关系。
 *
 * e1 阶段相关性用**关键词重叠**（中文二元组 + 英文词精确），向量留给 e2；接口
 * 不变，换的只是 `relevance` 的算法。
 */

import type { MemoryRecord } from './model.js'

/** 三个权重。命中时间词时 w_rec 换成 TIME_W_REC。 */
export interface ScoreWeights {
  readonly relevance: number
  readonly importance: number
  readonly recency: number
}

export const DEFAULT_WEIGHTS: ScoreWeights = { relevance: 1, importance: 0.6, recency: 0.8 }

/** 带时间偏好的权重（§5.1：命中时间词时 recency 提到 2.5）。 */
export const TIME_WEIGHTS: ScoreWeights = { ...DEFAULT_WEIGHTS, recency: 2.5 }

/** 打分阈值：低于它的不进注入（宁可少给，不给噪音）。 */
export const SCORE_THRESHOLD = 0.35

/** 注入预算：条数与总字符（§5.2 后处理第 4 条）。 */
export const MAX_INJECT_RECORDS = 8
export const MAX_INJECT_CHARS = 600

/** 同一个 (subject, kind) 最多进几条（多样性）。 */
export const MAX_PER_TOPIC = 2

/** 一条候选：记录本身 + 它与查询的相关性（0..1，由检索器给出）。 */
export interface Candidate {
  readonly record: MemoryRecord
  /** 0..1。关键词命中比例或余弦；`0` 表示"这一回合里一个字都没对上"。 */
  readonly relevance: number
}

export interface ScoredCandidate extends Candidate {
  readonly score: number
  readonly parts: { readonly relevance: number; readonly importance: number; readonly recency: number }
}

/** 时间衰减：`0.995^(距上次召回的小时数)`（Generative Agents 的 recency）。 */
export function recencyOf(record: MemoryRecord, now: number): number {
  const last = record.lastHitAt ?? record.recordedAt
  const hours = Math.max(0, (now - last) / 3_600_000)
  return 0.995 ** hours
}

/**
 * 给一批候选打分。三个因子都用天然 [0,1] 尺度（见文件头），所以**每条记录的分数
 * 只取决于它自己**，不取决于同批里还有谁。
 */
export function rankCandidates(
  candidates: readonly Candidate[],
  now: number,
  weights: ScoreWeights = DEFAULT_WEIGHTS,
): ScoredCandidate[] {
  const scored = candidates.map((c): ScoredCandidate => {
    const parts = {
      relevance: clamp01(c.relevance),
      importance: clamp01(c.record.importance / 10),
      recency: clamp01(recencyOf(c.record, now)),
    }
    return {
      record: c.record,
      relevance: parts.relevance,
      parts,
      score: weights.relevance * parts.relevance
        + weights.importance * parts.importance
        + weights.recency * parts.recency,
    }
  })
  // 同分时用 id 兜底排序：分数会随批次变，id 不会——输出得是确定的。
  return scored.sort((a, b) => (b.score - a.score) || a.record.id.localeCompare(b.record.id))
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0
  return Math.min(1, Math.max(0, v))
}

/**
 * 关键词相关性：**查询词命中记录的比例**，加权（关键词 > 标签 > 正文）。
 *
 * 中文没有空格，所以查询与正文都切成二元组（bigram）——这是 KB Lite 在本项目
 * 183,409 条向量上验证过的兜底做法：短文本上向量会漏精确词（人名、缩写、梗），
 * 关键词重叠正好补这一块。
 *
 * @returns 0..1。1 表示查询里的词一个不漏地都在这条记录里出现了。
 */
/**
 * 一条记录对查询的相关性（0..1）。
 *
 * 权重阶梯（命中字段越"像关键词"越值钱）：keywords 1.0 · tags 0.75 · 正文 0.5 · context 0.25。
 *
 * `idf` 是可选的**逆文档频率**（P6e·e4 加的）：不传时每个词权重 1，行为与从前
 * 逐字节一致；传进来时按词的信息量加权，分母也跟着变成"所有权重之和"。为什么
 * 要它：中文二元组里绝大多数是跨词边界的噪声（"学弟为什么" → 弟为 / 为什 / 么不），
 * 它们与真关键词（"面板"）在"命中就算 1 个"的口径下等价——于是"命中一个噪声词"
 * 与"命中一个真关键词"得同样的分，排序分不出好坏（60 题基准实测：不加 IDF 时
 * 目标记录的 relevance 与大量无关记录相同，rank 排到 180 位）。
 */
export function keywordRelevance(
  queryTerms: readonly string[],
  record: MemoryRecord,
  idf?: (term: string) => number,
): number {
  const terms = queryTerms.filter((t) => t.trim() !== '')
  if (terms.length === 0) return 0
  const kw = new Set(record.keywords.map((k) => k.toLowerCase()))
  const tags = new Set(record.tags.map((t) => t.toLowerCase()))
  const body = bigrams(record.content.toLowerCase())
  const context = record.context.toLowerCase()
  const weightOf = idf ?? ((): number => 1)
  let hit = 0
  let total = 0
  for (const raw of terms) {
    const weight = weightOf(raw)
    total += weight
    const term = raw.toLowerCase()
    if (kw.has(term)) { hit += weight; continue }
    if (tags.has(term)) { hit += weight * 0.75; continue }
    if (body.has(term) || record.content.includes(raw)) { hit += weight * 0.5; continue }
    if (context.includes(term)) hit += weight * 0.25
  }
  return total <= 0 ? 0 : clamp01(hit / total)
}

/**
 * 把一句话切成检索用的一元/二元词袋。
 *
 * 中文按相邻两字成组（"部署方案" → 部署/署方/方案），英文与数字按整词。**不做
 * 分词**：分词要词典、要新依赖，而这里只需要"能对上就行"。
 */
export function bigrams(text: string): Set<string> {
  const out = new Set<string>()
  for (const word of text.match(/[a-z0-9]+/g) ?? []) out.add(word)
  const cjk = text.replace(/[^一-鿿]/g, ' ')
  for (const run of cjk.split(/\s+/)) {
    if (run.length === 1) { out.add(run); continue }
    for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2))
  }
  return out
}

/**
 * 查询里不参与匹配的虚词二元组。
 *
 * 为什么需要这张表（P6e·e4 实测出来的）：查询大多是**问句**（"学弟为什么不愿意
 * 把面板关掉？"），而中文疑问句的虚词二元组（为什么 / 么不 / 不愿 / 愿意）在语料里
 * 到处都是——"我为什么要查这个""为什么只写 2 条"这类句子随手就能命中好几个。
 * 结果是：一条**真正回答了问题**的记录只命中一两个实词，被大堆只命中虚词的无关
 * 记录挤下去。60 题基准实测：不过滤虚词时 recall@8 只有 0.04，过滤后见阶段记录的
 * 数字。
 *
 * **只过滤查询侧**（索引侧照旧用全量二元组）：动了索引就要重建，而这里的问题
 * 出在"拿什么去查"，不在"记录里有哪几个字"。过滤后若一个词都不剩，退回原样
 * （宁可带着虚词查，也不要空查询）。
 */
const STOP_BIGRAMS = new Set([
  '为什么', '什么', '怎么', '怎样', '哪些', '哪个', '多少', '是不', '是否', '如何',
  '哪里', '哪儿', '到底', '究竟', '关于', '对于', '这样', '那样', '样子', '时候',
  '现在', '最近', '上次', '下次', '一下', '一个', '一些', '一样', '一直', '一起',
  '可以', '不能', '不愿', '愿意', '想要', '需要', '我们', '你们', '他们', '她们',
  '这个', '那个', '这些', '那些', '其实', '已经', '正在', '可能', '应该', '必须',
  '不会', '没有', '就是', '还是', '但是', '因为', '所以', '如果', '虽然', '然后',
  '而且', '以及', '或者', '不过', '时候', '知道', '说过', '什么',
])

/** 单字虚词：它们单独成组时（run 只有一个字）不参与匹配。 */
const STOP_SINGLE = new Set([
  '的', '了', '是', '在', '和', '吗', '呢', '吧', '把', '被', '给', '让', '从', '对', '与',
  '而', '就', '都', '也', '还', '只', '要', '会', '能', '我', '你', '他', '她', '它', '咱',
  '这', '那', '之', '并', '且', '或', '但', '却', '有', '不', '没', '很', '太',
])

/**
 * 虚词字：**两个都是虚词字**的二元组被判为虚词组合，不参与匹配。
 *
 * 为什么需要"按字"而不是按词：`bigrams` 产出的是**相邻两字**（见它的注释——不做
 * 分词，要词典、要新依赖），所以"为什么"会变成 `为什` + `什么`，一张按词写的
 * 停用表根本命中不了它们。判据取"两个都是虚词字"是保守的：`面板`（面不是虚词字）
 * 与 `学弟` 都留下，而 `为什` `么不` `的是` `会在` 这类被挡掉。
 *
 * 已知代价：`愿意` 也会被挡（愿/意都列在表里），而它在"他愿意帮忙"里是实词。
 * 在这种短查询场景里，情态词带来的噪声大于它的信息量——实测过：不过滤时
 * 60 题基准的 recall@8 只有 0.04。
 */
const STOP_CHARS = new Set([
  '为', '什', '么', '怎', '样', '呢', '吗', '吧', '啊', '的', '了', '是', '在', '和', '与',
  '或', '但', '而', '也', '都', '还', '只', '要', '会', '能', '可', '以', '不', '没', '很',
  '太', '我', '你', '他', '她', '它', '咱', '这', '那', '些', '之', '并', '且', '就', '被',
  '把', '给', '让', '从', '对', '于', '想', '需', '应', '该', '愿', '意', '如', '何', '哪',
])

/** 这个二元组是不是虚词组合（两个字符都是虚词字）。 */
function isStopPair(term: string): boolean {
  if (term.length !== 2) return false
  return STOP_CHARS.has(term[0] ?? '') && STOP_CHARS.has(term[1] ?? '')
}

/** 从一句查询里抽检索词：中文二元组 + 英文/数字整词，**去掉虚词**（见上）。 */
export function queryTerms(text: string): string[] {
  const all = [...bigrams(text.toLowerCase())]
  const kept = all.filter((t) =>
    !STOP_BIGRAMS.has(t) && !isStopPair(t) && !(t.length === 1 && STOP_SINGLE.has(t)))
  return kept.length > 0 ? kept : all
}

/**
 * 余弦相似度（09 §5.2 的 a 项）。
 *
 * 两个向量都**已经 L2 归一化**（bge-small-zh-v1.5 的输出就是这个形式，写在
 * `EmbedPort` 的实现契约里），所以点积即余弦，**别再做一次归一化**。负数
 * （本模型理论上不会给）与 NaN 一律夹到 [0,1]：阈值要跨记录可比。长度不一致
 * （维度错位）返回 0——宁可当"没关系"，也不让错位的数据拿到分。
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!
  return clamp01(dot)
}

/**
 * 记录有向量时的相关性：`weight × 余弦 + (1 − weight) × 关键词`。
 *
 * 默认 `weight = 1` 就是 09 §5.2 的"relevance = 余弦"；调小让关键词兜底参与
 * （中文短文本上向量会漏精确词，见 09 §10）。**没有向量时整项退回关键词重叠度**
 * ——缺向量的记录与 e1 的行为完全一致。权重来自配置（`memory.vectorWeight`），
 * 留给 e4 调参。
 */
export function blendedRelevance(cosine: number | null, keyword: number, weight: number): number {
  const kw = clamp01(keyword)
  if (cosine === null) return kw
  const w = clamp01(weight)
  return clamp01(w * clamp01(cosine) + (1 - w) * kw)
}

/** 链接扩展的邻居相关性门槛（09 §5.2 c 项；只用于向量开启的混合路径，e1 路径仍是 >0）。 */
export const LINK_MIN_RELEVANCE = 0.35
