/** 发送过程的**两件小工具**：异常分类（该不该重试）与作废令牌（超时之后还敢不敢发）。
 *
 * 为什么单独一个文件：这两件事都是"纯判据"，可以在没有平台、没有账本、没有网络的情况下
 * 逐条钉住，而 `sender.ts` 自己要管复核顺序与出站链。混在一起的时候，改一条分类规则
 * 得先读一遍发送流程，改一次发送流程又怕碰坏分类——两个都改不动。
 *
 * 一条贯穿全文件的保守原则：**无法证明"没发出去"，就当发过**。
 * 重复外发（群里两条一模一样的主动消息）比少发一条严重得多，所以这里的默认答案
 * 永远是"unknown / 不发"，只有平台**明确拒绝**才允许进入可重试分支。
 */

import type { Clock } from '../../ports/clock.js'
import { isOneBotRejection } from '../../onebot.js'

/** 我们自己的等待超时（与网络错误区分开：这条是我们判的，不是对端判的）。 */
export class ContactTimeoutError extends Error {}

/** 在 `ms` 内等一个 promise；超时抛 `ContactTimeoutError`（调用方据此记 `unknown`）。 */
export async function withTimeout<T>(clock: Clock, ms: number, run: () => Promise<T>): Promise<T> {
  // 句柄放在对象里而不是 `let`：赋值发生在 Promise 执行器里（闭包），
  // `let` 会被类型推断窄化成 `null` 字面量，于是 `handle?.cancel()` 变成了 never。
  const timer: { handle: { cancel(): void } | null } = { handle: null }
  const timeout = new Promise<never>((_, reject) => {
    timer.handle = clock.setTimeout(() => { reject(new ContactTimeoutError(`超过 ${String(ms)}ms 没有回执`)) }, ms)
  })
  try {
    return await Promise.race([run(), timeout])
  } finally {
    timer.handle?.cancel()
  }
}

/**
 * 一次发送的作废令牌。
 *
 * 由发送方在**进入限速队列之前**创建、被队列 callback 闭包捕获：超时之后
 * `cancel('timeout')` 一置位，哪怕那次任务在队列里排了三十秒才轮到，第一句就会看见
 * "已作废"而不调 `api.sendTo`。没有它，"超时"只是本进程不再等，消息照样会出去。
 */
export interface SendTicket {
  cancel(reason: string): void
  readonly cancelled: boolean
  /** 作废原因（日志与断言用）。 */
  readonly reason: string | null
}

export function createSendTicket(): SendTicket {
  const ticket: { reason: string | null } & SendTicket = {
    reason: null,
    get cancelled(): boolean { return ticket.reason !== null },
    cancel(reason: string): void { ticket.reason ??= reason },
  }
  return ticket
}

/** 发送异常的四类；**只有 `rejected` 敢重试**。 */
export type SendErrorKind = 'timeout' | 'rejected' | 'connection' | 'unknown'

/** 连接层错误码：这些错误发生时，消息**可能已经出去了**（对端收到了才断也一样）。 */
const CONNECTION_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH',
  'ENETUNREACH', 'EAI_AGAIN', 'ENOTFOUND', 'ERR_SOCKET_CLOSED', 'ERR_STREAM_PREMATURE_CLOSE',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
])

/** 连接类错误的前缀（undici 与 node:stream 的族名）。 */
const CONNECTION_PREFIXES = ['UND_ERR_', 'ERR_STREAM_']

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 把一个异常归类。**判据写死、可单测**，不要散在各处 catch 里。
 *
 * 顺序（R5 修的就是这个顺序与信任面）：
 *   1. 自建超时 → `unknown`（回执未知）；
 *   2. **连接类错误优先**：`ECONNRESET` 这类"对端可能已经收到"的错误，哪怕错误对象里
 *      顺带带了 `data.retcode = 1200`，也只能算 `unknown`——Codex 实测的洞正是
 *      "混合连接错误被判 `failed` → 重试 → 重复外发"；
 *   3. 只有**经校验的专用拒绝类型**（`onebot.ts` 的 `ONEBOT_REJECTION` 标记，见
 *      `isOneBotRejection`）才是 `failed`（可重试）；
 *   4. 其余一律 `unknown`。
 *
 * 两条"不看"是刻意的：
 *   - **不看 message 文本**：`String(error)` 里出现 "ECONNRESET" 不算数（错误消息是人写的，
 *     可能只是引用了一段日志）；
 *   - **不看任意嵌套的 `retcode` / `status:'failed'`**：任何对象都能长成那样，信任它等于
 *     让"未知异常"有机会伪装成"平台明确拒绝"，而后者是唯一会被重试的分支。
 *
 * 一句话：**只有我们自己的适配层亲手打过标记的拒绝才可重试。**
 */
export function classifySendError(error: unknown): {
  readonly state: 'unknown' | 'failed'
  readonly kind: SendErrorKind
  readonly detail: string
} {
  const detail = describe(error).slice(0, 200)
  if (error instanceof ContactTimeoutError) return { state: 'unknown', kind: 'timeout', detail }
  const record = recordOf(error)
  const code = typeof record?.code === 'string' ? record.code : ''
  const errno = typeof record?.errno === 'string' ? record.errno : ''
  if (CONNECTION_CODES.has(code) || CONNECTION_CODES.has(errno)) return { state: 'unknown', kind: 'connection', detail }
  if ([code, errno].some((mark) => CONNECTION_PREFIXES.some((prefix) => mark.startsWith(prefix)))) {
    return { state: 'unknown', kind: 'connection', detail }
  }
  if (isOneBotRejection(error)) return { state: 'failed', kind: 'rejected', detail }
  return { state: 'unknown', kind: 'unknown', detail }
}
