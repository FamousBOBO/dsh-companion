/** P9-G §1 的第二处修复：说完之后读话题要**带群号**。
 *
 * 计划指出：`afterSpeak` 拿话题走的是旧的 `timelines.view().topic()`（"唯一活跃群"降级），
 * 两个群同时有消息时它返回 `null`——于是"说完之后贴表情 / 落地话题"那一层拿不到话题。
 * 这里用**真实的时间线实现**（含真实的话题识别）复现那个形状，钉住三条：
 *
 *   1. 单群时能读到话题（修复前后都对，防止把好路径改坏）；
 *   2. **有两个活跃群时仍然能读到本群的话题**（修复前必红：旧路径返回 null）；
 *   3. 没有记录过的群 / 非法群号返回 null（fail-closed，不串群）。
 *
 * 话题靠 `core/group-topic.ts` 的轻量识别产生，所以语料写成它认得出的显式句式
 * （「说起来…」「关于…」），而不是随手一句——认不出话题时该返回 null，那是设计如此。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { AmbientEntry } from '../src/core/ambient.js'
import { GroupTimelineBook } from '../src/app/inbound/presence-timeline.js'
import { FakeClock } from './fakes/contact.js'

const GROUP_A = 145_326_153
const GROUP_B = 900_000_001
const START = new Date(2026, 10, 8, 22, 0, 0).getTime()
let seq = 0

function inbound(messageId: number, text: string, atMs: number): AmbientEntry {
  seq += 1
  return { seq, messageId, userId: 10_001, name: '小王', text, atMs, self: false }
}

function book(): GroupTimelineBook {
  return new GroupTimelineBook(new FakeClock(START))
}

test('单群：说完之后能读到这个群的话题', () => {
  const timelines = book()
  timelines.markInbound(GROUP_A, inbound(1, '说起来拍月亮老是糊，是不是快门的问题', START - 60_000))
  timelines.recordSelf(GROUP_A, {
    kind: 'proactive_message',
    messageId: 1001,
    text: '快门提到 1/250 会稳很多，可以试试',
    atMs: START,
  })

  const topic = timelines.scopedView().topic(GROUP_A)
  assert.equal(typeof topic, 'string', '她刚说完一句，话题不该是空的')
  assert.ok((topic ?? '').length > 0)
})

test('两个群同时活跃：本群话题仍然读得到（旧 view() 在这里返回 null）', () => {
  const timelines = book()
  timelines.markInbound(GROUP_A, inbound(1, '说起来拍月亮老是糊，是不是快门的问题', START - 60_000))
  timelines.markInbound(GROUP_B, inbound(2, '关于红烧肉，我总觉得糖色炒不出来', START - 60_000))
  timelines.recordSelf(GROUP_A, {
    kind: 'proactive_message',
    messageId: 1001,
    text: '快门提到 1/250 会稳很多',
    atMs: START,
  })
  timelines.recordSelf(GROUP_B, {
    kind: 'proactive_message',
    messageId: 2001,
    text: '先煸出油再下糖，颜色就出来了',
    atMs: START,
  })

  // 修复前的写法：两个群都活跃 → 拿不到"唯一活跃群" → null（这就是计划指出的 bug）。
  assert.equal(timelines.view().topic(), null, '旧降级路径在两个群时确实读不到')

  const view = timelines.scopedView()
  const topicA = view.topic(GROUP_A)
  const topicB = view.topic(GROUP_B)
  assert.equal(typeof topicA, 'string', '带群号就该读到 A 群的话题')
  assert.equal(typeof topicB, 'string', '带群号就该读到 B 群的话题')
  assert.notEqual(topicA, topicB, '两个群的话题不能是同一句话')
})

test('没有记录过的群 / 非法群号：话题是 null，不猜、不串群', () => {
  const timelines = book()
  timelines.markInbound(GROUP_A, inbound(1, '说起来拍月亮老是糊，是不是快门的问题', START - 60_000))

  const view = timelines.scopedView()
  assert.equal(view.topic(GROUP_B), null, '没有记录过的群不许借用别的群的话题')
  assert.equal(view.topic(0), null, '非法群号 fail-closed')
  assert.equal(view.topic(Number.NaN), null, '非法群号 fail-closed')
})
