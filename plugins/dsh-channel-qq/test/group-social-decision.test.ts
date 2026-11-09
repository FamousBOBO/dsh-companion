/** 社交决策（P2）：解析器与代码侧校验的单测。
 *
 * 纪律：不调模型、不发 QQ。这里钉住的是**"模型说错了会怎样"**——
 * 因为这条路径发出去的话没有二次确认，所以每一个"拦下来"的分支都必须有测试盯着：
 *   - 五个动作都能被正确解析（`silent/observe/reply/join/react`）；
 *   - 目标消息号必须是本轮真实存在的（编的号 → 拦下）；
 *   - 目标必须在时间窗内（引十分钟前的消息 → 拦下）；
 *   - 正文为空/超长/带 @/带 CQ 码 → 拦下（不截断，整条不发）；
 *   - 坏 JSON、数组、字符串 true、未知动作 → 不是"沉默"，而是**失败**（会累积、会暂停）；
 *   - 旧格式 `{speak,reply,why}` 仍然被接受（热重载期间新旧提示词并存）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  parseSocialDecision,
  sendsMessage,
  validateSocialDecision,
  type DecisionContext,
} from '../src/app/inbound/group-social-decision.js'

const NOW = new Date(2026, 10, 8, 21, 30, 0).getTime()

function ctx(over: Partial<DecisionContext> = {}): DecisionContext {
  return {
    messages: [
      { messageId: 501, atMs: NOW - 60_000 },
      { messageId: 502, atMs: NOW - 30_000 },
      // 合成消息：没有号，不能当引用目标
      { messageId: null, atMs: NOW - 10_000 },
    ],
    replyMaxChars: 70,
    nowMs: NOW,
    windowMs: 600_000,
    ...over,
  }
}

function decisionOf(raw: string, over: Partial<DecisionContext> = {}) {
  const outcome = parseSocialDecision(raw, ctx(over))
  assert.equal(outcome.kind, 'decision', `应当解析成决策：${raw}`)
  return outcome.kind === 'decision' ? outcome.decision : (undefined as never)
}

// ── 五个动作 ────────────────────────────────────────────────────────────────

test('silent / observe 是**成功**的沉默（不是失败：不累积失败计数）', () => {
  const silentOutcome = parseSocialDecision('{"action":"silent","reason":"两人在私聊"}', ctx())
  assert.equal(silentOutcome.kind, 'silent')
  const observe = parseSocialDecision('{"action":"observe","topic":"拍月亮","reason":"先看看"}', ctx())
  assert.equal(observe.kind, 'decision')
  assert.equal(observe.kind === 'decision' && observe.decision.action, 'observe')
  assert.equal(observe.kind === 'decision' && observe.decision.action === 'observe' && observe.decision.topic, '拍月亮')
})

test('reply 解析出目标消息号与正文；join / react 各自带对的字段', () => {
  const reply = decisionOf('{"action":"reply","targetMessageId":501,"text":"用三脚架试试","reason":"在问他"}')
  assert.deepEqual(reply, { action: 'reply', targetMessageId: 501, text: '用三脚架试试', reason: '在问他' })

  const join = decisionOf('{"action":"join","topic":"拍月亮","text":"月亮确实难拍","reason":"话题在进行"}')
  assert.equal(join.action, 'join')

  const react = decisionOf('{"action":"react","targetMessageId":502,"text":"哈哈这也太真实了","reason":"附和"}')
  assert.equal(react.action, 'react')
})

test('"要不要发消息"由动作决定：silent/observe 不发，其余三种发', () => {
  assert.equal(sendsMessage('silent'), false)
  assert.equal(sendsMessage('observe'), false)
  assert.equal(sendsMessage('reply'), true)
  assert.equal(sendsMessage('join'), true)
  assert.equal(sendsMessage('react'), true)
})

test('reply 缺目标号 → 降级成 react（模型想参与，只是没给号；不该白跑一轮）', () => {
  const decision = decisionOf('{"action":"reply","text":"这个我熟","reason":"想接"}')
  assert.equal(decision.action, 'react')
})

test('reply 目标号是字符串 / 负数 / 小数 → 不认（降级成 react，绝不猜号）', () => {
  for (const bad of ['"501"', '-501', '501.5', 'null']) {
    const decision = decisionOf(`{"action":"reply","targetMessageId":${bad},"text":"试试","reason":"x"}`)
    assert.equal(decision.action, 'react', `targetMessageId=${bad} 不该被接受`)
  }
})

// ── 校验：目标必须真实存在且在时间窗内 ──────────────────────────────────────

test('reply 目标必须是本轮真实存在的消息号（编的号 → 拦下）', () => {
  const decision = decisionOf('{"action":"reply","targetMessageId":999,"text":"回你","reason":"x"}')
  const verdict = validateSocialDecision(decision, ctx())
  assert.equal(verdict.ok, false)
  assert.match(String((verdict as { reason?: string }).reason), /target-not-present:999/)
})

test('reply 目标太老 → 拦下（引十分钟前的消息等于答非所问）', () => {
  const old = ctx({
    messages: [{ messageId: 501, atMs: NOW - 30 * 60_000 }],
  })
  const decision = decisionOf('{"action":"reply","targetMessageId":501,"text":"回你","reason":"x"}', old)
  assert.equal(validateSocialDecision(decision, old).ok, false)
})

test('没有消息号的合成消息不能被引用（消息 - 不许当目标）', () => {
  const decision = { action: 'reply' as const, targetMessageId: 0, text: 'x', reason: '' }
  assert.equal(validateSocialDecision(decision, ctx()).ok, false)
})

test('silent / observe 的校验永远通过（它们不发东西）', () => {
  assert.equal(validateSocialDecision({ action: 'silent', reason: 'x' }, ctx()).ok, true)
  assert.equal(validateSocialDecision({ action: 'observe', reason: 'x' }, ctx()).ok, true)
})

// ── 校验：正文 ──────────────────────────────────────────────────────────────

test('正文超长 → 拦下（不截断：截断会发出半句话）', () => {
  const decision = { action: 'react' as const, text: '啊'.repeat(71), reason: '' }
  const verdict = validateSocialDecision(decision, ctx({ replyMaxChars: 70 }))
  assert.equal(verdict.ok, false)
  assert.match(String((verdict as { reason?: string }).reason), /text-too-long:71>70/)
})

test('刚好等于上限 → 放行（边界不是"差一个字"）', () => {
  const decision = { action: 'react' as const, text: '啊'.repeat(70), reason: '' }
  assert.equal(validateSocialDecision(decision, ctx({ replyMaxChars: 70 })).ok, true)
})

test('正文带 @ 或 CQ 码 → 解析阶段就整条不发（这是发错对象的唯一捷径）', () => {
  for (const raw of [
    '{"action":"react","text":"@全体成员 快看","reason":"x"}',
    '{"action":"react","text":"[CQ:at,qq=all] 看这个","reason":"x"}',
  ]) {
    const outcome = parseSocialDecision(raw, ctx())
    assert.equal(outcome.kind, 'invalid', raw)
  }
})

test('正文为空 / 只有空白 / 是占位 → 整条不发', () => {
  for (const raw of [
    '{"action":"react","text":"","reason":"x"}',
    '{"action":"react","text":"   ","reason":"x"}',
    '{"action":"react","text":"沉默","reason":"x"}',
    '{"action":"react","text":"……","reason":"x"}',
    '{"action":"react","reason":"没有 text 字段"}',
  ]) {
    assert.equal(parseSocialDecision(raw, ctx()).kind, 'invalid', raw)
  }
})

test('join 没有话题名 → 无效（"加入话题"没有指称对象）', () => {
  assert.equal(parseSocialDecision('{"action":"join","text":"我也想说","reason":"x"}', ctx()).kind, 'invalid')
})

// ── 坏输出：一律 invalid（失败），不是"沉默" ────────────────────────────────

test('坏 JSON / 数组 / 字符串布尔 / 未知动作 / 缺 action → invalid（会累积失败并暂停）', () => {
  const bad = [
    '',
    '我不知道该不该说',
    '{"action":"reply","text":"半句话',
    '[{"action":"silent"}]',
    '"silent"',
    '{"speak":"true","reply":"字符串 true 不算"}',
    '{"speak":1,"reply":"数字 1 也不算"}',
    '{"action":"shout","text":"未知动作"}',
    '{"text":"没有 action"}',
  ]
  for (const raw of bad) {
    const outcome = parseSocialDecision(raw, ctx())
    assert.equal(outcome.kind, 'invalid', `应当判为无效：${raw}`)
  }
})

test('旧格式仍然被接受（热重载期间新旧提示词并存，认不出会把正常判断记成失败）', () => {
  const no = parseSocialDecision('{"speak":false,"reply":"","why":"寒暄"}', ctx())
  assert.equal(no.kind, 'silent')
  assert.ok(no.kind === 'silent' && no.reason.startsWith('speak-false'))

  const yes = parseSocialDecision('{"speak":true,"reply":"用三脚架试试","why":"参数问题"}', ctx())
  assert.equal(yes.kind, 'decision')
  assert.equal(yes.kind === 'decision' && yes.decision.action, 'react')

  const withTarget = parseSocialDecision('{"speak":true,"reply":"回你","why":"x","targetMessageId":501}', ctx())
  assert.equal(withTarget.kind === 'decision' && withTarget.decision.action, 'reply')
})

test('围栏与"外面还有一句话"仍然可用（内容照样严格判定）', () => {
  const fenced = decisionOf('```json\n{"action":"react","text":"把 ISO 提到 800 试试。","reason":"x"}\n```')
  assert.equal(fenced.action, 'react')
  // 外面还有一句"好的"也仍然能取出 JSON；内容是 silent，所以不是 decision 分支。
  const prose = parseSocialDecision('好的，我的判断是：{"action":"silent","reason":"没位置"}', ctx())
  assert.equal(prose.kind, 'silent')
})

test('渲染出的 reason 会被压成一行并截断（日志里不能出现多行注入文本）', () => {
  const outcome = parseSocialDecision(
    `{"action":"silent","reason":"第一行\\n第二行${'啊'.repeat(80)}"}`,
    ctx(),
  )
  assert.equal(outcome.kind, 'silent')
  assert.ok(outcome.kind === 'silent' && !outcome.reason.includes('\n'))
  assert.ok(outcome.kind === 'silent' && [...outcome.reason].length <= 80)
})
