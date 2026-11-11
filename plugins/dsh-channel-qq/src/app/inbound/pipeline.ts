/** 入站流水线：一条 QQ 消息 → 一包交给模型的内容。
 *
 * 七步顺序**不能重排**：准入 → 解析 → 取材（重活） → 渲染 → 判定 → 攒批 → 组包投递。
 * 旁听与被叫到都发生在判定之前（见 `group-ambient`）；私聊/注入两条路在 `inbound/delivery`。
 *
 * 这一层没有 `node:*`：副作用与时间都经端口注入，所以不需要真的 QQ 或真的宿主就能跑（R8）。
 */

import type { OneBotEvent } from '../../types.js'
import type { RegistryFile } from '../../core/participant.js'
import { parseInbound, type ParsedInbound } from '../../core/message/parse.js'

import { renderMessageLine } from '../../core/message/render.js'
import { isBatchFull, queueChars } from '../../core/batching.js'
import { plannerAllows } from './planner-gate.js'
import { isCalled, isOwnerMessage, reactionHintOf } from '../../core/trigger.js'
import { resolveRoomPolicy } from '../../core/room-policy.js'
import { roomOf } from '../../core/room.js'
import type { AgentGateway } from '../../ports/agent-gateway.js'
import type { BlobStore } from '../../ports/blob-store.js'
import type { ChatPlatform, QQApi } from '../../ports/platform.js'
import type { HttpClient } from '../../ports/http.js'
import type { Clock, Random } from '../../ports/clock.js'
import type { GatewayHealth } from '../conversation/gateway-health.js'
import type { ConversationRecord as Conversation, ConversationRegistry } from '../conversation/registry.js'
import type { PromptComposer } from '../conversation/prompt-composer.js'
import type { TurnLauncher } from '../conversation/turns.js'
import { gatherMaterials, type Materials } from './materials.js'
import { deliverDm, deliverInject } from './delivery.js'
import { userOrigin } from './origin.js'
import { DmBuffer } from './dm-buffer.js'
import { PacketComposer, type KnowledgeSource } from './packet-composer.js'
import {
  captureAmbient, takeBackground, type AmbientPresenceSettings, type PresenceObserver,
} from './group-ambient.js'
import { AmbientStore, presenceAppliesTo, presenceSettingsOf } from './ambient-store.js'
import { scheduleBatch as armBatch, gateOf, type FlushDeps } from './batch-flush.js'

/** 流水线用到的配置（实时读，后台改了立即生效）。 */
export interface PipelineConfig {
  readonly groupEnabled: boolean
  readonly requireMention: boolean
  readonly debug: boolean
  readonly injectMode: { readonly enabled: boolean; readonly duringTurn?: boolean; readonly wakeIdle: boolean }
  readonly imageRecognition: { readonly enabled: boolean; readonly maxPerMessage: number }
  readonly batching: { readonly windowMs: number; readonly maxMessages: number; readonly maxChars: number;
    readonly dmEnabled?: boolean; readonly dmShortMs?: number; readonly dmLongMs?: number;
    readonly dmLongChars?: number; readonly dmMaxWaitMs?: number }
  readonly contextBudget: { readonly compactChars: number }
  /** 上下文 v2（P6b）；缺省视为关（部分配置构造的旧测试不必补字段）。 */
  readonly context?: { readonly v2: boolean }
  /** 群聊准入（P6g）；同样是可选——缺省 = 关，旧测试不必补字段。 */
  readonly planner?: { readonly enabled: boolean }
  /**
   * 群聊旁听与自主接话（`presence`）；缺省 = 关（旧配置构造不必补字段）。
   *
   * 只取流水线自己要用的那几项；判断与发言的限频参数由执行器（`presence-runtime`）读。
   */
  readonly presence?: AmbientPresenceSettings
  /** 自己的号（判自环；旧配置构造里可能没有）。 */
  readonly selfId?: number
  readonly primaryGroup: number | null
  readonly primaryTalkValue?: number | null
  readonly talkValue: number
  readonly keywordTriggers: readonly string[]
  readonly keywordReactions: ReadonlyArray<{ keywords: string[]; reaction: string }>
}

export interface PipelineDeps {
  readonly config: () => PipelineConfig
  readonly registry: ConversationRegistry
  readonly turns: TurnLauncher
  readonly prompts: PromptComposer
  readonly platform: () => ChatPlatform
  readonly gateway: AgentGateway
  readonly blobs: BlobStore
  readonly http: HttpClient
  readonly clock: Clock
  /** 退避抖动用的随机源；注入进来才能重放。 */
  readonly random: Random
  readonly health: GatewayHealth
  readonly log: (line: string) => void
  /**
   * 语音转写：一条语音消息 → 文字（没配服务或失败时返回 null）。
   *
   * 由组合根提供：`stt.ts` 是 provider（P4 会搬进 `adapters/providers/`），
   * `app/` 只该认识这个函数签名。
   */
  readonly transcribe: (messageId: number) => Promise<string | null>
  /** 知识库自动召回（没接上时返回 null——它在 `Service.init` 后半段才造出来）。 */
  readonly knowledge: KnowledgeSource
  /** 组包器：队列 → 一包（图片封顶与上下文预算都在它那里）。 */
  readonly packets: PacketComposer
  /**
   * 管理员本地命令（「待批 / 申请 / 批准 / 拒绝」）：先于 agent、不经模型。
   * 返回 null 表示不是命令，照常交给 agent。
   */
  readonly adminCommand?: (text: string, userId: number) => Promise<string | null>
  /** 社交指令（同意好友/邀请、好友请求列表）：先于 agent、不经模型；没装就是 undefined。 */
  readonly socialCommand?: (text: string, userId: number) => Promise<boolean>
  /** 旁听缓冲（每群一个环）；缺省 = 没有旁听，行为与旧版一致。 */
  readonly ambient?: AmbientStore
  /** 自主接话执行器；缺省 = 只旁听（被 @ 时带上背景），不主动开口。 */
  readonly presence?: PresenceObserver
  /** 参与者注册表（P9-G4 §2.2）：每次现取；缺省 = 没装，全员按"身份未确认"处理（不是"全是人"）。 */
  readonly participants?: () => RegistryFile | null
  /** 表情词典只读取值函数（指纹 → 意思；缺省 = 不注入，渲染行里就没有 `knownMeaning=`）。 */
  readonly stickerMeanings?: (stickerKey: string) => string | null
}

export class InboundPipeline {
  private readonly dmBuffer: DmBuffer
  constructor(private readonly deps: PipelineDeps) { this.dmBuffer = new DmBuffer(deps) }
  /** 步骤 1：这条事件该不该进流水线（群聊按"这个群自己的开关"判）。 */
  private admits(event: OneBotEvent): boolean {
    if (event.post_type !== 'message' || event.message_type === undefined) return false
    if (event.message_type === 'group' && !resolveRoomPolicy(this.deps.config(), event.group_id ?? null).enabled) return false
    return true
  }
  /** 步骤 2+3：取材（语音、文件、引用、图片）——重活都在 `materials.ts`。 */
  private gather(event: OneBotEvent, parsed: ParsedInbound): Promise<Materials> {
    return gatherMaterials({
      platform: this.deps.platform,
      gateway: this.deps.gateway,
      blobs: this.deps.blobs,
      http: this.deps.http,
      clock: this.deps.clock,
      log: this.deps.log,
      config: this.deps.config,
      transcribe: this.deps.transcribe,
    }, event, parsed)
  }
  /**
   * 步骤 4：渲染一行入站行。
   *
   * 这个包装只做两件事：把配置翻译成"语气提示"，把"现在"取出来——两者都是副作用，
   * 而渲染本身是 `core/message/render.ts` 里的纯函数（黄金快照钉住它）。
   */
  private lineFor(
    event: OneBotEvent,
    parsed: ParsedInbound,
    called: boolean,
    quoted: string | null,
    voiceText: string | null = null,
    receivedFiles: string[] = [],
  ): string | null {
    return renderMessageLine({
      event,
      parsed,
      called,
      quoted,
      voiceText,
      receivedFiles,
      // 语气提示只在被叫到时才查：它会把模型带到某种语气上，混进无关消息里就是事故。
      reactionHint: called ? reactionHintOf(this.deps.config(), event) : null,
      nowMs: this.deps.clock.now(),
      // 表情词典只在消息里真有表情时才问（每条群消息都查库没有必要）。
      ...(parsed.stickers.length === 0 || this.deps.stickerMeanings === undefined ? {} : { stickerMeanings: this.deps.stickerMeanings }),
    })
  }

  /** 一条入站消息。 */
  async handle(event: OneBotEvent): Promise<void> {
    if (!this.admits(event)) return
    const key = roomOf(event)
    if (key === null) return
    const parsed = parseInbound(event)
    // 社交指令（好友申请/群邀请审批）：同样私聊专属、不经模型。
    if (event.message_type === 'private' && this.deps.socialCommand !== undefined) {
      if (await this.deps.socialCommand(parsed.plainText, event.user_id ?? 0)) return
    }
    // 管理员本地命令：私聊、先于 agent、不经模型。命中就回一条、不进队列。
    if (event.message_type === 'private' && this.deps.adminCommand !== undefined) {
      const reply = await this.deps.adminCommand(parsed.plainText, event.user_id ?? 0)
      if (reply !== null) { await this.deps.platform().api.sendPrivateMessage(event.user_id ?? 0, [{ type: 'text', data: { text: reply } }]); return }
    }
    // ── 旁听（presence，默认关）───────────────────────────────────────────
    // 记旁听必须在 requireMention 早退**之前**：不然下一次 @ 时她对"刚才在聊什么"
    // 一无所知，而"你怎么看"这类追问正是靠那段背景才答得上的。
    const config = this.deps.config()
    const groupId = event.message_type === 'group' ? (event.group_id ?? null) : null
    const presence = presenceSettingsOf(config)
    const watched = presence !== null && presenceAppliesTo(presence, groupId)
    if (watched && presence !== null && groupId !== null) {
      captureAmbient({
        ambient: this.deps.ambient,
        presence: this.deps.presence,
        settings: presence,
        groupId,
        event,
        parsed,
        selfId: config.selfId,
        nowMs: this.deps.clock.now(),
        // 注册表交给采集层现取：采集是每条群消息都跑的热路径，"谁来查身份"定在一处。
        ...(this.deps.participants === undefined ? {} : { registry: this.deps.participants }),
      })
    }
    const called = event.message_type === 'private'
      ? true
      : isCalled(event, parsed, config) || isOwnerMessage(event, config)
    // 纯旁听：只记不提——不下载图片、不转写语音、不展开转发、不进队列、不调模型。
    if (watched && groupId !== null
      && resolveRoomPolicy(config, groupId).requireMention && !called) {
      if (config.debug) this.deps.log(`ambient only (requireMention, not called) ${key}`)
      return
    }
    const materials = await this.gather(event, parsed)
    // 私聊按配置合并接话，或直接投递（去重与缓冲在 `inbound/delivery`）。
    if (event.message_type === 'private') {
      return await deliverDm({
        registry: this.deps.registry,
        turns: this.deps.turns,
        packets: this.deps.packets,
        dmBuffer: this.dmBuffer,
        config: this.deps.config,
      }, key, event, parsed,
      this.lineFor(event, parsed, true, materials.quoted, materials.voiceText, materials.receivedFiles),
      materials)
    }
    return await this.deliverGroup(key, event, parsed, materials, { groupId, called, presence })
  }

  /** 群聊：叫我就立刻分析，开了注入模式就逐条注入，否则攒批。 */
  private async deliverGroup(
    key: string,
    event: OneBotEvent,
    parsed: ParsedInbound,
    materials: Materials,
    ctx: {
      readonly groupId: number | null
      readonly called: boolean
      readonly presence: AmbientPresenceSettings | null
    },
  ): Promise<void> {
    const conversation = this.deps.registry.getOrCreate(key, event)
    conversation.lastEvent = event
    const config = this.deps.config()
    const policy = resolveRoomPolicy(config, event.group_id ?? null)
    const called = ctx.called

    // P6g 群聊准入（默认关）：被挡下的消息不进队列，每一条都写清理由。
    if (!plannerAllows(this.deps, key, event, parsed, called, policy.requireMention)) return

    // "需要 @ 才回"：不认这个开关的话，她会在没人叫的时候按概率往群里说话，
    // 群友读起来就是"答非所问"。环境消息仍会被学习 / 风控 / 链接观察看到。
    if (policy.requireMention && !called) {
      if (config.debug) this.deps.log(`ignored group message (requireMention, not called) ${key}`)
      return
    }
    const line = this.lineFor(event, parsed, called, materials.quoted, materials.voiceText, materials.receivedFiles)
    // 旁听背景只在被叫到的那一包上取（普通消息根本不进这里）。
    const background = (called && ctx.presence !== null && ctx.groupId !== null)
      ? takeBackground({
          ambient: this.deps.ambient,
          settings: ctx.presence,
          groupId: ctx.groupId,
          messageId: event.message_id,
          nowMs: this.deps.clock.now(),
          queueLength: conversation.queue.length,
        })
      : ''
    if (config.injectMode.enabled) {
      await this.injectNow(conversation, event, line, materials.imageRefs, called, background)
      return
    }
    await this.enqueue(conversation, event, line, materials.imageRefs, called, background)
  }

  /** 注入模式：这条消息立刻进 agent 上下文，不走攒批也不看概率。 */
  private async injectNow(
    conversation: Conversation,
    event: OneBotEvent,
    line: string | null,
    imageRefs: readonly unknown[],
    called: boolean,
    background = '',
  ): Promise<void> {
    await deliverInject({
      registry: this.deps.registry,
      turns: this.deps.turns,
      packets: this.deps.packets,
      prompts: this.deps.prompts,
      config: this.deps.config,
      log: this.deps.log,
    }, conversation, event, line, imageRefs, called, background)
  }

  /**
   * 攒批：入队、去重、够数就发、否则起安静窗口。
   *
   * `calledLine` 在 P6b 接线：每次入队记录"最后一条是不是叫我"（旧实现该标记从不
   * 置真、是走不到的死分支）。消费方是组包器，且只在 `context.v2` 打开时读它——
   * 关着时输出与旧行为逐字节一致。
   *
   * 是 `async` 而且**要 await**：被叫到的那条必须在这一步就把包发出去，
   * 否则调用方（与它后面的黄金快照）会看到一个"什么都没发生"的回合。
   */
  private async enqueue(
    conversation: Conversation,
    event: OneBotEvent,
    line: string | null,
    imageRefs: readonly unknown[],
    called: boolean,
    background = '',
  ): Promise<void> {
    // 跨窗口去重：同一个 QQ 消息号绝不入队两次（NapCat 重试与窗口回显会重复）。
    // **必须在 push 之前**：放在后面时重复消息已经进队列，return 只退出、内容留着。
    if (typeof event.message_id === 'number') {
      if (!conversation.seenMessageIds) conversation.seenMessageIds = new Set()
      if (conversation.seenMessageIds.has(event.message_id)) return
      if (conversation.seenMessageIds.size > 500) {
        conversation.seenMessageIds = new Set([...conversation.seenMessageIds].slice(-250))
      }
      conversation.seenMessageIds.add(event.message_id)
    }
    if (line !== null) conversation.queue.push(line)
    if (imageRefs.length > 0) {
      const cap = this.deps.config().imageRecognition.maxPerMessage
      conversation.pendingImages.push(...imageRefs.slice(-cap))
    }

    conversation.calledLine = called
    if (called) {
      // 跳过安静窗口：立刻分析，已入队的上下文一并带上。
      await this.flushNow(conversation, { immediate: true, ...(background === '' ? {} : { background }) })
      return
    }
    if (conversation.queue.length === 0) return
    if (isBatchFull(conversation.queue, this.deps.config().batching)) {
      const { length } = conversation.queue
      this.deps.log(`batch full (${length} lines, ${queueChars(conversation.queue)} chars) — analyzing`)
      await this.flushNow(conversation, { immediate: false })
      return
    }
    this.scheduleBatch(conversation)
  }

  /** 攒批定时器/闸门的依赖（时钟与骰子经端口注入；实现见 `batch-flush.ts`）。 */
  private flushDeps(): FlushDeps {
    return {
      config: () => this.deps.config(),
      clock: this.deps.clock,
      random: this.deps.random,
      health: this.deps.health,
      log: this.deps.log,
      flush: (conversation) => this.flushNow(conversation, { immediate: false }),
    }
  }

  /** 重新武装安静窗口（调用点只说"再来一次"）。 */
  private scheduleBatch(conversation: Conversation): void {
    armBatch(conversation, this.flushDeps())
  }

  /**
   * 把入队的内容分析成一包。
   *
   * `immediate`（被叫到）跳过等待与概率闸门；**正在跑的回合不被打断**——一批会等它
   * 空下来再发，而不是排在它后面，那正是我们要躲开的堆积。
   */
  private async flushNow(
    conversation: Conversation,
    opts: { immediate: boolean; background?: string },
  ): Promise<void> {
    conversation.batchTimer?.cancel()
    conversation.batchTimer = null
    if (conversation.queue.length === 0 && conversation.pendingImages.length === 0) return
    if (conversation.tracker.busy() && !opts.immediate) {
      // 有回合在跑或有网关重试已武装：等它结束再看，而不是排队或重置重试链。
      this.scheduleBatch(conversation)
      return
    }
    const decision = gateOf(conversation, opts.immediate, this.flushDeps())
    if (decision.kind === 'empty') return
    // 忙或退避中：重新起一个安静窗口，而不是排队——排队就是我们要躲开的堆积。
    if (decision.kind === 'defer') { this.scheduleBatch(conversation); return }
    if (decision.kind === 'drop') {
      conversation.queue = []
      conversation.pendingImages = []
      conversation.calledLine = false
      this.deps.log(`batch of ${decision.lines} dropped by talk chance`)
      return
    }
    const packet = await this.deps.packets.compose(
      conversation,
      opts.background === undefined ? {} : { background: opts.background },
    )
    try {
      if (conversation.session === null) {
        await this.deps.registry.ensure(conversation.key, conversation.lastEvent)
      }
      this.deps.turns.submit(conversation, packet.text, packet.imageRefs, userOrigin(conversation.lastEvent))
    } catch (error) {
      this.deps.log(`bridge followup failed: ${String(error)}`)
    }
  }

}

