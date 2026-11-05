/** 表情包：5 个工具。
 *
 * 表情包的列、搜、发。qq_send_sticker 是搜索+发送一步到位。
 *
 * 这些 spec **逐字节**来自原来的 `registerQQTools`——P4 的判据是工具名与
 * 参数 schema 一条都不许变（`test/golden/tools/qq-tools.txt` 钉着这一点）。
 * 一个工具一个函数：单看一个工具时不必在 1200 行里找它的边界。
 */

import { napcatFileArg, localPathOf } from '../../local-file.js'
import { resolveDshHome } from '../../paths.js'
import type { OneBotMessageSegment } from '../../types.js'
import type { ToolSpec } from '../../adapters/dsh-host/tools.js'
import type { QQToolDeps } from '../tool-deps.js'

/** `qq_send_emoji` — 发送一张本地表情包图片（stolen/registered 目录中的文件名）。… */
function qqSendEmoji(deps: QQToolDeps): ToolSpec {
  const { api, out } = deps
  return {
        name: 'qq_send_emoji',
        description: '发送一张本地表情包图片（stolen/registered 目录中的文件名）。',
        parameters: {
          type: 'object',
          properties: {
            isGroup: { type: 'boolean' },
            target: { type: 'number' },
            file: { type: 'string', description: '本地图片绝对路径' },
          },
          required: ['isGroup', 'target', 'file'],
        },
        run: async (args) => {
          const message: OneBotMessageSegment[] = [{ type: 'image', data: { file: await napcatFileArg(String(args.file)) } }]
          return args.isGroup === true
            ? await out.push(() => api.sendGroupMessage(Number(args.target), message))
            : await out.push(() => api.sendPrivateMessage(Number(args.target), message))
        },
      }
}

/** `qq_send_sticker` — 【表情包快捷调用】按情绪/语义/文件名直接发一张收藏的表情包：搜索+发送一步到位。拿不准氛围就先 qq_search_e… */
function qqSendSticker(deps: QQToolDeps): ToolSpec {
  const { api, out, library } = deps
  return {
        name: 'qq_send_sticker',
        description: '【表情包快捷调用】按情绪/语义/文件名直接发一张收藏的表情包：搜索+发送一步到位。拿不准氛围就先 qq_search_emojis 看清楚再决定。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '情绪或语义关键词，如 嘲讽 / 吃瓜 / 摸鱼；也可以直接给文件名' },
            isGroup: { type: 'boolean', description: '是否群聊' },
            target: { type: 'number', description: '群号或好友QQ号' },
            fallbackRandom: { type: 'boolean', description: '搜不到时随机发一张（默认 false —— 宁可不发也别乱发）' },
          },
          required: ['query', 'isGroup', 'target'],
        },
        run: async (args) => {
          if (library === undefined) throw new Error('表情库未启用，发不了表情包。')
          const query = String(args.query ?? '').trim()
          let hit: { file: string; source: string; desc: string; tags: string[]; score: number } | undefined = library.search(query, 1)[0]
          if (hit === undefined && args.fallbackRandom === true) {
            const pick = library.random()
            if (pick !== undefined) hit = { file: pick.file, source: pick.source, desc: pick.desc, tags: pick.tags, score: 0 }
          }
          if (hit === undefined) {
            throw new Error(`没搜到跟"${query}"相关的表情包。换个说法，或先用 qq_list_emojis 看库里有什么。`)
          }
          const message: OneBotMessageSegment[] = [{ type: 'image', data: { file: await napcatFileArg(hit.file) } }]
          const result = args.isGroup === true
            ? await out.push(() => api.sendGroupMessage(Number(args.target), message))
            : await out.push(() => api.sendPrivateMessage(Number(args.target), message))
          return { ok: true, sent: hit.file, desc: hit.desc, tags: hit.tags, result }
        },
      }
}

/** `qq_list_emojis` — 列出咱收藏的表情包（本地文件路径）。发表情前先列出来挑一张合适的。… */
function qqListEmojis(deps: QQToolDeps): ToolSpec {
  const { out, config, library } = deps
  return {
        name: 'qq_list_emojis',
        description: '列出咱收藏的表情包（本地文件路径）。发表情前先列出来挑一张合适的。',
        parameters: { type: 'object', properties: {} },
        run: async () => {
          if (library !== undefined) {
            const entries = library.list(40)
            return {
              count: entries.length,
              emojis: entries.map((e) => ({ file: e.file, source: e.source, desc: e.desc, tags: e.tags })),
            }
          }
          const fs = await import('node:fs/promises')
          const path = await import('node:path')
          const emojiCfg = config.emoji
          const home = resolveDshHome()
          const dir = emojiCfg.dir ?? path.join(home, 'channel-qq', 'emoji')
          const regDir = emojiCfg.registeredDir ?? path.join(dir, '..', 'emoji-registered')
          const out: Array<{ file: string; source: string }> = []
          for (const [d, source] of [[regDir, 'registered'], [dir, 'stolen']] as const) {
            try {
              for (const f of await fs.readdir(d)) {
                if (!f.startsWith('.')) out.push({ file: path.join(d, f), source })
              }
            } catch {}
          }
          return { count: out.length, emojis: out.slice(0, 60) }
        },
      }
}

/** `qq_search_emojis` — 按情绪/语义搜索咱收藏的表情包（比如：嘲讽、开心、摸鱼、吃瓜）。返回最匹配的几张的文件路径和描述，用 qq_send_e… */
function qqSearchEmojis(deps: QQToolDeps): ToolSpec {
  const { library } = deps
  return {
        name: 'qq_search_emojis',
        description: '按情绪/语义搜索咱收藏的表情包（比如：嘲讽、开心、摸鱼、吃瓜）。返回最匹配的几张的文件路径和描述，用 qq_send_emoji 发送其中 file。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '情绪或语义关键词，如 嘲讽 / 开心 / 吃瓜' },
            limit: { type: 'number', description: '最多返回几张（默认5）' },
          },
          required: ['query'],
        },
        run: async (args) => {
          if (library === undefined) return { error: '表情库未启用', emojis: [] }
          const hits = library.search(String(args.query ?? ''), Math.min(Number(args.limit ?? 5), 10))
          return { count: hits.length, emojis: hits }
        },
      }
}

/** `qq_emoji_stats` — 看表情库统计：总数、已打标数、常用标签 top10。… */
function qqEmojiStats(deps: QQToolDeps): ToolSpec {
  const { library } = deps
  return {
        name: 'qq_emoji_stats',
        description: '看表情库统计：总数、已打标数、常用标签 top10。',
        parameters: { type: 'object', properties: {} },
        run: async () => {
          if (library === undefined) return { error: '表情库未启用' }
          const entries = library.list(100000)
          const tagCount: Record<string, number> = {}
          let tagged = 0
          for (const e of entries) {
            if (e.tags.length > 0) tagged += 1
            for (const t of e.tags) tagCount[t] = (tagCount[t] ?? 0) + 1
          }
          const top = Object.entries(tagCount).sort((a, b) => b[1] - a[1]).slice(0, 10)
          return { total: entries.length, tagged, topTags: top }
        },
      }
}

/** 组装这一组工具。 */
export function stickersTools(deps: QQToolDeps): ToolSpec[] {
  return [
    qqSendEmoji(deps),
    qqSendSticker(deps),
    qqListEmojis(deps),
    qqSearchEmojis(deps),
    qqEmojiStats(deps),
  ]
}
