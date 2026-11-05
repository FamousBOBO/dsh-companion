/** 本机 embed 服务客户端（P6e·e2）：POST `<base>/v1/embeddings`，OpenAI 兼容形状。
 *
 * 三个决定值得写下来（09 §5.4）：
 *
 *   1. **800ms 超时**：拿不到向量就放弃向量这一路候选，绝不拖住一回合的组包
 *      （"含 embed 调用"的检索延迟门槛是 800ms）；
 *   2. **维度校验**：响应里任何一条向量长度 ≠ 配置维度 → 整批按"不可用"处理，
 *      **绝不写进索引**——维度错位读出来的是"别人的记忆"，这是 KB Lite 那个
 *      产物出过的真事故；
 *   3. **日志限流**：状态翻转（可用→不可用、恢复）各记一行；持续不可用时每
 *      5 分钟至多一行；失败后冷却 60 秒（冷却期内不碰网络）。服务没开时不能
 *      每回合刷一行。
 *
 * URL 只来自配置（`memory.vectorUrl`），永远不用消息里的文本拼——所以
 * `allowPrivateHosts` 放行的是 `ports/http.ts` 许可清单的第一类：
 * "运维在配置里填的地址"。失败**不抛**：`embed()` 失败返回 `null`，
 * 调用方据此退回关键词路径。
 */

import type { EmbedPort } from '../../ports/memory.js'
import type { HttpClient } from '../../ports/http.js'
import { systemHttp } from '../http/client.js'

/** 09 §5.4 的 800ms：这是"不让一回合被拖住"的上限，不是建议值。 */
const DEFAULT_TIMEOUT_MS = 800
/** 一批最多几条：512 维 × 16 条约 74KB JSON，塞得进下面的响应上限。 */
const MAX_BATCH = 16
/** 响应体积上限。512 维 × 16 条，每条浮点序列化成 ~20 字符 → 实测约 180KB；
 * 128KB 会把**正常的满批响应**判成不可用（2026-10-18 实测踩到）。 */
const MAX_RESPONSE_BYTES = 512 * 1024
/** 失败后的冷却：这段时间内直接按"不可用"处理，不碰网络。 */
const RETRY_COOLDOWN_MS = 60_000
/** 持续不可用的重复日志间隔。 */
const LOG_EVERY_MS = 5 * 60_000

export interface EmbedAdapterOptions {
  /** 服务基地址（配置项）。会补 `/v1/embeddings` 后缀；已以 `/embeddings` 结尾就用原样。 */
  readonly baseUrl: string
  /** 配置的向量维度；与响应不符时整批拒绝。 */
  readonly dim: number
  readonly timeoutMs?: number
  readonly log: (line: string) => void
  /** 测试注入；默认用全仓统一的系统客户端（`fetch` 只允许出现在 `adapters/http/`）。 */
  readonly http?: HttpClient
  /** 测试注入的时间源（冷却与日志限流用）。 */
  readonly now?: () => number
}

/** 把基地址补成 embeddings 端点。 */
function endpointOf(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '')
  if (base === '') return ''
  return /\/embeddings$/.test(base) ? base : `${base}/v1/embeddings`
}

/**
 * 解析 OpenAI 兼容响应；形状不对时返回**给日志看的原因**。
 *
 * 有合法的 `index` 就按它落位（服务端理论上可以乱序），最后做整数组补全检查
 * 兜底（重复 index 会留空洞）。维度不符的措辞刻意写全"绝不写进索引"。
 */
function parseEmbeddings(payload: unknown, count: number, dim: number): Float32Array[] | string {
  const data = (payload as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) return '响应里没有 data 数组'
  if (data.length !== count) return `响应条数不符（期望 ${count}，收到 ${data.length}）`
  const out: Array<Float32Array | undefined> = new Array<Float32Array | undefined>(count).fill(undefined)
  for (let i = 0; i < data.length; i++) {
    const entry = data[i] as { embedding?: unknown; index?: unknown } | undefined
    const embedding = entry?.embedding
    if (!Array.isArray(embedding)) return `第 ${i} 条没有 embedding 数组`
    if (embedding.length !== dim) {
      return `向量维度不符（期望 ${dim}，收到 ${embedding.length}）——整批按不可用处理，绝不写进索引`
    }
    const vec = new Float32Array(dim)
    for (let j = 0; j < dim; j++) {
      const value = Number(embedding[j])
      if (!Number.isFinite(value)) return `第 ${i} 条 embedding 含非数字`
      vec[j] = value
    }
    const index = typeof entry?.index === 'number' && Number.isInteger(entry.index)
      && entry.index >= 0 && entry.index < count ? entry.index : i
    out[index] = vec
  }
  const done: Float32Array[] = []
  for (let i = 0; i < count; i++) {
    const vec = out[i]
    if (vec === undefined) return `响应缺少第 ${i} 条（index 重复或缺失）`
    done.push(vec)
  }
  return done
}

/** 发一批（≤ MAX_BATCH 条）；任何失败都以抛错表达，由调用方统一收口成"不可用"。 */
async function requestBatch(
  http: HttpClient,
  endpoint: string,
  timeoutMs: number,
  dim: number,
  texts: readonly string[],
): Promise<Float32Array[]> {
  const response = await http.request(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: texts }),
    timeoutMs,
    limit: MAX_RESPONSE_BYTES,
    // URL 来自配置（运维填的本机服务）——不是消息内容，见 ports/http.ts 的许可清单。
    allowPrivateHosts: true,
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const parsed = parseEmbeddings(response.json<unknown>(), texts.length, dim)
  if (typeof parsed === 'string') throw new Error(parsed)
  return parsed
}

export function createEmbedAdapter(opts: EmbedAdapterOptions): EmbedPort {
  const { dim, log } = opts
  const now = opts.now ?? ((): number => Date.now())
  const http = opts.http ?? systemHttp
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const endpoint = endpointOf(opts.baseUrl)
  // 维度/地址非法是**配置错**：记一行、永久不可用，与"服务临时不可用"区分开。
  const invalid = !Number.isInteger(dim) || dim < 1 || dim > 8192
    ? `配置的向量维度非法（${String(dim)}）`
    : endpoint === '' ? 'embed 服务地址为空' : null
  if (invalid !== null) log(`memory.vector: ${invalid}，向量检索不可用`)

  let state: 'unknown' | 'up' | 'down' = 'unknown'
  let cooldownUntil = 0
  let lastDownLogAt = 0

  const available = (): boolean => invalid === null && (state !== 'down' || now() >= cooldownUntil)

  const markDown = (reason: string): void => {
    const at = now()
    if (state !== 'down') {
      log(`memory.vector: embed 服务不可用（${reason}），退回关键词检索（${RETRY_COOLDOWN_MS / 1000} 秒内不再重试）`)
      lastDownLogAt = at
    } else if (at - lastDownLogAt >= LOG_EVERY_MS) {
      log(`memory.vector: embed 服务仍不可用（${reason}）`)
      lastDownLogAt = at
    }
    state = 'down'
    cooldownUntil = at + RETRY_COOLDOWN_MS
  }

  return {
    dim,
    available,
    embed: async (texts) => {
      if (texts.length === 0) return []
      if (!available()) return null
      try {
        const vectors: Float32Array[] = []
        for (let i = 0; i < texts.length; i += MAX_BATCH) {
          vectors.push(...await requestBatch(http, endpoint, timeoutMs, dim, texts.slice(i, i + MAX_BATCH)))
        }
        if (state === 'down') log('memory.vector: embed 服务已恢复')
        state = 'up'
        return vectors
      } catch (error) {
        markDown(error instanceof Error ? error.message : String(error))
        return null
      }
    },
  }
}
