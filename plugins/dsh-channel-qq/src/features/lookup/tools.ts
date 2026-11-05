/** 查询：6 个工具。
 *
 * 只读查询：消息、群、成员、好友、以及历史会话日志。
 *
 * 这些 spec **逐字节**来自原来的 `registerQQTools`——P4 的判据是工具名与
 * 参数 schema 一条都不许变（`test/golden/tools/qq-tools.txt` 钉着这一点）。
 * 一个工具一个函数：单看一个工具时不必在 1200 行里找它的边界。
 */

import { readSessionLog, resolveSessionsRoot } from '../../paths.js'
import type { ToolSpec } from '../../adapters/dsh-host/tools.js'
import type { QQToolDeps } from '../tool-deps.js'

/** `qq_get_msg` — 按消息ID获取消息内容。… */
function qqGetMsg(deps: QQToolDeps): ToolSpec {
  const { api } = deps
  return {
        name: 'qq_get_msg',
        description: '按消息ID获取消息内容。',
        parameters: {
          type: 'object',
          properties: { messageId: { type: 'number' } },
          required: ['messageId'],
        },
        run: async (args) => api.getMessage(Number(args.messageId)),
      }
}

/** `qq_get_group_info` — 查询群资料（群名、成员数、上限等）。… */
function qqGetGroupInfo(deps: QQToolDeps): ToolSpec {
  const { api } = deps
  return {
        name: 'qq_get_group_info',
        description: '查询群资料（群名、成员数、上限等）。',
        parameters: {
          type: 'object',
          properties: { groupId: { type: 'number' } },
          required: ['groupId'],
        },
        run: async (args) => api.getGroupInfo(Number(args.groupId)),
      }
}

/** `qq_get_group_list` — 获取咱加入的所有群列表（群号、群名、成员数）。… */
function qqGetGroupList(deps: QQToolDeps): ToolSpec {
  const { api } = deps
  return {
        name: 'qq_get_group_list',
        description: '获取咱加入的所有群列表（群号、群名、成员数）。',
        parameters: { type: 'object', properties: {} },
        // The harness requires a tool result to be an object; a bare OneBot list
        // is rejected with `invalid output: "value" must be an object`.
        run: async () => ({ groups: await api.getGroupList() }),
      }
}

/** `qq_get_group_member_info` — 查询群成员资料（昵称、群名片、角色等）。… */
function qqGetGroupMemberInfo(deps: QQToolDeps): ToolSpec {
  const { api } = deps
  return {
        name: 'qq_get_group_member_info',
        description: '查询群成员资料（昵称、群名片、角色等）。',
        parameters: {
          type: 'object',
          properties: { groupId: { type: 'number' }, userId: { type: 'number' } },
          required: ['groupId', 'userId'],
        },
        run: async (args) => api.getGroupMemberInfo(Number(args.groupId), Number(args.userId)),
      }
}

/** `qq_get_friend_list` — 获取好友列表（QQ号、昵称、备注）。… */
function qqGetFriendList(deps: QQToolDeps): ToolSpec {
  const { api } = deps
  return {
        name: 'qq_get_friend_list',
        description: '获取好友列表（QQ号、昵称、备注）。',
        parameters: { type: 'object', properties: {} },
        run: async () => ({ friends: await api.getFriendList() }),
      }
}

/** `qq_search_history` — 搜索本群/私聊的完整聊天记录（含已被折叠的旧消息）。可按关键词、发送者QQ号、日期过滤，返回带时间戳和#编号的消息列表。… */
function qqSearchHistory(deps: QQToolDeps): ToolSpec {
  const { config, log } = deps
  return {
        name: 'qq_search_history',
        description: '搜索本群/私聊的完整聊天记录（含已被折叠的旧消息）。可按关键词、发送者QQ号、日期过滤，返回带时间戳和#编号的消息列表。',
        parameters: {
          type: 'object',
          properties: {
            isGroup: { type: 'boolean', description: '是否群聊（默认 true）' },
            target: { type: 'number', description: '群号或对方QQ号；省略则用配置里的 primaryGroup' },
            keyword: { type: 'string', description: '关键词（消息文本包含即命中）' },
            senderId: { type: 'number', description: '按发送者QQ号过滤' },
            sinceDate: { type: 'string', description: '起始日期 YYYY-MM-DD（含）' },
            untilDate: { type: 'string', description: '结束日期 YYYY-MM-DD（含）' },
            limit: { type: 'number', description: '最多返回条数（默认20，上限50）' },
          },
          required: [],
        },
        run: async (args) => {
          // The session id is derived from the conversation, never hardcoded: the
          // old literal pinned one group on one Windows host, so this tool could
          // only ever fail on a fresh deployment.
          const isGroup = args.isGroup !== false
          const target = Number(args.target ?? (isGroup ? config.primaryGroup : null) ?? 0)
          if (target === 0) {
            return { error: '需要 isGroup + target（群号/QQ号），或在配置里设置 primaryGroup' }
          }
          const sid = `qq-${isGroup ? 'group' : 'dm'}-${target}`
          let jsonl: string | null
          try {
            jsonl = await readSessionLog(config.workspacePath ?? undefined, sid)
          } catch (error) {
            return { error: '会话日志不可读: ' + String(error).slice(0, 120) }
          }
          if (jsonl === null) {
            // 本地没有会话日志（重启后/新房间）：如果开了服务端历史，就靠它。
            if (deps.history === undefined) {
              return {
                error: `找不到会话日志 ${sid}（工作区 ${config.workspacePath ?? '未设置'}，日志根 ${resolveSessionsRoot()}）`,
              }
            }
            jsonl = ''
          }
          const { filter, limit } = parseSearchArgs(args)
          const hits: SearchHit[] = []
          for (const line of jsonl.split('\n')) {
            const hit = parseHistoryLine(line, filter)
            if (hit === null) continue
            hits.push(hit)
            if (hits.length >= limit) break
          }
          // A4：本地没有命中时回源一次服务端历史（同一房间 60 秒只拉一次）。
          const source = hits.length === 0 && deps.history !== undefined ? 'server' : 'session-log'
          if (source === 'server') {
            hits.push(...await remoteHistoryHits(deps, sid, isGroup, target, filter, limit))
          }
          return { count: hits.length, sessionId: sid, source, hits }
        },
      }
}

/** 组装这一组工具。 */
export function lookupTools(deps: QQToolDeps): ToolSpec[] {
  return [
    qqGetMsg(deps),
    qqGetGroupInfo(deps),
    qqGetGroupList(deps),
    qqGetGroupMemberInfo(deps),
    qqGetFriendList(deps),
    qqSearchHistory(deps),
  ]
}

/** 参数 → 过滤条件与上限（`limit` 夹取到 [1, 50]）。 */
function parseSearchArgs(args: Record<string, unknown>): {
  filter: { keyword: string | null; sender: number | null; since: string | null; until: string | null }
  limit: number
} {
  const requested = Number(args.limit ?? 20)
  return {
    filter: {
      keyword: args.keyword === undefined ? null : String(args.keyword),
      sender: args.senderId === undefined ? null : Number(args.senderId),
      since: args.sinceDate === undefined ? null : String(args.sinceDate),
      until: args.untilDate === undefined ? null : String(args.untilDate),
    },
    // `0` 会变成 0 条、`abc` 会变成 NaN（`hits.length >= NaN` 恒假 ⇒ 上限形同虚设）、
    // 负数直接不返回（2026-10-19 排查）。
    limit: Number.isFinite(requested) ? Math.max(1, Math.min(Math.trunc(requested), 50)) : 20,
  }
}

/** 服务端历史里的一条命中（与本地日志行同一形状）。 */
interface SearchHit {
  time: string
  sender: string
  userId: number
  msgId: string
  text: string
}

/** A4：回源 + 检索服务端历史，转成与本地日志一致的命中形状。 */
async function remoteHistoryHits(
  deps: QQToolDeps,
  room: string,
  isGroup: boolean,
  target: number,
  filter: { keyword: string | null; sender: number | null; since: string | null; until: string | null },
  limit: number,
): Promise<SearchHit[]> {
  const history = deps.history
  if (history === undefined) return []
  await history.sync(room, isGroup, target).catch(() => 0)
  const remote = await history.search(room, filter).catch(() => [])
  return remote.slice(-limit).map((entry) => ({
    time: formatHhMm(entry.time),
    sender: entry.name,
    userId: entry.userId,
    msgId: String(entry.id),
    text: entry.text,
  }))
}

/**
 * 服务端历史的秒级时间戳 → 本地 HH:MM（与本地日志行的格式一致）。
 * 时间戳缺失（0）时返回 '--:--'，不假装知道几点。
 */
function formatHhMm(seconds: number): string {
  if (seconds <= 0) return '--:--'
  const date = new Date(seconds * 1000)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** 一条会话日志行 → 一条命中记录；不是聊天行或不符合过滤条件时为 null。 */
function parseHistoryLine(
  line: string,
  filter: { keyword: string | null; sender: number | null; since: string | null; until: string | null },
): { time: string; sender: string; userId: number; msgId: string; text: string } | null {
  if (!line.includes('"type":"user/message"')) return null
  try {
    const entry = JSON.parse(line)
    const content = entry.data?.content
    if (!Array.isArray(content)) return null
    // 保留换行：一条入站包是多行的（抬头 + 房间行 + 信封），聊天行只是其中一行。
    const text = content
      .filter((b: { type: string }) => b.type === 'text')
      .map((b: { text?: string }) => b.text ?? '')
      .join('\n')
    if (text === '') return null
    // 聊天行长这样：`HH:MM 昵称(QQ号) #消息号 [@咱]：正文`（见 core/message/render.ts）。
    // **必须逐行找**：包的第一行是 `【私聊消息】` 之类的抬头，用 `^` 锚在整段开头
    // 会一条都匹配不上（2026-10-19 实测：qq_search_history 永远返回空）。
    const chatLine = text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => /^\d{2}:\d{2} .+\(\d+\)/.test(line))
    if (chatLine === undefined) return null
    const head = /^(\d{2}:\d{2}) (.+?)\((\d+)\)/.exec(chatLine)
    if (head === null) return null
    const userId = Number(head[3])
    const body = chatLine.includes('：') ? chatLine.slice(chatLine.indexOf('：') + 1) : chatLine
    const iso = new Date(entry.time).toISOString().slice(0, 10)
    if (filter.since !== null && iso < filter.since) return null
    if (filter.until !== null && iso > filter.until) return null
    if (filter.keyword !== null && !body.includes(filter.keyword)) return null
    if (filter.sender !== null && userId !== filter.sender) return null
    return {
      time: new Date(entry.time).toISOString(),
      // 昵称前面常带不可见的方向控制符（⁧‭ 之类），原样返回会污染 JSON 与日志。
      sender: [...(head[2] ?? '')].filter((ch) => {
        const code = ch.codePointAt(0) ?? 0
        return !(code >= 0x200b && code <= 0x200f)
          && !(code >= 0x202a && code <= 0x202e)
          && !(code >= 0x2066 && code <= 0x2069)
      }).join('').trim(),
      userId,
      msgId: '#' + String(entry.data?.messageId ?? entry.seq),
      text: body.slice(0, 300),
    }
  } catch {
    // 半截行/非 JSON 行很常见（写入是追加的），跳过即可。
    return null
  }
}
