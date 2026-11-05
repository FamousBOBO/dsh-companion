/** 音乐子插件：后台「音乐」页的两个资源——歌单与曲库账号。
 *
 * 播歌工具面在 `qq-tools` 的 music 组里（注册顺序属于提示词内容，不拆）；这里承载
 * 的是"面板上能操作的东西"：
 *
 *   - `playlist`：歌单文件（面板加歌/删歌与 `qq_music_playlist` 看的是同一份）；
 *   - `music-account`：两个平台的登录态与扫码登录。凭据由各适配器写进
 *     `/etc/dsh/secrets/`，**不进配置、不进日志**；这里只回"登没登、叫什么"。
 *
 * 二维码图片在浏览器端生成（`src/admin/ui/qr.js`）：这里只回登录 URL，免得把
 * 登录 key 发给任何第三方图片服务。
 */

import * as path from 'node:path'
import { atomicWriteFile } from '../../adapters/fs-store/atomic.js'
import { readJson } from '../../read-json.js'
import {
  clearCookie as neteaseClearCookie, loginStatus as neteaseLoginStatus,
  qrLoginPoll as neteaseQrPoll, qrLoginStart as neteaseQrStart,
  searchSongs as neteaseSearch,
} from '../../adapters/providers/music-netease.js'
import {
  clearCookie as kugouClearCookie, loadCookie as kugouLoadCookie,
  qrLoginPoll as kugouQrPoll, qrLoginStart as kugouQrStart,
  searchSongs as kugouSearch,
} from '../../adapters/providers/music-kugou.js'
import type { SubPlugin } from '../plugin-kit.js'

export const musicPlugin: SubPlugin = {
  name: 'music',
  watches: [],
  apply(host) {
    registerPlaylist(host)
    registerAccount(host)
  },
}

/** 歌单文件读写（面板与工具共用同一份 `music-playlist.json`）。 */
function registerPlaylist(host: Parameters<NonNullable<SubPlugin['apply']>>[0]): void {
  const playlistFile = (): string => path.join(host.config.workspacePath ?? path.join(host.dshHome, 'channel-qq'), 'music-playlist.json')
  host.registerResource('playlist', {
    label: '歌单',
    list: async () => {
      const songs = await readJson<unknown[]>(playlistFile(), [])
      return { count: songs.length, songs }
    },
    create: async (body) => {
      if (host.config.workspacePath === null) throw new Error('未配置工作区')
      const file = playlistFile()
      const songs = await readJson<Array<Record<string, unknown>>>(file, [])
      const songId = String(body.songId ?? '')
      if (songId === '') throw new Error('songId 不能为空')
      if (songs.some((s) => String(s.id) === songId)) return { added: false, note: '歌单里已有这首' }
      songs.unshift({ id: songId, name: String(body.name ?? ''), artists: body.artists === undefined ? undefined : String(body.artists), addedAt: Date.now() })
      await atomicWriteFile(file, JSON.stringify(songs, null, 1))
      return { added: true, total: songs.length }
    },
    remove: async (id) => {
      if (host.config.workspacePath === null) throw new Error('未配置工作区')
      const file = playlistFile()
      const songs = await readJson<Array<Record<string, unknown>>>(file, [])
      const kept = songs.filter((s) => String(s.id) !== id)
      await atomicWriteFile(file, JSON.stringify(kept, null, 1))
      return { removed: songs.length - kept.length }
    },
  })
}

/** 曲库账号：状态 / 扫码登录 / 清除登录 / 搜索自检。 */
function registerAccount(host: Parameters<NonNullable<SubPlugin['apply']>>[0]): void {
  const base = (): string => host.config.music.kugouApiBase
  host.registerResource('music-account', {
    label: '曲库账号',
    list: async () => {
      const netease = await neteaseLoginStatus().catch((error: unknown) => ({
        loggedIn: false, note: error instanceof Error ? error.message : String(error),
      }))
      const kugouCookie = await kugouLoadCookie().catch(() => '')
      return {
        netease,
        kugou: { loggedIn: kugouCookie !== '' },
        kugouApiBase: base(),
      }
    },
    actions: {
      // 适配器返回的是 `unikey`；面板统一按 `key` 用（酷狗也叫 key）。
      neteaseLoginStart: async () => {
        const started = await neteaseQrStart()
        return { key: started.unikey, qrUrl: started.qrUrl }
      },
      neteaseLoginPoll: async (body) => {
        const result = await neteaseQrPoll(String(body.key ?? ''))
        return { code: result.code, message: result.message, done: result.code === 803, cookieSaved: result.code === 803 }
      },
      neteaseLogout: async () => { await neteaseClearCookie(); return { loggedIn: false } },
      kugouLoginStart: async () => await kugouQrStart(base()),
      kugouLoginPoll: async (body) => {
        const result = await kugouQrPoll(String(body.key ?? ''), base())
        // 适配器在成功时已经把 cookie 写进密钥目录；这里只回报状态。
        return { status: result.status, nickname: result.nickname, done: result.status === 'ok' }
      },
      kugouLogout: async () => { await kugouClearCookie(); return { loggedIn: false } },
      search: async (body) => {
        const keyword = String(body.keyword ?? '').trim()
        if (keyword === '') throw new Error('关键词不能为空')
        const provider = String(body.provider ?? 'netease')
        const songs = provider === 'kugou'
          ? await kugouSearch(keyword, 5, base())
          : await neteaseSearch(keyword, 5)
        return { provider, count: songs.length, songs }
      },
    },
  })
}
