/** 服务端历史（A4）：归一化、去重/上限、节流、检索回源、开关语义。
 *
 * 防的是"重启即失忆"和"每问一句就打一次协议端"：本地没有日志时才回源，
 * 同一房间 60 秒只拉一次；开关关着时一个请求都不发。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

const { normalizeHistoryMessage } = await import('../src/features/history/normalize.js')
const { HistoryStore, MAX_HISTORY_ENTRIES } = await import('../src/features/history/store.js')
const { HistoryService } = await import('../src/features/history/service.js')
const { registerQQTools } = await import('../src/features/qq-tools/register.js')
const { resolveConfig } = await import('../src/config.js')
const { createQQApi } = await import('../src/adapters/onebot/qq-api.js')
const { fakeClient, fakeOut, toolRecorder } = await import('./fakes/host.js')

const GROUP = 107
const MASTER = 280

const rawMessage = (id: number, text: string, userId = 555, time = 1_790_000_000) => ({
  message_id: id,
  time,
  user_id: userId,
  sender: { user_id: userId, nickname: '群友', card: '卡片名' },
  message: [{ type: 'text', data: { text } }],
})

test('历史归一化：文本拼接、卡片名优先、缺 id 丢弃、raw_message 兜底', () => {
  assert.deepEqual(normalizeHistoryMessage(rawMessage(1, '你好')), {
    id: 1, time: 1_790_000_000, userId: 555, name: '卡片名', text: '你好',
  })
  assert.equal(normalizeHistoryMessage({ raw_message: '没有 id' }), null)
  assert.equal(normalizeHistoryMessage({ message_id: 2, raw_message: '[CQ:image,file=x] 图后的字' })?.text, '图后的字')
  assert.equal(normalizeHistoryMessage({ message_id: 3, message: [{ type: 'image', data: {} }] })?.text, '[图片]')
})

test('历史仓库：去重、按时间排序、超过上限丢最旧', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hist-'))
  try {
    const store = new HistoryStore(dir, () => {})
    assert.equal(await store.merge('group-1', [normalizeHistoryMessage(rawMessage(1, 'a', 1, 30))!]), 1)
    assert.equal(await store.merge('group-1', [normalizeHistoryMessage(rawMessage(1, 'a', 1, 30))!]), 0, '重复不新增')
    await store.merge('group-1', [normalizeHistoryMessage(rawMessage(2, 'b', 1, 10))!])
    assert.deepEqual((await store.list('group-1')).map((e) => e.id), [2, 1], '按时间升序')
    const many = Array.from({ length: MAX_HISTORY_ENTRIES + 5 }, (_, i) => normalizeHistoryMessage(rawMessage(1000 + i, `x${i}`, 2, 100 + i))!)
    await store.merge('group-1', many)
    assert.equal((await store.list('group-1')).length, MAX_HISTORY_ENTRIES)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('历史服务：开关关着不回源；打开后节流；检索按条件过滤', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hist-'))
  try {
    let enabled = false
    let calls = 0
    let now = 1_000_000
    const store = new HistoryStore(dir, () => {})
    const service = new HistoryService({
      api: () => ({
        getGroupMsgHistory: async () => {
          calls += 1
          return { messages: [rawMessage(1, 'hello 世界', 555, 1_790_000_000)] }
        },
      }) as never,
      config: () => ({ serverBackfill: enabled, maxMessages: 50 }),
      store,
      now: () => now,
      log: () => {},
    })
    assert.equal(await service.sync('group-1', true, GROUP), 0)
    assert.equal(calls, 0)
    enabled = true
    assert.equal(await service.sync('group-1', true, GROUP), 1)
    assert.equal(calls, 1)
    assert.equal(await service.sync('group-1', true, GROUP), 0, '60 秒内不重复拉')
    assert.equal(calls, 1)
    now += 61_000
    await service.sync('group-1', true, GROUP)
    assert.equal(calls, 2)
    assert.equal((await service.search('group-1', { keyword: '世界' })).length, 1)
    assert.equal((await service.search('group-1', { keyword: '不存在' })).length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('qq_search_history：本地没有日志时回源服务端，返回 source=server', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hist-'))
  try {
    const { ctx, definitions } = toolRecorder()
    const client = fakeClient({
      get_group_list: [{ group_id: GROUP }],
      get_group_info: { group_name: '主群' },
      get_group_msg_history: { messages: [rawMessage(9, '旧消息 hello', 555)] },
    })
    const api = createQQApi(client as never)
    const store = new HistoryStore(dir, () => {})
    const history = new HistoryService({
      api: () => api,
      config: () => ({ serverBackfill: true, maxMessages: 20 }),
      store,
      now: () => 1_000_000,
      log: () => {},
    })
    const config = resolveConfig({
      selfId: 1, admins: [MASTER], primaryGroup: GROUP,
      workspacePath: path.join(dir, 'ws'),
      history: { serverBackfill: true, maxMessages: 20 },
    })
    registerQQTools(ctx, config, api, fakeOut() as never, () => {}, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, history)
    const def = definitions.find((d) => d.name === 'qq_search_history')
    assert.ok(def)
    const result = await (def!.execute as (a: unknown) => Promise<unknown>)({ isGroup: true, target: GROUP, keyword: 'hello' })
    assert.equal((result as { source: string }).source, 'server')
    assert.equal((result as { hits: Array<{ text: string }> }).hits[0]!.text, '旧消息 hello')
    assert.equal(client.calls.some((c) => c.action === 'get_group_msg_history'), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
