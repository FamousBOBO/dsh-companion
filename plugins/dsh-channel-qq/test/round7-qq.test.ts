import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import type { QQChannelConfig } from '../src/config.js'
import { ReminderStore, type Reminder } from '../src/features/reminders/store.js'
import { ReminderRunner } from '../src/features/reminders/runner.js'
import { configureReminderSeams, deliverReminder, remindersPlugin } from '../src/features/reminders/index.js'
import {
  configureAgendaPort, configureAgendaProbe, liveSeams,
} from '../src/features/reminders/agenda-seam.js'
import { baseConfig, tempHome, FakeOutboundQueue, FakePlatform } from './fakes/contact.js'
import type { SubHost } from '../src/features/plugin-kit.js'

// **第七轮**：验收方式是"**写端口零调用计数**"——不是比最终 JSON。
// 审查说得很对：保存同一个对象也能让 deepEqual 通过，所以"没变"证明不了"没写"。
// 这里直接数**真实发生的写动作**（`fs.rename` 是原子写的最后一步，也是账本隔离用的那一步），
// 外加把 store 的每个写方法都包成计数器。

const OWNER = 10001
const SESSION = `qq-dm-${String(OWNER)}`
const HOUR = 3_600_000

interface WriteCounter {
  readonly renames: number
  /** 每一次 rename 的**落点**（含故障 sidecar）——用来证明"被排除的只有 sidecar，没有别的"。 */
  readonly targets: string[]
  stop: () => void
}

/**
 * 数"真的发生了多少次落盘"：`atomicWriteFile` 的最后一步是 `fs.rename`。
 *
 * **`renames` 只数"状态落盘"，`targets` 记全部**（含故障 sidecar）。为什么排除 sidecar：
 * `<file>.readonly.json` 是**读失败的证据**，按设计必须写（见 `round8-qq.test.ts` 里
 * "故障状态要落成 sidecar，重启后还看得见"那条断言）；把它算进"落盘"会让
 * "提醒状态一个字都没写"这条断言变成**假红**。`targets` 留作逐条证据，断言处再收口。
 *
 * 注：`atomicWriteFile` 的 rename **落点永远是逻辑路径**（临时文件只出现在 rename 的
 * `from`，失败时由 `fs.rm` 收掉），所以 `targets` 里不会出现 `.dsh-tmp-*`。
 */
function countRenames(): WriteCounter {
  const original = fsp.rename
  let renames = 0
  const targets: string[] = []
  fsp.rename = async (...args: Parameters<typeof fsp.rename>) => {
    const target = String(args[1])
    targets.push(target)
    if (!target.endsWith('.readonly.json')) renames += 1
    return await original(...args)
  }
  return {
    get renames() { return renames },
    get targets() { return targets },
    stop: () => { fsp.rename = original },
  }
}

/** 把 store 的**每一个写方法**都计数（调用即算，不管有没有真的落盘）。 */
function countingStore(store: ReminderStore): { store: ReminderStore; calls: Record<string, number> } {
  const calls: Record<string, number> = {}
  const writeMethods = [
    'save', 'add', 'remove', 'markSent', 'markFired', 'markUnknown', 'resolve', 'skipRound', 'expireStale',
    'capBacklog', 'pruneFired', 'setPendingDispatch', 'clearPendingDispatch', 'bumpPendingDispatch',
  ] as const
  const proxy = new Proxy(store, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof prop === 'string' && (writeMethods as readonly string[]).includes(prop) && typeof value === 'function') {
        return async (...args: unknown[]) => {
          calls[prop] = (calls[prop] ?? 0) + 1
          return await (value as (...rest: unknown[]) => Promise<unknown>).apply(target, args)
        }
      }
      return value
    },
  })
  return { store: proxy, calls }
}

const seedFile = (file: string): void => {
  const now = Date.now()
  const rows: Reminder[] = [
    {
      id: 'r_due', text: '到点的一次性', at: now - 60_000, room: 'dm', target: OWNER,
      createdBy: OWNER, created: now - 2 * HOUR, fired: false, firedAt: null, repeat: 'none',
      occurrence: { id: 'occ-due', revision: 1 },
    },
    {
      id: 'r_daily', text: '每天吃药', at: now - 30 * HOUR, room: 'dm', target: OWNER,
      createdBy: OWNER, created: now - 40 * HOUR, fired: false, firedAt: null, repeat: 'daily',
      occurrence: { id: 'occ-daily', revision: 2 },
    },
  ]
  // **故意加"脏东西"**：未知顶层字段 + 未来 version + 需要被 trim 的文本。
  fs.writeFileSync(file, `${JSON.stringify({
    // **不要用 version 99 当哨兵**：新解码器拒绝未知版本并整份锁定，而锁定的 store 本来就不能写，
    // 于是"dryRun 套 0 次写"会变成恒真。这里要测的是 dryRun，不是版本兼容。
    version: 1,
    futureField: { keep: true },
    reminders: rows,
  }, null, 2)}\n`, 'utf8')
}

const makeHost = (
  dir: string,
  dryRun: boolean,
  over: { contact?: unknown, log?: (line: string) => void } = {},
  ownPlatform = new FakePlatform(),
  ownQueue = new FakeOutboundQueue(),
): SubHost => {
  const base = baseConfig({ admins: [OWNER] }) as unknown as QQChannelConfig
  const config = { ...base, workspacePath: dir, reminders: { enabled: true, dryRun, file: null } } as QQChannelConfig
  return {
    config,
    log: over.log ?? (() => {}),
    need: () => ({ api: ownPlatform.api, out: ownQueue }),
    provide: () => {},
    registerResource: () => {},
    bridge: { toolHost: () => ({ register: () => {} }) },
    dshHome: dir,
    get: (name: string) => (name === 'contact' ? over.contact
      : name === 'platform' ? { api: ownPlatform.api, out: ownQueue }
        : undefined),
  } as unknown as SubHost
}

// ── R7-1：启动 load 不再隐式重建文件 ───────────────────────────────────────

test('R7-1 首次 load（文件不存在）**一次写都没有**：不再"空表起步就重建文件"', async () => {
  const home = tempHome('qq-r7-load-')
  const counter = countRenames()
  try {
    const file = path.join(home.dir, 'reminders.json')
    const host = makeHost(home.dir, false)
    const store = new ReminderStore(host.config.reminders, { workspacePath: home.dir, dshHome: home.dir, log: () => {} })
    const { store: counted, calls } = countingStore(store)
    await counted.load()
    assert.equal(counter.renames, 0, `load 不许落盘（实际 rename ${String(counter.renames)} 次）`)
    assert.equal(calls.save ?? 0, 0, 'load 不许调 save()')
    assert.equal(fs.existsSync(file), false, '文件不该被凭空创建（等第一次真实变更）')
  } finally {
    counter.stop()
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})

// ── R7-2：dryRun 下 启动 + 卸载 全程零写入，且脏字段原样保留 ──────────────

test('R7-2 dryRun 下 apply→tick→dispose 全程 **0 次写**：未知字段/未 trim 文本都原样留着', async () => {
  const home = tempHome('qq-r7-dispose-')
  const file = path.join(home.dir, 'reminders.json')
  seedFile(file)
  const before = fs.readFileSync(file, 'utf8')
  const counter = countRenames()
  try {
    const logs: string[] = []
    const host = makeHost(home.dir, true, { log: (line) => { logs.push(line) } })
    const dispose = await remindersPlugin.apply(host) as (() => Promise<void>) | undefined
    // 等一拍（runner 每 30s 一拍，这里不会真的跑到；启动时的日志与 prune 策略才是关键）
    if (dispose !== undefined) await dispose()

    assert.equal(counter.renames, 0, `演练全程不许有任何落盘（实际 ${String(counter.renames)} 次 rename）`)
    assert.equal(fs.readFileSync(file, 'utf8'), before, '文件内容必须逐字节不变（version/未知字段/文本都不许被归一化）')
    assert.equal((JSON.parse(fs.readFileSync(file, 'utf8')) as { version: number }).version, 1, 'version 保持 1（不升版本）')
    assert.ok((JSON.parse(fs.readFileSync(file, 'utf8')) as { futureField?: unknown }).futureField !== undefined,
      '未知顶层字段不许消失')
    assert.ok(logs.some((line) => line.includes('跳过启动清理')), '要说明为什么没清')
    assert.ok(logs.some((line) => line.includes('卸载时**不保存**')), '卸载不保存也要有日志')
  } finally {
    counter.stop()
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})

// ── R7-3：演练期间闸门抛错不许落 unknown ──────────────────────────────────

test('R7-3 dryRun 下闸门抛错：结论 dry-run、**0 次写**、不调 markUnknown', async () => {
  const home = tempHome('qq-r7-gate-')
  const file = path.join(home.dir, 'reminders.json')
  seedFile(file)
  const counter = countRenames()
  try {
    const logs: string[] = []
    const contact = { outboundBudget: async () => { throw new Error('ledger boom') } }
    const host = makeHost(home.dir, true, { contact, log: (line) => { logs.push(line) } })
    const raw = new ReminderStore(host.config.reminders, { workspacePath: home.dir, dshHome: home.dir, log: () => {} })
    await raw.load()
    const { store, calls } = countingStore(raw)
    const reminder = store.list(10).find((item) => item.id === 'r_due')!
    const outcome = await deliverReminder(host, reminder)
    assert.equal(outcome, 'dry-run', '演练里闸门抛错按演练处理，不许变成 unknown')
    assert.equal(calls.markUnknown ?? 0, 0, '**不许调 markUnknown()**')
    assert.equal(counter.renames, 0, '**0 次落盘**')
  } finally {
    counter.stop()
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})

test('R7-3b 非演练下闸门抛错才落 unknown（对照，证明 R7-3 不是恒真）', async () => {
  const home = tempHome('qq-r7-gate2-')
  const file = path.join(home.dir, 'reminders.json')
  // **这条测的是"闸门抛错 ⇒ unknown"，所以必须走到闸门那一步。**
  // `r_due` 是**绑了 occurrence** 的：CAS 会比闸门先跑，而 agenda 服务不在时 CAS 现在回
  // `blocked` ⇒ 本拍 `skipped`（确定没发，下一拍重试），闸门根本轮不到 —— 那不是这条要测的东西。
  // ⇒ 换成**未绑定**的提醒（无 occurrence ⇒ CAS 短路），才真的能测到闸门抛错。
  fs.mkdirSync(home.dir, { recursive: true })
  const unbound = {
    id: 'r_due', text: '到点的一次性', at: Date.now() - 60_000, room: 'dm', target: OWNER,
    createdBy: OWNER, created: Date.now() - 2 * HOUR, fired: false, firedAt: null, repeat: 'none',
  }
  fs.writeFileSync(file, `${JSON.stringify({ version: 1, reminders: [unbound] })}\n`, 'utf8')
  try {
    const contact = { outboundBudget: async () => { throw new Error('ledger boom') } }
    const host = makeHost(home.dir, false, { contact })
    const raw = new ReminderStore(host.config.reminders, { workspacePath: home.dir, dshHome: home.dir, log: () => {} })
    await raw.load()
    const reminder = raw.list(10).find((item) => item.id === 'r_due')!
    assert.equal(await deliverReminder(host, reminder), 'unknown', '非演练：问不出闸门就按 unknown 处理')
  } finally {
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})

// ── R7-4：演练下"读闸门"不许隔离账本 ──────────────────────────────────────

test('R7-4 dryRun 下不碰 contact 账本：不给它"读到损坏就隔离"的机会', async () => {
  const home = tempHome('qq-r7-ledger-')
  const file = path.join(home.dir, 'reminders.json')
  seedFile(file)
  const counter = countRenames()
  try {
    let budgetCalls = 0
    const contact = {
      outboundBudget: async () => {
        budgetCalls += 1
        // 真实实现里这一步在账本损坏/版本不匹配时会 .corrupt + rename；演练绝不该走到这里。
        return { allowed: true, reason: 'ok' }
      },
    }
    const logs: string[] = []
    const host = makeHost(home.dir, true, { contact, log: (line) => { logs.push(line) } })
    const raw = new ReminderStore(host.config.reminders, { workspacePath: home.dir, dshHome: home.dir, log: () => {} })
    await raw.load()
    const reminder = raw.list(10).find((item) => item.id === 'r_due')!
    assert.equal(await deliverReminder(host, reminder), 'dry-run')
    assert.equal(budgetCalls, 0, '演练期不许调用 contact 闸门（它可能隔离账本）')
    assert.equal(counter.renames, 0, '0 次落盘')
    assert.ok(logs.some((line) => line.includes('不评估共享闸门')), '要说明为什么没评估闸门')

    // 对照：非演练时会真的问闸门（证明上面那个 0 不是"压根没实现"）。
    // 这里不关心投递结果（假平台撑不住一次真发），只看"闸门被问了一次"。
    const host2 = makeHost(home.dir, false, { contact })
    const reminder2 = raw.list(10).find((item) => item.id === 'r_due')!
    try {
      await deliverReminder(host2, reminder2)
    } catch { /* 假平台发不出去很正常 */ }
    assert.equal(budgetCalls, 1, '非演练要真的问一次闸门')
  } finally {
    counter.stop()
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})

// ── R7-5：resolver 三态（absent / incompatible / failed）───────────────────

test('R7-5 `incompatible`/`failed` 时 CAS **不放行**（本拍跳过且不消耗）；`absent` 才放行', async () => {
  const home = tempHome('qq-r7-tri-')
  const file = path.join(home.dir, 'reminders.json')
  seedFile(file)
  try {
    const host = makeHost(home.dir, false)
    const raw = new ReminderStore(host.config.reminders, { workspacePath: home.dir, dshHome: home.dir, log: () => {} })
    await raw.load()
    const platform = new FakePlatform()
    const queue = new FakeOutboundQueue()
    const full = {
      ...host,
      get: (name: string) => (name === 'platform' ? { api: platform.api, out: queue } : name === 'reminders' ? raw : undefined),
    } as unknown as SubHost

    // ① incompatible：有对象但缺方法 ⇒ CAS 不放行 ⇒ **不发、也不消耗**。
    configureAgendaPort(null)
    configureAgendaProbe(() => ({ port: null, state: 'incompatible' }))
    configureReminderSeams(liveSeams(() => {}))
    const reminder = raw.list(10).find((item) => item.id === 'r_due')!
    assert.equal(await deliverReminder(full, reminder), 'skipped', '问不出真相 ⇒ 跳过，不当成 ok')
    assert.equal(platform.count(), 0, '不许发')
    assert.equal(raw.list(10).find((item) => item.id === 'r_due')?.fired, false, '**不许消耗**（还会响）')

    // ② failed：探测抛错 ⇒ 同样不放行。
    configureAgendaProbe(() => { throw new Error('probe boom') })
    assert.equal(await deliverReminder(full, reminder), 'skipped')
    assert.equal(platform.count(), 0)

    // ③ absent：宿主没装服务 —— **task-66 起不放行**。
    // 走到 casOccurrence 就说明这条提醒**绑了 occurrence**，"问不出真相"不等于"没绑日程"。
    configureAgendaProbe(() => ({ port: null, state: 'absent' }))
    const outcome = await deliverReminder(full, raw.list(10).find((item) => item.id === 'r_due')!)
    assert.equal(outcome, 'skipped', 'absent + 已绑定 ⇒ 必须 skipped（不许绕过 CAS 投递）')
    assert.equal(platform.count(), 0, '不许真的发出去')
  } finally {
    configureReminderSeams({})
    configureAgendaPort(null)
    configureAgendaProbe(null)
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})

// ── R7-6：CAS 拒绝码必须是两段（not-found 与 incompatible 不能混）─────────

test('R7-6 liveSeams 的 CAS 在不同状态下给出不同理由，调用方分得开', async () => {
  const logs: string[] = []
  try {
    configureAgendaPort(null)
    configureAgendaProbe(() => ({ port: null, state: 'absent' }))
    const absentSeams = liveSeams((line) => { logs.push(line) })
    const absent = await absentSeams.casOccurrence!('occ', 1, { sessionId: SESSION })
    // **task-66**：`absent` 与 `incompatible`/`failed` 口径统一——CAS 一律不放行。
    assert.deepEqual(absent, { ok: false, reason: 'agenda-absent' }, 'absent 也必须不放行（已绑定的提醒不能绕过校验）')

    configureAgendaProbe(() => ({ port: null, state: 'incompatible' }))
    const incompatible = await liveSeams((line) => { logs.push(line) }).casOccurrence!('occ', 1, { sessionId: SESSION })
    assert.equal(incompatible.ok, false)
    assert.equal(incompatible.reason, 'agenda-incompatible')

    configureAgendaProbe(() => { throw new Error('boom') })
    const failed = await liveSeams((line) => { logs.push(line) }).casOccurrence!('occ', 1, { sessionId: SESSION })
    assert.equal(failed.ok, false)
    assert.equal(failed.reason, 'agenda-probe-failed')
    assert.ok(logs.some((line) => line.includes('CAS **不放行**')))
  } finally {
    configureAgendaPort(null)
    configureAgendaProbe(null)
  }
})

// ── R7-7：runner 在 dryRun 下不写（写端口计数版）───────────────────────────

test('R7-7 dryRun 多拍：store 的**所有写方法调用数是 0**（不是"文件没变"）', async () => {
  const home = tempHome('qq-r7-runner-')
  const file = path.join(home.dir, 'reminders.json')
  seedFile(file)
  const counter = countRenames()
  try {
    const host = makeHost(home.dir, true)
    const raw = new ReminderStore(host.config.reminders, { workspacePath: home.dir, dshHome: home.dir, log: () => {} })
    await raw.load()
    const { store, calls } = countingStore(raw)
    const runner = new ReminderRunner(
      store,
      (reminder) => deliverReminder(host, reminder),
      () => {},
      () => true,
      async () => null,
      async () => 'ok' as const,
      () => true,
    )
    for (let tick = 0; tick < 5; tick += 1) await (runner as unknown as { tick(): Promise<void> }).tick()
    assert.deepEqual(calls, {}, `dryRun 下 store 的所有写方法都不许被调用（实际：${JSON.stringify(calls)}）`)
    assert.equal(counter.renames, 0, '0 次落盘')
  } finally {
    counter.stop()
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})

// ── R7-8 **版本不认识 ⇒ 锁定只读、不写盘**（与 dryRun 分开钉住）────────────

test('R7-8 文件写了 version: 99 ⇒ `load()` 必须锁定、count 为 null、一个字都不许写', async () => {
  const home = tempHome('qq-r7-future-')
  const file = path.join(home.dir, 'reminders.json')
  fs.mkdirSync(home.dir, { recursive: true })
  const row = { id: 'r_x', text: 'x', at: Date.now() + 60_000, room: 'dm', target: OWNER, createdBy: OWNER, created: Date.now(), fired: false, firedAt: null, repeat: 'none' }
  fs.writeFileSync(file, `${JSON.stringify({ version: 99, reminders: [row] })}\n`, 'utf8')
  const before = fs.readFileSync(file, 'utf8')
  const counter = countRenames()
  try {
    // ase 不在此作用域 ⇒ 现场取配置（与其它用例一致）。
    const cfg = { ...(baseConfig({ admins: [OWNER] }) as unknown as QQChannelConfig), reminders: { enabled: true, dryRun: false, file: null } } as QQChannelConfig
    const store = new ReminderStore(cfg.reminders, { workspacePath: home.dir, dshHome: home.dir, log: () => {} })
    await store.load()
    assert.equal(store.isReadLocked(), true, '不认识的版本必须锁定（静默读进来再按 v1 写回会丢字段）')
    assert.equal(store.list(10).length, 0, '锁定态内存为空')
    // 锁定态连写都进不去，所以盘上不可能被动。
    await assert.rejects(() => store.add({ text: 'y', at: Date.now() + 60_000, room: 'dm', target: OWNER, createdBy: OWNER }), /只读锁定|READ_LOCKED/)
    assert.equal(fs.readFileSync(file, 'utf8'), before, '原文件必须逐字节不变')
    assert.equal(counter.renames, 0, '一次 rename 都不许发生')
    // **证据收口**：`renames` 排除的**只有**故障 sidecar —— 除它以外一个落点都不许有。
    // （`load()` 读不出/版本不认识时写 sidecar 是设计内行为；写"提醒状态"不是。）
    assert.deepEqual(
      counter.targets.filter((target) => !target.endsWith('.readonly.json')),
      [],
      `除故障 sidecar 外一个字都不许落盘（实际 ${counter.targets.join(',')}）`,
    )
    await store.close()
  } finally {
    counter.stop()
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})
// ── R7-9 **顺序守卫**：闸门拒绝时 occurrence 一次都不许被认领 ──────────────────
// 这条测试存在的唯一意义：**区分"闸门在前"与"CAS 在前"**。
// 没有它，谁把 admit() 里两个调用换回去，全部测试照样绿。

test('R7-9 闸门拒绝 + 已绑定 occurrence ⇒ occurrence 未被认领、本拍 skipped', async () => {
  const home = tempHome('qq-r7-order-')
  const file = path.join(home.dir, 'reminders.json')
  seedFile(file)
  const counter = countRenames()
  try {
    // 闸门**拒绝**（静默时段之类）。
    const contact = { outboundBudget: async () => ({ allowed: false, reason: 'quiet-hours' }) }
    const host = makeHost(home.dir, false, { contact })
    // 数 CAS：任何一次认领都要被看见。
    let casCalls = 0
    configureReminderSeams({
      casOccurrence: async () => {
        casCalls += 1
        return { ok: true }
      },
    })
    const raw = new ReminderStore(host.config.reminders, { workspacePath: home.dir, dshHome: home.dir, log: () => {} })
    await raw.load()
    const reminder = raw.list(10).find((item) => item.id === 'r_due')!
    assert.notEqual(reminder.occurrence, undefined, '前提：这条提醒**已绑定** occurrence')

    const outcome = await deliverReminder(host, reminder)

    // 核心断言：闸门先跑，CAS **一次都没被调用** ⇒ 日程里那一次没被吃掉。
    assert.equal(casCalls, 0, '闸门拒绝时**一次都不许**认领 occurrence（认领即消耗 ⇒ 静默丢事件）')
    assert.equal(outcome, 'skipped', '本拍跳过（下一拍重试），不是 unknown')
    const after = raw.list(10).find((item) => item.id === reminder.id)!
    assert.deepEqual(after.occurrence, reminder.occurrence, 'occurrence 与 revision 必须原样')
    assert.equal(after.fired, false, '没有被消耗')
    assert.equal(counter.renames, 0, '这一拍一个字都不许落盘')
    await raw.close()
  } finally {
    counter.stop()
    configureReminderSeams({})
    fs.rmSync(home.dir, { recursive: true, force: true })
  }
})
