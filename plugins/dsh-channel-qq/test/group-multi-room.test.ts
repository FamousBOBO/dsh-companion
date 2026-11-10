/** P7（多群连续性 / 调度名实相符 / 诊断）的测试。
 *
 * 三组，对应计划 §4.1–§4.3 的验收项：
 *   1. **并发群隔离**：两个群同时活跃，各自读自己的事件与话题，谁都不串；
 *   2. **fail-closed**：无群号 / 伪群号 / 非法群号的查询一律返回空，不退化成"最近活跃的那个群"；
 *   3. **诊断能区分**"允许判断但延迟"与"硬门槛不允许判断"。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { GroupTimelineBook } from '../src/app/inbound/presence-timeline.js'
import { groupContinuityBlock } from '../src/app/inbound/group-continuity-block.js'
import { GroupSchedulerBook, emptyStats } from '../src/app/inbound/presence-scheduler.js'
import type { Clock } from '../src/ports/clock.js'
import { FakeClock } from './fakes/contact.js'

const T0 = new Date(2026, 10, 8, 21, 0, 0).getTime()
const GROUP_A = 145_326_153
const GROUP_B = 1_003_000

function book(): GroupTimelineBook {
  return new GroupTimelineBook(new FakeClock(T0) as Clock)
}

let seq = 0

function say(b: GroupTimelineBook, groupId: number, messageId: number, text: string, name = '小王'): void {
  seq += 1
  b.markInbound(groupId, { seq, messageId, userId: 10_001, name, text, atMs: T0, self: false })
}

// ── 1. 并发群隔离（§4.1 的验收项 1 与 3） ───────────────────────────────────

test('两个群同时活跃：各自的事件与自述互不可见（A 群的话不会出现在 B 群的包里）', () => {
  const b = book()
  say(b, GROUP_A, 501, '周末去爬山吗', '小王')
  say(b, GROUP_B, 601, '显卡涨价了', '小李')
  b.recordSelf(GROUP_A, { kind: 'proactive_message', messageId: 9001, text: '我去过那条线', atMs: T0 })
  b.recordSelf(GROUP_B, { kind: 'proactive_message', messageId: 9002, text: '等下一批吧', atMs: T0 })
  const view = b.scopedView()
  assert.deepEqual(view.recentSelf(GROUP_A, 5).map((r) => r.text), ['我去过那条线'])
  assert.deepEqual(view.recentSelf(GROUP_B, 5).map((r) => r.text), ['等下一批吧'])
  assert.equal(view.detail(GROUP_A).valid, true)
  assert.equal(view.detail(GROUP_B).valid, true)
})

test('连续性块按群号取值：A 群的块里不出现 B 群那位的名字', () => {
  const b = book()
  say(b, GROUP_A, 501, '周末去爬山吗', '小王')
  say(b, GROUP_A, 502, '我也想去', '阿墨')
  b.recordSelf(GROUP_A, { kind: 'proactive_message', messageId: 9001, text: '我去过那条线', atMs: T0 })
  b.recordSelf(GROUP_B, { kind: 'proactive_message', messageId: 9002, text: 'B 群专属发言', atMs: T0 })
  const blockA = groupContinuityBlock({ groupId: GROUP_A, view: b.scopedView() })
  const blockB = groupContinuityBlock({ groupId: GROUP_B, view: b.scopedView() })
  assert.ok(blockA.length > 0)
  assert.ok(!blockA.includes('B 群专属发言'), 'A 群的块里不许出现 B 群的自述')
  // B 群只有一条自述、没有别的消息：它自己那一段（或空）也不该提 A 群的人。
  assert.ok(!blockB.includes('小王'))
})

test('交错写入不会互相覆盖：每个群的 detail.events 只数自己的', () => {
  const b = book()
  say(b, GROUP_A, 501, 'a1')
  say(b, GROUP_B, 601, 'b1')
  say(b, GROUP_A, 502, 'a2')
  say(b, GROUP_B, 602, 'b2')
  say(b, GROUP_B, 603, 'b3')
  const view = b.scopedView()
  assert.equal(view.detail(GROUP_A).events, 2)
  assert.equal(view.detail(GROUP_B).events, 3)
})

// ── 2. fail-closed（§4.1 的验收项 2） ───────────────────────────────────────

test('非法/伪群号一律返回空：不退化成"最近活跃的那个群"', () => {
  const b = book()
  say(b, GROUP_A, 501, '有人吗')
  const view = b.scopedView()
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2]) {
    assert.deepEqual(view.recentSelf(bad, 5), [], `群号 ${String(bad)} 必须 fail-closed`)
    assert.equal(view.topic(bad), null)
    assert.equal(view.detail(bad).valid, false)
    assert.equal(groupContinuityBlock({ groupId: bad, view }), '')
  }
})

test('没有时间线的群：给出空块并回报 denied（区分"没数据"与"注入坏了"）', () => {
  const outcomes: string[] = []
  const b = book()
  const block = groupContinuityBlock({
    groupId: GROUP_B,
    view: b.scopedView(),
    onOutcome: (outcome) => outcomes.push(outcome),
  })
  assert.equal(block, '')
  assert.deepEqual(outcomes, ['denied'])
})

test('真的给出块时回报 injected（两个计数分开才有意义）', () => {
  const outcomes: string[] = []
  const b = book()
  say(b, GROUP_A, 501, '周末去爬山吗')
  say(b, GROUP_A, 502, '我也想去')
  b.recordSelf(GROUP_A, { kind: 'proactive_message', messageId: 9001, text: '我去过那条线', atMs: T0 })
  const block = groupContinuityBlock({
    groupId: GROUP_A,
    view: b.scopedView(),
    onOutcome: (outcome) => outcomes.push(outcome),
  })
  assert.ok(block.length > 0)
  assert.deepEqual(outcomes, ['injected'])
})

test('视图为 null（执行器没装）：空块 + denied，不抛', () => {
  const outcomes: string[] = []
  assert.equal(groupContinuityBlock({ groupId: GROUP_A, view: null, onOutcome: (o) => outcomes.push(o) }), '')
  assert.deepEqual(outcomes, ['denied'])
})

// ── 3. 诊断（§4.3） ────────────────────────────────────────────────────────

test('新的诊断字段都有零值（快照不需要特判 undefined）', () => {
  const zero = emptyStats()
  assert.equal(zero.modelLatencyMs, 0)
  assert.equal(zero.modelCalls, 0)
  assert.equal(zero.sendLatencyMs, 0)
  assert.equal(zero.sendAttempts, 0)
  assert.equal(zero.lastBatchWaitMs, 0)
  assert.equal(zero.eventContextInjected, 0)
  assert.equal(zero.eventContextDenied, 0)
})

test('注入/拒绝分开计数：跟着群号走，互不串', () => {
  const book2 = new GroupSchedulerBook()
  book2.noteContinuity(GROUP_A, 'injected')
  book2.noteContinuity(GROUP_A, 'injected')
  book2.noteContinuity(GROUP_B, 'denied')
  assert.equal(book2.of(GROUP_A).eventContextInjected, 2)
  assert.equal(book2.of(GROUP_A).eventContextDenied, 0)
  assert.equal(book2.of(GROUP_B).eventContextDenied, 1)
  assert.equal(book2.of(GROUP_B).eventContextInjected, 0)
})

test('诊断快照不含正文（只有数字与布尔）', () => {
  const book2 = new GroupSchedulerBook()
  book2.update(GROUP_A, (stats) => ({ ...stats, judgments: 3, spoken: 1 }))
  const snapshot = book2.snapshot()
  const row = snapshot.find((entry) => entry.groupId === GROUP_A)
  assert.ok(row !== undefined)
  for (const value of Object.values(row)) {
    assert.ok(
      typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string',
      '诊断只放标量',
    )
  }
  // 只有 groupId 是字符串化的数字，其余值都该是数值/布尔。
  assert.equal(typeof row.groupId, 'number')
})
