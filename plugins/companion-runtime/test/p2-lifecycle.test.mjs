import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openRuntimeDb } from '../lib/db.mjs';
import { dispatchEvent } from '../lib/events.mjs';
import { createActivities, applyActivityEvent, ACTIVITY_KINDS, ACTIVITY_OPERATIONS, ACTIVITY_REALITY, ACTIVITY_STATUS } from '../lib/activities.mjs';
import { scopeKey } from '../lib/scope.mjs';

// P2-10 适配器生命周期 (contract §5, amendment BLOCK-6).
//
// The rules under test: `running → paused → running → done`, terminal states never revive,
// every refusal is a typed deterministic code, `start` writes `running` (there is no
// `pending`), and the diagnostics surface carries ids/counters/hash prefixes only.

const T0 = Date.UTC(2026, 9, 30, 4, 0, 0);
const SCOPE = Object.freeze({ userId: 'owner-1', personaId: 'march7', worldId: 'world:default' });
const KEY = scopeKey(SCOPE);
const SOURCE = Array.from({ length: 8 }, (_, index) => `第${index}段：` + '海风把纸吹得作响。'.repeat(8)).join('\n\n');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-life-'));
  fs.mkdirSync(path.join(dir, 'shelf'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'shelf', 'note.md'), `# 海风\n\n${SOURCE}`, 'utf8');
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
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

function openDb(t) {
  const db = openRuntimeDb({ file: ':memory:', now: () => T0 });
  db.acquireLease({ owner: 'test', generation: 'gen-1', ttlMs: 600000 });
  db.commitProjection({ scope: KEY, generation: 'gen-1', payload: {}, updatedAt: T0 });
  t.after(() => { try { db.close(); } catch { /* already closed */ } });
  return db;
}

const dispatchFor = db => event => dispatchEvent(db, event, { handlers: { autonomy: applyActivityEvent }, generation: 'gen-1', requireConsumers: true });

function insertSlot(db, { slotId, kind = 'activity', activity = 'read', target, startAt = T0, endAt = T0 + 3600000, detail = '{}' }) {
  db.run(`INSERT INTO p2_plan_slots (slot_id, plan_id, scope, day, start_at, end_at, kind, activity, title, detail,
            flexibility, intent, target_ref, status, locked, created_at, updated_at)
          VALUES (?, 'plan-1', ?, '2026-10-30', ?, ?, ?, ?, '海风', ?, 'soft', '', ?, 'planned', 0, ?, ?)`,
  slotId, KEY, startAt, endAt, kind, activity, detail, target, T0, T0);
}

function makeActivities({ db, ports = filePorts(), workspace, config = configFor(), clock = () => T0 + 1000, extra = {} }) {
  return createActivities({ db, config, clock, owner: 'test', generation: 'gen-1', dispatch: dispatchFor(db), ports, workspace, ...extra });
}

test('P2-10: the frozen vocabularies are exported and closed', () => {
  assert.deepEqual([...ACTIVITY_KINDS], ['read', 'explore', 'write', 'bilibili']);
  assert.deepEqual([...ACTIVITY_STATUS], ['running', 'paused', 'done', 'failed', 'abandoned']);
  assert.ok(!ACTIVITY_STATUS.includes('pending'), 'pending is unreachable (BLOCK-6)');
  assert.deepEqual([...ACTIVITY_REALITY], ['actual_tool_activity', 'simulated_world', 'hypothetical']);
  assert.deepEqual([...ACTIVITY_OPERATIONS], ['start', 'step', 'pause', 'resume', 'finish', 'abandon', 'missed', 'review', 'share']);
});

test('Bilibili reconciles running rounds and requires confirmed consumption for experience', async t => {
  const db = openDb(t);
  const observed = [];
  const activities = makeActivities({
    db, workspace: tempDir(t), ports: { runBilibili() {} },
    extra: { onFinished: info => observed.push(info) },
  });
  for (const [index, reality, evidence] of [
    [0, 'actual_tool_activity', [{ kind: 'report', written: true }]],
    [1, 'simulated_world', [{ kind: 'watch', videoId: 'BV1ab2cd3ef4', consumedSeconds: 19 }]],
    [2, 'actual_tool_activity', [{ kind: 'watch', videoId: 'BV1ab2cd3ef4', consumedSeconds: 19 }]],
  ]) {
    const slotId = `bili-slot-${index}`;
    insertSlot(db, { slotId, activity: 'bilibili', target: 'bilibili:duty', startAt: T0 + index * 100, endAt: T0 + 3600000 });
    const { activityId } = activities.start({ slotId, kind: 'bilibili', reality });
    const reconciliation = await activities.reconcile();
    assert.ok(reconciliation.resumed.includes(activityId));
    assert.ok(!reconciliation.needsReview.includes(activityId));
    const result = activities.settleBilibili({
      activityId, scopeKey: KEY, result: { roundId: activityId, status: 'completed', evidence },
    });
    assert.equal(result.status, 'done');
    assert.equal(result.bilibiliRound.watched, index === 0 ? 0 : 1);
  }
  assert.equal(observed.length, 1);
  assert.equal(observed[0].consumedPrefix, 1);
});

test('P2-10: start/step/pause/resume/finish and their refusals', t => {
  const workspace = tempDir(t);
  const db = openDb(t);
  insertSlot(db, { slotId: 'slot-1', target: 'shelf/note.md' });
  const activities = makeActivities({ db, workspace });

  const started = activities.start({ slotId: 'slot-1', kind: 'read' });
  assert.equal(started.status, 'running');
  assert.equal(activities.start({ slotId: 'slot-1', kind: 'read' }).duplicate, true, 'a repeated start is idempotent');
  assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM p2_activities').n), 1);

  const step = activities.step({ activityId: started.activityId, units: 200 });
  assert.ok(step.units > 0);
  assert.equal(step.status, 'running');
  assert.throws(() => activities.step({ activityId: 'act_missing', units: 10 }), error => error.code === 'unknown-activity');

  assert.equal(activities.pause({ activityId: started.activityId }).status, 'paused');
  assert.equal(activities.pause({ activityId: started.activityId }).duplicate, true, 'pausing twice is a no-op');
  assert.throws(() => activities.step({ activityId: started.activityId, units: 50 }), error => error.code === 'invalid-transition');
  assert.equal(activities.resume({ activityId: started.activityId }).status, 'running');
  assert.equal(activities.resume({ activityId: started.activityId }).duplicate, true, 'resuming a running activity is a no-op');

  const finished = activities.finish({ activityId: started.activityId });
  assert.equal(finished.status, 'done');
  assert.equal(activities.finish({ activityId: started.activityId }).duplicate, true);
  assert.throws(() => activities.step({ activityId: started.activityId, units: 10 }), error => error.code === 'invalid-transition');
  assert.throws(() => activities.pause({ activityId: started.activityId }), error => error.code === 'invalid-transition');
  assert.throws(() => activities.resume({ activityId: started.activityId }), error => error.code === 'invalid-transition');
  assert.throws(() => activities.abandon({ activityId: started.activityId, reason: 'x' }), error => error.code === 'invalid-transition');
  assert.throws(() => activities.fail({ activityId: started.activityId, code: 'failed-unknown' }), error => error.code === 'invalid-transition');
  assert.equal(db.get('SELECT status FROM p2_activities WHERE activity_id = ?', started.activityId).status, 'done', 'a terminal activity is never revived');
});

test('P2-10: fail() reaches the failed state once and abandon keeps its reason', t => {
  const workspace = tempDir(t);
  const db = openDb(t);
  insertSlot(db, { slotId: 'slot-fail', target: 'shelf/note.md' });
  insertSlot(db, { slotId: 'slot-abandon', target: 'shelf/note.md' });
  const activities = makeActivities({ db, workspace });

  const failing = activities.start({ slotId: 'slot-fail', kind: 'read' });
  const failed = activities.fail({ activityId: failing.activityId, code: 'failed-unknown', reason: 'crash after send' });
  assert.equal(failed.status, 'failed');
  const receipt = db.get("SELECT * FROM p2_activity_receipts WHERE activity_id = ? AND operation = 'finish'", failing.activityId);
  assert.equal(receipt.ok, 0);
  assert.equal(receipt.code, 'failed-unknown');
  assert.throws(() => activities.resume({ activityId: failing.activityId }), error => error.code === 'invalid-transition');

  const abandonable = activities.start({ slotId: 'slot-abandon', kind: 'read' });
  const abandoned = activities.abandon({ activityId: abandonable.activityId, reason: '没兴趣了' });
  assert.equal(abandoned.status, 'abandoned');
  const checkpoint = JSON.parse(db.get('SELECT checkpoint FROM p2_activities WHERE activity_id = ?', abandonable.activityId).checkpoint);
  assert.equal(checkpoint.reason, '没兴趣了');
  assert.equal(Number(db.get('SELECT ended_at FROM p2_activities WHERE activity_id = ?', abandonable.activityId).ended_at), T0 + 1000);
});

test('P2-10: switches, pause gates, mode and disposal are all typed refusals', t => {
  const workspace = tempDir(t);
  const db = openDb(t);
  insertSlot(db, { slotId: 'slot-1', target: 'shelf/note.md' });

  const disabled = makeActivities({ db, workspace, config: configFor({ enabled: false }) });
  assert.throws(() => disabled.start({ slotId: 'slot-1', kind: 'read' }), error => error.code === 'activities-disabled');
  assert.equal(disabled.status().enabled, false);
  assert.equal(disabled.status().state, 'disabled');

  const pausedConfig = makeActivities({ db, workspace, config: configFor({ paused: true }) });
  assert.throws(() => pausedConfig.start({ slotId: 'slot-1', kind: 'read' }), error => error.code === 'activities-paused');
  assert.equal(pausedConfig.status().paused, true);

  const gateFn = makeActivities({ db, workspace, extra: { pause: () => true } });
  assert.throws(() => gateFn.start({ slotId: 'slot-1', kind: 'read' }), error => error.code === 'activities-paused');

  // Persisted pause (contract §5 rule 6) survives a reload and is honoured without a hook.
  db.metaSet('p2_activities_paused', '1');
  const persisted = makeActivities({ db, workspace });
  assert.throws(() => persisted.start({ slotId: 'slot-1', kind: 'read' }), error => error.code === 'activities-paused');
  assert.equal(persisted.status().paused, true);
  db.metaSet('p2_activities_paused', '0');

  const shadow = makeActivities({ db, workspace, extra: { pause: { mode: 'shadow', isPaused: () => false } } });
  assert.throws(() => shadow.start({ slotId: 'slot-1', kind: 'read' }), error => error.code === 'runtime-inactive');

  const live = makeActivities({ db, workspace });
  const started = live.start({ slotId: 'slot-1', kind: 'read' });
  live.dispose();
  assert.throws(() => live.step({ activityId: started.activityId, units: 10 }), error => error.code === 'runtime-disposed');

  assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM p2_activities').n), 1, 'only the one allowed start created an activity');
});

test('P2-10: an unavailable adapter and an unknown kind create nothing', t => {
  const workspace = tempDir(t);
  const db = openDb(t);
  insertSlot(db, { slotId: 'slot-1', target: 'shelf/note.md' });
  const noPorts = createActivities({
    db, config: configFor(), clock: () => T0 + 1000, owner: 'test', generation: 'gen-1',
    dispatch: dispatchFor(db), ports: {}, workspace,
  });
  assert.throws(() => noPorts.start({ slotId: 'slot-1', kind: 'read' }), error => error.code === 'adapter-unavailable');
  assert.throws(() => noPorts.start({ slotId: 'slot-1', kind: 'sing' }), error => error.code === 'invalid-input');
  assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM p2_activities').n), 0);
  const described = noPorts.adapters();
  assert.deepEqual(described.map(entry => entry.available), [false, false, false, false]);
  assert.ok(described.every(entry => entry.reason === 'port-not-mounted'));

  // A start with no plan slot and no injected scope cannot invent a scope either.
  const anywhere = makeActivities({ db, workspace });
  assert.throws(() => anywhere.start({ slotId: 'slot-nope', kind: 'read' }), error => error.code === 'unknown-slot');
  assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM p2_activities').n), 0);
});

test('P2-10: reality is inferred strictly and diagnostics never leak a body', t => {
  const workspace = tempDir(t);
  const db = openDb(t);
  insertSlot(db, { slotId: 'slot-default', target: 'shelf/note.md' });
  insertSlot(db, { slotId: 'slot-explicit', target: 'shelf/note.md' });
  insertSlot(db, { slotId: 'slot-simulated', target: 'shelf/note.md', detail: '{"reality":"simulated"}' });
  insertSlot(db, { slotId: 'slot-sim-kind', kind: 'simulated', target: 'shelf/note.md' });
  // A planner may declare a slot as a real tool activity explicitly. It is honoured — but
  // nothing ever *defaults* to it (see the `slot-default` case below).
  insertSlot(db, { slotId: 'slot-declared-real', target: 'shelf/note.md', detail: '{"reality":"actual_tool_activity"}' });
  const activities = makeActivities({ db, workspace });

  const plain = activities.start({ slotId: 'slot-default', kind: 'read' });
  assert.equal(plain.reality, 'hypothetical', 'nothing claims a real tool activity by default');
  const explicit = activities.start({ slotId: 'slot-explicit', kind: 'read', reality: 'actual_tool_activity' });
  assert.equal(explicit.reality, 'actual_tool_activity');
  assert.equal(activities.start({ slotId: 'slot-simulated', kind: 'read' }).reality, 'simulated_world');
  assert.equal(activities.start({ slotId: 'slot-sim-kind', kind: 'read' }).reality, 'simulated_world');
  assert.equal(activities.start({ slotId: 'slot-declared-real', kind: 'read' }).reality, 'actual_tool_activity', 'an explicit slot marker is honoured');
  assert.equal(
    JSON.parse(db.get("SELECT detail FROM p2_activity_receipts WHERE activity_id = ? AND operation = 'start'", plain.activityId).detail).reality,
    'hypothetical',
    'the receipt carries the reality label',
  );

  activities.step({ activityId: plain.activityId, units: 200 });
  const status = activities.status();
  const listed = activities.list();
  assert.equal(listed.length, 5);
  const forbidden = ['text', 'title', 'excerpt', 'body', 'notes', 'checkpoint', 'sourceRef'];
  for (const entry of listed) {
    for (const key of forbidden) assert.ok(!(key in entry), `list() must not expose ${key}`);
    assert.equal(entry.sourceHashPrefix.length, 16, 'only a 16-hex hash prefix is reported');
  }
  const flattened = JSON.stringify(status);
  assert.ok(!flattened.includes('海风把纸吹得作响'), 'the status partition never contains source text');
  assert.equal(status.counts.running, 5);
  assert.equal(status.running, 5);
  assert.equal(status.adapters.length, 4);
  assert.ok(status.lastReceipt.operation);
  assert.equal(status.lastReceipt.reality, 'hypothetical');

  // The share payload may carry a bounded body, but this module never writes the table.
  const payload = activities.candidatePayload(plain.activityId);
  assert.equal(payload.ok, true);
  assert.ok(payload.title.length > 0);
  assert.equal(typeof payload.body, 'string', 'a read activity keeps no private body copy; the executor supplies its consumed segment');
  assert.equal(payload.sourceHash.length, 64);
  assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM p2_share_candidates').n), 0, 'share candidates belong to the Lead share flow');
});
