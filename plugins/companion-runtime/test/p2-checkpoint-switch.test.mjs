import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openRuntimeDb } from '../lib/db.mjs';
import { dispatchEvent } from '../lib/events.mjs';
import { scopeKey as keyOfScope } from '../lib/scope.mjs';
import { applyPlanEvent, createPlanner, SLOT_TRANSITIONS } from '../lib/planner.mjs';

// P2-24 — checkpoints: switch, extend, cool down (amendment BLOCK-2, wiki P2-24).
//
// A checkpoint is one of the four explicit replan reasons, so it may replace the plan of
// the day — but never rewrite history: a slot that already started or finished keeps its
// status, and an extension only ever covers the future. Repeated failure cools the planner
// down instead of burning the pool on a broken model, and a hard arrangement that appeared
// after the plan does not silently win: the replan is refused and the old plan stays.

const TZ = 'Asia/Shanghai';
const MIN = 60000;
const HOUR = 3600000;
const DAY = 86400000;
const SCOPE = Object.freeze({ userId: 'owner-1', personaId: 'bot', worldId: 'world:default' });
const KEY = keyOfScope(SCOPE);
const T0 = Date.UTC(2026, 10, 2, 5, 41, 0); // 2026-11-02 13:41 Asia/Shanghai

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
    return (outcome.results ?? []).find(result => result.applied)?.result ?? {};
  }
  function expectRejected(input) {
    const outcome = dispatch(input);
    assert.equal(outcome.rejected, true, 'the event must be rolled back');
    return (outcome.results ?? []).find(result => result.error)?.code ?? 'unknown';
  }
  return { clock, db, owner, generation, dispatch, expectOk, expectRejected };
}

function scriptedModel(script) {
  const calls = [];
  const fn = async (request) => {
    calls.push(request);
    const index = Math.min(calls.length - 1, script.length - 1);
    const answer = script[index];
    const value = typeof answer === 'function' ? await answer(request, calls.length) : answer;
    if (value && typeof value === 'object' && typeof value.text === 'string') return value;
    return { text: typeof value === 'string' ? value : JSON.stringify(value), provider: 'script', model: 'script-v1', inputTokens: 95, outputTokens: 41 };
  };
  fn.calls = calls;
  return fn;
}

function makeMaterials(changer = () => ({})) {
  return () => ({
    timeZone: TZ, persona: { version: 1, excerpt: 'bot' }, preferences: [],
    goals: [], commitments: [], fixedAgenda: [], runningActivities: [], lastReceipts: [],
    interests: [], opportunities: [], capabilities: [], budget: null, ...changer(),
  });
}

function makePlanner(world, { model, materials = makeMaterials() } = {}) {
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
const planRows = world => world.db.all('SELECT * FROM p2_plans WHERE scope = ? ORDER BY version', KEY);
const slotRows = world => world.db.all('SELECT * FROM p2_plan_slots WHERE scope = ? ORDER BY start_at', KEY);

function slotEvent(world, slot, from, to, at) {
  return world.expectOk({
    kind: 'autonomy/plan-slot',
    scope: SCOPE,
    occurredAt: at,
    payload: { at, slotId: slot.slot_id, planId: slot.plan_id, day: slot.day, from, to },
  });
}

// ------------------------------------------------------------------ switching

test('P2-24: a checkpoint can switch activity without losing the slot that already started', async (t) => {
  const world = makeWorld(t);
  const readSlot = { startAt: T0 + 20 * MIN, endAt: T0 + 80 * MIN };
  const model = scriptedModel([
    { summary: '下午读一段', slots: [{ kind: 'activity', activity: 'read', targetRef: 'shelf/notes.md', title: '读', ...readSlot, flexibility: 'soft' }] },
    { summary: '读腻了，换写', slots: [{ kind: 'activity', activity: 'write', targetRef: 'drafts/notes', title: '写', startAt: T0 + 50 * MIN, endAt: T0 + 110 * MIN, flexibility: 'soft' }] },
  ]);
  const planner = makePlanner(world, { model });
  assert.equal((await tick(planner, 'manual')).ok, true);

  const [slot] = slotRows(world);
  slotEvent(world, slot, 'planned', 'started', readSlot.startAt);

  world.clock.value = T0 + 50 * MIN;
  const outcome = await tick(planner, 'checkpoint:' + slot.slot_id);
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(outcome.version, 2);

  const slots = slotRows(world);
  const previous = slots.find(entry => entry.plan_id === planRows(world)[0].plan_id);
  assert.equal(previous.status, 'started', 'the interrupted slot keeps its real status');
  assert.equal(Number(previous.start_at), readSlot.startAt, 'history is not rewritten');
  const current = slots.find(entry => entry.plan_id !== planRows(world)[0].plan_id);
  assert.equal(current.activity, 'write', 'the new version carries the switched activity');
  assert.equal(planRows(world)[1].supersedes, planRows(world)[0].plan_id);
});

test('P2-24: an own soft activity can be extended, and only into the future', async (t) => {
  const world = makeWorld(t);
  const firstSlot = { startAt: T0 + 20 * MIN, endAt: T0 + 80 * MIN };
  const model = scriptedModel([
    { summary: '写四十分钟', slots: [{ kind: 'activity', activity: 'write', targetRef: 'drafts/notes', title: '写', ...firstSlot, flexibility: 'soft' }] },
    { summary: '还想再写一会儿', slots: [{ kind: 'activity', activity: 'write', targetRef: 'drafts/notes', title: '接着写', startAt: T0 + 80 * MIN, endAt: T0 + 140 * MIN, flexibility: 'soft' }] },
  ]);
  const planner = makePlanner(world, { model });
  assert.equal((await tick(planner, 'manual')).ok, true);
  const [slot] = slotRows(world);
  slotEvent(world, slot, 'planned', 'started', firstSlot.startAt);

  world.clock.value = T0 + 80 * MIN;
  const extended = await tick(planner, 'checkpoint:' + slot.slot_id);
  assert.equal(extended.ok, true, JSON.stringify(extended));

  const slots = slotRows(world);
  const added = slots.find(entry => entry.plan_id === planRows(world)[1].plan_id);
  const minutes = (Number(added.end_at) - Number(added.start_at)) / MIN;
  assert.equal(minutes, 60);
  assert.ok(Number(added.start_at) >= T0 + 79 * MIN, 'an extension never reaches into the executed slot');
  assert.equal(slots.find(entry => entry.plan_id === planRows(world)[0].plan_id).status, 'started');
});

// -------------------------------------------------------------- failure cooldown

test('P2-24: repeated model failure enters a cooldown even for an explicit reason', async (t) => {
  const world = makeWorld(t);
  const model = scriptedModel(['broken json', 'broken json', 'broken json', 'broken json']);
  const planner = makePlanner(world, { model });

  assert.equal((await tick(planner, 'manual')).code, 'invalid-plan');
  world.clock.value = T0 + 31 * MIN;
  assert.equal((await tick(planner, 'manual')).code, 'invalid-plan');
  const calls = model.calls.length;

  world.clock.value = T0 + 32 * MIN;
  assert.equal((await tick(planner, 'failure')).code, 'cooldown');
  assert.equal(model.calls.length, calls, 'a cool-down round makes no model call');

  // After the coalescing window the planner tries again instead of giving up for the day.
  world.clock.value = T0 + 41 * MIN;
  const retried = await tick(planner, 'failure');
  assert.equal(retried.code, 'invalid-plan', 'the model is retried after the cooldown');
  assert.equal(model.calls.length, calls + 2);
});

// ------------------------------------------------- hard arrangements never lose

test('P2-24: a fixed arrangement added after the plan refuses the replan and keeps the old plan', async (t) => {
  const world = makeWorld(t);
  // The user creates an appointment *after* the day plan exists.
  let appointment = [];
  const materials = makeMaterials(() => ({ fixedAgenda: appointment }));
  const model = scriptedModel([
    { summary: '下午读', slots: [{ kind: 'activity', activity: 'read', targetRef: 'shelf/notes.md', title: '读', startAt: T0 + 20 * MIN, endAt: T0 + 60 * MIN, flexibility: 'soft' }] },
    { summary: '想读久一点', slots: [{ kind: 'activity', activity: 'read', targetRef: 'shelf/notes.md', title: '读', startAt: T0 + 40 * MIN, endAt: T0 + 100 * MIN, flexibility: 'soft' }] },
  ]);
  const planner = makePlanner(world, { model, materials });
  assert.equal((await tick(planner, 'manual')).ok, true);
  const committed = planRows(world)[0];

  appointment = [{ startAt: T0 + 40 * MIN, endAt: T0 + 100 * MIN, title: '用户临时约的事', authorization: 'plan' }];
  world.clock.value = T0 + 35 * MIN;
  const refused = await tick(planner, 'checkpoint');
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'invalid-plan');
  const plans = planRows(world);
  assert.equal(plans.length, 1, 'the original plan is not lost');
  assert.equal(plans[0].plan_id, committed.plan_id);
  assert.equal(plans[0].status, 'committed');
});

test('P2-24: a rest-only replan is a legitimate answer (no forced action)', async (t) => {
  const world = makeWorld(t);
  const model = scriptedModel([
    { summary: '下午读', slots: [{ kind: 'activity', activity: 'read', targetRef: 'shelf/notes.md', title: '读', startAt: T0 + 20 * MIN, endAt: T0 + 60 * MIN, flexibility: 'soft' }] },
    { summary: '不想读了，歇着', slots: [{ kind: 'rest', title: '躺一会儿', startAt: T0 + 50 * MIN, endAt: T0 + 110 * MIN, flexibility: 'soft' }] },
  ]);
  const planner = makePlanner(world, { model });
  assert.equal((await tick(planner, 'manual')).ok, true);
  world.clock.value = T0 + 45 * MIN;
  const outcome = await tick(planner, 'checkpoint');
  assert.equal(outcome.ok, true);
  const currentPlanId = planRows(world)[1].plan_id;
  const slots = slotRows(world).filter(entry => entry.plan_id === currentPlanId);
  assert.deepEqual(slots.map(entry => entry.kind), ['rest']);
  assert.equal(world.db.all('SELECT * FROM p2_activities WHERE scope = ?', KEY).length, 0, 'the planner never invents an activity');
});

// ------------------------------------------------------------ transition rules

test('P2-24: slot transitions are frozen — terminal states never come back', async (t) => {
  const world = makeWorld(t);
  const model = scriptedModel([{ summary: '读', slots: [{ kind: 'activity', activity: 'read', targetRef: 'shelf/notes.md', title: '读', startAt: T0 + 20 * MIN, endAt: T0 + 60 * MIN, flexibility: 'soft' }] }]);
  const planner = makePlanner(world, { model });
  assert.equal((await tick(planner, 'manual')).ok, true);
  const [slot] = slotRows(world);

  const done = slotEvent(world, slot, 'planned', 'skipped', T0 + MIN);
  assert.equal(done.action, 'skipped');
  const revived = world.expectRejected({
    kind: 'autonomy/plan-slot', scope: SCOPE, occurredAt: T0 + 2 * MIN,
    payload: { at: T0 + 2 * MIN, slotId: slot.slot_id, planId: slot.plan_id, from: 'skipped', to: 'started' },
  });
  assert.equal(revived, 'invalid-transition');
  assert.equal(slotRows(world)[0].status, 'skipped');
  assert.deepEqual(SLOT_TRANSITIONS.done, []);
  assert.deepEqual(SLOT_TRANSITIONS.expired, []);
});
