/** 宿主的 **LLM 接缝（实现）**：一次补全（`prepareCall` → `stream` → 块组装）。
 *
 * 为什么从 `services.ts` 拆出来：宿主流形状的知识（七种块、`finish.reason` 的语义、
 * `reasoning-delta` 也带 `.text`）是**协议**，"取服务"是**装配**——混在一起时协议细节会被
 * "取服务不抛错"的风格盖住，2026-10-31 的事故（裸 `stream` 只回 `usage`+`finish`、草稿全空）
 * 因此在代码里看不出来。类型在 `./llm-types.ts`，这里只放行为。
 */
import { llmSeam } from './services.js'
import type {
  HostCompletion,
  HostCompletionRequest,
  HostContext,
  HostFinishKind,
  LlmCallConfig,
  LlmReasoningInfo,
  LlmService,
  LlmStream,
  LlmStreamChunk,
} from './llm-types.js'

// 类型词表仍从这里可见：调用点（`features/contact/draft-host.ts` 等）不需要改 import 路径。
export type {
  HostCompletion,
  HostCompletionRequest,
  HostContext,
  HostFinishKind,
  LlmCallConfig,
  LlmCallControls,
  LlmPreparedCall,
  LlmReasoningInfo,
  LlmSeam,
  LlmService,
  LlmStream,
  LlmStreamChunk,
} from './llm-types.js'


/** 空结果（没路由 / 没派发 / 抛错时用；字段全给，避免下游判 undefined）。 */
function noCompletion(patch: Partial<HostCompletion> & Pick<HostCompletion, 'routed' | 'dispatched'>): HostCompletion {
  return {
    text: '',
    reasoningChars: 0,
    finishKind: 'none',
    failureCode: null,
    failureMessage: null,
    chunkTypes: [],
    effort: null,
    usage: null,
    ...patch,
  }
}

/** 从任意异常里取 `code` / `message`（宿主用 `LlmError.code` 表达"哪一类失败"）。 */
function describeFailure(error: unknown): { code: string; message: string } {
  if (typeof error === 'object' && error !== null) {
    const shape = error as { code?: unknown; message?: unknown }
    const code = typeof shape.code === 'string' && shape.code !== '' ? shape.code : 'ERROR'
    const message = typeof shape.message === 'string' ? shape.message : String(error)
    return { code, message }
  }
  return { code: 'ERROR', message: String(error) }
}

/** 一个块里的增量文本（`.text` 优先，`delta.text` 兜底；都没有就是空串）。 */
function chunkText(chunk: LlmStreamChunk): string {
  if (typeof chunk.text === 'string') return chunk.text
  if (typeof chunk.delta?.text === 'string') return chunk.delta.text
  return ''
}

/**
 * 从模型声明的档位里**挑一个最省**的（默认想 `low`）。三条规矩：
 *   1. 只挑模型**声明过**的 id：硬塞不支持的档位会被 `prepareCall` 拒（`UNSUPPORTED_REASONING_EFFORT`），
 *      于是"想省推理"变成"一次草稿都发不出"；
 *   2. 想要的不在表里就退到表里**最弱**的那一档（`efforts` 由弱到强），而不是回到默认；
 *   3. 模型没声明推理能力（`reasoning` 为空）就**不传**——此时传任何档位都会抛。
 */
export function pickDraftEffort(
  preferred: string,
  reasoning: LlmReasoningInfo | undefined,
): string | null {
  const efforts = (reasoning?.efforts ?? []).map((entry) => entry.id).filter((id): id is string => typeof id === 'string' && id !== '')
  if (efforts.length === 0) return null
  if (efforts.includes(preferred)) return preferred
  for (const alias of ['low', 'minimal', 'none', 'off']) {
    if (efforts.includes(alias)) return alias
  }
  return efforts[0] ?? null
}

/**
 * 跑**一次**补全并把块组装成文本（`prepareCall` → `call.stream` → 累加）。
 *
 * 为什么不是裸 `llm.stream({provider, model, messages})`（**2026-10-31 的根因**）：裸调用
 * 绕过了适配器物化的路由——没有会话头（provider 拒）、没把推理档位降下来（`max` + 小
 * `maxTokens` 会把预算全烧在隐藏推理上）、也拿不到适配器默认值。本机实测：裸调用只回
 * `usage` + `finish`，**一个 `text-delta` 都没有**，所有草稿于是都成了"空回复"。
 * 形状与姿势照 `plugins/companion-foundation/host-llm.mjs:115-165`（那条路生产里是通的）。
 *
 * **单次**：一个请求只派发一次 `stream`；不重试、不降档重来。`dispatched` = "真的进了
 * `call.stream`"，调用方据此决定这笔账算不算花过钱。
 */
export async function hostCompletion(ctx: HostContext, request: HostCompletionRequest): Promise<HostCompletion> {
  let llm: LlmService | undefined
  try {
    // 服务 getter 也可能抛（F45：这时一次生成都没发生，不能算"调过模型"）。
    llm = llmSeam(ctx).llm
  } catch (error) {
    const failure = describeFailure(error)
    return noCompletion({ routed: false, dispatched: false, failureCode: failure.code, failureMessage: failure.message })
  }
  if (llm === undefined) return noCompletion({ routed: false, dispatched: false, failureCode: 'NO_LLM', failureMessage: '宿主没有 llm 服务' })

  const { provider, model } = request.selection
  const route: LlmCallConfig = { provider, model, maxTokens: request.maxTokens }
  const message = { role: 'user', content: [{ type: 'text', text: request.prompt }] }
  const base = { messages: [message], sessionId: request.sessionId, ...(request.signal === undefined ? {} : { signal: request.signal }) }
  const dispatched = await dispatch(llm, route, base, request.preferredEffort ?? 'low')
  if (dispatched.kind === 'blocked') {
    return noCompletion({
      routed: dispatched.routed,
      dispatched: dispatched.dispatched,
      failureCode: dispatched.failure.code,
      failureMessage: dispatched.failure.message,
      effort: dispatched.effort,
    })
  }
  const state: Assembly = {
    text: '', reasoningChars: 0, finishKind: 'none', deltaIndexes: new Set<number>(),
    effort: dispatched.effort, failureCode: null, failureMessage: null, usage: null,
  }
  const { body, thrown, missingFinish } = await drainStream(dispatched.stream, state)
  // `thrown`（迭代中抛错）比"终态失败块"更强；两者都没有、但一条 `finish` 都没有时，
  // 这条流**没有告诉我们它是怎么结束的**——按 `stream-error:NO_FINISH` 记失败，而不是
  // 当成"模型回了空白"（2026-10-31 的教训：没读到结束原因就等于什么都没读到）。
  const failure = thrown ?? (missingFinish ? { code: 'NO_FINISH', message: '流结束了但没有 finish 块（宿主的结束原因丢失）' } : null)
  return {
    ...body,
    routed: true,
    dispatched: true,
    ...(failure === null ? {} : { failureCode: failure.code, failureMessage: failure.message }),
  }
}

/**
 * 派发一次（`prepareCall` → `stream`），把"准备阶段就失败"与"已经派发"分开。
 *
 * `dispatched` 在**调用 `stream` 的那一行之前**置位：`stream()` 同步抛错也算"我们真的
 * 向宿主发起过请求"（否则一台永远同步抛错的宿主会绕过失败退避，无限重试）。
 * `prepareCall` 阶段的失败（没有适配器、档位不支持）则保持 `dispatched:false`——那一次
 * 生成一个 token 都没花。
 */
async function dispatch(
  llm: LlmService,
  route: LlmCallConfig,
  base: Record<string, unknown>,
  preferredEffort: string,
): Promise<
  | { kind: 'ready'; routed: true; dispatched: true; effort: string | null; stream: LlmStream }
  | { kind: 'blocked'; routed: boolean; dispatched: boolean; effort: string | null; failure: { code: string; message: string } }
> {
  const signal = typeof base['signal'] === 'object' ? (base['signal'] as AbortSignal) : undefined
  let effort: string | null = null
  let routed = false
  let dispatched = false
  try {
    if (typeof llm.prepareCall === 'function') {
      const call = await llm.prepareCall(route, signal, (controls, info) => {
        const picked = pickDraftEffort(preferredEffort, info?.reasoning)
        effort = picked
        return picked === null ? controls : { ...controls, reasoningEffort: picked }
      })
      routed = true
      // `call.config` 是**适配器物化之后**的路由（provider/model/effort/maxTokens）；
      // `callConfigEquals` 只比这几个字段，所以额外带 messages/sessionId 不会被判"配置漂移"。
      const options = { ...call.config, ...base }
      dispatched = true
      return { kind: 'ready', routed: true, dispatched: true, effort, stream: call.stream(options) }
    }
    // 老宿主/测试假件：没有准备阶段就只能裸调，至少保证"能跑"。
    routed = true
    dispatched = true
    return { kind: 'ready', routed: true, dispatched: true, effort, stream: llm.stream({ ...route, ...base }) }
  } catch (error) {
    return { kind: 'blocked', routed, dispatched, effort, failure: describeFailure(error) }
  }
}

/**
 * 收完一次流：块类型留样、正文/推理分别累加、终态失败的码留在 `state` 里。
 *
 * 迭代中抛错（比"终态失败块"更强的证据）放在 `thrown` 里返回，由调用方覆盖终态块的码。
 * `missingFinish` = 看见过**真实协议块**（带 `type`），却一条 `finish` 都没等到——
 * 这时"没有正文"不能算"模型回了空白"，因为这次调用根本没告诉我们它怎么结束的。
 * 老形状（只有 `{text}` 的假件/旧适配器）不适用这条：它们本来就没有 finish 块。
 */
async function drainStream(
  stream: LlmStream,
  state: Assembly,
): Promise<{
  body: Omit<HostCompletion, 'routed' | 'dispatched'>
  thrown: { code: string; message: string } | null
  missingFinish: boolean
}> {
  const chunks: string[] = []
  let thrown: { code: string; message: string } | null = null
  let sawFinish = false
  let sawTyped = false
  try {
    for await (const chunk of stream) {
      const type = typeof chunk?.type === 'string' ? chunk.type : ''
      if (type !== '') sawTyped = true
      if (type === 'finish') sawFinish = true
      if (chunks.length < 12) chunks.push(type === '' ? '(legacy)' : type)
      absorb(state, chunk)
    }
  } catch (error) {
    thrown = describeFailure(error)
  }
  return { body: snapshot(state, chunks), thrown, missingFinish: thrown === null && sawTyped && !sawFinish }
}

/** 组装过程中的可变量（字段可变：TS 才看得见"在闭包/循环里被赋值"）。 */
interface Assembly {
  text: string
  reasoningChars: number
  finishKind: HostFinishKind
  /** 已经用 delta 拼过的块序号：`block-end` 不能再把同一块的整段文本拼一遍。 */
  readonly deltaIndexes: Set<number>
  /** 实际用的推理档位（`null` = 没传）。 */
  effort: string | null
  /** 终态失败块里带的失败码（宿主把适配器/派发失败报成 `finish:error`，不抛）。 */
  failureCode: string | null
  failureMessage: string | null
  /** 宿主报的用量（全 0 = 一个 token 都没生成，是"没话说"之外的第二个诚实信号）。 */
  usage: { input: number; output: number; reasoning: number } | null
}

/** 吃一个块：只把**可见**文本拼进正文，推理单独计数，结束原因单独记。 */
function absorb(state: Assembly, chunk: LlmStreamChunk): void {
  const type = typeof chunk?.type === 'string' ? chunk.type : ''
  switch (type) {
    case 'text-delta': {
      if (typeof chunk.index === 'number') state.deltaIndexes.add(chunk.index)
      state.text += chunkText(chunk)
      return
    }
    case 'reasoning-delta': {
      state.reasoningChars += chunkText(chunk).length
      return
    }
    case 'block-end': {
      const block = chunk.block
      if (block === undefined) return
      const text = typeof block.text === 'string' ? block.text : ''
      const seen = typeof chunk.index === 'number' && state.deltaIndexes.has(chunk.index)
      if (block.type === 'text') {
        // 有 delta 的块已经拼过了：再拼 block-end 的整块会把这段话重复一遍。
        if (!seen) state.text += text
        return
      }
      if (block.type === 'reasoning') state.reasoningChars += text.length
      return
    }
    case 'finish': {
      const kind = chunk.reason?.kind
      state.finishKind = kind === 'stop' || kind === 'max-tokens' || kind === 'tool-calls' || kind === 'error' || kind === 'aborted'
        ? kind
        : 'none'
      if (state.finishKind === 'error' || state.finishKind === 'aborted') {
        // 宿主的约定：适配器/派发失败**不抛**，而是一条终态 finish 块。丢掉它就把
        // "provider 拒绝了这次请求"读成了"模型回了空白"（2026-10-31 事故）。
        state.failureCode = chunk.reason?.failure?.code ?? state.finishKind.toUpperCase()
        state.failureMessage = chunk.reason?.failure?.message ?? state.finishKind
      }
      return
    }
    case '':
      // 老形状/测试假件：没有 `type` 的块按可见正文处理（`{text:'...'}`）。
      state.text += chunkText(chunk)
      return
    case 'usage': {
      // 失败时这里通常是**全 0**：比"没有正文"更硬的证据（一个 token 都没生成过）。
      const usage = (chunk.usage ?? {}) as { inputTokens?: unknown; outputTokens?: unknown; reasoningTokens?: unknown }
      const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
      state.usage = { input: num(usage.inputTokens), output: num(usage.outputTokens), reasoning: num(usage.reasoningTokens) }
      return
    }
    default:
      // `block-start` / `tool-call-delta`：与正文无关。
      return
  }
}

function snapshot(state: Assembly, chunks: readonly string[]): Omit<HostCompletion, 'routed' | 'dispatched'> {
  return {
    text: state.text,
    reasoningChars: state.reasoningChars,
    finishKind: state.finishKind,
    failureCode: state.failureCode,
    failureMessage: state.failureMessage,
    chunkTypes: [...chunks],
    effort: state.effort,
    usage: state.usage,
  }
}
