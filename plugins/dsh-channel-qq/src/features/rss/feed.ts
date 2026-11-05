/** RSS/Atom 订阅推送的抓取、解析与轮询面（P1-4）。
 *
 * 低成本给群扩充内容源：一个 URL 就能接一个媒体/博客/公告板，不需要任何 API key。
 *
 * 刻意的设计选择：**不引入 XML 解析库**。RSS 2.0 / Atom 的骨架极其规整（`<item>` /
 * `<entry>` 里就是少量的已知标签），为了两个语法就拉一个依赖进来，得不偿失；正则够用，
 * 而且遇到畸形 feed 时降级行为可控（解析不到就报错，而不是抛栈）。
 *
 * 工具面在 `./tools.ts`。订阅变更与 `feed.lastGuid` 一律**就地改**——轮询器、订阅
 * 工具与管理后台共享同一个 config 对象引用，重新赋值会让两边看到不同的数组。
 */

import { createHash } from 'node:crypto'
import type { QQChannelConfig, RssFeedConfig } from '../../config.js'
import { systemHttp } from '../../adapters/http/client.js'

/** 一条 feed 里的单条内容。 */
export interface FeedItem {
  guid: string
  title: string
  link: string
  summary: string
  /** Unix 毫秒；解析不到时间就是 null（有些 feed 根本不写 pubDate）。 */
  published: number | null
}

/** 单次轮询最多解析多少条，防止某些巨型 feed（几百上千条）把事件循环卡住。 */
const MAX_PARSE_ITEMS = 50
/** 摘要截断长度，够模型判断"这条值不值得展开"就行。 */
const SUMMARY_LIMIT = 300
/** 响应体上限：超过 2MB 的 feed 基本是异常产物，直接截断省内存。 */
const MAX_BODY_CHARS = 2_000_000

/** 剥掉 CDATA 包裹，保留内层原文。 */
function stripCdata(value: string): string {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
}

/** 解 HTML 实体：命名实体 + 十进制/十六进制数字实体。 */
function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    switch (entity.toLowerCase()) {
      case 'amp': return '&'
      case 'lt': return '<'
      case 'gt': return '>'
      case 'quot': return '"'
      case 'apos': return "'"
      case 'nbsp': return ' '
      default: return match
    }
  })
}

/** 清掉标签、解实体、压平空白。 */
function cleanText(value: string): string {
  return decodeEntities(stripCdata(value).replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

/** 摘要额外做截断，超长文本灌给模型只是浪费 token。 */
function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`
}

/** 取 `<tag>` 的文本内容（不含属性处理）。 */
function tagText(block: string, tag: string): string {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i').exec(block)
  return match === null ? '' : cleanText(match[1] ?? '')
}

/** 取 `<tag attr="...">` 里的属性值；Atom 的 `<link href>` 就是这样。 */
function tagAttr(block: string, tag: string, attr: string): string {
  const match = new RegExp(`<${tag}\\b([^>]*)>`, 'i').exec(block)
  if (match === null) return ''
  const attrMatch = new RegExp(`${attr}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(match[1] ?? '')
  if (attrMatch === null) return ''
  return cleanText(attrMatch[2] ?? attrMatch[3] ?? '')
}

/**
 * Atom 的链接：优先 `rel="alternate"`（正文页），退而求其次取第一个 `<link href>`。
 * 少了这层偏好，很多站点会把 feed 自身的 self link 回给你，点进去是 XML。
 */
function atomLink(block: string): string {
  const links = /<link\b[^>]*>/gi
  let first = ''
  let match: RegExpExecArray | null
  while ((match = links.exec(block)) !== null) {
    const tag = match[0]
    const href = tagAttr(tag, 'link', 'href')
    if (href === '') continue
    if (first === '') first = href
    const rel = tagAttr(tag, 'link', 'rel')
    if (rel === '' || rel === 'alternate') return href
  }
  return first
}

/** `published` 解析：Atom 用 updated/published，RSS 用 pubDate；解析不了给 null。 */
function parseDate(block: string): number | null {
  for (const tag of ['updated', 'published', 'pubDate']) {
    const raw = tagText(block, tag)
    if (raw === '') continue
    const parsed = Date.parse(raw)
    if (!Number.isNaN(parsed)) return parsed
  }
  return null
}

/** 兜底 guid：feed 既没 guid/id 也没 link 时，只能按内容哈希去重。 */
function hashGuid(title: string, published: number | null): string {
  return createHash('sha1').update(`${title}|${published ?? ''}`).digest('hex').slice(0, 16)
}

/** 把一个 `<item>`/`<entry>` 块规范化成 FeedItem。 */
function toFeedItem(block: string, isAtom: boolean): FeedItem {
  const title = tagText(block, 'title')
  const link = isAtom ? atomLink(block) : tagText(block, 'link')
  const published = parseDate(block)
  const summarySource = isAtom
    ? (tagText(block, 'summary') || tagText(block, 'content'))
    : (tagText(block, 'description') || tagText(block, 'content:encoded'))
  const rawGuid = isAtom ? (tagText(block, 'id') || link) : (tagText(block, 'guid') || link)
  return {
    guid: rawGuid !== '' ? rawGuid : hashGuid(title, published),
    title: title !== '' ? title : '(无标题)',
    link,
    summary: truncate(summarySource, SUMMARY_LIMIT),
    published,
  }
}

/** 解析 feed 文本为标题 + 条目列表。先试 Atom，再试 RSS（两者互斥，顺序无所谓）。 */
function parseFeed(text: string): { title: string; items: FeedItem[] } {
  const body = text.length > MAX_BODY_CHARS ? text.slice(0, MAX_BODY_CHARS) : text
  const feedTitle = tagText(body, 'title')

  for (const [tag, isAtom] of [['entry', true], ['item', false]] as const) {
    const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi')
    const items: FeedItem[] = []
    let match: RegExpExecArray | null
    // 边匹配边截断：避免先把几千条全收集进数组再丢弃。
    while ((match = pattern.exec(body)) !== null && items.length < MAX_PARSE_ITEMS) {
      items.push(toFeedItem(match[1] ?? '', isAtom))
    }
    if (items.length > 0) return { title: feedTitle, items }
  }
  return { title: feedTitle, items: [] }
}

/**
 * 拉取并解析一个 RSS/Atom feed。
 *
 * @throws 中文 Error —— 网络失败、HTTP 非 2xx、URL 非法都给出下一步提示，
 *         因为调用方是模型，错误消息就是它的行动指南。
 */
export async function fetchFeed(url: string, log?: (l: string) => void): Promise<{ title: string; items: FeedItem[] }> {
  let response
  try {
    // 订阅地址可以由模型通过工具写进配置，所以**不能**放行私网：
    // 否则"加一个 RSS"就成了对内网发请求的开关。
    response = await systemHttp.request(url, {
      headers: { 'User-Agent': 'dsh-channel-qq/1.0', Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
      timeoutMs: 15_000,
      limit: 1024 * 1024,
    })
  } catch (error) {
    throw new Error(`RSS 拉取失败：${error instanceof Error ? error.message : String(error)}（检查地址是否可达，或稍后重试）：${url}`)
  }
  if (!response.ok) {
    throw new Error(`RSS 拉取失败 HTTP ${response.status}：${url}`)
  }
  const text = response.text()
  const parsed = parseFeed(text)
  log?.(`rss: ${url} → ${parsed.items.length} item(s), title=${parsed.title || '(无)'}`)
  return parsed
}

// ───────────────────────── 轮询调度 ─────────────────────────

/** 首次轮询延迟：启动瞬间几十个 feed 一起打出去会顶到出口限流，也容易被站点风控。 */
const FIRST_POLL_DELAY_MS = 20_000

/**
 * 定时把新条目推给会话。
 *
 * 每轮都重新读 `config.rss.feeds`（而不是构造时拍快照），这样管理后台刚加的
 * 订阅下一轮就生效，不必重启进程。
 */
export class RssPoller {
  private timer: ReturnType<typeof setInterval> | null = null
  /** When the last full poll ran; drives the configurable cadence. */
  private lastPollAt = 0
  /**
   * Sit at a fixed 30s tick and decide whether the configured interval has
   * elapsed, instead of a `setInterval(pollIntervalMin)` fixed at startup.
   * `rss.pollIntervalMin` is hot-editable in the admin panel, and a
   * pre-computed timer would silently keep the old cadence until a restart.
   */
  private static readonly TICK_MS = 30_000
  private running = false

  constructor(
    private readonly config: QQChannelConfig,
    private readonly send: (item: FeedItem, feed: RssFeedConfig) => Promise<void>,
    private readonly log: (l: string) => void,
  ) {}

  start(): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => { void this.tick(false) }, RssPoller.TICK_MS)
    this.timer.unref?.()
    // First poll after a short delay, so boot is not a burst of feed requests.
    const first = setTimeout(() => { void this.tick(true) }, FIRST_POLL_DELAY_MS)
    first.unref?.()
    this.log(`rss: poller armed (every ${this.intervalMinutes()}min, first poll in ${FIRST_POLL_DELAY_MS / 1000}s)`)
  }

  /** Configured poll cadence in minutes, with a sane fallback. */
  private intervalMinutes(): number {
    const minutes = Number(this.config.rss?.pollIntervalMin ?? 15)
    return Number.isFinite(minutes) && minutes > 0 ? minutes : 15
  }

  /**
   * One tick: poll only when the configured interval has elapsed (or forced).
   * The interval is re-read here every time, so a change from the panel takes
   * effect on the next tick instead of at the next restart.
   */
  private async tick(force: boolean): Promise<void> {
    const intervalMs = Math.max(60_000, this.intervalMinutes() * 60_000)
    if (!force && Date.now() - this.lastPollAt < intervalMs) return
    this.lastPollAt = Date.now()
    await this.pollAll()
  }

  dispose(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private async pollAll(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      if (this.config.rss?.enabled === false) return
      const feeds = Array.isArray(this.config.rss?.feeds) ? this.config.rss.feeds : []
      // 重新读取每一轮：后台新加的订阅立刻被看到。
      for (const feed of feeds) {
        if (!feed.enabled) continue
        try {
          await this.pollOne(feed)
        } catch (error) {
          // 单个 feed 挂了不能影响其它 feed：只记日志。
          this.log(`rss: feed ${feed.id} (${feed.url}) poll failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    } finally {
      this.running = false
    }
  }

  private async pollOne(feed: RssFeedConfig): Promise<void> {
    const fetched = await fetchFeed(feed.url, this.log)
    if (fetched.title !== '' && feed.title !== fetched.title) feed.title = fetched.title // 就地改字段，后台看到的是同一个对象
    const items = fetched.items
    if (items.length === 0) return

    // **不能假设 feed 一定按新→旧排列**：升序 feed（按发布时间从旧到新）在旧逻辑下
    // 会把水位线定在"最老的一条"，于是新条目永远进不了 fresh、历史条目每轮重推
    // （2026-10-19 排查）。用发布日期判方向，两条分支各自取"水位线之后"的那一段。
    const firstDate = items[0]?.published ?? null
    const lastDate = items[items.length - 1]?.published ?? null
    const descending = firstDate === null || lastDate === null ? true : firstDate >= lastDate
    const boundary = feed.lastGuid === null ? -1 : items.findIndex((item) => item.guid === feed.lastGuid)
    const fresh = boundary >= 0
      ? (descending ? items.slice(0, boundary) : items.slice(boundary + 1))
      : (feed.lastGuid === null ? [descending ? items[0] : items[items.length - 1]] : [])

    const limit = Math.max(1, Number(this.config.rss?.maxPerPoll ?? 3))
    // 取**最新**的 limit 条（升序时最新在末尾），再按时间从旧到新发出去。
    const batch = descending ? [...fresh.slice(0, limit)].reverse() : fresh.slice(-limit)
    for (const item of batch) {
      if (item === undefined) continue
      await this.send(item, feed)
    }
    // 水位线永远推进到最新一条：即使因为 maxPerPoll 丢了中间几条，也不下一轮补发刷屏。
    const newest = descending ? items[0] : items[items.length - 1]
    if (newest !== undefined && newest.guid !== feed.lastGuid) {
      feed.lastGuid = newest.guid
      this.log(`rss: ${feed.id} pushed ${batch.length} item(s) (${descending ? 'desc' : 'asc'}), lastGuid → ${newest.guid}`)
    }
  }
}
