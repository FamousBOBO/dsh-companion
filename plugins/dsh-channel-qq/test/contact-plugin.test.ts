/** **插件级闭环**：真的跑 `contactPlugin.apply()` + `start()`，从真实来源事件走到账本。
 *
 * 为什么单列一个文件：其余 contact 测试都是"拿一个函数/一个类来测"，这一份测的是**装配**——
 * `src/features/contact/index.ts` 里那些 `host.get(...)` 和闭包是不是真的接对了。装配错了
 * 单元测试全绿也没用（"提醒到期 → 候选 → 门控 → 发送 → 账本"这条链一个环节没连上，
 * 线上表现就是"开关打开后什么都不发生"）。
 *
 * 时钟：`index.ts` 用 `systemClock`（已知可测性缺口 V-I1），所以这里**不假装有假时钟**：
 *   - 装配时把 `pollIntervalMs` 设成一小时，真实 `setInterval` 在测试期间根本不会触发；
 *   - 用资源面暴露的 `actions.tick()` **显式驱动**每一拍（走的是真 `apply()` 出来的 worker）；
 *   - 等首拍/等结果用 `waitUntil`（真实定时器），不用 `setImmediate` 轮询。
 * 于是"插件级闭环"是确定性的，而"插件级**时间语义**"（免打扰/冷却/跨日）不在这里测——
 * 那些已在 gate/worker 层用假时钟覆盖（G08–G13、H01/H10）。
 *
 * 装配口径：`sendMode='turn'`。`direct` 模式需要真实模型接缝（`draft-host.ts` 走宿主
 * `bridge.tagContext()`），本地 mock 拿不到——那是与"真实模型未做"同类的缺口，不在这里假装。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import type { QQChannelConfig } from '../src/config.js'
import type { ContactService } from '../src/features/contact/types.js'
import {
  FakeOutboundQueue, FakePlatform, FakeTurns, tempHome, baseConfig, fieldDefaults, fakeSubHost, waitUntil,
  waitCandidatesSettled,
} from './fakes/contact.js'

const { CONTACT_GROUPS } = await import('../src/config/sections/contact.js')
const { contactPlugin } = await import('../src/features/contact/index.js')

// ── 脚手架 ──────────────────────────────────────────────────────────────────

/** 一条到点的提醒（形状照 `sources.ts` 的 `ReminderLike` 窄面）。 */
interface FakeReminder {
  id: string
  text: string
  at: number
  room: 'group' | 'dm'
  target: number
  createdBy: number
  created: number
  fired: boolean
}

interface PluginRig {
  cfg: QQChannelConfig
  platform: FakePlatform
  turns: FakeTurns
  queue: FakeOutboundQueue
  home: ReturnType<typeof tempHome>
  logs: string[]
  bag: Record<string, unknown>
  resources: Record<string, unknown>
  /** 假宿主本体（P00 要手工驱动装配）。 */
  host: Parameters<typeof contactPlugin.apply>[0]
  /** 假提醒存储：`due()` 返回所有 `fired=false` 的（runner 关着，没人会把它们标成已发）。 */
  reminders: FakeReminder[]
  /** 真 `apply()` + `start()`；等首拍落地。 */
  boot(): Promise<void>
  /** 经唯一对外入口提一条候选（撤销接管后，候选只能这样进来）。 */
  propose(input: Record<string, unknown>): Promise<{ outcome: string; candidateId: string | null; note: string }>
  /** 假时钟不存在时的替代物：这里用宿主真实时间（插件级时钟由 index.ts 持有）。 */
  clock: { now(): number }
  /** 显式驱动一拍（走真装配出来的 worker）。 */
  tick(): Promise<void>
  /** 账本（从临时 dshHome 里读，证明"落盘"也是真的）。 */
  ledger(): { candidates: Record<string, { state: string; dedupeKey: string; source: string }>; outbox: Record<string, { state: string }> }
  dispose(): Promise<void>
}

function makePluginRig(
  over: Partial<QQChannelConfig['contact']> = {},
  options: { remindersEnabled?: boolean; preCreateDir?: boolean } = {},
): PluginRig {
  const home = tempHome('qq-contact-plugin-')
  const now = Date.now()
  const cfg = baseConfig({
    contact: {
      ...(fieldDefaults(CONTACT_GROUPS) as unknown as QQChannelConfig['contact']),
      // 闭环要能真的走到发送：三道闸全开、turn 模式（不需要模型）、免打扰关掉。
      enabled: true,
      dryRun: false,
      allowExternalSend: true,
      sendMode: 'turn',
      draftModel: false,
      timezone: '',
      quietHours: [],
      // 一小时一拍：真实 setInterval 在测试期间等于不存在，推进由 tick() 显式驱动。
      pollIntervalMs: 3_600_000,
      maxPerTick: 1,
      ...over,
    },
  })
  const fake = fakeSubHost('contact', cfg, home.dir)
  const platform = new FakePlatform()
  const turns = new FakeTurns()
  const queue = new FakeOutboundQueue()
  const reminders: FakeReminder[] = [{
    id: 'r-1',
    text: '喝水',
    at: now - 60_000,
    room: 'dm',
    target: 10001,
    createdBy: 10001,
    created: now - 3_600_000,
    fired: false,
  }]
  const ledgerFile = path.join(home.dir, 'channel-qq', 'contact.json')

  // V-P1（全新 dshHome 上引擎不启动）**已修**：`LeaseKeeper.create()` 前会 `mkdir -p` 父目录。
  // 所以这里**不再**预建目录——所有用例都跑在"新装 profile"的真实形态上，`P00` 守着这条。
  if (options.preCreateDir === true) {
    mkdirSync(path.join(home.dir, 'channel-qq'), { recursive: true })
  }

  // 装"装载顺序在前"的服务：platform（通道 + 出站链）、inbound（回合入口）、reminders（来源）。
  fake.with('platform', {
    client: {} as never,
    platform,
    api: platform.api,
    out: queue,
  } as never)
  fake.with('inbound', {
    registry: { get: () => undefined, set: () => {}, delete: () => false, list: () => [] },
    turns,
    notices: {} as never,
    pipeline: {} as never,
  } as never)
  fake.with('reminders', {
    due: (at: number) => reminders.filter((item) => !item.fired && item.at <= at),
  } as never)

  // `remindersEnabled` 判据来自"提醒 runner 是否在跑"，插件侧读的是配置里的 `reminders.enabled`。
  if (options.remindersEnabled === true) {
    cfg.reminders = { ...cfg.reminders, enabled: true } as QQChannelConfig['reminders']
  } else {
    cfg.reminders = { ...cfg.reminders, enabled: false } as QQChannelConfig['reminders']
  }

  const rig: PluginRig = {
    cfg, platform, turns, queue, home, reminders,
    get logs() { return fake.logs },
    bag: fake.bag as Record<string, unknown>,
    resources: fake.resources,
    host: fake.host,
    boot: async () => {
      await contactPlugin.apply(fake.host)
      contactPlugin.start?.(fake.host)
      // `enabled=true` 时首拍会去抢租约并落盘账本：等**账本**出现，而不是等锁文件。
      // （锁文件在 `open('wx')` 那一刻就存在了，账本要等 `acquireLease` 落盘，两者之间
      //   有真实 I/O 的时间差——等错东西会读到"锁在、账本不在"的中间态。）
      if (cfg.contact.enabled) {
        await waitUntil(() => existsSync(ledgerFile), 3_000)
      }
    },
    propose: async (input) => {
      const service = fake.bag.contact as { propose(value: unknown): Promise<{ outcome: string; candidateId: string | null; note: string }> } | undefined
      if (service === undefined) throw new Error("contact 服务不在袋子里：装配没跑起来")
      return await service.propose(input)
    },
    clock: { now: () => Date.now() },
    tick: async () => {
      const resource = fake.resources.contact as { actions?: { tick?: () => Promise<{ ok: boolean }> } } | undefined
      assert.notEqual(resource, undefined, '插件应当注册 `contact` 资源（诊断面 + 测试的显式推进入口）')
      assert.equal(typeof resource?.actions?.tick, 'function', '资源应当暴露 actions.tick')
      await resource!.actions!.tick!()
      // **为什么要等**：`start()` 里 `void worker.tick()` 掷出的首拍若还没跑完，worker 的
      // `busy` 会让上面这一拍只记一次 `pendingTickAt` 就返回（产品有意：丢一拍=丢一分钟），
      // 于是"await 一次 tick"并不等于"跑完了"，紧接着的断言会看到 `pending` 中间态。
      // 等不到会**抛错**（不是放行）：真有 tick 卡死时这条测试必须红。
      await waitCandidatesSettled(() => (fake.bag.contact as ContactService).status())
    },
    ledger: () => JSON.parse(readFileSync(ledgerFile, 'utf-8')) as ReturnType<PluginRig['ledger']>,
    dispose: async () => {
      const disposers = fake.host as unknown as { disposeAll?: () => Promise<void> }
      await disposers.disposeAll?.()
      home.cleanup()
    },
  }
  return rig
}

/** 一条普通「想起来问一句」的候选（`follow-up`）。撤销接管后这是唯一进池的正路。 */
const FOLLOW_UP_KEY = 'followup:dm-10001:idle'

function followUpInput(rig: PluginRig): Record<string, unknown> {
  const now = rig.clock.now()
  return {
    source: 'follow-up',
    reason: '你最近一直在忙，想问问你在忙什么',
    evidenceSource: 'chatlog',
    evidenceIds: ['msg-1'],
    scope: { userId: 10001, personaId: '', worldId: '' },
    target: { channel: 'qq', room: 'dm-10001', isGroup: false, chatId: 10001 },
    priority: 0,
    earliestAt: now - 60_000,
    expiresAt: now + 6 * 3_600_000,
    dedupeKey: FOLLOW_UP_KEY,
    // `standing` 也要凭据：谁在什么时候说过"可以主动找我"
    authorization: { kind: 'standing', by: 10001, at: now - 86_400_000 },
  }
}

function candidatesOf(rig: PluginRig): Array<{ id?: string; state: string; dedupeKey: string; source: string }> {
  return Object.values(rig.ledger().candidates)
}

// ── P00：全新 dshHome（V-P1 回归，当前应为红） ──────────────────────────────

test('P00 全新 dshHome：首拍必须真的拿到租约、建出账本、跑完一轮不抛（V-P1）', async () => {
  // 不预建 `<dshHome>/channel-qq/`：这是"新装 profile"的真实形态。
  // 注意：这里**不**断言"发出去一条"——默认配置不接管提醒（`sourceReminders=false`），
  // 所以"没有候选"是正确行为；发送能力由 P01 证明。P00 只钉"引擎真的跑起来了"。
  const rig = makePluginRig({}, { preCreateDir: false })
  try {
    // 不用 `boot()`（它会等租约超时）：手工装配，然后把结论一次说清。
    await contactPlugin.apply(rig.host)
    contactPlugin.start?.(rig.host)
    // 首拍是 fire-and-forget：给它充分的时间（真实文件 I/O）
    await new Promise<void>((resolve) => setTimeout(resolve, 300))
    // **round7**：这里以前是 `.catch(() => {})`——把错误**吞掉**了，于是 P00 偶发红的时候
    // 手上什么证据都没有（只剩"连锁文件没建出来"这种二手结论）。现在把错误记下来，
    // 失败时随断言一起打印；同时把每次 tick 的成败次数也记进日志。
    let tickError: unknown = null
    try {
      await rig.tick()
    } catch (error) {
      tickError = error
      rig.logs.push(`[P00] tick 抛错：${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`)
    }
    if (tickError !== null) {
      const detail = tickError instanceof Error ? (tickError.stack ?? tickError.message) : String(tickError)
      rig.logs.push(`[P00] tick 错误栈：\n${detail}`)
    }

    const lock = path.join(rig.home.dir, 'channel-qq', 'contact.lock')
    const ledger = path.join(rig.home.dir, 'channel-qq', 'contact.json')
    const joined = rig.logs.join('\n')
    assert.equal(
      existsSync(lock),
      true,
      `V-P1：全新 dshHome 上连锁文件都没建出来 —— 引擎一次都没跑起来。日志：\n${joined}`,
    )
    assert.equal(existsSync(ledger), true, `V-P1：账本没有落盘。日志：\n${joined}`)
    assert.equal(rig.cfg.contact.enabled, true, '前置：开关是开着的')
    // 一轮跑完的标志：拿到租约的日志出现（且没有"租约在别的实例手里"这句误导话术）
    assert.ok(joined.includes('取得租约'), `没看到取租约的日志：\n${joined}`)
    assert.equal(
      joined.includes('租约在别的实例手里'),
      false,
      `全新 dshHome 上不该出现"多开"的判断（那是 V-P1 的误导话术）：\n${joined}`,
    )
    // 默认不接管提醒 → 零候选、零提交（这条同时是 F1 的默认口径，见 P08）
    assert.equal(rig.turns.booked.length, 0, `默认配置不该接管提醒：\n${joined}`)
  } finally {
    await rig.dispose()
  }
})

// ── P01：闭环正路 ───────────────────────────────────────────────────────────

test('P01 插件级闭环：候选 → 门控 → 回合提交 → 账本 submitted（撤销接管后改用 propose 注入）', async () => {
  const rig = makePluginRig()
  try {
    await rig.boot()
    // 第四轮：sources.ts 已删除，提醒不再是候选来源 → 候选由测试经**唯一对外入口**
    // service.propose 注入。闭环断言的部分一个字没少：候选入库 → 门控 → 提交 → 账本。
    const outcome = await rig.propose(followUpInput(rig))
    assert.equal(outcome.outcome, 'accepted', `候选应当被接受，实际 ${outcome.outcome}/${outcome.note}`)
    await rig.tick()
    await waitUntil(() => rig.turns.booked.length >= 1, 3_000)

    // 1) 候选真的入库了（来源/去重键都对）
    const candidates = candidatesOf(rig)
    assert.equal(candidates.length, 1, `应当恰好一条候选，实际：${JSON.stringify(candidates)}`)
    assert.equal(candidates[0]!.source, 'follow-up')
    assert.equal(candidates[0]!.dedupeKey, FOLLOW_UP_KEY)

    // 2) 门控放行 → 回合真的收到了一次提交（turn 模式没有平台回执，只能到 submitted）
    assert.equal(rig.turns.booked.length, 1, `回合应当被提交一次，日志：\n${rig.logs.join('\n')}`)
    assert.equal(rig.turns.booked[0]!.room, 'dm-10001')
    assert.match(rig.turns.booked[0]!.prompt, /在忙什么/, '提交给回合的文案要带上候选的原因')

    // 3) 账本落盘：候选已消费、投递是 submitted（不是 confirmed——turn 模式拿不到回执）
    await waitUntil(() => Object.values(rig.ledger().outbox).length >= 1, 3_000)
    await waitUntil(() => candidatesOf(rig)[0]?.state === 'consumed', 3_000)
    const outbox = Object.values(rig.ledger().outbox)
    assert.equal(outbox.length, 1)
    assert.equal(outbox[0]!.state, 'submitted')
    assert.equal(candidatesOf(rig)[0]!.state, 'consumed')

    // 4) 再拍一次不会重复提交（候选已消费 + 去重键已递出）
    await rig.tick()
    assert.equal(rig.turns.booked.length, 1, '同一件事不许第二拍再来一次')
  } finally {
    await rig.dispose()
  }
})

test('P02 同一个 dedupeKey 只提一条候选：重复 tick 不重复提交', async () => {
  const rig = makePluginRig()
  try {
    await rig.boot()
    const first = await rig.propose(followUpInput(rig))
    assert.equal(first.outcome, 'accepted')
    // 同一个键再提一次：必须是 duplicate，不许在池子里堆第二条
    const second = await rig.propose(followUpInput(rig))
    assert.equal(second.outcome, 'duplicate', `同键第二次 propose 应当 duplicate，实际 ${second.outcome}`)
    await rig.tick()
    await waitUntil(() => rig.turns.booked.length >= 1, 3_000)
    await rig.tick()
    await rig.tick()
    const keys = candidatesOf(rig).map((item) => item.dedupeKey)
    assert.equal(keys.length, 1, `同一 dedupeKey 只许有一条候选，实际：${JSON.stringify(keys)}`)
    assert.equal(rig.turns.booked.length, 1, '同一件事只提交一次')
  } finally {
    await rig.dispose()
  }
})

test('P10 判据级：explicit-reminder 候选一律 drop(reminders-owns)——装配全开也不出门', async () => {
  // 撤销接管之后的**唯一**口径：到期提醒归 reminders 插件，contact 不投递这类事件，
  // 所以门控对这类来源一律 drop，且与任何开关无关（配置里已没有接管开关）。
  const rig = makePluginRig()
  try {
    await rig.boot()
    const outcome = await rig.propose({
      ...followUpInput(rig),
      source: 'explicit-reminder',
      dedupeKey: 'reminder:r-9:1700000000000',
      authorization: { kind: 'explicit', by: 10001, at: rig.clock.now() - 3_600_000, quote: '提醒我喝水' },
      reason: '你之前让我提醒你：喝水',
    })
    assert.equal(outcome.outcome, 'accepted', '候选本身是合法的（凭证齐全），要被门控拦下而不是拒绝入库')
    await rig.tick()
    await new Promise<void>((resolve) => setTimeout(resolve, 250))
    assert.equal(rig.turns.booked.length, 0, `提醒归 reminders 插件，contact 一律不发。日志：\n${rig.logs.join('\n')}`)
    assert.equal(rig.platform.count(), 0)
    const candidate = candidatesOf(rig)[0]
    assert.equal(candidate?.state, 'cancelled', `候选应当被 drop 成 cancelled，实际 ${candidate?.state}`)
    assert.match(
      JSON.stringify(rig.logs),
      /reminders-owns/,
      `日志里要能看见稳定原因 reminders-owns：\n${rig.logs.join('\n')}`,
    )
  } finally {
    await rig.dispose()
  }
})
test('P04 enabled=false：装配跑通但零候选零发送（默认装上去就是静默的）', async () => {
  const rig = makePluginRig({ enabled: false })
  try {
    await rig.boot()
    await rig.tick()
    await rig.tick()
    assert.equal(rig.turns.booked.length, 0)
    assert.equal(rig.platform.count(), 0)
    // 关着的时候连账本都不该建——所以这里不能"读候选"，只能断言文件不存在。
    assert.equal(existsSync(path.join(rig.home.dir, 'channel-qq', 'contact.json')), false, '关着时连账本都不该建')
    assert.equal(existsSync(path.join(rig.home.dir, 'channel-qq', 'contact.lock')), false, '关着时也不该抢锁')
  } finally {
    await rig.dispose()
  }
})

test('P05 dryRun=true：候选照提、门控照判，但一次都不出网（演练不是"什么都不做"）', async () => {
  const rig = makePluginRig({ dryRun: true })
  try {
    await rig.boot()
    // 没有内建来源：先显式提一条候选，才有"本来要发什么"可演练
    assert.equal((await rig.propose(followUpInput(rig))).outcome, 'accepted')
    await rig.tick()
    await waitUntil(() => existsSync(path.join(rig.home.dir, 'channel-qq', 'contact.json')), 3_000)
    await waitUntil(() => candidatesOf(rig).length >= 1, 3_000)
    assert.equal(rig.turns.booked.length, 0, '演练模式下不许真的交给回合')
    const candidates = candidatesOf(rig)
    assert.equal(candidates.length, 1, '演练模式仍然要把候选记下来（否则看不出"本来要发什么"）')
    assert.notEqual(candidates[0]!.state, 'consumed', '演练不算发过，候选不该被消费')
  } finally {
    await rig.dispose()
  }
})

// ── P07：`propose` 的按键幂等与证据合并 ────────────────────────────────────

test('P07 同一 dedupeKey 并发两次 propose：池子里只留一条，第二次判 duplicate', async () => {
  const rig = makePluginRig()
  try {
    await rig.boot()
    const service = rig.bag.contact as {
      propose(input: unknown): Promise<{ outcome: string; candidateId: string | null; note: string }>
    }
    const now = Date.now()
    const base = {
      source: 'explicit-reminder',
      reason: '你之前让我提醒你：交房租',
      evidenceSource: 'reminders',
      evidenceIds: ['r-rent'],
      scope: { userId: 10001, personaId: '', worldId: '' },
      target: { channel: 'qq', room: 'dm-10001', isGroup: false, chatId: 10001 },
      priority: 0,
      earliestAt: now - 60_000,
      expiresAt: now + 3_600_000,
      dedupeKey: 'reminder:r-rent:1700000000000',
      authorization: { kind: 'explicit', by: 10001, at: now - 3_600_000, quote: '交房租' },
    }
    // 并发两次（首拍 vs 显式 tick、两个来源同时提同一件事的真实形态）
    const [first, second] = await Promise.all([service.propose(base), service.propose(base)])

    const same = candidatesOf(rig).filter((item) => item.dedupeKey === base.dedupeKey)
    assert.equal(same.length, 1, `同一个 dedupeKey 只许有一条候选（查重与入池必须是同一个事务），实际 ${String(same.length)} 条`)
    const outcomes = [first.outcome, second.outcome].sort()
    assert.deepEqual(outcomes, ['accepted', 'duplicate'], `两次 propose 应当一次 accepted、一次 duplicate，实际 ${outcomes.join('/')}`)
    assert.equal(first.candidateId ?? second.candidateId, same[0]!.id as string, 'duplicate 也要把既有候选 id 返回给调用方')

    // 同一件事再来一次、但带了新证据：不得新建候选，只把 evidenceIds 合并进去
    const richer = await service.propose({ ...base, evidenceIds: ['r-rent', 'chat-1'] })
    assert.equal(richer.outcome, 'duplicate')
    const after = candidatesOf(rig).filter((item) => item.dedupeKey === base.dedupeKey)
    assert.equal(after.length, 1, '带新证据也不许新建候选')
    const evidence = ((after[0] as unknown as { evidenceIds?: string[] }).evidenceIds ?? []).slice().sort()
    assert.ok(
      evidence.includes('chat-1'),
      `新证据应当被合并进既有候选，实际 evidenceIds=${JSON.stringify(evidence)}`,
    )
  } finally {
    await rig.dispose()
  }
})

// ── P06：诊断面 ────────────────────────────────────────────────────────────

test('P06 服务面与资源面都在：`contact` 服务可取、资源可 tick、诊断不含凭据', async () => {
  const rig = makePluginRig()
  try {
    await rig.boot()
    const service = rig.bag.contact as { status?: () => unknown; propose?: unknown } | undefined
    assert.notEqual(service, undefined, '`contact` 服务必须装进服务袋（别的子插件只能通过它提候选）')
    assert.equal(typeof service?.status, 'function')
    assert.equal(typeof service?.propose, 'function')
    assert.equal(typeof (service as { sendNow?: unknown }).sendNow, 'undefined', '刻意没有 sendNow：发送只能由 worker 在门控之后发生')

    const status = service!.status!()
    assert.notEqual(status, undefined)
    const text = JSON.stringify(status)
    // 日志/诊断不许带凭据或完整 URL（本轮只检查最容易被误带上的两种）
    for (const needle of ['secret', 'access_token', 'http://', 'https://', 'Bearer ']) {
      assert.equal(text.includes(needle), false, `诊断输出里不该出现 ${needle}`)
    }
  } finally {
    await rig.dispose()
  }
})
