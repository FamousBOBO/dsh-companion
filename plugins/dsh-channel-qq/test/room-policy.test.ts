/** 按群覆盖的解析：优先级、非法值兜底、主群概率。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { resolveRoomPolicy } = await import('../src/core/room-policy.js')

const base = {
  groupEnabled: true,
  requireMention: true,
  talkValue: 0.6,
  primaryGroup: 100,
  rooms: undefined,
}

test('没有覆盖：原样返回全局值（主群用 primaryTalkValue）', () => {
  assert.deepEqual(resolveRoomPolicy(base, 200), { enabled: true, requireMention: true, talkValue: 0.6 })
  assert.deepEqual(
    resolveRoomPolicy({ ...base, primaryTalkValue: 0.9 }, 100),
    { enabled: true, requireMention: true, talkValue: 0.9 },
  )
})

test('单个群覆盖优先于全局', () => {
  const config = { ...base, rooms: [{ id: 200, enabled: false, requireMention: false, talkValue: 0.1 }] }
  assert.deepEqual(resolveRoomPolicy(config, 200), { enabled: false, requireMention: false, talkValue: 0.1 })
  // 别的群不受影响。
  assert.deepEqual(resolveRoomPolicy(config, 300), { enabled: true, requireMention: true, talkValue: 0.6 })
})

test('只覆盖一个字段时，其余仍跟全局', () => {
  const config = { ...base, rooms: [{ id: 200, enabled: false }] }
  assert.deepEqual(resolveRoomPolicy(config, 200), { enabled: false, requireMention: true, talkValue: 0.6 })
})

test('非法值当作没有覆盖（不因手滑把群静音/刷屏）', () => {
  const config = {
    ...base,
    rooms: [{ id: 200, enabled: 'false', requireMention: 1, talkValue: 2 }],
  } as never
  assert.deepEqual(resolveRoomPolicy(config, 200), { enabled: true, requireMention: true, talkValue: 0.6 })
})

test('私聊：只看全局（不套群覆盖）', () => {
  const config = { ...base, rooms: [{ id: 200, enabled: false }] }
  assert.deepEqual(resolveRoomPolicy(config, null), { enabled: true, requireMention: true, talkValue: 0.6 })
})

test('主群自己也有覆盖时，覆盖优先于 primaryTalkValue', () => {
  const config = { ...base, primaryTalkValue: 0.9, rooms: [{ id: 100, talkValue: 0.2 }] }
  assert.equal(resolveRoomPolicy(config, 100).talkValue, 0.2)
})

test('配置解析：rooms 数组必须原样穿过 resolveConfig（对象形态会被静默丢掉）', async () => {
  const { resolveConfig } = await import('../src/config/resolve.js')
  const rooms = [{ id: 200, enabled: false }]
  const fromPatch = resolveConfig({ rooms } as never)
  assert.deepEqual(fromPatch.rooms, rooms, 'patch 层要保留')
  const fromOverride = resolveConfig({}, { rooms } as never)
  assert.deepEqual(fromOverride.rooms, rooms, '后台覆盖层要保留')
})
