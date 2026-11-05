/** 一次投递的**结算形状**：成功、被拦、异常三种来源都收敛成同一个 `ContactSendResult`。
 *
 * 从 `sender.ts` 拆出来的判据：这三个函数全是纯的（输入异常/返回值 + 日志口，输出结算），
 * 而 `sender.ts` 要管时序（复核顺序、队列、令牌）。结算规则最要紧的一条是
 * **"没能证明发出去"绝不写成成功**，所以它值得单独摆在一个能逐条钉住的文件里：
 * `confirmed`（平台接受）> `submitted`（已提交、无回执能力）> `unknown`（回执未知）
 * 的语义差别，就是诊断面板与验收测试唯一能依靠的东西。
 */

import type { ContactDeliveryState, ContactReceipt, ContactTarget } from './types.js'
import { classifySendError } from './send-guard.js'

/** 结算结果：`state` 直接写进投递记录，`detail` 进日志与 `lastError`。 */
export interface ContactSendResult {
  readonly state: ContactDeliveryState
  readonly receipt: ContactReceipt | null
  readonly detail: string
  /** 是否真的调用过平台/回合（"没通道不得标 sent"的可断言证据）。 */
  readonly attempted: boolean
}

/** 复核/门控拦下的结算：**没有调用过平台**，所以 `attempted=false`。 */
export function blockedResult(state: ContactDeliveryState, detail: string): ContactSendResult {
  return { state, receipt: null, detail, attempted: false }
}

/**
 * 执行点自己拦下的发送（超时作废/冻结/世界变了）：不发，结算成 `deferred`/`cancelled`，
 * **绝不**记 `failed`（那个状态会被 `afterSend` 重试）。
 */
export class ContactAborted extends Error {
  constructor(readonly verdict: { readonly state: ContactDeliveryState; readonly detail: string }) {
    super(verdict.detail)
    this.name = 'ContactAborted'
  }
}

/** `sendTo` 的返回值 → 结算。**有 `message_id` 才是 `confirmed`**，否则最多 `submitted`。 */
export function summarizeResult(
  result: { message_id?: number },
  target: ContactTarget,
  now: number,
  log: (line: string) => void,
): ContactSendResult {
  const messageId = typeof result.message_id === 'number' && result.message_id > 0 ? result.message_id : null
  if (messageId === null) {
    log(`contact: 直发已提交但没拿到 message_id（${target.room}），只记 submitted`)
    return { state: 'submitted', receipt: { kind: 'none', messageId: null, at: now }, detail: 'no-message-id', attempted: true }
  }
  log(`contact: 直发成功 ${target.room} message_id=${String(messageId)}`)
  return {
    state: 'confirmed',
    receipt: { kind: 'platform-accepted', messageId, at: now },
    detail: 'platform-accepted',
    attempted: true,
  }
}

/**
 * 异常 → 结算。**这不是"失败即 failed"**：只有经标记的平台明确拒绝才可重试，
 * 其余（超时/连接断/认不出）一律 `unknown`，因为它们无法证明消息没出去。
 */
export function resultFromError(error: unknown, log: (line: string) => void): ContactSendResult {
  if (error instanceof ContactAborted) {
    // 没出网、明确没发：按 deferred/cancelled 落账，**绝不** failed（会被重试）。
    log(`contact: 执行点拦下（${error.verdict.detail}），未发送`)
    return blockedResult(error.verdict.state, error.verdict.detail)
  }
  const { state, kind, detail } = classifySendError(error)
  if (kind === 'rejected') {
    log(`contact: 平台明确拒绝：${detail}`)
    return { state, receipt: null, detail: `rejected:${detail}`, attempted: true }
  }
  if (kind === 'timeout') {
    log('contact: 发送超时，回执未知，记 unknown 且不自动重发')
    return { state, receipt: null, detail: 'timeout', attempted: true }
  }
  // 连接类与未知：消息可能已经出去，也可能没出去；**按发过算**（unknown 不重试）。
  log(`contact: 发送异常（${kind}），回执未知，记 unknown 且不自动重发：${detail}`)
  return { state, receipt: null, detail: `unconfirmed:${kind}:${detail}`, attempted: true }
}
