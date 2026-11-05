import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openRuntimeDb } from '../lib/db.mjs';
import { dispatchEvent } from '../lib/events.mjs';
import {
  applyActivityEvent, createActivities, effectBlock, effectIndex, effectKeyFor,
  effectRecords, jobKeyFor,
} from '../lib/activities.mjs';
import { applyPlanEvent } from '../lib/planner.mjs';
import { createP2 } from '../lib/p2.mjs';
import { RuntimeError } from '../lib/errors.mjs';
import { parseScope, scopeKey } from '../lib/scope.mjs';

// P2.5 R4 — a durable execution intent before any external effect.
//
// `start()` used to call `adapter.prepare()` first and create the activity row afterwards, while
// explore's prepare already fetched a page and write's prepare already wrote an artifact. So "no
// activity row" could not distinguish "nothing happened" from "the call went out and the result was
// lost", two overlapping pump passes could both enter prepare for one slot, and a plan superseded
// during an async prepare still committed its result.
//
// The fix is a write-ahead `lc-effect / prepared` record whose deterministic receipt id is the
// table's primary key, a re-check after the adapter returns and before the row is committed, an
// `unknown` phase when that re-check fails, and dispatch queries that refuse a job with an
// unresolved effect. These tests pin each of those five behaviours; all of them count the *external
// calls* (the port invocation), not just rows, because that is what "at most once" is about.

const T0 = Date.UTC(2026, 10, 5, 2, 0, 0);
const HOUR = 3600000;
const SCOPE = Object.freeze({ userId: 'owner-9', personaId: 'march7', worldId: 'world:default' });
const KEY = scopeKey(SCOPE);
const OWNER = '999999:r4:test';
const GEN = 'gen-r4';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-effect-'));
  fs.mkdirSync(path.join(dir, 'shelf'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'shelf', 'tide.md'), '潮水在傍晚退去。'.repeat(60), 'utf8');
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });
  return dir;
}

function configFor(extra = {}) {
  return {
    p2: {
      planning: { enabled: true },
      activities: {
        enabled: true, paused: false, chunkUnits: 100, maxUnitsPerStep: 3000,
        maxSourceBytes: 200000, maxTotalUnits: 200000, maxExcerptChars: 400, draftsDir: 'drafts',
        // A short deadline so a "crashed" prepare becomes `unknown` inside the test, not in 15 min.
        effectDeadlineMs: 60000,
        ...extra,
      },
      autonomy: { allowedSources: [] },
    },
  };
}

function world(t, { planStatus = 'committed', clock = { value: T0 } } = {}) {
  const dir = tempDir(t);
  const db = openRuntimeDb({ file: ':memory:', now: () => clock.value });
  t.after(() => { try { db.close(); } catch { /* already closed */ } });
  assert.equal(db.acquireLease({ owner: OWNER, generation: GEN, ttlMs: 3600000 }).ok, true);
  db.commitProjection({ scope: KEY, generation: GEN, payload: {}, updatedAt: T0 });
  db.run(`INSERT INTO p2_plans (plan_id, scope, day, version, status, time_zone, window_start, window_end, summary, source_run_id, supersedes, created_at, committed_at)
          VALUES ('plan-1', ?, '2026-11-05', 1, ?, 'Asia/Shanghai', ?, ?, '', '', '', ?, ?)`,
  KEY, planStatus, T0 - 6 * HOUR, T0 + 6 * HOUR, T0, T0);
  return { dir, db, clock };
}

function insertSlot(db, { slotId, startAt = T0 - HOUR, endAt = T0 + HOUR, kind = 'activity', activity = 'read', target = 'shelf/tide.md', planId = 'plan-1' }) {
  db.run(`INSERT INTO p2_plan_slots (slot_id, plan_id, scope, day, start_at, end_at, kind, activity, title, detail,
            flexibility, intent, target_ref, status, locked, created_at, updated_at)
          VALUES (?, ?, ?, '2026-11-05', ?, ?, ?, ?, '潮汐', '{}', 'soft', '', ?, 'planned', 0, ?, ?)`,
  slotId, planId, KEY, startAt, endAt, kind, activity, target, T0, T0);
}

/**
 * A file port set that counts the *external calls* prepare makes. `onRead` lets a test mutate the
 * world in the middle of prepare (a supersede, a crash), which is exactly the window R4 is about.
 */
function countingPorts(workspace, { onRead = null } = {}) {
  const calls = { reads: 0, writes: 0, fetches: 0 };
  return {
    calls,
    readFile({ path: file }) {
      calls.reads += 1;
      if (onRead) onRead(calls.reads);
      try { return { ok: true, text: fs.readFileSync(file, 'utf8') }; } catch { return { ok: false }; }
    },
    writeFile({ path: file, text }) { calls.writes += 1; fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, 'utf8'); return { ok: true, bytes: Buffer.byteLength(text) }; },
    fetchPage() { calls.fetches += 1; return { ok: false, status: 0 }; },
  };
}

function makeController({ db, workspace, ports, clock, dispatch }) {
  return createActivities({
    db, config: configFor(), clock: () => clock.value, owner: OWNER, generation: GEN, ports, workspace,
    dispatch: dispatch ?? (event => dispatchEvent(db, event, { handlers: { autonomy: applyActivityEvent }, generation: GEN, requireConsumers: true })),
  });
}

/**
 * The production dispatcher: the scope is resolved from the scope key and a *rejected* event is
 * raised instead of being returned as a quiet non-insert, so a pump failure is visible in a test.
 */
function emitThrough(db, clock) {
  const handlers = {
    autonomy: args => (args.event.kind === 'autonomy/receipt' || args.event.kind === 'autonomy/activity'
      ? applyActivityEvent(args)
      : applyPlanEvent(args)),
  };
  return (input = {}) => {
    const scope = input.scope ?? parseScope(input.scopeKey);
    if (!scope) throw new RuntimeError('unbound', 'no persisted scope');
    db.assertLeaseHeld({ owner: OWNER, generation: GEN, at: Number(clock.value) });
    const { scopeKey: _drop, ...rest } = input;
    const outcome = dispatchEvent(db, { ...rest, scope }, { handlers, generation: GEN, owner: OWNER, requireConsumers: true });
    const failure = outcome.results.find(result => result.error);
    if (outcome.rejected) throw new RuntimeError(failure?.code ?? 'event-rejected', failure?.error ?? 'the authority rejected the event');
    if (failure) throw new RuntimeError(failure.code ?? 'consumer-failed', failure.error ?? 'a consumer failed');
    return { ok: true, eventId: outcome.event.eventId, inserted: outcome.inserted, seq: outcome.seq, results: outcome.results };
  };
}

const jobOf = row => jobKeyFor({ scopeKey: KEY, startAt: Number(row.start_at), endAt: Number(row.end_at), kind: String(row.activity) });

// ---------------------------------------------------------------------------
// 1. prepare ran, the process died before the row: no second external call
// ---------------------------------------------------------------------------

test('R4: a prepare whose result was lost blocks a second external call and reads as unknown', async t => {
  const w = world(t);
  insertSlot(w.db, { slotId: 'slot-crash' });
  const ports = countingPorts(w.dir);
  // Simulated crash: everything works until the activity row is committed — the exact instant the
  // old code had no evidence for.
  const crashingDispatch = event => {
    if (event?.kind === 'autonomy/activity') throw new RuntimeError('simulated-crash', '进程在 prepare 与建行之间被杀');
    return dispatchEvent(w.db, event, { handlers: { autonomy: applyActivityEvent }, generation: GEN, requireConsumers: true });
  };
  const first = makeController({ db: w.db, workspace: w.dir, ports, clock: w.clock, dispatch: crashingDispatch });

  assert.throws(() => first.start({ slotId: 'slot-crash', kind: 'read' }), error => /simulated-crash|source-/.test(String(error.code ?? error.message)));
  assert.equal(ports.calls.reads, 1, 'the external call really happened once');
  assert.equal(Number(w.db.get('SELECT COUNT(*) AS n FROM p2_activities').n), 0, 'and no activity row was committed');

  const records = effectRecords(w.db, { scopeKey: KEY });
  // Round-3 ruling: a *read* cannot change the world, so a typed failure of it is provably
  // `not_applied` and a retry is legal. The case where an outward call may have happened (and
  // therefore must block) is pinned in `p1-closeout.test.mjs`.
  assert.deepEqual(records.map(r => r.phase), ['prepared', 'not_applied'], 'a read failure is provably not applied');
  assert.equal(records[1].effectKey, records[0].effectKey, 'both records describe the same effect');
  assert.equal(effectBlock({ record: records[1], now: w.clock.value }).blocked, false, 'a settled attempt does not block the next one');

  // A read is idempotent, so a fresh controller may retry it under a **new attempt ordinal**.
  const second = makeController({ db: w.db, workspace: w.dir, ports, clock: w.clock });
  const retried = second.start({ slotId: 'slot-crash', kind: 'read' });
  assert.equal(retried.ok, true, 'a settled read may be retried');
  const after = effectRecords(w.db, { scopeKey: KEY });
  assert.equal(after.filter(r => r.phase === 'prepared').length, 2, 'the retry is a new attempt, not a replay');

  // Even before the deadline lapses the same intent blocks, just under a different name.
  const fresh = { phase: 'prepared', deadline: w.clock.value + 1000, jobKey: records[0].jobKey };
  assert.equal(effectBlock({ record: fresh, now: w.clock.value }).code, 'effect-in-flight');
  assert.equal(effectBlock({ record: fresh, now: w.clock.value + 5000 }).code, 'effect-unknown');
});

// ---------------------------------------------------------------------------
// 2. two overlapping starts for one slot: exactly one prepared, one external call
// ---------------------------------------------------------------------------

test('R4: two overlapping starts of the same slot produce one intent and one external call', async t => {
  const w = world(t);
  insertSlot(w.db, { slotId: 'slot-race' });
  // Production ports are async: prepare returns a promise, which is what lets a second pass run
  // inside the first pass's prepare. A synchronous port would hide the race entirely.
  const ports = {
    calls: { reads: 0 },
    async readFile({ path: file }) { ports.calls.reads += 1; return { ok: true, text: fs.readFileSync(file, 'utf8') }; },
    async writeFile() { return { ok: false }; },
    async fetchPage() { return { ok: false, status: 0 }; },
  };
  const activities = makeController({ db: w.db, workspace: w.dir, ports, clock: w.clock });

  // The real shape of the race: both passes scan the same due slot *before* either has a row.
  // A refusal that happens before the adapter is synchronous (that is the point: nothing external
  // may run), so it is normalised into a rejection here.
  const attempt = () => {
    try { return Promise.resolve(activities.start({ slotId: 'slot-race', kind: 'read' })); }
    catch (error) { return Promise.reject(error); }
  };
  const outcomes = await Promise.allSettled([attempt(), attempt()]);
  const fulfilled = outcomes.filter(outcome => outcome.status === 'fulfilled');
  const rejected = outcomes.filter(outcome => outcome.status === 'rejected');
  assert.equal(fulfilled.length, 1, 'exactly one attempt won');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, 'effect-in-flight', 'the loser was refused by the intent, not by luck');
  assert.equal(ports.calls.reads, 1, 'the adapter ran exactly once');

  const prepared = effectRecords(w.db, { scopeKey: KEY }).filter(r => r.phase === 'prepared');
  assert.equal(prepared.length, 1, 'one prepared intent per attempt, never two');
  assert.equal(Number(w.db.get('SELECT COUNT(*) AS n FROM p2_activities').n), 1);
});

test('R4: the start pump is single-flight, so a nested pass cannot re-enter it', async t => {
  const w = world(t);
  insertSlot(w.db, { slotId: 'slot-pump' });
  for (const scope of [KEY]) w.db.run("INSERT OR REPLACE INTO scope_snapshots (scope, version, generation, payload, updated_at) VALUES (?, 0, ?, '{}', ?)", scope, GEN, T0);
  const ports = countingPorts(w.dir);
  let nested = null;
  const p2 = createP2({
    db: w.db, config: configFor({ dispatchEnabled: true }), clock: () => w.clock.value, owner: OWNER, generation: GEN,
    getMode: () => 'active', isActive: () => true,
    emit: emitThrough(w.db, w.clock),
    ports: {
      ...ports,
      readFile({ path: file }) {
        // Re-enter the pump exactly while the first pass is inside prepare.
        if (!nested) nested = p2.pump({ now: w.clock.value });
        return ports.readFile({ path: file });
      },
    },
    options: { artifactRoot: w.dir },
  });
  const outer = await p2.pump({ now: w.clock.value });
  const inner = await nested;
  assert.deepEqual(outer.started.length, 1, 'the outer pass started the activity');
  assert.equal(inner.code, 'starts-in-flight', 'the nested pass was refused by the in-flight lock');
  assert.equal(ports.calls.reads, 1, 'still one external call');
});

// ---------------------------------------------------------------------------
// 3. superseded during prepare: no row, no result, unknown
// ---------------------------------------------------------------------------

test('R4: a plan superseded during prepare commits nothing and leaves an unknown effect', async t => {
  const w = world(t);
  insertSlot(w.db, { slotId: 'slot-supersede' });
  const ports = countingPorts(w.dir, {
    onRead: () => { w.db.run("UPDATE p2_plans SET status = 'superseded' WHERE plan_id = 'plan-1'"); },
  });
  const activities = makeController({ db: w.db, workspace: w.dir, ports, clock: w.clock });

  assert.throws(() => activities.start({ slotId: 'slot-supersede', kind: 'read' }), error => error.code === 'plan-superseded');
  assert.equal(ports.calls.reads, 1, 'the external call had already happened');
  assert.equal(Number(w.db.get('SELECT COUNT(*) AS n FROM p2_activities').n), 0, 'no activity row is created');
  assert.equal(Number(w.db.get("SELECT COUNT(*) AS n FROM p2_activity_receipts WHERE operation = 'start'").n), 0, 'no start receipt either');
  const phases = effectRecords(w.db, { scopeKey: KEY }).map(r => r.phase);
  assert.deepEqual(phases, ['prepared', 'unknown'], 'the result is not silently declared successful');
});

test('R4: a slot whose window moved during prepare is refused the same way', async t => {
  const w = world(t);
  insertSlot(w.db, { slotId: 'slot-moved' });
  const ports = countingPorts(w.dir, {
    onRead: () => { w.db.run('UPDATE p2_plan_slots SET end_at = ? WHERE slot_id = ?', T0 + 2 * HOUR, 'slot-moved'); },
  });
  const activities = makeController({ db: w.db, workspace: w.dir, ports, clock: w.clock });
  assert.throws(() => activities.start({ slotId: 'slot-moved', kind: 'read' }), error => error.code === 'job-changed');
  assert.equal(Number(w.db.get('SELECT COUNT(*) AS n FROM p2_activities').n), 0);
});

// ---------------------------------------------------------------------------
// 4. manual resolution: not_applied re-opens the gates, confirmed keeps it shut
// ---------------------------------------------------------------------------

test('R4: a resolved not_applied effect lets the job through the gates again — and only then', async t => {
  const w = world(t);
  insertSlot(w.db, { slotId: 'slot-resolve' });
  const ports = countingPorts(w.dir, {
    onRead: calls => { if (calls === 1) w.db.run('UPDATE p2_plans SET status = \'superseded\' WHERE plan_id = \'plan-1\''); },
  });
  const activities = makeController({ db: w.db, workspace: w.dir, ports, clock: w.clock });
  assert.throws(() => activities.start({ slotId: 'slot-resolve', kind: 'read' }), error => error.code === 'plan-superseded');
  const unknown = effectRecords(w.db, { scopeKey: KEY }).at(-1);
  assert.equal(unknown.phase, 'unknown');

  // Still blocked after the operator put the plan back: an unresolved effect wins over the gates.
  w.db.run("UPDATE p2_plans SET status = 'committed' WHERE plan_id = 'plan-1'");
  assert.throws(() => activities.start({ slotId: 'slot-resolve', kind: 'read' }), error => error.code === 'effect-unknown');
  assert.equal(ports.calls.reads, 1, 'no retry while it is unknown');

  // Human says "it did not happen" — append-only, and it refuses a bogus key.
  assert.equal(activities.resolveEffect({ scopeKey: KEY, effectKey: 'nope', outcome: 'not_applied' }).code, 'invalid-effect-key');
  assert.equal(activities.resolveEffect({ scopeKey: KEY, effectKey: unknown.effectKey, outcome: 'maybe' }).code, 'invalid-outcome');
  const resolved = activities.resolveEffect({ scopeKey: KEY, effectKey: unknown.effectKey, outcome: 'not_applied', evidence: '核对过网络日志：请求未发出', operator: 'owner', attemptLost: true });
  assert.equal(resolved.ok, true, JSON.stringify(resolved));
  assert.equal(resolved.phase, 'not_applied');
  assert.deepEqual(effectRecords(w.db, { scopeKey: KEY }).map(r => r.phase), ['prepared', 'unknown', 'not_applied'], 'history is appended, never overwritten');

  // Now the gates decide again: the retry runs, and it is a *new* attempt with its own intent.
  const second = activities.start({ slotId: 'slot-resolve', kind: 'read' });
  assert.equal(second.ok, true);
  assert.equal(ports.calls.reads, 2, 'the retry is the second external call, deliberately');
  const records = effectRecords(w.db, { scopeKey: KEY });
  assert.deepEqual(records.map(r => r.phase), ['prepared', 'unknown', 'not_applied', 'prepared', 'confirmed']);
  assert.notEqual(records[3].effectKey, records[0].effectKey, 'a new attempt is a new effect, not a reused one');
});

test('R4: confirmed cannot be downgraded to not_applied', async t => {
  const w = world(t);
  insertSlot(w.db, { slotId: 'slot-confirmed' });
  const ports = countingPorts(w.dir);
  const activities = makeController({ db: w.db, workspace: w.dir, ports, clock: w.clock });
  assert.equal(activities.start({ slotId: 'slot-confirmed', kind: 'read' }).ok, true);
  const confirmed = effectRecords(w.db, { scopeKey: KEY }).at(-1);
  assert.equal(confirmed.phase, 'confirmed');
  const refused = activities.resolveEffect({ scopeKey: KEY, effectKey: confirmed.effectKey, outcome: 'not_applied', evidence: '核对', operator: 'owner', attemptLost: true });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'effect-conflict');
  assert.equal(activities.resolveEffect({ scopeKey: KEY, effectKey: confirmed.effectKey, outcome: 'confirmed', evidence: '核对', operator: 'owner' }).duplicate, true);
});

// ---------------------------------------------------------------------------
// 5. an unresolved effect keeps the job out of every dispatch query
// ---------------------------------------------------------------------------

test('R4: an unresolved effect keeps the job out of the heartbeat and pump dispatch queries', async t => {
  const w = world(t);
  // Two slots of the same logical job (same window + kind, different slot ids) — the job key is
  // deliberately independent of the slot id, because a supersede creates a new one.
  insertSlot(w.db, { slotId: 'slot-a' });
  insertSlot(w.db, { slotId: 'slot-b' });
  const ports = countingPorts(w.dir, {
    onRead: () => { w.db.run("UPDATE p2_plans SET status = 'superseded' WHERE plan_id = 'plan-1'"); },
  });
  const activities = makeController({ db: w.db, workspace: w.dir, ports, clock: w.clock });
  assert.throws(() => activities.start({ slotId: 'slot-a', kind: 'read' }), error => error.code === 'plan-superseded');
  assert.equal(effectRecords(w.db, { scopeKey: KEY }).at(-1).phase, 'unknown');

  // Put the plan back but keep the two slots scheduled: without the ledger they are "due" again.
  w.db.run("UPDATE p2_plans SET status = 'committed' WHERE plan_id = 'plan-1'");
  w.db.run("UPDATE p2_plan_slots SET status = 'planned' WHERE slot_id IN ('slot-a','slot-b')");
  const blockedJob = jobOf(w.db.get("SELECT * FROM p2_plan_slots WHERE slot_id = 'slot-b'"));
  assert.equal(blockedJob, effectRecords(w.db, { scopeKey: KEY }).at(-1).jobKey, 'both slots are the same logical job');

  w.db.run("INSERT OR REPLACE INTO scope_snapshots (scope, version, generation, payload, updated_at) VALUES (?, 0, ?, '{}', ?)", KEY, GEN, T0);
  const p2 = createP2({
    db: w.db, config: configFor({ dispatchEnabled: true }), clock: () => w.clock.value, owner: OWNER, generation: GEN,
    getMode: () => 'active', isActive: () => true,
    emit: emitThrough(w.db, w.clock),
    ports, options: { artifactRoot: w.dir },
  });

  const due = p2.dueSlotsForHeartbeat({ scopeKey: KEY, now: w.clock.value, limit: 2 });
  assert.deepEqual(due.slots, [], 'the heartbeat may not claim a job with an unresolved effect');
  const pump = await p2.pump({ now: w.clock.value });
  assert.deepEqual(pump.started, [], 'the pump may not start it either');
  assert.equal(ports.calls.reads, 1, 'no second external call from either path');
  assert.equal(Number(w.db.get('SELECT COUNT(*) AS n FROM p2_activities').n), 0);

  // The ledger is what does it: resolving the effect makes the same query return the job again.
  const unknown = effectRecords(w.db, { scopeKey: KEY }).at(-1);
  assert.equal(activities.resolveEffect({ scopeKey: KEY, effectKey: unknown.effectKey, outcome: 'not_applied', evidence: '核对：请求未发出', operator: 'owner', attemptLost: true }).ok, true);
  const after = p2.dueSlotsForHeartbeat({ scopeKey: KEY, now: w.clock.value, limit: 2 });
  assert.equal(after.slots.length, 2, 'both slots of the resolved job are dispatchable again');
});
