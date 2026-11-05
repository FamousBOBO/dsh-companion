/** 发起回合：把一包内容交给会话，以及主动/定时/后台那几条入口。
 *
 * 这一步搬的是"**谁在什么时候替模型开一个回合**"。原来它在 `bridge.ts` 里与入站
 * 流水线同处一个类，于是"她说的话"有两条来源（用户消息、主动行为）却共用一份
 * 投递代码——改一处很难说清影响的是哪一条。
 *
 * 搬出来之后：
 *   - 投递的**状态迁移**在 `TurnTracker`（忙不忙、失败怎么重试）；
 *   - 投递的**文案**在 `PromptComposer`（人格包）；
 *   - 这里只剩"把这两者接起来"，以及四个入口共同的守卫（有一轮在跑就不插队）。
 */

import type { OneBotEvent } from '../../types.js'
import { dmRoom, splitRoom } from '../../core/room.js'
import { timeContext } from '../../core/schedule/stamp.js'
import type { Clock } from '../../ports/clock.js'
import type { PromptPart } from '../../ports/agent-gateway.js'
import type { ConversationRecord, ConversationRegistry } from './registry.js'
import { ADMIN, PROACTIVE, type TurnOrigin } from './origins.js'
import type { PromptComposer } from './prompt-composer.js'
import type { TurnHooks } from '../../ports/turn-hooks.js'

/** "她最近说过什么"的一段渲染结果（按房间取）。 */
export interface SentLogReader {
  /** 渲染成一段提示词；没说过话时返回空串。 */
  render(): string
}

/** 发起回合用到的配置。 */
export interface TurnsConfig {
  readonly selfId: number
  readonly admins: readonly number[]
}

export interface TurnLauncherDeps {
  readonly registry: ConversationRegistry
  readonly prompts: PromptComposer
  readonly clock: Clock
  readonly log: (line: string) => void
  readonly config: () => TurnsConfig
  /** 取某个房间的出站消息日志；文件在哪儿是部署知识，由组合根提供。 */
  readonly openSentLog: (room: string) => Promise<SentLogReader>
  /** 每回合开头的运行环境事实（模型 / 图片能力 / 窗口）；缺省 = 不加。 */
  readonly runtimeNote?: () => string
  /** 回合生命周期钩子（A1 交互提示）；缺省 = 什么都不做。 */
  readonly hooks?: TurnHooks
}

export class TurnLauncher {
  private readonly sentLogs = new Map<string, Promise<SentLogReader>>()

  constructor(private readonly deps: TurnLauncherDeps) {}

  /** 某个房间"她最近说过的话"，渲染成一段提示词（空串表示没什么可给）。 */
  async sentBlockFor(room: string): Promise<string> {
    return (await this.sentLogFor(room)).render()
  }

  /**
   * 把一包交给会话。
   *
   * 走哪条通道（inject / steer / followup）由回合账本决定；这里只管把正文与附件
   * 拼成端口形状。
   */
  submit(
    conversation: ConversationRecord,
    prompt: string,
    imageRefs: readonly unknown[] = [],
    origin: TurnOrigin = PROACTIVE,
  ): void {
    // 运行环境事实放在每个回合的最前面：模型会把历史里的旧结论当事实，
    // 每回合明确一次「现在是什么样子、旧说法作废」（2026-10-20 看图事故）。
    const note = this.deps.runtimeNote?.() ?? ''
    const text = note === '' ? prompt : `${note}
${prompt}`
    // 新的一包顶掉旧的网关重试：旧包的问题已经被新内容取代了。
    // A1：只有用户消息引起的回合才有"对方正在等"——主动/定时/后台不提示。
    if (origin.kind === 'user') this.deps.hooks?.begin(conversation.key, conversation.lastEvent)
    conversation.tracker.begin(text, imageRefs.length > 0)
    // 记下是谁引起的这一轮（P6 的信任分级会读它；现在只记录）。
    conversation.lastOrigin = origin
    const content: PromptPart[] = [{ type: 'text', text }]
    for (const attachment of imageRefs) content.push({ type: 'image', attachment })
    conversation.tracker.deliver(content)
  }

  /**
   * 本地补丁 COMPANION-QQ-PATCH-6：把一段话作为**引导**插进正在跑的回合。
   *
   * 回合没在跑（或宿主不给 inject 通道）时返回 `false`，由调用方退回排队。
   * 与 `submit()` 的差别：不重写运行环境事实（那一行已经在回合开头）、不 `begin()`
   * 新一轮，只把新内容拼进当前回合的上下文。
   */
  injectGuidance(conversation: ConversationRecord, prompt: string): boolean {
    const text = prompt.trim()
    if (text === '') return false
    const delivered = conversation.tracker.injectGuidance([{ type: 'text', text }])
    if (delivered) this.deps.log(`guidance injected into running turn for ${conversation.key}`)
    return delivered
  }

  /** 主动私聊：她自己来找学弟。 */  async dmProactive(prompt: string): Promise<void> {
    const master = this.deps.config().admins[0]
    if (master === undefined) return
    const key = dmRoom(master)
    try {
      const conversation = await this.deps.registry.ensure(key, this.syntheticDm(master))
      if (conversation.tracker.running()) return
      // 房间指令在这里最要紧：这些注入的提示词正是 2026-10-14 那次发错群的地方
      // ——"去找他"没有点名房间与发送参数，于是她发进了主群。现在每一次注入都写明。
      this.submit(conversation, this.proactivePrompt(conversation, prompt))
      this.deps.log('dm proactive submitted')
    } catch (error) {
      this.deps.log(`dm proactive failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 定时任务：巡逻 / 做梦 / 自省，都落在群会话上。 */
  async patrolTick(key: string, prompt: string): Promise<void> {
    await this.scheduledTick(key, prompt)
  }

  async dreamTick(key: string, prompt: string): Promise<void> {
    await this.scheduledTick(key, prompt)
  }

  async evolveTick(key: string, prompt: string): Promise<void> {
    await this.scheduledTick(key, prompt)
  }

  /**
   * 事件书（P6f）的 prompt 事件：往**任意**房间键发一条，返回是否真的提交了。
   *
   * 与 `dmProactive`/`scheduledTick` 的差别只有一处：房间由事件书指定（四种 target
   * 已由 `core/schedule/targets.ts` 解析成房间键）。私聊在会话还没物化时合成一个
   * "对方发来的"事件——这条路径与主动私聊完全一致，房间指令也照旧写明。
   */
  async bookPrompt(room: string, prompt: string, ticket?: { readonly cancelled: boolean }): Promise<boolean> {
    const parsed = splitRoom(room)
    if (parsed !== null && !parsed.isGroup) return await this.syntheticDmTick(room, parsed.chatId, prompt, ticket)
    return await this.scheduledTick(room, prompt, ticket)
  }

  /** 私聊定向回合：没会话就合成一个（与 `dmProactive` 同一条路）。 */
  private async syntheticDmTick(key: string, chatId: number, prompt: string, ticket?: { readonly cancelled: boolean }): Promise<boolean> {
    try {
      const conversation = await this.deps.registry.ensure(key, this.syntheticDm(chatId))
      // F43: the ensure await may outlive the contact timeout; never submit a late turn.
      if (ticket?.cancelled === true) {
        this.deps.log(`book prompt cancelled after ensure for ${key}`)
        return false
      }
      if (conversation.tracker.running()) return false
      this.submit(conversation, this.proactivePrompt(conversation, prompt))
      this.deps.log(`book prompt submitted for ${key}`)
      return true
    } catch (error) {
      this.deps.log(`book prompt failed: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  private async scheduledTick(key: string, prompt: string, ticket?: { readonly cancelled: boolean }): Promise<boolean> {
    // 定时任务可能是开服后第一件发生的事（刚部署、群里还没人说话）：
    // 那就把记录合成出来，而不是安静地什么都不做。
    const conversation = this.deps.registry.bootstrap(key)
    if (conversation === undefined) return false
    if (conversation.tracker.running()) return false
    try {
      await this.deps.registry.ensure(key, conversation.lastEvent)
      if (ticket?.cancelled === true) {
        this.deps.log(`scheduled tick cancelled after ensure for ${key}`)
        return false
      }
      this.submit(conversation, this.proactivePrompt(conversation, prompt))
      this.deps.log(`scheduled tick submitted for ${key}`)
      return true
    } catch (error) {
      this.deps.log(`scheduled tick failed: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  /** 只给学弟的后台指令：投进他的私聊会话。 */
  async adminPrompt(prompt: string): Promise<void> {
    const master = this.deps.config().admins[0]
    if (master === undefined) throw new Error('no admin configured')
    const key = dmRoom(master)
    const conversation = await this.deps.registry.ensure(key, this.syntheticDm(master))
    if (conversation.tracker.running()) throw new Error('turn in flight; try again shortly')
    // 与 dmProactive 同理：写明房间与确切的发送参数。
    this.submit(conversation, `${this.roomDirective(conversation)}\n${prompt}`, [], ADMIN)
    this.deps.log(`admin prompt submitted to ${key}`)
  }

  private proactivePrompt(conversation: ConversationRecord, prompt: string): string {
    const ctx = timeContext(new Date(this.deps.clock.now()))
    return this.deps.prompts.proactive(ctx.period, this.roomDirective(conversation), prompt)
  }

  private roomDirective(conversation: ConversationRecord): string {
    return this.deps.prompts.roomDirective(conversation.isGroup, conversation.chatId)
  }

  /** 一条合成出来的"学弟发来的"私聊事件（会话还没物化时用它）。 */
  private syntheticDm(master: number): OneBotEvent {
    return {
      time: Math.floor(this.deps.clock.now() / 1000),
      self_id: this.deps.config().selfId,
      post_type: 'message',
      message_type: 'private',
      user_id: master,
      sender: { user_id: master, nickname: '学弟' },
    }
  }

  private async sentLogFor(room: string): Promise<SentLogReader> {
    let pending = this.sentLogs.get(room)
    if (pending === undefined) {
      pending = this.deps.openSentLog(room)
      this.sentLogs.set(room, pending)
    }
    return await pending
  }
}
