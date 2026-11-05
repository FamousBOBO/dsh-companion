import { expectOk, expectRejected } from './fakes/reminders.js'
import { test } from 'node:test'
import { storeFault } from '../src/features/reminders/store-contract.js'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { QQChannelConfig } from '../src/config.js'
import { ReminderStore } from '../src/features/reminders/store.js'
import { decodeReminderFile } from '../src/features/reminders/store-load.js'
import { baseConfig, tempHome } from './fakes/contact.js'

// **task-65（第十一轮复审）**：六件**不依赖写入路径重设计**的事。
//
// 复审的核心判据：**不是再加 guard 调用，而是让"保存失败 + 回滚 + 其他操作已成功"装配后仍成立**。
// 本轮只做能独立收敛的六件；`guardedWrite` 的串行化/回滚语义**刻意不动**，等 Codex 的设计。

const OWNER = 10001
const base = baseConfig({ admins: [OWNER] }) as unknown as QQChannelConfig

const newStore = (dir: string): ReminderStore => new ReminderStore(
  { ...base.reminders, dryRun: false, file: null },
  { workspacePath: dir, dshHome: dir, log: () => {} },
)

const oneShot = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'r_one', text: '一次性', at: Date.now() + 3600_000, room: 'dm', target: OWNER,
  createdBy: OWNER, created: Date.now(), fired: false, firedAt: null, repeat: 'none', ...over,
})

const lockStore = (dir: string, items: unknown[]): ReminderStore => {
  const file = path.join(dir, 'reminders.json')
  fs.writeFileSync(file, `${JSON.stringify({ version: 1, reminders: items }, null, 2)}\n`, 'utf8')
  fs.writeFileSync(`${file}.readonly.json`,
    `${JSON.stringify({ at: Date.now(), reason: 'unreadable', source: file, detail: '上次故障' })}\n`, 'utf8')
  return newStore(dir)
}

const withTemp = async (name: string, run: (dir: string) => Promise<void>): Promise<void> => {
  const home = tempHome(name)
  try {
    await run(home.dir)
  } finally {
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
}

// ── 1. markFired / markUnknown 的快照时机 ──────────────────────────────────

test('R12-1 `markFired` 落盘失败 ⇒ 内存**逐字节**回到改前（快照取改前）', async () => {
  await withTemp('qq-r12-fired-', async (dir) => {
    const store = newStore(dir)
    await store.load()
    const item = expectOk(await store.add({ text: '吃药', at: Date.now() + 60_000, room: 'dm', target: OWNER, createdBy: OWNER }))
    const before = JSON.stringify(store.list(10)[0])
    ;(store as unknown as { io: { replaceSerialized: (b: string) => Promise<{ kind: 'committed' }> } }).io.replaceSerialized = async () => { throw storeFault('PERSIST_FAILED', 'write', 'disk full') }
    await assert.rejects(store.markFired(item.id), /disk full/, '没落盘就不许报成功（必须 reject）')
    assert.equal(JSON.stringify(store.list(10)[0]), before, '**快照必须取改前**，否则回滚等于没回滚')
  })
})

test('R12-2 `markUnknown` 落盘失败 ⇒ `unknownAt/Reason` 都不许留在内存里', async () => {
  await withTemp('qq-r12-unknown-', async (dir) => {
    const store = newStore(dir)
    await store.load()
    const item = expectOk(await store.add({ text: '吃药', at: Date.now() + 60_000, room: 'dm', target: OWNER, createdBy: OWNER }))
    const before = JSON.stringify(store.list(10)[0])
    ;(store as unknown as { io: { replaceSerialized: (b: string) => Promise<{ kind: 'committed' }> } }).io.replaceSerialized = async () => { throw storeFault('PERSIST_FAILED', 'write', 'disk full') }
    await assert.rejects(store.markUnknown(item.id, '平台抛错'), /disk full/, '没落盘就不许报成功（必须 reject）')
    const after = store.list(10)[0]
    assert.equal(JSON.stringify(after), before, '内存逐字节回到改前')
    assert.equal(after?.unknownAt ?? null, null, 'unknownAt 不许留下')
  })
})

// ── 2. load() 用 shapeOf：坏结构锁住、不变空表 ──────────────────────────────

test('R12-3 `load()` 遇到"合法 JSON 但结构不对"⇒ **锁定**、内存空、原文件不动', async () => {
  await withTemp('qq-r12-load-', async (dir) => {
    const file = path.join(dir, 'reminders.json')
    for (const bad of ['{}', '{"reminders":"x"}', '{"reminders":[{}]}']) {
      fs.writeFileSync(file, bad, 'utf8')
      fs.rmSync(`${file}.readonly.json`, { force: true })
      const store = newStore(dir)
      await store.load()
      assert.equal(store.isReadLocked(), true, `结构不对（${bad}）必须锁定，不许当空表`)
      assert.equal(store.readFailure()?.reason, 'unreadable')
      // 源码措辞是「结构不合法：<path> <message>」；判据是「要说明是结构问题」，不钉死具体字。
      assert.match(store.readFailure()?.detail ?? '', /结构(不对|不合法)/, '要说明是结构问题')
      assert.equal(fs.readFileSync(file, 'utf8'), bad, '原文件必须原样（没被覆盖）')
      // 而且写入被拒：不会把原文件冲掉。
      await assert.rejects(
        () => store.add({ text: 'x', at: Date.now() + 1000, room: 'dm', target: OWNER, createdBy: OWNER }),
        // 源码的 READ_LOCKED 文案是「提醒存储处于只读锁定（…）」；判据是「写入被拒」，不钉死措辞。
        /只读锁定|锁定写入|读不出来/,
      )
      assert.equal(fs.readFileSync(file, 'utf8'), bad, '写被拒之后原文件仍然原样')
      // A 类：同一文件只允许一个活跃 Store ⇒ 循环里每轮都要关掉上一个再建下一个。
      await store.close()
    }
  })
})

// ── 3. clearReadLock 的行级校验 ────────────────────────────────────────────

test('R12-4 `clearReadLock()` 拒绝 `{"reminders":[{}]}`（行级不合格 ⇒ 不解锁）', async () => {
  await withTemp('qq-r12-rows-', async (dir) => {
    const file = path.join(dir, 'reminders.json')
    fs.writeFileSync(file, '{ 坏', 'utf8')
    const store = newStore(dir)
    await store.load()
    assert.equal(store.isReadLocked(), true)

    for (const bad of ['{"reminders":[{}]}', '{"reminders":[{"id":"r_x"}]}', '{"reminders":[{"at":1}]}']) {
      fs.writeFileSync(file, bad, 'utf8')
      // **task-66**：行级不合格 ⇒ 抛 `RECOVERY_INVALID`（不再回 ok:false）。
      await assert.rejects(store.clearReadLock(), /RECOVERY_INVALID/, `行级不合格（${bad}）不许恢复成功`)
      assert.equal(store.isReadLocked(), true, '必须保持锁定')
    }
    // 合格的一行才放行。
    fs.writeFileSync(file, `${JSON.stringify({ version: 1, reminders: [oneShot({ id: 'r_ok' })] })}\n`, 'utf8')
    const recovered = await store.clearReadLock()
    assert.equal(recovered.loaded, 1, '合格 ⇒ 报告 loaded=1')
    assert.deepEqual(recovered.added.map((r) => r.id), ['r_ok'])
    assert.equal(store.list(10)[0]?.id, 'r_ok')
  })
})

// ── 4. expireStale / capBacklog：失败与空值可区分 ──────────────────────────

test('R12-5 `expireStale()`/`capBacklog()` 失败回 `ok:false`，哨兵行仍在', async () => {
  await withTemp('qq-r12-catchup-', async (dir) => {
    const now = Date.now()
    const stale = now - 30 * 24 * 3600_000
    const store = newStore(dir)
    fs.writeFileSync(path.join(dir, 'reminders.json'), `${JSON.stringify({
      version: 1,
      reminders: [
        oneShot({ id: 'r_stale', at: stale }),
        ...Array.from({ length: 25 }, (_, i) => oneShot({ id: `r_${String(i)}`, at: now - 1000 + i })),
      ],
    })}\n`, 'utf8')
    await store.load()
    ;(store as unknown as { io: { replaceSerialized: (b: string) => Promise<{ kind: 'committed' }> } }).io.replaceSerialized = async () => { throw storeFault('PERSIST_FAILED', 'write', 'disk full') }

    // **task-66**：写失败 ⇒ reject（不再回 ok:false + 空数组）；内存一条都不许少。
    await assert.rejects(store.expireStale(), /disk full/, '保存失败必须 reject，不许冒充"没有过期的"')
    assert.equal(store.list(100).length, 26, '一条都不许少')

    await assert.rejects(store.capBacklog(), /disk full/, '保存失败必须 reject')
    assert.equal(store.list(100).length, 26, '一条都不许少')

    // 正常路径仍要能区分"真的有"与"真的没有"。
    // A 类：同一文件只允许一个活跃 Store ⇒ 建第二个实例前**必须 await 关掉旧的**（设计 §5）；
    // 关旧之后**必须重新 load()**，否则"关了但没读"是假绿。
    await store.close()
    const fresh = newStore(dir)
    fs.writeFileSync(path.join(dir, 'reminders.json'), `${JSON.stringify({ version: 1, reminders: [] })}\n`, 'utf8')
    await fresh.load()
    const empty = expectOk(await fresh.expireStale())
    assert.deepEqual(empty, [], '没有过期的 = 成功 + 空清单（不是失败）')
  })
})

// ── 6. `qq_remind_cancel` 的"写入被拒" vs "没找到" ─────────────────────────

test('R12-6 `qq_remind_cancel` 锁定时说"没有执行"，不是"没找到"', async () => {
  await withTemp('qq-r12-cancel-', async (dir) => {
    const file = path.join(dir, 'reminders.json')
    const store = lockStore(dir, [oneShot({ id: 'r_keep' })])
    await store.load()
    assert.equal(store.isReadLocked(), true)
    const { registerReminderTools } = await import('../src/features/reminders/tools.js')
    const specs: Array<{ name: string; execute(args: unknown): Promise<Record<string, unknown>> }> = []
    const cfg = { ...base, primaryGroup: 1000000003, reminders: { enabled: true, dryRun: false, file: null } } as QQChannelConfig
    registerReminderTools(
      { tools: { register: (definition: unknown) => { specs.push(definition as never); return () => {} } } } as never,
      cfg, {} as never, {} as never, () => {}, store,
    )
    const call = async (name: string, args: Record<string, unknown>) => {
      const spec = specs.find((item) => item.name === name)
      assert.notEqual(spec, undefined)
      return await spec!.execute(args)
    }
    const locked = await call('qq_remind_cancel', { id: 'r_keep' })
    assert.equal(locked.ok, false)
    assert.match(String(locked.error), /锁定写入|没有执行/, '锁定时要说"没有执行"')
    // 解锁后：不存在的 id 才是"没找到"。
    fs.writeFileSync(file, `${JSON.stringify({ version: 1, reminders: [oneShot({ id: 'r_keep' })] })}\n`, 'utf8')
    const recovered = await store.clearReadLock()
    assert.equal(recovered.loaded, 1, '解锁后读到那一条')
    const missing = await call('qq_remind_cancel', { id: 'r_nope' })
    assert.equal(missing.ok, false)
    assert.match(String(missing.note), /没找到/, '正常态下不存在的 id 仍然报"没找到"')
  })
})

// ── 3 的单元口径 ───────────────────────────────────────────────────────────

test('R12-7 `decodeReminderFile` 行级判定：缺 id / 缺 at / 元素非对象都不合格', () => {
  const good = oneShot({ id: 'r_ok' })
  assert.equal(decodeReminderFile([]).ok, true, '空数组合格')
  assert.equal(decodeReminderFile([good]).ok, true, '完整行合格')
  assert.equal(decodeReminderFile([{}]).ok, false, '空对象不合格')
  assert.equal(decodeReminderFile([{ id: 'r' }]).ok, false, '缺 at 不合格')
  assert.equal(decodeReminderFile([{ at: 1 }]).ok, false, '缺 id 不合格')
  assert.equal(decodeReminderFile([null]).ok, false, '元素非对象不合格')
  assert.equal(decodeReminderFile({ reminders: [{ ...good, id: '' }] }).ok, false, '空 id 也不合格')
  // **task-66（第十一轮 P1）**：`issues` 必须指出**具体哪一行哪个字段**，不能只回 ok:false。
  const bad = decodeReminderFile([{ id: 'r' }])
  assert.equal(bad.ok, false)
  if (!bad.ok) assert.match(bad.issues[0]?.path ?? '', /reminders\[0\]\./, '要能定位到具体行与字段')
})
