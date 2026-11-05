import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { mountRuntime } from '../index.mjs';
import { createMemoryEngine } from '../../companion-memory/index.mjs';
import { openRuntimeDb } from '../lib/db.mjs';
import { scopeKey as scopeKeyOf } from '../lib/scope.mjs';

// 第五轮的两条"还缺的组合证据"：
//   A. `retry` 之后**真的跑一次 drain**，第二次投递确实发生、回执被重建（不是只把行放回队列）；
//   B. 跨库崩溃恢复的 **RT 侧**：重投让 RT 从 `needs-review` 走到 `resolved-applied`。
//
// 用真 memory 引擎 + 真 runtime + 文件库，断言读的是库里的字节。

const T0 = Date.UTC(2026, 10, 24, 3, 0, 0);
const SESSION = 'e2e-owner';
const RESOLVED = 'p2_correction_resolved:';
const SCOPE = Object.freeze({ userId: 'owner-1', personaId: 'bot', worldId: 'world:default' });
const KEY = scopeKeyOf(SCOPE);

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-e2e-'));
  for (const dir of ['home/companion', 'home/memory', 'logs', 'workspace']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, 'workspace/PERSONA.md'), 'bot', 'utf8');
  fs.writeFileSync(path.join(root, 'home/companion/runtime.config.json'), JSON.stringify({
    enabled: true, mode: 'active', timeZone: 'Asia/Shanghai',
    p2: { activities: { enabled: true }, planning: { enabled: false }, share: { enabled: false } },
  }, null, 2), 'utf8');
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

  const dbFile = path.join(root, 'home/companion', 'runtime.db');
  const runtime = mountRuntime(null, root, {
    now: () => T0,
    identity: {
      owner: () => ({ id: 'owner-1', displayName: 'owner-1', platform: 'local' }),
      resolve: sessionId => ({ userId: 'owner-1', personaId: 'bot', displayName: 'owner-1', sessionId }),
    },
    memory: engine,
    dbFile,
  });
  t.after(() => { try { runtime.dispose?.(); } catch { /* disposed */ } });

  const db = openRuntimeDb({ file: dbFile, now: () => T0 });
  t.after(() => { try { db.close(); } catch { /* closed */ } });
  const internal = await engine.internal();
  return { root, engine, runtime, db, memDb: internal.db };
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

const auditOf = (db, id) => {
  try { return JSON.parse(String(db.metaGet(`${RESOLVED}${id}`, '') || '{}')); } catch { return {}; }
};
const receiptOf = (db, requestId) => {
  try { return JSON.parse(String(db.metaGet(`p2_correction_apply:${requestId}`, '') || '{}')); } catch { return {}; }
};

/** Plant "delivered but not applied": an outbox row already `sent`, plus a failing receipt. */
function plantPending(db, { id, requestId, supersedeIds, payload, receipt }) {
  // Mirrors `events.mjs` exactly: the runtime stores reality in `reality_status`, and the bridge reads
  // it back from there — a planted row with the wrong column would look hypothetical and be refused.
  db.run(`INSERT INTO domain_events (seq, event_id, schema_version, kind, scope, user_id, persona_id, world_id,
                session_id, occurred_at, recorded_at, correlation_id, causation_id, root_evidence,
                reality_status, evidence_status, config_version, model_version, payload)
          VALUES (?, ?, 1, 'memory/ingest-request', ?, 'owner-1', 'bot', 'world:default',
                  '', ?, ?, '', '', '[]', 'actual_tool_activity', 'confirmed', '', '', ?)`,
  900000 + requestId.length, requestId, KEY, T0, T0, JSON.stringify(payload));
  db.run(`INSERT INTO runtime_meta (meta_key, meta_value, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value, updated_at = excluded.updated_at`,
  `${RESOLVED}${id}`, JSON.stringify({
    recordId: id, requestId, supersedeIds, outcome: 'resolved-pending-apply', requestedAt: T0,
  }), T0);
  db.run(`INSERT INTO memory_outbox (outbox_id, scope, event_id, namespace, payload, status, receipt_id, attempts, last_error, claimed_until, claim_owner, created_at, updated_at)
          VALUES (?, ?, ?, 'companion.correction', ?, 'sent', 'rcpt-1', 1, 'supersede-write-failed', 0, '', ?, ?)`,
  `out_${id}`, KEY, requestId, JSON.stringify(payload), T0, T0);
  if (receipt) {
    db.run(`INSERT INTO runtime_meta (meta_key, meta_value, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value, updated_at = excluded.updated_at`,
    `p2_correction_apply:${requestId}`, JSON.stringify(receipt), T0);
  }
}

test('A. retry 之后真跑一次 drain：第二次投递发生、回执被重建、裁决走到 resolved-applied', async t => {
  const { engine, runtime, db } = await mounted(t);

  // A real memory that the correction is supposed to supersede.
  const original = await engine.ingestDomainEvent(fact({
    namespace: 'companion.event', eventId: 'retry-orig', content: '用户喜欢在雨天散步',
  }));
  assert.equal(original.status, 'accepted', JSON.stringify(original));
  const targetId = String(original.recordId);

  const requestId = 'req-retry-1';
  plantPending(db, {
    id: 'rec-retry', requestId, supersedeIds: [targetId],
    payload: {
      namespace: 'companion.correction',
      content: '其实用户不喜欢雨天散步了',
      rootEvidenceIds: [],
      transformVersion: 't1',
      supersedeIds: [targetId],
      realityStatus: 'actual_tool_activity',
      evidenceStatus: 'confirmed',
      occurredAt: T0,
    },
    receipt: { applied: [], duplicate: [], notApplied: [targetId], reason: 'supersede-write-failed', at: T0 },
  });

  // settle first: it must read the old failure and park the record
  runtime.settleCorrectionResolutions({ limit: 10 });
  assert.equal(auditOf(db, 'rec-retry').outcome, 'needs-review', 'the old failure parks it');

  // …then the operator asks for a real retry
  const retried = runtime.resolveCorrection({ resolutionId: 'rec-retry', decision: 'retry', operator: 'owner', evidence: '排查后重试' });
  assert.equal(retried.ok, true, JSON.stringify(retried));
  assert.equal(String(db.get("SELECT status FROM memory_outbox WHERE event_id = ?", requestId)?.status), 'queued', 'the request is back in the queue');
  assert.equal(db.get('SELECT meta_value FROM runtime_meta WHERE meta_key = ?', `p2_correction_apply:${requestId}`), undefined, 'and the stale receipt is gone');

  // **the real drain** — this is the step the earlier test never ran
  const drained = await runtime.drainOutbox({ sessionId: SESSION });
  assert.ok(drained, 'drain answered');
  const row = db.get("SELECT status, attempts FROM memory_outbox WHERE event_id = ?", requestId);
  assert.equal(String(row?.status), 'sent', `the second delivery really happened (got ${JSON.stringify(row)})`);
  assert.equal(Number(row?.attempts) >= 2, true, `and it is a *second* attempt (attempts=${row?.attempts})`);

  // the memory side really applied the supersede, and the runtime rebuilt the receipt
  const statusOfTarget = String(db.all("SELECT 1 AS n") && '')
    || String((await engine.internal()).db.handle.prepare('SELECT status FROM memories WHERE id = ?').get(targetId)?.status ?? '');
  assert.equal(statusOfTarget, 'superseded', `the memory was really superseded (got ${statusOfTarget})`);

  const receipt = receiptOf(db, requestId);
  assert.ok(receipt && Object.keys(receipt).length > 0, `a fresh receipt was written (got ${JSON.stringify(receipt)})`);
  assert.equal((receipt.applied ?? []).includes(targetId) || (receipt.duplicate ?? []).includes(targetId), true,
    `and it names the id that was applied (got ${JSON.stringify(receipt)})`);

  // …and the adjudication can finally settle
  runtime.settleCorrectionResolutions({ limit: 10 });
  const after = auditOf(db, 'rec-retry');
  assert.equal(after.outcome, 'resolved-applied', `retry closed the loop (got ${JSON.stringify(after)})`);
});

test('B. 跨库恢复的 RT 侧：重投（duplicate）让裁决从 needs-review 走到 resolved-applied', async t => {
  const { engine, runtime, db } = await mounted(t);

  const original = await engine.ingestDomainEvent(fact({
    namespace: 'companion.event', eventId: 'recover-orig', content: '用户养了一只叫团子的猫',
  }));
  const targetId = String(original.recordId);

  // The correction was delivered **and applied** by memory, but the runtime lost its receipt (crash).
  const requestId = 'req-recover-1';
  const applied = await engine.ingestDomainEvent(fact({
    namespace: 'companion.correction', eventId: requestId, content: '那只猫其实叫元宵',
    supersedeIds: [targetId],
  }));
  assert.equal(applied.status, 'accepted', JSON.stringify(applied));
  const memStatus = String((await engine.internal()).db.handle.prepare('SELECT status FROM memories WHERE id = ?').get(targetId)?.status ?? '');
  assert.equal(memStatus, 'superseded', 'memory really superseded it');

  // Runtime side knows nothing yet: a delivery with no receipt ⇒ parked as needs-review.
  plantPending(db, {
    id: 'rec-recover', requestId, supersedeIds: [targetId],
    payload: {
      namespace: 'companion.correction', content: '那只猫其实叫元宵', rootEvidenceIds: [],
      transformVersion: 't1', supersedeIds: [targetId],
      realityStatus: 'actual_tool_activity', evidenceStatus: 'confirmed', occurredAt: T0,
    },
    receipt: null,
  });
  runtime.settleCorrectionResolutions({ limit: 10 });
  assert.equal(auditOf(db, 'rec-recover').outcome, 'needs-review', 'without a receipt the runtime cannot tell');

  // The retry re-delivers; memory answers `duplicate` **with** the supersede result.
  const retried = runtime.resolveCorrection({ resolutionId: 'rec-recover', decision: 'retry', operator: 'owner', evidence: '崩溃后重投' });
  assert.equal(retried.ok, true, JSON.stringify(retried));
  await runtime.drainOutbox({ sessionId: SESSION });

  const receipt = receiptOf(db, requestId);
  assert.equal((receipt.duplicate ?? []).includes(targetId) || (receipt.applied ?? []).includes(targetId), true,
    `the rebuilt receipt carries the supersede result (got ${JSON.stringify(receipt)})`);

  runtime.settleCorrectionResolutions({ limit: 10 });
  const after = auditOf(db, 'rec-recover');
  assert.equal(after.outcome, 'resolved-applied',
    `a crash-lost receipt must be recoverable from what memory already did (got ${JSON.stringify(after)})`);
  assert.equal(db.all("SELECT COUNT(*) AS n FROM domain_events WHERE kind = 'memory/ingest-request'")[0].n >= 1, true);
});
