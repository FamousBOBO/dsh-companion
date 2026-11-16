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

// The B 站 gate must not starve the other three kinds.
//
// Before this, `startDueActivities()` selected its due window with
// `ORDER BY start_at ASC LIMIT 2` and only *then* skipped unavailable Bilibili slots in the
// loop. Two due duty slots therefore filled the whole window and the beat started nothing at
// all — read/explore/write lost the beat to two activities that could never run. The gate now
// excludes them in the same SQL, so the window counts slots that can actually start.
//
// Everything here is a real P2 controller over a temporary SQLite file: no model, no network,
// no Bilibili provider, no disk outside the fixture.

const T0 = Date.UTC(2026, 10, 14, 4, 0, 0);
const HOUR = 3600_000;
const SCOPE = Object.freeze({ userId: 'owner-1', personaId: 'bot', worldId: 'world:default' });
const KEY = scopeKeyOf(SCOPE);
const TTL = 30 * 24 * HOUR;

function tempRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-bili-order-'));
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
    heartbeat: { enabled: true, pollIntervalMs: 60000, jitterMs: 0, maxDispatchPerCycle: 1 },
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

function seedPlan(db, { planId = 'plan-1', day = '2026-11-14' } = {}) {
  db.run(`INSERT INTO p2_plans (plan_id, scope, day, version, status, time_zone, window_start, window_end, summary, source_run_id, supersedes, created_at, committed_at)
          VALUES (?, ?, ?, 1, 'committed', 'Asia/Shanghai', ?, ?, '', '', '', ?, ?)`,
  planId, KEY, day, T0 - 6 * HOUR, T0 + 18 * HOUR, T0, T0);
}

function seedSlot(db, {
  slotId, planId = 'plan-1', day = '2026-11-14', startAt = T0 - HOUR, endAt = T0 + HOUR,
  activity = 'read', targetRef = 'sources/note.md', status = 'planned',
} = {}) {
  db.run(`INSERT INTO p2_plan_slots (slot_id, plan_id, scope, day, start_at, end_at, kind, activity, title, detail,
            flexibility, intent, target_ref, status, locked, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'activity', ?, '槽位', '{"reality":"actual_tool_activity"}', 'soft', '', ?, ?, 0, ?, ?)`,
  slotId, planId, KEY, day, startAt, endAt, activity, targetRef, status, T0, T0);
}

/**
 * A real P2 controller over a temporary database.
 * `providerReady: false` simply means no `runBilibili` port was injected — exactly the state of
 * an installation whose `dsh-bili-scroll` copy has no provider publish code.
 */
function makeWorld(t, { providerReady = false } = {}) {
  const dir = tempRoot(t);
  const db = openRuntimeDb({ file: path.join(dir, 'companion-runtime.db'), now: () => T0 });
  t.after(() => { try { db.close(); } catch { /* already closed */ } });
  const owner = '999999:bili-order:test';
  const generation = 'gen-order';
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
  const p2 = createP2({
    db, config: configWith(), clock: () => T0, owner, generation,
    getMode: () => 'active', isActive: () => true, emit, ports,
    options: { artifactRoot: path.join(dir, 'works'), onError: (code, detail) => notes.push({ code, detail }) },
  });
  return { db, p2, notes, dir };
}

const activityRows = db => db.all('SELECT kind, plan_slot_id, status FROM p2_activities ORDER BY created_at, activity_id');

test('B 站未就绪：两个到点的 duty slot 不会挤掉同一窗口里的 read', async t => {
  const world = makeWorld(t, { providerReady: false });
  seedPlan(world.db);
  // Two duty slots due first (the column `start_at` orders them in front), one read slot right
  // behind them. The old two-row window contained only the two duty slots.
  seedSlot(world.db, { slotId: 'slot-bili-1', activity: 'bilibili', targetRef: 'bilibili:duty', startAt: T0 - HOUR, endAt: T0 + 2 * HOUR });
  seedSlot(world.db, { slotId: 'slot-bili-2', activity: 'bilibili', targetRef: 'bilibili:duty', startAt: T0 - HOUR + 60_000, endAt: T0 + 2 * HOUR });
  seedSlot(world.db, { slotId: 'slot-read', activity: 'read', targetRef: 'sources/note.md', startAt: T0 - HOUR + 120_000, endAt: T0 + 2 * HOUR });

  const pumped = await world.p2.pump({ now: T0 });
  const rows = activityRows(world.db);
  assert.equal(rows.length, 1, `exactly the readable slot starts: ${JSON.stringify(rows)}`);
  assert.equal(rows[0].kind, 'read', 'the duty slots do not consume the beat');
  assert.equal(rows[0].plan_slot_id, 'slot-read');

  // The skip is still reported: "nothing started" is not the same fact as "the provider is not ready".
  const skipped = world.notes.filter(note => note.code === 'p2-activity-start-bilibili-provider-not-ready');
  assert.equal(skipped.length, 1, 'one named reason per beat, not one per slot');
  assert.match(String(skipped[0].detail), /2 due Bilibili slot\(s\)/);

  // The duty slots stay `planned`: a skip is not a claim, so a later beat may still run them once
  // the provider really becomes ready.
  const statuses = world.db.all("SELECT slot_id, status FROM p2_plan_slots WHERE activity = 'bilibili' ORDER BY slot_id");
  assert.deepEqual(statuses.map(row => row.status), ['planned', 'planned']);
});

test('B 站就绪：同样的三个槽位，duty 照常 start（闸门不是永久关闭）', async t => {
  const world = makeWorld(t, { providerReady: true });
  seedPlan(world.db);
  seedSlot(world.db, { slotId: 'slot-bili-1', activity: 'bilibili', targetRef: 'bilibili:duty', startAt: T0 - HOUR, endAt: T0 + 2 * HOUR });
  seedSlot(world.db, { slotId: 'slot-read', activity: 'read', targetRef: 'sources/note.md', startAt: T0 - HOUR + 60_000, endAt: T0 + 2 * HOUR });

  const pumped = await world.p2.pump({ now: T0 });
  assert.equal(pumped.ok, true, JSON.stringify(pumped));
  const rows = activityRows(world.db);
  assert.equal(rows.length, 1, 'the read activity stays single-flight');
  assert.equal(rows[0].plan_slot_id, 'slot-bili-1', 'with a ready provider the earliest slot wins again');
  assert.equal(world.notes.filter(note => note.code === 'p2-activity-start-bilibili-provider-not-ready').length, 0,
    'a ready provider produces no skip note');
});
