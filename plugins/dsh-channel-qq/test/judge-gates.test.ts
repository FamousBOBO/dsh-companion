/** 九门 → 决策表 → 折判：**纯函数**的三层，逐条钉住。
 *
 * 为什么这组测试这么值得写：换成"让模型直接选动作"之后，唯一能证明"她不会在吵架里
 * 插话"的东西就是这张表。表是纯函数，所以每条规则都能在毫秒内证明一次——
 * 而模型的行为只能靠夹具统计。两者都要，但先要有这一层。
 *
 * 覆盖的四类：
 *   1. **优先级**：安全门压过一切（吵架 / 钱 / 注入）；
 *   2. **边界**：一对一私聊与"有人求助"的重叠（那一处实测最容易误判）；
 *   3. **降级**：`reply` 目标不合格时降成 `react`，而不是整轮不说话；
 *   4. **保守**：短语没把握 / 缺门 / 缺答案时一律不说话。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  GATE_ORDER,
  GATE_QUESTIONS,
  PHRASE_BANKS,
  SCENES,
  gateFactsFrom,
  parseGateList,
  phraseTextOf,
  phrasesOf,
  ruleTable,
  type GateFacts,
  type GateId,
} from '../src/app/inbound/judge-gates.js'
import {
  candidateTargets,
  describeVerdict,
  factsOf,
  foldVerdict,
  phraseInventory,
  type ScoredAnswer,
  type TypedAnswers,
} from '../src/app/inbound/judge-verdict.js'
import type { JudgeLine, JudgeRequest } from '../src/app/inbound/judge-port.js'

/** 九门全 false 的事实向量。 */
function quiet(): Record<GateId, boolean> {
  const facts = {} as Record<GateId, boolean>
  for (const id of GATE_ORDER) facts[id] = false
  return facts
}

/** 一条判据：事实 → 期望动作 + 期望场景。 */
function expectRule(overrides: Partial<Record<GateId, boolean>>, action: string, scene: string | null): void {
  const outcome = ruleTable(gateFactsFrom({ ...quiet(), ...overrides }))
  assert.equal(outcome.action, action, `动作不对：${JSON.stringify(overrides)}`)
  assert.equal(outcome.scene, scene, `场景不对：${JSON.stringify(overrides)}`)
  assert.ok(outcome.why !== '', '每条结论都要有具名理由（日志要能解释）')
}

test('决策表：安全门压过一切（吵架 / 钱 / 注入）', () => {
  // 三个安全门各自单独成立时都要闭嘴，而且**优先级高于**"有人求助"。
  expectRule({ conflict: true }, 'silent', null)
  expectRule({ privacy: true }, 'silent', null)
  expectRule({ inject: true }, 'silent', null)
  expectRule({ conflict: true, help_open: true, tech_issue: true }, 'silent', null)
  expectRule({ privacy: true, share: true, casual: true }, 'silent', null)
  expectRule({ inject: true, help_open: true }, 'silent', null)
  // 安全门的理由要能区分是哪一个（否则日志里只有"没说话"）。
  assert.equal(ruleTable(gateFactsFrom({ ...quiet(), conflict: true })).why, 'safety:conflict')
  assert.equal(ruleTable(gateFactsFrom({ ...quiet(), privacy: true })).why, 'safety:privacy')
  assert.equal(ruleTable(gateFactsFrom({ ...quiet(), inject: true })).why, 'safety:inject')
})

test('决策表：话题已收尾时不补一句', () => {
  expectRule({ closed: true }, 'silent', null)
  assert.equal(ruleTable(gateFactsFrom({ ...quiet(), closed: true })).why, 'closed')
})

test('决策表：一对一私聊只在"不是在求助、也不是可接话题"时闭嘴', () => {
  // 纯两人来回聊：闭嘴。
  expectRule({ one_to_one: true }, 'silent', null)
  // 有两个人在聊，但其中一个人问了还没人答 → 那不是"插进别人的对话"，是填空。
  expectRule({ one_to_one: true, help_open: true }, 'reply', 'empathy')
  // 两个人在聊日常 / 在分享进展 → 一句短反应仍然成立（实测在 casual 上把 one_to_one 判 true，
  // 如果这条不排掉，"两个人聊天气"会被误判成私聊而完全不说话）。
  expectRule({ one_to_one: true, casual: true }, 'react', 'casual')
  expectRule({ one_to_one: true, share: true }, 'react', 'share')
  // 两个人在聊技术 → **仍然闭嘴**：一对一那扇门排在"技术话题"之前。
  // 理由是从夹具里撞出来的：两个人正在互相排查时她插一句"我也踩过这个坑"，
  // 那不是补充信息，而是打断了他们两个人之间的来回。要她参与的唯一入口是
  // `help_open`（有人问了还没人答）——那时"填空"才是名正言顺的。
  expectRule({ one_to_one: true, tech_issue: true }, 'silent', null)
})

test('决策表：有人求助 → reply，技术场景用 tech 库', () => {
  expectRule({ help_open: true }, 'reply', 'empathy')
  expectRule({ help_open: true, tech_issue: true }, 'reply', 'tech')
  // 求助优先于"技术话题"，但两者都指向技术场景时场景不变。
  assert.equal(ruleTable(gateFactsFrom({ ...quiet(), help_open: true, tech_issue: true })).why, 'unanswered-help')
})

test('决策表：技术 / 分享 / 日常各自的动作', () => {
  expectRule({ tech_issue: true }, 'join', 'tech')
  expectRule({ share: true }, 'react', 'share')
  expectRule({ casual: true }, 'react', 'casual')
  // 技术压过分享与日常（技术话题里"加油等好消息"是答非所问）。
  expectRule({ tech_issue: true, share: true, casual: true }, 'join', 'tech')
  // 分享压过日常。
  expectRule({ share: true, casual: true }, 'react', 'share')
})

test('决策表：什么都没发生 → 不说话', () => {
  expectRule({}, 'silent', null)
  assert.equal(ruleTable(gateFactsFrom(quiet())).why, 'no-topic')
})

test('门清单解析：认不出的丢掉，全不认时退回九门全开', () => {
  assert.deepEqual(parseGateList(GATE_ORDER.join(',')), [...GATE_ORDER])
  // 顺序由 GATE_ORDER 决定（配置里乱序不该改变问句顺序）。
  assert.deepEqual(parseGateList('share,casual'), ['casual', 'share'])
  // 认不出的丢掉、不去猜。
  assert.deepEqual(parseGateList('tech_issue, nope, share'), ['tech_issue', 'share'])
  // 全部认不出 → 九门全开（那是唯一有实测数据支撑的配置，不该退化成"什么都不问"）。
  assert.deepEqual(parseGateList('nope,what'), [...GATE_ORDER])
  // 空串 / 只有逗号 → 九门全开。
  assert.deepEqual(parseGateList(''), [...GATE_ORDER])
  assert.deepEqual(parseGateList(' , , '), [...GATE_ORDER])
  // 重复值去重。
  assert.deepEqual(parseGateList('share,share'), ['share'])
})

test('门的事实向量：缺的门按 false（方向保守）', () => {
  const facts = gateFactsFrom({ conflict: true })
  assert.equal(facts.conflict, true)
  for (const id of GATE_ORDER) {
    if (id === 'conflict') continue
    assert.equal(facts[id], false, `${id} 应该是 false`)
  }
})

test('短语库：四条硬约束（不空、不超长、不带 @、不重复）', () => {
  const inventory = phraseInventory()
  assert.equal(inventory.length, SCENES.length)
  for (const item of inventory) {
    assert.ok(item.count >= 3, `${item.scene} 的库至少要三条（少于三条时"选"没有信息量）`)
  }
  const total = inventory.reduce((sum, item) => sum + item.count, 0)
  assert.equal(total, 13, '短语库总条数（改动这个数要说清为什么）')
  for (const scene of SCENES) {
    const bank = phrasesOf(scene)
    const texts = new Set<string>()
    for (const [name, text] of Object.entries(bank)) {
      assert.ok(name !== '', `${scene} 有空 id`)
      assert.ok(text.length > 0 && text.length <= 70, `${scene}.${name} 长度越界（上限是 replyMaxChars 默认值）`)
      assert.ok(!text.includes('@'), `${scene}.${name} 带 @（整条会发不出去）`)
      assert.ok(!/\[cq:/i.test(text), `${scene}.${name} 带 CQ 码（整条会发不出去）`)
      assert.ok(!texts.has(text), `${scene} 里有两句一样的短语（选哪条都一样，概率再高也没信息）`)
      texts.add(text)
    }
  }
  assert.equal(phraseTextOf('tech', 'agree'), '这个说得对')
  assert.equal(phraseTextOf('tech', 'nope'), null)
})

test('九道问句都是**关于群里内容**的事实（不问"她能不能"）', () => {
  for (const id of GATE_ORDER) {
    const question = GATE_QUESTIONS[id]
    assert.ok(question.length > 0, `${id} 没有问句`)
    // 实测：问"她能不能插话"一律返回 false（p 0.75–0.97，4/4）。这条断言防止有人把问句改回去。
    assert.ok(!question.includes('插话'), `${id} 的问句问到了"她"（会一律判 false）`)
    assert.ok(!question.includes('她该'), `${id} 的问句问到了"她"`)
  }
})

/** 一个"技术求助"的判定输入（四条真实消息 + 现在几点）。 */
function request0(overrides: Partial<JudgeRequest> = {}): JudgeRequest {
  const nowMs = 1_000_000
  const base = nowMs - 60_000
  const lines: JudgeLine[] = [
    { messageId: 710, name: '小王', userId: 10001, text: '迁移脚本跑到一半报 deadlock', self: false, atMs: base },
    { messageId: 711, name: '老陈', userId: 10002, text: '你看下锁的粒度', self: false, atMs: base + 10_000 },
    { messageId: 712, name: '小王', userId: 10001, text: '好，我试试', self: false, atMs: base + 20_000 },
    { messageId: 713, name: '', userId: 10003, text: '她刚说过的一句话', self: true, atMs: base + 30_000 },
  ]
  return {
    groupId: 1_000_000_004,
    lines,
    state: 'State:\n[消息 710] …\n现在是 2026-11-19 20:45。',
    nowMs,
    replyMaxChars: 70,
    windowMs: 600_000,
    ...overrides,
  }
}

const LIMITS = { phraseMinProbability: 0.3, replyMaxChars: 70, windowMs: 600_000 }

/** 造一份 answers（九门 + 每场景的短语 + 目标）。 */
function answersOf(input: {
  gates?: Partial<Record<GateId, boolean>>
  phrase?: Record<string, ScoredAnswer | undefined>
  target?: ScoredAnswer
}): TypedAnswers {
  const gates: Partial<Record<GateId, ScoredAnswer>> = {}
  for (const [id, value] of Object.entries(input.gates ?? {})) {
    gates[id as GateId] = { answer: value === true ? 'true' : 'false', topProbability: 0.9 }
  }
  const phrases: Partial<Record<string, ScoredAnswer>> = {}
  for (const scene of SCENES) {
    const scored = input.phrase?.[scene]
    if (scored !== undefined) phrases[scene] = scored
  }
  return { gates, phrases, ...(input.target === undefined ? {} : { target: input.target }) }
}

const SURE = { answer: 'me_too', topProbability: 0.61 }

test('折判：求助 → reply 且带上真实目标号', () => {
  const outcome = foldVerdict(
    answersOf({ gates: { help_open: true, tech_issue: true }, phrase: { tech: SURE }, target: { answer: '710', topProbability: 0.5 } }),
    request0(),
    LIMITS,
  )
  assert.equal(outcome.verdict.kind, 'decision')
  if (outcome.verdict.kind !== 'decision') return
  assert.equal(outcome.verdict.action, 'reply')
  assert.equal(outcome.verdict.text, '我也踩过这个坑')
  assert.equal(outcome.verdict.targetMessageId, 710)
  assert.equal(outcome.scene, 'tech')
  assert.deepEqual(outcome.phrase, { name: 'me_too', probability: 0.61 })
})

test('折判：短语没把握 → 这一轮不说（不换一条低概率的话顶上）', () => {
  const outcome = foldVerdict(
    answersOf({ gates: { help_open: true }, phrase: { empathy: { answer: 'empathy', topProbability: 0.29 } } }),
    request0(),
    LIMITS,
  )
  assert.equal(outcome.verdict.kind, 'decision')
  if (outcome.verdict.kind !== 'decision') return
  assert.equal(outcome.verdict.action, 'silent')
  assert.match(outcome.verdict.reason, /^phrase-low-confidence:/)
  // 概率仍然进账本（它是"阈值该不该重标"的唯一证据）。
  assert.deepEqual(outcome.phrase, { name: 'empathy', probability: 0.29 })
})

test('折判：决策表要说话但那个场景没给答案 → invalid（是失败，会累积）', () => {
  const outcome = foldVerdict(
    answersOf({ gates: { tech_issue: true } }),
    request0(),
    LIMITS,
  )
  assert.equal(outcome.verdict.kind, 'invalid')
  if (outcome.verdict.kind !== 'invalid') return
  assert.equal(outcome.verdict.reason, 'phrase-missing')
})

test('折判：目标号不在本轮消息里 → reply 降级成 react（不带目标）', () => {
  const outcome = foldVerdict(
    answersOf({ gates: { help_open: true }, phrase: { empathy: { answer: 'agree', topProbability: 0.7 } }, target: { answer: '999', topProbability: 0.4 } }),
    request0(),
    LIMITS,
  )
  assert.equal(outcome.verdict.kind, 'decision')
  if (outcome.verdict.kind !== 'decision') return
  assert.equal(outcome.verdict.action, 'react')
  assert.equal('targetMessageId' in outcome.verdict ? outcome.verdict.targetMessageId : undefined, undefined)
  assert.match(outcome.verdict.reason, /^reply-degraded:/)
})

test('折判：react 的目标号合法时保留它', () => {
  const outcome = foldVerdict(
    answersOf({ gates: { casual: true }, phrase: { casual: { answer: 'light', topProbability: 0.5 } }, target: { answer: '712', topProbability: 0.5 } }),
    request0(),
    LIMITS,
  )
  assert.equal(outcome.verdict.kind, 'decision')
  if (outcome.verdict.kind !== 'decision') return
  assert.equal(outcome.verdict.action, 'react')
  assert.equal('targetMessageId' in outcome.verdict ? outcome.verdict.targetMessageId : undefined, 712)
})

test('折判：join 的话题就是场景名（短语库按场景切，话题就是它）', () => {
  const outcome = foldVerdict(
    answersOf({ gates: { tech_issue: true }, phrase: { tech: { answer: 'curious', topProbability: 0.4 } } }),
    request0(),
    LIMITS,
  )
  assert.equal(outcome.verdict.kind, 'decision')
  if (outcome.verdict.kind !== 'decision') return
  assert.equal(outcome.verdict.action, 'join')
  assert.equal('topic' in outcome.verdict ? outcome.verdict.topic : undefined, 'tech')
})

test('折判：安全门 → silent（不查短语、不查目标）', () => {
  const outcome = foldVerdict(answersOf({ gates: { conflict: true, help_open: true } }), request0(), LIMITS)
  assert.equal(outcome.verdict.kind, 'decision')
  if (outcome.verdict.kind !== 'decision') return
  assert.equal(outcome.verdict.action, 'silent')
  assert.equal(outcome.verdict.reason, 'safety:conflict')
  assert.equal(outcome.scene, null)
  assert.equal(outcome.phrase, null)
})

test('目标候选：排除她自己、合成消息（null 号）与过期消息', () => {
  const nowMs = 1_000_000
  const lines: JudgeLine[] = [
    { messageId: 1, name: 'a', userId: 1, text: 'x', self: false, atMs: nowMs - 900_000 },
    { messageId: null, name: 'b', userId: 2, text: 'y', self: false, atMs: nowMs - 10_000 },
    { messageId: 3, name: '', userId: 9, text: 'z', self: true, atMs: nowMs - 5_000 },
    { messageId: 4, name: 'c', userId: 3, text: 'w', self: false, atMs: nowMs - 1_000 },
  ]
  assert.deepEqual(candidateTargets(lines, nowMs, 600_000, 0), [4])
  // `maxCount > 0` 时只留最近几个。
  assert.deepEqual(candidateTargets([...lines, { messageId: 5, name: 'd', userId: 4, text: 'v', self: false, atMs: nowMs }], nowMs, 0, 2),
    [4, 5])
})

test('factsOf：只认字符串 true（`"TRUE"` / 概率都不算）', () => {
  const facts = factsOf({
    gates: { conflict: { answer: 'TRUE', topProbability: 0.9 }, privacy: { answer: 'true', topProbability: 0.9 } },
    phrases: {},
  })
  assert.equal(facts.conflict, false)
  assert.equal(facts.privacy, true)
})

test('describeVerdict：三种形状都能压成一句可读日志', () => {
  assert.equal(describeVerdict({ kind: 'no-route', detail: '未配置' }), '判断不可用（未配置）')
  assert.equal(describeVerdict({ kind: 'invalid', reason: 'phrase-missing' }), '判断结果不可用（phrase-missing）')
  assert.equal(describeVerdict({ kind: 'decision', action: 'silent', reason: 'safety:conflict' }),
    'silent：safety:conflict')
  assert.equal(describeVerdict({ kind: 'decision', action: 'reply', text: '好的', reason: 'unanswered-help', targetMessageId: 710 }),
    'reply（2 字，引用 #710）：unanswered-help')
})

test('短语库与场景清单同源（`PHRASE_BANKS` 的键就是 `SCENES`）', () => {
  assert.deepEqual(Object.keys(PHRASE_BANKS).sort(), [...SCENES].sort())
  // 每个库至少要有一条"认同/轻反应"（否则没话说时连"这个说得对"都发不出来）。
  for (const scene of SCENES) assert.ok(Object.keys(PHRASE_BANKS[scene]).length >= 3)
})

test('事实向量的类型面：九门一个都不能少', () => {
  const facts: GateFacts = gateFactsFrom({})
  assert.equal(Object.keys(facts).length, GATE_ORDER.length)
})
