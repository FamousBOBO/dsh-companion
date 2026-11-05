/** 知识库服务：把 store / 检索 / 摄取 / 向量打包成工具与后台共用的一张面。
 *
 * 为什么不让工具直接拿 `KbStore`：工具只该知道"搜什么、返回什么"，读写细节
 * （归档、增量重建、串行队列）留在实现里；后台同理，只调这几个方法。
 */

import { citationOf, type KbHit } from '../../core/kb/model.js'
import type { KbService, KbStats } from '../../ports/kb.js'
import type { IngestProgress, KbIngestor } from './ingest.js'
import type { KbRetriever } from './retriever.js'
import type { KbStore } from './store.js'
import type { KbVectors } from './vectors.js'

export type { KbService, KbStats } from '../../ports/kb.js'

export interface KbServiceDeps {
  readonly store: KbStore
  readonly retriever: KbRetriever
  readonly ingestor: KbIngestor
  readonly vectors: KbVectors | null
  readonly reindex: () => Promise<{ embedded: number; failed: number; total: number; skipped: boolean }>
  readonly enabled: () => boolean
  readonly injectTop: () => number
  readonly injectChars: () => number
}

export function createKbService(deps: KbServiceDeps): KbService {
  return {
    search: async (query, room, limit, collection) =>
      await deps.retriever.retrieve({ text: query, room, limit, ...(collection === undefined ? {} : { collection }) }),
    catalog: (room) => deps.retriever.catalog(room),
    evidence: async ({ text, room }) => deps.enabled()
      ? await deps.retriever.evidence(text, room, deps.injectTop(), deps.injectChars())
      : '',
    stats: () => ({
      ...deps.store.stats(),
      enabled: deps.enabled(),
      vectors: deps.vectors?.size() ?? 0,
      ingest: deps.ingestor.status(),
    }),
    ingest: async (force = false) => await deps.ingestor.run(force),
    reindexVectors: async () => deps.enabled() ? await deps.reindex() : { embedded: 0, failed: 0, total: deps.vectors?.size() ?? 0, skipped: true },
    remove: async (id) => await deps.store.removeDocument(id, Date.now()),
    restore: async (id) => await deps.store.restoreDocument(id, Date.now()),
    preview: (id) => {
      const doc = deps.store.getDoc(id)
      if (doc === undefined) return null
      return { doc, chunks: deps.store.chunksOf(id).filter((chunk) => !chunk.archived) }
    },
    documents: () => deps.store.documents(),
    collections: () => deps.store.collections(),
  }
}

/** 工具结果里的一条命中（带引用与截断后的正文）。 */
export function hitToResult(hit: KbHit, maxChars = 900): Record<string, unknown> {
  return {
    citation: citationOf(hit),
    title: hit.document.title,
    path: hit.document.path,
    heading: hit.chunk.heading,
    page: hit.chunk.page,
    segment: hit.chunk.seq + 1,
    score: Number(hit.score.toFixed(3)),
    text: hit.chunk.text.slice(0, maxChars),
  }
}
