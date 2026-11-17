import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mountRuntime } from '../index.mjs';
import { openRuntimeDb } from '../lib/db.mjs';

// P2-6 (round-3 review): the dry watch must not promise a claim the real beat refuses.
//
// Before this, `dispatchWatch` used a copy of the heartbeat's due predicate that **lacked** the
// capability gate, so a Bilibili slot whose provider can never run was reported `state:'claimable'`
// with an `expectedBeat` number — a promise nothing could keep. What an operator saw before
// flipping `p2.activities.dispatchEnabled` on was therefore the reverse of the truth: several
// "claimable" slots, of which the beat would claim only the non-Bilibili ones.
//
// The fix keeps the honest answer instead of hiding the slot: `state:'blocked-capability'`,
// `blockReason:'bilibili-provider-not-ready'`. That name is an **extension** of the frozen
// CONTRACT §15.3 vocabulary, which is why it is documented there next to `claimable` /
// `blocked-effect` / `awaiting-start` / `will-miss` rather than introduced silently here.
//
// Same discipline as the rest of the P2.5 suite: throwaway root, throwaway SQLite file, no network,
// no model, no Bilibili account, no host profile.

const T0 = Date.UTC(2026, 10, 14, 4, 0, 0);
const HOUR = 3600_000;
const TTL = 30 * 24 * HOUR;

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-bili-watch-'));
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

const claims = db => db.all("SELECT payload FROM domain_events WHERE kind = 'autonomy/plan-slot' ORDER BY seq")
  .map(row => JSON.parse(row.payload))
  .filter(payload => payload.to === 'started');

test('P2-6：dry watch 把 provider 未就绪的 B 站槽报成 blocked-capability，而不是 claimable', async t => {
  const clock = { value: T0 };
  const root = makeRoot(t);
  const runtime = mount(t, root, { clock, providerReady: false });
  const sessionId = persistScope(runtime);
  const db = sideDb(t, root);
  // Two slots in one beat: the Bilibili one is earlier, so an un-gated watch would put it first in
  // line and predict the read slot on beat 2.
  seedSlot(db, { slotId: 'slot-bili', activity: 'bilibili', targetRef: 'bilibili:duty', startAt: T0 - 2 * HOUR });
  seedSlot(db, { slotId: 'slot-read', startAt: T0 - HOUR });

  const watched = runtime.p2DispatchWatch({ sessionId, now: T0 });
  assert.equal(watched.ok, true, JSON.stringify(watched));
  assert.deepEqual(watched.blockedBy, [], 'nothing defers this scope: the gate skips one capability, not the beat');
  assert.equal(watched.counts.capabilityBlocked, 1, JSON.stringify(watched.rows));
  assert.equal(watched.counts.claimable, 1, 'only the slot the beat can really claim is claimed claimable');
  assert.equal(watched.counts.beatsToDrain, 1);
  const bili = watched.rows.find(row => row.slotId === 'slot-bili');
  assert.equal(bili.state, 'blocked-capability', JSON.stringify(bili));
  assert.equal(bili.blockReason, 'bilibili-provider-not-ready');
  assert.equal(bili.expectedBeat, null, 'no beat number is promised for a slot that can never run');
  const read = watched.rows.find(row => row.slotId === 'slot-read');
  assert.equal(read.state, 'claimable');
  assert.equal(read.expectedBeat, 1, 'the readable slot is first in line, exactly as the beat will do it');
  assert.equal(watched.p2.bilibiliProviderReady, false, 'the named capability fact is still reported');

  // The durable measurement says the same thing, and keeps `slots_due` meaning "a beat could claim
  // it right now".
  assert.equal(watched.metrics.slots_due, 1, JSON.stringify(watched.metrics));
  assert.equal(watched.metrics.slots_claimable, 1);
  assert.equal(watched.metrics.slots_capability_blocked, 1);
  assert.equal(watched.metrics.capabilityGate, 'bilibili-not-ready');
  assert.equal(watched.metrics.slots_open, 2, 'both slots are still open — the backlog is a different number');

  // ...and the real beat behaves exactly as predicted.
  const beat = runtime.runHeartbeatCycle({ reason: 'test' });
  assert.equal(beat.dispatched, 1, JSON.stringify(beat));
  const claimed = claims(db);
  assert.equal(claimed.length, 1, JSON.stringify(claimed));
  assert.equal(claimed[0].slotId, 'slot-read', 'the predicted claim is the claim that happened');
  assert.equal(db.get("SELECT status FROM p2_plan_slots WHERE slot_id = 'slot-bili'").status, 'planned',
    'the gated slot was never claimed, so it may still run once the provider really becomes ready');
});

test('P2-6 回归：provider 就绪时同一组槽位的 watch 与 metrics 都回到 claimable/ready', async t => {
  const clock = { value: T0 };
  const root = makeRoot(t);
  const runtime = mount(t, root, { clock, providerReady: true });
  const sessionId = persistScope(runtime);
  const db = sideDb(t, root);
  seedSlot(db, { slotId: 'slot-bili', activity: 'bilibili', targetRef: 'bilibili:duty', startAt: T0 - 2 * HOUR });
  seedSlot(db, { slotId: 'slot-read', startAt: T0 - HOUR });

  const watched = runtime.p2DispatchWatch({ sessionId, now: T0 });
  assert.equal(watched.counts.capabilityBlocked, 0);
  assert.equal(watched.counts.claimable, 2, 'with a ready provider both slots are claimable again');
  const bili = watched.rows.find(row => row.slotId === 'slot-bili');
  assert.equal(bili.state, 'claimable', JSON.stringify(bili));
  assert.equal(bili.blockReason, null);
  assert.equal(bili.expectedBeat, 1, 'the earlier slot is first again');
  assert.equal(watched.metrics.slots_due, 2);
  assert.equal(watched.metrics.slots_capability_blocked, 0);
  assert.equal(watched.metrics.capabilityGate, 'ready');
  assert.equal(watched.p2.bilibiliProviderReady, true);

  const beat = runtime.runHeartbeatCycle({ reason: 'test' });
  assert.equal(beat.dispatched, 2, JSON.stringify(beat));
  assert.deepEqual(claims(db).map(payload => payload.slotId).sort(), ['slot-bili', 'slot-read']);
});
