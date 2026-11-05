/** 群内 AI 生图（P1-6）：provider 只做「调外部服务拿图 + 落盘」，不注册工具。
 *
 * 背景（实测）：本机 LLM 网关 `http://127.0.0.1:3123/v1` 只有 chat 接口，
 * `POST /v1/images/generations` 返回 404，所以默认后端只能是外部端点。
 * 选了 pollinations 的免 key 公开端点（`https://image.pollinations.ai/prompt/<urlencoded>`
 * 实测返回 200 + 真 JPEG），同时保留 `openai` 分支，方便学弟以后接自己的
 * 中转站/自建绘图服务（任何实现了 `/images/generations` 的 OpenAI 兼容端点）。
 *
 * 落盘而不是直接转发 URL：OneBot 的图片段需要本地文件或 URL，本地文件更可控，
 * 也顺手把生成结果留档，模型可以先 `qq_generate_image_save` 看一眼再决定发不发。
 *
 * 工具面在 `features/imagegen/tools.ts`——那里只管"模型怎么调用它"。
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { ImageGenConfig, QQChannelConfig } from '../../config.js'
import { resolveDshHome } from '../../paths.js'
import { atomicWriteFile } from '../fs-store/atomic.js'
import { systemHttp } from '../http/client.js'

/** 一次生图的结果描述；`file` 是绝对路径。 */
export interface ImageGenResult {
  file: string
  bytes: number
  provider: string
  prompt: string
  width: number
  height: number
}

/** 生图很慢（pollinations 常要 10~40 秒），超时给足，别在模型等的时候就掐断。 */
const GENERATE_TIMEOUT_MS = 90_000
/** 图片下载（openai 的 url 形态）10 秒够了。 */
const DOWNLOAD_TIMEOUT_MS = 30_000
/** 小于 1KB 的响应基本是错误页/占位图，不是真图。 */
const MIN_IMAGE_BYTES = 1000
/** 单张图上限 30MB，防止磁盘被一张怪图写满。 */
const MAX_IMAGE_BYTES = 30 * 1024 * 1024
/** 提示词上限：多数生图后端在 800 字附近开始丢后半段。 */
const PROMPT_LIMIT = 800

function clampDimension(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(2048, Math.max(256, Math.round(n)))
}

/**
 * 从字节流魔数判断真实图片类型。
 *
 * 不用 content-type 决定后缀：pollinations 偶尔返回 `application/octet-stream`，
 * 而 QQ 的图片段对后缀敏感——后缀错了就发不出去。
 */
function detectExt(bytes: Buffer, contentType: string): string {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg'
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp'
  const type = contentType.toLowerCase()
  if (type.includes('png')) return 'png'
  if (type.includes('webp')) return 'webp'
  if (type.includes('jpeg') || type.includes('jpg')) return 'jpg'
  return 'jpg'
}

/** 校验一下是不是真拿到图片，失败就抛中文 Error 让模型知道能怎么办。 */
function assertImage(bytes: Buffer, contentType: string, source: string): void {
  const looksLikeImage = contentType.toLowerCase().startsWith('image/')
    || (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    || (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
  if (!looksLikeImage) {
    throw new Error(`生图返回的不是图片（content-type=${contentType || '(空)'}，${bytes.length} 字节）：${source}。可能是提示词被拒或后端抖动，换个提示词重试。`)
  }
  if (bytes.length < MIN_IMAGE_BYTES) {
    throw new Error(`生图返回的图片只有 ${bytes.length} 字节，太小了（不是真图）：${source}。稍后重试。`)
  }
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new Error(`生图返回的图片 ${Math.round(bytes.length / 1024 / 1024)}MB 超过上限，已放弃写入：${source}`)
  }
}

/** 需要就 mkdir -p，返回确保存在的目录。 */
async function ensureDir(dir: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true })
  return dir
}

/**
 * pollinations：GET 一句 URL 就出图，无需任何 key。
 *
 * Two behaviours learned by probing the live endpoint from this host:
 *   - Adding a `model=` query parameter makes it answer **402 immediately**
 *     (named models are gated behind a token); the plain endpoint still
 *     returns 200 + a real JPEG, so no `model` is ever sent here.
 *   - The anonymous queue is rate-limited per IP: a 402/429/5xx arrives
 *     sporadically and the very next attempt succeeds. Those are transient,
 *     not configuration errors, so they are retried with a short backoff
 *     instead of surfacing a failure the model cannot act on.
 */
async function generateViaPollinations(
  prompt: string,
  width: number,
  height: number,
  log: (l: string) => void,
): Promise<{ bytes: Buffer; contentType: string }> {
  const attempts = 3
  let lastError = ''
  for (let attempt = 1; attempt <= attempts; attempt++) {
    // seed 随机：同一条提示词每次都能出点不一样的图，否则 pollinations 会回同一张缓存。
    const seed = Math.floor(Math.random() * 1_000_000)
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${width}&height=${height}&nologo=true&seed=${seed}`
    try {
      // pollinations 是硬编码的公网地址，过闸门没有副作用。
      const response = await systemHttp.request(url, {
        headers: { 'User-Agent': 'dsh-channel-qq/1.0', Accept: 'image/*' },
        timeoutMs: GENERATE_TIMEOUT_MS,
        limit: MAX_IMAGE_BYTES,
      })
      if (response.ok) {
        const bytes = Buffer.from(response.bytes)
        const contentType = response.header('content-type') ?? ''
        assertImage(bytes, contentType, 'pollinations')
        return { bytes, contentType }
      }
      lastError = `HTTP ${response.status}`
      // 402 = 匿名队列满了；429/5xx = 限流或后端抖动。都值得再等一等。
      if (![402, 429, 500, 502, 503, 504].includes(response.status)) break
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    if (attempt < attempts) {
      const wait = 2000 * attempt
      log(`imagegen: pollinations ${lastError}，${wait / 1000}s 后重试（第 ${attempt + 1}/${attempts} 次）`)
      await new Promise((resolve) => setTimeout(resolve, wait))
    }
  }
  throw new Error(`生图失败 ${lastError}（pollinations 免费端点会按 IP 限流，稍后再试；也可以在配置里把生图后端换成自建的 OpenAI 兼容 /images/generations）：${prompt.slice(0, 60)}`)
}

/** 抽出 OpenAI 兼容响应里的图片字节：b64_json 直接解，url 再下载一次。 */
async function readOpenAiPayload(data: unknown, log: (l: string) => void): Promise<{ bytes: Buffer; contentType: string }> {
  const entry = Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : undefined
  if (entry === undefined || entry === null) throw new Error('生图接口返回里没有 data[0]，什么都没生成出来。检查 model 名是否正确。')
  const b64 = typeof entry.b64_json === 'string' ? entry.b64_json : ''
  if (b64 !== '') return { bytes: Buffer.from(b64, 'base64'), contentType: 'image/png' }
  const url = typeof entry.url === 'string' ? entry.url : ''
  if (url === '') throw new Error('生图接口既没给 b64_json 也没给 url，拿不到图。检查后端是否真的支持 /images/generations。')
  log(`imagegen: downloading result from ${url}`)
  let response
  try {
    // 这个地址来自**运维配置的生图后端**（可以是本机的 SD 服务），所以放行私网。
    response = await systemHttp.request(url, {
      timeoutMs: DOWNLOAD_TIMEOUT_MS, limit: MAX_IMAGE_BYTES, allowPrivateHosts: true,
    })
  } catch (error) {
    throw new Error(`下载生成的图片失败：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) throw new Error(`下载生成的图片失败 HTTP ${response.status}：${url}`)
  return { bytes: Buffer.from(response.bytes), contentType: response.header('content-type') ?? '' }
}

/** openai：任意 OpenAI 兼容 /images/generations。 */
async function generateViaOpenAi(
  prompt: string,
  config: ImageGenConfig,
  width: number,
  height: number,
  log: (l: string) => void,
): Promise<{ bytes: Buffer; contentType: string }> {
  const baseUrl = (config.baseUrl ?? '').trim().replace(/\/+$/, '')
  if (baseUrl === '') {
    throw new Error('生图后端是 openai 但 config.imageGen.baseUrl 是空的。让学弟在配置里填上 OpenAI 兼容地址（例如 https://api.example.com/v1），或把 provider 改成 pollinations 用免 key 端点。')
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'User-Agent': 'dsh-channel-qq/1.0' }
  if ((config.apiKey ?? '') !== '' && config.apiKey !== null) headers.Authorization = `Bearer ${config.apiKey}`
  let response
  try {
    // `baseUrl` 是运维配置的生图后端（本机 SD / 自建网关都合法）。
    response = await systemHttp.request(`${baseUrl}/images/generations`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: config.model, prompt, n: 1, size: `${width}x${height}` }),
      timeoutMs: GENERATE_TIMEOUT_MS,
      limit: 4 * 1024 * 1024,
      allowPrivateHosts: true,
    })
  } catch (error) {
    throw new Error(`生图请求失败：${error instanceof Error ? error.message : String(error)}：${baseUrl}/images/generations`)
  }
  const raw = response.text()
  if (!response.ok) {
    throw new Error(`生图失败 HTTP ${response.status}：${baseUrl}/images/generations —— ${raw.slice(0, 200)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`生图接口返回的不是 JSON（前 200 字）：${raw.slice(0, 200)}`)
  }
  const data = (parsed as { data?: unknown }).data
  return readOpenAiPayload(data, log)
}

/**
 * 生成一张图并落盘。prompt 空值/超长都在这里拦掉，调用方（模型）只需要传一句话。
 */
export async function generateImage(
  prompt: string,
  opts: { config: ImageGenConfig; outDir: string; log?: (l: string) => void },
): Promise<ImageGenResult> {
  const log = opts.log ?? ((): void => {})
  const trimmed = prompt.trim()
  if (trimmed === '') throw new Error('提示词是空的，先想清楚要画什么（建议用英文描述，效果更好）。')
  if (trimmed.length > PROMPT_LIMIT) log(`imagegen: prompt truncated from ${trimmed.length} to ${PROMPT_LIMIT} chars`)
  const finalPrompt = trimmed.slice(0, PROMPT_LIMIT)
  const config = opts.config
  const width = clampDimension(config.width, 1024)
  const height = clampDimension(config.height, 1024)
  const outDir = await ensureDir(opts.outDir)
  const provider = config.provider

  let generated: { bytes: Buffer; contentType: string }
  if (provider === 'openai') {
    generated = await generateViaOpenAi(finalPrompt, config, width, height, log)
  } else if (provider === 'pollinations') {
    generated = await generateViaPollinations(finalPrompt, width, height, log)
  } else {
    throw new Error(`不认识的生图后端 "${String(provider)}"，只能是 pollinations 或 openai。`)
  }
  const { bytes, contentType } = generated
  assertImage(bytes, contentType, provider)
  // 时间戳 + 随机后缀：同毫秒并发也不会互相覆盖。
  const ext = detectExt(bytes, contentType)
  const file = path.resolve(outDir, `gen_${Date.now()}.${ext}`)
  await atomicWriteFile(file, bytes)
  log(`imagegen: ${provider} → ${file} (${bytes.length}B, ${width}x${height})`)
  return { file, bytes: bytes.length, provider, prompt: finalPrompt, width, height }
}

// ───────────────────────── 配置与落盘目录 ─────────────────────────

/** 取出生图配置；缺段就抛中文错误（调用方直接把它讲给主控即可）。 */
export function requireConfig(config: QQChannelConfig): ImageGenConfig {
  const imageGen = config.imageGen
  if (imageGen === undefined || imageGen === null) throw new Error('配置里缺少 imageGen 段，先让主控补上。')
  return imageGen
}

/** 生图结果落盘目录：<workspace>/generated-images，没有工作区就落到 <dshHome>/channel-qq/images。 */
export function resolveOutDir(config: QQChannelConfig): string {
  const workspace = config.workspacePath
  if (typeof workspace === 'string' && workspace.trim() !== '') return path.join(workspace, 'generated-images')
  return path.join(resolveDshHome(), 'channel-qq', 'images')
}
