/**
 * **跨进程写锁**（第二轮 P1-A）：用 SQLite 的事务锁做互斥，**不**手写 lock 文件/TTL。
 *
 * ## 为什么现有的两个东西不够
 *
 *   - `atomicWriteFile()`（`./atomic.ts`）保证"不会写坏"，**不保证"不丢更新"**——
 *     两个进程各自读到 `claim=null` 再各自 rename，最后盘上只剩一个 claim，
 *     但**两条 QQ 消息都已经发出去了**。磁盘最终状态证明不了"只发过一次"；
 *   - `withLock()`（`./mutex.ts`）是**进程内**的键排队（一个 `Map`），跨进程等于没有。
 *
 * ## 为什么是 SQLite 事务，而不是自己写锁文件
 *
 * `BEGIN IMMEDIATE` 拿的是**内核级文件锁**（POSIX `fcntl` / Win32 `LockFileEx`）：
 *
 *   1. 互斥由**操作系统**给，不是由我们的定时器给；
 *   2. **进程崩溃即自动释放**——不需要 TTL，也**不会**"误删仍被活跃进程持有的锁"。
 *      自己写 lock 文件最典型的两个坑（TTL 太短 ⇒ 误删活锁；TTL 太长 ⇒ 崩了之后永久死锁）
 *      在这里根本不存在。实测强行终止持锁进程后，另一个进程 1 ms 就拿到了；
 *   3. 锁与"锁里读写什么"无关：锁是独立的 `<reminders.json>.lock.db`，提醒数据仍在
 *      `reminders.json`（旧文件路径、旧字节格式一字不改）。
 *
 * `node:sqlite` 是 Node 24 内置模块（本仓 `engines.node >= 24`，
 * `companion-foundation/group-memory.mjs` 已在用同一套 `process.getBuiltinModule` 取法），
 * **不引入新依赖**。
 *
 * ## 关键取舍：锁里**不写任何数据**，释放用 `ROLLBACK`
 *
 * 提醒数据不在 SQLite 里（那是独立的原子 rename），所以这个事务只当**互斥量**用，
 * 不需要提交任何东西。这带来三个实测可见的好处：
 *
 *   - **没有 COMMIT 争用**：rollback journal 模式下，持锁者 `COMMIT` 时有竞争者在敲门
 *     会**随机**抛 `database is locked`（实测 10 次里 4 次），而 `ROLLBACK` 10/10 成功。
 *     持锁者"释放失败"会把锁泄漏到进程退出，正是我们最不想要的故障；
 *   - **数据库文件 0 字节**：不建表、不写一行，锁文件里没有任何需要迁移/清理的状态；
 *   - **"释放别人的锁"在结构上不可能**：只有持有这**一个**打开事务的那个进程能对
 *     `BEGIN` 之后的状态执行 `ROLLBACK`。owner/token 校验因此退化成进程内的
 *     lease 对象校验（同一个 token 只能 release 一次），而跨进程那一半是内核保证的。
 *
 * ## 不阻塞事件循环
 *
 * `busy_timeout = 0` + **异步退避重试**：抢不到就 `await delay(10ms)` 再来，
 * 而不是让 `BEGIN` 自己阻塞（那会把整个宿主的事件循环钉住）。实测 700 ms 争用期间
 * 每 5 ms 的定时器照样跑了 33 次。
 *
 * ## 句柄只在一次 `acquire()` 期间存在
 *
 * 长驻句柄在 Windows 上有两个实际代价：① 临时目录删不掉（测试、迁移都会踩）；
 * ② 进程退出被拖住。写提醒是低频操作（一拍至多几条），开一次 sqlite 约 1 ms，
 * 换来"句柄只在事务期间存在"，也顺手保证不会有跨 tick 的锁泄漏。
 */

import * as path from 'node:path'
import { mkdirSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import type { MutexLease as LeasePort, ProcessMutex } from '../../features/reminders/store-contract.js'

/** 抢锁的总预算：超过就如实失败（**绝不**降级成"没锁也写"）。 */
export const LOCK_TIMEOUT_MS = 5_000
/** 重试间隔（异步，不阻塞事件循环）。 */
export const LOCK_RETRY_MS = 10

export type MutexLease = LeasePort

/** 抢锁失败（**暂时性**故障：不许继续发送，也不要停表）。 */
export class LockTimeoutError extends Error {
  readonly code = 'LOCK_TIMEOUT'
  constructor(readonly waitedMs: number, readonly timeoutMs: number) {
    super(`跨进程写锁在 ${String(waitedMs)}ms 内没拿到（上限 ${String(timeoutMs)}ms）：另一个 DSH 进程正在写同一份提醒文件`)
    this.name = 'LockTimeoutError'
  }
}

/**
 * **本运行时没有跨进程锁**（第三轮 P2）：`node:sqlite` 取不到，或锁文件打不开。
 *
 * 与 `LockTimeoutError` 必须分开——那是"竞争，稍后再试"，这是"这台机器永远拿不到锁"。
 * 混成一个码会把"永久写不了"报成"竞争激烈"，运维会一直等一个不会来的自愈。
 * 行为上两者都是 **fail-closed**：不许写入、更不许无锁写入。
 */
export class ProcessLockUnavailableError extends Error {
  readonly code = 'LOCK_UNAVAILABLE'
  constructor(readonly detail: string) {
    super(`本运行时没有可用的跨进程写锁（${detail}）：拒绝在无锁状态下写入`)
    this.name = 'ProcessLockUnavailableError'
  }
}

/** `node:sqlite` 里我们真正用到的那点形状（不把实验性类型铺到调用方）。 */
interface SqliteDb {
  exec(sql: string): void
  close(): void
}
type SqliteCtor = new (file: string) => SqliteDb

let sqliteModule: { DatabaseSync: SqliteCtor } | null | 'unset' = 'unset'

/**
 * 同步取 `node:sqlite`（取不到返回 null）。
 *
 * 为什么走 `process.getBuiltinModule` 而不是静态 `import`：静态 import 在缺少该内置模块时会让
 * **整个模块加载失败**，而这里的失败应当是"没有跨进程锁"（可诊断、可退化），
 * 不是"提醒子系统起不来"。
 */
function sqlite(): { DatabaseSync: SqliteCtor } | null {
  if (sqliteModule !== 'unset') return sqliteModule
  try {
    const get = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule
    const mod = typeof get === 'function' ? get.call(process, 'node:sqlite') : null
    const ctor = (mod as { DatabaseSync?: unknown } | null)?.DatabaseSync
    sqliteModule = typeof ctor === 'function' ? { DatabaseSync: ctor as SqliteCtor } : null
  } catch {
    sqliteModule = null
  }
  return sqliteModule
}

/** 本运行时能不能提供跨进程锁（诊断面要如实报告这一条）。 */
export function processLockAvailable(): boolean {
  return sqlite() !== null
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

/** SQLite 的"被占用"错误（不同平台/版本文案不同，所以 code 与文案双判）。 */
function isBusy(error: unknown): boolean {
  const code = String((error as { code?: unknown }).code ?? '')
  const message = String((error as { message?: unknown }).message ?? '')
  return code.includes('SQLITE_BUSY') || code.includes('SQLITE_LOCKED')
    || /database is locked|database table is locked/i.test(message)
}

/**
 * 一把绑在**某个提醒文件**上的跨进程写锁。
 *
 * 锁文件是 `<reminders.json>.lock.db`（同目录 ⇒ 同一个 `dataDir` 一定是同一把锁）。
 */
export class SqliteProcessMutex implements ProcessMutex {
  readonly file: string
  private closed = false
  private held: string | null = null

  constructor(targetFile: string, private readonly log: (line: string) => void = () => {}) {
    this.file = `${targetFile}.lock.db`
  }

  /** 本进程此刻是否持锁（诊断用；`close()` 之后一律 `false`）。 */
  get isHeld(): boolean { return this.held !== null }

  /**
   * 抢锁。**超时抛 `LockTimeoutError`**（调用方据此"本拍不发、稍后再试"，**不许**无锁继续）。
   *
   * 重入保护：同一实例已在持有状态时直接报错——那说明调用方漏了 `release()`。
   */
  async acquire(timeoutMs = LOCK_TIMEOUT_MS): Promise<MutexLease> {
    if (this.closed) throw new Error('跨进程写锁已关闭')
    if (this.held !== null) throw new Error('同一把跨进程写锁被重复获取（上一笔没 release）')
    const mod = sqlite()
    // **能力不可用是"永远"，不是"这次竞争激烈"**：抛专用错误，让上层报 `LOCK_UNAVAILABLE`。
    if (mod === null) throw new ProcessLockUnavailableError('本运行时没有 node:sqlite')
    let db: SqliteDb
    try {
      db = openHandle(mod, this.file)
    } catch (error) {
      // 打不开锁文件（权限、只读盘、目录不存在…）同样是"这台机器拿不到锁"，不是超时。
      throw new ProcessLockUnavailableError(`打不开锁文件 ${this.file}：${error instanceof Error ? error.message : String(error)}`)
    }
    const token = `pid-${String(process.pid)}-${randomBytes(6).toString('hex')}`
    const started = Date.now()
    for (;;) {
      try {
        // **只要这一句**：拿到即拥有互斥，直到 ROLLBACK / 句柄关闭 / 进程消失。
        db.exec('BEGIN IMMEDIATE')
        this.held = token
        return this.leaseFor(db, token)
      } catch (error) {
        if (!isBusy(error)) {
          closeQuietly(db)
          throw error
        }
        const waited = Date.now() - started
        if (waited >= timeoutMs) {
          closeQuietly(db)
          throw new LockTimeoutError(waited, timeoutMs)
        }
        // 异步退避：让出事件循环，别把宿主钉在 `BEGIN` 上。
        await delay(LOCK_RETRY_MS)
      }
    }
  }

  /** **只试一次**（拿不到立刻返回 `false`）：诊断/测试用，不重试、不留状态。 */
  tryAcquireOnce(): boolean {
    if (this.closed || this.held !== null) return false
    const mod = sqlite()
    if (mod === null) return false
    let db: SqliteDb | null = null
    try {
      db = openHandle(mod, this.file)
      db.exec('BEGIN IMMEDIATE')
      db.exec('ROLLBACK')
      return true
    } catch (error) {
      if (isBusy(error)) return false
      throw error
    } finally {
      if (db !== null) closeQuietly(db)
    }
  }

  /** 关闭（`store.close()` 调）。挡住后续 acquire；在途租约由各自的 `release()` 收尾。 */
  close(): void {
    this.closed = true
    this.held = null
  }

  private leaseFor(db: SqliteDb, token: string): MutexLease {
    let released = false
    return {
      token,
      release: (): boolean => {
        if (released) return false
        released = true
        // **只可能是自己的**：这个事务句柄只在本进程、只在这一笔里存在。
        if (this.held !== token) {
          this.log(`reminders: 写锁归属不符（本进程持的是 ${this.held ?? 'none'}，要放的是 ${token}）→ 不放，交给句柄关闭`)
          closeQuietly(db)
          return false
        }
        this.held = null
        // `ROLLBACK` 而没有改动 = 空操作，且**不会**像 `COMMIT` 那样在竞争者敲门时抛 BUSY。
        try {
          db.exec('ROLLBACK')
        } catch (error) {
          // 走到这里说明事务已经不在了（连接异常），锁也已经随连接消失；照实记一行。
          this.log(`reminders: 释放写锁时事务已不存在（${error instanceof Error ? error.message : String(error)}）：锁已随连接释放`)
        }
        closeQuietly(db)
        return true
      },
    }
  }

  /** 锁文件所在目录（测试清理用）。 */
  get dir(): string { return path.dirname(this.file) }
}

function openHandle(mod: { DatabaseSync: SqliteCtor }, file: string): SqliteDb {
  // 目录必须先存在：sqlite 自己**不会**建父目录，报错是 `unable to open database file`（一点线索都没有）。
  // 这里只在**真的要写**的时候才创建（`dryRun` 全程不写，连锁文件都不会出现）。
  mkdirSync(path.dirname(file), { recursive: true })
  const db = new mod.DatabaseSync(file)
  // **不阻塞**：抢不到立刻 BUSY，由上面的异步退避决定何时再试。
  // 不建表、不写行：这个库只当互斥量用（见文件头"锁里不写任何数据"）。
  db.exec('PRAGMA busy_timeout = 0')
  return db
}

function closeQuietly(db: SqliteDb): void {
  try { db.close() } catch { /* 已经关了 */ }
}
