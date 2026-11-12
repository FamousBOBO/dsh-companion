/**
 * **加载与恢复的流程**（从 `store.ts` 抽出：那边要守 400 行硬上限）。
 *
 * 这两段与"业务变更"无关：它们是**启动 / 救火**路径，判据是"盘上现在是什么样"，
 * 而不是"这次编辑合不合法"。抽出来的边界是 `StoreIo`：本模块不认识 `ReminderStore` 这个类，
 * 只认识"能读盘、能写 sidecar、能发布冻结状态、能记日志"这几件事。
 *
 * 一条共同纪律：**先读完、再决定、最后一次性发布**。中途任何失败都不许改掉已有的内存状态
 * （否则"读失败"会连带把能用的旧状态也清空）。发布同步发生、不 await——写盘成功到发布
 * 之间不能出现"读者能看到旧状态"的窗口。
 */

import type { Reminder } from './reminder-model.js'
import { decodeReminderFile } from './store-load.js'
import type { ValidationIssue } from './store-contract.js'
import { storeFault } from './store-contract.js'
import type { RecoveryReport } from './store-contract.js'
import { diffOf } from './store-recovery.js'

/** 读失败的现场（sidecar 里也存一份）。 */
export interface ReadFailure {
  at: number
  reason: 'unreadable' | 'permission'
  source: string
  detail: string
}

export interface LoadReport {
  status: 'loaded' | 'missing' | 'locked'
  loaded: number
  failure?: ReadFailure
  issues?: readonly ValidationIssue[]
}

/** sidecar 里的 `reason` 只认这两种（别把任意字符串当分类用）。 */
const asReason = (reason: string): 'permission' | 'unreadable' => (reason === 'permission' ? 'permission' : 'unreadable')

export type RawRead =
  | { kind: 'missing' }
  | { kind: 'present'; raw: unknown }
  | { kind: 'failed'; failure: ReadFailure }

/** 加载/恢复需要的最小上下文（由 store 用闭包提供）。 */
export interface StoreIo {
  readonly ownerKey: string
  readonly log: (line: string) => void
  /** `missing` 与 `failed` 必须分得开：前者是新装，后者是事故。 */
  readRaw(): Promise<RawRead>
  readMarker(): Promise<{ at: number; reason: string; source: string; detail: string } | null>
  writeMarker(failure: ReadFailure): Promise<void>
  removeMarker(): Promise<void>
  current(): readonly Reminder[]
  publish(items: readonly Reminder[]): void
}

/** 加载的三种结局统一从这里返回（store 只负责把 `report` 存下来）。 */
export async function loadFromDisk(io: StoreIo): Promise<LoadReport> {
  const marker = await io.readMarker()
  const read = await io.readRaw()
  const locked = marker === null ? null : { ...marker, reason: asReason(marker.reason) }
  if (read.kind === 'missing') {
    io.publish([])
    if (locked === null) io.log('reminders: 盘上还没有提醒文件（新装）→ 空表起步、可写；**不在启动时创建**')
    return { status: locked === null ? 'missing' : 'locked', loaded: 0, ...(locked === null ? {} : { failure: locked }) }
  }
  if (read.kind === 'failed') {
    io.publish([])
    await io.writeMarker(read.failure)
    io.log(`reminders: 提醒文件读不出来（${read.failure.reason}：${read.failure.detail}）→ **锁定所有写入（只读）**，`
      + `不重建主文件；现场保留，故障记在 ${io.ownerKey}.readonly.json`)
    return { status: 'locked', loaded: 0, failure: read.failure }
  }
  const decoded = decodeReminderFile(read.raw)
  if (!decoded.ok) {
    const failure: ReadFailure = {
      at: Date.now(),
      reason: 'unreadable',
      source: io.ownerKey,
      detail: `结构不合法：${decoded.issues[0]?.path ?? ''} ${decoded.issues[0]?.message ?? ''}`,
    }
    io.publish([])
    await io.writeMarker(failure)
    io.log(`reminders: 提醒文件结构不合法（${String(decoded.issues.length)} 处，首处 ${decoded.issues[0]?.path ?? ''}）`
      + '→ **锁定所有写入（只读）**，不重建主文件')
    return { status: 'locked', loaded: 0, failure, issues: decoded.issues }
  }
  io.publish(decoded.items)
  io.log(`reminders: loaded ${String(decoded.items.length)} item(s)`)
  return {
    status: locked === null ? 'loaded' : 'locked',
    loaded: decoded.items.length,
    ...(locked === null ? {} : { failure: locked }),
  }
}

/**
 * **恢复**：单次读 + 完整解码 → 删 sidecar → **同步发布**（之后 store 才解锁）。
 *
 * 文件不存在**默认拒绝**（防"误删文件后一恢复就把数据清空"）；要解释成空表必须显式传
 * `{ allowMissingAsEmpty: true }`。坏结构/坏行/读失败 ⇒ 旧状态与锁都不动（直接抛）。
 */
export async function recoverFromDisk(
  io: StoreIo,
  locked: boolean,
  options: { allowMissingAsEmpty?: boolean },
): Promise<RecoveryReport> {
  if (!locked) throw storeFault('RECOVERY_INVALID', 'clearReadLock', '当前没有锁定，无需恢复')
  const read = await io.readRaw()
  if (read.kind === 'failed') {
    throw storeFault('RECOVERY_READ_FAILED', 'clearReadLock', `文件仍然读不出来：${read.failure.detail}`)
  }
  if (read.kind === 'missing' && options.allowMissingAsEmpty !== true) {
    throw storeFault('RECOVERY_INVALID', 'clearReadLock', '文件不存在：默认拒绝恢复（确需清空请传 { allowMissingAsEmpty: true }）')
  }
  const decoded = read.kind === 'missing'
    ? { ok: true as const, items: [] as Reminder[], notes: [] }
    : decodeReminderFile(read.raw)
  if (!decoded.ok) {
    throw storeFault('RECOVERY_INVALID', 'clearReadLock',
      `结构不合法（${String(decoded.issues.length)} 处，首处 ${decoded.issues[0]?.path ?? ''}）：拒绝恢复`)
  }
  const report = diffOf(io.current(), decoded.items)
  await io.removeMarker()
  // 删 marker 成功之后才发布（删不掉 ⇒ 保持旧状态与锁）。
  io.publish(decoded.items)
  io.log(`reminders: 已恢复并解锁（${String(report.loaded)} 条；removed ${String(report.removed.length)}、`
    + `replaced ${String(report.replaced.length)}、added ${String(report.added.length)}）`)
  return report
}
