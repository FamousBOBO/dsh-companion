/** P9-G4 §3 / §4.1：参与者身份段 + 互动风险的单元测试。
 *
 * 这一层有两个失败方向，代价完全不同，所以每个判据都成对写：
 *   - **身份判错**（把人类当 bot / 把 bot 当人类）会让她的社交判断建立在假事实上，
 *     而且错得**看不见**——群里没人会发现她认错了人；
 *   - **风险判高**会让"她该说话时闭嘴"，这个错误同样看不见（没人会抱怨她没说话）。
 *
 * 所以每条规则都配一个**必须不触发**的反例，尤其是"前一条消息来自 Bot"这一条：
 * 计划 §4.1 明写不得仅因上一条是 Bot 就判高风险，而那是这一层最容易写错的地方。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  assessInteractionRisk,
  riskAdvice,
  RISK_THRESHOLDS,
  type RiskEntry,
} from '../src/core/bot-ecology.js'
import { renderParticipants, renderRisk, ECOLOGY_MAX_CHARS } from '../src/app/inbound/group-ecology-prompt.js'
import type { GroupParticipant } from '../src/core/participant.js'

const SELF = 2_668_517_323
const BOT_A = 10_001
const BOT_B = 10_002
const HUMAN = 10_003
const STRANGER = 10_004
const T0 = new Date(2026, 10, 9, 21, 0, 0).getTime()

/** 一条背景消息（默认是已确认的人说的普通内容）。 */
function entry(over: Partial<RiskEntry> = {}): RiskEntry {
  return {
    messageId: 1,
    userId: HUMAN,
    senderKind: 'known_human',
    text: '这个我上周也遇到过',
    atMs: T0,
    self: false,
    ...over,
  }
}

function participant(over: Partial<GroupParticipant> = {}): GroupParticipant {
  return {
    userId: HUMAN,
    displayName: '小王',
    senderKind: 'known_human',
    source: 'manual_registry',
    ...over,
  }
}

// ── §4.1：不得仅因"上一条来自 Bot"就判高风险 ──────────────────────────

test('§4.1：只有一条 bot 的实质发言 → low（身份不是风险，内容才是）', () => {
  const risk = assessInteractionRisk([entry({ userId: BOT_A, senderKind: 'known_bot', text: '我试过这个方案，可行' })], T0)
  assert.equal(risk.botLoopRisk, 'low')
  assert.equal(risk.reason, undefined, '低风险不该编一个理由')
})

test('§4.1：两个 bot 各说各的实质内容 → 不是 high（还没形成循环）', () => {
  const risk = assessInteractionRisk([
    entry({ messageId: 1, userId: BOT_A, senderKind: 'known_bot', text: '推荐用缓存', atMs: T0 }),
    entry({ messageId: 2, userId: BOT_B, senderKind: 'known_bot', text: '图片压缩也有帮助', atMs: T0 + 1000 }),
  ], T0 + 2000)
  assert.notEqual(risk.botLoopRisk, 'high')
})

// ── 高风险的三个判据 ──────────────────────────────────────────────────

test('高风险：两个不同的人说了几乎同一句 → high，且理由带消息号', () => {
  const risk = assessInteractionRisk([
    entry({ messageId: 11, userId: BOT_A, senderKind: 'known_bot', text: '建议先清理缓存再试一次' }),
    entry({ messageId: 12, userId: BOT_B, senderKind: 'known_bot', text: '建议先清理缓存再试一次' }),
  ], T0)
  assert.equal(risk.botLoopRisk, 'high')
  assert.equal(risk.semanticDuplicate, true)
  assert.match(risk.reason ?? '', /11|12/)
})

test('高风险：同一个人连说两句相似的话 → 不算重复（那是补充说明）', () => {
  const risk = assessInteractionRisk([
    entry({ messageId: 21, userId: BOT_A, senderKind: 'known_bot', text: '建议先清理缓存再试一次' }),
    entry({ messageId: 22, userId: BOT_A, senderKind: 'known_bot', text: '建议先清理缓存再试一次' }),
  ], T0)
  assert.equal(risk.semanticDuplicate, false)
  assert.notEqual(risk.botLoopRisk, 'high')
})

test('高风险：三个人对同一条消息各回一次（重复重启同一话题） → high', () => {
  const risk = assessInteractionRisk([
    entry({ messageId: 31, userId: BOT_A, senderKind: 'known_bot', text: '我觉得可以', replyToMessageId: 9, atMs: T0 }),
    entry({ messageId: 32, userId: BOT_B, senderKind: 'known_bot', text: '我同意上面', replyToMessageId: 9, atMs: T0 + 1000 }),
    entry({ messageId: 33, userId: HUMAN, senderKind: 'known_human', text: '确实', replyToMessageId: 9, atMs: T0 + 2000 }),
  ], T0 + 3000)
  assert.equal(risk.botLoopRisk, 'high')
})

test('高风险：尾部连续三条纯客套 → high（礼貌性互动循环）', () => {
  const risk = assessInteractionRisk([
    entry({ messageId: 41, userId: BOT_A, senderKind: 'known_bot', text: '谢谢' }),
    entry({ messageId: 42, userId: BOT_B, senderKind: 'known_bot', text: '感谢分享' }),
    entry({ messageId: 43, userId: HUMAN, senderKind: 'known_human', text: '好的' }),
  ], T0)
  assert.equal(risk.botLoopRisk, 'high')
  assert.equal(RISK_THRESHOLDS.politenessRun, 3)
})

test('客套判定：中间夹一句实质发言就断掉（"谢谢 → 有个问题"不是循环）', () => {
  const risk = assessInteractionRisk([
    entry({ messageId: 51, userId: BOT_A, senderKind: 'known_bot', text: '谢谢' }),
    entry({ messageId: 52, userId: BOT_B, senderKind: 'known_bot', text: '这个配置我建议改成 20 秒' }),
    entry({ messageId: 53, userId: HUMAN, senderKind: 'known_human', text: '好的' }),
  ], T0)
  // 只有尾部两条客套 → 不到 3 条。
  assert.notEqual(risk.botLoopRisk, 'high')
})

test('客套判定：长得像客套但内容更长的句子不算客套', () => {
  const risk = assessInteractionRisk([
    entry({ messageId: 61, userId: BOT_A, senderKind: 'known_bot', text: '好的，不过我觉得这个方案还得再改改' }),
    entry({ messageId: 62, userId: BOT_B, senderKind: 'known_bot', text: '好的，我今晚有空再试一次看看' }),
    entry({ messageId: 63, userId: HUMAN, senderKind: 'known_human', text: '好的，那我等你消息' }),
  ], T0)
  assert.notEqual(risk.botLoopRisk, 'high', '超过 12 个字的"好的…"不是纯客套')
})

// ── 中风险 ────────────────────────────────────────────────────────────

test('中风险：已经有人实质回答过，但还有新信息 → medium 且 alreadyAnswered', () => {
  const risk = assessInteractionRisk([
    entry({ messageId: 71, userId: BOT_A, senderKind: 'known_bot', text: '这个要看你的 Node 版本' }),
    entry({ messageId: 72, userId: HUMAN, senderKind: 'known_human', text: '我用的 24' }),
  ], T0)
  assert.equal(risk.botLoopRisk, 'medium')
  assert.equal(risk.alreadyAnswered, true)
  assert.equal(risk.newInformation, true)
})

test('高/中风险：两个 bot 互相 @ 说客套 —— 高度重复的问候算 high，不重复的算 medium', () => {
  // 几乎同一句问候 = 已经在循环里（这与"两个不同的人说了几乎同一句"是同一条判据）。
  const greeting = assessInteractionRisk([
    entry({ messageId: 81, userId: BOT_A, senderKind: 'known_bot', text: '你好呀', atIds: [BOT_B] }),
    entry({ messageId: 82, userId: BOT_B, senderKind: 'known_bot', text: '你好', atIds: [BOT_A] }),
  ], T0)
  assert.equal(greeting.botLoopRisk, 'high')
  // 内容不重复、但两个 bot 谁都没说实质内容 → medium（要参与就得给点别处没有的）。
  const smallTalk = assessInteractionRisk([
    entry({ messageId: 83, userId: BOT_A, senderKind: 'known_bot', text: '早上好', atIds: [BOT_B] }),
    entry({ messageId: 84, userId: BOT_B, senderKind: 'known_bot', text: '今天天气不错', atIds: [BOT_A] }),
  ], T0)
  assert.equal(smallTalk.botLoopRisk, 'medium')
})

// ── 建议文本 ──────────────────────────────────────────────────────────

test('风险建议：低风险没有建议；高风险指明优先 silent / observe', () => {
  assert.equal(riskAdvice({ botLoopRisk: 'low', semanticDuplicate: false, alreadyAnswered: false, newInformation: true }), null)
  const high = riskAdvice({ botLoopRisk: 'high', semanticDuplicate: true, alreadyAnswered: true, newInformation: false })
  assert.match(high ?? '', /silent/)
  assert.match(high ?? '', /observe/)
  const medium = riskAdvice({ botLoopRisk: 'medium', semanticDuplicate: false, alreadyAnswered: true, newInformation: true })
  assert.match(medium ?? '', /别处没有/)
})

test('风险建议：不替模型选动作（不说"必须沉默"）', () => {
  const text = riskAdvice({ botLoopRisk: 'high', semanticDuplicate: true, alreadyAnswered: true, newInformation: false }) ?? ''
  assert.equal(/必须silent|禁止发言|不要说话/.test(text), false)
})

// ── §3：身份段渲染 ────────────────────────────────────────────────────

test('身份段：只有一名未登记成员时整段不出现（那是复述背景）', () => {
  assert.equal(renderParticipants([participant({ senderKind: 'unknown', source: 'unknown' })]), '')
  assert.equal(renderParticipants([]), '')
})

test('身份段：未登记成员被显式点名，并写清"不许从措辞推断"', () => {
  const text = renderParticipants([
    participant({ userId: BOT_A, displayName: '小助手', senderKind: 'known_bot', botProfileId: 'helper' }),
    participant({ userId: STRANGER, displayName: '路人', senderKind: 'unknown', source: 'unknown' }),
  ])
  assert.match(text, /已确认的机器人/)
  assert.match(text, /未登记/)
  assert.match(text, /不许.*推断/, '必须写死"不能凭措辞推断身份"（§2.1）')
  assert.match(text, /helper/, 'botProfileId 要显示')
})

test('身份段：她自己标成"你自己"，人类标成"已确认的人"', () => {
  const text = renderParticipants([
    participant({ userId: SELF, displayName: '三月', senderKind: 'self', source: 'trusted_platform' }),
    participant({ userId: HUMAN, displayName: '小王' }),
  ])
  assert.match(text, /你自己/)
  assert.match(text, /已确认的人/)
  assert.equal(/机器人/.test(text), false, '没有 bot 时不该出现"机器人"')
})

test('身份段：同一人重复出现只渲染一次，且有字数上限', () => {
  const duplicated = renderParticipants([participant({ userId: HUMAN }), participant({ userId: HUMAN })])
  assert.equal((duplicated.match(/小王/g) ?? []).length, 1, '重复的人只出现一次')
  // 人多时截断（每名成员最多一行，末尾仍要收在字数上限内）。
  const many = Array.from({ length: 20 }, (_, index) =>
    participant({ userId: 20_000 + index, displayName: '成员' + String(index) }))
  assert.ok([...renderParticipants(many)].length <= ECOLOGY_MAX_CHARS, '有字数上限')
})

test('身份段：不出现"别理机器人"这类行为指令（只摆事实）', () => {
  const text = renderParticipants([
    participant({ userId: BOT_A, displayName: '小助手', senderKind: 'known_bot' }),
    participant({ userId: HUMAN }),
  ])
  assert.equal(/别理|不用回|忽略/.test(text), false)
})

// ── §4.1：风险段渲染 ──────────────────────────────────────────────────

test('风险段：低风险整段不出现；未算过也不出现', () => {
  assert.equal(renderRisk({ botLoopRisk: 'low', semanticDuplicate: false, alreadyAnswered: false, newInformation: true }), '')
  assert.equal(renderRisk(undefined), '')
})

test('风险段：高风险带建议与事实两行，且有字数上限', () => {
  const text = renderRisk({
    botLoopRisk: 'high',
    reason: '两个人说了几乎同一句',
    semanticDuplicate: true,
    alreadyAnswered: true,
    newInformation: false,
  })
  assert.match(text, /互动风险/)
  assert.match(text, /已经有人给过实质回答/)
  assert.match(text, /两个人说几乎同一句/)
  assert.ok([...text].length <= ECOLOGY_MAX_CHARS)
})
