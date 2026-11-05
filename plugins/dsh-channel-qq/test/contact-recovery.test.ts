/** 主动消息的**生命周期**：空转、暂停、卸载、热重载、双 Host、崩溃恢复、退避。
 *
 * 这个文件回答的都是"**它不该动的时候真的没动**"：
 *   - 空转 24 小时：模型调用 0、外发 0、账本字节不变（只有租约续期在写锁文件）；
 *   - `enabled=false`：连磁盘都不碰（不取租约、不建文件），因为"关着"是最常见的状态；
 *   - 暂停/卸载：定时器停在原地，租约当场释放，不留后台任务占着实例位置；
 *   - 第二个 Host：拿不到租约 → 一句都不发（单调度者）；
 *   - 崩溃后重启：`running` 降级成 `unknown`，**不重发**；
 *   - 用户正在说话 / 连着几条没人理：延期，而不是插话。
 *
 * 时间全部来自 `FakeClock`（推进 = 调用 `tick`，不 sleep），外发全部落账在 `FakePlatform`，
 * 模型全部是会计数的假 `DraftPort`。不连网络、不发真 QQ、不碰真实 dshHome。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import * as path from 'node:path'
import type { ContactConfig } from '../src/config/sections/contact.js'
import type { ContactCandidate } from '../src/features/contact/types.js'
import type { DraftAttempt } from '../src/features/contact/model.js'
import {
  FakeClock, FakePlatform, contactCandidate, contactRuntime, fieldDefaults, tempHome, waitUntil,
  type TempHome,
} from './fakes/contact.js'

const { CONTACT_GROUPS } = await import('../src/config/sections/contact.js')
const { ContactStore } = await import('../src/features/contact/store.js')
const { ContactSender } = await import('../src/features/contact/sender.js')
const { ContactWorker } = await import('../src/features/contact/worker.js')

// ── 脚手架 ──────────────────────────────────────────────────────────────────

const DAY = '2026-10-17'
/** 当前人格 id；候选的 scope.personaId 必须与它一致（sender.scopeIssue 会复核）。 */
const PERSONA = 'nono'
/** 2026-10-17 06:00 +08:00（免打扰之外、白天）。 */
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
    pollIntervalMs: 60_000,
    ...over,
  }
}

interface Rig {
  worker: InstanceType<typeof ContactWorker>
  store: InstanceType<typeof ContactStore>
  platform: FakePlatform
  clock: FakeClock
  logs: string[]
  home: TempHome
  files: { ledger: string; lock: string }
  /** 假 DraftPort 调用次数（"空转模型调用 0"的唯一判据）。 */
  draftCalls(): number
  setFacts(room: string, facts: Partial<{ connected: boolean; roomBound: boolean; turnRunning: boolean; lastUserMessageAt: number | null }>): void
  /** 跑 n 次 tick，每次推进 `stepMs`。 */
  run(ticks: number, stepMs?: number): Promise<void>
}

function makeRig(options: {
  home?: TempHome
  config: ContactConfig
  start?: number
  hostId?: string
  pid?: number
  connected?: boolean
  /**
   * 假草稿端口：返回**结构化** `DraftAttempt`（`model.ts` 的合同，F5 之后端口要能区分
   * "调了但没话可说"与"根本没调"）。`text` 给了就是 `draft`，没给就是 `skip`。
   */
  draft?: (candidate: ContactCandidate) => Promise<{ kind: string; text?: string; route?: string; detail?: string }>
} = { config: config() }): Rig {
  const home = options.home ?? tempHome('qq-contact-worker-')
  const clock = new FakeClock(options.start ?? START)
  const platform = new FakePlatform({ clock })
  const logs: string[] = []
  const dir = path.join(home.dir, 'channel-qq')
  mkdirSync(dir, { recursive: true })
  const files = { ledger: path.join(dir, 'contact.json'), lock: path.join(dir, 'contact.lock') }
  const store = new ContactStore({
    file: files.ledger,
    lockFile: files.lock,
    hostId: options.hostId ?? 'host-a',
    pid: options.pid ?? 1001,
    log: (line: string) => { logs.push(line) },
    clock,
    dayKey: () => DAY,
  })

  // 房间事实：一个可变表，测试改写它就等于"用户刚说话 / 断线 / 有回合在跑"。
  const facts = new Map<string, { connected: boolean; roomBound: boolean; turnRunning: boolean; lastUserMessageAt: number | null }>()
  const factsOf = (room: string) => {
    const current = facts.get(room)
    if (current !== undefined) return current
    const fresh = { connected: options.connected ?? true, roomBound: true, turnRunning: false, lastUserMessageAt: null as number | null }
    facts.set(room, fresh)
    return fresh
  }
  const runtimeFor = (room: string) => {
    const current = factsOf(room)
    return contactRuntime({
      connected: current.connected,
      roomBound: current.roomBound,
      turnRunningByRoom: { [room]: current.turnRunning },
      lastUserMessageAtByRoom: { [room]: current.lastUserMessageAt },
      deliveredDedupeKeys: store.deliveredDedupeKeys(),
    })
  }
  const transport = () => ({
    connected: factsOf('__any__').connected,
    out: { push: async <T,>(task: () => Promise<T>): Promise<T> => await task() },
    api: platform.api as never,
  })

  const sender = new ContactSender({
    log: (line: string) => { logs.push(line) },
    clock,
    transport,
    turns: () => ({ bookPrompt: async () => true }),
    identity: () => ({ personaId: PERSONA, worldId: '' }),
    refresh: (candidateId, room) => ({ candidate: store.candidate(candidateId), runtime: runtimeFor(room) }),
    timeoutMs: 30_000,
  })

  let draftCalls = 0
  const worker = new ContactWorker({
    store,
    sender,
    clock,
    log: (line: string) => { logs.push(line) },
    config: () => options.config,
    roomFacts: (room) => {
      const current = factsOf(room)
      return {
        connected: current.connected,
        roomBound: current.roomBound,
        turnRunning: current.turnRunning,
        lastUserMessageAt: current.lastUserMessageAt,
      }
    },
    identity: () => ({ personaId: PERSONA, worldId: '' }),
    ...(options.draft === undefined
      ? {}
      : {
        // 草稿端口是 `{ draft(request) }`（`model.ts` 的 `DraftPort`，返回结构化 `DraftAttempt`）；
        // 预算与退避在 `draftWithBudget` 里判，所以这里只数"端口被真的调了几次"。
        draftPort: {
          draft: async (request: { candidate: ContactCandidate }): Promise<DraftAttempt> => {
            draftCalls += 1
            return (await options.draft!(request.candidate)) as DraftAttempt
          },
        },
      }),
  })

  const rig: Rig = {
    worker, store, platform, clock, logs, home, files,
    draftCalls: () => draftCalls,
    setFacts: (room, next) => { Object.assign(factsOf(room), next) },
    run: async (ticks, stepMs = (options.config.pollIntervalMs)) => {
      for (let i = 0; i < ticks; i += 1) {
        clock.shift(stepMs)
        await worker.tick(clock.now())
      }
    },
  }
  return rig
}

/** 等一个条件成立（`start()` 里的首拍是 fire-and-forget，只能等它落地）。 */
async function waitFor(predicate: () => boolean, budgetMs = 3_000): Promise<void> {
  // 用共享的真实时间基等待（见 `fakes/contact.ts` 的 `waitUntil` 注释）：
  // `setImmediate` 轮询在 Windows 上只有十几毫秒，等不到真实文件 I/O。
  await waitUntil(predicate, budgetMs)
}

/** 往账本里放一条候选（已到点、一天内）。 */
async function seedCandidate(rig: Rig, over: Partial<ContactCandidate> = {}): Promise<ContactCandidate> {
  const now = rig.clock.now()
  const candidate = contactCandidate({
    earliestAt: now - 60_000,
    expiresAt: now + 6 * 3_600_000,
    createdAt: now - 60_000,
    ...over,
  })
  // 用 store 直写（不用 service.propose：这里测的是 worker，不是入口校验）
  await rig.store.write((ledger) => { ledger.candidates[candidate.id] = candidate; return true })
  return candidate
}

// ── H01/H02：空转与"关着" ─────────────────────────────────────────────────

test('H01 空转 24 小时（enabled=true、空池）：模型调用 0、外发 0、账本除租约外字节不变', async () => {
  const rig = makeRig({ config: config(), draft: async () => ({ kind: 'draft', text: '不该被调用', route: 'fake' }) })
  try {
    // 第一拍：取租约（这一步必然要落盘，因为它要写下 epoch 与过期时刻）
    await rig.worker.tick(rig.clock.now())
    const afterBoot = readFileSync(rig.files.ledger, 'utf-8')

    // 24 小时。用 5 分钟一拍（288 拍）而不是 1 分钟一拍（1440 拍）：每一拍走的是同一段
    // 空转路径，结论与拍频无关；降拍频只是把这份测试的 20 多秒压到 4 秒左右。
    await rig.run(288, 5 * 60_000)

    assert.equal(rig.draftCalls(), 0, '空转不许调用模型（"什么时候调模型"由门控顺序决定，不是约定）')
    assert.equal(rig.platform.count(), 0, '空转不许外发')

    // 账本唯一允许变化的是 `lease.expiresAt`（续期）。用它证明"什么都没写进去"。
    const before = JSON.parse(afterBoot) as Record<string, unknown>
    const after = JSON.parse(readFileSync(rig.files.ledger, 'utf-8')) as Record<string, unknown>
    delete before.lease
    delete after.lease
    assert.deepEqual(after, before, '空池的 tick 除租约续期外不该改账本（候选/投递/计数/原因都不许动）')

    // 日志也必须保持安静：1440 次 tick 不该刷出 1440 行（连续同因只记第一次）。
    assert.ok(rig.logs.length < 40, `日志增长应当有界，实际 ${String(rig.logs.length)} 行：\n${rig.logs.slice(0, 10).join('\n')}`)
  } finally {
    await rig.worker.dispose()
    rig.home.cleanup()
  }
})

test('H02 enabled=false：零模型、零外发、**零磁盘写**（连账本文件都不建）', async () => {
  const rig = makeRig({ config: config({ enabled: false }), draft: async () => ({ kind: 'draft', text: 'x', route: 'fake' }) })
  try {
    await seedCandidate(rig, { id: 'c-off', dedupeKey: 'k-off' })
    // seedCandidate 已经建了账本；先记下内容
    const before = readFileSync(rig.files.ledger, 'utf-8')
    await rig.run(10)
    assert.equal(rig.draftCalls(), 0, '关着时候选照常入库但不调模型')
    assert.equal(rig.platform.count(), 0)
    assert.equal(readFileSync(rig.files.ledger, 'utf-8'), before, '关着的 tick 不该写盘')
    assert.equal(rig.store.lease, null, '关着时不该占着租约')
  } finally {
    await rig.worker.dispose()
    rig.home.cleanup()
  }
})

test('H02b enabled=false 且账本还不存在：一拍都不该创建文件/锁', async () => {
  const home = tempHome('qq-contact-off-')
  const rig = makeRig({ home, config: config({ enabled: false }) })
  try {
    assert.equal(existsSync(rig.files.ledger), false, '前置：账本还不存在')
    await rig.run(5)
    assert.equal(existsSync(rig.files.ledger), false, '关着的状态下不该创建账本（"关"必须是真的不动）')
    assert.equal(existsSync(rig.files.lock), false, '也不该抢锁')
  } finally {
    await rig.worker.dispose()
    home.cleanup()
  }
})

test('H04 有候选但被免打扰挡住：模型调用 0（门控在起草之前）', async () => {
  const rig = makeRig({
    // 免打扰覆盖 06:00 那一整段：起点 06:00 → 落在 [00:00, 23:00) 之外？
    config: config({ quietHours: [{ from: '05:00', to: '08:00' }] }),
    draft: async () => ({ kind: 'draft', text: '不该被调用', route: 'fake' }),
    start: START + 3_600_000,
  })
  try {
    await seedCandidate(rig, { id: 'c-quiet', dedupeKey: 'k-quiet' })
    await rig.run(5)
    assert.equal(rig.draftCalls(), 0, '免打扰时不生成草稿（空转不消耗模型预算是靠顺序保证的）')
    assert.equal(rig.platform.count(), 0)
    assert.equal(rig.store.candidate('c-quiet')?.state, 'deferred')
    assert.equal(rig.store.candidate('c-quiet')?.lastSuppressedReason, 'quiet-hours')
  } finally {
    await rig.worker.dispose()
    rig.home.cleanup()
  }
})

// ── H05：重复 tick / 双 Host ───────────────────────────────────────────────

test('H05 重复 tick 不重复领取：同一条候选只发一次', async () => {
  const rig = makeRig({ config: config(), draft: async () => ({ kind: 'draft', text: '在吗', route: 'fake' }) })
  try {
    await seedCandidate(rig, { id: 'c-once', dedupeKey: 'k-once' })
    await rig.run(1)
    assert.equal(rig.platform.count(), 1)
    await rig.run(5)
    assert.equal(rig.platform.count(), 1, '后续 tick 不该再发（候选已 consumed）')
    assert.equal(rig.store.candidate('c-once')?.state, 'consumed')
    assert.equal(rig.draftCalls(), 1, '已消费的候选不该再起草')
  } finally {
    await rig.worker.dispose()
    rig.home.cleanup()
  }
})

test('H06 双 Host：第二个实例拿不到租约 → 一句都不发', async () => {
  const home = tempHome('qq-contact-dual-')
  const a = makeRig({ home, config: config(), hostId: 'host-a', pid: 1001, draft: async () => ({ kind: 'draft', text: 'A', route: 'fake' }) })
  const b = makeRig({ home, config: config(), hostId: 'host-b', pid: 2002, draft: async () => ({ kind: 'draft', text: 'B', route: 'fake' }) })
  try {
    await a.worker.tick(a.clock.now())
    assert.notEqual(a.store.lease, null, 'A 应当拿到租约')

    // B 与 A 看同一个时钟/同一份文件
    b.clock.shift(a.clock.now() - b.clock.now())
    await seedCandidate(b, { id: 'c-dual', dedupeKey: 'k-dual' })
    await b.worker.tick(b.clock.now())

    assert.equal(b.store.lease, null, 'B 不该拿到租约')
    assert.equal(b.platform.count(), 0, 'B 一条都不许发')
    assert.ok(b.logs.some((line) => line.includes('租约在别的实例手里')), b.logs.join('\n'))

    // A 拿到租约后照常处理同一条候选（证明"不是没人能发"，只是只能有一个发）
    await a.worker.tick(a.clock.now())
    assert.equal(a.platform.count(), 1)
  } finally {
    await a.worker.dispose()
    await b.worker.dispose()
    home.cleanup()
  }
})

// ── H07/H08：卸载与暂停 ────────────────────────────────────────────────────

test('H07 卸载：定时器停在原地、租约释放、之后 tick 不再动', async () => {
  const rig = makeRig({ config: config() })
  try {
    await rig.worker.start()
    assert.equal(rig.clock.liveCount(), 1, '起表之后应当只有一个 interval')
    // `start()` 里的首拍是 fire-and-forget：等它拿到租约
    await waitFor(() => rig.store.lease !== null)
    assert.notEqual(rig.store.lease, null)

    await rig.worker.dispose()
    assert.equal(rig.clock.liveCount(), 0, '卸载后不许留残留定时器')
    assert.equal(rig.store.lease, null, '卸载必须释放租约')
    assert.equal(existsSync(rig.files.lock), false, '锁文件应当被删掉（别的实例才能立刻接管）')

    // 卸载之后即使有人误调 tick 也不该再有任何动作
    await seedCandidate(rig, { id: 'c-after', dedupeKey: 'k-after' })
    await rig.worker.tick(rig.clock.now())
    assert.equal(rig.platform.count(), 0, '卸载后的 tick 必须是空操作')
  } finally {
    rig.home.cleanup()
  }
})

test('H08 暂停：停表 + 释放租约 + 不再推进；恢复后照常', async () => {
  const rig = makeRig({ config: config(), draft: async () => ({ kind: 'draft', text: '在吗', route: 'fake' }) })
  try {
    await rig.worker.start()
    await waitFor(() => rig.store.lease !== null)
    assert.notEqual(rig.store.lease, null)

    rig.worker.pause()
    assert.equal(rig.worker.isPaused, true)
    assert.equal(rig.clock.liveCount(), 0, '暂停必须停表（不留后台任务）')
    // pause 里的 releaseLease 是 fire-and-forget：等它落地
    await waitFor(() => rig.store.lease === null)
    assert.equal(rig.store.lease, null, '暂停要放开租约，别的实例才能接管')

    await rig.run(3)
    assert.equal(rig.platform.count(), 0, '暂停期间一条都不发')

    await seedCandidate(rig, { id: 'c-resume', dedupeKey: 'k-resume' })
    rig.worker.resume()
    assert.equal(rig.clock.liveCount(), 1, '恢复要重新起表')
    // `resume()` 里的 start 也会立刻跑一拍（fire-and-forget），所以这里等结果而不是再抢一拍。
    await waitFor(() => rig.platform.count() === 1)
    assert.equal(rig.platform.count(), 1)
  } finally {
    await rig.worker.dispose()
    rig.home.cleanup()
  }
})

// ── H09：崩溃恢复 ──────────────────────────────────────────────────────────

test('H09 崩溃恢复：领取后进程死掉 → 重启降级成 unknown，不重发', async () => {
  const home = tempHome('qq-contact-crash-')
  const first = makeRig({ home, config: config(), draft: async () => ({ kind: 'draft', text: '在吗', route: 'fake' }) })
  try {
    await seedCandidate(first, { id: 'c-crash', dedupeKey: 'k-crash' })
    // 手工模拟"领到一半就死"：claim 之后不结算
    const lease = await first.store.acquireLease()
    const now = first.clock.now()
    const delivery = {
      id: 'd-c-crash', candidateId: 'c-crash', dedupeKey: 'k-crash',
      target: { channel: 'qq' as const, room: 'dm-10001', isGroup: false, chatId: 10001 },
      scope: { userId: 10001, personaId: '', worldId: '' }, text: '在吗', state: 'pending' as const,
      attempts: 0, leaseOwner: null, epoch: 0, createdAt: now, updatedAt: now,
      submittedAt: null, confirmedAt: null, receipt: null, lastError: null, mode: 'direct' as const,
    }
    assert.equal(await first.store.claimDelivery(delivery, lease!.epoch), true)

    // 新进程（同一个 hostId/pid，模拟重启）
    const second = makeRig({
      home, config: config(), hostId: 'host-a', pid: 1001, start: first.clock.now(),
      draft: async () => ({ kind: 'draft', text: '不该再发', route: 'fake' }),
    })
    await second.store.load()
    assert.equal(second.store.listDeliveries()[0]?.state, 'unknown')
    await second.worker.tick(second.clock.now())
    assert.equal(second.platform.count(), 0, '降级成 unknown 之后不许重发')
    // 候选也已经被判 consumed（第一次发送时账本已推进）——这里至少不能回到 pending 再发一遍
    assert.notEqual(second.store.candidate('c-crash')?.state, 'pending')
    await second.worker.dispose()
    second.home.cleanup()
  } finally {
    await first.worker.dispose()
    home.cleanup()
  }
})

// ── H10/H11：竞争与退避 ────────────────────────────────────────────────────

test('H10 用户正在说话 → 延期；窗口过去之后才发', async () => {
  const rig = makeRig({ config: config(), draft: async () => ({ kind: 'draft', text: '在吗', route: 'fake' }) })
  try {
    const candidate = await seedCandidate(rig, { id: 'c-settle', dedupeKey: 'k-settle' })
    rig.setFacts(candidate.target.room, { lastUserMessageAt: rig.clock.now() })
    await rig.run(1)
    assert.equal(rig.platform.count(), 0, '人家刚说话，不该插话')
    assert.equal(rig.store.candidate('c-settle')?.lastSuppressedReason, 'settle:user-active')

    // 过了 settle 窗口（默认 2 分钟）
    await rig.run(3)
    assert.equal(rig.platform.count(), 1, '窗口过去就该发')
  } finally {
    await rig.worker.dispose()
    rig.home.cleanup()
  }
})

test('H11 未回复退避：连着发到上限就停；用户一说话计数归零、恢复发送', async () => {
  // 额度放宽到不挡路：本条测的是**退避**（`maxUnansweredStreak`），
  // 默认 `dailyQuotaPerRoom=2` 会先一步用 `quota:room` 拦住，量到的是额度不是退避。
  const rig = makeRig({
    config: config({ perRoomCooldownMs: 0, globalCooldownMs: 0, dailyQuotaPerRoom: 10, dailyQuotaGlobal: 10 }),
    draft: async () => ({ kind: 'draft', text: '在吗', route: 'fake' }),
  })
  try {
    const max = config().maxUnansweredStreak
    assert.equal(max, 2, '前置：默认上限是 2（改了这里要一起复核）')
    const room = 'dm-10001'
    for (let i = 0; i < max; i += 1) {
      await seedCandidate(rig, { id: `c-streak-${i}`, dedupeKey: `k-streak-${i}` })
      await rig.run(1)
    }
    assert.equal(rig.platform.count(), max, `应当发了 ${max} 条`)

    // 第三条：退避生效
    await seedCandidate(rig, { id: 'c-streak-blocked', dedupeKey: 'k-streak-blocked' })
    await rig.run(2)
    assert.equal(rig.platform.count(), max, '没人回复时不该继续发')
    assert.equal(rig.store.candidate('c-streak-blocked')?.lastSuppressedReason, 'backoff:unanswered')

    // 用户回了一句（最后一条事件比最后一次主动发送更晚）
    rig.setFacts(room, { lastUserMessageAt: rig.clock.now() })
    await rig.run(2)
    // 归零之后同一条候选就能发了（退避不是永久封禁）
    assert.equal(rig.platform.count(), max + 1, '恢复之后应当能再发一条')
    // 计数：先被"收到回复"清零，再被这一条新发送 +1 → 1；
    // 如果没有清零，这里会是 max+1（3）。所以断言 1 同时证明了"清零发生过"。
    const counters = rig.store.state.counters
    assert.equal(counters.unansweredStreakByRoom[room] ?? 0, 1, '收到回复后连续未回复计数归零（随后这一条 +1）')
  } finally {
    await rig.worker.dispose()
    rig.home.cleanup()
  }
})

// ── H12/H13/H14：模型离线、无通道、演练 ────────────────────────────────────

test('H12 模型离线（起草抛错）：不阻塞节拍、不假成功、下一轮还能再试', async () => {
  const rig = makeRig({
    config: config(),
    draft: async () => ({ kind: 'failed', detail: 'model offline' }),
  })
  try {
    await seedCandidate(rig, { id: 'c-offline', dedupeKey: 'k-offline' })
    await rig.run(1)
    assert.equal(rig.platform.count(), 0, '没有文案就不发')
    assert.equal(rig.store.candidate('c-offline')?.lastSuppressedReason, 'draft:unavailable')
    // 稳定词而不是自然语言：日志措辞会改，`draft:failed` 是 `model.ts` 的稳定原因码
    assert.ok(rig.logs.some((line) => /draft:failed|没有草稿/.test(line)), rig.logs.join('\n'))

    // 节拍没有停：后面的 tick 照常跑（没有卡在 busy 里）
    await rig.run(2)
    assert.equal(rig.worker.isPaused, false)
    // 退避期内不再反复问模型：默认 draftFailureBackoffMs = 60s，所以在窗口内（+30s 两次）
    // 不该再产生调用。用"窗口内"而不是"下一拍"来断言，是因为下一拍恰好卡在窗口边界上。
    const callsAfterFirst = rig.draftCalls()
    await rig.run(2, 15_000)
    assert.equal(rig.draftCalls(), callsAfterFirst, '失败退避窗口内不该再去问模型')
  } finally {
    await rig.worker.dispose()
    rig.home.cleanup()
  }
})

test('H13 无通道：不发、不假成功、候选留着等通道回来', async () => {
  const rig = makeRig({ config: config(), connected: false, draft: async () => ({ kind: 'draft', text: '在吗', route: 'fake' }) })
  try {
    await seedCandidate(rig, { id: 'c-nochannel', dedupeKey: 'k-nochannel' })
    await rig.run(2)
    assert.equal(rig.platform.count(), 0, '没通道绝不"假装发过"')
    assert.equal(rig.store.listDeliveries().length, 0, '连投递记录都不该建')
    assert.equal(rig.store.candidate('c-nochannel')?.state, 'deferred')
    assert.equal(rig.store.candidate('c-nochannel')?.lastSuppressedReason, 'no-channel')
  } finally {
    await rig.worker.dispose()
    rig.home.cleanup()
  }
})

test('H14 dry-run：全流程照跑但绝不出网，账本里能看到"本来要发"', async () => {
  const rig = makeRig({ config: config({ dryRun: true }), draft: async () => ({ kind: 'draft', text: '本来想说的话', route: 'fake' }) })
  try {
    await seedCandidate(rig, { id: 'c-dry', dedupeKey: 'k-dry' })
    await rig.run(1)
    assert.equal(rig.platform.count(), 0, '演练模式一条都不发')
    const candidate = rig.store.candidate('c-dry')
    assert.equal(candidate?.state, 'deferred')
    // 发送器把"演练"作为 detail 返回，worker 再套一层 `deferred:` 前缀
    assert.match(candidate?.lastSuppressedReason ?? '', /dry-run/)
    // 草稿确实生成了（演练的意义是"看它打算说什么"）
    assert.equal(rig.draftCalls(), 1)
    // 额度没有被消耗（没发出去就不算"今天说过一次"）
    assert.equal(rig.store.state.counters.sentTodayGlobal, 0)
  } finally {
    await rig.worker.dispose()
    rig.home.cleanup()
  }
})

test('H15 补算视界：停机很久之后池子里的老候选被判过期，不会攒成一次补发', async () => {
  const rig = makeRig({ config: config(), draft: async () => ({ kind: 'draft', text: '补发', route: 'fake' }) })
  try {
    const now = rig.clock.now()
    // 一条"昨天就该发"的候选（超出 maxCatchupHours=24）
    const stale = contactCandidate({
      id: 'c-stale', dedupeKey: 'k-stale',
      earliestAt: now - 30 * 3_600_000, expiresAt: now + 3_600_000, createdAt: now - 30 * 3_600_000,
    })
    await rig.store.write((ledger) => { ledger.candidates[stale.id] = stale; return true })
    await rig.run(1)
    assert.equal(rig.platform.count(), 0)
    assert.equal(rig.store.candidate('c-stale')?.state, 'expired')
    assert.equal(rig.store.candidate('c-stale')?.lastSuppressedReason, 'stale:restart')
  } finally {
    await rig.worker.dispose()
    rig.home.cleanup()
  }
})
