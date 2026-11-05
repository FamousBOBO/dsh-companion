/** **P2.5-3A 外发闭环**：共享闸门与账本 / 提醒 unknown / dryRun / occurrence 绑定 / dispatched。
 *
 * 五片的判据都落在"发了几条 / 返回什么结论 / 调用了谁"，不看内部字段。
 * 3A-1 额外带一条**抽取等价性**对照：28 个固定输入的 `verdict/reason` 与抽取前
 * （`logs/p2.5/outbound-3a/baseline-reasons.txt`）逐行相同。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { QQChannelConfig } from '../src/config.js'
import { evaluateGate, evaluateOutboundBudget } from '../src/features/contact/gate.js'
import { emptyCounters } from '../src/features/contact/types.js'
import type { ContactRuntimeFacts } from '../src/features/contact/types.js'
import type { Reminder } from '../src/features/reminders/store.js'
import { ReminderRunner } from '../src/features/reminders/runner.js'
import { configureReminderSeams, deliverReminder } from '../src/features/reminders/index.js'
import type { SubHost } from '../src/features/plugin-kit.js'
import { FakeOutboundQueue, FakePlatform, baseConfig } from './fakes/contact.js'

const START = Date.UTC(2026, 9, 16, 14, 0, 0)
const ROOM = 'dm-10001'

// ── 3A-1：抽取等价性（28 个固定输入，逐行对齐抽取前的基线） ──────────────────

const baseGateConfig = {
  enabled: true, dryRun: false, allowExternalSend: true, sendMode: 'direct', draftModel: true,
  timezone: 'Asia/Shanghai', quietHours: [], settleWindowMs: 120_000,
  perRoomCooldownMs: 0, globalCooldownMs: 0,
  dailyQuotaGlobal: 20, dailyQuotaPerRoom: 5,
  maxUnansweredStreak: 0, maxCatchupHours: 24,
}

const candidateOf = (over: Record<string, unknown> = {}): never => ({
  id: 'c-1', source: 'follow-up', reason: 'x', evidenceSource: 'chat', evidenceIds: [],
  scope: { userId: 10001, personaId: '', worldId: '' },
  target: { channel: 'qq', room: ROOM, isGroup: false, chatId: 10001 },
  priority: 0, earliestAt: START - 60_000, expiresAt: START + 3_600_000, dedupeKey: 'k',
  version: 1, authorization: { kind: 'standing', by: 10001, at: START - 86_400_000, quote: null },
  state: 'pending', attempts: 0, createdAt: START - 60_000, updatedAt: START - 60_000, lastSuppressedReason: null,
  ...over,
}) as never

const runtimeOf = (over: Record<string, unknown> = {}): ContactRuntimeFacts => ({
  lastUserMessageAtByRoom: {}, turnRunningByRoom: {}, toolRunning: false,
  connected: true, roomBound: true, deliveredDedupeKeys: [], enabled: true, ...over,
} as ContactRuntimeFacts)

const countersOf = (over: Record<string, unknown> = {}): ReturnType<typeof emptyCounters> => ({
  ...emptyCounters('2026-10-16'), ...over,
})

/** 抽取前用 `probe-gate-reasons.mjs` 抓到、存进 `baseline-reasons.txt` 的那张表。 */
const BASELINE: readonly (readonly [string, string, string])[] = [
  ['ok', 'send', 'ok'],
  ['state:cancelled', 'drop', 'cancelled'],
  ['state:consumed', 'drop', 'consumed'],
  ['state:expired', 'drop', 'expired'],
  ['disabled', 'defer', 'disabled'],
  ['window:expired', 'drop', 'expired'],
  ['window:stale-restart', 'drop', 'stale:restart'],
  ['window:not-due', 'defer', 'not-due'],
  ['auth-invalid', 'drop', 'authorization-invalid'],
  ['reminders-owns', 'drop', 'reminders-owns'],
  ['scope:no-user', 'drop', 'scope:no-user'],
  ['binding-invalid:room', 'drop', 'binding-invalid'],
  ['timezone-invalid', 'defer', 'timezone-invalid'],
  ['quiet-hours', 'defer', 'quiet-hours'],
  ['settle:user-active', 'defer', 'settle:user-active'],
  ['turn-running', 'defer', 'turn-running'],
  ['tool-running', 'defer', 'tool-running'],
  ['cooldown:room', 'defer', 'cooldown:room'],
  ['cooldown:global', 'defer', 'cooldown:global'],
  ['quota:global', 'defer', 'quota:global'],
  ['quota:room', 'defer', 'quota:room'],
  ['dedupe:delivery', 'drop', 'dedupe'],
  ['dedupe:runtime', 'drop', 'dedupe'],
  ['backoff:unanswered', 'defer', 'backoff:unanswered'],
  ['no-channel', 'defer', 'no-channel'],
  ['binding-invalid:unbound', 'drop', 'binding-invalid'],
  ['order:dedupe-before-backoff', 'drop', 'dedupe'],
  ['order:quiet-before-quota', 'defer', 'quiet-hours'],
]

const CASES: Record<string, { candidate?: unknown; config?: unknown; counters?: unknown; runtime?: unknown; deliveryDedupeKeys?: readonly string[] }> = {
  'ok': {},
  'state:cancelled': { candidate: candidateOf({ state: 'cancelled' }) },
  'state:consumed': { candidate: candidateOf({ state: 'consumed' }) },
  'state:expired': { candidate: candidateOf({ state: 'expired' }) },
  'disabled': { config: { ...baseGateConfig, enabled: false } },
  'window:expired': { candidate: candidateOf({ expiresAt: START - 1 }) },
  'window:stale-restart': { candidate: candidateOf({ earliestAt: START - 48 * 3_600_000 }) },
  'window:not-due': { candidate: candidateOf({ earliestAt: START + 60_000 }) },
  'auth-invalid': { candidate: candidateOf({ authorization: { kind: 'standing', by: null, at: null, quote: null } }) },
  'reminders-owns': { candidate: candidateOf({ source: 'explicit-reminder' }) },
  'scope:no-user': { candidate: candidateOf({ scope: { userId: null, personaId: '', worldId: '' } }) },
  'binding-invalid:room': { candidate: candidateOf({ target: { channel: 'qq', room: 'group-10001', isGroup: false, chatId: 10001 } }) },
  'timezone-invalid': { config: { ...baseGateConfig, timezone: 'Not/AZone' } },
  'quiet-hours': { config: { ...baseGateConfig, quietHours: [{ from: '00:00', to: '23:59' }] } },
  'settle:user-active': { runtime: runtimeOf({ lastUserMessageAtByRoom: { [ROOM]: START - 1_000 } }) },
  'turn-running': { runtime: runtimeOf({ turnRunningByRoom: { [ROOM]: true } }) },
  'tool-running': { runtime: runtimeOf({ toolRunning: true }) },
  'cooldown:room': { config: { ...baseGateConfig, perRoomCooldownMs: 600_000 }, counters: countersOf({ lastSentAtByRoom: { [ROOM]: START - 1_000 } }) },
  'cooldown:global': { config: { ...baseGateConfig, globalCooldownMs: 600_000 }, counters: countersOf({ lastSentAt: START - 1_000 }) },
  'quota:global': { counters: countersOf({ sentTodayGlobal: 99 }) },
  'quota:room': { counters: countersOf({ sentTodayByRoom: { [ROOM]: 99 } }) },
  'dedupe:delivery': { deliveryDedupeKeys: ['k'] },
  'dedupe:runtime': { runtime: runtimeOf({ deliveredDedupeKeys: ['k'] }) },
  'backoff:unanswered': { config: { ...baseGateConfig, maxUnansweredStreak: 2 }, counters: countersOf({ unansweredStreakByRoom: { [ROOM]: 3 } }) },
  'no-channel': { runtime: runtimeOf({ connected: false }) },
  'binding-invalid:unbound': { runtime: runtimeOf({ roomBound: false }) },
  'order:dedupe-before-backoff': { config: { ...baseGateConfig, maxUnansweredStreak: 1 }, counters: countersOf({ unansweredStreakByRoom: { [ROOM]: 5 } }), deliveryDedupeKeys: ['k'] },
  'order:quiet-before-quota': { config: { ...baseGateConfig, quietHours: [{ from: '00:00', to: '23:59' }] }, counters: countersOf({ sentTodayGlobal: 99 }) },
}

test('S1 抽取等价性：28 个固定输入的 verdict/reason 与抽取前基线逐行相同', () => {
  for (const [name, verdict, reason] of BASELINE) {
    const over = CASES[name] ?? {}
    const decision = evaluateGate({
      candidate: (over.candidate ?? candidateOf()) as never,
      now: START,
      config: (over.config ?? baseGateConfig) as never,
      counters: (over.counters ?? countersOf()) as never,
      runtime: (over.runtime ?? runtimeOf()) as never,
      deliveryDedupeKeys: over.deliveryDedupeKeys ?? [],
    })
    assert.equal(`${decision.verdict}/${decision.reason}`, `${verdict}/${reason}`, `用例 ${name} 的判定变了（抽取不是搬家）`)
  }
})

test('S2 共享闸门：没有候选也能判预算（免打扰/配额/冷却），reason 与 contact 同名', () => {
  const quiet = evaluateOutboundBudget({
    now: START, config: { ...baseGateConfig, quietHours: [{ from: '00:00', to: '23:59' }] } as never,
    counters: countersOf(), runtime: runtimeOf(), room: ROOM,
  })
  assert.deepEqual(quiet, { verdict: 'defer', reason: 'quiet-hours' })
  const quota = evaluateOutboundBudget({
    now: START, config: baseGateConfig as never, counters: countersOf({ sentTodayGlobal: 99 }), runtime: runtimeOf(), room: ROOM,
  })
  assert.deepEqual(quota, { verdict: 'defer', reason: 'quota:global' })
  const ok = evaluateOutboundBudget({ now: START, config: baseGateConfig as never, counters: countersOf(), runtime: runtimeOf(), room: ROOM })
  assert.deepEqual(ok, { verdict: 'send', reason: 'ok' })
})

// ── 3A-2：提醒的 unknown ────────────────────────────────────────────────────

function reminderAt(over: Partial<Reminder> = {}): Reminder {
  return {
    id: 'r-1', text: '该睡了', at: 0, room: 'dm', target: 10001, createdBy: 10001,
    created: 0, fired: false, firedAt: null, repeat: 'none', ...over,
  }
}

/** 假 store：`due()` 真的跟着 `markFired`/`markUnknown` 变，于是"还会不会重试"是可见的。 */
function fakeReminderStore(items: Reminder[]) {
  const fired = new Set<string>()
  const unknown = new Map<string, string>()
  const resolved: string[] = []
  return {
    fired, unknown, resolved,
    due: () => items.filter((r) => !fired.has(r.id)),
    // mutator 必须存在：生产里没有兜底，缺了就该炸
    expireStale: async () => ({ ok: true as const, changed: false, value: [] }),
    capBacklog: async () => ({ ok: true as const, changed: false, value: [] }),
    clearPendingDispatch: async () => ({ ok: true as const, changed: false, value: true }),
    bumpPendingDispatch: async () => ({ ok: false as const, code: 'NOT_APPLICABLE' as const, message: '桩：没有待办' }),
    markSent: async () => ({ ok: false as const, code: 'NOT_FOUND' as const, message: '桩：不记账' }),
    markFired: async (id: string) => { fired.add(id) },
    markUnknown: async (id: string, reason: string) => { fired.add(id); unknown.set(id, reason) },
    resolve: async (id: string, outcome: 'confirmed' | 'failed') => {
      resolved.push(`${id}:${outcome}`)
      unknown.delete(id)
      if (outcome === 'failed') fired.delete(id)
      return true
    },
  }
}

const tickOf = (runner: ReminderRunner): Promise<void> =>
  (runner as unknown as { tick: () => Promise<void> }).tick()

test('U1 发送抛错 → 进入 unknown：推进 5 个周期仍只尝试一次（不再无限重试）', async () => {
  const store = fakeReminderStore([reminderAt({ id: 'r-u1' })])
  let attempts = 0
  const runner = new ReminderRunner(store as never, async () => { attempts += 1; throw new Error('ECONNRESET') }, () => {})
  for (let i = 0; i < 5; i += 1) await tickOf(runner)
  assert.equal(attempts, 1, '抛错之后不许每 30 秒重来一遍')
  assert.equal(store.unknown.get('r-u1'), 'ECONNRESET', 'unknown 要留下原因')
})

test('U2 已提交但拿不到回执（unknown）→ 不重发；人工收敛 failed 后才允许再试', async () => {
  const store = fakeReminderStore([reminderAt({ id: 'r-u2' })])
  let attempts = 0
  const runner = new ReminderRunner(store as never, async () => { attempts += 1; return 'unknown' }, () => {})
  for (let i = 0; i < 5; i += 1) await tickOf(runner)
  assert.equal(attempts, 1, '回执未知的那条不许重发（重复外发是事故）')
  await store.resolve('r-u2', 'failed')
  await tickOf(runner)
  assert.equal(attempts, 2, '人工收敛成"确实没发出去"之后才该再试一次')
})

test('U3 成功投递 → 恰好一次，后续 tick 不再重复', async () => {
  const store = fakeReminderStore([reminderAt({ id: 'r-u3' })])
  let attempts = 0
  const runner = new ReminderRunner(store as never, async () => { attempts += 1; return 'sent' }, () => {})
  for (let i = 0; i < 5; i += 1) await tickOf(runner)
  assert.equal(attempts, 1)
  assert.equal(store.unknown.size, 0)
})

// ── 3A-3 / 3A-4 / 3A-5：投递链（dryRun / 日程 CAS / dispatched） ──────────────

function reminderConfig(over: { dryRun?: boolean } = {}): QQChannelConfig {
  const base = baseConfig({ admins: [10001] }) as unknown as QQChannelConfig
  return {
    ...base,
    groupEnabled: true,
    rooms: [],
    reminders: { enabled: true, file: null, dryRun: over.dryRun ?? false },
  } as QQChannelConfig
}

interface Rig {
  readonly host: SubHost
  readonly platform: FakePlatform
  readonly budgetCalls: number[]
  readonly accountCalls: number[]
  readonly logs: string[]
}

function rig(options: { dryRun?: boolean; budgetDenied?: string } = {}): Rig {
  const platform = new FakePlatform()
  const queue = new FakeOutboundQueue()
  const budgetCalls: number[] = []
  const accountCalls: number[] = []
  const logs: string[] = []
  const config = reminderConfig({ dryRun: options.dryRun })
  const contact = {
    outboundBudget: async () => {
      budgetCalls.push(1)
      return options.budgetDenied === undefined
        ? { allowed: true, reason: 'ok', verdict: 'send' as const }
        : { allowed: false, reason: options.budgetDenied, verdict: 'defer' as const }
    },
    account: async () => { accountCalls.push(1) },
  }
  const host = {
    config,
    log: (line: string) => { logs.push(line) },
    get: (name: string) => {
      if (name === 'platform') return { api: platform.api, out: queue }
      if (name === 'contact') return contact
      return undefined
    },
  } as unknown as SubHost
  return { host, platform, budgetCalls, accountCalls, logs }
}

const reminderFor = (over: Partial<Reminder> = {}): Reminder => reminderAt({ room: 'dm', target: 10001, at: START - 1_000, ...over })

test('D1 dryRun=true → 零 sendTo、**不碰闸门**（round7）、不记账、不写 dispatched', async () => {
  const r = rig({ dryRun: true })
  let dispatched = 0
  configureReminderSeams({ emitDispatched: () => { dispatched += 1 } })
  try {
    const outcome = await deliverReminder(r.host, reminderFor({ occurrence: { id: 'occ-1', revision: 3 } }))
    // **终审 B2**：dryRun 有自己的结论 `dry-run`（不是 `sent`）——runner 见它什么都不写，
    // 所以"演练过的提醒"不会因此在 store 里被标成已触发，退出 dryRun 后还会补发。
    assert.equal(outcome, 'dry-run', 'dryRun 是独立结论，不能冒充 sent')
    assert.equal(r.platform.count(), 0, 'dryRun 不许真发')
    // **round7 改判**：不再"只读地过闸门"。闸门读账本在损坏/版本不匹配时会隔离账本（rename），
    // 演练不得触发写动作 ⇒ 直接不评估；代价是演练看不出会不会被拦（已记日志 + 写入 README）。
    assert.equal(r.budgetCalls.length, 0, 'dryRun 不评估闸门（读账本可能触发隔离）')
    assert.equal(r.accountCalls.length, 0, '没真发就不该记账（配额是"发出去几条"）')
    assert.equal(dispatched, 0, 'dryRun 不写 occurrence-dispatched')
    assert.ok(r.logs.some((line) => line.includes('dryRun')), r.logs.join('\n'))
    assert.ok(r.logs.some((line) => line.includes('不评估共享闸门')), '要说明为什么不评估闸门')
  } finally {
    configureReminderSeams({})
  }
})

test('D2 dryRun=false → 真发一次、记账一次、dispatched 恰好一条', async () => {
  const r = rig({ dryRun: false })
  let dispatched = 0
  configureReminderSeams({ emitDispatched: () => { dispatched += 1 } })
  try {
    const outcome = await deliverReminder(r.host, reminderFor({ occurrence: { id: 'occ-2', revision: 5 } }))
    assert.equal(outcome, 'sent')
    assert.equal(r.platform.count(), 1)
    assert.equal(r.accountCalls.length, 1)
    assert.equal(dispatched, 1)
  } finally {
    configureReminderSeams({})
  }
})

test('D3 共享闸门拒绝 → 不投、不记账、返回 skipped（不消耗，等闸门自己放开）', async () => {
  const r = rig({ dryRun: false, budgetDenied: 'quota:global' })
  const outcome = await deliverReminder(r.host, reminderFor())
  assert.equal(outcome, 'skipped')
  assert.equal(r.platform.count(), 0)
  assert.equal(r.accountCalls.length, 0)
  assert.ok(r.logs.some((line) => line.includes('quota:global')), r.logs.join('\n'))
})

test('D4 日程 revision 不再匹配（取消/改期/时区/DST 的共性）→ 不投递，且进 terminal 不重试', async () => {
  const r = rig({ dryRun: false })
  let casCalls = 0
  configureReminderSeams({
    casOccurrence: async () => { casCalls += 1; return { ok: false, reason: 'revision-mismatch' } },
  })
  try {
    const outcome = await deliverReminder(r.host, reminderFor({ occurrence: { id: 'occ-3', revision: 7 } }))
    assert.equal(casCalls, 1, '发送前必须问一次 CAS')
    assert.equal(outcome, 'unknown', 'terminal：不重试，等人工收敛')
    assert.equal(r.platform.count(), 0, '日程变了就不许按旧时刻硬发')
    assert.equal(r.accountCalls.length, 0)
  } finally {
    configureReminderSeams({})
  }
})

test('D6 四类日程失效（取消/改期/时区/DST）在 QQ 侧都表现为 revision 不匹配 → 一律不投', async () => {
  // 四种情况在运行时那边是四条不同的判定，但在 QQ 侧拿到的是**同一个结果**：
  // "你已经不是我以为的那条日程了"。所以这里按四个 reason 各跑一遍，确认口径一致。
  const cases: readonly (readonly [string, string])[] = [
    ['日程已取消', 'occurrence-cancelled'],
    ['日程已改期', 'occurrence-rescheduled'],
    ['时区变了（本地时刻跟着漂）', 'timezone-changed'],
    ['DST gap/fold 让本地时刻不存在或有歧义', 'dst-ambiguous'],
  ]
  for (const [label, reason] of cases) {
    const r = rig({ dryRun: false })
    configureReminderSeams({ casOccurrence: async () => ({ ok: false, reason }) })
    try {
      const outcome = await deliverReminder(r.host, reminderFor({ id: `r-${reason}`, occurrence: { id: 'occ-x', revision: 2 } }))
      assert.equal(outcome, 'unknown', `${label}：应当 terminal（不重试），实际 ${outcome}`)
      assert.equal(r.platform.count(), 0, `${label}：一条都不许发`)
      assert.ok(r.logs.some((line) => line.includes(reason)), `${label}：诊断里要能看出是哪一类（${r.logs.join(' | ')}）`)
    } finally {
      configureReminderSeams({})
    }
  }
})

test('D5 日程 CAS 通过 → 正常投递（绑定不是"永远拦"）', async () => {
  const r = rig({ dryRun: false })
  let dispatched = 0
  configureReminderSeams({
    casOccurrence: async () => ({ ok: true }),
    emitDispatched: () => { dispatched += 1 },
  })
  try {
    const outcome = await deliverReminder(r.host, reminderFor({ occurrence: { id: 'occ-4', revision: 9 } }))
    assert.equal(outcome, 'sent')
    assert.equal(r.platform.count(), 1)
    assert.equal(dispatched, 1)
  } finally {
    configureReminderSeams({})
  }
})
