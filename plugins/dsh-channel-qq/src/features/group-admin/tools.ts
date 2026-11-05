/** 高危群管：8 个工具。
 *
 * 改群名片、禁言、踢人、设管理员、加精。改动群状态的那几个走 assertDangerous 总闸门（默认关闭）。
 * `policy.v2` 打开且工具闸门在位时，放行与否整体让给信任表（`tools/pre-execute` 已先拦，
 * 只有 master 的回合能走到 run；见 `app/policy/tool-policy.ts`），总闸门此时直通。
 *
 * 这些 spec **逐字节**来自原来的 `registerQQTools`——P4 的判据是工具名与
 * 参数 schema 一条都不许变（`test/golden/tools/qq-tools.txt` 钉着这一点）。
 * 一个工具一个函数：单看一个工具时不必在 1200 行里找它的边界。
 */

import type { ToolSpec } from '../../adapters/dsh-host/tools.js'
import type { QQToolDeps } from '../tool-deps.js'

/** `qq_set_group_card` — 设置群名片（群昵称）。… */
function qqSetGroupCard(deps: QQToolDeps): ToolSpec {
  const { api } = deps
  return {
        name: 'qq_set_group_card',
        description: '设置群名片（群昵称）。',
        parameters: {
          type: 'object',
          properties: {
            groupId: { type: 'number' },
            userId: { type: 'number' },
            card: { type: 'string', description: '新群名片，空字符串删除名片' },
          },
          required: ['groupId', 'userId', 'card'],
        },
        run: async (args) => api.setGroupCard(Number(args.groupId), Number(args.userId), String(args.card)),
      }
}

/** `qq_group_ban` — 禁言群成员，时长60-300秒。… */
function qqGroupBan(deps: QQToolDeps): ToolSpec {
  const { api } = deps
  return {
        name: 'qq_group_ban',
        description: '禁言群成员，时长60-300秒。',
        parameters: {
          type: 'object',
          properties: {
            groupId: { type: 'number' },
            userId: { type: 'number' },
            duration: { type: 'number', description: '禁言秒数（60-300）' },
          },
          required: ['groupId', 'userId'],
        },
        run: async (args) => {
          const duration = Math.min(Math.max(Number(args.duration ?? 60), 60), 300)
          return api.setGroupBan(Number(args.groupId), Number(args.userId),  duration)
        },
      }
}

/** `qq_group_kick` — 将成员移出群聊（踢人）。默认关闭，需要 groupAdmin.dangerous 打开才可用。… */
function qqGroupKick(deps: QQToolDeps): ToolSpec {
  const { api } = deps
  const assertDangerousAllowed = deps.assertDangerous
  return {
        name: 'qq_group_kick',
        description: '将成员移出群聊（踢人）。默认关闭，需要 groupAdmin.dangerous 打开才可用。',
        parameters: {
          type: 'object',
          properties: {
            groupId: { type: 'number' },
            userId: { type: 'number' },
            rejectAddRequest: { type: 'boolean', description: '是否拒绝此人再次加群' },
          },
          required: ['groupId', 'userId'],
        },
        run: async (args) => {
          assertDangerousAllowed('踢人')
          return api.setGroupKick(Number(args.groupId), Number(args.userId), args.rejectAddRequest === true)
        },
      }
}

/** `qq_group_whole_ban` — 开启或关闭全员禁言。默认关闭，需要 groupAdmin.dangerous 打开才可用。… */
function qqGroupWholeBan(deps: QQToolDeps): ToolSpec {
  const { api } = deps
  const assertDangerousAllowed = deps.assertDangerous
  return {
        name: 'qq_group_whole_ban',
        description: '开启或关闭全员禁言。默认关闭，需要 groupAdmin.dangerous 打开才可用。',
        parameters: {
          type: 'object',
          properties: {
            groupId: { type: 'number' },
            enable: { type: 'boolean', description: 'true=开启全员禁言，false=关闭' },
          },
          required: ['groupId', 'enable'],
        },
        run: async (args) => {
          assertDangerousAllowed('全员禁言')
          return api.setGroupWholeBan(Number(args.groupId), args.enable === true)
        },
      }
}

/** `qq_set_group_admin` — 设置或取消群成员的管理员身份。默认关闭，需要 groupAdmin.dangerous 打开才可用。… */
function qqSetGroupAdmin(deps: QQToolDeps): ToolSpec {
  const { api } = deps
  const assertDangerousAllowed = deps.assertDangerous
  return {
        name: 'qq_set_group_admin',
        description: '设置或取消群成员的管理员身份。默认关闭，需要 groupAdmin.dangerous 打开才可用。',
        parameters: {
          type: 'object',
          properties: {
            groupId: { type: 'number' },
            userId: { type: 'number' },
            enable: { type: 'boolean', description: 'true=设为管理员，false=取消' },
          },
          required: ['groupId', 'userId', 'enable'],
        },
        run: async (args) => {
          assertDangerousAllowed('设管理员')
          return api.setGroupAdmin(Number(args.groupId), Number(args.userId), args.enable === true)
        },
      }
}

/** `qq_set_essence` — 设置一条消息为群精华（好好记就收进精华）。… */
function qqSetEssence(deps: QQToolDeps): ToolSpec {
  const { api } = deps
  return {
        name: 'qq_set_essence',
        description: '设置一条消息为群精华（好好记就收进精华）。',
        parameters: {
          type: 'object',
          properties: { messageId: { type: 'number', description: '消息#编号' } },
          required: ['messageId'],
        },
        run: async (args) => api.setEssence(Number(args.messageId)),
      }
}

/** `qq_delete_essence` — 移除一条群精华。… */
function qqDeleteEssence(deps: QQToolDeps): ToolSpec {
  const { api } = deps
  return {
        name: 'qq_delete_essence',
        description: '移除一条群精华。',
        parameters: {
          type: 'object',
          properties: { messageId: { type: 'number' } },
          required: ['messageId'],
        },
        run: async (args) => api.deleteEssence(Number(args.messageId)),
      }
}

/** `qq_get_essence_list` — 获取群精华消息列表（用于整理精华、翻重要记录）。… */
function qqGetEssenceList(deps: QQToolDeps): ToolSpec {
  const { api } = deps
  return {
        name: 'qq_get_essence_list',
        description: '获取群精华消息列表（用于整理精华、翻重要记录）。',
        parameters: {
          type: 'object',
          properties: { groupId: { type: 'number' } },
          required: ['groupId'],
        },
        run: async (args) => ({ messages: await api.getEssenceList(Number(args.groupId)) }),
      }
}

/** 组装这一组工具。 */
export function groupAdminTools(deps: QQToolDeps): ToolSpec[] {
  return [
    qqSetGroupCard(deps),
    qqGroupBan(deps),
    qqGroupKick(deps),
    qqGroupWholeBan(deps),
    qqSetGroupAdmin(deps),
    qqSetEssence(deps),
    qqDeleteEssence(deps),
    qqGetEssenceList(deps),
  ]
}
