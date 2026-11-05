/** 宿主的 **纯补全端口**（实现）：给「兴趣判断」用的"一次、短提示词、无会话、无工具"。
 *
 * 为什么不是 `AgentGateway.open()`：判一句"要不要接话"不该建 agent、给工具面、跑步数预算
 * ——那会把"她有自己的工具"这条事实搅进一次静默判断里，还会写出群会话历史。这里与
 * `features/contact/draft-host.ts` 同一个姿势：`prepareCall` → `call.stream` 一次补全。
 *
 * 与 `draft-host.ts` 的差别只有两处（都是本用例的硬要求）：
 *   1. **单次不重试**，且 `maxTokens` / `timeoutMs` / `sessionId` 由调用方逐次给
 *      （判断的频率与预算由 `presence.judge*` 配置决定，不在这里写死）；
 *   2. 结果为四种**可判别**的 kind（`text` / `no-route` / `failed` / `timeout`），
 *      **绝不抛**：判断这条路径上，"模型不可用"必须是"这一轮不说话"，不是异常。
 *
 * 超时用**注入的 `Clock`**（测试用假时钟才不用真等 25 秒）。超时的那次调用结果直接丢弃：
 * 它已经晚了，再补一句"刚才想到一句"就是对着旧话题说话。
 *
 * 端口类型（`CompletePort` / `CompleteRequest` / `CompleteResult`）由**消费者**声明
 * （`app/inbound/presence-runtime.ts`）：`app/` 不许 import `adapters/`（分层检查 R8），
 * 所以适配器只负责实现它、装配侧负责接线。
 */

import { hostCompletion } from './llm.js'
import { hostSelection } from './services.js'
import type { HostCompletion, HostContext } from './llm.js'
import { systemClock, type Clock, type TimerHandle } from '../../ports/clock.js'
import type { CompletePort, CompleteRequest, CompleteResult } from '../../app/inbound/presence-flow.js'

/** 一次判断想要的推理档位（判断任务不需要深推理；模型没声明该档位时适配层不传）。 */
const PREFERRED_EFFORT = 'low'

/** 没显式给超时时的兜底（配置里的 `presence.judgeTimeoutMs` 优先）。 */
const DEFAULT_TIMEOUT_MS = 25_000

export interface HostCompleteDeps {
  /** 惰性取宿主上下文（装配侧传 `host.bridge.tagContext()`）；取不到 = 这一轮不判断。 */
  readonly context: () => HostContext | undefined
  readonly log: (line: string) => void
  /** 注入时钟（超时竞速）。缺省用系统时钟。 */
  readonly clock?: Clock
  /** 默认会话 id（请求里没给时用；默认 `presence-judge-<pid>`）。 */
  readonly sessionId?: () => string
}

/** 一次调用准备就绪之后的全部输入。 */
interface PreparedCall {
  readonly context: HostContext
  readonly selection: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }
  readonly prompt: string
  readonly maxTokens: number
  readonly timeoutMs: number
  readonly sessionId: string
  readonly preferredEffort: string
}

/** 一次尝试的观测（穷尽三档：拿到了 / 抛了 / 超时了）。 */
type Attempt =
  | { readonly kind: 'completion'; readonly value: HostCompletion }
  | { readonly kind: 'threw'; readonly detail: string }
  | { readonly kind: 'timeout' }

/**
 * 造一个纯补全端口。
 *
 * **不在这里做预算/退避**：那是 `core/presence.ts` 的 `failures` 与 `pauseUntilMs` 的事。
 * 这里只回答"这一次调用拿到了什么"，因为两套账叠在一起时，诊断里永远看不到真正的原因。
 */
export function createHostComplete(deps: HostCompleteDeps): CompletePort {
  const clock = deps.clock ?? systemClock
  return {
    async complete(request: CompleteRequest): Promise<CompleteResult> {
      // ① 准备阶段：一次模型调用都还没发生，失败不算"花过钱"。
      const ready = prepare(deps, request)
      if (ready.kind === 'stop') return ready.result
      // ② 跨过这条线之后才可能真花钱：抛错/超时都算这一次判断失败。
      const attempt = await attemptOnce({ ...ready.prepared, clock, log: deps.log })
      return classify(attempt, ready.prepared.selection, deps.log)
    },
  }
}

/** 准备一次调用（取上下文 / 选型 / 补齐默认值）；任何抛错都收敛成 `failed`。 */
function prepare(
  deps: HostCompleteDeps,
  request: CompleteRequest,
): { kind: 'ready'; prepared: PreparedCall } | { kind: 'stop'; result: CompleteResult } {
  try {
    const context = deps.context()
    if (context === undefined) {
      deps.log('presence: 没有宿主上下文，这一轮兴趣判断跳过（不算模型失败）')
      return { kind: 'stop', result: { kind: 'no-route', detail: '没有宿主上下文' } }
    }
    const selection = hostSelection(context)
    if (selection === undefined) {
      deps.log('presence: 宿主没有可用的模型路由，这一轮不判断')
      return { kind: 'stop', result: { kind: 'no-route', detail: '宿主没有可用的模型路由' } }
    }
    return {
      kind: 'ready',
      prepared: {
        context,
        selection,
        prompt: request.prompt,
        maxTokens: Math.max(1, Math.trunc(request.maxTokens)),
        timeoutMs: Number.isFinite(request.timeoutMs) ? request.timeoutMs : DEFAULT_TIMEOUT_MS,
        sessionId: request.sessionId ?? (deps.sessionId?.() ?? `presence-judge-${String(process.pid)}`),
        preferredEffort: request.preferredEffort ?? PREFERRED_EFFORT,
      },
    }
  } catch (error) {
    return { kind: 'stop', result: { kind: 'failed', detail: `prepare:${describe(error)}` } }
  }
}

/** 跑**一次**补全，超时用注入时钟竞速（**绝不抛**）。 */
async function attemptOnce(input: PreparedCall & { clock: Clock; log: (line: string) => void }): Promise<Attempt> {
  const controller = new AbortController()
  const handle: { timer: TimerHandle | null } = { timer: null }
  const work = hostCompletion(input.context, {
    selection: input.selection,
    prompt: input.prompt,
    maxTokens: input.maxTokens,
    sessionId: input.sessionId,
    preferredEffort: input.preferredEffort,
    signal: controller.signal,
  }).then(
    (value): Attempt => ({ kind: 'completion', value }),
    (error: unknown): Attempt => ({ kind: 'threw', detail: describe(error) }),
  )
  if (!(input.timeoutMs > 0)) return await work
  const timeout = new Promise<Attempt>((resolve) => {
    handle.timer = input.clock.setTimeout(() => {
      // 中止 + 立刻以 `timeout` 结算：收流的循环在下个块边界看到 signal 就放弃。
      controller.abort(new Error('presence judge timeout'))
      input.log(`presence: 兴趣判断超时（${String(input.timeoutMs)}ms），这一轮当作沉默`)
      resolve({ kind: 'timeout' })
    }, input.timeoutMs)
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    handle.timer?.cancel()
  }
}

/**
 * 把"这一次到底发生了什么"翻译成端口结果（穷尽、分档）。
 *
 * | 观测 | 结果 |
 * |---|---|
 * | 超时 | `timeout` |
 * | 流里抛错 | `failed`（`stream-error`） |
 * | 没有路由（`routed=false`，一个 token 都没花） | `no-route` |
 * | 有路由但派发前被拒 | `failed`（`not-dispatched`） |
 * | `finish=error/aborted` 或带失败码 | `failed`（`provider-error`） |
 * | 正常收尾但正文为空 | `failed`（`empty-reply`，多半是推理烧光了预算） |
 * | 有正文 | `text`（截断与否交给解析层：坏 JSON 会被判成沉默） |
 */
function classify(
  attempt: Attempt,
  selection: PreparedCall['selection'],
  log: (line: string) => void,
): CompleteResult {
  const route = `${selection.provider}/${selection.model}`
  if (attempt.kind === 'timeout') return { kind: 'timeout' }
  if (attempt.kind === 'threw') {
    log(`presence: 判断调用抛错（${attempt.detail}）`)
    return { kind: 'failed', detail: `stream-error:${attempt.detail}` }
  }
  const completion = attempt.value
  const code = completion.failureCode ?? '-'
  if (!completion.routed) {
    log(`presence: 宿主没有可用的模型路由（route=${route} code=${code}）`)
    return { kind: 'no-route', detail: `route=${route} code=${code}` }
  }
  if (!completion.dispatched) {
    log(`presence: 判断准备阶段被宿主拒绝，未发起生成（route=${route} code=${code}）`)
    return { kind: 'failed', detail: `not-dispatched:${code}: ${completion.failureMessage ?? '未知原因'}` }
  }
  if (completion.finishKind === 'error' || completion.finishKind === 'aborted' || completion.failureCode !== null) {
    const detail = `provider-error:${code}: ${completion.failureMessage ?? '未知失败'}`
      + `（finish=${completion.finishKind} route=${route}）`
    log(`presence: 判断调用失败（${detail}）`)
    return { kind: 'failed', detail }
  }
  if (completion.text.trim() === '') {
    const detail = `empty-reply: finish=${completion.finishKind} reasoningChars=${String(completion.reasoningChars)}`
      + ` route=${route}`
    log(`presence: 判断没有可见正文（${detail}）`)
    return { kind: 'failed', detail }
  }
  return { kind: 'text', text: completion.text }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
