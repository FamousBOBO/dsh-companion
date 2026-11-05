/** 记忆库卫生（PR #2）：外部写入惰性重载 + 超长内容去重。
 *
 * 防两件事：夜间蒸馏/迁移脚本写完，召回端还看着旧内存；以及超长内容截断后
 * 每次都被当成新记录重复入库。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

const { MemoryStore } = await import('../src/features/memory/store.js')
const { createMemoryService } = await import('../src/features/memory/service.js')
const { makeRecord, oneLine } = await import('../src/core/memory/model.js')

function scratch() {
  const dir = mkdtempSync(path.join(tmpdir(), 'mem-hyg-'))
  return {
    dir,
    store: (tag: string) => new MemoryStore({ workspacePath: dir, dshHome: dir, log: () => tag }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

test('记忆卫生：外部进程写入后 refreshIfChanged 当轮可见', async () => {
  const s = scratch()
  try {
    const reader = s.store('reader')
    await reader.load()
    assert.equal(reader.size(), 0)
    const writer = s.store('writer')
    await writer.load()
    await writer.put(makeRecord({
      kind: 'fact', subject: { type: 'world' }, content: '外部写入的一条', source: { kind: 'manual' },
    }, Date.now(), () => 0.5))
    assert.equal(await reader.refreshIfChanged(), true)
    assert.equal(reader.size(), 1)
    assert.equal(await reader.refreshIfChanged(), false, 'mtime 没变就不要再读')
  } finally { s.cleanup() }
})

test('记忆卫生：超长内容先归一化再判重，不会重复入库', async () => {
  const s = scratch()
  try {
    const store = s.store('t')
    await store.load()
    const service = createMemoryService({
      store, log: () => {}, renderTime: (at) => new Date(at).toISOString().slice(0, 10),
      clock: { now: () => Date.now() }, legacy: null,
    })
    const content = `这是一段很长的偏好描述${'啊'.repeat(300)}`
    const first = await service.memorize({ content, kind: 'preference' })
    assert.equal(first.created, true)
    const second = await service.memorize({ content, kind: 'preference' })
    assert.equal(second.created, false, '截断后应认出是同一条')
    assert.equal(store.size(), 1)
    assert.equal(oneLine(content).length <= 200, true)
  } finally { s.cleanup() }
})
