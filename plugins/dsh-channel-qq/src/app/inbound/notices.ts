/** 通知（notice）的裁决与合并：戳一戳、进退群、禁言、撤回、荣誉、加好友。
 *
 * 两条完全不同的路径，放在一起是因为它们处理的是同一类输入：
 *
 *   1. **戳一戳** —— 单独走"耐心窗口"：窗口里被戳多次只裁决一次，免得有人连点几下
 *      就把模型刷醒。裁决交给模型（它可以戳回去、可以说一句、也可以不理），
 *      插件自己**从不**代替它出手；
 *   2. **其它群事件** —— 合并成一条话题素材。两条刻意的限制让它不至于变成噪音：
 *      只在**已经存在**的会话里说话（热闹群的进出不会凭空拉起一个会话），
 *      并且按 `eventMonitor.windowSec` 把一串事件合并成一行上下文。
 *
 * `poke` 被明确排除在第二条之外：它有自己的耐心窗口，两边都算就是重复计数。
 */

import type { OneBotEvent } from '../../types.js'
import { groupRoom } from '../../core/room.js'
import { describeNotice, noticeKind } from '../../core/message/notice.js'
import type { Clock, TimerHandle } from '../../ports/clock.js'
import type { ChatPlatform } from '../../ports/platform.js'
import type { ConversationRegistry } from '../conversation/registry.js'
import type { TurnLauncher } from '../conversation/turns.js'
import type { TurnOrigin } from '../conversation/origins.js'
import type { PromptComposer } from '../conversation/prompt-composer.js'

/** 通知处理用到的配置。 */
export interface NoticesConfig {
  readonly selfId: number
  readonly poke: { readonly enabled: boolean; readonly windowSec: number }
  readonly eventMonitor: { readonly enabled: boolean; readonly kinds: readonly string[]; readonly windowSec: number }
}

export interface NoticeHandlerDeps {
  readonly registry: ConversationRegistry
  readonly turns: TurnLauncher
  readonly prompts: PromptComposer
  readonly platform: () => ChatPlatform
  readonly clock: Clock
  readonly config: () => NoticesConfig
  readonly log: (line: string) => void
}

export class NoticeHandler {
  /** 每个房间的戳一戳时间戳（耐心窗口内合并成一次裁决）。 */
  private readonly pokes = new Map<string, number[]>()
  /** 合并中的群事件行，按房间。 */
  private readonly buckets = new Map<string, string[]>()
  private readonly timers = new Map<string, TimerHandle>()

  constructor(private readonly deps: NoticeHandlerDeps) {}

  /** 卸载：取消全部合并窗口定时器。 */
  dispose(): void {
    for (const timer of this.timers.values()) timer.cancel()
    this.timers.clear()
    this.buckets.clear()
  }

  /** 一条通知进来。 */
  async handle(event: OneBotEvent): Promise<void> {
    // 其它通知先处理：它们只给**已经存在**的会话加话题素材，不会自己建会话。
    this.handleMonitored(event)
    await this.handlePoke(event)
  }

  /** 戳一戳：耐心窗口 + 交给模型裁决。 */
  private async handlePoke(event: OneBotEvent): Promise<void> {
    const poke = this.deps.config().poke
    if (!poke.enabled) return
    if (event.notice_type !== 'notify' || event.sub_type !== 'poke') return
    const self = this.deps.platform().selfId ?? this.deps.config().selfId
    if (event.target_id !== self) return
    const groupId = event.group_id
    const pokerId = event.user_id
    if (typeof groupId !== 'number' || typeof pokerId !== 'number') return
    const key = groupRoom(groupId)
    this.deps.log(`poked by QQ${pokerId} in ${groupId} — submitting for agent adjudication`)

    // 裁决模式：插件从不自己戳回去或说话，每一次戳都作为通知交给模型，由它决定
    // 怎么回应（包括 qq_send_poke）。这里只做限流：窗口内的多次戳合并成一次。
    const now = this.deps.clock.now()
    const windowMs = poke.windowSec * 1000
    const list = (this.pokes.get(key) ?? []).filter((t) => now - t < windowMs)
    list.push(now)
    this.pokes.set(key, list)
    if (list.length > 1) return // 这个窗口里已经排好一次裁决了

    const conversation = this.deps.registry.get(key)
    if (conversation === undefined || conversation.session === null) return
    const minutes = Math.max(1, Math.round(poke.windowSec / 60))
    const prompt = this.deps.prompts.pokeNotice({ pokerId, minutes, count: list.length })
    try {
      await this.deps.registry.ensure(key, conversation.lastEvent)
      this.deps.turns.submit(conversation, prompt, [], { kind: 'notice', userId: pokerId })
    } catch (error) {
      this.deps.log(`poke adjudication failed: ${String(error)}`)
    }
  }

  /** 其余群事件：合并成一个包，投给已经存在的会话。 */
  private handleMonitored(event: OneBotEvent): void {
    const monitor = this.deps.config().eventMonitor
    if (!monitor.enabled) return
    const kind = noticeKind(event)
    if (kind === null || kind === 'poke') return
    if (!monitor.kinds.includes(kind)) return
    const groupId = event.group_id
    if (typeof groupId !== 'number') return
    const key = groupRoom(groupId)
    if (this.deps.registry.get(key) === undefined) return
    const text = describeNotice(event, kind)
    if (text === null) return

    this.buckets.set(key, [...(this.buckets.get(key) ?? []), text])
    if (this.timers.has(key)) return
    const timer = this.deps.clock.setTimeout(() => { this.flush(key) }, Math.max(5, monitor.windowSec) * 1000)
    // 不让一个待合并的窗口把进程吊着。
    timer.unref?.()
    this.timers.set(key, timer)
  }

  /** 合并窗口到期：把攒下的事件行交给模型。 */
  private flush(key: string): void {
    this.timers.delete(key)
    const lines = this.buckets.get(key) ?? []
    this.buckets.delete(key)
    if (lines.length === 0) return
    const conversation = this.deps.registry.get(key)
    if (conversation === undefined || conversation.session === null) return
    try {
      this.deps.turns.submit(conversation, this.deps.prompts.eventNotice(lines), [], NOTICE)
      this.deps.log(`event monitor submitted ${lines.length} event(s) for ${key}`)
    } catch (error) {
      this.deps.log(`event monitor submit failed: ${String(error)}`)
    }
  }
}

/** 群事件合并包的发起人：它们没有单一发起者，记一个中性值。 */
const NOTICE: TurnOrigin = { kind: 'notice', userId: 0 }
