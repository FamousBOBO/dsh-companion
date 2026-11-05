import type { PipelineDeps } from './pipeline.js'
import type { ConversationRecord as Conversation } from '../conversation/registry.js'
import type { OneBotEvent } from '../../types.js'
import { userOrigin } from './origin.js'

export class DmBuffer {
  private readonly started = new Map<string, number>()
  private readonly composing = new Set<string>()
  /** 每会话的 flush 失败次数与首次失败时刻：让"卡住"在诊断面可见。 */
  private readonly flushFailures = new Map<string, { count: number; firstAt: number }>()
  constructor(private readonly deps: PipelineDeps) {}

  accept(conversation: Conversation, event: OneBotEvent): boolean {
    if (typeof event.message_id === 'number') {
      conversation.seenMessageIds ??= new Set()
      if (conversation.seenMessageIds.has(event.message_id)) return false
      if (conversation.seenMessageIds.size >= 500) {
        conversation.seenMessageIds = new Set([...conversation.seenMessageIds].slice(-250))
      }
      conversation.seenMessageIds.add(event.message_id)
    }
    conversation.lastEvent = event
    return true
  }

  enqueue(conversation: Conversation, line: string | null, images: readonly unknown[], chars: number): void {
    if (line !== null) conversation.queue.push(line)
    const cap = Math.max(1, this.deps.config().imageRecognition.maxPerMessage)
    conversation.pendingImages = [...conversation.pendingImages, ...images].slice(-cap)
    if (!this.started.has(conversation.key)) this.started.set(conversation.key, this.deps.clock.now())
    this.schedule(conversation, chars)
  }

  /** 短句更可能还没说完；长句缩短等待。上轮未结束时保留队列，不排多个 followup。 */
  private schedule(conversation: Conversation, chars: number): void {
    const cfg = this.deps.config().batching
    const longMs = cfg.dmLongMs ?? 1500
    const shortMs = Math.max(longMs, cfg.dmShortMs ?? 6000)
    const ratio = Math.min(1, Math.max(0, chars) / (cfg.dmLongChars ?? 80))
    const delay = Math.round(shortMs - ratio * (shortMs - longMs))
    const started = this.started.get(conversation.key) ?? this.deps.clock.now()
    const remaining = Math.max(0, (cfg.dmMaxWaitMs ?? 15000) - (this.deps.clock.now() - started))
    conversation.batchTimer?.cancel()
    conversation.batchTimer = this.deps.clock.setTimeout(() => {
      conversation.batchTimer = null
      void this.flush(conversation).catch(error => this.deps.log(`dm flush failed: ${String(error)}`))
    }, Math.min(delay, remaining))
  }

  /** 指数退避：80 → 320 → 1280 → 5000，且不超过合并窗口上限。 */
  private backoffFor(failures: number): number {
    const steps = [80, 320, 1280, 5000]
    const index = Math.min(steps.length - 1, Math.max(0, failures - 1))
    const cap = this.deps.config().batching?.dmMaxWaitMs ?? 15000
    return Math.min(steps[index] ?? 80, cap)
  }

  /** 记一次 flush 失败；**日志节流**（第 1/5/20 次，之后每 50 次），否则同一行会淹掉别的。 */
  private noteFlushFailure(key: string): { count: number; firstAt: number } {
    const previous = this.flushFailures.get(key)
    const next = previous === undefined
      ? { count: 1, firstAt: this.deps.clock.now() }
      : { count: previous.count + 1, firstAt: previous.firstAt }
    this.flushFailures.set(key, next)
    const n = next.count
    if (n === 1 || n === 5 || n === 20 || n % 50 === 0) {
      this.deps.log(`dm flush failed x${String(n)}（自 ${String(next.firstAt)}）：内容已放回队列，按退避重试`)
    }
    return next
  }

  /** 诊断面：**没有失败数据时是 `null`（不是 0）**——"没消息"和"零失败"要分得开。 */
  diagnostics(): { flushFailures: { count: number; firstFailureAt: number; flushStuck: boolean } | null } {
    let worst: { count: number; firstAt: number } | null = null
    for (const item of this.flushFailures.values()) {
      if (worst === null || item.count > worst.count) worst = item
    }
    if (worst === null) return { flushFailures: null }
    return { flushFailures: { count: worst.count, firstFailureAt: worst.firstAt, flushStuck: worst.count >= 20 } }
  }

  private async flush(conversation: Conversation): Promise<void> {
    // 本地补丁 COMPANION-QQ-PATCH-6：这一轮**还在跑**（典型场景：她正在分段发送，
    // 段间有停顿）时，这一批新消息不再等回合结束，而是直接作为「引导」插进当前回合。
    //
    // 2026-10-31 事故后曾把这条闸绑在 `injectMode.enabled` 上（那是"所有消息都改走注入"），
    // 于是"中途插话"实际上被彻底关掉了（2026-11-04 用户复查：`guidance injected` 只在
    // 10-30/10-31 出现过）。现在它有独立开关 `injectMode.duringTurn`，默认关、按需打开。
    const injectDuringTurn = this.deps.config().injectMode.duringTurn === true
    if (injectDuringTurn && conversation.tracker.running() && conversation.queue.length > 0) {
      const lines = conversation.queue.splice(0)
      const event = conversation.lastEvent
      this.started.delete(conversation.key)
      this.composing.add(conversation.key)
      try {
        // 私聊每条都算叫到我；图片在回合进行中不重投（历史里每张都会在每个请求重放）。
        const packet = await this.deps.packets.composeInject(conversation, { called: true, body: lines.join('\n') })
        if (!this.deps.turns.injectGuidance(conversation, packet)) {
          conversation.queue.unshift(...lines)
          this.schedule(conversation, 80)
        }
        conversation.pendingImages = []
        return
      } catch (error) {
        conversation.queue.unshift(...lines)
        this.schedule(conversation, 80)
        throw error
      } finally {
        this.composing.delete(conversation.key)
      }
    }
    if (conversation.tracker.busy() || this.composing.has(conversation.key)) {
      conversation.batchTimer = this.deps.clock.setTimeout(() => {
        conversation.batchTimer = null
        void this.flush(conversation).catch(error => this.deps.log(`dm flush failed: ${String(error)}`))
      }, 500)
      return
    }
    const lines = conversation.queue.splice(0)
    const images = conversation.pendingImages.splice(0, this.deps.config().imageRecognition.maxPerMessage)
    conversation.pendingImages = []
    this.started.delete(conversation.key)
    if (lines.length === 0 && images.length === 0) return
    const event = conversation.lastEvent
    this.composing.add(conversation.key)
    try {
      const packet = await this.deps.packets.composeDm(conversation, { line: lines.join('\n') || null, hasImages: images.length > 0 })
      this.deps.turns.submit(conversation, packet, images, userOrigin(event))
    } catch (error) {
      conversation.queue.unshift(...lines)
      conversation.pendingImages.unshift(...images)
      // **内容仍放回（不许丢）**；指数退避只降低重试频率，不是放弃。
      const failure = this.noteFlushFailure(conversation.key)
      this.schedule(conversation, this.backoffFor(failure.count))
      throw error
    } finally {
      this.composing.delete(conversation.key)
    }
  }

}
