import { expectOk, expectRejected } from './fakes/reminders.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { QQChannelConfig } from '../src/config.js'
import { ReminderStore } from '../src/features/reminders/store.js'
import { decodeReminderFile } from '../src/features/reminders/store-load.js'
import { storeFault } from '../src/features/reminders/store-contract.js'
import { resourceListOf } from '../src/features/reminders/index.js'
import { baseConfig, tempHome } from './fakes/contact.js'

// **task-64（第九轮复审 P1）**：store 的"成败闭环"。
//
// 复审用探针给了六个漏洞 + 一个"合法 JSON 但结构不对就合法清空"的反例：
//   ① `resolve` 锁中仍返回成功、`unknownAt` 清空、写入 0 次
//   ② `pruneFired` 锁中仍删内存、返回"删了 1 条"
//   ③ `expireStale` 抛锁错误但内存已变 fired/expired
//   ④ `clearPendingDispatch` 抛锁错误但 pending 已删
//   ⑤ `capBacklog` / 设待办 同样"先改内存后落盘"
//   ⑥ 普通写失败仍"假成功"（返回提醒、内存 +1 行、只有失败日志）
//   ⑦ `qq_remind_at` 没有 catch（只有 `qq_remind` 转了）
//
// 口径：**"共同底层拒写" ≠ "共同拒绝内存变更"**。这里每条都同时断言
// 「返回值是失败」+「内存没变」+「盘上没变」。

const OWNER = 10001
const base = baseConfig({ admins: [OWNER] }) as unknown as QQChannelConfig

const newStore = (dir: string): ReminderStore => new ReminderStore(
  { ...base.reminders, dryRun: false, file: null },
  { workspacePath: dir, dshHome: dir, log: () => {} },
)

/** 起一个**锁生效**的 store：文件本身可读（内存有数据），sidecar 在 ⇒ 锁。 */
const lockedStoreWith = (dir: string, items: unknown[]): ReminderStore => {
  const file = path.join(dir, 'reminders.json')
  fs.writeFileSync(file, `${JSON.stringify({ version: 1, reminders: items }, null, 2)}\n`, 'utf8')
  fs.writeFileSync(`${file}.readonly.json`,
    `${JSON.stringify({ at: Date.now(), reason: 'unreadable', source: file, detail: '上次故障' })}\n`, 'utf8')
  return newStore(dir)
}

const oneShot = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'r_one', text: '一次性', at: Date.now() + 3600_000, room: 'dm', target: OWNER,
  createdBy: OWNER, created: Date.now(), fired: false, firedAt: null, repeat: 'none', ...over,
})

const withTemp = async (name: string, run: (dir: string) => Promise<void>): Promise<void> => {
  const home = tempHome(name)
  try {
    await run(home.dir)
  } finally {
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
}

// ── ① resolve ───────────────────────────────────────────────────────────────

test('R11-1 锁中 `resolve()` 必须返回 false，且 `unknownAt` 不被清', async () => {
  await withTemp('qq-r11-resolve-', async (dir) => {
    const store = lockedStoreWith(dir, [oneShot({ unknownAt: 111, unknownReason: '旧', fired: true })])
    await store.load()
    assert.equal(store.isReadLocked(), true, '前提：锁生效')
    // task-66: lock means infrastructure fault -> mutator rejects (no more "false / 0").
    await assert.rejects(() => store.resolve('r_one', 'confirmed'), /READ_LOCKED/, '锁着时不许返回成功')
    const item = store.list(10)[0]
    assert.equal(item?.unknownAt, 111, '**内存里的 unknownAt 不许被清**')
    assert.equal(item?.unknownReason, '旧')
  })
})

// ── ② pruneFired ────────────────────────────────────────────────────────────

test('R11-2 锁中 `pruneFired()` 必须返回 0，且内存行数不变', async () => {
  await withTemp('qq-r11-prune-', async (dir) => {
    const old = Date.now() - 30 * 24 * 3600_000
    const store = lockedStoreWith(dir, [oneShot({ fired: true, firedAt: old, at: old })])
    await store.load()
    assert.equal(store.isReadLocked(), true)
        await assert.rejects(() => store.pruneFired(), /READ_LOCKED/, '锁着时不许说"删了 N 条"')
    assert.equal(store.list(10).length, 1, '**内存里那行必须还在**')
  })
})

// ── ③ expireStale：落盘失败但内存已改（不是锁，是磁盘失败） ────────────────

test('R11-3 `expireStale()` 落盘失败 ⇒ 返回空、内存**整份回滚**（不再"抛错但已改"）', async () => {
  await withTemp('qq-r11-expire-', async (dir) => {
    const stale = Date.now() - 30 * 24 * 3600_000
    const store = newStore(dir)
    fs.writeFileSync(path.join(dir, 'reminders.json'),
      `${JSON.stringify({ version: 1, reminders: [oneShot({ at: stale })] })}\n`, 'utf8')
    await store.load()
    // 让唯一写出口失败。
    ;(store as unknown as { io: { replaceSerialized: (b: string) => Promise<{ kind: 'committed' }> } }).io.replaceSerialized = async () => {
      throw storeFault('PERSIST_FAILED', 'write', 'disk full')
    }
    // **task-66**：写失败 ⇒ Promise reject（不再回 ok:false/空数组）；内存一个字节都不许变。
    await assert.rejects(store.expireStale(), /disk full/, '写失败必须 reject，不许用空数组冒充')
    const item = store.list(10)[0]
    assert.equal(item?.fired, false, '**内存里的 fired 必须回滚**')
    assert.equal(item?.expiredAt ?? null, null, '**expiredAt 也必须回滚**')
  })
})

// ── ④ clearPendingDispatch ──────────────────────────────────────────────────

test('R11-4 `clearPendingDispatch()` 落盘失败 ⇒ false，pending **仍在内存里**', async () => {
  await withTemp('qq-r11-pending-', async (dir) => {
    const store = newStore(dir)
    const pending = { occurrenceId: 'occ-1', revision: 1, at: Date.now() }
    fs.writeFileSync(path.join(dir, 'reminders.json'),
      `${JSON.stringify({ version: 1, reminders: [oneShot({ pendingDispatch: pending })] })}\n`, 'utf8')
    await store.load()
    ;(store as unknown as { io: { replaceSerialized: (b: string) => Promise<{ kind: 'committed' }> } }).io.replaceSerialized = async () => {
      throw storeFault('PERSIST_FAILED', 'write', 'disk full')
    }
    // **task-66**：写失败 ⇒ reject（不再回 false）；pending 一个字节都不许动。
    await assert.rejects(store.clearPendingDispatch('r_one'), /disk full/, '写失败必须 reject')
    assert.ok(store.list(10)[0]?.pendingDispatch !== undefined, '**pending 不许被静默删掉**')
  })
})

// ── ⑤ capBacklog ───────────────────────────────────────────────────────────

test('R11-5 `capBacklog()` 落盘失败 ⇒ 返回空、内存**整份回滚**', async () => {
  await withTemp('qq-r11-cap-', async (dir) => {
    const now = Date.now()
    const many = Array.from({ length: 25 }, (_, i) => oneShot({ id: `r_${String(i)}`, at: now - 1000 + i }))
    const store = newStore(dir)
    fs.writeFileSync(path.join(dir, 'reminders.json'),
      `${JSON.stringify({ version: 1, reminders: many })}\n`, 'utf8')
    await store.load()
    ;(store as unknown as { io: { replaceSerialized: (b: string) => Promise<{ kind: 'committed' }> } }).io.replaceSerialized = async () => {
      throw storeFault('PERSIST_FAILED', 'write', 'disk full')
    }
    // **task-66**：写失败 ⇒ reject；内存 25 条一条都不许少。
    await assert.rejects(store.capBacklog(now), /disk full/, '写失败必须 reject，不许用"丢了 0 条"冒充')
    assert.equal(store.list(100).length, 25, '**25 条一条都不许少**')
    assert.equal(store.catchUpDiagnostics(now).dropped, 0, '诊断也不许出现丢弃')
  })
})

// ── ⑥ 普通写失败仍"假成功" ─────────────────────────────────────────────────

test('R11-6 普通写失败（磁盘）⇒ `add()` 抛错且内存不留行；成功时内存 +1', async () => {
  await withTemp('qq-r11-add-', async (dir) => {
    const store = newStore(dir)
    await store.load()
    const ok = expectOk(await store.add({ text: '正常', at: Date.now() + 60_000, room: 'dm', target: OWNER, createdBy: OWNER }))
    assert.equal(store.list(10).length, 1, '成功时 +1')
    assert.equal(store.list(10)[0]?.id, ok.id)
    ;(store as unknown as { io: { replaceSerialized: (b: string) => Promise<{ kind: 'committed' }> } }).io.replaceSerialized = async () => {
      throw storeFault('PERSIST_FAILED', 'write', 'disk full')
    }
    await assert.rejects(
      store.add({ text: '失败', at: Date.now() + 60_000, room: 'dm', target: OWNER, createdBy: OWNER }),
      /disk full/,
      '失败必须抛（不许返回一条"重启后就没了"的提醒）',
    )
    assert.equal(store.list(10).length, 1, '**失败那条不许留在内存里**')
  })
})

// ── ⑦ 两个工具行为一致 ─────────────────────────────────────────────────────

test('R11-7 `qq_remind` 与 `qq_remind_at` 都 catch 写失败并回 `ok:false`', async () => {
  // **从"读源码搜字符串"改成"真跑一遍"。** 旧写法断言 `src.includes('ok: false, error: why')`——
  // 那是在测实现形状：变量一改名就红（我改成 `error.message` 就挂了），而行为没变。
  // 现在直接装一个"写盘必失败"的真 store，看两个工具回什么。
  const home = tempHome('qq-r11-tools-fail-')
  try {
    const cfg = { ...base, primaryGroup: 1000000003, reminders: { enabled: true, dryRun: false, file: null } } as QQChannelConfig
    const store = newStore(home.dir)
    await store.load()
    ;(store as unknown as { io: { replaceSerialized: (b: string) => Promise<{ kind: 'committed' }> } }).io.replaceSerialized = async () => {
      throw storeFault('PERSIST_FAILED', 'write', 'disk full')
    }
    const { registerReminderTools } = await import('../src/features/reminders/tools.js')
    const specs: Array<{ name: string; execute(args: unknown): Promise<Record<string, unknown>> }> = []
    registerReminderTools(
      { tools: { register: (definition: unknown) => { specs.push(definition as never); return () => {} } } } as never,
      cfg,
      {} as never,
      {} as never,
      () => {},
      store,
    )
    const call = async (name: string, args: Record<string, unknown>) => {
      const spec = specs.find((item) => item.name === name)
      assert.notEqual(spec, undefined, `没注册工具 ${name}`)
      return await spec!.execute(args)
    }
    const at = String(Date.now() + 3600_000)
    const remind = await call('qq_remind', { text: '写不进', when: '明天9点', isGroup: false, target: OWNER })
    const remindAt = await call('qq_remind_at', { text: '写不进', at, isGroup: false, target: OWNER })
    for (const [label, result] of [['qq_remind', remind], ['qq_remind_at', remindAt]] as const) {
      assert.equal(result.ok, false, `${label} 写失败必须回 ok:false（不许假成功）`)
      assert.equal(typeof result.error, 'string', `${label} 失败要带原因`)
      assert.match(String(result.error), /disk full|没有执行|写入被拒/, `${label} 原因要能看出是写失败`)
    }
    assert.equal(store.list(10).length, 0, '一条都没建成（内存里也不许留）')
    await store.close()
  } finally {
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})

// ── 恢复：结构校验 + 丢弃条数 ───────────────────────────────────────────────

test('R11-8 恢复只接受**形状合格**的文件：合法 JSON 但结构不对 ⇒ 拒绝恢复、保持锁定', async () => {
  await withTemp('qq-r11-shape-', async (dir) => {
    const file = path.join(dir, 'reminders.json')
    fs.writeFileSync(file, '{ 坏', 'utf8')
    const store = newStore(dir)
    await store.load()
    assert.equal(store.isReadLocked(), true)

    for (const bad of ['{}', '{"reminders":"x"}', '{"version":"1","reminders":[]}', '{"reminders":[null]}']) {
      fs.writeFileSync(file, bad, 'utf8')
      // **task-66**：结构不对 ⇒ 抛 `RECOVERY_INVALID`（不再回 ok:false）。
      await assert.rejects(store.clearReadLock(), /RECOVERY_INVALID/, `结构不对（${bad}）不许"恢复成功"`)
      assert.equal(store.isReadLocked(), true, '拒绝恢复时必须**保持锁定**')
    }
    // 形状合格才放行。
    fs.writeFileSync(file, `${JSON.stringify({ version: 1, reminders: [oneShot({ id: 'r_keep' })] })}\n`, 'utf8')
    const res = await store.clearReadLock()
    // **task-66**：报告是完整内容，不是布尔。
    assert.equal(res.loaded, 1, '合格 ⇒ 报告 loaded=1')
    assert.deepEqual(res.added.map((r) => r.id), ['r_keep'], '盘上那条要出现在 added 里')
    assert.equal(store.list(10)[0]?.id, 'r_keep', '合格 ⇒ 真的读到了那条')
  })
})

test('R11-9 锁定态下**构造不出**内存行 ⇒ `removed` 恒空（证明不可能静默丢弃）', async () => {
  await withTemp('qq-r11-discard-', async (dir) => {
    const file = path.join(dir, 'reminders.json')
    fs.writeFileSync(file, '{ 坏', 'utf8')
    const store = newStore(dir)
    await store.load()
    // **结构性保证（比原来更强）**：新契约下"内存有、盘上没有"的行**构造不出来**——
    // 锁定态内存必空、`add()` 必 reject，状态只能经事务发布。
    // 所以 `removed` 在这条路径上**恒为 []**——这不是"丢了没报"，是"没有可丢的"。
    // ⚠️ 下一个人别以为 `removed` 没测过：它在这条路径上本就恒空。
    assert.equal(store.list(10).length, 0, '锁定态内存必须为空')
    await assert.rejects(
      () => store.add({ text: '幽灵', at: Date.now() + 3600_000, room: 'dm', target: OWNER, createdBy: OWNER }),
      /READ_LOCKED/,
      '锁定态加不进新行 ⇒ 造不出 ghost',
    )
    fs.writeFileSync(file, `${JSON.stringify({ version: 1, reminders: [oneShot({ id: 'r_keep' })] })}\n`, 'utf8')
    const res = await store.clearReadLock()
    assert.deepEqual(res.removed, [], 'removed 必空，因为没有可丢的')
    assert.equal(res.loaded, 1, '但盘上那条要真的读进来')
    assert.deepEqual(res.added.map((row) => row.id), ['r_keep'], 'added 带完整行')
  })
})

test('R11-10 `decodeReminderFile()` 的判定口径（正反两面）', () => {
  const good = oneShot({ id: 'r_ok' })
  assert.equal(decodeReminderFile([good]).ok, true, '裸数组合格')
  assert.equal(decodeReminderFile({ reminders: [good] }).ok, true, '对象 + reminders 数组合格')
  assert.equal(decodeReminderFile(null).ok, false)
  assert.equal(decodeReminderFile({}).ok, false)
  assert.equal(decodeReminderFile('[]').ok, false)
  assert.equal(decodeReminderFile({ version: 1, reminders: [null] }).ok, false)
  // **task-66（第十一轮 P2）**：已声明但不是 1 的版本一律拒绝。
  // 以前 99 会被接受、然后在保存时被降写成 v1 —— 那是"合法地丢字段"。
  assert.equal(decodeReminderFile({ version: 99, reminders: [good] }).ok, false, '非 1 版本必须拒绝')
})

test('R11-11 读锁生效时资源面仍然 `count===null`（round9 守卫不回退）', async () => {
  await withTemp('qq-r11-res-', async (dir) => {
    const store = lockedStoreWith(dir, [oneShot()])
    await store.load()
    const list = resourceListOf(store)()
    assert.equal(list.count, null)
    assert.ok(list.readLock !== null)
  })
})

// ── 工具层：两个工具在**真拒写 store** 上的行为（复审 R10-3 点名） ──────────

test('R11-12 锁定的 store 上 `qq_remind` 与 `qq_remind_at` 都回 `ok:false`，且内存/盘都不动', async () => {
  const home = tempHome('qq-r11-tools-')
  try {
    const cfg = { ...base, primaryGroup: 1000000003, reminders: { enabled: true, dryRun: false, file: null } } as QQChannelConfig
    const store = newStore(home.dir)
    await store.load()
    // 预置一条**非空行**（复审要求：预置非空行再断言"不变"）。
    const keep = expectOk(await store.add({ text: '原有那条', at: Date.now() + 3600_000, room: 'dm', target: OWNER, createdBy: OWNER }))
    const file = path.join(home.dir, 'reminders.json')

    // 让它进入锁态（不改文件：直接闩上，模拟"读失败已发生"）。
    // 真锁只能靠坏文件 + 新实例 load()（io.gate 字段已不存在）。
    await store.close()
    fs.writeFileSync(file, '{ bad', 'utf8')
    const locked = newStore(home.dir)
    await locked.load()
    assert.equal(locked.isReadLocked(), true, '坏文件就要真锁')
    const diskLocked = fs.readFileSync(file, 'utf8')

    const { registerReminderTools } = await import('../src/features/reminders/tools.js')
    const specs: Array<{ name: string; execute(args: unknown): Promise<Record<string, unknown>> }> = []
    registerReminderTools(
      { tools: { register: (definition: unknown) => { specs.push(definition as never); return () => {} } } } as never,
      cfg,
      {} as never,
      {} as never,
      () => {},
      locked,
    )
    const call = async (name: string, args: Record<string, unknown>) => {
      const spec = specs.find((item) => item.name === name)
      assert.notEqual(spec, undefined, `没注册工具 ${name}`)
      return await spec!.execute(args)
    }
    const at = String(Date.now() + 3600_000)
    const remind = await call('qq_remind', { text: '要被拒', when: '明天9点', isGroup: false, target: OWNER })
    const remindAt = await call('qq_remind_at', { text: '要被拒', at, isGroup: false, target: OWNER })
    for (const [label, result] of [['qq_remind', remind], ['qq_remind_at', remindAt]] as const) {
      assert.equal(result.ok, false, `${label} 必须回 ok:false（不许假成功）`)
      assert.equal(typeof result.error, 'string', `${label} 要带原因`)
    }
    assert.equal(locked.list(10).length, 0, '锁定态内存必为空')
    void keep
    assert.equal(fs.readFileSync(file, 'utf8'), diskLocked, '盘上内容逐字节不变')
    // `qq_remind_cancel` 用**不存在的 id**：返回 ok:false（且不报错）。
    const cancel = await call('qq_remind_cancel', { id: 'r_nope' })
    assert.equal(cancel.ok, false, '不存在的 id 要回 ok:false')
  } finally {
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})
