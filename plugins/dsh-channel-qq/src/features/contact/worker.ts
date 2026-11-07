/** 主动消息的**节拍器**：定时看一眼候选池，问门控，然后（可能）交给 sender。
 *
 * 本文件只管顺序，不管判定（`gate.ts`）、不管发送（`sender.ts`）、不管落盘细节
 * （`store.ts`）、不管账本怎么变（`transitions.ts`）、不管怎么起草（`model.ts`）：
 *
 *   取租约 → 跨日归零 → 清理未回复计数 → 过期/超视界 → 候选池上限 → 挑出本轮该看的
 *   → 逐条 `evaluateGate` → send/defer/drop
 *
 * 五条不许省的顺序（每条都对应一类事故）：
 *   1. **先停再判**：`paused` / `enabled=false` 时**不取租约、不读候选、不调模型**，
 *      已持有的租约当场释放——卸载/暂停不留后台任务，也不占着实例位置；
 *   2. **空转零模型调用**：起草只在"门控说 send"之后发生（`attemptSend`），于是"候选
 *      全被免打扰挡住"的那些 tick 一次模型都不调；
 *   3. **先落盘再执行**：领取（`claimDelivery` 置 running）落盘之后才真正发送，进程死
 *      在半路读盘时会被降级成 `unknown`——不是"重发"，是"承认不知道"；
 *   4. **过期不补发**：`expiresAt` 已过、或 `earliestAt` 老过补算视界的候选判过期；
 *   5. **单飞**：上一轮还在跑就跳过这一轮（否则同一条候选会被领两次）。
 *
 * 时间一律来自注入的 `Clock`；`tick(now)` 可以被测试直接调用（不用等真实定时器）。
 */

import type { ContactConfig } from '../../config/sections/contact.js'
import type { Clock, TimerHandle } from '../../ports/clock.js'
import { evaluateGate, type GateReason } from './gate.js'
import { attemptSend, type AttemptDeps, type DraftRing } from './attempt.js'
import type { AdaptiveDecisionPort } from './adaptive-host.js'
import type { DraftPort } from './model.js'
import { ContactSender, type ContactIdentity } from './sender.js'
import { ContactStore, StaleLeaseError, type DeliverySettlement } from './store.js'
import {
  afterSend,
  capCandidates,
  deferCandidate,
  dropCandidate,
  expireStale,
  pruneOldDeliveries,
  settleStreaks,
  type ContactRoomFacts,
  type TransitionDeps,
} from './transitions.js'
import type {
  ContactCandidate,
  ContactDelivery,
  ContactRuntimeFacts,
} from './types.js'

/** 终态投递记录的保留期（超过就清掉，否则账本无界增长）。 */
const RETENTION_MS = 30 * 24 * 3_600_000

export type { ContactRoomFacts } from './transitions.js'

export interface ContactWorkerDeps {
  readonly sleepText?: NonNullable<AttemptDeps['sleepText']>
  readonly adaptivePort?: AdaptiveDecisionPort
  readonly store: ContactStore
  readonly sender: ContactSender
  readonly clock: Clock
  readonly log: (line: string) => void
  /** 活配置（每次 tick 现取：后台改完不用重挂）。 */
  readonly config: () => ContactConfig
  readonly roomFacts: (room: string) => ContactRoomFacts
  readonly identity: () => ContactIdentity
  /** 是否有工具在跑（首版没有可靠事实源，缺省 = false，不做假设）。 */
  readonly toolRunning?: () => boolean
  /** 独立候选来源（例如私聊空闲 follow-up）；缺省 = 只收外部 propose。 */
  readonly sourceCandidates?: () => Promise<void>
  /** 草稿端口（`model.ts` 的 `DraftPort`）；没接线时 `direct` 模式不发。 */
  readonly draftPort?: DraftPort | null
  /**
   * 起草上下文的来源（P2.5-3D）：只在"门控放行之后、调模型之前"被调用。
   * 缺省 = 不组装（历史用例与 `turn` 模式的行为不变）。
   */
  readonly draftContext?: AttemptDeps['draftContext']
  /** 同一条投递最多试几次（超过就放弃这条候选）。 */
  readonly maxSendAttempts?: number
  /** 卸载时等多久让在途发送走到安全点。 */
  readonly disposeWaitMs?: number
  /**
   * 每一轮 tick **收尾之后**调一次的钩子（点歌的"自主选歌"挂在这里）。
   *
   * 为什么挂在 contact 的节拍上而不是自己起定时器：主动联系已经有免打扰、额度、冷却与
   * 会话绑定校验（`evaluateOutboundBudget`），而且它已经知道"这个房间刚说过话"。
   * 再起一个定时器就是第二套节拍，两套节拍互相不知道对方刚发过什么。
   *
   * 语义：**尽力而为**。它失败/抛错只记一行日志，绝不影响这一轮的联系候选投递
   * （两条路径的成本完全不同：点歌要跑两三分钟，联系是发一句话）。
   */
  readonly afterTick?: (now: number) => Promise<void>
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 有界等待：`work` 完成或超时，两者取先到（卸载时绝不能无限等一次网络往返）。 */
async function boundedWait(clock: Clock, ms: number, work: Promise<unknown>): Promise<void> {
  // 句柄放对象里：赋值在 Promise 执行器（闭包）内，`let` 会被窄化成 null 字面量。
  const timer: { handle: TimerHandle | null } = { handle: null }
  const timeout = new Promise<void>((resolve) => { timer.handle = clock.setTimeout(resolve, ms) })
  try {
    await Promise.race([work.then(() => undefined, () => undefined), timeout])
  } finally {
    timer.handle?.cancel()
  }
}


export class ContactWorker {
  private timer: TimerHandle | null = null
  /** 防重入：上一轮还在跑（发送里有 await）就跳过这一轮，而不是叠起来跑。 */
  private busy = false
  private paused = false
  private stopped = false
  private inflight: Promise<void> | null = null
  private leaseLostNoted = false
  /** 锁文件建不出来这类硬故障只记一次（否则每拍刷一行，日志失去信息量）。 */
  private leaseErrorNoted = false
  /**
   * 被"上一轮还在跑"挤掉的那一拍（记下时刻，等本轮收尾时补跑）。
   *
   * 为什么需要它：`resume()` → `start()` 会立刻掷一拍，但如果上一拍还在 await 里，
   * 这一拍只会撞上 `busy` 然后被静默丢掉——而定时器要 60 秒后才再来。于是"恢复"
   * 之后可能整整一分钟什么都不发生（假时钟下就是永远）。丢掉一拍和丢掉一分钟，
   * 在"恢复要立刻继续"这个承诺上是一回事。
   */
  private pendingTickAt: number | null = null
  /** 本小时内已发生的起草时刻（每小时突发预算的内存环；重启后从零开始是可接受的）。 */
  private readonly drafts: DraftRing = { calls: [] }
  private readonly transitions: TransitionDeps
  /** 「门控放行之后」那一段的依赖（顺序与冻结复查都在 `attempt.ts`，这里只提供它要的东西）。 */
  private readonly attempt: AttemptDeps
  private readonly maxSendAttempts: number

  constructor(private readonly deps: ContactWorkerDeps) {
    this.maxSendAttempts = deps.maxSendAttempts ?? 3
    this.transitions = {
      store: deps.store,
      log: deps.log,
      roomFacts: deps.roomFacts,
      maxSendAttempts: this.maxSendAttempts,
    }
    // `isFrozen` 必须是闭包而不是快照：判断发生在模型调用前后两个时刻。
    this.attempt = {
      ...(deps.sleepText === undefined ? {} : { sleepText: deps.sleepText }),
      store: deps.store,
      sender: deps.sender,
      clock: deps.clock,
      log: deps.log,
      transitions: this.transitions,
      draftPort: () => deps.draftPort ?? null,
      ...(deps.adaptivePort ? { adaptivePort: deps.adaptivePort } : {}),
      ...(deps.draftContext === undefined ? {} : { draftContext: deps.draftContext }),
      identity: deps.identity,
      isFrozen: () => this.stopped || this.paused,
      drafts: this.drafts,
    }
  }

  /** 暂停状态（诊断面直接读它）。 */
  get isPaused(): boolean {
    return this.paused
  }

  /**
   * 冻结 = 暂停或已卸载。**这是 sender 在队列执行点唯一能看见的"现在别发"**：
   * 候选与运行时事实里都没有"暂停"这一位（暂停不改账本），所以必须由装配方把这个
   * 谓词注入进去（`ContactSenderDeps.isFrozen`）。
   */
  get isFrozen(): boolean {
    return this.paused || this.stopped
  }

  /** 起表（`start` 钩子在 inbound 重挂之后执行）。 */
  start(): void {
    if (this.timer !== null) return
    const config = this.deps.config()
    this.timer = this.deps.clock.setInterval(() => { void this.tick(this.deps.clock.now()) }, config.pollIntervalMs)
    this.timer.unref?.()
    this.deps.log(`contact: worker started (every ${String(config.pollIntervalMs)}ms, enabled=${String(config.enabled)})`)
    // 启动即刻判一次：先把过期/超视界的候选标掉，再按 maxPerTick 一条一条来。
    void this.tick(this.deps.clock.now())
  }

  /** 暂停：停表 + 释放租约（不留后台任务，也不占着别的实例的位置）。 */
  pause(): void {
    this.paused = true
    this.pendingTickAt = null
    this.timer?.cancel()
    this.timer = null
    this.deps.log('contact: 已暂停（停表并释放租约）')
    void this.deps.store.releaseLease().catch((error: unknown) => {
      this.deps.log(`contact: 暂停时释放租约失败：${describe(error)}`)
    })
  }

  resume(): void {
    this.paused = false
    this.start()
  }

  /** 卸载顺序：停表 → 等在途发送到安全点（有界）→ 释放租约。 */
  async dispose(): Promise<void> {
    this.stopped = true
    this.timer?.cancel()
    this.timer = null
    const inflight = this.inflight
    if (inflight !== null) await boundedWait(this.deps.clock, this.deps.disposeWaitMs ?? 5_000, inflight)
    await this.deps.store.releaseLease().catch((error: unknown) => {
      this.deps.log(`contact: 卸载时释放租约失败：${describe(error)}`)
    })
  }

  /** 跑一轮。`now` 注入（测试推进假时钟即可精确复现）。 */
  async tick(now: number): Promise<void> {
    if (this.stopped) return
    if (this.busy) {
      // 不丢这一拍：记下来，等本轮收尾时补（见 pendingTickAt 的注记）。
      this.pendingTickAt = now
      this.deps.log('contact: 上一轮 tick 还在跑，这一拍排到本轮收尾之后')
      return
    }
    this.busy = true
    const run = this.runTick(now)
    this.inflight = run
    try {
      await run
    } catch (error) {
      this.deps.log(`contact: tick 失败：${describe(error)}`)
    } finally {
      this.busy = false
      if (this.inflight === run) this.inflight = null
      const pending = this.pendingTickAt
      this.pendingTickAt = null
      if (pending !== null && !this.paused && !this.stopped) void this.tick(this.deps.clock.now())
    }
  }

  private async runTick(now: number): Promise<void> {
    const config = this.deps.config()
    if (this.paused || !config.enabled) {
      // 关着/暂停时连租约都不该占：别的实例（或明天的自己）要能立刻接管。
      if (this.deps.store.lease !== null) await this.deps.store.releaseLease()
      return
    }
    const epoch = await this.ensureLease()
    if (epoch === null) return
    await this.deps.store.sweepInterrupted(now, epoch)
    await this.deps.store.rollDay(now, epoch)
    if (this.deps.sourceCandidates !== undefined) {
      await this.deps.sourceCandidates().catch((error: unknown) => {
        this.deps.log(`contact: 候选来源失败：${describe(error)}`)
      })
    }
    await settleStreaks(this.transitions, now, epoch)
    await expireStale(this.transitions, now, epoch, config)
    await capCandidates(this.transitions, now, epoch, config)
    for (const candidate of this.pickDue(now, config)) {
      await this.consider(candidate, now, epoch, config).catch(async (error: unknown) => {
        this.deps.log(`contact: 候选 ${candidate.id} 处理失败：${describe(error)}`)
        await this.deps.store.noteReason(`${candidate.id} error:${describe(error)}`, now, epoch).catch(() => false)
      })
    }
    // 收尾钩子（点歌自主选歌）：放在最后，**尽力而为**——它花的是分钟级的钱
    // （下载 + 分离 + 推理），绝不能挡住或拖慢联系候选的投递。
    if (this.deps.afterTick !== undefined && !this.paused && !this.stopped) {
      await this.deps.afterTick(now).catch((error: unknown) => {
        this.deps.log(`contact: afterTick 失败：${describe(error)}`)
      })
    }
  }

  /** 取/续租约，返回当前代次。拿不到 = 另一个活着的实例在跑（多开时的正常状态）。 */
  private async ensureLease(): Promise<number | null> {
    const store = this.deps.store
    if (store.lease !== null) {
      if (await store.renewLease()) return store.lease?.epoch ?? null
      this.leaseLostNoted = false
    }
    let lease
    try {
      lease = await store.acquireLease()
    } catch (error) {
      // **不要把 IO 故障说成"多开"**：`LeaseCreateError` 的消息已经是"锁文件创建失败：
      // <code> <message>"。每拍都记（这是需要人看一眼的硬故障），但同一原因只记一次。
      if (!this.leaseErrorNoted) this.deps.log(`contact: ${describe(error)}`)
      this.leaseErrorNoted = true
      return null
    }
    if (lease !== null) {
      this.leaseErrorNoted = false
      this.leaseLostNoted = false
      return lease.epoch
    }
    if (!this.leaseLostNoted) {
      this.deps.log('contact: 租约在别的实例手里，本实例不推进（多开时的正常状态）')
      this.leaseLostNoted = true
    }
    return null
  }

  /** 本轮该看哪几条：到点、没过期、按优先级再按到期时间，最多 `maxPerTick` 条。 */
  private pickDue(now: number, config: ContactConfig): ContactCandidate[] {
    const live = this.deps.store.listCandidates().filter((row) =>
      (row.state === 'pending' || row.state === 'deferred') && row.earliestAt <= now && now < row.expiresAt)
    live.sort((a, b) => (a.priority - b.priority) || (a.earliestAt - b.earliestAt))
    return live.slice(0, Math.max(1, config.maxPerTick))
  }

  /** 一条候选：门控 → 发 / 缓 / 丢。 */
  private async consider(candidate: ContactCandidate, now: number, epoch: number, config: ContactConfig): Promise<void> {
    // **在动手之前再判一次开关**：从 `runTick` 开头到这里隔着取租约、清理、门控一长串
    // await，足够操作者在后台按一下暂停。冻结之后不该再为这条候选建投递行、花模型钱、
    // 更不该发出去；不入账也不留痕（下一轮从账本现状重新判）。
    if (this.stopped || this.paused) {
      this.deps.log(`contact: 已暂停/卸载，候选 ${candidate.id} 本轮不动`)
      return
    }
    const runtime = this.runtimeOf(candidate)
    const decision = evaluateGate({
      candidate,
      now,
      config,
      counters: this.deps.store.state.counters,
      runtime,
      deliveryDedupeKeys: this.deps.store.deliveredDedupeKeys(),
    })
    if (decision.verdict === 'send') {
      await attemptSend(this.attempt, candidate, now, epoch, config, runtime)
      return
    }
    if (decision.verdict === 'drop') {
      await dropCandidate(this.transitions, candidate, decision.reason, now, epoch)
      return
    }
    await deferCandidate(this.transitions, candidate, decision.reason satisfies GateReason, now, epoch)
  }

  /** 组装门控要的运行时事实（只填这条候选关心的那个房间，避免整表快照）。 */
  private runtimeOf(candidate: ContactCandidate): ContactRuntimeFacts {
    const room = candidate.target.room
    const facts = this.deps.roomFacts(room)
    return {
      connected: facts.connected,
      roomBound: facts.roomBound,
      turnRunningByRoom: { [room]: facts.turnRunning },
      toolRunning: this.deps.toolRunning?.() ?? false,
      lastUserMessageAtByRoom: { [room]: facts.lastUserMessageAt },
      // 秒级时间戳之外的第二个游标（同秒消息靠它才拦得住，Codex P1/R5）。
      queueDepthByRoom: { [room]: facts.queueDepth ?? null },
      deliveredDedupeKeys: this.deps.store.deliveredDedupeKeys(),
    }
  }


  /** 清掉很旧的终态投递（保留 30 天；`running` 永远不删）。时间走注入的时钟。 */
  async prune(): Promise<number> {
    try {
      return await pruneOldDeliveries(this.deps.store, this.deps.clock.now() - RETENTION_MS)
    } catch (error) {
      if (error instanceof StaleLeaseError) return 0
      this.deps.log(`contact: 清理旧投递失败：${describe(error)}`)
      return 0
    }
  }
}
