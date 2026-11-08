/** 每群连续性（P7-A）与合批等待（P7-B）的测试。
 *
 * 这一组只回答两个问题：
 *   1. **两个群同时活跃时，每个群各读各的**（P7-A：旧的"唯一活跃群"降级在这里会失败）；
 *   2. **等待上限与饥饿告警的名字与行为对得上**（P7-B：`starvationWarnMs` 只报警、不改调度）。
 *
 * 纪律与其它 presence 测试一致：不发真 QQ、不调真模型、不读真库；时间由 `FakeClock` 推进。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { GroupTimelineBook } from '../src/app/inbound/presence-timeline.js'
import { groupContinuityBlock, CONTINUITY_MAX_CHARS } from '../src/app/inbound/group-continuity-block.js'
import { quietWaitMs, starvedOf, starvationWarnMs } from '../src/app/inbound/presence-cadence.js'
import { sentLinesOf, personaSnapshotOf } from '../src/app/inbound/presence-reads.js'
import type { PresenceView } from '../src/app/inbound/presence-flow.js'
import type { Clock } from '../src/ports/clock.js'
import { FakeClock } from './fakes/contact.js'

const T0 = new Date(2026, 10, 8, 21, 0, 0).getTime()
const GROUP_A = 145_326_153
const GROUP_B = 1_003_000

function book(): GroupTimelineBook {
  return new GroupTimelineBook(new FakeClock(T0) as Clock)
}

/** 一份完整可用的 `presence` 视图（缺席字段按默认值补，便于只覆盖要测的那一项）。 */
function view(over: Partial<PresenceView> = {}): PresenceView {
  return {
    enabled: true,
    groups: [GROUP_A],
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
    ...over,
  }
}

let seq = 0

/** 往某个群的时间线里塞一条入站消息。 */
function say(b: GroupTimelineBook, groupId: number, messageId: number, text: string, senderId = 10_001): void {
  seq += 1
  b.markInbound(groupId, {
    seq,
    messageId,
    userId: senderId,
    name: '小王',
    text,
    atMs: T0,
    self: false,
  })
}

// ── P7-A：按群号查询 ────────────────────────────────────────────────────────

test('两个群同时活跃：各读各的记录与自述（旧的唯一活跃群降级会两边都读不到）', () => {
  const b = book()
  say(b, GROUP_A, 501, '这周末去爬山吗')
  say(b, GROUP_B, 601, '显卡又涨价了')
  b.recordSelf(GROUP_A, { kind: 'proactive_message', messageId: 9001, text: '我去过那条线', atMs: T0 })
  b.recordSelf(GROUP_B, { kind: 'proactive_message', messageId: 9002, text: '等等再买吧', atMs: T0 })
  const view = b.scopedView()
  // 关键断言：两个群都 valid —— 这正是旧口径（唯一活跃群才给数据）失败的地方。
  assert.equal(view.detail(GROUP_A).valid, true)
  assert.equal(view.detail(GROUP_B).valid, true)
  assert.ok(view.detail(GROUP_A).events > 0)
  assert.ok(view.detail(GROUP_B).events > 0)
  // 而且两份数据不串：A 群看不到 B 群那句，反之亦然。
  assert.deepEqual(view.recentSelf(GROUP_A, 3).map((row) => row.text), ['我去过那条线'])
  assert.deepEqual(view.recentSelf(GROUP_B, 3).map((row) => row.text), ['等等再买吧'])
})

test('按群号查询：没有时间线的群返回空，不是"退回到最近活跃的那个群"', () => {
  const b = book()
  say(b, GROUP_A, 501, '随便聊聊')
  const view = b.scopedView()
  assert.deepEqual(view.recentSelf(GROUP_B, 3), [])
  assert.equal(view.topic(GROUP_B), null)
  assert.deepEqual(view.detail(GROUP_B), { valid: false, events: 0 })
})

test('按群号查询：非法群号一律拒绝（不猜、不落到 String(id)）', () => {
  const b = book()
  say(b, GROUP_A, 501, '随便聊聊')
  const view = b.scopedView()
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(view.recentSelf(bad, 3), [], `群号 ${String(bad)} 应当被拒绝`)
    assert.equal(view.topic(bad), null)
    assert.equal(view.detail(bad).valid, false)
  }
  // 19 位 QQ 号超过安全整数：宁可返回空，也不要拿一个不准确的号去查。
  assert.equal(view.detail(Number.MAX_SAFE_INTEGER + 2).valid, false)
})

test('她自己说过的话只出现在那个群（不跨群复用）', () => {
  const b = book()
  b.recordSelf(GROUP_A, { kind: 'proactive_message', messageId: 9001, text: '我去过那条线', atMs: T0 })
  const view = b.scopedView()
  assert.equal(view.recentSelf(GROUP_A, 3).length, 1)
  assert.equal(view.recentSelf(GROUP_B, 3).length, 0, 'B 群不该看到 A 群的自述')
})

// ── P7-A：组包里的连续性块 ─────────────────────────────────────────────────

test('连续性块：空视图 / 非法群号 → 空串（组包产物与 P6 逐字节一致）', () => {
  assert.equal(groupContinuityBlock({ groupId: GROUP_A, view: null }), '')
  const b = book()
  assert.equal(groupContinuityBlock({ groupId: GROUP_A, view: b.scopedView() }), '', '没有记录就不该有这一段')
  say(b, GROUP_A, 501, '随便聊聊')
  assert.equal(groupContinuityBlock({ groupId: 0, view: b.scopedView() }), '')
})

test('连续性块：有话题时带标题与条数，且**不含**她自己的原话（去重交给 sentBlock）', () => {
  const b = book()
  say(b, GROUP_A, 501, '这周末去爬山吗')
  say(b, GROUP_A, 502, '我想去四姑娘山')
  b.recordSelf(GROUP_A, { kind: 'proactive_message', messageId: 9001, text: '我去年走过那条线', atMs: T0 + 1_000 })
  const block = groupContinuityBlock({ groupId: GROUP_A, view: b.scopedView() })
  assert.ok(block.length > 0)
  assert.match(block, /这个群的近期上下文/)
  assert.ok(!block.includes('我去年走过那条线'), '她自己的原话不该在这段里出现（sentBlock 已经有一份）')
})

test('连续性块有字数上限（上下文不是资料库）', () => {
  const b = book()
  for (let i = 0; i < 40; i += 1) say(b, GROUP_A, 500 + i, '第' + String(i) + '句话，' + '很长的内容'.repeat(6))
  const block = groupContinuityBlock({ groupId: GROUP_A, view: b.scopedView() })
  assert.ok([...block].length <= CONTINUITY_MAX_CHARS)
})

test('连续性块：视图抛错时返回空串（绝不把组包弄崩）', () => {
  const block = groupContinuityBlock({
    groupId: GROUP_A,
    view: {
      recentSelf: () => { throw new Error('boom') },
      topic: () => { throw new Error('boom') },
      detail: () => { throw new Error('boom') },
    },
  })
  assert.equal(block, '')
})

// ── P7-B：合批等待与饥饿告警 ────────────────────────────────────────────────

test('等待时长就是 batchQuietMs（缺省退回判断间隔，旧配置行为不变）', () => {
  assert.equal(quietWaitMs(view({ batchQuietMs: 6_000, judgeIntervalMs: 50_000 })), 6_000)
  // 显式把安静窗口设成"没有"：只有这时才退回判断间隔。
  const noQuiet = view({ judgeIntervalMs: 50_000 })
  delete (noQuiet as { batchQuietMs?: number }).batchQuietMs
  assert.equal(quietWaitMs(noQuiet), 50_000, '没配安静窗口时退回判断间隔')
  // 0 算"没配"：退回默认的 6 秒（间隔类参数的安全方向是"按默认来"，与额度类相反）。
  assert.equal(quietWaitMs(view({ batchQuietMs: 0, judgeIntervalMs: 50_000 })), 6_000)
})

test('饥饿告警阈值：读配置、缺省 25 秒、0/负数退回默认', () => {
  assert.equal(starvationWarnMs(view({ starvationWarnMs: 12_000 })), 12_000)
  assert.equal(starvationWarnMs(view({ starvationWarnMs: undefined })), 25_000)
  assert.equal(starvationWarnMs(null), 25_000, '配置取不到也要有个阈值')
  assert.equal(starvationWarnMs(view({ starvationWarnMs: 0 })), 25_000)
  assert.equal(starvationWarnMs(view({ starvationWarnMs: -1 })), 25_000)
})

test('饿着 = 有内容 + 已等超阈值；没内容时"等了很久"没有意义', () => {
  const base = { nowMs: T0 + 30_000, batchStartedAtMs: T0, warnMs: 25_000 }
  assert.equal(starvedOf({ ...base, pending: 3 }), true)
  assert.equal(starvedOf({ ...base, pending: 0 }), false, '没人说话就不叫饿')
  assert.equal(starvedOf({ ...base, batchStartedAtMs: 0, pending: 3 }), false, '批次没起算就不叫饿')
  assert.equal(starvedOf({ nowMs: T0 + 10_000, batchStartedAtMs: T0, warnMs: 25_000, pending: 3 }), false)
})

// ── P7-B：读侧降级 ──────────────────────────────────────────────────────────

test('她说过什么：时间线优先，时间线空了才退回旁听环', () => {
  assert.deepEqual(
    sentLinesOf({ groupId: GROUP_A, fromTimeline: () => ['时间线里的'], fallback: ['兜底的'], limit: 6 }),
    ['时间线里的'],
  )
  assert.deepEqual(
    sentLinesOf({ groupId: GROUP_A, fromTimeline: () => [], fallback: ['兜底的'], limit: 6 }),
    ['兜底的'],
  )
  assert.deepEqual(
    sentLinesOf({
      groupId: GROUP_A,
      fromTimeline: () => { throw new Error('时间线坏了') },
      fallback: ['兜底的'],
      limit: 6,
    }),
    ['兜底的'],
    '时间线抛错也要有兜底',
  )
})

test('人格快照取不到时返回 null 并留一行日志（不静默）', () => {
  const logs: string[] = []
  assert.equal(personaSnapshotOf({ groupId: GROUP_A, persona: () => null, log: (l) => logs.push(l) }), null)
  assert.equal(logs.length, 1)
  assert.match(logs[0] ?? '', /人格快照不可用/)
})

test('人格快照提供者抛错时也只降级，不把判断路径弄崩', () => {
  const logs: string[] = []
  const snapshot = personaSnapshotOf({
    groupId: GROUP_A,
    persona: () => { throw new Error('boom') },
    log: (l) => logs.push(l),
  })
  assert.equal(snapshot, null)
  assert.match(logs[0] ?? '', /抛错/)
})
