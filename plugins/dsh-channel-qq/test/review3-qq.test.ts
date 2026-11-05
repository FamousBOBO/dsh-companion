import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { QQChannelConfig } from '../src/config.js'
import { ReminderStore, type Reminder } from '../src/features/reminders/store.js'
import { REMINDER_OUTCOMES, ReminderRunner, outcomeOf } from '../src/features/reminders/runner.js'
import { deliverReminder, configureReminderSeams } from '../src/features/reminders/index.js'
import { configureAgendaPort, nextOccurrenceOf, occurrenceOf, seamsOf, type AgendaPort } from '../src/features/reminders/agenda-seam.js'
import { registerReminderTools, UNBOUND_NOTE } from '../src/features/reminders/tools.js'
import { createSharePort } from '../src/features/contact/share-port.js'
import { actionOf, decideOutbound, type OutboundOrigin } from '../src/core/outbound-boundary.js'
import { createToolGateHooks } from '../src/features/qq-tools/gate.js'
import { baseConfig, tempHome, FakeOutboundQueue, FakePlatform } from './fakes/contact.js'
import type { SubHost } from '../src/features/plugin-kit.js'

// 终审 round3 的 P1 修（QQ 侧四件）：
//   B2 dryRun 不得消耗提醒（**最高优先**）
//   B3-A 建提醒要带可解析的 sessionId；B3-B occurrence 兼容嵌套形状
//   B6 share 端口透传真实拒绝原因
//   B8 poke/like/delete 归类为写、来源不可解析时 fail-closed
//
// 约定：**不碰 home/**，全部落在 `tempHome()` 的临时目录。

const NOW = 1_762_000_000_000

// ───────────────────────────────────────────────────────────────────────────
// B2：dryRun 不得改动任何持久状态，且退出 dryRun 后仍能发出
// ───────────────────────────────────────────────────────────────────────────

interface DryRig {
  readonly store: ReminderStore
  readonly file: string
  readonly runner: ReminderRunner
  readonly platform: FakePlatform
  readonly logs: string[]
  readonly close: () => Promise<void>
}

/** 真 store（临时目录）+ 真 runner + 真 `deliverReminder`（假平台，零外发）。 */
async function dryRig(dryRun: boolean, home: ReturnType<typeof tempHome>): Promise<DryRig> {
  const logs: string[] = []
  const base = baseConfig({ admins: [10001] }) as unknown as QQChannelConfig
  const config = {
    ...base,
    groupEnabled: true,
    rooms: [],
    reminders: { enabled: true, dryRun, file: null },
  } as QQChannelConfig
  const store = new ReminderStore(config.reminders, {
    workspacePath: home.dir,
    dshHome: home.dir,
    log: (line) => { logs.push(line) },
  })
  await store.load()
  const platform = new FakePlatform()
  const queue = new FakeOutboundQueue()
  const host = {
    config,
    log: (line: string) => { logs.push(line) },
    get: (name: string) => {
      if (name === 'platform') return { api: platform.api, out: queue }
      // 故意不给 contact：这条测试只关心"提醒自己的状态"，闸门另有测试。
      return undefined
    },
  } as unknown as SubHost
  const runner = new ReminderRunner(
    store,
    (reminder) => deliverReminder(host, reminder),
    (line) => { logs.push(line) },
    () => true,
  )
  return {
    store,
    file: path.join(home.dir, 'reminders.json'),
    runner,
    platform,
    logs,
    // **A 类修复**：原来只重置接缝、**没关 store** ⇒ 同一临时目录建第二个 rig 就 OWNER_CONFLICT。
    // 现在真的 `await store.close()`（排空后释放注册表），第二个实例自己会 `await store.load()`。
    close: async () => { configureReminderSeams({}); configureAgendaPort(null); await store.close() },
  }
}

/** 工具调用要传"未来"时刻：`NOW` 是固定的过去时间，只给 store 的 due 判定用。 */
const soon = (ms: number): number => Date.now() + ms

const tickOf = async (rig: DryRig): Promise<void> => {  await (rig.runner as unknown as { tick(): Promise<void> }).tick()
}

const snapshotOf = (file: string): unknown => JSON.parse(fs.readFileSync(file, 'utf8'))

const addOneShot = async (rig: DryRig): Promise<void> => {
  await rig.store.add({
    text: '该睡了',
    // **必须在补发窗口内**（round4 B7：比 6 小时更旧的到期提醒会被收成 skipped-expired、不再补发）。
    at: Date.now() - 1_000,
    room: 'dm',
    target: 10001,
    createdBy: 10001,
    repeat: 'none',
    occurrence: { id: 'occ-dry', revision: 4 },
  })
}

test('B2-1 dryRun：一次性提醒发不出去，但 fired/at/occurrence 逐字段不变（一点都没消耗）', async () => {
  const home = tempHome('qq-b2-1-')
  const rig = await dryRig(true, home)
  try {
    // 先让 seams 里的 CAS 也可能被调用：给一个会记数的桩（dryRun 下它**不该**被问到）。
    const casCalls: string[] = []
    configureReminderSeams({ casOccurrence: async (occurrenceId) => { casCalls.push(occurrenceId); return { ok: true, revision: 1 } } })
    await addOneShot(rig)
    const before = snapshotOf(rig.file)
    await tickOf(rig)
    const after = snapshotOf(rig.file)
    assert.equal(rig.platform.count(), 0, 'dryRun 一条都不许发')
    assert.deepEqual(after, before, 'dryRun 之后 store 必须逐字段不变（fired/at/occurrence 都不动）')
    assert.deepEqual(casCalls, [], 'dryRun 排在 CAS 之前：演练不该去问日程')
    assert.ok(rig.logs.some((line) => line.includes('dry-run')), '日志要能看出是"演练过"')
    // 一条一次性提醒仍然"到期未发"。
    assert.equal(rig.store.due().length, 1, '提醒还在 due 里（没被消耗）')
  } finally {
    await rig.close()
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})

test('B2-2 演练过的那条，关掉 dryRun 重启后仍然发得出（证明没有被永久标记）', async () => {
  const home = tempHome('qq-b2-2-')
  // 第一趟：dryRun=true，跑两拍（多跑一拍更能证明没被消耗）。
  const dry = await dryRig(true, home)
  await addOneShot(dry)
  await tickOf(dry)
  await tickOf(dry)
  assert.equal(dry.platform.count(), 0)
  await dry.close()

  // 第二趟：同一个文件、dryRun=false，重启。
  const real = await dryRig(false, home)
  try {
    await tickOf(real)
    assert.equal(real.platform.count(), 1, '关掉 dryRun 后必须**补发**（恰好一次）')
    const after = snapshotOf(real.file) as { reminders: Reminder[] }
    assert.equal(after.reminders[0]?.fired, true, '真发之后才标 fired')
  } finally {
    await real.close()
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})

test('B2-3 对照组：dryRun=false 一次性提醒恰好发一次，且标记为已触发', async () => {
  const home = tempHome('qq-b2-3-')
  const rig = await dryRig(false, home)
  try {
    await addOneShot(rig)
    await tickOf(rig)
    await tickOf(rig)
    assert.equal(rig.platform.count(), 1, '只发一次（第二拍已不在 due 里）')
    const after = snapshotOf(rig.file) as { reminders: Reminder[] }
    assert.equal(after.reminders[0]?.fired, true)
    // `firedAt` 记的是**真正发出那一刻**（不是到点时刻）——这里只要求它是个合理时间戳。
    assert.ok((after.reminders[0]?.firedAt ?? 0) > NOW - 1_000, 'firedAt 要写上');
  } finally {
    await rig.close()
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})

// ───────────────────────────────────────────────────────────────────────────
// B3-A：建提醒必须带可解析的 sessionId（拿不到就诚实降级）
// ───────────────────────────────────────────────────────────────────────────

interface ToolsRig {
  readonly logs: string[]
  readonly call: (name: string, args: unknown) => Promise<Record<string, unknown>>
  readonly close: () => void
}

async function toolsRig(): Promise<ToolsRig> {
  const home = tempHome('qq-b3-')
  const logs: string[] = []
  const base = baseConfig({ admins: [10001] }) as unknown as QQChannelConfig
  const config = {
    ...base,
    primaryGroup: 1000000003,
    reminders: { enabled: true, dryRun: false, file: null },
  } as QQChannelConfig
  const store = new ReminderStore(config.reminders, { workspacePath: home.dir, dshHome: home.dir, log: (line) => { logs.push(line) } })
  await store.load()
  const platform = new FakePlatform()
  const specs: Array<{ name: string; execute(args: unknown): Promise<unknown> }> = []
  registerReminderTools(
    { tools: { register: (definition: unknown) => { specs.push(definition as { name: string; execute(args: unknown): Promise<unknown> }); return () => {} } } },
    config,
    platform.api,
    new FakeOutboundQueue() as never,
    (line) => { logs.push(line) },
    store,
  )
  return {
    logs,
    call: async (name, args) => {
      const spec = specs.find((item) => item.name === name)
      assert.notEqual(spec, undefined, '没注册工具 ' + name)
      return await spec!.execute(args) as Record<string, unknown>
    },
    close: () => {
      configureAgendaPort(null)
      try { fs.rmSync(home.dir, { recursive: true, force: true }) } catch { /* 删不掉就算了 */ }
    },
  }
}

/** 记录每次 `createSchedule` 入参的假 agenda。 */
function recordingAgenda(result: { ok: boolean; occurrenceId?: string; revision?: number; occurrence?: { id?: string; revision?: number }; code?: string }): {
  port: AgendaPort
  calls: Array<Record<string, unknown>>
} {
  const calls: Array<Record<string, unknown>> = []
  return {
    calls,
    port: {
      createSchedule: async (input) => { calls.push(input as unknown as Record<string, unknown>); return result },
    } as AgendaPort,
  }
}

test('B3-A 建提醒时 createSchedule 带上 sessionId（qq-dm-<号> / qq-group-<号>）', async () => {
  const rig = await toolsRig()
  const agenda = recordingAgenda({ ok: true, occurrenceId: 'sch-1', revision: 2 })
  configureAgendaPort(agenda.port)
  try {
    const dm = await rig.call('qq_remind_at', { at: soon(60_000), text: '起来', isGroup: false, target: 10001 })
    assert.equal(dm.ok, true)
    assert.equal(agenda.calls.length, 1, '建提醒要建一次日程')
    assert.equal(agenda.calls[0]?.sessionId, 'qq-dm-10001', '必须带上可解析的 sessionId')
    assert.equal(dm.occurrence, undefined, '工具回执不暴露 occurrence 细节（内部记账）')

    // 群目标：sessionId 用群房间键。
    await rig.call('qq_remind_at', { at: soon(120_000), text: '开会', isGroup: true, target: 1000000003 })
    assert.equal(agenda.calls[1]?.sessionId, 'qq-group-1000000003')
  } finally {
    await rig.close()
  }
})

test('B3-A 自报的 sessionId 与房间不一致 → 不建日程（诚实降级），提醒照建', async () => {
  const rig = await toolsRig()
  const agenda = recordingAgenda({ ok: true, occurrenceId: 'sch-x', revision: 1 })
  configureAgendaPort(agenda.port)
  try {
    const bad = await rig.call('qq_remind_at', {
      at: soon(70_000), text: '起来', isGroup: false, target: 10001,
      // 自报的是**另一个会话**：拿它去建日程会把绑定指到别处。
      sessionId: 'qq-dm-99999',
    })
    assert.equal(bad.ok, true, '提醒本身照建（不因为没绑定就拒绝用户）')
    assert.equal(agenda.calls.length, 0, 'sessionId 对不上就不该去建日程')
    assert.match(String(bad.note ?? ''), /sessionId/, `降级说明要指明缺什么：${String(bad.note ?? '')}`)
    assert.ok(String(bad.note ?? '').includes(UNBOUND_NOTE), '仍用同一句"未与日程绑定"开头')

    // 与房间一致的自报值：采信，并原样传给 createSchedule。
    await rig.call('qq_remind_at', { at: soon(100_000), text: '起来', isGroup: false, target: 10001, sessionId: 'qq-dm-10001' })
    assert.equal(agenda.calls.length, 1)
    assert.equal(agenda.calls[0]?.sessionId, 'qq-dm-10001')
  } finally {
    await rig.close()
  }
})

// ───────────────────────────────────────────────────────────────────────────
// B3-B：occurrence 兼容嵌套（foundation 的 {ok, occurrence:{id,revision}}）
// ───────────────────────────────────────────────────────────────────────────

test('B3-B occurrenceOf 同时接受嵌套与平铺两种形状', () => {
  assert.deepEqual(occurrenceOf({ ok: true, occurrence: { id: 'sch-9', revision: 7 } }), { id: 'sch-9', revision: 7 })
  assert.deepEqual(occurrenceOf({ ok: true, occurrenceId: 'sch-8', revision: 3 }), { id: 'sch-8', revision: 3 })
  // 嵌套缺 revision → 回落平铺；两者都没有 → null（诚实降级）。
  assert.deepEqual(occurrenceOf({ ok: true, occurrence: { id: 'sch-7' }, revision: 1 }), { id: 'sch-7', revision: 1 })
  assert.equal(occurrenceOf({ ok: true, occurrence: { id: 'sch-6' } }), null)
  assert.equal(occurrenceOf({ ok: false, occurrence: { id: 'sch-5', revision: 1 } }), null, 'ok=false 一律不认')
})

test('B3-B 真 agenda 桩返回**嵌套**形状 → 周期提醒换绑仍成立（不再被解绑）', async () => {
  const home = tempHome('qq-b3b-')
  const rig = await dryRig(false, home)
  try {
    // 每轮都返回嵌套形状：只要 occurrenceOf 只读平铺，这里就永远是 null ⇒ 绑定被清空。
    configureAgendaPort({
      createSchedule: async () => ({ ok: true, occurrence: { id: 'sch-loop', revision: 1 } }),
      nextOccurrence: async () => ({ ok: true, occurrence: { id: 'sch-loop', revision: 2 } }),
    } as AgendaPort)
    // runner 的换绑走 `nextOccurrenceOf`（与生产同一函数）。
    const rebind = async (reminder: Reminder) => (reminder.repeat === 'none' ? null : await nextOccurrenceOf(reminder))
    const runner = new ReminderRunner(
      rig.store,
      (reminder) => deliverReminder((rig as unknown as { host?: SubHost }).host ?? hostOf(rig), reminder),
      (line) => { rig.logs.push(line) },
      () => true,
      rebind,
    )
    await rig.store.add({
      text: '每天九点', at: Date.now() - 1_000, room: 'dm', target: 10001, createdBy: 10001,
      repeat: 'daily', occurrence: { id: 'sch-loop', revision: 1 },
    })
    await (runner as unknown as { tick(): Promise<void> }).tick()
    const after = snapshotOf(rig.file) as { reminders: Reminder[] }
    assert.equal(rig.platform.count(), 1, '这一轮真发了')
    assert.deepEqual(after.reminders[0]?.occurrence, { id: 'sch-loop', revision: 2 },
      '换绑必须跟上嵌套形状的 revision（否则每天都被解绑）')
    assert.ok((after.reminders[0]?.at ?? 0) > NOW - 1_000, '周期提醒的 at 要推进')
  } finally {
    await rig.close()
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})

/** `dryRig` 内部的 host 不在返回值里；这里给 B3-B 造一个等价的最小 host。 */
function hostOf(rig: DryRig): SubHost {
  const base = baseConfig({ admins: [10001] }) as unknown as QQChannelConfig
  const config = { ...base, groupEnabled: true, rooms: [], reminders: { enabled: true, dryRun: false, file: null } } as QQChannelConfig
  const queue = new FakeOutboundQueue()
  return {
    config,
    log: (line: string) => { rig.logs.push(line) },
    get: (name: string) => (name === 'platform' ? { api: rig.platform.api, out: queue } : undefined),
  } as unknown as SubHost
}

// ───────────────────────────────────────────────────────────────────────────
// B6：share 端口把闸门原因原样透传（不再压成 rejected）
// ───────────────────────────────────────────────────────────────────────────

function sharePortWith(over: {
  propose?: () => Promise<{ outcome: 'accepted' | 'duplicate' | 'rejected'; candidateId: string; note: string }>
  budget?: (room: string) => Promise<{ allowed: boolean; reason?: string }>
}) {
  const calls: string[] = []
  const port = createSharePort({
    enabled: () => true,
    propose: async () => {
      calls.push('propose')
      return over.propose === undefined
        ? { outcome: 'rejected', candidateId: 'c1', note: '闸门拒绝' }
        : await over.propose()
    },
    attempt: async () => { calls.push('attempt') },
    target: () => ({
      scope: { userId: 10001, personaId: 'march7', worldId: '' },
      target: { channel: 'qq', room: 'dm-10001', isGroup: false, chatId: 10001 },
      authorization: { kind: 'standing', by: 10001, at: NOW, quote: null },
    }),
    now: () => NOW,
    log: () => {},
    ...(over.budget === undefined ? {} : { budget: over.budget }),
  })
  return { port, calls }
}

test('B6 闸门给 quiet-hours → 端口返回的 code 就是 quiet-hours（不是 rejected）', async () => {
  const { port } = sharePortWith({ budget: async () => ({ allowed: false, reason: 'quiet-hours' }) })
  const result = await port.submitShare({ candidateId: 'shr-b6', title: '夜里想说一句' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'quiet-hours', 'retryable 的原因必须原样透传（否则 runtime 会当终态丢掉候选）')
})

test('B6 闸门给 quota / 冷却也照样透传；问不出原因时才回落 rejected', async () => {
  for (const reason of ['quota:global', 'cooldown:room', 'rate-limited']) {
    const { port } = sharePortWith({ budget: async () => ({ allowed: false, reason }) })
    assert.equal((await port.submitShare({ candidateId: 'x', title: 't' })).code, reason)
  }
  // 没有 budget 依赖（老装配）：不编原因，退回 rejected。
  const { port } = sharePortWith({})
  assert.equal((await port.submitShare({ candidateId: 'y', title: 't' })).code, 'rejected')
  // 闸门放行但 contact 仍拒（例如 dedupe 之外的内部拒绝）→ 也回落 rejected，不假称可重试。
  const allowed = sharePortWith({ budget: async () => ({ allowed: true, reason: 'ok' }) })
  assert.equal((await allowed.port.submitShare({ candidateId: 'z', title: 't' })).code, 'rejected')
  // 接受时不受影响。
  const ok = sharePortWith({
    propose: async () => ({ outcome: 'accepted', candidateId: 'a1', note: '' }),
    budget: async () => ({ allowed: false, reason: 'quiet-hours' }),
  })
  assert.deepEqual(await ok.port.submitShare({ candidateId: 'a1', title: 't' }), { ok: true, code: 'accepted' })
})

// ───────────────────────────────────────────────────────────────────────────
// B8：poke / like / delete 归到"写"，来源不可解析时 fail-closed
// ───────────────────────────────────────────────────────────────────────────

const DM_OWNER: OutboundOrigin = { isGroup: false, chatId: 10001 }
const GROUP_TURN: OutboundOrigin = { isGroup: true, chatId: 1000000003 }
const OTHER_GROUP = 1000000004

const boundaryConfig = (over: Record<string, unknown> = {}) => ({
  admins: [10001] as readonly number[],
  groupEnabled: true,
  rooms: [] as readonly { id: number; enabled: boolean }[],
  ...over,
}) as never

test('B8-1 poke / like / delete 不再是只读（归类为写）', () => {
  for (const tool of ['qq_send_poke', 'qq_send_like', 'qq_delete_msg']) {
    assert.notEqual(actionOf(tool, {}), 'read', tool + ' 会改变他人可见状态，不能算只读')
    assert.equal(actionOf(tool, {}), 'send', tool + ' 归到写（send 是最严的默认档）')
  }
  // 真正的只读工具照旧。
  assert.equal(actionOf('qq_get_group_list', {}), 'read')
})

test('B8-2 群被关掉时这三个动作都被拒（受 groupEnabled / 来源群约束）', () => {
  const closed = boundaryConfig({ groupEnabled: false })
  // 带 groupId 的：目标群关着 → group-disabled。
  for (const [tool, args] of [
    ['qq_send_poke', { groupId: 1000000003, userId: 10002 }],
    ['qq_delete_msg', { messageId: 42, groupId: 1000000003 }],
  ] as const) {
    const verdict = decideOutbound({ tool, args: args as Record<string, unknown>, origin: DM_OWNER, config: closed })
    assert.equal(verdict.kind, 'deny', tool + ' 在关掉的群里不该被允许')
    assert.equal(verdict.kind === 'deny' ? verdict.code : '', 'group-disabled')
  }
  // 没有 groupId 的（点赞）：按**来源群**兜住——关着的群里不许动手。
  const like = decideOutbound({ tool: 'qq_send_like', args: { userId: 10002, times: 3 }, origin: GROUP_TURN, config: closed })
  assert.equal(like.kind, 'deny')
  assert.equal(like.kind === 'deny' ? like.code : '', 'group-disabled')
})

test('B8-3 群开着时：自己群里 poke 放行，跨群 poke 被拒', () => {
  const config = boundaryConfig()
  const own = decideOutbound({ tool: 'qq_send_poke', args: { groupId: 1000000003, userId: 10002 }, origin: GROUP_TURN, config })
  assert.equal(own.kind, 'allow')
  const cross = decideOutbound({ tool: 'qq_send_poke', args: { groupId: OTHER_GROUP, userId: 10002 }, origin: GROUP_TURN, config })
  assert.equal(cross.kind, 'deny')
  assert.equal(cross.kind === 'deny' ? cross.code : '', 'cross-group')
})

test('B8-4 来源解析不出来 → 默认拒绝（fail-closed），只读工具仍然放行', () => {
  const config = boundaryConfig()
  for (const [tool, args] of [
    ['qq_send_poke', { userId: 10002 }],
    ['qq_send_like', { userId: 10002 }],
    ['qq_delete_msg', { messageId: 42 }],
    ['qq_send_text', { target: 10001, text: '在' }],
  ] as const) {
    const verdict = decideOutbound({ tool, args: args as Record<string, unknown>, origin: null, config })
    assert.equal(verdict.kind, 'deny', tool + ' 在来源不明时必须被拒')
    assert.equal(verdict.kind === 'deny' ? verdict.code : '', 'origin-unknown')
    assert.ok(verdict.kind === 'deny' && verdict.reason.length > 0, '理由要可读')
  }
  // 只读工具不受影响：读不到就是读不到。
  assert.equal(decideOutbound({ tool: 'qq_get_group_list', args: {}, origin: null, config }).kind, 'allow')
})

// B2 收尾：`ReminderOutcome` 的词表有**一处权威定义**，且文档里有对照表
// （终审 round3 的 Follow-up ①：`dry-run` 是新词，仓外按三态枚举的地方会误判）。
test('B2-4 词表权威定义：REMINDER_OUTCOMES 恰好四档；README 有对照表；认不出的一律 unknown', () => {
  // ① 代码里的唯一权威定义（类型由它派生：少一个/多一个都会先在这里红）。
  assert.deepEqual([...REMINDER_OUTCOMES].sort(), ['dry-run', 'sent', 'skipped', 'unknown'])
  // ② 收敛函数：认不出的值按 unknown（不能静默当成"发成功"），四档原样返回。
  for (const value of REMINDER_OUTCOMES) assert.equal(outcomeOf(value), value)
  for (const junk of ['', 'SENT', 'dryrun', 'ok', null, undefined, 0, {}]) {
    assert.equal(outcomeOf(junk), 'unknown', `认不出的返回值要落到 unknown：${String(junk)}`)
  }
  // ③ README 里有名字一眼能查到的对照表（人话版），四个词都得出现。
  // 测试在 build/lib-test/ 里跑，所以按**仓库根**（cwd）读 README，而不是相对测试文件。
  const readme = fs.readFileSync(path.join(process.cwd(), 'README.md'), 'utf8')
  assert.ok(readme.includes('提醒的四种结论'), 'README 要有这一节（文档侧的落点）')
  for (const word of REMINDER_OUTCOMES) {
    assert.ok(readme.includes(`\`${word}\``), `README 的对照表要写清 \`${word}\``)
  }
  assert.ok(readme.includes('REMINDER_OUTCOMES'), 'README 要指向代码里的权威定义')
})

// B8 收尾：被拒绝时那行日志必须**可 grep**（真机上"某个系统动作被拦了"要看得出原因）。
test('B8-5 拒绝日志可 grep：`boundary: denied … origin-unknown` 带工具名与来源', () => {
  const lines: string[] = []
  const hooks = createToolGateHooks({
    trustOf: () => undefined,
    boundary: () => boundaryConfig() as never,
    log: (line: string) => { lines.push(line) },
    guardText: (key: string) => key,
    workspacePath: () => null,
    sendGuard: null,
    switches: { policyOn: () => false, toolsOn: () => false, admins: () => [10001] as readonly number[] },
  })
  // 来源不可解析（没有 agentId）：poke 必须被拒，且日志能直接 grep 出 code。
  const verdict = hooks.decide({ name: 'qq_send_poke', args: { userId: 10002 }, agentId: undefined } as never)
  assert.equal(verdict.kind, 'deny')
  const line = lines.find((item) => item.includes('boundary: denied')) ?? ''
  assert.match(line, /boundary: denied qq_send_poke/, `日志里要有工具名：${lines.join(' | ')}`)
  assert.match(line, /origin-unknown/, '日志里要有 code（运维手册按它 grep）')
  assert.match(line, /session=\?/, '要看得出"没有会话"，别让人以为主体为空是正常现象')
  // 只读工具不会被这条拦住（日志里也不该出现 deny）；放行在 gate 里叫 `pass`。
  assert.equal(hooks.decide({ name: 'qq_get_group_list', args: {}, agentId: undefined } as never).kind, 'pass')
})

// 让 TS 知道这个词表被用到了（防止有人把 import 当装饰）。
const _outcomes: typeof REMINDER_OUTCOMES = REMINDER_OUTCOMES
void _outcomes
