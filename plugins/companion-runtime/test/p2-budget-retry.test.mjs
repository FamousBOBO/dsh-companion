import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openRuntimeDb } from '../lib/db.mjs';
import { scopeKey as keyOfScope } from '../lib/scope.mjs';
import { createBudget } from '../lib/budget.mjs';

// Budget reservation identity under retries (external two-process fencing blocker).
//
// The pump used to pass a fixed ref per segment (`act:<id>:<consumed>:<from>-<to>`), and
// `reserve` used that ref verbatim as `entry_id`. A retry of the same segment — a failed model
// call, or a second writer taking the lease over at the same checkpoint — therefore hit
// `UNIQUE constraint failed: p2_budget_ledger.entry_id` and the whole step died.
//
// The contract now is: every *attempt* owns a distinct reservation, the previous issued attempt
// keeps its conservative charge, and `settle` settles the reservation that was returned.

const SCOPE = Object.freeze({ userId: 'owner-1', personaId: 'bot', worldId: 'world:default' });
const KEY = keyOfScope(SCOPE);
const T0 = Date.UTC(2026, 10, 5, 3, 0, 0);

function makeWorld(t) {
  const clock = { value: T0 };
  const db = openRuntimeDb({ file: ':memory:', now: () => clock.value });
  t.after(() => { try { db.close(); } catch { /* closed */ } });
  const owner = 'owner-test';
  const generation = 'gen-test';
  // A short lease is what makes the takeover path reachable at all.
  assert.equal(db.acquireLease({ owner, generation, ttlMs: 5000 }).ok, true);
  const config = { p2: { budget: { maxRequestsPerDay: 64, maxInputTokensPerDay: 160000, maxOutputTokensPerDay: 24000, recoveryReserveRatio: 0.2, chatPriority: false } } };
  const budget = createBudget({ db, config, clock: () => clock.value, timeZone: 'Asia/Shanghai', owner, generation, shouldYield: () => false });
  return { db, clock, budget, owner, generation };
}

const SEGMENT_REF = 'act:act-1:120:120-160';

test('budget: retrying the same segment never collides on entry_id', async t => {
  const { db, budget } = makeWorld(t);
  const first = budget.reserve({ scope: KEY, purpose: 'p2-activity', ref: SEGMENT_REF, estimatedInputTokens: 500, estimatedOutputTokens: 200 });
  assert.equal(first.ok, true, JSON.stringify(first));
  budget.markIssued({ scope: KEY, ref: first.ref });
  budget.settle({ scope: KEY, ref: first.ref, inputTokens: 400, outputTokens: 120, ok: false, code: 'model-error' });
  // Same segment, second attempt: a new reservation, no exception, and the failed attempt is
  // still visible with its conservative charge.
  const second = budget.reserve({ scope: KEY, purpose: 'p2-activity', ref: SEGMENT_REF, estimatedInputTokens: 500, estimatedOutputTokens: 200 });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.notEqual(second.ref, first.ref, 'each attempt gets its own reservation id');
  const rows = db.all("SELECT entry_id, amount, settled, issued FROM p2_budget_ledger WHERE kind = 'requests' ORDER BY entry_id");
  assert.equal(rows.length, 2, 'both attempts are recorded');
  assert.equal(rows.every(row => Number(row.settled) === 1 || Number(row.issued) === 0), true, 'no attempt was silently dropped');
  const charged = rows.reduce((sum, row) => sum + Number(row.amount), 0);
  assert.equal(charged, 2, 'both attempts are charged (the failed one is not refunded)');
});

test('budget: a takeover writer can retry the same segment and settle its own reservation', async t => {
  const { db, clock, budget, owner, generation } = makeWorld(t);
  const first = budget.reserve({ scope: KEY, purpose: 'p2-activity', ref: SEGMENT_REF, estimatedInputTokens: 300, estimatedOutputTokens: 100 });
  budget.markIssued({ scope: KEY, ref: first.ref });
  // The first writer dies without settling. The second writer takes the lease over.
  const takeoverOwner = 'owner-2';
  const takeoverGeneration = 'gen-2';
  clock.value = T0 + 6000;
  assert.equal(db.acquireLease({ owner: takeoverOwner, generation: takeoverGeneration, ttlMs: 86_400_000 }).ok, true);
  const second = createBudget({ db, config: { p2: { budget: { maxRequestsPerDay: 64, maxInputTokensPerDay: 160000, maxOutputTokensPerDay: 24000, recoveryReserveRatio: 0.2, chatPriority: false } } }, clock: () => clock.value, timeZone: 'Asia/Shanghai', owner: takeoverOwner, generation: takeoverGeneration, shouldYield: () => false });
  const retry = second.reserve({ scope: KEY, purpose: 'p2-activity', ref: SEGMENT_REF, estimatedInputTokens: 300, estimatedOutputTokens: 100 });
  assert.equal(retry.ok, true, JSON.stringify(retry));
  second.markIssued({ scope: KEY, ref: retry.ref });
  const settled = second.settle({ scope: KEY, ref: retry.ref, inputTokens: 250, outputTokens: 80, ok: true });
  assert.equal(settled.ok, true, JSON.stringify(settled));
  const rows = db.all("SELECT entry_id, amount, settled, issued FROM p2_budget_ledger WHERE kind = 'requests' ORDER BY entry_id");
  assert.equal(rows.length, 2, 'the dead attempt and the takeover attempt both exist');
  const dead = rows.find(row => row.entry_id === first.ref);
  assert.equal(Number(dead.settled), 0, 'the dead attempt stays open for the sweep instead of being deleted');
  assert.equal(Number(dead.issued), 1, 'and it stays issued, so its charge is conservative');
  const fresh = rows.find(row => row.entry_id === retry.ref);
  assert.equal(Number(fresh.settled), 1, 'the takeover reservation settled');
  // The sweep is what closes the dead attempt later; it must not refund the quota.
  const swept = second.sweep({ scope: KEY, now: T0 + 3 * 3600_000 + 6000 });
  assert.equal(swept.ok, true);
  const afterSweep = db.get("SELECT settled, amount FROM p2_budget_ledger WHERE entry_id = ? AND kind = 'requests'", first.ref);
  assert.equal(Number(afterSweep.settled), 1, 'the dead attempt is closed');
  assert.equal(Number(afterSweep.amount), 1, 'and it is still charged');
  assert.equal(owner !== takeoverOwner && generation !== takeoverGeneration, true);
});
