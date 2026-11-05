/** 出站请求的两道闸门：目标地址合法性 + 响应体积上限。
 *
 * 为什么需要它：群友可以往群里贴任意链接，插件会**替他去请求**（自动出卡、
 * `qq_resolve_link`）。没有闸门时，`http://127.0.0.1:6099`（NapCat WebUI）、
 * `http://127.0.0.1:8790`（管理后台）、`http://169.254.169.254`（云元数据）
 * 都会被真的请求一遍，标题与简介还会被带回群聊——这是一条现成的 SSRF。
 * 302 跳到内网同样是缺口，所以重定向必须逐跳检查，不能交给 `redirect: 'follow'`。
 *
 * 体积上限是同一件事的另一半：`res.arrayBuffer()` 会把响应**整份**读进内存，
 * 一个不诚实的服务器（或一个 10GB 的"图片"）就能把进程撑爆。这里按流读、
 * 读满即停，并主动 cancel，所以上限是真的上限，不是读完再截断。
 *
 * 设计约束：
 *   - 只依赖 `node:*`，不引入任何包（见 MODULE-CONTRACT.md）；
 *   - DNS 解析可注入（`resolve` 参数），测试不需要真网络；
 *   - 判定是「拒绝清单」而不是「允许清单」：未知的新公网地址照常放行，
 *     只有明确属于本机 / 内网 / 保留段的地址被挡——否则会把正常链接也误杀。
 */

import { lookup } from 'node:dns/promises'

/** 一个已解析的地址。 */
export interface AddressInfo {
  address: string
  family: number
}

/** 解析主机名的函数签名；默认用 `node:dns`，测试可注入。 */
export type ResolveHost = (host: string) => Promise<readonly AddressInfo[]>

/** 默认解析器：一次拿回该主机的**全部**地址（IPv4 + IPv6）。 */
export const defaultResolveHost: ResolveHost = async (host) =>
  await lookup(host, { all: true, verbatim: true })

/** 这些主机名一律拒绝：本机别名、内网后缀、云元数据端点。 */
const BLOCKED_HOST_SUFFIXES = ['.local', '.localhost', '.internal', '.home.arpa', '.in-addr.arpa']
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'instance-data',
])

/** 允许的协议：只有 http/https。file: / gopher: / data: 一律拒绝。 */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])

interface Cidr4 {
  /** 网络地址（32 位无符号）。 */
  net: number
  /** 掩码位数 0-32。 */
  bits: number
}

const ipv4 = (a: number, b: number, c: number, d: number): number =>
  (((a << 24) >>> 0) + (b << 16) + (c << 8) + d) >>> 0

/** IPv4 拒绝段：本机、内网、链路本地、CGNAT、文档与保留段、组播。 */
const BLOCKED_V4: readonly Cidr4[] = [
  { net: ipv4(0, 0, 0, 0), bits: 8 },          // "this network"
  { net: ipv4(10, 0, 0, 0), bits: 8 },         // 私网
  { net: ipv4(100, 64, 0, 0), bits: 10 },      // CGNAT / 运营商内网
  { net: ipv4(127, 0, 0, 0), bits: 8 },        // 环回
  { net: ipv4(169, 254, 0, 0), bits: 16 },     // 链路本地（含 169.254.169.254 元数据）
  { net: ipv4(172, 16, 0, 0), bits: 12 },      // 私网
  { net: ipv4(192, 0, 0, 0), bits: 24 },       // IETF 协议分配
  { net: ipv4(192, 0, 2, 0), bits: 24 },       // TEST-NET-1
  { net: ipv4(192, 168, 0, 0), bits: 16 },     // 私网
  { net: ipv4(198, 18, 0, 0), bits: 15 },      // 基准测试
  { net: ipv4(198, 51, 100, 0), bits: 24 },    // TEST-NET-2
  { net: ipv4(203, 0, 113, 0), bits: 24 },     // TEST-NET-3
  { net: ipv4(224, 0, 0, 0), bits: 4 },        // 组播
  { net: ipv4(240, 0, 0, 0), bits: 4 },        // 保留（含 255.255.255.255）
]

/** 把 `a.b.c.d` 解析成 32 位整数；不是合法 IPv4 返回 null。 */
export function parseIpv4(text: string): number | null {
  const parts = text.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const n = Number(part)
    if (n > 255) return null
    value = ((value << 8) + n) >>> 0
  }
  return value
}

/**
 * IPv6 → 16 字节。支持 `::` 压缩、内嵌 IPv4（`::ffff:1.2.3.4`）、结尾 `%zone`。
 * 解析失败返回 null（调用方按拒绝处理）。
 */
export function parseIpv6(text: string): Uint8Array | null {
  let host = text
  const zone = host.indexOf('%')
  if (zone >= 0) host = host.slice(0, zone)
  if (host === '') return null
  if (!host.includes(':')) return null

  // 内嵌 IPv4：把最后一段换成两段十六进制。
  if (host.includes('.')) {
    const lastColon = host.lastIndexOf(':')
    const embedded = parseIpv4(host.slice(lastColon + 1))
    if (embedded === null) return null
    const hi = (embedded >>> 16).toString(16)
    const lo = (embedded & 0xffff).toString(16)
    host = `${host.slice(0, lastColon)}:${hi}:${lo}`
  }

  const elision = host.indexOf('::')
  let head: string[] = []
  let tail: string[] = []
  if (elision >= 0) {
    if (host.indexOf('::', elision + 1) >= 0) return null
    head = host.slice(0, elision).split(':').filter((g) => g !== '')
    tail = host.slice(elision + 2).split(':').filter((g) => g !== '')
  } else {
    head = host.split(':')
  }
  const groups = elision >= 0 ? head.length + tail.length : head.length
  if (groups > 8) return null
  if (elision < 0 && groups !== 8) return null

  const padded = elision >= 0
    ? [...head, ...Array<string>(8 - groups).fill('0'), ...tail]
    : head
  const bytes = new Uint8Array(16)
  for (let i = 0; i < 8; i++) {
    const group = padded[i] ?? '0'
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null
    const value = Number.parseInt(group, 16)
    bytes[i * 2] = (value >> 8) & 0xff
    bytes[i * 2 + 1] = value & 0xff
  }
  return bytes
}

function bytesMatchPrefix(bytes: Uint8Array, prefix: readonly number[], bits: number): boolean {
  const full = Math.floor(bits / 8)
  for (let i = 0; i < full; i++) {
    if (bytes[i] !== prefix[i]) return false
  }
  const rest = bits % 8
  if (rest === 0) return true
  const mask = (0xff << (8 - rest)) & 0xff
  return ((bytes[full] ?? 0) & mask) === ((prefix[full] ?? 0) & mask)
}

const v6 = (...groups: number[]): number[] => {
  const out: number[] = []
  for (const group of groups) {
    out.push((group >> 8) & 0xff, group & 0xff)
  }
  return out
}

/** IPv6 拒绝段：环回、未指定、ULA、链路本地、组播、文档、NAT64/6to4 前缀。 */
const BLOCKED_V6: ReadonlyArray<{ prefix: readonly number[]; bits: number; label: string }> = [
  { prefix: v6(0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000), bits: 128, label: '未指定地址 ::' },
  { prefix: v6(0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0001), bits: 128, label: '环回 ::1' },
  { prefix: v6(0x0064, 0xff9b, 0, 0, 0, 0, 0, 0), bits: 96, label: 'NAT64 前缀' },
  { prefix: v6(0x0100, 0, 0, 0, 0, 0, 0, 0), bits: 64, label: '丢弃前缀 100::/64' },
  { prefix: v6(0x2001, 0x0db8, 0, 0, 0, 0, 0, 0), bits: 32, label: '文档段 2001:db8::/32' },
  { prefix: v6(0x2002, 0, 0, 0, 0, 0, 0, 0), bits: 16, label: '6to4 2002::/16' },
  { prefix: v6(0xfc00, 0, 0, 0, 0, 0, 0, 0), bits: 7, label: '唯一本地地址 fc00::/7' },
  { prefix: v6(0xfe80, 0, 0, 0, 0, 0, 0, 0), bits: 10, label: '链路本地 fe80::/10' },
  { prefix: v6(0xff00, 0, 0, 0, 0, 0, 0, 0), bits: 8, label: '组播 ff00::/8' },
]

/**
 * 判定单个 IP 字面量是否被拒。
 *
 * @returns 被拒原因（中文，可直接写进日志或讲给群友）；放行返回 null。
 */
export function blockedAddressReason(address: string): string | null {
  const v4 = parseIpv4(address)
  if (v4 !== null) {
    for (const cidr of BLOCKED_V4) {
      const mask = cidr.bits === 0 ? 0 : (0xffffffff << (32 - cidr.bits)) >>> 0
      if (((v4 & mask) >>> 0) === ((cidr.net & mask) >>> 0)) {
        return `目标是内网/保留地址（${address}）`
      }
    }
    return null
  }
  const bytes = parseIpv6(address)
  if (bytes === null) return `地址无法解析（${address}）`

  // IPv4-mapped（::ffff:a.b.c.d）与 IPv4-compatible：按里面的 IPv4 判定。
  const mapped = bytes.slice(0, 10).every((b) => b === 0)
    && ((bytes[10] === 0xff && bytes[11] === 0xff) || (bytes[10] === 0 && bytes[11] === 0))
  if (mapped) {
    const inner = `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`
    const reason = blockedAddressReason(inner)
    return reason === null ? null : `目标是内网/保留地址（${address} → ${inner}）`
  }

  for (const cidr of BLOCKED_V6) {
    if (bytesMatchPrefix(bytes, cidr.prefix, cidr.bits)) {
      return `目标是内网/保留地址（${address}：${cidr.label}）`
    }
  }
  return null
}

/**
 * 检查一个主机名是否可请求：先看名字本身，再解析 DNS 并逐个检查地址。
 *
 * @returns 被拒原因；放行返回 null。
 */
export async function blockedHostReason(host: string, resolve: ResolveHost = defaultResolveHost): Promise<string | null> {
  const name = host.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (name === '') return '主机名为空'
  if (BLOCKED_HOSTNAMES.has(name)) return `目标是本机地址（${name}）`
  for (const suffix of BLOCKED_HOST_SUFFIXES) {
    if (name.endsWith(suffix)) return `目标是本机地址（${name}）`
  }
  // 字面量 IP：直接判，不走 DNS。
  if (parseIpv4(name) !== null || name.includes(':')) {
    return blockedAddressReason(name)
  }
  // 没有点的名字（http://napcat/）只在带搜索域的内网里有意义，一律拒绝。
  if (!name.includes('.')) return `不像公网主机名（${name}）`

  let addresses: readonly AddressInfo[]
  try {
    addresses = await resolve(name)
  } catch {
    return `域名解析失败（${name}）`
  }
  if (addresses.length === 0) return `域名没有解析到地址（${name}）`
  for (const entry of addresses) {
    const reason = blockedAddressReason(entry.address)
    if (reason !== null) return reason
  }
  return null
}

/**
 * 解析并校验一个用户提供的 URL。
 *
 * @throws Error 中文文案，可直接讲给群友。
 */
export async function assertUrlAllowed(raw: string, resolve: ResolveHost = defaultResolveHost): Promise<URL> {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`这不像一个链接（${raw}）`)
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(`只支持 http/https（收到 ${parsed.protocol}）`)
  }
  const reason = await blockedHostReason(parsed.hostname, resolve)
  if (reason !== null) throw new Error(reason)
  return parsed
}

/** 跟随重定向时的逐跳上限。 */
const MAX_REDIRECTS = 5

export interface SafeFetchOptions {
  /**
   * 放行私网 / 保留地址（默认 false）。
   *
   * 打开它的只有两类调用方，理由见 `ports/http.ts` 的 `HttpOptions`：
   * 运维在配置里填的地址，以及本机服务给的下载链接。**消息里的链接绝不能打开**。
   */
  allowPrivateHosts?: boolean
  /** 响应体积上限（字节）。默认 256KB。 */
  limit?: number
  /** 最多跟随几次重定向。默认 5。 */
  maxRedirects?: number
  /** 注入的解析器（测试用）。 */
  resolve?: ResolveHost
  /** 诊断输出。 */
  log?: (line: string) => void
}

export interface CappedResponse {
  /** 最终响应（`body` 已被读干，不要再用）。 */
  readonly response: Response
  /** 实际读到的字节（≤ limit）。 */
  readonly bytes: Buffer
  /** 是否因为到达上限而截断。 */
  readonly truncated: boolean
  /** 最终地址（重定向之后）。 */
  readonly finalUrl: string
}

/**
 * 带私网拦截、逐跳重定向检查、体积上限的 GET/HEAD。
 *
 * 与 `fetch(url, { redirect: 'follow' })` 的区别：每一跳都重新校验，
 * 所以「公网地址 302 到 127.0.0.1」这种绕法走不通。
 *
 * @throws Error 中文文案。
 */
export async function fetchGuarded(url: string, init: RequestInit = {}, opts: SafeFetchOptions = {}): Promise<CappedResponse> {
  const limit = opts.limit ?? 256 * 1024
  const maxRedirects = opts.maxRedirects ?? MAX_REDIRECTS
  const resolve = opts.resolve ?? defaultResolveHost

  let current = url
  for (let hop = 0; hop <= maxRedirects; hop++) {
    // 逐跳校验：只在第一跳拦是不够的——公网地址 302 到 127.0.0.1 就绕过去了。
    if (opts.allowPrivateHosts !== true) await assertUrlAllowed(current, resolve)
    const response = await fetch(current, { ...init, redirect: 'manual' })
    const status = response.status
    const isRedirect = status === 301 || status === 302 || status === 303 || status === 307 || status === 308
    if (!isRedirect) {
      if (init.method === 'HEAD') {
        // HEAD 没有正文；只需要头信息。
        try { await response.body?.cancel() } catch { /* 已经结束 */ }
        return { response, bytes: Buffer.alloc(0), truncated: false, finalUrl: response.url !== '' ? response.url : current }
      }
      const { bytes, truncated } = await readCapped(response, limit)
      return { response, bytes, truncated, finalUrl: response.url !== '' ? response.url : current }
    }
    const location = response.headers.get('location')
    try { await response.body?.cancel() } catch { /* 已经结束 */ }
    if (location === null || location === '') {
      throw new Error(`服务器返回 ${status} 但没有 Location`)
    }
    let next: string
    try {
      next = new URL(location, current).toString()
    } catch {
      throw new Error(`重定向目标不是合法地址（${location}）`)
    }
    opts.log?.(`link redirect ${hop + 1}: ${current} → ${next}`)
    current = next
  }
  throw new Error(`重定向次数超过 ${maxRedirects} 次`)
}

/**
 * 按上限读响应体。
 *
 * 用 `body.getReader()` 而不是 `arrayBuffer()`：后者会把任意大的响应整份读进
 * 内存，上限就形同虚设。读满即 cancel，连接不会继续往下淌。
 */
export async function readCapped(response: Response, limit: number): Promise<{ bytes: Buffer; truncated: boolean }> {
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > limit) {
    // 提前拒：省一次读，也避免把明显超标的响应拉下来。
    try { await response.body?.cancel() } catch { /* 已经结束 */ }
    throw new Error(`响应体积 ${declared} 字节，超过上限 ${limit}`)
  }
  const body: ReadableStream<Uint8Array> | null = response.body
  if (body === null) {
    const buf = Buffer.from(await response.arrayBuffer())
    return { bytes: buf.subarray(0, limit), truncated: buf.length > limit }
  }
  const reader = body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  let truncated = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      const chunk = Buffer.from(value)
      if (total + chunk.length > limit) {
        chunks.push(chunk.subarray(0, limit - total))
        total = limit
        truncated = true
        break
      }
      chunks.push(chunk)
      total += chunk.length
      if (total === limit) {
        // 正好读满，还需要再读一次才知道是不是真的结束。
        const peek = await reader.read()
        truncated = !peek.done
        if (!peek.done && peek.value !== undefined) {
          truncated = true
        }
        break
      }
    }
  } finally {
    try { await reader.cancel() } catch { /* 已经结束 */ }
  }
  return { bytes: Buffer.concat(chunks), truncated }
}
