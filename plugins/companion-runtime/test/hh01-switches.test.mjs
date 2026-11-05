import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mountRuntime } from '../index.mjs';

// HH01: the two new capabilities are independent, default-off switches; shadow mode does
// not touch the authoritative agenda; pausing the business heartbeat must not stop P1, the
// memory bridge, the writer lease or the chat path, and the pause survives a restart.

const T0 = Date.UTC(2026, 9, 30, 1, 0, 0); // 2026-10-30 09:00 Asia/Shanghai

function buildRoot(t, config) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hh01-switches-'));
  for (const dir of ['home/companion', 'logs']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, 'home/companion/runtime.config.json'), JSON.stringify(config));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });
  return root;
}

const identity = () => ({ resolve: sessionId => ({ userId: 'owner-1', persona: 'march7', sessionId }) });

function mount(root, clock = () => T0) {
  return mountRuntime(null, root, { now: clock, identity: identity() });
}

test('HH01: default config keeps agenda and heartbeat off, and says so instead of pretending', t => {
  const root = buildRoot(t, { enabled: true, mode: 'active', timeZone: 'Asia/Shanghai' });
  const runtime = mount(root);
  t.after(() => runtime.dispose());
  assert.equal(runtime.mode, 'active');
  const status = runtime.status({ bound: { userId: 'owner-1' } });
  assert.equal(status.agenda.enabled, false);
  assert.equal(status.agenda.state, 'disabled');
  assert.equal(status.heartbeat.enabled, false);
  assert.equal(status.heartbeat.state, 'disabled');
  assert.equal(status.heartbeat.registered, true, 'the controller is mounted but idle');
  assert.equal(status.heartbeat.timer, 'stopped', 'a disabled heartbeat starts no business timer');

  const created = runtime.createSchedule({ bound: { userId: 'owner-1' }, title: '去文庙', rule: 'once', timeZone: 'Asia/Shanghai', date: '2026-10-31', time: '10:00' });
  assert.equal(created.ok, false);
  assert.equal(created.code, 'agenda-disabled');

  const listed = runtime.listSchedule({ bound: { userId: 'owner-1' } });
  assert.equal(listed.ok, true);
  assert.equal(listed.enabled, false);
  assert.equal(listed.state, 'disabled');
  assert.deepEqual(listed.items, []);

  const cycle = runtime.runHeartbeatCycle();
  assert.equal(cycle.ok, false);
  assert.equal(cycle.code, 'heartbeat-disabled');

  // Nothing about the new capabilities may be written while they are off.
  assert.equal(Number(runtime.status({ bound: { userId: 'owner-1' } }).eventCount), 0);
});

test('HH01: agenda on while heartbeat stays off — definitions and occurrences work, nothing is settled', t => {
  let clock = T0;
  const root = buildRoot(t, {
    enabled: true, mode: 'active',
    agenda: { enabled: true },
    heartbeat: { enabled: false },
  });
  const runtime = mount(root, () => clock);
  t.after(() => runtime.dispose());
  const bound = { userId: 'owner-1' };
  const created = runtime.createSchedule({ bound, title: '看展', rule: 'once', timeZone: 'Asia/Shanghai', date: '2026-10-30', time: '10:00' });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.occurrences.length, 1);
  assert.equal(created.occurrences[0].status, 'scheduled');

  // Move past the planned instant with the heartbeat disabled: nothing may settle it.
  clock = T0 + 2 * 3600 * 1000;
  const listed = runtime.listSchedule({ bound });
  assert.equal(listed.enabled, true);
  assert.equal(listed.occurrences.length, 1);
  assert.equal(listed.occurrences[0].status, 'scheduled', 'a disabled heartbeat never marks anything due');
  const cycle = runtime.runHeartbeatCycle();
  assert.equal(cycle.ok, false);
  assert.equal(cycle.code, 'heartbeat-disabled');
  assert.equal(runtime.listSchedule({ bound }).occurrences[0].status, 'scheduled');
});

test('HH01: shadow mode records a proposal instead of writing the authoritative agenda', t => {
  const root = buildRoot(t, { enabled: true, mode: 'shadow', agenda: { enabled: true } });
  const runtime = mount(root);
  t.after(() => runtime.dispose());
  const bound = { userId: 'owner-1' };
  const created = runtime.createSchedule({ bound, title: '散步', rule: 'daily', timeZone: 'Asia/Shanghai', time: '20:00' });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.shadow, true);
  assert.equal(created.enabled, false);
  const proposals = runtime.shadowProposals({ scopeKey: 'u:owner-1|p:march7|w:world:default' });
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].kind, 'agenda/created');
  const listed = runtime.listSchedule({ bound });
  assert.equal(listed.items.length, 0, 'shadow mode never writes agenda_items');
});

test('HH01: pause stops only the rule cycle, is persisted, and survives a remount', t => {
  const root = buildRoot(t, {
    enabled: true, mode: 'active',
    agenda: { enabled: true },
    heartbeat: { enabled: true, pollIntervalMs: 300000 },
  });
  const bound = { userId: 'owner-1' };
  const runtime = mount(root);
  let disposed = false;
  t.after(() => { if (!disposed) runtime.dispose(); });

  // P1 activity before the pause, so "still working afterwards" is a real comparison.
  const goal = runtime.proposeGoal({ bound, title: '修窗户' });
  assert.equal(goal.ok, true, JSON.stringify(goal));

  const paused = runtime.pauseHeartbeat({ reason: 'operator-test' });
  assert.equal(paused.ok, true, JSON.stringify(paused));
  assert.equal(runtime.heartbeatStatus().paused, true);
  const status = runtime.status({ bound });
  assert.equal(status.heartbeat.paused, true);
  assert.equal(status.heartbeat.pausedReason, 'operator-test');

  // Pausing must not stop the runtime, the lease, the bridge or P1 writes.
  assert.equal(runtime.mode, 'active');
  assert.equal(runtime.writable, true);
  assert.equal(runtime.stopped, false);
  assert.equal(status.stopped, false);
  assert.equal(status.config.bridgeEnabled, false, 'the pause does not touch the bridge switch');
  assert.ok(runtime.generation);
  const afterPause = runtime.proposeGoal({ bound, title: '买玻璃' });
  assert.equal(afterPause.ok, true, 'P1 writes keep working while the heartbeat is paused');

  // A paused cycle writes nothing at all.
  const dbFile = runtime.dbFile;
  const before = Number(runtime.status({ bound }).eventCount);
  const cycle = runtime.runHeartbeatCycle();
  assert.equal(cycle.ok, false);
  assert.equal(cycle.code, 'heartbeat-paused');
  assert.equal(Number(runtime.status({ bound }).eventCount), before, 'a paused cycle appends no event');
  assert.ok(fs.existsSync(dbFile));

  // Restart semantics: the persisted pause is still in force in a fresh mount.
  disposed = true;
  runtime.dispose();
  const remounted = mount(root);
  t.after(() => remounted.dispose());
  const restarted = remounted.heartbeatStatus();
  assert.equal(restarted.paused, true, 'the pause is persisted, not in-memory only');
  assert.equal(restarted.pausedReason, 'operator-test');
  const resumed = remounted.resumeHeartbeat();
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  assert.equal(remounted.heartbeatStatus().paused, false);
  // Resuming an explicitly paused heartbeat never enables a disabled feature.
  const p1 = remounted.listGoals({ bound });
  assert.equal(p1.goals.length, 2, 'P1 goals survived the remount untouched');
});
