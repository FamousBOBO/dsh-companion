import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openRuntimeDb } from '../lib/db.mjs';
import { dispatchEvent } from '../lib/events.mjs';
import { scopeKey as keyOfScope } from '../lib/scope.mjs';
import { applyPlanEvent, createPlanner, interestIdFor, PLAN_LIMITS } from '../lib/planner.mjs';

// P2-05 — cross-day soft directions and the promise boundary.
//
// Soft directions live in `p2_interests` for 3–7 days: a direction touched within the
// horizon is carried into the next day's prompt, an older one is not, and nothing ever
// fills future calendars. A closed project is never revived, and a user's explicit
// commitment is never cancelled by a soft direction (the planner can only change its own
// plan; H1 rows stay untouched).

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
  function expectRejected(input) {
    const outcome = dispatch(input);
    assert.equal(outcome.rejected, true, 'the event must be rolled back');
    return (outcome.results ?? []).find(result => result.error)?.code ?? 'unknown';
  }
  return { clock, db, owner, generation, dispatch, expectOk, expectRejected };
}

function interestEvent({ action = 'upsert', interestId, kind = 'project', title, note = '', at = T0, expectedRevision, status }) {
  const payload = { action, at, ...(interestId ? { interestId } : {}) };
  if (action === 'upsert') payload.interest = { interestId, kind, title, note, origin: 'plan', ref: 'plan:p1', status: 'active', strength: 0.5 };
  if (expectedRevision !== undefined) payload.expectedRevision = expectedRevision;
  if (status) payload.status = status;
  return { kind: 'autonomy/interest', scope: SCOPE, occurredAt: at, payload };
}

function scriptedModel(script) {
  const calls = [];
  const fn = async (request) => {
    calls.push(request);
    const index = Math.min(calls.length - 1, script.length - 1);
    const answer = script[index];
    const value = typeof answer === 'function' ? await answer(request, calls.length) : answer;
    if (value && typeof value === 'object' && typeof value.text === 'string') return value;
    return { text: typeof value === 'string' ? value : JSON.stringify(value), provider: 'script', model: 'script-v1', inputTokens: 100, outputTokens: 45 };
  };
  fn.calls = calls;
  return fn;
}

function makeMaterials(world, overrides = {}) {
  const fixedAgenda = () => world.db.all(`SELECT occurrence_id, item_id, scheduled_at, slot_end_at, status FROM agenda_occurrences
    WHERE scope = ? AND status IN ('scheduled','due','dispatched')`, KEY)
    .map(row => ({ occurrenceId: row.occurrence_id, startAt: Number(row.scheduled_at), endAt: Number(row.slot_end_at), title: '约定', authorization: 'reminder', status: row.status }));
  return () => ({
    timeZone: TZ, persona: { version: 2, excerpt: '三月七' }, preferences: [],
    goals: [], commitments: [], fixedAgenda: fixedAgenda(), runningActivities: [], lastReceipts: [],
    interests: [], opportunities: [], capabilities: [], budget: null, ...overrides,
  });
}

function makePlanner(world, { model, materials = makeMaterials(world), planning = {} } = {}) {
  const budget = {
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
    budget,
    materials,
    pause: { mode: 'active' },
  });
}

const tick = (planner, reason = 'manual') => planner.tick({ scopeKey: KEY, reason });

function interestRows(world) {
  return world.db.all('SELECT * FROM p2_interests WHERE scope = ? ORDER BY interest_id', KEY);
}

function plannedSlots(world) {
  return world.db.all('SELECT * FROM p2_plan_slots WHERE scope = ? ORDER BY start_at', KEY);
}

// ------------------------------------------------------------ persistence

test('P2-05: a plan writes its soft directions into p2_interests with a revision', async (t) => {
  const world = makeWorld(t);
  const model = scriptedModel([{
    summary: '想继续写那篇随笔',
    slots: [{ kind: 'activity', activity: 'write', targetRef: 'drafts/notes', title: '写第二段', startAt: T0 + 40 * MIN, endAt: T0 + 90 * MIN, flexibility: 'soft' }],
    interests: [{ kind: 'project', title: '随笔《夏日》', note: '想把第二段写完' }],
  }]);
  const planner = makePlanner(world, { model });
  const outcome = await tick(planner);
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(outcome.interests, 1);

  const rows = interestRows(world);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'project');
  assert.equal(rows[0].title, '随笔《夏日》');
  assert.equal(rows[0].status, 'active');
  assert.equal(Number(rows[0].revision), 1);
  assert.equal(rows[0].origin, 'plan');
  assert.match(rows[0].ref, /^plan:/);
});

test('P2-05: the next day carries the direction into the prompt without refilling the calendar', async (t) => {
  const world = makeWorld(t);
  const dayOne = {
    summary: '继续随笔',
    slots: [{ kind: 'activity', activity: 'write', targetRef: 'drafts/notes', title: '写第二段', startAt: T0 + 40 * MIN, endAt: T0 + 90 * MIN, flexibility: 'soft' }],
    interests: [{ kind: 'project', title: '随笔《夏日》', note: '想把第二段写完' }],
  };
  const dayTwo = (request, call) => {
    const now = world.clock.value;
    return {
      summary: '接着写',
      slots: [{ kind: 'activity', activity: 'write', targetRef: 'drafts/notes', title: '写第三段', startAt: now + 30 * MIN, endAt: now + 80 * MIN, flexibility: 'soft' }],
      interests: [{ kind: 'project', title: '随笔《夏日》', note: '再写一段' }],
    };
  };
  const model = scriptedModel([dayOne, dayTwo]);
  const planner = makePlanner(world, { model });

  assert.equal((await tick(planner, 'manual')).ok, true);
  world.clock.value = T0 + DAY + HOUR;
  const second = await tick(planner, 'day-change');
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.ok(second.day === '2026-11-03');
  assert.equal(model.calls.length, 2);

  const dayTwoPrompt = model.calls[1].input;
  assert.ok(dayTwoPrompt.includes('随笔《夏日》'), 'the soft direction is carried into the next day');
  assert.ok(dayTwoPrompt.includes('1 天前碰过'), 'the prompt says how fresh the direction is');

  const plans = world.db.all('SELECT day, status FROM p2_plans WHERE scope = ? ORDER BY day', KEY);
  assert.deepEqual(plans.map(row => row.day), ['2026-11-02', '2026-11-03'], 'only today is ever planned, never a future day');
  const rows = interestRows(world);
  assert.equal(rows.length, 1, 'the same direction stays one row across days');
  assert.equal(Number(rows[0].revision), 2, 'an upsert bumps the revision');
});

test('P2-05: the 3–7 day horizon decides which directions are carried', async (t) => {
  const world = makeWorld(t);
  world.expectOk(interestEvent({ interestId: interestIdFor(KEY, 'project', '旧项目'), title: '旧项目', at: T0 - 8 * DAY }));
  world.expectOk(interestEvent({ interestId: interestIdFor(KEY, 'project', '新项目'), title: '新项目', at: T0 - 2 * DAY }));
  assert.equal(interestRows(world).length, 2);

  const model = scriptedModel([{ summary: '继续', slots: [] }]);
  const planner = makePlanner(world, { model });
  const outcome = await tick(planner);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.status, 'empty');
  const prompt = model.calls[0].input;
  assert.ok(prompt.includes('新项目'), 'a direction inside the horizon is carried');
  assert.ok(!prompt.includes('旧项目'), 'a direction older than the horizon is not carried');
  assert.equal(planner.status({ scopeKey: KEY }).interests.carried, 1);
  assert.equal(planner.status({ scopeKey: KEY }).interests.horizonDays, PLAN_LIMITS.softDirectionDays);
});

// ---------------------------------------------------------------- lifecycle

test('P2-05: a closed project is never revived, and the plan still commits', async (t) => {
  const world = makeWorld(t);
  const interestId = interestIdFor(KEY, 'project', '写完的小故事');
  world.expectOk(interestEvent({ interestId, title: '写完的小故事', at: T0 - DAY }));
  const closed = world.expectOk(interestEvent({ action: 'close', interestId, status: 'done', at: T0 - HOUR }));
  assert.equal(closed.status, 'done');
  assert.equal(Number(interestRows(world)[0].revision), 2);

  // Reviving a finished project is refused deterministically.
  const code = world.expectRejected(interestEvent({ interestId, title: '写完的小故事', at: T0 }));
  assert.equal(code, 'terminal-interest');
  assert.equal(interestRows(world)[0].status, 'done');

  // The planner proposes the same direction again: the upsert is skipped, the plan lands.
  const model = scriptedModel([{
    summary: '还想继续那个故事',
    slots: [{ kind: 'activity', activity: 'write', targetRef: 'drafts/notes', title: '再写一点', startAt: T0 + 40 * MIN, endAt: T0 + 80 * MIN, flexibility: 'soft' }],
    interests: [{ kind: 'project', title: '写完的小故事', note: '也许还能加一段' }],
  }]);
  const planner = makePlanner(world, { model });
  const outcome = await tick(planner);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.interests, 0, 'a dropped/closed direction is not revived');
  assert.equal(interestRows(world)[0].status, 'done');
});

test('P2-05: an upsert honours an optional expectedRevision', async (t) => {
  const world = makeWorld(t);
  const interestId = interestIdFor(KEY, 'interest', '想弄明白潮汐');
  world.expectOk(interestEvent({ interestId, kind: 'interest', title: '想弄明白潮汐', at: T0 - HOUR }));
  const stale = world.expectRejected(interestEvent({
    interestId, kind: 'interest', title: '想弄明白潮汐', at: T0, expectedRevision: 99,
  }));
  assert.equal(stale, 'stale-revision');
  const fresh = world.expectOk(interestEvent({
    interestId, kind: 'interest', title: '想弄明白潮汐', note: '先看看月亮', at: T0, expectedRevision: 1,
  }));
  assert.equal(fresh.revision, 2);
  assert.equal(interestRows(world)[0].note, '先看看月亮');
});

// ------------------------------------------------- promises are not negotiable

test('P2-05: a soft direction never cancels a user commitment', async (t) => {
  const world = makeWorld(t);
  // A real H1 item the user created, and its occurrence.
  world.db.run(`INSERT INTO agenda_items (item_id, scope, revision, title, category, source, rule_kind, time_zone,
    local_date, local_time, weekdays, at_utc, valid_from, valid_until, status, authorization, delivery,
    goal_ref, commitment_ref, request_key, resolution, created_at, updated_at)
    VALUES ('item_promise', ?, 1, '陪用户看那部电影', 'plan', 'tool', 'once', 'Asia/Shanghai', '2026-11-02',
    '15:00', '[]', ?, 0, NULL, 'active', 'reminder', 'none', '', '', 'req_promise', '{}', 0, 0)`, KEY, T0 + 79 * MIN);
  world.db.run(`INSERT INTO agenda_occurrences (occurrence_id, scope, item_id, slot_key, definition_revision, scheduled_at,
    slot_end_at, status, reason_code, revision, attempts, last_error, causation_event_id, created_at, updated_at)
    VALUES ('occ_promise', ?, 'item_promise', 'once:1', 1, ?, ?, 'scheduled', '', 1, 0, '', '', 0, 0)`,
  KEY, T0 + 79 * MIN, T0 + 139 * MIN);

  const before = world.db.all('SELECT * FROM agenda_items WHERE scope = ?', KEY);
  const model = scriptedModel([{
    summary: '想在那时候写东西',
    slots: [{ kind: 'activity', activity: 'write', targetRef: 'drafts/notes', title: '写随笔', startAt: T0 + 90 * MIN, endAt: T0 + 130 * MIN, flexibility: 'soft' }],
    interests: [{ kind: 'project', title: '随笔《夏日》', note: '继续写' }],
  }]);
  const planner = makePlanner(world, { model });
  const outcome = await tick(planner);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'invalid-plan', 'the commitment window is not negotiable');
  assert.equal(world.db.all('SELECT * FROM p2_plans WHERE scope = ?', KEY).length, 0);
  assert.deepEqual(world.db.all('SELECT * FROM agenda_items WHERE scope = ?', KEY), before, 'the H1 row is untouched');
  assert.equal(world.db.all("SELECT * FROM agenda_occurrences WHERE scope = ? AND status = 'scheduled'", KEY).length, 1);
  assert.equal(world.db.all("SELECT * FROM domain_events WHERE scope = ? AND kind LIKE 'agenda/%'", KEY).length, 0, 'the planner never writes an agenda event');
});
