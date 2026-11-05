import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openRuntimeDb } from '../lib/db.mjs';
import { dispatchEvent, listEvents } from '../lib/events.mjs';
import { scopeKey as keyOfScope } from '../lib/scope.mjs';
import { applyPlanEvent, createPlanner } from '../lib/planner.mjs';

// P2 (v1.2 §3) — an opportunity is not an island.
//
// `planner.replanFromOpportunity` is the one causal entry point that turns a queued motivation
// into a *local* revision of the current day: it consumes exactly one open opportunity and runs
// one bounded planning round with the frozen explicit reason it maps onto (`checkpoint` by
// default). Everything that bounds cost still applies — the 30-minute model floor, the shared
// budget, the single-flight claim — and every refusal returns a code with **zero** model calls.

const TZ = 'Asia/Shanghai';
const MIN = 60000;
const DAY = 86400000;
const HOUR = 3600000;
const SCOPE = Object.freeze({ userId: 'owner-1', personaId: 'march7', worldId: 'world:default' });
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
  return { clock, db, owner, generation, dispatch, expectOk };
}

function scriptedModel(script) {
  const calls = [];
  const fn = async request => {
    calls.push(request);
    const index = Math.min(calls.length - 1, script.length - 1);
    const answer = script[index];
    const value = typeof answer === 'function' ? await answer(request, calls.length) : answer;
    if (value && typeof value === 'object' && typeof value.text === 'string') return value;
    return { text: typeof value === 'string' ? value : JSON.stringify(value), provider: 'script', model: 'script-v1', inputTokens: 120, outputTokens: 60 };
  };
  fn.calls = calls;
  return fn;
}

function makeMaterials() {
  return () => ({
    timeZone: TZ,
    persona: { version: 2, excerpt: '三月七' },
    preferences: [], goals: [], commitments: [], fixedAgenda: [], runningActivities: [], lastReceipts: [],
    interests: [], opportunities: [], capabilities: [], budget: null,
  });
}

function makePlanner(world, { model, budget } = {}) {
  const stubBudget = budget ?? {
    reserve: entry => ({ ok: true, ref: entry.ref }),
    markIssued: () => ({ ok: true }),
    settle: () => ({ ok: true }),
    release: () => ({ ok: true }),
    status: () => ({ requests: { limit: 64, used: 0, remaining: 64 } }),
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
    budget: stubBudget,
    materials: makeMaterials(),
    pause: { mode: 'active' },
  });
}

const planRows = world => world.db.all('SELECT * FROM p2_plans WHERE scope = ? ORDER BY version', KEY);
const slotRows = world => world.db.all('SELECT * FROM p2_plan_slots WHERE scope = ? ORDER BY start_at', KEY);
const opportunityRow = (world, id) => world.db.get('SELECT * FROM p2_opportunities WHERE scope = ? AND opportunity_id = ?', KEY, id);
const runRows = world => world.db.all('SELECT * FROM p2_plan_runs WHERE scope = ? ORDER BY started_at', KEY);

/** Queue one opportunity whose origin is the id of a real event already in the log. */
function queueOpportunity(world, { opportunityId = 'opp_1', kind = 'new-material', source = 'shelf/new.md', expiresIn = DAY, originEventId } = {}) {
  const origin = originEventId ?? listEvents(world.db, { scopeKey: KEY, limit: 1 })[0]?.eventId ?? 'evt_origin';
  const outcome = world.dispatch({
    kind: 'autonomy/opportunity',
    scope: SCOPE,
    occurredAt: world.clock.value,
    payload: {
      action: 'queue',
      at: world.clock.value,
      opportunityId,
      dedupeKey: `dk_${opportunityId}`,
      originEventId: origin,
      opportunity: { kind, source, dedupeKey: `dk_${opportunityId}`, weight: 1, expiresAt: world.clock.value + expiresIn, payload: { ref: source } },
    },
  });
  assert.equal(outcome.rejected, false, JSON.stringify(outcome.results));
  return origin;
}

const initialPlan = { summary: '下午读一段', slots: [{ kind: 'activity', activity: 'read', title: '读旧材料', startAt: T0 + 40 * MIN, endAt: T0 + 90 * MIN, flexibility: 'soft', targetRef: 'shelf/old.md' }] };

test('P2-31: one open opportunity with a real origin triggers exactly one bounded replan', async (t) => {
  const world = makeWorld(t);
  const model = scriptedModel([
    initialPlan,
    { summary: '有新材料，改成读它', slots: [{ kind: 'activity', activity: 'read', title: '读新材料', startAt: T0 + 100 * MIN, endAt: T0 + 140 * MIN, flexibility: 'soft', targetRef: 'shelf/new.md' }] },
  ]);
  const planner = makePlanner(world, { model });
  assert.equal((await planner.tick({ scopeKey: KEY, reason: 'manual', now: T0 })).ok, true);
  assert.equal(planRows(world).length, 1);

  world.clock.value = T0 + 35 * MIN; // outside the 30-minute floor
  const origin = queueOpportunity(world);
  const replan = await planner.replanFromOpportunity({ scopeKey: KEY, opportunityId: 'opp_1', now: world.clock.value });
  assert.equal(replan.ok, true, JSON.stringify(replan.round ?? replan));
  assert.equal(replan.code, 'committed');
  assert.equal(replan.mappedReason, 'checkpoint', 'an opportunity maps onto a frozen explicit reason');
  assert.equal(replan.consumed, true);
  assert.equal(replan.version, 2);
  assert.equal(model.calls.length, 2, 'exactly one extra model call for the replan');
  assert.equal(replan.modelCalls, 1);

  const plans = planRows(world);
  assert.equal(plans.length, 2);
  assert.equal(plans.filter(row => row.status === 'committed').length, 1, 'one committed version per day');
  assert.equal(plans[0].status, 'superseded');
  const current = plans[1];
  assert.equal(Number(current.version), 2);
  const slot = slotRows(world).find(row => row.plan_id === current.plan_id);
  assert.equal(slot.target_ref, 'shelf/new.md', 'the changed slot carries the new material');

  // The queue row is consumed, and the causal chain is on the run row.
  assert.equal(opportunityRow(world, 'opp_1').status, 'consumed');
  const runs = runRows(world);
  const replanRun = runs.at(-1);
  assert.equal(replanRun.trigger, 'opportunity:checkpoint', 'the run row names both the entry point and the mapped reason');
  assert.equal(replanRun.opportunity_id, 'opp_1', 'the run row names the opportunity that caused it');
  assert.equal(replanRun.status, 'committed');
  assert.ok(origin);
});

test('P2-31: a second call for the same opportunity does nothing', async (t) => {
  const world = makeWorld(t);
  const model = scriptedModel([
    initialPlan,
    { summary: '改读新材料', slots: [{ kind: 'activity', activity: 'read', title: '读新材料', startAt: T0 + 100 * MIN, endAt: T0 + 140 * MIN, flexibility: 'soft', targetRef: 'shelf/new.md' }] },
  ]);
  const planner = makePlanner(world, { model });
  await planner.tick({ scopeKey: KEY, reason: 'manual', now: T0 });
  world.clock.value = T0 + 35 * MIN;
  queueOpportunity(world);
  const first = await planner.replanFromOpportunity({ scopeKey: KEY, opportunityId: 'opp_1', now: world.clock.value });
  assert.equal(first.ok, true);
  const callsAfter = model.calls.length;

  world.clock.value = T0 + 120 * MIN;
  const again = await planner.replanFromOpportunity({ scopeKey: KEY, opportunityId: 'opp_1', now: world.clock.value });
  assert.equal(again.ok, false);
  assert.equal(again.code, 'opportunity-not-open');
  assert.equal(again.consumed, false);
  assert.equal(model.calls.length, callsAfter, 'a consumed opportunity never reaches the model');
  assert.equal(planRows(world).length, 2, 'no new version');
});

test('P2-31: an expired opportunity returns a code and calls nothing', async (t) => {
  const world = makeWorld(t);
  const model = scriptedModel([initialPlan]);
  const planner = makePlanner(world, { model });
  await planner.tick({ scopeKey: KEY, reason: 'manual', now: T0 });
  queueOpportunity(world, { opportunityId: 'opp_old', expiresIn: 5 * MIN });
  world.clock.value = T0 + 40 * MIN; // past both the floor and the expiry
  const calls = model.calls.length;
  const out = await planner.replanFromOpportunity({ scopeKey: KEY, opportunityId: 'opp_old', now: world.clock.value });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'opportunity-expired');
  assert.equal(out.modelCalls, 0);
  assert.equal(model.calls.length, calls, 'the model is never called');
  assert.equal(planRows(world).length, 1);
  assert.equal(opportunityRow(world, 'opp_old').status, 'open', 'an expired-but-open row is left for the housekeeping path');
});

test('P2-31: an opportunity row without provenance is refused by the entry point too', async (t) => {
  const world = makeWorld(t);
  const model = scriptedModel([initialPlan]);
  const planner = makePlanner(world, { model });
  await planner.tick({ scopeKey: KEY, reason: 'manual', now: T0 });
  // A hostile row: written straight into the table, so no reducer ever validated it.
  world.db.run(`INSERT INTO p2_opportunities (opportunity_id, scope, kind, source, dedupe_key, weight, created_at, expires_at, status, payload)
                VALUES (?, ?, 'curiosity', 'shelf/x.md', ?, 1, ?, ?, 'open', ?)`,
  'opp_hostile', KEY, 'dk_hostile', T0, T0 + DAY, JSON.stringify({ ref: 'shelf/x.md' }));
  world.clock.value = T0 + 40 * MIN;
  const calls = model.calls.length;
  const out = await planner.replanFromOpportunity({ scopeKey: KEY, opportunityId: 'opp_hostile', now: world.clock.value });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'invalid-opportunity', 'BLOCK-8: no origin, no replan');
  assert.equal(model.calls.length, calls);
  assert.equal(planRows(world).length, 1);
});

test('P2-31: the 30-minute floor still applies to an opportunity-driven replan', async (t) => {
  const world = makeWorld(t);
  const model = scriptedModel([
    initialPlan,
    { summary: '改读新材料', slots: [{ kind: 'activity', activity: 'read', title: '读新材料', startAt: T0 + 50 * MIN, endAt: T0 + 80 * MIN, flexibility: 'soft', targetRef: 'shelf/new.md' }] },
  ]);
  const planner = makePlanner(world, { model });
  await planner.tick({ scopeKey: KEY, reason: 'manual', now: T0 });
  queueOpportunity(world);
  world.clock.value = T0 + 10 * MIN; // inside the floor
  const calls = model.calls.length;
  const out = await planner.replanFromOpportunity({ scopeKey: KEY, opportunityId: 'opp_1', now: world.clock.value });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'rate-limited');
  assert.equal(out.modelCalls, 0);
  assert.equal(model.calls.length, calls);
  assert.equal(out.nextAttemptAt, T0 + 30 * MIN);
  assert.equal(opportunityRow(world, 'opp_1').status, 'open', 'the motivation is kept for the allowed moment');

  // Once the floor passes, the same call succeeds.
  world.clock.value = T0 + 31 * MIN;
  const allowed = await planner.replanFromOpportunity({ scopeKey: KEY, opportunityId: 'opp_1', now: world.clock.value });
  assert.equal(allowed.ok, true, JSON.stringify(allowed.round ?? allowed));
  assert.equal(allowed.version, 2);
});

test('P2-31: an exhausted budget returns a code, calls nothing and keeps the opportunity', async (t) => {
  const world = makeWorld(t);
  const model = scriptedModel([initialPlan, { summary: '改读新材料', slots: [{ kind: 'open', title: '留白', startAt: T0 + 50 * MIN, endAt: T0 + 80 * MIN, flexibility: 'soft' }] }]);
  const spentBudget = {
    reserve: () => ({ ok: false, code: 'budget-exhausted' }),
    markIssued: () => ({ ok: false, code: 'budget-exhausted' }),
    settle: () => ({ ok: true }),
    release: () => ({ ok: true }),
    status: () => ({ requests: { limit: 64, used: 64, remaining: 0 } }),
  };
  const planner = makePlanner(world, { model, budget: spentBudget });
  // The daily plan has to exist without a model call taking budget: write it through the reducer.
  world.expectOk({
    kind: 'autonomy/plan-committed',
    scope: SCOPE,
    occurredAt: T0,
    payload: {
      at: T0, day: '2026-11-02', timeZone: TZ, sourceRunId: 'run_seed', snapshotDigest: 'd_seed',
      plan: { planId: 'plan_v1', day: '2026-11-02', version: 1, windowStart: T0, windowEnd: T0 + 8 * HOUR, summary: '下午读一段', timeZone: TZ, slots: [{ kind: 'activity', activity: 'read', title: '读旧材料', startAt: T0 + 40 * MIN, endAt: T0 + 90 * MIN, flexibility: 'soft', targetRef: 'shelf/old.md' }] },
    },
  });
  queueOpportunity(world, { opportunityId: 'opp_broke' });
  world.clock.value = T0 + 40 * MIN;
  const out = await planner.replanFromOpportunity({ scopeKey: KEY, opportunityId: 'opp_broke', now: world.clock.value });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'budget-exhausted');
  assert.equal(out.modelCalls, 0);
  assert.equal(model.calls.length, 0, 'the model is never called when the pool is empty');
  assert.equal(planRows(world).length, 1, 'no plan change');
  assert.equal(planRows(world)[0].plan_id, 'plan_v1');
  assert.equal(opportunityRow(world, 'opp_broke').status, 'open');
});

test('P2-31: a missing or unknown opportunity never reaches the model', async (t) => {
  const world = makeWorld(t);
  const model = scriptedModel([initialPlan]);
  const planner = makePlanner(world, { model });
  await planner.tick({ scopeKey: KEY, reason: 'manual', now: T0 });
  const missing = await planner.replanFromOpportunity({ scopeKey: KEY, now: T0 });
  assert.equal(missing.code, 'opportunity-required');
  const unknown = await planner.replanFromOpportunity({ scopeKey: KEY, opportunityId: 'opp_ghost', now: T0 });
  assert.equal(unknown.code, 'opportunity-not-found');
  assert.equal(model.calls.length, 1, 'only the initial tick called the model');
  assert.equal(planRows(world).length, 1);
});

// ------------------------------------- external acceptance: no slot without a real source
//
// A real-host run produced an `empty`-quality `read` slot titled "翻几页闲书" with no
// `targetRef`, which the pump could never execute. A tool slot must name the concrete thing the
// tool will open or write; otherwise the whole plan is refused as `invalid-plan` and the run is
// recorded as `rejected`.

test('P2-31: a sourceless read slot is refused as invalid-plan, nothing is committed', async (t) => {
  const world = makeWorld(t);
  const model = scriptedModel([
    { summary: '翻几页闲书', slots: [{ kind: 'activity', activity: 'read', title: '翻几页闲书', startAt: T0 + 10 * MIN, endAt: T0 + 70 * MIN, flexibility: 'soft' }] },
  ]);
  const planner = makePlanner(world, { model });
  const out = await planner.tick({ scopeKey: KEY, reason: 'manual', now: T0 });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'invalid-plan');
  assert.match(out.error, /slot-without-source/);
  assert.equal(planRows(world).length, 0, 'no plan row');
  assert.equal(slotRows(world).length, 0, 'no slots');
  const run = runRows(world).at(-1);
  assert.equal(run.status, 'rejected');
  assert.equal(run.error_code, 'invalid-plan');
  assert.match(run.error_detail, /slot-without-source/);
});

test('P2-31: a write slot needs a concrete document target, and a real one commits', async (t) => {
  const world = makeWorld(t);
  const vague = scriptedModel([{ summary: '写点东西', slots: [{ kind: 'activity', activity: 'write', title: '写点东西', startAt: T0 + 10 * MIN, endAt: T0 + 50 * MIN, flexibility: 'soft', targetRef: '随手写写' }] }]);
  const planner = makePlanner(world, { model: vague });
  const refused = await planner.tick({ scopeKey: KEY, reason: 'manual', now: T0 });
  assert.equal(refused.code, 'invalid-plan');
  assert.match(refused.error, /slot-without-source/);
  assert.equal(planRows(world).length, 0);

  // Past the 30-minute floor that the first (refused) round now occupies.
  world.clock.value = T0 + 40 * MIN;
  const concrete = scriptedModel([{ summary: '写一段', slots: [{ kind: 'activity', activity: 'write', title: '写一段', startAt: T0 + 50 * MIN, endAt: T0 + 90 * MIN, flexibility: 'soft', targetRef: 'drafts/notes' }] }]);
  const good = makePlanner(world, { model: concrete });
  const committed = await good.tick({ scopeKey: KEY, reason: 'manual', now: world.clock.value });
  assert.equal(committed.ok, true, JSON.stringify(committed));
  const slot = slotRows(world)[0];
  assert.equal(slot.target_ref, 'drafts/notes');
  assert.equal(Number(slot.locked), 0);
});

test('P2-31: the material names the only allowed targets, in the prompt and in the validator', async (t) => {
  const world = makeWorld(t);
  const material = {
    timeZone: TZ,
    persona: { version: 2, excerpt: '三月七' },
    preferences: [], goals: [], commitments: [], fixedAgenda: [], runningActivities: [], lastReceipts: [],
    interests: [], opportunities: [], capabilities: [], budget: null,
    sources: ['shelf/tides.md', { url: 'https://example.org/tides' }],
  };
  const seen = [];
  const model = async request => {
    seen.push(request);
    return { text: JSON.stringify({ summary: '读那篇真的', slots: [{ kind: 'activity', activity: 'read', title: '读潮汐', startAt: T0 + 10 * MIN, endAt: T0 + 50 * MIN, flexibility: 'soft', targetRef: 'shelf/made-up.md' }] }), provider: 'script', model: 'script-v1', inputTokens: 100, outputTokens: 50 };
  };
  const planner = createPlanner({
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
    budget: { reserve: entry => ({ ok: true, ref: entry.ref }), markIssued: () => ({ ok: true }), settle: () => ({ ok: true }), release: () => ({ ok: true }), status: () => ({}) },
    materials: () => material,
    pause: { mode: 'active' },
  });
  const refused = await planner.tick({ scopeKey: KEY, reason: 'manual', now: T0 });
  assert.equal(refused.code, 'invalid-plan');
  assert.match(refused.error, /slot-target-not-in-materials/);
  assert.equal(planRows(world).length, 0);
  // The prompt offered them as the only targets.
  const prompt = seen[0]?.input ?? '';
  assert.match(prompt, /shelf\/tides\.md/, 'the offered path is in the prompt');
  assert.match(prompt, /https:\/\/example\.org\/tides/, 'the offered URL is in the prompt');
  assert.match(prompt, /只能用这些目标/, 'and the prompt says they are the only allowed ones');
});

test('P2-31: a hand-written event cannot slip a sourceless slot past the reducer', async (t) => {
  const world = makeWorld(t);
  const code = (() => {
    try {
      world.expectOk({
        kind: 'autonomy/plan-committed',
        scope: SCOPE,
        occurredAt: T0,
        payload: {
          at: T0, day: '2026-11-02', timeZone: TZ, sourceRunId: 'run_seed', snapshotDigest: 'd_seed',
          plan: { planId: 'plan_bad', day: '2026-11-02', version: 1, windowStart: T0, windowEnd: T0 + 8 * HOUR, summary: '坏的', timeZone: TZ, slots: [{ kind: 'activity', activity: 'read', title: '翻几页闲书', startAt: T0 + 10 * MIN, endAt: T0 + 40 * MIN, flexibility: 'soft' }] },
        },
      });
      return 'accepted';
    } catch (error) {
      return String(error.message ?? '').includes('slot-without-source') ? 'refused' : `other:${error.message}`;
    }
  })();
  assert.equal(code, 'refused');
  assert.equal(planRows(world).length, 0);
});
