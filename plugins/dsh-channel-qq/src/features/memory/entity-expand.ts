/** 实体扩展的检索侧胶水（P2，从 retriever 拆出：那边有 400 行硬上限）。
 *
 * 判据本身在 `core/memory/entities.ts`（纯逻辑）；这里只做"把扩展候选塞进
 * 检索器的候选列表"这一步——依赖通过参数注入（store 与 admit 过滤都是
 * retriever 的私有形状，core 不该知道）。
 */

import type { MemoryRecord } from '../../core/memory/model.js'
import { ENTITY_EXPANSION_FACTOR, entitiesInText, entityIndex } from '../../core/memory/entities.js'
import type { Candidate } from '../../core/memory/score.js'
import type { MemoryStore } from './store.js'

export interface EntityExpandDeps {
  readonly store: MemoryStore
  /** retriever 的准入闭包（状态/时间/房间/accept 的合取）。 */
  readonly admit: (record: MemoryRecord) => boolean
}

/**
 * 查询文本点名的实体（QQ 号、keywords、person 称呼）名下的记录也进候选——
 * 关键词路径只认二元组重叠，"学弟养了猫"未必字面命中"学弟的猫叫团子"，
 * 但"学弟"这个实体把它带回来。
 *
 * 直接命中的候选不动；扩展进来的拿 `ENTITY_EXPANSION_FACTOR × 实体底分`，
 * 让它过得了阈值、又排不过真正的字面命中。
 */
export function expandEntities(
  candidates: Candidate[],
  deps: EntityExpandDeps,
  text: string,
): void {
  if (text.trim() === '') return
  const index = entityIndex(deps.store.all())
  const mentioned = entitiesInText(index, text)
  if (mentioned.length === 0) return
  const seen = new Set(candidates.map((c) => c.record.id))
  const base = 0.35 * ENTITY_EXPANSION_FACTOR
  for (const { ids } of mentioned) {
    for (const id of ids) {
      if (seen.has(id)) continue
      const record = deps.store.get(id)
      if (record === undefined) continue
      if (!deps.admit(record)) continue
      candidates.push({ record, relevance: base })
      seen.add(id)
    }
  }
}
