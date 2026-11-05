/** **草稿预算与发送 deadline**（F5 / F6）：走**真实** `createHostDraftPort`，不桩端口。
 *
 * 为什么这两条必须用真端口：H12 桩的是一个"直接抛错"的假 `DraftPort`，它绕过了真实端口
 * 里那层 `try/catch → null` 的收敛。Codex 实测过：真实端口把"宿主流抛错"变成 `null`，
 * 而预算层把 `null` 当 `noteDraftSuccess` ——于是**连续失败不清零反而清零**、小时环也
 * 一次都不记。断言桩端口永远看不到这个组合。
 *
 * 两个缺陷各配一条"行为级"证据（不看内部字段也能断言的那种）：
 *   - F5：`draftHourlyBudget=1` 时，同一个小时里端口**只该被调 1 次**（小时环真的记了）；
 *   - F6：起草耗掉 40 秒（> 发送 timeout 30 秒）仍然要发得出去（deadline 从入队算起）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import * as path from 'node:path'
import type { ContactConfig } from '../src/config/sections/contact.js'
import type { ContactCandidate, ContactRuntimeFacts } from '../src/features/contact/types.js'
import {
  FakeClock, FakeOutboundQueue, FakePlatform, contactCandidate, contactDelivery, contactRuntime,
  fieldDefaults, tempHome, waitUntil, type TempHome,
} from './fakes/contact.js'

const { CONTACT_GROUPS } = await import('../src/config/sections/contact.js')
const { createHostDraftPort } = await import('../src/features/contact/draft-host.js')
const { draftWithBudget, DRAFT_REASONS } = await import('../src/features/contact/model.js')
const { ContactStore } = await import('../src/features/contact/store.js')
const { ContactSender } = await import('../src/features/contact/sender.js')
const { ContactWorker } = await import('../src/features/contact/worker.js')

const START = Date.UTC(2026, 9, 16, 22, 0, 0)

function config(over: Partial<ContactConfig> = {}): ContactConfig {
  return {
    ...(fieldDefaults(CONTACT_GROUPS) as unknown as ContactConfig),
    enabled: true,
    dryRun: false,
    allowExternalSend: true,
    sendMode: 'direct',
    draftModel: true,
    timezone: 'Asia/Shanghai',
    quietHours: [],
    ...over,
  }
}

/**
 * 假宿主上下文：只提供 `llm.stream` 与默认模型选择。
 *
 * 形状照 `llmSeam` 的用法**推**出来（`draft-host.ts` 只读这两样），所以不需要 cordis。
 */
function fakeHostContext(stream: (input: unknown) => AsyncIterable<{ text?: string }>): unknown {
  return {
    llm: { stream },
    agentDefaultModel: { currentSelection: () => ({ provider: 'mock', model: 'mock-1' }) },
  }
}

/** 一个立刻抛错的流（模拟宿主模型调用失败）。 */
function throwingStream(): (input: unknown) => AsyncIterable<{ text?: string }> {
  return () => ({
    [Symbol.asyncIterator](): AsyncIterator<{ text?: string }> {
      return { next: async () => { throw new Error('host llm exploded') } }
    },
  })
}

/** 一个正常吐出文本的流。 */
function textStream(text: string): (input: unknown) => AsyncIterable<{ text?: string }> {
  return () => ({
    [Symbol.asyncIterator](): AsyncIterator<{ text?: string }> {
      let done = false
      return {
        next: async () => {
          if (done) return { done: true, value: undefined }
          done = true
          return { done: false, value: { text } }
        },
      }
    },
  })
}

/** 一个"多久之后才吐出文本"的流（用来模拟慢草稿，时间由假时钟推进）。 */
function slowStream(clock: FakeClock, delayMs: number, text: string): (input: unknown) => AsyncIterable<{ text?: string }> {
  return () => ({
    [Symbol.asyncIterator](): AsyncIterator<{ text?: string }> {
      let done = false
      return {
        next: async () => {
          if (done) return { done: true, value: undefined }
          done = true
          clock.advance(delayMs)
          return { done: false, value: { text } }
        },
      }
    },
  })
}

function draftInput(over: Partial<{ now: number; recentCalls: number[] }> = {}): {
  candidate: ContactCandidate
  now: number
  recentCalls: number[]
} {
  return {
    candidate: contactCandidate({ id: 'c-draft', earliestAt: START - 60_000, expiresAt: START + 6 * 3_600_000 }),
    now: over.now ?? START,
    recentCalls: over.recentCalls ?? [],
  }
}

function countersFor(): InstanceType<typeof ContactStore>['state']['counters'] {
  return {
    day: '2026-10-17',
    sentTodayGlobal: 0,
    sentTodayByRoom: {},
    lastSentAt: null,
    lastSentAtByRoom: {},
    unansweredStreakByRoom: {},
    draftCallsToday: 0,
    lastDraftFailureAt: null,
    draftFailureStreak: 0,
  }
}

// ── F5：真实端口的失败必须计入退避，且小时环要记这次调用 ─────────────────────

test('F5a 真实 createHostDraftPort + 抛错的宿主流 → draft:failed，失败退避生效（修复前：draft:empty 且 streak=0）', async () => {
  const clock = new FakeClock(START)
  const logs: string[] = []
  const port = createHostDraftPort({
    context: () => fakeHostContext(throwingStream()) as never,
    log: (line: string) => { logs.push(line) },
    clock,
    timeoutMs: () => 20_000,
  })
  const { candidate, now } = draftInput()
  const outcome = await draftWithBudget(port, {
    candidate,
    config: config(),
    counters: countersFor(),
    now,
    recentCalls: [],
  }, { clock, log: (line: string) => { logs.push(line) } })

  assert.equal(outcome.kind, 'none', `抛错不该产出草稿，实际 ${outcome.kind}`)
  assert.equal((outcome as { reason?: string }).reason, 'draft:failed',
    `真实端口抛错必须归成 draft:failed（不是 draft:empty——"没话可说"和"模型挂了"是两件事）：${logs.join(' | ')}`)
  assert.equal(outcome.called, true, '这一次确实向模型发起了请求（called=true），小时环必须记它')
  assert.equal(outcome.counters.draftFailureStreak, 1,
    '连续失败计数必须 +1（修复前被当成成功清零 → 退避永不生效 → 反复调用一个挂掉的模型）')
  assert.notEqual(outcome.counters.lastDraftFailureAt, null, '失败时刻要落盘（退避的起点）')
  assert.equal(outcome.counters.draftCallsToday, 1, '日预算也要 +1（这次调用真的发生了）')
})

test('F5b 真实端口：模型明确 SKIP → 计调用、计预算，但**不算失败**（退避不该被 SKIP 触发）', async () => {
  const clock = new FakeClock(START)
  const port = createHostDraftPort({
    context: () => fakeHostContext(textStream('SKIP')) as never,
    log: () => {},
    clock,
    timeoutMs: () => 20_000,
  })
  const { candidate, now } = draftInput()
  const outcome = await draftWithBudget(port, {
    candidate,
    config: config(),
    counters: countersFor(),
    now,
    recentCalls: [],
  }, { clock, log: () => {} })

  assert.equal(outcome.kind, 'none')
  assert.equal((outcome as { reason?: string }).reason, 'draft:skip', '模型说 SKIP 是"调过但没话可说"')
  assert.equal(outcome.called, true)
  assert.equal(outcome.counters.draftCallsToday, 1)
  assert.equal(outcome.counters.draftFailureStreak, 0, 'SKIP 不是失败，不该把退避推上去')
})

test('F5c 行为级：小时上限=1 时，同一小时内端口只该被调 1 次（修复前 SKIP 不进小时环 → 被调 N 次）', async () => {
  const home = tempHome('qq-draft-ring-')
  try {
    const clock = new FakeClock(START)
    const platform = new FakePlatform({ clock })
    const queue = new FakeOutboundQueue()
    const logs: string[] = []
    const dir = path.join(home.dir, 'channel-qq')
    mkdirSync(dir, { recursive: true })
    const store = new ContactStore({
      file: path.join(dir, 'contact.json'),
      lockFile: path.join(dir, 'contact.lock'),
      hostId: 'host-a', pid: 1001, log: (line: string) => { logs.push(line) }, clock, dayKey: () => '2026-10-17',
    })
    let portCalls = 0
    const port = {
      draft: async () => {
        portCalls += 1
        return { kind: 'skip' as const }
      },
    }
    const runtime = (): ContactRuntimeFacts => contactRuntime({ lastUserMessageAtByRoom: { 'dm-10001': null }, turnRunningByRoom: { 'dm-10001': false } })
    const sender = new ContactSender({
      log: () => {}, clock, transport: () => ({ connected: true, out: queue, api: platform.api }),
      turns: () => ({ bookPrompt: async () => true }), identity: () => ({ personaId: 'nono', worldId: '' }),
      refresh: (id) => ({ candidate: store.candidate(id), runtime: runtime() }), timeoutMs: 30_000,
    })
    const cfg = config({ draftHourlyBudget: 1, draftDailyBudget: 20 })
    const worker = new ContactWorker({
      store, sender, clock, log: (line: string) => { logs.push(line) },
      config: () => cfg,
      roomFacts: () => ({ connected: true, roomBound: true, turnRunning: false, lastUserMessageAt: null }),
      identity: () => ({ personaId: 'nono', worldId: '' }),
      draftPort: port as never,
    })
    try {
      // 三拍：每一拍都只有一条候选（同一条），SKIP 之后候选被 defer，下一拍会再试
      for (let i = 0; i < 3; i += 1) {
        const now = clock.now()
        const candidate = contactCandidate({
          id: 'c-ring', dedupeKey: 'k-ring', state: 'pending',
          earliestAt: now - 60_000, expiresAt: now + 6 * 3_600_000, createdAt: now - 60_000,
        })
        await store.write((ledger) => { ledger.candidates[candidate.id] = candidate; return true })
        await worker.tick(now)
        clock.shift(60_000)
      }
      assert.equal(portCalls, 1,
        `小时上限=1 时端口只该被调 1 次；实际 ${String(portCalls)} 次说明"调过但没草稿"没被记进小时环（F5）`)
    } finally {
      await worker.dispose()
    }
  } finally {
    home.cleanup()
  }
})

// ── F6：慢草稿不该把发送 deadline 吃掉 ──────────────────────────────────────

test('F6 慢草稿（起草耗 40s > 发送 timeout 30s）仍然发得出去（修复前被 deadline 判过期）', async () => {
  const home = tempHome('qq-draft-slow-')
  try {
    const clock = new FakeClock(START)
    const platform = new FakePlatform({ clock })
    const queue = new FakeOutboundQueue()
    const logs: string[] = []
    const dir = path.join(home.dir, 'channel-qq')
    mkdirSync(dir, { recursive: true })
    const store = new ContactStore({
      file: path.join(dir, 'contact.json'),
      lockFile: path.join(dir, 'contact.lock'),
      hostId: 'host-a', pid: 1001, log: (line: string) => { logs.push(line) }, clock, dayKey: () => '2026-10-17',
    })
    const port = createHostDraftPort({
      // 起草过程中把假时钟推进 40 秒：合法的慢草稿（配置允许 draftTimeoutMs=60s）
      context: () => fakeHostContext(slowStream(clock, 40_000, '慢慢想到的一句话')) as never,
      log: (line: string) => { logs.push(line) },
      clock,
      timeoutMs: () => 60_000,
    })
    const runtime = (): ContactRuntimeFacts => contactRuntime({ lastUserMessageAtByRoom: { 'dm-10001': null }, turnRunningByRoom: { 'dm-10001': false } })
    const sender = new ContactSender({
      log: (line: string) => { logs.push(line) }, clock,
      transport: () => ({ connected: true, out: queue, api: platform.api }),
      turns: () => ({ bookPrompt: async () => true }), identity: () => ({ personaId: 'nono', worldId: '' }),
      refresh: (id) => ({ candidate: store.candidate(id), runtime: runtime() }),
      timeoutMs: 30_000,
    })
    const cfg = config({ draftTimeoutMs: 60_000 })
    const worker = new ContactWorker({
      store, sender, clock, log: (line: string) => { logs.push(line) },
      config: () => cfg,
      roomFacts: () => ({ connected: true, roomBound: true, turnRunning: false, lastUserMessageAt: null }),
      identity: () => ({ personaId: 'nono', worldId: '' }),
      draftPort: port,
    })
    try {
      const now = clock.now()
      const candidate = contactCandidate({
        id: 'c-slow', dedupeKey: 'k-slow', state: 'pending',
        earliestAt: now - 60_000, expiresAt: now + 6 * 3_600_000, createdAt: now - 60_000,
      })
      await store.write((ledger) => { ledger.candidates[candidate.id] = candidate; return true })
      await worker.tick(now)

      assert.equal(platform.count(), 1,
        `起草慢但合法，必须发得出去；实际发了 ${String(platform.count())} 条。日志：\n${logs.join('\n')}`)
      assert.equal(store.listDeliveries()[0]?.state, 'confirmed')
      assert.deepEqual(platform.textsTo(10001), ['慢慢想到的一句话'])
    } finally {
      await worker.dispose()
    }
  } finally {
    home.cleanup()
  }
})

// ── R6：调用**之前**就失败不该记模型预算；too-long 要被完整消费 ──────────────

test('R6a 拿不到模型路由（currentSelection 抛错）→ called=false，日预算与失败退避**都不动**', async () => {
  // Codex 第三轮 R6：修复前 `currentSelection()` 在端口内部抛错也会被算成"调过模型"，
  // 于是日预算与失败退避各 +1 —— 明明一个字节都没发出去，模型额度却被扣了，
  // 而且"没配模型路由"这种稳定状态会被记成"连续失败"，把退避推到上限。
  const clock = new FakeClock(START)
  const logs: string[] = []
  const port = createHostDraftPort({
    context: () => ({
      llm: { stream: () => { throw new Error('不该被调用：路由都没有') } },
      agentDefaultModel: { currentSelection: () => { throw new Error('宿主没有默认模型') } },
    }) as never,
    log: (line: string) => { logs.push(line) },
    clock,
    timeoutMs: () => 20_000,
  })
  const { candidate, now } = draftInput()
  const outcome = await draftWithBudget(port, {
    candidate,
    config: config(),
    counters: countersFor(),
    now,
    recentCalls: [],
  }, { clock, log: (line: string) => { logs.push(line) } })

  assert.equal(outcome.kind, 'none')
  // 稳定词：`draft:not-called`（"没发起调用"）。上一轮接口预告里叫过 `draft:no-route`，
  // 实现最终把"取不到接缝/路由"统一收敛成 `draft:not-called`；两个都表示**没调模型**，
  // 所以这里按实际词表断言，同时把 `called=false` 当成更本质的判据。
  assert.equal((outcome as { reason?: string }).reason, 'draft:not-called', `应当是"没发起调用"，实际 ${(outcome as { reason?: string }).reason}：${logs.join(' | ')}`)
  assert.equal(outcome.called, false, 'R6：根本没发起调用，called 必须是 false')
  assert.equal(outcome.counters.draftCallsToday, 0, 'R6：没调用就不该扣日预算（修复前 +1）')
  assert.equal(outcome.counters.draftFailureStreak, 0, 'R6：没调用就不该记失败（修复前 +1）')
  assert.equal(outcome.counters.lastDraftFailureAt, null)
})

test('R6b 端口回 too-long → draft:too-long（不是 draft:empty、也不是成功），并计调用', async () => {
  const clock = new FakeClock(START)
  const port = {
    draft: async () => ({ kind: 'too-long' as const, detail: '超过 120 字' }),
  }
  const { candidate, now } = draftInput()
  const outcome = await draftWithBudget(port, {
    candidate,
    config: config({ draftMaxChars: 120 }),
    counters: countersFor(),
    now,
    recentCalls: [],
  }, { clock, log: () => {} })

  assert.equal(outcome.kind, 'none')
  assert.equal((outcome as { reason?: string }).reason, 'draft:too-long', 'R6：七态里的 too-long 要原样落成 draft:too-long')
  assert.equal(outcome.called, true, '调用真的发生了（只是文本超长）')
  assert.equal(outcome.counters.draftCallsToday, 1, '超长也算一次调用（预算是按调用算的）')
})

// ── R7：执行点自然过期 → 候选终态是 expired（不是 cancelled） ────────────────

test('R7 候选在队列等待期间自然过期 → 零 sendTo，且候选终态是 `expired`（不是 `cancelled`）', async () => {
  // 第三轮 Codex R7：执行点把"自然过期"写成 `cancelled`，与门控的 `drop(expired)` 漂移，
  // 事后看账本分不清"这件事过期了"和"有人取消了它"。要在 direct 模式下测：候选先被领取，
  // 然后**在出站队列的等待窗口里**跨过 `expiresAt`。
  const home = tempHome('qq-draft-expire-')
  try {
    const clock = new FakeClock(START)
    const platform = new FakePlatform({ clock })
    const queue = new FakeOutboundQueue()
    const logs: string[] = []
    const dir = path.join(home.dir, 'channel-qq')
    mkdirSync(dir, { recursive: true })
    const store = new ContactStore({
      file: path.join(dir, 'contact.json'),
      lockFile: path.join(dir, 'contact.lock'),
      hostId: 'host-a', pid: 1001, log: (line: string) => { logs.push(line) }, clock, dayKey: () => '2026-10-17',
    })
    const runtime = (): ContactRuntimeFacts => contactRuntime({
      lastUserMessageAtByRoom: { 'dm-10001': null }, turnRunningByRoom: { 'dm-10001': false },
    })
    const sender = new ContactSender({
      log: (line: string) => { logs.push(line) }, clock,
      transport: () => ({ connected: true, out: queue, api: platform.api }),
      turns: () => ({ bookPrompt: async () => true }), identity: () => ({ personaId: 'nono', worldId: '' }),
      refresh: (id) => ({ candidate: store.candidate(id), runtime: runtime() }),
      timeoutMs: 30_000,
    })
    const worker = new ContactWorker({
      store, sender, clock, log: (line: string) => { logs.push(line) },
      config: () => config(),
      roomFacts: () => ({ connected: true, roomBound: true, turnRunning: false, lastUserMessageAt: null }),
      identity: () => ({ personaId: 'nono', worldId: '' }),
      draftPort: { draft: async () => ({ kind: 'draft' as const, text: '快了快了', route: 'fake' }) },
    })
    try {
      const now = clock.now()
      const candidate = contactCandidate({
        id: 'c-exp', dedupeKey: 'k-exp', state: 'pending',
        earliestAt: now - 60_000, expiresAt: now + 900, createdAt: now - 60_000,
      })
      await store.write((ledger) => { ledger.candidates[candidate.id] = candidate; return true })

      queue.hold = true
      const ticking = worker.tick(now)
      await waitUntil(() => queue.pending() === 1, 3_000)
      clock.advance(1_200) // 队列等待期间跨过 expiresAt
      await queue.release()
      await ticking

      assert.equal(platform.count(), 0, `过期之后不该再发，日志：\n${logs.join('\n')}`)
      const settled = store.candidate('c-exp')
      assert.equal(
        settled?.state, 'expired',
        `R7：自然过期的终态必须是 \`expired\`（与门控 drop(expired) 一致），实际 ${settled?.state}`,
      )
      // P2-3：抑制原因与**门控同口径**（阶段信息只在日志/投递 detail 里）。
      // 修复前这里是 `expired:at-send`，于是后台看到"同一条候选，两种原因"。
      assert.equal(
        settled?.lastSuppressedReason, 'expired',
        `P2-3：候选的抑制原因要与门控同口径（\`expired\`），实际 ${String(settled?.lastSuppressedReason)}`,
      )
    } finally {
      queue.hold = false
      await worker.dispose()
    }
  } finally {
    home.cleanup()
  }
})

test('F5d DRAFT_REASONS 词表包含 F5 新增的两个稳定词（draft:skip / draft:no-route）', () => {
  assert.ok(DRAFT_REASONS.includes('draft:skip'), '`draft:skip` 必须在词表里（"调过但模型说算了"）')
  assert.ok(DRAFT_REASONS.includes('draft:no-route'), '`draft:no-route` 必须在词表里（"没发起调用"）')
  for (const reason of DRAFT_REASONS) {
    assert.match(reason, /^[a-z][a-z0-9-]*(?::[a-z0-9-]+)?$/, `reason 必须是稳定短串：${reason}`)
  }
})
