/**
 * 对抗测试：假 OneBot WS 必须拒绝**一切**动作，且没有任何上游可穿透。
 *
 * 这是计划 §4 的 T02 / T03 / T13 的离线版本——先证明"拦得住"，再去接真实数据。
 * 关键断言不是"某些动作被拒"，而是：
 *
 *   1. 频道里用到的每一个动作、以及**任意未知动作**都被拒；
 *   2. 拒绝帧是**明确失败**（status=failed、retcode 非零），不是假成功；
 *   3. 绝不返回合成的 message_id —— 假回执会让测试运行时的 sent-log 记下"已发送"；
 *   4. 非本机来源、错 Token 的握手直接拒绝。
 *
 * 跑法：node --test tools/group-mirror/test/
 */
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import WebSocket from 'ws'

import { FakeOneBotServer } from '../src/local-ws.mjs'

/** 频道实际用到的 39 个动作（取自 adapters/onebot/qq-api.ts）+ 几个未知动作。 */
const KNOWN_ACTIONS = [
  'can_send_record', 'check_url_safely', 'delete_essence_msg', 'delete_group_file', 'delete_msg',
  'fetch_ptt_text', 'get_ai_record', 'get_essence_msg_list', 'get_file', 'get_forward_msg',
  'get_friend_list', 'get_group_info', 'get_group_list', 'get_group_member_info',
  'get_group_root_files', 'get_image', 'get_login_info', 'get_msg', 'get_private_file_url',
  'get_status', 'get_stranger_info', 'group_poke', 'send_group_ai_record',
  'send_group_forward_msg', 'send_group_msg', 'send_like', 'send_private_forward_msg',
  'send_private_msg', 'set_diy_online_status', 'set_essence_msg', 'set_group_admin',
  'set_group_ban', 'set_group_card', 'set_group_kick', 'set_group_whole_ban',
  'set_input_status', 'set_msg_emoji_like', 'set_online_status', 'upload_private_file',
]

const UNKNOWN_ACTIONS = ['some_future_action', 'send_group_telepathy', '', '__proto__']

const TOKEN = 'fake-mirror-token-for-tests'
const PORT = 31_491

let server

before(async () => {
  server = new FakeOneBotServer({ host: '127.0.0.1', port: PORT, token: TOKEN })
  await server.listen()
})

after(async () => {
  await server.close()
})

/** 连上假 WS（带正确 Token），返回 socket 与一个"发动作并等回执"的函数。 */
function connect() {
  const socket = new WebSocket('ws://127.0.0.1:' + PORT + '/', { headers: { Authorization: 'Bearer ' + TOKEN } })
  const pending = new Map()
  socket.on('message', (data) => {
    let frame = null
    try { frame = JSON.parse(String(data)) } catch { return }
    const waiter = pending.get(String(frame.echo))
    if (waiter) { pending.delete(String(frame.echo)); waiter(frame) }
  })
  const ready = new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  let seq = 0
  const call = (action, params = {}) => new Promise((resolve, reject) => {
    seq += 1
    const echo = 'e' + seq
    const timer = setTimeout(() => reject(new Error('等回执超时：' + action)), 3000)
    pending.set(echo, (frame) => { clearTimeout(timer); resolve(frame) })
    socket.send(JSON.stringify({ action, params, echo }))
  })
  return { socket, ready, call }
}

test('T03：频道用到的 39 个动作全部被拒，且没有一个是假成功', async () => {
  const { socket, ready, call } = connect()
  await ready
  try {
    for (const action of KNOWN_ACTIONS) {
      const frame = await call(action, { group_id: 1, message: 'x' })
      assert.equal(frame.status, 'failed', action + ' 必须是明确失败')
      assert.notEqual(frame.retcode, 0, action + ' 的 retcode 不能是 0（那会被当成成功）')
      assert.equal(frame.data, null, action + ' 不许返回任何 data（尤其不许合成 message_id）')
    }
  } finally {
    socket.close()
  }
  assert.ok(server.stats.forbiddenActionAttempts >= KNOWN_ACTIONS.length)
})

test('T03：未知动作同样被拒（不靠枚举黑名单）', async () => {
  const { socket, ready, call } = connect()
  await ready
  try {
    for (const action of UNKNOWN_ACTIONS) {
      const frame = await call(action, { anything: true })
      assert.equal(frame.status, 'failed', JSON.stringify(action) + ' 也必须被拒')
      assert.equal(frame.data, null)
    }
  } finally {
    socket.close()
  }
})

test('T13：只读查询也不放行，绝不给"合成数据"留口子', async () => {
  const { socket, ready, call } = connect()
  await ready
  try {
    for (const action of ['get_login_info', 'get_status', 'get_group_list']) {
      const frame = await call(action)
      assert.equal(frame.status, 'failed', action + ' 尽管是纯查询也不放行——白名单会变成下一个洞')
      assert.equal(frame.data, null)
    }
  } finally {
    socket.close()
  }
})

test('每次越权尝试都被计数（判"本次运行未通过出站约束"的依据）', async () => {
  const before = server.stats.forbiddenActionAttempts
  const { socket, ready, call } = connect()
  await ready
  try {
    await call('send_group_msg', { group_id: 1, message: 'x' })
    await call('send_private_msg', { user_id: 1, message: 'x' })
  } finally {
    socket.close()
  }
  assert.equal(server.stats.forbiddenActionAttempts, before + 2)
  assert.equal(server.stats.lastForbidden.action, 'send_private_msg')
  assert.deepEqual(Object.keys(server.stats.lastForbidden.params), ['user_id', 'message'])
  assert.equal(server.stats.lastForbidden.params.message, 'string(1)', '记形状，不记正文')
})

test('错 Token 的握手被拒绝，且不会让它产生动作尝试', async () => {
  const bad = new WebSocket('ws://127.0.0.1:' + PORT + '/', { headers: { Authorization: 'Bearer wrong' } })
  const closed = await new Promise((resolve) => {
    bad.once('close', (code) => resolve(code))
    bad.once('error', () => resolve(-1))
    bad.once('open', () => setTimeout(() => resolve(-2), 1000))
  })
  assert.ok(closed !== -2, '错 Token 不该被接上')
  assert.ok(server.stats.rejectedHandshakes >= 1)
})

test('不带 Token 的握手被拒绝', async () => {
  const bad = new WebSocket('ws://127.0.0.1:' + PORT + '/')
  const closed = await new Promise((resolve) => {
    bad.once('close', (code) => resolve(code))
    bad.once('error', () => resolve(-1))
    bad.once('open', () => setTimeout(() => resolve(-2), 1000))
  })
  assert.ok(closed !== -2, '不带 Token 不该被接上')
})
