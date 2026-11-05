/** 入站旁路观察的测试。
 *
 * 这四个观察（风控 / 口癖 / 链接卡片 / 偷表情包）原来内联在 `index.ts` 里，
 * 而 `index.ts` 是组合根——测试根本够不着它。搬进 `features/observers` 之后，
 * 依赖全是取值函数，于是这里可以用几个假件把"什么时候该做、什么时候不该做"
 * 逐条钉住；这恰恰是最容易漏的部分：它们没有返回值，出问题只表现为"群里没反应"。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { InboundObservers } = await import('../src/features/observers/inbound.js')
const { resolveConfig } = await import('../src/config.js')
type OneBotEvent = import('../src/types.js').OneBotEvent

const GROUP = 1000000003
const OTHER_GROUP = 999
const STICKER = 12345
const SENDER = 555

interface Recorder {
  learned: Array<{ text: string; userId: number; groupId: number }>
  flooded: unknown[]
  stolen: number
  tagged: number
}

/** 造一组能记账的假件；`over` 用来逐条关掉某个观察。 */
function harness(over: Record<string, unknown> = {}): { observers: InstanceType<typeof InboundObservers>; seen: Recorder } {
  const seen: Recorder = { learned: [], flooded: [], stolen: 0, tagged: 0 }
  const config = resolveConfig({
    primaryGroup: GROUP,
    workspacePath: '/tmp/ws',
    ...over,
  })
  const out = { async push<T>(fn: () => Promise<T>): Promise<T> { return await fn() } }
  const api = { sendTo: async () => ({ ok: true }) }
  const observers = new InboundObservers({
    config: () => config,
    log: () => {},
    platform: () => ({ api, selfId: 10000, isConnected: () => true }) as never,
    out: () => out as never,
    flood: () => ({ observe: (input: unknown) => { seen.flooded.push(input); return null } }) as never,
    learn: () => ({ observe: (input: { text: string; userId: number; groupId: number }) => { seen.learned.push(input) } }) as never,
    emoji: () => ({ steal: async () => { seen.stolen += 1; return { md5: 'x' } } }) as never,
    library: () => ({ async tagEntry() { seen.tagged += 1 }, async save() {} }) as never,
    // 观察者不该碰网络：真去取图就抛出，测试会立刻失败。
    http: { request: async () => { throw new Error('观察者不该发起请求') } } as never,
    // 宿主上下文在测试里只是一个占位（R7 只约束 src/，测试允许转型）。
    tagContext: () => ({} as never),
  })
  return { observers, seen }
}

function groupMessage(segments: unknown[]): OneBotEvent {
  return {
    time: 1, self_id: 10000, post_type: 'message', message_type: 'group',
    group_id: GROUP, user_id: SENDER, message_id: 1, message: segments,
  } as OneBotEvent
}

const text = (t: string): unknown => ({ type: 'text', data: { text: t } })

test('观察者：正常群消息会被口癖学习与风控各看一次', () => {
  const { observers, seen } = harness()
  observers.observe(groupMessage([text('今天天气不错')]))
  assert.deepEqual(seen.learned, [{ text: '今天天气不错', userId: SENDER, groupId: GROUP }])
  assert.equal(seen.flooded.length, 1)
})

test('观察者：只用纯文字，占位符不进口癖库也不进风控', () => {
  const { observers, seen } = harness()
  // 只有一张没有配文的图：`text` 会是 `[图片]`，`plainText` 是空的。
  observers.observe(groupMessage([{ type: 'image', data: { url: 'https://x/y.png' } }]))
  assert.deepEqual(seen.learned, [], '没有配文的图不是内容')
  assert.deepEqual(seen.flooded, [])
})

test('观察者：口癖学习关掉（或被设置关掉）就不收集', () => {
  const a = harness({ learn: { enabled: false, autoCapture: true } })
  a.observers.observe(groupMessage([text('喂')]))
  assert.deepEqual(a.seen.learned, [], 'enabled=false 不收集')

  const b = harness({ learn: { enabled: true, autoCapture: false } })
  b.observers.observe(groupMessage([text('喂')]))
  assert.deepEqual(b.seen.learned, [], 'autoCapture=false 不被动收集')
  assert.equal(b.seen.flooded.length, 1, '风控不受它影响')
})

test('观察者：群开关关掉时整段不做', () => {
  const { observers, seen } = harness({ groupEnabled: false })
  observers.observe(groupMessage([text('喂')]))
  assert.deepEqual(seen.learned, [])
  assert.deepEqual(seen.flooded, [])
  assert.equal(seen.stolen, 0)
})

test('观察者：偷表情包只在主群、只在关掉开关前发生', () => {
  const main = harness()
  main.observers.observe(groupMessage([{ type: 'image', data: { url: 'https://x/y.png' } }]))
  assert.equal(main.seen.stolen, 1, '主群带图 → 偷')

  const other = harness()
  other.observers.observe({ ...groupMessage([{ type: 'image', data: { url: 'https://x/y.png' } }]), group_id: OTHER_GROUP } as OneBotEvent)
  assert.equal(other.seen.stolen, 0, '别的群不偷')

  const off = harness({ emoji: { steal: false, dir: null, registeredDir: null } })
  off.observers.observe(groupMessage([{ type: 'image', data: { url: 'https://x/y.png' } }]))
  assert.equal(off.seen.stolen, 0, '关掉 steal 不偷')
})

test('观察者：取图失败（这里是"不许碰网络"）不影响消息路径', async () => {
  const { observers, seen } = harness()
  // observe 是同步的：异步打标自己跑自己的，抛错只吞掉，绝不冒泡。
  observers.observe(groupMessage([{ type: 'image', data: { url: 'https://x/y.png' } }, text('配文')]))
  assert.equal(seen.stolen, 1)
  assert.deepEqual(seen.learned.map((l) => l.text), ['配文'], '同一条消息的口癖照收')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(seen.tagged, 0, '取图失败 → 没打标，但也没炸')
})
