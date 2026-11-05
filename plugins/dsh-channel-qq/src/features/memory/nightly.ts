/** 夜间巩固（P6e·e3，09 §6.2）：八个 job。
 *
 * 全部注册成**事件书**（P6f）的 `kind: job`——什么时候跑、跑不跑由那本书决定
 * （默认书里有对应事件，见 `core/schedule/event-book.ts`），本文件只管"跑起来做什么"。
 * 于是"昨天 04:20 为什么没抽日记"这个问题的答案在事件书的状态里（`skipped:<原因>`），
 * 不在某个藏在代码里的 if。
 *
 * 三条纪律：
 *   - **够不到模型就具名跳过**（`no-extractor`），绝不假装做了——抽取/反思都走
 *     现有那条抽取通道（`knowledge.ts` 的 route），它没配就是没配；
 *   - **候选不直接生效**：反思产物落 `status='candidate'`，等主人在后台审核（D4）；
 *   - **失败只进日志**：单个 job 抛错由执行器兜住（`failed:<原因>`），不影响对话。
 *
 * 开关关着时这八个 job 仍然注册（默认书里一直列着它们）——那时它们回一句
 * `skipped:memory-v2-off`，而不是 `failed:unknown-job` 那种"看起来坏了"的结果。
 *
 * 已知边界（写在明面上，不假装完整）：
 *   - "链接演化"只做了**建链接**（确定性）；按 A-MEM 把邻居的 keywords/context
 *     回写需要模型，本轮跳过；
 *   - 去重用的是**关键词重叠代理**（0.9），不是设计里的向量 0.92 + LLM 裁决
 *     （0.75–0.92 那段需要模型）——e2 的向量只接了检索，没接写入路径。
 */

import { withHit, type MemoryStatus, type MemorySource } from '../../core/memory/model.js'
import { distillFact } from '../../core/memory/distill.js'
import { applyMerge, mergeNote, planMerges } from '../../core/memory/consolidate.js'
import {
  archiveNote, buildLinks, findConflicts, pickForDigest, renderDigest, splitForArchive,
  DIGEST_MAX_BYTES,
} from '../../core/memory/nightly.js'
import { formatLocalStamp, localDayKey } from '../../core/schedule/stamp.js'
import { readSessionLog } from '../../paths.js'
import type { EmbedPort } from '../../ports/memory.js'
import { registerJob, type JobContext, type JobHandler, type JobOutcome } from '../proactive/jobs.js'
import { rebuildMemoryVectors } from './rebuild.js'
import { chunksOfDay } from './session-split.js'
import { indexWorkspaceChunks } from './chunks.js'
import { appendConsolidationLog, freezeConflicts } from './consolidate-io.js'
import type { MemoryStore } from './store.js'
import {
  appendArchive, findNearDuplicate, readDiary, toNewRecord, writeDigestFile,
  type ExtractedItem,
} from './nightly-io.js'

/** 日记太短就不抽（与旧抽取任务同一门槛：几行字的日记抽不出东西）。 */
const MIN_DIARY_CHARS = 50

/** 反思的输入门槛：低于它没有"归纳"的意义（Generative Agents 的精神是"攒够了再想"）。 */
const MIN_REFLECT_RECORDS = 6

/** 参与反思的门槛与回顾窗口（§6.2：最近 7 天 importance ≥ 7）。 */
const REFLECT_MIN_IMPORTANCE = 7
const REFLECT_WINDOW_MS = 7 * 86_400_000

/** 老知识库的窄契约（双写用）。 */
export interface LegacyWriterLike {
  addMany(items: Array<{ type: string; content: string; tags: string[]; source: string }>): Promise<number>
}

export interface NightlyDeps {
  /**
   * 记忆库；**null = `memory.v2` 关着**。
   *
   * 做成取值函数而不是直接给实例，是因为这八个 job 在开关关着时也注册（默认书里
   * 一直列着它们）——那时它们要能回一句 `skipped:memory-v2-off`。
   */
  readonly store: () => MemoryStore | null
  /** 老知识库（双写目标）；null = 没有（只写新库）。 */
  readonly legacy: LegacyWriterLike | null
  readonly log: (line: string) => void
  /** 工作区根；null = 没配（日记/DIGEST 都写不成，具名跳过）。 */
  readonly workspace: () => string | null
  /** 抽取通道配好了吗（`resolveExtractorRoute() !== null`）。 */
  readonly extractorReady: () => boolean
  /** 走抽取通道；未配置时调用方不该被调到（由 `extractorReady` 先挡）。 */
  readonly extract: (source: string, text: string) => Promise<ExtractedItem[]>
  /** 向量重建用的嵌入器；**null = 没配**（`memory.vectorEnabled` 关着，或装配失败）。 */
  readonly embed: () => EmbedPort | null
  /** 要扫的房间键（主群 / 主人私聊）。 */
  readonly rooms: () => readonly string[]
  readonly random: () => number
}

/** 注册全部八个 job；返回反注册函数（卸载插件时调用）。 */
export function registerNightlyJobs(deps: NightlyDeps): () => void {
  /** 开关关着 → 一句具名跳过；开着 → 把库交给真正的实现。 */
  const withStore = (
    run: (deps: NightlyDeps, store: MemoryStore, ctx: JobContext) => Promise<JobOutcome>,
  ): JobHandler => async (ctx) => {
    const store = deps.store()
    if (store === null) return { skipped: 'memory-v2-off' }
    return await run(deps, store, ctx)
  }
  const offs = [
    registerJob('memory.chunks', withStore(indexChunks)),
    registerJob('memory.diary-extract', withStore(diaryExtract)),
    registerJob('memory.session-split', withStore(sessionSplit)),
    registerJob('memory.consolidate', withStore(consolidate)),
    registerJob('memory.reflect', withStore(reflect)),
    registerJob('memory.links', withStore((d, s) => links(d, s))),
    registerJob('memory.contradictions', withStore(contradictions)),
    registerJob('memory.forget', withStore(forget)),
    registerJob('memory.digest', withStore(digest)),
    registerJob('memory.reindex', withStore((d, s) => reindex(d, s))),
  ]
  return () => { for (const off of offs) off() }
}

/** 抽取条目入库：重复的（重叠 ≥ 0.9）只强化，新的建档；顺带双写老库。 */
async function ingest(
  deps: NightlyDeps,
  store: MemoryStore,
  items: readonly ExtractedItem[],
  source: MemorySource,
  now: number,
  opts: { status?: MemoryStatus; importance?: number } = {},
): Promise<{ added: number; hit: number }> {
  let added = 0
  let hit = 0
  const fresh: ExtractedItem[] = []
  for (const item of items) {
    // P0 的写入侧蒸馏：抽出来的先去壳成 ≤80 字短事实，再谈去重。
    // 去重判据跑在**蒸馏后**的内容上，"同一段话的两种啰嗦说法"才能认出彼此。
    const content = distillFact(item.content)
    if (content.length < 4) continue
    const duplicate = findNearDuplicate(store, content)
    if (duplicate !== null) {
      await store.put(withHit(duplicate, now))
      hit += 1
      continue
    }
    await store.remember(toNewRecord({ ...item, content }, source, opts), now, deps.random)
    fresh.push({ ...item, content })
    added += 1
  }
  await mirrorToLegacy(deps, fresh, source)
  return { added, hit }
}

/** 双写老知识库（换开关那天不该出现"记忆页空了"）；失败只记日志。 */
async function mirrorToLegacy(deps: NightlyDeps, items: readonly ExtractedItem[], source: MemorySource): Promise<void> {
  if (deps.legacy === null || items.length === 0) return
  try {
    await deps.legacy.addMany(items.map((item) => ({
      type: item.type,
      content: item.content,
      tags: [...item.tags],
      source: source.file ?? source.room ?? source.kind,
    })))
  } catch (error) {
    deps.log(`memory: 夜间任务双写老知识库失败（新库已写入）：${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 04:20 日记抽取：当天日记 → 记录。 */
async function diaryExtract(deps: NightlyDeps, store: MemoryStore, ctx: JobContext): Promise<JobOutcome> {
  if (!deps.extractorReady()) return { skipped: 'no-extractor' }
  // **昨天的日记**：日记从每天 00:01 起写，而这个 job 在 04:20 跑——用"今天"
  // 只能看到开头几小时（实测 10-17 那天只抽到 5/147 段 = 3.4%）。与下面
  // sessionSplit 的口径一致：昨天整天的内容，今天凌晨处理。
  const day = localDayKey(new Date(ctx.now.getTime() - 86_400_000))
  const diary = await readDiary(deps.workspace(), day)
  if (diary.trim().length < MIN_DIARY_CHARS) return { skipped: 'diary-too-short' }
  const items = await deps.extract(`日记 ${day}`, diary)
  if (items.length === 0) return { skipped: 'nothing-extracted' }
  const { added, hit } = await ingest(deps, store, items, { kind: 'diary', file: `memory/${day}.md` }, ctx.now.getTime())
  return { note: `日记抽取 ${day}：${items.length} 条（新增 ${added}，命中已有 ${hit}）` }
}

/** 04:40 会话分解：昨天的会话原件 → 回合块 → 记录（出处带房间）。 */
async function sessionSplit(deps: NightlyDeps, store: MemoryStore, ctx: JobContext): Promise<JobOutcome> {
  if (!deps.extractorReady()) return { skipped: 'no-extractor' }
  const workspace = deps.workspace()
  const day = localDayKey(new Date(ctx.now.getTime() - 86_400_000))
  let blocks = 0
  let added = 0
  let hit = 0
  for (const room of deps.rooms()) {
    const jsonl = await readSessionLog(workspace ?? undefined, `qq-${room}`)
    if (jsonl === null) continue
    for (const chunk of chunksOfDay(jsonl, room, day)) {
      blocks += 1
      const items = await deps.extract(`会话 ${room} ${day}`, chunk.text)
      const got = await ingest(deps, store, items, { kind: 'chat', room, sessionId: `qq-${room}` }, chunk.start, { importance: 4 })
      added += got.added
      hit += got.hit
    }
  }
  if (blocks === 0) return { skipped: 'no-chat-yesterday' }
  return { note: `会话分解 ${day}：${blocks} 块 → 新增 ${added}，命中已有 ${hit}` }
}

/**
 * 04:55 巩固：合并"同一件事的两种说法"、冻结疑似冲突（P1）。
 *
 * 顺序在 session-split（04:40）之后、reflect（05:10）之前：白天和昨天刚进来的
 * 记录先合并一遍，反思看到的就不是满库重复。合并是**可逆的**（drop 走 supersede，
 * 历史可回查），所以自动执行；冲突只冻结不处置（等主人拍板）。
 */
async function consolidate(deps: NightlyDeps, store: MemoryStore, ctx: JobContext): Promise<JobOutcome> {
  const now = ctx.now.getTime()
  const plans = planMerges(store.all())
  let merged = 0
  for (const plan of plans) {
    await store.put(...applyMerge(plan, now))
    await appendConsolidationLog(store.dir, { at: now, action: 'merge', note: mergeNote(plan) }, deps.log)
    merged += 1
    if (merged >= 40) break // 一晚最多合 40 对：宁渐进，不一夜大改
  }
  const frozen = await freezeConflicts(store.dir, findConflicts(store.all()).slice(0, 20), now)
  if (merged === 0 && frozen === 0) return { note: '巩固：没有需要合并或冻结的' }
  return { note: `巩固：合并 ${merged} 对，新冻结 ${frozen} 对疑似冲突（等主人裁决）` }
}

/** 05:10 反思：近 7 天的高重要性记录 → 归纳成候选（等人审核，不直接生效）。 */
async function reflect(deps: NightlyDeps, store: MemoryStore, ctx: JobContext): Promise<JobOutcome> {
  if (!deps.extractorReady()) return { skipped: 'no-extractor' }
  const now = ctx.now.getTime()
  const highlights = store.all().filter((r) =>
    r.status === 'active' && r.importance >= REFLECT_MIN_IMPORTANCE && now - r.recordedAt <= REFLECT_WINDOW_MS)
  if (highlights.length < MIN_REFLECT_RECORDS) return { skipped: 'too-few-highlights' }
  const text = highlights.map((r) => `（${r.kind}）${r.content}`).join('\n').slice(0, 1500)
  const items = await deps.extract('反思输入', text)
  if (items.length === 0) return { skipped: 'nothing-extracted' }
  const { added, hit } = await ingest(deps, store, items, { kind: 'reflect' }, now, { status: 'candidate', importance: REFLECT_MIN_IMPORTANCE })
  return { note: `反思候选：${items.length} 条（新增候选 ${added}，命中已有 ${hit}）——等主人在后台审核` }
}

/** 05:30 链接：确定性建 links（演化回写 keywords/context 需要模型，跳过并说明）。 */
async function links(deps: NightlyDeps, store: MemoryStore): Promise<JobOutcome> {
  const changed = buildLinks(store.all())
  if (changed.length === 0) return { note: '链接：没有新增' }
  await store.put(...changed)
  return { note: `链接：${changed.length} 条记录挂上了新邻居（keywords/context 的回写要模型，本轮跳过）` }
}

/** 05:50 矛盾扫描：检出疑似冲突对 → 冻结进队列（P1 前只报日志，两条并存）。 */
async function contradictions(deps: NightlyDeps, store: MemoryStore, ctx: JobContext): Promise<JobOutcome> {
  const pairs = findConflicts(store.all())
  if (pairs.length === 0) return { note: '矛盾扫描：没有疑似冲突' }
  const frozen = await freezeConflicts(store.dir, pairs.slice(0, 50), ctx.now.getTime())
  return frozen > 0
    ? { note: `矛盾扫描：检出 ${pairs.length} 对，新冻结 ${frozen} 对（队列里等主人裁定）` }
    : { note: `矛盾扫描：${pairs.length} 对疑似冲突都已在队列里` }
}

/** 06:05 遗忘与归档：R < 0.05 且没被钉住的记录转 archived，正文进归档文件。 */
/** 03:50 原文分块：把工作区 md 切成 600 字块记录（块覆盖行多，命中面比句子大）。 */
async function indexChunks(deps: NightlyDeps, store: MemoryStore, ctx: JobContext): Promise<JobOutcome> {
  const workspace = deps.workspace()
  if (workspace === null || workspace === '') return { skipped: 'no-workspace' }
  let n = 0
  const got = await indexWorkspaceChunks(store, {
    workspace,
    now: ctx.now.getTime(),
    // 块的 id 由"文件 + 序号"决定，roll 只影响 makeRecord 的兜底 id，这里给可重放的序列。
    roll: () => ((n++ % 997) / 997),
    log: deps.log,
  })
  if (got.files === 0) return { skipped: 'no-markdown' }
  return { note: `原文分块：${got.files} 个文件 / ${got.chunks} 块（归档 ${got.archived}）` }
}

/** 06:05 遗忘归档：R < 0.05 且没被钉住的 → archived，并追加到 `.jsonl.gz`。 */
async function forget(deps: NightlyDeps, store: MemoryStore, ctx: JobContext): Promise<JobOutcome> {
  const now = ctx.now.getTime()
  const { archive } = splitForArchive(store.all(), now)
  if (archive.length === 0) return { note: '遗忘：没有到期需要归档的' }
  const file = await appendArchive(
    store.dir,
    archive.map((record) => ({ record, note: archiveNote(record, now) })),
    now,
  )
  await store.put(...archive.map((record) => ({ ...record, status: 'archived' as const })))
  return { note: `遗忘：归档 ${archive.length} 条（仍在 ${file} 里可查）` }
}

/** 06:20 DIGEST：核心记忆摘要（≤ 8KB，整条截断）写 `memory/DIGEST.md`。 */
async function digest(deps: NightlyDeps, store: MemoryStore, ctx: JobContext): Promise<JobOutcome> {
  const workspace = deps.workspace()
  if (workspace === null || workspace === '') return { skipped: 'no-workspace' }
  const picks = pickForDigest(store.all(), ctx.now.getTime())
  const text = renderDigest(picks, { generatedAt: formatLocalStamp(ctx.now), maxBytes: DIGEST_MAX_BYTES })
  const file = await writeDigestFile(workspace, text)
  return { note: `DIGEST：${picks.length} 条候选 → ${file}` }
}

/** 06:30 索引重建：增量嵌新记录、写分片（embed 服务不在就具名跳过）。 */
async function reindex(deps: NightlyDeps, store: MemoryStore): Promise<JobOutcome> {
  const embed = deps.embed()
  if (embed === null) return { skipped: 'no-embed' }
  const records = store.all().filter((r) => r.status !== 'archived')
  const result = await rebuildMemoryVectors({ dir: store.dir, records, embed, log: deps.log })
  return { note: `向量索引：${result.records} 条（新嵌 ${result.embedded}，失败 ${result.failed.length}）` }
}
