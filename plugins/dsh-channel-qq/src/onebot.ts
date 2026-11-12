/** OneBot v11 WebSocket transport: forward client and reverse server, echo-based API calls. */

import http from 'node:http'
import { EventEmitter } from 'node:events'
import WebSocket, { WebSocketServer, type RawData } from 'ws'
import type { ConnectionConfig } from './config.js'
import type { OneBotActionPayload, OneBotApiResponse, OneBotEvent } from './types.js'

const MAX_RECONNECT_DELAY_MS = 60_000

/**
 * "平台**明确拒绝**"的唯一标记（`Symbol.for`，跨模块同一枚）。
 *
 * 为什么需要它：`retcode`/`status` 是 OneBot 失败帧里的普通字段，任何包装过的错误都
 * 可以顺手带上一个非零 `retcode`（诊断字段、上游 wrapper、嵌套 `data`）。若分类器只认
 * "看到非零 retcode 就当明确拒绝"，一个**连接被重置**的错误就会被判成"可重试"，而重复
 * 外发正是从这里进来的。所以：只有这里打上标记的错误才算"平台明确说没成"。
 *
 * 打标记用的是不可枚举属性，`JSON.stringify`/日志不受影响。
 */
export const ONEBOT_REJECTION = Symbol.for('dsh-channel-qq.onebot-rejection')

/** 带标记的拒绝错误类型（分类器据此判 `failed`，允许重试）。 */
export type OneBotRejectionError = Error & {
  readonly [ONEBOT_REJECTION]: true
  readonly status?: string
  readonly retcode?: number
}

/** 这个错误是不是"平台明确拒绝"（带标记才算）。 */
export function isOneBotRejection(error: unknown): error is OneBotRejectionError {
  return typeof error === 'object' && error !== null && (error as Record<symbol, unknown>)[ONEBOT_REJECTION] === true
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** Port parsed from a ws://…:port URL (reverse mode binds it; forward mode dials it). */
export function urlPort(url: string, fallback: number): number {
  try {
    return Number(new URL(url).port) || fallback
  } catch {
    return fallback
  }
}

export class OneBotClient extends EventEmitter {
  private readonly observeOnly: boolean
  private ws: WebSocket | null = null
  private reverseServer: http.Server | null = null
  private pending = new Map<string, PendingRequest>()
  private echoSeq = 0
  private reconnectAttempts = 0
  private reconnectTimer: NodeJS.Timeout | null = null
  private heartbeatTimer: NodeJS.Timeout | null = null
  private lastPongAt = Date.now()
  private closed = false
  selfId: number | null = null

  constructor(
    private connection: ConnectionConfig,
    private accessToken: string | undefined,
    private readonly log: (line: string) => void,
  ) {
    super()
    this.observeOnly = connection.mode === 'mirror-observe'
  }

  /**
   * 连接是否已配置（`connection.url` 为空 = 未配置）。
   *
   * 安全默认：**没配 NapCat 就什么都不做**。出厂配置里 URL 是空串，所以新装的
   * 插件不会去拨一个不存在的端口、不会监听 8082、也不会每 60 秒重连一次。
   * 以前默认 `ws://127.0.0.1:3001`：目标不存在时 `scheduleReconnect()` 会一路
   * 指数退避重试到天荒地老，日志里全是 "reconnecting in …"。
   */
  configured(): boolean {
    return this.connection.url.trim() !== ''
  }

  start(): void {
    if (this.observeOnly) {
      const url = new URL(this.connection.url)
      if (this.connection.mode !== 'mirror-observe' || url.protocol !== 'ws:' || !['127.0.0.1', '[::1]'].includes(url.hostname)) {
        throw new Error('mirror-observe requires a literal loopback ws URL and cannot switch to a live transport')
      }
    } else if (this.connection.mode === 'mirror-observe') {
      throw new Error('mirror-observe requires a fresh client; restart in an isolated environment')
    }
    this.closed = false
    if (!this.configured()) {
      this.log('NapCat/OneBot 未配置（connection.url 为空）：不发起连接、不监听端口、不重连。'
        + '在后台「连接」页或 profile 的 cordis.patch.yml 里填好地址后保存即会重连。')
      return
    }
    if (this.connection.mode === 'reverse') {
      this.startReverseServer(urlPort(this.connection.url, 8082))
    } else {
      this.connectForward()
    }
  }

  stop(): void {
    this.closed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.clearPending(new Error('channel stopped'))
    this.ws?.close(1000, 'channel stopped')
    this.ws = null
    this.reverseServer?.close()
    this.reverseServer = null
  }

  /**
   * Swap transport (forward/reverse, URL, token) without recreating the client.
   *
   * The admin panel changes these live. Rebuilding the client instead would
   * strand every other object: `OutboundQueue`, the bridge and all 88 tools
   * captured this instance at init and would keep sending through a dead
   * socket. So the socket is torn down and re-dialled in place.
   */
  reconnect(connection: ConnectionConfig, accessToken: string | undefined): void {
    if ((connection.mode === 'mirror-observe') !== this.observeOnly) throw new Error('Switching mirror isolation requires a restart')
    this.stop()
    this.connection = connection
    this.accessToken = accessToken
    this.reconnectAttempts = 0
    this.lastPongAt = Date.now()
    this.start()
    this.log(`transport switched to mode=${connection.mode} url=${connection.url} (token ${accessToken ? 'set' : 'none'})`)
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  /**
   * 最近一次收到任何帧的时间（Unix ms）。
   *
   * 健康探针用它回答"链路还活着吗"的接收侧：`isConnected()` 只看 socket 状态，
   * 而 NapCat 的登录态假活时 socket 照样是 OPEN（2026-10-19 事故）。心跳/事件
   * 帧都会刷新这个值，所以它可以作为一个廉价的旁证（不替代 `get_status` 往返）。
   */
  lastActivityAt(): number {
    return this.lastPongAt
  }

  /** One OneBot API call; resolves with `data` on ok, rejects on failure or timeout. */
  async call(action: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<unknown> {
    if (this.observeOnly) throw new Error(`mirror-observe blocked OneBot action: ${action}`)
    // Brief reconnect grace: a dropped socket usually comes back within a few
    // seconds (NapCat re-dials the reverse server). Wait up to 12s instead of
    // failing the agent's action on the first blip.
    if (!this.isConnected()) {
      const deadline = Date.now() + 12_000
      while (!this.isConnected() && Date.now() < deadline && !this.closed) {
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    }
    if (!this.isConnected()) throw new Error(`QQ not connected (action ${action} dropped)`)
    const echo = `dsh-qq-${Date.now()}-${this.echoSeq++}`
    const payload: OneBotActionPayload = { action, params, echo }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo)
        reject(new Error(`QQ API ${action} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(echo, { resolve, reject, timer })
      this.ws!.send(JSON.stringify(payload))
    })
  }

  private handleFrame(raw: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return
    }
    const payload = parsed as Partial<OneBotApiResponse> & Partial<OneBotEvent>
    if (typeof payload.echo === 'string' && this.pending.has(payload.echo)) {
      const entry = this.pending.get(payload.echo)!
      this.pending.delete(payload.echo)
      clearTimeout(entry.timer)
      if (payload.status === 'ok' || (payload.status === undefined && payload.retcode === 0)) entry.resolve(payload.data)
      else {
        // **保留平台拒绝的结构**：`status`/`retcode` 是"平台明确说没成"的唯一凭据。
        // 只留一句 message 的话，上层只能看到"某个 Error"，而"无法证明没发出去"的错误
        // 必须按 `unknown` 处理（不许自动重试）。把结构带上，才能区分
        // "明确拒绝 → failed（可重试）" 与 "连接断了 → unknown（绝不重试）"。
        const detail = payload.msg ?? payload.wording ?? `retcode ${String(payload.retcode)}`
        const error: Error & { status?: string; retcode?: number; msg?: string; wording?: string } =
          new Error(`QQ API failed: ${detail}`)
        if (payload.status !== undefined) error.status = payload.status
        if (payload.retcode !== undefined) error.retcode = payload.retcode
        if (payload.msg !== undefined) error.msg = payload.msg
        if (payload.wording !== undefined) error.wording = payload.wording
        // R5-2: `async` explicitly means the request was accepted but the result is
        // not final. It is never a provable rejection, even if retcode is nonzero.
        // A bare nonzero retcode without `status:'failed'` is ambiguous too; only the
        // platform's explicit failure status may enter the retryable `failed` path.
        const provablyRejected = payload.status === 'failed'
        if (provablyRejected) {
          Object.defineProperty(error, ONEBOT_REJECTION, { value: true, enumerable: false })
        }
        entry.reject(error)
      }
      return
    }
    if ((payload as OneBotEvent).post_type === 'meta_event') return // heartbeats & lifecycle bookkeeping
    this.emit('event', parsed as OneBotEvent)
  }

  private bindSocket(ws: WebSocket, label: string): void {
    this.ws = ws
    this.reconnectAttempts = 0
    this.log(`${label} connected`)
    this.emit('connect')
    ws.on('pong', () => {
      this.lastPongAt = Date.now()
    })
    ws.on('message', (data: RawData) => {
      this.lastPongAt = Date.now()
      this.handleFrame(data.toString())
    })
    ws.on('close', (code, reason) => {
      this.log(`${label} closed: code=${code} reason=${reason.toString() || 'none'}`)
      // A replaced socket's close must not clear the live replacement.
      if (this.ws !== ws) return
      if (this.connection.mode === 'reverse') {
        this.ws = null
        this.clearPending(new Error('QQ socket closed'))
        this.emit('disconnect')
        this.log('waiting for NapCat to reconnect…')
      } else {
        this.scheduleReconnect()
      }
    })
    ws.on('error', (err: Error) => {
      this.log(`${label} error: ${err.message}`)
    })
  }

  private connectForward(): void {
    if (this.closed || !this.configured()) return
    const headers: Record<string, string> = {}
    if (this.accessToken) headers.Authorization = `Bearer ${this.accessToken}`
    this.log(`dialling NapCat at ${this.connection.url}`)
    const ws = new WebSocket(this.connection.url, { headers })
    ws.on('open', () => {
      this.bindSocket(ws, 'forward WS')
      this.startHeartbeat()
    })
    ws.on('error', () => this.scheduleReconnect())
  }

  private startReverseServer(port: number): void {
    if (this.reverseServer) return
    const server = http.createServer((_req, res) => {
      res.writeHead(404).end()
    })
    const wss = new WebSocketServer({ server, perMessageDeflate: false })
    wss.on('connection', (ws, req) => {
      const ip = req.socket.remoteAddress ?? 'unknown'
      if (this.accessToken && req.headers.authorization !== `Bearer ${this.accessToken}`) {
        this.log(`reverse WS auth failed from ${ip}`)
        ws.close(1008, 'Unauthorized')
        return
      }
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close(1000, 'replaced by a newer connection')
      this.bindSocket(ws, `reverse WS (${ip})`)
      this.startHeartbeat()
    })
    wss.on('error', (err: Error) => this.log(`reverse WS server error: ${err.message}`))
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        this.log(`port ${port} busy; retrying in 2s`)
        setTimeout(() => {
          if (!this.closed) {
            this.reverseServer = null
            this.startReverseServer(port)
          }
        }, 2_000)
        return
      }
      this.log(`reverse WS http error: ${err.message}`)
    })
    // Bind dual-stack (no host): NapCat dials `ws://localhost:8082`, which may
    // resolve to ::1 or 127.0.0.1 depending on DNS order; both must answer.
    server.listen(port)
    this.reverseServer = server
    this.log(`reverse WS server listening on [::]:${port} + 127.0.0.1:${port} (NapCat should dial this)`)
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    // TCP half-open guard: NapCat's socket can die without a FIN (sleep,
    // network switch). Track pongs; a silent socket gets torn down so the
    // reverse server accepts a fresh dial instead of holding a zombie.
    this.lastPongAt = Date.now()
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return
      if (Date.now() - this.lastPongAt > 65_000) {
        this.log('heartbeat: no pong for 65s, tearing down dead socket')
        try { this.ws.terminate() } catch { /* closing anyway */ }
        return
      }
      this.ws.ping()
    }, 30_000)
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer || !this.configured()) return
    const delay = Math.min(1_000 * 2 ** this.reconnectAttempts++, MAX_RECONNECT_DELAY_MS)
    this.log(`reconnecting in ${delay}ms`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connectForward()
    }, delay)
  }

  private clearPending(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }
}
