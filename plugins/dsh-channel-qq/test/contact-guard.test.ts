/** **队列执行点**与**异常分类**的回归：Codex 验收阻断项 1、2 的取证。
 *
 * 这个文件里的用例全部是"**修复前会红**"的形状——它们断言的是契约，而不是现状：
 *
 *   1. **队列等待期不许绕过复核**：`out.push(() => api.sendTo(...))` 之后、callback 真正
 *      执行之前，是一段真实存在的时间窗（真实队列会先等 `rateLimitMs`）。这段时间里
 *      世界会变：用户刚说话、候选被取消、实例被暂停、租约被接管。修复前的实现只在
 *      `deliver()` 开头复核一次，于是这四种情形都会**照样发出去并记 `confirmed`**。
 *      修复要求：复核必须在 **callback 内**再跑一次（可观察证据：`refresh` 被调用
 *      ≥ 2 次，且第二次发生在 callback 真正执行之后）。
 *
 *   2. **异常必须分流**：`ECONNRESET`/`EPIPE`/`ETIMEDOUT`/未知异常 = **回执未知**
 *      （`unknown`：不重试、不算"发成功"、但额度已经花掉）；只有平台**明确拒绝**
 *      （响应带 `retcode !== 0` / `status: 'failed'`）才是 `failed`（可重试）。
 *      修复前的实现把除"自己造的超时"之外的一切异常都判成 `failed`，于是
 *      `ECONNRESET` 会被 `afterSend` 当成可重试 → **重复外发**。
 *
 *   3. **超时必须作废队列里那次任务**：`unknown` 之后如果队列里的 callback 还能真的
 *      发出去，那账本说"不知道"、用户却收到了一条——比漏发更糟。
 *
 * 纪律：不读源码、不 mock 私有方法，只通过注入的依赖（`refresh` / `isFrozen` /
 * 假出站链 / 假平台）控制"callback 执行那一刻的事实"。时间用 `FakeClock` 推进，
 * 等队列放行用 `waitUntil`（真实定时器，不用 `setImmediate` 轮询）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import * as path from 'node:path'
import type { ContactConfig } from '../src/config/sections/contact.js'
import type {
  ContactCandidate, ContactDelivery, ContactRuntimeFacts,
} from '../src/features/contact/types.js'
import {
  FakeClock, FakeOutboundQueue, FakePlatform, contactCandidate, contactDelivery, contactRuntime,
  fieldDefaults, nodeError, oneBotReject, tempHome, waitUntil, type TempHome,
} from './fakes/contact.js'

const { CONTACT_GROUPS } = await import('../src/config/sections/contact.js')
const senderModule = await import('../src/features/contact/sender.js')
const { ContactSender } = senderModule
const { ContactStore } = await import('../src/features/contact/store.js')

// ── 脚手架 ──────────────────────────────────────────────────────────────────

const START = Date.UTC(2026, 9, 16, 22, 0, 0)

function config(over: Partial<ContactConfig> = {}): ContactConfig {
  return {
    ...(fieldDefaults(CONTACT_GROUPS) as unknown as ContactConfig),
    enabled: true,
    dryRun: false,
    allowExternalSend: true,
    sendMode: 'direct',
    timezone: 'Asia/Shanghai',
    quietHours: [],
    draftModel: true,
    ...over,
  }
}

/** 一个可变世界：测试改它就等于"窗口期内事情发生了"。 */
interface World {
  candidateState: ContactCandidate['state']
  connected: boolean
  roomBound: boolean
  turnRunning: boolean
  lastUserMessageAt: number | null
  /** 暂停/卸载/租约易主的统一表达（实现侧应把三者都折进这个谓词）。 */
  frozen: boolean
}

interface GuardRig {
  sender: InstanceType<typeof ContactSender>
  platform: FakePlatform
  queue: FakeOutboundQueue
  clock: FakeClock
  logs: string[]
  world: World
  /** `refresh` 被调用了几次（"callback 内复核过没有"的可观察证据）。 */
  readonly refreshCalls: () => number
  /** 每次 `refresh` 调用时的世界快照（用来断言"第二次读发生在世界变了之后"）。 */
  readonly refreshTrace: Array<{ at: number; lastUserMessageAt: number | null; candidateState: string }>
  /** 发起一次投递（不 await：队列可能挂住它）。 */
  deliver(over?: Partial<ContactDelivery> & { text?: string }): Promise<{ state: string; detail: string; attempted: boolean }>
  runtime(): ContactRuntimeFacts
}

function makeGuardRig(options: { world?: Partial<World> } = {}): GuardRig {
  const clock = new FakeClock(START)
  const platform = new FakePlatform({ clock })
  const queue = new FakeOutboundQueue()
  const logs: string[] = []
  const world: World = {
    candidateState: 'pending',
    connected: true,
    roomBound: true,
    turnRunning: false,
    lastUserMessageAt: null,
    frozen: false,
    ...options.world,
  }
  let refreshCalls = 0
  const refreshTrace: GuardRig['refreshTrace'] = []

  const runtime = (): ContactRuntimeFacts => contactRuntime({
    connected: world.connected,
    roomBound: world.roomBound,
    turnRunningByRoom: { 'dm-10001': world.turnRunning },
    lastUserMessageAtByRoom: { 'dm-10001': world.lastUserMessageAt },
  })

  const deps: Record<string, unknown> = {
    log: (line: string) => { logs.push(line) },
    clock,
    transport: () => ({
      connected: world.connected,
      out: queue,
      api: platform.api,
    }),
    turns: () => ({ bookPrompt: async () => true }),
    identity: () => ({ personaId: 'nono', worldId: '' }),
    // 现取：每次调用都读**当前**世界（这正是"复核"的意义）。
    refresh: (candidateId: string) => {
      refreshCalls += 1
      const candidate = contactCandidate({ id: candidateId, state: world.candidateState })
      const facts = runtime()
      refreshTrace.push({
        at: clock.now(),
        lastUserMessageAt: world.lastUserMessageAt,
        candidateState: world.candidateState,
      })
      return { candidate, runtime: facts }
    },
    timeoutMs: 30_000,
    // 与 `AttemptDeps.isFrozen` 同名；暂停/卸载/租约易主都折进这一个谓词。
    isFrozen: () => world.frozen,
  }

  const sender = new ContactSender(deps as never)

  const rig: GuardRig = {
    sender, platform, queue, clock, logs, world, refreshTrace,
    refreshCalls: () => refreshCalls,
    runtime,
    deliver: async (over = {}) => {
      const now = clock.now()
      const delivery: ContactDelivery = {
        ...contactDelivery({ candidateId: 'c-guard', text: '在吗' }),
        ...over,
      }
      const candidate = contactCandidate({ id: delivery.candidateId, state: world.candidateState })
      const result = await sender.deliver({
        delivery,
        candidate,
        text: over.text ?? '在吗',
        now,
        runtime: runtime(),
      }, config())
      return { state: result.state, detail: result.detail, attempted: result.attempted }
    },
  }
  return rig
}

/**
 * 把一次投递推进到"已入队、callback 还挂着"的状态。
 *
 * 返回值用对象包一层而不是直接返回那个 promise：`async` 函数的返回值会被**扁平化**，
 * `return pending` 会让 `await holdInQueue(rig)` 一路等到投递结算——而队列正被握着，
 * 于是测试自己把自己锁死（这个坑我踩过一次，写在这里免得下一个人再踩）。
 */
async function holdInQueue(
  rig: GuardRig,
): Promise<{ pending: Promise<{ state: string; detail: string; attempted: boolean }> }> {
  rig.queue.hold = true
  const pending = rig.deliver()
  await waitUntil(() => rig.queue.pending() === 1, 2_000)
  return { pending }
}

/**
 * 用"松散 deps"造一个 sender：R2–R5 这几条要注入可选的执行点守卫（verifyOwnership /
 * liveFacts / config），所以这里绕开 excess-property 检查，而不是把断言删掉。
 */
function makeLooseSender(deps: Record<string, unknown>): InstanceType<typeof ContactSender> {
  const Ctor = senderModule.ContactSender as unknown as new (deps: Record<string, unknown>) => InstanceType<typeof ContactSender>
  return new Ctor(deps)
}

const NO_SEND = (rig: { platform: FakePlatform }): void => {
  assert.equal(rig.platform.count(), 0, '队列等待期世界变了，这一次绝不该真的调 sendTo')
  assert.equal(rig.platform.attempts.length, 0, '连一次端口调用都不该发生（attempts 是含失败在内的全量账）')
}

// ── Q01–Q04：队列执行点的四种情形（修复前全部会红） ────────────────────────

test('Q01 队列等待期用户开始说话 → 零 sendTo，结算 deferred（修复前：照样发 + confirmed）', async () => {
  const rig = makeGuardRig()
  try {
    const { pending } = await holdInQueue(rig)

    // 窗口期内：用户刚说了一句话（settle 窗口内）
    rig.world.lastUserMessageAt = rig.clock.now()
    await rig.queue.release()

    const result = await pending
    NO_SEND(rig)
    assert.equal(result.state, 'deferred', `应当是"下一轮再说"，实际 ${result.state}/${result.detail}`)
    assert.equal(result.attempted, false, 'attemped=false 的含义是"没调用过平台"，这次确实没调')
  } finally {
    rig.queue.hold = false
  }
})

test('Q02 队列等待期候选被取消 → 零 sendTo，结算 cancelled（修复前：照样发 + confirmed）', async () => {
  const rig = makeGuardRig()
  try {
    const { pending } = await holdInQueue(rig)

    rig.world.candidateState = 'cancelled'
    await rig.queue.release()

    const result = await pending
    NO_SEND(rig)
    assert.equal(result.state, 'cancelled', `取消之后不该再发（也不是 failed），实际 ${result.state}/${result.detail}`)
    assert.equal(result.attempted, false)
  } finally {
    rig.queue.hold = false
  }
})

test('Q03 队列等待期实例被暂停 → 零 sendTo，结算 deferred（修复前：照样发 + confirmed）', async () => {
  const rig = makeGuardRig()
  try {
    const { pending } = await holdInQueue(rig)

    // 操作者按了暂停：worker 会置 paused 并把这件事折进 isFrozen
    rig.world.frozen = true
    await rig.queue.release()

    const result = await pending
    NO_SEND(rig)
    assert.equal(result.state, 'deferred', `暂停期间不许外发，实际 ${result.state}/${result.detail}`)
    assert.equal(result.attempted, false)
  } finally {
    rig.queue.hold = false
  }
})

test('Q04 队列等待期**真实租约被接管** → 零 sendTo（真实 store + 真实锁文件，F2）', async () => {
  // Codex 对上一版 Q04 的判断是对的：手动把 `world.frozen` 置真只是**重复测了冻结**，
  // 既不经过 `ContactStore`/`LeaseKeeper`，也没有 `leaseEpoch`，所以根本证明不了
  // "外部接管之后旧实例被拦住"。这一版用具名事实：真锁文件 + 租约过期 + 另一个实例接管。
  const rig = makeStoreRig()
  try {
    const { pending } = await holdInStoreQueue(rig)

    // 1) 本实例的租约到期；2) 另一个实例（不同 hostId/pid）接管，epoch 变成 2
    rig.clock.advance(rig.leaseTtlMs + 1_000)
    const takenOver = await rig.takeover()
    assert.notEqual(takenOver, null, '第二个实例必须能接管（否则这条测试就是空转）')
    assert.notEqual(takenOver!.epoch, rig.epoch(), '接管之后代次必须不同')
    // 关键事实：**内存里的 epoch 还是老的**——这正是 F2 说的"只看内存看不出来"
    assert.equal(rig.epoch(), 1, '旧实例内存里的 epoch 不会自己变（所以要读盘）')

    await rig.queue.release()
    const result = await pending
    NO_SEND(rig)
    assert.ok(
      result.state === 'deferred' || result.state === 'cancelled',
      `租约被接管后本实例不该再发，实际 ${result.state}/${result.detail}`,
    )
    assert.notEqual(result.state, 'confirmed')
    // 细节串会随实现的两条判据而变：先读盘判定时可能是 `delivery:unknown`
    // （接管方在恢复遗留的 `running` 行时把它归约成 unknown —— 这也是一种"发不出去"），
    // 先断言租约时是 `lease-lost`。两者都指向所有权，**真正要钉的是"零 sendTo"**。
    assert.match(result.detail, /lease|ownership|stale|delivery:/i, `detail 要能看出是所有权问题，实际 ${result.detail}`)
  } finally {
    await rig.dispose()
  }
})

test('Q04b（对照）租约**没**被接管时同样条件下照常发一条——证明拦住它的是接管，不是别的', async () => {
  const rig = makeStoreRig()
  try {
    const { pending } = await holdInStoreQueue(rig)
    // 只推进时间但不让任何人接管：租约自己续上（本实例每拍续期）
    rig.clock.advance(1_000)
    await rig.renew()
    await rig.queue.release()
    const result = await pending
    assert.equal(result.state, 'confirmed', `续期成功时不该被拦，实际 ${result.state}/${result.detail}`)
    assert.equal(rig.platform.count(), 1)
  } finally {
    await rig.dispose()
  }
})

test('Q06 免打扰边界：22:59:55 入队 → 23:00:05 执行 → 零 sendTo（F3，修复前会 confirmed）', async () => {
  // Asia/Shanghai 22:59:55 = UTC 14:59:55
  const rig = makeStoreRig({
    start: Date.UTC(2026, 9, 16, 14, 59, 55),
    config: { quietHours: [{ from: '23:00', to: '08:00' }], timezone: 'Asia/Shanghai' },
  })
  try {
    const { pending } = await holdInStoreQueue(rig)
    // 队列等待期间跨进了免打扰
    rig.clock.advance(10_000) // → 23:00:05
    await rig.queue.release()
    const result = await pending
    NO_SEND(rig)
    assert.equal(
      result.state, 'deferred',
      `跨进免打扰之后必须停下（deferred 而不是 confirmed），实际 ${result.state}/${result.detail}`,
    )
    assert.equal(result.attempted, false, '没出网就不该记成尝试过')
    assert.match(result.detail, /quiet-hours/, `detail 要指向免打扰，实际 ${result.detail}`)
  } finally {
    await rig.dispose()
  }
})

test('Q07 排队期间后台把开关关掉 → 执行点用**当前**配置重判，零 sendTo（F3）', async () => {
  const rig = makeStoreRig()
  try {
    const { pending } = await holdInStoreQueue(rig)
    // 操作者在窗口期把总开关关了（配置是活对象：执行点必须现取，不能用入队时的快照）
    rig.setConfig({ enabled: false })
    await rig.queue.release()
    const result = await pending
    NO_SEND(rig)
    assert.notEqual(result.state, 'confirmed')
    assert.match(result.detail, /disabled|enabled|paused/i, `detail 要指向开关，实际 ${result.detail}`)
  } finally {
    await rig.dispose()
  }
})

test('Q05 复核必须在队列 callback 内再跑一次（refresh 调用 ≥2 次，且第二次晚于 callback 启动）', async () => {
  const rig = makeGuardRig()
  try {
    const { pending } = await holdInQueue(rig)
    const callsWhileQueued = rig.refreshCalls()
    assert.equal(callsWhileQueued, 1, '进队列之前应当只复核过一次（这是现状，不是要求）')

    rig.world.lastUserMessageAt = rig.clock.now()
    const tracedBefore = rig.refreshTrace.length
    await rig.queue.release()
    await pending

    assert.ok(
      rig.refreshCalls() > tracedBefore,
      `callback 内没有再读一次事实（refresh 调用数停在 ${String(rig.refreshCalls())}）——`
      + '这就是"决策与执行之间没有复核"的直接证据',
    )
  } finally {
    rig.queue.hold = false
  }
})

// ── 真 store 版 rig：租约/门控都走真实实现（F2/F3 的取证基础） ──────────────

interface StoreRig {
  sender: InstanceType<typeof ContactSender>
  store: InstanceType<typeof ContactStore>
  platform: FakePlatform
  queue: FakeOutboundQueue
  clock: FakeClock
  logs: string[]
  home: TempHome
  leaseTtlMs: number
  readonly epoch: () => number | null
  /** 另一个实例接管租约（不同 hostId/pid），返回它拿到的租约。 */
  takeover(): Promise<{ epoch: number } | null>
  /** 本实例续期。 */
  renew(): Promise<void>
  /** 运行期改配置（模拟"操作者在后台改了开关"）。 */
  setConfig(over: Partial<ContactConfig>): void
  /**
   * **在最后一轮 I/O（`liveFacts`）里执行一次**：F41/F42 的注入点。
   *
   * 为什么要这个缝：修复前 `verifyOwnership` 只在读盘**之前**跑一次，于是"读盘期间
   * 租约到期/跨进免打扰/开关被关/候选过期"全都拦不住。这个钩子就落在那个窗口里。
   */
  duringLiveFacts: (() => void | Promise<void>) | null
  /** `verifyOwnership` 被调用了几次（F41 要求 ≥2：读盘前 + 读盘后）。 */
  readonly ownershipCalls: () => number
  deliver(): Promise<{ state: string; detail: string; attempted: boolean }>
  dispose(): Promise<void>
}

function makeStoreRig(
  options: { start?: number; config?: Partial<ContactConfig> } = {},
): StoreRig {
  const home = tempHome('qq-contact-store-rig-')
  const clock = new FakeClock(options.start ?? START)
  const platform = new FakePlatform({ clock })
  const queue = new FakeOutboundQueue()
  const logs: string[] = []
  const leaseTtlMs = 180_000
  const dir = path.join(home.dir, 'channel-qq')
  mkdirSync(dir, { recursive: true })
  const files = { ledger: path.join(dir, 'contact.json'), lock: path.join(dir, 'contact.lock') }
  const store = new ContactStore({
    file: files.ledger,
    lockFile: files.lock,
    hostId: 'host-a',
    pid: 1001,
    log: (line: string) => { logs.push(line) },
    clock,
    leaseTtlMs,
    dayKey: () => '2026-10-17',
  })
  let cfg: ContactConfig = config(options.config ?? {})
  const candidateId = 'c-exec'
  const room = 'dm-10001'
  let ownershipCalls = 0
  // `rig` 在 deps 之后才构造，用一个可变槽让 `liveFacts` 能引用它（F41/F42 的注入点）。
  const rigRef: { duringLiveFacts: (() => void | Promise<void>) | null } = { duringLiveFacts: null }
  const runtime = (): ContactRuntimeFacts => contactRuntime({
    deliveredDedupeKeys: [],
    lastUserMessageAtByRoom: { [room]: null },
    turnRunningByRoom: { [room]: false },
  })

  // 与 `index.ts` 的装配同形：所有权校验读锁文件、门控重跑用盘上快照 + 当前配置。
  const deps: Record<string, unknown> = {
    log: (line: string) => { logs.push(line) },
    clock,
    transport: () => ({ connected: true, out: queue, api: platform.api }),
    turns: () => ({ bookPrompt: async () => true }),
    identity: () => ({ personaId: 'nono', worldId: '' }),
    refresh: (id: string) => ({ candidate: store.candidate(id), runtime: runtime() }),
    isFrozen: () => store.lease === null,
    leaseEpoch: () => store.lease?.epoch ?? null,
    // **与生产同形的 `liveSnapshot`（F41 的契约）**：一次调用里"先读盘 → 用这份快照判
    // → **最后** `assertLease(epoch)`"。Codex 第四轮 P2 点名过我上一版的两个毛病：
    // ① 复制了一份宽松守卫（只判"行存在且 running"，漏 id/epoch/leaseOwner）；
    // ② 用 `verifyOwnership` + `liveFacts` 两段拼，两段各自读盘 → 判据与事实不同源。
    // 现在按契约只走一次读盘，最后那个 `assertLease` 是这次调用里的**最后一个 await**。
    liveSnapshot: async (delivery: ContactDelivery) => {
      ownershipCalls += 1
      const snapshot = await store.snapshot()
      const facts = {
        candidate: snapshot.candidates[delivery.candidateId],
        counters: snapshot.counters,
        deliveredDedupeKeys: Object.values(snapshot.outbox)
          .filter((row) => row.state === 'submitted' || row.state === 'confirmed' || row.state === 'unknown')
          .map((row) => row.dedupeKey),
        runtime: runtime(),
      }
      // 盘上判定（与 `index.ts` 的 `ownershipOf` 逐字同形）
      const candidate = facts.candidate
      if (candidate === undefined) return { verdict: { state: 'cancelled', detail: 'candidate:missing' }, facts }
      if (candidate.state !== 'pending' && candidate.state !== 'deferred') {
        return { verdict: { state: 'cancelled', detail: `candidate:${candidate.state}` }, facts }
      }
      const row = snapshot.outbox[delivery.id]
      if (row === undefined) return { verdict: { state: 'cancelled', detail: 'delivery:missing' }, facts }
      if (row.id !== delivery.id) return { verdict: { state: 'cancelled', detail: 'delivery:id-mismatch' }, facts }
      if (row.state !== 'running') return { verdict: { state: 'deferred', detail: `delivery:${row.state}` }, facts }
      if (row.epoch !== delivery.epoch) return { verdict: { state: 'deferred', detail: 'delivery:epoch-mismatch' }, facts }
      if (row.leaseOwner !== delivery.leaseOwner) return { verdict: { state: 'deferred', detail: 'delivery:owner-mismatch' }, facts }

      // F41/F42 的注入点：**最后一轮 I/O 期间**世界可以变（租约到期、跨进免打扰、
      // 开关被关、候选过期）。测试通过 `rig.duringLiveFacts` 在这个窗口里动手。
      // 允许返回 Promise 并在这里 await：改账本本身是异步的，不 await 就会变成
      // "测试以为改了、守卫读到的还是旧值"（F42③ 第一版就踩了这个）。
      if (rigRef.duringLiveFacts !== null) await rigRef.duringLiveFacts()

      // 顺序契约的最后一步：**这次调用里最后一个 await** 才是租约断言。
      if (!(await store.assertLease(delivery.epoch))) {
        logs.push(`contact: 投递 ${delivery.id} 的租约已失效（epoch=${String(delivery.epoch)}），不发`)
        return { verdict: { state: 'deferred', detail: 'lease-lost' }, facts }
      }
      return { verdict: null, facts }
    },
    config: () => cfg,
    // 故意放大：这条 rig 要在"队列等待期间"把假时钟推进到租约过期（180s+），
    // 用默认的 30s 发送超时会让用例先撞上 `unknown/timeout`，测不到租约那件事。
    timeoutMs: 600_000,
  }
  const sender = new ContactSender(deps as never)

  const rig: StoreRig = {
    sender, store, platform, queue, clock, logs, home, leaseTtlMs,
    epoch: () => store.lease?.epoch ?? null,
    takeover: async () => {
      // 过期之后**另一个进程**（不同 hostId/pid）抢锁：`wx` 会失败 → 走 steal → epoch+1
      const other = new ContactStore({
        file: files.ledger,
        lockFile: files.lock,
        hostId: 'host-b',
        pid: 2002,
        log: (line: string) => { logs.push(`[B] ${line}`) },
        clock,
        leaseTtlMs,
        dayKey: () => '2026-10-17',
      })
      const lease = await other.acquireLease()
      return lease === null ? null : { epoch: lease.epoch }
    },
    renew: async () => { await store.renewLease() },
    setConfig: (over) => { cfg = { ...cfg, ...over } },
    get duringLiveFacts() { return rigRef.duringLiveFacts },
    set duringLiveFacts(next) { rigRef.duringLiveFacts = next },
    ownershipCalls: () => ownershipCalls,
    deliver: async () => {
      const now = clock.now()
      // **id 必须与 `holdInStoreQueue` 领取的那一条一致**（Codex 第四轮 P2 点名的缺口：
      // 之前这里用工厂默认 `d-1`，而领取的是 `d-c-exec` → ownership 查的是一条不存在的行）。
      const delivery: ContactDelivery = contactDelivery({
        id: CLAIMED_DELIVERY_ID, candidateId, dedupeKey: 'k-exec', text: '在吗',
        epoch: store.lease?.epoch ?? 0, leaseOwner: ownerOf(store), mode: 'direct',
      })
      const candidate = contactCandidate({
        id: candidateId, state: 'pending',
        earliestAt: now - 60_000, expiresAt: now + 6 * 3_600_000, createdAt: now - 60_000,
      })
      const result = await sender.deliver({ delivery, candidate, text: '在吗', now, runtime: runtime() }, cfg)
      return { state: result.state, detail: result.detail, attempted: result.attempted }
    },
    dispose: async () => {
      await store.releaseLease().catch(() => {})
      home.cleanup()
    },
  }
  return rig
}

/**
 * 真 store 版"推进到已入队、callback 还挂着"。
 *
 * 与轻量版不同的是：候选与投递都真的写进账本（`putCandidate` + `claimDelivery`），
 * 否则 `verifyOwnership` 读盘只会看到 `candidate:missing`，测不出租约问题。
 *
 * **投递 id 与 `rig.deliver()` 用的必须是同一个常量**（`CLAIMED_DELIVERY_ID`）：
 * 两边不一致时 ownership 查的是一条不存在的行，用例会"看起来通过"却什么都没验证。
 */
const CLAIMED_DELIVERY_ID = 'd-c-exec'

/** 领取者的身份串（与 `store.claimDelivery` 写入 `leaseOwner` 的格式一致）。 */
function ownerOf(store: InstanceType<typeof ContactStore>): string {
  const row = store.listDeliveries().find((item) => item.id === CLAIMED_DELIVERY_ID)
  return row?.leaseOwner ?? ''
}

async function holdInStoreQueue(
  rig: StoreRig,
  over: { expiresAt?: number } = {},
): Promise<{ pending: Promise<{ state: string; detail: string; attempted: boolean }> }> {
  const now = rig.clock.now()
  const lease = await rig.store.acquireLease()
  assert.notEqual(lease, null, '前置：本实例要先拿到租约')
  const candidate = contactCandidate({
    id: 'c-exec',
    state: 'pending',
    earliestAt: now - 60_000,
    expiresAt: over.expiresAt ?? now + 6 * 3_600_000,
    createdAt: now - 60_000,
    dedupeKey: 'k-exec',
  })
  await rig.store.putCandidate(candidate)
  const delivery: ContactDelivery = contactDelivery({
    id: CLAIMED_DELIVERY_ID,
    candidateId: 'c-exec',
    dedupeKey: 'k-exec',
    text: '在吗',
    mode: 'direct',
  })
  const claimed = await rig.store.claimDelivery(delivery, lease!.epoch)
  assert.equal(claimed, true, '前置：投递要真的被领到（running 落盘），否则后面测的不是同一条路')

  rig.queue.hold = true
  const pending = rig.deliver()
  await waitUntil(() => rig.queue.pending() === 1, 2_000)
  return { pending }
}

// ── E01–E06：异常矩阵（修复前：只有自建超时是 unknown，其余全判 failed） ──────

for (const code of ['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN']) {
  test(`E01 网络异常 ${code} → unknown（回执未知，不重试、不算发成功）`, async () => {
    const rig = makeGuardRig()
    try {
      rig.platform.failWithError = nodeError(code)
      const result = await rig.deliver()
      assert.equal(
        result.state, 'unknown',
        `${code} 是"可能已经发出去了"的一类，判成 ${result.state} 会让 afterSend 重试并重复外发`,
      )
      assert.equal(result.attempted, true, '确实尝试过（额度已经花掉），只是结果未知')
      assert.equal(rig.platform.attempts.length, 1, '尝试记录应当留痕')
      assert.equal(rig.platform.count(), 0, '没有任何一条被记成"发出去"')
    } finally {
      rig.queue.hold = false
    }
  })
}

test('E02 未知/无 code 的异常 → unknown（不确定就说不确定，不要猜成 failed）', async () => {
  const rig = makeGuardRig()
  try {
    rig.platform.failWithError = new Error('something exploded')
    const result = await rig.deliver()
    assert.equal(result.state, 'unknown', `没有可判别的 code 时应当保守判未知，实际 ${result.state}/${result.detail}`)
  } finally {
    rig.queue.hold = false
  }
})

test('E03 平台明确拒绝（retcode/status=failed）→ failed（这条可以重试）', async () => {
  const rig = makeGuardRig()
  try {
    rig.platform.failWithError = oneBotReject(100, 'failed')
    const result = await rig.deliver()
    assert.equal(result.state, 'failed', `明确的业务拒绝才可以重试，实际 ${result.state}/${result.detail}`)
    assert.equal(result.attempted, true)
  } finally {
    rig.queue.hold = false
  }
})

test('E04 自建超时 → unknown，且**队列里那次任务作废**（放行之后也不许真的发出去）', async () => {
  const rig = makeGuardRig()
  try {
    const { pending } = await holdInQueue(rig)
    // 30 秒没回执：判定"回执未知"
    rig.clock.advance(30_001)
    const result = await pending
    assert.equal(result.state, 'unknown', `超时应当是 unknown，实际 ${result.state}/${result.detail}`)

    // 关键：队列里那次 callback 还挂着。放行之后它若真的调用 sendTo，
    // 账本说"不知道"、用户却收到一条——比漏发更糟。
    await rig.queue.release()
    NO_SEND(rig)
  } finally {
    rig.queue.hold = false
  }
})

test('E05 分类是纯函数：classifySendError 不依赖注入、同输入同输出', async () => {
  const classify = (senderModule as unknown as {
    classifySendError?: (error: unknown) => { state: string; detail: string } | undefined
  }).classifySendError
  assert.equal(typeof classify, 'function', 'sender.ts 应当导出 classifySendError（异常分流是纯函数，别再长回 if/else 里）')
  const cases: Array<[unknown, string]> = [
    [nodeError('ECONNRESET'), 'unknown'],
    [nodeError('EPIPE'), 'unknown'],
    [nodeError('ETIMEDOUT'), 'unknown'],
    [new Error('???'), 'unknown'],
    [oneBotReject(), 'failed'],
  ]
  for (const [error, expected] of cases) {
    const first = classify!(error)
    const second = classify!(error)
    assert.equal(first?.state, expected, `${String((error as { code?: string }).code ?? 'unknown')} 应当判 ${expected}`)
    assert.deepEqual(second, first, '纯函数：同一输入两次结论必须一致')
  }
})

test('E06 真实 OneBot 失败帧：适配层必须保留 retcode/status，整条链路才判 failed（F4）', async () => {
  // Codex 的判断：E03 只是手搓了一个"分类器期望的输入"，没走真实解码器。
  // 真实路径是 OneBotClient 收到 `{status:'failed', retcode:1200}` → 它 reject 的错误
  // 如果只是个普通 Error（丢了码），分类器只能判 unknown → 明确拒绝被当成"可能发出去了"，
  // 白耗一次候选与额度，而且永不重试。
  const { OneBotClient } = await import('../src/onebot.js')
  const logs: string[] = []
  const client = new OneBotClient({ mode: 'forward', url: 'ws://127.0.0.1:1' }, undefined, (line) => { logs.push(line) })
  type Entry = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: unknown }
  const internals = client as unknown as { pending: Map<string, Entry>; handleFrame(raw: string): void }
  const echo = 'dsh-qq-f4'
  const rejected = new Promise<Error>((resolve) => {
    internals.pending.set(echo, {
      resolve: () => { resolve(new Error('不该 resolve：这是一个失败帧')) },
      reject: (error) => { resolve(error) },
      timer: null,
    })
  })
  internals.handleFrame(JSON.stringify({ status: 'failed', retcode: 1200, msg: 'mock refusal', echo }))
  const error = await rejected

  // 1) 适配层：结构必须在（这是 F4 的核心断言）
  const shaped = error as Error & { status?: string; retcode?: number; msg?: string }
  assert.equal(shaped.retcode, 1200, `适配层把 retcode 丢了（实际 message=${error.message}）——分类器只能判 unknown`)
  assert.equal(shaped.status, 'failed', '适配层还要保留 status，才能分辨"明确拒绝"与"连接断了"')

  // 2) 整条链路：用这个真实的错误去发一次，必须判 failed（而不是 unknown）
  const rig = makeGuardRig()
  try {
    rig.platform.failWithError = error
    const result = await rig.deliver()
    assert.equal(result.state, 'failed', `真实失败帧走完整链路应当判 failed，实际 ${result.state}/${result.detail}`)
    assert.equal(result.attempted, true)
  } finally {
    rig.queue.hold = false
  }
})

// ══ 第四轮：R2–R7（第三轮 Codex 新增的 P1/P2） ══════════════════════════════

test('R2 turn 模式也必须过执行点守卫：租约已失 → bookPrompt 0 次（修复前 submitted + 1 次）', async () => {
  // Codex 实测：修复前 `sendTurn` 只在 `bookPrompt` 前做一次粗筛，**没有**走
  // ownership/liveFacts/evaluateGate，于是"租约已经丢了"照样把提示词塞进会话
  // （submitted），而 `verifyOwnership` 一次都没被调用。
  const rig = makeGuardRig({ world: {} })
  let verifyCalls = 0
  const sender = makeLooseSender({
    log: () => {},
    clock: rig.clock,
    transport: () => ({ connected: true, out: rig.queue, api: rig.platform.api }),
    turns: () => ({ bookPrompt: async () => { throw new Error('不该走到这里：业务上必须被守卫拦下') } }),
    identity: () => ({ personaId: 'nono', worldId: '' }),
    refresh: () => ({ candidate: contactCandidate({ id: 'c-r2', state: 'pending' }), runtime: contactRuntime({}) }),
    verifyOwnership: async () => { verifyCalls += 1; return { state: 'deferred', detail: 'lease-lost' } },
    timeoutMs: 30_000,
  })
  const delivery: ContactDelivery = contactDelivery({ candidateId: 'c-r2', text: '在吗', mode: 'turn' })
  const result = await sender.deliver({
    delivery,
    candidate: contactCandidate({ id: 'c-r2', state: 'pending' }),
    text: '在吗',
    now: rig.clock.now(),
    runtime: contactRuntime({}),
  }, config({ sendMode: 'turn' }))

  assert.equal(verifyCalls, 1, 'R2：turn 模式必须调用一次执行点所有权校验（修复前 0 次）')
  assert.notEqual(result.state, 'submitted', `R2：租约丢了就不许提交，实际 ${result.state}/${result.detail}`)
  assert.equal(result.state, 'deferred')
  assert.match(result.detail, /lease/)
  rig.queue.hold = false
})

test('R4 盘上已有**另一条**同 dedupeKey 的 confirmed 行 → 零 sendTo（修复前按 key 整批排除 → 照发）', async () => {
  // 修复前的写法是 `.filter(key => key !== delivery.dedupeKey)`：它把"自己这条"排掉，
  // 但同时把**别的**同键证据也排掉了 → 去重形同虚设。
  const rig = makeGuardRig()
  try {
    let liveFactsCalls = 0
    const sender = makeLooseSender({
      log: () => {},
      clock: rig.clock,
      transport: () => ({ connected: true, out: rig.queue, api: rig.platform.api }),
      turns: () => ({ bookPrompt: async () => true }),
      identity: () => ({ personaId: 'nono', worldId: '' }),
      refresh: () => ({ candidate: contactCandidate({ id: 'c-r4', state: 'pending' }), runtime: contactRuntime({}) }),
      liveFacts: async () => {
        liveFactsCalls += 1
        // 注意：`liveFacts` 里的 candidate 也要对齐假时钟，否则 `evaluateGate` 会先被
        // **补算视界**（`stale:restart`）拦下，断言就测不到去重那一步了。
        return {
          candidate: contactCandidate({
            id: 'c-r4', state: 'pending', dedupeKey: 'k-dup',
            earliestAt: rig.clock.now() - 60_000, expiresAt: rig.clock.now() + 6 * 3_600_000,
            createdAt: rig.clock.now() - 60_000,
          }),
          // 同一件事**已经**递出去过一次（另一条投递，状态 confirmed）
          deliveredDedupeKeys: ['k-dup'],
          counters: {
            day: '2026-10-17', sentTodayGlobal: 0, sentTodayByRoom: {}, lastSentAt: null, lastSentAtByRoom: {},
            unansweredStreakByRoom: {}, draftCallsToday: 0, lastDraftFailureAt: null, draftFailureStreak: 0,
          },
          runtime: contactRuntime({}),
        }
      },
      config: () => config(),
      timeoutMs: 30_000,
    })
    const now = rig.clock.now()
    const delivery: ContactDelivery = contactDelivery({
      candidateId: 'c-r4', dedupeKey: 'k-dup', text: '在吗', mode: 'direct',
      // 时间窗要对齐**假时钟**：用工厂默认值会落在 24h 之外 → 先被 `stale:restart` 拦下，
      // 于是这条用例就测不到去重了（我第一版就踩了这个，detail 打出来是 stale:restart）。
      createdAt: now - 60_000, updatedAt: now - 60_000,
    })
    const result = await sender.deliver({
      delivery,
      candidate: contactCandidate({
        id: 'c-r4', state: 'pending', dedupeKey: 'k-dup',
        earliestAt: now - 60_000, expiresAt: now + 6 * 3_600_000, createdAt: now - 60_000,
      }),
      text: '在吗',
      now: rig.clock.now(), runtime: contactRuntime({}),
    }, config())

    assert.equal(liveFactsCalls, 1, '执行点必须现取事实（否则这条测试没有意义）')
    assert.equal(rig.platform.count(), 0, 'R4：同一件事已经递出去过，就不许再发第二条')
    assert.notEqual(result.state, 'confirmed')
    assert.match(result.detail, /dedupe/, `detail 要指向去重，实际 ${result.detail}`)
  } finally {
    rig.queue.hold = false
  }
})

test('R3② 盘上快照里候选已不存在 → cancelled，**绝不回退内存里那条旧候选**', async () => {
  const rig = makeGuardRig()
  try {
    const sender = makeLooseSender({
      log: () => {},
      clock: rig.clock,
      transport: () => ({ connected: true, out: rig.queue, api: rig.platform.api }),
      turns: () => ({ bookPrompt: async () => true }),
      identity: () => ({ personaId: 'nono', worldId: '' }),
      // 内存里还"有"这条候选（旧快照），盘上已经没了
      refresh: () => ({ candidate: contactCandidate({ id: 'c-r3', state: 'pending' }), runtime: contactRuntime({}) }),
      liveFacts: async () => ({
        candidate: undefined,
        runtime: contactRuntime({}),
        counters: {
          day: '2026-10-17', sentTodayGlobal: 0, sentTodayByRoom: {}, lastSentAt: null, lastSentAtByRoom: {},
          unansweredStreakByRoom: {}, draftCallsToday: 0, lastDraftFailureAt: null, draftFailureStreak: 0,
        },
        deliveredDedupeKeys: [],
      }),
      config: () => config(),
      timeoutMs: 30_000,
    })
    const result = await sender.deliver({
      delivery: contactDelivery({ candidateId: 'c-r3', text: '在吗', mode: 'direct' }),
      candidate: contactCandidate({ id: 'c-r3', state: 'pending' }),
      text: '在吗', now: rig.clock.now(), runtime: contactRuntime({}),
    }, config())

    assert.equal(rig.platform.count(), 0, '盘上候选没了就不许发')
    assert.equal(result.state, 'cancelled', `R3②：应当是 cancelled（终态），实际 ${result.state}/${result.detail}`)
    assert.match(result.detail, /candidate/)
  } finally {
    rig.queue.hold = false
  }
})

test('R3① 所有权通过之后、快照阶段跨过发送截止 → 零 sendTo（异步空窗必须复查）', async () => {
  const rig = makeGuardRig()
  try {
    const sender = makeLooseSender({
      log: () => {}, clock: rig.clock,
      transport: () => ({ connected: true, out: rig.queue, api: rig.platform.api }),
      turns: () => ({ bookPrompt: async () => true }),
      identity: () => ({ personaId: 'nono', worldId: '' }),
      refresh: () => ({ candidate: contactCandidate({ id: 'c-r3a', state: 'pending' }), runtime: contactRuntime({}) }),
      verifyOwnership: async () => null, // 租约这一关过了
      liveFacts: async () => {
        // 快照是异步 I/O：等它回来的时候，发送窗口已经过去了
        rig.clock.advance(31_000)
        return {
          candidate: contactCandidate({ id: 'c-r3a', state: 'pending' }),
          runtime: contactRuntime({}),
          counters: {
            day: '2026-10-17', sentTodayGlobal: 0, sentTodayByRoom: {}, lastSentAt: null, lastSentAtByRoom: {},
            unansweredStreakByRoom: {}, draftCallsToday: 0, lastDraftFailureAt: null, draftFailureStreak: 0,
          },
          deliveredDedupeKeys: [],
        }
      },
      config: () => config(),
      timeoutMs: 30_000,
    })
    const result = await sender.deliver({
      delivery: contactDelivery({ candidateId: 'c-r3a', text: '在吗', mode: 'direct' }),
      candidate: contactCandidate({ id: 'c-r3a', state: 'pending' }),
      text: '在吗', now: rig.clock.now(), runtime: contactRuntime({}),
    }, config())

    assert.equal(rig.platform.count(), 0, 'R3①：快照期间跨过截止后必须停下')
    assert.notEqual(result.state, 'confirmed')
  } finally {
    rig.queue.hold = false
  }
})

test('R5 分类器只信任**带标记**的拒绝：`ECONNRESET + data.retcode=1200` → unknown（修复前 failed）', async () => {
  const classify = (senderModule as unknown as {
    classifySendError?: (error: unknown) => { state: string; kind: string }
  }).classifySendError
  assert.equal(typeof classify, 'function')

  // 1) 连接类错误 + 嵌套"看起来像拒绝"的字段：不许当成可重试的 failed
  const connection = nodeError('ECONNRESET')
  Object.assign(connection, { data: { retcode: 1200 }, detail: { retcode: 1200 }, retcode: 1200 })
  assert.equal(
    classify!(connection).state, 'unknown',
    'R5：`ECONNRESET` 是连接类，嵌套/顶层的 retcode 都不能把它变成"明确拒绝"（否则会重试 → 重复外发）',
  )

  // 2) 真正的拒绝：走真实适配层打的那个标记
  const { ONEBOT_REJECTION } = await import('../src/onebot.js') as unknown as { ONEBOT_REJECTION: symbol }
  const rejection = Object.assign(new Error('QQ API failed: mock refusal'), { retcode: 1200, status: 'failed' })
  Object.defineProperty(rejection, ONEBOT_REJECTION, { value: true, enumerable: false })
  assert.equal(classify!(rejection).state, 'failed', 'R5：带专用拒绝标记的才是 failed（可重试）')
})

// ══ 第五轮：F41 / F42 / P2（最后一轮 I/O 期间的窗口） ════════════════════════

test('F41 最后一轮 I/O 期间租约到期 → 零 sendTo（顺序契约：assertLease 是最后一个 await）', async () => {
  // 顺序契约（`liveSnapshot`）：**先读盘 → 用这份快照判 → 最后 assertLease(epoch)**。
  // 修复前只有"读盘前校验一次"，于是"读盘期间租约刚好到期"这一段没人管。
  const rig = makeStoreRig()
  try {
    const { pending } = await holdInStoreQueue(rig)
    // 在**最后一轮 I/O**里把假时钟推过租约有效期（180s）
    rig.duringLiveFacts = () => { rig.clock.advance(rig.leaseTtlMs + 1_000) }
    await rig.queue.release()
    const result = await pending

    assert.equal(
      rig.platform.count(), 0,
      `租约在读盘期间到期了，这一次绝不该发出去。ownership 调用 ${String(rig.ownershipCalls())} 次；`
      + `日志：\n${rig.logs.join('\n')}`,
    )
    assert.equal(result.state, 'deferred', `应当是 deferred，实际 ${result.state}/${result.detail}`)
    assert.equal(result.attempted, false, '一个字节都没出网')
    assert.match(result.detail, /lease/, `detail 要指向租约，实际 ${result.detail}`)
  } finally {
    rig.duringLiveFacts = null
    await rig.dispose()
  }
})

test('F42① 最后一轮 I/O 期间跨进免打扰（22:59:55 → 23:00:05）→ 零 sendTo', async () => {
  // Codex 三条探针之一：修复前这里会 `confirmed` + `sendTo=1`。
  const rig = makeStoreRig({
    start: Date.UTC(2026, 9, 16, 14, 59, 55), // Asia/Shanghai 22:59:55
    config: { quietHours: [{ from: '23:00', to: '08:00' }], timezone: 'Asia/Shanghai' },
  })
  try {
    const { pending } = await holdInStoreQueue(rig)
    rig.duringLiveFacts = () => { rig.clock.advance(10_000) } // → 23:00:05
    await rig.queue.release()
    const result = await pending

    assert.equal(rig.platform.count(), 0, '跨进免打扰之后必须停下')
    assert.equal(result.state, 'deferred')
    assert.match(result.detail, /quiet-hours/, `detail 要指向免打扰，实际 ${result.detail}`)
  } finally {
    rig.duringLiveFacts = null
    await rig.dispose()
  }
})

test('F42② 最后一轮 I/O 期间后台把总开关关掉 → 零 sendTo', async () => {
  const rig = makeStoreRig()
  try {
    const { pending } = await holdInStoreQueue(rig)
    rig.duringLiveFacts = () => { rig.setConfig({ enabled: false }) }
    await rig.queue.release()
    const result = await pending

    assert.equal(rig.platform.count(), 0, '开关在窗口期被关掉了，这一次绝不该发')
    assert.notEqual(result.state, 'confirmed')
    assert.match(result.detail, /disabled|enabled|paused/i, `detail 要指向开关，实际 ${result.detail}`)
  } finally {
    rig.duringLiveFacts = null
    await rig.dispose()
  }
})

test('F42③ 最后一轮 I/O 期间候选越过 expiresAt → 零 sendTo', async () => {
  const rig = makeStoreRig()
  try {
    // 候选 900ms 后过期：入队时还活着，窗口期内自然过期。
    // **不改账本**（那会变成"我自己改了盘"），只把假时钟推过去——这才是真实世界里
    // "时间流逝导致候选过期"的形状，也是生产 sync 守卫用 `refresh` + `now` 判出来的东西。
    const { pending } = await holdInStoreQueue(rig, { expiresAt: rig.clock.now() + 900 })
    rig.duringLiveFacts = () => { rig.clock.advance(1_200) }
    await rig.queue.release()
    const result = await pending

    assert.equal(rig.platform.count(), 0, '候选在窗口期过期了，这一次绝不该发')
    assert.notEqual(result.state, 'confirmed')
    assert.match(result.detail, /expired/, `detail 要指向过期，实际 ${result.detail}`)
  } finally {
    rig.duringLiveFacts = null
    await rig.dispose()
  }
})

test('R3①（重写）读盘期间跨过**发送截止** → 零 sendTo（不再是"普通超时"）', async () => {
  // 上一版这条只触发了 `withTimeout` 的普通超时（`aborted:deadline` 的兄弟），
  // 并没有走到"读盘之后那一次所有权校验"。现在把假时钟推过 `timeoutMs`，
  // 断言仍然零发送，且**不是** `unknown/timeout`（那是"回执未知"，与"根本没发"是两件事）。
  const rig = makeStoreRig({ config: {} })
  try {
    const { pending } = await holdInStoreQueue(rig)
    rig.duringLiveFacts = () => { rig.clock.advance(700_000) } // > timeoutMs(600_000)
    await rig.queue.release()
    const result = await pending

    assert.equal(rig.platform.count(), 0, '过了发送截止就不该再发')
    assert.notEqual(result.state, 'confirmed')
    // 这里**不**断言"state 不能是 unknown"：假时钟一推进就同时触发了发送超时的定时器，
    // "过了 deadline 主动放弃"和"超时"在假时钟下无法区分（同一个 now）。要证明的性质是
    // **一个字节都没出网**，那一条在上面。
    assert.ok(
      result.state === 'unknown' || result.state === 'deferred',
      `既没发也不该记成发过，实际 ${result.state}/${result.detail}`,
    )
  } finally {
    rig.duringLiveFacts = null
    await rig.dispose()
  }
})

test('P2-1 缺 status/retcode 的回包**不打拒绝标记** → 分类成 unknown（不是可重试的 failed）', async () => {
  const { OneBotClient } = await import('../src/onebot.js')
  const client = new OneBotClient({ mode: 'forward', url: 'ws://127.0.0.1:1' }, undefined, () => {})
  type Entry = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: unknown }
  const internals = client as unknown as { pending: Map<string, Entry>; handleFrame(raw: string): void }
  const echo = 'dsh-qq-p21'
  const rejected = new Promise<Error>((resolve) => {
    internals.pending.set(echo, {
      resolve: () => { resolve(new Error('不该 resolve')) },
      reject: (error) => { resolve(error) },
      timer: null,
    })
  })
  // 一个"既不 ok 也没有 retcode/status"的怪回包：无法证明是平台明确拒绝
  internals.handleFrame(JSON.stringify({ echo, msg: 'weird reply' }))
  const error = await rejected

  const shape = error as { retcode?: number; status?: string }
  assert.equal(shape.status, undefined, 'P2-1：缺 status 的回包不该被补成 failed')
  assert.equal(shape.retcode, undefined, 'P2-1：缺 retcode 的回包不该被补成某个数字')
  // P2-1 落盘后的判据：**没有可验证的拒绝证据就不许打标记**（标记是"可重试"的唯一凭据）
  const { isOneBotRejection } = await import('../src/onebot.js')
  assert.equal(isOneBotRejection(error), false, 'P2-1：缺字段的回包绝不能带拒绝标记')
  const classify = (senderModule as unknown as { classifySendError?: (value: unknown) => { state: string } }).classifySendError
  assert.equal(typeof classify, 'function')
  assert.equal(
    classify!(error).state, 'unknown',
    'P2-1：没有可验证的拒绝证据 → 只能当"回执未知"（不许重试）',
  )
})

// ── 对照：修复不该把"能发"也拦住 ───────────────────────────────────────────

test('Q00（对照）什么都没变时照常发一条并记 confirmed——证明确实是"窗口期复核"在起作用', async () => {
  const rig = makeGuardRig()
  try {
    rig.queue.hold = true
    const pending = rig.deliver()
    await waitUntil(() => rig.queue.pending() === 1, 2_000)
    await rig.queue.release()
    const result = await pending
    assert.equal(result.state, 'confirmed')
    assert.equal(rig.platform.count(), 1)
    assert.deepEqual(rig.platform.textsTo(10001), ['在吗'])
  } finally {
    rig.queue.hold = false
  }
})
