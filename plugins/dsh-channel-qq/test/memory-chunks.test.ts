/** 原文分块索引：切块规则、行号、幂等、文件改动后的归档。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { tmpdir } from 'node:os'

const { chunkMarkdown, indexWorkspaceChunks } = await import('../src/features/memory/chunks.js')
const { MemoryStore } = await import('../src/features/memory/store.js')

test('切块：不超上限、块间有重叠、行号指向块首行', () => {
  const lines = Array.from({ length: 120 }, (_, i) => `第${i + 1}行 ${'字'.repeat(20)}`)
  const chunks = chunkMarkdown(lines.join('\n'), 200, 60)
  assert.ok(chunks.length > 3)
  for (const c of chunks) assert.ok(c.text.length <= 240, `块超长：${c.text.length}`)
  assert.equal(chunks[0]?.line, 1)
  // 相邻块首行应当递增，且重叠让下一块的首行小于上一块末行 + 1
  for (let i = 1; i < chunks.length; i += 1) {
    assert.ok((chunks[i]?.line ?? 0) > (chunks[i - 1]?.line ?? 0))
  }
  const joined = chunks.map((c) => c.text).join('\n')
  assert.match(joined, /第120行/)
})

test('切块：空文本返回空数组', () => {
  assert.deepEqual(chunkMarkdown(''), [])
})

test('索引：幂等；文件改动后旧块归档（不删除）', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'qq-chunks-'))
  try {
    mkdirSync(path.join(dir, 'memory'), { recursive: true })
    writeFileSync(path.join(dir, 'memory', 'a.md'), `# 日记\n${'内容'.repeat(400)}`, 'utf-8')
    const store = new MemoryStore({ workspacePath: dir, dshHome: dir, log: () => {} })
    await store.load()
    let n = 0
    const roll = () => ((n++ % 997) / 997)

    const first = await indexWorkspaceChunks(store, { workspace: dir, now: 1, roll, log: () => {} })
    assert.ok(first.chunks > 0)
    const count = store.all().length
    assert.equal(count, first.chunks)

    const second = await indexWorkspaceChunks(store, { workspace: dir, now: 2, roll, log: () => {} })
    assert.equal(second.archived, 0, '内容没变就不该归档')
    assert.equal(store.all().filter((r) => r.status === 'active').length, count, '幂等：不重复建')

    writeFileSync(path.join(dir, 'memory', 'a.md'), '# 日记\n只有一小段了。', 'utf-8')
    const third = await indexWorkspaceChunks(store, { workspace: dir, now: 3, roll, log: () => {} })
    assert.ok(third.archived > 0, '消失的块要归档')
    assert.equal(store.all().some((r) => r.status === 'archived'), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
