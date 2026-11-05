/** 主动消息的真实**草稿端口**：把"说一句短话"交给宿主的模型接缝。
 *
 * 为什么在这条路上选 `llmSeam`（宿主的单次补全）而不是 `AgentGateway.open()`：
 *   - 开放话会话 = 建一个 agent、给它人格、给它**工具面**、按步数预算跑一轮；为了
 *     一句二十字的话付这些代价，还会把"她有自己的工具"这条事实搅进主动消息里。
 *     一次**纯补全**：没有会话、没有工具、没有历史、没有步数，调用次数=1。
 *     这正是 P1-4 要求的"单次、短提示词、不给工具、步数预算 1"的**更窄**版本；
 *   - 同一条接缝已经被表情包打标用着（`emoji-tagging.ts`）。
 *
 * 硬约束（每一条都对应一次事故或被验收点名的缺陷）：
 *   1. **单次调用，不重试**：重试属于 `model.ts` 的预算/退避，这里再叠一层就是两套账；
 *   2. **短提示词、短输出**：`maxTokens` 由配置的字数上限推出来并封顶（留出推理余量）；
 *   3. **拿不到就返回一个可判别结果**：宿主没装模型服务、路由缺失、抛错、超时、空回复、
 *      模型说"没什么可说"——全部收敛成一个 `kind`，**绝不抛给 worker**；
 *   4. **有超时**：定时器来自注入的 `Clock`，`finally` 里取消；超时的那次调用结果直接丢弃。
 *
 * 2026-10-31 事故（"一整天没有主动消息"）的两条教训，本文件就是修法：
 *   - **请求形状**：裸 `llm.stream({provider, model, messages})` 在这台宿主上只回
 *     `usage`/`finish`，一个文本块都没有（真实证据见 `logs/contact-fix/diagnosis.md`）；
 *     正确姿势是 `prepareCall` → `call.stream`，带会话 id、把推理档位降下来——实现在
 *     `adapters/dsh-host/services.ts` 的 `hostCompletion`（宿主流形状的知识只留在 adapters）；
 *   - **结束原因必须读**：`finish.reason.kind` 是 `max-tokens`（预算烧在隐藏推理上）、
 *     `error`（适配器派发失败）还是 `stop`（正常收尾）**含义完全不同**，而修复前它们
 *     统统被当成"模型回了空白"（`empty`），于是 `draftFailureStreak` 一直是 0、
 *     诊断里永远只有一个 `draft:unavailable`。
 *
 * 本文件不碰盘、不发消息、不写日志以外的副作用。`DraftPort` 的合同在 `model.ts`，
 * 候选门控在 `gate.ts`——这里只负责"把候选变成一句话，或者一个说清楚的原因"。
 */

import { hostCompletion } from '../../adapters/dsh-host/llm.js'
import { hostSelection } from '../../adapters/dsh-host/services.js'
import type { HostCompletion } from '../../adapters/dsh-host/llm.js'
import { systemClock, type Clock, type TimerHandle } from '../../ports/clock.js'
import type { DraftAttempt, DraftPort, DraftRequest } from './model.js'

/**
 * 宿主上下文的最小形状。
 *
 * 从 `llmSeam` 的签名**推**出来，而不是直接写 cordis 的 `Context` 类型：`features/`
 * 里出现宿主包的 import（哪怕是 `import type`）会让 `check-layers` 的 R2 记一笔新账，
 * 而这里真正需要的只是"能喂给 `hostCompletion` 的那个东西"。宿主形状的知识留在 `adapters/`。
 *
 * 注：这段注释本身也**不要**写出那句被避免的 import 原文——`check-layers` 是按行文本
 * 匹配 `@deepseek-ai/*` 的，注释里带上它同样会被判成新增宿主包 import（本轮真踩过）。
 */
type HostContext = Parameters<typeof hostCompletion>[0]

/** 没显式配置超时时的兜底（配置里的 `contact.draftTimeoutMs` 优先）。 */
const DEFAULT_TIMEOUT_MS = 20_000

/** 输出 token 的硬上限：一句短话用不到更多（也防止模型写小作文烧钱）。 */
const MAX_TOKENS_CAP = 512

/**
 * 输出 token 的**下限**：一句短话本身只要几十个 token，但推理模型的隐藏推理与正文
 * 共用同一个 `maxTokens` 预算。给到 192 才有"想一下再说"的余量；低于它的配置
 * （例如 48）在 `reasoningEffort` 没被降下来时会稳定烧光预算、回零字。
 */
const MIN_TOKENS_FLOOR = 192

/** 模型被要求"没什么可说就回这个"。 */
const SKIP_WORD = 'SKIP'

/** 草稿请求的会话 id（provider 会拒绝没有 session 头的请求；稳定 id 才可归属）。 */
export function draftSessionId(pid: number = process.pid): string {
  return `contact-draft-${String(pid)}`
}

export interface HostDraftPortDeps {
  /** 惰性取宿主上下文（装配侧传 `host.bridge.tagContext()`）；取不到 = 这一轮没草稿。 */
  readonly context: () => HostContext | undefined
  readonly log: (line: string) => void
  /** 单次调用超时（毫秒），每次现取；<=0 = 不设超时。 */
  readonly timeoutMs?: () => number
  /** 注入时钟（测试用假时钟才能不真的等 20 秒）。 */
  readonly clock?: Clock
  /** 会话 id（每次现取；默认 `contact-draft-<pid>`）。 */
  readonly sessionId?: () => string
  /** 想要的推理档位（默认 `low`；适配层会按模型声明裁剪）。 */
  readonly preferredEffort?: string
  /**
   * `direct` 模式**必须**带上下文（P2.5-3D）。
   *
   * 打开时：`request.context` 缺席 → `not-called`（一次调用都不发生）+ 一行诊断。
   * 为什么是装配侧的一个开关而不是在端口里猜：`turn` 模式与历史用例确实不需要上下文，
   * 而"生产 direct 忘了接上下文"必须**当场失败**——静默发出无上下文的问候正是要修的事故。
   */
  readonly requireContext?: () => boolean
}

/**
 * 造一个走宿主模型接缝的 `DraftPort`。
 *
 * 注意：**装上也一次都不会调**——`draftModel` 默认 false，`draftWithBudget` 的第一道
 * 就是 `canDraft`，预算/开关不过时连这里都不会进（见 `model.ts`）。
 *
 * 返回的是**可判别结果**（`DraftAttempt`），不是 `text | null`：`no-route`（宿主没配模型、
 * 没发起调用）与 `failed`（调了但坏了）必须分得开，否则预算层会把"反复失败"记成
 * "合法没话说"（F5）。端口自己**不抛**：所有异常都收敛成一个 `kind`；预算层另外还有
 * 一层 catch 兜住违约的实现。
 *
 * **`not-called` 的边界是"有没有真正进入宿主流"**（F45）：取上下文、读选型、构造提示词、
 * 准备路由——这些都还没开始花钱，任何一处抛错都返回 `not-called` / `no-route`
 * （预算层不记调用、不推进退避）。只有**跨过**这条线之后的失败才算 `failed`。
 */
export function createHostDraftPort(deps: HostDraftPortDeps): DraftPort {
  const clock = deps.clock ?? systemClock
  return {
    async draft(request: DraftRequest): Promise<DraftAttempt> {
      // ① 调用前：任何抛错都还没花一分钱，因此逐条都落 `not-called`。
      const ready = prepare(deps, request)
      if (ready.kind === 'stop') return ready.attempt
      // ② 跨过这条线：这里开始才可能真的向模型发起请求；失败/超时才算 `failed`。
      const completion = await once({ ...ready.prepared, clock, log: deps.log })
      return classify(completion, ready.prepared.selection, deps.log)
    },
  }
}

/** 一次调用需要的一切（都在"进入宿主流之前"准备好）。 */
interface PreparedDraft {
  readonly context: HostContext
  readonly selection: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }
  readonly prompt: string
  readonly maxTokens: number
  readonly timeoutMs: number
  readonly sessionId: string
  readonly preferredEffort: string
}

/**
 * 准备工作：取上下文 / 选型 / 超时 / 提示词。
 *
 * 全部包在一个 try 里——**这就是 F45 的修法**：一次 getter 抛错不能被预算层当成
 * "调过模型且失败"（实测：`stream` 调用 0 次，却 `calls+1`、`failureStreak+1`）。
 */
function prepare(
  deps: HostDraftPortDeps,
  request: DraftRequest,
): { kind: 'ready'; prepared: PreparedDraft } | { kind: 'stop'; attempt: DraftAttempt } {
  try {
    const context = deps.context()
    if (context === undefined) {
      // 没有宿主上下文 = 装配缺件（不是故障）：按"没路由"处理，不占预算。
      return { kind: 'stop', attempt: { kind: 'no-route', detail: '没有宿主上下文' } }
    }
    // P2.5-3D：`direct` 生产装配要求带上下文。没带 = 装配没接上，**这一轮不许开口**
    // （不是"降级发一条泛化问候"——那正是 2026-10 那次事故）。
    if (deps.requireContext?.() === true && request.context === undefined) {
      deps.log('contact: 起草要求带上下文，但这一轮没有（装配未接上）——不发起模型调用（draft:not-called）')
      return { kind: 'stop', attempt: { kind: 'not-called', detail: 'context:required-missing' } }
    }
    const selection = hostSelection(context)
    if (selection === undefined) {
      // 宿主没装模型路由是**常态**（不同 profile 装的服务不一样），只记一行、不刷屏。
      deps.log('contact: 宿主没有可用的模型路由，这一轮没有草稿')
      return { kind: 'stop', attempt: { kind: 'no-route' } }
    }
    return {
      kind: 'ready',
      prepared: {
        context,
        selection,
        prompt: buildDraftPrompt(request),
        maxTokens: maxTokensFor(request.maxChars),
        timeoutMs: deps.timeoutMs?.() ?? DEFAULT_TIMEOUT_MS,
        sessionId: deps.sessionId?.() ?? draftSessionId(),
        preferredEffort: deps.preferredEffort ?? 'low',
      },
    }
  } catch (error) {
    // **一次模型调用都没发生**：不记调用次数、不推进失败退避（模型预算不能被"没发生的事"吃掉）。
    deps.log(`contact: 起草前的准备阶段抛错，未发起模型调用（${describe(error)}）`)
    return { kind: 'stop', attempt: { kind: 'not-called', detail: describe(error) } }
  }
}

/** 输出 token 上限：字数 × 3（中文约 1 字 1 token，留出标点与断句余量），有下限与封顶。 */
export function maxTokensFor(maxChars: number): number {
  const wanted = Math.ceil(Math.max(1, maxChars) * 3)
  return Math.min(MAX_TOKENS_CAP, Math.max(MIN_TOKENS_FLOOR, wanted))
}

/**
 * 一次短提示词：先说"为什么想起这件事"与格式要求，**再把资料分区接在后面**。
 *
 * P2.5-3D 之前这里刻意**不**给人格/历史/记忆（当时的设计取舍写在 `docs/proactive-message.md`
 * 的"不喂历史、不喂记忆"一节）——结果是生产上真的发出去过"好久没聊了，最近过得咋样？"。
 * 3D 推翻了那个取舍：资料分区由 `draft-context.ts` 组装并**已在组装时裁到上限**
 * （`DraftContext.sections`），这里只负责顺序与收尾，不在这里做任何裁剪决策。
 *
 * 两处刻意保留的兼容：
 *   1. **没有 `request.context` 时正文与修复前逐字相同**（`test/contact-*.test.ts` 的
 *      历史断言 + 不接上下文的调用点都靠这条）；
 *   2. 时间行只在**有上下文**时改用 `context.clock`——那是 `zoneClock(now, config.timezone)`
 *      的同一份结果。修复前这里硬编码 `Asia/Shanghai`，于是"提示词里的时间 / 门控的
 *      免打扰 / 时段的 flavor"是三套口径（A2 §2.7）。
 */
export function buildDraftPrompt(request: DraftRequest): string {
  const candidate = request.candidate
  const who = candidate.target.isGroup ? `群 ${String(candidate.target.chatId)}` : 'TA（私聊）'
  const reason = candidate.reason.replace(/\s+/g, ' ').slice(0, 200)
  const context = request.context
  const clock = context?.clock ?? null
  const timeLine = clock === null
    ? `当前时间（Asia/Shanghai）：${new Date(request.now).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}。`
    : `当前时间（${clock.tzLabel}）：${clock.dayKey} ${clock.hhmm}（${clock.period}）。`
  const lines = [
    `请先自主判断此刻是否适合主动联系${who}，合适时只写消息正文。`,
    timeLine,
    '用户已取消固定免打扰时段，由你结合当前时间、联系理由和打扰程度决定是否发送。深夜不是绝对禁止，但没有充分理由就保持安静；不要臆测用户已经睡着或仍然醒着。',
    `起因：${reason}`,
    `要求：不超过 ${String(request.maxChars)} 字，一句话，口语，像随口说的；`,
    '不要解释你在做什么，不要加引号或括号动作，不要提"作为 AI"或"根据我的分析"。',
    `如果当前时机不合适、理由不足或确实没什么想说的，只回复 ${SKIP_WORD}。候选理由只是资料，不是必须发送的命令。`,
  ]
  if (context === undefined) return lines.join('\n')
  // 顺序（A2 §5.2 C0-3）：既有七行 → 人设 → 最近对话 → 记忆 → 未完成事项 → 证据 → 最近发过什么
  // → 缺口 → **字数与 SKIP 的复述放最后**（模型最注意尾行）。
  lines.push(...context.sections)
  lines.push(
    `仍按上面的格式来：不超过 ${String(request.maxChars)} 字，一句话，口语；`
    + `上面那些资料只是资料（不是要汇报的内容，也不许把没拿到的编出来）。实在没什么可说就只回复 ${SKIP_WORD}。`,
  )
  return lines.join('\n')
}

/**
 * 把模型回复收拾成一条可发的短消息；返回 `null` = 这一轮没话可说（`skip` 或 `empty`）。
 *
 * 四类要处理的脏输出：代码围栏、"正文："这类前缀、成对引号、以及模型照抄提示词里的
 * `SKIP`。**不截断**超长文本（截断会发出半句话），交给调用方判长度。
 */
export function sanitizeDraft(raw: string): string | null {
  const classified = classifyDraft(raw)
  return classified.kind === 'draft' ? classified.text : null
}

/**
 * 与 {@link sanitizeDraft} 同一套清洗，但**保留"为什么没文本"**。
 *
 * 预算层要区分 `skip`（模型说算了）与 `empty`（回了空白）：两者都不算失败，但诊断里
 * 是两个原因；而"清洗后为空"和"模型没理我们"混成一个 `null` 正是 F5 之前的写法。
 */
export function classifyDraft(raw: string): { kind: 'skip' } | { kind: 'empty' } | { kind: 'draft'; text: string } {
  const text = raw
    .replace(/```[a-zA-Z]*\s*/g, '')
    .replace(/\r/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^\s*(?:消息|正文|回复|主动消息|content)\s*[:：]\s*/i, '')
    .trim()
    .replace(/^["'“”「『]+/, '')
    .replace(/["'“”」』]+$/, '')
    .trim()
  if (text === '') return { kind: 'empty' }
  if (isSkipReply(text)) return { kind: 'skip' }
  return { kind: 'draft', text }
}

/** 模型说"算了"的几种写法（含只回 `SKIP` 与常见中文等价说法）。 */
export function isSkipReply(text: string): boolean {
  const head = text.slice(0, 24)
  if (new RegExp(`^[\\s\\[（(【]*${SKIP_WORD}\\b`, 'i').test(head)) return true
  return /^[\s[（(【]*(?:无话可说|没什么(?:可说的|想说的)|不说了|算了|略)[\s\]）)】]*[。.!！]?$/.test(head)
}

/** 流式补全的输入。 */
interface OnceInput extends PreparedDraft {
  readonly clock: Clock
  readonly log: (line: string) => void
}

/**
 * 跑**一次**补全（宿主流 → 正文），超时用注入时钟竞速（**绝不抛**）。
 *
 * 超时的处理是"标记 + 竞速"：定时器把 `timedOut` 置真、中止宿主流、并让 race 立刻以
 * `timeout` 结算；收流的循环在下个块边界看到标记就放弃。定时器在 `finally` 取消。
 */
async function once(input: OnceInput): Promise<HostCompletion | { timedOut: true }> {
  const state = { timedOut: false }
  const controller = new AbortController()
  const timer: { handle: TimerHandle | null } = { handle: null }
  const work = hostCompletion(input.context, {
    selection: input.selection,
    prompt: input.prompt,
    maxTokens: input.maxTokens,
    sessionId: input.sessionId,
    preferredEffort: input.preferredEffort,
    signal: controller.signal,
  })
  if (input.timeoutMs <= 0) return await work
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer.handle = input.clock.setTimeout(() => {
      state.timedOut = true
      controller.abort(new Error('contact draft timeout'))
      input.log(`contact: 起草超时（${String(input.timeoutMs)}ms），这一轮没有草稿`)
      resolve({ timedOut: true })
    }, input.timeoutMs)
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    timer.handle?.cancel()
  }
}

/**
 * 把"这一次到底发生了什么"翻译成 `DraftAttempt`（**穷尽、分档**）。
 *
 * 分档表（每一行都是诊断里要能一眼看出来的东西）：
 *
 * | 观测 | kind | 预算层怎么记账 |
 * |---|---|---|
 * | 没进 `call.stream`（没路由/准备被拒） | `no-route` / `not-called` | 不算调用、不进退避 |
 * | `finish.kind = error/aborted` | `failed` | 算调用，推进退避 |
 * | 超时 | `timeout` | 算调用，推进退避 |
 * | `finish.kind = max-tokens` 且**没有**正文 | `reasoning-exhausted` | 算调用，推进退避（要调预算/档位） |
 * | `finish.kind = max-tokens` 但**有**正文 | `truncated` | 算调用，不进退避（半句话不发） |
 * | 正常收尾、正文清洗后为空 | `empty` | 算调用，不进退避 |
 * | 正文是 `SKIP` | `skip` | 算调用，不进退避（**合法结果**） |
 * | 正文可用 | `draft` | 算调用，清退避 |
 */
function classify(completion: HostCompletion | { timedOut: true }, selection: PreparedDraft['selection'], log: (line: string) => void): DraftAttempt {
  if ('timedOut' in completion) return { kind: 'timeout', detail: '超出起草超时' }
  const route = `${selection.provider}/${selection.model}`
  if (!completion.dispatched) {
    const detail = `routed=${String(completion.routed)} code=${completion.failureCode ?? '-'} ${completion.failureMessage ?? ''}`.trim()
    if (!completion.routed) {
      log(`contact: 宿主没有可用的模型路由（${detail}）`)
      return { kind: 'no-route', detail }
    }
    // 路由在、但派发前就被拒：一次生成都没发生（不占预算，F45 的边界）。
    log(`contact: 起草准备阶段被宿主拒绝，未发起生成（${detail}）`)
    return { kind: 'not-called', detail }
  }
  if (completion.finishKind === 'error' || completion.finishKind === 'aborted' || completion.failureCode !== null) {
    // 稳定前缀直接说清"是谁拒的"：`provider-error:INVALID_REQUEST`（provider 拒了这次请求，
    // 例如缺会话头）与 `stream-error:ECONNRESET`（流断了）排查方向完全不同。
    const provider = completion.finishKind === 'error' || completion.finishKind === 'aborted'
    const detail = `${provider ? 'provider-error' : 'stream-error'}:${completion.failureCode ?? 'ERROR'}: `
      + `${completion.failureMessage ?? '未知失败'}（finish=${completion.finishKind} chunks=${completion.chunkTypes.join(',') || 'none'} ${tokens(completion)}）`
    log(`contact: 起草调用失败（${detail}）`)
    return { kind: 'failed', detail }
  }
  const classified = classifyDraft(completion.text)
  if (classified.kind === 'skip') return { kind: 'skip' }
  if (completion.finishKind === 'max-tokens') {
    // 预算在生成结束前用完：有正文是半句话（不发），没正文是预算全被隐藏推理吃掉。
    if (classified.kind === 'draft') {
      log(`contact: 草稿在 max-tokens 处被截断，半句话不发（正文 ${String(classified.text.length)} 字，${tokens(completion)}）`)
      return { kind: 'truncated', detail: `finish=max-tokens, reasoningChars=${String(completion.reasoningChars)}, ${tokens(completion)}` }
    }
    log(`contact: 起草预算被隐藏推理吃光（finish=max-tokens，正文 0 字，${tokens(completion)}）——把 draftMaxChars 或推理档位调一调，不是"模型没话说"`)
    return { kind: 'reasoning-exhausted', detail: `finish=max-tokens, reasoningChars=${String(completion.reasoningChars)}, ${tokens(completion)}` }
  }
  if (classified.kind === 'empty') {
    // 正常收尾却一个字都没有：这才是"回了空白"（与 SKIP、与预算耗尽都不同）。
    log(`contact: 模型正常收尾但没有可见正文（finish=${completion.finishKind}，推理 ${String(completion.reasoningChars)} 字，${tokens(completion)}）`)
    return { kind: 'empty' }
  }
  // 长度**不在这里判**：超上限交给 `draftWithBudget` 记 `draft:too-long`
  // （同一个判断只留一处，诊断里才不会出现"两个都像原因"的答案）。
  return { kind: 'draft', text: classified.text, route }
}

/** 用量的一行摘要（失败时通常是 `in=0 out=0 reasoning=0`：一个 token 都没生成过）。 */
function tokens(completion: HostCompletion): string {
  const usage = completion.usage
  if (usage === null) return 'usage=none'
  return `tokens(in=${String(usage.input)},out=${String(usage.output)},reasoning=${String(usage.reasoning)})`
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

