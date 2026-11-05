// A real child process for the writer/fencing test (P2 blocking-8 leftover).
//
// Two modes, one database file, no mocks: the lease, the generation meta row and the activity
// rows are all real `node:sqlite` rows written by the runtime's own code in *separate*
// processes.
//
//   hold    — take the writer lease, plan a slot, start a read activity, consume one window,
//             print one JSON line and then stay alive holding the lease until it is killed.
//   worker  — start while `hold` is alive: it must be refused the writer role and must not be
//             able to write progress; then wait for the holder to die and take over on the
//             runtime's own takeover path, consume exactly one more window, verify recovery
//             and exit.
//
// Every observation is a single JSON line on stdout so the parent test can assert on facts,
// not on timing.

import fs from 'node:fs';
import path from 'node:path';
import { openRuntimeDb } from '../../lib/db.mjs';
import { dispatchEvent } from '../../lib/events.mjs';
import { applyActivityEvent, createActivities } from '../../lib/activities.mjs';
import { applyPlanEvent } from '../../lib/planner.mjs';
import { listEvents } from '../../lib/events.mjs';
import { verifyRecovery } from '../../lib/snapshot.mjs';
import { scopeKey } from '../../lib/scope.mjs';
import { RuntimeError } from '../../lib/errors.mjs';

const MODE = process.argv[2] || 'hold';
const ROOT = process.env.P2_FENCE_ROOT || '';
const SCOPE = { userId: 'owner-1', personaId: 'bot', worldId: 'world:default' };
const KEY = scopeKey(SCOPE);
const SLOT_ID = 'slot-fence';
const SOURCE_MD = `# 围栏测试\n\n${Array.from({ length: 10 }, (_, index) => `第${index}段：` + '潮水在傍晚退去。'.repeat(10)).join('\n\n')}\n`;
const T0 = Date.UTC(2026, 9, 30, 4, 0, 0);

const say = value => process.stdout.write(`${JSON.stringify(value)}\n`);

// One composed handler table for dispatch *and* for the recovery replay, so the replayed state
// can be compared with the live state table by table. `events.mjs` routes every `autonomy/*`
// kind to a single consumer, so the two reducers are composed here exactly like `p2.mjs` does.
const PLANNER_KINDS = new Set(['autonomy/plan-committed', 'autonomy/plan-slot', 'autonomy/opportunity', 'autonomy/interest']);
const ACTIVITY_KINDS = new Set(['autonomy/activity', 'autonomy/receipt']);
function autonomyHandler({ db, event, slice, now }) {
  if (PLANNER_KINDS.has(event.kind)) return applyPlanEvent({ db, event, slice, now });
  if (ACTIVITY_KINDS.has(event.kind)) return applyActivityEvent({ db, event, slice, now });
  throw new RuntimeError('invalid-payload', `unknown autonomy event kind: ${event.kind}`);
}
const HANDLERS = { autonomy: autonomyHandler };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function ports() {
  return {
    async readFile({ path: file }) {
      try { return { ok: true, text: fs.readFileSync(file, 'utf8') }; } catch { return { ok: false }; }
    },
    async writeFile({ path: file, text }) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text, 'utf8');
      return { ok: true, bytes: Buffer.byteLength(text, 'utf8') };
    },
    async fetchPage() { return { ok: false, status: 0 }; },
  };
}

function config() {
  return {
    p2: {
      planning: { enabled: true },
      activities: { enabled: true, paused: false, chunkUnits: 200, maxUnitsPerStep: 4000, maxSourceBytes: 200000, maxTotalUnits: 200000, maxExcerptChars: 4000, draftsDir: 'drafts', defaultReality: '' },
      autonomy: { allowedSources: [] },
    },
  };
}

function open() {
  const file = path.join(ROOT, 'home/companion/companion-runtime.db');
  const db = openRuntimeDb({ file, now: () => Date.now() });
  db.migrate?.();
  return db;
}

function activitiesFor(db, generation) {
  const workspace = path.join(ROOT, 'home/companion/works');
  fs.mkdirSync(path.join(workspace, 'shelf'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'shelf/tide.md'), SOURCE_MD, 'utf8');
  return createActivities({
    db, config: config(), clock: () => Date.now(), owner: `${process.pid}:fence`, generation,
    dispatch: event => dispatchEvent(db, event, {
      handlers: HANDLERS, generation, requireConsumers: true,
    }),
    ports: ports(), workspace,
  });
}

// The plan is committed through its real reducer, not by inserting rows: `p2_plan_slots` is a
// projection table, so `verifyRecovery` must be able to reproduce it by replaying events.
function planSlot(db, generation) {
  dispatchEvent(db, {
    kind: 'autonomy/plan-committed',
    scope: SCOPE,
    occurredAt: T0,
    payload: {
      at: T0,
      plan: {
        planId: 'plan-fence', day: '2026-10-30', version: 1, timeZone: 'Asia/Shanghai',
        windowStart: Date.UTC(2026, 9, 29, 16, 0, 0), windowEnd: Date.UTC(2026, 9, 30, 16, 0, 0),
        summary: '围栏测试的一天',
        slots: [{
          slotId: SLOT_ID, kind: 'activity', activity: 'read', title: '读潮汐',
          startAt: T0, endAt: T0 + 3600000, flexibility: 'soft', intent: '', targetRef: 'shelf/tide.md',
          reality: 'actual_tool_activity',
        }],
      },
    },
  }, { handlers: HANDLERS, generation, requireConsumers: true });
}

function progressEvents(db) {
  // A progress event is phase:'progress'; the activity's start is a different fact and must
  // not be counted as consumed work.
  return db.all(`SELECT event_id, occurred_at FROM domain_events
                 WHERE kind = 'autonomy/activity' AND scope = ? AND payload LIKE '%"phase":"progress"%'
                 ORDER BY seq`, KEY);
}

function stepReceipts(db, activityId) {
  return db.all("SELECT receipt_id, consumed_from, consumed_to FROM p2_activity_receipts WHERE activity_id = ? AND operation = 'step' ORDER BY consumed_from", activityId);
}

function activityRow(db) {
  return db.get('SELECT * FROM p2_activities WHERE scope = ?', KEY);
}

// ------------------------------------------------------------------ parked / taker

const SENTINEL = () => path.join(ROOT, 'sentinel');

async function waitForSentinel(deadlineMs = 30000) {
  const at = Date.now() + deadlineMs;
  while (Date.now() < at) {
    if (fs.existsSync(SENTINEL())) return true;
    await sleep(25);
  }
  return false;
}

async function parked() {
  const db = open();
  const owner = `${process.pid}:fence`;
  const generation = `gen-${process.pid}`;
  // Short TTL on purpose: the takeover has to happen *while this process is parked*.
  const lease = db.acquireLease({ owner, generation, ttlMs: 5000 });
  if (!lease.ok) { say({ event: 'parked-no-lease', lease }); process.exit(4); }
  planSlot(db, generation);
  // Renew while we start the operation: the lease must not expire *before* we reach the port. A fixed
  // short TTL was racing the store, which clamps it to at least one second anyway.
  let renewing = true;
  const renew = (async () => {
    while (renewing) {
      try { db.heartbeatLease({ owner, generation, ttlMs: 5000 }); } catch { /* reported below */ }
      await sleep(100);
    }
  })();
  const starter = activitiesFor(db, generation);
  const started = await starter.start({ slotId: SLOT_ID, kind: 'read' });
  const activityId = started.activityId;

  // A port that parks: the operation has already passed `assertRunGate()` by the time we get here.
  const slow = {
    ...ports(),
    async readFile({ path: file }) {
      say({ event: 'step-parked', generation, activityId });
      // Now stop renewing and let the lease really expire: from here the takeover is not a race, it is
      // the only correct outcome.
      renewing = false;
      await renew;
      say({ event: 'lease-let-go', generation });
      const arrived = await waitForSentinel();
      say({ event: 'step-resumed', arrived });
      try { return { ok: true, text: fs.readFileSync(file, 'utf8') }; } catch { return { ok: false }; }
    },
  };
  const activities = createActivities({
    db, config: config(), clock: () => Date.now(), owner, generation,
    dispatch: event => dispatchEvent(db, event, { handlers: HANDLERS, generation, requireConsumers: true }),
    ports: slow, workspace: path.join(ROOT, 'home/companion/works'),
  });
  const before = Number(activityRow(db)?.consumed_prefix ?? -1);
  let outcome;
  try {
    await activities.step({ activityId, units: 200 });
    outcome = { ok: true };
  } catch (error) {
    outcome = { ok: false, code: error?.code ?? 'unknown', name: error?.name ?? '' };
  }
  const after = Number(activityRow(db)?.consumed_prefix ?? -1);
  say({ event: 'commit-attempt', generation, ...outcome, consumedBefore: before, consumedAfter: after });
  try { db.close(); } catch { /* closed */ }
  process.exit(0);
}

async function taker() {
  const db = open();
  const owner = `${process.pid}:taker`;
  const generation = `gen-${process.pid}-taker`;
  const deadline = Date.now() + 30000;
  let lease = null;
  while (Date.now() < deadline) {
    lease = db.acquireLease({ owner, generation, ttlMs: 60000 });
    if (lease.ok) break;
    await sleep(25);
  }
  if (!lease?.ok) { say({ event: 'taker-failed', lease }); process.exit(5); }
  say({ event: 'took-over', generation, holder: { owner: lease.owner ?? owner } });
  // The barrier: hold the lease by **renewing** it (the production path), and report a renewal that
  // fails instead of ignoring it.
  const stop = path.join(ROOT, 'taker-stop');
  const until = Date.now() + 60000;
  let renewals = 0;
  let renewFailures = 0;
  while (Date.now() < until && !fs.existsSync(stop)) {
    const renewed = db.heartbeatLease({ owner, generation, ttlMs: 60000 });
    if (renewed === true) renewals += 1;
    else renewFailures += 1;
    await sleep(50);
  }
  say({ event: 'taker-renewals', renewals, renewFailures });
  say({ event: 'taker-done', generation });
  try { db.close(); } catch { /* closed */ }
  process.exit(0);
}

// ------------------------------------------------------------------ stale

async function staleWrite() {
// `P2_FENCE_GENERATION` is the generation the caller wants to impersonate. No lease is taken:
// the point is that the **store** refuses the write, not that this script checks politely.
const db = open();
const gen = String(process.env.P2_FENCE_GENERATION || '');
const activity = activityRow(db);
const consumedBefore = Number(activityRow(db)?.consumed_prefix ?? -1);
let outcome = null;
try {
  const activities = activitiesFor(db, gen);
  await activities.step({ activityId: activity.activity_id, units: 200 });
  outcome = { ok: true };
} catch (error) {
  outcome = { ok: false, code: error?.code ?? 'unknown' };
}
say({ event: 'stale-write', generation: gen, ...outcome, consumedBefore, consumedAfter: Number(activityRow(db)?.consumed_prefix ?? -1) });
try { db.close(); } catch { /* closed */ }
process.exit(0);
}

// ------------------------------------------------------------------ hold

async function hold() {
  const db = open();
  const owner = `${process.pid}:fence`;
  const generation = `gen-${process.pid}`;
  const lease = db.acquireLease({ owner, generation, ttlMs: 15000 });
  if (!lease.ok) { say({ event: 'lease-refused', owner, generation }); process.exit(2); }
  planSlot(db, generation);
  const activities = activitiesFor(db, generation);
  const started = await activities.start({ slotId: SLOT_ID, kind: 'read' });
  const stepped = await activities.step({ activityId: started.activityId, units: 200 });
  say({
    event: 'ready', pid: process.pid, owner, generation, activityId: started.activityId,
    consumed: stepped.consumedPrefix, sourceHash: stepped.sourceHashPrefix,
  });
  // Hold the lease until the parent kills us. The heartbeat must keep this process *alive*
  // (an unref'd timer would let it exit and turn the crash case into a clean handover), and we
  // never release on the way out: a killed writer is exactly what the fence has to survive.
  setInterval(() => { try { db.heartbeatLease({ owner, generation, ttlMs: 15000 }); } catch { /* dying */ } }, 200);
  await new Promise(() => {});
}

// --------------------------------------------------------------------- worker

async function worker() {
  const db = open();
  const owner = `${process.pid}:fence`;
  const generation = `gen-${process.pid}`;
  const first = db.acquireLease({ owner, generation, ttlMs: 15000 });
  const activity = activityRow(db);
  say({
    event: 'first-attempt', ok: first.ok === true,
    holder: first.ok ? null : { owner: first.owner, generation: first.generation },
  });
  if (first.ok) {
    // A live holder means the runtime would never have mounted us as the writer.
    say({ event: 'unexpected-writer', generation });
    process.exit(3);
  }
  // The writer role is held by someone else, so a progress write must be refused *by the
  // store*, not by a polite check in this script.
  let refused = null;
  try {
    const activities = activitiesFor(db, generation);
    await activities.step({ activityId: activity.activity_id, units: 200 });
    refused = { ok: true };
  } catch (error) {
    refused = { ok: false, code: error?.code ?? 'unknown', name: error?.name ?? '' };
  }
  say({ event: 'write-attempt', ...refused, consumed: Number(activityRow(db)?.consumed_prefix ?? -1) });

  // Wait for the holder to die, then take over through `acquireLease` — the same path the
  // runtime uses at startup. Bounded, and driven by a real condition, not a fixed sleep.
  const deadline = Date.now() + 20000;
  let takeover = null;
  while (Date.now() < deadline) {
    takeover = db.acquireLease({ owner, generation, ttlMs: 15000 });
    if (takeover.ok) break;
    await sleep(50);
  }
  if (!takeover?.ok) { say({ event: 'takeover-failed', holder: takeover }); process.exit(4); }
  say({ event: 'took-over', generation, previousGeneration: takeover.generation ?? null });

  const activities = activitiesFor(db, generation);
  const row = activityRow(db);
  const continued = await activities.step({ activityId: row.activity_id, units: 200 });
  const events = progressEvents(db);
  const receipts = stepReceipts(db, row.activity_id);
  const recovery = verifyRecovery(db, { scopeKey: KEY, handlers: HANDLERS });
  say({
    event: 'done', generation, activityId: row.activity_id,
    consumedBefore: Number(row.consumed_prefix), consumedAfter: continued.consumedPrefix,
    continuedFrom: continued.consumed.from, continuedTo: continued.consumed.to,
    progressEvents: events.length,
    receipts: receipts.map(receipt => ({ id: receipt.receipt_id, from: Number(receipt.consumed_from), to: Number(receipt.consumed_to) })),
    recovery: { ok: recovery.ok, mismatches: recovery.mismatches.length, replayed: recovery.replayed,
      kinds: recovery.mismatches.map(item => item.kind), detail: recovery.mismatches.slice(0, 2) },
    eventIds: events.map(event => event.event_id),
    totalEvents: listEvents(db, { scopeKey: KEY, limit: 100000 }).length,
  });
  db.releaseLease(generation, owner);
  process.exit(0);
}

if (MODE === 'hold') await hold();
else if (MODE === 'stale') await staleWrite();
else if (MODE === 'parked') await parked();
else if (MODE === 'taker') await taker();
else await worker();
