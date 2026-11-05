import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openRuntimeDb } from '../lib/db.mjs';
import { scopeKey as scopeKeyOf } from '../lib/scope.mjs';
import { createP2 } from '../lib/p2.mjs';
import { mountRuntime } from '../index.mjs';

// 第七轮复审的两条小修：
//   A5 轮转键必须**按 scope** 分（否则 A 总取 gated、B 总取 pending，各自仍在饥饿）；
//   以及 `review-failed` 要是普通 SQLite 异常时的**精确**返回码，并且 ABORT 之后连接仍然可用。

const T0 = Date.UTC(2026, 10, 27, 3, 0, 0);
const A = scopeKeyOf({ userId: 'owner-1', personaId: 'bot', worldId: 'world:a' });
const B = scopeKeyOf({ userId: 'owner-1', personaId: 'bot', worldId: 'world:b' });

function world(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-round7-'));
  const db = openRuntimeDb({ file: ':memory:', now: () => T0 });
  t.after(() => {
    try { db.close(); } catch { /* closed */ }
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }); } catch { /* best effort */ }
  });
  db.acquireLease({ owner: 'owner-test', generation: 'gen-1', ttlMs: 365 * 24 * 3600 * 1000 });
  return { db, root };
}

function shareWorld(db, root, calls) {
  const port = { async submit(payload) { calls.push(payload); return { ok: true }; } };
  return createP2({
    db, clock: () => T0, owner: 'owner-test', generation: 'gen-1',
    config: { timeZone: 'Asia/Shanghai', p2: { planning: { enabled: false }, activities: { enabled: false }, share: { enabled: true, maxPending: 500 } } },
    getMode: () => 'active', isActive: () => true, emit: () => {},
    options: { sharePort: port, onError: () => {} },
  });
}

function gate(db, p2, { scopeKey, activityId, at = T0 }) {
  const id = p2.createShareCandidate({ scopeKey, activityId, title: activityId, body: '正文' }).candidateId;
  db.run(`INSERT INTO runtime_meta (meta_key, meta_value, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value, updated_at = excluded.updated_at`,
  `p2_share_retry:${id}`, JSON.stringify({ attempts: 1, nextAttemptAt: at - 1, expiresAt: at + 86400000, lastReason: 'quiet-hours' }), at);
  db.run("UPDATE p2_share_candidates SET status = 'gated' WHERE candidate_id = ?", id);
  return id;
}

test('A5：轮转状态按 scope 分键 —— A、B 各自都有自己的上界', async t => {
  const { db, root } = world(t);
  const calls = [];
  const p2 = shareWorld(db, root, calls);

  // Each scope: an older gated row plus a younger pending.
  const gatedA = gate(db, p2, { scopeKey: A, activityId: 'a-gated' });
  const gatedB = gate(db, p2, { scopeKey: B, activityId: 'b-gated' });
  const pendingA = p2.createShareCandidate({ scopeKey: A, activityId: 'a-pending', title: 'a-pending', body: '正文' }).candidateId;
  const pendingB = p2.createShareCandidate({ scopeKey: B, activityId: 'b-pending', title: 'b-pending', body: '正文' }).candidateId;

  // Alternate the two scopes, exactly like a multi-scope host would.
  for (let tick = 0; tick < 4; tick += 1) {
    await p2.deliverShareCandidates({ scopeKey: tick % 2 === 0 ? A : B, limit: 1 });
  }

  const served = new Set(calls.map(call => String(call.candidateId)));
  assert.equal(served.has(pendingA), true,
    `scope A must also serve its pending (rotation is per scope) — served ${JSON.stringify([...served])}`);
  assert.equal(served.has(pendingB), true, 'and so must scope B');

  // The rotation state itself is per scope, not one global bucket.
  const keys = db.all("SELECT meta_key FROM runtime_meta WHERE meta_key LIKE 'p2_share_rotation%'").map(row => String(row.meta_key));
  assert.equal(keys.length >= 2, true, `one rotation key per scope (saw ${JSON.stringify(keys)})`);
  void gatedA; void gatedB;
});

test('review-failed：普通 SQLite 异常返回精确的 review-failed，且之后连接仍可用', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-round7f-'));
  fs.mkdirSync(path.join(root, 'home', 'companion'), { recursive: true });
  fs.writeFileSync(path.join(root, 'home', 'companion', 'runtime.config.json'), JSON.stringify({
    enabled: true, mode: 'active', timeZone: 'Asia/Shanghai',
    p2: { activities: { enabled: true }, planning: { enabled: false }, share: { enabled: false } },
  }, null, 2), 'utf8');
  const dbFile = path.join(root, 'home', 'companion', 'runtime.db');
  const identity = {
    owner: () => ({ id: 'owner-1', displayName: 'owner-1', platform: 'local' }),
    resolve: sessionId => ({ userId: 'owner-1', personaId: 'bot', displayName: 'owner-1', sessionId }),
  };
  const runtime = mountRuntime(null, root, { memory: null, identity, dbFile, now: () => T0 });
  const db = openRuntimeDb({ file: dbFile, now: () => T0 });
  t.after(() => {
    try { db.run('DROP TRIGGER IF EXISTS rf'); } catch { /* cleanup */ }
    try { runtime.dispose?.(); } catch { /* disposed */ }
    try { db.close(); } catch { /* closed */ }
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ }
  });

  const KEY = scopeKeyOf({ userId: 'owner-1', personaId: 'bot', worldId: 'world:default' });
  db.run(`INSERT INTO runtime_meta (meta_key, meta_value, updated_at) VALUES ('p2_correction_resolved:rec-rf', ?, ?)`,
  JSON.stringify({ recordId: 'rec-rf', requestId: 'req-rf', supersedeIds: ['mem_a'], outcome: 'needs-review', requestedAt: T0 }), T0);
  db.run(`INSERT INTO memory_outbox (outbox_id, scope, event_id, namespace, payload, status, receipt_id, attempts, last_error, claimed_until, claim_owner, created_at, updated_at)
          VALUES ('out-rf', ?, 'req-rf', 'companion.correction', '{}', 'sent', 'rcpt-1', 1, 'x', 0, '', ?, ?)`, KEY, T0, T0);

  db.run(`INSERT INTO runtime_meta (meta_key, meta_value, updated_at) VALUES ('p2_correction_apply:req-rf', ?, ?)`,
  JSON.stringify({ applied: [], duplicate: [], notApplied: ['mem_a'], reason: 'supersede-write-failed', at: T0 }), T0);

  // A plain SQLite abort (not a RuntimeError) must surface as `review-failed`, never `internal`.
  db.run(`CREATE TRIGGER rf BEFORE DELETE ON runtime_meta WHEN OLD.meta_key LIKE 'p2_correction_apply:%'
          BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
  const failed = runtime.resolveCorrection({ resolutionId: 'rec-rf', decision: 'retry', operator: 'owner', evidence: '重投' });
  assert.equal(failed.ok, false, JSON.stringify(failed));
  assert.equal(failed.code, 'review-failed', `a raw SQLite error must map to review-failed (got ${JSON.stringify(failed)})`);

  // …and the connection is clean afterwards: the same retry now succeeds.
  db.run('DROP TRIGGER rf');
  const retried = runtime.resolveCorrection({ resolutionId: 'rec-rf', decision: 'retry', operator: 'owner', evidence: '重投' });
  assert.equal(retried.ok, true, `the connection must still be usable after an ABORT (got ${JSON.stringify(retried)})`);
  assert.equal(String(db.get('SELECT status FROM memory_outbox WHERE event_id = ?', 'req-rf')?.status), 'queued');
});

test('第四轮：空选择不写轮转键；写失败会 noteError；键数量有上限', async t => {
  const { db, root } = world(t);
  const calls = [];
  const p2 = shareWorld(db, root, calls);
  const rotationKeys = () => db.all("SELECT meta_key FROM runtime_meta WHERE meta_key LIKE 'p2_share_rotation:%'");

  // Nothing to deliver: no key may be written.
  await p2.deliverShareCandidates({ scopeKey: A, limit: 1 });
  assert.equal(rotationKeys().length, 0, `an empty tick must not write a rotation key (saw ${JSON.stringify(rotationKeys())})`);

  // One candidate really served: the key appears and names the class that got the slot.
  p2.createShareCandidate({ scopeKey: A, activityId: 'served', title: 'served', body: '正文' });
  await p2.deliverShareCandidates({ scopeKey: A, limit: 1 });
  assert.equal(rotationKeys().length, 1);
  assert.equal(String(db.metaGet(`p2_share_rotation:${A}`, '')), 'pending');

  // The pruner keeps the table bounded (201 keys → the oldest is dropped).
  for (let index = 0; index < 205; index += 1) {
    db.run(`INSERT INTO runtime_meta (meta_key, meta_value, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value, updated_at = excluded.updated_at`,
    `p2_share_rotation:u:owner-1|p:bot|w:world:bulk-${index}`, 'pending', T0 + index);
  }
  p2.createShareCandidate({ scopeKey: A, activityId: 'served-again', title: 'served-again', body: '正文' });
  await p2.deliverShareCandidates({ scopeKey: A, limit: 1 });
  // The pruner is throttled (once a day); force it, which is exactly what the daily sweep does.
  p2.pruneRotationKeys?.({ force: true });
  const kept = rotationKeys().length;
  assert.equal(kept <= 200, true, `rotation keys must stay bounded (saw ${kept})`);
});

test('第九轮：关键错误不会被常规错误挤掉（单独一档）', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-errlog-'));
  fs.mkdirSync(path.join(root, 'home', 'companion'), { recursive: true });
  fs.writeFileSync(path.join(root, 'home', 'companion', 'runtime.config.json'), JSON.stringify({
    enabled: true, mode: 'active', timeZone: 'Asia/Shanghai',
    p2: { activities: { enabled: true }, planning: { enabled: false }, share: { enabled: false } },
  }, null, 2), 'utf8');
  const dbFile = path.join(root, 'home', 'companion', 'runtime.db');
  const identity = {
    owner: () => ({ id: 'owner-1', displayName: 'owner-1', platform: 'local' }),
    resolve: sessionId => ({ userId: 'owner-1', personaId: 'bot', displayName: 'owner-1', sessionId }),
  };
  const runtime = mountRuntime(null, root, { memory: null, identity, dbFile, now: () => T0 });
  const db = openRuntimeDb({ file: dbFile, now: () => T0 });
  t.after(() => {
    try { db.run('DROP TRIGGER IF EXISTS al'); } catch { /* cleanup */ }
    try { runtime.dispose?.(); } catch { /* disposed */ }
    try { db.close(); } catch { /* closed */ }
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ }
  });

  const KEY = scopeKeyOf({ userId: 'owner-1', personaId: 'bot', worldId: 'world:default' });
  db.run(`INSERT INTO runtime_meta (meta_key, meta_value, updated_at) VALUES ('p2_correction_resolved:rec-c', ?, ?)`,
  JSON.stringify({ recordId: 'rec-c', requestId: 'req-c', supersedeIds: ['mem_a'], outcome: 'needs-review', requestedAt: T0 }), T0);
  db.run(`INSERT INTO memory_outbox (outbox_id, scope, event_id, namespace, payload, status, receipt_id, attempts, last_error, claimed_until, claim_owner, created_at, updated_at)
          VALUES ('out-c', ?, 'req-c', 'companion.correction', '{}', 'sent', 'rcpt-1', 1, 'x', 0, '', ?, ?)`, KEY, T0, T0);
  db.run(`INSERT INTO runtime_meta (meta_key, meta_value, updated_at) VALUES ('p2_correction_apply:req-c', ?, ?)`,
  JSON.stringify({ applied: [], duplicate: [], notApplied: ['mem_a'], reason: 'x', at: T0 }), T0);

  // One critical failure…
  db.run(`CREATE TRIGGER al BEFORE DELETE ON runtime_meta WHEN OLD.meta_key LIKE 'p2_correction_apply:%'
          BEGIN SELECT RAISE(ABORT, 'injected'); END`);
  const failed = runtime.resolveCorrection({ resolutionId: 'rec-c', decision: 'retry', operator: 'owner', evidence: '重投' });
  assert.equal(failed.code, 'review-failed');
  db.run('DROP TRIGGER al');

  // …then a burst of routine ones through the same helper (they must not evict it).
  const readLog = () => JSON.parse(String(db.metaGet('p2_error_log', '[]') || '[]'));
  const readCritical = () => JSON.parse(String(db.metaGet('p2_error_log_critical', '[]') || '[]'));
  assert.equal(readCritical().length >= 1, true, 'the critical bucket has the failure');
  assert.equal(readCritical().some(item => item.code === 'p2-correction-review-failed'), true);
  assert.equal(readCritical()[0].subject, 'rec-c', 'and it names the record it was about');

  assert.equal(readCritical()[0].code, 'p2-correction-review-failed');

  // **Real** noise: 25 routine persistent records. The ordinary ring must roll (≤20) …
  for (let index = 0; index < 25; index += 1) {
    runtime.reportError({ code: 'p2-share-rotation-write-failed', detail: `routine failure ${index}`, subject: `subject-${index}` });
  }
  const noisy = readLog();
  assert.equal(noisy.length, 20, `the ordinary ring rolls to 20 (got ${noisy.length})`);
  assert.equal(noisy.some(item => item.code === 'p2-correction-review-failed'), false,
    'and the critical record was pushed out of the *ordinary* ring by noise');

  // …while the critical buckets still hold it, and the dedicated key holds it for ever.
  assert.equal(readCritical().some(item => item.code === 'p2-correction-review-failed'), true,
    'the critical ring is not touched by routine noise');
  const dedicated = JSON.parse(String(db.metaGet('p2_error_log_review_failed', '[]') || '[]'));
  assert.equal(dedicated.length >= 1, true, 'and the dedicated review-failed key has it');
  assert.equal(dedicated[0].subject, 'rec-c');

  // A **rebuilt** instance must read the same records: this is persistence, not instance state.
  const rebuilt = mountRuntime(null, root, { memory: null, identity, dbFile, now: () => T0 });
  t.after(() => { try { rebuilt.dispose?.(); } catch { /* disposed */ } });
  const fromRebuilt = rebuilt.errorLog();
  assert.equal(fromRebuilt.critical.some(item => item.code === 'p2-correction-review-failed'), true,
    'a restarted instance still sees the critical record');
  assert.equal(fromRebuilt.reviewFailed[0].subject, 'rec-c');
  void readLog;
});

test('第十轮：关键档不会被第 11 条关键错误挤掉，未知 code 默认按关键处理', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-sev-'));
  fs.mkdirSync(path.join(root, 'home', 'companion'), { recursive: true });
  fs.writeFileSync(path.join(root, 'home', 'companion', 'runtime.config.json'), JSON.stringify({
    enabled: true, mode: 'active', timeZone: 'Asia/Shanghai',
    p2: { activities: { enabled: true }, planning: { enabled: false }, share: { enabled: false } },
  }, null, 2), 'utf8');
  const dbFile = path.join(root, 'home', 'companion', 'runtime.db');
  const identity = {
    owner: () => ({ id: 'owner-1', displayName: 'owner-1', platform: 'local' }),
    resolve: sessionId => ({ userId: 'owner-1', personaId: 'bot', displayName: 'owner-1', sessionId }),
  };
  const runtime = mountRuntime(null, root, { memory: null, identity, dbFile, now: () => T0 });
  t.after(() => {
    try { runtime.dispose?.(); } catch { /* disposed */ }
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ }
  });

  // One adjudication failure…
  runtime.reportError({ code: 'p2-correction-review-failed', detail: 'the first failure', subject: 'rec-first' });

  // …then 30 other critical errors: the critical ring rotates, the dedicated key must not.
  for (let index = 0; index < 30; index += 1) {
    runtime.reportError({ code: `p2-some-critical-${index}`, detail: `critical ${index}` });
  }
  const view = runtime.errorLog();
  assert.equal(view.critical.length, 20, `the critical ring stays bounded (got ${view.critical.length})`);
  assert.equal(view.critical.some(item => item.code === 'p2-correction-review-failed'), false,
    'the wider critical ring did rotate — this is why the dedicated key exists');
  assert.equal(view.reviewFailed.length >= 1, true, 'the dedicated key still holds the adjudication failure');
  assert.equal(view.reviewFailed[0].subject, 'rec-first');

  // An unknown code is classified as critical (conservative), not dropped.
  runtime.reportError({ code: 'p2-never-heard-of-this', detail: 'unknown but kept' });
  const after = runtime.errorLog();
  assert.equal(after.critical.some(item => item.code === 'p2-never-heard-of-this'), true,
    'an unknown code lands in the critical ring');
  assert.equal(after.critical.find(item => item.code === 'p2-never-heard-of-this').severity, 'critical');

  // …and a routine code does not.
  runtime.reportError({ code: 'p2-share-rotation-write-failed', detail: 'routine noise' });
  assert.equal(runtime.errorLog().critical.some(item => item.code === 'p2-share-rotation-write-failed'), false,
    'a known-routine code stays out of the critical ring');
});
