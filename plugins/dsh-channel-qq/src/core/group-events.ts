/** 统一**群聊事件时间线**（P3 §7.1）：把入站消息、被 @ 的回复、自主发言、轻量反应、
 * 话题切换都记成同一种事件，让"她刚刚说过什么 / 群里刚刚发生过什么"只有**一个**来源。
 *
 * 为什么要有它（而不是继续用 `AmbientRing`）：`AmbientRing` 的角色是"旁听缓冲"——它服务
 * 的是"被 @ 时带点背景"，游标语义（`take` 交付一次）与判断语义（`peekAfter` 只看不动）混在
 * 一个对象上。自主发言要能被**后续回合**看到（§7.2），就必须有一个按 `eventId`/`messageId`
 * 去重、能按时间窗口裁剪、且与长期记忆无关的东西。
 *
 * 四条硬规矩：
 *   1. **平台消息以真实 `messageId` 去重**（NapCat 会重推、窗口会回显）；没有号的合成事件用
 *      `eventId` 去重。同一条自主发言**绝不能**进两次时间线。
 *   2. **只按时间窗口裁剪**（条数 + 毫秒双上限），不做"重要性"筛选：这是短期上下文，不是记忆。
 *   3. **与长期记忆分离**：这里不落盘、不调用任何存储（重载即清空，符合"重启不补发"）。
 *   4. **纯**：不读时钟、不写盘、不联网——时间由调用方传入（R8）。
 */

/** 事件种类（§7.1 原样）。 */
export type GroupEventKind =
  | 'inbound_message'
  | 'agent_reply'
  | 'proactive_message'
  | 'reaction'
  | 'topic_change'

/** 事件的来源侧。 */
export type GroupEventSource = 'qq' | 'agent' | 'presence'

/** 一条群事件。 */
export interface GroupEvent {
  readonly groupId: number
  /** 稳定 id：`msg:<messageId>` / `presence:<messageId>` / `topic:<groupId>:<atMs>`。 */
  readonly eventId: string
  readonly messageId?: number
  readonly senderId: number
  readonly senderName?: string
  readonly kind: GroupEventKind
  readonly content: string
  readonly timestamp: number
  readonly topicId?: string
  readonly source: GroupEventSource
  /** 她自己发的（`proactive_message` 一定是；`agent_reply` 通常也是）。 */
  readonly self: boolean
}

/** 时间线上限：条数 + 时间窗（双上限，谁先到按谁裁）。 */
export interface TimelineLimits {
  readonly maxEvents: number
  readonly ttlMs: number
}

/** 记一条的结果：`added` / `duplicate`（同一个号已经在里面）/ `rejected`（没有可用 id）。 */
export type AppendOutcome = 'added' | 'duplicate' | 'rejected'

/**
 * 每群一条时间线。
 *
 * 为什么按群分实例而不是内部 Map：调用方（`AmbientStore` 那一层）已经是"群 → 对象"的结构，
 * 这里再做一层分发只会让"这个群到底有没有时间线"变成两个地方判断。
 */
export class GroupTimeline {
  private events: GroupEvent[] = []

  constructor(public limits: TimelineLimits) {}

  /** 换上限（配置热更新）：立即按新上限裁剪，不迁移历史。 */
  configure(limits: TimelineLimits): void {
    this.limits = limits
    this.trim()
  }

  /** 记一条。先去重、再入列（顺序反了，去重就没有意义）。 */
  append(event: GroupEvent, nowMs: number): AppendOutcome {
    this.prune(nowMs)
    if (!Number.isFinite(event.timestamp) || event.eventId.trim() === '') return 'rejected'
    if (event.kind !== 'topic_change' && typeof event.messageId === 'number'
      && this.events.some((existing) => existing.messageId === event.messageId && existing.kind === event.kind)) {
      // 同一个消息号 + 同一种事件 = 同一条事实。`agent_reply` 与 `proactive_message` 分开算：
      // 一次被 @ 的回复和一次自主发言可能是同一个号的两面，合并会丢掉"这是主动说的"这条信息。
      return 'duplicate'
    }
    if (this.events.some((existing) => existing.eventId === event.eventId)) return 'duplicate'
    this.events.push(event)
    this.trim()
    return 'added'
  }

  /** 未过期的事件（时间正序）。 */
  live(nowMs: number): GroupEvent[] {
    const ttl = positive(this.limits.ttlMs, 900_000)
    return this.events.filter((event) => event.timestamp + ttl > nowMs)
  }

  /** 最近 N 条**她自己的**发言（`proactive_message` / `agent_reply`），时间正序。 */
  recentSelf(nowMs: number, limit = 6): GroupEvent[] {
    return this.live(nowMs).filter((event) => event.self).slice(-Math.max(1, limit))
  }

  /** 最近一条事件（判断"刚刚发生过什么"用）。 */
  latest(nowMs: number): GroupEvent | null {
    const live = this.live(nowMs)
    return live.length === 0 ? null : (live[live.length - 1] ?? null)
  }

  /**
   * 当前话题（`topic_change` 事件携带的 `topicId`）。
   *
   * 为什么单独一个方法：话题在`GroupEvent`里是**事件**而不是状态，消费方（被 @ 的回合）
   * 只想知道"现在在聊什么"，不想自己筛事件。没有话题事件就 `null`——不猜、不用最近一条
   * 消息冒充话题。
   */
  recentTopic(nowMs: number): string | null {
    const live = this.live(nowMs)
    for (let i = live.length - 1; i >= 0; i -= 1) {
      const event = live[i]
      if (event?.kind === 'topic_change' && typeof event.topicId === 'string' && event.topicId.trim() !== '') {
        return event.topicId.trim()
      }
    }
    return null
  }

  /** 条数（诊断用）。 */
  size(nowMs: number): number {
    return this.live(nowMs).length
  }

  private prune(nowMs: number): void {
    const ttl = positive(this.limits.ttlMs, 900_000)
    this.events = this.events.filter((event) => event.timestamp + ttl > nowMs)
  }

  private trim(): void {
    const maxEvents = positive(this.limits.maxEvents, 200)
    if (this.events.length > maxEvents) this.events = this.events.slice(-maxEvents)
  }
}

/** 从一条入站消息造事件（`messageId` 缺省时退回"合成 id"，绝不猜一个号）。 */
export function inboundEventOf(input: {
  groupId: number
  messageId?: number | null
  senderId: number
  senderName?: string
  content: string
  timestamp: number
  self?: boolean
}): GroupEvent {
  const hasId = typeof input.messageId === 'number' && Number.isSafeInteger(input.messageId) && input.messageId > 0
  return {
    groupId: input.groupId,
    eventId: hasId ? `msg:${String(input.messageId)}` : `syn:${String(input.groupId)}:${String(input.timestamp)}:${String(input.senderId)}`,
    ...(hasId ? { messageId: input.messageId as number } : {}),
    senderId: input.senderId,
    ...(input.senderName === undefined || input.senderName === '' ? {} : { senderName: input.senderName }),
    kind: 'inbound_message',
    content: input.content,
    timestamp: input.timestamp,
    source: 'qq',
    self: input.self === true,
  }
}

/** 她发出去的一条（自主发言 / 被 @ 的回复）。 */
export function selfEventOf(input: {
  groupId: number
  messageId: number
  content: string
  timestamp: number
  kind: 'proactive_message' | 'agent_reply' | 'reaction'
  senderId: number
}): GroupEvent {
  const prefix = input.kind === 'proactive_message' ? 'presence' : 'agent'
  return {
    groupId: input.groupId,
    eventId: `${prefix}:${String(input.messageId)}`,
    messageId: input.messageId,
    senderId: input.senderId,
    kind: input.kind,
    content: input.content,
    timestamp: input.timestamp,
    source: input.kind === 'proactive_message' ? 'presence' : 'agent',
    self: true,
  }
}

function positive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback
}
