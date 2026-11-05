/** 每个站一套解析：B站 / 网易云 / GitHub / 通用网页兜底。
 *
 * 站点接口是**最容易变**的部分（B站 2026 年就换过一次 `x/web-interface/view` 的
 * 字段），所以它们各自独立成函数、集中在同一个文件里：换一个站不必动缓存、
 * 不必动发送、也不必动工具面。
 */


import type { HttpClient } from '../../../ports/http.js'
import { systemHttp } from '../../http/client.js'
import {
  MAX_HTML_BYTES, SHORT_LINK_HOSTS, UA, aidFrom, bvidFrom, clamp, collapse, decodeEntities, fail,
  followShortLink, githubRepo, headOf, hostOf, message, metaContent, neteaseSongId, pageTitle,
  upgradeToHttps,
} from './parse.js'

/** 这些解析器统一用这个取回器（带超时与体积上限）。 */
const http: HttpClient = systemHttp


export interface ResolvedLink {
  /** 'bilibili' | 'music163' | 'github' | 'web' */
  kind: string
  /** 规范化后的真实链接（短链会被还原）。 */
  url: string
  title: string
  desc: string
  /** 封面图 URL；没有就是 null。 */
  cover: string | null
  extra: Record<string, unknown>
}

export interface ResolveOptions {
  /** 形如 `SESSDATA=…`，可选，用于 B站接口防风控 / 更高码率封面。 */
  bilibiliCookie?: string | null
  log?: (line: string) => void
}

// ---------------------------------------------------------------- 小工具

interface BiliViewData {
  bvid?: string
  aid?: number
  title?: string
  desc?: string
  pic?: string
  duration?: number
  pubdate?: number
  owner?: { name?: string; mid?: number }
  stat?: { view?: number; danmaku?: number; like?: number; coin?: number; favorite?: number; reply?: number }
  pages?: Array<{ cid?: number; page?: number; part?: string; duration?: number }>
}

interface BiliPageListEntry {
  cid?: number
  page?: number
  part?: string
  duration?: number
}

/** One `x/web-interface/view` call, or a throw carrying a human reason. */
async function biliView(api: string, headers: Record<string, string>): Promise<BiliViewData> {
  const res = await systemHttp.request(api, { headers, timeoutMs: 10_000 })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = res.json<{ code?: number; message?: string; data?: BiliViewData }>()
  if (body.code !== 0 || body.data === undefined) {
    // -404 = 视频不存在 / 已失效；-403 = 风控；62002 = 稿件不可见。
    const note = body.code === -404 ? '视频不存在或已失效'
      : body.code === 62002 ? '稿件已被UP主设为不可见'
        : body.code === -403 ? '被 B站 风控拦了（可在配置里填 bilibiliCookie）'
          : `接口返回 code=${body.code} ${body.message ?? ''}`
    throw new Error(note)
  }
  if (collapse(body.data.title ?? '') === '') throw new Error('接口没有返回标题')
  return body.data
}

/**
 * Cover-less card built from the B站 endpoints that stay open to datacenter IPs.
 *
 * `x/web-interface/view` is the only route that also yields the cover, the UP
 * and the play counts, but it answers HTTP 412 to a bare datacenter IP. The
 * endpoints below were verified reachable from the same host at the same
 * moment, so when `view` is blocked the card degrades to "title + duration +
 * description + link" instead of failing outright.
 *
 * @returns null when even the open endpoints cannot produce a title.
 */
async function biliOpenCard(
  bvid: string,
  headers: Record<string, string>,
  opts: ResolveOptions,
): Promise<ResolvedLink | null> {
  const get = async <T>(api: string): Promise<T | null> => {
    try {
      const res = await systemHttp.request(api, { headers, timeoutMs: 10_000 })
      if (!res.ok) return null
      const body = res.json<{ code?: number; data?: T }>()
      if (body.code !== 0 || body.data === undefined) return null
      return body.data
    } catch {
      return null
    }
  }

  const pages = await get<BiliPageListEntry[]>(`https://api.bilibili.com/x/player/pagelist?bvid=${encodeURIComponent(bvid)}`)
  const first = Array.isArray(pages) ? pages[0] : undefined
  const title = collapse(first?.part ?? '')
  if (title === '') return null

  const rawDesc = await get<string>(`https://api.bilibili.com/x/web-interface/archive/desc?bvid=${encodeURIComponent(bvid)}`)
  let aid: number | null = null
  if (typeof first?.cid === 'number') {
    const player = await get<{ aid?: number }>(`https://api.bilibili.com/x/player/v2?bvid=${encodeURIComponent(bvid)}&cid=${first.cid}`)
    aid = typeof player?.aid === 'number' ? player.aid : null
  }
  opts.log?.(`bilibili open card for ${bvid}: title ok, cover unavailable (view is risk-controlled)`)
  return {
    kind: 'bilibili',
    url: `https://www.bilibili.com/video/${bvid}`,
    title,
    // An empty description comes back as the literal "-".
    desc: collapse(typeof rawDesc === 'string' ? rawDesc : '').replace(/^-$/, ''),
    cover: null,
    extra: {
      up: '',
      upMid: null,
      durationSec: typeof first?.duration === 'number' ? first.duration : null,
      view: null,
      danmaku: null,
      like: null,
      coin: null,
      favorite: null,
      reply: null,
      pubdate: null,
      pages: Array.isArray(pages) ? pages.length : 1,
      bvid,
      aid,
      degraded: 'view 接口被 B站 风控（HTTP 412），已改用开放接口：标题/时长可用，封面需要配置 bilibiliCookie',
      coverUnavailable: true,
    },
  }
}

/** 短链先还原，再从还原后的链接里取 BV/av 号。 */
async function biliLocate(url: string): Promise<{ target: string; bvid: string | null; aid: string | null }> {
  const host = hostOf(url)
  const target = SHORT_LINK_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
    ? await followShortLink(url)
    : url
  const bvid = bvidFrom(target) ?? bvidFrom(url)
  const aid = bvid === null ? aidFrom(target) ?? aidFrom(url) : null
  if (bvid === null && aid === null) throw fail('B站', '这个链接里没有 BV 号 / av 号，可能是动态、专栏或直播间')
  return { target, bvid, aid }
}

/** B站请求头。SESSDATA 只是防风控（无 cookie 时同 IP 高频请求会 -412）。 */
function biliHeaders(opts: ResolveOptions): Record<string, string> {
  const headers: Record<string, string> = { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' }
  if (typeof opts.bilibiliCookie === 'string' && opts.bilibiliCookie.trim() !== '') {
    headers.Cookie = opts.bilibiliCookie.trim()
  }
  return headers
}

/** `x/web-interface/view` 的回答 → 完整卡片（有封面、UP、播放量）。 */
function biliFullCard(data: BiliViewData, target: string, bvid: string | null): ResolvedLink {
  return {
    kind: 'bilibili',
    url: data.bvid !== undefined ? `https://www.bilibili.com/video/${data.bvid}` : target,
    title: collapse(data.title ?? ''),
    desc: collapse(data.desc ?? ''),
    cover: typeof data.pic === 'string' && data.pic !== '' ? upgradeToHttps(data.pic) : null,
    extra: {
      up: data.owner?.name ?? '',
      upMid: data.owner?.mid ?? null,
      durationSec: typeof data.duration === 'number' ? data.duration : null,
      view: data.stat?.view ?? null,
      danmaku: data.stat?.danmaku ?? null,
      like: data.stat?.like ?? null,
      coin: data.stat?.coin ?? null,
      favorite: data.stat?.favorite ?? null,
      reply: data.stat?.reply ?? null,
      pubdate: data.pubdate ?? null,
      pages: Array.isArray(data.pages) ? data.pages.length : 1,
      bvid: data.bvid ?? bvid,
    },
  }
}

/**
 * B站：三级回退。
 *
 * 1. `x/web-interface/view` —— 唯一同时给出封面 / UP / 播放量的接口；
 * 2. 开放接口组合（pagelist + archive/desc + player/v2）—— 无封面但标题时长都在；
 * 3. 网页 og: 元数据 —— 最后兜底。
 *
 * 填了 `bilibiliCookie` 之后第 1 级一般就通了，封面与播放量都会回来。
 */
export async function resolveBilibili(url: string, opts: ResolveOptions): Promise<ResolvedLink> {
  const { target, bvid, aid } = await biliLocate(url)
  const api = bvid !== null
    ? `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`
    : `https://api.bilibili.com/x/web-interface/view?aid=${encodeURIComponent(aid!)}`
  const headers = biliHeaders(opts)

  try {
    return biliFullCard(await biliView(api, headers), target, bvid)
  } catch (error) {
    opts.log?.(`bilibili view failed (${message(error)}), trying the open endpoints`)
    if (bvid !== null) {
      const open = await biliOpenCard(bvid, headers, opts)
      if (open !== null) return open
    }
    opts.log?.('bilibili open endpoints failed too, falling back to og: metadata')
    // 接口挂了不等于卡片做不出来：网页 og: 里通常还有标题和封面。
    const page = bvid !== null
      ? `https://www.bilibili.com/video/${bvid}`
      : `https://www.bilibili.com/video/av${aid!}`
    const meta = await resolveGeneric(page, opts)
    return {
      ...meta,
      kind: 'bilibili',
      url: page,
      extra: { ...meta.extra, degraded: '接口不可用，已降级为网页元数据' },
    }
  }
}

// ---------------------------------------------------------------- 网易云音乐

interface NeteaseSong {
  name?: string
  ar?: Array<{ name?: string }>
  artists?: Array<{ name?: string }>
  al?: { name?: string; picUrl?: string; pic_str?: string }
  album?: { name?: string; picUrl?: string; pic_str?: string }
  dt?: number
  duration?: number
}

/** 网易云：URL / `#/song?id=` 里提 songId，走公网 api（本机网关没有音乐接口）。 */
export async function resolveMusic163(url: string, opts: ResolveOptions): Promise<ResolvedLink> {
  let target = url
  const host = hostOf(url)
  if (host === '163cn.tv' || host.endsWith('.163cn.tv')) {
    target = await followShortLink(url)
  }
  const songId = neteaseSongId(target) ?? neteaseSongId(url)
  if (songId === null) throw fail('网易云音乐', '这个链接里没有歌曲 id')

  const headers: Record<string, string> = { 'User-Agent': UA, Referer: 'https://music.163.com/' }
  try {
    const res = await systemHttp.request(`https://music.163.com/api/song/detail?ids=[${songId}]`, {
      headers, timeoutMs: 10_000,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = res.json<{ code?: number; songs?: NeteaseSong[] }>()
    const song = body.songs?.[0]
    if (song === undefined) throw new Error(`接口没有返回歌曲（code=${body.code}）`)
    const artists = song.ar ?? song.artists ?? []
    const album = song.al ?? song.album
    const pic = album?.picUrl ?? album?.pic_str ?? ''
    return {
      kind: 'music163',
      url: `https://music.163.com/#/song?id=${songId}`,
      title: collapse(song.name ?? ''),
      desc: collapse(album?.name ?? ''),
      cover: pic === '' ? null : upgradeToHttps(pic),
      extra: {
        songId,
        artists: artists.map((a: { name?: string }) => a.name ?? '').filter((name: string) => name !== '').join('/'),
        album: album?.name ?? '',
        durationSec: typeof song.dt === 'number' ? Math.round(song.dt / 1000)
          : typeof song.duration === 'number' ? Math.round(song.duration / 1000) : null,
      },
    }
  } catch (error) {
    // 老接口偶发 404：退回网页 og: 元数据（至少能拿到歌名和封面）。
    opts.log?.(`netease api failed (${message(error)}), falling back to og: metadata`)
    const meta = await resolveGeneric(`https://music.163.com/#/song?id=${songId}`, opts)
    return {
      ...meta,
      kind: 'music163',
      url: `https://music.163.com/#/song?id=${songId}`,
      extra: { ...meta.extra, songId, degraded: '接口不可用，已降级为网页元数据' },
    }
  }
}

// ---------------------------------------------------------------- GitHub

/** GitHub：公开 REST 拿 description / stars / language，封面用 owner 头像。 */
export async function resolveGithub(url: string, _opts: ResolveOptions): Promise<ResolvedLink> {
  const parsed = githubRepo(url)
  if (parsed === null) throw fail('GitHub', '链接里没有 owner/repo')
  const { owner, repo } = parsed
  try {
    const res = await systemHttp.request(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
      headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json' },
      timeoutMs: 10_000,
    })
    if (res.status === 404) throw new Error('仓库不存在或已私有')
    if (res.status === 403) throw new Error('触发了 GitHub 限流，稍后再试')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as {
      full_name?: string
      description?: string | null
      html_url?: string
      stargazers_count?: number
      forks_count?: number
      language?: string | null
      topics?: string[]
      owner?: { login?: string; avatar_url?: string }
      updated_at?: string
    }
    const avatar = data.owner?.avatar_url ?? (data.owner?.login !== undefined ? `https://github.com/${data.owner.login}.png` : '')
    return {
      kind: 'github',
      url: data.html_url ?? `https://github.com/${owner}/${repo}`,
      title: data.full_name ?? `${owner}/${repo}`,
      desc: collapse(data.description ?? ''),
      cover: avatar === '' ? null : upgradeToHttps(avatar),
      extra: {
        owner,
        repo,
        stars: data.stargazers_count ?? 0,
        forks: data.forks_count ?? 0,
        language: data.language ?? '',
        topics: data.topics ?? [],
        updatedAt: data.updated_at ?? '',
      },
    }
  } catch (error) {
    throw fail('GitHub', message(error))
  }
}

// ---------------------------------------------------------------- 通用网页兜底

/**
 * 通用网页：GET 页面只读前 256KB，从 og: / twitter: / title / description 抽字段。
 * 手写正则而不是 HTML 解析库——只要三个字段，且项目禁止新增依赖。
 *
 * 请求走 `systemHttp`：群友贴的内网地址（NapCat WebUI、管理后台、云元数据）
 * 在这里被挡住，重定向也逐跳检查。
 */
export async function resolveGeneric(url: string, _opts: ResolveOptions): Promise<ResolvedLink> {
  try {
    const response = await systemHttp.request(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
      timeoutMs: 10_000,
      limit: MAX_HTML_BYTES,
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const html = headOf(response.bytes)
    const title = pageTitle(html) ?? ''
    const desc = metaContent(html, 'og:description')
      ?? metaContent(html, 'twitter:description')
      ?? metaContent(html, 'description')
      ?? ''
    const image = metaContent(html, 'og:image')
      ?? metaContent(html, 'og:image:secure_url')
      ?? metaContent(html, 'twitter:image')
      ?? ''
    if (title === '' && desc === '' && image === '') throw new Error('页面里没有可用的标题 / 简介 / 封面')
    return {
      kind: 'web',
      url: response.url !== '' ? response.url : url,
      title: clamp(title, 200),
      desc: clamp(desc, 500),
      cover: image === '' ? null : upgradeToHttps(image),
      extra: { site: metaContent(html, 'og:site_name') ?? '', host: hostOf(url) },
    }
  } catch (error) {
    throw fail('网页', message(error))
  }
}
