/** 语音合成的工具面 (P4.2/P4.4)：3 个工具——列音色 / 念成语音条 / 只存文件。
 *
 * spec 逐字节来自原来的 `src/tts.ts::registerTtsTools`——P4 的判据是工具名、描述与
 * 参数 schema 一条都不许变（`test/golden/tools/other-tools.txt` 钉着这一点）。
 * 原来的注册函数 77 行、超 60 行硬上限，所以一个工具一个工厂函数，注册函数只负责组表。
 * 合成本体在 `adapters/providers/tts/`（edge / 百度 / 谷歌三个后端），这里只管"模型怎么调用它"。
 */

import { registerSpecs, params, type ToolHost, type ToolSpec } from '../../adapters/dsh-host/tools.js'
import type { QQChannelConfig } from '../../config.js'
import type { QQApi } from '../../ports/platform.js'
import type { OutboundQueue } from '../../outbound.js'
import {
  FALLBACK_NOTE, POPULAR_VOICES, resolveProvider, resolveTtsDir, synthesize, textToVoiceMessage,
  type SynthesizeOptions, type TtsProvider,
} from '../../adapters/providers/tts/index.js'

const TTS_DISABLED_NOTE = '语音合成已在配置里关闭'

function asText(value: unknown): string {
  return value === undefined || value === null ? '' : String(value).trim()
}

/** 工具参数 → 合成参数：工具没给的字段一律回落到 config.tts 的默认值。 */
function buildOptions(config: QQChannelConfig, log: (line: string) => void, args: Record<string, unknown>): SynthesizeOptions {
  return {
    voice: asText(args.voice) || config.tts.voice,
    rate: asText(args.rate) || config.tts.rate,
    pitch: asText(args.pitch) || config.tts.pitch,
    volume: asText(args.volume) || config.tts.volume,
    outDir: resolveTtsDir(config),
    log,
  }
}

/** `qq_list_voices` — 列出可用音色并说明当前实际生效的合成后端。 */
function qqListVoices(provider: TtsProvider): ToolSpec {
  return {
    name: 'qq_list_voices',
    description: '列出可用的 edge-tts 中文音色（免 key、免 GPU），并说明当前实际生效的合成后端。想发语音条前先用它挑一个 voice 名字，再交给 qq_tts_voice 或 qq_tts_save。',
    parameters: params({}),
    run: async () => ({
      count: POPULAR_VOICES.length,
      voices: POPULAR_VOICES,
      provider,
      // auto 时首选 edge，但 edge 是否可用只有真连一次才知道，所以写成策略而不是具体后端
      effective: provider === 'auto' ? 'auto: edge→baidu/google' : provider,
      fallbackNote: FALLBACK_NOTE,
    }),
  }
}

/** `qq_tts_voice` — 把文字念成语音条发到指定群或私聊。 */
function qqTtsVoice(
  config: QQChannelConfig,
  api: QQApi,
  out: OutboundQueue,
  log: (line: string) => void,
  provider: TtsProvider,
): ToolSpec {
  return {
    name: 'qq_tts_voice',
    description: '把一段文字念成语音条发到指定群或私聊（微软 edge-tts 免费音色，无需 key）。这是"想用语音说话"的默认入口；只想生成文件用 qq_tts_save。',
    parameters: params({
      text: { type: 'string', description: '要念的文字，别太长（超过 800 字会被截断）' },
      isGroup: { type: 'boolean', description: '是否发到群聊' },
      target: { type: 'number', description: '群号或好友QQ号' },
      voice: { type: 'string', description: '音色名，见 qq_list_voices；不填用配置默认' },
      rate: { type: 'string', description: '语速，如 +10% / -10%' },
      pitch: { type: 'string', description: '音调，如 +20Hz / -10Hz' },
      volume: { type: 'string', description: '音量，如 +20% / -10%' },
    }, ['text', 'isGroup', 'target']),
    run: async (args) => {
      if (!config.tts.enabled) return { ok: false, note: TTS_DISABLED_NOTE }
      const text = asText(args.text)
      if (text === '') throw new Error('text 不能为空：请给要念的文字。')
      const id = Number(args.target)
      if (!Number.isFinite(id) || id <= 0) throw new Error('target 必须是群号或好友QQ号（数字）。')
      const options = buildOptions(config, log, args)
      const result = await textToVoiceMessage(text, options, api, out, { isGroup: args.isGroup === true, id }, provider)
      return { ok: true, voice: options.voice, provider: result.provider, sent: result.sent }
    },
  }
}

/** `qq_tts_save` — 只合成本地 mp3 文件（不发送）。 */
function qqTtsSave(config: QQChannelConfig, log: (line: string) => void, provider: TtsProvider): ToolSpec {
  return {
    name: 'qq_tts_save',
    description: '只把文字合成为本地 mp3 文件（不发送），拿到 file 后可以用 qq_send_voice 发到任意会话，或另作他用。',
    parameters: params({
      text: { type: 'string', description: '要念的文字，超过 800 字会被截断' },
      voice: { type: 'string', description: '音色名，见 qq_list_voices；不填用配置默认' },
      rate: { type: 'string', description: '语速，如 +10%' },
      pitch: { type: 'string', description: '音调，如 +20Hz' },
      volume: { type: 'string', description: '音量，如 +20%' },
    }, ['text']),
    run: async (args) => {
      if (!config.tts.enabled) return { ok: false, note: TTS_DISABLED_NOTE }
      const text = asText(args.text)
      if (text === '') throw new Error('text 不能为空：请给要念的文字。')
      const result = await synthesize(text, buildOptions(config, log, args), provider)
      return {
        ok: true, file: result.file, bytes: result.bytes, voice: result.voice, provider: result.provider,
        // 截断必须告诉模型：否则它以为整段都念了（2026-10-19 排查）。
        ...(result.truncatedFrom === undefined ? {} : { note: `原文 ${result.truncatedFrom} 字，超过上限只念了前 800 字` }),
      }
    },
  }
}

/**
 * 注册 qq_list_voices / qq_tts_voice / qq_tts_save。
 *
 * 参数顺序与原来一致（调用方 src/index.ts 不改）。
 */
export function registerTtsTools(
  ctx: ToolHost,
  config: QQChannelConfig,
  api: QQApi,
  out: OutboundQueue,
  log: (line: string) => void,
): () => void {
  const provider = resolveProvider(config)
  const specs: ToolSpec[] = [
    qqListVoices(provider),
    qqTtsVoice(config, api, out, log, provider),
    qqTtsSave(config, log, provider),
  ]
  return registerSpecs(ctx, specs, log, 'tts')
}
