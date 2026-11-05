import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openRuntimeDb } from '../lib/db.mjs';
import { EFFECT_CODE, effectKeyFor, effectRecords, jobKeyFor } from '../lib/activities.mjs';
import { parseScope, scopeKey as scopeKeyOf } from '../lib/scope.mjs';
import { mountRuntime } from '../index.mjs';

// 第四轮 A3：公开 `runtime.resolveEffect` 必须真的能用 —— 上一轮我只写了**静态契约检查**，
// 而"公开 API 用不了"正是第四轮抓到的缺陷本身。
//
// 这里：真 dispatcher（不是桩）+ 公开 API + **重开数据库**读账本。

const T0 = Date.UTC(2026, 10, 18, 3, 0, 0);
const HOUR = 3_600_000;
const SCOPE = Object.freeze({ userId: 'owner-1', personaId: 'march7', worldId: 'world:default' });
const KEY = scopeKeyOf(SCOPE);
const GEN = 'gen-1';
const OWNER = 'owner-test';

function build(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-a3-public-'));
  fs.mkdirSync(path.join(root, 'home', 'companion'), { recursive: true });
  fs.writeFileSync(path.join(root, 'home', 'companion', 'runtime.config.json'), JSON.stringify({
    enabled: true, mode: 'active', timeZone: 'Asia/Shanghai',
    p2: { activities: { enabled: true, effectDeadlineMs: 60000 }, planning: { enabled: true }, share: { enabled: false } },
  }, null, 2), 'utf8');
  const dbFile = path.join(root, 'home', 'companion', 'runtime.db');

  const identity = {
    owner: () => ({ id: 'owner-1', displayName: 'owner-1', platform: 'local' }),
    resolve: sessionId => ({ userId: 'owner-1', personaId: 'march7', displayName: 'owner-1', sessionId }),
  };
  // Mount FIRST: the runtime takes the writer lease itself. Opening a seed handle first and
  // acquiring a lease there fences the runtime out (`mode: off`) — measured, not guessed.
  const runtime = mountRuntime(null, root, { memory: null, identity, dbFile, now: () => T0 });
  t.after(() => {
    try { runtime.dispose?.(); } catch { /* disposed */ }
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ }
  });
  assert.equal(runtime.mode, 'active', `the runtime must be active for this test (got ${String(runtime.mode)})`);

  const seed = openRuntimeDb({ file: dbFile, now: () => T0 });
  // The in-flight guard compares the receipt's generation with the activities instance's; a planted row
  // must carry **this** runtime's generation or the guard is simply not exercised.
  const runtimeGeneration = String(runtime.status?.()?.generation ?? seed.get("SELECT generation FROM writer_lease ORDER BY rowid DESC LIMIT 1")?.generation ?? '');
  assert.ok(runtimeGeneration, 'the test must know the live writer generation');
  t.after(() => { try { seed.close(); } catch { /* closed */ } });
  const scope = parseScope(KEY);
  seed.run(`INSERT INTO p2_plans (plan_id, scope, day, version, status, time_zone, window_start, window_end, summary, source_run_id, supersedes, created_at, committed_at)
            VALUES ('plan-a3', ?, '2026-11-18', 1, 'committed', 'Asia/Shanghai', ?, ?, '', '', '', ?, ?)`,
  KEY, T0 - 6 * HOUR, T0 + 6 * HOUR, T0, T0);
  seed.run(`INSERT INTO p2_plan_slots (slot_id, plan_id, scope, day, start_at, end_at, kind, activity, title, detail, flexibility, intent, target_ref, status, locked, created_at, updated_at)
            VALUES ('slot-a3', 'plan-a3', ?, '2026-11-18', ?, ?, 'activity', 'explore', 'x', '{}', 'soft', '', 'https://example.test/a', 'planned', 0, ?, ?)`,
  KEY, T0 - HOUR, T0 + HOUR, T0, T0);

  const jobKey = jobKeyFor({ scopeKey: KEY, startAt: T0 - HOUR, endAt: T0 + HOUR, kind: 'explore' });
  const effectKey = effectKeyFor({ jobKey, operation: 'prepare', ordinal: 1 });
  // The durable lifecycle row the ledger is built from: a `prepared` intent whose deadline has long
  // passed ("we asked, nobody answered"). `effectRecords()` reads exactly this table.
  seed.run(`INSERT INTO p2_activity_receipts (receipt_id, activity_id, scope, operation, ok, code, detail, source_hash,
              consumed_from, consumed_to, artifact_ref, at, generation)
            VALUES (?, 'act-a3', ?, 'prepare', 1, ?, ?, '', 0, 0, '', ?, ?)`,
  `rcpt_${effectKey}_prepared`, KEY, EFFECT_CODE,
  JSON.stringify({ effectKey, jobKey, phase: 'prepared', deadline: T0 - HOUR, generation: runtimeGeneration, operation: 'prepare' }),
  T0 - 2 * HOUR, runtimeGeneration);
  void scope;
  return { runtime, dbFile, effectKey };
}
function readDetail(dbFile, receiptId) {
  const db = openRuntimeDb({ file: dbFile, now: () => T0 });
  try { return JSON.parse(String(db.get('SELECT detail FROM p2_activity_receipts WHERE receipt_id = ?', receiptId)?.detail ?? '{}')); }
  catch { return {}; } finally { db.close(); }
}

function readLedger(dbFile) {
  const db = openRuntimeDb({ file: dbFile, now: () => T0 });
  try { return effectRecords(db, { scopeKey: KEY }); } finally { db.close(); }
}

test('A3：公开 API 不带 reason 被拒，带上 reason 能完成超时收敛并落账本', t => {
  const { runtime, dbFile, effectKey } = build(t);

  const without = runtime.resolveEffect({
    sessionId: 's1', effectKey, outcome: 'not_applied', evidence: 'ip 记录显示已发出', operator: 'owner',
  });
  assert.equal(without?.ok, false, `an in-flight override without a reason must be refused (${JSON.stringify(without)})`);
  assert.equal(String(without?.code ?? ''), 'reason-required', `and it must say why (${JSON.stringify(without)})`);
  assert.equal(readLedger(dbFile).filter(record => record.effectKey === effectKey).length, 1, 'the refusal writes nothing');

  const withReason = runtime.resolveEffect({
    sessionId: 's1', effectKey, outcome: 'not_applied', evidence: 'ip 记录显示已发出', operator: 'owner', reason: 'worker-abandoned',
  });
  assert.equal(withReason?.ok, true, `the public API must be able to converge a timed-out effect (${JSON.stringify(withReason)})`);

  // Re-open the database: the ledger, not the return value, is the evidence.
  const records = readLedger(dbFile).filter(record => record.effectKey === effectKey);
  assert.equal(records.length >= 2, true, `a resolution phase is appended (saw ${JSON.stringify(records.map(r => r.phase))})`);
  const last = records[records.length - 1];
  assert.equal(String(last.phase), 'not_applied', `the resolved phase is not_applied (got ${String(last.phase)})`);
  const detail = readDetail(dbFile, String(last.receiptId));
  assert.equal(String(detail?.reason ?? ''), 'worker-abandoned', `the reason is recorded in the audit (got ${JSON.stringify(detail).slice(0, 260)})`);
});
