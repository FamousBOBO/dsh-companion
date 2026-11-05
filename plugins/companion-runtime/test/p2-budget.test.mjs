import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openRuntimeDb } from '../lib/db.mjs';
import { dispatchEvent } from '../lib/events.mjs';
import { scopeKey as keyOfScope } from '../lib/scope.mjs';
import { createBudget } from '../lib/budget.mjs';
import { applyPlanEvent, createPlanner } from '../lib/planner.mjs';

// P2-19 — the shared budget accounting behind the planner, against the real
// `lib/budget.mjs` (amendment BLOCK-3), plus planner integration and restart behaviour.
//
// Falsifiable assertions required by the amendment:
//   * 64 unsettled `reserve` calls ⇒ the 65th is `budget-exhausted`;
//   * `markIssued` then `release` ⇒ `already-issued` (the quota stays spent);
//   * `kind:'recovery'` still succeeds at the 61st reservation;
//   * an issued-but-unsettled reservation occupies quota until the sweep closes it.

const TZ = 'Asia/Shanghai';
const MIN = 60000;
const DAY = 86400000;
const SCOPE = Object.freeze({ userId: 'owner-1', personaId: 'bot', worldId: 'world:default' });
const KEY = keyOfScope(SCOPE);
const T0 = Date.UTC(2026, 10, 2, 5, 41, 0);

function makeWorld(t, { file = ':memory:' } = {}) {
  const clock = { value: T0 };
  const db = openRuntimeDb({ file, now: () => clock.value });
  t.after(() => { try { db.close(); } catch { /* already closed */ } });
  const owner = 'owner-test';
  const generation = 'gen-test';
  assert.equal(db.acquireLease({ owner, generation, ttlMs: 7 * DAY }).ok, true);
  db.commitProjection({ scope: KEY, generation, payload: { } });
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

function budgetConfig(overrides = {}) {
  return {
    p2: {
      budget: {
        maxRequestsPerDay: 64, maxInputTokensPerDay: 160000, maxOutputTokensPerDay: 24000,
        recoveryReserveRatio: 0.2, maxConcurrent: 2, chatPriority: true, maxCostPerDay: 0, ...overrides,
      },
    },
  };
}

function makeBudget(world, { overrides = {}, shouldYield = () => false } = {}) {
  return createBudget({
    db: world.db, config: budgetConfig(overrides), clock: () => world.clock.value,
    timeZone: TZ, owner: world.owner, generation: world.generation, shouldYield,
  });
}

function scriptedModel(script) {
  const calls = [];
  const fn = async (request) => {
    calls.push(request);
    const index = Math.min(calls.length - 1, script.length - 1);
    const answer = script[index];
    const value = typeof answer === 'function' ? await answer(request, calls.length) : answer;
    if (value && typeof value === 'object' && typeof value.text === 'string') return value;
    return { text: typeof value === 'string' ? value : JSON.stringify(value), provider: 'script', model: 'script-v1', inputTokens: 300, outputTokens: 120 };
  };
  fn.calls = calls;
  return fn;
}

function makePlanner(world, { model, budget, materials = () => ({ timeZone: TZ, persona: { version: 1, excerpt: 'bot' }, preferences: [], goals: [], commitments: [], fixedAgenda: [], runningActivities: [], lastReceipts: [], interests: [], opportunities: [], capabilities: [], budget: null }) } = {}) {
  return createPlanner({
    db: world.db,
    config: { enabled: true, mode: 'active', timeZone: TZ, p2: { planning: { enabled: true, retryBackoffMs: 0 } } },
    clock: () => world.clock.value,
    owner: world.owner,
    generation: world.generation,
    dispatch: world.dispatch,
    callModel: model,
    budget,
    materials,
    pause: { mode: 'active' },
  });
}

const tick = (planner, reason = 'manual') => planner.tick({ scopeKey: KEY, reason });

const PLAN = {
  summary: '下午读一点',
  slots: [{ kind: 'activity', activity: 'read', targetRef: 'shelf/notes.md', title: '读', startAt: T0 + 40 * MIN, endAt: T0 + 90 * MIN, flexibility: 'soft' }],
};

const ledgerRows = world => world.db.all('SELECT * FROM p2_budget_ledger WHERE scope = ? ORDER BY at, entry_id', KEY);

// ------------------------------------------------------- BLOCK-3 assertions

test('P2-19: 64 unsettled reservations exhaust the day and the 65th is refused', async (t) => {
  const world = makeWorld(t);
  const budget = makeBudget(world, { overrides: { recoveryReserveRatio: 0 } });
  for (let index = 0; index < 64; index += 1) {
    const outcome = budget.reserve({ scope: KEY, purpose: 'p2-planning', ref: `r_${index}` });
    assert.equal(outcome.ok, true, `reservation ${index + 1} must succeed: ${JSON.stringify(outcome)}`);
    assert.equal(outcome.day, '2026-11-02');
  }
  const overflow = budget.reserve({ scope: KEY, purpose: 'p2-planning', ref: 'r_64' });
  assert.equal(overflow.ok, false);
  assert.equal(overflow.code, 'budget-exhausted');
  const used = budget.status({ scope: KEY });
  assert.equal(used.requests.used, 64);
  assert.equal(used.requests.remaining, 0);
});

test('P2-19: an issued reservation can never be released (already-issued)', async (t) => {
  const world = makeWorld(t);
  const budget = makeBudget(world);
  const reserved = budget.reserve({ scope: KEY, purpose: 'p2-planning', ref: 'r_issue', estimatedInputTokens: 100 });
  assert.equal(reserved.ok, true);
  assert.equal(budget.release({ scope: KEY, ref: 'r_issue' }).ok, true, 'a never-issued reservation is releasable');
  const again = budget.reserve({ scope: KEY, purpose: 'p2-planning', ref: 'r_issue2', estimatedInputTokens: 100 });
  assert.equal(again.ok, true);
  assert.equal(budget.markIssued({ scope: KEY, ref: 'r_issue2' }).ok, true);
  const refused = budget.release({ scope: KEY, ref: 'r_issue2' });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'already-issued');
  assert.equal(budget.status({ scope: KEY }).requests.used, 1, 'the issued request stays counted');
});

test('P2-19: the recovery reserve gates normal work but still allows recovery, and is honoured at the 61st call', async (t) => {
  const world = makeWorld(t);
  const budget = makeBudget(world); // recoveryReserveRatio 0.2 of 64 ⇒ 13 held back
  let normal = 0;
  for (let index = 0; index < 64; index += 1) {
    const outcome = budget.reserve({ scope: KEY, purpose: 'p2-planning', ref: `n_${index}` });
    if (outcome.ok) normal += 1;
    else { assert.equal(outcome.code, 'budget-exhausted'); break; }
  }
  assert.equal(normal, 51, 'normal work stops when only the recovery reserve is left');
  const held = budget.status({ scope: KEY });
  assert.equal(held.recoveryReserve.requests, 13);
  assert.equal(held.recoveryReserve.usableForNormalWork, 0);
  // Nine more recovery requests fill the pool to 60; the 61st still succeeds.
  let recovery = 0;
  for (let index = 0; index < 9; index += 1) {
    const outcome = budget.reserve({ scope: KEY, purpose: 'p2-recovery', kind: 'recovery', ref: `rec_${index}` });
    assert.equal(outcome.ok, true, `recovery ${index + 1}: ${JSON.stringify(outcome)}`);
    recovery += 1;
  }
  const sixtyFirst = budget.reserve({ scope: KEY, purpose: 'p2-recovery', kind: 'recovery', ref: 'rec_60' });
  assert.equal(recovery + normal, 60);
  assert.equal(sixtyFirst.ok, true, 'the 61st reservation is still within the pool');
  // Recovery may spend the rest of the pool, and no more: 64 total, then a hard stop.
  let filled = recovery + normal + 1;
  for (let index = 0; index < 8; index += 1) {
    const outcome = budget.reserve({ scope: KEY, purpose: 'p2-recovery', kind: 'recovery', ref: `rec2_${index}` });
    if (outcome.ok) filled += 1;
    else { assert.equal(outcome.code, 'budget-exhausted'); break; }
  }
  assert.equal(filled, 64, 'the pool fills to its frozen limit');
  const overdraw = budget.reserve({ scope: KEY, purpose: 'p2-recovery', kind: 'recovery', ref: 'rec_over' });
  assert.equal(overdraw.ok, false, 'the 65th reservation overdraws the pool');
  assert.equal(budget.status({ scope: KEY }).requests.remaining, 0);
});

test('P2-19: an issued-but-unsettled reservation occupies quota until the sweep closes it', async (t) => {
  const world = makeWorld(t);
  const budget = makeBudget(world, { overrides: { recoveryReserveRatio: 0 } });
  const reserved = budget.reserve({ scope: KEY, purpose: 'p2-planning', ref: 'r_pending', estimatedInputTokens: 500, estimatedOutputTokens: 200 });
  assert.equal(reserved.ok, true);
  budget.markIssued({ scope: KEY, ref: 'r_pending' });
  assert.equal(budget.status({ scope: KEY }).requests.used, 1, 'an in-flight request already occupies quota');
  // Still occupying after ten minutes of downtime...
  world.clock.value = T0 + 11 * MIN;
  const swept = budget.sweep({ scope: KEY });
  assert.equal(swept.ok, true);
  assert.equal(swept.closed, 3, 'request + estimated tokens are closed as unsettled');
  const row = world.db.get("SELECT purpose FROM p2_budget_ledger WHERE entry_id = 'r_pending'");
  assert.match(row.purpose, /:unsettled$/);
});

// ------------------------------------------------------ planner integration

test('P2-19: the planner reserves before the call and settles the real tokens', async (t) => {
  const world = makeWorld(t);
  const budget = makeBudget(world);
  const model = scriptedModel([PLAN]);
  const planner = makePlanner(world, { model, budget });

  const outcome = await tick(planner);
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  const rows = ledgerRows(world);
  const requests = rows.filter(row => row.kind === 'requests');
  assert.equal(requests.length, 1);
  assert.equal(Number(requests[0].settled), 1);
  assert.equal(Number(requests[0].issued), 1);
  assert.equal(requests[0].purpose, 'p2-planning');
  const input = rows.find(row => row.kind === 'input_tokens');
  const output = rows.find(row => row.kind === 'output_tokens');
  assert.equal(Number(input.amount), 300, 'the real input tokens are settled, not the estimate');
  assert.equal(Number(output.amount), 120);
  assert.ok(model.calls.length === 1);
});

test('P2-19: an exhausted budget stops the planner before any model call', async (t) => {
  const world = makeWorld(t);
  const budget = makeBudget(world); // 13/64 reserved for recovery
  for (let index = 0; index < 51; index += 1) {
    assert.equal(budget.reserve({ scope: KEY, purpose: 'p2-planning', ref: `fill_${index}` }).ok, true);
  }
  const model = scriptedModel([PLAN]);
  const planner = makePlanner(world, { model, budget });
  const outcome = await tick(planner);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'budget-exhausted');
  assert.equal(model.calls.length, 0, 'the model is never called without quota');
  assert.equal(world.db.all('SELECT * FROM p2_plans WHERE scope = ?', KEY).length, 0);
});

test('P2-19: a failed attempt is counted and settled as failed', async (t) => {
  const world = makeWorld(t);
  const budget = makeBudget(world);
  const model = async () => { throw new Error('provider down'); };
  const planner = makePlanner(world, { model, budget });
  const outcome = await tick(planner);
  assert.equal(outcome.code, 'model-error');
  const rows = ledgerRows(world);
  const requests = rows.filter(row => row.kind === 'requests');
  assert.equal(requests.length, 2, 'both attempts are counted');
  for (const row of requests) {
    assert.equal(Number(row.settled), 1);
    assert.match(row.purpose, /:model-error$/);
  }
});

test('P2-19: a restart keeps the plan and the spend, and never re-plans the same day', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-budget-'));
  const file = path.join(dir, 'runtime.db');
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });

  const first = makeWorld(t, { file });
  const budgetOne = makeBudget(first);
  const modelOne = scriptedModel([PLAN]);
  const plannerOne = makePlanner(first, { model: modelOne, budget: budgetOne });
  assert.equal((await tick(plannerOne)).ok, true);
  const spentBefore = budgetOne.status({ scope: KEY }).requests.used;
  assert.equal(spentBefore, 1);
  first.db.close();

  // Reopen the same file: a new writer generation, the same day and the same ledger.
  const clock = first.clock;
  const db = openRuntimeDb({ file, now: () => clock.value });
  t.after(() => { try { db.close(); } catch { /* already closed */ } });
  const owner = 'owner-test';
  const generation = 'gen-test-2';
  assert.equal(db.acquireLease({ owner, generation, ttlMs: 7 * DAY }).ok, true);
  const reopened = { clock, db, owner, generation, dispatch: input => {
    const outcome = dispatchEvent(db, input, { handlers: { autonomy: applyPlanEvent }, generation, requireConsumers: true });
    if (outcome.rejected) {
      const failure = (outcome.results ?? []).find(result => result.error);
      throw Object.assign(new Error(failure?.error ?? 'rejected'), { code: failure?.code ?? 'rejected' });
    }
    return outcome;
  } };
  const budgetTwo = createBudget({
    db, config: budgetConfig(), clock: () => clock.value, timeZone: TZ, owner, generation, shouldYield: () => false,
  });
  assert.equal(budgetTwo.status({ scope: KEY }).requests.used, 1, 'the restart does not mint a new day or a new quota');
  const modelTwo = scriptedModel([PLAN]);
  const plannerTwo = makePlanner(reopened, { model: modelTwo, budget: budgetTwo });
  const second = await tick(plannerTwo);
  assert.equal(second.ok, false);
  assert.equal(second.code, 'plan-exists', 'the restart does not duplicate the committed plan');
  assert.equal(modelTwo.calls.length, 0);
  assert.equal(budgetTwo.status({ scope: KEY }).requests.used, 1, 'no budget was spent again');
});
