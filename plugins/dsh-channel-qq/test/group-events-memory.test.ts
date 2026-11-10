/** 统一群事件时间线（P3 §7.1）与记忆契约（P1）的单测。
 *
 * 纪律：不读盘、不联网、不读时钟（时间全部由入参给）。
 *
 * 时间线要钉住的是**去重与裁剪**——这两条错了，"她刚说过什么"就会出现两份或全丢：
 *   - 同一条平台消息重推 → 只进一次；
 *   - 同一条自主发言 → 只进一次（`eventId` 与 `messageId` 两个键都要挡）；
 *   - 超条数/超时间窗 → 从最老的丢，绝不留空窗；
 *   - `recentSelf` 只给"她自己说的"，按时间正序。
 *
 * 记忆契约要钉住的是**作用域与推测**：
 *   - 跨群证据一律丢（不是"这个群优先"）；
 *   - 缺来源、缺成员号、空正文 → 丢；
 *   - 存储侧给的 TEXT id 也能被认出来（跨插件边界的真实形状）；
 *   - 超预算时先丢推测、再丢成员记忆，最后才动群体记忆。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  GroupTimeline,
  inboundEventOf,
  selfEventOf,
  type GroupEvent,
} from '../src/core/group-events.js'
import {
  EMPTY_RECALL,
  clipChars,
  idOf,
  evidenceLine,
  normalizeRecall,
  type GroupMemoryEvidence,
} from '../src/app/inbound/group-memory-contract.js'

const T0 = new Date(2026, 10, 8, 21, 0, 0).getTime()
const GROUP = 145326153

function limits(over: Partial<{ maxEvents: number; ttlMs: number }> = {}) {
  return { maxEvents: 5, ttlMs: 60_000, ...over }
}

// ── 时间线：去重 ────────────────────────────────────────────────────────────

test('同一条平台消息重推只进一次（NapCat 重试 / 窗口回显）', () => {
  const timeline = new GroupTimeline(limits())
  const event = inboundEventOf({ groupId: GROUP, messageId: 501, senderId: 10_001, content: '在吗', timestamp: T0 })
  assert.equal(timeline.append(event, T0), 'added')
  assert.equal(timeline.append(event, T0), 'duplicate')
  assert.equal(timeline.size(T0), 1)
})

test('同一条自主发言只进一次（eventId 与 messageId 两个键都挡）', () => {
  const timeline = new GroupTimeline(limits())
  const event = selfEventOf({ groupId: GROUP, messageId: 9001, content: '我也想看', timestamp: T0, kind: 'proactive_message', senderId: 0 })
  assert.equal(timeline.append(event, T0), 'added')
  assert.equal(timeline.append({ ...event }, T0), 'duplicate')
  assert.equal(timeline.recentSelf(T0).length, 1)
})

test('agent_reply 与 proactive_message 同一号不算重复（两种事实分开记）', () => {
  const timeline = new GroupTimeline(limits())
  timeline.append(selfEventOf({ groupId: GROUP, messageId: 9001, content: '被 @ 的回复', timestamp: T0, kind: 'agent_reply', senderId: 0 }), T0)
  timeline.append(selfEventOf({ groupId: GROUP, messageId: 9001, content: '自主发言', timestamp: T0 + 1, kind: 'proactive_message', senderId: 0 }), T0 + 1)
  assert.equal(timeline.size(T0 + 1), 2)
})

test('没有 eventId 的事件被拒（不能进时间线，也不能占位）', () => {
  const timeline = new GroupTimeline(limits())
  const broken = { ...selfEventOf({ groupId: GROUP, messageId: 1, content: 'x', timestamp: T0, kind: 'reaction', senderId: 0 }), eventId: '  ' }
  assert.equal(timeline.append(broken, T0), 'rejected')
  assert.equal(timeline.size(T0), 0)
})

// ── 时间线：裁剪 ────────────────────────────────────────────────────────────

test('超条数从最老的丢（留下的永远是最新的）', () => {
  const timeline = new GroupTimeline(limits({ maxEvents: 3 }))
  for (let i = 1; i <= 6; i += 1) {
    timeline.append(inboundEventOf({ groupId: GROUP, messageId: i, senderId: 10_001, content: `第${String(i)}条`, timestamp: T0 + i }), T0 + i)
  }
  const live = timeline.live(T0 + 6)
  assert.deepEqual(live.map((event) => event.content), ['第4条', '第5条', '第6条'])
})

test('超时间窗的整条丢（短期上下文，不是记忆）', () => {
  const timeline = new GroupTimeline(limits({ ttlMs: 10_000 }))
  timeline.append(inboundEventOf({ groupId: GROUP, messageId: 1, senderId: 1, content: '很老', timestamp: T0 }), T0)
  timeline.append(inboundEventOf({ groupId: GROUP, messageId: 2, senderId: 1, content: '新的', timestamp: T0 + 9_000 }), T0 + 9_000)
  assert.deepEqual(timeline.live(T0 + 15_000).map((event) => event.content), ['新的'])
})

test('recentSelf 只给"她自己说的"，且按时间正序', () => {
  const timeline = new GroupTimeline(limits({ maxEvents: 20 }))
  timeline.append(inboundEventOf({ groupId: GROUP, messageId: 1, senderId: 10_001, content: '别人说的', timestamp: T0 }), T0)
  timeline.append(selfEventOf({ groupId: GROUP, messageId: 2, content: '她说的第一句', timestamp: T0 + 1, kind: 'proactive_message', senderId: 0 }), T0 + 1)
  timeline.append(selfEventOf({ groupId: GROUP, messageId: 3, content: '她说的第二句', timestamp: T0 + 2, kind: 'agent_reply', senderId: 0 }), T0 + 2)
  assert.deepEqual(timeline.recentSelf(T0 + 3).map((event) => event.content), ['她说的第一句', '她说的第二句'])
  assert.equal(timeline.latest(T0 + 3)?.content, '她说的第二句')
})

test('没有消息号的入站消息拿到稳定合成 id（不猜一个真实号）', () => {
  const a = inboundEventOf({ groupId: GROUP, messageId: null, senderId: 7, content: 'x', timestamp: T0 })
  assert.equal(a.messageId, undefined)
  assert.match(a.eventId, /^syn:/)
  const b = inboundEventOf({ groupId: GROUP, messageId: null, senderId: 7, content: 'x', timestamp: T0 })
  assert.equal(a.eventId, b.eventId, '同样的输入要得到同样的 id（才能去重）')
})

test('configure 之后立即按新上限裁剪（配置热更新）', () => {
  const timeline = new GroupTimeline(limits({ maxEvents: 10 }))
  for (let i = 1; i <= 6; i += 1) {
    timeline.append(inboundEventOf({ groupId: GROUP, messageId: i, senderId: 1, content: String(i), timestamp: T0 + i }), T0 + i)
  }
  timeline.configure(limits({ maxEvents: 2 }))
  assert.deepEqual(timeline.live(T0 + 6).map((event) => event.content), ['5', '6'])
})

// ── 记忆契约 ────────────────────────────────────────────────────────────────

function evidence(over: Partial<GroupMemoryEvidence> = {}): GroupMemoryEvidence {
  const scope = over.scope ?? 'group'
  return {
    scope,
    groupId: GROUP,
    // 成员记忆必须带 memberId，否则会被"缺成员号"丢掉——这是契约本身的要求，
    // 所以默认给一个，用例只在测"缺成员号"时显式覆盖成 undefined。
    ...(scope === 'member' ? { memberId: 10_001 } : {}),
    content: '这个群喜欢拍月亮',
    kind: 'explicit',
    confidence: 0.8,
    sourceMessageIds: [501],
    createdAt: T0,
    ...over,
  }
}

test('idOf：number 与纯数字串都认，其余一律 0（跨插件边界的真实形状）', () => {
  assert.equal(idOf(145326153), 145326153)
  assert.equal(idOf('145326153'), 145326153)
  assert.equal(idOf(' 145326153 '), 145326153)
  assert.equal(idOf(''), 0)
  assert.equal(idOf('abc'), 0)
  assert.equal(idOf(-1), 0)
  assert.equal(idOf(null), 0)
})

test('跨群证据一律丢（不是"这个群优先"）', () => {
  const recall = normalizeRecall(
    { group: [evidence(), evidence({ groupId: 999 })] },
    { groupId: GROUP },
  )
  assert.equal(recall.group.length, 1)
  assert.ok(recall.dropped.includes('cross-group'))
})

test('成员记忆必须属于本轮正在说话的人（别人的画像不许塞进来）', () => {
  const recall = normalizeRecall(
    {
      member: [
        evidence({ scope: 'member', memberId: 10_001, content: '他喜欢拍月亮' }),
        evidence({ scope: 'member', memberId: 99_999, content: '没在这个群里说话的人' }),
      ],
    },
    { groupId: GROUP, memberIds: [10_001] },
  )
  assert.deepEqual(recall.member.map((item) => item.content), ['他喜欢拍月亮'])
  assert.ok(recall.dropped.includes('other-member'))
})

test('缺来源 / 缺成员号 / 空正文 → 丢（没有来源的记忆不可追溯）', () => {
  const recall = normalizeRecall(
    {
      group: [
        evidence({ sourceMessageIds: [] }),
        evidence({ content: '' }),
      ],
      member: [evidence({ scope: 'member', memberId: undefined })],
    },
    { groupId: GROUP, memberIds: [10_001] },
  )
  assert.equal(recall.group.length, 0)
  assert.equal(recall.member.length, 0)
  assert.ok(recall.dropped.includes('no-source'))
  assert.ok(recall.dropped.includes('empty-content'))
  assert.ok(recall.dropped.includes('no-member'))
})

test('推测排在最后、置信度被压到 0.4 以下（不许挤掉明确事实）', () => {
  const recall = normalizeRecall(
    {
      group: [
        evidence({ kind: 'guess', confidence: 0.9, content: '他们可能喜欢爬山' }),
        evidence({ kind: 'explicit', confidence: 0.5, content: '他说过周末去爬山' }),
      ],
    },
    { groupId: GROUP },
  )
  assert.deepEqual(recall.group.map((item) => item.kind), ['explicit', 'guess'])
  assert.ok((recall.group[1]?.confidence ?? 1) <= 0.4)
})

test('语义形状不对的输入 → 空结果（不抛、不猜）', () => {
  assert.deepEqual(normalizeRecall(null, { groupId: GROUP }), EMPTY_RECALL)
  assert.deepEqual(normalizeRecall('nope', { groupId: GROUP }), EMPTY_RECALL)
  assert.deepEqual(normalizeRecall({ group: 'not-array', member: 42 }, { groupId: GROUP }), EMPTY_RECALL)
})

test('超预算：先丢推测，再丢成员记忆，最后才动群体记忆', () => {
  const fat = (text: string, kind: GroupMemoryEvidence['kind'], scope: 'group' | 'member' = 'group'): GroupMemoryEvidence =>
    evidence({ content: text, kind, scope })
  const recall = normalizeRecall(
    {
      group: [fat('甲'.repeat(60), 'explicit'), fat('乙'.repeat(60), 'guess')],
      member: [fat('丙'.repeat(60), 'explicit', 'member'), fat('丁'.repeat(60), 'observed', 'member')],
    },
    { groupId: GROUP, memberIds: [10_001], budgetChars: 100 },
  )
  const total = [...recall.group, ...recall.member].reduce((sum, item) => sum + [...item.content].length + 1, 0)
  assert.ok(total <= 100, `总长 ${String(total)} 超过预算`)
  // 群体记忆里的明确事实必须活着（它是"接不接得上"的主依据）
  assert.ok(recall.group.some((item) => item.content.startsWith('甲')))
  assert.ok(recall.dropped.includes('budget-drop-member'))
})

test('clipChars 按码点截断（emoji 不算两个字）', () => {
  assert.equal(clipChars('🌙🌙🌙', 2), '🌙🌙')
  assert.equal(clipChars('abc', 10), 'abc')
})

test('evidenceLine 的口吻由 kind 决定（推测必须写明"别当事实说"）', () => {
  assert.match(evidenceLine(evidence({ kind: 'explicit' })), /他明确说过/)
  assert.match(evidenceLine(evidence({ kind: 'observed' })), /你观察到的/)
  assert.match(evidenceLine(evidence({ kind: 'guess' })), /只是你的推测，别当事实说/)
})
