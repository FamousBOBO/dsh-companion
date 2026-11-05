/** 主动消息的草稿**预算与记账**：**唯一会花模型钱的地方**。
 *
 * 为什么与门控分家：门控（`gate.ts`）判"该不该说"，这里只判"能不能起草、花了几次"。
 * 两者的失败代价完全不同——门控判错会发错消息，起草失败只是这一轮没话说，
 * 所以这里的每一条失败路径都必须是**软的**：返回 `none`、记一笔预算、退避一会儿，
 * 绝不让日程/回合/记忆路径跟着卡住。模型离线时主动消息停摆是正常现象，
 * 不是一个需要重试到天亮的故障。
 *
 * 端口合同与稳定原因词表在 `draft-outcome.ts`（契约），本文件只做策略：额度、退避、超时。
 *
 * 四条硬规矩：
 *   1. **先问预算再调用**（`canDraft`）：草稿预算是共享额度（每日 + 每小时突发），
 *      空转不消耗，被门控抑制的候选也不消耗；
 *   2. **失败有界退避**（`backoffMs`）：指数增长但有上限，连续失败到阈值就停手，
 *      等跨日（计数归零）或人工干预——不无限重试；
 *   3. **超时即失败**（`draftWithBudget` 里的 race）：模型卡住时宁可这一轮没话说，
 *      也不能把 worker 的节拍拖住；
 *   4. **记账按"有没有真的调过模型"分档**（F5）：端口返回的是**可判别结果**
 *      （`DraftAttempt`），于是"调用坏了"（`failed`/`timeout`/`reasoning-exhausted`）、
 *      "调了但没话说"（`skip`/`empty`/`too-long`/`truncated`）与"根本没发起调用"
 *      （`no-route`/`not-called`/`no-port`）是三本账：前两者计入调用次数与小时环，
 *      只有前者推进失败退避；后者什么都不记。在 F5 之前这三者都收敛成 `null`，
 *      被当成"合法没话说"→ 清零退避、且不进小时环，结果是**反复调用一个坏掉的模型**
 *      （Codex 第二轮实测）。
 *
 * 本文件不碰平台、不碰盘：`DraftPort` 由装配方注入（真实现走宿主模型路由，
 * 测试注入假端口），计数由调用方传入并接收更新后的副本。
 */

import { systemClock, type Clock, type TimerHandle } from '../../ports/clock.js'
import type { ContactConfig } from '../../config/sections/contact.js'
import type { ContactCandidate, ContactCounters } from './types.js'
import type { DraftContext } from './draft-context.js'
import type {
  DraftAttempt,
  DraftBudget,
  DraftOutcome,
  DraftPort,
  DraftReason,
  DraftRequest,
} from './draft-outcome.js'

// 词表与端口合同搬到了 `draft-outcome.ts`（契约与策略分开改）。这里再导出一次，
// 于是既有 import 点（`attempt.ts` / `worker.ts` / 测试）不需要跟着挪。
export { DRAFT_REASONS } from './draft-outcome.js'
export type { DraftAttempt, DraftBudget, DraftOutcome, DraftPort, DraftReason, DraftRequest } from './draft-outcome.js'

/**
 * 现在允许起草吗（只看预算与退避，**不看**候选门控）。
 *
 * @param counters 当前计数（`draftCallsToday` / `draftFailureStreak` / `lastDraftFailureAt`）
 * @param config 配置（`draftModel` / `draftDailyBudget` / `draftHourlyBudget` / 退避参数）
 * @param window 选择给出时同时检查"每小时突发"：`recentCalls` 是最近若干次调用的
 *   时刻（毫秒），由调用方维护一个内存环。不给就只查每日——每日那条是持久化的，
 *   重启不会忘；每小时那条只是防抖，重启后从零开始是可以接受的。
 */
export function canDraft(
  counters: ContactCounters,
  config: ContactConfig,
  window?: { readonly now: number; readonly recentCalls: readonly number[] },
): DraftBudget {
  if (!config.draftModel) return { allowed: false, reason: 'disabled' }
  if (counters.draftCallsToday >= config.draftDailyBudget) return { allowed: false, reason: 'budget:daily' }
  if (counters.draftFailureStreak >= config.draftMaxFailures) return { allowed: false, reason: 'backoff:streak' }
  if (window !== undefined) {
    if (window.recentCalls.length >= config.draftHourlyBudget) return { allowed: false, reason: 'budget:hourly' }
    const last = counters.lastDraftFailureAt
    if (last !== null && window.now - last < backoffMs(counters.draftFailureStreak, config.draftFailureBackoffMs)) {
      return { allowed: false, reason: 'backoff:draft' }
    }
  }
  return { allowed: true, reason: 'ok' }
}

/**
 * 失败退避时长：`base × 2^(streak-1)`，上限 8 倍（有界）。
 *
 * `streak = 0`（没失败过）返回 0——调用方因此不需要在"没有失败"时特判。
 * 上限是必须的：没有上限的指数退避在 streak 到 20 时等于永久停手，
 * 而那时的正确做法是"停手并说明原因"，不是让一个数字悄悄变成无穷大。
 */
export function backoffMs(streak: number, baseMs: number): number {
  if (streak <= 0 || baseMs <= 0) return 0
  const factor = 2 ** Math.min(streak - 1, 3)
  return baseMs * factor
}

/**
 * 起草**成功**后更新计数：调用次数 +1，并清掉失败退避。
 *
 * 清理是必要的：一次失败留下的等待会一直压在后面每一次起草上；只有真正拿到草稿才
 * 能证明"那条路又通了"。
 */
export function noteDraftSuccess(counters: ContactCounters, now: number): ContactCounters {
  return {
    ...counters,
    draftCallsToday: counters.draftCallsToday + 1,
    lastDraftFailureAt: null,
    draftFailureStreak: 0,
  }
}

/**
 * 起草**调过模型但没拿到草稿**（`skip` / `empty` / `too-long` / `truncated`）后更新计数。
 *
 * 只记调用次数：钱花了，小时/日预算必须看到；但**不动失败退避**——"她想了想，觉得
 * 现在没什么可说"不是故障，把它记成失败会让一次正常的沉默把后面十分钟的尝试全部拖住。
 */
export function noteDraftCall(counters: ContactCounters): ContactCounters {
  return { ...counters, draftCallsToday: counters.draftCallsToday + 1 }
}

/** 起草**失败**（抛错/超时/预算被推理吃光）后更新计数：调用次数 +1，退避起点与连续失败数一起前进。 */
export function noteDraftFailure(counters: ContactCounters, now: number): ContactCounters {
  return {
    ...counters,
    draftCallsToday: counters.draftCallsToday + 1,
    lastDraftFailureAt: now,
    draftFailureStreak: counters.draftFailureStreak + 1,
  }
}

/** 只保留最近一小时内的调用时刻（每小时突发预算的数据源）。 */
export function pruneDraftCalls(calls: readonly number[], now: number, windowMs = 3_600_000): number[] {
  return calls.filter((at) => now - at < windowMs)
}

/** 一次起草尝试的输入。 */
export interface DraftRunInput {
  readonly candidate: ContactCandidate
  readonly config: ContactConfig
  readonly counters: ContactCounters
  readonly now: number
  /** 最近的起草时刻（本小时内），没有内存环就给空数组。 */
  readonly recentCalls: readonly number[]
  /**
   * 这一轮喂给模型的资料（P2.5-3D）。
   *
   * **只在门控放行之后**由 `attempt.ts` 组装并透传：空转的 tick、被门控挡住的候选、
   * `turn` 模式都不该读库，更不该调模型（H2 保持零模型调用的前提）。
   */
  readonly context?: DraftContext
}

/**
 * 在预算内起草一次。
 *
 * 顺序：预算（`canDraft`）→ 端口 → 超时 → 按端口给出的 `kind` 分档记账。
 * **预算不过就绝不调用端口**，这是"空转不调用模型"的最后一道保证。
 * 记账口径见 {@link consumeAttempt}（也就是 `docs/proactive-message.md` §12.2 的那张表）。
 */
export async function draftWithBudget(
  port: DraftPort | null,
  input: DraftRunInput,
  deps: { readonly clock?: Clock; readonly log?: (line: string) => void } = {},
): Promise<DraftOutcome> {
  const budget = canDraft(input.counters, input.config, { now: input.now, recentCalls: input.recentCalls })
  if (!budget.allowed) return { kind: 'none', reason: budget.reason, counters: input.counters, called: false }
  if (port === null) return { kind: 'none', reason: 'no-port', counters: input.counters, called: false }

  const clock = deps.clock ?? systemClock
  const request: DraftRequest = {
    candidate: input.candidate,
    maxChars: input.config.draftMaxChars,
    now: input.now,
    ...(input.context === undefined ? {} : { context: input.context }),
  }
  const attempt = await raceTimeout(port, request, input.config.draftTimeoutMs, clock)
  return consumeAttempt(attempt, input, deps.log)
}

/**
 * 把端口结果**穷尽地**翻译成预算动作（R6：漏一个分支就是编译错误）。
 *
 * | 尝试 | reason | `draftCallsToday` | 小时环 | 退避 |
 * |---|---|---|---|---|
 * | `draft`（未超长） | — | +1 | 记 | 清零 |
 * | `draft`（超长）/ `too-long` | `draft:too-long` | +1 | 记 | 不动 |
 * | `truncated`（max-tokens 撞断正文） | `draft:truncated` | +1 | 记 | 不动 |
 * | `skip` / `empty` | `draft:skip` / `draft:empty` | +1 | 记 | 不动 |
 * | `reasoning-exhausted`（推理吃光预算） | `draft:reasoning-exhausted` | +1 | 记 | +1 |
 * | `failed` / `timeout` | `draft:failed` / `draft:timeout` | +1 | 记 | +1 |
 * | `not-called` | `draft:not-called` | **不变** | 不记 | 不动 |
 * | `no-route` | `draft:no-route` | 不变 | 不记 | 不动 |
 *
 * `not-called` 与 `no-route` 都表示"模型调用根本没发生"：它们**不占模型预算**。
 * 装配/宿主问题靠日志与诊断暴露，不靠烧预算与退避掩盖。
 */
function consumeAttempt(
  attempt: DraftAttempt,
  input: DraftRunInput,
  log?: (line: string) => void,
): DraftOutcome {
  switch (attempt.kind) {
    case 'no-route':
      log?.('contact: 宿主没有可用的模型路由，这一轮没有草稿（draft:no-route）')
      return none('draft:no-route', input.counters, false)
    case 'not-called':
      // 一次模型调用都没发生（边界：有没有真正进入宿主流）：**不记调用、不记失败**，
      // 只留一条诊断。把它记成失败会让预算被"没发生的事"吃掉（R6/F45）。
      log?.(`contact: 起草前的准备阶段抛错，未发起模型调用（draft:not-called）：${attempt.detail}`)
      return none('draft:not-called', input.counters, false)
    case 'failed':
    case 'timeout': {
      const reason: DraftReason = attempt.kind === 'timeout' ? 'draft:timeout' : 'draft:failed'
      const detail = attempt.detail === undefined ? '' : `：${attempt.detail}`
      log?.(`contact: 起草失败（${attempt.kind}）${detail}`)
      return none(reason, noteDraftFailure(input.counters, input.now), true)
    }
    case 'reasoning-exhausted':
      // 预算被隐藏推理吃光：**这是配置问题**（档位太高 / maxTokens 太小），按失败记账。
      log?.(noteReasoningExhausted(attempt.detail))
      return none('draft:reasoning-exhausted', noteDraftFailure(input.counters, input.now), true)
    case 'truncated':
      return truncatedOutcome(input, attempt, log)
    case 'skip':
    case 'empty':
      // 调过模型、但它没给出可发的话：记调用次数，不动退避（"沉默"不是"故障"）。
      return none(attempt.kind === 'skip' ? 'draft:skip' : 'draft:empty', noteDraftCall(input.counters), true)
    case 'too-long':
      // 端口自己已经判定超长：**单独**消费成 too-long，不再往下猜成 empty/成功（R6）。
      return tooLongOutcome(input, attempt, log)
    case 'draft': {
      const text = attempt.text.trim()
      if (text === '') {
        // 端口说 draft 却没给文本：按"空白回复"处理，同样不动退避。
        return none('draft:empty', noteDraftCall(input.counters), true)
      }
      if ([...text].length > input.config.draftMaxChars) {
        // 不截断（半句话比不说更难看）：算一次调用，但不算失败。
        log?.(`contact: 草稿 ${String([...text].length)} 字超过上限 ${String(input.config.draftMaxChars)}，按"没话可说"处理`)
        return none('draft:too-long', noteDraftCall(input.counters), true)
      }
      return {
        kind: 'draft',
        draft: { text, route: attempt.route ?? '' },
        counters: noteDraftSuccess(input.counters, input.now),
        called: true,
      }
    }
    default:
      // 编译期穷尽性：新增一个 kind 而不处理它，这里会报错（运行时到不了）。
      assertNever(attempt)
      return none('draft:failed', input.counters, false)
  }
}

/** 造一个 `none` outcome（模板：少写几次重复的对象字面量）。 */
function none(reason: DraftReason, counters: ContactCounters, called: boolean): DraftOutcome {
  return { kind: 'none', reason, counters, called }
}

/** 半句话不发（`truncated`）：算一次调用，但**不**推进失败退避——模型没坏，只是超了预算。 */
function truncatedOutcome(input: DraftRunInput, attempt: { readonly detail?: string }, log?: (line: string) => void): DraftOutcome {
  log?.(`contact: 草稿在 max-tokens 处被截断，按"没话可说"处理：${attempt.detail ?? '(无细节)'}`)
  return none('draft:truncated', noteDraftCall(input.counters), true)
}

/** 端口自己判定的超长：单独的稳定词，不再往下猜成 empty/成功（R6）。 */
function tooLongOutcome(input: DraftRunInput, attempt: { readonly detail?: string }, log?: (line: string) => void): DraftOutcome {
  log?.(`contact: 端口判定的草稿超长，按"没话可说"处理：${attempt.detail ?? '(无细节)'}`)
  return none('draft:too-long', noteDraftCall(input.counters), true)
}

/**
 * `reasoning-exhausted` 的诊断行（长文案搬出 `consumeAttempt`：那里的行数预算留给分支）。
 *
 * 说清两件事：**不是模型没话说**，以及**下一步该动哪个配置**。只写"没有草稿"会让下一个人
 * 沿着"模型故障"的方向查很久（2026-10-31 就是这样查了一个下午）。
 */
function noteReasoningExhausted(detail: string | undefined): string {
  return 'contact: 起草预算被隐藏推理吃光，零可见正文（draft:reasoning-exhausted）'
    + `${detail === undefined ? '' : `：${detail}`}`
    + '——把推理档位调低或把 draftMaxChars 调大；用同一份配置重试不会有不同结果'
}

/** 编译期穷尽性检查；运行时不会被执行。 */
function assertNever(_value: never): void {
  /* 什么都不做：存在的意义是让 TS 在漏分支时报错 */
}

/**
 * 带超时地跑一次端口调用。
 *
 * 超时用注入的 `Clock`（默认 `systemClock`），定时器在 `finally` 里取消——
 * 不取消的话，一个已经超时的请求会在 worker 卸载后仍然握着计时器。
 * `timeoutMs <= 0` = 不设超时（明确要"等到底"的部署才这么配）。
 *
 * 端口自己的 rejection 也在这里兜成 `failed`：端口合同要求"所有错误都变成一个
 * `kind`"，但**合同不该靠信任**——预算层是最后一道，漏出来的异常在这里被记成失败。
 */
async function raceTimeout(
  port: DraftPort,
  request: DraftRequest,
  timeoutMs: number,
  clock: Clock,
): Promise<DraftAttempt> {
  const work: Promise<DraftAttempt> = port.draft(request).then(
    (attempt): DraftAttempt => attempt ?? { kind: 'failed', detail: 'port returned nothing' },
    (error: unknown): DraftAttempt => ({
      kind: 'failed',
      detail: error instanceof Error ? error.message : String(error),
    }),
  )
  if (timeoutMs <= 0) return await work
  // 句柄放在对象里：TS 的控制流分析看不见"在 Promise 执行器里赋值"，直接写
  // `let handle: X | null` 会让读点被收窄成 `null`（然后是 `never`）。
  const holder: { timer: TimerHandle | null } = { timer: null }
  const timer = new Promise<DraftAttempt>((resolve) => {
    holder.timer = clock.setTimeout(() => {
      resolve({ kind: 'timeout', detail: `超过 ${String(timeoutMs)}ms` })
    }, timeoutMs)
  })
  try {
    return await Promise.race([work, timer])
  } finally {
    holder.timer?.cancel()
  }
}
