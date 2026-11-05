/** **P1 顺序回归**（Codex 增量复审）：异步复核必须在盘上租约复核**之前**，
 *  而 `sendTo` 之前的最后一步必须是**同步、零 await** 的 `finalSyncGuard`
 *  （所有权三连 + 版本戳 + 本地判据）。
 *
 * 这个文件只用"发了几条"和"调用顺序"作判据（`platform.count()` 与一条顺序日志），
 * 不看内部字段：顺序错了一行日志就能看出来，拦没拦住只要数一下发了没有。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ContactConfig } from '../src/config/sections/contact.js'
import type { ContactDelivery, ContactLease, ContactRuntimeFacts } from '../src/features/contact/types.js'
import type { ContactGuardVerdict, ContactSendRequest } from '../src/features/contact/sender.js'
import type { ContactLiveSnapshot } from '../src/features/contact/sender.js'
import type { DraftRevision } from '../src/features/contact/draft-context.js'
import {
  FakeClock, FakeOutboundQueue, FakePlatform, contactCandidate, contactDelivery, contactRuntime, fieldDefaults,
} from './fakes/contact.js'
import { CONTACT_GROUPS } from '../src/config/sections/contact.js'
import { ContactSender } from '../src/features/contact/sender.js'
import { emptyCounters } from '../src/features/contact/types.js'
import { freezeRevision } from '../src/features/contact/draft-freshness.js'
import { finalSyncGuard } from '../src/features/contact/precheck.js'

const START = Date.UTC(2026, 9, 16, 14, 0, 0)
const ROOM = 'dm-10001'
const OWNER = 10001
const IDENTITY = { personaId: 'nono', worldId: '' }
const LAST_USER = START - 600_000
const OWNER_TAG = 'host-a#4242'

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

function candidate(over: Partial<Parameters<typeof contactCandidate>[0]> = {}): ReturnType<typeof contactCandidate> {
  return contactCandidate({
    id: 'c-lease', dedupeKey: 'k-lease', version: 3, updatedAt: START - 60_000,
    earliestAt: START - 60_000, expiresAt: START + 3_600_000,
    authorization: { kind: 'standing', by: OWNER, at: START - 86_400_000, quote: null },
    ...over,
  })
}

const OBSERVED = { persona: '测试人设：说话短。', history: [{ at: LAST_USER, text: '健康检查超时了' }] }

function revisionOf(): DraftRevision {
  return freezeRevision(candidate(), OBSERVED, { lastUserMessageAt: LAST_USER, queueDepth: 0 })
}

function runtimeOf(): ContactRuntimeFacts {
  return contactRuntime({
    lastUserMessageAtByRoom: { [ROOM]: LAST_USER },
    queueDepthByRoom: { [ROOM]: 0 },
    turnRunningByRoom: { [ROOM]: false },
    connected: true,
    roomBound: true,
  })
}

/** 领到租约的那条投递（epoch/owner 与下面的 lease 一致）。 */
function runningDelivery(over: Partial<ContactDelivery> = {}): ContactDelivery {
  return { ...contactDelivery(), id: 'd-lease', candidateId: 'c-lease', state: 'running', epoch: 7, leaseOwner: OWNER_TAG, mode: 'direct', ...over }
}

function request(over: { delivery?: ContactDelivery; revision?: DraftRevision; text?: string } = {}): ContactSendRequest {
  const revision = over.revision
  return {
    delivery: over.delivery ?? runningDelivery(),
    candidate: candidate(),
    text: over.text ?? '在的，健康检查那事后来怎么样了',
    now: START,
    draftedAt: START,
    runtime: runtimeOf(),
    ...(revision === undefined ? {} : { revision }),
  }
}

interface RigOptions {
  /** 在 `verifyDraft` 的 await 窗口里做点什么（模拟"接管/修订恰好发生在这时"）。 */
  readonly duringVerify?: () => void
  /** 直发的最终闸依赖（所有权三连用它）。 */
  readonly attachOwnership?: boolean
  /** 这条路径是否要求带冻结版本（生产上 = `sendMode === 'direct'`；turn 为 false）。 */
  readonly requireRevision?: boolean
}

interface Rig {
  readonly sender: ContactSender
  readonly platform: FakePlatform
  readonly order: string[]
  readonly lease: { current: ContactLease | null }
  readonly row: { current: ContactDelivery | undefined }
  /** 当下"盘上"的候选版本（模拟执行点读到的那一版）。 */
  readonly version: { current: number }
}

/** 真 `ContactSender` + 假平台 + 一条可观察的顺序日志（零网络、零模型、零磁盘）。 */
function rig(options: RigOptions = {}): Rig {
  const platform = new FakePlatform()
  const queue = new FakeOutboundQueue()
  const order: string[] = []
  const lease: { current: ContactLease | null } = {
    current: { hostId: 'host-a', pid: 4242, epoch: 7, acquiredAt: START - 1_000, expiresAt: START + 60_000 },
  }
  const row: { current: ContactDelivery | undefined } = { current: runningDelivery() }
  const version: { current: number } = { current: 3 }
  const snapshot: ContactLiveSnapshot = {
    verdict: null,
    facts: {
      candidate: candidate(),
      runtime: runtimeOf(),
      counters: emptyCounters('2026-10-16'),
      deliveredDedupeKeys: [],
    },
  }
  const sender = new ContactSender({
    log: () => {},
    clock: new FakeClock(START),
    transport: () => ({ connected: true, out: queue, api: platform.api }),
    turns: () => ({ bookPrompt: async () => { order.push('book'); return true } }),
    identity: () => IDENTITY,
    // 故意**不注入** `config`：让 `deliver()` 传进来的那份配置说了算（turn 用例要能切模式）。
    refresh: () => ({
      // 每次现取都返回**当下**的那一版（用例通过 `version` 模拟"候选被修订"）。
      candidate: candidate({ version: version.current }),
      runtime: runtimeOf(),
    }),
    liveSnapshot: async () => {
      order.push('snapshot') // 真实实现里这一步的最后一次 await 就是 assertLease
      return snapshot
    },
    verifyDraft: async () => {
      order.push('verify')
      // 真实实现要读文件/缓存，这里用一个微任务让出控制权（足以让顺序错位的实现露出来）。
      await Promise.resolve()
      order.push('verify-done')
      options.duringVerify?.()
      return null as ContactGuardVerdict | null
    },
    requireDraftRevision: () => options.requireRevision !== false,
    ...(options.attachOwnership === false ? {} : { lease: () => lease.current, deliveryRow: (id: string) => (row.current?.id === id ? row.current : undefined) }),
    timeoutMs: 30_000,
  })
  return { sender, platform, order, lease, row, version }
}

// ── 顺序不变式 ──────────────────────────────────────────────────────────────

test('L1 顺序：异步复核(`verify`)必须在读盘+租约断言(`snapshot`)之前，之后只有同步闸与发送', async () => {
  const r = rig()
  const result = await r.sender.deliver(request({ revision: revisionOf() }), config())
  assert.equal(result.state, 'confirmed', `对照组要发得出去：${JSON.stringify(result)}`)
  assert.equal(r.platform.count(), 1)
  const verify = r.order.indexOf('verify-done')
  const snapshot = r.order.indexOf('snapshot')
  assert.ok(verify >= 0, `异步复核必须真的跑过：${r.order.join(' → ')}`)
  assert.ok(snapshot > verify, `异步复核必须**先于**租约断言（R5 第一版的顺序回归就在这里）：${r.order.join(' → ')}`)
})

// ── 零外发：await 窗口里租约失效 ─────────────────────────────────────────────

test('L2 await 窗口里租约过期（旧实例仍持有内存租约）→ 同步闸拦下，零外发', async () => {
  let r: Rig
  r = rig({
    duringVerify: () => {
      // 接管发生在这段窗口里：锁文件上的租约已经过期，但**内存里**我这一份还在。
      r.lease.current = { hostId: 'host-a', pid: 4242, epoch: 7, acquiredAt: START - 1_000, expiresAt: START }
    },
  })
  const result = await r.sender.deliver(request({ revision: revisionOf() }), config())
  assert.equal(r.platform.count(), 0, `租约过期之后一条都不许发：${JSON.stringify(result)}`)
  assert.equal(result.state, 'deferred')
  assert.equal(result.detail, 'lease-expired', `要能解释清楚是"租约过期"，实际 ${String(result.detail)}`)
})

test('L3 await 窗口里租约被同进程新代次取代（epoch 变了）→ 零外发', async () => {
  let r: Rig
  r = rig({
    duringVerify: () => {
      r.lease.current = { hostId: 'host-a', pid: 4242, epoch: 8, acquiredAt: START, expiresAt: START + 60_000 }
    },
  })
  const result = await r.sender.deliver(request({ revision: revisionOf() }), config())
  assert.equal(result.detail, 'lease-epoch-changed')
  assert.equal(r.platform.count(), 0)
})

test('L4 await 窗口里投递行被别人改过（不再是 running）→ 零外发', async () => {
  let r: Rig
  r = rig({
    duringVerify: () => {
      r.row.current = runningDelivery({ state: 'unknown', leaseOwner: 'host-b#9' })
    },
  })
  const result = await r.sender.deliver(request({ revision: revisionOf() }), config())
  assert.equal(r.platform.count(), 0, `别人已经接手这条投递了就绝不能发：${JSON.stringify(result)}`)
  assert.equal(result.detail, 'delivery:unknown')
})

test('L5 await 窗口里候选被修订（version+1）→ 同步新鲜度闸拦下，零外发', async () => {
  let r: Rig
  r = rig({
    duringVerify: () => {
      // 候选被 patch 过一版：`refresh` 下次现取会看到 version 4（冻结的是 3）。
      r.version.current = 4
    },
  })
  const result = await r.sender.deliver(request({ revision: revisionOf() }), config())
  assert.equal(r.platform.count(), 0, `起草之后候选变了就不许发：${JSON.stringify(result)}`)
  assert.ok(String(result.detail).startsWith('draft:stale'), `原因要指向草稿过期，实际 ${String(result.detail)}`)
})

// ── 对照组：什么都没变 → 恰好一条 ───────────────────────────────────────────

test('L6 对照组：异步复核耗时但世界没变 → 恰好 1 次 sendTo', async () => {
  const r = rig()
  const result = await r.sender.deliver(request({ revision: revisionOf() }), config())
  assert.equal(result.state, 'confirmed', JSON.stringify(result))
  assert.equal(r.platform.count(), 1, '对照组：不多不少一条（防止用"全拦"骗过测试）')
  assert.deepEqual(r.platform.textsTo(OWNER), ['在的，健康检查那事后来怎么样了'])
})

// ── direct 缺 revision / turn 的边界 ────────────────────────────────────────

test('L7 最后同步闸也要求 direct 带 revision（补上漏传的 requireDraftRevision）', () => {
  const lease: ContactLease = { hostId: 'host-a', pid: 4242, epoch: 7, acquiredAt: START, expiresAt: START + 60_000 }
  const deps = {
    identity: () => IDENTITY,
    transport: () => ({ connected: true, out: new FakeOutboundQueue(), api: new FakePlatform().api }),
    turns: () => ({ bookPrompt: async () => true }),
    requireDraftRevision: () => true,
    nowMs: () => START,
    liveConfig: () => config(),
    refresh: () => ({ candidate: candidate(), runtime: runtimeOf() }),
    lease: () => lease,
    deliveryRow: (id: string) => (id === 'd-lease' ? runningDelivery() : undefined),
    draftAttested: () => true,
  }
  // 没有 revision → 最后一道闸也必须拒绝（修复前这里会放行，因为 deps 里漏传了这个开关）。
  assert.deepEqual(finalSyncGuard(request(), config(), deps), { state: 'deferred', detail: 'draft:stale:unverifiable' })
  // 有 revision 但异步复核没打戳（有人删了那次调用）→ 同样拒绝，不许静默退回"只比时间戳"。
  assert.deepEqual(
    finalSyncGuard(request({ revision: revisionOf() }), config(), { ...deps, draftAttested: () => false }),
    { state: 'deferred', detail: 'draft:stale:unverified' },
  )
  // 都齐了 → 放行（否则 L6 的对照组也就没意义了）。
  assert.equal(finalSyncGuard(request({ revision: revisionOf() }), config(), deps), null)
})

test('L8 turn 路径没有 revision，行为与注释一致：不假装能保证正文新鲜度', async () => {
  // 生产上 `requireDraftRevision = (sendMode === 'direct')`：turn 走 false，于是"没有 revision"
  // 不会把它拦死；代价是这一路**只能**保证"提交前状态没变"，正文新鲜度交给回合。
  const turnRig = rig({ requireRevision: false })
  const result = await turnRig.sender.deliver(request({ delivery: runningDelivery({ mode: 'turn' }) }), config({ sendMode: 'turn' }))
  // turn 只能到 `submitted`（没有平台回执），提交动作本身仍然发生一次。
  assert.equal(result.state, 'submitted', JSON.stringify(result))
  assert.equal(result.detail, 'turn-submitted')
  assert.equal(turnRig.order.filter((step) => step === 'book').length, 1)
  assert.equal(turnRig.platform.count(), 0, 'turn 路径不经 sendTo（正文由回合生成）')
})
