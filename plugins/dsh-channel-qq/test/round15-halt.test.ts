import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { ReminderStore } from '../src/features/reminders/store.js'
import { ReminderRunner } from '../src/features/reminders/runner.js'
import { deliverReminder } from '../src/features/reminders/index.js'
import { storeFault } from '../src/features/reminders/store-contract.js'
import type { QQChannelConfig } from '../src/config.js'
import { baseConfig, tempHome, waitUntil, FakePlatform, FakeOutboundQueue } from './fakes/contact.js'

const OWNER = 10001

const sleep = async (ms: number): Promise<void> => await new Promise((resolve) => { setTimeout(resolve, ms) })

/**
 * 等"第一拍真的发生了"，再断言负向条件。
 *
 * 这些用例原先靠 `sleep(150)` 猜第一拍完成。机器忙（临时目录 + Defender 扫描，单次 10–50ms）
 * 时 150ms 会不够，于是**实现正确**的用例偶发变红：2026-11-11 的验收轮里同一文件连续
 * 三次运行出现过 P1-16.1 / P1-17.2 各一次假红。`waitUntil` 用宿主真实时间轮询**正向条件**，
 * 负向断言（第二拍不许再发）仍然保留固定延迟，因为要证明的正是"这段时间内没有动作"。
 */
async function afterFirstBeat(predicate: () => boolean, label: string): Promise<void> {
  await waitUntil(predicate, 3_000)
  assert.ok(predicate(), label)
}

/**
 * P1（复审 1.2）守卫：**已投递但记账失败 ⇒ 必须锁定调度，下一拍不许再发。**
 *
 * 为什么这条比"日志写了不重发"重要：`sentFor` 没写成 ⇒ `due()` 下一拍仍选中它 ⇒
 * 崩溃恢复闸判 false ⇒ 真的会再发一次。日志说"不重发"而实际重发，是最坏的组合。
 */
test('P1-1.2 记账失败 ⇒ 调度锁定，第二拍不许再发', async () => {
  const home = tempHome('qq-halt-')
  const logs: string[] = []
  const base = baseConfig({ admins: [OWNER] }) as unknown as QQChannelConfig
  const store = new ReminderStore(
    { ...base.reminders, enabled: true, dryRun: false, file: null },
    { workspacePath: home.dir, dshHome: home.dir, log: (line: string) => { logs.push(line) } },
  )
  try {
    await store.load()
    await store.add({ text: '该睡了', at: Date.now() - 1000, room: 'dm', target: OWNER, createdBy: OWNER } as never)

    let sends = 0
    // 记账一定失败：这是"已经发出去、但状态没落盘"的现场。
    // 一次性提醒走 markFired（周期才走 markFiredRebound）⇒ 这里只注 markFired：这条用例走不到 rebound。
    // **别在这里注 `markSent`**：`runner.ts` 里它出现 0 次（真实调用点在 `index.ts::sendOnce`），
    // 那样的桩永远不会被调用 —— 那是 round16 §4-3 点名的"看起来有守卫、实际没测"，守卫在 `P1-17.2`。
    store.markFired = async () => { throw storeFault('PERSIST_FAILED', 'markFired', '桩：模拟记账写不进盘') }

    const runner = new ReminderRunner(
      store,
      async () => { sends += 1; return 'sent' },
      (line: string) => { logs.push(line) },
      () => true,
      async () => null,
      async () => 'ok' as const,
      () => false,
    )
    runner.start(10)
    await afterFirstBeat(() => sends === 1, '第一拍必须真的发了（否则这条测试是空转）')
    const afterFirst = sends
    assert.equal(afterFirst, 1, '第一拍必须真的发了（否则这条测试是空转）')
    assert.ok(logs.some((line) => line.includes('调度已锁定')), `要留下锁定痕迹：${logs.join(' | ')}`)
    await sleep(150)
    assert.equal(sends, 1, '记账失败后**第二拍不许再发**（否则就是重复外发）')
    runner.dispose()
  } finally {
    await store.close()
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})

/**
 * P1（复审 13.2）守卫：**`markUnknown` 也写不成时同样要锁定调度。**
 *
 * 两条 `sent` 出口早就调了 `haltDispatch`，唯独 `unknown` 出口是裸 `return`——
 * 而"发没发说不清"恰恰是最危险的一种：`due()` 下一拍仍选中它 ⇒ 再发一次。
 */
test('P1-13.2 markUnknown 写不成 ⇒ 调度锁定，第二拍不许再发', async () => {
  const home = tempHome('qq-halt2-')
  const logs: string[] = []
  const base = baseConfig({ admins: [OWNER] }) as unknown as QQChannelConfig
  const store = new ReminderStore(
    { ...base.reminders, enabled: true, dryRun: false, file: null },
    { workspacePath: home.dir, dshHome: home.dir, log: (line: string) => { logs.push(line) } },
  )
  try {
    await store.load()
    await store.add({ text: '该睡了', at: Date.now() - 1000, room: 'dm', target: OWNER, createdBy: OWNER } as never)

    let sends = 0
    // 只注 `markUnknown`：这条用例走的是 unknown 出口，`markFired` 不在这条路径上
    // （以前这里还注了一个 `markSent`，`runner.ts` 里根本不存在这个调用点 ⇒ 死桩，round16 §4-3 已删）。
    store.markUnknown = async () => { throw storeFault('PERSIST_FAILED', 'markUnknown', '桩') }

    const runner = new ReminderRunner(
      store,
      async () => { sends += 1; return 'unknown' },
      (line: string) => { logs.push(line) },
      () => true,
      async () => null,
      async () => 'ok' as const,
      () => false,
    )
    runner.start(10)
    await afterFirstBeat(() => sends === 1, '第一拍必须真的发了（否则这条测试是空转）')
    assert.ok(logs.some((line) => line.includes('调度已锁定')), `要留下锁定痕迹：${logs.join(' | ')}`)
    await sleep(150)
    assert.equal(sends, 1, 'unknown 出口记账失败后**第二拍不许再发**')
    runner.dispose()
  } finally {
    await store.close()
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})

const makeFaultRunner = async (code: string, logs: string[], _intervalMs = 10) => {
  const home = tempHome(`qq-haltf-${code.toLowerCase()}-`)
  const base = baseConfig({ admins: [OWNER] }) as unknown as QQChannelConfig
  const store = new ReminderStore(
    { ...base.reminders, enabled: true, dryRun: false, file: null },
    { workspacePath: home.dir, dshHome: home.dir, log: (line: string) => { logs.push(line) } },
  )
  await store.load()
  // `takeBatch()` 第一件事就是 expireStale ⇒ 用它制造"tick 抛出"
  store.expireStale = async () => { throw storeFault(code as never, 'expireStale', '桩') }
  const runner = new ReminderRunner(
    store,
    async () => { return 'sent' },
    (line: string) => { logs.push(line) },
    () => true,
    async () => null,
    async () => 'ok' as const,
    () => false,
  )
  return { runner, store, home }
}

/**
 * **P1（复审 15.1）双向守卫**：tick 抛出的故障**按 code 分级**。
 *
 * `isStoreFault` 不带 code ⇒ 以前把 `INVALID_CANDIDATE`（注释里写着"程序错误"）也当磁盘故障，
 * 结果一个 bug 会让提醒**永久失活**。判据是"状态可信吗"，不是"是不是 Store 故障"。
 */
/**
 * **P1（复审 16.3）**：程序错误**单次不停表**（不让一个 bug 变永久失活），
 * 但**连续 10 拍同类**要停表（见 `P1-16.3a`）。**两条成对**，才说明阈值真的在起作用。
 */
test('P1-15.1a 单次程序错误（INVALID_CANDIDATE）⇒ 不停表、继续跑', async () => {
  const logs: string[] = []
  const home = tempHome('qq-soft-once-')
  const base = baseConfig({ admins: [OWNER] }) as unknown as QQChannelConfig
  const store = new ReminderStore(
    { ...base.reminders, enabled: true, dryRun: false, file: null },
    { workspacePath: home.dir, dshHome: home.dir, log: (line: string) => { logs.push(line) } },
  )
  try {
    await store.load()
    await store.add({ text: '该睡了', at: Date.now() - 1000, room: 'dm', target: OWNER, createdBy: OWNER } as never)
    const realExpire = store.expireStale.bind(store)
    let threw = false
    // 只抛一次，之后走真实逻辑 ⇒ 证明"单次错误不会停表、后续还能继续跑"
    store.expireStale = async () => {
      if (!threw) { threw = true; throw storeFault('INVALID_CANDIDATE', 'expireStale', '一次性') }
      return await realExpire()
    }
    let sends = 0
    const runner = new ReminderRunner(
      store,
      async () => { sends += 1; return 'sent' },
      (line: string) => { logs.push(line) },
      () => true,
      async () => null,
      async () => 'ok' as const,
      () => false,
    )
    runner.start(10)
    await sleep(120)
    assert.equal(logs.some((line) => line.includes('调度已锁定')), false, '单次程序错误不许停表')
    assert.ok(logs.some((line) => line.includes('非磁盘类')), `要留下痕迹：${logs.join(' | ')}`)
    assert.ok(sends >= 1, '抛过一次之后仍要继续投递（否则就是静默空转/停表）')
    runner.dispose()
  } finally {
    await store.close()
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})

test('P1-15.1b 磁盘类故障（PERSIST_FAILED）⇒ 停表', async () => {
  const logs: string[] = []
  const { runner, store, home } = await makeFaultRunner('PERSIST_FAILED', logs)
  try {
    runner.start(10)
    await waitUntil(() => logs.some((line) => line.includes('调度已锁定')), 3_000)
    assert.ok(logs.some((line) => line.includes('调度已锁定')), `磁盘故障必须停表：${logs.join(' | ')}`)
    const before = logs.filter((line) => line.includes('调度已锁定')).length
    await sleep(150)
    assert.equal(logs.filter((line) => line.includes('调度已锁定')).length, before, '停表后不许再跑下一拍')
    runner.dispose()
  } finally {
    await store.close()
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})

/**
 * **P1（复审 16.1）守卫**：记账路径 `markFired` 抛**非 store 错误**（`TypeError`）时也必须停表。
 * 投递已经发生，`fired`/`sentFor` 没写成 ⇒ 下一拍 `due()` 仍选中它 ⇒ 再发一次。
 */
test('P1-16.1 记账路径抛 TypeError 也必须停表：markFired', async () => {
  const home = tempHome('qq-halt-markFired-')
  const logs: string[] = []
  const base = baseConfig({ admins: [OWNER] }) as unknown as QQChannelConfig
  const store = new ReminderStore(
    { ...base.reminders, enabled: true, dryRun: false, file: null },
    { workspacePath: home.dir, dshHome: home.dir, log: (line: string) => { logs.push(line) } },
  )
  try {
    await store.load()
    await store.add({ text: '该睡了', at: Date.now() - 1000, room: 'dm', target: OWNER, createdBy: OWNER, repeat: 'none' } as never)
    let sends = 0
    store.markFired = async () => { throw new TypeError('boom') }
    const runner = new ReminderRunner(
      store,
      async () => { sends += 1; return 'sent' },
      (line: string) => { logs.push(line) },
      () => true,
      async () => null,
      async () => 'ok' as const,
      () => false,
    )
    runner.start(10)
    await afterFirstBeat(() => sends === 1, '第一拍必须真的发了（否则这条测试是空转）')
    assert.ok(logs.some((line) => line.includes('调度已锁定')), `必须留锁定痕迹：${logs.join(' | ')}`)
    await sleep(150)
    assert.equal(sends, 1, '记账抛 TypeError 后**第二拍不许再发**')
    runner.dispose()
  } finally {
    await store.close()
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})

/**
 * **P1（复审 16.1）守卫**：记账路径 `markFiredRebound` 抛**非 store 错误**（`TypeError`）时也必须停表。
 * 投递已经发生，`fired`/`sentFor` 没写成 ⇒ 下一拍 `due()` 仍选中它 ⇒ 再发一次。
 */
test('P1-16.1 记账路径抛 TypeError 也必须停表：markFiredRebound', async () => {
  const home = tempHome('qq-halt-markFiredRebound-')
  const logs: string[] = []
  const base = baseConfig({ admins: [OWNER] }) as unknown as QQChannelConfig
  const store = new ReminderStore(
    { ...base.reminders, enabled: true, dryRun: false, file: null },
    { workspacePath: home.dir, dshHome: home.dir, log: (line: string) => { logs.push(line) } },
  )
  try {
    await store.load()
    await store.add({ text: '该睡了', at: Date.now() - 1000, room: 'dm', target: OWNER, createdBy: OWNER, repeat: 'daily' } as never)
    let sends = 0
    store.markFiredRebound = async () => { throw new TypeError('boom') }
    const runner = new ReminderRunner(
      store,
      async () => { sends += 1; return 'sent' },
      (line: string) => { logs.push(line) },
      () => true,
      async () => null,
      async () => 'ok' as const,
      () => false,
    )
    runner.start(10)
    await afterFirstBeat(() => sends === 1, '第一拍必须真的发了（否则这条测试是空转）')
    assert.ok(logs.some((line) => line.includes('调度已锁定')), `必须留锁定痕迹：${logs.join(' | ')}`)
    await sleep(150)
    assert.equal(sends, 1, '记账抛 TypeError 后**第二拍不许再发**')
    runner.dispose()
  } finally {
    await store.close()
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})

/**
 * **P1（复审 16.1）守卫**：记账路径 `markUnknown` 抛**非 store 错误**（`TypeError`）时也必须停表。
 * 投递已经发生，`fired`/`sentFor` 没写成 ⇒ 下一拍 `due()` 仍选中它 ⇒ 再发一次。
 */
test('P1-16.1 记账路径抛 TypeError 也必须停表：markUnknown', async () => {
  const home = tempHome('qq-halt-markUnknown-')
  const logs: string[] = []
  const base = baseConfig({ admins: [OWNER] }) as unknown as QQChannelConfig
  const store = new ReminderStore(
    { ...base.reminders, enabled: true, dryRun: false, file: null },
    { workspacePath: home.dir, dshHome: home.dir, log: (line: string) => { logs.push(line) } },
  )
  try {
    await store.load()
    await store.add({ text: '该睡了', at: Date.now() - 1000, room: 'dm', target: OWNER, createdBy: OWNER, repeat: 'none' } as never)
    let sends = 0
    store.markUnknown = async () => { throw new TypeError('boom') }
    const runner = new ReminderRunner(
      store,
      async () => { sends += 1; return 'unknown' },
      (line: string) => { logs.push(line) },
      () => true,
      async () => null,
      async () => 'ok' as const,
      () => false,
    )
    runner.start(10)
    await afterFirstBeat(() => sends === 1, '第一拍必须真的发了（否则这条测试是空转）')
    assert.ok(logs.some((line) => line.includes('调度已锁定')), `必须留锁定痕迹：${logs.join(' | ')}`)
    await sleep(150)
    assert.equal(sends, 1, '记账抛 TypeError 后**第二拍不许再发**')
    runner.dispose()
  } finally {
    await store.close()
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})

/**
 * **P1（复审 16.3 / round17 §1-17.1·§1-17.2）**：程序错误不停表是对的（不让一个 bug 变永久失活），
 * 但**静默空转同样不可观测**。裁定：**同一个 code 连续 `SOFT_FAULT_LIMIT` 拍** ⇒ 停表并标"疑似 bug"。
 *
 * round18：断言改成读**结构化状态**（`status().halted`）而不是只 grep 日志，因为 tick 级停表的
 * 文案换成了"调度已暂停 / 未投递任何消息"（旧文案说"已投递但记账失败 / 修好盘"，而这里 `sends=0`）。
 * 阈值的**数值**与"成功一拍清零"由 `test/reminders-diagnostics.test.ts` 的 R18-1/2/3 钉住。
 */
test('P1-16.3a 连续同类程序错误 ⇒ 停表（不停表就是静默空转）', async () => {
  const logs: string[] = []
  const { runner, store, home } = await makeFaultRunner('INVALID_CANDIDATE', logs, 5)
  try {
    runner.start(5)
    await waitUntil(() => runner.status().halted, 8_000)
    assert.ok(logs.some((line) => line.includes('疑似 bug')), `连续同类错误必须停表：${logs.join(' | ')}`)
    assert.ok(logs.some((line) => line.includes('调度已暂停')), '停表要留一行可 grep 的痕迹')
    assert.equal(
      logs.some((line) => line.includes('已投递但记账失败')),
      false,
      'tick 级停表不许复用记账路径的文案（这条路径一条消息都没发出去）',
    )
    runner.dispose()
  } finally {
    await store.close()
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})

/** code 变了 ⇒ streak 清零 ⇒ 不许因为"错误总数多"就停表（判断依据是**连续同类**）。 */
test('P1-16.3b 交替出现两种程序错误 ⇒ streak 清零、不停表', async () => {
  const logs: string[] = []
  const home = tempHome('qq-soft-alt-')
  const base = baseConfig({ admins: [OWNER] }) as unknown as QQChannelConfig
  const store = new ReminderStore(
    { ...base.reminders, enabled: true, dryRun: false, file: null },
    { workspacePath: home.dir, dshHome: home.dir, log: (line: string) => { logs.push(line) } },
  )
  try {
    await store.load()
    let n = 0
    store.expireStale = async () => {
      n += 1
      throw storeFault((n % 2 === 0 ? 'INVALID_CANDIDATE' : 'REENTRANT') as never, 'expireStale', '交替')
    }
    const runner = new ReminderRunner(
      store,
      async () => 'sent',
      (line: string) => { logs.push(line) },
      () => true,
      async () => null,
      async () => 'ok' as const,
      () => false,
    )
    runner.start(5)
    await sleep(400)
    assert.equal(logs.some((line) => line.includes('疑似 bug')), false, '错误交替出现不算连续同类，不许停表')
    assert.ok(logs.filter((line) => line.includes('非磁盘类')).length >= 5, '应当一直在跑（空转可观测）')
    runner.dispose()
  } finally {
    await store.close()
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})

/**
 * **P1（复审 17.2）投递层**：`markSent` 故障 ⇒ 结论 `unknown`、**不重发**、**不停表**。
 *
 * 三条验收（缺第一条就会变成假守卫）：
 * ① 第一拍**真的走到** `sendTo`（`platformSends === 1`）；
 * ② `markSent` 抛 `TypeError` + `markUnknown` 正常 ⇒ 第二拍仍 1、且无「调度已锁定」；
 * ③ 分别守住 unknown 收敛与故障日志；等价的 rethrow 不作为行为变异。
 * ④ markSent 与 markUnknown 都失败 ⇒ 停表、第二拍不重发。
 */
for (const failUnknown of [false, true]) {
test(`P1-17.2 投递层 markSent 抛错 / unknown 保存${failUnknown ? '失败停表' : '成功收敛'} ⇒ 不重发`, async () => {
  const home = tempHome('qq-halt-sentlayer-')
  const logs: string[] = []
  const base = baseConfig({ admins: [OWNER] }) as unknown as QQChannelConfig
  const config = { ...base, workspacePath: home.dir, reminders: { enabled: true, dryRun: false, file: null } } as QQChannelConfig
  const store = new ReminderStore(
    config.reminders,
    { workspacePath: home.dir, dshHome: home.dir, log: (line: string) => { logs.push(line) } },
  )
  let runner: ReminderRunner | undefined
  try {
    await store.load()
    await store.add({ text: '该睡了', at: Date.now() - 1000, room: 'dm', target: OWNER, createdBy: OWNER } as never)
    store.markSent = async () => { throw new TypeError('boom') }
    let unknownCalls = 0
    const markUnknown = store.markUnknown.bind(store)
    store.markUnknown = async (...args: Parameters<typeof markUnknown>) => {
      unknownCalls += 1
      if (failUnknown) throw new TypeError('unknown-save-boom')
      return await markUnknown(...args)
    }
    let platformSends = 0
    const platform = new FakePlatform()
    const queue = new FakeOutboundQueue()
    const counting = {
      ...platform.api,
      sendTo: async (isGroup: boolean, target: number, message: unknown) => {
        platformSends += 1
        return await (platform.api as { sendTo: (g: boolean, t: number, m: unknown) => Promise<unknown> })
          .sendTo(isGroup, target, message)
      },
    }
    const host = {
      config,
      log: (line: string) => { logs.push(line) },
      need: () => ({ api: counting, out: queue }),
      provide: () => {},
      registerResource: () => {},
      bridge: { toolHost: () => ({ register: () => {} }) },
      dshHome: home.dir,
      get: (name: string) => (name === 'platform' ? { api: counting, out: queue } : name === 'reminders' ? store : undefined),
    } as never
    runner = new ReminderRunner(
      store,
      async (reminder) => await deliverReminder(host, reminder),
      (line: string) => { logs.push(line) },
      () => true,
      async () => null,
      async () => 'ok' as const,
      () => false,
    )
    runner.start(10)
    await afterFirstBeat(() => platformSends === 1, '① 第一拍必须真的走到 sendTo（否则这条测试是空转）')
    assert.equal(platformSends, 1, '① 第一拍必须真的走到 sendTo（否则这条测试是空转）')
    assert.equal(unknownCalls, 1, '③ 必须通过 unknown 路径收敛，不能误报 sent')
    assert.ok(logs.some((line) => line.includes('已真发但状态没落盘 → 按 unknown 处理')), '③ 必须诊断已投递但状态未落盘')
    assert.equal(logs.some((line) => line.includes('调度已锁定')), failUnknown, '④ 只有 unknown 也写不成时必须停表')
    await sleep(200)
    assert.equal(platformSends, 1, '② unknown 写成终态后**不许重发**')
    runner.dispose()
  } finally {
    runner?.dispose()
    await store.close()
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})
}
