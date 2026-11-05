import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openRuntimeDb } from '../lib/db.mjs';
import { dispatchEvent } from '../lib/events.mjs';
import { scopeKey as keyOfScope } from '../lib/scope.mjs';
import { applyPlanEvent, createPlanner } from '../lib/planner.mjs';

// P2-supplement — a night-time micro-plan must not own the whole day.
//
// Production (2026-10-31): at 01:09 the timer committed a 15-minute plan (read 静夜思, then four
// hours of sleep) and the same-day `plan-exists` gate then refused any further planning, so the
// afternoon had `next=[]` and the user saw "没有计划以及日程". Two rules fix it:
//   1. the planning window starts at `max(now, wakeHour)`, so a 01:09 round plans the real day;
//   2. a worn-out day may be *supplemented* a bounded number of times, each round producing a
//      new plan version through the ordinary revision path.

const TZ = 'Asia/Shanghai';
const MIN = 60000;
const HOUR = 3600000;
const DAY = 86400000;
const SCOPE = Object.freeze({ userId: '10001', personaId: 'bot', worldId: 'world:default' });
const KEY = keyOfScope(SCOPE);
// 2026-11-03 01:09 Asia/Shanghai — the night minute the bad plan was committed at.
const NIGHT = Date.UTC(2026, 10, 2, 17, 9, 0);
const NOON = Date.UTC(2026, 10, 3, 6, 0, 0); // 2026-11-03 14:00 Asia/Shanghai
const EARLY = Date.UTC(2026, 10, 2, 22, 0, 0); // 2026-11-03 06:00 Asia/Shanghai

function makeWorld(t, { now = NIGHT, planning = {} } = {}) {
  const clock = { value: now };
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
  return { clock, db, owner, generation, dispatch, expectOk, planning };
}

function scriptedModel(script) {
  const calls = [];
  const fn = async request => {
    calls.push(request);
    const index = Math.min(calls.length - 1, script.length - 1);
    const answer = script[index];
    const value = typeof answer === 'function' ? await answer(request, calls.length) : answer;
    if (value && typeof value === 'object' && typeof value.text === 'string') return value;
    return { text: typeof value === 'string' ? value : JSON.stringify(value), provider: 'script', model: 'script-v1', inputTokens: 200, outputTokens: 90 };
  };
  fn.calls = calls;
  return fn;
}

function makeMaterials() {
  return () => ({
    timeZone: TZ,
    persona: { version: 2, excerpt: 'bot' },
    preferences: [], goals: [], commitments: [], fixedAgenda: [], runningActivities: [], lastReceipts: [],
    interests: [], opportunities: [], capabilities: [], budget: null,
  });
}

function makePlanner(world, { model, budget, planning = {} } = {}) {
  const stubBudget = budget ?? {
    reserve: entry => ({ ok: true, ref: entry.ref }),
    markIssued: () => ({ ok: true }),
    settle: () => ({ ok: true }),
    release: () => ({ ok: true }),
    status: () => ({}),
  };
  return createPlanner({
    db: world.db,
    config: { enabled: true, mode: 'active', timeZone: TZ, p2: { planning: { enabled: true, retryBackoffMs: 0, ...planning } } },
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
    budget: stubBudget,
    materials: makeMaterials(),
    pause: { mode: 'active' },
  });
}

const planRows = world => world.db.all('SELECT * FROM p2_plans WHERE scope = ? ORDER BY version', KEY);
const slotRows = world => world.db.all('SELECT * FROM p2_plan_slots WHERE scope = ? ORDER BY start_at, slot_id', KEY);
const runRows = world => world.db.all('SELECT * FROM p2_plan_runs WHERE scope = ? ORDER BY started_at, run_id', KEY);
const supplementRuns = world => runRows(world).filter(run => String(run.trigger).startsWith('supplement'));

const at = (base, minutes) => base + minutes * MIN;

// A night plan: 01:15–01:30 read (already over by the afternoon) and a rest block for the night.
const nightAnswer = {
  summary: '夜里读一小段，然后睡',
  slots: [
    { kind: 'activity', activity: 'read', title: '再读《静夜思》', startAt: at(Date.UTC(2026, 10, 3, 0, 0, 0), 0), endAt: at(Date.UTC(2026, 10, 3, 0, 0, 0), 15), flexibility: 'soft', targetRef: 'shelf/jingyesi.md' },
  ],
};

test('P2-SUP: a 01:09 round plans from wakeHour, not the night', async (t) => {
  const world = makeWorld(t);
  const wake = Date.UTC(2026, 10, 3, 0, 0, 0); // 2026-11-03 08:00 Asia/Shanghai
  const model = scriptedModel([{
    summary: '白天读一段',
    slots: [{ kind: 'activity', activity: 'read', title: '早读', startAt: at(wake, 30), endAt: at(wake, 70), flexibility: 'soft', targetRef: 'shelf/morning.md' }],
  }]);
  const planner = makePlanner(world, { model });
  const out = await planner.tick({ scopeKey: KEY, reason: 'timer', now: NIGHT });
  assert.equal(out.ok, true, JSON.stringify(out));
  // The prompt carried the 08:00 window, not a 01:09 one.
  const prompt = model.calls[0].input;
  assert.match(prompt, /可安排窗口 08:00–00:00/, 'the model is handed the wake-hour window');
  assert.match(prompt, new RegExp(`windowStart = ${wake}`), 'the window start timestamp is the wake instant');
  const slots = slotRows(world);
  assert.equal(slots.length, 1);
  assert.ok(Number(slots[0].start_at) >= wake, 'no slot may be planned inside the night');
  assert.equal(Number(planRows(world)[0].window_start), wake, 'the committed plan records the wake-hour window');
});

test('P2-SUP: a night answer that plans the night is refused', async (t) => {
  const world = makeWorld(t);
  const oneAm = Date.UTC(2026, 10, 2, 17, 15, 0); // 2026-11-03 01:15 local
  const model = scriptedModel([{ summary: '夜里读', slots: [{ kind: 'activity', activity: 'read', title: '再读《静夜思》', startAt: oneAm, endAt: oneAm + 15 * MIN, flexibility: 'soft', targetRef: 'shelf/jingyesi.md' }] }]);
  const planner = makePlanner(world, { model });
  const out = await planner.tick({ scopeKey: KEY, reason: 'timer', now: NIGHT });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'invalid-plan');
  assert.match(out.error, /starts before the planning window/);
  assert.equal(planRows(world).length, 0);
});

test('P2-SUP: a worn-out day is supplemented into a new version, history preserved', async (t) => {
  const world = makeWorld(t);
  const wake = Date.UTC(2026, 10, 3, 0, 0, 0);
  const model = scriptedModel([
    // night: one short read at 08:30–09:00, so by the afternoon the plan is worn out
    { summary: '早上读一小段', slots: [{ kind: 'activity', activity: 'read', title: '早读', startAt: at(wake, 30), endAt: at(wake, 60), flexibility: 'soft', targetRef: 'shelf/morning.md' }] },
    // afternoon supplement: a real afternoon
    { summary: '下午再安排一点', slots: [{ kind: 'activity', activity: 'read', title: '下午读', startAt: at(NOON, 30), endAt: at(NOON, 90), flexibility: 'soft', targetRef: 'shelf/afternoon.md' }] },
  ]);
  const planner = makePlanner(world, { model });
  assert.equal((await planner.tick({ scopeKey: KEY, reason: 'timer', now: NIGHT })).ok, true);
  const [v1] = planRows(world);
  const v1Slots = slotRows(world).filter(slot => slot.plan_id === v1.plan_id);

  world.clock.value = NOON;
  const supplement = await planner.tick({ scopeKey: KEY, reason: 'supplement', now: NOON });
  assert.equal(supplement.ok, true, JSON.stringify(supplement));
  assert.equal(supplement.version, 2);
  const plans = planRows(world);
  assert.equal(plans.length, 2);
  assert.equal(plans.filter(row => row.status === 'committed').length, 1);
  assert.equal(plans[0].status, 'superseded', 'v1 is superseded, not edited');
  const v1After = slotRows(world).filter(slot => slot.plan_id === v1.plan_id);
  assert.deepEqual(v1After.map(slot => slot.slot_id), v1Slots.map(slot => slot.slot_id), 'v1 keeps its own rows');
  assert.deepEqual(v1After.map(slot => Number(slot.start_at)), v1Slots.map(slot => Number(slot.start_at)), 'v1 slot times are untouched');
  assert.deepEqual(v1After.map(slot => slot.status), ['skipped'], 'the superseded plan slot retires as skipped (history preserved)');
  assert.equal(supplementRuns(world).length, 1, 'the supplement is recorded on the run row');
  assert.equal(supplementRuns(world)[0].trigger, 'supplement:checkpoint');
  // The supplement plans the same local day window, starting at max(now, wakeHour).
  assert.equal(Number(plans[1].window_start), NOON, 'the supplement window starts at now');
  assert.equal(Number(plans[1].window_end), Date.UTC(2026, 10, 3, 16, 0, 0), 'and ends at the local day end');
  const status = planner.status({ scopeKey: KEY });
  assert.equal(status.supplement.used, 1);
  assert.equal(status.supplement.max, 2);
  assert.equal(status.supplement.wakeHour, 8);
  assert.equal(status.window.startAt, NOON, 'status reports the real planning window');
});

test('P2-SUP: the day has a hard supplement cap; after it, zero model calls', async (t) => {
  const world = makeWorld(t);
  const wake = Date.UTC(2026, 10, 3, 0, 0, 0);
  const liveSlot = base => ({ summary: '再安排', slots: [{ kind: 'activity', activity: 'read', title: '读一段', startAt: at(base, 5), endAt: at(base, 20), flexibility: 'soft', targetRef: 'shelf/more.md' }] });
  const model = scriptedModel([liveSlot(wake), liveSlot(NOON), liveSlot(NOON + 40 * MIN), liveSlot(NOON + 80 * MIN)]);
  const planner = makePlanner(world, { model, planning: { supplementMaxPerDay: 2 } });
  assert.equal((await planner.tick({ scopeKey: KEY, reason: 'timer', now: NIGHT })).ok, true);

  world.clock.value = NOON;
  assert.equal((await planner.tick({ scopeKey: KEY, reason: 'supplement', now: NOON })).ok, true);
  world.clock.value = NOON + 40 * MIN; // past the 30-minute floor
  assert.equal((await planner.tick({ scopeKey: KEY, reason: 'supplement', now: NOON + 40 * MIN })).ok, true);
  assert.equal(supplementRuns(world).length, 2);

  world.clock.value = NOON + 80 * MIN;
  const capped = await planner.tick({ scopeKey: KEY, reason: 'supplement', now: NOON + 80 * MIN });
  assert.equal(capped.ok, false);
  assert.equal(capped.code, 'supplement-capped');
  assert.equal(capped.modelCalls, 0);
  assert.equal(capped.used, 2);
  assert.equal(model.calls.length, 3, 'the third supplement never reached the model');
  assert.equal(planRows(world).length, 3, 'no new version was written');
});

test('P2-SUP: before wakeHour a supplement is refused without a model call', async (t) => {
  const world = makeWorld(t);
  const wake = Date.UTC(2026, 10, 3, 0, 0, 0);
  const model = scriptedModel([{ summary: '早上读', slots: [{ kind: 'activity', activity: 'read', title: '早读', startAt: at(wake, 30), endAt: at(wake, 60), flexibility: 'soft', targetRef: 'shelf/morning.md' }] }]);
  const planner = makePlanner(world, { model, planning: { wakeHour: 8 } });
  // A plan exists (committed at 05:00 for the morning) and the round is at 06:00.
  world.clock.value = Date.UTC(2026, 10, 2, 21, 0, 0); // 05:00 local
  world.expectOk({
    kind: 'autonomy/plan-committed',
    scope: SCOPE,
    occurredAt: world.clock.value,
    payload: {
      at: world.clock.value, day: '2026-11-03', timeZone: TZ, sourceRunId: 'run_seed', snapshotDigest: 'd_seed',
      plan: {
        planId: 'plan_night', day: '2026-11-03', version: 1, windowStart: wake, windowEnd: Date.UTC(2026, 10, 3, 16, 0, 0),
        summary: '早上读一段', timeZone: TZ,
        slots: [{ kind: 'activity', activity: 'read', title: '早读', startAt: at(wake, 30), endAt: at(wake, 60), flexibility: 'soft', targetRef: 'shelf/morning.md' }],
      },
    },
  });
  world.clock.value = EARLY; // 06:00 local, before wakeHour
  const out = await planner.tick({ scopeKey: KEY, reason: 'supplement', now: EARLY });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'before-wake');
  assert.equal(out.modelCalls, 0);
  assert.equal(model.calls.length, 0);
  assert.equal(planRows(world).length, 1, 'the night plan stays authoritative until the day starts');
});

test('P2-SUP: too little usable day left refuses the round without a model call', async (t) => {
  const world = makeWorld(t);
  const model = scriptedModel([{ summary: '晚上', slots: [] }]);
  const planner = makePlanner(world, { model, planning: { supplementMinMinutes: 90 } });
  const late = Date.UTC(2026, 10, 3, 14, 40, 0); // 22:40 local → 80 minutes of day left
  const out = await planner.tick({ scopeKey: KEY, reason: 'timer', now: late });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'no-window');
  assert.equal(out.modelCalls, 0);
  assert.equal(out.remainingMinutes, 80);
  assert.equal(model.calls.length, 0);
  assert.equal(planRows(world).length, 0);
});

test('P2-SUP: an unfinished plan still returns plan-exists (the ordinary rule stands)', async (t) => {
  const world = makeWorld(t);
  const wake = Date.UTC(2026, 10, 3, 0, 0, 0);
  const model = scriptedModel([
    { summary: '下午读', slots: [{ kind: 'activity', activity: 'read', title: '下午读', startAt: at(NOON, 10), endAt: at(NOON, 130), flexibility: 'soft', targetRef: 'shelf/afternoon.md' }] },
    { summary: '不该发生', slots: [] },
  ]);
  const planner = makePlanner(world, { model });
  assert.equal((await planner.tick({ scopeKey: KEY, reason: 'timer', now: NOON })).ok, true);
  const again = await planner.tick({ scopeKey: KEY, reason: 'supplement', now: NOON + 20 * MIN });
  assert.equal(again.ok, false);
  assert.equal(again.code, 'plan-exists', 'an actionable slot blocks the supplement');
  assert.equal(again.modelCalls, 0);
  assert.equal(model.calls.length, 1);
  assert.equal(planRows(world).length, 1);
  assert.ok(wake);
});

test('P2-SUP: a locked slot is carried into the supplement version', async (t) => {
  const world = makeWorld(t);
  const pinnedStart = Date.UTC(2026, 10, 3, 9, 0, 0); // 2026-11-03 17:00 local
  world.clock.value = NIGHT;
  world.expectOk({
    kind: 'autonomy/plan-committed',
    scope: SCOPE,
    occurredAt: NIGHT,
    payload: {
      at: NIGHT, day: '2026-11-03', timeZone: TZ, sourceRunId: 'run_seed', snapshotDigest: 'd_seed',
      plan: {
        planId: 'plan_v1', day: '2026-11-03', version: 1, windowStart: Date.UTC(2026, 10, 3, 0, 0, 0), windowEnd: Date.UTC(2026, 10, 3, 16, 0, 0),
        summary: '早上读一小段，下午钉住写作', timeZone: TZ,
        slots: [
          { kind: 'activity', activity: 'read', title: '早读', startAt: Date.UTC(2026, 10, 3, 0, 30, 0), endAt: Date.UTC(2026, 10, 3, 1, 0, 0), flexibility: 'soft', targetRef: 'shelf/morning.md' },
          { kind: 'activity', activity: 'write', title: '钉住的写作', startAt: pinnedStart, endAt: pinnedStart + 30 * MIN, flexibility: 'firm', targetRef: 'drafts/pinned', locked: true, reality: 'actual_tool_activity' },
        ],
      },
    },
  });
  const model = scriptedModel([{ summary: '下午再读一点', slots: [{ kind: 'activity', activity: 'read', title: '下午读', startAt: at(NOON, 60), endAt: at(NOON, 120), flexibility: 'soft', targetRef: 'shelf/afternoon.md' }] }]);
  const planner = makePlanner(world, { model });
  world.clock.value = NOON;
  const out = await planner.tick({ scopeKey: KEY, reason: 'supplement', now: NOON });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.carried, 1, 'the pinned slot comes forward');
  const committed = planRows(world).find(row => row.status === 'committed');
  const carried = slotRows(world).filter(slot => slot.plan_id === committed.plan_id && Number(slot.locked) === 1);
  assert.equal(carried.length, 1);
  assert.equal(Number(carried[0].start_at), pinnedStart);
  assert.equal(carried[0].target_ref, 'drafts/pinned');
  assert.equal(carried[0].status, 'planned');
});

test('P2-SUP: an exhausted day may answer with no slots and commit an empty plan', async (t) => {
  const world = makeWorld(t);
  const model = scriptedModel([{ summary: '今天就这样吧', slots: [] }]);
  const planner = makePlanner(world, { model });
  const out = await planner.tick({ scopeKey: KEY, reason: 'timer', now: NOON });
  assert.equal(out.ok, true, 'an empty plan is a success, not an error');
  assert.equal(out.code, 'empty');
  const plans = planRows(world);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].status, 'empty');
  assert.equal(slotRows(world).length, 0);
  // And a daytime empty plan is authoritative: no supplement that same afternoon.
  world.clock.value = NOON + 60 * MIN;
  const again = await planner.tick({ scopeKey: KEY, reason: 'supplement', now: NOON + 60 * MIN });
  assert.equal(again.code, 'plan-exists');
  assert.equal(again.modelCalls, 0);
});

test('P2-SUP: budget exhaustion refuses the supplement and leaves the plan alone', async (t) => {
  const world = makeWorld(t);
  const model = scriptedModel([{ summary: '下午读', slots: [{ kind: 'activity', activity: 'read', title: '下午读', startAt: at(NOON, 10), endAt: at(NOON, 60), flexibility: 'soft', targetRef: 'shelf/afternoon.md' }] }]);
  // A plan that is already worn out, so the supplement passes its own gate and hits the budget.
  world.clock.value = NIGHT;
  world.expectOk({
    kind: 'autonomy/plan-committed',
    scope: SCOPE,
    occurredAt: NIGHT,
    payload: {
      at: NIGHT, day: '2026-11-03', timeZone: TZ, sourceRunId: 'run_seed', snapshotDigest: 'd_seed',
      plan: {
        planId: 'plan_spent', day: '2026-11-03', version: 1, windowStart: Date.UTC(2026, 10, 3, 0, 0, 0), windowEnd: Date.UTC(2026, 10, 3, 16, 0, 0),
        summary: '早上读一小段', timeZone: TZ,
        slots: [{ kind: 'activity', activity: 'read', title: '早读', startAt: Date.UTC(2026, 10, 3, 0, 30, 0), endAt: Date.UTC(2026, 10, 3, 1, 0, 0), flexibility: 'soft', targetRef: 'shelf/morning.md' }],
      },
    },
  });
  const spent = {
    reserve: () => ({ ok: false, code: 'budget-exhausted' }),
    markIssued: () => ({ ok: false, code: 'budget-exhausted' }),
    settle: () => ({ ok: true }),
    release: () => ({ ok: true }),
    status: () => ({ requests: { limit: 64, used: 64, remaining: 0 } }),
  };
  const planner = makePlanner(world, { model, budget: spent });
  world.clock.value = NOON;
  const out = await planner.tick({ scopeKey: KEY, reason: 'supplement', now: NOON });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'budget-exhausted');
  assert.equal(out.modelCalls, 0);
  assert.equal(model.calls.length, 0);
  assert.equal(planRows(world).length, 1, 'no new version');
  assert.equal(planRows(world)[0].plan_id, 'plan_spent');
});

test('P2-SUP: a night-scoped empty plan may be supplemented; a daytime one may not', async (t) => {
  const world = makeWorld(t);
  const wake = Date.UTC(2026, 10, 3, 0, 0, 0);
  const model = scriptedModel([{ summary: '下午读一点', slots: [{ kind: 'activity', activity: 'read', title: '下午读', startAt: at(NOON, 30), endAt: at(NOON, 90), flexibility: 'soft', targetRef: 'shelf/afternoon.md' }] }]);
  const planner = makePlanner(world, { model });
  // An empty plan committed at 01:09 is night-scoped: it must not own the whole day.
  world.clock.value = NIGHT;
  world.expectOk({
    kind: 'autonomy/plan-committed',
    scope: SCOPE,
    occurredAt: NIGHT,
    payload: {
      at: NIGHT, day: '2026-11-03', timeZone: TZ, sourceRunId: 'run_seed', snapshotDigest: 'd_seed',
      plan: {
        planId: 'plan_night_empty', day: '2026-11-03', version: 1, windowStart: wake, windowEnd: Date.UTC(2026, 10, 3, 16, 0, 0),
        summary: '今天先这样', timeZone: TZ, slots: [],
      },
    },
  });
  world.clock.value = NOON;
  const out = await planner.tick({ scopeKey: KEY, reason: 'supplement', now: NOON });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.version, 2);
  assert.equal(planRows(world)[0].status, 'superseded');
});

test('P2-SUP: a running activity blocks the supplement even when the rest of the day is free', async (t) => {
  const world = makeWorld(t);
  const wake = Date.UTC(2026, 10, 3, 0, 0, 0);
  const model = scriptedModel([{ summary: '不该发生', slots: [] }]);
  const planner = makePlanner(world, { model });
  world.clock.value = NOON;
  world.expectOk({
    kind: 'autonomy/plan-committed',
    scope: SCOPE,
    occurredAt: NOON,
    payload: {
      at: NOON, day: '2026-11-03', timeZone: TZ, sourceRunId: 'run_seed', snapshotDigest: 'd_seed',
      plan: {
        planId: 'plan_running', day: '2026-11-03', version: 1, windowStart: NOON, windowEnd: Date.UTC(2026, 10, 3, 16, 0, 0),
        summary: '正在读', timeZone: TZ,
        slots: [{ kind: 'activity', activity: 'read', title: '正在读', startAt: at(NOON, 0), endAt: at(NOON, 120), flexibility: 'soft', targetRef: 'shelf/live.md' }],
      },
    },
  });
  const [slot] = slotRows(world);
  world.expectOk({ kind: 'autonomy/plan-slot', scope: SCOPE, occurredAt: NOON + MIN, payload: { at: NOON + MIN, slotId: slot.slot_id, from: 'planned', to: 'started' } });
  world.clock.value = NOON + 10 * MIN;
  const out = await planner.tick({ scopeKey: KEY, reason: 'supplement', now: NOON + 10 * MIN });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'plan-exists', 'an activity is literally running');
  assert.equal(out.modelCalls, 0);
  assert.equal(model.calls.length, 0);
  assert.ok(wake);
});
