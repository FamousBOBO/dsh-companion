/** 夜间巩固的**合并计划**（P1，调研 [20261024_memory-system-research.md] §6-P1）。
 *
 * 与 `nightly.ts`（遗忘/冲突检出/DIGEST）的分工：那个文件管"哪些该归档、哪些疑似
 * 冲突"，这里管"哪些该**合并**"。三者的输出都只是**计划**——执行与写盘在
 * `features/memory/nightly.ts`。
 *
 * 为什么合并要单独一个文件：mneme 的 autoDream 证明"巩固"的核心不是模型调用，
 * 而是**类型化决策**（keep / merge / archive / conflict）。merge 是其中唯一动
 * 正文形状的，判据也最微妙：两条"同主体同类且高度重叠但不相同"的记录，多见
 * "一件事的两种说法"（"学弟在上海工作" vs "学弟公司在上海"）——重叠够高就合并，
 * 保留信息量大的那条当正文，另一条退役（supersede，不删除）。
 *
 * 纪律（与夜间任务同源）：
 *   - **被钉住的永不合并**（isPinned 的判据已经足够保守，合并会让"永不归档"失去意义）；
 *   - **合并必须留凭证**：谁并入谁、正文用了哪条、丢弃了什么——`mergeNote` 渲染；
 *   - 两条**完全相等**的正文不走这里（写入侧 findNearDuplicate 已经挡了）。
 */

import { isPinned, sameTopic, supersede, type MemoryRecord } from './model.js'
import { overlapOf, type ConflictPair } from './nightly.js'

/** 判"其实是同一件事"的重叠门槛。低于它算不同事实，宁多不少。 */
export const MERGE_OVERLAP = 0.75

/** 一条合并计划：keep 吸收 drops 的记忆痕迹后继续活着。 */
export interface MergePlan {
  /** 留下的记录（正文取信息量更大的那条，痕迹取双方之最）。 */
  readonly keep: MemoryRecord
  /** 并入后退役的（supersede，历史可回查）。 */
  readonly drops: readonly MemoryRecord[]
}

/** 合并后 keep 的痕迹：hits 相加、强度取最大、置信取最高、links 取并集。 */
export function absorb(keep: MemoryRecord, drops: readonly MemoryRecord[]): MemoryRecord {
  let hits = keep.hits
  let strength = keep.strength
  let confidence = keep.confidence
  let lastHitAt = keep.lastHitAt
  const links = new Set<string>(keep.links)
  for (const drop of drops) {
    hits += drop.hits
    strength = Math.max(strength, drop.strength)
    confidence = Math.max(confidence, drop.confidence)
    if (drop.lastHitAt !== undefined && (lastHitAt === undefined || drop.lastHitAt > lastHitAt)) {
      lastHitAt = drop.lastHitAt
    }
    for (const link of drop.links) {
      if (link !== keep.id) links.add(link)
    }
  }
  return {
    ...keep,
    hits,
    strength,
    confidence,
    ...(lastHitAt === undefined ? {} : { lastHitAt }),
    links: [...links].slice(0, keep.links.length + drops.length * 4),
  }
}

/** 正文选谁：长度是"信息量"的粗代理；同长取 recordedAt 更新的（新的说法更接近现在）。 */
function pickBody(a: MemoryRecord, b: MemoryRecord): MemoryRecord {
  if (a.content.length !== b.content.length) return a.content.length > b.content.length ? a : b
  return a.recordedAt >= b.recordedAt ? a : b
}

/** 对一批同 topic 的记录（都 active、同主体同类）两两找可合并对。 */
function pairsWithin(bucket: readonly MemoryRecord[]): Array<{ a: MemoryRecord; b: MemoryRecord; overlap: number }> {
  const out: Array<{ a: MemoryRecord; b: MemoryRecord; overlap: number }> = []
  for (let i = 0; i < bucket.length; i += 1) {
    for (let j = i + 1; j < bucket.length; j += 1) {
      const a = bucket[i]!
      const b = bucket[j]!
      const overlap = overlapOf(a.content, b.content)
      if (overlap >= MERGE_OVERLAP) out.push({ a, b, overlap })
    }
  }
  return out.sort((x, y) => y.overlap - x.overlap)
}

/**
 * 生成整库的合并计划。
 *
 * 流程：按 topic 分组（只收 active、非钉住、非原文块）→ 组内按重叠从高到低配对 →
 * 每对产出一条 MergePlan（body 当 keep，另一条进 drops）。一条记录最多进一个计划
 * （先到先得，按重叠高低），所以输出之间不会互相冲突——执行器可以放心逐条落地。
 */
export function planMerges(records: readonly MemoryRecord[]): MergePlan[] {
  const groups = new Map<string, MemoryRecord[]>()
  for (const record of records) {
    if (record.status !== 'active') continue
    if (isPinned(record)) continue
    const key = `${record.kind}|${record.subject.type}|${String(record.subject.id ?? '')}`
    const bucket = groups.get(key)
    if (bucket === undefined) groups.set(key, [record])
    else bucket.push(record)
  }
  const plans: MergePlan[] = []
  const consumed = new Set<string>()
  for (const bucket of groups.values()) {
    for (const { a, b } of pairsWithin(bucket)) {
      if (consumed.has(a.id) || consumed.has(b.id)) continue
      const keep = pickBody(a, b)
      const drop = keep.id === a.id ? b : a
      consumed.add(a.id)
      consumed.add(b.id)
      plans.push({ keep: absorb(keep, [drop]), drops: [drop] })
    }
  }
  return plans
}

/**
 * 执行一条合并计划：keep 落 absorb 后的形状，drops 各自 supersede 到 keep.id。
 * 返回要写盘的完整记录列表（调用方一次性 put）。
 */
export function applyMerge(plan: MergePlan, now: number): MemoryRecord[] {
  const out: MemoryRecord[] = [plan.keep]
  for (const drop of plan.drops) out.push(supersede(drop, plan.keep.id, now))
  return out
}

/**
 * 合并的决策凭证（mneme 的 receipt 思路：巩固不留凭证 = 白巩固）。
 * 追加进 `consolidation-log.jsonl`，事后能回答"这两条为什么变成了一条"。
 */
export function mergeNote(plan: MergePlan): string {
  const dropIds = plan.drops.map((d) => d.id).join(',')
  const overlap = plan.drops.length > 0 ? overlapOf(plan.keep.content, plan.drops[0]!.content).toFixed(2) : '0'
  return `merge ${dropIds} → ${plan.keep.id}（重叠 ${overlap}，正文保留 ${plan.keep.content.slice(0, 30)}…）`
}

/**
 * 矛盾对的冻结键：一对冲突在队列里的唯一标识（id 排序后拼接）。
 * 队列文件用它去重——同一对反复扫出来只记一次。
 */
export function conflictKey(pair: ConflictPair): string {
  return [pair.left.id, pair.right.id].sort().join('~')
}
