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
import { parseScope, scopeKey as scopeKeyOf } from '../lib/scope.mjs';
import { RuntimeError } from '../lib/errors.mjs';

// P1-4 (round-3 review): the capability gate must cover the **claim** path, not only the pump.
//
// The gate was first added only to `startDueActivities()`. Reproduced consequence (lead's probe
// `probe-hb3b.mjs`, against head d9c9bcc): with `dispatchEnabled:true` and a provider that can
// never run, `claimSlotForHeartbeat()` still answered `ok:true`, the slot moved `planned → started`,
// the pump (correctly) started nothing, the window closed, and the missed sweep filed the slot as
// `{operation:'missed', code:'window-closed'}` **and** called `onMissed` with
// `reason:'window-closed'`. That is a false fact: the planner reads it tomorrow as "the character
// planned something and did not do it", when the truth is "this build cannot do that at all".
//
// Three properties are pinned here:
//   1. a not-ready capability slot is not *offered* to the heartbeat and is not *claimable* either
//      (two independent defences: the due query and the claim itself);
//   2. when its window closes anyway, it is retired with `detail:'capability-unavailable'`, **no**
//      `missed` receipt and **no** `onMissed` fact — a skip is not a failure;
//   3. a ready provider still claims and still starts (the fix is a gate, not a permanent off).
//
// Real P2 controller, real reducers, real SQLite in a temp dir; the provider port is a stub and
// no network, model, or Bilibili account is involved.

const T0 = Date.UTC(2026, 10, 14, 4, 0, 0);
const HOUR = 3600_000;
const SCOPE = Object.freeze({ userId: 'owner-1', personaId: 'bot', worldId: 'world:default' });
const KEY = scopeKeyOf(SCOPE);
const TTL = 30 * 24 * HOUR;

function tempRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-bili-claim-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });
  return dir;
}

function configWith() {
  return {
    enabled: true,
    mode: 'active',
    timeZone: 'Asia/Shanghai',
    leaseTtlMs: TTL,
    agenda: { enabled: false },
    heartbeat: { enabled: true, pollIntervalMs: 60000, jitterMs: 0, maxDispatchPerCycle: 1, maxAttempts: 3 },
    p2: {
      planning: { enabled: false, paused: false },
      activities: {
        enabled: true, dispatchEnabled: true, paused: false,
        chunkUnits: 1200, maxUnitsPerStep: 4000, maxSourceBytes: 200000,
        maxTotalUnits: 200000, maxExcerptChars: 4000,
      },
      budget: { maxRequestsPerDay: 64, maxInputTokensPerDay: 160000, maxOutputTokensPerDay: 24000, maxConcurrent: 2 },
      autonomy: { allowedSources: [], scopeAcknowledgedAt: T0 },
      share: { enabled: false, maxPending: 5 },
    },
  };
}

function seedPlan(db) {
  db.run(`INSERT INTO p2_plans (plan_id, scope, day, version, status, time_zone, window_start, window_end, summary, source_run_id, supersedes, created_at, committed_at)
          VALUES ('plan-1', ?, '2026-11-14', 1, 'committed', 'Asia/Shanghai', ?, ?, '', '', '', ?, ?)`,
  KEY, T0 - 6 * HOUR, T0 + 18 * HOUR, T0, T0);
}

function seedSlot(db, {
  slotId, startAt = T0 - HOUR, endAt = T0 + HOUR, activity = 'bilibili', targetRef = 'bilibili:duty',
} = {}) {
  db.run(`INSERT INTO p2_plan_slots (slot_id, plan_id, scope, day, start_at, end_at, kind, activity, title, detail,
            flexibility, intent, target_ref, status, locked, created_at, updated_at)
          VALUES (?, 'plan-1', ?, '2026-11-14', ?, ?, 'activity', ?, '槽位', '{"reality":"actual_tool_activity"}', 'soft', '', ?, 'planned', 0, ?, ?)`,
  slotId, KEY, startAt, endAt, activity, targetRef, T0, T0);
}

/**
 * A real P2 controller over a temporary database. `providerReady:false` means no `runBilibili`
 * port is injected at all — the shipped state of an installation whose `dsh-bili-scroll` copy has
 * no provider publish code.
 */
function makeWorld(t, { providerReady = false } = {}) {
  const dir = tempRoot(t);
  const db = openRuntimeDb({ file: path.join(dir, 'companion-runtime.db'), now: () => T0 });
  t.after(() => { try { db.close(); } catch { /* already closed */ } });
  const owner = '999999:bili-claim:test';
  const generation = 'gen-claim';
  assert.equal(db.acquireLease({ owner, generation, ttlMs: TTL }).ok, true, 'the test writer holds the lease');
  db.commitProjection({ scope: KEY, generation, payload: {}, updatedAt: T0 });
  fs.mkdirSync(path.join(dir, 'works', 'sources'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'works', 'sources', 'note.md'), '# 海风\n\n' + '海风把纸吹得作响。'.repeat(30), 'utf8');

  const handlers = {
    autonomy: (args) => (args.event.kind === 'autonomy/receipt' || args.event.kind === 'autonomy/activity'
      ? applyActivityEvent(args)
      : applyPlanEvent(args)),
  };
  const emit = (input = {}) => {
    const scope = input.scope ?? parseScope(input.scopeKey);
    if (!scope) throw new RuntimeError('unbound', 'no persisted scope');
    db.assertLeaseHeld({ owner, generation, at: T0 });
    const { scopeKey: _drop, ...rest } = input;
    const outcome = dispatchEvent(db, { ...rest, scope }, { handlers, generation, owner, requireConsumers: true });
    const failure = outcome.results.find(result => result.error);
    if (outcome.rejected) throw new RuntimeError(failure?.code ?? 'event-rejected', failure?.error ?? 'rejected');
    if (failure) throw new RuntimeError(failure.code ?? 'consumer-failed', failure.error ?? 'consumer failed');
    return { ok: true, eventId: outcome.event.eventId, inserted: outcome.inserted, seq: outcome.seq };
  };
  const ports = {
    readFile({ path: file }) { try { return { ok: true, text: fs.readFileSync(file, 'utf8') }; } catch { return { ok: false, code: 'source-invalid' }; } },
    writeFile() { return { ok: false, code: 'write-unavailable' }; },
    fetchPage() { return { ok: false, code: 'source-invalid' }; },
  };
  if (providerReady) {
    const run = async () => ({ status: 'completed', evidence: [] });
    run.available = () => true;
    ports.runBilibili = run;
  }
  const notes = [];
  const missedFacts = [];
  const p2 = createP2({
    db, config: configWith(), clock: () => T0, owner, generation,
    getMode: () => 'active', isActive: () => true, emit, ports,
    options: {
      artifactRoot: path.join(dir, 'works'),
      onError: (code, detail) => notes.push({ code, detail }),
      // The "the planned thing did not happen" fact the pump writes for a real miss. Recording it
      // here is how the test proves a capability skip does **not** become that fact.
      onMissed: input => { missedFacts.push(input); return { ok: true }; },
    },
  });
  return { db, p2, notes, missedFacts, dir };
}

const slotStatus = (db, slotId) => db.get('SELECT status FROM p2_plan_slots WHERE slot_id = ?', slotId)?.status ?? '';
const slotDetail = (db, slotId) => {
  const row = db.get("SELECT payload FROM domain_events WHERE kind = 'autonomy/plan-slot' AND json_extract(payload, '$.slotId') = ? ORDER BY seq DESC", slotId);
  return row ? String(JSON.parse(row.payload).detail ?? '') : '';
};
const activityRows = db => db.all('SELECT kind, plan_slot_id, status FROM p2_activities ORDER BY created_at, activity_id');
const missedReceipts = db => db.all("SELECT activity_id, operation, code FROM p2_activity_receipts WHERE operation = 'missed'");

test('P1-4：provider 未就绪时，心跳既看不到也不认领 B 站槽（槽留在 planned）', async t => {
  const world = makeWorld(t, { providerReady: false });
  seedPlan(world.db);
  seedSlot(world.db, { slotId: 'slot-bili' });
  seedSlot(world.db, { slotId: 'slot-read', activity: 'read', targetRef: 'sources/note.md', startAt: T0 - HOUR + 60_000 });

  // 1. The due query itself excludes the not-ready capability — otherwise the heartbeat wastes its
  //    per-beat window on a slot the pump will refuse.
  const offered = world.p2.dueSlotsForHeartbeat({ scopeKey: KEY, now: T0, limit: 2 });
  assert.equal(offered.deferred, null, JSON.stringify(offered));
  assert.deepEqual(offered.slots.map(slot => slot.slotId), ['slot-read'], 'only the executable slot is offered');
  assert.equal(offered.skipped, 1, 'the excluded duty slot is reported as one named number, not silently dropped');

  // 2. The claim hook refuses it even if a host reaches it directly (defence in depth): a claim
  //    would flip the slot to `started` and orphan it until the window closed.
  const refused = world.p2.claimSlotForHeartbeat({ scopeKey: KEY, slotId: 'slot-bili', planId: 'plan-1', day: '2026-11-14', scheduledAt: T0 - HOUR });
  assert.equal(refused.ok, false, JSON.stringify(refused));
  assert.equal(refused.code, 'capability-unavailable');
  assert.equal(slotStatus(world.db, 'slot-bili'), 'planned', 'no claim was written');
  assert.equal(world.db.get("SELECT COUNT(*) AS n FROM domain_events WHERE kind = 'autonomy/plan-slot'")?.n, 0,
    'and no plan-slot event exists at all');

  // 3. The pump leaves the same slot alone while its window is still open — and still starts the
  //    readable slot that shares the beat, so the gate skips one capability, not the whole tick.
  const pumped = await world.p2.pump({ now: T0 });
  assert.equal(pumped.ok, true, JSON.stringify(pumped));
  const rows = activityRows(world.db);
  assert.equal(rows.length, 1, `only the executable slot starts: ${JSON.stringify(rows)}`);
  assert.equal(rows[0].plan_slot_id, 'slot-read', 'the Bilibili slot was not started');
  assert.equal(rows[0].kind, 'read');
  assert.equal(slotStatus(world.db, 'slot-bili'), 'planned');
  assert.equal(missedReceipts(world.db).length, 0, 'an open window is not a miss');
  assert.equal(world.missedFacts.length, 0, 'and no missed fact was written');
});

test('P1-4：窗口关掉时按 capability-unavailable 退役，不写 missed 收据、不报 missed 事实', async t => {
  const world = makeWorld(t, { providerReady: false });
  seedPlan(world.db);
  // The window is already in the past: this is exactly the state the lead's probe ended in, except
  // that nothing was claimed this time.
  seedSlot(world.db, { slotId: 'slot-bili', startAt: T0 - 3 * HOUR, endAt: T0 - HOUR });
  // A read slot whose window also closed: the *real* miss must keep its old semantics, so the two
  // cases are distinguished inside one sweep.
  seedSlot(world.db, { slotId: 'slot-read', activity: 'read', targetRef: 'sources/note.md', startAt: T0 - 3 * HOUR, endAt: T0 - HOUR });

  const pumped = await world.p2.pump({ now: T0 });
  assert.equal(pumped.ok, true, JSON.stringify(pumped));
  assert.equal(activityRows(world.db).length, 0);

  assert.equal(slotStatus(world.db, 'slot-bili'), 'expired', 'the closed window is still retired, not left open');
  assert.equal(slotDetail(world.db, 'slot-bili'), 'capability-unavailable', 'and retired under its own name');

  assert.equal(slotStatus(world.db, 'slot-read'), 'expired');
  assert.equal(slotDetail(world.db, 'slot-read'), 'missed', 'a real miss keeps the frozen detail value');

  const receipts = missedReceipts(world.db);
  assert.equal(receipts.length, 1, `exactly the real miss files a receipt: ${JSON.stringify(receipts)}`);
  // `activity_id` is a content hash, not the slot id: identify the receipt by the fact it belongs
  // to the readable slot, i.e. it is the one whose id matches the missed fact's slot.
  assert.equal(world.missedFacts.length, 1, 'and exactly one missed fact is reported');
  assert.equal(world.missedFacts[0].slotId, 'slot-read', 'never the capability slot');
  assert.equal(world.missedFacts[0].reason, 'window-closed');

  const skipped = world.notes.filter(note => note.code === 'p2-slot-expired-capability-unavailable');
  assert.equal(skipped.length, 1, 'the capability retirement is reported by name');
  assert.match(String(skipped[0].detail), /slot-bili/);
});

test('P1-4 回归：provider 就绪时心跳照常认领、泵照常 start（闸门不是永久关闭）', async t => {
  const world = makeWorld(t, { providerReady: true });
  seedPlan(world.db);
  seedSlot(world.db, { slotId: 'slot-bili' });

  const offered = world.p2.dueSlotsForHeartbeat({ scopeKey: KEY, now: T0, limit: 1 });
  assert.equal(offered.skipped, 0, 'a ready provider excludes nothing');
  assert.deepEqual(offered.slots.map(slot => slot.slotId), ['slot-bili']);

  const claimed = world.p2.claimSlotForHeartbeat({ scopeKey: KEY, slotId: 'slot-bili', planId: 'plan-1', day: '2026-11-14', scheduledAt: T0 - HOUR });
  assert.equal(claimed.ok, true, JSON.stringify(claimed));
  assert.equal(claimed.inserted, true);
  assert.equal(slotStatus(world.db, 'slot-bili'), 'started', 'the claim really moved the slot');

  const pumped = await world.p2.pump({ now: T0 });
  assert.equal(pumped.ok, true, JSON.stringify(pumped));
  const rows = activityRows(world.db);
  assert.equal(rows.length, 1, `the pump turned the claim into one activity: ${JSON.stringify(rows)}`);
  assert.equal(rows[0].kind, 'bilibili');
  assert.equal(rows[0].plan_slot_id, 'slot-bili');
  assert.equal(world.notes.filter(note => note.code === 'p2-slot-expired-capability-unavailable').length, 0,
    'a ready provider produces no capability note');
});
