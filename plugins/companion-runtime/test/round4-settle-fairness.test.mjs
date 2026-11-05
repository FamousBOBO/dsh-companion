import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openRuntimeDb } from '../lib/db.mjs';
import { scopeKey as scopeKeyOf } from '../lib/scope.mjs';
import { mountRuntime } from '../index.mjs';

// 第四轮 B2：`sent ⇒ applied` 曾会误报，且 settle 扫描会队头阻塞。
//
// `mountRuntime` 总是自己打开数据库（`options.dbFile`），所以这里给它一个**文件**，然后用第二个句柄
// 直接种入"待结算的裁决 + 已投递的 outbox 行"，并读回持久化的裁决状态 —— 断言的是库里的东西。

const T0 = Date.UTC(2026, 10, 17, 3, 0, 0);
const SCOPE = Object.freeze({ userId: 'owner-1', personaId: 'bot', worldId: 'world:default' });
const KEY = scopeKeyOf(SCOPE);
const RESOLVED = 'p2_correction_resolved:';

function world(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-settle-'));
  fs.mkdirSync(path.join(root, 'home', 'companion'), { recursive: true });
  fs.writeFileSync(path.join(root, 'home', 'companion', 'runtime.config.json'), JSON.stringify({
    enabled: true, mode: 'active', timeZone: 'Asia/Shanghai',
    p2: { activities: { enabled: true }, planning: { enabled: true }, share: { enabled: false } },
  }, null, 2), 'utf8');
  const dbFile = path.join(root, 'home', 'companion', 'runtime.db');
  const identity = {
    owner: () => ({ id: 'owner-1', displayName: 'owner-1', platform: 'local' }),
    resolve: sessionId => ({ userId: 'owner-1', personaId: 'bot', displayName: 'owner-1', sessionId }),
  };
  const runtime = mountRuntime(null, root, { memory: null, identity, dbFile, now: () => T0 });
  t.after(() => { try { runtime.dispose?.(); } catch { /* disposed */ } });
  const db = openRuntimeDb({ file: dbFile, now: () => T0 });
  t.after(() => {
    try { db.close(); } catch { /* closed */ }
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ }
  });
  return { db, runtime, root };
}

/** Plant one open adjudication plus the outbox row that delivered it. */
function plant(db, { id, requestId, wanted, receipt, at = T0 }) {
  db.run(`INSERT INTO runtime_meta (meta_key, meta_value, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value, updated_at = excluded.updated_at`,
  `${RESOLVED}${id}`, JSON.stringify({
    recordId: id, requestId, supersedeIds: wanted, outcome: 'resolved-pending-apply', requestedAt: at,
  }), at);
  if (requestId) {
    db.run(`INSERT INTO memory_outbox (outbox_id, scope, event_id, namespace, payload, status, receipt_id, attempts, last_error, claimed_until, claim_owner, created_at, updated_at)
            VALUES (?, ?, ?, 'companion.correction', '{}', 'sent', 'rcpt-1', 1, '', 0, '', ?, ?)`,
    `out_${id}`, KEY, requestId, at, at);
    if (receipt) {
      db.run(`INSERT INTO runtime_meta (meta_key, meta_value, updated_at) VALUES (?, ?, ?)
              ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value, updated_at = excluded.updated_at`,
      `p2_correction_apply:${requestId}`, JSON.stringify(receipt), at);
    }
  }
}

function auditOf(db, id) {
  try { return JSON.parse(String(db.metaGet(`${RESOLVED}${id}`, '') || '{}')); } catch { return {}; }
}

test('B2：已发送但压旧没生效 → needs-review（不是 applied），并如实列出没压的 id', t => {
  const { db, runtime } = world(t);
  plant(db, { id: 'rec-1', requestId: 'req-1', wanted: ['mem_a', 'mem_b'], receipt: { applied: ['mem_a'], duplicate: [], notApplied: ['mem_b'], reason: 'supersede-write-failed', at: T0 } });
  const out = runtime.settleCorrectionResolutions({ limit: 10 });
  assert.ok(out, 'the runtime must expose the settle step');
  const audit = auditOf(db, 'rec-1');
  assert.equal(audit.outcome, 'needs-review', `a partial supersede must not be reported as applied (got ${JSON.stringify(audit)})`);
  assert.deepEqual(audit.missingIds, ['mem_b'], 'and it must name the id that did not take effect');
  assert.deepEqual(audit.appliedIds, ['mem_a'], 'while keeping what really was applied');
});

test('B2：全部压掉 → resolved-applied，并记录真实 id', t => {
  const { db, runtime } = world(t);
  plant(db, { id: 'rec-2', requestId: 'req-2', wanted: ['mem_a', 'mem_b'], receipt: { applied: ['mem_a', 'mem_b'], duplicate: [], notApplied: [], reason: 'correction-superseded', at: T0 } });
  runtime.settleCorrectionResolutions({ limit: 10 });
  const audit = auditOf(db, 'rec-2');
  assert.equal(audit.outcome, 'resolved-applied');
  assert.deepEqual(audit.appliedIds, ['mem_a', 'mem_b']);
});

test('B2：队头不再阻塞 —— 10 条永久失败 + 1 条可结算，后者仍被 settle', t => {
  const { db, runtime } = world(t);
  for (let i = 0; i < 10; i += 1) {
    plant(db, {
      id: `stuck-${i}`, requestId: `req-stuck-${i}`, wanted: [`mem_x${i}`],
      receipt: { applied: [], duplicate: [], notApplied: [`mem_x${i}`], reason: 'supersede-write-failed', at: T0 }, at: T0 - 1000 * (10 - i),
    });
  }
  plant(db, { id: 'fresh', requestId: 'req-fresh', wanted: ['mem_ok'], receipt: { applied: ['mem_ok'], duplicate: [], notApplied: [], reason: 'correction-superseded', at: T0 }, at: T0 });
  for (let pass = 0; pass < 3; pass += 1) runtime.settleCorrectionResolutions({ limit: 10 });
  const fresh = auditOf(db, 'fresh');
  assert.equal(fresh.outcome, 'resolved-applied', `a stuck head must not block a later adjudication (got ${JSON.stringify(fresh)})`);
  assert.equal(auditOf(db, 'stuck-0').outcome, 'needs-review', 'the stuck one is terminal, so it leaves the queue');
});

test('A3: the public resolveEffect forwards `reason` (static contract check)', () => {
  // Honest scope: this is a STATIC contract check, not behavioural evidence. A real same-generation
  // timeout convergence needs a prepared effect with an expired deadline (the controller layer covers
  // that in round3-rt); here we only pin down that the public wrapper does not swallow the parameter.
  const source = fs.readFileSync(new URL('../index.mjs', import.meta.url), 'utf8');
  const from = source.indexOf('  function resolveEffect(input = {}) {');
  assert.ok(from > 0, 'the public resolveEffect must exist');
  const body = source.slice(from, source.indexOf('\n  }\n', from));
  assert.equal(body.indexOf('input.reason') > -1, true, 'the wrapper must pass reason through');
});

test('恢复路径：needs-review 可以被人工 retry / accept-partial / reject，且留下审计', t => {
  const { db, runtime } = world(t);
  plant(db, { id: 'rec-r', requestId: 'req-r', wanted: ['mem_a', 'mem_b'], receipt: { applied: ['mem_a'], duplicate: [], notApplied: ['mem_b'], reason: 'supersede-write-failed', at: T0 } });
  runtime.settleCorrectionResolutions({ limit: 10 });
  assert.equal(auditOf(db, 'rec-r').outcome, 'needs-review');

  // An operator decision needs an operator and evidence (same discipline as resolveEffect).
  assert.equal(runtime.resolveCorrection({ resolutionId: 'rec-r', decision: 'retry', operator: '', evidence: 'x' }).code, 'operator-required');
  assert.equal(runtime.resolveCorrection({ resolutionId: 'rec-r', decision: 'retry', operator: 'owner', evidence: '' }).code, 'evidence-required');
  assert.equal(runtime.resolveCorrection({ resolutionId: 'rec-r', decision: 'nonsense', operator: 'owner', evidence: 'x' }).code, 'invalid-decision');

  // round-5 review: `retry` is not a counter reset any more — it must re-drive the delivery, so a
  // request with no delivered outbox row is refused instead of quietly pretending.
  const notRetryable = runtime.resolveCorrection({ resolutionId: 'rec-r', decision: 'retry', operator: 'owner', evidence: 'x' });
  assert.equal(notRetryable.ok, true, 'the planted request was delivered, so this one *is* retryable');
  void notRetryable;

  const afterRetry = auditOf(db, 'rec-r');
  assert.equal(afterRetry.outcome, 'resolved-pending-apply', 'retry puts it back in the settle queue');
  assert.equal(afterRetry.reason, 'operator-retry');
  assert.equal(afterRetry.reviewedBy, 'owner');
  assert.equal(afterRetry.reviewHistory.length, 1, 'the transition is audited');
  assert.equal(db.get("SELECT meta_value FROM runtime_meta WHERE meta_key = 'p2_correction_apply:req-r'"), undefined,
    'the stale receipt is dropped so the settle step cannot read the old failure again');
  assert.equal(String(db.get("SELECT status FROM memory_outbox WHERE event_id = 'req-r'")?.status), 'queued',
    'and the request is really back in the queue');

  // …and with the receipt gone there is nothing to accept yet (round-5: zero applied ⇒ refuse).
  const acceptTooEarly = runtime.resolveCorrection({ resolutionId: 'rec-r', decision: 'accept-partial', operator: 'owner', evidence: '只接受 mem_a' });
  assert.equal(acceptTooEarly.ok, false, `accept-partial needs at least one real id (got ${JSON.stringify(acceptTooEarly)})`);
  assert.equal(acceptTooEarly.code, 'nothing-applied');

  // Simulate the re-delivery: mark the row sent again and plant a fresh receipt.
  db.run("UPDATE memory_outbox SET status = 'sent' WHERE event_id = 'req-r'");
  db.run(`INSERT INTO runtime_meta (meta_key, meta_value, updated_at) VALUES ('p2_correction_apply:req-r', ?, ?)
          ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value, updated_at = excluded.updated_at`,
  JSON.stringify({ applied: ['mem_a'], duplicate: [], notApplied: ['mem_b'], reason: 'supersede-write-failed', at: T0 }), T0);

  const accepted = runtime.resolveCorrection({ resolutionId: 'rec-r', decision: 'accept-partial', operator: 'owner', evidence: '只接受 mem_a 的压旧' });
  assert.equal(accepted.outcome, 'resolved-applied');
  const afterAccept = auditOf(db, 'rec-r');
  assert.equal(afterAccept.acceptedPartial, true, 'a partial acceptance says so');
  assert.deepEqual(afterAccept.missingIds, ['mem_b'], 'and keeps what was missing');

  const rejected = runtime.resolveCorrection({ resolutionId: 'rec-r', decision: 'reject', operator: 'owner', evidence: '人工复核后拒绝' });
  assert.equal(rejected.outcome, 'failed');
  assert.equal(auditOf(db, 'rec-r').reviewHistory.length, 3);
});
