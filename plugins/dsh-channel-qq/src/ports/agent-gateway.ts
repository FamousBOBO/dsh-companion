/** 宿主会话的接缝：开一个会话、往里面递东西、听它的回合事件。
 *
 * 为什么要有这条缝（04 §2）：`bridge.ts` 原来
 * 手里攥着整个 cordis `Context`——`agents` / `agentPresets` / `agentDefaultModel` /
 * `permissionPresets` / `sessionTitle` / `workspaceRegistry` / `attachments` 七个服务，
 * 加上十来处 `as never`。后果不是"不好看"，而是**任何一次会话逻辑的测试都要先造一个
 * 假宿主**，而且宿主升级时"哪里会坏"没有边界。
 *
 * 缝划在这里之后：
 *   - `app/` 只认识下面这几个类型，不认识 cordis；
 *   - 会话创建/恢复的全部顺序、竞态与重试写在 `adapters/dsh-host/agents.ts` 一处；
 *   - 测试可以直接给一个"记账用的假网关"，比假宿主更小也更诚实。
 *
 * 只有类型，没有实现；实现见 `adapters/dsh-host/agents.ts`。
 */

/** 递进会话的一块内容。`attachment` 是不透明的附件引用（由网关自己解释）。 */
export type PromptPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly attachment: unknown }

/** 一段完整的投递内容。 */
export type PromptContent = readonly PromptPart[]

/** 往会话里递内容的通道。 */
export type DeliverMode =
  /** 排队等这一轮跑完（默认）。 */
  | 'followup'
  /** 只进上下文，不唤醒（宿主在下一个步边界取用）。 */
  | 'inject'
  /** 唤醒空闲的会话去处理。 */
  | 'steer'

/** 一个回合的生命周期事件。 */
export interface TurnListener {
  /** 这一轮跑完了。 */
  onIdle(): void
  /**
   * 本轮报错。
   *
   * `raw` 是错误对象 `JSON.stringify` 之后的串（失败分类读它——原因见
   * `core/retry-policy.ts`）；`detail` 是给人看的一行。
   */
  onError(error: { readonly raw: string; readonly detail: string }): void
}

/** 打开（创建或恢复）一个会话需要的东西。 */
export interface SessionSpec {
  /** 会话 id，例如 `qq-group-1000000003`。它同时是磁盘上的目录名。 */
  readonly sessionId: string
  /** 会话的工作目录（= 配置里的 `workspacePath`，可热改）。 */
  readonly cwd: string
  /** 人格预设 id。 */
  readonly presetId: string
  readonly provider: string
  readonly model: string
  /** 会话标题（后台会话列表里显示的那一行）。 */
  readonly title: string
  readonly permissionPreset: string
  /**
   * 每轮最多几步；`0` = 不限。
   *
   * 是取值函数而不是数值：原实现对**每个步边界**重新读配置，所以后台把上限从 0
   * 改成 20 会立即生效。换成一个定值就等于悄悄取消了这个热加载。
   */
  readonly stepBudget: () => number
  readonly listener: TurnListener
  readonly log: (line: string) => void
}

/** 一个打开的会话。 */
export interface AgentSession {
  readonly id: string
  /** 正在跑一轮吗（宿主只在部分版本上暴露状态，拿不到时返回 false）。 */
  isRunning(): boolean
  /**
   * 递一段内容。
   *
   * @returns 真的递出去了为 true；宿主不支持这个通道时为 false（调用方退回 `followup`）。
   */
  deliver(content: PromptContent, mode: DeliverMode): boolean
  /**
   * 释放这个会话。
   *
   * @returns 释放成功为 true；"本插件只是挂上去、不拥有释放能力"为 false。
   * @throws 释放**失败**时抛错——与"没有释放能力"是两件事，调用方要分开记。
   */
  dispose(): Promise<boolean>
}

/** 宿主会话网关。 */
export interface AgentGateway {
  /**
   * 打开一个会话：宿主里还活着就接上去，否则创建；会话 id 已落盘就恢复它的历史。
   *
   * 这条路径上的顺序、竞态与重试**全部**由实现负责——调用方拿到的只有
   * "一个可用的会话"或者一个异常。
   */
  open(spec: SessionSpec): Promise<AgentSession>
  /** 宿主当前的默认路由（私聊用它；群聊可能被配置里的 `groupModel` 覆盖）。 */
  defaultRoute(): { provider: string; model: string }
  /**
   * 把已落盘的 `qq-*` 会话全部挂回工作区（启动自愈）。
   *
   * 为什么放在网关里而不是 `app/`：这件事要读宿主的会话目录布局，是适配器的知识。
   */
  reattachAll(cwd: string, groupCwd?: string | null): Promise<{ attached: number; total: number }>
  /** 存一张图片附件，返回不透明的引用（可放进 `PromptPart` 的 `image`）。 */
  saveImage(input: { data: Uint8Array; mediaType: string; name: string }): Promise<unknown>
}
