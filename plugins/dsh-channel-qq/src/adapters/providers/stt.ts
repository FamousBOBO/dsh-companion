/** Voice-bar → text (STT) pipeline, ported from the OpenClaw extension:
 * get_record (silk) → silk-wasm decode → WAV → [OI]-compatible
 * /audio/transcriptions (Whisper-style form upload) → text for the model.
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { execFile } from 'node:child_process'
import { resolveDshHome } from '../../paths.js'
import { convertSilkToWav } from './silk.js'
import type { STTConfig } from '../../config.js'
import type { QQApi } from '../../ports/platform.js'
import { atomicWriteFile } from '../fs-store/atomic.js'
import { systemHttp } from '../http/client.js'

/** 语音文件体积上限（语音条最长也就几分钟）。 */
const MAX_VOICE_BYTES = 8 * 1024 * 1024

interface ResolvedSTT {
  baseUrl: string
  apiKey: string
  model: string
}

function resolveSTT(config: STTConfig): ResolvedSTT | null {
  if (!config.enabled || !config.baseUrl) return null
  let apiKey = config.apiKey ?? ''
  if (apiKey.startsWith('$')) apiKey = process.env[apiKey.slice(1)] ?? ''
  if (apiKey === '') return null
  return { baseUrl: config.baseUrl.replace(/\/+$/, ''), apiKey, model: config.model }
}

/** curl's binary name differs per platform; resolved once. */
const CURL = process.platform === 'win32' ? 'curl.exe' : 'curl'

/** Optional egress proxy for the transcription endpoint.
 *
 * No default: the old value assumed a Clash instance on the same host, which
 * silently pointed at nothing on a fresh server. */
const STT_PROXY = process.env.STT_PROXY ?? null

/** Transcribe one OpenAI-compatible `/audio/transcriptions` endpoint.
 *
 * Native fetch first — no external binary, so it works on every platform.
 * Some egress IPs get 403'd by the provider's edge and Node's fetch has no
 * proxy knob, so a configured `STT_PROXY` retries through curl with `-x`. */
async function transcribeWav(stt: ResolvedSTT, wavPath: string): Promise<string | null> {
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

/**
 * Fetch a voice-bar message and transcribe it.
 * @returns `[文字, 时长秒]`, or null when STT is disabled/unavailable.
 */
export async function transcribeVoiceMessage(
  api: QQApi,
  config: STTConfig,
  messageId: number,
  log: (line: string) => void,
): Promise<[string, number] | null> {
  const stt = resolveSTT(config)
  if (stt === null) return null
  const tempDir = path.join(resolveDshHome(), 'channel-qq', 'voice-tmp')
  await fs.mkdir(tempDir, { recursive: true })

  // 2026-09-17: out_format 'mp4' made NapCat fail with "file not found"
  // (ffmpeg unavailable). 'amr' returns the original file as-is; the silk→wav
  // conversion below handles it either way.
  const record = await api.getRecord(messageId, 'amr')
  let local = typeof record?.file === 'string' ? record.file : ''
  let bytes: Buffer | null = null
  if (local !== '' && !local.startsWith('http')) {
    bytes = await fs.readFile(local).catch(() => null)
  }
  if (bytes === null) {
    const url = typeof record?.url === 'string' ? record.url : (local.startsWith('http') ? local : '')
    if (url === '') throw new Error('get_record returned no usable file')
    // NapCat 给的语音地址，本机部署时就在 127.0.0.1 上。
    const res = await systemHttp.request(url, { limit: MAX_VOICE_BYTES, allowPrivateHosts: true })
    if (!res.ok) throw new Error(`voice download HTTP ${res.status}`)
    bytes = Buffer.from(res.bytes)
    local = path.join(tempDir, `voice_${messageId}`)
    await atomicWriteFile(local, bytes)
  }

  // NapCat hands us silk (or already-decoded audio); silk needs a decode to WAV.
  let wavPath = local
  if (local.endsWith('.silk') || local.endsWith('.slk') || local.endsWith('.amr')) {
    const converted = await convertSilkToWav(local, tempDir)
    if (converted === null) throw new Error('silk decode failed')
    wavPath = converted.wavPath
    log(`voice ${messageId}: silk → wav (${Math.round(converted.duration / 100) / 10}s)`)
  }

  const text = await transcribeWav(stt, wavPath)
  await fs.rm(local, { force: true }).catch(() => {})
  if (wavPath !== local) await fs.rm(wavPath, { force: true }).catch(() => {})
  return text === null ? null : [text, 0]
}
