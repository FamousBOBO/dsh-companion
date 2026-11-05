import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openRuntimeDb } from '../lib/db.mjs';
import { dispatchEvent } from '../lib/events.mjs';
import { applyPlanEvent } from '../lib/planner.mjs';
import { applyActivityEvent } from '../lib/activities.mjs';
import { createP2 } from '../lib/p2.mjs';
import { createHeartbeat } from '../lib/heartbeat.mjs';
import { scopeKey as scopeKeyOf, parseScope } from '../lib/scope.mjs';
import { RuntimeError } from '../lib/errors.mjs';
import { mountRuntime } from '../index.mjs';

// P2.5-1 Slice A: the closed loop `committed plan slot → H2 claim → P2 pump → activity → P1 event`.
//
// What is under test (A1 §7.2 steps 1–4, zero schema migration):
//   * the heartbeat may *claim* a due slot inside its own scope transaction — one
//     `autonomy/plan-slot` `planned → started` append — and nothing else;
//   * with no `activityDispatch` hook injected the round is byte-for-byte the pre-slice round;
//   * foreground chat, a paused activity switch and the per-cycle dispatch cap all make it defer,
//     with a persisted reason instead of a silent skip;
//   * a claim that never became an activity is recoverable (pump start, or an honest `missed`);
//   * a superseded plan's slots are never dispatched;
//   * a finished activity produces exactly one P1 `memory/ingest-request` and one outbox row.
//
// Everything runs on a temporary SQLite file or `:memory:`; no production database, no network,
// no QQ, no model.

const T0 = Date.UTC(2026, 10, 1, 4, 0, 0); // 2026-11-01 12:00 Asia/Shanghai
const HOUR = 3600000;
const DAY = 24 * HOUR;
const SCOPE = Object.freeze({ userId: 'owner-1', personaId: 'bot', worldId: 'world:default' });
const KEY = scopeKeyOf(SCOPE);
const TTL = 30 * DAY;

function tempRoot(t, label = 'p2-dispatch') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });
  return dir;
}

function configWith(overrides = {}) {
  return {
    enabled: true,
    mode: 'active',
    timeZone: 'Asia/Shanghai',
    leaseTtlMs: TTL,
    agenda: { enabled: true, maxItemsPerScope: 64, generationHorizonHours: 72, maxGeneratePerCall: 64, querySpanDays: 14 },
    heartbeat: {
      enabled: true, pollIntervalMs: 60000, jitterMs: 0, maxScopesPerCycle: 8, maxDueItemsPerCycle: 64,
      maxNewOccurrencesPerCycle: 128, maxCatchupHorizonHours: 24, maxAttempts: 3, maxTimeBudgetMs: 2000,
      dueRetentionHours: 24, maxRetryBackoffMs: 1800000, maxDispatchPerCycle: 1, activityConsumer: '',
      ...(overrides.heartbeat ?? {}),
    },
    p2: {
      planning: { enabled: false, paused: false },
      // `dispatchEnabled` is the P2.5-1 gray switch: the heartbeat may only claim a slot when the
      // operator turned it on. Every wired case below therefore sets it explicitly.
      activities: { enabled: true, dispatchEnabled: true, paused: false, chunkUnits: 1200, maxUnitsPerStep: 4000, maxSourceBytes: 200000, maxTotalUnits: 200000, maxExcerptChars: 4000 },
      budget: { maxRequestsPerDay: 64, maxInputTokensPerDay: 160000, maxOutputTokensPerDay: 24000, recoveryReserveRatio: 0.2, maxConcurrent: 2, chatPriority: true, maxCostPerDay: 0 },
      autonomy: { allowedSources: [], scopeAcknowledgedAt: T0 },
      share: { enabled: false, maxPending: 5 },
      ...(overrides.p2 ?? {}),
    },
  };
}

/** The agenda API surface the heartbeat requires; empty, because this slice is about slots. */
function emptyAgenda() {
  return {
    activeAgendaItems: () => [],
    planWindow: () => [],
    dueAgendaOccurrences: () => [],
    existingSlotKeys: () => new Set(),
    agendaCounts: () => ({ items: 0, occurrences: {}, nextOccurrenceAt: null }),
  };
}

function seedPlan(db, { planId = 'plan-1', day = '2026-11-01', version = 1, status = 'committed' } = {}) {
  db.run(`INSERT INTO p2_plans (plan_id, scope, day, version, status, time_zone, window_start, window_end, summary, source_run_id, supersedes, created_at, committed_at)
          VALUES (?, ?, ?, ?, ?, 'Asia/Shanghai', ?, ?, '', '', '', ?, ?)`,
  planId, KEY, day, version, status, T0 - 6 * HOUR, T0 + 18 * HOUR, T0, T0);
}

function seedSlot(db, {
  slotId = 'slot-1', planId = 'plan-1', day = '2026-11-01', startAt = T0 - HOUR, endAt = T0 + HOUR,
  activity = 'read', targetRef = 'shelf/note.md', status = 'planned', detail = '{"reality":"actual_tool_activity"}',
} = {}) {
  db.run(`INSERT INTO p2_plan_slots (slot_id, plan_id, scope, day, start_at, end_at, kind, activity, title, detail,
            flexibility, intent, target_ref, status, locked, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'activity', ?, '海风', ?, 'soft', '', ?, ?, 0, ?, ?)`,
  slotId, planId, KEY, day, startAt, endAt, activity, detail, targetRef, status, T0, T0);
}

/**
 * A real P2 controller + a real heartbeat over one temporary database, wired exactly the way
 * `index.mjs` wires them (`emit` = the writer-gated dispatcher, `activityDispatch` = two closures
 * over the controller's hooks). The only stand-in is the agenda, which has nothing to do here.
 */
function makeWorld(t, { config = configWith(), foregroundBusy = () => false, file = null, hook = true } = {}) {
  const clock = { value: T0 };
  const dbFile = file ?? path.join(tempRoot(t), 'companion-runtime.db');
  const db = openRuntimeDb({ file: dbFile, now: () => clock.value });
  t.after(() => { try { db.close(); } catch { /* already closed */ } });
  const owner = '999999:p2-dispatch:test'; // a dead pid: a takeover after the simulated crash is justified
  const generation = 'gen-hb';
  assert.equal(db.acquireLease({ owner, generation, ttlMs: TTL }).ok, true, 'the test writer holds the lease');
  db.commitProjection({ scope: KEY, generation, payload: {}, updatedAt: T0 });

  const handlers = {
    autonomy: (args) => (args.event.kind === 'autonomy/receipt' || args.event.kind === 'autonomy/activity'
      ? applyActivityEvent(args)
      : applyPlanEvent(args)),
  };
  // Mirrors index.mjs `dispatchForAutonomy`: the writer gate runs first, and a *rejected* event is
  // raised as a typed error instead of being returned as a quiet non-insert. That distinction is
  // what lets `claimSlotForHeartbeat` report a contradiction (`invalid-transition`) honestly.
  const emit = (input = {}) => {
    const scope = input.scope ?? parseScope(input.scopeKey);
    if (!scope) throw new RuntimeError('unbound', 'no persisted scope');
    db.assertLeaseHeld({ owner, generation, at: Number(clock.value) });
    const { scopeKey: _drop, ...rest } = input;
    const outcome = dispatchEvent(db, { ...rest, scope }, { handlers, generation, owner, requireConsumers: true });
    const failure = outcome.results.find(result => result.error);
    if (outcome.rejected) throw new RuntimeError(failure?.code ?? 'event-rejected', failure?.error ?? 'the authority rejected the event');
    if (failure) throw new RuntimeError(failure.code ?? 'consumer-failed', failure.error ?? 'a consumer failed');
    return { ok: true, eventId: outcome.event.eventId, inserted: outcome.inserted, seq: outcome.seq, results: outcome.results };
  };
  const p2 = createP2({
    db, config, clock: () => clock.value, owner, generation,
    getMode: () => config.mode,
    isActive: () => config.mode === 'active',
    emit,
    options: { artifactRoot: path.join(path.dirname(dbFile), 'works'), isForegroundBusy: foregroundBusy },
  });
  const heartbeat = createHeartbeat({
    db, config, clock: () => clock.value, owner, generation,
    dispatch: emit,
    agenda: emptyAgenda(),
    // Mirrors index.mjs `heartbeatActivityDispatch` (lazy closures, fail-closed when unwired).
    activityDispatch: hook
      ? { dueSlots: input => p2.dueSlotsForHeartbeat(input), claim: input => p2.claimSlotForHeartbeat(input) }
      : null,
    isActive: () => config.mode === 'active',
    isWritable: () => true,
  });
  return { db, clock, owner, generation, p2, heartbeat, config, dbFile };
}

const planSlotEvents = db => db.all("SELECT payload FROM domain_events WHERE kind = 'autonomy/plan-slot' ORDER BY seq").map(row => JSON.parse(row.payload));
const claimedStarts = db => planSlotEvents(db).filter(payload => payload.to === 'started');
const slotStatus = (db, slotId = 'slot-1') => db.get('SELECT status FROM p2_plan_slots WHERE slot_id = ?', slotId)?.status;
const cursorAnchor = db => {
  const row = db.get('SELECT page_anchor FROM heartbeat_cursor WHERE scope = ?', KEY);
  return row ? JSON.parse(row.page_anchor || '{}') : {};
};

// ---------------------------------------------------------------------------
// 1. one logical slot, one claim — however many ticks
// ---------------------------------------------------------------------------

test('A slice: a due slot is claimed exactly once, even across 100 heartbeat cycles', t => {
  const world = makeWorld(t);
  seedPlan(world.db);
  seedSlot(world.db);

  const first = world.heartbeat.cycle({ reason: 'timer' });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.dispatched, 1, 'the first cycle claims the due slot');
  assert.equal(slotStatus(world.db), 'started');

  for (let index = 0; index < 100; index += 1) world.heartbeat.cycle({ reason: 'timer' });

  assert.equal(claimedStarts(world.db).length, 1, 'exactly one planned→started event exists');
  assert.equal(slotStatus(world.db), 'started', 'and the slot never moves again');
  assert.equal(Number(world.db.get("SELECT COUNT(*) AS n FROM domain_events WHERE kind = 'autonomy/plan-slot'").n), 1);

  // A second, explicit claim of the same slot re-sends the *same* event (same slot, same instant,
  // same payload), so it is idempotent rather than a second dispatch — and it appends nothing.
  const again = world.p2.claimSlotForHeartbeat({ scopeKey: KEY, slotId: 'slot-1', planId: 'plan-1', day: '2026-11-01', scheduledAt: T0 - HOUR });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.inserted, false, 'the identical claim is acknowledged, not re-applied');
  assert.equal(claimedStarts(world.db).length, 1, 'the claim appended nothing new');

  // A *different* claim payload for an already-started slot is a real contradiction and the
  // reducer refuses it deterministically (`planned → started` from `started` is not allowed).
  const contradictory = world.p2.claimSlotForHeartbeat({ scopeKey: KEY, slotId: 'slot-1', planId: 'plan-1', day: '2026-11-01', scheduledAt: T0 });
  assert.equal(contradictory.ok, false);
  assert.equal(contradictory.code, 'invalid-transition');
  assert.equal(claimedStarts(world.db).length, 1, 'the refusal appended nothing');
});

test('A slice: without the hook the heartbeat is exactly the old heartbeat (rollback switch)', t => {
  const world = makeWorld(t, { hook: false });
  seedPlan(world.db);
  seedSlot(world.db);

  const outcome = world.heartbeat.cycle({ reason: 'timer' });
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(outcome.dispatched ?? 0, 0, 'no hook means no dispatch');
  assert.equal(slotStatus(world.db), 'planned', 'the slot stays planned');
  assert.equal(planSlotEvents(world.db).length, 0, 'and no autonomy event was written');
  assert.equal(world.heartbeat.status().activityDispatch, 'unavailable');
  assert.equal(world.heartbeat.status().activityDispatchLimit, 0);

  // The wired twin reports itself as wired: the diagnostic is never optimistic.
  const wired = makeWorld(t);
  assert.equal(wired.heartbeat.status().activityDispatch, 'wired');
  assert.equal(wired.heartbeat.status().activityDispatchLimit, 1);
});

// ---------------------------------------------------------------------------
// 2. letting the human go first, and the per-cycle cap
// ---------------------------------------------------------------------------

test('A slice: foreground chat, a paused switch or a zero cap defer the claim with a reason', t => {
  // (a) the user is talking: the slot stays due, and the reason is persisted on the cursor.
  const busy = makeWorld(t, { foregroundBusy: () => true });
  seedPlan(busy.db);
  seedSlot(busy.db);
  const deferred = busy.heartbeat.cycle({ reason: 'timer' });
  assert.equal(deferred.ok, true, JSON.stringify(deferred));
  assert.equal(deferred.dispatched, 0);
  assert.equal(deferred.deferred, 1);
  assert.equal(slotStatus(busy.db), 'planned', 'chat priority wins over the plan');
  assert.match(String(cursorAnchor(busy.db).lastError), /dispatch-deferred:chat-priority/);

  // (b) the activity switch is paused: same shape, different reason.
  const paused = makeWorld(t);
  seedPlan(paused.db);
  seedSlot(paused.db);
  paused.db.metaSet('p2_activities_paused', '1');
  const held = paused.heartbeat.cycle({ reason: 'timer' });
  assert.equal(held.ok, true, JSON.stringify(held));
  assert.equal(held.dispatched, 0);
  assert.match(String(cursorAnchor(paused.db).lastError), /dispatch-deferred:activities-paused/);

  // (c) the cap is the documented off switch even with a hook injected.
  const capped = makeWorld(t, { config: configWith({ heartbeat: { maxDispatchPerCycle: 0 } }) });
  seedPlan(capped.db);
  seedSlot(capped.db);
  const none = capped.heartbeat.cycle({ reason: 'timer' });
  assert.equal(none.ok, true, JSON.stringify(none));
  assert.equal(none.dispatched ?? 0, 0);
  assert.equal(slotStatus(capped.db), 'planned');
  // A zero cap is a configuration decision, so it is reported as such — not as "no consumer".
  assert.equal(capped.heartbeat.status().activityDispatch, 'disabled-by-config', 'a zero cap is a config decision, not a missing feature');
  assert.equal(capped.heartbeat.status().activityDispatchLimit, 0);

  // (d) no time budget left: the section is skipped, never run "a little".
  const tight = makeWorld(t, { config: configWith({ heartbeat: { maxTimeBudgetMs: 50 } }) });
  seedPlan(tight.db);
  seedSlot(tight.db);
  let calls = 0;
  const starving = createHeartbeat({
    db: tight.db, config: tight.config, clock: () => tight.clock.value, elapsed: () => (calls++ === 0 ? 0 : 1e6),
    owner: tight.owner, generation: tight.generation, dispatch: () => ({ ok: true, results: [] }),
    agenda: emptyAgenda(),
    activityDispatch: { dueSlots: () => ({ slots: [], deferred: null }), claim: () => ({ ok: true, inserted: true }) },
    isActive: () => true, isWritable: () => true,
  });
  const starved = starving.cycle({ reason: 'timer' });
  assert.equal(starved.ok, true, JSON.stringify(starved));
  assert.equal(starved.dispatched ?? 0, 0);
  assert.equal(slotStatus(tight.db), 'planned', 'a starved round claims nothing');
});

test('A slice: the per-cycle cap is honoured when several slots are due', t => {
  const world = makeWorld(t, { config: configWith({ heartbeat: { maxDispatchPerCycle: 1 } }) });
  seedPlan(world.db);
  seedSlot(world.db, { slotId: 'slot-a', startAt: T0 - 2 * HOUR, endAt: T0 + 2 * HOUR });
  seedSlot(world.db, { slotId: 'slot-b', startAt: T0 - 2 * HOUR, endAt: T0 + 2 * HOUR });

  const one = world.heartbeat.cycle({ reason: 'timer' });
  assert.equal(one.dispatched, 1, 'only one claim per cycle');
  assert.equal(claimedStarts(world.db).length, 1);

  const two = world.heartbeat.cycle({ reason: 'timer' });
  assert.equal(two.dispatched, 1, 'the next beat claims the next slot');
  assert.equal(claimedStarts(world.db).length, 2);
  assert.deepEqual(
    world.db.all("SELECT slot_id, status FROM p2_plan_slots ORDER BY slot_id").map(row => [row.slot_id, row.status]),
    [['slot-a', 'started'], ['slot-b', 'started']],
  );
});

// ---------------------------------------------------------------------------
// 3. crash between claim and execution
// ---------------------------------------------------------------------------

test('A slice: a slot claimed but never started is recovered by the pump, not lost', async t => {
  const world = makeWorld(t);
  seedPlan(world.db);
  seedSlot(world.db);
  world.heartbeat.cycle({ reason: 'timer' });
  assert.equal(slotStatus(world.db), 'started');
  assert.equal(Number(world.db.get('SELECT COUNT(*) AS n FROM p2_activities').n), 0, 'the claim created no activity');

  // "Crash": the process that claimed the slot is gone. A fresh controller (same database, same
  // real files) must be able to execute the claim.
  world.db.close();
  const dir = path.dirname(world.dbFile);
  const reopened = openRuntimeDb({ file: world.dbFile, now: () => T0 });
  t.after(() => { try { reopened.close(); } catch { /* already closed */ } });
  const owner = 'owner-hb-2';
  const generation = 'gen-hb-2';
  // The old lease is taken over (the new owner is this process, the old row is dead evidence).
  assert.equal(reopened.acquireLease({ owner, generation, ttlMs: TTL }).ok, true);
  fs.mkdirSync(path.join(dir, 'works', 'shelf'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'works', 'shelf', 'note.md'), '# 海风\n\n' + '海风把纸吹得作响。'.repeat(30), 'utf8');
  const handlers = { autonomy: (args) => (args.event.kind === 'autonomy/receipt' || args.event.kind === 'autonomy/activity' ? applyActivityEvent(args) : applyPlanEvent(args)) };
  const emit = (input = {}) => {
    const scope = input.scope ?? parseScope(input.scopeKey);
    const { scopeKey: _drop, ...rest } = input;
    return dispatchEvent(reopened, { ...rest, scope }, { handlers, generation, owner, requireConsumers: true });
  };
  const config = configWith();
  const p2 = createP2({
    db: reopened, config, clock: () => T0, owner, generation, getMode: () => 'active', isActive: () => true, emit,
    // `ports` and `artifactRoot` are two different injection points: the ports are a top-level
    // createP2 argument, the artifact root lives in its `options`.
    ports: {
      readFile({ path: file }) { try { return { ok: true, text: fs.readFileSync(file, 'utf8') }; } catch { return { ok: false }; } },
      writeFile() { return { ok: false }; },
      fetchPage() { return { ok: false, status: 0 }; },
    },
    options: { artifactRoot: path.join(dir, 'works') },
  });
  const started = await p2.pump({ now: T0 });
  assert.deepEqual(started.started.length, 1, 'the claimed slot is executed by the new controller');
  const activity = reopened.get('SELECT plan_slot_id, status FROM p2_activities WHERE scope = ?', KEY);
  assert.equal(activity.plan_slot_id, 'slot-1', 'the activity is bound to the claimed slot');
  assert.equal(activity.status, 'running');
  assert.equal(claimedStarts(reopened).length, 1, 'the recovery did not append a second claim');
});

test('A slice: a claimed slot whose window closed becomes an honest miss, not an orphan', async t => {
  const world = makeWorld(t);
  seedPlan(world.db);
  seedSlot(world.db, { slotId: 'slot-late', startAt: T0 - HOUR, endAt: T0 + HOUR });
  world.heartbeat.cycle({ reason: 'timer' });
  assert.equal(slotStatus(world.db, 'slot-late'), 'started');

  // The window closes before anything could execute it (no ports, no model, no disk).
  const later = T0 + 3 * HOUR;
  world.clock.value = later;
  await world.p2.pump({ now: later });
  assert.equal(slotStatus(world.db, 'slot-late'), 'expired', 'the claim is closed instead of hanging forever');
  const missed = world.db.all("SELECT operation, ok, code FROM p2_activity_receipts WHERE operation = 'missed'");
  assert.equal(missed.length, 1, 'and it left one missed receipt as evidence');
  assert.equal(Number(missed[0].ok), 0);
  assert.equal(missed[0].code, 'window-closed');
  const expiredEvent = planSlotEvents(world.db).filter(payload => payload.to === 'expired');
  assert.equal(expiredEvent.length, 1);
  assert.equal(expiredEvent[0].from, 'started', 'the transition starts from the real status');
});

// ---------------------------------------------------------------------------
// 4. plan revisions and scope boundaries
// ---------------------------------------------------------------------------

test('A slice: a superseded plan never dispatches its slots', t => {
  const world = makeWorld(t);
  seedPlan(world.db, { planId: 'plan-old', version: 1, status: 'superseded' });
  seedSlot(world.db, { slotId: 'slot-old', planId: 'plan-old' });
  seedPlan(world.db, { planId: 'plan-new', version: 2, status: 'committed', day: '2026-11-01' });
  seedSlot(world.db, { slotId: 'slot-new', planId: 'plan-new' });

  const outcome = world.heartbeat.cycle({ reason: 'timer' });
  assert.equal(outcome.dispatched, 1, 'only the committed plan contributes a due slot');
  assert.equal(slotStatus(world.db, 'slot-new'), 'started');
  assert.equal(slotStatus(world.db, 'slot-old'), 'planned', 'the superseded plan is untouched');
  assert.deepEqual(claimedStarts(world.db).map(payload => payload.slotId), ['slot-new']);
});

test('A slice: the Shanghai midnight boundary is decided by instants, not calendar days', async t => {
  const world = makeWorld(t);
  // 2026-11-01 23:58 → 2026-11-02 00:28 Asia/Shanghai (UTC 15:58 → 16:28): one slot spanning
  // midnight. A calendar-day comparison would either miss it or dispatch it twice.
  const lateEvening = Date.UTC(2026, 10, 1, 15, 59, 0);
  const crossingStart = Date.UTC(2026, 10, 1, 15, 58, 0);
  const crossingEnd = Date.UTC(2026, 10, 1, 16, 28, 0);
  world.clock.value = lateEvening;
  seedPlan(world.db, { day: '2026-11-01' });
  seedSlot(world.db, { slotId: 'slot-midnight', startAt: crossingStart, endAt: crossingEnd, day: '2026-11-01' });
  // A slot that already closed yesterday evening.
  seedSlot(world.db, { slotId: 'slot-yesterday', startAt: Date.UTC(2026, 10, 1, 13, 0, 0), endAt: Date.UTC(2026, 10, 1, 13, 30, 0), day: '2026-11-01' });

  const beforeMidnight = world.heartbeat.cycle({ reason: 'timer' });
  assert.equal(beforeMidnight.dispatched, 1);
  assert.equal(slotStatus(world.db, 'slot-midnight'), 'started');

  // After midnight (local 2026-11-02 00:01) the same slot is still inside its window but already
  // claimed: no second dispatch, no duplicate event.
  world.clock.value = Date.UTC(2026, 10, 1, 16, 1, 0);
  const afterMidnight = world.heartbeat.cycle({ reason: 'timer' });
  assert.equal(afterMidnight.dispatched ?? 0, 0, 'a claim is not repeated across the day boundary');
  assert.deepEqual(claimedStarts(world.db).map(payload => payload.slotId), ['slot-midnight']);

  // The yesterday window is not "due" any more; the pump files it as a miss with its own src status.
  await world.p2.pump({ now: Date.UTC(2026, 10, 1, 16, 1, 0) });
  assert.equal(slotStatus(world.db, 'slot-yesterday'), 'expired');
  const missed = world.db.all("SELECT receipt_id FROM p2_activity_receipts WHERE operation = 'missed'");
  assert.equal(missed.length, 1, 'only the closed window produced a miss');
});

// ---------------------------------------------------------------------------
// 5. jump 2: a finished activity becomes a P1 fact (through the real mount)
// ---------------------------------------------------------------------------

function mountRoot(t, activities = { enabled: true, dispatchEnabled: true, chunkUnits: 200, maxUnitsPerStep: 4000, maxSourceBytes: 200000, maxTotalUnits: 200000, maxExcerptChars: 400 }) {
  const root = tempRoot(t, 'p2-dispatch-mount');
  for (const dir of ['home/companion', 'home/companion/works/shelf', 'logs']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, 'home/companion/works/shelf/note.md'), '# 海风\n\n' + '海风把纸吹得作响。'.repeat(40), 'utf8');
  fs.writeFileSync(path.join(root, 'home/companion/identity.json'), JSON.stringify({
    schemaVersion: 1, persona: 'bot', owner: { id: 'owner-1', displayName: 'o', platform: 'qq' },
    desktop: { mode: 'local-owner', userId: 'owner-1' }, sessions: {},
  }));
  fs.writeFileSync(path.join(root, 'home/companion/memory.config.json'), JSON.stringify({ schemaVersion: 1, backend: 'sqlite', injection: { budgetChars: 2400 }, extraction: { enabled: false }, embedding: { provider: 'local', dimensions: 128 }, wiki: { enabled: false } }));
  fs.writeFileSync(path.join(root, 'home/companion/runtime.config.json'), JSON.stringify({
    enabled: true, mode: 'active', leaseTtlMs: TTL,
    agenda: { enabled: true }, heartbeat: { enabled: true, pollIntervalMs: 600000, jitterMs: 0 },
    p2: { activities },
    bridge: { enabled: false },
  }));
  return root;
}

test('A slice: the mounted runtime really wires the claim, and a finish yields one P1 ingest', async t => {
  const clock = { value: T0 };
  const root = mountRoot(t);
  const ctx = { tools: { register() {} }, systemPrompt: { section() {} }, on() {}, get() { return undefined; } };
  const identity = { resolve: sessionId => ({ userId: 'owner-1', personaId: 'bot', sessionId }) };
  const runtime = mountRuntime(ctx, root, {
    now: () => clock.value,
    identity,
    p2Ports: { readFile({ path: file }) { try { return { ok: true, text: fs.readFileSync(file, 'utf8') }; } catch { return { ok: false }; } } },
  });
  t.after(() => { try { runtime.dispose(); } catch { /* already disposed */ } });

  // The mount must not claim a capability it lacks: with activities on, the hook is wired.
  assert.equal(runtime.heartbeatStatus().activityDispatch, 'wired');

  // Persist the scope through the public event path, then seed a committed plan + a due slot.
  const proposed = runtime.recordEvent({ sessionId: 's', kind: 'goal/proposed', payload: { title: '看一页书' } });
  assert.equal(proposed.ok, true, JSON.stringify(proposed));
  const dbFile = path.join(root, 'home/companion/companion-runtime.db');
  const side = openRuntimeDb({ file: dbFile, now: () => clock.value });
  const scopeRow = side.get('SELECT scope FROM scope_snapshots ORDER BY scope LIMIT 1');
  assert.ok(scopeRow?.scope, 'a persisted scope exists');
  side.run(`INSERT INTO p2_plans (plan_id, scope, day, version, status, time_zone, window_start, window_end, summary, source_run_id, supersedes, created_at, committed_at)
            VALUES ('plan-m', ?, '2026-11-01', 1, 'committed', 'Asia/Shanghai', ?, ?, '', '', '', ?, ?)`,
  scopeRow.scope, T0 - HOUR, T0 + 6 * HOUR, T0, T0);
  side.run(`INSERT INTO p2_plan_slots (slot_id, plan_id, scope, day, start_at, end_at, kind, activity, title, detail,
              flexibility, intent, target_ref, status, locked, created_at, updated_at)
            VALUES ('slot-m', 'plan-m', ?, '2026-11-01', ?, ?, 'activity', 'read', '海风', '{"reality":"actual_tool_activity"}', 'soft', '', 'shelf/note.md', 'planned', 0, ?, ?)`,
  scopeRow.scope, T0 - HOUR, T0 + HOUR, T0, T0);
  side.close();

  // The heartbeat claims it through index.mjs' wiring (no direct hook call in this assertion).
  const cycle = runtime.runHeartbeatCycle();
  assert.equal(cycle.ok, true, JSON.stringify(cycle));
  assert.equal(cycle.dispatched, 1, JSON.stringify(cycle));

  // The pump turns the claim into a real activity, exactly as the 60 s P2 timer would.
  const pumped = await runtime.pumpActivities({ now: T0 });
  assert.equal(pumped.ok, true, JSON.stringify(pumped));
  assert.equal(pumped.started.length, 1);
  const activityId = pumped.started[0];

  const check = openRuntimeDb({ file: dbFile, now: () => clock.value });
  t.after(() => { try { check.close(); } catch { /* already closed */ } });
  assert.equal(check.get('SELECT status FROM p2_plan_slots WHERE slot_id = ?', 'slot-m').status, 'started');
  assert.equal(check.get('SELECT status FROM p2_activities WHERE activity_id = ?', activityId).status, 'running');

  // Finishing the activity must produce exactly one P1 `memory/ingest-request` and one outbox row.
  const finished = await runtime.finishActivity({ sessionId: 's', activityId });
  assert.equal(finished.ok, true, JSON.stringify(finished));
  const ingest = check.all("SELECT event_id FROM domain_events WHERE kind = 'memory/ingest-request'");
  assert.equal(ingest.length, 1, 'one P1 event for the finished activity');
  const outbox = check.all('SELECT outbox_id, status FROM memory_outbox');
  assert.equal(outbox.length, 1, 'the bridge consumer queued it exactly once');
  assert.equal(outbox[0].status, 'queued');
  const payload = JSON.parse(check.get("SELECT payload FROM domain_events WHERE kind = 'memory/ingest-request'").payload);
  assert.equal(payload.namespace, 'p2/activity');
  assert.match(String(payload.content), /自主阅读/, 'the fact states what happened, bounded');

  // Idempotency: finishing again (or a duplicated close) must not add a second event or row.
  const again = await runtime.finishActivity({ sessionId: 's', activityId });
  assert.equal(again.ok, true);
  assert.equal(again.duplicate, true, 'a repeated finish is a no-op');
  assert.equal(check.all("SELECT event_id FROM domain_events WHERE kind = 'memory/ingest-request'").length, 1);
  assert.equal(check.all('SELECT outbox_id FROM memory_outbox').length, 1);
});

test('A slice: an activity that is only paused or abandoned never claims to have happened', async t => {
  const clock = { value: T0 };
  const root = mountRoot(t);
  const ctx = { tools: { register() {} }, systemPrompt: { section() {} }, on() {}, get() { return undefined; } };
  const identity = { resolve: sessionId => ({ userId: 'owner-1', personaId: 'bot', sessionId }) };
  const runtime = mountRuntime(ctx, root, {
    now: () => clock.value,
    identity,
    p2Ports: { readFile({ path: file }) { try { return { ok: true, text: fs.readFileSync(file, 'utf8') }; } catch { return { ok: false }; } } },
  });
  t.after(() => { try { runtime.dispose(); } catch { /* already disposed */ } });
  runtime.recordEvent({ sessionId: 's', kind: 'goal/proposed', payload: { title: '看一页书' } });

  const dbFile = path.join(root, 'home/companion/companion-runtime.db');
  const side = openRuntimeDb({ file: dbFile, now: () => clock.value });
  const scopeRow = side.get('SELECT scope FROM scope_snapshots ORDER BY scope LIMIT 1');
  side.run(`INSERT INTO p2_plans (plan_id, scope, day, version, status, time_zone, window_start, window_end, summary, source_run_id, supersedes, created_at, committed_at)
            VALUES ('plan-p', ?, '2026-11-01', 1, 'committed', 'Asia/Shanghai', ?, ?, '', '', '', ?, ?)`,
  scopeRow.scope, T0 - HOUR, T0 + 6 * HOUR, T0, T0);
  side.run(`INSERT INTO p2_plan_slots (slot_id, plan_id, scope, day, start_at, end_at, kind, activity, title, detail,
              flexibility, intent, target_ref, status, locked, created_at, updated_at)
            VALUES ('slot-p', 'plan-p', ?, '2026-11-01', ?, ?, 'activity', 'read', '海风', '{"reality":"actual_tool_activity"}', 'soft', '', 'shelf/note.md', 'planned', 0, ?, ?)`,
  scopeRow.scope, T0 - HOUR, T0 + HOUR, T0, T0);
  side.close();

  runtime.runHeartbeatCycle();
  const pumped = await runtime.pumpActivities({ now: T0 });
  const activityId = pumped.started[0];
  const paused = await runtime.pauseActivity({ sessionId: 's', activityId, reason: 'user-arrived' });
  assert.equal(paused.ok, true, JSON.stringify(paused));

  const check = openRuntimeDb({ file: dbFile, now: () => clock.value });
  t.after(() => { try { check.close(); } catch { /* already closed */ } });
  assert.equal(check.all("SELECT event_id FROM domain_events WHERE kind = 'memory/ingest-request'").length, 0, 'a pause is not an experience');
  assert.equal(check.all('SELECT outbox_id FROM memory_outbox').length, 0);
});

// ---------------------------------------------------------------------------
// 6. the gray-release switch (P2.5-1 §6): shipping the code must not change behaviour
// ---------------------------------------------------------------------------

test('A slice: the mounted runtime does not dispatch until p2.activities.dispatchEnabled is on', async t => {
  const clock = { value: T0 };
  // The dangerous combination this section exists for: activities already enabled (as the real
  // production config has been since long before this slice), gray switch absent → false.
  const root = mountRoot(t, { enabled: true, chunkUnits: 200, maxUnitsPerStep: 4000, maxSourceBytes: 200000, maxTotalUnits: 200000, maxExcerptChars: 400 });
  const ctx = { tools: { register() {} }, systemPrompt: { section() {} }, on() {}, get() { return undefined; } };
  const identity = { resolve: sessionId => ({ userId: 'owner-1', personaId: 'bot', sessionId }) };
  const runtime = mountRuntime(ctx, root, {
    now: () => clock.value,
    identity,
    p2Ports: { readFile({ path: file }) { try { return { ok: true, text: fs.readFileSync(file, 'utf8') }; } catch { return { ok: false }; } } },
  });
  t.after(() => { try { runtime.dispose(); } catch { /* already disposed */ } });

  // Three states, and "the operator has not turned it on" is its own state.
  assert.equal(runtime.heartbeatStatus().activityDispatch, 'disabled-by-config');
  assert.equal(runtime.heartbeatStatus().activityDispatchLimit, 0);
  assert.equal(runtime.p2Status({ sessionId: 's' }).activities.enabled, true, 'execution is still enabled: only dispatch is gated');

  runtime.recordEvent({ sessionId: 's', kind: 'goal/proposed', payload: { title: '看一页书' } });
  const dbFile = path.join(root, 'home/companion/companion-runtime.db');
  const side = openRuntimeDb({ file: dbFile, now: () => clock.value });
  const scopeRow = side.get('SELECT scope FROM scope_snapshots ORDER BY scope LIMIT 1');
  side.run(`INSERT INTO p2_plans (plan_id, scope, day, version, status, time_zone, window_start, window_end, summary, source_run_id, supersedes, created_at, committed_at)
            VALUES ('plan-g', ?, '2026-11-01', 1, 'committed', 'Asia/Shanghai', ?, ?, '', '', '', ?, ?)`,
  scopeRow.scope, T0 - HOUR, T0 + 6 * HOUR, T0, T0);
  side.run(`INSERT INTO p2_plan_slots (slot_id, plan_id, scope, day, start_at, end_at, kind, activity, title, detail,
              flexibility, intent, target_ref, status, locked, created_at, updated_at)
            VALUES ('slot-g', 'plan-g', ?, '2026-11-01', ?, ?, 'activity', 'read', '海风', '{"reality":"actual_tool_activity"}', 'soft', '', 'shelf/note.md', 'planned', 0, ?, ?)`,
  scopeRow.scope, T0 - HOUR, T0 + HOUR, T0, T0);
  side.close();

  // No claim: the due slot is untouched and no autonomy event exists.
  const cycle = runtime.runHeartbeatCycle();
  assert.equal(cycle.ok, true, JSON.stringify(cycle));
  assert.equal(cycle.dispatched ?? 0, 0, 'the gray switch is closed');

  const check = openRuntimeDb({ file: dbFile, now: () => clock.value });
  t.after(() => { try { check.close(); } catch { /* already closed */ } });
  assert.equal(check.get('SELECT status FROM p2_plan_slots WHERE slot_id = ?', 'slot-g').status, 'planned', 'the slot is not claimed');
  assert.equal(check.all("SELECT event_id FROM domain_events WHERE kind = 'autonomy/plan-slot'").length, 0);

  // The old execution path is untouched: the pump still starts a planned slot with no claim,
  // which is exactly the behaviour of the code before this slice.
  const pumped = await runtime.pumpActivities({ now: T0 });
  assert.equal(pumped.started.length, 1, 'execution itself never depended on the gray switch');
  assert.equal(check.get('SELECT status FROM p2_activities WHERE activity_id = ?', pumped.started[0]).status, 'running');
});

test('A slice: the p2 hooks refuse a claim on their own when the gray switch is off', async t => {
  // Defence in depth: a host that reaches the controller hooks directly (bypassing index.mjs'
  // injection check) must still be refused, before any event is appended.
  const world = makeWorld(t, { config: configWith({ p2: { activities: { enabled: true, dispatchEnabled: false, paused: false } } }) });
  seedPlan(world.db);
  seedSlot(world.db);

  const due = world.p2.dueSlotsForHeartbeat({ scopeKey: KEY, now: T0, limit: 1 });
  assert.deepEqual(due, { slots: [], deferred: 'dispatch-disabled' });
  const claim = world.p2.claimSlotForHeartbeat({ scopeKey: KEY, slotId: 'slot-1', planId: 'plan-1', day: '2026-11-01', scheduledAt: T0 - HOUR });
  assert.equal(claim.ok, false);
  assert.equal(claim.code, 'dispatch-disabled');
  assert.equal(planSlotEvents(world.db).length, 0, 'a refused claim appends nothing');
  assert.equal(slotStatus(world.db), 'planned');

  // And the heartbeat round is a no-op for dispatch: nothing claimed, nothing rejected.
  const cycle = world.heartbeat.cycle({ reason: 'timer' });
  assert.equal(cycle.ok, true, JSON.stringify(cycle));
  assert.equal(cycle.dispatched ?? 0, 0);
  assert.equal(slotStatus(world.db), 'planned');
});

test('A slice: the gray switch is strict — anything but a literal true keeps dispatch off', async t => {
  const { DEFAULT_CONFIG, loadConfig } = await import('../lib/config.mjs');
  assert.equal(DEFAULT_CONFIG.p2.activities.dispatchEnabled, false, 'the shipped default is off (plan §6)');
  assert.equal(DEFAULT_CONFIG.p2.activities.enabled, false);

  // loadConfig reads <root>/home/companion/runtime.config.json; build a throwaway root per value.
  const readBack = (activities) => {
    const root = tempRoot(t, 'p2-dispatch-config');
    fs.mkdirSync(path.join(root, 'home/companion'), { recursive: true });
    fs.writeFileSync(path.join(root, 'home/companion/runtime.config.json'), JSON.stringify({ enabled: true, mode: 'active', p2: { activities } }));
    return loadConfig(root).config.p2.activities.dispatchEnabled;
  };
  assert.equal(readBack({ enabled: true }), false, 'a missing key means off, not "inherit enabled"');
  assert.equal(readBack({ enabled: true, dispatchEnabled: 'true' }), false, 'a string is not a boolean');
  assert.equal(readBack({ enabled: true, dispatchEnabled: 1 }), false, 'a number is not a boolean');
  assert.equal(readBack({ enabled: true, dispatchEnabled: true }), true, 'only a literal true turns it on');
});
