/**
 * **快照 CAS 与身份唯一性**（第三轮 P1-A / P1-B / P1-C / P2 的验收）。
 *
 * 第二轮证明了"写入互斥"：两个进程不能同时改同一份文件。但**写入互斥 ≠ 决策用了最新状态**。
 * 本文件把这条差距钉成 12 个用例，全部跑在**真子进程**上（同一进程里的两个 Store 共享
 * `OWNERS`、串行队列与锁实例，证明不了跨进程语义；骨架见 `process-peer.ts`）：
 *
 *   1. **旧快照不许认领**：周期提醒推进/换绑之后，握着推进前快照的进程必须被 `STALE_STATE` 拒；
 *   2. **投递必须用锁内最新对象**：`send` / `recordSent` / 日志 `scheduledAt` 都是认领后那一行；
 *   3. **认领之后二次 `allow`**：闸门在认领期间关掉 ⇒ 放回认领、一次都不发；
 *   4. **续租 vs 收敛**：A 续租成功之后，B 拿着旧快照不能把 A 的发送标成 `unknown`；
 *   5. **owner 全局唯一**：同 pid 的两个 runner 也不许撞（容器共享 PID namespace 是真实场景）；
 *   6. **没有跨进程锁 ⇒ fail-closed**：`LOCK_UNAVAILABLE`，不是"竞争激烈"、更不是无锁写入。
 *
 * 假时钟、假发送适配器、barrier 对齐并发起点；一次真实 QQ/OneBot 都没有。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { alone, boot, cleanup, diskOf, row, scratch, seed, T0, together } from './process-peer.js'
import { ReminderStore } from '../src/features/reminders/store.js'
import { claimOwnerOf, shortOwner } from '../src/features/reminders/dispatch.js'
import type { ProcessMutex, MutexLease } from '../src/features/reminders/store-contract.js'
import { SqliteProcessMutex } from '../src/adapters/fs-store/process-lock.js'

const TTL = 120_000

// ── 1. 旧快照不许认领（P1-A 核心） ─────────────────────────────────────────

test('C1 周期提醒已推进：拿旧快照认领必须被 STALE_STATE 拒，盘上一个字都不改', async () => {
  const dir = scratch()
  // 盘上这一轮已经推进到 `T0`（有人发过了），而某个进程手里还是推进前那一轮（`T0 - 86400000`）。
  seed(dir, [row({ id: 'r-adv', at: T0, repeat: 'daily' })])
  try {
    const stale = await alone({
      dir, task: 'claim-expect', now: T0, id: 'r-adv', owner: 'child-stale',
      expectAt: T0 - 86_400_000,
    })
    assert.equal(stale.claimed, false, '旧快照不许认领（认领会把"下一轮"提前发出去）')
    assert.equal(stale.rejectCode, 'STALE_STATE', `必须是业务拒绝：${JSON.stringify(stale)}`)
    assert.equal(stale.claim, null, '认领没落盘')
    assert.equal(stale.at, T0, '盘上的 at 不许被这次尝试改动')
    assert.equal(stale.attempts, null, '`attempts` 也不许 +1（认领没发生）')
  } finally {
    cleanup(dir)
  }
})

test('C2 日程换绑：只比较 id 不够，revision 变了同样必须被拒', async () => {
  const dir = scratch()
  seed(dir, [row({ id: 'r-occ', at: T0 - 1_000, occurrence: { id: 'gym', revision: 8 } })])
  try {
    const wrongRevision = await alone({
      dir, task: 'claim-expect', now: T0, id: 'r-occ', owner: 'child-a',
      expectAt: T0 - 1_000, expectOccurrence: { id: 'gym', revision: 7 },
    })
    assert.equal(wrongRevision.claimed, false, '同一个日程但 revision 不同 ⇒ 不是同一轮')
    assert.equal(wrongRevision.rejectCode, 'STALE_STATE')
    // 绑定时只有一边是 null（解绑/新绑）也必须算"不是同一轮"。
    seed(dir, [row({ id: 'r-occ', at: T0 - 1_000, occurrence: { id: 'gym', revision: 8 } })])
    const wrongNull = await alone({
      dir, task: 'claim-expect', now: T0, id: 'r-occ', owner: 'child-b',
      expectAt: T0 - 1_000, expectOccurrence: null,
    })
    assert.equal(wrongNull.claimed, false, '盘上有绑定、预期是 null ⇒ 不是同一轮')
    // 完全一致时才允许（否则这条 CAS 就是把正常投递也挡掉）。
    const matching = await alone({
      dir, task: 'claim-expect', now: T0, id: 'r-occ', owner: 'child-c',
      expectAt: T0 - 1_000, expectOccurrence: { id: 'gym', revision: 8 },
    })
    assert.equal(matching.claimed, true, '预期与盘上完全一致时必须认领成功')
  } finally {
    cleanup(dir)
  }
})

test('C3 还没到点：带着正确快照也不许提前认领', async () => {
  const dir = scratch()
  seed(dir, [row({ id: 'r-future', at: T0 + 60_000 })])
  try {
    const early = await alone({
      dir, task: 'claim-expect', now: T0, id: 'r-future', owner: 'child-e',
      expectAt: T0 + 60_000,
    })
    assert.equal(early.claimed, false, '提前认领会让"到点判定"形同虚设')
    assert.equal(early.rejectCode, 'STALE_STATE')
    assert.equal(early.claim, null)
  } finally {
    cleanup(dir)
  }
})

// ── 2. 投递链必须使用锁内最新对象（P1-A 第二半） ───────────────────────────

test('C4 两个进程同时投递一条周期提醒：只发一次，且推进只发生一次', async () => {
  const dir = scratch()
  seed(dir, [row({ id: 'r-per', at: T0 - 1_000, repeat: 'daily' })])
  try {
    const reports = await together([
      { dir, task: 'dispatch-period', now: T0, id: 'r-per', owner: 'child-1', expectAt: T0 - 1_000 },
      { dir, task: 'dispatch-period', now: T0, id: 'r-per', owner: 'child-2', expectAt: T0 - 1_000 },
    ])
    const total = reports.reduce((sum, report) => sum + report.sends, 0)
    assert.equal(total, 1, `周期提醒同一轮只能发一次（实际 ${String(total)}：${JSON.stringify(reports)}）`)
    // **推进只许发生一次**：两次推进就是"跳过下一轮"（`at` 会多前进一天）。
    const at = diskOf(dir)[0]!.at!
    assert.equal(at, T0 - 1_000 + 86_400_000, `at 只能推进一轮（实际 ${String(at)}）`)
  } finally {
    cleanup(dir)
  }
})

test('C5 认领后的权威对象是锁内最新行：日志与记账的 scheduledAt 都取自它', async () => {
  const dir = scratch()
  // 盘上比调用方手里的快照**更新**（`at` 已被推进到 T0），调用方以为还是 T0-1000。
  seed(dir, [row({ id: 'r-log', at: T0, repeat: 'daily' })])
  try {
    const stale = await alone({ dir, task: 'dispatch', now: T0, id: 'r-log', owner: 'child-s', expectAt: T0 - 1_000 })
    assert.equal(stale.sends, 0, '快照不符 ⇒ 不投递（否则会把下一轮提前发掉）')
    assert.equal(stale.faultCode, null, '这是业务拒绝，不是故障')
    assert.equal(stale.at, T0, '盘上 at 不变')

    // 快照一致时正常发；发完推进到下一轮（证明记账用的是**认领后**的对象）。
    seed(dir, [row({ id: 'r-log', at: T0 - 1_000, repeat: 'daily' })])
    const fresh = await alone({ dir, task: 'dispatch-period', now: T0, id: 'r-log', owner: 'child-f', expectAt: T0 - 1_000 })
    assert.equal(fresh.sends, 1)
    assert.equal(fresh.at, T0 - 1_000 + 86_400_000, '记账按认领后那一轮推进')
  } finally {
    cleanup(dir)
  }
})

// ── 3. 认领后二次 allow ────────────────────────────────────────────────────

test('C6 认领期间闸门关掉：二次 allow 拦住、放回认领、一次都不发', async () => {
  const dir = scratch()
  seed(dir, [row({ id: 'r-gate', at: T0 - 1_000 })])
  const logs: string[] = []
  let allowed = true
  let sends = 0
  const store = new ReminderStore(
    { enabled: true, dryRun: false, file: null } as never,
    { workspacePath: dir, dshHome: dir, log: () => {} },
    undefined,
    new SqliteProcessMutex(path.join(dir, 'reminders.json')),
  )
  try {
    await store.load()
    const { dispatchOne } = await import('../src/features/reminders/dispatch.js')
    const target = store.list(5)[0]!
    await dispatchOne({
      store,
      owner: claimOwnerOf(),
      now: () => T0,
      dryRun: () => false,
      // **第一次允许、第二次拒绝**：模拟"认领期间开关被关掉"。
      allow: () => { const ok = allowed; allowed = false; return ok },
      send: async () => { sends += 1; return 'sent' },
      recordSent: async () => true,
      markUnknown: async () => {},
      haltDispatch: () => {},
      log: (line) => { logs.push(line) },
    }, target)
    assert.equal(sends, 0, `二次 allow 拒绝之后一次都不许发（实际 ${String(sends)} 次）`)
    assert.ok(logs.some((line) => line.includes('认领后复查不允许投递')), `要留一行说明：${logs.join(' | ')}`)
    const disk = diskOf(dir)
    assert.equal(disk[0]!.claim, undefined, '放回认领必须真的落盘（否则要等 TTL）')
    assert.equal(disk[0]!.fired, false, '没发就不许消耗')
  } finally {
    await store.close()
    cleanup(dir)
  }
})

test('C7 放回认领失败不许静默：日志里必须说出来', async () => {
  const dir = scratch()
  seed(dir, [row({ id: 'r-rel', at: T0 - 1_000 })])
  const logs: string[] = []
  const store = new ReminderStore(
    { enabled: true, dryRun: false, file: null } as never,
    { workspacePath: dir, dshHome: dir, log: () => {} },
    undefined,
    new SqliteProcessMutex(path.join(dir, 'reminders.json')),
  )
  try {
    await store.load()
    // 让 `releaseClaim` 这一笔失败（其余写盘正常）。
    const { dispatchOne } = await import('../src/features/reminders/dispatch.js')
    const original = (store as unknown as { io: { replaceSerialized: (bytes: string) => Promise<{ kind: string }> } }).io
    const target = store.list(5)[0]!
    let calls = 0
    const io = original as unknown as { replaceSerialized: (bytes: string) => Promise<{ kind: string }> }
    const real = io.replaceSerialized.bind(io)
    io.replaceSerialized = async (bytes: string) => {
      calls += 1
      // 第 2 笔 = 放回认领（第 1 笔是认领自己）。
      if (calls === 2) throw new Error('桩：放回写盘失败')
      return await real(bytes)
    }
    await dispatchOne({
      store,
      owner: claimOwnerOf(),
      now: () => T0,
      dryRun: () => false,
      allow: () => true,
      send: async () => 'skipped',
      recordSent: async () => true,
      markUnknown: async () => {},
      haltDispatch: () => {},
      log: (line) => { logs.push(line) },
    }, target)
    assert.ok(logs.some((line) => line.includes('没能放回')), `放回失败必须留痕：${logs.join(' | ')}`)
  } finally {
    await store.close()
    cleanup(dir)
  }
})

// ── 4. 续租 vs 收敛（P1-B） ────────────────────────────────────────────────

test('C8 A 续租之后 B 的收敛必须失败：不许把正在进行的发送标成 unknown', async () => {
  const dir = scratch()
  // 盘上是一条**看起来快过期**的认领（还差 300 ms）。
  seed(dir, [row({
    id: 'r-renews', at: T0 - 1_000,
    claim: { by: 'holder-a', at: T0 - TTL + 400, until: T0 - 300 },
  })])
  let holder: ReturnType<typeof boot> | null = null
  try {
    // A：持续续租（每 120 ms 一次，拖 1 秒）。时钟冻结在 `T0 - 400`（还没过期的那一瞬）。
    holder = boot({ dir, task: 'claim-hold-renew', now: T0 - 400, id: 'r-renews', owner: 'holder-a', holdMs: 1_000 })
    await holder.ready
    holder.child.send({ type: 'go' })
    const first = await holder.once('renewed')
    const renewedUntil = first.until
    assert.equal(typeof renewedUntil, 'number', `续租要报出新的 until：${JSON.stringify(first)}`)
    // B：拿着**旧 until** 来收敛 ⇒ 必须被拒（盘上已经被续到未来）。
    const [stale] = await together([{
      dir, task: 'resolve-stale', now: T0, id: 'r-renews', owner: 'child-b',
      expectOwner: 'holder-a', expectUntil: T0 - 300,
    }])
    assert.equal(stale!.resolveCode, 'STALE_STATE', `续租之后不许收敛：${JSON.stringify(stale)}`)
    assert.equal(stale!.unknownReason, null, '不许写 unknown')
    const claim = diskOf(dir)[0]!.claim
    assert.equal(claim?.by, 'holder-a', '认领仍归 A（没被清掉）')
    assert.ok((claim?.until ?? 0) > T0 - 300, `until 应当已被续到未来（实际 ${String(claim?.until)}）`)
    await holder.done
  } finally {
    holder?.child.kill()
    cleanup(dir)
  }
})

test('C9 认领仍是原 owner / 原 until 且确实过期：允许收敛成 unknown（不重发）', async () => {
  const dir = scratch()
  const expiredAt = T0 - 1_000
  seed(dir, [row({
    id: 'r-dead', at: T0 - 60_000,
    claim: { by: 'holder-a', at: T0 - TTL, until: expiredAt },
  })])
  try {
    const report = await alone({
      dir, task: 'resolve-stale', now: T0, id: 'r-dead', owner: 'child-b',
      expectOwner: 'holder-a', expectUntil: expiredAt,
    })
    assert.equal(report.resolveCode, null, `原样过期时应当收敛成功：${JSON.stringify(report)}`)
    assert.equal(report.unknownReason, 'claim-expired:unknown', '收敛成 unknown（结果未知）')
    assert.equal(report.claim, null, '认领被清掉')
    assert.equal(report.fired, true, '一次性提醒收敛后是终态')
  } finally {
    cleanup(dir)
  }
})

test('C10 owner 已换或 claim 已消失：收敛一律失败，状态不动', async () => {
  const dir = scratch()
  seed(dir, [row({ id: 'r-gone', at: T0 - 1_000 })])
  try {
    // ① 盘上根本没有 claim（对方已收尾）。
    const none = await alone({ dir, task: 'resolve-stale', now: T0, id: 'r-gone', owner: 'child-b', expectOwner: 'holder-a', expectUntil: T0 - 1 })
    assert.equal(none.resolveCode, 'STALE_STATE', '没有 claim 时不许"收敛"出一条 unknown')
    assert.equal(none.unknownReason, null)
    // ② 认领已经易主。
    seed(dir, [row({
      id: 'r-gone', at: T0 - 1_000,
      claim: { by: 'holder-b', at: T0 - 5_000, until: T0 - 1_000 },
    })])
    const other = await alone({ dir, task: 'resolve-stale', now: T0, id: 'r-gone', owner: 'child-c', expectOwner: 'holder-a', expectUntil: T0 - 1_000 })
    assert.equal(other.resolveCode, 'STALE_STATE', '易主之后不许清别人的 claim')
    assert.equal(diskOf(dir)[0]!.claim?.by, 'holder-b', '盘上认领不许动')
    assert.equal(diskOf(dir)[0]!.unknownReason, undefined, '更不许写 unknown')
  } finally {
    cleanup(dir)
  }
})

test('C11 收敛写盘失败 ⇒ fail-closed：既不当作已收敛，也不重发，而且必须留痕', async () => {
  const dir = scratch()
  const expiredAt = T0 - 1_000
  seed(dir, [row({
    id: 'r-fail', at: T0 - 60_000,
    claim: { by: 'holder-a', at: T0 - TTL, until: expiredAt },
  })])
  const logs: string[] = []
  const store = new ReminderStore(
    { enabled: true, dryRun: false, file: null } as never,
    { workspacePath: dir, dshHome: dir, log: () => {} },
    undefined,
    new SqliteProcessMutex(path.join(dir, 'reminders.json')),
  )
  try {
    await store.load()
    // 让**所有写盘**失败：这正是"收敛写不进去"的现场。
    const io = (store as unknown as { io: { replaceSerialized: (bytes: string) => Promise<{ kind: string }> } }).io
    io.replaceSerialized = async () => { throw new Error('桩：写盘失败（disk full）') }
    const { dispatchOne } = await import('../src/features/reminders/dispatch.js')
    let sends = 0
    await dispatchOne({
      store,
      owner: claimOwnerOf(),
      now: () => T0,
      dryRun: () => false,
      allow: () => true,
      send: async () => { sends += 1; return 'sent' },
      recordSent: async () => true,
      markUnknown: async () => {},
      haltDispatch: () => {},
      log: (line) => { logs.push(line) },
    }, store.list(5)[0]!)
    assert.equal(sends, 0, '收敛写不进去时一次都不许发（否则就是"结果未知却重发"）')
    assert.ok(logs.some((line) => line.includes('没写进盘')), `写盘失败必须留痕：${logs.join(' | ')}`)
    // 盘上仍是旧认领、仍没有 unknown（没有"假装收敛了"）。
    const disk = diskOf(dir)
    assert.equal(disk[0]!.claim?.by, 'holder-a', '旧认领仍在')
    assert.equal(disk[0]!.unknownReason, undefined, 'unknown 没写进去')
    assert.equal(disk[0]!.fired, false, '状态没有被改动')
  } finally {
    await store.close()
    cleanup(dir)
  }
})

// ── 5. owner 身份唯一（P1-C） ──────────────────────────────────────────────

test('C12 同一 pid 的两个 runner：owner 必须不同（容器共享 PID namespace 的真实场景）', () => {
  const a = claimOwnerOf(4242)
  const b = claimOwnerOf(4242)
  assert.notEqual(a, b, '同 pid 两次创建 runner 也必须拿到不同 owner（否则一方会把对方的认领判成 mine）')
  assert.match(a, /^pid-4242#\d+#[0-9a-f-]{36}$/, `owner 形状要带随机令牌：${a}`)
  // 令牌必须真的随机（不是序号）：100 个里不许有重复。
  const many = Array.from({ length: 100 }, () => claimOwnerOf(1))
  assert.equal(new Set(many).size, 100, '100 个 owner 必须互不相同')
  // 日志用的脱敏串不带令牌（令牌是归属凭据，不该出现在会贴进 issue 的日志里）。
  const short = shortOwner(a)
  assert.match(short, /^pid-4242#\d+$/, `脱敏后只留 pid 与序号：${short}`)
  assert.ok(!short.includes(a.split('#')[2]!), '脱敏串不许包含令牌')
})

// ── 6. 没有跨进程锁 ⇒ fail-closed（P2） ────────────────────────────────────

/** 一个"永远说能力不可用"的锁替身（模拟 `node:sqlite` 缺失的运行时）。 */
function unavailableMutex(): ProcessMutex {
  return {
    file: '/nonexistent/reminders.json.lock.db',
    acquire: async (): Promise<MutexLease> => {
      const error = new Error('本运行时没有 node:sqlite')
      ;(error as { code?: string }).code = 'LOCK_UNAVAILABLE'
      throw error
    },
    tryAcquireOnce: () => false,
    close: () => {},
  }
}

test('C13 锁能力不可用：写入一律 LOCK_UNAVAILABLE（不是超时、更不是无锁写入）', async () => {
  const dir = scratch()
  seed(dir, [row({ id: 'r-nolock', at: T0 - 1_000 })])
  const before = fs.readFileSync(path.join(dir, 'reminders.json'), 'utf8')
  const store = new ReminderStore(
    { enabled: true, dryRun: false, file: null } as never,
    { workspacePath: dir, dshHome: dir, log: () => {} },
    undefined,
    unavailableMutex(),
  )
  try {
    await store.load()
    await assert.rejects(
      async () => { await store.claim('r-nolock', claimOwnerOf(), T0, TTL, { expectedAt: T0 - 1_000, expectedOccurrence: null }) },
      (error: { code?: string }) => error.code === 'LOCK_UNAVAILABLE',
      '抓不到锁必须报 LOCK_UNAVAILABLE（暂时性故障码会让人一直等一个不会来的自愈）',
    )
    // **fail-closed**：盘上一个字都不许动。
    assert.equal(fs.readFileSync(path.join(dir, 'reminders.json'), 'utf8'), before, '无锁状态下不许写盘')
  } finally {
    await store.close()
    cleanup(dir)
  }
})

test('C14 node:sqlite 存在但写不出锁文件：同样报 LOCK_UNAVAILABLE 并拒绝写入', async () => {
  const dir = scratch()
  seed(dir, [row({ id: 'r-badlock', at: T0 - 1_000 })])
  const before = fs.readFileSync(path.join(dir, 'reminders.json'), 'utf8')
  // 把"锁文件路径"指到一个**不可能创建的目录**（父路径是文件而不是目录）。
  const blocker = path.join(dir, 'blocker')
  fs.writeFileSync(blocker, 'x', 'utf8')
  const store = new ReminderStore(
    { enabled: true, dryRun: false, file: null } as never,
    { workspacePath: dir, dshHome: dir, log: () => {} },
    undefined,
    new SqliteProcessMutex(path.join(blocker, 'reminders.json')),
  )
  try {
    await store.load()
    await assert.rejects(
      async () => { await store.add({ text: 'x', at: T0 + 60_000, room: 'dm', target: 10001, createdBy: 10001 }) },
      (error: { code?: string }) => error.code === 'LOCK_UNAVAILABLE',
      '打不开锁文件是"能力不可用"，不是"竞争激烈"',
    )
    assert.equal(fs.readFileSync(path.join(dir, 'reminders.json'), 'utf8'), before, 'fail-closed：盘上不动')
  } finally {
    await store.close()
    cleanup(dir)
  }
})
