/** `qq_memory_search`（深召回工具）的接线测试。
 *
 * 这个工具不实现检索本身——它只是深召回面的**薄壳**：把 query/limit 交给
 * `deps.memorySearch`（`memory.v2` 装配时提供），把命中映射成"内容 + 出处 + 日期"。
 * 所以这里钉住两件事：
 *   1. 没有深召回面（v2 关着）时给出可读的拒绝理由，而不是抛异常；
 *   2. 有面时参数怎么传、结果怎么映射（出处里的 `#L行号` 不能丢）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { memoryTools } = await import('../src/features/memory/tools.js')

/** 只取深召回那一个 spec；其余依赖这些测试用不到，给空对象即可。 */
function searchSpec(search: unknown) {
  const specs = memoryTools({ memorySearch: search } as never)
  const spec = specs.find((s) => s.name === 'qq_memory_search')
  assert.ok(spec, 'qq_memory_search 应当在记忆工具组里')
  return spec!
}

test('qq_memory_search：v2 关着（没有深召回面）→ 返回可读的 note，不抛异常', async () => {
  const got = await searchSpec(undefined).run({ query: '上次部署怎么弄的' }) as Record<string, unknown>
  assert.match(String(got.note), /未启用/)
})

test('qq_memory_search：参数原样交给深召回面，结果映射成 内容/出处/日期/是否原文块', async () => {
  const calls: Array<[string, number]> = []
  const spec = searchSpec(async (query: string, limit: number) => {
    calls.push([query, limit])
    return [
      { content: '部署时先停 dsh', kind: 'fact', source: 'memory/2026-10-12.md#L18', date: '2026-10-12', chunk: true },
      { content: '学弟偏好深夜部署', kind: 'preference', source: 'qq-dm-1000000002', date: '2026-10-10', chunk: false },
    ]
  })
  const got = await spec.run({ query: '部署', limit: 6 }) as { count: number; results: Array<Record<string, unknown>> }
  assert.deepEqual(calls, [['部署', 6]])
  assert.equal(got.count, 2)
  assert.deepEqual(got.results[0], {
    content: '部署时先停 dsh', source: 'memory/2026-10-12.md#L18', date: '2026-10-12', chunk: true,
  })
  assert.equal(got.results[1]!.chunk, false)
})

test('qq_memory_search：不给 limit 时默认要 8 条（工具契约里的默认值）', async () => {
  let seen = -1
  const spec = searchSpec(async (_q: string, limit: number) => { seen = limit; return [] })
  await spec.run({ query: '随便问问' })
  assert.equal(seen, 8)
})
