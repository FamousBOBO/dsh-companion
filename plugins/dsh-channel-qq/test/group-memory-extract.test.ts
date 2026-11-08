/** 候选记忆提取（P1 §5.3）的单测。
 *
 * 这一层的判据是"宁可少记，也不要记错"：写错的成员画像会被下一轮召回当成事实说出来，
 * 而用户没有任何纠正的机会。所以用例里**反例比正例多**。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { extractCandidateFacts, type ExtractInput } from '../src/core/group-memory-extract.js'

function said(text: string, over: Partial<ExtractInput> = {}): ExtractInput {
  return { messageId: 501, userId: 10_001, text, self: false, ...over }
}

test('第一人称主动陈述的偏好/属性会被记成 explicit 成员事实', () => {
  const facts = extractCandidateFacts([said('我特别喜欢拍月亮')])
  assert.equal(facts.length, 1)
  assert.equal(facts[0]?.scope, 'member')
  assert.equal(facts[0]?.memberId, 10_001)
  assert.equal(facts[0]?.kind, 'explicit')
  assert.deepEqual(facts[0]?.sourceMessageIds, [501])
  assert.match(facts[0]?.content ?? '', /拍月亮/)
})

test('提问、假设、否定式不被当成事实（"你会做饭吗" ≠ "他会做饭"）', () => {
  for (const text of ['你会做饭吗', '我是不是该换个镜头', '要是我喜欢爬山呢', '我有没有说过我喜欢猫']) {
    assert.deepEqual(extractCandidateFacts([said(text)]), [], text)
  }
})

test('计划与当下判断不收（它们会过期，而成员事实没有 TTL）', () => {
  for (const text of ['我明天要去爬山', '我觉得这个镜头一般', '我猜他说的不是这个']) {
    assert.deepEqual(extractCandidateFacts([said(text)]), [], text)
  }
})

test('她自己的发言不参与提取（她说什么不该变成群友的画像）', () => {
  assert.deepEqual(extractCandidateFacts([said('我特别喜欢拍月亮', { self: true })]), [])
})

test('没有真实消息号的合成事件不能当来源（存储侧同样拒写）', () => {
  assert.deepEqual(extractCandidateFacts([said('我特别喜欢拍月亮', { messageId: null })]), [])
  assert.deepEqual(extractCandidateFacts([said('我特别喜欢拍月亮', { messageId: 0 })]), [])
})

test('没有有效 QQ 号的来源也不收（认不出是谁说的，就记不到谁头上）', () => {
  assert.deepEqual(extractCandidateFacts([said('我特别喜欢拍月亮', { userId: 0 })]), [])
})

test('带链接 / @ / CQ 码 / 长数字串的内容不收（这些不该进记忆）', () => {
  for (const text of [
    '我喜欢这个 https://example.com',
    '我特别喜欢 @小王 说的',
    '我住在 [CQ:at,qq=123456] 那边',
    '我的手机号是 13800001111',
  ]) {
    assert.deepEqual(extractCandidateFacts([said(text)]), [], text)
  }
})

test('一句话里有多条事实时按句切开，各自带同一个来源消息号', () => {
  const facts = extractCandidateFacts([said('我特别喜欢拍月亮。我养了只橘猫。')])
  assert.equal(facts.length, 2)
  assert.deepEqual(facts.map((fact) => fact.sourceMessageIds), [[501], [501]])
})

test('同一批里重复的句子只记一次（去空白与标点后比较）', () => {
  const facts = extractCandidateFacts([
    said('我特别喜欢拍月亮'),
    said('我特别喜欢拍月亮！', { messageId: 502 }),
  ])
  assert.equal(facts.length, 1)
})

test('过长的"陈述"不当事实（那是讲话，不是给这个人的画像）', () => {
  const long = `我特别喜欢${'很长的理由'.repeat(30)}`
  assert.deepEqual(extractCandidateFacts([said(long)]), [])
})

test('正文优先用 body（剥掉发送者抬头之后的那一段）', () => {
  const facts = extractCandidateFacts([
    { messageId: 501, userId: 10_001, text: '小王(10001) 22:00：我特别喜欢拍月亮', body: '我特别喜欢拍月亮', self: false },
  ])
  assert.equal(facts.length, 1)
})
