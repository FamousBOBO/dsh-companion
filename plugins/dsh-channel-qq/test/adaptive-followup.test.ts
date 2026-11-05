import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import * as path from 'node:path'
import { readFileSync } from 'node:fs'
import { ContactStore } from '../src/features/contact/store.js'
import { ContactSender } from '../src/features/contact/sender.js'
import { ContactWorker } from '../src/features/contact/worker.js'
import { defaultContactConfig } from '../src/config/sections/contact.js'
import type { ContactCandidate } from '../src/features/contact/types.js'
import type { DraftContext } from '../src/features/contact/draft-context.js'
import { historyCursorOf } from '../src/features/contact/draft-freshness.js'
import { normalizeCandidate } from '../src/features/contact/ledger.js'
import { parseAdaptiveDecision } from '../src/features/contact/adaptive-intent.js'
import { adaptivePrompt, createAdaptiveDecisionPort, type AdaptiveAttempt, type AdaptiveRequest } from '../src/features/contact/adaptive-host.js'
import { FakeClock, FakePlatform, contactCandidate, contactRuntime, tempHome } from './fakes/contact.js'

const T0 = Date.UTC(2026, 10, 3, 5, 10)
async function rig(t: TestContext, decision: (request: AdaptiveRequest) => Promise<AdaptiveAttempt>, options: { budget?: number; ordinary?: boolean } = {}) {
  const home = tempHome('qq-adaptive-'), clock = new FakeClock(T0), logs: string[] = [], platform = new FakePlatform()
  const config = { ...defaultContactConfig(), enabled: true, dryRun: false, allowExternalSend: true, sendMode: 'turn' as const,
    timezone: 'Asia/Shanghai', quietHours: [], allowedRooms: ['dm-10001'], draftModel: false,
    ...(options.budget === undefined ? {} : { draftDailyBudget: options.budget }) }
  const file = path.join(home.dir, 'contact.json')
  const store = new ContactStore({ file, lockFile: path.join(home.dir, 'contact.lock'), clock, log: line => logs.push(line),
    hostId: 'adaptive-test', pid: 101, dayKey: () => '2026-11-03' })
  await store.load()
  const row = contactCandidate({ id: 'c-adaptive', reason: '确认午饭是否还需要关心', source: 'follow-up',
    evidenceSource: options.ordinary ? 'chatlog' : 'planned-followup', createdAt: T0 - 3_600_000, updatedAt: T0 - 3_600_000,
    earliestAt: T0 - 1, expiresAt: T0 + 3_600_000, scope: { userId: 10001, personaId: 'companion', worldId: '' },
    target: { channel: 'qq', room: 'dm-10001', chatId: 10001, isGroup: false },
    ...(options.ordinary ? {} : { intent: { schemaVersion: 1 as const, purpose: '如果还没有聊到午饭，关心是否吃饭', originSessionId: 'qq-dm-10001', evaluations: 0 } }) })
  await store.putCandidate(row)
  let bookings = 0, calls = 0, message = { id: 'qq:77', who: 'user' as const, text: '我已经吃过午饭了', at: T0 - 600_000, speaker: '主人' }
  let contextMissing = false
  const facts = () => ({ connected: true, roomBound: true, turnRunning: false, lastUserMessageAt: message.at, queueDepth: 0 })
  const runtime = () => contactRuntime({ lastUserMessageAtByRoom: { 'dm-10001': message.at }, queueDepthByRoom: { 'dm-10001': 0 } })
  const source = { build: async (candidate: ContactCandidate): Promise<DraftContext> => ({
    persona: { personaId: 'companion', document: '三月七', truncated: false }, history: contextMissing ? [] : [{ ...message }],
    memory: null, pending: [], evidence: [], outbound: [], sentBlock: null, unansweredStreak: 0,
    clock: { tz: 'Asia/Shanghai', tzLabel: 'Asia/Shanghai', dayKey: '2026-11-03', hhmm: '13:10', minutes: 790, period: '下午' },
    revision: { candidateVersion: candidate.version, candidateUpdatedAt: candidate.updatedAt, lastUserAt: message.at,
      binding: { room: 'dm-10001', chatId: 10001, isGroup: false, personaId: 'companion', worldId: '' },
      roomCursor: { lastUserAt: message.at, queueDepth: 0 }, personaDigest: 'persona-ok', historyCursor: historyCursorOf([message]) },
    gaps: [], sections: [], trimmed: [], overBudget: false,
  }) }
  const sender = new ContactSender({ clock, log: line => logs.push(line),
    identity: () => ({ personaId: 'companion', worldId: '' }),
    refresh: id => ({ candidate: store.candidate(id), runtime: runtime() }),
    transport: () => ({ connected: true, api: platform.api, out: { push: async task => await task() } }),
    turns: () => ({ bookPrompt: async () => { bookings++; return true } }),
  })
  const worker = new ContactWorker({ store, clock, sender, log: line => logs.push(line), config: () => config,
    roomFacts: facts, identity: () => ({ personaId: 'companion', worldId: '' }), draftContext: source,
    adaptivePort: { decide: async request => { calls++; return await decision(request) } },
  })
  t.after(async () => { await worker.dispose(); await store.releaseLease(); home.cleanup() })
  return { worker, store, clock, file, platform, logs, config, row, source, calls: () => calls, bookings: () => bookings,
    setMessage: (next: Partial<typeof message>) => { message = { ...message, ...next } }, missing: () => { contextMissing = true } }
}
const answer = (action: string, evidenceIds: string[] = ['qq:77']): AdaptiveAttempt => ({ called: true, text: JSON.stringify({ action, evidenceIds }) })

for (const action of ['dismiss', 'fulfilled']) test(`adaptive ${action}: 目的已解决，不创建回合、不发送、不扣发送配额`, async t => {
  const r = await rig(t, async request => {
    assert.ok(adaptivePrompt(request).includes('我已经吃过午饭了'))
    assert.ok(adaptivePrompt(request).includes('如果还没有聊到午饭'))
    return answer(action)
  })
  await r.worker.tick(r.clock.now())
  await r.worker.tick(r.clock.now())
  assert.equal(r.calls(), 1)
  assert.equal(r.bookings(), 0)
  assert.equal(r.platform.sent.length, 0)
  assert.equal(r.store.state.counters.sentTodayGlobal, 0)
  assert.equal(r.store.state.counters.unansweredStreakByRoom['dm-10001'] ?? 0, 0)
  assert.equal(r.store.state.counters.draftCallsToday, 1)
  assert.equal(r.store.candidate(r.row.id)?.state, 'cancelled')
  assert.equal(r.store.listDeliveries().length, 0)
  const disk = JSON.parse(readFileSync(r.file, 'utf8'))
  const restored = normalizeCandidate(disk.candidates[r.row.id])
  assert.equal(restored?.intent?.decision?.action, action)
})
test('adaptive send: turn + draftModel=false 仍进行复核，通过后只提交一个回合', async t => {
  const r = await rig(t, async () => answer('send', []))
  r.setMessage({ text: '先打完这局再说' })
  await r.worker.tick(r.clock.now())
  assert.equal(r.calls(), 1)
  assert.equal(r.bookings(), 1, r.logs.join('\n'))
  assert.equal(r.store.state.counters.sentTodayGlobal, 1)
  await r.worker.tick(r.clock.now())
  assert.equal(r.bookings(), 1)
})
test('adaptive: 普通联系候选保留原行为，不进入自主意图复核', async t => {
  const r = await rig(t, async () => { throw Error('must not call') }, { ordinary: true })
  await r.worker.tick(r.clock.now())
  assert.equal(r.calls(), 0)
  assert.equal(r.bookings(), 1)
})
for (const raw of ['not-json', JSON.stringify({ action: 'fulfilled', evidenceIds: ['qq:invented'] })]) test('adaptive: 坏输出或伪造证据只延后，绝不发送', async t => {
  const r = await rig(t, async () => ({ called: true, text: raw }))
  await r.worker.tick(r.clock.now())
  await r.worker.tick(r.clock.now())
  assert.equal(r.calls(), 1)
  assert.equal(r.bookings(), 0)
  assert.equal(r.store.candidate(r.row.id)?.state, 'deferred')
})
test('adaptive: 同秒同内容但消息 ID 变化，使旧复核失效', async t => {
  let r: Awaited<ReturnType<typeof rig>>
  r = await rig(t, async () => { r.setMessage({ id: 'qq:78' }); return answer('send', []) })
  await r.worker.tick(r.clock.now())
  assert.equal(r.bookings(), 0)
  assert.equal(r.store.state.counters.draftFailureStreak, 0, '新消息不是模型故障')
})
test('adaptive: 复核期间取消，迟到结果不复活候选', async t => {
  let r: Awaited<ReturnType<typeof rig>>
  r = await rig(t, async () => {
    await r.store.patchCandidate(r.row.id, { state: 'cancelled' }, r.clock.now())
    return answer('send', [])
  })
  await r.worker.tick(r.clock.now())
  assert.equal(r.bookings(), 0)
  assert.equal(r.store.candidate(r.row.id)?.state, 'cancelled')
})
test('adaptive: 缺上下文或预算时零调用、零外发', async t => {
  const r = await rig(t, async () => answer('send', []), { budget: 0 })
  await r.worker.tick(r.clock.now())
  assert.equal(r.calls(), 0)
  r.config.draftDailyBudget = 20
  r.missing()
  await r.worker.tick(r.clock.now())
  assert.equal(r.calls(), 0)
  assert.equal(r.bookings(), 0)
})
test('adaptive: 两次延后后终结，tick 不导致无限调用', async t => {
  const r = await rig(t, async () => answer('defer', []))
  for (let i = 0; i < 4; i++) { await r.worker.tick(r.clock.now()); r.clock.advance(300_000) }
  assert.equal(r.calls(), 2)
  assert.equal(r.bookings(), 0)
  assert.equal(r.store.candidate(r.row.id)?.lastSuppressedReason, 'followup:review-limit')
})
for (const old of [false, true]) test(`adaptive: ${old ? '意图创建前的证据' : '不可读图片'}不能作为完成依据`, async t => {
  const r = await rig(t, async () => answer('fulfilled'))
  r.setMessage(old ? { at: T0 - 7_200_000 } : { text: '[图片]' })
  await r.worker.tick(r.clock.now())
  assert.equal(r.store.candidate(r.row.id)?.state, 'deferred')
  assert.equal(r.bookings(), 0)
})
test('adaptive: 未实际发起模型调用不占模型预算', async t => {
  const r = await rig(t, async () => ({ called: false, text: '' }))
  await r.worker.tick(r.clock.now())
  assert.equal(r.store.state.counters.draftCallsToday, 0)
  assert.equal(r.store.candidate(r.row.id)?.intent?.evaluations, 0)
  assert.equal(r.bookings(), 0)
})
test('adaptive: 原生模型入口在准备失败时返回未调用，严格输出解析拒绝空证据完成', async () => {
  const clock = new FakeClock(T0)
  const port = createAdaptiveDecisionPort({ context: () => { throw Error('not ready') }, clock, timeoutMs: () => 1000 })
  assert.deepEqual(await port.decide({} as AdaptiveRequest), { called: false, text: '' })
  assert.equal(parseAdaptiveDecision('{"action":"fulfilled","evidenceIds":[]}', [], T0), null)
})

test('adaptive: 配额、免打扰和功能开关继续在模型与发送之前生效', async t => {
 const r=await rig(t,async()=>answer('send',[]));r.config.dailyQuotaGlobal=0;
 await r.worker.tick(r.clock.now());assert.equal(r.calls(),0);assert.equal(r.bookings(),0);
 r.config.dailyQuotaGlobal=3;r.config.adaptiveFollowUp=false;await r.worker.tick(r.clock.now());assert.equal(r.calls(),0);
})
test('adaptive: 复核期间关闭功能，不提交发送回合', async t=>{
 let r:Awaited<ReturnType<typeof rig>>;r=await rig(t,async()=>{r.config.adaptiveFollowUp=false;return answer('send',[])});
 await r.worker.tick(r.clock.now());assert.equal(r.bookings(),0);assert.equal(r.store.state.counters.sentTodayGlobal,0);
})
test('adaptive: 模型超时被中止并返回有界失败',async()=>{
 const clock=new FakeClock(T0);let dispatched=0;
 const port=createAdaptiveDecisionPort({clock,timeoutMs:()=>1000,context:()=>({llm:{stream:()=>{dispatched++;return {[Symbol.asyncIterator]:()=>({next:async()=>await new Promise(()=>{})})}}},agentDefaultModel:{currentSelection:()=>({provider:'mock',model:'mock'})}}) as never});
 const pending=port.decide({intent:{schemaVersion:1,purpose:'午饭',originSessionId:'qq-dm-10001',evaluations:1},context:{history:[],evidence:[],outbound:[],sentBlock:null,memory:null} as never,now:T0,createdAt:T0-1000});
 for(let i=0;i<8;i++)await Promise.resolve();clock.advance(1000);
 assert.deepEqual(await pending,{called:true,text:'',failed:true});assert.equal(dispatched,1);
})
