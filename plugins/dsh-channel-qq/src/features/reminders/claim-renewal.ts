/**
 * **发送期间续租认领**（第二轮 P1-A：「claim TTL 必须与发送超时协调」）。
 *
 * 为什么需要：认领 TTL 的用途是"崩了之后别的进程能判定这一轮作废"，**不是**给发送掐表。
 * 一次真实的 QQ 发送可能比 TTL 还慢（出站队列限速 + 多段 + 平台慢）。如果不续租：
 *
 *   1. 我们还在发，认领先过期；
 *   2. 另一个进程把这条判成 `stale` ⇒ 收敛成 `unknown`；
 *   3. 结果是一条**真发出去的消息**被记成"不确定"，积压成人工工单。
 *
 * 续租把这两件事解耦：只要**发送者进程还活着并在发**，租约就一直有效；进程真的没了，
 * 租约最多在一个 TTL 之后过期（崩溃恢复语义不变）。
 *
 * 三条纪律：
 *   - 续租间隔 = `ttlMs / 3`（留两次失败的余量）；
 *   - 续租失败**只记日志**，不改投递结论——消息可能已经发出去了，把"续租失败"写成
 *     "没发出去"会直接导致重复外发；
 *   - 用注入的时钟（`Clock.setInterval`），所以这个行为能在假时钟上逐毫秒验证。
 */

import type { Clock, TimerHandle } from '../../ports/clock.js'
import type { ReminderStore } from './store.js'
import { DEFAULT_CLAIM_TTL_MS } from './claim.js'

/** 续租节奏：TTL 的三分之一（一次失败还有两次机会）。 */
export function renewIntervalMs(ttlMs: number): number {
  return Math.max(1, Math.floor(Math.max(1, ttlMs) / 3))
}

/**
 * 开一个续租心跳。**必须**在 `finally` 里 `stop()`（否则发送结束后它还在写盘）。
 *
 * @returns `stop()` 之后的续租次数（测试断言"真的续了"）
 */
export function startClaimRenewal(input: {
  readonly store: ReminderStore
  readonly id: string
  readonly owner: string
  readonly clock: Clock
  readonly log: (line: string) => void
  readonly ttlMs?: number
}): { stop: () => number; count: () => number } {
  // 老测试替身没有 `renewClaim()`：没什么可续的（它们也没有 `claim()`，退化规则一致）。
  if (typeof (input.store as { renewClaim?: unknown }).renewClaim !== 'function') {
    return { stop: () => 0, count: () => 0 }
  }
  const ttlMs = input.ttlMs ?? DEFAULT_CLAIM_TTL_MS
  let renewals = 0
  const handle: TimerHandle = input.clock.setInterval(() => {
    const now = input.clock.now()
    void input.store.renewClaim(input.id, input.owner, now, ttlMs).then((mutation) => {
      if (mutation.ok) { renewals += 1; return }
      // 续不上不是投递结论：只留痕（人工收敛时能看到"这一轮的租约没续上"）。
      input.log(`reminders: ${input.id} 认领续租被拒（${mutation.code}：${mutation.message}）——`
        + '投递结论不受影响，但这一轮可能被别的进程判成 unknown')
    }).catch((error: unknown) => {
      input.log(`reminders: ${input.id} 认领续租失败（${error instanceof Error ? error.message : String(error)}）：`
        + '投递结论不受影响')
    })
  }, renewIntervalMs(ttlMs))
  if (typeof handle.unref === 'function') handle.unref()
  return {
    stop: () => { handle.cancel(); return renewals },
    count: () => renewals,
  }
}
