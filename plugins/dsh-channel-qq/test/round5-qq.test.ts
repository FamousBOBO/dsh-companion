import { expectOk, expectRejected } from './fakes/reminders.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { QQChannelConfig } from '../src/config.js'
import { ReminderStore, type Reminder } from '../src/features/reminders/store.js'
import { MAX_CATCH_UP_PER_TICK, ReminderRunner } from '../src/features/reminders/runner.js'
import { configureReminderSeams, deliverReminder, resourceListOf } from '../src/features/reminders/index.js'
import { CATCH_UP_MAX_TOTAL, CATCH_UP_WINDOW_MS } from '../src/features/reminders/catch-up.js'
import {
  agendaPortOf, configureAgendaPort, configureAgendaResolver, identityOfReminder, liveSeams, nextOccurrenceOf,
  type AgendaPort,
} from '../src/features/reminders/agenda-seam.js'
import { baseConfig, tempHome, FakeOutboundQueue, FakePlatform } from './fakes/contact.js'
import type { SubHost } from '../src/features/plugin-kit.js'

// 第五轮复审（round5 D4）：**dryRun 开着也会永久停掉周期提醒**。
//
// 缺陷：runner 先 expire/cap 再 send、再识别 dry-run，而 catch-up 不区分 repeat ⇒
// 超期的 daily/weekly 被 `fired=true` ⇒ 永久停掉。这是"演练模式下也丢数据"。
//
// 本文件证明四件事（Lead 指定验收）：
//   R5-1 dryRun 多拍前后**持久状态逐字段不变**（不只是"没发消息"）；
//   R5-2 daily/weekly 错过当前轮次后**未来轮次仍存在**（at 已推进、fired 不为真）；
//   R5-3 21 条溢出只按明确策略处理（一次性提醒照旧 too-old / backlog-overflow）；
//   R5-4 一次性提醒的 too-old / backlog-overflow **行为不变**（不回归 B7）。

const OWNER = 10001
const HOUR = 3_600_000

interface Rig {
  readonly store: ReminderStore
  readonly logs: string[]
  readonly platform: FakePlatform
  readonly file: string
  readonly tick: () => Promise<void>
  readonly setDryRun: (value: boolean) => void
  readonly close: () => void
}

function rig(dir: string, options: { dryRun?: boolean } = {}): Rig {
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
    get: (name: string) => {
      if (name === 'platform') return { api: platform.api, out: queue }
      if (name === 'reminders') return store
      return undefined
    },
  } as unknown as SubHost
  configureReminderSeams({})
  const runner = new ReminderRunner(
    store,
    (reminder) => deliverReminder(host, reminder),
    (line) => { logs.push(line) },
    () => true,
    async () => null,
    async () => 'ok' as const,
    () => dryRun,
  )
  return {
    store,
    logs,
    platform,
    file: path.join(dir, 'reminders.json'),
    tick: async () => { await (runner as unknown as { tick(): Promise<void> }).tick() },
    setDryRun: (value: boolean) => { dryRun = value; (config as { reminders: { dryRun: boolean } }).reminders.dryRun = value },
    // **A 类修复（通用形态）**：原来只重置接缝、**没关 store** ⇒ 同目录第二个 rig 必 OWNER_CONFLICT。
  close: async () => { configureReminderSeams({}); configureAgendaPort(null); configureAgendaResolver(null); await store.close() },
  }
}

const readRows = (file: string): Reminder[] => (JSON.parse(fs.readFileSync(file, 'utf8')) as { reminders: Reminder[] }).reminders

const addRepeat = async (store: ReminderStore, at: number, repeat: 'daily' | 'weekly' = 'daily'): Promise<Reminder> =>
  expectOk(await store.add({
    text: '每天七点吃药',
    at,
    room: 'dm',
    target: OWNER,
    createdBy: OWNER,
    repeat,
    occurrence: { id: 'occ-rep', revision: 2 },
  }))

// ── R5-1：dryRun 多拍，持久状态逐字段不变 ─────────────────────────────────

test('R5-1 dryRun 连跑多拍：超期的周期提醒**一个字段都不改**（不是只看"没发消息"）', async () => {
  const home = tempHome('qq-r5a-')
  const r = rig(home.dir, { dryRun: true })
  try {
    await r.store.load()
    // 一条"早就该响"的 daily（超出补发窗口）+ 一条刚过期的 daily + 一条超期的一次性。
    await addRepeat(r.store, Date.now() - 30 * HOUR, 'daily')
    await addRepeat(r.store, Date.now() - 60_000, 'weekly')
    expectOk(await r.store.add({
      text: '一次性的',
      at: Date.now() - 30 * HOUR,
      room: 'dm',
      target: OWNER,
      createdBy: OWNER,
      repeat: 'none',
      occurrence: { id: 'occ-one', revision: 1 },
    }))
    const before = readRows(r.file)
    assert.equal(before.length, 3)

    // **round6 P2 加强**：再种一条**带历史 `pendingDispatch`（attempts>0）**的记录，
    // 并**整份盘**（含顶层 `version`）比对——以前只比 `reminders` 数组，漏掉顶层字段与待办。
    const seeded = JSON.parse(fs.readFileSync(r.file, 'utf8')) as { version: number, reminders: Reminder[] }
    seeded.reminders.push({
      id: 'r_hist', text: '有历史待办的一次性', at: Date.now() - 10 * 60_000, room: 'dm', target: OWNER,
      createdBy: OWNER, created: Date.now() - HOUR, fired: false, firedAt: null, repeat: 'none',
      occurrence: { id: 'occ-hist', revision: 2 },
      pendingDispatch: {
        occurrenceId: 'occ-hist', revision: 2, at: Date.now() - 10 * 60_000, attempts: 2, since: Date.now() - 9 * 60_000,
      },
    })
    fs.writeFileSync(r.file, `${JSON.stringify(seeded, null, 2)}\n`, 'utf8')
    await r.store.load()
    const diskBefore = JSON.parse(fs.readFileSync(r.file, 'utf8')) as { version: number, reminders: Reminder[] }

    for (let i = 0; i < 4; i += 1) await r.tick()

    assert.equal(r.platform.count(), 0, '演练当然不发消息')
    // **整份盘**（含顶层字段 + 历史待办）逐字段比对。
    assert.deepEqual(JSON.parse(fs.readFileSync(r.file, 'utf8')), diskBefore,
      'dryRun 下持久状态必须一个字段都不变（含顶层 version、pendingDispatch.attempts、at/fired/occurrence）')
    const hist = (JSON.parse(fs.readFileSync(r.file, 'utf8')) as { reminders: Reminder[] }).reminders
      .find((item) => item.id === 'r_hist')
    assert.equal(hist?.pendingDispatch?.attempts, 2, '**不许**给历史待办加次数（round6 D4：整条入口零写入）')
    assert.ok(r.logs.some((line) => line.includes('dryRun 命中')), '要有演练日志')
  } finally {
    await r.close()
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})

// ── R5-2：周期提醒错过当前轮次后，未来轮次仍存在 ──────────────────────────

test('R5-2 daily 错过当前轮次 → 只跳过这一轮（at 推进到下一轮、fired 不为真、不被终结）', async () => {
  const home = tempHome('qq-r5b-')
  const r = rig(home.dir) // 非 dryRun：这时才允许写"推进一轮"
  try {
    await r.store.load()
    const stale = await addRepeat(r.store, Date.now() - 30 * HOUR, 'daily')
    await r.tick()

    const after = readRows(r.file).find((item) => item.id === stale.id)!
    assert.equal(r.platform.count(), 0, '错过的那一轮**不发**（不发陈旧提醒）')
    assert.notEqual(after.fired, true, '**不许**把周期提醒标成 fired（那就是永久停掉）')
    assert.equal(after.repeat, 'daily', 'repeat 不变')
    assert.ok(after.at > Date.now(), `at 必须推进到未来（实际 ${new Date(after.at).toISOString()}）`)
    assert.equal(after.expiredReason, undefined, '周期提醒不该出现 skipped-expired 终态原因')
    assert.equal(after.expiredAt, undefined, '也不该有终态时间戳')
    assert.ok(r.logs.some((line) => line.includes('只跳过这一轮')), `日志要能区分"跳一轮"与"永久丢弃"：${r.logs.join(' | ')}`)

    // 再跑几拍：这条不会再被当成 due 反复触发。
    for (let i = 0; i < 3; i += 1) await r.tick()
    assert.equal(r.platform.count(), 0, '下一轮还没到，不该发')
    const stillThere = readRows(r.file).find((item) => item.id === stale.id)!
    assert.ok(stillThere.at > Date.now(), '未来的轮次仍然存在')
  } finally {
    await r.close()
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})

test('R5-2b weekly 同理：推进到下一周，而不是终结', async () => {
  const home = tempHome('qq-r5c-')
  const r = rig(home.dir)
  try {
    await r.store.load()
    const stale = await addRepeat(r.store, Date.now() - 30 * HOUR, 'weekly')
    await r.tick()
    const after = readRows(r.file).find((item) => item.id === stale.id)!
    assert.notEqual(after.fired, true)
    const days = (after.at - Date.now()) / (24 * HOUR)
    assert.ok(days > 5, `weekly 的下一轮应该在一周内（实际 ${String(Math.round(days))} 天后）`)
  } finally {
    await r.close()
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})

// ── R5-3：21 条溢出：三闸只作用于一次性提醒 ────────────────────────────────

test('R5-3 21 条超期：只有一次性提醒被淘汰，周期提醒**一条都不丢**', async () => {
  const home = tempHome('qq-r5d-')
  const r = rig(home.dir)
  try {
    await r.store.load()
    // 21 条**一次性**刚过期（窗口内，超总量上限 20 ⇒ 丢 1 条最老）+ 3 条**周期**也刚过期。
    for (let index = 0; index < 21; index += 1) {
      expectOk(await r.store.add({
        text: `一次性 ${String(index)}`,
        at: Date.now() - 60_000 - index * 60_000,
        room: 'dm',
        target: OWNER,
        createdBy: OWNER,
        repeat: 'none',
        occurrence: { id: `occ-o-${String(index)}`, revision: 1 },
      }))
    }
    const repeats: Reminder[] = []
    for (let index = 0; index < 3; index += 1) {
      repeats.push(await addRepeat(r.store, Date.now() - 120_000 - index * 60_000, 'daily'))
    }
    await r.tick()

    const rows = readRows(r.file)
    // 一次性：恰好 1 条被判 backlog-overflow（21 - 20）。
    const overflow = rows.filter((item) => item.expiredReason === 'skipped-expired:backlog-overflow')
    assert.equal(overflow.length, 1, `一次性提醒按上限丢 1 条（实际 ${String(overflow.length)}）`)
    // 周期提醒：一条都没被淘汰。
    for (const repeat of repeats) {
      const row = rows.find((item) => item.id === repeat.id)
      assert.ok(row !== undefined)
      assert.notEqual(row.fired, true, '周期提醒不许被 fired')
      assert.equal(row.expiredReason, undefined, '周期提醒不许出现 skipped-expired')
    }
    // 每拍上限 3 也只算一次性：周期提醒**照发**（3 条 daily 都发了）。
    const sent = r.platform.count()
    assert.ok(sent >= 3, `周期提醒不该被积压挤掉（本拍发了 ${String(sent)} 条）`)
    assert.ok(sent <= 3 + MAX_CATCH_UP_PER_TICK, '一次性最多 3 条 + 周期提醒本身')
  } finally {
    await r.close()
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})

// ── R5-7：清单被截断必须可见（task-59 P2 之一） ────────────────────────────

test('R5-7 `droppedItems` 超过 20 条时：`droppedTotal`/`droppedTruncated` 说明清单不全，日志也写明', async () => {
  const home = tempHome('qq-trunc-')
  const r = rig(home.dir)
  try {
    await r.store.load()
    // 丢掉 25 条：窗口内造 45 条一次性（上限 20 ⇒ 丢 25），超过清单上限 20。
    for (let index = 0; index < 45; index += 1) {
      expectOk(await r.store.add({
        text: `积压 ${String(index)}`,
        at: Date.now() - 60_000 - index * 60_000,
        room: 'dm',
        target: OWNER,
        createdBy: OWNER,
        repeat: 'none',
        occurrence: { id: `occ-t-${String(index)}`, revision: 1 },
      }))
    }
    await r.tick()
    const metrics = r.store.catchUpDiagnostics()
    assert.equal(metrics.dropped, 25, '丢了 25 条（45 - 20）')
    assert.equal(metrics.droppedItems.length, 20, '清单只列 20 条（上限）')
    assert.equal(metrics.droppedTotal, 25, `droppedTotal 必须是真实总数（实际 ${String(metrics.droppedTotal)}）`)
    assert.equal(metrics.droppedTruncated, true, '**必须标明清单被截断**')
    // 日志：列出 5 条，并明说"还有 N 条没列出"。
    assert.ok(r.logs.some((line) => line.includes('丢弃明细只列了 5 条')), `日志要说明清单不全：${r.logs.join(' | ')}`)
    assert.ok(r.logs.some((line) => line.includes('droppedTruncated=true')), '日志要给出可查的字段名')

    // 反面：没被截断时 `droppedTruncated` 必须是 false（别恒真）。
    const small = tempHome('qq-trunc-small-')
    const r2 = rig(small.dir)
    try {
      await r2.store.load()
      for (let index = 0; index < 23; index += 1) {
        expectOk(await r2.store.add({
          text: `小 ${String(index)}`,
          at: Date.now() - 60_000 - index * 60_000,
          room: 'dm', target: OWNER, createdBy: OWNER, repeat: 'none',
          occurrence: { id: `occ-s-${String(index)}`, revision: 1 },
        }))
      }
      await r2.tick()
      const m2 = r2.store.catchUpDiagnostics()
      assert.equal(m2.dropped, 3, '23 - 20 = 3')
      assert.equal(m2.droppedTotal, 3)
      assert.equal(m2.droppedTruncated, false, '清单完整时不许标成截断')
    } finally {
      await r2.close()
      fs.rmSync(small.dir, { recursive: true, force: true })
    }
  } finally {
    await r.close()
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})

// ── R5-8：连续解析不到 → 丢弃旧端口（task-59 P2 之二） ──────────────────────

test('R5-8 agenda 端口：偶发一次解析不到仍沿用旧端口；**连续 3 次**则丢弃并记日志', async () => {
  const logs: string[] = []
  const fake: AgendaPort = { casOccurrence: async () => ({ ok: true }) }
  let answer: AgendaPort | null = fake
  try {
    configureAgendaPort(null)
    configureAgendaResolver(() => answer, (line) => { logs.push(line) })

    // ① 正常解析到。
    assert.notEqual(agendaPortOf(), null, '解析得到时返回真对象')
    // ② 偶发一次失败（<3）：**仍沿用**旧端口。
    answer = null
    assert.notEqual(agendaPortOf(), null, '只失败 1 次不许丢（瞬时故障）')
    assert.equal(logs.filter((line) => line.includes('已丢弃旧引用')).length, 0)
    // ③ 恢复一次 → streak 归零。
    answer = fake
    assert.notEqual(agendaPortOf(), null)
    answer = null
    agendaPortOf()
    // ④ 连续 3 次解析不到 → 丢弃旧引用 + 日志。
    agendaPortOf()
    const dropped = agendaPortOf()
    assert.equal(dropped, null, '连续 3 次解析不到必须丢弃旧端口（不能用着已被卸载的服务）')
    assert.ok(logs.some((line) => line.includes('agenda 端口连续 3 次解析不到，已丢弃旧引用')),
      `要有明确日志：${logs.join(' | ')}`)
  } finally {
    configureAgendaPort(null)
    configureAgendaResolver(null)
  }
})

// ── R5-6：反向饥饿——周期提醒不能把一次性提醒挤到永远轮不上 ────────────────

test('R5-6 50 条同时到点的 daily + 5 条一次性：一次性在有限拍内全部发出（不被周期挤死）', async () => {
  const home = tempHome('qq-starve-')
  const r = rig(home.dir)
  try {
    await r.store.load()
    // 50 条 daily + 5 条一次性，**同一时刻**到点。
    const at = Date.now() - 60_000
    for (let index = 0; index < 50; index += 1) {
      expectOk(await r.store.add({
        text: `每日 ${String(index)}`,
        at,
        room: 'dm',
        target: OWNER,
        createdBy: OWNER,
        repeat: 'daily',
        occurrence: { id: `occ-d${String(index)}`, revision: 1 },
      }))
    }
    const oneShotIds: string[] = []
    for (let index = 0; index < 5; index += 1) {
      const item = expectOk(await r.store.add({
        text: `一次性 ${String(index)}`,
        at,
        room: 'dm',
        target: OWNER,
        createdBy: OWNER,
        repeat: 'none',
        occurrence: { id: `occ-s${String(index)}`, revision: 1 },
      }))
      oneShotIds.push(item.id)
    }
    // 每拍上限只对一次性计数（3 条/拍）⇒ 5 条一次性最迟第 2 拍发完。
    // 断言"有限拍"：跑 3 拍就必须一条不剩地被标成已触发。
    for (let tick = 0; tick < 3; tick += 1) await r.tick()
    const rows = readRows(r.file)
    const unsent = oneShotIds.filter((id) => rows.find((item) => item.id === id)?.fired !== true)
    assert.deepEqual(unsent, [], `一次性提醒不许被周期提醒饿死（还剩 ${String(unsent.length)} 条没发）`)
    // 50 条 daily 也都发过一轮并推进到下一轮（不会因为"每拍上限"被拖住）。
    const repeats = rows.filter((item) => item.repeat === 'daily')
    assert.equal(repeats.length, 50)
    assert.ok(repeats.every((item) => item.at > Date.now()), 'daily 全部推进到未来')
    assert.ok(repeats.every((item) => item.fired !== true), 'daily 不该被标成已触发')
    // 发送总数 = 50（周期）+ 5（一次性）。
    assert.equal(r.platform.count(), 55, `应发出 55 条（实际 ${String(r.platform.count())}）`)
  } finally {
    await r.close()
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})


test('R5-5 从 QQ 真实入口投递：CAS / dispatched / 换绑取数的实参里都带 canonical sessionId', async () => {
  const home = tempHome('qq-ident-')
  const base = baseConfig({ admins: [OWNER] }) as unknown as QQChannelConfig
  const config = {
    ...base,
    groupEnabled: true,
    reminders: { enabled: true, dryRun: false, file: null },
  } as QQChannelConfig
  const logs: string[] = []
  const store = new ReminderStore(config.reminders, { workspacePath: home.dir, dshHome: home.dir, log: (line) => { logs.push(line) } })
  const platform = new FakePlatform()
  const queue = new FakeOutboundQueue()
  const host = {
    config,
    log: (line: string) => { logs.push(line) },
    get: (name: string) => (name === 'platform' ? { api: platform.api, out: queue } : name === 'reminders' ? store : undefined),
  } as unknown as SubHost

  // **真实接缝**：`seamsOf(agenda, log)` → 它会把下发参数原样交给 agenda 端口。
  const seen: Array<{ call: string; input: Record<string, unknown> }> = []
  const agenda: AgendaPort = {
    casOccurrence: async (input) => { seen.push({ call: 'cas', input: { ...input } }); return { ok: true, revision: 1 } },
    markOccurrenceDispatched: async (input) => { seen.push({ call: 'mark', input: { ...input } }); return { ok: true } },
    nextOccurrence: async (input) => {
      seen.push({ call: 'next', input: { ...input } })
      return { ok: true, occurrence: { id: 'occ-next', revision: 2 } }
    },
  }
  configureAgendaPort(agenda)
  configureAgendaResolver(() => agenda)
  configureReminderSeams(liveSeams((line) => { logs.push(line) }))
  try {
    await store.load()
    // 一条**私聊**周期提醒：走 CAS → 真发 → dispatched → 换绑取数 全链路。
    const reminder = expectOk(await store.add({
      text: '每天九点吃药',
      at: Date.now() - 60_000,
      room: 'dm',
      target: OWNER,
      createdBy: OWNER,
      repeat: 'daily',
      occurrence: { id: 'occ-ident', revision: 1 },
    }))
    // 从**真实入口**驱动：runner 的 send 就是 deliverReminder（与生产装配一致）。
    const runner = new ReminderRunner(
      store,
      (item) => deliverReminder(host, item),
      (line) => { logs.push(line) },
      () => true,
      async (item) => await nextOccurrenceOf(item),
      async () => 'ok' as const,
      () => false,
    )
    await (runner as unknown as { tick(): Promise<void> }).tick()

    assert.equal(platform.count(), 1, '前置：真的发出去了')
    const cas = seen.find((entry) => entry.call === 'cas')
    const mark = seen.find((entry) => entry.call === 'mark')
    const next = seen.find((entry) => entry.call === 'next')
    assert.ok(cas !== undefined, `CAS 必须被调用：${JSON.stringify(seen)}`)
    assert.ok(mark !== undefined, 'markOccurrenceDispatched 必须被调用')
    assert.ok(next !== undefined, '换绑取数必须被调用')
    // 三个调用点都必须带 **canonical sessionId**（runtime 用它解 scope）。
    const expected = `qq-dm-${String(OWNER)}`
    for (const entry of [cas!, mark!, next!]) {
      assert.equal(entry.input.sessionId, expected, `${entry.call} 的 sessionId 必须是 ${expected}（实际 ${String(entry.input.sessionId)}）`)
    }
    // 身份与建日程时用的规则**同一个**（`sessionIdOf(dmRoom(target))`）。
    assert.equal(identityOfReminder({ room: 'dm', target: OWNER })?.sessionId, expected)
    // 群聊同样派生（换个房间只需换 canonical 前缀）。
    assert.equal(identityOfReminder({ room: 'group', target: 55555 })?.sessionId, 'qq-group-55555')
    // 非法目标：宁可不传（诚实降级），也不传一个假身份。
    assert.equal(identityOfReminder({ room: 'dm', target: 0 }), undefined)
    assert.equal(identityOfReminder({ room: 'dm', target: Number.NaN }), undefined)
    void reminder
  } finally {
    configureReminderSeams({})
    configureAgendaPort(null)
    configureAgendaResolver(null)
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})


test('R5-4 一次性提醒：超出窗口 → too-old；窗口内超上限 → backlog-overflow（不回归 B7）', async () => {
  const home = tempHome('qq-r5e-')
  const r = rig(home.dir)
  try {
    await r.store.load()
    // 2 条超窗口（一次性）+ 25 条窗口内（一次性，超上限 20 ⇒ 丢 5）。
    for (let index = 0; index < 2; index += 1) {
      expectOk(await r.store.add({
        text: `太旧 ${String(index)}`,
        at: Date.now() - CATCH_UP_WINDOW_MS - 2 * HOUR,
        room: 'dm',
        target: OWNER,
        createdBy: OWNER,
        repeat: 'none',
        occurrence: { id: `occ-old-${String(index)}`, revision: 1 },
      }))
    }
    for (let index = 0; index < 25; index += 1) {
      expectOk(await r.store.add({
        text: `窗口内 ${String(index)}`,
        at: Date.now() - 60_000 - index * 60_000,
        room: 'dm',
        target: OWNER,
        createdBy: OWNER,
        repeat: 'none',
        occurrence: { id: `occ-in-${String(index)}`, revision: 1 },
      }))
    }
    await r.tick()
    const rows = readRows(r.file)
    assert.equal(rows.filter((item) => item.expiredReason === 'skipped-expired:too-old').length, 2, 'too-old 仍是 2 条')
    // 窗口内 25 条、上限 20 ⇒ 丢 5 条**最老的**（其余 20 条继续排队/发送）。
    const overflowRows = rows.filter((item) => item.expiredReason === 'skipped-expired:backlog-overflow')
    assert.equal(overflowRows.length, 5, `backlog-overflow 仍是 5 条（实际 ${String(overflowRows.length)}）`)
    // 丢的必须是最老的那 5 条（`at` 最小的）——用集合相等断言，不只数条数。
    const inWindow = rows
      .filter((item) => item.occurrence?.id?.startsWith('occ-in-'))
      .sort((a, b) => a.at - b.at)
      .slice(0, 5)
      .map((item) => item.id)
      .sort()
    assert.deepEqual(overflowRows.map((item) => item.id).sort(), inWindow, '丢的是最老的 5 条')
    const metrics = r.store.catchUpDiagnostics()
    assert.equal(metrics.dropped, 5)
    assert.equal(metrics.maxTotal, CATCH_UP_MAX_TOTAL)
    // `droppedItems` 是"被丢弃的清单"，**两种原因都算**（too-old 2 + overflow 5 = 7）。
    assert.equal(metrics.droppedItems.length, 7, `清单要包含两种原因（实际 ${String(metrics.droppedItems.length)}）`)
    assert.deepEqual(
      [...new Set(metrics.droppedItems.map((item) => item.reason))].sort(),
      ['skipped-expired:backlog-overflow', 'skipped-expired:too-old'],
      '清单里两种原因都要能看到',
    )
    assert.equal(resourceListOf(r.store)().catchUp.dropped, 5, '后台计数同源')
  } finally {
    await r.close()
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})
