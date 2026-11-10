/** 到点轮询器。只管"何时该响"，怎么发由主控的 send 决定 ——
 * 主控可能想走 agent（带人格再开口），也可能只想发一行裸文本。
 *
 * P1-02：`allow` 是**每次投递前**的二次判定（开关 / `allowedRooms` / 按群策略）。
 *
 * P2.5-3A-2：投递结果从"发/不发"两态变成**三态**，并且由**这里**做记账：
 *   - `sent`    → `markFired()`（照旧）；
 *   - `unknown` → `markUnknown()`：**不再自动重试**、留证据等人工收敛。
 *     以前失败只记一行日志、不 markFired ⇒ 每 30 秒无限重试；"已发出但回执丢了"
 *     的那条还会被重发出去（A5 实测）。
 *   - `skipped` → **什么都不动**（闸门/日程判它现在不该发，等它自己变好，不消耗）。
 *
 * 终审 round3 B2 追加第四态 `dry-run`（**权威定义就在下面的 `REMINDER_OUTCOMES`**，
 * 人话表格见插件 `README.md` 的「提醒的四种结论」一节）：
 *   - 演练：走完只读闸门就返回，**不改任何持久状态**（不写 `fired`/`firedAt`、不推进 `at`、
 *     不动 `occurrence`、不写 dispatched、不记账）——所以退出 dryRun 之后它还会响。
 */

import type { Reminder, ReminderStore } from './store.js'
import { isHaltWorthyFault, SOFT_FAULT_LIMIT, SoftFaultTracker } from './store-contract.js'
import { haltOnSoftFault, haltOnStorageFault, ScheduleHalt, type RunnerStatus } from './runner-status.js'
import { flushPendingDispatches } from './runner-flush.js'
import { MAX_CATCH_UP_PER_TICK, takeBatch } from './batch.js'
import { CATCH_UP_WINDOW_MS } from './catch-up.js'
import { REMINDER_OUTCOMES, outcomeOf, type ReminderOutcome } from './outcome.js'
import { dispatchOne, claimOwnerOf, type DispatchDeps } from './dispatch.js'
import { planWakeup, wakeupAtsOf } from './schedule.js'
import { WakeupBackoff } from './backoff.js'
import { WakeupTimer } from './wakeup.js'
import { setReminderNudge } from './nudge.js'
import { systemClock, type Clock } from '../../ports/clock.js'

/**
 * 一次投递尝试的**全部**结论——**唯一权威定义在 `outcome.ts`**，这里只做 re-export。
 *
 * 为什么搬走：`dispatch.ts`（"单独一条怎么发"）也要用它，而它不能反向 import `runner.ts`
 * （循环依赖）。既有写法 `import { outcomeOf } from '.../runner.js'` 继续有效——
 * `test/review3-qq.test.ts` B2-4 就钉着这个出口。
 */
export { REMINDER_OUTCOMES, outcomeOf }
export type { ReminderOutcome }

/**
 * **每拍最多补发几条一次性提醒**（终审 B7，默认 3 条）——**权威定义在 `batch.ts`**，
 * 这里只做 re-export（`test/round4-qq.test.ts` 等从这里取）。
 */
export { MAX_CATCH_UP_PER_TICK }

/** 算"下一条什么时候到点"时最多看多少行：提醒表按 `at` 升序，够了。 */
const MAX_ROWS_FOR_WAKEUP = 50

export class ReminderRunner {
  /**
   * **按到期时刻醒来的定时器**（2026-11-10 修复）。
   *
   * 以前这里是 `setInterval(intervalMs)`：到点误差的**下界就是轮询间隔**，一条 23:40:00 的
   * 提醒最好也要 23:40:00–23:40:30 才被看见（事故日志里 84 次被拦的记录间隔稳定 30 s，
   * 就是这条定时器）。现在改成"算下一条 `at`，到点才醒"，心跳只兜时钟漂移/休眠唤醒/手改文件。
   */
  private wake: WakeupTimer | null = null
  /** 上一轮还没跑完就不开下一轮：send 超过一拍时同一批 due 会被推两次。 */
  private running = false
  /** 停表现场（原因与时刻都在里面；"为什么停"的两套文案见 `runner-status.ts`）。 */
  private readonly halt = new ScheduleHalt()
  private readonly softFault = new SoftFaultTracker()
  private readonly store: ReminderStore
  private readonly send: (r: Reminder) => Promise<ReminderOutcome>
  private readonly allow: (r: Reminder) => boolean
  /**
   * 周期提醒的**换绑取数钩子**（P2.5-3A-4 收尾）。
   *
   * 只负责"去 agenda 问下一次 occurrence 是多少"，**不写 store**——写盘由
   * `store.markFiredRebound()` 一次完成（`at` 推进与 revision 换绑同生共死）。
   */
  private readonly rebind?: (r: Reminder) => Promise<{ id: string; revision: number } | null>
  /**
   * **补发 `occurrence-dispatched`**（终审 B3b / round4）：三态而不是布尔，因为"没有 agenda"
   * 和"写失败"必须分开——前者这条待办**根本无处可写**，应当作废（留着只会白补 10 拍、污染
   * `overLimit`）；后者才该累加次数等下一拍。
   */
  private readonly redispatch?: (r: Reminder) => Promise<'ok' | 'absent' | 'fail'>
  /**
   * **演练模式探针**（round5 D4）。`true` 时本拍**一行持久状态都不写**：
   * 不再做"收终态/积压淘汰"这些批量收编动作（否则 dryRun 会把周期提醒永久停掉）。
   */
  private readonly dryRun?: () => boolean
  /** 时钟（`now()` 与定时器都从这里来）：到点精度与"停机补发"都要能在假时钟上复现。 */
  private readonly clock: Clock
  /** 认领者标识（写进盘上：多实例排查时能读出"谁在发"）。 */
  private readonly owner = claimOwnerOf()
  private readonly log: (line: string) => void
  /**
   * **到期未消费的退避现场**（第二轮 P1-B）。状态机与增长曲线都在
   * `backoff.ts::WakeupBackoff`——这里只持有它。
   */
  private readonly backoff = new WakeupBackoff()

  constructor(
    store: ReminderStore,
    send: (r: Reminder) => Promise<ReminderOutcome>,
    log: (line: string) => void,
    allow: (r: Reminder) => boolean = () => true,
    rebind?: (r: Reminder) => Promise<{ id: string; revision: number } | null>,
    redispatch?: (r: Reminder) => Promise<'ok' | 'absent' | 'fail'>,
    dryRun?: () => boolean,
    clock: Clock = systemClock,
  ) {
    this.store = store
    this.send = send
    this.log = log
    this.allow = allow
    this.rebind = rebind
    this.redispatch = redispatch
    this.dryRun = dryRun
    this.clock = clock
  }

  /**
   * **锁定调度**：提醒已经投递出去、但记账没成 —— 再自动重发就是重复外发。
   * **任何**错误走到这里都一样：投递已经发生 ⇒ 状态不可信 ⇒ **无条件停表**（不看 code、不 rethrow）。
   * 只有"还没投递就出错"的读取故障才走 `haltAfterTickFault`，那里才按 code 分级（见 §8.9）。
   */
  private haltDispatch(reason: string, reminderId: string): void {
    this.halt.mark(reason)
    this.dispose()
    this.log(`reminders: ${reminderId} 已投递但记账失败（${reason}）→ **调度已锁定**：不会自动重发，修好盘并重启后再处理`)
  }

  /**
   * **tick 级**异常的分类出口（**投递前**的读取故障才走这里；投递后的记账失败走 `haltDispatch`）。
   *
   * 两条纪律（round17 §1-17.2）：①这一档**一条消息都没发出去**，所以文案不许说"已投递 / 修好盘"；
   * ②程序错误单次不停表，但**同一个 code 连续 `SOFT_FAULT_LIMIT` 拍**要升级成停表。
   */
  private haltAfterTickFault(error: unknown): void {
    const reason = error instanceof Error ? error.message : String(error)
    if (!isHaltWorthyFault(error)) {
      const code = (error as { code?: string }).code ?? 'UNKNOWN'
      // 同一个 code 连续出现才算"同一类"；换 code 说明是不同问题，重新计。
      if (this.softFault.note(code)) {
        haltOnSoftFault(this.halt, () => { this.dispose() }, this.log, code)
        return
      }
      this.log(`reminders: 本轮 tick 抛出**非磁盘类**异常（第 ${String(this.softFault.count())} 拍；连续 ${String(SOFT_FAULT_LIMIT)} 拍则停表）：${reason}`)
      return
    }
    haltOnStorageFault(this.halt, () => { this.dispose() }, this.log, reason)
  }

  /** **只读诊断快照**（字段含义见 `runner-status.ts` 的 `RunnerStatus`；**不改停表判定、不新增写路径**）。 */
  status(): RunnerStatus {
    return {
      scheduled: this.wake !== null, halted: this.halt.halted,
      haltReason: this.halt.reason, haltedAt: this.halt.at,
      softFault: { streak: this.softFault.count(), code: this.softFault.lastCode(), limit: SOFT_FAULT_LIMIT },
      backoff: this.backoff.snapshot(),
    }
  }

  /**
   * 启动调度（`heartbeatMs` 是**心跳**，不是原来的"固定轮询间隔"）。
   *
   * **2026-11-10 修复**：以前这里是 `setInterval(intervalMs)`，"提醒何时被看见"的下界就是
   * 这个间隔——一条 23:40:00 的提醒最好也要 23:40:30 才被处理，5 秒验收在结构上不可能。
   * 现在每拍跑完都重新算"下一条 `at` 离现在多久"并按它唤醒；心跳只兜时钟漂移、系统休眠/
   * 唤醒（`setTimeout` 不保证跨休眠按墙钟走）与被外部手改过的提醒文件。
   */
  start(heartbeatMs = 30_000): void {
    if (this.wake !== null) return
    // **round18 P1（复审 17.2）**：停表之后 `start()` 不许只打一行 "started"——那会让人以为
    // 它又开始干活了，实际 `tick()` 立刻返回、一条都不会发（复审实测：只多 1 行日志、`sends` 增量 0）。
    if (this.halt.halted) {
      this.log(`reminders: **仍在停表中**（${this.halt.reason ?? '原因未记录'}）：runner 不会开始轮询，需要人工重启本插件`)
      return
    }
    this.wake = new WakeupTimer({
      clock: this.clock,
      // **P1（复审 1.1）**：`tick()` 会 reject（存储故障按设计是 reject）。没人接住 = 进程级
      // 未捕获拒绝，Node ≥15 默认会**中止整个宿主**（提醒、contact、面板一起没）。
      // `WakeupTimer` 自己接住，所以这里只负责把异常分流到停表判定。
      onTick: async () => { await this.tick().catch((error: unknown) => { this.haltAfterTickFault(error) }) },
      nextDelayMs: () => this.nextDelayMs(heartbeatMs),
      log: this.log,
    })
    // 建/删提醒之后立刻重排（`nudge.ts`）：否则一条"15 秒后"的提醒可能排在心跳后面。
    setReminderNudge(() => { this.wake?.reschedule() })
    this.wake.start()
    this.log(`reminders: runner started (heartbeat ${String(heartbeatMs)}ms，按到期时刻唤醒)`)
  }

  /**
   * **这一拍有没有进展**（第二轮 P1-B 的核心判据）。
   *
   * 判据与增长曲线都在 `backoff.ts::WakeupBackoff`（纯状态机 + 纯函数间隔）；这里只负责
   * 取"开拍前/收拍后各几条到期项"。
   *
   * 为什么按**数量**判而不是"这一拍发了几条"：`skipped` 与 `dryRun` 都是"一条没发但不是
   * 故障"；而认领被另一个进程抢走（本拍没发、对方发了）会让数量变少 ⇒ 正确地算成有进展。
   */
  private trackBackoff(before: number): void {
    this.backoff.note(before, this.store.due(this.clock.now()).length)
  }

  /** 开拍前有几条到期项（`trackBackoff()` 的对照值；`takeBatch()` 会把它们消耗掉）。 */
  private dueCount(): number {
    return this.store.due(this.clock.now()).length
  }

  /**
   * 下一拍该等多久（毫秒）。
   *
   * 取值来自**盘上的提醒表**（与投递侧同一套判据，见 `schedule.ts::wakeupAtsOf`）；
   * 停表/正在跑时给心跳，避免"跑着的时候又醒一次"。
   *
   * **第二轮 P1-B**：到期项不再一律 1 ms。间隔由"连续几拍没进展"决定：有进展 ⇒ 1 秒
   * （积压按节奏继续）；没进展（`dryRun` / 通道断开 / 房间不许发）⇒ 翻倍直到心跳。
   * 未来提醒仍然精确到它的 `scheduledAt`，不受退避影响。
   */
  private nextDelayMs(heartbeatMs: number): number {
    if (this.halt.halted) return heartbeatMs
    const now = this.clock.now()
    const delay = planWakeup({
      ats: wakeupAtsOf(this.store.list(MAX_ROWS_FOR_WAKEUP), CATCH_UP_WINDOW_MS, now),
      now,
      heartbeatMs,
      overdueGapMs: this.backoff.gapFor(heartbeatMs),
    })
    this.backoff.remember(delay)
    return delay
  }

  /** 每次轮询同一时刻的 due 快照；单条失败只记日志，其它条继续。 */
  private async tick(): Promise<void> {
    // **P1（复审 1.2）**：记账失败 = "已发出但没落盘"，下一拍再发就是**重复外发**。锁定调度。
    if (this.halt.halted) return
    if (this.running) return
    this.running = true
    try {
      // **终审 round6 D4：dryRun 是"整条入口零写入"**，不只是不投递。
      // 补回执会 `clearPendingDispatch` 或 `bumpPendingDispatch`（清待办/加次数/转终态），
      // 那是**可恢复的回执待办**——演练模式下动它等于把真实状态改掉了。所以整段跳过。
      const dryRun = this.dryRun?.() === true
      if (dryRun) {
        this.log('reminders: dryRun 生效：本拍不补回执、不清待办、不加次数、不推进提醒（整条入口零写入）')
      } else {
        // 终审 B3b：先把上一拍没写成的 `occurrence-dispatched` 补掉（不影响任何投递结论）。
        // 具体判定在 `runner-flush.ts`（纯搬移：runner.ts 贴着 400 行硬上限）。
        await flushPendingDispatches({ store: this.store, redispatch: this.redispatch, log: this.log })
      }
      // **第二轮 P1-B**：开拍前先数一次到期项，收尾时用"有没有变少"决定下一拍退避多久。
      const overdueBefore = this.dueCount()
      await this.runDue()
      // **round18 P1（复审 17.1）**：这里才是"这一拍真的跑完了"——`runDue()` 正常返回、且
      // 没有因为 `running`/`halted` 提前 return（那两种情况在函数开头就返回了，走不到这里）。
      // 连击清零放在这，而不是 `start()` 的 `.then()`：后者会把"空转"算成"成功"。
      this.softFault.reset()
      this.trackBackoff(overdueBefore)
      // **可观测性落点（能被 grep 的那一行）**：放在本拍收尾，这样"这一拍刚产生的积压"
      // 也能立刻出现在日志里（放在开头的话，第一次积压要等下一拍才看得到）。
      this.logDispatchMetrics()
    } finally {
      this.running = false
    }
  }

  /**
   * 记一行 `pendingDispatch` 指标（运维据此知道有没有积压）。
   *
   * `overLimit` 涨了说明"有人得去看一眼"——那是终态，不会自愈，属于运维动作而不是代码能解决的。
   */
  private logDispatchMetrics(): void {
    const metrics = typeof this.store.dispatchDiagnostics === 'function'
      ? this.store.dispatchDiagnostics()
      : null
    if (metrics === null || (metrics.value === 0 && metrics.overLimit === 0)) return
    this.log(`reminders: pendingDispatch value=${String(metrics.value)} oldestAgeMs=${String(metrics.oldestAgeMs)}`
      + ` overLimit=${String(metrics.overLimit)}`)
  }

  /**
   * **取本拍要发的那批**（防雪崩的三道闸）。策略与顺序在 `batch.ts`——`runner.ts` 贴着
   * 400 行硬上限，而那段是"发哪几条"，与"什么时候醒"无关。
   */
  private async takeBatch(): Promise<Reminder[]> {
    return await takeBatch({ store: this.store, now: this.clock.now(), dryRun: this.dryRun?.() === true, log: this.log })
  }

  private async runDue(): Promise<void> {
    const pending = await this.takeBatch()
    for (const reminder of pending) {
      // 认领 → 闸门 → 真发 → 记账 → 结构化日志，全在 `dispatch.ts`（runner.ts 贴着 400 行上限）。
      // 返回 `false` = 这一条必须中止本拍（投递已发生但记账失败 ⇒ 已停表）。
      const ok = await dispatchOne(this.dispatchDeps(), reminder)
      if (!ok) return
    }
  }

  /** `dispatchOne` 的依赖（每次现取：`halt`/`dryRun` 都是活状态，不能提前快照）。 */
  private dispatchDeps(): DispatchDeps {
    return {
      store: this.store,
      owner: this.owner,
      now: () => this.clock.now(),
      dryRun: () => this.dryRun?.() === true,
      allow: this.allow,
      send: this.send,
      recordSent: (reminder) => this.recordSent(reminder),
      markUnknown: async (id, reason) => { await this.store.markUnknown(id, reason, this.clock.now()) },
      haltDispatch: (reason, reminderId) => { this.haltDispatch(reason, reminderId) },
      log: this.log,
      clock: this.clock,
    }
  }

  /**
   * 记账（`sent` 出口）：推进/换绑一次落盘。
   *
   * 从 `runDue` 抽出来的——它原来把 `runDue` 撑到 80 行（上限 60）。**纯重构，行为不变**：
   * 返回 `false` 表示"这条本拍必须中止"（写失败已记日志）。
   *
   * **两条路径的 catch 都无条件 `haltDispatch`**：投递**已经发生** ⇒ 无论抛的是什么错
   * （含 `TypeError` 这类程序错误）状态都不可信（`fired`/`sentFor` 没写成 ⇒ 下一拍
   * `due()` 仍选中它、崩溃恢复闸判 false ⇒ **会再发一次**）。既不 rethrow、也不只写
   * "不重发"然后下一拍照发（复审 15/16.1/1.2）。
   */
  private async recordSent(reminder: Reminder): Promise<boolean> {
    // 周期性提醒：`at` 推进与 `occurrence` 换绑必须是**一次写盘**（裁决 ③）。
    // 先向 agenda 问下一次（纯取数、不写盘），再让 store 一次落盘；写盘失败则两者都不动。
    if (reminder.repeat !== 'none' && this.rebind !== undefined) {
      let occurrence: { id: string; revision: number } | null = null
      try {
        occurrence = await this.rebind(reminder)
      } catch (error) {
        // 取数失败 = 拿不到下一次 ⇒ 清空绑定（绝不拿 createSchedule 兜底）。
        this.log(`reminders: ${reminder.id} 取下一轮 occurrence 抛错，将解除绑定：${error instanceof Error ? error.message : String(error)}`)
      }
      if (occurrence === null) {
        // **task-66**：这条日志以前没有——"拿不到下一轮 ⇒ 清空绑定"是**成功路径**，
        // 只有抛错那条有日志，于是"绑定被清空"在日志里看不见（B8 抓到的就是这个）。
        this.log(`reminders: ${reminder.id} 拿不到下一轮 occurrence → 已解除日程绑定（清空，避免旧 revision 必然过期）`)
      }
      try {
        await this.store.markFiredRebound(reminder.id, occurrence, this.clock.now())
      } catch (error) {
        // 投递已经发生、写盘失败 ⇒ 无条件停表（理由见本函数头注释）。
        this.haltDispatch(`推进+换绑写盘失败：${error instanceof Error ? error.message : String(error)}`, reminder.id)
        return false
      }
    } else {
      try {
        await this.store.markFired(reminder.id, this.clock.now())
      } catch (error) {
        // 投递已经发生、写盘失败 ⇒ 无条件停表（理由见本函数头注释）。
        this.haltDispatch(`"已触发"没落盘：${error instanceof Error ? error.message : String(error)}`, reminder.id)
        return false
      }
    }
    return true
  }
  dispose(): void {
    setReminderNudge(null)
    if (this.wake !== null) {
      this.wake.dispose()
      this.wake = null
    }
  }
}
