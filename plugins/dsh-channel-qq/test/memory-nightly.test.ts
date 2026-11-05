/** P6e·e3 夜间巩固的测试：纯判据（遗忘/冲突/DIGEST/链接）、会话切分、八个 job。
 *
 * 五条不能少的性质：
 *   1. **遗忘是确定性的**：R = e^(−t/S)，钉住的永不归档，非 active 的一律不动；
 *   2. **冲突检出宁缺毋滥**：同主体同类**且**正文高度重叠才叫疑似冲突
 *      （同一个人可以有十条互不相干的事实）；
 *   3. **DIGEST 有序、整条截断、带"自动生成"头**（它会被模型整读）；
 *   4. **开关关着时八个 job 回 `skipped:memory-v2-off`**，不是 unknown-job
 *      （默认书里一直列着它们）；
 *   5. **够不到模型/服务就具名跳过**：no-extractor / no-embed / no-workspace，
 *      绝不假装做了。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gunzipSync } from 'node:zlib'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

const {
  splitForArchive, overlapOf, findConflicts, pickForDigest, renderDigest, buildLinks,
  archiveNote, DIGEST_MAX_BYTES, MAX_LINKS,
} = await import('../src/core/memory/nightly.js')
const { makeRecord, withHit, MAX_STRENGTH } = await import('../src/core/memory/model.js')
const { chunksOfDay, GAP_MS } = await import('../src/features/memory/session-split.js')
const { MemoryStore } = await import('../src/features/memory/store.js')
const { registerNightlyJobs } = await import('../src/features/memory/nightly.js')
const { resolveJob } = await import('../src/features/proactive/jobs.js')
const { splitMemoryMarkdown } = await import('../src/core/memory/migrate.js')
const { migrateMemoryFile } = await import('../src/features/memory/migrate.js')

const DAY = 86_400_000
// 用本地时间构造：这些用例比较的是 localDayKey(now)，写死 +08:00 会在 UTC 的 CI 上挂。
const NOW = new Date(2026, 9, 17, 6, 30).getTime()

type Rec = ReturnType<typeof makeRecord>

let counter = 0
function rec(over: Partial<Parameters<typeof makeRecord>[0]> & { recordedAt?: number; lastHitAt?: number; hits?: number } = {}): Rec {
  counter += 1
  const base = makeRecord({
    kind: over.kind ?? 'fact',
    subject: over.subject ?? { type: 'user', id: 1000000002 },
    content: over.content ?? `记录 ${counter}`,
    source: over.source ?? { kind: 'diary' },
    importance: over.importance ?? 5,
    ...(over.status === undefined ? {} : { status: over.status }),
    ...(over.tags === undefined ? {} : { tags: over.tags }),
  }, over.recordedAt ?? NOW, () => (counter % 997) / 997)
  // 只有测试明确要求时才动时间字段（默认就是"刚建、从没被召回"）。
  return {
    ...base,
    ...(over.lastHitAt === undefined ? {} : { lastHitAt: over.lastHitAt }),
    ...(over.hits === undefined ? {} : { hits: over.hits }),
  }
}

// ── 纯判据 ──────────────────────────────────────────────────────────────────

test('遗忘：R<0.05 归档、钉住的永不、非 active 不动', () => {
  const stale = rec({ recordedAt: NOW - 400 * DAY, importance: 2 })          // R≈0 该归档
  const fresh = rec({ recordedAt: NOW - DAY, importance: 5 })                // 还新
  const pinned = rec({ kind: 'person', recordedAt: NOW - 400 * DAY })        // 人物关系：钉住
  const pref = rec({ kind: 'preference', subject: { type: 'user', id: 1 }, recordedAt: NOW - 400 * DAY })
  const candidate = rec({ status: 'candidate', recordedAt: NOW - 400 * DAY })
  const superseded = rec({ status: 'superseded', recordedAt: NOW - 400 * DAY })
  const { archive, keep } = splitForArchive([stale, fresh, pinned, pref, candidate, superseded], NOW)
  assert.deepEqual(archive.map((r) => r.id), [stale.id])
  assert.equal(keep.length, 5, '钉住的/新的/候选/已退役的都留下')
  assert.ok(!archive.includes(pinned) && !archive.includes(pref))
})

test('遗忘：常用记忆衰减更慢（strength 上限 20）', () => {
  const used = rec({ recordedAt: NOW - 400 * DAY, importance: 5 })
  let boosted = used
  for (let i = 0; i < 30; i += 1) boosted = withHit(boosted, NOW - 200 * DAY)
  assert.equal(boosted.strength, MAX_STRENGTH)
  const { archive } = splitForArchive([boosted], NOW - 200 * DAY + 100 * DAY)
  assert.equal(archive.length, 0, 'S=20 时 100 天后的 R 仍 > 0.05')
})

test('冲突检出：同主体同类 + 正文高度重叠才算，内容相同不算', () => {
  const a = rec({ kind: 'preference', content: '学弟不吃香菜，点菜要记得备注' })
  const b = rec({ kind: 'preference', content: '学弟不吃香菜，点外卖要记得备注' })
  const same = rec({ kind: 'preference', content: '学弟不吃香菜，点菜要记得备注' })
  const other = rec({ kind: 'preference', content: '学弟喜欢在凌晨干活，白天睡觉' })
  const otherUser = rec({ kind: 'preference', subject: { type: 'user', id: 999 }, content: '学弟不吃香菜，点菜要记得备注' })
  const pairs = findConflicts([a, b, same, other, otherUser])
  assert.ok(pairs.length >= 1)
  const hit = pairs.find((p) => (p.left.id === a.id && p.right.id === b.id) || (p.left.id === b.id && p.right.id === a.id))
  assert.ok(hit !== undefined, '高度重叠的两条应当被检出')
  assert.ok(hit.overlap >= 0.5)
  for (const p of pairs) {
    assert.notEqual(p.left.content, p.right.content, '一字不差的重复不是冲突（那是去重的活）')
    assert.equal(p.left.subject.id, p.right.subject.id, '不同主体不算冲突')
  }
})

test('DIGEST：只收 active、按重要性与近因排序、整条截断、带头注释', () => {
  const high = rec({ importance: 10, content: '主人叫学弟' })
  const low = rec({ importance: 2, content: '今天天气一般' })
  const old = rec({ importance: 10, content: '很久以前的大事', recordedAt: NOW - 200 * DAY, lastHitAt: NOW - 200 * DAY })
  const candidate = rec({ importance: 10, status: 'candidate', content: '还没确认的候选' })
  const picks = pickForDigest([low, high, old, candidate], NOW)
  // 分数 = 重要性/10 + 0.995^小时：high(10, 刚建)=2.0 > low(2, 刚建)=1.2 > old(10, 200 天前)≈1.0
  assert.deepEqual(picks.map((p) => p.record.id), [high.id, low.id, old.id])
  const text = renderDigest(picks, { generatedAt: '2026-10-17', maxBytes: DIGEST_MAX_BYTES })
  assert.match(text, /自动生成，勿手改/)
  assert.match(text, /主人叫学弟/)
  assert.ok(!text.includes('还没确认的候选'), '候选不进 DIGEST')
  // 小的字节上限：条目按**整条**截断——不会出现半行（头部始终保留，它是定位信息）
  const tiny = renderDigest(picks, { generatedAt: '2026-10-17', maxBytes: 320 })
  const tinyLines = tiny.split('\n').filter((l) => l.startsWith('- '))
  assert.ok(tinyLines.length < picks.length, '上限变小之后条目应当被截掉一些')
  for (const line of tinyLines) {
    assert.ok(text.includes(line), '被截断的必须是整条')
  }
})

test('链接：同主体或高重叠建双向链、最多 4 个、无变化时返回空', () => {
  const a = rec({ kind: 'fact', content: '学弟住在三号楼' })
  const b = rec({ kind: 'fact', content: '学弟住在三号楼东侧' })
  const c = rec({ kind: 'fact', content: '学弟住在三号楼东侧', subject: { type: 'user', id: 1000000002 } })
  const changed = buildLinks([a, b, c])
  assert.ok(changed.length >= 2)
  const updatedA = changed.find((r) => r.id === a.id)
  assert.ok(updatedA !== undefined && updatedA.links.length > 0, '同主体的邻居应当挂上')
  assert.ok(updatedA.links.length <= MAX_LINKS)
  // 已经挂过的不用再挂
  const again = buildLinks([...changed, a, b, c].filter((r, i, arr) => arr.findIndex((x) => x.id === r.id) === i))
  assert.equal(again.length, 0, '链接已经建好，第二次不该再改')
})

test('归档注记带上"距上次召回多少天"', () => {
  const old = rec({ recordedAt: NOW - 400 * DAY })
  const note = archiveNote(old, NOW)
  assert.match(note, /^R<0\.05，距上次召回 400\.0 天/)
})

// ── 会话切分 ────────────────────────────────────────────────────────────────

test('会话切分：只取当天、按 30 分钟间隔断块', () => {
  const at = (iso: string): number => Date.parse(iso)
  const line = (iso: string, text: string): string => JSON.stringify({
    type: 'user/message',
    time: at(iso),
    data: { content: [{ type: 'text', text }] },
  })
  const jsonl = [
    line('2026-10-16T10:00:00+08:00', '10:00 甲(1)：早上好'),
    line('2026-10-16T10:05:00+08:00', '10:05 乙(2)：早'),
    // 间隔 40 分钟 > 30 → 新块
    line('2026-10-16T10:45:00+08:00', '10:45 甲(1)：中午吃啥'),
    // 另一天：不算
    line('2026-10-15T10:00:00+08:00', '10:00 甲(1)：昨天的话'),
    // 非聊天行：丢掉
    JSON.stringify({ type: 'system/notice', time: at('2026-10-16T10:50:00+08:00') }),
  ].join('\n')
  const chunks = chunksOfDay(jsonl, 'group-1', '2026-10-16')
  assert.equal(chunks.length, 2)
  assert.equal(chunks[0]?.room, 'group-1')
  assert.match(chunks[0]?.text ?? '', /早上好/)
  assert.match(chunks[0]?.text ?? '', /早$/)
  assert.match(chunks[1]?.text ?? '', /中午吃啥/)
  assert.ok((chunks[1]?.start ?? 0) - (chunks[0]?.start ?? 0) >= GAP_MS)
})

test('会话切分：没有当天的对话就返回空', () => {
  const line = JSON.stringify({ type: 'user/message', time: new Date(2026, 9, 10, 10, 0).getTime(), data: { content: [{ type: 'text', text: 'x' }] } })
  assert.deepEqual(chunksOfDay(line, 'group-1', '2026-10-16'), [])
})

// ── 八个 job ────────────────────────────────────────────────────────────────

interface Harness {
  dir: string
  store: () => InstanceType<typeof MemoryStore> | null
  off: () => void
  cleanup: () => void
}

async function harness(opts: { v2?: boolean; workspace?: string | null; extract?: (s: string, t: string) => Promise<Array<{ type: string; content: string; tags: string[]; source: string }>>; embed?: unknown } = {}): Promise<Harness> {
  const dir = mkdtempSync(path.join(tmpdir(), 'qq-nightly-'))
  const workspace = opts.workspace === undefined ? dir : opts.workspace
  let store: InstanceType<typeof MemoryStore> | null = null
  if (opts.v2 !== false) {
    store = new MemoryStore({ workspacePath: workspace, dshHome: dir, log: () => {} })
    await store.load()
  }
  const fixed = store
  const off = registerNightlyJobs({
    store: () => fixed,
    legacy: null,
    log: () => {},
    workspace: () => workspace,
    extractorReady: () => opts.extract !== undefined,
    extract: opts.extract ?? (async () => []),
    embed: () => (opts.embed ?? null) as never,
    rooms: () => [],
    random: () => 0.5,
  })
  return {
    dir,
    store: () => fixed,
    off,
    cleanup: () => { off(); rmSync(dir, { recursive: true, force: true }) },
  }
}

function ctxOf(dir: string, workspace: string | null, now = NOW): { now: Date; log: (l: string) => void; dshHome: string; workspace: string | null } {
  return { now: new Date(now), log: () => {}, dshHome: dir, workspace }
}

test('开关关着：八个 job 全部回 skipped:memory-v2-off', async () => {
  const h = await harness({ v2: false })
  try {
    const names = [
      'memory.diary-extract', 'memory.session-split', 'memory.reflect', 'memory.links',
      'memory.contradictions', 'memory.forget', 'memory.digest', 'memory.reindex',
    ]
    for (const name of names) {
      const handler = resolveJob(name)
      assert.ok(handler !== undefined, `${name} 应当已注册`)
      const outcome = await handler(ctxOf(h.dir, h.dir))
      assert.deepEqual(outcome, { skipped: 'memory-v2-off' }, `${name} 的跳过原因应当是开关，而不是 unknown-job`)
    }
  } finally { h.cleanup() }
})

test('遗忘 job：真归档——状态转 archived、正文进 .gz 归档文件', async () => {
  const h = await harness()
  try {
    const store = h.store()!
    const stale = await store.remember({ kind: 'fact', subject: { type: 'world' }, content: '一条早就没人提的事', source: { kind: 'diary' }, importance: 1 }, NOW - 400 * DAY, () => 0.5)
    await store.remember({ kind: 'fact', subject: { type: 'world' }, content: '新近的事', source: { kind: 'diary' }, importance: 5 }, NOW - DAY, () => 0.5)
    const outcome = await resolveJob('memory.forget')!(ctxOf(h.dir, h.dir))
    assert.match(String(outcome?.note), /归档 1 条/)
    assert.equal(store.get(stale.id)?.status, 'archived')
    const gz = path.join(store.dir, 'records.archive.jsonl.gz')
    assert.ok(existsSync(gz))
    const text = gunzipSync(readFileSync(gz)).toString('utf-8')
    assert.match(text, new RegExp(stale.id))
    assert.match(text, /R<0\.05/)
  } finally { h.cleanup() }
})

test('DIGEST job：写出 memory/DIGEST.md（带自动生成头）', async () => {
  const h = await harness()
  try {
    const store = h.store()!
    await store.remember({ kind: 'preference', subject: { type: 'user', id: 1 }, content: '学弟喜欢喝冰美式', source: { kind: 'chat' }, importance: 9 }, NOW - DAY, () => 0.5)
    const outcome = await resolveJob('memory.digest')!(ctxOf(h.dir, h.dir))
    assert.match(String(outcome?.note), /DIGEST/)
    const text = readFileSync(path.join(h.dir, 'memory', 'DIGEST.md'), 'utf-8')
    assert.match(text, /自动生成，勿手改/)
    assert.match(text, /学弟喜欢喝冰美式/)
    assert.match(text, /qq_memory/)
  } finally { h.cleanup() }
})

test('链接 job：把邻居挂上并写库', async () => {
  const h = await harness()
  try {
    const store = h.store()!
    const a = await store.remember({ kind: 'fact', subject: { type: 'user', id: 7 }, content: '学弟在准备考试', source: { kind: 'diary' } }, NOW - DAY, () => 0.5)
    await store.remember({ kind: 'fact', subject: { type: 'user', id: 7 }, content: '学弟在准备考试，快考完了', source: { kind: 'diary' } }, NOW - DAY, () => 0.5)
    const outcome = await resolveJob('memory.links')!(ctxOf(h.dir, h.dir))
    assert.match(String(outcome?.note), /链接/)
    assert.ok((store.get(a.id)?.links.length ?? 0) > 0)
  } finally { h.cleanup() }
})

test('矛盾扫描 job：检出 → 冻结进队列，但不改记录本身（P1）', async () => {
  const h = await harness()
  try {
    const store = h.store()!
    await store.remember({ kind: 'preference', subject: { type: 'user', id: 7 }, content: '学弟不吃香菜，点菜要备注', source: { kind: 'chat' } }, NOW - DAY, () => 0.5)
    await store.remember({ kind: 'preference', subject: { type: 'user', id: 7 }, content: '学弟不吃香菜，点外卖要备注', source: { kind: 'chat' } }, NOW - DAY, () => 0.6)
    const before = store.all().map((r) => r.status)
    const outcome = await resolveJob('memory.contradictions')!(ctxOf(h.dir, h.dir))
    assert.match(String(outcome?.note), /新冻结 1 对/)
    assert.deepEqual(store.all().map((r) => r.status), before, '扫描不改任何记录')
    // 冻结队列：一对挂进 knowledge/conflicts.jsonl，重复扫不重复记。
    const { readOpenConflicts } = await import('../src/features/memory/consolidate-io.js')
    const kdir = path.join(h.dir, 'knowledge')
    assert.equal((await readOpenConflicts(kdir)).length, 1)
    await resolveJob('memory.contradictions')!(ctxOf(h.dir, h.dir))
    assert.equal((await readOpenConflicts(kdir)).length, 1, '同一对不重复入队')
  } finally { h.cleanup() }
})

test('日记抽取 job：没有抽取器就具名跳过；有抽取器才写记录', async () => {
  const noRoute = await harness()
  try {
    const outcome = await resolveJob('memory.diary-extract')!(ctxOf(noRoute.dir, noRoute.dir))
    assert.deepEqual(outcome, { skipped: 'no-extractor' })
  } finally { noRoute.cleanup() }

  const withRoute = await harness({
    extract: async () => [{ type: 'preference', content: '学弟不吃香菜', tags: ['饮食'], source: '日记' }],
  })
  try {
    const dir = withRoute.dir
    mkdirSync(path.join(dir, 'memory'), { recursive: true })
    // 04:20 的 job 处理**昨天**的日记（日记从每天 00:01 起写，当天凌晨只有几小时）。
    writeFileSync(path.join(dir, 'memory', '2026-10-16.md'), '今天学弟说他从来不吃香菜，点菜的时候要记得备注一下；晚上他又提了一次，说上次那家店放了很多香菜他一口都没吃，看来这条得记牢。', 'utf-8')
    const outcome = await resolveJob('memory.diary-extract')!(ctxOf(dir, dir))
    assert.match(String(outcome?.note), /新增 1/)
    assert.equal(withRoute.store()!.all().filter((r) => r.content === '学弟不吃香菜').length, 1)
    // 再跑一次：同一条内容命中"已有"，不再新增
    const again = await resolveJob('memory.diary-extract')!(ctxOf(dir, dir))
    assert.match(String(again?.note), /命中已有 1/)
    assert.equal(withRoute.store()!.all().length, 1)
  } finally { withRoute.cleanup() }
})

test('索引重建 job：没有嵌入器就具名跳过', async () => {
  const h = await harness()
  try {
    assert.deepEqual(await resolveJob('memory.reindex')!(ctxOf(h.dir, h.dir)), { skipped: 'no-embed' })
  } finally { h.cleanup() }
})

test('反思 job：高重要性记录不足时具名跳过', async () => {
  const h = await harness({ extract: async () => [] })
  try {
    // harness 的 extract 已给 → extractorReady 为真；但库里没有足够的高重要性记录
    assert.deepEqual(await resolveJob('memory.reflect')!(ctxOf(h.dir, h.dir)), { skipped: 'too-few-highlights' })
  } finally { h.cleanup() }
})

test('会话分解 job：没有抽取器就具名跳过（哪怕原件读得到）', async () => {
  const h = await harness()
  try {
    assert.deepEqual(await resolveJob('memory.session-split')!(ctxOf(h.dir, h.dir)), { skipped: 'no-extractor' })
  } finally { h.cleanup() }
})

// ── MEMORY.md 迁移（D4 §7） ─────────────────────────────────────────────────

test('切分：标题不成为条目、列表项与正文各成一条、带原始行号', () => {
  const md = [
    '# MEMORY.md',                       // 1 一级标题：不成条
    '',
    '## 学习进度',                        // 3
    '- 学会了用 zstd 解多帧会话日志',      // 4 ← 一条
    '- 踩坑：**多帧**只解第一帧会静默丢数据', // 5 ← 一条（去粗体）
    '',                                  // 6
    '## 主人的偏好',                       // 7
    '不吃香菜，点菜要备注。',              // 8 ← 一条（整段正文）
    '- [x] 已完成的事',                   // 9 ← 一条
    '- a',                               // 10 太短：丢掉
    '```',
    '- 围栏里的不算',                      // 12 代码围栏内：丢掉
    '```',
  ].join('\n')
  const items = splitMemoryMarkdown(md)
  assert.deepEqual(items.map((i) => i.line), [4, 5, 8, 9])
  assert.match(items[0]!.content, /zstd/)
  assert.equal(items[0]!.heading, '学习进度')
  assert.ok(!items[1]!.content.includes('**'), 'markdown 粗体标记要去掉')
  assert.equal(items[2]!.heading, '主人的偏好')
})

test('切分：链接语法还原成文字、超长截断', () => {
  const items = splitMemoryMarkdown(`## 链接\n- 参考 [文档](https://x/y) 里的做法\n- ${'长'.repeat(300)}`)
  assert.equal(items[0]?.content, '参考 文档 里的做法')
  assert.ok((items[1]?.content.length ?? 0) <= 200)
})

test('迁移：冻结原件 → 切分 → 落候选（不影响对话，等审核）', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'qq-migrate-'))
  try {
    const workspace = path.join(dir, 'ws')
    mkdirSync(workspace, { recursive: true })
    writeFileSync(path.join(workspace, 'MEMORY.md'), '# MEMORY\n## 学习\n- 学会了给记忆分片做向量索引\n- 踩坑：多帧 zstd 只解第一帧会静默丢数据\n', 'utf-8')
    const store = new MemoryStore({ workspacePath: workspace, dshHome: dir, log: () => {} })
    await store.load()
    const result = await migrateMemoryFile({
      workspace, dshHome: dir, store, log: () => {}, now: new Date(NOW), roll: () => 0.42,
    })
    assert.equal(result.ok, true)
    assert.equal(result.total, 2)
    assert.equal(result.added, 2)
    // 候选：不参与检索（isRetrievable 只认 active）
    assert.ok(store.all().every((r) => r.status === 'candidate'))
    // 出处带原文件与行号
    const first = store.all()[0]!
    assert.equal(first.source.kind, 'migration')
    assert.equal(first.source.file, 'MEMORY.md')
    assert.equal(first.source.line, 3)
    // 冻结两份：备份目录 + 工作区 .frozen；原件不动
    assert.ok(existsSync(path.join(dir, 'channel-qq', 'backups', 'MEMORY.md.2026-10-17')))
    assert.ok(existsSync(path.join(workspace, 'MEMORY.md.frozen')))
    assert.ok(existsSync(path.join(workspace, 'MEMORY.md')))
    // 再跑一次：全部命中已有，不再新增
    const again = await migrateMemoryFile({
      workspace, dshHome: dir, store, log: () => {}, now: new Date(NOW), roll: () => 0.43,
    })
    assert.equal(again.added, 0)
    assert.equal(again.duplicated, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('迁移：没有 MEMORY.md 时具名失败、什么都不改', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'qq-migrate-'))
  try {
    const store = new MemoryStore({ workspacePath: dir, dshHome: dir, log: () => {} })
    await store.load()
    const result = await migrateMemoryFile({ workspace: dir, dshHome: dir, store, log: () => {}, now: new Date(NOW), roll: () => 0.5 })
    assert.equal(result.ok, false)
    assert.match(String(result.reason), /不存在/)
    assert.equal(store.all().length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
