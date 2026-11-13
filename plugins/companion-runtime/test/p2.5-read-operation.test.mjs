import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { mountRuntime } from '../index.mjs';
import { openRuntimeDb } from '../lib/db.mjs';
import { activityIdFor } from '../lib/activities.mjs';
import { extractPlainText } from '../lib/activity-adapters.mjs';

// P2.5-A/B minimal acceptance: **one** `read` operation, from a due plan slot to a completion
// receipt — plus the guarantee that nothing dispatches by default.
//
// Why this file exists: the pieces (heartbeat claim, P2 pump, activity lifecycle, effect ledger,
// P1 receipt) each have their own tests, but the *stitched* loop "committed slot → H2 claim →
// pump start → model step → finish → P1 fact" had no single executable acceptance path, and the
// plan (P2.5-B) asks for exactly that, with two hard preconditions:
//
//   * `p2.activities.dispatchEnabled` defaults to false ⇒ shipping the code never starts
//     dispatching (`dispatchEnabled=false` is the one-switch halt);
//   * one logical operation, however many beats / restarts / instances: deterministic id,
//     at most one claim, at most one activity row, at most one completion receipt, at most one
//     P1 ingest request;
//   * an invalidated source must not produce a completion: it parks for review and the fact says
//     `failed`, never `finished`.
//
// Scope fences (deliberately NOT exercised here — see logs/p2.5-next/RELEASE-CHECKLIST.md):
//   * no QQ send, no contact ledger, no share candidate, no `allowedSources` widening;
//   * `explore` / `write` are never auto-dispatched;
//   * everything runs on a throwaway root + throwaway SQLite file — no production database, no
//     network, no host profile;
//   * the model is an injected stub (`callModel`), so this file proves *plumbing*, not that a
//     real provider produced the text. That gap is reported as NOT_RUN, never as "closed loop".
//
// Reproduce:
//   cd plugins/companion-runtime && node --test test/p2.5-read-operation.test.mjs

const T0 = Date.UTC(2026, 10, 2, 4, 0, 0); // 2026-11-02 12:00 Asia/Shanghai
const HOUR = 3600000;
const DAY = 24 * HOUR;
const TTL = 30 * DAY;

// Deterministic body: enough characters that a small `chunkUnits` really needs several steps.
const READ_TEXT = `# 海风\n\n${'海风把纸吹得作响，窗外的电线在响。'.repeat(40)}`;
const READ_TEXT_CHANGED = `# 海风（改过）\n\n${'这一段被换掉了，旧偏移不能再用。'.repeat(40)}`;

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function makeRoot(t, { activities = {}, heartbeat = {}, agenda = {}, share = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p25-read-'));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });
  fs.mkdirSync(path.join(root, 'home/companion/works/shelf'), { recursive: true });
  fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'home/companion/works/shelf/note.md'), READ_TEXT, 'utf8');
  // Synthetic identities only: this file must never carry a real owner id or a real path.
  fs.writeFileSync(path.join(root, 'home/companion/identity.json'), JSON.stringify({
    schemaVersion: 1,
    persona: 'bot',
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
    agenda: { enabled: true, ...agenda },
    heartbeat: { enabled: true, pollIntervalMs: 600000, jitterMs: 0, maxDispatchPerCycle: 1, maxAttempts: 3, ...heartbeat },
    p2: {
      planning: { enabled: false },
      activities: {
        enabled: true,
        // NOTE: `dispatchEnabled` is intentionally absent unless a test sets it. That is the
        // shipped default (`DEFAULT_CONFIG.p2.activities.dispatchEnabled === false`) and the
        // whole point of the first test below.
        paused: false,
        chunkUnits: 4000,
        maxUnitsPerStep: 8000,
        maxSourceBytes: 200000,
        maxTotalUnits: 200000,
        maxExcerptChars: 1200,
        ...activities,
      },
      budget: { maxRequestsPerDay: 64, maxInputTokensPerDay: 160000, maxOutputTokensPerDay: 24000, maxConcurrent: 1, chatPriority: true },
      // Untouched by this task: a narrow allowlist stays narrow. Nothing here fetches a URL.
      autonomy: { allowedSources: [] },
      share: share ?? { enabled: false },
    },
    bridge: { enabled: false },
  }, null, 2));
  return root;
}

function mount(t, root, { clock, callModel, readFile } = {}) {
  const ctx = { tools: { register() {} }, systemPrompt: { section() {} }, on() {}, get() { return undefined; } };
  const identity = { resolve: sessionId => ({ userId: 'owner-synthetic', personaId: 'bot', sessionId }) };
  const runtime = mountRuntime(ctx, root, {
    now: () => clock.value,
    identity,
    // The stub model: deterministic, offline, and labelled as such in every assertion it touches.
    callModel: callModel ?? (() => ({ text: '读完这一段：海风把纸吹得作响。', provider: 'stub-provider', model: 'stub-reader', inputTokens: 120, outputTokens: 24 })),
    p2Ports: {
      readFile: readFile ?? (input => {
        try { return { ok: true, text: fs.readFileSync(input.path, 'utf8') }; } catch { return { ok: false }; }
      }),
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
}

function scopeKeyOfDb(db) {
  const row = db.get('SELECT scope FROM scope_snapshots ORDER BY scope LIMIT 1');
  assert.ok(row?.scope, 'a persisted scope exists');
  return row.scope;
}

function seedDueSlot(db, {
  slotId = 'slot-1', planId = 'plan-1', day = '2026-11-02',
  startAt = T0 - HOUR, endAt = T0 + HOUR,
  activity = 'read', targetRef = 'shelf/note.md', status = 'planned',
  reality = 'actual_tool_activity',
} = {}) {
  const scope = scopeKeyOfDb(db);
  db.run(`INSERT INTO p2_plans (plan_id, scope, day, version, status, time_zone, window_start, window_end, summary, source_run_id, supersedes, created_at, committed_at)
          VALUES (?, ?, ?, 1, 'committed', 'Asia/Shanghai', ?, ?, '', '', '', ?, ?)`,
  planId, scope, day, startAt - HOUR, endAt + HOUR, startAt, startAt);
  db.run(`INSERT INTO p2_plan_slots (slot_id, plan_id, scope, day, start_at, end_at, kind, activity, title, detail,
            flexibility, reality, intent, target_ref, status, locked, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'activity', ?, '海风', '', 'soft', ?, '', ?, ?, 0, ?, ?)`,
  slotId, planId, scope, day, startAt, endAt, activity, reality, targetRef, status, startAt, startAt);
  return { scope, planId, slotId };
}

// ---------------------------------------------------------------------------
// read-only probes (never used to mutate)
// ---------------------------------------------------------------------------

const count = (db, sql, ...params) => Number(db.get(sql, ...params)?.n ?? 0);
const slotStatus = (db, slotId) => db.get('SELECT status FROM p2_plan_slots WHERE slot_id = ?', slotId)?.status;
const activityRows = db => db.all('SELECT activity_id, plan_slot_id, kind, status, consumed_prefix, total_units, source_hash, checkpoint FROM p2_activities ORDER BY created_at');
const receiptRows = (db, activityId) => db.all('SELECT operation, ok, code, source_hash, consumed_from, consumed_to FROM p2_activity_receipts WHERE activity_id = ? ORDER BY at, receipt_id', activityId);
const planSlotPayloads = db => db.all("SELECT payload FROM domain_events WHERE kind = 'autonomy/plan-slot' ORDER BY seq").map(row => JSON.parse(row.payload));
const claims = db => planSlotPayloads(db).filter(payload => payload.to === 'started');
const ingestEvents = db => db.all("SELECT payload, reality_status, evidence_status FROM domain_events WHERE kind = 'memory/ingest-request' ORDER BY seq")
  .map(row => ({ ...JSON.parse(row.payload), realityStatus: row.reality_status, evidenceStatus: row.evidence_status }));
const outboxRows = db => db.all('SELECT outbox_id, status, namespace FROM memory_outbox ORDER BY created_at');
const sha256 = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const plainText = () => extractPlainText({ contentType: 'text/markdown', text: READ_TEXT }).text;

/** Drive one claim+start+execute pass, exactly as the 60 s timer would, but deterministically. */
async function runOneOperation(runtime, { now = T0, steps = 8 } = {}) {
  const cycle = runtime.runHeartbeatCycle({ reason: 'test' });
  assert.equal(cycle.ok, true, JSON.stringify(cycle));
  const started = await runtime.pumpActivities({ now });
  assert.equal(started.ok, true, JSON.stringify(started));
  const execution = await runtime.pumpActivityExecution({ now, maxStepsPerCycle: steps });
  assert.equal(execution.ok, true, JSON.stringify(execution));
  return { cycle, started, execution };
}

// ---------------------------------------------------------------------------
// 1. the one-switch halt: default OFF means the heartbeat claims nothing
// ---------------------------------------------------------------------------

test('gate: with the shipped default (dispatchEnabled absent) the heartbeat claims nothing', async t => {
  const clock = { value: T0 };
  const root = makeRoot(t); // activities.enabled true, dispatchEnabled absent — the production shape
  const runtime = mount(t, root, { clock });
  persistScope(runtime);

  // Diagnostics must say "the operator has not turned it on", not "the feature is missing".
  const status = runtime.heartbeatStatus();
  assert.equal(status.activityDispatch, 'disabled-by-config');
  assert.equal(status.activityDispatchLimit, 0);
  // ...and the execution switch is a different switch, still on.
  assert.equal(runtime.p2Status({ sessionId: 'synthetic-session' }).activities.enabled, true);

  const db = sideDb(t, root);
  seedDueSlot(db);

  for (let index = 0; index < 3; index += 1) {
    const cycle = runtime.runHeartbeatCycle({ reason: 'test' });
    assert.equal(cycle.ok, true, JSON.stringify(cycle));
    assert.equal(cycle.dispatched ?? 0, 0, 'no claim while dispatchEnabled is off');
  }

  assert.equal(slotStatus(db, 'slot-1'), 'planned', 'the due slot stays planned');
  assert.equal(claims(db).length, 0, 'no planned→started event exists');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM p2_activities'), 0, 'no activity was created');
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM domain_events WHERE kind = 'memory/ingest-request'"), 0);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM memory_outbox'), 0);

  // The pump is the pre-existing path and was never automatic: only an explicit call starts it.
  const pumped = await runtime.pumpActivities({ now: T0 });
  assert.equal(pumped.ok, true, JSON.stringify(pumped));
  assert.equal(pumped.started.length, 1, 'execution is gated by its own switch, not by the gray switch');
});

test('gate: pausing activities stops new claims without stopping the runtime', async t => {
  const clock = { value: T0 };
  const root = makeRoot(t, { activities: { dispatchEnabled: true } });
  const runtime = mount(t, root, { clock });
  persistScope(runtime);
  const db = sideDb(t, root);
  seedDueSlot(db);

  const paused = runtime.pauseActivities({ sessionId: 'synthetic-session', reason: 'operator-halt' });
  assert.equal(paused.ok, true, JSON.stringify(paused));

  const cycle = runtime.runHeartbeatCycle({ reason: 'test' });
  assert.equal(cycle.ok, true, JSON.stringify(cycle));
  assert.equal(cycle.dispatched ?? 0, 0, 'a paused activity switch yields no claim');
  assert.equal(slotStatus(db, 'slot-1'), 'planned');
  assert.equal(claims(db).length, 0);
  // The halt is visible as a named deferral, not as silence.
  const anchor = JSON.parse(db.get('SELECT page_anchor FROM heartbeat_cursor WHERE scope = ?', scopeKeyOfDb(db))?.page_anchor ?? '{}');
  assert.match(String(anchor.lastError), /dispatch-deferred/);

  // The runtime itself keeps running: chat-side reads still work while activities are paused.
  assert.equal(runtime.status().mode, 'active');
  const resumed = runtime.resumeActivities();
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  const after = runtime.runHeartbeatCycle({ reason: 'test' });
  assert.equal(after.dispatched, 1, 'resuming re-opens the claim path');
});

// ---------------------------------------------------------------------------
// 2. one read operation: claim once, execute once, one completion receipt
// ---------------------------------------------------------------------------

test('read operation: one claim, one activity, one completion receipt, one P1 ingest', async t => {
  const clock = { value: T0 };
  const root = makeRoot(t, { activities: { dispatchEnabled: true } });
  const runtime = mount(t, root, { clock });
  persistScope(runtime);

  const status = runtime.heartbeatStatus();
  assert.equal(status.activityDispatch, 'wired');
  assert.equal(status.activityDispatchLimit, 1);

  const db = sideDb(t, root);
  const seeded = seedDueSlot(db);

  // --- beat 1: the heartbeat claims the due slot (one planned→started append, nothing else) ---
  const first = runtime.runHeartbeatCycle({ reason: 'timer' });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.dispatched, 1, 'the due slot is claimed');
  assert.equal(slotStatus(db, 'slot-1'), 'started');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM p2_activities'), 0, 'a claim is not an execution');

  // --- beat 2..4: the same slot is never claimed twice ---
  for (let index = 0; index < 3; index += 1) runtime.runHeartbeatCycle({ reason: 'timer' });
  assert.equal(claims(db).length, 1, 'exactly one planned→started event across four beats');

  // --- the pump turns the claim into a real activity with a deterministic id ---
  const started = await runtime.pumpActivities({ now: T0 });
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.equal(started.started.length, 1);
  const expectedId = activityIdFor({ scopeKey: seeded.scope, slotId: 'slot-1', kind: 'read' });
  assert.equal(started.started[0], expectedId, 'the operation id is content-addressed, not random');
  assert.equal(db.get('SELECT status FROM p2_activities WHERE activity_id = ?', expectedId).status, 'running');
  assert.equal(claims(db).length, 1, 'the pump did not append a second claim');

  // --- one real execution pass through the model-gated path ---
  const preRun = await runtime.pumpActivityExecution({ now: T0, maxStepsPerCycle: 8 });
  assert.equal(preRun.ok, true, JSON.stringify(preRun));
  assert.ok(preRun.steps.length >= 1, JSON.stringify(preRun.steps));

  const row = db.get('SELECT activity_id, status, consumed_prefix, total_units, source_hash, ended_at FROM p2_activities WHERE activity_id = ?', expectedId);
  assert.equal(row.status, 'done', 'the source was consumed to the end');
  assert.ok(Number(row.consumed_prefix) > 0);
  assert.equal(Number(row.consumed_prefix), Number(row.total_units), 'stamina: the read reached its last character');
  assert.ok(Number(row.ended_at) > 0, 'the terminal state is stamped');
  // The recorded evidence is the hash of exactly the text that was extracted, not of the file bytes.
  assert.equal(row.source_hash, sha256(plainText()), 'the source hash covers the extracted plain text');

  // --- receipts: a start, ≥1 step, and exactly one completion ---
  const receipts = receiptRows(db, expectedId);
  const byOperation = operation => receipts.filter(entry => entry.operation === operation);
  assert.equal(byOperation('start').length, 1);
  assert.equal(byOperation('finish').length, 1, `exactly one completion receipt, got ${JSON.stringify(receipts)}`);
  assert.equal(byOperation('finish')[0].ok, 1, 'the completion receipt is an affirmative one');
  assert.equal(Number(byOperation('finish')[0].consumed_to), Number(row.total_units), 'coverage is the whole source');
  assert.ok(byOperation('step').length >= 1);
  for (const step of byOperation('step')) {
    assert.equal(step.ok, 1);
    assert.equal(step.source_hash, row.source_hash, 'every step receipt binds to the same source');
    assert.ok(Number(step.consumed_to) > Number(step.consumed_from), 'no zero-width consumption');
  }

  // --- the completion became exactly one P1 fact and exactly one outbox row ---
  const ingests = ingestEvents(db);
  assert.equal(ingests.length, 1, 'one completion → one P1 ingest request');
  const payload = ingests[0];
  assert.equal(payload.namespace, 'p2/activity');
  assert.equal(payload.transformVersion, 'p2-activity-v1');
  assert.equal(payload.facts?.phase, 'finished');
  assert.equal(payload.facts?.kind, 'read');
  // `facts.result` is the runtime's own vocabulary: `ok` | `skipped` | `failed` (index.mjs:2342).
  // It is deliberately NOT the word "completed" — a receipt field must not imply a platform
  // delivery, and this ingest only means "queued for memory".
  assert.equal(payload.facts?.result, 'ok');
  assert.equal(payload.realityStatus, 'actual_tool_activity', 'a real local read is stated as such');
  assert.match(String(payload.content), /阅读|海风/, 'the fact states what happened');
  assert.equal(outboxRows(db).length, 1, 'the bridge queued it once');
  assert.equal(outboxRows(db)[0].status, 'queued', 'queued ≠ delivered: memory was never involved here');

  // --- idempotency: more beats and more pumps add nothing ---
  await runOneOperation(runtime, { now: T0 + 60_000, steps: 8 });
  assert.equal(claims(db).length, 1, 'no second claim after completion');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM p2_activities'), 1, 'no second activity');
  assert.equal(receiptRows(db, expectedId).filter(entry => entry.operation === 'finish').length, 1, 'no second completion receipt');
  assert.equal(ingestEvents(db).length, 1, 'no second P1 fact');
  assert.equal(outboxRows(db).length, 1, 'no second outbox row');
});

// ---------------------------------------------------------------------------
// 3. restart / second instance: the same slot stays one logical operation
// ---------------------------------------------------------------------------

test('restart takes over the claim and still produces one operation', async t => {
  const clock = { value: T0 };
  const root = makeRoot(t, { activities: { dispatchEnabled: true } });
  const runtimeA = mount(t, root, { clock });
  persistScope(runtimeA);
  const dbA = sideDb(t, root);
  const seeded = seedDueSlot(dbA);

  // The heartbeat claims, then the process dies before anything executes.
  runtimeA.runHeartbeatCycle({ reason: 'timer' });
  assert.equal(slotStatus(dbA, 'slot-1'), 'started');
  assert.equal(count(dbA, 'SELECT COUNT(*) AS n FROM p2_activities'), 0);
  runtimeA.dispose();

  // A fresh mount on the same database — the "restarted host" case.
  const runtimeB = mount(t, root, { clock: { value: T0 + 5 * 60_000 } });
  assert.equal(runtimeB.writable, true, 'the restarted host takes the writer lease');
  const pumped = await runtimeB.pumpActivities({ now: T0 + 5 * 60_000 });
  assert.equal(pumped.ok, true, JSON.stringify(pumped));
  const expectedId = activityIdFor({ scopeKey: seeded.scope, slotId: 'slot-1', kind: 'read' });
  assert.deepEqual(pumped.started, [expectedId], 'the recovered operation keeps the same id');

  const done = await runtimeB.pumpActivityExecution({ now: T0 + 5 * 60_000, maxStepsPerCycle: 8 });
  assert.equal(done.ok, true, JSON.stringify(done));
  const dbB = sideDb(t, root);
  assert.equal(claims(dbB).length, 1, 'the recovery did not append a second claim');
  assert.equal(count(dbB, 'SELECT COUNT(*) AS n FROM p2_activities'), 1);
  assert.equal(ingestEvents(dbB).length, 1, 'one completion fact, written by the second host');
  assert.equal(outboxRows(dbB).length, 1);

  // A third mount does not re-do the operation.
  runtimeB.dispose();
  const runtimeC = mount(t, root, { clock: { value: T0 + 10 * 60_000 } });
  const cycle = runtimeC.runHeartbeatCycle({ reason: 'timer' });
  assert.equal(cycle.dispatched ?? 0, 0, 'a completed slot is not claimed again');
  await runtimeC.pumpActivities({ now: T0 + 10 * 60_000 });
  await runtimeC.pumpActivityExecution({ now: T0 + 10 * 60_000, maxStepsPerCycle: 8 });
  const dbC = sideDb(t, root);
  assert.equal(claims(dbC).length, 1);
  assert.equal(count(dbC, 'SELECT COUNT(*) AS n FROM p2_activities'), 1);
  assert.equal(ingestEvents(dbC).length, 1);
  assert.equal(outboxRows(dbC).length, 1);
});

test('lease takeover fences the old instance: only the current writer may claim', async t => {
  const clock = { value: T0 };
  const root = makeRoot(t, { activities: { dispatchEnabled: true } });
  const first = mount(t, root, { clock });
  persistScope(first);
  const db = sideDb(t, root);
  seedDueSlot(db);

  // Two mounts in ONE process are not "two instances": `db.acquireLease` deliberately lets a
  // same-pid remount take the lease over (db.mjs:209-211, the hot-reload path). What must hold —
  // and what this asserts — is that the *previous* writer stops being able to claim the moment the
  // lease moves, and that the claim is then made exactly once by the new owner.
  // Real cross-process exclusion is covered by `test/lease-crossprocess.test.mjs` (existing suite).
  const second = mount(t, root, { clock });
  assert.equal(second.writable, true, 'a same-process remount takes the lease over by design');

  const fenced = first.runHeartbeatCycle({ reason: 'timer' });
  assert.notEqual(fenced.ok, true, JSON.stringify(fenced), 'the previous writer may not run a business cycle');
  assert.match(String(fenced.code ?? ''), /lease|generation|inactive/, JSON.stringify(fenced));
  assert.equal(slotStatus(db, 'slot-1'), 'planned', 'the fenced instance claimed nothing');
  assert.equal(claims(db).length, 0);

  // The current lease holder is the single dispatch owner.
  const owned = second.runHeartbeatCycle({ reason: 'timer' });
  assert.equal(owned.ok, true, JSON.stringify(owned));
  assert.equal(owned.dispatched, 1, JSON.stringify(owned));
  assert.equal(claims(db).length, 1);
});

// ---------------------------------------------------------------------------
// 4. invalidation recovery: a source that moved under the read never finishes
// ---------------------------------------------------------------------------

test('invalidation: a source changed mid-read parks for review and never claims completion', async t => {
  const clock = { value: T0 };
  // Small steps ⇒ the first pass consumes only part of the source, so there is a "mid-read".
  const root = makeRoot(t, { activities: { dispatchEnabled: true, chunkUnits: 200, maxUnitsPerStep: 200 } });
  const runtime = mount(t, root, { clock });
  persistScope(runtime);
  const db = sideDb(t, root);
  const seeded = seedDueSlot(db);

  runtime.runHeartbeatCycle({ reason: 'timer' });
  const started = await runtime.pumpActivities({ now: T0 });
  assert.equal(started.started.length, 1, JSON.stringify(started));
  const activityId = started.started[0];

  const first = await runtime.pumpActivityExecution({ now: T0, maxStepsPerCycle: 1 });
  assert.equal(first.ok, true, JSON.stringify(first));
  const mid = db.get('SELECT status, consumed_prefix, total_units FROM p2_activities WHERE activity_id = ?', activityId);
  assert.equal(mid.status, 'running');
  assert.ok(Number(mid.consumed_prefix) > 0, 'a real prefix was consumed');
  assert.ok(Number(mid.consumed_prefix) < Number(mid.total_units), 'and the read is not finished yet');

  // The source changes on disk (another writer, an edit, a sync).
  fs.writeFileSync(path.join(root, 'home/companion/works/shelf/note.md'), READ_TEXT_CHANGED, 'utf8');

  const second = await runtime.pumpActivityExecution({ now: T0 + 60_000, maxStepsPerCycle: 4 });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.ok(second.steps.some(step => step.code === 'source-changed'), JSON.stringify(second.steps));
  // The executor must also *converge*: reporting the code every tick while the row stays `running`
  // is the "permanently stuck in running" state §6 of the plan forbids. It parks instead.
  assert.ok(second.steps.some(step => step.code === 'parked' && step.reason === 'source-changed'), JSON.stringify(second.steps));

  const parked = db.get('SELECT status, consumed_prefix, checkpoint FROM p2_activities WHERE activity_id = ?', activityId);
  assert.equal(parked.status, 'paused', 'a moved source parks the activity, it does not finish it');
  assert.equal(Number(parked.consumed_prefix), Number(mid.consumed_prefix), 'no progress is invented from the old offset');
  assert.equal(JSON.parse(parked.checkpoint).needsReview, true, 'the review gate is set');
  assert.equal(JSON.parse(parked.checkpoint).reason, 'source-changed');

  const receipts = receiptRows(db, activityId);
  // NOTE for readers of `p2_activity_receipts`: the R4 effect ledger reuses `operation='review'`
  // with `code='lc-effect'` (CONTRACT §13.6.6), so a happy path legitimately contains two extra
  // rows here (`prepared`, then `confirmed`). They are not refusals — filter them before counting,
  // or a clean run looks like it was rejected twice.
  const effectRows = receipts.filter(entry => entry.code === 'lc-effect');
  assert.equal(effectRows.length, 2, 'the effect ledger closed its prepared→confirmed pair');
  assert.equal(receipts.filter(entry => entry.operation === 'finish').length, 0, 'no completion receipt exists');
  const review = receipts.filter(entry => entry.operation === 'review' && entry.code !== 'lc-effect');
  assert.ok(review.length >= 1, 'the refusal is evidence');
  assert.equal(review[review.length - 1].code, 'source-changed');

  // The fact that reaches P1 is a failure, never a completion.
  const ingests = ingestEvents(db);
  assert.equal(ingests.length, 1, 'the parked read is reported once');
  assert.equal(ingests[0].facts?.phase, 'failed');
  assert.equal(ingests[0].facts?.code, 'source-changed');
  assert.notEqual(ingests[0].facts?.result, 'completed');
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM domain_events WHERE kind = 'memory/ingest-request'"), 1);

  // The parked row is not silently advanced or re-claimed by later beats.
  const again = await runtime.pumpActivityExecution({ now: T0 + 120_000, maxStepsPerCycle: 4 });
  assert.equal(again.ok, true);
  assert.ok(again.steps.every(step => step.code !== 'stepped'), JSON.stringify(again.steps));
  const beat = runtime.runHeartbeatCycle({ reason: 'timer' });
  assert.equal(beat.dispatched ?? 0, 0, 'the parked slot is not re-claimed');
  assert.equal(claims(db).length, 1);

  // Reconciliation reports the row as needing review — it does not "repair" it into a resume.
  const reconciled = runtime.reconcileActivities({ sessionId: 'synthetic-session' });
  assert.equal(reconciled.ok === false, false, JSON.stringify(reconciled));
  assert.ok(Array.isArray(reconciled.needsReview), 'reconcile answers with a review list');
  assert.ok(reconciled.needsReview.includes(activityId), JSON.stringify(reconciled));
  assert.equal(db.get('SELECT status FROM p2_activities WHERE activity_id = ?', activityId).status, 'paused');
});

// ---------------------------------------------------------------------------
// 5. a read refusal is retryable — the honest asymmetry with explore / write
// ---------------------------------------------------------------------------

test('retry: a missing source leaves no activity row and blocks nothing (read has no outward effect)', async t => {
  const clock = { value: T0 };
  const root = makeRoot(t, { activities: { dispatchEnabled: true } });
  // First mount: the read port reports "no such file" (a definite answer, not a lost request).
  let sourcePresent = false;
  const runtime = mount(t, root, {
    clock,
    readFile: input => {
      if (!sourcePresent) return { ok: false };
      try { return { ok: true, text: fs.readFileSync(input.path, 'utf8') }; } catch { return { ok: false }; }
    },
  });
  persistScope(runtime);
  const db = sideDb(t, root);
  seedDueSlot(db);

  runtime.runHeartbeatCycle({ reason: 'timer' });
  const attempt = await runtime.pumpActivities({ now: T0 });
  assert.equal(attempt.ok, true, JSON.stringify(attempt));
  assert.equal(attempt.started.length, 0, 'a refused start creates nothing');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM p2_activities'), 0, 'no activity row for a refused start');
  assert.equal(claims(db).length, 1, 'the claim itself is untouched');

  // The effect ledger must say "provably not applied" — a read cannot have changed the world,
  // so a later attempt is legal. (`unknown` is reserved for explore/write, which may have acted.)
  const effects = runtime.listEffects({ sessionId: 'synthetic-session' });
  assert.equal(effects.ok, true, JSON.stringify(effects));
  const phases = (effects.effects ?? []).map(entry => entry.phase);
  assert.ok(phases.includes('not_applied'), `the read attempt is not_applied, got ${JSON.stringify(phases)}`);
  assert.equal(phases.includes('unknown'), false, 'a local read can never be an unknown effect');

  // Restore the source: the next pass starts the same deterministic operation.
  sourcePresent = true;
  const cooling = await runtime.pumpActivities({ now: T0 + 60_000 });
  assert.equal(cooling.started.length, 0, 'source recovery still respects persisted retry backoff');
  const retried = await runtime.pumpActivities({ now: T0 + 300_000 });
  assert.equal(retried.ok, true, JSON.stringify(retried));
  assert.equal(retried.started.length, 1, JSON.stringify(retried));
  assert.equal(claims(db).length, 1, 'the retry reuses the existing claim');
  const done = await runtime.pumpActivityExecution({ now: T0 + 300_000, maxStepsPerCycle: 8 });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(db.get('SELECT status FROM p2_activities WHERE activity_id = ?', retried.started[0]).status, 'done');
  assert.equal(ingestEvents(db).length, 1, 'and exactly one completion fact exists at the end');
});
