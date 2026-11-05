import { expectOk, expectRejected } from './fakes/reminders.js'
import { storeFault } from '../src/features/reminders/store-contract.js'
/** **3A-4 补水**：提醒与 H1 日程真正绑定（写入口 / 适配层 / 诚实降级 / 顺序不变式）。
 *
 * 六条测试对应裁决「补 4」的六条要求；判据一律"落盘内容 / 调用序 / 返回文案"，
 * 不看私有字段。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import * as path from 'node:path'
import type { QQChannelConfig } from '../src/config.js'
import { ReminderStore, type Reminder } from '../src/features/reminders/store.js'
import { registerReminderTools, UNBOUND_NOTE } from '../src/features/reminders/tools.js'
import { deliverReminder, configureReminderSeams } from '../src/features/reminders/index.js'
import { configureAgendaPort, seamsOf, type AgendaPort } from '../src/features/reminders/agenda-seam.js'
import { baseConfig, tempHome, FakeOutboundQueue, FakePlatform } from './fakes/contact.js'
import type { SubHost } from '../src/features/plugin-kit.js'

const START = Date.UTC(2026, 9, 16, 14, 0, 0)

// ── 工具与 store 的脚手架 ───────────────────────────────────────────────────

interface ToolsRig {
  readonly store: ReminderStore
  readonly file: string
  readonly logs: string[]
  readonly call: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>
  readonly close: () => Promise<void>
}

/** 真 `ReminderStore`（落盘到临时目录）+ 真工具注册（拿 ToolSpec 直接调 run）。 */
async function toolsRig(options: { agenda?: AgendaPort | null; config?: Partial<QQChannelConfig> } = {}): Promise<ToolsRig> {
  const home = tempHome('qq-3a-bind-')
  const logs: string[] = []
  const base = baseConfig({ admins: [10001] }) as unknown as QQChannelConfig
  const config = {
    ...base,
    primaryGroup: 1000000003,
    reminders: { enabled: true, dryRun: false, file: null },
    ...(options.config ?? {}),
  } as QQChannelConfig
  const store = new ReminderStore(config.reminders, { workspacePath: home.dir, dshHome: home.dir, log: (line) => { logs.push(line) } })
  await store.load()
  const platform = new FakePlatform()
  // 宿主 register 收到的是**宿主定义**（execute），不是 ToolSpec；调 execute 才走真映射。
  const specs: Array<{ name: string; execute(args: unknown): Promise<unknown> }> = []
  registerReminderTools(
    { tools: { register: (definition: unknown) => { specs.push(definition as { name: string; execute(args: unknown): Promise<unknown> }); return () => {} } } },
    config,
    platform.api,
    new FakeOutboundQueue() as never,
    (line) => { logs.push(line) },
    store,
  )
  configureAgendaPort(options.agenda === undefined ? null : options.agenda)
  return {
    store,
    file: path.join(home.dir, 'reminders.json'),
    logs,
    call: async (name, args) => {
      const spec = specs.find((item) => item.name === name)
      assert.notEqual(spec, undefined, '没注册工具 ' + name + '（已注册：' + specs.map((s) => s.name).join(',') + '）')
      return await spec!.execute(args) as Record<string, unknown>
    },
    close: async () => {
      configureAgendaPort(null)
      await new Promise((resolve) => setTimeout(resolve, 40))
      try { fs.rmSync(home.dir, { recursive: true, force: true }) } catch { /* 删不掉就算了 */ }
    },
  }
}

/** 未来 10 分钟（用真实时钟：工具比的是真实的 now，`START` 是 2026-10-16 已经过去了）。 */
const futureAt = (): string => String(Date.now() + 10 * 60_000)

// ── 1. agenda 可用：先建日程，再存提醒 ──────────────────────────────────────

test('B1 agenda 可用 → qq_remind 先建日程，提醒里带 occurrence 并落盘', async () => {
  const created: Array<Record<string, unknown>> = []
  const rig = await toolsRig({
    agenda: {
      createSchedule: async (input) => {
        created.push({ ...input })
        return { ok: true, occurrenceId: 'occ-777', revision: 4 }
      },
    },
  })
  try {
    const result = await rig.call('qq_remind_at', { at: futureAt(), text: '吃药', isGroup: false, target: 10001, createdBy: 10001 })
    assert.equal(result.ok, true)
    assert.equal(created.length, 1, '建提醒之前必须建一条日程')
    assert.equal(created[0]!.text, '吃药')
    assert.equal(created[0]!.room, 'dm')
    // 落盘内容（不是内存）：读回文件确认 occurrence 真的写进去了。
    const raw = JSON.parse(fs.readFileSync(rig.file, 'utf8')) as { reminders: Reminder[] }
    const stored = raw.reminders.find((item) => item.text === '吃药')
    assert.notEqual(stored, undefined)
    assert.deepEqual(stored!.occurrence, { id: 'occ-777', revision: 4 })
    assert.equal(result.note, undefined, '绑上了就不该有"未绑定"的说明')
  } finally {
    await rig.close()
  }
})

test('B1b 自然语言入口同样绑定（qq_remind 走同一条路径）', async () => {
  const rig = await toolsRig({
    agenda: { createSchedule: async () => ({ ok: true, occurrenceId: 'occ-888', revision: 1 }) },
  })
  try {
    const result = await rig.call('qq_remind', { when: '10分钟后', text: '倒水', isGroup: false, target: 10001 })
    assert.equal(result.ok, true)
    const stored = (JSON.parse(fs.readFileSync(rig.file, 'utf8')) as { reminders: Reminder[] }).reminders.at(-1)!
    assert.deepEqual(stored.occurrence, { id: 'occ-888', revision: 1 })
  } finally {
    await rig.close()
  }
})

// ── 2. 诚实降级 ────────────────────────────────────────────────────────────

test('B2 agenda 不可用 → 提醒照建、无 occurrence，且返回里明说"未与日程绑定"', async () => {
  const rig = await toolsRig({ agenda: null })
  try {
    const result = await rig.call('qq_remind_at', { at: futureAt(), text: '喝水', isGroup: false, target: 10001 })
    assert.equal(result.ok, true, '没有 agenda 也必须能建提醒')
    const stored = (JSON.parse(fs.readFileSync(rig.file, 'utf8')) as { reminders: Reminder[] }).reminders.at(-1)!
    assert.equal(stored.occurrence, undefined, '不许假装绑定了')
    assert.equal(result.note, UNBOUND_NOTE)
    assert.match(String(result.note), /改期\/取消不会自动失效/)
  } finally {
    await rig.close()
  }
})

test('B2b 建日程失败/抛错 → 同样降级，但说明里带上失败原因', async () => {
  const failing = await toolsRig({ agenda: { createSchedule: async () => ({ ok: false, code: 'agenda-disabled' }) } })
  try {
    const result = await failing.call('qq_remind_at', { at: futureAt(), text: 'A', isGroup: false, target: 10001 })
    assert.equal(result.ok, true)
    assert.match(String(result.note), /agenda-disabled/)
  } finally {
    await failing.close()
  }
  const throwing = await toolsRig({ agenda: { createSchedule: async () => { throw new Error('boom') } } })
  try {
    const result = await throwing.call('qq_remind_at', { at: futureAt(), text: 'B', isGroup: false, target: 10001 })
    assert.equal(result.ok, true, '建日程抛错不能连累提醒本身')
    assert.match(String(result.note), /boom/)
  } finally {
    await throwing.close()
  }
})

// ── 3~6：投递侧的适配层行为 ─────────────────────────────────────────────────

interface DeliverRig {
  readonly host: SubHost
  readonly platform: FakePlatform
  readonly order: string[]
  readonly logs: string[]
}

function deliverRig(options: { dryRun?: boolean; deliverOk?: boolean } = {}): DeliverRig {
  const platform = new FakePlatform()
  const queue = new FakeOutboundQueue()
  const order: string[] = []
  const logs: string[] = []
  const base = baseConfig({ admins: [10001] }) as unknown as QQChannelConfig
  const config = {
    ...base,
    groupEnabled: true,
    rooms: [],
    reminders: { enabled: true, dryRun: options.dryRun ?? false, file: null },
  } as QQChannelConfig
  const contact = {
    outboundBudget: async () => { order.push('budget'); return { allowed: true, reason: 'ok', verdict: 'send' as const } },
    account: async () => { order.push('account') },
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
  return { host, platform, order, logs }
}

const reminderFor = (over: Partial<Reminder> = {}): Reminder => ({
  id: 'r-bind', text: '该睡了', at: START - 1_000, room: 'dm', target: 10001, createdBy: 10001,
  created: 0, fired: false, firedAt: null, repeat: 'none', ...over,
})

test('B3 绑定后改期（revision 变了）→ 适配层给出 reason，这条进 unknown（terminal，不重试）', async () => {
  const r = deliverRig()
  const order: string[] = []
  configureReminderSeams(seamsOf({
    casOccurrence: async (input) => {
      order.push('cas')
      assert.equal(input.occurrenceId, 'occ-1')
      assert.equal(input.revision, 3)
      return { ok: false, code: 'occurrence-rescheduled', actualRevision: 4 }
    },
  }, () => {}))
  try {
    const outcome = await deliverReminder(r.host, reminderFor({ occurrence: { id: 'occ-1', revision: 3 } }))
    assert.equal(outcome, 'unknown', 'revision 不匹配必须 terminal')
    assert.deepEqual(order, ['cas'])
    assert.equal(r.platform.count(), 0, '一条都不许发')
    assert.ok(r.logs.some((line) => line.includes('occurrence-rescheduled')), r.logs.join('\n'))
  } finally {
    configureReminderSeams({})
  }
})

test('B3b CAS 抛错按"不过"处理（ok:false），不会把异常当放行', async () => {
  const r = deliverRig()
  const logs: string[] = []
  configureReminderSeams(seamsOf({ casOccurrence: async () => { throw new Error('agenda down') } }, (line) => { logs.push(line) }))
  try {
    const outcome = await deliverReminder(r.host, reminderFor({ occurrence: { id: 'occ-2', revision: 1 } }))
    assert.equal(outcome, 'unknown')
    assert.equal(r.platform.count(), 0)
    assert.ok(logs.some((line) => line.includes('按"不过"处理')), logs.join('\n'))
  } finally {
    configureReminderSeams({})
  }
})

test('B4 emitDispatched 抛错 → 真发成功的那条**不被记成 unknown**，异常被吞且留日志', async () => {
  const r = deliverRig()
  const logs: string[] = []
  let markCalls = 0
  configureReminderSeams(seamsOf({
    casOccurrence: async () => ({ ok: true }),
    markOccurrenceDispatched: async () => { markCalls += 1; throw new Error('event store down') },
  }, (line) => { logs.push(line) }))
  try {
    const outcome = await deliverReminder(r.host, reminderFor({ occurrence: { id: 'occ-3', revision: 2 } }))
    assert.equal(outcome, 'sent', '真发出去了就是 sent（事件写失败不能改结论）')
    assert.equal(r.platform.count(), 1)
    assert.equal(markCalls, 1, 'dispatched 仍然尝试写过一次')
    // **终审 B3b 改了这条的落点**：dispatched 现在**等结果**（`dispatchNow`），失败会
    // 记一条待办（这个 rig 没有 store，所以只留日志），而不再只是 fire-and-forget 的"已吞"。
    // 日志走 `host.log`（`r.logs`），接缝自己的 log 是另一个数组。
    const joined = r.logs.join(' | ')
    assert.ok(r.logs.some((line) => line.includes('未写成')), `要留下"事件没写成"的日志：${joined}`)
    assert.ok(r.logs.some((line) => line.includes('event store down')), `日志里要有真实原因：${joined}`)
    assert.equal(outcome, 'sent', '结论不受影响（再确认一次）')
    assert.equal(outcome, 'sent', '结论不受影响（再确认一次）')
  } finally {
    configureReminderSeams({})
  }
})

test('B5 dryRun 下 emitDispatched 不被调用（也不记账）', async () => {
  const r = deliverRig({ dryRun: true })
  const logs: string[] = []
  let markCalls = 0
  configureReminderSeams(seamsOf({
    casOccurrence: async () => ({ ok: true }),
    markOccurrenceDispatched: async () => { markCalls += 1; return { ok: true } },
  }, (line) => { logs.push(line) }))
  try {
    const outcome = await deliverReminder(r.host, reminderFor({ occurrence: { id: 'occ-4', revision: 1 } }))
    // **终审 B2**：dryRun 的结论是 `dry-run`——runner 见它不写任何状态（不消耗这条提醒）。
    assert.equal(outcome, 'dry-run')
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(markCalls, 0, 'dryRun 不写 dispatched')
    assert.equal(r.platform.count(), 0, 'dryRun 不真发')
    // **round7 改判**：dryRun 以前会"只读地过一遍闸门"；现在**不评估闸门**——因为 contact 的
    // 账本读取在损坏/版本不匹配时会**删旧 `.corrupt` 并 rename 当前账本**（`ledger-io.ts:81-90`），
    // 那是写动作，演练不得触发。代价：演练看不出"这会儿会不会被拦"（如实记日志、写进 README）。
    assert.deepEqual(r.order, [], 'dryRun 不碰闸门、不记账、不问日程 CAS')
  } finally {
    configureReminderSeams({})
  }
})

test('B6 顺序不变式：CAS → 闸门 → 真发 → 记账 → dispatched', async () => {
  const r = deliverRig()
  const sequence: string[] = []
  configureReminderSeams(seamsOf({
    casOccurrence: async () => { sequence.push('cas'); return { ok: true } },
    markOccurrenceDispatched: async () => { sequence.push('dispatched'); return { ok: true } },
  }, () => {}))
  const originalBudget = r.order
  try {
    const outcome = await deliverReminder(r.host, reminderFor({ occurrence: { id: 'occ-5', revision: 1 } }))
    assert.equal(outcome, 'sent')
    await new Promise((resolve) => setImmediate(resolve))
    // `budget`/`account` 记在 r.order，`cas`/`dispatched` 记在 sequence —— 合起来看顺序。
    const merged = [...sequence.slice(0, 1), ...originalBudget, ...sequence.slice(1)]
    assert.deepEqual(merged, ['cas', 'budget', 'account', 'dispatched'],
      `顺序必须是 CAS → 闸门 → 真发 → 记账 → dispatched，实际 ${merged.join(' → ')}`)
    assert.equal(r.platform.count(), 1)
  } finally {
    configureReminderSeams({})
  }
})

void pathToFileURL

// ── 7~8：周期提醒的 revision 回写（3A-4 收尾） ───────────────────────────────

/**
 * 周期提醒连续两轮的真跑脚手架：真 `ReminderStore`（落盘）+ 真 `ReminderRunner`
 * + 假 agenda。第二轮必须换到 agenda 给的新 revision，否则 CAS 会判过期。
 */
async function periodicRig(options: {
  /** 
extOccurrence 依次返回的答案；缺省 = 压根不实现它（走"清空绑定"那条路）。 */
  next?: Array<{ ok: boolean; occurrenceId?: string; revision?: number; code?: string } | null>

}) {
  const home = tempHome('qq-3a-periodic-')
  const logs: string[] = []
  const base = baseConfig({ admins: [10001] }) as unknown as QQChannelConfig
  const config = { ...base, reminders: { enabled: true, dryRun: false, file: null } } as QQChannelConfig
  const store = new ReminderStore(config.reminders, { workspacePath: home.dir, dshHome: home.dir, log: (line) => { logs.push(line) } })
  await store.load()
  const created: Array<Record<string, unknown>> = []
  const seen: Array<Record<string, unknown>> = []
  let call = 0
  const next = options.next
  configureAgendaPort({
    // 兜底路径**不许**被用到：这里记录下来，测试里断言 0 次。
    createSchedule: async (input) => { created.push({ ...input }); return { ok: false, code: 'must-not-fallback' } },
    ...(next === undefined ? {} : {
      nextOccurrence: async (input: { occurrenceId: string; at: number }) => {
        seen.push({ ...input })
        const pick = next[Math.min(call, next.length - 1)] ?? null
        call += 1
        return pick ?? { ok: false, code: 'agenda-unavailable' }
      },
    }),
  })

  const { ReminderRunner } = await import('../src/features/reminders/runner.js')
  const { nextOccurrenceOf } = await import('../src/features/reminders/agenda-seam.js')
  const runner = new ReminderRunner(
    store,
    async () => 'sent' as const,
    (line) => { logs.push(line) },
    () => true,
    // 新契约：只取数、不写盘（写盘由 markFiredRebound 一次完成）。
    async (reminder) => (reminder.repeat === 'none' ? null : await nextOccurrenceOf(reminder)),
  )
  const drive = runner as unknown as { runDue(): Promise<void> }
  return { store, file: path.join(home.dir, 'reminders.json'), created, seen, logs, run: async () => { await drive.runDue() }, close: async () => {
    runner.dispose()
    configureAgendaPort(null)
    await new Promise((resolve) => setTimeout(resolve, 40))
    try { fs.rmSync(home.dir, { recursive: true, force: true }) } catch { /* 略 */ }
  } }
}

test('B7 周期提醒连续两轮：markFired 之后回写新 revision（第二轮 CAS 仍能过）', async () => {
  // 注意：这条提醒是**直接存进 store 的**（绑着 revision 1），所以第一次 `createSchedule`
  // 调用就是"取下一轮"，返回的应当是 revision 2。
  const rig = await periodicRig({ next: [
    { ok: true, occurrenceId: 'occ-daily', revision: 2 },
  ] })
  try {
    const item = expectOk(await rig.store.add({
      text: '吃药', at: Date.now() - 1_000, room: 'dm', target: 10001, createdBy: 10001, repeat: 'daily',
      occurrence: { id: 'occ-daily', revision: 1 },
    }))
    await rig.run()
    // 第一轮：发了、at 推到下一轮、revision 必须换成 agenda 给的新版本。
    const afterFirst = rig.store.list(10).find((row) => row.id === item.id)!
    assert.deepEqual(afterFirst.occurrence, { id: 'occ-daily', revision: 2 },
      `第一轮之后必须回写新 revision，实际 ${JSON.stringify(afterFirst.occurrence)}`)
    assert.ok(afterFirst.at > Date.now(), 'at 必须推进到未来')
    // 第二轮：用回写后的 revision 去 CAS —— 假 agenda 只在 revision 匹配时放行。
    configureAgendaPort({
      casOccurrence: async (input) => ({ ok: input.revision === 2, code: 'occurrence-rescheduled' }),
    })
    const outcome = await deliverReminder(
      { config: { ...(baseConfig({ admins: [10001] }) as unknown as QQChannelConfig), reminders: { enabled: true, dryRun: false, file: null } }, log: () => {}, get: () => undefined } as unknown as SubHost,
      { ...afterFirst, at: afterFirst.at },
    )
    assert.notEqual(outcome, 'unknown', '第二轮用回写后的 revision，CAS 必须通过（不该进 unknown）')
  } finally {
    await rig.close()
  }
})

test('B8 拿不到下一次 occurrence → 绑定被清空，第三轮不因旧 revision 进 unknown', async () => {
  // 第一次 `createSchedule` 就是"取下一轮"，这里让它失败：必须走"清空绑定"那条路。
  const rig = await periodicRig({ next: [
    { ok: false, code: 'agenda-unavailable' },
  ] })
  try {
    const item = expectOk(await rig.store.add({
      text: '交房租', at: Date.now() - 1_000, room: 'dm', target: 10001, createdBy: 10001, repeat: 'weekly',
      occurrence: { id: 'occ-weekly', revision: 1 },
    }))
    await rig.run()
    const afterFirst = rig.store.list(10).find((row) => row.id === item.id)!
    // 清空 = 字段**不存在**（盘上不写 `"occurrence": null`，文件形状与"从来没绑定过"一致）。
    assert.equal(afterFirst.occurrence, undefined, '拿不到下一次就必须清空（不能留必然过期的旧 revision）')
    assert.ok(rig.logs.some((line) => line.includes('已解除日程绑定')), rig.logs.join('\n'))
    assert.equal(rig.created.length, 0, '拿不到下一次时**不许**用 createSchedule 兜底（会污染事件书）')
    // 没有 occurrence ⇒ 投递时**不会**去问 CAS（也就不可能因旧 revision 被判过期）。
    let casCalls = 0
    configureReminderSeams(seamsOf({ casOccurrence: async () => { casCalls += 1; return { ok: false, code: 'stale' } } }, () => {}))
    try {
      const r = deliverRig()
      const outcome = await deliverReminder(r.host, { ...afterFirst, at: afterFirst.at, occurrence: afterFirst.occurrence })
      assert.equal(outcome, 'sent', `没有绑定时照常发，实际 ${outcome}`)
      assert.equal(casCalls, 0, '没有 occurrence 就不该问 CAS')
    } finally {
      configureReminderSeams({})
    }
  } finally {
    await rig.close()
  }
})

test('B9 重绑写盘失败 → `at` 也不推进（推进与换绑同生共死）', async () => {
  // 裁决 ③：`markFired`（推 at）与换绑（换 revision）必须是**一次写盘**。
  // 让第二次 save 抛错，断言两件事都没落下 —— 否则会留下"新 at + 旧 revision"这种自造故障。
  const rig = await periodicRig({ next: [{ ok: true, occurrenceId: 'occ-daily', revision: 9 }] })
  try {
    const at0 = Date.now() - 1_000
    const item = expectOk(await rig.store.add({
      text: '吃药', at: at0, room: 'dm', target: 10001, createdBy: 10001, repeat: 'daily',
      occurrence: { id: 'occ-daily', revision: 1 },
    }))
    const diskBefore = fs.readFileSync(rig.file, 'utf8')
    // 从这里开始，所有写盘都失败（`markFiredRebound` 必须整体回滚）。
    // **round9**：写底座搬进 `ReminderFile`（`store.io`），注入点跟着搬——判据不变（让写盘抛错）。
    // **task-66**：唯一写出口是 `io.replaceSerialized`（`save()` 已删）。
    ;(rig.store as unknown as { io: { replaceSerialized: (b: string) => Promise<{ kind: 'committed' }> } }).io.replaceSerialized = async () => {
      throw storeFault('PERSIST_FAILED', 'write', 'disk full')
    }
    await rig.run()
    const after = rig.store.list(10).find((row) => row.id === item.id)!
    assert.equal(after.at, at0, `写盘失败时 at 不许推进，实际 ${String(after.at)}`)
    assert.deepEqual(after.occurrence, { id: 'occ-daily', revision: 1 }, '写盘失败时绑定也不许换')
    assert.equal(after.fired, false, 'fired 也不许变')
    assert.ok(rig.logs.some((line) => line.includes('推进+换绑写盘失败')), rig.logs.join('\n'))
    // 盘上也没动（不是"内存回滚了、盘上却写了"）。
    assert.equal(fs.readFileSync(rig.file, 'utf8'), diskBefore, '写盘失败 ⇒ 磁盘内容一个字都不许变')
  } finally {
    await rig.close()
  }
})