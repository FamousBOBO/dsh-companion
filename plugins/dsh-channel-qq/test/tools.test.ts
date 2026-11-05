/** 工具面的行为测试：发送前的三道闸门、历史日志解析。
 *
 * P4 把 57 个工具从一个大函数拆成 `features/<功能>/tools.ts`，每个工具一个函数。
 * 这一步的判据是"工具名与参数 schema 一条都不许变"（`golden/tools/qq-tools.txt`），
 * 但**闸门的语义**不在 schema 里——它们只在 `run` 里。所以这里补上：
 * 用真的工具面配假平台，逐个触发那些拦人的分支。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { registerQQTools } = await import('../src/features/qq-tools/register.js')
const { resolveConfig } = await import('../src/config.js')
const { createQQApi } = await import('../src/adapters/onebot/qq-api.js')
const { fakeClient, fakeOut, toolRecorder } = await import('./fakes/host.js')

const SELF = 1705
const GROUP = 107
const MASTER = 280
const STRANGER = 999

interface ToolCall {
  (args: Record<string, unknown>): Promise<unknown>
}

/** 只取一个工具的执行函数。 */
function only(responses: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}): {
  run: ToolCall
  calls: Array<{ action: string; params: Record<string, unknown> }>
  logs: string[]
} {
  const { ctx, definitions } = toolRecorder()
  const client = fakeClient(responses)
  const api = createQQApi(client as never)
  const logs: string[] = []
  const config = resolveConfig({
    selfId: SELF, admins: [MASTER], primaryGroup: GROUP, workspacePath: '/tmp/ws',
    groupAdmin: { dangerous: false },
    ...overrides,
  })
  registerQQTools(ctx, config, api, fakeOut() as never, (line: string) => { logs.push(line) })
  return {
    calls: client.calls,
    logs,
    run: async (args) => {
      const name = String(args.__tool)
      const def = definitions.find((d) => d.name === name)
      assert.ok(def, `工具 ${name} 不存在`)
      const { __tool, ...rest } = args
      return await (def!.execute as (a: unknown) => Promise<unknown>)(rest)
    },
  }
}

// ── 发送闸门 ────────────────────────────────────────────────────────────────

test('qq_send_text：目标群不是咱加入的群 → 拦下（且没有真的发送）', async () => {
  const t = only({ get_group_list: [], get_group_info: { group_name: '某群' } })
  await assert.rejects(
    () => t.run({ __tool: 'qq_send_text', isGroup: true, target: 555, text: '在吗' }),
    /不是咱加入的群/,
  )
  assert.equal(t.calls.some((c) => c.action === 'send_group_msg'), false, '拦下之后不许再发')
})

test('qq_send_text：窗口验证失败（群查不到）→ 拦下', async () => {
  const t = only({ get_group_list: [{ group_id: 555 }], get_group_info: null })
  await assert.rejects(
    () => t.run({ __tool: 'qq_send_text', isGroup: true, target: 555, text: '在吗' }),
    /窗口验证失败/,
  )
})

test('qq_send_text：群里发代码 → 拦下并指路 qq_send_code_review', async () => {
  const t = only({ get_group_list: [{ group_id: GROUP }], get_group_info: { group_name: '主群' } })
  await assert.rejects(
    () => t.run({ __tool: 'qq_send_text', isGroup: true, target: GROUP, text: '```js\nconst a = 1\n```' }),
    /群聊禁止发代码/,
  )
})

test('qq_send_text：内心戏外泄 → 拦下并记一行日志', async () => {
  const t = only({ get_group_list: [{ group_id: GROUP }], get_group_info: { group_name: '主群' } })
  await assert.rejects(
    () => t.run({ __tool: 'qq_send_text', isGroup: true, target: GROUP, text: '本轮先不说话。' }),
    /内部盘算/,
  )
  assert.equal(t.logs.some((l) => l.includes('blocked inner-monologue leak')), true)
})

test('qq_send_text：私聊陌生人 → 拦下', async () => {
  const t = only({ get_friend_list: [{ user_id: STRANGER, nickname: '路人' }] })
  await assert.rejects(
    () => t.run({ __tool: 'qq_send_text', isGroup: false, target: STRANGER, text: '你好' }),
    /不是管理员/,
  )
})

test('qq_send_text：给学弟私聊发代码是允许的（禁令只针对群）', async () => {
  const t = only({ get_friend_list: [{ user_id: MASTER, nickname: '学弟' }] })
  const result = await t.run({ __tool: 'qq_send_text', isGroup: false, target: MASTER, text: '```js\nconst a = 1\n```' })
  assert.ok(result !== undefined)
  assert.equal(t.calls.some((c) => c.action === 'send_private_msg'), true, '私聊照发')
})

test('qq_send_text：正常群消息发得出去', async () => {
  const t = only({ get_group_list: [{ group_id: GROUP }], get_group_info: { group_name: '主群' } })
  await t.run({ __tool: 'qq_send_text', isGroup: true, target: GROUP, text: '好呀' })
  const sent = t.calls.find((c) => c.action === 'send_group_msg')
  assert.ok(sent, '应当调用 send_group_msg')
  assert.equal(sent!.params.group_id, GROUP)
})

test('qq_send_text：只有思考没有正文 → 拦下', async () => {
  const t = only({ get_group_list: [{ group_id: GROUP }], get_group_info: { group_name: '主群' } })
  await assert.rejects(
    () => t.run({ __tool: 'qq_send_text', isGroup: true, target: GROUP, text: '<思考>要不要说话</思考>' }),
    /消息文本为空/,
  )
})

// ── 高危群管总闸门 ──────────────────────────────────────────────────────────

test('高危群管：默认关闭时踢人 / 全员禁言 / 设管理员全部拦下', async () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['qq_group_kick', { groupId: GROUP, userId: STRANGER }],
    ['qq_group_whole_ban', { groupId: GROUP, enable: true }],
    ['qq_set_group_admin', { groupId: GROUP, userId: STRANGER, enable: true }],
  ]
  for (const [tool, args] of cases) {
    const t = only()
    await assert.rejects(
      () => t.run({ __tool: tool, ...args }),
      /groupAdmin\.dangerous=false/,
      `${tool} 默认必须被拦下`,
    )
  }
})

test('高危群管：打开开关之后放行（命令确实发出去了）', async () => {
  const t = only({}, { groupAdmin: { dangerous: true } })
  await t.run({ __tool: 'qq_group_kick', groupId: GROUP, userId: STRANGER })
  assert.equal(t.calls.some((c) => c.action === 'set_group_kick'), true)
})

// ── 历史日志解析 ────────────────────────────────────────────────────────────

test('qq_search_history：入站行还原发送者，非聊天行被丢掉', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const os = await import('node:os')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-'))
  const root = path.join(dir, 'sessions', '--tmp-ws--', 'qq-group-107')
  fs.mkdirSync(root, { recursive: true })
  const lines = [
    JSON.stringify({ type: 'user/message', time: Date.parse('2026-10-16T14:31:00+08:00'), seq: 1, data: { messageId: 42, content: [{ type: 'text', text: '14:31 群友甲(1086) #42：铃铃这个怎么修' }] } }),
    JSON.stringify({ type: 'user/message', time: Date.parse('2026-10-16T14:32:00+08:00'), seq: 2, data: { messageId: 43, content: [{ type: 'text', text: '【主动巡逻】看看群里在聊什么' }] } }),
    JSON.stringify({ type: 'assistant/message', time: Date.parse('2026-10-16T14:33:00+08:00'), seq: 3, data: {} }),
  ].join('\n')
  fs.writeFileSync(path.join(root, 'session.v4.jsonl'), lines)

  const previous = process.env.DSH_SESSIONS_ROOT
  process.env.DSH_SESSIONS_ROOT = path.join(dir, 'sessions')
  try {
    const t = only({})
    const result = await t.run({ __tool: 'qq_search_history', isGroup: true, target: GROUP }) as {
      count: number
      hits: Array<{ sender: string; userId: number; text: string }>
    }
    assert.equal(result.count, 1, '定时任务注入的行不是聊天，不许出现')
    assert.equal(result.hits[0]?.userId, 1086)
    assert.equal(result.hits[0]?.sender, '群友甲')
    assert.equal(result.hits[0]?.text, '铃铃这个怎么修')
  } finally {
    process.env.DSH_SESSIONS_ROOT = previous
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
