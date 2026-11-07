/** 语音条的收尾规则（`clipLengthFor`）：纯函数，逐条钉住"长度是怎么算出来的"。
 *
 * 为什么这些用例值得单独一个文件：收尾决定的输入是"副歌起点 + 一串句尾 + 一对上下限"，
 * 输出是一个数。它不需要队列、不需要端口、不需要临时目录——而它错了的后果是
 * **一条被掐断或短到听不出来的语音条**，那是最难在事后发现的那类问题。
 *
 * 七类情况各一条（对应验收清单）：
 *   句尾在范围内取最后一个 / 没有句尾退回上限 / 太靠后被排除 /
 *   低于下限被排除 / 空数组 / 时间戳乱序 / 毫秒级抖动不漂。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { clipLengthFor, MIN_PHRASE_CLIP_SECONDS } = await import('../src/features/song/phrase.js')

const MAX = 59
const MIN = MIN_PHRASE_CLIP_SECONDS

test('句尾在范围内：取**最后一个**（最靠后 = 上限之内尽量多听一句）', () => {
  assert.equal(clipLengthFor(60, [78.5, 96, 107.5, 118.5], MAX, MIN), 58.5)
})

test('没有句尾（空数组）：退回上限，交给日志说明是硬切', () => {
  assert.equal(clipLengthFor(60, [], MAX, MIN), MAX)
})

test('句尾太靠后（长度 > 上限）被排除，取剩下最靠后的那个', () => {
  // 60 → 119 是 59（正好等于上限，收），125 是 65（排除）。
  assert.equal(clipLengthFor(60, [95, 119, 125], MAX, MIN), 59)
  // 全都超过上限：退回上限本身，而不是给一个"最接近上限"的近似值。
  assert.equal(clipLengthFor(60, [130, 140], MAX, MIN), 59)
})

test('句尾低于下限（半句副歌）被排除：宁可硬切，也不要一条听不出来的短语音', () => {
  assert.equal(clipLengthFor(60, [68, 74, 101], MAX, MIN), 41)
  // 只有太短的句尾：退回上限。
  assert.equal(clipLengthFor(60, [68, 74], MAX, MIN), 59)
  // 正好等于下限的收（19.999 不收）。
  assert.equal(clipLengthFor(60, [80], MAX, MIN), 20)
  assert.equal(clipLengthFor(60, [79.999], MAX, MIN), 59)
})

test('时间戳乱序：结论与顺序无关（同一份输入永远同一个长度）', () => {
  const ordered = [82.5, 96.5, 111.5]
  const shuffled = [111.5, 82.5, 96.5]
  assert.equal(clipLengthFor(70, shuffled, MAX, MIN), clipLengthFor(70, ordered, MAX, MIN))
  assert.equal(clipLengthFor(70, shuffled, MAX, MIN), 41.5)
})

test('上下限本身不合法时不崩：下限高过上限就当作没有可用句尾', () => {
  // 操作员把上限调到 10 s、下限仍是 20 s：一句也不收，直接按上限。
  assert.equal(clipLengthFor(60, [75], 10, MIN), 10)
  // 起点不是有限数（调用方本该拦，这里只保证不把 NaN 喂给 ffmpeg）。
  assert.equal(clipLengthFor(Number.NaN, [75], MAX, MIN), MAX)
})

test('毫秒级抖动不泄漏：返回三位小数（ffmpeg 参数与日志可复现）', () => {
  assert.equal(clipLengthFor(12.3456, [59.8457], MAX, MIN), 47.5)
  assert.equal(clipLengthFor(0.1, [47.6], MAX, MIN), 47.5)
})
