/** 合并转发（A3）：开关语义、节点内容、超限/失败回退。
 *
 * 这条测试防的是"卡片吞内容"：开关关着必须逐条发；打开后只有条数在
 * [阈值, maxNodes] 且没有单条超长时才改发卡片；转发失败必须回退逐条发。
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

// 分段节奏**不手写**：从 `resolveConfig()` 拿生产默认（60/200/3000）。
// 手写过一次 24/400/1200，于是"long sentence waits only 1.5 seconds"这类时间敏感用例全红。
const PROD_SEG = resolveConfig({ selfId: 1, admins: [], primaryGroup: 1, workspacePath: '/tmp/ws' }).segmentation
const SEG = {
  ...PROD_SEG,
  enabled: true, style: 'active' as const, minLength: 8, maxSegments: 8, removeTrailingPeriod: true,
}
const TEXT = '第一句。第二句。第三句。'

function harness(opts: {
  forward: { longReplyThreshold: number; maxNodes: number }
  responses?: Record<string, unknown>
  failForward?: boolean
}) {
  const { ctx, definitions } = toolRecorder()
  const client = fakeClient(opts.responses)
  const api = createQQApi(client as never)
  const target = opts.failForward === true
    ? {
        ...api,
        sendGroupForward: async () => { throw new Error('forward rejected') },
        sendPrivateForward: async () => { throw new Error('forward rejected') },
      }
    : api
  const logs: string[] = []
  const out = fakeOut()
  const config = resolveConfig({
    selfId: SELF, admins: [MASTER], primaryGroup: GROUP, workspacePath: '/tmp/ws',
    segmentation: SEG, forward: opts.forward,
  })
  registerQQTools(ctx, config, target as never, out as never, (line: string) => { logs.push(line) })
  return {
    calls: client.calls,
    client,
    out,
    logs,
    async run(args: Record<string, unknown>) {
      const def = definitions.find((d) => d.name === 'qq_send_text')
      assert.ok(def)
      return await (def!.execute as (a: unknown) => Promise<unknown>)(args)
    },
  }
}

// PATCH-8：同步只发第一段，其余段交给进程级队列 ⇒ 断言前必须让后台那一段跑完。
// PATCH-8：同步只发第一段，其余段按 PATCH-5 的节奏（200ms~3s 停顿）后台补发。
// 轮询到条件成立或超时：正常情况 ~200ms 返回，慢机器不会假红，失败时直接报"等到几条"。
async function waitForCalls(h: { calls: Array<{ action: string }> }, n: number, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  const count = (): number => h.calls.filter((c) => c.action === 'send_private_msg').length
  while (Date.now() < deadline) {
    if (count() >= n) return
    await new Promise((resolve) => { setTimeout(resolve, 50) })
  }
  throw new Error(`等了 ms 只发了  条（期望 ）`)
}

const OK = { get_group_list: [{ group_id: GROUP }], get_group_info: { group_name: '主群' }, get_login_info: { user_id: SELF, nickname: 'bot' } }
const DIRECT = 'send_private_msg'

test('合并转发：开关关着 → 逐条发送，没有转发动作', async () => {
  const h = harness({ forward: { longReplyThreshold: 0, maxNodes: 20 }, responses: OK })
  await h.run({ isGroup: false, target: MASTER, text: TEXT })
  const syncCount = h.calls.filter((c) => c.action === DIRECT).length
  await waitForCalls(h, 3)
  assert.equal(syncCount, 1, 'PATCH-8：同步只发第一段')
  assert.equal(h.calls.filter((c) => c.action === DIRECT).length, 3, '排空后三段都发出去（后台补发其余两段）')
  assert.equal(h.calls.some((c) => c.action === 'send_private_forward_msg'), false)
  assert.equal(h.calls.some((c) => c.action === 'get_login_info'), false)
})

test('合并转发：达到阈值 → 一条卡片，节点带机器人昵称与各段正文', async () => {
  const h = harness({ forward: { longReplyThreshold: 3, maxNodes: 20 }, responses: OK })
  const result = await h.run({ isGroup: false, target: MASTER, text: TEXT })
  assert.equal(h.calls.some((c) => c.action === DIRECT), false, '不该再逐条发')
  const forward = h.calls.find((c) => c.action === 'send_private_forward_msg')
  assert.ok(forward)
  const nodes = forward!.params.messages as Array<{ type: string; data: { nickname: string; content: Array<{ data: { text: string } }> } }>
  assert.equal(nodes.length, 3)
  assert.equal(nodes[0]!.data.nickname, 'bot')
  assert.equal(nodes[2]!.data.content[0]!.data.text, '第三句')
  assert.equal((result as { forwarded?: boolean }).forwarded, true)
})

test('合并转发：条数低于阈值 → 仍逐条发送', async () => {
  const h = harness({ forward: { longReplyThreshold: 4, maxNodes: 20 }, responses: OK })
  await h.run({ isGroup: false, target: MASTER, text: TEXT })
  const syncCount = h.calls.filter((c) => c.action === DIRECT).length
  await waitForCalls(h, 3)
  assert.equal(syncCount, 1, 'PATCH-8：同步只发第一段')
  assert.equal(h.calls.filter((c) => c.action === DIRECT).length, 3, '排空后三段都发出去（后台补发其余两段）')
  assert.equal(h.calls.some((c) => c.action === 'send_private_forward_msg'), false)
})

test('合并转发：条数超过 maxNodes → 回退逐条（不截断）', async () => {
  const h = harness({ forward: { longReplyThreshold: 2, maxNodes: 2 }, responses: OK })
  await h.run({ isGroup: false, target: MASTER, text: TEXT })
  const syncCount = h.calls.filter((c) => c.action === DIRECT).length
  await waitForCalls(h, 3)
  assert.equal(syncCount, 1, 'PATCH-8：同步只发第一段')
  assert.equal(h.calls.filter((c) => c.action === DIRECT).length, 3, '排空后三段都发出去（后台补发其余两段）')
  assert.equal(h.calls.some((c) => c.action === 'send_private_forward_msg'), false)
})

test('合并转发：转发失败 → 回退逐条，内容不丢', async () => {
  const h = harness({ forward: { longReplyThreshold: 2, maxNodes: 20 }, responses: OK, failForward: true })
  await h.run({ isGroup: false, target: MASTER, text: TEXT })
  const syncCount = h.calls.filter((c) => c.action === DIRECT).length
  await waitForCalls(h, 3)
  assert.equal(syncCount, 1, 'PATCH-8：同步只发第一段')
  assert.equal(h.calls.filter((c) => c.action === DIRECT).length, 3, '排空后三段都发出去（后台补发其余两段）')
  assert.equal(h.logs.some((l) => l.includes('forward failed')), true)
})

test('合并转发：私聊走 send_private_forward_msg', async () => {
  const h = harness({
    forward: { longReplyThreshold: 2, maxNodes: 20 },
    responses: { ...OK, get_friend_list: [{ user_id: MASTER }] },
  })
  await h.run({ isGroup: false, target: MASTER, text: '第一句。第二句。' })
  assert.equal(h.calls.some((c) => c.action === 'send_private_forward_msg'), true)
})

// ── PATCH-8 契约守卫：队列必须排空 + 一段都不许丢 ─────────────────────────────
// 动机：forward/dm-buffer/interaction 共 13 条测试都隐含依赖"后台段最终会发"，
// 但此前**没有任何一条**断言这件事。异步化那次改动因此没有测试红。

test('PATCH-8 契约：提交 3 段后队列最终排空、3 段全部到达', async () => {
  const h = harness({ forward: { longReplyThreshold: 0, maxNodes: 20 }, responses: OK })
  await h.run({ isGroup: false, target: MASTER, text: TEXT })

  // 同步只发第一段（PATCH-8 的承诺）。
  assert.equal(h.calls.filter((c) => c.action === DIRECT).length, 1, '同步只发第一段')
  // 后台必须把其余段补齐。
  await waitForCalls(h, 3)
  assert.equal(h.calls.filter((c) => c.action === DIRECT).length, 3, '3 段全部到达，一段都不许丢')
  // akeOut().calls 是**入队记录**（不是待办队列）⇒ 3 表示三段都真的进了进程级队列，
  // 而不是同步发一段、另外两段就地丢掉。
  assert.equal(h.out.calls.length, 3, '三段都必须进队列（不许就地丢弃）')
  assert.equal(h.out.pending(), 0, '队列必须排空，不许留残余任务')
})

// ── PATCH-8 契约（失败路径）：尾段抛错也必须释放队列计数 ──────────────────────
// 成功路径总会被跑到；**失败路径才是泄漏来源**。tools.ts:148 写着"尾段失败只记日志"，
// 所以这里专测"失败一次，计数照样回到 0"。

test('PATCH-8 契约：尾段失败也必须释放队列计数（不许泄漏）', async () => {
  const h = harness({ forward: { longReplyThreshold: 0, maxNodes: 20 }, responses: OK, failForward: false })
  // 让第二段发送抛错：把发消息动作换成"第二次调用时抛"。
  let sends = 0
  const original = h.client.call.bind(h.client)
  h.client.call = async (action: string, params?: Record<string, unknown>) => {
    if (action === DIRECT) {
      sends += 1
      if (sends === 2) throw new Error('tail segment boom')
    }
    return await original(action, params)
  }
  try {
    await h.run({ isGroup: false, target: MASTER, text: TEXT })
  } catch {
    // 尾段失败不该把 run 整体炸掉；若炸了也继续断言计数。
  }
  await new Promise((resolve) => { setTimeout(resolve, 300) })
  assert.equal(h.out.pending(), 0, '失败也必须释放计数，否则队列永久泄漏')
})
