/** KuGou music via self-hosted KuGouMusicApi server (port 4000).
 *
 * Ported from astrbot_plugin_kugoumusic (analyzed):
 * - server: github.com/MakcRe/KuGouMusicApi, started with PORT=4000
 * - /register/dev once to get dfid (device id), persisted
 * - /search (needs login token after kugou banned anonymous search: error_code 152)
 * - /song/url?hash=..&quality=.. -> { url|backupUrl[], status(1 ok/2 quality degrade), extName }
 * - QR login: /login/qr/key -> /login/qr/create -> /login/qr/check (token+userid)
 * - Cookie storage: `/etc/dsh/secrets/kugou-cookie`（600；dfid 同目录，见
 *   `adapters/fs-store/secrets.ts`；旧位置会在首次读取时自动搬过去）。
 */

import { systemHttp } from '../http/client.js'
import { readSecret, removeSecret, writeSecret } from '../fs-store/secrets.js'

const DEFAULT_BASE = 'http://127.0.0.1:4000'

/**
 * 基地址：显式传入（后台配置）优先 → 环境变量 `KUGOU_API_BASE` → 本机默认。
 * **每次调用现取**，所以后台改完立即生效，不用重启。
 */
function baseOf(override?: string): string {
  const raw = (override ?? '').trim() || (process.env.KUGOU_API_BASE ?? '').trim() || DEFAULT_BASE
  return raw.replace(/\/+$/, '')
}
// cookie 与 dfid 都进 /etc/dsh/secrets（600），不再混在 dshHome 的数据目录里。
const COOKIE_NAME = 'kugou-cookie'
const DFID_NAME = 'kugou-dfid'

export async function loadCookie(): Promise<string> {
  return await readSecret(COOKIE_NAME)
}

export async function clearCookie(): Promise<void> {
  await removeSecret(COOKIE_NAME)
}

export async function saveCookie(cookie: string): Promise<void> {
  await writeSecret(COOKIE_NAME, cookie)
}

async function ensureDfid(base: string): Promise<string> {
  const existing = await readSecret(DFID_NAME)
  if (existing !== '') return existing
  const res = await kgRequest(`${base}/register/dev`, { allowPrivateHosts: true })
  const body = (await res.json()) as { data?: { dfid?: string } }
  const dfid = body.data?.dfid ?? ''
  if (dfid === '') throw new Error('register/dev 拿不到 dfid')
  await writeSecret(DFID_NAME, dfid)
  return dfid
}

/**
 * 请求本机 KuGouMusicApi。连不上时把 `fetch failed` 翻译成"该起什么服务"——
 * 后台面板会把这句原样显示给主人（2026-10-19："fetch failed" 没人看得懂）。
 */
async function kgRequest(url: string, options: { timeoutMs?: number; allowPrivateHosts?: boolean } = {}) {
  try {
    return await systemHttp.request(url, options)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`酷狗 API 不可达（${url.split('?')[0]}）：${reason}。先在本机启动 KuGouMusicApi（默认 4000 端口），或在后台「音乐」页改地址。`)
  }
}

async function kgGet(path: string, params: Record<string, string>, anonFallback = false, override?: string): Promise<any> {
  const base = baseOf(override)
  const dfid = await ensureDfid(base)
  const cookie = await loadCookie()
  const search = new URLSearchParams({ ...params, dfid })
  // kugou banned anonymous search (error_code 152): needs logged cookie; anonymous
  // placeholder only helps /search per kugoumusic plugin notes.
  if (cookie === '') {
    if (anonFallback) search.set('token', 'kg')
  } else {
    search.set('cookie', cookie)
  }
  // 这个基地址是运维自己填的本机服务（KuGouMusicApi），属于 HTTP 闸门允许的
  // 「显式配置的地址」一类——必须显式放行，否则每次都会报「内网/保留地址」。
  const res = await kgRequest(`${base}${path}?${search.toString()}`, {
    timeoutMs: 20_000,
    allowPrivateHosts: true,
  })
  const body = (await res.json()) as any
  return body
}

export interface KugouSearchHit {
  hash: string
  name: string
  singers: string
  durationSec?: number
}

export async function searchSongs(keyword: string, limit = 5, base?: string): Promise<KugouSearchHit[]> {
  const body = await kgGet('/search', { keywords: keyword, type: 'song', page: '1', pagesize: String(Math.min(limit, 10)) }, true)
  if (body.status !== 1) {
    const code = body.error_code
    throw new Error(code === 152 ? '酷狗搜索需要登录：先 qq_kugou_login 扫码' : `酷狗搜索失败: ${body.error_msg ?? body.msg ?? code}`)
  }
  const lists = body.data?.lists ?? []
  return lists.map((item: any) => ({
    hash: item.hash ?? item.FileHash ?? '',
    name: item.name ?? item.SongName ?? '',
    singers: (item.singers ?? []).map((s: any) => s.name ?? s).join('/'),
    durationSec: item.duration !== undefined ? Math.round(item.duration / 1000) : undefined,
  }))
}

export interface KugouUrlResult {
  url: string
  status: number
  trial: boolean
  extName: string
}

/** Resolve playback URL for a hash. quality: auto|viper_tape|viper_clear|super|high|flac|320|128 */
export async function songUrl(hash: string, quality = 'auto', override?: string): Promise<KugouUrlResult> {
  const body = await kgGet('/song/url', { hash, quality }, false, override)
  const pick = (item: any): string => {
    for (const key of ['url', 'backupUrl']) {
      const v = item[key]
      if (Array.isArray(v)) {
        const first = v.find((u: string) => Boolean(u))
        if (first !== undefined) return String(first)
      } else if (v) return String(v)
    }
    return ''
  }
  const url = pick(body)
  if (url === '') throw new Error(`酷狗拿不到链接 (status=${body.status} error_code=${body.error_code})`)
  const trial = url.toLowerCase().includes('p_0_') && !url.toLowerCase().includes('full')
  return { url, status: body.status ?? 0, trial, extName: body.extName ?? 'mp3' }
}

/** QR login step 1: key + QR image URL. */
export async function qrLoginStart(override?: string): Promise<{ key: string; qrUrl: string }> {
  const keyBody = await kgGet('/login/qr/key', { timestamp: String(Date.now()) }, false, override)
  const key = keyBody.data?.qrcode ?? ''
  if (key === '') throw new Error('拿不到酷狗登录 key')
  const create = await kgGet('/login/qr/create', { key, qrimg: 'true' }, false, override)
  const qrUrl = create.data?.url ?? `https://activity.kugou.com/static/login/index.html?key=${encodeURIComponent(key)}`
  return { key, qrUrl }
}

/** QR login step 2: poll. Returns cookie on success. */
export async function qrLoginPoll(key: string, override?: string): Promise<{ status: string; cookie: string; nickname?: string }> {
  const body = await kgGet('/login/qr/check', { key, timestamp: String(Date.now()) }, false, override)
  const data = body.data ?? {}
  const status = String(data.status ?? body.status ?? '')
  if (status === '1' || body.status === 1) {
    const token = data.token ?? ''
    const userid = data.userid ?? ''
    if (token !== '') {
      const cookie = `token=${token};userid=${userid}`
      await saveCookie(cookie)
      return { status: 'ok', cookie, nickname: data.nickname }
    }
  }
  return { status, cookie: '' }
}
