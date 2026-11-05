/** 管理员 IM 命令：待批 / 申请 / 批准 / 拒绝。
 *
 * **不经模型**：这条路径在入站流水线里先于 agent 处理，纯正则匹配。理由是
 * 《IM Bot 特权命令远程批准方案》§4 的第 6 条——让模型参与"批准"这件事，
 * 就等于给提示注入留了一条直接触发高危动作的路。
 *
 * 只认**管理员私聊**：群聊里的同名命令一律拒绝（防群成员冒用）。
 */

import { approveById, denyById, describeRequest, listRequests, requestCommand } from './store.js'

export interface CommandContext {
  readonly isGroup: boolean
  readonly admins: readonly number[]
  readonly dir?: string
  /** 审计日志（谁申请、谁批准）。缺省时静默。 */
  readonly log?: (line: string) => void
}

export type CommandResult = { handled: true; reply: string } | { handled: false }

const RE = /^\s*\/?(待批|申请|批准|拒绝)(?:\s+([\s\S]+))?\s*$/

const NOT_MINE: CommandResult = { handled: false }

/** 处理一条文本；不是管理命令就返回 `handled:false`，交回正常流程。 */
export async function handleAdminCommand(text: string, userId: number, ctx: CommandContext): Promise<CommandResult> {
  const match = RE.exec(text)
  if (match === null) return NOT_MINE
  const verb = match[1]!
  const arg = (match[2] ?? '').trim()

  // 群里**完全静默**：回复一句"只认私聊"等于告诉任何群友"这台机器有审批后门"，
  // 还能被拿来刷屏（2026-10-19 排查）。
  if (ctx.isGroup) return NOT_MINE
  if (!ctx.admins.includes(userId)) return { handled: true, reply: '无权操作。' }

  try {
    if (verb === '待批') {
      const all = await listRequests(ctx.dir)
      const open = all.filter((r) => r.status === 'pending' || r.status === 'approved').slice(0, 10)
      if (open.length === 0) return { handled: true, reply: '没有待批请求。' }
      return { handled: true, reply: `待批 ${open.length} 条：\n${open.map((r) => `${r.status === 'approved' ? '✅' : '⏳'} ${describeRequest(r)}`).join('\n')}` }
    }
    if (verb === '申请') {
      if (arg === '') return { handled: true, reply: '用法：申请 <命令原文>' }
      const req = await requestCommand(arg, ctx.dir, Date.now(), `dm-${userId}`)
      ctx.log?.(`approval: ${req.id} requested by dm-${userId} [${req.level}] ${req.command}`)
      return {
        handled: true,
        reply: `已提交：${describeRequest(req)}\n批准：批准 ${req.id}`,
      }
    }
    if (verb === '批准') {
      if (arg === '') return { handled: true, reply: '用法：批准 <请求号>' }
      const req = await approveById(arg, ctx.dir, Date.now(), `dm-${userId}`)
      ctx.log?.(`approval: ${req.id} approved by dm-${userId} [${req.level}] ${req.command}`)
      return { handled: true, reply: `已批准并排队执行：${describeRequest(req)}` }
    }
    if (verb === '拒绝') {
      if (arg === '') return { handled: true, reply: '用法：拒绝 <请求号>' }
      const req = await denyById(arg, ctx.dir, `dm-${userId}`)
      ctx.log?.(`approval: ${req.id} denied by dm-${userId}`)
      return { handled: true, reply: `已拒绝：${describeRequest(req)}` }
    }
  } catch (error) {
    return { handled: true, reply: `操作失败：${error instanceof Error ? error.message : String(error)}` }
  }
  return NOT_MINE
}
