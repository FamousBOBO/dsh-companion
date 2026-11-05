import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openRuntimeDb } from '../lib/db.mjs';
import { dispatchEvent } from '../lib/events.mjs';
import { applyActivityEvent, createActivities, effectRecords, prepareFailurePhase } from '../lib/activities.mjs';
import { applyPlanEvent } from '../lib/planner.mjs';
import { createP2 } from '../lib/p2.mjs';
import { normalizeEvent } from '../lib/events.mjs';
import { applyBridgeEvent, enqueueIngest } from '../lib/bridge.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scopeKey } from '../lib/scope.mjs';

// P2.5 收口（第二轮复审 §二.1）：prepare 失败的**三桶**分类。
//
//   not_applied — 能证明没有发出外部调用（校验、无适配器、白名单在 fetch 前就拒绝、任何 read）
//   failed      — 调用确实发生，且拿到了确定答案（404、正文不可读、写完被明确拒绝）→ 终态，可重试
//   unknown     — 调用可能发生但拿不到答案（端口抛错/超时/中断/进程退出）→ 阻断，等人收敛
//
// 只有 unknown 与在途 prepared 阻断。全部隔离：临时库、无网络、无 home/。

const T0 = Date.UTC(2026, 10, 4, 3, 0, 0);
const HOUR = 3600000;
const SCOPE = Object.freeze({ userId: 'owner-1', personaId: 'march7', worldId: 'world:default' });
const KEY = scopeKey(SCOPE);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const dispatchAll = db => event => dispatchEvent(db, event, {
  handlers: { autonomy: applyActivityEvent, planner: applyPlanEvent }, generation: 'gen-1', owner: '999999:tester:test', requireConsumers: true,
});

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-closeout-'));
  fs.mkdirSync(path.join(dir, 'shelf'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'shelf', 'deep.md'), '# 深处\n\n' + '潮声一阵一阵压过来。'.repeat(40), 'utf8');
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });
  return dir;
}

function world(t) {
  const clock = { value: T0 };
  const db = openRuntimeDb({ file: ':memory:', now: () => clock.value });
  t.after(() => { try { db.close(); } catch { /* closed */ } });
  const owner = '999999:tester:test';
  const generation = 'gen-1';
  assert.equal(db.acquireLease({ owner, generation, ttlMs: 600000 }).ok, true);
  db.commitProjection({ scope: KEY, generation, payload: {}, updatedAt: T0 });
  db.run(`INSERT INTO p2_plans (plan_id, scope, day, version, status, time_zone, window_start, window_end, summary, source_run_id, supersedes, created_at, committed_at)
          VALUES ('plan-1', ?, '2026-11-04', 1, 'committed', 'Asia/Shanghai', ?, ?, '', '', '', ?, ?)`,
  KEY, T0 - 6 * HOUR, T0 + 6 * HOUR, T0, T0);
  db.run(`INSERT INTO p2_plan_slots (slot_id, plan_id, scope, day, start_at, end_at, kind, activity, title, detail,
            flexibility, intent, target_ref, status, locked, created_at, updated_at)
          VALUES ('slot-explore', 'plan-1', ?, '2026-11-04', ?, ?, 'explore', 'explore', '页面', '{"reality":"actual_tool_activity"}', 'soft', '', 'https://example.test/a', 'planned', 0, ?, ?)`,
  KEY, T0 - HOUR, T0 + HOUR, T0, T0);
  return { db, clock, owner, generation };
}

function makeActivities({ db, dir, owner, generation, clock, fetchPage }) {
  return createActivities({
    db, clock: () => clock.value, owner, generation, workspace: dir,
    config: {
      p2: {
        activities: {
          enabled: true, paused: false, chunkUnits: 200, maxUnitsPerStep: 4000,
          maxSourceBytes: 200000, maxTotalUnits: 200000, maxExcerptChars: 400, draftsDir: 'drafts',
        },
        autonomy: { allowedSources: ['example.test'] },
      },
    },
    dispatch: event => dispatchEvent(db, event, {
      handlers: { autonomy: applyActivityEvent, planner: applyPlanEvent },
      generation, owner, requireConsumers: true,
    }),
    ports: {
      readFile({ path: file }) { try { return { ok: true, text: fs.readFileSync(file, 'utf8') }; } catch { return { ok: false }; } },
      writeFile() { return { ok: false }; },
      fetchPage,
    },
  });
}

test('三桶: the classifier itself (pure)', () => {
  assert.equal(prepareFailurePhase({ kind: 'read', ioStarted: true, code: 'source-invalid', typed: true }), 'not_applied', 'a read cannot change anything');
  assert.equal(prepareFailurePhase({ kind: 'explore', ioStarted: false, code: 'source-invalid', typed: true }), 'not_applied', 'refused before the adapter ran');
  assert.equal(prepareFailurePhase({ kind: 'explore', ioStarted: true, code: 'source-invalid', typed: true }), 'failed', 'a definite answer');
  assert.equal(prepareFailurePhase({ kind: 'explore', ioStarted: true, code: 'source-invalid', typed: false }), 'unknown', 'no answer');
});

test('#1: a 404 is a definite answer (`failed`), it does not block, and the retry gets a new attempt', async t => {
  const dir = tempDir(t);
  const w = world(t);
  let fetches = 0;
  const activities = makeActivities({
    ...w, dir, fetchPage() { fetches += 1; return { ok: false, status: 404 }; },
  });

  assert.throws(() => activities.start({ slotId: 'slot-explore', kind: 'explore' }), error => error.code === 'source-invalid');
  assert.deepEqual(effectRecords(w.db, { scopeKey: KEY }).map(r => r.phase), ['prepared', 'failed'], 'the outcome is a definite failure');

  assert.throws(() => activities.start({ slotId: 'slot-explore', kind: 'explore' }), error => error.code === 'source-invalid');
  assert.equal(fetches, 2, 'a settled failure does not block the next attempt');
  const records = effectRecords(w.db, { scopeKey: KEY });
  assert.equal(records.filter(r => r.phase === 'prepared').length, 2, 'the retry is a new attempt, not a replay');
  assert.notEqual(records[0].effectKey, records[2].effectKey, 'a new attempt has a new identity');
});

test('#1: a port that throws gives no answer (`unknown`), and that blocks the retry', async t => {
  const dir = tempDir(t);
  const w = world(t);
  let fetches = 0;
  const activities = makeActivities({
    ...w, dir, fetchPage() { fetches += 1; throw new Error('socket hang up'); },
  });

  assert.throws(() => activities.start({ slotId: 'slot-explore', kind: 'explore' }));
  assert.deepEqual(effectRecords(w.db, { scopeKey: KEY }).map(r => r.phase), ['prepared', 'unknown'], 'no answer ⇒ unknown');
  assert.throws(() => activities.start({ slotId: 'slot-explore', kind: 'explore' }), error => error.code === 'effect-unknown');
  assert.equal(fetches, 1, 'an ambiguous call is never repeated without a human');
});

// ---------------------------------------------------------------------------
// #8.1 tick 驱动的 drain
// ---------------------------------------------------------------------------

function configP2({ activities = true, planning = true } = {}) {
  return {
    p2: {
      activities: {
        enabled: activities, paused: false, chunkUnits: 200, maxUnitsPerStep: 4000,
        maxSourceBytes: 200000, maxTotalUnits: 200000, maxExcerptChars: 400, draftsDir: 'drafts',
      },
      planning: { enabled: planning },
      autonomy: { allowedSources: ['example.test'] },
    },
  };
}

test('#8.1: the P2 tick is what drains the outbox — and both switches off means no drain', async t => {
  const dir = tempDir(t);
  const w = world(t);
  let drains = 0;
  const withTick = createP2({
    db: w.db, config: configP2(), clock: () => w.clock.value, owner: w.owner, generation: w.generation,
    workspace: dir, emit: dispatchAll(w.db),
    options: { drainOutbox: async () => { drains += 1; return { ok: true, processed: 0 }; } },
  });

  // Drive the *real* interval callback: if the drain call is removed from the timer body (or the
  // timer stops being installed), this goes red.
  const realSetInterval = globalThis.setInterval;
  let captured = null;
  globalThis.setInterval = fn => { captured = fn; return { unref() {} }; };
  try { withTick.start(); } finally { globalThis.setInterval = realSetInterval; }
  assert.equal(typeof captured, 'function', 'the tick was installed');
  await captured();
  assert.equal(drains, 1, 'the timer body drains the outbox');

  // Both P2 switches off: no timer at all, and nothing drains.
  drains = 0;
  const idle = createP2({
    db: w.db, config: configP2({ activities: false, planning: false }), clock: () => w.clock.value,
    owner: w.owner, generation: w.generation, workspace: dir, emit: dispatchAll(w.db),
    options: { drainOutbox: async () => { drains += 1; return { ok: true, processed: 0 }; } },
  });
  let installed = null;
  globalThis.setInterval = fn => { installed = fn; return { unref() {} }; };
  try { idle.start(); } finally { globalThis.setInterval = realSetInterval; }
  assert.equal(installed, null, 'no timer is installed when both switches are off');
  assert.equal(drains, 0, 'and the outbox is not drained behind their back');
});

// ---------------------------------------------------------------------------
// #8.3 补偿超过 20 条边界
// ---------------------------------------------------------------------------

const DONE_ACTIVITY_SQL = `INSERT INTO p2_activities (activity_id, scope, plan_slot_id, kind, adapter, capability, reality, status,
    target, source_ref, source_hash, total_units, consumed_prefix, checkpoint, artifact_ref, artifact_hash,
    artifact_version, started_at, paused_at, ended_at, created_at, updated_at)
  VALUES (?, ?, '', 'read', 'read', 'read', 'actual_tool_activity', 'done',
    'shelf/deep.md', 'file:shelf/deep.md', ?, 100, 100, '{}', '', '', 0, ?, 0, ?, ?, ?)`;

test('#8.3: twenty already-marked activities do not starve the twenty-first', async t => {
  const dir = tempDir(t);
  const w = world(t);
  const marked = [];
  for (let i = 0; i < 20; i += 1) {
    const id = `act_old_${String(i).padStart(2, '0')}`;
    const at = T0 - 10 * HOUR + i;
    w.db.run(DONE_ACTIVITY_SQL, id, KEY, 'b'.repeat(64), at, at, at, at);
    w.db.run('INSERT INTO runtime_meta (meta_key, meta_value, updated_at) VALUES (?, ?, ?)', `p2_p1_${id}`, '1', at);
    marked.push(id);
  }
  const missing = 'act_old_21';
  const seen = [];
  const p2 = createP2({
    db: w.db, config: configP2(), clock: () => w.clock.value, owner: w.owner, generation: w.generation,
    workspace: dir, emit: dispatchAll(w.db),
    options: { onFinished: info => {
      seen.push(info.activityId);
      const event = normalizeEvent({
        kind: 'memory/ingest-request', scope: SCOPE, occurredAt: Number(info.at) || T0,
        realityStatus: 'actual_tool_activity', evidenceStatus: 'observed',
        payload: { namespace: 'p2/activity', content: `补记 ${info.activityId}`, transformVersion: 'p2-activity-v1' },
      });
      const dispatched = dispatchEvent(w.db, event, {
        handlers: { bridge: args => applyBridgeEvent(args) }, generation: w.generation, owner: w.owner,
      });
      return { ok: dispatched.rejected !== true, duplicate: dispatched.inserted === false };
    } },
  });

  // The 21st finishes **after** the hook was wired (that is the case compensation exists for):
  // anything older than the one-time boundary is deliberately left alone, otherwise the legacy
  // path's experience plus this replay would double-write (R3).
  w.db.run(DONE_ACTIVITY_SQL, missing, KEY, 'c'.repeat(64), T0, T0, T0, T0);

  const pass = await p2.compensateFinishedEvents({ scopeKey: KEY, limit: 2 });
  assert.deepEqual(pass.replayed, [missing], 'the unmarked activity past the first twenty is still reached');
  assert.equal(seen.includes(marked[0]), false, 'already-marked activities are not replayed');
});

// ---------------------------------------------------------------------------
// #8.2 子进程硬退出
// ---------------------------------------------------------------------------

test('#8.2: a process that dies with the intent open never causes a second outward call', async t => {
  for (const phase of ['prepared', 'after-call']) {
    const root = tempDir(t);
    const dbFile = path.join(root, 'runtime.db');
    const marker = path.join(root, 'port-calls.txt');
    fs.writeFileSync(marker, '');
    const spawned = spawnSync(process.execPath, [path.join(HERE, 'fixtures', 'p1-closeout-child.mjs')], {
      env: { ...process.env, P1_DB: dbFile, P1_MARKER: marker, P1_ROOT: root, P1_PHASE: phase, P1_GENERATION: 'gen-child' },
      stdio: 'ignore',
      timeout: 60000,
    });
    assert.notEqual(spawned.status, 0, `the child exits hard (${phase})`);

    // The parent re-opens the same database: the intent must be durable and unanswered.
    const db = openRuntimeDb({ file: dbFile, now: () => T0 });
    t.after(() => { try { db.close(); } catch { /* closed */ } });
    assert.deepEqual(effectRecords(db, { scopeKey: KEY }).map(r => r.phase), ['prepared'], `only the intent is durable (${phase})`);

    const callsBefore = fs.readFileSync(marker, 'utf8').split('\n').filter(Boolean).length;
    assert.equal(callsBefore, phase === 'after-call' ? 1 : 0, `the port was reached ${phase === 'after-call' ? 'once' : 'not at all'}`);

    // Take over with a different connection *and* a different generation: exactly what a restarted
    // process does. The unanswered intent must stop it before the port is touched.
    assert.equal(db.acquireLease({ owner: '888888:parent:test', generation: 'gen-parent', ttlMs: 600000 }).ok, true);
    const activities = createActivities({
      db, config: configP2(), clock: () => T0 + 1000, owner: '888888:parent:test', generation: 'gen-parent',
      dispatch: event => dispatchEvent(db, event, {
        handlers: { autonomy: applyActivityEvent, planner: applyPlanEvent },
        generation: 'gen-parent', owner: '888888:parent:test', requireConsumers: true,
      }),
      workspace: root,
      ports: {
        readFile() { return { ok: false }; },
        writeFile() { return { ok: false }; },
        fetchPage() { fs.appendFileSync(marker, 'refetch\n'); return { ok: false, status: 404 }; },
      },
    });
    assert.throws(
      () => activities.start({ slotId: 'slot-child', kind: 'explore' }),
      error => ['effect-unknown', 'effect-in-flight'].includes(error.code),
      `the unanswered intent blocks the retry (${phase})`,
    );
    const callsAfter = fs.readFileSync(marker, 'utf8').split('\n').filter(Boolean).length;
    assert.equal(callsAfter, callsBefore, `no second outward call (${phase})`);
  }
});
