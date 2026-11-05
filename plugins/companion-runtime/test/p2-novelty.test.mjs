import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openRuntimeDb } from '../lib/db.mjs';
import { dispatchEvent, listEvents } from '../lib/events.mjs';
import { scopeKey as keyOfScope } from '../lib/scope.mjs';
import { applyPlanEvent, createPlanner, dedupeKeyFor, PLAN_LIMITS } from '../lib/planner.mjs';

// P2-25 — novelty vs familiarity vs idling, and the honesty boundary around it.
//
// Diversity must not become a scoring treadmill: the same source never raises a candidate's
// weight, a novelty trigger does not buy a second model call for the day, and an idle day
// (rest/open, zero output) is a legitimate result instead of a failure. A soft direction is
// a plan-level interest — never a skill claim, never a memory, never an activity receipt.

const TZ = 'Asia/Shanghai';
const MIN = 60000;
const DAY = 86400000;
const SCOPE = Object.freeze({ userId: 'owner-1', personaId: 'bot', worldId: 'world:default' });
const KEY = keyOfScope(SCOPE);
const T0 = Date.UTC(2026, 10, 2, 5, 41, 0);

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
    return { text: typeof value === 'string' ? value : JSON.stringify(value), provider: 'script', model: 'script-v1', inputTokens: 88, outputTokens: 33 };
  };
  fn.calls = calls;
  return fn;
}

function makePlanner(world, { model, materials } = {}) {
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
    materials: materials ?? (() => ({ timeZone: TZ, persona: { version: 1, excerpt: 'bot' }, preferences: [], goals: [], commitments: [], fixedAgenda: [], runningActivities: [], lastReceipts: [], interests: [], opportunities: [], capabilities: [], budget: null })),
    pause: { mode: 'active' },
  });
}

const tick = (planner, reason = 'manual') => planner.tick({ scopeKey: KEY, reason });
const slotRows = world => world.db.all('SELECT * FROM p2_plan_slots WHERE scope = ? ORDER BY start_at', KEY);

function queueEvent({ opportunityId, dedupeKey, kind = 'novelty', weight = 1, at = T0, sourceKey = 'article-1' }) {
  return {
    kind: 'autonomy/opportunity',
    scope: SCOPE,
    occurredAt: at,
    payload: {
      action: 'queue', at, opportunityId, dedupeKey, originEventId: `evt_${opportunityId}`,
      opportunity: { kind, source: sourceKey, dedupeKey, weight, expiresAt: at + DAY },
    },
  };
}

// ---------------------------------------------------------------- novelty

test('P2-25: novelty is a queue signal, not a score — the same source never inflates', async (t) => {
  const world = makeWorld(t);
  const dedupeKey = dedupeKeyFor(KEY, 'novelty', 'article-1');
  world.expectOk(queueEvent({ opportunityId: 'opp_n1', dedupeKey }));
  world.expectOk(queueEvent({ opportunityId: 'opp_n2', dedupeKey, weight: 2, at: T0 + MIN }));
  world.expectOk(queueEvent({ opportunityId: 'opp_n3', dedupeKey, weight: 9, at: T0 + 2 * MIN }));
  const rows = world.db.all('SELECT * FROM p2_opportunities WHERE scope = ?', KEY);
  assert.equal(rows.length, 1, 'one row for one source');
  assert.equal(Number(rows[0].weight), PLAN_LIMITS.maxOpportunityWeight, 'the weight is capped, never accumulated');
  // A different source is a genuinely different candidate.
  world.expectOk(queueEvent({ opportunityId: 'opp_n4', dedupeKey: dedupeKeyFor(KEY, 'novelty', 'article-2'), sourceKey: 'article-2', at: T0 + 3 * MIN }));
  assert.equal(world.db.all('SELECT * FROM p2_opportunities WHERE scope = ?', KEY).length, 2);
});

test('P2-25: an idle day with zero output is a legitimate result, not a failure', async (t) => {
  const world = makeWorld(t);
  const model = scriptedModel([{ summary: '今天就想安安静静待着', slots: [{ kind: 'rest', title: '什么都不做', startAt: T0 + 30 * MIN, endAt: T0 + 150 * MIN, flexibility: 'soft' }] }]);
  const planner = makePlanner(world, { model });
  const outcome = await tick(planner, 'idle-gap');
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(outcome.status, 'committed');
  const slots = slotRows(world);
  assert.equal(slots.length, 1);
  assert.equal(slots[0].kind, 'rest');
  assert.equal(slots[0].activity, '', 'idling never pretends to be a tool activity');
  assert.equal(slots[0].reality, 'simulated_world');
  assert.equal(world.db.all('SELECT * FROM p2_activities WHERE scope = ?', KEY).length, 0, 'idling produces no fake activity');
});

test('P2-25: a plan with zero slots is accepted as the "nothing today" answer', async (t) => {
  const world = makeWorld(t);
  const model = scriptedModel([{ summary: '今天不安排', slots: [], interests: [] }]);
  const planner = makePlanner(world, { model });
  const outcome = await tick(planner, 'novelty');
  assert.equal(outcome.ok, true);
  assert.equal(outcome.status, 'empty');
  assert.equal(model.calls.length, 1);
  assert.equal((await tick(planner, 'novelty')).code, 'plan-exists', 'novelty never becomes a per-tick exploration loop');
  assert.equal(model.calls.length, 1);
});

test('P2-25: a novel candidate and a familiar project are presented side by side', async (t) => {
  const world = makeWorld(t);
  // A familiar project already on the books (touched yesterday), plus a novel lead.
  world.expectOk({
    kind: 'autonomy/interest', scope: SCOPE, occurredAt: T0 - DAY,
    payload: { action: 'upsert', at: T0 - DAY, interest: { interestId: 'int_familiar', kind: 'project', title: '熟悉的小项目', note: '一直在做', status: 'active', strength: 0.6, origin: 'plan', ref: 'plan:p0' } },
  });
  const materials = () => ({
    timeZone: TZ, persona: { version: 1, excerpt: 'bot' }, preferences: [],
    goals: [], commitments: [], fixedAgenda: [], runningActivities: [], lastReceipts: [],
    interests: [{ kind: 'interest', title: '潮汐为什么有周期', note: '刚看到一半' }],
    opportunities: [{ kind: 'novelty', source: 'article-2', weight: 1 }],
    capabilities: [{ name: 'explore', available: true }], budget: null,
  });
  const model = scriptedModel([{
    summary: '先看看潮汐，再回头做项目',
    slots: [
      { kind: 'activity', activity: 'explore', targetRef: 'https://example.org/reading', title: '查潮汐', startAt: T0 + 30 * MIN, endAt: T0 + 70 * MIN, flexibility: 'soft' },
      { kind: 'activity', activity: 'write', targetRef: 'drafts/notes', title: '做项目', startAt: T0 + 90 * MIN, endAt: T0 + 150 * MIN, flexibility: 'soft' },
    ],
  }]);
  const planner = makePlanner(world, { model, materials });
  const outcome = await tick(planner, 'manual');
  assert.equal(outcome.ok, true, JSON.stringify(outcome));

  const prompt = model.calls[0].input;
  assert.ok(prompt.includes('熟悉的小项目'), 'the familiar project is material');
  assert.ok(prompt.includes('潮汐为什么有周期'), 'the novel lead is material');
  assert.ok(prompt.includes('[novelty]'), 'the novelty trigger is visible');
  // The planner does not pick for the model: the committed slots are exactly the answer.
  const slots = slotRows(world);
  assert.deepEqual(slots.map(slot => slot.activity), ['explore', 'write']);
  assert.deepEqual(slots.map(slot => Number(slot.start_at)), [T0 + 30 * MIN, T0 + 90 * MIN]);
});

test('P2-25: an empty material object is tolerated and still bounded', async (t) => {
  const world = makeWorld(t);
  const model = scriptedModel([{ summary: '没有材料也能待着', slots: [] }]);
  const planner = makePlanner(world, { model, materials: () => ({}) });
  const outcome = await tick(planner, 'manual');
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.ok(model.calls[0].input.length <= PLAN_LIMITS.maxInputChars);
  assert.match(model.calls[0].input, /输出契约/);
});

// --------------------------------------------------------- honesty boundary

test('P2-25: a soft direction is an interest, never a skill claim, memory or activity', async (t) => {
  const world = makeWorld(t);
  const model = scriptedModel([{
    summary: '想弄明白潮汐',
    slots: [{ kind: 'activity', activity: 'explore', targetRef: 'https://example.org/reading', title: '查潮汐', startAt: T0 + 30 * MIN, endAt: T0 + 70 * MIN, flexibility: 'soft' }],
    interests: [{ kind: 'interest', title: '潮汐的周期', note: '先弄清楚月亮的影响' }],
  }]);
  const planner = makePlanner(world, { model });
  assert.equal((await tick(planner, 'manual')).ok, true);

  const events = listEvents(world.db, { scopeKey: KEY, limit: 100 });
  const interestEvents = events.filter(event => event.kind === 'autonomy/interest');
  assert.equal(interestEvents.length, 1);
  assert.deepEqual(Object.keys(interestEvents[0].payload.interest).sort(),
    ['interestId', 'kind', 'note', 'origin', 'ref', 'status', 'strength', 'title'],
    'an interest carries no skill/mastery/confidence claim');
  for (const forbidden of ['skill', 'mastery', 'confidence', 'fact', 'evidence']) {
    assert.equal(Object.hasOwn(interestEvents[0].payload.interest, forbidden), false);
  }
  // No memory write, no share candidate, no invented activity: the planner only plans.
  assert.equal(events.filter(event => String(event.kind).startsWith('memory/')).length, 0);
  assert.equal(world.db.all('SELECT * FROM p2_share_candidates WHERE scope = ?', KEY).length, 0);
  assert.equal(world.db.all('SELECT * FROM p2_activities WHERE scope = ?', KEY).length, 0);
  // And the interest is not "progress" of any kind.
  const row = world.db.get('SELECT status, strength, revision FROM p2_interests WHERE scope = ?', KEY);
  assert.equal(row.status, 'active');
  assert.equal(Number(row.revision), 1);
});

test('P2-25: only self-declared, origin-bound opportunities can enter the queue', async (t) => {
  const world = makeWorld(t);
  const unknown = world.expectRejected({
    kind: 'autonomy/opportunity', scope: SCOPE, occurredAt: T0,
    payload: { action: 'queue', at: T0, dedupeKey: 'k', opportunity: { kind: 'novelty' } },
  });
  assert.equal(unknown, 'invalid-opportunity', 'an untraceable lead is not evidence');
  const expired = world.expectRejected({
    kind: 'autonomy/opportunity', scope: SCOPE, occurredAt: T0,
    payload: { action: 'expire', at: T0 },
  });
  assert.equal(expired, 'invalid-opportunity');
  assert.equal(world.db.all('SELECT * FROM p2_opportunities WHERE scope = ?', KEY).length, 0);
});
