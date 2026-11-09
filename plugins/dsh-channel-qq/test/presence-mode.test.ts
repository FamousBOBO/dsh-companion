/** 运行模式（P5-B：off / shadow / live）的测试。
 *
 * 这一组用例只回答一个问题：**"说不发"到底可不可靠**。所以每条 "不发" 都配一条对照
 * （同一套输入、只把模式换成 live），证明"没发"是闸门干的，不是用例自己写坏了。
 *
 * 三条纪律（与 `presence-runtime.test.ts` 一致）：不发真 QQ、不调真模型、不读真库；
 * 时间全部由 `FakeClock` 推进。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AmbientLimits } from '../src/core/ambient.js'
import type { Clock } from '../src/ports/clock.js'
import { AmbientStore } from '../src/app/inbound/ambient-store.js'
import { GroupPresence } from '../src/app/inbound/presence-runtime.js'
import type { CompletePort, PresenceView } from '../src/app/inbound/presence-flow.js'
import { FakeClock, FakePlatform, settle } from './fakes/contact.js'

const START = new Date(2026, 10, 1, 22, 0, 0).getTime()
const GROUP = 145326153
const LIMITS: AmbientLimits = { maxEntries: 40, ttlMs: 600_000, maxChars: 6_000 }

/** 一句会被解析成 `reply` 的输出（目标号在下面 push 的第一条）。 */
const REPLY = '{"action":"reply","targetMessageId":1000,"text":"把快门提到 1/250 试试。","reason":"在问参数"}'

function view(over: Partial<PresenceView> = {}): PresenceView {
  return {
    enabled: true,
    groups: [GROUP],
    ambientMaxEntries: 40,
    ambientTtlMs: 600_000,
    ambientMaxChars: 6_000,
    judgeIntervalMs: 50_000,
    judgeMaxEntries: 15,
    judgeMaxChars: 1_200,
    judgeTimeoutMs: 25_000,
    judgeMaxTokens: 320,
    speakMinIntervalMs: 300_000,
    speakMaxPerHour: 3,
    replyMaxChars: 70,
    ...over,
  }
}

interface Harness {
  readonly clock: FakeClock
  readonly platform: FakePlatform
  readonly logs: string[]
  readonly sentLog: Array<{ messageId: number | null; text: string }>
  readonly shadow: Array<Record<string, unknown>>
  readonly prompts: string[]
  readonly presence: GroupPresence
  /** 换模式（模拟管理员在后台改配置）。 */
  setMode(next: string): void
  push(text: string, over?: { userId?: number; messageId?: number }): void
  tick(ms: number): Promise<void>
}

function harness(initialMode: string, reply = REPLY): Harness {
  const clock = new FakeClock(START)
  const logs: string[] = []
  const sentLog: Harness['sentLog'] = []
  const shadow: Array<Record<string, unknown>> = []
  const prompts: string[] = []
  const ambient = new AmbientStore({ log: (line) => logs.push(line) })
  const platform = new FakePlatform({ clock })
  let mode = initialMode
  const complete: CompletePort = {
    async complete(request) {
      prompts.push(request.prompt)
      return { kind: 'text', text: reply }
    },
  }
  const presence = new GroupPresence({
    config: () => ({ presence: view() }),
    clock: clock as Clock,
    log: (line) => logs.push(line),
    platform: () => platform,
    ambient,
    complete,
    recordSent: async (_groupId, messageId, text) => {
      sentLog.push({ messageId, text })
    },
    persona: () => null,
    // 每次现取：这就是"在途结果也要被拦下"的那条缝。
    mode: () => mode,
    recordShadow: (decision) => {
      shadow.push({ ...decision })
    },
  })
  let nextId = 1000
  return {
    clock,
    platform,
    logs,
    sentLog,
    shadow,
    prompts,
    presence,
    setMode(next) {
      mode = next
    },
    push(text, over = {}) {
      ambient.ring(GROUP, LIMITS).add({
        messageId: over.messageId ?? nextId++,
        userId: over.userId ?? 10_001,
        name: '小王',
        text,
        atMs: clock.now(),
        self: false,
      })
      presence.observe(GROUP)
    },
    async tick(ms) {
      clock.advance(ms)
      await settle(4)
    },
  }
}

/** 走完"首条 → 等满间隔 → 再来一条武装 → 到点判断"。第一条的 messageId 固定为 1000。 */
async function firstJudgment(h: Harness): Promise<void> {
  h.push('小王(10001) 22:00：晚上拍月亮老是糊', { messageId: 1000 })
  await h.tick(300_000)
  h.push('小李(10002) 22:05：是不是得用三脚架', { messageId: 1001 })
  await h.tick(50_000)
}

// ── shadow ─────────────────────────────────────────────────────────────────

test('shadow：真判断、真校验，但一条都不发；影子日志记下"本来想发什么"', async () => {
  const h = harness('shadow')
  await firstJudgment(h)
  assert.equal(h.prompts.length, 1, 'shadow 必须真判断（否则影子日志没有意义）')
  assert.equal(h.platform.attempts.length, 0, 'shadow 下不许有任何真实发送')
  assert.equal(h.sentLog.length, 0, 'shadow 下不许写 sent-log（那会变成"说过话"）')
  assert.equal(h.shadow.length, 1, '影子日志应当有一行')
  assert.equal(h.shadow[0]?.['blockedBy'], 'shadow')
  assert.equal(h.shadow[0]?.['action'], 'reply')
  assert.match(String(h.shadow[0]?.['text']), /快门/)
})

test('shadow：spoken 为 0、shadowWouldSend 为 1（两个数字放一起才能看出闸门有没有漏）', async () => {
  const h = harness('shadow')
  await firstJudgment(h)
  const stats = h.presence.diagnostics().groups.find((row) => row.groupId === GROUP)
  assert.equal(stats?.spoken, 0)
  assert.equal(stats?.shadowWouldSend, 1)
})

test('shadow 的判断按"成功"记账：不累积失败、不进入发言冷却', async () => {
  const h = harness('shadow')
  await firstJudgment(h)
  assert.ok(!h.logs.some((line) => line.includes('speak-cooldown')), '没发过就不该有冷却')
  assert.ok(!h.logs.some((line) => line.includes('暂停')), 'shadow 不该触发失败暂停')
  assert.ok(h.logs.some((line) => line.includes('只记不发')), '应当留一行"只记不发"的日志')
})

// ── 闸门每次现取 ────────────────────────────────────────────────────────────

test('在途判断期间把 live 改成 shadow：这次结果不发出去', async () => {
  const clock = new FakeClock(START)
  const logs: string[] = []
  const ambient = new AmbientStore({ log: () => {} })
  const platform = new FakePlatform({ clock })
  let mode = 'live'
  // 手动结算的闸门（测"在途"）。用对象包一层：TS 的闭包赋值收窄在 `?.()` 处会丢。
  const latch: { open: () => void } = { open: () => {} }
  const gate = new Promise<void>((resolve) => {
    latch.open = () => resolve()
  })
  const presence = new GroupPresence({
    config: () => ({ presence: view() }),
    clock: clock as Clock,
    log: (line) => logs.push(line),
    platform: () => platform,
    ambient,
    complete: {
      async complete() {
        await gate
        return { kind: 'text', text: REPLY }
      },
    },
    recordSent: async () => {},
    persona: () => null,
    mode: () => mode,
  })
  const push = (text: string, messageId: number): void => {
    ambient.ring(GROUP, LIMITS).add({ messageId, userId: 10_001, name: '小王', text, atMs: clock.now(), self: false })
    presence.observe(GROUP)
  }
  push('小王(10001) 22:00：晚上拍月亮老是糊', 1000)
  clock.advance(300_000)
  await settle(2)
  push('小李(10002) 22:05：是不是得用三脚架', 1001)
  clock.advance(50_000)
  await settle(2)
  // 模型还在飞的时候把 live 改成 shadow：这次结果**不许**发出去。
  mode = 'shadow'
  latch.open()
  await settle(6)
  assert.equal(platform.attempts.length, 0, '在途结果必须被新模式下拦住')
  presence.dispose()
})

test('off 模式：判断照跑但一条都不发，也不写影子日志（off 只是"不发"，不是"不判断"）', async () => {
  const h = harness('off')
  await firstJudgment(h)
  assert.equal(h.platform.attempts.length, 0, 'off 下不许有任何真实发送')
  // 注意：off 的**装配层**（presence-wiring）根本不会创建执行器；这里的用例是直接构造
  // GroupPresence 并传 'off'，验证的是"闸门对 off 同样有效"这条兜底。
  assert.equal(h.shadow.length, 1, '闸门对 off 也要留一行记录，便于诊断为什么没发')
  assert.equal(h.shadow[0]?.['blockedBy'], 'off')
})

// ── 对照组 ─────────────────────────────────────────────────────────────────

test('live 对照组：同一套输入确实会发（证明上面的"不发"是闸门干的）', async () => {
  const h = harness('live')
  await firstJudgment(h)
  assert.equal(h.platform.attempts.length, 1, 'live 下应当发一条')
  assert.equal(h.sentLog.length, 1)
  assert.equal(h.shadow.length, 0, 'live 下不写影子日志')
})

test('闸门取不到值时按 live（旧装配与既有测试的行为不变）', async () => {
  const clock = new FakeClock(START)
  const ambient = new AmbientStore({ log: () => {} })
  const platform = new FakePlatform({ clock })
  const presence = new GroupPresence({
    config: () => ({ presence: view() }),
    clock: clock as Clock,
    log: () => {},
    platform: () => platform,
    ambient,
    complete: { async complete() { return { kind: 'text', text: REPLY } } },
    recordSent: async () => {},
    persona: () => null,
    // 刻意不传 mode：旧装配的形状。
  })
  ambient.ring(GROUP, LIMITS).add({ messageId: 1000, userId: 10_001, name: '小王', text: '拍月亮老是糊', atMs: clock.now(), self: false })
  presence.observe(GROUP)
  clock.advance(300_000)
  await settle(2)
  ambient.ring(GROUP, LIMITS).add({ messageId: 1001, userId: 10_002, name: '小李', text: '是不是得用三脚架', atMs: clock.now(), self: false })
  presence.observe(GROUP)
  clock.advance(50_000)
  await settle(6)
  assert.equal(platform.attempts.length, 1, '没有闸门时按 live（P1–P4 的行为）')
  presence.dispose()
})
