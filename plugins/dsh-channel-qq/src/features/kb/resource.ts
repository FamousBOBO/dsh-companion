/** 后台「知识库」页的数据面：文档清单、集合、摄取进度、扫描/重建/删除/预览。
 *
 * 写操作只有三个：扫描（读磁盘）、重建向量、软删除/恢复。**不提供"直接写入文档"**
 * ——知识库的入口是工作区里的文件，绕开文件系统写入会让"来源可追溯"这句话失效。
 */

import type { Json } from '../../admin/config-engine.js'
import type { AdminResource } from '../../admin/types.js'
import type { KbDocument } from '../../core/kb/model.js'
import type { KbService } from './service.js'

export interface KbResourceDeps {
  readonly service: KbService
  readonly log: (line: string) => void
  /** URL 入库开关（默认关）与实现；缺实现时动作给出可读拒绝。 */
  readonly ingestUrls: () => boolean
  readonly ingestUrl?: (url: string) => Promise<unknown>
  /** 现取集合可见范围（配置里是 JSON 字符串；坏 JSON 的原因也一并给后台）。 */
  readonly scopes: () => { scopes: Record<string, readonly string[]>; error: string }
}

function bodyOf(body: Json): Record<string, unknown> {
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {}
}

function idOf(body: Json): string {
  const id = String(bodyOf(body).id ?? '').trim()
  if (id === '') throw new Error('缺少文档 id')
  return id
}

/** 一条文档（块数按需现算；文档总数在几千的量级，逐个统计可接受）。 */
function summarize(doc: KbDocument, chunks: number): Record<string, unknown> {
  return {
    id: doc.id,
    title: doc.title,
    path: doc.path,
    collection: doc.collection,
    status: doc.status,
    bytes: doc.bytes,
    mtime: doc.mtime,
    updatedAt: doc.updatedAt,
    parser: doc.parser,
    pages: doc.pages ?? 0,
    error: doc.error ?? '',
    chunks,
  }
}

export function kbResource(deps: KbResourceDeps): AdminResource {
  return {
    label: '知识库',
    list: (query) => {
      const service = deps.service
      const only = (query?.get('collection') ?? '').trim()
      const docs = service.documents()
        .filter((doc) => only === '' || doc.collection === only)
        .map((doc) => summarize(doc, service.preview(doc.id)?.chunks.length ?? 0))
        .sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt))
      const scope = deps.scopes()
      return {
        ingestUrls: deps.ingestUrls(),
        documents: docs,
        collections: service.collections(),
        stats: service.stats(),
        scopes: scope.scopes,
        scopeError: scope.error,
      }
    },
    actions: {
      scan: async (body) => {
        const progress = await deps.service.ingest(bodyOf(body).force === true)
        return progress
      },
      reindex: async () => await deps.service.reindexVectors(),
      remove: async (body) => ({ removed: await deps.service.remove(idOf(body)) }),
      restore: async (body) => ({ restored: await deps.service.restore(idOf(body)) }),
      ingestUrl: async (body) => {
        if (!deps.ingestUrls()) throw new Error('URL 入库未启用（后台「知识库」页打开 kb.ingestUrls）')
        if (deps.ingestUrl === undefined) throw new Error('当前部署没有配置 URL 入库')
        const url = String(bodyOf(body).url ?? '').trim()
        if (url === '') throw new Error('缺少 url')
        return await deps.ingestUrl(url)
      },
      preview: async (body) => {
        const preview = deps.service.preview(idOf(body))
        if (preview === null) throw new Error('没有这份文档')
        return {
          document: summarize(preview.doc, preview.chunks.length),
          chunks: preview.chunks.map((chunk) => ({
            seq: chunk.seq + 1,
            heading: chunk.heading,
            line: chunk.line,
            page: chunk.page,
            text: chunk.text,
          })),
        }
      },
    },
  }
}
