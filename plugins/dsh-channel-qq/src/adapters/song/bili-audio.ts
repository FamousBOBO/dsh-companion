/** B站音轨：`playurl` 选流 → 取字节 → ffmpeg 转 wav。
 *
 * 从这里拆出来的理由只有一条：**"挑哪条流"与"怎么把它变成 wav"是两件互不知情的事**，
 * 而它们又都挤在 `bili.ts` 的 400 行上限里。拆开之后 `bili.ts` 只负责接口语义
 * （搜索/视频信息/错误翻译），这里只负责字节与编码。
 *
 * 两个写进代码里的实机事实：
 *
 *   1. **`baseUrl` 不一定通**。B站常把 `baseUrl` 指向 `*.mcdn.bilivideo.cn:8082` 这类边缘
 *      节点，本机实测直接 `ECONNREFUSED`；而同一段音频的 `backupUrl` 一秒就下 6.2 MB。
 *      所以"一个音频 = 一组地址"，逐个试，只有"连不上"才换下一条。
 *   2. **截断的 m4s 比失败更糟**。转出来的 wav 是一段没有结尾的歌，后面的分离/推理会把它
 *      当成一首完整的歌处理。所以超上限直接拒，不转码。
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { HttpClient } from '../../ports/http.js'
import type { ProcessPort } from '../../features/song/types.js'
import { atomicWriteFile } from '../fs-store/atomic.js'

/** 下载字节流用的头：**故意不带 Cookie**（见 `bili.ts` 文件头第 2 条）。 */
export const AUDIO_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Referer: 'https://www.bilibili.com/',
}

/** JSON 端点的体积上限由调用方给；这里只管音频。 */
export const AUDIO_LIMIT = 32 * 1024 * 1024
/** 音频下载超时：比接口长得多，它要真的把字节搬下来。 */
export const AUDIO_TIMEOUT_MS = 60_000
/** ffmpeg 转码超时：一小时音轨也够。 */
const FFMPEG_TIMEOUT_MS = 120_000

/** `playurl` 响应里我们用到的部分（`base_url` / `backup_url` 是旧版字段名，两种都认）。 */
export interface PlayUrlRaw {
  dash?: {
    audio?: Array<{
      id?: number
      bandwidth?: number
      baseUrl?: string
      base_url?: string
      backupUrl?: string[]
      backup_url?: string[]
    }>
  }
  durl?: unknown[]
}

/** 一条音轨：最大带宽那一条，附上它的全部候选地址。 */
export interface AudioTrack {
  readonly urls: readonly string[]
  readonly id: number
  readonly bandwidth: number
}

/**
 * 从 `dash.audio` 里挑一条音轨，并把这条音轨**所有可用的 URL** 排好序。
 *
 * 排序规则：**非 `mcdn` 域优先**（那是实测会不通的那一类），其余按原顺序。
 * 排序不等于保证——所以下面仍然逐个试，全都不行才报错。
 */
export function pickBestAudio(dash: PlayUrlRaw['dash']): AudioTrack {
  let best: AudioTrack | null = null
  for (const item of dash?.audio ?? []) {
    const candidates = [item.baseUrl ?? item.base_url ?? '', ...(item.backupUrl ?? item.backup_url ?? [])]
    const urls = candidates
      .map((raw) => raw.trim())
      .filter((raw) => raw !== '')
      // 协议相对的 `//host/…` 补成 `https:`（B站偶尔给这种形状）。
      .map((raw) => (raw.startsWith('//') ? `https:${raw}` : raw))
      .filter((url) => /^https?:\/\//i.test(url))
    if (urls.length === 0) continue
    const bandwidth = typeof item.bandwidth === 'number' ? item.bandwidth : 0
    if (best === null || bandwidth > best.bandwidth) {
      best = {
        urls: preferDirectHosts([...new Set(urls)]),
        id: typeof item.id === 'number' ? item.id : 0,
        bandwidth,
      }
    }
  }
  if (best === null) throw new Error('B站playurl 失败：dash.audio 里没有可用的音轨（可能只给了 durl / 视频流）')
  return best
}

/** 把 `*.mcdn.bilivideo.cn` 那类边缘节点挪到后面（实测会 `ECONNREFUSED`）。 */
function preferDirectHosts(urls: string[]): string[] {
  const mcdn: string[] = []
  const direct: string[] = []
  for (const url of urls) {
    let host = ''
    try { host = new URL(url).host } catch { host = '' }
    if (/\.mcdn\./i.test(host)) mcdn.push(url)
    else direct.push(url)
  }
  return [...direct, ...mcdn]
}

/** 下载与转码需要的依赖（只有这几个，都不认识 B站 API）。 */
export interface AudioDeps {
  readonly http: HttpClient
  readonly process: ProcessPort
  readonly ffmpegPath: string
  readonly log: (line: string) => void
  readonly workRoot: string
}

/**
 * 把一条音轨下下来并转成 44.1 kHz / 立体声 / pcm_s16le 的 wav。
 *
 * 临时 `.m4s` 用 `finally` 删掉：一个 6.7 MB 的残留，点十首歌就是 67 MB。
 */
export async function downloadTrack(
  deps: AudioDeps,
  headers: Record<string, string>,
  track: AudioTrack,
  names: { bvid: string; cid: number },
  destFile: string,
  opts: { timeoutMs?: number; signal?: AbortSignal } | undefined,
): Promise<{ file: string; bytes: number }> {
  const timeoutMs = opts?.timeoutMs ?? AUDIO_TIMEOUT_MS
  const fetched = await fetchFirstReachable(deps, headers, track.urls, timeoutMs)
  if (fetched.truncated) throw new Error(`B站音轨超过 ${String(AUDIO_LIMIT)} 字节上限，拒绝截断后转码`)
  if (!fetched.ok) throw new Error(`B站音轨下载失败：HTTP ${String(fetched.status)}（${String(track.id)} 码率）`)

  const tmp = path.join(deps.workRoot, `${names.bvid}-${String(names.cid)}-${String(track.id)}.m4s`)
  await atomicWriteFile(tmp, fetched.bytes)
  try {
    const converted = await deps.process.run(
      deps.ffmpegPath,
      ['-v', 'error', '-y', '-i', tmp, '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', destFile],
      { timeoutMs: FFMPEG_TIMEOUT_MS, signal: opts?.signal },
    )
    if (converted.timedOut) throw new Error(`ffmpeg 转码超时（${String(converted.durationMs)}ms）`)
    if (converted.code !== 0) {
      throw new Error(`ffmpeg 转码失败（exit ${String(converted.code)}）：${converted.stderr.trim().slice(-400)}`)
    }
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => { /* 删不掉也不该让整条链路失败 */ })
  }
  const stat = await fs.stat(destFile)
  deps.log(`song/bili: 音轨已就绪 ${destFile}（下载 ${String(fetched.bytes.length)} 字节 → wav ${String(stat.size)} 字节）`)
  return { file: destFile, bytes: stat.size }
}

/** 一次取到的响应（`bytes` 类型与 `HttpClient` 的返回一致）。 */
interface Fetched {
  readonly ok: boolean
  readonly status: number
  readonly bytes: Uint8Array
  readonly truncated: boolean
}

/**
 * 逐个试地址，返回**第一个拿到的、可用的 HTTP 响应**。
 *
 * 两类错误会被下一个地址接住：
 *   1. **连不上**（`ECONNREFUSED` / `ECONNRESET` / 超时）——这条路不通；
 *   2. **上游临时不可用**（429 / 502 / 503 / 504）——实机踩过：`30280` 的
 *      `baseUrl` 回 `HTTP 503`，而同一段音频的 `backupUrl` 立刻能下 6 MB。
 *      这几个码的语义就是"现在不行，等会儿/换个节点再试"。
 *
 * **其余非 2xx 不换地址**：403 / 404 是上游说"你没有权限 / 文件没了"，
 * 换备份地址多半也一样，而且会把真正的错误信息藏起来。
 *
 * 如果所有地址都给临时错误，返回**最后一个**响应——让调用方按"下载失败：
 * HTTP 503"收场，而不是把它误报成"连不上"。
 */
async function fetchFirstReachable(
  deps: AudioDeps,
  headers: Record<string, string>,
  urls: readonly string[],
  timeoutMs: number,
): Promise<Fetched> {
  const failures: string[] = []
  let lastTransient: Fetched | null = null
  for (const url of urls) {
    try {
      const response = await deps.http.request(url, { headers, timeoutMs, limit: AUDIO_LIMIT })
      if (!response.ok && isTransientStatus(response.status)) {
        lastTransient = response
        deps.log(`song/bili: 这条音轨地址暂时不可用（HTTP ${String(response.status)}），换下一条`)
        continue
      }
      return response
    } catch (error) {
      const reason = describeReachFailure(error)
      failures.push(reason)
      deps.log(`song/bili: 这条音轨地址连不上（${reason}），换下一条`)
    }
  }
  if (lastTransient !== null) return lastTransient
  throw new Error(`B站音轨的 ${String(urls.length)} 条地址都连不上：${failures.join('；')}`)
}

/** 上游"现在不行、换个节点/等会儿再试"的状态码。 */
function isTransientStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504
}

/** 连不上的一行说明（不打印完整 URL：里面有签名参数，日志会被截图外传）。 */
function describeReachFailure(error: unknown): string {
  const cause = (error as { cause?: { code?: string; message?: string } }).cause
  const code = cause?.code ?? cause?.message ?? (error instanceof Error ? error.message : String(error))
  return String(code)
}
