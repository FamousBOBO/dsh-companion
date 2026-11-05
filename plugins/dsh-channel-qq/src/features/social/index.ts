/** 社交面：好友申请 / 群邀请事件 + 单向好友（C 组，审计 [20261025_snowluma-capability-audit.md]）。
 *
 * 此前 request 类事件直接被 dispatch 丢弃——好友申请会一直挂着直到过期，
 * 主人连"有申请"都不会知道。现在：
 *
 *   - `request/friend` → 存 flag + 拉陌生人资料（A4 同源）→ 通知主人；
 *     主人回复「同意好友 <QQ>」批（`commands.ts`，不经模型）；
 *   - `request/group` + `sub_type=invite` → 同上，走 `set_group_add_request`；
 *   - 工具面：`qq_friend_requests` 列待批、`qq_unidirectional_friends` 查单向好友
 *     （对方列表里没有我——关系感知）。
 *
 * flag 是 QQ 的凭据：只存在本机 store 里、只有管理员指令链能用，工具面永远看不到。
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { OneBotEvent } from '../../types.js'
import { registerSpecs, params, type ToolHost, type ToolSpec } from '../../adapters/dsh-host/tools.js'
import type { QQApi } from '../../ports/platform.js'
import type { SubHost, SubPlugin } from '../plugin-kit.js'
import { SocialStore, describeRequest, type SocialRequest } from './store.js'
import { handleSocialCommand } from './commands.js'

interface SocialToolContext {
  agentId?: string
}

export const socialPlugin: SubPlugin = {
  name: 'social',
  watches: [],
  async apply(host) {
    const enabled = host.config.access.friendRequests === true
    const dir = path.join(host.dshHome, 'channel-qq')
    const store = new SocialStore(dir, host.log)
    await store.load()
    const apiOf = (): QQApi | null => host.get('platform')?.api ?? null

    host.provide('social', {
      /** 一条 request 事件进来（dispatch 分流；关着时是空操作）。 */
      handleRequest: async (event: OneBotEvent): Promise<void> => {
        if (host.config.access.friendRequests === true) await handleRequest(host, store, event)
      },
      /**
       * 社交指令（同意好友/邀请等）：命中并已回复 → true。关着时永远 false
       * （指令交回正常流程，模型看不到也执行不了——flag 根本没存）。
       */
      commandHandler: async (text: string, userId: number): Promise<boolean> => {
        if (host.config.access.friendRequests !== true) return false
        const result = await handleSocialCommand(text, userId, {
          isGroup: false,
          admins: host.config.admins,
          api: apiOf(),
          store,
          log: host.log,
        })
        if (!result.handled) return false
        const api = apiOf()
        if (api !== null) {
          try {
            await api.sendPrivateMessage(userId, [{ type: 'text', data: { text: result.reply } }])
          } catch (error) {
            host.log(`social: 回复指令失败：${error instanceof Error ? error.message : String(error)}`)
          }
        }
        return true
      },
    })
    if (enabled) host.log('social: 好友申请/群邀请处理已启用（批准走管理员私聊指令）')
    else host.log('social: 关着（access.friendRequests=false，request 事件直接丢弃）')
    registerTools(host, store, apiOf)
    return () => {}
  },
}

/** 处理一条好友申请/群邀请：存 flag、拉资料、通知主人（同一请求只通知一次）。 */
async function handleRequest(host: SubHost, store: SocialStore, event: OneBotEvent): Promise<void> {
  const flag = typeof event.flag === 'string' ? event.flag : ''
  if (flag === '') return
  const requestType = event.request_type
  if (requestType === 'friend') {
    const fromId = event.user_id ?? 0
    if (fromId <= 0) return
    const row: SocialRequest = {
      kind: 'friend',
      id: fromId,
      fromId,
      name: event.sender?.nickname ?? '',
      comment: typeof event.comment === 'string' ? event.comment : '',
      flag,
      at: Date.now(),
      status: 'pending',
    }
    const { isNew } = await store.put(row)
    const profile = await strangerLine(host, fromId)
    if (isNew) {
      host.log(`social: 好友申请 from ${fromId}${row.comment === '' ? '' : `：${row.comment.slice(0, 40)}`}`)
      await notify(host, `好友申请：QQ ${fromId}${profile}。`
        + `验证消息：${row.comment === '' ? '（无）' : row.comment.slice(0, 60)}。`
        + `回复「同意好友 ${fromId}」或「拒绝好友 ${fromId}」。`)
    }
    return
  }
  if (requestType === 'group' && event.sub_type === 'invite') {
    const groupId = event.group_id ?? 0
    const fromId = event.user_id ?? 0
    if (groupId <= 0) return
    const row: SocialRequest = {
      kind: 'group-invite',
      id: groupId,
      fromId,
      name: typeof event.group_name === 'string' ? event.group_name : '',
      comment: typeof event.comment === 'string' ? event.comment : '',
      flag,
      at: Date.now(),
      status: 'pending',
    }
    const { isNew } = await store.put(row)
    if (isNew) {
      host.log(`social: 群邀请 → ${groupId} from ${fromId}`)
      await notify(host, `群邀请：QQ ${fromId} 邀请进群 ${groupId}${row.name === '' ? '' : `（${row.name}）`}。`
        + `回复「同意邀请 ${groupId}」或「拒绝邀请 ${groupId}」。`)
    }
  }
}

/** 陌生人资料一行（A4 同款信息：昵称/性别/等级/长签名；查不到就空串）。 */
async function strangerLine(host: SubHost, userId: number): Promise<string> {
  try {
    const info = await host.need('platform').api.getStrangerInfo(userId)
    const bits: string[] = []
    if (typeof info?.nickname === 'string' && info.nickname !== '') bits.push(info.nickname)
    if (typeof info?.sex === 'string' && info.sex !== '') bits.push(info.sex)
    const level = info?.qq_level ?? info?.level
    if (typeof level === 'number' && level > 0) bits.push(`Lv.${level}`)
    if (typeof info?.long_nick === 'string' && info.long_nick.trim() !== '') bits.push(`签名：${info.long_nick.trim().slice(0, 40)}`)
    return bits.length === 0 ? '' : `（${bits.join('，')}）`
  } catch {
    return ''
  }
}

async function notify(host: SubHost, text: string): Promise<void> {
  const owner = host.config.admins[0]
  if (owner === undefined) return
  try {
    await host.need('platform').api.sendPrivateMessage(owner, [{ type: 'text', data: { text } }])
  } catch (error) {
    host.log(`social: 通知主人失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

// ── 工具面 ──────────────────────────────────────────────────────────────────

function registerTools(host: SubHost, store: SocialStore, apiOf: () => QQApi | null): void {
  const tools: ToolSpec[] = [friendRequestsTool(store), unidirectionalTool(apiOf, host.log)]
  registerSpecs(host.bridge.toolHost(), tools, host.log, 'social')
}

/** `qq_friend_requests` — 列待处理的好友申请/群邀请（给模型看的视图，无 flag）。 */
function friendRequestsTool(store: SocialStore): ToolSpec {
  return {
    name: 'qq_friend_requests',
    description: '列出待处理的好友申请与群邀请（主人批准走私聊指令「同意好友 <QQ>」，不经你手）。主人问"有没有人加我"时用。',
    parameters: params({}, []),
    run: async () => {
      const open = store.listPending()
      if (open.length === 0) return { count: 0, note: '没有待处理的好友申请或群邀请。' }
      return { count: open.length, requests: open.map((row) => describeRequest(row)) }
    },
  }
}

/** `qq_unidirectional_friends` — 单向好友（对方列表里没有我）。 */
function unidirectionalTool(apiOf: () => QQApi | null, log: (line: string) => void): ToolSpec {
  return {
    name: 'qq_unidirectional_friends',
    description: '查单向好友列表（对方的好友列表里没有我——通常是被删了）。只查不动。',
    parameters: params({}, []),
    run: async () => {
      const api = apiOf()
      if (api === null) return { note: '协议端未连接。' }
      const got = await api.getUnidirectionalFriendList().catch((error: unknown): { list?: Array<{ user_id?: number; nickname?: string; source?: string }> } => {
        log(`social: 单向好友查询失败：${error instanceof Error ? error.message : String(error)}`)
        return {}
      })
      const list = got?.list ?? []
      return {
        count: list.length,
        friends: list.slice(0, 30).map((item) => ({ qq: item.user_id, nickname: item.nickname, source: item.source })),
      }
    },
  }
}
