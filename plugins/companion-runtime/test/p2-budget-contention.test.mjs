import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openRuntimeDb } from '../lib/db.mjs';
import { dispatchEvent } from '../lib/events.mjs';
import { scopeKey as keyOfScope } from '../lib/scope.mjs';
import { createBudget } from '../lib/budget.mjs';
import { applyPlanEvent, createPlanner, PLAN_LIMITS } from '../lib/planner.mjs';

// P2-26 — budget contention, single-flight and foreground priority.
//
// The planner is one consumer of a shared pool: it must not queue behind itself, must not
// start more than two background rounds, must let a foreground chat turn win
// (`chat-priority` from `reserve`), and must never touch the recovery reserve for ordinary
// planning work (amendment BLOCK-3/BLOCK-8).

const TZ = 'Asia/Shanghai';
const MIN = 60000;
const DAY = 86400000;
const SCOPE = Object.freeze({ userId: 'owner-1', personaId: 'bot', worldId: 'world:default' });
const KEY = keyOfScope(SCOPE);
const OTHER_SCOPES = ['world:a', 'world:b'].map(worldId => keyOfScope({ userId: 'owner-1', personaId: 'bot', worldId }));
const T0 = Date.UTC(2026, 10, 2, 5, 41, 0);

const flush = () => new Promise(resolve => setImmediate(resolve));
// A deferred model that is never released must fail this test, never hang the runner: the
// suite hung for 4+ minutes (and an external auditor had to kill the child processes) because
// an unresolved promise had no deadline.
const withTimeout = (promise, ms = 5000, label = 'tick') => Promise.race([
  promise,
  new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(label + ' did not settle within ' + ms + 'ms')), ms); if (typeof timer.unref === 'function') timer.unref(); }),
]);

function makeWorld(t) {
  const clock = { value: T0 };
  const db = openRuntimeDb({ file: ':memory:', now: () => clock.value });
  t.after(() => { try { db.close(); } catch { /* already closed */ } });
  const owner = 'owner-test';
  const generation = 'gen-test';
  assert.equal(db.acquireLease({ owner, generation, ttlMs: 7 * DAY }).ok, true);
  db.commitProjection({ scope: KEY, generation, payload: {} });
  for (const scopeKey of OTHER_SCOPES) db.commitProjection({ scope: scopeKey, generation, payload: {} });
  const dispatch = input => {
    const outcome = dispatchEvent(db, input, { handlers: { autonomy: applyPlanEvent }, generation, requireConsumers: true });
    if (outcome.rejected) {
      const failure = (outcome.results ?? []).find(result => result.error);
      throw Object.assign(new Error(failure?.error ?? 'rejected'), { code: failure?.code ?? 'rejected' });
    }
    return outcome;
  };
  return { clock, db, owner, generation, dispatch };
}

function makeBudget(world, { shouldYield = () => false, overrides = {} } = {}) {
  return createBudget({
    db: world.db,
    config: { p2: { budget: { maxRequestsPerDay: 64, maxInputTokensPerDay: 160000, maxOutputTokensPerDay: 24000, recoveryReserveRatio: 0.2, maxConcurrent: 2, chatPriority: true, maxCostPerDay: 0, ...overrides } } },
    clock: () => world.clock.value,
    timeZone: TZ, owner: world.owner, generation: world.generation, shouldYield,
  });
}

/** A model transport whose calls stay pending until the test releases them. */
function deferredModel() {
  const calls = [];
  const pending = [];
  const fn = request => new Promise(resolve => {
    calls.push(request);
    pending.push(resolve);
  });
  fn.calls = calls;
  fn.pending = pending;
  fn.release = (index, plan) => pending[index]({
    text: JSON.stringify(plan), provider: 'script', model: 'script-v1', inputTokens: 200, outputTokens: 90,
  });
  return fn;
}

function planFor(now) {
  return { summary: '读一点', slots: [{ kind: 'activity', activity: 'read', targetRef: 'shelf/notes.md', title: '读', startAt: now + 40 * MIN, endAt: now + 90 * MIN, flexibility: 'soft' }] };
}

function makePlanner(world, { model, budget, materials } = {}) {
  return createPlanner({
    db: world.db,
    config: { enabled: true, mode: 'active', timeZone: TZ, p2: { planning: { enabled: true, retryBackoffMs: 0 } } },
    clock: () => world.clock.value,
    owner: world.owner,
    generation: world.generation,
    dispatch: world.dispatch,
    callModel: model,
    budget,
    materials: materials ?? (() => ({ timeZone: TZ, persona: { version: 1, excerpt: 'bot' }, preferences: [], goals: [], commitments: [], fixedAgenda: [], runningActivities: [], lastReceipts: [], interests: [], opportunities: [], capabilities: [], budget: null })),
    pause: { mode: 'active' },
  });
}

// -------------------------------------------------------------- single flight

test('P2-26: a second tick for the same scope returns single-flight instead of queueing', async (t) => {
  const world = makeWorld(t);
  const model = deferredModel();
  const planner = makePlanner(world, { model, budget: makeBudget(world) });

  const first = planner.tick({ scopeKey: KEY, reason: 'manual' });
  const second = planner.tick({ scopeKey: KEY, reason: 'manual' });
  assert.equal(second.code, 'single-flight', 'the cheap gate answers synchronously');
  const secondResult = await second;
  assert.equal(secondResult.ok, false);
  assert.equal(secondResult.code, 'single-flight');

  await flush();
  assert.equal(model.calls.length, 1);
  model.release(0, planFor(T0));
  const firstResult = await first;
  assert.equal(firstResult.ok, true, JSON.stringify(firstResult));

  // Once the round finished, the scope is free again (and the day now has a plan).
  const third = await planner.tick({ scopeKey: KEY, reason: 'manual' });
  assert.equal(third.code, 'plan-exists');
});

test('P2-26: at most two background rounds run at once across scopes', async (t) => {
  const world = makeWorld(t);
  const model = deferredModel();
  const planner = makePlanner(world, { model, budget: makeBudget(world) });

  const a = planner.tick({ scopeKey: KEY, reason: 'manual' });
  const b = planner.tick({ scopeKey: OTHER_SCOPES[0], reason: 'manual' });
  const c = planner.tick({ scopeKey: OTHER_SCOPES[1], reason: 'manual' });
  assert.equal(c.code, 'concurrency-limit');
  assert.equal((await c).ok, false);
  assert.equal(PLAN_LIMITS.maxConcurrentRounds, 2);

  await flush();
  assert.equal(model.calls.length, 2, 'only two requests are in flight');
  model.release(0, planFor(T0));
  model.release(1, planFor(T0));
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.ok, true);
  assert.equal(rb.ok, true);

  // With both rounds settled, the third scope may plan.
  const third = planner.tick({ scopeKey: OTHER_SCOPES[1], reason: 'manual' });
  await flush();
  assert.equal(model.calls.length, 3);
  model.release(2, planFor(T0));
  assert.equal((await third).ok, true);
});

// ------------------------------------------------------------ foreground first

test('P2-26: chat priority refuses the reservation and the model is never called', async (t) => {
  const world = makeWorld(t);
  const budget = makeBudget(world, { shouldYield: () => true });
  let calls = 0;
  const model = async () => { calls += 1; return { text: '{}' }; };
  const planner = makePlanner(world, { model, budget });

  const outcome = await planner.tick({ scopeKey: KEY, reason: 'manual' });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'chat-priority');
  assert.equal(calls, 0, 'a foreground turn owns the model');
  assert.equal(budget.status({ scope: KEY }).requests.used, 0, 'a refused reservation books nothing');
  assert.equal(world.db.all('SELECT * FROM p2_plans WHERE scope = ?', KEY).length, 0);
  const run = world.db.get('SELECT status, error_code FROM p2_plan_runs WHERE scope = ?', KEY);
  assert.equal(run.status, 'skipped');
  assert.equal(run.error_code, 'chat-priority');
});

test('P2-26: two planners on the same scope share one plan and one pool', async (t) => {
  const world = makeWorld(t);
  const budget = makeBudget(world);
  const modelA = deferredModel();
  const modelB = deferredModel();
  const plannerA = makePlanner(world, { model: modelA, budget });
  const plannerB = makePlanner(world, { model: modelB, budget });

  const a = plannerA.tick({ scopeKey: KEY, reason: 'manual' });
  const b = plannerB.tick({ scopeKey: KEY, reason: 'manual' });
  // The claim row is written synchronously by the first planner, so the second cannot
  // start a competing round even though it is a different instance.
  assert.equal((await b).code, 'claim-held');
  await flush();
  modelA.release(0, planFor(T0));
  assert.equal((await a).ok, true);
  assert.equal(modelB.calls.length, 0);
  assert.equal(world.db.all('SELECT * FROM p2_plans WHERE scope = ?', KEY).length, 1);
  assert.equal(budget.status({ scope: KEY }).requests.used, 1);

  // Later ticks from either planner see the committed day.
  assert.equal((await withTimeout(plannerB.tick({ scopeKey: KEY, reason: 'manual' }))).code, 'plan-exists');
});

test('P2-26: ordinary planning never borrows from the recovery reserve', async (t) => {
  const world = makeWorld(t);
  const budget = makeBudget(world); // 13 of 64 held back for recovery
  for (let index = 0; index < 51; index += 1) {
    assert.equal(budget.reserve({ scope: KEY, purpose: 'p2-activity', ref: `fill_${index}` }).ok, true);
  }
  const status = budget.status({ scope: KEY });
  assert.equal(status.recoveryReserve.usableForNormalWork, 0);
  assert.equal(status.recoveryReserve.requests, 13);

  let calls = 0;
  const model = async () => { calls += 1; return { text: JSON.stringify(planFor(T0)) }; };
  const planner = makePlanner(world, { model, budget });
  const outcome = await planner.tick({ scopeKey: KEY, reason: 'manual' });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'budget-exhausted');
  assert.equal(calls, 0, 'a long activity already used the day; planning does not steal the reserve');
  assert.equal(budget.status({ scope: KEY }).requests.remaining, 13, 'the recovery reserve is intact');
});
