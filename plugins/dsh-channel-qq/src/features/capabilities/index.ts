/** 人格化与群运营工具（A1/A2/A3/B + D 的工具面，审计 [20261025_snowluma-capability-audit.md]）。
 *
 * 五个 qq_* 工具，全部**默认注册**（只读与低危写）：
 *   - `qq_set_status`（A1）：在线状态随时段/心情变——人格感最便宜的来源；
 *   - `qq_react`（A2）：对某条消息贴/撤一个表情回应（比回复轻的存在感）；
 *   - `qq_custom_face`（A3）：QQ 自定义表情的列表与发送（stolen 表情发出去更像"发表情"）；
 *   - `qq_group_pulse`（B）：群荣誉（龙王/活跃榜）+ @全体剩余，一段摘要——群活跃画像；
 *   - `qq_check_url`（D）：出站链接安检（发给别人之前先问协议端这个链接安不安全）。
 *
 * 写操作的边界：status/reaction/custom_face 都是"她自己的行为"，模型可自主调用
 * （与 qq_send_poke 同级）；没有"替别人操作"的参数。
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { registerSpecs, params, type ToolHost, type ToolSpec } from '../../adapters/dsh-host/tools.js'
import type { QQApi } from '../../ports/platform.js'
import type { SubHost, SubPlugin } from '../plugin-kit.js'

/** 标准在线状态的数字档（OneBot/NapCat/SnowLuma 语义：1 在线 … 6 DND）。 */
const STATUS_CODES: ReadonlyArray<readonly [string, number]> = [
  ['online', 1], ['away', 2], ['invisible', 3], ['busy', 4], ['qme', 5], ['dnd', 6],
]

export const capabilitiesPlugin: SubPlugin = {
  name: 'capabilities',
  watches: [],
  async apply(host) {
    const apiOf = (): QQApi | null => host.get('platform')?.api ?? null
    const emojiDir = (): string => host.config.emoji?.dir ?? path.join(resolveHome(host), 'channel-qq', 'emoji')
    const registeredDir = (): string => host.config.emoji?.registeredDir ?? path.join(emojiDir(), '..', 'emoji-registered')
    registerSpecs(host.bridge.toolHost(), [
      setStatusTool(apiOf),
      reactTool(apiOf, () => host.config.selfId),
      customFaceTool(apiOf, emojiDir, registeredDir),
      groupPulseTool(apiOf),
      checkUrlTool(apiOf),
    ], host.log, 'capabilities')
    return () => {}
  },
}

/** 宿主的 DSH home（capabilities 没有自己的工作区）。 */
function resolveHome(host: SubHost): string {
  return host.dshHome
}

/** `qq_set_status` — A1：设置在线状态（标准档或自定义文案）。 */
function setStatusTool(apiOf: () => QQApi | null): ToolSpec {
  return {
    name: 'qq_set_status',
    description: '设置自己的在线状态（online/away/invisible/busy/qme/dnd，或自定义文案）。'
      + '想表达"在忙""睡了""听歌中"这类状态时用，不用每次都改。',
    parameters: params({
      preset: { type: 'string', enum: ['online', 'away', 'invisible', 'busy', 'qme', 'dnd'], description: '标准档；与 diy 二选一' },
      diy: { type: 'string', description: '自定义状态文案（如"听歌中"）；给了它就忽略 preset' },
      faceId: { type: 'number', description: '自定义状态的表情 id（diy 用；可省略）' },
    }, []),
    run: async (args) => {
      const api = apiOf()
      if (api === null) return { ok: false, note: '协议端未连接。' }
      const diy = typeof args.diy === 'string' ? args.diy.trim() : ''
      if (diy !== '') {
        const faceId = typeof args.faceId === 'number' ? args.faceId : 21
        await api.setDiyOnlineStatus(faceId, diy)
        return { ok: true, status: diy }
      }
      const preset = String(args.preset ?? 'online')
      const code = STATUS_CODES.find(([name]) => name === preset)?.[1] ?? 1
      await api.setOnlineStatus(code)
      return { ok: true, status: preset }
    },
  }
}

/** `qq_react` — A2：对一条消息贴/撤表情回应。 */
function reactTool(apiOf: () => QQApi | null, selfId: () => number): ToolSpec {
  return {
    name: 'qq_react',
    description: '对某条群消息贴一个表情回应（或 remove=true 撤掉）。比回复轻的存在感：'
      + '看到不错的话、想标记某条消息时用。emojiId 是 QQ 小表情编号（如 128588）。',
    parameters: params({
      messageId: { type: 'number', description: '目标消息的 #编号（来自上下文包）' },
      emojiId: { type: 'string', description: 'QQ 表情编号' },
      remove: { type: 'boolean', description: 'true = 撤掉这个回应' },
    }, ['messageId', 'emojiId']),
    run: async (args, ctx) => {
      const api = apiOf()
      if (api === null) return { ok: false, note: '协议端未连接。' }
      const messageId = Number(args.messageId)
      const emojiId = String(args.emojiId ?? '')
      if (!Number.isFinite(messageId) || emojiId === '') return { ok: false, note: 'messageId 与 emojiId 必填。' }
      // 房间从会话 id 推（qq-group-<群号>）；群消息才有回应。
      const agentId = String((ctx as { agentId?: string }).agentId ?? '')
      const match = /^qq-group-(\d+)$/.exec(agentId)
      if (match === null) return { ok: false, note: '表情回应只在群聊里可用。' }
      const groupId = Number(match[1])
      const remove = args.remove === true
      await api.setGroupReaction(groupId, messageId, emojiId, remove)
      return { ok: true, reacted: remove ? 'removed' : 'added', messageId, emojiId, self: selfId() }
    },
  }
}

/** `qq_custom_face` — A3：QQ 自定义表情列表 / 发送（本地表情文件直接发）。 */
function customFaceTool(apiOf: () => QQApi | null, emojiDir: () => string, registeredDir: () => string): ToolSpec {
  return {
    name: 'qq_custom_face',
    description: 'QQ 自定义表情：action=list 列出账号里已有的；action=send 把一张本地表情图片'
      + '（stolen/registered 目录的文件名，或绝对路径）当自定义表情发出去——比发普通图片更像"发表情"。',
    parameters: params({
      action: { type: 'string', enum: ['list', 'send'], description: 'list / send' },
      file: { type: 'string', description: 'send：表情文件名（emoji 目录里找，如 stolen_xxx.png）或绝对路径' },
      target: { type: 'number', description: 'send：发给谁（群号或 QQ 号）' },
      isGroup: { type: 'boolean', description: 'send：是否群聊（默认群聊）' },
    }, ['action']),
    run: async (args) => {
      const api = apiOf()
      if (api === null) return { ok: false, note: '协议端未连接。' }
      const action = String(args.action ?? 'list')
      if (action === 'list') {
        const got = await api.fetchCustomFace(60).catch((error: unknown): { faces?: Array<{ emoji_id?: string; emoji_name?: string; url?: string }> } => {
          return {}
        })
        const faces = got?.faces ?? []
        return { count: faces.length, faces: faces.slice(0, 30).map((face) => ({ id: face.emoji_id, name: face.emoji_name })) }
      }
      const file = String(args.file ?? '').trim()
      if (file === '') return { ok: false, note: 'send 需要 file（表情文件名）。' }
      const target = Number(args.target)
      const isGroup = args.isGroup !== false
      if (!Number.isFinite(target) || target <= 0) return { ok: false, note: 'send 需要 target（群号或 QQ 号）。' }
      // 安全解析：只允许 emoji 目录内的文件名（防目录穿越）；绝对路径原样走闸门。
      const resolved = path.isAbsolute(file)
        ? file
        : path.join(/[\\/]stolen_/.test(file) ? emojiDir() : registeredDir(), path.basename(file))
      if (!resolved.startsWith(emojiDir()) && !resolved.startsWith(registeredDir())) {
        return { ok: false, note: '只允许发送 emoji 目录里的表情。' }
      }
      await fs.access(resolved)
      await api.sendCustomFace(`file://${resolved}`, isGroup, target)
      return { ok: true, sent: path.basename(resolved) }
    },
  }
}

/** `qq_group_pulse` — B：群荣誉 + @全体剩余，一段摘要。 */
function groupPulseTool(apiOf: () => QQApi | null): ToolSpec {
  return {
    name: 'qq_group_pulse',
    description: '群活跃脉搏：龙王/群聊之火等荣誉榜 + @全体剩余额度。写群活跃画像、早报、'
      + '决定要不要 @全体时用。groupId 缺省用当前会话的群。',
    parameters: params({
      groupId: { type: 'number', description: '群号（缺省 = 当前会话）' },
    }, []),
    run: async (args, ctx) => {
      const api = apiOf()
      if (api === null) return { note: '协议端未连接。' }
      const agentId = String((ctx as { agentId?: string }).agentId ?? '')
      const fallback = /^qq-group-(\d+)$/.exec(agentId)?.[1]
      const groupId = Number(args.groupId ?? fallback)
      if (!Number.isFinite(groupId) || groupId <= 0) return { note: '没有可用的群号。' }
      const [honor, remain] = await Promise.all([
        api.getGroupHonorInfo(groupId).catch(() => null),
        api.getGroupAtAllRemain(groupId).catch(() => null),
      ])
      const talkative = honor?.current_talkative ?? null
      const names = (list: readonly { nickname?: string }[] | undefined): string[] =>
        (list ?? []).map((item) => String(item.nickname ?? '')).filter((name) => name !== '').slice(0, 5)
      return {
        groupId,
        talkative: talkative === null ? null : { qq: talkative.user_id, nickname: talkative.nickname, days: talkative.day_count },
        performers: names(honor?.performer_list),
        legends: names(honor?.legend_list),
        emotions: names(honor?.emotion_list),
        atAll: remain === null ? null : { can: remain.can_at_all === true, groupRemain: remain.remain_at_all_count_for_group, myRemain: remain.remain_at_all_count_for_uin },
      }
    },
  }
}

/** `qq_check_url` — D 工具面：查一个链接的安全等级。 */
function checkUrlTool(apiOf: () => QQApi | null): ToolSpec {
  return {
    name: 'qq_check_url',
    description: '查一个链接在 QQ 侧的安全等级（1 安全 → 3 危险）。把来路不明的链接'
      + '转述给别人之前先查一下；自动安检在出站时也会做，这个是手动版。',
    parameters: params({
      url: { type: 'string', description: '要检查的链接' },
    }, ['url']),
    run: async (args) => {
      const api = apiOf()
      if (api === null) return { note: '协议端未连接。' }
      const url = String(args.url ?? '').trim()
      if (!/^https?:\/\//i.test(url)) return { note: '只查 http(s) 链接。' }
      const got = await api.checkUrlSafely(url).catch((): { level?: number | string; message?: string } => ({ message: 'check failed' }))
      const level = got?.level
      return {
        url,
        level,
        verdict: level === undefined ? 'unknown' : Number(level) >= 3 ? 'dangerous' : Number(level) === 2 ? 'warn' : 'safe',
        ...(got?.message === undefined ? {} : { note: String(got.message) }),
      }
    },
  }
}
