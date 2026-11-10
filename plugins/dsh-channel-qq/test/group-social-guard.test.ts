/** P6-B：四条事实型复核的单元测试。
 *
 * 这一层的风险是**误拦**（她该说话时被拦住，用户看到的是"她变呆了"），所以每条规则都成对写：
 * 一个该拦的用例 + 一个**必须放行**的反例。放行反例比拦截用例更重要——它们定义了
 * "这条规则不许扩大到哪里"。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  checkSocialGuard,
  DEFAULT_SOCIAL_GUARD,
  SOCIAL_GUARD_MODES,
  SELF_REPEAT_THRESHOLD,
} from '../src/core/group-social-guard.js'
import { buildSocialScene, type SocialScene } from '../src/core/group-scene.js'

const SELF = 100_000
const A = 100_001
const B = 100_002
const T0 = new Date(2026, 10, 8, 21, 0, 0).getTime()

/** 空场景（各字段都是保守值）：没给的具体字段用它兜。 */
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

test('默认档位是 warn（只记不拦），三档齐全', () => {
  assert.equal(DEFAULT_SOCIAL_GUARD, 'warn')
  assert.deepEqual([...SOCIAL_GUARD_MODES], ['off', 'warn', 'enforce'])
})

// ── G30：复读自己 ───────────────────────────────────────────────────────────

test('G30：与她自己刚说过的那句完全相同 → 拦', () => {
  const verdict = checkSocialGuard({
    action: 'reply',
    text: '今天又下雨 出门记得带伞',
    scene: scene(),
    selfSaid: [{ text: '今天又下雨 出门记得带伞', atMs: T0 }],
    nowMs: T0 + 10 * 60_000,
  })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.ok === false ? verdict.reason : '', 'self-repeat')
})

test('G30：只差标点也算复读（不能被标点绕过）', () => {
  const verdict = checkSocialGuard({
    action: 'reply',
    text: '今天又下雨，出门记得带伞！',
    scene: scene(),
    selfSaid: [{ text: '今天又下雨 出门记得带伞', atMs: T0 }],
    nowMs: T0 + 60_000,
  })
  assert.equal(verdict.ok, false)
})

test('G30 反例：内容不同的新信息必须放行（不许把不同观点都拦掉）', () => {
  const verdict = checkSocialGuard({
    action: 'reply',
    text: '带伞也没用，我昨天带了照样湿透',
    scene: scene(),
    selfSaid: [{ text: '今天又下雨 出门记得带伞', atMs: T0 }],
    nowMs: T0 + 10 * 60_000,
  })
  assert.equal(verdict.ok, true)
})

test('G30 反例：超出 40 分钟窗口的旧话不算复读', () => {
  const verdict = checkSocialGuard({
    action: 'reply',
    text: '今天又下雨 出门记得带伞',
    scene: scene(),
    selfSaid: [{ text: '今天又下雨 出门记得带伞', atMs: T0 }],
    nowMs: T0 + 41 * 60_000,
  })
  assert.equal(verdict.ok, true, '半小时以前的同类话题是正常的，不该拦')
})

test('G30 反例：别人说过的同一句不算（这条只防"复读自己"）', () => {
  const verdict = checkSocialGuard({
    action: 'reply',
    text: '今天又下雨 出门记得带伞',
    scene: scene(),
    selfSaid: [],
    nowMs: T0,
  })
  assert.equal(verdict.ok, true)
})

test('复读阈值 0.9 比"接话复读"的 0.6 更保守（两个场景代价不对称）', () => {
  assert.equal(SELF_REPEAT_THRESHOLD, 0.9)
})

// ── G41：争执中不掺和 ──────────────────────────────────────────────────────

test('G41：场景判为 active 且没人找她 → 连劝架也不许', () => {
  const verdict = checkSocialGuard({
    action: 'react',
    text: '都少说两句吧',
    scene: scene({ conflictState: 'active', askedMe: false }),
    selfSaid: [],
    nowMs: T0,
  })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.ok === false ? verdict.reason : '', 'conflict-bystander')
})

test('G41 反例：有人真的 @ 她求助 → 放行（不许一有争执就全群禁言）', () => {
  const verdict = checkSocialGuard({
    action: 'reply',
    text: '先别急，把聊天记录发我看看',
    scene: scene({ conflictState: 'active', askedMe: true }),
    selfSaid: [],
    nowMs: T0,
  })
  assert.equal(verdict.ok, true)
})

test('G41 反例：只是观点分歧（conflictState 不是 active）→ 放行', () => {
  const verdict = checkSocialGuard({
    action: 'reply',
    text: '我倒觉得第二种方案更稳',
    scene: scene({ conflictState: 'uncertain' }),
    selfSaid: [],
    nowMs: T0,
  })
  assert.equal(verdict.ok, true)
})

// ── G06：定向对话里不"加入话题" ─────────────────────────────────────────────

test('G06：定向对话 + 没被点名 → 不许 join', () => {
  const verdict = checkSocialGuard({
    action: 'join',
    text: '你们打什么 我也想玩',
    scene: scene({ discussionKind: 'directed', directedTo: B }),
    selfSaid: [],
    nowMs: T0,
  })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.ok === false ? verdict.reason : '', 'directed-join')
})

test('G06 反例：定向对话里回**某一条**是允许的（reply 不是"加入话题"）', () => {
  const verdict = checkSocialGuard({
    action: 'reply',
    targetMessageId: 613,
    text: '我也缺人，算我一个',
    scene: scene({ discussionKind: 'directed', directedTo: B }),
    selfSaid: [],
    nowMs: T0,
  })
  assert.equal(verdict.ok, true)
})

test('G06 反例：公开讨论里 join 必须放行（否则她就再也不敢参与公开话题）', () => {
  const verdict = checkSocialGuard({
    action: 'join',
    text: '这个我也在看',
    scene: scene({ discussionKind: 'public' }),
    selfSaid: [],
    nowMs: T0,
  })
  assert.equal(verdict.ok, true)
})

test('G06 反例：被点名的 join（directedTo 就是她）→ 放行', () => {
  const verdict = checkSocialGuard({
    action: 'join',
    text: '在呢，怎么了',
    scene: scene({ discussionKind: 'directed', directedTo: undefined, askedMe: true }),
    selfSaid: [],
    nowMs: T0,
  })
  assert.equal(verdict.ok, true)
})

test('G06 反例：场景算不出来（null）→ join 放行（宁可不拦）', () => {
  const verdict = checkSocialGuard({
    action: 'join',
    text: '我也有同感',
    scene: null,
    selfSaid: [],
    nowMs: T0,
  })
  assert.equal(verdict.ok, true)
})

// ── G10：重复抢答 ──────────────────────────────────────────────────────────

test('G10：有人已经这样答过了，她再答一遍同样的话 → 拦', () => {
  const verdict = checkSocialGuard({
    action: 'reply',
    targetMessageId: 711,
    text: '我也可以顶一会儿',
    scene: scene(),
    selfSaid: [],
    nowMs: T0,
    existingAnswers: ['我也可以顶一会儿'],
  })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.ok === false ? verdict.reason : '', 'answered-duplicate')
})

test('G10 反例：已有回答，但她带来了真正的新信息 → 放行（不许"有人答过就不许答"）', () => {
  const verdict = checkSocialGuard({
    action: 'reply',
    targetMessageId: 711,
    text: '我下午有空，两点到五点都能顶',
    scene: scene(),
    selfSaid: [],
    nowMs: T0,
    existingAnswers: ['我'],
  })
  assert.equal(verdict.ok, true)
})

test('G10 反例：没人回答过（existingAnswers 空）→ 放行', () => {
  const verdict = checkSocialGuard({
    action: 'reply',
    targetMessageId: 711,
    text: '我也可以顶一会儿',
    scene: scene({ answerState: 'open' }),
    selfSaid: [],
    nowMs: T0,
    existingAnswers: [],
  })
  assert.equal(verdict.ok, true)
})

// ── 顺序与组合 ──────────────────────────────────────────────────────────────

test('多条同时命中时，先给最确定的那条（复读原话 > 场景推断）', () => {
  const verdict = checkSocialGuard({
    action: 'join',
    text: '今天又下雨 出门记得带伞',
    scene: scene({ conflictState: 'active', discussionKind: 'directed', directedTo: B }),
    selfSaid: [{ text: '今天又下雨 出门记得带伞', atMs: T0 }],
    nowMs: T0 + 60_000,
  })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.ok === false ? verdict.reason : '', 'self-repeat')
})

test('真实场景接进复核：两人互相引用但没点名她 → join 被拦（G06 的端到端形状）', () => {
  const built = buildSocialScene({
    entries: [
      { messageId: 611, userId: A, text: '今晚还差一个人 你来不来', atMs: T0, self: false, atUserIds: [B] },
      { messageId: 612, userId: B, text: '我九点后才能上', atMs: T0 + 60_000, self: false, replyToMessageId: 611 },
      { messageId: 613, userId: A, text: '那你上线喊我', atMs: T0 + 120_000, self: false, replyToMessageId: 612 },
    ],
    selfId: SELF,
    nowMs: T0 + 180_000,
  })
  assert.equal(built.discussionKind, 'directed')
  assert.equal(built.directedTo, B)
  const verdict = checkSocialGuard({
    action: 'join',
    text: '你们打什么 我也想玩',
    scene: built,
    selfSaid: [],
    nowMs: T0 + 180_000,
  })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.ok === false ? verdict.reason : '', 'directed-join')
})
