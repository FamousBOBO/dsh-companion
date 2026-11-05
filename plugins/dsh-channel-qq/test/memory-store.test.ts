/** 记忆存储与检索（P6e · e1）：追加式落盘、倒排索引、候选生成、记账。
 *
 * 这里测的是"会不会安静地坏掉"的那一类东西——文件被写成半截、坏行把整个库读不出来、
 * 记账写在了没注入的记录上（那样遗忘曲线就假了）、房间作用域串了。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

const { MemoryStore } = await import('../src/features/memory/store.js')
const { MemoryRetriever } = await import('../src/features/memory/retriever.js')

const NOW = Date.parse('2026-10-17T15:00:00+08:00')
const DAY = 86_400_000
/**
 * 递增的假随机源。**不能用常量**：常量会让 `newMemoryId` 每次都给出同一个后缀，
 * 于是同一批测试里建的多条记录共用一个 id（第一版就是这么写的，三条记录变成一条）。
 * 递增既保持可重放，又让 id 各不相同。
 */
let seq = 0
const roll = (): number => { seq = (seq + 1) % 10_000; return seq / 10_000 }

interface Scratch {
  dir: string
  store: InstanceType<typeof MemoryStore>
  logs: string[]
  cleanup: () => void
}

function scratch(): Scratch {
  const dir = mkdtempSync(path.join(tmpdir(), 'mem-'))
  const logs: string[] = []
  const store = new MemoryStore({ workspacePath: dir, dshHome: dir, log: (l: string) => logs.push(l) })
  return { dir, store, logs, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function entry(store: InstanceType<typeof MemoryStore>, overrides: Record<string, unknown> = {}) {
  return store.remember({
    kind: 'fact',
    subject: { type: 'user', id: 1000000002 },
    content: '学弟喜欢冰美式',
    source: { kind: 'chat', room: 'qq-dm-1000000002' },
    keywords: ['冰美式', '咖啡'],
    ...overrides,
  } as never, (overrides.__now as number) ?? NOW, roll)
}

// ── 存储 ────────────────────────────────────────────────────────────────────

test('存储：文件不存在时 load 出空库，不抛错也不建文件', async () => {
  const s = scratch()
  try {
    assert.equal(await s.store.load(), 0)
    assert.equal(existsSync(s.store.file), false, '只读不该产生文件')
  } finally { s.cleanup() }
})

test('存储：remember 落成一行 JSONL，键就是 09 §4.1 的字段', async () => {
  const s = scratch()
  try {
    await s.store.load()
    const rec = await entry(s.store)
    const lines = readFileSync(s.store.file, 'utf8').trim().split('\n')
    assert.equal(lines.length, 1)
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>
    assert.equal(parsed.id, rec.id)
    assert.equal(parsed.content, '学弟喜欢冰美式')
    assert.equal(parsed.status, 'active')
    assert.equal(parsed.strength, 1)
    assert.deepEqual((parsed.source as { room: string }).room, 'qq-dm-1000000002')
  } finally { s.cleanup() }
})

test('存储：追加式——同一 id 写两次就两行，**后写胜出**', async () => {
  const s = scratch()
  try {
    await s.store.load()
    const rec = await entry(s.store)
    await s.store.put({ ...rec, hits: 7, strength: 4 })

    const lines = readFileSync(s.store.file, 'utf8').trim().split('\n')
    assert.equal(lines.length, 2, '改动是追加，不是重写')

    const reopened = new MemoryStore({ workspacePath: s.dir, dshHome: s.dir, log: () => {} })
    await reopened.load()
    assert.equal(reopened.get(rec.id)!.hits, 7, '重新打开后看到的是最后那一行')
    assert.equal(reopened.size(), 1, '同一个 id 只算一条记录')
  } finally { s.cleanup() }
})

test('存储：坏行跳过、其余照读，并记一行日志（一条烂记录不该让整个库打不开）', async () => {
  const s = scratch()
  try {
    await s.store.load()
    const rec = await entry(s.store)
    appendFileSync(s.store.file, '{这不是 JSON\n', 'utf8')
    appendFileSync(s.store.file, JSON.stringify({ content: '没有 id' }) + '\n', 'utf8')

    const reopened = new MemoryStore({ workspacePath: s.dir, dshHome: s.dir, log: (l) => s.logs.push(l) })
    assert.equal(await reopened.load(), 1)
    assert.equal(reopened.get(rec.id)!.content, '学弟喜欢冰美式')
    assert.equal(s.logs.some((l) => l.includes('读不懂的记录')), true)
  } finally { s.cleanup() }
})

test('存储：压缩把文件重写成"一条记录一行"，历史版本被清掉', async () => {
  const s = scratch()
  try {
    await s.store.load()
    const rec = await entry(s.store)
    for (let i = 0; i < 5; i++) await s.store.put({ ...rec, hits: i })
    assert.equal(readFileSync(s.store.file, 'utf8').trim().split('\n').length, 6)

    const { kept } = await s.store.compact()
    assert.equal(kept, 1)
    const after = readFileSync(s.store.file, 'utf8').trim().split('\n')
    assert.equal(after.length, 1)
    assert.equal((JSON.parse(after[0]!) as { hits: number }).hits, 4, '压的是当前状态')
  } finally { s.cleanup() }
})

test('存储：id 撞车时自动换一个，不让后来的记录顶掉前一条', async () => {
  const s = scratch()
  try {
    await s.store.load()
    const constant = (): number => 0.5
    const a = await s.store.remember({ kind: 'fact', subject: { type: 'user', id: 1 }, content: '第一条', source: { kind: 'chat' } } as never, NOW, constant)
    const b = await s.store.remember({ kind: 'fact', subject: { type: 'user', id: 1 }, content: '第二条', source: { kind: 'chat' } } as never, NOW, constant)
    assert.notEqual(a.id, b.id)
    assert.equal(s.store.size(), 2, '两条都在')
    assert.equal(s.store.get(a.id)!.content, '第一条')
    assert.equal(s.store.get(b.id)!.content, '第二条')
  } finally { s.cleanup() }
})

test('存储：倒排索引覆盖关键词、标签、以及正文二元组', async () => {
  const s = scratch()
  try {
    await s.store.load()
    const rec = await entry(s.store, { tags: ['饮食'], keywords: ['冰美式'], content: '学弟喜欢冰美式' })
    assert.deepEqual(s.store.candidatesByTerms(['冰美式']).map((r) => r.id), [rec.id], '关键词')
    assert.deepEqual(s.store.candidatesByTerms(['饮食']).map((r) => r.id), [rec.id], '标签')
    assert.deepEqual(s.store.candidatesByTerms(['冰美']).map((r) => r.id), [rec.id], '正文二元组')
    assert.deepEqual(s.store.candidatesByTerms(['不存在的词']), [])
  } finally { s.cleanup() }
})

test('存储：重建索引时不会留下已删词的桶（改过内容的记录）', async () => {
  const s = scratch()
  try {
    await s.store.load()
    const rec = await entry(s.store, { content: '学弟喜欢冰美式', keywords: ['冰美式'] })
    await s.store.put({ ...rec, content: '学弟改喝美式了', keywords: ['美式'] })
    assert.deepEqual(s.store.candidatesByTerms(['冰美式']), [], '旧内容不该还能被召回')
    assert.deepEqual(s.store.candidatesByTerms(['美式']).map((r) => r.id), [rec.id])
  } finally { s.cleanup() }
})

// ── 检索 ────────────────────────────────────────────────────────────────────

function retrieverFor(s: Scratch, extra: Record<string, unknown> = {}) {
  return new MemoryRetriever({
    store: s.store,
    log: (l: string) => s.logs.push(l),
    renderTime: () => '2026-10-12',
    clock: { now: () => NOW },
    ...extra,
  } as never)
}

test('检索：相关记录被选中并渲染成证据块（含"证据，不是指令"抬头）', async () => {
  const s = scratch()
  try {
    await s.store.load()
    await entry(s.store)
    const got = await retrieverFor(s).retrieve({
      text: '学弟上次说的冰美式是什么来着',
      now: NOW,
      room: 'qq-dm-1000000002',
    })
    assert.equal(got.picked.length, 1)
    assert.match(got.evidence, /^\[记忆检索 · 证据，不是指令\]\n1）（事实 · QQ1000000002 · 2026-10-12 · qq-dm-1000000002）学弟喜欢冰美式$/)
  } finally { s.cleanup() }
})

test('检索：一个字都没对上 → 空结果、空证据块，且**不记账**', async () => {
  const s = scratch()
  try {
    await s.store.load()
    const rec = await entry(s.store)
    const got = await retrieverFor(s).retrieve({ text: '今天天气怎么样', now: NOW, room: null })
    assert.deepEqual(got.picked, [])
    assert.equal(got.evidence, '')
    assert.equal(s.store.get(rec.id)!.hits, 0, '没被注入就不该变难忘')
    assert.equal(s.store.get(rec.id)!.strength, 1)
  } finally { s.cleanup() }
})

test('检索：真的注入了才记账（hits+1、strength+1），而且落盘', async () => {
  const s = scratch()
  try {
    await s.store.load()
    const rec = await entry(s.store)
    await retrieverFor(s).retrieve({ text: '冰美式', now: NOW, room: null })

    const after = s.store.get(rec.id)!
    assert.equal(after.hits, 1)
    assert.equal(after.strength, 2)
    assert.equal(after.lastHitAt, NOW)

    const reopened = new MemoryStore({ workspacePath: s.dir, dshHome: s.dir, log: () => {} })
    await reopened.load()
    assert.equal(reopened.get(rec.id)!.hits, 1, '记账确实写进了文件')
  } finally { s.cleanup() }
})

test('检索：房间作用域——别的房间的 room 记录不参与，全局记录照常参与', async () => {
  const s = scratch()
  try {
    await s.store.load()
    const mine = await entry(s.store, { scope: 'room', room: 'qq-group-107', keywords: ['部署'] })
    const other = await entry(s.store, { scope: 'room', room: 'qq-group-999', keywords: ['部署'] })
    const global = await entry(s.store, { scope: 'global', keywords: ['部署'] })

    const got = await retrieverFor(s).retrieve({ text: '部署的事', now: NOW, room: 'qq-group-107' })
    const ids = got.picked.map((r) => r.id)
    assert.equal(ids.includes(mine.id), true)
    assert.equal(ids.includes(global.id), true)
    assert.equal(ids.includes(other.id), false, '别的房间的记忆不该冒出来')
  } finally { s.cleanup() }
})

test('检索：room 为 null = 不按房间过滤（深召回要能跨房间翻旧账）', async () => {
  const s = scratch()
  try {
    await s.store.load()
    const mine = await entry(s.store, { scope: 'room', room: 'qq-group-107', keywords: ['部署'] })
    const other = await entry(s.store, { scope: 'room', room: 'qq-dm-1000000002', keywords: ['部署'] })
    const got = await retrieverFor(s).retrieve({ text: '部署的事', now: NOW, room: null })
    const ids = got.picked.map((r) => r.id)
    assert.equal(ids.includes(mine.id), true)
    assert.equal(ids.includes(other.id), true, '深召回不按房间过滤')
  } finally { s.cleanup() }
})

test('检索：命中时间词时按区间过滤（"前天"不会给出上个月的事）', async () => {
  const s = scratch()
  try {
    await s.store.load()
    const recent = await entry(s.store, { content: '前天聊了部署', keywords: ['部署'], validFrom: NOW - DAY })
    const old = await entry(s.store, { content: '上个月聊了部署', keywords: ['部署'], validFrom: NOW - 40 * DAY })

    const got = await retrieverFor(s).retrieve({ text: '前天我们聊的部署呢', now: NOW, room: null })
    const ids = got.picked.map((r) => r.id)
    assert.equal(ids.includes(recent.id), true)
    assert.equal(ids.includes(old.id), false, '40 天前的记录被时间区间挡掉')
    assert.equal(got.query.preferRecent, true)
  } finally { s.cleanup() }
})

test('检索：被取代的记录不再注入（检索只看 active）', async () => {
  const s = scratch()
  try {
    await s.store.load()
    const rec = await entry(s.store, { keywords: ['冰美式'] })
    await s.store.put({ ...rec, status: 'superseded', validTo: NOW - 1, supersededBy: 'm_later' })
    const got = await retrieverFor(s).retrieve({ text: '冰美式', now: NOW, room: null })
    assert.deepEqual(got.picked, [])
  } finally { s.cleanup() }
})

test('检索：链接一跳——顺着命中记录的 links 能想起邻居（但邻居自己也要相关）', async () => {
  const s = scratch()
  try {
    await s.store.load()
    const seed = await entry(s.store, { content: '聊过部署方案', keywords: ['部署'] })
    const neighbour = await entry(s.store, { content: '部署要用到 rsync 增量', keywords: ['rsync'] })
    const unrelated = await entry(s.store, { content: '完全无关的事情', keywords: ['无关'] })
    await s.store.put({ ...seed, links: [neighbour.id, unrelated.id] })

    const got = await retrieverFor(s).retrieve({ text: '部署', now: NOW, room: null })
    const ids = got.picked.map((r) => r.id)
    assert.equal(ids.includes(neighbour.id), true, '邻居里含"部署"这个词，跟着被想起来')
    assert.equal(ids.includes(unrelated.id), false, '邻居也要自己有相关性')
  } finally { s.cleanup() }
})

test('检索：提到学弟时他的记录排在前（主体加权），但不会把别人排掉', async () => {
  const s = scratch()
  try {
    await s.store.load()
    const his = await entry(s.store, { content: '学弟在写机器人', keywords: ['机器人'] })
    const world = await entry(s.store, {
      content: '群里讨论机器人', keywords: ['机器人'], subject: { type: 'group', id: 107 },
    })

    const plain = await retrieverFor(s).retrieve({ text: '机器人', now: NOW, room: null })
    assert.equal(plain.picked.length, 2, '没提到人时两条都在')

    const withName = await retrieverFor(s).retrieve({
      text: '学弟的机器人怎么样了', now: NOW, room: null, aliases: ['学弟'], masterId: 1000000002,
    })
    assert.equal(withName.picked[0]!.id, his.id, '提到学弟 → 他的记录排前')
    assert.equal(withName.picked.some((r) => r.id === world.id), true, '加权不是过滤')
  } finally { s.cleanup() }
})

test('检索：注入预算 ≤8 条 / ≤600 字（在存储-检索这条链路上也成立）', async () => {
  const s = scratch()
  try {
    await s.store.load()
    for (let i = 0; i < 12; i++) {
      await entry(s.store, { content: `${'记'.repeat(100)}部署 ${i}`, keywords: ['部署'] })
    }
    const got = await retrieverFor(s).retrieve({ text: '部署', now: NOW, room: null })
    const chars = got.picked.reduce((sum, r) => sum + r.content.length, 0)
    assert.ok(got.picked.length <= 8, `条数：${got.picked.length}`)
    assert.ok(chars <= 600, `字符：${chars}`)
  } finally { s.cleanup() }
})

test('检索：记账写盘失败只记日志，不让这一回合失败', async () => {
  const s = scratch()
  try {
    await s.store.load()
    const rec = await entry(s.store)
    // 只替掉"写盘"这一个动作：`Object.create` 让其余方法照旧（走原型链拿到真实现），
    // 直接把类实例展开成字面量是**不行的**——展开只复制自有属性，原型上的方法全丢。
    const broken = Object.create(s.store) as typeof s.store
    broken.put = async (): Promise<void> => { throw new Error('磁盘满了') }

    const got = await retrieverFor(s, { store: broken }).retrieve({ text: '冰美式', now: NOW, room: null })
    assert.equal(got.picked.length, 1, '证据照给')
    assert.equal(got.picked[0]!.id, rec.id)
    assert.equal(s.logs.some((l) => l.includes('记账失败')), true)
  } finally { s.cleanup() }
})

// ── 工具面：memory.v2 有它就换轨道，没有就照旧 ──────────────────────────────

test('工具面：qq_recall_memory / qq_memorize_fact 在 memory 服务在场时走结构化记忆', async () => {
  const { resolveConfig } = await import('../src/config.js')
  const { createQQApi } = await import('../src/adapters/onebot/qq-api.js')
  const { fakeClient, fakeOut, toolRecorder } = await import('./fakes/host.js')
  const { registerQQTools } = await import('../src/features/qq-tools/register.js')
  const { MemoryStore } = await import('../src/features/memory/store.js')
  const { MemoryRetriever } = await import('../src/features/memory/retriever.js')
  const { createMemoryService } = await import('../src/features/memory/service.js')
  const { mkdtempSync: mk, rmSync: rm } = await import('node:fs')

  const dir = mk(path.join(tmpdir(), 'mem-svc-'))
  try {
    const store = new MemoryStore({ workspacePath: dir, dshHome: dir, log: () => {} })
    await store.load()
    const service = createMemoryService({
      store,
      log: () => {},
      renderTime: () => '2026-10-12',
      clock: { now: () => NOW },
      legacy: null,
    })

    const { ctx, definitions } = toolRecorder()
    const config = resolveConfig({ selfId: 1, admins: [1000000002], primaryGroup: 107 })
    registerQQTools(
      ctx as never, config, createQQApi(fakeClient() as never), fakeOut() as never, () => {},
      undefined, undefined, undefined, undefined, undefined, service as never,
    )
    const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const def = definitions.find((d) => d.name === name)
      assert.ok(def, `工具 ${name} 不存在`)
      return await (def.execute as (a: unknown) => Promise<Record<string, unknown>>)(args)
    }

    const written = await call('qq_memorize_fact', { content: '学弟喜欢冰美式', type: 'preference' })
    assert.equal(written.ok, true)
    assert.equal(written.added, 1)

    const recalled = await call('qq_recall_memory', { query: '冰美式' })
    assert.equal(recalled.count, 1)
    const memories = recalled.memories as Array<Record<string, unknown>>
    assert.equal(memories[0]!.content, '学弟喜欢冰美式')
    assert.equal(memories[0]!.type, 'preference')
    assert.equal(memories[0]!.date, '2026-10-12', '证据带成立时间')
  } finally { rm(dir, { recursive: true, force: true }) }
})

// ── 原文块的隔离（2026-10-19：chunk 层上线的回归保护）─────────────────────────

test('检索：accept 过滤生效——原文块不进自动注入预算', async () => {
  const s = scratch()
  try {
    await s.store.load()
    const fact = await entry(s.store, { content: '学弟喜欢冰美式', keywords: ['冰美式'] })
    const chunk = await entry(s.store, {
      content: '学弟喜欢冰美式，每天早上到了工位第一件事就是冲一杯。', keywords: ['冰美式'], tags: ['chunk'],
    })
    const got = await retrieverFor(s).retrieve({
      text: '冰美式',
      now: NOW,
      room: null,
      accept: (record: { tags: readonly string[] }) => !record.tags.includes('chunk'),
    })
    const ids = got.picked.map((r) => r.id)
    assert.equal(ids.includes(fact.id), true)
    assert.equal(ids.includes(chunk.id), false, '600 字预算装一块就满了，块必须挡在注入之外')
  } finally { s.cleanup() }
})

test('主动召回：原文块不作为「一条记忆」返回', async () => {
  const { createMemoryService } = await import('../src/features/memory/service.js')
  const s = scratch()
  try {
    await s.store.load()
    await entry(s.store, { content: '学弟喜欢冰美式', keywords: ['冰美式'] })
    await entry(s.store, {
      content: '这段话是日记原文块：学弟喜欢冰美式，每天早上都喝。', keywords: ['冰美式'], tags: ['chunk'],
    })
    const service = createMemoryService({
      store: s.store, log: () => {}, renderTime: () => '2026-10-12', clock: { now: () => NOW }, legacy: null,
    })
    const hits = await service.recall({ query: '冰美式', limit: 5 })
    assert.equal(hits.length, 1)
    assert.equal(hits[0]!.content, '学弟喜欢冰美式')
  } finally { s.cleanup() }
})
