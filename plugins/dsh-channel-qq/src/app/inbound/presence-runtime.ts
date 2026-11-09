/** 群聊旁听的**状态机**：合批定时器、每群游标、限频记账、卸载。
 *
 * 分层：背景缓冲在 `core/ambient.ts`、限频记账在 `core/presence.ts`、时间线在
 * `presence-timeline.ts`、调度观测在 `presence-scheduler.ts`、一次判断的编排在
 * `presence-cycle.ts`、**本文件**只管常驻状态与定时器。
 *
 * 六条硬约束：1) `observe` 非阻塞（入站不等模型）；2) 旁听环不归我写（`captureAmbient`
 * 负责 `add`，这里只读并推进游标）；3) platform / persona / memory 每次现取（热加载会换
 * 掉旧对象）；4) 热加载不补发（`emptyPresenceState(now)` 把上次判断时刻置成"现在"）；
 * 5) 同群不并发（`inflight`）；6) 不重排已武装的定时器——`starvationWarnMs` 只用来报警。
 *
 * 这里不碰盘、不建会话、不给工具：自主发言由通道直接发，不经过群 agent（§0.8）。
 */

import { emptyPresenceState, judgeVerdict, type PresenceState } from '../../core/presence.js'
import type { AmbientEntry } from '../../core/ambient.js'
import { ambientLimitsOf, presenceAppliesTo, type AmbientStore } from './ambient-store.js'
import { DEFAULTS, limitsOf, positiveOr, type CompletePort, type PresenceView } from './presence-flow.js'
import { GroupTimelineBook, type GroupEventsScopedView, type GroupEventsView } from './presence-timeline.js'
import { GroupSchedulerBook, type GroupSchedulerStats } from './presence-scheduler.js'
import { runCycleFor, SENT_MEMORY, TIMELINE_SELF_LIMIT, type CycleContext } from './presence-cycle.js'
import { quietWaitMs, starvationWarnMs } from './presence-cadence.js'
import { personaSnapshotOf, sentLinesOf, starvationLine } from './presence-reads.js'
import type { Clock, TimerHandle } from '../../ports/clock.js'
import type { ChatPlatform } from '../../ports/platform.js'
import type { JudgeEntry } from './presence-judge.js'
import type { GroupPersonaSnapshot } from './group-persona.js'
import type { GroupMemoryRecall } from './group-memory-contract.js'
import type { CandidateFact } from '../../core/group-memory-extract.js'
import type { RegistryFile } from '../../core/participant.js'

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
  /** 语义复核档位（P6-B）：`off` / `warn` / `enforce`；缺省 = `warn`。 */
  readonly guardMode?: () => string
  /**
   * 参与者注册表（P9-G4 §2.2）：**每次现取**；缺省 = 没装，全员"身份未确认"。
   *
   * 为什么由执行器持有、再转给判断层：注册表是判断输入（"谁在说话"），而执行器是
   * 唯一同时看得到配置与判断入口的地方。装配侧只把"怎么读"递进来一次。
   */
  readonly registry?: () => RegistryFile | null
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
  /** 每群的限频状态 / 判断游标 / 定时器 / 在途 / 自述缓存（全部按群分，互不影响）。 */
  private readonly states = new Map<number, PresenceState>()
  private readonly judgedSeq = new Map<number, number>()
  private readonly timers = new Map<number, TimerHandle>()
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

  /** 诊断快照（§7.4）：只暴露数字与布尔，**不含任何消息正文**。 */
  diagnostics(): { groups: Array<{ groupId: number } & GroupSchedulerStats>; pending: number } {
    return { groups: this.scheduler.snapshot(), pending: this.timers.size + this.inflight.size }
  }

  /** 这个群的时间线（诊断/测试用；不存在就造一个空的）。 */
  timeline(groupId: number) {
    return this.timelines.of(groupId)
  }

  /** **按群号**查询的时间线视图（P7-A）：群号由调用方从宿主路由拿到，这里不做任何推断。 */
  scopedEventsView(): GroupEventsScopedView {
    return this.timelines.scopedView()
  }

  /** 记一次连续性上下文注入结果（P7-C）：`denied` 只在真的不该给时加一（见 `noteContinuity`）。 */
  noteContinuity(groupId: number, outcome: 'injected' | 'denied'): void {
    this.scheduler.noteContinuity(groupId, outcome)
  }

  /** @deprecated 用 {@link scopedEventsView}（这个视图拿不到群号，两个群同时活跃时两边都读不到）。 */
  eventsView(): GroupEventsView & { detail: () => { groups: number; ambiguous: boolean } } {
    return this.timelines.view()
  }

  // ── 内部：合批定时器 ────────────────────────────────────────────────────

  /**
   * 满足条件就武装一个合批定时器，**已经武装的绝不重排**——重排会让热闹的群把窗口无限
   * 往后推，那正是"判断饥饿"的老根因。硬门槛优先：暂停中 / 同群在途 / 没待判内容 /
   * 还不到间隔时都不判断，只记一次跳过原因。等待时长见 `quietWaitMs`。
   */
  private arm(groupId: number, settings: PresenceView): void {
    if (this.timers.has(groupId)) return
    if (this.inflight.has(groupId)) {
      this.noteSkip(groupId, 'busy', this.deps.clock.now(), 0)
      return
    }
    const nowMs = this.deps.clock.now()
    const pending = this.pendingOf(groupId, settings).length
    const startedAt = this.batchStartOf(groupId, nowMs, pending)
    const state = this.stateOf(groupId)
    const verdict = judgeVerdict(state, nowMs, limitsOf(settings), pending)
    if (!verdict.ok) {
      this.noteSkip(groupId, String(verdict.reason ?? 'unknown'), nowMs, pending)
      return
    }
    this.scheduleCycle(groupId, quietWaitMs(settings))
  }

  /** 这一批的起点（首次武装时记，判完由 `recordOutcome` 清零）。 */
  private batchStartOf(groupId: number, nowMs: number, pending: number): number {
    const stats = this.scheduler.of(groupId)
    const startedAt = stats.batchStartedAtMs === 0 ? nowMs : stats.batchStartedAtMs
    this.scheduler.update(groupId, (current) => ({
      ...current,
      batchStartedAtMs: startedAt,
      batchCount: pending,
    }))
    return startedAt
  }

  /** 武装一个 `waitMs` 之后跑一次判断的定时器（`waitMs <= 0` 表示下一个微任务就判）。 */
  private scheduleCycle(groupId: number, waitMs: number): void {
    const handle = this.deps.clock.setTimeout(() => {
      this.timers.delete(groupId)
      void this.runCycle(groupId).catch((error: unknown) => {
        this.deps.log(`presence: 群 ${String(groupId)} 判断流程抛错（已忽略）：${describe(error)}`)
      })
    }, Math.max(0, Math.trunc(waitMs)))
    handle.unref?.()
    this.timers.set(groupId, handle)
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
      // 参与者注册表（P9-G4 §2.2）：没装就是 null —— 全员"身份未确认"，判断照常跑。
      registry: () => this.deps.registry?.() ?? null,
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
      // 真实的平台发送尝试（P9-A3）：耗时只含平台调用本身，失败也计入。
      noteSend: (input: { groupId: number; latencyMs: number; ok: boolean }) => this.scheduler.noteSend(input),
      // 语义复核档位（P6-B）+ 她自己的号（P6-A）：两个都每次现取。
      guardMode: () => this.deps.guardMode?.() ?? 'warn',
      selfId: () => {
        try {
          const id = this.deps.platform().selfId
          return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : 0
        } catch {
          return 0
        }
      },
      ...(this.deps.recordShadow === undefined ? {} : { recordShadow: this.deps.recordShadow }),
      ...(this.deps.afterSpeak === undefined ? {} : {
        // 话题**按群号**取（P9-G §1 的修复）：`view().topic()` 是「唯一活跃群」的旧降级，
        // 两个群都有消息时它返回 null，于是「说完之后贴表情」那层什么都拿不到。
        onSpoken: (input: Parameters<NonNullable<CycleContext['onSpoken']>>[0]) => {
          this.deps.afterSpeak?.({ ...input, topic: this.timelines.scopedView().topic(input.groupId) })
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

  /** 她最近说过的话（时间线优先、旁听环兜底；细节见 `presence-reads.ts`）。 */
  private sentLinesOf(groupId: number): readonly string[] {
    return sentLinesOf({
      groupId,
      fromTimeline: () => this.timelines.recentSelfLines(groupId, TIMELINE_SELF_LIMIT),
      fallback: this.sent.get(groupId) ?? [],
      limit: SENT_MEMORY,
    })
  }

  /**
   * 跳过判断的记账 + 饥饿告警。
   *
   * `starvationWarnMs` **只用来报警**，不改变调度（理由见 `presence-cadence.ts` 文件头：
   * 把上限真的接进调度会在特定配置下静默缩短合批窗口，而那种偏差没人能从日志看出来）。
   * 告警本身仍然必要：它把"限频/暂停/退避导致的安静"与"群里没人说话"分开。
   */
  private noteSkip(groupId: number, reason: string, nowMs: number, pending: number): void {
    const warnMs = starvationWarnMs(this.settings())
    const starved = this.scheduler.noteSkip({ groupId, reason, nowMs, pending, maxWaitMs: warnMs })
    if (!starved) return
    const stats = this.scheduler.of(groupId)
    this.deps.log(starvationLine({ groupId, pending, waitedMs: nowMs - stats.batchStartedAtMs, reason }))
  }

  /**
   * 取一次人格快照（**绝不抛**：这条路径上任何异常都只能让"这一轮少一段人格"）。
   *
   * 拿不到时打一行日志——一行就够，因为"她说话不像角色"这个问题唯一的排查起点就是
   * "快照到底有没有接上"。
   */
  private personaSnapshot(groupId: number): GroupPersonaSnapshot | null {
    return personaSnapshotOf({ groupId, persona: this.deps.persona, log: this.deps.log })
  }

  private settings(): PresenceView | null {
    const presence = this.deps.config().presence
    return presence === undefined ? null : presence
  }

  /**
   * "已经判到哪一条"。首次见到这个群时**只留最新那一条**：这是"热加载/重启不补发旧批次"
   * 的另一半（上线前的消息不回放）。留最新而不是从"此刻之后"开始，是因为 `observe` 是
   * 流水线**先** `add`、**再**调进来的——最新那条正是刚发生、最该被看见的那条。
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
