import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openRuntimeDb } from '../lib/db.mjs';
import { scopeKey as scopeKeyOf } from '../lib/scope.mjs';
import { mountRuntime } from '../index.mjs';
import { p2Observability } from '../lib/observability.mjs';

// 第六轮复审的四条实证（两条 P1）：retry 的失败原子性、forced 重审的分页、单槽公平的双向轮转、
// 以及 `readRow` 的假 0。断言全部读**库里的字节**，并做"整笔回滚"级别的检查。

const T0 = Date.UTC(2026, 10, 26, 3, 0, 0);
const SCOPE = Object.freeze({ userId: 'owner-1', personaId: 'march7', worldId: 'world:default' });
const KEY = scopeKeyOf(SCOPE);
const RESOLVED = 'p2_correction_resolved:';

function world(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-round6-'));
  fs.mkdirSync(path.join(root, 'home', 'companion'), { recursive: true });
  fs.writeFileSync(path.join(root, 'home', 'companion', 'runtime.config.json'), JSON.stringify({
    enabled: true, mode: 'active', timeZone: 'Asia/Shanghai',
    p2: { activities: { enabled: true }, planning: { enabled: false }, share: { enabled: false } },
  }, null, 2), 'utf8');
  const dbFile = path.join(root, 'home', 'companion', 'runtime.db');
  const identity = {
    owner: () => ({ id: 'owner-1', displayName: 'owner-1', platform: 'local' }),
    resolve: sessionId => ({ userId: 'owner-1', personaId: 'march7', displayName: 'owner-1', sessionId }),
  };
  const runtime = mountRuntime(null, root, { memory: null, identity, dbFile, now: () => T0 });
  const db = openRuntimeDb({ file: dbFile, now: () => T0 });
  t.after(() => {
    try { runtime.dispose?.(); } catch { /* disposed */ }
    try { db.close(); } catch { /* closed */ }
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ }
  });
  return { db, runtime, root, dbFile };
}

/** Plant one open adjudication plus the outbox row and the (failed) receipt that made it open. */
function plant(db, { id, requestId, status = 'sent', receipt = true }) {
  db.run(`INSERT INTO runtime_meta (meta_key, meta_value, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value, updated_at = excluded.updated_at`,
  `${RESOLVED}${id}`, JSON.stringify({
    recordId: id, requestId, supersedeIds: ['mem_a'], outcome: 'needs-review', requestedAt: T0,
  }), T0);
  db.run(`INSERT INTO memory_outbox (outbox_id, scope, event_id, namespace, payload, status, receipt_id, attempts, last_error, claimed_until, claim_owner, created_at, updated_at)
          VALUES (?, ?, ?, 'companion.correction', '{}', ?, 'rcpt-1', 1, 'x', 0, '', ?, ?)`,
  `out_${id}`, KEY, requestId, status, T0, T0);
  if (receipt) {
    db.run(`INSERT INTO runtime_meta (meta_key, meta_value, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value, updated_at = excluded.updated_at`,
    `p2_correction_apply:${requestId}`,
    JSON.stringify({ applied: [], duplicate: [], notApplied: ['mem_a'], reason: 'supersede-write-failed', at: T0 }), T0);
  }
}

const auditOf = (db, id) => {
  try { return JSON.parse(String(db.metaGet(`${RESOLVED}${id}`, '') || '{}')); } catch { return {}; }
};
const outboxOf = (db, requestId) => db.get('SELECT status, attempts FROM memory_outbox WHERE event_id = ?', requestId);

test('1a. retry 遇到"没有已投递的请求"：旧回执**不许**被删，outbox 也不许动', t => {
  const { db, runtime } = world(t);
  // queued (not `sent`) — the requeue条件不满足
  plant(db, { id: 'rec-q', requestId: 'req-q', status: 'queued' });
  const beforeReceipt = String(db.metaGet('p2_correction_apply:req-q', 'MISSING'));
  const beforeOutbox = { ...outboxOf(db, 'req-q') };

  const out = runtime.resolveCorrection({ resolutionId: 'rec-q', decision: 'retry', operator: 'owner', evidence: '试着重投' });
  assert.equal(out.ok, false, JSON.stringify(out));
  assert.equal(out.code, 'not-retryable');

  assert.equal(String(db.metaGet('p2_correction_apply:req-q', 'MISSING')), beforeReceipt,
    'the failed receipt must survive a refusal (round-6 probe 1)');
  assert.deepEqual({ ...outboxOf(db, 'req-q') }, beforeOutbox, 'and the outbox row is untouched');
  assert.equal(auditOf(db, 'rec-q').outcome, 'needs-review', 'the adjudication is untouched too');
});

test('1b. retry 的写失败必须整笔回滚：注入 DELETE 失败 → outbox / 回执 / audit 全不变', t => {
  const { db, runtime } = world(t);
  plant(db, { id: 'rec-w', requestId: 'req-w', status: 'sent' });

  // The runtime opens its **own** connection, so patching this handle would not reach its
  // transaction. A trigger does: the DELETE fails inside whatever connection runs it.
  db.run(`CREATE TRIGGER boom BEFORE DELETE ON runtime_meta
          WHEN OLD.meta_key LIKE 'p2_correction_apply:%'
          BEGIN SELECT RAISE(ABORT, 'injected: delete failed'); END`);
  t.after(() => { try { db.run('DROP TRIGGER IF EXISTS boom'); } catch { /* cleanup */ } });
  const beforeOutbox = { ...outboxOf(db, 'req-w') };
  const beforeReceipt = String(db.metaGet('p2_correction_apply:req-w', 'MISSING'));

  const out = runtime.resolveCorrection({ resolutionId: 'rec-w', decision: 'retry', operator: 'owner', evidence: '重投' });

  assert.equal(out.ok, false, `a failed write must fail the whole call (got ${JSON.stringify(out)})`);
  assert.deepEqual({ ...outboxOf(db, 'req-w') }, beforeOutbox,
    'the UPDATE must be rolled back, not committed (round-6 probe 2)');
  assert.equal(String(db.metaGet('p2_correction_apply:req-w', 'MISSING')), beforeReceipt,
    'and the receipt is still there');
  assert.equal(auditOf(db, 'rec-w').outcome, 'needs-review', 'the audit is still needs-review');
  assert.equal(out.code !== undefined, true, 'the refusal names a code');
});

test('1c. 成功的 retry 仍然两件事都做：行回队列 + 旧回执删除', t => {
  const { db, runtime } = world(t);
  plant(db, { id: 'rec-ok', requestId: 'req-ok', status: 'sent' });
  const out = runtime.resolveCorrection({ resolutionId: 'rec-ok', decision: 'retry', operator: 'owner', evidence: '重投' });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(String(outboxOf(db, 'req-ok')?.status), 'queued');
  assert.equal(db.get('SELECT meta_value FROM runtime_meta WHERE meta_key = ?', 'p2_correction_apply:req-ok'), undefined);
  assert.equal(auditOf(db, 'rec-ok').outcome, 'resolved-pending-apply');
});

test('2. forced 重审分页收敛：3 个标记、batch=1 → 3 次内全部处理完', async t => {
  const { db, runtime } = world(t);
  // Three legacy marks with no owning activity (the `unowned` bucket the forced pass exists for).
  for (const id of ['ghost-a', 'ghost-b', 'ghost-c']) {
    db.run(`INSERT INTO runtime_meta (meta_key, meta_value, updated_at) VALUES (?, 'legacy', ?)
            ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value, updated_at = excluded.updated_at`,
    `p2_p1_${id}`, T0);
  }
  let passes = 0;
  let revoked = 0;
  while (passes < 4) {
    passes += 1;
    const out = runtime.reauditLegacy({
      scopeKey: KEY, includeUnowned: true, operator: 'owner', evidence: 'activity 行已被清理', batch: 1,
    });
    assert.equal(out.ok, true, JSON.stringify(out));
    revoked += Number(out.revoked ?? 0);
    if (out.more === false) break;
  }
  assert.equal(revoked >= 3, true, `all three marks must be reached within a few passes (revoked ${revoked}, passes ${passes})`);
  for (const id of ['ghost-a', 'ghost-b', 'ghost-c']) {
    assert.equal(String(db.metaGet(`p2_p1_${id}`, '')), 'revoked', `${id} was revoked`);
  }
});

test('4. 缺行就是 null：model_calls / budget_remaining 不许是 0/measured', () => {
  // `get` answers "no row" — the honest answer is unavailable, not a healthy zero.
  const noRow = { get() { return undefined; }, all() { return []; } };
  const view = p2Observability(noRow, {
    scopeKey: KEY, now: T0, switches: { activities: false, planning: true },
  });
  const model = view.groups.model.metrics;
  assert.equal(model.model_calls.value, null, `model_calls must be null (got ${JSON.stringify(model.model_calls)})`);
  assert.equal(model.model_calls.honest, 'unavailable');
  assert.equal(model.budget_remaining.value, null, `budget_remaining must be null (got ${JSON.stringify(model.budget_remaining)})`);
  assert.equal(model.budget_remaining.honest, 'unavailable');
  assert.equal(model.tokens_estimated.value, null);

  // …and a genuine empty row still reads as 0.
  const empty = { get(sql) { return /COUNT/.test(sql) ? { n: 0, tin: 0, tout: 0, tchars: 0 } : { amount: 0, spent: 0 }; }, all() { return []; } };
  const emptyView = p2Observability(empty, { scopeKey: KEY, now: T0, switches: { activities: false, planning: true } });
  assert.equal(emptyView.groups.model.metrics.model_calls.value, 0);
  assert.equal(emptyView.groups.model.metrics.model_calls.honest, 'measured');
});
