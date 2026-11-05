/** 音乐：11 个工具。
 *
 * 点歌、发卡片、发语音、歌词、歌单，以及两个平台的登录。
 *
 * 这些 spec **逐字节**来自原来的 `registerQQTools`——P4 的判据是工具名与
 * 参数 schema 一条都不许变（`test/golden/tools/qq-tools.txt` 钉着这一点）。
 * 一个工具一个函数：单看一个工具时不必在 1200 行里找它的边界。
 */

import { systemHttp } from '../../adapters/http/client.js'
import { resolveDshHome } from '../../paths.js'
import { atomicWriteFile } from '../../adapters/fs-store/atomic.js'
import type { OneBotMessageSegment } from '../../types.js'
import {
  loginStatus as neteaseLoginStatus, saveCookie as neteaseSaveCookie,
  searchSongs as neteaseSearch,
  qrLoginStart, qrLoginPoll,
} from '../../adapters/providers/music-netease.js'
import {
  qrLoginPoll as kugouQrPoll, qrLoginStart as kugouQrStart,
  searchSongs as kugouSearch, songUrl as kugouSongUrl,
} from '../../adapters/providers/music-kugou.js'
import { parseLxSources, resolveSongAudio } from './source.js'
import { prepareSong, saveAudio } from './delivery.js'
import type { ToolSpec } from '../../adapters/dsh-host/tools.js'
import type { QQToolDeps } from '../tool-deps.js'

/** `qq_search_music` — 搜索网易云音乐（歌名/歌手）。返回 id、歌名、歌手、时长列表，供点歌时选歌。… */
function qqSearchMusic(deps: QQToolDeps): ToolSpec {
  const {  } = deps
  return {
        name: 'qq_search_music',
        description: '搜索网易云音乐（歌名/歌手）。返回 id、歌名、歌手、时长列表，供点歌时选歌。',
        parameters: {
          type: 'object',
          properties: {
            keyword: { type: 'string', description: '歌名或歌手' },
            limit: { type: 'number', description: '返回条数（默认5，最多10）' },
          },
          required: ['keyword'],
        },
        run: async (args) => {
          const songs = await neteaseSearch(String(args.keyword), Math.min(Number(args.limit ?? 5), 10))
          return { count: songs.length, songs }
        },
      }
}

/** `qq_resolve_music` — 解析一首歌的播放直链/封面/歌词（网易云 songId）。发语音或拿链接前用这个。… */
function qqResolveMusic(deps: QQToolDeps): ToolSpec {
  return {
        name: 'qq_resolve_music',
        description: '解析一首歌的播放直链（网易云 songId）。先问已配置的落雪音源，再退回网易云直链；发语音或拿链接前用这个。',
        parameters: {
          type: 'object',
          properties: {
            songId: { type: 'string', description: '网易云歌曲ID' },
            name: { type: 'string', description: '歌名（可选，音源用它做元数据）' },
            artists: { type: 'string', description: '歌手（可选）' },
          },
          required: ['songId'],
        },
        run: async (args) => {
          const parsed = parseLxSources(deps.config.music.lxSources)
          if (parsed.error !== '') deps.log(`music: ${parsed.error}`)
          const resolved = await resolveSongAudio({
            songId: String(args.songId),
            ...(args.name === undefined ? {} : { name: String(args.name) }),
            ...(args.artists === undefined ? {} : { artists: String(args.artists) }),
          }, {
            sources: parsed.sources,
            defaultQuality: deps.config.music.quality,
            log: deps.log,
          })
          return { audioUrl: resolved.url, via: resolved.via, quality: resolved.quality }
        },
      }
}

/** `qq_send_music_card` — 点歌：解析音源 → 下载 → 发送。
 *
 * 投递方式由后台开关 `music.sendFile` 决定：
 *   - **关（默认）**：语音条，群里点开就能听；
 *   - **开**：`.mp3` 文件（长歌语音条可能被 QQ 客户端截断时用）。
 *
 * 为什么不发"官方音乐卡片"：SnowLuma 的 `music` 段依赖外部签名服务，默认签名
 * 地址已下线，回退的 `com.tencent.structmsg` 旧卡片在现行 QQ 上只显示
 * 「发送者版本过低，无法展示内容」（SnowLuma #365）。
 */
function qqSendMusicCard(deps: QQToolDeps): ToolSpec {
  const { api, out } = deps
  return {
        name: 'qq_send_music_card',
        description: '点歌：解析音源后把歌曲发到群/私聊。默认发语音条；后台「点歌发文件」打开后改发音频文件。',
        parameters: {
          type: 'object',
          properties: {
            target: { type: 'number', description: '群号或好友QQ号' },
            songId: { type: 'string', description: '网易云歌曲ID（来自 qq_search_music）' },
            name: { type: 'string', description: '歌名（可选：文件名与音源元数据用）' },
            artists: { type: 'string', description: '歌手（可选）' },
            private: { type: 'boolean', description: 'true=私聊发送（默认群聊）' },
          },
          required: ['target', 'songId'],
        },
        run: async (args) => {
          const prepared = await prepareSong({
            songId: String(args.songId),
            ...(args.name === undefined ? {} : { name: String(args.name) }),
            ...(args.artists === undefined ? {} : { artists: String(args.artists) }),
          }, deps.config, deps.log)
          const asFile = deps.config.music.sendFile === true
          const segment: OneBotMessageSegment[] = asFile
            ? [{ type: 'file', data: { file: prepared.arg, name: prepared.fileName } }]
            : [{ type: 'record', data: { file: prepared.arg } }]
          try {
            const result = (await out.push(() => (args.private === true
              ? api.sendPrivateMessage(Number(args.target), segment)
              : api.sendGroupMessage(Number(args.target), segment)))) as Record<string, unknown>
            return {
              ...result,
              delivery: asFile ? 'file' : 'voice',
              via: prepared.via,
              quality: prepared.quality,
              ...(asFile ? { file: prepared.fileName, bytes: prepared.bytes } : {}),
            }
          } finally {
            await prepared.cleanup()
          }
        },
      }
}

/** `qq_send_music_voice` — 同一首歌以语音条发送（短歌合适；长歌由 QQ 客户端决定能否播完）。… */
function qqSendMusicVoice(deps: QQToolDeps): ToolSpec {
  const { api, out } = deps
  return {
        name: 'qq_send_music_voice',
        description: '把一首歌以语音条发到群/私聊（先走落雪音源再退回网易云；长歌可能被 QQ 客户端截断，优先用 qq_send_music_card 发文件）。',
        parameters: {
          type: 'object',
          properties: {
            target: { type: 'number', description: '群号或好友QQ号' },
            songId: { type: 'string', description: '网易云歌曲ID' },
            name: { type: 'string', description: '歌名（可选）' },
            artists: { type: 'string', description: '歌手（可选）' },
            private: { type: 'boolean', description: 'true=私聊发送（默认群聊）' },
          },
          required: ['target', 'songId'],
        },
        run: async (args) => {
          const prepared = await prepareSong({
            songId: String(args.songId),
            ...(args.name === undefined ? {} : { name: String(args.name) }),
            ...(args.artists === undefined ? {} : { artists: String(args.artists) }),
          }, deps.config, deps.log)
          const segment: OneBotMessageSegment[] = [{ type: 'record', data: { file: prepared.arg } }]
          try {
            const result = (await out.push(() => (args.private === true
              ? api.sendPrivateMessage(Number(args.target), segment)
              : api.sendGroupMessage(Number(args.target), segment)))) as Record<string, unknown>
            return { ...result, via: prepared.via, quality: prepared.quality }
          } finally {
            // 发送失败也要删：否则每次失败都在磁盘上留一份整首歌。
            await prepared.cleanup()
          }
        },
      }
}

/** `qq_music_lyrics` — 拿一首歌的完整歌词（网易云 songId）。… */
function qqMusicLyrics(deps: QQToolDeps): ToolSpec {
  const { api } = deps
  return {
        name: 'qq_music_lyrics',
        description: '拿一首歌的完整歌词（网易云 songId）。',
        parameters: {
          type: 'object',
          properties: { songId: { type: 'string', description: '网易云歌曲ID' } },
          required: ['songId'],
        },
        run: async (args) => {
          const lrcUrl = `https://api.qijieya.cn/meting/?server=netease&type=lrc&id=${encodeURIComponent(String(args.songId))}`
          const res = await systemHttp.request(lrcUrl)
          if (!res.ok) throw new Error(`歌词获取失败 HTTP ${res.status}`)
          const text = res.text()
          // meting returns JSON array with lrc field when Accept: json
          try {
            const list = JSON.parse(text) as Array<{ lrc?: string }>
            return { lyrics: (list[0]?.lrc ?? text).slice(0, 6000) }
          } catch {
            return { lyrics: text.slice(0, 6000) }
          }
        },
      }
}

/** `qq_music_playlist` — 咱的个人歌单（跨重启持久）。action: add/remove/list/clear。add 需要 songId 和 … */
function qqMusicPlaylist(deps: QQToolDeps): ToolSpec {
  const { config } = deps
  return {
        name: 'qq_music_playlist',
        description: '咱的个人歌单（跨重启持久）。action: add/remove/list/clear。add 需要 songId 和 name。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', description: 'add / remove / list / clear' },
            songId: { type: 'string' },
            name: { type: 'string', description: '歌名（add 时记录）' },
            artists: { type: 'string', description: '歌手（add 时可选）' },
          },
          required: ['action'],
        },
        run: async (args) => {
          const fsMod = await import('node:fs/promises')
          const pathMod = await import('node:path')
          // 与面板（features/music/index.ts）同一个文件；两边的兜底目录也必须一致，
          // 否则没配 workspacePath 时面板和工具会各写一份（2026-10-19 排查）。
          const wsRoot = config.workspacePath ?? pathMod.join(resolveDshHome(), 'channel-qq')
          const file = pathMod.join(wsRoot, 'music-playlist.json')
          type Song = { id: string; name: string; artists?: string; addedAt: number }
          let songs: Song[] = []
          try {
            const parsed: unknown = JSON.parse(await fsMod.readFile(file, 'utf8'))
            if (!Array.isArray(parsed)) throw new Error('内容不是数组')
            songs = parsed as Song[]
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              songs = []
            } else {
              // **读失败绝不能当成空歌单**：紧接着的写回会把用户整份歌单覆盖成 []。
              throw new Error(`歌单读取失败（为避免覆盖原文件，本次未做任何修改）：${error instanceof Error ? error.message : String(error)}`)
            }
          }
          const action = String(args.action)
          if (action === 'add') {
            if (songs.some((s) => s.id === String(args.songId))) return { result: '歌单里已有这首', total: songs.length }
            songs.unshift({ id: String(args.songId), name: String(args.name ?? ''), artists: args.artists === undefined ? undefined : String(args.artists), addedAt: Date.now() })
          } else if (action === 'remove') {
            songs = songs.filter((s) => s.id !== String(args.songId))
          } else if (action === 'clear') {
            songs = []
          } else if (action !== 'list') {
            return { error: 'action 只能是 add/remove/list/clear' }
          }
          // list 是只读的：不重写文件（写回一次就多一次覆盖机会）。
          if (action !== 'list') await atomicWriteFile(file, JSON.stringify(songs, null, 1))
          return { action, total: songs.length, songs: songs.slice(0, 30) }
        },
      }
}

/** `qq_netease_login` — 网易云会员登录。action=start 返回二维码链接（发给学弟用网易云App扫码）；action=poll 用返回的… */
function qqNeteaseLogin(deps: QQToolDeps): ToolSpec {
  const {  } = deps
  return {
        name: 'qq_netease_login',
        description: '网易云会员登录。action=start 返回二维码链接（发给学弟用网易云App扫码）；action=poll 用返回的 key 轮询，成功后自动保存会员 Cookie（VIP歌就能发了）。Cookie 持久保存，不用每次登。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', description: 'start（拿二维码）/ poll（查状态，带 key）' },
            key: { type: 'string', description: 'poll 时传 start 返回的 key' },
          },
          required: ['action'],
        },
        run: async (args) => {
          const action = String(args.action)
          if (action === 'start') {
            const { unikey, qrUrl } = await qrLoginStart()
            return { key: unikey, qrUrl, hint: '把 qrUrl 发给学弟，用网易云音乐App扫码；然后每2秒调一次 action=poll' }
          }
          if (action === 'poll') {
            const result = await qrLoginPoll(String(args.key ?? ''))
            if (result.code === 803 && result.cookie !== '') {
              await neteaseSaveCookie(result.cookie)
              return { status: '登录成功，会员Cookie已保存', cookieSaved: true }
            }
            const meaning = { 800: '二维码已过期，重新 start', 801: '等待扫码', 802: '已扫码待确认', [-1]: '轮询异常' } as Record<number, string>
            return { status: meaning[result.code] ?? (`code=${result.code} ${result.message}`), code: result.code }
          }
          return { error: 'action 只能是 start/poll' }
        },
      }
}

/** `qq_netease_status` — 查网易云账号登录状态和会员等级（判断 VIP 歌能不能发）。… */
function qqNeteaseStatus(deps: QQToolDeps): ToolSpec {
  const {  } = deps
  return {
        name: 'qq_netease_status',
        description: '查网易云账号登录状态和会员等级（判断 VIP 歌能不能发）。',
        parameters: { type: 'object', properties: {} },
        run: async () => neteaseLoginStatus(),
      }
}

/** `qq_kugou_search` — 搜索酷狗音乐（歌名/歌手）。返回 hash、歌名、歌手，供酷狗点歌用。需要先 qq_kugou_login 登录（酷狗禁… */
function qqKugouSearch(deps: QQToolDeps): ToolSpec {
  const {  } = deps
  return {
        name: 'qq_kugou_search',
        description: '搜索酷狗音乐（歌名/歌手）。返回 hash、歌名、歌手，供酷狗点歌用。需要先 qq_kugou_login 登录（酷狗禁止匿名搜索）。',
        parameters: {
          type: 'object',
          properties: {
            keyword: { type: 'string', description: '歌名或歌手' },
            limit: { type: 'number', description: '返回条数（默认5，最多10）' },
          },
          required: ['keyword'],
        },
        run: async (args) => {
          const songs = await kugouSearch(String(args.keyword), Math.min(Number(args.limit ?? 5), 10), deps.config.music.kugouApiBase)
          return { count: songs.length, songs }
        },
      }
}

/** `qq_kugou_send` — 发酷狗歌曲：默认发语音条（VIP歌需要先 qq_kugou_login）。quality 可选 auto/viper_t… */
function qqKugouSend(deps: QQToolDeps): ToolSpec {
  const { api, out } = deps
  return {
        name: 'qq_kugou_send',
        description: '发酷狗歌曲：默认发语音条（VIP歌需要先 qq_kugou_login）。quality 可选 auto/viper_tape/viper_clear/super/high/flac/320/128。',
        parameters: {
          type: 'object',
          properties: {
            target: { type: 'number', description: '群号或好友QQ号' },
            hash: { type: 'string', description: '歌曲hash（来自 qq_kugou_search）' },
            quality: { type: 'string', description: '音质（默认 auto）' },
            private: { type: 'boolean', description: 'true=私聊发送（默认群聊）' },
          },
          required: ['target', 'hash'],
        },
        run: async (args) => {
          const resolved = await kugouSongUrl(String(args.hash), String(args.quality ?? 'auto'), deps.config.music.kugouApiBase)
          const saved = await saveAudio(resolved.url, resolved.extName, deps.config)
          const segment: OneBotMessageSegment[] = [{ type: 'record', data: { file: saved.arg } }]
          try {
            const result = (await out.push(() => (args.private === true
              ? api.sendPrivateMessage(Number(args.target), segment)
              : api.sendGroupMessage(Number(args.target), segment)))) as Record<string, unknown>
            return { ...result, trial: resolved.trial, quality: String(args.quality ?? 'auto') }
          } finally {
            await saved.cleanup()
          }
        },
      }
}

/** `qq_kugou_login` — 酷狗音乐登录。action=start 拿二维码链接（发给学弟用酷狗App扫码）；action=poll 轮询，成功自动… */
function qqKugouLogin(deps: QQToolDeps): ToolSpec {
  const {  } = deps
  return {
        name: 'qq_kugou_login',
        description: '酷狗音乐登录。action=start 拿二维码链接（发给学弟用酷狗App扫码）；action=poll 轮询，成功自动保存 Cookie（VIP歌+搜索就通了）。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', description: 'start / poll' },
            key: { type: 'string', description: 'poll 时传 start 返回的 key' },
          },
          required: ['action'],
        },
        run: async (args) => {
          const action = String(args.action)
          if (action === 'start') {
            const { key, qrUrl } = await kugouQrStart(deps.config.music.kugouApiBase)
            return { key, qrUrl, hint: '把 qrUrl 发给学弟，用酷狗App扫码；然后每2秒调一次 action=poll' }
          }
          if (action === 'poll') {
            const result = await kugouQrPoll(String(args.key ?? ''), deps.config.music.kugouApiBase)
            if (result.status === 'ok') {
              return { status: '登录成功，酷狗Cookie已保存', nickname: result.nickname, cookieSaved: true }
            }
            const meaning = { 0: '等待扫码', 1: '已扫码待确认' } as Record<string, string>
            return { status: meaning[result.status] ?? `status=${result.status}` }
          }
          return { error: 'action 只能是 start/poll' }
        },
      }
}

/** 组装这一组工具。 */
export function musicTools(deps: QQToolDeps): ToolSpec[] {
  return [
    qqSearchMusic(deps),
    qqResolveMusic(deps),
    qqSendMusicCard(deps),
    qqSendMusicVoice(deps),
    qqMusicLyrics(deps),
    qqMusicPlaylist(deps),
    qqNeteaseLogin(deps),
    qqNeteaseStatus(deps),
    qqKugouSearch(deps),
    qqKugouSend(deps),
    qqKugouLogin(deps),
  ]
}
