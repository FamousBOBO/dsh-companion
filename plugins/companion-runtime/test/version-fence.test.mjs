import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mountRuntime } from '../index.mjs';
import { openRuntimeDb } from '../lib/db.mjs';
import { normalizeEvent, applyEvent } from '../lib/events.mjs';

const T0 = Date.UTC(2026, 9, 29, 2, 0, 0);
function buildRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-fence-'));
  for (const dir of ['home/companion', 'home/memory', 'logs']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, 'home/companion/identity.json'), JSON.stringify({
    schemaVersion: 1, persona: 'march7', owner: { id: 'owner-1', displayName: 'o', platform: 'qq' },
    desktop: { mode: 'local-owner', userId: 'owner-1' }, sessions: {},
  }));
  fs.writeFileSync(path.join(root, 'home/companion/memory.config.json'), JSON.stringify({
    schemaVersion: 1, backend: 'sqlite', injection: { budgetChars: 2400 }, extraction: { enabled: false },
    embedding: { provider: 'local', dimensions: 128 }, wiki: { enabled: false },
  }));
  fs.writeFileSync(path.join(root, 'home/companion/runtime.config.json'), JSON.stringify({ enabled: true, mode: 'active', injection: { budgetChars: 320 } }));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });
  return root;
}
const identity = () => ({ resolve: sessionId => ({ userId: sessionId === 'other' ? 'other-user' : 'owner-1', personaId: 'march7', worldId: '', sessionId }) });
const ctx = () => ({ tools: { register() {} }, systemPrompt: { section() {} }, on() {}, get() { return undefined; } });
const memory = { async ingestDomainEvent() { return { status: 'accepted' }; } };

test('public focus/belief mutations reject stale revisions and cross-scope goals', (t) => {
  const root = buildRoot(t);
  const runtime = mountRuntime(ctx(), root, { memory, identity: identity(), now: () => T0 });
  const bound = identity().resolve('s');
  const proposed = runtime.proposeGoal({ bound, sessionId: 's', title: '目标A', nextStep: '第一步' });
  assert.equal(proposed.ok, true);
  const goalId = proposed.results.find(row => row.consumer === 'goals').result.goalId;
  const current = runtime.listGoals({ sessionId: 's' }).goals[0];
  const accepted = runtime.transitionGoal({ sessionId: 's', goalId, to: 'accepted', expectedRevision: current.revision });
  assert.equal(accepted.ok, true);
  const acceptedRevision = runtime.listGoals({ sessionId: 's' }).goals[0].revision;

  const staleSwitch = runtime.switchFocus({ sessionId: 's', goalId, expectedRevision: acceptedRevision - 1 });
  assert.equal(staleSwitch.ok, false);
  assert.equal(staleSwitch.code, 'stale-revision');

  const goodSwitch = runtime.switchFocus({ sessionId: 's', goalId, expectedRevision: acceptedRevision });
  assert.equal(goodSwitch.ok, true);

  const missingGoal = runtime.resumeFocus({ sessionId: 's', goalId: 'goal_missing' });
  assert.equal(missingGoal.ok, false);
  assert.equal(missingGoal.code, 'goal-not-found');

  const otherGoal = runtime.proposeGoal({ bound: identity().resolve('other'), sessionId: 'other', title: '目标B' });
  const otherId = otherGoal.results.find(row => row.consumer === 'goals').result.goalId;
  const crossScope = runtime.switchFocus({ sessionId: 's', goalId: otherId, expectedRevision: 1 });
  assert.equal(crossScope.ok, false);
  assert.equal(crossScope.code, 'goal-not-found');

  const belief = runtime.assertBelief({ sessionId: 's', proposition: '用户住在上海', rootEvidenceIds: ['chat:1'] });
  assert.equal(belief.ok, true);
  const beliefId = belief.results.find(row => row.consumer === 'beliefs').result.beliefId;
  const currentBelief = runtime.listBeliefs({ sessionId: 's' }).beliefs[0];
  const staleCorrect = runtime.correctBelief({ sessionId: 's', beliefId, replacement: '用户住在杭州', byEvidenceId: 'chat:2', expectedRevision: currentBelief.revision - 1 });
  assert.equal(staleCorrect.ok, false);
  assert.equal(staleCorrect.code, 'stale-revision');
  const goodCorrect = runtime.correctBelief({ sessionId: 's', beliefId, replacement: '用户住在杭州', byEvidenceId: 'chat:2', expectedRevision: currentBelief.revision });
  assert.equal(goodCorrect.ok, true);
  const beliefs = runtime.listBeliefs({ sessionId: 's' }).beliefs;
  assert.equal(beliefs.length, 1);
  assert.equal(beliefs[0].proposition, '用户住在杭州');

  const bogusFocus = runtime.recordEvent({ sessionId: 's', kind: 'topic/switch', payload: { goalId: 'goal_missing' } });
  assert.equal(bogusFocus.ok, false);
  const staleDirect = runtime.recordEvent({ sessionId: 's', kind: 'topic/switch', payload: { goalId, expectedRevision: acceptedRevision - 1 } });
  assert.equal(staleDirect.ok, false);
  assert.equal(staleDirect.code, 'stale-revision');
  const whitespaceDirect = runtime.recordEvent({ sessionId: 's', kind: ' topic/switch ', payload: { goalId, expectedRevision: acceptedRevision - 1 } });
  assert.equal(whitespaceDirect.ok, false);
  assert.equal(whitespaceDirect.code, 'stale-revision');
  const missingPayload = runtime.recordEvent({ sessionId: 's', kind: 'topic/switch', payload: {} });
  assert.equal(missingPayload.ok, false);
  assert.equal(missingPayload.code, 'invalid-input');
  const duplicate = runtime.recordEvent({ sessionId: 's', eventId: 'evt-direct-dedupe', kind: 'topic/switch', payload: { goalId, expectedRevision: acceptedRevision } });
  assert.equal(duplicate.ok, true);
  const duplicateAgain = runtime.recordEvent({ sessionId: 's', eventId: 'evt-direct-dedupe', kind: 'topic/switch', payload: { goalId, expectedRevision: acceptedRevision } });
  assert.equal(duplicateAgain.ok, true);
  assert.equal(duplicateAgain.inserted, false);
  const noGoalResume = runtime.recordEvent({ sessionId: 's', kind: 'topic/resume', payload: {} });
  assert.equal(noGoalResume.ok, false);
  assert.equal(noGoalResume.code, 'invalid-input');
  const collision = runtime.recordEvent({ sessionId: 's', eventId: 'evt-direct-dedupe', kind: 'topic/switch', payload: { goalId, expectedRevision: acceptedRevision, note: 'different' } });
  assert.equal(collision.ok, false);
  assert.equal(collision.code, 'conflicting-event');
  const goodDirect = runtime.recordEvent({ sessionId: 's', kind: 'topic/switch', payload: { goalId, expectedRevision: acceptedRevision } });
  assert.equal(goodDirect.ok, true);
  assert.equal(runtime.listBeliefs({ sessionId: 's' }).beliefs[0].proposition, '用户住在杭州');
  runtime.dispose();
});

test('a lease owned by a dead process is reclaimed instead of silently running off', (t) => {
  const root = buildRoot(t);
  const db = openRuntimeDb({ file: path.join(root, 'home/companion/companion-runtime.db') });
  const deadOwner = '999999:dead:test';
  const first = db.acquireLease({ owner: deadOwner, generation: 'gen-dead', ttlMs: 600000 });
  assert.equal(first.ok, true);
  const second = db.acquireLease({ owner: `${process.pid}:live:test`, generation: 'gen-live', ttlMs: 600000 });
  assert.equal(second.ok, true);
  assert.equal(second.generation, 'gen-live');
  db.close();
});

test('envelope accessors are rejected before any getter runs', (t) => {
  const root = buildRoot(t);
  const scope = { userId: 'owner-1', personaId: 'march7', worldId: '' };
  let reads = 0;
  const event = { kind: 'state/impulse', scope, occurredAt: T0 };
  Object.defineProperty(event, 'payload', { get() { reads += 1; return {}; }, enumerable: true });
  assert.throws(() => normalizeEvent(event), /plain data property|non-JSON/);
  assert.equal(reads, 0);
  const db = openRuntimeDb({ file: path.join(root, 'home/companion/companion-runtime.db') });
  db.acquireLease({ owner: `${process.pid}:test:envelope`, generation: 'gen-envelope', ttlMs: 60000 });
  assert.throws(() => applyEvent(db, { consumer: 'working-memory', event }), /plain data property|non-JSON/);
  assert.equal(reads, 0);
  let valueOfReads = 0;
  const instant = { valueOf() { valueOfReads += 1; return T0; } };
  assert.throws(() => normalizeEvent({ kind: 'state/impulse', scope, occurredAt: instant }), /primitive|occurredAt/);
  assert.equal(valueOfReads, 0);
  let rootReads = 0;
  const roots = [];
  Object.defineProperty(roots, '0', { get() { rootReads += 1; return 'x'; }, enumerable: true });
  assert.throws(() => normalizeEvent({ kind: 'state/impulse', scope, occurredAt: T0, rootEvidenceIds: roots }), /plain data property|non-JSON/);
  assert.equal(rootReads, 0);
  assert.throws(() => normalizeEvent({ kind: 'state/impulse', scope, occurredAt: T0, toJSON() {} }), /JSON data|toJSON/);
  assert.throws(() => applyEvent(db, { consumer: 'working-memory', event: { kind: 'topic/switch', scope, occurredAt: T0, payload: { goalId: 'missing', expectedRevision: 'invalid' } } }), /finite number|expectedRevision/);
  assert.throws(() => applyEvent(db, { consumer: 'working-memory', event: { kind: 'topic/resume', scope, occurredAt: T0, payload: { expectedRevision: 'invalid' } } }), /finite number|expectedRevision/);
  db.close();
});

test('payload snapshot rejects toJSON and non-plain values', () => {
  const scope = { userId: 'owner-1', personaId: 'march7', worldId: '' };
  let toJsonReads = 0;
  const getterPayload = { get toJSON() { toJsonReads += 1; return () => ({ evil: true }); } };
  assert.throws(() => normalizeEvent({ kind: 'state/impulse', scope, occurredAt: T0, payload: getterPayload }), /toJSON|non-JSON|plain object/);
  assert.equal(toJsonReads, 0, 'snapshot must not invoke a toJSON getter');
  assert.throws(() => normalizeEvent({ kind: 'state/impulse', scope, occurredAt: T0, payload: { get value() { return 7; } } }), /plain data property|non-JSON/);
  assert.throws(() => normalizeEvent({ kind: 'state/impulse', scope, occurredAt: T0, payload: [Object.defineProperty([], '0', { get() { return 8; }, enumerable: true })] }), /plain data property|non-JSON/);
  assert.throws(() => normalizeEvent({ kind: 'state/impulse', scope, occurredAt: T0, payload: { toJSON() { return { evil: true }; } } }), /toJSON|non-JSON|plain object/);
  assert.throws(() => normalizeEvent({ kind: 'state/impulse', scope, occurredAt: T0, payload: new Date() }), /plain object|toJSON/);
  assert.throws(() => normalizeEvent({ kind: 'state/impulse', scope, occurredAt: T0, payload: { bad: () => 1 } }), /non-JSON/);
  const frozen = normalizeEvent({ kind: 'state/impulse', scope, occurredAt: T0, payload: { b: 2, a: 1 } });
  const again = normalizeEvent(frozen);
  assert.equal(again.payload, frozen.payload, 'the same frozen snapshot is reused at the next boundary');
  assert.equal(Object.isFrozen(frozen.payload), true);
  assert.deepEqual(frozen.payload, { b: 2, a: 1 });
});
