/** 主动消息草稿的**词汇表**：端口合同（`DraftPort`）、每次尝试的可判别结果
 *  （`DraftAttempt`）、以及落进账本/日志的稳定原因词（`DRAFT_REASONS`）。
 *
 * 为什么从 `model.ts` 拆出来：这份词表被三处同时消费——`draft-host.ts`（真实现要按它
 * 返回结果）、`model.ts`（预算层要按它**穷尽**分档记账）、`attempt.ts`（要把精确原因
 * 写进诊断）。它是"契约"，而 `model.ts` 是"策略"（额度、退避、超时）。两者的改动理由
 * 完全不同：加一个 `kind` 是改契约，调一个阈值是改策略。
 *
 * 词表纪律：`DRAFT_REASONS` 里的每个串都是**稳定字符串**（诊断面板、日志 grep、验收
 * 脚本直接断言它）。改名等于让历史账本与告警一起失效——要改就同时改测试与文档。
 */

import type { ContactCandidate, ContactCounters, ContactDraft } from './types.js'
import type { DraftContext } from './draft-context.js'

/**
 * 端口的一次落地（**可判别结果**，不是 `T | null`）。
 *
 * 为什么必须能判别：预算与退避要按"到底发生了什么"分档记账，而 `null` 把所有情况
 * 压成同一个值——"模型坏了"与"模型说没什么可说"在账本上长得一模一样，于是失败退避
 * 被清零、小时环漏记调用（F5）。
 *
 * 判别联合而不是"一个 kind + 一堆可选字段"：这样 `draftWithBudget` 能写成**穷尽 switch**，
 * 漏掉任何一个分支都是编译错误（第三轮审阅 R6 的要求）。
 */
export type DraftAttempt =
  /** 拿到了一句可发的短文本。**调用过**模型。 */
  | { readonly kind: 'draft'; readonly text: string; readonly route?: string }
  /** 模型明确表示"没什么可说"（提示词里的 `SKIP`）。**调用过**模型。 */
  | { readonly kind: 'skip' }
  /** 模型给了回应但是空白。**调用过**模型。 */
  | { readonly kind: 'empty' }
  /** 文本超过 `maxChars`（不截断，这一轮算了）。**调用过**模型。 */
  | { readonly kind: 'too-long'; readonly detail?: string }
  /** 超时。**调用过**模型（请求可能仍在宿主那边跑）。 */
  | { readonly kind: 'timeout'; readonly detail?: string }
  /** 调用失败（宿主拒绝/流中断）。**调用过**模型。 */
  | { readonly kind: 'failed'; readonly detail: string }
  /**
   * 生成预算在出正文之前就被**隐藏推理**吃光了（结束原因是 `max-tokens`/长度上限，可见正文 0 字）。
   *
   * 与 `empty` 分开是 2026-10-31 事故的直接整改：两者都是"没有可发的文本"，但 `empty` =
   * 模型好好回了空白（正常收尾），`reasoning-exhausted` = **配置问题**（推理档位太高或
   * `maxTokens` 太小），重试同样的配置只会再烧一次预算。所以它按失败记账（有界退避），
   * 诊断里也会明确说"调预算/调档位"，而不是"模型没话说"。
   */
  | { readonly kind: 'reasoning-exhausted'; readonly detail?: string }
  /**
   * 正文拿到了一半就撞上 `max-tokens`：**不发半句话**（与 `too-long` 同一种处置）。
   *
   * 算一次调用，但**不**推进失败退避：模型没坏，只是这次说得比预算长。
   */
  | { readonly kind: 'truncated'; readonly detail?: string }
  /**
   * **调用前**就坏了：取宿主上下文、读模型接缝的 `llm` getter、读默认选型、读超时配置、
   * 构造提示词时抛错。
   *
   * 与 `failed` 分开是这个变体存在的全部理由：这时生成一次都没发生，把"没发生的调用"
   * 记成一次花钱的调用 + 一次失败退避，会让预算提前耗尽，并把排查方向引到模型上
   * （R6/F45）。判据是**有没有真正进入宿主流**，不是"有没有写过 try"。
   */
  | { readonly kind: 'not-called'; readonly detail: string }
  /** 宿主没有可用的模型路由/接缝：**没有发起调用**（装配缺件，不是故障）。 */
  | { readonly kind: 'no-route'; readonly detail?: string }

/**
 * 草稿端口：把"说一句短话"这件事交给外面实现。
 *
 * 返回 `kind: 'skip'` 是**合法结果**（"想了想，没什么要说的"），不是错误——
 * 把它当错误处理会逼出一条"每次都必须说点什么"的路径，正是主动消息最容易打扰人的地方；
 * 反过来把它当成功（F5 的做法）会让真正的失败悄悄清零退避。所以两种都得能分辨。
 */
export interface DraftPort {
  draft(request: DraftRequest): Promise<DraftAttempt>
}

/** 一次起草请求：候选只提供背景，**不许**在这里决定发不发。 */
export interface DraftRequest {
  readonly candidate: ContactCandidate
  /** 硬上限（字符）：短消息就是短，超了按"没话可说"处理，不截断（免得发出半句话）。 */
  readonly maxChars: number
  /** 现在（Unix 毫秒），供实现侧写日志/做提示词。 */
  readonly now: number
  /**
   * **这一轮喂给模型的资料**（P2.5-3D / Slice C0，见 `draft-context.ts`）。
   *
   * 缺席 = 老行为（只有时间/理由/格式），只用于不接上下文的调用点与历史用例；
   * 生产 `direct` 装配**必须**带上它，否则 `requireContext` 会把这一轮判成
   * `not-called`（一次模型调用都不发生）——**不许静默退回无上下文的泛化问候**。
   */
  readonly context?: DraftContext
}

/** 草稿这一侧的全部原因（稳定字符串；调用方按需映射成门控的 `draft:unavailable`）。 */
export const DRAFT_REASONS = [
  'ok',
  /** `draftModel` 关着（默认）：只产候选、不调用模型。 */
  'disabled',
  /** 没注入端口（装配缺件）。 */
  'no-port',
  /** 当日预算用尽。 */
  'budget:daily',
  /** 每小时突发预算用尽。 */
  'budget:hourly',
  /** 失败退避未到。 */
  'backoff:draft',
  /** 连续失败到阈值：先停手。 */
  'backoff:streak',
  /** 模型说没话可说（`SKIP`；合法结果，调过模型）。 */
  'draft:skip',
  /** 模型回了空白（调过模型）。 */
  'draft:empty',
  /** 草稿过长：不截断，这一轮就算了（调过模型）。 */
  'draft:too-long',
  /** 端口抛错/宿主拒绝（调过模型）。 */
  'draft:failed',
  /** 超时（调过模型；请求可能仍在宿主那边跑）。 */
  'draft:timeout',
  /** 生成预算被隐藏推理吃光、零可见正文（调过模型；这是配置问题，不是"没话说"）。 */
  'draft:reasoning-exhausted',
  /** 正文在 `max-tokens` 处被截断：不半句发（调过模型；不推进失败退避）。 */
  'draft:truncated',
  /** **调用前**就坏了（取接缝/选型抛错）：没有发起调用，不占模型预算。 */
  'draft:not-called',
  /** 宿主没有可用的模型路由/接缝：**没有发起调用**。 */
  'draft:no-route',
  /**
   * **上下文不足，所以一次模型调用都没发生**（P2.5-3D / Slice C0）。
   *
   * 判据在 `draft-context.sufficientContext`：读不到"最近对话"（或时区算不出来、或
   * 裁到上限还是超预算）就不起草。与 `draft:not-called` 同档：不记调用、不动退避，
   * 只把候选 defer 回去等下一拍。**这条存在的理由就是不允许"没有上下文的问候"**。
   */
  'draft:no-context',
] as const

export type DraftReason = (typeof DRAFT_REASONS)[number]

/** 预算判定的结果。 */
export interface DraftBudget {
  readonly allowed: boolean
  readonly reason: DraftReason
}

/**
 * 起草的结果。
 *
 * 只有 `kind: 'draft'` 能继续往下走；`kind: 'none'` 的调用方一律把候选**defer**
 * 回队列（不是 drop——没话说不代表这件事永远不会说）。
 *
 * `called` 是给**小时预算环**用的：`true` = 这一次真的向模型发起了请求（成功、
 * SKIP、空文、过长、失败、超时都算），调用方据此把 `now` 记进内存环。F5 之前这里
 * 只在拿到草稿时才返回 `draft`，于是"调了十次都失败"在小时上限里一次都不显示。
 */
export type DraftOutcome =
  | {
    readonly kind: 'draft'
    readonly draft: ContactDraft
    readonly counters: ContactCounters
    readonly called: true
  }
  | {
    readonly kind: 'none'
    readonly reason: DraftReason
    readonly counters: ContactCounters
    readonly called: boolean
  }
