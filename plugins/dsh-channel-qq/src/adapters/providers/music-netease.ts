/** Netease VIP playback for dsh-channel-qq.
 *
 * Path (verified live from this host): POST /api/song/enhance/player/url with
 * {ids:[..], br:..} + member Cookie (MUSIC_U=...) -> url for VIP/fee tracks.
 * weapi is WAF-blocked from datacenter IPs (200 + empty body) — avoided.
 * QR login: /api/login/qrcode/unikey (key) + /api/login/qrcode/client/login (poll,
 * 803 = cookie in Set-Cookie). Member check: /api/vip/info/ or login/status.
 *
 * Cookie storage: `/etc/dsh/secrets/netease-cookie`（600；见 `adapters/fs-store/secrets.ts`，
 * 旧位置 `<dshHome>/channel-qq/netease-cookie.txt` 会在首次读取时自动搬过去）。
 */

import { systemHttp } from '../http/client.js'
import { readSecret, removeSecret, writeSecret } from '../fs-store/secrets.js'

const COOKIE_NAME = 'netease-cookie'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0'

export async function loadCookie(): Promise<string> {
  return await readSecret(COOKIE_NAME)
}

export async function clearCookie(): Promise<void> {
  await removeSecret(COOKIE_NAME)
}

export async function saveCookie(cookie: string): Promise<void> {
  await writeSecret(COOKIE_NAME, cookie)
}

function cookieHeader(extra = 'appver=2.0.2'): string {
  return extra
}

/** POST form to music.163.com /api/ endpoint, parse JSON. */
async function apiPost(path: string, params: Record<string, string>, cookie?: string): Promise<any> {
  const res = await systemHttp.request(`https://music.163.com${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: 'https://music.163.com/',
      'User-Agent': UA,
      Cookie: [cookieHeader(), cookie].filter((v) => v !== undefined && v !== '').join('; '),
    },
    body: new URLSearchParams(params).toString(),
  })
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`网易云响应异常 (HTTP ${res.status}): ${text.slice(0, 100)}`)
  }
}

export interface NeteaseSearchHit {
  id: string
  name: string
  artists: string
  durationSec?: number
}

/**
 * 搜索歌曲。
 *
 * 端点用 `cloudsearch/pc`：`/api/search/get/web` 从 2026-10 起返回的是加密串
 * （`{"result":"35b1…"}`），解析出来永远是空列表——2026-10-19 实测发现。
 * 两个端点的字段名不同（`ar`/`dt` vs `artists`/`duration`），所以两个都认。
 */
export async function searchSongs(keyword: string, limit = 5): Promise<NeteaseSearchHit[]> {
  const data = await apiPost('/api/cloudsearch/pc', {
    s: keyword,
    limit: String(Math.min(limit, 10)),
    type: '1',
    offset: '0',
  }, 'appver=2.0.2')
  const songs = (data as { result?: { songs?: any[] } }).result?.songs ?? []
  return songs.map((s: any) => {
    const artists = (s.ar ?? s.artists ?? []) as any[]
    const duration = (s.dt ?? s.duration) as number | undefined
    return {
      id: String(s.id),
      name: s.name,
      artists: artists.map((a: any) => a.name).join('/'),
      durationSec: duration !== undefined ? Math.round(duration / 1000) : undefined,
    }
  })
}

export interface NeteaseUrlResult {
  url: string | null
  fee: number
  code: number
  br: number
  size: number
  vipRequired: boolean
}

/** Resolve playable URL. Cookie with MUSIC_U unlocks VIP/fee tracks; br is bitrate (999000 = max). */
export async function songUrl(songId: string, br = 320000, cookie?: string): Promise<NeteaseUrlResult> {
  const effectiveCookie = cookie !== undefined && cookie !== '' ? cookie : await loadCookie()
  const data = await apiPost('/api/song/enhance/player/url', {
    br: String(br),
    ids: `[${Number(songId)}]`,
  }, effectiveCookie === '' ? 'appver=2.0.2' : effectiveCookie)
  const item = (data.data ?? [])[0] ?? {}
  return {
    url: typeof item.url === 'string' ? item.url : null,
    fee: item.fee ?? 0,
    code: item.code ?? data.code ?? 0,
    br: item.br ?? 0,
    size: item.size ?? 0,
    vipRequired: item.url === null && (item.fee === 1 || item.fee === 4 || item.fee === 16),
  }
}

/** QR login step 1: get unikey + QR image URL. */
export async function qrLoginStart(): Promise<{ unikey: string; qrUrl: string }> {
  const body = await apiPost('/api/login/qrcode/unikey', { type: '3' })
  const unikey = body.unikey ?? ''
  if (unikey === '') throw new Error('拿不到登录 key（可能被风控），稍后再试')
  return { unikey, qrUrl: `https://music.163.com/login?codekey=${unikey}` }
}

/** QR login step 2: poll. 800 expired / 801 waiting / 802 scanned / 803 success(+cookie). */
export async function qrLoginPoll(unikey: string): Promise<{ code: number; message: string; cookie: string }> {
  const res = await systemHttp.request('https://music.163.com/api/login/qrcode/client/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: 'https://music.163.com/', 'User-Agent': UA },
    body: new URLSearchParams({ key: unikey, type: '3' }).toString(),
  })
  const body = res.json<{ code?: number; message?: string; msg?: string }>()
  let cookie = ''
  for (const line of res.headerValues('set-cookie')) {
    // `?? ''`：split 在 noUncheckedIndexedAccess 下返回 `string | undefined`。
    // 实际永远有元素（空串也会 split 出一个 ''），加它只是为了把类型说清楚。
    const first = (line.split(';', 1)[0] ?? '').trim()
    if (first.startsWith('MUSIC_U=') || first.startsWith('__csrf=') || first.startsWith('MUSIC_A=')) {
      cookie = cookie === '' ? first : `${cookie}; ${first}`
    }
  }
  return { code: body.code ?? -1, message: body.message ?? body.msg ?? '', cookie }
}

/** Login status + VIP level from the stored cookie. */
export async function loginStatus(): Promise<{ loggedIn: boolean; nickname?: string; vipType?: string }> {
  const cookie = await loadCookie()
  if (cookie === '') return { loggedIn: false }
  const data = await apiPost('/api/nuser/account/get', {}, cookie)
  const profile = data.profile
  if (profile === undefined || profile === null) return { loggedIn: false }
  let vipType = '普通'
  try {
    const vip = await apiPost('/api/vip/info/', {}, cookie)
    const v = vip.data ?? {}
    if (v.redVipLevel !== undefined || v.redVipDynamicIconUrl !== undefined) vipType = `黑胶VIP Lv.${v.redVipLevel ?? '?'}`
  } catch { /* keep 普通 */ }
  return { loggedIn: true, nickname: profile.nickname, vipType }
}
