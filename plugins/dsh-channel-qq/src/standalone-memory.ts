/**
 * Standalone memory entry — 让记忆核心可脱离 cordis 宿主独立使用。
 *
 * 插件主体（`src/index.ts`）仍通过 cordis Service 装配记忆；本入口把同一套
 * `core/memory` + `features/memory` 以普通工厂函数暴露，任何 Node 22+ 宿主
 * （其他 bot 框架、CLI 脚本、测试夹具）都能直接接入。
 *
 * 零框架依赖：只 import `node:*` 与仓库内的 `core/memory`、`features/memory`、
 * `adapters/fs-store`、`ports/memory`。向量服务（`EmbedPort`）不传时自动走关键词路径。
 */

import { MemoryStore } from './features/memory/store.js'
import { createMemoryService, type LegacyWriter } from './features/memory/service.js'
import { MemoryRetriever } from './features/memory/retriever.js'
import { keywordRelevance, queryTerms } from './core/memory/score.js'
import { isChunkRecord, type MemoryRecord } from './core/memory/model.js'
import type { EmbedPort, MemoryEvidence, MemoryService } from './ports/memory.js'

export type { MemoryRecord } from './core/memory/model.js'
export type { MemoryService, MemoryEvidence, EmbedPort } from './ports/memory.js'
export type { LegacyWriter } from './features/memory/service.js'

export interface MemoryV2Options {
  /** dsh 宿主根（$DSH_HOME），用于缺省路径。 */
  readonly dshHome: string
  /** 工作区路径；null 时记忆库落在 dshHome/channel-qq/knowledge/。 */
  readonly workspacePath: string | null
  readonly log: (line: string) => void
  /** 旧 KnowledgeStore 兼容写入目标（双写，可空）。 */
  readonly legacyWriter?: LegacyWriter | null
  /** 向量服务（可选）；不传则永远走关键词路径。 */
  readonly embed?: EmbedPort | null
  /** 主体标签（检索证据渲染用，如「主人」）。 */
  readonly labelOfSubject?: (record: MemoryRecord) => string
  /** 注入预算（不传用 core 默认值：0.35 / 8 条 / 600 字）。 */
  readonly budget?: { readonly threshold?: number; readonly maxRecords?: number; readonly maxChars?: number }
}

export interface MemoryV2 {
  readonly store: MemoryStore
  readonly service: MemoryService
  readonly retriever: MemoryRetriever
  /** 组包前调用：本回合想起什么。返回空串 = 什么都没想起来。 */
  readonly evidence: MemoryEvidence
  /** 兼容旧 KnowledgeStore.search 的轻量召回（供桥接层退化使用）。 */
  search(query: string, top?: number): Array<{ id: string; content: string; source: string }>
  memorize(input: {
    content: string
    kind?: string | undefined
    tags?: readonly string[] | undefined
    source?: string | undefined
  }): Promise<{ id: string; total: number; created: boolean }>
  recall(input: { query: string; kind?: string | undefined; limit: number }): Promise<ReadonlyArray<{
    id: string
    kind: string
    content: string
    tags: readonly string[]
    source: string
    date: string
    hits: number
  }>>
}

/** 证据块：与插件同口径（排除原文块、日期只到天、可选预算）。 */
function makeEvidence(opts: MemoryV2Options, retriever: MemoryRetriever): MemoryEvidence {
  return async (input) => {
    try {
      const result = await retriever.retrieve({
        text: input.text,
        now: Date.now(),
        room: input.room,
        ...(opts.budget === undefined ? {} : { budget: opts.budget }),
        accept: (record: MemoryRecord) => !isChunkRecord(record),
      })
      return result.evidence
    } catch (error) {
      opts.log(`memory standalone evidence failed: ${String(error)}`)
      return ''
    }
  }
}

/** 兼容旧 KnowledgeStore.search 的轻量召回。 */
function makeSearch(store: MemoryStore): (query: string, top?: number) => Array<{ id: string; content: string; source: string }> {
  return (query, top = 5) => {
    try {
      const terms = store.keepKnown(queryTerms(query))
      return store.candidatesByTerms(terms)
        .map((record) => ({ record, score: keywordRelevance(terms, record, (term) => store.idfOf(term)) }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, top)
        .map((item) => ({ id: item.record.id, content: item.record.content, source: item.record.source.kind }))
    } catch {
      return []
    }
  }
}

export async function createMemoryV2(opts: MemoryV2Options): Promise<MemoryV2> {
  const store = new MemoryStore({
    dshHome: opts.dshHome,
    workspacePath: opts.workspacePath,
    log: opts.log,
  })
  await store.load()

  // 与插件一致：证据里的日期只到天，不把毫秒时区塞给模型。
  const renderTime = (at: number): string => new Date(at).toISOString().slice(0, 10)
  const clock = { now: (): number => Date.now() }
  const service = createMemoryService({
    store,
    log: opts.log,
    renderTime,
    clock,
    legacy: opts.legacyWriter ?? null,
  })
  const retriever = new MemoryRetriever({
    store,
    log: opts.log,
    renderTime,
    clock,
    ...(opts.labelOfSubject === undefined ? {} : { labelOfSubject: opts.labelOfSubject }),
  })

  const evidence = makeEvidence(opts, retriever)
  const search = makeSearch(store)

  return {
    store,
    service,
    retriever,
    evidence,
    search,
    memorize: async (input) => service.memorize(input),
    recall: async (input) => service.recall(input),
  }
}
