/** 访问门控段（安全）：谁能触发 agent。
 *
 * 三种模式：
 *   - `pairing`（默认）：陌生私聊/未批准的群先回一句「待主人批准」，不进 agent；
 *     主人在后台「安全」页批准后才放行。
 *   - `allowlist`：只放行 `allowUsers` / `allowGroups`（另有已批准列表）。
 *   - `open`：旧行为（任何人可触发），只建议在本机/私有环境使用。
 */

import { b, e, list, n, type FieldGroup } from '../dsl.js'

export interface AccessConfig {
  mode: 'pairing' | 'allowlist' | 'open'
  /** 群的门控策略：member=在群里就允许；pairing=逐群审批；allowlist=只认名单。 */
  groupPolicy: 'member' | 'pairing' | 'allowlist'
  allowUsers: number[]
  allowGroups: number[]
  /** 新请求私聊通知主人。 */
  notifyOwner: boolean
  /** 同一请求者两次「待批准」回复的最小间隔（分钟）；只对私聊生效。 */
  replyCooldownMin: number
  /** 未批准的群里也回一句「待主人批准」（默认关；群里回这句话很容易刷屏）。 */
  replyPendingInGroups: boolean
  /**
   * 好友申请/群邀请事件（2026-10-25 接入，默认关）。打开后 request 事件进来
   * 就存 flag 并私聊通知主人（带陌生人资料），批准走私聊指令「同意好友 <QQ>」
   * ——不经模型（与 approval 同一条纪律）。
   */
  friendRequests: boolean
}

export const ACCESS_GROUPS: FieldGroup[] = [
  {
    id: 'access',
    label: '访问门控',
    page: 'security',
    help: '决定谁能触发 agent。默认 pairing：陌生人先申请，主人批准后放行。',
    fields: {
      friendRequests: b('处理好友申请与群邀请', false, {
        hot: 'live',
        help: '打开后好友申请/群邀请会存凭据并私聊通知主人（附陌生人资料）；'
          + '批准走管理员私聊指令「同意好友 <QQ>」，不经模型。关着时事件直接丢弃（旧行为）。',
      }),
      mode: e('模式', 'pairing', [
        ['pairing', '配对审批（推荐）'],
        ['allowlist', '仅白名单'],
        ['open', '全部放行（旧行为）'],
      ], {
        hot: 'live',
        help: 'pairing：陌生私聊/未批准的群只回「待主人批准」；allowlist：只认下面的名单；open：任何人都能触发。',
      }),
      groupPolicy: e('群策略', 'pairing', [
        ['member', '在群里就允许（推荐）'],
        ['pairing', '逐群审批'],
        ['allowlist', '只认群名单'],
      ], {
        hot: 'live',
        help: 'member：机器人已经在的群直接放行（加群本身就是主人操作）；pairing：未批准的群先申请；allowlist：只认下面的群名单与已批准列表。',
      }),
      allowUsers: list('额外允许的 QQ 号', [], {
        hot: 'live', page: 'security', itemsKind: 'number',
        help: '私聊白名单；与后台已批准列表合并。管理员始终允许。',
      }),
      allowGroups: list('额外允许的群号', [], {
        hot: 'live', page: 'security', itemsKind: 'number',
        help: '群白名单；与后台已批准列表合并。',
      }),
      notifyOwner: b('新请求通知主人', true, { hot: 'live' }),
      replyPendingInGroups: b('未批准的群里也回「待批准」', false, {
        hot: 'live',
        help: '默认关。关着时未批准的群只在主人侧通知，群里完全安静；打开后每个请求只回一次。',
        hiddenIf: { field: 'access.groupPolicy', notEquals: 'pairing' },
      }),
      replyCooldownMin: n('待批准回复间隔（分钟）', 30, {
        min: 1, max: 1440, hot: 'live', unit: '分钟',
        help: '同一个人/同一个群在这个时间内只回一次「待主人批准」。',
        hiddenIf: { field: 'access.mode', notEquals: 'pairing' },
      }),
    },
  },
]
