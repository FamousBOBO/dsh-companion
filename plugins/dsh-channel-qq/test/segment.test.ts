/** 分句发送（P6h）：规则层 + 在 `qq_send_text` 上的接线。
 *
 * 这段逻辑在 P4.6 被删过一次（当时确实没人调用它），P6h 把它作为出站阶段接回来。
 * 所以两条都要钉住：**规则本身**（逐字搬回，不许在搬的过程中走样）与**开关语义**
 * （关着 = 一条，打开 = 分条；默认关——P6 的规矩是"每项独立开关，默认关"）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { segmentText } = await import('../src/core/text/segment.js')
const { resolveConfig } = await import('../src/config.js')
const { createQQApi } = await import('../src/adapters/onebot/qq-api.js')
const { registerQQTools } = await import('../src/features/qq-tools/register.js')
const { fakeClient, fakeOut, toolRecorder } = await import('./fakes/host.js')

/** 生产默认的分段配置（**唯一来源**：`resolveConfig()`）。 */
const PROD_SEG = resolveConfig({ selfId: 1, admins: [], primaryGroup: 1, workspacePath: '/tmp/ws' }).segmentation

/** 只改分段那一段的配置（其余用默认层）。 */
function configWith(segmentation: Record<string, unknown>) {
  return resolveConfig({
    selfId: 1705, admins: [280], primaryGroup: 107, workspacePath: '/tmp/ws',
    // 分段节奏**不手写**：`PROD_SEG` 来自 `resolveConfig()`，保证跑的是生产默认。
    segmentation: {
      ...PROD_SEG,
      enabled: true, style: 'natural', minLength: 8, maxSegments: 8, removeTrailingPeriod: true,
      ...segmentation,
    },
  })
}

// ── 规则 ────────────────────────────────────────────────────────────────────

test('分句：开关关着 → 原样一条', () => {
  assert.deepEqual(segmentText('今天天气不错。要不要出去走走？', configWith({ enabled: false }).segmentation), [
    '今天天气不错。要不要出去走走？',
  ])
})

test('分句：没有句末标点 → 一条（不硬拆）', () => {
  assert.deepEqual(segmentText('今天天气不错啊', configWith({}).segmentation), ['今天天气不错啊'])
})

test('分句：按句末标点切，段末句号去掉', () => {
  assert.deepEqual(segmentText('先吃饭。然后写代码。最后早点睡。', configWith({}).segmentation), [
    '先吃饭', '然后写代码', '最后早点睡',
  ])
})

test('分句：连着的一串情绪标点跟在同一段尾巴上', () => {
  assert.deepEqual(segmentText('真的吗！！！这也太离谱了吧……', configWith({}).segmentation), [
    '真的吗！！！', '这也太离谱了吧……',
  ])
})

test('分句：受保护区域里不切——括号、引号书名、代码块', () => {
  assert.deepEqual(segmentText('他昨天说（其实是前天。我记错了）。', configWith({}).segmentation), [
    '他昨天说（其实是前天。我记错了）',
  ])
  assert.deepEqual(segmentText('那本书叫《活着。很好哭》。', configWith({}).segmentation), ['那本书叫《活着。很好哭》'])
  // 代码块里的点号不算句末（`1.5` 那个点不能切），而代码块与"看这段"之间本来
  // 就没有句末标点，所以它们是**同一段**——这正是想要的。
  assert.deepEqual(segmentText('```js\nconst a = 1.5\n```\n看这段。', configWith({}).segmentation), [
    '```js\nconst a = 1.5\n```\n看这段',
  ])
})

test('分句：conservative 把相邻短句粘起来，且**真的读 minLength**', () => {
  const text = '好。行。我们出发。'
  // 阈值 8：三条都短 → 第一条与第二条粘，第三条也短但上一段已经不短了
  assert.deepEqual(segmentText(text, configWith({ style: 'conservative', minLength: 8 }).segmentation), ['好，行，我们出发'])
  // 阈值 0：谁都不算"短"，一条不粘
  assert.deepEqual(segmentText(text, configWith({ style: 'conservative', minLength: 0 }).segmentation), ['好', '行', '我们出发'])
})

test('分句：natural / active 不合并', () => {
  assert.deepEqual(segmentText('好。行。', configWith({ style: 'active' }).segmentation), ['好', '行'])
  assert.deepEqual(segmentText('好。行。', configWith({ style: 'natural' }).segmentation), ['好', '行'])
})

test('分句：重复的句子只发一次，maxSegments 封顶', () => {
  assert.deepEqual(segmentText('走了。走了。', configWith({}).segmentation), ['走了'])
  const many = Array.from({ length: 20 }, (_, i) => `第${i}句。`).join('')
  assert.equal(segmentText(many, configWith({ maxSegments: 3 }).segmentation).length, 3)
})

test('分句：发之前先丢掉"不是话"的部分（思考块 / NO_REPLY / 字数提示）', () => {
  assert.deepEqual(segmentText('<思考>要不要说话</思考>我说两句。', configWith({}).segmentation), ['我说两句'])
  assert.deepEqual(segmentText('NO_REPLY', configWith({}).segmentation), [])
  assert.deepEqual(segmentText('好。（32字）', configWith({}).segmentation), ['好'])
})

// ── 接线：qq_send_text ──────────────────────────────────────────────────────

function sendText(overrides: Record<string, unknown>, text: string, isGroup = false) {
  const { ctx, definitions } = toolRecorder()
  const client = fakeClient({ get_group_list: [{ group_id: 107 }], get_group_info: { group_name: '主群' } })
  const api = createQQApi(client as never)
  const config = resolveConfig({
    selfId: 1705, admins: [280], primaryGroup: 107, workspacePath: '/tmp/ws', ...overrides,
  })
  const out = fakeOut()
  registerQQTools(ctx, config, api, out as never, () => {})
  const def = definitions.find((d) => d.name === 'qq_send_text')
  assert.ok(def, 'qq_send_text 必须存在')
  return {
    client,
    run: async (): Promise<Record<string, unknown>> => await (def!.execute as (a: unknown) => Promise<Record<string, unknown>>)(
      { isGroup, target: isGroup ? 107 : 280, text },
    ),
  }
}

test('群聊即使开启分段也只发送一条，超长拒绝且不外发', async () => {
  const text = '先吃饭。然后写代码。最后早点睡。'
  const h = sendText({ segmentation: { enabled: true } }, text, true)
  assert.equal((await h.run()).segments, 1)
  const calls = h.client.calls.filter(call => call.action === 'send_group_msg')
  assert.equal(calls.length, 1)
  assert.equal((calls[0]!.params.message as Array<{data:{text:string}}>)[0]!.data.text, text)
  const long = sendText({}, '字'.repeat(121), true)
  await assert.rejects(long.run, /120 字/)
  assert.equal(long.client.calls.some(call => call.action === 'send_group_msg'), false)
  const expanded = sendText({ segmentation: { groupMaxChars: 150 } }, '字'.repeat(121), true)
  assert.equal((await expanded.run()).segments, 1)
})

/** 等 `client.calls` 至少 N 条：PATCH-8 下**同步只发第一段**，其余段走进程级队列。 */
async function waitGroupSends(client: { calls: Array<{ action: string }> }, n: number, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  const count = (): number => client.calls.filter((c) => c.action === 'send_private_msg').length
  while (Date.now() < deadline) {
    if (count() >= n) return
    await new Promise((resolve) => { setTimeout(resolve, 25) })
  }
  throw new Error(`等了 ${String(timeoutMs)}ms 只发了 ${String(count())} 条（期望 ${String(n)}）`)
}

test('接线：默认关着 → 一条消息发出去（与从前逐字节一样）', async () => {
  const { client, run } = sendText({}, '先吃饭。然后写代码。最后早点睡。')
  const result = await run()
  const sends = client.calls.filter((c) => c.action === 'send_private_msg')
  assert.equal(sends.length, 1, '关着就是一条')
  assert.equal(result.segments, 1)
  const text = (sends[0]!.params.message as Array<{ data: { text: string } }>)[0]!.data.text
  assert.equal(text, '先吃饭。然后写代码。最后早点睡。', '关着时文本逐字节不变')
})

test('接线：打开之后 → 按句分成三条，逐条发', async () => {
  const { client, run } = sendText(
    { segmentation: { enabled: true, style: 'natural', minLength: 8, maxSegments: 8, removeTrailingPeriod: true } },
    '先吃饭。然后写代码。最后早点睡。',
  )
  const result = await run()
  // PATCH-8：同步只发第一段，其余两段走队列 ⇒ 等齐 3 条再断言。
  await waitGroupSends(client, 3)
  const sends = client.calls.filter((c) => c.action === 'send_private_msg')
  assert.equal(sends.length, 3)
  assert.equal(result.segments, 3)
  const texts = sends.map((s) => (s.params.message as Array<{ data: { text: string } }>)[0]!.data.text)
  assert.deepEqual(texts, ['先吃饭', '然后写代码', '最后早点睡'])
})

test('接线：分段之后仍然过硬切分（单条超过上限时再切）', async () => {
  const long = '啊'.repeat(120)
  const { client, run } = sendText(
    { maxMessageLength: 50, segmentation: { enabled: true, style: 'natural', minLength: 8, maxSegments: 8, removeTrailingPeriod: true } },
    `${long}。`,
  )
  await run()
  const sends = client.calls.filter((c) => c.action === 'send_private_msg')
  assert.ok(sends.length >= 3, `120 字 / 上限 50 → 至少 3 条，实际 ${sends.length}`)
  for (const send of sends) {
    const text = (send.params.message as Array<{ data: { text: string } }>)[0]!.data.text
    assert.ok(text.length <= 50, `每条都不许超上限：${text.length}`)
  }
})

test('标点转换：URL 与代码块必须原样（链接不能被全角化，也不能被切成两条）', () => {
  const text = '看 https://a.com/x?y=1,z=2 这个，还有 https://b.com 也不错。'
  const pieces = segmentText(text, { enabled: true, style: 'natural', minLength: 8, maxSegments: 3, removeTrailingPeriod: true })
  const joined = pieces.join('')
  assert.ok(joined.includes('https://a.com/x?y=1,z=2'), `URL 被改坏了：${joined}`)
  assert.ok(joined.includes('https://b.com'), '第二个 URL 也要原样')
  assert.equal(pieces.some((p) => p.includes('https：//')), false, '不许出现全角冒号的链接')

  const code = segmentText('跑 `npm run build?x=1,y=2` 试试。', { enabled: true, style: 'natural', minLength: 8, maxSegments: 3, removeTrailingPeriod: true })
  assert.ok(code.join('').includes('`npm run build?x=1,y=2`'), '行内代码原样')
})
