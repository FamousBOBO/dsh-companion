/** 攒批策略：一次"数据包"什么时候发、什么时候等、什么时候干脆丢掉。
 *
 * 这是群里不被刷屏的核心判定，原来长在 `ConversationBridge.flushNow()` 里，
 * 与宿主、定时器、会话状态搅在一起，四种分支（空包 / 忙 / 退避中 / 骰子没中）
 * 只能靠跑真消息观察。搬出来之后每一种分支都是一次纯函数调用。
 *
 * **随机数从外面递进来**（`roll`）：判定必须是确定性的可重放函数，
 * 骰子只在真正需要掷的那一刻才掷（所以 `roll` 是 thunk 而不是数值——
 * 提前求值会消耗随机流，让"这次到底掷没掷"无法解释）。
 */

/** 队列里的总字数（入站行的长度之和，不是字节）。 */
export function queueChars(queue: readonly string[]): number {
  let sum = 0
  for (const line of queue) sum += line.length
  return sum
}

/** 攒够了没有：条数或字数任一触顶就立刻分析，不等安静窗口。 */
export function isBatchFull(queue: readonly string[], limits: { readonly maxMessages: number; readonly maxChars: number }): boolean {
  return queue.length >= limits.maxMessages || queueChars(queue) >= limits.maxChars
}

/** 一次 flush 的裁决结果。 */
export type FlushDecision =
  /** 队列和待发图都是空的，什么也不用做。 */
  | { readonly kind: 'empty' }
  /** 现在不能发，重新起一个安静窗口等着。 */
  | { readonly kind: 'defer'; readonly why: 'busy' | 'backoff' }
  /** 骰子没中：整包丢掉（记下丢了几行）。 */
  | { readonly kind: 'drop'; readonly lines: number }
  /** 发。 */
  | { readonly kind: 'flush' }

export interface FlushState {
  /** 待分析的行数。 */
  readonly lines: number
  /** 待随包发出的图片数。 */
  readonly images: number
  /** 有回合在跑，或有网关重试已经武装。 */
  readonly busy: boolean
  /** 这一包是"被叫到"触发的：跳过等待与概率闸门。 */
  readonly immediate: boolean
  readonly nowMs: number
  /** 网关过载退避的截止时刻（0 = 没有退避）。 */
  readonly backoffUntilMs: number
  /** 这一轮的搭话概率。 */
  readonly chance: number
  /** 取一个 [0,1) 随机数。只在需要掷骰子时被调用。 */
  readonly roll: () => number
}

/**
 * 裁决一次 flush。
 *
 * 顺序是**有意义的**，不要重排：空包先返回（不起定时器），然后"忙"与"退避"
 * 都走重新排期而不是排队（排队就是我们要躲开的那种堆积），最后才是概率闸门。
 */
export function decideFlush(state: FlushState): FlushDecision {
  if (state.lines === 0 && state.images === 0) return { kind: 'empty' }
  if (state.busy && !state.immediate) return { kind: 'defer', why: 'busy' }
  if (!state.immediate && state.nowMs < state.backoffUntilMs) return { kind: 'defer', why: 'backoff' }
  if (!state.immediate && state.roll() >= state.chance) return { kind: 'drop', lines: state.lines }
  return { kind: 'flush' }
}
