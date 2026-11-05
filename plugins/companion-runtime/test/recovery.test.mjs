import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openRuntimeDb } from '../lib/db.mjs';
import { normalizeEvent, dispatchEvent } from '../lib/events.mjs';
import { scopeKey } from '../lib/scope.mjs';
import { verifyRecovery } from '../lib/snapshot.mjs';

const SCOPE_A = Object.freeze({ userId: 'owner-1', personaId: 'bot', worldId: '' });
const SCOPE_B = Object.freeze({ userId: 'owner-2', personaId: 'bot', worldId: 'world:game' });
const KEY_A = scopeKey(SCOPE_A);
const KEY_B = scopeKey(SCOPE_B);
const T0 = Date.UTC(2026, 9, 29, 2, 0, 0);

// A deliberately small but relational reducer: it writes a row and a projection
// slice, which is what recovery has to reproduce.
function handlers(calls = []) {
  return {
    goals: ({ db, event, slice, now }) => {
      calls.push({ consumer: 'goals', eventId: event.eventId });
      if (event.kind === 'goal/proposed') {
        const goalId = `goal-${event.payload.title}`;
        db.run(`INSERT INTO goals (goal_id, scope, title, status, created_at, updated_at)
                VALUES (?, ?, ?, 'proposed', ?, ?)`, goalId, event.scopeKey, event.payload.title, now, now);
        return { slice: { count: Number(slice.count ?? 0) + 1, lastGoal: goalId }, result: { goalId } };
      }
      if (event.kind === 'goal/step') {
        db.run('UPDATE goals SET completed_steps = ?, updated_at = ? WHERE goal_id = ?',
          JSON.stringify([event.payload.step]), now, event.payload.goalId);
        return { slice: { count: Number(slice.count ?? 0) + 1 }, result: {} };
      }
      return { slice };
    },
    'working-memory': ({ db, event, slice, now }) => {
      calls.push({ consumer: 'working-memory', eventId: event.eventId });
      db.run(`INSERT INTO working_memory (scope, focus_goal_id, revision, updated_at, view)
              VALUES (?, ?, 1, ?, '{}')
              ON CONFLICT(scope) DO UPDATE SET focus_goal_id = excluded.focus_goal_id, revision = working_memory.revision + 1`,
        event.scopeKey, event.payload.goalId ?? '', now);
      return { slice: { focus: event.payload.goalId ?? '' } };
    },
  };
}

function buildFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-recovery-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });
  return path.join(dir, 'runtime.db');
}

function seed(db, keyHandlers) {
  dispatchEvent(db, normalizeEvent({ kind: 'goal/proposed', scope: SCOPE_A, occurredAt: T0, payload: { title: '修屋顶' } }), { handlers: keyHandlers, generation: 'gen-1' });
  dispatchEvent(db, normalizeEvent({ kind: 'goal/proposed', scope: SCOPE_A, occurredAt: T0 + 1000, payload: { title: '整资料' } }), { handlers: keyHandlers, generation: 'gen-1' });
  dispatchEvent(db, normalizeEvent({ kind: 'goal/step', scope: SCOPE_A, occurredAt: T0 + 2000, payload: { goalId: 'goal-修屋顶', step: '联系师傅' } }), { handlers: keyHandlers, generation: 'gen-1' });
  dispatchEvent(db, normalizeEvent({ kind: 'goal/proposed', scope: SCOPE_B, occurredAt: T0 + 3000, payload: { title: '另一世界' } }), { handlers: keyHandlers, generation: 'gen-1' });
}

test('A08: replaying the recorded log reproduces the projection', () => {
  const db = openRuntimeDb({ file: ':memory:', now: () => T0 + 5000 });
  db.acquireLease({ owner: 'test', generation: 'gen-1', ttlMs: 600000 });
  const h = handlers();
  seed(db, h);
  const report = verifyRecovery(db, { scopeKey: KEY_A, handlers: h, now: () => T0 + 5000 });
  assert.equal(report.ok, true, JSON.stringify(report.mismatches));
  assert.equal(report.replayed, 3, 'only this scope is replayed');
  assert.equal(report.projectionVersion, db.projection(KEY_A).version);
  const other = verifyRecovery(db, { scopeKey: KEY_B, handlers: h, now: () => T0 + 5000 });
  assert.equal(other.ok, true);
  assert.equal(other.replayed, 1);
  db.close();
});

test('A08: replay detects a hand-edited projection instead of blessing it', () => {
  const db = openRuntimeDb({ file: ':memory:', now: () => T0 + 5000 });
  db.acquireLease({ owner: 'test', generation: 'gen-1', ttlMs: 600000 });
  const h = handlers();
  seed(db, h);
  db.run("UPDATE goals SET next_step = '手工改过' WHERE goal_id = 'goal-修屋顶'");
  const report = verifyRecovery(db, { scopeKey: KEY_A, handlers: h, now: () => T0 + 5000 });
  assert.equal(report.ok, false);
  assert.equal(report.mismatches.some(mismatch => mismatch.kind === 'table-mismatch' && mismatch.table === 'goals'), true);
  db.close();
});

test('A08/B4: tampering with a title or a commitment body is detected too', () => {
  const db = openRuntimeDb({ file: ':memory:', now: () => T0 + 5000 });
  db.acquireLease({ owner: 'test', generation: 'gen-1', ttlMs: 600000 });
  const h = handlers();
  seed(db, h);
  const baseline = verifyRecovery(db, { scopeKey: KEY_A, handlers: h, now: () => T0 + 5000 });
  assert.equal(baseline.ok, true, JSON.stringify(baseline.mismatches));

  db.run("UPDATE goals SET title = '被改过的标题' WHERE goal_id = 'goal-修屋顶'");
  const titleTamper = verifyRecovery(db, { scopeKey: KEY_A, handlers: h, now: () => T0 + 5000 });
  assert.equal(titleTamper.ok, false, 'a changed title must be visible to the recovery check');
  assert.equal(titleTamper.mismatches.some(mismatch => mismatch.table === 'goals'), true);
  db.run("UPDATE goals SET title = '修屋顶' WHERE goal_id = 'goal-修屋顶'");

  db.run("INSERT INTO commitments (commitment_id, scope, goal_id, body, status, due_at, revision, created_at, updated_at, closed_reason) VALUES ('cm-1', ?, 'goal-修屋顶', '周五继续整理资料', 'open', NULL, 1, ?, ?, '')", KEY_A, T0, T0);
  const extraCommitment = verifyRecovery(db, { scopeKey: KEY_A, handlers: h, now: () => T0 + 5000 });
  assert.equal(extraCommitment.ok, false, 'an unrecorded commitment row must be visible too');
  assert.equal(extraCommitment.mismatches.some(mismatch => mismatch.table === 'commitments'), true);
  db.run("UPDATE commitments SET body = '被改过的承诺' WHERE commitment_id = 'cm-1'");
  const bodyTamper = verifyRecovery(db, { scopeKey: KEY_A, handlers: h, now: () => T0 + 5000 });
  assert.equal(bodyTamper.ok, false);
  db.close();
});

test('A08: replay is side-effect free, deterministic and survives a restart', t => {
  const file = buildFile(t);
  let clock = T0;
  const first = openRuntimeDb({ file, now: () => clock });
  first.acquireLease({ owner: 'test', generation: 'gen-1', ttlMs: 600000 });
  const h = handlers();
  seed(first, h);
  const before = {
    events: first.get('SELECT COUNT(*) AS n FROM domain_events').n,
    goals: first.get('SELECT COUNT(*) AS n FROM goals').n,
    receipts: first.get('SELECT COUNT(*) AS n FROM consumer_receipts').n,
  };
  const one = verifyRecovery(first, { scopeKey: KEY_A, handlers: h, now: () => clock });
  const two = verifyRecovery(first, { scopeKey: KEY_A, handlers: h, now: () => clock });
  assert.equal(one.ok, true);
  assert.deepEqual(one, two, 'replay is deterministic and writes nothing to the live db');
  assert.deepEqual({
    events: first.get('SELECT COUNT(*) AS n FROM domain_events').n,
    goals: first.get('SELECT COUNT(*) AS n FROM goals').n,
    receipts: first.get('SELECT COUNT(*) AS n FROM consumer_receipts').n,
  }, before);
  first.close();

  clock += 60000;
  const reopened = openRuntimeDb({ file, now: () => clock });
  const after = verifyRecovery(reopened, { scopeKey: KEY_A, handlers: h, now: () => clock });
  assert.equal(after.ok, true, JSON.stringify(after.mismatches));
  assert.equal(after.replayed, 3);
  reopened.close();
});

test('A08: replay is identical even when the wall clock has moved on', () => {
  let clock = T0 + 5000;
  const db = openRuntimeDb({ file: ':memory:', now: () => clock });
  db.acquireLease({ owner: 'test', generation: 'gen-1', ttlMs: 600000 });
  const h = handlers();
  seed(db, h);
  const live = db.projection(KEY_A).payload;
  // A week later, on a reopened runtime, replay must reproduce the same rows.
  clock = T0 + 7 * 86400000;
  const report = verifyRecovery(db, { scopeKey: KEY_A, handlers: h, now: () => clock });
  assert.equal(report.ok, true, JSON.stringify(report.mismatches));
  assert.deepEqual(db.projection(KEY_A).payload, live, 'the live projection was not rewritten by the check');
  db.close();
});

test('recovery never re-applies across scopes and keeps unknown scopes empty', () => {
  const db = openRuntimeDb({ file: ':memory:', now: () => T0 });
  db.acquireLease({ owner: 'test', generation: 'gen-1', ttlMs: 600000 });
  const h = handlers();
  seed(db, h);
  const unknown = verifyRecovery(db, { scopeKey: scopeKey({ userId: 'nobody', personaId: 'bot', worldId: '' }), handlers: h, now: () => T0 });
  assert.equal(unknown.ok, true);
  assert.equal(unknown.replayed, 0);
  assert.equal(db.projection(KEY_A).version, 6, 'no cross-scope writes');
  db.close();
});
