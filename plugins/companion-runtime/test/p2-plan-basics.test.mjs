import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openRuntimeDb } from '../lib/db.mjs';
import { dispatchEvent, listEvents } from '../lib/events.mjs';
import { scopeKey as keyOfScope } from '../lib/scope.mjs';
import { RuntimeError } from '../lib/errors.mjs';
import { applyPlanEvent, createPlanner, PLAN_LIMITS } from '../lib/planner.mjs';

// P2-01 — the day plan itself: one committed plan per (scope, day), the remaining-day
// window (late start), a legal empty plan that closes the day, and rest/open as
// legitimate outcomes.
//
// Everything is driven through the real event path: `dispatch` wraps `dispatchEvent`
// with `handlers:{autonomy:applyPlanEvent}` and `requireConsumers:true`, exactly like the
// runtime wrapper (`lib/p2.mjs` `emit`). The model is a scripted transport (no production
// path, no network) so model-call counts are assertions, not guesses.

const TZ = 'Asia/Shanghai';
const MIN = 60000;
const DAY = 86400000;
const SCOPE = Object.freeze({ userId: 'owner-1', personaId: 'march7', worldId: 'world:default' });
const KEY = keyOfScope(SCOPE);
// 2026-11-02 13:41 Asia/Shanghai — a mid-afternoon start, so "today" still has room.
const T0 = Date.UTC(2026, 10, 2, 5, 41, 0);
const DAY_END = Date.UTC(2026, 10, 2, 16, 0, 0); // next local midnight

// --------------------------------------------------------------------- harness

function makeWorld(t, { start = T0, file = ':memory:' } = {}) {
  const clock = { value: start };
  const db = openRuntimeDb({ file, now: () => clock.value });
  t.after(() => { try { db.close(); } catch { /* already closed */ } });
  const owner = 'owner-test';
  const generation = 'gen-test';
  assert.equal(db.acquireLease({ owner, generation, ttlMs: 7 * DAY }).ok, true, 'the test writer holds the lease');
  db.commitProjection({ scope: KEY, generation, payload: {} });
  const events = [];
  function dispatch(input) {
    const outcome = dispatchEvent(db, input, { handlers: { autonomy: applyPlanEvent }, generation, requireConsumers: true });
    if (outcome.rejected) {
      const failure = (outcome.results ?? []).find(result => result.error);
      throw new RuntimeError(failure?.code ?? 'dispatch-rejected', failure?.error ?? 'the event was rejected');
    }
    events.push(outcome.event);
    return { ok: true, eventId: outcome.event.eventId, inserted: outcome.inserted, seq: outcome.seq, results: outcome.results };
  }
  return { clock, db, owner, generation, dispatch, events };
}

function scriptedModel(script) {
  const calls = [];
  const fn = async (request) => {
    calls.push(request);
    const index = Math.min(calls.length - 1, script.length - 1);
    const answer = script[index];
    if (typeof answer === 'function') return answer(request, calls.length);
    if (answer instanceof Error) throw answer;
    return {
      text: typeof answer === 'string' ? answer : JSON.stringify(answer),
      provider: 'script', model: 'script-v1', inputTokens: 137, outputTokens: 62,
    };
  };
  fn.calls = calls;
  return fn;
}

/** Fake budget port with the frozen lib/budget.mjs shape (reserve → markIssued → settle). */
function makeBudget({ maxRequests = 8, reserveCode = null, settleCode = null } = {}) {
  const ledger = { requests: 0, inputTokens: 0, outputTokens: 0 };
  const reserves = [];
  const issues = [];
  const settles = [];
  const releases = [];
  let sequence = 0;
  return {
    ledger, reserves, issues, settles, releases,
    reserve({ scope, purpose, ref, estimatedInputTokens = 0, estimatedOutputTokens = 0 }) {
      reserves.push({ scope, purpose, ref, estimatedInputTokens, estimatedOutputTokens });
      if (reserveCode) return { ok: false, code: reserveCode };
      if (ledger.requests + 1 > maxRequests) return { ok: false, code: 'budget-exhausted' };
      ledger.requests += 1;
      sequence += 1;
      return { ok: true, ref: ref ?? `budget_${sequence}` };
    },
    markIssued({ scope, ref }) { issues.push({ scope, ref }); return { ok: true, ref }; },
    settle({ scope, ref, inputTokens, outputTokens, ok, code }) {
      settles.push({ scope, ref, inputTokens, outputTokens, ok, code });
      ledger.inputTokens += Number(inputTokens) || 0;
      ledger.outputTokens += Number(outputTokens) || 0;
      if (settleCode) return { ok: false, code: settleCode };
      return { ok: true };
    },
    release({ scope, ref }) { releases.push({ scope, ref }); return { ok: true }; },
    status() { return { day: '2026-11-02', requests: { used: ledger.requests, limit: maxRequests, remaining: maxRequests - ledger.requests } }; },
    canSpend() { return ledger.requests < maxRequests; },
  };
}

function makeMaterials(overrides = {}) {
  const calls = [];
  const fn = ({ scopeKey, day, now }) => {
    calls.push({ scopeKey, day, now });
    const base = {
      timeZone: TZ,
      now,
      day,
      persona: { version: 3, excerpt: '三月七：喜欢亮晶晶的东西，爱拍照，也爱胡思乱想。' },
      preferences: ['喜欢在下午读点东西', '不想被安排得满满当当'],
      goals: [], commitments: [], fixedAgenda: [], runningActivities: [], lastReceipts: [],
      interests: [], opportunities: [],
      capabilities: [{ name: 'read', available: true }, { name: 'explore', available: true }, { name: 'write', available: true }],
      budget: { requests: { used: 1, limit: 64, remaining: 63 } },
    };
    const extra = typeof overrides === 'function' ? overrides({ scopeKey, day, now, base, call: calls.length }) : overrides;
    return { ...base, ...extra };
  };
  fn.calls = calls;
  return fn;
}

function makePlanner(world, { model, materials, budget = makeBudget(), planning = {}, pause = { mode: 'active' } } = {}) {
  return createPlanner({
    db: world.db,
    config: { enabled: true, mode: 'active', timeZone: TZ, p2: { planning: { enabled: true, retryBackoffMs: 0, ...planning } } },
    clock: () => world.clock.value,
    owner: world.owner,
    generation: world.generation,
    dispatch: world.dispatch,
    callModel: model,
    budget,
    materials,
    pause,
  });
}

/** Drive a tick the way `lib/p2.mjs` does: scopeKey per call, no bound scope. */
function tick(planner, reason, extra = {}) {
  return planner.tick({ scopeKey: KEY, reason, ...extra });
}

function autonomyEvents(world, kind) {
  return listEvents(world.db, { scopeKey: KEY, kind, limit: 1000 });
}

function planRows(world) {
  return world.db.all('SELECT * FROM p2_plans WHERE scope = ? ORDER BY version ASC', KEY);
}

function slotRows(world) {
  return world.db.all('SELECT * FROM p2_plan_slots WHERE scope = ? ORDER BY start_at ASC', KEY);
}

const AFTERNOON_PLAN = {
  summary: '下午接着读一会儿，然后随手写两句',
  slots: [
    { kind: 'activity', activity: 'read', targetRef: 'shelf/notes.md', title: '把昨天那篇接着读一段', detail: '从断点继续', startAt: T0 + 10 * MIN, endAt: T0 + 55 * MIN, flexibility: 'soft', intent: '把断点续上' },
    { kind: 'open', title: '随便逛逛', detail: '', startAt: T0 + 120 * MIN, endAt: T0 + 160 * MIN, flexibility: 'soft' },
  ],
  interests: [{ kind: 'project', title: '随手写的小随笔', note: '想把第二段写完' }],
};

// ------------------------------------------------------------------ P2-01 tests

test('P2-01: the first tick of the day commits exactly one plan for the remaining day', async (t) => {
  const world = makeWorld(t);
  const model = scriptedModel([AFTERNOON_PLAN]);
  const materials = makeMaterials();
  const planner = makePlanner(world, { model, materials });

  const outcome = await tick(planner, 'manual');
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(outcome.code, 'committed');
  assert.equal(outcome.status, 'committed');
  assert.equal(outcome.version, 1);
  assert.equal(outcome.attempts, 1);
  assert.equal(model.calls.length, 1, 'one model call for the main plan');
  assert.equal(materials.calls[0].scopeKey, KEY, 'materials receive the tick scope');

  const request = model.calls[0];
  assert.equal(request.purpose, 'p2-planning', 'the purpose is the frozen P2 purpose, not the memory one');
  assert.equal(request.maxTokens, PLAN_LIMITS.maxOutputTokens);
  assert.ok(request.input.length <= PLAN_LIMITS.maxInputChars, `input is bounded (${request.input.length})`);
  assert.match(request.input, /Asia\/Shanghai/);
  assert.match(request.input, /已约好的事情/);
  assert.match(request.input, /输出契约/);
  assert.match(request.input, /三月七/);

  const plans = planRows(world);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].status, 'committed');
  assert.equal(plans[0].day, '2026-11-02');
  assert.equal(plans[0].time_zone, TZ);
  assert.equal(Number(plans[0].version), 1);
  assert.equal(Number(plans[0].window_start), T0, 'a same-day plan window starts at now');
  assert.equal(Number(plans[0].window_end), DAY_END);

  const slots = slotRows(world);
  assert.equal(slots.length, 2);
  for (const slot of slots) {
    assert.ok(Number(slot.start_at) >= T0, 'no slot reaches back before now');
    assert.ok(Number(slot.end_at) <= DAY_END, 'no slot reaches past the local day end');
    const minutes = (Number(slot.end_at) - Number(slot.start_at)) / MIN;
    assert.ok(minutes >= PLAN_LIMITS.minDurationMinutes && minutes <= PLAN_LIMITS.maxDurationMinutes);
    assert.equal(slot.status, 'planned');
    assert.equal(slot.agenda_item_id, '', 'P2 never mirrors a slot into the H1 agenda');
  }
  assert.deepEqual(slots.map(slot => slot.reality), ['actual_tool_activity', 'simulated_world'], 'every slot labels its own reality');

  const committed = autonomyEvents(world, 'autonomy/plan-committed');
  assert.equal(committed.length, 1);
  assert.equal(committed[0].occurredAt, T0, 'a definition-level event carries the payload instant');
  assert.equal(committed[0].payload.plan.day, '2026-11-02');
  assert.equal(committed[0].payload.plan.slots[0].reality, 'actual_tool_activity');

  const status = planner.status({ scopeKey: KEY });
  assert.equal(status.enabled, true);
  assert.equal(status.mode, 'active');
  assert.equal(status.day, '2026-11-02');
  assert.equal(status.plan.planId, plans[0].plan_id);
  assert.equal(status.slots.total, 2);
  assert.equal(status.slots.planned, 2);
  assert.ok(String(status.plan.summary).length <= 120, 'status never carries a full plan body');
});

test('P2-01: a second tick on the same day asks the model nothing (plan-exists)', async (t) => {
  const world = makeWorld(t);
  const model = scriptedModel([AFTERNOON_PLAN]);
  const planner = makePlanner(world, { model, materials: makeMaterials() });

  assert.equal((await tick(planner, 'manual')).ok, true);
  world.clock.value = T0 + 20 * MIN;
  const second = await tick(planner, 'timer');
  assert.equal(second.ok, false);
  assert.equal(second.code, 'plan-exists');
  assert.equal(second.modelCalls, 0);
  assert.equal(model.calls.length, 1, 'the same day never gets a second model call');
  assert.equal(planRows(world).length, 1, 'the plan is not re-created');

  world.clock.value = T0 + 25 * MIN;
  const third = await tick(planner, 'curiosity');
  assert.equal(third.code, 'plan-exists');
  assert.equal(model.calls.length, 1);
});

test('P2-01: a late start only plans the remaining day and never reaches back', async (t) => {
  const start = T0 + 6 * 60 * MIN; // 19:41 local
  const world = makeWorld(t, { start });
  const model = scriptedModel([{
    summary: '晚上只读一小段',
    slots: [{ kind: 'activity', activity: 'read', targetRef: 'shelf/notes.md', title: '睡前读两页', detail: '', startAt: start + 5 * MIN, endAt: start + 25 * MIN, flexibility: 'soft' }],
  }]);
  const planner = makePlanner(world, { model, materials: makeMaterials() });

  const outcome = await tick(planner, 'startup');
  assert.equal(outcome.ok, true);
  assert.equal(outcome.status, 'committed');
  const plans = planRows(world);
  assert.equal(Number(plans[0].window_start), start, 'the plan window starts at the late start instant');
  for (const slot of slotRows(world)) {
    assert.ok(Number(slot.start_at) >= start);
    assert.ok(Number(slot.end_at) <= DAY_END);
  }
});

test('P2-01: a plan that reaches before now is rejected and nothing is committed', async (t) => {
  const world = makeWorld(t);
  const model = scriptedModel([{
    summary: '早上本来想做的事',
    slots: [{ kind: 'activity', activity: 'read', targetRef: 'shelf/notes.md', title: '早读', startAt: T0 - 180 * MIN, endAt: T0 - 120 * MIN, flexibility: 'soft' }],
  }]);
  const planner = makePlanner(world, { model, materials: makeMaterials() });

  const outcome = await tick(planner, 'manual');
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'invalid-plan');
  assert.equal(outcome.attempts, PLAN_LIMITS.maxAttempts, 'the retry is bounded to maxAttempts');
  assert.equal(model.calls.length, PLAN_LIMITS.maxAttempts);
  assert.equal(planRows(world).length, 0, 'no half plan is ever committed');
  assert.equal(slotRows(world).length, 0);
  assert.equal(autonomyEvents(world, 'autonomy/plan-committed').length, 0);
  const runs = world.db.all('SELECT * FROM p2_plan_runs WHERE scope = ? AND attempts = 2 AND status = ?', KEY, 'rejected');
  assert.equal(runs.length, 1, 'the rejected attempt is recorded for diagnostics');
});

test('P2-01: a legal empty plan is a success, writes a real row and closes the day', async (t) => {
  const world = makeWorld(t);
  const model = scriptedModel([{ summary: '今天想安静待着，不做安排', slots: [] }]);
  const planner = makePlanner(world, { model, materials: makeMaterials() });

  const outcome = await tick(planner, 'manual');
  assert.equal(outcome.ok, true);
  assert.equal(outcome.code, 'empty');
  assert.equal(outcome.status, 'empty');
  assert.equal(outcome.slots, 0);
  assert.equal(model.calls.length, 1);

  const plans = planRows(world);
  assert.equal(plans.length, 1, 'the empty outcome is persisted as a plan row');
  assert.equal(plans[0].status, 'empty', 'empty is a committed-for-the-day status (BLOCK-2)');
  assert.equal(slotRows(world).length, 0);

  for (const [offset, reason] of [[15 * MIN, 'timer'], [40 * MIN, 'curiosity'], [90 * MIN, 'idle-gap']]) {
    world.clock.value = T0 + offset;
    const again = await tick(planner, reason);
    assert.equal(again.modelCalls, 0, `an empty plan is not re-planned (${reason})`);
    assert.equal(again.code, 'plan-exists');
  }
  assert.equal(model.calls.length, 1, 'exactly one model call for a whole empty day');
  assert.equal(planner.status({ scopeKey: KEY }).day, '2026-11-02');
  assert.equal(planner.status({ scopeKey: KEY }).slots.total, 0);
});

test('P2-01: rest/open-only plans are legitimate outcomes', async (t) => {
  const world = makeWorld(t);
  const model = scriptedModel([{
    summary: '今天只想歇着',
    slots: [
      { kind: 'rest', title: '躺一会儿', detail: '什么都不做', startAt: T0 + 30 * MIN, endAt: T0 + 150 * MIN, flexibility: 'soft' },
      { kind: 'open', title: '留白', detail: '', startAt: T0 + 180 * MIN, endAt: T0 + 240 * MIN, flexibility: 'soft' },
    ],
  }]);
  const planner = makePlanner(world, { model, materials: makeMaterials() });

  const outcome = await tick(planner, 'manual');
  assert.equal(outcome.status, 'committed');
  const slots = slotRows(world);
  assert.deepEqual(slots.map(slot => slot.kind), ['rest', 'open']);
  assert.equal(slots[0].activity, '', 'rest/open never carry an activity kind');
  assert.deepEqual(slots.map(slot => slot.reality), ['simulated_world', 'simulated_world']);
});

test('P2-01: the plan window never exceeds the local day, and midnight is a new day', async (t) => {
  const world = makeWorld(t);
  const model = scriptedModel([
    { summary: '下午随便安排', slots: [{ kind: 'open', title: '发呆', startAt: T0 + 30 * MIN, endAt: T0 + 60 * MIN, flexibility: 'soft' }] },
    { summary: '第二天', slots: [{ kind: 'open', title: '第二天发呆', startAt: T0 + DAY + 45 * MIN, endAt: T0 + DAY + 60 * MIN, flexibility: 'soft' }] },
  ]);
  const planner = makePlanner(world, { model, materials: makeMaterials() });

  const first = await tick(planner, 'manual');
  assert.equal(first.status, 'committed');
  assert.equal(Number(planRows(world)[0].window_end), DAY_END);

  world.clock.value = T0 + DAY + 35 * MIN; // next local day, 14:16
  const second = await tick(planner, 'day-change');
  assert.equal(second.ok, true);
  assert.equal(second.day, '2026-11-03');
  assert.equal(second.version, 1, 'a new day starts at version 1');
  const plans = planRows(world);
  assert.equal(plans.length, 2);
  assert.deepEqual(plans.map(row => row.day), ['2026-11-02', '2026-11-03']);
  assert.deepEqual(plans.map(row => row.status), ['committed', 'committed']);
});

test('P2-01: an explicit replan reason bumps the version and supersedes the old row', async (t) => {
  const world = makeWorld(t);
  const model = scriptedModel([
    { summary: '下午读一点', slots: [{ kind: 'activity', activity: 'read', targetRef: 'shelf/notes.md', title: '读', startAt: T0 + 30 * MIN, endAt: T0 + 80 * MIN, flexibility: 'soft' }] },
    { summary: '改主意了', slots: [{ kind: 'activity', activity: 'write', targetRef: 'drafts/notes', title: '写两句', startAt: T0 + 60 * MIN, endAt: T0 + 100 * MIN, flexibility: 'soft' }] },
  ]);
  const planner = makePlanner(world, { model, materials: makeMaterials() });

  assert.equal((await tick(planner, 'manual')).ok, true);
  world.clock.value = T0 + 20 * MIN;
  const replan = await tick(planner, 'checkpoint:slot_1');
  assert.equal(replan.ok, true, 'checkpoint is one of the four explicit replan reasons');
  assert.equal(replan.version, 2);
  assert.equal(model.calls.length, 2);
  const plans = planRows(world);
  assert.deepEqual(plans.map(row => row.status), ['superseded', 'committed']);
  assert.equal(plans[1].supersedes, plans[0].plan_id);
  assert.equal(replan.supersedes, plans[0].plan_id);
});
