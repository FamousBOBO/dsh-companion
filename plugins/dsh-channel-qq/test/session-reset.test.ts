/** 会话换血阈值：纯函数边界。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OverflowStreak, isResetCommand, looksLikeOverflow, sessionExpired, shouldResetSession } from '../src/core/session-reset.js'

test('窗口未知 / 非有限值：不换血', () => {
  assert.equal(shouldResetSession(1_000_000, null, 0.7), false)
  assert.equal(shouldResetSession(Number.NaN, 128_000, 0.7), false)
  assert.equal(shouldResetSession(100, 0, 0.7), false)
  assert.equal(shouldResetSession(-1, 128_000, 0.7), false)
})

test('按比例触发；比例被夹在 0.1–0.95', () => {
  assert.equal(shouldResetSession(89_599, 128_000, 0.7), false)
  assert.equal(shouldResetSession(89_600, 128_000, 0.7), true)
  // 比例过低被夹到 0.1：128000*0.1=12800
  assert.equal(shouldResetSession(12_799, 128_000, 0), false)
  assert.equal(shouldResetSession(12_800, 128_000, 0), true)
  // 比例过高被夹到 0.95
  assert.equal(shouldResetSession(121_599, 128_000, 2), false)
  assert.equal(shouldResetSession(121_600, 128_000, 2), true)
})

test('1M 窗口：27.8 万 token 不触发（留出压缩余量）', () => {
  assert.equal(shouldResetSession(278_000, 1_048_576, 0.7), false)
  assert.equal(shouldResetSession(734_004, 1_048_576, 0.7), true)
})

test('连续 400：窗口内两次才算，冷却期内不再触发', () => {
  const streak = new OverflowStreak(2, 10 * 60_000, 30 * 60_000)
  const t0 = 1_000_000
  assert.equal(streak.hit('dm-1', t0), false)
  assert.equal(streak.hit('dm-1', t0 + 1_000), true)
  // 冷却期内：即使再连续两次也不触发
  assert.equal(streak.hit('dm-1', t0 + 2_000), false)
  assert.equal(streak.hit('dm-1', t0 + 3_000), false)
  // 冷却期过后重新计数
  assert.equal(streak.hit('dm-1', t0 + 31 * 60_000), false)
  assert.equal(streak.hit('dm-1', t0 + 31 * 60_000 + 1_000), true)
})

test('连续 400：超过窗口的旧计数不算连续', () => {
  const streak = new OverflowStreak(2, 60_000, 0)
  assert.equal(streak.hit('dm-2', 0), false)
  assert.equal(streak.hit('dm-2', 120_000), false) // 间隔 > 窗口，重新从 1 开始
  assert.equal(streak.hit('dm-2', 150_000), true)
})

test('错误文本识别：网关包装的 400 与标准上下文错误', () => {
  assert.equal(looksLikeOverflow('LlmError: 400: {"code":"bad_response_status_code"}'), true)
  assert.equal(looksLikeOverflow('context_length_exceeded'), true)
  assert.equal(looksLikeOverflow('CONTEXT_WINDOW_EXCEEDED'), true)
  assert.equal(looksLikeOverflow('LlmError: 503: model_not_found'), false)
  assert.equal(looksLikeOverflow('Connection error.'), false)
})

test('管理员换血指令的识别：只认固定写法', () => {
  assert.equal(isResetCommand('/换血'), true)
  assert.equal(isResetCommand('换血'), true)
  assert.equal(isResetCommand('/重置会话'), true)
  assert.equal(isResetCommand('/reset'), true)
  assert.equal(isResetCommand('  /Reset  '), true)
  assert.equal(isResetCommand('换血一下'), false)
  assert.equal(isResetCommand('请换血'), false)
  assert.equal(isResetCommand('/换血 顺便'), false)
})

test('定期换血：按天数判断，0 关闭，未知时间不触发', () => {
  const day = 24 * 60 * 60_000
  const now = 1000 * day
  assert.equal(sessionExpired(null, now, 7), false)
  assert.equal(sessionExpired(0, now, 7), true) // 0 是"很久以前"
  assert.equal(sessionExpired(now - 6 * day, now, 7), false)
  assert.equal(sessionExpired(now - 7 * day, now, 7), true)
  assert.equal(sessionExpired(now - 100 * day, now, 0), false)
})
