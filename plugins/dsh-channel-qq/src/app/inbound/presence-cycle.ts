/** **一次**判断的编排：取背景 → 组装输入 → 跑流程 → 把结果记回状态/旁听/时间线。
 *
 * 为什么从 `presence-runtime.ts` 拆出来：那个类是**常驻状态**（每群游标、限频状态、定时器、
 * 卸载），这里是**一次性流程**（说完就结束，最长活一次模型超时）。混在一起时文件会一路长到
 * 四百多行（`check:size` 的硬上限），而"这一次到底发生了什么"会散在七个私有方法里。
 *
 * 这里**不持有**任何跨轮状态：所有读写都经 {@link CycleContext} 的回调回到 `GroupPresence`。
 * 好处是这条流程可以被单独测（喂假上下文），而不是必须先把整个状态机装配起来。
 */

import type { AmbientEntry } from '../../core/ambient.js'
import type { PresenceState } from '../../core/presence.js'
import { judgeVerdict } from '../../core/presence.js'
import type { ChatPlatform } from '../../ports/platform.js'
import type { Clock } from '../../ports/clock.js'
import { ambientLimitsOf, type AmbientStore } from './ambient-store.js'
import {
  DEFAULTS,
  limitsOf,
  positiveOr,
  runPresenceCycle,
  type CompletePort,
  type CycleOutcome,
  type PresenceView,
} from './presence-flow.js'
import type { GroupTimelineBook } from './presence-timeline.js'
import type { GroupSchedulerBook } from './presence-scheduler.js'
import type { JudgeEntry } from './presence-judge.js'
import type { GroupPersonaSnapshot } from './group-persona.js'
import { EMPTY_RECALL, type GroupMemoryRecall } from './group-memory-contract.js'
import { extractCandidateFacts, type CandidateFact } from '../../core/group-memory-extract.js'

/** 她最近说过的话留几条（防重复；提示词里最多渲染 6 条）。 */
export const SENT_MEMORY = 6

/** 时间线读出来的"她刚说过什么"最多几条。 */
export const TIMELINE_SELF_LIMIT = 6

/**
 * 一次判断要用到的**全部外部面**，全部由调用方（状态机）给。
 *
 * 刻意全是函数：`platform`/`persona`/`memory` 每次现取（热加载后旧对象会被换掉，
 * 缓存等于把"重连"变成"静默失败"），而状态读写必须回到唯一的持有者。
 */
export interface CycleContext {
  readonly clock: Clock
  readonly log: (line: string) => void
  readonly platform: () => ChatPlatform
  readonly complete: CompletePort
  readonly recordSent: (groupId: number, messageId: number | null, text: string) => Promise<void>
  readonly ambient: AmbientStore
  readonly timelines: GroupTimelineBook
  readonly scheduler: GroupSchedulerBook
  readonly settingsOf: () => PresenceView | null
  readonly stateOf: (groupId: number) => PresenceState
  readonly applyState: (groupId: number, state: PresenceState) => void
  readonly cursorOf: (groupId: number, ring: { lastSeq(): number }) => number
  readonly commitCursor: (groupId: number, seq: number) => void
  readonly sentLines: (groupId: number) => readonly string[]
  readonly noteSpoken: (groupId: number, text: string) => void
  readonly persona: (groupId: number) => GroupPersonaSnapshot | null
  readonly memory?: (input: {
    groupId: number
    memberIds: readonly number[]
    topic: string
    background: readonly JudgeEntry[]
    nowMs: number
  }) => GroupMemoryRecall
  readonly noteSkip: (groupId: number, reason: string, nowMs: number, pending: number) => void
  /**
   * 现取运行模式（P5-B）：最后一道发送闸门用它。
   *
   * **每次发送前都重新问**：管理员把 live 改成 shadow 时，正在飞的那次模型调用回来
   * 也必须被拦下（计划 §7.1 点名的最高风险）。
   */
  readonly modeOf: () => string
  /** 她自己的 QQ 号（P6-A）；取不到给 0（场景会保守地判"没人 @ 我"）。 */
  readonly selfId: () => number
  /** 语义复核档位（P6-B）：`off` / `warn` / `enforce`。 */
  readonly guardMode: () => string
  /** 影子日志（`shadow` 下"本来想发什么"）；缺省 = 不记。 */
  readonly recordShadow?: (decision: {
    groupId: number
    action: 'reply' | 'join' | 'react'
    text: string
    targetMessageId?: number
    blockedBy: string
    atMs: number
  }) => void
  /**
   * 她刚发出一条（文字或表情）之后的钩子（P4 §8.2 / §8.3）；缺省 = 什么都不做。
   *
   * 为什么放在这里：只有这一层知道"真的发出去了"（有回执），而表情包与弱反馈都要求
   * "发成功才记"。放在外面会让失败也记一笔。
   */
  readonly onSpoken?: (input: {
    groupId: number
    action: 'reply' | 'join' | 'react'
    text: string
    messageId: number
    atMs: number
  }) => void
  /**
   * 写候选记忆（P1 §5.3）；缺省 = 不写。
   *
   * 为什么由**这一层**调：只有它手里有"这一批是哪几条消息"（带真实消息号），而记忆必须有来源。
   * 写入失败不该影响判断结果，所以调用方要把异常吞掉。
   */
  readonly remember?: (input: {
    groupId: number
    facts: readonly CandidateFact[]
    nowMs: number
  }) => void
}

/**
 * 跑一次判断。
 *
 * 顺序不能变：**先取批次并推进游标**（同一批不该被反复判），再判"这一轮到底该不该判"
 * （限频），最后才花钱调模型。反过来会在限频挡下时把游标留原地，于是同一批被反复取出来。
 */
export async function runCycleFor(ctx: CycleContext, groupId: number): Promise<boolean> {
  const settings = ctx.settingsOf()
  if (settings === null) return false
  const startedAt = ctx.clock.now()
  const background = takeBatch(ctx, groupId, settings)
  if (background.length === 0) return false
  const outcome = await runPresenceCycle(inputOf(ctx, groupId, settings, background), depsOf(ctx, groupId))
  // 卸载之后到达的结果一律丢弃（否则"关掉了还在发"）。
  ctx.applyState(groupId, outcome.state)
  recordOutcome(ctx, groupId, settings, outcome, startedAt)
  // shadow 下"本来想发"的那句进影子账本（与真实发言分开统计）。
  if (outcome.kind === 'shadow') {
    ctx.scheduler.update(groupId, (current) => ({ ...current, shadowWouldSend: current.shadowWouldSend + 1 }))
    try {
      ctx.recordShadow?.({
        groupId,
        action: outcome.action,
        text: outcome.text,
        ...(outcome.targetMessageId === undefined ? {} : { targetMessageId: outcome.targetMessageId }),
        blockedBy: outcome.blockedBy,
        atMs: ctx.clock.now(),
      })
    } catch (error) {
      ctx.log(`presence: 群 ${String(groupId)} 影子日志失败（已忽略）：${describe(error)}`)
    }
  }
  // 记忆提取放在**判断结束之后**：它是附带产物，不该拖慢这一轮（§7.4 的成本要求）。
  rememberFrom(ctx, groupId, background)
  return true
}

/**
 * 把这一批里的候选记忆写进库。
 *
 * 三条约束：只写"成员主动说的第一人称事实"（见 `core/group-memory-extract.ts`）；
 * 写失败只记日志（判断已经完成，不该因为记忆回滚）；**不与判断同步等待**——
 * 写入方是同步的 sqlite 调用，所以这里也就同步，但不抛。
 */
function rememberFrom(ctx: CycleContext, groupId: number, background: readonly JudgeEntry[]): void {
  if (ctx.remember === undefined) return
  try {
    const facts = extractCandidateFacts(background)
    if (facts.length === 0) return
    ctx.remember({ groupId, facts, nowMs: ctx.clock.now() })
  } catch (error) {
    ctx.log(`presence: 群 ${String(groupId)} 记忆提取失败（已忽略）：${describe(error)}`)
  }
}

/** 取这一批背景，并**无论如何**推进游标。 */
function takeBatch(ctx: CycleContext, groupId: number, settings: PresenceView): JudgeEntry[] {
  const nowMs = ctx.clock.now()
  const ring = ctx.ambient.ring(groupId, ambientLimitsOf(settings))
  const after = ring.peekAfter(ctx.cursorOf(groupId, ring), nowMs)
  ctx.commitCursor(groupId, ring.lastSeq())
  const fresh = after.filter((entry) => !entry.self).length
  const verdict = judgeVerdict(ctx.stateOf(groupId), nowMs, limitsOf(settings), fresh)
  if (!verdict.ok) {
    ctx.noteSkip(groupId, String(verdict.reason ?? 'unknown'), nowMs, fresh)
    ctx.log(`presence: 群 ${String(groupId)} 这一轮不判断（${String(verdict.reason)}）`)
    return []
  }
  return windowOf(after, settings.judgeMaxEntries, settings.judgeMaxChars)
}

/** 一次判断的输入（背景已裁好、时间正序）。 */
function inputOf(ctx: CycleContext, groupId: number, settings: PresenceView, background: readonly JudgeEntry[]) {
  const memberIds = [...new Set(background.filter((entry) => !entry.self).map((entry) => entry.userId))]
  return {
    groupId,
    settings,
    state: ctx.stateOf(groupId),
    background,
    sentLines: ctx.sentLines(groupId),
    // 复读复核（G30）要**真实时间**：sentLines 是给提示词的纯文本，这里另带一份带时刻的。
    selfSaid: selfSaidOf(ctx, groupId),
    nowLabel: nowLabelOf(ctx.clock.date()),
    persona: ctx.persona(groupId),
    memory: recallFor(ctx, groupId, memberIds, background),
  }
}

/**
 * 她说过的话（带时刻）。时间线优先（那里有真实 atMs）；退回 sentLines 时按"刚刚"算——
 * 保守方向是**多拦**，而默认档位只记不拦，所以退回也不会误伤。
 */
function selfSaidOf(ctx: CycleContext, groupId: number): Array<{ text: string; atMs: number }> {
  try {
    const recent = ctx.timelines.scopedView().recentSelf(groupId, TIMELINE_SELF_LIMIT)
    if (recent.length > 0) return recent.map((row) => ({ text: row.text, atMs: row.atMs }))
  } catch {
    /* 时间线坏了就走下面的兜底 */
  }
  const nowMs = ctx.clock.now()
  return ctx.sentLines(groupId).map((text) => ({ text, atMs: nowMs }))
}

/** 一次判断能碰到的外部世界（全部现取）。 */
function depsOf(ctx: CycleContext, groupId: number) {
  return {
    clock: ctx.clock,
    log: ctx.log,
    platform: ctx.platform,
    complete: ctx.complete,
    recordSent: ctx.recordSent,
    // 最后一道闸门：**每次要发之前**现取模式（参考 `CycleDeps.sendGate` 的注释）。
    sendGate: () => ctx.modeOf(),
    // 她自己的号（P6-A）：场景要判"有没有人真的 @ 了我"。
    selfId: () => ctx.selfId(),
    // 语义复核档位（P6-B）：每次现取，后台改完立即生效。
    guardMode: () => ctx.guardMode(),
    recordEvent: (event: { kind: 'proactive_message' | 'agent_reply'; messageId: number; text: string; atMs: number }) => {
      try {
        ctx.timelines.recordSelf(groupId, event)
      } catch (error) {
        ctx.log(`presence: 群 ${String(groupId)} 时间线写入失败（已忽略）：${describe(error)}`)
      }
    },
  }
}

/** 把结果记回统计、旁听环与时间线（**只有拿到回执**才有"说过话"这一步）。 */
function recordOutcome(
  ctx: CycleContext,
  groupId: number,
  settings: PresenceView,
  outcome: CycleOutcome,
  startedAt: number,
): void {
  const duration = Math.max(0, ctx.clock.now() - startedAt)
  ctx.scheduler.update(groupId, (current) => ({
    ...current,
    lastJudgeAtMs: startedAt,
    lastJudgeDurationMs: duration,
    judgments: current.judgments + 1,
    // 这一批判完了：批次起点清零，否则下一轮会拿旧起点算"饥饿"并误报。
    batchStartedAtMs: 0,
    batchCount: 0,
    ...(outcome.kind === 'spoke' ? { spoken: current.spoken + 1 } : {}),
  }))
  if (outcome.kind !== 'spoke') return
  ctx.noteSpoken(groupId, outcome.text)
  echoSelf(ctx, groupId, settings, outcome.messageId, outcome.selfId, outcome.text)
  if (ctx.onSpoken === undefined) return
  try {
    ctx.onSpoken({
      groupId,
      action: outcome.action,
      text: outcome.text,
      messageId: outcome.messageId,
      atMs: ctx.clock.now(),
    })
  } catch (error) {
    // 表情包/反馈都是附加动作：失败绝不能影响"这一句已经发出去了"这个事实。
    ctx.log(`presence: 群 ${String(groupId)} 附加动作失败（已忽略）：${describe(error)}`)
  }
}

/** 把她自己刚发的那条回灌旁听：下一次判断要能看见"这是我自己说的"。 */
function echoSelf(
  ctx: CycleContext,
  groupId: number,
  settings: PresenceView,
  messageId: number,
  selfId: number | null,
  text: string,
): void {
  try {
    ctx.ambient.ring(groupId, ambientLimitsOf(settings)).add({
      messageId,
      userId: typeof selfId === 'number' ? selfId : 0,
      name: '',
      text,
      body: text,
      atMs: ctx.clock.now(),
      self: true,
    })
  } catch (error) {
    ctx.log(`presence: 群 ${String(groupId)} 回灌旁听失败（已忽略）：${describe(error)}`)
  }
}

/** 这一轮要注入的记忆（**绝不抛**：记忆坏了只是少一段，不是判断失败）。 */
function recallFor(
  ctx: CycleContext,
  groupId: number,
  memberIds: readonly number[],
  background: readonly JudgeEntry[],
): GroupMemoryRecall {
  if (ctx.memory === undefined) return EMPTY_RECALL
  try {
    const topic = background
      .filter((entry) => !entry.self)
      .map((entry) => (typeof entry.body === 'string' ? entry.body : entry.text))
      .slice(-1)[0] ?? ''
    return ctx.memory({
      groupId,
      memberIds,
      topic: topic.slice(0, 60),
      background,
      nowMs: ctx.clock.now(),
    })
  } catch (error) {
    ctx.log(`presence: 群 ${String(groupId)} 记忆召回失败（已忽略）：${describe(error)}`)
    return EMPTY_RECALL
  }
}

/**
 * 按条数与字数取**最近**的一段背景（时间正序返回）。
 *
 * 与 `AmbientRing.take` 同一套口径（从最新往前收，至少留一条），但这里**不推进**缓冲的
 * 交付游标：判断只看不取，被 @ 时的交付仍由流水线负责。
 */
function windowOf(entries: readonly AmbientEntry[], maxEntries: number, maxChars: number): JudgeEntry[] {
  const entryCap = Math.max(1, Math.trunc(positiveOr(maxEntries, DEFAULTS.judgeMaxEntries)))
  const charCap = Math.max(1, Math.trunc(positiveOr(maxChars, DEFAULTS.judgeMaxChars)))
  const recent = entries.slice(-entryCap).reverse()
  const picked: AmbientEntry[] = []
  let total = 0
  for (const entry of recent) {
    const size = [...entry.text].length
    if (picked.length > 0 && total + size > charCap) break
    picked.push(entry)
    total += size
  }
  return picked.reverse().map((entry) => ({
    messageId: entry.messageId,
    name: entry.name,
    userId: entry.userId,
    text: entry.text,
    // 正文单独带一份：渲染层要显式输出一次发送者身份，整行里那段抬头就不能再出现。
    // 环里没存 body（旧写入方 / 测试直接 `add`）时不填这个键：让判断层自己去剥抬头，
    // 而不是在这里塞一整行当正文——那正好会渲染成"身份出现两次"。
    ...(entry.body === undefined ? {} : { body: entry.body }),
    self: entry.self,
    atMs: entry.atMs,
    // 平台结构原样带给判断层（P6-A）：场景摘要只认这些事实。
    ...(entry.replyToMessageId === undefined ? {} : { replyToMessageId: entry.replyToMessageId }),
    ...(entry.atIds === undefined ? {} : { atIds: entry.atIds }),
  }))
}

/** 提示词里的"现在几点"（用注入时钟的 `date()`，不读全局时钟——R8）。 */
function nowLabelOf(date: Date): string {
  const two = (value: number): string => String(value).padStart(2, '0')
  return `${String(date.getFullYear())}-${two(date.getMonth() + 1)}-${two(date.getDate())} `
    + `${two(date.getHours())}:${two(date.getMinutes())}`
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
