/** 知识库存储：追加式落盘、软删除/恢复、压缩、坏行容忍。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, appendFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

const { KbStore, docIdOf, chunkIdOf } = await import('../src/features/kb/store.js')

function scratch() {
  const dir = mkdtempSync(path.join(tmpdir(), 'kb-store-'))
  const logs: string[] = []
  const store = new KbStore({ root: dir, log: (line: string) => logs.push(line) })
  return { dir, store, logs, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function doc(overrides: Record<string, unknown> = {}) {
  return {
    id: docIdOf('inbox/a.md'), hash: 'h1', path: 'inbox/a.md', title: 'A',
    collection: 'inbox', mime: 'text/markdown', bytes: 10, mtime: 1,
    addedAt: 1, updatedAt: 1, status: 'active', parser: 'markdown', ...overrides,
  } as never
}

function chunk(docId: string, seq: number, text: string, overrides: Record<string, unknown> = {}) {
  return {
    id: chunkIdOf(docId, seq), docId, seq, text, heading: '', line: 1, page: 1,
    hash: `h${seq}`, archived: false, ...overrides,
  } as never
}

test('存储：空库 load 不建文件', async () => {
  const s = scratch()
  try {
    assert.deepEqual(await s.store.load(), { docs: 0, chunks: 0 })
    assert.equal(existsSync(s.store.docsFile), false)
  } finally { s.cleanup() }
})

test('存储：写入后新实例能读回（后写胜出）', async () => {
  const s = scratch()
  try {
    const id = docIdOf('inbox/a.md')
    await s.store.putDocument(doc())
    await s.store.putChunks([chunk(id, 0, '第一块'), chunk(id, 1, '第二块')])
    const again = new KbStore({ root: s.dir, log: () => {} })
    assert.deepEqual(await again.load(), { docs: 1, chunks: 2 })
    assert.equal(again.docByPath('inbox/a.md')?.title, 'A')
    assert.equal(again.activeChunks().length, 2)
    assert.equal(again.collections()[0]?.name, 'inbox')
    assert.equal(again.collections()[0]?.chunkCount, 2)
  } finally { s.cleanup() }
})

test('存储：归档后不再检索；同 id 重写会复活', async () => {
  const s = scratch()
  try {
    const id = docIdOf('inbox/a.md')
    await s.store.putDocument(doc())
    await s.store.putChunks([chunk(id, 0, '旧')])
    assert.equal(await s.store.archiveChunks(id), 1)
    assert.equal(s.store.activeChunks().length, 0)
    await s.store.putChunks([chunk(id, 0, '新')])
    assert.equal(s.store.activeChunks()[0]?.text, '新')
  } finally { s.cleanup() }
})

test('存储：移除 = 文档 deleted + 块归档；恢复把块带回', async () => {
  const s = scratch()
  try {
    const id = docIdOf('inbox/a.md')
    await s.store.putDocument(doc())
    await s.store.putChunks([chunk(id, 0, '内容')])
    assert.equal(await s.store.removeDocument(id, 99), true)
    assert.equal(s.store.getDoc(id)?.status, 'deleted')
    assert.equal(s.store.activeChunks().length, 0)
    assert.equal(await s.store.restoreDocument(id, 100), true)
    assert.equal(s.store.getDoc(id)?.status, 'active')
    assert.equal(s.store.activeChunks().length, 1)
    assert.equal(await s.store.removeDocument('missing', 1), false)
  } finally { s.cleanup() }
})

test('存储：压缩后每个实体只剩一行', async () => {
  const s = scratch()
  try {
    const id = docIdOf('inbox/a.md')
    for (let i = 0; i < 5; i += 1) await s.store.putDocument(doc({ updatedAt: i }))
    await s.store.putChunks([chunk(id, 0, 'x'), chunk(id, 0, 'y')])
    await s.store.compact()
    assert.equal(readFileSync(s.store.docsFile, 'utf8').trim().split('\n').length, 1)
    assert.equal(readFileSync(s.store.chunksFile, 'utf8').trim().split('\n').length, 1)
  } finally { s.cleanup() }
})

test('存储：坏行跳过并记日志，好行照读', async () => {
  const s = scratch()
  try {
    const id = docIdOf('inbox/a.md')
    await s.store.putDocument(doc())
    await s.store.putChunks([chunk(id, 0, '好块')])
    appendFileSync(s.store.docsFile, '{不是 json}\n', 'utf8')
    appendFileSync(s.store.chunksFile, '{"id":1}\n', 'utf8')
    const again = new KbStore({ root: s.dir, log: (line: string) => { s.logs.push(line) } })
    await again.load()
    assert.equal(again.documents().length, 1)
    assert.equal(again.activeChunks().length, 1)
    assert.ok(s.logs.some((line) => line.includes('documents.jsonl')))
    assert.ok(s.logs.some((line) => line.includes('chunks.jsonl')))
  } finally { s.cleanup() }
})

test('存储：stats 只把 active 文档算进字节与集合', async () => {
  const s = scratch()
  try {
    await s.store.putDocument(doc())
    await s.store.putDocument(doc({
      id: docIdOf('downloads/b.md'), path: 'downloads/b.md', collection: 'downloads', status: 'error', bytes: 99,
    }))
    const stats = s.store.stats()
    assert.equal(stats.docs, 2)
    assert.equal(stats.activeDocs, 1)
    assert.equal(stats.bytes, 10)
    assert.equal(stats.collections, 1)
  } finally { s.cleanup() }
})
