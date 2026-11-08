/** 群聊旁听的**状态机**：合批定时器、每群游标、限频记账、卸载。
 *
 * 分层（这个文件的边界就是这几层的边界）：
 *   - `core/ambient.ts`      : 背景缓冲（旁听 ≠ 发言；**唯一的写入者是流水线**）；
 *   - `core/presence.ts`     : 限频记账（能不能判、能不能说，纯函数、不可变状态）；
 *   - `presence-timeline.ts` : 统一事件时间线的簿记（P3；她说过什么、群里发生过什么）；
 *   - `presence-scheduler.ts`: 调度观测的簿记（§7.4；谁等了多久、为什么没判）；
 *   - `presence-cycle.ts`    : **一次**判断的编排（取批次 → 跑流程 → 记账）；
 *   - `presence-flow.ts`     : 流程本身（模型 → 解析 → 校验 → 发送 → 记账）；
 *   - **本文件**              : 常驻状态与定时器，把这些接到"入站那一刻"与"到点那一刻"上。
 *
 * 六条硬约束（每一条都对应一个会出事的地方）：
 *   1. **`observe` 非阻塞**：入站路径上不能等模型。这里只（可能）武装一个合批定时器。
 *   2. **旁听环不归我写**：流水线的 `captureAmbient` 负责 `add`；这里只 `peekAfter` 读并推进
 *      自己的 `judgedSeq`（两个写者会让"这条到底算不算看过"变成猜测）。
 *   3. **每次现取 platform / persona / memory**：热加载后旧对象会被换掉（2026-11 的私聊事故
 *      就是闭包抓着死掉的客户端）。缓存等于把"重连"变成"静默失败"。
 *   4. **热加载不补发**：`emptyPresenceState(now)` 把上次判断/发言时刻置成"现在"，每群游标首见时
 *      落在"此刻最新的那条"上，于是只有她"上线"之后的新消息才会被判断。
 *   5. **同群不并发**：一个群同时只跑一次判断（`inflight`），避免"两句连着发出去"。
 *   6. **调度参数各管一件事**（P3 §7.3）：`batchQuietMs` 管合批等待、`judgeIntervalMs` 管
 *      判断间隔、`speakMinIntervalMs`/`speakMaxPerHour` 管发言。**不重排**已武装的定时器：
 *      重排会让热闹的群无限往后推（这是"判断饥饿"的老根因），所以等待上限由"首条消息起算"
 *      天然成立；`judgeMaxWaitMs` 只用来**报警**（见 `noteSkip`）。
 *
 * 这里不碰盘、不建会话、不给工具：自主发言由通道直接发，不经过群 agent（§0.8）。
 */

import { emptyPresenceState, judgeVerdict, type PresenceState } from '../../core/presence.js'
import type { AmbientEntry } from '../../core/ambient.js'
import { ambientLimitsOf, presenceAppliesTo, type AmbientStore } from './ambient-store.js'
import { DEFAULTS, limitsOf, positiveOr, type CompletePort, type PresenceView } from './presence-flow.js'
import { GroupTimelineBook, type GroupEventsView } from './presence-timeline.js'
import { GroupSchedulerBook, type GroupSchedulerStats } from './presence-scheduler.js'
import { runCycleFor, SENT_MEMORY, TIMELINE_SELF_LIMIT, type CycleContext } from './presence-cycle.js'
import type { Clock, TimerHandle } from '../../ports/clock.js'
import type { ChatPlatform } from '../../ports/platform.js'
import type { JudgeEntry } from './presence-judge.js'
import type { GroupPersonaSnapshot } from './group-persona.js'
import type { GroupMemoryRecall } from './group-memory-contract.js'
import type { CandidateFact } from '../../core/group-memory-extract.js'

export type { CompletePort, CompleteRequest, CompleteResult, PresenceView } from './presence-flow.js'
export type { GroupSchedulerStats } from './presence-scheduler.js'

export interface PresenceDeps {
  /** 现取配置（后台改完立即生效；`presence` 缺席 = 这套能力不存在）。 */
  readonly config: () => { readonly presence?: PresenceView }
  readonly clock: Clock
  readonly log: (line: string) => void
  /** **不缓存**：热加载后要跟随新客户端。 */
  readonly platform: () => ChatPlatform
  readonly ambient: AmbientStore
  readonly complete: CompletePort
  /** 写 sent-log（她自己的出站账本）；失败只记日志。 */
  readonly recordSent: (groupId: number, messageId: number | null, text: string) => Promise<void>
  /**
   * 现取群聊可见的人格快照（P0 §4.2）。
   *
   * 为什么是"取快照的函数"而不是"一份快照"：快照带版本号，人格文件改了要在下一轮判断
   * 里生效，而不是等通道重启。返回 `null` = 取不到，提示词会明说降级（绝不假装已读到）。
   */
  readonly persona: () => GroupPersonaSnapshot | null
  /**
   * 现取这一轮要注入的群记忆（P1 §5.4）。
   *
   * 缺省 = 没有记忆：**记忆服务不可用时不影响基础群聊**（§5.5 验收项）。由调用方给参数
   * （本轮背景里的成员号、当前话题名），因为只有它知道"这一批是谁在说话"。
   */
  readonly memory?: (input: {
    groupId: number
    memberIds: readonly number[]
    topic: string
    background: readonly JudgeEntry[]
    nowMs: number
  }) => GroupMemoryRecall
  /** 写候选记忆（P1 §5.3）；缺省 = 不写。写失败只记日志。 */
  readonly remember?: (input: {
    groupId: number
    facts: readonly CandidateFact[]
    nowMs: number
  }) => void
  /** 她真的发出一条之后的附加动作（P4 §8.2 表情包 / §8.3 弱反馈）；缺省 = 不做。 */
  readonly afterSpeak?: (input: {
    groupId: number
    action: 'reply' | 'join' | 'react'
    text: string
    messageId: number
    atMs: number
    topic: string | null
  }) => void
  /**
   * 现取运行模式（P5-B）：**每次要发之前**都会重新问一遍。
   *
   * 缺省 = `live`（旧装配与单测的行为不变）。装配侧传的是
   * `() => resolveMode(host.config.presence)`，所以后台一改就立即生效。
   */
  readonly mode?: () => string
  /** 影子日志（`shadow` 下"本来想发什么"）；缺省 = 只写普通日志。 */
  readonly recordShadow?: (decision: {
    groupId: number
    action: 'reply' | 'join' | 'react'
    text: string
    targetMessageId?: number
    blockedBy: string
    atMs: number
  }) => void
}

/** 群聊旁听的执行器。一个实例管所有白名单群（每群一份状态，互不影响）。 */
export class GroupPresence {
  private readonly states = new Map<number, PresenceState>()
  /** 每群"已经判到哪一条"（`AmbientRing` 的 seq）。 */
  private readonly judgedSeq = new Map<number, number>()
  private readonly timers = new Map<number, TimerHandle>()
  /** 正在跑判断的群（同群不并发、不连发）。 */
  private readonly inflight = new Set<number>()
  private readonly sent = new Map<number, readonly string[]>()
  /** 每群的统一事件时间线（P3 §7.1）与调度观测（§7.4）。 */
  private readonly timelines: GroupTimelineBook
  private readonly scheduler = new GroupSchedulerBook()
  private disposed = false

  constructor(private readonly deps: PresenceDeps) {
    this.timelines = new GroupTimelineBook(deps.clock)
  }

  /**
   * 记一条旁听/准备判断（**非阻塞**：不等模型、不发消息、不写盘）。
   *
   * 流水线在 `captureAmbient` 之后调它一次。这里要回答的只有一句：
   * **现在该不该武装一个合批定时器**（到点再花钱判断）。
   */
  observe(groupId: number): void {
    if (this.disposed) return
    try {
      const settings = this.settings()
      if (settings === null || !presenceAppliesTo(settings, groupId)) return
      this.markMessage(groupId, settings)
      this.arm(groupId, settings)
    } catch (error) {
      // 入站路径上绝不能因为旁听把一条正常消息弄丢。
      this.deps.log(`presence: 群 ${String(groupId)} 旁听记账异常（已忽略）：${describe(error)}`)
    }
  }

  /** 卸下：取消所有定时器，丢掉所有内存状态（**不**补发、不落盘）。 */
  dispose(): void {
    this.disposed = true
    for (const handle of this.timers.values()) {
      try {
        handle.cancel()
      } catch {
        /* 取消失败只影响一次判断，不能把卸载流程弄崩 */
      }
    }
    this.timers.clear()
    this.states.clear()
    this.judgedSeq.clear()
    this.sent.clear()
    this.inflight.clear()
    this.timelines.clear()
    this.scheduler.clear()
  }

  /** 诊断快照（§7.4：调度耗时可观测）。只暴露数字与布尔，**不含任何消息正文**。 */
  diagnostics(): { groups: Array<{ groupId: number } & GroupSchedulerStats>; pending: number } {
    return { groups: this.scheduler.snapshot(), pending: this.timers.size + this.inflight.size }
  }

  /** 这个群的时间线（诊断/测试用；不存在就造一个空的）。 */
  timeline(groupId: number) {
    return this.timelines.of(groupId)
  }

  /** 给**兄弟插件行**（`companion-group` 的系统提示词段）看的时间线视图。 */
  eventsView(): GroupEventsView & { detail: () => { groups: number; ambiguous: boolean } } {
    return this.timelines.view()
  }

  // ── 内部：合批定时器 ────────────────────────────────────────────────────

  /**
   * 满足条件就武装一个合批定时器，**已经武装的绝不重排**。
   *
   * 重排会让热闹的群把窗口无限往后推——这正是"判断饥饿"的老根因（§7.4）。所以等待上限
   * 由"首条消息起算 + batchQuietMs"天然成立；`judgeMaxWaitMs` 只用来在**跳过**发生时报警。
   */
  private arm(groupId: number, settings: PresenceView): void {
    if (this.timers.has(groupId)) return
    if (this.inflight.has(groupId)) {
      this.noteSkip(groupId, 'busy', this.deps.clock.now(), 0)
      return
    }
    const nowMs = this.deps.clock.now()
    const pending = [...this.pendingOf(groupId, settings)].length
    const verdict = judgeVerdict(this.stateOf(groupId), nowMs, limitsOf(settings), pending)
    if (!verdict.ok) {
      this.noteSkip(groupId, String(verdict.reason ?? 'unknown'), nowMs, pending)
      return
    }
    const wait = positiveOr(settings.batchQuietMs ?? settings.judgeIntervalMs, DEFAULTS.batchQuietMs)
    const handle = this.deps.clock.setTimeout(() => {
      this.timers.delete(groupId)
      void this.runCycle(groupId).catch((error: unknown) => {
        this.deps.log(`presence: 群 ${String(groupId)} 判断流程抛错（已忽略）：${describe(error)}`)
      })
    }, wait)
    handle.unref?.()
    this.timers.set(groupId, handle)
    this.scheduler.update(groupId, (stats) => ({
      ...stats,
      batchStartedAtMs: stats.batchStartedAtMs === 0 ? nowMs : stats.batchStartedAtMs,
      batchCount: pending,
    }))
  }

  /** 定时器到点：交给 {@link runCycleFor}（一次流程的全部细节在那里）。 */
  private async runCycle(groupId: number): Promise<void> {
    if (this.disposed) return
    this.inflight.add(groupId)
    try {
      await runCycleFor(this.cycleContext(), groupId)
    } finally {
      // 卸载之后到达的结果一律丢弃（`runCycleFor` 里已经按 `disposed` 收尾）。
      this.inflight.delete(groupId)
    }
  }

  /** 一次流程能碰到的全部外部面（每次现造：热加载后不会抓着旧对象）。 */
  private cycleContext(): CycleContext {
    return {
      clock: this.deps.clock,
      log: this.deps.log,
      platform: this.deps.platform,
      complete: this.deps.complete,
      recordSent: this.deps.recordSent,
      ambient: this.deps.ambient,
      timelines: this.timelines,
      scheduler: this.scheduler,
      settingsOf: () => this.settings(),
      stateOf: (groupId) => this.stateOf(groupId),
      applyState: (groupId, state) => {
        if (this.disposed) return
        this.states.set(groupId, state)
      },
      cursorOf: (groupId, ring) => this.cursorOf(groupId, ring),
      commitCursor: (groupId, seq) => this.judgedSeq.set(groupId, seq),
      sentLines: (groupId) => this.sentLinesOf(groupId),
      noteSpoken: (groupId, text) => {
        this.sent.set(groupId, [...(this.sent.get(groupId) ?? []), text].slice(-SENT_MEMORY))
      },
      persona: (groupId) => this.personaSnapshot(groupId),
      ...(this.deps.memory === undefined ? {} : { memory: this.deps.memory }),
      ...(this.deps.remember === undefined ? {} : { remember: this.deps.remember }),
      // 最后一道发送闸门：每次现取（不能装配时读一次，否则在途的模型结果会照发）。
      modeOf: () => {
        try {
          const mode = this.deps.mode?.()
          return typeof mode === 'string' && mode !== '' ? mode : 'live'
        } catch {
          return 'off'
        }
      },
      ...(this.deps.recordShadow === undefined ? {} : { recordShadow: this.deps.recordShadow }),
      ...(this.deps.afterSpeak === undefined ? {} : {
        onSpoken: (input: { groupId: number; action: 'reply' | 'join' | 'react'; text: string; messageId: number; atMs: number }) => {
          const topic = this.timelines.view().topic()
          this.deps.afterSpeak?.({ ...input, topic })
        },
      }),
      noteSkip: (groupId, reason, nowMs, pending) => this.noteSkip(groupId, reason, nowMs, pending),
    }
  }

  // ── 内部：观测与状态 ────────────────────────────────────────────────────

  /** 未判的旁听（不含她自己发的）。 */
  private pendingOf(groupId: number, settings: PresenceView): AmbientEntry[] {
    const nowMs = this.deps.clock.now()
    const ring = this.deps.ambient.ring(groupId, ambientLimitsOf(settings))
    return ring.peekAfter(this.cursorOf(groupId, ring), nowMs).filter((entry) => !entry.self)
  }

  /** 记一条入站消息（进时间线，顺带更新"最近一条消息"时刻）。 */
  private markMessage(groupId: number, settings: PresenceView): void {
    const nowMs = this.deps.clock.now()
    const ring = this.deps.ambient.ring(groupId, ambientLimitsOf(settings))
    const last: AmbientEntry | undefined = ring.peekAfter(Math.max(0, ring.lastSeq() - 1), nowMs).slice(-1)[0]
    this.scheduler.update(groupId, (stats) => ({ ...stats, lastMessageAtMs: nowMs }))
    if (last !== undefined) this.timelines.markInbound(groupId, last)
  }

  /** 她最近说过的话：时间线优先（P3 之后"说过什么"只有一个来源），旁听环兜底。 */
  private sentLinesOf(groupId: number): readonly string[] {
    try {
      const fromTimeline = this.timelines.recentSelfLines(groupId, TIMELINE_SELF_LIMIT)
      if (fromTimeline.length > 0) return fromTimeline.slice(-SENT_MEMORY)
    } catch {
      /* 时间线坏了就退回旁听环里的记录 */
    }
    return this.sent.get(groupId) ?? []
  }

  /** 跳过判断的记账 + 饥饿告警（"持续活跃的群不会无限期得不到判断"）。 */
  private noteSkip(groupId: number, reason: string, nowMs: number, pending: number): void {
    const settings = this.settings()
    const maxWait = positiveOr(settings?.judgeMaxWaitMs ?? DEFAULTS.judgeMaxWaitMs, DEFAULTS.judgeMaxWaitMs)
    const starved = this.scheduler.noteSkip({ groupId, reason, nowMs, pending, maxWaitMs: maxWait })
    if (!starved) return
    const stats = this.scheduler.of(groupId)
    this.deps.log(
      `presence: 群 ${String(groupId)} 判断饥饿告警——${String(pending)} 条消息已等待 `
      + `${String(nowMs - stats.batchStartedAtMs)}ms 仍未判断（原因 ${reason}）`,
    )
  }

  /**
   * 取一次人格快照（**绝不抛**：这条路径上任何异常都只能让"这一轮少一段人格"）。
   *
   * 拿不到时打一行日志——一行就够，因为"她说话不像角色"这个问题唯一的排查起点就是
   * "快照到底有没有接上"。
   */
  private personaSnapshot(groupId: number): GroupPersonaSnapshot | null {
    try {
      const snapshot = this.deps.persona()
      if (snapshot === null) {
        this.deps.log(`presence: 群 ${String(groupId)} 人格快照不可用，这一轮用降级人格`)
        return null
      }
      return snapshot
    } catch (error) {
      this.deps.log(`presence: 群 ${String(groupId)} 取人格快照抛错（已降级）：${describe(error)}`)
      return null
    }
  }

  private settings(): PresenceView | null {
    const presence = this.deps.config().presence
    return presence === undefined ? null : presence
  }

  /**
   * "已经判到哪一条"。首次见到这个群时**只留最新那一条**，并把它记下来。
   *
   * 这是"热加载/重启不补发旧批次"的另一半：缓冲里那些在她上线之前就存在的消息不会被
   * 回放。留最新这一条而不是从"此刻之后"才开始，是因为 `observe` 是流水线**先** `add`、
   * **再**调进来的——此刻最新那条正是刚发生、最该被看见的那条；丢掉它，
   * 群里要等到下一条消息才有判断，而那一批背景里还会缺掉引起话题的那一句。
   */
  private cursorOf(groupId: number, ring: { lastSeq(): number }): number {
    const recorded = this.judgedSeq.get(groupId)
    if (recorded !== undefined) return recorded
    const created = Math.max(0, ring.lastSeq() - 1)
    this.judgedSeq.set(groupId, created)
    return created
  }

  private stateOf(groupId: number): PresenceState {
    const existing = this.states.get(groupId)
    if (existing !== undefined) return existing
    // `emptyPresenceState(now)`：判断/发言时刻都从"现在"起算，重载后不会瞬间开口。
    const created = emptyPresenceState(this.deps.clock.now())
    this.states.set(groupId, created)
    return created
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
