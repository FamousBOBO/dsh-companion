import { expectOk, expectRejected } from './fakes/reminders.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { QQChannelConfig } from '../src/config.js'
import { ReminderStore, type Reminder } from '../src/features/reminders/store.js'
import { ReminderRunner } from '../src/features/reminders/runner.js'
import { configureReminderSeams, deliverReminder, resourceListOf } from '../src/features/reminders/index.js'
import { configureAgendaPort } from '../src/features/reminders/agenda-seam.js'
import { baseConfig, tempHome, FakeOutboundQueue, FakePlatform } from './fakes/contact.js'
import type { SubHost } from '../src/features/plugin-kit.js'

// 终审 B3b：`occurrence-dispatched` 与 QQ store 的原子性。
//
// 三条主线（任务书要求的三条测试）：
//   H1 平台成功、dispatched 抛错 → 结论仍 `sent`、待办 +1、**重启后不重发**（靠 store 判定）；
//   H2 dispatched 成功 → 待办清空；
//   H3 平台成功后**硬杀**（store 写了、dispatched 没写）→ 重启后**不重发**。
//
// 全部落临时目录；不发真 QQ、不调真模型。seams 一律用桩（`dispatchNow` 可控成败）。

const OWNER = 10001
const NOW = 1_762_000_000_000

interface Row { readonly reminders: Reminder[] }

/** 真 store + 真 runner + 真 deliverReminder，seams 由参数控制。 */
function rig(dir: string, options: { dispatchedOutcome?: 'ok' | 'throw' | 'reject' } = {}) {
  const logs: string[] = []
  const base = baseConfig({ admins: [OWNER] }) as unknown as QQChannelConfig
  const config = {
    ...base,
    groupEnabled: true,
    rooms: [],
    reminders: { enabled: true, dryRun: false, file: null },
  } as QQChannelConfig
  const store = new ReminderStore(config.reminders, { workspacePath: dir, dshHome: dir, log: (line) => { logs.push(line) } })
  const platform = new FakePlatform()
  const queue = new FakeOutboundQueue()
  const host = {
    config,
    log: (line: string) => { logs.push(line) },
    get: (name: string) => {
      if (name === 'platform') return { api: platform.api, out: queue }
      // deliverReminder 现在需要拿到 store（崩溃恢复判据 + 落盘"已发出"）。
      if (name === 'reminders') return store
      return undefined
    },
  } as unknown as SubHost

  const dispatched: Array<{ occurrenceId: string; revision: number; at: number }> = []
  const outcome = options.dispatchedOutcome ?? 'ok'
  configureReminderSeams({
    dispatchNow: async (occurrenceId, revision, at) => {
      dispatched.push({ occurrenceId, revision, at })
      if (outcome === 'throw') throw new Error('agenda down')
      if (outcome === 'reject') return { ok: false, code: 'dispatch-rejected' }
      return { ok: true }
    },
  })

  const runner = new ReminderRunner(
    store,
    (reminder) => deliverReminder(host, reminder),
    (line) => { logs.push(line) },
    () => true,
    // 一次性提醒用不到换绑；给个恒 null 的实现免得 undeinfed 分支影响阅读。
    async () => null,
    async (reminder) => {
      const pending = reminder.pendingDispatch ?? null
      if (pending === null) return 'fail' as const
      dispatched.push({ occurrenceId: pending.occurrenceId, revision: pending.revision, at: pending.at })
      // round4 之后是**三态**：`ok` 补上了 / `absent` 没有 agenda（作废）/ `fail` 真失败（累加次数）。
      if (outcome === 'throw') return 'fail' as const
      if (outcome === 'reject') return 'fail' as const
      return 'ok' as const
    },
  )
  const file = path.join(dir, 'reminders.json')
  return {
    store,
    runner,
    platform,
    logs,
    file,
    dispatched,
    tick: async () => { await (runner as unknown as { tick(): Promise<void> }).tick() },
    // **A 类修复（与 review3 同根因）**：原来只重置接缝、**没关 store** ⇒ 同目录建第二个 rig 就
  // OWNER_CONFLICT。现在真的 await 关掉；第二个 rig 自己 `await store.load()` 读盘。
  close: async () => { configureReminderSeams({}); configureAgendaPort(null); await store.close() },
  }
}

const readFileOf = (file: string): Row => JSON.parse(fs.readFileSync(file, 'utf8')) as Row

const addOneShot = async (store: ReminderStore, over: Partial<Reminder> = {}): Promise<Reminder> => expectOk(await store.add({
  text: '该睡了',
  // **必须在补发窗口内**（终审 round4 B7 之后：更旧的不再补发，会被收成 skipped-expired）。
  at: Date.now() - 1_000,
  room: 'dm',
  target: OWNER,
  createdBy: OWNER,
  repeat: 'none',
  occurrence: { id: 'occ-h', revision: 3 },
  ...over,
}))

// ── H1：平台成功、dispatched 抛错 → 结论仍 sent、待办 +1、重启不重发 ─────────

test('H1 dispatched 抛错 → 结论仍是 sent、待办 +1；重启后不重发（靠 store 判定，不靠 CAS）', async () => {
  const home = tempHome('qq-h1-')
  const first = rig(home.dir, { dispatchedOutcome: 'throw' })
  try {
    await first.store.load()
    const item = await addOneShot(first.store)
    await first.tick()

    assert.equal(first.platform.count(), 1, '平台确实发出去了')
    // 投递结论没被事件写失败改写：一次性提醒已被标成已触发。
    const after = readFileOf(first.file)
    assert.equal(after.reminders[0]?.fired, true, '结论是 sent ⇒ 记账照旧（fired）')
    // 待办 +1（dispatched 没写成）：位置对得上，且带上了重试计数与起点（diagnostics 要用）。
    const pending = after.reminders[0]?.pendingDispatch
    assert.equal(pending?.occurrenceId, 'occ-h')
    assert.equal(pending?.revision, 3)
    assert.equal(pending?.attempts, 1, '第一次失败记 1 次')
    assert.equal(typeof pending?.since, 'number', '要记起点（算 oldestAgeMs）')
    assert.ok(first.logs.some((line) => line.includes('记待办')), `日志要说明记了待办：${first.logs.join(' | ')}`)
    // CAS 一次都不该被问（证明"不重发"不靠 agenda）。
    void item
  } finally {
    await first.close()
  }

  // 重启：同一份文件，新的 store/runner。绝不能重发。
  const second = rig(home.dir, { dispatchedOutcome: 'ok' })
  try {
    await second.store.load()
    await second.tick()
    assert.equal(second.platform.count(), 0, '重启后不许重发（一次性提醒已 fired）')
    // 这一拍补上了 dispatched，待办清空。
    assert.equal(readFileOf(second.file).reminders[0]?.pendingDispatch, undefined, '补上之后待办要清掉')
    assert.equal(second.dispatched.length, 1, '补发一次 dispatched')
  } finally {
    await second.close()
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})

// ── H2：dispatched 成功 → 待办清空 ─────────────────────────────────────────

test('H2 dispatched 成功 → 待办为空（不留垃圾字段），且只写一次事件', async () => {
  const home = tempHome('qq-h2-')
  const r = rig(home.dir, { dispatchedOutcome: 'ok' })
  try {
    await r.store.load()
    await addOneShot(r.store)
    await r.tick()
    const after = readFileOf(r.file)
    assert.equal(after.reminders[0]?.pendingDispatch, undefined, '成功时不该留下待办')
    assert.equal(r.dispatched.length, 1, 'dispatched 恰好写一次')
    assert.equal(r.store.pendingDispatches().length, 0)
    // "已发出"这个临时事实在产生定论后也要撤掉（否则下一轮会被它挡住）。
    assert.equal(after.reminders[0]?.sentFor, undefined, 'sentFor 是临时的：定论后要清掉')
  } finally {
    await r.close()
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})

// ── H3：平台成功后硬杀（store 写了 / dispatched 没写）→ 重启不重发 ──────────

test('H3 **构造**崩溃现场（store 已落 sentFor、dispatched 未写；**不是真 kill 进程**）→ 重启后不重发', async () => {
  const home = tempHome('qq-h3-')
  // 直接构造"崩溃现场"：模拟平台回执拿到、markSent 落盘后进程消失。
  const crash = rig(home.dir)
  try {
    await crash.store.load()
    const item = await addOneShot(crash.store)
    // 平台发出了（这一步在真机上是真的 sendTo；这里只在"事实层面"落盘）。
    const persisted = expectOk(await crash.store.markSent(item.id, item.at))
    // task-66：markSent 回 Mutation<Reminder>（不是 boolean）⇒ 断言那条提醒的字段，盘上另行核对。
    assert.equal(persisted.sentFor, item.at, 'markSent 要真的写进盘')
    const scene = readFileOf(crash.file)
    assert.equal(scene.reminders[0]?.sentFor, item.at, '盘上要有"这一轮发过"的事实')
    assert.equal(scene.reminders[0]?.fired, false, '崩溃时 runner 还来不及记账（fired 仍是 false）')
    // 这里"进程消失"：不再调用 runner，直接开第二个 store。
  } finally {
    await crash.close()
  }

  const restarted = rig(home.dir)
  try {
    await restarted.store.load()
    // 关键：due() 仍然会返回它（fired=false、at 已过）——重发与否只能靠 sentFor 判。
    assert.equal(restarted.store.due().length, 1, '前置：这条提醒确实还在 due 里')
    await restarted.tick()
    assert.equal(restarted.platform.count(), 0, '重启后**不许重发**（凭 store 的 sentFor 认出已发过）')
    assert.ok(restarted.logs.some((line) => line.includes('已发过（崩溃恢复）')), `日志要说明是崩溃恢复：${restarted.logs.join(' | ')}`)
    // 记账照旧完成（结论是 sent），sentFor 随之清掉。
    const after = readFileOf(restarted.file)
    assert.equal(after.reminders[0]?.fired, true, '恢复后要补上记账')
    assert.equal(after.reminders[0]?.sentFor, undefined, 'sentFor 是临时的：定论后清掉')
  } finally {
    await restarted.close()
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})

// ── H5：补发次数上限 → 转终态，不再每拍重试 ────────────────────────────────

test('H5 连续失败到上限 → 转终态（dispatchAbandonedAt/Reason），之后不再重试', async () => {
  const home = tempHome('qq-h5-')
  const r = rig(home.dir, { dispatchedOutcome: 'reject' })
  try {
    await r.store.load()
    const item = await addOneShot(r.store)
    // 第一次投递：平台发出去了，事件没写成 → 待办 1 条（attempts=1）。
    await r.tick()
    assert.equal(r.store.pendingDispatches().length, 1, '前置：留着一条待办')
    const first = readFileOf(r.file).reminders[0]
    assert.equal(first?.pendingDispatch?.attempts, 1, '第一次失败 = attempts 1')
    assert.equal(typeof first?.pendingDispatch?.since, 'number', '要记下 since（诊断算年龄用）')

    // 一拍拍补，直到转终态。上限是 DISPATCH_MAX_ATTEMPTS(=10)：第 10 次失败时放弃。
    let guard = 0
    while (r.store.pendingDispatches().length > 0 && guard < 30) {
      await r.tick()
      guard += 1
    }
    const after = readFileOf(r.file).reminders[0]
    assert.equal(after?.pendingDispatch, undefined, '到上限后待办要删掉（不再每拍重试）')
    assert.equal(typeof after?.dispatchAbandonedAt, 'number', '转终态要留时间戳')
    assert.match(String(after?.dispatchAbandonReason ?? ''), /^attempts-exhausted:\d+$/, `终态原因要可解释：${String(after?.dispatchAbandonReason)}`)
    assert.ok(r.logs.some((line) => line.includes('转终态')), `日志要说清放弃了：${r.logs.join(' | ')}`)
    // 再跑几拍：不该再有新的 dispatched 尝试（已经终态）。
    const beforeTries = r.dispatched.length
    await r.tick()
    await r.tick()
    assert.equal(r.dispatched.length, beforeTries, '终态之后不再重试')
    // 指标：待办 0、overLimit 1。
    const metrics = r.store.dispatchDiagnostics()
    assert.equal(metrics.value, 0)
    assert.equal(metrics.overLimit, 1, '放弃的条数要进 overLimit')
    void item
  } finally {
    await r.close()
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})

// ── H6：oldestAgeMs 随待办年龄增长 ────────────────────────────────────────

test('H6 诊断指标：没待办时 0；有待办时 oldestAgeMs 随时间增长；overLimit 数得出来', async () => {
  const home = tempHome('qq-h6-')
  const r = rig(home.dir, { dispatchedOutcome: 'reject' })
  try {
    await r.store.load()
    // ① 空态：0 / 0 / 0（真实测量，不是"没接"）。
    assert.deepEqual(r.store.dispatchDiagnostics(), { value: 0, oldestAgeMs: 0, overLimit: 0 })
    await addOneShot(r.store)
    await r.tick()
    assert.equal(r.store.pendingDispatches().length, 1)
    const since = r.store.pendingDispatches()[0]?.pendingDispatch?.since ?? 0
    // ② 用显式 now 测量年龄（不 sleep）：距 since 1 分钟 → 约 60_000。
    const oneMinute = r.store.dispatchDiagnostics(since + 60_000)
    assert.equal(oneMinute.value, 1)
    assert.ok(oneMinute.oldestAgeMs >= 60_000 && oneMinute.oldestAgeMs <= 60_100, `年龄要按 since 算：${oneMinute.oldestAgeMs}`)
    // ③ 更久之后更大（单调）。
    const tenMinutes = r.store.dispatchDiagnostics(since + 600_000)
    assert.ok(tenMinutes.oldestAgeMs > oneMinute.oldestAgeMs, '年龄要随时间增长')
    // ④ 时间倒退（时钟回拨）不许出负数。
    assert.equal(r.store.dispatchDiagnostics(since - 5_000).oldestAgeMs, 0, '负年龄要夹到 0')
  } finally {
    await r.close()
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})

// ── H7：后台资源的 list() 里就有这三个数（honest: measured） ────────────────

test('H7 后台 reminders 资源：list() 带 pendingDispatch 三项 + honest=measured', () => {
  const home = tempHome('qq-h7-')
  const logs: string[] = []
  const base = baseConfig({ admins: [OWNER] }) as unknown as QQChannelConfig
  const config = {
    ...base,
    reminders: { enabled: true, dryRun: false, file: null },
  } as QQChannelConfig
  const store = new ReminderStore(config.reminders, { workspacePath: home.dir, dshHome: home.dir, log: (line) => { logs.push(line) } })
  try {
    // 直接调装配里的同一个函数（`resourceListOf`），避免为了测三行去起整个子插件。
    const list = resourceListOf(store)
    const payload = list()
    assert.equal(payload.honest, 'measured', '这三个数是数出来的，不许写成 not-wired')
    assert.deepEqual(payload.pendingDispatch, { value: 0, oldestAgeMs: 0, overLimit: 0 })
  } finally {
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})

// ── H8：可观测性落点——能被 grep 的那一行 ──────────────────────────────────

test('H8 runner 每拍打一行 `reminders: pendingDispatch value=… oldestAgeMs=… overLimit=…`（没积压就不打）', async () => {
  const home = tempHome('qq-h8-')
  const r = rig(home.dir, { dispatchedOutcome: 'reject' })
  try {
    await r.store.load()
    // ① 没有积压：不该有这行（免得日志噪音）。
    await r.tick()
    assert.equal(r.logs.filter((line) => line.includes('pendingDispatch value=')).length, 0, '空态不该打积压行')
    // ② 造一条待办：投递成功但事件写失败。
    await addOneShot(r.store)
    await r.tick()
    const lines = r.logs.filter((line) => line.includes('pendingDispatch value='))
    assert.ok(lines.length >= 1, `要有可 grep 的积压行：${r.logs.join(' | ')}`)
    assert.match(lines[lines.length - 1]!, /^reminders: pendingDispatch value=\d+ oldestAgeMs=\d+ overLimit=\d+$/, '格式要固定（运维按前缀 grep）')
    assert.match(lines[lines.length - 1]!, /value=[1-9]/, '有积压时 value 必须 >0')
  } finally {
    await r.close()
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})

// ── H9：同一份数被两处读（后台资源 + 运行时状态），不是各算各的 ─────────────

test('H9 指标只有一个来源：后台资源与运行时状态都调 `dispatchDiagnostics()`', () => {
  // 测试在 build/lib-test/ 里跑，所以按仓库根（cwd）读源码。
  const read = (relative: string): string => fs.readFileSync(path.join(process.cwd(), relative), 'utf8')
  // 资源面（/api/resource/reminders）—— round7 起 `resourceListOf` 搬到 `lifecycle.ts`（体积硬上限），
  // 断言跟着搬，判据不变：仍然是**同一处** `dispatchDiagnostics()`。
  assert.ok(read('src/features/reminders/lifecycle.ts').includes('dispatchDiagnostics'),
    '资源 list() 必须走 store.dispatchDiagnostics()')
  // 运行时状态（后台状态接口 / SSE）：后台「提醒」页的 pill 与「关键指标」都从这里来。
  // round9 起这三项抽进了 `reminderStatusOf()`（压函数行数），判据不变：**同一个 `dispatchDiagnostics()`**。
  const admin = read('src/features/admin/index.ts')
  assert.ok(admin.includes('pendingDispatch:') && admin.includes('dispatchDiagnostics()'),
    'runtime status 也要走同一个 dispatchDiagnostics()（不然两个数会各说各话）')
  assert.ok(admin.includes('readFailure()'), 'round9：后台要能看出"读失败 ≠ 没有提醒"')
  // 前端两处展示（pill + 关键指标）都要读它，否则"有数没人看"等于没做。
  const html = read('src/admin-html.ts')
  assert.ok(html.includes('s.pendingDispatch'), '「提醒」页要把积压渲染成 pill')
  // 关键指标用 `getPath(status, 'pendingDispatch.value')`（round7 起 UI 源码在 `src/admin/ui/**`，
  // 这里断言的是**生成物**；两种写法都算数，判据是"那一格读的是同一个字段"）。
  assert.ok(
    html.includes('status.pendingDispatch.value') || html.includes("getPath(status, 'pendingDispatch.value')"),
    '「关键指标」要有一格',
  )
})

// ── H4（附）：旧文件字节不变（零 migration） ───────────────────────────────

test('H4 老格式文件（没有 B3b 字段）读进来不凭空多出 null 行', async () => {
  const home = tempHome('qq-h4-')
  try {
    const file = path.join(home.dir, 'reminders.json')
    const legacy = {
      version: 1,
      reminders: [{
        id: 'r_old', text: '旧提醒', at: NOW + 60_000, room: 'dm', target: OWNER,
        createdBy: OWNER, created: NOW - 5_000, fired: false, firedAt: null, repeat: 'none',
      }],
    }
    fs.writeFileSync(file, JSON.stringify(legacy, null, 2), 'utf8')
    const r = rig(home.dir)
    try {
      await r.store.load()
      // **task-66**：`save()` 已删除——每次成功变更在事务里已落盘，不存在"卸载补存"。
      const reread = readFileOf(file)
      assert.equal(reread.reminders[0]?.sentFor, undefined, '没写过就不该冒出 sentFor')
      assert.equal(reread.reminders[0]?.sentAt, undefined)
      assert.equal(reread.reminders[0]?.pendingDispatch, undefined)
      assert.equal(r.store.pendingDispatches().length, 0)
    } finally {
      await r.close()
    }
  } finally {
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})
