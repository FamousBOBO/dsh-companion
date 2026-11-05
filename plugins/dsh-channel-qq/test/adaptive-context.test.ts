import test from 'node:test'
import assert from 'node:assert/strict'
import { buildDraftContext, type DraftContextDeps } from '../src/features/contact/draft-context.js'
import { createRevisionVerifier } from '../src/features/contact/draft-freshness.js'
import { defaultContactConfig } from '../src/config/sections/contact.js'
import { contactCandidate, contactDelivery, contactRuntime } from './fakes/contact.js'

test('adaptive context: 读取更完整的有界对话，发送前复核使用同一历史窗口', async () => {
  const now = Date.UTC(2026, 10, 3, 5, 10)
  const lines = Array.from({ length: 30 }, (_, n) => ({ id: n + 1, time: (now - (30 - n) * 60_000) / 1000,
    userId: 10001, name: '主人', text: n === 10 ? '午饭已经吃过了，刚才还给你看了照片' : '这是正常聊天 ' + n }))
  // 自主跟进复核默认关（发布基线）；这条用例测的是"复核读到哪段历史"，所以显式打开。
  const config = { ...defaultContactConfig(), timezone: 'Asia/Shanghai', adaptiveFollowUp: true }
  const deps: DraftContextDeps = { config: () => config, get: name => name === 'history' ? { search: async () => lines, collect: async () => 0 } : undefined,
    preset: () => ({ readDocument: async () => ({ content: 'bot' }) }),
    roomFacts: () => ({ connected: true, roomBound: true, turnRunning: false, lastUserMessageAt: now - 60_000, queueDepth: 0 }) }
  const base = contactCandidate({ createdAt: now - 3_600_000, updatedAt: now - 3_600_000,
    evidenceSource: 'planned-followup', intent: { schemaVersion: 1, purpose: '确认午饭', originSessionId: 'qq-dm-10001', evaluations: 0 } })
  const adaptive = await buildDraftContext(deps, base, now)
  assert.ok(adaptive.history.some(row => row.id === 'qq:11'), '不能因只读最后12条而遗漏刚才已经解决目的的对话')
  const ordinary = await buildDraftContext(deps, { ...base, intent: undefined, evidenceSource: 'chatlog' }, now)
  assert.equal(ordinary.history.some(row => row.id === 'qq:11'), false, '普通候选保持原有上下文窗口')
  const verify = createRevisionVerifier(deps)
  const req = { candidate: base, delivery: contactDelivery({ candidateId: base.id }), text: 'check', now,
    runtime: contactRuntime(), revision: adaptive.revision }
  assert.equal(await verify(req), null, '评估与执行必须使用同一窗口，否则所有正常发送都会误判陈旧')
  lines.push({ id: 31, time: (now - 60_000) / 1000, userId: 10001, name: '主人', text: '有新消息' })
  assert.equal((await verify(req))?.detail, 'draft:stale:history')
})
