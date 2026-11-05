import { expectOk, expectRejected } from './fakes/reminders.js'
﻿import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { QQChannelConfig } from '../src/config.js'
import { ReminderStore, type Reminder } from '../src/features/reminders/store.js'
import { ReminderRunner } from '../src/features/reminders/runner.js'
import { configureReminderSeams, deliverReminder, remindersPlugin } from '../src/features/reminders/index.js'
import {
  agendaPortOf, configureAgendaPort, configureAgendaProbe, liveSeams, probeAgendaCandidates,
  type AgendaPort,
} from '../src/features/reminders/agenda-seam.js'
import { baseConfig, tempHome, FakeOutboundQueue, FakePlatform } from './fakes/contact.js'
import type { SubHost } from '../src/features/plugin-kit.js'

// **第八轮**：四条 P1 的回归（都按"真实装配 + 计数"的要求写）。
//
//   R8-1  清缓存**不许**把 failed/incompatible 降级成 absent（走真实候选解析，三阶段逐拍断言）
//   R8-2  读失败后**锁住所有写入**（add 之后 save 仍为 0；显式 clearReadLock 才恢复）
//   R8-3  runner 的**异常出口**也要守 dryRun（且注入点必须真的被打中）
//   R8-4  README/注释与实现一致（演练不评估闸门）
//   R8-5  R7 那组测试的加强：读失败、真 tick、桩命中、真实候选解析、`markFiredRebound`/`persistRaw`

const OWNER = 10001
const SESSION = `qq-dm-${String(OWNER)}`

const fullPort = (): AgendaPort => ({
  casOccurrence: async () => ({ ok: true }),
  markOccurrenceDispatched: async () => ({ ok: true }),
  nextOccurrence: async () => ({ ok: true, occurrence: { id: 'next', revision: 2 } }),
})

const legacyPort = () => ({ casOccurrence: async () => ({ ok: true }) })

interface HostRig {
  readonly host: SubHost
  readonly platform: FakePlatform
  readonly dir: string
  close: () => Promise<void>
}

const makeHost = (dir: string, dryRun: boolean, store?: ReminderStore): HostRig => {
  const platform = new FakePlatform()
  const queue = new FakeOutboundQueue()
  const base = baseConfig({ admins: [OWNER] }) as unknown as QQChannelConfig
  const config = { ...base, workspacePath: dir, reminders: { enabled: true, dryRun, file: null } } as QQChannelConfig
  const host = {
    config,
    log: () => {},
    need: () => ({ api: platform.api, out: queue }),
    provide: () => {},
    registerResource: () => {},
    bridge: { toolHost: () => ({ register: () => {} }) },
    dshHome: dir,
    get: (name: string) => (name === 'platform' ? { api: platform.api, out: queue }
      : name === 'reminders' ? store : undefined),
  } as unknown as SubHost
  // **A 类（通用形态）**：原来只重置接缝、**没关 store**。这里的 store 是调用方传进来的，
  // rig 代为关闭（同一文件只允许一个活跃 Store）⇒ close 必须是 async。
  return {
    host, platform, dir,
    close: async () => {
      configureReminderSeams({}); configureAgendaPort(null); configureAgendaProbe(null)
      if (store !== undefined) await store.close()
    },
  }
}

const seed = (file: string, rows: Reminder[]): void => {
  fs.writeFileSync(file, `${JSON.stringify({ version: 1, reminders: rows }, null, 2)}\n`, 'utf8')
}

const dueRow = (): Reminder => ({
  id: 'r_due', text: '到点的一次性', at: Date.now() - 60_000, room: 'dm', target: OWNER,
  createdBy: OWNER, created: Date.now() - 3_600_000, fired: false, firedAt: null, repeat: 'none',
  occurrence: { id: 'occ-due', revision: 1 },
})

// ── R8-1：清缓存不许把 failed/incompatible 降级成 absent ────────────────────

test('R8-1 真实候选解析：先成功 → 连续 incompatible/failed（含清缓存那一拍）→ 恢复，**逐拍都不许放行**', async () => {
  const home = tempHome('qq-r8-streak-')
  const logs: string[] = []
  try {
    // 宿主的服务表：`companionAgenda` 先给完整端口，之后换成残缺对象 / 抛错 / 恢复。
    let mode: 'ok' | 'incompatible' | 'failed' = 'ok'
    const get = (name: string): unknown => {
      if (name !== 'companionAgenda') return undefined
      if (mode === 'failed') throw new Error('ctx boom')
      return mode === 'ok' ? fullPort() : legacyPort()
    }
    configureAgendaPort(null)
    configureAgendaProbe(() => probeAgendaCandidates(get, (line) => { logs.push(line) }), (line) => { logs.push(line) })
    const seams = liveSeams((line) => { logs.push(line) })

    // ① 成功阶段：端口可用，CAS 正常问端口（这里端口回 ok ⇒ 放行）。
    assert.equal(agendaPortOf() !== null, true, '先缓存一个可用端口')
    assert.equal((await seams.casOccurrence!('occ-1', 1, { sessionId: SESSION })).ok, true, '正常阶段放行')

    // ② 连续 incompatible：**每一拍都不许 ok**（包括第 3、4、5 拍——第 3 拍是清缓存那一拍）。
    mode = 'incompatible'
    for (let round = 1; round <= 5; round += 1) {
      const verdict = await seams.casOccurrence!('occ-1', 1, { sessionId: SESSION })
      assert.equal(verdict.ok, false, `第 ${String(round)} 拍（incompatible）不许放行：${JSON.stringify(verdict)}`)
      assert.equal(verdict.reason, 'agenda-incompatible', `第 ${String(round)} 拍理由必须是 incompatible（实际 ${String(verdict.reason)}）`)
    }

    // ③ 连续 failed：同样逐拍不放行，理由是 probe-failed。
    mode = 'failed'
    for (let round = 1; round <= 5; round += 1) {
      const verdict = await seams.casOccurrence!('occ-1', 1, { sessionId: SESSION })
      assert.equal(verdict.ok, false, `第 ${String(round)} 拍（failed）不许放行：${JSON.stringify(verdict)}`)
      assert.equal(verdict.reason, 'agenda-probe-failed', `理由必须是 probe-failed（实际 ${String(verdict.reason)}）`)
    }

    // ④ 恢复：换回完整端口 ⇒ 立刻重新接上并放行。
    mode = 'ok'
    assert.equal((await seams.casOccurrence!('occ-1', 1, { sessionId: SESSION })).ok, true, '恢复后必须能接回')
    assert.equal(agendaPortOf() !== null, true)
    // 日志要能看出**立刻停用了缓存端口**（不是降级成 absent 再放行）。
    assert.ok(logs.some((line) => line.includes('立刻停用缓存端口')), logs.join(' | '))

    // ⑤ `absent` 走的是**另一条**规矩（瞬时抖动容忍 3 次）：连续 3 次 absent 才丢引用，
    //    且丢引用时**保留状态**（日志里能看出来），绝不许写成 absent 以外的东西再放行。
    const absentLogs: string[] = []
    configureAgendaPort(null)
    // 先**缓存**一个可用端口，再让探测开始返回 absent —— 这样才走"连续 3 次 absent 丢引用"那条路。
    let absentMode: 'ok' | 'absent' = 'ok'
    configureAgendaProbe(
      () => probeAgendaCandidates((name) => (absentMode === 'ok' && name === 'companionAgenda' ? fullPort() : undefined), (line) => { absentLogs.push(line) }),
      (line) => { absentLogs.push(line) },
    )
    const absentSeams = liveSeams((line) => { absentLogs.push(line) })
    assert.equal((await absentSeams.casOccurrence!('occ-1', 1, { sessionId: SESSION })).ok, true, '先缓存可用端口')
    absentMode = 'absent'
    for (let round = 0; round < 4; round += 1) {
      // 前两拍仍然可用（瞬时抖动容忍），第三拍起丢引用。
      await absentSeams.casOccurrence!('occ-1', 1, { sessionId: SESSION })
    }
    assert.ok(absentLogs.some((line) => line.includes('保留状态')), `absent 的丢引用要说明保留了什么状态：${absentLogs.join(' | ')}`)
  } finally {
    configureAgendaPort(null)
    configureAgendaProbe(null)
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})

// ── R8-2：读失败 → 锁住所有写入 ────────────────────────────────────────────

test('R8-2 盘上文件读不出来（损坏 JSON）→ add 也写不进去；修好后 clearReadLock 才恢复', async () => {
  const home = tempHome('qq-r8-lock-')
  const file = path.join(home.dir, 'reminders.json')
  const writes: string[] = []
  try {
    // 造一个"存在但解析不了"的文件。
    fs.writeFileSync(file, '{ this is not json', 'utf8')
    const base = baseConfig({ admins: [OWNER] }) as unknown as QQChannelConfig
    const config = { ...base, reminders: { enabled: true, dryRun: false, file: null } } as QQChannelConfig
    const logs: string[] = []
    const store = new ReminderStore(config.reminders, { workspacePath: home.dir, dshHome: home.dir, log: (line) => { logs.push(line) } })
    // 数真实落盘次数（原子写最后一步是 rename）。
    const { promises: fsp } = await import('node:fs')
    const original = fsp.rename
    fsp.rename = async (...args: Parameters<typeof fsp.rename>) => { writes.push(String(args[1])); return await original(...args) }
    try {
      await store.load()
      assert.equal(store.isReadLocked(), true, '读失败必须闩住')
      assert.ok(logs.some((line) => (line.includes('锁定所有写入') || line.includes('锁定只读'))), '要说明闩上了')
      // **持久故障状态**：内存里能读，且落了 sidecar（重启后也看得见）。
      const failure = store.readFailure()
      assert.ok(failure !== null, '要给出故障状态（不只是日志）')
      assert.equal(failure?.reason, 'unreadable', `解析失败应记为 unreadable（实际 ${String(failure?.reason)}）`)
      assert.equal(failure?.source, file, '要写清是哪个文件')
      const marker = `${file}.readonly.json`
      assert.equal(fs.existsSync(marker), true, '故障状态要落成 sidecar，重启后还看得见')
      assert.equal((JSON.parse(fs.readFileSync(marker, 'utf8')) as { reason: string }).reason, 'unreadable')
      // **关键**：add 之后也不许落盘（以前这里会 save=1，把原文件覆盖成空表）。
      // **round10 加强**：现在连"返回一条假提醒"都不许——`add()` 必须在改内存之前就抛。
      // **round17 口径**：`load()` 期间写故障 sidecar 是**设计内**行为（它是读失败的证据，
      // 且下面 :176 那条断言就要求它存在），所以判据从"一次都别写"收成"**基线 + 不增长**"：
      // 被钉住的不变量是"读失败后 `add()` 一个字都不许落盘"。
      const baseline = writes.length
      await assert.rejects(
        () => store.add({ text: '新提醒', at: Date.now() + 1000, room: 'dm', target: OWNER, createdBy: OWNER }),
        /只读锁定|锁定写入|读不出来/,
        '读失败后 add 必须抛错（工具据此回 ok:false，不许假成功）',
      )
      assert.deepEqual(writes.slice(baseline), [], `读失败后 add 不许落盘（实际写了 ${writes.slice(baseline).join(',')}）`)
      assert.equal(fs.readFileSync(file, 'utf8'), '{ this is not json', '原文件必须原样保留')
      assert.ok(logs.some((line) => line.includes('写入被拒绝') || line.includes('读失败锁生效')), '要留一条"被拒绝"的日志')

      // 显式恢复：人工修好原文件 → clearReadLock() → 之后才允许写。
      fs.writeFileSync(file, `${JSON.stringify({ version: 1, reminders: [] })}\n`, 'utf8')
      assert.equal((await store.clearReadLock()).loaded, 0, 'task-66：clearReadLock 回完整恢复报告（这里盘上是空表）')
      assert.equal(store.isReadLocked(), false)
      assert.equal(store.readFailure(), null, '恢复后故障状态要清掉')
      assert.equal(fs.existsSync(marker), false, 'sidecar 也要删掉')
      // 解锁只是"允许写"，不等于"已经写了"——必须真的写一次才能证明可写。
    // 判据也更强：从"有人 rename 过"变成"那条具体的提醒真的在盘上"。
    const restored = expectOk(await store.add({ text: '恢复后', at: Date.now() + 1000, room: 'dm', target: OWNER, createdBy: OWNER }))
    assert.equal(writes.length > 0, true, '解锁后必须真的能写进去')
    assert.equal(store.list(10).length, 1, '那条真的在内存里')
    assert.equal(fs.readFileSync(file, 'utf8').includes(restored.id), true, '而且真的落了盘')
    } finally {
      fsp.rename = original
    }
  } finally {
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})

test('R8-2b 全新目录（ENOENT）**不闩**：那是新装，不是事故', async () => {
  const home = tempHome('qq-r8-lock2-')
  try {
    const base = baseConfig({ admins: [OWNER] }) as unknown as QQChannelConfig
    const config = { ...base, reminders: { enabled: true, dryRun: false, file: null } } as QQChannelConfig
    const store = new ReminderStore(config.reminders, { workspacePath: home.dir, dshHome: home.dir, log: () => {} })
    await store.load()
    assert.equal(store.isReadLocked(), false, '文件不存在 = 新装，不许闩')
    expectOk(await store.add({ text: '第一条', at: Date.now() + 1000, room: 'dm', target: OWNER, createdBy: OWNER }))
    assert.equal(fs.existsSync(path.join(home.dir, 'reminders.json')), true, '第一次真实变更要能落盘')
  } finally {
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})

// ── R8-3：runner 的异常出口也要守 dryRun（注入点必须命中） ─────────────────

for (const dryRun of [true, false]) {
  test(`R8-3 (dryRun=${String(dryRun)}) send 抛错：异常出口 ${dryRun ? '不落 markUnknown' : '落 markUnknown'}，且注入点确实被打中`, async () => {
    const home = tempHome(`qq-r8-runner-${String(dryRun)}-`)
    const file = path.join(home.dir, 'reminders.json')
    seed(file, [dueRow()])
    try {
      const raw = new ReminderStore(
        (baseConfig({ admins: [OWNER] }) as unknown as QQChannelConfig).reminders,
        { workspacePath: home.dir, dshHome: home.dir, log: () => {} },
      )
      await raw.load()
      const calls: Record<string, number> = {}
      const store = new Proxy(raw, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver)
          if (typeof prop === 'string' && ['markUnknown', 'markFired', 'markFiredRebound', 'save'].includes(prop) && typeof value === 'function') {
            return async (...args: unknown[]) => {
              calls[prop] = (calls[prop] ?? 0) + 1
              return await (value as (...rest: unknown[]) => Promise<unknown>).apply(target, args)
            }
          }
          return value
        },
      })
      let sendAttempts = 0
      const runner = new ReminderRunner(
        store,
        async () => { sendAttempts += 1; throw new Error('platform exploded') },
        () => {},
        () => true,
        async () => null,
        async () => 'ok' as const,
        () => dryRun,
      )
      await (runner as unknown as { tick(): Promise<void> }).tick()

      assert.equal(sendAttempts, 1, '**注入点必须真的被打中一次**（上一轮的桩没命中，等于没测）')
      if (dryRun) {
        assert.equal(calls.markUnknown ?? 0, 0, '演练下异常出口**不许** markUnknown')
        assert.equal(calls.save ?? 0, 0, '演练下异常出口**不许**落盘')
      } else {
        assert.equal(calls.markUnknown ?? 0, 1, '非演练：异常 ⇒ markUnknown 一次（对照，证明上面的 0 不是恒真）')
      }
    } finally {
      fs.rmSync(home.dir, { recursive: true, force: true })
    }
  })
}

// ── R8-4：README/注释与实现一致（演练不评估闸门） ─────────────────────────

test('R8-4 README 与代码注释不许再说"演练也走只读闸门"', () => {
  const read = (rel: string): string => fs.readFileSync(path.join(process.cwd(), rel), 'utf8')
  const readme = read('README.md')
  assert.equal(readme.includes('走完只读闸门'), false, 'README 里"走完只读闸门"必须改掉')
  assert.equal(readme.includes('门控都过了'), false, 'README 里"门控都过了"必须改掉')
  assert.ok(readme.includes('不评估'), 'README 要明确写"演练不评估闸门"')
  // 代码注释里也不许留相反的话。
  const source = read('src/features/reminders/index.ts')
  assert.equal(source.includes('共享闸门照旧**只读**跑一遍'), false, 'index.ts 里那条相反注释必须改掉')
})

// ── R8-5：R7 那组测试的加强 ────────────────────────────────────────────────

test('R8-5a R7-1 加强：**读失败**（不是缺文件）也不写盘，且要闩住', async () => {
  const home = tempHome('qq-r8-r71-')
  const file = path.join(home.dir, 'reminders.json')
  fs.writeFileSync(file, 'not json at all', 'utf8')
  try {
    const base = baseConfig({ admins: [OWNER] }) as unknown as QQChannelConfig
    const config = { ...base, reminders: { enabled: true, dryRun: true, file: null } } as QQChannelConfig
    const store = new ReminderStore(config.reminders, { workspacePath: home.dir, dshHome: home.dir, log: () => {} })
    await store.load()
    assert.equal(store.isReadLocked(), true, '演练下读失败同样要闩（否则退出演练后第一次写就覆盖）')
  } finally {
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})

test('R8-5b R7-2 加强：dryRun 下走**真 tick**（不是只 apply/dispose），全程 0 次落盘', async () => {
  const home = tempHome('qq-r8-r72-')
  const file = path.join(home.dir, 'reminders.json')
  seed(file, [dueRow()])
  const before = fs.readFileSync(file, 'utf8')
  const { promises: fsp } = await import('node:fs')
  const original = fsp.rename
  let renames = 0
  fsp.rename = async (...args: Parameters<typeof fsp.rename>) => { renames += 1; return await original(...args) }
  try {
    const rig = makeHost(home.dir, true)
    const raw = new ReminderStore(rig.host.config.reminders, { workspacePath: home.dir, dshHome: home.dir, log: () => {} })
    await raw.load()
    const runner = new ReminderRunner(
      raw,
      (reminder) => deliverReminder(rig.host, reminder),
      () => {},
      () => true,
      async () => null,
      async () => 'ok' as const,
      () => true,
    )
    for (let tick = 0; tick < 3; tick += 1) await (runner as unknown as { tick(): Promise<void> }).tick()
    assert.equal(renames, 0, `真 tick 下不许落盘（实际 ${String(renames)} 次）`)
    assert.equal(fs.readFileSync(file, 'utf8'), before, '文件必须逐字节不变')
    await rig.close()
  } finally {
    fsp.rename = original
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})

test('R8-5c R7-7 加强：dryRun 下 `markFiredRebound`/`persistRaw` 也一次都不许被调', async () => {
  const home = tempHome('qq-r8-r77-')
  const file = path.join(home.dir, 'reminders.json')
  seed(file, [{ ...dueRow(), repeat: 'daily' }])
  try {
    const rig = makeHost(home.dir, true)
    const raw = new ReminderStore(rig.host.config.reminders, { workspacePath: home.dir, dshHome: home.dir, log: () => {} })
    await raw.load()
    const calls: string[] = []
    const store = new Proxy(raw, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver)
        const watched = ['markFired', 'markFiredRebound', 'markUnknown', 'markSent', 'skipRound', 'expireStale',
          'capBacklog', 'pruneFired', 'setPendingDispatch', 'clearPendingDispatch', 'bumpPendingDispatch', 'save', 'add', 'remove']
        if (typeof prop === 'string' && watched.includes(prop) && typeof value === 'function') {
          return async (...args: unknown[]) => {
            calls.push(prop)
            return await (value as (...rest: unknown[]) => Promise<unknown>).apply(target, args)
          }
        }
        return value
      },
    })
    const runner = new ReminderRunner(
      store,
      (reminder) => deliverReminder(rig.host, reminder),
      () => {},
      () => true,
      async () => ({ id: 'next', revision: 2 }),
      async () => 'ok' as const,
      () => true,
    )
    await (runner as unknown as { tick(): Promise<void> }).tick()
    assert.deepEqual(calls, [], `dryRun 下写方法调用必须为空（含 markFiredRebound）：${calls.join(',')}`)
    await rig.close()
  } finally {
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})

test('R8-5d R7-5 加强：走**真实候选解析**（不是手写 resolver）验证 absent / incompatible / failed', async () => {
  try {
    const logs: string[] = []
    const absent = probeAgendaCandidates(() => undefined, (line) => { logs.push(line) })
    assert.deepEqual(absent, { port: null, state: 'absent' }, '什么都没装 ⇒ absent')
    const incompatible = probeAgendaCandidates((name) => (name === 'companionAgenda' ? legacyPort() : undefined), (line) => { logs.push(line) })
    assert.equal(incompatible.state, 'incompatible', '有对象但不合格 ⇒ incompatible')
    const failed = probeAgendaCandidates(() => { throw new Error('boom') }, (line) => { logs.push(line) })
    assert.equal(failed.state, 'failed', '取服务抛错 ⇒ failed')
    const ok = probeAgendaCandidates((name) => (name === 'companion:agenda' ? fullPort() : undefined), (line) => { logs.push(line) })
    assert.equal(ok.state, 'ok', '正确的端口要选到')
    assert.ok(logs.some((line) => line.includes('缺')))
  } finally {
    configureAgendaProbe(null)
    configureAgendaPort(null)
  }
})

// ── R8-6：契约边界——dryRun 不是全局只读锁 ────────────────────────────────

test('R8-6 README 写清 dryRun 锁什么/不锁什么（工具与后台的显式管理操作仍会写盘）', () => {
  const readme = fs.readFileSync(path.join(process.cwd(), 'README.md'), 'utf8')
  assert.ok(readme.includes('不锁'), 'README 要写清"不锁什么"')
  assert.ok(readme.includes('显式'), 'README 要说明显式管理操作不受演练限制')
})
