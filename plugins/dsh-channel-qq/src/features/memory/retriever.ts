/** 检索器：把"本回合的几句话"变成"要注入的 3–8 条证据"（09 §5）。
 *
 * 管线（每一步都能单独测）：
 *
 *   查询构造（core/memory/query）→ 候选生成（倒排索引 + 向量 + 链接一跳）→
 *   相关性/加权（core/memory/score + query 的主体偏好）→ 打分排序 →
 *   取舍（阈值/多样性/矛盾合并/预算，core/memory/select）→ 渲染证据块 →
 *   记账（hits/strength/lastHitAt，MemoryBank 的"越用越难忘"）
 *
 * 两处刻意的顺序：
 *   - **记账发生在"真的注入了"之后**，不是"被检索到"之后。否则一条记录只要被候选
 *     生成扫到就会变难忘，遗忘曲线就失去意义。
 *   - **候选生成有上限**（`MAX_CANDIDATES`）。倒排索引的查询词一多就可能捞回几百条，
 *     而 min-max 已经去掉了、分数不依赖批次，所以这里只是性能上的封顶；截断按
 *     "命中词数"排序，不是按插入顺序。
 *
 * e2 的向量（09 §5.2）分两条路径，**边界必须清晰**：
 *   - 向量关着/查询嵌不动/服务不可用 → `keywordCandidates`（e1 锚点，逐字节保留）；
 *   - 向量可用 → `hybridCandidates`：两路各取 top-50 合并，邻居只在相关性 > 0.35 时展开。
 */

import type { MemoryRecord } from '../../core/memory/model.js'
import { isRetrievable, withHit } from '../../core/memory/model.js'
import {
  DEFAULT_WEIGHTS, LINK_MIN_RELEVANCE, MAX_INJECT_CHARS, TIME_WEIGHTS, blendedRelevance, cosineSimilarity,
  keywordRelevance, queryTerms, rankCandidates, type Candidate,
} from '../../core/memory/score.js'
import { buildQuery, boostRelevance, narrowestRange, type MemoryQuery } from '../../core/memory/query.js'
import {
  evidenceLine, pickPinned, pickWander, renderConstantBlock, renderEvidence, renderWanderBlock,
  selectForInjection,
} from '../../core/memory/select.js'
import { expandEntities } from './entity-expand.js'
import type { MemoryStore } from './store.js'
import type { VectorRecall } from './vector-store.js'

/** 关键词路径的封顶（e1）；向量路径是"各取 top-50"，见 `TOP_PER_SOURCE`。 */
const MAX_CANDIDATES = 300

/** 链接一跳最多扩展几条（A-MEM；两条路径共用）。 */
const MAX_LINK_EXPANSIONS = 10

/** 两路候选各取多少条（09 §5.2："各取 top-50，合并去重"）。 */
const TOP_PER_SOURCE = 50

export interface RetrieveOptions {
  /** 本回合的消息文本（调用方决定拼几条）。 */
  readonly text: string
  /** 当前时刻（注入，R8）。 */
  readonly now: number
  /** 当前房间（`scope='room'` 的记录只有同房间才参与）；`null` = 不按房间过滤。 */
  readonly room: string | null
  /** 主人的昵称/QQ 号：提到时抬高他的记录。 */
  readonly aliases?: readonly string[]
  readonly masterId?: number | string
  /** 只在本房间范围内检索（工具 recall 的 scope 参数用）。 */
  readonly roomOnly?: boolean
  /**
   * 注入预算（配置项）。不传就用 `core/memory/score.ts` 的默认值。
   *
   * 为什么做成参数而不是常量：这三项在后台面板上能改，而"面板上能改的东西必须
   * 真的被读到"是这个项目反复付过学费的一条（`minLength` 曾经写死 8）。
   */
  readonly budget?: { readonly threshold?: number; readonly maxRecords?: number; readonly maxChars?: number; readonly maxPerTopic?: number }
  /**
   * 额外的候选过滤。自动注入与主动召回都用它排除原文块（`tags` 含 `chunk`）：
   * 块是 600 字的原文，塞进 600 字预算后整回合只剩一条证据——实测 recall 反而变 0。
   */
  readonly accept?: (record: MemoryRecord) => boolean
  /**
   * 打分权重覆盖（默认 `DEFAULT_WEIGHTS`；`preferRecent` 命中时用 `TIME_WEIGHTS`）。
   * 评测用它把排序压到"只看相关性"——离线语料里的 importance/recency 是合成值，
   * 不该参与判断"检索能不能找到依据"。
   */
  readonly weights?: { readonly relevance: number; readonly importance: number; readonly recency: number }
  /**
   * asOf 时间旅行（P2）：问"那个时点我们知道什么"。过滤改用该时点
   * （validFrom/validTo 与 recordedAt 都按它判），排序仍用真实现在。
   * 深召回工具的日期参数走这里；自动注入永远不用。
   */
  readonly asOf?: number
  /**
   * 走神骰子（P2 第三层）：`roll ∈ [0,1) < 8%` 时带一条"很久没想起"的深记忆回来。
   * 不传 = 不掷骰子（评测与深召回都关着走神，只有自动注入传）。
   */
  readonly roll?: number
  /** 关掉常驻层（评测用；自动注入默认开）。 */
  readonly noPinned?: boolean
}

export interface Retrieved {
  readonly query: MemoryQuery
  /** 实际要注入的那几条（已排序、已过滤、已在预算内）。 */
  readonly picked: MemoryRecord[]
  /** 证据块（没有命中时是空串）。 */
  readonly evidence: string
}

export interface RetrieverDeps {
  readonly store: MemoryStore
  readonly log: (line: string) => void
  /** 时间渲染（注入，便于测试固定格式）。 */
  readonly renderTime: (at: number) => string
  /** 主体标签（学弟/群名），没有就用 QQ 号。 */
  readonly labelOfSubject?: (record: MemoryRecord) => string
  /** 现在几点（注入）。 */
  readonly clock: { now(): number }
  /** 向量召回面（e2）；关着/服务不可用/索引为空时是 undefined → 走 e1 关键词路径。 */
  readonly vectors?: VectorRecall | undefined
}

export class MemoryRetriever {
  /** 逆文档频率：把"罕见词更值钱"接到相关性打分上（见 `MemoryStore.idfOf`）。 */
  private readonly idf = (term: string): number => this.deps.store.idfOf(term)

  constructor(private readonly deps: RetrieverDeps) {}

  /**
   * 检索并渲染证据块。**会写盘**（记账），所以调用频率要跟着回合走，不要每次
   * 组包都调两遍。
   */
  async retrieve(opts: RetrieveOptions): Promise<Retrieved> {
    const query = buildQuery(opts.text, opts.now, {
      ...(opts.aliases === undefined ? {} : { aliases: opts.aliases }),
      ...(opts.masterId === undefined ? {} : { masterId: opts.masterId }),
    })
    const lineOpts = {
      renderTime: this.deps.renderTime,
      ...(this.deps.labelOfSubject === undefined ? {} : { labelOfSubject: this.deps.labelOfSubject }),
    }
    // ── 常驻层 + 走神层（第一/三层）：与话题无关，预算先占（见 outerBlocks）。 ──
    const { pinned, wander, pinnedBlock, wanderBlock, budget } = this.outerBlocks(opts, lineOpts)

    // 空文本不劳烦 embed 服务——也避免把"没得查"当成一次失败去触发冷却。
    const vectors = this.deps.vectors
    const queryVec = vectors === undefined || opts.text.trim() === ''
      ? null
      : await vectors.embedQuery(opts.text)
    // asOf：过滤用那个时点，排序仍用真实现在（"当时知道什么"不影响"现在多重要"）。
    const filterNow = opts.asOf ?? opts.now
    const candidates = queryVec !== null && vectors !== undefined
      ? this.hybridCandidates(query, queryVec, filterNow, opts.room, opts.roomOnly === true, opts.accept)
      : this.keywordCandidates(query, filterNow, opts.room, opts.roomOnly === true, opts.accept)
    // 实体扩展（P2 第二路的补充）：查询里点名的"人/事"顺着实体词典多想一步。
    // 实体扩展与主路径同守一套区间/房间/accept：时间词（"前天"）表达的查询意图
    // 对扩展进来的候选同样生效，否则"上个月的部署"会被实体"部署"拉回来。
    const range = narrowestRange(query)
    const admit = (r: MemoryRecord) => this.admits(r, filterNow, opts.room, opts.roomOnly === true, range, opts.accept)
    expandEntities(candidates, { store: this.deps.store, admit }, query.text)

    if (candidates.length === 0) {
      if (pinnedBlock === '' && wanderBlock === '') return { query, picked: [], evidence: '' }
      const evidence = [pinnedBlock, wanderBlock].filter((part) => part !== '').join('\n\n')
      await this.account([...pinned, ...(wander === null ? [] : [wander])], opts.now)
      return { query, picked: [...pinned, ...(wander === null ? [] : [wander])], evidence }
    }

    const weighted: Candidate[] = candidates.map((c) => ({
      record: c.record,
      relevance: boostRelevance(c.relevance, c.record, query),
    }))
    const weights = opts.weights ?? (query.preferRecent ? TIME_WEIGHTS : DEFAULT_WEIGHTS)
    const ranked = rankCandidates(weighted, opts.now, weights)
    // 预算与渲染同源：按真正要渲染的那一行算长度（前缀也计入）。
    const picked = selectForInjection(ranked, {
      ...budget,
      lineOf: (record, index) => evidenceLine(record, index, lineOpts),
    })

    const evidence = [pinnedBlock, renderEvidence(picked, lineOpts), wanderBlock]
      .filter((part) => part !== '').join('\n\n')
    const touched = [...picked.map((c) => c.record), ...pinned, ...(wander === null ? [] : [wander])]
    if (touched.length > 0) await this.account(touched, opts.now)
    return { query, picked: touched, evidence }
  }


  /**
   * e1 的关键词候选（**默认路径**：向量关着、查询嵌不动、或服务不可用时都走这里）。
   *
   * 这段逻辑是"打开向量之前线上行为逐字节不变"的锚点：候选封顶 `MAX_CANDIDATES`、
   * 链接邻居门槛是"相关性 > 0"（09 §5.2 在向量模式下收紧为 > 0.35，见
   * `expandLinksHybrid`）。改动这里等于改动默认行为，必须有评测对比。
   */
  private keywordCandidates(
    query: MemoryQuery,
    now: number,
    room: string | null,
    roomOnly: boolean,
    accept?: (record: MemoryRecord) => boolean,
  ): Candidate[] {
    const terms = this.deps.store.keepKnown(queryTerms(query.text))
    const range = narrowestRange(query)
    const scored = new Map<string, number>()

    for (const record of this.deps.store.candidatesByTerms(terms)) {
      if (!this.admits(record, now, room, roomOnly, range, accept)) continue
      scored.set(record.id, keywordRelevance(terms, record, this.idf))
      if (scored.size >= MAX_CANDIDATES) break
    }

    // 链接一跳：命中记录指向的邻居也可能是答案（A-MEM 的"顺着线索想起来"）。
    // 只扩 top-N，且邻居必须自己也有点相关性才留下——否则"顺着链接"会变成
    // "把所有记忆都翻出来"。
    const seeds = [...scored.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_LINK_EXPANSIONS)
    for (const [id] of seeds) {
      const seed = this.deps.store.get(id)
      if (seed === undefined) continue
      for (const linkId of seed.links) {
        if (scored.has(linkId)) continue
        const neighbour = this.deps.store.get(linkId)
        if (neighbour === undefined) continue
        if (!this.admits(neighbour, now, room, roomOnly, range, accept)) continue
        const own = keywordRelevance(terms, neighbour, this.idf)
        if (own <= 0) continue
        scored.set(linkId, own)
        if (scored.size >= MAX_CANDIDATES) break
      }
    }

    const out: Candidate[] = []
    for (const [id, relevance] of scored) {
      const record = this.deps.store.get(id)
      if (record !== undefined) out.push({ record, relevance })
    }
    return out
  }

  /**
   * 混合候选（向量可用时）：09 §5.2 的 a/b/c 项。
   *
   * 关键词与向量各取 top-50、合并去重（≤100 条，天然低于 e1 的 300 封顶——那顶
   * 留在 `keywordCandidates` 里管默认路径）。每条记录的相关性：有向量用余弦
   * （按配置权重与关键词混合），缺向量退回关键词重叠度；链接一跳只在
   * **邻居相关性 > 0.35** 时展开。
   */
  private hybridCandidates(
    query: MemoryQuery,
    queryVec: Float32Array,
    now: number,
    room: string | null,
    roomOnly: boolean,
    accept?: (record: MemoryRecord) => boolean,
  ): Candidate[] {
    const vectors = this.deps.vectors
    if (vectors === undefined) return this.keywordCandidates(query, now, room, roomOnly, accept)
    const terms = this.deps.store.keepKnown(queryTerms(query.text))
    const range = narrowestRange(query)
    const scored = new Map<string, number>()
    for (const record of this.keywordTop(terms, now, room, roomOnly, range, accept)) {
      scored.set(record.id, this.hybridRelevance(terms, record, queryVec, vectors.weight))
    }
    for (const record of this.vectorTop(queryVec, now, room, roomOnly, range, accept)) {
      if (!scored.has(record.id)) scored.set(record.id, this.hybridRelevance(terms, record, queryVec, vectors.weight))
    }
    this.expandLinksHybrid(scored, terms, queryVec, vectors.weight, now, room, roomOnly, range, accept)
    const out: Candidate[] = []
    for (const [id, relevance] of scored) {
      const record = this.deps.store.get(id)
      if (record !== undefined) out.push({ record, relevance })
    }
    return out
  }

  /** 关键词一路的 top-50：命中记录按关键词相关性排序（同分用 id 定序，输出确定）。 */
  private keywordTop(
    terms: readonly string[],
    now: number,
    room: string | null,
    roomOnly: boolean,
    range: { from: number; to: number } | null,
    accept?: (record: MemoryRecord) => boolean,
  ): MemoryRecord[] {
    const hits: Array<{ record: MemoryRecord; score: number }> = []
    for (const record of this.deps.store.candidatesByTerms(terms)) {
      if (!this.admits(record, now, room, roomOnly, range, accept)) continue
      hits.push({ record, score: keywordRelevance(terms, record, this.idf) })
    }
    hits.sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id))
    return hits.slice(0, TOP_PER_SOURCE).map((hit) => hit.record)
  }

  /** 向量一路的 top-50：全部已索引记录的暴力余弦（量级与理由见 09 §4.3）。 */
  private vectorTop(
    queryVec: Float32Array,
    now: number,
    room: string | null,
    roomOnly: boolean,
    range: { from: number; to: number } | null,
    accept?: (record: MemoryRecord) => boolean,
  ): MemoryRecord[] {
    const vectors = this.deps.vectors
    if (vectors === undefined) return []
    const ranked: Array<{ record: MemoryRecord; score: number }> = []
    for (const [id, vector] of vectors.all()) {
      const record = this.deps.store.get(id)
      if (record === undefined || !this.admits(record, now, room, roomOnly, range, accept)) continue
      ranked.push({ record, score: cosineSimilarity(queryVec, vector) })
    }
    ranked.sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id))
    return ranked.slice(0, TOP_PER_SOURCE).map((item) => item.record)
  }

  /** 混合相关性：记录有向量 → 余弦（按权重与关键词混合）；缺向量 → 关键词重叠度。 */
  private hybridRelevance(
    terms: readonly string[],
    record: MemoryRecord,
    queryVec: Float32Array,
    weight: number,
  ): number {
    const vec = this.deps.vectors?.vectorOf(record.id) ?? null
    const cosine = vec === null ? null : cosineSimilarity(queryVec, vec)
    return blendedRelevance(cosine, keywordRelevance(terms, record, this.idf), weight)
  }

  /** 链接一跳（09 §5.2 c 项）：top-10 种子各自的 links 展开，**邻居相关性 > 0.35** 才进。 */
  private expandLinksHybrid(
    scored: Map<string, number>,
    terms: readonly string[],
    queryVec: Float32Array,
    weight: number,
    now: number,
    room: string | null,
    roomOnly: boolean,
    range: { from: number; to: number } | null,
    accept?: (record: MemoryRecord) => boolean,
  ): void {
    const seeds = [...scored.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_LINK_EXPANSIONS)
    for (const [id] of seeds) {
      const seed = this.deps.store.get(id)
      if (seed === undefined) continue
      for (const linkId of seed.links) {
        if (scored.has(linkId)) continue
        const neighbour = this.deps.store.get(linkId)
        if (neighbour === undefined) continue
        if (!this.admits(neighbour, now, room, roomOnly, range, accept)) continue
        const own = this.hybridRelevance(terms, neighbour, queryVec, weight)
        if (own > LINK_MIN_RELEVANCE) scored.set(linkId, own)
      }
    }
  }

  /**
   * 话题检索之外的两个"场外"块：常驻（第一层）与走神（第三层）。
   * 它们不参与相似度竞争，但渲染行先从注入预算里扣——600 字是硬上限。
   */
  private outerBlocks(
    opts: RetrieveOptions,
    lineOpts: { renderTime: (at: number) => string; labelOfSubject?: (record: MemoryRecord) => string },
  ): { pinned: MemoryRecord[]; wander: MemoryRecord | null; pinnedBlock: string; wanderBlock: string; budget: NonNullable<RetrieveOptions['budget']> } {
    const pinned = opts.noPinned === true ? [] : pickPinned(this.deps.store.all())
    const pinnedBlock = renderConstantBlock(pinned, lineOpts)
    const wander = opts.roll === undefined ? null : pickWander(this.deps.store.all(), opts.now, opts.roll)
    const wanderBlock = wander === null ? '' : renderWanderBlock(wander, lineOpts)
    const reserved = (pinnedBlock === '' ? 0 : pinnedBlock.length + 2) + (wanderBlock === '' ? 0 : wanderBlock.length + 2)
    return {
      pinned,
      wander,
      pinnedBlock,
      wanderBlock,
      budget: {
        ...(opts.budget ?? {}),
        maxChars: Math.max(150, (opts.budget?.maxChars ?? MAX_INJECT_CHARS) - reserved),
      },
    }
  }

  /** 一条记录该不该进候选：状态、时间、作用域、时间范围。 */
  private admits(
    record: MemoryRecord,
    now: number,
    room: string | null,
    roomOnly: boolean,
    range: { from: number; to: number } | null,
    accept?: (record: MemoryRecord) => boolean,
  ): boolean {
    if (!isRetrievable(record, now)) return false
    if (accept !== undefined && !accept(record)) return false
    // `room === null` 是"不按房间过滤"（深召回工具用）：自动注入永远传具体房间。
    if (room !== null && record.scope === 'room' && record.room !== undefined && record.room !== room) return false
    if (roomOnly && record.scope === 'room' && record.room !== room) return false
    if (range !== null && (record.validFrom > range.to || record.validFrom < range.from)) return false
    return true
  }

  /** 记账：命中即"越用越难忘"。写盘失败只记日志——记忆的记账不该让这一回合失败。 */
  private async account(records: readonly MemoryRecord[], now: number): Promise<void> {
    const updated = records.map((r) => withHit(r, now))
    try {
      await this.deps.store.put(...updated)
    } catch (error) {
      this.deps.log(`memory: 记账失败（不影响本回合）：${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
