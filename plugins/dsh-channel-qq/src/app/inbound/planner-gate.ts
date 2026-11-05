/** 群聊准入的**适配层**（P6g）：把入站事件的形状喂给 `core/planner.ts` 的判定。
 *
 * 为什么单独一个文件：判定本身是纯函数（`core/planner.ts`），但"从事件与配置里
 * 取哪几个字段"是宿主形状的知识——那条知识属于这里（`app/inbound/`），不属于
 * `core/`（`core/` 只认已经算好的事实）。分开之后 `pipeline.ts` 只剩一行调用。
 *
 * 开关关着时**一个字节都不跑**（连字段都不取）：默认关是这个项目里"新行为必须
 * 可关"的通用做法。
 */

import { planInbound } from '../../core/planner.js'
import type { OneBotEvent } from '../../types.js'
import type { ParsedInbound } from '../../core/message/parse.js'
import type { PipelineConfig } from './pipeline.js'

export interface PlannerGateDeps {
  readonly config: () => PipelineConfig
  readonly log: (line: string) => void
}

/** 这一条群消息能不能进 agent？（关着开关时永远放行。）
 *
 * `requireMention` 由调用方传入**这个群**解析后的值（按群覆盖见 core/room-policy）：
 * 闸门只认已经算好的事实，不自己去查配置。
 */
export function plannerAllows(
  deps: PlannerGateDeps,
  key: string,
  event: OneBotEvent,
  parsed: ParsedInbound,
  called: boolean,
  requireMention: boolean,
): boolean {
  const config = deps.config()
  if (config.planner?.enabled !== true) return true
  const plan = planInbound({
    isGroup: true,
    called,
    requireMention,
    // 宿主没给"发送者是机器人"的标记，能可靠判的只有自环（自己的消息回来）。
    fromBot: event.user_id === config.selfId,
    hasText: parsed.plainText.trim() !== '',
  })
  if (plan.decision !== 'ignore') return true
  deps.log(`planner: ignore (${plan.reason}) ${key}`)
  return false
}
