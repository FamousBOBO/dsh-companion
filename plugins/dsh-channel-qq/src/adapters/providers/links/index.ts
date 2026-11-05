/** 链接卡片的**对外入口**：解析（带缓存与并发去重）、发卡片、自动出卡。
 *
 * 三件事都围绕一个 `ResolvedLink`：谁都能解析，但同一分钟里同一个 URL 只解析一次
 * （10 分钟 LRU + 同 URL 并发复用），发卡片时把封面下载并落到工作区。
 *
 * 工具面在 `features/links/tools.ts`——那里只管"模型怎么调用它"。
 */


import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import type { QQChannelConfig } from '../../../config.js'
import type { QQApi } from '../../../ports/platform.js'
import type { OutboundQueue } from '../../../outbound.js'
import { resolveDshHome } from '../../../paths.js'
import { napcatFileArg } from '../../../local-file.js'
import { systemHttp } from '../../http/client.js'
import { atomicWriteFile } from '../../fs-store/atomic.js'
import {
  MAX_COVER_BYTES, UA, clamp, extractUrls, hostOf, looksLikeBilibili, looksLikeMusic163, message,
} from './parse.js'
import { resolveBilibili, resolveGithub, resolveGeneric, resolveMusic163, type ResolveOptions, type ResolvedLink } from './resolvers.js'

export type { ResolveOptions, ResolvedLink }


/** 解析结果缓存存活时间；同一个 URL 10 分钟内不重复请求。 */
const CACHE_TTL_MS = 10 * 60 * 1000

const CACHE_MAX_ENTRIES = 200

interface CacheEntry {
  at: number
  value: ResolvedLink
}

/** 10 分钟 LRU（Map 的插入序即使用序，命中后重新插入 = 提升为最近使用）。 */
const linkCache = new Map<string, CacheEntry>()

/** 同 URL 并发去重：第二条相同的链接复用第一条正在飞行的请求。 */
const inflight = new Map<string, Promise<ResolvedLink>>()

function cacheGet(url: string): ResolvedLink | null {
  const hit = linkCache.get(url)
  if (hit === undefined) return null
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    linkCache.delete(url)
    return null
  }
  linkCache.delete(url)
  linkCache.set(url, hit)
  return hit.value
}

function cachePut(url: string, value: ResolvedLink): void {
  linkCache.delete(url)
  linkCache.set(url, { at: Date.now(), value })
  while (linkCache.size > CACHE_MAX_ENTRIES) {
    const oldest = linkCache.keys().next()
    if (oldest.done === true) break
    linkCache.delete(oldest.value)
  }
}

// ---------------------------------------------------------------- URL 抽取

/**
 * 解析单条链接。按 host 分派到 B站 / 网易云 / GitHub / 通用网页。
 *
 * @throws Error 中文文案，可直接讲给群友（例：`B站解析失败：视频不存在或已失效`）。
 */
export async function resolveLink(url: string, opts: ResolveOptions = {}): Promise<ResolvedLink> {
  const raw = (url ?? '').trim()
  if (raw === '') throw new Error('链接解析失败：没有给链接')
  const normalized = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  let parsed: URL
  try {
    parsed = new URL(normalized)
  } catch {
    throw new Error(`链接解析失败：这不像一个链接（${raw}）`)
  }
  const key = parsed.toString()

  const cached = cacheGet(key)
  if (cached !== null) {
    opts.log?.(`link cache hit: ${key}`)
    return cached
  }
  const pending = inflight.get(key)
  if (pending !== undefined) return pending

  const task = (async (): Promise<ResolvedLink> => {
    const host = parsed.hostname.toLowerCase()
    if (looksLikeBilibili(key, host)) return resolveBilibili(key, opts)
    if (looksLikeMusic163(key, host)) return resolveMusic163(key, opts)
    if (host === 'github.com' || host.endsWith('.github.com')) return resolveGithub(key, opts)
    return resolveGeneric(key, opts)
  })()

  inflight.set(key, task)
  try {
    const value = await task
    cachePut(key, value)
    return value
  } finally {
    inflight.delete(key)
  }
}

// ---------------------------------------------------------------- 封面落盘

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
  'image/bmp': '.bmp',
}

function extFor(contentType: string, coverUrl: string): string {
  const mime = contentType.split(';')[0]!.trim().toLowerCase()
  const byMime = EXT_BY_MIME[mime]
  if (byMime !== undefined) return byMime
  try {
    const ext = path.extname(new URL(coverUrl).pathname).toLowerCase()
    if (/^\.(jpg|jpeg|png|webp|gif|avif|bmp)$/.test(ext)) return ext === '.jpeg' ? '.jpg' : ext
  } catch {
    /* URL 解析不了就落到默认后缀 */
  }
  return '.jpg'
}

/**
 * 下载封面到 `<dshHome>/channel-qq/link-cache/<sha1(url)>.<ext>`。
 * 文件名由 URL 哈希决定，所以同一个封面天然命中缓存、不重复下载。
 *
 * @returns 本地绝对路径；失败返回 null（调用方降级为纯文本卡片）。
 */
async function downloadCover(coverUrl: string, log?: (line: string) => void): Promise<string | null> {
  const dir = path.join(resolveDshHome(), 'channel-qq', 'link-cache')
  try {
    const hash = createHash('sha1').update(coverUrl).digest('hex')
    const head = await systemHttp.request(coverUrl, {
      method: 'HEAD',
      headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
      timeoutMs: 10_000,
      limit: 0,
    }).catch(() => null)
    const guessExt = extFor(head?.header('content-type') ?? '', coverUrl)
    const target = path.join(dir, `${hash}${guessExt}`)
    try {
      const stat = await fs.stat(target)
      if (stat.size > 0) return target
    } catch {
      /* 缓存未命中，继续下载 */
    }
    await fs.mkdir(dir, { recursive: true })
    const response = await systemHttp.request(coverUrl, {
      headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
      timeoutMs: 15_000,
      limit: MAX_COVER_BYTES,
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const buf = Buffer.from(response.bytes)
    if (buf.length === 0) throw new Error('封面是空文件')
    const ext = extFor(response.header('content-type') ?? '', coverUrl)
    const finalPath = ext === guessExt ? target : path.join(dir, `${hash}${ext}`)
    await atomicWriteFile(finalPath, buf)
    return finalPath
  } catch (error) {
    log?.(`cover download failed: ${message(error)}`)
    return null
  }
}

// ---------------------------------------------------------------- 卡片发送（工具与自动出卡共用）

/**
 * 发一张链接卡片：先封面图，再「标题 + 简介 + 原链接」文本。
 *
 * 这是 `qq_send_link_card` 工具和自动出卡**共用的唯一实现**（工具内部也调它），
 * 所以封面落盘路径、先图后文的顺序、降级行为只有一处。
 *
 * 全程走 `out.push`（限速队列），封面下载 / 发送失败一律降级为纯文本，**绝不抛错**：
 * 自动出卡跑在入站消息的主路径上，一个坏链接不能让整条消息处理炸掉。
 *
 * @returns `ok=false` 表示连文本都没发出去（此时 `note` 有原因）；
 *          `imageUrl` 是实际发出的封面**本地文件路径**（远端封面 URL 在 `card.cover`），
 *          没发图或发图失败为 null，`note` 说明降级原因。
 */
export async function sendLinkCard(
  api: QQApi,
  out: OutboundQueue,
  card: ResolvedLink,
  opts: { isGroup: boolean; target: number; log?: (line: string) => void },
): Promise<{ ok: boolean; imageUrl: string | null; note?: string }> {
  const { isGroup, target, log } = opts
  let imageUrl: string | null = null
  let note: string | undefined

  if (card.cover !== null && card.cover !== '') {
    let file: string | null = null
    try {
      file = await downloadCover(card.cover, log)
    } catch (error) {
      // downloadCover 自己已经兜底；这里防的是它之外的意外（例如取 dshHome 时失败）。
      log?.(`cover download failed: ${message(error)}`)
      file = null
    }
    if (file === null) {
      note = '封面下载失败，已降级为纯文本卡片'
    } else {
      try {
        // Resolve the wire form *before* queueing: the out.push callback must stay
        // synchronous, so it cannot await napcatFileArg itself.
        const cover = await napcatFileArg(file)
        await out.push(() => api.sendTo(isGroup, target, [{ type: 'image', data: { file: cover } }]))
        imageUrl = file
      } catch (error) {
        note = `封面发送失败（${message(error)}），已降级为纯文本卡片`
      }
    }
  }

  try {
    await out.push(() => api.sendTo(isGroup, target, [{ type: 'text', data: { text: cardText(card) } }]))
  } catch (error) {
    const textError = `卡片文本发送失败（${message(error)}）`
    return { ok: false, imageUrl, note: note === undefined ? textError : `${note}；${textError}` }
  }
  return note === undefined ? { ok: true, imageUrl } : { ok: true, imageUrl, note }
}

// ---------------------------------------------------------------- 自动出卡

/** 同群同链接的自动出卡去重窗口：30 分钟。 */
const AUTO_DEDUP_TTL_MS = 30 * 60 * 1000

/**
 * 自动出卡去重表：键 `groupId|规范化URL`，值 = 上一次成功出卡的时间戳。
 *
 * 只在内存里（进程重启即清空）：它防的是「群友复读同一条链接刷屏」，
 * 不是业务数据，不值得落盘。
 */
const autoSent = new Map<string, number>()

/** 顺手丢掉超过 30 分钟的旧条目，免得这张表随群里链接越甩越多无限增长。 */
function purgeAutoSent(now: number): void {
  for (const [key, at] of autoSent) {
    if (now - at > AUTO_DEDUP_TTL_MS) autoSent.delete(key)
  }
}

/**
 * 去重用的 URL 规范化：host 小写、去掉末尾多余的 `/`。
 *
 * 刻意保留 `#fragment`——网易云的规范链接是 `https://music.163.com/#/song?id=…`，
 * 抹掉 fragment 会让所有歌共用一个键。短链用 `card.url`（解析后的真实链接）做键，
 * 所以 `b23.tv/xxx` 和展开后的 B站链接算同一条。
 */
function normalizeUrlKey(url: string): string {
  const raw = url.trim()
  try {
    const parsed = new URL(raw)
    parsed.protocol = parsed.protocol.toLowerCase()
    parsed.hostname = parsed.hostname.toLowerCase()
    const text = parsed.toString()
    if (parsed.search === '' && parsed.hash === '' && text.endsWith('/')) return text.slice(0, -1)
    return text
  } catch {
    return raw.toLowerCase()
  }
}

/**
 * 入站消息的自动出卡：群在 `linkResolve.autoGroups` 白名单里 + 消息里有链接
 * → 解析后自动把卡片发到那个群。
 *
 * 接线（index.ts 的入站钩子里，拿到纯文本和群号之后）：
 *   `void autoResolveLinks(text, groupId, config, api, out, log)`
 * 它自己吞掉所有异常，只 log 不抛——这条路径在消息主循环上，不该因为它炸掉。
 *
 * 去重规则：同群 + 同链接 30 分钟内只自动出一次卡（见文件头注释）。
 */
export async function autoResolveLinks(
  text: string,
  groupId: number,
  config: QQChannelConfig,
  api: QQApi,
  out: OutboundQueue,
  log: (line: string) => void,
): Promise<{ resolved: number; skipped: string }> {
  try {
    const cfg = config.linkResolve
    if (cfg.enabled !== true) return { resolved: 0, skipped: 'disabled' }
    if (!cfg.autoGroups.includes(groupId)) return { resolved: 0, skipped: 'group-not-enabled' }

    const urls = extractUrls(text, cfg.maxPerMessage)
    if (urls.length === 0) return { resolved: 0, skipped: 'ok' }
    purgeAutoSent(Date.now())

    let resolved = 0
    for (const url of urls) {
      // 单个链接失败只记账继续：一条消息里第二个链接不该被第一个的失败拖累。
      try {
        const card = await resolveLink(url, { bilibiliCookie: cfg.bilibiliCookie, log })
        const key = `${groupId}|${normalizeUrlKey(card.url)}`
        const last = autoSent.get(key)
        if (last !== undefined && Date.now() - last < AUTO_DEDUP_TTL_MS) {
          log(`auto link card skipped (same url within 30min): ${card.url}`)
          continue
        }
        const sent = await sendLinkCard(api, out, card, { isGroup: true, target: groupId, log })
        if (!sent.ok) {
          log(`auto link card text send failed: ${card.url}${sent.note === undefined ? '' : ` (${sent.note})`}`)
          continue
        }
        // 只有真的发出去了才记时间戳：文本发送失败通常是瞬时故障，允许下次重试。
        autoSent.set(key, Date.now())
        resolved += 1
        if (sent.note !== undefined) log(`auto link card degraded: ${card.url} (${sent.note})`)
      } catch (error) {
        log(`auto link resolve failed (${url}): ${message(error)}`)
      }
    }
    return { resolved, skipped: 'ok' }
  } catch (error) {
    log(`auto link failed: ${message(error)}`)
    return { resolved: 0, skipped: 'error' }
  }
}

// ---------------------------------------------------------------- 工具注册

/** 卡片文本：标题 + 简介 + 原链接。走分段队列，超长由 outbound 自己切。 */
function cardText(card: ResolvedLink): string {
  const lines = [clamp(card.title, 120)]
  if (card.desc !== '') lines.push(clamp(card.desc, 300))
  lines.push(card.url)
  return lines.join('\n')
}
