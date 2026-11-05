import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mountRuntime } from '../index.mjs';
import { openRuntimeDb } from '../lib/db.mjs';
import { p2Observability } from '../lib/observability.mjs';

// P2.5 dispatch observability + dry watch (CONTRACT §15).
//
// The claim → execute → receipt chain already has its own acceptance file
// (`p2.5-read-operation.test.mjs`). What was missing — and what this file pins — is the answer to
// "would the next beat dispatch anything, and if not, why?" **before** the gray switch is turned on,
// plus the measured fields an operator needs once it is:
//
//   * `slots_due` / `slots_claimable` / `slots_effect_blocked` / `slots_open`
//   * `dispatch_lag_ms` (pending lag), `claim_age_ms` (waiting for the pump), `claim_age_source`
//   * `activities_pending` / `activities_running` / `effects_unknown` / `effects_prepared`
//   * `heartbeatStatus().activityDispatchLastCycle` (what the last beat decided)
//   * `runtime.p2DispatchWatch()` — the zero-write dry watch
//
// Two properties matter more than the field list:
//
//   1. **No lying.** "We could not look" is `null` + `available:false`, never `0`; "nothing is due"
//      is a real `0`; a claim written before its wall clock was recorded reports `not-recorded`
//      rather than a confident wrong age (the old `claim_age_ms` measured the wrong thing entirely).
//   2. **No writing.** The dry watch is called *because* nothing is running yet, so an observation
//      that mutates the database would corrupt the very state it is meant to observe.
//
// Everything runs on a throwaway root + throwaway SQLite file. No network, no QQ, no share, no
// host profile, and no production database.
//
// Reproduce:
//   cd plugins/companion-runtime && node --test test/p2.5-dispatch-observability.test.mjs

const T0 = Date.UTC(2026, 10, 2, 4, 0, 0); // 2026-11-02 12:00 Asia/Shanghai
const HOUR = 3600000;
const MINUTE = 60000;
const TTL = 30 * 24 * HOUR;

// ---------------------------------------------------------------------------
// fixtures (same shape as the acceptance file; kept local so the two can diverge safely)
// ---------------------------------------------------------------------------

function makeRoot(t, { activities = {}, heartbeat = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p25-obs-'));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });
  fs.mkdirSync(path.join(root, 'home/companion/works/shelf'), { recursive: true });
  fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'home/companion/works/shelf/note.md'), '# 观测\n\n一段用来读的文字。', 'utf8');
  fs.writeFileSync(path.join(root, 'home/companion/identity.json'), JSON.stringify({
    schemaVersion: 1,
    persona: 'march7',
    owner: { id: 'owner-synthetic', displayName: 'o', platform: 'qq' },
    desktop: { mode: 'local-owner', userId: 'owner-synthetic' },
    sessions: {},
  }));
  fs.writeFileSync(path.join(root, 'home/companion/memory.config.json'), JSON.stringify({
    schemaVersion: 1, backend: 'sqlite',
    injection: { budgetChars: 2400 },
    extraction: { enabled: false },
    embedding: { provider: 'local', dimensions: 128 },
    wiki: { enabled: false },
  }));
  fs.writeFileSync(path.join(root, 'home/companion/runtime.config.json'), JSON.stringify({
    enabled: true,
    mode: 'active',
    leaseTtlMs: TTL,
    agenda: { enabled: true },
    heartbeat: { enabled: true, pollIntervalMs: 600000, jitterMs: 0, maxDispatchPerCycle: 1, maxAttempts: 3, ...heartbeat },
    p2: {
      planning: { enabled: false },
      activities: {
        enabled: true,
        paused: false,
        chunkUnits: 4000,
        maxUnitsPerStep: 8000,
        maxSourceBytes: 200000,
        maxTotalUnits: 200000,
        maxExcerptChars: 1200,
        ...activities,
      },
      budget: { maxRequestsPerDay: 64, maxInputTokensPerDay: 160000, maxOutputTokensPerDay: 24000, maxConcurrent: 1, chatPriority: true },
      autonomy: { allowedSources: [] },
      share: { enabled: false },
    },
    bridge: { enabled: false },
  }, null, 2));
  return root;
}

function mount(t, root, { clock, callModel } = {}) {
  const ctx = { tools: { register() {} }, systemPrompt: { section() {} }, on() {}, get() { return undefined; } };
  const identity = { resolve: sessionId => ({ userId: 'owner-synthetic', personaId: 'march7', sessionId }) };
  const runtime = mountRuntime(ctx, root, {
    now: () => clock.value,
    identity,
    callModel: callModel ?? (() => ({ text: '读完一段。', provider: 'stub-provider', model: 'stub-reader', inputTokens: 80, outputTokens: 12 })),
    p2Ports: {
      readFile: input => {
        try { return { ok: true, text: fs.readFileSync(input.path, 'utf8') }; } catch { return { ok: false }; }
      },
    },
  });
  t.after(() => { try { runtime.dispose(); } catch { /* already disposed */ } });
  return runtime;
}

function sideDb(t, root) {
  const db = openRuntimeDb({ file: path.join(root, 'home/companion/companion-runtime.db'), now: () => Date.now() });
  t.after(() => { try { db.close(); } catch { /* already closed */ } });
  return db;
}

/** Persist one scope through the public event path (the only way a scope may exist). */
function persistScope(runtime) {
  const proposed = runtime.recordEvent({ sessionId: 'synthetic-session', kind: 'goal/proposed', payload: { title: '读一页书' } });
  assert.equal(proposed.ok, true, JSON.stringify(proposed));
  return 'synthetic-session';
}

function scopeKeyOfDb(db) {
  const row = db.get('SELECT scope FROM scope_snapshots ORDER BY scope LIMIT 1');
  assert.ok(row?.scope, 'a persisted scope exists');
  return row.scope;
}

function seedSlot(db, {
  slotId = 'slot-1', planId = 'plan-1', day = '2026-11-02',
  startAt = T0 - HOUR, endAt = T0 + HOUR, activity = 'read', targetRef = 'shelf/note.md',
  status = 'planned', reality = 'actual_tool_activity',
} = {}) {
  const scope = scopeKeyOfDb(db);
  db.run(`INSERT OR IGNORE INTO p2_plans (plan_id, scope, day, version, status, time_zone, window_start, window_end, summary, source_run_id, supersedes, created_at, committed_at)
          VALUES (?, ?, ?, 1, 'committed', 'Asia/Shanghai', ?, ?, '', '', '', ?, ?)`,
  planId, scope, day, startAt - 2 * HOUR, endAt + 2 * HOUR, startAt, startAt);
  db.run(`INSERT INTO p2_plan_slots (slot_id, plan_id, scope, day, start_at, end_at, kind, activity, title, detail,
            flexibility, reality, intent, target_ref, status, locked, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'activity', ?, '观测用槽', '', 'soft', ?, '', ?, ?, 0, ?, ?)`,
  slotId, planId, scope, day, startAt, endAt, activity, reality, targetRef, status, startAt, startAt);
  return { scope, planId, slotId };
}

const count = (db, sql, ...params) => Number(db.get(sql, ...params)?.n ?? 0);
const planSlotPayloads = db => db.all("SELECT payload FROM domain_events WHERE kind = 'autonomy/plan-slot' ORDER BY seq").map(row => JSON.parse(row.payload));
const claims = db => planSlotPayloads(db).filter(payload => payload.to === 'started');

/**
 * A full fingerprint of every table the dispatch loop can touch, cursor churn included.
 *
 * Counting rows alone is not enough: `heartbeat_cursor` is *updated* in place, so "no new rows"
 * would still hide a beaten-on cursor. The cursor rows (and their `updated_at` / `cycles`) are
 * therefore compared verbatim.
 */
function fingerprint(db) {
  const tables = [
    'domain_events', 'p2_plans', 'p2_plan_slots', 'p2_activities', 'p2_activity_receipts',
    'consumer_receipts', 'runtime_meta', 'memory_outbox', 'p2_budget_ledger', 'scope_snapshots',
    'p2_plan_runs', 'p2_share_candidates',
  ];
  const out = {};
  for (const name of tables) out[name] = count(db, `SELECT COUNT(*) AS n FROM ${name}`);
  out['domain_events.maxSeq'] = Number(db.get('SELECT COALESCE(MAX(seq), 0) AS n FROM domain_events')?.n ?? 0);
  out.heartbeat_cursor = db.all('SELECT scope, consumer, settled_until, event_seq, cycles, updated_at, page_anchor FROM heartbeat_cursor ORDER BY scope, consumer');
  out.slotStatuses = db.all('SELECT slot_id, status, updated_at FROM p2_plan_slots ORDER BY slot_id');
  return out;
}

// ---------------------------------------------------------------------------
// 1. the dry watch writes nothing — including no heartbeat-cursor churn
// ---------------------------------------------------------------------------

test('dry watch: five calls change nothing (rows, events, cursor churn)', async t => {
  const clock = { value: T0 };
  const root = makeRoot(t, { activities: { dispatchEnabled: true } });
  const runtime = mount(t, root, { clock });
  const sessionId = persistScope(runtime);
  const db = sideDb(t, root);
  seedSlot(db);
  seedSlot(db, { slotId: 'slot-future', startAt: T0 + 3 * HOUR, endAt: T0 + 4 * HOUR });

  // One real beat first: without it there is no `heartbeat_cursor` row, and "the cursor did not
  // churn" would be a vacuous claim.
  const beat = runtime.runHeartbeatCycle({ reason: 'test' });
  assert.equal(beat.ok, true, JSON.stringify(beat));
  assert.equal(beat.dispatched, 1, JSON.stringify(beat));
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM heartbeat_cursor'), 1, 'the beat committed a cursor row');

  const before = fingerprint(db);
  for (let index = 0; index < 5; index += 1) {
    const watched = runtime.p2DispatchWatch({ sessionId, now: T0 + 5 * MINUTE });
    assert.equal(watched.ok, true, JSON.stringify(watched));
    assert.equal(watched.readOnly, true, 'the watch announces that it is a read-only projection');
    // Not a stub: it actually saw the claim the beat just made.
    assert.equal(watched.counts.awaitingStart, 1, JSON.stringify(watched.rows));
    assert.ok(watched.rows.some(row => row.slotId === 'slot-1' && row.state === 'awaiting-start'), JSON.stringify(watched.rows));
  }
  const after = fingerprint(db);
  assert.deepEqual(after, before, 'a dry watch must not write a single row (heartbeat_cursor included)');
  assert.equal(claims(db).length, 1, 'and it did not claim anything either');
  assert.equal(db.get("SELECT status FROM p2_plan_slots WHERE slot_id = 'slot-1'").status, 'started');
});

// ---------------------------------------------------------------------------
// 2. the watch names the reason instead of answering with silence
// ---------------------------------------------------------------------------

test('dry watch: with the shipped default (dispatchEnabled absent) the slots are listed but named as refused', async t => {
  const clock = { value: T0 };
  const root = makeRoot(t); // dispatchEnabled absent = off, exactly like production today
  const runtime = mount(t, root, { clock });
  const sessionId = persistScope(runtime);
  const db = sideDb(t, root);
  seedSlot(db);

  const watched = runtime.p2DispatchWatch({ sessionId, now: T0 });
  assert.equal(watched.ok, true, JSON.stringify(watched));
  // Nothing has failed and nothing has been tried: `null`, not an empty string or a 0.
  assert.equal(watched.lastError, null);
  // The slot level still reports what *would* happen, which is the whole point of watching first…
  assert.equal(watched.counts.claimable, 1, JSON.stringify(watched.rows));
  assert.equal(watched.rows[0].state, 'claimable');
  assert.equal(watched.rows[0].expectedBeat, 1);
  // …and the beat level says, by name, that no beat will run.
  assert.ok(watched.blockedBy.includes('dispatch-disabled'), JSON.stringify(watched.blockedBy));
  assert.equal(watched.claimableNow, false, 'a slot being due does not mean it will be claimed');
  assert.equal(watched.p2.dispatchEnabled, false);
  assert.equal(watched.metrics.dispatch_enabled, false);
  assert.equal(watched.metrics.slots_due, 1, 'the durable measurement is still honest about what is due');
  assert.equal(watched.metrics.slots_claimable, 1);

  // The reason is not invented by the watch: the beat itself persists the same name.
  runtime.runHeartbeatCycle({ reason: 'test' });
  const last = runtime.heartbeatStatus().activityDispatchLastCycle;
  assert.ok(last, 'a beat ran, so there is a decision record');
  assert.equal(last.skipped, 'no-hook', 'with the switch off the host injects no hook at all');
  assert.equal(last.wired, false);
  assert.equal(last.claimed, 0);
  assert.equal(claims(db).length, 0, 'and nothing was claimed');
});

test('dry watch: chat priority and a paused switch are named deferrals, not failures', async t => {
  const clock = { value: T0 };
  const root = makeRoot(t, { activities: { dispatchEnabled: true } });
  let foreground = false;
  const ctx = { tools: { register() {} }, systemPrompt: { section() {} }, on() {}, get() { return undefined; } };
  const identity = { resolve: sessionId => ({ userId: 'owner-synthetic', personaId: 'march7', sessionId }) };
  const runtime = mountRuntime(ctx, root, {
    now: () => clock.value,
    identity,
    isForegroundBusy: () => foreground,
    callModel: () => ({ text: 'x', provider: 'p', model: 'm', inputTokens: 1, outputTokens: 1 }),
  });
  t.after(() => { try { runtime.dispose(); } catch { /* disposed */ } });
  const sessionId = persistScope(runtime);
  const db = sideDb(t, root);
  seedSlot(db);

  // (a) the user is talking: the slot stays due, the beat defers by name.
  foreground = true;
  const busy = runtime.p2DispatchWatch({ sessionId, now: T0 });
  assert.ok(busy.blockedBy.includes('chat-priority'), JSON.stringify(busy.blockedBy));
  assert.equal(busy.claimableNow, false);
  const deferred = runtime.runHeartbeatCycle({ reason: 'test' });
  assert.equal(deferred.ok, true, JSON.stringify(deferred));
  assert.equal(deferred.dispatched, 0, 'a foreground turn always wins');
  const record = runtime.heartbeatStatus().activityDispatchLastCycle;
  assert.equal(record.deferred, 'chat-priority');
  assert.match(String(record.code), /dispatch-deferred:chat-priority/);
  // ...and the composed watch surfaces that same reason as `lastError`, with who said it.
  const afterDefer = runtime.p2DispatchWatch({ sessionId, now: T0 });
  assert.equal(afterDefer.lastError?.from, 'heartbeat');
  assert.match(String(afterDefer.lastError?.code), /dispatch-deferred:chat-priority/);
  assert.equal(claims(db).length, 0);

  // (b) the operator paused activities: same shape, different name.
  foreground = false;
  const paused = runtime.pauseActivities({ sessionId, reason: 'observability-test' });
  assert.equal(paused.ok, true, JSON.stringify(paused));
  const afterPause = runtime.p2DispatchWatch({ sessionId, now: T0 });
  assert.ok(afterPause.blockedBy.includes('activities-paused'), JSON.stringify(afterPause.blockedBy));
  assert.equal(afterPause.metrics.paused, true);

  // (c) resumed: the watch says claimable *and* claimableNow — and the beat agrees.
  runtime.resumeActivities();
  const open = runtime.p2DispatchWatch({ sessionId, now: T0 });
  assert.deepEqual(open.blockedBy, [], JSON.stringify(open.blockedBy));
  assert.equal(open.claimableNow, true);
  const claimed = runtime.runHeartbeatCycle({ reason: 'test' });
  assert.equal(claimed.dispatched, 1, JSON.stringify(claimed));
  assert.equal(claims(db).length, 1);
});

test('dry watch: a slot whose job has an unresolved effect is blocked by name', async t => {
  const clock = { value: T0 };
  const root = makeRoot(t, { activities: { dispatchEnabled: true } });
  const runtime = mount(t, root, { clock });
  const sessionId = persistScope(runtime);
  const db = sideDb(t, root);
  const seeded = seedSlot(db);

  // An unresolved `unknown` effect for exactly this job: the ledger says "it may have happened".
  const { jobKeyFor } = await import('../lib/activities.mjs');
  const jobKey = jobKeyFor({ scopeKey: seeded.scope, startAt: T0 - HOUR, endAt: T0 + HOUR, kind: 'read' });
  db.run(`INSERT INTO p2_activity_receipts (receipt_id, activity_id, scope, operation, ok, code, detail, at)
          VALUES ('r-unknown', '', ?, 'review', 0, 'lc-effect', ?, ?)`,
  seeded.scope, JSON.stringify({ jobKey, effectKey: 'a'.repeat(64), phase: 'unknown' }), T0 - 1000);

  const watched = runtime.p2DispatchWatch({ sessionId, now: T0 });
  assert.equal(watched.counts.claimable, 0, JSON.stringify(watched.rows));
  assert.equal(watched.counts.effectBlocked, 1);
  const row = watched.rows.find(entry => entry.slotId === 'slot-1');
  assert.equal(row.state, 'blocked-effect');
  assert.equal(row.blockReason, 'effect-unknown');
  assert.equal(watched.claimableNow, false);
  assert.equal(watched.metrics.effects_unknown, 1);
  assert.equal(watched.metrics.slots_effect_blocked, 1);
  assert.equal(watched.metrics.slots_due, 1, 'it is still due; it is blocked from being dispatched');

  // The real beat refuses it for the same reason: the watch did not invent a rule.
  const beat = runtime.runHeartbeatCycle({ reason: 'test' });
  assert.equal(beat.dispatched, 0, JSON.stringify(beat));
  assert.equal(claims(db).length, 0);
});

// ---------------------------------------------------------------------------
// 3. claim_age_ms is measured from the claim, survives a restart, and refuses to guess
// ---------------------------------------------------------------------------

test('claim_age_ms: measured after a claim, still correct after a restart, null for a legacy claim', async t => {
  const clock = { value: T0 };
  const root = makeRoot(t, { activities: { dispatchEnabled: true } });
  const runtimeA = mount(t, root, { clock });
  const sessionId = persistScope(runtimeA);
  const dbA = sideDb(t, root);
  seedSlot(dbA);

  // Before any claim: nothing is waiting, so the age is `null` with a named source — not 0.
  const idle = runtimeA.p2DispatchWatch({ sessionId, now: T0 });
  assert.equal(idle.metrics.claim_age_ms, null);
  assert.equal(idle.metrics.claim_age_source, 'none');

  const beat = runtimeA.runHeartbeatCycle({ reason: 'test' });
  assert.equal(beat.dispatched, 1, JSON.stringify(beat));
  const claimedAt = dbA.get("SELECT recorded_at, occurred_at FROM domain_events WHERE kind = 'autonomy/plan-slot' ORDER BY seq DESC LIMIT 1");
  assert.ok(Number(claimedAt.recorded_at) > Number(claimedAt.occurred_at),
    'the claim stores the wall clock it was written at, separate from the slot start it is about');

  // Same process, ten minutes later: the claim has been waiting for the pump for ten minutes.
  const tenMinutes = runtimeA.p2DispatchWatch({ sessionId, now: T0 + 10 * MINUTE });
  assert.equal(tenMinutes.metrics.claim_age_source, 'recorded_at');
  assert.equal(tenMinutes.metrics.claim_age_ms, 10 * MINUTE, 'now - the claim wall clock');
  assert.equal(tenMinutes.counts.awaitingStart, 1);
  assert.equal(tenMinutes.rows.find(row => row.slotId === 'slot-1').claimAgeMs, 10 * MINUTE);
  // Process-local knowledge is not claimed: the last *claim attempt* lives in this process only.
  assert.equal(tenMinutes.metrics.lastClaim.ok, true);

  // A restarted host still knows the age (it is durable), but not the in-memory attempt record.
  runtimeA.dispose();
  const runtimeB = mount(t, root, { clock: { value: T0 + 10 * MINUTE } });
  const afterRestart = runtimeB.p2DispatchWatch({ sessionId, now: T0 + 10 * MINUTE });
  assert.equal(afterRestart.metrics.claim_age_ms, 10 * MINUTE, 'the claim clock is durable, not in-memory');
  assert.equal(afterRestart.metrics.claim_age_source, 'recorded_at');
  assert.equal(afterRestart.metrics.lastClaim.ok, null, 'a fresh process has attempted nothing; it does not inherit a success');

  // A claim written by a build that did not record its wall clock can never be turned into a
  // confident age: the two timestamps are the same value, so the honest answer is `not-recorded`.
  const dbB = sideDb(t, root);
  dbB.run("UPDATE domain_events SET recorded_at = occurred_at WHERE kind = 'autonomy/plan-slot'");
  const legacy = runtimeB.p2DispatchWatch({ sessionId, now: T0 + 10 * MINUTE });
  assert.equal(legacy.metrics.claim_age_ms, null, 'never invent an age for a claim that has no wall clock');
  assert.equal(legacy.metrics.claim_age_source, 'not-recorded');
  assert.equal(legacy.counts.awaitingStart, 1, 'the claim is still real and still visible');
});

// ---------------------------------------------------------------------------
// 4. two beats, one claim — and the watch reports the same thing the database does
// ---------------------------------------------------------------------------

test('two beats claim once; the watch mirrors the log instead of guessing', async t => {
  const clock = { value: T0 };
  const root = makeRoot(t, { activities: { dispatchEnabled: true } });
  const runtime = mount(t, root, { clock });
  const sessionId = persistScope(runtime);
  const db = sideDb(t, root);
  seedSlot(db);

  const first = runtime.runHeartbeatCycle({ reason: 'timer' });
  assert.equal(first.dispatched, 1, JSON.stringify(first));
  const second = runtime.runHeartbeatCycle({ reason: 'timer' });
  assert.equal(second.dispatched ?? 0, 0, 'the claimed slot is not claimed twice');
  const third = runtime.runHeartbeatCycle({ reason: 'timer' });
  assert.equal(third.dispatched ?? 0, 0);
  assert.equal(claims(db).length, 1, 'exactly one planned→started event across three beats');

  const last = runtime.heartbeatStatus().activityDispatchLastCycle;
  assert.equal(last.claimed, 0, 'the later beats claimed nothing');
  assert.equal(last.wired, true);
  assert.equal(last.skipped, null);

  const watched = runtime.p2DispatchWatch({ sessionId, now: T0 });
  assert.equal(watched.counts.claimable, 0);
  assert.equal(watched.counts.awaitingStart, 1);
  assert.equal(watched.metrics.slots_due, 0, 'a claimed slot is no longer due for claiming');
  assert.equal(watched.metrics.slots_open, 1, 'but it is still open — the two numbers differ on purpose');
  assert.equal(watched.metrics.dispatch_lag_ms, null, 'nothing is due, so there is no pending lag (0 would be a lie)');
});

// ---------------------------------------------------------------------------
// 5. the metrics distinguish "measured zero" from "could not measure"
// ---------------------------------------------------------------------------

test('honesty: an empty scope measures 0; an unbound session measures nothing at all', async t => {
  const clock = { value: T0 };
  const root = makeRoot(t, { activities: { dispatchEnabled: true } });
  const runtime = mount(t, root, { clock });
  const sessionId = persistScope(runtime);

  // A scope with no plan: 0 due is a real measurement.
  const empty = runtime.p2Status({ sessionId });
  assert.equal(empty.activities.dispatch.available, true);
  assert.equal(empty.activities.dispatch.slots_due, 0);
  assert.equal(empty.activities.dispatch.slots_claimable, 0);
  assert.equal(empty.activities.dispatch.slots_open, 0);
  assert.equal(empty.activities.dispatch.dispatch_lag_ms, null, 'no due slot ⇒ no lag, and 0 would read as "on time"');
  assert.equal(empty.activities.dispatch.claim_age_source, 'none');

  // No scope at all: nothing was measured, so every number is `null` and `available` is false.
  const unbound = runtime.p2Status({});
  assert.equal(unbound.activities.dispatch.available, false, JSON.stringify(unbound.activities.dispatch));
  assert.equal(unbound.activities.dispatch.slots_due, null);
  assert.equal(unbound.activities.dispatch.code, 'no-scope');

  const watched = runtime.p2DispatchWatch({});
  assert.equal(watched.ok, true, 'the watch still answers, it just answers "nothing can be measured"');
  assert.equal(watched.metrics.available, false);
  assert.equal(watched.rows.length, 0);
  assert.ok(watched.blockedBy.length > 0, JSON.stringify(watched.blockedBy));
});

test('honesty: the eight-group projection reads the same slots_due as the P2 controller', async t => {
  const clock = { value: T0 };
  const root = makeRoot(t, { activities: { dispatchEnabled: true } });
  const runtime = mount(t, root, { clock });
  const sessionId = persistScope(runtime);
  const db = sideDb(t, root);
  seedSlot(db);                                                   // due now
  seedSlot(db, { slotId: 'slot-later', startAt: T0 + 3 * HOUR, endAt: T0 + 4 * HOUR }); // not due yet

  const scopeKey = scopeKeyOfDb(db);
  const controller = runtime.p2Status({ sessionId }).activities.dispatch;
  const projection = p2Observability(db, { scopeKey, now: T0, switches: { activities: true, planning: false } }).groups;
  assert.equal(projection.slots.metrics.slots_due.value, controller.slots_due, 'one definition, two views');
  assert.equal(projection.slots.metrics.slots_due.value, 1, 'only the slot whose window covers now counts as due');
  assert.equal(projection.slots.metrics.slots_open.value, 2, 'the all-time backlog is reported separately');
  assert.equal(projection.slots.metrics.slots_due.honest, 'measured');
  assert.equal(projection.latency.metrics.dispatch_lag_ms.value, HOUR, 'now − the due slot start');
  assert.equal(projection.latency.metrics.claim_age_ms.value, null);
  assert.equal(projection.latency.metrics.claim_age_ms.honest, 'not-wired', 'no claim is waiting: null, and it says why');

  // After a claim, the projection reports a real age (and stops calling itself not-wired).
  runtime.runHeartbeatCycle({ reason: 'test' });
  const later = p2Observability(db, { scopeKey, now: T0 + 2 * MINUTE, switches: { activities: true, planning: false } }).groups;
  assert.equal(later.latency.metrics.claim_age_ms.honest, 'measured');
  assert.equal(later.latency.metrics.claim_age_ms.value, 2 * MINUTE);
  assert.equal(later.slots.metrics.slots_due.value, 0);
  assert.equal(later.slots.metrics.slots_claimable.value, 0);
});

// ---------------------------------------------------------------------------
// 5b. an unreadable effect ledger is "unknown", not "nothing blocked"
// ---------------------------------------------------------------------------

test('honesty: when the effect ledger cannot be read, blocked counts are null — never 0', async t => {
  const clock = { value: T0 };
  const root = makeRoot(t, { activities: { dispatchEnabled: true } });
  const runtime = mount(t, root, { clock });
  const sessionId = persistScope(runtime);
  const db = sideDb(t, root);
  seedSlot(db);

  // Break only the ledger read: `effectIndex` scans p2_activity_receipts, so a hostile handle that
  // throws for that statement leaves every other query working.
  const hostile = {
    get: (...args) => db.get(...args),
    all: (sql, ...params) => {
      if (String(sql).includes('p2_activity_receipts')) throw new Error('ledger unreadable');
      return db.all(sql, ...params);
    },
  };
  const { dispatchMetrics: measure } = await import('../lib/dispatch-observability.mjs');
  const metrics = measure(hostile, { scopeKey: scopeKeyOfDb(db), now: T0 });
  assert.equal(metrics.available, true, 'the rest of the measurement still works');
  assert.equal(metrics.effectIndexAvailable, false);
  assert.equal(metrics.slots_due, 1, 'due-ness does not need the ledger, so it stays measured');
  assert.equal(metrics.slots_claimable, null, 'but "how many are claimable" is unknowable');
  assert.equal(metrics.slots_effect_blocked, null, 'and 0 blocked would be a dangerous lie');
  assert.equal(metrics.effects_unknown, null);
});

// ---------------------------------------------------------------------------
// 6. the switch stays "strictly true" — a string is not a switch
// ---------------------------------------------------------------------------

test('dispatchEnabled is compared with === true; a truthy string does not dispatch', async t => {
  const clock = { value: T0 };
  const root = makeRoot(t, { activities: { dispatchEnabled: 'true' } }); // a YAML/JSON mistake, not a switch
  const runtime = mount(t, root, { clock });
  const sessionId = persistScope(runtime);
  const db = sideDb(t, root);
  seedSlot(db);

  const watched = runtime.p2DispatchWatch({ sessionId, now: T0 });
  assert.equal(watched.p2.dispatchEnabled, false, 'the string "true" is not the boolean true');
  assert.ok(watched.blockedBy.includes('dispatch-disabled'), JSON.stringify(watched.blockedBy));
  assert.equal(watched.claimableNow, false);

  for (let index = 0; index < 2; index += 1) {
    const beat = runtime.runHeartbeatCycle({ reason: 'test' });
    assert.equal(beat.dispatched ?? 0, 0, JSON.stringify(beat));
  }
  assert.equal(claims(db).length, 0);
  assert.equal(db.get("SELECT status FROM p2_plan_slots WHERE slot_id = 'slot-1'").status, 'planned');
});

// ---------------------------------------------------------------------------
// 7. a closed window is shown as "will miss", not as "claimable"
// ---------------------------------------------------------------------------

test('dry watch: a closed window is reported as will-miss, never as claimable', async t => {
  const clock = { value: T0 };
  const root = makeRoot(t, { activities: { dispatchEnabled: true } });
  const runtime = mount(t, root, { clock });
  const sessionId = persistScope(runtime);
  const db = sideDb(t, root);
  seedSlot(db, { slotId: 'slot-gone', startAt: T0 - 5 * HOUR, endAt: T0 - 2 * HOUR });

  const watched = runtime.p2DispatchWatch({ sessionId, now: T0 });
  assert.equal(watched.counts.claimable, 0, 'a closed window cannot be claimed');
  assert.equal(watched.counts.willMiss, 1, JSON.stringify(watched.rows));
  const row = watched.rows.find(entry => entry.slotId === 'slot-gone');
  assert.equal(row.state, 'will-miss');
  assert.equal(row.blockReason, 'window-closed');
  assert.equal(row.expectedBeat, null);
  assert.equal(watched.metrics.slots_due, 0);
  assert.equal(watched.metrics.slots_open, 1);

  // The pump then really files it as missed — the watch and the loop agree.
  const beat = runtime.runHeartbeatCycle({ reason: 'test' });
  assert.equal(beat.dispatched ?? 0, 0);
  await runtime.pumpActivities({ now: T0 });
  assert.equal(db.get("SELECT status FROM p2_plan_slots WHERE slot_id = 'slot-gone'").status, 'expired');
  const after = runtime.p2DispatchWatch({ sessionId, now: T0 });
  assert.equal(after.counts.willMiss, 0);
  assert.equal(after.rows.length, 0);
});

// ---------------------------------------------------------------------------
// 8. the per-beat cap is part of the prediction, not hidden behind it
// ---------------------------------------------------------------------------

test('dry watch: with a per-beat cap of 1 the second due slot is predicted on beat 2', async t => {
  const clock = { value: T0 };
  const root = makeRoot(t, { activities: { dispatchEnabled: true }, heartbeat: { maxDispatchPerCycle: 1 } });
  const runtime = mount(t, root, { clock });
  const sessionId = persistScope(runtime);
  const db = sideDb(t, root);
  seedSlot(db, { slotId: 'slot-a', startAt: T0 - 2 * HOUR, endAt: T0 + HOUR });
  seedSlot(db, { slotId: 'slot-b', startAt: T0 - 1 * HOUR, endAt: T0 + HOUR });

  const watched = runtime.p2DispatchWatch({ sessionId, now: T0 });
  assert.equal(watched.counts.claimable, 2);
  assert.equal(watched.counts.beatsToDrain, 2, 'one claim per beat ⇒ two beats');
  const bySlot = new Map(watched.rows.map(row => [row.slotId, row]));
  assert.equal(bySlot.get('slot-a').expectedBeat, 1, 'the earlier slot goes first');
  assert.equal(bySlot.get('slot-b').expectedBeat, 2);
  assert.equal(watched.metrics.dispatch_lag_ms, 2 * HOUR, 'the pending lag is the *oldest* due slot');

  const beat = runtime.runHeartbeatCycle({ reason: 'test' });
  assert.equal(beat.dispatched, 1, 'the cap is enforced by the beat, exactly as predicted');
  assert.equal(claims(db).length, 1);
  const next = runtime.p2DispatchWatch({ sessionId, now: T0 });
  assert.equal(next.counts.claimable, 1);
  assert.equal(next.rows.find(row => row.slotId === 'slot-b').expectedBeat, 1, 'the remaining slot is now first in line');
});
