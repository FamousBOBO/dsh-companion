/** 管理员私聊命令（访问门控）：待批访问 / 放行 / 放行群 / 拒绝访问 / 拒绝访问群。
 *
 * 为什么不复用「批准 / 拒绝」：那两个动词属于高危命令审批网关（`features/approval`），
 * 同一个词在两套队列里会产生歧义。这里用**放行**系动词，并在通知里直接给出可复制的命令。
 */

import type { OneBotEvent } from '../../types.js'
import { rawText } from '../../core/message/parse.js'
import type { SubHost } from '../plugin-kit.js'
import type { AccessService } from './service.js'

export type AccessCommand =
  | { readonly verb: 'list' }
  | { readonly verb: 'approve' | 'reject'; readonly kind: 'user' | 'group'; readonly id: number }

const RE = /^\s*\/?(待批访问|访问请求|放行群|放行|拒绝访问群|拒绝访问)(?:\s+(\d{1,12}))?\s*$/

/** 解析一条命令；不是访问命令时返回 null。 */
export function parseAccessCommand(text: string): AccessCommand | null {
  const match = RE.exec(text)
  if (match === null) return null
  const verb = match[1] ?? ''
  const id = match[2] === undefined ? null : Number(match[2])
  if (verb === '待批访问' || verb === '访问请求') return { verb: 'list' }
  if (id === null || !Number.isFinite(id) || id <= 0) return null
  if (verb === '放行') return { verb: 'approve', kind: 'user', id }
  if (verb === '放行群') return { verb: 'approve', kind: 'group', id }
  if (verb === '拒绝访问') return { verb: 'reject', kind: 'user', id }
  return { verb: 'reject', kind: 'group', id }
}

/** 渲染待批列表（含可直接复制的命令）。 */
export function renderPending(list: ReturnType<AccessService['list']>): string {
  if (list.pending.length === 0) return '没有待批访问请求。'
  const lines = list.pending.map((item) => {
    const row = item as { kind?: string; id?: number; name?: string }
    const kind = row.kind === 'group' ? '群' : '私聊'
    const cmd = row.kind === 'group' ? `放行群 ${row.id}` : `放行 ${row.id}`
    return `· ${kind} ${row.id}${row.name === undefined || row.name === '' ? '' : `（${row.name}）`} → ${cmd}`
  })
  return `待批 ${list.pending.length} 条：\n${lines.join('\n')}`
}

/**
 * 在入站分发里处理命令：只认**管理员私聊**；处理了返回 true（调用方不再往下走）。
 *
 * 命令回复走普通出站队列，失败只记日志。
 */
export async function maybeHandleAccessCommand(host: SubHost, event: OneBotEvent): Promise<boolean> {
  if (event.post_type !== 'message' || event.message_type !== 'private') return false
  const userId = event.user_id
  if (typeof userId !== 'number' || !host.config.admins.includes(userId)) return false
  const command = parseAccessCommand(rawText(event))
  if (command === null) return false
  const access = host.get('access')
  const parts = host.get('platform')
  if (access === undefined || parts === undefined) return false
  let reply: string
  if (command.verb === 'list') {
    reply = renderPending(access.list())
  } else {
    const kind = command.kind === 'group' ? '群' : '私聊'
    try {
      if (command.verb === 'approve') await access.approve(command.kind, command.id)
      else await access.reject(command.kind, command.id)
      // P1-04：allowlist 模式下"放行"不会扩展名单（只认 allowUsers/allowGroups），
      // 必须在回复里说清楚，否则主人会以为已经放行、实际仍被拦。
      const allowlist = access.list().mode === 'allowlist'
      const where = command.kind === 'group' ? 'allowGroups' : 'allowUsers'
      reply = command.verb === 'approve'
        ? (allowlist
            ? `已记录${kind} ${command.id}，但当前是 allowlist 模式：名单只认配置里的 ${where}，`
              + `这条批准**不会**放行。要真的放行，请在后台把它加进 ${where}（或把模式换成 pairing）。`
            : `已放行${kind} ${command.id}，并已通知对方。`)
        : `已拒绝${kind} ${command.id}（同时撤销了之前的批准）。`
    } catch (error) {
      reply = `操作失败：${error instanceof Error ? error.message : String(error)}`
    }
  }
  try {
    await parts.out.push(() => parts.api.sendPrivateMessage(userId, [{ type: 'text', data: { text: reply } }]))
  } catch (error) {
    host.log(`access: 命令回复失败：${error instanceof Error ? error.message : String(error)}`)
  }
  return true
}
