import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mountRuntime } from '../index.mjs';
import { createDb } from '../lib/db.mjs';

// HH17: the P1 cognitive layer, working memory, bridge queue and contact boundary must be
// unchanged when the new switches are off — including the "no business side effect" claim:
// calling every new API must append no event, write no outbox row and move no state.

const T0 = Date.UTC(2026, 9, 30, 1, 0, 0);
const BOUND = { userId: 'owner-1' };

function buildRoot(t, config) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hh17-regression-'));
  for (const dir of ['home/companion', 'logs']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, 'home/companion/runtime.config.json'), JSON.stringify(config));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });
  return root;
}

const identity = () => ({ resolve: sessionId => ({ userId: 'owner-1', persona: 'march7', sessionId }) });

function openProbe(root) {
  return createDb({ file: path.join(root, 'home/companion/companion-runtime.db'), now: () => T0, pragmas: false });
}

test('HH17: with the new switches off, P1 state, working memory and verification behave as before', t => {
  const root = buildRoot(t, { enabled: true, mode: 'active', timeZone: 'Asia/Shanghai', injection: { budgetChars: 320 } });
  const runtime = mountRuntime(null, root, {
    now: () => T0,
    identity: identity(),
    memory: { version: 'stub', ingestDomainEvent: async () => ({ status: 'accepted', receiptId: 'r1' }) },
  });
  t.after(() => runtime.dispose());

  // P1 lifecycle through the public API.
  const proposed = runtime.proposeGoal({ bound: BOUND, title: '整理相册', nextStep: '挑出重复照片', deadlineAt: T0 + 86400000 });
  assert.equal(proposed.ok, true, JSON.stringify(proposed));
  const goal = runtime.listGoals({ bound: BOUND }).goals[0];
  assert.equal(runtime.transitionGoal({ bound: BOUND, goalId: goal.goalId, to: 'accepted', expectedRevision: goal.revision }).ok, true);
  assert.equal(runtime.transitionGoal({ bound: BOUND, goalId: goal.goalId, to: 'started', expectedRevision: goal.revision + 1 }).ok, true);
  const stepped = runtime.recordGoalStep({ bound: BOUND, goalId: goal.goalId, step: '删掉 30 张', expectedRevision: goal.revision + 2 });
  assert.equal(stepped.ok, true, JSON.stringify(stepped));
  assert.equal(runtime.makeCommitment({ bound: BOUND, text: '晚饭前整理完', dueAt: T0 + 7200000 }).ok, true);
  const belief = runtime.assertBelief({ bound: BOUND, proposition: '用户喜欢散步', rootEvidenceIds: ['chat:session-hh17:1'], source: 'chat-confirmed' });
  assert.equal(belief.ok, true, JSON.stringify(belief));

  const injection = runtime.injectionFor({ bound: BOUND, budgetChars: 320 });
  assert.ok(injection.text.includes('整理相册'), 'working memory still injects the goal');
  assert.ok(injection.text.length <= 320);
  const wm = runtime.workingMemory({ bound: BOUND });
  assert.equal(wm.focusGoalId, goal.goalId);
  assert.equal(wm.goal.nextStep, '挑出重复照片');

  // New capabilities are inert and say so.
  const status = runtime.status({ bound: BOUND });
  assert.equal(status.agenda.state, 'disabled');
  assert.equal(status.heartbeat.state, 'disabled');
  assert.equal(status.receipts.agenda, 0, 'no agenda consumer ever ran');
  assert.equal(status.outbox.queued, 0);

  // Every new API is a no-op with respect to stored state while the switches are off.
  const probe = openProbe(root);
  const before = {
    events: Number(probe.get('SELECT COUNT(*) AS n FROM domain_events').n),
    outbox: Number(probe.get('SELECT COUNT(*) AS n FROM memory_outbox').n),
    items: Number(probe.get('SELECT COUNT(*) AS n FROM agenda_items').n),
    occurrences: Number(probe.get('SELECT COUNT(*) AS n FROM agenda_occurrences').n),
    state: Number(probe.get('SELECT COUNT(*) AS n FROM consumer_receipts WHERE consumer = ?', 'state').n),
  };
  probe.close();

  runtime.listSchedule({ bound: BOUND });
  runtime.todaySchedule({ bound: BOUND });
  runtime.createSchedule({ bound: BOUND, title: '不该落库', rule: 'daily', timeZone: 'Asia/Shanghai', time: '09:00' });
  runtime.updateSchedule({ bound: BOUND, itemId: 'ag_missing', expectedRevision: 1 });
  runtime.cancelSchedule({ bound: BOUND, itemId: 'ag_missing', expectedRevision: 1 });
  runtime.heartbeatStatus();
  runtime.pauseHeartbeat({ reason: 'should-not-apply' });
  runtime.resumeHeartbeat();
  runtime.runHeartbeatCycle();
  runtime.verifyRecovery({ bound: BOUND });

  const after = openProbe(root);
  const afterCounts = {
    events: Number(after.get('SELECT COUNT(*) AS n FROM domain_events').n),
    outbox: Number(after.get('SELECT COUNT(*) AS n FROM memory_outbox').n),
    items: Number(after.get('SELECT COUNT(*) AS n FROM agenda_items').n),
    occurrences: Number(after.get('SELECT COUNT(*) AS n FROM agenda_occurrences').n),
    state: Number(after.get('SELECT COUNT(*) AS n FROM consumer_receipts WHERE consumer = ?', 'state').n),
  };
  after.close();
  assert.deepEqual(afterCounts, before, 'disabled capabilities write nothing at all');

  // Recovery still reproduces the P1 projection and the (empty) agenda tables.
  const recovery = runtime.verifyRecovery({ bound: BOUND });
  assert.equal(recovery.ok, true, JSON.stringify(recovery.mismatches));
  assert.ok(recovery.replayed >= 6);

  // The bridge refuses to pretend success without a memory service, and never double-sends.
  const drained = runtime.drainOutbox({ bound: BOUND });
  assert.equal(Number(drained.processed ?? 0), 0);
  assert.equal(Number(drained.delivered ?? 0), 0);
  assert.equal(runtime.status({ bound: BOUND }).outbox.queued, 0);
});

test('HH17: an active agenda does not touch working memory, state or the memory outbox', t => {
  const root = buildRoot(t, {
    enabled: true, mode: 'active',
    agenda: { enabled: true },
    heartbeat: { enabled: true, pollIntervalMs: 300000 },
  });
  const runtime = mountRuntime(null, root, { now: () => T0, identity: identity() });
  t.after(() => runtime.dispose());
  const created = runtime.createSchedule({ bound: BOUND, title: '午后散步', rule: 'daily', timeZone: 'Asia/Shanghai', time: '16:00' });
  assert.equal(created.ok, true, JSON.stringify(created));
  runtime.runHeartbeatCycle();

  const status = runtime.status({ bound: BOUND });
  assert.equal(status.outbox.queued, 0, 'agenda never queues a memory write');
  assert.equal(status.receipts.state, 0, 'the heartbeat emits no state event');
  assert.equal(status.receipts['working-memory'], 0, 'a schedule is not a goal and does not move focus');
  assert.equal(status.goals.active, 0);
  assert.equal(status.agenda.items, 1);
  assert.ok(status.agenda.occurrences.scheduled + status.agenda.occurrences.due >= 1);

  // The working-memory injection has no agenda text and the P1 budget still applies.
  const injection = runtime.injectionFor({ bound: BOUND, budgetChars: 320 });
  assert.doesNotMatch(injection.text, /午后散步/, 'agenda content is not injected as working memory');

  // Cancelling a schedule must not create or close a commitment either.
  const cancelled = runtime.cancelSchedule({ bound: BOUND, itemId: created.itemId, expectedRevision: created.item.revision });
  assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
  assert.equal(runtime.status({ bound: BOUND }).goals.openCommitments, 0);
});
