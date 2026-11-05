/** R5 focused regressions: final refresh cancellation, async response, crash accounting, F43 late turn. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { finalSyncGuard } from '../src/features/contact/precheck.js'
import { classifySendError } from '../src/features/contact/send-guard.js'
import { emptyLedger, sweepInterrupted } from '../src/features/contact/ledger.js'
import { OneBotClient, isOneBotRejection } from '../src/onebot.js'
import { TurnLauncher } from '../src/app/conversation/turns.js'
import { proposeIdleFollowUp } from '../src/features/contact/index.js'
import { ContactStore } from '../src/features/contact/store.js'
import { baseConfig, contactCandidate, contactDelivery, contactRuntime, FakeClock, tempHome } from './fakes/contact.js'

const T0 = Date.UTC(2026, 9, 30, 1, 0, 0)

test('R5-1 final synchronous refresh consumes a candidate cancelled after liveSnapshot', () => {
  const config = baseConfig()
  const req = {
    candidate: contactCandidate({ id: 'c-r51', state: 'pending' }),
    delivery: contactDelivery({ candidateId: 'c-r51', mode: 'direct' }),
    text: '在吗',
    now: T0,
    runtime: contactRuntime({}),
  }
  const verdict = finalSyncGuard(req as never, config.contact as never, {
    identity: () => ({ personaId: 'nono', worldId: '' }),
    transport: () => ({ connected: true, out: { push: async (fn: never) => fn }, api: { sendTo: async () => ({}) } }) as never,
    turns: () => ({ bookPrompt: async () => true }),
    nowMs: () => T0,
    refresh: () => ({ runtime: contactRuntime({}), candidate: contactCandidate({ id: 'c-r51', state: 'cancelled' }) }),
  })
  assert.deepEqual(verdict, { state: 'cancelled', detail: 'candidate:cancelled' })
  const missing = finalSyncGuard(req as never, config.contact as never, {
    identity: () => ({ personaId: 'nono', worldId: '' }),
    transport: () => ({ connected: true, out: { push: async (fn: never) => fn }, api: { sendTo: async () => ({}) } }) as never,
    turns: () => ({ bookPrompt: async () => true }),
    nowMs: () => T0,
    refresh: () => ({ runtime: contactRuntime({}) }),
  })
  assert.deepEqual(missing, { state: 'cancelled', detail: 'candidate:missing' })
})

test('R5-2 async OneBot response is ambiguous, never a retryable rejection', async () => {
  const client = new OneBotClient({ mode: 'forward', url: 'ws://127.0.0.1:1' }, undefined, () => {})
  type Entry = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: { cancel(): void } }
  const internals = client as unknown as { pending: Map<string, Entry>; handleFrame(raw: string): void }
  const echo = 'r5-async'
  const rejected = new Promise<Error>((resolve) => {
    internals.pending.set(echo, { resolve: () => {}, reject: resolve, timer: { cancel: () => {} } })
  })
  internals.handleFrame(JSON.stringify({ status: 'async', retcode: 1, echo, msg: 'queued' }))
  const error = await rejected
  assert.equal(isOneBotRejection(error), false)
  assert.equal(classifySendError(error).state, 'unknown')
  for (const frame of [{ status: 'async', retcode: 0, expected: 'unknown' }, { status: 'failed', retcode: 0, expected: 'failed' }]) {
    const echo2 = `r5-ambiguous-${frame.status}`
    const rejected2 = new Promise<Error>((resolve) => {
      internals.pending.set(echo2, { resolve: () => {}, reject: resolve, timer: { cancel: () => {} } })
    })
    internals.handleFrame(JSON.stringify({ ...frame, echo: echo2 }))
    const err = await rejected2
    assert.equal(classifySendError(err).state, frame.expected)
  }
})

test('R5-3 interrupted unknown charges quota once and is idempotent', () => {
  const ledger = emptyLedger('2026-10-30')
  const candidate = contactCandidate({ id: 'c-r53', target: { channel: 'qq', room: 'qq-dm-10001', isGroup: false, chatId: 10001 } })
  ledger.candidates[candidate.id] = candidate
  ledger.outbox['d-r53'] = {
    ...contactDelivery({ id: 'd-r53', candidateId: candidate.id, target: candidate.target }),
    state: 'running',
    leaseOwner: 'dead#1',
    epoch: 1,
  }
  assert.equal(sweepInterrupted(ledger, T0), 1)
  assert.equal(ledger.counters.sentTodayGlobal, 1)
  assert.equal(ledger.counters.sentTodayByRoom[candidate.target.room], 1)
  assert.equal(ledger.counters.lastSentAt, T0)
  assert.equal(sweepInterrupted(ledger, T0 + 1), 0)
  assert.equal(ledger.counters.sentTodayGlobal, 1)
})

test('production room allowlist rejects a group/other room before send', () => {
  const config = baseConfig()
  const contact = { ...config.contact, enabled: true, dryRun: false, allowExternalSend: true, sendMode: 'direct', allowedRooms: ['dm-10001'], quietHours: [] }
  const req = {
    candidate: contactCandidate({ id: 'c-room', target: { channel: 'qq', room: 'group-1000000003', isGroup: true, chatId: 1000000003 } }),
    delivery: contactDelivery({ candidateId: 'c-room', target: { channel: 'qq', room: 'group-1000000003', isGroup: true, chatId: 1000000003 } }),
    text: '在吗', now: T0, runtime: contactRuntime({}),
  }
  const verdict = finalSyncGuard(req as never, contact as never, {
    identity: () => ({ personaId: 'nono', worldId: '' }),
    transport: () => ({ connected: true, out: { push: async (fn: never) => fn }, api: { sendTo: async () => ({}) } }) as never,
    turns: () => ({ bookPrompt: async () => true }),
    nowMs: () => T0,
    refresh: () => ({ runtime: contactRuntime({}), candidate: req.candidate }),
  })
  assert.deepEqual(verdict, { state: 'cancelled', detail: 'room-not-allowed' })
})

test('R5-3 second process load does not sweep a live running delivery', async () => {
  const home = tempHome('r5-two-load-')
  const clock = new FakeClock(new Date(T0))
  const options = {
    file: `${home.dir}/contact.json`, lockFile: `${home.dir}/contact.lock`, hostId: 'r5-two', pid: process.pid,
    log: () => {}, clock, dayKey: () => '2026-10-30',
  }
  const first = new ContactStore(options)
  const second = new ContactStore({ ...options, pid: process.pid + 1 })
  try {
    await first.load({ sweep: false })
    const lease = await first.acquireLease()
    const candidate = contactCandidate({ id: 'c-live' })
    const delivery = contactDelivery({ id: 'd-live', candidateId: candidate.id })
    await first.putCandidate(candidate, lease!.epoch)
    await first.claimDelivery(delivery, lease!.epoch)
    await second.load({ sweep: false })
    assert.equal(second.state.outbox[delivery.id]?.state, 'running')
    assert.equal(second.state.counters.sentTodayGlobal, 0)
  } finally {
    await first.releaseLease().catch(() => {})
    home.cleanup()
  }
})

test('R5-3 atomic settlement charges quota and is idempotent', async () => {
  const home = tempHome('r5-atomic-')
  const clock = new FakeClock(new Date(T0))
  const store = new ContactStore({
    file: `${home.dir}/contact.json`,
    lockFile: `${home.dir}/contact.lock`,
    hostId: 'r5-host',
    pid: process.pid,
    log: () => {},
    clock,
    dayKey: () => '2026-10-30',
  })
  try {
    await store.load()
    const lease = await store.acquireLease()
    assert.notEqual(lease, null)
    const candidate = contactCandidate({ id: 'c-atomic' })
    const delivery = contactDelivery({ id: 'd-atomic', candidateId: candidate.id })
    await store.putCandidate(candidate, lease!.epoch)
    assert.equal(await store.claimDelivery(delivery, lease!.epoch), true)
    const settlement = { state: 'confirmed' as const, receipt: null, lastError: null }
    assert.equal(await store.settleDeliveryAndAccount(delivery.id, lease!.epoch, settlement, T0, candidate.id, 'confirmed'), true)
    assert.equal(store.state.counters.sentTodayGlobal, 1)
    // A replay of the same settlement must not charge a second slot.
    assert.equal(await store.settleDeliveryAndAccount(delivery.id, lease!.epoch, settlement, T0 + 1, candidate.id, 'confirmed'), true)
    assert.equal(store.state.counters.sentTodayGlobal, 1)
  } finally {
    await store.releaseLease().catch(() => {})
    home.cleanup()
  }
})

test('follow-up source proposes exactly one owner-DM candidate after idle', async () => {
  const proposals: unknown[] = []
  const host = {
    config: {
      admins: [10001],
      agentPreset: 'companion',
      contact: { timezone: 'Asia/Shanghai', maxCatchupHours: 24 },
    },
    get: (name: string) => name === 'inbound'
      ? { registry: { get: () => ({ sessionId: 'qq-dm-10001', lastEvent: { post_type: 'message', user_id: 10001, time: (T0 - 7 * 3_600_000) / 1000 } }) } }
      : undefined,
    log: () => {},
  }
  const service = { propose: async (input: unknown) => { proposals.push(input); return { outcome: 'accepted', candidateId: 'c-follow' } } }
  await proposeIdleFollowUp(host as never, service as never, T0)
  assert.equal(proposals.length, 1)
  const input = proposals[0] as { source: string; target: { room: string; isGroup: boolean }; dedupeKey: string }
  assert.equal(input.source, 'follow-up')
  assert.equal(input.target.room, 'dm-10001')
  assert.equal(input.target.isGroup, false)
  assert.match(input.dedupeKey, /^followup:dm-10001:idle:/)
})

test('F43 a ticket cancelled before registry.ensure returns never submits a late turn', async () => {  let begin = 0
  const conversation = {
    key: 'dm-10001',
    chatId: 10001,
    isGroup: false,
    lastEvent: {},
    tracker: { running: () => false, begin: () => { begin += 1 }, deliver: () => {} },
  }
  const launcher = new TurnLauncher({
    registry: {
      ensure: async () => conversation,
      bootstrap: () => conversation,
    } as never,
    prompts: { proactive: () => 'p', roomDirective: () => 'room' } as never,
    clock: { now: () => T0, setTimeout: () => ({ cancel: () => {} }) } as never,
    log: () => {},
    config: () => ({ selfId: 1, admins: [10001] }),
    openSentLog: async () => ({ render: () => '' }),
  })
  const accepted = await launcher.bookPrompt('dm-10001', 'x', { cancelled: true })
  assert.equal(accepted, false)
  assert.equal(begin, 0)
})
