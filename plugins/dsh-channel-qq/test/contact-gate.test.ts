/** 主动消息的**门控**（`features/contact/gate.ts`）：逐个 reason 钉住，外加顺序契约。
 *
 * 为什么这个文件必须存在：`evaluateGate` 是「最终授权由代码强制」的**唯一**落点。
 * 模型只起草；要不要发由这个纯函数说。所以它的每一条 reason 都要有可复现的用例，
 * 否则"免打扰真的生效了吗""额度用完了吗"只能靠读代码相信。
 *
 * 写法约定：
 *   - 所有时间钉在 **Asia/Shanghai**，用 `sh()` 从 UTC 造出确定毫秒，不依赖运行机器的
 *     TZ（否则同一条断言在 CI 与本机可能相反）；
 *   - 配置一律从 `defaultContactConfig()` 起步再覆盖：默认值只有一处来源，
 *     测试不复制第二份数字（改了默认值，这里该跟着动的是"预期"而不是"噪音"）；
 *   - 每个用例同时断言 **verdict 与 reason**：只断言"没发"是不够的——
 *     `defer` 与 `drop` 的差别决定这条候选以后还会不会被问。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ContactCandidate, ContactCounters, ContactRuntimeFacts } from '../src/features/contact/types.js'
import { emptyCounters } from '../src/features/contact/types.js'
import type { ContactConfig } from '../src/config/sections/contact.js'
import { fieldDefaults } from './fakes/contact.js'

const { CONTACT_GROUPS } = await import('../src/config/sections/contact.js')
const { authorizeOutbound, evaluateGate, GATE_REASONS, GATE_STEPS } = await import('../src/features/contact/gate.js')

/**
 * 段定义的默认值。
 *
 * 注意：`src/config/sections/contact.ts` 曾经导出一个 `defaultContactConfig()`，后来被移除
 * （见审查发现 V-C2）。测试改为自己从 `CONTACT_GROUPS` 的 `spec.default` 读——
 * **仍然只有一处来源**，不在测试里抄第二份数字。
 */
function defaultContactConfig(): ContactConfig {
  return fieldDefaults(CONTACT_GROUPS) as unknown as ContactConfig
}

type GateDecision = { verdict: 'send' | 'defer' | 'drop'; reason: string }

/** 上海时间（+08:00）→ 毫秒。`sh(17, 3)` = 2026-10-17 03:00 +08:00。 */
function sh(day: number, hour: number, minute = 0): number {
  return Date.UTC(2026, 9, day, hour - 8, minute, 0, 0)
}

/** 开启门控的配置（默认全是关的：`enabled=false` 在最前面就会 defer 掉一切）。 */
function gateConfig(overrides: Partial<ContactConfig> = {}): ContactConfig {
  return {
    ...defaultContactConfig(),
    enabled: true,
    dryRun: false,
    allowExternalSend: true,
    timezone: 'Asia/Shanghai',
    quietHours: [],
    ...overrides,
  }
}

function candidate(overrides: Partial<ContactCandidate> = {}): ContactCandidate {
  return {
    id: 'c-1',
    source: 'follow-up',
    reason: '跟进上次说的部署',
    evidenceSource: 'chatlog',
    evidenceIds: [],
    scope: { userId: 10001, personaId: 'nono', worldId: '' },
    target: { channel: 'qq', room: 'dm-10001', isGroup: false, chatId: 10001 },
    priority: 0,
    // 默认"四小时前就该发了"：既过了时间窗，又没有越过 maxCatchupHours（24h）的补算视界。
    earliestAt: sh(17, 10, 0),
    expiresAt: Number.MAX_SAFE_INTEGER,
    dedupeKey: 'followup:dm-10001:deploy',
    version: 1,
    authorization: { kind: 'none', by: null, at: null, quote: null },
    state: 'pending',
    attempts: 0,
    createdAt: 0,
    updatedAt: 0,
    lastSuppressedReason: null,
    ...overrides,
  }
}

function runtime(overrides: Partial<ContactRuntimeFacts> = {}): ContactRuntimeFacts {
  return {
    connected: true,
    roomBound: true,
    turnRunningByRoom: {},
    toolRunning: false,
    lastUserMessageAtByRoom: {},
    deliveredDedupeKeys: [],
    ...overrides,
  }
}

function counters(overrides: Partial<ContactCounters> = {}): ContactCounters {
  return { ...emptyCounters('2026-10-17'), ...overrides }
}

/** 一次判定（默认一切正常，只测被覆盖的那一项）。 */
function decide(over: {
  candidate?: Partial<ContactCandidate>
  config?: Partial<ContactConfig>
  counters?: Partial<ContactCounters>
  runtime?: Partial<ContactRuntimeFacts>
  now?: number
  deliveryDedupeKeys?: string[]
} = {}): GateDecision {
  const now = over.now ?? sh(17, 14, 0)
  const candidateOver: Partial<ContactCandidate> = over.candidate ?? {}
  return evaluateGate({
    // `earliestAt` 默认跟着 `now` 走（一小时前）：否则把 `now` 挪到第二天就会先撞上
    // `maxCatchupHours` 的补算视界，测出来的是 stale 而不是被测的那一项。
    candidate: candidate({ earliestAt: now - 3_600_000, ...candidateOver }),
    now,
    config: gateConfig(over.config),
    counters: counters(over.counters),
    runtime: runtime(over.runtime),
    deliveryDedupeKeys: over.deliveryDedupeKeys ?? [],
  })
}

// ── 基线 ────────────────────────────────────────────────────────────────────

test('G00 一切正常时放行（`send`/`ok`）——后面所有"没发"的断言都以这条为对照', () => {
  assert.deepEqual(decide(), { verdict: 'send', reason: 'ok' })
})

test('G00b 纯函数：同一份输入永远同一结论，且结论只由注入的输入决定', () => {
  const input = {
    candidate: candidate({ earliestAt: sh(17, 15, 0) }),
    now: sh(17, 14, 0),
  }
  const a = decide(input)
  const b = decide(input)
  assert.deepEqual(a, b)
  // 只把时间推到 earliestAt：同一份候选从 defer 变 send，说明它读的是参数而不是别处。
  assert.deepEqual(decide({ ...input, now: sh(17, 15, 0) }), { verdict: 'send', reason: 'ok' })
})

// ── 总开关与终态 ────────────────────────────────────────────────────────────

test('G01 默认配置（enabled=false）：defer/disabled，候选留着但一条都不发', () => {
  const defaults = defaultContactConfig()
  assert.equal(defaults.enabled, false, '默认必须关着')
  assert.equal(defaults.dryRun, true, '默认必须演练')
  assert.equal(defaults.allowExternalSend, false, '默认不许真实外发')
  assert.deepEqual(decide({ config: { enabled: false } }), { verdict: 'defer', reason: 'disabled' })
})

test('G02 终态一律 drop，且**终态优先于总开关**（关着也不能让取消的候选以后复活）', () => {
  for (const state of ['cancelled', 'expired', 'consumed'] as const) {
    assert.deepEqual(decide({ candidate: { state } }), { verdict: 'drop', reason: state })
    // 总开关关着时，终态仍然是 drop（不是 defer）：它永远不会再被发。
    assert.deepEqual(decide({ candidate: { state }, config: { enabled: false } }), { verdict: 'drop', reason: state })
  }
  // deferred 不是终态：还能被再判一次。
  assert.equal(decide({ candidate: { state: 'deferred' } }).verdict, 'send')
})

// ── 时间窗 ──────────────────────────────────────────────────────────────────

test('G03 时间窗：没到 earliestAt → defer/not-due；到 expiresAt → drop/expired', () => {
  const earliest = sh(17, 15, 0)
  assert.deepEqual(decide({ candidate: { earliestAt: earliest } }), { verdict: 'defer', reason: 'not-due' })
  assert.deepEqual(
    decide({ candidate: { earliestAt: earliest }, now: earliest - 1 }),
    { verdict: 'defer', reason: 'not-due' },
  )
  // 边界：earliestAt 整点放行（闭区间起点）
  assert.equal(decide({ candidate: { earliestAt: earliest }, now: earliest }).verdict, 'send')

  const expires = sh(17, 13, 0)
  assert.deepEqual(decide({ candidate: { expiresAt: expires } }), { verdict: 'drop', reason: 'expired' })
  // 边界：expiresAt 整点已经过期（半开区间：`now >= expiresAt` 即丢）
  assert.deepEqual(decide({ candidate: { expiresAt: sh(17, 14, 0) } }), { verdict: 'drop', reason: 'expired' })
  // 还差 1ms 才到 expiresAt：仍然可发
  assert.equal(decide({ candidate: { expiresAt: sh(17, 14, 0) + 1 } }).verdict, 'send')
})

test('G03b 补算视界 T04：停机八小时后堆着的旧候选不再补发（stale:restart）', () => {
  const now = sh(17, 14, 0)
  const horizon = defaultContactConfig().maxCatchupHours * 3_600_000
  // 刚好在视界上：还能发（`>` 才是 stale）
  assert.equal(decide({ now, candidate: { earliestAt: now - horizon } }).verdict, 'send')
  // 超出 1 分钟：按过期丢，不是"攒一波全发出去"
  assert.deepEqual(
    decide({ now, candidate: { earliestAt: now - horizon - 60_000 } }),
    { verdict: 'drop', reason: 'stale:restart' },
  )
  // 八小时前（重启后常见的场景）：仍在 24h 视界内 → 照常（真正常见的是被免打扰/竞争挡住）
  assert.equal(decide({ now, candidate: { earliestAt: now - 8 * 3_600_000 } }).verdict, 'send')
  // 视界 0 = 关闭该判据
  assert.equal(
    decide({ now, config: { maxCatchupHours: 0 }, candidate: { earliestAt: now - 90 * 3_600_000 } }).verdict,
    'send',
  )
})

// ── 授权 / 作用域 / 绑定 ────────────────────────────────────────────────────

test('G04 伪造的授权（缺 by/at）→ drop/authorization-invalid；只有 none 允许空授权', () => {
  for (const kind of ['explicit', 'standing'] as const) {
    assert.deepEqual(
      decide({ candidate: { authorization: { kind, by: null, at: null, quote: null } } }),
      { verdict: 'drop', reason: 'authorization-invalid' },
      `${kind} 说不出"谁在什么时候许可的"，与没有授权同义`,
    )
    assert.deepEqual(
      decide({ candidate: { authorization: { kind, by: 10001, at: null, quote: '明早叫我' } } }),
      { verdict: 'drop', reason: 'authorization-invalid' },
      `${kind} 缺授权时刻也是伪造`,
    )
    // 完整授权可以走（仍受后面所有门控约束）
    assert.equal(
      decide({ candidate: { authorization: { kind, by: 10001, at: sh(17, 9), quote: '明早叫我' } } }).verdict,
      'send',
      `${kind} 带齐 by/at 应当放行`,
    )
  }
  // none 是唯一允许空授权的形态（模型/规则自己想到的），它照样要过后面所有门控。
  assert.equal(decide({ candidate: { authorization: { kind: 'none', by: null, at: null, quote: null } } }).verdict, 'send')
})

test('G05 明确提醒不进本账本：explicit-reminder → drop/reminders-owns（提醒与闲聊的分界）', () => {
  const reminder = candidate({
    source: 'explicit-reminder',
    authorization: { kind: 'explicit', by: 10001, at: sh(17, 9), quote: '明早七点叫我' },
    dedupeKey: 'reminder:r_abc',
  })
  assert.deepEqual(decide({ candidate: reminder }), { verdict: 'drop', reason: 'reminders-owns' })
  // 即使其它条件全部完美、且开关全开，也不许发第二条。
  assert.deepEqual(
    decide({ candidate: reminder, config: { enabled: true, dryRun: false, allowExternalSend: true } }),
    { verdict: 'drop', reason: 'reminders-owns' },
  )
  // 反之：follow-up / share-intent / activity-receipt 都还能走（它们才是本账本的活）。
  for (const source of ['follow-up', 'share-intent', 'activity-receipt'] as const) {
    assert.equal(decide({ candidate: { source } }).verdict, 'send', `${source} 不该被 reminders-owns 拦`)
  }
})

test('G06 作用域：私聊却说不清跟谁 → drop/scope:no-user；群聊允许无具体用户', () => {
  assert.deepEqual(
    decide({
      candidate: {
        scope: { userId: null, personaId: 'nono', worldId: '' },
        target: { channel: 'qq', room: 'dm-10001', isGroup: false, chatId: 10001 },
      },
    }),
    { verdict: 'drop', reason: 'scope:no-user' },
  )
  assert.equal(
    decide({
      candidate: {
        scope: { userId: null, personaId: 'nono', worldId: '' },
        target: { channel: 'qq', room: 'group-1000000003', isGroup: true, chatId: 1000000003 },
      },
    }).verdict,
    'send',
    '群聊候选不必绑到某个用户',
  )
})

test('G07 绑定：房间键与目标不自洽 → drop/binding-invalid（四种错法）', () => {
  const cases: Array<Partial<ContactCandidate>> = [
    // 群聊却给了私聊房间键
    { target: { channel: 'qq', room: 'dm-10001', isGroup: true, chatId: 10001 } },
    // 群号写错
    { target: { channel: 'qq', room: 'group-1', isGroup: true, chatId: 1000000003 } },
    // 私聊房间键却是群
    { target: { channel: 'qq', room: 'group-10001', isGroup: false, chatId: 10001 } },
  ]
  for (const over of cases) {
    assert.deepEqual(decide({ candidate: over }), { verdict: 'drop', reason: 'binding-invalid' }, JSON.stringify(over.target))
  }
  // 首版只支持 QQ：别的通道不是"降级处理"，是直接不发。
  assert.deepEqual(
    decide({ candidate: { target: { channel: 'wechat', room: 'dm-10001', isGroup: false, chatId: 10001 } as never } }),
    { verdict: 'drop', reason: 'binding-invalid' },
  )
  // 两种历史前缀都放行（`group-1` 与 `qq-group-1` 都要能匹配）
  assert.equal(
    decide({ candidate: { target: { channel: 'qq', room: 'qq-group-1000000003', isGroup: true, chatId: 1000000003 } } }).verdict,
    'send',
  )
})

// ── 免打扰 ──────────────────────────────────────────────────────────────────

test('G08 免打扰（跨午夜 23:00→08:00）：区间内 defer/quiet-hours，08:00 整放行', () => {
  const config = { quietHours: [{ from: '23:00', to: '08:00' }] }
  assert.deepEqual(decide({ config, now: sh(17, 23, 0) }), { verdict: 'defer', reason: 'quiet-hours' })
  assert.deepEqual(decide({ config, now: sh(18, 3, 30) }), { verdict: 'defer', reason: 'quiet-hours' })
  assert.deepEqual(decide({ config, now: sh(18, 7, 59) }), { verdict: 'defer', reason: 'quiet-hours' })
  // to 是开区间：08:00 整已经"出了"免打扰
  assert.equal(decide({ config, now: sh(18, 8, 0) }).verdict, 'send')
  assert.equal(decide({ config, now: sh(18, 22, 59) }).verdict, 'send')
  // 空数组 = 不设免打扰
  assert.equal(decide({ config: { quietHours: [] }, now: sh(18, 3, 0) }).verdict, 'send')
})

test('G09 时区名不认识 → defer/timezone-invalid（fail-closed，不在算不出时间的地方发）', () => {
  assert.deepEqual(
    decide({ config: { timezone: 'Mars/Olympus' } }),
    { verdict: 'defer', reason: 'timezone-invalid' },
  )
  // 正确时区下同一时刻不受影响
  assert.equal(decide({ config: { timezone: 'Asia/Shanghai' } }).verdict, 'send')
  assert.equal(decide({ config: { timezone: 'UTC' }, now: sh(17, 6, 0) }).verdict, 'send')
})

// ── 竞争（新用户消息 / 回合 / 工具） ────────────────────────────────────────

test('G10 用户刚说过话 → defer/settle:user-active（含时钟回拨的负差，宁可不发）', () => {
  const now = sh(17, 14, 0)
  const settle = defaultContactConfig().settleWindowMs
  // 差 1ms 还不够 settle 窗口
  assert.deepEqual(
    decide({ now, runtime: { lastUserMessageAtByRoom: { 'dm-10001': now - (settle - 1) } } }),
    { verdict: 'defer', reason: 'settle:user-active' },
  )
  // 刚好超过窗口就放行
  assert.equal(
    decide({ now, runtime: { lastUserMessageAtByRoom: { 'dm-10001': now - settle } } }).verdict,
    'send',
  )
  // 未来时间戳（时钟回拨/坏数据）：差值负数也按"刚说过话"
  assert.deepEqual(
    decide({ now, runtime: { lastUserMessageAtByRoom: { 'dm-10001': now + 60_000 } } }),
    { verdict: 'defer', reason: 'settle:user-active' },
  )
  // 别的房间说过话不影响本房间
  assert.equal(
    decide({ now, runtime: { lastUserMessageAtByRoom: { 'group-1000000003': now } } }).verdict,
    'send',
  )
})

test('G10b 空闲跟进候选（evidenceSource=chat）在主人刚说过话时要重新等 `followUpIdleMs`', () => {
  const now = sh(17, 14, 0)
  const config = { settleWindowMs: 600_000, followUpIdleMs: 21_600_000 }
  const said = (minutesAgo: number): Partial<ContactRuntimeFacts> => ({
    lastUserMessageAtByRoom: { 'dm-10001': now - minutesAgo * 60_000 },
  })
  // 2 小时前说过话：已经过了 settle 窗口（10 分钟），但没到这个空闲候选的重新计时窗口（6 小时）
  assert.deepEqual(
    decide({ now, config, candidate: { evidenceSource: 'chat' }, runtime: said(120) }),
    { verdict: 'defer', reason: 'settle:user-active' },
  )
  // 同一时刻、同一条候选，但证据不是"聊天里说的" ⇒ 不该享受这个宽窗口
  assert.equal(
    decide({ now, config, candidate: { evidenceSource: 'chatlog' }, runtime: said(120) }).verdict,
    'send',
  )
  // 6 小时窗口刚过就放行（开区间语义与 settle 一致：`<` 不是 `<=`）
  assert.equal(decide({ now, config, candidate: { evidenceSource: 'chat' }, runtime: said(360) }).verdict, 'send')
  // 配成 0 = 不额外等（退回只看 settle 窗口）
  assert.equal(
    decide({ now, config: { ...config, followUpIdleMs: 0 }, candidate: { evidenceSource: 'chat' }, runtime: said(120) }).verdict,
    'send',
  )
})

test('G11 回合在跑 / 工具在跑 → defer（插话会打断节奏）', () => {
  assert.deepEqual(
    decide({ runtime: { turnRunningByRoom: { 'dm-10001': true } } }),
    { verdict: 'defer', reason: 'turn-running' },
  )
  assert.deepEqual(decide({ runtime: { toolRunning: true } }), { verdict: 'defer', reason: 'tool-running' })
  // 竞争先于冷却：两个都命中时报竞争（顺序契约）
  assert.deepEqual(
    decide({
      runtime: { turnRunningByRoom: { 'dm-10001': true } },
      counters: { lastSentAt: sh(17, 13, 59) },
    }),
    { verdict: 'defer', reason: 'turn-running' },
  )
})

// ── 冷却与额度 ──────────────────────────────────────────────────────────────

test('G12 冷却：房间级先于全局级；0 = 该级不设冷却', () => {
  const now = sh(17, 14, 0)
  const roomCool = defaultContactConfig().perRoomCooldownMs
  // 房间刚发过
  assert.deepEqual(
    decide({ now, counters: { lastSentAtByRoom: { 'dm-10001': now - 1000 } } }),
    { verdict: 'defer', reason: 'cooldown:room' },
  )
  // 房间不在冷却里、但全局冷却未过
  assert.deepEqual(
    decide({ now, counters: { lastSentAt: now - 1000 } }),
    { verdict: 'defer', reason: 'cooldown:global' },
  )
  // 两个都过
  assert.equal(decide({ now, counters: { lastSentAt: now - roomCool, lastSentAtByRoom: { 'dm-10001': now - roomCool } } }).verdict, 'send')
  // 关掉两级冷却
  assert.equal(
    decide({
      now,
      config: { globalCooldownMs: 0, perRoomCooldownMs: 0 },
      counters: { lastSentAt: now, lastSentAtByRoom: { 'dm-10001': now } },
    }).verdict,
    'send',
  )
})

test('G13 额度：全局先于房间；跨日自动归零（落盘的 day 是昨天）', () => {
  const config = defaultContactConfig()
  assert.deepEqual(
    decide({ counters: { sentTodayGlobal: config.dailyQuotaGlobal } }),
    { verdict: 'defer', reason: 'quota:global' },
  )
  assert.deepEqual(
    decide({ counters: { sentTodayByRoom: { 'dm-10001': config.dailyQuotaPerRoom } } }),
    { verdict: 'defer', reason: 'quota:room' },
  )
  // 昨天用光了，今天照样能发（计数按配置时区的今日重算）
  assert.equal(
    decide({
      counters: {
        day: '2026-10-16',
        sentTodayGlobal: 99,
        sentTodayByRoom: { 'dm-10001': 99 },
      },
    }).verdict,
    'send',
  )
  // 但"今天"的判据来自配置时区，不是落盘的 day 本身
  assert.deepEqual(
    decide({ counters: { day: '2026-10-17', sentTodayGlobal: config.dailyQuotaGlobal } }),
    { verdict: 'defer', reason: 'quota:global' },
  )
})

// ── 去重与退避 ──────────────────────────────────────────────────────────────

test('G14 去重：已投递的 dedupeKey → drop/dedupe（两处来源取并集）', () => {
  const key = 'followup:dm-10001:deploy'
  assert.deepEqual(
    decide({ candidate: { dedupeKey: key }, deliveryDedupeKeys: [key] }),
    { verdict: 'drop', reason: 'dedupe' },
  )
  assert.deepEqual(
    decide({ candidate: { dedupeKey: key }, runtime: { deliveredDedupeKeys: [key] } }),
    { verdict: 'drop', reason: 'dedupe' },
  )
  // 空去重键 = 不参与去重（不能因为"键拼不出来"就全部互相顶掉）
  assert.equal(decide({ candidate: { dedupeKey: '' }, deliveryDedupeKeys: [''] }).verdict, 'send')
})

test('G15 未回复退避：连续 N 条没人理 → defer/backoff:unanswered；0 = 不设上限', () => {
  const max = defaultContactConfig().maxUnansweredStreak
  assert.deepEqual(
    decide({ counters: { unansweredStreakByRoom: { 'dm-10001': max } } }),
    { verdict: 'defer', reason: 'backoff:unanswered' },
  )
  assert.equal(
    decide({ counters: { unansweredStreakByRoom: { 'dm-10001': max - 1 } } }).verdict,
    'send',
  )
  assert.equal(
    decide({
      config: { maxUnansweredStreak: 0 },
      counters: { unansweredStreakByRoom: { 'dm-10001': 99 } },
    }).verdict,
    'send',
  )
})

// ── 通道 ────────────────────────────────────────────────────────────────────

test('G16 通道：没连上 → defer/no-channel；绑定失效 → drop/binding-invalid', () => {
  assert.deepEqual(decide({ runtime: { connected: false } }), { verdict: 'defer', reason: 'no-channel' })
  assert.deepEqual(decide({ runtime: { roomBound: false } }), { verdict: 'drop', reason: 'binding-invalid' })
})

// ── 顺序契约 ────────────────────────────────────────────────────────────────

test('G17 判定顺序是契约：前一步不通过就不再看后面的', () => {
  // 终态（state）先于一切
  assert.equal(decide({ candidate: { state: 'cancelled' }, config: { enabled: false } }).reason, 'cancelled')
  // 总开关先于时间窗
  assert.equal(decide({ config: { enabled: false }, candidate: { expiresAt: 1 } }).reason, 'disabled')
  // 时间窗先于授权
  assert.equal(
    decide({
      candidate: { earliestAt: sh(18, 0, 0), authorization: { kind: 'explicit', by: null, at: null, quote: null } },
    }).reason,
    'not-due',
  )
  // 授权/绑定先于免打扰
  assert.equal(
    decide({ config: { quietHours: [{ from: '23:00', to: '08:00' }] }, now: sh(18, 3, 0), candidate: { dedupeKey: 'x' }, deliveryDedupeKeys: ['x'] }).reason,
    'quiet-hours',
  )
  // 免打扰先于竞争
  assert.equal(
    decide({
      config: { quietHours: [{ from: '23:00', to: '08:00' }] },
      now: sh(18, 3, 0),
      runtime: { toolRunning: true },
    }).reason,
    'quiet-hours',
  )
  // 竞争先于冷却
  assert.equal(
    decide({ runtime: { toolRunning: true }, counters: { lastSentAt: sh(17, 13, 59) } }).reason,
    'tool-running',
  )
  // 冷却先于额度
  assert.equal(
    decide({
      counters: { lastSentAt: sh(17, 13, 59), sentTodayGlobal: 99 },
    }).reason,
    'cooldown:global',
  )
  // 额度先于去重
  assert.equal(
    decide({ counters: { sentTodayGlobal: 99 }, deliveryDedupeKeys: ['followup:dm-10001:deploy'] }).reason,
    'quota:global',
  )
  // 去重先于退避
  assert.equal(
    decide({
      deliveryDedupeKeys: ['followup:dm-10001:deploy'],
      counters: { unansweredStreakByRoom: { 'dm-10001': 99 } },
    }).reason,
    'dedupe',
  )
  // 退避先于通道
  assert.equal(
    decide({ runtime: { connected: false }, counters: { unansweredStreakByRoom: { 'dm-10001': 99 } } }).reason,
    'backoff:unanswered',
  )
})

test('G18 reason 词表稳定：全部是小写短横线串，且实际吐出的都在词表里', () => {
  const declared = GATE_REASONS as readonly string[]
  for (const reason of declared) {
    assert.match(reason, /^[a-z0-9]+(:[a-z0-9-]+)?(-[a-z0-9]+)*$/, `reason 必须是稳定短横线串：${reason}`)
  }
  assert.equal(new Set(declared).size, declared.length, 'reason 不能重复')
  assert.ok(declared.length >= GATE_STEPS.length, '每个判定步骤至少对应一个 reason')
  // 实际会吐出来的 reason 必须都在词表里（漏登记 = 面板上出现一个没有徽章的空白）
  const now = sh(17, 14, 0)
  const samples = [
    decide(),
    decide({ config: { enabled: false } }),
    decide({ candidate: { state: 'cancelled' } }),
    decide({ candidate: { state: 'expired' } }),
    decide({ candidate: { state: 'consumed' } }),
    decide({ candidate: { earliestAt: now + 1000 } }),
    decide({ candidate: { earliestAt: now - 90 * 3_600_000 } }),
    decide({ candidate: { expiresAt: now } }),
    decide({ candidate: { authorization: { kind: 'explicit', by: null, at: null, quote: null } } }),
    decide({ candidate: { source: 'explicit-reminder' } }),
    decide({ candidate: { target: { channel: 'qq', room: 'dm-1', isGroup: true, chatId: 1 } } }),
    decide({ config: { quietHours: [{ from: '23:00', to: '08:00' }] }, now: sh(18, 3) }),
    decide({ config: { timezone: 'Mars/Olympus' } }),
    decide({ runtime: { lastUserMessageAtByRoom: { 'dm-10001': now - 1 } } }),
    decide({ runtime: { turnRunningByRoom: { 'dm-10001': true } } }),
    decide({ runtime: { toolRunning: true } }),
    decide({ counters: { lastSentAtByRoom: { 'dm-10001': now - 1 } } }),
    decide({ counters: { lastSentAt: now - 1 } }),
    decide({ counters: { sentTodayGlobal: 99 } }),
    decide({ counters: { sentTodayByRoom: { 'dm-10001': 99 } } }),
    decide({ deliveryDedupeKeys: ['followup:dm-10001:deploy'] }),
    decide({ counters: { unansweredStreakByRoom: { 'dm-10001': 99 } } }),
    decide({ runtime: { connected: false } }),
    decide({ runtime: { roomBound: false } }),
  ].map((decision) => decision.reason)
  for (const reason of samples) assert.ok(declared.includes(reason), `词表里没有 ${reason}`)
})

// ── 出网授权（与候选门控正交的两道闸） ─────────────────────────────────────

test('G19 authorizeOutbound 三态：dryRun / denied / allowed 分得清，默认两道都关', () => {
  const defaults = defaultContactConfig()
  // 默认：演练 + 不许外发 → 结论只能是 dry-run（诊断里一眼看出"还在观察"）
  const dry = authorizeOutbound(defaults)
  assert.equal(dry.verdict, 'dry-run')
  assert.equal(dry.reason, 'dry-run')
  assert.equal(dry.allowed, false, 'dry-run 绝不允许真发')
  // 只关演练、没开外发授权 → denied（而不是静默，也不是 allowed）
  const denied = authorizeOutbound({ ...defaults, dryRun: false })
  assert.equal(denied.verdict, 'denied')
  assert.equal(denied.reason, 'external-send-denied')
  assert.equal(denied.allowed, false)
  // 只开外发授权、演练还开着 → 仍然是 dry-run（两道是**与**关系）
  assert.equal(authorizeOutbound({ ...defaults, dryRun: true, allowExternalSend: true }).verdict, 'dry-run')
  // 两道都放开才是 allowed
  const allowed = authorizeOutbound({ ...defaults, dryRun: false, allowExternalSend: true })
  assert.equal(allowed.verdict, 'allowed')
  assert.equal(allowed.reason, 'ok')
  assert.equal(allowed.allowed, true)
})

test('G20 默认组合下什么都不发：sendMode=turn、draftModel=false、两道闸都关', () => {
  const defaults = defaultContactConfig()
  assert.equal(defaults.enabled, false)
  assert.equal(defaults.dryRun, true)
  assert.equal(defaults.allowExternalSend, false)
  assert.equal(defaults.sendMode, 'turn')
  assert.equal(defaults.draftModel, false)
  // 默认配置下：候选能进门控，但两道出网闸都关着 → 只可能记 dry-run，不可能真发。
  assert.notEqual(authorizeOutbound(defaults).verdict, 'allowed')
  // 默认免打扰是跨午夜的 23:00→08:00（工程建议值，不是用户作息）
  assert.deepEqual(defaults.quietHours, [{ from: '23:00', to: '08:00' }])
  assert.equal(defaults.settleWindowMs, 120_000)
  assert.equal(defaults.pollIntervalMs, 60_000)
  // 每拍只处理一条：一次冒出十条候选不该一口气烧掉当天额度
  assert.equal(defaults.maxPerTick, 1)
  assert.equal(defaults.maxCatchupHours, 24)
})
