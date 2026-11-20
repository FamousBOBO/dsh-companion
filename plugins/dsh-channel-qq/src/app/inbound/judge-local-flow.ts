/** **本地 Jev 判断这一路**的编排：状态渲染 → 判断端口 → 折成 `CycleOutcome`。
 *
 * 为什么单独一个文件：`runPresenceCycle` 那条路要组整段提示词、解析自由文本、跑语义复核；
 * 这一路不生成文本，所以两者**共用的只有"记账口径"**。混在一个函数里，
 * 改阈值时要读两百行提示词组装，而改提示词时会碰到判断阈值——两条线的失败模式完全不同。
 *
 * 三条硬口径（与宿主模型那条**完全一致**，这是换后端不改行为的前提）：
 *   1. `no-route` → **不是失败**：这一路不可用（没配置/没显存/进程挂了），按"这一轮不判断"
 *      记账，否则显存一抖动就会攒满失败计数把自己暂停十分钟；
 *   2. `invalid` → **是失败**：有回答但形状不对，累积几次就暂停（与宿主模型同口径）；
 *   3. `silent` / `observe` → **是成功**：正常结论，不累积失败、不占发言额度。
 *
 * 第 1 条为什么与宿主模型不同：宿主模型的 `no-route` 也是失败（它「本该」有能力），
 * 而本地打分器是**可选加速件**——它的缺席不该改变这一轮的记账。
 */

import type { JudgeLine, JudgePort, JudgeRequest, JudgeVerdict } from './judge-port.js'
import { renderJudgeState } from './judge-state.js'
import {
  DEFAULTS,
  failed,
  positiveOr,
  silent,
  type CycleDeps,
  type CycleInput,
  type CycleOutcome,
  type PresenceView,
  type SpeakingDecision,
} from './presence-flow.js'
import { speak } from './presence-send.js'

/** 本模块要用的 `presence.*`（结构类型：不把整份配置拖进来）。 */
export type LocalJudgeSettings = PresenceView

/** 判断端口的入参（把配置里的上限解析成具体数字）。 */
export function judgeRequestOf(input: CycleInput, deps: CycleDeps): JudgeRequest {
  const settings = input.settings
  const limit = positiveOr(settings.judgeMaxEntries, DEFAULTS.judgeMaxEntries)
  const entries = input.background.slice(-limit)
  return {
    groupId: input.groupId,
    lines: entries.map((entry): JudgeLine => ({
      messageId: entry.messageId,
      name: entry.name,
      userId: entry.userId,
      text: entry.text,
      self: entry.self,
      atMs: entry.atMs,
    })),
    state: renderJudgeState(entries, input.nowLabel),
    nowMs: deps.clock.now(),
    replyMaxChars: positiveOr(settings.replyMaxChars, DEFAULTS.replyMaxChars),
    windowMs: positiveOr(settings.replyWindowMs ?? DEFAULTS.replyWindowMs, DEFAULTS.replyWindowMs),
    ...(deps.selfId === undefined ? {} : { selfId: deps.selfId() }),
  }
}

/**
 * 跑一次本地判断。
 *
 * `judge` 缺省时不可达（调用方先判 `usesLocalJudge`）；这里再兜一层是为了
 * "装配漏接但配置切到了 jev-local"这种半坏状态：按不可用处理，而不是崩。
 */
export async function runLocalJudgeCycle(input: CycleInput, deps: CycleDeps): Promise<CycleOutcome> {
  const judge: JudgePort | undefined = deps.judge
  if (judge === undefined || input.background.length === 0) {
    return silent(input, deps, '这一轮没有可判断的旁听（本地判断跳过）', 'silent')
  }
  const request = judgeRequestOf(input, deps)
  const verdict = await judge.decide(request)
  switch (verdict.kind) {
    case 'no-route':
      // 本地打分器缺席**不改记账**：这一轮只当没判。
      return silent(input, deps, `本地判断不可用（${verdict.detail}），本轮不判断`, 'silent')
    case 'invalid':
      return failed(input, deps, `本地判断输出不可用（${verdict.reason}）`)
    case 'decision': {
      if (verdict.action === 'silent' || verdict.action === 'observe') {
        const label = verdict.action === 'observe' ? '观察' : '沉默'
        const topic = verdict.action === 'observe' && verdict.topic !== undefined ? `；关注话题「${verdict.topic}」` : ''
        return silent(input, deps, `本地判断为${label}（${verdict.reason}）${topic}`,
          verdict.action === 'observe' ? 'observe' : 'silent')
      }
      const decision = speakingDecisionOf(verdict)
      if (decision === null) return failed(input, deps, '本地判断给了要说话的动作但没有目标消息号')
      // 发送侧的所有闸门（限频、模式、回执）与宿主模型那条**共用同一处**：
      // 换后端不允许改发送行为，所以这里只做"把决策交出去"。
      return await speak(input, deps, decision)
    }
    default:
      return failed(input, deps, '本地判断返回了未知形状')
  }
}

/** 把 verdict 收成发送侧认的形状；`reply` 缺目标号时返回 `null`（那是坏回答）。 */
function speakingDecisionOf(verdict: Extract<JudgeVerdict, { kind: 'decision' }>): SpeakingDecision | null {
  if (verdict.action === 'reply') {
    const target = verdict.targetMessageId
    if (target === undefined) return null
    return { action: 'reply', targetMessageId: target, text: verdict.text, reason: verdict.reason }
  }
  if (verdict.action === 'join') {
    // `join` 必须有话题：本地判断的话题就是场景名（短语库按场景切，话题就是它）。
    return { action: 'join', topic: verdict.topic ?? '群里的话题', text: verdict.text, reason: verdict.reason }
  }
  if (verdict.action === 'react') {
    return {
      action: 'react',
      text: verdict.text,
      reason: verdict.reason,
      ...(verdict.targetMessageId === undefined ? {} : { targetMessageId: verdict.targetMessageId }),
    }
  }
  return null
}
