/** SSE 广播：`GET /api/events` 的客户端集合与事件分发。
 *
 * 为什么是 SSE 而不是 WebSocket（内部文档 §2/§7）：这里只有**服务端→
 * 浏览器**一个方向——状态卡、日志增量、配置版本变化；SSE 就是为这个形状设计的，
 * 浏览器自带断线重连（`retry:` 提示间隔），不需要握手与心跳协议。
 *
 * 断线语义要诚实：客户端会指数退避重连，重连期间状态卡显示"已断开"而不是假装
 * 在线（由前端负责）；服务端这里只做三件事：登记连接、广播帧、空闲心跳。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/** 心跳间隔：代理与浏览器都会掐掉长期静默的连接。 */
const HEARTBEAT_MS = 15_000

export class EventHub {
  private readonly clients = new Set<ServerResponse>()
  private heartbeat: NodeJS.Timeout | null = null

  constructor(private readonly log: (line: string) => void) {}

  get count(): number {
    return this.clients.size
  }

  /** 接管一个响应对象，把它变成 SSE 流。 */
  add(_req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    // 提示浏览器的自动重连间隔（毫秒）。首帧写成注释，保证代理立刻见到字节。
    res.write('retry: 2000\n\n')
    this.clients.add(res)
    res.on('close', () => {
      this.clients.delete(res)
      this.stopHeartbeatIfIdle()
    })
    this.ensureHeartbeat()
  }

  /** 发一帧 `event: <name>` + JSON 数据。断掉的连接在这里被摘除。 */
  broadcast(event: string, data: unknown): void {
    if (this.clients.size === 0) return
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const res of [...this.clients]) {
      try {
        res.write(frame)
      } catch (error) {
        this.clients.delete(res)
        this.log(`sse: dropping client (${error instanceof Error ? error.message : String(error)})`)
      }
    }
  }

  /** 进程收尾：关掉全部流。 */
  closeAll(): void {
    for (const res of [...this.clients]) {
      try { res.end() } catch { /* 已断开 */ }
    }
    this.clients.clear()
    this.stopHeartbeatIfIdle()
  }

  private ensureHeartbeat(): void {
    if (this.heartbeat !== null) return
    this.heartbeat = setInterval(() => {
      if (this.clients.size === 0) { this.stopHeartbeatIfIdle(); return }
      for (const res of [...this.clients]) {
        try { res.write(': ping\n\n') } catch { this.clients.delete(res) }
      }
    }, HEARTBEAT_MS)
    this.heartbeat.unref?.()
  }

  private stopHeartbeatIfIdle(): void {
    if (this.clients.size > 0 || this.heartbeat === null) return
    clearInterval(this.heartbeat)
    this.heartbeat = null
  }
}
