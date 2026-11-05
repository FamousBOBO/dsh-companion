/** 知识库向量：增量重建、失败不写坏文件、全部失败时不假装"没有变化"。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

const { KbVectors } = await import('../src/features/kb/vectors.js')
const { chunkIdOf } = await import('../src/features/kb/store.js')

const DIM = 3

function chunk(docId: string, seq: number, text: string) {
  return {
    id: chunkIdOf(docId, seq), docId, seq, text, heading: '', line: 1, page: 0,
    hash: `h${seq}`, archived: false,
  }
}

/** 假嵌入器：按文本长度给一个确定性向量。 */
function fakeEmbed(ok = true) {
  return {
    dim: DIM,
    available: () => true,
    embed: async (texts: readonly string[]) => ok
      ? texts.map((text) => Float32Array.from([text.length % 7 + 1, 2, 3]))
      : null,
  } as never
}

function scratch() {
  const dir = mkdtempSync(path.join(tmpdir(), 'kb-vec-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('向量：首次重建写入文件，块数一致', async () => {
  const s = scratch()
  try {
    const vectors = new KbVectors({ dir: s.dir, dim: DIM, log: () => {} })
    assert.equal(await vectors.load(), 0)
    const chunks = [chunk('d1', 0, '甲'), chunk('d1', 1, '乙乙'), chunk('d2', 0, '丙丙丙')]
    const got = await vectors.rebuild(chunks, fakeEmbed())
    assert.equal(got.embedded, 3)
    assert.equal(got.failed, 0)
    assert.equal(vectors.size(), 3)
    assert.ok(existsSync(path.join(s.dir, 'vec.bin')))
    assert.ok(vectors.vectorOf(chunks[0]!.id) !== null)
    // 新实例能从磁盘读回。
    const again = new KbVectors({ dir: s.dir, dim: DIM, log: () => {} })
    assert.equal(await again.load(), 3)
  } finally { s.cleanup() }
})

test('向量：增量重建只嵌新增块', async () => {
  const s = scratch()
  try {
    const vectors = new KbVectors({ dir: s.dir, dim: DIM, log: () => {} })
    await vectors.load()
    const first = [chunk('d1', 0, '甲'), chunk('d1', 1, '乙')]
    await vectors.rebuild(first, fakeEmbed())
    const got = await vectors.rebuild([...first, chunk('d1', 2, '丙')], fakeEmbed())
    assert.equal(got.embedded, 1)
    assert.equal(got.total, 3)
  } finally { s.cleanup() }
})

test('向量：嵌入全部失败时不写索引、也不伪装成"已是最新"', async () => {
  const s = scratch()
  try {
    const vectors = new KbVectors({ dir: s.dir, dim: DIM, log: () => {} })
    await vectors.load()
    const chunks = [chunk('d1', 0, '甲'), chunk('d1', 1, '乙')]
    const got = await vectors.rebuild(chunks, fakeEmbed(false))
    assert.equal(got.embedded, 0)
    assert.equal(got.failed, 2)
    assert.equal(vectors.size(), 0)
    // 下一次服务恢复：仍然会重新尝试（上轮没写清单，不会被当成"已索引"）。
    const retry = await vectors.rebuild(chunks, fakeEmbed())
    assert.equal(retry.embedded, 2)
    assert.equal(vectors.size(), 2)
  } finally { s.cleanup() }
})

test('向量：文档移除后其向量在重写时掉出', async () => {
  const s = scratch()
  try {
    const vectors = new KbVectors({ dir: s.dir, dim: DIM, log: () => {} })
    await vectors.load()
    await vectors.rebuild([chunk('d1', 0, '甲'), chunk('d2', 0, '乙')], fakeEmbed())
    assert.equal(vectors.size(), 2)
    const got = await vectors.rebuild([chunk('d1', 0, '甲')], fakeEmbed())
    assert.equal(got.total, 1)
    assert.equal(vectors.size(), 1)
  } finally { s.cleanup() }
})
