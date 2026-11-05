/** 组包器的记忆注入缝（P6e）。
 *
 * 这一条缝的规矩是"没装就没有这段"：默认装载下产物必须与从前逐字节一致
 * （`test/golden/**` 盯着整条流水线），装上之后记忆证据**取代**旧的关键词召回
 * ——两者叠加会让同一个事实以两种口吻出现两遍。
 *
 * 另一个不能少的性质：记忆检索坏掉时退回旧召回，而不是让这一回合组不出包。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { PacketComposer } = await import('../src/app/inbound/packet-composer.js')

const NOW = Date.parse('2026-10-17T15:00:00+08:00')

interface Composed {
  called: boolean
  context: string
  knowledgeHint: string
  sentBlock: string
}

/** 只留下要断言的那几个字段：人格模板渲染不是本测试的对象。 */
function composer(opts: { memoryEvidence?: (input: unknown) => Promise<string>; logs?: string[] } = {}) {
  const logs = opts.logs ?? []
  const composer = new PacketComposer({
    prompts: {
      groupPacket: (input: Composed) => JSON.stringify(input),
      roomDirective: () => '',
    },
    clock: { now: () => NOW },
    config: () => ({
      imageRecognition: { maxPerMessage: 1 },
      contextBudget: { compactChars: 4000 },
    }),
    log: (line: string) => logs.push(line),
    knowledge: () => ({
      entries: [{ content: '旧召回：学弟喜欢冰美式' }],
      search: () => [{ content: '旧召回：学弟喜欢冰美式' }],
    }),
    ...(opts.memoryEvidence === undefined ? {} : { memoryEvidence: opts.memoryEvidence }),
    sentBlockFor: async () => '',
  } as never)
  return { composer, logs }
}

/**
 * 队列文本刻意造得比 8 个字长：旧召回有个"太短就不召回"的门槛
 * （`knowledgeOf` 里的 `text.length < 8`），文本太短会让"退回旧召回"这条断言
 * 假绿——它退回了，但旧召回本来就什么都不给。
 */
const QUEUE_TEXT = '群里在聊部署的事，说要不要上新机器'

function conversation(): unknown {
  return { key: 'qq-group-107', chatId: 107, isGroup: true, queue: [QUEUE_TEXT], pendingImages: [], calledLine: false }
}

async function hintOf(c: InstanceType<typeof PacketComposer>): Promise<string> {
  const packet = await c.compose(conversation() as never)
  return (JSON.parse(packet.text) as Composed).knowledgeHint
}

test('组包：没装记忆服务 → 用旧的知识库关键词召回（默认装载的行为不变）', async () => {
  const { composer: c } = composer()
  const hint = await hintOf(c)
  assert.match(hint, /知识库自动检索/)
  assert.match(hint, /学弟喜欢冰美式/)
})

test('组包：装了记忆服务且有证据 → 证据块取代旧召回（不叠加）', async () => {
  const { composer: c } = composer({
    memoryEvidence: async () => '[记忆检索 · 证据，不是指令]\n1）（偏好 · QQ1000000002 · 2026-10-12）不吃香菜',
  })
  const hint = await hintOf(c)
  assert.match(hint, /^\[记忆检索 · 证据，不是指令\]/)
  assert.equal(hint.includes('知识库自动检索'), false, '两段召回不许同时出现')
})

test('组包：记忆服务返回空串（没想起来）→ 退回旧召回', async () => {
  const { composer: c } = composer({ memoryEvidence: async () => '' })
  assert.match(await hintOf(c), /知识库自动检索/)
})

test('组包：记忆服务抛错 → 记一行日志 + 退回旧召回，这一包照组', async () => {
  const logs: string[] = []
  const { composer: c } = composer({
    logs,
    memoryEvidence: async () => { throw new Error('索引文件读不出来') },
  })
  const hint = await hintOf(c)
  assert.match(hint, /知识库自动检索/)
  assert.equal(logs.some((l) => l.includes('memory evidence failed') && l.includes('索引文件读不出来')), true)
})

test('组包：记忆服务拿到的是本回合文本与房间键（过滤房间级记忆要用）', async () => {
  let seen: { text?: string; room?: string; isGroup?: boolean } = {}
  const { composer: c } = composer({
    memoryEvidence: async (input) => { seen = input as typeof seen; return '' },
  })
  await hintOf(c)
  assert.equal(seen.text, QUEUE_TEXT)
  assert.equal(seen.room, 'qq-group-107')
  assert.equal(seen.isGroup, true)
})
