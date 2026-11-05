import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createMemoryEngine } from '../index.mjs';

// task-36：**fail-closed** —— 压掉一条真实记忆是不可逆的，所以文本 hint 命中多条时宁可不压。
//
// 这条测试的存在理由：task-33 的 B 片在 hint 是文本时用 LIKE 找候选，命中最多 5 条会**一起**被
// 标成 superseded。用户说"我改主意了"不该顺手抹掉三条无关偏好。现在的规则是：
//   命中恰好 1 条 → superse；
//   命中 ≥2 条   → 一条都不压，记 `correction-hint-ambiguous`（带候选 id），新事实照常入库；
//   命中 0 条    → miss，按普通事实入库；
//   id hint      → 精确命中（行为不变）。

const T0 = Date.UTC(2026, 10, 6, 3, 0, 0);
const PERSONA = 'march7';
const USER = 'guard_user';

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-memory-guard-'));
  const configFile = path.join(root, 'home', 'companion', 'memory.config.json');
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify({
    backend: 'sqlite',
    database: 'home/memory/companion-memory.db',
    wiki: { enabled: false },
    extraction: { enabled: false },
    retrieval: { semanticEnabled: false },
  }, null, 2), 'utf8');
  return root;
}

const identityStub = () => ({
  owner() { return { id: USER, displayName: '误伤防护用户', platform: 'local' }; },
  resolve(sessionId) { return { userId: USER, personaId: PERSONA, displayName: '误伤防护用户', sessionId }; },
});

async function makeEngine(t) {
  const root = makeRoot(t);
  const engine = createMemoryEngine({ root, identity: identityStub(), env: {}, now: () => T0 });
  t.after(async () => {
    try { await engine.close(); } catch { /* cleanup only */ }
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* cleanup only */ }
  });
  await engine.initialize();
  const internal = await engine.internal();
  assert.ok(internal.db, 'the engine must open a temporary sqlite database');
  return { engine, db: internal.db };
}

const base = overrides => ({
  subject: { userId: USER, personaId: PERSONA, worldId: '' },
  transformVersion: 't1',
  rootEvidenceIds: [],
  realityStatus: 'actual_tool_activity',
  evidenceStatus: 'confirmed',
  occurredAt: T0,
  ...overrides,
});

const statusOf = (db, id) => db.handle.prepare('SELECT status FROM memories WHERE id = ?').get(id)?.status ?? '';

test('文本 hint 命中 2 条 → 一条都不压、记 ambiguous、新事实入库', async t => {
  const { engine, db } = await makeEngine(t);
  // Two distinct confirmed memories that both contain the hint text.
  const first = await engine.ingestDomainEvent(base({ namespace: 'companion.event', eventId: 'g1', content: '用户喜欢在雨天散步，尤其是小雨' }));
  const second = await engine.ingestDomainEvent(base({ namespace: 'companion.event', eventId: 'g2', content: '用户喜欢在雨天散步，但不喜欢打伞' }));
  assert.equal(first.status, 'accepted');
  assert.equal(second.status, 'accepted');

  const correction = await engine.ingestDomainEvent(base({
    namespace: 'companion.correction',
    eventId: 'g3',
    content: '用户纠正（旧：用户喜欢在雨天散步）现在是「用户不喜欢在雨天散步」',
    supersedesHint: '用户喜欢在雨天散步',
  }));

  assert.equal(correction.status, 'accepted', 'the new fact is still stored');
  assert.equal(correction.supersede.reason, 'correction-hint-ambiguous');
  assert.deepEqual(correction.supersede.superseded, [], 'nothing was superseded');
  assert.equal(correction.supersede.ambiguous.length, 2, 'both candidates are reported');
  assert.equal(statusOf(db, first.recordId), 'confirmed', 'candidate one survived');
  assert.equal(statusOf(db, second.recordId), 'confirmed', 'candidate two survived');
  assert.equal(statusOf(db, correction.recordId), 'confirmed', 'the correction itself is stored');
});

test('文本 hint 命中 1 条 → 照旧 superse（行为不回归）', async t => {
  const { engine, db } = await makeEngine(t);
  const only = await engine.ingestDomainEvent(base({ namespace: 'companion.event', eventId: 'h1', content: '用户喜欢在雨天散步' }));
  const correction = await engine.ingestDomainEvent(base({
    namespace: 'companion.correction', eventId: 'h2',
    content: '用户纠正（旧：用户喜欢在雨天散步）现在是「用户不喜欢在雨天散步」',
    supersedesHint: '用户喜欢在雨天散步',
  }));
  assert.equal(correction.supersede.reason, 'correction-superseded');
  assert.deepEqual(correction.supersede.superseded, [only.recordId]);
  assert.equal(statusOf(db, only.recordId), 'superseded');
});

test('文本 hint 命中 0 条 → miss，按普通事实入库', async t => {
  const { engine, db } = await makeEngine(t);
  const correction = await engine.ingestDomainEvent(base({
    namespace: 'companion.correction', eventId: 'm1',
    content: '用户纠正（旧：从没说过的话）现在是「新说法」',
    supersedesHint: '从没说过的话',
  }));
  assert.equal(correction.status, 'accepted');
  assert.equal(correction.supersede.reason, 'correction-hint-miss');
  assert.equal(statusOf(db, correction.recordId), 'confirmed');
  assert.equal(correction.superseded, undefined);
});

test('id hint：精确命中就压；指向不存在则 miss', async t => {
  const { engine, db } = await makeEngine(t);
  const target = await engine.ingestDomainEvent(base({ namespace: 'companion.event', eventId: 'i1', content: '用户喜欢早起' }));
  // Deliberately ambiguous *text* but an exact id: the id wins, exactly one row is superseded.
  await engine.ingestDomainEvent(base({ namespace: 'companion.event', eventId: 'i2', content: '用户喜欢早起，但只在夏天' }));

  const byId = await engine.ingestDomainEvent(base({
    namespace: 'companion.correction', eventId: 'i3',
    content: '用户纠正（旧：用户喜欢早起）现在是「用户不喜欢早起」',
    supersedesHint: target.recordId,
  }));
  assert.equal(byId.supersede.reason, 'correction-superseded');
  assert.deepEqual(byId.supersede.superseded, [target.recordId]);
  assert.equal(statusOf(db, target.recordId), 'superseded');

  const missing = await engine.ingestDomainEvent(base({
    namespace: 'companion.correction', eventId: 'i4',
    content: '用户纠正（旧：另一件事）现在是「另一件新事」',
    supersedesHint: 'mem_does_not_exist',
  }));
  assert.equal(missing.supersede.reason, 'correction-hint-miss');
  assert.equal(statusOf(db, missing.recordId), 'confirmed');
});

test('诊断可读：ambiguous 计数与最近条目（含候选 id）', async t => {
  const { engine } = await makeEngine(t);
  const empty = await engine.correctionReview();
  assert.deepEqual(empty, { count: 0, recent: [] }, 'nothing to review yet');

  await engine.ingestDomainEvent(base({ namespace: 'companion.event', eventId: 'd1', content: '用户喜欢在雨天散步，尤其是小雨' }));
  await engine.ingestDomainEvent(base({ namespace: 'companion.event', eventId: 'd2', content: '用户喜欢在雨天散步，但不喜欢打伞' }));
  const ambiguous = await engine.ingestDomainEvent(base({
    namespace: 'companion.correction', eventId: 'd3',
    content: '用户纠正（旧：用户喜欢在雨天散步）现在是「用户不喜欢在雨天散步」',
    supersedesHint: '用户喜欢在雨天散步',
  }));
  assert.equal(ambiguous.supersede.reason, 'correction-hint-ambiguous');

  const review = await engine.correctionReview({ limit: 5 });
  assert.equal(review.count, 1, 'one correction is waiting for a human');
  assert.equal(review.recent.length, 1);
  assert.equal(review.recent[0].recordId, ambiguous.recordId);
  assert.equal(review.recent[0].candidates.length, 2, 'the candidate ids travel with the marker');
});
