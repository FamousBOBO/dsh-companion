/** 社交场景段的**渲染**测试（P6-A）。
 *
 * 这一段是"给模型看的上下文"，所以测试重点不是文案，而是**三条不会伤人的性质**：
 *   1. 没有事实时**不出现**（提示词与 P2 逐字节一致）；
 *   2. 判不准就写"看不出"，**不偷偷挑一个结论**；
 *   3. 不写命令句（"别插嘴""该沉默了"）——那会把代码的猜测变成命令。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { renderSocialScene, SCENE_MAX_CHARS } from '../src/app/inbound/group-scene-prompt.js'
import type { SocialScene } from '../src/core/group-scene.js'

const A = 100_001
const B = 100_002

function scene(over: Partial<SocialScene> = {}): SocialScene {
  return {
    replyEdges: [],
    activeParticipants: [A, B],
    directedTo: undefined,
    discussionKind: 'uncertain',
    answerState: 'uncertain',
    conflictState: 'none',
    recentSelfTexts: [],
    repeatedSelf: false,
    askedMe: false,
    questionsAskedBy: [],
    ...over,
  }
}

test('没有事实（单条消息、无引用、无提问）→ 空串，提示词与 P2 一致', () => {
  assert.equal(renderSocialScene(null), '')
  assert.equal(renderSocialScene(scene({ activeParticipants: [A] })), '')
})

test('有引用边时列出"谁回了谁"（只给消息号，不复述正文）', () => {
  const text = renderSocialScene(scene({
    replyEdges: [{ fromMessageId: 612, toMessageId: 611 }],
  }))
  assert.match(text, /消息 612 引用了 消息 611/)
  // 只给号：这一段不该出现任何一句原文（原文在上面的背景块里，重复一遍等于喂两遍）。
  assert.ok(!text.includes('今晚还差一个人'), '这一段不该复述正文')
})

test('两个人说话时**明说**"这不等于私聊"（防止模型把人数当结论）', () => {
  const text = renderSocialScene(scene({
    replyEdges: [{ fromMessageId: 612, toMessageId: 611 }],
  }))
  assert.match(text, /只有两个人在说话/)
  assert.match(text, /不说明是私聊/)
})

test('判不准的字段渲染成"看不出"，不偷偷挑一个', () => {
  const text = renderSocialScene(scene({
    replyEdges: [{ fromMessageId: 612, toMessageId: 611 }],
    discussionKind: 'uncertain',
    answerState: 'uncertain',
    conflictState: 'uncertain',
  }))
  assert.match(text, /看不出是公开还是定向/)
  assert.match(text, /看不出来有没有被回应/)
  assert.match(text, /看不准有没有争执/)
})

test('**不含命令句**：段落里不许出现"别插嘴""该沉默"这类祈使结论', () => {
  const text = renderSocialScene(scene({
    replyEdges: [{ fromMessageId: 612, toMessageId: 611 }],
    discussionKind: 'directed',
    conflictState: 'active',
    repeatedSelf: true,
  }))
  for (const forbidden of ['别插嘴', '不许说话', '必须沉默', '你应该']) {
    assert.ok(!text.includes(forbidden), `不该出现命令句：${forbidden}`)
  }
  // 结尾必须把判断权交回模型。
  assert.match(text, /拿不准就选 silent/)
})

test('名字优先：给了名字表就用名字，没有才退回 QQ 号', () => {
  const names = new Map<number, string>([[A, '小王'], [B, '小李']])
  const withNames = renderSocialScene(scene({ directedTo: B }), (id) => names.get(id) ?? '')
  assert.match(withNames, /小王/)
  assert.match(withNames, /小李/)
  assert.ok(!withNames.includes(String(A)), '有名字时不该再列 QQ 号（同一串数字出现两次会让模型当成两个人）')
  const withoutNames = renderSocialScene(scene({ directedTo: B }))
  assert.match(withoutNames, new RegExp(String(B)))
})

test('争执与复读各自有一句提示，且都带"可能"（不把推断说成事实）', () => {
  const conflict = renderSocialScene(scene({
    replyEdges: [{ fromMessageId: 612, toMessageId: 611 }],
    conflictState: 'active',
  }))
  assert.match(conflict, /争执/)
  assert.match(conflict, /可能/)
  const repeat = renderSocialScene(scene({
    replyEdges: [{ fromMessageId: 612, toMessageId: 611 }],
    repeatedSelf: true,
  }))
  assert.match(repeat, /内容很接近/)
  assert.match(repeat, /别换个说法复读/)
})

test('有人真的 @ 她时明说（这是"被邀请"的唯一事实来源）', () => {
  const text = renderSocialScene(scene({
    replyEdges: [{ fromMessageId: 612, toMessageId: 611 }],
    askedMe: true,
  }))
  assert.match(text, /真的 @ 了你/)
})

test('有字数上限（上下文不是资料库）', () => {
  const edges = Array.from({ length: 40 }, (_, i) => ({ fromMessageId: 600 + i, toMessageId: 500 + i }))
  const text = renderSocialScene(scene({ replyEdges: edges }))
  assert.ok([...text].length <= SCENE_MAX_CHARS, `长度 ${String([...text].length)} 超过上限`)
})

test('渲染抛错也不会让判断崩（坏场景只该少一段）', () => {
  const broken = { ...scene(), activeParticipants: null } as unknown as SocialScene
  assert.equal(renderSocialScene(broken), '')
})
