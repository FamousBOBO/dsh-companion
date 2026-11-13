/** DeepSeek 官方语音识别（ASR）客户端。
 *
 * 协议按官方文档核定（2026-11-13，见 docs/media/M6-report.md）：
 *
 *   POST {baseUrl}/v1/tools/asr
 *   Authorization: Bearer <DeepSeek API Key>
 *   multipart/form-data，音频放 `file` 字段
 *   → { request_id, text, duration_ms }
 *
 * 为什么不塞进 stt.ts 的 OpenAI 兼容分支：三处结构差异不是参数差别，是协议差别。
 *   1. 没有 `model` / `language` / `response_format` —— 语种由服务端自动判断；
 *   2. 限额是硬的（8 MiB、120 秒），超了服务端直接 413，本地先拒能省一次往返
 *      也避免把超长音频传上去才发现；
 *   3. 错误体是 `{error:{message,type,code}}`，不是纯文本。
 *
 * 计费按音频时长，所以任何本地就能判死的输入都在发请求前拒掉。
 */

import { promises as fs } from 'node:fs'
import { execFile } from 'node:child_process'
import * as path from 'node:path'
import { systemHttp } from '../http/client.js'

/** 官方限额：单文件 8 MiB、单条音频 120 秒。 */
export const ASR_MAX_BYTES = 8 * 1024 * 1024
export const ASR_MAX_SECONDS = 120

/** 文档列出的合法采样率。不在表里就拒，不偷偷重采样——重采样会改变时长口径。 */
const SAMPLE_RATES: ReadonlySet<number> = new Set([8000, 16000, 22050, 24000, 32000, 44100, 48000])

/** 官方端点；`baseUrl` 留空时用它。 */
export const DEFAULT_ASR_BASE_URL = 'https://api.deepseek.com'

/**
 * 凭证库里的引用名。
 *
 * 本机把平台 Key 存在 DSH 凭据库（`~/.dsh/.credentials.yaml` 的 `refs` 段）而不是
 * 插件配置文件里：这样它不进 git、不进后台配置快照、也不出现在日志里。
 */
export const DEEPSEEK_API_KEY_REF = 'DEEPSEEK_API_KEY'

export type AsrErrorCode =
  | 'ASR_UNSUPPORTED_AUDIO'
  | 'ASR_AUDIO_TOO_LARGE'
  | 'ASR_AUDIO_TOO_LONG'
  | 'ASR_AUTH'
  | 'ASR_INVALID_AUDIO'
  | 'ASR_UPLOAD_TIMEOUT'
  | 'ASR_RATE_LIMITED'
  | 'ASR_BUSY'
  | 'ASR_TIMEOUT'
  | 'ASR_UPSTREAM'

/** 带稳定错误码的 ASR 失败；`code` 是契约，`message` 只给人看。 */
export class AsrError extends Error {
  readonly code: AsrErrorCode

  constructor(code: AsrErrorCode, message: string) {
    super(message)
    this.name = 'AsrError'
    this.code = code
  }
}

export interface AsrOptions {
  /** 平台 API Key（`sk-` 开头）。 */
  apiKey: string
  /** 服务地址；调用方负责填默认值。 */
  baseUrl: string
  timeoutMs: number
}

interface WavFacts {
  readonly audioFormat: number
  readonly channels: number
  readonly sampleRate: number
  readonly bitsPerSample: number
  readonly dataBytes: number
}

/**
 * 读 WAV 头并把不合规的原因说清楚。
 *
 * 只做"能不能发"的判断，不解码音频：真正的转写由服务端做。
 * @param bytes - 完整文件字节。
 * @returns 解析出的格式与数据长度。
 * @throws {AsrError} 不是 RIFF/WAVE、块不完整、或不是 16 位 PCM。
 */
export function inspectWav(bytes: Buffer): WavFacts {
  if (bytes.length < 44) {
    throw new AsrError('ASR_UNSUPPORTED_AUDIO', `WAV 只有 ${bytes.length} 字节，读不出 44 字节头`)
  }
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    throw new AsrError('ASR_UNSUPPORTED_AUDIO', '不是 RIFF/WAVE 文件（只接受 16 位 PCM WAV 或 Ogg Opus）')
  }

  let fmt: { audioFormat: number; channels: number; sampleRate: number; bitsPerSample: number } | null = null
  let dataBytes = 0
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4)
    const size = bytes.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > bytes.length) {
        throw new AsrError('ASR_UNSUPPORTED_AUDIO', 'fmt 区块不完整')
      }
      fmt = {
        audioFormat: bytes.readUInt16LE(body),
        channels: bytes.readUInt16LE(body + 2),
        sampleRate: bytes.readUInt32LE(body + 4),
        bitsPerSample: bytes.readUInt16LE(body + 14),
      }
    } else if (id === 'data') {
      // 流式写出的文件会把 data 长度写成 0 或写成超出实际长度的值；
      // 以文件里真实剩多少为准，别信头里那个数。
      dataBytes = size === 0 || body + size > bytes.length ? bytes.length - body : size
    }
    // 块按偶数字节对齐：奇数长度的块后面补一个 0 字节。
    offset = body + size + (size % 2)
  }

  if (fmt === null) throw new AsrError('ASR_UNSUPPORTED_AUDIO', '缺少 fmt 区块')
  if (dataBytes <= 0) throw new AsrError('ASR_UNSUPPORTED_AUDIO', '缺少 data 区块')
  if (fmt.audioFormat !== 1) {
    throw new AsrError('ASR_UNSUPPORTED_AUDIO', `音频格式 ${fmt.audioFormat} 不是 PCM（1）；官方只收 16 位 PCM WAV`)
  }
  if (fmt.bitsPerSample !== 16) {
    throw new AsrError('ASR_UNSUPPORTED_AUDIO', `位深 ${fmt.bitsPerSample} 不是 16`)
  }
  if (fmt.channels !== 1 && fmt.channels !== 2) {
    throw new AsrError('ASR_UNSUPPORTED_AUDIO', `声道数 ${fmt.channels} 既不是单声道也不是双声道`)
  }
  return { ...fmt, dataBytes }
}

/**
 * 把字节数与头部事实判成"能不能发"；能发就返回时长。
 * @throws {AsrError} 超限或采样率不在官方列表里。
 */
export function assertSendable(bytes: Buffer): number {
  const facts = inspectWav(bytes)
  if (!SAMPLE_RATES.has(facts.sampleRate)) {
    throw new AsrError(
      'ASR_UNSUPPORTED_AUDIO',
      `采样率 ${facts.sampleRate} Hz 不在官方支持列表（${[...SAMPLE_RATES].join('/')}）内`,
    )
  }
  if (bytes.length > ASR_MAX_BYTES) {
    throw new AsrError('ASR_AUDIO_TOO_LARGE', `音频 ${bytes.length} 字节，超过上限 ${ASR_MAX_BYTES}`)
  }
  const seconds = facts.dataBytes / (facts.channels * 2 * facts.sampleRate)
  if (seconds > ASR_MAX_SECONDS) {
    throw new AsrError('ASR_AUDIO_TOO_LONG', `音频 ${seconds.toFixed(1)} 秒，超过上限 ${ASR_MAX_SECONDS} 秒`)
  }
  return seconds
}

/** 抹掉错误正文里的密钥形状；上游 401 会把 key 尾号回显在 message 里。 */
function redact(text: string, apiKey: string): string {
  let out = text
  if (apiKey !== '') out = out.split(apiKey).join('[redacted]')
  return out
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/g, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .slice(0, 200)
}

/** HTTP 状态 → 稳定错误码。全部不重试：ASR 按秒计费，重试要由人显式发起。 */
function failureFor(status: number, body: string, apiKey: string): AsrError {
  const detail = body.trim() === '' ? `HTTP ${status}（响应体为空）` : `HTTP ${status}: ${redact(body, apiKey)}`
  switch (status) {
    case 400:
      return new AsrError('ASR_INVALID_AUDIO', `音频被拒（格式不对或未过内容审核）：${detail}`)
    case 401:
    case 403:
      return new AsrError('ASR_AUTH', `API Key 无效或无权使用 ASR：${detail}`)
    case 408:
      return new AsrError('ASR_UPLOAD_TIMEOUT', `上传超过 10 分钟：${detail}`)
    case 413:
      return new AsrError('ASR_AUDIO_TOO_LARGE', `超过 8 MiB：${detail}`)
    case 429:
      return new AsrError('ASR_RATE_LIMITED', `并发超过账号上限（50），不会自动重试：${detail}`)
    case 503:
      return new AsrError('ASR_BUSY', `服务繁忙：${detail}`)
    case 504:
      return new AsrError('ASR_TIMEOUT', `识别超时：${detail}`)
    default:
      // 实测见过边缘节点对构造非法的 Key 返回 550 且 body 为空；这不是文档列出的码，
      // 所以如实归为 UPSTREAM，不猜成鉴权失败。
      return new AsrError('ASR_UPSTREAM', `上游返回 ${detail}`)
  }
}

/** `{request_id, text, duration_ms}`；文本为空表示这段音频里没有语音。 */
function readTranscript(body: string): string | null {
  const parsed = JSON.parse(body) as { text?: unknown }
  const text = typeof parsed.text === 'string' ? parsed.text.trim() : ''
  return text === '' ? null : text
}

/** curl 的可执行名因平台而异；只解析一次。 */
const CURL = process.platform === 'win32' ? 'curl.exe' : 'curl'

/**
 * 出口代理。
 *
 * 每次调用现读 `STT_PROXY` 而不是模块加载时读一次：测试要能改它，运维改环境变量
 * 也不该要求重启宿主。与 stt.ts 里的 OpenAI 兼容分支共用同一个变量名，语义一致。
 */
function proxyFor(): string | null {
  const raw = process.env.STT_PROXY
  return raw === undefined || raw === '' ? null : raw
}

/**
 * 转写一段 WAV。
 *
 * 发请求前先在本地把格式、体积、时长判掉：这些错误由本地给出比让服务端 413 更早，
 * 而且计费按音频秒数走，明知会失败就不该传。
 *
 * @param opts - 端点、密钥与超时。
 * @param wavPath - 磁盘上的 WAV 文件（silK 解码的产物，24 kHz 单声道 PCM16）。
 * @returns 转写文本；音频里没有语音时返回 `null`。
 * @throws {AsrError} 本地拒绝，或上游按状态码映射后的失败。
 */
export async function transcribeDeepSeekWav(opts: AsrOptions, wavPath: string): Promise<string | null> {
  const bytes = await fs.readFile(wavPath)
  assertSendable(bytes)

  const url = `${opts.baseUrl.replace(/\/+$/, '')}/v1/tools/asr`
  const filename = path.basename(wavPath)
  const timeoutMs = opts.timeoutMs

  const viaFetch = async (): Promise<string> => {
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(bytes)], { type: 'audio/wav' }), filename)
    // baseUrl 是运维在配置里填的（也可以指向自建中转），所以放行私网，与 whisper 分支同一条理由。
    const res = await systemHttp.request(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.apiKey}` },
      body: form,
      timeoutMs,
      allowPrivateHosts: true,
    })
    const text = res.text()
    if (!res.ok) throw failureFor(res.status, text, opts.apiKey)
    return text
  }

  const viaCurl = (proxy: string): Promise<string> => new Promise((resolve, reject) => {
    const args = ['-s', '-m', String(Math.ceil(timeoutMs / 1000)), '-w', '\n%{http_code}', '-x', proxy]
    args.push(
      '-F', `file=@${wavPath};filename=${filename};type=audio/wav`,
      '-H', `Authorization: Bearer ${opts.apiKey}`,
      url,
    )
    execFile(CURL, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) return reject(err)
      const idx = stdout.lastIndexOf('\n')
      const code = Number.parseInt(stdout.slice(idx + 1).trim(), 10)
      const body = stdout.slice(0, idx)
      if (code !== 200) return reject(failureFor(code, body, opts.apiKey))
      resolve(body)
    })
  })

  let body: string
  const proxy = proxyFor()
  try {
    body = await viaFetch()
  } catch (error) {
    // 只有代理在配置里时才换 curl；否则把原始失败原样抛出去，别掩盖真正的错因。
    if (proxy === null) throw error
    body = await viaCurl(proxy)
  }
  return readTranscript(body)
}
