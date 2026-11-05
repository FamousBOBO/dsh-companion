/** 链接解析的纯工具：URL 提取、短链跟随、HTML 实体、meta 标签、截断。
 *
 * 这一层最容易单测（给一段 HTML 说"标题应该是这个"），所以它刻意不碰缓存、
 * 不碰网络调度、不认识"卡片"这个概念。唯一的外部动作是跟随短链（一次 HEAD 级请求）。
 */


import type { HttpClient } from '../../../ports/http.js'
import { systemHttp } from '../../http/client.js'


/** 统一的浏览器 UA：没有 UA 时 bilibili / 网易云会直接 403。 */
export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

/** 网页兜底只读前 256KB，避免把整张大页面读进内存。 */
export const MAX_HTML_BYTES = 256 * 1024

export const SHORT_LINK_HOSTS = ['b23.tv', 'bili2233.cn']

const ENTITY_MAP: Record<string, string> = {
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
  '#039': "'",
}

/** http 封面升级为 https（见文件头注释）。 */
export function upgradeToHttps(url: string): string {
  return url.startsWith('http://') ? `https://${url.slice('http://'.length)}` : url
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** 统一异常文案：调用方只需 catch 后直接讲给群友听。 */
export function fail(kind: string, detail: string): Error {
  return new Error(`${kind}解析失败：${detail}`)
}

export function message(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * 取回响应正文的头部若干字节（已由 `ssrf-guard.readCapped` 限过体积）。
 *
 * 保留这个壳是为了让调用点的意图（"只要头部"）留在原地；真正的读取上限在
 * `HttpClient` 里，不是读完再截断。
 */
export function headOf(bytes: Uint8Array, limit: number = MAX_HTML_BYTES): string {
  // 不整份拷贝：`Buffer` 视图复用同一段内存，`toString('utf8')` 才是把字节解成文本。
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return view.subarray(0, limit).toString('utf8')
}

/** 极简 HTML 实体解码：og: 描述里 &amp; &#39; 这类很常见，不解码会串到群里。 */
export function decodeEntities(text: string): string {
  return text
    .replace(/&(lt|gt|quot|apos|nbsp|#0?39);/g, (match, name: string) => ENTITY_MAP[name] ?? match)
    .replace(/&#(\d{1,7});/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&')
}

export function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

// ---------------------------------------------------------------- 缓存

/**
 * 从任意文本里抽链接。
 *
 * 覆盖三种写法：完整 `https?://…`、裸 `b23.tv/xxxx`（群友常这么甩短链）、
 * 裸 `BV1xx…`（只有编号，需要补成 B站链接才能解析）。
 * 尾部的句号 / 括号 / 中文标点一律剥掉——「看这个 https://b23.tv/abc。」很常见。
 */
export function extractUrls(text: string, max = 3): string[] {
  const found: string[] = []
  const seen = new Set<string>()
  const push = (raw: string): void => {
    // 尾部标点先剥掉再补协议：否则 `…abc。` 会连句号一起带进 URL。
    let url = raw.trim().replace(/[)\]}>,.;:!?'"”’】）。，、；：！？]+$/u, '')
    if (url === '') return
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`
    if (seen.has(url)) return
    seen.add(url)
    found.push(url)
  }

  // 中文标点（。，、！？「」等）显式排除：中文句子经常紧跟一个句号，
  // 只写 `[^\s]` 会把句号一起吃进链接里。
  const full = /https?:\/\/[^\s<>"'）】」》，。；！？、]+/gi
  for (const match of text.matchAll(full)) {
    if (found.length >= max) break
    push(match[0])
  }

  // 裸短链：只认 b23.tv 系（群里最常见的一种），避免误抓普通域名。
  if (found.length < max) {
    const bareShort = /(?:^|[\s(（[【])((?:b23\.tv|bili2233\.cn)\/[^\s<>"'）】」》，。；！？、]*)/gi
    for (const match of text.matchAll(bareShort)) {
      if (found.length >= max) break
      const candidate = match[1]
      if (candidate === undefined) continue
      if (seen.has(`https://${candidate.trim()}`)) continue
      push(candidate)
    }
  }

  // 裸 BV 号：前面已抽到含同一个 BV 的链接时跳过，免得同一条链接出现两次。
  if (found.length < max) {
    const bareBv = /(?:^|[^0-9a-zA-Z])(BV[0-9A-Za-z]{10})(?![\w])/g
    for (const match of text.matchAll(bareBv)) {
      if (found.length >= max) break
      const id = match[1]
      if (id === undefined) continue
      if (found.some((url) => url.includes(id))) continue
      push(`www.bilibili.com/video/${id}`)
    }
  }

  return found.slice(0, max)
}

// ---------------------------------------------------------------- B站

export function bvidFrom(text: string): string | null {
  const match = /BV[0-9A-Za-z]{10}/.exec(text)
  return match === null ? null : match[0]
}

export function aidFrom(text: string): string | null {
  const match = /av(\d{4,12})/i.exec(text)
  return match === null ? null : match[1]!
}

/**
 * 短链 → 最终 URL。
 *
 * 走 `systemHttp` 而不是裸 `fetch(..., { redirect: 'follow' })`：后者会把
 * 「公网地址 302 到 127.0.0.1」当成一次正常跳转跟进去，短链服务正是最爱
 * 被这样利用的入口。`HttpClient` 每一跳都重新校验目标地址。
 */
export async function followShortLink(url: string): Promise<string> {
  try {
    // 只需要 Location / 最终地址，正文最多读 1KB 就够（也省掉一次大下载）。
    const res = await systemHttp.request(url, { headers: { 'User-Agent': UA }, limit: 1024 })
    return res.url
  } catch (error) {
    throw fail('B站', `短链展开不了（${message(error)}）`)
  }
}

export function neteaseSongId(url: string): string | null {
  const byHash = /[#/]song\?[^#]*?\bid=(\d+)/i.exec(url)
  if (byHash !== null) return byHash[1]!
  const byQuery = /[?&]id=(\d+)/.exec(url)
  if (byQuery !== null) return byQuery[1]!
  const byPath = /\/song\/(\d+)/.exec(url)
  if (byPath !== null) return byPath[1]!
  const bare = /\b(\d{5,12})\b/.exec(url)
  return bare === null ? null : bare[1]!
}

export function githubRepo(url: string): { owner: string; repo: string } | null {
  let pathname = ''
  try {
    pathname = new URL(url).pathname
  } catch {
    return null
  }
  const parts = pathname.split('/').filter((part) => part !== '')
  if (parts.length < 2) return null
  const owner = parts[0]!
  const repo = parts[1]!.replace(/\.git$/, '')
  if (owner === '' || repo === '') return null
  return { owner, repo }
}

/** 抓一个属性值：兼容 `content` 在前 / 在后两种写法（网上的页面两种都有）。 */
export function metaContent(html: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const forward = new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]*?content=["']([^"']*)["']`, 'i')
  const backward = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*?(?:property|name)=["']${escaped}["']`, 'i')
  const hit = forward.exec(html) ?? backward.exec(html)
  return hit === null ? null : decodeEntities(collapse(hit[1] ?? ''))
}

export function pageTitle(html: string): string | null {
  const og = metaContent(html, 'og:title')
  if (og !== null && og !== '') return og
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  if (title === null) return null
  return decodeEntities(collapse(title[1] ?? ''))
}

export function looksLikeBilibili(url: string, host: string): boolean {
  return host === 'bilibili.com' || host.endsWith('.bilibili.com')
    || host === 'b23.tv' || host.endsWith('.b23.tv')
    || host === 'bili2233.cn' || host.endsWith('.bili2233.cn')
    || bvidFrom(url) !== null
}

export function looksLikeMusic163(url: string, host: string): boolean {
  return host === 'music.163.com' || host.endsWith('.music.163.com')
    || host === '163cn.tv' || host.endsWith('.163cn.tv')
    || /[#/]song\?[^#]*\bid=\d+/i.test(url)
}

/**
 * 封面下载上限（`downloadCover` 用）：2MB。
 *
 * 原先 `arrayBuffer()` 全量读，没有上限——一张"图片"可以是要多少有多少的
 * 内存。QQ 封面正常都在几百 KB 以内，2MB 足够宽裕。
 */
export const MAX_COVER_BYTES = 2 * 1024 * 1024

