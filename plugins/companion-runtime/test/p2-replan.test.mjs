import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openRuntimeDb } from '../lib/db.mjs';
import { dispatchEvent, listEvents } from '../lib/events.mjs';
import { scopeKey as keyOfScope } from '../lib/scope.mjs';
import { applyPlanEvent, createPlanner } from '../lib/planner.mjs';

// P2-06 — changing your mind without rewriting history.
//
// A replan is a new version, not an edit: the old plan row flips to `superseded`, already
// executed slots keep their status, and a late model answer is refused when the day moved
// under it (`superseded-before-commit` / `materials-changed`) instead of overwriting a
// newer decision (amendment BLOCK-2, wiki P2-05).

const TZ = 'Asia/Shanghai';
const MIN = 60000;
const HOUR = 3600000;
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
    return { text: typeof value === 'string' ? value : JSON.stringify(value), provider: 'script', model: 'script-v1', inputTokens: 101, outputTokens: 44 };
  };
  fn.calls = calls;
  return fn;
}

function makeMaterials(changer = () => ({})) {
  let call = 0;
  return () => {
    call += 1;
    return {
      timeZone: TZ,
      persona: { version: 2, excerpt: '三月七' },
      preferences: [], goals: [], commitments: [], fixedAgenda: [], runningActivities: [], lastReceipts: [],
      interests: [], opportunities: [], capabilities: [], budget: null,
      ...changer(call),
    };
  };
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

function planEvent({ planId, version, windowStart = T0, windowEnd = T0 + 8 * HOUR, slots = [], day = '2026-11-02', supersedes = '' }) {
  return {
    kind: 'autonomy/plan-committed',
    scope: SCOPE,
    occurredAt: T0,
    payload: {
      at: T0, day, timeZone: TZ, sourceRunId: 'run_test', supersedes, snapshotDigest: 'd_test',
      plan: { planId, day, version, windowStart, windowEnd, summary: '测试', timeZone: TZ, slots },
    },
  };
}

// -------------------------------------------------------------- version chain

test('P2-06: a replan supersedes the old version and keeps executed slot history', async (t) => {
  const world = makeWorld(t);
  const before = { startAt: T0 + 20 * MIN, endAt: T0 + 60 * MIN };
  const after = { startAt: T0 + 120 * MIN, endAt: T0 + 170 * MIN };
  const model = scriptedModel([
    { summary: '先读一段', slots: [{ kind: 'activity', activity: 'read', targetRef: 'shelf/notes.md', title: '读', ...before, flexibility: 'soft' }] },
    { summary: '改成写', slots: [{ kind: 'activity', activity: 'write', targetRef: 'drafts/notes', title: '写', ...after, flexibility: 'soft' }] },
  ]);
  const planner = makePlanner(world, { model });

  assert.equal((await tick(planner, 'manual')).ok, true);
  const [firstSlot] = slotRows(world);
  // The activity really started and finished inside that slot (episode 2 owns execution;
  // here the two transitions stand in for the activities module's receipts).
  world.expectOk({ kind: 'autonomy/plan-slot', scope: SCOPE, occurredAt: before.startAt, payload: { at: before.startAt, slotId: firstSlot.slot_id, planId: firstSlot.plan_id, day: '2026-11-02', from: 'planned', to: 'started' } });
  world.expectOk({ kind: 'autonomy/plan-slot', scope: SCOPE, occurredAt: before.endAt, payload: { at: before.endAt, slotId: firstSlot.slot_id, planId: firstSlot.plan_id, day: '2026-11-02', from: 'started', to: 'done' } });

  world.clock.value = T0 + 90 * MIN;
  const replan = await tick(planner, 'checkpoint:' + firstSlot.slot_id);
  assert.equal(replan.ok, true, JSON.stringify(replan));
  assert.equal(replan.version, 2);

  const plans = planRows(world);
  assert.deepEqual(plans.map(row => row.status), ['superseded', 'committed']);
  assert.equal(plans[1].supersedes, plans[0].plan_id);

  const slots = slotRows(world);
  assert.equal(slots.length, 2);
  const old = slots.find(slot => slot.plan_id === plans[0].plan_id);
  assert.equal(old.status, 'done', 'history is never rewritten by a replan');
  assert.equal(Number(old.start_at), before.startAt);
  const fresh = slots.find(slot => slot.plan_id === plans[1].plan_id);
  assert.equal(fresh.status, 'planned');
  assert.ok(Number(fresh.start_at) >= T0 + 90 * MIN, 'the new version only plans the future');
});

test('P2-06: a late answer is refused when a newer plan appeared during the model call', async (t) => {
  const world = makeWorld(t);
  let injected = false;
  const model = scriptedModel([
    { summary: '第一版', slots: [{ kind: 'open', title: '发呆', startAt: T0 + 40 * MIN, endAt: T0 + 80 * MIN, flexibility: 'soft' }] },
    // While the second (replan) answer is being produced, another writer commits v2.
    () => {
      if (!injected) {
        injected = true;
        world.expectOk(planEvent({
          planId: 'plan_other', version: 2, supersedes: planRows(world)[0].plan_id,
          slots: [{ kind: 'open', title: '别的安排', startAt: T0 + 100 * MIN, endAt: T0 + 130 * MIN }],
        }));
      }
      return { summary: '迟到的第三版', slots: [{ kind: 'open', title: '迟到', startAt: T0 + 200 * MIN, endAt: T0 + 220 * MIN, flexibility: 'soft' }] };
    },
  ]);
  const planner = makePlanner(world, { model });

  assert.equal((await tick(planner, 'manual')).ok, true);
  world.clock.value = T0 + 40 * MIN;
  const late = await tick(planner, 'checkpoint');
  assert.equal(late.ok, false);
  assert.equal(late.code, 'superseded-before-commit');
  const plans = planRows(world);
  assert.equal(plans.length, 2, 'no third version was written');
  assert.equal(plans[1].plan_id, 'plan_other');
  assert.equal(plans[1].status, 'committed');
  const run = world.db.get('SELECT status, error_code FROM p2_plan_runs WHERE scope = ? ORDER BY started_at DESC LIMIT 1', KEY);
  assert.equal(run.status, 'superseded-before-commit');
});

test('P2-06: a changed material between prompt and commit is refused', async (t) => {
  const world = makeWorld(t);
  // Second materials read (the pre-commit digest re-check) sees a new goal.
  const materials = makeMaterials(call => (call >= 2 ? { goals: [{ title: '用户临时加的目标' }] } : {}));
  const model = scriptedModel([{ summary: '按旧材料安排', slots: [{ kind: 'open', title: '留白', startAt: T0 + 40 * MIN, endAt: T0 + 70 * MIN, flexibility: 'soft' }] }]);
  const planner = makePlanner(world, { model, materials });

  const outcome = await tick(planner, 'manual');
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'materials-changed');
  assert.equal(planRows(world).length, 0, 'nothing is committed against stale material');
  const run = world.db.get('SELECT status, error_code FROM p2_plan_runs WHERE scope = ?', KEY);
  assert.equal(run.status, 'rejected');
  assert.equal(run.error_code, 'materials-changed');
});

test('P2-06: a later tick re-plans with fresh material after materials-changed', async (t) => {
  const world = makeWorld(t);
  let call = 0;
  const materials = () => {
    call += 1;
    return {
      timeZone: TZ, persona: { version: 2, excerpt: '三月七' }, preferences: [],
      goals: call === 1 ? [] : [{ title: '用户临时加的目标' }],
      commitments: [], fixedAgenda: [], runningActivities: [], lastReceipts: [],
      interests: [], opportunities: [], capabilities: [], budget: null,
    };
  };
  const model = scriptedModel([
    { summary: '旧材料计划', slots: [{ kind: 'open', title: '留白', startAt: T0 + 40 * MIN, endAt: T0 + 70 * MIN, flexibility: 'soft' }] },
    { summary: '新材料计划', slots: [{ kind: 'open', title: '留白', startAt: T0 + 40 * MIN, endAt: T0 + 70 * MIN, flexibility: 'soft' }] },
  ]);
  const planner = makePlanner(world, { model, materials });
  assert.equal((await tick(planner, 'manual')).code, 'materials-changed');
  // The refusal itself is not a model failure, but BLOCK-8's 30-minute gap still applies to
  // a non-explicit tick: a fresh plan is attempted at the next eligible round.
  assert.equal((await tick(planner, 'manual')).code, 'rate-limited');
  assert.equal(model.calls.length, 1);
  world.clock.value = T0 + 31 * MIN;
  const retried = await tick(planner, 'manual');
  assert.equal(retried.ok, true, JSON.stringify(retried));
  assert.equal(planRows(world).length, 1);
});

test('P2-06: the reducer refuses an out-of-order version', async (t) => {
  const world = makeWorld(t);
  world.expectOk(planEvent({ planId: 'plan_v1', version: 1, slots: [{ kind: 'open', title: 'A', startAt: T0 + 40 * MIN, endAt: T0 + 70 * MIN }] }));
  const code = world.expectRejected(planEvent({ planId: 'plan_dup', version: 1, slots: [{ kind: 'open', title: 'B', startAt: T0 + 80 * MIN, endAt: T0 + 90 * MIN }] }));
  assert.equal(code, 'invalid-version');
  const plans = planRows(world);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].plan_id, 'plan_v1');
  assert.equal(listEvents(world.db, { scopeKey: KEY, kind: 'autonomy/plan-committed', limit: 10 }).length, 1);
});

test('P2-06: a non-explicit reason never replaces an existing plan', async (t) => {
  const world = makeWorld(t);
  const model = scriptedModel([{ summary: '下午', slots: [{ kind: 'open', title: '留白', startAt: T0 + 40 * MIN, endAt: T0 + 70 * MIN, flexibility: 'soft' }] }]);
  const planner = makePlanner(world, { model });
  assert.equal((await tick(planner, 'manual')).ok, true);
  const inspiration = await tick(planner, 'inspiration');
  assert.equal(inspiration.code, 'plan-exists');
  assert.equal(model.calls.length, 1);
  assert.equal(planRows(world).length, 1);
});

// Regression for the demo's second round (reported by the Lead, 2026-10-30): after a
// restart at +45 min, a `checkpoint` replan whose answer is a legitimate 2-slot
// `activity` + `open` plan — anchored at the round's *current* now — must commit. The same
// answer anchored 45 minutes in the past is refused, because a plan may never reach back
// into the day (contract §5.1 / amendment BLOCK-2: slots inside `[now, localDayEnd]`).
const eveningPlan = now => ({
  summary: '材料看过了，晚上想把白天那一小段接着写完。',
  slots: [
    { kind: 'activity', activity: 'write', title: '把白天的观察写完', detail: '接着项目写第二段', startAt: now, endAt: now + 40 * MIN, flexibility: 'soft', targetRef: 'drafts/city-observation.md' },
    { kind: 'open', title: '留白', detail: '看看还有没有别的想写的', startAt: now + 40 * MIN, endAt: now + 70 * MIN, flexibility: 'soft' },
  ],
});
const dayOpener = () => ({
  summary: '先看看材料，再读一段，再写一小段。',
  slots: [
    { kind: 'activity', activity: 'explore', title: '找材料', startAt: T0, endAt: T0 + 20 * MIN, flexibility: 'soft', targetRef: 'https://127.0.0.1/article' },
    { kind: 'activity', activity: 'read', title: '读两段', startAt: T0 + 20 * MIN, endAt: T0 + 50 * MIN, flexibility: 'soft', targetRef: 'shelf/article.md' },
    { kind: 'activity', activity: 'write', title: '写一小段', startAt: T0 + 50 * MIN, endAt: T0 + 80 * MIN, flexibility: 'soft', targetRef: 'drafts/city-observation.md' },
    { kind: 'open', title: '留白', startAt: T0 + 80 * MIN, endAt: T0 + 110 * MIN, flexibility: 'soft' },
  ],
});

test('P2-06: a checkpoint replan with activity+open starting exactly at now commits', async (t) => {
  const world = makeWorld(t);
  const anchor = { value: null };
  const model = scriptedModel([
    dayOpener(),
    () => eveningPlan(anchor.value ?? world.clock.value),
  ]);
  const planner = makePlanner(world, { model });
  assert.equal((await tick(planner, 'manual')).ok, true);
  assert.equal(planRows(world).length, 1);

  // The restart: 45 minutes later, same day (the demo's exact timing).
  world.clock.value = T0 + 45 * MIN;
  anchor.value = world.clock.value;
  const replan = await tick(planner, 'checkpoint');
  assert.equal(replan.ok, true, JSON.stringify(replan));
  assert.equal(replan.version, 2);
  assert.equal(replan.slots, 2);
  const current = planRows(world).find(row => row.status === 'committed');
  assert.equal(current.plan_id, planRows(world)[1].plan_id);
  assert.equal(Number(current.version), 2);
  const slots = slotRows(world).filter(slot => slot.plan_id === current.plan_id);
  assert.deepEqual(slots.map(slot => slot.kind), ['activity', 'open']);
  assert.deepEqual(slots.map(slot => Number(slot.start_at)), [world.clock.value, world.clock.value + 40 * MIN]);
  assert.equal(slots[0].flexibility, 'soft');
  assert.equal(slots[0].target_ref, 'drafts/city-observation.md');
});

test('P2-06: the same 2-slot answer anchored at the day start is refused (it reaches back)', async (t) => {
  const world = makeWorld(t);
  const model = scriptedModel([dayOpener(), eveningPlan(T0)]);
  const planner = makePlanner(world, { model });
  assert.equal((await tick(planner, 'manual')).ok, true);

  world.clock.value = T0 + 45 * MIN;
  const refused = await tick(planner, 'checkpoint');
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'invalid-plan', 'the demo\'s second round: anchored 45 minutes in the past');
  assert.match(refused.error, /slots\[0\] starts before now/);
  const plans = planRows(world);
  assert.equal(plans.length, 1, 'the original plan stays committed');
  assert.equal(plans[0].status, 'committed');
  assert.equal(Number(plans[0].version), 1);
});

// Review pass 2, B-1 (blocking): superseding a plan must terminate the slots it left
// behind, or the pump would still start the *old* plan's activity when its hour arrives.
test('P2-06: a superseded plan\'s untouched slots are retired and can never be started', async (t) => {
  const world = makeWorld(t);
  const oldStart = T0 + 120 * MIN; // 15:41 local, the old plan's hour
  const newStart = T0 + 240 * MIN;
  const model = scriptedModel([
    { summary: '下午读旧材料', slots: [{ kind: 'activity', activity: 'read', title: '读旧材料', startAt: oldStart, endAt: oldStart + 40 * MIN, flexibility: 'soft', targetRef: 'shelf/old.md' }] },
    { summary: '改主意了，读新材料', slots: [{ kind: 'activity', activity: 'read', title: '读新材料', startAt: newStart, endAt: newStart + 40 * MIN, flexibility: 'soft', targetRef: 'shelf/new.md' }] },
  ]);
  const planner = makePlanner(world, { model });
  assert.equal((await tick(planner, 'manual')).ok, true);
  const [oldSlot] = slotRows(world);

  world.clock.value = T0 + 30 * MIN;
  const replan = await tick(planner, 'checkpoint');
  assert.equal(replan.ok, true, JSON.stringify(replan));
  assert.equal(replan.version, 2);

  const plans = planRows(world);
  assert.equal(plans.filter(row => row.status === 'committed').length, 1, 'exactly one committed plan per day');
  const retired = world.db.get('SELECT * FROM p2_plan_slots WHERE slot_id = ?', oldSlot.slot_id);
  assert.equal(retired.status, 'skipped', 'the superseded plan\'s planned slot is retired (frozen enum `skipped`)');
  assert.equal(Number(retired.start_at), oldStart, 'the retirement does not rewrite the times');
  assert.equal(Number(retired.updated_at), T0 + 30 * MIN, 'the transition uses the superseding commit instant, not a cycle clock');

  // The pump's own predicate (status='planned' inside the window) now matches nothing from v1.
  world.clock.value = oldStart + MIN;
  const startable = world.db.all("SELECT * FROM p2_plan_slots WHERE scope = ? AND status = 'planned' AND kind = 'activity' AND start_at <= ? AND end_at > ?", KEY, world.clock.value, world.clock.value);
  assert.deepEqual(startable, [], 'nothing from the superseded plan can be started');
  const survivor = world.db.all("SELECT * FROM p2_plan_slots WHERE scope = ? AND plan_id = ? AND status = 'planned'", KEY, plans[1].plan_id);
  assert.equal(survivor.length, 1, 'the new version keeps its own planned slot');
  assert.equal(survivor[0].target_ref, 'shelf/new.md');
});

test('P2-06: a locked slot is carried into the new version instead of being dropped', async (t) => {
  const world = makeWorld(t);
  // A pinned slot written through the reducer (Studio/manual path; the model cannot set it).
  const pinnedStart = T0 + 180 * MIN;
  world.expectOk({
    kind: 'autonomy/plan-committed',
    scope: SCOPE,
    occurredAt: T0,
    payload: {
      at: T0, day: '2026-11-02', timeZone: TZ, sourceRunId: 'run_seed', snapshotDigest: 'd_seed',
      plan: {
        planId: 'plan_pinned', day: '2026-11-02', version: 1, windowStart: T0, windowEnd: T0 + 8 * HOUR, summary: '钉住的一段', timeZone: TZ,
        slots: [{ kind: 'activity', activity: 'write', title: '写完那一段（钉住）', startAt: pinnedStart, endAt: pinnedStart + 30 * MIN, flexibility: 'firm', targetRef: 'drafts/pinned', locked: true }],
      },
    },
  });
  assert.equal(Number(world.db.get("SELECT locked FROM p2_plan_slots WHERE plan_id = 'plan_pinned'").locked), 1);

  const model = scriptedModel([{ summary: '改主意了', slots: [{ kind: 'open', title: '留白', startAt: T0 + 300 * MIN, endAt: T0 + 330 * MIN, flexibility: 'soft' }] }]);
  const planner = makePlanner(world, { model });
  world.clock.value = T0 + 30 * MIN;
  const replan = await tick(planner, 'checkpoint');
  assert.equal(replan.ok, true, JSON.stringify(replan));
  assert.equal(replan.version, 2);

  const plans = planRows(world);
  const committed = plans.find(row => row.status === 'committed');
  const oldRow = world.db.get("SELECT * FROM p2_plan_slots WHERE plan_id = 'plan_pinned'");
  assert.equal(oldRow.status, 'skipped', 'the old row is retired');
  const carried = world.db.all('SELECT * FROM p2_plan_slots WHERE scope = ? AND plan_id = ? AND locked = 1', KEY, committed.plan_id);
  assert.equal(carried.length, 1, 'the locked slot survives into the new version');
  assert.equal(Number(carried[0].start_at), pinnedStart);
  assert.equal(carried[0].status, 'planned');
  assert.equal(carried[0].target_ref, 'drafts/pinned');
assert.equal(carried[0].title, '写完那一段（钉住）');
assert.equal(Number(carried[0].locked), 1);
assert.equal(Number(carried[0].end_at) - Number(carried[0].start_at), 30 * MIN, 'the carried slot keeps its own window');
  assert.equal(carried[0].flexibility, 'firm');
  // The model still cannot smuggle a lock into a plan.
  const rejected = await (async () => {
    const badModel = scriptedModel([{ summary: 'x', slots: [{ kind: 'open', title: 'y', startAt: T0 + 400 * MIN, endAt: T0 + 420 * MIN, flexibility: 'soft', locked: true }] }]);
    const other = makeWorld(t);
    const badPlanner = makePlanner(other, { model: badModel });
    return badPlanner.tick({ scopeKey: KEY, reason: 'manual' });
  })();
  assert.equal(rejected.code, 'invalid-plan', 'the model may not set `locked`');
});

// --------------------------------------------------- R-2: carried locks are first-class
//
// Amendment v1.2 §7 R-2: a preserved `locked` slot takes part in the new version's overlap /
// out-of-window / cross-midnight validation exactly like a normal slot, so a model answer can
// never double-book a promise and a promise is never silently dropped.

// A planner-written slot always carries its reality label (BLOCK-5); the fixture matches that.
const lockedAt = startAt => ({ kind: 'activity', activity: 'write', title: '钉住的写作', startAt, endAt: startAt + 30 * MIN, flexibility: 'firm', targetRef: 'drafts/pinned', locked: true, reality: 'actual_tool_activity' });

test('P2-06 (R-2): a new slot that collides with a carried locked slot is refused', async (t) => {
  const world = makeWorld(t);
  const pinnedStart = T0 + 80 * MIN;
  world.expectOk(planEvent({ planId: 'plan_v1', version: 1, slots: [lockedAt(pinnedStart)] }));
  const model = scriptedModel([{ summary: '改主意读别的', slots: [{ kind: 'activity', activity: 'read', title: '读点别的', startAt: pinnedStart + 10 * MIN, endAt: pinnedStart + 25 * MIN, flexibility: 'soft', targetRef: 'shelf/other.md' }] }]);
  const planner = makePlanner(world, { model });
  world.clock.value = T0 + 30 * MIN;
  const refused = await tick(planner, 'checkpoint');
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'slot-overlap', 'the model slot overlaps the promise it would preserve');
  assert.match(refused.error, /locked slot/);
  assert.equal(model.calls.length, 1, 'the model answered once; the commit refused it');
  const plans = planRows(world);
  assert.equal(plans.length, 1, 'no new version was written');
  assert.equal(plans[0].status, 'committed');
  const pinned = slotRows(world).find(row => Number(row.locked) === 1);
  assert.equal(pinned.status, 'planned', 'the promise stays exactly as it was');
  assert.equal(Number(pinned.start_at), pinnedStart);
});

test('P2-06 (R-2): a carried locked slot that no longer fits the new window is refused', async (t) => {
  const world = makeWorld(t);
  const pinnedStart = T0 + 20 * MIN; // 14:01 — already past when the replan happens
  world.expectOk(planEvent({ planId: 'plan_v1', version: 1, slots: [lockedAt(pinnedStart)] }));
  const model = scriptedModel([{ summary: '下午换个安排', slots: [{ kind: 'open', title: '留白', startAt: T0 + 120 * MIN, endAt: T0 + 150 * MIN, flexibility: 'soft' }] }]);
  const planner = makePlanner(world, { model });
  world.clock.value = T0 + 60 * MIN; // 14:41, so 14:01 is outside [now, dayEnd]
  const refused = await tick(planner, 'checkpoint');
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'slot-out-of-window');
  assert.match(refused.error, /locked slot .* does not fit/);
  assert.equal(planRows(world).length, 1, 'the old version keeps the promise visible');
  const pinned = slotRows(world).find(row => Number(row.locked) === 1);
  assert.equal(pinned.status, 'planned');
});

test('P2-06 (R-2/H5): locked slots are exposed, and the plan page can lock, unlock and skip one', async (t) => {
  const world = makeWorld(t);
  const pinnedStart = T0 + 80 * MIN;
  world.expectOk(planEvent({ planId: 'plan_v1', version: 1, slots: [lockedAt(pinnedStart), { kind: 'open', title: '留白', startAt: T0 + 200 * MIN, endAt: T0 + 230 * MIN, flexibility: 'soft', targetRef: '' }] }));
  const planner = makePlanner(world, { model: scriptedModel([{ summary: '下午留白', slots: [{ kind: 'open', title: '留白', startAt: T0 + 150 * MIN, endAt: T0 + 180 * MIN, flexibility: 'soft' }] }]) });
  const [pinned, soft] = slotRows(world);

  // Exposed for the life view: status() and snapshot() both name the promise.
  const status = planner.status({ scopeKey: KEY });
  assert.equal(status.slots.locked, 1);
  assert.equal(status.lockedSlots.length, 1);
  assert.equal(status.lockedSlots[0].slotId, pinned.slot_id);
  assert.equal(status.lockedSlots[0].title, '钉住的写作');
  assert.equal(status.lockedSlots[0].targetRef, 'drafts/pinned');
  assert.equal(status.lockedSlots[0].status, 'planned');
  assert.equal(status.lockedSlots[0].reality, 'actual_tool_activity');
  const snapshot = planner.snapshot({ scopeKey: KEY });
  assert.equal(snapshot.slots.find(slot => slot.slotId === pinned.slot_id).locked, true);
  assert.equal(snapshot.slots.find(slot => slot.slotId === soft.slot_id).locked, false);
  assert.equal(snapshot.lockedSlots.length, 1);

  // H5: the plan page can lock/unlock/skip a future slot through the reducer.
  world.expectOk({ kind: 'autonomy/plan-slot', scope: SCOPE, occurredAt: T0 + MIN, payload: { at: T0 + MIN, slotId: soft.slot_id, action: 'lock' } });
  assert.equal(Number(slotRows(world).find(row => row.slot_id === soft.slot_id).locked), 1);
  const lockedNow = planner.status({ scopeKey: KEY });
  assert.equal(lockedNow.slots.locked, 2);
  world.expectOk({ kind: 'autonomy/plan-slot', scope: SCOPE, occurredAt: T0 + 2 * MIN, payload: { at: T0 + 2 * MIN, slotId: soft.slot_id, action: 'unlock' } });
  assert.equal(Number(slotRows(world).find(row => row.slot_id === soft.slot_id).locked), 0);
  world.expectOk({ kind: 'autonomy/plan-slot', scope: SCOPE, occurredAt: T0 + 3 * MIN, payload: { at: T0 + 3 * MIN, slotId: soft.slot_id, action: 'skip' } });
  assert.equal(slotRows(world).find(row => row.slot_id === soft.slot_id).status, 'skipped');
  // A slot that already happened can no longer be locked or skipped…
  assert.equal(world.expectRejected({ kind: 'autonomy/plan-slot', scope: SCOPE, occurredAt: T0 + 4 * MIN, payload: { at: T0 + 4 * MIN, slotId: soft.slot_id, action: 'lock' } }), 'invalid-transition');
  // …but repeating the skip it already has is idempotent (replay-safe), not an error.
  world.expectOk({ kind: 'autonomy/plan-slot', scope: SCOPE, occurredAt: T0 + 4 * MIN, payload: { at: T0 + 4 * MIN, slotId: soft.slot_id, action: 'skip' } });
  assert.equal(slotRows(world).find(row => row.slot_id === soft.slot_id).status, 'skipped');

  // Only the still-locked slot is carried into a new version; the skipped one stays history.
  world.clock.value = T0 + 30 * MIN;
  const replan = await planner.tick({ scopeKey: KEY, reason: 'checkpoint' });
  assert.equal(replan.ok, true, JSON.stringify(replan));
  assert.equal(replan.carried, 1);
  const carried = slotRows(world).filter(row => Number(row.locked) === 1 && row.plan_id !== 'plan_v1');
  assert.equal(carried.length, 1);
  assert.equal(carried[0].status, 'planned');
  assert.equal(Number(carried[0].start_at), pinnedStart);
});
