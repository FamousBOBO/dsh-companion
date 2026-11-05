/** 人物侧写（B2）：筛选、排序、去重、上限、渲染长度。
 *
 * 防的是"侧写把别人/作废的事也写进去"：只留 active 且未被取代的该用户记录。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { buildProfile, renderProfile } = await import('../src/core/memory/profile.js')
const { makeRecord } = await import('../src/core/memory/model.js')

const NOW = Date.parse('2026-10-22T12:00:00+08:00')

function rec(over: Record<string, unknown>) {
  return makeRecord({
    kind: 'fact',
    subject: { type: 'user', id: 7 },
    content: '默认内容',
    source: { kind: 'chat', room: 'group-107' },
    importance: 5,
    ...over,
  }, NOW, () => 0.5)
}

test('侧写：只留这个人、active、未被取代；重要度优先', () => {
  const records = [
    rec({ content: '喜欢冰美式', importance: 8 }),
    rec({ content: '怕辣', importance: 6 }),
    rec({ content: '这是别人的', subject: { type: 'user', id: 8 }, importance: 10 }),
    { ...rec({ content: '已作废', importance: 9 }), status: 'superseded' as const },
    { ...rec({ content: '被别人取代', importance: 9 }), supersededBy: 'x' },
    rec({ content: '喜欢冰美式', importance: 8 }),
  ]
  const lines = buildProfile(records, 7, 5)
  assert.deepEqual(lines.map((l) => l.text), ['喜欢冰美式', '怕辣'])
})

test('侧写：limit 生效，渲染带称呼且不超过 240 字', () => {
  const records = Array.from({ length: 8 }, (_, i) => rec({ content: `第${i}条关于他的事`, importance: 10 - i }))
  assert.equal(buildProfile(records, 7, 3).length, 3)
  const text = renderProfile('学弟', buildProfile(records, 7, 8))
  assert.match(text, /^【关于学弟】/)
  assert.ok(text.length <= 240)
})

test('侧写：没有记录 → 空串', () => {
  assert.equal(renderProfile('学弟', buildProfile([], 7)), '')
})
