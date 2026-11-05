/** 记忆子插件：旧知识库（默认行为）+ 新记忆系统（`memory.v2`，P6e）。
 *
 * 两条轨并排跑，由 `memory.v2` 决定走哪条：
 *
 *   - **关**（默认）：阶段二知识库原样——`entries.json` + 关键词检索 + 后台
 *     「长期记忆」「日记」两张表。`qq_recall_memory` / `qq_memorize_fact` 走它。
 *   - **开**：`core/memory/*` 的结构化记录（双时间轴、矛盾退役、遗忘曲线）落
 *     `knowledge/records.jsonl`；每回合自动注入 3–8 条证据（≤600 字）；两个工具
 *     改走结构化召回与写入；**同时双写旧库**，所以后台那两张表不会空。
 *
 * 为什么不是"直接换掉"：换开关那天不该出现"记忆页空了"或"检索突然变了"两种
 * 意外同时发生。开关默认关（P6 的规矩），线上行为在打开之前逐字节不变。
 *
 * e1 只做到"记录模型 + 存储 + 关键词检索 + 注入"；e2 在其上加了向量：本机 embed
 * 服务客户端 + 分片 `vec.bin` + 混合打分，开关是 `memory.vectorEnabled`（默认关，
 * 关着时检索与 e1 逐字节一致；开着但服务不可用时自动退回关键词）；夜间巩固、
 * 遗忘与 MEMORY.md 迁移是 e3（见 内部文档 的落地分期）。
 */

import { KnowledgeStore, resolveExtractorRoute, extractFromText } from '../../knowledge.js'
import { isChunkRecord, type MemoryRecord } from '../../core/memory/model.js'
import { findConflicts } from '../../core/memory/nightly.js'
import type { Json } from '../../admin/config-engine.js'
import type { EmbedPort } from '../../ports/memory.js'
import { MemoryRetriever } from './retriever.js'
import { migrateMemoryFile } from './migrate.js'
import { promoteToSkill } from './promote.js'
import { registerNightlyJobs } from './nightly.js'
import { MemoryStore } from './store.js'
import { importLegacyEntries } from './import-legacy.js'
import { buildProfile, renderProfile } from '../../core/memory/profile.js'
import { createMemoryService } from './service.js'
import { wireInjectionV3 } from './inject-v3.js'
import { VEC_MANIFEST_NAME } from './vector-store.js'
import { setupVectors } from './vectors-setup.js'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { SubHost, SubPlugin } from '../plugin-kit.js'

export const memoryPlugin: SubPlugin = {
  name: 'memory',
  // 这些点一变就重挂本插件：记忆系统的开关、注入预算、向量参数都是"改了要立刻生效"的。
  watches: [
    'memory.v2', 'memory.threshold', 'memory.maxRecords', 'memory.maxChars',
    'memory.profiles', 'memory.pinnedEnabled', 'memory.wanderPercent', 'memory.occasionsEnabled',
    'memory.captureEnabled', 'memory.captureDailyCap',
    'memory.vectorEnabled', 'memory.vectorUrl', 'memory.vectorDim', 'memory.vectorTimeoutMs', 'memory.vectorWeight',
    'memory.extractorUrl', 'memory.extractorModel', 'memory.extractorApiKey',
  ],
  async apply(host) {
    const workspacePath = host.config.workspacePath
    const store = new KnowledgeStore(host.dshHome, workspacePath, host.log)
    await store.load()
    // 抽取器的三项可以从后台「记忆」页填（留空回退环境变量）。仍然只解析一次：
    // "抽取器没配好"只在一处判定、只记一行日志。
    const m = host.config.memory
    const extractor = { baseUrl: m.extractorUrl, model: m.extractorModel, apiKey: m.extractorApiKey }
    const route = resolveExtractorRoute(extractor)
    if (route === null) {
      host.log('knowledge: extractor not configured (set CHANNEL_QQ_EXTRACTOR_BASE_URL and CHANNEL_QQ_EXTRACTOR_MODEL to enable)')
    }
    const extract = async (source: string, text: string): Promise<number> => {
      if (route === null) return 0
      const items = await extractFromText(route, source, text, host.log)
      return store.addMany(items)
    }
    host.provide('knowledge', { store, extract })

    // 夜间巩固的八个 job（P6e·e3）：**无条件注册**——默认事件书里一直列着它们，
    // 开关关着时每个 handler 自己回一句 `skipped:memory-v2-off`（比 unknown-job
    // 那种"看起来坏了"的结果清楚）。向量重建要的嵌入器在 v2 装配时才建，
    // 所以这里用取值函数，注册发生在装配之前也不会读到 undefined。
    const nightlyState: { store: MemoryStore | null; embed: EmbedPort | null } = { store: null, embed: null }
    const nightlyRoute = resolveExtractorRoute(extractor)
    const offNightly = registerNightlyJobs({
      store: () => nightlyState.store,
      legacy: store,
      log: host.log,
      workspace: () => host.config.workspacePath,
      extractorReady: () => nightlyRoute !== null,
      extract: async (source: string, text: string) => {
        if (nightlyRoute === null) return []
        return await extractFromText(nightlyRoute, source, text, host.log)
      },
      embed: () => nightlyState.embed,
      rooms: () => {
        const out: string[] = []
        if (host.config.primaryGroup !== null) out.push(`group-${host.config.primaryGroup}`)
        const master = host.config.admins[0]
        if (master !== undefined) out.push(`dm-${master}`)
        return out
      },
      random: Math.random,
    })

    if (host.config.memory.v2) {
      await attachMemoryV2(host, store, nightlyState, nightlyRoute)
    }

    registerPendingResource(host, nightlyState)
    registerStatsResource(host, nightlyState)
    registerLegacyResources(host, store, workspacePath)

    // 卸载时把八个 job 从注册表摘掉（同名重挂是"后者生效"，留着会让旧实例的
    // handler 继续接活——那时它的 store 引用已经过期了）。
    return () => { offNightly() }
  },
}

/**
 * 装配新记忆系统（`memory.v2`）。
 *
 * 三件东西一次挂上：
 *   - `memory`：工具面的召回与写入（`qq_recall_memory` / `qq_memorize_fact`）；
 *   - `memoryEvidence`：入站组包每回合的自动注入（3–8 条、≤600 字、按房间过滤）；
 *   - 后台「长期记忆」表改由 v2 记录填充（**不删旧库**，只是换数据源给它看）。
 *
 * 注入预算（条数/字数/阈值）取自配置：`segmentText` 那一课的教训是"面板上能改的
 * 东西必须真的被读到"，所以这里显式传下去，而不是用模块常量。
 */
/** B2：人物侧写解析器（5 分钟缓存，最多 500 人）。 */
function createProfileResolver(host: SubHost, store: MemoryStore): (id: number, name: string) => string {
  const cache = new Map<number, { at: number; text: string }>()
  const TTL_MS = 5 * 60_000
  const MAX = 500
  return (id, name) => {
    if (host.config.memory.profiles !== true) return ''
    const now = Date.now()
    const cached = cache.get(id)
    if (cached !== undefined && now - cached.at < TTL_MS) return cached.text
    const text = renderProfile(name === '' ? String(id) : name, buildProfile(store.all(), id))
    if (cache.size >= MAX) {
      const oldest = cache.keys().next().value
      if (typeof oldest === 'number') cache.delete(oldest)
    }
    cache.set(id, { at: now, text })
    return text
  }
}

async function attachMemoryV2(
  host: SubHost,
  legacy: KnowledgeStore,
  nightly: { store: MemoryStore | null; embed: EmbedPort | null },
  nightlyRoute: ReturnType<typeof resolveExtractorRoute>,
): Promise<void> {
  const { memory } = host.config
  const store = new MemoryStore({ workspacePath: host.config.workspacePath, dshHome: host.dshHome, log: host.log })
  const count = await store.load()
  nightly.store = store
  host.log(`memory.v2: ${count} 条结构化记忆已加载（${store.file}）`)
  // 新库为空而旧库有货：先导入，否则"打开 v2"在用户看来就是"知识全丢了"。
  if (count === 0 && legacy.entries.length > 0) {
    await importLegacyEntries(store, legacy.entries, { now: Date.now(), roll: Math.random, log: host.log })
  }

  const renderTime = (at: number): string => new Date(at).toISOString().slice(0, 10)
  const clock = { now: () => Date.now() }
  const service = createMemoryService({ store, log: host.log, renderTime, clock, legacy })
  const { recall: vectors, embed, bulk } = await setupVectors(host, store.dir)
  // 夜间重建用宽超时的适配器；回合内的查询仍走 800ms 的那个（见 setupVectors）。
  nightly.embed = bulk ?? embed
  const retriever = new MemoryRetriever({
    store,
    log: host.log,
    renderTime,
    clock,
    ...(vectors === undefined ? {} : { vectors }),
  })

  host.provide('memory', service)
  const profileFor = createProfileResolver(host, store)
  // 三层注入（P2/P3）：常驻 + 话题 + 走神，前置今天的日子；顺带造好即时抽取器。
  const { evidence, capture } = wireInjectionV3({
    host,
    store,
    retriever,
    affectionScore: () => {
      const affection = host.get('affection') as { read(): { score: number } } | undefined
      return affection === undefined ? null : affection.read().score
    },
    extract: nightlyRoute === null || host.config.memory.captureEnabled !== true
      ? undefined
      : async (source, text) => await extractFromText(nightlyRoute, source, text, host.log),
    profileFor: (id, name) => profileFor(id, name),
    clock,
    random: Math.random,
  })
  host.provide('memoryEvidence', evidence)
  host.provide('memoryCapture', capture)
  provideMemorySearch(host, retriever, renderTime)
}

/**
 * 深召回（`qq_memory_search`）：一次给 5–8 条**原文块**，愿意多花上下文换命中率。
 * 与自动注入的区别就在预算：这里 6000 字、同主题不限；注入仍然是 600 字/8 条短事实。
 */
function provideMemorySearch(host: SubHost, retriever: MemoryRetriever, renderTime: (at: number) => string): void {
  host.provide('memorySearch', async (query: string, limit?: number, asOf?: string) => {
    const k = Math.max(3, Math.min(8, Math.trunc(limit ?? 8) || 8))
    // asOf 时间旅行（P2）："那天我们是怎么想的"——解析失败就当没问。
    const asOfMs = asOf === undefined || asOf.trim() === '' ? undefined : Date.parse(asOf.trim())
    const got = await retriever.retrieve({
      text: query,
      room: null, // 深召回跨房间：群记忆与私聊记忆都要能翻到
      now: Date.now(),
      ...(asOfMs === undefined || Number.isNaN(asOfMs) ? {} : { asOf: asOfMs }),
      budget: { threshold: 0.2, maxRecords: k, maxChars: 6000, maxPerTopic: k },
      weights: { relevance: 1, importance: 0.3, recency: 0.2 },
    })
    // 块优先：深召回要的是"原文在哪"，短事实由 recall 负责。
    const picked = [...got.picked].sort((x, y) => Number(y.tags.includes('chunk')) - Number(x.tags.includes('chunk')))
    return picked.map((r) => ({
      content: r.content,
      kind: r.kind,
      source: `${r.source.file ?? r.source.room ?? ''}${r.source.line === undefined ? '' : `#L${r.source.line}`}`,
      date: renderTime(r.validFrom),
      chunk: r.tags.includes('chunk'),
    }))
  })
}

/**
 * 「记忆审核」页的数据面（P6e·e3，D4）：候选记录与疑似冲突对。
 *
 * 待处理 = 两类还没被主人确认过的记录：反思产出的候选（`status='candidate'`）、
 * 疑似冲突的记录对。**每次现算**——扫描是确定性的（`findConflicts`），不另存一份
 * 会与记录库漂移的队列文件。
 */
function registerPendingResource(host: SubHost, nightly: { store: MemoryStore | null }): void {
  const storeOf = (): MemoryStore | null => nightly.store
  host.registerResource('memory-pending', {
    label: '记忆审核',
    list: () => {
      const store = storeOf()
      if (store === null) return { candidates: [], conflicts: [], note: 'memory.v2 关着' }
      const all = store.all()
      const candidates = all.filter((r) => r.status === 'candidate')
      const pairs = findConflicts(all).slice(0, 50)
      return {
        candidates: candidates.map((r) => ({
          id: r.id, kind: r.kind, content: r.content,
          date: new Date(r.recordedAt).toISOString().slice(0, 10), source: r.source.kind,
        })),
        conflicts: pairs.map((p) => ({
          left: { id: p.left.id, content: p.left.content },
          right: { id: p.right.id, content: p.right.content },
          overlap: Number(p.overlap.toFixed(2)),
        })),
      }
    },
    actions: {
      approve: (body) => decideCandidate(storeOf(), body, 'active'),
      reject: (body) => decideCandidate(storeOf(), body, 'archived'),
      resolve: (body) => resolveConflict(storeOf(), body),
      migrate: () => runMigration(host, storeOf()),
      toSkill: (body) => promoteToSkill(host, storeOf(), body),
    },
  })
}

/**
 * 「索引状态」卡的数据面：结构记录数、原文块数、向量条数。
 *
 * 这些东西以前只存在于日志里——而「块索引到底建了没有」「向量索引是不是空的」
 * 恰恰决定了 `qq_memory_search` 好不好用，所以必须有地方能一眼看到。
 * `memory.v2` 关着时返回 `enabled: false`，页面照常显示"关着"。
 */
function registerStatsResource(host: SubHost, nightly: { store: MemoryStore | null }): void {
  host.registerResource('memory-stats', {
    label: '记忆索引状态',
    list: async () => {
      const store = nightly.store
      if (store === null) return { enabled: false, note: 'memory.v2 关着（深召回也不可用）' }
      const all = store.all()
      const chunks = all.filter((r) => r.tags.includes('chunk'))
      const active = all.filter((r) => r.status === 'active')
      const vectors = await countVectors(store.dir, host.config.memory.vectorDim)
      return {
        enabled: true,
        records: all.length,
        active: active.length,
        chunks: chunks.length,
        chunkActive: chunks.filter((r) => r.status === 'active').length,
        vectors,
        vectorEnabled: host.config.memory.vectorEnabled,
        storeFile: store.file,
      }
    },
  })
}

/** 向量索引里有多少条（清单缺失/维度不符都算 0——那是"还没建"而不是故障）。 */
async function countVectors(dir: string, dim: number): Promise<number> {
  const raw = await fs.readFile(path.join(dir, VEC_MANIFEST_NAME), 'utf-8').catch(() => '')
  if (raw === '') return 0
  try {
    const parsed = JSON.parse(raw) as { dim?: number; entries?: Record<string, unknown> }
    return parsed.dim === dim ? Object.keys(parsed.entries ?? {}).length : 0
  } catch { return 0 }
}

/**
 * 老知识库的两个资源页（「长期记忆」「日记」）。
 *
 * e1 起 v2 记录会双写老库，所以这两张表在开关打开后仍然有数据——换开关那天不该
 * 出现"记忆页空了"。它们读的始终是老库（`KnowledgeStore`），不是新记录库。
 */
function registerLegacyResources(host: SubHost, store: KnowledgeStore, workspacePath: string | null): void {
  host.registerResource('memories', {
    label: '长期记忆',
    list: (query) => {
      const q = (query.get('q') ?? '').trim()
      const entries = q === '' ? store.entries.slice(-300).reverse() : store.search(q, 50)
      return { count: store.entries.length, entries }
    },
    create: async (body) => ({
      added: await store.addManual({
        type: body.type === undefined ? undefined : String(body.type),
        content: String(body.content ?? ''),
        tags: Array.isArray(body.tags) ? body.tags.map((t) => String(t)) : [],
        source: body.source === undefined ? undefined : String(body.source),
      }),
    }),
    remove: async (id) => ({ removed: await store.remove(id) }),
  })
  host.registerResource('diary', {
    label: '日记',
    list: async (query) => {
      if (workspacePath === null) return { diaries: [] }
      const dir = path.join(workspacePath, 'memory')
      const date = (query.get('date') ?? '').replace(/[^0-9-]/g, '')
      if (date !== '') {
        const content = await fs.readFile(path.join(dir, `${date}.md`), 'utf-8').catch(() => '')
        return { date, content }
      }
      const names = await fs.readdir(dir).catch(() => [] as string[])
      const diaries: Array<{ date: string; file: string }> = []
      for (const name of names) {
        if (!name.endsWith('.md') || !/^\d{4}-\d{2}-\d{2}/.test(name)) continue
        diaries.push({ date: name.slice(0, 10), file: path.join(dir, name) })
      }
      diaries.sort((a, b) => b.date.localeCompare(a.date))
      return { count: diaries.length, diaries: diaries.slice(0, 90) }
    },
  })
}

/** 通过/驳回一条候选：`candidate` → `active`（开始参与检索）或 `archived`（不删，可回查）。 */
async function decideCandidate(store: MemoryStore | null, body: Json, status: 'active' | 'archived'): Promise<unknown> {
  const record = store?.get(String(body.id ?? ''))
  if (store === null || record === undefined) return { ok: false, reason: '记录不存在' }
  if (status === 'active' && record.status !== 'candidate') return { ok: false, reason: `状态是 ${record.status}，不是候选` }
  await store.put({ ...record, status })
  return { ok: true, id: record.id, status }
}

/** 裁定一对疑似冲突：留下 keep，另一条 supersede（不删除，历史可回查）。 */
async function resolveConflict(store: MemoryStore | null, body: Json): Promise<unknown> {
  const winner = store?.get(String(body.keep ?? ''))
  const loser = store?.get(String(body.drop ?? ''))
  if (store === null || winner === undefined || loser === undefined) return { ok: false, reason: '记录不存在' }
  await store.put({ ...loser, status: 'superseded', supersededBy: winner.id, validTo: Date.now() })
  return { ok: true, kept: winner.id, superseded: loser.id }
}

/** D4 §7 的一次性迁移：冻结 MEMORY.md → 切分 → 落候选（等审核）。 */
async function runMigration(host: SubHost, store: MemoryStore | null): Promise<unknown> {
  if (store === null) return { ok: false, reason: 'memory.v2 关着' }
  return await migrateMemoryFile({
    workspace: host.config.workspacePath,
    dshHome: host.dshHome,
    store,
    log: host.log,
    now: new Date(),
    roll: Math.random,
  })
}
