/** 主动消息的**持久层 + 投递**（`store.ts` / `sender.ts`）：租约、领取、结算、崩溃恢复。
 *
 * 这个文件盯的是"**同一件事会不会发两遍 / 会不会假装发过**"这两类事故。它们都不靠
 * 代码读起来对不对，而靠状态机与租约的边界条件：
 *
 *   - 两条 tick、两个 Host、热重载后的重入 → `claimDelivery` 必须只成功一次；
 *   - 领取后进程死掉 → 重启把 `running` 降级成 `unknown`，**不重发**；
 *   - 发送成功但回执丢了 → `unknown`（不是 `failed`，也不是 `confirmed`），且没人再领；
 *   - 没有通道 / dry-run / 绑定失效 → `attempted=false`，平台调用次数必须是 0。
 *
 * 全部用临时目录 + 假时钟 + 假平台：不连网络、不调模型、不发真 QQ、不碰真实 dshHome。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import type { ContactConfig } from '../src/config/sections/contact.js'
import type { ContactDelivery } from '../src/features/contact/types.js'
import {
  FakeClock, FakePlatform, baseConfig, contactCandidate, contactDelivery, contactRuntime,
  fieldDefaults, oneBotReject, settle, tempHome, type TempHome,
} from './fakes/contact.js'

const { CONTACT_GROUPS } = await import('../src/config/sections/contact.js')
const { ContactStore, StaleLeaseError, CONTACT_LEDGER_VERSION } = await import('../src/features/contact/store.js')
const { pruneOldDeliveries } = await import('../src/features/contact/transitions.js')
const { ContactSender } = await import('../src/features/contact/sender.js')

// ── 脚手架 ──────────────────────────────────────────────────────────────────

const DAY = '2026-10-17'

/**
 * 段定义默认值（单一来源 = `CONTACT_GROUPS[].fields[].default`）。
 *
 * `sendMode` 默认是 `turn`，而投递记录里写着当时的模式；两者必须一致，否则
 * `sender` 会（正确地）判 `mode-changed`。所以 helper 分成两份，**不在每个用例里
 * 各自拼一个 sendMode**——那样很容易漏掉一个而把"模式不符"误读成别的 bug。
 */
function contactConfig(over: Partial<ContactConfig> = {}): ContactConfig {
  return {
    ...(fieldDefaults(CONTACT_GROUPS) as unknown as ContactConfig),
    enabled: true,
    dryRun: false,
    allowExternalSend: true,
    timezone: 'Asia/Shanghai',
    quietHours: [],
    ...over,
  }
}

/** 直发模式（有平台回执）。 */
function directConfig(over: Partial<ContactConfig> = {}): ContactConfig {
  return contactConfig({ sendMode: 'direct', ...over })
}

/** 回合模式（只能记 submitted）。 */
function turnConfig(over: Partial<ContactConfig> = {}): ContactConfig {
  return contactConfig({ sendMode: 'turn', ...over })
}

interface Rig {
  store: InstanceType<typeof ContactStore>
  clock: FakeClock
  logs: string[]
  home: TempHome
  files: { ledger: string; lock: string }
}

function makeStore(home: TempHome, options: {
  hostId?: string
  pid?: number
  start?: number
  leaseTtlMs?: number
} = {}): Rig {
  const clock = new FakeClock(options.start ?? Date.UTC(2026, 9, 17, 6, 0, 0))
  const logs: string[] = []
  const dir = path.join(home.dir, 'channel-qq')
  mkdirSync(dir, { recursive: true })
  const files = { ledger: path.join(dir, 'contact-ledger.json'), lock: path.join(dir, 'contact.lock') }
  const store = new ContactStore({
    file: files.ledger,
    lockFile: files.lock,
    hostId: options.hostId ?? 'host-a',
    pid: options.pid ?? 1001,
    log: (line: string) => { logs.push(line) },
    clock,
    ...(options.leaseTtlMs === undefined ? {} : { leaseTtlMs: options.leaseTtlMs }),
    dayKey: () => DAY,
  })
  return { store, clock, logs, home, files }
}

/** 一条已经被领到手的投递（租约与 epoch 由调用方给）。 */
function claimedDelivery(over: Partial<ContactDelivery> = {}): ContactDelivery {
  return contactDelivery({ state: 'pending', ...over })
}

// ── 账本读写与容错 ──────────────────────────────────────────────────────────

test('S01 账本：写进去的东西跨实例读得回来（形状一致，版本号写对）', async () => {
  const home = tempHome('qq-ledger-')
  try {
    const first = makeStore(home)
    await first.store.load()
    const candidate = contactCandidate({ id: 'c-keep', dedupeKey: 'followup:dm-10001:x' })
    assert.equal(await first.store.putCandidate(candidate), true)

    const second = makeStore(home, { hostId: 'host-b', pid: 2002 })
    await second.store.load()
    const back = second.store.candidate('c-keep')
    assert.equal(back?.dedupeKey, 'followup:dm-10001:x')
    assert.deepEqual(back?.scope, candidate.scope)
    assert.deepEqual(back?.target, candidate.target)

    // 磁盘格式版本是契约的一部分（读到别的版本按"不认识"处理，见 S03）。
    const onDisk = JSON.parse(readFileSync(first.files.ledger, 'utf-8')) as { version?: number }
    assert.equal(onDisk.version, CONTACT_LEDGER_VERSION)
  } finally {
    home.cleanup()
  }
})

test('S02 账本读不动时：改名成 .corrupt 保留证据，本轮空表起步且不抛', async () => {
  const home = tempHome('qq-ledger-')
  try {
    const first = makeStore(home)
    mkdirSync(path.dirname(first.files.ledger), { recursive: true })
    writeFileSync(first.files.ledger, '{ 这不是 JSON', 'utf-8')
    await first.store.load()
    assert.equal(first.store.listCandidates().length, 0)
    assert.ok(first.logs.some((line) => line.includes('.corrupt')), first.logs.join('\n'))
    // 坏文件被保留下来了（不是被静默删除）
    assert.match(readFileSync(`${first.files.ledger}.corrupt`, 'utf-8'), /这不是 JSON/)
  } finally {
    home.cleanup()
  }
})

test('S03 不认识的账本版本：按"读不动"处理，绝不猜结构', async () => {
  const home = tempHome('qq-ledger-')
  try {
    const first = makeStore(home)
    mkdirSync(path.dirname(first.files.ledger), { recursive: true })
    writeFileSync(first.files.ledger, JSON.stringify({ version: 99, candidates: {}, outbox: {} }), 'utf-8')
    await first.store.load()
    assert.equal(first.store.listCandidates().length, 0)
    assert.ok(first.logs.some((line) => line.includes('版本 99')), first.logs.join('\n'))
  } finally {
    home.cleanup()
  }
})

test('S04 同一件事只留一个活着的候选：终态（cancelled/expired）不挡住重新提起', async () => {
  const home = tempHome('qq-ledger-')
  try {
    const rig = makeStore(home)
    await rig.store.load()
    await rig.store.putCandidate(contactCandidate({ id: 'c1', dedupeKey: 'k1' }))
    assert.equal(rig.store.findByDedupeKey('k1')?.id, 'c1')
    await rig.store.patchCandidate('c1', { state: 'cancelled' }, rig.clock.now())
    assert.equal(rig.store.findByDedupeKey('k1'), undefined, '取消过的主题还能重新提起')
    await rig.store.putCandidate(contactCandidate({ id: 'c2', dedupeKey: 'k1' }))
    // 但 expired 也不挡
    await rig.store.patchCandidate('c2', { state: 'expired' }, rig.clock.now())
    assert.equal(rig.store.findByDedupeKey('k1'), undefined)
  } finally {
    home.cleanup()
  }
})

// ── 租约（T09：第二 Host 拿不到租约） ───────────────────────────────────────

test('S05 租约：第二个 Host 拿不到；过期后能接管且代次 +1；旧代次不能提交', async () => {
  const home = tempHome('qq-lease-')
  try {
    const a = makeStore(home, { hostId: 'host-a', pid: 1001, leaseTtlMs: 60_000 })
    const leaseA = await a.store.acquireLease()
    assert.notEqual(leaseA, null, '第一个实例应当拿到租约')
    assert.equal(leaseA!.epoch, 1)

    // 第二个 Host：同一份文件、不同的身份
    const b = makeStore(home, { hostId: 'host-b', pid: 2002, leaseTtlMs: 60_000 })
    b.clock.shift(a.clock.now() - b.clock.now())
    assert.equal(await b.store.acquireLease(), null, '第一实例还活着时，第二实例必须一句都不发')
    assert.equal(await b.store.renewLease(), false, '没持有租约的实例不能续期')

    // A 的租约过期（时钟推进过 TTL）
    a.clock.shift(61_000)
    b.clock.shift(61_000)
    const leaseB = await b.store.acquireLease()
    assert.notEqual(leaseB, null, '过期之后应当能接管')
    assert.equal(leaseB!.epoch, 2, '接管的代次必须比前任大')

    // 旧代次（A）的结算写不进去
    await a.store.putCandidate(contactCandidate({ id: 'c-1' }))
    await assert.rejects(
      () => a.store.settleDelivery('d-1', leaseA!.epoch, { state: 'confirmed', receipt: null, lastError: null }, a.clock.now()),
      (error: unknown) => error instanceof StaleLeaseError || (error as Error).name === 'StaleLeaseError',
      '旧代次提交必须被拒（哪怕只是"租约文件不在自己手里"）',
    )
  } finally {
    home.cleanup()
  }
})

test('S06 租约续期：自己续自己（每次 tick）成功，且不会改代次', async () => {
  const home = tempHome('qq-lease-')
  try {
    const a = makeStore(home, { leaseTtlMs: 60_000 })
    const lease = await a.store.acquireLease()
    a.clock.shift(30_000)
    assert.equal(await a.store.renewLease(), true)
    assert.equal(a.store.lease?.epoch, lease!.epoch)
    assert.ok(a.store.lease!.expiresAt > lease!.expiresAt, '续期必须把过期时刻往后推')
  } finally {
    home.cleanup()
  }
})

// ── 领取（重复 tick / 双实例不重复发） ─────────────────────────────────────

test('S07 领取幂等：同一条投递只有第一次 claim 成功（重复 tick 不会二次发送）', async () => {
  const home = tempHome('qq-claim-')
  try {
    const rig = makeStore(home)
    const lease = await rig.store.acquireLease()
    await rig.store.putCandidate(contactCandidate({ id: 'c-1' }))

    const delivery = claimedDelivery({ id: 'd-1', candidateId: 'c-1' })
    assert.equal(await rig.store.claimDelivery(delivery, lease!.epoch), true)
    assert.equal(rig.store.listDeliveries()[0]?.state, 'running')
    assert.equal(rig.store.listDeliveries()[0]?.leaseOwner, 'host-a#1001')
    assert.equal(rig.store.listDeliveries()[0]?.attempts, 1)

    // 第二次（模拟下一秒的 tick / 热重载后的重入）
    assert.equal(await rig.store.claimDelivery(delivery, lease!.epoch), false, 'running 不许二次领取')
  } finally {
    home.cleanup()
  }
})

test('S08 领取拒绝终态：候选被取消/过期/已消费后绝不再领（取消不复活）', async () => {
  const home = tempHome('qq-claim-')
  try {
    const rig = makeStore(home)
    const lease = await rig.store.acquireLease()
    for (const state of ['cancelled', 'expired', 'consumed'] as const) {
      const id = `c-${state}`
      await rig.store.putCandidate(contactCandidate({ id, dedupeKey: `k-${state}` }))
      await rig.store.patchCandidate(id, { state }, rig.clock.now())
      const delivery = claimedDelivery({ id: `d-${state}`, candidateId: id, dedupeKey: `k-${state}` })
      assert.equal(await rig.store.claimDelivery(delivery, lease!.epoch), false, `${state} 不许领取`)
      assert.equal(rig.store.listDeliveries().length, 0, '失败的领取不该留下记录')
    }
    // 候选根本不在账本里 → 也不领
    assert.equal(await rig.store.claimDelivery(claimedDelivery({ id: 'd-x', candidateId: 'ghost' }), lease!.epoch), false)
    assert.equal(rig.store.listDeliveries().length, 0)
  } finally {
    home.cleanup()
  }
})

test('S09 已经递出去的投递不许重领（submitted/confirmed/unknown 都是终态）', async () => {
  const home = tempHome('qq-claim-')
  try {
    const rig = makeStore(home)
    const lease = await rig.store.acquireLease()
    await rig.store.putCandidate(contactCandidate({ id: 'c-1' }))
    const delivery = claimedDelivery({ id: 'd-1', candidateId: 'c-1' })
    for (const state of ['submitted', 'confirmed', 'unknown', 'cancelled'] as const) {
      await rig.store.claimDelivery(delivery, lease!.epoch)
      await rig.store.settleDelivery('d-1', lease!.epoch, { state, receipt: null, lastError: null }, rig.clock.now())
      assert.equal(await rig.store.claimDelivery(delivery, lease!.epoch), false, `${state} 之后不许重领`)
    }
    // failed / deferred 是"这一轮没成"，可以重领（次数由 attempts 兜住）
    // 盘上的 attempts 在每一次**成功领取**时 +1；被拒的领取不动计数。
    await rig.store.settleDelivery('d-1', lease!.epoch, { state: 'failed', receipt: null, lastError: 'x' }, rig.clock.now())
    assert.equal(await rig.store.claimDelivery(delivery, lease!.epoch), true, 'failed 允许重试')
    assert.equal(rig.store.listDeliveries()[0]?.attempts, 2, 'attempts 以盘上那份为准累加')
  } finally {
    home.cleanup()
  }
})

// ── 结算（回执丢失 → unknown，不盲重试） ────────────────────────────────────

test('S10 回执丢失：结算成 unknown 之后没人再领，且去重键已经算"递出去了"', async () => {
  const home = tempHome('qq-settle-')
  try {
    const rig = makeStore(home)
    const lease = await rig.store.acquireLease()
    await rig.store.putCandidate(contactCandidate({ id: 'c-1', dedupeKey: 'k-1' }))
    const delivery = claimedDelivery({ id: 'd-1', candidateId: 'c-1', dedupeKey: 'k-1' })
    await rig.store.claimDelivery(delivery, lease!.epoch)
    await rig.store.settleDelivery(
      'd-1',
      lease!.epoch,
      { state: 'unknown', receipt: null, lastError: 'timeout' },
      rig.clock.now(),
    )
    assert.equal(rig.store.listDeliveries()[0]?.state, 'unknown')
    assert.equal(rig.store.listDeliveries()[0]?.leaseOwner, null, '结算之后必须放开租约标记')
    assert.equal(await rig.store.claimDelivery(delivery, lease!.epoch), false, 'unknown 不许盲重试')
    assert.deepEqual(rig.store.deliveredDedupeKeys(), ['k-1'], 'unknown 也算"递出去了"，去重键不能放回去')

    // 反过来：failed 不算递出去（允许下一轮重试）
    await rig.store.settleDelivery('d-1', lease!.epoch, { state: 'failed', receipt: null, lastError: 'x' }, rig.clock.now())
    assert.deepEqual(rig.store.deliveredDedupeKeys(), [], 'failed 不该占着去重键')
  } finally {
    home.cleanup()
  }
})

test('S11 结算里的 submittedAt/confirmedAt 只增不减（旧时间戳不会被覆盖成 null）', async () => {
  const home = tempHome('qq-settle-')
  try {
    const rig = makeStore(home)
    const lease = await rig.store.acquireLease()
    await rig.store.putCandidate(contactCandidate({ id: 'c-1' }))
    await rig.store.claimDelivery(claimedDelivery({ id: 'd-1', candidateId: 'c-1' }), lease!.epoch)
    await rig.store.settleDelivery('d-1', lease!.epoch, {
      state: 'submitted', receipt: { kind: 'none', messageId: null, at: 1000 }, lastError: null, submittedAt: 1000,
    }, rig.clock.now())
    await rig.store.settleDelivery('d-1', lease!.epoch, {
      state: 'confirmed', receipt: { kind: 'platform-accepted', messageId: 42, at: 2000 }, lastError: null, confirmedAt: 2000,
    }, rig.clock.now())
    const row = rig.store.listDeliveries()[0]!
    assert.equal(row.submittedAt, 1000, '第二次结算没给 submittedAt，旧值必须留着')
    assert.equal(row.confirmedAt, 2000)
    assert.deepEqual(row.receipt, { kind: 'platform-accepted', messageId: 42, at: 2000 })
  } finally {
    home.cleanup()
  }
})

// ── 崩溃恢复（T03 / T09） ───────────────────────────────────────────────────

test('S12 崩溃恢复：重启把 running 降级成 unknown（不重发），并落盘这一降级', async () => {
  const home = tempHome('qq-crash-')
  try {
    const before = makeStore(home)
    const lease = await before.store.acquireLease()
    await before.store.putCandidate(contactCandidate({ id: 'c-1' }))
    await before.store.claimDelivery(claimedDelivery({ id: 'd-1', candidateId: 'c-1' }), lease!.epoch)
    assert.equal(before.store.listDeliveries()[0]?.state, 'running')

    // 模拟进程死在发送中途：不调 releaseLease，直接起一个新实例
    const after = makeStore(home, { hostId: 'host-a', pid: 1001 })
    await after.store.load()
    const row = after.store.listDeliveries()[0]!
    assert.equal(row.state, 'unknown', 'running 必须降级成 unknown')
    assert.match(row.lastError ?? '', /interrupted/)
    const afterLease = await after.store.acquireLease()
    assert.equal(
      await after.store.claimDelivery(claimedDelivery({ id: 'd-1', candidateId: 'c-1' }), afterLease!.epoch),
      false,
      '降级后不许重发',
    )
    assert.deepEqual(after.store.deliveredDedupeKeys(), ['followup:dm-10001:deploy'])

    // 降级结果落盘了（而不是只在内存里）
    const onDisk = JSON.parse(readFileSync(before.files.ledger, 'utf-8')) as { outbox: Record<string, { state?: string }> }
    assert.equal(onDisk.outbox['d-1']?.state, 'unknown')
    assert.ok(after.logs.some((line) => line.includes('已降级为 unknown')), after.logs.join('\n'))
  } finally {
    home.cleanup()
  }
})

test('S13 逻辑删除不越界：prune 只清旧终态，running/pending/deferred 一律留下', async () => {
  const home = tempHome('qq-prune-')
  try {
    const rig = makeStore(home)
    const lease = await rig.store.acquireLease()
    await rig.store.putCandidate(contactCandidate({ id: 'c-1' }))
    // 一批很久以前的终态 + 一条正在跑的
    for (let i = 0; i < 5; i += 1) {
      const id = `d-old-${i}`
      await rig.store.claimDelivery(claimedDelivery({ id, candidateId: 'c-1' }), lease!.epoch)
      await rig.store.settleDelivery(id, lease!.epoch, { state: 'confirmed', receipt: null, lastError: null }, 1)
    }
    await rig.store.claimDelivery(claimedDelivery({ id: 'd-running', candidateId: 'c-1' }), lease!.epoch)
    // prune 从 `ContactStore` 搬到了 `transitions.ts`（`pruneOldDeliveries`，worker 调它）：
    // 只清旧终态、`running` 永远留着。
    const removed = await pruneOldDeliveries(rig.store, rig.clock.now() + 86_400_000, 2)
    assert.equal(removed, 3)
    const left = rig.store.listDeliveries().map((row) => row.id).sort()
    assert.ok(left.includes('d-running'), '正在跑的投递绝不能被 prune 掉')
    assert.equal(left.filter((id) => id.startsWith('d-old')).length, 2, '只保留最近 2 条终态')
  } finally {
    home.cleanup()
  }
})

// ── 计数与跨日 ──────────────────────────────────────────────────────────────

test('S14 计数要过租约；连续同因不重复记', async () => {
  const home = tempHome('qq-counters-')
  try {
    const outsider = makeStore(home, { hostId: 'host-b', pid: 2002 })
    await assert.rejects(
      () => outsider.store.patchCounters({ sentTodayGlobal: 1 }, 1),
      (error: unknown) => error instanceof StaleLeaseError,
      '没有租约的实例不许改计数（否则等于把额度还回去）',
    )

    const rig = makeStore(home, { hostId: 'host-c', pid: 3003 })
    const lease = await rig.store.acquireLease()
    const updated = await rig.store.patchCounters({ sentTodayGlobal: 2, lastSentAt: 5000 }, lease!.epoch)
    assert.equal(updated.sentTodayGlobal, 2)
    assert.equal(updated.day, DAY, 'day 必须由 store 决定，客户端改不动')

    await rig.store.noteReason('quiet-hours', rig.clock.now())
    await rig.store.noteReason('quiet-hours', rig.clock.now())
    assert.equal(rig.store.state.recentReasons.length, 1, '同一个原因连着来只记第一次（夜里每分钟一条会淹没日志）')
    await rig.store.noteReason('quota:global', rig.clock.now())
    assert.equal(rig.store.state.recentReasons.length, 2)
    assert.ok(rig.store.state.recentReasons[0]!.endsWith('quota:global'), '新的在前')
  } finally {
    home.cleanup()
  }
})

// ── 跨日归零（V-S1：本轮审查发现并被修复） ─────────────────────────────────
//
// 修复前：`readLedger` 里的 `normalizeCounters(parsed.counters, dayKey(now))` 把账本的
// `day` 改写成"今天"却保留昨天的计数 → `rollDay()` 恒返回 null（死代码）→ 跨日/跨日重启
// 之后当天额度直接是"已用满"。修法是把"洗数据"与"跨日归零"拆开：
// `normalizeCounters` 保留原 `day`，`rollCounters()` 按天清零、跨天有意义的字段保留。
//
// 下面两条把修好之后的行为钉住（修复前它们会红，红在哪就是 V-S1 的哪一面）。

test('S14b 跨日（进程一直在跑）：rollDay 真的归零，跨天有意义的字段保留', async () => {
  const home = tempHome('qq-counters-')
  try {
    const rig = makeStore(home, { hostId: 'host-c', pid: 3003 })
    const lease = await rig.store.acquireLease()
    await rig.store.patchCounters({
      sentTodayGlobal: 2,
      sentTodayByRoom: { 'dm-10001': 2 },
      draftCallsToday: 5,
      lastSentAt: 5_000,
      lastSentAtByRoom: { 'dm-10001': 5_000 },
      unansweredStreakByRoom: { 'dm-10001': 1 },
    }, lease!.epoch)
    assert.equal(await rig.store.rollDay(rig.clock.now(), lease!.epoch), null, '同一天不该归零')

    // 同一个实例、同一份账本，只是"今天"变了（dayKey 读的是活配置）
    let today = DAY
    const live = new ContactStore({
      file: rig.files.ledger,
      lockFile: rig.files.lock,
      hostId: 'host-c',
      pid: 3003,
      log: () => {},
      clock: rig.clock,
      dayKey: () => today,
    })
    const liveLease = await live.acquireLease()
    today = '2026-10-18'
    const rolled = await live.rollDay(rig.clock.now(), liveLease!.epoch)
    assert.notEqual(rolled, null, '跨日必须真的归零（V-S1 修好之前这里恒为 null）')
    assert.equal(rolled!.day, '2026-10-18')
    // 按天计的：清零
    assert.equal(rolled!.sentTodayGlobal, 0, '当日总额度归零')
    assert.deepEqual(rolled!.sentTodayByRoom, {}, '当日每会话额度归零')
    assert.equal(rolled!.draftCallsToday, 0, '草稿日预算归零')
    // 跨天有意义的：保留
    assert.equal(rolled!.lastSentAt, 5_000, '全局冷却要跨天生效，否则午夜一到立刻又能发一条')
    assert.deepEqual(rolled!.lastSentAtByRoom, { 'dm-10001': 5_000 })
    assert.deepEqual(rolled!.unansweredStreakByRoom, { 'dm-10001': 1 }, '没人回就是没人回，与日历无关')
  } finally {
    home.cleanup()
  }
})

test('S14c 跨日重启：读盘即归零（开机不该发现"今天的额度昨天就用光了"）', async () => {
  const home = tempHome('qq-counters-')
  try {
    let today = DAY
    mkdirSync(path.join(home.dir, 'channel-qq'), { recursive: true })
    const file = path.join(home.dir, 'channel-qq', 'contact-ledger.json')
    const lockFile = path.join(home.dir, 'channel-qq', 'contact.lock')
    const yesterday = new ContactStore({
      file, lockFile, hostId: 'host-d', pid: 4004, log: () => {}, clock: new FakeClock(Date.UTC(2026, 9, 17, 6, 0, 0)),
      dayKey: () => today,
    })
    const lease = await yesterday.acquireLease()
    await yesterday.patchCounters({ sentTodayGlobal: 3, draftCallsToday: 7, lastSentAt: 1_000 }, lease!.epoch)

    today = '2026-10-18'
    const clock = new FakeClock(Date.UTC(2026, 9, 18, 6, 0, 0))
    const restarted = new ContactStore({ file, lockFile, hostId: 'host-d', pid: 4004, log: () => {}, clock, dayKey: () => today })
    await restarted.load()
    assert.equal(restarted.state.counters.day, '2026-10-18')
    assert.equal(restarted.state.counters.sentTodayGlobal, 0, '新的一天从零开始')
    assert.equal(restarted.state.counters.draftCallsToday, 0, '草稿预算也归零')
    assert.equal(restarted.state.counters.lastSentAt, 1_000, '但冷却时刻要留下')
    // rollDay 此时是幂等的（已经归零过），返回 null 而不是再写一遍
    const restartedLease = await restarted.acquireLease()
    assert.equal(await restarted.rollDay(clock.now(), restartedLease!.epoch), null)
  } finally {
    home.cleanup()
  }
})

// ── Windows `rename` EPERM（本轮第二个只在 Windows 上暴露的坑） ─────────────
//
// `atomicWriteFile` 的 `tmp → 目标` 改名在 Windows 上会被"目标文件还有别的句柄开着"
// 挡住（Defender 扫描、读句柄未关），表现为 `EPERM`。它不是"写坏了"，而是"这一刻不行"，
// 所以正确做法是**有界重试**；无界重试会挂住整条队列，一次都不重试则账本永远写不进去。
// 注入缝 `ContactStoreOptions.renameOnce` 只替换**单次** rename，用来确定性地造这两条。

test('S15 Windows rename EPERM：第一次失败、第二次成功 → 账本照常写入，且有一条可查的重试日志', async () => {
  const home = tempHome('qq-rename-')
  try {
    const clock = new FakeClock(Date.UTC(2026, 9, 17, 6, 0, 0))
    const logs: string[] = []
    const dir = path.join(home.dir, 'channel-qq')
    mkdirSync(dir, { recursive: true })
    const files = { ledger: path.join(dir, 'contact-ledger.json'), lock: path.join(dir, 'contact.lock') }
    let calls = 0
    const store = new ContactStore({
      file: files.ledger,
      lockFile: files.lock,
      hostId: 'host-a',
      pid: 1001,
      log: (line: string) => { logs.push(line) },
      clock,
      dayKey: () => DAY,
      renameOnce: async (from, to) => {
        calls += 1
        if (calls === 1) {
          const error = new Error('EPERM: operation not permitted, rename') as NodeJS.ErrnoException
          error.code = 'EPERM'
          throw error
        }
        const { promises: fsp } = await import('node:fs')
        await fsp.rename(from, to)
      },
      // 重试之间的等待用**瞬时**实现：默认那条是"注入时钟 + 50ms 真实定时器赛跑"，
      // 全量并发跑时 50ms 会漂移，用例会随机变红（本轮踩过：单跑 639ms 绿、全量 349ms 红）。
      retryDelay: async () => {},
    })

    const lease = await store.acquireLease()
    assert.notEqual(lease, null, 'EPERM 一次之后必须重试成功，而不是把租约判失败')
    assert.ok(calls >= 2, '应当真的重试过（只调一次 rename 就失败说明没重试）')
    assert.equal(existsSync(files.ledger), true, '账本必须落盘')
    const onDisk = JSON.parse(readFileSync(files.ledger, 'utf-8')) as { version?: number; lease?: { epoch?: number } }
    assert.equal(onDisk.version, CONTACT_LEDGER_VERSION)
    assert.equal(onDisk.lease?.epoch, lease!.epoch)
    assert.ok(
      logs.some((line) => line.includes('EPERM') && line.includes('重试')),
      `必须留一条可查的重试日志（否则"偶尔很慢"永远查不出来）：\n${logs.join('\n')}`,
    )
  } finally {
    home.cleanup()
  }
})

test('S16 Windows rename 一直 EPERM：有界重试后**写操作明确失败**，绝不假装写成功', async () => {
  const home = tempHome('qq-rename-')
  try {
    const clock = new FakeClock(Date.UTC(2026, 9, 17, 6, 0, 0))
    const logs: string[] = []
    const dir = path.join(home.dir, 'channel-qq')
    mkdirSync(dir, { recursive: true })
    const files = { ledger: path.join(dir, 'contact-ledger.json'), lock: path.join(dir, 'contact.lock') }
    let calls = 0
    const store = new ContactStore({
      file: files.ledger,
      lockFile: files.lock,
      hostId: 'host-a',
      pid: 1001,
      log: (line: string) => { logs.push(line) },
      clock,
      dayKey: () => DAY,
      renameOnce: async () => {
        calls += 1
        const error = new Error('EPERM: operation not permitted, rename') as NodeJS.ErrnoException
        error.code = 'EPERM'
        throw error
      },
      // 同上：瞬时重试，让"重试多少次"变成确定值而不是时序函数。
      retryDelay: async () => {},
    })

    // 取租约本身可以成功（锁文件是 `open('wx')` 建的，不走 rename），但**落盘**会失败：
    // 那一层是"记日志后继续"——因为没有账本就发不出去（见下一条断言）。
    const lease = await store.acquireLease()
    // 现在可以收紧到"精确等于 RENAME_ATTEMPTS"：一次取租约只落盘一次，重试次数是常量。
    assert.equal(calls, 6, `重试次数应当恰好是 RENAME_ATTEMPTS=6，实际 ${String(calls)} 次`)
    assert.equal(
      logs.filter((line) => line.includes('账本改名被占用')).length,
      6,
      `6 次尝试各留一条"被占用"日志（日志在每次失败后写，然后才汇总抛出）：\n${logs.join('\n')}`,
    )
    assert.ok(logs.some((line) => line.includes('EPERM')), '日志里要能看见错误码（否则运维只能猜）')

    // 关键：**写操作**必须明确失败。失败 → `claimDelivery` 领不到 → 一条都发不出去（fail-closed）。
    await assert.rejects(
      () => store.patchCounters({ sentTodayGlobal: 1 }, lease!.epoch),
      (error: unknown) => error instanceof Error && /rename|改名|EPERM/.test(error.message),
      '写入失败必须抛出来（"账本改名失败"），不能静默当成功——否则账本与实际状态会悄悄分叉',
    )
    assert.equal(existsSync(files.ledger), false, '一直失败的情况下账本文件本来就不该被创建')
  } finally {
    home.cleanup()
  }
})

// ── 投递执行（sender） ─────────────────────────────────────────────────────

interface SenderRig {
  sender: InstanceType<typeof ContactSender>
  platform: FakePlatform
  clock: FakeClock
  logs: string[]
  turns: { booked: Array<{ room: string; prompt: string }>; ok: boolean }
  setCandidate(candidate: ReturnType<typeof contactCandidate> | undefined): void
  setRuntime(runtime: ReturnType<typeof contactRuntime>): void
}

function makeSender(options: {
  config?: ContactConfig
  connected?: boolean
  transport?: boolean
  turnPort?: boolean
  loseReceipt?: boolean
  failWith?: string | null
  hanging?: boolean
  identity?: { personaId: string; worldId: string }
  start?: number
} = {}): SenderRig {
  const clock = new FakeClock(options.start ?? Date.UTC(2026, 9, 17, 6, 0, 0))
  const platform = new FakePlatform({ clock })
  platform.loseReceipt = options.loseReceipt ?? false
  platform.failWith = options.failWith ?? null
  const logs: string[] = []
  const turns = { booked: [] as Array<{ room: string; prompt: string }>, ok: true }
  let candidate = contactCandidate({ earliestAt: clock.now() - 3_600_000, createdAt: clock.now() - 3_600_000 })
  let runtime = contactRuntime()

  const out = options.hanging === true
    ? { push: <T,>(_task: () => Promise<T>): Promise<T> => new Promise<T>(() => {}) }
    : { push: async <T,>(task: () => Promise<T>): Promise<T> => await task() }

  const sender = new ContactSender({
    log: (line: string) => { logs.push(line) },
    clock,
    transport: () => (options.transport === false
      ? undefined
      : { connected: options.connected ?? true, out: out as never, api: platform.api as never }),
    turns: () => (options.turnPort === false
      ? undefined
      : { bookPrompt: async (room: string, prompt: string) => { turns.booked.push({ room, prompt }); return turns.ok } }),
    identity: () => options.identity ?? { personaId: 'nono', worldId: '' },
    refresh: () => ({ candidate, runtime }),
    timeoutMs: 30_000,
  })

  return {
    sender, platform, clock, logs, turns,
    setCandidate: (next) => { candidate = next as never },
    setRuntime: (next) => { runtime = next },
  }
}

/** 一次投递请求（默认：直发、正文非空、时间就是"现在"）。 */
function requestOf(rig: SenderRig, over: Partial<ContactDelivery> = {}): Parameters<InstanceType<typeof ContactSender>['deliver']>[0] {
  const candidate = contactCandidate({ earliestAt: rig.clock.now() - 3_600_000, createdAt: rig.clock.now() - 3_600_000 })
  return {
    delivery: contactDelivery({ state: 'running', epoch: 1, attempts: 1, ...over }),
    candidate,
    text: '在吗',
    now: rig.clock.now(),
    runtime: contactRuntime(),
  }
}

test('D01 直发成功且拿到 message_id → confirmed(platform-accepted)，只发一条', async () => {
  const rig = makeSender()
  const result = await rig.sender.deliver(requestOf(rig), directConfig())
  assert.equal(result.state, 'confirmed')
  assert.equal(result.attempted, true)
  assert.equal(result.receipt?.kind, 'platform-accepted')
  assert.equal(typeof result.receipt?.messageId, 'number')
  assert.equal(rig.platform.count(), 1)
  assert.equal(rig.platform.sent[0]!.text, '在吗')
  assert.deepEqual([rig.platform.sent[0]!.isGroup, rig.platform.sent[0]!.target], [false, 10001])
})

test('D02 发出去了但没拿到 message_id → 只能记 submitted（不许自称 confirmed）', async () => {
  const rig = makeSender({ loseReceipt: true })
  const result = await rig.sender.deliver(requestOf(rig), directConfig())
  assert.equal(result.state, 'submitted', 'confirmed 的唯一含义是平台接受了这条消息')
  assert.equal(result.receipt?.kind, 'none')
  assert.equal(result.receipt?.messageId, null)
  assert.equal(rig.platform.count(), 1, '消息确实出去了')
})

test('D03 发送超时 → unknown（回执未知），不是 failed，也不会自动重发', async () => {
  const rig = makeSender({ hanging: true })
  const pending = rig.sender.deliver(requestOf(rig), directConfig())
  await settle()
  rig.clock.advance(30_001)
  const result = await pending
  assert.equal(result.state, 'unknown')
  assert.equal(result.attempted, true)
  assert.equal(result.receipt, null)
  assert.ok(rig.logs.some((line) => line.includes('不自动重发')), rig.logs.join('\n'))
})

test('D04 平台明确 reject（retcode/status=failed）→ failed（有错误可查），不是 unknown', async () => {
  // 注意：这里是**明确拒绝**（OneBot 响应带 `retcode !== 0` / `status: 'failed'`），
  // 不是随便一个异常。随便一个 `Error('boom')` 属于"回执未知"（见 D04b 与 contact-guard 的
  // E01/E02）——本轮修复前这里用的是普通字符串错误并期望 `failed`，那正是把
  // `ECONNRESET` 之类误判成可重试的同一个 bug，现已改为显式拒绝。
  const rig = makeSender({})
  rig.platform.failWithError = oneBotReject(100, 'failed')
  const result = await rig.sender.deliver(requestOf(rig), directConfig())
  assert.equal(result.state, 'failed')
  assert.match(result.detail, /rejected/)
  assert.equal(result.attempted, true)
})

test('D04b 普通异常（没有 code/retcode）→ unknown：不确定就说不确定，不许猜成 failed', async () => {
  const rig = makeSender({ failWith: 'onebot: not connected' })
  const result = await rig.sender.deliver(requestOf(rig), directConfig())
  assert.equal(result.state, 'unknown', '认不出的异常宁可当"可能发出去了"，也不能当可重试的失败')
  assert.equal(result.attempted, true)
})

test('D05 没有通道 → attempted=false 且平台零调用（绝不假成功）', async () => {
  const noTransport = makeSender({ transport: false })
  const r1 = await noTransport.sender.deliver(requestOf(noTransport), directConfig())
  assert.equal(r1.attempted, false)
  assert.equal(r1.state, 'deferred')
  assert.equal(noTransport.platform.count(), 0)

  const disconnected = makeSender({ connected: false })
  disconnected.setRuntime(contactRuntime({ connected: false }))
  const r2 = await disconnected.sender.deliver(requestOf(disconnected), directConfig())
  assert.equal(r2.attempted, false)
  assert.equal(r2.state, 'deferred')
  assert.match(r2.detail, /no-channel/)
  assert.equal(disconnected.platform.count(), 0)
})

test('D06 dry-run / 未授权外发 → 一次都不出网，但结算是 deferred（不是 failed）', async () => {
  for (const config of [directConfig({ dryRun: true }), directConfig({ allowExternalSend: false })]) {
    const rig = makeSender()
    const result = await rig.sender.deliver(requestOf(rig), config)
    assert.equal(result.state, 'deferred')
    assert.equal(result.attempted, false)
    assert.equal(rig.platform.count(), 0)
  }
})

test('D07 复核窗口：候选在起草期间被取消 → 不碰通道', async () => {
  const rig = makeSender()
  rig.setCandidate(contactCandidate({ state: 'cancelled' }))
  const result = await rig.sender.deliver(requestOf(rig), directConfig())
  assert.equal(result.state, 'cancelled')
  assert.equal(result.attempted, false)
  assert.equal(rig.platform.count(), 0)
})

test('D08 复核窗口：起草期间用户刚说话 → deferred（下一轮再说）', async () => {
  const rig = makeSender()
  // 关键：复核读的是 `refresh()` 现取的运行时事实，**不是**请求里那份快照。
  // 把"刚说过话"只写在请求上会被正确地忽略——这正是这条测试想钉住的窗口语义。
  rig.setRuntime(contactRuntime({ lastUserMessageAtByRoom: { 'dm-10001': rig.clock.now() } }))
  const result = await rig.sender.deliver(requestOf(rig), directConfig())
  assert.equal(result.state, 'deferred')
  assert.equal(result.detail, 'settle:user-active')
  assert.equal(rig.platform.count(), 0)

  // 反向证据：只把"刚说过话"写在**过期的**请求快照里，不影响判定（refresh 是权威）。
  const stale = makeSender()
  const staleRequest = requestOf(stale)
  ;(staleRequest.runtime.lastUserMessageAtByRoom as Record<string, number | null>)['dm-10001'] = stale.clock.now()
  assert.equal((await stale.sender.deliver(staleRequest, directConfig())).state, 'confirmed')
})

test('D09 绑定失效 → cancelled（等多久都不会自己变对），不碰通道', async () => {
  const rig = makeSender()
  const request = requestOf(rig, {
    target: { channel: 'qq', room: 'dm-10001', isGroup: true, chatId: 10001 } as never,
  })
  const result = await rig.sender.deliver(request, directConfig())
  assert.equal(result.state, 'cancelled')
  assert.equal(result.detail, 'binding-invalid')
  assert.equal(rig.platform.count(), 0)
})

test('D10 跨用户越权：私聊收件人不是候选指向的那个人 → cancelled/scope:user', async () => {
  const rig = makeSender()
  // 候选说"这是 10002 的事"，投递却写给 10001
  rig.setCandidate(contactCandidate({ scope: { userId: 10002, personaId: 'nono', worldId: '' } }))
  const result = await rig.sender.deliver(requestOf(rig), directConfig())
  assert.equal(result.state, 'cancelled')
  assert.equal(result.detail, 'scope:user')
  assert.equal(rig.platform.count(), 0)
  // 群聊里 userId 只表示"这件事关于谁"，不要求等于群号
  rig.setCandidate(contactCandidate({
    scope: { userId: 10002, personaId: 'nono', worldId: '' },
    target: { channel: 'qq', room: 'group-1000000003', isGroup: true, chatId: 1000000003 },
  }))
  const groupRequest = requestOf(rig, { target: { channel: 'qq', room: 'group-1000000003', isGroup: true, chatId: 1000000003 } })
  assert.notEqual((await rig.sender.deliver(groupRequest, directConfig())).state, 'cancelled')
})

test('D11 跨人格/世界：作用域不一致就不发', async () => {
  const rig = makeSender()
  rig.setCandidate(contactCandidate({ scope: { userId: 10001, personaId: 'someone-else', worldId: '' } }))
  const persona = await rig.sender.deliver(requestOf(rig), directConfig())
  assert.equal(persona.state, 'cancelled')
  assert.equal(persona.detail, 'scope:persona')

  const rig2 = makeSender()
  rig2.setCandidate(contactCandidate({ scope: { userId: 10001, personaId: 'nono', worldId: 'other-world' } }))
  const world = await rig2.sender.deliver(requestOf(rig2), directConfig())
  assert.equal(world.state, 'cancelled')
  assert.equal(world.detail, 'scope:world')
  assert.equal(rig.platform.count() + rig2.platform.count(), 0)
})

test('D12 turn 模式：交给会话，只可能记 submitted（没有平台回执）', async () => {
  const rig = makeSender()
  const result = await rig.sender.deliver(requestOf(rig, { mode: 'turn' }), turnConfig())
  assert.equal(result.state, 'submitted')
  assert.equal(result.receipt?.kind, 'none')
  assert.deepEqual(rig.turns.booked, [{ room: 'dm-10001', prompt: '在吗' }])
  assert.equal(rig.platform.count(), 0, 'turn 模式不直接碰平台')
})

test('D13 turn 模式被会话拒绝（忙）→ deferred，不算发过', async () => {
  const rig = makeSender()
  rig.turns.ok = false
  const result = await rig.sender.deliver(requestOf(rig, { mode: 'turn' }), turnConfig())
  assert.equal(result.state, 'deferred')
  assert.equal(result.detail, 'turn-race-lost')
})

test('D14 sendMode 改了（投递建好之后）→ deferred，不按旧模式硬发', async () => {
  const rig = makeSender()
  const result = await rig.sender.deliver(requestOf(rig, { mode: 'direct' }), turnConfig())
  assert.equal(result.state, 'deferred')
  assert.equal(result.detail, 'mode-changed')
  assert.equal(rig.platform.count(), 0)
})

test('D15 空正文 → cancelled，不发一条空白消息', async () => {
  const rig = makeSender()
  const request = requestOf(rig)
  const result = await rig.sender.deliver({ ...request, text: '   ' }, directConfig())
  assert.equal(result.state, 'cancelled')
  assert.equal(result.detail, 'empty-text')
  assert.equal(rig.platform.count(), 0)
})

test('D16 候选已过期 → cancelled（不是 deferred：过期等不回未来）', async () => {
  const rig = makeSender()
  rig.setCandidate(contactCandidate({ expiresAt: rig.clock.now() - 1 }))
  const result = await rig.sender.deliver(requestOf(rig), directConfig())
  assert.equal(result.state, 'cancelled')
  assert.equal(result.detail, 'candidate:expired')
  assert.equal(rig.platform.count(), 0)
})

test('D17 候选已经不在账本里 → cancelled，不猜也不发', async () => {
  const rig = makeSender()
  rig.setCandidate(undefined)
  const result = await rig.sender.deliver(requestOf(rig), directConfig())
  assert.equal(result.state, 'cancelled')
  assert.equal(result.detail, 'candidate:missing')
  assert.equal(rig.platform.count(), 0)
})

test('D18 发送用的是与提醒共用的出站链（out.push），不是自己另开一条', async () => {
  const rig = makeSender()
  let pushed = 0
  // 用一个会计数的 out 覆盖 transport
  const spy = new ContactSender({
    log: () => {},
    clock: rig.clock,
    transport: () => ({
      connected: true,
      out: { push: async <T,>(task: () => Promise<T>): Promise<T> => { pushed += 1; return await task() } },
      api: rig.platform.api as never,
    }),
    turns: () => undefined,
    identity: () => ({ personaId: 'nono', worldId: '' }),
    refresh: () => ({ candidate: contactCandidate({ earliestAt: 0 }), runtime: contactRuntime() }),
  })
  await spy.deliver(requestOf(rig), directConfig())
  assert.equal(pushed, 1, '投递必须经过 out.push（全局限速与失败计数都在那条链上）')
})
