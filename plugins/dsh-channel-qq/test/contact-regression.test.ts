import { expectOk, expectRejected } from './fakes/reminders.js'
/** 回归 + 现状基线：**谁可能重复发消息**，以及主动消息引入前后这些路径必须不变。
 *
 * 本文件回答两个问题：
 *   1. **配置写错时，主动行为往哪个方向失败？**——`proactive/checkedBook` 曾把不合法的
 *      事件书退回 `defaultEventBook()`，而那本默认书里 `patrol` / `morning-report` /
 *      `dream` / `evolve` / `dm-visit` 全是 `enabled: true`：配置写错换来的是**更多**
 *      外发。现在必须是空书安全停用。这条以前零覆盖（`proactive-v2.test.ts` 只测了
 *      默认书本身合法），所以回归风险最高。
 *   2. **同一时刻有几条路会往外发？**——到期提醒（直发）、主动回合（事件书）、
 *      被动回复（工具）。三者的归属必须在测试里写死，否则新加的 contact 很容易
 *      变成"第四条路"，同一句话发两遍。
 *
 * 全部用假件：假时钟、假平台、假回合、临时 dshHome。不连网络、不调模型、不发真 QQ。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { QQChannelConfig } from '../src/config.js'
import type { OneBotMessage } from '../src/types.js'
import type { PlatformParts } from '../src/features/plugin-kit.js'
import {
  FakeClock, FakePlatform, FakeRegistry, FakeTurns, baseConfig, fakeSubHost, segmentText, settle, tempHome,
} from './fakes/contact.js'

const { defaultEventBook, parseEventBook } = await import('../src/core/schedule/event-book.js')
const { proactivePlugin } = await import('../src/features/proactive/index.js')
const { remindersPlugin } = await import('../src/features/reminders/index.js')
const { ReminderRunner } = await import('../src/features/reminders/runner.js')
const { ReminderStore } = await import('../src/features/reminders/store.js')
const { createQQApi } = await import('../src/adapters/onebot/qq-api.js')
const { fakeClient } = await import('./fakes/host.js')
const { OutboundQueue } = await import('../src/outbound.js')

// ── 公共脚手架 ──────────────────────────────────────────────────────────────

/** `PluginEffect` 归一成一个可 await 的卸载器。 */
async function mountProactive(book: unknown, options: { config?: Partial<QQChannelConfig> } = {}): Promise<{
  turns: FakeTurns
  logs: string[]
  home: ReturnType<typeof tempHome>
  dispose(): Promise<void>
}> {
  const home = tempHome('qq-proactive-')
  const clock = new FakeClock(new Date(2026, 9, 17, 22, 10, 0))
  const turns = new FakeTurns(clock)
  const registry = new FakeRegistry()
  const config = baseConfig({ proactive: { v2: true, book }, ...(options.config ?? {}) })
  const sub = fakeSubHost('proactive', config, home.dir)
  sub.with('inbound', { registry, turns, notices: {}, pipeline: {} } as never)
  sub.with('persona', { pack: {}, composer: { render: (key: string) => key } } as never)
  const effect = await proactivePlugin.apply(sub.host)
  const dispose = typeof effect === 'function' ? effect : (): void => {}
  await proactivePlugin.start?.(sub.host)
  await settle()
  return {
    turns,
    logs: sub.logs,
    home,
    dispose: async () => {
      await dispose()
      home.cleanup()
    },
  }
}

/** 一个"立即执行"的出站队列（限速与重试不参与本文件的断言）。 */
function immediateOut(): PlatformParts['out'] {
  return { push: async <T>(fn: () => Promise<T>): Promise<T> => fn() } as unknown as PlatformParts['out']
}

/** 把 runner 的 `setInterval` 抓住（`ReminderRunner` 不接时钟——见审查发现 V-R3）。 */
function captureIntervals(): { fire(): void; cleared(): number; restore(): void } {
  const originalSet = globalThis.setInterval
  const originalClear = globalThis.clearInterval
  let fn: (() => void) | null = null
  let clearCount = 0
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).setInterval = (callback: () => void): unknown => { fn = callback; return { unref(): void {} } }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).clearInterval = (): void => { clearCount += 1 }
  return {
    fire: () => { fn?.() },
    cleared: () => clearCount,
    restore: () => {
      globalThis.setInterval = originalSet
      globalThis.clearInterval = originalClear
    },
  }
}

// ── R01/R02：坏配置的失败姿态 ───────────────────────────────────────────────

/** 一本"看起来像那么回事、其实写错了"的书：`intervall` 是拼错的字段。 */
const TYPO_BOOK = {
  version: 1,
  events: [{
    id: 'dm-visit', enabled: true, kind: 'prompt',
    trigger: { type: 'interval', everyMin: 22, intervall: 1, jitterMin: 1.5, runOnBoot: true },
    quietHours: [], target: 'master-dm', template: 'events/dm-visit',
    materials: [], requires: [],
  }],
}

test('R01 事件书不合法：空书安全停用（零事件、零回合），绝不退回会外发的默认书', async () => {
  // 先把"退回默认书有多危险"写进断言：默认书里开着 5 条以上会主动外发的事件。
  const defaultOn = defaultEventBook().events.filter((event) => event.enabled)
  assert.ok(defaultOn.length >= 5, '默认书里启用的事件数变了，这条回归的前提要一起看')
  assert.deepEqual(
    ['patrol', 'morning-report', 'dream', 'evolve', 'dm-visit'].every((id) => defaultOn.some((event) => event.id === id)),
    true,
    '默认书里的五条主动外发事件必须都还标着 enabled——正因为如此，退回它是危险姿态',
  )

  // 前提：这本书确实不合法（否则本用例测的是别的分支）。
  assert.equal(parseEventBook(TYPO_BOOK).ok, false)

  const harness = await mountProactive(TYPO_BOOK)
  try {
    // 1) 执行器起来时是 0 事件、0 启用——这是"安全停用"的可观测证据。
    assert.ok(
      harness.logs.some((line) => line.includes('events: executor started, 0 events (0 on)')),
      `执行器必须以空书启动：\n${harness.logs.join('\n')}`,
    )
    // 2) 具名日志：说清楚"不合法 + 按空书停用"，不是静悄悄地什么都不做。
    const complaint = harness.logs.find((line) => line.includes('事件书不合法'))
    assert.ok(complaint !== undefined, harness.logs.join('\n'))
    assert.match(complaint!, /空事件书停用/)
    assert.match(complaint!, /intervall/, '至少要指出真正写错的那个字段名')
    // 3) 最关键：一条回合都没发（默认书在这里会跑 dm-visit / 巡逻）。
    assert.equal(harness.turns.total(), 0, `不该有任何主动回合：${JSON.stringify(harness.turns.booked)}`)
  } finally {
    await harness.dispose()
  }
})

test('R02（对照组）事件书合法：到点恰好跑一条——证明 R01 的零不是"永远不跑"', async () => {
  const good = {
    version: 1,
    events: [{
      id: 'ping', enabled: true, kind: 'prompt',
      trigger: { type: 'interval', everyMin: 30, jitterMin: 0, runOnBoot: true },
      quietHours: [], target: 'primary-group', template: 'proactive/patrol',
      materials: [], requires: [],
    }],
  }
  assert.equal(parseEventBook(good).ok, true)
  const harness = await mountProactive(good)
  try {
    assert.ok(harness.logs.some((line) => line.includes('events: executor started, 1 events (1 on)')), harness.logs.join('\n'))
    assert.equal(harness.turns.booked.length, 1, '合法书启动即补跑这一桶')
    assert.equal(harness.turns.booked[0]!.room, 'group-1000000003')
  } finally {
    await harness.dispose()
  }
})

test('R01b 空事件书本身是合法配置（所以"停用"不需要额外的开关位）', () => {
  const parsed = parseEventBook({ version: 1, events: [] })
  assert.equal(parsed.ok, true)
  if (parsed.ok) assert.equal(parsed.book.events.length, 0)
})

// ── R03：到期提醒的直发路径（恰好一次） ─────────────────────────────────────

test('R03 提醒到点：直发恰好一次，第二拍不重发，卸载时定时器被取消', async () => {
  const home = tempHome('qq-reminders-')
  const platform = new FakePlatform({ clock: new FakeClock(0) })
  const config = baseConfig({ reminders: { file: null } })
  const sub = fakeSubHost('reminders', config, home.dir)
  sub.with('platform', {
    client: {}, platform, api: platform.api, out: immediateOut(),
  } as unknown as PlatformParts)

  const capture = captureIntervals()
  let dispose: () => Promise<void> = async () => {}
  try {
    const effect = await remindersPlugin.apply(sub.host)
    dispose = async () => { if (typeof effect === 'function') await effect() }

    const store = sub.host.get('reminders')
    assert.notEqual(store, undefined, '提醒存储必须挂上（后台页与工具面都靠它）')
    // 一条已经到点的一次性提醒。
    await store!.add({ text: '喝水', at: Date.now() - 1000, room: 'group', target: 1000000003, createdBy: 10001 })

    capture.fire()
    await settle()
    assert.equal(platform.count(), 1, '到点应当直发一条')
    assert.equal(platform.sent[0]!.text, '⏰ 到点了：喝水')
    assert.deepEqual([platform.sent[0]!.isGroup, platform.sent[0]!.target], [true, 1000000003])

    // 第二拍：已经 markFired，不该再发（这是"重复 tick 不重复发"的最底层一条）。
    capture.fire()
    await settle()
    assert.equal(platform.count(), 1, '同一批 due 不能被推两次')

    await dispose()
    assert.equal(capture.cleared(), 1, '卸载必须 clearInterval（否则进程里留一个 30s 的幽灵）')
  } finally {
    capture.restore()
    await dispose()
    home.cleanup()
  }
})

test('R03b 提醒未到点：一拍都不发（due() 的时间判据不能提前）', async () => {
  const home = tempHome('qq-reminders-')
  const platform = new FakePlatform()
  const config = baseConfig({ reminders: { file: null } })
  const sub = fakeSubHost('reminders', config, home.dir)
  sub.with('platform', { client: {}, platform, api: platform.api, out: immediateOut() } as unknown as PlatformParts)

  const capture = captureIntervals()
  let dispose: () => Promise<void> = async () => {}
  try {
    const effect = await remindersPlugin.apply(sub.host)
    dispose = async () => { if (typeof effect === 'function') await effect() }
    const store = sub.host.get('reminders')!
    expectOk(await store.add({ text: '明天的事', at: Date.now() + 6 * 60 * 60_000, room: 'dm', target: 10001, createdBy: 10001 }))
    capture.fire()
    await settle()
    assert.equal(platform.count(), 0)
  } finally {
    capture.restore()
    await dispose()
    home.cleanup()
  }
})

test('R03c 周期提醒：触发后推进到下一个未来时刻，不连发', async () => {
  const home = tempHome('qq-reminders-')
  const log: string[] = []
  const store = new ReminderStore({ file: null } as never, { workspacePath: null, dshHome: home.dir, log: (l) => log.push(l) })
  await store.load()
  const sent: string[] = []
  const runner = new ReminderRunner(store, async (reminder) => { sent.push(reminder.text); return 'sent' as const }, (l) => log.push(l))
  try {
    expectOk(await store.add({ text: '吃药', at: Date.now() - 1000, room: 'dm', target: 10001, createdBy: 10001, repeat: 'daily' }))
    // `ReminderRunner.tick/runDue` 是私有的且不接时钟：这里直接驱动一次（见审查发现 V-R3）。
    const drive = runner as unknown as { runDue(): Promise<void> }
    await drive.runDue()
    assert.deepEqual(sent, ['吃药'])
    await drive.runDue()
    assert.deepEqual(sent, ['吃药'], 'daily 提醒推进到明天，不能在同一分钟内连发')
    const still = store.list(10)
    assert.equal(still.length, 1)
    assert.equal(still[0]!.fired, false, '周期提醒永远不置 fired')
    assert.ok(still[0]!.at > Date.now(), '下次到点必须在未来')
  } finally {
    runner.dispose()
    home.cleanup()
  }
})

// ── R04/R05：出站与传输接缝 ─────────────────────────────────────────────────

test('R04 出站队列：发送失败必须 reject（不静默当成功）', async () => {
  const logs: string[] = []
  const platform = new FakePlatform()
  platform.failWith = 'onebot: 连接已断开'
  let sent = 0
  let failed = 0
  const queue = new OutboundQueue(platform.api, baseConfig(), (line) => logs.push(line), {
    sent: () => { sent += 1 },
    failed: () => { failed += 1 },
  })
  await assert.rejects(
    () => queue.push(() => platform.api.sendTo(false, 10001, [{ type: 'text', data: { text: 'hi' } }])),
    /连接已断开/,
  )
  assert.equal(failed, 1)
  assert.equal(sent, 0, '失败不能计入成功数——指标页读的正是这两个计数')
})

test('R05 sendTo 的线上动作名：群/私聊不能搞混（被动回复与直发共用这一层）', async () => {
  const client = fakeClient()
  const api = createQQApi(client as never)
  const message: OneBotMessage = [{ type: 'text', data: { text: '你好' } }]
  await api.sendTo(true, 1000000003, message)
  await api.sendTo(false, 10001, message)
  assert.deepEqual(client.calls.map((call) => call.action), ['send_group_msg', 'send_private_msg'])
  assert.equal(client.calls[0]!.params.group_id, 1000000003)
  assert.equal(client.calls[1]!.params.user_id, 10001)
  assert.equal(client.calls[0]!.params.message, message)
})

// ── R06：三类外发同处一拍时的基线 ───────────────────────────────────────────

test('R06 同一拍里：主动回合一条 + 提醒直发一条，互不吞也不多发', async () => {
  const home = tempHome('qq-both-')
  const platform = new FakePlatform()
  const turns = new FakeTurns()
  const registry = new FakeRegistry()
  const config = baseConfig({
    proactive: {
      v2: true,
      book: {
        version: 1,
        events: [{
          id: 'ping', enabled: true, kind: 'prompt',
          trigger: { type: 'interval', everyMin: 30, jitterMin: 0, runOnBoot: true },
          quietHours: [], target: 'primary-group', template: 'proactive/patrol',
          materials: [], requires: [],
        }],
      },
    },
  })
  const sub = fakeSubHost('both', config, home.dir)
  sub.with('inbound', { registry, turns, notices: {}, pipeline: {} } as never)
  sub.with('persona', { pack: {}, composer: { render: (key: string) => key } } as never)
  sub.with('platform', { client: {}, platform, api: platform.api, out: immediateOut() } as unknown as PlatformParts)

  const disposers: Array<() => Promise<void>> = []
  const capture = captureIntervals()
  try {
    // 主动回合（走 turns，不经平台）
    const proactiveEffect = await proactivePlugin.apply(sub.host)
    if (typeof proactiveEffect === 'function') disposers.push(async () => { await proactiveEffect() })
    await proactivePlugin.start?.(sub.host)
    await settle()

    // 提醒直发（走平台，不经 turns）
    const remindersEffect = await remindersPlugin.apply(sub.host)
    if (typeof remindersEffect === 'function') disposers.push(async () => { await remindersEffect() })
    await sub.host.get('reminders')!.add({
      text: '出门带伞', at: Date.now() - 1000, room: 'group', target: 1000000003, createdBy: 10001,
    })
    capture.fire()
    await settle()

    assert.equal(turns.booked.length, 1, '主动回合恰好一条')
    assert.equal(platform.count(), 1, '提醒直发恰好一条')
    // 两条路的归属清楚：提醒文案不会跑到回合里，巡逻提示词也不会跑到平台上。
    assert.equal(platform.sent[0]!.text, '⏰ 到点了：出门带伞')
    assert.ok(!turns.booked[0]!.prompt.includes('出门带伞'), '提醒正文不该被拼进回合提示词')
    assert.match(segmentText([{ type: 'text', data: { text: platform.sent[0]!.text } }]), /到点了/)
  } finally {
    capture.restore()
    for (const dispose of disposers.reverse()) await dispose()
    home.cleanup()
  }
})
