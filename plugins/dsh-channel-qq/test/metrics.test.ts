/** 指标（C1/C2）：聚合算术、开关语义、token 差值、失败标记、仓库上限。
 *
 * 防的是"面板上的数字是假的"：样本必须来自真实回合边界；token 是累计投影的
 * 差值；关着开关时不能偷偷写盘。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

const { aggregateMetrics, percentile } = await import('../src/core/metrics/aggregate.js')
const { MetricsService } = await import('../src/features/metrics/service.js')
const { MetricsStore, MAX_METRIC_SAMPLES } = await import('../src/features/metrics/store.js')

const sample = (over: Record<string, unknown> = {}) => ({
  at: 1_000, room: 'group-1', ms: 100, ok: true, input: 10, output: 2, cacheRead: 3, cacheWrite: 4, ...over,
})

test('指标：分位数按最近邻取值', () => {
  assert.equal(percentile([], 50), 0)
  assert.equal(percentile([10], 90), 10)
  assert.equal(percentile([1, 2, 3, 4, 5], 50), 3)
  assert.equal(percentile([1, 2, 3, 4, 5], 90), 5)
})

test('指标：按房间与天聚合，失败计入 failed', () => {
  const now = Date.parse('2026-10-22T12:00:00+08:00')
  const day = (at: number) => new Date(at).toISOString().slice(0, 10)
  const rows = [
    sample({ at: now - 1000, room: 'group-1', ms: 100 }),
    sample({ at: now - 2000, room: 'group-1', ms: 300, ok: false }),
    sample({ at: now - 3000, room: 'dm-2', ms: 200, input: 5 }),
  ]
  const agg = aggregateMetrics(rows, now, day, 2)
  assert.equal(agg.turns, 3)
  assert.equal(agg.failed, 1)
  assert.equal(agg.rooms[0]!.room, 'group-1')
  assert.equal(agg.rooms[0]!.turns, 2)
  assert.equal(agg.rooms[0]!.failed, 1)
  assert.equal(agg.rooms[0]!.p50, 100)
  assert.equal(agg.days.length, 2)
  assert.equal(agg.days.at(-1)!.turns, 3)
})

test('指标：开关关着 → 不记任何样本', async () => {
  const samples: unknown[] = []
  const service = new MetricsService({
    enabled: () => false,
    now: () => 1000,
    usage: () => undefined,
    store: { add: (s: unknown) => samples.push(s), flush: async () => {} } as never,
    log: () => {},
  })
  service.begin('group-1')
  service.end('group-1')
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(samples.length, 0)
})

test('指标：回合耗时 + token 差值；失败标记落进样本', async () => {
  const samples: Array<Record<string, unknown>> = []
  let now = 1_000
  let usage = { uncachedInputTokens: 100, outputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 1 }
  const service = new MetricsService({
    enabled: () => true,
    now: () => now,
    usage: () => ({ usage: async () => ({ ...usage }) }),
    store: { add: (s: Record<string, unknown>) => samples.push(s), flush: async () => {} } as never,
    log: () => {},
  })
  service.begin('group-1')
  now = 1_500
  service.end('group-1')
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(samples.length, 1)
  assert.equal(samples[0]!.ms, 500)
  assert.equal(samples[0]!.input, 100)
  assert.equal(samples[0]!.ok, true)

  usage = { uncachedInputTokens: 180, outputTokens: 30, cacheReadTokens: 5, cacheWriteTokens: 1 }
  service.begin('group-1')
  service.error('group-1')
  now = 1_700
  service.end('group-1')
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(samples[1]!.input, 80, '第二轮只算差值')
  assert.equal(samples[1]!.output, 20)
  assert.equal(samples[1]!.ok, false)
})

test('指标：出站计数（成功/失败）', () => {
  const service = new MetricsService({
    enabled: () => true, now: () => 0, usage: () => undefined,
    store: { add: () => {}, flush: async () => {} } as never, log: () => {},
  })
  service.sendOk()
  service.sendOk()
  service.sendFailed()
  assert.deepEqual(service.counters(), { sends: 2, sendFailures: 1 })
})

test('指标仓库：超过上限丢最旧，写盘后可读回', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'metrics-'))
  try {
    const file = path.join(dir, 'metrics.json')
    const store = new MetricsStore(file, () => {})
    await store.load()
    for (let index = 0; index < MAX_METRIC_SAMPLES + 2; index += 1) store.add(sample({ at: index }))
    assert.equal(store.list().length, MAX_METRIC_SAMPLES)
    assert.equal(store.list()[0]!.at, 2)
    await store.flush()
    const again = new MetricsStore(file, () => {})
    await again.load()
    assert.equal(again.list().length, MAX_METRIC_SAMPLES)
    assert.equal(again.list().at(-1)!.at, MAX_METRIC_SAMPLES + 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
