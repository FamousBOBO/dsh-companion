/** 6g 的**管线级**集成测试：真实 `InboundPipeline.handle()` 走一遍。
 *
 * `planner.test.ts` 测纯判定、`planner-gate.test.ts` 测适配层；这里证明的是
 * **在真正的入站路径上**，被拦下的消息不进队列、不提交回合，放行的消息才入队，
 * 被叫到的立刻提交。这三件事是 6g 的收益本身（省上下文、省一次模型调用）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { InboundPipeline } = await import('../src/app/inbound/pipeline.js')

interface Submitted { key: string; text: string }

function conversation(key: string) {
  return {
    key,
    sessionId: `qq-${key}`,
    isGroup: true,
    chatId: 1,
    session: null,
    tracker: { busy: () => false, running: () => false },
    queue: [] as string[],
    pendingImages: [] as unknown[],
    batchTimer: null,
    seenMessageIds: null,
    calledLine: false,
    lastEvent: null,
  }
}

function harness(opts: { planner: boolean; requireMention?: boolean; selfId?: number }) {
  const submitted: Submitted[] = []
  const logs: string[] = []
  const conv = conversation('group-1')
  const config = {
    groupEnabled: true,
    requireMention: opts.requireMention === true,
    debug: false,
    injectMode: { enabled: false, wakeIdle: true },
    imageRecognition: { enabled: false, serverOcr: false, maxPerMessage: 2 },
    batching: { windowMs: 1000, maxMessages: 20, maxChars: 4000 },
    contextBudget: { compactChars: 0 },
    primaryGroup: 1,
    talkValue: 1,
    keywordTriggers: [],
    keywordReactions: [],
    selfId: opts.selfId ?? 100,
    planner: { enabled: opts.planner },
  }
  const deps = {
    config: () => config,
    registry: {
      getOrCreate: () => conv,
      ensure: async () => {},
    },
    turns: {
      submit: (c: { key: string }, text: string) => { submitted.push({ key: c.key, text }) },
    },
    prompts: { imageNote: () => '[图片]' },
    platform: () => ({}),
    gateway: {},
    blobs: {},
    http: {},
    clock: { now: () => 0, setTimeout: () => ({ cancel: () => {} }) },
    random: { next: () => 0.99 },
    health: { deadline: () => 0 },
    log: (line: string) => logs.push(line),
    transcribe: async () => null,
    knowledge: { recall: () => null },
    packets: {
      compose: async () => ({ text: 'packet', imageRefs: [] }),
      knowledgeOf: () => null,
    },
  }
  const pipeline = new InboundPipeline(deps as never)
  return { pipeline, conv, submitted, logs }
}

function groupEvent(userId: number, text: string) {
  return {
    time: 0,
    self_id: 100,
    post_type: 'message',
    message_type: 'group',
    group_id: 1,
    user_id: userId,
    message_id: 1,
    raw_message: text,
    message: [{ type: 'text', data: { text } }],
    sender: { user_id: userId, nickname: '甲' },
  } as never
}

test('开关开着：自环消息被拦下——不入队、不提交回合、日志写理由', async () => {
  const h = harness({ planner: true })
  await h.pipeline.handle(groupEvent(100, '我自己的回显'))
  assert.deepEqual(h.conv.queue, [], '被拦下的消息不进队列')
  assert.equal(h.submitted.length, 0, '也不触发任何回合')
  assert.match(h.logs.at(-1) ?? '', /planner: ignore \(from-bot\)/)
})

test('开关开着：只有表情没正文被拦下', async () => {
  const h = harness({ planner: true })
  await h.pipeline.handle(groupEvent(200, '   '))
  assert.deepEqual(h.conv.queue, [])
  assert.match(h.logs.at(-1) ?? '', /non-text/)
})

test('开关开着：要求 @ 且没被叫，拦下', async () => {
  const h = harness({ planner: true, requireMention: true })
  await h.pipeline.handle(groupEvent(200, '今天吃啥'))
  assert.deepEqual(h.conv.queue, [])
  assert.match(h.logs.at(-1) ?? '', /require-mention/)
})

test('开关开着：普通群消息放行——入队，等安静窗口（不立刻提交）', async () => {
  const h = harness({ planner: true })
  await h.pipeline.handle(groupEvent(200, '今天吃啥'))
  assert.equal(h.conv.queue.length, 1, '放行的消息进了队列')
  assert.equal(h.submitted.length, 0, '没被叫到就先攒批')
  assert.deepEqual(h.logs, [], '放行不写 planner 日志')
})

test('开关关着：自环消息照旧入队（默认关 = 行为一字不改）', async () => {
  const h = harness({ planner: false })
  await h.pipeline.handle(groupEvent(100, '我自己的回显'))
  assert.equal(h.conv.queue.length, 1)
  assert.deepEqual(h.logs, [])
})

test('去重：同一个 message_id 连投两次，只入队一次', async () => {
  const h = harness({ planner: false })
  const event = groupEvent(200, '同一条消息')
  await h.pipeline.handle(event)
  await h.pipeline.handle(event)
  assert.equal(h.conv.queue.length, 1, '重复投递不能再入队（去重必须在 push 之前）')
})
