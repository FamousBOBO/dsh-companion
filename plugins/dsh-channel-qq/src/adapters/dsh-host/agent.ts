/** 宿主 agent 的接线面：消息投递、状态查询、事件订阅。
 *
 * **这里是 `as never` / `as unknown as` 唯一的落点**（06 §P2.9）。
 *
 * 为什么要把转型集中到一处：宿主类型是**运行时形状的知识**——`agent.status`
 * 有没有、`steer`/`inject` 在不在、`ctx.on('agent/pre-step')` 的监听器收几个
 * 参数、返回什么能中断本轮。这些原来散在 `bridge.ts` 的十来处 `as never` 里，
 * 于是"宿主升级之后哪里会坏"这个问题没有答案——每一处都只知道自己那一点。
 * 集中之后，宿主换版本时只需要看这一个文件，`check-layers` 的 R2 基线也才有
 * 收缩的余地。
 *
 * 每个包装都**按缺失降级**而不是抛错：`steer`/`inject` 在旧运行时上不存在，
 * 调用方拿到 `false` 再走 `followup` 兜底（这是原来就地写死的行为，语义没变）。
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, errorChain } from '@deepseek-ai/dsh-llm'
import type { PromptPart } from '../../ports/agent-gateway.js'
import type { PromptBlock } from '../../services.js'

/** 宿主 `createUserMessage` 的返回类型（不自己复述一遍，避免宿主改了名字而这里没跟上）。 */
export type HostUserMessage = ReturnType<typeof createUserMessage>

/** 把错误链渲染成一行文本；原样转发宿主实现。 */
export { errorChain }

/**
 * 造一条"用户发的"消息。
 *
 * 入参是**端口那边的**内容形状（`PromptPart`），不是宿主的 `PromptBlock`：
 * 这样 `app/` 递东西进来时不必认识宿主类型，翻译发生在这一个函数里。
 *
 * `source.kind` 只能是 `'user'`：v4 会话格式拒绝 `'plugin'`（retired plugin
 * wrappers），而 plugin 字段只是自留的归属标记。这个形状宿主类型里没有，
 * 所以转型发生在这里——**只有这里**。
 */
export function buildUserMessage(content: readonly PromptPart[]): HostUserMessage {
  const blocks: PromptBlock[] = content.map((part) => (
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : { type: 'image', attachment: part.attachment }
  ))
  return createUserMessage({
    content: blocks,
    source: { kind: 'user', plugin: 'channel-qq' },
  } as never)
}

/** agent 是否正在跑一轮（宿主只在部分版本上暴露 `status`）。 */
export function agentStatusOf(agent: unknown): string | undefined {
  const record = agent as { status?: unknown } | null
  return typeof record?.status === 'string' ? record.status : undefined
}

/**
 * 把消息插进**正在跑的那一轮**，不唤醒 agent。
 *
 * @returns 宿主支持 `inject` 且调用成功时为 true；否则 false（调用方退回 `followup`）。
 */
export function injectAgent(agent: unknown, message: HostUserMessage): boolean {
  const record = agent as { inject?: (m: unknown) => void } | null
  if (typeof record?.inject !== 'function') return false
  record.inject(message)
  return true
}

/**
 * 唤醒空闲的 agent 去处理这条消息。
 *
 * @returns 宿主支持 `steer` 且调用成功时为 true；否则 false。
 */
export function steerAgent(agent: unknown, message: HostUserMessage): boolean {
  const record = agent as { steer?: (m: unknown) => void } | null
  if (typeof record?.steer !== 'function') return false
  record.steer(message)
  return true
}

/** 我们订阅的 agent 事件，以及每个事件的监听器签名。 */
export interface AgentEventMap {
  'agent/status': { payload: { status?: string }; result: void }
  'agent/error': { payload: { error?: unknown }; result: void }
  'agent/pre-step': { payload: unknown; result: unknown }
  'agent/request': { payload: unknown; result: { provider: string; model: string } }
}

/**
 * 订阅一个 agent 事件。
 *
 * 两类事件语义不同：`agent/status`、`agent/error` 是**广播**（监听器的返回值
 * 被忽略），`agent/pre-step`、`agent/request` 是**瀑布**（监听器必须返回一个
 * 值，通常是 `next()` 的结果）。签名统一成"收 payload、可选 next"，由宿主决定
 * 要不要用返回值——这正是原来每一处 `as never` 在掩盖的东西。
 */
export function onAgentEvent<K extends keyof AgentEventMap>(
  agentCtx: Context,
  event: K,
  listener: (
    payload: AgentEventMap[K]['payload'],
    next: () => Promise<AgentEventMap[K]['result']>,
  ) => unknown,
): void {
  const events = agentCtx as unknown as { on(event: string, handler: unknown): unknown }
  events.on(event, listener as never)
}
