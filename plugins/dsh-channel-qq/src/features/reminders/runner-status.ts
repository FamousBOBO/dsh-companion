/**
 * **停表现场** + **两条调度级停表的文案** + `status()` 的快照形状。
 *
 * 为什么单独一个文件：①`runner.ts` 贴着 400 行硬上限（`scripts/check-size.mjs`）；
 * ②"为什么停了"这句话必须与**有没有投递过**一致 —— 记账失败（消息已经发出去了）与
 * 程序错误连击（一条都没发出去）是两种完全不同的现场，混用一行日志会让运维按错的
 * 原因去修。round17 §1-17.2 实测：`sends=0` 时那行却说"已投递但记账失败 / 修好盘"，
 * 两个事实都是错的，而那是这条路径**唯一**的痕迹。
 */

import { SOFT_FAULT_LIMIT } from './store-contract.js'

/** 一次停表的现场（原因 + 时刻）。`mark()` 之后**不可撤销**：只有重启插件能复位。 */
export class ScheduleHalt {
  private state: { reason: string; at: number } | null = null

  get halted(): boolean { return this.state !== null }
  get reason(): string | null { return this.state?.reason ?? null }
  get at(): number | null { return this.state?.at ?? null }

  mark(reason: string): void { this.state = { reason, at: Date.now() } }
}

/**
 * `ReminderRunner.status()` 的返回形状；诊断面（`resourceListOf()` 的 `runner` 字段）与
 * 实现**共用这一份定义**（别在旁边再抄一份字段，抄第二份迟早会漂）。
 */
export interface RunnerStatus {
  /** 定时器还挂着吗（`enabled=false` 时压根没启动；停表后会被 `dispose()` 掉）。 */
  scheduled: boolean
  /** **停表了没有**：停表之后 `tick()` 直接返回，**不会**自动恢复。 */
  halted: boolean
  /** 停表原因（原文，人话）；没停表时是 `null`。 */
  haltReason: string | null
  /** 停表时刻（`Date.now()` 毫秒）；没停表时是 `null`。 */
  haltedAt: number | null
  /** 同类程序错误的连击现场：`streak` 涨到 `limit` 就停表 —— "空转"这一档也看得见。 */
  softFault: { streak: number; code: string; limit: number }
  /**
   * **到期未消费的退避现场**（第二轮 P1-B）。
   *
   * `overduePasses` = 连续几拍"到期项还在、而且没减少"（`dryRun` / 通道断开 / 房间不许发
   * 会一直涨）；`gapMs` = 按它算出来的下一拍间隔（`null` = 还没算出过）。
   *
   * 为什么进诊断面：这一档以前是**不可观测的 CPU 空转**——日志里只看得到"每秒被拦一次"，
   * 却看不出是闸门在拦还是调度在空转。有了这两个数，"日志暴涨"能被直接读成"passes 在涨"。
   */
  backoff: { overduePasses: number; gapMs: number | null }
}

/**
 * 两条调度级停表共用的尾巴：**这一拍一条都没发出去**，而且必须人工重启。
 *
 * 这两句是 round17 §1-17.2 的核心：旧文案说"已投递但记账失败 / 修好盘并重启"，
 * 而实测 `sends=0`、也不是盘的问题 —— 运维会照着修错的东西。
 */
const NO_DELIVERY = '本拍**未投递任何消息**；需要人工重启本插件才会恢复（不会自动恢复；'
  + '`GET /api/resource/reminders` 的 `runner.halted` / `haltReason` 可查）'

/** 调度级停表①：**同类程序错误连击**到阈值（不是盘的问题，状态没坏，但也不能再空转）。 */
export function haltOnSoftFault(
  halt: ScheduleHalt,
  dispose: () => void,
  log: (line: string) => void,
  code: string,
): void {
  halt.mark(`连续 ${String(SOFT_FAULT_LIMIT)} 拍同类程序错误（${code}）⇒ 疑似 bug`)
  dispose()
  log(`reminders: **调度已暂停**：${halt.reason ?? ''}。${NO_DELIVERY}`)
}

/** 调度级停表②：**tick 级存储故障**（盘的问题：状态不可信，修好盘才谈重启）。 */
export function haltOnStorageFault(
  halt: ScheduleHalt,
  dispose: () => void,
  log: (line: string) => void,
  reason: string,
): void {
  halt.mark(`本轮 tick 因存储故障终止（${reason}）`)
  dispose()
  log(`reminders: **调度已锁定**：${halt.reason ?? ''}。修好盘后${NO_DELIVERY}`)
}
