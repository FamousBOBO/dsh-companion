/** 宿主流形状的**类型**（协议词汇）：块、结束原因、准备调用、一次补全的请求与结果。
 *
 * 为什么与 `llm.ts` 分家：这些是**契约**（七种块、`finish.reason` 的语义、`reasoning-delta`
 * 也带 `.text`），而 `llm.ts` 是**协议实现**（prepareCall → stream → 组装）。分开放也让
 * `llm.ts` 留在体量棘轮的单文件上限以内（`check:size`）。
 *
 * 2026-10-31 事故的教训都写在字段注释里：宿主把"适配器派发失败"报成一条终态 `finish` 块
 * 而不是异常，`reasoning-delta.text` 与 `text-delta.text` 同名——两者都不能按名字猜语义。
 */
import type { AttachmentsService } from '../../services.js'

/** 宿主上下文（cordis `Context` 的**不透明**把手：这里只原样转交，不读它的方法）。 */
export type HostContext = unknown

/**
 * 宿主流的一个块（`StreamChunk` 的**窄投影**，只声明本项目真读的字段）。
 * 真实协议（`@deepseek-ai/dsh-llm` 的 `StreamChunk`，本机 0.2.1-rc.3）是：
 * `{type:'block-start', index, blockType}` / `{type:'text-delta', index, text}` /
 * `{type:'reasoning-delta', index, text}` / `{type:'tool-call-delta', index, id, argumentsDelta}` /
 * `{type:'block-end', index, block}` / `{type:'usage', usage}` / `{type:'finish', reason}`。
 *
 * 三个**必须**在这里体现的事实（2026-10-31 主动消息"整天一条都没发"事故的根因）：
 *   1. 文本在 `text-delta.text`；**`reasoning-delta.text` 也是 `.text`**——两耳不闻类型
 *      地按 `.text` 拼，会把隐藏推理当成消息正文；
 *   2. 结束原因是 `finish.reason.kind`（`stop` / `max-tokens` / `aborted` / `error` /
 *      `tool-calls`），**不是异常**：适配器的派发失败是一条 `finish` 终态块；
 *   3. `block-end.block` 里带的是**整块**文本——已经在 delta 里拼过的块不能再拼一遍。
 * 兼容：老形状/测试里的 `{text}`（没有 `type`）按"可见正文"处理。
 */
export interface LlmStreamChunk {
  readonly type?: string
  readonly index?: number
  readonly text?: string
  readonly blockType?: string
  /** `block-end` 里组装好的整块。 */
  readonly block?: { readonly type?: string; readonly text?: string } | undefined
  /** `finish` 的结束原因。 */
  readonly reason?: {
    readonly kind?: string
    readonly failure?: { readonly code?: string; readonly message?: string } | undefined
  } | undefined
  readonly usage?: unknown
  /** 有的适配器把增量放在 `delta.text` 里；读到就用（与 `.text` 二选一）。 */
  readonly delta?: { readonly text?: string } | undefined
}

/** `ctx.llm.stream()` 返回的流：块序列（`AsyncIterable<StreamChunk>`）。 */
export type LlmStream = AsyncIterable<LlmStreamChunk>

/** 一次调用的具体控制项（`LlmCallControls` 的窄投影）。 */
export interface LlmCallControls {
  readonly reasoningEffort?: string
  readonly temperature?: number
  readonly maxTokens?: number
  readonly stop?: readonly string[]
}

/** 路由 + 控制项（`LlmCallConfig` 的窄投影）。 */
export interface LlmCallConfig extends LlmCallControls {
  readonly provider: string
  readonly model: string
}

/** 一次**已准备好**的调用（`PreparedLlmCall` 的窄投影）：`stream` 只能派发一次。 */
export interface LlmPreparedCall {
  readonly config: LlmCallConfig
  stream(options: Record<string, unknown>): LlmStream
}

/** 模型元信息里我们看的那一格：可选推理档位（`LlmResolvedModelInfo` 的窄投影）。 */
export interface LlmReasoningInfo {
  /** 由弱到强排列；`id` 是传给 `reasoningEffort` 的稳定值。 */
  readonly efforts?: readonly { readonly id?: string }[]
  readonly defaultEffort?: string
}

/** `ctx.llm`：真实宿主是 `LlmRuntime`，这里只声明本项目真用到的方法。 */
export interface LlmService {
  stream(options: Record<string, unknown>): LlmStream
  /**
   * 准备一次调用（可选：老宿主/测试假件可能只有 `stream`）。
   *
   * **为什么必须走它**：裸 `stream({provider, model, messages})` 拿不到适配器在准备阶段
   * 物化的路由配置（会话头、推理档位、`maxTokens` 默认值），实测在 opencode-go 上
   * 只会回 `usage` + `finish` 两块、**一个文本块都没有**——见 `hostCompletion` 的注记。
   */
  prepareCall?(
    config: LlmCallConfig,
    signal?: AbortSignal,
    configure?: (
      controls: Readonly<LlmCallControls>,
      model: Readonly<{ readonly reasoning?: LlmReasoningInfo }>,
    ) => LlmCallControls,
  ): Promise<LlmPreparedCall>
}

/** LLM 接缝：直接发一次补全（表情包打标 / 主动消息草稿），以及当前的默认选型。 */
export interface LlmSeam {
  llm?: LlmService
  agentDefaultModel?: { currentSelection(): { provider: string; model: string; reasoningEffort?: string } }
  /**
   * 视觉消息要用的附件存储。`llm.stream` 的 content block 是**宿主形状**
   * `{type:'image', attachment}`（附件由 `ctx.attachments.saveImage` 落盘），
   * 不是 OpenAI 的 `image_url`——给错形状模型会回「未收到图片」。
   */
  attachments?: AttachmentsService
}

/**
 * 一次补全请求（**单次**：一个请求 = 至多一次生成，本函数自己不重试）。
 *
 * `sessionId` 不是可选装饰：opencode-go 会拒绝没有 `x-opencode-session-id` 的请求
 * （本仓库 `plugins/companion-foundation/host-llm.mjs:103-107` 记过这条实测），
 * 后台调用必须带一个可归属的稳定 id。
 */
export interface HostCompletionRequest {
  readonly selection: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }
  readonly prompt: string
  readonly maxTokens: number
  readonly sessionId: string
  /** 想用的推理档位（默认 `low`）；模型没声明该档位时**不传**，而不是硬塞。 */
  readonly preferredEffort?: string
  /** 取消信号（超时由调用方触发；适配器只转交，不自己造）。 */
  readonly signal?: AbortSignal
}

/** 结束原因（未知的适配器取值原样透出；诊断只按串比较）。 */
export type HostFinishKind = 'stop' | 'max-tokens' | 'tool-calls' | 'error' | 'aborted' | 'none'

/**
 * 一次补全的**可判别结果**（绝不抛）。
 *
 * 三个正交的问题必须分开答，否则"没话可说"会吃掉"模型根本没用上"：
 *   - `routed`：路由存在吗（`prepareCall` 过没过）；
 *   - `dispatched`：**真的进入 `call.stream` 了吗**（没进 = 一个 token 都没花）；
 *   - `finishKind` + `text`：流跑完了，到底给了什么。
 */
export interface HostCompletion {
  /** 可见正文（只拼 `text-delta` / `block-end[text]`；**不含** reasoning）。 */
  readonly text: string
  /** 隐藏推理的字数（诊断用；永不进正文）。 */
  readonly reasoningChars: number
  readonly finishKind: HostFinishKind
  readonly failureCode: string | null
  readonly failureMessage: string | null
  /** 观测到的块类型（前 12 个；排查"形状不对"唯一的事实来源）。 */
  readonly chunkTypes: readonly string[]
  readonly routed: boolean
  readonly dispatched: boolean
  /** 实际用的推理档位（`null` = 没传，用模型默认）。 */
  readonly effort: string | null
  /** 宿主报的用量（失败时通常全 0 = 一个 token 都没生成过）。 */
  readonly usage: { readonly input: number; readonly output: number; readonly reasoning: number } | null
}
