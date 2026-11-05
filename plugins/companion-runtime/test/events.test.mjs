import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openRuntimeDb } from '../lib/db.mjs';
import {
  normalizeEvent, appendEvent, dispatchEvent, applyEvent, receiptFor, receiptCount,
  eventCount, listEvents, consumersFor, CONSUMERS, eventIdFor,
} from '../lib/events.mjs';
import { scopeKey } from '../lib/scope.mjs';
import { StaleGenerationError, RuntimeStoppedError, RuntimeError } from '../lib/errors.mjs';

const SCOPE = Object.freeze({ userId: 'owner-1', personaId: 'march7', worldId: '' });
const KEY = scopeKey(SCOPE);
const T0 = Date.UTC(2026, 9, 29, 2, 0, 0);

function freshDb({ generation = 'gen-test' } = {}) {
  const db = openRuntimeDb({ file: ':memory:', now: () => T0 });
  db.acquireLease({ owner: 'test-owner', generation, ttlMs: 60000 });
  return db;
}

// Minimal consumers: the real reducers live in the domain modules, this file only
// proves the event machinery (dedupe, receipts, transactions, generations).
function handlersFor(calls, { failOn } = {}) {
  const make = name => ({ db, event, slice }) => {
    calls.push({ consumer: name, eventId: event.eventId });
    const applied = Number(slice.applied ?? 0) + 1;
    if (failOn === name) {
      db.run('INSERT INTO shadow_proposals (proposal_id, scope, kind, payload, decision, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        `half-${name}`, event.scopeKey, 'half-write', '{}', 'test', T0);
      throw new Error(`consumer ${name} exploded`);
    }
    return { slice: { applied, lastEvent: event.eventId }, result: { applied } };
  };
  return { goals: make('goals'), 'working-memory': make('working-memory'), beliefs: make('beliefs'), state: make('state'), bridge: make('bridge') };
}

test('A01: the same event delivered 10 times is applied once per consumer', () => {
  const db = freshDb();
  const calls = [];
  const handlers = handlersFor(calls);
  const event = normalizeEvent({
    kind: 'goal/proposed', scope: SCOPE, occurredAt: T0,
    payload: { title: '整理资料', source: 'conversation' },
  });
  const deliveries = [];
  for (let i = 0; i < 10; i += 1) deliveries.push(dispatchEvent(db, event, { handlers, generation: 'gen-test' }));

  assert.equal(deliveries.filter(d => d.inserted).length, 1, 'only the first delivery inserts');
  assert.equal(eventCount(db, KEY), 1, 'one authoritative event row');
  assert.equal(receiptCount(db, 'goals'), 1);
  assert.equal(receiptCount(db, 'working-memory'), 1);
  assert.deepEqual(calls.filter(c => c.consumer === 'goals').length, 1);
  assert.equal(db.projection(KEY).version, 2, 'two consumers -> two commits, no re-application');
  assert.equal(deliveries.at(-1).results.every(result => result.duplicate === true), true);
  db.close();
});

test('A01: one consumer failing does not swallow the event for other consumers', () => {
  const db = freshDb();
  const calls = [];
  const event = normalizeEvent({ kind: 'goal/proposed', scope: SCOPE, occurredAt: T0, payload: { title: 'x' } });
  const outcome = dispatchEvent(db, event, { handlers: handlersFor(calls, { failOn: 'goals' }), generation: 'gen-test' });
  const goals = outcome.results.find(r => r.consumer === 'goals');
  const wm = outcome.results.find(r => r.consumer === 'working-memory');
  assert.equal(goals.applied, false);
  assert.match(goals.error, /exploded/);
  assert.equal(wm.applied, true, 'the other legitimate consumer still processes it');
  assert.equal(receiptFor(db, 'goals', event.eventId), null, 'no receipt for the failed consumer');
  assert.ok(receiptFor(db, 'working-memory', event.eventId));
  assert.equal(db.get('SELECT COUNT(*) AS n FROM shadow_proposals').n, 0, 'half-written rows rolled back');
  db.close();
});

test('A08: a consumer failure rolls back the projection and can be replayed later', () => {
  const db = freshDb();
  const calls = [];
  const event = normalizeEvent({ kind: 'belief/asserted', scope: SCOPE, occurredAt: T0, payload: { proposition: '用户在忙' } });
  const before = db.projection(KEY);
  dispatchEvent(db, event, { handlers: handlersFor(calls, { failOn: 'beliefs' }), generation: 'gen-test' });
  const after = db.projection(KEY);
  assert.equal(after.version, before.version, 'no version bump without a commit');
  assert.equal(receiptFor(db, 'beliefs', event.eventId), null);

  const retry = dispatchEvent(db, event, { handlers: handlersFor(calls), generation: 'gen-test' });
  assert.equal(retry.inserted, false, 'the event row was already recorded');
  assert.equal(retry.results.find(r => r.consumer === 'beliefs').applied, true);
  assert.equal(receiptCount(db, 'beliefs'), 1);
  const replay = dispatchEvent(db, event, { handlers: handlersFor(calls), generation: 'gen-test' });
  assert.equal(replay.results.every(r => r.applied === false), true, 'a later replay applies nothing twice');
  db.close();
});

test('A08: crash between append and apply recovers without a half state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-events-'));
  const file = path.join(dir, 'runtime.db');
  const db = openRuntimeDb({ file, now: () => T0 });
  db.acquireLease({ owner: 'test-owner', generation: 'gen-test', ttlMs: 60000 });
  const event = normalizeEvent({ kind: 'goal/started', scope: SCOPE, occurredAt: T0, payload: { goalId: 'goal-1' } });
  db.tx(() => appendEvent(db, event, { generation: 'gen-test' }));
  // Simulated crash: nothing applied, handle gone.
  db.close();

  const db2 = openRuntimeDb({ file, now: () => T0 });
  db2.acquireLease({ owner: 'test-owner', generation: 'gen-test', ttlMs: 60000 });
  const calls = [];
  const retry = dispatchEvent(db2, event, { handlers: handlersFor(calls), generation: 'gen-test' });
  assert.equal(retry.inserted, false);
  assert.equal(retry.results.every(r => r.applied === true), true);
  assert.equal(db2.projection(KEY).version, 2);
  assert.equal(receiptCount(db2, 'goals'), 1);
  db2.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test('A08: submitting twice after a commit does not double-apply', () => {
  const db = freshDb();
  const handlers = handlersFor([]);
  const event = normalizeEvent({ kind: 'commitment/made', scope: SCOPE, occurredAt: T0, payload: { text: '周五继续整理资料' } });
  dispatchEvent(db, event, { handlers, generation: 'gen-test' });
  const version = db.projection(KEY).version;
  dispatchEvent(db, event, { handlers, generation: 'gen-test' });
  assert.equal(db.projection(KEY).version, version);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM commitments').n, 0, 'the test handler writes no business rows');
  db.close();
});

test('conflicting reuse of an event id is refused instead of silently overwritten', () => {
  const db = freshDb();
  const at = T0;
  const first = normalizeEvent({ kind: 'belief/asserted', scope: SCOPE, occurredAt: at, payload: { proposition: 'a' } });
  appendEvent(db, first, { generation: 'gen-test' });
  const conflicting = { ...first, kind: 'belief/corrected', scopeKey: first.scopeKey };
  assert.throws(() => appendEvent(db, conflicting, { generation: 'gen-test' }), /already exists with different content/);
  db.close();
});

test('event ids are content addressed and scope separated', () => {
  const base = { kind: 'state/impulse', occurredAt: T0, payload: { amounts: { tension: -0.1 } } };
  const a = eventIdFor({ ...base, scope: SCOPE });
  const b = eventIdFor({ ...base, scope: SCOPE });
  const c = eventIdFor({ ...base, scope: { ...SCOPE, userId: 'owner-2' } });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('consumer map keeps domains separate', () => {
  assert.deepEqual(consumersFor('goal/proposed').sort(), ['goals', 'working-memory']);
  assert.deepEqual(consumersFor('belief/asserted'), ['beliefs']);
  assert.deepEqual(consumersFor('state/impulse'), ['state']);
  assert.equal(Object.values(CONSUMERS).flat().includes('goal/proposed'), true);
});

test('unknown event kinds and invalid scopes are rejected before touching the log', () => {
  assert.throws(() => normalizeEvent({ kind: 'not/a-kind', scope: SCOPE, occurredAt: T0 }), /unknown event kind/);
  assert.throws(() => normalizeEvent({ kind: 'goal/proposed', scope: { userId: '' }, occurredAt: T0 }), /trusted userId/);
  assert.throws(() => normalizeEvent({ kind: 'goal/proposed', scope: SCOPE, occurredAt: 0 }), /occurredAt/);
  assert.throws(() => normalizeEvent({ kind: 'goal/proposed', scope: SCOPE, occurredAt: T0, realityStatus: 'pretend' }), /realityStatus/);
});

test('A10/writing gate: a stale generation cannot commit, a stopped runtime commits nothing', () => {
  const db = freshDb({ generation: 'gen-old' });
  const calls = [];
  const handler = handlersFor(calls).goals;
  db.acquireLease({ owner: 'test-owner', generation: 'gen-new', ttlMs: 60000 });
  const event = normalizeEvent({ kind: 'goal/proposed', scope: SCOPE, occurredAt: T0, payload: { title: 'stale' } });
  assert.throws(
    () => applyEvent(db, { consumer: 'goals', event, generation: 'gen-old', apply: handler }),
    error => error instanceof StaleGenerationError || /no longer the writer/.test(error.message),
  );
  assert.equal(receiptCount(db, 'goals'), 0);

  db.setStopped(true, 'operator-stop');
  assert.throws(
    () => applyEvent(db, { consumer: 'goals', event, generation: 'gen-new', apply: handler }),
    error => error instanceof RuntimeStoppedError,
  );
  assert.equal(receiptCount(db, 'goals'), 0);
  db.close();
});

test('A07/A08: a deterministically refused event never enters the log', () => {
  const db = freshDb();
  const rejecting = {
    goals: () => { throw new RuntimeError('invalid-transition', 'proposed → paused is not allowed'); },
  };
  const event = normalizeEvent({ kind: 'goal/paused', scope: SCOPE, occurredAt: T0, payload: { goalId: 'goal-1' } });
  const outcome = dispatchEvent(db, event, { handlers: rejecting, generation: 'gen-test' });
  assert.equal(outcome.inserted, false);
  assert.equal(outcome.rejected, true);
  assert.equal(outcome.results.find(result => result.consumer === 'goals').code, 'invalid-transition');
  assert.equal(eventCount(db, KEY), 0, 'the refused proposal is not stored');
  assert.equal(receiptCount(db, 'goals'), 0);
  assert.equal(db.projection(KEY).version, 0);

  // A transient failure (plain Error) keeps the event for a later retry instead.
  const transient = {
    goals: () => { throw new Error('disk hiccup'); },
  };
  const retryable = normalizeEvent({ kind: 'goal/accepted', scope: SCOPE, occurredAt: T0 + 1, payload: { goalId: 'goal-1' } });
  const kept = dispatchEvent(db, retryable, { handlers: transient, generation: 'gen-test' });
  assert.equal(kept.inserted, true);
  assert.equal(eventCount(db, KEY), 1, 'an unknown failure stays in the log for recovery');
  db.close();
});

test('A08: a failing consumer savepoint rolls back only its own writes (transient failure)', () => {
  const db = freshDb();
  const partial = {
    goals: () => { throw new Error('disk hiccup midway'); },
    'working-memory': ({ slice }) => ({ slice: { applied: Number(slice.applied ?? 0) + 1 } }),
  };
  const event = normalizeEvent({ kind: 'goal/paused', scope: SCOPE, occurredAt: T0, payload: { goalId: 'goal-1' } });
  const outcome = dispatchEvent(db, event, { handlers: partial, generation: 'gen-test' });
  assert.equal(outcome.inserted, true, 'the working-memory consumer applied, so the event is kept for retry');
  assert.equal(outcome.results.find(result => result.consumer === 'goals').applied, false);
  assert.equal(receiptCount(db, 'goals'), 0);
  assert.equal(receiptCount(db, 'working-memory'), 1);
  assert.equal(db.projection(KEY).version, 1, 'only the successful consumer bumped the version');
  db.close();
});

test('A07/B3: a deterministic refusal from the owning consumer vetoes the secondary one', () => {
  const db = freshDb();
  const handlers = {
    goals: () => { throw new RuntimeError('stale-revision', 'goal: expected revision 9, current 2'); },
    'working-memory': ({ slice }) => ({ slice: { applied: Number(slice.applied ?? 0) + 1, focus: 'moved' } }),
  };
  const event = normalizeEvent({ kind: 'goal/accepted', scope: SCOPE, occurredAt: T0, payload: { goalId: 'goal-1', expectedRevision: 9 } });
  const outcome = dispatchEvent(db, event, { handlers, generation: 'gen-test' });
  assert.equal(outcome.rejected, true);
  assert.equal(outcome.inserted, false, 'the refused event never enters the log');
  const working = outcome.results.find(result => result.consumer === 'working-memory');
  assert.equal(working.applied, false);
  assert.equal(working.reason, 'authority-rejected', 'the secondary consumer never runs on a refused goal change');
  assert.equal(receiptCount(db, 'working-memory'), 0);
  assert.equal(db.projection(KEY).version, 0, 'no focus change, no version bump');
  db.close();
});

test('B10: an unsupported envelope version is refused, not silently rewritten', () => {
  assert.throws(
    () => normalizeEvent({ kind: 'state/impulse', scope: SCOPE, occurredAt: T0, schemaVersion: 999, payload: { amount: 0.1 } }),
    /unsupported event schemaVersion 999/,
  );
  const db = freshDb();
  const smuggled = {
    ...normalizeEvent({ kind: 'state/impulse', scope: SCOPE, occurredAt: T0, payload: { amount: 0.1 } }),
    schemaVersion: 999,
  };
  assert.throws(() => appendEvent(db, smuggled, { generation: 'gen-test' }), /unsupported event schemaVersion/);
  assert.throws(() => dispatchEvent(db, smuggled, { handlers: handlersFor([]), generation: 'gen-test' }), /unsupported event schemaVersion/);
  // The reviewer bypassed normalization with a pre-normalized envelope; every
  // non-numeric / non-finite explicit version must be refused on that path too.
  for (const bogus of ['bogus', '1', Number.NaN, Number.POSITIVE_INFINITY, 0, 2, null]) {
    const envelope = { ...normalizeEvent({ kind: 'state/impulse', scope: SCOPE, occurredAt: T0, payload: { amount: 0.1 } }), schemaVersion: bogus };
    if (bogus === null) {
      // An absent version means "current"; only an explicit wrong one is refused.
      assert.equal(dispatchEvent(db, envelope, { handlers: handlersFor([{ type: 'state/impulse', amount: 0.1 }]), generation: 'gen-test' }).rejected, false);
      continue;
    }
    assert.throws(() => dispatchEvent(db, envelope, { handlers: handlersFor([]), generation: 'gen-test' }), /unsupported event schemaVersion/, `schemaVersion ${String(bogus)} must be refused`);
  }
  assert.equal(eventCount(db, KEY), 1, 'only the version-less envelope reached the log');
  db.close();
});

test('events keep log order after late delivery, and seq is monotonic', () => {
  const db = freshDb();
  const handlers = handlersFor([]);
  const late = normalizeEvent({ kind: 'state/impulse', scope: SCOPE, occurredAt: T0 + 5000, payload: { amount: -0.1 } });
  const early = normalizeEvent({ kind: 'state/impulse', scope: SCOPE, occurredAt: T0 + 1000, payload: { amount: 0.1 } });
  dispatchEvent(db, late, { handlers, generation: 'gen-test' });
  dispatchEvent(db, early, { handlers, generation: 'gen-test' });
  const events = listEvents(db, { scopeKey: KEY });
  assert.deepEqual(events.map(event => event.occurredAt), [T0 + 5000, T0 + 1000], 'replay follows recording order, not wall-clock order');
  assert.deepEqual(events.map(event => event.seq), [1, 2], 'seq is strictly increasing');
  // The affect reducer is the one that orders by occurrence time (A09/A02 rules).
  const byTime = [...events].sort((a, b) => a.occurredAt - b.occurredAt).map(event => event.occurredAt);
  assert.deepEqual(byTime, [T0 + 1000, T0 + 5000]);
  db.close();
});
