/** **3D 起草上下文接入**（P2.5-3D / Slice C0）的证据文件。
 *
 * 这个文件不接受"我调用了某个函数"作为证据：每一条断电断言的都是**实际模型请求**
 * （`llm.stream` 收到的 `messages[0].content[0].text`）。审计 A2 已经证明过
 * "ID 存在 ≠ 正文注入"——所以这里的判据只有两类：
 *   1. 捕获到的请求里**有没有那段文字**（`assert.ok(prompt.includes(...))`）；
 *   2. 该不该有请求时**到底发生了几次**（`stream` 计数 / `platform.count()`）。
 *
 * 六类场景（计划 §3 3D 的验证场景 / Lead 的本轮验收）与用例的对应：
 *   ① 有对话可延续 → D2a、D5b       ② 无记忆命中但对话可用 → D3c
 *   ③ 对话读取失败 → 跳过 → D2b/D2c  ④ 身份不匹配 → 跳过 → S1
 *   ⑤ 证据缺失 → 不分享 → D4a/D4b    ⑥ 起草期间新消息 → 旧草稿失效 → F1a/F1b
 *
 * 纪律：不发真 QQ、不调真模型、不读真库；时间在单元级用 `FakeClock`，插件级用真实
 * `systemClock`（`index.ts` 用的是它，这里不假装有假时钟——见 `contact-plugin.test.ts`）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { withLock } from '../src/adapters/fs-store/mutex.js'
import type { AdminResource } from '../src/admin/types.js'
import type { ContactConfig } from '../src/config/sections/contact.js'
import type { QQChannelConfig } from '../src/config.js'
import type { ContactCandidate, ContactDelivery, ContactRuntimeFacts, ContactService } from '../src/features/contact/types.js'
import type { ContactSendRequest } from '../src/features/contact/sender.js'
import type { HostBridge, SectionHostEnv, ServiceBag } from '../src/features/plugin-kit.js'
import type { DraftContextDeps } from '../src/features/contact/draft-context.js'
import {
  FakeClock, FakeOutboundQueue, FakePlatform, FakeRegistry, baseConfig, contactCandidate,
  contactRuntime, fakeBridge, fieldDefaults, tempHome, waitUntil,
} from './fakes/contact.js'
import { CONTACT_GROUPS } from '../src/config/sections/contact.js'
import { createHost } from '../src/features/plugin-kit.js'
import { contactPlugin } from '../src/features/contact/index.js'
import { buildDraftPrompt, createHostDraftPort } from '../src/features/contact/draft-host.js'
import { emptyCounters } from '../src/features/contact/types.js'
import { zoneClock } from '../src/features/contact/local-time.js'
import {
  DRAFT_CONTEXT_BUDGET, buildDraftContext, describeDraftContext, sufficientContext,
} from '../src/features/contact/draft-context.js'
import { freshnessIssue, verdictOf } from '../src/features/contact/precheck.js'
import { ContactStore } from '../src/features/contact/store.js'

/** 2026-10-16 22:00 上海（= 14:00 UTC）：本地与 UTC 不同日不同时的时段，能测出时区口径。 */
const START = Date.UTC(2026, 9, 16, 14, 0, 0)
const ROOM = 'dm-10001'
const OWNER = 10001
const SELF = 10000

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
    // 发布基线：自主跟进复核（复用模型预算）默认关；本文件测的是复核/起草读到的上下文，
    // 所以显式打开。
    adaptiveFollowUp: true,
    ...over,
  }
}

/** 一条历史（形状同 `HistoryEntry`：`time` 是**秒**）。 */
function entry(id: number, userId: number, text: string, atMs: number): {
  id: number; userId: number; name: string; text: string; time: number
} {
  return { id, userId, name: userId === SELF ? '我' : '主人', text, time: Math.floor(atMs / 1000) }
}

function fakeHistory(rows: ReturnType<typeof entry>[], over: { collectThrows?: boolean; searchThrows?: boolean } = {}): unknown {
  return {
    search: async () => {
      if (over.searchThrows === true) throw new Error('history store 坏了')
      return rows
    },
    collect: async () => {
      if (over.collectThrows === true) throw new Error('平台拉历史超时')
      return 0
    },
  }
}

interface DepsOverrides {
  readonly services?: Record<string, unknown>
  readonly preset?: DraftContextDeps['preset']
  readonly config?: Partial<ContactConfig>
  readonly deliveries?: DraftContextDeps['deliveries']
  readonly counters?: DraftContextDeps['counters']
  readonly roomFacts?: DraftContextDeps['roomFacts']
  readonly budget?: DraftContextDeps['budget']
  readonly logs?: string[]
}

/** 单元级的组装依赖：服务袋就是一个普通对象（这正是 C0 能"零真依赖"测出来的原因）。 */
function depsFor(over: DepsOverrides = {}): DraftContextDeps {
  const table = over.services ?? {}
  return {
    get: (name: string) => table[name],
    preset: over.preset ?? (() => undefined),
    config: () => config(over.config ?? {}),
    deliveries: over.deliveries ?? (() => []),
    counters: over.counters ?? (() => emptyCounters('2026-10-16')),
    ...(over.roomFacts === undefined ? {} : { roomFacts: over.roomFacts }),
    clock: new FakeClock(START),
    log: (line: string) => over.logs?.push(line),
    ...(over.budget === undefined ? {} : { budget: over.budget }),
  }
}

/** 一个"话很短"的合成人设（不读真 preset 文档）。 */
function fakePreset(document = '测试人设：说话短，别端着，喜欢叫主人。', throws = false): DraftContextDeps['preset'] {
  return () => ({
    readDocument: async () => {
      if (throws) throw new Error('preset 文件读不出来')
      return { content: document }
    },
  })
}

/** 捕获"实际模型请求"的假宿主上下文（`draft-host` 只读这两样）。 */
function capturingContext(seen: unknown[], reply = '在的，部署那事搞定了吗'): unknown {
  return {
    llm: {
      stream: (input: unknown) => {
        seen.push(input)
        return {
          [Symbol.asyncIterator]: (): AsyncIterator<{ text?: string }> => {
            let done = false
            return {
              next: async () => {
                if (done) return { done: true, value: undefined }
                done = true
                return { done: false, value: { text: reply } }
              },
            }
          },
        }
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'mock', model: 'mock-1' }) },
  }
}

/** 从捕获到的请求里取出**提示词全文**（这就是 C0 的全部被测对象）。 */
function promptOf(input: unknown): string {
  const messages = (input as { messages?: Array<{ content?: Array<{ text?: string }> }> }).messages ?? []
  return messages[0]?.content?.[0]?.text ?? ''
}

/** 走一次真实端口，返回提示词（`context` 缺席时就是修复前那七行）。 */
async function promptWith(candidate: ContactCandidate, context?: Awaited<ReturnType<typeof buildDraftContext>>): Promise<string> {
  const seen: unknown[] = []
  const port = createHostDraftPort({
    context: () => capturingContext(seen) as never,
    log: () => {},
    clock: new FakeClock(START),
    timeoutMs: () => 20_000,
  })
  const attempt = await port.draft({
    candidate,
    maxChars: 120,
    now: START,
    ...(context === undefined ? {} : { context }),
  })
  assert.equal(attempt.kind, 'draft', `假模型应当给出草稿，实际 ${attempt.kind}`)
  assert.equal(seen.length, 1, '一次起草只发起一次模型调用')
  return promptOf(seen[0])
}

const HAPPY_LINES = [
  entry(1, OWNER, '部署脚本又挂了，nginx 502', START - 40 * 60_000),
  entry(2, SELF, '先看 upstream 是不是没起来', START - 39 * 60_000),
  entry(3, OWNER, 'upstream 起来了，但是健康检查超时', START - 3 * 60_000),
]

function baseCandidate(over: Partial<ContactCandidate> = {}): ContactCandidate {
  return contactCandidate({ id: 'c-ctx', dedupeKey: 'k-ctx', updatedAt: START - 60_000, ...over })
}

/** 与 `contactCandidate()` 的 `scope` 自洽的身份（`scopeIssue` 会拿它对一遍）。 */
const IDENTITY = { personaId: 'nono', worldId: '' }

// ── D1 人设：读到了就进请求，读不到就记缺口（不编一个假人设） ─────────────────

test('D1a 人设读到了 → **实际请求**里有那段人设', async () => {
  const context = await buildDraftContext(depsFor({
    services: { history: fakeHistory(HAPPY_LINES) },
    preset: fakePreset(),
  }), baseCandidate(), START)
  const prompt = await promptWith(baseCandidate(), context)
  assert.ok(prompt.includes('测试人设：说话短'), `请求里必须有人设正文：\n${prompt}`)
  assert.equal(context.gaps.some((gap) => gap.partition === 'persona'), false, '读到了就不该记缺口')
})

test('D1b 宿主没有人格注册表 → 记 persona:missing，但**对话在就照发**（人设缺失只降级）', async () => {
  const context = await buildDraftContext(depsFor({ services: { history: fakeHistory(HAPPY_LINES) } }), baseCandidate(), START)
  assert.equal(context.gaps.find((gap) => gap.partition === 'persona')?.code, 'persona:missing')
  assert.equal(sufficientContext(context).ok, true, '人设缺失不是"不能开口"的理由（有对话就还能判断）')
  const prompt = await promptWith(baseCandidate(), context)
  assert.equal(prompt.includes('【她是谁'), false, `没读到人设就不许出现人设段（不许编）：\n${prompt}`)
  assert.ok(prompt.includes('persona:missing'), `缺口要进请求，模型才知道这块没拿到：\n${prompt}`)
})

test('D1c 人设读取出错 → 记缺口、不抛、不进失败退避（它是降级不是故障）', async () => {
  const context = await buildDraftContext(depsFor({
    services: { history: fakeHistory(HAPPY_LINES) },
    preset: fakePreset('', true),
  }), baseCandidate(), START)
  const gap = context.gaps.find((item) => item.partition === 'persona')
  assert.equal(gap?.code, 'persona:missing')
  assert.ok(gap?.reason.includes('preset 文件读不出来'), `缺口要写清真实原因：${String(gap?.reason)}`)
  assert.equal(sufficientContext(context).ok, true)
})

// ── D2 最近对话：硬条件（没有对话就是修复前那个事故） ────────────────────────

test('D2a 3 条历史 → 请求里按**旧→新**出现，带发言人标记（有对话可延续）', async () => {
  const context = await buildDraftContext(depsFor({ services: { history: fakeHistory(HAPPY_LINES) } }), baseCandidate(), START)
  assert.equal(context.history.length, 3)
  const prompt = await promptWith(baseCandidate(), context)
  const at502 = prompt.indexOf('nginx 502')
  const atUpstream = prompt.indexOf('先看 upstream')
  const atHealth = prompt.indexOf('健康检查超时')
  assert.ok(at502 > 0 && atUpstream > at502 && atHealth > atUpstream, `顺序必须是旧→新：\n${prompt}`)
  assert.ok(prompt.includes('TA（主人）：部署脚本又挂了'), `用户那侧要有发言人标记，并把称呼带出来：\n${prompt}`)
  assert.ok(prompt.includes('我：先看 upstream'), `她自己那侧要标成"我"（否则模型分不清谁说的）：\n${prompt}`)
  assert.ok(/\d{2}:\d{2}/.test(prompt), `每行要带时刻：\n${prompt}`)
})

test('D2b 拿不到 history 服务 → **一次模型调用都不发生**，候选 deferred，稳定词 draft:no-context', async () => {
  const rig = await directRig()
  try {
    await rig.propose()
    await rig.tick()
    assert.equal(rig.streams(), 0, `读不到对话就不许调模型（退回去就是那次事故）：${rig.logs().join('\n')}`)
    assert.equal(rig.counters().draftCallsToday, 0, '没调模型就不该扣起草预算')
    const candidate = rig.candidates()[0]
    assert.equal(candidate?.state, 'deferred', `候选要 defer 回去（不是 drop、也不是发出去）：${String(candidate?.state)}`)
    assert.ok(rig.reasons().some((line) => line.includes('draft:no-context')), `诊断里要有稳定词：${rig.reasons().join(' | ')}`)
    assert.equal(rig.platform.count(), 0)
  } finally {
    rig.close()
  }
})

test('D2c 回源也拿不到（search 空 + collect 0）→ 与"没有服务"同一条路：零调用 + draft:no-context', async () => {
  const context = await buildDraftContext(depsFor({ services: { history: fakeHistory([]) } }), baseCandidate(), START)
  assert.equal(context.gaps.find((gap) => gap.partition === 'history')?.code, 'history:empty')
  assert.equal(sufficientContext(context).ok, false)
  const rig = await directRig({ services: { history: fakeHistory([]) } })
  try {
    await rig.propose()
    await rig.tick()
    assert.equal(rig.streams(), 0)
    assert.ok(rig.reasons().some((line) => line.includes('draft:no-context')), rig.reasons().join(' | '))
  } finally {
    rig.close()
  }
})

test('D2d 历史超过 12 条 → 只取最后 12 条（第 13 条早的不进请求）', async () => {
  const many = Array.from({ length: 20 }, (_, index) => entry(index + 1, OWNER, `第${String(index + 1)}句：这是很早以前的话`, START - (20 - index) * 60_000))
  const context = await buildDraftContext(depsFor({ services: { history: fakeHistory(many) } }), baseCandidate(), START)
  assert.equal(context.history.length, 12, `最多 12 条（A2 §5.4），实际 ${String(context.history.length)}`)
  const prompt = await promptWith(baseCandidate(), context)
  assert.equal(prompt.includes('第8句'), false, `第 8 句（= 20 条里的第 13 早）不该出现：\n${prompt}`)
  assert.ok(prompt.includes('第20句'), '最后一句必须在')
})

// ── D3 记忆：有就逐字进请求，没有/读不到都只降级 ─────────────────────────────

test('D3a memoryEvidence 有命中 → 请求里逐字包含该块', async () => {
  const block = '【记忆】他上周说过要换工作；他对 nginx 很熟'
  const context = await buildDraftContext(depsFor({
    services: { history: fakeHistory(HAPPY_LINES), memoryEvidence: async () => block },
  }), baseCandidate(), START)
  assert.equal(context.memory, block)
  const prompt = await promptWith(baseCandidate(), context)
  assert.ok(prompt.includes(block), `记忆块必须逐字进请求：\n${prompt}`)
})

test('D3b memoryEvidence 抛错 → 记 memory:missing，**仍然发**（记忆不是硬条件）', async () => {
  const context = await buildDraftContext(depsFor({
    services: {
      history: fakeHistory(HAPPY_LINES),
      memoryEvidence: async () => { throw new Error('向量库挂了') },
    },
  }), baseCandidate(), START)
  assert.equal(context.gaps.find((gap) => gap.partition === 'memory')?.code, 'memory:missing')
  assert.equal(sufficientContext(context).ok, true)
})

test('D3c 没有注入 memoryEvidence（memory.v2 关）/ 返回空串 → 两类缺口分开记，且**基于对话照发**', async () => {
  const absent = await buildDraftContext(depsFor({ services: { history: fakeHistory(HAPPY_LINES) } }), baseCandidate(), START)
  assert.equal(absent.gaps.find((gap) => gap.partition === 'memory')?.code, 'memory:missing')
  const empty = await buildDraftContext(depsFor({
    services: { history: fakeHistory(HAPPY_LINES), memoryEvidence: async () => '' },
  }), baseCandidate(), START)
  assert.equal(empty.gaps.find((gap) => gap.partition === 'memory')?.code, 'memory:empty')
  assert.equal(sufficientContext(empty).ok, true, '"没想起什么"不是故障（A2 §5.6）')
  const prompt = await promptWith(baseCandidate(), empty)
  assert.ok(prompt.includes('健康检查超时'), '无记忆命中时仍然要基于对话判断')
})

// ── D4 证据正文：不解析 id，但绝不编（缺口写进请求） ─────────────────────────

test('D4a evidenceIds 有值但没有解析器 → 记 evidence:unresolved，退化成"最近一条对话"', async () => {
  const candidate = baseCandidate({ evidenceIds: [`chat:qq-dm-10001:${String(Math.floor(START / 1000))}`] })
  const context = await buildDraftContext(depsFor({ services: { history: fakeHistory(HAPPY_LINES) } }), candidate, START)
  assert.equal(context.gaps.find((gap) => gap.partition === 'evidence')?.code, 'evidence:unresolved')
  assert.equal(context.evidence.length, 1)
  assert.equal(context.evidence[0]?.source, 'history:last')
  const prompt = await promptWith(candidate, context)
  assert.ok(prompt.includes('健康检查超时'), `证据退化成最后一条对话：\n${prompt}`)
  assert.ok(prompt.includes('evidence:unresolved'), `"id 解析不了"这件事要写进请求，别让模型以为它有原文：\n${prompt}`)
})

test('D4b 证据指向的东西读不出来（history 也空）→ 零调用（不分享、不编）', async () => {
  const candidate = baseCandidate({ evidenceIds: ['chat:qq-dm-10001:1730000000'] })
  const context = await buildDraftContext(depsFor({ services: { history: fakeHistory([]) } }), candidate, START)
  assert.equal(context.evidence.length, 0)
  assert.deepEqual(sufficientContext(context), { ok: false, detail: 'history:empty' })
})

// ── D5 最近主动外发 + 反馈：避免近义问候反复开场 ─────────────────────────────

test('D5a sentLog 渲染块 + 一条 confirmed 投递 → 请求里有"上次说过什么"和送达状态', async () => {
  const sentBlock = '【我最近在私聊里发过的消息】\n21:30 我发的 #9001：在吗？'
  const context = await buildDraftContext(depsFor({
    services: { history: fakeHistory(HAPPY_LINES), sentLogHub: { for: async () => ({ render: () => sentBlock }) } },
    deliveries: () => [{
      ...contactCandidateDelivery(), text: '在吗？部署方便说说吗', state: 'confirmed', updatedAt: START - 3_600_000,
    }],
    counters: () => ({ ...emptyCounters('2026-10-16'), unansweredStreakByRoom: { [ROOM]: 0 }, lastSentAtByRoom: { [ROOM]: START - 3_600_000 } }),
  }), baseCandidate(), START)
  const prompt = await promptWith(baseCandidate(), context)
  assert.ok(prompt.includes('在吗？'), `要有她上次说过的话：\n${prompt}`)
  assert.ok(prompt.includes('confirmed'), `要带送达状态（unknown 不能当成功）：\n${prompt}`)
  assert.ok(prompt.includes('回过话'), `对方接没接要说清：\n${prompt}`)
})

test('D5b 未回复计数 = 1 → 请求里明确写"TA 还没回过话"（不用近义问候绕过去重）', async () => {
  const context = await buildDraftContext(depsFor({
    services: { history: fakeHistory(HAPPY_LINES) },
    counters: () => ({ ...emptyCounters('2026-10-16'), unansweredStreakByRoom: { [ROOM]: 1 } }),
  }), baseCandidate(), START)
  assert.equal(context.unansweredStreak, 1)
  const prompt = await promptWith(baseCandidate(), context)
  assert.ok(prompt.includes('还没回过话'), `要写清"上次没人接话"：\n${prompt}`)
})

test('D5c sentLogHub 缺失 + 没有投递记录 → 记 outbound:missing，不假装知道', async () => {
  const context = await buildDraftContext(depsFor({ services: { history: fakeHistory(HAPPY_LINES) } }), baseCandidate(), START)
  assert.equal(context.gaps.find((gap) => gap.partition === 'outbound')?.code, 'outbound:missing')
})

// ── D6 时间：与门控同一份 zoneClock 结果（不再硬编码上海） ────────────────────

test('D6a timezone=Asia/Shanghai → 请求里的时间与 zoneClock(now,tz) 是**同一分钟**', async () => {
  const context = await buildDraftContext(depsFor({ services: { history: fakeHistory(HAPPY_LINES) } }), baseCandidate(), START)
  const zoned = zoneClock(START, 'Asia/Shanghai')
  assert.ok(zoned !== null)
  const hhmm = `${String(Math.floor(zoned.minutes / 60)).padStart(2, '0')}:${String(zoned.minutes % 60).padStart(2, '0')}`
  const prompt = await promptWith(baseCandidate(), context)
  assert.ok(prompt.includes(`当前时间（Asia/Shanghai）：${zoned.day} ${hhmm}`), `时间行口径必须与门控一致：\n${prompt}`)
  assert.ok(prompt.includes(zoned.day), '日期也要写（跨日判断靠它）')
})

test('D6b timezone 为空（跟随宿主）→ 时间行仍在，且标成"宿主本地"；时段与别的口径无关', async () => {
  const context = await buildDraftContext(depsFor({
    services: { history: fakeHistory(HAPPY_LINES) },
    config: { timezone: '' },
  }), baseCandidate(), START)
  const zoned = zoneClock(START, '')
  assert.ok(zoned !== null)
  assert.equal(context.clock?.tzLabel, '宿主本地')
  const prompt = await promptWith(baseCandidate(), context)
  assert.ok(prompt.includes('当前时间（宿主本地）：'), `空时区也要说清用哪套口径：\n${prompt}`)
  assert.equal(context.clock?.dayKey, zoned.day)
})

test('D6c timezone 名不认识 → 上下文自己就判"不能开口"，一次模型调用都不发生', async () => {
  const context = await buildDraftContext(depsFor({
    services: { history: fakeHistory(HAPPY_LINES) },
    config: { timezone: 'Not/AZone' },
  }), baseCandidate(), START)
  assert.equal(context.clock, null)
  assert.equal(context.gaps.find((gap) => gap.partition === 'clock')?.code, 'clock:timezone-invalid')
  assert.deepEqual(sufficientContext(context), { ok: false, detail: 'clock:timezone-invalid' })
  const rig = await directRig({ config: { timezone: 'Not/AZone' }, services: { history: fakeHistory(HAPPY_LINES) } })
  try {
    await rig.propose()
    await rig.tick()
    assert.equal(rig.streams(), 0, `时区算不出来就不许开口（与门控 fail-closed 同一条）：${rig.logs().join('\n')}`)
  } finally {
    rig.close()
  }
})

// ── S 身份不匹配 / 未接入分区：跳过，且缺口进请求 ────────────────────────────

test('S1 身份不匹配（候选 scope.userId ≠ 目标 chatId）→ 门控在起草前就拦下，零模型调用', async () => {
  const rig = await directRig({ services: { history: fakeHistory(HAPPY_LINES) } })
  try {
    await rig.propose({ scope: { userId: 10002, personaId: '', worldId: '' } })
    await rig.tick()
    assert.equal(rig.streams(), 0, `越权候选不许进模型：${rig.logs().join('\n')}`)
    assert.equal(rig.candidates()[0]?.state, 'cancelled', '越权是终态（重试只会把同一条错发三次）')
    assert.equal(rig.platform.count(), 0)
  } finally {
    rig.close()
  }
})

test('S2 三块没有拥有者接口的分区 → 恒记 unsupported，并且**写进请求**（模型知道它没拿到）', async () => {
  const context = await buildDraftContext(depsFor({ services: { history: fakeHistory(HAPPY_LINES) } }), baseCandidate(), START)
  const codes = context.gaps.map((gap) => gap.code)
  assert.ok(codes.includes('pending:unsupported'), `未完成事项要显式记缺：${codes.join(',')}`)
  assert.ok(codes.includes('mentionPolicy:unsupported'), `mentionPolicy 要显式记缺：${codes.join(',')}`)
  const gap = context.gaps.find((item) => item.partition === 'pending')
  assert.ok((gap?.ownerHint ?? '').includes('companion-runtime'), '缺口要写"谁该来补"（留给下一片）')
  const prompt = await promptWith(baseCandidate(), context)
  assert.ok(prompt.includes('pending:unsupported'), `缺口必须出现在实际请求里：\n${prompt}`)
  assert.ok(prompt.includes('不许编造'), `并且要明确禁止编造：\n${prompt}`)
  assert.ok(prompt.includes('【未完成事项】'), '未完成事项段恒在（告知"这块没接入"）')
})

// ── F 新鲜度：起草期间世界变了 → 旧草稿作废 ──────────────────────────────────

function sendRequest(over: { draftedAt: number; updatedAt: number; lastUserAt: number | null }): ContactSendRequest {
  const candidate = baseCandidate({
    updatedAt: over.updatedAt,
    earliestAt: 0,
    expiresAt: START + 3_600_000,
    authorization: { kind: 'standing', by: OWNER, at: START - 86_400_000, quote: null },
  })
  return {
    delivery: { ...contactCandidateDelivery(), candidateId: candidate.id, updatedAt: START, state: 'running' },
    candidate,
    text: '在的，部署那边搞定了吗',
    now: over.draftedAt,
    draftedAt: over.draftedAt,
    runtime: contactRuntime({ lastUserMessageAtByRoom: { [ROOM]: over.lastUserAt } }),
  }
}

test('F1a 起草后候选被改过（version/updatedAt 前进）→ 执行点 deferred（draft:stale），零 sendTo', async () => {
  const stale = freshnessIssue(sendRequest({ draftedAt: START, updatedAt: START + 1, lastUserAt: null }), baseCandidate({ updatedAt: START + 1 }), contactRuntime({ lastUserMessageAtByRoom: { [ROOM]: null } }))
  assert.deepEqual(stale, { state: 'deferred', detail: 'draft:stale' }, '证据/状态在起草后变了 → 旧草稿失效')
  const verdict = verdictOf(
    sendRequest({ draftedAt: START, updatedAt: START + 1, lastUserAt: null }),
    config({ allowedRooms: [] }),
    { identity: () => IDENTITY, transport: () => undefined, turns: () => undefined },
  )
  assert.equal(verdict?.detail, 'draft:stale', `verdictOf 必须接上这道闸（否则草稿照样发出去）：${String(verdict?.detail)}`)
})

test('F1b 起草期间目标房间来了新消息 → draft:stale:new-message（优先于 settle 窗）', async () => {
  const runtime = contactRuntime({ lastUserMessageAtByRoom: { [ROOM]: START + 2_000 } })
  const req = sendRequest({ draftedAt: START, updatedAt: START - 1_000, lastUserAt: START + 2_000 })
  assert.deepEqual(freshnessIssue(req, req.candidate, runtime), { state: 'deferred', detail: 'draft:stale:new-message' })
  const verdict = verdictOf(req, config({ allowedRooms: [] }), {
    identity: () => IDENTITY, transport: () => undefined, turns: () => undefined,
  })
  assert.equal(verdict?.detail, 'draft:stale:new-message', '窗口里来了新消息 → 不许把旧问候插进新对话')
  assert.equal(verdict?.state, 'deferred', 'deferred 而不是 cancelled：下一拍重新起草，候选不丢')
})

test('F1c 对照组：世界没变 → 恰好 1 次 sendTo（别把"能发"也拦掉）', async () => {
  const rig = await directRig({ services: { history: fakeHistory(HAPPY_LINES), memoryEvidence: async () => '【记忆】他在弄 nginx' } })
  try {
    await rig.propose()
    await rig.tick()
    assert.equal(rig.streams(), 1, `这一轮该起草一次：${rig.logs().join('\n')}`)
    assert.equal(rig.platform.count(), 1, '上下文齐了就该发出去恰好一条')
    assert.deepEqual(rig.platform.textsTo(OWNER), ['在的，部署那事搞定了吗'])
  } finally {
    rig.close()
  }
})

test('F1d 插件级：起草期间候选被修订（外部改账本）→ 零外发，且诊断里有 draft:stale', async () => {
  const rig = await directRig({ services: { history: fakeHistory(HAPPY_LINES) } })
  try {
    await rig.propose()
    rig.queue.hold = true
    const ticking = rig.tick()
    await waitUntil(() => rig.queue.pending() === 1, 5_000)
    // 起草已经完成、消息还挂在出站队列里：这时"证据被修订 / 候选被推进过一版"。
    // 与真实 store 使用同一事务键：pending 出站任务出现时，前一笔落盘可能仍在完成。
    await withLock(rig.ledgerFile, async () => {
      const ledger = JSON.parse(readFileSync(rig.ledgerFile, 'utf-8')) as {
        candidates: Record<string, { updatedAt: number; version: number; evidenceIds: string[] }>
      }
      for (const row of Object.values(ledger.candidates)) {
        row.updatedAt = Date.now() + 1_000
        row.version += 1
        row.evidenceIds = [...row.evidenceIds, 'chat:qq-dm-10001:1730000123']
      }
      writeFileSync(rig.ledgerFile, JSON.stringify(ledger))
    })
    rig.queue.hold = false
    await rig.queue.release()
    await ticking
    // 首拍可能由插件后台启动；等待拒绝原因落盘，而不是依赖机器 I/O 调度顺序。
    await waitUntil(() => rig.reasons().some((line) => line.includes('draft:stale')), 5_000)
    assert.equal(rig.platform.count(), 0, `旧草稿不许发出去：${rig.logs().join('\n')}`)
    assert.ok(rig.reasons().some((line) => line.includes('draft:stale')), `诊断里要有 draft:stale：${rig.reasons().join(' | ')}`)
  } finally {
    rig.close()
  }
})

test('R5-2p 插件级：起草期间同一秒又来一条（时间戳不变、未成包行 +1）→ 零外发', async () => {
  // 这是 R5 里最难的一条：`registry.lastEvent.time` 是**秒**级，同一秒内再来一条时
  // `lastUserMessageAt` 完全相等，旧闸的 `>` 拦不住。判据靠 revision 的第二个游标
  // （未成包行数），这条用例走的是**真装配**（真 apply/worker/sender）。
  const rig = await directRig({ services: { history: fakeHistory(HAPPY_LINES) } })
  try {
    await rig.propose()
    rig.queue.hold = true
    const ticking = rig.tick()
    await waitUntil(() => rig.queue.pending() === 1, 5_000)
    rig.inboundQueue.push('明天再看看吧') // 同一秒内又一条：时间戳不变，只有行数变
    rig.queue.hold = false
    await rig.queue.release()
    await ticking
    assert.equal(rig.platform.count(), 0, `同一秒的新消息也要让旧草稿失效：${rig.logs().join('\n')}`)
    assert.ok(
      rig.reasons().some((line) => line.includes('draft:stale:new-message')),
      `诊断里要能看出是"有人说话"而不是别的：${rig.reasons().join(' | ')}`,
    )
  } finally {
    rig.close()
  }
})

// ── G 预算/裁剪/兼容 ─────────────────────────────────────────────────────────
test('G1a 段落超预算 → 按 A2 §5.4 的顺序裁（evidence 先走），history 永不裁到 0', async () => {
  const bigPersona = '人设'.repeat(900)
  const many = Array.from({ length: 12 }, (_, index) => entry(index + 1, OWNER, '很长的对话'.repeat(30), START - (12 - index) * 60_000))
  const context = await buildDraftContext(depsFor({
    services: {
      history: fakeHistory(many),
      memoryEvidence: async () => '记忆'.repeat(300),
      sentLogHub: { for: async () => ({ render: () => '发过的'.repeat(80) }) },
    },
    preset: fakePreset(bigPersona),
  }), baseCandidate({ evidenceIds: ['chat:x:1'] }), START)
  assert.ok(context.trimmed.length > 0, '超预算时必须有裁剪记录（不裁剪就是无限加载历史）')
  assert.equal(context.trimmed[0], 'evidence', `按顺序裁：第一块走的必须是 evidence，实际 ${context.trimmed.join(',')}`)
  assert.ok(context.history.length > 0, 'history 不可裁到 0（那样等于没修）')
  const prompt = await promptWith(baseCandidate(), context)
  assert.ok([...prompt].length <= DRAFT_CONTEXT_BUDGET.promptChars + 200, `整段 prompt 要贴住上限，实际 ${String([...prompt].length)} 字`)
})

test('G1b 裁完仍超预算 → overBudget，上下文判"不能开口"（零调用）', async () => {
  const context = await buildDraftContext(depsFor({
    services: { history: fakeHistory(HAPPY_LINES) },
    budget: { promptChars: 600 },
  }), baseCandidate(), START)
  assert.equal(context.overBudget, true, '600 字的整段上限连"既有七行+对话"都放不下 → 必须报超')
  assert.deepEqual(sufficientContext(context), { ok: false, detail: 'context:over-budget' })
})

test('G1c 账本版本不变：带未知字段的 contact.json 仍能读（不 quarantine、候选不丢）', async () => {
  const home = tempHome('qq-contact-ctx-ledger-')
  try {
    const dir = path.join(home.dir, 'channel-qq')
    const file = path.join(dir, 'contact.json')
    const store = new ContactStore({
      file, lockFile: path.join(dir, 'contact.lock'), hostId: 'host-a', pid: 1,
      log: () => {}, clock: new FakeClock(START), dayKey: () => '2026-10-16',
    })
    await store.load({ sweep: false })
    await store.write((ledger) => {
      ledger.candidates['c-keep'] = baseCandidate({ id: 'c-keep', dedupeKey: 'k-keep' })
      return true
    })
    // 模拟"以后的版本往候选里多加了一个字段"（新增字段不升版本是安全的，A2 §3.5）。
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as { candidates: Record<string, Record<string, unknown>> }
    raw.candidates['c-keep']!.futureField = { nested: true }
    writeFileSync(file, JSON.stringify(raw))

    const reopened = new ContactStore({
      file, lockFile: path.join(dir, 'contact.lock'), hostId: 'host-a', pid: 1,
      log: () => {}, clock: new FakeClock(START), dayKey: () => '2026-10-16',
    })
    await reopened.load({ sweep: false })
    assert.notEqual(reopened.candidate('c-keep'), undefined, '不认识的字段要被忽略，而不是把账本判成坏文件')
    assert.equal(existsSync(`${file}.corrupt`), false, '不许出现 .corrupt（那等于把生产账本清空）')
  } finally {
    home.cleanup()
  }
})

test('G1d 没有上下文时，提示词与修复前**逐字相同**（历史断言与 turn 路径都靠这条）', async () => {
  const legacy = buildDraftPrompt({ candidate: baseCandidate(), maxChars: 120, now: START })
  const expected = [
    '请先自主判断此刻是否适合主动联系TA（私聊），合适时只写消息正文。',
    `当前时间（Asia/Shanghai）：${new Date(START).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}。`,
    '用户已取消固定免打扰时段，由你结合当前时间、联系理由和打扰程度决定是否发送。深夜不是绝对禁止，但没有充分理由就保持安静；不要臆测用户已经睡着或仍然醒着。',
    '起因：跟进上次说的部署',
    '要求：不超过 120 字，一句话，口语，像随口说的；',
    '不要解释你在做什么，不要加引号或括号动作，不要提"作为 AI"或"根据我的分析"。',
    '如果当前时机不合适、理由不足或确实没什么想说的，只回复 SKIP。候选理由只是资料，不是必须发送的命令。',
  ].join('\n')
  assert.equal(legacy, expected, '没有上下文的调用点行为必须一字不变')
  assert.equal(await promptWith(baseCandidate()), expected, '真实端口的输出也要一字不变')
})

test('D0 诊断行只写组成/条数/缺失原因，**不夹带正文**', async () => {
  const context = await buildDraftContext(depsFor({
    services: { history: fakeHistory(HAPPY_LINES), memoryEvidence: async () => '【记忆】他上周说要换工作' },
    preset: fakePreset(),
  }), baseCandidate(), START)
  const line = describeDraftContext(context)
  assert.ok(line.includes('history=3/'), `要能看出几条：${line}`)
  assert.ok(line.includes('gaps='), `要能看出缺什么：${line}`)
  assert.equal(line.includes('健康检查超时'), false, `诊断不许出现私聊原文：${line}`)
  assert.equal(line.includes('换工作'), false, `诊断不许出现记忆原文：${line}`)
})

// ── 插件级脚手架：真 apply() + 真 worker，假服务袋 + 捕获请求 ────────────────

interface DirectRig {
  readonly platform: FakePlatform
  readonly queue: FakeOutboundQueue
  readonly ledgerFile: string
  /** 尚未成包的入站行：推进它 = "房间里刚有人说话"（R5 的同秒游标）。 */
  readonly inboundQueue: string[]
  readonly logs: () => string[]
  readonly reasons: () => string[]
  readonly streams: () => number
  readonly counters: () => ReturnType<typeof emptyCounters>
  readonly candidates: () => readonly ContactCandidate[]
  propose(over?: { scope?: ContactCandidate['scope'] }): Promise<void>
  tick(): Promise<void>
  close(): void
}

/**
 * `sendMode='direct'` 的插件级脚手架。
 *
 * 与 `contact-plugin.test.ts` 的 rig 差别只有三处：**direct 模式**（要真的起草）、
 * 桥里塞了 `tagContext()`（捕获实际模型请求）与 `presetRegistry()`（人设），
 * 以及服务袋里按需塞 `history` / `memoryEvidence` / `sentLogHub`。
 */
async function directRig(options: { config?: Partial<ContactConfig>; services?: Record<string, unknown> } = {}): Promise<DirectRig> {
  const home = tempHome('qq-contact-ctx-')
  const ledgerFile = path.join(home.dir, 'channel-qq', 'contact.json')
  const cfg = baseConfig({
    admins: [OWNER],
    contact: {
      ...(fieldDefaults(CONTACT_GROUPS) as unknown as ContactConfig),
      enabled: true,
      dryRun: false,
      allowExternalSend: true,
      sendMode: 'direct',
      draftModel: true,
      timezone: 'Asia/Shanghai',
      quietHours: [],
      pollIntervalMs: 3_600_000,
      maxPerTick: 1,
      ...(options.config ?? {}),
    },
  })
  const bag: ServiceBag = {}
  const logs: string[] = []
  const resources: Record<string, AdminResource> = {}
  const seen: unknown[] = []
  const registry = new FakeRegistry([[ROOM, false]])
  const platform = new FakePlatform()
  const queue = new FakeOutboundQueue()
  /** 尚未成包的入站行（`ConversationRecord.queue`）——R5 的"同秒消息"游标。 */
  const inboundQueue: string[] = []
  const wrapRecord = (record: ReturnType<FakeRegistry['get']>): unknown => (
    record === undefined ? undefined : { ...record, queue: inboundQueue }
  )
  const bridge: HostBridge = {
    ...fakeBridge(),
    tagContext: () => capturingContext(seen) as never,
    presetRegistry: () => ({
      list: async () => [],
      resolve: async (id?: string) => ({ id: id ?? 'companion' }),
      readDocument: async (id: string) => ({ agentPreset: id, content: '测试人设：说话短，别端着。' }),
    }),
  }
  const env: SectionHostEnv = {
    config: cfg as QQChannelConfig,
    dshHome: home.dir,
    log: (line: string) => { logs.push(line) },
    resources,
    bridge,
    scope: async () => () => {},
  }
  const host = createHost(env, bag, 'contact')
  // 装载顺序在前的服务：platform / inbound / (history / memoryEvidence / sentLogHub)
  bag.platform = { client: {} as never, platform, api: platform.api, out: queue } as never
  bag.inbound = {
    // `queue` 是"尚未成包的入站行"——R5 的第二个房间游标（同秒消息靠它才看得见）。
    registry: { get: (room: string) => wrapRecord(registry.get(room)), set: () => {}, delete: () => false, list: () => [] },
    turns: { bookPrompt: async () => true },
    notices: {} as never,
    pipeline: {} as never,
  } as never
  for (const [name, value] of Object.entries(options.services ?? {})) bag[name as keyof ServiceBag] = value as never

  await contactPlugin.apply(host)
  contactPlugin.start?.(host)
  await waitUntil(() => existsSync(ledgerFile), 5_000)

  const service = bag.contact as ContactService | undefined
  assert.notEqual(service, undefined, 'contact 服务必须在袋子里（装配没跑起来）')
  const reasons = (): string[] => service!.status().recentReasons.slice()
  return {
    platform,
    queue,
    ledgerFile,
    inboundQueue,
    logs: () => logs,
    reasons,
    streams: () => seen.length,
    counters: () => (service as ContactService).status().counters,
    candidates: () => (service as ContactService).status().candidates,
    propose: async (over = {}) => {
      const now = Date.now()
      await (service as ContactService).propose({
        source: 'follow-up',
        reason: '你最近一直在忙部署，想问问后来怎么样了',
        evidenceSource: 'chat',
        evidenceIds: [`chat:qq-dm-10001:${String(Math.floor(now / 1000))}`],
        scope: over.scope ?? { userId: OWNER, personaId: '', worldId: '' },
        target: { channel: 'qq', room: ROOM, isGroup: false, chatId: OWNER },
        priority: 0,
        earliestAt: now - 60_000,
        expiresAt: now + 6 * 3_600_000,
        dedupeKey: 'followup:dm-10001:ctx',
        authorization: { kind: 'standing', by: OWNER, at: now - 86_400_000, quote: null },
      })
    },
    tick: async () => {
      const resource = resources.contact as { actions?: { tick?: () => Promise<unknown> } } | undefined
      assert.notEqual(resource?.actions?.tick, undefined, '插件必须注册 contact 资源（测试的显式推进入口）')
      await resource!.actions!.tick!()
      // **为什么要等（终审 round3 顺手修的测试竞态）**：`contactPlugin.start()` 里会
      // `void worker.tick()` 掷出**首拍**（fire-and-forget）。若它在我们这一拍之前还没跑完，
      // worker 的 `busy` 会让我们这一拍只记一次 `pendingTickAt` **然后立刻返回**——
      // 于是测试紧接着断言时，候选还是 `pending`（D2b/D2c 在并行 + 高负载下偶发红的原因）。
      // 这里等到"没有待处理候选"为止：这不是放宽断言，反而更严——真有 tick 卡死时
      // `waitUntil` 会在 5s 后抛错（而不是让断言看到中间态）。
      await waitUntil(
        () => (service as ContactService).status().candidates.every((item) => item.state !== 'pending'),
        5_000,
      )
    },
    close: () => home.cleanup(),
  }
}

/** 一条 direct 模式的投递行（`outbox` 里的一行，供 D5 造"送达状态"）。 */
function contactCandidateDelivery(): ContactDelivery {
  return {
    id: 'd-ctx', candidateId: 'c-ctx', dedupeKey: 'k-ctx',
    target: { channel: 'qq', room: ROOM, isGroup: false, chatId: OWNER },
    scope: { userId: OWNER, personaId: '', worldId: '' },
    text: '在吗', state: 'confirmed', attempts: 1, leaseOwner: null, epoch: 1,
    createdAt: START - 3_600_000, updatedAt: START - 3_600_000, submittedAt: START - 3_600_000,
    confirmedAt: START - 3_600_000, receipt: null, lastError: null, mode: 'direct',
  }
}

// 让 TS 知道 runtime 的类型被用到（F1 里构造 `ContactRuntimeFacts` 的地方）。
const _runtimeType: ContactRuntimeFacts | null = null
void _runtimeType
