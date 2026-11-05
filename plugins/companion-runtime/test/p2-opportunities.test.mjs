import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openRuntimeDb } from '../lib/db.mjs';
import { dispatchEvent } from '../lib/events.mjs';
import { scopeKey as keyOfScope } from '../lib/scope.mjs';
import { applyPlanEvent, createPlanner, dedupeKeyFor, PLAN_LIMITS } from '../lib/planner.mjs';

// P2-02 — trigger sources, the opportunity queue and the bounded decision cadence.
//
// Two layers are covered:
//   * the `autonomy/opportunity` reducer: dedupe by `dedupe_key`, merge instead of a second
//     row, one-way states, and the amendment BLOCK-8 origin requirement;
//   * the planner's cadence gates: a 30-minute minimum between model calls unless the
//     reason is one of the four explicit replan reasons, and `plan-exists` for anything
//     else once the day has a plan.

const TZ = 'Asia/Shanghai';
const MIN = 60000;
const DAY = 86400000;
const SCOPE = Object.freeze({ userId: 'owner-1', personaId: 'march7', worldId: 'world:default' });
const KEY = keyOfScope(SCOPE);
const T0 = Date.UTC(2026, 10, 2, 5, 41, 0); // 2026-11-02 13:41 Asia/Shanghai

function makeWorld(t, { start = T0 } = {}) {
  const clock = { value: start };
  const db = openRuntimeDb({ file: ':memory:', now: () => clock.value });
  t.after(() => { try { db.close(); } catch { /* already closed */ } });
  const owner = 'owner-test';
  const generation = 'gen-test';
  assert.equal(db.acquireLease({ owner, generation, ttlMs: 7 * DAY }).ok, true);
  db.commitProjection({ scope: KEY, generation, payload: {} });
  function dispatch(input) {
    return dispatchEvent(db, input, { handlers: { autonomy: applyPlanEvent }, generation, requireConsumers: true });
  }
  function expectOk(input) {
    const outcome = dispatch(input);
    assert.equal(outcome.rejected, false, JSON.stringify(outcome.results));
    const failure = outcome.results.find(result => result.error);
    assert.equal(failure, undefined, JSON.stringify(failure));
    return outcome.results.find(result => result.applied)?.result ?? {};
  }
  function expectRejected(input) {
    const outcome = dispatch(input);
    assert.equal(outcome.rejected, true, 'the event must be rolled back');
    const failure = outcome.results.find(result => result.error);
    return failure?.code ?? 'unknown';
  }
  return { clock, db, owner, generation, dispatch, expectOk, expectRejected };
}

function queueEvent(world, { opportunityId, dedupeKey, kind = 'curiosity', origin = 'evt_origin_1', weight = 1, at = T0 }) {
  return {
    kind: 'autonomy/opportunity',
    scope: SCOPE,
    occurredAt: at,
    payload: {
      action: 'queue',
      at,
      opportunityId,
      dedupeKey,
      originEventId: origin,
      opportunity: { kind, source: 'scripted', dedupeKey, weight, expiresAt: at + DAY, payload: { ref: 'source-1' } },
    },
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
    return { text: typeof value === 'string' ? value : JSON.stringify(value), provider: 'script', model: 'script-v1', inputTokens: 120, outputTokens: 50 };
  };
  fn.calls = calls;
  return fn;
}

function makeBudget({ maxRequests = 8 } = {}) {
  const ledger = { requests: 0 };
  return {
    ledger,
    reserve({ ref }) {
      if (ledger.requests + 1 > maxRequests) return { ok: false, code: 'budget-exhausted' };
      ledger.requests += 1;
      return { ok: true, ref };
    },
    markIssued() { return { ok: true }; },
    settle() { return { ok: true }; },
    release() { return { ok: true }; },
    status() { return { requests: { used: ledger.requests, limit: maxRequests } }; },
  };
}

function makeMaterials(overrides = {}) {
  return () => ({
    timeZone: TZ,
    persona: { version: 1, excerpt: '三月七' },
    preferences: [], goals: [], commitments: [], fixedAgenda: [], runningActivities: [], lastReceipts: [],
    interests: [], opportunities: [], capabilities: [], budget: null, ...overrides,
  });
}

function makePlanner(world, { model, materials = makeMaterials(), budget = makeBudget() } = {}) {
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

function tick(planner, reason) {
  return planner.tick({ scopeKey: KEY, reason });
}

function opportunityRows(world) {
  return world.db.all('SELECT * FROM p2_opportunities WHERE scope = ? ORDER BY created_at ASC, opportunity_id ASC', KEY);
}

const PLAN = {
  summary: '下午读一点',
  slots: [{ kind: 'activity', activity: 'read', targetRef: 'shelf/notes.md', title: '读一段', startAt: T0 + 30 * MIN, endAt: T0 + 90 * MIN, flexibility: 'soft' }],
};

// ------------------------------------------------------------ reducer: queue

test('P2-02: queueing requires a dedupe key and an origin event/receipt', async (t) => {
  const world = makeWorld(t);
  // BLOCK-8: an opportunity without a traceable origin is not evidence.
  const code = world.expectRejected({
    kind: 'autonomy/opportunity',
    scope: SCOPE,
    occurredAt: T0,
    payload: { action: 'queue', at: T0, dedupeKey: 'k1', opportunity: { kind: 'curiosity', dedupeKey: 'k1' } },
  });
  assert.equal(code, 'invalid-opportunity');
  const noKey = world.expectRejected({
    kind: 'autonomy/opportunity',
    scope: SCOPE,
    occurredAt: T0,
    payload: { action: 'queue', at: T0, originEventId: 'evt_1', opportunity: { kind: 'curiosity' } },
  });
  assert.equal(noKey, 'invalid-opportunity');
  assert.equal(opportunityRows(world).length, 0, 'a refused opportunity never lands');
});

test('P2-02: the same cause merges into one open row instead of a second candidate', async (t) => {
  const world = makeWorld(t);
  const dedupeKey = dedupeKeyFor(KEY, 'curiosity', 'article-1');
  const first = world.expectOk(queueEvent(world, { opportunityId: 'opp_1', dedupeKey }));
  assert.equal(first.action, 'queued');
  const second = world.expectOk(queueEvent(world, { opportunityId: 'opp_2', dedupeKey, origin: 'evt_origin_2' }));
  assert.equal(second.action, 'merged');
  assert.equal(second.opportunityId, 'opp_1', 'the merge stays on the original row');
  const rows = opportunityRows(world);
  assert.equal(rows.length, 1, 'one open row per (scope, dedupe_key)');
  assert.equal(Number(rows[0].weight), 1, 'a same-cause repeat never inflates the score');
  const third = world.expectOk(queueEvent(world, { opportunityId: 'opp_3', dedupeKey, origin: 'evt_origin_3', weight: 5 }));
  assert.equal(third.weight, PLAN_LIMITS.maxOpportunityWeight, 'weight never exceeds the frozen ceiling');
  assert.equal(opportunityRows(world).length, 1);
});

test('P2-02: opportunity states are one-way, and a consume/expire repeat is kept not re-opened', async (t) => {
  const world = makeWorld(t);
  const dedupeKey = 'k-consume';
  world.expectOk(queueEvent(world, { opportunityId: 'opp_c', dedupeKey }));
  const consumed = world.expectOk({
    kind: 'autonomy/opportunity',
    scope: SCOPE,
    occurredAt: T0 + MIN,
    payload: { action: 'consume', at: T0 + MIN, opportunityId: 'opp_c' },
  });
  assert.equal(consumed.action, 'consumed');
  // A second consume is idempotent, not an error, and never re-opens.
  const again = world.expectOk({
    kind: 'autonomy/opportunity',
    scope: SCOPE,
    occurredAt: T0 + 2 * MIN,
    payload: { action: 'consume', at: T0 + 2 * MIN, opportunityId: 'opp_c' },
  });
  assert.equal(again.action, 'kept');
  // Consumed → expired is an invalid transition and rolls the whole event back.
  const code = world.expectRejected({
    kind: 'autonomy/opportunity',
    scope: SCOPE,
    occurredAt: T0 + 3 * MIN,
    payload: { action: 'expire', at: T0 + 3 * MIN, opportunityId: 'opp_c' },
  });
  assert.equal(code, 'invalid-transition');
  const rows = opportunityRows(world);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'consumed');
});

test('P2-02: an expired cause can queue again as a new open row', async (t) => {
  const world = makeWorld(t);
  const dedupeKey = 'k-expire';
  world.expectOk(queueEvent(world, { opportunityId: 'opp_e1', dedupeKey }));
  world.expectOk({
    kind: 'autonomy/opportunity',
    scope: SCOPE,
    occurredAt: T0 + MIN,
    payload: { action: 'expire', at: T0 + MIN, opportunityId: 'opp_e1' },
  });
  const requeued = world.expectOk(queueEvent(world, { opportunityId: 'opp_e2', dedupeKey, origin: 'evt_origin_9', at: T0 + 2 * MIN }));
  assert.equal(requeued.action, 'queued', 'a closed cause may queue again');
  const rows = opportunityRows(world);
  assert.equal(rows.length, 2, 'history (expired) is kept next to the new open row');
  assert.deepEqual(rows.map(row => row.status), ['expired', 'open']);
});

test('P2-02: dedupe keys are stable and scope-bound', async () => {
  const a = dedupeKeyFor(KEY, 'curiosity', 'article-1');
  const b = dedupeKeyFor(KEY, 'curiosity', 'article-1');
  const otherScope = dedupeKeyFor('u:other|p:march7|w:world:default', 'curiosity', 'article-1');
  const otherKind = dedupeKeyFor(KEY, 'novelty', 'article-1');
  assert.equal(a, b, 'the same (scope, kind, sourceKey) always yields the same key');
  assert.notEqual(a, otherScope, 'another scope never shares a cause');
  assert.notEqual(a, otherKind, 'another kind never shares a cause');
  assert.match(a, /^opp_[0-9a-f]{40}$/);
});

// ------------------------------------------------------------ planner cadence

test('P2-02: replans happen only for the four explicit reasons', async (t) => {
  const world = makeWorld(t);
  const model = scriptedModel([PLAN, { ...PLAN, summary: '第二个计划' }]);
  const planner = makePlanner(world, { model });

  assert.equal((await tick(planner, 'manual')).ok, true);
  world.clock.value = T0 + 20 * MIN;
  for (const reason of ['curiosity', 'inspiration', 'new-material', 'idle-gap', 'timer', 'day-change']) {
    const refused = await tick(planner, reason);
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'plan-exists', `${reason} may not replace a same-day plan`);
    assert.equal(refused.modelCalls, 0);
  }
  assert.equal(model.calls.length, 1, 'no model call from a non-explicit reason');
  for (const reason of ['user-change', 'checkpoint:slot_9', 'failure', 'source-invalid']) {
    const allowed = await tick(planner, reason);
    assert.equal(allowed.ok, true, `${reason} is an explicit replan reason`);
  }
  assert.equal(model.calls.length, 5);
});

test('P2-02: two model calls are at least 30 minutes apart unless the reason is explicit', async (t) => {
  const world = makeWorld(t);
  const laterPlan = () => {
    const now = world.clock.value;
    return { summary: '迟到的计划', slots: [{ kind: 'open', title: '留白', startAt: now + 10 * MIN, endAt: now + 40 * MIN, flexibility: 'soft' }] };
  };
  const model = scriptedModel(['{"summary":"坏掉的答案"', '{"summary":"坏掉的答案"', laterPlan]);
  const planner = makePlanner(world, { model });

  const first = await tick(planner, 'timer');
  assert.equal(first.code, 'invalid-plan');
  assert.equal(model.calls.length, PLAN_LIMITS.maxAttempts);

  // Same day, no plan row, non-explicit reason, 5 minutes later: the gap gate refuses
  // before any model call happens.
  world.clock.value = T0 + 5 * MIN;
  const throttled = await tick(planner, 'timer');
  assert.equal(throttled.ok, false);
  assert.equal(throttled.code, 'rate-limited');
  assert.ok(throttled.nextAttemptAt >= T0 + PLAN_LIMITS.minModelGapMs - MIN);
  assert.equal(model.calls.length, PLAN_LIMITS.maxAttempts, 'the model was not called again');

  world.clock.value = T0 + PLAN_LIMITS.minModelGapMs + MIN;
  const retried = await tick(planner, 'timer');
  assert.equal(retried.ok, true, JSON.stringify(retried));
  assert.equal(model.calls.length, PLAN_LIMITS.maxAttempts + 1);
});

test('P2-02: an explicit reason bypasses the 30-minute gap', async (t) => {
  const world = makeWorld(t);
  const model = scriptedModel([PLAN, { ...PLAN, summary: '用户改期了' }]);
  const planner = makePlanner(world, { model });

  assert.equal((await tick(planner, 'manual')).ok, true);
  world.clock.value = T0 + 2 * MIN;
  const replan = await tick(planner, 'user-change');
  assert.equal(replan.ok, true, JSON.stringify(replan));
  assert.equal(model.calls.length, 2);
});

test('P2-02: after two consecutive model failures the planner cools down', async (t) => {
  const world = makeWorld(t);
  const model = scriptedModel(['not json at all', 'still not json', PLAN]);
  const planner = makePlanner(world, { model });

  const first = await tick(planner, 'timer');
  assert.equal(first.code, 'invalid-plan');
  // A second round (allowed by the 30-minute gap once it has elapsed) fails too.
  world.clock.value = T0 + PLAN_LIMITS.minModelGapMs + MIN;
  const second = await tick(planner, 'timer');
  assert.equal(second.code, 'invalid-plan');
  const callsAfterTwo = model.calls.length;

  // Now two consecutive failed runs are on record: every reason cools down.
  world.clock.value = T0 + PLAN_LIMITS.minModelGapMs + 2 * MIN;
  const cooled = await tick(planner, 'failure');
  assert.equal(cooled.ok, false);
  assert.equal(cooled.code, 'cooldown');
  assert.equal(cooled.modelCalls, 0);
  assert.equal(model.calls.length, callsAfterTwo);
  assert.ok(planner.status({ scopeKey: KEY }).runs.nextAttemptAt > 0);
});

// Review pass 2: provenance is stored on the row, so `p2_opportunities` is self-describing
// (the envelope event id always, the producer's receipt id when it supplied one). Ids only.
test('P2-02: a queued opportunity keeps its provenance on the row', async (t) => {
  const world = makeWorld(t);
  const dedupeKey = 'k-provenance';
  const outcome = world.dispatch({
    kind: 'autonomy/opportunity',
    scope: SCOPE,
    occurredAt: T0,
    payload: {
      action: 'queue', at: T0, opportunityId: 'opp_p', dedupeKey, originReceiptId: 'rcp_abc',
      opportunity: { kind: 'curiosity', source: 'shelf/x.md', dedupeKey, weight: 1, payload: { ref: 'shelf/x.md', sourceHashPrefix: 'abcdef0123456789' } },
    },
  });
  assert.equal(outcome.rejected, false, JSON.stringify(outcome.results));
  const row = world.db.get('SELECT * FROM p2_opportunities WHERE opportunity_id = ?', 'opp_p');
  const stored = JSON.parse(row.payload);
  assert.equal(stored.originEventId, outcome.event.eventId, 'the envelope event id is stored');
  assert.equal(stored.originReceiptId, 'rcp_abc', 'the producer receipt id is stored');
  assert.equal(stored.ref, 'shelf/x.md');
  assert.equal(stored.sourceHashPrefix, 'abcdef0123456789', 'the producer reference block survives');
  for (const value of Object.values(stored)) {
    assert.equal(typeof value, 'string');
    assert.ok(value.length <= 160, 'the stored payload stays id-sized');
  }

  // A later merge with the same cause updates the event id but keeps the receipt origin.
  const second = world.dispatch({
    kind: 'autonomy/opportunity',
    scope: SCOPE,
    occurredAt: T0 + MIN,
    payload: {
      action: 'queue', at: T0 + MIN, opportunityId: 'opp_p2', dedupeKey, originEventId: 'evt_repeat',
      opportunity: { kind: 'curiosity', source: 'shelf/x.md', dedupeKey, weight: 1 },
    },
  });
  assert.equal(second.rejected, false);
  const merged = JSON.parse(world.db.get('SELECT payload FROM p2_opportunities WHERE opportunity_id = ?', 'opp_p').payload);
  assert.equal(merged.originEventId, second.event.eventId, 'the merged row tracks the latest cause');
  assert.equal(merged.originReceiptId, 'rcp_abc', 'the first real receipt evidence is not lost by a merge');
  assert.equal(world.db.all('SELECT * FROM p2_opportunities WHERE scope = ?', KEY).length, 1);
});
