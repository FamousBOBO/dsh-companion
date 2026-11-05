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
import { CATCH_UP_MAX_TOTAL } from './catch-up.js'

/**
 * 一次投递尝试的**全部**结论——**唯一权威定义**（类型从这里派生，别再手写第二份）。
 *
 * | 结论 | runner 会写什么 | 会不会消耗这条提醒 |
 * |---|---|---|
 * | `sent` | `markFired()` / `markFiredRebound()`（推进 `at`、换绑 `occurrence`） | 会（它就是"发过了"） |
 * | `dry-run` | **什么都不写**（只留一行日志） | **不会**（演练不是发出） |
 * | `unknown` | `markUnknown()`（终态，留证据） | 会（但会留痕、可人工收敛） |
 * | `skipped` | 什么都不写 | 不会 |
 *
 * ⚠️ 仓外若有人按"三态"枚举（`sent`/`unknown`/`skipped`），**必须**把 `dry-run` 补进去：
 * 演练既不是"发出去"也不是"失败"，混进 `unknown` 会让人以为出过错。
 */
export const REMINDER_OUTCOMES = ['sent', 'dry-run', 'unknown', 'skipped'] as const

/**
 * **每拍最多补发几条**（终审 B7，默认 3 条）。
 *
 * 为什么需要：`due()` 会把所有"到点没过太久"的都列出来，`dryRun` 关掉的那一刻可能一次
 * 炸出一大批。3 条 ≈ 默认 30 秒一拍，20 条积压约 3.5 分钟发完——比"一秒 20 条"像人得多。
 * 超出的**不丢弃**：下一拍继续（`due()` 仍会选中它们）。
 */
export const MAX_CATCH_UP_PER_TICK = 3

/** 一次投递尝试的结论。`skipped` / `dry-run` 都不消耗提醒，区别是后者"闸门跑过了"。 */
export type ReminderOutcome = typeof REMINDER_OUTCOMES[number]

/** 把回调随便返回的东西收敛成四种结论之一（认不出的按 `unknown`：说不清就别重试）。 */
export function outcomeOf(value: unknown): ReminderOutcome {
  const text = String(value)
  return (REMINDER_OUTCOMES as readonly string[]).includes(text) ? text as ReminderOutcome : 'unknown'
}

export class ReminderRunner {
  private timer: ReturnType<typeof setInterval> | null = null
  /** 上一轮还没跑完就不开下一轮：send 超过 30s 时同一批 due 会被推两次。 */
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
  private readonly log: (line: string) => void

  constructor(
    store: ReminderStore,
    send: (r: Reminder) => Promise<ReminderOutcome>,
    log: (line: string) => void,
    allow: (r: Reminder) => boolean = () => true,
    rebind?: (r: Reminder) => Promise<{ id: string; revision: number } | null>,
    redispatch?: (r: Reminder) => Promise<'ok' | 'absent' | 'fail'>,
    dryRun?: () => boolean,
  ) {
    this.store = store
    this.send = send
    this.log = log
    this.allow = allow
    this.rebind = rebind
    this.redispatch = redispatch
    this.dryRun = dryRun
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
      scheduled: this.timer !== null, halted: this.halt.halted,
      haltReason: this.halt.reason, haltedAt: this.halt.at,
      softFault: { streak: this.softFault.count(), code: this.softFault.lastCode(), limit: SOFT_FAULT_LIMIT },
    }
  }

  start(intervalMs = 30_000): void {
    if (this.timer !== null) return
    // **round18 P1（复审 17.2）**：停表之后 `start()` 不许只打一行 "started"——那会让人以为
    // 它又开始干活了，实际 `tick()` 立刻返回、一条都不会发（复审实测：只多 1 行日志、`sends` 增量 0）。
    if (this.halt.halted) {
      this.log(`reminders: **仍在停表中**（${this.halt.reason ?? '原因未记录'}）：runner 不会开始轮询，需要人工重启本插件`)
      return
    }
    // **P1（复审 1.1）**：`tick()` 会 reject（存储故障按设计是 reject）。没人接住 = 进程级
    // 未捕获拒绝，Node ≥15 默认会**中止整个宿主**（提醒、contact、面板一起没）。
    this.timer = setInterval(() => {
      // **round18 P1（复审 17.1）**：`softFault.reset()` **绝对不能**挂在这个 `.then()` 上——
      // `tick()` 在上一拍还没跑完（`running`）时会**立即 resolve**，于是"这一拍什么都没做"会被
      // 当成"这一拍成功了"，故障比一拍慢时连击永远归零（复审实测：32 次故障、日志全写"第 1 拍"、
      // `sends=0`、`halted` 永假）。清零现在在 `tick()` 里、`runDue()` 真的跑完之后。
      void this.tick().catch((error: unknown) => { this.haltAfterTickFault(error) })
    }, intervalMs)
    // 别让这个轮询把进程钉住：主控 dispose 时进程照常退出。
    // `unref` 在 Node 的 Timeout 上一定存在；`typeof` 只是防"跑在别的运行时上"。
    if (typeof this.timer.unref === 'function') this.timer.unref()
    this.log(`reminders: runner started (every ${String(intervalMs)}ms)`)
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
      await this.runDue()
      // **round18 P1（复审 17.1）**：这里才是"这一拍真的跑完了"——`runDue()` 正常返回、且
      // 没有因为 `running`/`halted` 提前 return（那两种情况在函数开头就返回了，走不到这里）。
      // 连击清零放在这，而不是 `start()` 的 `.then()`：后者会把"空转"算成"成功"。
      this.softFault.reset()
      // **可观测性落点（能被 grep 的那一行）**：放在本拍收尾，这样"这一拍刚产生的积压"
      // 也能立刻出现在日志里（放在开头的话，第一次积压要等下一拍才看得到）。
      // 运维看 `pendingDispatch value=` 就知道有没有积压；`overLimit` 涨了说明"有人得去看一眼"
      // （终态不会自愈，这是运维动作而不是代码能解决的）。
      const metrics = typeof this.store.dispatchDiagnostics === 'function'
        ? this.store.dispatchDiagnostics()
        : null
      if (metrics !== null && (metrics.value > 0 || metrics.overLimit > 0)) {
        this.log(`reminders: pendingDispatch value=${String(metrics.value)} oldestAgeMs=${String(metrics.oldestAgeMs)}`
          + ` overLimit=${String(metrics.overLimit)}`)
      }
    } finally {
      this.running = false
    }
  }

  /**
   * **取本拍要发的那批**（防雪崩的三道闸，终审 B7 + Lead 裁定的总量闸）。
   *
   * 顺序：① 太旧的收终态（`skipped-expired:too-old`）→ ② 积压超过 `CATCH_UP_MAX_TOTAL`
   * 按**最老优先**丢弃（`skipped-expired:backlog-overflow`）→ ③ 只取 `MAX_CATCH_UP_PER_TICK` 条。
   * 每一步都记日志：既不静默丢弃，也不在恢复瞬间刷屏。
   */
  private async takeBatch(): Promise<Reminder[]> {
    // **演练模式：一行持久状态都不写**（round5 D4）。淘汰/收编都是写操作，必须整个跳过——
    // 否则"dryRun 开着"也会把超期的 daily/weekly 收成终态 ⇒ 永久停掉周期提醒。
    if (this.dryRun?.() === true) return this.store.due()
    // **task-66（设计 §6 调用方规则）**：收编失败是**存储故障**（reject）⇒ **终止本拍投递**，
    // 不能捕获后继续用空数组绕过防雪崩。业务拒绝（NOT_APPLICABLE）才算"没有要收的"。
    const expiredMutation = await this.store.expireStale()
    const expired = expiredMutation.ok ? expiredMutation.value.map((row) => row.id) : []
    if (expired.length > 0) {
      this.log(`reminders: ${String(expired.length)} 条已超出补发窗口（${String(this.store.catchUpWindowMs)}ms）`
        + ' → 收成终态 skipped-expired:too-old（不补发、也不假装还在等）')
    }
    const overflowMutation = await this.store.capBacklog()
    const overflow = overflowMutation.ok ? overflowMutation.value.map((row) => row.id) : []
    if (overflow.length > 0) {
      this.log(`reminders: 因积压丢弃 ${String(overflow.length)} 条（skipped-expired:backlog-overflow，`
        + `上限 ${String(CATCH_UP_MAX_TOTAL)} 条；最老优先丢，后台可见）`)
      // **扔了哪几条要能看见**（只有数字等于没用）：日志打前 5 条（时间 + 截断文本）。
      const dropped = typeof this.store.droppedItems === 'function' ? this.store.droppedItems(5) : []
      for (const item of dropped) {
        const when = new Date(item.at).toISOString().slice(11, 16)
        this.log(`reminders: 丢弃明细 ${when} ${item.text}（${item.reason}）`)
      }
      // **清单可能不全**（Lead 的 P2）：一定要说清"这只是前 5 条"，别让人当成全部。
      const total = typeof this.store.catchUpDiagnostics === 'function'
        ? this.store.catchUpDiagnostics().droppedTotal
        : overflow.length
      if (total > dropped.length) {
        this.log(`reminders: 丢弃明细只列了 ${String(dropped.length)} 条，**还有 ${String(total - dropped.length)} 条没列出**`
          + `（后台 reminders.catchUp.droppedTotal=${String(total)}、droppedTruncated=true）`)
      }
    }
    const backlog = this.store.due()
    // **错过这一轮的周期提醒也要进本拍**（round5 D4）：它们不在 `due()` 里（`at` 已滑出窗口），
    // 但需要被"推进到下一轮"——否则会永远卡在过去的时刻（既不响也不再走）。
    const missed = typeof this.store.missedRounds === 'function' ? this.store.missedRounds() : []
    // **每拍上限只对一次性提醒计数**（round5 D4）：周期提醒本来就不会被淘汰，不该被"积压"挤掉。
    const repeats = backlog.filter((item) => item.repeat !== 'none')
    const oneShots = backlog.filter((item) => item.repeat === 'none')
    const pending = [...missed, ...repeats, ...oneShots.slice(0, MAX_CATCH_UP_PER_TICK)]
    if (oneShots.length > MAX_CATCH_UP_PER_TICK) {
      this.log(`reminders: 本拍到点 ${String(oneShots.length)} 条一次性提醒，按每拍上限 ${String(MAX_CATCH_UP_PER_TICK)} 条先发；`
        + `其余 ${String(oneShots.length - MAX_CATCH_UP_PER_TICK)} 条下一拍继续（不丢弃、不插队）`)
    }
    return pending
  }

  private async runDue(): Promise<void> {
    const pending = await this.takeBatch()
    for (const reminder of pending) {
      // P1-02：投递前再判一次（开关 / 房间白名单 / 按群策略）。不允许投的**不消耗**提醒。
      if (!this.allow(reminder)) {
        this.log(`reminders: 跳过 ${reminder.id}（当前不可投递：开关关闭或房间不在白名单）`)
        continue
      }
      let outcome: ReminderOutcome = 'unknown'
      let reason = 'unknown'
      try {
        // 四种结论都在 `REMINDER_OUTCOMES` 里（权威定义）；认不出的一律 `unknown`：
        // "说不清发没发"时最安全的是不重试。
        const result = await this.send(reminder)
        outcome = outcomeOf(result)
        if (outcome === 'unknown') reason = `unclassified:${String(result)}`
      } catch (error) {
        // 抛错 = "无法证明没发出去" ⇒ 与 contact 的 unknown 同口径：不重试。
        outcome = 'unknown'
        reason = error instanceof Error ? error.message : String(error)
        this.log(`reminders: send failed for ${reminder.id}: ${reason}`)
      }
      if (outcome === 'dry-run') {
        // **终审 B2**：演练**不许动任何持久状态**——不写 `fired`、不推进 `at`、不改 `occurrence`。
        // 所以这里什么都不做，只留一行日志（`dryRun` 与"真发过"在日志/诊断里能分辨）。
        this.log(`reminders: ${reminder.id} 演练过（dry-run），状态未改动，下一次到点还会响`)
      } else if (outcome === 'sent') {
        if (!(await this.recordSent(reminder))) return
      } else if (outcome === 'unknown') {
        // **round8**：演练下**任何**出口都不许落盘——包括这条"异常/说不清"的出口。
        // 以前只在前面的分支里挡 dryRun，这里漏了 ⇒ send 抛错仍然 `markUnknown()`
        // （会清 sent 字段、终结一次性或推进周期）。
        if (this.dryRun?.() === true) {
          this.log(`reminders: ${reminder.id} 演练里出现 unknown（${reason}）→ **不落 unknown**，状态保持原样`)
        } else {
          // **task-65**：`markUnknown` 返回 false（锁着/没落盘）时不许写"记为 unknown"——那等于谎报状态。
          try {
            await this.store.markUnknown(reminder.id, reason)
          } catch (error) {
            // **P1（复审 16.1）**：投递**已经发生**（结论 unknown = 不确定发没发），
            // 所以这里和另外两条记账路径一样**无条件停表**——rethrow 会被 tick 级分类判成
            // "程序错误、不停表"，结果每 30 秒再发一次（复审探针实测 350ms 内 23 次外发）。
            this.log(`reminders: ${reminder.id} 的 unknown 状态**没写进去**（${error instanceof Error ? error.message : String(error)}）：内存与盘上都没记，别当成已收敛`)
            // **P1（复审 13.2）**：unknown 也没写成 ⇒ "发没发"说不清 ⇒ 下一拍 `due()` 仍会选中它 ⇒ 锁定调度
            this.haltDispatch(`unknown 没写进去：${error instanceof Error ? error.message : String(error)}`, reminder.id)
            return
          }
          this.log(`reminders: ${reminder.id} 记为 unknown（不自动重试，等人工收敛 ${reason}）`)
        }
      }
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
        await this.store.markFiredRebound(reminder.id, occurrence)
      } catch (error) {
        // 投递已经发生、写盘失败 ⇒ 无条件停表（理由见本函数头注释）。
        this.haltDispatch(`推进+换绑写盘失败：${error instanceof Error ? error.message : String(error)}`, reminder.id)
        return false
      }
    } else {
      try {
        await this.store.markFired(reminder.id)
      } catch (error) {
        // 投递已经发生、写盘失败 ⇒ 无条件停表（理由见本函数头注释）。
        this.haltDispatch(`"已触发"没落盘：${error instanceof Error ? error.message : String(error)}`, reminder.id)
        return false
      }
    }
    return true
  }
  dispose(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}
