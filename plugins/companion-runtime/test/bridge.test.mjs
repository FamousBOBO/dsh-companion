import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openRuntimeDb } from '../lib/db.mjs';
import { normalizeEvent, applyEvent, receiptFor } from '../lib/events.mjs';
import { normalizeScope, scopeKey } from '../lib/scope.mjs';
import { enqueueIngest, applyBridgeEvent, drainOutbox, outboxStats, outboxIdFor } from '../lib/bridge.mjs';
import { createMemoryEngine } from '../../companion-memory/index.mjs';

// A11 + cross-database idempotence. Every test runs in a throwaway temp root with a
// synthetic owner id: the production `home/` directory is never opened and no model
// is ever called. The memory side is either the real engine over a temp SQLite file
// or an explicit fake, so a degraded service can be reproduced deterministically.

const T0 = Date.UTC(2026, 9, 29, 2, 0, 0);
const USER = 'bridge_user';
const PERSONA = 'march7';
const SCOPE = Object.freeze({ userId: USER, personaId: PERSONA, worldId: '' });
// The runtime normalises an empty worldId to `world:default`; the outbox stores
// that normalised key, so the test oracle must use it too.
const RUNTIME_SCOPE = normalizeScope(SCOPE);
const KEY = scopeKey(RUNTIME_SCOPE);

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Registered last, so any database handle registered before it closes first. */
function removeDir(t, dir) {
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch { /* a Windows lock leftover must not fail an assertion */ }
  });
}

function identityStub(userId = USER) {
  return {
    owner() {
      return { id: userId, displayName: '桥接测试用户', platform: 'local' };
    },
    resolve(sessionId) {
      return { userId, personaId: PERSONA, displayName: '桥接测试用户', sessionId };
    },
  };
}

/** Real memory engine over a temp root; background wiki/embedding work is off. */
async function makeMemory(t, { userId = USER } = {}) {
  const root = makeTempDir('dsh-bridge-memory-');
  const configFile = path.join(root, 'home', 'companion', 'memory.config.json');
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify({
    backend: 'sqlite',
    database: 'home/memory/companion-memory.db',
    wiki: { enabled: false },
    extraction: { enabled: false },
    retrieval: { semanticEnabled: false },
  }, null, 2), 'utf8');
  const engine = createMemoryEngine({ root, identity: identityStub(userId), env: {}, now: () => T0 });
  // Close the database before removing its directory (Windows keeps file locks).
  t.after(async () => {
    try { await engine.close(); } catch { /* cleanup only */ }
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* cleanup only */ }
  });
  await engine.initialize();
  return engine;
}

function makeRuntime(t, { file = ':memory:', generation = 'gen-bridge' } = {}) {
  const db = openRuntimeDb({ file, now: () => T0 });
  db.acquireLease({ owner: 'bridge-test-owner', generation, ttlMs: 120000 });
  t.after(() => db.close());
  return db;
}

async function memoryDb(engine) {
  const internal = await engine.internal();
  return internal.db;
}

async function memories(engine) {
  const db = await memoryDb(engine);
  return db.handle
    .prepare('SELECT id, status, kind, reality_level, mention_policy, value, dedupe_key FROM memories ORDER BY created_at ASC, id ASC')
    .all();
}

async function receipts(engine) {
  const db = await memoryDb(engine);
  return db.handle.prepare('SELECT * FROM domain_event_receipts ORDER BY created_at ASC, receipt_id ASC').all();
}

async function scalar(engine, sql) {
  const db = await memoryDb(engine);
  return Number(db.handle.prepare(sql).get().n);
}

function ingestRequest(overrides = {}) {
  return {
    subject: { ...SCOPE },
    namespace: 'companion.event',
    eventId: 'evt_bridge_1',
    transformVersion: 't1',
    rootEvidenceIds: ['evt_root_a', 'evt_root_b'],
    realityStatus: 'actual_tool_activity',
    evidenceStatus: 'confirmed',
    content: '用户喜欢在雨天散步',
    occurredAt: T0,
    ...overrides,
  };
}

function ingestEvent({ eventId = 'evt_bridge_1', occurredAt = T0, realityStatus = 'actual_tool_activity', evidenceStatus = 'confirmed', content = '用户喜欢在雨天散步', payload = {} } = {}) {
  return normalizeEvent({
    kind: 'memory/ingest-request',
    scope: SCOPE,
    occurredAt,
    realityStatus,
    evidenceStatus,
    payload: { content, transformVersion: 't1', ...payload },
  });
}

function deliver(db, event) {
  return applyEvent(db, { consumer: 'bridge', event, apply: args => applyBridgeEvent(args) });
}

function outboxRow(db, outboxId) {
  return outboxId
    ? db.get('SELECT * FROM memory_outbox WHERE outbox_id = ?', outboxId)
    : db.get('SELECT * FROM memory_outbox ORDER BY created_at ASC, outbox_id ASC LIMIT 1');
}

// ---------------------------------------------------------------------------
// memory side: public entry (CONTRACT.md §16)
// ---------------------------------------------------------------------------

test('accepted ingest stores one record, and a retry returns the original receipt', async t => {
  const engine = await makeMemory(t);
  const request = ingestRequest();

  const first = await engine.ingestDomainEvent(request);
  assert.equal(first.status, 'accepted');
  assert.match(first.receiptId, /^rcpt_/);
  assert.match(first.recordId, /^mem_/);
  assert.equal(first.reason, 'confirmed-observation');

  const rows = await memories(engine);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, first.recordId);
  assert.equal(rows[0].status, 'confirmed');
  assert.equal(rows[0].kind, 'fact');
  assert.equal(rows[0].reality_level, 'explicit_user_statement');
  assert.equal(rows[0].mention_policy, 'direct');
  assert.equal(rows[0].value, request.content);
  // Own evidence row plus one link per root evidence id.
  assert.equal(await scalar(engine, 'SELECT COUNT(*) AS n FROM memory_evidence'), 3);

  const retry = await engine.ingestDomainEvent(request);
  assert.equal(retry.status, 'duplicate');
  assert.equal(retry.reason, 'dedupe-hit');
  assert.equal(retry.receiptId, first.receiptId);
  assert.equal(retry.recordId, first.recordId);
  assert.equal((await memories(engine)).length, 1, 'a retry must not insert a second record');
  assert.equal((await receipts(engine)).length, 1, 'a retry must not insert a second receipt');
  assert.equal(await scalar(engine, 'SELECT COUNT(*) AS n FROM memory_evidence'), 3);
});

test('the same dedupe key with different content is rejected and never overwrites', async t => {
  const engine = await makeMemory(t);
  const request = ingestRequest();
  const first = await engine.ingestDomainEvent(request);
  assert.equal(first.status, 'accepted');

  const conflict = await engine.ingestDomainEvent({ ...request, content: '用户讨厌雨天' });
  assert.equal(conflict.status, 'rejected');
  assert.equal(conflict.reason, 'content-conflict');
  assert.equal(conflict.receiptId, first.receiptId, 'the original receipt id is reported back');

  const rows = await memories(engine);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].value, request.content, 'the stored fact keeps its original value');
  const stored = await receipts(engine);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].status, 'accepted', 'a conflict does not rewrite the original receipt');
  assert.equal(stored[0].reason, 'confirmed-observation');

  const retry = await engine.ingestDomainEvent(request);
  assert.equal(retry.status, 'duplicate');
  assert.equal(retry.receiptId, first.receiptId);
});

test('inferred content stays a pending candidate; hypothetical and simulated stay out of memory', async t => {
  const engine = await makeMemory(t);

  const inferred = await engine.ingestDomainEvent(ingestRequest({
    eventId: 'evt_inferred', evidenceStatus: 'inferred',
    content: '用户可能喜欢手冲咖啡', mentionPolicy: 'direct',
  }));
  assert.equal(inferred.status, 'pending');
  assert.equal(inferred.reason, 'inferred-candidate');
  const inferredRow = (await memories(engine)).find(row => row.id === inferred.recordId);
  assert.equal(inferredRow.status, 'pending', 'inference never becomes a confirmed fact');
  assert.equal(inferredRow.reality_level, 'inferred');
  assert.equal(inferredRow.mention_policy, 'soft_echo', 'pending rows cannot be injected directly');
  const inferredRetry = await engine.ingestDomainEvent(ingestRequest({
    eventId: 'evt_inferred', evidenceStatus: 'inferred',
    content: '用户可能喜欢手冲咖啡', mentionPolicy: 'direct',
  }));
  assert.equal(inferredRetry.status, 'duplicate');

  const hypothetical = await engine.ingestDomainEvent(ingestRequest({
    eventId: 'evt_hypothetical', realityStatus: 'hypothetical', content: '如果用户明天去了月球',
  }));
  assert.equal(hypothetical.status, 'rejected');
  assert.equal(hypothetical.reason, 'non-actual-reality');
  assert.equal(hypothetical.recordId, undefined);

  const simulated = await engine.ingestDomainEvent(ingestRequest({
    eventId: 'evt_simulated', realityStatus: 'simulated_world', content: '剧情世界里用户是一位骑士',
  }));
  assert.equal(simulated.status, 'rejected');
  assert.equal(simulated.reason, 'non-actual-reality');

  assert.equal((await memories(engine)).length, 1, 'only the inferred candidate is stored');
  const stored = await receipts(engine);
  assert.equal(stored.length, 3, 'accepted-path receipt, pending receipt and two rejection receipts');
  assert.equal(stored.filter(row => row.status === 'rejected').length, 2);

  // A rejected request retried with the same key keeps its rejection decision.
  const retryHypothetical = await engine.ingestDomainEvent(ingestRequest({
    eventId: 'evt_hypothetical', realityStatus: 'hypothetical', content: '如果用户明天去了月球',
  }));
  assert.equal(retryHypothetical.status, 'rejected');
  assert.equal(retryHypothetical.reason, 'non-actual-reality');
  assert.equal(retryHypothetical.receiptId, hypothetical.receiptId);
});

test('scope is enforced inside memory: unbound subjects and fiction worlds are rejected', async t => {
  const engine = await makeMemory(t);

  const unbound = await engine.ingestDomainEvent(ingestRequest({
    eventId: 'evt_stranger', subject: { userId: 'stranger', personaId: PERSONA, worldId: '' },
  }));
  assert.equal(unbound.status, 'rejected');
  assert.equal(unbound.reason, 'unbound-subject');
  assert.equal(unbound.receiptId, '', 'no receipt is claimed for an unbound subject');

  const invalid = await engine.ingestDomainEvent(ingestRequest({
    eventId: 'evt_invalid', subject: { userId: '', personaId: PERSONA, worldId: '' },
  }));
  assert.equal(invalid.status, 'rejected');
  assert.equal(invalid.reason, 'invalid-subject');

  // The engine is single-persona: a foreign persona is unbound, never reattributed.
  const wrongPersona = await engine.ingestDomainEvent(ingestRequest({
    eventId: 'evt_persona', subject: { userId: USER, personaId: 'someone-else', worldId: '' },
  }));
  assert.equal(wrongPersona.status, 'rejected');
  assert.equal(wrongPersona.reason, 'unbound-subject');

  const fictionWorld = await engine.ingestDomainEvent(ingestRequest({
    eventId: 'evt_world', subject: { userId: USER, personaId: PERSONA, worldId: 'world:demo' },
  }));
  assert.equal(fictionWorld.status, 'rejected');
  assert.equal(fictionWorld.reason, 'world-scope-mismatch');

  // `world:default` is the runtime spelling of reality and is accepted as such.
  const defaultWorld = await engine.ingestDomainEvent(ingestRequest({
    eventId: 'evt_default_world', subject: { userId: USER, personaId: PERSONA, worldId: 'world:default' },
  }));
  assert.equal(defaultWorld.status, 'accepted');
  assert.equal(defaultWorld.reason, 'confirmed-observation');

  const stored = await memories(engine);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].id, defaultWorld.recordId);
  assert.equal((await receipts(engine)).length, 2, 'fiction-world and default-world requests are receipted');
});

test('degraded memory reports retryable_failure instead of claiming persistence', async t => {
  const root = makeTempDir('dsh-bridge-legacy-');
  const configFile = path.join(root, 'home', 'companion', 'memory.config.json');
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  // Legacy backend: the SQLite store is intentionally never opened.
  fs.writeFileSync(configFile, JSON.stringify({ backend: 'legacy' }, null, 2), 'utf8');
  const engine = createMemoryEngine({ root, identity: identityStub(), env: {}, now: () => T0 });
  t.after(async () => {
    try { await engine.close(); } catch { /* cleanup only */ }
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* cleanup only */ }
  });

  const result = await engine.ingestDomainEvent(ingestRequest());
  assert.equal(result.status, 'retryable_failure');
  assert.equal(result.reason, 'memory-unavailable');
  assert.equal(result.receiptId, '');
  assert.equal(result.recordId, undefined);
});

test('a failure mid-transaction leaves no half record and reports retryable_failure', async t => {
  const engine = await makeMemory(t);
  const db = await memoryDb(engine);
  const original = db.addEvidence;
  db.addEvidence = () => { throw new Error('simulated disk failure'); };
  t.after(() => { db.addEvidence = original; });

  const failed = await engine.ingestDomainEvent(ingestRequest({ eventId: 'evt_rollback' }));
  assert.equal(failed.status, 'retryable_failure');
  assert.equal(failed.reason, 'memory-write-failed');
  assert.equal(failed.receiptId, '');
  assert.equal(failed.recordId, undefined);
  db.addEvidence = original;

  // Evidence, record and receipt all rolled back: nothing half-written is left.
  assert.equal((await memories(engine)).length, 0);
  assert.equal((await receipts(engine)).length, 0);
  assert.equal(await scalar(engine, 'SELECT COUNT(*) AS n FROM source_events'), 0);

  // The same request succeeds once the store recovers; no residue blocks it.
  const retried = await engine.ingestDomainEvent(ingestRequest({ eventId: 'evt_rollback' }));
  assert.equal(retried.status, 'accepted');
  assert.equal((await memories(engine)).length, 1);
});

// ---------------------------------------------------------------------------
// runtime side: outbox reducer
// ---------------------------------------------------------------------------

test('applyBridgeEvent queues inside the consumer transaction and is idempotent', async t => {
  const db = makeRuntime(t);
  const event = ingestEvent({ content: '用户今天整理了资料' });

  const applied = deliver(db, event);
  assert.equal(applied.applied, true);
  assert.equal(applied.result.queued, true);
  assert.equal(applied.result.namespace, 'companion.event');
  assert.equal(applied.result.eventId, event.eventId);
  assert.equal(typeof applied.result.contentDigest, 'string');
  assert.equal(applied.result.content, undefined, 'the receipt holds ids only, never正文');
  assert.ok(receiptFor(db, 'bridge', event.eventId));

  const rows = db.all('SELECT * FROM memory_outbox');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'queued');
  assert.equal(rows[0].scope, KEY);
  assert.equal(rows[0].event_id, event.eventId);
  assert.equal(rows[0].namespace, 'companion.event');
  assert.equal(rows[0].attempts, 0);

  const replay = deliver(db, event);
  assert.equal(replay.duplicate, true);
  assert.equal(db.all('SELECT * FROM memory_outbox').length, 1, 'replay never queues twice');
  assert.equal(outboxStats(db, KEY).queued, 1);
});

test('a correction request queues under its own namespace', t => {
  const db = makeRuntime(t);
  const event = normalizeEvent({
    kind: 'memory/correction-request',
    scope: SCOPE,
    occurredAt: T0 + 1,
    realityStatus: 'actual_tool_activity',
    evidenceStatus: 'confirmed',
    payload: { content: '更正：用户其实不喜欢咖啡', transformVersion: 't1' },
  });
  const applied = deliver(db, event);
  assert.equal(applied.result.queued, true);
  assert.equal(applied.result.namespace, 'companion.correction');
  const row = outboxRow(db);
  assert.equal(row.namespace, 'companion.correction');
  assert.equal(row.status, 'queued');

  // A payload-level namespace (set by the runtime facade) wins over the default.
  const custom = normalizeEvent({
    kind: 'memory/ingest-request',
    scope: SCOPE,
    occurredAt: T0 + 2,
    realityStatus: 'actual_tool_activity',
    evidenceStatus: 'confirmed',
    payload: { content: '自定义命名空间的事件', namespace: 'companion.custom', transformVersion: 't1' },
  });
  deliver(db, custom);
  assert.equal(db.get('SELECT namespace FROM memory_outbox WHERE event_id = ?', custom.eventId).namespace, 'companion.custom');
});

test('enqueueIngest dedupes on (scope, eventId, namespace, transformVersion) and validates input', t => {
  const db = makeRuntime(t);
  const event = ingestEvent();
  const first = enqueueIngest(db, { scope: SCOPE, scopeKey: KEY, event });
  const second = enqueueIngest(db, { scope: SCOPE, scopeKey: KEY, event });
  assert.equal(first.outboxId, second.outboxId);
  assert.equal(first.queued, true);
  assert.equal(second.queued, false);
  assert.equal(first.outboxId, outboxIdFor({ scopeKey: KEY, eventId: event.eventId, namespace: 'companion.event', transformVersion: 't1' }));
  assert.equal(db.all('SELECT * FROM memory_outbox').length, 1);

  assert.throws(() => enqueueIngest(db, { scope: SCOPE, event: { ...event, payload: {} } }), /non-empty content/);
  assert.throws(() => enqueueIngest(db, { event }), /scope or scopeKey/);
});

// ---------------------------------------------------------------------------
// runtime side: drain (A11) and cross-database receipts
// ---------------------------------------------------------------------------

test('drainOutbox delivers to the real memory engine and never re-sends a receipted row', async t => {
  const engine = await makeMemory(t);
  const db = makeRuntime(t);
  const event = ingestEvent({ content: '用户今天整理了资料' });
  deliver(db, event);

  const first = await drainOutbox({ db, memory: engine, scopeKey: KEY, now: () => T0 + 1000 });
  assert.deepEqual(
    { processed: first.processed, delivered: first.delivered, rejected: first.rejected, retryable: first.retryable, queued: first.queued },
    { processed: 1, delivered: 1, rejected: 0, retryable: 0, queued: 0 },
  );
  const row = outboxRow(db);
  assert.equal(row.status, 'sent');
  assert.match(row.receipt_id, /^rcpt_/);
  assert.equal(row.attempts, 1);
  assert.equal(row.last_error, '');

  const memoryReceipts = await receipts(engine);
  assert.equal(memoryReceipts.length, 1);
  assert.equal(row.receipt_id, memoryReceipts[0].receipt_id, 'the memory receipt id is persisted in the outbox');
  const stored = await memories(engine);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].value, event.payload.content);

  const second = await drainOutbox({ db, memory: engine, scopeKey: KEY, now: () => T0 + 2000 });
  assert.equal(second.processed, 0, 'a delivered row is not drained twice');
  assert.equal(second.queued, 0);
});

test('R3: a record claimed by another drain is skipped until the claim expires', async t => {
  const db = makeRuntime(t);
  deliver(db, ingestEvent({ content: '合成内容：认领测试' }));
  const calls = [];
  const memory = {
    async ingestDomainEvent(request) {
      calls.push(request.eventId);
      return { status: 'accepted', receiptId: `rcpt_${calls.length}` };
    },
  };
  db.run("UPDATE memory_outbox SET claimed_until = ?, claim_owner = 'other-process'", T0 + 60000);
  const blocked = await drainOutbox({ db, memory, scopeKey: KEY, now: T0 + 1000 });
  assert.equal(blocked.processed, 0, 'another claimant owns the record');
  assert.equal(calls.length, 0, 'a claimed record is not handed to memory');

  const resumed = await drainOutbox({ db, memory, scopeKey: KEY, now: T0 + 61000 });
  assert.equal(resumed.processed, 1);
  assert.equal(resumed.delivered, 1);
  assert.equal(calls.length, 1, 'after the TTL the record is retried exactly once');
  assert.equal(outboxRow(db).status, 'sent');
  db.close();
});

test('R3/R4: a drain that lost its claim counts nothing and never releases the new claim', async t => {
  const db = makeRuntime(t);
  deliver(db, ingestEvent({ content: '合成内容：失去认领' }));
  const calls = [];
  const memory = {
    async ingestDomainEvent(request) {
      calls.push(request.eventId);
      // Another claimant takes the row while the call is in flight.
      db.run("UPDATE memory_outbox SET claim_owner = 'intruder', claimed_until = 0");
      return { status: 'accepted', receiptId: 'rcpt_intruder' };
    },
  };
  const summary = await drainOutbox({ db, memory, scopeKey: KEY, now: T0 + 1000 });
  assert.equal(calls.length, 1);
  assert.equal(summary.delivered, 0, 'a lost claim cannot be reported as delivered');
  assert.equal(summary.lostClaim, 1);
  assert.equal(summary.skipped, 'claim-lost');
  const row = outboxRow(db);
  assert.equal(row.status, 'queued', 'the record stays queued for the real claimant');
  assert.equal(row.claim_owner, 'intruder', 'the stale drain must not clear the newer claim');
  assert.equal(row.attempts, 0, 'no attempt is recorded by a drain that no longer owns the row');
  db.close();
});

test('R4: a stale drain cannot clear a newer claim while recording a failure', async t => {
  const db = makeRuntime(t);
  deliver(db, ingestEvent({ content: '合成内容：失败与认领' }));
  const memory = {
    async ingestDomainEvent() {
      db.run("UPDATE memory_outbox SET claim_owner = 'intruder', claimed_until = 0");
      throw Object.assign(new Error('memory hiccup'), { code: 'memory-unavailable' });
    },
  };
  const summary = await drainOutbox({ db, memory, scopeKey: KEY, now: T0 + 1000 });
  assert.equal(summary.lostClaim, 1);
  assert.equal(summary.retryable, 0, 'the failure belongs to the new claim, not this drain');
  const row = outboxRow(db);
  assert.equal(row.claim_owner, 'intruder');
  assert.equal(row.attempts, 0);
  assert.equal(row.last_error, '');
  db.close();
});

test('R3: concurrent drains on one database handle are serialized, so a slow call cannot expire a claim', async t => {
  const db = makeRuntime(t);
  deliver(db, ingestEvent({ content: '合成内容：串行甲' }));
  deliver(db, ingestEvent({ content: '合成内容：串行乙', eventId: 'evt_bridge_2' }));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const calls = [];
  let runtime;
  const memory = {
    async ingestDomainEvent(request) {
      calls.push(request.eventId);
      if (calls.length === 1) await gate;
      return { status: 'accepted', receiptId: `rcpt_${calls.length}` };
    },
  };
  const first = drainOutbox({ db, memory, scopeKey: KEY, now: T0 + 1000 });
  const second = drainOutbox({ db, memory, scopeKey: KEY, now: T0 + 61000 });
  await new Promise(resolve => setTimeout(resolve, 20));
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls.length, 2, `each record is delivered once: ${calls.join(',')}`);
  assert.equal(new Set(calls).size, 2, 'no record is delivered twice');
  assert.equal(a.delivered + b.delivered, 2, JSON.stringify({ a: a.delivered, b: b.delivered }));
  assert.equal(db.get("SELECT COUNT(*) AS n FROM memory_outbox WHERE status = 'sent'").n, 2);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM memory_outbox WHERE claim_owner <> ''").n, 0);
  db.close();
});

test('N-hang: a hung memory call times out, releases the claim, and a late answer cannot write', async t => {
  const db = makeRuntime(t);
  deliver(db, ingestEvent({ content: '合成内容：挂起超时' }));
  let releaseLate;
  let calls = 0;
  const memory = {
    async ingestDomainEvent() {
      calls += 1;
      return new Promise((resolve) => { releaseLate = () => resolve({ status: 'accepted', receiptId: 'late' }); });
    },
  };
  const summary = await drainOutbox({ db, memory, scopeKey: KEY, now: T0 + 1000, callTimeoutMs: 25 });
  assert.equal(summary.processed, 1);
  assert.equal(summary.timedOut, 1);
  assert.equal(summary.retryable, 1);
  assert.equal(summary.delivered, 0);
  assert.equal(summary.skipped, 'drain-timeout');
  let row = outboxRow(db);
  assert.equal(row.status, 'queued');
  assert.equal(row.attempts, 1);
  assert.equal(row.last_error, 'memory-timeout');
  assert.equal(row.claim_owner, '', 'the claim is released so a retry can proceed');

  // The abandoned call answers late: it must not rewrite the row.
  releaseLate();
  await new Promise(resolve => setTimeout(resolve, 10));
  row = outboxRow(db);
  assert.equal(row.status, 'queued');
  assert.equal(row.attempts, 1);
  assert.equal(row.receipt_id, '');
  assert.equal(row.last_error, 'memory-timeout');

  // A later drain with a healthy memory delivers it; memory dedupes by receipt.
  const healthy = {
    async ingestDomainEvent() { calls += 1; return { status: 'accepted', receiptId: 'rcpt_retry' }; },
  };
  const retried = await drainOutbox({ db, memory: healthy, scopeKey: KEY, now: T0 + 2000, callTimeoutMs: 1000 });
  assert.equal(retried.delivered, 1);
  assert.equal(outboxRow(db).status, 'sent');
  assert.equal(calls, 2, 'one hung call plus one successful retry');
  db.close();
});

test('the outbox receipt survives closing and reopening the runtime database; crash retry stays idempotent', async t => {
  const dir = makeTempDir('dsh-bridge-runtime-');
  const file = path.join(dir, 'runtime.db');
  const engine = await makeMemory(t);
  const db = makeRuntime(t, { file });
  deliver(db, ingestEvent({ content: '用户最近在准备考试' }));
  const queuedPayload = outboxRow(db).payload;
  const drained = await drainOutbox({ db, memory: engine, scopeKey: KEY, now: () => T0 + 1000 });
  assert.equal(drained.delivered, 1);
  const receiptId = outboxRow(db).receipt_id;
  db.close();

  const reopened = openRuntimeDb({ file, now: () => T0 + 5000 });
  t.after(() => reopened.close());
  removeDir(t, dir);
  const persisted = outboxRow(reopened);
  assert.equal(persisted.status, 'sent');
  assert.equal(persisted.receipt_id, receiptId);
  assert.equal(persisted.attempts, 1);
  // Delivered rows keep a digest, not the user's words: memory owns the record now.
  assert.doesNotMatch(persisted.payload, /准备考试/);
  assert.match(persisted.payload, /contentDigest/);

  // Simulate a crash where the delivery UPDATE never happened: the queued row (with
  // its content) is delivered again, memory answers with the original receipt and no
  // second record appears.
  reopened.run("UPDATE memory_outbox SET status = 'queued', receipt_id = '', attempts = 0, payload = ? WHERE outbox_id = ?",
    queuedPayload, persisted.outbox_id);
  const retried = await drainOutbox({ db: reopened, memory: engine, scopeKey: KEY, now: () => T0 + 6000 });
  assert.equal(retried.delivered, 1);
  const after = outboxRow(reopened);
  assert.equal(after.receipt_id, receiptId, 'the duplicate answer carries the original receipt');
  assert.equal(after.status, 'sent');
  assert.equal((await memories(engine)).length, 1, 'a retried delivery never inserts twice');
  assert.equal((await receipts(engine)).length, 1);
});

test('A11: missing or reloading memory keeps rows queued with attempt counters', async t => {
  const db = makeRuntime(t);
  const first = ingestEvent({ content: '用户喜欢在雨天散步' });
  const second = ingestEvent({ eventId: 'evt_bridge_2', occurredAt: T0 + 1, content: '用户在整理旧照片' });
  deliver(db, first);
  deliver(db, second);

  const missing = await drainOutbox({ db, memory: null, scopeKey: KEY, now: () => T0 });
  assert.equal(missing.skipped, 'memory-unavailable');
  assert.equal(missing.processed, 2);
  assert.equal(missing.retryable, 2);
  assert.equal(missing.delivered, 0);
  assert.equal(missing.queued, 2, 'rows stay queued when memory is missing');
  for (const row of db.all('SELECT * FROM memory_outbox')) {
    assert.equal(row.status, 'queued');
    assert.equal(row.attempts, 1);
    assert.equal(row.last_error, 'memory-unavailable');
    assert.equal(row.receipt_id, '');
  }

  // An object without the ingest method behaves like a missing service. The clock is advanced past
  // the retry backoff: a failed row is deliberately not eligible again inside it (§二.8).
  assert.ok(Number(db.get('SELECT claimed_until FROM memory_outbox LIMIT 1').claimed_until) > T0, 'the failed row is backed off');
  const methodless = await drainOutbox({ db, memory: {}, scopeKey: KEY, now: () => T0 + 120_000 });
  assert.equal(methodless.skipped, 'memory-unavailable');
  assert.equal(methodless.queued, 2);
  for (const row of db.all('SELECT * FROM memory_outbox')) {
    assert.equal(row.attempts, 2);
    assert.equal(row.status, 'queued');
  }

  // Recovery delivers exactly once per queued row.
  const fake = {
    calls: 0,
    async ingestDomainEvent() {
      fake.calls += 1;
      return { status: 'accepted', receiptId: 'rcpt_fake', recordId: 'mem_fake' };
    },
  };
  const recovered = await drainOutbox({ db, memory: fake, scopeKey: KEY, now: () => T0 + 240_000 });
  assert.equal(recovered.delivered, 2);
  assert.equal(recovered.queued, 0);
  assert.equal(fake.calls, 2);
  const stats = outboxStats(db, KEY);
  assert.equal(stats.total, 2);
  assert.equal(stats.queued, 0);
  assert.equal(stats.sent, 2);
  assert.equal(stats.failed, 0);
  assert.equal(stats.attempts, 6, 'two failed drains plus the successful drain per row');
  assert.equal(stats.lastError, '');
});

test('degraded memory that throws never raises out of the chat path and stores codes only', async t => {
  const db = makeRuntime(t);
  const secretish = '用户喜欢在雨天散步';
  deliver(db, ingestEvent({ content: secretish }));

  const throwing = {
    ingestDomainEvent() {
      throw new Error(`memory backend exploded while storing ${secretish}`);
    },
  };
  await assert.doesNotReject(drainOutbox({ db, memory: throwing, scopeKey: KEY, now: () => T0 }));
  let row = outboxRow(db);
  assert.equal(row.status, 'queued');
  assert.equal(row.attempts, 1);
  assert.equal(row.last_error, 'memory-threw');
  assert.ok(!row.last_error.includes(secretish), 'only reason codes are persisted, never content');

  const coded = {
    async ingestDomainEvent() {
      const error = new Error('db down');
      error.code = 'db-unavailable';
      throw error;
    },
  };
  // Past the backoff the row is eligible again (§二.8) — that is the "it is not lost" half.
  const second = await drainOutbox({ db, memory: coded, scopeKey: KEY, now: () => T0 + 120_000 });
  assert.equal(second.retryable, 1);
  row = outboxRow(db);
  assert.equal(row.status, 'queued');
  assert.equal(row.attempts, 2);
  assert.equal(row.last_error, 'db-unavailable');

  // A retryable_failure status is respected verbatim: still queued, never delivered.
  const retryable = { ingestDomainEvent: async () => ({ status: 'retryable_failure', receiptId: '', reason: 'memory-unavailable' }) };
  const third = await drainOutbox({ db, memory: retryable, scopeKey: KEY, now: () => T0 + 360_000 });
  assert.equal(third.delivered, 0);
  row = outboxRow(db);
  assert.equal(row.status, 'queued');
  assert.equal(row.attempts, 3);
  assert.equal(row.last_error, 'memory-unavailable');

  // A malformed answer is never treated as success.
  const garbage = { ingestDomainEvent: async () => null };
  const fourth = await drainOutbox({ db, memory: garbage, scopeKey: KEY, now: () => T0 + 900_000 });
  assert.equal(fourth.delivered, 0);
  assert.equal(fourth.retryable, 1);
  row = outboxRow(db);
  assert.equal(row.status, 'queued');
  assert.equal(row.attempts, 4);
  assert.equal(row.last_error, 'invalid-response');
  assert.equal(outboxStats(db, KEY).queued, 1);
});

test('a memory rejection is recorded once and never retried', async t => {
  const db = makeRuntime(t);
  deliver(db, ingestEvent({ realityStatus: 'hypothetical', content: '如果用户明天去了月球' }));
  const memory = {
    calls: 0,
    async ingestDomainEvent() {
      memory.calls += 1;
      return { status: 'rejected', receiptId: 'rcpt_rejected', reason: 'non-actual-reality' };
    },
  };
  const outcome = await drainOutbox({ db, memory, scopeKey: KEY, now: () => T0 });
  assert.equal(outcome.rejected, 1);
  assert.equal(outcome.delivered, 0);
  const row = outboxRow(db);
  assert.equal(row.status, 'failed');
  assert.equal(row.receipt_id, 'rcpt_rejected');
  assert.equal(row.last_error, 'non-actual-reality');

  const again = await drainOutbox({ db, memory, scopeKey: KEY, now: () => T0 + 1000 });
  assert.equal(again.processed, 0, 'rejected rows are terminal');
  assert.equal(memory.calls, 1);
  assert.equal(outboxStats(db, KEY).failed, 1);
});

test('bridge + real engine: inferred is delivered as pending, hypothetical is rejected', async t => {
  const engine = await makeMemory(t);
  const db = makeRuntime(t);
  const inferred = ingestEvent({
    eventId: 'evt_inferred', evidenceStatus: 'inferred', occurredAt: T0,
    content: '用户可能喜欢手冲咖啡',
  });
  const hypothetical = ingestEvent({
    eventId: 'evt_hypothetical', realityStatus: 'hypothetical', occurredAt: T0 + 1,
    content: '如果用户明天去了月球',
  });
  deliver(db, inferred);
  deliver(db, hypothetical);

  const outcome = await drainOutbox({ db, memory: engine, scopeKey: KEY, now: () => T0 + 1000 });
  assert.equal(outcome.processed, 2);
  assert.equal(outcome.delivered, 1);
  assert.equal(outcome.rejected, 1);
  assert.equal(outcome.queued, 0);

  const rows = new Map(db.all('SELECT * FROM memory_outbox').map(row => [row.event_id, row]));
  assert.equal(rows.get(inferred.eventId).status, 'sent');
  assert.equal(rows.get(hypothetical.eventId).status, 'failed');
  assert.equal(rows.get(hypothetical.eventId).last_error, 'non-actual-reality');
  assert.match(rows.get(inferred.eventId).receipt_id, /^rcpt_/);

  const stored = await memories(engine);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].status, 'pending');
  assert.equal(stored[0].reality_level, 'inferred');
  const memoryReceipts = await receipts(engine);
  assert.equal(memoryReceipts.length, 2);
  assert.deepEqual(memoryReceipts.map(row => row.status).sort(), ['pending', 'rejected']);
});

test('outboxStats exposes counts and reason codes only', async t => {
  const db = makeRuntime(t);
  deliver(db, ingestEvent({ content: '这是一条不该出现在诊断里的正文' }));
  const stats = outboxStats(db, KEY);
  assert.deepEqual(
    Object.keys(stats).sort(),
    ['attempts', 'failed', 'lastError', 'oldestQueuedAt', 'queued', 'scopeKey', 'sent', 'total'],
  );
  assert.equal(stats.scopeKey, KEY);
  assert.equal(stats.total, 1);
  assert.equal(stats.queued, 1);
  assert.equal(typeof stats.oldestQueuedAt, 'number');
  assert.ok(!JSON.stringify(stats).includes('不该出现在诊断里的正文'));
  const all = outboxStats(db);
  assert.equal(all.scopeKey, null);
  assert.equal(all.total, 1);
});
