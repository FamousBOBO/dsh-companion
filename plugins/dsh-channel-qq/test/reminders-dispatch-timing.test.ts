/**
 * **到点投递的时间学**（2026-11-10 修复的验收测试）。
 *
 * 这份文件守的是事故本身：2026-11-09 23:40 的一条提醒，实际 00:22:10 才发出，迟到 42 分钟。
 * 复盘结论是**三段时间各自丢了一点**，所以这里按段钉住，而不是只测"最后发出去了":
 *
 *   1. **到期检测 / 唤醒精度**（`schedule.ts` + `wakeup.ts`）：以前是固定 `setInterval(30s)`，
 *      误差下界就是 30 秒 ⇒ 5 秒验收在结构上不可能。现在按 `scheduledAt` 定时，误差只剩
 *      "排程到真正取到 now()"的那几毫秒，用例要求 **≤ 5 秒**。
 *   2. **共享闸门**：以前到点提醒借的是主动消息的判据（免打扰/冷却/配额/退避），事故里就是
 *      被 23:21 一次普通回复留下的 `cooldown:room`（`perRoomCooldownMs` 1 小时）挡到 00:21:52。
 *      现在 `profile: 'reminder'` 只判通道与绑定——本文件用"真 contact 服务 + 一小时冷却"
 *      的现场验证它不再拦（见 T14）。
 *   3. **原子领取**：以前只有进程内一个 `running` 布尔量。本文件验证同一批到点被两个 runner
 *      扫到只发一次，并且**发之前盘上真的有认领**（那才是跨进程生效的证据）。
 *
 * 所有用例都跑在**假时钟 + 假 QQ 适配器**上：没有一条走真平台，收件人全是 `10001` 这类造数 id
 * （生产里的那个号在这个文件里一次都不出现）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

import { ReminderStore } from '../src/features/reminders/store.js'
import { ReminderRunner } from '../src/features/reminders/runner.js'
import { MIN_WAKEUP_MS, nextWakeupDelayMs, wakeupAtsOf } from '../src/features/reminders/schedule.js'
import { WakeupTimer } from '../src/features/reminders/wakeup.js'
import { formatDispatchLine } from '../src/features/reminders/dispatch.js'
import type { Reminder } from '../src/features/reminders/reminder-model.js'
import type { ReminderOutcome } from '../src/features/reminders/outcome.js'
import { FakeClock } from './fakes/contact.js'

/** 2026-11-09 23:40:00 Asia/Shanghai 的毫秒值（事故那条提醒的计划时刻）。 */
const T0 = Date.UTC(2026, 10, 9, 15, 40, 0)
/** 造数收件人：生产里那个号**不许**出现在测试里。 */
const OWNER = 10001
const GROUP = 1000000003

interface Sent { readonly id: string; readonly at: number; readonly text: string }

interface Rig {
  readonly clock: FakeClock
  readonly store: ReminderStore
  readonly runner: ReminderRunner
  readonly sends: Sent[]
  readonly logs: string[]
  readonly dir: string
  /** 每次真发之前盘上有没有认领（`true` = 跨进程也生效的证据）。 */
  readonly claimsSeen: boolean[]
  close(): Promise<void>
}

function scratch(): string { return mkdtempSync(path.join(tmpdir(), 'qq-rl-')) }

/** 造一条"还没响"的提醒（默认一次性、私聊）。 */
function row(over: Partial<Reminder> & { at: number }): Reminder {
  return {
    id: 'r-x', text: '该睡了', room: 'dm', target: OWNER, createdBy: OWNER,
    created: T0, fired: false, firedAt: null, repeat: 'none', ...over,
  }
}

/** 直接把条目写进提醒文件（模拟"停机期间就已经到期"的现场）。 */
function seed(dir: string, items: Reminder[]): string {
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'reminders.json')
  writeFileSync(file, `${JSON.stringify({ version: 1, reminders: items }, null, 2)}\n`, 'utf8')
  return file
}

const diskOf = (dir: string): Reminder[] => (JSON.parse(readFileSync(path.join(dir, 'reminders.json'), 'utf8')) as { reminders: Reminder[] }).reminders

async function makeRig(input: {
  readonly dir: string
  readonly now: number
  readonly outcome?: (r: Reminder) => Promise<ReminderOutcome>
  readonly dryRun?: boolean
}): Promise<Rig> {
  const clock = new FakeClock(input.now)
  const logs: string[] = []
  const store = new ReminderStore(
    { enabled: true, dryRun: input.dryRun === true, file: null } as never,
    { workspacePath: input.dir, dshHome: input.dir, log: (line) => { logs.push(line) } },
  )
  await store.load()
  const file = path.join(input.dir, 'reminders.json')
  const outcome = input.outcome ?? (async () => 'sent' as const)
  const sends: Sent[] = []
  const claimsSeen: boolean[] = []
  const runner = new ReminderRunner(
    store,
    async (reminder) => {
      // **发之前**看一眼盘：认领必须先落地，否则"多 worker 只发一次"只是口号。
      try {
        const disk = JSON.parse(readFileSync(file, 'utf8')) as { reminders: Reminder[] }
        claimsSeen.push(disk.reminders.some((r) => r.id === reminder.id && r.claim !== undefined && r.claim !== null))
      } catch { claimsSeen.push(false) }
      // 演练模式与生产同口径：`deliverReminder()` 自己判 dryRun 并回 `dry-run`，**不出网**。
      // 这个假适配器照着做，否则"演练"在测试里会变成真发（判据就假了）。
      if (input.dryRun === true) return 'dry-run' as const
      sends.push({ id: reminder.id, at: clock.now(), text: reminder.text })
      return await outcome(reminder)
    },
    (line) => { logs.push(line) },
    () => true,
    async () => null,
    async () => 'ok' as const,
    () => input.dryRun === true,
    clock,
  )
  return {
    clock, store, runner, sends, logs, claimsSeen, dir: input.dir,
    close: async () => { runner.dispose(); await store.close() },
  }
}

const realDelay = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

/**
 * 让"刚被叫醒的那一拍"真的跑完。
 *
 * 为什么不能用 `setImmediate` 轮次：这一拍要落盘两次（认领 + 记账），走的是**真实文件 I/O**
 * （临时目录 + Defender 扫描，单次 10–30ms）。`setImmediate` 只转检查阶段，几十轮也等不到
 * fs 的 promise 回来 —— 于是断言会在"其实还在写盘"时判红。这里用**真实**定时器等；
 * `WakeupTimer` 用的是注入的假时钟，两者互不干扰。
 */
async function pump(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await realDelay(8)
}

/**
 * 推进假时间并等每一拍落地。
 *
 * `stepMs` 是**步长**，不是"精度"：`FakeClock.advance()` 会把步长内所有到期定时器按时刻
 * 依次触发，所以按 `scheduledAt` 排的唤醒仍然精确到毫秒（T1 的迟到就是 0ms）。
 */
async function advance(rig: Rig, ms: number, stepMs = 1_000): Promise<void> {
  await pump()
  let left = ms
  while (left > 0) {
    const step = Math.min(stepMs, left)
    rig.clock.advance(step)
    await pump()
    left -= step
  }
  // 收尾：还有"已经到点却挂着的"排程（积压分批 / MIN_WAKEUP_MS）就继续推到没有为止。
  for (let i = 0; i < 200; i += 1) {
    if (!rig.clock.live().some((timer) => timer.at <= rig.clock.now())) return
    rig.clock.advance(0)
    await pump(1)
  }
}

// ── 1. 唤醒精度：迟到 ≤ 5 秒 ────────────────────────────────────────────────

test('T1 15 秒后到点的提醒：到点 5 秒内就发出（旧实现的下界是 30 秒轮询）', async () => {
  const dir = scratch()
  const rig = await makeRig({ dir, now: T0 })
  try {
    const at = T0 + 15_000
    assert.equal((await rig.store.add({ text: '喝水', at, room: 'dm', target: OWNER, createdBy: OWNER })).ok, true)
    rig.runner.start(30_000)
    await pump()
    // 排程依据是**盘上的 scheduledAt**，不是"上一拍 + 间隔"。
    assert.equal(rig.runner.status().scheduled, true)
    await advance(rig, 20_000)
    assert.equal(rig.sends.length, 1, `到点必须发一次（实际 ${String(rig.sends.length)}）`)
    const lateness = rig.sends[0]!.at - at
    assert.ok(lateness >= 0, `不许提前发（实际 ${String(lateness)}ms）`)
    assert.ok(lateness <= 5_000, `迟到必须 ≤ 5 秒，实际 ${String(lateness)}ms（旧实现这里是 0–30000）`)
    // 结构化日志里能读出同一件事（运维事后复盘只看日志）。
    const line = rig.logs.find((l) => l.includes('reminders: dispatch'))
    assert.ok(line !== undefined, `要有一行结构化 dispatch 日志：${rig.logs.join(' | ')}`)
    assert.match(line!, new RegExp(`reminderId=r_\\w+ scheduledAt=${String(at)} observedAt=\\d+`))
    assert.match(line!, /latenessMs=\d+ claimedAt=\d+ sendStartedAt=\d+ sendCompletedAt=\d+ attempt=1 outcome=sent/)
  } finally {
    await rig.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('T2 纯函数：下一次唤醒 = min(下一条 scheduledAt - now, 心跳)，且不许排成 0ms 死循环', () => {
  // 有未来提醒 ⇒ 正好在它到点时醒。
  assert.equal(nextWakeupDelayMs({ ats: [T0 + 15_000], now: T0, heartbeatMs: 30_000 }), 15_000)
  // 排在心跳之外 ⇒ 心跳先醒，那时再重算一次。
  assert.equal(nextWakeupDelayMs({ ats: [T0 + 90_000], now: T0, heartbeatMs: 30_000 }), 30_000)
  // 已经过去 ⇒ 立刻（但要有下界，不许 0）。
  assert.equal(nextWakeupDelayMs({ ats: [T0 - 1], now: T0, heartbeatMs: 30_000 }), MIN_WAKEUP_MS)
  // 没有提醒 ⇒ 心跳。
  assert.equal(nextWakeupDelayMs({ ats: [], now: T0, heartbeatMs: 30_000 }), 30_000)
  // 多条取最早；非有限值被忽略（盘上手改过的脏值不许把排程算成 NaN）。
  assert.equal(nextWakeupDelayMs({ ats: [Number.NaN, T0 + 4_000, T0 + 9_000], now: T0, heartbeatMs: 30_000 }), 4_000)
  // 已触发的、超出补发窗口的一次性提醒不参与（否则会为一个永远不会投递的时刻反复醒来）。
  assert.deepEqual(
    wakeupAtsOf([row({ id: 'a', at: T0, fired: true }), row({ id: 'b', at: T0 - 7 * 3_600_000 }), row({ id: 'c', at: T0 + 1_000 })],
      6 * 3_600_000, T0),
    [T0 + 1_000],
  )
})

test('T3 唤醒器：按排程延迟叫醒、跑完重排、dispose 之后一次都不再醒', async () => {
  const clock = new FakeClock(T0)
  const due = T0 + 12_000
  const ticks: number[] = []
  const timer = new WakeupTimer({
    clock,
    nextDelayMs: () => nextWakeupDelayMs({ ats: [due], now: clock.now(), heartbeatMs: 30_000 }),
    onTick: () => { ticks.push(clock.now()) },
    log: () => {},
  })
  timer.start()
  // `start()` 排的是"立刻跑第一拍"（0ms）。假时钟不会自己走，所以要显式推一下，
  // 让第一拍跑完、由它算出真正的下一次唤醒时刻。
  clock.advance(0)
  await pump()
  assert.equal(timer.state().delayMs, 12_000, '第一拍必须按 scheduledAt 排（不是心跳）')
  clock.advance(11_999)
  await pump(1)
  assert.deepEqual(ticks, [T0], '只跑过启动那一拍，还没到点')
  clock.advance(1)
  await pump()
  assert.deepEqual(ticks, [T0, T0 + 12_000], '到点那一刻醒')
  timer.dispose()
  const before = timer.state().ticks
  clock.advance(60_000)
  await pump(1)
  assert.equal(timer.state().ticks, before, 'dispose 之后不许再醒（否则卸载后还在发）')
  assert.equal(timer.state().armed, false)
})

// ── 2. 唯一性：多拍 / 多 runner 只发一次 ────────────────────────────────────

test('T4 同一批到点被两个 runner 扫到：只发一次，且发之前盘上有认领', async () => {
  const dir = scratch()
  seed(dir, [row({ id: 'r-once', at: T0 - 1_000 })])
  const rig = await makeRig({ dir, now: T0 })
  let sameStore = 0
  const second = new ReminderRunner(
    rig.store,
    async () => { sameStore += 1; return 'sent' as const },
    (line) => { rig.logs.push(line) },
    () => true, async () => null, async () => 'ok' as const, () => false, rig.clock,
  )
  try {
    rig.runner.start(30_000)
    second.start(30_000)
    await advance(rig, 2_000)
    const total = rig.sends.length + sameStore
    assert.equal(total, 1, `两个 runner 一共只能发一次（实际 ${String(total)}）`)
    // **跨进程证据**：真发的那一刻，盘上已经有这一条的认领。
    assert.equal(rig.claimsSeen[0], true, '发之前盘上必须有认领')
    const saved = diskOf(dir)[0]!
    assert.equal(saved.fired, true, '发完必须回写 fired')
    assert.equal(saved.claim, undefined, '一轮结束必须放掉认领（否则下一轮被自己挡住）')
  } finally {
    second.dispose()
    await rig.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('T5 认领过期（上一个进程发到一半崩了）⇒ 收敛成 unknown，**不重发**', async () => {
  const dir = scratch()
  seed(dir, [row({ id: 'r-stale', at: T0 - 60_000, claim: { by: 'pid-999#1', at: T0 - 60_000, until: T0 - 30_000 } })])
  const rig = await makeRig({ dir, now: T0 })
  try {
    rig.runner.start(30_000)
    await advance(rig, 2_000)
    assert.equal(rig.sends.length, 0, '结果未知就不许重发（重复外发是事故）')
    const saved = diskOf(dir)[0]!
    assert.equal(saved.unknownReason, 'claim-expired:unknown', `盘上要留痕迹：${JSON.stringify(saved)}`)
    assert.equal(saved.claim, undefined, '认领要清掉（留着只会让下一拍再演一遍）')
    assert.ok(rig.logs.some((l) => l.includes('已过期，结果未知')), rig.logs.join(' | '))
  } finally {
    await rig.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 3. 重启 / 停机补发 ──────────────────────────────────────────────────────

test('T6 到期前重启：新 runner 接着排程，仍然只发一次', async () => {
  const dir = scratch()
  const first = await makeRig({ dir, now: T0 })
  const at = T0 + 60_000
  const added = await first.store.add({ text: '关火', at, room: 'dm', target: OWNER, createdBy: OWNER })
  assert.equal(added.ok, true)
  first.runner.start(30_000)
  await pump()
  await advance(first, 20_000)
  assert.equal(first.sends.length, 0, '还没到点，重启前不该发')
  await first.close()   // 卸载：定时器撤掉、store 排空并释放

  const second = await makeRig({ dir, now: T0 + 20_000 })
  try {
    second.runner.start(30_000)
    await pump()
    await advance(second, 60_000)
    assert.equal(second.sends.length, 1, `重启后仍然只发一次（实际 ${String(second.sends.length)}）`)
    const lateness = second.sends[0]!.at - at
    assert.ok(lateness >= 0 && lateness <= 5_000, `迟到必须 ≤ 5 秒，实际 ${String(lateness)}ms`)
  } finally {
    await second.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('T7 停机期间到期（10 分钟前）：恢复后补发一次，并把迟到毫秒记进日志', async () => {
  const dir = scratch()
  const at = T0 - 10 * 60_000
  seed(dir, [row({ id: 'r-down', at })])
  const rig = await makeRig({ dir, now: T0 })
  try {
    rig.runner.start(30_000)
    await advance(rig, 2_000)
    assert.equal(rig.sends.length, 1, '停机期间到期的必须补发（不许静默丢掉）')
    const lateness = rig.sends[0]!.at - at
    assert.ok(lateness >= 10 * 60_000, `迟到要如实算出来，实际 ${String(lateness)}`)
    assert.ok(rig.logs.some((l) => l.includes(`latenessMs=${String(lateness)}`)), rig.logs.join(' | '))
    const dispatchLine = rig.logs.find((l) => l.includes('reminders: dispatch'))!
    assert.match(dispatchLine, new RegExp(`scheduledAt=${String(at)}`))
    assert.match(dispatchLine, /outcome=sent/)
    // 补发之后不许再来第二遍。
    await advance(rig, 5_000)
    assert.equal(rig.sends.length, 1, '补发只许一次')
  } finally {
    await rig.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 4. 失败 / 超时 / 未知三态 ───────────────────────────────────────────────

test('T8 发送抛错 / 回执未知 / 明确跳过：只有"跳过"允许下一拍再试', async () => {
  const dir = scratch()
  seed(dir, [
    row({ id: 'r-boom', at: T0 - 1_000 }),
    row({ id: 'r-unknown', at: T0 - 2_000 }),
    row({ id: 'r-skip', at: T0 - 3_000 }),
  ])
  const rig = await makeRig({
    dir,
    now: T0,
    outcome: async (reminder) => {
      if (reminder.id === 'r-boom') throw new Error('onebot: 连接已断开')
      return reminder.id === 'r-unknown' ? 'unknown' : 'skipped'
    },
  })
  try {
    rig.runner.start(30_000)
    await advance(rig, 2_000)
    const byId = new Map(diskOf(dir).map((r) => [r.id, r]))
    assert.equal(byId.get('r-boom')!.unknownReason, 'onebot: 连接已断开', '抛错 = 无法证明没发出去 ⇒ unknown，带原因')
    assert.equal(byId.get('r-unknown')!.unknownReason, 'unclassified', '认不出的回执 ⇒ unknown')
    assert.equal(byId.get('r-skip')!.unknownAt, undefined, 'skipped 是"现在不该发"，不是失败')
    assert.equal(byId.get('r-skip')!.fired, false, 'skipped 不许消耗这条提醒')
    assert.equal(byId.get('r-skip')!.claim, undefined, 'skipped 之后认领必须放回（否则下一拍发不出去）')
    await advance(rig, 60_000)
    assert.equal(rig.sends.filter((s) => s.id === 'r-boom').length, 1, 'unknown 不许自动重试（抛错那条）')
    assert.equal(rig.sends.filter((s) => s.id === 'r-unknown').length, 1, 'unknown 不许自动重试（回执未知那条）')
    assert.ok(rig.sends.filter((s) => s.id === 'r-skip').length >= 2, 'skipped 之后下一拍还要再试')
  } finally {
    await rig.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('T9 演练模式：一条都不外发，但**一行持久状态都不写**（认领也不落盘）', async () => {
  const dir = scratch()
  const file = seed(dir, [row({ id: 'r-dry', at: T0 - 1_000 })])
  const before = readFileSync(file, 'utf8')
  const rig = await makeRig({ dir, now: T0, dryRun: true })
  try {
    rig.runner.start(30_000)
    await advance(rig, 3_000)
    assert.equal(rig.sends.length, 0, '演练绝不出网')
    assert.equal(readFileSync(file, 'utf8'), before, '演练承诺"整条入口零写入"：盘上必须逐字节不变')
    assert.equal(diskOf(dir)[0]!.fired, false, '演练不消耗提醒')
  } finally {
    await rig.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 5. 多条目：不饿死、不超发 ───────────────────────────────────────────────

test('T10 十条同时到点：每一拍有上限，但一条都不许被饿死（也不许发两次）', async () => {
  const dir = scratch()
  const items = Array.from({ length: 10 }, (_v, i) => row({ id: `r-many-${String(i)}`, at: T0 - (10 - i) * 1_000 }))
  seed(dir, items)
  const rig = await makeRig({ dir, now: T0 })
  try {
    rig.runner.start(30_000)
    await advance(rig, 8_000)
    const counts = new Map<string, number>()
    for (const send of rig.sends) counts.set(send.id, (counts.get(send.id) ?? 0) + 1)
    assert.equal(counts.size, 10, `10 条都要发出去（实际 ${String(counts.size)} 条：${[...counts.keys()].join(',')}）`)
    for (const [id, count] of counts) assert.equal(count, 1, `${id} 发了 ${String(count)} 次（重复外发是事故）`)
    // 工整性：每拍上限 3 条 ⇒ 至少 4 拍，所以不是"一口气全喷出去"。
    assert.ok(rig.logs.some((l) => l.includes('按每拍上限')), '超上限要有日志，不许静默排队')
  } finally {
    await rig.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 6. 时间单位与时区 ───────────────────────────────────────────────────────

test('T11 秒/毫秒单位错了（`at` 给了秒）⇒ 收成"超出补发窗口"的终态，绝不当成未来', async () => {
  const dir = scratch()
  // 1794238800 秒 = 2026-11-09 23:40，但少了三个零：按毫秒解读就是 1970 年。
  seed(dir, [row({ id: 'r-sec', at: 1_794_238_800 })])
  const rig = await makeRig({ dir, now: T0 })
  try {
    rig.runner.start(30_000)
    await advance(rig, 2_000)
    assert.equal(rig.sends.length, 0, '差三个零的时刻绝不能被当成"到点了、发出去"')
    assert.equal(diskOf(dir)[0]!.expiredReason, 'skipped-expired:too-old', '要收成终态（可见），不许静默丢弃')
    assert.ok(rig.logs.some((l) => l.includes('skipped-expired:too-old')), rig.logs.join(' | '))
  } finally {
    await rig.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('T12 计划时刻就是盘上的绝对毫秒：23:40 Asia/Shanghai = 15:40Z，唤醒不经过机器时区', () => {
  // 这条守的是"时间解析不许用机器隐式时区"：投递侧只认 `scheduledAt`（绝对毫秒），
  // 时区只影响"人类怎么读它"，不影响"什么时候发"。
  assert.equal(new Date(T0).toISOString(), '2026-11-09T15:40:00.000Z')
  assert.equal(nextWakeupDelayMs({ ats: [T0], now: T0 - 15_000, heartbeatMs: 30_000 }), 15_000)
  // 迟到判定同样只看两个绝对毫秒之差（与 TZ 无关）。
  assert.equal(formatDispatchLine({
    reminderId: 'r-tz', scheduledAt: T0, observedAt: T0 + 2_530_430, latenessMs: 2_530_430,
    claimedAt: null, sendStartedAt: T0 + 2_530_500, sendCompletedAt: T0 + 2_530_600,
    attempt: 1, outcome: 'sent', reason: null,
  }), `reminders: dispatch reminderId=r-tz scheduledAt=${String(T0)} observedAt=${String(T0 + 2_530_430)}`
    + ' latenessMs=2530430 claimedAt=null'
    + ` sendStartedAt=${String(T0 + 2_530_500)} sendCompletedAt=${String(T0 + 2_530_600)} attempt=1 outcome=sent`)
})

// ── 7. 长跑 ─────────────────────────────────────────────────────────────────

test('T13 长跑：边跑边加 12 条，每条恰好一次，没有静默丢弃', async () => {
  const dir = scratch()
  const rig = await makeRig({ dir, now: T0 })
  const planned: string[] = []
  try {
    rig.runner.start(30_000)
    await pump()
    for (let i = 0; i < 12; i += 1) {
      const added = await rig.store.add({
        text: `第 ${String(i)} 条`, at: rig.clock.now() + 5_000, room: 'dm', target: OWNER, createdBy: OWNER,
      })
      assert.equal(added.ok, true, `第 ${String(i)} 条没建成功：${JSON.stringify(added)}`)
      if (added.ok) planned.push(added.value.id)
      await advance(rig, 12_000, 3_000)
    }
    await advance(rig, 60_000, 10_000)
    const counts = new Map<string, number>()
    for (const send of rig.sends) counts.set(send.id, (counts.get(send.id) ?? 0) + 1)
    for (const id of planned) assert.equal(counts.get(id), 1, `${id} 必须恰好发一次（实际 ${String(counts.get(id))}）`)
    assert.equal(counts.size, planned.length, `不许有额外外发：${[...counts.keys()].join(',')}`)
    // 盘上：全部 fired，且一个认领都不许留着。
    for (const item of diskOf(dir)) {
      assert.equal(item.fired, true, `${item.id} 应当已触发：${JSON.stringify(item)}`)
      assert.equal(item.claim, undefined, `${item.id} 的认领没放掉`)
      assert.equal(item.unknownAt, undefined, `${item.id} 不许进 unknown`)
    }
  } finally {
    await rig.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 9. 运行中新建的提醒也吃同一份精度 ───────────────────────────────────────

test('T15 定时器正等心跳时新建"15 秒后"的提醒：立刻重排，仍然 ≤ 5 秒', async () => {
  // 这条守的是 `nudge.ts` 的写入侧接线：定时器按"下一条 at"定，而新提醒出现在两次排程之间。
  // 现场取**最坏相位**：刚跑完一拍（下一个唤醒排在 30 秒心跳上）、此刻新建一条 15 秒后的提醒。
  // 不拍这一下 ⇒ 它会一直等到心跳那一拍（T0+30s）才被看见 ⇒ 迟到 15 秒，5 秒验收当场失效。
  const dir = scratch()
  const rig = await makeRig({ dir, now: T0 })
  try {
    // 先放一条"很久以后"的提醒，把心跳利用率钉满（定时器下一次一定排在 30 秒后）。
    assert.equal((await rig.store.add({
      text: '明天的事', at: T0 + 6 * 3_600_000, room: 'dm', target: OWNER, createdBy: OWNER,
    })).ok, true)
    rig.runner.start(30_000)
    await advance(rig, 1_000)
    assert.equal(rig.sends.length, 0)
    // 此刻正是"刚跑完一拍"的相位：紧接着新建一条 15 秒后的提醒。
    const now = rig.clock.now()
    const soon = now + 15_000
    const added = await rig.store.add({ text: '喝水', at: soon, room: 'dm', target: OWNER, createdBy: OWNER })
    assert.equal(added.ok, true, `新建失败：${JSON.stringify(added)}`)
    await advance(rig, 20_000)
    assert.equal(rig.sends.length, 1, `新提醒必须发一次（实际 ${String(rig.sends.length)}）`)
    const lateness = rig.sends[0]!.at - soon
    assert.ok(lateness >= 0 && lateness <= 5_000,
      `运行中新建的提醒也必须 ≤ 5 秒，实际 ${String(lateness)}ms（没接 nudge 时这里约 15000ms）`)
  } finally {
    await rig.close()
    rmSync(dir, { recursive: true, force: true })
  }
})


test('T14 事故重放：房间还在 contact 的一小时冷却里，23:40 的提醒照样准点发出', async () => {
  // 事故现场（真日志）：23:21:52 有一次主动投递成功 ⇒ `perRoomCooldownMs=3600000` 到 00:21:52；
  // 23:40 的提醒被 `cooldown:room` 拦住 84 拍，00:22:10 才发出（迟到 2530430ms）。
  // 这里就把那一刻摆出来：闸门必须回 `send`，提醒必须落在 scheduledAt 附近。
  const dir = scratch()
  const rig = await makeRig({ dir, now: T0 - 1_000 })
  try {
    const { evaluateOutboundBudget } = await import('../src/features/contact/gate.js')
    const { CONTACT_DEFAULTS } = await import('../src/config/sections/contact.js')
    const config = { ...CONTACT_DEFAULTS, perRoomCooldownMs: 3_600_000, quietHours: [] }
    const counters = {
      lastSentAt: T0 - 18 * 60_000, lastSentAtByRoom: { 'dm-10001': T0 - 18 * 60_000 },
      sentTodayGlobal: 99, sentTodayByRoom: { 'dm-10001': 99 }, unansweredStreakByRoom: { 'dm-10001': 9 },
    }
    const runtime = { connected: true, roomBound: true, lastUserMessageAtByRoom: {}, turnRunningByRoom: {}, toolRunning: false, deliveredDedupeKeys: [] }
    // 修复前（`proactive` 档）：这三条拦全都会命中 —— 事故就是它们。
    const proactive = evaluateOutboundBudget({ now: T0, config, counters, runtime, room: 'dm-10001' } as never)
    assert.equal(proactive.reason, 'cooldown:room', `对照：主动消息档确实会被冷却拦住（实际 ${proactive.reason}）`)
    // 修复后（`reminder` 档）：只剩物理可行性，可以发。
    const reminder = evaluateOutboundBudget({ now: T0, config, counters, runtime, room: 'dm-10001', profile: 'reminder' } as never)
    assert.deepEqual(reminder, { verdict: 'send', reason: 'ok' }, '到点提醒不许被主动消息的冷却/配额/退避拦住')
    // 通道真断了还是发不出去（不是把判据全关掉）。
    const offline = evaluateOutboundBudget({
      now: T0, config, counters, runtime: { ...runtime, connected: false }, room: 'dm-10001', profile: 'reminder',
    } as never)
    assert.deepEqual(offline, { verdict: 'defer', reason: 'no-channel' }, '物理不可行照样拦（这一档不是"永远放行"）')
  } finally {
    await rig.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
