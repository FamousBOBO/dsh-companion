/** **round17 / task-4 的守卫**：分层闸门三处修复的行为不变证明 + 停表可观测性。
 *
 * 三块，各自对着一条复审挂账：
 *   1. `check-layers` 三处违规（`store-freeze.ts` / `store.ts` / `store-io.ts`）——
 *      改法必须是"把接口改对/用正确工具"，所以这里钉的是**行为没变**：
 *      深度冻结照旧、`edit()` 的事务契约照旧、sidecar 的**字节**照旧（只是换原子写）；
 *   2. 停表可观测性（round16 §8.7 / §2.2）：`halted` / 停表原因 / 软故障连击从
 *      private 字段进 `ReminderRunner.status()` 与资源表 `runner` 字段。
 *      运维的问题是"这个渠道**停表了**，还是**在空转**"——两档都要看得见；
 *   3. 顺带钉住"空转"那一档：程序错误单次不停表，但**连击数要能读出来**（否则
 *      `halted=false` 与"一切正常"在诊断面上长得一模一样）。
 *
 * 纪律：本文件只用临时 dshHome，**不碰生产 home**、不启宿主、不出网。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { QQChannelConfig } from '../src/config.js'
import { ReminderStore } from '../src/features/reminders/store.js'
import { ReminderRunner } from '../src/features/reminders/runner.js'
import { deepFreeze } from '../src/features/reminders/store-freeze.js'
import { resourceListOf } from '../src/features/reminders/lifecycle.js'
import { remindersPlugin } from '../src/features/reminders/index.js'
import { SOFT_FAULT_LIMIT, SoftFaultTracker, storeFault } from '../src/features/reminders/store-contract.js'
import {
  FakeOutboundQueue, FakePlatform, baseConfig, fakeSubHost, tempHome, waitUntil,
} from './fakes/contact.js'

const OWNER = 10001

const base = baseConfig({ admins: [OWNER] }) as unknown as QQChannelConfig

/** 一个"不演练、一次性"的提醒存储（每个用例一份临时 home）。 */
const newStore = (dir: string): ReminderStore => new ReminderStore(
  { ...base.reminders, enabled: true, dryRun: false, file: null },
  { workspacePath: dir, dshHome: dir, log: () => {} },
)

/** 一条已经到点的一次性提醒（`repeat` 缺省 = `none`）。 */
const dueOneShot = (): Record<string, unknown> => ({
  text: '该睡了', at: Date.now() - 1000, room: 'dm', target: OWNER, createdBy: OWNER,
})

const sleep = async (ms: number): Promise<void> => {
  await new Promise<void>((resolve) => { setTimeout(resolve, ms) })
}

// ── R17-1：深度冻结（`store-freeze.ts` 不再用 `as unknown as`） ────────────

test('R17-1 deepFreeze 仍**深度**冻结：嵌套对象/数组/元素都冻上，且返回同一引用', () => {
  const row = { id: 'r1', nested: { a: 1 }, list: [{ b: 2 }] }
  const frozen = deepFreeze(row)
  assert.equal(frozen, row, '必须返回同一引用（调用方按"就地冻结"用）')
  assert.equal(Object.isFrozen(row), true)
  assert.equal(Object.isFrozen(row.nested), true, '嵌套对象也要冻（只冻顶层等于没冻）')
  assert.equal(Object.isFrozen(row.list), true)
  assert.equal(Object.isFrozen(row.list[0]), true, '数组元素也要冻')
  // 幂等：已经冻过的再来一次不抛。
  assert.equal(deepFreeze(row), row)
  // 基本类型原样返回（以前也是这样：不是对象就直接返回）。
  assert.equal(deepFreeze(1), 1)
  assert.equal(deepFreeze(null), null)
  assert.equal(deepFreeze('x'), 'x')
  // 冻结之后写入必须失败（这是"只读视图"的实测证据，不只是 `Object.isFrozen`）。
  assert.throws(() => { (row as { id: string }).id = 'changed' })
})

// ── R17-2：sidecar 故障标记改原子写，**字节不变** ───────────────────────────

test('R17-2 故障标记走原子写：内容与旧实现逐字节一致、不留临时文件、能被读回', async () => {
  const home = tempHome('qq-r17-marker-')
  try {
    const file = path.join(home.dir, 'reminders.json')
    fs.writeFileSync(file, '{ 半截', 'utf8')
    const store = newStore(home.dir)
    try {
      const report = await store.load()
      assert.equal(report.status, 'locked', '坏 JSON ⇒ 锁定（与原子写无关，但不能被这次改动碰坏）')
      const markerFile = `${file}.readonly.json`
      assert.equal(fs.existsSync(markerFile), true, 'sidecar 必须真的写出来（运维靠它看"上次为什么锁"）')
      const raw = fs.readFileSync(markerFile, 'utf8')
      const parsed = JSON.parse(raw) as { at: number; reason: string; source: string; detail: string }
      // 旧实现是 `JSON.stringify(failure, null, 2) + '\n'`：`atomicWriteJson` 也是这个格式，
      // 这里逐字节比，防"换工具顺手换了格式"。
      assert.equal(raw, `${JSON.stringify(parsed, null, 2)}\n`, 'sidecar 字节必须与旧实现一致')
      assert.equal(parsed.reason, 'unreadable')
      assert.equal(parsed.source, file)
      assert.equal(typeof parsed.at, 'number')
      assert.equal(store.readFailure()?.detail, parsed.detail, '内存里的锁与盘上的 sidecar 要是同一份事实')
    } finally {
      await store.close()
    }
    const leftovers = fs.readdirSync(home.dir).filter((name) => name.includes('.dsh-tmp'))
    assert.deepEqual(leftovers, [], `原子写不许在目录里留临时文件（实际：${leftovers.join(', ')}）`)
  } finally {
    home.cleanup()
  }
})

// ── R17-3：`store.edit()` 去掉 `reducer as never` 之后契约照旧 ──────────────

test('R17-3 事务契约照旧：成功落盘、业务拒绝回 ok:false、坏输入不写盘', async () => {
  const home = tempHome('qq-r17-tx-')
  try {
    const file = path.join(home.dir, 'reminders.json')
    const store = newStore(home.dir)
    try {
      await store.load()
      const added = await store.add(dueOneShot() as never)
      assert.equal(added.ok, true, '正常新增要成功')
      const disk = JSON.parse(fs.readFileSync(file, 'utf8')) as { reminders: Array<{ text: string }> }
      assert.equal(disk.reminders.length, 1, '成功的事务必须已落盘')
      assert.equal(disk.reminders[0]?.text, '该睡了')

      // 业务拒绝：**没改状态、没写盘**，而且不许 reject。
      const missing = await store.resolve('r_nope', 'confirmed')
      assert.equal(missing.ok, false, '没有这条 ⇒ 业务拒绝（不是基础设施故障）')
      if (!missing.ok) assert.equal(missing.code, 'NOT_FOUND')
      // 基础设施故障仍然是 reject（这条是 `Mutation` 契约的底线）。
      await store.close()
      await assert.rejects(() => store.add(dueOneShot() as never), /CLOSED|已关闭/)
    } finally {
      // close() 在 try 里已经 await 过；这里再调一次也安全（队列 close 幂等）。
      await store.close()
    }
  } finally {
    home.cleanup()
  }
})

// ── R17-4：资源表的旧字段不变；没有 runner 时就是 `null` ──────────────────

test('R17-4 资源表：没接 runner ⇒ `runner: null`（旧字段一个都没少）', async () => {
  const home = tempHome('qq-r17-res-')
  try {
    const store = newStore(home.dir)
    try {
      await store.load()
      const snapshot = resourceListOf(store)()
      assert.equal(snapshot.runner, null, '没给取值器时不许编造"在跑"')
      assert.equal(snapshot.honest, 'measured')
      assert.equal(typeof snapshot.count, 'number')
      assert.deepEqual(snapshot.reminders, [])
      assert.equal(snapshot.pendingDispatch.value, 0)
      assert.equal(snapshot.pendingDispatch.overLimit, 0)
      assert.equal(snapshot.readLock, null)
      assert.equal(typeof snapshot.catchUp.windowMs, 'number')
    } finally {
      await store.close()
    }
  } finally {
    home.cleanup()
  }
})

// ── R17-5：`status()` 的停表现场 ──────────────────────────────────────────

test('R17-5 停表之后 `status()` 说得出"停了、为什么停、什么时候停"', async () => {
  const home = tempHome('qq-r17-halt-')
  try {
    const store = newStore(home.dir)
    try {
      await store.load()
      await store.add(dueOneShot() as never)
      // 已投递但记账写不进盘 ⇒ 必须停表（这条语义不许退化，见 round15/16）。
      store.markFired = async () => {
        throw storeFault('PERSIST_FAILED', 'markFired', '桩：模拟记账写不进盘')
      }
      const runner = new ReminderRunner(
        store,
        async () => 'sent',
        () => {},
        () => true,
        async () => null,
        async () => 'ok' as const,
        () => false,
      )
      try {
        // 还没 start：既没排上表、也没停表。
        const before = runner.status()
        assert.equal(before.scheduled, false)
        assert.equal(before.halted, false)
        assert.equal(before.haltReason, null)
        assert.equal(before.haltedAt, null)
        assert.equal(before.softFault.streak, 0)

        runner.start(10)
        assert.equal(runner.status().scheduled, true, 'start() 之后定时器必须挂着（否则诊断面读不出"在跑"）')
        await sleep(150)

        const halted = runner.status()
        assert.equal(halted.halted, true, '记账失败 ⇒ 必须停表')
        assert.equal(halted.scheduled, false, '停表会 dispose 定时器（诊断面要看得出来）')
        assert.match(String(halted.haltReason), /没落盘|记账/, '停表原因要说人话（要看得出是哪条路）')
        assert.equal(typeof halted.haltedAt, 'number', '停表时刻要留下')
        // 资源面拿到的必须是**同一份**现场（同一个方法，不抄第二份字段）。
        const viaResource = resourceListOf(store, () => runner.status())()
        assert.deepEqual(viaResource.runner, halted, '资源表的 `runner` 与直接调 `status()` 必须一致')
      } finally {
        runner.dispose()
      }
    } finally {
      await store.close()
    }
  } finally {
    home.cleanup()
  }
})

// ── R17-6："空转"也要可见：连击数进诊断面 ─────────────────────────────────

test('R17-6 空转可见：程序错误连击进 `status().softFault`（未到阈值时不谎报停表）', async () => {
  const home = tempHome('qq-r17-spin-')
  try {
    const store = newStore(home.dir)
    try {
      await store.load()
      // `takeBatch()` 第一件事就是 expireStale ⇒ 用它制造"每拍都抛、一条都发不出去"。
      store.expireStale = async () => {
        throw storeFault('INVALID_CANDIDATE', 'expireStale', '桩：每拍都抛')
      }
      const runner = new ReminderRunner(
        store,
        async () => 'sent',
        () => {},
        () => true,
        async () => null,
        async () => 'ok' as const,
        () => false,
      )
      try {
        runner.start(5)
        await sleep(120)
        const snapshot = runner.status()
        assert.ok(snapshot.softFault.streak >= 2, `连击数必须能读出来（实际 ${String(snapshot.softFault.streak)}）`)
        assert.equal(snapshot.softFault.code, 'INVALID_CANDIDATE', '连击的是**哪一类**错误也要看得见')
        assert.equal(snapshot.softFault.limit, SOFT_FAULT_LIMIT, '阈值要来自同一个常量（别在诊断面写死 10）')
        assert.equal(snapshot.halted, false, '未到阈值不许停表（单次程序错误不停表是 round16 的裁定）')
      } finally {
        runner.dispose()
      }
    } finally {
      await store.close()
    }
  } finally {
    home.cleanup()
  }
})

test('R17-6b SoftFaultTracker：阈值按"连续同类"算，换 code / reset 都清零', () => {
  const tracker = new SoftFaultTracker()
  assert.equal(tracker.count(), 0)
  assert.equal(tracker.lastCode(), '')
  for (let i = 1; i < SOFT_FAULT_LIMIT; i += 1) {
    assert.equal(tracker.note('A'), false, `第 ${String(i)} 拍不该停表`)
    assert.equal(tracker.count(), i)
  }
  assert.equal(tracker.lastCode(), 'A', '诊断面要读出最后是哪个 code')
  assert.equal(tracker.note('A'), true, `连续 ${String(SOFT_FAULT_LIMIT)} 拍同类 ⇒ 到阈值`)
  // 换一个 code ⇒ 重新计（"连续同类"才是疑似 bug）。
  assert.equal(tracker.note('B'), false)
  assert.equal(tracker.count(), 1)
  assert.equal(tracker.lastCode(), 'B')
  tracker.reset()
  assert.equal(tracker.count(), 0)
  assert.equal(tracker.lastCode(), '')
})

// ── R17-7：插件级——资源面（`/api/resource/reminders` 的 `list()`）真能看见 ──

test('R17-7 插件装配后资源面就有 runner 现场（晚绑定真的接上了）', async () => {
  const home = tempHome('qq-r17-apply-')
  try {
    const config = baseConfig({
      admins: [OWNER],
      reminders: { enabled: true, dryRun: false, file: null },
    }) as unknown as QQChannelConfig
    const fake = fakeSubHost('reminders', config, home.dir)
    const platform = new FakePlatform()
    const queue = new FakeOutboundQueue()
    fake.with('platform', {
      client: {} as never,
      platform,
      api: platform.api,
      out: queue,
    } as never)
    // `apply()` 返回的是 disposer（`createHost` 不会替我们记账）——必须自己 await 掉。
    const dispose = await remindersPlugin.apply(fake.host)
    try {
      const resource = fake.resources.reminders as {
        list: () => { runner: { scheduled: boolean; halted: boolean; haltReason: string | null; softFault: { streak: number; limit: number } } | null }
      }
      assert.notEqual(resource, undefined, '插件必须注册 `reminders` 资源（这就是提醒侧对外的诊断出口）')
      const snapshot = resource.list()
      assert.notEqual(snapshot.runner, null, '装配之后 runner 现场必须出现在资源面里（晚绑定接了没有）')
      assert.equal(snapshot.runner?.scheduled, true, '`enabled=true` ⇒ 轮询器应当在跑')
      assert.equal(snapshot.runner?.halted, false, '刚装配时没有停表')
      assert.equal(snapshot.runner?.haltReason, null)
      assert.equal(snapshot.runner?.softFault.limit, SOFT_FAULT_LIMIT)
      // **第二个出口**（round18）：同一个只读现场也进了服务袋，`/api/snapshot` 的
      // `remindersRunner` 就是读它（`src/features/admin/index.ts::reminderStatusOf`）。
      const bagRunner = (fake.bag as { remindersRunner?: { status(): unknown } }).remindersRunner
      assert.notEqual(bagRunner, undefined, '服务袋里必须有 `remindersRunner`（`/api/snapshot` 的唯一来源）')
      assert.deepEqual(bagRunner?.status(), snapshot.runner, '两个出口必须是**同一份**现场，不许各抄一份')
    } finally {
      if (typeof dispose === 'function') await dispose()
    }
  } finally {
    home.cleanup()
  }
})

// ── R18：软故障刹车（round17 §1-17.1 / §1-17.2 / §2-17.1 的守卫） ───────────
//
// 这一组的存在理由（复审实测）：`softFault.reset()` 原来挂在 `start()` 的 `.then()` 上，
// 而 `tick()` 在"上一拍还没跑完"（`running`）时会**立即 resolve** ⇒ 每拍都把计数清零 ⇒
// 故障比一拍慢时刹车永远踩不下去（32 次故障、日志全写"第 1 拍"、`sends=0`、`halted` 永假）。
// 四条断言各自钉住一件事：
//   ①阈值**就是 `SOFT_FAULT_LIMIT`**（不是"迟早会停"）；
//   ②N-1 拍不停、成功一拍清零（`reset()` 变空操作 ⇒ 红）；
//   ③**故障比一拍慢**也照样到阈值（旧实现唯一漏掉的形状）；
//   ④停表的文案不许说"已投递 / 修好盘"（`sends=0` 时那是谎话），且 `start()` 说"仍在停表中"。

/** 造一个 runner：`send` 恒 `sent`、`allow` 恒真、不演练。 */
const makeRunner = (store: ReminderStore, logs: string[]): ReminderRunner => new ReminderRunner(
  store,
  async () => 'sent',
  (line: string) => { logs.push(line) },
  () => true,
  async () => null,
  async () => 'ok' as const,
  () => false,
)

/**
 * **阈值本身是契约，必须被钉成字面量**。
 *
 * 复审 §2-17.1 的 mutation B2（`10 → 3`）在旧测试集里**全绿**，原因是所有断言都与实现共用
 * `SOFT_FAULT_LIMIT` 这个常量（两边一起动就都"对"）。所以这里单独钉一次数值：生产节拍 30 s，
 * 第 10 拍才刹车 ⇒ 前 9 拍（270 s = 4.5 分钟）是"空转但还不停表"的窗口。把 10 改小是缩短这个
 * 窗口（提前永久停表），改大是延长（更晚才刹车）；任何改动都必须是有意的，并同步注释与日志文案。
 */
test('R18-0 `SOFT_FAULT_LIMIT` 是契约：10 拍（30s 节拍 ⇒ 前 9 拍 270s 空转窗口），改它必须是有意的', () => {
  assert.equal(SOFT_FAULT_LIMIT, 10, '阈值必须还是 10 拍')
  assert.equal((SOFT_FAULT_LIMIT * 30_000) / 60_000, 5, '30 s 节拍下第 10 拍 = 5 分钟')
  assert.equal(((SOFT_FAULT_LIMIT - 1) * 30_000) / 60_000, 4.5, '前 9 拍 = 270 s = 4.5 分钟（"静默空转"的窗口，别悄悄改）')
})

test('R18-1 刹车踩在阈值上：第 `SOFT_FAULT_LIMIT` 次**真实**故障才停表（不是"迟早会停"）', async () => {
  const home = tempHome('qq-r18-threshold-')
  const logs: string[] = []
  let faults = 0
  const store = newStore(home.dir)
  try {
    await store.load()
    store.expireStale = async () => {
      faults += 1
      throw storeFault('INVALID_CANDIDATE', 'expireStale', '桩：每拍都抛')
    }
    const runner = makeRunner(store, logs)
    try {
      runner.start(5)
      await waitUntil(() => runner.status().halted, 5_000)
      // 阈值改成 3 ⇒ 3 ≠ 10 红；改成 1000 ⇒ waitUntil 抛（永不停表）
      assert.equal(
        faults,
        SOFT_FAULT_LIMIT,
        `必须在第 ${String(SOFT_FAULT_LIMIT)} 次真实故障时停表（实际 ${String(faults)} 次）`,
      )
      assert.equal(logs.filter((line) => line.includes('调度已暂停')).length, 1, '停表只许留一条痕迹')
      assert.equal(runner.status().softFault.streak, SOFT_FAULT_LIMIT, '连击数要停在阈值上')
    } finally {
      runner.dispose()
    }
  } finally {
    await store.close()
    home.cleanup()
  }
})

test('R18-2 N-1 拍不停表、成功一拍把连击清零（`reset()` 变空操作 ⇒ 这条会红）', async () => {
  const home = tempHome('qq-r18-reset-')
  const logs: string[] = []
  const burst = SOFT_FAULT_LIMIT - 1
  const plan = [...Array<string>(burst).fill('fault'), 'ok', ...Array<string>(burst).fill('fault')]
  let step = 0
  let faults = 0
  let successes = 0
  const store = newStore(home.dir)
  try {
    await store.load()
    const real = store.expireStale.bind(store)
    store.expireStale = async () => {
      const planned = step < plan.length ? plan[step]! : 'ok'
      if (step < plan.length) step += 1
      if (planned === 'fault') {
        faults += 1
        throw storeFault('INVALID_CANDIDATE', 'expireStale', '按脚本抛')
      }
      successes += 1
      return await real()
    }
    const runner = makeRunner(store, logs)
    try {
      runner.start(5)
      await waitUntil(() => faults >= burst * 2 && successes >= 2, 8_000)
      const snapshot = runner.status()
      assert.equal(
        snapshot.halted,
        false,
        `${String(burst)} 拍 + 成功一拍 + ${String(burst)} 拍之后**不许**停表：成功那一拍必须把连击清零`
          + '（否则几小时里分散的偶发错误会被当成"连续同类"）',
      )
      assert.ok(
        snapshot.softFault.streak < SOFT_FAULT_LIMIT,
        `连击必须从成功那一拍重新计（实际 ${String(snapshot.softFault.streak)}）`,
      )
    } finally {
      runner.dispose()
    }
  } finally {
    await store.close()
    home.cleanup()
  }
})

test('R18-3 故障**比一拍慢**也照样到阈值（旧实现：每拍清零 ⇒ 永远"第 1 拍"、永不停表）', async () => {
  const home = tempHome('qq-r18-slow-')
  const logs: string[] = []
  let faults = 0
  const store = newStore(home.dir)
  try {
    await store.load()
    // 故障耗时 40ms、节拍 10ms ⇒ 每一拍都重叠（复审实测的形态：写队列没排空 / 盘慢）
    store.expireStale = async () => {
      await sleep(40)
      faults += 1
      throw storeFault('INVALID_CANDIDATE', 'expireStale', '桩：慢故障')
    }
    const runner = makeRunner(store, logs)
    try {
      runner.start(10)
      await waitUntil(() => runner.status().halted, 10_000)
      assert.equal(faults, SOFT_FAULT_LIMIT, `慢故障也必须数到 ${String(SOFT_FAULT_LIMIT)} 拍才停（实际 ${String(faults)}）`)
      // 旧实现里这 9 行日志全写"第 1 拍"（每拍都被 .then() 清零）
      const counted = logs
        .map((line) => /第 (\d+) 拍/.exec(line)?.[1])
        .filter((value): value is string => value !== undefined)
        .map(Number)
      const expected = Array.from({ length: SOFT_FAULT_LIMIT - 1 }, (_, index) => index + 1)
      assert.deepEqual(counted, expected, `日志里的"第 N 拍"必须是 1…${String(SOFT_FAULT_LIMIT - 1)}（实际 ${counted.join(',')}）`)
    } finally {
      runner.dispose()
    }
  } finally {
    await store.close()
    home.cleanup()
  }
})

// tick 级停表的两种现场：文案必须与"有没有投递过"一致（round17 §1-17.2）。
for (const code of ['INVALID_CANDIDATE', 'PERSIST_FAILED']) {
  const soft = code === 'INVALID_CANDIDATE'
  test(`R18-4 tick 级停表文案不许撒谎：${code}（${soft ? '程序错误连击' : '存储故障'}）`, async () => {
    const home = tempHome(`qq-r18-wording-${code.toLowerCase()}-`)
    const logs: string[] = []
    const store = newStore(home.dir)
    try {
      await store.load()
      let sends = 0
      store.expireStale = async () => { throw storeFault(code as never, 'expireStale', '桩') }
      const runner = new ReminderRunner(
        store,
        async () => { sends += 1; return 'sent' },
        (line: string) => { logs.push(line) },
        () => true,
        async () => null,
        async () => 'ok' as const,
        () => false,
      )
      try {
        runner.start(5)
        await waitUntil(() => runner.status().halted, 8_000)
        const haltLine = logs.find((line) => line.includes('调度已暂停') || line.includes('调度已锁定'))
        assert.notEqual(haltLine, undefined, `停表必须留一行痕迹：${logs.join(' | ')}`)
        assert.equal(sends, 0, '这条路径上一条消息都没发出去（下面两句文案的对错就取决于这个事实）')
        assert.ok(haltLine!.includes('未投递任何消息'), `必须说清"一条都没发"（实际：${haltLine ?? ''}）`)
        assert.ok(haltLine!.includes('人工重启'), `必须说清"要人工重启"（实际：${haltLine ?? ''}）`)
        assert.equal(
          haltLine!.includes('已投递但记账失败'),
          false,
          `tick 级停表**不许**复用记账路径的文案（sends=0 时那是谎话）：${haltLine ?? ''}`,
        )
        const reason = runner.status().haltReason ?? ''
        assert.ok(
          reason.includes(soft ? '连续' : '存储故障'),
          `haltReason 要说清是哪一种停表（实际：${reason}）`,
        )
      } finally {
        runner.dispose()
      }
    } finally {
      await store.close()
      home.cleanup()
    }
  })
}

test('R18-5 停表后 `start()` 必须说"仍在停表中"，而且真的不再跑（不许只打一行 started）', async () => {
  const home = tempHome('qq-r18-restart-')
  const logs: string[] = []
  let faults = 0
  const store = newStore(home.dir)
  try {
    await store.load()
    store.expireStale = async () => {
      faults += 1
      throw storeFault('INVALID_CANDIDATE', 'expireStale', '桩')
    }
    const runner = makeRunner(store, logs)
    try {
      runner.start(5)
      await waitUntil(() => runner.status().halted, 8_000)
      const faultsBefore = faults
      logs.length = 0
      // 复审实测：旧实现这里只多一行 "runner started"，然后彻底安静 —— 而 `sends` 增量 0。
      runner.start(10)
      await sleep(120)
      assert.ok(logs.some((line) => line.includes('仍在停表中')), `停表后 start() 必须说清它仍不干活：${logs.join(' | ')}`)
      assert.equal(logs.some((line) => line.includes('runner started')), false, '不许打 "runner started"')
      assert.equal(runner.status().scheduled, false, '停表后 start() 不许把定时器挂回去（否则诊断面会说"在跑"）')
      assert.equal(faults, faultsBefore, '停表后 start() 不许再跑任何一拍')
    } finally {
      runner.dispose()
    }
  } finally {
    await store.close()
    home.cleanup()
  }
})
