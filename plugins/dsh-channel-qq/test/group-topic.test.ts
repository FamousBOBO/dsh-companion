/** 话题识别（P3 §7.1 的 `topic_change` 来源）与统一时间线的单测。
 *
 * 话题识别是**最容易错**的一处：错了会让她对着一件没发生的事接话，而且没人当场发现。
 * 所以这里的用例集中在"不该识别"的一侧——识别不出是正常结果，识别错是事故。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { refineTopic, type TopicInput } from '../src/core/group-topic.js'
import { GroupTimeline, inboundEventOf } from '../src/core/group-events.js'

const T0 = new Date(2026, 10, 8, 21, 0, 0).getTime()
const GROUP = 145326153

function said(text: string, offsetSec = 0, self = false): TopicInput {
  return { text, atMs: T0 + offsetSec * 1000, self }
}

// ── 话题识别 ────────────────────────────────────────────────────────────────

test('显式挑明的话题会被取出来（说起来 / 顺便问 / 关于 / 你们觉得…吗）', () => {
  assert.equal(refineTopic([said('说起来，拍月亮要用三脚架吗')])?.topic, '拍月亮要用三脚架吗')
  // 指示代词会被剥掉：留着"那个"指不到东西，整条拒掉又会漏掉一大半真话题。
  assert.equal(refineTopic([said('顺便问一下，那个赤道仪好用吗')])?.topic, '赤道仪好用吗')
  assert.equal(refineTopic([said('关于周末的安排，大家有想法吗')])?.topic, '周末的安排')
  assert.equal(refineTopic([said('你们觉得长焦镜头值不值吗')])?.topic, '长焦镜头值不值')
})

test('没有显式句式、也没有重复词 → 不猜（返回 null，而不是拿最后一句冒充话题）', () => {
  assert.equal(refineTopic([said('在吗')]), null)
  assert.equal(refineTopic([said('嗯')]), null)
  assert.equal(refineTopic([said('好的我看看')]), null)
  assert.equal(refineTopic([]), null)
})

test('连续同题：多条消息里重复出现的词才当话题', () => {
  const guess = refineTopic([
    said('今天月亮好亮'),
    said('月亮确实亮'),
    said('月亮拍不清'),
  ])
  assert.ok(guess !== null)
  assert.match(guess.topic, /月亮/)
})

test('只重复两次的两字词置信度不够 → 不记（可能是巧合）', () => {
  assert.equal(refineTopic([said('好的'), said('好的')]), null)
})

test('她自己的发言不参与话题识别（她说什么不该定义群里在聊什么）', () => {
  assert.equal(refineTopic([said('说起来，我觉得月亮很美', 0, true)]), null)
})

test('只有提问词/虚词起头的内容不会被当成话题（"说起来，什么来着"）', () => {
  // "一下 / 那个"这类指示代词会被**剥掉**（剥完还有内容就是话题），
  // 但"什么 / 怎么 / 为什么"起头说明这句话本身没有指称对象，整条不要。
  assert.equal(refineTopic([said('说起来，什么来着')]), null)
  assert.equal(refineTopic([said('关于，为什么啊')]), null)
  // 对照：剥掉指示代词之后剩下的实义短语仍然被接受。
  assert.equal(refineTopic([said('说起来，这个赤道仪多少钱')])?.topic, '赤道仪多少钱')
})

test('话题长度被夹到 24 字（提示词里只放得下一句短语）', () => {
  const guess = refineTopic([said(`说起来，${'很长的描述'.repeat(10)}`)])
  assert.ok(guess !== null)
  assert.ok([...guess.topic].length <= 24, `长度 ${String([...(guess.topic)].length)}`)
})

// ── 时间线：话题事件 ────────────────────────────────────────────────────────

test('topic_change 事件能被 recentTopic 取到；没有话题事件就是 null（不拿最后一条消息冒充）', () => {
  const timeline = new GroupTimeline({ maxEvents: 50, ttlMs: 600_000 })
  timeline.append(inboundEventOf({ groupId: GROUP, messageId: 1, senderId: 10_001, content: '月亮好亮', timestamp: T0 }), T0)
  assert.equal(timeline.recentTopic(T0), null)
  timeline.append({
    groupId: GROUP,
    eventId: `topic:${String(GROUP)}:${String(T0 + 1)}:月亮`,
    senderId: 0,
    kind: 'topic_change',
    content: '月亮',
    topicId: '月亮',
    timestamp: T0 + 1,
    source: 'presence',
    self: false,
  }, T0 + 1)
  assert.equal(timeline.recentTopic(T0 + 1), '月亮')
})

test('同一话题不重复记（每来一条消息都记一次会把时间线淹掉）', () => {
  const timeline = new GroupTimeline({ maxEvents: 50, ttlMs: 600_000 })
  const topicEvent = {
    groupId: GROUP,
    eventId: 'topic:x',
    senderId: 0,
    kind: 'topic_change' as const,
    content: '月亮',
    topicId: '月亮',
    timestamp: T0,
    source: 'presence' as const,
    self: false,
  }
  assert.equal(timeline.append(topicEvent, T0), 'added')
  assert.equal(timeline.append({ ...topicEvent, timestamp: T0 + 5 }, T0 + 5), 'duplicate')
  assert.equal(timeline.live(T0 + 5).filter((event) => event.kind === 'topic_change').length, 1)
})

test('话题事件不参与 recentSelf（她没说过这句话）', () => {
  const timeline = new GroupTimeline({ maxEvents: 50, ttlMs: 600_000 })
  timeline.append({
    groupId: GROUP,
    eventId: 'topic:y',
    senderId: 0,
    kind: 'topic_change',
    content: '月亮',
    topicId: '月亮',
    timestamp: T0,
    source: 'presence',
    self: false,
  }, T0)
  assert.deepEqual(timeline.recentSelf(T0), [])
})
