import { expectOk, expectRejected } from './fakes/reminders.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { QQChannelConfig } from '../src/config.js'
import { ReminderStore } from '../src/features/reminders/store.js'
import { resourceListOf } from '../src/features/reminders/index.js'
import { baseConfig, tempHome } from './fakes/contact.js'

// **第十轮**：把存储保护收到**底层唯一出口**。复审给了三个已复现反例 + 一个假成功：
//
//   反例 1 双读竞态：`diagnoseRead()` 读一次、`JsonStore.load()` 再读一次，第二次异常被吞成 null ⇒ 锁没闩上
//   反例 2 rebound 绕锁：`markFiredRebound()` 直接 `store.save()`，不过门闩
//   反例 3 解锁不重载：`clearReadLock()` 只解锁，内存还是空表 ⇒ 下次保存覆盖人工修好的内容
//   假成功：读锁拒写**不抛**，`add()` 仍返回提醒、工具仍回 `ok:true` ⇒ 重启后消失
//
// 这里的每条断言都对应其中一个。

const OWNER = 10001

const base = baseConfig({ admins: [OWNER] }) as unknown as QQChannelConfig

const newStore = (dir: string, dryRun = false): ReminderStore => new ReminderStore(
  { ...base.reminders, dryRun, file: null },
  { workspacePath: dir, dshHome: dir, log: () => {} },
)

const countWrites = async (): Promise<{ get: () => number, stop: () => void }> => {
  const { promises: fsp } = await import('node:fs')
  const original = fsp.rename
  let n = 0
  fsp.rename = async (...args: Parameters<typeof fsp.rename>) => { n += 1; return await original(...args) }
  return { get: () => n, stop: () => { fsp.rename = original } }
}

// ── R10-1 反例 1：**只读一次**（不许"第一次成功、第二次失败被吞"） ──────────

test('R10-1 读失败分类只依赖**一次**读取：坏 JSON 时锁必须闩上；不存在时不闩', async () => {
  const home = tempHome('qq-r10-single-')
  try {
    const file = path.join(home.dir, 'reminders.json')
    fs.writeFileSync(file, '{ 半截', 'utf8')
    // **task-64 加强**：不只是"最后没漏闩"——还要**真的数一遍读取次数**。
    // 主文件只许被读 **1** 次（旧实现是 diagnoseRead 一次 + JsonStore.load 再一次）。
    const { promises: fsp } = await import("node:fs")
    const originalRead = fsp.readFile
    let mainReads = 0
    fsp.readFile = (async (target: unknown, ...rest: unknown[]) => {
      if (String(target).includes('reminders.json') && !String(target).includes('readonly')) mainReads += 1
      return await (originalRead as (...args: unknown[]) => Promise<unknown>)(target, ...rest)
    }) as typeof fsp.readFile
    const store = newStore(home.dir)
    try {
      await store.load()
    } finally {
      fsp.readFile = originalRead
    }
    assert.equal(store.isReadLocked(), true, '坏 JSON ⇒ 必须闩住（旧实现第二次读吞错会漏闩）')
    assert.equal(store.readFailure()?.reason, 'unreadable')
    assert.equal(mainReads, 1, `主文件必须只读 1 次（实际 ${String(mainReads)} 次）`)

    const fresh = tempHome('qq-r10-single-ok-')
    try {
      const ok = newStore(fresh.dir)
      await ok.load()
      assert.equal(ok.isReadLocked(), false, '文件不存在 = 新装，不闩')
    } finally {
      fs.rmSync(fresh.dir, { recursive: true, force: true })
    }
  } finally {
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})

// ── R10-2 反例 2：rebound 也必须过门闩 ─────────────────────────────────────

test('R10-2 读锁生效时 `markFiredRebound()` 返回 false 且**一次都不落盘**（旧实现会写）', async () => {
  const home = tempHome('qq-r10-rebound-')
  const counter = await countWrites()
  try {
    const file = path.join(home.dir, 'reminders.json')
    // **复现复审的反例**：文件本身**可读**（内存里有数据），但 sidecar 在 ⇒ 锁生效。
    // 这时对一个**真实存在**的周期提醒调 rebound，旧实现会直接 `store.save()` 绕过去。
    const daily = {
      id: 'r_daily', text: '每天吃药', at: Date.now() - 60_000, room: 'dm', target: OWNER,
      createdBy: OWNER, created: Date.now() - 3600_000, fired: false, firedAt: null, repeat: 'daily',
      occurrence: { id: 'occ-1', revision: 1 },
    }
    fs.writeFileSync(file, `${JSON.stringify({ version: 1, reminders: [daily] }, null, 2)}\n`, 'utf8')
    fs.writeFileSync(`${file}.readonly.json`, `${JSON.stringify({ at: Date.now(), reason: 'unreadable', source: file, detail: '上次故障' })}\n`, 'utf8')

    const store = newStore(home.dir)
    await store.load()
    assert.equal(store.isReadLocked(), true, 'sidecar 在 ⇒ 锁生效')
    assert.equal(store.list(10).length, 1, '内存里确实有那条周期提醒（这才是能绕锁的前提）')

    // **task-64 加强**：rename 计数不能证明"没改内存"——再比一次完整对象，并盯住写端口。
    const before = JSON.stringify(store.list(10)[0])
    // **task-66**：写端口是 `ReminderFile.replaceSerialized`（老的 `save()` 已删）。
    const ioPort = (store as unknown as { io: { replaceSerialized: (bytes: string) => Promise<unknown> } }).io
    const originalWrite = ioPort.replaceSerialized
    let writeCalls = 0
    ioPort.replaceSerialized = async (bytes: string) => { writeCalls += 1; return await originalWrite.call(ioPort, bytes) }
    try {
      // **task-66**：锁定是**基础设施故障**⇒ reject `READ_LOCKED`（不再"返回 false"）。
      await assert.rejects(
        async () => { await store.markFiredRebound('r_daily', { id: 'occ-2', revision: 2 }) },
        /READ_LOCKED|只读锁定/,
        '锁着时必须 reject（不是返回 false）',
      )
    } finally {
      ioPort.replaceSerialized = originalWrite
    }
    assert.equal(counter.get(), 0, '锁着时一次落盘都不许发生（旧实现这里有 1 次）')
    assert.equal(writeCalls, 0, '唯一写出口 `ReminderFile.replaceSerialized()` 也不许被调')
    assert.equal(JSON.stringify(store.list(10)[0]), before, '内存对象必须**逐字节**不变')
    const disk = JSON.parse(fs.readFileSync(file, 'utf8')) as { reminders: Array<{ at: number }> }
    assert.equal(disk.reminders[0]?.at, daily.at, '盘上那条的 at 也必须原样（没被推进）')
  } finally {
    counter.stop()
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})

// ── R10-3 假成功：拒写要在**改内存之前** ────────────────────────────────────

test('R10-3 读锁生效时 `add()` 必须**抛错**（不许返回一条"重启后就没了"的提醒）', async () => {
  const home = tempHome('qq-r10-fake-')
  try {
    const file = path.join(home.dir, 'reminders.json')
    fs.writeFileSync(file, '{ 坏', 'utf8')
    const store = newStore(home.dir)
    await store.load()
    await assert.rejects(
      () => store.add({ text: '吃药', at: Date.now() + 1000, room: 'dm', target: OWNER, createdBy: OWNER }),
      /只读锁定|锁定写入|读不出来/,
      '必须抛错（工具据此回 ok:false），不许假成功',
    )
    assert.deepEqual(store.list(10), [], '内存里也不许留下这条（拒绝发生在改内存之前）')
    // `remove` 同理：锁着时**抛** `READ_LOCKED`（不是"返回 false"）。
    await assert.rejects(() => store.remove('whatever'), /只读锁定|READ_LOCKED/)
  } finally {
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})

// ── R10-4 反例 3：解锁必须**重载**并保留人工修复的非空数据 ─────────────────

test('R10-4 `clearReadLock()` 会重读盘：预置的非空哨兵必须还在（旧实现会覆盖成空表）', async () => {
  const home = tempHome('qq-r10-recover-')
  try {
    const file = path.join(home.dir, 'reminders.json')
    fs.writeFileSync(file, '{ 坏', 'utf8')
    const store = newStore(home.dir)
    await store.load()
    assert.equal(store.isReadLocked(), true)

    // 人工修好文件，预置一条**非空**哨兵。
    const sentinel = {
      id: 'r_sentinel', text: '人工修好的那条', at: Date.now() + 3600_000, room: 'dm', target: OWNER,
      createdBy: OWNER, created: Date.now(), fired: false, firedAt: null, repeat: 'none',
    }
    fs.writeFileSync(file, `${JSON.stringify({ version: 1, reminders: [sentinel] }, null, 2)}\n`, 'utf8')

    // **task-66**：返回**完整恢复报告**（不是 boolean）。
    const recovered = await store.clearReadLock()
    assert.equal(recovered.loaded, 1, '解锁后应当读到那一条')
    assert.deepEqual(recovered.removed.map((row) => row.id), [], '没有行消失')
    assert.deepEqual(recovered.added.map((row) => row.id), ['r_sentinel'], '盘上的哨兵属于新增')
    assert.equal(store.isReadLocked(), false)
    assert.equal(store.readFailure(), null)
    assert.equal(store.list(10).length, 1, '**必须把盘上的数据读回内存**')
    assert.equal(store.list(10)[0]?.id, 'r_sentinel', '哨兵还在')

    // 解锁后保存：盘上仍然是那条哨兵，不被空表覆盖。
    const disk = JSON.parse(fs.readFileSync(file, 'utf8')) as { reminders: Array<{ id: string }> }
    assert.deepEqual(disk.reminders.map((r) => r.id), ['r_sentinel'], '保存不许把哨兵冲掉')

    // 文件仍坏时解锁必须**拒绝**，且锁不动。
    // 注意：此刻 store 已经**解锁**了，而未锁定的 store 调 `clearReadLock()` 会先抛「当前没有锁定，无需恢复」，
    // 压根读不到文件 —— 那测的不是这条本意。所以先让它**真的锁上**：`load()` 幂等 ⇒ 只有新实例会重读，
    // 同一文件只允许一个活跃 Store ⇒ 先关旧的。
    await store.close()
    fs.writeFileSync(file, '{ 还是坏', 'utf8')
    const relocked = newStore(home.dir)
    await relocked.load()
    assert.equal(relocked.isReadLocked(), true, '前提：坏文件 ⇒ 锁定')
    // **task-66**：文件仍坏 ⇒ 恢复**reject** `RECOVERY_READ_FAILED`/`RECOVERY_INVALID`（不是回 false）。
    await assert.rejects(() => relocked.clearReadLock(), /RECOVERY_READ_FAILED|RECOVERY_INVALID/)
    assert.equal(relocked.isReadLocked(), true, '拒绝恢复后必须仍然锁定')
    await relocked.close()
  } finally {
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})

// ── R10-5 sidecar 真的被读回来（注释与实现一致） ───────────────────────────

test('R10-5 sidecar 存在时**新实例也必须锁定**（以前只写注释、实现没读）', async () => {
  const home = tempHome('qq-r10-sidecar-')
  try {
    const file = path.join(home.dir, 'reminders.json')
    // 文件本身**可读**，但 sidecar 在（说明上次读失败没人确认处理过）。
    fs.writeFileSync(file, `${JSON.stringify({ version: 1, reminders: [] })}\n`, 'utf8')
    fs.writeFileSync(`${file}.readonly.json`, `${JSON.stringify({ at: Date.now(), reason: 'unreadable', source: file, detail: '上次的故障' })}\n`, 'utf8')
    const store = newStore(home.dir)
    await store.load()
    assert.equal(store.isReadLocked(), true, 'sidecar 在 ⇒ 继续闩住（直到显式 clearReadLock）')
    assert.equal(store.readFailure()?.detail, '上次的故障', '故障状态要能从 sidecar 读回来')
    // 清锁后 sidecar 消失，再新建实例就不锁了。
    assert.equal((await store.clearReadLock()).loaded, 0)
    assert.equal(fs.existsSync(`${file}.readonly.json`), false, '解锁要删 sidecar')
    // A 类：同一文件只允许一个活跃 Store ⇒ 建第二个实例前**必须 await 关掉旧的**（设计 §5）。
    await store.close()
    const again = newStore(home.dir)
    await again.load()
    assert.equal(again.isReadLocked(), false, '没有 sidecar 就不锁')
  } finally {
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})

// ── R10-6 资源面 count 与 readLock 一致（round9 的守卫，防回退） ─────────────

test('R10-6 读锁生效时资源面 `count===null`；正常时是数字', async () => {
  const home = tempHome('qq-r10-res-')
  try {
    const file = path.join(home.dir, 'reminders.json')
    fs.writeFileSync(file, '{ 坏', 'utf8')
    const store = newStore(home.dir)
    await store.load()
    const locked = resourceListOf(store)()
    assert.equal(locked.count, null)
    assert.ok(locked.readLock !== null)

    fs.writeFileSync(file, `${JSON.stringify({ version: 1, reminders: [] })}\n`, 'utf8')
    // 盘上是空表 `reminders: []` ⇒ 读到 0 条是对的（这条测的正是「正常时 0 就是 0」）。
    assert.equal((await store.clearReadLock()).loaded, 0)
    const ok = resourceListOf(store)()
    assert.equal(ok.count, 0, '正常时 0 就是 0（真·没有提醒）')
    assert.equal(ok.readLock, null)
  } finally {
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})
