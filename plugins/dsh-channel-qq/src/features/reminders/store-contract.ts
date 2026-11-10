/**
 * **ReminderStore 的写入契约**（第十一轮复审的设计，见 `design/p2.5-reminder-store-design.md` §1）。
 *
 * 两条硬规矩，全库都要按它读：
 *   1. `ok:false` **只**表示**业务拒绝**：没改状态、没写盘；
 *   2. **基础设施故障**（锁定 / 保存失败 / 队列满 / 重入 / 已关闭）一律 **Promise reject**
 *      `ReminderStoreFault`——**不许**伪装成 `false`/`0`/`[]`/`{ok:false, items:[]}`。
 *
 * 为什么这么定：三轮复审在"保存失败被改写成一个正常的空结果"上翻车三次。
 * 空结果只能表示"确实没有"，不能兼职表示"没写成功"。
 */

import type { Reminder } from './reminder-model.js'

export type BusinessCode = 'NOT_FOUND' | 'INVALID_INPUT' | 'NOT_APPLICABLE' | 'STALE_STATE'

/** 业务结果：`ok:false` ⇒ 没改状态、没写盘。 */
export type Mutation<T> =
  | { ok: true; changed: boolean; value: T }
  | { ok: false; code: BusinessCode; message: string }

export type StoreFaultCode =
  | 'NOT_LOADED'
  | 'READ_LOCKED'
  | 'PERSIST_FAILED'
  | 'COMMIT_UNKNOWN'
  | 'QUEUE_FULL'
  | 'REENTRANT'
  | 'CLOSED'
  | 'RECOVERY_READ_FAILED'
  | 'RECOVERY_INVALID'
  | 'RECOVERY_MARKER_FAILED'
  /** reducer 造出了不合法的候选行（**程序错误**，不是磁盘问题——别记成 PERSIST_FAILED）。 */
  | 'INVALID_CANDIDATE'
  /** 同一提醒文件被第二个 Store 打开（内存状态不同，只共用队列不够）。 */
  | 'OWNER_CONFLICT'
  /**
   * **跨进程写锁没抢到**（第二轮 P1-A）：另一个 DSH 进程正在写同一份提醒文件。
   *
   * 语义是**暂时性**：这一笔没写、状态没动、什么都没发生；稍后再试就好。
   * 所以它**不在** `HALT_WORTHY` 里（停表只会把"对方写得慢"变成"我方永久失活"），
   * 但它也**绝不允许**降级成"没锁也写"——调用方必须当失败处理（尤其投递路径：
   * 拿不到锁就不许发 QQ）。
   */
  | 'LOCK_TIMEOUT'
  /**
   * **本运行时根本没有跨进程写锁**（第三轮 P2）：`node:sqlite` 取不到，或锁初始化就失败。
   *
   * 与 `LOCK_TIMEOUT` 必须分开：那是"另一个进程正好在写，稍后再试"（暂时性、会自愈）；
   * 这是"这台机器永远拿不到锁"（**装配/能力问题，不自愈**）。混成一个码的后果是把
   * "永远写不了"报成"竞争激烈"，运维会一直等一个不会来的自愈。
   *
   * 行为是 **fail-closed**：拒绝写入，绝不在无锁状态下写盘（那正是重复外发的成因）。
   */
  | 'LOCK_UNAVAILABLE'
  /** 跨进程重读盘上最新状态失败（锁内基线作废 ⇒ **不许**拿旧内存快照继续写）。 */
  | 'REFRESH_FAILED'

export class ReminderStoreFault extends Error {
  readonly code: StoreFaultCode
  readonly operation: string

  constructor(code: StoreFaultCode, operation: string, message: string, options?: { cause?: unknown }) {
    super(`[${code}] ${operation}: ${message}`, options)
    this.name = 'ReminderStoreFault'
    this.code = code
    this.operation = operation
  }
}

export function storeFault(
  code: StoreFaultCode,
  operation: string,
  message: string,
  cause?: unknown,
): ReminderStoreFault {
  return new ReminderStoreFault(code, operation, message, cause === undefined ? undefined : { cause })
}

/**
 * **哪一种故障该"停表"**（复审 15.1：`isStoreFault` 不带 code ⇒ 以前把所有故障都当磁盘故障）。
 *
 * 判据是**状态可信吗**：
 * - 磁盘/持久化失败 ⇒ 内存与盘可能已经不一致 ⇒ 状态不可信 ⇒ **停表**（只能重启 + 修盘）
 * - 程序错误 / 装配错误 ⇒ 状态没坏，停表只会把"一个 bug"变成"永久失活" ⇒ **只记日志，继续跑**
 *   （但**同一个 code 连续** `SOFT_FAULT_LIMIT` 拍就不是偶发了，见 `SoftFaultTracker`）
 */
const HALT_WORTHY: ReadonlySet<StoreFaultCode> = new Set<StoreFaultCode>([
  // 磁盘/持久化：写了但不确定落没落、或读不出来
  'PERSIST_FAILED',
  'COMMIT_UNKNOWN',
  'READ_LOCKED',
  'RECOVERY_READ_FAILED',
  'RECOVERY_INVALID',
  'RECOVERY_MARKER_FAILED',
])

/** 连续多少拍同类程序错误就停表（静默空转与静默停表一样不可观测）。 */
export const SOFT_FAULT_LIMIT = 10

/**
 * **软故障连击追踪**：`isHaltWorthyFault` 说"这一拍不该停"，这里说"再这样下去就该停了"。
 *
 * 政策（阈值、按 code 计连续）属于"故障分类"，所以住在 `store-contract`，不散落在 runner 里。
 */
export class SoftFaultTracker {
  private streak = 0
  private last = ''

  /** `true` = 已到阈值，调用方应停表。同一 code 连续才算；换 code 或调用 `reset()` 都清零。 */
  note(code: string): boolean {
    this.streak = code === this.last ? this.streak + 1 : 1
    this.last = code
    return this.streak >= SOFT_FAULT_LIMIT
  }

  /** 成功一拍就清零（"连续"才叫疑似 bug）。 */
  reset(): void {
    this.streak = 0
    this.last = ''
  }

  /** 当前连击数（诊断/日志用）。 */
  count(): number {
    return this.streak
  }

  /** 最后一个故障 code（诊断面用：连击了**哪一类**错误）。 */
  lastCode(): string {
    return this.last
  }
}

/** `true` = 状态不可信，必须停表；`false` = 程序/装配错误或瞬时压力，只记日志。 */
export function isHaltWorthyFault(error: unknown): boolean {
  return isStoreFault(error) && HALT_WORTHY.has(error.code)
}

/** 判断一个 reject 是不是某一类存储故障（给调用方分支用；`code` 省略 = 只要是我们自己的故障）。 */
export function isStoreFault(error: unknown, code?: StoreFaultCode): error is ReminderStoreFault {
  return error instanceof ReminderStoreFault && (code === undefined || error.code === code)
}

// ── 事务内部的"编辑结果" ───────────────────────────────────────────────────

export type Edit<T> =
  | { kind: 'reject'; code: BusinessCode; message: string }
  | { kind: 'unchanged'; value: T }
  | { kind: 'changed'; value: T }

export const edited = <T>(value: T): Edit<T> => ({ kind: 'changed', value })
export const unchanged = <T>(value: T): Edit<T> => ({ kind: 'unchanged', value })
export const rejected = <T>(code: BusinessCode, message: string): Edit<T> => ({ kind: 'reject', code, message })

// ── 解码 / 校验 ────────────────────────────────────────────────────────────

export interface ValidationIssue {
  /** 出问题的位置，如 `reminders[3].at`。 */
  path: string
  message: string
}

/** 归一化记录（例如把缺省字段补齐）——**只用于说明，不许把坏行留下**。 */
export interface ValidationNote extends ValidationIssue {
  filled: string
}

// ── 恢复报告（要完整内容，不能只报 id） ────────────────────────────────────

export interface ItemChange {
  before: Reminder
  after: Reminder
}

export interface RecoveryReport {
  loaded: number
  /** 完全消失的旧行（完整内容）。 */
  removed: Reminder[]
  /** 同 id 但内容变了。 */
  replaced: ItemChange[]
  added: Reminder[]
}

// ── 持久化（注入式，便于测试模拟"提交前失败"） ────────────────────────────

export type ReadResult =
  | { kind: 'missing' }
  | { kind: 'present'; raw: unknown }
  | { kind: 'failed'; failure: { at: number; reason: 'unreadable' | 'permission'; source: string; detail: string } }

export interface ReminderPersistence {
  /** 单次读取：数据与错误分类来自同一次读（`missing` 与"内容是 null"必须能分开）。 */
  readOnce(): Promise<ReadResult>
  /** **唯一写入口**：返回 `committed` = 已提交（rename 成功）；抛错 = 未提交。 */
  replaceSerialized(bytes: string): Promise<{ kind: 'committed' }>
  /** 读失败标记（sidecar）。 */
  readMarker(): Promise<{ at: number; reason: string; source: string; detail: string } | null>
  writeMarker(failure: { at: number; reason: string; source: string; detail: string }): Promise<void>
  removeMarker(): Promise<void>
}

/**
 * **跨进程写锁端口**（第二轮 P1-A）。
 *
 * 抽象出来只有一个理由：`features/` 不该 import `adapters/` 的实现细节，
 * 而"这台机器到底有没有跨进程锁"是**运行时能力**，必须能被诊断面如实报告、
 * 也必须能在测试里换成一个"永远抢不到"的替身（证明"拿不到锁就不发送"）。
 */
export interface ProcessMutex {
  /** 锁文件路径（诊断与日志用）。 */
  readonly file: string
  /** 抢锁；超时**抛错**（调用方据此本拍不发，不许无锁继续）。 */
  acquire(timeoutMs?: number): Promise<MutexLease>
  /** 只试一次（诊断/测试用）。 */
  tryAcquireOnce(): boolean
  close(): void
}

/** 一次租约。**必须**在 `finally` 里 release。 */
export interface MutexLease {
  readonly token: string
  /** `true` = 确实是我们自己释放的（`false` 说明归属已经变了）。 */
  release(): boolean
}

/** 已发布状态的形状（不可变）。 */
export interface StoreState {
  readonly items: readonly Reminder[]
}
