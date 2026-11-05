import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openRuntimeDb } from '../lib/db.mjs';
import { dispatchEvent } from '../lib/events.mjs';
import { applyActivityEvent, createActivities } from '../lib/activities.mjs';
import { applyPlanEvent } from '../lib/planner.mjs';
import { createP2 } from '../lib/p2.mjs';
import { enqueueIngest, drainOutbox, applyBridgeEvent } from '../lib/bridge.mjs';
import { normalizeEvent } from '../lib/events.mjs';
import { scopeKey, parseScope } from '../lib/scope.mjs';
import { mountRuntime } from '../index.mjs';
import { createMemoryEngine } from '../../companion-memory/index.mjs';

// Codex pre-release review — the three runtime P1s (R2, R3, R6).
//
//   R2  a slot the H2 heartbeat already claimed (`started`) must still be usable as a
//       *continuation* target, otherwise the outcome depends on who ran first and a reading
//       continuation can never complete.
//   R3  one finished activity = one experience. Legacy memoryPort off when the P1 hook is wired,
//       plus compensation for "terminal committed, P1 event missing", plus a bounded drainer so a
//       queued `memory/ingest-request` actually becomes a memory.
//   R6  the writes that were still reachable without a lease check (outbox INSERT, claim refresh,
//       pre-memory-call) now fail closed.
//
// Everything is isolated: `os.tmpdir()` databases, no production `home/`, no network, no QQ.

const T0 = Date.UTC(2026, 10, 4, 3, 0, 0);
const HOUR = 3600000;
const SCOPE = Object.freeze({ userId: 'owner-1', personaId: 'bot', worldId: 'world:default' });
const KEY = scopeKey(SCOPE);
const TTL = 60000;
const BOUND = { userId: 'owner-1', persona: 'bot' };
const SOURCE = Array.from({ length: 10 }, (_, index) => `第${index}段：` + '潮声一阵一阵压过来。'.repeat(6)).join('\n\n');

function tempDir(t, label = 'p1-fixes') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  fs.mkdirSync(path.join(dir, 'shelf'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'shelf', 'deep.md'), `# 深处\n\n${SOURCE}`, 'utf8');
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });
  return dir;
}

function filePorts() {
  return {
    readFile({ path: file }) { try { return { ok: true, text: fs.readFileSync(file, 'utf8') }; } catch { return { ok: false }; } },
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

function world(t, { owner = '999999:tester:test', generation = 'gen-1', ttlMs = 600000, clock = { value: T0 } } = {}) {
  const db = openRuntimeDb({ file: ':memory:', now: () => clock.value });
  t.after(() => { try { db.close(); } catch { /* already closed */ } });
  assert.equal(db.acquireLease({ owner, generation, ttlMs }).ok, true);
  db.commitProjection({ scope: KEY, generation, payload: {}, updatedAt: T0 });
  return { db, clock, owner, generation };
}

function seedPlan(db, { planId = 'plan-1', status = 'committed', version = 1, day = '2026-11-04' } = {}) {
  db.run(`INSERT INTO p2_plans (plan_id, scope, day, version, status, time_zone, window_start, window_end, summary, source_run_id, supersedes, created_at, committed_at)
          VALUES (?, ?, ?, ?, ?, 'Asia/Shanghai', ?, ?, '', '', '', ?, ?)`,
  planId, KEY, day, version, status, T0 - 6 * HOUR, T0 + 6 * HOUR, T0, T0);
}

function insertSlot(db, { slotId, planId = 'plan-1', status = 'planned', target = 'shelf/deep.md', startAt = T0 - HOUR, endAt = T0 + HOUR, kind = 'activity' } = {}) {
  db.run(`INSERT INTO p2_plan_slots (slot_id, plan_id, scope, day, start_at, end_at, kind, activity, title, detail,
            flexibility, intent, target_ref, status, locked, created_at, updated_at)
          VALUES (?, ?, ?, '2026-11-04', ?, ?, ?, 'read', '深处', '{"reality":"actual_tool_activity"}', 'soft', '', ?, ?, 0, ?, ?)`,
  slotId, planId, KEY, startAt, endAt, kind, target, status, T0, T0);
}

const dispatchFor = (db, generation, owner = null) => event => dispatchEvent(db, event, {
  handlers: { autonomy: applyActivityEvent, planner: applyPlanEvent },
  generation,
  owner,
  requireConsumers: true,
});

function makeActivities({ db, workspace, owner, generation, clock, ports = filePorts() }) {
  return createActivities({
    db, config: configFor(), clock: () => clock.value, owner, generation,
    dispatch: dispatchFor(db, generation, owner), ports, workspace,
  });
}

const activityRow = (db, activityId) => db.get('SELECT * FROM p2_activities WHERE activity_id = ?', activityId);

// ---------------------------------------------------------------------------
// R2 — claim × continuation
// ---------------------------------------------------------------------------

/**
 * Build the exact R2 situation: an activity paused because its window closed, and the *next*
 * matching slot — with the status the H2 heartbeat leaves (`started`) or the one it has when the
 * pump wins the race (`planned`).
 */
function pausedReading(t, { newSlotStatus }) {
  const dir = tempDir(t);
  const w = world(t);
  seedPlan(w.db);
  insertSlot(w.db, { slotId: 'slot-old' });
  insertSlot(w.db, { slotId: 'slot-new', status: newSlotStatus });
  const activities = makeActivities({ db: w.db, workspace: dir, owner: w.owner, generation: w.generation, clock: w.clock });
  const started = activities.start({ slotId: 'slot-old', kind: 'read' });
  const paused = activities.pause({ activityId: started.activityId, reason: 'window-closed' });
  assert.equal(paused.status, 'paused');
  return { ...w, dir, activities, activityId: started.activityId };
}

test('R2: a continuation slot the heartbeat already claimed (`started`) is still eligible', t => {
  const w = pausedReading(t, { newSlotStatus: 'started' });
  // Before the fix this threw `invalid-transition` ("continuation slot is not an eligible matching
  // activity") and the reading could never continue — the old activity stayed `paused` forever and
  // the claimed slot died as `missed` when its window closed.
  const resumed = w.activities.resume({ activityId: w.activityId, scopeKey: KEY, slotId: 'slot-new', reason: 'planned-continuation' });
  assert.equal(resumed.status, 'running');
  const row = activityRow(w.db, w.activityId);
  assert.equal(row.plan_slot_id, 'slot-new', 'the activity moved onto the claimed slot');
  assert.equal(row.status, 'running');
  const checkpoint = JSON.parse(row.checkpoint);
  assert.equal(checkpoint.continueSlotStatus, 'started', 'the reducer reports the slot status it accepted');
  assert.equal(checkpoint.needsReview, false, 'the resume cleared the review gate');
  assert.equal(w.db.get('SELECT status FROM p2_plan_slots WHERE slot_id = ?', 'slot-new').status, 'started',
    'the claim is not rewritten: no planned→started for an already claimed slot');
});

test('R2: the pump-first order behaves identically (the bug was order dependence)', t => {
  const w = pausedReading(t, { newSlotStatus: 'planned' });
  const resumed = w.activities.resume({ activityId: w.activityId, scopeKey: KEY, slotId: 'slot-new', reason: 'planned-continuation' });
  assert.equal(resumed.status, 'running');
  const row = activityRow(w.db, w.activityId);
  assert.equal(row.plan_slot_id, 'slot-new');
  assert.equal(JSON.parse(row.checkpoint).continueSlotStatus, 'planned');
});

test('R2: only the status set was widened — every other eligibility rule still refuses', t => {
  const dir = tempDir(t);
  const w = world(t);
  seedPlan(w.db);
  insertSlot(w.db, { slotId: 'slot-old' });
  // Right window, wrong target.
  insertSlot(w.db, { slotId: 'slot-wrong-target', status: 'started', target: 'shelf/other.md' });
  // Right target, closed window.
  insertSlot(w.db, { slotId: 'slot-closed', status: 'started', startAt: T0 - 5 * HOUR, endAt: T0 - 4 * HOUR });
  // Right target and window, but the plan is superseded (a different plan, so a different day).
  seedPlan(w.db, { planId: 'plan-old', status: 'superseded', day: '2026-11-03' });
  insertSlot(w.db, { slotId: 'slot-old-plan', planId: 'plan-old', status: 'started' });
  // Right target and window, but not an activity slot.
  insertSlot(w.db, { slotId: 'slot-rest', status: 'started', kind: 'rest' });
  const activities = makeActivities({ db: w.db, workspace: dir, owner: w.owner, generation: w.generation, clock: w.clock });
  const started = activities.start({ slotId: 'slot-old', kind: 'read' });
  activities.pause({ activityId: started.activityId, reason: 'window-closed' });

  for (const slotId of ['slot-wrong-target', 'slot-closed', 'slot-old-plan', 'slot-rest']) {
    assert.throws(
      () => activities.resume({ activityId: started.activityId, scopeKey: KEY, slotId, reason: 'planned-continuation' }),
      error => error.code === 'invalid-transition',
      `${slotId} must still be refused`,
    );
  }
  assert.equal(activityRow(w.db, started.activityId).plan_slot_id, 'slot-old', 'refusals never move the activity');
});

// ---------------------------------------------------------------------------
// R3 — the drainer, the single write, and the compensation
// ---------------------------------------------------------------------------

function mountForMemory(t, { withEngine = true } = {}) {
  const root = tempDir(t, 'p1-fixes-mount');
  for (const dir of ['home/companion/works/sources', 'home/memory', 'logs']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, 'home/companion/works/sources/a.md'), '慢速观察'.repeat(40));
  fs.writeFileSync(path.join(root, 'home/companion/identity.json'), JSON.stringify({
    schemaVersion: 1, persona: 'bot', owner: { id: 'owner-1', displayName: 'o', platform: 'qq' },
    desktop: { mode: 'local-owner', userId: 'owner-1' }, sessions: {},
  }));
  fs.writeFileSync(path.join(root, 'home/companion/memory.config.json'), JSON.stringify({
    schemaVersion: 1, backend: 'sqlite', database: 'home/memory/companion-memory.db',
    injection: { budgetChars: 2400 }, extraction: { enabled: false }, embedding: { provider: 'local', dimensions: 128 }, wiki: { enabled: false },
  }));
  fs.writeFileSync(path.join(root, 'home/companion/runtime.config.json'), JSON.stringify({
    enabled: true, mode: 'active', timeZone: 'Asia/Shanghai',
    p2: { planning: { enabled: true }, activities: { enabled: true, artifactRoot: 'home/companion/works', chunkUnits: 20, maxUnitsPerStep: 20 } },
  }));
  return root;
}

async function realEngine(t, root) {
  const engine = createMemoryEngine({
    root,
    identity: { owner() { return { id: 'owner-1', displayName: 'memory', platform: 'local' }; }, resolve(sessionId) { return { userId: 'owner-1', personaId: 'bot', displayName: 'memory', sessionId }; } },
    env: {}, now: () => T0,
  });
  t.after(async () => { try { await engine.close(); } catch { /* cleanup only */ } });
  await engine.initialize();
  return engine;
}

test('R3: finish → P1 event → outbox → drain → a real memory row (the chain had never run)', async t => {
  const root = mountForMemory(t);
  const engine = await realEngine(t, root);
  const runtime = mountRuntime(null, root, {
    now: () => T0,
    identity: { resolve: sessionId => ({ ...BOUND, sessionId }) },
    memory: engine,
    callModel: async args => (args.purpose === 'p2-planning'
      ? { text: JSON.stringify({ summary: '读一段', slots: [{ kind: 'activity', activity: 'read', title: '读 a', detail: '', startAt: T0, endAt: T0 + 1800_000, flexibility: 'soft', targetRef: 'sources/a.md' }] }), provider: 'test', model: 'test', inputTokens: 10, outputTokens: 10 }
      : { text: '读到了：慢速观察反复出现', provider: 'test', model: 'test', inputTokens: 10, outputTokens: 6 }),
    p2Ports: { readFile: async ({ path: file }) => ({ ok: true, text: fs.readFileSync(file, 'utf8') }) },
  });
  t.after(() => { try { runtime.dispose(); } catch { /* closed */ } });

  runtime.proposeGoal({ bound: BOUND, title: 'x' });
  await runtime.pumpPlanning({ reason: 'timer' });
  await runtime.pumpActivities({ now: T0 });
  for (let index = 0; index < 8; index += 1) await runtime.pumpActivityExecution({ now: T0, maxStepsPerCycle: 1 });
  const activity = runtime.listActivities({ bound: BOUND }).activities[0];
  assert.equal(activity.status, 'done', 'the reading finished');

  const internal = await engine.internal();
  const countMemories = () => Number(internal.db.handle.prepare('SELECT COUNT(*) AS n FROM memories').get().n);
  assert.equal(countMemories(), 0, 'the event alone is not a memory');

  const drained = await runtime.drainOutboxNow();
  // The drain reached memory and memory made a decision — that is what R3 had to prove. Since
  // P2.5-2 (E2) a *fully read plain article* is `routine` by policy, so the correct outcome here is
  // a policy refusal rather than a durable row; the notable case (a write, an exploration, a
  // failure) lands a real row and is covered in `p2-experience-loop.test.mjs`.
  assert.equal(drained.processed, 1, JSON.stringify(drained));
  assert.equal(countMemories(), 0, 'a routine reading does not become a permanent memory');

  const db = openRuntimeDb({ file: path.join(root, 'home/companion/companion-runtime.db'), now: () => T0 });
  t.after(() => { try { db.close(); } catch { /* closed */ } });
  assert.equal(db.get('SELECT status FROM memory_outbox').status, 'failed', 'the request is terminal, not stuck');
  assert.equal(db.get('SELECT last_error FROM memory_outbox').last_error, 'routine-activity-not-remembered');
  assert.equal(db.all('SELECT outbox_id FROM memory_outbox').length, 1, 'exactly one queued experience');

  // Idle ticks must stay idle (no write transaction, no attempt churn).
  const idle = await runtime.drainOutboxNow();
  assert.equal(idle.skipped, 'idle');
  assert.equal(countMemories(), 0);
});

test('R3: without a memory engine the drain skips quietly and keeps the row for later', async t => {
  const root = mountForMemory(t);
  const runtime = mountRuntime(null, root, {
    now: () => T0,
    identity: { resolve: sessionId => ({ ...BOUND, sessionId }) },
    p2Ports: { readFile: async ({ path: file }) => ({ ok: true, text: fs.readFileSync(file, 'utf8') }) },
  });
  t.after(() => { try { runtime.dispose(); } catch { /* closed */ } });
  const skipped = await runtime.drainOutboxNow();
  assert.equal(skipped.skipped, 'memory-unavailable');
  assert.equal(skipped.processed, 0);
});

test('R3: the pump tick is what drains the outbox (drainMemory is the wired function)', async t => {
  const dir = tempDir(t);
  const w = world(t);
  const delivered = [];
  const p2 = createP2({
    db: w.db, config: configFor(), clock: () => w.clock.value, owner: w.owner, generation: w.generation,
    getMode: () => 'active', isActive: () => true, emit: dispatchFor(w.db, w.generation, w.owner),
    options: {
      artifactRoot: dir,
      onFinished: info => {
        // A minimal stand-in for the runtime hook: one deterministic ingest request per activity.
        const event = normalizeEvent({
          kind: 'memory/ingest-request', scope: SCOPE, occurredAt: Number(info.at) || T0,
          realityStatus: 'actual_tool_activity', evidenceStatus: 'observed',
          payload: { namespace: 'p2/activity', content: `完成了一次阅读 ${info.activityId}`, transformVersion: 'p2-activity-v1' },
        });
        const dispatched = dispatchEvent(w.db, event, { handlers: { bridge: args => applyBridgeEvent(args) }, generation: w.generation, owner: w.owner });
        // Mirror the runtime hook's contract: `{ ok: true }` once the request is queued or already
        // present (a duplicate is a success, not a failure).
        return { ok: dispatched.rejected !== true, duplicate: dispatched.inserted === false };
      },
      drainOutbox: async () => drainOutbox({
        db: w.db, memory: { async ingestDomainEvent(req) { delivered.push(req); return { status: 'accepted', receiptId: 'r1' }; } },
        generation: w.generation, owner: w.owner, now: w.clock.value, limit: 5,
      }),
    },
    ports: filePorts(),
  });
  seedPlan(w.db);
  insertSlot(w.db, { slotId: 'slot-r3' });
  const activities = p2.activities;
  const started = activities.start({ slotId: 'slot-r3', kind: 'read' });
  activities.finish({ activityId: started.activityId });

  assert.equal(w.db.all('SELECT outbox_id FROM memory_outbox').length, 1, 'the finish queued one experience');
  assert.equal(delivered.length, 0);
  const summary = await p2.drainMemory();
  assert.equal(summary.delivered, 1, JSON.stringify(summary));
  assert.equal(delivered.length, 1, 'the function the timer calls is the one that delivers');
  assert.equal(w.db.get('SELECT status FROM memory_outbox').status, 'sent');
});

test('R3: compensation replays only activities finished under the P1 scheme, and never twice', async t => {
  const dir = tempDir(t);
  const w = world(t);
  // Seeded **before** the hook exists: this is what "history" means for the reconciliation pass.
  // A `done` activity from *before* the P1 scheme: it must never be backfilled, otherwise the
  // legacy experience plus this replay would be the double write R3 is about.
  w.db.run(`INSERT INTO p2_activities (activity_id, scope, plan_slot_id, kind, adapter, capability, reality, status,
              target, source_ref, source_hash, total_units, consumed_prefix, checkpoint, artifact_ref, artifact_hash,
              artifact_version, started_at, paused_at, ended_at, created_at, updated_at)
            VALUES ('act_legacy', ?, '', 'read', 'read', 'read', 'actual_tool_activity', 'done',
              'shelf/old.md', 'file:shelf/old.md', ?, 100, 100, '{}', '', '', 0, ?, 0, ?, ?, ?)`,
  KEY, 'a'.repeat(64), T0 - 6 * HOUR, T0 - 6 * HOUR, T0 - 6 * HOUR, T0 - 6 * HOUR);
  // ... and the legacy path **did** write a fact for it (that is what makes it legacy). Without this
  // row the reconciliation must hand it to compensation — which is the new, evidence-based rule.
  w.db.run("INSERT INTO runtime_meta (meta_key, meta_value, updated_at) VALUES (?, 'legacy', ?) ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value, updated_at = excluded.updated_at",
    `p2_p1_act_legacy`, T0 - 6 * HOUR);
  // …and the fact that justifies it (the re-audit revokes marks whose fact is missing).
  w.db.run(`INSERT INTO domain_events (seq, event_id, schema_version, kind, scope, user_id, persona_id, world_id, occurred_at, recorded_at, payload)
            VALUES (90001, 'evt-legacy-fact', 1, 'memory/ingest-request', ?, 'owner-1', 'bot', 'world:default', ?, ?, ?)`,
  KEY, T0 - 6 * HOUR, T0 - 6 * HOUR, JSON.stringify({ namespace: 'p2/activity', facts: { activityId: 'act_legacy' } }));
  const written = [];
  const p2 = createP2({
    db: w.db, config: configFor(), clock: () => w.clock.value, owner: w.owner, generation: w.generation,
    getMode: () => 'active', isActive: () => true, emit: dispatchFor(w.db, w.generation, w.owner),
    options: {
      artifactRoot: dir,
      onFinished: info => {
        written.push(info.activityId);
        const event = normalizeEvent({
          kind: 'memory/ingest-request', scope: SCOPE, occurredAt: Number(info.at) || T0,
          realityStatus: 'actual_tool_activity', evidenceStatus: 'observed',
          payload: { namespace: 'p2/activity', content: `完成了一次阅读 ${info.activityId}`, transformVersion: 'p2-activity-v1' },
        });
        const dispatched = dispatchEvent(w.db, event, { handlers: { bridge: args => applyBridgeEvent(args) }, generation: w.generation, owner: w.owner });
        return { ok: dispatched.rejected !== true, duplicate: dispatched.inserted === false };
      },
    },
    ports: filePorts(),
  });
  seedPlan(w.db);
  insertSlot(w.db, { slotId: 'slot-a' });
  const started = p2.activities.start({ slotId: 'slot-a', kind: 'read' });

  // (the legacy row is inserted before the runtime mounts — see below)
  p2.activities.finish({ activityId: started.activityId });
  written.length = 0; // ignore the live write; only the compensation pass matters here

  // Window 1: no mark → the pass replays it.
  w.db.run('DELETE FROM runtime_meta WHERE meta_key = ?', `p2_p1_${started.activityId}`);
  const first = await p2.compensateFinishedEvents({ scopeKey: KEY, limit: 2 });
  assert.deepEqual(first.replayed, [started.activityId], 'the marked activity was compensated once');
  assert.equal(written.filter(id => id === started.activityId).length, 1);
  assert.equal(written.includes('act_legacy'), false, 'a pre-scheme activity is never backfilled');
  assert.equal(w.db.get('SELECT meta_value FROM runtime_meta WHERE meta_key = ?', `p2_p1_${started.activityId}`).meta_value, '1');
  assert.equal(w.db.all("SELECT event_id FROM domain_events WHERE kind = 'memory/ingest-request' AND payload LIKE ?", `%${started.activityId}%`).length, 1,
    'the replay re-used the content-addressed event instead of writing a second one');
  assert.equal(w.db.all('SELECT outbox_id FROM memory_outbox').length, 1);

  // Window 2: already marked → nothing to do, and no starvation of a later activity.
  const second = await p2.compensateFinishedEvents({ scopeKey: KEY, limit: 2 });
  assert.deepEqual(second.replayed, []);
  assert.equal(written.length, 1, 'no second write for the same activity');

  // The P1 mode of `compensateMemory` reports why it no longer touches the legacy port.
  const legacyMode = await p2.compensateMemory({ scopeKey: KEY, limit: 2 });
  assert.equal(legacyMode.skipped, 'superseded-by-p1-hook');
});

// ---------------------------------------------------------------------------
// R6 — the remaining unguarded write paths
// ---------------------------------------------------------------------------

test('R6: the outbox INSERT is refused without the writer lease', t => {
  const w = world(t, { ttlMs: TTL });
  const event = normalizeEvent({
    kind: 'memory/ingest-request', scope: SCOPE, occurredAt: T0,
    realityStatus: 'actual_tool_activity', evidenceStatus: 'observed',
    payload: { content: '合成经历', transformVersion: 'v1' },
  });
  // Inside the lease the insert works …
  const queued = enqueueIngest(w.db, {
    scope: SCOPE, event: event.eventId, namespace: 'p2/activity',
    payload: { content: '合成经历', transformVersion: 'v1', occurredAt: T0 },
    owner: w.owner, generation: w.generation,
  });
  assert.equal(queued.queued, true);
  assert.equal(w.db.all('SELECT outbox_id FROM memory_outbox').length, 1);

  // … and once the lease has lapsed it is refused, with nothing inserted.
  w.clock.value = T0 + TTL + 1;
  assert.throws(
    () => enqueueIngest(w.db, {
      scope: SCOPE, event: 'evt_second', namespace: 'p2/activity',
      payload: { content: '第二条', transformVersion: 'v1', occurredAt: w.clock.value },
      owner: w.owner, generation: w.generation,
    }),
    error => error.code === 'lease-expired',
  );
  assert.equal(w.db.all('SELECT outbox_id FROM memory_outbox').length, 1, 'the refused insert wrote nothing');
});

test('R6: a drain that loses the writer mid-flight records no second delivery', async t => {
  const w = world(t, { ttlMs: TTL });
  for (const [eventId, content] of [['evt_a', '经历一'], ['evt_b', '经历二']]) {
    const event = normalizeEvent({
      kind: 'memory/ingest-request', scope: SCOPE, occurredAt: T0,
      realityStatus: 'actual_tool_activity', evidenceStatus: 'observed',
      payload: { content, transformVersion: 'v1' },
    });
    void eventId;
    enqueueIngest(w.db, {
      scope: SCOPE, event: event.eventId, namespace: 'p2/activity',
      payload: { content, transformVersion: 'v1', occurredAt: T0 },
      owner: w.owner, generation: w.generation,
    });
  }
  assert.equal(w.db.all('SELECT outbox_id FROM memory_outbox').length, 2);
  const delivered = [];
  const summary = await drainOutbox({
    db: w.db, generation: w.generation, owner: w.owner, scopeKey: KEY, now: T0,
    memory: {
      async ingestDomainEvent(request) {
        delivered.push(request);
        // The first delivery outlives the lease: the second claim refresh must be fenced.
        w.clock.value = T0 + TTL + 1;
        return { status: 'accepted', receiptId: 'r1' };
      },
    },
  });
  assert.equal(delivered.length, 1, 'exactly one external call was made');
  // The memory call happened, but by then the lease had lapsed, so the drain must not record a
  // delivery it is no longer entitled to write — `delivered` is a claim about what the *log* says,
  // and the log says nothing. (The row stays queued; memory dedupes the retry by event id, which
  // is the documented at-least-once contract.)
  assert.equal(summary.delivered, 0, 'a lapsed drain cannot claim a delivery');
  assert.equal(summary.skipped, 'writer-fenced');
  const rows = w.db.all('SELECT status FROM memory_outbox ORDER BY created_at ASC, outbox_id ASC');
  assert.deepEqual(rows.map(row => row.status), ['queued', 'queued'], 'nothing was recorded as sent without the lease');
});

test('R6: the legacy memory write checks the lease BEFORE the external call', async t => {
  const dir = tempDir(t);
  const w = world(t, { ttlMs: TTL });
  const calls = [];
  const p2 = createP2({
    db: w.db, config: configFor(), clock: () => w.clock.value, owner: w.owner, generation: w.generation,
    getMode: () => 'active', isActive: () => true, emit: dispatchFor(w.db, w.generation, w.owner),
    memoryPort: { async recordExperience(input) { calls.push(input); return { ok: true, receiptId: 'mem-1' }; } },
    ports: filePorts(),
    options: { artifactRoot: dir },
  });
  seedPlan(w.db);
  insertSlot(w.db, { slotId: 'slot-r6' });
  const started = p2.activities.start({ slotId: 'slot-r6', kind: 'read' });
  // A remembered experience needs evidence: consume a slice before closing.
  p2.activities.step({ activityId: started.activityId, units: 100 });
  p2.activities.finish({ activityId: started.activityId });

  // Inside the lease the port is used (this is the legacy path, kept for non-hooked runtimes).
  const inside = await p2.recordExperience({ scopeKey: KEY, activityId: started.activityId });
  assert.equal(inside.ok, true, JSON.stringify(inside));
  assert.equal(calls.length, 1);

  // After the lease lapses the call must be refused *before* the port is touched.
  w.db.run('DELETE FROM runtime_meta WHERE meta_key = ?', `p2_memory_${started.activityId}`);
  w.clock.value = T0 + TTL + 1;
  const refused = await p2.recordExperience({ scopeKey: KEY, activityId: started.activityId });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'lease-expired');
  assert.equal(calls.length, 1, 'no external write happened without the lease');
});
