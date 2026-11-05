/** 工作区 `AGENTS.md` 的**指令受管区**（P6b）：渲染、写入、移除。
 *
 * 为什么落在受管区而不是宿主提示片段接缝（`ctx.systemPrompt.section()`）：宿主确实
 * 有那条接缝（`内部文档宿主核实记录.md` V4），但按 Agent 注册要改
 * `adapters/dsh-host/agents.ts`（别人的文件），在插件根上下文注册则是全局的、会把
 * QQ 行为约定漏给同进程里所有非 QQ 会话——所以走 05 §3.4 的另一条落点。
 * 只碰 `<!-- channel-qq:begin -->…<!-- channel-qq:end -->` 之间的内容，区外逐字节保留。
 *
 * 从 `features/inbound/index.ts` 拆出（体量棘轮）：这段逻辑与入站流水线无关，
 * 只跟工作区文件打交道，单独放一个文件更好读也更好测。
 */

import * as path from 'node:path'
import { atomicWriteFile, readTextFileOrNull } from '../../adapters/fs-store/atomic.js'
import { regionBlock, stripManagedRegion, upsertManagedRegion } from '../../core/instruction/managed-region.js'
import type { SubHost } from '../plugin-kit.js'

/** 同步结果的一句话（启动日志与后台热更新回执共用）。 */
export type InstructionRegionStatus = 'created' | 'updated' | 'removed' | 'unchanged' | 'malformed'

/** 把指令层受管区写进工作区 AGENTS.md（`body === null` = 移除）。 */
export async function writeInstructionRegion(workspacePath: string, body: string | null): Promise<InstructionRegionStatus> {
  const file = path.join(workspacePath, 'AGENTS.md')
  const current = await readTextFileOrNull(file)
  if (body === null) {
    if (current === null) return 'unchanged'
    const stripped = stripManagedRegion(current)
    if (stripped.status === 'malformed') return 'malformed'
    if (stripped.status === 'absent') return 'unchanged'
    await atomicWriteFile(file, stripped.text)
    return 'removed'
  }
  const result = upsertManagedRegion(current ?? '', regionBlock(body))
  if (result.status === 'malformed') return 'malformed'
  if (result.status === 'unchanged') return 'unchanged'
  await atomicWriteFile(file, result.text)
  return current === null ? 'created' : 'updated'
}

/** 读配置、渲染人格包、同步受管区；任何失败都只汇报、不抛出（不能挡住启动与热更新）。 */
export async function syncInstructionRegion(host: SubHost): Promise<string> {
  const workspace = host.config.workspacePath
  if (workspace === null || workspace === '') return '未配置工作区，跳过'
  let body: string | null = null
  if (host.config.context?.v2 === true && !host.config.context.agentInstructions) {
    try {
      // 必须走 composer 而不是 pack：tools.v2 开着时 composer 会把旧工具名改写成
      // 合并后的写法。用 pack.render 会把这行旧名字原样写进 AGENTS.md，模型每轮
      // 都读它——2026-10-18 线上就是这样继续"撞墙"的。
      body = host.need('persona').composer.render('instruction/behavior')
    } catch (error) {
      return `渲染 instruction/behavior 失败：${error instanceof Error ? error.message : String(error)}`
    }
  }
  try {
    const status = await writeInstructionRegion(workspace, body)
    return status === 'malformed' ? 'AGENTS.md 受管区标记不成对，未改动（需人工检查）' : status
  } catch (error) {
    return `写入失败：${error instanceof Error ? error.message : String(error)}`
  }
}
