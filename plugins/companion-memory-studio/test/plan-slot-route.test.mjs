import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStudioHandlers, ROUTES, groupRoutesByPath } from '../server.mjs';

// H5 (blocking-7) write path: the page's 锁定 / 跳过 buttons go through POST /plan-slot, which
// must hand the request to the live runtime and never write the plan itself. These tests drive
// the real handler through the real route table with a stub engine and a stub runtime.

const PATH = '/api/companion-memory/plan-slot';
const VIEWER = { userId: 'owner-1', personaId: 'march7', worldId: 'world:default' };

function engine() {
  return { internal: async () => ({ viewer: () => VIEWER }) };
}

function request(body) {
  return new Request(`http://127.0.0.1${PATH}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

function handlersWith(runtime) {
  return createStudioHandlers({ engine: engine(), identity: null, root: '/tmp/studio', log: null, runtime: () => runtime });
}

async function call(runtime, body) {
  const handlers = handlersWith(runtime);
  const response = await handlers[`POST ${PATH}`](request(body));
  const payload = await response.json();
  return { status: response.status, payload };
}

test('H5: the plan-slot route is registered on the shared path with the other POST routes', () => {
  const entry = groupRoutesByPath(ROUTES).find(group => group.path === PATH);
  assert.ok(entry, 'the route is part of the studio table');
  assert.deepEqual(entry.methods, ['POST']);
  assert.ok(entry.names.includes('plan-slot'));
});

test('H5: lock hands the slot to the runtime and reports what it did', async () => {
  const seen = [];
  const runtime = {
    lockPlanSlot: async input => { seen.push(['lock', input]); return { ok: true, slot: { slotId: input.slotId, locked: true }, status: 'planned' }; },
    skipPlanSlot: async () => { throw new Error('not used'); },
  };
  const { status, payload } = await call(runtime, { slotId: 'slot-next', action: 'lock' });
  assert.equal(status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.data.slotId, 'slot-next');
  assert.equal(payload.data.action, 'lock');
  assert.equal(seen.length, 1, 'the runtime was called exactly once');
  assert.deepEqual(seen[0][1], { bound: { userId: 'owner-1', personaId: 'march7' }, slotId: 'slot-next', locked: true });
});

test('H5: unlock and skip use the runtime too, and skip carries the reason', async () => {
  const seen = [];
  const runtime = {
    lockPlanSlot: async input => { seen.push(['lock', input]); return { ok: true }; },
    skipPlanSlot: async input => { seen.push(['skip', input]); return { ok: true, status: 'skipped' }; },
  };
  assert.equal((await call(runtime, { slotId: 'slot-a', action: 'unlock' })).payload.ok, true);
  const skipped = await call(runtime, { slotId: 'slot-b', action: 'skip', reason: '改主意了' });
  assert.equal(skipped.payload.data.status, 'skipped');
  assert.deepEqual(seen.map(entry => entry[0]), ['lock', 'skip']);
  assert.equal(seen[0][1].locked, false, 'unlock is lock with locked:false');
  assert.equal(seen[1][1].reason, '改主意了');
});

test('H5: without a runtime the route says so instead of pretending', async () => {
  const { status, payload } = await call(null, { slotId: 'slot-next', action: 'lock' });
  assert.equal(payload.ok, false);
  // The studio API vocabulary is fixed (bad-request / not-found / db-unavailable / denied /
  // internal), so "not wired" is `db-unavailable` with an honest message — not a fake success.
  assert.equal(payload.error.code, 'db-unavailable');
  assert.equal(status, 500, 'the page can tell this apart from a refusal');
  assert.match(payload.error.message, /没有提供计划控制接口/);
});

test('H5: the runtime’s own refusal is passed through, not invented', async () => {
  const runtime = {
    lockPlanSlot: async () => { const error = new Error('a started slot cannot be locked'); error.code = 'invalid-transition'; throw error; },
    skipPlanSlot: async () => { const error = new Error('slot slot-x is unknown'); error.code = 'unknown-slot'; throw error; },
  };
  const locked = await call(runtime, { slotId: 'slot-started', action: 'lock' });
  assert.equal(locked.payload.error.code, 'bad-request', 'a started slot is a bad request');
  assert.match(locked.payload.error.message, /invalid-transition/, 'the runtime code is kept verbatim');
  assert.equal(locked.status, 400);
  const missing = await call(runtime, { slotId: 'slot-ghost', action: 'skip' });
  assert.equal(missing.payload.error.code, 'not-found');
  assert.match(missing.payload.error.message, /unknown-slot/);
  assert.equal(missing.status, 404);
});

test('H5: bad requests never reach the runtime', async () => {
  let calls = 0;
  const runtime = { lockPlanSlot: async () => { calls += 1; return { ok: true }; }, skipPlanSlot: async () => { calls += 1; return { ok: true }; } };
  for (const body of [{ action: 'lock' }, { slotId: 'slot-a', action: 'delete' }, { slotId: 'slot-a' }]) {
    const { payload } = await call(runtime, body);
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, 'bad-request', JSON.stringify(body));
  }
  assert.equal(calls, 0, 'nothing invalid reached the runtime');
});
