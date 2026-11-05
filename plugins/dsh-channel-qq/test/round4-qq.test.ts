import { expectOk, expectRejected } from './fakes/reminders.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { QQChannelConfig } from '../src/config.js'
import { ReminderStore, type Reminder } from '../src/features/reminders/store.js'
import { storeFault } from '../src/features/reminders/store-contract.js'
import { MAX_CATCH_UP_PER_TICK, ReminderRunner } from '../src/features/reminders/runner.js'
import { configureReminderSeams, deliverReminder } from '../src/features/reminders/index.js'
import {
  agendaPortOf, configureAgendaPort, configureAgendaResolver, liveSeams, seamsOf, type AgendaPort,
} from '../src/features/reminders/agenda-seam.js'
import { baseConfig, tempHome, FakeOutboundQueue, FakePlatform } from './fakes/contact.js'
import type { SubHost } from '../src/features/plugin-kit.js'

// 终审 round4（QQ 侧四条 P1）的证据文件：
//   B7 dryRun 关掉后的雪崩补发（补发窗口 + 每拍条数上限）
//   B8 `markSent()` 返回 false 时不许当成功
//   C4 agenda 惰性解析（启动没有 → 之后出现 → 下次使用能接上）
//   D2 `pruneFired` 不许删掉还有待补 dispatched 的行

const OWNER = 10001
const NOW = 1_762_000_000_000
const HOUR = 3_600_000

interface Rig {
  readonly store: ReminderStore
  readonly runner: ReminderRunner
  readonly platform: FakePlatform
  readonly file: string
  readonly logs: string[]
  readonly dispatched: string[]
  readonly tick: () => Promise<void>
  readonly close: () => void
}

function rig(dir: string, options: {
  dispatched?: 'ok' | 'reject'
  markSentFails?: boolean
} = {}): Rig {
  const logs: string[] = []
  const base = baseConfig({ admins: [OWNER] }) as unknown as QQChannelConfig
  const config = {
    ...base,
    groupEnabled: true,
    rooms: [],
    reminders: { enabled: true, dryRun: false, file: null },
  } as QQChannelConfig
  const real = new ReminderStore(config.reminders, { workspacePath: dir, dshHome: dir, log: (line) => { logs.push(line) } })
  // B8 的注入点：让 `markSent` 报"没落盘"（其余方法照旧走真实现）。
  // **B8**：让 `markSent` 报"没落盘"。task-66 起"没落盘"是**基础设施故障** ⇒ reject
  // （以前假 store 回 boolean `false`，是旧契约；日志因此打出 `undefined：undefined`）。
  const store = options.markSentFails === true
    ? Object.assign(Object.create(real) as ReminderStore, {
      markSent: async (): Promise<never> => { throw storeFault('PERSIST_FAILED', 'markSent', '桩：模拟没落盘') },
    })
    : real
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
  const dispatched: string[] = []
  configureReminderSeams({
    dispatchNow: async (occurrenceId) => {
      dispatched.push(occurrenceId)
      return options.dispatched === 'reject' ? { ok: false, code: 'rejected' } : { ok: true }
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
      dispatched.push(pending.occurrenceId)
      // 三态：ok / absent / fail（round4 之后 runner 会按它决定"清待办"还是"累加次数"）。
      return options.dispatched === 'reject' ? 'fail' as const : 'ok' as const
    },
  )
  return {
    store,
    runner,
    platform,
    file: path.join(dir, 'reminders.json'),
    logs,
    dispatched,
    tick: async () => { await (runner as unknown as { tick(): Promise<void> }).tick() },
    // **A 类修复（通用形态）**：原来只重置接缝、**没关 store** ⇒ 同目录第二个 rig 必 OWNER_CONFLICT。
  close: async () => { configureReminderSeams({}); configureAgendaPort(null); configureAgendaResolver(null); await real.close() },
  }
}

const readAll = (file: string): Reminder[] => (JSON.parse(fs.readFileSync(file, 'utf8')) as { reminders: Reminder[] }).reminders

/**
 * 造 `count` 条到期的一次性提醒。
 *
 * `bound` 默认 true（绑 occurrence）；**"没有 agenda 的部署"必须传 `bound: false`** ——
 * 那种部署里提醒根本不会有 occurrence，`occurrence === null` 会短路掉 CAS。
 * 以前 C4-2 用了绑定提醒去测"没有 agenda"，于是 absent 不放行把测试弄红（判据其实是对的）。
 */
const seed = async (
  store: ReminderStore,
  count: number,
  at: number,
  options: { bound?: boolean } = {},
): Promise<string[]> => {
  const ids: string[] = []
  for (let index = 0; index < count; index += 1) {
    const item = expectOk(await store.add({
      text: `提醒 ${String(index)}`,
      at,
      room: 'dm',
      target: OWNER,
      createdBy: OWNER,
      repeat: 'none',
      ...(options.bound === false ? {} : { occurrence: { id: `occ-${String(index)}`, revision: 1 } }),
    }))
    ids.push(item.id)
  }
  return ids
}

// ── B7：一次 20 条过期 → 每拍最多 M 条，超窗口的转终态 ─────────────────────

test('B7-1 20 条刚过期：单拍最多 MAX_CATCH_UP_PER_TICK 条，其余下一拍继续（不丢弃）', async () => {
  const home = tempHome('qq-b7a-')
  const r = rig(home.dir)
  try {
    await r.store.load()
    await seed(r.store, 20, Date.now() - 60_000) // 一分钟前到点：仍在补发窗口内
    assert.equal(r.store.due().length, 20, '前置：20 条都在窗口内、都 due')
    await r.tick()
    const sentFirst = r.platform.count()
    assert.equal(sentFirst, MAX_CATCH_UP_PER_TICK, `单拍最多 ${String(MAX_CATCH_UP_PER_TICK)} 条（实际 ${String(sentFirst)}）`)
    assert.ok(r.logs.some((line) => line.includes('按每拍上限')), `日志要说清被限流：${r.logs.join(' | ')}`)
    // 剩下的仍然 due（没被丢弃、没被标 fired）。
    assert.equal(r.store.due().length, 20 - MAX_CATCH_UP_PER_TICK, '其余留在 due 里')
    // 再几拍就把剩下的发完，且总数对得上。
    for (let i = 0; i < 10 && r.store.due().length > 0; i += 1) await r.tick()
    assert.equal(r.platform.count(), 20, '全部补完（一条不漏、一条不重）')
  } finally {
    await r.close()
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})

test('B7-2 超出补发窗口（>6h）→ 转终态 skipped-expired:too-old，不补发也不假装还在等', async () => {
  const home = tempHome('qq-b7b-')
  const r = rig(home.dir)
  try {
    await r.store.load()
    const fresh = await seed(r.store, 2, Date.now() - 60_000) // 窗口内
    const stale = await seed(r.store, 3, Date.now() - 30 * HOUR) // 30 小时前：窗口外
    assert.deepEqual(r.store.due().map((item) => item.id).sort(), [...fresh].sort(), '窗口外的不能出现在 due 里')
    await r.tick()
    assert.equal(r.platform.count(), 2, '只补窗口内的两条')
    const after = readAll(r.file)
    for (const id of stale) {
      const item = after.find((entry) => entry.id === id)
      assert.equal(item?.fired, true, '窗口外的要收成终态（fired）')
      assert.equal(item?.expiredReason, 'skipped-expired:too-old', `原因要写清：${String(item?.expiredReason)}`)
      assert.equal(typeof item?.expiredAt, 'number', '要留时间戳（不是静默丢弃）')
    }
    assert.ok(r.logs.some((line) => line.includes('超出补发窗口')), `日志要说明：${r.logs.join(' | ')}`)
    // 再跑一拍：这 3 条不会被补发。
    const before = r.platform.count()
    await r.tick()
    assert.equal(r.platform.count(), before, '终态之后不再补发')
  } finally {
    await r.close()
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})

test('B7-3 积压超过总量上限（20）→ 恰好 20 条进入补发、其余转 backlog-overflow，且丢的是最老的', async () => {
  const home = tempHome('qq-b7c-')
  const r = rig(home.dir)
  try {
    await r.store.load()
    // 30 条都在窗口内（1 分钟 ~ 30 分钟前），但超过总量上限 20。
    // 故意让"最老的"与"最新的"可区分：at 越小越老。
    const ids: Array<{ id: string; at: number }> = []
    for (let index = 0; index < 30; index += 1) {
      const at = Date.now() - 60_000 - index * 60_000
      const item = expectOk(await r.store.add({
        text: `积压 ${String(index)}`,
        at,
        room: 'dm',
        target: OWNER,
        createdBy: OWNER,
        repeat: 'none',
        occurrence: { id: `occ-b-${String(index)}`, revision: 1 },
      }))
      ids.push({ id: item.id, at })
    }
    assert.equal(r.store.due().length, 30, '前置：30 条都在窗口内且 due')

    await r.tick() // 这一拍就做总量闸 + 取前 3 条

    const after = readAll(r.file)
    const overflow = after.filter((item) => item.expiredReason === 'skipped-expired:backlog-overflow')
    assert.equal(overflow.length, 10, `恰好丢 10 条（实际 ${String(overflow.length)}）`)
    // 丢弃的是**最老**的：at 最小的那 10 条。
    const oldestTen = [...ids].sort((a, b) => a.at - b.at).slice(0, 10).map((entry) => entry.id)
    assert.deepEqual(overflow.map((item) => item.id).sort(), oldestTen.sort(), '丢的必须是最老的 10 条')
    // 剩下的 20 条仍在队列里（3 条已发、17 条待发）。
    const stillDue = r.store.due()
    assert.equal(stillDue.length, 17, `20 - 3 = 17 条待发（实际 ${String(stillDue.length)}）`)
    assert.equal(r.platform.count(), MAX_CATCH_UP_PER_TICK, '本拍按每拍上限发 3 条')
    // 日志与后台计数都要能看到"因积压丢弃"。
    assert.ok(r.logs.some((line) => line.includes('因积压丢弃 10 条')), `日志要写清丢弃条数：${r.logs.join(' | ')}`)
    const metrics = r.store.catchUpDiagnostics()
    assert.equal(metrics.dropped, 10, '后台计数 dropped=10')
    assert.equal(metrics.backlog, 17, '后台计数 backlog=17')
    assert.equal(metrics.maxTotal, 20)
    // 排空后总量也不超过 20（不会因为继续攒而反复触发）。
    for (let i = 0; i < 10 && r.store.due().length > 0; i += 1) await r.tick()
    assert.equal(r.platform.count(), 20, '最终只补发 20 条（不多不少）')
    assert.equal(r.store.catchUpDiagnostics().backlog, 0)
  } finally {
    await r.close()
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})

test('B7-4 丢弃清单可读：`droppedItems` 有 时间+截断文本+原因，`droppedLast24h`/`lastDroppedAt` 回答"现在还在丢吗"', async () => {
  const home = tempHome('qq-b7d-')
  const r = rig(home.dir)
  try {
    await r.store.load()
    // 25 条窗口内（超过上限 20 ⇒ 丢 5 条），其中**最老的**那条文本超长，验证截断。
    const long = '这是一条特别特别长的提醒文本，用来验证后台清单里会被截断，不会把整页撑坏，也足够辨认这是哪一条'
    for (let index = 0; index < 25; index += 1) {
      expectOk(await r.store.add({
        text: index === 24 ? long : `清单 ${String(index)}`,
        at: Date.now() - 60_000 - index * 60_000,
        room: 'dm',
        target: OWNER,
        createdBy: OWNER,
        repeat: 'none',
        occurrence: { id: `occ-l-${String(index)}`, revision: 1 },
      }))
    }
    await r.tick()

    const metrics = r.store.catchUpDiagnostics()
    assert.equal(metrics.dropped, 5, '丢 5 条')
    assert.equal(metrics.droppedLast24h, 5, '刚丢的 ⇒ 最近 24 小时也是 5')
    assert.equal(typeof metrics.lastDroppedAt, 'number', '要有最后一次丢弃时刻')
    assert.equal(metrics.droppedItems.length, 5, '清单要有 5 条')
    // 清单按**到点时刻升序**（像一句话读下来）。
    const times = metrics.droppedItems.map((item) => item.at)
    assert.deepEqual(times, [...times].sort((a, b) => a - b), '清单按到点时刻升序')
    // 每条都有时间 + 截断文本 + 原因。
    for (const item of metrics.droppedItems) {
      assert.equal(typeof item.at, 'number')
      assert.equal(item.reason, 'skipped-expired:backlog-overflow')
      assert.ok(item.text.length > 0)
      assert.ok(item.text.length <= 41, `文本要截断到 40 字（实际 ${String(item.text.length)}）`)
    }
    // 最老那条（文本最长的）在清单里且被截断。
    const oldest = metrics.droppedItems[0]!
    assert.ok(oldest.text.endsWith('…'), '超长文本必须以省略号结尾')
    // 日志打前 5 条明细（时间 + 文本）。
    const detail = r.logs.filter((line) => line.includes('丢弃明细'))
    assert.ok(detail.length >= 1 && detail.length <= 5, `日志明细 1..5 条（实际 ${String(detail.length)}）`)
    assert.ok(detail.some((line) => line.includes('清单 24') || line.includes('这是一条特别')), `明细要含文本：${detail.join(' | ')}`)

    // 24 小时窗口的反面：把丢弃时刻改到 2 天前 ⇒ dropped 仍 5，但 droppedLast24h 归 0。
    const file = r.file
    const rows = readAll(file).map((item) => item.expiredReason === 'skipped-expired:backlog-overflow'
      ? { ...item, expiredAt: Date.now() - 48 * HOUR }
      : item)
    fs.writeFileSync(file, JSON.stringify({ version: 1, reminders: rows }, null, 2), 'utf8')
    // **`load()` 幂等**（设计 §7）：第二次调用不重读盘，所以"再 load 一次当刷新"不成立。
    // 要读到盘上的新内容只能**关旧建新**（同一文件只允许一个活跃 Store）。
    await r.store.close()
    const reopened = new ReminderStore(
      // ase 只存在于 rig 内部 ⇒ 这里现场取，免得多一个跨作用域变量。
      { ...(baseConfig({ admins: [OWNER] }) as unknown as QQChannelConfig).reminders, dryRun: false, file: null },
      { workspacePath: home.dir, dshHome: home.dir, log: () => {} },
    )
    await reopened.load()
    const older = reopened.catchUpDiagnostics()
    assert.equal(older.dropped, 5, '累计仍是 5')
    assert.equal(older.droppedLast24h, 0, '超过 24 小时的**不算**"现在还在丢"——这正是本指标要能区分的')
    await reopened.close()
  } finally {
    await r.close()
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})

// ── B8：markSent 返回 false 不许当成功 ─────────────────────────────────────

test('B8 markSent 落盘失败 → 结论不是 sent、不写 dispatched（按 unknown 处理，不重发）', async () => {
  const home = tempHome('qq-b8-')
  const r = rig(home.dir, { markSentFails: true })
  try {
    await r.store.load()
    await seed(r.store, 1, Date.now() - 60_000)
    await r.tick()
    assert.equal(r.platform.count(), 1, '平台确实发出去了（这一步没错）')
    assert.deepEqual(r.dispatched, [], '落盘失败时**不许**继续写 dispatched')
    const item = readAll(r.file)[0]
    assert.equal(item?.fired, true, '不走 sent 路径 ⇒ 由 runner 按 unknown 收尾（fired=true、留证据）')
    assert.ok(r.logs.some((line) => line.includes('没写进盘')), `日志要说明：${r.logs.join(' | ')}`)
    // 再跑一拍不许重发（unknown 是终态）。
    const before = r.platform.count()
    await r.tick()
    assert.equal(r.platform.count(), before, 'unknown 之后不重发')
  } finally {
    await r.close()
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})

// ── C4：agenda 惰性解析（启动没有 → 之后出现 → 下次使用能接上） ─────────────

test('C4 agenda 惰性解析：启动时没有 → 之后发布 → 下一次用到就接上（不用重启）', async () => {
  try {
    // ① 启动时解析不到。
    configureAgendaResolver(() => null)
    configureAgendaPort(null)
    assert.equal(agendaPortOf(), null, '启动时确实没有')

    // ② foundation 之后才发布。
    const seen: string[] = []
    const published: AgendaPort = {
      casOccurrence: async (input) => { seen.push(`cas:${input.occurrenceId}`); return { ok: true } },
      markOccurrenceDispatched: async (input) => { seen.push(`dispatch:${input.occurrenceId}`); return { ok: true } },
    }
    let available: AgendaPort | null = null
    configureAgendaResolver(() => available)
    assert.equal(agendaPortOf(), null, '还没发布时仍然是 null')
    available = published

    // ③ 惰性接缝：**同一个 seams 对象**，下一次调用就接上了。
    const live = liveSeams(() => {})
    const cas = await live.casOccurrence?.('occ-late', 1)
    assert.deepEqual(cas, { ok: true }, '下一次使用就能 CAS（不用重启、不用重新装配）')
    const dispatch = await live.dispatchNow?.('occ-late', 1, Date.now())
    assert.deepEqual(dispatch, { ok: true })
    assert.deepEqual(seen, ['cas:occ-late', 'dispatch:occ-late'], '真的调到了后发布的那个服务')

    // ④ 对照：旧的 `seamsOf(null)` 是"固定为空"——这正是 C4 说的接不回。
    const fixed = seamsOf(null, () => {})
    assert.equal(fixed.casOccurrence, undefined, '老写法在启动没探到时就是空的（不会自己接回）')

    // ⑤ 解析器抛错不炸调用方。**round8 改判**：抛错现在算 `failed`（"问不出真相"），
    //    按 round8 的规矩**立刻停用缓存端口**（否则已绑定 occurrence 的提醒会绕过 CAS）；
    //    真正要保住的性质是"**不会被永久钉死**"：下一次探测成功就接回来。
    configureAgendaResolver(() => { throw new Error('ctx gone') })
    assert.equal(agendaPortOf(), null, 'round8：探测抛错 ⇒ failed ⇒ 立刻停用缓存端口（CAS 不放行）')
    configureAgendaResolver(() => ({ casOccurrence: async () => ({ ok: true }) }))
    assert.notEqual(agendaPortOf(), null, 'failure 之后只要探测恢复，必须能接回来（不许被钉死）')
    // 而"偶发一次返回 null（absent）"仍然**容忍**（瞬时抖动不该丢端口，task-59 P2 的口径没变）。
    configureAgendaResolver(() => ({ casOccurrence: async () => ({ ok: true }) }))
    assert.notEqual(agendaPortOf(), null, '重新缓存')
    configureAgendaResolver(() => null)
    assert.notEqual(agendaPortOf(), null, '一次 absent 不该丢掉已接上的端口')
  } finally {
    configureAgendaPort(null)
    configureAgendaResolver(null)
  }
})

test('C4-2 没有 agenda 的部署：不当成"写失败"——不留待办、不白补 10 拍、日志说"不假装写过"', async () => {
  const home = tempHome('qq-c4b-')
  // 装配里**只有** liveSeams + 没有 agenda（模拟"惰性解析器一直解析不到"）。
  const logs: string[] = []
  const base = baseConfig({ admins: [OWNER] }) as unknown as QQChannelConfig
  const config = { ...base, reminders: { enabled: true, dryRun: false, file: null } } as QQChannelConfig
  const dir = home.dir
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
  try {
    configureAgendaPort(null)
    configureAgendaResolver(() => null)
    // **C4-2 的真正形态**：完全没有 agenda 接缝 ⇒ `index.ts` 的
    // `seams.casOccurrence === undefined` 短路 ⇒ 照常发 + 日志「不假装写过」（不留待办）。
    // 这与 `liveSeams(...)` + `absent`（有接缝但服务不在 ⇒ 不放行）是两种不同部署形态。
    configureReminderSeams({})
    await store.load()
    await seed(store, 1, Date.now() - 60_000)
    const runner = new ReminderRunner(
      store,
      (reminder) => deliverReminder(host, reminder),
      (line) => { logs.push(line) },
      () => true,
      async () => null,
      async (reminder) => {
        const pending = reminder.pendingDispatch ?? null
        if (pending === null) return 'fail' as const
        const verdict = await liveSeams(() => {}).dispatchNow?.(pending.occurrenceId, pending.revision, pending.at)
        return verdict?.code === 'agenda-absent' ? 'absent' as const : verdict?.ok === true ? 'ok' as const : 'fail' as const
      },
    )
    await (runner as unknown as { tick(): Promise<void> }).tick()
    assert.equal(platform.count(), 1, '没有 agenda 也照常发提醒（提醒不依赖 agenda）')
    assert.equal(store.pendingDispatches().length, 0, '**不许**留下待办（没有 agenda ≠ 写失败）')
    assert.ok(logs.some((line) => line.includes('不假装写过')), `日志要说清：${logs.join(' | ')}`)
    // 再跑几拍：不该出现"仍未补上"或"转终态"这种白跑的痕迹。
    for (let i = 0; i < 3; i += 1) await (runner as unknown as { tick(): Promise<void> }).tick()
    assert.equal(store.dispatchDiagnostics().overLimit, 0, '没有 agenda 不该污染 overLimit')
    assert.equal(logs.filter((line) => line.includes('仍未补上')).length, 0, '不该白补次数')
  } finally {
    configureReminderSeams({})
    configureAgendaPort(null)
    configureAgendaResolver(null)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ── D2：pruneFired 不许删掉还有待补 dispatched 的行 ────────────────────────

test('D2 清理老的一次性提醒时，跳过仍有待补 dispatched 的行（事件不会被永久丢掉）', async () => {
  const home = tempHome('qq-d2-')
  const r = rig(home.dir, { dispatched: 'reject' })
  try {
    await r.store.load()
    await seed(r.store, 1, Date.now() - 60_000)
    await r.tick() // 发出去、事件没写成 → 待办 1 条
    assert.equal(r.store.pendingDispatches().length, 1, '前置：有待补事件')
    // 把这条推到"7 天前就 fired"的状态，然后再清理。
    const item = readAll(r.file)[0]!
    const old = { ...item, fired: true, firedAt: Date.now() - 8 * 24 * HOUR }
    fs.writeFileSync(r.file, JSON.stringify({ version: 1, reminders: [old] }, null, 2), 'utf8')
    await r.store.load()
    const removed = expectOk(await r.store.pruneFired(Date.now(), 7 * 24 * HOUR))
    assert.equal(removed.length, 0, '有待补事件的行不许删')
    assert.equal(readAll(r.file).length, 1, '行还在')
    assert.equal(r.store.pendingDispatches().length, 1, '待办还在')

    // 待办补上之后，同样的行就可以被清掉了（不是永远不删）。
    // A 类：同一文件只允许一个活跃 Store ⇒ 建第二个 rig 前先关旧的（rig 自己会 load）。
    await r.close()
    const clean = rig(home.dir, { dispatched: 'ok' })
    try {
      await clean.store.load()
      await clean.tick()
      assert.equal(clean.store.pendingDispatches().length, 0, '补上之后待办清空')
      const gone = expectOk(await clean.store.pruneFired(Date.now(), 7 * 24 * HOUR))
      assert.equal(gone.length, 1, '没有待办了就该能清掉')
    } finally {
      await clean.close()
    }
  } finally {
    await r.close()
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})
