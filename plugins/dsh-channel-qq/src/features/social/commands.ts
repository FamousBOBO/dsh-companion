/** 管理员 IM 指令：好友申请与群邀请的批准/拒绝（不经模型）。
 *
 * 与 approval 的同一条纪律：**批准类动作不让模型经手**，纯正则 + 管理员私聊，
 * 防提示注入直接触发。群聊里完全静默（不暴露审批通道的存在）。
 *
 *   同意好友 <QQ> / 拒绝好友 <QQ> / 同意邀请 <群号> / 拒绝邀请 <群号> / 好友请求
 *
 * `flag` 从 SocialStore 里按 id 取（request 事件进来时存下的），不要求主人提供。
 */

import type { QQApi } from '../../ports/platform.js'
import { describeRequest, type SocialRequest, type SocialStore } from './store.js'

export interface SocialCommandContext {
  readonly isGroup: boolean
  readonly admins: readonly number[]
  readonly api: QQApi | null
  readonly store: SocialStore
  readonly log?: (line: string) => void
}

export type SocialCommandResult = { handled: true; reply: string } | { handled: false }

const RE = /^\s*\/?(同意好友|拒绝好友|同意邀请|拒绝邀请|好友请求)(?:\s+(\S+))?\s*$/

/** 处理一条文本；不是社交管理命令就返回 `handled:false`。 */
export async function handleSocialCommand(text: string, userId: number, ctx: SocialCommandContext): Promise<SocialCommandResult> {
  const match = RE.exec(text)
  if (match === null) return { handled: false }
  const verb = match[1]!
  if (ctx.isGroup) return { handled: false }
  if (!ctx.admins.includes(userId)) return { handled: true, reply: '无权操作。' }
  if (verb === '好友请求') {
    const open = ctx.store.listPending()
    if (open.length === 0) return { handled: true, reply: '没有待处理的好友申请或群邀请。' }
    return {
      handled: true,
      reply: `待处理 ${open.length} 条：\n${open.map((row) => describeRequest(row)).join('\n')}\n回复「同意好友 <QQ>」等处理。`,
    }
  }
  const arg = match[2] ?? ''
  const id = Number(arg)
  if (!Number.isFinite(id) || id <= 0) return { handled: true, reply: `用法：${verb} <${verb.includes('邀请') ? '群号' : 'QQ 号'}>` }
  const kind = verb.includes('好友') ? 'friend' as const : 'group-invite' as const
  const row = ctx.store.take(kind, id)
  if (row === undefined) return { handled: true, reply: `没有 ${id} 的待处理${kind === 'friend' ? '好友申请' : '群邀请'}。` }
  if (ctx.api === null) return { handled: true, reply: '协议端还没连上，稍后再试。' }
  const approve = verb.startsWith('同意')
  try {
    if (kind === 'friend') await ctx.api.setFriendAddRequest(row.flag, approve)
    else await ctx.api.setGroupAddRequest(row.flag, approve)
    await ctx.store.settle(row, approve ? 'approved' : 'rejected')
    ctx.log?.(`social: ${verb} ${id} → ${approve ? 'approved' : 'rejected'} by ${userId}`)
    return { handled: true, reply: `已${approve ? '同意' : '拒绝'}${kind === 'friend' ? '好友' : '邀请'} ${id}。` }
  } catch (error) {
    return { handled: true, reply: `操作失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/** 供 dispatch 在 access 命令之后插入调用（保持 pipeline 依赖面窄）。 */
export function socialCommandHandler(store: SocialStore, api: () => QQApi | null, admins: () => readonly number[], log: (line: string) => void) {
  return async (event: { post_type: string; message_type?: string; user_id?: number; raw_message?: string; message?: unknown }, text: string): Promise<boolean> => {
    if (event.post_type !== 'message' || event.message_type !== 'private') return false
    const result = await handleSocialCommand(text, event.user_id ?? 0, {
      isGroup: false,
      admins: admins(),
      api: api(),
      store,
      log,
    })
    if (!result.handled) return false
    const queue = api()
    if (queue !== null && event.user_id !== undefined) {
      try {
        await queue.sendPrivateMessage(event.user_id, [{ type: 'text', data: { text: result.reply } }])
      } catch (error) {
        log(`social: 回复指令失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return true
  }
}

/** 类型守卫：给 dispatch 用（request 事件的形状）。 */
export function isSocialRequestRow(row: SocialRequest): boolean {
  return row.status === 'pending'
}
