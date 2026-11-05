/** 安全默认值（发布合同）：**没配置就什么都不做**。
 *
 * 这一份测试守的是发布口径，不是某个功能的细节：
 *
 *   1. 没填 NapCat/OneBot 地址时，`OneBotClient.start()` **不拨号、不监听、不重连**
 *      （一个定时器都不注册）。以前默认 `ws://127.0.0.1:3001`，目标不存在时会一路
 *      指数退避重试到底——"新装的插件立刻开始重连风暴"就是从这里来的；
 *   2. 旧的定时主动行为（巡逻 / 做梦 / 自省 / 主动私聊 / 早报 / 抽知识）默认关：
 *      `Scheduler.start()` 一个定时器都不注册，因此不会调用模型、不会外发；
 *   3. 出厂配置里所有"会自己往外发""会在后台调模型"的开关默认都是关的；
 *   4. 附带的 `qq-idle-compaction`（压缩会走到模型）默认不安装定时器。
 *
 * 判断"有没有注册定时器"的办法是**在同步调用期间替换全局 setTimeout/setInterval**
 * 并计数——这比断言某个私有字段更接近事实：真问题是"会不会有人被唤醒"，而不是
 * "某个字段是不是 null"。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { OneBotClient } from '../src/onebot.js'
import { resolveConfig } from '../src/config.js'
import { Scheduler } from '../src/features/proactive/events.js'
import type { TurnLauncher } from '../src/app/conversation/turns.js'
import type { PromptComposer } from '../src/app/conversation/prompt-composer.js'

/** 在一次**同步**调用期间统计新注册的定时器，结束后立刻还原全局函数。 */
function countTimers(run: () => void): { timeouts: number; intervals: number } {
  const realSetTimeout = globalThis.setTimeout
  const realSetInterval = globalThis.setInterval
  const counts = { timeouts: 0, intervals: 0 }
  const fakeSetTimeout = ((...args: Parameters<typeof setTimeout>) => {
    counts.timeouts += 1
    return realSetTimeout(...args)
  }) as typeof setTimeout
  const fakeSetInterval = ((...args: Parameters<typeof setInterval>) => {
    counts.intervals += 1
    return realSetInterval(...args)
  }) as typeof setInterval
  try {
    globalThis.setTimeout = fakeSetTimeout
    globalThis.setInterval = fakeSetInterval
    run()
  } finally {
    globalThis.setTimeout = realSetTimeout
    globalThis.setInterval = realSetInterval
  }
  return counts
}

// ── 1. 连接：未配置 = 不动作 ────────────────────────────────────────────────

test('未填 NapCat 地址：forward 模式 start() 不拨号、不注册任何定时器', () => {
  const logs: string[] = []
  const client = new OneBotClient({ mode: 'forward', url: '' }, undefined, (line) => { logs.push(line) })
  try {
    const timers = countTimers(() => { client.start() })
    assert.equal(client.configured(), false, '空 URL 必须被判成"未配置"')
    assert.deepEqual(timers, { timeouts: 0, intervals: 0 }, '未配置时不许起任何定时器（重连/心跳都不行）')
    assert.equal(client.isConnected(), false)
    assert.ok(logs.some((line) => line.includes('未配置')), `日志里要明说"未配置"，实际：${JSON.stringify(logs)}`)
  } finally {
    client.stop()
  }
})

test('未填 NapCat 地址：reverse 模式 start() 也不监听端口', () => {
  const logs: string[] = []
  const client = new OneBotClient({ mode: 'reverse', url: '   ' }, undefined, (line) => { logs.push(line) })
  try {
    const timers = countTimers(() => { client.start() })
    assert.equal(client.configured(), false, '纯空格也算未配置')
    assert.deepEqual(timers, { timeouts: 0, intervals: 0 })
    assert.equal(logs.some((line) => line.includes('listening')), false, '未配置时不许监听端口')
    assert.ok(logs.some((line) => line.includes('未配置')))
  } finally {
    client.stop()
  }
})

test('填了地址：start() 真的会去拨号（对照组，说明上面不是"永远不连"）', () => {
  const logs: string[] = []
  const client = new OneBotClient({ mode: 'forward', url: 'ws://127.0.0.1:1' }, undefined, (line) => { logs.push(line) })
  try {
    assert.equal(client.configured(), true)
    client.start()
    assert.ok(logs.some((line) => line.includes('dialling')), `配置了地址就应该拨号，实际：${JSON.stringify(logs)}`)
  } finally {
    client.stop()
  }
})

// ── 2. 旧定时主动行为：默认不注册任何定时器 ──────────────────────────────────

/** 起点 stub：定时器一个都不该被注册，所以这两个依赖永远不会被调用。 */
const neverTurns = {
  patrolTick: () => { throw new Error('不该巡逻') },
  dreamTick: () => { throw new Error('不该做梦') },
  evolveTick: () => { throw new Error('不该自省') },
  dmProactive: () => { throw new Error('不该主动私聊') },
} as unknown as TurnLauncher

const neverPrompts = {
  render: () => { throw new Error('不该渲染主动文案') },
} as unknown as PromptComposer

test('proactive.scheduler 默认关：Scheduler.start() 一个定时器都不注册', () => {
  // 不写盘：DSH_HOME 指到临时目录，即便将来 start() 提前读状态也不会污染真实 home。
  const before = process.env.DSH_HOME
  process.env.DSH_HOME = path.join(process.cwd(), 'build', 'safe-defaults-home')
  const logs: string[] = []
  const config = resolveConfig({})
  assert.equal(config.proactive.scheduler, false, '出厂默认必须是关')
  const scheduler = new Scheduler(neverTurns, neverPrompts, config, (line) => { logs.push(line) })
  try {
    const timers = countTimers(() => { scheduler.start() })
    assert.deepEqual(timers, { timeouts: 0, intervals: 0 }, '关着时不许注册任何定时器')
    assert.ok(logs.some((line) => line.includes('旧定时行为未启用')), `日志要说明为什么没跑，实际：${JSON.stringify(logs)}`)
    assert.ok(logs.some((line) => line.includes('scheduler started')) === false, '不该打出 "scheduler started"')
  } finally {
    scheduler.dispose()
    if (before === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = before
  }
})

// ── 3. 出厂配置：会外发 / 会调模型的开关默认全关 ────────────────────────────

test('出厂配置：自动外发与后台模型任务默认全部关闭', () => {
  const config = resolveConfig({})
  const checks: Array<[string, boolean, string]> = [
    ['connection.url 空 = 未配置', config.connection.url === '', `实际 ${JSON.stringify(config.connection.url)}`],
    ['主动消息总开关', config.contact.enabled === false, 'contact.enabled'],
    ['主动消息演练模式', config.contact.dryRun === true, 'contact.dryRun'],
    ['主动消息真实外发', config.contact.allowExternalSend === false, 'contact.allowExternalSend'],
    ['主动消息模型起草', config.contact.draftModel === false, 'contact.draftModel'],
    ['旧定时主动行为', config.proactive.scheduler === false, 'proactive.scheduler'],
    ['事件书 v2', config.proactive.v2 === false, 'proactive.v2'],
    ['群聊旁听与自主接话', config.presence.enabled === false, 'presence.enabled'],
    ['每日早报', config.morningReport.enabled === false, 'morningReport.enabled'],
    ['原话簿', config.chatlog.enabled === false, 'chatlog.enabled'],
    ['群聊准入', config.planner.enabled === false, 'planner.enabled'],
    ['高危群管', config.groupAdmin.dangerous === false, 'groupAdmin.dangerous'],
    ['策略 v2', config.policy.v2 === false, 'policy.v2'],
    ['工具面 v2', config.tools.v2 === false, 'tools.v2'],
    ['自适应跟进复核', config.contact.adaptiveFollowUp === false, 'contact.adaptiveFollowUp'],
    ['语言自动出卡（空 = 只走工具）', config.linkResolve.autoGroups.length === 0, 'linkResolve.autoGroups'],
    ['巡航任务', config.cruises.length === 0, 'cruises'],
    ['RSS 订阅', config.rss.feeds.length === 0, 'rss.feeds'],
    ['提醒演练模式', config.reminders.dryRun === true, 'reminders.dryRun'],
    ['后台口令（空 = 无法登录，fail-closed）', config.admin.password === '', 'admin.password'],
    ['后台只监听本机', config.admin.host === '127.0.0.1', 'admin.host'],
  ]
  for (const [label, ok, detail] of checks) {
    assert.equal(ok, true, `默认值不安全：${label}（${detail}）`)
  }
})

// ── 4. 附带的空闲压缩插件：默认不安装定时器 ──────────────────────────────────

test('qq-idle-compaction：没有 QQ_IDLE_COMPACTION 时不注册定时器', async (t) => {
  const file = path.resolve(process.cwd(), '..', 'qq-idle-compaction.mjs')
  if (!existsSync(file)) {
    t.skip('套件布局下才有 plugins/qq-idle-compaction.mjs（单独装本包时跳过）')
    return
  }
  const mod = (await import(pathToFileURL(file).href)) as {
    enabled: (env?: Record<string, string | undefined>) => boolean
    apply: (ctx: unknown) => void
  }
  assert.equal(mod.enabled({}), false, '默认必须是关')
  assert.equal(mod.enabled({ QQ_IDLE_COMPACTION: '0' }), false)
  assert.equal(mod.enabled({ QQ_IDLE_COMPACTION: '1' }), true)
  const ctx = {
    agents: { roots: () => [] },
    llm: { resolveModelInfo: async () => ({}) },
    tokenMeter: { measure: () => ({ totalTokens: 0 }) },
    compaction: { compactNow: async () => null },
    on: () => {},
  }
  const timers = countTimers(() => { mod.apply(ctx) })
  assert.deepEqual(timers, { timeouts: 0, intervals: 0 }, '默认关时不许起 60 秒轮询')
})
