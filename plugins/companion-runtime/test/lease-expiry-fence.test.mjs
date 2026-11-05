import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openRuntimeDb } from '../lib/db.mjs';
import { appendEvent, applyEvent, dispatchEvent, normalizeEvent } from '../lib/events.mjs';
import { applyBridgeEvent, drainOutbox } from '../lib/bridge.mjs';
import { createActivities, applyActivityEvent } from '../lib/activities.mjs';
import { scopeKey } from '../lib/scope.mjs';
import { StaleGenerationError, RuntimeStoppedError } from '../lib/errors.mjs';
import { mountRuntime } from '../index.mjs';

// P2.5-4A: the writer lease is a *time* fence, not only a generation label.
//
// Before this file, fifteen write paths asked "is this still the current generation?" and a
// process that was suspended past its lease TTL could wake up and commit as a ghost writer until
// somebody else happened to take the lease over (A1 §4.4 #1–#11, #15). The contract now is:
//   * `db.assertLeaseValid({owner, generation, at})` is the single primitive (generation +
//     lease expiry + optional owner), and `assertWritable`/`assertLeaseHeld` are its two forms;
//   * `heartbeatLease` refuses to revive an expired row, so recovery is a takeover, never a
//     resurrection;
//   * every write path in this slice (`events.appendEvent`, `events.applyEvent`,
//     `db.commitProjection`, the five `bridge` marks, `activities.assertRunGate`) goes through it.
//
// Every case is isolated: temp files under `os.tmpdir()` or `:memory:`, no network, no QQ, no
// production database.

const T0 = Date.UTC(2026, 10, 2, 2, 0, 0);
const SCOPE = Object.freeze({ userId: 'owner-1', personaId: 'march7', worldId: 'world:default' });
const KEY = scopeKey(SCOPE);
const TTL = 60000;

function tempRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-lease-expiry-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });
  return dir;
}

/** One memory database whose wall clock the test owns. */
function openClock(t, { owner = 'owner-a', generation = 'gen-a', ttlMs = TTL } = {}) {
  const clock = { value: T0 };
  const db = openRuntimeDb({ file: ':memory:', now: () => clock.value });
  t.after(() => { try { db.close(); } catch { /* already closed */ } });
  db.acquireLease({ owner, generation, ttlMs });
  return { db, clock, owner, generation };
}

const goalEvent = (occurredAt = T0, title = '看一页书') => normalizeEvent({
  kind: 'goal/proposed', scope: SCOPE, occurredAt, payload: { title },
});
const goalHandlers = () => ({ goals: ({ slice }) => ({ slice: { applied: Number(slice.applied ?? 0) + 1 } }) });

// ---------------------------------------------------------------------------
// 1. the primitive
// ---------------------------------------------------------------------------

test('4A: assertLeaseValid decides generation, owner and expiry in one place', t => {
  const { db, clock, owner, generation } = openClock(t);

  assert.deepEqual(db.assertLeaseValid({ owner, generation }), { ok: true, checked: 'owner+expiry' });
  assert.deepEqual(db.assertLeaseValid({ generation }), { ok: true, checked: 'generation+expiry' });

  // A generation that is not the writer's is refused before anything else is read.
  assert.throws(() => db.assertLeaseValid({ generation: 'gen-old' }), error => error instanceof StaleGenerationError);

  // An owner that no longer holds the row is refused ("lease-lost"), even with the right generation.
  assert.throws(() => db.assertLeaseValid({ owner: 'owner-b', generation }), error => error.code === 'lease-lost');

  // Right before the expiry the lease still authorises writes …
  clock.value = T0 + TTL - 1;
  assert.equal(db.assertLeaseValid({ owner, generation }).ok, true);
  // … and at/after the expiry it does not, even though the row still names this generation.
  clock.value = T0 + TTL;
  assert.throws(() => db.assertLeaseValid({ owner, generation }), error => error.code === 'lease-expired');
  assert.throws(() => db.assertWritable(generation), error => error.code === 'lease-expired');
  assert.throws(() => db.assertLeaseHeld({ owner, generation, at: clock.value }), error => error.code === 'lease-expired');

  // A stopped runtime outranks every other answer.
  db.setStopped(true, 'operator-stop');
  assert.throws(() => db.assertLeaseValid({ owner, generation }), error => error instanceof RuntimeStoppedError);
  db.setStopped(false);

  // The strict form needs a row at all; the loose form keeps the historical "released" meaning.
  db.releaseLease(generation, owner);
  assert.throws(() => db.assertLeaseHeld({ owner, generation }), error => error.code === 'lease-lost');
  assert.deepEqual(db.assertLeaseValid({ owner, generation }), { ok: true, checked: 'generation' });
  // A generation-less call is the stop latch only (replay uses this).
  assert.deepEqual(db.assertLeaseValid({}), { ok: true, checked: 'stop' });
});

// ---------------------------------------------------------------------------
// 2. renewal never resurrects an expired lease
// ---------------------------------------------------------------------------

test('4A: an expired lease cannot be renewed, only taken over by a new generation', t => {
  const { db, clock, owner, generation } = openClock(t);
  const before = db.leaseRow();

  // Inside the window the heartbeat renews, exactly as before.
  clock.value = T0 + TTL - 1000;
  assert.equal(db.heartbeatLease({ owner, generation, ttlMs: TTL }), true);
  assert.ok(db.leaseRow().expiresAt > before.expiresAt, 'the renewal extended the row');

  // Past the renewed expiry the renewal is refused: the process is no longer the writer.
  clock.value = db.leaseRow().expiresAt + 1;
  assert.equal(db.heartbeatLease({ owner, generation, ttlMs: TTL }), false, 'an expired row is never revived');
  const frozen = db.leaseRow();
  assert.equal(frozen.generation, generation, 'the dead row still names the old generation (crash evidence)');
  assert.ok(frozen.expiresAt < clock.value);

  // The old owner is fenced out of every write until a takeover happens.
  assert.throws(() => db.assertWritable(generation), error => error.code === 'lease-expired');

  // A new generation takes the expired lease over and immediately becomes the only writer.
  assert.equal(db.acquireLease({ owner: 'owner-b', generation: 'gen-b', ttlMs: TTL }).ok, true);
  assert.equal(db.currentGeneration(), 'gen-b');
  assert.deepEqual(db.assertLeaseValid({ owner: 'owner-b', generation: 'gen-b' }).ok, true);
  assert.throws(() => db.assertWritable(generation), error => error instanceof StaleGenerationError);
});

// ---------------------------------------------------------------------------
// 3. the P1 event log (the single choke point)
// ---------------------------------------------------------------------------

test('4A: the event append is fenced by lease expiry, so no ghost event reaches the log', t => {
  const { db, clock, owner, generation } = openClock(t);

  const first = dispatchEvent(db, goalEvent(), { handlers: goalHandlers(), generation, owner });
  assert.equal(first.inserted, true);
  assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM domain_events').n), 1);

  clock.value = T0 + TTL + 5;
  assert.throws(
    () => dispatchEvent(db, goalEvent(T0 + 1, '第二条'), { handlers: goalHandlers(), generation, owner }),
    error => error.code === 'lease-expired',
  );
  assert.throws(
    () => appendEvent(db, goalEvent(T0 + 2, '第三条'), { generation, owner }),
    error => error.code === 'lease-expired',
  );
  assert.throws(
    () => applyEvent(db, { consumer: 'goals', event: goalEvent(T0 + 3, '第四条'), generation, owner, apply: goalHandlers().goals }),
    error => error.code === 'lease-expired',
  );
  assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM domain_events').n), 1, 'the fenced writes appended nothing');
  assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM consumer_receipts').n), 1, 'and consumed nothing');

  // A renewal inside the window keeps the same writer working: the fence is expiry, not age.
  db.acquireLease({ owner, generation, ttlMs: TTL * 100 });
  const renewed = dispatchEvent(db, goalEvent(T0 + 4, '第五条'), { handlers: goalHandlers(), generation, owner });
  assert.equal(renewed.inserted, true);
});

// ---------------------------------------------------------------------------
// 4. the memory bridge: a lapsed drain never records a delivery
// ---------------------------------------------------------------------------

function outboxRows(db) {
  return db.all('SELECT status, attempts, receipt_id, claim_owner FROM memory_outbox ORDER BY created_at ASC');
}

test('4A: a drain that loses its lease mid-flight stays queued and is never reported as sent', async t => {
  const { db, clock, owner, generation } = openClock(t, { owner: 'bridge-owner', generation: 'gen-bridge' });

  // One real queued ingest through the normal event path (no generation: replay-compatible).
  const event = normalizeEvent({
    kind: 'memory/ingest-request', scope: SCOPE, occurredAt: T0,
    realityStatus: 'actual_tool_activity', evidenceStatus: 'confirmed',
    payload: { content: '今天读完了一页书', transformVersion: 't1' },
  });
  applyEvent(db, { consumer: 'bridge', event, apply: args => applyBridgeEvent(args) });
  assert.equal(outboxRows(db).length, 1);

  // The memory call itself takes longer than the lease had left.
  const memory = {
    async ingestDomainEvent() {
      clock.value = T0 + TTL + 1000;
      return { status: 'accepted', receiptId: 'rcpt_ghost' };
    },
  };
  const summary = await drainOutbox({ db, memory, scopeKey: KEY, generation, owner, now: T0 + 1000 });
  assert.equal(summary.processed, 1);
  assert.equal(summary.delivered, 0, 'a lost lease cannot be reported as delivered');
  assert.equal(summary.skipped, 'writer-fenced');
  const [row] = outboxRows(db);
  assert.equal(row.status, 'queued', 'the record stays queued for the next writer');
  assert.equal(row.receipt_id, '', 'no receipt was stored');
  assert.equal(row.attempts, 0, 'the fenced drain did not even count an attempt');

  // Once the lease has lapsed, the drain refuses up front instead of shrinking the queue.
  await assert.rejects(
    drainOutbox({ db, memory, scopeKey: KEY, generation, owner, now: clock.value }),
    error => error.code === 'lease-expired',
  );
  assert.equal(outboxRows(db).length, 1);
  assert.equal(outboxRows(db)[0].status, 'queued');
});

// ---------------------------------------------------------------------------
// 5. P2 activities: refuse before spending a token
// ---------------------------------------------------------------------------

function workspaceWithNote(t) {
  const dir = tempRoot(t);
  fs.mkdirSync(path.join(dir, 'shelf'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'shelf', 'note.md'), '# 海风\n\n' + '海风把纸吹得作响。'.repeat(20), 'utf8');
  return dir;
}

function activityWorld(t) {
  const { db, clock, owner, generation } = openClock(t);
  db.commitProjection({ scope: KEY, generation, payload: {}, updatedAt: T0 });
  db.run(`INSERT INTO p2_plan_slots (slot_id, plan_id, scope, day, start_at, end_at, kind, activity, title, detail,
            flexibility, intent, target_ref, status, locked, created_at, updated_at)
          VALUES ('slot-1', 'plan-1', ?, '2026-11-02', ?, ?, 'activity', 'read', '海风', '{}', 'soft', '', 'shelf/note.md', 'planned', 0, ?, ?)`,
  KEY, T0, T0 + 3600000, T0, T0);
  const activities = createActivities({
    db,
    config: { p2: { activities: { enabled: true, paused: false, chunkUnits: 200, maxUnitsPerStep: 4000, maxSourceBytes: 200000, maxTotalUnits: 200000, maxExcerptChars: 400 } } },
    clock: () => clock.value,
    owner,
    generation,
    dispatch: input => dispatchEvent(db, input, { handlers: { autonomy: applyActivityEvent }, generation, owner, requireConsumers: true }),
    ports: {
      readFile({ path: file }) { try { return { ok: true, text: fs.readFileSync(file, 'utf8') }; } catch { return { ok: false }; } },
      writeFile() { return { ok: false }; },
      fetchPage() { return { ok: false, status: 0 }; },
    },
    workspace: workspaceWithNote(t),
  });
  return { db, clock, activities, owner, generation };
}

test('4A: the activity controller refuses an expired writer before it does any work', t => {
  const { db, clock, activities } = activityWorld(t);

  // Control: inside the window the activity really starts (the fence is not "nothing works").
  clock.value = T0 + TTL - 1000;
  const started = activities.start({ slotId: 'slot-1', kind: 'read' });
  assert.equal(started.status, 'running');
  assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM p2_activities').n), 1);

  // The lease lapses: the controller refuses, and the refusal is typed and explicit.
  clock.value = T0 + TTL + 1000;
  assert.throws(() => activities.step({ activityId: started.activityId, units: 50 }), error => error.code === 'lease-expired');
  assert.throws(() => activities.finish({ activityId: started.activityId }), error => error.code === 'lease-expired');
  assert.throws(() => activities.pause({ activityId: started.activityId }), error => error.code === 'lease-expired');
  // Nothing advanced: prefix, status and receipt count are exactly what the live writer left.
  const row = db.get('SELECT status, consumed_prefix FROM p2_activities WHERE activity_id = ?', started.activityId);
  assert.equal(row.status, 'running');
  assert.equal(Number(row.consumed_prefix), 0);
  assert.equal(Number(db.get("SELECT COUNT(*) AS n FROM p2_activity_receipts WHERE code <> 'lc-effect'").n), 1, 'only the start receipt exists');
});

// ---------------------------------------------------------------------------
// 6. the mounted runtime: a lapsed writer is visibly dead, not quietly writing
// ---------------------------------------------------------------------------

function mountRoot(t, config) {
  const root = tempRoot(t);
  for (const dir of ['home/companion', 'logs']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, 'home/companion/identity.json'), JSON.stringify({
    schemaVersion: 1, persona: 'march7', owner: { id: 'owner-1', displayName: 'o', platform: 'qq' },
    desktop: { mode: 'local-owner', userId: 'owner-1' }, sessions: {},
  }));
  fs.writeFileSync(path.join(root, 'home/companion/runtime.config.json'), JSON.stringify(config));
  return root;
}

test('4A: after the lease lapses a mounted runtime is fenced, and renewal cannot undo it', t => {
  const clock = { value: T0 };
  const root = mountRoot(t, { enabled: true, mode: 'active', leaseTtlMs: 10000 });
  const ctx = { tools: { register() {} }, systemPrompt: { section() {} }, on() {}, get() { return undefined; } };
  const identity = { resolve: sessionId => ({ userId: 'owner-1', personaId: 'march7', sessionId }) };
  const runtime = mountRuntime(ctx, root, { now: () => clock.value, identity });
  t.after(() => { try { runtime.dispose(); } catch { /* already disposed */ } });
  assert.equal(runtime.writable, true);

  const written = runtime.recordEvent({ sessionId: 's', kind: 'goal/proposed', payload: { title: '泡一杯茶' } });
  assert.equal(written.ok, true, JSON.stringify(written));

  // The process is suspended for longer than its own lease TTL (the laptop-lid case).
  clock.value = T0 + 60000;
  const renewed = runtime.heartbeat();
  assert.equal(renewed.ok, false, 'renewal of an expired lease is refused, never silently revived');

  const ghost = runtime.recordEvent({ sessionId: 's', kind: 'goal/proposed', payload: { title: '第二个目标' } });
  assert.equal(ghost.ok, false);
  assert.equal(ghost.code, 'lease-expired', JSON.stringify(ghost));

  const status = runtime.status({ sessionId: 's' });
  assert.notEqual(status.lease, 'held', 'the mount no longer claims a healthy lease');
  assert.equal(Number(status.eventCount), 1, 'exactly the one event the live writer committed');
});
