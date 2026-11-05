/** 主动消息的账本（A1/A3）：候选、投递、计数、租约——**唯一被允许改这份数据的地方**。
 *
 * 为什么是单文件：候选与投递是一枚硬币的两面（候选到期/取消会改投递，投递结果会改
 * 候选），分两个文件就必然出现"候选已 consumed、投递还 pending"这种自相矛盾的半截
 * 状态；而它们的量级只有几十条，一次整份原子写比拆表更安全。
 *
 * 别处的规矩不在这里重复：跨进程租约与代次在 `lease.ts`（旧代次一律 `StaleLeaseError`），
 * 字段形状、洗数据与跨日归零在 `ledger.ts`，原子写与坏文件兜底在 `ledger-io.ts`，
 * **每类改动具体改哪些字段**在 `ledger-ops.ts`（纯函数，只认账本与参数）。
 * 本文件只回答一件事：**怎么在"进程内串行 + 跨进程租约"下安全地读改写**，写入口只有
 * `write(mutate, epoch)`。它不判断"该不该发"（gate.ts）、不发送（sender.ts）、不定时
 * （worker.ts）。
 */

import { withLock } from '../../adapters/fs-store/mutex.js'
import type { Clock } from '../../ports/clock.js'
import {
  describe,
  emptyLedger,
  sweepInterrupted as sweepLedgerInterrupted,
  type CandidatePatch,
  type ContactLedger,
  type DeliverySettlement,
} from './ledger.js'
import {
  applyCandidatePatch,
  applyClaim,
  applyCounters,
  applyNote,
  applyRoll,
  applySettle,
  applySettleAndAccount,
} from './ledger-ops.js'
import { readLedgerFile, writeLedgerFile, type LedgerIoOptions } from './ledger-io.js'
import { LeaseKeeper, StaleLeaseError } from './lease.js'
import type {
  ContactCandidate,
  ContactCounters,
  ContactDelivery,
  ContactLease,
} from './types.js'

export { StaleLeaseError }
// 兼容门面：账本形状与版本号住在 `ledger.ts`，但消费方（诊断、测试）一直从 store 拿，
// 这一层再导出就不必为了拆文件去改所有调用点。
export { CONTACT_LEDGER_VERSION } from './ledger.js'
export type { ContactLedger } from './ledger.js'

/** 构造参数：全部注入（时钟、pid、路径），测试用临时目录 + 假时钟就能复现。 */
export interface ContactStoreOptions {
  readonly file: string
  readonly lockFile: string
  /** 本实例的标识（通常是 hostname）；锁文件里靠它与 pid 认"是不是我"。 */
  readonly hostId: string
  readonly pid: number
  readonly log: (line: string) => void
  readonly clock: Clock
  /** 租约时长（默认 3 分钟）。 */
  readonly leaseTtlMs?: number
  /** 本地日键（时区由配置层决定，这里只调用）。 */
  readonly dayKey: (now: number) => string
  /** 测试缝：替换单次 rename（默认 `fs.rename`），钉住 Windows `EPERM` 的有界重试。 */
  readonly renameOnce?: (from: string, to: string) => Promise<void>
  /** 测试缝：替换一次退避等待（默认"注入时钟 + 真实定时器赛跑"，见 `ledger-io.backoff` 的注记）。 */
  readonly retryDelay?: (ms: number) => Promise<void>
}

/** 投递结算与候选补丁的**形状**住在 `ledger.ts`（数据契约 vs IO 事务），这里只做门面。 */
export type { CandidatePatch, DeliverySettlement } from './ledger.js'

export class ContactStore {
  private ledger: ContactLedger
  private loaded = false
  private readonly keeper: LeaseKeeper

  constructor(private readonly deps: ContactStoreOptions) {
    this.ledger = emptyLedger(deps.dayKey(deps.clock.now()))
    this.keeper = new LeaseKeeper({
      lockFile: deps.lockFile,
      hostId: deps.hostId,
      pid: deps.pid,
      ttlMs: deps.leaseTtlMs ?? 180_000,
      clock: deps.clock,
      log: deps.log,
      knownEpoch: () => Math.max(this.ledger.lease?.epoch ?? 0, 0),
    })
  }

  // ── 读 ────────────────────────────────────────────────────────────────

  /** 启动读一次（幂等）；坏文件 → `.corrupt` + 空表 + 一行日志。
   * `sweep=false` 时只读不把 running 降级；生产在拿到租约后再 sweep，避免第二进程
   * 启动时误结算另一个活实例的 running 投递（R5-3 两进程边界）。
   */
  async load({ sweep = true }: { sweep?: boolean } = {}): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    // 读也进同一把进程内锁：Windows 上 `rename` 覆盖一个正被读句柄打开的目标会 EPERM，
    // "写走锁、读裸读"正好制造这种重叠（见 `ledger-io.ts` 的第二次尝试）。
    await withLock(this.deps.file, async () => {
      const { ledger, swept } = await this.readLedger(sweep)
      this.ledger = ledger
      if (swept > 0) {
        this.deps.log(`contact: ${String(swept)} 条投递处于 running，已降级为 unknown（进程中途结束，不重发）`)
        await this.persist(this.ledger).catch((error: unknown) => {
          this.deps.log(`contact: 降级落盘失败：${describe(error)}`)
        })
      }
    })
  }

  /** 在持有租约时把 running 降级并计额（幂等；生产启动路径专用）。 */
  async sweepInterrupted(now: number, epoch: number): Promise<number> {
    let swept = 0
    await this.write((ledger) => {
      swept = sweepLedgerInterrupted(ledger, now)
      return swept > 0
    }, epoch)
    return swept
  }

  /** 只读快照。调用方**不得**改它（改账本只能经 `write`）。 */
  get state(): ContactLedger {
    return this.ledger
  }

  /** 当前持有的租约（没持有 = null）。 */
  get lease(): ContactLease | null {
    return this.keeper.current
  }

  candidate(id: string): ContactCandidate | undefined {
    return this.ledger.candidates[id]
  }

  /** 同一件事只该有一个活着的候选（终态的不算，否则"取消过的"会挡住"重新提起"）。 */
  findByDedupeKey(dedupeKey: string): ContactCandidate | undefined {
    for (const row of Object.values(this.ledger.candidates)) {
      if (row.dedupeKey === dedupeKey && row.state !== 'cancelled' && row.state !== 'expired') return row
    }
    return undefined
  }

  listCandidates(): ContactCandidate[] {
    return Object.values(this.ledger.candidates)
  }

  listDeliveries(): ContactDelivery[] {
    return Object.values(this.ledger.outbox)
  }

  /** 已经"递出去了"的去重键（submitted/confirmed/unknown 都算，`running` 不算）。 */
  deliveredDedupeKeys(): string[] {
    return Object.values(this.ledger.outbox)
      .filter((row) => row.state === 'submitted' || row.state === 'confirmed' || row.state === 'unknown')
      .map((row) => row.dedupeKey)
  }

  // ── 写 ────────────────────────────────────────────────────────────────

  /** 读-改-写一次（进程内串行 + 原子落盘）。返回"真的改了并写下去了"。
   *
   * P2.5 round16 §2.3a：`mutate` 作用在**刚从盘上重新解析出来的草稿**上，只有落盘成功了
   * 才把草稿整体换进内存。旧写法是"先把内存换成盘上那份、再就地改、最后才落盘"——于是
   * `persist()` 一抛，进程里的账本已经是脏的：配额、冷却、`deliveredDedupeKeys` 会读到
   * 一个从未落盘的状态（窗口一直持续到下一次成功写盘，重读盘才自愈）。这类"窗口型"缺陷
   * 在现场几乎不可能复现，所以从结构上消掉它，而不是要求每个调用方记得回滚。
   *
   * 草稿天然与内存隔离：`readLedger` 每次都从 JSON 重新构造对象，没有共享引用，因此这里
   * 不需要额外深拷贝。
   *
   * `mutate` 返回 false（业务上不该改）时**不落盘**，但**仍然把草稿采纳进内存**：读盘本身
   * 就在自愈（跨日归零、洗数据，以及将来任何降级动作都在 `readLedger` 里），旧实现那条
   * "读一次就跟着盘走"的面子不能丢——丢掉它，"内存相对盘落后"的窗口就会出现在**正常路径**
   * 上（而不是只在落盘失败路径上）。两件事因此被分开成两条互不越界的规则：
   *   - **没改成的东西绝不写盘**（`mutate` 说 false ⇒ 一个字节都不落）；
   *   - **改了但没写成的绝不换内存**（`persist` 抛 ⇒ 草稿丢弃，内存仍是上一次落盘的样子）。
   */
  async write(mutate: (ledger: ContactLedger) => boolean, epoch: number | null = null): Promise<boolean> {
    return await withLock(this.deps.file, async () => {
      if (epoch !== null) await this.keeper.assert(epoch)
      const draft = (await this.readLedger(false)).ledger
      if (!mutate(draft)) {
        this.ledger = draft
        return false
      }
      await this.persist(draft)
      this.ledger = draft
      return true
    })
  }

  /** 保存（出错原样抛，调用方决定降级）。原子写、EPERM 重试与版本号在 `ledger-io.ts`。 */
  private async persist(ledger: ContactLedger): Promise<void> {
    await writeLedgerFile(this.io(), ledger)
  }

  /** 文件层要的东西（测试缝 `renameOnce` 与账本锁同源，见 `ledger-io.ts`）。 */
  private io(): LedgerIoOptions {
    return {
      file: this.deps.file,
      clock: this.deps.clock,
      log: this.deps.log,
      dayKey: this.deps.dayKey,
      ...(this.deps.renameOnce === undefined ? {} : { renameOnce: this.deps.renameOnce }),
      ...(this.deps.retryDelay === undefined ? {} : { retryDelay: this.deps.retryDelay }),
    }
  }

  // ── 租约 ──────────────────────────────────────────────────────────────

  /**
   * 取租约（已持有则续期）。拿不到 = 另一个活着的实例在跑，**本实例就此闭嘴**。
   *
   * 顺序要点（两把锁**不许嵌套持有时交换**，否则会互相等）：
   *   1. 先抢锁文件（`keeper.acquire`，只碰 `contact.lock`）；
   *   2. 再进账本锁读盘 + 落盘——读盘降级（`running`→`unknown`）与代次递增在同一处
   *      发生，于是"接管"这件事在账本上永远只有一种样子；
   *   3. 读盘与写盘都在账本锁内，Windows 上就不会出现"读句柄还开着、rename 就来了"。
   */
  async acquireLease(): Promise<ContactLease | null> {
    const lease = await this.keeper.acquire()
    if (lease === null) return null
    let swept = 0
    await withLock(this.deps.file, async () => {
      const read = await this.readLedger(true)
      swept = read.swept
      this.ledger = read.ledger
      this.loaded = true
      this.ledger.lease = lease
      await this.persist(this.ledger).catch((error: unknown) => {
        this.deps.log(`contact: 租约落盘失败：${describe(error)}`)
      })
    })
    if (swept > 0) this.deps.log(`contact: 接管时降级 ${String(swept)} 条 running 投递为 unknown`)
    this.deps.log(`contact: 取得租约 epoch=${String(lease.epoch)}（${this.deps.hostId}#${String(this.deps.pid)}）`)
    return lease
  }

  /** 续期（tick 每轮调）。失败 = 租约已经不属于自己，返回 false 且**不**改账本。 */
  async renewLease(): Promise<boolean> {
    if (!(await this.keeper.renew())) return false
    const lease = this.keeper.current
    if (lease === null) return false
    await this.write((ledger) => {
      if (ledger.lease !== null && ledger.lease.epoch > lease.epoch) return false
      ledger.lease = lease
      return true
    }).catch(() => false)
    return true
  }

  /** 释放：锁文件还是自己的才删（别把别人的锁删了）。 */
  async releaseLease(): Promise<void> {
    await this.keeper.release()
    await this.write((ledger) => {
      if (ledger.lease === null) return false
      ledger.lease = null
      return true
    }).catch(() => false)
  }

  /**
   * 执行点的所有权校验（F2）：内存租约 + **盘上锁文件** + 有效期，三样都要对得上。
   *
   * 为什么不能只看 `lease` getter：那是内存值。租约过期后被别的进程接管，旧实例的
   * 内存里 epoch 还是老样子，照它发送就是重复外发。只有读锁文件能问出真相。
   *
   * @returns `true` = 这一代租约还是我的；`false` = 已经不属于我（或已过期）。
   */
  async assertLease(epoch: number): Promise<boolean> {
    try {
      await this.keeper.assert(epoch)
      return true
    } catch {
      return false
    }
  }

  /**
   * 从盘上现读一份快照，**不采纳进内存**。
   *
   * 执行点用它核对"这条候选在盘上是否还活着、这条投递是否还是 running"。读进内存会
   * 让执行点改写正在进行的上下文（比如把别人刚写的状态覆盖掉），所以这里只给快照。
   */
  async snapshot(): Promise<ContactLedger> {
    return await withLock(this.deps.file, async () => (await this.readLedger(false)).ledger)
  }

  // ── 候选 / 投递 / 计数 ────────────────────────────────────────────────

  async putCandidate(candidate: ContactCandidate, epoch: number | null = null): Promise<boolean> {
    return await this.write((ledger) => {
      ledger.candidates[candidate.id] = candidate
      return true
    }, epoch)
  }

  /** 改候选（版本 +1：时间戳、抑制原因、证据都算变化）。判据在 `ledger-ops.applyCandidatePatch`。 */
  async patchCandidate(id: string, patch: CandidatePatch, now: number, epoch: number | null = null): Promise<ContactCandidate | null> {
    let out: ContactCandidate | null = null
    await this.write((ledger) => {
      out = applyCandidatePatch(ledger, id, patch, now)
      return out !== null
    }, epoch)
    return out
  }

  /**
   * 领取一条投递：置 `running` 并绑定租约。
   *
   * 幂等与"取消不复活"的判据在 `ledger-ops.applyClaim`——它与"候选是否还被允许发"在
   * **同一个事务**里判（只看投递行会让"取消后仍然发出去"成真）。
   */
  async claimDelivery(delivery: ContactDelivery, epoch: number): Promise<boolean> {
    const owner = `${this.deps.hostId}#${String(this.deps.pid)}`
    return await this.write((ledger) => applyClaim(ledger, delivery, owner, epoch, this.deps.clock.now()), epoch)
  }

  /** 结算一条投递。旧代次的迟到结果写不进去（`epoch` 对不上就 false）。 */
  async settleDelivery(id: string, epoch: number, settle: DeliverySettlement, now: number): Promise<boolean> {
    return await this.write((ledger) => applySettle(ledger, id, epoch, settle, now), epoch)
  }

  /**
   * R5-3: settle the delivery row, the send quota/cooldown counters and the candidate
   * terminal state in **one** ledger write. A crash can no longer leave a confirmed/
   * unknown row without its quota charge, which would let a different candidate spend
   * the same daily slot after restart.
   */
  async settleDeliveryAndAccount(
    id: string,
    epoch: number,
    settle: DeliverySettlement,
    now: number,
    candidateId: string,
    detail: string,
  ): Promise<boolean> {
    return await this.write(
      (ledger) => applySettleAndAccount(ledger, id, epoch, settle, now, candidateId, detail),
      epoch,
    )
  }

  /**
   * 改计数。**`epoch` 必填**：计数决定"今天还能说几句"，是最该防旧代次的字段
   * （一个被接管的旧实例写回旧计数，等于把额度凭空还回去）。
   */
  async patchCounters(patch: Partial<ContactCounters>, epoch: number): Promise<ContactCounters> {
    let out = this.ledger.counters
    await this.write((ledger) => {
      out = applyCounters(ledger, patch)
      return true
    }, epoch)
    return out
  }

  /**
   * 跨日清零。返回新计数（没跨日 = null）。
   *
   * 真正的归零发生在**读盘**（`ledger.rollCounters`，跨日重启也正确）；这里管的是
   * "进程连续跑过午夜、内存里还是昨天的账"那一刻：把内存与盘一起推进到今天。
   *
   * 为什么这里**总是**落一笔，哪怕读盘时已经归零过（round18 裁决，别改成"盘上已是今天
   * 就算了"）：读盘归零是纯函数，盘上的 `day` 可能还停在昨天，而"今天"这件事应该由盘自己
   * 说得清——下一次接管/重启读到的就是一份明白账，不必再靠读时推算。代价是跨日那天多一次
   * 原子写（一天一次）。另外 `write()` 在 `mutate` 说 false 时**只采纳内存、不落盘**，
   * 所以"让它自己写"这件事必须由这里的 `return true` 明确表达，不能靠副作用。
   */
  async rollDay(now: number, epoch: number): Promise<ContactCounters | null> {
    const day = this.deps.dayKey(now)
    if (this.ledger.counters.day === day) return null
    await this.write((ledger) => {
      applyRoll(ledger, day)
      return true
    }, epoch)
    return this.ledger.counters.day === day ? this.ledger.counters : null
  }

  /** 记一条抑制/投递原因（连续同因不重复记，避免夜里每分钟刷一行）。 */
  async noteReason(reason: string, now: number, epoch: number | null = null): Promise<void> {
    await this.write((ledger) => applyNote(ledger, reason, now), epoch)
  }

  // ── 读盘 ──────────────────────────────────────────────────────────────

  /** 读盘（形状/洗数据/跨日归零在 `ledger.ts`，坏文件兜底在 `ledger-io.ts`）。 */
  private async readLedger(sweep: boolean): Promise<{ ledger: ContactLedger; swept: number }> {
    return await readLedgerFile(this.io(), sweep)
  }
}
