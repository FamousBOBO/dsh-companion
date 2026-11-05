/** 会话登记处：哪个房间有一个会话、它开没开出来、什么时候该重建。
 *
 * 这一步搬的是 `ConversationBridge` 里**唯一一份可变状态**：房间键 → 会话记录。
 * 它原来和入站流水线、通知裁决、旁路观察混在同一个类里，于是"会话什么时候被建/
 * 被丢/被重建"这件事没有单一答案——四条路径（收到消息、定时任务、后台指令、
 * 启动自愈）各自去摸那个 Map。
 *
 * 搬出来之后：
 *   - 并发保护（`ensureInFlight`）只在这里出现一次，四个调用方共享同一个答案；
 *   - "重建会话"（后台按钮）与"释放会话"（卸载）都走这里，语义不会各写一遍；
 *   - 记录本身是纯数据，可以造出来直接断言，不必先跑一条真实消息。
 *
 * 时间与定时器一律走注入的 `Clock`（`check-layers` 的 R8 会拦住别的写法）。
 */

import type { OneBotEvent } from '../../types.js'
import { sessionIdOf, splitRoom } from '../../core/room.js'
import type { TurnOrigin } from './origins.js'
import type { AgentGateway, AgentSession } from '../../ports/agent-gateway.js'
import type { Clock, Random, TimerHandle } from '../../ports/clock.js'
import { TurnTracker } from './turn-tracker.js'
import type { TurnHooks } from '../../ports/turn-hooks.js'
import type { GatewayHealth } from './gateway-health.js'

/**
 * 一个房间的会话记录。
 *
 * 它是**内存里的**：进程重启后从宿主的会话目录重建（`reattachAll`）。
 * 落盘的东西（说过的话、好感度、语录）都不在这里。
 */
export interface ConversationRecord {
  /** 房间键（`group-1000000003` / `dm-1000000002`）。 */
  readonly key: string
  /** 会话 id（`qq-<key>`）；它同时是磁盘上的目录名。 */
  readonly sessionId: string
  readonly isGroup: boolean
  readonly chatId: number
  /** 打开着的宿主会话；`null` 表示还没开出来。 */
  session: AgentSession | null
  /**
   * 回合账本：忙不忙、跑完没有、失败要不要重试。
   *
   * "这个会话在跑一轮"这件事原来由十个散字段描述、三个地方分别改，现在只有
   * 一个答案（`tracker.busy()`）。
   */
  readonly tracker: TurnTracker
  /** 待成包分析的入站行。 */
  queue: string[]
  /** 等着搭下一包的图片附件。 */
  pendingImages: unknown[]
  /** 安静窗口定时器。 */
  batchTimer: TimerHandle | null
  /** 已经收过的 QQ 消息号（跨窗口去重）。 */
  seenMessageIds: Set<number> | null
  /** 最后一条入队的消息是不是"叫我"的（P6b 起接线；仅 `context.v2` 打开时消费）。 */
  calledLine: boolean
  /** 最近一条事件；会话还没物化时用它。 */
  lastEvent: OneBotEvent
  /**
   * 这一轮的发起人（本阶段只记录，不用于拦截）。
   *
   * 放在记录上而不是回合账本里：它是"这个房间最后那次回合是谁引起的"，
   * 后台按房间看时最直观，也不需要活着的会话才能读。
   */
  lastOrigin: TurnOrigin | null
}

/**
 * 登记处真正用到的配置项。
 *
 * 刻意**不** import `config.ts`：那样会把"配置"整个模块拉进 app 层（它自己带
 * 文件 IO），而这里其实只要几个值。写成结构类型之后 `QQChannelConfig` 天然满足它，
 * 组合根直接把配置传进来即可。
 */
export interface RegistryConfig {
  readonly selfId: number
  readonly workspacePath: string | null
  readonly agentPreset: string
  readonly permissionPreset: string
  readonly groupAgentPreset?: string | null
  readonly groupPermissionPreset?: string | null
  readonly groupWorkspacePath?: string | null
  readonly groupModel: { readonly provider: string | null; readonly model: string | null }
  readonly injectMode: { readonly enabled: boolean; readonly duringTurn?: boolean; readonly wakeIdle: boolean }
  readonly contextBudget: { readonly maxSteps: number }
  /**
   * 步数分档（P6b）。0 或缺省 = 沿用 `contextBudget.maxSteps`；system 档预留给
   * 系统回合（事件书 P6f）——当前只有群聊 / 私聊两种会话类型。
   */
  readonly turn?: {
    readonly maxSteps?: { readonly dm?: number; readonly group?: number; readonly system?: number }
  }
}

export interface RegistryDeps {
  readonly gateway: AgentGateway
  readonly health: GatewayHealth
  readonly clock: Clock
  /** 随机源（退避抖动用）；注入进来才能在测试里重放。 */
  readonly random: Random
  readonly log: (line: string) => void
  /** 实时读配置：路由、标题、步数上限这些都要跟着后台改。 */
  readonly config: () => RegistryConfig
  /** 网关重试要补的那句话（来自人格包；取值函数才能跟着包一起热改）。 */
  readonly nudge: () => string
  /** 每次模型错误都投递一次（换血看门狗据此识别连续 400）。 */
  readonly onGatewayError?: (room: string, detail: string) => void
  /** 回合结束钩子（A1 交互提示撤销）。 */
  readonly turnHooks?: TurnHooks
}

export class ConversationRegistry {
  private readonly records = new Map<string, ConversationRecord>()
  /** 同一个房间的并发"开会话"合并成一次（宿主那边建两次会撞 id）。 */
  private readonly inFlight = new Map<string, Promise<ConversationRecord>>()

  constructor(private readonly deps: RegistryDeps) {}

  /** 已经建出来的记录；没有就返回 undefined（不创建）。 */
  get(key: string): ConversationRecord | undefined {
    return this.records.get(key)
  }

  /** 有多少个房间登记过（后台状态页用）。 */
  size(): number {
    return this.records.size
  }

  /** 已登记的房间键快照（会话换血的看门狗要遍历它们）。 */
  keys(): string[] {
    return [...this.records.keys()]
  }

  /**
   * 取记录，没有就按这条事件建一个**空壳**（会话还没开）。
   *
   * 群消息走这条：即使这一条最后被 `requireMention` 丢掉，记录也已经在了，
   * 于是旁路观察（风控 / 口癖 / 链接卡片）与通知裁决有地方落脚。
   */
  getOrCreate(key: string, event: OneBotEvent): ConversationRecord {
    const existing = this.records.get(key)
    if (existing !== undefined) return existing
    const record = this.makeRecord(key, event)
    this.records.set(key, record)
    return record
  }

  /**
   * 确保这个房间的会话是开着的。
   *
   * 并发安全：同一个房间同时来两条消息时只开一次（后来者复用前一次的结果）。
   */
  async ensure(key: string, event: OneBotEvent): Promise<ConversationRecord> {
    const existing = this.records.get(key)
    if (existing !== undefined && existing.session !== null) return existing
    const pending = this.inFlight.get(key)
    if (pending !== undefined) return pending
    const run = this.open(key, event).finally(() => { this.inFlight.delete(key) })
    this.inFlight.set(key, run)
    return run
  }

  /**
   * 定时任务可能在任何一条消息之前触发（刚部署、群里还没人说话），
   * 那时记录得凭房间键本身合成出来，而不是等一条真实消息。
   */
  bootstrap(key: string): ConversationRecord | undefined {
    const existing = this.records.get(key)
    if (existing !== undefined) return existing
    const room = splitRoom(key)
    if (room === null) return undefined
    return this.getOrCreate(key, {
      time: Math.floor(this.deps.clock.now() / 1000),
      self_id: this.deps.config().selfId,
      post_type: 'message',
      message_type: room.isGroup ? 'group' : 'private',
      ...(room.isGroup ? { group_id: room.chatId } : { user_id: room.chatId }),
    })
  }

  /**
   * 丢掉一个房间的内存记录，让下一条消息重建它。
   *
   * 后台「重建会话」用它：改完人格或换过人设预设之后，落盘的会话里还带着旧的
   * 组合，所以**会话产物与这条记录都得没**，新指令才会生效。发出的消息日志
   * （sent-log）故意保留——那是"她说过什么"的历史，不是人格。
   */
  forget(key: string): boolean {
    const record = this.records.get(key)
    if (record === undefined) return false
    this.releaseTimers(record)
    this.records.delete(key)
    this.deps.log(`forgot conversation ${key} (will rebuild on the next message)`)
    return true
  }

  /**
   * 拆掉这个房间的活会话——**只有本插件建出来的才拆得动**。
   *
   * `agents.get()` 给的是一个**裸** Agent，释放能力归创建者；只是挂回来的会话
   * 拆不掉，调用方不能假设这里一定成功。
   *
   * @returns 真的拆掉了为 true。
   */
  async dispose(key: string): Promise<boolean> {
    const record = this.records.get(key)
    if (record === undefined) return false
    const session = record.session
    if (session === null) return false
    try {
      // "拆不掉"（只是挂回来的会话）与"拆失败"是两件事，见 AgentSession.dispose。
      if (!(await session.dispose())) return false
    } catch (error) {
      this.deps.log(`dispose agent for ${key} failed: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
    this.releaseTimers(record)
    this.records.delete(key)
    this.deps.log(`disposed agent for ${key}`)
    return true
  }

  /** 卸载：释放全部定时器与重试链。 */
  disposeAll(): void {
    for (const record of this.records.values()) this.releaseTimers(record)
  }

  /**
   * 启动自愈：把每个已落盘的 `qq-*` 会话重新挂到配置的工作区上。
   *
   * 自愈**失败不能挡住启动**，所以这里吞掉异常只记一行；怎么扫目录是宿主的
   * 布局知识，在网关里。
   */
  async reattachAll(): Promise<void> {
    try {
      const config = this.deps.config()
      await this.deps.gateway.reattachAll(config.workspacePath ?? '', config.groupWorkspacePath)
    } catch (error) {
      this.deps.log(`self-heal failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 这一轮的步数上限：先看分档，档位为 0（或缺省）时回退到旧的 contextBudget.maxSteps。 */
  private stepBudgetFor(record: ConversationRecord): number {
    const config = this.deps.config()
    const tier = record.isGroup ? config.turn?.maxSteps?.group : config.turn?.maxSteps?.dm
    if (typeof tier === 'number' && tier > 0) return tier
    return config.contextBudget.maxSteps
  }

  /** 记下这一包用的是哪条路由：群聊可以单独配（千问），否则走宿主默认。 */
  private routeFor(record: ConversationRecord): { provider: string; model: string } {
    const group = this.deps.config().groupModel
    if (record.isGroup && group.provider !== null && group.model !== null) {
      return { provider: group.provider, model: group.model }
    }
    return this.deps.gateway.defaultRoute()
  }

  private async open(key: string, event: OneBotEvent): Promise<ConversationRecord> {
    const record = this.getOrCreate(key, event)
    const config = this.deps.config()
    const route = this.routeFor(record)
    const session = await this.deps.gateway.open({
      sessionId: sessionIdOf(key),
      cwd: record.isGroup ? config.groupWorkspacePath ?? config.workspacePath ?? '' : config.workspacePath ?? '',
      presetId: record.isGroup ? config.groupAgentPreset ?? config.agentPreset : config.agentPreset,
      provider: route.provider,
      model: route.model,
      title: record.isGroup ? `QQ 群${record.chatId}` : `QQ 私聊${record.chatId}`,
      permissionPreset: record.isGroup ? config.groupPermissionPreset ?? config.permissionPreset : config.permissionPreset,
      // 取值函数而不是快照：后台把步数上限从 0 改成 20 必须立即生效。
      stepBudget: () => this.stepBudgetFor(record),
      // 回合账本自己就是监听器：宿主报 idle/error 直接落到它的状态迁移上。
      listener: record.tracker,
      log: this.deps.log,
    })
    record.session = session
    record.tracker.bind(session)
    this.records.set(key, record)
    this.deps.log(`session ${session.id} ready for ${key}`)
    return record
  }

  private makeRecord(key: string, event: OneBotEvent): ConversationRecord {
    return {
      key,
      sessionId: sessionIdOf(key),
      isGroup: event.message_type === 'group',
      chatId: (event.group_id ?? event.user_id) ?? 0,
      session: null,
      tracker: new TurnTracker({
        room: key,
        health: this.deps.health,
        clock: this.deps.clock,
        log: this.deps.log,
        nudge: this.deps.nudge,
        injectMode: () => this.deps.config().injectMode,
        roll: () => this.deps.random.next(),
        ...this.deps.onGatewayError === undefined ? {} : { onGatewayError: this.deps.onGatewayError },
        ...this.deps.turnHooks === undefined ? {} : {
          onTurnEnd: (room: string) => this.deps.turnHooks?.end(room),
          onTurnError: (room: string, kind: 'retry' | 'permanent') => this.deps.turnHooks?.error?.(room, kind),
        },
      }),
      queue: [],
      pendingImages: [],
      seenMessageIds: new Set(),
      batchTimer: null,
      calledLine: false,
      lastEvent: event,
      lastOrigin: null,
    }
  }

  private releaseTimers(record: ConversationRecord): void {
    record.batchTimer?.cancel()
    record.batchTimer = null
    record.tracker.dispose()
  }
}
