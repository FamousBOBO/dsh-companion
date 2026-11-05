/** 审批网关的功能装配：管理员命令 + 回执轮询。
 *
 * 这块不注册新工具、也不进装载表——它挂在 inbound 子插件里（命中最前置、不经模型），
 * 这样既不用改子插件顺序，也不会动到工具面快照。
 */

import { approvalDir, listResults, removeResult, type ExecResult } from './store.js'
import { handleAdminCommand } from './commands.js'
import type { SubHost } from '../plugin-kit.js'

/**
 * 造一个"私聊管理员命令"处理器；没启用审批的部署不装它。
 *
 * `admins` 是**取值函数**而不是快照：撤掉一个管理员后，他手里的「批准」
 * 必须立刻失效（2026-10-19 排查：apply 时快照 ⇒ 撤权不生效）。
 */
export function createAdminCommand(admins: () => readonly number[], log?: (line: string) => void): (text: string, userId: number) => Promise<string | null> {
  return async (text: string, userId: number) => {
    const result = await handleAdminCommand(text, userId, { isGroup: false, admins: admins(), log })
    return result.handled ? result.reply : null
  }
}

function receiptText(result: ExecResult): string {
  const head = result.ok ? '✅ [审批回执] 命令已执行' : '❌ [审批回执] 执行失败'
  const output = result.output.trim() === '' ? '（无输出）' : result.output.trim().slice(-800)
  return [
    head,
    `请求号：${result.id}`,
    `命令：${result.command}`,
    `退出码：${result.exitCode ?? '—'}`,
    `输出：${output}`,
  ].join('\n')
}

/**
 * 轮询 root 执行器写回的回执，转发给管理员私聊。
 *
 * 为什么是轮询而不是回调：执行器在**独立的 cgroup**里跑（重启 dsh 时不能连自己一起
 * 杀掉），它没法调用插件的内存。文件是两边唯一稳定的交界面。
 */
export function startReceiptPoller(host: SubHost, everyMs = 20_000): () => void {
  let stopped = false
  const tick = async (): Promise<void> => {
    if (stopped) return
    const results = await listResults(approvalDir()).catch(() => [])
    if (results.length === 0) return
    // 回执发给**全部**管理员（批准权限就是按整张名单判的）；名单为空时
    // 什么都不删，等有人被加回来再补发。
    const admins = host.config.admins
    const parts = host.get('platform')
    if (admins.length === 0 || parts === undefined) return
    for (const result of results) {
      let delivered = true
      for (const admin of admins) {
        try {
          await parts.out.push(() => parts.api.sendPrivateMessage(admin, [{ type: 'text', data: { text: receiptText(result) } }]))
        } catch (error) {
          delivered = false
          host.log(`approval receipt send failed (${result.id} → ${admin}): ${String(error)}`)
        }
      }
      // **发成功才删**：旧实现先删后发，发送失败即永久丢失。
      if (delivered) await removeResult(result.id, approvalDir())
      host.log(`approval: receipt ${result.id} (${result.ok ? 'ok' : 'fail'}) ${delivered ? 'delivered' : 'kept for retry'}`)
    }
  }
  const timer = setInterval(() => { void tick() }, everyMs)
  timer.unref?.()
  void tick()
  return () => { stopped = true; clearInterval(timer) }
}
