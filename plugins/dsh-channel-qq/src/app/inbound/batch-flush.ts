/** 攒批的定时器与闸门：把"等安静窗口"和"这一批要不要发"从流水线里搬出来。
 *
 * 为什么单独一个文件：这两段是**定时器与骰子**的耦合点（`Clock` / `Random` /
 * `GatewayHealth` 三个副作用端口同时在场），既要能逐条测，又不能让入站流水线那个
 * 文件继续长大（`check:size` 对单文件有硬上限）。
 *
 * 行为与搬出前逐字节一致：
 *   - `scheduleBatch` 每次都**重新武装**安静窗口（旧定时器先取消）；
 *   - `gateOf` 只负责把"现在几点、忙不忙、骰子面值"取出来，裁决在 `core/batching.ts`。
 */

import { decideFlush, type FlushDecision } from '../../core/batching.js'
import { resolveRoomPolicy } from '../../core/room-policy.js'
import type { ConversationRecord } from '../conversation/registry.js'
import type { Clock, Random } from '../../ports/clock.js'
import type { GatewayHealth } from '../conversation/gateway-health.js'

/** 定时器与闸门要用到的配置（结构类型：不把整份 config 拖进来）。 */
export interface BatchConfig {
  readonly batching: { readonly windowMs: number }
  readonly groupEnabled: boolean
  readonly requireMention: boolean
  readonly talkValue: number
  readonly primaryTalkValue?: number | null
  readonly primaryGroup: number | null
  readonly rooms?: readonly { readonly id: number; readonly enabled?: boolean | null;
    readonly requireMention?: boolean | null; readonly talkValue?: number | null }[]
}

export interface FlushDeps {
  readonly config: () => BatchConfig
  readonly clock: Clock
  readonly random: Random
  readonly health: GatewayHealth
  readonly log: (line: string) => void
  /** 真的去组包并投递（由流水线提供：它才知道 turns 与 packets）。 */
  readonly flush: (conversation: ConversationRecord) => Promise<void>
}

/** 重新武装安静窗口定时器（到点就 flush；错误只记日志，不抛给定时器）。 */
export function scheduleBatch(conversation: ConversationRecord, deps: FlushDeps): void {
  const windowMs = deps.config().batching.windowMs
  conversation.batchTimer?.cancel()
  conversation.batchTimer = deps.clock.setTimeout(() => {
    conversation.batchTimer = null
    void deps.flush(conversation).catch((error: Error) => {
      deps.log(`batch flush failed: ${String(error)}`)
    })
  }, windowMs)
}

/** 这一批的闸门裁决（空包 / 忙 / 退避中 / 骰子没中 / 放行）。 */
export function gateOf(
  conversation: ConversationRecord,
  immediate: boolean,
  deps: FlushDeps,
): FlushDecision {
  return decideFlush({
    lines: conversation.queue.length,
    images: conversation.pendingImages.length,
    busy: conversation.tracker.busy(),
    immediate,
    nowMs: deps.clock.now(),
    backoffUntilMs: deps.health.deadline(),
    chance: resolveRoomPolicy(deps.config(), conversation.isGroup ? conversation.chatId : null).talkValue,
    roll: () => deps.random.next(),
  })
}
