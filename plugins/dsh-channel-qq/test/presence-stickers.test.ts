/** 自主发言之后的**配图**（`features/inbound/presence-afterspeak.ts` 的 `stickerStep`）。
 *
 * docs/11 的 P1「分离入站理解和出站配图」：用户发来的表情是**理解**（不管它），Bot 自己要
 * 配图是**出站**（受 `presence.stickers` + 冷却 + 小时额度约束）。这两件事共用一套图库，
 * 但只有后者会真的发东西，所以它必须被单独钉住：
 *
 *   1. `presence.stickers !== true` → 一次图库都不问（不是问了再丢）；
 *   2. 额度与冷却按**群**记：同一群刚发过就不再问；不同群互不影响；
 *   3. 图库说「没候选 / 冷却 / 授权不够」时，**账本不前进**——不能因为一次没发成
 *      就把这一群锁死 10 分钟；
 *   4. 图库抛错不能冒泡到「这句话已经发出去了」这条路径上。
 *
 * 全程假图库：不读库、不联网、不发 QQ。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { afterSpeakHandler } = await import('../src/features/inbound/presence-afterspeak.js')

const NOW = Date.parse('2026-11-08T09:00:00+08:00')
const GROUP = 1000000003

interface FakeService {
  candidateCalls: Array<Record<string, unknown>>
  replyCalls: Array<Record<string, unknown>>
  candidates: (input: Record<string, unknown>) => unknown
  reply: (input: Record<string, unknown>) => unknown
}

/** 一个记账用的假图库：默认给一张候选、发送成功并带回执。 */
function fakeService(over: Partial<FakeService> = {}): FakeService {
  const service: FakeService = {
    candidateCalls: [],
    replyCalls: [],
    candidates(input) { service.candidateCalls.push(input); return { ok: true, candidates: [{ assetId: 'ast_abc123456' }] } },
    reply(input) { service.replyCalls.push(input); return { ok: true, messageId: 4242 } },
    ...over,
  }
  return service
}

/** 一个只够 afterSpeakHandler 用的假宿主：日志进数组，上下文里挂着图库服务。 */
function fakeHost(service: FakeService | null): { host: unknown; logs: string[] } {
  const logs: string[] = []
  const host = {
    log: (line: string) => { logs.push(line) },
    dshHome: '/tmp/does-not-matter',
    bridge: {
      tagContext: () => ({
        get: (name: string) => (name === 'companionExpression' ? service ?? undefined : undefined),
      }),
    },
  }
  return { host, logs }
}

/** 一次"她刚说完"的输入：附和类（`react`）+ 轻量反应正文，是配图唯一被考虑的形状。 */
function spoken(over: Record<string, unknown> = {}) {
  return {
    groupId: GROUP,
    action: 'react' as const,
    text: '哈哈哈',
    messageId: 9001,
    atMs: NOW,
    topic: null,
    ...over,
  }
}

/** `presence.*` 的最小面：`stickerStep` 只读这三项。 */
function settings(over: Record<string, unknown> = {}) {
  return { enabled: true, stickers: true, stickerMinIntervalMs: 600_000, stickerMaxPerHour: 1, ...over } as never
}

test('async candidates serialize per group and recheck live mode before sending', async () => {
  let release!: () => void
  const ready = new Promise<void>(resolve => { release = resolve })
  const service = fakeService()
  service.candidates = async input => {
    service.candidateCalls.push(input)
    await ready
    return { ok: true, send: true, candidates: [{ assetId: 'ast_abc123456' }] }
  }
  const { host } = fakeHost(service)
  let current = settings()
  const handler = afterSpeakHandler(host as never, () => current)
  const first = handler(spoken() as never)
  await handler(spoken() as never)
  assert.equal(service.candidateCalls.length, 1)
  current = settings({ mode: 'shadow' })
  release()
  await first
  assert.equal(service.replyCalls.length, 0)
  current = settings()
  await handler(spoken() as never)
  assert.equal(service.replyCalls.length, 1)
  assert.equal(service.replyCalls[0]?.mode, 'sticker_only')
  assert.equal(service.replyCalls[0]?.text, undefined)
})

test('presence.stickers 关着：一次图库都不问（不是问了再丢）', async () => {
  const service = fakeService()
  const { host } = fakeHost(service)
  const handler = afterSpeakHandler(host as never, () => settings({ stickers: false }))
  await handler(spoken() as never)
  assert.equal(service.candidateCalls.length, 0)
  assert.equal(service.replyCalls.length, 0)
})

test('额度允许时：先问候选、再用候选 assetId 发，且是「文字在前、图在后」', async () => {
  const service = fakeService()
  const { host, logs } = fakeHost(service)
  const handler = afterSpeakHandler(host as never, () => settings())
  await handler(spoken() as never)
  assert.equal(service.candidateCalls.length, 1)
  assert.equal(service.candidateCalls[0]?.isGroup, true)
  assert.equal(String(service.candidateCalls[0]?.target), String(GROUP))
  assert.equal(service.replyCalls.length, 1)
  assert.equal(service.replyCalls[0]?.assetId, 'ast_abc123456', '必须用候选返回的 assetId，不许拼路径')
  assert.equal(service.replyCalls[0]?.mode, 'sticker_only', '文字是主表达，图配在后面')
  assert.ok(logs.some(line => line.includes('发了一张表情包')), `日志里要有发送记录：${logs.join(' | ')}`)
})

test('同一群冷却中：第二次不再问图库（额度按群记）', async () => {
  const service = fakeService()
  const { host } = fakeHost(service)
  const handler = afterSpeakHandler(host as never, () => settings({ stickerMaxPerHour: 5 }))
  await handler(spoken() as never)
  assert.equal(service.candidateCalls.length, 1)
  // 10 分钟冷却没到（只过了 1 分钟）。
  await handler(spoken({ atMs: NOW + 60_000 }) as never)
  assert.equal(service.candidateCalls.length, 1, '冷却中不该再问一次图库')
  // 过了冷却就能再问（额度 5，够）。
  await handler(spoken({ atMs: NOW + 700_000 }) as never)
  assert.equal(service.candidateCalls.length, 2)
})

test('小时额度用尽：不再问图库', async () => {
  const service = fakeService()
  const { host } = fakeHost(service)
  const handler = afterSpeakHandler(host as never, () => settings({ stickerMaxPerHour: 1, stickerMinIntervalMs: 1 }))
  await handler(spoken() as never)
  assert.equal(service.candidateCalls.length, 1)
  // 冷却已过（间隔 1ms），但这一小时已经发过 1 张。
  await handler(spoken({ atMs: NOW + 120_000 }) as never)
  assert.equal(service.candidateCalls.length, 1, '小时额度用尽后不再问')
})

test('不同群互不影响：另一个群有自己的额度与冷却', async () => {
  const service = fakeService()
  const { host } = fakeHost(service)
  const handler = afterSpeakHandler(host as never, () => settings({ stickerMaxPerHour: 1 }))
  await handler(spoken() as never)
  assert.equal(service.candidateCalls.length, 1)
  await handler(spoken({ groupId: 1000000004, atMs: NOW + 1000 }) as never)
  assert.equal(service.candidateCalls.length, 2, '另一个群不该被这个群的冷却挡住')
})

test('图库说没候选时账本不前进：下一句仍然会再问（一次没发成不锁死 10 分钟）', async () => {
  const service = fakeService()
  // 覆盖成「永远没有候选」，但仍然记账（覆盖会替换掉默认实现，所以这里自己 push）。
  service.candidates = (input: Record<string, unknown>) => { service.candidateCalls.push(input); return { ok: true, candidates: [] } }
  const { host, logs } = fakeHost(service)
  const handler = afterSpeakHandler(host as never, () => settings())
  await handler(spoken() as never)
  assert.equal(service.candidateCalls.length, 1)
  assert.equal(service.replyCalls.length, 0, '没有候选就不发（不随机挑图）')
  assert.ok(logs.some(line => line.includes('no-candidate')), `日志要写清原因：${logs.join(' | ')}`)
  // 冷却只有 10 分钟，但账本没前进，所以 1 分钟后就允许再试。
  await handler(spoken({ atMs: NOW + 60_000 }) as never)
  assert.equal(service.candidateCalls.length, 2, '没发成功不该消耗冷却')
})

test('没有回执（messageId）不算发过：账本同样不前进', async () => {
  const service = fakeService({ reply: () => ({ ok: true }) })
  const { host, logs } = fakeHost(service)
  const handler = afterSpeakHandler(host as never, () => settings())
  await handler(spoken() as never)
  assert.ok(logs.some(line => line.includes('no-receipt')), `没有回执要如实写：${logs.join(' | ')}`)
  await handler(spoken({ atMs: NOW + 60_000 }) as never)
  assert.equal(service.candidateCalls.length, 2, '没有回执的发送不占用冷却')
})

test('图库抛错不冒泡：只记一行，且不影响其它附加动作', async () => {
  const service = fakeService({
    candidates: () => { throw new Error('图库炸了') },
  })
  const { host, logs } = fakeHost(service)
  const handler = afterSpeakHandler(host as never, () => settings())
  await assert.doesNotReject(() => handler(spoken() as never))
  assert.ok(logs.some(line => line.includes('图库炸了') || line.includes('候选检索抛错')), `要记一行原因：${logs.join(' | ')}`)
})

test('没有图库服务：不发、不抛，只记一行「没发」', async () => {
  const { host, logs } = fakeHost(null)
  const handler = afterSpeakHandler(host as never, () => settings())
  await assert.doesNotReject(() => handler(spoken() as never))
  assert.ok(logs.some(line => line.includes('no-service')), `要写清是没有服务：${logs.join(' | ')}`)
})

test('settingsOf 为空（presence 没开）：整段跳过，一次图库都不问', async () => {
  const service = fakeService()
  const { host } = fakeHost(service)
  const handler = afterSpeakHandler(host as never, () => null)
  await handler(spoken() as never)
  assert.equal(service.candidateCalls.length, 0)
})
