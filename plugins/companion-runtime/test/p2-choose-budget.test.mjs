import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openRuntimeDb } from '../lib/db.mjs';
import { dispatchEvent } from '../lib/events.mjs';
import { scopeKey as keyOfScope } from '../lib/scope.mjs';
import { applyPlanEvent, buildPlanningPrompt, createPlanner, PLAN_LIMITS } from '../lib/planner.mjs';

// P2-03 — what the planner is allowed to choose, and what it is allowed to spend.
//
// The prompt must carry the bounded material (persona, preferences, fixed arrangements,
// capabilities, budget) without exceeding 16 000 characters; the budget port is the hard
// gate (no reservation ⇒ no model call), and every attempt — including a failed or
// retried one — is settled. The model transport is scripted and records every call.

const TZ = 'Asia/Shanghai';
const MIN = 60000;
const DAY = 86400000;
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

function scriptedModel(script) {
  const calls = [];
  const fn = async (request) => {
    calls.push(request);
    const index = Math.min(calls.length - 1, script.length - 1);
    const answer = script[index];
    const value = typeof answer === 'function' ? await answer(request, calls.length) : answer;
    if (value && typeof value === 'object' && typeof value.text === 'string') return value;
    return { text: typeof value === 'string' ? value : JSON.stringify(value), provider: 'script', model: 'script-v1', inputTokens: 211, outputTokens: 77 };
  };
  fn.calls = calls;
  return fn;
}

function makeBudget({ reserveCode = null, settleCode = null, markIssuedCode = null } = {}) {
  const reserves = [];
  const issues = [];
  const settles = [];
  const releases = [];
  return {
    reserves, issues, settles, releases,
    reserve(entry) {
      reserves.push(entry);
      if (reserveCode) return { ok: false, code: reserveCode };
      return { ok: true, ref: entry.ref };
    },
    markIssued(entry) {
      issues.push(entry);
      if (markIssuedCode) return { ok: false, code: markIssuedCode };
      return { ok: true };
    },
    settle(entry) {
      settles.push(entry);
      if (settleCode) return { ok: false, code: settleCode };
      return { ok: true };
    },
    release(entry) { releases.push(entry); return { ok: true }; },
    status() { return { requests: { used: reserves.length, limit: 64 } }; },
  };
}

function makeMaterials(overrides = {}) {
  return () => ({
    timeZone: TZ,
    persona: { version: 4, excerpt: '三月七：喜欢亮晶晶的东西，爱拍照，也爱胡思乱想。' },
    preferences: ['喜欢在下午读点东西'],
    goals: [{ title: '读完《小王子》', deadlineAt: T0 + 3 * DAY }],
    commitments: [{ body: '答应帮用户找那篇关于潮汐的文章', dueAt: T0 + DAY }],
    fixedAgenda: [{ startAt: T0 + 19 * MIN, endAt: T0 + 79 * MIN, title: '用户约好的电话', authorization: 'plan', status: 'scheduled' }],
    runningActivities: [{ activity_id: 'act_1', kind: 'read', status: 'running', target: 'book.md', consumed_prefix: 2400 }],
    lastReceipts: [{ activity_id: 'act_0', operation: 'step', ok: 1, code: '', at: T0 - DAY }],
    interests: [], opportunities: [],
    capabilities: [
      { name: 'read', available: true }, { name: 'explore', available: true }, { name: 'write', available: true },
      { name: 'image', available: false, reason: 'port-not-mounted' },
    ],
    budget: { requests: { used: 3, limit: 64, remaining: 61 } },
    ...overrides,
  });
}

function makePlanner(world, { model, materials = makeMaterials(), budget = makeBudget(), planning = {} } = {}) {
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
    pause: { mode: 'active' },
  });
}

const tick = (planner, reason = 'manual') => planner.tick({ scopeKey: KEY, reason });
const planRows = world => world.db.all('SELECT * FROM p2_plans WHERE scope = ?', KEY);

const GOOD_PLAN = {
  summary: '下午先读一段',
  slots: [{ kind: 'activity', activity: 'read', targetRef: 'shelf/notes.md', title: '接着读', startAt: T0 + 100 * MIN, endAt: T0 + 160 * MIN, flexibility: 'soft' }],
};

// ------------------------------------------------------------------- choices

test('P2-03: the prompt carries the bounded material and stays inside 16 000 characters', async (t) => {
  const world = makeWorld(t);
  const model = scriptedModel([GOOD_PLAN]);
  const planner = makePlanner(world, { model });

  assert.equal((await tick(planner)).ok, true);
  const input = model.calls[0].input;
  assert.ok(input.length <= PLAN_LIMITS.maxInputChars, `input bounded: ${input.length}`);
  for (const fragment of ['三月七', '读完《小王子》', '答应帮用户找那篇关于潮汐的文章', '14:00–15:00', '用户约好的电话', 'read: 可用', 'image: 不可用', 'port-not-mounted', 'book.md', '61']) {
    assert.ok(input.includes(fragment), `prompt is missing: ${fragment}`);
  }
  assert.match(input, /只能安排窗口内这段时间/);
});

test('P2-03: a huge material degrades by dropping sections, never by exceeding the budget', async (t) => {
  const big = makeMaterials({
    preferences: Array.from({ length: 400 }, (_, index) => `偏好 ${index} `.repeat(20)),
    interests: Array.from({ length: 200 }, (_, index) => ({ kind: 'interest', title: `兴趣 ${index}`.repeat(10), note: 'x'.repeat(400) })),
    runningActivities: Array.from({ length: 50 }, () => ({ kind: 'read', target: 'long-name'.repeat(20), consumed_prefix: 10 })),
  });
  const world = makeWorld(t);
  const model = scriptedModel([GOOD_PLAN]);
  const planner = makePlanner(world, { model, materials: big });
  assert.equal((await tick(planner)).ok, true);
  const input = model.calls[0].input;
  assert.ok(input.length <= PLAN_LIMITS.maxInputChars, `bounded: ${input.length}`);
  assert.ok(input.trimEnd().endsWith('不要输出 scope、状态、完成度、调用 ID 或任何执行命令；不要声称已经执行。'), 'the output contract survives truncation pressure');
});

test('P2-03: buildPlanningPrompt is pure and deterministic for the same material', () => {
  const material = {
    timeZone: TZ,
    persona: { version: 1, excerpt: '三月七' },
    preferences: ['a'], fixedAgenda: [{ startAt: T0 + 60 * MIN, endAt: T0 + 90 * MIN, title: '约定' }],
    goals: [], commitments: [], runningActivities: [], lastReceipts: [], interests: [], opportunities: [], capabilities: [],
  };
  const args = { material, day: '2026-11-02', timeZone: TZ, now: T0, windowStart: T0, windowEnd: T0 + 8 * 3600000, carried: [] };
  const first = buildPlanningPrompt(args);
  const second = buildPlanningPrompt(args);
  assert.equal(first.input, second.input);
  assert.equal(first.digest, second.digest);
  // A material change that matters changes the digest; a volatile field does not.
  const changed = buildPlanningPrompt({ ...args, material: { ...material, goals: [{ title: '新目标' }] } });
  assert.notEqual(changed.digest, first.digest);
  const volatile = buildPlanningPrompt({ ...args, material: { ...material, now: T0 + 999, budget: { requests: { used: 9 } } } });
  assert.equal(volatile.digest, first.digest, 'now/budget are not planning material');
});

// -------------------------------------------------------------------- budget

test('P2-03: an exhausted budget refuses the round without calling the model', async (t) => {
  const world = makeWorld(t);
  const model = scriptedModel([GOOD_PLAN]);
  const budget = makeBudget({ reserveCode: 'budget-exhausted' });
  const planner = makePlanner(world, { model, budget });

  const outcome = await tick(planner);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'budget-exhausted');
  assert.equal(model.calls.length, 0, 'no model request is made without a reservation');
  assert.equal(budget.reserves.length, 1, 'exactly one reservation attempt');
  assert.equal(budget.reserves[0].purpose, 'p2-planning');
  assert.deepEqual(budget.issues, [], 'nothing was issued');
  assert.equal(planRows(world).length, 0);
  const run = world.db.get('SELECT status, error_code FROM p2_plan_runs WHERE scope = ?', KEY);
  assert.equal(run.status, 'skipped');
  assert.equal(run.error_code, 'budget-exhausted');
});

test('P2-03: chat priority is passed straight through', async (t) => {
  const world = makeWorld(t);
  const model = scriptedModel([GOOD_PLAN]);
  const planner = makePlanner(world, { model, budget: makeBudget({ reserveCode: 'chat-priority' }) });
  const outcome = await tick(planner);
  assert.equal(outcome.code, 'chat-priority');
  assert.equal(model.calls.length, 0);
});

test('P2-03: markIssued happens before the request and settle reports the real tokens', async (t) => {
  const world = makeWorld(t);
  const observed = [];
  const budget = makeBudget();
  const model = scriptedModel([request => {
    observed.push({ issuedAtCall: budget.issues.length, settlesAtCall: budget.settles.length, signal: Boolean(request.signal) });
    return GOOD_PLAN;
  }]);
  const planner = makePlanner(world, { model, budget });

  assert.equal((await tick(planner)).ok, true);
  assert.equal(observed[0].issuedAtCall, 1, 'the reservation is marked issued before the model sees it');
  assert.equal(observed[0].settlesAtCall, 0, 'settling happens after the answer');
  assert.equal(observed[0].signal, true, 'the port receives an abort signal for the timeout');
  assert.equal(budget.settles.length, 1);
  assert.equal(budget.settles[0].inputTokens, 211);
  assert.equal(budget.settles[0].outputTokens, 77);
  assert.equal(budget.settles[0].ok, undefined, 'a successful call does not settle as failed');
});

test('P2-03: a reservation that cannot be marked issued is released, not spent', async (t) => {
  const world = makeWorld(t);
  const model = scriptedModel([GOOD_PLAN]);
  const budget = makeBudget({ markIssuedCode: 'already-issued' });
  const planner = makePlanner(world, { model, budget });
  const outcome = await tick(planner);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'already-issued');
  assert.equal(model.calls.length, 0);
  assert.equal(budget.releases.length, 1, 'a never-issued reservation is released');
});

test('P2-03: an overspent settlement still commits the plan and is reported', async (t) => {
  const world = makeWorld(t);
  const model = scriptedModel([GOOD_PLAN]);
  const planner = makePlanner(world, { model, budget: makeBudget({ settleCode: 'budget-exhausted' }) });
  const outcome = await tick(planner);
  assert.equal(outcome.ok, true, 'the model already answered; throwing the plan away would waste the spend');
  assert.equal(outcome.overspent, true);
  const run = world.db.get('SELECT status, error_code FROM p2_plan_runs WHERE scope = ?', KEY);
  assert.equal(run.status, 'committed');
  assert.equal(run.error_code, 'budget-overspent');
});

// ---------------------------------------------------------------- model faults

test('P2-03: unparseable output is rejected without a partial plan, and the retry is counted', async (t) => {
  const world = makeWorld(t);
  const model = scriptedModel(['{"summary":"被截断的计划","slots":[{"kind":"acti', 'not json either']);
  const budget = makeBudget();
  const planner = makePlanner(world, { model, budget });

  const outcome = await tick(planner);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'invalid-plan');
  assert.equal(outcome.attempts, PLAN_LIMITS.maxAttempts);
  assert.equal(model.calls.length, PLAN_LIMITS.maxAttempts);
  assert.equal(budget.reserves.length, PLAN_LIMITS.maxAttempts, 'retries reserve again');
  assert.equal(budget.settles.length, PLAN_LIMITS.maxAttempts, 'retries settle too');
  assert.equal(planRows(world).length, 0);
});

test('P2-03: a transport failure is retried once and recorded as failed', async (t) => {
  const world = makeWorld(t);
  let attempts = 0;
  const model = async () => {
    attempts += 1;
    throw new Error('socket hang up');
  };
  const planner = makePlanner(world, { model });
  const outcome = await tick(planner);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'model-error');
  assert.equal(attempts, PLAN_LIMITS.maxAttempts);
  assert.equal(planRows(world).length, 0);
  const run = world.db.get('SELECT status, error_code, attempts FROM p2_plan_runs WHERE scope = ?', KEY);
  assert.equal(run.status, 'failed');
  assert.equal(run.error_code, 'model-error');
  assert.equal(Number(run.attempts), PLAN_LIMITS.maxAttempts);
});

test('P2-03: an empty model answer is unusable output (invalid-plan), not an empty plan', async (t) => {
  const world = makeWorld(t);
  const model = scriptedModel([{ text: '   ', provider: 'script' }]);
  const planner = makePlanner(world, { model });
  const outcome = await tick(planner);
  // Review pass 2, N-9: the frozen code for unusable output is `invalid-plan`.
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'invalid-plan');
  assert.equal(outcome.attempts, PLAN_LIMITS.maxAttempts);
  assert.equal(planRows(world).length, 0, 'an empty answer never becomes a committed empty plan');
  const run = world.db.get('SELECT status, error_code FROM p2_plan_runs WHERE scope = ?', KEY);
  assert.equal(run.status, 'rejected', 'unusable output records a rejected round, not a transport failure');
  assert.equal(run.error_code, 'invalid-plan');
});

test('P2-03: the planner keeps its retry/timeout timers referenced while a round is pending', async () => {
  // Review pass 2, N-8: an `unref()`ed timer lets a bare Node process exit mid-round and drop
  // the bounded retry (the reviewer's own probe exited 1). This guards the source, because the
  // failure mode is invisible to a test runner that is kept alive by its own handles.
  const source = fs.readFileSync(new URL('../lib/planner.mjs', import.meta.url), 'utf8');
  assert.equal(/\.unref\s*\(/.test(source), false, 'planner.mjs must not unref a pending-round timer');
});

test('P2-03: a retried transport failure still runs after the backoff delay', async (t) => {
  const world = makeWorld(t);
  let attempt = 0;
  const model = async () => {
    attempt += 1;
    if (attempt === 1) throw new Error('transient reset');
    return { text: JSON.stringify({ summary: '重试成功', slots: [{ kind: 'open', title: '留白', startAt: T0 + 140 * MIN, endAt: T0 + 170 * MIN, flexibility: 'soft' }] }), provider: 'script', model: 'script-v1', inputTokens: 10, outputTokens: 5 };
  };
  const planner = makePlanner(world, { model, planning: { retryBackoffMs: 5 } });
  const outcome = await tick(planner);
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(attempt, 2, 'the backoff retry actually happened');
  assert.equal(planRows(world).length, 1);
});

test('P2-03: a truncated or oversized answer is invalid-plan even when the JSON happens to parse', async (t) => {
  const world = makeWorld(t);
  let call = 0;
  const model = async () => {
    call += 1;
    if (call === 1) {
      // Parses perfectly, but the provider says it was cut at the token limit.
      return { text: JSON.stringify(GOOD_PLAN), provider: 'script', model: 'script-v1', finishReason: 'length', inputTokens: 10, outputTokens: 4096 };
    }
    return { text: JSON.stringify(GOOD_PLAN), provider: 'script', model: 'script-v1', outputTokens: PLAN_LIMITS.maxOutputTokens + 1 };
  };
  const planner = makePlanner(world, { model });
  const outcome = await tick(planner);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'invalid-plan');
  assert.equal(outcome.attempts, PLAN_LIMITS.maxAttempts);
  assert.equal(planRows(world).length, 0, 'a truncated answer is never salvaged into a plan');
});

test('P2-03: a call that exceeds the timeout aborts and settles', async (t) => {
  const world = makeWorld(t);
  const settles = [];
  const budget = {
    reserve: entry => ({ ok: true, ref: entry.ref }),
    markIssued: () => ({ ok: true }),
    settle: entry => { settles.push(entry); return { ok: true }; },
    release: () => ({ ok: true }),
    status: () => ({}),
  };
  const model = request => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ text: 'too late' }), 5000);
    timer.unref?.();
    request.signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    });
  });
  const planner = makePlanner(world, { model, budget, planning: { timeoutMs: 20, retryBackoffMs: 0 } });
  const outcome = await tick(planner);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'model-timeout');
  assert.equal(settles.length, PLAN_LIMITS.maxAttempts, 'a timeout is a counted attempt');
  assert.equal(settles[0].ok, false);
  assert.equal(settles[0].code, 'model-timeout');
  assert.equal(planRows(world).length, 0);
});
