/** 实体词典：从记录里抽"谁/什么"的别名，检索时顺着实体多想一步（P2）。
 *
 * 调研来源：dsh-engram 的实体词典（别名归一、多对多挂到记忆）+ 它检索时的
 * "one-hop relation-edge expansion"。我们的简化版刻意**确定性**（R8、零模型）：
 *   - 实体的来源只有三处：`subject.id`（QQ 号/群号）、`keywords`（建档时给的词）、
 *     `person` 记录正文开头的称呼（"学弟住在…"的"学弟"）；
 *   - 查询侧：查询文本里**包含**实体键（`includes`，中文不用分词）就命中该实体，
 *     该实体名下的记录按"命中记录分数 × 衰减"进候选。
 *
 * 为什么不接 NER：实体词典的价值在"别名 → 记录"的**挂接**，不在识别本身。
 * 记录建档时 keywords/subject 已经是现成的高质量锚点，再用模型抽一遍实体是
 * 花钱买边角收益——这些预算留给 P0 的抽取。
 */

import type { MemoryRecord } from './model.js'
import { isChunkRecord } from './model.js'

/** 一个实体名下最多挂几条记录（挂满会失去"顺着实体想起"的针对性）。 */
export const MAX_RECORDS_PER_ENTITY = 12

/** 实体键的最短长度（单字中文做实体 = 万物皆实体，噪声灾难）。 */
export const MIN_ENTITY_LEN = 2

/** 别名的前缀截断长度（person 正文取前 8 字当称呼——"学弟""王阿姨"量级）。 */
const PERSON_NAME_CHARS = 8

/** 单条记录贡献的实体键。 */
function entitiesOf(record: MemoryRecord): string[] {
  const out = new Set<string>()
  if (record.subject.id !== undefined) {
    const id = String(record.subject.id)
    if (id.length >= MIN_ENTITY_LEN) out.add(id)
  }
  for (const keyword of record.keywords) {
    if (keyword.length >= MIN_ENTITY_LEN && keyword.length <= 16) out.add(keyword.toLowerCase())
  }
  if (record.kind === 'person') {
    const name = record.content.slice(0, PERSON_NAME_CHARS)
    if (name.length >= MIN_ENTITY_LEN) out.add(name.toLowerCase())
  }
  return [...out]
}

/**
 * 建实体词典：实体键 → 记录 id 集合。只收 `active`；原文块不进
 * （块是 600 字原文，不是"一条记忆"，与注入的同一道规矩）。
 *
 * O(库大小)，每次检索前现建在量级上不可接受时调用方应缓存（装配层已有
 * 每回合一次的节奏，数千条记录的 Map 构建在毫秒级）。
 */
export function entityIndex(records: readonly MemoryRecord[]): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>()
  for (const record of records) {
    if (record.status !== 'active' || isChunkRecord(record)) continue
    for (const key of entitiesOf(record)) {
      const bucket = index.get(key)
      if (bucket === undefined) index.set(key, new Set([record.id]))
      else if (bucket.size < MAX_RECORDS_PER_ENTITY) bucket.add(record.id)
    }
  }
  return index
}

/**
 * 查询文本里出现的实体 → 记录 id（带"这个实体被提了几次"的计数，供相关性加权）。
 *
 * 命中判据是 `text.includes(key)`：中文无分词，这是保守但零依赖的近似——
 * "学弟为什么…"会命中实体"学弟"，"学"不会（长度门槛挡了单字）。
 */
export function entitiesInText(
  index: Map<string, Set<string>>,
  text: string,
): Array<{ key: string; ids: Set<string> }> {
  const lower = text.toLowerCase()
  const out: Array<{ key: string; ids: Set<string> }> = []
  for (const [key, ids] of index) {
    if (lower.includes(key)) out.push({ key, ids })
  }
  // 提到的实体越多越靠前；同级按键定序（输出确定，测试可断言）。
  out.sort((a, b) => (a.key === b.key ? 0 : a.key < b.key ? -1 : 1))
  return out
}

/** 实体扩展进候选时的相关性折扣：顺着想起来的，比直接命中的弱一档。 */
export const ENTITY_EXPANSION_FACTOR = 0.8
