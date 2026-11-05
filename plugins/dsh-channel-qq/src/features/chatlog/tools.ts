/** 原话簿工具面：`qq_group_digest` 跨群摘要。
 *
 * 与记忆工具的分工：`qq_recall` 检索的是蒸馏后的结构化记忆；本工具直接读原话簿
 * 原始流水，回答「哪个群发生了什么 / 某群今天聊了什么」这类需要原文的问题。
 *
 * 默认关：`chatlog.enabled` 为 false 时不注册工具（golden 工具快照不含它）。
 */

import { registerSpecs, params, type ToolHost, type ToolSpec } from '../../adapters/dsh-host/tools.js'
import type { QQChannelConfig } from '../../config.js'
import { listGroupIds, localClock, readDay, type DigestMessage } from './store.js'

/** 注册原话簿工具；配置关闭时不注册任何东西。返回卸载器。 */
export function registerChatLogTools(ctx: ToolHost, config: QQChannelConfig, log: (line: string) => void): () => void {
  if (config.chatlog.enabled !== true) return () => {}
  return registerSpecs(ctx, [groupDigest(config)], log, 'chatlog')
}

function groupDigest(config: QQChannelConfig): ToolSpec {
  return {
    name: 'qq_group_digest',
    description: '群动态摘要：读各群原话簿（实时落盘的纯消息流水），按群返回指定日期的发言。问「哪个群发生了什么/某群今天聊了什么/所有群都在聊什么」时用这个，跨群汇总一次拿全。',
    parameters: params({
      room: { type: 'string', description: '哪间房，如 group-1000000006；不填=全部群' },
      day: { type: 'string', description: '哪天 YYYY-MM-DD；不填=今天' },
      limit: { type: 'number', description: '每群最多取多少条（默认 15，上限 30）' },
    }),
    run: async (args) => {
      const dir = config.chatlog.dir ?? `${config.workspacePath ?? ''}/chatlog`
      const day = String(args.day ?? localClock().day)
      const rawLimit = Number(args.limit)
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 30) : 15
      const want = String(args.room ?? '').trim().replace(/^group-/, '')
      const ids = (await listGroupIds(dir)).filter((id) => want === '' || id === want)
      const groups: Array<{ room: string; count: number; messages: DigestMessage[] }> = []
      for (const id of ids) {
        const messages = await readDay(dir, id, day)
        if (messages.length === 0) continue
        groups.push({ room: `group-${id}`, count: messages.length, messages: messages.slice(-limit) })
      }
      if (groups.length === 0) {
        return { day, groups: [], note: `${day} 原话簿里没有可读发言（或群目录不存在）` }
      }
      return { day, groups }
    },
  }
}
