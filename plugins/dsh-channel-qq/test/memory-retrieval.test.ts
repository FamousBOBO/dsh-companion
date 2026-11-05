/** P6e·e4 检索侧改动的测试：查询词过滤、IDF、df 过滤、评测切分器。
 *
 * 这些改动都是 60 题基准**实测逼出来的**（见 内部文档 §9）：
 *   - 停用虚词：中文问句的虚词二元组在语料里到处都是，会把真关键词淹掉；
 *   - IDF：命中一个罕见词与命中一个高频词不该同分；
 *   - `keepKnown`：库里根本不存在的查询词不会命中，只会稀释分母；
 *   - 句子级切分：评测语料要是"一句话事实"，不是几百字的段落。
 *
 * 一条回归保护：`keywordRelevance` **不传 IDF 时行为与从前一致**（既有测试与
 * 生产路径之外的老调用都靠它）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

const { queryTerms, keywordRelevance, bigrams } = await import('../src/core/memory/score.js')
const { makeRecord } = await import('../src/core/memory/model.js')
const { MemoryStore } = await import('../src/features/memory/store.js')
// 评测器是纯 JS（.mjs），没有类型声明。用 `import.meta.url` 而不是字面相对路径：
// 测试编译到 `lib-test/test/`，字面路径 `../eval/…` 会解析到 `lib-test/eval/…`。
const corpusUrl = new URL('../../../eval/memory/corpus.mjs', import.meta.url).href
const { splitDiary, MIN_SEGMENT_CHARS } = await import(corpusUrl)

const NOW = Date.parse('2026-10-17T12:00:00+08:00')

function record(content: string) {
  return makeRecord({
    kind: 'fact',
    subject: { type: 'self' },
    content,
    source: { kind: 'diary', file: 'x.md', line: 1 },
  }, NOW, () => 0.5)
}

// ── 查询词过滤 ──────────────────────────────────────────────────────────────

test('queryTerms：问句里的虚词二元组不参与匹配', () => {
  const terms = queryTerms('学弟为什么不愿意把面板关掉？')
  for (const stop of ['为什么', '么不', '不愿', '愿意']) {
    assert.ok(!terms.includes(stop), `${stop} 是虚词，不该进查询`)
  }
  assert.ok(terms.includes('学弟'))
  assert.ok(terms.includes('面板'))
  assert.ok(terms.includes('关掉'))
})

test('queryTerms：单字虚词不参与匹配，实词留着', () => {
  const terms = queryTerms('他 在 哪儿 说 的 部署')
  assert.ok(!terms.includes('的'))
  assert.ok(terms.includes('部署'))
})

test('queryTerms：全被过滤掉时退回原样（不做空查询）', () => {
  const terms = queryTerms('是什么')
  assert.ok(terms.length > 0, '哪怕只剩虚词也要能查')
})

// ── IDF ─────────────────────────────────────────────────────────────────────

test('idfOf：罕见词比常见词值钱，且不设上限（否则一起撞顶等于没有 IDF）', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'qq-idf-'))
  try {
    const store = new MemoryStore({ workspacePath: dir, dshHome: dir, log: () => {} })
    await store.load()
    for (let i = 0; i < 20; i += 1) await store.remember({ kind: 'fact', subject: { type: 'self' }, content: '学弟今天在忙', source: { kind: 'diary' } }, NOW, () => 0.1 + i / 100)
    await store.remember({ kind: 'fact', subject: { type: 'self' }, content: '设备池只耗不补', source: { kind: 'diary' } }, NOW, () => 0.9)
    const common = store.idfOf('学弟')
    const rare = store.idfOf('设备')
    assert.ok(rare > common, `罕见词(${rare.toFixed(2)}) 应当高于常见词(${common.toFixed(2)})`)
    assert.ok(store.idfOf('谁都没提过') >= 0.5, '有下限')
    assert.ok(rare > 1, '不设上限：df 小的词要能明显高于 1')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('keepKnown：库里没有的词不进查询；全没有时退回原样', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'qq-keep-'))
  try {
    const store = new MemoryStore({ workspacePath: dir, dshHome: dir, log: () => {} })
    await store.load()
    await store.remember({ kind: 'fact', subject: { type: 'self' }, content: '学弟在准备考试', source: { kind: 'diary' } }, NOW, () => 0.5)
    assert.deepEqual(store.keepKnown(['学弟', '考试', '弟为']), ['学弟', '考试'], '库里没有的「弟为」被去掉')
    assert.deepEqual(store.keepKnown(['弟为', '压根没有']), ['弟为', '压根没有'], '全都没有时退回原样')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('keywordRelevance：不传 IDF 时与从前同一口径（回归保护）', () => {
  const one = record('学弟不吃香菜')
  const terms = queryTerms('学弟吃什么')
  // 不传 idf：命中词数 / 总词数
  const value = keywordRelevance(terms, one)
  assert.ok(value > 0 && value <= 1)
  assert.equal(value, keywordRelevance(terms, one, () => 1), '显式给常量 1 与不传等价')
})

test('keywordRelevance：IDF 让"命中罕见词"胜过"命中高频词"', () => {
  const rare = record('设备池只耗不补')
  const common = record('学弟今天在忙')
  const terms = ['设备', '学弟']
  const idf = (t: string): number => (t === '设备' ? 4 : 1)
  assert.ok(
    keywordRelevance(terms, rare, idf) > keywordRelevance(terms, common, idf),
    '同样命中一个词时，命中罕见词的那条更相关',
  )
})

// ── 评测切分器 ──────────────────────────────────────────────────────────────

test('splitDiary：句子级切分、保留标题行、跳过代码围栏与表格', () => {
  const text = [
    '# 日记',                                     // 1
    '',
    '## 10:10 学弟答复了：面板的事',
    '他说「没事，开着吧」，我据此把建议从「关掉外网访问」改成「保留外网、换成新密码」，并把这条结论写进了 PROGRESS.md 里。',   // 4
    '```',
    '这是代码块里的内容，不该变成记忆记录。',
    '```',
    '| 表格 | 行 |',
    '## 11:00 下一轮',
    '这轮没发送，只是把之前写下的几条结论又复核了一遍，确认它们到现在还站得住脚，没有需要改口的地方。',
  ].join('\n')
  const segs = splitDiary(text, '2026-10-16.md')
  assert.ok(segs.length >= 2)
  for (const seg of segs) {
    assert.equal(seg.span.file, '2026-10-16.md')
    assert.ok(seg.content.length >= MIN_SEGMENT_CHARS, '太短的碎片不该成条')
    assert.ok(!seg.content.includes('```'))
    assert.ok(!seg.content.includes('表格'))
    assert.ok(!seg.content.startsWith('# 日记'), '一级标题不是记忆')
  }
  assert.ok(segs.some((s: { content: string }) => s.content.includes('学弟答复了')), '标题行并入段落（锚点靠它）')
  assert.ok(segs.some((s: { content: string }) => s.content.includes('开着吧')))
})

test('splitDiary：行号区间覆盖原文（锚点命中判据靠它）', () => {
  const text = ['## 标题行在第二行吗', '', '正文这一句写得足够长，长到能成为一条独立的记忆记录，用来验证切分出来的行号区间是对的。'].join('\n')
  const segs = splitDiary(text, 'a.md')
  assert.equal(segs.length, 1)
  const span = segs[0]!.span
  assert.ok(span.start <= 1 && span.end >= 1, '第一行（标题）在区间内')
  assert.ok(span.start <= 3 && span.end >= 3, '第三行（正文）也在区间内')
})

test('splitDiary 与既有 bigrams 配合：切出来的句子能命中自己的关键词', () => {
  const segs = splitDiary('## 设备池\n他说设备池只耗不补，已经从 12 台掉到 11 台了，修的时候记得把这一条补上，别让池子空掉。', 'a.md')
  assert.equal(segs.length, 1)
  assert.ok(bigrams(segs[0]!.content).has('设备'))
})
