/** 组包：把一段段文案拼成**正好那一串**交给模型。
 *
 * 这一步是"人格即数据"（04 §1）的落点。搬出来
 * 之前，这些提示词是 `bridge.ts` 里散落的模板字面量，改一句话就得读 TypeScript；
 * 搬出来之后文案在 `assets/persona/`，这里只剩**拼装**：谁在什么条件下出现、用哪个
 * 分隔符、顺序如何。
 *
 * 拼装逻辑刻意留在代码里而不是模板语法里：条件（有没有情绪提示、有没有知识召回、
 * 有没有发过话）用普通的 `if` 比用 `{{#if}}` 好读也好测，而且模板里少一门小语言
 * 就少一类只能在运行时发现的错误。
 *
 * **每一个空行都是行为**：这些提示词的分隔符（`\n`）参与黄金快照的逐字节比对，
 * 所以下面每一处的拼接顺序都照着搬出前的原样写，没有"顺手整理一下"。
 */

import type { PersonaPack } from '../../ports/persona.js'
import type { InjectionSignal } from '../../ports/injection.js'
import {
  BACKGROUND_TITLE, CURRENT_TITLE, PENDING_TITLE, injectionWarningLine, routeSignals, untrustedEnvelope,
} from '../../core/instruction/envelope.js'

/** 群聊一包的素材。 */
export interface GroupPacketInput {
  /** 最后一条是不是"叫咱"（@ / 关键词）。 */
  readonly called: boolean
  /** 已经渲染好的入站行。 */
  readonly context: string
  /** 已渲染的房间指令行。 */
  readonly room: string
  readonly period: string
  /** 情绪提示（可能为空串）。 */
  readonly emotionHint: string
  /** 知识库召回（可能为空串）。 */
  readonly knowledgeHint: string
  /** "她最近发过的话"（可能为空串）。 */
  readonly sentBlock: string
}

/** 群聊一包（v2）的素材：旁听背景、待回块与当前块分开、各自进信封。 */
export interface GroupPacketV2Input {
  readonly called: boolean
  /**
   * 旁听背景：她被叫到之前，群里已经在聊、但**没有直接对她说**的那些消息（可能为空）。
   *
   * 它单独成块、单独进信封、标题写明"不是对你说的"：混进待回块会让模型把这些话
   * 当成逐条等她回答的问题，那正是"抢答"的来源。
   */
  readonly background?: string
  /**
   * 待回块：除当前消息外、还没被回过的入站行连接（可能已按预算压缩；空串 = 没有）。
   *
   * 边界在**消息**上、不在换行上：一条消息的正文可以含换行，所以这里不切行——
   * 切行会把"正在被问的那句"的一部分错误地标成"仅供参考"。
   */
  readonly pending: string
  /** 当前消息：队列里最后一条**整条**原文（含它自己的换行；空串 = 这一包没有当前消息）。 */
  readonly current: string
  readonly room: string
  /** 信封的 room 属性（`group:1000000003`）。 */
  readonly roomKey: string
  readonly period: string
  readonly knowledgeHint: string
  readonly sentBlock: string
  /** 注入特征信号（P6c 的扫描器填；空数组 = 不渲染提示行）。 */
  readonly signals: readonly InjectionSignal[]
}

/** 私聊一包（v2）的素材：只有当前块。 */
export interface DmPacketV2Input {
  readonly line: string | null
  readonly knowledgeHint: string
  readonly room: string
  readonly roomKey: string
  readonly signals: readonly InjectionSignal[]
}

/** 注入模式一条（v2）的素材。 */
export interface InjectPacketV2Input {
  readonly called: boolean
  readonly body: string
  readonly room: string
  readonly roomKey: string
  readonly signals: readonly InjectionSignal[]
}

export class PromptComposer {
  constructor(
    private readonly pack: PersonaPack,
    private readonly toolsV2: () => boolean = () => false,
    /** 把旧工具名换成合并后的写法；由组合根注入（app/ 不认识 tools-v2 模块）。 */
    private readonly rewrite: (text: string) => string = (text) => text,
  ) {}

  /**
   * 渲染一个模板；tools.v2 开着时把旧工具名换成 `qq_message（action=…）`。
   *
   * 例外：`notice/tools-renamed` 本身就是旧名→新名的对照表，改写会把表弄坏。
   */
  private r(key: string, vars: Readonly<Record<string, string>> = {}): string {
    const text = this.pack.render(key, vars)
    if (!this.toolsV2() || key === 'notice/tools-renamed') return text
    return this.rewrite(text)
  }

  /** 模板原文（后台展示 / 自检用）。 */
  template(key: string): string | undefined {
    return this.pack.template(key)
  }

  /**
   * 直接渲染一段模板。
   *
   * 给"只有一处用到、不值得为它写一个方法"的文案留的出口（例如定时任务的三段
   * 主动提示词）。带条件的分支不要走这里——那种拼装应当有自己的方法，见文件头。
   */
  render(key: string, vars: Readonly<Record<string, string>> = {}): string {
    return this.r(key, vars)
  }

  /**
   * 告诉模型"你在哪个房间、该往哪发"的那一行。
   *
   * 没有它，群聊与私聊的入站行长得一模一样，而指令只说"发到本会话"却没给目标——
   * 模型只能猜 `isGroup` 与 `target`。它真的猜错过：2026-10-14 学弟在私聊问了一句，
   * 回答发到了主群。现在每一条把回合交给模型的路径都带上这一行。
   */
  roomDirective(isGroup: boolean, chatId: number): string {
    // tools.v2 把发送类工具合并成了 `qq_message`（action=send/reply）。指令里如果还
    // 报旧名字，模型会找不到工具、直接"以为"自己发了——2026-10-18 线上真发生过。
    // 关着时仍走原模板，输出逐字节不变（golden 安全）。
    const v2 = this.toolsV2()
    const key = isGroup
      ? (v2 ? 'room/group-v2' : 'room/group')
      : (v2 ? 'room/dm-v2' : 'room/dm')
    return this.r(key, { chatId: String(chatId) })
  }

  /** `（当前时段：下午）`。 */
  timeNote(period: string): string {
    return this.r('packet/time', { period })
  }

  /** `（图见附件）`。 */
  imageNote(): string {
    return this.r('packet/image-note')
  }

  /** 私聊一包：入站行 + 知识召回 + 图注 + 房间指令 + 收尾。 */
  dmPacket(input: { line: string | null; knowledgeHint: string; room: string; hasImages?: boolean }): string {
    const text = [input.line, input.knowledgeHint, input.hasImages ? this.imageNote() : ''].filter(Boolean).join('\n')
    return `${text}\n${input.room}\n${this.r('packet/dm-tail')}`
  }

  /** 群聊一包（攒批分析）：抬头 + 正文 + 房间 + 时段 + 三段可选素材 + 收尾。 */
  groupPacket(input: GroupPacketInput): string {
    const head = this.r(input.called ? 'packet/group-called' : 'packet/group', {
      context: input.context,
    })
    return head
      + `\n${input.room}`
      + `\n${this.timeNote(input.period)}`
      + (input.emotionHint !== '' ? `\n${input.emotionHint}` : '')
      + (input.knowledgeHint !== '' ? `\n${input.knowledgeHint}` : '')
      + (input.sentBlock !== '' ? `\n${input.sentBlock}` : '')
      + `\n${this.r('packet/group-tail')}`
  }

  /** 注入模式的一条：抬头 + 房间 + 正文 + 收尾。 */
  injectPacket(input: { called: boolean; room: string; body: string }): string {
    const header = this.r(input.called ? 'inject/called-header' : 'inject/ambient-header')
    const tail = this.r(input.called ? 'inject/called-tail' : 'inject/ambient-tail')
    return `${header}\n${input.room}\n${input.body}\n${tail}`
  }

  // ── context.v2 的渲染（P6b）：指令层 + 不可信信封 + 当前消息 ──────────────

  /**
   * 群聊一包（v2）。
   *
   * 排布按 05 §3.4：抬头 → 房间行 → 时段 → [待回块] → [当前块] → 自述 → 记忆证据
   * （最后）。"自上次回复以来"与"需要回应"各自成块、各自进 `<untrusted>` 信封；
   * 注入提示紧随它涉及的块（不堆到包尾）。包尾不再带行为约定——那些在指令层
   * （`assets/persona/default/instruction/behavior.txt` → AGENTS.md 受管区）。
   */
  groupPacketV2(input: GroupPacketV2Input): string {
    const routed = routeSignals(input.signals, input.current, input.pending)
    const out = [
      this.r(input.called ? 'packet/group-called-v2' : 'packet/group-v2'),
      input.room,
      this.timeNote(input.period),
    ]
    // 旁听背景排在待回块之前：先"刚才在聊什么"，再"攒着等你回的"，最后"当前这条"。
    // 只有被叫到（`called`）的包才可能带背景——流水线只在 @ 那条上取值。
    if ((input.background ?? '') !== '') {
      out.push(BACKGROUND_TITLE, untrustedEnvelope(input.roomKey, input.background ?? ''))
    }
    if (input.pending !== '') {
      out.push(PENDING_TITLE, untrustedEnvelope(input.roomKey, input.pending))
      for (const signal of routed.pending) out.push(injectionWarningLine(signal.name))
    }
    if (input.current !== '') {
      out.push(CURRENT_TITLE, untrustedEnvelope(input.roomKey, input.current))
      for (const signal of routed.current) out.push(injectionWarningLine(signal.name))
    }
    if (input.sentBlock !== '') out.push(input.sentBlock)
    if (input.knowledgeHint !== '') out.push(input.knowledgeHint)
    return out.join('\n')
  }

  /** 私聊一包（v2）：抬头 + 房间行 + 当前块 + 知识召回。 */
  dmPacketV2(input: DmPacketV2Input): string {
    const target = input.roomKey.slice(input.roomKey.indexOf(':') + 1)
    // 本地补丁 COMPANION-QQ-PATCH-9：**必须**带上房间指令（`room/dm-v2`：
    // 「这是私聊…要发言必须用 qq_message 工具…」）。2026-11-01 21:54 事故：这一行
    // 被漏掉后，模型只看到「【QQ路由】isGroup=false；target=…」，于是把回复当普通
    // 文本吐在回合里，QQ 上一个字也没发出去（turn 记录里 0 个工具调用）。
    // 群聊那条（dmPacketV2 的兄弟 `groupPacketV2`）一直都是带 `input.room` 的。
    const out = [`【QQ路由】isGroup=false；target=${target}`, input.room]
    if (input.line !== null) {
      out.push(CURRENT_TITLE, untrustedEnvelope(input.roomKey, input.line))
      const routed = routeSignals(input.signals, input.line, '')
      for (const signal of routed.current) out.push(injectionWarningLine(signal.name))
    }
    if (input.knowledgeHint !== '') out.push(input.knowledgeHint)
    return out.join('\n')
  }

  /** 注入模式一条（v2）：每条注入的都是"当前消息"。 */
  injectPacketV2(input: InjectPacketV2Input): string {
    const header = this.r(input.called ? 'inject/called-header' : 'inject/ambient-header')
    const out = [header, input.room, CURRENT_TITLE, untrustedEnvelope(input.roomKey, input.body)]
    const routed = routeSignals(input.signals, input.body, '')
    for (const signal of routed.current) out.push(injectionWarningLine(signal.name))
    return out.join('\n')
  }

  /** 主动回合（巡逻 / 做梦 / 自省 / 主动私聊 / 后台指令）的抬头。 */
  proactive(period: string, room: string, prompt: string): string {
    return `${this.timeNote(period)}\n${room}\n${prompt}`
  }

  /** 戳一戳裁决：告诉模型"谁戳了咱、最近第几次"，其余交给它自己决定。 */
  pokeNotice(input: { pokerId: number; minutes: number; count: number }): string {
    return this.r('notice/poke', {
      pokerId: String(input.pokerId),
      minutes: String(input.minutes),
      count: String(input.count),
    })
  }

  /** 群事件合并包。`lines` 只取最近 12 条（原来的行为）。 */
  eventNotice(lines: readonly string[]): string {
    return this.r('notice/events', { events: lines.slice(-12).join('\n') })
  }

  /** 网关重试时补的那句话（原包已经在会话历史里，这句只是"接着做"）。 */
  gatewayNudge(): string {
    return this.r('retry/gateway-nudge')
  }
}
