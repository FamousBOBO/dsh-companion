/**
 * **独立进程的并发证明**（第二轮 P1-A 的核心验收）。
 *
 * 为什么必须用真子进程：同一进程里的两个 `ReminderStore` 共享模块级状态（`OWNERS`、串行队列、
 * 锁实例），它们"互斥"只能证明进程内互斥。第一轮的 T4 因此**只能**算同进程回归，
 * 不能算跨进程证明——盘上最后只剩一个 claim，也不能证明"只发了一次"。
 *
 * 每个 worker 都是 `fork` 出来的**独立 Node 进程**（独立 pid、独立模块实例、独立内存），
 * 通过 IPC 与父进程交换"准备好了 / 开始了 / 认领到了 / 发了"，用 **barrier** 把并发起点对齐。
 * 骨架（fork/barrier/种子数据/读盘）在 `process-peer.ts`——与 `reminders-claim-cas.test.ts` 共用。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { boot, cleanup, diskOf, row, scratch, seed, T0, together, type WorkerReport } from './process-peer.js'

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
    cleanup(dir)
  }
})

test('M2 两个独立进程同时认领并尝试发送：总发送次数严格等于 1', async () => {
  const dir = scratch()
  seed(dir, [row({ id: 'r-once', at: T0 - 1_000 })])
  try {
    const reports = await together([
      { dir, task: 'dispatch', now: T0, id: 'r-once', owner: 'child-1', expectAt: T0 - 1_000 },
      { dir, task: 'dispatch', now: T0, id: 'r-once', owner: 'child-2', expectAt: T0 - 1_000 },
    ])
    const total = reports.reduce((sum, report) => sum + report.sends, 0)
    assert.equal(total, 1, `两个进程的发送次数之和必须严格等于 1（实际 ${String(total)}：${JSON.stringify(reports)}）`)
    const disk = diskOf(dir)
    assert.equal(disk[0]!.fired, true, '发完必须回写 fired')
    assert.equal(disk[0]!.claim, undefined, '一轮结束必须放掉认领')
  } finally {
    cleanup(dir)
  }
})

// ── 2. 不同提醒：两次更新都留下（不丢更新） ────────────────────────────────

test('M3 两个独立进程改不同提醒：两次更新都保留（后写不许覆盖先写）', async () => {
  const dir = scratch()
  seed(dir, [row({ id: 'r-a', at: T0 - 1_000 }), row({ id: 'r-b', at: T0 - 2_000 })])
  try {
    const reports = await together([
      { dir, task: 'dispatch', now: T0, id: 'r-a', owner: 'child-a', expectAt: T0 - 1_000 },
      { dir, task: 'dispatch', now: T0, id: 'r-b', owner: 'child-b', expectAt: T0 - 2_000 },
    ])
    assert.equal(reports.reduce((sum, report) => sum + report.sends, 0), 2, '两条各发一次')
    const byId = new Map(diskOf(dir).map((item) => [item.id, item]))
    assert.equal(byId.size, 2, '不许少行')
    assert.equal(byId.get('r-a')!.fired, true, 'r-a 的更新必须还在（没被 r-b 那笔写覆盖）')
    assert.equal(byId.get('r-b')!.fired, true, 'r-b 的更新必须还在（没被 r-a 那笔写覆盖）')
  } finally {
    cleanup(dir)
  }
})

// ── 3. 认领写失败 ⇒ 一次都不发 ─────────────────────────────────────────────

test('M4 认领那笔写盘失败：假发送适配器调用次数为 0', async () => {
  const dir = scratch()
  seed(dir, [row({ id: 'r-fail', at: T0 - 1_000 })])
  try {
    // ① 投递入口：认领没落盘 ⇒ **一次都不许发**（`dispatchOne` 把认领故障当"本拍不发"）。
    const [report] = await together([
      { dir, task: 'dispatch', now: T0, id: 'r-fail', owner: 'child-f', expectAt: T0 - 1_000, failClaimWrite: true },
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
    cleanup(dir)
  }
})

// ── 4. 持锁进程异常退出 ⇒ 另一进程不用等 TTL ───────────────────────────────

test('M5 持锁进程被强杀：另一进程立刻能拿到锁（不靠 TTL、也不许无锁抢写）', async () => {
  const dir = scratch()
  seed(dir, [row({ id: 'r-crash', at: T0 - 1_000 })])
  try {
    const holder = boot({ dir, task: 'hold', now: T0, id: 'r-crash', owner: 'holder' })
    await holder.ready
    holder.child.send({ type: 'go' })
    await holder.once('holding')
    // **强杀**：不给它任何收尾机会（正常退出会走 `finally` 释放锁，那就不叫崩溃了）。
    holder.child.kill('SIGKILL')
    await new Promise<void>((resolve) => { holder.child.on('exit', () => { resolve() }) })

    const [report] = await together([
      { dir, task: 'dispatch', now: T0, id: 'r-crash', owner: 'child-b', expectAt: T0 - 1_000 },
    ])
    assert.equal(report!.sends, 1, `强杀之后另一个进程必须能继续（实际发了 ${String(report!.sends)} 次）`)
    assert.equal(diskOf(dir)[0]!.fired, true, '照常收敛')
  } finally {
    cleanup(dir)
  }
})

// ── 5. owner 不匹配 ⇒ 不许释放别人的锁 ─────────────────────────────────────

test('M6 owner 不匹配：第二个进程不许释放别人的租约，认领仍然归原主', async () => {
  const dir = scratch()
  seed(dir, [row({
    id: 'r-held', at: T0 - 1_000,
    claim: { by: 'pid-999#1#deadbeef', at: T0 - 5_000, until: T0 + 60_000 },
  })])
  try {
    const [report] = await together([
      { dir, task: 'claim-release-other', now: T0, id: 'r-held', owner: 'child-x', expectAt: T0 - 1_000 },
    ])
    assert.equal(report!.claimed, false, '别人的有效认领在本拍必须挡住')
    assert.equal(report!.rejectCode, 'STALE_STATE')
    assert.equal(report!.releaseCode, 'STALE_STATE', '带 owner 的放回必须认出"这不是我的租约"')
    const disk = diskOf(dir)
    assert.equal(disk[0]!.claim?.by, 'pid-999#1#deadbeef', `别人的认领不许被放掉（实际 ${JSON.stringify(disk[0]!.claim)}）`)
    assert.equal(disk[0]!.claim?.until, T0 + 60_000, '租约到期时刻也不许被改')
  } finally {
    cleanup(dir)
  }
})

// ── 6. 活跃发送超过普通 tick：第二进程不得重复认领 ──────────────────────────

test('M7 活跃发送超过一拍：发送期间第二进程认领被拒（租约仍归发送者）', async () => {
  const dir = scratch()
  seed(dir, [row({ id: 'r-slow', at: T0 - 1_000 })])
  let slow: ReturnType<typeof boot> | null = null
  try {
    // 第一个进程认领之后**停 1.2 秒**才发（远超一拍，但远小于 TTL）。
    slow = boot({ dir, task: 'dispatch', now: T0, id: 'r-slow', owner: 'child-slow', expectAt: T0 - 1_000, holdMs: 1_200 })
    await slow.ready
    slow.child.send({ type: 'go' })
    assert.equal((await slow.once('claimed')).claimed, true, '第一进程必须认领成功')
    // 此刻 `claim` 已落盘、发送还没完成 ⇒ 第二个进程来抢必须被拒。
    const [second] = await together([{ dir, task: 'claim', now: T0, id: 'r-slow', owner: 'child-2', expectAt: T0 - 1_000 }])
    assert.equal(second!.claimed, false, '第一进程还在发，第二个不许认领')
    assert.equal(second!.rejectCode, 'STALE_STATE')
    assert.equal(second!.sends, 0, '拿不到认领就不许发送')
    const report = await slow.done
    assert.equal(report.sends, 1, '第一进程照常发完')
  } finally {
    slow?.child.kill()
    cleanup(dir)
  }
})

// ── 7. claim 过期 ⇒ unknown，不自动重发 ────────────────────────────────────

test('M8 认领已过期：第二个进程按 unknown 收敛，一次都不发（重启后状态正确恢复）', async () => {
  const dir = scratch()
  seed(dir, [row({
    id: 'r-stale', at: T0 - 60_000,
    claim: { by: 'pid-999#1#deadbeef', at: T0 - 60_000, until: T0 - 30_000 },
  })])
  try {
    const reports = await together([
      { dir, task: 'dispatch', now: T0, id: 'r-stale', owner: 'child-s', expectAt: T0 - 60_000 },
    ])
    const report: WorkerReport = reports[0]!
    assert.equal(report.sends, 0, '结果未知就不许重发（重复外发是事故）')
    const disk = diskOf(dir)
    assert.equal(disk[0]!.unknownReason, 'claim-expired:unknown', `盘上要留痕迹：${JSON.stringify(disk[0])}`)
    assert.equal(disk[0]!.claim, undefined, '过期认领要清掉（留着只会让下一拍再演一遍）')
    // 重启后再读一遍：状态要正确恢复（不兼容旧数据的话这里会读成空表或坏行）。
    const [again] = await together([{ dir, task: 'inspect', now: T0, id: 'r-stale', owner: 'child-i' }])
    assert.equal(again!.fired, true, '一次性提醒收敛后是 fired')
    assert.equal(again!.claim, null, '重启后不许冒出一个认领')
  } finally {
    cleanup(dir)
  }
})
