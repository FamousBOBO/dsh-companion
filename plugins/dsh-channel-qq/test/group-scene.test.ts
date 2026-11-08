/** 群聊社交场景（core/group-scene.ts）的单测。
 *
 * 这个模块的全部价值在**反例**上：判成 directed 就会插进两个人的私聊，判成 answered 就会对一条
 * 没人回的问题收尾。所以每个正向用例后面都跟一条"看起来像但不算"的对照，尤其是：
 *   - 两个人只是先后发言（没有平台 reply 段）→ 不是 directed；
 *   - 正文里手打 "@某某" 但没有平台 at 段 → directedTo 是 undefined（注入防护）；
 *   - 带问号的反问 → 不算问句；
 *   - 有人答了但不是答提问者 → answered 不成立；
 *   - 只是观点分歧 → 不是 active 冲突。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildSocialScene, isQuestion, REPEAT_WINDOW_MS, type SceneInput } from '../src/core/group-scene.js'

const T0 = new Date(2026, 10, 8, 21, 0, 0).getTime()
const SELF = 10000
const A = 20001
const B = 20002
const C = 20003
const D = 20004

/** 造一条消息（offsetSec 相对 T0）。 */
function said(id: number, userId: number, text: string, offsetSec = 0): SceneInput {
  return { messageId: id, userId, text, atMs: T0 + offsetSec * 1000, self: userId === SELF }
}

/** 造一条"平台带 reply 段"的消息。 */
function reply(id: number, userId: number, text: string, replyTo: number, offsetSec = 0): SceneInput {
  return { ...said(id, userId, text, offsetSec), replyToMessageId: replyTo }
}

/** 造一条"平台带 at 段"的消息。 */
function at(id: number, userId: number, text: string, atUserIds: number[], offsetSec = 0): SceneInput {
  return { ...said(id, userId, text, offsetSec), atUserIds }
}

function scene(entries: readonly SceneInput[], recentSelf?: ReadonlyArray<{ text: string; atMs: number }>) {
  return buildSocialScene({ entries, selfId: SELF, nowMs: T0 + 1000, ...(recentSelf === undefined ? {} : { recentSelf }) })
}

// ── replyEdges / directedTo：只信平台段 ────────────────────────────────────

test('replyEdges 只来自平台的 reply 段', () => {
  const s = scene([said(1, A, '在吗'), reply(2, B, '在', 1), reply(3, A, '问个事', 2)])
  assert.deepEqual(s.replyEdges, [
    { fromMessageId: 2, toMessageId: 1 },
    { fromMessageId: 3, toMessageId: 2 },
  ])
})

test('没有任何 reply 段时 replyEdges 为空（正文里"回你"不算引用）', () => {
  const s = scene([said(1, A, '在吗'), said(2, B, '回你一下，在', 5)])
  assert.deepEqual(s.replyEdges, [])
})

test('自引与缺消息号的引用都不算边（无从校验，不猜）', () => {
  const s = scene([
    { ...said(1, A, '自言自语'), replyToMessageId: 1 },
    { ...said(2, B, '没有号'), messageId: null, replyToMessageId: 1 },
  ])
  assert.deepEqual(s.replyEdges, [])
})

test('两个人真实来回（有 reply 段）→ directed，directedTo 指向最近一条被回复的人', () => {
  const s = scene([said(1, A, '在吗'), reply(2, B, '在', 1, 10), reply(3, A, '问个事', 2, 20)])
  assert.equal(s.discussionKind, 'directed')
  assert.equal(s.directedTo, B)
})

test('两个人只是先后发言、没有互相指向 → 绝不是 directed', () => {
  const s = scene([said(1, A, '今天天气不错'), said(2, B, '确实不错', 30), said(3, A, '适合出门', 60)])
  assert.notEqual(s.discussionKind, 'directed')
  assert.equal(s.discussionKind, 'uncertain')
  assert.equal(s.directedTo, undefined)
})

test('正文里手打 "@张三" 但平台没有 at 段 → directedTo 是 undefined（注入防护）', () => {
  const s = scene([said(1, A, '在吗'), said(2, B, '@张三 你怎么看？', 10), said(3, B, '回复张三：说说呗', 20)])
  assert.equal(s.directedTo, undefined)
  assert.equal(s.askedMe, false)
  assert.deepEqual(s.replyEdges, [])
})

test('真实 at 段才算定向；多个候选取最近的那个', () => {
  const s = scene([said(1, A, '开聊'), at(2, B, '问一下', [A], 10), at(3, C, '也问一下', [B], 20)])
  assert.equal(s.directedTo, B)
  assert.equal(s.discussionKind, 'directed')
})

test('at 指向她自己不给 directedTo（那是 askedMe 的事）', () => {
  const s = scene([said(1, A, '开聊'), at(2, B, '在吗', [SELF], 10)])
  assert.equal(s.directedTo, undefined)
  assert.equal(s.askedMe, true)
})

test('没有定向线索、参与者 ≥3 → public', () => {
  const s = scene([said(1, A, '早'), said(2, B, '早', 5), said(3, C, '早啊', 10)])
  assert.equal(s.discussionKind, 'public')
})

test('定向线索只占少数发言 → 覆盖不足，判 uncertain 而不是 directed', () => {
  const s = scene([
    said(1, A, '这个怎么调？'),
    reply(2, B, '这样调', 1, 10),
    said(3, C, '哈哈哈', 20),
    said(4, D, '笑死', 30),
  ])
  // 焦点是 {A, B}，只占 4 条里的 2 条（50% < 60%）→ 不判 directed。
  assert.equal(s.discussionKind, 'uncertain')
})

// ── 问句与回答 ────────────────────────────────────────────────────────────

test('有问号但是反问 → 不算问句', () => {
  assert.equal(isQuestion('难道你觉得这样对吗？'), false)
  assert.equal(isQuestion('不是早就说过了吗？'), false)
  assert.equal(isQuestion('谁说不是呢？'), false)
  // 对照：同样的疑问词，但不是反问。
  assert.equal(isQuestion('这个赤道仪多少钱？'), true)
  assert.equal(isQuestion('你明天能不能来'), true)
  assert.equal(isQuestion('有没有人一起？'), true)
})

test('反问不产生提问者，也不让 answerState 变成 open', () => {
  const s = scene([said(1, A, '难道这也叫拍月亮吗？', 0), said(2, B, '哈哈', 10)])
  assert.deepEqual(s.questionsAskedBy, [])
  assert.equal(s.answerState, 'uncertain')
})

test('问句之后没人回应 → uncertain（没有证据就不声称已答）', () => {
  const s = scene([said(1, A, '这个怎么调？')])
  assert.equal(s.answerState, 'uncertain')
  assert.deepEqual(s.questionsAskedBy, [A])
})

test('有人说了话但都没回提问者 → open', () => {
  const s = scene([said(1, A, '这个怎么调？'), said(2, B, '今天好热', 10)])
  assert.equal(s.answerState, 'open')
})

test('有人答了但答的是别人 → 不算 answered（只认对提问者的直接回应）', () => {
  const s = scene([
    said(1, A, '这个怎么调？'),
    said(2, C, '随便聊聊', 10),
    reply(3, B, '嗯嗯', 2, 20),
  ])
  assert.equal(s.answerState, 'open')
})

test('引用提问者的任意一条消息 → answered', () => {
  const s = scene([
    said(1, A, '这个怎么调？'),
    said(2, A, '我在等答案', 10),
    reply(3, B, '调到 ISO1600', 2, 20),
  ])
  assert.equal(s.answerState, 'answered')
})

test('引用问句本身或真实 @ 提问者 → answered', () => {
  assert.equal(scene([said(1, A, '怎么调？'), reply(2, B, '这样调', 1, 10)]).answerState, 'answered')
  assert.equal(scene([said(1, A, '怎么调？'), at(2, B, '这样调', [A], 10)]).answerState, 'answered')
})

test('自问自答不算回答', () => {
  const s = scene([said(1, A, '怎么调？'), reply(2, A, '我查到了', 1, 10)])
  assert.equal(s.answerState, 'uncertain')
})

test('questionsAskedBy 去重、保序、最多 5 个', () => {
  const askers = [A, B, C, D, 20005, 20006, A]
  const entries = askers.map((userId, i) => said(i + 1, userId, '这个多少？', i * 5))
  const s = scene(entries)
  assert.equal(s.questionsAskedBy.length, 5)
  assert.deepEqual(s.questionsAskedBy, [B, C, D, 20005, 20006])
})

// ── 冲突 ──────────────────────────────────────────────────────────────────

test('只是观点分歧 → 不是 active 冲突', () => {
  const s = scene([
    said(1, A, '我觉得这张好'),
    reply(2, B, '我觉得那张好', 1, 30),
    reply(3, A, '还是这张好', 2, 60),
  ])
  assert.notEqual(s.conflictState, 'active')
  assert.equal(s.conflictState, 'uncertain')
})

test('互相连续回击 + 强否定 → active', () => {
  const s = scene([
    said(1, A, '你能不能别说了'),
    reply(2, B, '闭嘴吧你', 1, 5),
    reply(3, A, '滚', 2, 10),
    reply(4, B, '有完没完', 3, 15),
  ])
  assert.equal(s.conflictState, 'active')
})

test('只有单向回击（都在骂同一个人）→ 不是 active', () => {
  const s = scene([
    said(1, B, '随便吧'),
    reply(2, A, '闭嘴', 1, 10),
    reply(3, A, '烦死了', 1, 20),
    reply(4, A, '别说了', 1, 30),
  ])
  assert.equal(s.conflictState, 'none')
})

test('双向互击但条数与强否定都不够 → uncertain（承认像，但不据此行动）', () => {
  const s = scene([
    said(1, B, '随便吧'),
    reply(2, A, '好吧', 1, 10),
    reply(3, B, '行', 2, 20),
  ])
  assert.equal(s.conflictState, 'uncertain')
})

test('根本解析不出互相回击 → none（默认值，不猜）', () => {
  // reply 段指向一条不在本批里的消息号：查不到发送者，连边都不成立。
  const s = scene([said(1, A, '嗯'), reply(2, B, '哦', 999, 10), reply(3, A, '呵', 998, 20)])
  assert.equal(s.conflictState, 'none')
})

test('超出 5 分钟窗口的互相回击 → 不判 active', () => {
  const s = scene([
    said(1, B, '随便吧'),
    reply(2, A, '闭嘴', 1, 200),
    reply(3, B, '烦', 2, 400),
    reply(4, A, '滚', 3, 600),
  ])
  assert.equal(s.conflictState, 'uncertain')
})

test('空输入下冲突默认 none', () => {
  assert.equal(scene([]).conflictState, 'none')
})

// ── 她自己 ────────────────────────────────────────────────────────────────

test('她 30 分钟前说过类似的话 → repeatedSelf', () => {
  const s = scene(
    [said(1, SELF, '今晚的月亮真的很圆很好看', 0), said(2, A, '是呀', 5)],
    [{ text: '今晚的月亮真的很圆很好看呀', atMs: T0 - 30 * 60_000 }],
  )
  assert.equal(s.repeatedSelf, true)
})

test('她之前说的是完全不同的话 → repeatedSelf 为 false', () => {
  const s = scene(
    [said(1, SELF, '今晚的月亮真的很圆很好看', 0)],
    [{ text: '明天记得带伞，要下雨', atMs: T0 - 30 * 60_000 }],
  )
  assert.equal(s.repeatedSelf, false)
})

test('超出复读窗口（45 分钟前）的相似发言 → 不算复读', () => {
  const s = scene(
    [said(1, SELF, '今晚的月亮真的很圆很好看', 0)],
    [{ text: '今晚的月亮真的很圆很好看呀', atMs: T0 - 45 * 60_000 }],
  )
  assert.equal(s.repeatedSelf, false)
  assert.equal(REPEAT_WINDOW_MS, 40 * 60_000)
})

test('recentSelfTexts 最多 6 条，且取最近的', () => {
  const history = Array.from({ length: 9 }, (_, i) => ({ text: '第' + String(i + 1) + '句', atMs: T0 - (9 - i) * 60_000 }))
  const s = scene([said(1, A, '嗯')], history)
  assert.equal(s.recentSelfTexts.length, 6)
  assert.equal(s.recentSelfTexts[0], '第4句')
  assert.equal(s.recentSelfTexts[5], '第9句')
})

test('没有 recentSelf 时退回这批消息里她自己发的那些', () => {
  const s = scene([said(1, SELF, '我先说一句'), said(2, A, '嗯', 5)])
  assert.deepEqual(s.recentSelfTexts, ['我先说一句'])
  assert.equal(s.repeatedSelf, false)
})

test('askedMe：真实 at 她、或引用的那条是她发的', () => {
  assert.equal(scene([said(1, A, '开聊'), at(2, B, '在吗', [SELF], 10)]).askedMe, true)
  assert.equal(scene([said(1, SELF, '我说一句'), reply(2, A, '回你', 1, 10)]).askedMe, true)
  assert.equal(scene([said(1, SELF, '自问'), at(2, SELF, '自答', [SELF], 10)]).askedMe, false)
  assert.equal(scene([said(1, A, '开聊'), said(2, B, '继续', 10)]).askedMe, false)
})

// ── 参与者与安全返回 ──────────────────────────────────────────────────────

test('activeParticipants 去重、保序、最多 10 个', () => {
  const users = [A, B, A, C, D, 20005, 20006, 20007, 20008, 20009, 20010, 20011]
  const s = scene(users.map((userId, i) => said(i + 1, userId, '话', i * 5)))
  assert.equal(s.activeParticipants.length, 10)
  assert.equal(s.activeParticipants[0], B)
  assert.equal(s.activeParticipants[9], 20011)
})

test('空输入安全返回（不抛、字段都是保守值）', () => {
  const s = scene([])
  assert.deepEqual(s.replyEdges, [])
  assert.deepEqual(s.activeParticipants, [])
  assert.equal(s.directedTo, undefined)
  assert.equal(s.discussionKind, 'uncertain')
  assert.equal(s.answerState, 'uncertain')
  assert.equal(s.conflictState, 'none')
  assert.deepEqual(s.recentSelfTexts, [])
  assert.equal(s.repeatedSelf, false)
  assert.equal(s.askedMe, false)
  assert.deepEqual(s.questionsAskedBy, [])
})

test('单条消息安全返回', () => {
  const s = scene([said(1, A, '在吗')])
  assert.equal(s.replyEdges.length, 0)
  assert.deepEqual(s.activeParticipants, [A])
  assert.equal(s.discussionKind, 'uncertain')
  assert.equal(s.directedTo, undefined)
})

test('非法 id / 非法时间被静默丢弃，不抛', () => {
  const bad: SceneInput[] = [
    { messageId: 0, userId: A, text: '零号', atMs: T0, self: false },
    { messageId: 1, userId: -1, text: '负号', atMs: T0, self: false },
    { messageId: 2, userId: B, text: '坏时间', atMs: Number.NaN, self: false },
    { messageId: 3.5, userId: C, text: '小数号', atMs: T0, self: false, replyToMessageId: Number.NaN },
  ]
  const s = scene(bad)
  // 留下的是 A（号非法的 messageId 降级为 null）与 C；B 的时间不是有限数，整条丢掉。
  assert.deepEqual(s.activeParticipants, [A, C])
  assert.deepEqual(s.replyEdges, [])
  assert.equal(s.directedTo, undefined)
})

test('entries 不是数组时也安全返回', () => {
  const s = buildSocialScene({ entries: undefined as unknown as readonly SceneInput[], selfId: SELF, nowMs: T0 })
  assert.deepEqual(s.activeParticipants, [])
  assert.equal(s.discussionKind, 'uncertain')
})

test('selfId 不在参与者里不影响判定', () => {
  const s = scene([said(1, A, '在吗'), reply(2, B, '在', 1, 10)])
  assert.equal(s.askedMe, false)
  assert.equal(s.discussionKind, 'directed')
  assert.ok(!s.activeParticipants.includes(SELF))
})

test('非法 selfId 不被当成有效的"她"', () => {
  const s = buildSocialScene({ entries: [said(1, A, '嗯')], selfId: Number.NaN, nowMs: T0 })
  assert.equal(s.askedMe, false)
  assert.deepEqual(s.recentSelfTexts, [])
})
