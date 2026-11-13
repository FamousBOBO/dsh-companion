/** Voice-bar → text (STT) pipeline.
 *
 * get_record (silk) → silk-wasm decode → WAV → 后端 → text for the model.
 *
 * 两个后端，协议不同而不是参数不同，所以分叉在最后一步，而不是"多传几个字段"：
 *
 *   openai-compatible  POST {baseUrl}/audio/transcriptions（Whisper 风格表单，现状）
 *   deepseek-asr       POST {baseUrl}/v1/tools/asr（官方 ASR，无 model/language 参数）
 *
 * silk→wav 那段共用：解码出来固定是 24 kHz 单声道 PCM16，正好落在官方 ASR
 * 支持的采样率列表里，所以换后端不需要重采样。
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { execFile } from 'node:child_process'
import { resolveDshHome } from '../../paths.js'
import { convertSilkToWav } from './silk.js'
import { DEFAULT_ASR_BASE_URL, transcribeDeepSeekWav } from './stt-deepseek.js'
import type { STTConfig } from '../../config.js'
import type { QQApi } from '../../ports/platform.js'
import { atomicWriteFile } from '../fs-store/atomic.js'
import { systemHttp } from '../http/client.js'

/** 语音文件体积上限（语音条最长也就几分钟）。 */
const MAX_VOICE_BYTES = 8 * 1024 * 1024

/** curl's binary name differs per platform; resolved once. */
const CURL = process.platform === 'win32' ? 'curl.exe' : 'curl'

/** Optional egress proxy for the transcription endpoint.
 *
 * No default: the old value assumed a Clash instance on the same host, which
 * silently pointed at nothing on a fresh server. */
const STT_PROXY = process.env.STT_PROXY ?? null

/** 凭据来源：明文 / `$ENV` / 宿主凭据库。 */
export interface SttKeySource {
  /**
   * 现取宿主凭据库里的 Key（`ctx.credentials.resolve`）。
   *
   * 为什么是回调而不是一个字符串：Key 存在 DSH 凭据库里，改了要**立刻**生效，
   * 不能等插件重挂；而且它的值不该出现在任何配置快照或日志里。
   */
  resolveCredentialsKey?: () => Promise<string | null>
}

interface ResolvedStt {
  backend: 'openai-compatible' | 'deepseek-asr'
  baseUrl: string
  apiKey: string
  model: string
  timeoutMs: number
}

/** `$NAME` → 环境变量；其余原样（空串表示"没填"）。 */
function expandEnv(value: string | null): string {
  const text = (value ?? '').trim()
  if (!text.startsWith('$')) return text
  return (process.env[text.slice(1)] ?? '').trim()
}

/**
 * 把配置解析成一次调用要用的端点/密钥。
 *
 * 两种后端对必填项的要求不同：OpenAI 兼容要 baseUrl + key + model，
 * 官方 ASR 只要 key（地址留空就用官方，也没有 model 这个概念）。
 */
async function resolveSTT(config: STTConfig, source: SttKeySource): Promise<ResolvedStt | null> {
  if (!config.enabled) return null
  const backend = config.backend ?? 'openai-compatible'
  const timeoutMs = config.timeoutMs ?? 30_000

  // baseUrl 也支持 `$ENV`：自建 whisper 的地址常按机器不同；解析为空等于没填。
  const configuredBase = expandEnv(config.baseUrl ?? null)
  const baseUrl = configuredBase !== ''
    ? configuredBase
    // 没配地址时只剩官方后端有确定的默认端点。
    : (backend === 'deepseek-asr' ? DEFAULT_ASR_BASE_URL : '')
  if (baseUrl === '') return null

  let apiKey = expandEnv(config.apiKey)
  if (apiKey === '') {
    // 明文与 $ENV 都没给，才去凭据库要；宿主没装 credentials 服务时这一步拿到 null。
    apiKey = (await source.resolveCredentialsKey?.().catch(() => null)) ?? ''
  }
  if (apiKey === '') return null

  return {
    backend,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey,
    model: config.model,
    timeoutMs,
  }
}

/** Transcribe one OpenAI-compatible `/audio/transcriptions` endpoint.
 *
 * Native fetch first — no external binary, so it works on every platform.
 * Some egress IPs get 403'd by the provider's edge and Node's fetch has no
 * proxy knob, so a configured `STT_PROXY` retries through curl with `-x`. */
async function transcribeWav(stt: ResolvedStt, wavPath: string): Promise<string | null> {
  const readText = (body: string): string | null => {
    const value = (JSON.parse(body) as { text?: string }).text?.trim() ?? ''
    return value === '' ? null : value
  }

  const viaFetch = async (): Promise<string | null> => {
    const bytes = await fs.readFile(wavPath)
    const form = new FormData()
    form.append('file', new Blob([bytes]), path.basename(wavPath))
    form.append('model', stt.model)
    form.append('language', 'zh')
    form.append('response_format', 'json')
    // `baseUrl` 是运维在配置里填的：本机跑 whisper 完全合法，所以放行私网。
    const res = await systemHttp.request(`${stt.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${stt.apiKey}` },
      body: form,
      timeoutMs: 90_000,
      allowPrivateHosts: true,
    })
    const text = res.text()
    if (!res.ok) throw new Error(`STT HTTP ${res.status}: ${text.slice(0, 200)}`)
    return readText(text)
  }

  const viaCurl = (proxy: string | null): Promise<string | null> => new Promise((resolve, reject) => {
    const args = ['-s', '-m', '90', '-w', '\n%{http_code}']
    if (proxy !== null) args.push('-x', proxy)
    args.push(
      '-F', `file=@${wavPath};filename=${path.basename(wavPath)}`,
      '-F', `model=${stt.model}`,
      '-F', 'language=zh',
      '-F', 'response_format=json',
      '-H', `Authorization: Bearer ${stt.apiKey}`,
      `${stt.baseUrl}/audio/transcriptions`,
    )
    execFile(CURL, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) return reject(err)
      const idx = stdout.lastIndexOf('\n')
      const code = stdout.slice(idx + 1).trim()
      if (code !== '200') return reject(new Error(`STT HTTP ${code}: ${stdout.slice(0, idx).slice(0, 200)}`))
      resolve(readText(stdout.slice(0, idx)))
    })
  })

  try {
    return await viaFetch()
  } catch (error) {
    if (STT_PROXY === null) throw error
    return await viaCurl(STT_PROXY)
  }
}

/** 读一个本地路径；读不到（不存在 / 是 URL）返回 null，不抛。 */
async function readLocalFile(file: string): Promise<Buffer | null> {
  if (file === '' || file.startsWith('http')) return null
  return await fs.readFile(file).catch(() => null)
}

/**
 * 读本地语音文件，读不到就短重试。
 *
 * **为什么必须重试**：2026-11-14 实测，语音消息到达与 NapCat 把 silk 落盘发生在
 * **同一秒**（文件 CreationTime 与转写失败时间都是 02:23:27）。宿主一收到事件就去
 * 读 `record.path`，此时文件还没写完 → 读失败 → 退到 url 下载 → 下载回来的是
 * **真 AMR**（`#!AMR`），而 silk-wasm 解不了 AMR，于是整条语音失败。
 *
 * 而 `get_record` 要 ffmpeg 转码（本机没有），所以 `path` 是唯一能拿到 silk 的
 * 来源——必须等它落盘。
 *
 * @param file - 本地绝对路径。
 * @returns 文件字节，或重试窗口内始终读不到时的 null。
 */
async function readVoiceFileWithRetry(file: string): Promise<Buffer | null> {
  // 约 1.6 秒窗口：silk 只有几 KB，落盘是毫秒级的，这个窗口足够且不至于拖慢回合。
  const attempts = 8
  const delayMs = 200
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const bytes = await readLocalFile(file)
    if (bytes !== null && bytes.length > 0) return bytes
    if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  return null
}

/**
 * 按**文件头**判断是不是需要解码的语音容器。
 *
 * 为什么不看扩展名：NapCat 给的 `.amr` 里装的其实是 silk（`#!SILK_V3`），
 * 而 url 下载存下来的临时文件干脆没有扩展名。扩展名只作提示，真正的判据是字节。
 * @param file - 本地文件。
 * @returns 需要走 silk 解码时为 true。
 */
async function looksLikeVoiceContainer(file: string): Promise<boolean> {
  const lower = file.toLowerCase()
  const byName = lower.endsWith('.silk') || lower.endsWith('.slk') || lower.endsWith('.amr')
  const handle = await fs.open(file, 'r').catch(() => null)
  if (handle === null) return byName
  try {
    const head = Buffer.alloc(16)
    const { bytesRead } = await handle.read(head, 0, head.length, 0)
    const text = head.subarray(0, bytesRead).toString('latin1')
    return byName || text.includes('#!SILK') || text.includes('#!AMR')
  } catch {
    return byName
  } finally {
    await handle.close().catch(() => {})
  }
}

/** 按 URL 下载语音到临时目录。
 *
 * 文件名带上原件的扩展名（`.amr` / `.silk`）：万一文件头判断也不敢下结论，
 * 扩展名仍是最后一道提示。 */
async function downloadVoice(
  url: string,
  messageId: number,
  tempDir: string,
  nameHint: string,
): Promise<{ local: string; bytes: Buffer }> {
  // NapCat 给的语音地址，本机部署时就在 127.0.0.1 上。
  const res = await systemHttp.request(url, { limit: MAX_VOICE_BYTES, allowPrivateHosts: true })
  if (!res.ok) throw new Error(`voice download HTTP ${res.status}`)
  const bytes = Buffer.from(res.bytes)
  const ext = path.extname(nameHint).toLowerCase()
  const local = path.join(tempDir, `voice_${messageId}${ext}`)
  await atomicWriteFile(local, bytes)
  return { local, bytes }
}

/** 一条语音条的 record 段里我们关心的三个字段（缺省皆空串）。 */
interface RecordSegment {
  readonly path: string
  readonly url: string
  readonly fileName: string
}

/**
 * 从 `get_msg` 里取 record 段。
 *
 * 失败不抛：它只是三级回退里的第一级，失败原因记进 `tried` 供最终报错使用。
 * @param api - 协议端。
 * @param messageId - 语音条消息号。
 * @param tried - 失败原因收集器（由调用方一并报出）。
 */
async function recordSegmentOf(api: QQApi, messageId: number, tried: string[]): Promise<RecordSegment> {
  try {
    const fetched = await api.getMessage(messageId)
    const segments = Array.isArray(fetched?.message) ? fetched.message : []
    const segment = segments.find((item) => item.type === 'record')
    const data = segment?.type === 'record' ? segment.data : undefined
    return {
      path: typeof data?.path === 'string' ? data.path : '',
      url: typeof data?.url === 'string' ? data.url : '',
      fileName: typeof data?.file === 'string' ? data.file : '',
    }
  } catch (error) {
    tried.push(`get_msg 失败：${error instanceof Error ? error.message : String(error)}`)
    return { path: '', url: '', fileName: '' }
  }
}

/**
 * 取一条语音条的音源。
 *
 * 顺序有讲究，每一步都记下失败原因——最后一条报错要能看出全貌：
 *
 *   1. **`get_msg` 的 record 段 `path`**：NapCat 已经把 silk 落盘，并直接给出
 *      绝对路径。读它即可，不需要转码。
 *   2. **`get_record(messageId, 'amr')`**：协议文档的标准取法，但 NapCat 会调
 *      ffmpeg 转码；本机没有 ffmpeg，实测返回 `file not found` /
 *      `Encoder not found`。所以它只能是退路。
 *   3. **`url` 下载**：最后退路（`get_msg` 或 `get_record` 给的都算）。
 *
 * 历史：2026-09-17 曾把 `out_format` 从 'mp4' 改成 'amr'，以为能绕开 ffmpeg；
 * 2026-11-14 实测两条都会失败，真正的出路是第 1 步。
 *
 * `owned` 标明这个文件是不是**我们**建在临时目录里的：只有它才能被清理。
 * `get_msg.path` 指向的是 NapCat 自己的数据目录，删了就是毁用户数据。
 */
async function fetchVoiceSource(
  api: QQApi,
  messageId: number,
  tempDir: string,
  log: (line: string) => void,
): Promise<{ local: string; owned: boolean }> {
  const tried: string[] = []
  const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error))

  const segment = await recordSegmentOf(api, messageId, tried)
  if (segment.path !== '') {
    // 竞态：消息到达与落盘在同一秒，必须等文件写完（见 readVoiceFileWithRetry）。
    if ((await readVoiceFileWithRetry(segment.path)) !== null) {
      log(`voice ${messageId}: 音源=get_msg.path`)
      return { local: segment.path, owned: false }
    }
    tried.push(`get_msg.path 打不开：${segment.path}`)
  } else {
    tried.push('get_msg 里没有 record.path')
  }

  let record: { file?: string; url?: string } | undefined
  try {
    record = await api.getRecord(messageId, 'amr')
  } catch (error) {
    tried.push(`get_record 失败：${reason(error)}`)
  }
  const file = typeof record?.file === 'string' ? record.file : ''
  if ((await readLocalFile(file)) !== null) {
    log(`voice ${messageId}: 音源=get_record.file`)
    return { local: file, owned: false }
  }
  if (file !== '') tried.push(`get_record.file 读不到：${file}`)

  const url = segment.url !== ''
    ? segment.url
    : (typeof record?.url === 'string' && record.url !== '' ? record.url : (file.startsWith('http') ? file : ''))
  if (url !== '') {
    try {
      const downloaded = await downloadVoice(url, messageId, tempDir, segment.fileName || file)
      log(`voice ${messageId}: 音源=下载（${tried.join('；')}）`)
      return { local: downloaded.local, owned: true }
    } catch (error) {
      tried.push(`下载失败：${reason(error)}`)
    }
  }

  throw new Error(`取语音文件失败（${tried.join('；')}）`)
}

/**
 * Fetch a voice-bar message and transcribe it.
 * @returns `[文字, 时长秒]`, or null when STT is disabled/unavailable.
 */
export async function transcribeVoiceMessage(
  api: QQApi,
  config: STTConfig,
  messageId: number,
  log: (line: string) => void,
  source: SttKeySource = {},
): Promise<[string, number] | null> {
  const stt = await resolveSTT(config, source)
  if (stt === null) return null
  const tempDir = path.join(resolveDshHome(), 'channel-qq', 'voice-tmp')
  await fs.mkdir(tempDir, { recursive: true })

  const { local, owned } = await fetchVoiceSource(api, messageId, tempDir, log)

  // NapCat 给的是 silk（哪怕扩展名叫 .amr），需要先解成 WAV。
  // 判据是文件头而不是扩展名：下载下来的临时文件可能没有扩展名。
  let wavPath = local
  if (await looksLikeVoiceContainer(local)) {
    const converted = await convertSilkToWav(local, tempDir)
    if (converted === null) {
      // 走到这里通常意味着拿到的是**真 AMR**（`#!AMR`）而不是 silk——silk-wasm
      // 解不了 AMR，而官方 ASR 也不收 AMR。唯一出路是让 `get_msg.path` 成功
      // （那是 silk），所以消息要把这一点说清，别再让人去查 ASR 参数。
      throw new Error(
        'silk decode failed：拿到的不是 silk 音频（多为 AMR）。'
        + '请确认 NapCat 的 record.path 可读——get_record 需要 ffmpeg 转码，本机没有。',
      )
    }
    wavPath = converted.wavPath
    log(`voice ${messageId}: silk → wav (${Math.round(converted.duration / 100) / 10}s)`)
  }

  try {
    const text = stt.backend === 'deepseek-asr'
      ? await transcribeDeepSeekWav(
        { apiKey: stt.apiKey, baseUrl: stt.baseUrl, timeoutMs: stt.timeoutMs },
        wavPath,
      )
      : await transcribeWav(stt, wavPath)
    return text === null ? null : [text, 0]
  } finally {
    // 只清理我们自己建的文件：`owned=false` 时那是 NapCat 的数据目录，
    // 本来就在协议端管着，删了等于毁用户素材。
    if (owned) await fs.rm(local, { force: true }).catch(() => {})
    if (wavPath !== local) await fs.rm(wavPath, { force: true }).catch(() => {})
  }
}
