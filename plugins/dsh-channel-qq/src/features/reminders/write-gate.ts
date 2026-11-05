/**
 * **写入门闩**（round8）：读失败时锁住所有落盘路径，并把**故障状态落成文件**。
 *
 * 为什么单独一个文件：`store.ts` 顶到 400 行硬上限（`scripts/check-size.mjs`），
 * 而这块逻辑自成一事（不依赖提醒数据本身）。它只管一件事：
 *
 * > 如果盘上**有**提醒文件但读不出来（损坏/权限/半截 JSON），内存里就是空表；
 * > 此时任何一次 `save()` 都会把空表写回去，把也许还能人工救的原文件**抹掉**。
 *
 * 三条规矩（review round8 的要求）：
 *   1. 闩上时**不只是打一行日志**——把故障状态写进 sidecar `<file>.readonly.json`，
 *      这样"重启之后还看得见出过事"，运维不用翻历史日志；
 *   2. sidecar 里带 `reason`/`at`/`source`（谁是现场、什么时候），给人工判断用；
 *   3. **显式恢复**：`clear()`（= 确认原文件已处理）会删掉 sidecar。
 *
 * 注意：sidecar 本身是**诊断文件**，不是数据——读失败时写它不会覆盖任何真实数据。
 */

import * as fs from 'node:fs'

/** 落盘的故障状态（给运维看）。 */
export interface ReadFailure {
  /** 什么时候发现的（毫秒）。 */
  at: number
  /** 为什么：`unreadable`（存在但读不出来/解析失败）/ `permission`（读被拒）。 */
  reason: 'unreadable' | 'permission'
  /** 出事的那个文件。 */
  source: string
  /** 人能看懂的一句话。 */
  detail: string
}

export class WriteGate {
  private locked: boolean
  private failure: ReadFailure | null = null

  constructor(
    locked: boolean,
    private readonly log: (line: string) => void,
    private readonly markerFile: string | null = null,
  ) {
    // **round9**：sidecar 真的**读回来**（以前注释说"重启后从 sidecar 读回来"，实现里却根本没读）。
    // 语义：sidecar 存在 ⇒ 说明上一次读失败还没被人确认处理过 ⇒ 继续闩住，直到显式 `clear()`。
    const persisted = this.loadMarker()
    this.locked = locked || persisted !== null
    this.failure = persisted
  }

  /** 读 sidecar（不存在/读不动都算"没有"）。 */
  private loadMarker(): ReadFailure | null {
    if (this.markerFile === null) return null
    try {
      const text = fs.readFileSync(this.markerFile, 'utf8')
      const parsed = JSON.parse(text) as ReadFailure
      return typeof parsed?.at === 'number' && typeof parsed?.reason === 'string' ? parsed : null
    } catch {
      return null
    }
  }

  /** 闩上（读失败）。给了 `markerFile` 就把故障状态落成 sidecar。 */
  lock(failure: ReadFailure): void {
    this.locked = true
    this.failure = failure
    if (this.markerFile === null) return
    try {
      fs.writeFileSync(this.markerFile, `${JSON.stringify(failure, null, 2)}\n`, 'utf8')
    } catch (error) {
      // 写不成 sidecar 不影响内存里的闩（只是少一份给运维看的证据）。
      this.log(`reminders: 读失败标记写不出来（不影响锁）：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 当前是否闩着。 */
  isLocked(): boolean {
    return this.locked
  }

  /** **持久故障状态**（内存里那份；重启后从 sidecar 读回来）。 */
  failureState(): ReadFailure | null {
    return this.failure
  }

  /**
   * 闩着就拒绝这次写入并记一行，返回 `true`（调用方据此跳过落盘，**不抛错**，
   * 让这一轮跑完而不是把整条链路炸掉）。
   */
  refuse(where: string): boolean {
    if (!this.locked) return false
    this.log(`reminders: **写入被拒绝**（${where}）——盘上原有提醒文件读不出来，先修好再写，`
      + '否则会把读失败的空表覆盖掉真实数据')
    return true
  }

  /** 与 `refuse` 相同，但**抛错**（给"成败必须返回给调用方"的路径用）。 */
  assertOpen(where: string): void {
    if (this.locked) {
      this.log(`reminders: **写入被拒绝**（${where}）——盘上原有提醒文件读不出来，先修好再写`)
      throw new Error('reminders-read-locked')
    }
  }

  /** **显式恢复**：确认人工处理过原文件之后调用（也可以直接重启）。 */
  clear(): void {
    this.locked = false
    this.failure = null
    if (this.markerFile !== null) {
      try { fs.rmSync(this.markerFile, { force: true }) } catch { /* 删不掉也不影响解锁 */ }
    }
    this.log('reminders: 读失败锁已解除（写入恢复）')
  }
}
