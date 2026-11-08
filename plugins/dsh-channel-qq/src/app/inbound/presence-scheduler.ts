/** 每群的**调度观测**（P3 §7.4）：谁被判过、等了多久、为什么没判。
 *
 * 为什么单独一个文件：这些数字要进后台页面与日志，而"记账"和"调度"是两件事——
 * 混在 `presence-runtime.ts` 里时，一个 60 行的 `noteSkip` 会把定时器与限频的代码隔开，
 * 而那份文件本来就已经接近单文件上限（`check:size` 400 行）。
 *
 * 一条硬约束：**只放数字与布尔，绝不放消息正文**。这份结构会进日志与诊断页面。
 */

/** 一个群的调度观测。 */
export interface GroupSchedulerStats {
  /** 最近一次收到消息的时刻（0 = 还没收到过）。 */
  readonly lastMessageAtMs: number
  /** 最近一次**成功**判断的时刻。 */
  readonly lastJudgeAtMs: number
  /** 当前这批最早那条消息的时刻（0 = 没有待判的批次）。 */
  readonly batchStartedAtMs: number
  /** 当前这批有多少条（未判的旁听）。 */
  readonly batchCount: number
  /** 上一轮判断耗时（毫秒）。 */
  readonly lastJudgeDurationMs: number
  /** 因为限频跳过判断的次数。 */
  readonly skippedByQuota: number
  /** 因为忙碌（同群在途）跳过判断的次数。 */
  readonly skippedByBusy: number
  /** 因为失败退避跳过的次数。 */
  readonly skippedByPause: number
  /** 被判过的批次数。 */
  readonly judgments: number
  /** 真正发出消息的条数。 */
  readonly spoken: number
  /** 出现过"待判消息比 starvationWarnMs 还老"的次数（§7.4 的饥饿告警）。 */
  readonly starvationWarnings: number
  /**
   * `shadow` 下"本来要发"的次数（P5-B / §7.3）。
   *
   * 与 `spoken` **分开统计**：这两个数字放在一起才有意义——shadow 跑一轮应该看到
   * `shadowWouldSend > 0` 且 `spoken === 0`；出现 `spoken > 0` 就说明闸门漏了。
   */
  readonly shadowWouldSend: number
  /**
   * 分段耗时（P7-C / §4.3）：按群累计，用来回答"慢在哪一段"。
   *
   * 为什么分开记而不是一个总耗时：**模型调用**是供应商的锅、**发送**是平台的锅、
   * **合批等待**是我们自己的调度。三件事混成一个数，任何一次变慢都只能靠猜。
   */
  readonly modelLatencyMs: number
  readonly modelCalls: number
  readonly sendLatencyMs: number
  readonly sendAttempts: number
  /** 最近一次"这批等了多久才开始判"（毫秒；0 = 还没有批次）。 */
  readonly lastBatchWaitMs: number
  /**
   * 上下文注入的命中/拒绝计数（P7-C）。
   *
   * `denied` 只在**真的不该给**时加一：群号非法、这个群没有时间线、视图抛错。
   * 两个数字放在一起才能看出"没有连续性"是因为没数据还是因为被拒绝了。
   */
  readonly eventContextInjected: number
  readonly eventContextDenied: number
}

/** 零值（新群的起点）。 */
export function emptyStats(): GroupSchedulerStats {
  return {
    lastMessageAtMs: 0,
    lastJudgeAtMs: 0,
    batchStartedAtMs: 0,
    batchCount: 0,
    lastJudgeDurationMs: 0,
    skippedByQuota: 0,
    skippedByBusy: 0,
    skippedByPause: 0,
    judgments: 0,
    spoken: 0,
    starvationWarnings: 0,
    shadowWouldSend: 0,
    modelLatencyMs: 0,
    modelCalls: 0,
    sendLatencyMs: 0,
    sendAttempts: 0,
    lastBatchWaitMs: 0,
    eventContextInjected: 0,
    eventContextDenied: 0,
  }
}

/** 每个群一份观测的簿记。 */
export class GroupSchedulerBook {
  private readonly stats = new Map<number, GroupSchedulerStats>()

  clear(): void {
    this.stats.clear()
  }

  /** 读（不存在就是零值，**不写入**：读不该产生副作用）。 */
  of(groupId: number): GroupSchedulerStats {
    return this.stats.get(groupId) ?? emptyStats()
  }

  /** 改（不可变更新，方便日志里对比前后）。 */
  update(groupId: number, change: (stats: GroupSchedulerStats) => GroupSchedulerStats): void {
    this.stats.set(groupId, change(this.of(groupId)))
  }

  /**
   * 记一次连续性上下文的注入结果（P7-C）。
   *
   * 两个计数器分开：`denied` 只在**真的不该给**时加一（群号非法 / 没时间线 / 视图抛错）。
   * 合成一个数会让"这个群刚上线，还没有记录"看起来像"上下文注入坏了"。
   */
  noteContinuity(groupId: number, outcome: 'injected' | 'denied'): void {
    this.update(groupId, (stats) => ({
      ...stats,
      eventContextInjected: stats.eventContextInjected + (outcome === 'injected' ? 1 : 0),
      eventContextDenied: stats.eventContextDenied + (outcome === 'denied' ? 1 : 0),
    }))
  }

  /** 诊断导出（按群号，不含正文）。 */
  snapshot(): Array<{ groupId: number } & GroupSchedulerStats> {
    return [...this.stats.entries()].map(([groupId, stats]) => ({ groupId, ...stats }))
  }

  /**
   * 记一次"跳过判断"（限频、暂停、同群在途、没有上下文），并在真的饿着时告警。
   *
   * "持续活跃的群不会无限期得不到判断"这条要求由两件事保证：定时器**不重排**（等待上限天然
   * 成立），以及这条告警——如果一批消息比 `starvationWarnMs` 还老还没被判，那就是真的饿了
   * （限频/暂停/失败退避导致），必须在日志里看得出来，而不是被读成"群里没人说话"。
   *
   * @returns 是否发出了饥饿告警（调用方据此决定要不要再写日志）
   */
  noteSkip(input: {
    groupId: number
    reason: string
    nowMs: number
    pending: number
    maxWaitMs: number
  }): boolean {
    let starved = false
    let waitedMs = 0
    this.update(input.groupId, (stats) => {
      const startedAt = stats.batchStartedAtMs === 0 ? input.nowMs : stats.batchStartedAtMs
      waitedMs = input.nowMs - startedAt
      starved = input.pending > 0 && waitedMs >= input.maxWaitMs
      return {
        ...stats,
        batchStartedAtMs: startedAt,
        batchCount: input.pending,
        skippedByQuota: input.reason === 'hour-quota' || input.reason === 'speak-cooldown'
          ? stats.skippedByQuota + 1
          : stats.skippedByQuota,
        skippedByPause: input.reason === 'paused' ? stats.skippedByPause + 1 : stats.skippedByPause,
        skippedByBusy: input.reason === 'busy' ? stats.skippedByBusy + 1 : stats.skippedByBusy,
        starvationWarnings: starved ? stats.starvationWarnings + 1 : stats.starvationWarnings,
      }
    })
    return starved
  }
}
