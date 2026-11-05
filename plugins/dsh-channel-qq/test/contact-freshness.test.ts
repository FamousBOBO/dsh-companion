/** **R5 版本闸**（Codex 预发布审查 P1）：新鲜度不能只有两个时间戳比较。
 *
 * 审查指出的四个漏网场景，全都不是"时间更大"能表达的，所以这里的每条用例都贴着
 * 一个具体场景：同毫秒 patch / 同秒入站 / 会话重绑 / 人设或证据正文修订；外加一条
 * **对照组**证明"什么都没变时恰好发一条"（防止用"全拦"骗过测试）。
 *
 * 判据本体：`draft-freshness.compareRevision`（同步，进 `precheck.verdictOf` →
 * `finalSyncGuard`）与 `createRevisionVerifier`（异步，进 `sender.recheckAtSend`）。
 * 断言一律落在"这条请求**发不发得出去**"（`platform.count()`），不看内部字段。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ContactConfig } from '../src/config/sections/contact.js'
import type { ContactCandidate } from '../src/features/contact/types.js'
import type { ContactRuntimeFacts } from '../src/features/contact/types.js'
import type { ContactSendRequest } from '../src/features/contact/sender.js'
import type { DraftContextDeps, DraftRevision } from '../src/features/contact/draft-context.js'
import { FakeClock, FakeOutboundQueue, FakePlatform, contactCandidate, contactDelivery, contactRuntime, fieldDefaults } from './fakes/contact.js'
import { CONTACT_GROUPS } from '../src/config/sections/contact.js'
import { ContactSender } from '../src/features/contact/sender.js'
import { emptyCounters } from '../src/features/contact/types.js'
import { compareRevision, createRevisionVerifier, freezeRevision } from '../src/features/contact/draft-freshness.js'
import { freshnessIssue, verdictOf } from '../src/features/contact/precheck.js'

const START = Date.UTC(2026, 9, 16, 14, 0, 0)
const ROOM = 'dm-10001'
const OWNER = 10001
const IDENTITY = { personaId: 'nono', worldId: '' }
/** 10 分钟前说过话：超过 `settleWindowMs` 的默认 2 分钟，于是"用户在场窗"这一道不参与拦截。 */
const LAST_USER = START - 600_000

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

/** 起草那一刻的候选（版本 3）。 */
function candidate(over: Partial<ContactCandidate> = {}): ContactCandidate {
  return contactCandidate({
    id: 'c-rev', dedupeKey: 'k-rev', version: 3, updatedAt: START - 60_000,
    earliestAt: 0, expiresAt: START + 3_600_000,
    authorization: { kind: 'standing', by: OWNER, at: START - 86_400_000, quote: null },
    ...over,
  })
}

const OBSERVED = {
  persona: '测试人设A：说话短。',
  history: [{ id: 'qq:1', at: LAST_USER, text: 'upstream 起来了，但健康检查超时' }],
}
const FACTS = { lastUserMessageAt: LAST_USER, queueDepth: 0 }

/** 在 `START` 那一刻冻结出来的 revision。 */
function frozenRevision(over: { persona?: string | null; history?: { at: number; text: string }[]; facts?: typeof FACTS } = {}): DraftRevision {
  return freezeRevision(
    candidate(),
    { persona: over.persona === undefined ? OBSERVED.persona : over.persona, history: over.history ?? OBSERVED.history },
    over.facts ?? FACTS,
  )
}

function runtimeOf(over: { lastUserAt?: number | null; queueDepth?: number | null } = {}): ContactRuntimeFacts {
  return contactRuntime({
    lastUserMessageAtByRoom: { [ROOM]: over.lastUserAt === undefined ? LAST_USER : over.lastUserAt },
    queueDepthByRoom: { [ROOM]: over.queueDepth === undefined ? 0 : over.queueDepth },
    turnRunningByRoom: { [ROOM]: false },
  })
}

/** 一条"版本与此刻世界完全一致"的投递请求。 */
function request(over: { revision?: DraftRevision; draftedAt?: number; runtime?: ContactRuntimeFacts } = {}): ContactSendRequest {
  const rev = over.revision
  return {
    delivery: { ...contactDelivery(), candidateId: 'c-rev', updatedAt: START, state: 'running' },
    candidate: candidate(),
    text: '在的，健康检查那事后来怎么样了',
    now: START,
    draftedAt: over.draftedAt ?? START,
    runtime: over.runtime ?? runtimeOf(),
    ...(rev === undefined ? {} : { revision: rev }),
  }
}

/** 复核依赖：人设与历史都由用例决定（只读窄面，不碰真库/真模型）。 */
function depsOf(over: { persona?: string | null; history?: { at: number; text: string }[] } = {}): DraftContextDeps {
  const rows = over.history ?? OBSERVED.history
  return {
    get: (name: string) => (name === 'history'
      ? { search: async () => rows.map((row, index) => ({ id: index + 1, userId: OWNER, name: '主人', text: row.text, time: Math.floor(row.at / 1000) })), collect: async () => 0 }
      : undefined),
    preset: () => ({
      readDocument: async () => ({
        content: over.persona === undefined ? (OBSERVED.persona ?? '') : (over.persona ?? ''),
      }),
    }),
    config: () => config(),
    deliveries: () => [],
    counters: () => emptyCounters('2026-10-16'),
    roomFacts: () => ({ connected: true, roomBound: true, turnRunning: false, lastUserMessageAt: LAST_USER, queueDepth: 0 }),
    clock: new FakeClock(START),
    log: () => {},
  }
}

// ── 四条"时间戳看不出来"的场景 ──────────────────────────────────────────────

test('R5-1 同毫秒 patch（updatedAt 一模一样，只是 version+1）→ draft:stale:version，零外发', async () => {
  const rev = frozenRevision()
  const patched = candidate({ version: 4, updatedAt: rev.candidateUpdatedAt })
  const req = request({ revision: rev })
  assert.deepEqual(
    compareRevision({ ...req, candidate: patched }, patched, req.runtime),
    { state: 'deferred', detail: 'draft:stale:version' },
    '旧闸比的是 `updatedAt > draftedAt`：同一毫秒里改过就看不出来，version 才认得出来',
  )
  // 走到真实发送器上：一条都不许出门（`current` = 执行点从盘上读到的那一版）。
  const rig = senderRig({ current: patched })
  assert.equal((await rig.sender.deliver(req, config())).state, 'deferred')
  assert.equal(rig.platform.count(), 0, `同毫秒 patch 之后不许发：${rig.logs.join('\n')}`)
})

test('R5-2 同秒入站（时间戳相等、队列从 0 变成 1）→ draft:stale:new-message', async () => {
  const rev = frozenRevision()
  const req = request({ revision: rev, runtime: runtimeOf({ lastUserAt: LAST_USER, queueDepth: 1 }) })
  assert.deepEqual(
    compareRevision(req, req.candidate, req.runtime),
    { state: 'deferred', detail: 'draft:stale:new-message' },
    '`registry.lastEvent.time` 是秒级：同一秒里又来一条时时间戳相等，只能靠未成包行数',
  )
  const rig = senderRig({ runtime: runtimeOf({ lastUserAt: LAST_USER, queueDepth: 1 }) })
  assert.equal((await rig.sender.deliver(req, config())).state, 'deferred')
  assert.equal(rig.platform.count(), 0)
})

test('R5-3 会话/绑定重绑（人格变了）→ draft:stale:binding', async () => {
  const rev = freezeRevision(candidate({ scope: { userId: OWNER, personaId: 'other', worldId: '' } }), OBSERVED, FACTS)
  const req = request({ revision: rev })
  assert.deepEqual(compareRevision(req, req.candidate, req.runtime), { state: 'deferred', detail: 'draft:stale:binding' })
  const rig = senderRig()
  assert.equal((await rig.sender.deliver(req, config())).state, 'deferred')
  assert.equal(rig.platform.count(), 0, '换了一段会话就不许把旧问候插进去')
})

test('R5-4 人设被改了 → 异步复核抓得到（draft:stale:persona），零外发', async () => {
  const rev = frozenRevision()
  const verify = createRevisionVerifier(depsOf({ persona: '测试人设B：话很多，喜欢用表情。' }))
  const verdict = await verify(request({ revision: rev }))
  assert.deepEqual(verdict, { state: 'deferred', detail: 'draft:stale:persona' })
  const rig = senderRig({ verifyDraft: verify })
  assert.equal((await rig.sender.deliver(request({ revision: rev }), config())).state, 'deferred')
  assert.equal(rig.platform.count(), 0)
})

test('R5-5 证据/对话正文被修订（尾条内容变了）→ draft:stale:history，零外发', async () => {
  const rev = frozenRevision()
  const verify = createRevisionVerifier(depsOf({ history: [{ at: LAST_USER, text: '不用了，我已经自己修好了' }] }))
  assert.deepEqual(await verify(request({ revision: rev })), { state: 'deferred', detail: 'draft:stale:history' })
  const rig = senderRig({ verifyDraft: verify })
  assert.equal((await rig.sender.deliver(request({ revision: rev }), config())).state, 'deferred')
  assert.equal(rig.platform.count(), 0, '上次说的问题已经解决了，就别再按旧草稿问一遍')
})

// ── 保守口径：无法比较 ≠ 放行 ───────────────────────────────────────────────

test('R5-6 冻结版本缺失 / 关键字段为空 → draft:stale:unverifiable（拒绝，不是放行）', async () => {
  const noRevision = request()
  assert.deepEqual(
    freshnessIssue(noRevision, noRevision.candidate, noRevision.runtime, true),
    { state: 'deferred', detail: 'draft:stale:unverifiable' },
    '`direct` 装配要求带 revision：漏接时必须当场拒绝',
  )
  // `turn` 模式/历史用例没有上下文，按老口径判（两个时间戳），不因此变成"永远不发"。
  assert.equal(freshnessIssue(noRevision, noRevision.candidate, noRevision.runtime, false), null)
  const emptyDigest = freezeRevision(candidate(), { persona: null, history: OBSERVED.history }, FACTS)
  assert.equal(emptyDigest.personaDigest, '', '起草时没读到人设 = 空哨兵')
  assert.deepEqual(
    compareRevision(request({ revision: emptyDigest }), candidate(), runtimeOf()),
    { state: 'deferred', detail: 'draft:stale:unverifiable' },
  )
})

test('R5-7 requireDraftRevision=true 且没有 revision → 发送器一次都不发', async () => {
  const rig = senderRig()
  const result = await rig.sender.deliver(request(), config())
  assert.equal(result.state, 'deferred', `缺失版本必须被拦下：${JSON.stringify(result)}`)
  assert.equal(rig.platform.count(), 0)
  assert.ok(rig.logs.some((line) => line.includes('draft:stale:unverifiable')), rig.logs.join('\n'))
})

// ── 对照组：世界没变 → 恰好一条 ─────────────────────────────────────────────

test('R5-8 对照组：版本与人设历史全都没变 → 恰好吃 1 次 sendTo（且经 finalSyncGuard）', async () => {
  const rev = frozenRevision()
  const rig = senderRig()
  const result = await rig.sender.deliver(request({ revision: rev }), config())
  assert.equal(result.state, 'confirmed', `一切都没变就必须发得出去：${JSON.stringify(result)}\n${rig.logs.join('\n')}`)
  assert.equal(rig.platform.count(), 1, '对照组：不多不少一条')
  assert.deepEqual(rig.platform.textsTo(OWNER), ['在的，健康检查那事后来怎么样了'])
})

test('R5-9 同步闸仍然在最后一道：verdictOf 与 finalSyncGuard 用的是同一份判据', () => {
  const rev = frozenRevision()
  const req = request({ revision: rev })
  const deps = {
    identity: () => IDENTITY,
    transport: () => ({ connected: true, out: new FakeOutboundQueue(), api: new FakePlatform().api }),
    turns: () => ({ bookPrompt: async () => true }),
    requireDraftRevision: () => true,
  }
  // 候选被换了一版（模拟执行点读到的盘上事实）
  const patched = candidate({ version: 9 })
  const verdict = verdictOf({ ...req, candidate: patched }, config(), deps)
  assert.equal(verdict?.detail, 'draft:stale:version', `同步闸必须判出过期：${String(verdict?.detail)}`)
  assert.equal(verdictOf(req, config(), deps), null, '什么都没变时同步闸不拦（否则对照组也没意义）')
})

// ── 发送器脚手架（真 `ContactSender` + 假平台，零网络零模型） ─────────────────

interface SenderRig {
  readonly sender: ContactSender
  readonly platform: FakePlatform
  readonly logs: string[]
}

function senderRig(over: {
  verifyDraft?: ReturnType<typeof createRevisionVerifier>
  /** "此刻账本里/房间里"的样子（默认 = 与冻结时完全一致）。 */
  current?: ContactCandidate
  runtime?: ContactRuntimeFacts
} = {}): SenderRig {
  const platform = new FakePlatform()
  const queue = new FakeOutboundQueue()
  const logs: string[] = []
  const sender = new ContactSender({
    log: (line: string) => { logs.push(line) },
    clock: new FakeClock(START),
    transport: () => ({ connected: true, out: queue, api: platform.api }),
    turns: () => ({ bookPrompt: async () => true }),
    identity: () => IDENTITY,
    // `deliver()` 会先 `refresh()`：这就是"执行点看到的盘上事实"，用例通过它模拟世界变化。
    refresh: () => ({ candidate: over.current ?? candidate(), runtime: over.runtime ?? runtimeOf() }),
    timeoutMs: 30_000,
    // R5：`direct` 装配要求带冻结版本；缺失 = 拒绝。
    requireDraftRevision: () => true,
    verifyDraft: over.verifyDraft ?? createRevisionVerifier(depsOf()),
  })
  return { sender, platform, logs }
}
