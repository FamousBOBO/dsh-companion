/** RSS/Atom 订阅工具：加 / 列 / 删 / 预览，4 个。
 *
 * 抓取与解析、轮询推送在 `./feed.ts`（`fetchFeed` / `RssPoller`）；这里只有工具面。
 *
 * 所有订阅变更都就地改 `config.rss.feeds`（`push` / `splice`），不重新赋值。
 * 主控的管理后台和 RssPoller 共享同一个 config 对象引用——重新赋值会让后台看到
 * 旧数组、调度器看不到新订阅，两边打架。
 *
 * 这些 spec **逐字节**来自原来的 `src/rss.ts`——P4 的判据是工具名与
 * 参数 schema 一条都不许变（`test/golden/tools/other-tools.txt` 钉着这一点）。
 */

import { registerSpecs, params, shortId, type ToolHost, type ToolSpec } from '../../adapters/dsh-host/tools.js'
import type { QQChannelConfig, RssFeedConfig } from '../../config.js'
import type { ChatPlatform } from '../../ports/platform.js'
import type { OutboundQueue } from '../../outbound.js'
import { fetchFeed } from './feed.js'

/** 把 config/参数里的 group 号收敛成一个可用的数字。 */
function resolveGroup(raw: unknown, config: QQChannelConfig): number {
  const direct = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10)
  if (Number.isFinite(direct) && direct > 0) return direct
  if (config.primaryGroup !== null) return config.primaryGroup
  throw new Error('没有指定群号，配置里也没有 primaryGroup。请在参数里给 target（群号）。')
}
function requireFeedConfig(config: QQChannelConfig): RssFeedConfig[] {
  const rss = config.rss
  if (rss === undefined || rss === null) throw new Error('配置里缺少 rss 段，先让主控补上再订阅。')
  if (!Array.isArray(rss.feeds)) rss.feeds = []
  return rss.feeds
}

function asFeedRecord(feed: RssFeedConfig): Record<string, unknown> {
  return {
    id: feed.id,
    title: feed.title,
    url: feed.url,
    room: feed.room,
    target: feed.target,
    enabled: feed.enabled,
    lastGuid: feed.lastGuid,
  }
}

/** `qq_rss_add` — 订阅一个 RSS/Atom 源。先真实拉一次验证，拉不通不写配置。 */
function rssAddSpec(config: QQChannelConfig, log: (line: string) => void): ToolSpec {
  const disabled = (): Record<string, unknown> | null => (
    config.rss?.enabled === false ? { ok: false, note: 'RSS 订阅已在配置里关闭（config.rss.enabled=false）' } : null
  )
  return {
    name: 'qq_rss_add',
    description: '订阅一个 RSS/Atom 源，之后有新内容会自动推到这个群。什么时候用：学弟说"订阅这个博客/看这个站更新/跟踪这个 feed"时。会先真的拉一次验证地址可用，拉不通就不写进配置，所以不用担心写坏配置。',
    parameters: params({
      url: { type: 'string', description: 'RSS/Atom 地址（http/https，通常以 /feed、/rss.xml、/atom.xml 结尾）' },
      isGroup: { type: 'boolean', description: '推送到群聊还是私聊，默认群聊' },
      target: { type: 'number', description: '群号或好友QQ号，省略时用配置里的主群' },
    }, ['url']),
    run: async (args) => {
      const off = disabled()
      if (off !== null) return off
      const url = String(args.url ?? '').trim()
      if (!/^https?:\/\//i.test(url)) throw new Error(`RSS 地址不合法："${url}"，必须是 http/https 开头的完整地址。`)
      const isGroup = args.isGroup !== false
      const target = resolveGroup(args.target, config)
      // 先拉一次：地址死了/不是 feed 就当场失败，绝不往配置里塞垃圾订阅。
      const fetched = await fetchFeed(url, log)
      if (fetched.items.length === 0) throw new Error(`这个地址能打开但解析不到任何条目（可能不是 RSS/Atom，或 feed 为空）：${url}`)
      const feeds = requireFeedConfig(config)
      const title = fetched.title !== '' ? fetched.title : url
      const feed: RssFeedConfig = {
        id: shortId('rss'),
        url,
        room: isGroup ? 'group' : 'dm',
        target,
        enabled: true,
        // 关键：以"当前最新一条"为水位线，否则订阅瞬间会把历史文章全部刷进群。
        lastGuid: fetched.items[0]?.guid ?? null,
        title,
      }
      feeds.push(feed)
      log(`rss: subscribed ${feed.id} ${title} → ${feed.room} ${target}`)
      return { ok: true, feed: asFeedRecord(feed) }
    },
  }
}

/** `qq_rss_list` — 列出所有 RSS/Atom 订阅。 */
function rssListSpec(config: QQChannelConfig): ToolSpec {
  return {
    name: 'qq_rss_list',
    description: '列出当前所有 RSS/Atom 订阅（谁、推到哪、开没开）。',
    parameters: params({}),
    run: async () => {
      const feeds = requireFeedConfig(config)
      return { count: feeds.length, feeds: feeds.map(asFeedRecord) }
    },
  }
}

/** `qq_rss_remove` — 按 id 取消订阅。 */
function rssRemoveSpec(config: QQChannelConfig, log: (line: string) => void): ToolSpec {
  return {
    name: 'qq_rss_remove',
    description: '按 id 取消一个 RSS/Atom 订阅。id 从 qq_rss_list 里拿。',
    parameters: params({ id: { type: 'string', description: '订阅 id，如 rss_xxx' } }, ['id']),
    run: async (args) => {
      const id = String(args.id ?? '').trim()
      if (id === '') throw new Error('id 不能为空，先用 qq_rss_list 查订阅 id。')
      const feeds = requireFeedConfig(config)
      const index = feeds.findIndex((feed) => feed.id === id)
      if (index < 0) throw new Error(`没有 id 为 ${id} 的订阅，先用 qq_rss_list 看看现有订阅。`)
      // splice 就地删除，保持主控后台持有的同一个数组引用有效。
      const [removed] = feeds.splice(index, 1)
      log(`rss: removed ${id}`)
      return { ok: true, removed: removed === undefined ? null : asFeedRecord(removed) }
    },
  }
}

/** `qq_rss_preview` — 预览地址最新 5 条，不写订阅。 */
function rssPreviewSpec(log: (line: string) => void): ToolSpec {
  return {
    name: 'qq_rss_preview',
    description: '只预览一个 RSS/Atom 地址的最新 5 条，不写进订阅。什么时候用：学弟丢来一个地址问"这个能订吗/有什么内容"时，先预览确认内容合适再 qq_rss_add。',
    parameters: params({ url: { type: 'string', description: 'RSS/Atom 地址' } }, ['url']),
    run: async (args) => {
      const url = String(args.url ?? '').trim()
      if (!/^https?:\/\//i.test(url)) throw new Error(`RSS 地址不合法："${url}"，必须是 http/https 开头的完整地址。`)
      const fetched = await fetchFeed(url, log)
      const items = fetched.items.slice(0, 5).map((item) => ({
        title: item.title,
        link: item.link,
        summary: item.summary,
        published: item.published,
        date: item.published === null ? null : new Date(item.published).toISOString(),
      }))
      return { title: fetched.title, count: items.length, items }
    },
  }
}

/** 注册 RSS 订阅管理工具。返回 disposer（交给 index.ts 在卸载时调用）。 */
export function registerRssTools(
  ctx: ToolHost,
  config: QQChannelConfig,
  platform: ChatPlatform,
  out: OutboundQueue,
  log: (line: string) => void,
): () => void {
  // client 由 RssPoller 使用（轮询自己发消息）；这里保留签名一致性，也顺手打一条自检日志。
  log(`rss: tools loaded (client ${platform.isConnected() ? 'connected' : 'not connected yet'})`)

  const specs: ToolSpec[] = [
    rssAddSpec(config, log),
    rssListSpec(config),
    rssRemoveSpec(config, log),
    rssPreviewSpec(log),
  ]
  return registerSpecs(ctx, specs, log, 'rss')
}
