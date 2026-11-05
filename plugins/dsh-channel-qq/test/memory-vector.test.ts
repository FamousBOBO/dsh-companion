/** 向量检索（P6e · e2）：embed 客户端、分片存储、重建、混合检索。
 *
 * 守的是几件"坏起来很安静"的事：
 *   - 服务不可用 → 检索逐字节退回关键词路径，且日志只记一行（不按回合刷屏）；
 *   - 维度不符 → 整份拒绝，绝不错位读（KB Lite 那个产物的真事故）；
 *   - 坏分片 / 半截文件 → 跳过坏的、其余照用；
 *   - 打分 → 同一条记录的分数不随"同批里还有谁"变化。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, truncateSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

import { atomicWriteFile, atomicWriteJson } from '../src/adapters/fs-store/atomic.js'
import { createEmbedAdapter } from '../src/adapters/providers/embed.js'
import { makeRecord, type MemoryRecord, type NewRecordInput } from '../src/core/memory/model.js'
import { blendedRelevance, cosineSimilarity, rankCandidates } from '../src/core/memory/score.js'
import { MemoryRetriever } from '../src/features/memory/retriever.js'
import { rebuildMemoryVectors } from '../src/features/memory/rebuild.js'
import { MemoryStore } from '../src/features/memory/store.js'
import {
  VEC_FILE_NAME, VEC_MANIFEST_NAME, createVectorRecall, encodeVectorFile,
  loadVectorIndex, manifestFor, type VectorRecall,
} from '../src/features/memory/vector-store.js'
import type { EmbedPort } from '../src/ports/memory.js'
import type { HttpClient, HttpResponse } from '../src/ports/http.js'

const NOW = Date.parse('2026-10-17T15:00:00+08:00')
const DAY = 86_400_000

/** 递增的假随机源（同 memory-store.test.ts 的教训：常量会让 id 撞车）。 */
let seq = 0
const roll = (): number => { seq = (seq + 1) % 10_000; return seq / 10_000 }

function scratch(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'memvec-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** 造一条记录；id 定死（重建/检索测试按 id 断言）；`at` 可以把它放到过去。 */
function record(id: string, content: string, extra: Partial<NewRecordInput> = {}, at: number = NOW): MemoryRecord {
  const built = makeRecord({
    kind: 'fact',
    subject: { type: 'world' },
    content,
    source: { kind: 'manual' },
    ...extra,
  }, at, roll)
  return { ...built, id }
}

interface StubCall { readonly url: string; readonly body: string; readonly allowPrivate: boolean }
interface StubReply { readonly status?: number; readonly json?: unknown; readonly fail?: string }

/** 假的 HttpClient：记录调用、按回调返回（不碰真网络）。 */
function httpStub(respond: (call: StubCall) => StubReply): { http: HttpClient; calls: StubCall[] } {
  const calls: StubCall[] = []
  const http: HttpClient = {
    request: async (url, options): Promise<HttpResponse> => {
      const call: StubCall = {
        url,
        body: typeof options?.body === 'string' ? options.body : '',
        allowPrivate: options?.allowPrivateHosts === true,
      }
      calls.push(call)
      const reply = respond(call)
      if (reply.fail !== undefined) throw new Error(reply.fail)
      const status = reply.status ?? 200
      const text = JSON.stringify(reply.json ?? {})
      const bytes = Buffer.from(text, 'utf8')
      return {
        status,
        ok: status >= 200 && status < 300,
        url,
        bytes,
        truncated: false,
        header: () => null,
        headerValues: () => [],
        text: () => text,
        json: <T = unknown>(): T => (reply.json ?? {}) as T,
      }
    },
  }
  return { http, calls }
}

/** 确定性假嵌入器；`texts` 记录嵌过哪些文本（增量断言用）。 */
function fakeEmbedder(dim: number, vecOf: (text: string) => number[] | null): { port: EmbedPort; texts: string[] } {
  const texts: string[] = []
  const port: EmbedPort = {
    dim,
    available: () => true,
    embed: async (input) => {
      const out: Float32Array[] = []
      for (const text of input) {
        texts.push(text)
        const vec = vecOf(text)
        if (vec === null || vec.length !== dim) return null // 整批失败（沿用适配器的全有或全无）
        out.push(Float32Array.from(vec))
      }
      return out
    },
  }
  return { port, texts }
}

/** 直接造一份索引文件（测试专用）：按容量装片、写清单。 */
async function writeIndexFiles(
  dir: string,
  dim: number,
  generation: number,
  capacity: number,
  entries: ReadonlyArray<readonly [string, readonly number[]]>,
): Promise<void> {
  const shards: Float32Array[][] = []
  const manifest = new Map<string, readonly [number, number]>()
  for (const [id, vec] of entries) {
    let last = shards[shards.length - 1]
    if (last === undefined || last.length >= capacity) {
      last = []
      shards.push(last)
    }
    last.push(Float32Array.from(vec))
    manifest.set(id, [shards.length - 1, last.length - 1])
  }
  await atomicWriteFile(path.join(dir, VEC_FILE_NAME), encodeVectorFile(dim, shards, { capacity, generation }))
  await atomicWriteJson(path.join(dir, VEC_MANIFEST_NAME), manifestFor(dim, generation, manifest))
}

async function loadIndexWith(dir: string, dim: number, entries: ReadonlyArray<readonly [string, readonly number[]]>) {
  await writeIndexFiles(dir, dim, 1, 64, entries)
  return await loadVectorIndex({
    file: path.join(dir, VEC_FILE_NAME),
    manifestFile: path.join(dir, VEC_MANIFEST_NAME),
    dim,
    log: () => {},
  })
}

async function storeWith(dir: string, records: readonly MemoryRecord[], log: (l: string) => void = () => {}): Promise<MemoryStore> {
  const store = new MemoryStore({ workspacePath: dir, dshHome: dir, log })
  await store.load()
  await store.put(...records)
  return store
}

function retrieverFor(store: MemoryStore, logs: string[], vectors?: VectorRecall): MemoryRetriever {
  return new MemoryRetriever({
    store,
    log: (l) => logs.push(l),
    renderTime: () => '2026-10-17',
    clock: { now: () => NOW },
    ...(vectors === undefined ? {} : { vectors }),
  })
}

// ── embed 客户端 ────────────────────────────────────────────────────────────

test('embed 客户端：POST <base>/v1/embeddings、放行私网、解析 data[].embedding', async () => {
  const { http, calls } = httpStub(() => ({
    json: { object: 'list', model: 'Xenova/bge-small-zh-v1.5', data: [{ object: 'embedding', index: 0, embedding: [1, 0, 0, 0] }] },
  }))
  const adapter = createEmbedAdapter({ baseUrl: 'http://127.0.0.1:17861', dim: 4, log: () => {}, http, now: () => 0 })
  const out = await adapter.embed(['你好'])
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.url, 'http://127.0.0.1:17861/v1/embeddings')
  assert.equal(calls[0]!.allowPrivate, true, 'URL 来自配置，放行本机地址（第一类许可）')
  assert.deepEqual(JSON.parse(calls[0]!.body), { input: ['你好'] })
  assert.deepEqual([...(out![0]!)], [1, 0, 0, 0])
  assert.equal(adapter.available(), true)
})

test('embed 客户端：超过一批自动分批（16 条一批）', async () => {
  const { http, calls } = httpStub((call) => {
    const count = (JSON.parse(call.body) as { input: string[] }).input.length
    return { json: { data: Array.from({ length: count }, (_, i) => ({ index: i, embedding: [1, 0, 0, 0] })) } }
  })
  const adapter = createEmbedAdapter({ baseUrl: 'http://127.0.0.1:17861', dim: 4, log: () => {}, http, now: () => 0 })
  const out = await adapter.embed(Array.from({ length: 17 }, (_, i) => `t${i}`))
  assert.equal(out!.length, 17)
  assert.equal(calls.length, 2, '17 条拆成 16+1 两批')
})

test('embed 客户端：连不上 → 返回 null 不抛、只记一行；冷却期内不碰网络也不重记', async () => {
  const { http, calls } = httpStub(() => ({ fail: 'ECONNREFUSED' }))
  let clock = 1_000
  const logs: string[] = []
  const adapter = createEmbedAdapter({ baseUrl: 'http://127.0.0.1:17861', dim: 4, log: (l) => logs.push(l), http, now: () => clock })
  assert.equal(await adapter.embed(['a']), null)
  assert.equal(await adapter.embed(['a']), null)
  assert.equal(calls.length, 1, '冷却期内不再碰网络')
  assert.equal(adapter.available(), false)
  assert.equal(logs.filter((l) => l.includes('不可用')).length, 1, '失败只记一行')
  clock += 61_000
  assert.equal(adapter.available(), true, '冷却过后允许再试')
  assert.equal(await adapter.embed(['a']), null)
  assert.equal(calls.length, 2)
  assert.equal(logs.filter((l) => l.includes('仍不可用')).length, 0, '距上次记录不足 5 分钟，不刷屏')
})

test('embed 客户端：向量维度不符 → 整批按不可用处理（绝不写进索引）', async () => {
  const { http } = httpStub(() => ({ json: { data: [{ index: 0, embedding: [1, 0, 0] }] } }))
  const logs: string[] = []
  const adapter = createEmbedAdapter({ baseUrl: 'http://127.0.0.1:17861', dim: 4, log: (l) => logs.push(l), http, now: () => 0 })
  assert.equal(await adapter.embed(['a']), null)
  assert.equal(adapter.available(), false)
  assert.equal(logs.some((l) => l.includes('维度') && l.includes('绝不写进索引')), true)
})

test('embed 客户端：恢复记一行、状态回可用', async () => {
  let healthy = false
  const { http } = httpStub(() => healthy
    ? { json: { data: [{ index: 0, embedding: [1, 0, 0, 0] }] } }
    : { fail: 'boom' })
  let clock = 0
  const logs: string[] = []
  const adapter = createEmbedAdapter({ baseUrl: 'http://127.0.0.1:17861', dim: 4, log: (l) => logs.push(l), http, now: () => clock })
  assert.equal(await adapter.embed(['a']), null)
  healthy = true
  clock += 61_000
  assert.notEqual(await adapter.embed(['a']), null)
  assert.equal(logs.filter((l) => l.includes('已恢复')).length, 1)
  assert.equal(adapter.available(), true)
})

test('embed 客户端：维度配置非法 → 永久不可用（配置错只记一次、不碰网络）', async () => {
  const logs: string[] = []
  const { http, calls } = httpStub(() => ({ json: {} }))
  const adapter = createEmbedAdapter({ baseUrl: 'http://127.0.0.1:17861', dim: 0, log: (l) => logs.push(l), http, now: () => 0 })
  assert.equal(adapter.available(), false)
  assert.equal(await adapter.embed(['a']), null)
  assert.equal(calls.length, 0)
  assert.equal(logs.filter((l) => l.includes('维度非法')).length, 1)
})

// ── 分片存储 ────────────────────────────────────────────────────────────────

test('分片读写往返一致：encode → load → get 逐元素相等，清单与槽位对得上', async () => {
  const s = scratch()
  try {
    const dim = 3
    const vec = (n: number): number[] => [n, n + 0.5, n - 0.25]
    const entries = new Map<string, readonly [number, number]>([['m_a', [0, 0]], ['m_b', [0, 1]], ['m_c', [1, 0]]])
    const file = path.join(s.dir, VEC_FILE_NAME)
    const manifestFile = path.join(s.dir, VEC_MANIFEST_NAME)
    await atomicWriteFile(file, encodeVectorFile(dim, [
      [Float32Array.from(vec(1)), Float32Array.from(vec(2))],
      [Float32Array.from(vec(3))],
    ], { capacity: 2, generation: 7 }))
    await atomicWriteJson(manifestFile, manifestFor(dim, 7, entries))

    const logs: string[] = []
    const { index } = await loadVectorIndex({ file, manifestFile, dim, log: (l) => logs.push(l) })
    assert.equal(index.size(), 3)
    assert.equal(index.all().length, 3)
    assert.deepEqual([...index.get('m_a')!], vec(1))
    assert.deepEqual([...index.get('m_b')!], vec(2))
    assert.deepEqual([...index.get('m_c')!], vec(3))
    assert.equal(index.get('查无此条'), null)
    assert.deepEqual(logs, [], '健康的文件不该产生任何日志')
  } finally { s.cleanup() }
})

test('坏分片：跳过坏的那片、其余照用；重建把丢掉的补回来', async () => {
  const s = scratch()
  try {
    const dim = 2
    const ids = ['m_a', 'm_b', 'm_c', 'm_d', 'm_e']
    const entries = new Map<string, readonly [number, number]>(
      ids.map((id, i): [string, readonly [number, number]] => [id, [Math.floor(i / 2), i % 2]]),
    )
    const file = path.join(s.dir, VEC_FILE_NAME)
    const manifestFile = path.join(s.dir, VEC_MANIFEST_NAME)
    const buf = encodeVectorFile(dim, [
      [Float32Array.from([1, 0]), Float32Array.from([0, 1])],
      [Float32Array.from([0.5, 0.5]), Float32Array.from([0.25, 0.75])],
      [Float32Array.from([1, 1])],
    ], { capacity: 2, generation: 1 })
    buf.write('XXXX', 64 + (16 + 2 * dim * 4), 'ascii') // 弄坏中间分片的子头
    await atomicWriteFile(file, buf)
    await atomicWriteJson(manifestFile, manifestFor(dim, 1, entries))

    const logs: string[] = []
    const { index } = await loadVectorIndex({ file, manifestFile, dim, log: (l) => logs.push(l) })
    assert.equal(index.size(), 3, '坏片的两条被跳过，其余两片照用')
    assert.equal(index.get('m_c'), null)
    assert.equal(index.get('m_d'), null)
    assert.equal(logs.filter((l) => l.includes('部分向量不可用')).length, 1)

    // 重建：坏片丢掉的记录按"缺向量"重新嵌入，索引恢复完整。
    const { port } = fakeEmbedder(dim, () => [1, 1])
    const result = await rebuildMemoryVectors({
      records: ids.map((id) => record(id, `内容 ${id}`)),
      embed: port, dir: s.dir, log: (l) => logs.push(l), shardCapacity: 2,
    })
    assert.deepEqual(result.failed, [])
    assert.equal(result.records, 5)
    assert.equal(result.embedded, 2, '只有坏片里的两条重新嵌了')
    const after = await loadVectorIndex({ file, manifestFile, dim, log: (l) => logs.push(l) })
    assert.equal(after.index.size(), 5)
    assert.deepEqual([...after.index.get('m_c')!], [1, 1])
  } finally { s.cleanup() }
})

test('半截文件：被截断的尾片跳过，前面的分片照常可用', async () => {
  const s = scratch()
  try {
    const dim = 2
    const file = path.join(s.dir, VEC_FILE_NAME)
    const manifestFile = path.join(s.dir, VEC_MANIFEST_NAME)
    const entries = new Map<string, readonly [number, number]>([['m_a', [0, 0]], ['m_b', [0, 1]], ['m_c', [1, 0]]])
    const buf = encodeVectorFile(dim, [
      [Float32Array.from([1, 0]), Float32Array.from([0, 1])],
      [Float32Array.from([1, 1])],
    ], { capacity: 2, generation: 1 })
    await atomicWriteFile(file, buf)
    truncateSync(file, buf.length - 3)
    await atomicWriteJson(manifestFile, manifestFor(dim, 1, entries))
    const logs: string[] = []
    const { index } = await loadVectorIndex({ file, manifestFile, dim, log: (l) => logs.push(l) })
    assert.equal(index.size(), 2)
    assert.equal(index.get('m_c'), null)
    assert.equal(logs.some((l) => l.includes('部分向量不可用')), true)
  } finally { s.cleanup() }
})

test('整份拒绝：维度不符 / 代际不符 / magic 不对 → 退回"没有向量"并记日志', async () => {
  const s = scratch()
  try {
    const dim = 4
    const file = path.join(s.dir, VEC_FILE_NAME)
    const manifestFile = path.join(s.dir, VEC_MANIFEST_NAME)
    const entries = new Map<string, readonly [number, number]>([['m_a', [0, 0]]])
    const logs: string[] = []

    await atomicWriteFile(file, encodeVectorFile(3, [[Float32Array.from([1, 2, 3])]], { capacity: 2, generation: 1 }))
    await atomicWriteJson(manifestFile, manifestFor(3, 1, entries))
    const wrongDim = await loadVectorIndex({ file, manifestFile, dim, log: (l) => logs.push(l) })
    assert.equal(wrongDim.index.size(), 0, '维度与配置不符 → 整份拒绝')
    assert.equal(logs.some((l) => l.includes('维度与配置不符')), true)

    await atomicWriteFile(file, encodeVectorFile(dim, [[Float32Array.from([1, 0, 0, 0])]], { capacity: 2, generation: 1 }))
    await atomicWriteJson(manifestFile, manifestFor(dim, 2, entries)) // 模拟"换了文件、还没换清单"的窗口
    const stale = await loadVectorIndex({ file, manifestFile, dim, log: (l) => logs.push(l) })
    assert.equal(stale.index.size(), 0, '代际不一致 → 整份拒绝（绝不按老坐标读新文件）')

    await atomicWriteFile(file, Buffer.from('这不是向量文件。'.repeat(40), 'utf8'))
    await atomicWriteJson(manifestFile, manifestFor(dim, 1, entries))
    const garbage = await loadVectorIndex({ file, manifestFile, dim, log: (l) => logs.push(l) })
    assert.equal(garbage.index.size(), 0)
    assert.equal(logs.some((l) => l.includes('magic 不符')), true)
  } finally { s.cleanup() }
})

test('清单缺失：vec.bin 在也能不炸——向量暂不可用、有日志说明', async () => {
  const s = scratch()
  try {
    const dim = 2
    const file = path.join(s.dir, VEC_FILE_NAME)
    await atomicWriteFile(file, encodeVectorFile(dim, [[Float32Array.from([1, 0])]], { capacity: 2, generation: 1 }))
    const logs: string[] = []
    const { index } = await loadVectorIndex({ file, manifestFile: path.join(s.dir, VEC_MANIFEST_NAME), dim, log: (l) => logs.push(l) })
    assert.equal(index.size(), 0)
    assert.equal(logs.filter((l) => l.includes('清单')).length, 1)
  } finally { s.cleanup() }
})

// ── 重建（增量 / 失败清单 / 断点可续）────────────────────────────────────────

test('重建：增量复用（不重复嵌入）；失败进清单；重跑只用补齐——断点可续', async () => {
  const s = scratch()
  try {
    const dim = 4
    const records = [record('m_1', '内容一'), record('m_2', '内容二'), record('m_3', '内容三')]
    const failing = new Set(['内容三'])
    const { port, texts } = fakeEmbedder(dim, (t) => (failing.has(t) ? null : [1, 0, 0, 0]))

    const first = await rebuildMemoryVectors({ records, embed: port, dir: s.dir, log: () => {}, batchSize: 2, shardCapacity: 2 })
    assert.deepEqual(first.failed, ['m_3'])
    assert.equal(first.embedded, 2)
    assert.equal(first.records, 2)

    const file = path.join(s.dir, VEC_FILE_NAME)
    const manifestFile = path.join(s.dir, VEC_MANIFEST_NAME)
    const afterFirst = await loadVectorIndex({ file, manifestFile, dim, log: () => {} })
    assert.equal(afterFirst.index.size(), 2)
    assert.equal(afterFirst.index.get('m_3'), null)

    texts.length = 0
    failing.clear()
    const second = await rebuildMemoryVectors({ records, embed: port, dir: s.dir, log: () => {}, batchSize: 2, shardCapacity: 2 })
    assert.equal(second.embedded, 1, '只补缺的那条')
    assert.deepEqual(texts, ['内容三'], '已有向量的记录不重新嵌入')
    const afterSecond = await loadVectorIndex({ file, manifestFile, dim, log: () => {} })
    assert.equal(afterSecond.index.size(), 3)
    assert.notEqual(afterSecond.index.get('m_3'), null)
  } finally { s.cleanup() }
})

// ── 混合检索 ────────────────────────────────────────────────────────────────

test('混合召回：关键词零重叠、向量相似也能进（关着向量时召不回）', async () => {
  const s = scratch()
  try {
    const dim = 4
    const store = await storeWith(s.dir, [record('m_a', '暗号是紫色灯笼')])
    const plain = await retrieverFor(store, []).retrieve({ text: '今天的天气怎么样', now: NOW, room: null })
    assert.equal(plain.evidence, '', '基线：关键词路径召不回')

    const { port } = fakeEmbedder(dim, () => [1, 0, 0, 0])
    const { index } = await loadIndexWith(s.dir, dim, [['m_a', [1, 0, 0, 0]]])
    const hybrid = await retrieverFor(store, [], createVectorRecall(port, index, 1))
      .retrieve({ text: '今天的天气怎么样', now: NOW, room: null })
    assert.match(hybrid.evidence, /暗号是紫色灯笼/, '向量相似度让它进了注入')
  } finally { s.cleanup() }
})

test('链接扩展：邻居相关性必须 > 0.35（只有上下文的邻居不再被拉进来）', async () => {
  const s = scratch()
  try {
    const dim = 2
    const old = NOW - 800 * DAY
    // 50 条低分陪跑（tag 命中 0.75，但重要度低、久未召回 → 分数低），把 m_z 挤到关键词 top-50 之外。
    const sparring = Array.from({ length: 50 }, (_, i) =>
      record(`m_a${String(i).padStart(2, '0')}`, `陪跑第 ${i} 条`, { tags: ['部署'], importance: 1 }, old))
    const store = await storeWith(s.dir, [
      ...sparring,
      record('m_z', '排在 top-50 之外的强相关记录', { tags: ['部署'], importance: 10 }),
      record('m_ctx', '只沾了上下文的邻居', { context: '部署的旁支线索', importance: 10 }),
      record('m_seed', '关于部署的种子记录', { keywords: ['部署'], links: ['m_z', 'm_ctx'], importance: 10 }),
    ])
    const { port } = fakeEmbedder(dim, () => [1, 0])
    const { index } = await loadIndexWith(s.dir, dim, [['m_seed', [1, 0]]])
    const got = await retrieverFor(store, [], createVectorRecall(port, index, 1))
      .retrieve({ text: '部署', now: NOW, room: null })
    const ids = got.picked.map((r) => r.id)
    assert.ok(ids.includes('m_seed'))
    assert.ok(ids.includes('m_z'), '被 top-50 挤掉但相关性 0.75 > 0.35 的邻居经链接扩展回来')
    assert.ok(!ids.includes('m_ctx'), '只有 0.25 的上下文邻居不过 0.35 门槛（e1 门槛 >0 时会被拉进来）')
  } finally { s.cleanup() }
})

test('缺向量的记录：相关性退回关键词重叠度（索引里的陈旧条目被安静跳过）', async () => {
  const s = scratch()
  try {
    const dim = 4
    const store = await storeWith(s.dir, [record('m_kw', '学弟喜欢冰美式', { keywords: ['冰美式'] })])
    const { port } = fakeEmbedder(dim, () => [1, 0, 0, 0])
    // 索引里还有一条 store 里已不存在的记录（被删/被遗忘的旧向量）——应当被安静跳过。
    const { index } = await loadIndexWith(s.dir, dim, [['m_gone', [1, 0, 0, 0]]])
    const got = await retrieverFor(store, [], createVectorRecall(port, index, 1))
      .retrieve({ text: '冰美式', now: NOW, room: null })
    assert.deepEqual(got.picked.map((r) => r.id), ['m_kw'])
    assert.match(got.evidence, /冰美式/)
  } finally { s.cleanup() }
})

test('服务不可用 → 自动退回关键词，输出与"关着向量"逐字节一致，且只记一行', async () => {
  const a = scratch()
  const b = scratch()
  try {
    const records = [
      record('m_a', '学弟喜欢冰美式', { keywords: ['冰美式'], subject: { type: 'user', id: 1 } }),
      record('m_b', '部署走 rsync 增量', { keywords: ['部署'] }),
    ]
    const storeA = await storeWith(a.dir, records)
    const logs: string[] = []
    const storeB = await storeWith(b.dir, records, (l) => logs.push(l))

    const baseline = await retrieverFor(storeA, []).retrieve({ text: '冰美式怎么喝', now: NOW, room: null })

    const { http, calls } = httpStub(() => ({ fail: 'ECONNREFUSED' }))
    const adapter = createEmbedAdapter({ baseUrl: 'http://127.0.0.1:17861', dim: 4, log: (l) => logs.push(l), http, now: () => 1_000 })
    const { index } = await loadIndexWith(b.dir, 4, [['m_b', [1, 0, 0, 0]]])
    const retriever = retrieverFor(storeB, logs, createVectorRecall(adapter, index, 1))

    const first = await retriever.retrieve({ text: '冰美式怎么喝', now: NOW, room: null })
    const second = await retriever.retrieve({ text: '冰美式怎么喝', now: NOW, room: null })

    assert.equal(first.evidence, baseline.evidence, '逐字节一致')
    assert.equal(second.evidence, baseline.evidence)
    assert.deepEqual(first.picked.map((r) => r.id), baseline.picked.map((r) => r.id))
    assert.equal(calls.length, 1, '冷却期内第二次不再碰网络')
    assert.equal(logs.filter((l) => l.includes('embed 服务不可用')).length, 1, '只记一行')
  } finally { a.cleanup(); b.cleanup() }
})

// ── 打分与相关性 ────────────────────────────────────────────────────────────

test('打分不随批次组成变化：单独 vs 混批，分数与三项因子都相同', () => {
  const a = record('m_a', '甲', { importance: 5 })
  const b = record('m_b', '乙', { importance: 9 })
  const alone = rankCandidates([{ record: a, relevance: 0.4 }], NOW)
  const mixed = rankCandidates([{ record: a, relevance: 0.4 }, { record: b, relevance: 0.9 }], NOW)
  const got = mixed.find((c) => c.record.id === 'm_a')!
  assert.equal(alone[0]!.score, got.score)
  assert.deepEqual(alone[0]!.parts, got.parts)
})

test('余弦与混合相关性：天然 [0,1]、缺向量退回关键词、权重 1 = 纯余弦', () => {
  assert.equal(cosineSimilarity(Float32Array.from([1, 0]), Float32Array.from([1, 0])), 1)
  assert.equal(cosineSimilarity(Float32Array.from([1, 0]), Float32Array.from([0, 1])), 0)
  assert.equal(cosineSimilarity(Float32Array.from([1, 0]), Float32Array.from([1, 0, 0])), 0, '维度不符当没关系')
  assert.equal(blendedRelevance(null, 0.5, 1), 0.5, '缺向量 → 纯关键词')
  assert.equal(blendedRelevance(0.8, 0.2, 1), 0.8, '权重 1 = 纯余弦（不做 min-max）')
  assert.equal(blendedRelevance(1, 0, 0.5), 0.5, '权重 0.5 → 余弦与关键词各一半')
})
