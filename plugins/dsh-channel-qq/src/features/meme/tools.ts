/** 表情包工具面（3 个）：qq_make_meme / qq_send_meme / qq_emoji_sticker_text。
 *
 * 配字实现（ffmpeg drawtext、折行、字体探测）在 `./render.js`——实现与工具面分开装：
 * "怎么配字"要能换（字体、滤镜），而"模型怎么调用它"不该跟着一起动。
 *
 * 三个 spec **逐字节**来自原来的 `src/meme.ts`——P4 的判据是工具名、描述、参数 schema
 * 一条都不许变（`test/golden/tools/other-tools.txt` 钉着这一点）。
 * 一个工具一个函数：单看一个工具时不必在文件里找它的边界。
 */

import * as path from 'node:path'
import { registerSpecs, params, type ToolHost, type ToolSpec } from '../../adapters/dsh-host/tools.js'
import type { QQChannelConfig } from '../../config.js'
import type { QQApi } from '../../ports/platform.js'
import type { OneBotMessageSegment } from '../../types.js'
import type { OutboundQueue } from '../../outbound.js'
import { resolveDshHome } from '../../paths.js'
import { napcatFileArg } from '../../local-file.js'
import { makeMeme } from './render.js'

/** 表情包输出目录：配置优先，否则 <workspacePath ?? dshHome>/downloads/memes。 */
function resolveMemeDir(config: QQChannelConfig): string {
  const configured = config.meme.dir?.trim()
  if (configured !== undefined && configured !== '') return configured
  const base = config.workspacePath?.trim() || resolveDshHome()
  return path.join(base, 'downloads', 'memes')
}

const MEME_DISABLED_NOTE = '表情包制作已在配置里关闭'

function asText(value: unknown): string {
  return value === undefined || value === null ? '' : String(value).trim()
}

/** `qq_make_meme` — 给本地图片配上下两行字，生成 PNG（不发送）。 */
function qqMakeMeme(config: QQChannelConfig, log: (line: string) => void): ToolSpec {
  return {
    name: 'qq_make_meme',
    description: '给一张本地图片配上上句/下句白字黑边的表情包文字，生成 PNG 文件（不发送）。做完要发出去就用 qq_send_meme，或把返回的 file 交给 qq_send_image。',
    parameters: params({
      image: { type: 'string', description: '本地图片绝对路径（png/jpg/gif/webp/bmp）' },
      top: { type: 'string', description: '上句文字，可空' },
      bottom: { type: 'string', description: '下句文字，可空' },
    }, ['image']),
    run: async (args) => {
      if (!config.meme.enabled) return { ok: false, note: MEME_DISABLED_NOTE }
      const image = asText(args.image)
      if (image === '') throw new Error('image 不能为空：请给本地图片的绝对路径。')
      const result = await makeMeme({
        image,
        top: asText(args.top),
        bottom: asText(args.bottom),
        fontFile: config.meme.fontFile,
        outDir: resolveMemeDir(config),
        log,
      })
      return { ok: true, result }
    },
  }
}

/**
 * 发送目标：必须是正整数。`Number(undefined)` 是 NaN，NaN 一路进 outbound 队列
 * 只会变成一条"发不出去"的静默失败（2026-10-19 排查）。
 */
function targetOf(args: Record<string, unknown>): number {
  const raw = Number(args.target)
  if (!Number.isFinite(raw) || raw <= 0 || !Number.isInteger(raw)) {
    throw new Error(`target 必须是正整数（群号或好友 QQ 号），收到 ${String(args.target)}`)
  }
  return raw
}

/** `qq_send_meme` — 现场做一张并直接发到指定群或私聊。 */
function qqSendMeme(config: QQChannelConfig, api: QQApi, out: OutboundQueue, log: (line: string) => void): ToolSpec {
  return {
    name: 'qq_send_meme',
    description: '现场做一张配上句/下句的表情包并直接发到指定群或私聊。适合"用这张图接个梗"的场合；只想生成文件用 qq_make_meme。',
    parameters: params({
      image: { type: 'string', description: '本地图片绝对路径（png/jpg/gif/webp/bmp）' },
      top: { type: 'string', description: '上句文字，可空' },
      bottom: { type: 'string', description: '下句文字，可空' },
      isGroup: { type: 'boolean', description: '是否发到群聊' },
      target: { type: 'number', description: '群号或好友QQ号' },
    }, ['image', 'isGroup', 'target']),
    run: async (args) => {
      if (!config.meme.enabled) return { ok: false, note: MEME_DISABLED_NOTE }
      const image = asText(args.image)
      if (image === '') throw new Error('image 不能为空：请给本地图片的绝对路径。')
      const result = await makeMeme({
        image,
        top: asText(args.top),
        bottom: asText(args.bottom),
        fontFile: config.meme.fontFile,
        outDir: resolveMemeDir(config),
        log,
      })
      const message: OneBotMessageSegment[] = [{ type: 'image', data: { file: await napcatFileArg(result.file) } }]
      const sent = await out.push(() => api.sendTo(args.isGroup === true, targetOf(args), message))
      return { ok: true, result, sent }
    },
  }
}

/** `qq_emoji_sticker_text` — 只填 bottom 的 qq_send_meme 快捷入口。 */
function qqEmojiStickerText(config: QQChannelConfig, api: QQApi, out: OutboundQueue, log: (line: string) => void): ToolSpec {
  return {
    name: 'qq_emoji_sticker_text',
    description: '给一张已收藏的表情包配一句下方的吐槽并发出（等价于只填 bottom 的 qq_send_meme 快捷入口）。',
    parameters: params({
      file: { type: 'string', description: '表情包图片的本地绝对路径' },
      text: { type: 'string', description: '要压在下方的文字' },
      isGroup: { type: 'boolean', description: '是否发到群聊，默认 true' },
      target: { type: 'number', description: '群号或好友QQ号' },
    }, ['file', 'text']),
    run: async (args) => {
      if (!config.meme.enabled) return { ok: false, note: MEME_DISABLED_NOTE }
      const file = asText(args.file)
      const text = asText(args.text)
      if (file === '') throw new Error('file 不能为空：请给表情包图片的绝对路径。')
      if (text === '') throw new Error('text 不能为空：请给要压在下方的文字。')
      const result = await makeMeme({
        image: file,
        bottom: text,
        fontFile: config.meme.fontFile,
        outDir: resolveMemeDir(config),
        log,
      })
      if (args.target === undefined || args.target === null) return { ok: true, result }
      const message: OneBotMessageSegment[] = [{ type: 'image', data: { file: await napcatFileArg(result.file) } }]
      const sent = await out.push(() => api.sendTo(args.isGroup !== false, targetOf(args), message))
      return { ok: true, result, sent }
    },
  }
}

/**
 * 注册 qq_make_meme / qq_send_meme / qq_emoji_sticker_text。
 *
 * 接线与 `registerLinkTools` 相同：返回的 disposer 交给 cordis 的 effect/cleanup 即可。
 */
export function registerMemeTools(
  ctx: ToolHost,
  config: QQChannelConfig,
  api: QQApi,
  out: OutboundQueue,
  log: (line: string) => void,
): () => void {
  const specs: ToolSpec[] = [
    qqMakeMeme(config, log),
    qqSendMeme(config, api, out, log),
    qqEmojiStickerText(config, api, out, log),
  ]
  return registerSpecs(ctx, specs, log, 'meme')
}
