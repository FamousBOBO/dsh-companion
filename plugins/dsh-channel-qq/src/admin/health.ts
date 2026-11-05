/** `/api/healthz`：发送侧活体探测路由（从 admin.ts 拆出，控制单文件体量）。
 *
 * 门禁是**来源地址**而不是登录会话：调用方是同机的运维脚本，它没有后台 token。
 * 只要请求不是从 loopback 进来的就 403——面板即便被显式绑到 0.0.0.0，这条路由
 * 对公网仍然关着。
 *
 * 返回码：探测通过 200，失败 503；脚本用 `curl -fsS` 就能一把判断。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

type Send = (status: number, body: unknown) => void

/** 本机地址（含 IPv4-mapped 形式）。 */
export function isLoopbackAddress(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
}

/**
 * 处理 `/api/healthz`。
 *
 * @returns 是否已经接管这个请求（路径不匹配时 false，交回调用方）。
 */
export async function serveHealthRoute(
  probe: (() => Promise<unknown>) | undefined,
  req: IncomingMessage,
  res: ServerResponse,
  route: string,
  clientIp: string,
  send: Send,
): Promise<boolean> {
  if (route !== '/api/healthz') return false
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(405, { error: '只支持 GET' })
    return true
  }
  if (!isLoopbackAddress(clientIp)) {
    send(403, { error: 'healthz 只接受本机请求' })
    return true
  }
  if (probe === undefined) {
    send(503, { ok: false, error: '健康探测未就绪' })
    return true
  }
  try {
    const report = await probe() as { ok?: unknown }
    send(report?.ok === true ? 200 : 503, { ...(report as object) })
  } catch (error) {
    send(503, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }
  return true
}
