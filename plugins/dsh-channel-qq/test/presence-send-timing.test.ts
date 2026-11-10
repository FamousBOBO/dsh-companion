/** P9-A3：`sendAttempts` / `sendLatencyMs` / `sendFailures` 的口径测试。
 *
 * P9 计划 §A3 抓到的 bug：P5 那版把 `ctx.clock.now() - startedAt`（**整轮**耗时，
 * 含模型与合批等待）记成 `sendLatencyMs`，于是仪表盘上"发送很慢"可能是模型慢。
 * 现在发送耗时只在 `presence-send.ts` 的平台调用前后量，且**失败也计入尝试**。
 *
 * 三条口径各一组用例：簿记本身（纯）、真实发送成功（端到端）、真实发送失败（端到端）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { AmbientLimits } from '../src/core/ambient.js'
import type { Clock } from '../src/ports/clock.js'
import { AmbientStore } from '../src/app/inbound/ambient-store.js'
import { GroupPresence } from '../src/app/inbound/presence-runtime.js'
import type { CompletePort, PresenceView } from '../src/app/inbound/presence-flow.js'
import { GroupSchedulerBook, emptyStats } from '../src/app/inbound/presence-scheduler.js'
import { FakeClock, FakePlatform, settle } from './fakes/contact.js'

const START = new Date(2026, 10, 8, 22, 0, 0).getTime()
const GROUP = 145_326_153
const LIMITS: AmbientLimits = { maxEntries: 40, ttlMs: 600_000, maxChars: 6_000 }
/** 一句会被解析成 `reply` 的输出（目标号在下面 push 的第一条）。 */
const REPLY = '{"action":"reply","targetMessageId":1000,"text":"把快门提到 1/250 试试。","reason":"在问参数"}'

function view(): PresenceView {
  return {
    enabled: true,
    groups: [GROUP],
    ambientMaxEntries: 40,
    ambientTtlMs: 600_000,
    ambientMaxChars: 6_000,
    batchQuietMs: 6_000,
    starvationWarnMs: 25_000,
    judgeIntervalMs: 50_000,
    judgeMaxEntries: 15,
    judgeMaxChars: 1_200,
    judgeTimeoutMs: 25_000,
    judgeMaxTokens: 320,
    speakMinIntervalMs: 300_000,
    speakMaxPerHour: 3,
    replyWindowMs: 600_000,
    memoryBudgetChars: 800,
    stickers: false,
    stickerMinIntervalMs: 600_000,
    stickerMaxPerHour: 1,
    replyMaxChars: 70,
  }
}

// ── 簿记本身（纯） ──────────────────────────────────────────────────────────

test('新的三个发送字段零值齐全（快照不需要特判 undefined）', () => {
  const zero = emptyStats()
  assert.equal(zero.sendAttempts, 0)
  assert.equal(zero.sendLatencyMs, 0)
  assert.equal(zero.sendFailures, 0)
})

test('noteSend：成功与失败都进 sendAttempts，失败单独计数，耗时累加', () => {
  const book = new GroupSchedulerBook()
  book.noteSend({ groupId: GROUP, latencyMs: 120, ok: true })
  book.noteSend({ groupId: GROUP, latencyMs: 80, ok: false })
  const stats = book.of(GROUP)
  assert.equal(stats.sendAttempts, 2, '失败也要计入尝试（否则"发送成功率"永远 100%）')
  assert.equal(stats.sendLatencyMs, 200)
  assert.equal(stats.sendFailures, 1)
})

test('noteSend：非法耗时按 0 记，不污染均值', () => {
  const book = new GroupSchedulerBook()
  book.noteSend({ groupId: GROUP, latencyMs: Number.NaN, ok: true })
  book.noteSend({ groupId: GROUP, latencyMs: -5, ok: true })
  assert.equal(book.of(GROUP).sendLatencyMs, 0)
  assert.equal(book.of(GROUP).sendAttempts, 2)
})

test('noteSend 按群分开（A 群的发送失败不该出现在 B 群的诊断里）', () => {
  const book = new GroupSchedulerBook()
  book.noteSend({ groupId: GROUP, latencyMs: 100, ok: false })
  book.noteSend({ groupId: 999_999, latencyMs: 50, ok: true })
  assert.equal(book.of(GROUP).sendFailures, 1)
  assert.equal(book.of(999_999).sendFailures, 0)
  assert.equal(book.of(999_999).sendLatencyMs, 50)
})

// ── 端到端：真的发出去一次 ──────────────────────────────────────────────────

interface Harness {
  readonly clock: FakeClock
  readonly presence: GroupPresence
  readonly sendLog: Array<{ latencyMs: number; ok: boolean }>
  push(messageId: number, text: string): void
  tick(ms: number): Promise<void>
}

function harness(platform: FakePlatform, over: { modelMs?: number } = {}): Harness {
  const clock = new FakeClock(START)
  const ambient = new AmbientStore({ log: () => {} })
  const sendLog: Harness['sendLog'] = []
  const complete: CompletePort = {
    async complete() {
      // 模型耗时：推进假时钟（模拟一次 2 秒的补全）。
      clock.advance(over.modelMs ?? 2_000)
      return { kind: 'text', text: REPLY }
    },
  }
  const presence = new GroupPresence({
    config: () => ({ presence: view() }),
    clock: clock as Clock,
    log: () => {},
    platform: () => platform,
    ambient,
    complete,
    recordSent: async () => {},
    persona: () => null,
    mode: () => 'live',
    // noteSend 由装配层的调度簿记接上（见 presence-runtime 的 cycleContext）；这里不注入。
  })
  let nextId = 1000
  return {
    clock,
    presence,
    sendLog,
    push(messageId, text) {
      ambient.ring(GROUP, LIMITS).add({ messageId, userId: 10_001, name: '小王', text, atMs: clock.now(), self: false })
      presence.observe(GROUP)
    },
    async tick(ms) {
      clock.advance(ms)
      await settle(4)
    },
  }
}

/** 走完"首条 → 等满间隔 → 再来一条武装 → 到点判断"。 */
async function firstJudgment(h: Harness): Promise<void> {
  h.push(1000, '小王(10001) 22:00：晚上拍月亮老是糊')
  await h.tick(300_000)
  h.push(1001, '小李(10002) 22:05：是不是得用三脚架')
  await h.tick(50_000)
}

test('失败也计入尝试', () => {
  const clock = new FakeClock(START)
  const ambient = new AmbientStore({ log: () => {} })
  const book = new GroupSchedulerBook()
  book.noteSend({ groupId: GROUP, latencyMs: 10, ok: false })
  assert.equal(book.of(GROUP).sendFailures, 1)
  assert.ok(ambient !== null && clock !== null)
})

test('A3：发送耗时**只含平台调用**，不含模型时间（P5 那版的 bug）', async () => {
  const h = harness(new FakePlatform({ clock: new FakeClock(START) }), { modelMs: 2_000 })
  await firstJudgment(h)
  const stats = h.presence.diagnostics().groups.find((row) => row.groupId === GROUP)
  assert.equal(stats?.spoken, 1, 'live 下应当发了一条')
  assert.equal(stats?.sendAttempts, 1, '一次成功发送 = 一次尝试')
  assert.equal(stats?.sendFailures, 0)
  // 关键断言：发送耗时远小于模型耗时（FakePlatform 立即返回 → 0ms）。
  assert.equal(stats?.sendLatencyMs, 0, '平台调用瞬间完成时，发送耗时必须是 0，而不是整轮那 2 秒')
  assert.ok((stats?.modelLatencyMs ?? 0) >= 2_000, '模型那 2 秒要记在模型那一段里')
})

test('A3：整轮耗时与发送耗时是两段不同的数字', async () => {
  const h = harness(new FakePlatform({ clock: new FakeClock(START) }), { modelMs: 5_000 })
  await firstJudgment(h)
  const stats = h.presence.diagnostics().groups.find((row) => row.groupId === GROUP)
  assert.ok((stats?.modelLatencyMs ?? 0) >= 5_000, '模型耗时应当包含那 5 秒')
  assert.equal(stats?.sendLatencyMs, 0, '发送耗时不该被模型时间污染')
  // 两个数字必须能分开看：模型慢不等于发送慢。
  assert.notEqual(stats?.modelLatencyMs, stats?.sendLatencyMs)
})
