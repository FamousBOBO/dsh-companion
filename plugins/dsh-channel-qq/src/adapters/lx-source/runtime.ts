/** 落雪（LX Music）自定义音源的运行时。
 *
 * LX 音源是一段 JS，运行在宿主提供的 `globalThis.lx` 上：
 *
 *   on(EVENT_NAMES.request, ({action, source, info}) => …)   // 收到"要播放地址"
 *   send(EVENT_NAMES.inited, {status, sources})              // 脚本就绪
 *   request(url, options, callback)                          // 脚本发 HTTP 的唯一路径
 *
 * 这里用 `node:vm` 起一个**干净的上下文**：没有 `process`、`require`、`fetch`、
 * 文件系统；脚本能碰到的只有 `lx.request`（走全仓的 HTTP 闸门，默认拦私网），
 * 以及一个空实现的 console。禁掉字符串代码生成（eval / new Function），并对
 * 同步执行加超时。
 *
 * 诚实地说：`vm` 不是安全边界（Node 官方文档也这么写），它能挡的是"脚本不小心
 * 引用 Node 全局"，挡不住刻意逃逸的代码。所以音源**必须由管理员显式配置**，
 * 脚本只从该配置给的 URL 加载；默认空 = 功能不存在。这与 LX Music 自身的模型
 * 一致：音源是用户自己装的插件。
 */

import { createContext, Script } from 'node:vm'
import type { HttpClient } from '../../ports/http.js'
import { systemHttp } from '../http/client.js'

/** 脚本大小上限（正常音源几十 KB）。 */
const MAX_SCRIPT_BYTES = 1024 * 1024
/** 同步执行超时：脚本初始化时不应该长时间阻塞。 */
const DEFAULT_RUN_TIMEOUT_MS = 3_000
/** 一次 `lx.request` 的超时。 */
const REQUEST_TIMEOUT_MS = 15_000
/** 一次 URL 解析（含脚本内部请求）的超时。 */
const RESOLVE_TIMEOUT_MS = 25_000
/** 响应体上限：音源接口只返回一个小 JSON。 */
const RESPONSE_LIMIT = 1024 * 1024

/** 脚本在 `inited` 里声明的音源（只要名字，其余字段原样保留）。 */
export interface LxDeclaredSource {
  readonly name?: string
  readonly actions?: readonly string[]
  readonly qualitys?: readonly string[]
}

export interface LxRuntimeOptions {
  readonly http?: HttpClient
  readonly runTimeoutMs?: number
  /** 注入时钟/日志（测试用）。 */
  readonly log?: (line: string) => void
}

export interface LxLoadedSource {
  readonly sources: Readonly<Record<string, LxDeclaredSource>>
  /** 向脚本要一首歌的播放地址（`action: musicUrl`）。 */
  resolveUrl(input: {
    readonly source: string
    readonly musicInfo: Readonly<Record<string, unknown>>
    readonly quality: string
  }): Promise<string>
}

type Callback = (error: unknown, response?: { statusCode: number; body: unknown; headers: Record<string, string> }) => void

/**
 * 响应体：像 JSON 就解析成对象，否则原样给字符串。
 *
 * 这一步是 LX 的宿主行为：音源脚本有的直接读 `body.code`（ikun），有的自己
 * `JSON.parse(body)`（聆澜，字符串也接受）。**不能只给字符串**——ikun 会把
 * JSON 字符串当对象读，`body.code` 是 undefined，于是报 "unknow error"。
 */
function parseBody(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return text
  try {
    return JSON.parse(trimmed)
  } catch {
    return text
  }
}

interface LxHostState {
  requestHandler: ((input: unknown) => unknown) | null
  inited: { sources?: Record<string, LxDeclaredSource> } | null
}

/** 把 `lx.request` 的选项翻成端口选项：只认白名单字段，脚本给的一切都不直接信任。 */
function toHttpOptions(options: unknown): { method: 'GET' | 'POST'; headers: Record<string, string>; body: string | undefined; maxRedirects: number } {
  const raw = (options !== null && typeof options === 'object' ? options : {}) as Record<string, unknown>
  const method = String(raw.method ?? 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET'
  const headers: Record<string, string> = {}
  if (raw.headers !== null && typeof raw.headers === 'object') {
    for (const [key, value] of Object.entries(raw.headers as Record<string, unknown>)) {
      if (typeof value === 'string') headers[key] = value
    }
  }
  let body: string | undefined
  if (typeof raw.body === 'string') body = raw.body
  else if (raw.body !== undefined && raw.body !== null && typeof raw.body === 'object') {
    body = JSON.stringify(raw.body)
    headers['Content-Type'] ??= 'application/json'
  }
  const follow = Number(raw.follow_max ?? raw.maxRedirects ?? 5)
  const maxRedirects = Number.isFinite(follow) ? Math.max(0, Math.min(10, Math.trunc(follow))) : 5
  return { method, headers, body, maxRedirects }
}

/** `lx.request`：唯一允许脚本触达外界的通道。失败走 callback(err)，不抛进 vm。 */
function makeRequest(http: HttpClient, log: (line: string) => void): (url: unknown, options: unknown, callback: unknown) => void {
  return (url, options, callback) => {
    const target = String(url ?? '')
    if (!/^https?:\/\//i.test(target)) {
      ;(callback as Callback)(new Error('只允许 http(s) 地址'))
      return
    }
    if (typeof callback !== 'function') return
    const opts = toHttpOptions(options)
    void http.request(target, {
      method: opts.method,
      headers: opts.headers,
      ...(opts.body === undefined ? {} : { body: opts.body }),
      timeoutMs: REQUEST_TIMEOUT_MS,
      limit: RESPONSE_LIMIT,
      maxRedirects: opts.maxRedirects,
      // 音源 URL 来自脚本，属于"消息内容"一类：**不放行私网**。
    }).then((response) => {
      ;(callback as Callback)(null, { statusCode: response.status, body: parseBody(response.text()), headers: {} })
    }).catch((error: unknown) => {
      log(`lx: 脚本请求失败 ${target.split('?')[0]} ${error instanceof Error ? error.message : String(error)}`)
      ;(callback as Callback)(error)
    })
  }
}

/** 交给脚本的 `globalThis.lx`。 */
function createLxHost(state: LxHostState, http: HttpClient, log: (line: string) => void): Record<string, unknown> {
  return {
    EVENT_NAMES: { request: 'request', inited: 'inited', updateAlert: 'updateAlert' },
    env: 'desktop',
    version: '2.6.0',
    on: (event: string, handler: unknown): void => {
      if (event === 'request' && typeof handler === 'function') state.requestHandler = handler as (input: unknown) => unknown
    },
    send: (event: string, data: unknown): void => {
      if (event === 'inited' && data !== null && typeof data === 'object') {
        state.inited = data as { sources?: Record<string, LxDeclaredSource> }
      }
    },
    request: makeRequest(http, log),
    // 少数音源会用到的工具集；没有实现的能力保持"不存在"，让脚本自己报错。
    utils: {},
  }
}

/** 跑一段音源脚本，拿到它声明的音源与 `musicUrl` 处理器。 */
export function runLxScript(scriptText: string, opts: LxRuntimeOptions = {}): LxLoadedSource {
  if (Buffer.byteLength(scriptText, 'utf8') > MAX_SCRIPT_BYTES) throw new Error('音源脚本超过 1MB')
  const log = opts.log ?? (() => {})
  const state: LxHostState = { requestHandler: null, inited: null }
  const lx = createLxHost(state, opts.http ?? systemHttp, log)

  const sandbox: Record<string, unknown> = {
    lx,
    // 音源脚本很喜欢在每次请求时 console.log 一串横幅（聆澜一次解析十几行）。
    // 这些是脚本自己的调试输出，不是本插件的事件——只保留 error，免得日志被刷满。
    console: {
      log: () => {},
      info: () => {},
      warn: () => {},
      error: (msg: unknown) => log(`lx(script): ${String(msg)}`),
      debug: () => {},
      group: () => {},
      groupEnd: () => {},
    },
  }
  // 码生成关掉（脚本不需要 eval / new Function）；这是"减少一类逃逸面"，不是
  // 安全边界——见文件头。同步执行的超时由 runInContext 兜底。
  const context = createContext(sandbox, { codeGeneration: { strings: false, wasm: false } })

  const script = new Script(scriptText, { filename: 'lx-source.js' })
  script.runInContext(context, {
    timeout: opts.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
    displayErrors: true,
  })
  const inited = state.inited
  if (inited === null) throw new Error('音源没有在启动时报告 inited（不是有效的 LX 音源？）')
  const handler = state.requestHandler
  if (handler === null) throw new Error('音源没有注册 request 处理器')

  return {
    sources: inited.sources ?? {},
    async resolveUrl(input) {
      const result = await withTimeout(Promise.resolve(handler({
        action: 'musicUrl',
        source: input.source,
        info: { musicInfo: input.musicInfo, type: input.quality },
      })), RESOLVE_TIMEOUT_MS)
      if (typeof result !== 'string' || !/^https?:\/\//i.test(result)) {
        throw new Error('音源没有返回可用的播放地址')
      }
      return result
    },
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`音源请求超过 ${ms}ms`)), ms) }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** 已加载的脚本缓存（按 URL；6 小时过期，失败不缓存）。 */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000
const cache = new Map<string, { at: number; loaded: LxLoadedSource }>()

/** 下载并加载一个音源脚本（带缓存）。 */
export async function loadLxSource(url: string, opts: LxRuntimeOptions = {}): Promise<LxLoadedSource> {
  const key = url.trim()
  if (!/^https?:\/\//i.test(key)) throw new Error('音源地址必须是 http(s) URL')
  const hit = cache.get(key)
  if (hit !== undefined && Date.now() - hit.at < CACHE_TTL_MS) return hit.loaded
  const http = opts.http ?? systemHttp
  const response = await http.request(key, { timeoutMs: 20_000, limit: MAX_SCRIPT_BYTES })
  if (!response.ok) throw new Error(`音源脚本下载失败 HTTP ${response.status}`)
  const loaded = runLxScript(response.text(), opts)
  cache.set(key, { at: Date.now(), loaded })
  return loaded
}

/** 清空缓存（后台"重新加载音源"用）。 */
export function clearLxCache(): void {
  cache.clear()
}
