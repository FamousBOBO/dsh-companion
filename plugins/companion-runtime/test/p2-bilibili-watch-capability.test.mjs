import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mountRuntime } from '../index.mjs';
import { openRuntimeDb } from '../lib/db.mjs';

// Round-4 review N1 + N2: the dry watch must not contradict itself, and it must not promise a
// fact the pump will not write.
//
// N1 — `WILL_MISS_SQL` had no capability gate. With **both** windows already closed the watch
// reported every closed slot as `will-miss` with `blockDetail:'the slot window closed without an
// activity; the pump files it as missed'` — including a Bilibili slot that the pump (after P1-4)
// retires as `detail:'capability-unavailable'` with **no** `missed` receipt and **no** `onMissed`.
// `counts.willMiss` was therefore larger than the number of `missed` facts the pump would write.
//
// N2 — `CLAIMED_SQL`/`CLAIMED_COUNT_SQL` had no capability gate either. A slot claimed while the
// provider was ready and left behind in `started` when it went away stayed counted as
// `claimed_awaiting_start`, while `rows[]` (correctly) showed it as `blocked-capability`. Two
// numbers in one payload said different things about the same slot. This state is reachable in
// production exactly at the moment a fix like P1-4 lands.
//
// Both are observation-only fixes: no write path, no new state name (`blocked-capability` is the
// CONTRACT §15.3 state introduced in round 3). Throwaway root + throwaway SQLite, no network, no
// model, no Bilibili account.

const T0 = Date.UTC(2026, 10, 14, 4, 0, 0);
const HOUR = 3600_000;
const TTL = 30 * 24 * HOUR;

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-bili-watch4-'));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });
  fs.mkdirSync(path.join(root, 'home/companion/works/shelf'), { recursive: true });
  fs.writeFileSync(path.join(root, 'home/companion/works/shelf/note.md'), '# 观测\n\n一段用来读的文字。', 'utf8');
  fs.writeFileSync(path.join(root, 'home/companion/identity.json'), JSON.stringify({
    schemaVersion: 1,
    persona: 'bot',
    owner: { id: 'owner-synthetic', displayName: 'o', platform: 'qq' },
    desktop: { mode: 'local-owner', userId: 'owner-synthetic' },
    sessions: {},
  }));
  fs.writeFileSync(path.join(root, 'home/companion/runtime.config.json'), JSON.stringify({
    enabled: true,
    mode: 'active',
    leaseTtlMs: TTL,
    agenda: { enabled: true },
    heartbeat: { enabled: true, pollIntervalMs: 600000, jitterMs: 0, maxDispatchPerCycle: 2, maxAttempts: 3 },
    p2: {
      planning: { enabled: false },
      activities: {
        enabled: true, dispatchEnabled: true, paused: false,
        chunkUnits: 4000, maxUnitsPerStep: 8000, maxSourceBytes: 200000,
        maxTotalUnits: 200000, maxExcerptChars: 1200,
      },
      budget: { maxRequestsPerDay: 64, maxInputTokensPerDay: 160000, maxOutputTokensPerDay: 24000, maxConcurrent: 1, chatPriority: true },
      autonomy: { allowedSources: [] },
      share: { enabled: false },
    },
  }, null, 2));
  return root;
}

function mount(t, root, { clock, providerReady } = {}) {
  const ctx = { tools: { register() {} }, systemPrompt: { section() {} }, on() {}, get() { return undefined; } };
  const identity = { resolve: sessionId => ({ userId: 'owner-synthetic', personaId: 'bot', sessionId }) };
  const p2Ports = {
    readFile: input => {
      try { return { ok: true, text: fs.readFileSync(input.path, 'utf8') }; } catch { return { ok: false }; }
    },
  };
  if (providerReady) {
    const run = async () => ({ status: 'completed', evidence: [] });
    run.available = () => true;
    p2Ports.runBilibili = run;
  }
  const runtime = mountRuntime(ctx, root, {
    now: () => clock.value,
    identity,
    callModel: () => ({ text: '读完一段。', provider: 'stub-provider', model: 'stub-reader', inputTokens: 80, outputTokens: 12 }),
    p2Ports,
  });
  t.after(() => { try { runtime.dispose(); } catch { /* already disposed */ } });
  return runtime;
}

function sideDb(t, root) {
  const db = openRuntimeDb({ file: path.join(root, 'home/companion/companion-runtime.db'), now: () => Date.now() });
  t.after(() => { try { db.close(); } catch { /* already closed */ } });
  return db;
}

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
  slotId, day = '2026-11-14', startAt = T0 - HOUR, endAt = T0 + HOUR,
  activity = 'read', targetRef = 'shelf/note.md', status = 'planned',
} = {}) {
  const scope = scopeKeyOfDb(db);
  db.run(`INSERT OR IGNORE INTO p2_plans (plan_id, scope, day, version, status, time_zone, window_start, window_end, summary, source_run_id, supersedes, created_at, committed_at)
          VALUES ('plan-1', ?, ?, 1, 'committed', 'Asia/Shanghai', ?, ?, '', '', '', ?, ?)`,
  scope, day, startAt - 2 * HOUR, endAt + 2 * HOUR, startAt, startAt);
  db.run(`INSERT INTO p2_plan_slots (slot_id, plan_id, scope, day, start_at, end_at, kind, activity, title, detail,
            flexibility, reality, intent, target_ref, status, locked, created_at, updated_at)
          VALUES (?, 'plan-1', ?, ?, ?, ?, 'activity', ?, '观测用槽', '', 'soft', 'actual_tool_activity', '', ?, ?, 0, ?, ?)`,
  slotId, scope, day, startAt, endAt, activity, targetRef, status, startAt, startAt);
}

const missedReceipts = db => db.all("SELECT activity_id, operation, code FROM p2_activity_receipts WHERE operation = 'missed'");
const slotStatus = (db, slotId) => db.get('SELECT status FROM p2_plan_slots WHERE slot_id = ?', slotId)?.status ?? '';
const slotDetail = (db, slotId) => {
  const row = db.get("SELECT payload FROM domain_events WHERE kind = 'autonomy/plan-slot' AND json_extract(payload, '$.slotId') = ? ORDER BY seq DESC", slotId);
  return row ? String(JSON.parse(row.payload).detail ?? '') : '';
};

test('N1：窗口已关闭且能力未就绪 ⇒ blocked-capability（不是 will-miss），willMiss 只数真 miss', async t => {
  const clock = { value: T0 };
  const root = makeRoot(t);
  const runtime = mount(t, root, { clock, providerReady: false });
  const sessionId = persistScope(runtime);
  const db = sideDb(t, root);
  // Two closed windows in one scope: the Bilibili one the pump will retire as
  // `capability-unavailable`, and the read one the pump will really file as `missed`.
  seedSlot(db, { slotId: 'slot-bili', activity: 'bilibili', targetRef: 'bilibili:duty', startAt: T0 - 6 * HOUR, endAt: T0 - 3 * HOUR });
  seedSlot(db, { slotId: 'slot-read', startAt: T0 - 6 * HOUR, endAt: T0 - 3 * HOUR });

  const watched = runtime.p2DispatchWatch({ sessionId, now: T0 });
  assert.equal(watched.ok, true, JSON.stringify(watched));
  const bili = watched.rows.find(row => row.slotId === 'slot-bili');
  const read = watched.rows.find(row => row.slotId === 'slot-read');

  // The read slot keeps its old meaning: a real miss the pump will write.
  assert.equal(read.state, 'will-miss', JSON.stringify(read));
  assert.equal(read.blockDetail, 'the slot window closed without an activity; the pump files it as missed');

  // The Bilibili slot does not. It is capability-blocked, and its detail must not claim a
  // `missed` fact that the pump will never write.
  assert.equal(bili.state, 'blocked-capability', JSON.stringify(bili));
  assert.equal(bili.blockReason, 'bilibili-provider-not-ready');
  assert.match(bili.blockDetail, /capability-unavailable/);
  assert.doesNotMatch(bili.blockDetail, /files it as missed/);
  assert.equal(bili.expectedBeat, null);
  assert.equal(bili.dueSinceMs, null, 'a closed window has no "due since"');

  // The count is the number of `missed` facts the pump will actually write — one, not two.
  assert.equal(watched.counts.willMiss, 1, JSON.stringify(watched.counts));
  assert.equal(watched.counts.capabilityBlocked, 1);
  assert.equal(watched.counts.claimable, 0);

  // …and the pump then really writes exactly one missed receipt.
  await runtime.pumpActivities({ now: T0 });
  assert.equal(slotStatus(db, 'slot-bili'), 'expired');
  assert.equal(slotDetail(db, 'slot-bili'), 'capability-unavailable');
  assert.equal(slotStatus(db, 'slot-read'), 'expired');
  assert.equal(slotDetail(db, 'slot-read'), 'missed');
  assert.equal(missedReceipts(db).length, 1, JSON.stringify(missedReceipts(db)));

  // After the sweep both slots are history: the watch has nothing left to promise either way.
  const after = runtime.p2DispatchWatch({ sessionId, now: T0 });
  assert.equal(after.rows.length, 0, JSON.stringify(after.rows));
  assert.equal(after.counts.willMiss, 0);
  assert.equal(after.counts.capabilityBlocked, 0);
});

test('N1 回归：provider 就绪时同一批已关闭窗口的槽位都回到 will-miss', async t => {
  const clock = { value: T0 };
  const root = makeRoot(t);
  const runtime = mount(t, root, { clock, providerReady: true });
  const sessionId = persistScope(runtime);
  const db = sideDb(t, root);
  seedSlot(db, { slotId: 'slot-bili', activity: 'bilibili', targetRef: 'bilibili:duty', startAt: T0 - 6 * HOUR, endAt: T0 - 3 * HOUR });
  seedSlot(db, { slotId: 'slot-read', startAt: T0 - 6 * HOUR, endAt: T0 - 3 * HOUR });

  const watched = runtime.p2DispatchWatch({ sessionId, now: T0 });
  assert.equal(watched.counts.willMiss, 2, JSON.stringify(watched.rows));
  assert.equal(watched.counts.capabilityBlocked, 0);
  for (const row of watched.rows) assert.equal(row.state, 'will-miss', JSON.stringify(row));
});

test('N2：provider 变未就绪后遗留的 started 槽不再计入 claimed_awaiting_start，两个数字不再打架', async t => {
  const clock = { value: T0 };
  const root = makeRoot(t);
  // Ready long enough to claim, then the provider goes away: the honest way to build that state
  // through the public API is to claim with a ready provider and then mount a runtime whose port
  // reports not-ready — which is exactly what a fix landing on a live installation looks like.
  const readyRoot = root;
  fs.writeFileSync(path.join(readyRoot, 'home/companion/runtime.config.json'), JSON.stringify({
    enabled: true,
    mode: 'active',
    leaseTtlMs: TTL,
    agenda: { enabled: true },
    heartbeat: { enabled: true, pollIntervalMs: 600000, jitterMs: 0, maxDispatchPerCycle: 1, maxAttempts: 3 },
    p2: {
      planning: { enabled: false },
      activities: {
        enabled: true, dispatchEnabled: true, paused: false,
        chunkUnits: 4000, maxUnitsPerStep: 8000, maxSourceBytes: 200000,
        maxTotalUnits: 200000, maxExcerptChars: 1200,
      },
      budget: { maxRequestsPerDay: 64, maxInputTokensPerDay: 160000, maxOutputTokensPerDay: 24000, maxConcurrent: 1, chatPriority: true },
      autonomy: { allowedSources: [] },
      share: { enabled: false },
    },
  }, null, 2));

  const runtimeA = mount(t, root, { clock, providerReady: true });
  const sessionId = persistScope(runtimeA);
  const db = sideDb(t, root);
  seedSlot(db, { slotId: 'slot-bili', activity: 'bilibili', targetRef: 'bilibili:duty', startAt: T0 - HOUR, endAt: T0 + HOUR });

  const beat = runtimeA.runHeartbeatCycle({ reason: 'test' });
  assert.equal(beat.dispatched, 1, JSON.stringify(beat));
  assert.equal(slotStatus(db, 'slot-bili'), 'started', 'a ready provider really claimed it');
  runtimeA.dispose();

  // The provider is now gone (no `runBilibili` port), and the claim is still in the log — the
  // production state a capability fix inherits.
  const runtimeB = mount(t, root, { clock: { value: T0 + 10 * 60_000 }, providerReady: false });
  const watched = runtimeB.p2DispatchWatch({ sessionId, now: T0 + 10 * 60_000 });
  assert.equal(watched.ok, true, JSON.stringify(watched));

  const row = watched.rows.find(entry => entry.slotId === 'slot-bili');
  assert.equal(row.state, 'blocked-capability', JSON.stringify(row));
  assert.equal(row.claimAgeMs, null, 'the claim is not "waiting for the pump": the pump will never start it');
  assert.equal(watched.counts.awaitingStart, 0, JSON.stringify(watched.counts));

  // The two numbers that used to disagree now agree, and both are honest about the gate.
  assert.equal(watched.metrics.claimed_awaiting_start, 0, JSON.stringify(watched.metrics));
  assert.equal(watched.metrics.claim_age_ms, null);
  assert.equal(watched.metrics.claim_age_source, 'none');
  assert.equal(watched.metrics.capabilityGate, 'bilibili-not-ready');
  assert.equal(watched.metrics.slots_capability_blocked, 1);
  assert.equal(watched.metrics.slots_due, 0, 'a claimed slot is not due for claiming');

  // The claim itself was real, so it is still visible where it belongs: `slots_open` counts it.
  assert.equal(watched.metrics.slots_open, 1);
});

test('N2 回归：provider 就绪时遗留的 started 槽照旧算 awaiting-start（闸门不是把认领吞掉）', async t => {
  const clock = { value: T0 };
  const root = makeRoot(t);
  const runtime = mount(t, root, { clock, providerReady: true });
  const sessionId = persistScope(runtime);
  const db = sideDb(t, root);
  seedSlot(db, { slotId: 'slot-bili', activity: 'bilibili', targetRef: 'bilibili:duty', startAt: T0 - HOUR, endAt: T0 + HOUR });

  const beat = runtime.runHeartbeatCycle({ reason: 'test' });
  assert.equal(beat.dispatched, 1, JSON.stringify(beat));

  const watched = runtime.p2DispatchWatch({ sessionId, now: T0 + 5 * 60_000 });
  assert.equal(watched.counts.awaitingStart, 1, JSON.stringify(watched.rows));
  assert.equal(watched.metrics.claimed_awaiting_start, 1);
  assert.equal(watched.metrics.claim_age_ms, 5 * 60_000, 'the age is measured again, not suppressed by the gate');
  assert.equal(watched.metrics.claim_age_source, 'recorded_at');
  assert.equal(watched.metrics.capabilityGate, 'ready');
  assert.equal(watched.rows.find(entry => entry.slotId === 'slot-bili').state, 'awaiting-start');
});

test('N4：三条查询之间的窗口缺口不许吞行 —— started + 未开启窗口 + 能力未就绪也必须出现在 rows[]', async t => {
  // Round-5 review: after N2 applied the gate to `CLAIMED_SQL`, a `started` Bilibili slot whose
  // window had **not opened yet** vanished from `rows[]` entirely — it is not due
  // (`start_at > now`), not `will-miss` (`end_at > now`) and no longer `awaiting-start`. Three
  // window-bounded queries, one hole between them: `slots_open` said 3, `rows[]` showed 2.
  //
  // Reachability, stated without inflating it: the heartbeat itself only offers slots whose window
  // covers `now`, so it cannot create this state. `claimSlotForHeartbeat()` is looser than that
  // (it has no window check) and a host may reach it directly, which is exactly what this test
  // does. The fix is observation-only: one extra predicate with **no** window filter, so the row
  // list covers every open slot regardless of where the slot sits in time.
  const clock = { value: T0 };
  const root = makeRoot(t);
  const runtime = mount(t, root, { clock, providerReady: false });
  const sessionId = persistScope(runtime);
  const db = sideDb(t, root);
  seedSlot(db, { slotId: 'b-closed', activity: 'bilibili', targetRef: 'bilibili:duty', startAt: T0 - 6 * HOUR, endAt: T0 - 3 * HOUR, status: 'started' });
  seedSlot(db, { slotId: 'b-open', activity: 'bilibili', targetRef: 'bilibili:duty', startAt: T0 - HOUR, endAt: T0 + HOUR, status: 'started' });
  seedSlot(db, { slotId: 'b-future', activity: 'bilibili', targetRef: 'bilibili:duty', startAt: T0 + 3 * HOUR, endAt: T0 + 5 * HOUR, status: 'started' });

  // The claim hook really accepts all three — including the future one. That is the宽松 part of
  // `claimSlotForHeartbeat`, and it is why the hole existed at all.
  for (const slotId of ['b-closed', 'b-open', 'b-future']) {
    assert.equal(slotStatus(db, slotId), 'started', 'the fixture genuinely starts in `started`');
  }

  const watched = runtime.p2DispatchWatch({ sessionId, now: T0 });
  assert.equal(watched.ok, true, JSON.stringify(watched));
  assert.equal(watched.metrics.slots_open, 3, 'three open slots are counted');

  // The property under test: no slot may fall through the gap between the three window-bounded
  // queries, and `put()` must not duplicate one that more than one query found. (Only these three
  // fixtures exist in the scope, so all three must appear — with a larger scope `rows[]` is capped
  // at `3 × limit`, which is a bound, not a completeness promise; see CONTRACT §15.3.)
  const ids = watched.rows.map(row => row.slotId).sort();
  assert.deepEqual(ids, ['b-closed', 'b-future', 'b-open'], `rows[] must cover every open slot: ${JSON.stringify(watched.rows)}`);
  assert.equal(new Set(ids).size, ids.length, 'and exactly once');

  // Each row says which retirement is coming, and none of them pretends to be a `missed`.
  for (const id of ids) {
    const row = watched.rows.find(entry => entry.slotId === id);
    assert.equal(row.state, 'blocked-capability', `${id}: ${JSON.stringify(row)}`);
    assert.equal(row.blockReason, 'bilibili-provider-not-ready');
    assert.equal(row.expectedBeat, null);
    assert.doesNotMatch(row.blockDetail, /files it as missed/);
  }
  const future = watched.rows.find(row => row.slotId === 'b-future');
  assert.match(future.blockDetail, /window has not opened yet/);
  const closed = watched.rows.find(row => row.slotId === 'b-closed');
  assert.match(closed.blockDetail, /capability-unavailable, not as missed/);

  assert.equal(watched.counts.capabilityBlocked, 3, JSON.stringify(watched.counts));
  assert.equal(watched.counts.awaitingStart, 0, 'none of them is still "waiting for the pump"');
  assert.equal(watched.counts.willMiss, 0, 'and none will be filed as missed');


  // The numbers that a due-now metric reports stay due-now: only `b-open` has a window covering
  // `now`, but the gate excludes it from `slots_due` — the measurement was never asked to count
  // history.
  assert.equal(watched.metrics.slots_due, 0, JSON.stringify(watched.metrics));
  assert.equal(watched.metrics.slots_capability_blocked, 1, 'due-now only, not 3');
});

test('N4 回归：provider 就绪时同样三个槽位全部出现（行覆盖不依赖闸门）', async t => {
  const clock = { value: T0 };
  const root = makeRoot(t);
  const runtime = mount(t, root, { clock, providerReady: true });
  const sessionId = persistScope(runtime);
  const db = sideDb(t, root);
  seedSlot(db, { slotId: 'b-closed', activity: 'bilibili', targetRef: 'bilibili:duty', startAt: T0 - 6 * HOUR, endAt: T0 - 3 * HOUR, status: 'started' });
  seedSlot(db, { slotId: 'b-open', activity: 'bilibili', targetRef: 'bilibili:duty', startAt: T0 - HOUR, endAt: T0 + HOUR, status: 'started' });
  seedSlot(db, { slotId: 'b-future', activity: 'bilibili', targetRef: 'bilibili:duty', startAt: T0 + 3 * HOUR, endAt: T0 + 5 * HOUR, status: 'started' });

  const watched = runtime.p2DispatchWatch({ sessionId, now: T0 });
  const ids = watched.rows.map(row => row.slotId).sort();
  assert.deepEqual(ids, ['b-closed', 'b-future', 'b-open'], JSON.stringify(watched.rows));
  // `b-closed` keeps its old `will-miss` verdict; the other two are still awaiting the pump.
  assert.equal(watched.rows.find(row => row.slotId === 'b-closed').state, 'will-miss');
  for (const id of ['b-open', 'b-future']) {
    assert.equal(watched.rows.find(row => row.slotId === id).state, 'awaiting-start', id);
  }
  assert.equal(watched.counts.capabilityBlocked, 0);
  assert.equal(watched.metrics.capabilityGate, 'ready');
});
