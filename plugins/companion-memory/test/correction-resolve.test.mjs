import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createMemoryEngine } from '../index.mjs';

// task-38（记忆侧）：裁决之后，被压的那几条**真的**从 recall 里消失。
//
// 裁决通道把"哪几条"从启发式文本匹配变成**操作者给的精确 id 列表**（`supersedeIds`）。这里用真
// 引擎 + 真 `recall()` 证明：压掉的那条不再被召回，**没被选中的候选照旧召回**——这一点很重要，
// 否则"裁决"就成了"全清"。

const T0 = Date.UTC(2026, 10, 7, 3, 0, 0);
const PERSONA = 'bot';
const USER = 'resolve_user';

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-memory-resolve-'));
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
  owner() { return { id: USER, displayName: '裁决测试用户', platform: 'local' }; },
  resolve(sessionId) { return { userId: USER, personaId: PERSONA, displayName: '裁决测试用户', sessionId }; },
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

test('裁决 superseIds 只压选中的那一条：它从 recall 消失，另一条候选还在', async t => {
  const { engine, db } = await makeEngine(t);
  const a = await engine.ingestDomainEvent(base({ namespace: 'companion.event', eventId: 'r1', content: '用户喜欢在雨天散步，尤其是小雨' }));
  const b = await engine.ingestDomainEvent(base({ namespace: 'companion.event', eventId: 'r2', content: '用户喜欢在雨天散步，但不喜欢打伞' }));
  assert.equal(a.status, 'accepted');
  assert.equal(b.status, 'accepted');

  const before = await engine.recall({ sessionId: 's1', query: '雨天散步', limit: 10 });
  const beforeIds = before.entries.map(entry => String(entry.memoryId ?? entry.id ?? ''));
  assert.equal(beforeIds.includes(a.recordId), true, 'candidate A is recallable before the adjudication');
  assert.equal(beforeIds.includes(b.recordId), true, 'candidate B is recallable before the adjudication');

  // The operator's decision: replace only A.
  const adjudicated = await engine.ingestDomainEvent(base({
    namespace: 'companion.correction',
    eventId: 'r3',
    content: '人工裁决：纠正只取代第一条',
    supersedeIds: [a.recordId],
  }));
  assert.equal(adjudicated.status, 'accepted', JSON.stringify(adjudicated));
  assert.deepEqual(adjudicated.superseded, [a.recordId], 'exactly the chosen row was superseded');

  assert.equal(statusOf(db, a.recordId), 'superseded');
  assert.equal(statusOf(db, b.recordId), 'confirmed', 'the other candidate is untouched');

  const after = await engine.recall({ sessionId: 's1', query: '雨天散步', limit: 10 });
  const afterIds = after.entries.map(entry => String(entry.memoryId ?? entry.id ?? ''));
  assert.equal(afterIds.includes(a.recordId), false, 'the adjudicated row is gone from recall');
  assert.equal(afterIds.includes(b.recordId), true, 'the untouched candidate is still recalled');
});

test('裁决后 FTS 召回也不返回被压的那条', async t => {
  const { engine, db } = await makeEngine(t);
  const target = await engine.ingestDomainEvent(base({ namespace: 'companion.event', eventId: 'f1', content: '用户喜欢在雨天散步' }));
  await engine.ingestDomainEvent(base({
    namespace: 'companion.correction', eventId: 'f2', content: '人工裁决：取代那条旧说法', supersedeIds: [target.recordId],
  }));

  const hits = db.fullTextSearch({ userId: USER, personaId: PERSONA, worldId: '', query: '雨天散步', limit: 10 }) ?? [];
  const ids = hits.map(hit => String(hit.id ?? hit.memoryId ?? ''));
  assert.equal(ids.includes(target.recordId), false, 'FTS no longer returns the superseded row');
  assert.equal(statusOf(db, target.recordId), 'superseded');
});

test('裁决幂等：同一条旧记录被两次裁决只压一次（第二次 duplicate:true，无副作用）', async t => {
  const { engine, db } = await makeEngine(t);
  const target = await engine.ingestDomainEvent(base({ namespace: 'companion.event', eventId: 'i1', content: '用户喜欢早起' }));

  await engine.ingestDomainEvent(base({
    namespace: 'companion.correction', eventId: 'i2', content: '人工裁决一：取代', supersedeIds: [target.recordId],
  }));
  const second = await engine.ingestDomainEvent(base({
    namespace: 'companion.correction', eventId: 'i3', content: '人工裁决二：同样取代', supersedeIds: [target.recordId],
  }));
  assert.equal(second.status, 'accepted');
  assert.deepEqual(second.superseded, [target.recordId], 'supersedeMemory reports it (idempotent, no double revision)');

  const revisions = db.handle.prepare(
    "SELECT COUNT(*) AS n FROM memory_revisions WHERE old_id = ? AND operation = 'supersede'",
  ).get(target.recordId)?.n;
  assert.equal(Number(revisions), 1, 'exactly one supersede revision for that row');
  assert.equal(statusOf(db, target.recordId), 'superseded');
});

test('supersedeIds 形状不合法 → 拒绝，不入库', async t => {
  const { engine, db } = await makeEngine(t);
  const target = await engine.ingestDomainEvent(base({ namespace: 'companion.event', eventId: 'x1', content: '用户喜欢猫' }));

  const bad = await engine.ingestDomainEvent(base({
    namespace: 'companion.correction', eventId: 'x2', content: '坏 id 列表', supersedeIds: [target.recordId, 'not-an-id'],
  }));
  assert.equal(bad.status, 'rejected');
  assert.equal(bad.reason, 'invalid-supersede-ids');
  assert.equal(statusOf(db, target.recordId), 'confirmed', 'nothing was superseded');
});
