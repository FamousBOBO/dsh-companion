import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openRuntimeDb } from '../lib/db.mjs';
import { dispatchEvent } from '../lib/events.mjs';
import { createActivities, applyActivityEvent } from '../lib/activities.mjs';
import { scopeKey } from '../lib/scope.mjs';

// P2-11 活动故障/部分失败 (contract §8, amendment BLOCK-5).
//
// Fault points under test: the injected dispatcher throws, the reducer throws after writing,
// a progress event carries an unusable receipt, the source disappears mid-flight, the
// budget refuses, and a stale executor tries to advance a prefix it no longer owns. Every
// case must leave *no half state* — no row without its receipt, no receipt without its row,
// no advanced prefix without its interval.

const T0 = Date.UTC(2026, 9, 30, 4, 0, 0);
const SCOPE = Object.freeze({ userId: 'owner-1', personaId: 'bot', worldId: 'world:default' });
const KEY = scopeKey(SCOPE);
const SOURCE = Array.from({ length: 10 }, (_, index) => `第${index}段：` + '灯塔每十二秒闪一次。'.repeat(6)).join('\n\n');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-faults-'));
  fs.mkdirSync(path.join(dir, 'shelf'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'shelf', 'light.md'), `# 灯塔\n\n${SOURCE}`, 'utf8');
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  return dir;
}

function filePorts(overrides = {}) {
  return {
    readFile({ path: file }) { try { return { ok: true, text: fs.readFileSync(file, 'utf8') }; } catch { return { ok: false }; } },
    writeFile({ path: file, text }) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, 'utf8'); return { ok: true, bytes: Buffer.byteLength(text) }; },
    fetchPage() { return { ok: false, status: 0 }; },
    ...overrides,
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

function openDb(t) {
  const db = openRuntimeDb({ file: ':memory:', now: () => T0 });
  db.acquireLease({ owner: 'test', generation: 'gen-1', ttlMs: 600000 });
  db.commitProjection({ scope: KEY, generation: 'gen-1', payload: {}, updatedAt: T0 });
  t.after(() => { try { db.close(); } catch { /* already closed */ } });
  return db;
}

const dispatchFor = db => event => dispatchEvent(db, event, { handlers: { autonomy: applyActivityEvent }, generation: 'gen-1', requireConsumers: true });

function insertSlot(db, { slotId, kind = 'activity', target, startAt = T0, endAt = T0 + 3600000 }) {
  db.run(`INSERT INTO p2_plan_slots (slot_id, plan_id, scope, day, start_at, end_at, kind, activity, title, detail,
            flexibility, intent, target_ref, status, locked, created_at, updated_at)
          VALUES (?, 'plan-1', ?, '2026-10-30', ?, ?, ?, 'read', '灯塔', '{}', 'soft', '', ?, 'planned', 0, ?, ?)`,
  slotId, KEY, startAt, endAt, kind, target, T0, T0);
}

function makeActivities({ db, workspace, ports = filePorts(), config = configFor(), dispatch, extra = {} }) {
  return createActivities({
    db, config, clock: () => T0 + 1000, owner: 'test', generation: 'gen-1',
    dispatch: dispatch ?? dispatchFor(db), ports, workspace, ...extra,
  });
}

function counts(db) {
  return {
    events: Number(db.get('SELECT COUNT(*) AS n FROM domain_events').n),
    receipts: Number(db.get('SELECT COUNT(*) AS n FROM p2_activity_receipts').n),
    activities: Number(db.get('SELECT COUNT(*) AS n FROM p2_activities').n),
    version: db.projection(KEY).version,
  };
}

test('P2-11: a throwing dispatcher leaves no activity, no receipt and no event', t => {
  const workspace = tempDir(t);
  const db = openDb(t);
  insertSlot(db, { slotId: 'slot-1', target: 'shelf/light.md' });
  const activities = makeActivities({ db, workspace, dispatch: () => { throw new Error('dispatcher exploded'); } });
  const before = counts(db);
  assert.throws(() => activities.start({ slotId: 'slot-1', kind: 'read' }), error => error.code === 'activity-failed');
  assert.deepEqual(counts(db), before, 'a failed dispatch wrote nothing at all');

  const rejected = makeActivities({ db, workspace, dispatch: () => ({ rejected: true, results: [{ error: 'nope', code: 'invalid-transition', deterministic: true }] }) });
  assert.throws(() => rejected.start({ slotId: 'slot-1', kind: 'read' }), error => error.code === 'invalid-transition');
  assert.deepEqual(counts(db), before);
});

test('P2-11: a reducer that fails after writing rolls the activity rows back but keeps the log', t => {
  const workspace = tempDir(t);
  const db = openDb(t);
  insertSlot(db, { slotId: 'slot-1', target: 'shelf/light.md' });
  const before = counts(db);
  function failingAfterWrite(ctx) {
    const outcome = applyActivityEvent(ctx);
    if (outcome.extra) outcome.extra(ctx.db, ctx.event);
    throw new Error('consumer exploded after writing');
  }
  const event = {
    kind: 'autonomy/activity',
    scope: SCOPE,
    occurredAt: T0,
    payload: {
      phase: 'started',
      generation: 'gen-1',
      activity: {
        activityId: 'act_direct', scope: KEY, kind: 'read', adapter: 'read', capability: 'read',
        reality: 'hypothetical', target: 'shelf/light.md', sourceRef: 'file:shelf/light.md',
        sourceHash: 'a'.repeat(64), totalUnits: 100, artifactRef: '', artifactHash: '', artifactVersion: 0,
      },
      consumed: { from: 0, to: 0 },
      checkpoint: { position: 0 },
      receipt: { operation: 'start', ok: true, code: '', detail: '{"reality":"hypothetical","kind":"read","adapter":"read","units":0,"note":"start"}', sourceHash: 'a'.repeat(64), consumedFrom: 0, consumedTo: 0, artifactRef: '' },
    },
  };
  const attempt = dispatchEvent(db, event, { handlers: { autonomy: failingAfterWrite }, generation: 'gen-1' });
  assert.equal(attempt.inserted, true, 'the log row survives for a retry');
  assert.equal(attempt.rejected, false, 'a non-deterministic failure is not a veto');
  assert.equal(attempt.results[0].code, 'internal');
  const after = counts(db);
  assert.equal(after.events, before.events + 1);
  assert.equal(after.activities, before.activities, 'the half-written activity row was rolled back');
  assert.equal(after.receipts, before.receipts, 'no receipt was committed');
  assert.equal(after.version, before.version, 'the projection did not move');

  // The retry uses the same deterministic event id and finishes the job exactly once.
  const retry = dispatchEvent(db, attempt.event, { handlers: { autonomy: applyActivityEvent }, generation: 'gen-1', requireConsumers: true });
  assert.equal(retry.inserted, false);
  assert.equal(retry.results[0].applied, true);
  const settled = counts(db);
  assert.equal(settled.events, after.events);
  assert.equal(settled.activities, 1);
  assert.equal(settled.receipts, 1);
  const fresh = makeActivities({ db, workspace });
  assert.equal(fresh.list().length, 1);
});

test('P2-11: a progress event with an unusable receipt is vetoed and advances nothing', t => {
  const workspace = tempDir(t);
  const db = openDb(t);
  insertSlot(db, { slotId: 'slot-1', target: 'shelf/light.md' });
  const activities = makeActivities({ db, workspace });
  const started = activities.start({ slotId: 'slot-1', kind: 'read' });
  const step = activities.step({ activityId: started.activityId, units: 200 });
  const prefix = step.consumedPrefix;
  const before = counts(db);

  const row = db.get('SELECT * FROM p2_activities WHERE activity_id = ?', started.activityId);
  const brokenReceipt = {
    kind: 'autonomy/activity',
    scope: SCOPE,
    occurredAt: T0 + 3000,
    payload: {
      phase: 'progress',
      generation: 'gen-1',
      activity: { activityId: started.activityId, scope: KEY, kind: 'read', totalUnits: row.total_units },
      consumed: { from: prefix, to: prefix + 50 },
      expectedConsumed: prefix,
      checkpoint: { ...JSON.parse(row.checkpoint), consumed: { from: prefix, to: prefix + 50 } },
      // A receipt without an operation cannot be filed: the whole progress is refused, so
      // "consumed without a receipt" is impossible by construction.
      receipt: { ok: true, code: '', detail: '{}', sourceHash: row.source_hash, consumedFrom: prefix, consumedTo: prefix + 50 },
    },
  };
  const outcome = dispatchEvent(db, brokenReceipt, { handlers: { autonomy: applyActivityEvent }, generation: 'gen-1', requireConsumers: true });
  assert.equal(outcome.rejected, true);
  assert.equal(outcome.results[0].code, 'invalid-payload');
  assert.equal(Number(db.get('SELECT consumed_prefix FROM p2_activities WHERE activity_id = ?', started.activityId).consumed_prefix), prefix, 'the prefix did not move');
  assert.deepEqual(counts(db), before, 'no receipt, no event, no projection change');
});

test('P2-11: a stale executor cannot advance a prefix it no longer owns', t => {
  const workspace = tempDir(t);
  const db = openDb(t);
  insertSlot(db, { slotId: 'slot-1', target: 'shelf/light.md' });
  const activities = makeActivities({ db, workspace });
  const started = activities.start({ slotId: 'slot-1', kind: 'read' });
  const first = activities.step({ activityId: started.activityId, units: 200 });

  // The executor believed it was still at offset 0 (a reloaded worker with an old view).
  assert.throws(
    () => activities.step({ activityId: started.activityId, units: 200, expectedConsumed: 0 }),
    error => error.code === 'stale-consumed',
  );
  assert.equal(Number(db.get('SELECT consumed_prefix FROM p2_activities WHERE activity_id = ?', started.activityId).consumed_prefix), first.consumedPrefix);

  // A gap (a progress event that starts past the prefix) is refused as well.
  const row = db.get('SELECT * FROM p2_activities WHERE activity_id = ?', started.activityId);
  const gap = dispatchEvent(db, {
    kind: 'autonomy/activity',
    scope: SCOPE,
    occurredAt: T0 + 3000,
    payload: {
      phase: 'progress',
      generation: 'gen-1',
      activity: { activityId: started.activityId, scope: KEY, kind: 'read', totalUnits: row.total_units },
      consumed: { from: Number(row.consumed_prefix) + 10, to: Number(row.consumed_prefix) + 60 },
      expectedConsumed: Number(row.consumed_prefix),
      receipt: { operation: 'step', ok: true, code: '', detail: '{}', sourceHash: row.source_hash, consumedFrom: 0, consumedTo: 1 },
    },
  }, { handlers: { autonomy: applyActivityEvent }, generation: 'gen-1', requireConsumers: true });
  assert.equal(gap.rejected, true);
  assert.equal(gap.results[0].code, 'stale-consumed');
  assert.equal(Number(db.get('SELECT consumed_prefix FROM p2_activities WHERE activity_id = ?', started.activityId).consumed_prefix), first.consumedPrefix);
});

test('P2-11: a source that disappears mid-flight pauses the activity with review evidence', t => {
  const workspace = tempDir(t);
  const db = openDb(t);
  insertSlot(db, { slotId: 'slot-1', target: 'shelf/light.md' });
  const activities = makeActivities({ db, workspace });
  const started = activities.start({ slotId: 'slot-1', kind: 'read' });
  const first = activities.step({ activityId: started.activityId, units: 200 });

  fs.rmSync(path.join(workspace, 'shelf', 'light.md'));
  const parked = activities.step({ activityId: started.activityId, units: 200 });
  assert.equal(parked.ok, false);
  assert.equal(parked.code, 'source-invalid');
  assert.equal(parked.status, 'paused', 'a withdrawn source pauses instead of continuing');
  assert.equal(parked.needsReview, true);
  assert.equal(parked.consumedPrefix, first.consumedPrefix, 'no progress was invented');
  const row = db.get('SELECT * FROM p2_activities WHERE activity_id = ?', started.activityId);
  assert.equal(row.status, 'paused');
  assert.equal(JSON.parse(row.checkpoint).needsReview, true);
  assert.ok(db.get("SELECT 1 AS one FROM p2_activity_receipts WHERE operation = 'review' AND code = 'source-invalid'"));
  // Resume re-verifies and refuses while the source is still missing.
  assert.throws(() => activities.resume({ activityId: started.activityId }), error => error.code === 'source-invalid');
});

test('P2-11: a budget refusal is passed through and creates nothing', t => {
  const workspace = tempDir(t);
  const db = openDb(t);
  insertSlot(db, { slotId: 'slot-1', target: 'shelf/light.md' });
  const activities = makeActivities({
    db, workspace,
    extra: { budget: { check: () => ({ ok: false, code: 'budget-exhausted', detail: 'no requests left' }) } },
  });
  assert.throws(() => activities.start({ slotId: 'slot-1', kind: 'read' }), error => error.code === 'budget-exhausted');
  assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM p2_activities').n), 0);
  // A throwing budget gate surfaces its own code, never a silent success.
  const throwing = makeActivities({ db, workspace, extra: { budget: { check: () => { throw new Error('ledger unavailable'); } } } });
  assert.throws(() => throwing.start({ slotId: 'slot-1', kind: 'read' }), error => error.code === 'budget-exhausted');
});

test('P2-11: an implicit activity can never reach a memory entry point', t => {
  const workspace = tempDir(t);
  const db = openDb(t);
  insertSlot(db, { slotId: 'slot-1', target: 'shelf/light.md' });
  const experienceCalls = [];
  const ports = filePorts({ recordExperience: payload => { experienceCalls.push(payload); return { ok: true, receiptId: 'r1' }; } });
  const activities = makeActivities({ db, workspace, ports });
  const started = activities.start({ slotId: 'slot-1', kind: 'read' });
  activities.step({ activityId: started.activityId, units: 200 });
  activities.finish({ activityId: started.activityId });

  assert.equal(experienceCalls.length, 0, 'this module never writes an experience itself');
  const row = db.get('SELECT * FROM p2_activities WHERE activity_id = ?', started.activityId);
  // The memory gate (Lead-owned `p2.mjs#recordExperience`) only accepts `actual_tool_activity`,
  // so an activity whose reality was never stated can never be remembered as a real one.
  assert.notEqual(row.reality, 'actual_tool_activity');
  assert.equal(row.reality, 'hypothetical');
  insertSlot(db, { slotId: 'slot-sim', target: 'shelf/light.md' });
  const simulated = activities.start({ slotId: 'slot-sim', kind: 'read', reality: 'simulated_world' });
  assert.equal(db.get('SELECT reality FROM p2_activities WHERE activity_id = ?', simulated.activityId).reality, 'simulated_world');
});

// ---------------------------------------------------------------- async ports (B-3)

/**
 * The production foundation ports are **async**. A rejection from one of them must reach the
 * same park path as a synchronous throw: paused + `needsReview` + one deduplicated `review`
 * receipt. Reviewer pass 2 (B-3) found the sync-only `catch` left the activity `running` for
 * ever, retrying a dead source.
 */
function asyncFilePorts(root, calls = { reads: 0 }) {
  return {
    calls,
    async readFile({ path: file }) {
      calls.reads += 1;
      await new Promise(resolve => setImmediate(resolve)); // a real async boundary
      try { return { ok: true, text: fs.readFileSync(file, 'utf8') }; } catch { return { ok: false }; }
    },
    async writeFile() { return { ok: false }; },
    async fetchPage() { return { ok: false, status: 0 }; },
  };
}

function receiptsFor(db, activityId, operation = null) {
  // `lc-effect`: R4's write-ahead execution intent and its confirmation share `operation='review'`
  // with refusals but are a different row class (lifecycle design §2.1), so they are excluded here
  // — otherwise "how many review receipts did this failure leave" would count the intent too.
  return operation
    ? db.all("SELECT * FROM p2_activity_receipts WHERE activity_id = ? AND operation = ? AND code <> 'lc-effect' ORDER BY at, receipt_id", activityId, operation)
    : db.all('SELECT * FROM p2_activity_receipts WHERE activity_id = ? ORDER BY at, receipt_id', activityId);
}

test('P2-11 (B-3): with async ports a changed source parks the activity instead of retrying for ever', async t => {
  const workspace = tempDir(t);
  const db = openDb(t);
  insertSlot(db, { slotId: 'slot-async', target: 'shelf/light.md' });
  const ports = asyncFilePorts(workspace);
  const activities = makeActivities({ db, workspace, ports });

  const started = await activities.start({ slotId: 'slot-async', kind: 'read' });
  assert.equal(typeof started.then, 'undefined', 'the start already settled (the test awaits it)');
  const first = await activities.step({ activityId: started.activityId, units: 200 });
  const second = await activities.step({ activityId: started.activityId, units: 200 });
  const prefix = second.consumedPrefix;
  assert.ok(prefix > first.consumedPrefix);

  // The source changes behind the activity's back.
  fs.appendFileSync(path.join(workspace, 'shelf/light.md'), '\n\n来源被改写了。', 'utf8');

  const parked = await activities.step({ activityId: started.activityId, units: 200 });
  assert.equal(parked.ok, false, 'the async rejection resolves into a refusal object');
  assert.equal(parked.code, 'source-changed');
  assert.equal(parked.status, 'paused', 'B-3: the activity is parked, not left running');
  assert.equal(parked.needsReview, true);
  assert.equal(parked.consumedPrefix, prefix, 'no progress was invented');

  const row = db.get('SELECT * FROM p2_activities WHERE activity_id = ?', started.activityId);
  assert.equal(row.status, 'paused');
  assert.equal(Number(row.consumed_prefix), prefix);
  assert.equal(JSON.parse(row.checkpoint).needsReview, true, 'the checkpoint carries the review flag');

  const review = receiptsFor(db, started.activityId, 'review');
  assert.equal(review.length, 1, 'exactly one review receipt, with the real code');
  assert.equal(review[0].code, 'source-changed');
  assert.equal(Number(review[0].ok), 0);
  const pause = receiptsFor(db, started.activityId, 'pause');
  assert.equal(pause.length, 1);
  assert.equal(pause[0].code, 'source-changed');

  // Recovery agrees with the row: the parked activity is a review item, not "resumed" and not
  // silently done.
  const reconcile = await activities.reconcile();
  assert.ok(reconcile.needsReview.includes(started.activityId), 'reconcile() reports the parked activity as needsReview');
  assert.deepEqual(reconcile.resumed, []);
  assert.equal(db.get('SELECT status FROM p2_activities WHERE activity_id = ?', started.activityId).status, 'paused', 'reconcile never finishes it');

  // A second failing attempt adds no second receipt for the same interval.
  const receiptsBefore = receiptsFor(db, started.activityId).length;
  let secondFailure = null;
  try {
    secondFailure = await activities.step({ activityId: started.activityId, units: 200 });
  } catch (error) {
    secondFailure = { ok: false, code: error.code };
  }
  assert.equal(secondFailure.ok, false);
  assert.equal(secondFailure.code, 'invalid-transition', 'a paused activity accepts no progress');
  assert.equal(receiptsFor(db, started.activityId).length, receiptsBefore, 'no extra receipt for the same interval');
  assert.equal(receiptsFor(db, started.activityId, 'review').length, 1, 'the review receipt stays deduplicated');
});

test('P2-11 (B-3): an async port that rejects is a source failure, not a crash', async t => {
  const workspace = tempDir(t);
  const db = openDb(t);
  insertSlot(db, { slotId: 'slot-boom', target: 'shelf/light.md' });
  let reads = 0;
  const ports = {
    async readFile() {
      reads += 1;
      if (reads === 1) return { ok: true, text: fs.readFileSync(path.join(workspace, 'shelf/light.md'), 'utf8') };
      throw new Error('socket hang up');
    },
    async writeFile() { return { ok: false }; },
    async fetchPage() { return { ok: false, status: 0 }; },
  };
  const activities = makeActivities({ db, workspace, ports });
  const started = await activities.start({ slotId: 'slot-boom', kind: 'read' });
  const step = await activities.step({ activityId: started.activityId, units: 200 });
  assert.equal(step.ok, false);
  assert.equal(step.code, 'source-invalid', 'a rejected port is classified as a source failure');
  assert.equal(step.status, 'paused');
  assert.equal(step.needsReview, true);
  assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM p2_activity_receipts WHERE activity_id = ? AND operation = ? AND code <> ?', started.activityId, 'review', 'lc-effect').n), 1);
  assert.equal(Number(db.get('SELECT consumed_prefix FROM p2_activities WHERE activity_id = ?', started.activityId).consumed_prefix), 0, 'nothing was consumed');
});

test('P2-11 (B-3): an async prepare rejection still files its refusal evidence', async t => {
  const workspace = tempDir(t);
  const db = openDb(t);
  insertSlot(db, { slotId: 'slot-gone', target: 'shelf/missing.md' });
  const ports = asyncFilePorts(workspace);
  const activities = makeActivities({ db, workspace, ports });
  let failure = null;
  try {
    await activities.start({ slotId: 'slot-gone', kind: 'read' });
  } catch (error) {
    failure = error;
  }
  assert.equal(failure?.code, 'source-invalid');
  assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM p2_activities').n), 0, 'no activity row');
  const review = db.get("SELECT * FROM p2_activity_receipts WHERE operation = 'review' AND code <> 'lc-effect'");
  assert.ok(review, 'the refused start is durable evidence even when prepare rejects');
  assert.equal(review.code, 'source-invalid');
});
