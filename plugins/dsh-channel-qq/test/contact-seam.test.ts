/** 主动消息的**宿主流契约**（2026-10-31 "一整天没有主动消息"事故的回归测试）。
 *
 * 事故的现场（真实账本，`home/channel-qq/contact.json`）：
 * `draftCallsToday=10`、`draftFailureStreak=0`、候选 `attempts=9`、
 * `lastSuppressedReason='draft:unavailable'`、`recentReasons` 在
 * `defer:no-channel` 与 `defer:draft:unavailable` 之间来回。
 *
 * 那组数字只说得通一种解释：**每次起草都"成功"结束了，但一个字都没有**`
 * （`empty` 记调用、不动退避）。根因不在预算层，在这条缝的形状：
 * 裸 `llm.stream({provider, model, messages})` 在这台宿主上只回 `usage` + `finish`，
 * 一个 `text-delta` 都没有；而 `finish.reason.kind`（`max-tokens` / `error` / `stop`）
 * 被整段忽略，于是"预算烧在隐藏推理上"与"模型说没什么可说"在账本上长得一模一样。
 *
 * 本文件的纪律（与 `fakes/contact.ts` 一致）：
 *   1. **不连网、不调真模型**：宿主流全部由假件给出，且形状照真实 `StreamChunk` 写；
 *   2. 每条用例只断言**行为级**事实（拿到了什么文案 / 记了哪个稳定词 / 花了几次调用），
 *      不断言内部字段名——那样才能在重构后仍然拦住回归；
 *   3. 真模型的那一次证据在 `logs/contact-fix/real-draft-only.json`，不在单元测试里
 *      （测试必须能离线跑、且不花一分钱）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import * as path from 'node:path'
import type { ContactConfig } from '../src/config/sections/contact.js'
import type { ContactCandidate, ContactRuntimeFacts } from '../src/features/contact/types.js'
import {
  FakeClock, FakeOutboundQueue, FakePlatform, contactCandidate, contactRuntime,
  fieldDefaults, tempHome,
} from './fakes/contact.js'

const { CONTACT_GROUPS } = await import('../src/config/sections/contact.js')
const { createHostDraftPort, maxTokensFor, draftSessionId } = await import('../src/features/contact/draft-host.js')
const { draftWithBudget, DRAFT_REASONS } = await import('../src/features/contact/model.js')
const { ContactStore } = await import('../src/features/contact/store.js')
const { ContactSender } = await import('../src/features/contact/sender.js')
const { ContactWorker } = await import('../src/features/contact/worker.js')
const { scopeIssue } = await import('../src/features/contact/precheck.js')
const { pickDraftEffort } = await import('../src/adapters/dsh-host/llm.js')

const START = Date.UTC(2026, 9, 31, 2, 0, 0)

function config(over: Partial<ContactConfig> = {}): ContactConfig {
  return {
    ...(fieldDefaults(CONTACT_GROUPS) as unknown as ContactConfig),
    enabled: true,
    dryRun: false,
    allowExternalSend: true,
    sendMode: 'direct',
    draftModel: true,
    timezone: 'Asia/Shanghai',
    quietHours: [],
    ...over,
  }
}

// ── 假宿主：**真实** `StreamChunk` 形状 ─────────────────────────────────────

/** 真实协议的一块（`text-delta`/`reasoning-delta` 都带 `.text`，别把两者混为一谈）。 */
interface Chunk {
  type?: string
  index?: number
  text?: string
  blockType?: string
  block?: { type?: string; text?: string }
  reason?: { kind?: string; failure?: { code?: string; message?: string } }
  usage?: unknown
}

function iterate(chunks: readonly Chunk[]): AsyncIterable<Chunk> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0
      return {
        next: async (): Promise<IteratorResult<Chunk>> =>
          (i < chunks.length ? { done: false, value: chunks[i++]! } : { done: true, value: undefined }),
      }
    },
  }
}

/** 标准"跑通了"的流：块开始 → 两段正文 → 一段推理 → 整块收尾 → usage → finish。 */
function okChunks(text: string, reasoning = ''): Chunk[] {
  const half = Math.max(1, Math.floor(text.length / 2))
  const chunks: Chunk[] = [{ type: 'block-start', index: 0, blockType: 'text' }]
  chunks.push({ type: 'text-delta', index: 0, text: text.slice(0, half) })
  if (reasoning !== '') chunks.push({ type: 'reasoning-delta', index: 1, text: reasoning })
  chunks.push({ type: 'text-delta', index: 0, text: text.slice(half) })
  chunks.push({ type: 'block-end', index: 0, block: { type: 'text', text } })
  chunks.push({ type: 'usage', usage: { inputTokens: 120, outputTokens: 18 } })
  chunks.push({ type: 'finish', reason: { kind: 'stop' } })
  return chunks
}

interface HostOptions {
  /** 走 `prepareCall` 时要吐的块（真实宿主的形状）。 */
  chunks?: readonly Chunk[]
  /** 模型声明的推理档位（真实宿主由适配器给）。 */
  efforts?: readonly string[]
  /** `prepareCall` 的覆盖（造"准备阶段被拒"）。 */
  prepareCall?: (config: Record<string, unknown>, signal?: AbortSignal, configure?: unknown) => Promise<unknown>
  /** 裸 `stream` 的覆盖（老宿主/测试假件路径）。 */
  stream?: (options: Record<string, unknown>) => AsyncIterable<Chunk>
  /** 默认选型覆盖（`undefined` = 宿主没有默认模型）。 */
  selection?: () => { provider: string; model: string; reasoningEffort?: string } | undefined
  /** 最后一次真正派发出去的请求（断言请求形状用）。 */
  seen?: Record<string, unknown>
}

/** 默认选型：像这台机器一样带 `reasoningEffort:'max'`（真实宿主的选择就长这样）。 */
const DEFAULT_SELECTION = () => ({ provider: 'mock-provider', model: 'mock-model', reasoningEffort: 'max' })

/** 造一个假宿主上下文：形状照 `LlmService` 推，**默认走 prepareCall**（真实路径）。 */
function host(options: HostOptions = {}): unknown {
  const seen = options.seen ?? {}
  const selection = 'selection' in options ? options.selection : DEFAULT_SELECTION
  const prepareCall = options.prepareCall ?? (async (route: Record<string, unknown>, _signal: AbortSignal | undefined, configure: unknown) => {
    const picked = typeof configure === 'function'
      ? (configure as (c: unknown, m: unknown) => Record<string, unknown>)(
        { ...route },
        { reasoning: options.efforts === undefined ? undefined : { efforts: options.efforts.map((id) => ({ id })) } },
      )
      : { ...route }
    return {
      config: picked,
      stream: (dispatched: Record<string, unknown>) => {
        Object.assign(seen, dispatched)
        return iterate(options.chunks ?? [])
      },
    }
  })
  return {
    llm: {
      stream: options.stream ?? (() => { throw new Error('不该走裸 stream：有 prepareCall 就必须用它') }),
      prepareCall,
    },
    ...(selection === undefined ? {} : { agentDefaultModel: { currentSelection: selection } }),
  }
}

function draftInput(over: Partial<{ now: number; recentCalls: number[] }> = {}) {
  return {
    candidate: contactCandidate({
      id: 'c-seam',
      scope: { userId: 1429709395, personaId: 'companion', worldId: '' },
      target: { channel: 'qq', room: 'dm-1429709395', isGroup: false, chatId: 1429709395 },
      earliestAt: START - 60_000,
      expiresAt: START + 6 * 3_600_000,
    }),
    now: over.now ?? START,
    recentCalls: over.recentCalls ?? [],
  }
}

function countersFor(): InstanceType<typeof ContactStore>['state']['counters'] {
  return {
    day: '2026-10-31',
    sentTodayGlobal: 0,
    sentTodayByRoom: {},
    lastSentAt: null,
    lastSentAtByRoom: {},
    unansweredStreakByRoom: {},
    draftCallsToday: 0,
    lastDraftFailureAt: null,
    draftFailureStreak: 0,
  }
}

async function draftOnce(port: unknown, over: { config?: Partial<ContactConfig>; clock?: FakeClock } = {}) {
  const clock = over.clock ?? new FakeClock(START)
  const logs: string[] = []
  const { candidate, now } = draftInput()
  const outcome = await draftWithBudget(port as never, {
    candidate,
    config: config(over.config),
    counters: countersFor(),
    now,
    recentCalls: [],
  }, { clock, log: (line: string) => { logs.push(line) } })
  return { outcome, logs }
}

// ── (a) 真实宿主流形状 → 拼得出正文（修复前：一个字都没有） ────────────────

test('(a) 真实块形状（text-delta + block-end + finish:stop）→ 拿到草稿，且推理不混进正文', async () => {
  const seen: Record<string, unknown> = {}
  const clock = new FakeClock(START)
  const port = createHostDraftPort({
    context: () => host({
      chunks: okChunks('在吗？刚想到你说的部署', '我要不要现在找他……还是再等等'),
      efforts: ['low', 'medium', 'max'],
      seen,
    }) as never,
    log: () => {},
    clock,
    timeoutMs: () => 20_000,
  })
  const { outcome, logs } = await draftOnce(port, { clock })

  assert.equal(outcome.kind, 'draft', `真实形状的流必须拼得出正文：${logs.join(' | ')}`)
  assert.deepEqual(
    outcome.kind === 'draft' ? outcome.draft.text : null,
    '在吗？刚想到你说的部署',
    '正文只来自 text-delta；reasoning-delta 与 block-end 的整块都不能重复计入',
  )
  // 请求形状（这才是根因所在）：
  assert.equal(typeof seen.sessionId, 'string', '必须带会话 id（provider 会拒绝没有 x-opencode-session-id 的请求）')
  assert.ok(String(seen.sessionId).length > 0)
  assert.equal(seen.reasoningEffort, 'low', '草稿要显式把推理档位降到最低一档（默认 max 会把预算全烧在隐藏推理上）')
  assert.ok(Number(seen.maxTokens) >= 192, `maxTokens 要留出推理余量，实际 ${String(seen.maxTokens)}`)
  assert.ok(Array.isArray(seen.messages) && seen.messages.length === 1, '单次请求、单条 user 消息')
})

test('(a2) 推理档位选择只挑模型**声明过**的档位（没声明就不传，最弱一档兜底）', () => {
  assert.equal(pickDraftEffort('low', { efforts: [{ id: 'low' }, { id: 'max' }] }), 'low')
  assert.equal(pickDraftEffort('low', { efforts: [{ id: 'minimal' }, { id: 'high' }] }), 'minimal', '没有 low 就退到最弱一档')
  assert.equal(pickDraftEffort('low', { efforts: [{ id: 'high' }, { id: 'max' }] }), 'high', '只有高档位时也别硬塞 low（会被拒）')
  assert.equal(pickDraftEffort('low', { efforts: [] }), null, '模型没声明推理能力就不传档位（传任何值都会被拒）')
  assert.equal(pickDraftEffort('low', undefined), null)
  assert.ok(maxTokensFor(120) >= 192, '120 字的草稿也要有推理余量（修复前 360 但下限只有 48）')
  assert.equal(maxTokensFor(10_000), 512, '封顶不变（防止模型写小作文）')
})

// ── (b) 没有可见文本 ≠ SKIP：三种"没话说"要分得开 ─────────────────────────

test('(b) 正常收尾但零可见正文（只有推理）→ draft:empty，与 SKIP 不同', async () => {
  const clock = new FakeClock(START)
  const port = createHostDraftPort({
    context: () => host({
      chunks: [
        { type: 'block-start', index: 0, blockType: 'reasoning' },
        { type: 'reasoning-delta', index: 0, text: '想了想，还是不说了' },
        { type: 'block-end', index: 0, block: { type: 'reasoning', text: '想了想，还是不说了' } },
        { type: 'usage', usage: {} },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
      efforts: ['low'],
    }) as never,
    log: () => {},
    clock,
    timeoutMs: () => 20_000,
  })
  const { outcome } = await draftOnce(port, { clock })
  assert.equal(outcome.kind, 'none')
  assert.equal((outcome as { reason?: string }).reason, 'draft:empty', 'finish=stop 且零可见正文 = 回了空白')
  assert.notEqual((outcome as { reason?: string }).reason, 'draft:skip', '不能把"预算/形状问题"当成"模型说算了"')
  assert.equal(outcome.called, true)
  assert.equal(outcome.counters.draftFailureStreak, 0, '空白回复不是故障（不动退避）')
})

test('(b2) finish=max-tokens 且零可见正文 → draft:reasoning-exhausted（自己的码，按失败记账）', async () => {
  const clock = new FakeClock(START)
  const port = createHostDraftPort({
    context: () => host({
      chunks: [
        { type: 'reasoning-delta', index: 0, text: '先想想现在几点、他可能在做什么' },
        { type: 'usage', usage: { outputTokens: 192, reasoningTokens: 192 } },
        { type: 'finish', reason: { kind: 'max-tokens' } },
      ],
      efforts: ['max'],
    }) as never,
    log: () => {},
    clock,
    timeoutMs: () => 20_000,
  })
  const { outcome, logs } = await draftOnce(port, { clock })
  assert.equal(outcome.kind, 'none')
  assert.equal(
    (outcome as { reason?: string }).reason, 'draft:reasoning-exhausted',
    `预算被隐藏推理吃光要有自己的码（不能并进 draft:empty）：${logs.join(' | ')}`,
  )
  assert.equal(outcome.called, true, '这次真的调过模型（花过钱）')
  assert.equal(outcome.counters.draftFailureStreak, 1, '这是配置问题：要推进有界退避，别用同一份配置把当天预算烧光')
  assert.ok(logs.some((line) => /隐藏推理/.test(line)), `诊断里必须说清"不是模型没话说"：${logs.join(' | ')}`)
})

test('(b3) max-tokens 但已经拿到正文 → draft:truncated（半句话不发，也不算失败）', async () => {
  const clock = new FakeClock(START)
  const port = createHostDraftPort({
    context: () => host({
      chunks: [
        { type: 'text-delta', index: 0, text: '在吗？我想说一件事，就是' },
        { type: 'finish', reason: { kind: 'max-tokens' } },
      ],
      efforts: ['low'],
    }) as never,
    log: () => {},
    clock,
    timeoutMs: () => 20_000,
  })
  const { outcome } = await draftOnce(port, { clock })
  assert.equal(outcome.kind, 'none')
  assert.equal((outcome as { reason?: string }).reason, 'draft:truncated')
  assert.equal(outcome.counters.draftFailureStreak, 0, '截断不是故障（与 too-long 同一种处置）')
})

// ── (c) SKIP 仍然 = "不发，但不是失败" ─────────────────────────────────────

test('(c) 模型回 SKIP → draft:skip：不发、不算失败、退避不动（合法结果）', async () => {
  const clock = new FakeClock(START)
  const port = createHostDraftPort({
    context: () => host({ chunks: okChunks('SKIP'), efforts: ['low'] }) as never,
    log: () => {},
    clock,
    timeoutMs: () => 20_000,
  })
  const { outcome } = await draftOnce(port, { clock })
  assert.equal(outcome.kind, 'none')
  assert.equal((outcome as { reason?: string }).reason, 'draft:skip')
  assert.equal(outcome.called, true, 'SKIP 是调过模型之后的结果（钱花了，小时环要记）')
  assert.equal(outcome.counters.draftCallsToday, 1)
  assert.equal(outcome.counters.draftFailureStreak, 0, 'SKIP 绝不能推进失败退避')
  assert.equal(outcome.counters.lastDraftFailureAt, null)
})

// ── (d) 没有路由：自己的码，且一次调用都不记 ───────────────────────────────

test('(d1) 宿主没有默认模型路由 → draft:no-route，且不记调用/不记失败', async () => {
  const clock = new FakeClock(START)
  const logs: string[] = []
  const port = createHostDraftPort({
    context: () => host({ selection: () => undefined }) as never,
    log: (line: string) => { logs.push(line) },
    clock,
    timeoutMs: () => 20_000,
  })
  const { outcome } = await draftOnce(port, { clock })
  assert.equal(outcome.kind, 'none')
  assert.equal((outcome as { reason?: string }).reason, 'draft:no-route', logs.join(' | '))
  assert.equal(outcome.called, false)
  assert.equal(outcome.counters.draftCallsToday, 0, '没发起调用就不该扣预算')
  assert.equal(outcome.counters.draftFailureStreak, 0)
})

test('(d2) 宿主流服务不存在（profile 没装模型）→ draft:no-route，不是 failed', async () => {
  const clock = new FakeClock(START)
  const port = createHostDraftPort({
    context: () => ({ agentDefaultModel: { currentSelection: () => ({ provider: 'mock', model: 'mock-1' }) } }) as never,
    log: () => {},
    clock,
    timeoutMs: () => 20_000,
  })
  const { outcome } = await draftOnce(port, { clock })
  assert.equal((outcome as { reason?: string }).reason, 'draft:no-route')
  assert.equal(outcome.called, false)
})

test('(d3) prepareCall 被适配器拒绝（NO_ADAPTER）→ draft:no-route，不扣预算', async () => {
  const clock = new FakeClock(START)
  const port = createHostDraftPort({
    context: () => host({
      prepareCall: async () => { throw Object.assign(new Error('no adapter registered for provider "opencode-go"'), { code: 'NO_ADAPTER' }) },
    }) as never,
    log: () => {},
    clock,
    timeoutMs: () => 20_000,
  })
  const { outcome } = await draftOnce(port, { clock })
  assert.equal((outcome as { reason?: string }).reason, 'draft:no-route')
  assert.equal(outcome.called, false)
  assert.equal(outcome.counters.draftCallsToday, 0)
})

test('(d4) 准备阶段抛错（选型 getter 炸）→ draft:not-called（一次生成都没发生）', async () => {
  const clock = new FakeClock(START)
  const port = createHostDraftPort({
    context: () => ({
      llm: { stream: () => { throw new Error('不该被调用') } },
      agentDefaultModel: { currentSelection: () => { throw new Error('宿主没有默认模型') } },
    }) as never,
    log: () => {},
    clock,
    timeoutMs: () => 20_000,
  })
  const { outcome } = await draftOnce(port, { clock })
  assert.equal((outcome as { reason?: string }).reason, 'draft:not-called')
  assert.equal(outcome.called, false)
  assert.equal(outcome.counters.draftCallsToday, 0)
})

// ── (e) 失败/超时：各自的码 ────────────────────────────────────────────────

test('(e1) 流在迭代中抛错 → draft:failed，退避 +1', async () => {
  const clock = new FakeClock(START)
  const port = createHostDraftPort({
    context: () => host({
      prepareCall: async (route: Record<string, unknown>) => ({
        config: route,
        stream: (): AsyncIterable<Chunk> => ({
          [Symbol.asyncIterator]: () => ({ next: async () => { throw new Error('host llm exploded') } }),
        }),
      }),
    }) as never,
    log: () => {},
    clock,
    timeoutMs: () => 20_000,
  })
  const { outcome } = await draftOnce(port, { clock })
  assert.equal((outcome as { reason?: string }).reason, 'draft:failed')
  assert.equal(outcome.called, true)
  assert.equal(outcome.counters.draftFailureStreak, 1)
})

test('(e2) 终态 finish:error（provider 拒绝，如缺会话头）→ draft:failed，诊断带 provider-error:CODE 与用量', async () => {
  // 真实现场的这条证据（主会话实测，512 tokens）：
  //   `finish.reason = { kind:'error', failure:{ code:'INVALID_REQUEST',
  //     message:'400 MissingSessionID: Request is missing x-opencode-session-id...' } }`
  //   `usage` 全 0。修复前它被读成"模型回了空白"（`empty`）——于是失败计数永远是 0，
  //   而候选一天被 defer 九次。
  const clock = new FakeClock(START)
  const logs: string[] = []
  const port = createHostDraftPort({
    context: () => host({
      chunks: [
        { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
        {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: {
              code: 'INVALID_REQUEST',
              message: '400 MissingSessionID: Request is missing x-opencode-session-id and cannot be routed efficiently',
            },
          },
        },
      ],
    }) as never,
    log: (line: string) => { logs.push(line) },
    clock,
    timeoutMs: () => 20_000,
  })
  const { outcome } = await draftOnce(port, { clock })
  assert.equal((outcome as { reason?: string }).reason, 'draft:failed', '终态 error 块是"调用失败"，不是"回了空白"')
  assert.equal(outcome.called, true)
  assert.equal(outcome.counters.draftFailureStreak, 1, '硬失败必须推进失败退避（否则会反复撞同一个 400）')
  const text = logs.join(' | ')
  assert.match(text, /provider-error:INVALID_REQUEST/, `诊断里要有稳定前缀 + 真实错误码：${text}`)
  assert.match(text, /MissingSessionID/, `诊断里要留 provider 的原话：${text}`)
  assert.match(text, /tokens\(in=0,out=0,reasoning=0\)/, `用量全 0 是第二个诚实信号，必须记下来：${text}`)
})

test('(e4) 真实形状的流**没有 finish 块** → draft:failed + stream-error:NO_FINISH（不冒充"空回复"）', async () => {
  // 评审判据：流结束了却没给结束原因，就等于这次调用什么都没说清。若归成 `empty`，
  // 账本会显示"模型回了空白"——那是 2026-10-31 事故的同一种误读。
  const clock = new FakeClock(START)
  const logs: string[] = []
  const port = createHostDraftPort({
    context: () => host({
      chunks: [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: '说到一半' },
        { type: 'usage', usage: { inputTokens: 20, outputTokens: 6 } },
      ],
      efforts: ['low'],
    }) as never,
    log: (line: string) => { logs.push(line) },
    clock,
    timeoutMs: () => 20_000,
  })
  const { outcome } = await draftOnce(port, { clock })
  assert.equal((outcome as { reason?: string }).reason, 'draft:failed', `缺 finish 不能是 empty：${logs.join(' | ')}`)
  assert.equal(outcome.called, true, '这次真的调过模型（花过钱）')
  assert.equal(outcome.counters.draftFailureStreak, 1, '缺结束原因按失败记账（有界退避）')
  assert.match(logs.join(' | '), /stream-error:NO_FINISH/, `诊断要能一眼看出"结束块丢了"：${logs.join(' | ')}`)
})

test('(e5) 老形状（只有 {text}、没有 finish）仍然照旧：不当成 NO_FINISH', async () => {
  // 旧适配器/测试假件本来就不发 finish 块；对它们套 NO_FINISH 会把合法输出判成失败。
  const clock = new FakeClock(START)
  const port = createHostDraftPort({
    context: () => ({
      llm: {
        stream: () => iterate([{ text: '旧形状的一句话' }]),
      },
      agentDefaultModel: { currentSelection: () => ({ provider: 'mock', model: 'mock-1' }) },
    }) as never,
    log: () => {},
    clock,
    timeoutMs: () => 20_000,
  })
  const { outcome } = await draftOnce(port, { clock })
  assert.equal(outcome.kind, 'draft')
  assert.equal(outcome.kind === 'draft' ? outcome.draft.text : null, '旧形状的一句话')
})

test('(e3) 超时 → draft:timeout（自己的码），退避 +1', async () => {
  const clock = new FakeClock(START)
  const logs: string[] = []
  const port = createHostDraftPort({
    context: () => host({
      prepareCall: async (route: Record<string, unknown>) => ({
        config: route,
        stream: (): AsyncIterable<Chunk> => ({
          [Symbol.asyncIterator]: () => ({
            next: async (): Promise<IteratorResult<Chunk>> => {
              // 比超时窗更晚才回：只能被判超时（真模型卡住时也是这样）。
              await new Promise<void>((resolve) => { clock.setTimeout(resolve, 30_000) })
              return { done: false, value: { type: 'text-delta', index: 0, text: '迟到的正文' } }
            },
          }),
        }),
      }),
    }) as never,
    log: (line: string) => { logs.push(line) },
    clock,
    timeoutMs: () => 5_000,
  })
  const { candidate, now } = draftInput()
  const pending = draftWithBudget(port, {
    candidate, config: config(), counters: countersFor(), now, recentCalls: [],
  }, { clock, log: (line: string) => { logs.push(line) } })
  clock.advance(6_000)
  const outcome = await pending
  assert.equal((outcome as { reason?: string }).reason, 'draft:timeout', logs.join(' | '))
  assert.equal(outcome.called, true, '超时也算"发起过请求"（请求可能还在宿主那边跑）')
  assert.equal(outcome.counters.draftFailureStreak, 1)
  assert.ok(logs.some((line) => /超时/.test(line)))
})

// ── (f) 通道先不可用、后恢复 → 恰好一次起草、一次发送 ──────────────────────

test('(f) 没有通道时不起草；通道回来后只起草一次、只发一条（无重复发送）', async () => {
  const home = tempHome('qq-seam-channel-')
  try {
    const clock = new FakeClock(START)
    const platform = new FakePlatform({ clock, connected: false })
    const queue = new FakeOutboundQueue()
    const logs: string[] = []
    const dir = path.join(home.dir, 'channel-qq')
    mkdirSync(dir, { recursive: true })
    const store = new ContactStore({
      file: path.join(dir, 'contact.json'),
      lockFile: path.join(dir, 'contact.lock'),
      hostId: 'host-a',
      pid: 1001,
      log: (line: string) => { logs.push(line) },
      clock,
      dayKey: () => '2026-10-31',
    })
    let drafts = 0
    const seen: Record<string, unknown> = {}
    const port = createHostDraftPort({
      context: () => {
        drafts += 1
        return host({ chunks: okChunks('早上好呀'), efforts: ['low', 'max'], seen }) as never
      },
      log: (line: string) => { logs.push(line) },
      clock,
      timeoutMs: () => 20_000,
    })
    const room = 'dm-1429709395'
    let connected = false
    const runtime = (): ContactRuntimeFacts => contactRuntime({
      connected,
      lastUserMessageAtByRoom: { [room]: null },
      turnRunningByRoom: { [room]: false },
    })
    const sender = new ContactSender({
      log: (line: string) => { logs.push(line) },
      clock,
      transport: () => ({ connected, out: queue, api: platform.api }),
      turns: () => ({ bookPrompt: async () => true }),
      identity: () => ({ personaId: 'companion', worldId: '' }),
      refresh: (id) => ({ candidate: store.candidate(id), runtime: runtime() }),
      timeoutMs: 30_000,
    })
    const worker = new ContactWorker({
      store,
      sender,
      clock,
      log: (line: string) => { logs.push(line) },
      config: () => config(),
      roomFacts: () => ({ connected, roomBound: true, turnRunning: false, lastUserMessageAt: null }),
      identity: () => ({ personaId: 'companion', worldId: '' }),
      draftPort: port,
    })
    try {
      const now = clock.now()
      const candidate = contactCandidate({
        id: 'c-channel', dedupeKey: 'k-channel', state: 'pending',
        scope: { userId: 1429709395, personaId: 'companion', worldId: '' },
        target: { channel: 'qq', room, isGroup: false, chatId: 1429709395 },
        earliestAt: now - 60_000, expiresAt: now + 6 * 3_600_000, createdAt: now - 60_000,
      })
      await store.write((ledger) => { ledger.candidates[candidate.id] = candidate; return true })

      // 第一拍：通道没连上 → 门控 defer(no-channel)，**不该起草**（也不该花模型钱）。
      await worker.tick(now)
      assert.equal(drafts, 0, `没有通道时一次模型调用都不该发生，实际 ${String(drafts)} 次：${logs.join(' | ')}`)
      assert.equal(platform.count(), 0)
      assert.equal(store.candidate('c-channel')?.lastSuppressedReason, 'no-channel')

      // 通道回来了：同一拍里先 defer 后 send 的那条候选只该起草一次、只发一条。
      connected = true
      platform.connected = true
      clock.shift(60_000)
      await worker.tick(clock.now())
      await worker.tick(clock.now())
      assert.equal(drafts, 1, `通道恢复后只该起草一次，实际 ${String(drafts)} 次：${logs.join(' | ')}`)
      assert.equal(platform.count(), 1, `只该发一条，实际 ${String(platform.count())} 条`)
      assert.deepEqual(platform.textsTo(1429709395), ['早上好呀'])
      assert.equal(store.listDeliveries().length, 1, '投递记录只有一条（没有重复领取）')
      assert.equal(typeof seen.sessionId, 'string', '真实草稿请求必须带会话 id')
    } finally {
      await worker.dispose()
    }
  } finally {
    home.cleanup()
  }
})

// ── (g) 候选 scope 与真实身份对得上 ────────────────────────────────────────

test('(g) 候选的 persona/world 映射到真实身份：`companion`/`""` 与配置同源，不会被判越权', () => {
  // 生产现场的那条候选（`contact.json`）与生产身份：
  //   candidate.scope = { userId: 1429709395, personaId: 'companion', worldId: '' }
  //   身份 = { personaId: host.config.agentPreset, worldId: '' }，配置里 agentPreset=companion
  // 人格的**显示名**是「三月七」（march7），但身份用的是**预设 id**（companion）——
  // 两者不是同一个字段，混淆它们才会以为"映射错了"。
  const candidate: ContactCandidate = contactCandidate({
    scope: { userId: 1429709395, personaId: 'companion', worldId: '' },
    target: { channel: 'qq', room: 'dm-1429709395', isGroup: false, chatId: 1429709395 },
  })
  const target = candidate.target
  assert.equal(scopeIssue(candidate, target, { personaId: 'companion', worldId: '' }), null,
    '生产配置下候选作用域与身份一致：不越权，可以发')
  // 反向：真正的错配（把身份换成另一个预设 id）必须被拦下——这条证明判据是活的。
  assert.equal(scopeIssue(candidate, target, { personaId: 'march7', worldId: '' }), 'scope:persona',
    '若身份真的换了预设，作用域复核要拦下（不是静默放行）')
  assert.equal(scopeIssue(candidate, target, { personaId: 'companion', worldId: 'w2' }), 'scope:world')
})

test('(g2) 词表：新增的三个稳定词都在 DRAFT_REASONS 里，且格式与既有词一致', () => {
  for (const reason of ['draft:empty', 'draft:skip', 'draft:reasoning-exhausted', 'draft:truncated', 'draft:no-route', 'draft:not-called']) {
    assert.ok(DRAFT_REASONS.includes(reason as never), `${reason} 必须在词表里（诊断按它 grep）`)
  }
  for (const reason of DRAFT_REASONS) {
    assert.match(reason, /^[a-z][a-z0-9-]*(?::[a-z0-9-]+)?$/, `reason 必须是稳定短串：${reason}`)
  }
  assert.equal(draftSessionId(4242), 'contact-draft-4242', '会话 id 形状稳定（可归属到进程）')
})
