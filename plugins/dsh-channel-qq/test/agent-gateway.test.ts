/** 宿主会话网关与回合账本的测试。
 *
 * 这两个文件是 P3.2 的产物，而且它们的存在本身就是这一步的收益：在抽取之前，
 * "会话怎么开出来的"和"失败之后怎么重试"这两件事**没有任何直接的测试**——
 * 只能通过真消息端到端地撞。抽取之后：
 *
 *   - 网关的测试用**生产实现**跑在一个假宿主上（不是另写一份假网关），
 *     所以"先查注册表、失败退避、再恢复"这条路径在测试里跑的就是线上那份代码；
 *   - 回合账本的时间与定时器都走注入的 `Clock`，于是"退避 30 秒之后重试"
 *     用假时钟一次推到点，而不是真的等 30 秒。
 */

import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

// 会话目录的扫描要一个真实存在的根（`reattachAll` 会去 readdir）。
const SESSIONS = mkdtempSync(path.join(tmpdir(), 'gw-sessions-'))
process.env.DSH_SESSIONS_ROOT = SESSIONS

const { createAgentGateway } = await import('../src/adapters/dsh-host/agents.js')
const { TurnTracker } = await import('../src/app/conversation/turn-tracker.js')
const { GatewayHealth } = await import('../src/app/conversation/gateway-health.js')
const { PromptComposer } = await import('../src/app/conversation/prompt-composer.js')
const { createPersonaPack } = await import('../src/adapters/persona/fs-pack.js')
const { systemClock } = await import('../src/ports/clock.js')
const { FakeHost } = await import('./fakes/host.js')
type AgentSession = import('../src/ports/agent-gateway.js').AgentSession
type DeliverMode = import('../src/ports/agent-gateway.js').DeliverMode
type PromptContent = import('../src/ports/agent-gateway.js').PromptContent

/** 人格包里那句接着做——断言的就是发布物里的那一句。 */
const NUDGE = new PromptComposer(createPersonaPack()).gatewayNudge()

// ── 回合账本 ────────────────────────────────────────────────────────────────

/** 一个只会记账的会话：把 `deliver` 的入参原样留下来。 */
function recordingSession(): {
  session: AgentSession
  sent: Array<{ content: PromptContent; mode: DeliverMode }>
  setRunning(value: boolean): void
} {
  const sent: Array<{ content: PromptContent; mode: DeliverMode }> = []
  let running = false
  return {
    sent,
    setRunning: (value: boolean) => { running = value },
    session: {
      id: 'qq-group-1',
      isRunning: () => running,
      deliver(content, mode) { sent.push({ content, mode }); return true },
      async dispose() { return true },
    },
  }
}

function trackerFor(session: AgentSession, over: {
  injectMode?: { enabled: boolean; wakeIdle: boolean }
  log?: (line: string) => void
  health?: InstanceType<typeof GatewayHealth>
} = {}): { tracker: InstanceType<typeof TurnTracker>; logs: string[]; health: InstanceType<typeof GatewayHealth> } {
  const logs: string[] = []
  const health = over.health ?? new GatewayHealth()
  const tracker = new TurnTracker({
    room: 'group-1',
    health,
    clock: systemClock,
    log: over.log ?? ((line: string) => { logs.push(line) }),
    nudge: () => NUDGE,
    injectMode: () => over.injectMode ?? { enabled: false, wakeIdle: true },
    roll: () => 0.5,
  })
  tracker.bind(session)
  return { tracker, logs, health }
}

const TEXT: PromptContent = [{ type: 'text', text: '一包' }]

test('TurnTracker：干净的一轮跑完就把状态放开', () => {
  const { session } = recordingSession()
  const { tracker, logs } = trackerFor(session)
  tracker.begin('一包', false)
  assert.equal(tracker.running(), true)
  assert.equal(tracker.busy(), true)
  tracker.onIdle()
  assert.equal(tracker.running(), false)
  assert.equal(tracker.busy(), false)
  assert.deepEqual(logs, ['turn done for group-1'])
})

test('TurnTracker：网关形状的失败会退避重试，重试时补一句 nudge', async () => {
  const { session, sent } = recordingSession()
  const { tracker, logs } = trackerFor(session)
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
  try {
    tracker.begin('一包', false)
    tracker.onError({ raw: '{"code":"SERVER"}' })
    assert.equal(tracker.busy(), true, '重试已武装 → 攒批要给重试让路')
    assert.equal(sent.length, 0, '重试不是立刻发，先退避')
    assert.match(logs.join('\n'), /scheduling gateway retry 1\/8 for group-1 in 30s/)
    // 退避 30s（抖动 0.5 → 正好 30s）之后才补递。
    mock.timers.tick(30_000)
    await Promise.resolve()
    assert.deepEqual(sent, [{ content: [{ type: 'text', text: NUDGE }], mode: 'followup' }])
    assert.match(logs.join('\n'), /retry 1\/8 for group-1/)
  } finally {
    tracker.dispose()
    mock.timers.reset()
  }
})

test('GatewayHealth：退避只推迟不提前（新失败只会让它更晚结束）', () => {
  const health = new GatewayHealth()
  assert.equal(health.isBackingOff(0), false, '没退避过就不在退避期')
  health.arm(1_000_000, 30_000)
  assert.equal(health.deadline(), 1_030_000)
  // 一个更短的退避不该把截止时刻提前。
  health.arm(1_000_000, 10_000)
  assert.equal(health.deadline(), 1_030_000, '已经更晚了，保持不变')
  // 一次更晚、更长的失败可以把它推后。
  health.arm(1_020_000, 60_000)
  assert.equal(health.deadline(), 1_080_000)
  assert.equal(health.isBackingOff(1_079_999), true)
  assert.equal(health.isBackingOff(1_080_000), false)
})

test('TurnTracker：一次失败把退避推到"现在 + 30s"（攒批据此让路）', () => {
  const { session } = recordingSession()
  const health = new GatewayHealth()
  const { tracker } = trackerFor(session, { health })
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
  try {
    tracker.begin('一包', false)
    tracker.onError({ raw: '{"code":"SERVER"}' })
    assert.equal(health.deadline(), 1_030_000)
  } finally {
    tracker.dispose()
    mock.timers.reset()
  }
})

test('TurnTracker：重试次数用尽就放弃，不再排下一条', async () => {
  const { session } = recordingSession()
  const { tracker, logs } = trackerFor(session)
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
  try {
    // 一条重试链上连续失败：每次都要等定时器真的响过，计数才会往前走
    // （定时器还挂着的时候再报错属于同一个失败窗口，会被忽略）。
    tracker.begin('一包', false)
    for (let attempt = 1; attempt <= 8; attempt++) {
      tracker.onError({ raw: '{"code":"SERVER"}' })
      assert.match(logs.join('\n'), new RegExp(`scheduling gateway retry ${attempt}/8`))
      mock.timers.tick(200_000)
      await Promise.resolve()
    }
    tracker.onError({ raw: '{"code":"SERVER"}' })
    assert.match(logs.join('\n'), /exhausted 8 gateway retries; giving up/)
  } finally {
    tracker.dispose()
    mock.timers.reset()
  }
})

test('TurnTracker：带图的请求被整个拒了就改发纯文本，只试一次', () => {
  const { session, sent } = recordingSession()
  const { tracker, logs } = trackerFor(session)
  tracker.begin('带图的一包', true)
  tracker.onError({ raw: '{"code":"INVALID_REQUEST"}' })
  assert.deepEqual(sent, [{ content: [{ type: 'text', text: NUDGE }], mode: 'followup' }])
  assert.match(logs.join('\n'), /image request rejected; retrying text-only/)
  // 第二次同样的失败不再重试（textOnlyRetryDone 已经置上）。
  tracker.onError({ raw: '{"code":"INVALID_REQUEST"}' })
  assert.equal(sent.length, 1)
})

test('TurnTracker：永久性失败不重试', () => {
  const { session, sent } = recordingSession()
  const { tracker, logs } = trackerFor(session)
  tracker.begin('一包', false)
  tracker.onError({ raw: '{"name":"SessionFormatError"}' })
  assert.equal(sent.length, 0)
  assert.equal(logs.length, 0, '什么都不做，连日志都没有')
})

test('TurnTracker：投递通道按注入模式选（followup / inject / steer）', () => {
  // 注入模式关：永远 followup。
  const off = recordingSession()
  const a = trackerFor(off.session, { injectMode: { enabled: false, wakeIdle: true } })
  a.tracker.begin('x', false)
  a.tracker.deliver(TEXT)
  assert.equal(off.sent[0]?.mode, 'followup')

  // 注入模式开 + 正在跑：inject（只进上下文，不打断这一轮）。
  const running = recordingSession()
  running.setRunning(true)
  const b = trackerFor(running.session, { injectMode: { enabled: true, wakeIdle: true } })
  b.tracker.begin('x', false)
  b.tracker.deliver(TEXT)
  assert.equal(running.sent[0]?.mode, 'inject')

  // 注入模式开 + 空闲：唤醒（steer），这样 agent 会立刻接话。
  const idle = recordingSession()
  const c = trackerFor(idle.session, { injectMode: { enabled: true, wakeIdle: true } })
  c.tracker.begin('x', false)
  c.tracker.deliver(TEXT)
  assert.equal(idle.sent[0]?.mode, 'steer')
})

test('TurnTracker：宿主不支持 steer 时退回 followup', () => {
  const sent: Array<{ mode: DeliverMode }> = []
  const session: AgentSession = {
    id: 'qq-group-1',
    isRunning: () => false,
    // 老运行时上没有 steer：递不出去。
    deliver(_content, mode) { sent.push({ mode }); return mode !== 'steer' },
    async dispose() { return true },
  }
  const { tracker } = trackerFor(session, { injectMode: { enabled: true, wakeIdle: true } })
  tracker.begin('x', false)
  tracker.deliver(TEXT)
  assert.deepEqual(sent.map((s) => s.mode), ['steer', 'followup'])
})

// ── 网关 ────────────────────────────────────────────────────────────────────

function spec(host: InstanceType<typeof FakeHost>, over: Record<string, unknown> = {}): never {
  const listener = { idles: 0, errors: [] as string[], onIdle() { this.idles += 1 }, onError(e: { raw: string }) { this.errors.push(e.raw) } }
  return {
    sessionId: 'qq-group-1',
    cwd: '/tmp/ws',
    presetId: 'standard',
    provider: 'p', model: 'm',
    title: 'QQ 群1',
    permissionPreset: 'workspace-write',
    stepBudget: () => 0,
    listener,
    log: () => {},
    host,
    listenerRef: listener,
    ...over,
  } as never
}

/** 只取 spec 里属于 `SessionSpec` 的字段（`host`/`listenerRef` 是测试自己的）。 */
function sessionSpecOf(full: Record<string, unknown>): Record<string, unknown> {
  const { host: _h, listenerRef: _l, ...rest } = full
  return rest
}

test('网关：没有活会话就创建，并挂工作区 / 设权限 / 改标题', async () => {
  const host = new FakeHost({ workspacePath: '/tmp/ws' })
  const gateway = createAgentGateway(host.context(), () => {})
  const full = spec(host)
  const session = await gateway.open(sessionSpecOf(full) as never)
  assert.equal(session.id, 'qq-group-1')
  assert.equal(host.creates.get('qq-group-1'), 1)
  assert.deepEqual(host.attached, ['qq-group-1'])
  assert.deepEqual(host.permissions.map((p) => p.id), ['workspace-write'])
  assert.deepEqual(host.titles.map((t) => t.title), ['QQ 群1'])
  assert.equal(await session.dispose(), false, '宿主的裸 Agent 没有释放能力')
  rmSync(SESSIONS, { recursive: true, force: true })
})

test('网关：宿主里还活着就接上去（不重建），并重装模型覆盖', async () => {
  const host = new FakeHost({ liveSessions: ['qq-group-1'] })
  const gateway = createAgentGateway(host.context(), () => {})
  await gateway.open(sessionSpecOf(spec(host)) as never)
  assert.equal(host.creates.get('qq-group-1'), undefined, '没有调用 create')
  assert.ok(host.agentListeners.includes('agent/request'), '接回来的会话要重装模型覆盖')
  assert.ok(host.agentListeners.includes('agent/status'), '回合监听也补挂上了')
})

test('网关：create 撞上"已存在"就恢复它的历史', async () => {
  const host = new FakeHost({ createError: 'session already exists' })
  const gateway = createAgentGateway(host.context(), () => {})
  // 恢复链路里有一次 1.5s 的等待（批量自愈可能正在发布这个会话），这里如实等它。
  const session = await gateway.open(sessionSpecOf(spec(host)) as never)
  assert.equal(session.id, 'qq-group-1')
  assert.deepEqual(host.attached, ['qq-group-1'])
})

test('网关：我们建出来的会话才拆得掉', async () => {
  const host = new FakeHost({ canDispose: true })
  const gateway = createAgentGateway(host.context(), () => {})
  const session = await gateway.open(sessionSpecOf(spec(host)) as never)
  assert.equal(await session.dispose(), true)
  assert.deepEqual(host.disposed, ['qq-group-1'])
})

test('网关：自愈扫描把每个 qq-* 会话挂回工作区，"已经挂过"不算失败', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'gw-reattach-'))
  const previous = process.env.DSH_SESSIONS_ROOT
  process.env.DSH_SESSIONS_ROOT = root
  try {
    mkdirSync(path.join(root, 'proj', 'qq-group-7'), { recursive: true })
    mkdirSync(path.join(root, 'proj', 'qq-dm-9'), { recursive: true })
    mkdirSync(path.join(root, 'proj', 'not-ours'), { recursive: true })
    const host = new FakeHost()
    const gateway = createAgentGateway(host.context(), () => {})
    const result = await gateway.reattachAll('/tmp/ws')
    assert.deepEqual(result, { attached: 2, total: 2 })
    assert.deepEqual(host.attached.sort(), ['qq-dm-9', 'qq-group-7'])

    // 已经挂过的那些会被宿主拒绝：日志要说"failed"，但计数不受影响。
    const already = new FakeHost({ attachError: 'attachment already exists' })
    const gateway2 = createAgentGateway(already.context(), () => {})
    assert.deepEqual(await gateway2.reattachAll('/tmp/ws'), { attached: 0, total: 2 })
    assert.deepEqual(already.attached, [])
  } finally {
    process.env.DSH_SESSIONS_ROOT = previous
    rmSync(root, { recursive: true, force: true })
  }
})

test('网关：默认路由透传宿主当前选型', () => {
  const host = new FakeHost({ selection: { provider: 'qwen', model: 'qwen-max' } })
  const gateway = createAgentGateway(host.context(), () => {})
  assert.deepEqual(gateway.defaultRoute(), { provider: 'qwen', model: 'qwen-max' })
})
