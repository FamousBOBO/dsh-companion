/** 跨进程调度租约：**为什么单例锁不住第二个进程**的那一半答案。
 *
 * `<dshHome>/channel-qq/contact.lock` 用独占创建（`open(path, 'wx')`）占坑，内容是
 * `{hostId, pid, epoch, acquiredAt, expiresAt}`。判据只有三条：
 *   1. 文件在、内容能读、`expiresAt` 还没到 → **别人活着**，本实例什么都不做；
 *   2. 文件在、但过期/内容读不出来（上一个进程死在 open 与 write 之间）→ 抢：先
 *      `rename` 成 `.stale-<pid>`（rename 是原子的，抢输的人拿不到 ENOENT 就退出），
 *      再删掉，然后照常独占创建；
 *   3. 文件就是自己的（hostId + pid 都相同）→ 续期即可。
 *
 * `epoch` 单调递增：`max(锁文件里的 epoch, 账本里的 lease.epoch) + 1`。它存在的意义是
 * 让**旧代次的迟到结果**写不进去——`assert()` 同时校验内存租约、盘上锁文件、有效期。
 * 一个被接管却还活在某个 await 里的旧实例，其提交会得到 `StaleLeaseError`。
 *
 * 本文件只管这把锁：不碰账本内容（续期/释放后要不要落盘由 `store.ts` 决定），
 * 也不判断"该不该跑"（那是 worker 的事）。
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { atomicWriteFile, readTextFileOrNull } from '../../adapters/fs-store/atomic.js'
import { withLock } from '../../adapters/fs-store/mutex.js'
import type { Clock } from '../../ports/clock.js'
import { describe, normalizeLease, sameLease } from './ledger.js'
import type { ContactLease } from './types.js'

/** 没写完的锁文件在这么多毫秒内视为"有人正在建锁"，不去抢。 */
const LOCK_WRITE_GRACE_MS = 2_000

/** 旧代次/丢了租约还想写：一律拒绝（调用方只记日志，不重试）。 */
export class StaleLeaseError extends Error {}

/**
 * 锁文件**建不出来**（ENOENT/EACCES/EPERM…）。
 *
 * 与"拿不到锁"必须分开：`null` 的含义只有一种——**别人活着，本实例闭嘴**。任何 IO
 * 故障都伪装成"多开"会让排查方向彻底跑偏（2026-10-29 的 V-P1 就是这么藏了一整天：
 * 全新 dshHome 上父目录不存在 → `open` 抛 ENOENT → 日志一句"租约在别的实例手里"，
 * 而真相是引擎从来没启动过）。所以这里抛出去，让日志写出真实错误码。
 */
export class LeaseCreateError extends Error {
  constructor(detail: string) {
    super(`锁文件创建失败：${detail}`)
    this.name = 'LeaseCreateError'
  }
}

/** 一次读锁的结果：`present` 但 `lease === null` = 文件在、内容读不出来（正在写/被写坏）。 */
interface LockState {
  readonly lease: ContactLease | null
  readonly present: boolean
  readonly ageMs: number
}

export interface LeaseKeeperOptions {
  readonly lockFile: string
  readonly hostId: string
  readonly pid: number
  /** 租约时长（默认 3 分钟：tick 60s，允许两次续期失败）。 */
  readonly ttlMs: number
  readonly clock: Clock
  readonly log: (line: string) => void
  /** 账本里记着的上一个代次（接管时作为下界，绝不让 epoch 回退）。 */
  readonly knownEpoch: () => number
}

export class LeaseKeeper {
  private held: ContactLease | null = null

  constructor(private readonly deps: LeaseKeeperOptions) {}

  get current(): ContactLease | null {
    return this.held
  }

  /** 取租约（已持有则续期）。拿不到 = 另一个活着的实例在跑。 */
  async acquire(): Promise<ContactLease | null> {
    const lease = await withLock(this.deps.lockFile, async () => await this.take())
    if (lease === null) return null
    this.held = lease
    return lease
  }

  /** 续期。失败 = 租约已经不属于自己（被接管或文件被删）。 */
  async renew(): Promise<boolean> {
    const held = this.held
    if (held === null) return false
    const next: ContactLease = { ...held, expiresAt: this.deps.clock.now() + this.deps.ttlMs }
    const ok = await withLock(this.deps.lockFile, async () => {
      const state = await this.readLockState()
      if (state.lease === null || !sameLease(state.lease, held)) return false
      await atomicWriteFile(this.deps.lockFile, `${JSON.stringify(next)}\n`)
      return true
    })
    if (!ok) {
      this.held = null
      this.deps.log('contact: 租约已不在自己手里（被接管或文件被删），本轮停止')
      return false
    }
    this.held = next
    return true
  }

  /** 释放：锁文件还是自己的才删（别把别人的锁删了）。 */
  async release(): Promise<void> {
    const held = this.held
    this.held = null
    if (held === null) return
    await withLock(this.deps.lockFile, async () => {
      const state = await this.readLockState()
      if (state.lease !== null && sameLease(state.lease, held)) await fs.rm(this.deps.lockFile, { force: true })
    }).catch((error: unknown) => {
      this.deps.log(`contact: 释放锁文件失败：${describe(error)}`)
    })
  }

  /** 提交前的最后一道闸：内存租约、盘上锁文件、有效期三样都要对得上。 */
  async assert(epoch: number): Promise<void> {
    const held = this.held
    if (held === null || held.epoch !== epoch) {
      throw new StaleLeaseError(`租约代次不符（提交 ${String(epoch)}，持有 ${held === null ? '无' : String(held.epoch)}）`)
    }
    const state = await this.readLockState()
    if (state.lease === null || !sameLease(state.lease, held)) throw new StaleLeaseError('锁文件已不在自己手里')
    if (state.lease.expiresAt <= this.deps.clock.now()) throw new StaleLeaseError('租约已过期')
  }

  /** 抢锁本体（已在 `withLock(lockFile)` 内）。 */
  private async take(): Promise<ContactLease | null> {
    const now = this.deps.clock.now()
    const state = await this.readLockState()
    const existing = state.lease
    if (existing !== null && this.isMine(existing)) {
      const renewed: ContactLease = { ...existing, expiresAt: now + this.deps.ttlMs }
      await atomicWriteFile(this.deps.lockFile, `${JSON.stringify(renewed)}\n`)
      return renewed
    }
    if (existing !== null && existing.expiresAt > now) return null
    // 文件在但读不出内容：可能是别人刚 open 还没写完。给它一点耐心，别抢活人的锁。
    if (state.present && existing === null && state.ageMs < LOCK_WRITE_GRACE_MS) return null
    if (state.present) await this.steal()
    const epoch = Math.max(existing?.epoch ?? 0, this.deps.knownEpoch()) + 1
    const lease: ContactLease = {
      hostId: this.deps.hostId,
      pid: this.deps.pid,
      epoch,
      acquiredAt: now,
      expiresAt: now + this.deps.ttlMs,
    }
    return await this.create(lease) ? lease : null
  }

  /**
   * 独占创建并写入内容（写完再读一遍确认还是自己）。
   *
   * 返回 `true` = 拿到了；`false` = **文件已被别人建出来**（EEXIST，正常的"多开"）。
   * 其它错误一律抛 `LeaseCreateError`：那是我自己的 IO 问题，不是别人活着。
   */
  private async create(lease: ContactLease): Promise<boolean> {
    // 父目录必须自己建：`store.load()` 在"账本不存在且无变更"时不写盘，所以全新
    // dshHome 上这个目录可能根本不存在，`open(..., 'wx')` 会 ENOENT（V-P1）。
    await fs.mkdir(path.dirname(this.deps.lockFile), { recursive: true }).catch((error: unknown) => {
      throw new LeaseCreateError(`父目录建不出来（${describe(error)}）`)
    })
    let handle: Awaited<ReturnType<typeof fs.open>> | null = null
    try {
      handle = await fs.open(this.deps.lockFile, 'wx')
      // 用 fd 上的 write 而不是整份覆盖写：这个文件刚被独占创建，只有自己看得见，
      // 因此不需要（也不能）走 tmp+rename——rename 会把别人的锁顶掉。
      await handle.write(Buffer.from(`${JSON.stringify(lease)}\n`, 'utf-8'), 0, undefined, 0)
      await handle.close()
      handle = null
    } catch (error) {
      if (handle !== null) await handle.close().catch(() => {})
      const code = (error as NodeJS.ErrnoException).code ?? ''
      // EEXIST = 别人刚好抢先建了锁，这是"多开"的正常答案，不是故障。
      if (code === 'EEXIST') return false
      throw new LeaseCreateError(`${code === '' ? '' : `${code} `}${describe(error)}`)
    }
    const state = await this.readLockState()
    return state.lease !== null && sameLease(state.lease, lease)
  }

  /** 抢过期锁：先改名成 `.stale-<pid>`（rename 原子），再删掉。 */
  private async steal(): Promise<void> {
    const stale = `${this.deps.lockFile}.stale-${String(this.deps.pid)}`
    try {
      await fs.rename(this.deps.lockFile, stale)
    } catch {
      return
    }
    await fs.rm(stale, { force: true }).catch(() => {})
  }

  private isMine(lease: ContactLease): boolean {
    return lease.hostId === this.deps.hostId && lease.pid === this.deps.pid
  }

  private async readLockState(): Promise<LockState> {
    const now = this.deps.clock.now()
    let mtimeMs = 0
    try {
      mtimeMs = (await fs.stat(this.deps.lockFile)).mtimeMs
    } catch {
      return { lease: null, present: false, ageMs: 0 }
    }
    const text = await readTextFileOrNull(this.deps.lockFile)
    let lease: ContactLease | null = null
    if (text !== null && text.trim() !== '') {
      try {
        lease = normalizeLease(JSON.parse(text))
      } catch {
        lease = null
      }
    }
    return { lease, present: true, ageMs: Math.max(0, now - mtimeMs) }
  }
}
