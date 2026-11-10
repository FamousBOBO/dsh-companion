/** 每群的**统一事件时间线**簿记（P3 §7.1）：把"群消息 / 她的发言 / 话题切换"记进同一条线。
 *
 * 为什么从 `presence-runtime.ts` 拆出来：那个类的职责是**调度**（合批定时器、限频、在途、
 * 卸载），而时间线是**存储**（去重、裁剪、话题识别）。两件事放一个类里，文件会一路长到
 * 六百多行（`check:size` 的硬上限 400 行就是为这种情况设的），而且"这条消息到底进没进时间线"
 * 会散落在七个私有方法里。
 *
 * 三条纪律（与 `core/group-events.ts` 一致）：
 *   1. **只按群分实例**：跨群复用梗是硬性禁止项，所以每个群一份 `GroupTimeline`，
 *      没有任何"遍历所有群"的读接口；
 *   2. **只记不判**：这里不做"要不要说话"的判断，只负责"发生过什么"；
 *   3. **绝不抛**：时间线是上下文与诊断，坏了只该少一段背景，不该影响入站。
 */

import { GroupTimeline, inboundEventOf, selfEventOf, type GroupEvent } from '../../core/group-events.js'
import { refineTopic } from '../../core/group-topic.js'
import type { AmbientEntry } from '../../core/ambient.js'
import type { Clock } from '../../ports/clock.js'

/** 每群的时间线：条数与时间窗双上限（短期上下文，不是记忆）。 */
const TIMELINE_LIMITS = { maxEvents: 200, ttlMs: 1_800_000 } as const

/** 旧视图（唯一活跃群降级）。@deprecated 用 {@link GroupEventsScopedView}。 */
export interface GroupEventsView {
  recentSelf: (limit?: number) => Array<{ text: string; atMs: number; kind: string }>
  topic: () => string | null
  detail: () => { groups: number; ambiguous: boolean }
}

/**
 * **按群号**查询的视图（P7-A）。
 *
 * 形状刻意是"每个方法第一个参数都是 groupId"：调用方必须**自己**把群号拿出来。
 * 想省掉这个参数就得猜，而猜群号正是跨群复用的起点（§8.4）。
 */
export interface GroupEventsScopedView {
  recentSelf: (groupId: number, limit?: number) => Array<{ text: string; atMs: number; kind: string }>
  topic: (groupId: number) => string | null
  detail: (groupId: number) => { valid: boolean; events: number }
}

/** 一条"她自己发的"事件（由拿到回执的那一层传进来）。 */
export interface SelfEventInput {
  readonly kind: 'proactive_message' | 'agent_reply'
  readonly messageId: number
  readonly text: string
  readonly atMs: number
}

/** 每群一条时间线的持有者。 */
export class GroupTimelineBook {
  private readonly timelines = new Map<number, GroupTimeline>()

  constructor(private readonly clock: Clock) {}

  /** 卸下（热重载/关通道）：全清，不落盘、不补发。 */
  clear(): void {
    this.timelines.clear()
  }

  /** 这个群的时间线（不存在就造一个）。 */
  of(groupId: number): GroupTimeline {
    const existing = this.timelines.get(groupId)
    if (existing !== undefined) return existing
    const created = new GroupTimeline(TIMELINE_LIMITS)
    this.timelines.set(groupId, created)
    return created
  }

  /**
   * 记一条入站消息（成功进入旁听环之后调）。
   *
   * 只记**入站那一刻的最新一条**：`observe` 是流水线先 `add` 再调进来的，所以环里
   * 最后一条就是刚发生的这条。重复调用由 `eventId` 去重，不会记两条。
   */
  markInbound(groupId: number, entry: AmbientEntry): void {
    try {
      const nowMs = this.clock.now()
      const timeline = this.of(groupId)
      timeline.append(
        inboundEventOf({
          groupId,
          messageId: entry.messageId,
          senderId: entry.userId,
          senderName: entry.name,
          content: entry.body ?? entry.text,
          timestamp: entry.atMs,
          self: entry.self,
        }),
        nowMs,
      )
      this.noteTopic(groupId, timeline, nowMs)
    } catch {
      /* 时间线是上下文，不该影响入站 */
    }
  }

  /** 记一条她自己的发言（**只有拿到回执**才调，见 `presence-flow.ts`）。 */
  recordSelf(groupId: number, event: SelfEventInput): void {
    this.of(groupId).append(
      selfEventOf({
        groupId,
        messageId: event.messageId,
        content: event.text,
        timestamp: event.atMs,
        kind: event.kind,
        senderId: 0,
      }),
      event.atMs,
    )
  }

  /** 她最近说过的话（时间正序；不含话题事件）。 */
  recentSelfLines(groupId: number, limit: number): string[] {
    const nowMs = this.clock.now()
    return this.of(groupId)
      .recentSelf(nowMs, limit)
      .map((event: GroupEvent) => event.content)
      .filter((text) => text !== '')
  }

  /**
   * **按群号**查询的视图（P7-A：多群连续性）。
   *
   * 这是唯一正确的形状：每个群回合只能读自己那个群的事件与话题。群号由调用方从
   * 宿主路由里拿（`conversation.chatId`），**不许**从提示词原文、群昵称、自称里推断。
   *
   * 三条 fail-closed：
   *   1. 群号不是安全正整数 → 返回空（不猜、不退回"最近活跃的那个群"）；
   *   2. 这个群没有时间线 → 返回空（不是错误，只是"还没有记录"）；
   *   3. 任何内部异常 → 返回空。
   *
   * 历史说明：上一版是"唯一活跃群时给数据"（`view()`），那是**拿不到群号时的降级**，
   * 不是多群方案——两个群同时活跃就两边都读不到。P7 把查询改成显式带群号之后，
   * 那个降级不再需要，这里一并删掉（见 `docs/10b-group-multi-room.md`）。
   */
  scopedView(): GroupEventsScopedView {
    const timelineOf = (groupId: number): GroupTimeline | null => {
      if (!Number.isSafeInteger(groupId) || groupId <= 0) return null
      return this.timelines.get(groupId) ?? null
    }
    return {
      recentSelf: (groupId, limit = 6) => {
        const timeline = timelineOf(groupId)
        if (timeline === null) return []
        const cap = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 6) : 6
        return timeline
          .recentSelf(this.clock.now(), cap)
          .map((event) => ({ text: event.content, atMs: event.timestamp, kind: event.kind }))
      },
      topic: (groupId) => {
        const timeline = timelineOf(groupId)
        return timeline === null ? null : (timeline.recentTopic(this.clock.now()) ?? null)
      },
      detail: (groupId) => {
        const timeline = timelineOf(groupId)
        return {
          valid: timeline !== null,
          events: timeline === null ? 0 : timeline.size(this.clock.now()),
        }
      },
    }
  }

  /**
   * 给**兄弟插件行**看的旧视图（唯一活跃群降级）。
   *
   * **不要在新代码里用**：计划 §4.1 要求"每个 Agent 群回合只能读取自身 groupId 的事件和话题"，
   * 而这个视图拿不到群号。保留它只是为了旧装配在热重载期间不至于报错。
   *
   * @deprecated 用 {@link scopedView}（显式带群号）。
   */
  view(): GroupEventsView {
    const activeGroups = (): number[] => {
      const nowMs = this.clock.now()
      return [...this.timelines.entries()]
        .filter(([, timeline]) => timeline.size(nowMs) > 0)
        .map(([groupId]) => groupId)
    }
    const only = (): GroupTimeline | null => {
      const groups = activeGroups()
      if (groups.length !== 1) return null
      return this.timelines.get(groups[0] as number) ?? null
    }
    return {
      recentSelf: (limit = 6) => {
        const timeline = only()
        if (timeline === null) return []
        const cap = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 6) : 6
        return timeline
          .recentSelf(this.clock.now(), cap)
          .map((event) => ({ text: event.content, atMs: event.timestamp, kind: event.kind }))
      },
      topic: () => {
        const timeline = only()
        return timeline === null ? null : (timeline.recentTopic(this.clock.now()) ?? null)
      },
      detail: () => {
        const groups = activeGroups().length
        return { groups, ambiguous: groups > 1 }
      },
    }
  }

  /**
   * 记一次话题快照（§7.1 的 `topic_change`）。
   *
   * 只在**话题真的变了**时记一条：每来一条消息都记，时间线会被话题事件淹没，而"她刚刚
   * 说过什么"就会被挤出去。
   */
  private noteTopic(groupId: number, timeline: GroupTimeline, nowMs: number): void {
    const live = timeline.live(nowMs).filter((event) => event.kind !== 'topic_change')
    const guess = refineTopic(live.map((event) => ({ text: event.content, atMs: event.timestamp, self: event.self })))
    if (guess === null) return
    if (timeline.recentTopic(nowMs) === guess.topic) return
    timeline.append(
      {
        groupId,
        // 话题没有平台消息号：用"群 + 时刻 + 话题前缀"合成稳定 id，重算也不会进两条。
        eventId: `topic:${String(groupId)}:${String(nowMs)}:${guess.topic.slice(0, 8)}`,
        senderId: 0,
        kind: 'topic_change',
        content: guess.topic,
        topicId: guess.topic,
        timestamp: nowMs,
        source: 'presence',
        self: false,
      },
      nowMs,
    )
  }
}
