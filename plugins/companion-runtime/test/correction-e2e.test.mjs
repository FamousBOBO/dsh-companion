import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mountRuntime } from '../index.mjs';
import { createMemoryEngine } from '../../companion-memory/index.mjs';

// task-39：**跨插件**端到端 —— 一条流水线，不是两段证据。
//
// 之前 runtime 出队与 memory 召回是两条独立的测试：一条证明"精确 id 进了队列"，另一条证明"精确 id
// 会让 recall 不再返回"。那等于把风险留在接缝上。这里真挂 runtime + 真 memory 引擎，走完整条链路：
//
//   两条确认事实 → 一条含糊纠正（文本 hint，命中 2 条）→ memory fail-closed 报 ambiguous
//   → runtime 记待审（候选**带正文**）→ 主人裁决压 1 条 → 同一个引擎跑真 recall()
//   → 被压的那条不再返回、另一条仍在、count 减 1、审计可查

const T0 = Date.UTC(2026, 10, 8, 3, 0, 0);
const SESSION = 'e2e-owner';

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'correction-e2e-'));
  for (const dir of ['home/companion', 'home/memory', 'logs', 'workspace']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, 'workspace/PERSONA.md'), 'bot\n', 'utf8');
  fs.writeFileSync(path.join(root, 'home/companion/runtime.config.json'), JSON.stringify({
    enabled: true, mode: 'active', timeZone: 'Asia/Shanghai',
  }), 'utf8');
  // Memory must never call a model here: lexical recall only, extraction off.
  fs.writeFileSync(path.join(root, 'home/companion/memory.config.json'), JSON.stringify({
    backend: 'sqlite',
    database: 'home/memory/companion-memory.db',
    wiki: { enabled: false },
    extraction: { enabled: false },
    retrieval: { semanticEnabled: false },
  }, null, 2), 'utf8');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ } });
  return root;
}

async function mounted(t) {
  const root = tempRoot(t);
  const engine = createMemoryEngine({
    root,
    identity: {
      owner: () => ({ id: 'owner-1', displayName: '主人', platform: 'local' }),
      resolve: sessionId => ({ userId: 'owner-1', personaId: 'bot', displayName: '主人', sessionId }),
    },
    env: {},
    now: () => T0,
  });
  await engine.initialize();
  t.after(async () => { try { await engine.close(); } catch { /* cleanup */ } });

  const runtime = mountRuntime(null, root, {
    now: () => T0,
    identity: { resolve: sessionId => ({ userId: 'owner-1', persona: 'bot', sessionId }) },
    memory: engine,
  });
  t.after(() => { try { runtime.dispose?.(); } catch { /* disposed */ } });

  const internal = await engine.internal();
  assert.ok(internal.db, 'the real memory database is open');
  return { runtime, engine, db: internal.db, root };
}

const fact = overrides => ({
  subject: { userId: 'owner-1', personaId: 'bot', worldId: '' },
  transformVersion: 't1',
  rootEvidenceIds: [],
  realityStatus: 'actual_tool_activity',
  evidenceStatus: 'confirmed',
  occurredAt: T0,
  ...overrides,
});

const statusOf = (db, id) => db.handle.prepare('SELECT status FROM memories WHERE id = ?').get(id)?.status ?? '';
const recallIds = async (engine, query) => {
  const result = await engine.recall({ sessionId: SESSION, query, limit: 10 });
  return (result.entries ?? []).map(entry => String(entry.memoryId ?? entry.id ?? ''));
};

test('端到端：含糊纠正 → 待审带正文 → 裁决压 1 条 → 同一个引擎的 recall 不再返回它', async t => {
  const { runtime, engine, db } = await mounted(t);

  // Two real memories that a text hint cannot tell apart.
  const first = await engine.ingestDomainEvent(fact({ namespace: 'companion.event', eventId: 'e2e-1', content: '用户喜欢在雨天散步，尤其是小雨' }));
  const second = await engine.ingestDomainEvent(fact({ namespace: 'companion.event', eventId: 'e2e-2', content: '用户喜欢在雨天散步，但不喜欢打伞' }));
  assert.equal(first.status, 'accepted', JSON.stringify(first));
  assert.equal(second.status, 'accepted', JSON.stringify(second));
  assert.equal((await recallIds(engine, '雨天散步')).length, 2, 'both facts are recallable to start with');

  // A belief whose correction will carry the ambiguous old statement.
  assert.equal(runtime.assertBelief({ sessionId: SESSION, proposition: '用户喜欢在雨天散步', rootEvidenceIds: ['ev-1'], confidence: 0.8, source: 'conversation' }).ok, true);
  const belief = runtime.listBeliefs({ sessionId: SESSION }).beliefs[0];
  const corrected = runtime.correctBelief({
    sessionId: SESSION, beliefId: belief.beliefId, byEvidenceId: 'ev-2',
    reason: '用户改口了', replacement: '用户不喜欢在雨天散步了',
  });
  assert.equal(corrected.memoryCorrection.ok, true, JSON.stringify(corrected.memoryCorrection));

  // Deliver it for real: memory sees two candidates and refuses to guess.
  const summary = await runtime.drainOutbox({ sessionId: SESSION });
  assert.equal(summary.delivered >= 1, true, JSON.stringify(summary));
  assert.equal(statusOf(db, first.recordId), 'confirmed', 'fail-closed: nothing was superseded automatically');
  assert.equal(statusOf(db, second.recordId), 'confirmed');

  const review = await runtime.correctionReview({ limit: 5 });
  assert.equal(review.count, 1, 'one correction is waiting for a human');
  const entry = review.recent[0];
  const candidates = entry.candidates;
  assert.equal(candidates.length, 2, 'both candidates are offered');
  // **The point of this task**: the reviewer can read what it is choosing between.
  assert.equal(candidates.some(item => String(item.text ?? '').includes('尤其是小雨')), true, 'candidate text is readable');
  assert.equal(candidates.some(item => String(item.text ?? '').includes('但不喜欢打伞')), true);
  for (const item of candidates) {
    assert.equal(typeof item.recordId, 'string');
    assert.equal(String(item.text ?? '').length <= 120, true, 'previews are bounded');
  }

  // The owner decides: replace the first one only.
  const targetId = candidates.find(item => String(item.text ?? '').includes('尤其是小雨')).recordId;
  const resolved = runtime.resolveAmbiguousCorrection({
    recordId: entry.recordId,
    sessionId: SESSION,
    supersedeIds: [targetId],
    operator: 'owner',
    evidence: '主人说"以后别记那条小雨的说法了"',
  });
  assert.equal(resolved.ok, true, JSON.stringify(resolved));
  assert.equal(resolved.outcome, 'resolved-pending-apply');

  // Execution really reaches memory: deliver the adjudication, then the same engine is asked.
  const second2 = await runtime.drainOutbox({ sessionId: SESSION });
  assert.equal(second2.delivered >= 1, true, JSON.stringify(second2));
  assert.equal(statusOf(db, targetId), 'superseded', 'the chosen row is superseded');

  const afterIds = await recallIds(engine, '雨天散步');
  assert.equal(afterIds.includes(targetId), false, 'the adjudicated fact is gone from recall');
  assert.equal(afterIds.includes(second.recordId), true, 'the untouched candidate is still recalled');

  const reviewAfter = await runtime.correctionReview();
  assert.equal(reviewAfter.count, 0, 'nothing pending any more');
  // task-49: the memory side really superseded (asserted above), but the audit only becomes
  // `resolved-applied` when the settlement pass sees that confirmation.
  assert.equal(reviewAfter.resolved, 0, 'the enqueue alone is not an application');
  assert.equal(reviewAfter.pendingApply, 1, 'it is in flight and says so');
  const settleOut = runtime.settleCorrectionResolutions({});
  assert.equal(settleOut.needsReview, 0, `no adjudication should need review here (${JSON.stringify(settleOut)})`);
  const settledReview = await runtime.correctionReview();
  assert.equal(settledReview.resolved, 1, 'a confirmed supersede becomes applied');
  assert.equal(settledReview.pendingApply, 0);

  const audit = runtime.correctionResolution({ recordId: entry.recordId });
  assert.equal(audit.ok, true);
  assert.equal(audit.resolved.operator, 'owner');
  assert.deepEqual(audit.resolved.supersedeIds, [targetId]);

  const listed = runtime.listResolved({ limit: 5 });
  assert.equal(listed.ok, true, JSON.stringify(listed));
  assert.equal(listed.resolved.length, 1, 'the adjudication is enumerable');
  assert.equal(listed.resolved[0].recordId, entry.recordId);
  assert.deepEqual(listed.resolved[0].supersededIds, [targetId]);
  assert.equal(listed.resolved[0].operator, 'owner');
});
