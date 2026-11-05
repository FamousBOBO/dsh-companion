/** 指标采集（C1/C2）：回合耗时、token 增量、发送失败。
 *
 * 三条设计取舍：
 *   - **开关现取**：关着时 `begin` 不记开始时间，`end` 是空操作，一个样本都不写；
 *   - **用量是差值**：宿主 `tokenUsage` 是会话累计值，按房间记住上一次读数，
 *     相减才是"这一轮花了多少"；
 *   - **失败不拖累回合**：读用量、写文件都在后台 fire-and-forget，异常只记日志。
 */

import { sessionIdOf } from '../../core/room.js'
import type { MetricSample } from '../../core/metrics/aggregate.js'
import type { UsageBuckets, UsageProbe } from '../../ports/usage.js'
import type { MetricsStore } from './store.js'

const ZERO: UsageBuckets = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }

export interface MetricsDeps {
  readonly enabled: () => boolean
  readonly now: () => number
  readonly usage: () => UsageProbe | undefined
  readonly store: MetricsStore
  readonly log: (line: string) => void
}

export class MetricsService {
  private readonly starts = new Map<string, number>()
  private readonly errored = new Set<string>()
  private readonly lastUsage = new Map<string, UsageBuckets>()
  private sends = 0
  private sendFailures = 0

  constructor(private readonly deps: MetricsDeps) {}

  /** 回合开始：记起点、清掉上一轮的失败标记。 */
  begin(room: string): void {
    if (!this.deps.enabled()) return
    this.starts.set(room, this.deps.now())
    this.errored.delete(room)
  }

  /** 回合出错：只标记，真正落样本在 `end`（那时才知道耗时）。 */
  error(room: string): void {
    if (!this.deps.enabled()) return
    this.errored.add(room)
  }

  /** 回合结束：算耗时，后台读用量差值并落一条样本。 */
  end(room: string): void {
    const start = this.starts.get(room)
    this.starts.delete(room)
    if (start === undefined || !this.deps.enabled()) {
      this.errored.delete(room)
      return
    }
    const ms = Math.max(0, this.deps.now() - start)
    const ok = !this.errored.delete(room)
    void this.record(room, ms, ok)
  }

  /** 出站计数（platform 的出站队列调用）。 */
  sendOk(): void { this.sends += 1 }
  sendFailed(): void { this.sendFailures += 1 }

  /** 后台页读的进程内计数。 */
  counters(): { sends: number; sendFailures: number } {
    return { sends: this.sends, sendFailures: this.sendFailures }
  }

  private async record(room: string, ms: number, ok: boolean): Promise<void> {
    let buckets = ZERO
    try {
      const probe = this.deps.usage()
      const usage = probe === undefined ? null : await probe.usage(sessionIdOf(room))
      if (usage !== null) {
        const previous = this.lastUsage.get(room) ?? ZERO
        this.lastUsage.set(room, usage)
        buckets = {
          uncachedInputTokens: Math.max(0, usage.uncachedInputTokens - previous.uncachedInputTokens),
          outputTokens: Math.max(0, usage.outputTokens - previous.outputTokens),
          cacheReadTokens: Math.max(0, usage.cacheReadTokens - previous.cacheReadTokens),
          cacheWriteTokens: Math.max(0, usage.cacheWriteTokens - previous.cacheWriteTokens),
        }
      }
    } catch (error) {
      this.deps.log(`metrics: usage read failed for ${room}: ${error instanceof Error ? error.message : String(error)}`)
    }
    const sample: MetricSample = {
      at: this.deps.now(),
      room,
      ms,
      ok,
      input: buckets.uncachedInputTokens,
      output: buckets.outputTokens,
      cacheRead: buckets.cacheReadTokens,
      cacheWrite: buckets.cacheWriteTokens,
    }
    this.deps.store.add(sample)
    try {
      await this.deps.store.flush()
    } catch (error) {
      this.deps.log(`metrics: flush failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
