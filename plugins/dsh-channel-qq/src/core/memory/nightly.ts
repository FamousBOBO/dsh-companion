/** 夜间巩固的**纯逻辑**（09 §6.2/§6.3/§7）。
 *
 * `core/` 的硬规矩（R8）：不读时钟、不掷随机、不碰 IO——`now` 与阈值都由参数传进来。
 * 这里放的是"怎么选、怎么判"的判据；写文件、调模型、注册 job 都在
 * `features/memory/nightly.ts`。
 *
 * 三件事：
 *   - **遗忘**：`shouldArchive`（model.ts 的艾宾浩斯 + 钉住）已经定好单条判据，
 *     这里只做"整库过一遍"的分流（归档 / 留下）；
 *   - **冲突检出**：§4.2 的规则 1 要 LLM 裁决，够不到模型时**退化到规则 3**
 *     （两条并存 + 进待处理）。退化需要"哪些对**疑似**冲突"——用规则近似：
 *     同主体同类（`sameTopic`）且正文高度重叠但**不相同**（很可能是一件事的两种说法）；
 *   - **DIGEST 选取**：§7.4 的"重要性最高 + 最近活跃"，排序确定、可测。
 */

import { bigrams, LINK_MIN_RELEVANCE } from './score.js'
import { isPinned, sameTopic, shouldArchive, type MemoryRecord } from './model.js'

/** 疑似冲突判定的重叠门槛（二元组 Jaccard）。低于它的同主体记录算"不同的事实"。 */
export const CONFLICT_OVERLAP_MIN = 0.5

export interface ArchiveSplit {
  /** 到期该归档的（R < 0.05 且没被钉住）。 */
  readonly archive: readonly MemoryRecord[]
  /** 留下的（含被钉住的、以及还没到期但本来就不该变的）。 */
  readonly keep: readonly MemoryRecord[]
}

/**
 * 整库过一遍遗忘曲线（§6.3）。
 *
 * 只考虑 `active`：`superseded`/`archived`/`candidate` 各自有归宿，不该被再动一次
 * ——把它们也扫进来只会让"这条为什么归档了"变得难以回答。
 */
export function splitForArchive(records: readonly MemoryRecord[], now: number): ArchiveSplit {
  const archive: MemoryRecord[] = []
  const keep: MemoryRecord[] = []
  for (const record of records) {
    if (record.status !== 'active') {
      keep.push(record)
      continue
    }
    if (shouldArchive(record, now)) archive.push(record)
    else keep.push(record)
  }
  return { archive, keep }
}

/** 二元组 Jaccard 重叠（0 = 毫无共同点，1 = 完全相同）。 */
export function overlapOf(a: string, b: string): number {
  const left = bigrams(a)
  const right = bigrams(b)
  if (left.size === 0 || right.size === 0) return a === b ? 1 : 0
  let shared = 0
  for (const gram of left) if (right.has(gram)) shared += 1
  return shared / (left.size + right.size - shared)
}

/** 一对疑似冲突（`left` 是较早那条）。 */
export interface ConflictPair {
  readonly left: MemoryRecord
  readonly right: MemoryRecord
  readonly overlap: number
}

/**
 * 找疑似冲突对：同主体同类、都还 active、正文高度重叠但**不相同**。
 *
 * 为什么不用"同主体同类"直接当冲突：同一个人的 `fact` 可以有很多条互不相干的事实
 * （"不吃香菜"和"住在 3 号楼"）。真正的冲突是"同一件事的两种说法"，而那种情况
 * 正文的二元组重叠会很高——所以用重叠量作判据，宁缺毋滥。
 *
 * O(n²) 但只在同 topic 分组内两两比较，且每组通常只有个位数条。
 */
export function findConflicts(records: readonly MemoryRecord[]): ConflictPair[] {
  const groups = new Map<string, MemoryRecord[]>()
  for (const record of records) {
    if (record.status !== 'active') continue
    const key = `${record.kind}|${record.subject.type}|${String(record.subject.id ?? '')}`
    const bucket = groups.get(key)
    if (bucket === undefined) groups.set(key, [record])
    else bucket.push(record)
  }
  const pairs: ConflictPair[] = []
  for (const bucket of groups.values()) {
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        const left = bucket[i]!
        const right = bucket[j]!
        if (!sameTopic(left, right)) continue
        if (left.content === right.content) continue
        const overlap = overlapOf(left.content, right.content)
        if (overlap >= CONFLICT_OVERLAP_MIN) pairs.push({ left, right, overlap })
      }
    }
  }
  // 重叠越高越可疑，排前面（后台列表按这个顺序看）。
  return pairs.sort((a, b) => b.overlap - a.overlap)
}

/** DIGEST 里的一条（渲染交给调用方）。 */
export interface DigestPick {
  readonly record: MemoryRecord
  /** 排序用的分：重要性为主、近因次之，都取天然尺度。 */
  readonly score: number
}

/**
 * DIGEST 的选取（§7.4）：重要性最高 + 最近活跃。
 *
 * `recency` 用"最近一次被召回 / 建档"的日历天差取指数衰减——与检索的打分同一
 * 形状（`0.995^小时`），但不复用那个函数是因为这里要的是**排序**而不是阈值比较，
 * 且必须对"从没被召回过的偏好"友好（`lastHitAt` 缺省落到 `recordedAt`）。
 *
 * 只收 `active`；`preference`/`person`/`trait`/`fact` 全都要（DIGEST 是"核心记忆
 * 摘要"，不是"按类型分栏"）；`candidate` 不收——它们还没被主人确认。
 */
export function pickForDigest(records: readonly MemoryRecord[], now: number): DigestPick[] {
  const picks: DigestPick[] = []
  for (const record of records) {
    if (record.status !== 'active') continue
    const last = record.lastHitAt ?? record.recordedAt
    const hours = Math.max(0, (now - last) / 3_600_000)
    picks.push({ record, score: record.importance / 10 + 0.995 ** hours })
  }
  picks.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    // 分数相同时新的在前，顺序才是确定的（快照可比）。
    return b.record.recordedAt - a.record.recordedAt
  })
  return picks
}

/** 渲染 DIGEST 正文（§7.4：文件头写明"自动生成，勿手改"）。 */
export function renderDigest(picks: readonly DigestPick[], opts: { generatedAt: string; maxBytes: number }): string {
  // 用 TextEncoder 而不是 Buffer：`core/` 是可重放层，不依赖 Node 专有的全局。
  const encoder = new TextEncoder()
  const sizeOf = (text: string): number => encoder.encode(text).length
  const head = [
    '<!-- 自动生成，勿手改（夜间任务 digest 产出；改它会被下一次生成覆盖） -->',
    `# 记忆摘要（DIGEST）`,
    '',
    `生成时间：${opts.generatedAt}　记录数：${picks.length}`,
    '',
    '更早的事用 qq_memory 检索（recall），或翻 memory/ 里的日记。',
    '',
  ].join('\n')
  const lines: string[] = []
  let bytes = sizeOf(head)
  for (const pick of picks) {
    const line = `- （${pick.record.kind}）${pick.record.content}`
    const size = sizeOf(`${line}\n`)
    // 按**整条**截断，不做半条（与注入预算同一条规矩）。
    if (bytes + size > opts.maxBytes) break
    bytes += size
    lines.push(line)
  }
  return [head, ...lines, ''].join('\n')
}

/** DIGEST 的字节上限（§7.4：≤ 8KB）。 */
export const DIGEST_MAX_BYTES = 8192

/** 归档文件里一行要带的注记（谁、为什么）。 */
export function archiveNote(record: MemoryRecord, now: number): string {
  const days = Math.max(0, (now - (record.lastHitAt ?? record.recordedAt)) / 86_400_000)
  const pinned = isPinned(record) ? '（钉住，不应到此）' : ''
  return `R<0.05，距上次召回 ${days.toFixed(1)} 天${pinned}`
}

/** 一条记录最多挂几个邻居（A-MEM 的 links 是稀疏的，挂满会失去"关联"的含义）。 */
export const MAX_LINKS = 4

/**
 * 建链接（§6.2 的"链接与演化"里可确定的那一半）。
 *
 * 判据：同主体同类（`sameTopic`）**或**正文重叠 ≥ `LINK_MIN_RELEVANCE`，取重叠
 * 最高的前 `MAX_LINKS` 个，**双向**写入 links。只动 `links` 字段，别的一律不碰
 * ——"演化回写 keywords/context"要模型，这里不做（在 job 里具名跳过）。
 *
 * 已经挂上的链接不重复加；返回**需要写回**的记录（没有变化就不写，夜间任务不该
 * 每天把整库重写一遍）。
 */
export function buildLinks(records: readonly MemoryRecord[]): MemoryRecord[] {
  const active = records.filter((r) => r.status === 'active')
  const changed: MemoryRecord[] = []
  for (const record of active) {
    const scored: Array<{ id: string; score: number }> = []
    for (const other of active) {
      if (other.id === record.id) continue
      if (record.links.includes(other.id)) continue
      const related = sameTopic(record, other)
      const overlap = overlapOf(record.content, other.content)
      if (!related && overlap < LINK_MIN_RELEVANCE) continue
      // 同主体同类是最强信号，重叠量是它的补充；两者都有时分数更高。
      scored.push({ id: other.id, score: (related ? LINK_MIN_RELEVANCE : 0) + overlap })
    }
    if (scored.length === 0) continue
    scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.id.localeCompare(b.id)))
    const links = [...record.links, ...scored.slice(0, MAX_LINKS).map((s) => s.id)]
    if (links.length === record.links.length) continue
    changed.push({ ...record, links })
  }
  return changed
}
