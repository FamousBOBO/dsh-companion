/**
 * **独立进程的并发证明**（第二轮 P1-A 的核心验收）。
 *
 * 为什么必须用真子进程：同一进程里的两个 `ReminderStore` 共享模块级状态（`OWNERS`、串行队列、
 * 锁实例），它们"互斥"只能证明进程内互斥。第一轮的 T4 因此**只能**算同进程回归，
 * 不能算跨进程证明——盘上最后只剩一个 claim，也不能证明"只发了一次"。
 *
 * 每个 worker 都是 `fork` 出来的**独立 Node 进程**（独立 pid、独立模块实例、独立内存），
 * 通过 IPC 与父进程交换"准备好了 / 开始了 / 认领到了 / 发了"。父进程用 **barrier** 把并发
 * 起点对齐：所有 worker 都 `ready` 之后才一起 `go`——不做 barrier 的话，两个进程会因为启动
 * 顺序永远不重叠，而"没撞上"会被误读成"互斥生效"。
 *
 * 时间也是**假时钟**：`scheduledAt` 与 `now` 都由父进程算好（绝对毫秒）传给 worker，
 * 两边对"到点"的判断完全一致且可复现，不依赖真实等待。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fork, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Reminder } from '../src/features/reminders/reminder-model.js'

/** 2026-11-09 23:40:00 Asia/Shanghai（与事故那条同刻，这里只当绝对毫秒用）。 */
const T0 = Date.UTC(2026, 10, 9, 15, 40, 0)
/** 造数收件人：生产里那个号**不许**出现在测试里。 */
const OWNER = 10001

/** worker 与本文件同目录（`build/lib-test/test/`），不会被 `*.test.js` 的 glob 收进测试集。 */
const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'reminders-multiprocess.worker.js')

const scratch = (): string => mkdtempSync(path.join(tmpdir(), 'qq-mp-'))

/** 造一条"已经到点、还没触发"的一次性提醒。 */
function row(over: Partial<Reminder> & { at: number }): Reminder {
  return {
    id: 'r-mp', text: '该睡了', room: 'dm', target: OWNER, createdBy: OWNER,
    created: T0, fired: false, firedAt: null, repeat: 'none', ...over,
  }
}

/** 把提醒写进 `dir/reminders.json`（模拟"停机期间就已经到期"的现场）。 */
function seed(dir: string, items: Reminder[]): string {
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'reminders.json')
  writeFileSync(file, `${JSON.stringify({ version: 1, reminders: items }, null, 2)}\n`, 'utf8')
  return file
}

const diskOf = (dir: string): Reminder[] =>
  (JSON.parse(readFileSync(path.join(dir, 'reminders.json'), 'utf8')) as { reminders: Reminder[] }).reminders

/** 一个 worker 的观测结果（全部经 IPC 从子进程汇报回来）。 */
interface WorkerReport {
  readonly pid: number
  /** 认领结果：`true` = 本进程拿到了这一轮。 */
  readonly claimed: boolean
  /** 认领被拒的业务码（`STALE_STATE` 等）。 */
  readonly rejectCode: string | null
  /** 放回认领的结果（`STALE_STATE` = 认出"这不是我的租约"）。 */
  readonly releaseCode: string | null
  /** 认领抛出的存储故障码（`LOCK_TIMEOUT` / `PERSIST_FAILED` ...）。 */
  readonly faultCode: string | null
  /** 本进程调用假发送适配器的次数（跨进程总发送次数的唯一来源）。 */
  readonly sends: number
  /** 本进程结束后读到的盘上 `claim`。 */
  readonly claim: { by: string; until: number } | null
  /** 本进程结束后读到的盘上 `fired`。 */
  readonly fired: boolean
  /** 本进程看到的 `writeModel()`（诊断面必读字段）。 */
  readonly writeModel: string
}

interface Job {
  readonly dir: string
  readonly task: 'claim' | 'dispatch' | 'claim-release-other' | 'inspect' | 'hold'
  readonly now: number
  readonly id: string
  readonly owner: string
  readonly holdMs?: number
  readonly failSend?: boolean
  readonly failClaimWrite?: boolean
}

/** 起一个 worker，等它报 `ready`（**这时它还什么都没干**）。 */
function boot(job: Job): { child: ChildProcess; ready: Promise<void>; done: Promise<WorkerReport> } {
  const child = fork(WORKER, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  const ready = new Promise<void>((resolve) => {
    child.on('message', (message: { type?: string }) => { if (message.type === 'ready') resolve() })
  })
  let settled = false
  const done = new Promise<WorkerReport>((resolve, reject) => {
    child.on('message', (message: { type?: string; report?: WorkerReport }) => {
      if (message.type === 'done' && message.report !== undefined) { settled = true; resolve(message.report) }
    })
    child.on('error', (error) => { if (!settled) { settled = true; reject(error) } })
    // **被强杀**（`code === null`）不算"命令失败"——M5 就是故意杀它；只有真的非零退出才算失败。
    child.on('exit', (code) => {
      if (!settled && code !== 0 && code !== null) { settled = true; reject(new Error(`worker 退出码 ${String(code)}`)) }
    })
  })
  // 有的用例（M5 的持锁进程）永远不会有 `done`：别让未处理的 rejection 把整个文件带下水。
  done.catch(() => {})
  child.send({ type: 'job', ...job })
  return { child, ready, done }
}

/**
 * **barrier**：所有 worker 都 `ready` 之后才一起 `go`，然后并行收结果。
 *
 * 这是本文件的核心工具。少了它，"并发"只是"两个进程都跑过"，没有任何一次真的重叠。
 */
async function together(jobs: readonly Job[]): Promise<WorkerReport[]> {
  const boots = jobs.map(boot)
  await Promise.all(boots.map(async (item) => await item.ready))
  for (const item of boots) item.child.send({ type: 'go' })
  try {
    return await Promise.all(boots.map(async (item) => await item.done))
  } finally {
    for (const item of boots) item.child.kill()
  }
}

// ── 1. 同一提醒：只有一个进程取得有效 claim ─────────────────────────────────

test('M1 两个独立进程同时认领同一提醒：只有一个取得有效 claim', async () => {
  const dir = scratch()
  seed(dir, [row({ id: 'r-one', at: T0 - 1_000 })])
  try {
    const reports = await together([
      { dir, task: 'claim', now: T0, id: 'r-one', owner: 'child-1' },
      { dir, task: 'claim', now: T0, id: 'r-one', owner: 'child-2' },
    ])
    assert.equal(new Set(reports.map((report) => report.pid)).size, 2, `必须是两个不同的进程：${JSON.stringify(reports.map((report) => report.pid))}`)
    const winners = reports.filter((report) => report.claimed)
    assert.equal(winners.length, 1, `只能有一个进程认领成功（实际 ${String(winners.length)}：${JSON.stringify(reports)}）`)
    const loser = reports.find((report) => !report.claimed)!
    // 输的那一方必须是**业务拒绝**（"别人在发"），不是"出故障了所以没认出"。
    assert.equal(loser.rejectCode, 'STALE_STATE', `输的一方必须被认领挡住：${JSON.stringify(loser)}`)
    // 跨进程锁真的用上了（不是静默退化）。
    assert.equal(winners[0]!.writeModel, 'cross-process-lock', '必须是跨进程锁模型（否则这条测试毫无意义）')
    const disk = diskOf(dir)
    assert.equal(disk.length, 1)
    assert.equal(disk[0]!.claim?.by, winners[0]!.pid === reports[0]!.pid ? 'child-1' : 'child-2', '盘上的认领归赢家')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('M2 两个独立进程同时认领并尝试发送：总发送次数严格等于 1', async () => {
  const dir = scratch()
  seed(dir, [row({ id: 'r-once', at: T0 - 1_000 })])
  try {
    const reports = await together([
      { dir, task: 'dispatch', now: T0, id: 'r-once', owner: 'child-1' },
      { dir, task: 'dispatch', now: T0, id: 'r-once', owner: 'child-2' },
    ])
    const total = reports.reduce((sum, report) => sum + report.sends, 0)
    assert.equal(total, 1, `两个进程的发送次数之和必须严格等于 1（实际 ${String(total)}：${JSON.stringify(reports)}）`)
    const disk = diskOf(dir)
    assert.equal(disk[0]!.fired, true, '发完必须回写 fired')
    assert.equal(disk[0]!.claim, undefined, '一轮结束必须放掉认领')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 2. 不同提醒：两次更新都留下（不丢更新） ────────────────────────────────

test('M3 两个独立进程改不同提醒：两次更新都保留（后写不许覆盖先写）', async () => {
  const dir = scratch()
  seed(dir, [row({ id: 'r-a', at: T0 - 1_000 }), row({ id: 'r-b', at: T0 - 2_000 })])
  try {
    const reports = await together([
      { dir, task: 'dispatch', now: T0, id: 'r-a', owner: 'child-a' },
      { dir, task: 'dispatch', now: T0, id: 'r-b', owner: 'child-b' },
    ])
    assert.equal(reports.reduce((sum, report) => sum + report.sends, 0), 2, '两条各发一次')
    const byId = new Map(diskOf(dir).map((item) => [item.id, item]))
    assert.equal(byId.size, 2, '不许少行')
    assert.equal(byId.get('r-a')!.fired, true, 'r-a 的更新必须还在（没被 r-b 那笔写覆盖）')
    assert.equal(byId.get('r-b')!.fired, true, 'r-b 的更新必须还在（没被 r-a 那笔写覆盖）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 3. 认领写失败 ⇒ 一次都不发 ─────────────────────────────────────────────

test('M4 认领那笔写盘失败：假发送适配器调用次数为 0', async () => {
  const dir = scratch()
  seed(dir, [row({ id: 'r-fail', at: T0 - 1_000 })])
  try {
    // ① 投递入口：认领没落盘 ⇒ **一次都不许发**（`dispatchOne` 把认领故障当"本拍不发"）。
    const [report] = await together([
      { dir, task: 'dispatch', now: T0, id: 'r-fail', owner: 'child-f', failClaimWrite: true },
    ])
    assert.equal(report!.sends, 0, `认领没落盘就一次都不许发（实际 ${String(report!.sends)} 次）`)
    // ② 底层那笔认领本身必须**抛故障**（`PERSIST_FAILED`），不许静默返回"没认到"。
    const [raw] = await together([
      { dir, task: 'claim', now: T0, id: 'r-fail', owner: 'child-f', failClaimWrite: true },
    ])
    assert.equal(raw!.faultCode, 'PERSIST_FAILED', `写盘失败要如实抛出来：${JSON.stringify(raw)}`)
    assert.equal(raw!.claimed, false)
    const disk = diskOf(dir)
    assert.equal(disk[0]!.fired, false, '失败不该消耗这条提醒')
    assert.equal(disk[0]!.claim, undefined, '也不该留下认领')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 4. 持锁进程异常退出 ⇒ 另一进程不用等 TTL ───────────────────────────────

test('M5 持锁进程被强杀：另一进程立刻能拿到锁（不靠 TTL、也不许无锁抢写）', async () => {
  const dir = scratch()
  seed(dir, [row({ id: 'r-crash', at: T0 - 1_000 })])
  try {
    const holder = await holdThenKill(dir)
    assert.equal(holder, true, '持锁进程要先报告"已经拿到锁"')
    const [report] = await together([{ dir, task: 'dispatch', now: T0, id: 'r-crash', owner: 'child-b' }])
    assert.equal(report!.sends, 1, `强杀之后另一个进程必须能继续（实际发了 ${String(report!.sends)} 次）`)
    assert.equal(diskOf(dir)[0]!.fired, true, '照常收敛')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** 起一个"拿到跨进程锁就不放"的进程，等它报 `holding` 之后**强杀**（模拟崩溃/断电）。 */
async function holdThenKill(dir: string): Promise<boolean> {
  const item = boot({ dir, task: 'hold', now: T0, id: 'r-crash', owner: 'holder' })
  await item.ready
  const holding = new Promise<boolean>((resolve) => {
    item.child.on('message', (message: { type?: string }) => { if (message.type === 'holding') resolve(true) })
    setTimeout(() => resolve(false), 10_000)
  })
  item.child.send({ type: 'go' })
  const held = await holding
  // **强杀**：不给它任何收尾机会（正常退出会走 `finally` 释放锁，那就不叫崩溃了）。
  item.child.kill('SIGKILL')
  await new Promise<void>((resolve) => { item.child.on('exit', () => { resolve() }) })
  return held
}

// ── 5. owner 不匹配 ⇒ 不许释放别人的锁 ─────────────────────────────────────

test('M6 owner 不匹配：第二个进程不许释放别人的租约，认领仍然归原主', async () => {
  const dir = scratch()
  seed(dir, [row({
    id: 'r-held', at: T0 - 1_000,
    claim: { by: 'pid-999#1', at: T0 - 5_000, until: T0 + 60_000 },
  })])
  try {
    const [report] = await together([
      { dir, task: 'claim-release-other', now: T0, id: 'r-held', owner: 'child-x' },
    ])
    assert.equal(report!.claimed, false, '别人的有效认领在本拍必须挡住')
    assert.equal(report!.rejectCode, 'STALE_STATE')
    assert.equal(report!.releaseCode, 'STALE_STATE', '带 owner 的放回必须认出"这不是我的租约"')
    const disk = diskOf(dir)
    assert.equal(disk[0]!.claim?.by, 'pid-999#1', `别人的认领不许被放掉（实际 ${JSON.stringify(disk[0]!.claim)}）`)
    assert.equal(disk[0]!.claim?.until, T0 + 60_000, '租约到期时刻也不许被改')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 6. 活跃发送超过普通 tick：第二进程不得重复认领 ──────────────────────────

test('M7 活跃发送超过一拍：发送期间第二进程认领被拒（租约仍归发送者）', async () => {
  const dir = scratch()
  seed(dir, [row({ id: 'r-slow', at: T0 - 1_000 })])
  try {
    // 第一个进程认领之后**停 1.2 秒**才发（远超一拍，但远小于 TTL）。
    const slow = boot({ dir, task: 'dispatch', now: T0, id: 'r-slow', owner: 'child-slow', holdMs: 1_200 })
    await slow.ready
    const claimed = new Promise<boolean>((resolve) => {
      slow.child.on('message', (message: { type?: string; claimed?: boolean }) => {
        if (message.type === 'claimed') resolve(message.claimed === true)
      })
      setTimeout(() => resolve(false), 10_000)
    })
    slow.child.send({ type: 'go' })
    assert.equal(await claimed, true, '第一进程必须认领成功')
    // 此刻 `claim` 已落盘、发送还没完成 ⇒ 第二个进程来抢必须被拒。
    const [second] = await together([{ dir, task: 'claim', now: T0, id: 'r-slow', owner: 'child-2' }])
    assert.equal(second!.claimed, false, '第一进程还在发，第二个不许认领')
    assert.equal(second!.rejectCode, 'STALE_STATE')
    assert.equal(second!.sends, 0, '拿不到认领就不许发送')
    await slow.done
    slow.child.kill()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 7. claim 过期 ⇒ unknown，不自动重发 ────────────────────────────────────

test('M8 认领已过期：第二个进程按 unknown 收敛，一次都不发（重启后状态正确恢复）', async () => {
  const dir = scratch()
  seed(dir, [row({
    id: 'r-stale', at: T0 - 60_000,
    claim: { by: 'pid-999#1', at: T0 - 60_000, until: T0 - 30_000 },
  })])
  try {
    const [report] = await together([{ dir, task: 'dispatch', now: T0, id: 'r-stale', owner: 'child-s' }])
    assert.equal(report!.sends, 0, '结果未知就不许重发（重复外发是事故）')
    const disk = diskOf(dir)
    assert.equal(disk[0]!.unknownReason, 'claim-expired:unknown', `盘上要留痕迹：${JSON.stringify(disk[0])}`)
    assert.equal(disk[0]!.claim, undefined, '过期认领要清掉（留着只会让下一拍再演一遍）')
    // 重启后再读一遍：状态要正确恢复（不兼容旧数据的话这里会读成空表或坏行）。
    const [again] = await together([{ dir, task: 'inspect', now: T0, id: 'r-stale', owner: 'child-i' }])
    assert.equal(again!.fired, true, '一次性提醒收敛后是 fired')
    assert.equal(again!.claim, null, '重启后不许冒出一个认领')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
