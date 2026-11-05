/** P6f 事件书的行为测试：时间判定、书校验、target 解析、执行器（幂等/跳过/落盘）。
 *
 * 六条不能少的性质：
 *   1. **时间判定是纯函数**：同一份输入永远同一个结论（jitter 是 hash 不是随机）；
 *   2. **一桶只跑一次、跨重启也算**（先写状态再执行，B1/B2 的教训落在这里）；
 *   3. **跳过不消耗这一轮**：安静时段/条件不满足只记原因，出了门立刻能跑
 *      （夜里安静一下不能把整晚的机会吃掉）；
 *   4. **书是数据**：字段写错必须报出来（"配了却没生效"是 B 系列的原病）；
 *   5. **默认书复现今天的四种主动行为**（时段、静默窗口、素材顺序逐条对齐）；
 *   6. **开关关着时旧调度器一字不改**（这一条由既有 golden 与 verify 钉住，
 *      本文件只测事件书这一侧的语义）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import type { QQChannelConfig } from '../src/config.js'
import type { ConversationRegistry } from '../src/app/conversation/registry.js'
import type { PromptComposer } from '../src/app/conversation/prompt-composer.js'
import type { TurnLauncher } from '../src/app/conversation/turns.js'
import type { Clock, TimerHandle } from '../src/ports/clock.js'

const {
  decideDue, inQuietHours, inWindow, intervalKey, jitterOffsetMs, minutesOf,
  nextRunAt, parseHhMm,
} = await import('../src/core/schedule/due.js')
const { defaultEventBook, parseEventBook } = await import('../src/core/schedule/event-book.js')
const { resolveTarget } = await import('../src/core/schedule/targets.js')
const { ProactiveExecutor } = await import('../src/features/proactive/executor.js')

// ── 时间判定（纯函数） ──────────────────────────────────────────────────────

test('parseHhMm：只认 HH:MM（00:00–23:59）', () => {
  assert.equal(parseHhMm('00:00'), 0)
  assert.equal(parseHhMm('07:30'), 7 * 60 + 30)
  assert.equal(parseHhMm('23:59'), 23 * 60 + 59)
  assert.equal(parseHhMm('24:00'), null)
  assert.equal(parseHhMm('7:30'), null)
  assert.equal(parseHhMm('07:60'), null)
  assert.equal(parseHhMm(''), null)
})

test('inQuietHours：半开区间 [from, to)，支持跨午夜', () => {
  const at = (h: number, m = 0): Date => new Date(2026, 9, 17, h, m)
  assert.equal(inQuietHours([{ from: '01:00', to: '07:30' }], at(0, 59)), false)
  assert.equal(inQuietHours([{ from: '01:00', to: '07:30' }], at(1, 0)), true)
  assert.equal(inQuietHours([{ from: '01:00', to: '07:30' }], at(7, 29)), true)
  // to 是开区间：07:30 整已经"出了"安静时段（旧实现的 h < 7.5 就是这一条）。
  assert.equal(inQuietHours([{ from: '01:00', to: '07:30' }], at(7, 30)), false)
  // 跨午夜 23:00 → 07:00
  assert.equal(inQuietHours([{ from: '23:00', to: '07:00' }], at(23, 30)), true)
  assert.equal(inQuietHours([{ from: '23:00', to: '07:00' }], at(3, 0)), true)
  assert.equal(inQuietHours([{ from: '23:00', to: '07:00' }], at(12, 0)), false)
  assert.equal(inQuietHours([], at(3, 0)), false)
})

test('inWindow：闭区间 [from, to]，分钟粒度', () => {
  const at = (h: number, m = 0): Date => new Date(2026, 9, 17, h, m)
  assert.equal(inWindow('06:00', '11:59', at(5, 59)), false)
  assert.equal(inWindow('06:00', '11:59', at(6, 0)), true)
  assert.equal(inWindow('06:00', '11:59', at(11, 59)), true)
  assert.equal(inWindow('06:00', '11:59', at(12, 0)), false)
  assert.equal(inWindow('06:00', '11:59', new Date(2026, 9, 17, 11, 59, 59)), true, '闭区间覆盖到 11:59:59')
  assert.equal(inWindow('12:00', '06:00', at(8, 0)), false, 'from > to 的窗口不支持（校验期已拒）')
})

test('jitterOffsetMs：同一个 id+桶永远同一个偏移（hash，不是随机）', () => {
  const a = jitterOffsetMs('patrol', 100, 1)
  const b = jitterOffsetMs('patrol', 100, 1)
  assert.equal(a, b, '两次调用必须相同——重启不该改变判定')
  assert.ok(a >= 0 && a < 60_000)
  assert.equal(jitterOffsetMs('patrol', 100, 0), 0)
  assert.equal(jitterOffsetMs('patrol', 100, 1.5) < 90_000, true)
  // 不同事件在同一桶里的偏移通常不同（否则"抖动"就没意义了）
  assert.notEqual(jitterOffsetMs('patrol', 100, 3), jitterOffsetMs('dream', 100, 3))
})

test('decideDue（interval）：一桶一次；jitter 未到先 wait', () => {
  const trigger = { type: 'interval', everyMin: 9, jitterMin: 1, runOnBoot: false } as const
  const now = new Date(2026, 9, 17, 12, 0, 0)
  const key = intervalKey('patrol', 9, now.getTime())
  const offset = jitterOffsetMs('patrol', Math.floor(now.getTime() / (9 * 60_000)), 1)
  const bucketStart = Math.floor(now.getTime() / (9 * 60_000)) * (9 * 60_000)
  const dueAt = new Date(bucketStart + offset)

  // 抖动还没到：wait（不是 due）
  if (dueAt.getTime() > now.getTime()) {
    assert.equal(decideDue('patrol', trigger, null, now).kind, 'wait')
  }
  const later = new Date(bucketStart + offset)
  assert.equal(decideDue('patrol', trigger, null, later).kind, 'due')
  assert.equal(decideDue('patrol', trigger, key, later).kind, 'consumed')
  // 下一个桶：jitter 是**按桶**算的，下一次的到点时刻要用下一桶的偏移
  const nextBucket = Math.floor(now.getTime() / (9 * 60_000)) + 1
  const next = new Date(nextBucket * 9 * 60_000 + jitterOffsetMs('patrol', nextBucket, 1) + 1)
  assert.equal(decideDue('patrol', trigger, key, next).kind, 'due')
})

test('decideDue（window）：一天一次；窗口外是 outside 而不是 consumed', () => {
  const trigger = { type: 'window', from: '06:00', to: '11:59' } as const
  const morning = new Date(2026, 9, 17, 8, 0, 0)
  assert.equal(decideDue('morning-report', trigger, null, morning).kind, 'due')
  assert.equal(decideDue('morning-report', trigger, 'morning-report:2026-10-17', morning).kind, 'consumed')
  const night = new Date(2026, 9, 17, 23, 0, 0)
  assert.equal(decideDue('morning-report', trigger, null, night).kind, 'outside')
})

test('nextRunAt：面板的"下次判定"（interval 下一桶 / window 明天）', () => {
  const now = new Date(2026, 9, 17, 23, 0, 0)
  const next = nextRunAt('patrol', { type: 'interval', everyMin: 9, jitterMin: 0, runOnBoot: false }, 'patrol:x', now)
  // 当前桶还没跑过且已过到点时刻 → "下次"就是现在（这是"等一分钟后你就能跑"的诚实说法）
  assert.ok(next >= now.getTime())
  const tomorrow = nextRunAt('morning-report', { type: 'window', from: '06:00', to: '11:59' }, 'morning-report:2026-10-17', now)
  const t = new Date(tomorrow)
  assert.equal(t.getHours(), 6)
  assert.equal(t.getDate(), 18)
})

test('minutesOf：本地日的分钟数', () => {
  assert.equal(minutesOf(new Date(2026, 9, 17, 0, 0)), 0)
  assert.equal(minutesOf(new Date(2026, 9, 17, 13, 45)), 13 * 60 + 45)
})

// ── 事件书（数据面） ────────────────────────────────────────────────────────

test('内置默认书：合法、id 唯一、三种 kind 都有', () => {
  const parsed = parseEventBook(defaultEventBook())
  assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.problems.join('\n'))
  if (!parsed.ok) return
  const ids = parsed.book.events.map((e) => e.id)
  assert.equal(new Set(ids).size, ids.length, 'id 必须唯一')
  const kinds = new Set(parsed.book.events.map((e) => e.kind))
  assert.deepEqual([...kinds].sort(), ['job', 'prompt', 'script'])
})

test('内置默认书复现今天的主动行为（时段/静默/素材顺序逐条对齐）', () => {
  const parsed = parseEventBook(defaultEventBook())
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  const byId = new Map(parsed.book.events.map((e) => [e.id, e]))

  const patrol = byId.get('patrol')
  assert.equal(patrol?.trigger.type, 'interval')
  assert.deepEqual(patrol?.quietHours, [{ from: '01:00', to: '07:30' }])
  assert.equal(patrol?.target, 'primary-group')

  const morning = byId.get('morning-report')
  assert.deepEqual(morning?.trigger, { type: 'window', from: '06:00', to: '11:59' })
  assert.equal(morning?.target, 'master-dm')
  // 素材顺序必须与旧实现的拼接顺序一致（日期 → 课表 → 天气 → 昨天活跃）
  assert.deepEqual(morning?.materials, ['date', 'schedule', 'weather', 'yesterday-activity'])

  const dream = byId.get('dream')
  assert.deepEqual(dream?.trigger, { type: 'window', from: '04:00', to: '04:59' })

  const evolve = byId.get('evolve')
  assert.equal(evolve?.trigger.type === 'interval' ? evolve.trigger.everyMin : null, 360)

  const dmVisit = byId.get('dm-visit')
  assert.deepEqual(dmVisit?.quietHours, [{ from: '01:00', to: '08:00' }])
  assert.equal(dmVisit?.trigger.type === 'interval' ? dmVisit.trigger.everyMin : null, 22)

  const knowledge = byId.get('knowledge-extract')
  assert.equal(knowledge?.kind, 'job')
  assert.equal(knowledge?.job, 'knowledge.extract')
  assert.deepEqual(knowledge?.trigger, { type: 'window', from: '04:00', to: '08:59' })
})

test('书校验：未知字段、重复 id、坏 trigger 一次报全', () => {
  const bad = {
    version: 1,
    events: [
      { id: 'a', kind: 'prompt', target: 'primary-group', template: 'x', trigger: { type: 'interval', everyMin: 5, intervall: 3 } },
      { id: 'a', kind: 'prompt', target: 'primary-group', template: 'x', trigger: { type: 'interval', everyMin: 5 } },
      { id: 'b', kind: 'prompt', target: 'nope', template: '', trigger: { type: 'interval', everyMin: 0 } },
    ],
  }
  const parsed = parseEventBook(bad)
  assert.equal(parsed.ok, false)
  if (parsed.ok) return
  const text = parsed.problems.join('\n')
  assert.match(text, /不认识的字段「intervall」/)
  assert.match(text, /与前面重复/)
  assert.match(text, /everyMin/)
  assert.match(text, /target/)
  assert.match(text, /template/)
})

test('书校验：kind 与字段互斥、window 不支持跨午夜、version 必须是 1', () => {
  const cases: unknown[] = [
    { version: 2, events: [] },
    { version: 1, events: 'nope' },
    { version: 1, events: [{ id: 'j', kind: 'job', trigger: { type: 'interval', everyMin: 5 }, target: 'primary-group' }] },
    { version: 1, events: [{ id: 'j', kind: 'job', trigger: { type: 'interval', everyMin: 5 } }] },
    { version: 1, events: [{ id: 'w', kind: 'job', job: 'x', trigger: { type: 'window', from: '22:00', to: '06:00' } }] },
    { version: 1, events: [{ id: 's', kind: 'script', trigger: { type: 'interval', everyMin: 5 }, script: { argv: ['node', 'a b'], timeoutSec: 5 } }] },
  ]
  for (const book of cases) {
    const parsed = parseEventBook(book)
    assert.equal(parsed.ok, false, `这本该被拒：${JSON.stringify(book).slice(0, 80)}`)
  }
})

// ── target 解析 ─────────────────────────────────────────────────────────────

test('resolveTarget：四种写法与两种"没配"', () => {
  const dir = { primaryGroup: 1000000003, masterId: 10001 }
  assert.deepEqual(resolveTarget('primary-group', dir), { ok: true, room: 'group-1000000003' })
  assert.deepEqual(resolveTarget('master-dm', dir), { ok: true, room: 'dm-10001' })
  assert.deepEqual(resolveTarget('group:9', dir), { ok: true, room: 'group-9' })
  assert.deepEqual(resolveTarget('dm:42', dir), { ok: true, room: 'dm-42' })
  assert.equal(resolveTarget('primary-group', { primaryGroup: null, masterId: 1 }).ok, false)
  assert.equal(resolveTarget('master-dm', { primaryGroup: 1, masterId: null }).ok, false)
  assert.equal(resolveTarget('group:', dir).ok, false)
})

// ── 执行器 ──────────────────────────────────────────────────────────────────

interface FakeClock extends Clock {
  advance(ms: number): void
  fire(): void
}

function makeClock(start: Date): FakeClock {
  let at = start.getTime()
  return {
    now: () => at,
    date: () => new Date(at),
    setTimeout: (): TimerHandle => ({ cancel: () => {} }),
    setInterval: (): TimerHandle => ({ cancel: () => {} }),
    advance: (ms: number) => { at += ms },
    fire: () => {},
  }
}

interface FakeRegistry {
  get(key: string): unknown
  set(key: string, running: boolean): void
}

function makeRegistry(entries: Array<[string, boolean]> = []): FakeRegistry {
  const records = new Map<string, { running: boolean }>()
  for (const [key, running] of entries) records.set(key, { running })
  return {
    get: (key: string) => {
      const entry = records.get(key)
      if (entry === undefined) return undefined
      return { tracker: { running: () => entry.running } }
    },
    set: (key: string, running: boolean) => {
      const entry = records.get(key)
      if (entry === undefined) records.set(key, { running })
      else entry.running = running
    },
  }
}

interface Harness {
  executor: InstanceType<typeof ProactiveExecutor>
  rooms: string[]
  prompts: string[]
  logs: string[]
  clock: FakeClock
  dir: string
  cleanup(): void
}

function makeHarness(book: unknown, opts: {
  now?: Date
  registry?: FakeRegistry
  workspace?: string | null
  primaryGroup?: number | null
  master?: number | null
  dir?: string
} = {}): Harness {
  const dir = opts.dir ?? mkdtempSync(path.join(tmpdir(), 'qq-events-'))
  const clock = makeClock(opts.now ?? new Date(2026, 9, 17, 12, 0, 0))
  const registry = opts.registry ?? makeRegistry()
  const rooms: string[] = []
  const prompts: string[] = []
  const logs: string[] = []
  const config = {
    primaryGroup: opts.primaryGroup === undefined ? 999 : opts.primaryGroup,
    admins: opts.master === undefined ? [10001] : (opts.master === null ? [] : [opts.master]),
    workspacePath: opts.workspace === undefined ? null : opts.workspace,
    morningReport: { enabled: true, scheduleFile: null, weatherLocation: null },
  } as unknown as QQChannelConfig
  const turns = {
    bookPrompt: async (room: string, prompt: string) => { rooms.push(room); prompts.push(prompt); return true },
  } as unknown as TurnLauncher
  const prompts_ = {
    render: (key: string, vars: Record<string, string> = {}) => `${key}|${vars.flavor ?? ''}|${vars.material ?? ''}|${vars.master ?? ''}`,
  } as unknown as PromptComposer
  const executor = new ProactiveExecutor({
    turns,
    registry: registry as unknown as ConversationRegistry,
    prompts: prompts_,
    config: () => config,
    book: () => book as never,
    log: (line: string) => { logs.push(line) },
    dshHome: dir,
    clock,
  })
  return {
    executor, rooms, prompts, logs, clock, dir,
    cleanup: () => { rmSync(dir, { recursive: true, force: true }) },
  }
}

/** 一本只含被测事件的单事件书。 */
function bookOf(event: Record<string, unknown>): unknown {
  return { version: 1, events: [event] }
}

const PROMPT_EVENT = {
  id: 'ping', enabled: true, kind: 'prompt',
  trigger: { type: 'interval', everyMin: 30, jitterMin: 0, runOnBoot: false },
  quietHours: [], target: 'primary-group', template: 'proactive/patrol',
  materials: [], requires: [],
}

test('执行器：到点跑一条 prompt 事件，房间与渲染变量都对', async () => {
  const h = makeHarness(bookOf(PROMPT_EVENT))
  try {
    await h.executor.tick(h.clock.date())
    assert.deepEqual(h.rooms, ['group-999'])
    assert.match(h.prompts[0] ?? '', /^proactive\/patrol\|/)
    assert.ok(h.logs.some((l) => l.includes('events: ping ran')), h.logs.join('\n'))
  } finally { h.cleanup() }
})

test('执行器：同一个桶不重跑（幂等键落盘之后才算数）', async () => {
  const h = makeHarness(bookOf(PROMPT_EVENT))
  try {
    await h.executor.tick(h.clock.date())
    h.clock.advance(60_000)
    await h.executor.tick(h.clock.date())
    assert.equal(h.rooms.length, 1, '同一桶内第二次 tick 不该再发')
    // 进到下一桶（30 分钟）就能再跑一次
    h.clock.advance(30 * 60_000)
    await h.executor.tick(h.clock.date())
    assert.equal(h.rooms.length, 2)
  } finally { h.cleanup() }
})

test('执行器：状态跨实例（重启）仍然记得做过', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'qq-events-'))
  try {
    const first = makeHarness(bookOf(PROMPT_EVENT), { dir })
    await first.executor.tick(first.clock.date())
    assert.equal(first.rooms.length, 1)
    const second = makeHarness(bookOf(PROMPT_EVENT), { dir })
    await second.executor.tick(second.clock.date())
    assert.equal(second.rooms.length, 0, '同一个桶在重启后不该重发')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('执行器：安静时段只跳过、不消耗这一轮（出了门立刻能跑）', async () => {
  const event = { ...PROMPT_EVENT, quietHours: [{ from: '01:00', to: '07:30' }] }
  const h = makeHarness(bookOf(event), { now: new Date(2026, 9, 17, 3, 0, 0) })
  try {
    await h.executor.tick(h.clock.date())
    assert.equal(h.rooms.length, 0)
    assert.ok(h.logs.some((l) => l.includes('skipped: quiet-hours')), h.logs.join('\n'))
    // 出了安静时段，同一个桶（30 分钟）里马上就跑——跳过没有吃掉这一桶
    const at730 = new Date(2026, 9, 17, 7, 31, 0)
    await h.executor.tick(at730)
    assert.equal(h.rooms.length, 1)
  } finally { h.cleanup() }
})

test('执行器：requires 不满足就不跑；满足后同一轮里补上', async () => {
  const event = { ...PROMPT_EVENT, requires: ['room-has-session', 'turn-idle'] }
  const registry = makeRegistry()
  const h = makeHarness(bookOf(event), { registry })
  try {
    await h.executor.tick(h.clock.date())
    assert.equal(h.rooms.length, 0, '没有会话时 room-has-session 不满足')
    assert.ok(h.logs.some((l) => l.includes('skipped: requires:room-has-session')))

    registry.set('group-999', true) // 有会话但正忙
    await h.executor.tick(h.clock.date())
    assert.equal(h.rooms.length, 0)
    assert.ok(h.logs.some((l) => l.includes('skipped: requires:turn-idle')))

    registry.set('group-999', false) // 空闲了
    await h.executor.tick(h.clock.date())
    assert.equal(h.rooms.length, 1)
  } finally { h.cleanup() }
})

test('执行器：target 解析不出来时具名跳过（不是安静地什么都不做）', async () => {
  const event = { ...PROMPT_EVENT, target: 'master-dm' }
  const h = makeHarness(bookOf(event), { master: null })
  try {
    await h.executor.tick(h.clock.date())
    assert.equal(h.rooms.length, 0)
    assert.ok(h.logs.some((l) => l.includes('skipped: target:没配置主人')), h.logs.join('\n'))
  } finally { h.cleanup() }
})

test('执行器：job 未注册 = failed:unknown-job（不影响别的事件）', async () => {
  const book = { version: 1, events: [
    { id: 'ghost', enabled: true, kind: 'job', trigger: { type: 'interval', everyMin: 30, jitterMin: 0, runOnBoot: false }, quietHours: [], job: 'nobody.here' },
    PROMPT_EVENT,
  ] }
  const h = makeHarness(book)
  try {
    await h.executor.tick(h.clock.date())
    assert.ok(h.logs.some((l) => l.includes('events: ghost failed:unknown-job:nobody.here')), h.logs.join('\n'))
    assert.equal(h.rooms.length, 1, '后面那条照跑')
  } finally { h.cleanup() }
})

test('执行器：job 注册后跑，跳过的原因进状态', async () => {
  const { registerJob } = await import('../src/features/proactive/jobs.js')
  const unregister = registerJob('test.echo', () => ({ note: 'ok' }))
  const unregisterSkip = registerJob('test.skip', () => ({ skipped: 'nothing-to-do' }))
  const book = { version: 1, events: [
    { id: 'echo', enabled: true, kind: 'job', trigger: { type: 'interval', everyMin: 30, jitterMin: 0, runOnBoot: false }, quietHours: [], job: 'test.echo' },
    { id: 'skipme', enabled: true, kind: 'job', trigger: { type: 'interval', everyMin: 30, jitterMin: 0, runOnBoot: false }, quietHours: [], job: 'test.skip' },
  ] }
  const h = makeHarness(book)
  try {
    await h.executor.tick(h.clock.date())
    assert.ok(h.logs.some((l) => l.includes('events: echo note: ok')))
    assert.ok(h.logs.some((l) => l.includes('events: skipme skipped:nothing-to-do')))
    unregister()
    unregisterSkip()
  } finally { h.cleanup() }
})

test('执行器：script 事件真跑一次（workspace/scripts 之内、无 shell）', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'qq-ws-'))
  try {
    mkdirSync(path.join(workspace, 'scripts'), { recursive: true })
    writeFileSync(path.join(workspace, 'scripts', 'hello.mjs'), 'console.log("hi from script")\n', 'utf-8')
    const event = {
      id: 'beat', enabled: true, kind: 'script',
      trigger: { type: 'interval', everyMin: 30, jitterMin: 0, runOnBoot: false },
      quietHours: [], script: { argv: ['node', 'scripts/hello.mjs'], timeoutSec: 30 },
    }
    const h = makeHarness(bookOf(event), { workspace })
    try {
      await h.executor.tick(h.clock.date())
      assert.ok(h.logs.some((l) => l.includes('events: beat ran')), h.logs.join('\n'))
      assert.ok(h.logs.some((l) => l.includes('hi from script')))
    } finally { h.cleanup() }
  } finally { rmSync(workspace, { recursive: true, force: true }) }
})

test('执行器：脚本越界 = failed（拒绝文案进状态）', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'qq-ws-'))
  try {
    const event = {
      id: 'escape', enabled: true, kind: 'script',
      trigger: { type: 'interval', everyMin: 30, jitterMin: 0, runOnBoot: false },
      quietHours: [], script: { argv: ['node', '../outside.mjs'], timeoutSec: 5 },
    }
    const h = makeHarness(bookOf(event), { workspace })
    try {
      await h.executor.tick(h.clock.date())
      assert.ok(h.logs.some((l) => l.includes('events: escape failed:')), h.logs.join('\n'))
    } finally { h.cleanup() }
  } finally { rmSync(workspace, { recursive: true, force: true }) }
})

test('执行器：runOnBoot=false 在启动时吞掉当前桶；true 会补跑', async () => {
  const quiet = makeHarness(bookOf(PROMPT_EVENT))
  try {
    quiet.executor.start()
    await new Promise((r) => setImmediate(r)) // start 里的 tick 是 fire-and-forget
    assert.equal(quiet.rooms.length, 0, 'runOnBoot=false：启动那一刻不该补跑')
    assert.ok(quiet.logs.some((l) => l.includes('boot-seeded')), quiet.logs.join('\n'))
  } finally { quiet.cleanup() }

  const boot = makeHarness(bookOf({ ...PROMPT_EVENT, trigger: { type: 'interval', everyMin: 30, jitterMin: 0, runOnBoot: true } }))
  try {
    boot.executor.start()
    await new Promise((r) => setImmediate(r))
    assert.equal(boot.rooms.length, 1, 'runOnBoot=true：启动补跑当前桶')
  } finally { boot.cleanup() }
})

test('执行器：第一次跑时接住旧调度器的"今天做过了"（不再多发一份早报）', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'qq-events-'))
  try {
    mkdirSync(path.join(dir, 'channel-qq'), { recursive: true })
    writeFileSync(
      path.join(dir, 'channel-qq', 'scheduler-state.json'),
      JSON.stringify({ version: 1, done: { 'morning-2026-10-17': '2026-10-17T06:30:00+08:00' } }),
      'utf-8',
    )
    const event = {
      id: 'morning-report', enabled: true, kind: 'prompt',
      trigger: { type: 'window', from: '06:00', to: '11:59' },
      quietHours: [], target: 'master-dm', template: 'events/morning-report', materials: [], requires: [],
    }
    const h = makeHarness(bookOf(event), { dir, now: new Date(2026, 9, 17, 8, 0, 0) })
    try {
      h.executor.start()
      await new Promise((r) => setImmediate(r))
      assert.equal(h.rooms.length, 0, '旧标记说今天发过了，就不该再发')
      assert.ok(h.logs.some((l) => l.includes('migrated legacy marks')), h.logs.join('\n'))
    } finally { h.cleanup() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('执行器：早报事件把素材与主人号渲染进提示词（模板变量齐全）', async () => {
  const event = {
    id: 'morning-report', enabled: true, kind: 'prompt',
    trigger: { type: 'window', from: '06:00', to: '11:59' },
    quietHours: [], target: 'master-dm', template: 'events/morning-report',
    materials: ['date'], requires: [],
  }
  const h = makeHarness(bookOf(event), { now: new Date(2026, 9, 17, 8, 0, 0), master: 10001 })
  try {
    await h.executor.tick(h.clock.date())
    assert.deepEqual(h.rooms, ['dm-10001'])
    const rendered = h.prompts[0] ?? ''
    assert.match(rendered, /events\/morning-report\|/)
    assert.match(rendered, /日期：2026-10-17/, 'date 素材应当被渲染出来')
    assert.match(rendered, /\|10001$/, 'master 变量应当是主人号')
  } finally { h.cleanup() }
})

test('执行器：书里的 enabled=false 一条都不跑', async () => {
  const h = makeHarness(bookOf({ ...PROMPT_EVENT, enabled: false }))
  try {
    await h.executor.tick(h.clock.date())
    assert.equal(h.rooms.length, 0)
  } finally { h.cleanup() }
})
