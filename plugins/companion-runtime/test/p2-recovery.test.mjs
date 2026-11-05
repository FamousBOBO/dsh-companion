import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openRuntimeDb } from '../lib/db.mjs';
import { dispatchEvent } from '../lib/events.mjs';
import { activityIdFor, applyActivityEvent, createActivities, missedReceiptEvent, MISSED_RECEIPT_CODE } from '../lib/activities.mjs';
import { scopeKey } from '../lib/scope.mjs';

// P2-12 恢复不重放/不编造 (contract §8, amendment BLOCK-5/BLOCK-6).
//
// The rules under test: after a restart `reconcile()` compares the recorded checkpoint/hash
// with the source and reports `resumed` / `stale` / `needsReview`. It never replays a
// consumed interval, never invents progress, never marks an activity done and never restarts
// a slot whose window is long past.

const T0 = Date.UTC(2026, 9, 30, 4, 0, 0);
const SCOPE = Object.freeze({ userId: 'owner-1', personaId: 'bot', worldId: 'world:default' });
const KEY = scopeKey(SCOPE);
const SOURCE = Array.from({ length: 12 }, (_, index) => `第${index}段：` + '潮声一阵一阵压过来。'.repeat(6)).join('\n\n');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-recovery-'));
  fs.mkdirSync(path.join(dir, 'shelf'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'shelf', 'deep.md'), `# 深处\n\n${SOURCE}`, 'utf8');
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  return dir;
}

function filePorts(calls = { reads: 0 }) {
  return {
    calls,
    readFile({ path: file }) { calls.reads += 1; try { return { ok: true, text: fs.readFileSync(file, 'utf8') }; } catch { return { ok: false }; } },
    writeFile({ path: file, text }) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, 'utf8'); return { ok: true, bytes: Buffer.byteLength(text) }; },
    fetchPage() { return { ok: false, status: 0 }; },
  };
}

function configFor(activities = {}) {
  return {
    p2: {
      activities: {
        enabled: true, paused: false, chunkUnits: 200, maxUnitsPerStep: 4000,
        maxSourceBytes: 200000, maxTotalUnits: 200000, maxExcerptChars: 400, draftsDir: 'drafts',
        ...activities,
      },
      autonomy: { allowedSources: [] },
    },
  };
}

function openDb(t, file, now = () => T0) {
  const db = openRuntimeDb({ file, now });
  db.acquireLease({ owner: 'test', generation: 'gen-1', ttlMs: 600000 });
  db.commitProjection({ scope: KEY, generation: 'gen-1', payload: {}, updatedAt: T0 });
  t.after(() => { try { db.close(); } catch { /* already closed */ } });
  return db;
}

const dispatchFor = db => event => dispatchEvent(db, event, { handlers: { autonomy: applyActivityEvent }, generation: 'gen-1', requireConsumers: true });

function insertSlot(db, { slotId, kind = 'activity', target, startAt = T0, endAt = T0 + 3600000 }) {
  db.run(`INSERT INTO p2_plan_slots (slot_id, plan_id, scope, day, start_at, end_at, kind, activity, title, detail,
            flexibility, intent, target_ref, status, locked, created_at, updated_at)
          VALUES (?, 'plan-1', ?, '2026-10-30', ?, ?, ?, 'read', '深处', '{}', 'soft', '', ?, 'planned', 0, ?, ?)`,
  slotId, KEY, startAt, endAt, kind, target, T0, T0);
}

function makeActivities({ db, workspace, ports = filePorts(), config = configFor(), clock = () => T0 + 1000 }) {
  return createActivities({ db, config, clock, owner: 'test', generation: 'gen-1', dispatch: dispatchFor(db), ports, workspace });
}

function rowOf(db, activityId) {
  return db.get('SELECT * FROM p2_activities WHERE activity_id = ?', activityId);
}

test('P2-12: a restart resumes a paused activity without double-consuming', t => {
  const dir = tempDir(t);
  const workspace = path.join(dir, 'works');
  fs.mkdirSync(path.join(workspace, 'shelf'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'shelf', 'deep.md'), `# 深处\n\n${SOURCE}`, 'utf8');
  const dbFile = path.join(dir, 'runtime.db');

  const db = openDb(t, dbFile);
  insertSlot(db, { slotId: 'slot-1', target: 'shelf/deep.md' });
  const activities = makeActivities({ db, workspace });
  const started = activities.start({ slotId: 'slot-1', kind: 'read' });
  const step = activities.step({ activityId: started.activityId, units: 200 });
  activities.pause({ activityId: started.activityId });
  const prefix = step.consumedPrefix;
  const receiptsBefore = Number(db.get('SELECT COUNT(*) AS n FROM p2_activity_receipts').n);
  db.close();

  const reopened = openDb(t, dbFile);
  const restarted = makeActivities({ db: reopened, workspace, ports: filePorts() });
  const reconcile = restarted.reconcile();
  assert.deepEqual(reconcile.stale, []);
  assert.deepEqual(reconcile.needsReview, []);
  assert.deepEqual(reconcile.resumed, [started.activityId]);

  // Recovery itself never advanced anything and never wrote a step receipt.
  assert.equal(Number(rowOf(reopened, started.activityId).consumed_prefix), prefix);
  assert.equal(rowOf(reopened, started.activityId).status, 'paused', 'reconcile never resumes by itself');
  assert.equal(Number(reopened.get("SELECT COUNT(*) AS n FROM p2_activity_receipts WHERE operation = 'step'").n), 1);

  restarted.resume({ activityId: started.activityId });
  const next = restarted.step({ activityId: started.activityId, units: 200 });
  assert.equal(next.consumed.from, prefix, 'the next step continues at the recorded offset');
  assert.ok(next.consumedPrefix > prefix);
  assert.equal(Number(reopened.get('SELECT COUNT(*) AS n FROM p2_activity_receipts').n), receiptsBefore + 2, 'one resume receipt and one step receipt');
});

test('P2-12: a changed source hash is needsReview, not silent continuation', t => {
  const dir = tempDir(t);
  const workspace = path.join(dir, 'works');
  fs.mkdirSync(path.join(workspace, 'shelf'), { recursive: true });
  const file = path.join(workspace, 'shelf', 'deep.md');
  fs.writeFileSync(file, `# 深处\n\n${SOURCE}`, 'utf8');
  const db = openDb(t, ':memory:');
  insertSlot(db, { slotId: 'slot-1', target: 'shelf/deep.md' });
  const activities = makeActivities({ db, workspace });
  const started = activities.start({ slotId: 'slot-1', kind: 'read' });
  const step = activities.step({ activityId: started.activityId, units: 200 });

  // The file is edited behind the activity's back.
  fs.writeFileSync(file, `# 深处（修订）\n\n${SOURCE}\n\n新加的一段。`, 'utf8');
  const reconcile = activities.reconcile();
  assert.deepEqual(reconcile.resumed, []);
  assert.deepEqual(reconcile.needsReview, [started.activityId]);
  const row = rowOf(db, started.activityId);
  assert.equal(Number(row.consumed_prefix), step.consumedPrefix, 'no progress was invented');
  assert.notEqual(row.status, 'done', 'a changed source never becomes done');
  assert.ok(db.get("SELECT 1 AS one FROM p2_activity_receipts WHERE operation = 'review' AND code = 'source-changed'"));
  // And the executor cannot step past it either.
  const parked = (() => {
    try { return activities.step({ activityId: started.activityId, units: 100 }); } catch (error) { return { ok: false, code: error.code }; }
  })();
  assert.equal(parked.ok, false);
  assert.equal(parked.code, 'source-changed');
  // BLOCK-5: the refusal parks the activity. It stays paused with the old prefix — no
  // progress, no completion — until a human/planner decision re-points it at a new source.
  assert.equal(rowOf(db, started.activityId).status, 'paused');
  assert.equal(Number(rowOf(db, started.activityId).consumed_prefix), step.consumedPrefix);
});

test('P2-12: a window that closed long ago needs review instead of being finished', t => {
  const dir = tempDir(t);
  const workspace = path.join(dir, 'works');
  fs.mkdirSync(path.join(workspace, 'shelf'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'shelf', 'deep.md'), `# 深处\n\n${SOURCE}`, 'utf8');
  const db = openDb(t, ':memory:');
  insertSlot(db, { slotId: 'slot-1', target: 'shelf/deep.md', startAt: T0, endAt: T0 + 1800000 });
  // The activity started inside its window, then the host went down for a day.
  const activities = makeActivities({ db, workspace });
  const started = activities.start({ slotId: 'slot-1', kind: 'read' });
  activities.step({ activityId: started.activityId, units: 200 });

  const later = makeActivities({ db, workspace, clock: () => T0 + 86400000 });
  const reconcile = later.reconcile();
  assert.deepEqual(reconcile.needsReview, [started.activityId], 'a long-past window is a review item, not a completion');
  // Contract v1.2 §1: a review must be a real gate, so reconcile parks the row (`paused`) and
  // marks the checkpoint; what it must never do is finish or abandon the activity on a guess.
  assert.equal(rowOf(db, started.activityId).status, 'paused', 'reconcile never finishes and never abandons');
  assert.equal(JSON.parse(rowOf(db, started.activityId).checkpoint).needsReview, true, 'the gate is persisted for the executor');
  assert.ok(db.get("SELECT 1 AS one FROM p2_activity_receipts WHERE operation = 'review' AND code = 'window-closed'"));
  assert.equal(Number(db.get("SELECT COUNT(*) AS n FROM p2_activity_receipts WHERE operation = 'finish'").n), 0);
});

test('P2-12: a self-inconsistent row is stale and is not "repaired" by guessing', t => {
  const dir = tempDir(t);
  const workspace = path.join(dir, 'works');
  fs.mkdirSync(path.join(workspace, 'shelf'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'shelf', 'deep.md'), `# 深处\n\n${SOURCE}`, 'utf8');
  const db = openDb(t, ':memory:');
  insertSlot(db, { slotId: 'slot-1', target: 'shelf/deep.md' });
  const activities = makeActivities({ db, workspace });
  const started = activities.start({ slotId: 'slot-1', kind: 'read' });
  const step = activities.step({ activityId: started.activityId, units: 200 });

  // A repair/hand edit that made the checkpoint disagree with the row.
  const row = rowOf(db, started.activityId);
  const checkpoint = JSON.parse(row.checkpoint);
  checkpoint.consumed = { from: 0, to: 5 };
  db.run('UPDATE p2_activities SET checkpoint = ? WHERE activity_id = ?', JSON.stringify(checkpoint), started.activityId);
  const reconcile = activities.reconcile();
  assert.deepEqual(reconcile.stale, [started.activityId]);
  assert.deepEqual(reconcile.needsReview, []);
  assert.equal(Number(rowOf(db, started.activityId).consumed_prefix), step.consumedPrefix, 'the row was not rewritten from the checkpoint');
});

test('P2-12: unknown external outcomes are failed once and never blindly retried', t => {
  const dir = tempDir(t);
  const workspace = path.join(dir, 'works');
  fs.mkdirSync(path.join(workspace, 'shelf'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'shelf', 'deep.md'), `# 深处\n\n${SOURCE}`, 'utf8');
  const db = openDb(t, ':memory:');
  insertSlot(db, { slotId: 'slot-1', target: 'shelf/deep.md' });
  const activities = makeActivities({ db, workspace });
  const started = activities.start({ slotId: 'slot-1', kind: 'read' });
  activities.step({ activityId: started.activityId, units: 200 });
  const failed = activities.fail({ activityId: started.activityId, code: 'failed-unknown' });
  assert.equal(failed.status, 'failed');
  assert.equal(Number(db.get("SELECT COUNT(*) AS n FROM p2_activity_receipts WHERE operation = 'finish' AND ok = 0 AND code = 'failed-unknown'").n), 1);
  // Recovery does not resurrect it, and a retry of the same fail is idempotent.
  const reconcile = activities.reconcile();
  assert.deepEqual(reconcile.resumed, []);
  assert.deepEqual(reconcile.needsReview, []);
  assert.equal(activities.fail({ activityId: started.activityId, code: 'failed-unknown' }).duplicate, true);
  assert.equal(Number(db.get("SELECT COUNT(*) AS n FROM p2_activity_receipts WHERE operation = 'finish'").n), 1, 'one terminal receipt, no retry storm');
});

test('P2-12: an empty database reconciles to empty verdicts and writes nothing', t => {
  const db = openDb(t, ':memory:');
  const activities = makeActivities({ db, workspace: tempDir(t) });
  const eventsBefore = Number(db.get('SELECT COUNT(*) AS n FROM domain_events').n);
  assert.deepEqual(activities.reconcile(), { resumed: [], stale: [], needsReview: [] });
  assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM domain_events').n), eventsBefore);
  assert.equal(activities.status().reconcile.checked, 0);
  assert.equal(activities.status().reconcile.at > 0, true);
});

test('P2-12 (N-1): a missed slot leaves a missed receipt and never an activity row', t => {
  const db = openDb(t, ':memory:');
  const slotId = 'slot-never-started';
  // The pump owns the timing decision (window closed); the receipt row is written by the
  // activity reducer, filed against the id the slot would have produced.
  const event = missedReceiptEvent({ scope: SCOPE, scopeKey: KEY, slotId, kind: 'read', generation: 'gen-1', at: T0 + 3600000, note: 'window closed without a start' });
  assert.equal(event.kind, 'autonomy/receipt');
  assert.equal(event.occurredAt, T0 + 3600000);
  const expectedActivityId = activityIdFor({ scopeKey: KEY, slotId, kind: 'read' });
  assert.equal(event.payload.activityId, expectedActivityId, 'the receipt is filed against the id the slot would have produced');

  const outcome = dispatchEvent(db, { ...event, scope: SCOPE }, { handlers: { autonomy: applyActivityEvent }, generation: 'gen-1', requireConsumers: true });
  assert.equal(outcome.rejected, false);
  assert.equal(outcome.results[0].result.operation, 'missed');

  const receipts = db.all("SELECT * FROM p2_activity_receipts WHERE operation = 'missed'");
  assert.equal(receipts.length, 1, 'exactly one missed receipt');
  const receipt = receipts[0];
  assert.equal(receipt.activity_id, expectedActivityId);
  assert.equal(receipt.code, MISSED_RECEIPT_CODE);
  assert.equal(receipt.code, 'window-closed');
  assert.equal(Number(receipt.ok), 0);
  assert.equal(Number(receipt.consumed_from), 0);
  assert.equal(Number(receipt.consumed_to), 0);
  assert.equal(receipt.artifact_ref, '');
  assert.equal(receipt.generation, 'gen-1');
  assert.equal(JSON.parse(receipt.detail).reality, 'hypothetical');
  assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM p2_activities').n), 0, 'a missed slot never invents an activity');

  // A redelivered miss is one fact, not two.
  const again = dispatchEvent(db, { ...event, scope: SCOPE }, { handlers: { autonomy: applyActivityEvent }, generation: 'gen-1', requireConsumers: true });
  assert.equal(again.rejected, false);
  assert.equal(Number(db.get("SELECT COUNT(*) AS n FROM p2_activity_receipts WHERE code <> 'lc-effect'").n), 1, 'the receipt id is deterministic');
});
