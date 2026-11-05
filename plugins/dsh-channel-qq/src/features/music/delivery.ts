/** 点歌的落盘与投递：解析（LX 音源 → 网易云）、下载、放到 NapCat 读得到的位置。
 *
 * 为什么要专门一段：NapCat 在容器里跑，**读不到 `/root`**（权限 700），而插件的
 * `dshHome` 就在 `~/.dsh`。以前点歌把临时文件写在那里，于是：
 *   - 路径直传 → `EACCES: stat ~/.dsh/…`（2026-10-21 实测）；
 *   - 退回 base64 → 9MB 的歌超过 8MiB 内联上限，还是发不出去。
 * 所以临时文件一律写到**工作区**（它被挂进容器、路径可读），再用 `napcatFileArg`
 * 交给 NapCat；发送结束立刻删掉。
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { systemHttp } from '../../adapters/http/client.js'
import { atomicWriteFile } from '../../adapters/fs-store/atomic.js'
import { napcatFileArg } from '../../local-file.js'
import { resolveDshHome } from '../../paths.js'
import { searchSongs as neteaseSearch } from '../../adapters/providers/music-netease.js'
import type { QQChannelConfig } from '../../config.js'
import { MAX_DOWNLOAD_BYTES } from '../download-limit.js'
import { parseLxSources, resolveSongAudio, normalizeSongName, type SongRequest } from './source.js'

export interface SavedAudio {
  /** 本地绝对路径。 */
  readonly file: string
  /** 交给 OneBot 的 `file` 值（`file://` 或 `base64://`）。 */
  readonly arg: string
  readonly bytes: number
  cleanup(): Promise<void>
}

/** 音乐临时目录：优先工作区（容器可读），没有工作区才退回 dshHome。 */
export function musicTmpDir(config: QQChannelConfig): string {
  const root = config.workspacePath ?? path.join(resolveDshHome(), 'channel-qq')
  return path.join(root, 'music-tmp')
}

/** 文件名里不能出现的字符（跨平台保守取交集）。 */
export function safeSongName(name: string, fallback: string): string {
  const cleaned = String(name ?? '').replace(/[\\/:*?"<>|\r\n]/g, ' ').replace(/\s+/g, ' ').trim()
  return (cleaned === '' ? fallback : cleaned).slice(0, 80)
}

/** 下载音频并落盘；调用方负责 `cleanup()`。 */
export async function saveAudio(url: string, ext: string, config: QQChannelConfig): Promise<SavedAudio> {
  const audio = await systemHttp.request(url, { limit: MAX_DOWNLOAD_BYTES })
  if (!audio.ok) throw new Error(`音频下载失败 HTTP ${audio.status}`)
  const dir = musicTmpDir(config)
  await fs.mkdir(dir, { recursive: true })
  const suffix = ext.startsWith('.') ? ext : `.${ext}`
  const file = path.join(dir, `song_${Date.now()}_${Math.floor(Math.random() * 1e6)}${suffix}`)
  await atomicWriteFile(file, Buffer.from(audio.bytes))
  const arg = await napcatFileArg(file)
  return {
    file,
    arg,
    bytes: audio.bytes.length,
    cleanup: async () => { await fs.rm(file, { force: true }).catch(() => {}) },
  }
}

/** 给 OneBot `file` 段的展示名。 */
export function songFileName(req: SongRequest, ext = '.mp3'): string {
  const base = safeSongName(
    [req.name, req.artists].filter((part) => part !== undefined && part !== '').join(' - '),
    req.songId,
  )
  return `${base}${ext}`
}

export interface PreparedSong extends SavedAudio {
  readonly via: string
  readonly quality: string
  readonly fileName: string
}

/** 解析 → 下载 → 可投递。音源与网易云的顺序见 `resolveSongAudio`。
 *
 * 指定 id 解析失败时，如果知道歌名就**按歌名重试前三个搜索命中**：模型有时会
 * 挑到同名翻唱或不可播的条目（2026-10-21：`焚爱` 被点成另一个 id，两个音源都
 * 返回 404，而正确条目其实两边都能解析）。
 */
export async function prepareSong(
  req: SongRequest,
  config: QQChannelConfig,
  log: (line: string) => void,
): Promise<PreparedSong> {
  try {
    return await prepareOnce(req, config, log)
  } catch (error) {
    if (req.name === undefined || req.name.trim() === '') throw error
    const reason = error instanceof Error ? error.message : String(error)
    log(`music: ${req.songId} 解析失败（${reason.slice(0, 80)}），按歌名重试`)
    let hits
    try {
      hits = await neteaseSearch(`${req.name} ${req.artists ?? ''}`.trim(), 5)
    } catch {
      throw error
    }
    // 只认歌名对得上的命中："焚爱" 的搜索结果里第一首是《雨爱》，直接按顺序试
    // 会把用户点的歌换成另一首（2026-10-21 实测）。对不上就不替换，原样报错。
    const wanted = normalizeSongName(req.name)
    const matches = hits.filter((hit) => {
      const found = normalizeSongName(hit.name)
      return found !== '' && (found.includes(wanted) || wanted.includes(found))
    })
    if (matches.length === 0) throw error
    for (const hit of matches.slice(0, 3)) {
      if (hit.id === req.songId) continue
      try {
        const prepared = await prepareOnce({ ...req, songId: hit.id, name: hit.name, artists: hit.artists }, config, log)
        log(`music: 按歌名重试成功 ${hit.name} - ${hit.artists}（${hit.id}）`)
        return prepared
      } catch { /* 试下一个命中 */ }
    }
    throw error
  }
}

async function prepareOnce(
  req: SongRequest,
  config: QQChannelConfig,
  log: (line: string) => void,
): Promise<PreparedSong> {
  const parsed = parseLxSources(config.music.lxSources)
  if (parsed.error !== '') log(`music: ${parsed.error}`)
  const resolved = await resolveSongAudio(req, {
    sources: parsed.sources,
    defaultQuality: config.music.quality,
    log,
  })
  const ext = extensionOf(resolved.url)
  const saved = await saveAudio(resolved.url, ext, config)
  return { ...saved, via: resolved.via, quality: resolved.quality, fileName: songFileName(req, ext) }
}

/** 从 URL 猜扩展名（拿不到就 mp3；点歌几乎都是 mp3/flac/m4a）。 */
export function extensionOf(url: string): string {
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase()
    return /^\.(mp3|flac|m4a|aac|ogg|wav)$/.test(ext) ? ext : '.mp3'
  } catch {
    return '.mp3'
  }
}
