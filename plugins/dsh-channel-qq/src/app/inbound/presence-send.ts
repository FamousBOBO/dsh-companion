/** 社交决策的**出站层**：限频复核 → 模式闸门 → 发送 → 记账。
 *
 * 为什么从 `presence-flow.ts` 拆出来：那个文件负责"想"（组提示词、调模型、解析、校验），
 * 这个文件负责"做"（发不发、发出去没有、怎么记账）。两者的失败模式完全不同——
 * 想的失败是"模型胡说"，做的失败是"发出去了但没回执"或"该拦的没拦住"。
 * 混在一起时，最需要反复读的那段（发送闸门）会埋在一百行提示词组装后面。
 *
 * 三条硬口径（每一条都是事故换来的）：
 *   1. **最后一道闸门每次现取**：管理员把 `live` 改成 `shadow` 时，正在飞的那次模型调用
 *      回来也**不许发**。装配时读一次的做法会让那次调用照发（计划 §7.1 的最高风险）。
 *   2. **只有真实回执才算说过话**：`message_id` 是 number 才 `recordSpeak` + 写 sent-log；
 *      失败/无回执只推进失败计数，**不重试、不连发**。
 *   3. **被模式拦下不是失败**：模型与代码都正常，只是不许发。按 `silent` 记账，
 *      否则 shadow 跑一会儿就会把失败计数攒满、自己暂停。
 */

import {
  recordJudge,
  recordSpeak,
  speakVerdict,
  type PresenceState,
} from '../../core/presence.js'
import type { ChatPlatform } from '../../ports/platform.js'
import { limitsOf, type CycleDeps, type CycleInput, type CycleOutcome, type SpeakingDecision } from './presence-flow.js'

/** 说：先复核发言限频，再过模式闸门，再发；**只有拿到回执**才记账。 */
export async function speak(input: CycleInput, deps: CycleDeps, decision: SpeakingDecision): Promise<CycleOutcome> {
  const before = deps.clock.now()
  const verdict = speakVerdict(input.state, before, limitsOf(input.settings))
  if (!verdict.ok) return silent(input, deps, `判断说可以，但这一轮不开口（${String(verdict.reason)}）`)
  // 闸门在**限频之后、发送之前**：shadow 下不该消耗发言额度，所以限频只是先放行，
  // 真正决定"发不发"的是模式。
  const mode = currentMode(deps)
  if (mode !== 'live') return shadowed(input, deps, decision, mode)
  const sent = await send(input, deps, decision)
  if (sent.kind === 'failed') return sent.outcome
  const atMs = deps.clock.now()
  const state = recordSpeak(recordJudge(input.state, atMs, 'spoke', limitsOf(input.settings)), atMs)
  const target = decision.action === 'reply' ? `，引用 #${String(decision.targetMessageId)}` : ''
  deps.log(
    `presence: 群 ${String(input.groupId)} 已自主发言 ${decision.action} #${String(sent.messageId)}`
    + `（${String([...decision.text].length)} 字${target}）`,
  )
  try {
    await deps.recordSent(input.groupId, sent.messageId, decision.text)
  } catch (error) {
    deps.log(`presence: 群 ${String(input.groupId)} sent-log 写入失败（已忽略）：${describe(error)}`)
  }
  try {
    deps.recordEvent?.({
      kind: 'proactive_message',
      messageId: sent.messageId,
      text: decision.text,
      atMs,
      ...(decision.action === 'reply' ? { targetMessageId: decision.targetMessageId } : {}),
    })
  } catch (error) {
    deps.log(`presence: 群 ${String(input.groupId)} 事件记账失败（已忽略）：${describe(error)}`)
  }
  return {
    kind: 'spoke',
    action: decision.action,
    text: decision.text,
    messageId: sent.messageId,
    selfId: sent.selfId,
    ...(decision.action === 'reply' ? { targetMessageId: decision.targetMessageId } : {}),
    state,
  }
}

/** 真的把这一句发出去。`message_id` 不是 number 一律当没成（不重试、不连发）。 */
async function send(
  input: CycleInput,
  deps: CycleDeps,
  decision: SpeakingDecision,
): Promise<
  | { readonly kind: 'sent'; readonly messageId: number; readonly selfId: number | null }
  | { readonly kind: 'failed'; readonly outcome: CycleOutcome }
> {
  let platform: ChatPlatform
  try {
    platform = deps.platform()
  } catch (error) {
    return { kind: 'failed', outcome: failed(input, deps, `取平台失败：${describe(error)}`) }
  }
  // `reply` 用引用段：这是"在回哪一条"唯一的可见标记（也是模型给的号唯一被用到的地方）。
  // 引用段里的 id 只接受**本轮已经通过校验**的那个号——绝不把模型给的原样塞进去。
  const message = decision.action === 'reply'
    ? [{ type: 'reply' as const, data: { id: String(decision.targetMessageId) } }, { type: 'text' as const, data: { text: decision.text } }]
    : [{ type: 'text' as const, data: { text: decision.text } }]
  try {
    const receipt = await platform.api.sendGroupMessage(input.groupId, message)
    const id = receipt?.message_id
    if (typeof id !== 'number') {
      return { kind: 'failed', outcome: failed(input, deps, '自主发言没有 message_id 回执（不记成功、不重试）') }
    }
    return { kind: 'sent', messageId: id, selfId: platform.selfId }
  } catch (error) {
    return { kind: 'failed', outcome: failed(input, deps, `自主发言发送失败（不重试）：${describe(error)}`) }
  }
}

/**
 * 当前运行模式（每次现取；取不到按 `live`）。
 *
 * 取不到按 live 是**刻意的**：那是旧装配（没有闸门）与单测的默认路径。默认成 shadow
 * 会让既有测试与旧部署突然"不发消息"——那不是加固，是静默的功能回退。
 */
function currentMode(deps: CycleDeps): string {
  try {
    const mode = deps.sendGate?.()
    return typeof mode === 'string' && mode !== '' ? mode : 'live'
  } catch {
    deps.log('presence: 发送模式闸门抛错，按不发处理')
    return 'off'
  }
}

/**
 * 被模式拦下（`shadow` / `off`）：记影子日志，**按判断成功记账**。
 *
 * 三件事都不能少：记影子日志（shadow 存在的全部意义）；按 `silent` 记账（不是 `failed`）；
 * **不**推进发言冷却、**不**占额度（没发就是没发）。
 */
function shadowed(input: CycleInput, deps: CycleDeps, decision: SpeakingDecision, blockedBy: string): CycleOutcome {
  const atMs = deps.clock.now()
  deps.log(
    `presence: 群 ${String(input.groupId)} 模式 ${blockedBy} 拦下一次发言（${decision.action}，`
    + `${String([...decision.text].length)} 字），只记不发`,
  )
  try {
    deps.recordShadow?.({
      groupId: input.groupId,
      action: decision.action,
      text: decision.text,
      ...(decision.action === 'reply' ? { targetMessageId: decision.targetMessageId } : {}),
      reason: decision.reason,
      atMs,
      blockedBy,
    })
  } catch (error) {
    deps.log(`presence: 群 ${String(input.groupId)} 影子日志写入失败（已忽略）：${describe(error)}`)
  }
  const state = recordJudge(input.state, atMs, 'silent', limitsOf(input.settings))
  return {
    kind: 'shadow',
    action: decision.action,
    text: decision.text,
    ...(decision.action === 'reply' ? { targetMessageId: decision.targetMessageId } : {}),
    blockedBy,
    state,
  }
}

/** 记一次"不说话"（判断成功但结论是不说/观察，或复核被限频挡下）。 */
export function silent(input: CycleInput, deps: CycleDeps, reason: string, action?: 'silent' | 'observe'): CycleOutcome {
  deps.log(`presence: 群 ${String(input.groupId)} ${reason}`)
  const state: PresenceState = recordJudge(input.state, deps.clock.now(), 'silent', limitsOf(input.settings))
  return { kind: 'silent', reason, state, ...(action === undefined ? {} : { action }) }
}

/** 记一次失败（**绝不**记成一次自主发言：失败只影响 `failures`）。 */
export function failed(input: CycleInput, deps: CycleDeps, detail: string): CycleOutcome {
  deps.log(`presence: 群 ${String(input.groupId)} ${detail}`)
  const state: PresenceState = recordJudge(input.state, deps.clock.now(), 'failed', limitsOf(input.settings))
  return { kind: 'failed', detail, state }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
