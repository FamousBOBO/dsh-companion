/** SSE 的"实时"来源：状态推送与日志增量跟随。
 *
 * 只有**存在 SSE 客户端时**才做事（没有连接的轮询也照样能用），所以一个
 * 常驻的低频定时器就够了，不引入连接挂钩。日志增量用"最后一行"做游标：
 * 日志是追加写、极少轮转；找不到游标（轮转/截断）时退化成"重发最后 20 行"，
 * 宁可重复也不丢。日志在出网前统一掩码。
 */

import { maskSecretText } from './config-engine.js'
import type { EventHub } from './sse.js'

/** 检查间隔：状态每 3 个 tick（≈7.5s）推一次，日志每个 tick 跟一次。 */
const TICK_MS = 2500

export interface LiveDeps {
  status: () => Promise<Record<string, unknown>>
  readLog: (lines: number) => Promise<string[]>
}

export class LiveFeed {
  private timer: NodeJS.Timeout | null = null
  private lastLine = ''
  private tick = 0

  constructor(
    private readonly hub: EventHub,
    private readonly deps: LiveDeps,
    /** 当前需要掩码的敏感值（每次取，配置可变）。 */
    private readonly maskOf: () => string[],
  ) {}

  start(): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => { void this.tickOnce() }, TICK_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer === null) return
    clearInterval(this.timer)
    this.timer = null
  }

  private async tickOnce(): Promise<void> {
    if (this.hub.count === 0) return
    this.tick += 1
    if (this.tick % 3 === 0) {
      try { this.hub.broadcast('status', await this.deps.status()) } catch { /* 状态推送失败不致命 */ }
    }
    try {
      const tail = await this.deps.readLog(400)
      const lines = this.maskOf().length === 0 ? tail : tail.map((line) => maskSecretText(line, this.maskOf()))
      const fresh = this.since(lines)
      if (fresh.length === 0) return
      this.hub.broadcast('log', { lines: fresh })
      this.lastLine = lines[lines.length - 1] ?? this.lastLine
    } catch { /* 日志读取失败不致命 */ }
  }

  /** 自上次游标之后的新行。 */
  private since(lines: string[]): string[] {
    if (lines.length === 0) return []
    if (this.lastLine === '') return lines.slice(-20)
    const index = lines.lastIndexOf(this.lastLine)
    return index >= 0 ? lines.slice(index + 1) : lines.slice(-20)
  }
}
