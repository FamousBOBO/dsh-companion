/** 表情包使用策略（P4 §8.2）与弱反馈（§8.3）的单测。
 *
 * 这两块都是"发出去就收不回来"的路径，所以用例的重点在**不该发**的一侧：
 * 表情包错配语境比不说话更伤，而"没人接就多说点"的回路一旦成立就是刷屏。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { checkSticker, stickerQueryOf } from '../src/core/group-expression.js'
import { FEEDBACK_WINDOW_MS, GroupFeedbackBook, overlaps } from '../src/core/group-feedback.js'

const NOW = new Date(2026, 10, 8, 21, 30, 0).getTime()

function sticker(over: Partial<Parameters<typeof checkSticker>[0]> = {}): Parameters<typeof checkSticker>[0] {
  return {
    action: 'react',
    text: '哈哈这也太真实了',
    hasTopic: true,
    nowMs: NOW,
    lastStickerAtMs: 0,
    sentThisHour: 0,
    minIntervalMs: 600_000,
    maxPerHour: 1,
    ...over,
  }
}

// ── 表情包：不该发的情形 ────────────────────────────────────────────────────

test('reply 不配图（在回答一个具体问题，配图常常答非所问）', () => {
  const verdict = checkSticker(sticker({ action: 'reply' }))
  assert.equal(verdict.ok, false)
  assert.equal((verdict as { reason: string }).reason, 'action-reply')
})

test('需要把话说明白的句子不配图（问号 / 建议 / 注意 / 报错）', () => {
  for (const text of [
    '要不要现在试试？',
    '建议先检查一下供电',
    '注意别把 ISO 拉太高',
    '报错的话多半是驱动没装',
  ]) {
    const verdict = checkSticker(sticker({ text }))
    assert.equal(verdict.ok, false, text)
    assert.equal((verdict as { reason: string }).reason, 'needs-words', text)
  }
})

test('长句且不是轻量反应 → 不配图（她在解释事情，图会把意思弄糊）', () => {
  const long = '月亮糊通常是因为快门太慢加上手抖和风吹的关系所以我一般会等风停再按快门'
  const verdict = checkSticker(sticker({ text: long }))
  assert.equal(verdict.ok, false)
  assert.equal((verdict as { reason: string }).reason, 'too-long-for-sticker')
})

test('额度与冷却各管一件事：小时额度先于冷却判定', () => {
  const quota = checkSticker(sticker({ sentThisHour: 1, maxPerHour: 1, lastStickerAtMs: NOW - 1_000 }))
  assert.equal((quota as { reason: string }).reason, 'hour-quota')
  const cooldown = checkSticker(sticker({ sentThisHour: 0, lastStickerAtMs: NOW - 60_000 }))
  assert.equal((cooldown as { reason: string }).reason, 'cooldown')
})

test('没有话题、正文也不是轻量反应 → 不查图库（多半找不到贴题的图）', () => {
  const verdict = checkSticker(sticker({ hasTopic: false, text: '那个相机包我放在门口了' }))
  assert.equal(verdict.ok, false)
  assert.equal((verdict as { reason: string }).reason, 'no-query')
})

test('空正文不发（图不能替沉默）', () => {
  const verdict = checkSticker(sticker({ text: '   ' }))
  assert.equal(verdict.ok, false)
})

// ── 表情包：该发的情形 ──────────────────────────────────────────────────────

test('轻量反应 + 有额度 + 有话题 → 放行，并给出图库查询词', () => {
  const verdict = checkSticker(sticker())
  assert.equal(verdict.ok, true)
  assert.ok((verdict as { query: string }).query.length > 0)
})

test('没有话题时用正文当查询词（轻量反应也算有得查）', () => {
  const verdict = checkSticker(sticker({ hasTopic: false, text: '笑死' }))
  assert.equal(verdict.ok, true)
})

test('查询词按码点截到 32 字（图库只做关键词匹配）', () => {
  const query = stickerQueryOf({ action: 'react', text: '啊'.repeat(100), topic: null })
  assert.equal([...query].length, 32)
})

test('话题优先于正文（群里在聊"拍月亮"时，那个词比她那句话更好找图）', () => {
  assert.equal(stickerQueryOf({ action: 'react', text: '确实', topic: '拍月亮' }), '拍月亮')
})

// ── 弱反馈 ──────────────────────────────────────────────────────────────────

test('她说完之后有人接话 → 记一条 continued（带延迟），没人接 → 记一条未接', () => {
  const book = new GroupFeedbackBook()
  book.expect(145326153, '我也想看', NOW)
  const signal = book.settle(145326153, { text: '那就一起', userId: 10_001, atMs: NOW + 20_000 })
  assert.equal(signal?.continued, true)
  assert.equal(signal?.responders, 1)
  assert.equal(signal?.latencyMs, 20_000)

  book.expect(145326153, '有人吗', NOW)
  const quiet = book.settle(145326153, { text: '嗯', userId: 10_002, atMs: NOW + FEEDBACK_WINDOW_MS + 1 })
  assert.equal(quiet?.continued, false)
})

test('一次发言只结算一次（重复结算会让"接话率"变成人气数字）', () => {
  const book = new GroupFeedbackBook()
  book.expect(145326153, '我也想看', NOW)
  book.settle(145326153, { text: '一起', userId: 10_001, atMs: NOW + 1_000 })
  assert.equal(book.settle(145326153, { text: '走了', userId: 10_002, atMs: NOW + 2_000 }), null)
  assert.equal(book.summary(145326153).samples, 1)
})

test('没期待就不结算（群友之间正常聊天不该被记成"她发言的反馈"）', () => {
  const book = new GroupFeedbackBook()
  assert.equal(book.settle(145326153, { text: '在吗', userId: 10_001, atMs: NOW }), null)
})

test('卸载时把过了窗口的期待结算成"没人接"（不补发、不留悬挂状态）', () => {
  const book = new GroupFeedbackBook()
  book.expect(145326153, '我也想看', NOW)
  book.flush(NOW + FEEDBACK_WINDOW_MS + 1)
  assert.equal(book.summary(145326153).samples, 1)
  assert.equal(book.summary(145326153).continued, 0)
})

test('summary 只给事实数字，不给"满意度"（没接可能只是话题过去了）', () => {
  const book = new GroupFeedbackBook()
  book.expect(145326153, 'a', NOW)
  book.settle(145326153, { text: 'b', userId: 1, atMs: NOW + 1 })
  const summary = book.summary(145326153)
  assert.deepEqual(Object.keys(summary).sort(), ['continued', 'continuedRate', 'echoed', 'samples'])
})

test('overlaps 认出"整句搬过去"和"换个语气词"，但不同的话不算重复', () => {
  assert.equal(overlaps('今天又下雨了记得带伞', '今天下雨了 记得带伞呀'), true)
  assert.equal(overlaps('今天又下雨了', '我在看月亮'), false)
  assert.equal(overlaps('', '随便'), false)
})
