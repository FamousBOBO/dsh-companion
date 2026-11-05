/** Admin panel: password-gated HTTP surface over the channel's live config.
 *
 * Design constraints this file exists to satisfy:
 *
 * 1. **The panel is the source of truth after the first save.** Config resolves as
 *    `DEFAULT_CONFIG ← cordis patch ← admin-config.json`, so once an operator saves
 *    here the persisted override wins on every later boot.
 *
 * 2. **Edits apply to the running process, not just to disk.** Consumers captured
 *    `config` (and sub-objects) by reference at init, so writes merge *into* the
 *    live object graph (in place, arrays spliced) instead of replacing it.
 *
 * 3. **A save is visible before and after.** `POST /api/config` validates against
 *    the schema, carries a `baseVersion` (409 on someone else's concurrent save),
 *    records the change list in history (rollback source), audits it, then runs
 *    `applyEffects` and reports per-setting results. Fields the schema marks
 *    `hot: 'restart'` come back in `restartRequired` instead of silently no-oping.
 *
 * 4. **Secrets never leave in the clear.** `/api/snapshot` masks every `secret`
 *    field to `''` plus a `meta.secretSet` map; logs/audit text is masked. The
 *    password itself lives in `admin/auth.ts` (env scrypt hash preferred).
 *
 * Auth: password exchange mints an in-memory session (12h sliding) handed out as
 * an HttpOnly; SameSite=Strict cookie. Writes require `X-Requested-With: dsh-admin`
 * (CSRF) and land in `channel-qq/audit.jsonl`. Live pushes go over SSE.
 */

import * as http from 'node:http'
import { promises as fs, readFileSync } from 'node:fs'
import * as path from 'node:path'
import { adminOverridePath } from './config.js'
import { ADMIN_PAGES } from './config/pages.js'
import { hotOfPath, restartPaths, schemaView } from './config/meta.js'
import { bundleLookup, contentTypeOf } from './admin/assets.js'
import { LiveFeed } from './admin/live.js'
import { EventHub } from './admin/sse.js'
import { AuditLog } from './admin/audit.js'
import {
  AuthManager, LoginGuard, SessionStore,
  checkCsrf, clearCookieHeader, cookieHeader, readCookie,
} from './admin/auth.js'
import {
  ConfigHistory, computeChanges, describeIssues, inversePatch, maskConfigForView,
  maskSecretText, restartPathsIn, secretValuesOf, validatePatch, walkLeaves,
  type ChangeEntry, type Json,
} from './admin/config-engine.js'
import { routeReadData, routeWriteData, routeWriteMisc, type DataRouteEnv } from './admin/routes-data.js'
import { serveHealthRoute } from './admin/health.js'
import { routeProviders } from './admin/providers.js'
import type { AdminDeps, ConfigPatchOptions, ConfigPatchResult } from './admin/types.js'
import { buildNote, envFlag, isPlainObject, lineCount, messageOf, publicChange, statusOf, statusWithTimeout, summaryOf, toJson, clientIpOf } from './admin/util.js'
import { atomicWriteFile } from './adapters/fs-store/atomic.js'

export { HASH_ENV, PASSWORD_ENV } from './admin/auth.js'

/** Opt-in escape hatch for binding to a non-loopback address (exactly `1`). */
const ALLOW_REMOTE_ENV = 'CHANNEL_QQ_ADMIN_ALLOW_REMOTE'
/** `cruises[].script` is remote code execution; edits are gated by this env var. */
const ALLOW_CRUISE_EDITS_ENV = 'CHANNEL_QQ_ADMIN_ALLOW_CRUISE_EDITS'
export { ALLOW_CRUISE_EDITS_ENV, ALLOW_REMOTE_ENV }

const MAX_BODY_BYTES = 2 * 1024 * 1024
const LOG_PATH = 'channel-qq'

export type {
  AdminDeps, AdminResource, ConfigPatchOptions, ConfigPatchResult, PublicChange,
} from './admin/types.js'

/**
 * Merge `patch` into `target` in place.
 *
 * Plain objects merge recursively and arrays are updated in place (`length = 0`
 * then `push`) so that anything holding a reference to a nested object or list
 * keeps observing the change instead of a stale snapshot.
 */
export function applyPatch(target: Json, patch: Json): void {
  for (const [key, value] of Object.entries(patch)) {
    // 原型污染：`__proto__` / `constructor` / `prototype` 不是配置项，写进去会改到
    // 所有对象的原型上。HTTP 面有 validatePatch 挡着，但这是 export 的公共函数
    // （测试也直接调），必须在入口自己拒（2026-10-19 排查）。
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
    const current = target[key] as unknown
    if (isPlainObject(value) && isPlainObject(current)) {
      applyPatch(current, value)
      continue
    }
    if (Array.isArray(value) && Array.isArray(current)) {
      current.length = 0
      current.push(...value)
      continue
    }
    target[key] = value
  }
}

/**
 * 兼容出口（P5 组合根/子插件测试在用）：patch 触及了哪些 **restart 级** dot-path。
 *
 * 与保存管线同源——热等级一律问 `config/meta.ts` 的 `hotOfPath`（未标注 = restart，
 * 保守），不再维护手写白名单；因此它与 `applyConfigPatch` 的 `restartRequired`
 * 在语义上永远一致。
 */
export function touchedRestartPaths(patch: Json): string[] {
  const found: string[] = []
  walkLeaves(patch, (dotPath) => {
    if (hotOfPath(dotPath) === 'restart') found.push(dotPath)
  })
  return found
}

export class AdminServer {
  private server: http.Server | null = null
  private started = false
  private startedAt = 0
  /** What the live listener is actually bound to (drives `relisten` no-ops). */
  private bound: { port: number; host: string } | null = null
  /** The loopback-override notice is worth exactly one log line per process. */
  private loopbackNoticeLogged = false
  private override: Json = {}

  private readonly sessions = new SessionStore()
  private readonly guard = new LoginGuard()
  private readonly auth: AuthManager
  private readonly auditLog: AuditLog
  private readonly hub: EventHub
  private readonly history: ConfigHistory
  private readonly live: LiveFeed

  constructor(private readonly deps: AdminDeps) {
    const home = deps.dshHome
    this.auth = new AuthManager({
      dshHome: home,
      configPassword: () => deps.config.admin.password,
      log: deps.log,
    })
    this.auditLog = new AuditLog(path.join(home, LOG_PATH, 'audit.jsonl'), deps.log)
    this.history = new ConfigHistory(path.join(home, LOG_PATH, 'admin-config-history.json'), deps.log)
    this.hub = new EventHub(deps.log)
    this.live = new LiveFeed(
      this.hub,
      { status: () => deps.status(), readLog: (lines) => deps.readLog(lines) },
      () => secretValuesOf(deps.config),
    )
  }

  /** Load the persisted override layer so saves accumulate instead of clobbering. */
  async start(): Promise<void> {
    if (this.started) return
    const { config } = this.deps
    if (!config.admin.enabled) {
      this.deps.log('admin panel disabled by config')
      return
    }
    this.override = await this.readOverride()
    await this.history.load()
    await this.auth.load()
    this.live.start()
    const host = this.effectiveHost()
    const server = this.createServer()
    await this.listen(server, config.admin.port, host)
    this.server = server
    this.started = true
    this.startedAt = Date.now()
    this.bound = { port: config.admin.port, host }
    this.deps.log(`admin panel: http://${host}:${config.admin.port}/ (password-gated, config UI)`)
  }

  /** Build the HTTP server (shared by `start` and `relisten`). */
  private createServer(): http.Server {
    return http.createServer((req, res) => {
      void this.handle(req, res).catch((error: unknown) => {
        // The real message must reach the panel: an operator staring at
        // "internal error" after "save" cannot tell a refused path from a disk
        // failure. The panel is password-gated, so carrying the reason is safe.
        const message = messageOf(error)
        const status = statusOf(error)
        this.deps.log(`admin request failed (${status}): ${message}`)
        if (!res.headersSent) this.json(res, status, { error: message })
        else res.end()
      })
    })
  }

  private async listen(server: http.Server, port: number, host: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.removeListener('listening', onListening)
        reject(error)
      }
      const onListening = (): void => {
        server.removeListener('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, host)
    })
  }

  /** `close()` hands the port back asynchronously; retry the rebind briefly. */
  private async listenWithRetry(server: http.Server, port: number, host: string): Promise<void> {
    let last: unknown = null
    for (let attempt = 1; attempt <= 12; attempt++) {
      try {
        await this.listen(server, port, host)
        return
      } catch (error) {
        last = error
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'EADDRINUSE' && code !== 'EACCES') throw error
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt))
      }
    }
    throw last instanceof Error ? last : new Error(String(last))
  }

  /**
   * The address the listener actually uses: loopback unless
   * `CHANNEL_QQ_ADMIN_ALLOW_REMOTE=1`. `admin.host` is advisory on purpose —
   * a persisted override on an existing host would otherwise keep re-exposing
   * a remote-command surface on every boot.
   */
  private effectiveHost(): string {
    const { host } = this.deps.config.admin
    if (envFlag(ALLOW_REMOTE_ENV)) return host
    if (host !== '127.0.0.1' && !this.loopbackNoticeLogged) {
      this.loopbackNoticeLogged = true
      this.deps.log(
        `admin panel: 只监听 127.0.0.1（配置里的 admin.host=${host} 被忽略）。`
        + `要用 SSH 隧道访问：ssh -L 8790:127.0.0.1:${this.deps.config.admin.port} <user>@<host>；`
        + `确实要监听公网请设 ${ALLOW_REMOTE_ENV}=1`,
      )
    }
    return '127.0.0.1'
  }

  /** Release the socket without dropping sessions (used by `relisten`). */
  private closeServer(): void {
    const server = this.server
    this.server = null
    this.started = false
    if (server === null) return
    // `close()` stops accepting but leaves established keep-alive sockets
    // answering — an old port would keep replying to a connected browser.
    ;(server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.()
    server.close()
  }

  /**
   * Apply `admin.port` / `admin.host` / `admin.enabled` to the live process.
   *
   * The work is deferred (the rebind closes the very server delivering this
   * response) and order depends on what changed: a different port binds first
   * (a busy port must not cost us the old one); a host change on the same port
   * releases first and restores the previous binding if the retry fails.
   * Sessions deliberately survive, so a port change does not log the operator out.
   */
  async relisten(): Promise<string> {
    const { enabled, port } = this.deps.config.admin
    const host = this.effectiveHost()
    if (!enabled) {
      this.closeServer()
      return '后台已在配置里关闭，端口已释放'
    }
    const current = this.bound
    if (current !== null && current.port === port && current.host === host) {
      return `监听未变（${host}:${port}），无需重新绑定`
    }
    const timer = setTimeout(() => {
      void this.rebind(port, host).catch((error: Error) => {
        this.deps.log(`admin: rebind failed: ${error.message}`)
      })
    }, 250)
    timer.unref?.()
    return current === null
      ? `正在监听 ${host}:${port}（无需重启）`
      : `正在从 ${current.host}:${current.port} 切到 ${host}:${port}（无需重启，稍后生效）`
  }

  /** The deferred half of `relisten`; never throws into the caller. */
  private async rebind(port: number, host: string): Promise<void> {
    const previous = this.bound
    if (previous !== null && previous.port !== port) {
      const next = this.createServer()
      try {
        await this.listenWithRetry(next, port, host)
      } catch (error) {
        next.close()
        const reason = messageOf(error)
        this.deps.log(`admin: rebind to ${host}:${port} failed (${reason}); still on ${previous.host}:${previous.port}`)
        return
      }
      this.closeServer()
      this.server = next
      this.bound = { port, host }
      this.started = true
      this.deps.log(`admin panel: now listening on http://${host}:${port}/`)
      return
    }
    this.closeServer()
    const server = this.createServer()
    try {
      await this.listenWithRetry(server, port, host)
    } catch (error) {
      server.close()
      const reason = messageOf(error)
      this.deps.log(`admin: rebind to ${host}:${port} failed (${reason})`)
      if (previous === null) return
      const restore = this.createServer()
      try {
        await this.listenWithRetry(restore, previous.port, previous.host)
        this.server = restore
        this.bound = { port: previous.port, host: previous.host }
        this.started = true
        this.deps.log(`admin: restored ${previous.host}:${previous.port}`)
      } catch (restoreError) {
        this.deps.log(`admin: restoring ${previous.host}:${previous.port} also failed (${messageOf(restoreError)}) — a plugin restart is required`)
      }
      return
    }
    this.server = server
    this.bound = { port, host }
    this.started = true
    this.deps.log(`admin panel: now listening on http://${host}:${port}/`)
  }

  stop(): void {
    this.closeServer()
    this.sessions.revokeAll()
    this.live.stop()
    this.hub.closeAll()
  }

  // ── auth ────────────────────────────────────────────────────────────────

  /** Token from Bearer header, session cookie, or `?key=` (EventSource). */
  private tokenFrom(req: http.IncomingMessage, url: URL): string | null {
    const header = req.headers.authorization
    if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7).trim()
    const fromCookie = readCookie(req.headers.cookie, 'dsh_admin')
    if (fromCookie !== null && fromCookie !== '') return fromCookie
    const query = url.searchParams.get('key')
    if (query !== null && query !== '') return query
    return null
  }

  /** Gate an API request; on sliding renewal the cookie is re-sent. */
  private async authGate(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
    const token = this.tokenFrom(req, url)
    if (token === null) {
      this.json(res, 401, { error: '未登录或会话已过期' })
      return false
    }
    const result = this.sessions.touch(token)
    if (result === 'invalid') {
      this.json(res, 401, { error: '未登录或会话已过期' })
      return false
    }
    if (result === 'renewed') res.setHeader('set-cookie', cookieHeader(token))
    return true
  }

  private async audit(ip: string, method: string, reqPath: string, action: string, summary: string, result: 'ok' | 'error' = 'ok'): Promise<void> {    await this.auditLog.append({ ip, method, path: reqPath, action, summary, result })
  }

  // ── static assets ───────────────────────────────────────────────────────

  /** Serve `/` and `/ui/*` from the embedded UI bundle (`/api/*` falls through). */
  private serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): boolean {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false
    const hit = bundleLookup(pathname)
    if (hit === null) {
      if (pathname === '/' || pathname === '/index.html' || pathname.startsWith('/ui/')) {
        this.json(res, 404, { error: 'not found' })
        return true
      }
      return false
    }
    res.writeHead(200, {
      'content-type': contentTypeOf(hit.key),
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(hit.text),
    })
    res.end(hit.text)
    return true
  }

  // ── transport helpers ───────────────────────────────────────────────────

  private json(res: http.ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(text),
    })
    res.end(text)
  }

  private async readBody(req: http.IncomingMessage): Promise<Json> {
    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of req) {
      const buf = chunk as Buffer
      total += buf.length
      if (total > MAX_BODY_BYTES) throw new Error('请求体过大')
      chunks.push(buf)
    }
    if (total === 0) return {}
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
    if (!isPlainObject(parsed)) throw new Error('请求体必须是 JSON 对象')
    return parsed
  }

  // ── persistence ─────────────────────────────────────────────────────────

  private get overrideFile(): string {
    return adminOverridePath(this.deps.dshHome)
  }

  private async readOverride(): Promise<Json> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.overrideFile, 'utf-8'))
      return isPlainObject(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }

  private async persist(override: Json = this.override): Promise<void> {
    await fs.mkdir(path.dirname(this.overrideFile), { recursive: true })
    await atomicWriteFile(this.overrideFile, JSON.stringify(override, null, 2))
  }

  private versionText(): string {
    try {
      const raw: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'))
      const version = isPlainObject(raw) ? raw.version : undefined
      return typeof version === 'string' && version !== '' ? version : '0.1.0'
    } catch {
      return '0.1.0'
    }
  }

  // ── config pipeline ─────────────────────────────────────────────────────

  /** The two locks that do not depend on the patch's *values* being valid. */
  private assertPatchAllowed(patch: Json): void {
    if (patch.cruises !== undefined && !envFlag(ALLOW_CRUISE_EDITS_ENV)) {
      throw Object.assign(
        new Error(
          `巡航任务（cruises）已锁定：它会在本机执行脚本，改它等于远程执行代码。`
          + `确实需要修改，请在服务器上设 ${ALLOW_CRUISE_EDITS_ENV}=1 并重启 dsh。`,
        ),
        { status: 403 },
      )
    }
    // Refuse to *store* a remote bind address while remote binding is off: the
    // value would sit inert in admin-config.json and switch on the moment
    // someone sets ALLOW_REMOTE for an unrelated reason.
    const requestedHost = isPlainObject(patch.admin) ? String(patch.admin.host ?? '') : ''
    if (requestedHost !== '' && requestedHost !== '127.0.0.1' && !envFlag(ALLOW_REMOTE_ENV)) {
      throw Object.assign(
        new Error(
          `后台固定只听 127.0.0.1，不接受把 admin.host 改成 ${requestedHost}。`
          + `要用 SSH 隧道访问：ssh -L 8790:127.0.0.1:${this.deps.config.admin.port} root@<服务器>；`
          + `确实要监听公网，请在服务器上设 ${ALLOW_REMOTE_ENV}=1 并重启 dsh。`,
        ),
        { status: 403 },
      )
    }
  }

  /**
   * Merge a patch into the live config, persist it, record it, run its side
   * effects. Public because the panel is not the only writer: picking an agent
   * preset goes through exactly the same path. Side effects run *after* the
   * write, so a handler that throws cannot leave disk and process disagreeing.
   */
  async applyConfigPatch(patch: Json, opts: ConfigPatchOptions = {}): Promise<ConfigPatchResult> {
    this.assertPatchAllowed(patch)
    const issues = validatePatch(patch)
    if (issues.length > 0) {
      throw Object.assign(new Error(`配置校验未通过：${describeIssues(issues)}`), { status: 400 })
    }
    if (opts.requireVersion === true && opts.baseVersion !== undefined && opts.baseVersion !== this.history.current) {
      throw Object.assign(
        new Error(`配置已被其他页面修改（你的版本 v${opts.baseVersion}，当前 v${this.history.current}），请刷新后重试`),
        { status: 409, version: this.history.current },
      )
    }
    const { secretSet } = maskConfigForView(this.deps.config)
    const changes = computeChanges(this.deps.config, patch, undefined, secretSet)
    const restartRequired = restartPathsIn(changes)
    // **先落盘、后改内存**。反过来的话，写盘失败时进程按新配置跑、磁盘还是旧的、
    // 热重载也没跑——三方差且零日志，表现为"重启后设置自己变回去了"（2026-10-19 排查）。
    const nextOverride: Json = JSON.parse(JSON.stringify(this.override)) as Json
    applyPatch(nextOverride, patch)
    try {
      await this.persist(nextOverride)
    } catch (error) {
      this.deps.log(`admin: config persist FAILED, nothing applied :: ${messageOf(error)}`)
      throw Object.assign(new Error(`配置写盘失败，本次修改未生效：${messageOf(error)}`), { status: 500 })
    }
    this.override = nextOverride
    applyPatch(toJson(this.deps.config), patch)
    const effects: string[] = []
    if (this.deps.applyEffects !== undefined) {
      try {
        effects.push(...await this.deps.applyEffects(patch))
      } catch (error) {
        effects.push(`部分设置未能热应用：${messageOf(error)}`)
      }
    }
    const extra: string[] = []
    if (isPlainObject(patch.admin) && patch.admin.password !== undefined) {
      await this.auth.load()
      this.sessions.revokeAll()
      extra.push('后台口令已更新，全部会话已撤销')
    }
    const version = await this.finishWrite(changes, opts, extra)
    this.deps.log(`admin: config updated (${Object.keys(patch).join(', ')})${effects.length > 0 ? ' :: ' + effects.join('; ') : ''}`)
    return {
      applied: Object.keys(patch),
      changes: changes.map(publicChange),
      restartRequired,
      effects,
      note: buildNote(effects, restartRequired, extra),
      version,
    }
  }

  /** History + audit + SSE broadcast; returns the (possibly new) version. */
  private async finishWrite(changes: ChangeEntry[], opts: ConfigPatchOptions, extra: string[]): Promise<number> {
    let version = this.history.current
    if (changes.length > 0) {
      // Raw values stay for rollback, except secrets — those never enter history.
      const sanitized = changes.map((change) => (change.secret ? { ...change, rawOld: null, rawNew: null } : change))
      const entry = await this.history.record(opts.source ?? 'save', sanitized)
      version = entry.version
      this.hub.broadcast('config', { version, at: entry.at, changes: changes.map(publicChange) })
    }
    await this.auditLog.append({
      ip: opts.ip ?? '',
      method: opts.method ?? 'INTERNAL',
      path: opts.path ?? '/api/config',
      action: opts.source === 'rollback' ? 'config.rollback' : 'config.save',
      summary: summaryOf(changes, extra, opts.source),
      result: 'ok',
    })
    return version
  }

  /** Rollback = apply the inverse of a history entry through the same pipeline. */
  private async doRollback(version: number, opts: ConfigPatchOptions): Promise<ConfigPatchResult> {
    const entry = this.history.find(version)
    if (entry === undefined) throw Object.assign(new Error(`没有 v${version} 这条变更记录`), { status: 404 })
    const restorable = entry.changes.filter((change) => change.secret !== true)
    const skipped = entry.changes.length - restorable.length
    const result = await this.applyConfigPatch(inversePatch(restorable), {
      ...opts,
      source: 'rollback',
    })
    const skipNote = skipped > 0 ? `（${skipped} 项敏感字段不在历史里，未回滚）` : ''
    return { ...result, note: `已回滚 v${version} 的 ${restorable.length} 项改动。${skipNote}${result.note}` }
  }

  private metaView(secretSet: Json): Json {
    return {
      overrideFile: this.overrideFile,
      overrideKeys: Object.keys(this.override),
      resources: Object.keys(this.deps.resources),
      restartPaths: restartPaths(),
      sessions: this.sessions.size,
      configVersion: this.history.current,
      secretSet,
    }
  }

  // ── routes ──────────────────────────────────────────────────────────────

  /** 递给 routes-data.ts 的窄环境：只暴露那几条路由需要的五件事。 */
  private dataEnv(): DataRouteEnv {
    return {
      deps: this.deps,
      json: (res, status, body) => this.json(res, status, body),
      readBody: (req) => this.readBody(req),
      audit: (ip, method, reqPath, action, summary, result = 'ok') => this.audit(ip, method, reqPath, action, summary, result),
      clientIp: (req) => clientIpOf(req),
    }
  }

  /** Routes that must answer without a session: health, login, logout. */
  private async routePublic(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
    const route = url.pathname
    if (route === '/api/health') {
      this.json(res, 200, { ok: true, passwordRequired: this.auth.configured })
      return true
    }
    if (route === '/api/login' && req.method === 'POST') {
      const ip = clientIpOf(req)
      if (this.guard.blocked(ip)) {
        this.json(res, 429, { error: '尝试次数过多，请 5 分钟后再试' })
        return true
      }
      const body = await this.readBody(req)
      if (!this.auth.verify(String(body.password ?? ''))) {
        this.guard.record(ip)
        this.deps.log(`admin login failed from ${ip}`)
        await this.audit(ip, 'POST', route, 'auth.login', '登录失败（密码不正确）', 'error')
        this.json(res, 401, { error: '密码不正确' })
        return true
      }
      const token = this.sessions.create()
      res.setHeader('set-cookie', cookieHeader(token))
      await this.audit(ip, 'POST', route, 'auth.login', '登录成功')
      this.json(res, 200, { ok: true, token })
      return true
    }
    if (route === '/api/logout' && req.method === 'POST') {
      const token = this.tokenFrom(req, url)
      if (token !== null) this.sessions.revoke(token)
      res.setHeader('set-cookie', clearCookieHeader())
      this.json(res, 200, { ok: true })
      return true
    }
    return false
  }

  /** Session-gated account routes: revoke-all and password change. */
  private async routeAccount(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
    const route = url.pathname
    const ip = clientIpOf(req)
    if (route === '/api/logout-all' && req.method === 'POST') {
      this.sessions.revokeAll()
      res.setHeader('set-cookie', clearCookieHeader())
      await this.audit(ip, 'POST', route, 'auth.logout-all', '撤销全部会话')
      this.json(res, 200, { ok: true })
      return true
    }
    if (route === '/api/password' && req.method === 'POST') {
      const body = await this.readBody(req)
      const info = this.auth.info
      if (!info.canChange) {
        this.json(res, 403, { error: `口令当前${info.label}，后台不接管修改` })
        return true
      }
      if (!this.auth.verify(String(body.current ?? ''))) {
        await this.audit(ip, 'POST', route, 'auth.password', '改密失败（当前密码不正确）', 'error')
        this.json(res, 403, { error: '当前密码不正确' })
        return true
      }
      const changed = await this.auth.change(String(body.next ?? ''))
      if (!changed.ok) {
        this.json(res, 400, { error: changed.reason })
        return true
      }
      this.sessions.revokeAll()
      await this.audit(ip, 'POST', route, 'auth.password', '修改后台密码（已撤销全部会话）')
      this.json(res, 200, { ok: true, note: '密码已修改，全部会话已撤销' })
      return true
    }
    return false
  }

  private async routeReadCore(res: http.ServerResponse, route: string): Promise<boolean> {
    if (route === '/api/snapshot') {
      const { config, secretSet } = maskConfigForView(this.deps.config)
      // 状态里有 QQ 往返（群列表）；它挂住时不能拖死整个快照（配置与资源表清单都靠它）。
      const status = await statusWithTimeout(this.deps.status, 5_000)
      this.json(res, 200, { ok: true, config, status, meta: this.metaView(secretSet) })
      return true
    }
    if (route === '/api/schema') {
      this.json(res, 200, { ok: true, version: 1, pages: ADMIN_PAGES, ...schemaView() })
      return true
    }
    if (route === '/api/security') {
      const info = this.auth.info
      this.json(res, 200, {
        ok: true,
        password: { kind: info.kind, canChange: info.canChange, label: info.label },
        sessions: this.sessions.size,
        bound: this.bound,
        flags: {
          groupAdminDangerous: this.deps.config.groupAdmin.dangerous === true,
          allowCruiseEdits: envFlag(ALLOW_CRUISE_EDITS_ENV),
          allowRemote: envFlag(ALLOW_REMOTE_ENV),
        },
      })
      return true
    }
    if (route === '/api/runtime') {
      this.json(res, 200, {
        ok: true,
        version: this.versionText(),
        node: process.version,
        platform: `${process.platform} ${process.arch}`,
        uptimeSec: this.startedAt === 0 ? 0 : Math.round((Date.now() - this.startedAt) / 1000),
        dshHome: this.deps.dshHome,
        overrideFile: this.overrideFile,
        configVersion: this.history.current,
        resources: Object.keys(this.deps.resources),
        restartPaths: restartPaths(),
      })
      return true
    }
    return false
  }

  private async routeReadOps(res: http.ServerResponse, url: URL, route: string): Promise<boolean> {
    if (route === '/api/audit') {
      this.json(res, 200, { ok: true, entries: await this.auditLog.tail(lineCount(url, 300)) })
      return true
    }
    if (route === '/api/config/history') {
      const entries = this.history.list().map((entry) => ({
        version: entry.version, at: entry.at, source: entry.source, changes: entry.changes.map(publicChange),
      }))
      this.json(res, 200, { ok: true, entries })
      return true
    }
    if (route === '/api/logs') {
      const secrets = secretValuesOf(this.deps.config)
      const tail = await this.deps.readLog(lineCount(url, 200))
      this.json(res, 200, {
        ok: true,
        lines: secrets.length === 0 ? tail : tail.map((line) => maskSecretText(line, secrets)),
      })
      return true
    }
    return false
  }

  private async routeWriteConfig(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
    const route = url.pathname
    const ip = clientIpOf(req)
    if (route === '/api/config' && req.method === 'POST') {
      const body = await this.readBody(req)
      const patch = isPlainObject(body.patch) ? body.patch : body
      try {
        const result = await this.applyConfigPatch(patch, {
          source: 'save',
          ip,
          method: 'POST',
          path: route,
          baseVersion: typeof body.baseVersion === 'number' ? body.baseVersion : undefined,
          requireVersion: true,
        })
        this.json(res, 200, { ok: true, ...result })
      } catch (error) {
        const version = (error as { version?: unknown } | null)?.version
        await this.audit(ip, 'POST', route, 'config.save', `保存失败：${messageOf(error)}`.slice(0, 200), 'error')
        this.json(res, statusOf(error), {
          error: messageOf(error),
          ...(typeof version === 'number' ? { version } : {}),
        })
      }
      return true
    }
    if (route === '/api/config/reset' && req.method === 'POST') {
      this.override = {}
      await this.persist()
      const entry = await this.history.record('reset', [])
      this.hub.broadcast('config', { version: entry.version, at: entry.at, changes: [] })
      await this.audit(ip, 'POST', route, 'config.reset', '清空配置覆盖层')
      this.deps.log('admin: override cleared (defaults + cordis patch win again)')
      this.json(res, 200, {
        ok: true,
        version: entry.version,
        note: '已清空管理后台覆盖层；重启后回到默认值 + cordis 配置。当前进程内的值保持不变（除非重启）。',
      })
      return true
    }
    if (route === '/api/config/rollback' && req.method === 'POST') {
      const body = await this.readBody(req)
      try {
        const result = await this.doRollback(Number(body.version), { ip, method: 'POST', path: route })
        this.json(res, 200, { ok: true, ...result })
      } catch (error) {
        await this.audit(ip, 'POST', route, 'config.rollback', `回滚失败：${messageOf(error)}`.slice(0, 200), 'error')
        this.json(res, statusOf(error), { error: messageOf(error) })
      }
      return true
    }
    return false
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const route = url.pathname
    if (this.serveStatic(req, res, route)) return
    // 写请求的防 CSRF 判据（自定义头 + 同源）——在鉴权之前，登录也不例外。
    const csrf = checkCsrf(req.method ?? 'GET', req.headers)
    if (csrf !== null) {
      this.json(res, 403, { error: csrf })
      return
    }
    if (await this.routePublic(req, res, url)) return
    if (await serveHealthRoute(this.deps.health, req, res, route, clientIpOf(req),
      (status, body) => this.json(res, status, body))) return
    if (!await this.authGate(req, res, url)) return
    if (route === '/api/events') {
      this.hub.add(req, res)
      return
    }
    if (await this.routeAccount(req, res, url)) return
    if (await this.routeReadCore(res, route)) return
    if (await this.routeReadOps(res, url, route)) return
    const env = this.dataEnv()
    if (await routeReadData(env, req, res, url, route)) return
    if (await this.routeWriteConfig(req, res, url)) return
    if (await routeWriteData(env, req, res, url)) return
    if (await routeWriteMisc(env, req, res, url)) return
    if (await routeProviders(env, req, res, url)) return
    this.json(res, 404, { error: 'not found' })
  }
}
