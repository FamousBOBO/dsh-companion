/** 记忆与知识库：4 个工具。
 *
 * 记忆的写入与主动召回。
 *
 * 这些 spec **逐字节**来自原来的 `registerQQTools`——P4 的判据是工具名与
 * 参数 schema 一条都不许变（`test/golden/tools/qq-tools.txt` 钉着这一点）。
 * 一个工具一个函数：单看一个工具时不必在 1200 行里找它的边界。
 */

import type { ToolSpec } from '../../adapters/dsh-host/tools.js'
import type { QQToolDeps } from '../tool-deps.js'

/** `retrieve_knowledge` — 检索咱的长期知识库（从日记和群聊沉淀的技能/事实/偏好/事件/人物）。回答不确定的问题前先搜这里。… */
function retrieveKnowledge(deps: QQToolDeps): ToolSpec {
  const { knowledge } = deps
  return {
        name: 'retrieve_knowledge',
        description: '检索咱的长期知识库（从日记和群聊沉淀的技能/事实/偏好/事件/人物）。回答不确定的问题前先搜这里。',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: '自然语言查询' } },
          required: ['query'],
        },
        run: async (args) => {
          if (!knowledge) return { note: '知识库未启用' }
          const hits = knowledge.search(String(args.query ?? ''), 5)
          for (const h of hits) { void knowledge.reinforce(h.id).catch(() => {}) }
          return { count: hits.length, results: hits.map(e => ({ type: e.type, content: e.content, tags: e.tags, source: e.source, date: new Date(e.created).toISOString().slice(0, 10) })) }
        },
      }
}

/** `extract_knowledge` — 从一段文字（日记/聊天记录/文档）提取知识条目入库。别对日常寒暄用。… */
function extractKnowledge(deps: QQToolDeps): ToolSpec {
  const {  } = deps
  const extractFn = deps.extract
  return {
        name: 'extract_knowledge',
        description: '从一段文字（日记/聊天记录/文档）提取知识条目入库。别对日常寒暄用。',
        parameters: {
          type: 'object',
          properties: {
            source: { type: 'string', description: '来源简述（如：日记 2026-09-21）' },
            text: { type: 'string', description: '要提取的文字（截取有价值的部分）' },
          },
          required: ['source', 'text'],
        },
        run: async (args) => {
          if (!extractFn) return { note: '提取器未启用' }
          return extractFn(String(args.source ?? ''), String(args.text ?? ''))
        },
      }
}

/** `qq_recall_memory` — 【主动召回记忆】回答"上次那个…""你还记得…"之前先搜这里。比 retrieve_knowledge 多了类型过滤，命… *
 *
 * `memory.v2` 打开时走结构化记忆（带出处与成立时间、命中会强化遗忘曲线）；关着时
 * 走原来的知识库。**返回形状保持一致**——多出来的字段是加在既有字段旁，不是换掉。
 */
function qqRecallMemory(deps: QQToolDeps): ToolSpec {
  const { out, knowledge, memory } = deps
  return {
        name: 'qq_recall_memory',
        description: '【主动召回记忆】回答"上次那个…""你还记得…"之前先搜这里。比 retrieve_knowledge 多了类型过滤，命中的条目会被强化（以后更容易想起来）。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '自然语言查询' },
            type: { type: 'string', description: '只看某类记忆：skill / fact / preference / event / person（可选）' },
            limit: { type: 'number', description: '最多几条（默认5，上限20）' },
            reinforce: { type: 'boolean', description: '是否强化命中条目（默认 true）' },
          },
          required: ['query'],
        },
        run: async (args) => {
          const query = String(args.query ?? '').trim()
          if (query === '') throw new Error('query 不能为空，说清楚你要回忆什么。')
          const wantType = args.type === undefined ? null : String(args.type)
          const limit = Math.min(Math.max(Number(args.limit ?? 5), 1), 20)
          if (memory !== undefined) return await recallFromMemory(memory, query, wantType, limit)
          if (knowledge === undefined) return { ok: false, note: '知识库未启用' }
          return await recallFromLegacy(knowledge, query, wantType, limit, args.reinforce !== false)
        },
      }
}

/** v2 分支：结构化记忆召回（带出处与成立时间）。 */
async function recallFromMemory(
  memory: NonNullable<QQToolDeps['memory']>,
  query: string,
  wantType: string | null,
  limit: number,
): Promise<Record<string, unknown>> {
  const hits = await memory.recall({ query, kind: wantType ?? undefined, limit })
  return {
    count: hits.length,
    query,
    ...(hits.length === 0 ? { note: '记忆里没有相关的，别硬编，直说想不起来。' } : {}),
    memories: hits.map((h) => ({
      id: h.id, type: h.kind, content: h.content, tags: h.tags,
      source: h.source, hits: h.hits, date: h.date,
    })),
  }
}

/** 老分支：知识库关键词召回（`memory.v2` 关着时的原样行为）。 */
async function recallFromLegacy(
  knowledge: NonNullable<QQToolDeps['knowledge']>,
  query: string,
  wantType: string | null,
  limit: number,
  reinforce: boolean,
): Promise<Record<string, unknown>> {
  // search() scores the whole store, so a type filter over-fetches and trims —
  // otherwise "the one person entry" can be crowded out by higher-scoring facts
  // before the filter ever runs.
  const hits = knowledge.search(query, wantType === null ? limit : limit * 4)
  const picked = (wantType === null ? hits : hits.filter((h) => h.type === wantType)).slice(0, limit)
  if (reinforce) {
    for (const h of picked) void knowledge.reinforce(h.id).catch(() => {})
  }
  return {
    count: picked.length,
    query,
    ...(picked.length === 0 ? { note: '记忆里没有相关的，别硬编，直说想不起来。' } : {}),
    memories: picked.map((e) => ({
      id: e.id, type: e.type, content: e.content, tags: e.tags, source: e.source,
      weight: e.weight, hits: e.hits, date: new Date(e.created).toISOString().slice(0, 10),
    })),
  }
}

/** `qq_memorize_fact` — 【主动记下来】遇到"以后还要用"的事实/偏好/技能/人物/事件时直接写进长期记忆，不必等日记提取。日常寒暄不要用。… */
function qqMemorizeFact(deps: QQToolDeps): ToolSpec {
  const { knowledge, memory } = deps
  return {
        name: 'qq_memorize_fact',
        description: '【主动记下来】遇到"以后还要用"的事实/偏好/技能/人物/事件时直接写进长期记忆，不必等日记提取。日常寒暄不要用。',
        parameters: {
          type: 'object',
          properties: {
            content: { type: 'string', description: '一句话知识，写清楚人和事' },
            type: { type: 'string', description: 'skill / fact / preference / event / person（默认 fact）' },
            tags: { type: 'array', description: '标签数组，便于以后检索', items: { type: 'string' } },
            source: { type: 'string', description: '来源简述，如"群聊 2026-10-14"' },
          },
          required: ['content'],
        },
        run: async (args) => {
          const content = String(args.content ?? '').trim()
          if (content.length < 4) throw new Error('内容太短，至少 4 个字，把人和事说清楚。')
          if (memory !== undefined) {
            const written = await memory.memorize({
              content,
              kind: String(args.type ?? 'fact'),
              tags: Array.isArray(args.tags) ? args.tags.map((t) => String(t)) : [],
              source: String(args.source ?? 'memory'),
            })
            return {
              ok: true,
              added: written.created ? 1 : 0,
              total: written.total,
              note: written.created ? '记住了。' : '这条已经记过了。',
            }
          }
          if (knowledge === undefined) return { ok: false, note: '知识库未启用' }
          const added = await knowledge.addMany([{
            type: String(args.type ?? 'fact') as 'skill' | 'fact' | 'preference' | 'event' | 'person',
            content,
            tags: Array.isArray(args.tags) ? args.tags.map((t) => String(t)) : [],
            source: String(args.source ?? 'memory'),
          }])
          return { ok: true, added, total: knowledge.entries.length, note: added === 0 ? '这条已经记过了。' : '记住了。' }
        },
      }
}

/** `qq_memory_search` — 深召回：在日记/知识库的**原文块**里搜，带出处。 */
function qqMemorySearch(deps: QQToolDeps): ToolSpec {
  const search = deps.memorySearch
  return {
    name: 'qq_memory_search',
    description: '深召回：在日记与知识库的原文块里搜（返回文件与行号），一次 5–8 条。问"以前记过什么""上次怎么弄的""翻翻笔记"时用它；日常寒暄不要用。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '自然语言查询' },
        limit: { type: 'number', description: '返回条数（默认 8，最多 8）' },
        asOf: { type: 'string', description: '可选，时间旅行：只要某天（YYYY-MM-DD）之前已知道的记忆，如"上周二我们怎么想的"' },
      },
      required: ['query'],
    },
    run: async (args) => {
      if (search === undefined) return { note: '深召回未启用（需要 memory.v2 与块索引）' }
      const asOfRaw = args.asOf === undefined ? undefined : String(args.asOf)
      const hits = await search(String(args.query ?? ''), Number(args.limit ?? 8), asOfRaw)
      return { count: hits.length, results: hits.map((h) => ({ content: h.content, source: h.source, date: h.date, chunk: h.chunk })) }
    },
  }
}

/** 组装这一组工具。 */
export function memoryTools(deps: QQToolDeps): ToolSpec[] {
  return [
    retrieveKnowledge(deps),
    extractKnowledge(deps),
    qqRecallMemory(deps),
    qqMemorizeFact(deps),
    qqMemorySearch(deps),
  ]
}
