/** 标题感知分块：标题路径、行号、页码、超长拆分、稳定标题/集合。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { chunkText, stableHash, titleOf, collectionOf } = await import('../src/core/kb/chunk.js')

const DOC = [
  '# 安装',
  '',
  '先装依赖。',
  '',
  '## 依赖',
  '',
  '需要 Node 22。',
  '',
  '# 配置',
  '',
  '把端口写进配置。',
].join('\n')

test('分块：标题路径进块、行号指向段首', () => {
  const chunks = chunkText(DOC)
  assert.equal(chunks.length, 3)
  assert.equal(chunks[0]?.heading, '安装')
  assert.equal(chunks[1]?.heading, '安装 > 依赖')
  assert.equal(chunks[2]?.heading, '配置')
  assert.match(chunks[1]?.text ?? '', /^安装 > 依赖\n\n需要 Node 22/)
  assert.equal(chunks[0]?.line, 2, '第一段的正文从第 2 行开始')
  assert.equal(chunks[2]?.line, 10)
})

test('分块：换页符递增页码；每块都保留自己的页码', () => {
  const chunks = chunkText('# A\n第一页\f# B\n第二页')
  assert.deepEqual(chunks.map((c) => c.page), [1, 2])
})

test('分块：超长段按上限拆开，块间有重叠、标题前缀保留', () => {
  const lines = Array.from({ length: 80 }, (_, i) => `第${i + 1}行 ${'内容'.repeat(12)}`)
  const chunks = chunkText(`# 长文\n\n${lines.join('\n')}`, { size: 300, max: 360, overlap: 60 })
  assert.ok(chunks.length > 3, `应当拆成多块，实际 ${chunks.length}`)
  for (const chunk of chunks) {
    assert.ok(chunk.text.startsWith('长文\n\n'))
    assert.ok(chunk.text.length <= 360 + 20, `块超长：${chunk.text.length}`)
  }
  // 重叠：后一块的首行应当出现在前一块的尾部。
  const firstTail = chunks[0]?.text.split('\n').slice(-3).join('\n') ?? ''
  assert.ok(firstTail.length > 0)
  assert.ok(chunks[1]?.text.split('\n').some((line) => firstTail.includes(line) && line !== ''))
})

test('分块：空文本与纯空白返回空数组', () => {
  assert.deepEqual(chunkText(''), [])
  assert.deepEqual(chunkText('   \n\n  '), [])
})

test('哈希：同输入同输出，不同输入不同输出', () => {
  assert.equal(stableHash('abc'), stableHash('abc'))
  assert.notEqual(stableHash('abc'), stableHash('abd'))
})

test('标题与集合：优先第一个 Markdown 标题，否则文件名', () => {
  assert.equal(titleOf('inbox/a.md', '# 部署手册\n正文'), '部署手册')
  assert.equal(titleOf('inbox/运维笔记.md', '没有标题'), '运维笔记')
  assert.equal(collectionOf('inbox/a/b.md'), 'inbox')
  assert.equal(collectionOf('notes.md'), 'docs')
})
