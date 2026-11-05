import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openRuntimeDb } from '../lib/db.mjs';
import { dispatchEvent, listEvents } from '../lib/events.mjs';
import { scopeKey as keyOfScope } from '../lib/scope.mjs';
import { applyPlanEvent, createPlanner, protectedWindows } from '../lib/planner.mjs';

// P2-04 — manual and fixed arrangements are protected structurally (amendment BLOCK-4).
//
// The counter-example is a real H1 item created through the H1 writer with
// `authorization:'plan'` — the same shape production uses — not `reminder`. Both layers
// are asserted: the planner refuses to *produce* an overlapping plan, and the reducer
// refuses to *write* one even if a hand-written event tries, leaving the H1 rows untouched.

const TZ = 'Asia/Shanghai';
const MIN = 60000;
const HOUR = 3600000;
const DAY = 86400000;
const SCOPE = Object.freeze({ userId: 'owner-1', personaId: 'march7', worldId: 'world:default' });
const KEY = keyOfScope(SCOPE);
const T0 = Date.UTC(2026, 10, 2, 5, 41, 0); // 2026-11-02 13:41 Asia/Shanghai
// 14:00–15:00 local: a 60-minute appointment the user already made.
const APPT_START = T0 + 19 * MIN;
const APPT_END = T0 + 79 * MIN;

function makeWorld(t) {
  const clock = { value: T0 };
  const db = openRuntimeDb({ file: ':memory:', now: () => clock.value });
  t.after(() => { try { db.close(); } catch { /* already closed */ } });
  const owner = 'owner-test';
  const generation = 'gen-test';
  assert.equal(db.acquireLease({ owner, generation, ttlMs: 7 * DAY }).ok, true);
  db.commitProjection({ scope: KEY, generation, payload: {} });
  const dispatch = input => dispatchEvent(db, input, { handlers: { autonomy: applyPlanEvent }, generation, requireConsumers: true });
  function expectOk(input) {
    const outcome = dispatch(input);
    assert.equal(outcome.rejected, false, JSON.stringify(outcome.results));
    return outcome;
  }
  function expectRejected(input) {
    const outcome = dispatch(input);
    assert.equal(outcome.rejected, true, 'a refused plan must not be appended');
    return (outcome.results ?? []).find(result => result.error)?.code ?? 'unknown';
  }
  return { clock, db, owner, generation, dispatch, expectOk, expectRejected };
}

/** Seed a real H1 definition + occurrence, the way H1's writer would (test setup only). */
function seedAgendaItem(world, { itemId = 'item_call', authorization = 'plan', title = '用户约好的电话', startAt = APPT_START, endAt = APPT_END } = {}) {
  world.db.run(`INSERT INTO agenda_items (item_id, scope, revision, title, category, source, rule_kind, time_zone,
    local_date, local_time, weekdays, at_utc, valid_from, valid_until, status, authorization, delivery,
    goal_ref, commitment_ref, request_key, resolution, created_at, updated_at)
    VALUES (?, ?, 1, ?, 'plan', 'tool', 'once', 'Asia/Shanghai', '2026-11-02', '14:00', '[]', ?, 0, NULL,
    'active', ?, 'none', '', '', ?, '{}', 0, 0)`,
  itemId, KEY, title, startAt, authorization, `req_${itemId}`);
  world.db.run(`INSERT INTO agenda_occurrences (occurrence_id, scope, item_id, slot_key, definition_revision, scheduled_at,
    slot_end_at, status, reason_code, revision, attempts, last_error, causation_event_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?, 'scheduled', '', 1, 0, '', '', 0, 0)`,
  `occ_${itemId}`, KEY, itemId, `once:${startAt}`, startAt, endAt);
}

function agendaSnapshot(world) {
  return {
    items: world.db.all('SELECT item_id, revision, status, authorization, title FROM agenda_items WHERE scope = ? ORDER BY item_id', KEY),
    occurrences: world.db.all('SELECT occurrence_id, item_id, scheduled_at, slot_end_at, status, revision FROM agenda_occurrences WHERE scope = ? ORDER BY occurrence_id', KEY),
  };
}

function scriptedModel(script) {
  const calls = [];
  const fn = async (request) => {
    calls.push(request);
    const index = Math.min(calls.length - 1, script.length - 1);
    const answer = script[index];
    const value = typeof answer === 'function' ? await answer(request, calls.length) : answer;
    if (value && typeof value === 'object' && typeof value.text === 'string') return value;
    return { text: typeof value === 'string' ? value : JSON.stringify(value), provider: 'script', model: 'script-v1', inputTokens: 90, outputTokens: 40 };
  };
  fn.calls = calls;
  return fn;
}

function makeMaterials(world, overrides = {}) {
  const fixedAgenda = () => world.db.all(`SELECT occurrence_id, item_id, scheduled_at, slot_end_at, status FROM agenda_occurrences
    WHERE scope = ? AND status IN ('scheduled','due','dispatched')`, KEY)
    .map(row => ({
      occurrenceId: row.occurrence_id, itemId: row.item_id, startAt: Number(row.scheduled_at), endAt: Number(row.slot_end_at),
      title: '用户约好的电话', authorization: 'plan', status: row.status,
    }));
  return () => ({
    timeZone: TZ, persona: { version: 2, excerpt: '三月七' }, preferences: [],
    goals: [], commitments: [], fixedAgenda: fixedAgenda(), runningActivities: [], lastReceipts: [],
    interests: [], opportunities: [], capabilities: [], budget: null, ...overrides,
  });
}

function makePlanner(world, { model, materials = makeMaterials(world) } = {}) {
  const budget = {
    reserve: entry => ({ ok: true, ref: entry.ref }),
    markIssued: () => ({ ok: true }),
    settle: () => ({ ok: true }),
    release: () => ({ ok: true }),
    status: () => ({}),
  };
  return createPlanner({
    db: world.db,
    config: { enabled: true, mode: 'active', timeZone: TZ, p2: { planning: { enabled: true, retryBackoffMs: 0 } } },
    clock: () => world.clock.value,
    owner: world.owner,
    generation: world.generation,
    dispatch: input => {
      const outcome = world.dispatch(input);
      if (outcome.rejected) {
        const failure = (outcome.results ?? []).find(result => result.error);
        throw Object.assign(new Error(failure?.error ?? 'rejected'), { code: failure?.code ?? 'rejected' });
      }
      return outcome;
    },
    callModel: model,
    budget,
    materials,
    pause: { mode: 'active' },
  });
}

const tick = (planner, reason = 'manual') => planner.tick({ scopeKey: KEY, reason });

function planEvent({ planId = 'plan_x', version = 1, windowStart = T0, windowEnd = T0 + 8 * HOUR, slots = [], day = '2026-11-02' } = {}) {
  return {
    kind: 'autonomy/plan-committed',
    scope: SCOPE,
    occurredAt: T0,
    payload: {
      at: T0,
      day,
      timeZone: TZ,
      sourceRunId: 'run_test',
      snapshotDigest: 'd_test',
      plan: { planId, day, version, windowStart, windowEnd, summary: '测试计划', timeZone: TZ, slots },
    },
  };
}

const legalSlot = (overrides = {}) => ({
  kind: 'activity', activity: 'read', targetRef: 'shelf/notes.md', title: '读一段', startAt: T0 + 130 * MIN, endAt: T0 + 170 * MIN, flexibility: 'soft', ...overrides,
});

// ---------------------------------------------------------------- protections

test('P2-04: protectedWindows protects every fixed arrangement, not only reminders', () => {
  const windows = protectedWindows([
    { startAt: T0, endAt: T0 + HOUR, title: 'a', authorization: 'plan' },
    { startAt: T0, endAt: T0 + HOUR, title: 'b', authorization: 'reminder' },
    { startAt: T0, endAt: T0 + HOUR, title: 'c', locked: true },
    { startAt: T0, title: 'no end' },
    null,
  ]);
  assert.equal(windows.length, 3, 'every timed arrangement is protected regardless of authorization');
});

test('P2-04: a plan overlapping the H1 appointment is rejected and the appointment is untouched', async (t) => {
  const world = makeWorld(t);
  seedAgendaItem(world);
  const before = agendaSnapshot(world);

  const overlapping = {
    summary: '想在电话时间读点东西',
    slots: [{ kind: 'activity', activity: 'read', targetRef: 'shelf/notes.md', title: '读一段', startAt: APPT_START + 10 * MIN, endAt: APPT_START + 40 * MIN, flexibility: 'soft' }],
  };
  const model = scriptedModel([overlapping]);
  const planner = makePlanner(world, { model });

  const outcome = await tick(planner);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'invalid-plan');
  assert.equal(world.db.all('SELECT * FROM p2_plans WHERE scope = ?', KEY).length, 0);
  assert.deepEqual(agendaSnapshot(world), before, 'the H1 rows are byte-identical after a refused plan');
  assert.equal(listEvents(world.db, { scopeKey: KEY, kind: 'agenda/created', limit: 100 }).length, 0, 'the planner writes no agenda event');
});

test('P2-04: a plan that avoids the appointment commits and still leaves H1 untouched', async (t) => {
  const world = makeWorld(t);
  seedAgendaItem(world);
  const before = agendaSnapshot(world);
  const model = scriptedModel([{
    summary: '电话之后读一段',
    slots: [{ kind: 'activity', activity: 'read', targetRef: 'shelf/notes.md', title: '读一段', startAt: APPT_END + 10 * MIN, endAt: APPT_END + 50 * MIN, flexibility: 'soft' }],
  }]);
  const planner = makePlanner(world, { model });
  const outcome = await tick(planner);
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  const slots = world.db.all('SELECT start_at, end_at FROM p2_plan_slots WHERE scope = ?', KEY);
  assert.equal(slots.length, 1);
  assert.ok(Number(slots[0].start_at) >= APPT_END);
  assert.deepEqual(agendaSnapshot(world), before);
});

test('P2-04: a reminder-authorized appointment is protected exactly like a plan-authorised one', async (t) => {
  const world = makeWorld(t);
  seedAgendaItem(world, { itemId: 'item_reminder', authorization: 'reminder', title: '用户的重要提醒' });
  const model = scriptedModel([{
    summary: '撞上提醒时间',
    slots: [{ kind: 'open', title: '发呆', startAt: APPT_START + 5 * MIN, endAt: APPT_START + 30 * MIN, flexibility: 'soft' }],
  }]);
  const planner = makePlanner(world, { model });
  const outcome = await tick(planner);
  assert.equal(outcome.code, 'invalid-plan');
  assert.equal(world.db.all('SELECT * FROM p2_plans WHERE scope = ?', KEY).length, 0);
});

// ------------------------------------------------------ reducer refusals (BLOCK-4)

test('P2-04: the reducer refuses a slot that overlaps a live H1 occurrence', async (t) => {
  const world = makeWorld(t);
  seedAgendaItem(world);
  const before = agendaSnapshot(world);
  const code = world.expectRejected(planEvent({
    slots: [legalSlot({ startAt: APPT_START + 5 * MIN, endAt: APPT_START + 25 * MIN })],
  }));
  assert.equal(code, 'slot-overlap');
  assert.equal(world.db.all('SELECT * FROM p2_plans WHERE scope = ?', KEY).length, 0);
  assert.deepEqual(agendaSnapshot(world), before);
});

test('P2-04: the reducer refuses overlapping slots, out-of-window slots, midnight crossings and invalid slots', async (t) => {
  const world = makeWorld(t);
  // Two slots inside the same window that overlap each other.
  const overlap = world.expectRejected(planEvent({
    slots: [legalSlot({ startAt: T0 + 100 * MIN, endAt: T0 + 140 * MIN }), legalSlot({ startAt: T0 + 130 * MIN, endAt: T0 + 160 * MIN })],
  }));
  assert.equal(overlap, 'slot-overlap');
  const outOfWindow = world.expectRejected(planEvent({
    slots: [legalSlot({ startAt: T0 - 30 * MIN, endAt: T0 - 1 * MIN })],
  }));
  assert.equal(outOfWindow, 'slot-out-of-window');
  // A window extending past local midnight, with a slot straddling it.
  const midnight = world.expectRejected(planEvent({
    windowStart: T0, windowEnd: T0 + 12 * HOUR,
    slots: [legalSlot({ startAt: Date.UTC(2026, 10, 2, 15, 50), endAt: Date.UTC(2026, 10, 2, 16, 20) })],
  }));
  assert.equal(midnight, 'slot-crosses-midnight');
  const backwards = world.expectRejected(planEvent({ slots: [legalSlot({ startAt: T0 + 100 * MIN, endAt: T0 + 100 * MIN })] }));
  assert.equal(backwards, 'invalid-slot');
  const otherDay = world.expectRejected(planEvent({ slots: [legalSlot({ day: '2026-11-03' })] }));
  assert.equal(otherDay, 'invalid-slot');
  const noTitle = world.expectRejected(planEvent({ slots: [legalSlot({ title: '' })] }));
  assert.equal(noTitle, 'invalid-slot');
  assert.equal(world.db.all('SELECT * FROM p2_plans WHERE scope = ?', KEY).length, 0, 'none of the refusals left a row');
  assert.equal(listEvents(world.db, { scopeKey: KEY, kind: 'autonomy/plan-committed', limit: 10 }).length, 0);
});

test('P2-04: a legal event still commits after those refusals', async (t) => {
  const world = makeWorld(t);
  seedAgendaItem(world);
  world.expectOk(planEvent({ slots: [legalSlot()] }));
  const plans = world.db.all('SELECT plan_id, status FROM p2_plans WHERE scope = ?', KEY);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].status, 'committed');
  const slots = world.db.all('SELECT * FROM p2_plan_slots WHERE scope = ?', KEY);
  assert.equal(slots.length, 1);
  assert.equal(slots[0].day, '2026-11-02');
  assert.equal(slots[0].reality, 'hypothetical', 'an unlabelled slot is fail-closed hypothetical (BLOCK-5)');
});
