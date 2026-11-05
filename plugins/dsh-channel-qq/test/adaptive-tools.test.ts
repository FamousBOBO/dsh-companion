import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import * as path from 'node:path'
import { ContactStore } from '../src/features/contact/store.js'
import { createContactService } from '../src/features/contact/service.js'
import type { ContactWorker } from '../src/features/contact/worker.js'
import type { SubHost } from '../src/features/plugin-kit.js'
import { registerAdaptiveTools } from '../src/features/contact/adaptive-tools.js'
import { normalizeCandidate } from '../src/features/contact/ledger.js'
import { installFollowupContext, followupContext } from '../src/adapters/dsh-host/followup-context.js'
import { turnTrust } from '../src/core/trust.js'
import { FakeClock, baseConfig, fakeBridge, fakeSubHost, tempHome, contactDelivery } from './fakes/contact.js'

interface Definition { execute(args: unknown, exec?: { agent: { id: string } }): Promise<Record<string, any>> }
async function tools(t: TestContext) {
  const home = tempHome('adaptive-tools-'), clock = new FakeClock(Date.now() - 20_000)
  const config = baseConfig({ admins: [10001] })
  const harness = fakeSubHost('contact', config, home.dir)
  const store = new ContactStore({ file: path.join(home.dir, 'contact.json'), lockFile: path.join(home.dir, 'contact.lock'),
    hostId: 'tools', pid: 101, clock, log: () => {}, dayKey: () => '2026-11-03' })
  await store.load()
  const definitions = new Map<string, Definition>()
  const host: SubHost = { ...harness.host, bridge: { ...fakeBridge(), toolHost: () => ({ tools: {
    register: definition => { definitions.set(String(definition.name), definition as unknown as Definition); return () => { definitions.delete(String(definition.name)) } },
  } }) } }
  let evidence = [{ id: 77, time: Math.floor((clock.now() + 10_000) / 1000), userId: 10001, name: '主人', text: '已经吃过午饭了' }]
  harness.with('history', { search: async () => evidence, collect: async () => 0 } as never)
  const worker = { isPaused: false, pause: () => {}, resume: () => {} } as ContactWorker
  const service = createContactService({ store, worker, clock, log: () => {}, config: () => config.contact, random: Math.random })
  const remove = registerAdaptiveTools(host, store, service)
  turnTrust.commit('qq-dm-10001', 'master', true)
  t.after(async () => { remove(); await store.releaseLease(); home.cleanup() })
  const tool = definitions.get('qq_followup')!
  assert.ok(tool, '必须经真实宿主注册适配器注册')
  const call = (args: unknown, session = 'qq-dm-10001') => tool.execute(args, { agent: { id: session } })
  const add = (purpose = '晚点关心午饭') => call({ action: 'add', purpose, at: Date.now() + 60_000 })
  return { store, call, add, remove, definitions, setEvidence: (rows: typeof evidence) => { evidence = rows } }
}
test('adaptive tools: 只在主人私聊可创建，自动绑定 scope，重提同意图幂等', async t => {
  const r = await tools(t)
  await assert.rejects(r.call({ action: 'add', purpose: 'test', at: Date.now() + 60_000 }, 'qq-group-10001'), /owner-session-required/)
  turnTrust.commit('qq-dm-10001', 'member', true)
  await assert.rejects(r.add(), /owner-session-required/)
  turnTrust.commit('qq-dm-10001', 'master', true)
  const a = await r.add(), b = await r.add()
  assert.equal(a.outcome, 'accepted')
  turnTrust.commit('qq-dm-10001', 'system', true)
  assert.equal((await r.call({ action: 'list' })).candidates.length, 1, '主人私聊的自主回合可管理意图')
  turnTrust.commit('qq-dm-10001', 'master', true)
  assert.equal(b.outcome, 'duplicate')
  assert.equal(a.candidateId, b.candidateId)
  const row = r.store.candidate(String(a.candidateId))!
  assert.equal(row.authorization.kind, 'none')
  assert.equal(row.scope.userId, 10001)
  assert.equal(row.intent?.originSessionId, 'qq-dm-10001')
  assert.ok(normalizeCandidate(JSON.parse(JSON.stringify(row)))?.intent)
  assert.equal(normalizeCandidate({ ...row, intent: undefined }), null, '不能删除元数据后退回普通发送路径')
  assert.equal(normalizeCandidate({ ...row, intent: { ...row.intent, originSessionId: 'qq-dm-22222' } }), null)
  r.remove()
  assert.equal(r.definitions.size, 0)
})
test('adaptive tools: 完成需要同房间真实证据和当前版本，已终结不复活', async t => {
  const r = await tools(t), added = await r.add(), id = String(added.candidateId)
  const row = r.store.candidate(id)!
  await assert.rejects(r.call({ action: 'resolve', id, expectedVersion: row.version, outcome: 'fulfilled', evidenceIds: ['qq:fake'] }), /evidence-unavailable/)
  assert.equal((await r.call({ action: 'resolve', id, expectedVersion: row.version + 1, outcome: 'fulfilled', evidenceIds: ['qq:77'] })).ok, false)
  assert.equal((await r.call({ action: 'resolve', id, expectedVersion: row.version, outcome: 'fulfilled', evidenceIds: ['qq:77'] })).ok, true)
  assert.equal(r.store.candidate(id)?.state, 'cancelled')
  assert.equal(r.store.state.counters.sentTodayGlobal, 0)
  assert.equal((await r.add()).outcome, 'duplicate')
})
test('adaptive tools: 已领取的投递不能谎称被取消，改期使旧版本失效', async t => {
  const r = await tools(t), added = await r.add(), id = String(added.candidateId)
  const row = r.store.candidate(id)!
  assert.equal((await r.call({ action: 'reschedule', id, expectedVersion: row.version, at: Date.now() + 120_000 })).ok, true)
  const current = r.store.candidate(id)!
  assert.equal((await r.call({ action: 'cancel', id, expectedVersion: row.version })).ok, false)
  const lease = await r.store.acquireLease()
  assert.ok(lease)
  assert.equal(await r.store.claimDelivery(contactDelivery({ id: 'd-' + id, candidateId: id, target: current.target, scope: current.scope, dedupeKey: current.dedupeKey }), lease.epoch), true)
  assert.equal((await r.call({ action: 'cancel', id, expectedVersion: current.version })).ok, false)
})
test('adaptive tools: 图片占位符不能做完成证据，最多五个活动意图', async t => {
  const r = await tools(t), a = await r.add(), row = r.store.candidate(String(a.candidateId))!
  r.setEvidence([{ id: 77, time: Math.floor(Date.now() / 1000), userId: 10001, name: '主人', text: '[图片]' }])
  await assert.rejects(r.call({ action: 'resolve', id: row.id, expectedVersion: row.version, outcome: 'fulfilled', evidenceIds: ['qq:77'] }), /evidence-unavailable/)
  for (let i = 0; i < 4; i++) await r.add('purpose ' + i)
  assert.equal((await r.add('sixth')).outcome, 'rejected')
})
test('adaptive context: 只注入当前主人未结束意图，复用当前回合并可卸载', async t => {
  const r = await tools(t)
  await r.add()
  const row = r.store.listCandidates()[0]!
  assert.ok(followupContext([row]).includes(row.id))
  assert.equal(followupContext([{ ...row, state: 'cancelled' }]).includes(row.id), false)
  let listener: (event: any, next: () => Promise<unknown>) => Promise<unknown> = async () => {}
  let off = false, read: (() => string) | undefined
  const remove = installFollowupContext({ on: (_name: string, fn: typeof listener) => { listener = fn; return () => { off = true } } }, () => r.store.listCandidates(), 10001)
  const agent = { id: 'qq-dm-10001', ctx: { systemPrompt: { section: (input: { text: () => string }) => { read = input.text } } } }
  await listener({ agent }, async () => {})
  assert.ok(read?.().includes('晚点关心午饭'))
  await r.call({ action: 'cancel', id: row.id, expectedVersion: row.version })
  assert.equal(read?.().includes(row.id), false)
  remove()
  assert.equal(off, true)
})

test('adaptive tools: 并发创建也不能超过五个活动意图', async t => {
 const r = await tools(t)
 for (let i=0;i<4;i++) await r.add('open '+i)
 const result=await Promise.all([r.add('parallel A'),r.add('parallel B')])
 assert.equal(result.filter(x=>x.outcome==='accepted').length,1)
 assert.equal(result.filter(x=>x.outcome==='rejected').length,1)
 assert.equal(r.store.listCandidates().filter(x=>['pending','deferred'].includes(x.state)).length,5)
})
