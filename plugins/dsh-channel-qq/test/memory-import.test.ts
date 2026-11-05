/** 旧库 → 新库导入：去重、幂等、字段映射。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import * as path from 'node:path'
import { tmpdir } from 'node:os'

const { MemoryStore } = await import('../src/features/memory/store.js')
const { importLegacyEntries } = await import('../src/features/memory/import-legacy.js')

function withStore(fn: (store: InstanceType<typeof MemoryStore>, dir: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'qq-import-'))
    const store = new MemoryStore({ workspacePath: dir, dshHome: dir, log: () => {} })
    await store.load()
    try { await fn(store, dir) } finally { rmSync(dir, { recursive: true, force: true }) }
  }
}

const legacy = [
  { type: 'fact', content: '面板监听在 127.0.0.1', tags: ['运维'], source: '日记 2026-10-16', created: 1790000000000 },
  { type: 'preference', content: '学弟不吃香菜', tags: ['饮食'], source: '聊天' },
  { type: 'unknown-kind', content: '不认识的类型按事实存', tags: [] },
  { type: 'fact', content: '   ', tags: [] },
]

test('导入：映射字段、跳过空内容、未知类型按事实', withStore(async (store) => {
  const logs: string[] = []
  const n = await importLegacyEntries(store, legacy, { now: 1_800_000_000_000, roll: () => 0.5, log: (l) => logs.push(l) })
  assert.equal(n, 3)
  const all = store.all()
  assert.equal(all.length, 3)
  const pref = all.find((r) => r.kind === 'preference')
  assert.ok(pref !== undefined)
  assert.equal(pref!.content, '学弟不吃香菜')
  assert.equal(pref!.source.kind, 'migration')
  assert.ok(all.some((r) => r.kind === 'fact' && r.content.includes('不认识的类型')))
  assert.match(logs.join('\n'), /旧库 4 条 → 导入 3 条/)
}))

test('导入是幂等的：再跑一次不会重复', withStore(async (store) => {
  await importLegacyEntries(store, legacy, { now: 1, roll: () => 0.1, log: () => {} })
  const second = await importLegacyEntries(store, legacy, { now: 2, roll: () => 0.2, log: () => {} })
  assert.equal(second, 0)
  assert.equal(store.all().length, 3)
}))
