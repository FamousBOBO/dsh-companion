/** 订阅子插件（P5.1）：RSS/Atom 轮询器 + 工具面 + 后台资源 + 投递。
 *
 * 轮询器每轮重新读 `config.rss.feeds`，`pollIntervalMin` 也在 tick 时重读，
 * 所以订阅与节奏的后台改动下一轮即生效（这是原实现的"假热更新"正确的那一半，
 * 保留原样）。卡片排版与原 `deliverFeedItem` 一字未改。
 */

import { RssPoller, type FeedItem } from './feed.js'
import { registerRssTools } from './tools.js'
import type { RssFeedConfig } from '../../config.js'
import type { OneBotMessageSegment } from '../../types.js'
import type { SubHost, SubPlugin } from '../plugin-kit.js'

async function deliver(host: SubHost, item: FeedItem, feed: RssFeedConfig): Promise<void> {
  const parts = host.get('platform')
  if (parts === undefined) return
  const { api, out } = parts
  const lines = [`📰 ${feed.title !== '' ? feed.title : feed.url}`, item.title]
  if (item.link !== '') lines.push(item.link)
  if (item.summary !== '') lines.push(item.summary.slice(0, 160))
  const message: OneBotMessageSegment[] = [{ type: 'text', data: { text: lines.join('\n') } }]
  await out.push(() => api.sendTo(feed.room === 'group', feed.target, message))
  host.log(`rss pushed to ${feed.room}-${feed.target}: ${item.title.slice(0, 50)}`)
}

export const rssPlugin: SubPlugin = {
  name: 'rss',
  watches: [],
  requires: ['platform'],
  apply(host) {
    const poller = new RssPoller(host.config, async (item, feed) => { await deliver(host, item, feed) }, host.log)
    poller.start()
    host.registerResource('rss', {
      label: '订阅源',
      list: () => ({ count: host.config.rss.feeds.length, feeds: host.config.rss.feeds }),
      create: async (body) => {
        const url = String(body.url ?? '').trim()
        if (url === '') throw new Error('url 不能为空')
        const feed: RssFeedConfig = {
          id: `rss_${Date.now().toString(36)}`,
          url,
          room: body.isGroup === false ? 'dm' : 'group',
          target: Number(body.target ?? host.config.primaryGroup ?? host.config.admins[0] ?? 0),
          enabled: true,
          lastGuid: null,
          title: String(body.title ?? url),
        }
        // In place: the poller and the config file share this array.
        host.config.rss.feeds.push(feed)
        return feed
      },
      remove: async (id) => {
        const index = host.config.rss.feeds.findIndex((f) => f.id === id)
        if (index < 0) return { removed: false }
        host.config.rss.feeds.splice(index, 1)
        return { removed: true }
      },
    })
    const { platform, out } = host.need('platform')
    const disposeTools = registerRssTools(host.bridge.toolHost(), host.config, platform, out, host.log)
    return () => {
      disposeTools()
      poller.dispose()
    }
  },
}
