/** 免 key 音色（P0-5）：把文字念成语音条。首选微软 edge-tts，失败自动回退百度/谷歌 HTTP 接口。
 *
 * 为什么要有 HTTP 回退（别把下面这段当多余代码删掉）：
 * 2026-10 在目标服务器（香港数据中心 IP）实测，edge-tts 的 WebSocket 升级**一律 403**
 * （Origin 用 https://edge.microsoft.com 或上游 edge-tts 的 chrome-extension://…、
 * 带/不带 Sec-MS-GEC、GEC 放头还是放 query、带 Pragma/Cache-Control，7 种组合全被拒，
 * 响应带 `Ref B: HKG…`，是微软边缘节点直接拒的），但同一台机器上
 * `https://speech.platform.bing.com/…/voices/list` 仍 200（主机可达，被拒的只是 WS 升级），
 * 而百度 `fanyi.baidu.com/gettts` 和谷歌 `translate.google.com/translate_tts` 都 200 / audio/mpeg。
 * 所以只走 edge 的话，这台服务器发语音条的能力等于零；`tts.provider: 'auto'` 先 edge、
 * 失败按音色语言回退百度（中文）/谷歌（其它语言），两个都试过还失败才报错。
 *
 * 为什么 mp3 直接发 `{type:'record'}`：NapCat 收到 mp3/wav 会自己转 silk，
 * 我们不需要（也不该）在这里重复 audio-convert 里那套 silk 编码。
 *
 * 文件布局：三个后端在 `./edge.js`（WebSocket）与 `./baidu.js` / `./google.js`（HTTP 回退），
 * 两个 HTTP 后端共用的 fetch 底座与注入口在 `./common.js`；工具面在 `features/voice/tts.ts`。
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { QQChannelConfig } from '../../../config.js'
import type { QQApi } from '../../../ports/platform.js'
import type { OneBotMessageSegment } from '../../../types.js'
import type { OutboundQueue } from '../../../outbound.js'
import { resolveDshHome } from '../../../paths.js'
import { napcatFileArg } from '../../../local-file.js'
import { atomicWriteFile } from '../../fs-store/atomic.js'
import { voiceLang, type HttpOptions } from './common.js'
import { collectAudio } from './edge.js'
import { baiduSynthesize } from './baidu.js'
import { googleSynthesize } from './google.js'

// `__setFetchForTest` 定义在 `./common.js`——它必须和真正调用 `httpFetch` 的 `httpGet`
// 同处一个模块。这里再导出，调用方从一个入口就够。
export { __setFetchForTest } from './common.js'

/** 一个可选音色：name 是 edge 的 voice id，label 是给模型/人看的中文说明。 */
export interface VoiceOption {
  name: string
  label: string
}

/** 中文常用音色（大陆/辽宁/陕西/台湾/香港），label 写成人话方便模型挑。 */
export const POPULAR_VOICES: VoiceOption[] = [
  { name: 'zh-CN-XiaoxiaoNeural', label: '晓晓（温柔女声，最通用）' },
  { name: 'zh-CN-XiaoyiNeural', label: '晓伊（活泼女声）' },
  { name: 'zh-CN-YunxiNeural', label: '云希（年轻男声）' },
  { name: 'zh-CN-YunjianNeural', label: '云健（浑厚男声，适合旁白）' },
  { name: 'zh-CN-YunyangNeural', label: '云扬（新闻播报男声）' },
  { name: 'zh-CN-YunxiaNeural', label: '云夏（少年音）' },
  { name: 'zh-CN-liaoning-XiaobeiNeural', label: '晓北（东北大碴子味女声）' },
  { name: 'zh-CN-shaanxi-XiaoniNeural', label: '晓妮（陕西味女声）' },
  { name: 'zh-TW-HsiaoChenNeural', label: '曉臻（台湾女声）' },
  { name: 'zh-TW-YunJheNeural', label: '雲哲（台湾男声）' },
  { name: 'zh-HK-HiuMaanNeural', label: '曉曼（粤语女声）' },
  { name: 'zh-HK-WanLungNeural', label: '雲龍（粤语男声）' },
]

/** 默认音色，与 config.ts 里 `tts.voice` 的默认值保持一致。 */
const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural'

/** 太长的文本会让整条语音拖到超时，截断比失败好。 */
const MAX_TEXT_CHARS = 800

export interface SynthesizeOptions {
  voice?: string
  rate?: string
  pitch?: string
  volume?: string
  outDir: string
  log?: (l: string) => void
}

export interface SynthesizeResult {
  file: string
  bytes: number
  voice: string
  /** 实际成功的后端（edge / baidu / google），auto 模式下可能不是首选那个。 */
  provider: string
  /** 原文长度；超过上限被截断时才出现（调用方要把这件事告诉模型/主人）。 */
  truncatedFrom?: number
}

/** 配置里可选的合成后端；auto = 先 edge，失败再回退百度/谷歌。 */
export type TtsProvider = 'auto' | 'edge' | 'baidu' | 'google'

/** 真正干活的三个后端（auto 不是后端，只是策略）。 */
type TtsBackend = 'edge' | 'baidu' | 'google'

/** 一句话说清 auto 的行为，给 qq_list_voices 回给模型看。 */
export const FALLBACK_NOTE = 'edge 在数据中心 IP 上常被 403 拒掉握手，provider=auto 会自动回退到百度/谷歌 HTTP 接口；'
  + '两个回退后端不区分音色（只按音色名的语言选语言），语速由 rate 换算（百度 1-15，5≈常速；谷歌忽略）。'

/** 只读配置里的 provider 值：兼容 config 还没补这个字段的版本，认不出就当 auto。 */
export function resolveProvider(config: QQChannelConfig): TtsProvider {
  const raw = (config.tts as { provider?: unknown }).provider
  return raw === 'edge' || raw === 'baidu' || raw === 'google' || raw === 'auto' ? raw : 'auto'
}

/** 中文语境优先百度，其它语言优先谷歌（谷歌的小语种覆盖更稳）。 */
function fallbackOrder(voice: string): TtsBackend[] {
  return voiceLang(voice).google === 'zh-CN' ? ['baidu', 'google'] : ['google', 'baidu']
}

/** 某个后端合成为 mp3 字节。 */
function synthesizeWith(backend: TtsBackend, opts: HttpOptions & { pitch: string; volume: string }): Promise<Buffer> {
  if (backend === 'edge') return collectAudio(opts)
  if (backend === 'baidu') return baiduSynthesize(opts)
  return googleSynthesize(opts)
}

/**
 * 真正的合成句柄，正常就是上面的 synthesizeWith。
 * 抽成可替换变量有两个理由：单测能在不联网、不模拟 ws 的情况下验证 provider 分派与回退；
 * 以后要加新后端也只改这一处。
 */
let runBackend: (backend: TtsBackend, opts: HttpOptions & { pitch: string; volume: string }) => Promise<Buffer> = synthesizeWith

/**
 * 把文字合成为本地 mp3 文件。
 *
 * provider 分派：edge 只走 edge；baidu / google 只走对应 HTTP 接口；
 * auto（默认）先 edge，失败后按音色语言回退（中文→百度、其它→谷歌），再失败两个都试一遍。
 *
 * @param provider config.tts.provider，省略即 auto
 * @throws 中文 Error（文本为空 / 全部后端失败；错误信息里带每个后端各自的失败原因）
 */
export async function synthesize(
  text: string,
  opts: SynthesizeOptions,
  provider: TtsProvider = 'auto',
): Promise<SynthesizeResult> {
  const log = opts.log ?? (() => {})
  const voice = opts.voice?.trim() || DEFAULT_VOICE
  const rate = opts.rate?.trim() || '+0%'
  const pitch = opts.pitch?.trim() || '+0Hz'
  const volume = opts.volume?.trim() || '+0%'

  let body = text.trim()
  if (body === '') throw new Error('要念的文字是空的：text 不能为空。')
  const originalLength = body.length
  if (body.length > MAX_TEXT_CHARS) {
    log(`文本过长（${body.length} 字），已截断到 ${MAX_TEXT_CHARS} 字`)
    body = body.slice(0, MAX_TEXT_CHARS)
  }

  const collect: HttpOptions & { pitch: string; volume: string } = { text: body, voice, rate, pitch, volume, log }
  // provider 明确指定时只走那一个后端，不做回退（排障时行为可预期）
  const order: TtsBackend[] = provider === 'auto' ? ['edge', ...fallbackOrder(voice)] : [provider]
  const failures: string[] = []
  let audio: Buffer | null = null
  let used: TtsBackend | null = null

  for (const backend of order) {
    try {
      audio = await runBackend(backend, collect)
      used = backend
      break
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      failures.push(`${backend}=${reason}`)
      log(`tts 后端 ${backend} 失败：${reason}`)
    }
  }

  if (used === null || audio === null) throw new Error(`语音合成全部失败：${failures.join('；')}`)
  if (audio.length === 0) throw new Error(`${used} 合成失败：服务端没有返回音频数据，稍后再试`)

  const outDir = path.resolve(opts.outDir)
  await fs.mkdir(outDir, { recursive: true })
  const outFile = path.join(outDir, `tts_${used}_${Date.now()}.mp3`)
  await atomicWriteFile(outFile, audio)
  log(`tts → ${outFile} (${audio.length}B, voice=${voice}, provider=${used})`)
  return {
    file: outFile, bytes: audio.length, voice, provider: used,
    ...(originalLength > MAX_TEXT_CHARS ? { truncatedFrom: originalLength } : {}),
  }
}

/**
 * 合成 mp3 并当语音条发出去（NapCat 自己转 silk），发完删掉临时文件。
 * 删除放在 finally：发送失败也不该把垃圾留在磁盘上，但删不掉不影响本次结果。
 */
export async function textToVoiceMessage(
  text: string,
  opts: SynthesizeOptions,
  api: QQApi,
  out: OutboundQueue,
  target: { isGroup: boolean; id: number },
  provider: TtsProvider = 'auto',
): Promise<{ provider: string; sent: unknown }> {
  const result = await synthesize(text, opts, provider)
  try {
    const message: OneBotMessageSegment[] = [{ type: 'record', data: { file: await napcatFileArg(result.file) } }]
    const sent = target.isGroup
      ? await out.push(() => api.sendGroupMessage(target.id, message))
      : await out.push(() => api.sendPrivateMessage(target.id, message))
    return { provider: result.provider, sent }
  } finally {
    await fs.rm(result.file, { force: true }).catch(() => {})
  }
}

/** 语音输出目录：配置优先，否则 <dshHome>/channel-qq/tts。 */
export function resolveTtsDir(config: QQChannelConfig): string {
  const configured = config.tts.dir?.trim()
  if (configured !== undefined && configured !== '') return configured
  return path.join(resolveDshHome(), 'channel-qq', 'tts')
}

/**
 * 仅给单测用的注入口（正常代码不要调用）：替换后端合成句柄。
 * 传 null 恢复真实实现（edge WebSocket / 百度 / 谷歌 HTTP）。
 */
export function __setBackendForTest(
  fn: ((backend: TtsBackend, opts: HttpOptions & { pitch: string; volume: string }) => Promise<Buffer>) | null,
): void {
  runBackend = fn ?? synthesizeWith
}
