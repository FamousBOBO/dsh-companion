/** 群聊旁听的**执行器**（状态机 + 一次判断流程）测试。
 *
 * 纪律：不发真 QQ、不调真模型、不读真库。时间全部由 `FakeClock` 推进（不 sleep），
 * 模型由可控的假 `CompletePort` 顶替，外发全部落在 `FakePlatform` 上。
 *
 * 这里钉住的是**行为**，不是内部字段：
 *   - 合批：一条消息不会立刻触发判断，要等满一个 `judgeIntervalMs`，且窗口不因后续消息顺延；
 *   - 记账：**只有真实 `message_id` 回执**才 `recordSent` + 推进发言冷却 + 回灌旁听；
 *     失败/无回执只是失败，不占冷却、不占小时额度、不重试、不连发；
 *   - 隔离：多群各自一份状态（冷却与额度互不影响）；
 *   - 热加载：新实例看到旧缓冲**不补发**，只有上线之后的新消息才进判断；
 *   - 卸载：`dispose()` 取消定时器，并且在途的判断结果被丢弃（不再发消息）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AmbientLimits } from '../src/core/ambient.js'
import type { Clock } from '../src/ports/clock.js'
import { AmbientStore } from '../src/app/inbound/ambient-store.js'
import { GroupPresence } from '../src/app/inbound/presence-runtime.js'
import type { CompletePort, CompleteResult, PresenceView } from '../src/app/inbound/presence-flow.js'
import type { GroupPersonaSnapshot } from '../src/app/inbound/group-persona.js'
import { FakeClock, FakePlatform, settle } from './fakes/contact.js'

const START = new Date(2026, 10, 1, 22, 0, 0).getTime()
const GROUP = 145326153
const OTHER = 1_003_000
const LIMITS: AmbientLimits = { maxEntries: 40, ttlMs: 600_000, maxChars: 6_000 }

/** 「不说」的合法回复（模型正常回答"不接话"，这在记账上是**成功**）。 */
const SILENT = '{"speak":false,"reply":"","why":"寒暄，没有可补充的内容"}'
/** 「说」的回复。 */
const SPEAK = '{"speak":true,"reply":"手持的话把快门提到 1/250 试试，糊多半是手抖。","why":"具体的摄影参数问题"}'

/** P0 用的快照：断言"提示词读的是快照"而不是写死的文案。 */
const PERSONA: GroupPersonaSnapshot = {
  version: 'abc12345',
  personaId: 'bot',
  identity: '叫阿七，喜欢拍照。',
  personality: '话不多，但会说具体的。',
  speakingStyle: '短句、口语。',
  interests: ['摄影参数'],
  knownExperiences: ['拍过一整年的月亮'],
  publicFacts: ['住在杭州'],
  interactionBoundaries: ['不谈别人的家事'],
  source: 'config/persona.md',
}

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

interface Judge {
  /** 每次判断收到的完整提示词（断言背景/口径都靠它）。 */
  readonly calls: string[]
  /** 下一次判断返回什么（`result` 优先于 `reply`）。 */
  result: CompleteResult | null
  reply: string
  /** 非空时这一次调用挂住，直到测试自己 resolve（测"在途"）。 */
  gate: (() => Promise<CompleteResult>) | null
}

interface Harness {
  readonly clock: FakeClock
  readonly ambient: AmbientStore
  readonly judge: Judge
  readonly logs: string[]
  readonly sentLog: Array<{ groupId: number; messageId: number | null; text: string }>
  readonly presence: GroupPresence
  /** 当前（可替换的）平台——`platform()` 每次现取，用来模拟热加载换客户端。 */
  platform: FakePlatform
  /** 模拟流水线：先写旁听环，再调 `observe`。 */
  push(groupId: number, text: string, over?: { userId?: number; name?: string; self?: boolean; messageId?: number }): void
  /** 推进假时钟并让异步续体落地。 */
  tick(ms: number): Promise<void>
}

function harness(over: {
  view?: Partial<PresenceView>
  judge?: string
  start?: number
  clock?: FakeClock
  ambient?: AmbientStore
  platform?: FakePlatform
  /** 人格快照提供者（P0）；缺省 = 取不到（走降级人格）。 */
  persona?: () => GroupPersonaSnapshot | null
} = {}): Harness {
  const clock = over.clock ?? new FakeClock(over.start ?? START)
  const logs: string[] = []
  const ambient = over.ambient ?? new AmbientStore({ log: (line) => logs.push(line) })
  const sentLog: Harness['sentLog'] = []
  const judge: Judge = { calls: [], result: null, reply: over.judge ?? SILENT, gate: null }
  const complete: CompletePort = {
    async complete(request) {
      judge.calls.push(request.prompt)
      if (judge.gate !== null) return await judge.gate()
      if (judge.result !== null) return judge.result
      return { kind: 'text', text: judge.reply }
    },
  }
  const platform = over.platform ?? new FakePlatform({ clock })
  let current: FakePlatform = platform
  const presence = new GroupPresence({
    config: () => ({ presence: view(over.view) }),
    clock: clock as Clock,
    log: (line) => logs.push(line),
    platform: () => current,
    ambient,
    complete,
    recordSent: async (groupId, messageId, text) => {
      sentLog.push({ groupId, messageId, text })
    },
    // 人格快照：默认给"取不到"，只有专门测 P0 接线的用例才传 `persona`。
    persona: over.persona ?? (() => null),
  })
  let nextId = 1000
  const ringOf = (groupId: number) => ambient.ring(groupId, LIMITS)
  const harnessed: Harness = {
    clock,
    ambient,
    judge,
    logs,
    sentLog,
    presence,
    get platform() {
      return current
    },
    set platform(next: FakePlatform) {
      current = next
    },
    push(groupId, text, opts = {}) {
      ringOf(groupId).add({
        messageId: opts.messageId ?? nextId++,
        userId: opts.userId ?? 10_001,
        name: opts.name ?? '小王',
        text,
        atMs: clock.now(),
        self: opts.self ?? false,
      })
      presence.observe(groupId)
    },
    async tick(ms) {
      clock.advance(ms)
      await settle(4)
    },
  }
  return harnessed
}

/** 一个可以手动结算的承诺（测"判断在途时被卸载"）。 */
function deferred(): { readonly promise: Promise<CompleteResult>; resolve(result: CompleteResult): void } {
  let settleIt: (result: CompleteResult) => void = () => {}
  const promise = new Promise<CompleteResult>((resolve) => {
    settleIt = resolve
  })
  return { promise, resolve: (result) => settleIt(result) }
}

/** 走完"第一条消息（判断太早）→ 等满间隔 → 再来一条（武装）→ 到点判断"这一套。 */
async function firstJudgment(h: Harness, groupId = GROUP): Promise<void> {
  h.push(groupId, '小王(10001) 22:00：晚上拍月亮老是糊')
  await h.tick(300_000)
  h.push(groupId, '小李(10002) 22:05：是不是得用三脚架')
  await h.tick(50_000)
}

// ── 合批 ────────────────────────────────────────────────────────────────────

test('合批：首条不会立刻判断，满一个 judgeIntervalMs 才判，窗口不因后续消息顺延', async () => {
  const h = harness()
  h.push(GROUP, '小王(10001) 22:00：第一句')
  await h.tick(10_000)
  assert.equal(h.judge.calls.length, 0, '刚上线时不能立刻回放旧批次')
  assert.equal(h.clock.liveCount(), 0, '"判断太早"连定时器都不该武装')

  // 满一个间隔后的新消息才武装定时器
  await h.tick(40_000)
  h.push(GROUP, '小李(10002) 22:01：第二句')
  assert.equal(h.clock.liveCount(), 1, '应当武装一个合批定时器')

  // 窗口内的后续消息不顺延定时器
  await h.tick(20_000)
  h.push(GROUP, '小张(10003) 22:02：第三句')
  await h.tick(29_999)
  assert.equal(h.judge.calls.length, 0, '不到点不判断')
  await h.tick(1)
  assert.equal(h.judge.calls.length, 1, '到点判断一次')
  // 三条都被合进同一批（第一条也没丢：它一直没被判过）
  const prompt = h.judge.calls[0] ?? ''
  assert.match(prompt, /第一句/)
  assert.match(prompt, /第二句/)
  assert.match(prompt, /第三句/)
  assert.equal(h.clock.liveCount(), 0, '判断完定时器要消失')
})

// ── 说：真回执才算说过话 ────────────────────────────────────────────────────

test('判断通过 → 发一条纯文本；回执才记 sent-log、才回灌旁听', async () => {
  const h = harness({ judge: SPEAK })
  await firstJudgment(h)
  assert.equal(h.platform.count(), 1, '应当只发一条')
  assert.equal(h.platform.sent[0]?.text, '手持的话把快门提到 1/250 试试，糊多半是手抖。')
  assert.equal(h.platform.sent[0]?.target, GROUP)
  assert.equal(h.platform.sent[0]?.via, 'sendGroupMessage')
  // 回执号来自假平台（90000 + 第几条）
  assert.deepEqual(h.sentLog, [{ groupId: GROUP, messageId: 90001, text: h.platform.sent[0]?.text }])
  // 她自己那条被回灌旁听（下一次判断/回合要能看见"这是我自己说的"）
  const live = h.ambient.ring(GROUP, LIMITS).live(h.clock.now())
  const tail = live[live.length - 1]
  assert.equal(tail?.self, true)
  assert.equal(tail?.text, '手持的话把快门提到 1/250 试试，糊多半是手抖。')
  assert.ok(h.logs.some((line) => line.includes('已自主发言')), h.logs.join('\n'))
})

// ── 不说 ────────────────────────────────────────────────────────────────────

test('模型说"不说" → 一条都不发，只推进判断时刻', async () => {
  const h = harness({ judge: SILENT })
  await firstJudgment(h)
  assert.equal(h.judge.calls.length, 1)
  assert.equal(h.platform.count(), 0)
  assert.equal(h.sentLog.length, 0)
  assert.ok(h.logs.some((line) => line.includes('判断为不说话')), h.logs.join('\n'))
})

// ── 失败不计入发送 ──────────────────────────────────────────────────────────

test('判断失败 → 不发、不记 sent-log，也不占发言冷却（下一次照样能说）', async () => {
  const h = harness({ judge: SPEAK })
  h.judge.result = { kind: 'failed', detail: 'provider-error:INVALID_REQUEST' }
  await firstJudgment(h)
  assert.equal(h.platform.count(), 0, '判断失败不能发消息')
  assert.equal(h.sentLog.length, 0, '判断失败不能记成功')
  assert.ok(h.logs.some((line) => line.includes('判断调用不可用')), h.logs.join('\n'))

  // 失败没有吃掉冷却/额度：下一批判断通过就能立刻说
  h.judge.result = null
  await h.tick(50_000)
  h.push(GROUP, '小王(10001) 22:10：那我把快门提上去试试')
  await h.tick(50_000)
  assert.equal(h.judge.calls.length, 2)
  assert.equal(h.platform.count(), 1, '失败之后的第一次成功发言必须能发出去')
})

test('没有 message_id 回执 → 发过但不记成功、不重试、不占用冷却', async () => {
  const h = harness({ judge: SPEAK })
  h.platform.loseReceipt = true
  await firstJudgment(h)
  assert.equal(h.platform.attempts.length, 1, '只尝试一次（不重试）')
  assert.equal(h.platform.count(), 1, '消息确实发出去了')
  assert.equal(h.sentLog.length, 0, '没有回执就不能记成功')
  assert.ok(h.logs.some((line) => line.includes('没有 message_id 回执')), h.logs.join('\n'))
  assert.equal(h.platform.attempts.length, 1, '不许因为没回执而重发')

  // 冷却没被占用：下一次判断通过就能再发
  h.platform.loseReceipt = false
  await h.tick(50_000)
  h.push(GROUP, '小王(10001) 22:10：那我再试一次')
  await h.tick(50_000)
  assert.equal(h.platform.count(), 2, '无回执的那次不能占掉冷却')
  assert.equal(h.sentLog.length, 1)
})

test('发送抛错 → 只记一次失败，不重试、不连发', async () => {
  const h = harness({ judge: SPEAK })
  h.platform.failWith = 'QQ not connected'
  await firstJudgment(h)
  assert.equal(h.platform.attempts.length, 1, '发送失败不重试')
  assert.equal(h.sentLog.length, 0)
  assert.ok(h.logs.some((line) => line.includes('发送失败')), h.logs.join('\n'))
  await h.tick(600_000)
  assert.equal(h.platform.attempts.length, 1, '不许把失败的消息排队重发')
})

// ── 限频 ────────────────────────────────────────────────────────────────────

test('冷却：一次成功发言后 speakMinIntervalMs 内不再开口', async () => {
  const h = harness({ judge: SPEAK })
  await firstJudgment(h)
  assert.equal(h.platform.count(), 1)

  await h.tick(50_000)
  h.push(GROUP, '小王(10001) 22:10：那我再问个构图的问题')
  await h.tick(50_000)
  assert.equal(h.judge.calls.length, 2, '冷却期里判断照常做（只是不发）')
  assert.equal(h.platform.count(), 1, '冷却期里不许发')
  assert.ok(h.logs.some((line) => line.includes('speak-cooldown')), h.logs.join('\n'))
})

test('小时上限：speakMaxPerHour 到了就不再发', async () => {
  // 用短间隔把"每轮都要满 50 秒"的等待压掉
  const h = harness({ view: { judgeIntervalMs: 1_000, speakMinIntervalMs: 1_000, speakMaxPerHour: 2 }, judge: SPEAK })
  for (let round = 0; round < 3; round += 1) {
    h.push(GROUP, `小王(10001) 22:0${String(round)}：第 ${String(round)} 轮的问题`)
    await h.tick(1_000)
    h.push(GROUP, `小李(10002) 22:0${String(round)}：接一句`)
    await h.tick(1_000)
  }
  assert.equal(h.platform.count(), 2, '每小时只允许 2 次')
  assert.ok(h.logs.some((line) => line.includes('hour-quota')), h.logs.join('\n'))
})

test('多群隔离：一个群说完冷却中，另一个群照样能说', async () => {
  const h = harness({
    view: { groups: [GROUP, OTHER], judgeIntervalMs: 1_000, speakMinIntervalMs: 3_000 },
    judge: SPEAK,
  })
  // A 群先说一句（`emptyPresenceState` 让"上线后的第一次发言"要等满一个冷却）
  h.push(GROUP, '小王(10001) 22:00：A 群的问题')
  await h.tick(3_000)
  h.push(GROUP, '小王(10001) 22:00：A 群再一句')
  await h.tick(1_000)
  assert.equal(h.platform.textsTo(GROUP).length, 1, 'A 群应当能说一句')

  // A 群还在冷却：判断照做，但不许发
  h.push(GROUP, '小王(10001) 22:01：A 群第三句')
  await h.tick(1_000)
  h.push(GROUP, '小王(10001) 22:01：A 群第四句')
  await h.tick(1_000)
  assert.equal(h.platform.textsTo(GROUP).length, 1, 'A 群冷却期里不许再发')

  // B 群有自己的状态：不受 A 群冷却影响
  h.push(OTHER, '小赵(10009) 22:02：B 群的问题')
  await h.tick(3_000)
  h.push(OTHER, '小赵(10009) 22:02：B 群再一句')
  await h.tick(1_000)
  assert.equal(h.platform.textsTo(OTHER).length, 1, 'B 群要能各自说')
  assert.equal(h.platform.textsTo(GROUP).length, 1, 'A 群没有被 B 群影响')
})

// ── 热加载 ──────────────────────────────────────────────────────────────────

test('热加载：新实例不补发旧缓冲，只有上线之后的新消息进判断', async () => {
  const clock = new FakeClock(START)
  const ambient = new AmbientStore({ log: () => {} })
  // 旧批次：她"上线"之前就已经在缓冲里（另一个实例写的）
  const old = ambient.ring(GROUP, LIMITS)
  for (const text of ['老消息一', '老消息二', '老消息三']) {
    old.add({ messageId: null, userId: 10_001, name: '小王', text, atMs: clock.now(), self: false })
  }
  const h = harness({ clock, ambient, judge: SPEAK })
  h.push(GROUP, '新消息甲')
  await h.tick(300_000)
  h.push(GROUP, '新消息乙')
  await h.tick(50_000)
  assert.equal(h.judge.calls.length, 1)
  const prompt = h.judge.calls[0] ?? ''
  assert.match(prompt, /新消息甲/)
  assert.match(prompt, /新消息乙/)
  for (const text of ['老消息一', '老消息二', '老消息三']) {
    assert.ok(!prompt.includes(text), `旧批次不该被回放：${text}`)
  }
  assert.equal(h.platform.count(), 1)
})

// ── 人格快照（P0）：每轮现取、改动立刻生效、取不到就明说降级 ──────────────────

test('人格快照进提示词：身份来自快照，不是写死的文案', async () => {
  const h = harness({ judge: SILENT, persona: () => PERSONA })
  await firstJudgment(h)
  const prompt = h.judge.calls[0] ?? ''
  assert.match(prompt, /【你是谁（群聊可见的人格快照）】/)
  assert.match(prompt, /身份：叫阿七/)
})

test('快照每轮现取：人格文件改了（版本号变了）下一轮判断就用新的', async () => {
  let current = PERSONA
  const h = harness({ judge: SILENT, persona: () => current })
  await firstJudgment(h)
  assert.match(h.judge.calls[0] ?? '', /身份：叫阿七/)
  current = { ...PERSONA, version: 'def67890', identity: '改过名字了，叫小八。' }
  await firstJudgment(h)
  assert.match(h.judge.calls[1] ?? '', /身份：改过名字了，叫小八/)
  assert.match(h.judge.calls[1] ?? '', /快照版本 def67890/)
})

test('取不到快照：提示词明说降级，判断照常做（不阻断主动接话）', async () => {
  const h = harness({ judge: SILENT, persona: () => null })
  await firstJudgment(h)
  assert.equal(h.judge.calls.length, 1, '拿不到人格也要照常判断')
  assert.match(h.judge.calls[0] ?? '', /【人格快照不可用】/)
  assert.ok(h.logs.some((line) => line.includes('人格快照不可用')), h.logs.join('\n'))
})

test('取快照抛错：只降级、不冒泡（这条路径上异常等于这一轮少一段人格）', async () => {
  const h = harness({
    judge: SILENT,
    persona: () => {
      throw new Error('foundation boom')
    },
  })
  await firstJudgment(h)
  assert.equal(h.judge.calls.length, 1)
  assert.match(h.judge.calls[0] ?? '', /【人格快照不可用】/)
  assert.ok(h.logs.some((line) => line.includes('取人格快照抛错')), h.logs.join('\n'))
})

// ── 消息身份（P0）：背景带发送者与消息号，她自己的话标成"自己" ──────────────────

test('背景渲染带上真实消息号与发送者：模型能对上"哪条是谁说的"', async () => {
  const h = harness({ judge: SILENT, persona: () => PERSONA })
  // 用**真实写入形态**（`renderMessageLine` 的产物）：时间在前、昵称(QQ号) 在后、带 #消息号。
  h.push(GROUP, '2026-11-01 22:00 小王(10001) #501：晚上拍月亮老是糊', {
    messageId: 501, name: '小王', userId: 10_001,
  })
  await h.tick(300_000)
  h.push(GROUP, '2026-11-01 22:05 小李(10002) #502：是不是得用三脚架', {
    messageId: 502, name: '小李', userId: 10_002,
  })
  await h.tick(50_000)
  const prompt = h.judge.calls[0] ?? ''
  assert.match(prompt, /\[消息 501\] \[成员 小王 \/ QQ 10001\]/)
  assert.match(prompt, /\[消息 502\] \[成员 小李 \/ QQ 10002\]/)
  // 身份只出现一次：不再靠整行里的"昵称(QQ号)"再重复一遍
  assert.equal(prompt.split('10001').length - 1, 1)
})

test('她自己刚发的回灌进旁听时带 body：背景里标成"你（自己）"，不是群友说的', async () => {
  const h = harness({ judge: SPEAK, persona: () => PERSONA })
  await firstJudgment(h)
  assert.equal(h.platform.count(), 1)
  const live = h.ambient.ring(GROUP, LIMITS).live(h.clock.now())
  const tail = live[live.length - 1]
  assert.equal(tail?.self, true)
  assert.equal(tail?.body, tail?.text, '回灌那条的 body 就是正文（它没有发送者抬头）')
})

// ── 开关与卸载 ──────────────────────────────────────────────────────────────

test('开关关着 / 不在白名单 → 一条都不判、一条都不发', async () => {
  const off = harness({ view: { enabled: false }, judge: SPEAK })
  await firstJudgment(off)
  assert.equal(off.judge.calls.length, 0)
  assert.equal(off.platform.attempts.length, 0)

  const other = harness({ judge: SPEAK })
  other.push(OTHER, '小赵(10009) 22:00：不在白名单的群')
  await other.tick(600_000)
  assert.equal(other.judge.calls.length, 0)
  assert.equal(other.platform.attempts.length, 0)
})

test('dispose() 取消定时器：之后不再判断、不再发送', async () => {
  const h = harness({ judge: SPEAK })
  h.push(GROUP, '小王(10001) 22:00：第一句')
  await h.tick(50_000)
  h.push(GROUP, '小李(10002) 22:01：第二句')
  assert.equal(h.clock.liveCount(), 1)
  h.presence.dispose()
  assert.equal(h.clock.liveCount(), 0, 'dispose 必须取消所有定时器')
  await h.tick(600_000)
  assert.equal(h.judge.calls.length, 0)
  assert.equal(h.platform.attempts.length, 0)
})

test('dispose() 之后到达的在途判断结果被丢弃（不会再发消息）', async () => {
  const h = harness()
  const gate = deferred()
  h.judge.gate = () => gate.promise
  h.push(GROUP, '小王(10001) 22:00：第一句')
  await h.tick(50_000)
  h.push(GROUP, '小李(10002) 22:01：第二句')
  await h.tick(50_000)
  assert.equal(h.judge.calls.length, 1, '判断应当已经在途')
  h.presence.dispose()
  gate.resolve({ kind: 'text', text: SPEAK })
  await settle(6)
  assert.equal(h.platform.attempts.length, 0, '卸载之后不许再发消息')
})
