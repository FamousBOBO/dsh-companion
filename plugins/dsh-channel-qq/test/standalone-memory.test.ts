/** 记忆独立入口（PR #1）：写入/召回/证据、日期口径、原文块排除。
 *
 * 防的是"独立入口和插件行为不一致"：证据里混进 600 字原文块、或时间戳格式漂移。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

const { createMemoryV2 } = await import('../src/standalone-memory.js')
const { makeRecord } = await import('../src/core/memory/model.js')

test('独立记忆：写入、召回、检索、证据日期只到天', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mem-standalone-'))
  try {
    const mem = await createMemoryV2({ dshHome: dir, workspacePath: dir, log: () => {} })
    const saved = await mem.memorize({ content: '学弟喜欢冰美式', kind: 'preference', tags: ['咖啡'] })
    assert.equal(saved.created, true)
    assert.equal((await mem.recall({ query: '冰美式', limit: 3 }))[0]?.content, '学弟喜欢冰美式')
    assert.equal(mem.search('咖啡')[0]?.content, '学弟喜欢冰美式')
    const evidence = await mem.evidence({ text: '今天喝什么咖啡', room: 'group-1', isGroup: true })
    assert.match(evidence, /冰美式/)
    assert.match(evidence, /\d{4}-\d{2}-\d{2}/)
    assert.equal(evidence.includes('T'), false, '证据里不该出现完整 ISO 时间')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('独立记忆：证据排除原文块（tags: chunk）', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mem-standalone-'))
  try {
    const mem = await createMemoryV2({ dshHome: dir, workspacePath: dir, log: () => {} })
    await mem.store.put(makeRecord({
      kind: 'fact', subject: { type: 'world' }, content: '这是一段原文块内容，不应该被自动注入',
      tags: ['chunk'], source: { kind: 'manual' },
    }, Date.now(), () => 0.5))
    const evidence = await mem.evidence({ text: '原文块内容', room: 'group-1', isGroup: true })
    assert.equal(evidence.includes('不应该被自动注入'), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
