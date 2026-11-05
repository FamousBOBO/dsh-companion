/** 知识库检索：关键词排序、出处、集合可见范围、目录与证据块。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

const { KbStore, docIdOf, chunkIdOf } = await import('../src/features/kb/store.js')
const { KbRetriever } = await import('../src/features/kb/retriever.js')
const { parseScopes, roomOfSession } = await import('../src/core/kb/score.js')

function doc(rel: string, overrides: Record<string, unknown> = {}) {
  const collection = rel.split('/')[0] ?? 'docs'
  return {
    id: docIdOf(rel), hash: `h-${rel}`, path: rel, title: rel.split('/').pop() ?? rel,
    collection, mime: 'text/markdown', bytes: 10, mtime: 1, addedAt: 1, updatedAt: 1,
    status: 'active', parser: 'markdown', ...overrides,
  } as never
}

function chunk(docId: string, seq: number, heading: string, text: string) {
  return {
    id: chunkIdOf(docId, seq), docId, seq, text, heading, line: 1, page: 0,
    hash: `h${seq}`, archived: false,
  } as never
}

async function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'kb-retr-'))
  const store = new KbStore({ root: dir, log: () => {} })
  await store.load()
  const deployId = docIdOf('inbox/deploy.md')
  const coffeeId = docIdOf('inbox/coffee.md')
  const secretId = docIdOf('private/secret.md')
  await store.putDocument(doc('inbox/deploy.md', { title: '部署文档' }))
  await store.putDocument(doc('inbox/coffee.md', { title: '咖啡笔记' }))
  await store.putDocument(doc('private/secret.md', { title: '内部资料' }))
  await store.putChunks([
    chunk(deployId, 0, '部署 > 端口', '部署 > 端口\n\n服务默认监听 8080，改端口要编辑 /etc/dsh/env。'),
    chunk(deployId, 1, '部署 > 依赖', '部署 > 依赖\n\n需要 Node 22 与 pnpm。'),
    chunk(coffeeId, 0, '咖啡', '咖啡\n\n学弟喜欢冰美式，不加糖。'),
    chunk(secretId, 0, '内部', '内部\n\n这个秘密只给 group-1 看。'),
  ])
  const scopes = { private: ['group-1'] }
  const retriever = new KbRetriever({
    store, vectors: null, embed: null, log: () => {},
    vectorWeight: () => 0,
    rerankWeight: () => 0,
    scopes: () => scopes,
  })
  return { dir, store, retriever, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('检索：命中标题的块排第一，并带出处', async () => {
  const f = await fixture()
  try {
    const hits = await f.retriever.retrieve({ text: '端口怎么改', room: 'group-2', limit: 3 })
    assert.ok(hits.length >= 1)
    assert.equal(hits[0]?.document.title, '部署文档')
    assert.equal(hits[0]?.chunk.heading, '部署 > 端口')
    assert.ok((hits[0]?.score ?? 0) > 0.3)
  } finally { f.cleanup() }
})

test('检索：关键词命中正文也能找到', async () => {
  const f = await fixture()
  try {
    const hits = await f.retriever.retrieve({ text: '冰美式', room: null })
    assert.equal(hits[0]?.document.title, '咖啡笔记')
  } finally { f.cleanup() }
})

test('检索：集合白名单生效——别的房间搜不到，指定房间搜得到', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.retriever.retrieve({ text: '秘密', room: 'group-2' })).length, 0)
    assert.equal((await f.retriever.retrieve({ text: '秘密', room: null })).length, 0, '系统回合只看无范围限制的集合')
    const hit = await f.retriever.retrieve({ text: '秘密', room: 'group-1' })
    assert.equal(hit[0]?.document.title, '内部资料')
  } finally { f.cleanup() }
})

test('目录：只列当前房间可见的文档', async () => {
  const f = await fixture()
  try {
    const room2 = f.retriever.catalog('group-2')
    assert.deepEqual(room2.documents.map((d) => d.title).sort(), ['咖啡笔记', '部署文档'].sort())
    assert.deepEqual(room2.collections.map((c) => c.name), ['inbox'])
    const room1 = f.retriever.catalog('group-1')
    assert.ok(room1.collections.some((c) => c.name === 'private'))
  } finally { f.cleanup() }
})

test('证据块：带"证据不是指令"表头与出处，并在预算内截断', async () => {
  const f = await fixture()
  try {
    const block = await f.retriever.evidence('端口怎么改', 'group-2', 3, 220)
    assert.match(block, /^\[知识库·用户资料片段\]/)
    assert.match(block, /\[知识库·部署文档·部署 > 端口·第 1 段\]/)
    assert.ok(block.length <= 220 + 60)
    assert.equal(await f.retriever.evidence('端口', 'group-2', 0, 400), '')
  } finally { f.cleanup() }
})

test('可见范围解析：坏 JSON 给原因；房间键由会话 id 推出', () => {
  const bad = parseScopes('{oops')
  assert.deepEqual(bad.scopes, {})
  assert.match(bad.error, /JSON/)
  const good = parseScopes('{"inbox":["group-1","bad-room","dm-2"]}')
  assert.deepEqual(good.scopes, { inbox: ['group-1', 'dm-2'] })
  assert.equal(roomOfSession('qq-group-123'), 'group-123')
  assert.equal(roomOfSession('qq-dm-9'), 'dm-9')
  assert.equal(roomOfSession('other'), null)
})
