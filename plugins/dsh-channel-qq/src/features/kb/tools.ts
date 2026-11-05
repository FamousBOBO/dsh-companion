/** `qq_kb_search`：知识库的唯一工具面（只读）。
 *
 * 为什么不叫 `retrieve_knowledge`：那个是**记忆**（从聊天里沉淀的一句话事实）；
 * 知识库是**用户给的原文**。两个名字分开，模型才不会把"资料原文"当成"我记得"。
 *
 * 房间范围由 `exec.agent.id` 现算（`qq-group-123` → `group-123`），与技能的
 * 可见范围同一套房间键。
 */

import type { ToolSpec, ToolRunContext } from '../../adapters/dsh-host/tools.js'
import { roomOfSession } from '../../core/kb/score.js'
import { hitToResult, type KbService } from './service.js'

/** 一次最多返回几块（再多就是往上下文里灌整篇文档）。 */
const MAX_LIMIT = 10

export function qqKbSearch(service: KbService): ToolSpec {
  return {
    name: 'qq_kb_search',
    description: '【知识库】搜索主人给过的资料与文档（工作区 inbox / downloads / kb 里的 md、txt、PDF 等），'
      + '返回带出处的原文片段。回答"资料里怎么写的""那份文档提到什么"之前先搜这里；'
      + '不传 query 则列出资料目录。引用时带上返回的 citation。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '自然语言查询；留空 = 列出当前可用的资料目录' },
        limit: { type: 'number', description: `最多几块（默认 5，上限 ${MAX_LIMIT}）` },
        collection: { type: 'string', description: '只在某个集合里搜（目录名，如 inbox / downloads）' },
      },
      required: [],
    },
    run: async (args, context: ToolRunContext | undefined) => {
      const room = roomOfSession(context?.agentId)
      const query = String(args.query ?? '').trim()
      if (query === '') return catalogResult(service, room)
      const limit = Math.max(1, Math.min(MAX_LIMIT, Math.trunc(Number(args.limit ?? 5)) || 5))
      const collection = String(args.collection ?? '').trim()
      const hits = await service.search(query, room, limit, collection === '' ? undefined : collection)
      if (hits.length === 0) {
        return { count: 0, query, note: '知识库里没有相关片段。别编；直说资料里没找到，或换个说法再搜。' }
      }
      return { count: hits.length, query, results: hits.map((hit) => hitToResult(hit)) }
    },
  }
}

/** 目录：告诉模型"这里有什么"，避免它对着空气反复搜。 */
function catalogResult(service: KbService, room: string | null): Record<string, unknown> {
  const catalog = service.catalog(room)
  const total = catalog.documents.length
  return {
    count: total,
    collections: catalog.collections,
    documents: catalog.documents,
    note: total === 0
      ? '知识库还是空的：主人可以把资料放进工作区的 inbox/ 或 downloads/，后台「知识库」页可以立即扫描。'
      : '用 query 搜索具体内容；collection 可以把范围限定到某个目录。',
  }
}
