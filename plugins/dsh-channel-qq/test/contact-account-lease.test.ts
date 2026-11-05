/** P2.5 round16 §3.4：共享账本的**租约语义**——没租约就不记账，且绝不抛。
 *
 * 缺陷原样（`service.account()`）：`epoch = deps.store.lease?.epoch ?? 0`，没租约时把 0
 * 交给 `store.write()`，而 `keeper.assert(0)` 对"手上没有任何租约"一律抛
 * `StaleLeaseError`。调用方恰恰是提醒 runner 的**已经真发成功**记账路径：一次成功投递
 * 会被一个纯记账问题改写成"记账失败"，最坏的结果是整个提醒侧停表。
 *
 * 判据：
 *   1. 没租约 ⇒ `account()` **resolve**（不抛）；
 *   2. 日志里说清"这笔没记账、原因是没有租约"（要能 grep，且不许说成发送失败）；
 *   3. 账本与盘都没动（宁可少记一笔，也不写一笔来历不明的账）；
 *   4. 有租约时照常记一次（降级不能顺手把正常路径也关掉）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultContactConfig } from '../src/config/sections/contact.js'
import { readLedgerFile } from '../src/features/contact/ledger-io.js'
import { createContactService } from '../src/features/contact/service.js'
import { ContactStore } from '../src/features/contact/store.js'
import type { ContactWorker } from '../src/features/contact/worker.js'
import { FakeClock, tempHome } from './fakes/contact.js'

const T0 = Date.UTC(2026, 9, 30, 1, 0, 0)
const DAY = '2026-10-30'

/**
 * 只实现 `createContactService` 真正会碰的三件事（`account` 碰不到 worker）。
 *
 * 为什么不 new 一个真的 `ContactWorker`：这条用例要钉的是"记账路径有没有租约时会怎样"，
 * 起一个真 worker 会把定时器、发送、门控全拖进来——那样用例失败时说不清是谁的错。
 */
function stubWorker(): ContactWorker {
  return {
    isPaused: false,
    pause: () => {},
    resume: () => {},
  } as unknown as ContactWorker
}

function makeStore(home: { dir: string }, clock: FakeClock): ContactStore {
  return new ContactStore({
    file: `${home.dir}/contact.json`,
    lockFile: `${home.dir}/contact.lock`,
    hostId: 'account-host',
    pid: process.pid,
    log: () => {},
    clock,
    dayKey: () => DAY,
  })
}

test('round16 §3.4 无租约：account() 只记一条日志，不抛、不记账', async () => {
  const home = tempHome('account-nolease-')
  const clock = new FakeClock(new Date(T0))
  const logs: string[] = []
  const store = makeStore(home, clock)
  const service = createContactService({
    store,
    worker: stubWorker(),
    clock,
    log: (line) => { logs.push(line) },
    // 时区必须给：否则会先命中"算不出本地日"那条分支，把租约这条判据盖住。
    config: () => ({ ...defaultContactConfig(), enabled: true, timezone: 'Asia/Shanghai' }),
    random: () => 0.5,
  })
  try {
    await store.load()
    assert.equal(store.lease, null)

    // 主断言：一次成功投递的记账调用在无租约时**不许** reject。
    await assert.doesNotReject(
      service.account({ room: 'dm-10001', sender: 'reminders', reason: 'reminder-delivered' }),
      '无租约时记账抛错会把一次成功投递变成"记账失败"（round16 §3.4）',
    )

    // 日志要能查："这笔没记" + "原因是没有租约"，并且不含"失败"的误导口径。
    const line = logs.find((item) => item.includes('共享账本跳过') && item.includes('没有租约'))
    assert.ok(line !== undefined, `日志里没有"没有租约"的明确交代：${logs.join(' | ')}`)
    assert.match(line, /dm-10001/)
    assert.match(line, /reminders/)

    // 账本与盘都没动。
    assert.equal(store.state.counters.sentTodayGlobal, 0)
    assert.equal(store.state.counters.lastSentAt, null)
    const disk = await readLedgerFile({ file: `${home.dir}/contact.json`, clock, log: () => {}, dayKey: () => DAY }, false)
    assert.equal(disk.ledger.counters.sentTodayGlobal, 0)
  } finally {
    home.cleanup()
  }
})

test('round16 §3.4 有租约：account() 照常记一次（降级不关正常路径）', async () => {
  const home = tempHome('account-lease-')
  const clock = new FakeClock(new Date(T0))
  const logs: string[] = []
  const store = makeStore(home, clock)
  const service = createContactService({
    store,
    worker: stubWorker(),
    clock,
    log: (line) => { logs.push(line) },
    config: () => ({ ...defaultContactConfig(), enabled: true, timezone: 'Asia/Shanghai' }),
    random: () => 0.5,
  })
  try {
    await store.load()
    const lease = await store.acquireLease()
    assert.notEqual(lease, null)

    await service.account({ room: 'dm-10001', sender: 'reminders', reason: 'reminder-delivered', now: T0 })
    assert.equal(store.state.counters.sentTodayGlobal, 1)
    assert.equal(store.state.counters.sentTodayByRoom['dm-10001'], 1)
    assert.equal(store.state.counters.lastSentAt, T0)
    assert.equal(logs.some((item) => item.includes('没有租约')), false)
    const disk = await readLedgerFile({ file: `${home.dir}/contact.json`, clock, log: () => {}, dayKey: () => DAY }, false)
    assert.equal(disk.ledger.counters.sentTodayGlobal, 1)
  } finally {
    await store.releaseLease().catch(() => {})
    home.cleanup()
  }
})
