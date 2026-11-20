/** 打分器客户端：**假进程**测协议、超时、崩溃与重启上限。
 *
 * 为什么用假 `spawn` 而不是真起 `jev-score`：真起要显卡、要 495 MB 权重、要 0.9 秒启动，
 * 而这条测试要验证的是"回复形状不对时会不会把 NaN 传下去"这类**协议层**的事。
 * 真假分开之后，真打的证据在 `docs/groups/p10-jev-judge.md` 的实测表里，
 * 这里的证据是"任何一条坏回复都不会被当成好结果"。
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { PassThrough } from 'node:stream'
import { createScorerClient } from '../src/adapters/jev/scorer-client.js'
import { argsOf, resultsOf, totalMsOf, type ScorerOptions } from '../src/adapters/jev/scorer-protocol.js'
import { MAX_SPAWN_FAILURES, createLineQueue } from '../src/adapters/jev/scorer-process.js'
import type { Clock, TimerHandle } from '../src/ports/clock.js'

/** 只推进"被要求推进"的假时钟：超时用真 `setTimeout` 会拖慢整组测试。 */
function fakeClock(): Clock & { flush: () => void; pending: () => number } {
  const timers: Array<{ fn: () => void; cancelled: boolean }> = []
  return {
    now: () => Date.now(),
    date: () => new Date(),
    setTimeout(fn): TimerHandle {
      const entry = { fn, cancelled: false }
      timers.push(entry)
      return { cancel: () => { entry.cancelled = true } }
    },
    setInterval(fn): TimerHandle {
      const entry = { fn, cancelled: false }
      timers.push(entry)
      return { cancel: () => { entry.cancelled = true } }
    },
    flush(): void {
      for (const entry of timers.splice(0)) if (!entry.cancelled) entry.fn()
    },
    pending: () => timers.filter((entry) => !entry.cancelled).length,
  }
}

/** 假子进程：stdin 收到的行进 `received`，`reply()` 往 stdout 推一行。 */
class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly stdin = new PassThrough()
  readonly received: string[] = []
  killed = false

  constructor() {
    super()
    this.stdin.on('data', (chunk: Buffer | string) => {
      for (const line of chunk.toString().split('\n')) if (line.trim() !== '') this.received.push(line)
    })
  }

  reply(line: string): void {
    this.stdout.write(`${line}\n`)
  }

  kill(): boolean {
    this.killed = true
    this.emit('exit', null)
    return true
  }
}

/** 把假子进程塞进 `spawn` 的位置（形状对得上 Node 的 `ChildProcessWithoutNullStreams`）。 */
function fakeSpawn(children: FakeChild[]): (args: readonly string[]) => never {
  return (args: readonly string[]) => {
    void args
    const child = new FakeChild()
    children.push(child)
    return child as never
  }
}

const OPTIONS: ScorerOptions = {
  binaryPath: 'jev-score.exe',
  modelPath: 'J.gguf',
  contextSize: 2048,
  ubatch: 256,
  seqMax: 4,
  outputsMax: 64,
  nGpuLayers: 99,
  threads: 6,
}

/**
 * 真实的 `ready` 行形状（照 `jev_score.cpp:343` 抄）。
 *
 * **没有 `gpu_offload`**：那个字段是上游 Python 包装器自己算的，`ready` 行里从来没有。
 * `system_info` 也**不能**用来判断走没走 GPU——本机实测它只列 CPU 特性
 * （`CPU : SSE3 = 1 | AVX2 = 1 | …`），哪怕层已全卸载到 Vulkan。
 * 所以这里只断言"原文被保留"，不推断后端。
 */
const READY = '{"ready":true,"desc":"Jev-Style-0.8B-D3","n_ctx":2048,"n_seq_max":4,"n_ubatch":256,"load_ms":880,"system_info":"CPU : SSE3 = 1 | AVX2 = 1 | "}'

const QUESTION = { ids: [1, 2, 3, 4], slots: [3], rows: [9542, 874] }

test('启动参数：全量卸载 + 指定 ctx/ubatch/seq（顺序与打分器一致）', () => {
  const args = argsOf(OPTIONS)
  assert.deepEqual(args, [
    '--model', 'J.gguf', '--n-ctx', '2048', '--n-ubatch', '256', '--ngl', '99',
    '--threads', '6', '--n-seq-max', '4', '--n-outputs-max', '64',
  ])
})

test('一次成功的打分：ready → 请求 → 回复（logit 原样返回、耗时取自 timing）', async () => {
  const children: FakeChild[] = []
  const clock = fakeClock()
  const client = createScorerClient(OPTIONS, fakeSpawn(children))
  const promise = client.score({ prefix: [1, 2], questions: [QUESTION], timeoutMs: 3_000, clock })
  const child = children[0]
  assert.ok(child !== undefined)
  child.reply(READY)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(child.received.length, 1)
  const sent = JSON.parse(child.received[0] ?? '{}') as Record<string, unknown>
  assert.deepEqual(sent['prefix'], [1, 2])
  assert.equal(sent['share_prefix'], true, 'prefix 必须复用，否则每次都要重新解码状态')
  assert.equal(sent['keep_prefix'], true)
  child.reply('{"results":[{"scores":[[1.5,-0.5]]}],"timing":{"total_ms":12.5},"prefix_reused":true}')
  const outcome = await promise
  assert.equal(outcome.kind, 'scores')
  if (outcome.kind !== 'scores') return
  assert.deepEqual(outcome.results, [[[1.5, -0.5]]])
  assert.equal(outcome.totalMs, 12.5)
  // 就绪信息要能被读到（后台诊断用）。`system_info` 原文保留，**不**据此推断 GPU 后端。
  assert.equal(client.info()?.loadMs, 880)
  assert.equal(client.info()?.desc, 'Jev-Style-0.8B-D3')
  assert.equal(client.info()?.systemInfo, 'CPU : SSE3 = 1 | AVX2 = 1 | ')
})

test('启动超时（没等到 ready）→ no-route，且不无限重试', async () => {
  const children: FakeChild[] = []
  const clock = fakeClock()
  const client = createScorerClient(OPTIONS, fakeSpawn(children))
  const promise = client.score({ prefix: [1], questions: [QUESTION], timeoutMs: 500, clock })
  await new Promise((resolve) => setImmediate(resolve))
  clock.flush() // 推进超时
  const outcome = await promise
  assert.equal(outcome.kind, 'no-route')
  if (outcome.kind !== 'no-route') return
  assert.match(outcome.detail, /启动超时/)
  // 第二次调用：因为 `broken` 还在（用一次就清），所以立刻失败而不是再 spawn。
  const second = await client.score({ prefix: [1], questions: [QUESTION], timeoutMs: 500, clock })
  assert.equal(second.kind, 'no-route')
  assert.equal(children.length, 1, '第二次不该再 spawn')
})

test('spawn 连续失败到上限后不再试（最多 1 + MAX_SPAWN_FAILURES 次）', async () => {
  let spawned = 0
  const clock = fakeClock()
  const client = createScorerClient(OPTIONS, () => {
    spawned += 1
    throw new Error('ENOENT: jev-score 不存在')
  })
  for (let index = 0; index <= MAX_SPAWN_FAILURES + 1; index++) {
    const outcome = await client.score({ prefix: [1], questions: [QUESTION], timeoutMs: 500, clock })
    assert.equal(outcome.kind, 'no-route')
  }
  assert.ok(spawned <= MAX_SPAWN_FAILURES + 1, `spawn 次数失控：${String(spawned)}`)
})

test('回复里有 error → failed（不当作结果）', async () => {
  const children: FakeChild[] = []
  const clock = fakeClock()
  const client = createScorerClient(OPTIONS, fakeSpawn(children))
  const promise = client.score({ prefix: [1], questions: [QUESTION], timeoutMs: 3_000, clock })
  await new Promise((resolve) => setImmediate(resolve))
  children[0]?.reply(READY)
  await new Promise((resolve) => setImmediate(resolve))
  children[0]?.reply('{"error":"model load failed"}')
  const outcome = await promise
  assert.equal(outcome.kind, 'failed')
  if (outcome.kind !== 'failed') return
  assert.match(outcome.detail, /model load failed/)
})

test('回复不是 JSON → failed，且进程被回收（不留半死的打分器）', async () => {
  const children: FakeChild[] = []
  const clock = fakeClock()
  const client = createScorerClient(OPTIONS, fakeSpawn(children))
  const promise = client.score({ prefix: [1], questions: [QUESTION], timeoutMs: 3_000, clock })
  await new Promise((resolve) => setImmediate(resolve))
  children[0]?.reply(READY)
  await new Promise((resolve) => setImmediate(resolve))
  children[0]?.reply('这不是 JSON')
  const outcome = await promise
  assert.equal(outcome.kind, 'failed')
  assert.equal(children[0]?.killed, true, '坏回复之后进程应当被回收')
})

test('打分超时 → timeout，且进程被回收', async () => {
  const children: FakeChild[] = []
  const clock = fakeClock()
  const client = createScorerClient(OPTIONS, fakeSpawn(children))
  const promise = client.score({ prefix: [1], questions: [QUESTION], timeoutMs: 500, clock })
  await new Promise((resolve) => setImmediate(resolve))
  children[0]?.reply(READY)
  await new Promise((resolve) => setImmediate(resolve))
  clock.flush()
  const outcome = await promise
  assert.equal(outcome.kind, 'timeout')
  assert.equal(children[0]?.killed, true)
})

test('results 形状：NaN / 缺字段 / 非数组一律判失败（不能把 NaN 传下去）', () => {
  assert.equal(resultsOf(undefined).ok, false)
  assert.equal(resultsOf({}).ok, false)
  assert.equal(resultsOf([{ scores: 'nope' }]).ok, false)
  assert.equal(resultsOf([{ scores: [[1, 'x']] }]).ok, false)
  // 单个槽位只有一个数也认（`noul` 的两行由渲染器给，但结果里少一行不该让它蒙对）。
  const good = resultsOf([{ scores: [[1, -1], [0.5, -0.5]] }])
  assert.equal(good.ok, true)
  if (!good.ok) return
  assert.deepEqual(good.results, [[[1, -1], [0.5, -0.5]]])
  // `Infinity` 也算非有限数（JSON 里没有 Infinity，但 `1e999` 会变成 null，这里拦住）
  assert.equal(resultsOf([{ scores: [[Number.POSITIVE_INFINITY]] }]).ok, false)
})

test('totalMs：没有 timing 时用实测耗时兜底', () => {
  assert.equal(totalMsOf({}, 42), 42)
  assert.equal(totalMsOf({ timing: { total_ms: 7 } }, 42), 7)
  assert.equal(totalMsOf({ timing: { total_ms: 'x' } }, 42), 42)
})

test('行队列：先到的行排队，后到的等待者按 FIFO 拿；超时返回 null', async () => {
  const clock = fakeClock()
  const queue = createLineQueue()
  queue.push('a')
  queue.push('b')
  assert.equal(await queue.next(100, clock), 'a')
  assert.equal(await queue.next(100, clock), 'b')
  const pending = queue.next(100, clock)
  clock.flush()
  assert.equal(await pending, null)
  // 进程退出：所有等待者放空。
  const waiting = queue.next(100, clock)
  queue.drain()
  assert.equal(await waiting, null)
})

test('`close()` 幂等且不抛（没起过进程时直接返回）', async () => {
  const client = createScorerClient(OPTIONS, fakeSpawn([]))
  await client.close()
  await client.close()
  assert.equal(client.info(), null)
})
