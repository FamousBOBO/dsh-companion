/** 记忆核心（P6e · e1）：模型不变量、打分、取舍、查询构造。
 *
 * 这些是纯函数，也是记忆系统里"会被反复怀疑"的部分——模型说错话时，第一反应永远是
 * "是不是检索喂错了"。所以每一条规则都要有能被指着看的用例：遗忘曲线到底怎么衰减、
 * 阈值砍掉了什么、600 字预算先丢谁、被取代的记录会不会又冒出来。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

const {
  makeRecord, isPinned, isRetrievable, isValidAt, retention, shouldArchive, withHit,
  supersede, sameTopic, newMemoryId, MAX_STRENGTH,
} = await import('../src/core/memory/model.js')
const {
  rankCandidates, recencyOf, keywordRelevance, bigrams, queryTerms,
  DEFAULT_WEIGHTS, TIME_WEIGHTS, SCORE_THRESHOLD,
} = await import('../src/core/memory/score.js')
const { selectForInjection, renderEvidence } = await import('../src/core/memory/select.js')
const { buildQuery, narrowestRange, boostRelevance, SUBJECT_BOOST } = await import('../src/core/memory/query.js')

const NOW = Date.parse('2026-10-17T15:00:00+08:00')
const DAY = 86_400_000
/** 固定随机源：id 才能被断言。 */
const roll = (): number => 0.5

function fact(overrides: Record<string, unknown> = {}): ReturnType<typeof makeRecord> {
  return makeRecord({
    kind: 'fact',
    subject: { type: 'user', id: 1000000002 },
    content: overrides.content as string ?? '学弟在写一个 QQ 机器人',
    source: { kind: 'chat', room: 'qq-dm-1000000002' },
    ...overrides,
  }, (overrides.__now as number) ?? NOW, roll)
}

// ── 模型 ────────────────────────────────────────────────────────────────────

test('记忆模型：id 形如 m_<base36 时间>_<4 位随机>，同一时刻由注入的随机源决定', () => {
  const id = newMemoryId(NOW, roll)
  assert.match(id, /^m_[0-9a-z]+_[0-9a-z]{4}$/)
  assert.equal(id, newMemoryId(NOW, roll), '同一个随机源 → 同一个 id（可重放）')
  assert.notEqual(id, newMemoryId(NOW, () => 0.9))
})

test('记忆模型：建档补默认值——importance 5 / confidence 1 / strength 1，重要的给 3', () => {
  const normal = fact()
  assert.equal(normal.importance, 5)
  assert.equal(normal.confidence, 1)
  assert.equal(normal.strength, 1)
  assert.equal(normal.status, 'active')
  assert.equal(normal.hits, 0)
  assert.equal(normal.validTo, null)
  assert.equal(normal.recordedAt, NOW)

  assert.equal(fact({ importance: 9 }).strength, 3, 'importance ≥ 8 建档就给 strength=3')
  assert.equal(fact({ importance: 99 }).importance, 10, 'importance 夹到 1..10')
  assert.equal(fact({ confidence: -1 }).confidence, 0, 'confidence 夹到 0..1')
})

test('记忆模型：内容压成一句话并截断到 200 字（超了说明这不是"一句话"）', () => {
  assert.equal(fact({ content: '  学弟   喜欢\n\n喝冰美式  ' }).content, '学弟 喜欢 喝冰美式')
  const long = '啊'.repeat(300)
  const rec = fact({ content: long })
  assert.equal(rec.content.length, 200)
  assert.equal(rec.content.endsWith('…'), true)
  assert.throws(() => fact({ content: '   ' }), /不能为空/)
})

test('记忆模型：双时间轴——validFrom 在未来不算成立，validTo 过了就失效', () => {
  const future = fact({ validFrom: NOW + DAY })
  assert.equal(isValidAt(future, NOW), false)
  assert.equal(isRetrievable(future, NOW), false)

  const active = fact()
  assert.equal(isValidAt(active, NOW), true)
  const closed = { ...active, validTo: NOW - 1 }
  assert.equal(isValidAt(closed, NOW), false)
})

test('记忆模型：遗忘曲线 R=e^(−t/S)，被召回一次就变难忘一档', () => {
  const rec = fact()
  assert.ok(Math.abs(retention(rec, NOW) - 1) < 1e-9, '刚建档：R=1')
  // 一天没被召回，S=1 → e^-1 ≈ 0.3679
  assert.ok(Math.abs(retention(rec, NOW + DAY) - Math.exp(-1)) < 1e-6)

  const used = { ...rec, strength: 3 }
  assert.ok(retention(used, NOW + DAY) > retention(rec, NOW + DAY), 'S 越大衰减越慢')

  const hit = withHit(rec, NOW)
  assert.equal(hit.hits, 1)
  assert.equal(hit.lastHitAt, NOW)
  assert.equal(hit.strength, rec.strength + 1, '越用越难忘（MemoryBank）')
  assert.equal(withHit({ ...rec, strength: MAX_STRENGTH }, NOW).strength, MAX_STRENGTH, '强度有上限')
})

test('记忆模型：归档看 R<0.05，但"钉住"的永不归档', () => {
  const old = NOW - 60 * DAY
  const plain = fact({ __now: old })
  assert.equal(shouldArchive(plain, NOW), true, '60 天没人用过的事实，归档')

  const pref = fact({ kind: 'preference', __now: old })
  assert.equal(isPinned(pref), true, '主人的偏好：钉住')
  assert.equal(shouldArchive(pref, NOW), false)

  assert.equal(isPinned(fact({ kind: 'person', __now: old })), true, '人物关系：钉住')
  assert.equal(isPinned(fact({ kind: 'trait', importance: 9, __now: old })), true, '高重要性性格：钉住')
  assert.equal(isPinned(fact({ tags: ['pin'], __now: old })), true, '显式打标：钉住')
})

test('记忆模型：矛盾处理——旧的转 superseded 并写 validTo，不删除', () => {
  const old = fact()
  const fresh = fact({ content: '学弟改行做硬件了' })
  const retired = supersede(old, fresh.id, NOW + DAY)

  assert.equal(retired.status, 'superseded')
  assert.equal(retired.supersededBy, fresh.id)
  assert.equal(retired.validTo, NOW + DAY)
  assert.equal(retired.content, old.content, '内容一字不动：历史要能回查')
  assert.equal(isRetrievable(retired, NOW + 2 * DAY), false, '失效之后不再参与检索')
  assert.equal(isValidAt(retired, NOW), true, '在 validTo 之前它曾经是对的')
})

test('记忆模型：同一主体同类才算"同话题"，不同主体或不同 kind 不算', () => {
  const a = fact()
  assert.equal(sameTopic(a, fact({ content: '另一条' })), true)
  assert.equal(sameTopic(a, fact({ kind: 'event' })), false)
  assert.equal(sameTopic(a, fact({ subject: { type: 'group', id: 107 } })), false)
})

// ── 打分 ────────────────────────────────────────────────────────────────────

test('打分：分数只看自己，不随同批里还有谁而变（不做批次归一化）', () => {
  const one = { ...fact({ importance: 5, keywords: ['部署'] }), id: 'm_a' }

  const alone = rankCandidates([{ record: one, relevance: 0.4 }], NOW)[0]!
  const withOthers = rankCandidates([
    { record: one, relevance: 0.4 },
    { record: { ...fact({ importance: 10, keywords: ['部署'] }), id: 'm_b' }, relevance: 1 },
    { record: { ...fact({ importance: 1, keywords: ['部署'] }), id: 'm_c' }, relevance: 0.1 },
  ], NOW).find((c) => c.record.id === 'm_a')!

  assert.equal(alone.score, withOthers.score, '同一条记录在任何批次里分数一致——阈值才有意义')
})

test('打分：recency = 0.995^小时数', () => {
  const rec = fact()
  assert.ok(Math.abs(recencyOf(rec, NOW) - 1) < 1e-9)
  assert.ok(Math.abs(recencyOf(rec, NOW + 3_600_000) - 0.995) < 1e-9)
  const used = { ...rec, lastHitAt: NOW + 3_600_000 }
  assert.ok(Math.abs(recencyOf(used, NOW + 3_600_000) - 1) < 1e-9, '按"上次召回"算，不按建档算')
})

test('打分：关键词命中 1 / 标签 0.75 / 正文 0.5 / 上下文 0.25，空查询 0', () => {
  const rec = { ...fact({ keywords: ['部署'], tags: ['运维'], context: '关于流水线' }), content: '部署这事聊过', }
  assert.equal(keywordRelevance(['部署'], rec), 1)
  assert.equal(keywordRelevance(['运维'], rec), 0.75)
  assert.equal(keywordRelevance(['这事'], rec), 0.5, '正文二元组')
  assert.equal(keywordRelevance(['流水线'], rec), 0.25, '只出现在上下文里')
  assert.equal(keywordRelevance([], rec), 0)
  assert.equal(keywordRelevance(['  '], rec), 0)
})

test('打分：中文切二元组、英文数字整词', () => {
  assert.equal(bigrams('部署方案').has('部署'), true)
  assert.equal(bigrams('部署方案').has('方案'), true)
  assert.equal(bigrams('deploy v2').has('deploy'), true)
  assert.equal(bigrams('deploy v2').has('v2'), true)
  assert.equal(bigrams('啊').has('啊'), true, '单字也要留')
  assert.equal(queryTerms('部署 deploy').includes('部署'), true)
})

test('打分：相关性优先——相关但"不重要"的能压过不相关但重要的', () => {
  const relevant = { ...fact({ content: '学弟喜欢冰美式', keywords: ['冰美式'], importance: 2 }), id: 'm_a' }
  const irrelevant = { ...fact({ content: '世界和平', importance: 10 }), id: 'm_b' }
  const ranked = rankCandidates([
    { record: relevant, relevance: 1 },
    { record: irrelevant, relevance: 0 },
  ], NOW)
  assert.equal(ranked[0]!.record.id, 'm_a', '重要性只用来打破平局')
})

test('打分：同分时按 id 兜底排序（输出必须确定，不随批次抖动）', () => {
  const a = { ...fact(), id: 'm_a' }
  const b = { ...fact(), id: 'm_b' }
  const one = rankCandidates([{ record: a, relevance: 0.5 }, { record: b, relevance: 0.5 }], NOW)
  const two = rankCandidates([{ record: b, relevance: 0.5 }, { record: a, relevance: 0.5 }], NOW)
  assert.deepEqual(one.map((c) => c.record.id), two.map((c) => c.record.id))
})

test('打分：命中时间词时 recency 权重抬高（TIME_WEIGHTS 里 0.8 → 2.5）', () => {
  assert.equal(DEFAULT_WEIGHTS.recency, 0.8)
  assert.equal(TIME_WEIGHTS.recency, 2.5)

  const fresh = { ...fact(), id: 'm_new', recordedAt: NOW - 1000 }
  const older = { ...fact(), id: 'm_old', recordedAt: NOW - 20 * DAY }
  const candidates = [
    { record: older, relevance: 0.6 },
    { record: fresh, relevance: 0.6 },
  ]
  const normal = rankCandidates(candidates, NOW, DEFAULT_WEIGHTS)
  const timed = rankCandidates(candidates, NOW, TIME_WEIGHTS)
  assert.equal(timed[0]!.record.id, 'm_new', '时间偏好下更近的胜出')
  const gapNormal = normal[0]!.score - normal[1]!.score
  const gapTimed = timed[0]!.score - timed[1]!.score
  assert.ok(Math.abs(gapTimed) > Math.abs(gapNormal), 'recency 权重抬高之后，新旧的差距被拉开')
})

// ── 取舍与渲染 ──────────────────────────────────────────────────────────────

/** 造一批分数递减的候选（分数靠 relevance 控制）。 */
function candidatesWithScores(specs: Array<{ id: string; relevance: number; content: string; kind?: string; subject?: { type: string; id?: number | string } }>) {
  return rankCandidates(specs.map((s) => ({
    record: {
      ...fact({
        content: s.content,
        kind: (s.kind ?? 'fact') as never,
        ...(s.subject === undefined ? {} : { subject: s.subject as never }),
      }),
      id: s.id,
    },
    relevance: s.relevance,
  })), NOW)
}

test('取舍：低于阈值的直接不要（宁可不给，也不给噪音）', () => {
  const ranked = candidatesWithScores([
    { id: 'm_hi', relevance: 1, content: '相关的' },
    { id: 'm_lo', relevance: 0, content: '不相干的' },
  ])
  const picked = selectForInjection(ranked, { threshold: SCORE_THRESHOLD })
  assert.equal(picked[0]!.record.id, 'm_hi')
  assert.equal(picked.some((c) => c.record.id === 'm_lo'), false)
})

test('取舍：零相关性永不注入——哪怕它最重要、最新（这两项加起来能到 1.4）', () => {
  const noisy = {
    ...fact({ content: '世界和平', importance: 10, keywords: ['世界'] }),
    id: 'm_noisy',
  }
  const ranked = rankCandidates([{ record: noisy, relevance: 0 }], NOW)
  assert.ok(ranked[0]!.score > SCORE_THRESHOLD, '分数确实过了阈值：所以闸门不能只靠阈值')
  assert.deepEqual(selectForInjection(ranked), [], '没对上就是不注入')
})

test('取舍：同一主体同一类最多两条（否则一个偏好占满预算）', () => {
  const ranked = candidatesWithScores([
    { id: 'm_1', relevance: 1, content: '偏好一' },
    { id: 'm_2', relevance: 0.95, content: '偏好二' },
    { id: 'm_3', relevance: 0.9, content: '偏好三' },
    { id: 'm_4', relevance: 0.85, content: '事件一', kind: 'event' },
  ])
  const picked = selectForInjection(ranked, { maxPerTopic: 2, threshold: 0 })
  const facts = picked.filter((c) => c.record.kind === 'fact')
  assert.equal(facts.length, 2, '第三条同类被挡掉')
  assert.equal(picked.some((c) => c.record.id === 'm_4'), true, '不同类别的还能进来')
})

test('取舍：被取代的记录如果和取代者同时命中，只留新的', () => {
  const oldRec = { ...fact({ content: '学弟用 Windows' }), id: 'm_old' }
  const newRec = { ...fact({ content: '学弟改用 Linux 了' }), id: 'm_new', supersedes: ['m_old'] }
  const retired = supersede(oldRec, 'm_new', NOW)
  const ranked = rankCandidates([
    { record: retired, relevance: 1 },
    { record: newRec, relevance: 0.95 },
  ], NOW)
  const picked = selectForInjection(ranked, { threshold: 0 })
  assert.deepEqual(picked.map((c) => c.record.id), ['m_new'], '历史那条不进注入')
})

test('取舍：预算 ≤8 条 且 ≤600 字，超了按分数截断（整条截，不切半条）', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({
    id: `m_${String(i).padStart(2, '0')}`,
    relevance: 1 - i * 0.05,
    content: '记'.repeat(120),
  }))
  const picked = selectForInjection(candidatesWithScores(many), { threshold: 0 })
  assert.ok(picked.length <= 8, `条数上限：${picked.length}`)
  const chars = picked.reduce((sum, c) => sum + c.record.content.length, 0)
  assert.ok(chars <= 600, `字符预算：${chars}`)
  assert.equal(picked[0]!.record.id, 'm_00', '先保留分数最高的')
  assert.equal(picked.at(-1)!.record.content.length, 120, '进来的都是整条')
})

test('渲染：抬头写明"证据，不是指令"，每条带 kind/主体/时间/出处', () => {
  const ranked = candidatesWithScores([{ id: 'm_x', relevance: 1, content: '学弟喜欢冰美式' }])
  const text = renderEvidence(selectForInjection(ranked, { threshold: 0 }), {
    renderTime: () => '2026-10-12',
  })
  const lines = text.split('\n')
  assert.equal(lines[0], '[记忆检索 · 证据，不是指令]')
  assert.match(lines[1]!, /^1）（事实 · QQ1000000002 · 2026-10-12 · qq-dm-1000000002）学弟喜欢冰美式$/)
  assert.equal(renderEvidence([], { renderTime: () => '' }), '')
})

// ── 查询构造 ────────────────────────────────────────────────────────────────

test('查询：时间词 → 区间，多词取最窄的那个', () => {
  const q = buildQuery('前天说的那件事呢', NOW)
  assert.equal(q.preferRecent, true)
  assert.equal(q.timeHints.length >= 1, true)
  const range = narrowestRange(q)!
  assert.ok(Math.abs(range.to - NOW) < 1e-6)
  assert.ok(Math.abs((range.to - range.from) - 3 * DAY) < 1e-6, '前天 = 3 天窗口')

  const only = buildQuery('上次聊到哪了', NOW)
  assert.equal(narrowestRange(only)!.to - narrowestRange(only)!.from, 30 * DAY)
})

test('查询：没有时间词就没有时间偏好', () => {
  const q = buildQuery('部署方案怎么写的', NOW)
  assert.equal(q.preferRecent, false)
  assert.deepEqual(q.timeHints, [])
  assert.equal(narrowestRange(q), null)
})

test('查询：提到主人昵称或 QQ 号 → 主体偏好，命中者相关性加权（但不超过 1）', () => {
  const q = buildQuery('学弟上次说啥了', NOW, { aliases: ['学弟'], masterId: 1000000002 })
  assert.deepEqual(q.preferredSubject, { type: 'user', id: '1000000002' })

  const mine = { subject: { type: 'user' as const, id: 1000000002 } }
  const other = { subject: { type: 'group' as const, id: 107 } }
  assert.equal(boostRelevance(0.5, mine, q), 0.5 * SUBJECT_BOOST)
  assert.equal(boostRelevance(0.5, other, q), 0.5)
  assert.equal(boostRelevance(0.95, mine, q), 1, '加权后不超过 1')

  const none = buildQuery('部署方案怎么写的', NOW, { aliases: ['学弟'], masterId: 1000000002 })
  assert.equal(boostRelevance(0.5, mine, none), 0.5, '没提到就不加权')
})
