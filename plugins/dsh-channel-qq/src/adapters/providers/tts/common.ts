/** 百度/谷歌两个 HTTP 回退后端共用的底座：语言换算、带超时的 GET、音频校验，
 * 以及可被测试替换的 fetch 句柄。
 *
 * `__setFetchForTest` 必须和真正调用它的 `httpGet` 同处一个模块：注入口替换的是
 * 这个模块级变量 `httpFetch` 本身，跨模块赋值不生效（单测/探针靠它离线验证回退路径）。
 */

/** 音色名 → 语言。音色永远是 edge 风格 id（zh-CN-XiaoxiaoNeural / en-US-AriaNeural / ja-JP-NanamiNeural…），
 * 百度/谷歌只吃两个字母的语言码，所以要在这里换算。 */
interface VoiceLang {
  /** 百度 lan：zh / en / ja … */
  baidu: string
  /** 谷歌 tl：zh-CN / en / ja … */
  google: string
}

/** 回退接口是普通 HTTPS，30s 足够；超时收敛成中文 Error。 */
const HTTP_TIMEOUT_MS = 30_000
/** 小于这个字节数基本是错误页 / 静音占位，当成失败。 */
const MIN_AUDIO_BYTES = 1000

export const HTTP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0'

/** 从音色名推语言：zh-CN/zh-TW/zh-HK/zh-* → 中文，en-* / ja-* / ko-* … 取前两位小写，认不出当中文。 */
export function voiceLang(voice: string): VoiceLang {
  const id = voice.trim().toLowerCase()
  if (id.startsWith('zh-') || id === 'zh') return { baidu: 'zh', google: 'zh-CN' }
  const match = /^([a-z]{2})(?:-[a-z0-9]+)*$/i.exec(id)
  if (match === null) return { baidu: 'zh', google: 'zh-CN' }
  const code = (match[1] ?? '').toLowerCase()
  return { baidu: code, google: code }
}

/** 一次 HTTP 回退的输入。 */
export interface HttpOptions {
  text: string
  voice: string
  /** 形如 +0% / +20% / -10%，只有百度用得上。 */
  rate: string
  log: (l: string) => void
}

/**
 * 可被测试替换的 fetch 句柄：用 `new URLSearchParams()` 而不是手写 encodeURIComponent，
 * 空格的编码方式和浏览器完全一致（百度/谷歌都按浏览器请求设计）。测试里直接覆盖这个变量。
 */
let httpFetch: typeof fetch = fetch

/** HTTP 请求公共部分：浏览器 UA + 30s 超时 + 非 2xx 直接抛（错误信息带状态码，回退时要用）。 */
export async function httpGet(url: URL, headers: Record<string, string>, backend: string): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS)
  try {
    const response = await httpFetch(url, { method: 'GET', headers, signal: controller.signal })
    if (!response.ok) throw new Error(`${backend}语音接口返回异常：HTTP ${response.status}`)
    return response
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`${backend}语音接口返回异常：请求超时（${HTTP_TIMEOUT_MS / 1000}s）`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/** 校验 content-type 与长度，返回 mp3 字节。 */
export async function readAudio(response: Response, backend: string): Promise<Buffer> {
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
  if (!contentType.startsWith('audio/')) {
    throw new Error(`${backend}语音接口返回异常：content-type=${contentType || '(空)'}，不是音频`)
  }
  const audio = Buffer.from(await response.arrayBuffer())
  if (audio.length < MIN_AUDIO_BYTES) {
    throw new Error(`${backend}语音接口返回异常：只收到 ${audio.length} 字节，疑似错误页或静音`)
  }
  return audio
}

/** 仅给单测用的注入口：替换 HTTP fetch（百度/谷歌回退走它）。 */
export function __setFetchForTest(fn: typeof fetch | null): void {
  httpFetch = fn ?? fetch
}
