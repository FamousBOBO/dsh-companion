/** 记忆服务（`MemoryService` 端口在工具面的实现）：主动召回与写入。
 *
 * 与检索器（`retriever.ts`）的分工：检索器服务**每一回合的自动注入**（3–8 条、
 * 600 字预算、按房间过滤）；本文件服务**模型主动调用的那两个工具**（条数由模型指定、
 * 返回结构更详细、命中会强化）。两者共用同一份打分与同一份存储。
 *
 * e1 的两条简化，都写在明面上（e2/e3 会补）：
 *   - **去重按内容完全相等**。设计文档要的是"相似度 > 0.92 视为重复、0.75–0.92 交模型
 *     裁决"，那两种都需要向量；e1 只有关键词，用"一字不差"当重复线，宁多不少。
 *   - **关键词由正文切出来**（二元组 / 英文词），不是模型生成的。少一点语义、多一点
 *     召回，等 e2 的嵌入到位再用模型补 keywords/context。
 */

import { isChunkRecord, makeRecord, oneLine, withHit, type MemoryKind, type MemoryRecord } from '../../core/memory/model.js'
import { keywordRelevance, queryTerms, rankCandidates } from '../../core/memory/score.js'
import type { MemoryService } from '../../ports/memory.js'
import type { MemoryStore } from './store.js'

const KINDS: readonly MemoryKind[] = ['fact', 'preference', 'event', 'person', 'skill', 'procedure', 'trait']

/** 旧工具的类型词表是它的子集；对不上就算 fact。 */
function asKind(raw: string | undefined): MemoryKind {
  const value = (raw ?? 'fact').trim().toLowerCase()
  return (KINDS as readonly string[]).includes(value) ? (value as MemoryKind) : 'fact'
}

/** 旧知识库的窄契约（双写用）：只要它能把条目存下来。 */
export interface LegacyWriter {
  addMany(items: Array<{ type: string; content: string; tags: string[]; source: string }>): Promise<number>
}

export interface MemoryServiceDeps {
  readonly store: MemoryStore
  readonly log: (line: string) => void
  /** 把时间戳渲染成给人看的日期（注入，便于测试）。 */
  readonly renderTime: (at: number) => string
  readonly clock: { now(): number }
  /** e1 的双写目标：老 `KnowledgeStore`。没有就只写新库。 */
  readonly legacy: LegacyWriter | null
  /** 随机源（id 后缀）。 */
  readonly random?: () => number
}

/** 出处的一句话描述：检索时"这条是哪来的"要能一眼看见。 */
export function describeSource(record: MemoryRecord): string {
  const s = record.source
  const where = s.room ?? s.file ?? s.sessionId ?? ''
  return where === '' ? s.kind : `${s.kind} · ${where}`
}

/** 从正文切出检索词当 keywords（e1 的近似做法，见文件头）。 */
function keywordsOf(content: string): string[] {
  const terms = queryTerms(content)
  return terms.filter((t) => t.length >= 2).slice(0, 12)
}

export function createMemoryService(deps: MemoryServiceDeps): MemoryService {
  return {
    memorize: (input) => memorize(deps, input),
    recall: (input) => recall(deps, input),
  }
}

type MemorizeInput = Parameters<MemoryService['memorize']>[0]
type RecallInput = Parameters<MemoryService['recall']>[0]
type MemorizeResult = Awaited<ReturnType<MemoryService['memorize']>>
type RecallResult = Awaited<ReturnType<MemoryService['recall']>>

/** 找一个内容完全相同的 active 记录（e1 的"重复"判据，见文件头）。 */
function findDuplicate(store: MemoryStore, content: string): MemoryRecord | null {
  for (const record of store.all()) {
    if (record.status === 'active' && record.content === content) return record
  }
  return null
}

async function memorize(deps: MemoryServiceDeps, input: MemorizeInput): Promise<MemorizeResult> {
  // 与入库同一归一化口径，否则超长内容每次截断后就认不出重复。
  const content = oneLine(input.content.trim())
  const now = deps.clock.now()
  const duplicate = findDuplicate(deps.store, content)
  if (duplicate !== null) {
    // 重复不算新增，但记一次"又提到了"：经常被提起的事本来就该更难忘记。
    await deps.store.put(withHit(duplicate, now))
    return { id: duplicate.id, total: deps.store.size(), created: false }
  }
  const record = await deps.store.remember({
    kind: asKind(input.kind),
    subject: { type: 'world' },
    content,
    source: { kind: 'manual', ...(input.source === undefined ? {} : { file: input.source }) },
    tags: [...(input.tags ?? [])],
    keywords: keywordsOf(content),
    importance: 6,
  }, now, deps.random ?? (() => 0.5))
  await mirrorToLegacy(deps, record, input.source)
  return { id: record.id, total: deps.store.size(), created: true }
}

/** 双写老知识库：换开关那天不该出现"记忆页空了"。失败只记日志——新库已经写成功了。 */
async function mirrorToLegacy(deps: MemoryServiceDeps, record: MemoryRecord, source: string | undefined): Promise<void> {
  if (deps.legacy === null) return
  try {
    await deps.legacy.addMany([{
      type: record.kind,
      content: record.content,
      tags: [...record.tags],
      source: source ?? 'memory',
    }])
  } catch (error) {
    deps.log(`memory: 双写老知识库失败（新库已写入）：${error instanceof Error ? error.message : String(error)}`)
  }
}

async function recall(deps: MemoryServiceDeps, input: RecallInput): Promise<RecallResult> {
  // 先按 mtime 惰性重载，外部写入（夜间蒸馏、迁移脚本）当轮就能召回。
  await deps.store.refreshIfChanged().catch(() => {})
  const terms = deps.store.keepKnown(queryTerms(input.query))
  const kind = input.kind === undefined ? null : asKind(input.kind)
  const candidates = deps.store.candidatesByTerms(terms)
    // 原文块不参与主动召回：那是 600 字原文，不是"一条记忆"。
    .filter((r) => r.status === 'active' && !isChunkRecord(r) && (kind === null || r.kind === kind))
    .map((record) => ({ record, relevance: keywordRelevance(terms, record, (t) => deps.store.idfOf(t)) }))
  const ranked = rankCandidates(candidates, deps.clock.now()).slice(0, Math.max(1, input.limit))
  if (ranked.length === 0) return []
  // 主动召回也算"用过"：命中就强化（与自动注入同一套规则）。
  const now = deps.clock.now()
  await deps.store.put(...ranked.map((c) => withHit(c.record, now)))
  return ranked.map(({ record }) => ({
    id: record.id,
    kind: record.kind,
    content: record.content,
    tags: [...record.tags],
    source: describeSource(record),
    date: deps.renderTime(record.validFrom),
    hits: record.hits + 1,
  }))
}
