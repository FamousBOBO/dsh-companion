/** 点歌的音源解析：先问落雪音源（LX 自定义源），再退回网易云直链。
 *
 * 为什么需要多级：网易云对未登录/风控的请求经常返回 `url: null`（线上实测，
 * 即使 `fee: 0`），而 LX 音源正是把"能播的地址"这件事交给第三方服务解决。
 * 音源失败不该让点歌整个失败——下一顺位继续试，最后一条都不行才报错，并把每个
 * 音源的失败原因带出来（后台日志与工具返回值都能看到）。
 */

import { loadLxSource } from '../../adapters/lx-source/runtime.js'
import { songUrl as neteaseSongUrl } from '../../adapters/providers/music-netease.js'

/** 一条配置好的 LX 音源。 */
export interface LxSourceConfig {
  readonly name: string
  readonly url: string
  readonly enabled: boolean
  /** 请求音质（`128k` / `320k` / `flac`…；各音源支持范围不同）。 */
  readonly quality: string
}

export interface SongRequest {
  readonly songId: string
  readonly name?: string
  readonly artists?: string
  /** 覆盖默认音质。 */
  readonly quality?: string
}

export interface ResolvedAudio {
  readonly url: string
  /** `lx:<音源名>` 或 `netease`，便于日志与工具结果说明来源。 */
  readonly via: string
  readonly quality: string
}

export interface ResolveDeps {
  readonly sources: readonly LxSourceConfig[]
  readonly defaultQuality: string
  readonly log: (line: string) => void
  /** 测试注入。 */
  readonly loader?: typeof loadLxSource
  readonly netease?: typeof neteaseSongUrl
}

/**
 * 解析 `music.lxSources`：JSON 数组，元素可以是对象或直接的 URL 字符串。
 *
 * 坏 JSON 当"没有音源"并给出原因——点歌不能因为一个配置写错就整个不可用。
 */
export function parseLxSources(raw: string): { sources: LxSourceConfig[]; error: string } {
  const text = String(raw ?? '').trim()
  if (text === '') return { sources: [], error: '' }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { sources: [], error: `音源配置不是合法 JSON：${(error as Error).message}` }
  }
  if (!Array.isArray(parsed)) return { sources: [], error: '音源配置必须是数组' }
  const out: LxSourceConfig[] = []
  for (const item of parsed) {
    const source = typeof item === 'string'
      ? { name: nameOfUrl(item), url: item, enabled: true, quality: '' }
      : objectSource(item)
    if (source === null) continue
    if (!/^https?:\/\//i.test(source.url)) continue
    if (out.some((existing) => existing.url === source.url)) continue
    out.push(source)
  }
  return { sources: out, error: '' }
}

function objectSource(item: unknown): LxSourceConfig | null {
  if (item === null || typeof item !== 'object') return null
  const record = item as Record<string, unknown>
  const url = String(record.url ?? '').trim()
  if (url === '') return null
  return {
    name: String(record.name ?? '').trim() || nameOfUrl(url),
    url,
    enabled: record.enabled !== false,
    quality: String(record.quality ?? '').trim(),
  }
}

function nameOfUrl(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return 'lx'
  }
}

/** 歌名归一化：去掉括号里的备注与标点，用于"按歌名重试"时判断是不是同一首。 */
export function normalizeSongName(name: string): string {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
}

/** 音源请求用的 `musicInfo`：`wy` 认 `songmid`，其它平台也常读 `id`/`hash`。 */
function musicInfoOf(req: SongRequest): Record<string, unknown> {
  return {
    songmid: req.songId,
    id: req.songId,
    hash: req.songId,
    ...(req.name === undefined ? {} : { name: req.name }),
    ...(req.artists === undefined ? {} : { singer: req.artists }),
  }
}

export async function resolveSongAudio(req: SongRequest, deps: ResolveDeps): Promise<ResolvedAudio> {
  const quality = (req.quality ?? deps.defaultQuality ?? '320k').trim() || '320k'
  const failures: string[] = []
  for (const source of deps.sources) {
    if (!source.enabled) continue
    try {
      const loaded = await (deps.loader ?? loadLxSource)(source.url, { log: deps.log })
      const url = await loaded.resolveUrl({
        source: 'wy',
        musicInfo: musicInfoOf(req),
        quality: source.quality === '' ? quality : source.quality,
      })
      deps.log(`music: 音源 ${source.name} 解析成功（${req.name ?? req.songId}）`)
      return { url, via: `lx:${source.name}`, quality: source.quality === '' ? quality : source.quality }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      failures.push(`${source.name}: ${reason}`)
      deps.log(`music: 音源 ${source.name} 失败：${reason}`)
    }
  }
  const direct = await (deps.netease ?? neteaseSongUrl)(req.songId, 320000)
  if (direct.url !== null) {
    return { url: direct.url, via: 'netease', quality: '320k' }
  }
  const tail = failures.length === 0 ? '' : `（音源失败：${failures.join('；')}）`
  throw new Error(`${direct.vipRequired ? '该曲为 VIP/付费歌曲，且没有可用的音源' : '拿不到播放直链'}${tail}`)
}
