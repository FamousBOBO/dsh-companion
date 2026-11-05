/** 交互提示子插件（A1）：回合进行中的「正在输入」与表情回应。
 *
 * 两件都是**感知层**：
 *   - 私聊回合开始时 `set_input_status 1`、结束时 `0`；
 *   - 回合开始时给触发消息贴一个表情，结束时撤掉。
 *
 * 三条硬规则：
 *   1. 配置关着时**一个协议动作都不发**（默认关，golden 不动）；
 *   2. 任何失败只写一行日志，绝不影响回合（这是提示，不是消息）；
 *   3. `end` 撤销的是**当时真的发出去的那一个**——回合中途改配置也不会撤错表情。
 */

import type { QQChannelConfig } from '../../config.js'
import type { QQApi } from '../../ports/platform.js'
import type { TurnHooks } from '../../ports/turn-hooks.js'
import type { OneBotEvent } from '../../types.js'
import type { SubPlugin } from '../plugin-kit.js'

/** 一个房间里已经发出去的提示（end 按它逐项撤销）。 */
interface ActiveHint {
  /** 开始过输入状态；`userId` 是私聊对方。 */
  readonly typingUserId: number | null
  /** 贴过表情；带上当时的 emoji id。 */
  readonly reaction: { readonly messageId: number; readonly emojiId: string } | null
}

export interface InteractionDeps {
  readonly api: () => QQApi | null
  readonly config: () => QQChannelConfig['interaction']
  readonly log: (line: string) => void
}

export class Interaction implements TurnHooks {
  /** 房间 → 已发出的提示。 */
  private readonly active = new Map<string, ActiveHint>()
  /** 本地补丁 COMPANION-QQ-PATCH-7：协议动作**串行**发出（见 `queue()`）。 */
  private chain: Promise<void> = Promise.resolve()
  /** 房间 → 「正在输入」的自动撤销定时器。 */
  private readonly watchdogs = new Map<string, ReturnType<typeof setTimeout>>()
  /**
   * 「正在输入」最长显示多久。真实回合可能很长（生图 60 秒、分段发送几秒），
   * 但一个提示绝不能无限挂着：idle 一旦丢失（宿主重启、会话换血、网关重试），
   * QQ 那边就会一直显示"对方正在说话"。到点无条件撤销。
   */
  private static readonly TYPING_MAX_MS = 120_000

  constructor(private readonly deps: InteractionDeps) {}

  /** 用户回合开始：按开关发提示。 */
  begin(room: string, event: OneBotEvent): void {
    // 同一房间上一轮还没撤销（例如 idle 丢失）时先撤，避免两次提示叠加。
    this.end(room)
    const config = this.deps.config()
    const api = this.deps.api()
    if (api === null) return
    const isGroup = event.message_type === 'group'
    const userId = typeof event.user_id === 'number' ? event.user_id : null
    const messageId = typeof event.message_id === 'number' ? event.message_id : null
    const typingUserId = config.typingIndicator && !isGroup ? userId : null
    // 本地补丁 COMPANION-QQ-PATCH-11：**私聊也贴表情**（"已读"反应）。
    // 上游注释（2026-10-22）只在 SnowLuma 上实测过私聊表情不受支持；换成 NapCat 4.18.19
    // 后 `set_msg_emoji_like` 对私聊可用，2026-11-03 直连探测 `retcode: 0`（内层 QQ 错误码
    // 另算，见 `queue()` 的 rejected 日志）。群聊行为不变。
    const reaction = config.ackReaction && messageId !== null
      ? { messageId, emojiId: config.ackEmojiId }
      : null
    if (typingUserId === null && reaction === null) return
    this.active.set(room, { typingUserId, reaction })
    if (typingUserId !== null) {
      const userId = typingUserId
      this.armWatchdog(room, () => {
        this.deps.log(`interaction: 正在输入超过 ${Interaction.TYPING_MAX_MS / 1000}s，自动撤销（${room}）`)
        this.queue(room, 'input status timeout off', () => api.setInputStatus(userId, 0))
        this.active.delete(room)
      })
      this.queue(room, 'input status on', () => api.setInputStatus(userId, 1))
    }
    if (reaction !== null) {
      this.queue(room, 'reaction on', () => api.setMessageEmojiLike(reaction.messageId, reaction.emojiId, true))
    }
  }

  /** 回合结束（成功/失败/释放）：撤销这个房间里已发出的提示。 */
  end(room: string): void {
    const hint = this.active.get(room)
    if (hint === undefined) return
    this.active.delete(room)
    this.disarmWatchdog(room)
    const api = this.deps.api()
    if (api === null) return
    if (hint.typingUserId !== null) {
      const userId = hint.typingUserId
      this.queue(room, 'input status off', () => api.setInputStatus(userId, 0))
    }
    if (hint.reaction !== null) {
      const { messageId, emojiId } = hint.reaction
      this.queue(room, 'reaction off', () => api.setMessageEmojiLike(messageId, emojiId, false))
    }
  }

  /** 插件卸载/宿主关闭：把还挂着的提示全部撤掉，别把"正在输入"留在 QQ 上。 */
  dispose(): void {
    for (const room of [...this.active.keys()]) this.end(room)
  }

  private armWatchdog(room: string, fire: () => void): void {
    this.disarmWatchdog(room)
    const timer = setTimeout(() => {
      this.watchdogs.delete(room)
      fire()
    }, Interaction.TYPING_MAX_MS)
    // 定时器不该单独把进程吊着活。
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) (timer as { unref: () => void }).unref()
    this.watchdogs.set(room, timer)
  }

  private disarmWatchdog(room: string): void {
    const timer = this.watchdogs.get(room)
    if (timer === undefined) return
    clearTimeout(timer)
    this.watchdogs.delete(room)
  }

  /** 发一个提示动作；失败只记日志。 */
  private call(room: string, what: string, run: () => Promise<unknown>): void {
    void run().catch((error: unknown) => {
      this.deps.log(`interaction ${what} failed for ${room}: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /**
   * 本地补丁 COMPANION-QQ-PATCH-7：把协议动作排成一条链，保证「开」永远先于「关」。
   *
   * 上游这里是 fire-and-forget：`begin()` 和紧跟其后的 `end()`（重试 / 换血 / 下一轮
   * 立刻开始）各自发一个独立请求，两个请求的**到达顺序没有保证**。只要那个 `1` 后到，
   * 对方就会一直看到"正在输入"——2026-10-31 实测就是这个症状。串行之后，最后一个
   * 动作必然是后发生的那个状态。
   */
  private queue(room: string, what: string, run: () => Promise<unknown>): void {
    this.chain = this.chain
      .then(() => run())
      .then((result) => {
        // 本地补丁 COMPANION-QQ-PATCH-11：OneBot 的 `retcode: 0` 不代表 QQ 侧成功——
        // 内层 `data.result` 才是。NapCat 对过期消息/频率限制会回 65011 / 65009，
        // 不记录的话这些提示"看起来发了其实没生效"。
        const ack = result as { result?: unknown; errMsg?: unknown } | null
        const inner = ack !== null && typeof ack === 'object' ? Number(ack.result ?? 0) : 0
        if (Number.isFinite(inner) && inner !== 0) {
          this.deps.log(`interaction ${what} rejected for ${room}: ${String(ack?.errMsg ?? '')} (result=${inner})`)
          return
        }
        this.deps.log(`interaction ${what} ok for ${room}`)
      })
      .catch((error: unknown) => {
        this.deps.log(`interaction ${what} failed for ${room}: ${error instanceof Error ? error.message : String(error)}`)
      })
  }
}

export const interactionPlugin: SubPlugin = {
  name: 'interaction',
  watches: ['interaction'],
  requires: ['platform'],
  apply(host) {
    const interaction = new Interaction({
      api: () => host.get('platform')?.api ?? null,
      config: () => host.config.interaction,
      log: host.log,
    })
    host.provide('interaction', interaction)
    // 卸载/重载时把挂着的「正在输入」撤掉（COMPANION-QQ-PATCH-7）。
    return () => interaction.dispose()
  },
}
