import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { QQChannelConfig } from '../src/config.js'
import { ReminderStore, type Reminder } from '../src/features/reminders/store.js'
import { ReminderRunner } from '../src/features/reminders/runner.js'
import { configureReminderSeams, deliverReminder, remindersPlugin } from '../src/features/reminders/index.js'
import {
  agendaPortCapability, agendaPortOf, configureAgendaPort, configureAgendaResolver, identityOfReminder, liveSeams,
  type AgendaPort,
} from '../src/features/reminders/agenda-seam.js'
import { baseConfig, tempHome, FakeOutboundQueue, FakePlatform } from './fakes/contact.js'
import type { SubHost } from '../src/features/plugin-kit.js'

// 第六轮（round6）：D4 是"如果只能再做一件事"的那条 —— **dryRun 整条入口零写入**。
//
// 之前的缺陷：`takeBatch()` 已经绕过 expire/cap，但**整条入口**仍然写盘：
//   · `flushPendingDispatches()` 会 clear / bump（清待办、加次数、转 abandoned）；
//   · 插件启动时**无条件** prune。
// 本文件用"种一条带历史待办的记录 + 整份盘 deepEqual"来钉住这六件事：
//   不调用写端口 / 不清待办 / 不加次数 / 不转 abandoned / 不推进提醒 / 不做启动 prune。

const OWNER = 10001
const HOUR = 3_600_000
const SESSION = `qq-dm-${String(OWNER)}`

interface Rig {
  readonly store: ReminderStore
  readonly logs: string[]
  readonly platform: FakePlatform
  readonly file: string
  readonly tick: () => Promise<void>
  readonly setDryRun: (value: boolean) => void
  readonly close: () => void
}

/** 整份盘（**含顶层字段**，不是只读 `reminders` 数组）。 */
const readDisk = (file: string): unknown => JSON.parse(fs.readFileSync(file, 'utf8')) as unknown

function rig(dir: string, options: { dryRun?: boolean, dispatched?: 'ok' | 'absent' | 'fail' } = {}): Rig {
  const logs: string[] = []
  let dryRun = options.dryRun === true
  const base = baseConfig({ admins: [OWNER] }) as unknown as QQChannelConfig
  const config = {
    ...base,
    groupEnabled: true,
    reminders: { enabled: true, dryRun, file: null },
  } as QQChannelConfig
  const store = new ReminderStore(config.reminders, { workspacePath: dir, dshHome: dir, log: (line) => { logs.push(line) } })
  const platform = new FakePlatform()
  const queue = new FakeOutboundQueue()
  const host = {
    config,
    log: (line: string) => { logs.push(line) },
    get: (name: string) => (name === 'platform' ? { api: platform.api, out: queue } : name === 'reminders' ? store : undefined),
  } as unknown as SubHost
  const outcome = options.dispatched ?? 'ok'
  const writePortCalls: string[] = []
  configureReminderSeams({
    dispatchNow: async (occurrenceId, revision, at, identity) => {
      writePortCalls.push(`dispatch:${occurrenceId}:${String(identity?.sessionId)}`)
      return outcome === 'ok' ? { ok: true } : { ok: false, code: outcome === 'absent' ? 'agenda-absent' : 'rejected' }
    },
    casOccurrence: async (occurrenceId, revision, identity) => {
      writePortCalls.push(`cas:${occurrenceId}:${String(identity?.sessionId)}`)
      return { ok: true }
    },
  })
  const runner = new ReminderRunner(
    store,
    (reminder) => deliverReminder(host, reminder),
    (line) => { logs.push(line) },
    () => true,
    async () => null,
    async (reminder) => {
      const pending = reminder.pendingDispatch ?? null
      if (pending === null) return 'fail' as const
      writePortCalls.push(`redispatch:${pending.occurrenceId}:${String(identityOfReminder(reminder)?.sessionId)}`)
      return outcome === 'ok' ? 'ok' as const : outcome === 'absent' ? 'absent' as const : 'fail' as const
    },
    () => dryRun,
  )
  return {
    store,
    logs,
    platform,
    file: path.join(dir, 'reminders.json'),
    tick: async () => { await (runner as unknown as { tick(): Promise<void> }).tick() },
    setDryRun: (value: boolean) => {
      dryRun = value
      ;(config as { reminders: { dryRun: boolean } }).reminders.dryRun = value
    },
    // **A 类修复（通用形态）**：原来只重置接缝、**没关 store** ⇒ 同目录第二个 rig 必 OWNER_CONFLICT。
  close: async () => { configureReminderSeams({}); configureAgendaPort(null); configureAgendaResolver(null); await store.close() },
    // 便于断言"没有调用写端口"
    ...({ portCalls: writePortCalls } as unknown as Record<string, never>),
  }
}

const portCallsOf = (r: Rig): string[] => (r as unknown as { portCalls: string[] }).portCalls

/**
 * 种一份"什么脏东西都有"的提醒文件：
 *   - 一条带**历史** `pendingDispatch`（attempts>0）的一次性提醒（可恢复的回执待办）；
 *   - 一条 `sentFor` 事实（崩溃恢复用）；
 *   - 一条 `unknown`（等人工收敛）；
 *   - 一条 `dispatchAbandoned*` 终态；
 *   - 一条**早就该被 prune** 的 fired 行（8 天前）；
 *   - 一条超期的 daily（错过窗口，但周期提醒不该被终结）。
 */
function seedDirty(file: string): void {
  const now = Date.now()
  const rows: Reminder[] = [
    {
      id: 'r_pending', text: '有待办的一次性', at: now - 10 * 60_000, room: 'dm', target: OWNER,
      createdBy: OWNER, created: now - 3 * HOUR, fired: false, firedAt: null, repeat: 'none',
      occurrence: { id: 'occ-pending', revision: 4 },
      pendingDispatch: { occurrenceId: 'occ-pending', revision: 4, at: now - 10 * 60_000, attempts: 3, since: now - 9 * 60_000 },
    },
    {
      id: 'r_sentfor', text: '已发出事实', at: now - 5 * 60_000, room: 'dm', target: OWNER,
      createdBy: OWNER, created: now - 2 * HOUR, fired: false, firedAt: null, repeat: 'none',
      occurrence: { id: 'occ-sent', revision: 1 },
      sentFor: now - 5 * 60_000, sentAt: now - 5 * 60_000 + 50,
    },
    {
      id: 'r_unknown', text: '未确认的', at: now - 20 * HOUR, room: 'dm', target: OWNER,
      createdBy: OWNER, created: now - 30 * HOUR, fired: true, firedAt: now - 20 * HOUR, repeat: 'none',
      unknownAt: now - 20 * HOUR, unknownReason: 'no-receipt',
    },
    {
      id: 'r_abandoned', text: '放弃过的', at: now - 40 * HOUR, room: 'dm', target: OWNER,
      createdBy: OWNER, created: now - 50 * HOUR, fired: true, firedAt: now - 40 * HOUR, repeat: 'none',
      dispatchAbandonedAt: now - 39 * HOUR, dispatchAbandonReason: 'attempts-exhausted:10',
    },
    {
      id: 'r_prunable', text: '该被清掉的', at: now - 9 * 86400_000, room: 'dm', target: OWNER,
      createdBy: OWNER, created: now - 10 * 86400_000, fired: true, firedAt: now - 8 * 86400_000, repeat: 'none',
    },
    {
      id: 'r_daily', text: '每天七点吃药', at: now - 30 * HOUR, room: 'dm', target: OWNER,
      createdBy: OWNER, created: now - 40 * HOUR, fired: false, firedAt: null, repeat: 'daily',
      occurrence: { id: 'occ-daily', revision: 2 },
    },
  ]
  fs.writeFileSync(file, `${JSON.stringify({ version: 1, reminders: rows }, null, 2)}\n`, 'utf8')
}

// ── R6-1：dryRun 整条入口零写入（六项一起） ───────────────────────────────

for (const outcome of ['ok', 'absent', 'fail'] as const) {
  test(`R6-1 (redispatch=${outcome}) dryRun 多拍：整份盘逐字段不变 + 六件事全不成立`, async () => {
    const home = tempHome(`qq-r6-${outcome}-`)
    const r = rig(home.dir, { dryRun: true, dispatched: outcome })
    try {
      seedDirty(r.file)
      await r.store.load()
      const before = readDisk(r.file)
      assert.ok((before as { reminders: Reminder[] }).reminders.some((item) => item.id === 'r_pending' && (item.pendingDispatch?.attempts ?? 0) > 0),
        '前置：确实种了一条带历史待办（attempts>0）的记录')

      for (let tick = 0; tick < 5; tick += 1) await r.tick()

      // **一条断言覆盖六件事**：整份盘（含顶层 version）逐字节语义相等。
      assert.deepEqual(readDisk(r.file), before, `dryRun 下整份盘必须不变（redispatch=${outcome}）`)

      const after = readDisk(r.file) as { reminders: Reminder[] }
      const pending = after.reminders.find((item) => item.id === 'r_pending')!
      assert.equal(pending.pendingDispatch?.attempts, 3, '① 不许增加次数')
      assert.ok(pending.pendingDispatch !== undefined, '② 不许清待办')
      assert.equal(pending.dispatchAbandonedAt, undefined, '③ 不许转 abandoned')
      assert.ok((after.reminders.find((item) => item.id === 'r_sentfor')?.sentFor ?? 0) > 0, '④ 不许清 sentFor')
      const daily = after.reminders.find((item) => item.id === 'r_daily')!
      assert.notEqual(daily.fired, true, '⑤ 不许推进/终结提醒（daily）')
      const dailyBefore = (before as { reminders: Reminder[] }).reminders.find((item) => item.id === 'r_daily')!
      assert.equal(daily.at, dailyBefore.at, '⑤ daily 的 at 一点也不许动')
      assert.ok(after.reminders.some((item) => item.id === 'r_prunable'), '⑥ 不许做启动 prune（该清的还在）')
      // **写端口一次都没被调用**（演练不写事件、不写 CAS）。
      assert.deepEqual(portCallsOf(r), [], 'dryRun 下不许调用任何写端口（CAS/dispatch/redispatch）')
      assert.equal(r.platform.count(), 0)
      assert.ok(r.logs.some((line) => line.includes('本拍不补回执')), '要有"整条入口零写入"的日志')
    } finally {
      await r.close()
      fs.rmSync(home.dir, { recursive: true, force: true })
    }
  })
}

test('R6-1b dryRun 关掉后同一条待办被正常补上，且**带身份**', async () => {
  const home = tempHome('qq-r6-resume-')
  const r = rig(home.dir, { dryRun: true, dispatched: 'ok' })
  try {
    seedDirty(r.file)
    await r.store.load()
    await r.tick()
    assert.deepEqual(portCallsOf(r), [], '演练期间不碰写端口')

    r.setDryRun(false)
    await r.tick()
    const calls = portCallsOf(r)
    assert.ok(calls.some((call) => call.startsWith('redispatch:occ-pending:')), `恢复投递要补回执：${calls.join(' | ')}`)
    const redispatch = calls.find((call) => call.startsWith('redispatch:'))!
    assert.equal(redispatch.split(':')[2], SESSION, '恢复路径也必须带 canonical sessionId（round6 P1）')
    const after = readDisk(r.file) as { reminders: Reminder[] }
    assert.equal(after.reminders.find((item) => item.id === 'r_pending')?.pendingDispatch, undefined, '补上后待办清掉')
  } finally {
    await r.close()
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})

// ── R6-2：dispatchNow 的身份（从 redispatch 路径实测） ─────────────────────

test('R6-2 恢复路径 `dispatchNow` 必须带 identity（以前漏了 ⇒ not-found）', async () => {
  const home = tempHome('qq-r6-ident-')
  const r = rig(home.dir, { dryRun: false, dispatched: 'ok' })
  try {
    seedDirty(r.file)
    await r.store.load()
    await r.tick()
    const call = portCallsOf(r).find((entry) => entry.startsWith('dispatch:'))
    assert.ok(call !== undefined, `要有 dispatchNow 调用：${portCallsOf(r).join(' | ')}`)
    assert.equal(call.split(':')[2], SESSION, `dispatchNow 的 sessionId 必须是 ${SESSION}（实际 ${call.split(':')[2]}）`)
  } finally {
    await r.close()
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})

// ── R6-3：resolver 能力校验 + 卸载后重挂 ──────────────────────────────────

test('R6-3 `agendaPortCapability`：缺任一方法即不可用；插件选端口时跳过旧/残缺对象', () => {
  const complete: AgendaPort = {
    casOccurrence: async () => ({ ok: true }),
    markOccurrenceDispatched: async () => ({ ok: true }),
    nextOccurrence: async () => ({ ok: true, occurrence: { id: 'o', revision: 1 } }),
  }
  assert.equal(agendaPortCapability(complete).ok, true)
  assert.deepEqual(agendaPortCapability({ casOccurrence: () => ({ ok: true }) }).missing.sort(),
    ['markOccurrenceDispatched', 'nextOccurrence'])
  assert.equal(agendaPortCapability(null).ok, false)
  assert.equal(agendaPortCapability('agenda').ok, false)
  // **旧对象**（只有两个方法）不许当端口用。
  const legacy = { casOccurrence: async () => ({ ok: true }), markOccurrenceDispatched: async () => ({ ok: true }) }
  assert.equal(agendaPortCapability(legacy).ok, false, '旧对象缺 nextOccurrence ⇒ 不可用')
})

test('R6-3b 插件装配：先放残缺对象再放正确的 → 选到正确的；卸载后重挂能接回', async () => {
  const home = tempHome('qq-r6-resolver-')
  const logs: string[] = []
  const base = baseConfig({ admins: [OWNER] }) as unknown as QQChannelConfig
  const config = { ...base, reminders: { enabled: true, dryRun: true, file: null } } as QQChannelConfig
  const complete: AgendaPort = {
    casOccurrence: async () => ({ ok: true }),
    markOccurrenceDispatched: async () => ({ ok: true }),
    nextOccurrence: async () => ({ ok: true, occurrence: { id: 'o-next', revision: 2 } }),
  }
  const legacy = { casOccurrence: async () => ({ ok: true }) }
  // 宿主：`companionAgenda` 先给一个**残缺**对象，之后换成正确的。
  let published: unknown = legacy
  let resolveCalls = 0
  const host = {
    config,
    log: (line: string) => { logs.push(line) },
    need: () => ({ api: new FakePlatform().api, out: new FakeOutboundQueue() }),
    provide: () => {},
    registerResource: () => {},
    bridge: { toolHost: () => ({ register: () => {} }) },
    get: () => undefined,
    // 插件装配只用到这些
    ctxGet: () => published,
  } as unknown as SubHost
  try {
    configureAgendaPort(null)
    configureAgendaResolver(() => {
      resolveCalls += 1
      const capability = agendaPortCapability(published)
      return capability.ok ? published as AgendaPort : null
    }, (line) => { logs.push(line) })
    assert.equal(agendaPortOf(), null, '残缺对象不许被当成端口')
    published = complete
    assert.equal(agendaPortOf(), complete, '换成正确的对象后必须接上')
    // **卸载**：连续 3 次解析不到 → 丢弃旧引用。
    published = null
    agendaPortOf()
    agendaPortOf()
    assert.equal(agendaPortOf(), null, '卸载后（连续 3 次解析不到）必须丢弃旧引用')
    // **重挂**：换成一个新对象。
    const remounted: AgendaPort = {
      casOccurrence: async () => ({ ok: true }),
      markOccurrenceDispatched: async () => ({ ok: true }),
      nextOccurrence: async () => ({ ok: true, occurrence: { id: 'o-new', revision: 3 } }),
    }
    published = remounted
    assert.equal(agendaPortOf(), remounted, '重挂后要能接回新对象')
    assert.ok(resolveCalls > 3)
    void host
  } finally {
    configureAgendaPort(null)
    configureAgendaResolver(null)
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})

// ── R6-4：读盘要含顶层字段（R5-1 的加强前提） ──────────────────────────────

test('R6-4 `readDisk` 覆盖顶层字段：version 变化也能被发现', async () => {
  const home = tempHome('qq-r6-top-')
  const r = rig(home.dir, { dryRun: true })
  try {
    seedDirty(r.file)
    await r.store.load()
    const before = readDisk(r.file) as { version: number }
    assert.equal(before.version, 1)
    // 模拟"别人改了顶层 version"：deepEqual 必须能发现（说明 readDisk 没丢顶层）。
    const tampered = { ...(before as Record<string, unknown>), version: 99 }
    fs.writeFileSync(r.file, `${JSON.stringify(tampered, null, 2)}\n`, 'utf8')
    const after = readDisk(r.file) as { version: number }
    assert.notDeepEqual(after, before, '顶层字段必须在比较范围内')
  } finally {
    await r.close()
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})

// ── R6-5：启动 prune 在 dryRun 下不发生（走真插件 apply） ──────────────────

test('R6-5 插件 apply：dryRun 下不做启动 prune；关掉后才清', async () => {
  const home = tempHome('qq-r6-prune-')
  const logs: string[] = []
  let provided: ReminderStore | undefined
  const makeHost = (dryRun: boolean): SubHost => {
    const base = baseConfig({ admins: [OWNER] }) as unknown as QQChannelConfig
    // **workspacePath 必须指向这个临时目录**：插件内部用 storeOptions(host) 推文件路径，
    // 不设就会去 baseConfig 的默认工作区（那里没有我们种的数据）。
    const config = { ...base, workspacePath: home.dir, reminders: { enabled: true, dryRun, file: null } } as QQChannelConfig
    return {
      config,
      log: (line: string) => { logs.push(line) },
      need: () => ({ api: new FakePlatform().api, out: new FakeOutboundQueue() }),
      // 插件 `apply()` 自己建 store 并 provide 出来——**测试不许再建一个**（同一文件只允许一个活跃实例）。
      provide: (name: string, value: unknown) => { if (name === 'reminders') provided = value as ReminderStore },
      registerResource: () => {},
      bridge: { toolHost: () => ({ register: () => {} }) },
      dshHome: home.dir,
      get: () => provided,
    } as unknown as SubHost
  }
  try {
    seedDirty(path.join(home.dir, 'reminders.json'))
    // dryRun=true：apply 之后那条"该被清掉的"必须还在。
    const dispose1 = await remindersPlugin.apply(makeHost(true)) as (() => Promise<void>) | undefined
    let rows = (readDisk(path.join(home.dir, 'reminders.json')) as { reminders: Reminder[] }).reminders
    assert.ok(rows.some((item) => item.id === 'r_prunable'), 'dryRun 下不许 prune')
    assert.ok(logs.some((line) => line.includes('跳过启动清理')), '日志要说明为什么没清')
    if (dispose1 !== undefined) await dispose1()

    // dryRun=false：这次才会真的清。
    logs.length = 0
    const dispose2 = await remindersPlugin.apply(makeHost(false)) as (() => Promise<void>) | undefined
    rows = (readDisk(path.join(home.dir, 'reminders.json')) as { reminders: Reminder[] }).reminders
    assert.equal(rows.some((item) => item.id === 'r_prunable'), false, '关掉演练后才清')
    if (dispose2 !== undefined) await dispose2()
  } finally {
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})
