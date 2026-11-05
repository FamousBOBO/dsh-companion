/** 原话簿子插件：按群按日记录原始消息流水 + 跨群摘要工具。
 *
 * - 记录侧：入站分发在消息通过访问门控后调用 `record(event)`，把非机器人的文本
 *   消息原样追加到 `<workspace>/chatlog/<group|dm>/<id>/<day>.md`。写失败只记日志。
 * - 工具侧：`qq_group_digest` 读原话簿按群返回指定日期的发言（默认关）。
 *
 * 与记忆库的分工：记忆存蒸馏结论，原话簿存原文。默认关闭。
 */

import { appendChatLog, isPlaceholder, localClock, pruneOld, type ChatLogOptions } from './store.js'
import { registerChatLogTools } from './tools.js'
import { parseInbound } from '../../core/message/parse.js'
import type { OneBotEvent } from '../../types.js'
import type { SubPlugin } from '../plugin-kit.js'

/** 原话簿对外提供的记录服务（inbound 事件分发时取用）。 */
export interface ChatLogRecorder {
  record(event: OneBotEvent): void
}

export const chatlogPlugin: SubPlugin = {
  name: 'chatlog',
  watches: ['chatlog'],
  requires: ['platform'],
  apply(host) {
    const opts = (): ChatLogOptions => ({
      dir: host.config.chatlog.dir ?? `${host.config.workspacePath ?? host.dshHome}/chatlog`,
      maxChars: host.config.chatlog.maxChars,
      keepDays: host.config.chatlog.keepDays,
    })
    // 跨天清理只在进程内每天跑一次。
    let lastPruneDay = ''

    host.provide('chatlog', {
      record(event: OneBotEvent): void {
        if (host.config.chatlog.enabled !== true) return
        if (event.message_type !== 'group' && event.message_type !== 'private') return
        if (event.user_id === undefined || event.user_id === host.config.selfId) return
        const text = parseInbound(event).text.trim()
        if (text === '' || isPlaceholder(text)) return
        const clock = localClock()
        const isGroup = event.message_type === 'group'
        const room = isGroup ? (event.group_id ?? 0) : event.user_id
        if (room === 0) return
        const nick = event.sender?.card?.trim() || event.sender?.nickname || `QQ${event.user_id}`
        const current = opts()
        void appendChatLog(current, {
          room, isGroup, qq: event.user_id, nick, hhmm: clock.hhmm, day: clock.day, text,
        }).then((ok) => {
          if (!ok) host.log(`chatlog append failed: ${isGroup ? 'group' : 'dm'} ${room} ${clock.day} ${clock.hhmm}`)
        })
        if (clock.day !== lastPruneDay) {
          lastPruneDay = clock.day
          void pruneOld(current.dir, current.keepDays, clock.day).then((removed) => {
            if (removed > 0) host.log(`chatlog: 清理 ${removed} 个过期日文件（保留 ${current.keepDays} 天）`)
          })
        }
      },
    })

    return registerChatLogTools(host.bridge.toolHost(), host.config, host.log)
  },
}
