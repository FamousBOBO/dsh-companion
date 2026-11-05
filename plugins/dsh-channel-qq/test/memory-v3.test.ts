/** P0–P3 记忆升级的测试（调研 [20261024_memory-system-research.md] §6 落地）。
 *
 * 六块，对应六个新机制：
 *   1. 蒸馏与触发判据（core/memory/distill）——写入侧事实化的两道闸；
 *   2. 巩固计划（core/memory/consolidate）——合并/吸收/凭证/冲突键；
 *   3. 三层注入的挑选（core/memory/select）——常驻准入、走神骰子、渲染；
 *   4. 实体词典（core/memory/entities）——别名挂接与查询命中；
 *   5. 纪念日（core/memory/occasions）——月日匹配与年数；
 *   6. 即时抽取（features/memory/instant-capture）——配额、冷却、带外入库。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

const { distillFact, shouldCaptureInstant, CAPTURE_DAILY_CAP } = await import('../src/core/memory/distill.js')
const { planMerges, applyMerge, mergeNote, conflictKey, absorb, MERGE_OVERLAP } = await import('../src/core/memory/consolidate.js')
const { pickPinned, pickWander, renderConstantBlock, PINNED_INJECT_MAX, WANDER_PROBABILITY } = await import('../src/core/memory/select.js')
const { entityIndex, entitiesInText, ENTITY_EXPANSION_FACTOR } = await import('../src/core/memory/entities.js')
const { dueOccasions, renderOccasions } = await import('../src/core/memory/occasions.js')
const { isCoreRecord } = await import('../src/core/memory/model.js')
const { InstantCapture } = await import('../src/features/memory/instant-capture.js')
const { freezeConflicts, readOpenConflicts, resolveFrozenConflict } = await import('../src/features/memory/consolidate-io.js')
const { makeRecord } = await import('../src/core/memory/model.js')
const { MemoryStore } = await import('../src/features/memory/store.js')

const NOW = new Date(2026, 9, 24, 12, 0).getTime()
const DAY = 86_400_000

type Rec = ReturnType<typeof makeRecord>
/** 建一条基础记录；`over` 里既有建档输入（content/kind/tags）也有档案字段
 * （hits/strength/lastHitAt）——后者 makeRecord 不收，这里在档案层覆盖。 */
let recSeq = 0
function rec(over: Partial<Parameters<typeof makeRecord>[0]> & Partial<Pick<Rec, 'hits' | 'strength' | 'confidence' | 'lastHitAt' | 'validFrom' | 'status'>> = {}): Rec {
  const { hits: _h, strength: _s, confidence: _c, lastHitAt: _l, validFrom: _v, status: _st, ...input } = over
  // roll 用递增序列：id 后缀必须彼此不同——固定 roll 会让每条记录撞同一个 id。
  const made = makeRecord({ kind: 'fact', subject: { type: 'user', id: 7 }, content: '一条事实', source: { kind: 'chat' }, ...input }, NOW, () => (recSeq = (recSeq + 1) % 997) / 997)
  return {
    ...made,
    ...(hits_(_h) ?? {}),
    ...(strength_(_s) ?? {}),
    ...(confidence_(_c) ?? {}),
    ...(lastHitAt_(_l) ?? {}),
    ...(validFrom_(_v) ?? {}),
    ...(status_(_st) ?? {}),
  }
}
const hits_ = (v?: number) => (v === undefined ? null : { hits: v })
const strength_ = (v?: number) => (v === undefined ? null : { strength: v })
const confidence_ = (v?: number) => (v === undefined ? null : { confidence: v })
const lastHitAt_ = (v?: number) => (v === undefined ? null : { lastHitAt: v })
const validFrom_ = (v?: number) => (v === undefined ? null : { validFrom: v })
const status_ = (v?: Rec['status']) => (v === undefined ? null : { status: v })

// ── 1. 蒸馏与触发 ────────────────────────────────────────────────────────────

test('蒸馏：去掉口语壳与句尾语气，截到 80 字', () => {
  assert.equal(distillFact('其实主人不吃香菜'), '主人不吃香菜')
  assert.equal(distillFact('我觉得她好像在忙吧。'), '她好像在忙')
  assert.equal(distillFact('然后对了，他喜欢冰美式'), '他喜欢冰美式')
  assert.equal(distillFact('可能大概也许就是这样呢'), '也许就是这样')
  const long = '这是一条非常长的记忆内容'.repeat(20)
  const got = distillFact(long)
  assert.ok(got.length <= 80, `蒸馏后 ≤80 字，实际 ${got.length}`)
  assert.ok(got.endsWith('…'))
})

test('触发判据：四类触发命中，寒暄/命令/链接不命中', () => {
  assert.equal(shouldCaptureInstant('你说错了，我不吃香菜'), true, '被纠正')
  assert.equal(shouldCaptureInstant('帮我记住明天要开会'), true, '要求记住')
  assert.equal(shouldCaptureInstant('我是做后端开发的'), true, '自述')
  assert.equal(shouldCaptureInstant('气死我了真的！！'), true, '情绪上头')
  assert.equal(shouldCaptureInstant('哦'), false, '太短')
  assert.equal(shouldCaptureInstant('https://example.com/a/b'), false, '纯链接')
  assert.equal(shouldCaptureInstant('/status'), false, '命令')
  assert.equal(shouldCaptureInstant('今天天气怎么记笔记格式这样'), false, '触发词 ≠ 请求记住')
})

// ── 2. 巩固计划 ──────────────────────────────────────────────────────────────

test('巩固：同一件事的两种说法合并成一条，drop 走 supersede，痕迹吸收', () => {
  const a = rec({ content: '主人不吃香菜，每次点菜都要提前备注好', hits: 3, strength: 2, confidence: 0.5 })
  const b = rec({ content: '主人不吃香菜，每次点菜都提前备注好', hits: 5, strength: 1, confidence: 0.7 })
  const plans = planMerges([a, b])
  assert.equal(plans.length, 1, '同一件事的两种说法（重叠过门槛）合并')
  const plan = plans[0]!
  assert.equal(plan.keep.hits, 8, 'hits 相加')
  assert.equal(applyMerge(plan, NOW).length, 2, 'keep + 一条 drop')
  assert.equal(plan.keep.strength, 2, '强度取最大')
  assert.equal(plan.keep.confidence, 0.7, '置信取最高')
  const [keep, drop] = applyMerge(plan, NOW)
  assert.ok(keep !== undefined && drop !== undefined)
  assert.equal(keep.status, 'active')
  assert.equal(drop.status, 'superseded')
  assert.equal(drop.supersededBy, keep.id)
  assert.match(mergeNote(plan), /merge/)
})

test('巩固：互不相干的事实不合并；钉住的永不合并', () => {
  const a = rec({ content: '主人不吃香菜' })
  const b = rec({ content: '主人住在 3 号楼' })
  assert.equal(planMerges([a, b]).length, 0, '同主体不同事实，重叠低')
  const pinnedA = rec({ content: '主人不吃香菜，点菜要备注啊一定要备注', tags: ['pin'] })
  const pinnedB = rec({ content: '主人不吃香菜，点菜一定要备注备注' })
  assert.equal(planMerges([pinnedA, pinnedB]).length, 0, '钉住的退出合并')
})

test('巩固：冲突键与 id 顺序无关（同一对只会有一个键）', () => {
  const a = rec()
  const b = rec()
  assert.equal(conflictKey({ left: a, right: b, overlap: 0.8 }), conflictKey({ left: b, right: a, overlap: 0.8 }))
  assert.equal(MERGE_OVERLAP, 0.75)
  // absorb 的 links 并集：drop 指向别人的链接也跟过来（指向 keep 自己的除外）。
  const keep = rec({ content: '保留的这条' })
  const drop = rec({ content: '并入的那条', links: [keep.id, 'm_other'] })
  const got = absorb(keep, [drop])
  assert.ok(got.links.includes('m_other'))
  assert.ok(!got.links.includes(keep.id), '指向自己的链接不挂')
})

// ── 3. 三层注入的挑选 ────────────────────────────────────────────────────────

test('常驻层：core 标记 + 高重要 + 高置信才进，默认最多 2 条', () => {
  const core = rec({ tags: ['core'], importance: 9, confidence: 0.9 })
  const weak = rec({ tags: ['core'], importance: 5, confidence: 0.9 })
  const unsure = rec({ tags: ['core'], importance: 9, confidence: 0.5 })
  assert.equal(isCoreRecord(core), true)
  assert.equal(isCoreRecord(weak), false, 'importance 不够')
  assert.equal(isCoreRecord(unsure), false, '置信不够')
  assert.equal(isCoreRecord(rec({ importance: 9, confidence: 0.9 })), false, '没标记就不进')
  const many = [core, rec({ tags: ['core'], importance: 8, confidence: 0.9 }), rec({ tags: ['core'], importance: 8, confidence: 0.85 })]
  const picked = pickPinned(many)
  assert.equal(picked.length, PINNED_INJECT_MAX)
  assert.equal(picked[0]!.id, core.id, 'importance 最高的在前')
  assert.match(renderConstantBlock(picked, { renderTime: () => '2026-10-24' }), /\[记忆 · 一直记得的事\]/)
})

test('常驻层：affection 联动的扩展准入（admitExtra）', () => {
  const favorite = rec({ kind: 'preference', importance: 7, confidence: 0.85 })
  const weak = rec({ kind: 'preference', importance: 5, confidence: 0.85 })
  const admit = (r: Rec): boolean => r.kind === 'preference' && r.importance >= 7 && r.confidence >= 0.8
  const picked = pickPinned([favorite, weak], { admitExtra: admit })
  assert.deepEqual(picked.map((r) => r.id), [favorite.id], '高好感用户的重要偏好进常驻，弱的进不来')
})

test('走神层：8% 概率、深记忆、七天没想起；骰子大了不带', () => {
  assert.equal(WANDER_PROBABILITY, 0.08)
  const deep = rec({ strength: 5, lastHitAt: NOW - 10 * DAY })
  const shallow = rec({ strength: 1, lastHitAt: NOW - 10 * DAY })
  const fresh = rec({ strength: 5, lastHitAt: NOW - DAY })
  const pool = [deep, shallow, fresh]
  assert.equal(pickWander(pool, NOW, 0.05), deep, 'roll < 8%：从合格的池子里带一条')
  assert.equal(pickWander(pool, NOW, 0.5), null, 'roll ≥ 8%：不想起来')
  assert.equal(pickWander([shallow], NOW, 0.01), null, '太浅的不走神')
  assert.equal(pickWander([fresh], NOW, 0.01), null, '最近想过的不再走神')
  assert.equal(pickWander(pool, NOW, -1), null, '骰子坏了（负数）不带')
})

// ── 4. 实体词典 ──────────────────────────────────────────────────────────────

test('实体词典：keywords/subject.id/person 称呼都挂接；查询点名即命中', () => {
  const a = rec({ content: '主人在写机器人', keywords: ['机器人'] })
  const b = rec({ content: '团子是主人的猫', keywords: [], kind: 'person' as never, subject: { type: 'user', id: 23456 } })
  const chunk = rec({ content: '原文块不进实体', keywords: ['机器人'], tags: ['chunk'] })
  const index = entityIndex([a, b, chunk])
  assert.ok(index.has('机器人'), 'keywords 进实体')
  assert.ok(index.has('23456'), 'subject.id 进实体')
  assert.ok(index.has('团子是主人的猫'), 'person 正文开头当称呼')
  assert.ok(!index.get('机器人')!.has(chunk.id), '原文块不挂接')
  const hits = entitiesInText(index, '机器人现在写得怎么样了')
  assert.equal(hits.length, 1)
  assert.ok(hits[0]!.ids.has(a.id))
  assert.equal(entitiesInText(index, '毫无相关的询问').length, 0)
  assert.equal(ENTITY_EXPANSION_FACTOR, 0.8)
})

// ── 5. 纪念日 ────────────────────────────────────────────────────────────────

test('纪念日：月日相同才算到期；年数按建档算', () => {
  // NOW = 2026-10-24 本地；validFrom = 2024-10-24 → 第 3 个年头（years=2）。
  const birthday = rec({ content: '主人的生日', tags: ['birthday'], validFrom: new Date(2024, 9, 24, 8).getTime() })
  const other = rec({ content: '别的日子', tags: ['birthday'], validFrom: new Date(2024, 9, 25).getTime() })
  const untagged = rec({ content: '没标记的', validFrom: new Date(2024, 9, 24).getTime() })
  const got = dueOccasions([birthday, other, untagged], NOW, 8 * 60)
  assert.deepEqual(got.map((o) => o.record.id), [birthday.id])
  assert.equal(got[0]!.kind, 'birthday')
  assert.equal(got[0]!.years, 2)
  assert.match(renderOccasions(got, () => '2024-10-24'), /\[记忆 · 今天的日子\]/)
})

// ── 6. 即时抽取 ──────────────────────────────────────────────────────────────

interface Dir { dir: string; cleanup(): void }
function scratch(): Dir {
  const dir = mkdtempSync(path.join(tmpdir(), 'qq-capture-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function captureHarness(opts: { extract?: (s: string, t: string) => Promise<Array<{ type: string; content: string; tags: string[]; source: string }>>; cap?: number } = {}) {
  const s = scratch()
  const store = new MemoryStore({ workspacePath: s.dir, dshHome: s.dir, log: () => {} })
  const c = new InstantCapture({
    store: () => store,
    ...(opts.extract === undefined ? {} : { extract: opts.extract }),
    log: () => {},
    random: () => 0.5,
    clock: { now: () => NOW },
    dir: store.dir,
    ...(opts.cap === undefined ? {} : { dailyCap: opts.cap }),
  })
  return { c, store, ...s }
}

/**
 * 等到 `pred` 成立为止（最多 `timeoutMs`，超时即失败）。
 *
 * 即时抽取是**带外**异步的：`end()` 里 `void this.capture(...)`（见
 * `instant-capture.ts:78`），调用方拿不到任何 promise，所以"抽完了没有"只能从
 * 可观测状态问出来——库里的条数、抽取器被调的次数、今日剩余配额。固定 sleep 是
 * 拿时钟猜它跑完没有，机器一忙就猜错（同一份代码实测 13/13、12/13、13/13）；
 * 这里改成"等到真的发生"，等不到才失败。
 */
async function waitFor(what: string, pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() >= deadline) assert.fail(`等不到：${what}（已等 ${timeoutMs}ms）`)
    await new Promise<void>((resolve) => { setTimeout(resolve, 5) })
  }
}

/**
 * 等到"这条链真的停下来了"，用于"**不该**发生"的断言。
 *
 * 即时抽取没有回调可用（`end()` 里 `void this.capture(...)`，`instant-capture.ts:78`），
 * 而"什么都没发生"是个否定命题：只能靠"观察活动计数不再变化"来证伪——抽取被调次数、
 * 库里条数、今日剩余配额，任一变化都说明还有链在跑，重置窗口接着等；三者一起静下来
 * `quietMs` 才算这条链走完。它**不是**"睡一觉再看"：只要还有活动就不返回，所以
 * "配额没被拦住 / 冷却没生效"这类回归会让计数变化、窗口重置，随后的断言照样红
 * （把 `cap: 1` 改成 `cap: 2` 验证过这条路径会失败）。
 *
 * 窗口要 ≥ 一次落盘：`consumeQuota` 里 `atomicWriteFile`（`:106`）是这条链最长的
 * 异步尾巴，本地几毫秒；150ms 是它的保守上界，不是"猜抽取器什么时候跑完"。
 */
async function settle(probe: () => string, quietMs = 150, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last = probe()
  let since = Date.now()
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => { setTimeout(resolve, 5) })
    const now = probe()
    if (now !== last) { last = now; since = Date.now(); continue }
    if (Date.now() - since >= quietMs) return
  }
  assert.fail(`即时抽取这条链在 ${timeoutMs}ms 内一直没停下来（最后观测到 ${last}）`)
}

test('即时抽取：触发才抽、蒸馏后入库、低置信带 instant 标记', async () => {
  const h = captureHarness({ extract: async () => [{ type: 'fact', content: '其实主人不吃香菜，点菜要备注一下的', tags: ['饮食'], source: '聊天' }] })
  try {
    await h.store.load()
    h.c.begin('group-123', { text: '你说错了，我不吃香菜' })
    h.c.end('group-123')
    await waitFor('这条纠正被即时抽取写进记忆库', () => h.store.all().length === 1)
    const all = h.store.all()
    assert.equal(all.length, 1)
    assert.equal(all[0]!.content, '主人不吃香菜，点菜要备注一下的', '蒸馏过的短事实（≤80 字）')
    assert.equal(all[0]!.confidence, 0.5, '低置信起步')
    assert.equal(all[0]!.tags.includes('instant'), true)
    assert.equal(all[0]!.source.kind, 'extract')
  } finally { h.cleanup() }
})

test('即时抽取：不触发不调抽取器；配额用完就停；同房间冷却', async () => {
  let calls = 0
  const h = captureHarness({
    cap: 1,
    extract: async () => { calls += 1; return [{ type: 'fact', content: '临时事实若干', tags: [], source: '聊天' }] },
  })
  /** 三个可观测量的合成签名：抽取次数 / 库里条数 / 今日剩余配额。 */
  const activity = (): string => `${String(calls)}|${String(h.store.all().length)}|${String(h.c.remainingToday())}`
  try {
    await h.store.load()
    h.c.begin('group-1', { text: '今天天气不错' })
    h.c.end('group-1')
    await settle(activity)
    assert.equal(calls, 0, '寒暄不触发')

    h.c.begin('group-1', { text: '帮我记住一件事很重要' })
    h.c.end('group-1')
    await waitFor('触发的这条被抽一次', () => calls === 1)
    assert.equal(calls, 1, '触发的抽一次')

    h.c.begin('group-1', { text: '再帮我记住另一件事' })
    h.c.end('group-1')
    await settle(activity)
    assert.equal(calls, 1, '冷却期内不再抽')

    h.c.begin('group-2', { text: '另一间房也帮我记住' })
    h.c.end('group-2')
    await settle(activity)
    assert.equal(calls, 1, '每日配额 1 条用完即停')
    assert.ok(CAPTURE_DAILY_CAP >= 1)
  } finally { h.cleanup() }
})

// ── 7. 冲突队列的 IO ─────────────────────────────────────────────────────────

test('冲突队列：冻结去重、裁决标记 resolved', async () => {
  const s = scratch()
  try {
    const a = rec()
    const b = rec()
    const pair = { left: a, right: b, overlap: 0.8 }
    assert.equal(await freezeConflicts(s.dir, [pair], NOW), 1)
    assert.equal(await freezeConflicts(s.dir, [pair], NOW + 1), 0, '同一对不重复入队')
    const open = await readOpenConflicts(s.dir)
    assert.equal(open.length, 1)
    assert.equal(await resolveFrozenConflict(s.dir, open[0]!.key, 'kept-left', NOW + 2), true)
    assert.equal((await readOpenConflicts(s.dir)).length, 0, '裁决后不再挂起')
  } finally { s.cleanup() }
})
