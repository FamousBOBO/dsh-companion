/** 表情包入站旁路的测试（`features/expression-bridge.ts`）。
 *
 * 这条路径是**旁路**：它跑在每一条消息上，所以测试关心的不是功能多，而是
 * "没装 / 不要 / 对方坏了"三种情况下**什么都别发生**：
 *   - 没有端口时不建注册表、不抛、不起定时器；
 *   - 端口说不要（且不说"要"以外的任何值）时一次 ingest 都不发生；
 *   - 端口抛错时吞掉并记一行，消息路径照旧；
 *   - 转发出去的是**元数据**：地址与 mface 字段，没有字节、没有 Buffer。
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

// 数据根先钉住：端口注册表按它分区，也免得测试去读宿主机上真实的数据目录。
const DATA_ROOT = mkdtempSync(path.join(tmpdir(), 'expression-bridge-'))
process.env.DSH_COMPANION_DATA_DIR = DATA_ROOT

const bridge = await import('../src/features/expression-bridge.js')
const { InboundObservers } = await import('../src/features/observers/inbound.js')
const { resolveConfig } = await import('../src/config.js')
type OneBotEvent = import('../src/types.js').OneBotEvent

interface Ingested {
  messageId: number
  at: number
  kind: string
  chatId: number
  isOwner: boolean
  senderId: number
  images: Array<Record<string, unknown>>
  text?: string
}

interface FakePort {
  version?: number
  offersCalls: Array<Record<string, unknown>>
  ingested: Ingested[]
  offers: (offer: Record<string, unknown>) => unknown
  ingest: (event: Ingested) => unknown
}

const KEY = DATA_ROOT
const PORT = bridge.EXPRESSION_PORT_SYMBOL

/** 装一个假端口（只读记账，不建定时器）；`over` 可以逐条改行为。 */
function install(over: Partial<FakePort> = {}): FakePort {
  const port: FakePort = {
    version: 1,
    offersCalls: [],
    ingested: [],
    offers(offer) { port.offersCalls.push(offer); return true },
    ingest(event) { port.ingested.push(event); return undefined },
    ...over,
  }
  const registry = new Map<string, unknown>([[KEY, port]])
  Object.defineProperty(process, PORT, { value: registry, configurable: true, writable: true })
  return port
}

function clear(): void {
  Reflect.deleteProperty(process, PORT)
}

after(() => {
  clear()
  delete process.env.DSH_COMPANION_DATA_DIR
  rmSync(DATA_ROOT, { recursive: true, force: true })
})

const GROUP = 1000000003
const OWNER = 456
const MEMBER = 789

function groupEvent(message: unknown[], over: Partial<OneBotEvent> = {}): OneBotEvent {
  return {
    time: 1_760_000_000, self_id: 10000, post_type: 'message', message_type: 'group',
    group_id: GROUP, user_id: MEMBER, message_id: 42, message: message as never, ...over,
  }
}

const text = (value: string): unknown => ({ type: 'text', data: { text: value } })

test('没有端口：不建注册表、不抛、什么都不做', () => {
  clear()
  const before = Reflect.get(process, PORT)
  assert.equal(bridge.expressionPort(), null)
  for (let i = 0; i < 50; i++) bridge.forwardInbound(groupEvent([text('你好')]), { admins: [OWNER] })
  assert.equal(Reflect.get(process, PORT), before, '取端口不许顺手建一个空 Map')
  assert.equal(Reflect.get(process, PORT), undefined)
})

test('端口版本不是 v1：当作没有端口（一次判空就返回）', () => {
  const port = install({ version: 2 })
  assert.equal(bridge.expressionPort(), null)
  bridge.forwardInbound(groupEvent([text('你好')]), { admins: [OWNER] })
  assert.deepEqual(port.offersCalls, [], '版本不对就不该被调用')
  assert.deepEqual(port.ingested, [])
})

test('端口说不要：一次 ingest 都没有（且不做任何组包之外的副作用）', () => {
  let offers = 0
  const port = install({ offers: () => { offers += 1; return false } })
  bridge.forwardInbound(groupEvent([{ type: 'image', data: { url: 'https://x/y.png' } }]), { admins: [OWNER] })
  assert.equal(offers, 1, '问过一次要不要')
  assert.deepEqual(port.ingested, [])
  // 非 `true` 的返回值一律当"不要"：`undefined` / `'yes'` / `1` / 对象都不算应允。
  for (const answer of [undefined, 'yes', 1, {}]) {
    const other = install({ offers: () => answer })
    bridge.forwardInbound(groupEvent([text('喂')]), { admins: [OWNER] })
    assert.deepEqual(other.ingested, [], String(answer))
  }
})

test('转发的是元数据：消息号 / 时间 / 路由 / 发言人 / 图片地址与 mface 字段，没有字节', () => {
  const port = install()
  const event = groupEvent(
    [
      text('看看这个'),
      { type: 'image', data: { url: 'https://cdn.example.com/a.png', subType: 1, summary: '[动画表情]', emojiId: 'e1', emojiPackageId: 'p1', key: 'k1' } },
    ],
    { user_id: OWNER },
  )
  bridge.forwardInbound(event, { admins: [OWNER] })
  assert.equal(port.ingested.length, 1)
  const ingested = port.ingested[0]!
  assert.deepEqual(ingested, {
    messageId: 42,
    at: 1_760_000_000_000,
    kind: 'group',
    chatId: GROUP,
    isOwner: true,
    senderId: OWNER,
    images: [{ url: 'https://cdn.example.com/a.png', subType: 1, summary: '[动画表情]', emojiId: 'e1', emojiPackageId: 'p1', key: 'k1' }],
    text: '看看这个',
  })
  // 占位符不进 `text`（`plainText` 才是内容），也不出现任何字节形态。
  assert.equal(/\[图片\]/.test(ingested.text ?? ''), false)
  assert.equal(Object.keys(ingested).includes('bytes'), false)
  for (const value of Object.values(ingested)) assert.equal(Buffer.isBuffer(value), false)
  assert.equal(JSON.stringify(ingested).includes('data:image'), false)
  // 私聊路由：chatId 是对方 QQ 号，`isOwner` 只认 admins。
  const dm = install()
  bridge.forwardInbound({ time: 1_760_000_000, self_id: 10000, post_type: 'message', message_type: 'private', user_id: MEMBER, message_id: 7, message: [text('嗨')] as never }, { admins: [OWNER] })
  assert.equal(dm.ingested[0]!.kind, 'dm')
  assert.equal(dm.ingested[0]!.chatId, MEMBER)
  assert.equal(dm.ingested[0]!.isOwner, false)
})

test('端口抛错一律吞掉：记一行，消息路径照旧（上下两行都不许冒泡）', () => {
  const logs: string[] = []
  const offersThrow = install({ offers: () => { throw new Error('offers 炸了') } })
  assert.equal(bridge.forwardInbound(groupEvent([text('喂')]), { admins: [OWNER], log: (line) => logs.push(line) }), undefined)
  assert.deepEqual(offersThrow.ingested, [])
  assert.equal(logs.length, 1)
  assert.match(logs[0]!, /offers 炸了/)

  const ingestThrow = install({ ingest: () => { throw new Error('ingest 炸了') } })
  assert.equal(bridge.forwardInbound(groupEvent([text('喂')]), { admins: [OWNER], log: (line) => logs.push(line) }), undefined)
  assert.equal(ingestThrow.offersCalls.length, 1, 'ingest 之前照常问过一次')
  assert.equal(logs.length, 2)
  assert.match(logs[1]!, /ingest 炸了/)
})

test('观察者接上端口后每条消息转发一次；没接则整段跳过（旧行为不变）', () => {
  const port = install()
  const seen = { learned: 0, flooded: 0 }
  const observers = new InboundObservers({
    config: () => resolveConfig({ primaryGroup: GROUP, workspacePath: '/tmp/ws' }),
    log: () => {},
    platform: () => ({ api: { sendTo: async () => ({ ok: true }) }, selfId: 10000, isConnected: () => true }) as never,
    out: () => ({ push: async <T>(fn: () => Promise<T>) => await fn() }) as never,
    flood: () => ({ observe: () => { seen.flooded += 1; return null } }) as never,
    learn: () => ({ observe: () => { seen.learned += 1 } }) as never,
    emoji: () => null,
    library: () => null,
    expression: () => bridge.expressionBridgePort(),
    http: { request: async () => { throw new Error('旁路不该碰网络') } } as never,
    tagContext: () => ({} as never),
  })
  observers.observe(groupEvent([text('今天天气不错')]))
  assert.equal(port.ingested.length, 1)
  assert.deepEqual(port.offersCalls[0], { kind: 'group', chatId: GROUP, isOwner: false })
  assert.equal(seen.learned, 1, '口癖学习照旧')
  assert.equal(seen.flooded, 1, '风控照旧')

  // 观察者没有这一格（旧装配）：不转发、也不炸。
  const legacy = new InboundObservers({
    config: () => resolveConfig({ workspacePath: '/tmp/ws' }),
    log: () => {},
    platform: () => null,
    out: () => null,
    flood: () => null,
    learn: () => null,
    emoji: () => null,
    library: () => null,
    http: { request: async () => { throw new Error('不该请求') } } as never,
    tagContext: () => ({} as never),
  })
  assert.equal(legacy.observe(groupEvent([text('喂')])), undefined)
})

test('未启用（没有端口）时不注册任何定时器，也不新增活动句柄', () => {
  clear()
  const handles = () => process.getActiveResourcesInfo().filter((name) => name === 'Timeout' || name === 'Immediate').length
  const before = handles()
  for (let i = 0; i < 200; i++) bridge.forwardInbound(groupEvent([text('喂')]), { admins: [OWNER] })
  assert.equal(handles(), before)
})

test('publisher 实际发布的裸对象也认：没有 offers 就直接喂 observe', () => {
  // `companion-expression/src/index.mjs` 的 `process[PORT_SYMBOL] = {version, service, observe, status}`。
  const seen: Ingested[] = []
  Object.defineProperty(process, PORT, { value: { version: 1, service: {}, observe: (event: Ingested) => { seen.push(event) } }, configurable: true, writable: true })
  assert.notEqual(bridge.expressionPort(), null)
  bridge.forwardInbound(groupEvent([text('喂')]), { admins: [OWNER] })
  assert.equal(seen.length, 1, '没有 offers 就等于"全都要"，授权在对方内部判')
  assert.equal(seen[0]!.kind, 'group')
  assert.equal(seen[0]!.chatId, GROUP)
  // 形状不认识（没有任何入队方法）仍旧当作没有端口。
  Object.defineProperty(process, PORT, { value: { version: 1, service: {} }, configurable: true, writable: true })
  assert.equal(bridge.expressionPort(), null)
})
