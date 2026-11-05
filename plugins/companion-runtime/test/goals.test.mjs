// C2 goals & commitments — lifecycle, stale-write rejection, deadlines, commitments.
// A06 (commitment half) and the goals half of A03/A04 live here; working-memory.test.mjs
// covers focus/checkpoint/render. Every test uses :memory: or a throw-away temp file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openRuntimeDb } from '../lib/db.mjs';
import { scopeKey } from '../lib/scope.mjs';
import { RuntimeError, StaleRevisionError } from '../lib/errors.mjs';
import { applyEvent, dispatchEvent, eventCount, normalizeEvent, receiptFor } from '../lib/events.mjs';
import {
  AUTHORIZATION,
  GOAL_STATUS,
  applyGoalEvent,
  closeCommitment,
  createCommitment,
  getGoal,
  listCommitments,
  listGoals,
  markOverdue,
  proposeGoal,
  recordStep,
  transitionGoal,
  updateGoal,
} from '../lib/goals.mjs';

const SCOPE = { userId: 'u-goals', personaId: 'march7', worldId: 'w-goals' };
const OTHER = { userId: 'u-other', personaId: 'march7', worldId: 'w-other' };
const DAY = 86400000;

function makeClock(start = 1_760_000_000_000) {
  const clock = {
    value: start,
    tick(ms = 60000) { clock.value += ms; return clock.value; },
  };
  return clock;
}

function openMemory(clock) {
  return openRuntimeDb({ file: ':memory:', now: () => clock.value });
}

/** propose → accept → start, optionally with waitingOn and confirmed steps. */
function createRunning(db, clock, scope, options = {}) {
  const key = scopeKey(scope);
  const collection = listGoals(db, { scopeKey: key, includeClosed: true });
  const created = proposeGoal(db, {
    scope,
    title: options.title ?? '目标',
    source: options.source ?? 'test',
    authorization: options.authorization ?? 'none',
    deadlineAt: options.deadlineAt ?? null,
    nextStep: options.nextStep ?? '',
    now: clock.tick(),
    expectedRevision: collection.revision,
  });
  for (const to of ['accepted', 'running']) {
    transitionGoal(db, { scope, goalId: created.goalId, to, expectedRevision: getGoal(db, key, created.goalId).revision, now: clock.tick() });
  }
  if (options.waitingOn) {
    updateGoal(db, {
      scope, goalId: created.goalId, patch: { waitingOn: options.waitingOn },
      expectedRevision: getGoal(db, key, created.goalId).revision, now: clock.tick(),
    });
  }
  for (const step of options.steps ?? []) {
    recordStep(db, { scope, goalId: created.goalId, step, expectedRevision: getGoal(db, key, created.goalId).revision, now: clock.tick() });
  }
  return created.goalId;
}

function isCode(expected) {
  return error => {
    assert.equal(error.code, expected);
    assert.equal(error.name === 'StaleRevisionError', expected === 'stale-revision' || expected === 'stale-generation');
    return true;
  };
}

/** The goals consumer's own line in a dispatch result, independent of fan-out order. */
function goalsResult(outcome) {
  return outcome.results.find(result => result.consumer === 'goals');
}

test('goals: frozen status and authorization vocabularies', () => {
  assert.deepEqual([...GOAL_STATUS], ['proposed', 'accepted', 'running', 'paused', 'completed', 'cancelled']);
  assert.deepEqual([...AUTHORIZATION], ['none', 'reminder', 'tool', 'proactive-contact']);
  assert.ok(Object.isFrozen(GOAL_STATUS));
});

test('goals: proposed → accepted → running → paused → running → completed keeps compact history', () => {
  const clock = makeClock();
  const db = openMemory(clock);
  const key = scopeKey(SCOPE);
  const created = proposeGoal(db, {
    scope: SCOPE, title: '整理旅行清单', source: 'conversation', authorization: 'none',
    nextStep: '确认机票日期', now: clock.tick(), expectedRevision: 0,
  });
  assert.deepEqual([created.status, created.revision], ['proposed', 1]);
  for (const to of ['accepted', 'running', 'paused', 'running', 'completed']) {
    transitionGoal(db, { scope: SCOPE, goalId: created.goalId, to, expectedRevision: getGoal(db, key, created.goalId).revision, now: clock.tick() });
  }
  const goal = getGoal(db, key, created.goalId);
  assert.equal(goal.status, 'completed');
  assert.equal(goal.revision, 6);
  assert.deepEqual(goal.history.map(entry => entry.action), ['proposed', 'accepted', 'running', 'paused', 'running', 'completed']);
  for (const entry of goal.history) {
    assert.deepEqual(Object.keys(entry).sort(), ['action', 'at', 'reason', 'revision']);
    assert.equal(typeof entry.reason, 'string');
    assert.ok(!('title' in entry) && !('nextStep' in entry), 'history never stores plan bodies');
  }
  // collection revision advanced alongside the plan.
  assert.ok(listGoals(db, { scopeKey: key, includeClosed: true }).revision >= 6);
  db.close();
});

test('goals: every mutation requires expectedRevision and stale writes never overwrite', () => {
  const clock = makeClock();
  const db = openMemory(clock);
  const key = scopeKey(SCOPE);
  const goalId = createRunning(db, clock, SCOPE, { title: '写周报', steps: ['列提纲'] });
  const before = getGoal(db, key, goalId);
  recordStep(db, { scope: SCOPE, goalId, step: '补数据', expectedRevision: before.revision, now: clock.tick() });
  const moved = getGoal(db, key, goalId);
  assert.equal(moved.revision, before.revision + 1);

  assert.throws(
    () => transitionGoal(db, { scope: SCOPE, goalId, to: 'paused', expectedRevision: before.revision, now: clock.tick() }),
    error => error instanceof StaleRevisionError && error.code === 'stale-revision' && error.detail.actual === before.revision + 1,
  );
  assert.throws(() => recordStep(db, { scope: SCOPE, goalId, step: '第三步', now: clock.tick() }), isCode('invalid-input'));
  assert.throws(() => transitionGoal(db, { scope: SCOPE, goalId, to: 'paused', now: clock.tick() }), isCode('invalid-input'));
  assert.throws(() => updateGoal(db, { scope: SCOPE, goalId, patch: { title: '改标题' }, now: clock.tick() }), isCode('invalid-input'));

  const after = getGoal(db, key, goalId);
  assert.equal(after.status, 'running');
  assert.equal(after.title, '写周报');
  assert.deepEqual(after.completedSteps, ['列提纲', '补数据']);
  db.close();
});

test('goals: proposeGoal guards the goals collection revision', () => {
  const clock = makeClock();
  const db = openMemory(clock);
  const key = scopeKey(SCOPE);
  proposeGoal(db, { scope: SCOPE, title: '第一个', now: clock.tick(), expectedRevision: 0 });
  assert.throws(
    () => proposeGoal(db, { scope: SCOPE, title: '第二个', now: clock.tick(), expectedRevision: 0 }),
    error => error.code === 'stale-revision',
  );
  assert.throws(() => proposeGoal(db, { scope: SCOPE, title: '第三个', now: clock.tick() }), isCode('invalid-input'));
  const list = listGoals(db, { scopeKey: key });
  assert.equal(list.length, 1);
  proposeGoal(db, { scope: SCOPE, title: '第二个', now: clock.tick(), expectedRevision: list.revision });
  assert.equal(listGoals(db, { scopeKey: key }).length, 2);
  db.close();
});

test('goals: completed and cancelled are terminal, a new goal is required', () => {
  const clock = makeClock();
  const db = openMemory(clock);
  const key = scopeKey(SCOPE);
  const done = createRunning(db, clock, SCOPE, { title: '已完成目标' });
  transitionGoal(db, { scope: SCOPE, goalId: done, to: 'completed', expectedRevision: getGoal(db, key, done).revision, now: clock.tick() });
  const frozen = getGoal(db, key, done);
  assert.throws(() => transitionGoal(db, { scope: SCOPE, goalId: done, to: 'running', expectedRevision: frozen.revision, now: clock.tick() }), isCode('terminal-state'));
  assert.throws(() => transitionGoal(db, { scope: SCOPE, goalId: done, to: 'cancelled', expectedRevision: frozen.revision, now: clock.tick() }), isCode('terminal-state'));
  assert.throws(() => recordStep(db, { scope: SCOPE, goalId: done, step: '补一步', expectedRevision: frozen.revision, now: clock.tick() }), isCode('terminal-state'));
  assert.throws(() => updateGoal(db, { scope: SCOPE, goalId: done, patch: { nextStep: '新一步' }, expectedRevision: frozen.revision, now: clock.tick() }), isCode('terminal-state'));
  assert.equal(getGoal(db, key, done).status, 'completed');
  assert.equal(getGoal(db, key, done).revision, frozen.revision);

  const cancelled = createRunning(db, clock, SCOPE, { title: '取消目标' });
  transitionGoal(db, { scope: SCOPE, goalId: cancelled, to: 'cancelled', expectedRevision: getGoal(db, key, cancelled).revision, now: clock.tick() });
  assert.throws(() => transitionGoal(db, { scope: SCOPE, goalId: cancelled, to: 'completed', expectedRevision: getGoal(db, key, cancelled).revision, now: clock.tick() }), isCode('terminal-state'));

  // A follow-up task is a new goal, never a revival.
  const next = createRunning(db, clock, SCOPE, { title: '后续目标' });
  assert.notEqual(next, done);
  assert.equal(listGoals(db, { scopeKey: key, includeClosed: true }).length, 3);
  db.close();
});

test('goals: only the transitions in the contract are accepted', () => {
  const clock = makeClock();
  const db = openMemory(clock);
  const key = scopeKey(SCOPE);
  const created = proposeGoal(db, { scope: SCOPE, title: '生命周期', now: clock.tick(), expectedRevision: 0 });
  const goalId = created.goalId;
  for (const to of ['running', 'paused', 'completed']) {
    assert.throws(() => transitionGoal(db, { scope: SCOPE, goalId, to, expectedRevision: getGoal(db, key, goalId).revision, now: clock.tick() }), isCode('invalid-transition'));
  }
  assert.equal(getGoal(db, key, goalId).status, 'proposed', 'a refused transition starts nothing');
  // The only legal way out of proposed is the explicit acceptance step.
  transitionGoal(db, { scope: SCOPE, goalId, to: 'accepted', expectedRevision: getGoal(db, key, goalId).revision, now: clock.tick() });
  assert.equal(getGoal(db, key, goalId).status, 'accepted');
  assert.throws(() => transitionGoal(db, { scope: SCOPE, goalId, to: 'proposed', expectedRevision: getGoal(db, key, goalId).revision, now: clock.tick() }), isCode('invalid-transition'));
  transitionGoal(db, { scope: SCOPE, goalId, to: 'running', expectedRevision: getGoal(db, key, goalId).revision, now: clock.tick() });
  assert.equal(getGoal(db, key, goalId).status, 'running');
  assert.throws(() => transitionGoal(db, { scope: SCOPE, goalId, to: 'archived', expectedRevision: getGoal(db, key, goalId).revision, now: clock.tick() }), isCode('invalid-input'));
  // From accepted, completed still needs a running phase.
  const second = proposeGoal(db, { scope: SCOPE, title: '第二个生命周期', now: clock.tick(), expectedRevision: listGoals(db, { scopeKey: key }).revision });
  transitionGoal(db, { scope: SCOPE, goalId: second.goalId, to: 'accepted', expectedRevision: 1, now: clock.tick() });
  assert.throws(
    () => transitionGoal(db, { scope: SCOPE, goalId: second.goalId, to: 'completed', expectedRevision: 2, now: clock.tick() }),
    isCode('invalid-transition'),
  );
  db.close();
});

test('goals: proposed → running is rejected — the frozen matrix has no shortcut (B7)', () => {
  const clock = makeClock();
  const db = openMemory(clock);
  const key = scopeKey(SCOPE);
  const created = proposeGoal(db, { scope: SCOPE, title: '直接开始', now: clock.tick(), expectedRevision: 0 });
  const before = getGoal(db, key, created.goalId);
  assert.equal(before.status, 'proposed');

  assert.throws(
    () => transitionGoal(db, { scope: SCOPE, goalId: created.goalId, to: 'running', expectedRevision: before.revision, now: clock.tick() }),
    isCode('invalid-transition'),
  );
  let after = getGoal(db, key, created.goalId);
  assert.deepEqual([after.status, after.revision], ['proposed', before.revision], 'a refused shortcut writes nothing');
  assert.deepEqual(after.history.map(entry => entry.action), ['proposed'], 'no running entry may be forged');

  // The event path obeys the same matrix instead of trusting the caller's intent.
  const refused = dispatchEvent(db, {
    scope: SCOPE, kind: 'goal/started', occurredAt: clock.tick(),
    payload: { goalId: created.goalId, expectedRevision: before.revision },
  }, { handlers: { goals: applyGoalEvent } });
  assert.equal(goalsResult(refused).code, 'invalid-transition');
  assert.equal(refused.rejected, true);
  assert.equal(refused.inserted, false);
  assert.equal(receiptFor(db, 'goals', refused.event.eventId), null);
  after = getGoal(db, key, created.goalId);
  assert.deepEqual([after.status, after.revision], ['proposed', before.revision]);

  // "Just start it" is two recorded steps, not one rewritten status.
  transitionGoal(db, { scope: SCOPE, goalId: created.goalId, to: 'accepted', expectedRevision: after.revision, now: clock.tick() });
  transitionGoal(db, { scope: SCOPE, goalId: created.goalId, to: 'running', expectedRevision: getGoal(db, key, created.goalId).revision, now: clock.tick() });
  after = getGoal(db, key, created.goalId);
  assert.equal(after.status, 'running');
  assert.deepEqual(after.history.map(entry => entry.action), ['proposed', 'accepted', 'running']);
  assert.deepEqual(after.history.map(entry => entry.revision), [1, 2, 3], 'each step keeps its own revision');
  db.close();
});

test('goals: steps are appended once, in order, and only on an open goal', () => {
  const clock = makeClock();
  const db = openMemory(clock);
  const key = scopeKey(SCOPE);
  const goalId = createRunning(db, clock, SCOPE, { title: '步骤' });
  for (const step of ['查天气', '列装备']) {
    const result = recordStep(db, { scope: SCOPE, goalId, step, expectedRevision: getGoal(db, key, goalId).revision, now: clock.tick() });
    assert.equal(result.duplicated, false);
  }
  const goal = getGoal(db, key, goalId);
  assert.deepEqual(goal.completedSteps, ['查天气', '列装备']);
  const duplicate = recordStep(db, { scope: SCOPE, goalId, step: '查天气', expectedRevision: getGoal(db, key, goalId).revision, now: clock.tick() });
  assert.equal(duplicate.duplicated, true);
  assert.equal(getGoal(db, key, goalId).revision, goal.revision, 'a repeated step is a no-op, not a new revision');
  assert.deepEqual(getGoal(db, key, goalId).completedSteps, ['查天气', '列装备']);
  // A stale duplicate is NOT a no-op any more: the fence comes first (B3).
  assert.throws(() => recordStep(db, { scope: SCOPE, goalId, step: '查天气', expectedRevision: 1, now: clock.tick() }), isCode('stale-revision'));
  assert.deepEqual(getGoal(db, key, goalId).completedSteps, ['查天气', '列装备']);
  assert.throws(() => recordStep(db, { scope: SCOPE, goalId, step: '  ', expectedRevision: goal.revision, now: clock.tick() }), isCode('invalid-input'));
  db.close();
});

test('goals: authorization stays separate from plan text and never upgrades itself', () => {
  const clock = makeClock();
  const db = openMemory(clock);
  const key = scopeKey(SCOPE);
  const goalId = createRunning(db, clock, SCOPE, { title: '给妈妈打电话' });
  // Plan text that mentions a reminder is still plan text.
  updateGoal(db, {
    scope: SCOPE, goalId,
    patch: { title: '提醒我给妈妈打电话', nextStep: '提醒我周末提醒她' },
    expectedRevision: getGoal(db, key, goalId).revision, now: clock.tick(),
  });
  let goal = getGoal(db, key, goalId);
  assert.equal(goal.authorization, 'none');
  assert.equal(goal.title, '提醒我给妈妈打电话');
  assert.ok(goal.history.at(-1).reason.includes('title'));

  // Only an explicit field moves it.
  updateGoal(db, { scope: SCOPE, goalId, patch: { authorization: 'reminder' }, expectedRevision: goal.revision, now: clock.tick() });
  goal = getGoal(db, key, goalId);
  assert.equal(goal.authorization, 'reminder');
  assert.ok(goal.history.at(-1).reason.includes('authorization'));

  // And it survives later plan updates without being escalated further.
  updateGoal(db, { scope: SCOPE, goalId, patch: { nextStep: '打电话' }, expectedRevision: goal.revision, now: clock.tick() });
  assert.equal(getGoal(db, key, goalId).authorization, 'reminder');
  assert.throws(
    () => updateGoal(db, { scope: SCOPE, goalId, patch: { authorization: 'send-message' }, expectedRevision: getGoal(db, key, goalId).revision, now: clock.tick() }),
    isCode('invalid-input'),
  );
  assert.throws(
    () => updateGoal(db, { scope: SCOPE, goalId, patch: { status: 'completed' }, expectedRevision: getGoal(db, key, goalId).revision, now: clock.tick() }),
    isCode('invalid-input'),
  );
  db.close();
});

test('goals: a passed deadline only sets overdue — no auto complete, no delete', () => {
  const clock = makeClock();
  const db = openMemory(clock);
  const key = scopeKey(SCOPE);
  const late = createRunning(db, clock, SCOPE, { title: '过期目标', deadlineAt: clock.value - 3600000, steps: ['查天气'] });
  const later = createRunning(db, clock, SCOPE, { title: '未到期目标', deadlineAt: clock.value + 30 * DAY });
  const closed = createRunning(db, clock, SCOPE, { title: '已取消目标', deadlineAt: clock.value - 3600000 });
  transitionGoal(db, { scope: SCOPE, goalId: closed, to: 'cancelled', expectedRevision: getGoal(db, key, closed).revision, now: clock.tick() });
  const lateRevision = getGoal(db, key, late).revision;

  clock.tick(DAY);
  const sweep = markOverdue(db, { scopeKey: key, now: clock.value });
  assert.deepEqual(sweep.goalIds, [late]);
  assert.equal(sweep.marked, 1);

  const lateGoal = getGoal(db, key, late);
  assert.equal(lateGoal.status, 'running', 'overdue never completes the goal');
  assert.equal(lateGoal.overdue, true);
  assert.equal(lateGoal.revision, lateRevision, 'the derived overdue flag does not advance the plan revision');
  assert.deepEqual(lateGoal.completedSteps, ['查天气']);
  assert.equal(lateGoal.history.at(-1).action, 'overdue');
  assert.equal(getGoal(db, key, later).overdue, false);
  assert.equal(getGoal(db, key, closed).overdue, false);
  assert.equal(listGoals(db, { scopeKey: key, includeClosed: true }).length, 3, 'the goal is still there');

  // Idempotent sweep.
  assert.deepEqual(markOverdue(db, { scopeKey: key, now: clock.value }).goalIds, []);
  // A normal mutation still works right after the sweep (revision untouched by it).
  recordStep(db, { scope: SCOPE, goalId: late, step: '列装备', expectedRevision: lateGoal.revision, now: clock.tick() });
  assert.equal(getGoal(db, key, late).status, 'running');
  db.close();
});

test('commitments: silence and TTL never close them, only an explicit close does (A06)', () => {
  const clock = makeClock();
  const db = openMemory(clock);
  const key = scopeKey(SCOPE);
  const goalId = createRunning(db, clock, SCOPE, { title: '约定', steps: ['约时间'] });
  const dueSoon = createCommitment(db, { scope: SCOPE, text: '周末回她消息', dueAt: clock.value + 3600000, goalId, now: clock.tick() });
  const past = createCommitment(db, { scope: SCOPE, text: '寄出快递', dueAt: clock.value - DAY, now: clock.tick() });
  assert.equal(dueSoon.status, 'open');
  assert.equal(dueSoon.revision, 1);

  // Long silence: no reply, no acknowledgement, only time passing and sweeps.
  const before = listCommitments(db, { scopeKey: key, status: 'open' });
  for (let round = 0; round < 5; round += 1) {
    clock.tick(8 * DAY);
    markOverdue(db, { scopeKey: key, now: clock.value });
  }
  const open = listCommitments(db, { scopeKey: key, status: 'open' });
  assert.equal(open.length, 2, 'a commitment is never expired by TTL');
  assert.deepEqual(open.map(commitment => commitment.text).sort(), ['周末回她消息', '寄出快递'].sort());
  assert.deepEqual(open.map(commitment => commitment.revision), [1, 1]);
  assert.deepEqual(open.map(commitment => commitment.updatedAt), before.map(commitment => commitment.updatedAt));
  assert.equal(open.find(commitment => commitment.commitmentId === past.commitmentId).overdue, true, 'derived flag only');
  assert.equal(open.find(commitment => commitment.commitmentId === past.commitmentId).status, 'open');

  // Completing the linked goal does not close anything either.
  transitionGoal(db, { scope: SCOPE, goalId, to: 'completed', expectedRevision: getGoal(db, key, goalId).revision, now: clock.tick() });
  assert.equal(listCommitments(db, { scopeKey: key, status: 'open' }).length, 2);

  // Explicit close, with the optional revision guard.
  assert.throws(
    () => closeCommitment(db, { scope: SCOPE, commitmentId: dueSoon.commitmentId, expectedRevision: 9, now: clock.tick() }),
    isCode('stale-revision'),
  );
  const closed = closeCommitment(db, { scope: SCOPE, commitmentId: dueSoon.commitmentId, reason: 'user-confirmed', expectedRevision: 1, now: clock.tick() });
  assert.equal(closed.status, 'closed');
  assert.equal(closed.kept, false);
  assert.equal(listCommitments(db, { scopeKey: key, status: 'open' }).length, 1);
  const kept = closeCommitment(db, { scope: SCOPE, commitmentId: dueSoon.commitmentId, now: clock.tick() });
  assert.equal(kept.kept, true, 'closing twice is a no-op');
  assert.throws(() => closeCommitment(db, { scope: SCOPE, commitmentId: 'cm_missing', now: clock.tick() }), isCode('unknown-commitment'));
  assert.throws(() => createCommitment(db, { scope: SCOPE, text: '   ', now: clock.tick() }), isCode('invalid-input'));
  db.close();
});

test('goals: two scopes in one database never see each other', () => {
  const clock = makeClock();
  const db = openMemory(clock);
  const keyA = scopeKey(SCOPE);
  const keyB = scopeKey(OTHER);
  const goalA = createRunning(db, clock, SCOPE, { title: 'A 的旅行清单' });
  const goalB = createRunning(db, clock, OTHER, { title: 'B 的周报' });
  const commitmentA = createCommitment(db, { scope: SCOPE, text: 'A 的承诺', dueAt: clock.value + DAY, now: clock.tick() });
  createCommitment(db, { scope: OTHER, text: 'B 的承诺', dueAt: clock.value + DAY, now: clock.tick() });

  assert.deepEqual(listGoals(db, { scopeKey: keyA }).map(goal => goal.goalId), [goalA]);
  assert.deepEqual(listGoals(db, { scopeKey: keyB }).map(goal => goal.goalId), [goalB]);
  assert.equal(getGoal(db, keyB, goalA), null);
  assert.equal(getGoal(db, keyA, goalB), null);
  assert.deepEqual(listCommitments(db, { scopeKey: keyA }).map(commitment => commitment.commitmentId), [commitmentA.commitmentId]);

  assert.throws(
    () => transitionGoal(db, { scope: SCOPE, goalId: goalB, to: 'paused', expectedRevision: getGoal(db, keyB, goalB).revision, now: clock.tick() }),
    isCode('unknown-goal'),
  );
  assert.throws(
    () => recordStep(db, { scope: OTHER, goalId: goalA, step: '越界', expectedRevision: 1, now: clock.tick() }),
    isCode('unknown-goal'),
  );
  assert.throws(
    () => createCommitment(db, { scope: SCOPE, text: '借用别人目标', goalId: goalB, now: clock.tick() }),
    isCode('unknown-goal'),
  );
  assert.throws(
    () => closeCommitment(db, { scope: OTHER, commitmentId: commitmentA.commitmentId, now: clock.tick() }),
    isCode('unknown-commitment'),
  );
  assert.throws(
    () => proposeGoal(db, { scope: SCOPE, scopeKey: keyB, title: '身份矛盾', now: clock.tick(), expectedRevision: 1 }),
    isCode('scope-denied'),
  );
  db.close();
});

test('goals reducer: events persist through applyEvent and a re-delivery is a no-op', () => {
  const clock = makeClock();
  const db = openMemory(clock);
  const key = scopeKey(SCOPE);
  const handlers = { goals: applyGoalEvent };
  const base = { scope: SCOPE, realityStatus: 'actual_tool_activity', evidenceStatus: 'confirmed' };
  const goalId = 'goal_event_1';

  const proposed = dispatchEvent(db, { ...base, kind: 'goal/proposed', occurredAt: clock.tick(), payload: { goalId, title: '事件目标', nextStep: '第一步' } }, { handlers });
  assert.equal(proposed.results[0].applied, true);
  dispatchEvent(db, { ...base, kind: 'goal/accepted', occurredAt: clock.tick(), payload: { goalId, expectedRevision: 1 } }, { handlers });
  dispatchEvent(db, { ...base, kind: 'goal/started', occurredAt: clock.tick(), payload: { goalId, expectedRevision: 2 } }, { handlers });
  dispatchEvent(db, { ...base, kind: 'goal/step', occurredAt: clock.tick(), payload: { goalId, step: '确认机票日期', expectedRevision: 3 } }, { handlers });
  const updatedEvent = { ...base, kind: 'goal/updated', occurredAt: clock.tick(), payload: { goalId, patch: { waitingOn: '她确认周末时间' }, expectedRevision: 4 } };
  dispatchEvent(db, updatedEvent, { handlers });

  let goal = getGoal(db, key, goalId);
  assert.equal(goal.status, 'running');
  assert.deepEqual(goal.completedSteps, ['确认机票日期']);
  assert.equal(goal.waitingOn, '她确认周末时间');
  const receipts = Number(db.get("SELECT COUNT(*) AS n FROM consumer_receipts WHERE consumer = 'goals' AND scope = ?", key).n);
  assert.equal(receipts, 5);

  // Same event again: no new row, no new receipt, no revision move.
  const replay = dispatchEvent(db, updatedEvent, { handlers });
  assert.equal(replay.inserted, false);
  assert.equal(replay.results[0].duplicate, true);
  goal = getGoal(db, key, goalId);
  assert.equal(goal.title, '事件目标');
  assert.equal(goal.status, 'running');
  assert.equal(Number(db.get("SELECT COUNT(*) AS n FROM consumer_receipts WHERE consumer = 'goals' AND scope = ?", key).n), 5);

  // An event that carries an outdated revision is refused and rolled back (A07 for goals).
  const stale = dispatchEvent(db, { ...base, kind: 'goal/completed', occurredAt: clock.tick(), payload: { goalId, expectedRevision: 3 } }, { handlers });
  assert.equal(stale.results[0].applied, false);
  assert.equal(stale.results[0].code, 'stale-revision');
  assert.equal(getGoal(db, key, goalId).status, 'running');
  assert.equal(receiptFor(db, 'goals', stale.event.eventId), null);
  db.close();
});

test('goals reducer: only its own event kinds are handled', () => {
  const clock = makeClock();
  const db = openMemory(clock);
  const key = scopeKey(SCOPE);
  for (const kind of ['state/impulse', 'topic/switch', 'belief/asserted', 'memory/ingest-request']) {
    assert.deepEqual(applyGoalEvent({ db, event: { kind, scopeKey: key, eventId: `evt_${kind}`, payload: {} }, slice: {}, now: clock.value }), {});
  }
  assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM goals').n), 0);
  assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM commitments').n), 0);
  db.close();
});

test('goals reducer: a stale re-delivery is refused at handler level and deduped at dispatch level', () => {
  const clock = makeClock();
  const db = openMemory(clock);
  const key = scopeKey(SCOPE);
  const event = { eventId: 'evt_manual_1', kind: 'goal/proposed', scope: SCOPE, scopeKey: key, payload: { goalId: 'goal_manual', title: '手工', nextStep: '' } };
  const stepEvent = {
    eventId: 'evt_manual_2', kind: 'goal/step', scope: SCOPE, scopeKey: key,
    payload: { goalId: 'goal_manual', step: '第一步', expectedRevision: 1 },
  };
  db.tx(() => {
    applyGoalEvent({ db, event, slice: {}, now: clock.value }).extra(db, event);
    applyGoalEvent({ db, event, slice: {}, now: clock.value }).extra(db, event);
    applyGoalEvent({ db, event: stepEvent, slice: {}, now: clock.value }).extra(db, stepEvent);
    // A direct handler re-execution is not the dedupe mechanism: the consumer receipt is.
    // With the fence first, replaying an applied event by hand is refused, not silently kept.
    assert.throws(
      () => applyGoalEvent({ db, event: stepEvent, slice: {}, now: clock.value }).extra(db, stepEvent),
      isCode('stale-revision'),
    );
  });
  const goals = db.all('SELECT * FROM goals WHERE scope = ?', key);
  assert.equal(goals.length, 1);
  assert.deepEqual(JSON.parse(goals[0].completed_steps), ['第一步']);

  // The real duplicate path is the receipt: dispatch the same event twice.
  const handlers = { goals: args => applyGoalEvent(args) };
  const normalized = normalizeEvent({
    kind: 'goal/step', scope: SCOPE, occurredAt: clock.tick(),
    payload: { goalId: 'goal_manual', step: '第二步', expectedRevision: 2 },
  });
  const first = dispatchEvent(db, normalized, { handlers });
  const second = dispatchEvent(db, normalized, { handlers });
  assert.equal(first.inserted, true);
  assert.equal(second.inserted, false);
  assert.equal(second.results.find(result => result.consumer === 'goals').duplicate, true);
  assert.deepEqual(JSON.parse(db.get('SELECT completed_steps FROM goals WHERE scope = ?', key).completed_steps), ['第一步', '第二步']);
  db.close();
});

test('goals reducer: every goal-mutating event must carry expectedRevision (B3)', () => {
  const clock = makeClock();
  const db = openMemory(clock);
  const key = scopeKey(SCOPE);
  const goalId = createRunning(db, clock, SCOPE, { title: '围栏目标', nextStep: '下一步', waitingOn: '等回复', steps: ['一步'] });
  const before = getGoal(db, key, goalId);
  const base = { scope: SCOPE, realityStatus: 'actual_tool_activity', evidenceStatus: 'confirmed' };
  const fenced = ['goal/accepted', 'goal/started', 'goal/paused', 'goal/resumed', 'goal/completed', 'goal/cancelled', 'goal/step', 'goal/updated'];
  const payloadFor = kind => (kind === 'goal/step'
    ? { goalId, step: '两步' }
    : kind === 'goal/updated'
      ? { goalId, patch: { waitingOn: '她确认周末' } }
      : { goalId });

  for (const kind of fenced) {
    const outcome = dispatchEvent(db, { ...base, kind, occurredAt: clock.tick(), payload: payloadFor(kind) }, { handlers: { goals: applyGoalEvent } });
    assert.equal(goalsResult(outcome).code, 'revision-required', `${kind} must demand a revision`);
    assert.equal(goalsResult(outcome).deterministic, true, `${kind} rejection is a deterministic refusal`);
    assert.equal(outcome.rejected, true, `${kind} rolls the whole event back`);
    assert.equal(outcome.inserted, false, `${kind} never enters the log`);
    assert.equal(eventCount(db, key), 0, `${kind} leaves no event row`);
    assert.equal(receiptFor(db, 'goals', outcome.event.eventId), null, `${kind} writes no receipt`);
    const after = getGoal(db, key, goalId);
    assert.deepEqual(
      [after.status, after.revision, after.nextStep, after.waitingOn, after.completedSteps, after.history.length],
      [before.status, before.revision, before.nextStep, before.waitingOn, before.completedSteps, before.history.length],
      `${kind} changes no row`,
    );
  }

  // Non-revision values are not silently coerced into a revision.
  for (const expectedRevision of ['soon', {}]) {
    const outcome = dispatchEvent(db, { ...base, kind: 'goal/paused', occurredAt: clock.tick(), payload: { goalId, expectedRevision } }, { handlers: { goals: applyGoalEvent } });
    assert.equal(goalsResult(outcome).code, 'revision-required');
    assert.equal(getGoal(db, key, goalId).status, 'running');
  }

  // Called directly (no receipt layer around it) the reducer throws the typed refusal.
  const direct = { eventId: 'evt_direct', kind: 'goal/paused', scope: SCOPE, scopeKey: key, occurredAt: clock.value, payload: { goalId } };
  assert.throws(
    () => applyGoalEvent({ db, event: direct, slice: {}, now: clock.value }).extra(db, direct),
    error => error instanceof RuntimeError && error.code === 'revision-required',
  );
  assert.equal(getGoal(db, key, goalId).status, 'running');

  // goal/proposed (insert) and goal/overdue (derived flag) stay exempt.
  const proposed = dispatchEvent(db, { ...base, kind: 'goal/proposed', occurredAt: clock.tick(), payload: { goalId: 'goal_exempt', title: '豁免' } }, { handlers: { goals: applyGoalEvent } });
  assert.equal(goalsResult(proposed).applied, true);
  const overdue = dispatchEvent(db, { ...base, kind: 'goal/overdue', occurredAt: clock.tick(), payload: {} }, { handlers: { goals: applyGoalEvent } });
  assert.equal(goalsResult(overdue).applied, true);
  db.close();
});

test('goals reducer: a stale expectedRevision is refused and leaves no trace (B3/A07)', () => {
  const clock = makeClock();
  const db = openMemory(clock);
  const key = scopeKey(SCOPE);
  const goalId = createRunning(db, clock, SCOPE, { title: '过期版本', steps: ['一步'] });
  const before = getGoal(db, key, goalId);
  const base = { scope: SCOPE, realityStatus: 'actual_tool_activity', evidenceStatus: 'confirmed' };

  const stale = dispatchEvent(db, { ...base, kind: 'goal/completed', occurredAt: clock.tick(), payload: { goalId, expectedRevision: before.revision + 5 } }, { handlers: { goals: applyGoalEvent } });
  assert.equal(goalsResult(stale).code, 'stale-revision');
  assert.equal(goalsResult(stale).deterministic, true);
  assert.equal(stale.rejected, true);
  assert.equal(stale.inserted, false, 'the refused event never enters the log');
  assert.equal(eventCount(db, key), 0);
  assert.equal(receiptFor(db, 'goals', stale.event.eventId), null, 'no receipt is written');
  let after = getGoal(db, key, goalId);
  assert.deepEqual(
    [after.status, after.revision, after.history.length],
    [before.status, before.revision, before.history.length],
    'the plan is untouched',
  );

  // The same payload with the revision the caller actually read still applies: the fence
  // refuses stale writers, not event-sourced writes in general.
  const honest = dispatchEvent(db, { ...base, kind: 'goal/completed', occurredAt: clock.tick(), payload: { goalId, expectedRevision: after.revision } }, { handlers: { goals: applyGoalEvent } });
  assert.equal(goalsResult(honest).applied, true);
  after = getGoal(db, key, goalId);
  assert.deepEqual([after.status, after.revision], ['completed', before.revision + 1]);
  db.close();
});

test('goals: a file-backed database survives a restart with the same rows', () => {
  const clock = makeClock();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-goals-restart-'));
  const file = path.join(dir, 'runtime.db');
  try {
    let db = openRuntimeDb({ file, now: () => clock.value });
    const key = scopeKey(SCOPE);
    const goalId = createRunning(db, clock, SCOPE, { title: '重启目标', nextStep: '确认机票日期', steps: ['查天气'] });
    const commitment = createCommitment(db, { scope: SCOPE, text: '重启承诺', dueAt: clock.value + DAY, goalId, now: clock.tick() });
    const before = getGoal(db, key, goalId);
    db.close();

    db = openRuntimeDb({ file, now: () => clock.value });
    const after = getGoal(db, key, goalId);
    assert.deepEqual(after, before);
    assert.equal(listCommitments(db, { scopeKey: key, status: 'open' })[0].commitmentId, commitment.commitmentId);
    assert.equal(listGoals(db, { scopeKey: key }).length, 1);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('goals: applyEvent wires the reducer slice and receipt in one commit', () => {
  const clock = makeClock();
  const db = openMemory(clock);
  const key = scopeKey(SCOPE);
  const event = {
    eventId: 'evt_slice_1', kind: 'goal/proposed', scope: SCOPE, scopeKey: key,
    occurredAt: clock.tick(), payload: { goalId: 'goal_slice', title: '切片', source: 'test' },
  };
  const outcome = applyEvent(db, { consumer: 'goals', event, apply: applyGoalEvent });
  assert.equal(outcome.applied, true);
  assert.equal(outcome.result.goalId, 'goal_slice');
  const projection = db.projection(key);
  assert.equal(projection.payload.goals.active, 1);
  assert.equal(projection.payload.goals.revision, 1);
  assert.equal(projection.payload.goals.lastEventId, 'evt_slice_1');
  assert.ok(receiptFor(db, 'goals', 'evt_slice_1'));
  db.close();
});
