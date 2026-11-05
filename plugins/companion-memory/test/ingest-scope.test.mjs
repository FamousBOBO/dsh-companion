import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createMemoryEngine } from '../index.mjs';

// Codex review 2026-10-29, B1: the receipt dedupe key included the scope but the
// `source_events` event key did not. Two registered users sending the same
// namespace/eventId/transformVersion both got `accepted`, and the second user's
// memory linked to — and quoted — the first user's evidence text.
//
// Every test owns a throwaway root: the production `home/` directory is never
// opened and no model is ever called.

const T0 = Date.UTC(2026, 9, 29, 3, 0, 0);
const PERSONA = 'bot';
const USER_A = 'scope_user_a';
const USER_B = 'scope_user_b';
const NAMESPACE = 'companion.event';
const EVENT_ID = 'evt_scope_shared';
const TRANSFORM_VERSION = 't1';

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-memory-ingest-'));
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

function identityStub(userId = USER_A) {
  return {
    owner() {
      return { id: userId, displayName: '作用域测试用户', platform: 'local' };
    },
    resolve(sessionId) {
      return { userId, personaId: PERSONA, displayName: '作用域测试用户', sessionId };
    },
  };
}

async function makeEngine(t) {
  const root = makeRoot(t);
  const engine = createMemoryEngine({ root, identity: identityStub(USER_A), env: {}, now: () => T0 });
  t.after(async () => {
    try { await engine.close(); } catch { /* cleanup only */ }
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* cleanup only */ }
  });
  await engine.initialize();
  const internal = await engine.internal();
  assert.ok(internal.db, '测试引擎必须打开临时 SQLite 库');
  return { engine, db: internal.db };
}

function ingestRequest(overrides = {}) {
  return {
    subject: { userId: USER_A, personaId: PERSONA, worldId: '' },
    namespace: NAMESPACE,
    eventId: EVENT_ID,
    transformVersion: TRANSFORM_VERSION,
    rootEvidenceIds: [],
    realityStatus: 'actual_tool_activity',
    evidenceStatus: 'confirmed',
    content: '用户甲喜欢在雨天散步',
    occurredAt: T0,
    ...overrides,
  };
}

function evidenceFor(db, memoryId) {
  return db.handle
    .prepare(
      `SELECT s.source_id AS source_id, s.event_key AS event_key, s.user_id AS user_id,
              s.persona_id AS persona_id, s.world_id AS world_id, s.content AS content
         FROM memory_evidence AS e
         JOIN source_events AS s ON s.source_id = e.source_id
        WHERE e.memory_id = ?
        ORDER BY s.source_id ASC`,
    )
    .all(memoryId);
}

function count(db, table) {
  return Number(db.handle.prepare(`SELECT count(*) AS total FROM ${table}`).get().total);
}

test('same tuple, two different users: both accepted, each memory owns its own evidence text', async t => {
  const { engine, db } = await makeEngine(t);
  // The engine is single-persona but multi-user: USER_B only needs a local identity.
  db.upsertIdentity({ userId: USER_B, displayName: '第二位用户', platform: 'local' });

  const contentA = '用户甲喜欢在雨天散步';
  const contentB = '用户乙在整理旧照片';
  const first = await engine.ingestDomainEvent(ingestRequest({ content: contentA }));
  const second = await engine.ingestDomainEvent(ingestRequest({
    subject: { userId: USER_B, personaId: PERSONA, worldId: '' },
    content: contentB,
  }));

  assert.equal(first.status, 'accepted');
  assert.equal(second.status, 'accepted', '相同 namespace/eventId/version 的不同主体都必须被接受');
  assert.notEqual(second.recordId, first.recordId, '不同主体必须拥有各自的记录');
  assert.notEqual(second.receiptId, first.receiptId, '不同主体必须拥有各自的收据');

  assert.equal(db.getMemory(first.recordId).value, contentA);
  assert.equal(db.getMemory(second.recordId).value, contentB);

  const evidenceA = evidenceFor(db, first.recordId);
  const evidenceB = evidenceFor(db, second.recordId);
  assert.equal(evidenceA.length, 1);
  assert.equal(evidenceB.length, 1);
  assert.equal(evidenceA[0].content, contentA, '甲的记忆必须引用甲的正文');
  assert.equal(evidenceB[0].content, contentB, '乙的记忆必须引用乙的正文，不能串到甲');
  assert.equal(evidenceA[0].user_id, USER_A);
  assert.equal(evidenceB[0].user_id, USER_B, '证据行必须归属于真正的主体');
  assert.equal(evidenceA[0].persona_id, PERSONA);
  assert.equal(evidenceB[0].persona_id, PERSONA);
  assert.notEqual(evidenceA[0].source_id, evidenceB[0].source_id, '证据行必须按作用域分开');
  assert.match(evidenceA[0].event_key, /^runtime-scoped:/, '证据键必须带作用域前缀');
  assert.match(evidenceB[0].event_key, /^runtime-scoped:/);

  assert.equal(count(db, 'source_events'), 2, '两个主体各写一行证据');
  assert.equal(count(db, 'memories'), 2);
  assert.equal(count(db, 'domain_event_receipts'), 2);

  const receipts = db.handle
    .prepare(
      `SELECT r.scope AS scope, m.user_id AS user_id
         FROM domain_event_receipts AS r
         JOIN memories AS m ON m.id = r.record_id
        ORDER BY m.user_id ASC`,
    )
    .all();
  assert.deepEqual(
    receipts.map(row => row.scope),
    [`u:${USER_A}|p:${PERSONA}|w:`, `u:${USER_B}|p:${PERSONA}|w:`],
    '收据作用域必须与主体一致',
  );
  assert.deepEqual(receipts.map(row => row.user_id), [USER_A, USER_B]);
});

test('same tuple, same user, different content: rejected as content conflict', async t => {
  const { engine, db } = await makeEngine(t);
  const request = ingestRequest();
  const first = await engine.ingestDomainEvent(request);
  assert.equal(first.status, 'accepted');

  const conflict = await engine.ingestDomainEvent({ ...request, content: '用户甲讨厌雨天' });
  assert.equal(conflict.status, 'rejected');
  assert.equal(conflict.reason, 'content-conflict');
  assert.equal(conflict.receiptId, first.receiptId, '冲突必须回报原收据');
  assert.equal(conflict.recordId, first.recordId);

  assert.equal(count(db, 'memories'), 1);
  assert.equal(count(db, 'source_events'), 1, '冲突请求不得写第二行证据');
  assert.equal(count(db, 'domain_event_receipts'), 1);
  assert.equal(db.getMemory(first.recordId).value, request.content, '原记录正文不得被覆盖');
  assert.equal(evidenceFor(db, first.recordId)[0].content, request.content);
});

test('same tuple, same content retried: duplicate with the original receipt and exactly one record', async t => {
  const { engine, db } = await makeEngine(t);
  const request = ingestRequest();

  const first = await engine.ingestDomainEvent(request);
  assert.equal(first.status, 'accepted');
  const retry = await engine.ingestDomainEvent(request);

  assert.equal(retry.status, 'duplicate');
  assert.equal(retry.reason, 'dedupe-hit');
  assert.equal(retry.receiptId, first.receiptId);
  assert.equal(retry.recordId, first.recordId);

  assert.equal(count(db, 'memories'), 1);
  assert.equal(count(db, 'source_events'), 1);
  assert.equal(count(db, 'memory_evidence'), 1);
  assert.equal(count(db, 'domain_event_receipts'), 1);
});

test('a legacy unscoped evidence row is never reused by a scoped ingest', async t => {
  const { engine, db } = await makeEngine(t);
  // Rows written before the B1 fix used `runtime:<ns>:<id>:<ver>` and carried no
  // scope. They must stay untouched and must never be linked by a new ingest.
  const legacy = db.appendEvent({
    eventKey: `runtime:${NAMESPACE}:${EVENT_ID}:${TRANSFORM_VERSION}`,
    role: 'runtime',
    sourceKind: 'system',
    occurredAt: T0,
    content: '旧版无作用域的证据正文',
    userId: USER_A,
    personaId: PERSONA,
    worldId: '',
  });
  assert.equal(legacy.inserted, true);

  const contentB = '用户乙的新证据';
  const result = await engine.ingestDomainEvent(ingestRequest({
    subject: { userId: USER_A, personaId: PERSONA, worldId: '' },
    content: contentB,
  }));
  assert.equal(result.status, 'accepted');

  const rows = evidenceFor(db, result.recordId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].content, contentB, '不得复用旧版无作用域证据的正文');
  assert.notEqual(rows[0].source_id, legacy.sourceId);
  assert.match(rows[0].event_key, /^runtime-scoped:/);
  assert.equal(count(db, 'source_events'), 2);
  assert.equal(db.getEvent(legacy.sourceId).content, '旧版无作用域的证据正文', '旧证据必须原样保留');
});

test('an existing evidence row with a different subject or text is rejected instead of linked', async t => {
  const { engine, db } = await makeEngine(t);
  const request = ingestRequest();
  const first = await engine.ingestDomainEvent(request);
  assert.equal(first.status, 'accepted');

  // Simulate an integrity break: the receipt is gone while the evidence row stays.
  // A fresh ingest then reaches the evidence layer and must detect the mismatch.
  db.handle.prepare('DELETE FROM domain_event_receipts').run();

  const conflict = await engine.ingestDomainEvent({ ...request, content: '用户甲其实喜欢晴天' });
  assert.equal(conflict.status, 'rejected');
  assert.equal(conflict.reason, 'evidence-conflict');
  assert.equal(conflict.receiptId, '', '完整性拒绝不声称持久化收据');
  assert.equal(conflict.recordId, undefined);

  assert.equal(count(db, 'memories'), 1);
  assert.equal(count(db, 'source_events'), 1, '不得追加第二行证据');
  assert.equal(count(db, 'domain_event_receipts'), 0, '证据冲突不写收据');
  assert.equal(evidenceFor(db, first.recordId)[0].content, request.content);

  // A subject change on an existing row is caught the same way.
  db.upsertIdentity({ userId: USER_B, displayName: '第二位用户', platform: 'local' });
  const subjectConflict = await engine.ingestDomainEvent({
    ...request,
    subject: { userId: USER_B, personaId: PERSONA, worldId: '' },
  });
  assert.equal(subjectConflict.status, 'accepted', '主体不同就是不同证据键，不得被判冲突');
  assert.equal(count(db, 'source_events'), 2);
});
