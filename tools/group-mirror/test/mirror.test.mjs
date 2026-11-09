/**
 * 镜像链路的离线测试。
 *
 * 全部在本机完成：**没有**一条真实 NapCat 连接、没有一个真实 QQ 动作。
 * 这些用例是计划 §4 的 T01–T14 里"完全离线就能跑"的那部分——先在假件上把
 * "拦得住"证明出来，再去接真实的 SSE。
 *
 * 跑法：node --test tools/group-mirror/test/
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { MirrorConfigError, normalizeMirrorConfig } from '../src/config.mjs'
import { admitEvent, REJECT, validateEvent } from '../src/event.mjs'
import { BoundedQueue, DedupeTable } from '../src/queue.mjs'
import { backoffMs, SseDecoder } from '../src/sse-client.mjs'
import { createMirror } from '../src/mirror.mjs'

const GROUP = 145326153
const OTHER_GROUP = 900000001
const SELF = 10000001

function groupEvent(over = {}) {
  return {
    post_type: 'message',
    message_type: 'group',
    time: 1_700_000_000,
    self_id: SELF,
    group_id: GROUP,
    user_id: 20_001,
    message_id: 5001,
    message: [{ type: 'text', data: { text: '晚上拍月亮老是糊' } }],
    raw_message: '晚上拍月亮老是糊',
    ...over,
  }
}

/* ── 配置校验：可疑配置一律拒绝启动 ───────────────────────────────── */

test('配置：空白名单 = 不转发任何群，而且默认关闭', () => {
  const config = normalizeMirrorConfig({ fakeOneBotTokenEnv: 'T' }, { T: 'token-a' })
  assert.deepEqual(config.allowedGroups, [])
  assert.equal(config.enabled, false, '默认必须是关闭的')
})

test('配置：假 WS 的 Token 不能与事件 Token 相同（测试侧不许持有真实令牌）', () => {
  assert.throws(
    () => normalizeMirrorConfig(
      { enabled: true, sourceUrl: 'http://127.0.0.1:3002/_events', sourceTokenEnv: 'S', fakeOneBotTokenEnv: 'F' },
      { S: 'same-token', F: 'same-token' },
    ),
    (error) => error instanceof MirrorConfigError && error.reason === 'shared-token',
  )
})

test('配置：假 WS 只能监听回环地址，0.0.0.0 直接拒绝', () => {
  assert.throws(
    () => normalizeMirrorConfig({ fakeOneBotHost: '0.0.0.0', fakeOneBotTokenEnv: 'F' }, { F: 't' }),
    (error) => error.reason === 'bad-host',
  )
})

test('配置：源地址必须是 http/https 的 SSE，ws:// 被拒绝（那是双向端口）', () => {
  assert.throws(
    () => normalizeMirrorConfig(
      { enabled: true, sourceUrl: 'ws://127.0.0.1:3001', sourceTokenEnv: 'S', fakeOneBotTokenEnv: 'F' },
      { S: 'a', F: 'b' },
    ),
    (error) => error.reason === 'bad-source',
  )
})

test('配置：群号必须是正整数，重复也不行', () => {
  assert.throws(() => normalizeMirrorConfig({ allowedGroups: ['x'], fakeOneBotTokenEnv: 'F' }, { F: 't' }), (e) => e.reason === 'bad-group')
  assert.throws(() => normalizeMirrorConfig({ allowedGroups: [1, 1], fakeOneBotTokenEnv: 'F' }, { F: 't' }), (e) => e.reason === 'duplicate-group')
})

/* ── 事件过滤：顺序即策略 ──────────────────────────────────────── */

test('过滤：白名单内的群消息通过，其它群一律不进', () => {
  const allowed = admitEvent(groupEvent(), { allowedGroups: [GROUP] })
  assert.equal(allowed.accepted, true)
  const other = admitEvent(groupEvent({ group_id: OTHER_GROUP }), { allowedGroups: [GROUP] })
  assert.equal(other.accepted, false)
  assert.equal(other.reason, REJECT.GROUP)
  const none = admitEvent(groupEvent(), { allowedGroups: [] })
  assert.equal(none.reason, REJECT.GROUP, '空白名单必须一条都不放行')
})

test('过滤：私聊 / 通知 / 心跳 / 好友申请都不进入镜像', () => {
  assert.equal(admitEvent(groupEvent({ message_type: 'private' }), { allowedGroups: [GROUP] }).reason, REJECT.TYPE)
  assert.equal(admitEvent({ post_type: 'notice', notice_type: 'group_recall', group_id: GROUP }, { allowedGroups: [GROUP] }).reason, REJECT.TYPE)
  assert.equal(admitEvent({ post_type: 'meta_event', meta_event_type: 'heartbeat' }, { allowedGroups: [GROUP] }).reason, REJECT.TYPE)
  assert.equal(admitEvent({ post_type: 'request', request_type: 'friend', user_id: 1 }, { allowedGroups: [GROUP] }).reason, REJECT.TYPE)
})

test('过滤：坏形状与超长正文被拒绝（不靠猜补字段）', () => {
  assert.equal(validateEvent('not an object').reason, REJECT.SHAPE)
  assert.equal(validateEvent({}).reason, REJECT.SHAPE)
  assert.equal(validateEvent({ post_type: 'message', message_type: 'group', group_id: 0 }).reason, REJECT.GROUP)
  assert.equal(validateEvent({ post_type: 'message', message_type: 'group', group_id: 'abc' }).reason, REJECT.GROUP)
  const huge = groupEvent({ message: [{ type: 'text', data: { text: 'x'.repeat(200_000) } }] })
  assert.equal(validateEvent(huge, { maxEventBytes: 1024 }).reason, REJECT.OVERSIZE)
})

test('过滤：自发消息仍然通过（当上下文），但带 self 标记', () => {
  const admitted = admitEvent(groupEvent({ user_id: SELF }), { allowedGroups: [GROUP] })
  assert.equal(admitted.accepted, true)
  assert.equal(admitted.event.self, true)
})

/* ── 去重与队列 ────────────────────────────────────────────────── */

test('去重：同一 group_id + message_id 只算一次，不同群同号互不影响', () => {
  const table = new DedupeTable({ ttlMs: 60_000, maxEntries: 10, now: () => 1000 })
  assert.equal(table.first(GROUP, 5001), true)
  assert.equal(table.first(GROUP, 5001), false, '重放的同一条消息不能再次触发判断')
  assert.equal(table.first(OTHER_GROUP, 5001), true, '不同群的同一个消息号是两条消息')
  assert.equal(table.first(GROUP, null), true, '没有消息号的事件不去重（没有可靠的键）')
})

test('去重：过期的记录会被清掉，表有上限', () => {
  let clock = 0
  const table = new DedupeTable({ ttlMs: 1000, maxEntries: 3, now: () => clock })
  table.first(GROUP, 1)
  clock = 2000
  assert.equal(table.first(GROUP, 1), true, 'TTL 到了之后同一个消息号应视为新事件')
  for (let i = 2; i < 20; i += 1) table.first(GROUP, i)
  assert.ok(table.size <= 3, '去重表必须有上限')
})

test('队列：超限丢最旧的未处理事件，并如实计数', () => {
  const queue = new BoundedQueue({ maxEntries: 3 })
  for (let i = 1; i <= 5; i += 1) queue.push(i)
  assert.equal(queue.size, 3)
  assert.equal(queue.dropped, 2)
  assert.deepEqual(queue.drain(), [3, 4, 5], '保留最新的三条')
  assert.equal(queue.size, 0)
})

/* ── SSE 解析 ──────────────────────────────────────────────────── */

test('SSE：帧被网络切断在任意位置都能拼回来', () => {
  const decoder = new SseDecoder()
  assert.deepEqual(decoder.push('data: {"a":1}\n\ndata: {"b"'), ['{"a":1}'])
  assert.deepEqual(decoder.push(':2}\n\n'), ['{"b":2}'])
  assert.deepEqual(decoder.push('data: {"c":3}\n\n'), ['{"c":3}'])
})

test('SSE：一直不给分隔符时缓冲区有上限，不会无限增长', () => {
  const decoder = new SseDecoder({ maxBufferChars: 100 })
  decoder.push('data: ' + 'x'.repeat(500))
  assert.equal(decoder.buffer, '', '超上限直接丢弃缓冲')
})

test('退避：指数增长并封顶，抖动不会越界', () => {
  const noJitter = () => 0.5
  assert.equal(backoffMs(0, { baseMs: 1000, maxMs: 60_000, random: noJitter }), 1000)
  assert.equal(backoffMs(3, { baseMs: 1000, maxMs: 60_000, random: noJitter }), 8000)
  assert.equal(backoffMs(20, { baseMs: 1000, maxMs: 60_000, random: noJitter }), 60_000)
  const low = backoffMs(3, { baseMs: 1000, maxMs: 60_000, random: () => 0 })
  const high = backoffMs(3, { baseMs: 1000, maxMs: 60_000, random: () => 1 })
  assert.ok(low >= 1 && high <= 60_000)
})

/* ── 整条装配（不连真实 NapCat）──────────────────────────────────── */

test('装配：白名单外的群不进队列、不进 WS、且不写正文', () => {
  const lines = []
  const mirror = createMirror({
    config: normalizeMirrorConfig(
      { enabled: false, allowedGroups: [GROUP], maxQueueEntries: 10, fakeOneBotTokenEnv: 'F' },
      { F: 'fake-token' },
    ),
    log: (line) => lines.push(line),
  })
  mirror.onFrame(JSON.stringify(groupEvent({ group_id: OTHER_GROUP })))
  mirror.onFrame(JSON.stringify(groupEvent()))
  mirror.onFrame(JSON.stringify(groupEvent()))
  assert.equal(mirror.stats.received, 3)
  assert.equal(mirror.stats.accepted, 2)
  assert.equal(mirror.stats.rejected.group, 1)
  assert.equal(mirror.stats.duplicates, 1, '同一条消息号第二次到应该被去重')
  assert.equal(mirror.stats.delivered, 0, '没有测试客户端连接时不该声称投递成功')
  const joined = lines.join('\n')
  assert.ok(!joined.includes('晚上拍月亮'), '日志里绝不能出现正文')
})
