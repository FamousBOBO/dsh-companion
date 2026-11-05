/** HTTP 端口：一次"带闸门的取回"。
 *
 * **只有类型**（06 §P2.5）。实现在
 * `adapters/http/client.ts`，SSRF 规则在 `adapters/http/ssrf-guard.ts`。
 *
 * 为什么需要它：全仓 32 处 `fetch(` 各自决定超时、体积上限、是否跟随重定向。
 * 这三件事在"取一个群友发的链接"这条路径上全是安全边界，而**每一处都要
 * 记得写**——迟早会漏。收进端口之后，默认值即安全值，要放宽必须显式写出来。
 *
 * 默认值（实现必须遵守）：
 *   - 超时 15s；
 *   - 响应体积上限 256 KiB，超了就报错而不是默默截断；
 *   - **拦截私网/保留地址**，且跟随重定向时**逐跳重新校验**；
 *   - 重定向最多 5 跳。
 */

/** 一次请求的选项。 */
export interface HttpOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'HEAD'
  headers?: Record<string, string>
  /** 请求体。`FormData` 走 multipart，此时不要自己设 Content-Type（boundary 由运行时补）。 */
  body?: string | Uint8Array | FormData
  timeoutMs?: number
  /** 响应体积上限（字节）。默认 256 KiB。 */
  limit?: number
  /** 重定向上限。默认 5；`0` 表示不跟随。 */
  maxRedirects?: number
  /**
   * 放行私网 / 保留地址。
   *
   * **默认 false，而且必须逐处显式写**。只有两类 URL 可以打开它：
   *   1. 运维在配置里填的地址（本地 whisper、本地生图后端——那是运维自己的机器）；
   *   2. 来自本机服务的地址（NapCat 的文件下载链接就可能是 127.0.0.1）。
   * 消息里的链接、模型给出的地址、以及它们重定向到的地方，一律不许打开。
   *
   * 打开它仍然保留超时、体积上限、重定向跳数限制——只是不再拦地址。
   */
  allowPrivateHosts?: boolean
}

/** 一次取回的结果。正文已经读进内存（所以有上限），因此不需要再管流。 */
export interface HttpResponse {
  readonly status: number
  readonly ok: boolean
  /** 跟随重定向之后的最终地址。 */
  readonly url: string
  readonly bytes: Uint8Array
  /** 正文被体积上限截断过（只有 `allowTruncated` 的场景会出现）。 */
  readonly truncated: boolean
  /** 头字段（大小写不敏感）。没有时返回 null。 */
  header(name: string): string | null
  /**
   * 同名头的**全部**取值。
   *
   * 需要它的是 `set-cookie`：合并成一个字符串再按逗号拆是错的——cookie 的
   * `Expires` 里就有逗号。没有同名头时返回空数组。
   */
  headerValues(name: string): string[]
  text(): string
  json<T = unknown>(): T
}

/** 取回器。 */
export interface HttpClient {
  /** 取一次；失败（网络、超时、私网、体积超标）一律抛 `Error`，不返回半截结果。 */
  request(url: string, options?: HttpOptions): Promise<HttpResponse>
}
