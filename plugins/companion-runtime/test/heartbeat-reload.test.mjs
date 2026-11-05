import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mountRuntime } from '../index.mjs';
import { createDb } from '../lib/db.mjs';

// HH13: repeated mounts, same-process replacement and hot reload. Exactly one business
// timer, one tool registration path, no duplicated application of the same slot, and an
// old generation can never commit after a replacement or after dispose.

const T0 = Date.UTC(2026, 9, 30, 1, 0, 0);
const BOUND = { userId: 'owner-1' };

function buildRoot(t, config) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hh13-reload-'));
  for (const dir of ['home/companion', 'logs']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, 'home/companion/runtime.config.json'), JSON.stringify(config));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });
  return root;
}

const identity = () => ({ resolve: sessionId => ({ userId: 'owner-1', persona: 'march7', sessionId }) });
const mount = (root, clock = () => T0) => mountRuntime(null, root, { now: clock, identity: identity() });

test('HH13: a same-process replacement takes the writer lease and the old generation is fenced out', t => {
  const root = buildRoot(t, {
    enabled: true, mode: 'active',
    agenda: { enabled: true },
    heartbeat: { enabled: true, pollIntervalMs: 300000 },
  });
  const first = mount(root);
  t.after(() => { try { first.dispose(); } catch { /* already */ } });
  const created = first.createSchedule({ bound: BOUND, title: '晨间散步', rule: 'daily', timeZone: 'Asia/Shanghai', time: '07:30' });
  assert.equal(created.ok, true, JSON.stringify(created));
  const firstGeneration = first.generation;

  const second = mount(root);
  t.after(() => { try { second.dispose(); } catch { /* already */ } });
  assert.notEqual(second.generation, firstGeneration);

  // The replaced generation must not be able to commit anything any more.
  const stale = first.createSchedule({ bound: BOUND, title: '旧代次', rule: 'once', timeZone: 'Asia/Shanghai', date: '2026-10-31', time: '09:00' });
  assert.equal(stale.ok, false);
  assert.ok(['stale-generation', 'lease-lost'].includes(stale.code), `unexpected code ${stale.code}`);
  const staleCycle = first.runHeartbeatCycle();
  assert.equal(staleCycle.ok, false);
  assert.ok(['stale-generation', 'lease-lost', 'lease-expired'].includes(staleCycle.code), `unexpected cycle code ${staleCycle.code}`);

  // The live generation keeps working and still sees the definition created before reload.
  const listed = second.listSchedule({ bound: BOUND });
  assert.equal(listed.ok, true, JSON.stringify(listed));
  assert.equal(listed.items.length, 1, 'the definition survived the reload');
  assert.equal(listed.items[0].title, '晨间散步');
  const after = second.updateSchedule({ bound: BOUND, itemId: listed.items[0].itemId, expectedRevision: listed.items[0].revision, patch: { title: '晨间散步（改）' } });
  assert.equal(after.ok, true, JSON.stringify(after));
});

test('HH13: five hot reloads keep one business timer and never duplicate a slot', t => {
  const root = buildRoot(t, {
    enabled: true, mode: 'active',
    agenda: { enabled: true },
    heartbeat: { enabled: true, pollIntervalMs: 300000 },
  });
  const first = mount(root);
  const created = first.createSchedule({ bound: BOUND, title: '日晚间整理', rule: 'daily', timeZone: 'Asia/Shanghai', time: '21:00' });
  assert.equal(created.ok, true, JSON.stringify(created));
  const itemId = created.itemId;
  const occurrencesAfterCreate = created.occurrences.length;
  const eventsAfterCreate = first.status({ bound: BOUND }).eventCount;
  first.dispose();

  let runtime = null;
  const timers = [];
  for (let index = 0; index < 5; index += 1) {
    if (runtime) runtime.dispose();
    runtime = mount(root);
    const status = runtime.heartbeatStatus();
    timers.push(status.timer);
    assert.equal(status.registered, true);
    // A reload must not append events on its own: the same slot is not regenerated.
    const listed = runtime.listSchedule({ bound: BOUND });
    assert.equal(listed.items.length, 1);
    assert.equal(listed.occurrences.filter(row => row.itemId === itemId).length, occurrencesAfterCreate,
      `reload ${index} duplicated an occurrence`);
    assert.equal(runtime.status({ bound: BOUND }).eventCount, eventsAfterCreate, `reload ${index} appended an event`);
  }
  assert.deepEqual(timers, ['running', 'running', 'running', 'running', 'running'], 'exactly one business timer per mount');
  t.after(() => { try { runtime.dispose(); } catch { /* already */ } });

  // One cycle after all reloads still produces exactly one `due` transition per slot, never two.
  runtime.runHeartbeatCycle();
  const afterCycle = runtime.listSchedule({ bound: BOUND });
  const dueRows = afterCycle.occurrences.filter(row => row.status === 'due');
  assert.ok(dueRows.length <= 1, `one slot must not be marked due twice (${dueRows.length})`);
});

test('HH13: dispose stops the timer and refuses every later commit, including a queued cycle', t => {
  const root = buildRoot(t, {
    enabled: true, mode: 'active',
    agenda: { enabled: true },
    heartbeat: { enabled: true, pollIntervalMs: 300000 },
  });
  const runtime = mount(root);
  runtime.createSchedule({ bound: BOUND, title: '待办', rule: 'daily', timeZone: 'Asia/Shanghai', time: '08:00' });
  const status = runtime.heartbeatStatus();
  assert.equal(status.timer, 'running', 'an enabled heartbeat starts its timer');
  const before = runtime.status({ bound: BOUND }).eventCount;

  runtime.dispose();
  assert.equal(runtime.status({ bound: BOUND }).heartbeat.timer, 'stopped');
  const disposedCycle = runtime.runHeartbeatCycle();
  assert.equal(disposedCycle.ok, false);
  assert.ok(['runtime-disposed', 'heartbeat-not-registered', 'runtime-off'].includes(disposedCycle.code), disposedCycle.code);
  const disposedCreate = runtime.createSchedule({ bound: BOUND, title: '不应写入', rule: 'once', timeZone: 'Asia/Shanghai', date: '2026-11-01', time: '09:00' });
  assert.equal(disposedCreate.ok, false);
  // A disposed runtime reports no counts because its handle is closed; read the file that
  // is actually on disk to prove nothing was appended after dispose.
  const probe = createDb({ file: path.join(root, 'home/companion/companion-runtime.db'), now: () => T0, pragmas: false });
  const eventsAfterDispose = Number(probe.get('SELECT COUNT(*) AS n FROM domain_events').n);
  probe.close();
  assert.equal(eventsAfterDispose, before, 'a disposed runtime appends nothing');
});

test('HH13: stop() halts the business cycle while leaving the stored data readable', t => {
  const root = buildRoot(t, {
    enabled: true, mode: 'active',
    agenda: { enabled: true },
    heartbeat: { enabled: true, pollIntervalMs: 300000 },
  });
  const runtime = mount(root);
  t.after(() => { try { runtime.dispose(); } catch { /* already */ } });
  const created = runtime.createSchedule({ bound: BOUND, title: '镜头清洁', rule: 'daily', timeZone: 'Asia/Shanghai', time: '18:00' });
  assert.equal(created.ok, true, JSON.stringify(created));
  const stopped = runtime.stop({ reason: 'hh13-test' });
  assert.equal(stopped.ok, true);
  assert.equal(runtime.heartbeatStatus().timer, 'stopped', 'stop clears the business timer');
  const cycle = runtime.runHeartbeatCycle();
  assert.equal(cycle.ok, false);
  assert.ok(['runtime-stopped', 'runtime-inactive'].includes(cycle.code), cycle.code);
  const listed = runtime.listSchedule({ bound: BOUND });
  assert.equal(listed.items.length, 1, 'read-only inspection still works after stop');
  const resumed = runtime.resume();
  assert.equal(resumed.ok, true);
  assert.equal(runtime.mode, 'active');
});
