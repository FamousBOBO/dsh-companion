/** 回合告知（A2）：慢回合一句「还在处理」，永久失败一句「没处理完」。
 *
 * 只在用户回合里工作；主动/定时回合没有"对方在等"，不发。
 * 两条提示都只发一次，且失败只写日志——提示不能反过来拖垮回合。
 */

import type { QQChannelConfig } from '../../config.js'
import { splitRoom } from '../../core/room.js'
import type { PersonaPack } from '../../ports/persona.js'
import type { QQApi } from '../../ports/platform.js'
import type { OutboundQueue } from '../../outbound.js'

export interface ReliabilityDeps {
  readonly api: () => QQApi | null
  readonly out: () => OutboundQueue | null
  readonly config: () => QQChannelConfig['reliability']
  readonly persona: () => PersonaPack | null
  readonly log: (line: string) => void
  /** 现在几点（测试注入）。 */
  readonly now?: () => number
}

/** 同一房间两次「没处理完」的最小间隔：额度耗尽时别每条都报。 */
const FAILURE_COOLDOWN_MS = 10 * 60_000

export class Reliability {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly failed = new Set<string>()
  /** 用户回合进行中的房间：主动/定时回合不在这里，失败时不该发告知。 */
  private readonly active = new Set<string>()
  private readonly lastFailureAt = new Map<string, number>()
  private readonly now: () => number

  constructor(private readonly deps: ReliabilityDeps) {
    this.now = deps.now ?? (() => Date.now())
  }

  /** 用户回合开始：清掉上一轮残留，按需挂慢回合计时器。 */
  begin(room: string): void {
    this.clearTimer(room)
    this.active.add(room)
    this.failed.delete(room)
    const config = this.deps.config()
    if (!config.slowNotice) return
    const timer = setTimeout(() => {
      this.timers.delete(room)
      this.notice(room, 'notice/slow-turn')
    }, config.slowAfterMs)
    timer.unref?.()
    this.timers.set(room, timer)
  }

  /** 出错：只有"确定不会再试"、且这是用户回合时，才记下来。 */
  error(room: string, kind: 'retry' | 'permanent'): void {
    if (!this.active.has(room)) return
    if (kind !== 'permanent') return
    if (!this.deps.config().failureNotice) return
    this.failed.add(room)
  }

  /** 回合结束：撤计时器；永久失败的补一句告知（同一房间 10 分钟最多一次）。 */
  end(room: string): void {
    this.clearTimer(room)
    const wasActive = this.active.delete(room)
    if (!wasActive || !this.failed.delete(room)) return
    const now = this.now()
    const last = this.lastFailureAt.get(room) ?? 0
    if (now - last < FAILURE_COOLDOWN_MS) return
    this.lastFailureAt.set(room, now)
    this.notice(room, 'notice/turn-failed')
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.failed.clear()
    this.active.clear()
    this.lastFailureAt.clear()
  }

  private clearTimer(room: string): void {
    const timer = this.timers.get(room)
    if (timer !== undefined) clearTimeout(timer)
    this.timers.delete(room)
  }

  private notice(room: string, key: string): void {
    const target = splitRoom(room)
    const api = this.deps.api()
    const out = this.deps.out()
    const persona = this.deps.persona()
    if (target === null || api === null || out === null || persona === null) return
    let text: string
    try {
      text = persona.render(key).trim()
    } catch (error) {
      this.deps.log(`reliability: 人格包缺 ${key}：${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (text === '') return
    void out.push(() => api.sendTo(target.isGroup, target.chatId, [{ type: 'text', data: { text } }]))
      .catch((error: unknown) => {
        this.deps.log(`reliability: 提示发送失败 ${room}：${error instanceof Error ? error.message : String(error)}`)
      })
  }
}
