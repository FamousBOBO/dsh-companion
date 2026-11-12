/**
 * **到期未消费的退避状态**（第二轮 P1-B：从"1 ms 空转"改成"有上限的退避"）。
 *
 * 为什么单独一个类：这段是**有状态的判据**，而 `schedule.ts` 里的三个函数是纯函数
 * （那里连"上一拍剩几条"都不该知道）。分开之后两件事都能单独测，`runner.ts` 也不会
 * 再因为这个状态而变胖（它贴着 400 行硬上限）。
 *
 * 语义只有一条：**到期项变少了 ⇒ 有进展 ⇒ 清零；没变少 ⇒ 没进展 ⇒ 加一。**
 *
 *   - 有进展 ⇒ `overdueGapMs({ passes: 0 })` = 1 秒（积压按节奏继续，但不一口气喷完）；
 *   - 没进展 ⇒ 1 s → 2 s → 4 s … 直到心跳（`dryRun`、通道断开、房间不许发、日程阻断）。
 *
 * **只在内存里**：dryRun 承诺"整条入口零持久化写入"，退避状态也不许落盘。
 */

import { overdueGapMs } from './schedule.js'

export interface BackoffSnapshot {
  /** 连续几拍"到期项还在、而且没变少"。 */
  readonly overduePasses: number
  /** 按它算出来的下一拍间隔（`null` = 还没算过）。 */
  readonly gapMs: number | null
}

export class WakeupBackoff {
  private passes = 0
  private gap: number | null = null

  /**
   * 记一拍的进展，返回**这一拍之后**的退避状态。
   *
   * @param before 开拍前的到期项条数
   * @param after 收拍后的到期项条数
   */
  note(before: number, after: number): BackoffSnapshot {
    this.passes = after === 0 || after < before ? 0 : this.passes + 1
    return this.snapshot()
  }

  /** 下一拍该给到期的项留多少毫秒（未来项不受它影响，见 `planWakeup`）。 */
  gapFor(heartbeatMs: number): number {
    return overdueGapMs({ passes: this.passes, heartbeatMs })
  }

  /** 记下最终采用的间隔（诊断面 `backoff.gapMs`）。 */
  remember(gapMs: number): void { this.gap = gapMs }

  snapshot(): BackoffSnapshot { return { overduePasses: this.passes, gapMs: this.gap } }

  /** `nudge` / 启动时复位：那两种现场的语义是"还没试过，马上试"。 */
  reset(): void { this.passes = 0 }
}
