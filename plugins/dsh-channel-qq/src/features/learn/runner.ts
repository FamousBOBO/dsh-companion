/** 群聊学习 (P4.2)：定期把内存候选合并落盘的 runner。
 * 从 src/learn.ts 原样搬来（store 在 ./store.ts、工具面在 ./tools.ts）。
 */

import type { LearnStore } from './store.js'

/** 定期把内存候选合并落盘。 */
export class LearnRunner {
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly store: LearnStore,
    private readonly log: (line: string) => void,
  ) {}

  start(intervalMs = 5 * 60_000): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => {
      void this.store.flush().catch((error: unknown) => {
        this.log(`learn: flush 失败：${error instanceof Error ? error.message : String(error)}`)
      })
    }, Math.max(1_000, intervalMs))
    // unref 掉：学习任务不该拖住进程退出。
    this.timer.unref()
  }

  dispose(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}
