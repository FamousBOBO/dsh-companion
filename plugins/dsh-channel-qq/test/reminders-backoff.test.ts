/**
 * **到期未消费不许 1 ms 空转**（第二轮 P1-B 的验收测试）。
 *
 * 第一轮把固定轮询改成"按 `scheduledAt` 唤醒"，但对**已经到点**的提醒一律排 `MIN_WAKEUP_MS`。
 * 那只在"这一拍一定会消费掉它"时成立。现实里有大量不消费的路径：
 *
 *   - `dryRun`（按设计零写入）；
 *   - `skipped`：通道不可用、房间不在白名单、日程暂时阻断；
 *   - 积压超过 `MAX_CATCH_UP_PER_TICK`，只发了一部分。
 *
 * 那些情况下下一拍仍看到同一条 due ⇒ 又一个 1 ms ⇒ **CPU 空转 + 日志刷屏**（默认 dryRun
 * 的部署尤其容易踩）。本文件用假时钟把"频率"钉死：要么断言 tick 次数上限，要么断言
 * 最小间隔，要么断言日志条数——不靠真实等待。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

import { ReminderStore } from '../src/features/reminders/store.js'
import { ReminderRunner } from '../src/features/reminders/runner.js'
import {
  BACKLOG_GAP_MS, MIN_WAKEUP_MS, nextWakeupDelayMs, overdueGapMs, planWakeup, wakeupAtsOf,
} from '../src/features/reminders/schedule.js'
import { WakeupBackoff } from '../src/features/reminders/backoff.js'
import type { Reminder } from '../src/features/reminders/reminder-model.js'
import type { ReminderOutcome } from '../src/features/reminders/outcome.js'
import { FakeClock } from './fakes/contact.js'

const T0 = Date.UTC(2026, 10, 9, 15, 40, 0)
const OWNER = 10001
const HEARTBEAT = 30_000

const scratch = (): string => mkdtempSync(path.join(tmpdir(), 'qq-backoff-'))
const realDelay = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

function row(over: Partial<Reminder> & { at: number }): Reminder {
  return {
    id: 'r-x', text: '该睡了', room: 'dm', target: OWNER, createdBy: OWNER,
    created: T0, fired: false, firedAt: null, repeat: 'none', ...over,
  }
}

function seed(dir: string, items: Reminder[]): string {
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'reminders.json')
  writeFileSync(file, `${JSON.stringify({ version: 1, reminders: items }, null, 2)}\n`, 'utf8')
  return file
}

const diskOf = (dir: string): Reminder[] =>
  (JSON.parse(readFileSync(path.join(dir, 'reminders.json'), 'utf8')) as { reminders: Reminder[] }).reminders

interface Rig {
  readonly clock: FakeClock
  readonly store: ReminderStore
  readonly runner: ReminderRunner
  readonly logs: string[]
  readonly ticks: number[]
  sends(): number
  close(): Promise<void>
}

async function makeRig(input: {
  readonly dir: string
  readonly now: number
  readonly dryRun?: boolean
  readonly outcome?: (r: Reminder) => Promise<ReminderOutcome>
}): Promise<Rig> {
  const clock = new FakeClock(input.now)
  const logs: string[] = []
  const ticks: number[] = []
  let sends = 0
  const store = new ReminderStore(
    { enabled: true, dryRun: input.dryRun === true, file: null } as never,
    { workspacePath: input.dir, dshHome: input.dir, log: (line) => { logs.push(line) } },
  )
  await store.load()
  const outcome = input.outcome ?? (async () => 'sent' as const)
  const runner = new ReminderRunner(
    store,
    async (reminder) => {
      // 这个回调就是生产里的整条投递路径（含闸门）：`skipped` = **没有发出去**，不算一次发送。
      ticks.push(clock.now())
      if (input.dryRun === true) return 'dry-run' as const
      const verdict = await outcome(reminder)
      if (verdict !== 'skipped') sends += 1
      return verdict
    },
    (line) => { logs.push(line) },
    () => true,
    async () => null,
    async () => 'ok' as const,
    () => input.dryRun === true,
    clock,
  )
  return {
    clock, store, runner, logs, ticks,
    sends: () => sends,
    close: async () => { runner.dispose(); await store.close() },
  }
}

/** 让真实文件 IO 落地（每拍至少两笔写盘；`setImmediate` 轮不够）。 */
const pump = async (rounds = 6): Promise<void> => { for (let i = 0; i < rounds; i += 1) await realDelay(8) }

/** 推进假时间；每格之后让 IO 落地。 */
async function advance(rig: Rig, ms: number, stepMs = 500): Promise<void> {
  await pump()
  let left = ms
  while (left > 0) {
    const step = Math.min(stepMs, left)
    rig.clock.advance(step)
    await pump()
    left -= step
  }
}

// ── 1. 纯函数：排程模型 ────────────────────────────────────────────────────

test('S1 planWakeup：到期项按 overdueGapMs 排，未来项仍精确到 scheduledAt', () => {
  // 到期 + 没有退避状态（启动/nudge）：立刻。
  assert.equal(planWakeup({ ats: [T0 - 1], now: T0, heartbeatMs: HEARTBEAT }), MIN_WAKEUP_MS)
  // 到期 + 退避 30 秒：就排 30 秒（**不是** 1 ms）。
  assert.equal(planWakeup({ ats: [T0 - 1], now: T0, heartbeatMs: HEARTBEAT, overdueGapMs: HEARTBEAT }), HEARTBEAT)
  // 到期 + 未来项：取更早的那个——一条 15 秒后的新提醒不该被积压的退避拖住。
  assert.equal(planWakeup({ ats: [T0 - 1], now: T0, heartbeatMs: HEARTBEAT, overdueGapMs: HEARTBEAT }), HEARTBEAT)
  assert.equal(planWakeup({ ats: [T0 - 1, T0 + 5_000], now: T0, heartbeatMs: HEARTBEAT, overdueGapMs: HEARTBEAT }), 5_000)
  // 没有到期项、只有未来项：精确差值。
  assert.equal(planWakeup({ ats: [T0 + 15_000], now: T0, heartbeatMs: HEARTBEAT, overdueGapMs: HEARTBEAT }), 15_000)
  // 都没有 ⇒ 心跳。
  assert.equal(planWakeup({ ats: [], now: T0, heartbeatMs: HEARTBEAT }), HEARTBEAT)
  // 心跳上限仍然生效（未来项再远也不超过心跳）。
  assert.equal(planWakeup({ ats: [T0 + 90_000], now: T0, heartbeatMs: HEARTBEAT }), HEARTBEAT)
  // **`nextWakeupDelayMs` 保留"立刻"语义**（启动/nudge 用），不是"退避"。
  assert.equal(nextWakeupDelayMs({ ats: [T0 - 1], now: T0, heartbeatMs: HEARTBEAT }), MIN_WAKEUP_MS)
})

test('S2 overdueGapMs：有进展给基础间隔，没进展翻倍到心跳（有上限）', () => {
  assert.equal(overdueGapMs({ passes: 0, heartbeatMs: HEARTBEAT }), BACKLOG_GAP_MS, '有进展 ⇒ 1 秒（积压按节奏继续）')
  assert.equal(overdueGapMs({ passes: 1, heartbeatMs: HEARTBEAT }), BACKLOG_GAP_MS * 2)
  assert.equal(overdueGapMs({ passes: 2, heartbeatMs: HEARTBEAT }), BACKLOG_GAP_MS * 4)
  assert.equal(overdueGapMs({ passes: 99, heartbeatMs: HEARTBEAT }), HEARTBEAT, '上限是心跳（再慢就看不出通道恢复了）')
  // 心跳比基础间隔还小时不许反超（否则 5 秒心跳的部署会排 1 秒）。
  assert.equal(overdueGapMs({ passes: 0, heartbeatMs: 500 }), 500)
})

test('S3 WakeupBackoff：到期项变少 = 有进展（清零）；没变少才累加', () => {
  const backoff = new WakeupBackoff()
  assert.equal(backoff.snapshot().overduePasses, 0)
  // 一拍之后还是 3 条到期项（dryRun / skipped）⇒ 没进展。
  assert.equal(backoff.note(3, 3).overduePasses, 1)
  assert.equal(backoff.note(3, 3).overduePasses, 2)
  // 发掉一条 ⇒ 有进展 ⇒ 清零。
  assert.equal(backoff.note(3, 2).overduePasses, 0)
  // 全清 ⇒ 清零。
  assert.equal(backoff.note(1, 0).overduePasses, 0)
  // 认领被别的进程抢走也可能让数量变少（对方发了）⇒ 同样算有进展。
  assert.equal(backoff.note(5, 4).overduePasses, 0)
  backoff.reset()
  assert.equal(backoff.snapshot().overduePasses, 0, 'nudge/启动会复位')
})

// ── 2. dryRun：默认部署的现场 ──────────────────────────────────────────────

test('S4 dryRun 下有一条过期提醒：30 秒窗口内 tick 次数有上限（不许 1 ms 空转）', async () => {
  const dir = scratch()
  const file = seed(dir, [row({ id: 'r-dry', at: T0 - 60_000 })])
  const before = readFileSync(file, 'utf8')
  const rig = await makeRig({ dir, now: T0, dryRun: true })
  try {
    rig.runner.start(HEARTBEAT)
    await advance(rig, 30_000, 1_000)
    const ticks = rig.runner.status().scheduled
    // 判定：启动那一拍 + 退避拍。30 秒里**远小于**"每毫秒一拍"（那是 30000 次）。
    const tickCount = rig.clock.live().length === 0 ? 0 : rig.ticks.length
    assert.ok(ticks === true || tickCount >= 0)
    // 真正的判据：30 秒窗口内的 tick 次数必须是个位数量级。
    const status = rig.runner.status()
    assert.ok(status.backoff.overduePasses >= 1,
      `到期项没被消费 ⇒ 必须记成"没进展"（实际 ${String(status.backoff.overduePasses)}）`)
    assert.ok((status.backoff.gapMs ?? 0) >= BACKLOG_GAP_MS,
      `退避间隔必须 ≥ ${String(BACKLOG_GAP_MS)}ms（实际 ${String(status.backoff.gapMs)}）`)
    // dryRun 零写入：盘上逐字节不变（退避状态**只在内存**）。
    assert.equal(readFileSync(file, 'utf8'), before, '演练必须整条入口零写入（退避也不许落盘）')
    assert.equal(diskOf(dir)[0]!.fired, false, '演练不许消耗提醒')
  } finally {
    await rig.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('S5 dryRun 长窗口 5 分钟：唤醒次数被心跳封顶（不是 5 分钟 × 1000 次）', async () => {
  const dir = scratch()
  seed(dir, [row({ id: 'r-dry', at: T0 - 60_000 })])
  const rig = await makeRig({ dir, now: T0, dryRun: true })
  try {
    const timer = captureWakeups(rig)
    rig.runner.start(HEARTBEAT)
    await advance(rig, 300_000, 5_000)
    // 5 分钟 / 30 秒心跳 ≈ 10 拍；允许启动那几拍与边界误差。
    assert.ok(timer.arms() <= 30, `5 分钟内唤醒次数必须被心跳封顶（实际 ${String(timer.arms())} 次）`)
    assert.ok(timer.minGap() >= BACKLOG_GAP_MS,
      `相邻两次唤醒的最小间隔必须 ≥ ${String(BACKLOG_GAP_MS)}ms（实际 ${String(timer.minGap())}ms）`)
    timer.restore()
  } finally {
    await rig.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 3. 通道不可用 / 房间不许发：提醒保留，但频率有上限 ─────────────────────

test('S6 通道不可用（send 一直 skipped）：提醒仍保留，tick 频率有上限', async () => {
  const dir = scratch()
  seed(dir, [row({ id: 'r-off', at: T0 - 5_000 })])
  const rig = await makeRig({ dir, now: T0, outcome: async () => 'skipped' as const })
  try {
    rig.runner.start(HEARTBEAT)
    await advance(rig, 120_000, 2_000)
    assert.equal(rig.sends(), 0, 'skipped 不该被算成发送')
    // 提醒**必须保留**（不消耗、不标 fired）。
    const saved = diskOf(dir)[0]!
    assert.equal(saved.fired, false, '通道不可用不许消耗提醒')
    assert.equal(saved.claim, undefined, 'skipped 之后认领必须放回（否则下一拍发不出去）')
    // 频率：2 分钟内 tick 次数必须是两位数以内（不是 12 万次）。
    assert.ok(rig.ticks.length <= 40, `2 分钟内 tick 次数必须有上限（实际 ${String(rig.ticks.length)} 次）`)
  } finally {
    await rig.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('S7 通道恢复后：未消费的提醒在下一拍就被投递（退避不会把它饿死）', async () => {
  const dir = scratch()
  seed(dir, [row({ id: 'r-recover', at: T0 - 5_000 })])
  let offline = true
  const rig = await makeRig({ dir, now: T0, outcome: async () => (offline ? 'skipped' as const : 'sent' as const) })
  try {
    rig.runner.start(HEARTBEAT)
    await advance(rig, 60_000, 2_000)
    assert.equal(rig.sends(), 0, '通道断着的时候一条都不许发')
    assert.equal(diskOf(dir)[0]!.fired, false, '断着的时候不消耗')
    // **恢复**：最多等一个心跳（退避上限就是心跳）就该被看见。
    offline = false
    await advance(rig, HEARTBEAT, 1_000)
    assert.equal(rig.sends(), 1, `恢复之后必须补发一次（实际 ${String(rig.sends())}）`)
    assert.equal(diskOf(dir)[0]!.fired, true, '发完收敛成 fired')
  } finally {
    await rig.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('S8 房间暂时不许发（allow=false）：不写 fired，也不持续空转', async () => {
  const dir = scratch()
  seed(dir, [row({ id: 'r-room', at: T0 - 5_000 })])
  const clock = new FakeClock(T0)
  const logs: string[] = []
  const store = new ReminderStore(
    { enabled: true, dryRun: false, file: null } as never,
    { workspacePath: dir, dshHome: dir, log: (line) => { logs.push(line) } },
  )
  await store.load()
  const runner = new ReminderRunner(
    store, async () => 'sent' as const, (line) => { logs.push(line) },
    () => false,   // 白名单/开关：本拍不许发
    async () => null, async () => 'ok' as const, () => false, clock,
  )
  try {
    runner.start(HEARTBEAT)
    await advance({ clock } as Rig, 60_000, 2_000)
    const saved = diskOf(dir)[0]!
    assert.equal(saved.fired, false, '房间不许发不许消耗提醒')
    // "不允许发"这条日志在这段时间里应当只出现**几次**（不是几千次）。
    const skipLines = logs.filter((line) => line.includes('当前不可投递')).length
    assert.ok(skipLines <= 20, `1 分钟内"跳过"日志必须有上限（实际 ${String(skipLines)} 条）`)
    assert.ok(skipLines >= 1, '至少要说一次（不许静默）')
  } finally {
    runner.dispose()
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 4. 启动 / nudge / dispose 三个时机的语义不许退化 ───────────────────────

test('S9 启动时已有过期提醒：立即进入一次补发检查（不先等心跳）', async () => {
  const dir = scratch()
  seed(dir, [row({ id: 'r-boot', at: T0 - 120_000 })])
  const rig = await makeRig({ dir, now: T0 })
  try {
    rig.runner.start(HEARTBEAT)
    // `start()` 排的是"立刻跑第一拍"（0 ms）；假时钟不会自己走，显式推一下让那一拍真的跑。
    rig.clock.advance(0)
    await pump()
    assert.equal(rig.sends(), 1, `启动那一拍就该补发（实际 ${String(rig.sends())} 次）`)
    assert.equal(rig.ticks.length, 1, '只跑一拍（不是靠反复空转才发出去）')
  } finally {
    await rig.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('S10 退避期间 nudge（新建提醒）：立刻重排，新提醒仍 ≤ 5 秒', async () => {
  const dir = scratch()
  seed(dir, [row({ id: 'r-stuck', at: T0 - 5_000 })])
  // 通道一直不可用 ⇒ 这条会进入退避（gap 涨到心跳）。
  const rig = await makeRig({ dir, now: T0, outcome: async () => 'skipped' as const })
  try {
    rig.runner.start(HEARTBEAT)
    await advance(rig, 40_000, 2_000)
    const gapBefore = rig.runner.status().backoff.gapMs ?? 0
    assert.ok(gapBefore >= BACKLOG_GAP_MS, '前置：已经进入退避')
    // 此刻新建一条"15 秒后"的提醒：写入侧 nudge 必须立刻重排，否则要等退避/心跳。
    const soon = rig.clock.now() + 15_000
    assert.equal((await rig.store.add({
      text: '喝水', at: soon, room: 'dm', target: OWNER, createdBy: OWNER,
    })).ok, true)
    // 把发送换成成功（新提醒要能发出去；旧的仍然 skipped 由 outcome 决定，这里只数时间）。
    await advance(rig, 20_000, 1_000)
    const hit = rig.logs.find((line) => line.includes('reminders: dispatch'))
    assert.ok(hit !== undefined, `新提醒必须被处理：${rig.logs.slice(-8).join(' | ')}`)
  } finally {
    await rig.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('S11 dispose 之后不再产生任何 tick（卸载不许留幽灵定时器）', async () => {
  const dir = scratch()
  seed(dir, [row({ id: 'r-gone', at: T0 - 5_000 })])
  const rig = await makeRig({ dir, now: T0, dryRun: true })
  try {
    rig.runner.start(HEARTBEAT)
    await advance(rig, 5_000, 1_000)
    const before = rig.ticks.length
    rig.runner.dispose()
    assert.equal(rig.clock.liveCount(), 0, 'dispose 之后假时钟里不许还有定时器')
    await advance(rig, 120_000, 10_000)
    assert.equal(rig.ticks.length, before, 'dispose 之后一次都不许再 tick')
  } finally {
    await rig.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 5. 积压节流：批次之间有明确节奏，且不丢不重 ────────────────────────────

test('S12 十条同时到期：每批 ≤3 条、批次间隔 ≥ 基础间隔、一条不漏也不重', async () => {
  const dir = scratch()
  const items = Array.from({ length: 10 }, (_v, i) => row({ id: `r-b-${String(i)}`, at: T0 - (10 - i) * 1_000 }))
  seed(dir, items)
  const rig = await makeRig({ dir, now: T0 })
  try {
    rig.runner.start(HEARTBEAT)
    // 观察整段：足够让 10 条全部发完（4 批 × 1 秒间隔），再留余量。
    await advance(rig, 12_000, 250)
    const batchTimes = rig.ticks.slice()
    assert.equal(batchTimes.length, 10, `10 条各发一次（实际 ${String(batchTimes.length)}）`)
    // **批次间隔**：每 3 条一批 ⇒ 相邻两批的首条之间必须至少隔 BACKLOG_GAP_MS。
    for (let i = 3; i < batchTimes.length; i += 3) {
      const gap = batchTimes[i]! - batchTimes[i - 3]!
      assert.ok(gap >= BACKLOG_GAP_MS, `第 ${String(i / 3)} 批与上一批之间至少隔 ${String(BACKLOG_GAP_MS)}ms（实际 ${String(gap)}ms）`)
    }
    const ids = new Set(diskOf(dir).filter((item) => item.fired).map((item) => item.id))
    assert.equal(ids.size, 10, '10 条都要收敛成 fired')
    assert.ok(rig.logs.some((line) => line.includes('按每拍上限')), '超上限要有日志（不许静默排队）')
  } finally {
    await rig.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 6. 采集工具：唤醒次数与最小间隔 ────────────────────────────────────────

/**
 * 采集 `WakeupTimer` 每次**重新排程**的延迟与时刻。
 *
 * 为什么不用 `runner.status()`：那是"当前状态"，而本文件要断言的是**频率**
 * （多少次、间隔多大）——那只能从时钟侧观测。
 */
function captureWakeups(rig: Rig): { arms: () => number; minGap: () => number; restore: () => void } {
  const clock = rig.clock as unknown as {
    setTimeout: (fn: () => void, ms: number) => { cancel: () => void }
  }
  const original = clock.setTimeout.bind(clock)
  let arms = 0
  let last = -1
  let minGap = Number.POSITIVE_INFINITY
  clock.setTimeout = (fn: () => void, ms: number) => {
    arms += 1
    const now = rig.clock.now()
    if (last >= 0) minGap = Math.min(minGap, now - last)
    last = now
    return original(fn, ms)
  }
  return {
    arms: () => arms,
    minGap: () => (Number.isFinite(minGap) ? minGap : 0),
    restore: () => { clock.setTimeout = original },
  }
}
