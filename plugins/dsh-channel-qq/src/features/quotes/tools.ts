/** 语录工具面：存 / 随机复读 / 检索 / 统计 / 删除 五件套。
 *
 * 原来和 `QuoteStore` 一起住在 `src/quotes.ts`（一个文件装了类型 + 存储 + 工具面）。
 * P4.2 拆开：存储去 `store.ts`，这里只留工具面。spec 是**逐字节**搬过来的
 * ——工具名、描述、参数 schema 一个字符都不许变（`test/golden/tools/other-tools.txt`
 * 钉着这一点）。
 */

import { registerSpecs, params, type ToolHost, type ToolSpec } from '../../adapters/dsh-host/tools.js'
import type { QQChannelConfig } from '../../config.js'
import type { QQApi } from '../../ports/platform.js'
import type { OneBotMessageSegment } from '../../types.js'
import type { OutboundQueue } from '../../outbound.js'
import type { QuoteEntry, QuoteStore } from './store.js'

/** 这组工具要用到的依赖；`store` 由组合根加载好再传进来。 */
interface QuoteToolDeps {
  config: QQChannelConfig
  api: QQApi
  out: OutboundQueue
  store: QuoteStore
}

/** 语录库在配置里关闭时的统一回执。 */
function disabled(): { ok: boolean; note: string } {
  return { ok: false, note: '语录库已在配置里关闭' }
}

/** 「正文」——speaker 的形式；speaker 缺失时退化成QQ号，再缺就写匿名。 */
function renderQuote(entry: QuoteEntry): string {
  const speaker = entry.speaker.trim() !== ''
    ? entry.speaker.trim()
    : (entry.speakerId > 0 ? String(entry.speakerId) : '匿名')
  return `「${entry.text}」——${speaker}`
}

/** 解析投放目标；群默认落 primaryGroup，私聊没有默认值（必须显式给）。 */
function resolveTarget(config: QQChannelConfig, args: Record<string, unknown>): { isGroup: boolean; target: number } | null {
  const isGroup = args.isGroup !== false
  const raw = args.target
  if (raw === undefined || raw === null || raw === '') {
    if (!isGroup) return null
    return config.primaryGroup === null ? null : { isGroup: true, target: config.primaryGroup }
  }
  const target = Number(raw)
  if (!Number.isFinite(target) || target <= 0) return null
  return { isGroup, target }
}

/** `qq_save_quote` —— 往群语录库存一条金句/群梗。 */
function qqSaveQuote(deps: QuoteToolDeps): ToolSpec {
  const { config, store } = deps
  const defaultSpeakerId = config.admins[0] ?? 0
  const defaultGroupId = config.primaryGroup ?? 0
  return {
    name: 'qq_save_quote',
    description: '往群语录库存一条金句/群梗。群里谁说了句特别有意思的话（活人感、名场面、能复读的梗）就存下来，之后可以用 qq_random_quote / qq_search_quote 复读。text 必填，别存日常寒暄；speaker 写说话人昵称，tags 写 1-3 个便于检索的词。',
    parameters: params({
      text: { type: 'string', description: '语录正文，4-300 字，原话照抄不要改写' },
      speaker: { type: 'string', description: '说话人昵称' },
      speakerId: { type: 'number', description: '说话人QQ号，省略则用配置里的学弟' },
      groupId: { type: 'number', description: '来源群号，省略则用 primaryGroup' },
      tags: { type: 'array', items: { type: 'string' }, description: '检索标签，如 ["摸鱼","退网"]' },
      note: { type: 'string', description: '备注：当时什么场景' },
    }, ['text']),
    run: async (args) => {
      if (!config.quotes.enabled) return disabled()
      const entry = await store.add({
        text: String(args.text ?? ''),
        speaker: String(args.speaker ?? ''),
        speakerId: Number(args.speakerId ?? defaultSpeakerId),
        groupId: Number(args.groupId ?? defaultGroupId),
        tags: Array.isArray(args.tags) ? args.tags.map((t) => String(t)) : [],
        note: String(args.note ?? ''),
      })
      return { ok: true, quote: entry, total: store.stats().total }
    },
  }
}

/** `qq_random_quote` —— 随机复读一条群语录（可按 tag 过滤）。 */
function qqRandomQuote(deps: QuoteToolDeps): ToolSpec {
  const { config, api, out, store } = deps
  return {
    name: 'qq_random_quote',
    description: '随机复读一条群语录（可选按 tag 过滤），适合冷场、被@了不知道说啥、或者别人提起某个梗的时候。默认直接发到会话；只想看看有什么语录就 send=false。',
    parameters: params({
      tag: { type: 'string', description: '按标签过滤，如"摸鱼"' },
      isGroup: { type: 'boolean', description: '是否群聊（默认 true）' },
      target: { type: 'number', description: '群号或好友QQ号；省略则用 primaryGroup' },
      send: { type: 'boolean', description: 'false = 只返回语录不发送（默认 true）' },
    }),
    run: async (args) => {
      if (!config.quotes.enabled) return disabled()
      const entry = store.random(typeof args.tag === 'string' ? args.tag : undefined)
      if (entry === null) return { ok: false, note: '语录库还是空的（或该标签下没有语录）。先用 qq_save_quote 存几条。' }
      if (args.send === false) return { ok: true, quote: entry }
      const dest = resolveTarget(config, args)
      if (dest === null) return { ok: false, note: '需要 isGroup + target（群号/QQ号），或在配置里设置 primaryGroup' }
      const text = renderQuote(entry)
      const message: OneBotMessageSegment[] = [{ type: 'text', data: { text } }]
      await out.push(() => api.sendTo(dest.isGroup, dest.target, message))
      await store.touch(entry.id)
      return { ok: true, sent: text, quote: entry }
    },
  }
}

/** `qq_search_quote` —— 按关键词检索群语录库。 */
function qqSearchQuote(deps: QuoteToolDeps): ToolSpec {
  const { config, store } = deps
  return {
    name: 'qq_search_quote',
    description: '按关键词检索群语录库。别人提到某个话题/某个人时，先搜一下有没有对应的老梗可以复读。搜 text/tags/speaker 三个字段。',
    parameters: params({
      query: { type: 'string', description: '关键词，如"退网"或"张三"' },
      limit: { type: 'number', description: '返回条数，默认 5' },
    }, ['query']),
    run: (args) => {
      if (!config.quotes.enabled) return disabled()
      const query = String(args.query ?? '').trim()
      if (query === '') throw new Error('query 不能为空：先想清楚要搜哪个词（梗的关键词、说话人昵称、标签都行）。')
      const wanted = Number(args.limit)
      const limit = Number.isFinite(wanted) && wanted > 0 ? wanted : 5
      const quotes = store.search(query, limit)
      return { count: quotes.length, quotes }
    },
  }
}

/** `qq_quote_stats` —— 看语录库规模：总数、最常见的标签、贡献者。 */
function qqQuoteStats(deps: QuoteToolDeps): ToolSpec {
  const { config, store } = deps
  return {
    name: 'qq_quote_stats',
    description: '看群语录库的规模：总数、最常见的标签、贡献语录最多的人。想复读但不知道有什么梗时先看这个。',
    parameters: params({}),
    run: () => {
      if (!config.quotes.enabled) return disabled()
      return store.stats()
    },
  }
}

/** `qq_delete_quote` —— 由 id 删掉一条语录。 */
function qqDeleteQuote(deps: QuoteToolDeps): ToolSpec {
  const { config, store } = deps
  return {
    name: 'qq_delete_quote',
    description: '删掉一条语录（id 来自 qq_search_quote / qq_random_quote 的返回）。删错内容、存重了、或者当事人要求删时用。',
    parameters: params({
      id: { type: 'string', description: '语录 id，形如 q_xxxx' },
    }, ['id']),
    run: async (args) => {
      if (!config.quotes.enabled) return disabled()
      const id = String(args.id ?? '').trim()
      if (id === '') throw new Error('id 不能为空：先用 qq_search_quote 找到要删的那条。')
      const removed = await store.remove(id)
      return { ok: removed, note: removed ? '已删除' : `没找到 id=${id} 的语录` }
    },
  }
}

/**
 * 注册语录工具。
 *
 * 接线：`registerQuoteTools(ctx, config, api, out, log, store)`，返回的 disposer
 * 交给 cordis 的 effect/cleanup 即可（和 `registerLinkTools` 一样，一行调用）。
 */
export function registerQuoteTools(
  ctx: ToolHost,
  config: QQChannelConfig,
  api: QQApi,
  out: OutboundQueue,
  log: (line: string) => void,
  store: QuoteStore,
): () => void {
  const deps: QuoteToolDeps = { config, api, out, store }
  const specs: ToolSpec[] = [
    qqSaveQuote(deps),
    qqRandomQuote(deps),
    qqSearchQuote(deps),
    qqQuoteStats(deps),
    qqDeleteQuote(deps),
  ]
  return registerSpecs(ctx, specs, log, 'quotes')
}
