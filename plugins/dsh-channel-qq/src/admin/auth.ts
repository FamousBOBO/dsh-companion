/** 后台认证：口令来源链、scrypt 校验、会话（滑动续期）、登录限速、CSRF 头校验。
 *
 * 口令来源链（从高到低，内部文档 §8 / D13）：
 *
 *   1. `CHANNEL_QQ_ADMIN_PASSWORD_HASH`  —— scrypt 哈希，**推荐的部署形态**；
 *   2. `CHANNEL_QQ_ADMIN_PASSWORD`       —— 兼容 P0 的明文环境变量（弃用警告，
 *      服务器 /etc/dsh/env 现在就是它，不能删——删了等于把人锁在门外）；
 *   3. `channel-qq/admin-password.json`  —— 后台「安全」页改密后写入的面板口令；
 *   4. `config.admin.password`           —— 历史字段，仅在毫无环境变量时兜底；
 *   5. 全部为空                          —— 首次启动**生成随机口令并打印一次**
 *      （spec §8 抄 AstrBot 的做法；比"登录一律拒绝"更可用，且口令只存在于
 *      本次进程与那行日志里，不存在代码里——不存在"人人相同的默认口令"）。
 *
 * 哈希格式（单行，可整段写进 env）：
 *   `scrypt$<N>$<r>$<p>$<salt-base64>$<key-base64>`
 * 设了但解析不了时**fail-closed**（登录一律拒绝）：一个打错的哈希不该静默降级成
 * "没设密码"。
 *
 * 会话：12 小时滑动续期——每次请求触达时若距上次续期超过 {@link REFRESH_AFTER_MS}
 * 就把过期时间推到 now+12h（并由调用方重发 Cookie）。改密码撤销**全部**会话。
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { atomicWriteFile } from '../adapters/fs-store/atomic.js'

export const HASH_ENV = 'CHANNEL_QQ_ADMIN_PASSWORD_HASH'
export const PASSWORD_ENV = 'CHANNEL_QQ_ADMIN_PASSWORD'

/** 会话时长（12 小时，滑动）。 */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000
/** 距上次续期超过这个间隔才重发 Cookie，避免每个请求都带 Set-Cookie。 */
const REFRESH_AFTER_MS = 5 * 60 * 1000
const LOGIN_WINDOW_MS = 5 * 60 * 1000
const LOGIN_MAX_FAILURES = 10
/** 新密码的长度下限（spec §8）。 */
export const MIN_PASSWORD_LENGTH = 12

const SCRYPT_PARAMS = { N: 16_384, r: 8, p: 1, keylen: 64 } as const

interface ParsedHash {
  N: number
  r: number
  p: number
  salt: Buffer
  key: Buffer
}

/** 生成 scrypt 哈希串（登录校验与 `/api/password` 共用）。 */
export function hashPassword(plain: string, salt: Buffer = randomBytes(16)): string {
  const key = scryptSync(plain, salt, SCRYPT_PARAMS.keylen, {
    N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p,
  })
  return ['scrypt', SCRYPT_PARAMS.N, SCRYPT_PARAMS.r, SCRYPT_PARAMS.p, salt.toString('base64'), key.toString('base64')].join('$')
}

function parseHash(stored: string): ParsedHash | null {
  const parts = stored.trim().split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null
  const N = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p) || N < 2 || r < 1 || p < 1) return null
  try {
    const salt = Buffer.from(parts[4]!, 'base64')
    const key = Buffer.from(parts[5]!, 'base64')
    if (salt.length === 0 || key.length === 0) return null
    return { N, r, p, salt, key }
  } catch {
    return null
  }
}

function verifyParsed(plain: string, parsed: ParsedHash): boolean {
  try {
    const derived = scryptSync(plain, parsed.salt, parsed.key.length, { N: parsed.N, r: parsed.r, p: parsed.p })
    return derived.length === parsed.key.length && timingSafeEqual(derived, parsed.key)
  } catch {
    return false
  }
}

/** 校验明文字符串对 scrypt 哈希串。格式不合法 → false（fail-closed）。 */
export function verifyPassword(plain: string, stored: string): boolean {
  const parsed = parseHash(stored)
  if (parsed === null) return false
  return verifyParsed(plain, parsed)
}

/** 明文对明文的常数时间比较（兼容路径用；两侧先取等长摘要）。 */
function plainMatches(expected: string, supplied: string): boolean {
  const a = scryptSync(expected, 'dsh-admin-cmp', 32, { N: 4096, r: 8, p: 1 })
  const b = scryptSync(supplied, 'dsh-admin-cmp', 32, { N: 4096, r: 8, p: 1 })
  return timingSafeEqual(a, b)
}

/** 去掉易混字符（0/O、1/l/I）的随机口令。 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
export function generatePassword(length = 24): string {
  const bytes = randomBytes(length)
  let out = ''
  for (let i = 0; i < length; i += 1) out += ALPHABET[bytes[i]! % ALPHABET.length]
  return out
}

export type PasswordSourceKind = 'env-hash' | 'env-plain' | 'panel' | 'config' | 'generated'

export interface PasswordSourceInfo {
  kind: PasswordSourceKind
  /** 改密是否由后台接管（env 管着时为 false，UI 显示说明而不是表单）。 */
  canChange: boolean
  /** 给「安全」页显示的一句话（不含任何口令内容）。 */
  label: string
}

export interface AuthOptions {
  dshHome: string
  /** 实时读取 `config.admin.password`（配置可能热改）。 */
  configPassword: () => string
  log: (line: string) => void
}

export class AuthManager {
  private kind: PasswordSourceKind = 'generated'
  private hash: ParsedHash | null = null
  private plain: string | null = null
  private brokenHash = false
  private readonly panelFile: string
  private loggedDeprecation = false

  constructor(private readonly opts: AuthOptions) {
    this.panelFile = path.join(opts.dshHome, 'channel-qq', 'admin-password.json')
  }

  /** 决定本次进程用哪种来源；`generated` 时把口令打印一次。 */
  async load(): Promise<void> {
    const hashEnv = (process.env[HASH_ENV] ?? '').trim()
    if (hashEnv !== '') {
      const parsed = parseHash(hashEnv)
      if (parsed === null) {
        this.kind = 'env-hash'
        this.brokenHash = true
        this.opts.log(`admin panel: ${HASH_ENV} 无法解析（应为 scrypt$N$r$p$salt$key）→ 登录一律拒绝`)
        return
      }
      this.hash = parsed
      this.kind = 'env-hash'
      return
    }
    const plainEnv = (process.env[PASSWORD_ENV] ?? '').trim()
    if (plainEnv !== '') {
      this.plain = plainEnv
      this.kind = 'env-plain'
      this.logDeprecation()
      return
    }
    const panel = await this.readPanel()
    if (panel !== null) {
      this.hash = panel
      this.kind = 'panel'
      return
    }
    const fromConfig = this.opts.configPassword().trim()
    if (fromConfig !== '') {
      this.plain = fromConfig
      this.kind = 'config'
      if (!this.loggedDeprecation) {
        this.loggedDeprecation = true
        this.opts.log('admin panel: 口令来自 config.admin.password（弃用路径），建议改用环境变量 ' + HASH_ENV)
      }
      return
    }
    const generated = generatePassword()
    this.plain = generated
    this.kind = 'generated'
    this.opts.log(`admin panel: 未设置密码，已生成一次性口令（只显示这一次；建议写入 ${HASH_ENV}）：${generated}`)
  }

  private logDeprecation(): void {
    if (this.loggedDeprecation) return
    this.loggedDeprecation = true
    this.opts.log(`admin panel: 口令来自 ${PASSWORD_ENV}（明文环境变量，弃用中）。建议迁移到 ${HASH_ENV}（scrypt 哈希），生成方式见 内部文档`)
  }

  private async readPanel(): Promise<ParsedHash | null> {
    try {
      const raw: unknown = JSON.parse(await fs.readFile(this.panelFile, 'utf-8'))
      if (typeof raw !== 'object' || raw === null) return null
      const record = raw as Record<string, unknown>
      if (record.format !== 'scrypt') return null
      const N = Number(record.N)
      const r = Number(record.r)
      const p = Number(record.p)
      if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return null
      const salt = Buffer.from(String(record.salt ?? ''), 'base64')
      const key = Buffer.from(String(record.key ?? ''), 'base64')
      if (salt.length === 0 || key.length === 0) return null
      return { N, r, p, salt, key }
    } catch {
      return null
    }
  }

  get info(): PasswordSourceInfo {
    const labels: Record<PasswordSourceKind, string> = {
      'env-hash': `由环境变量 ${HASH_ENV} 管理（scrypt 哈希）`,
      'env-plain': `由环境变量 ${PASSWORD_ENV} 管理（明文，建议迁移到 ${HASH_ENV}）`,
      panel: '由本后台管理（channel-qq/admin-password.json，scrypt 哈希）',
      config: '来自 config.admin.password（弃用路径）',
      generated: '本次启动生成的一次性口令（重启后会更换）',
    }
    return {
      kind: this.kind,
      canChange: this.kind === 'panel' || this.kind === 'config' || this.kind === 'generated',
      label: labels[this.kind],
    }
  }

  /** 是否设置了可用口令（任何时候都为 true——generated 也算）。 */
  get configured(): boolean {
    return !this.brokenHash && (this.hash !== null || this.plain !== null)
  }

  verify(plain: string): boolean {
    if (this.brokenHash) return false
    if (this.hash !== null) return verifyParsed(plain, this.hash)
    if (this.plain !== null) return plainMatches(this.plain, plain)
    return false
  }

  /** 改密：校验长度并写入面板口令文件（env 管理时拒绝）。 */
  async change(plain: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const info = this.info
    if (!info.canChange) {
      return { ok: false, reason: `口令当前${info.label}，后台不接管修改。请在服务器上改环境变量后重启 dsh。` }
    }
    if (plain.length < MIN_PASSWORD_LENGTH) {
      return { ok: false, reason: `新密码至少 ${MIN_PASSWORD_LENGTH} 位` }
    }
    const salt = randomBytes(16)
    const key = scryptSync(plain, salt, SCRYPT_PARAMS.keylen, {
      N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p,
    })
    const record = {
      format: 'scrypt', N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p,
      salt: salt.toString('base64'), key: key.toString('base64'),
      updatedAt: new Date().toISOString(),
    }
    await fs.mkdir(path.dirname(this.panelFile), { recursive: true })
    await atomicWriteFile(this.panelFile, JSON.stringify(record, null, 2))
    this.hash = { N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p, salt, key }
    this.plain = null
    this.kind = 'panel'
    return { ok: true }
  }
}

export type TouchResult = 'valid' | 'renewed' | 'invalid'

/** 内存会话表：12 小时 TTL、滑动续期、可整体撤销。 */
export class SessionStore {
  private readonly sessions = new Map<string, { expires: number; renewedAt: number }>()

  create(): string {
    const token = randomBytes(24).toString('hex')
    const now = Date.now()
    this.sessions.set(token, { expires: now + SESSION_TTL_MS, renewedAt: now })
    return token
  }

  touch(token: string): TouchResult {
    const entry = this.sessions.get(token)
    if (entry === undefined) return 'invalid'
    const now = Date.now()
    if (entry.expires <= now) {
      this.sessions.delete(token)
      return 'invalid'
    }
    if (now - entry.renewedAt > REFRESH_AFTER_MS) {
      entry.renewedAt = now
      entry.expires = now + SESSION_TTL_MS
      return 'renewed'
    }
    return 'valid'
  }

  revoke(token: string): void {
    this.sessions.delete(token)
  }

  revokeAll(): void {
    this.sessions.clear()
  }

  get size(): number {
    return this.sessions.size
  }
}

/** 登录失败限速（每 IP）。 */
export class LoginGuard {
  private readonly failures = new Map<string, { count: number; until: number }>()

  blocked(ip: string): boolean {
    const entry = this.failures.get(ip)
    if (entry === undefined) return false
    if (entry.until < Date.now()) {
      this.failures.delete(ip)
      return false
    }
    return entry.count >= LOGIN_MAX_FAILURES
  }

  record(ip: string): void {
    const entry = this.failures.get(ip)
    const now = Date.now()
    if (entry === undefined || entry.until < now) {
      this.failures.set(ip, { count: 1, until: now + LOGIN_WINDOW_MS })
      return
    }
    entry.count += 1
    entry.until = now + LOGIN_WINDOW_MS
  }
}

/** 写请求的 CSRF 校验：自定义头 + 同源（Origin 存在时必须与 Host 一致）。 */
export function checkCsrf(method: string, headers: Record<string, string | string[] | undefined>): string | null {
  const upper = method.toUpperCase()
  if (upper === 'GET' || upper === 'HEAD' || upper === 'OPTIONS') return null
  const marker = headers['x-requested-with']
  if (typeof marker !== 'string' || marker.trim().toLowerCase() !== 'dsh-admin') {
    return '写请求必须带 X-Requested-With: dsh-admin（防 CSRF）'
  }
  const origin = headers.origin
  if (typeof origin === 'string' && origin !== '') {
    try {
      const originHost = new URL(origin).host
      const host = typeof headers.host === 'string' ? headers.host : ''
      if (host !== '' && originHost !== host) return `拒绝跨站来源 ${origin}`
    } catch {
      return `Origin 头无法解析：${origin}`
    }
  }
  return null
}

export function readCookie(cookieHeader: string | undefined, name: string): string | null {
  if (cookieHeader === undefined) return null
  for (const part of cookieHeader.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return rest.join('=')
  }
  return null
}

export const SESSION_COOKIE = 'dsh_admin'

/** HttpOnly; SameSite=Strict（spec §8——严格档在后台这种单一用途站点上没有副作用）。 */
export function cookieHeader(token: string): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
}

export function clearCookieHeader(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0`
}
