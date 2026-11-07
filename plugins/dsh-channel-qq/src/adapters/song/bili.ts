/** B站适配器：搜歌、取视频信息、按 BV+分P 把**纯音轨**下载成本地 wav。
 *
 * 为什么直接打 `api.bilibili.com` 而不装 `bilibili_api`（Python 包）：那条链路要用
 * 一个 Python 进程 + 一堆隐含依赖，而我们已经有 `HttpClient` 端口（带超时、体积上限、
 * SSRF 闸门）。下面五个端点是**在实机上逐个验过**的：
 *
 *   - `x/web-interface/search/type?search_type=video`  搜索。不带 `search_type=video`
 *     会落到另一种结构，字段名都不一样，所以这个参数是合同的一部分。
 *   - `x/web-interface/view?bvid=`                     标题/UP/时长/分P 列表。
 *   - `x/player/pagelist?bvid=`                        分P 列表（与 view 里的 `pages` 同形）。
 *   - `x/player/playurl?...&fnval=16&fourk=1`          DASH 音频流。
 *   - `data.dash.audio[].baseUrl`                      真正的音频字节。
 *
 * 五条实测结论直接写成了代码形状，别"顺手简化"掉：
 *
 *   1. **搜索/信息/playurl 要带 Cookie**（未登录的搜索返回 HTTP 412 的一整页 HTML，
 *      不是 JSON）。所以凭据文件读不到时**降级为匿名**而不是直接失败：匿名拿不到搜索，
 *      但 view / pagelist / 低码率 playurl 还能用。
 *   2. **下载音频那一跳不要带 Cookie**。实测带 Cookie 也能成，但这个字节流来自 CDN、
 *      与账号无关；把 SESSDATA 发给一个只做分发的主机没有收益，只有风险。所以下载
 *      单独用一套头（UA + Referer，无 Cookie）。
 *   3. **`durl` 是空的**（`fnval=16` 走 DASH），所以音频只从 `dash.audio` 里取，
 *      并且取 `bandwidth` 最大的一条（30280 / 30232 / 30216 三档，实测 5:17 的 30280
 *      是 6.7 MB 的 aac 48 kHz 立体声）。
 *   4. **`baseUrl` 偶尔是协议相对 URL**（`//host/...`），必须补 `https:`——
 *      `HttpClient` 只认绝对 http(s) 地址。
 *   5. 视频时长在搜索里是文本（`"4:30"`；超过一小时是 `"163:39"`，即 163 分钟，
 *      不是 1:63），在 `view` 里是秒数。两种都要认，且**不能混淆**。
 *   6. **`baseUrl` 不一定通**（实机 `ECONNREFUSED` 打在 `*.mcdn.bilivideo.cn:8082` 上），
 *      而同一段音频的 `backupUrl` 一秒能下。所以音频那一段是"一组地址逐个试"，
 *      那段代码在 `bili-audio.ts`。
 *
 * 失败一律抛**可读**错误：带 `code`/`message`，不带整段 JSON。风控/凭据失效是最常见的
 * 失败，所以 412 单独给一句"Cookie 可能失效"。
 *
 * **`signal` 只做入场检查**：`HttpClient` 端口目前没有 `signal` 字段（超时由它自己的
 * `timeoutMs` 管），所以这三个方法在开跑前 `throwIfAborted()`，已经取消就直接抛；
 * 已经发出的那次请求会按 `timeoutMs` 自己结束。不假装能中途掐断，是因为假装之后
 * 调用方会依赖一个不存在的保证（"取消后不会有请求在跑"）。
 */

import { promises as fs } from 'node:fs'
import type { HttpClient, HttpOptions } from '../../ports/http.js'
import type { BiliPage, BiliPort, BiliVideoInfo, ProcessPort, SongCandidate } from '../../features/song/types.js'
import {
  AUDIO_HEADERS, AUDIO_TIMEOUT_MS, downloadTrack, pickBestAudio,
  type AudioDeps, type AudioTrack, type PlayUrlRaw,
} from './bili-audio.js'

/** 桌面 Chrome UA：没有它 B站 会 403，这条在实机上验过（空 UA / curl UA 都失败）。 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const REFERER = 'https://www.bilibili.com/'
const API = 'https://api.bilibili.com'

/** JSON 端点的体积上限：`view` 在多分P 视频上能到 170 KB+，给 1 MiB 余量。 */
const JSON_LIMIT = 1024 * 1024
/** 接口超时。 */
const API_TIMEOUT_MS = 15_000

/** B站 统一响应封套。 */
interface BiliBody<T> {
  code?: number
  message?: string
  data?: T
}

interface SearchRaw {
  bvid?: string
  title?: string
  author?: string
  duration?: string | number
  play?: number
  description?: string
}

interface ViewRaw {
  bvid?: string
  title?: string
  duration?: number
  owner?: { name?: string }
  pages?: Array<{ cid?: number; part?: string; duration?: number }>
}

/** 凭据文件里的四个字段；大小写两种都认（真实文件是小写）。 */
interface BiliCredential {
  sessdata?: string
  SESSDATA?: string
  bili_jct?: string
  buvid3?: string
  dedeuserid?: string
  DedeUserID?: string
}

export interface BiliPortOptions {
  readonly http: HttpClient
  /** bili_credential.json 的绝对路径（含 SESSDATA/bili_jct/buvid3/dedeuserid）。读不到就匿名。 */
  readonly credentialFile: string
  /** ffmpeg 可执行文件名或绝对路径，用于 m4s→wav。 */
  readonly ffmpegPath: string
  readonly process: ProcessPort
  readonly log: (line: string) => void
  /** 凭据目录（下载临时文件落这里，绝不写仓库里除 data 之外的位置）。 */
  readonly workRoot: string
}

/** `4:30` / `163:39` / `1:02:03` → 秒。任何认不出的形状都返回 0（不猜）。 */
export function parseBiliDuration(text: string): number {
  const parts = String(text ?? '').trim().split(':')
  if (parts.length < 2 || parts.length > 3) return 0
  const nums = parts.map((part) => Number(part))
  if (nums.some((value) => !Number.isFinite(value) || value < 0)) return 0
  // 三段才是"时:分:秒"；两段是"分:秒"（B站 搜索里超过一小时仍按分钟记，例：163:39）。
  return parts.length === 3
    ? (nums[0] ?? 0) * 3600 + (nums[1] ?? 0) * 60 + (nums[2] ?? 0)
    : (nums[0] ?? 0) * 60 + (nums[1] ?? 0)
}

/** 剥掉 `<em class="keyword">` 之类的高亮标签并还原常见实体（标题里两者都有）。 */
export function cleanBiliText(raw: string): string {
  return String(raw ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim()
}

/** BV 号形状（`BV` + 10 位）：不合形状的直接拒，别把任意字符串拼进 URL。 */
function assertBvid(bvid: string): string {
  const value = String(bvid ?? '').trim()
  if (!/^BV[0-9A-Za-z]{10}$/.test(value)) throw new Error(`BV 号形状不对：${value === '' ? '(空)' : value}`)
  return value
}

/** cid 必须是正整数（`0` / `undefined` 都是"还没选分P"，不是合法参数）。 */
function assertCid(cid: number): number {
  if (!Number.isInteger(cid) || cid <= 0) throw new Error(`分P cid 不对：${String(cid)}`)
  return cid
}

/** 把 `code != 0` 翻译成一句人话。风控/凭据失效是最常见的，所以单独给提示。 */
function biliFailure(what: string, code: number | undefined, message: string | undefined): Error {
  const codeText = code === undefined ? '未知 code' : `code=${String(code)}`
  const tail = message === undefined || message.trim() === '' ? '' : `（${message.trim()}）`
  const hint = code === -404 ? '：视频不存在或已失效'
    : code === 62002 ? '：稿件已被 UP 主设为不可见'
      : code === -403 || code === -412 ? '：被风控拦了，检查 bili_credential.json 里的 SESSDATA 是否失效'
        : ''
  return new Error(`B站${what}失败：${codeText}${tail}${hint}`)
}

/** 取一次 JSON 端点，校验封套并返回 `data`。 */
async function getJson<T>(
  http: HttpClient,
  what: string,
  url: string,
  headers: Record<string, string>,
): Promise<T> {
  const options: HttpOptions = { headers, timeoutMs: API_TIMEOUT_MS, limit: JSON_LIMIT }
  const res = await http.request(url, options)
  if (!res.ok) {
    const hint = res.status === 412 ? '（风控拦截：通常是 Cookie 失效或请求过快）' : ''
    throw new Error(`B站${what}失败：HTTP ${String(res.status)}${hint}`)
  }
  let body: BiliBody<T>
  try {
    body = res.json<BiliBody<T>>()
  } catch {
    // 412 返回的是一整页 HTML——这里再兜一次，防止状态码是 200 但正文不是 JSON。
    throw new Error(`B站${what}失败：返回的不是 JSON（可能是风控页，检查 Cookie）`)
  }
  if (body.code !== 0) throw biliFailure(what, body.code, body.message)
  if (body.data === undefined || body.data === null) throw new Error(`B站${what}失败：响应没有 data`)
  return body.data
}

/** 读凭据文件 → `Cookie` 头。读不到 / 坏 JSON 一律返回空串（匿名降级，不抛）。 */
async function readCookie(file: string): Promise<string> {
  let text: string
  try {
    text = await fs.readFile(file, 'utf-8')
  } catch {
    return ''
  }
  let parsed: BiliCredential
  try {
    parsed = JSON.parse(text) as BiliCredential
  } catch {
    return ''
  }
  const sessdata = (parsed.sessdata ?? parsed.SESSDATA ?? '').trim()
  if (sessdata === '') return ''
  const parts = [`SESSDATA=${sessdata}`]
  const jct = (parsed.bili_jct ?? '').trim()
  if (jct !== '') parts.push(`bili_jct=${jct}`)
  const buvid = (parsed.buvid3 ?? '').trim()
  if (buvid !== '') parts.push(`buvid3=${buvid}`)
  const uid = (parsed.dedeuserid ?? parsed.DedeUserID ?? '').trim()
  if (uid !== '') parts.push(`DedeUserID=${uid}`)
  return parts.join('; ')
}

/** 搜索/信息/playurl 调用用的头（带 Cookie）。 */
function apiHeaders(cookie: string): Record<string, string> {
  const headers: Record<string, string> = { 'User-Agent': UA, Referer: REFERER }
  if (cookie !== '') headers.Cookie = cookie
  return headers
}

/** 三个方法共享的依赖（Cookie 缓存挂在它上面，见 `cookieOf`）。 */
interface BiliDeps extends BiliPortOptions {
  /** `null` = 还没读过；`''` = 读过但没有凭据（不再重复读文件）。 */
  readonly cookieCache: { value: string | null }
}

/** 一次点歌会打 3~4 个接口，没必要读四遍凭据文件。 */
async function cookieOf(deps: BiliDeps): Promise<string> {
  const cached = deps.cookieCache.value
  if (cached !== null) return cached
  const cookie = await readCookie(deps.credentialFile)
  deps.cookieCache.value = cookie
  deps.log(cookie === '' ? 'song/bili: 读不到凭据，本次匿名（搜索大概率被风控）' : 'song/bili: 已载入凭据')
  return cookie
}

async function searchVideos(deps: BiliDeps, keyword: string, limit: number): Promise<readonly SongCandidate[]> {
  const text = String(keyword ?? '').trim()
  if (text === '') return []
  const data = await getJson<{ result?: SearchRaw[] | null }>(
    deps.http, '搜索',
    `${API}/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(text)}&page=1`,
    apiHeaders(await cookieOf(deps)),
  )
  const rows = Array.isArray(data.result) ? data.result : []
  const out: SongCandidate[] = []
  for (const row of rows) {
    const candidate = toCandidate(row)
    if (candidate === null) continue
    out.push(candidate)
    if (out.length >= Math.max(1, limit)) break
  }
  deps.log(`song/bili: 搜索「${text}」得到 ${String(out.length)} 条可用结果（上游 ${String(rows.length)} 条）`)
  return out
}

async function fetchVideoInfo(deps: BiliDeps, bvid: string): Promise<BiliVideoInfo> {
  const id = assertBvid(bvid)
  const data = await getJson<ViewRaw>(
    deps.http, '视频信息', `${API}/x/web-interface/view?bvid=${encodeURIComponent(id)}`,
    apiHeaders(await cookieOf(deps)),
  )
  const pages = toPages(data.pages ?? [])
  if (pages.length === 0) throw new Error(`B站视频信息失败：${id} 没有可用的分P（cid 缺失）`)
  return {
    bvid: String(data.bvid ?? id),
    title: cleanBiliText(String(data.title ?? '')),
    author: cleanBiliText(String(data.owner?.name ?? '')),
    duration: typeof data.duration === 'number' && data.duration > 0 ? data.duration : 0,
    pages,
  }
}

/** 一条搜索结果 → `SongCandidate`；缺 bvid 的直接丢（没法下一步）。 */
function toCandidate(raw: SearchRaw): SongCandidate | null {
  const bvid = String(raw.bvid ?? '').trim()
  if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) return null
  const duration = typeof raw.duration === 'number' ? raw.duration : parseBiliDuration(String(raw.duration ?? ''))
  return {
    bvid,
    title: cleanBiliText(String(raw.title ?? '')),
    author: cleanBiliText(String(raw.author ?? '')),
    duration: duration > 0 ? duration : 0,
    play: typeof raw.play === 'number' ? raw.play : 0,
    description: cleanBiliText(String(raw.description ?? '')),
  }
}

/** 分P 列表归一化：`cid` 必须是正整数，否则这一项没意义。 */
function toPages(raw: readonly { cid?: number; part?: string; duration?: number }[]): BiliPage[] {
  const out: BiliPage[] = []
  for (const item of raw) {
    const cid = item.cid
    if (typeof cid !== 'number' || !Number.isInteger(cid) || cid <= 0) continue
    out.push({
      cid,
      part: cleanBiliText(String(item.part ?? '')),
      duration: typeof item.duration === 'number' && item.duration > 0 ? item.duration : 0,
    })
  }
  return out
}

/** `playurl` → 最高带宽音轨（含它的全部候选地址，见 `bili-audio.ts` 为什么是一组）。 */
async function resolveAudioUrl(deps: BiliDeps, bvid: string, cid: number): Promise<AudioTrack> {
  const data = await getJson<PlayUrlRaw>(
    deps.http, 'playurl',
    `${API}/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${String(cid)}&fnval=16&fourk=1`,
    apiHeaders(await cookieOf(deps)),
  )
  return pickBestAudio(data.dash)
}

export function createBiliPort(options: BiliPortOptions): BiliPort {
  const deps: BiliDeps = { ...options, cookieCache: { value: null } }
  const audio: AudioDeps = {
    http: options.http, process: options.process, ffmpegPath: options.ffmpegPath,
    log: options.log, workRoot: options.workRoot,
  }
  return {
    search: async (keyword, limit, signal) => {
      signal?.throwIfAborted()
      return await searchVideos(deps, keyword, limit)
    },
    videoInfo: async (bvid, signal) => {
      signal?.throwIfAborted()
      return await fetchVideoInfo(deps, bvid)
    },
    downloadAudio: async (bvid, cid, destFile, opts) => {
      opts?.signal?.throwIfAborted()
      const id = assertBvid(bvid)
      const pageId = assertCid(cid)
      const track = await resolveAudioUrl(deps, id, pageId)
      deps.log(`song/bili: ${id} cid=${String(pageId)} 音轨 ${String(track.id)}/${String(track.bandwidth)}bps（${String(track.urls.length)} 条候选地址）`)
      return await downloadTrack(audio, AUDIO_HEADERS, track, { bvid: id, cid: pageId }, destFile, opts)
    },
  }
}
