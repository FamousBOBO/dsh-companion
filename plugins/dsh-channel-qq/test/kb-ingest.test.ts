/** 摄取：哈希增量、文件改动后的归档、删除检测、解析失败的记录方式。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

const { KbStore } = await import('../src/features/kb/store.js')
const { KbIngestor } = await import('../src/features/kb/ingest.js')

async function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'kb-ing-'))
  mkdirSync(path.join(dir, 'inbox'), { recursive: true })
  const store = new KbStore({ root: dir, log: () => {} })
  await store.load()
  const ingestor = new KbIngestor({
    store, workspace: dir, dirs: 'inbox,downloads', maxBytes: 1024 * 1024,
    doclingUrl: '', log: () => {},
  })
  return { dir, store, ingestor, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('摄取：新增 → 再扫跳过 → 改动后更新', async () => {
  const f = await fixture()
  try {
    writeFileSync(path.join(f.dir, 'inbox', 'a.md'), '# 部署\n\n监听 8080。', 'utf8')
    const first = await f.ingestor.run()
    assert.equal(first.added, 1)
    assert.equal(first.failed, 0)
    assert.equal(f.store.documents()[0]?.status, 'active')
    assert.equal(f.store.activeChunks().length, 1)

    const second = await f.ingestor.run()
    assert.equal(second.skipped, 1)
    assert.equal(second.added, 0)

    writeFileSync(path.join(f.dir, 'inbox', 'a.md'), '# 部署\n\n监听 9090。\n\n# 附\n\n更多内容', 'utf8')
    const third = await f.ingestor.run()
    assert.equal(third.updated, 1)
    assert.ok(f.store.activeChunks().length >= 2)
    assert.ok(f.store.activeChunks().every((chunk) => !chunk.text.includes('8080')))
  } finally { f.cleanup() }
})

test('摄取：文件变短时多出来的旧块归档（不再检索）', async () => {
  const f = await fixture()
  try {
    writeFileSync(path.join(f.dir, 'inbox', 'a.md'), `# 一\n\n${'甲'.repeat(3000)}`, 'utf8')
    await f.ingestor.run()
    const before = f.store.activeChunks().length
    assert.ok(before > 2)
    writeFileSync(path.join(f.dir, 'inbox', 'a.md'), '# 一\n\n短了', 'utf8')
    await f.ingestor.run()
    assert.ok(f.store.activeChunks().length < before)
    assert.equal(f.store.documents()[0]?.status, 'active')
  } finally { f.cleanup() }
})

test('摄取：磁盘删除的文件从索引移除（磁盘文件不删）', async () => {
  const f = await fixture()
  try {
    writeFileSync(path.join(f.dir, 'inbox', 'gone.md'), '# 临时\n\n内容', 'utf8')
    await f.ingestor.run()
    rmSync(path.join(f.dir, 'inbox', 'gone.md'))
    const after = await f.ingestor.run()
    assert.equal(after.removed, 1)
    assert.equal(f.store.documents()[0]?.status, 'deleted')
    assert.equal(f.store.activeChunks().length, 0)
  } finally { f.cleanup() }
})

test('摄取：没有 Docling 时 PDF 记解析失败，不中断整轮', async () => {
  const f = await fixture()
  try {
    writeFileSync(path.join(f.dir, 'inbox', 'ok.md'), '# 好的\n\n文本', 'utf8')
    writeFileSync(path.join(f.dir, 'inbox', 'scan.pdf'), '%PDF-1.4 fake', 'utf8')
    const result = await f.ingestor.run()
    assert.equal(result.added, 1)
    assert.equal(result.failed, 1)
    const pdf = f.store.documents().find((doc) => doc.path.endsWith('.pdf'))
    assert.equal(pdf?.status, 'error')
    assert.match(pdf?.error ?? '', /Docling/)
    // 同一份文件下一轮不反复重试（除非 force）。
    const again = await f.ingestor.run()
    assert.equal(again.failed, 0)
    assert.equal(again.skipped, 2)
  } finally { f.cleanup() }
})
