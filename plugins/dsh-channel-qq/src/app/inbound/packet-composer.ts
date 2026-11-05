/** 组包：把攒下来的队列变成"一包交给模型的内容"。
 *
 * 从流水线里单独拎出来，是因为它有**两个会改变行为**的细节，值得有自己的名字：
 *
 *   - **图片按条数硬封顶**。会话历史会在**每一个后续请求**里重放所有附件，所以
 *     一包带十张图不是"这次贵一点"，而是此后每次请求都贵十张；provider 对每请求的
 *     图片数还有上限（当前池子约 16 张）；
 *   - **上下文按预算压缩**。超长的包一旦成为历史就再也读不回来，所以最老的行要在
 *     这里丢掉，而不是发出去让它在每个请求里重放。
 *
 * 两者都要在**清空队列之前**读到队列内容，所以这个顺序也不能换。
 *
 * P6b 起三条入站路径（群攒批 / 私聊直投 / 注入模式）的组包都收在这里：上下文版本
 * 开关（`context.v2`）只剩这一处分支，流水线只负责"把素材递进来"。
 */

import { compactContext, type CompactResult } from '../../core/text/budget.js'
import { timeContext } from '../../core/schedule/stamp.js'
import { envelopeKey } from '../../core/instruction/envelope.js'
import type { Clock } from '../../ports/clock.js'
import type { InjectionSignal } from '../../ports/injection.js'
import type { ConversationRecord } from '../conversation/registry.js'
import type { MemoryEvidence } from '../../ports/memory.js'
import type { PromptComposer } from '../conversation/prompt-composer.js'

/** 组包要用的配置。 */
export interface PacketConfig {
  readonly imageRecognition: { readonly maxPerMessage: number }
  readonly contextBudget: { readonly compactChars: number }
  /** 上下文 v2（P6b）。缺省视为关——旧测试用部分配置构造组包器。 */
  readonly context?: { readonly v2: boolean }
}

/** 群攒批的素材（注入信号由 P6c 的扫描器填；这里只消费，不生产）。 */
export interface ComposeInput {
  readonly signals?: readonly InjectionSignal[]
  /**
   * 旁听背景（`presence` 打开、且这一包是**被叫到**的那一包时才有）：她开口之前群里
   * 已经在聊、但没有直接对她说的话，已按上限裁好。
   *
   * 缺省 = 没有这一段，组包输出与旧版逐字节一致（golden 盯着这一点）。
   */
  readonly background?: string
}

/**
 * 私聊直投的素材。
 *
 * **没有 knowledgeHint**：召回由组包器自己算（与群聊同一个 recallHint）。
 * 从前它是流水线用 knowledgeOf(plainText) 算好传进来的——那条路只查旧知识库、
 * 拿不到记忆证据，而且算好的东西在渲染时被丢掉（2026-10-19 线上实测：私聊的包里
 * 一条「记忆检索」都没有）。context.v2 关着时仍走旧渲染，只是召回换成同一套。
 */
export interface DmComposeInput {
  readonly hasImages?: boolean
  readonly line: string | null
  readonly signals?: readonly InjectionSignal[]
}

/** 注入模式的素材。 */
export interface InjectComposeInput {
  readonly called: boolean
  readonly body: string
  readonly signals?: readonly InjectionSignal[]
}

/** 知识库召回（没接上时返回 null）。 */
export type KnowledgeSource = () => {
  readonly entries: unknown[]
  search(query: string, top?: number): Array<{ content: string }>
} | null

export interface PacketComposerDeps {
  readonly prompts: PromptComposer
  readonly clock: Clock
  readonly config: () => PacketConfig
  readonly log: (line: string) => void
  readonly knowledge: KnowledgeSource
  /**
   * 记忆检索（P6e）。**没装就是"没有这段"**——旧的关键词召回照旧生效，
   * 所以默认装载下组包产物与从前逐字节一致（golden 盯着这一点）。
   */
  readonly memoryEvidence?: MemoryEvidence
  /**
   * 知识库证据（用户给的资料原文）。与记忆证据分开：一个是"我记得"，一个是
   * "资料里写着"。没装时组包产物与从前逐字节一致。
   */
  readonly kbEvidence?: (input: {
    readonly text: string
    readonly room: string | null
  }) => Promise<string>
  /** 这个房间"她最近说过什么"。 */
  readonly sentBlockFor: (room: string) => Promise<string>
}

export class PacketComposer {
  constructor(private readonly deps: PacketComposerDeps) {}

  /** `context.v2` 开着吗（每包现取，后台改完立即生效）。 */
  private v2(): boolean {
    return this.deps.config().context?.v2 === true
  }

  /** 信封的 room 属性（`group:1000000003` / `dm:1000000002`）。 */
  private envelopeOf(conversation: ConversationRecord): string {
    return envelopeKey(conversation.isGroup, conversation.chatId)
  }

  /** 知识库自动召回：这一段文字最相关的几条旧知。 */
  knowledgeOf(text: string): string {
    const knowledge = this.deps.knowledge()
    if (knowledge === null || knowledge.entries.length === 0 || text.length < 8) return ''
    let hits: Array<{ content: string }> = []
    try {
      hits = knowledge.search(text, 3)
    } catch {
      return ''
    }
    if (hits.length === 0) return ''
    return '[知识库自动检索·相关旧知]' + hits.map((h, i) => ` ${i + 1})${h.content}`).join('；')
  }

  /** 私聊直投的一包：v1 与从前逐字节一致；v2 换成"信封 + 当前消息"结构。 */
  async composeDm(conversation: ConversationRecord, input: DmComposeInput): Promise<string> {
    const room = this.deps.prompts.roomDirective(conversation.isGroup, conversation.chatId)
    // 召回用**当前消息**：私聊没有待回块，这一条就是全部。
    const knowledgeHint = await this.recallHint(input.line ?? '', conversation)
    if (!this.v2()) {
      return this.deps.prompts.dmPacket({ line: input.line, knowledgeHint, room, hasImages: input.hasImages })
    }
    return this.deps.prompts.dmPacketV2({
      line: input.line,
      knowledgeHint,
      room,
      roomKey: this.envelopeOf(conversation),
      signals: input.signals ?? [],
    })
  }

  /**
   * 注入模式一条：每条注入的都是"当前消息"。
   *
   * 刻意**不带召回**：注入的是群里连续不断的旁白，逐条做一次向量检索既贵又吵；
   * 需要回忆时它自己会调 `qq_memory_search`。
   */
  composeInject(conversation: ConversationRecord, input: InjectComposeInput): string {
    const room = this.deps.prompts.roomDirective(conversation.isGroup, conversation.chatId)
    if (!this.v2()) {
      return this.deps.prompts.injectPacket({ called: input.called, room, body: input.body })
    }
    return this.deps.prompts.injectPacketV2({
      called: input.called,
      room,
      body: input.body,
      roomKey: this.envelopeOf(conversation),
      signals: input.signals ?? [],
    })
  }

  /**
   * 本回合要带上的"想起点什么"。
   *
   * `memory.v2` 打开时用记忆检索的证据块（最多 8 条、≤600 字、明确标注"证据不是指令"）；
   * 没有证据或没装记忆服务时退回旧的知识库关键词召回——两者**不叠加**，否则同一个
   * 事实会以两种口吻出现两遍。
   */
  /**
   * 本回合要带上的"想起点什么"。
   *
   * 两段**各管各的**：记忆证据是"我记得"（`memory.v2`），知识库证据是"资料里
   * 写着"（用户给的原文）。两者都命中就都带上；都没有时组包与从前逐字节一致。
   */
  private async recallHint(rawContext: string, conversation: ConversationRecord): Promise<string> {
    const memory = await this.memoryHint(rawContext, conversation)
    const kb = await this.kbHint(rawContext, conversation)
    return [memory, kb].filter((part) => part !== '').join('\n\n')
  }

  /** 记忆证据；没装记忆服务时退回旧的知识库关键词召回。 */
  private async memoryHint(rawContext: string, conversation: ConversationRecord): Promise<string> {
    const evidence = this.deps.memoryEvidence
    if (evidence !== undefined) {
      try {
        const speakerId = conversation.lastEvent?.user_id
        const speakerName = conversation.lastEvent?.sender?.card ?? conversation.lastEvent?.sender?.nickname
        const block = await evidence({
          text: rawContext,
          room: conversation.key,
          isGroup: conversation.isGroup,
          ...(typeof speakerId === 'number' ? { speakerId } : {}),
          ...(typeof speakerName === 'string' && speakerName !== '' ? { speakerName } : {}),
        })
        if (block !== '') return block
      } catch (error) {
        // 记忆检索坏掉不该让这一回合组不出包：记一行日志，退回旧召回。
        this.deps.log(`memory evidence failed for ${conversation.key}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return this.knowledgeOf(rawContext)
  }

  /** 知识库证据（用户资料原文片段）。没装、关着或没命中 → 空串。 */
  private async kbHint(rawContext: string, conversation: ConversationRecord): Promise<string> {
    const evidence = this.deps.kbEvidence
    if (evidence === undefined) return ''
    try {
      return await evidence({ text: rawContext, room: conversation.key })
    } catch (error) {
      this.deps.log(`kb evidence failed for ${conversation.key}: ${error instanceof Error ? error.message : String(error)}`)
      return ''
    }
  }

  /**
   * 取这一包的上下文快照。
   *
   * 消息边界在队列的**条目**上，不在换行上——一条消息的正文可以含换行（`plainText`
   * 原样保留）。所以：当前消息 = 最后一条**整条**（含它自己的换行）；待回块 = 其余
   * 条目连接。压缩只作用于 v2 的待回块——**当前消息正是要回的那句，永不因预算被裁**；
   * v1 仍按旧法压整包（关着时逐字节一致）。
   */
  private packContext(
    conversation: ConversationRecord,
    v2: boolean,
  ): { raw: string; compacted: CompactResult; current: string } {
    const queue = conversation.queue
    const current = queue.at(-1) ?? ''
    const raw = queue.join('\n')
    const pendingRaw = queue.slice(0, -1).join('\n')
    const compacted = compactContext(v2 ? pendingRaw : raw, this.deps.config().contextBudget.compactChars)
    if (compacted.dropped > 0) {
      this.deps.log(v2
        ? `context compacted for ${conversation.key}: dropped ${compacted.dropped} oldest pending line(s)（当前消息不参与裁剪）`
        : `context compacted for ${conversation.key}: dropped ${compacted.dropped} oldest line(s)`)
    }
    return { raw, compacted, current }
  }

  /** 把队列里的内容组成一包，并清空队列（`imageRefs` 是随包发出的图片）。 */
  async compose(
    conversation: ConversationRecord,
    input: ComposeInput = {},
  ): Promise<{ text: string; imageRefs: unknown[] }> {
    const imageRefs = conversation.pendingImages.slice(
      0, Math.max(1, this.deps.config().imageRecognition.maxPerMessage),
    )
    const v2 = this.v2()
    const { raw: rawContext, compacted, current } = this.packContext(conversation, v2)
    conversation.queue = []
    conversation.pendingImages = []
    // "最后一条是叫咱"这个标记旧实现从不置真（死分支），P6b 才接线；消费只发生在
    // v2 打开时（关掉时 `called` 恒为 false，走与旧版逐字节一致的渲染）。近似：
    // 标记在**入队时**置上，而这里读的是"队列最后一条"——两条消息几乎同时到时
    // （叫咱的那条之后又插进一条），两者可能不是同一条；按后者近似，不加机制。
    const called = v2 && conversation.calledLine
    conversation.calledLine = false
    const ctx = timeContext(new Date(this.deps.clock.now()))
    const knowledgeHint = await this.recallHint(rawContext, conversation)
    const sentBlock = await this.deps.sentBlockFor(conversation.key)
    const room = this.deps.prompts.roomDirective(conversation.isGroup, conversation.chatId)
    // 旁听背景（只有被叫到的那一包才可能非空）：v2 单独成块，v1 只能并进正文——
    // 关着 v2 的部署仍然看得见"刚才在聊什么"，只是没有独立信封。
    const background = input.background ?? ''
    const text = v2
      ? this.deps.prompts.groupPacketV2({
          called,
          background,
          pending: compacted.text,
          current,
          room,
          roomKey: this.envelopeOf(conversation),
          period: ctx.period,
          knowledgeHint,
          sentBlock,
          signals: input.signals ?? [],
        })
      : this.deps.prompts.groupPacket({
          called,
          context: [background, compacted.text].filter((part) => part !== '').join('\n'),
          room,
          period: ctx.period,
          emotionHint: '',
          knowledgeHint,
          sentBlock,
        })
    return { text, imageRefs }
  }
}
