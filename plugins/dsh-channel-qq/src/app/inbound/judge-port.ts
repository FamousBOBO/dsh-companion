/** 判断端口的类型面：**"这一轮该不该说话"这件事由谁来回答**。
 *
 * 为什么单独一个文件：判断有两条实现（宿主默认模型 / 本地 Jev typed），但**消费方只有一处**
 * （`presence-flow.ts` 的 `runPresenceCycle`）。把"回答的形状"钉在这里，两条实现才不会
 * 各自演化出不同的结果类型——那正是"换后端之后记账口径变了"的起点。
 *
 * 三条口径：
 *   1. **绝不抛**：所有失败都折成 {@link JudgeVerdict} 的一个分支，调用方 switch 一次就穷尽；
 *   2. **"不说话"是成功**：`silent` / `observe` 与 `decision` 一样是正常结果，
 *      只有 `no-route` / `invalid` 才进失败计数（见 `core/presence.ts` 的 `recordJudge`）；
 *   3. **不放自由文本**：本地 Jev 不经生成，所以这里没有 `text` 字段以外的自由度——
 *      文案只能从短语库里选，长度与字符约束在 `judge-verdict.ts` 里再核一遍。
 *
 * 端口**类型**放在消费者这一侧：`app/` 不许 import `adapters/`（分层检查 R8），
 * 所以适配器实现它、装配侧接起来。
 */

import type { SocialAction } from './group-social-decision.js'

/** 一条要判断的旁听（与 `JudgeEntry` 同形，但这里只要判断用得上的那几项）。 */
export interface JudgeLine {
  /** 平台消息号；`null` = 合成消息，不能作为引用目标。 */
  readonly messageId: number | null
  /** 群名片或昵称；空串 = 不知道。 */
  readonly name: string
  /** 真实发送者 QQ 号。 */
  readonly userId: number
  /** 这一条的正文（不含发送者抬头）。 */
  readonly text: string
  /** 她自己说的。 */
  readonly self: boolean
  /** 本地时间（毫秒）。 */
  readonly atMs: number
}

/** 一次判断的入参：**只有事实**，没有结论、没有指令。 */
export interface JudgeRequest {
  readonly groupId: number
  /** 按时间正序的一批旁听（调用方已按条数/字数裁好）。 */
  readonly lines: readonly JudgeLine[]
  /**
   * 已渲染成型的群聊状态文本。
   *
   * 为什么由调用方给而不是这里拼：拼状态要读人格、记忆、参与者身份、互动风险——
   * 那些都在 `app/` 的另一侧，判断端口不该把它们全拖进来。给字符串的好处是
   * **本地 Jev 与宿主模型看到的是同一份状态**（换后端时不会悄悄换掉上下文）。
   */
  readonly state: string
  /** 现在几点（毫秒）；由调用方用注入时钟给，判断层不读全局时钟。 */
  readonly nowMs: number
  /** 正文长度上限（码点）。 */
  readonly replyMaxChars: number
  /** 允许引用的时间窗（毫秒）：比这更老的消息不许 reply/react。 */
  readonly windowMs: number
  /** 她自己的 QQ 号；`undefined` = 不知道（不能因此假定"没有人 @ 我"）。 */
  readonly selfId?: number
}

/**
 * 判断的结局（穷尽）。
 *
 * `action` 只到"要发什么动作"这一层；具体的 `text` 与 `targetMessageId` 由实现填。
 * 三个要发消息的分支**必须**同时给出 `text`——这是 `SpeakingDecision` 的由来。
 */
export type JudgeVerdict =
  | {
    readonly kind: 'decision'
    readonly action: 'silent' | 'observe'
    readonly reason: string
    /** `observe` 可能带话题（方便下一轮接上）。 */
    readonly topic?: string
  }
  | {
    readonly kind: 'decision'
    readonly action: 'reply' | 'join' | 'react'
    readonly text: string
    readonly reason: string
    readonly targetMessageId?: number
    readonly topic?: string
  }
  /** 这一路不可用（没配、没起、超时）。**不是失败**：按"这一轮不判断"记账。 */
  | { readonly kind: 'no-route'; readonly detail: string }
  /** 有回答但不可用（缺门、短语置信度不够、目标不在场）。按失败记账。 */
  | { readonly kind: 'invalid'; readonly reason: string }

/** 判断端口（单次、不重试）。 */
export interface JudgePort {
  decide(request: JudgeRequest): Promise<JudgeVerdict>
}

/** 要发消息的三个动作（`sendsMessage` 的正向面；实现里用它收窄）。 */
export type SpeakingAction = Extract<SocialAction, 'reply' | 'join' | 'react'>
