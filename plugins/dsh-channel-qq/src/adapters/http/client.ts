/** `HttpClient` 端口的实现：`fetch` + 闸门 + 超时 + 体积上限。
 *
 * 全仓原来 32 处裸 `fetch(`，各自决定超时、体积、重定向策略。这个文件把那些
 * 决定变成**默认值**，并且默认值是安全的那一侧：
 *
 *   - 超时 15s（原来是各自写 `AbortSignal.timeout(...)`，漏一处就是永久挂起）；
 *   - 体积上限 256 KiB，超标报错（原来是有的读全量，一个超大响应就能把内存吃掉）；
 *   - 拦截私网 / 保留地址，跟随重定向时**逐跳**重新校验（`ssrf-guard.ts`）；
 *   - 重定向最多 5 跳。
 *
 * 要放宽必须在调用处显式写 `allowPrivateHosts: true`——见 `ports/http.ts` 里
 * 那两类允许的理由。
 */

import type { HttpClient, HttpOptions, HttpResponse } from '../../ports/http.js'
import { fetchGuarded } from './ssrf-guard.js'

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_LIMIT = 256 * 1024

export function createHttpClient(): HttpClient {
  return {
    async request(url: string, options: HttpOptions = {}): Promise<HttpResponse> {
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
      const headers = options.headers ?? {}
      // multipart 的 Content-Type 里带 boundary，必须由运行时生成；调用方写了也不要。
      if (options.body instanceof FormData) {
        delete headers['Content-Type']
        delete headers['content-type']
      }
      const method = options.method ?? (options.body === undefined ? 'GET' : 'POST')
      const init: RequestInit = {
        method,
        headers,
        // 超时就中断底层连接；只 reject 不 abort 会让请求在后台继续跑。
        signal: AbortSignal.timeout(timeoutMs),
      }
      if (options.body !== undefined) {
        init.body = options.body as RequestInit['body']
      }
      const { response, bytes, truncated, finalUrl } = await fetchGuarded(url, init, {
        limit: options.limit ?? DEFAULT_LIMIT,
        maxRedirects: options.maxRedirects ?? 5,
        allowPrivateHosts: options.allowPrivateHosts === true,
      })
      return {
        status: response.status,
        ok: response.ok,
        url: finalUrl,
        bytes,
        truncated,
        header: (name: string): string | null => response.headers.get(name),
        headerValues: (name: string): string[] => (name.toLowerCase() === 'set-cookie'
          ? (response.headers.getSetCookie?.() ?? [])
          : (response.headers.has(name) ? [response.headers.get(name) ?? ''] : [])),
        text: (): string => Buffer.from(bytes).toString('utf-8'),
        json: <T = unknown>(): T => JSON.parse(Buffer.from(bytes).toString('utf-8')) as T,
      }
    },
  }
}

/** 默认实例：没有理由换实现的调用方直接用它。 */
export const systemHttp: HttpClient = createHttpClient()
