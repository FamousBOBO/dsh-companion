// A02 / A05 / A06 (beliefs half) — CONTRACT.md §4 `lib/beliefs.mjs`.
//
// Acceptance in this file:
//   A02  an original statement quoted / summarised / planned three times keeps one
//        root evidence and one confidence; only genuinely independent roots raise it;
//        recalling again (same root) changes nothing.
//   A05  ten fixed correction cases: the old conclusion is never a current fact, the
//        history stays traceable with evidence ids and revisions, and unrelated
//        beliefs/dependents are preserved.
//   A06  a busy belief expires to `unknown` (never `refuted`, never "free") and a
//        no-reply payload is refused with a stable code without touching any row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openRuntimeDb } from '../lib/db.mjs';
import { normalizeEvent, applyEvent, dispatchEvent, receiptFor } from '../lib/events.mjs';
import { scopeKey } from '../lib/scope.mjs';
import {
  BELIEF_STATUS, confidenceForRoots, applyBeliefEvent, assertBelief, addEvidence,
  correctBelief, expireBeliefs, addDependent, currentBeliefs, beliefHistory,
} from '../lib/beliefs.mjs';

const USER = Object.freeze({ userId: 'owner-1', personaId: 'bot', worldId: '' });
const WORLD_A = Object.freeze({ userId: 'owner-1', personaId: 'bot', worldId: 'world:study' });
const WORLD_B = Object.freeze({ userId: 'owner-1', personaId: 'bot', worldId: 'world:work' });
const T0 = Date.UTC(2026, 9, 29, 2, 0, 0);
const MINUTE = 60_000;
const HOUR = 3_600_000;

function makeWorld(scope = USER) {
  const clock = { t: T0 };
  const db = openRuntimeDb({ file: ':memory:', now: () => clock.t });
  db.acquireLease({ owner: 'beliefs-test', generation: 'gen-beliefs', ttlMs: 600_000 });
  return {
    db,
    scope,
    key: scopeKey(scope),
    now: () => clock.t,
    advance(ms) { clock.t += ms; return clock.t; },
    close() { db.close(); },
  };
}

function currentOf(world, scope = world.scope, extra = {}) {
  return currentBeliefs(world.db, { scopeKey: scopeKey(scope), now: world.now(), ...extra });
}
function propositionsOf(world, scope = world.scope) {
  return currentOf(world, scope).map(item => item.proposition);
}
function rowOf(world, beliefId, scope = world.scope) {
  return world.db.get('SELECT * FROM beliefs WHERE belief_id = ? AND scope = ?', beliefId, scopeKey(scope));
}
function historyOf(world, beliefId) {
  return beliefHistory(world.db, { scopeKey: world.key, beliefId, now: world.now() });
}
function dependentOf(world, dependentId, beliefId) {
  return world.db.get('SELECT * FROM belief_dependents WHERE dependent_id = ? AND belief_id = ?', dependentId, beliefId);
}
function dumpState(world) {
  return {
    beliefs: world.db.all(`SELECT belief_id, status, confidence, roots, independence, valid_until, revision,
        superseded_by, reason FROM beliefs WHERE scope = ? ORDER BY belief_id`, world.key),
    evidence: world.db.all(`SELECT belief_id, evidence_id, root_id, relation, event_id, added_at
        FROM belief_evidence ORDER BY belief_id, evidence_id, relation`),
    dependents: world.db.all(`SELECT dependent_id, belief_id, kind, status
        FROM belief_dependents ORDER BY dependent_id, belief_id`),
  };
}

/** The shared A05 invariant: retracted fact, traceable history, nothing unrelated moved. */
function assertCorrected(world, { oldId, newId, reason, byEvidenceId }) {
  const history = historyOf(world, oldId);
  assert.equal(history.status, 'superseded');
  assert.equal(history.reason, reason, 'the correction reason is preserved');
  assert.equal(history.supersededBy, newId, 'superseded_by points at the replacement');
  assert.ok(history.evidence.some(item => item.evidenceId === byEvidenceId && item.relation === 'refute'),
    'the refuting evidence is kept on the old belief');
  assert.ok(history.roots.length >= 1, 'the original support roots survive the retraction');
  assert.ok(history.revisions.length >= 2, 'the correction appends a revision');
  const last = history.revisions.at(-1);
  assert.equal(last.kind, 'corrected');
  assert.equal(last.byEvidenceId, byEvidenceId);
  assert.equal(last.revision, history.revision);
  const current = currentOf(world);
  assert.equal(current.some(item => item.beliefId === oldId), false, 'the old conclusion is not a current fact');
  if (newId) {
    assert.equal(current.some(item => item.beliefId === newId), true, 'the corrected judgment is the current fact');
    assert.equal(history.successor?.beliefId, newId);
  }
  return history;
}

// ----------------------------------------------------------------------------- A02

test('A02: one statement quoted, summarised and planned three times keeps one root', () => {
  const world = makeWorld();
  try {
    const belief = assertBelief(world.db, {
      scope: USER, proposition: '用户今晚不想聊', rootEvidenceIds: ['msg:orig-1'], source: 'conversation', now: T0,
    });
    assert.equal(belief.confidence, 0.5);
    assert.equal(belief.independence, 1);

    // Three modules each cite the original statement: same root id, new evidence row.
    for (const [index, use] of ['quote', 'summary', 'plan'].entries()) {
      const event = normalizeEvent({
        kind: 'belief/evidence', scope: USER, occurredAt: T0 + (index + 1) * MINUTE,
        payload: { beliefId: belief.beliefId, evidenceId: `use:${use}`, rootId: 'msg:orig-1', relation: 'supports' },
        rootEvidenceIds: ['msg:orig-1'],
      });
      const applied = applyEvent(world.db, { consumer: 'beliefs', event, apply: applyBeliefEvent });
      assert.equal(applied.applied, true);
      assert.equal(applied.result.independence, 1, `${use} must not add independence`);
      assert.equal(applied.result.confidence, 0.5, `${use} must not raise confidence`);
      assert.equal(applied.result.revision, 1, `${use} must not append a revision`);
    }

    const row = rowOf(world, belief.beliefId);
    assert.equal(row.independence, 1);
    assert.equal(row.confidence, 0.5);
    assert.equal(row.revision, 1);
    assert.deepEqual(JSON.parse(row.roots), ['msg:orig-1']);

    const citedRoots = world.db.all(
      "SELECT DISTINCT root_id FROM belief_evidence WHERE belief_id = ? AND relation = 'support'", belief.beliefId);
    assert.deepEqual(citedRoots.map(item => item.root_id), ['msg:orig-1'], 'three citations, still one root');

    // A second module restating the same thing is still one root, not two beliefs' worth.
    const summary = assertBelief(world.db, {
      scope: USER, proposition: '用户今晚状态不好', rootEvidenceIds: ['msg:orig-1'], now: T0 + 4 * MINUTE,
    });
    assert.equal(summary.independence, 1);
    assert.equal(summary.confidence, 0.5);
    assert.equal(currentOf(world).length, 2);
  } finally { world.close(); }
});

test('A02: independent roots raise confidence to a cap; recalling again changes nothing', () => {
  const ladder = [0, 1, 2, 3, 7].map(count =>
    confidenceForRoots(Array.from({ length: count }, (_, index) => `mem:${index}`)));
  assert.deepEqual(ladder, [0, 0.5, 0.75, 0.9, 0.9], 'frozen monotone ladder, capped at three roots');
  assert.equal(confidenceForRoots(['mem:1', 'mem:1', 'mem:1']), 0.5, 'repetition is one root');
  assert.equal(confidenceForRoots(new Set(['mem:1', 'mem:2'])), 0.75);
  assert.equal(confidenceForRoots([]), 0);

  const world = makeWorld();
  try {
    const belief = assertBelief(world.db, {
      scope: USER, proposition: '用户周末想爬山', rootEvidenceIds: ['mem:1'], now: T0,
    });
    assert.equal(belief.independence, 1);
    assert.equal(belief.confidence, 0.5);

    const steps = [];
    for (const [index, root] of ['mem:2', 'mem:3', 'mem:4'].entries()) {
      const outcome = addEvidence(world.db, {
        scope: USER, beliefId: belief.beliefId, evidenceId: `recall:${root}`, rootId: root,
        relation: 'supports', now: T0 + (index + 1) * MINUTE,
      });
      steps.push(outcome);
    }
    assert.deepEqual(steps.map(item => item.confidence), [0.75, 0.9, 0.9], 'three independent roots raise, then cap');
    assert.deepEqual(steps.map(item => item.independence), [2, 3, 4], 'independence is stored explicitly');

    const before = rowOf(world, belief.beliefId);
    const recall = addEvidence(world.db, {
      scope: USER, beliefId: belief.beliefId, evidenceId: 'recall:again', rootId: 'mem:1', now: T0 + 5 * MINUTE,
    });
    assert.equal(recall.added, false);
    assert.equal(recall.confidence, Number(before.confidence));
    assert.equal(recall.independence, Number(before.independence));
    assert.equal(recall.revision, Number(before.revision));

    const reassert = assertBelief(world.db, {
      scope: USER, proposition: '用户周末想爬山', rootEvidenceIds: ['mem:1'], now: T0 + 6 * MINUTE,
    });
    assert.equal(reassert.created, false);
    assert.equal(reassert.confidence, Number(before.confidence));
    assert.equal(reassert.independence, Number(before.independence));
    assert.equal(reassert.revision, Number(before.revision));
  } finally { world.close(); }
});

// ----------------------------------------------------------------------------- B6
// Review finding B6: the evidence ledger and the root counter must never diverge.
// `evidenceId -> rootId` is an immutable mapping; the counter is recomputed only from
// the rows `belief_evidence` actually holds.

test('B6: an existing evidenceId cannot be re-pointed at a conflicting root', () => {
  const world = makeWorld();
  try {
    const belief = assertBelief(world.db, {
      scope: USER, proposition: '用户周末想爬山', rootEvidenceIds: ['mem:1'], now: T0,
    });
    assert.equal(belief.confidence, 0.5);
    assert.equal(belief.independence, 1);

    const first = addEvidence(world.db, {
      scope: USER, beliefId: belief.beliefId, evidenceId: 'recall:1', rootId: 'mem:2',
      relation: 'supports', now: T0 + MINUTE,
    });
    assert.equal(first.confidence, 0.75);
    assert.equal(first.independence, 2);
    assert.equal(first.revision, 2);
    const before = dumpState(world);

    // Same evidenceId, different root: refused, not merged into the counter.
    assert.throws(
      () => addEvidence(world.db, {
        scope: USER, beliefId: belief.beliefId, evidenceId: 'recall:1', rootId: 'mem:3',
        relation: 'supports', now: T0 + 2 * MINUTE,
      }),
      error => error?.code === 'evidence-root-conflict',
      'a re-pointed root must be a deterministic rejection',
    );
    // Same evidenceId, different relation: the mapping (root *and* relation) is frozen.
    assert.throws(
      () => addEvidence(world.db, {
        scope: USER, beliefId: belief.beliefId, evidenceId: 'recall:1', rootId: 'mem:2',
        relation: 'refutes', now: T0 + 2 * MINUTE,
      }),
      error => error?.code === 'evidence-root-conflict',
    );

    assert.deepEqual(dumpState(world), before, 'a rejected conflict leaves no trace');
    const row = rowOf(world, belief.beliefId);
    assert.equal(row.status, 'supported');
    assert.equal(row.confidence, 0.75, 'the counter did not move');
    assert.equal(row.independence, 2);
    assert.equal(row.revision, 2, 'no revision was appended for a rejected conflict');
    assert.deepEqual(JSON.parse(row.roots), ['mem:1', 'mem:2']);
    const persisted = world.db.get(
      'SELECT root_id FROM belief_evidence WHERE belief_id = ? AND evidence_id = ?', belief.beliefId, 'recall:1');
    assert.equal(persisted.root_id, 'mem:2', 'the persisted evidence still points at its original root');
  } finally { world.close(); }
});

test('B6: re-sending the same evidenceId with the same root is idempotent', () => {
  const world = makeWorld();
  try {
    const belief = assertBelief(world.db, {
      scope: USER, proposition: '用户周末想爬山', rootEvidenceIds: ['mem:1'], now: T0,
    });
    const first = addEvidence(world.db, {
      scope: USER, beliefId: belief.beliefId, evidenceId: 'recall:1', rootId: 'mem:2',
      relation: 'supports', now: T0 + MINUTE,
    });
    assert.equal(first.added, true);
    assert.equal(first.confidence, 0.75);
    const before = dumpState(world);
    const historyBefore = historyOf(world, belief.beliefId);

    const replay = addEvidence(world.db, {
      scope: USER, beliefId: belief.beliefId, evidenceId: 'recall:1', rootId: 'mem:2',
      relation: 'supports', now: T0 + 2 * MINUTE,
    });
    assert.equal(replay.added, false, 'the same mapping is not new evidence');
    assert.equal(replay.confidence, first.confidence);
    assert.equal(replay.independence, first.independence);
    assert.equal(replay.revision, first.revision, 'a replay appends no revision');
    assert.deepEqual(dumpState(world), before, 'a replay rewrites no row (added_at included)');
    assert.deepEqual(historyOf(world, belief.beliefId).evidence, historyBefore.evidence);
  } finally { world.close(); }
});

test('B6: the 1/2/3 independent-root ladder still yields 0.5 / 0.75 / 0.9', () => {
  const world = makeWorld();
  try {
    const belief = assertBelief(world.db, {
      scope: USER, proposition: '用户周末想爬山', rootEvidenceIds: ['mem:1'], now: T0,
    });
    assert.deepEqual([belief.independence, belief.confidence], [1, 0.5]);

    const observed = [];
    for (const [index, root] of ['mem:2', 'mem:3', 'mem:4'].entries()) {
      const outcome = addEvidence(world.db, {
        scope: USER, beliefId: belief.beliefId, evidenceId: `recall:${root}`, rootId: root,
        relation: 'supports', now: T0 + (index + 1) * MINUTE,
      });
      const row = rowOf(world, belief.beliefId);
      observed.push({ independence: outcome.independence, confidence: outcome.confidence, roots: JSON.parse(row.roots) });
    }
    assert.deepEqual(observed.map(item => item.confidence), [0.75, 0.9, 0.9], 'frozen ladder, capped at three roots');
    assert.deepEqual(observed.map(item => item.independence), [2, 3, 4], 'independence counts every distinct root');
    assert.deepEqual(observed.map(item => item.roots.length), [2, 3, 4]);
    assert.deepEqual(observed.at(-1).roots, ['mem:1', 'mem:2', 'mem:3', 'mem:4']);

    // Quoting a known root under a fresh evidence id is still one root.
    const recitation = addEvidence(world.db, {
      scope: USER, beliefId: belief.beliefId, evidenceId: 'quote:mem:2', rootId: 'mem:2',
      relation: 'corroborates', now: T0 + 5 * MINUTE,
    });
    assert.equal(recitation.added, false);
    assert.equal(recitation.confidence, 0.9);
    assert.equal(recitation.independence, 4);
    assert.equal(Number(rowOf(world, belief.beliefId).revision), 4, 'asserted + three roots, no extra revision');

    const tampered = rowOf(world, belief.beliefId);
    assert.equal(tampered.independence, JSON.parse(tampered.roots).length,
      'the stored counter matches the roots it claims');
  } finally { world.close(); }
});

test('B6: the counter is rebuilt from the ledger, not from caller input or drift', () => {
  const world = makeWorld();
  try {
    const belief = assertBelief(world.db, {
      scope: USER, proposition: '用户周末想爬山', rootEvidenceIds: ['mem:1'], now: T0,
    });
    // Simulate a counter that drifted away from the ledger (older build / manual edit).
    world.db.run('UPDATE beliefs SET roots = ?, independence = 3, confidence = 0.9 WHERE belief_id = ? AND scope = ?',
      JSON.stringify(['mem:1', 'ghost:a', 'ghost:b']), belief.beliefId, world.key);
    assert.equal(Number(rowOf(world, belief.beliefId).confidence), 0.9);

    const outcome = addEvidence(world.db, {
      scope: USER, beliefId: belief.beliefId, evidenceId: 'recall:2', rootId: 'mem:2',
      relation: 'supports', now: T0 + MINUTE,
    });
    const row = rowOf(world, belief.beliefId);
    assert.deepEqual(JSON.parse(row.roots), ['mem:1', 'mem:2'], 'only roots with accepted evidence rows count');
    assert.equal(row.independence, 2);
    assert.equal(outcome.confidence, 0.75, 'confidence follows the ledger, never the drifted counter');
    assert.equal(outcome.revision, 2);
    const supportRows = world.db.all(
      "SELECT root_id FROM belief_evidence WHERE belief_id = ? AND relation = 'support' ORDER BY root_id", belief.beliefId);
    assert.deepEqual(supportRows.map(item => item.root_id), ['mem:1', 'mem:2']);
  } finally { world.close(); }
});

test('B6: the assert path also obeys the evidence -> root mapping and the ledger', () => {
  const world = makeWorld();
  try {
    const belief = assertBelief(world.db, { scope: USER, proposition: '他周末通常在家', rootEvidenceIds: ['root1'], now: T0 });
    assert.equal(belief.confidence, 0.5);
    // Reviewer repro: bind evidenceId root2 to root1, then assert root2.
    addEvidence(world.db, { scope: USER, beliefId: belief.beliefId, evidenceId: 'root2', rootId: 'root1', relation: 'support', now: T0 + MINUTE });
    const before = rowOf(world, belief.beliefId);
    assert.throws(
      () => assertBelief(world.db, { scope: USER, proposition: '他周末通常在家', rootEvidenceIds: ['root2'], now: T0 + 2 * MINUTE }),
      error => error?.code === 'evidence-root-conflict',
      'the assert path must refuse a re-pointed evidence id too',
    );
    const after = rowOf(world, belief.beliefId);
    assert.equal(Number(after.confidence), Number(before.confidence), 'a refused assert cannot raise confidence');
    assert.equal(after.independence, before.independence);
    assert.equal(after.revision, before.revision);
    assert.deepEqual(JSON.parse(after.roots), ['root1']);
  } finally { world.close(); }
});

test('B6: a conflicting root through dispatchEvent leaves no receipt and no state change', () => {
  const world = makeWorld();
  try {
    const belief = assertBelief(world.db, {
      scope: USER, proposition: '用户在赶方案', rootEvidenceIds: ['mem:1'], now: T0,
    });
    addEvidence(world.db, {
      scope: USER, beliefId: belief.beliefId, evidenceId: 'recall:1', rootId: 'mem:2',
      relation: 'supports', now: T0 + MINUTE,
    });
    const before = dumpState(world);

    const event = normalizeEvent({
      kind: 'belief/evidence', scope: USER, occurredAt: T0 + 2 * MINUTE,
      payload: { beliefId: belief.beliefId, evidenceId: 'recall:1', rootId: 'mem:3', relation: 'supports' },
      rootEvidenceIds: ['mem:3'],
    });
    const outcome = dispatchEvent(world.db, event, {
      handlers: { beliefs: applyBeliefEvent }, generation: 'gen-beliefs',
    });
    assert.equal(outcome.inserted, false);
    assert.equal(outcome.rejected, true);
    const result = outcome.results.find(item => item.consumer === 'beliefs');
    assert.equal(result.applied, false);
    assert.equal(result.code, 'evidence-root-conflict');
    assert.equal(result.deterministic, true, 'a typed rejection, so the event is not kept for replay');
    assert.equal(receiptFor(world.db, 'beliefs', event.eventId), null, 'no receipt');
    assert.equal(
      world.db.get('SELECT COUNT(*) AS n FROM domain_events WHERE event_id = ?', event.eventId).n, 0,
      'the refused event never enters the log',
    );
    assert.deepEqual(dumpState(world), before, 'confidence/independence/revision/ledger all unchanged');
  } finally { world.close(); }
});

// ----------------------------------------------------------------------------- A05

test('A05-01: "先这样吧" read as disinterest is corrected to "just busy today"', () => {
  const world = makeWorld();
  try {
    const wrong = assertBelief(world.db, {
      scope: USER, proposition: '用户不想聊了', rootEvidenceIds: ['msg:1'], validUntil: T0 + 2 * HOUR, now: T0,
    });
    addDependent(world.db, { scope: USER, dependentId: 'derived:stop-messaging', beliefIds: [wrong.beliefId], now: T0 });
    const correction = correctBelief(world.db, {
      scope: USER, beliefId: wrong.beliefId, byEvidenceId: 'msg:2',
      reason: '用户解释只是今天忙', replacement: '用户只是今天忙', now: T0 + HOUR,
    });
    assert.equal(correction.code, 'corrected');
    assert.equal(correction.invalidatedDependents, 1);
    const history = assertCorrected(world, {
      oldId: wrong.beliefId, newId: correction.replacementId, reason: '用户解释只是今天忙', byEvidenceId: 'msg:2',
    });
    assert.equal(history.corrections.at(-1).reason, '用户解释只是今天忙');
    assert.equal(dependentOf(world, 'derived:stop-messaging', wrong.beliefId).status, 'invalid');
    assert.equal(Number(rowOf(world, correction.replacementId).confidence), 0.5, 'the new fact rests on the correction only');
    assert.deepEqual(propositionsOf(world), ['用户只是今天忙']);
  } finally { world.close(); }
});

test('A05-02: a conclusion built on a wrong premise is retired, unrelated facts stay', () => {
  const world = makeWorld();
  try {
    const wrong = assertBelief(world.db, { scope: USER, proposition: '用户下周要出差', rootEvidenceIds: ['doc:stale-plan'], now: T0 });
    const unrelated = assertBelief(world.db, { scope: USER, proposition: '用户养了一只猫', rootEvidenceIds: ['msg:9'], now: T0 });
    const correction = correctBelief(world.db, {
      scope: USER, beliefId: wrong.beliefId, byEvidenceId: 'msg:3',
      reason: '之前那份计划作废了', replacement: '用户下周不用出差', now: T0 + MINUTE,
    });
    assertCorrected(world, {
      oldId: wrong.beliefId, newId: correction.replacementId, reason: '之前那份计划作废了', byEvidenceId: 'msg:3',
    });
    const kept = rowOf(world, unrelated.beliefId);
    assert.equal(kept.status, 'supported');
    assert.equal(Number(kept.revision), 1);
    assert.equal(Number(kept.confidence), 0.5);
  } finally { world.close(); }
});

test('A05-03: a corrected preference replaces the old preference', () => {
  const world = makeWorld();
  try {
    const wrong = assertBelief(world.db, { scope: USER, proposition: '用户不喜欢咖啡', rootEvidenceIds: ['msg:4'], now: T0 });
    const correction = correctBelief(world.db, {
      scope: USER, beliefId: wrong.beliefId, byEvidenceId: 'msg:5',
      reason: '用户纠正：其实喜欢咖啡', replacement: '用户其实喜欢咖啡', now: T0 + MINUTE,
    });
    assertCorrected(world, {
      oldId: wrong.beliefId, newId: correction.replacementId, reason: '用户纠正：其实喜欢咖啡', byEvidenceId: 'msg:5',
    });
    assert.deepEqual(propositionsOf(world), ['用户其实喜欢咖啡']);
  } finally { world.close(); }
});

test('A05-04: a corrected deadline keeps the old evidence but stops being current', () => {
  const world = makeWorld();
  try {
    const wrong = assertBelief(world.db, {
      scope: USER, proposition: '汇报截止周五', rootEvidenceIds: ['msg:6'], validUntil: T0 + 48 * HOUR, now: T0,
    });
    const correction = correctBelief(world.db, {
      scope: USER, beliefId: wrong.beliefId, byEvidenceId: 'msg:7', reason: '用户说截止时间改了',
      replacement: { proposition: '汇报截止下周二', validUntil: T0 + 120 * HOUR }, now: T0 + MINUTE,
    });
    const history = assertCorrected(world, {
      oldId: wrong.beliefId, newId: correction.replacementId, reason: '用户说截止时间改了', byEvidenceId: 'msg:7',
    });
    assert.equal(history.validUntil, T0 + 48 * HOUR, 'the retired deadline is preserved verbatim');
    const replacement = rowOf(world, correction.replacementId);
    assert.equal(Number(replacement.valid_until), T0 + 120 * HOUR);
    assert.equal(replacement.status, 'supported');
    assert.deepEqual(propositionsOf(world), ['汇报截止下周二']);
  } finally { world.close(); }
});

test('A05-05: only the dependents of the corrected belief are invalidated', () => {
  const world = makeWorld();
  try {
    const study = assertBelief(world.db, { scope: USER, proposition: '用户在准备考试', rootEvidenceIds: ['msg:10'], now: T0 });
    const cat = assertBelief(world.db, { scope: USER, proposition: '用户养了一只猫', rootEvidenceIds: ['msg:11'], now: T0 });
    addDependent(world.db, { scope: USER, dependentId: 'derived:study-plan', beliefIds: [study.beliefId], kind: 'inference', now: T0 });
    addDependent(world.db, { scope: USER, dependentId: 'derived:cat-care', beliefIds: [cat.beliefId], kind: 'inference', now: T0 });
    addDependent(world.db, { scope: USER, dependentId: 'derived:shared-plan', beliefIds: [study.beliefId, cat.beliefId], kind: 'plan', now: T0 });

    const correction = correctBelief(world.db, {
      scope: USER, beliefId: study.beliefId, byEvidenceId: 'msg:12', reason: '用户说考试已经结束', replacement: '用户考试已经结束',
      now: T0 + MINUTE,
    });
    assert.equal(correction.invalidatedDependents, 2, 'only the two rows resting on this belief moved');
    assertCorrected(world, {
      oldId: study.beliefId, newId: correction.replacementId, reason: '用户说考试已经结束', byEvidenceId: 'msg:12',
    });
    assert.equal(dependentOf(world, 'derived:study-plan', study.beliefId).status, 'invalid');
    assert.equal(dependentOf(world, 'derived:cat-care', cat.beliefId).status, 'current');
    assert.equal(dependentOf(world, 'derived:shared-plan', study.beliefId).status, 'invalid');
    assert.equal(dependentOf(world, 'derived:shared-plan', cat.beliefId).status, 'current', 'the unrelated half of a shared inference survives');
    const kept = rowOf(world, cat.beliefId);
    assert.equal(kept.status, 'supported');
    assert.equal(Number(kept.revision), 1);
  } finally { world.close(); }
});

test('A05-06: a retracted consent stops being a current fact', () => {
  const world = makeWorld();
  try {
    const consent = assertBelief(world.db, { scope: USER, proposition: '用户同意上午提醒他', rootEvidenceIds: ['msg:13'], now: T0 });
    const correction = correctBelief(world.db, {
      scope: USER, beliefId: consent.beliefId, byEvidenceId: 'msg:14',
      reason: '用户撤回了提醒同意', replacement: '用户撤回了提醒同意', now: T0 + MINUTE,
    });
    assertCorrected(world, {
      oldId: consent.beliefId, newId: correction.replacementId, reason: '用户撤回了提醒同意', byEvidenceId: 'msg:14',
    });
    assert.equal(rowOf(world, consent.beliefId).status, 'superseded');
    assert.deepEqual(propositionsOf(world), ['用户撤回了提醒同意']);
  } finally { world.close(); }
});

test('A05-07: a factual correction replaces the wrong detail', () => {
  const world = makeWorld();
  try {
    const wrong = assertBelief(world.db, { scope: USER, proposition: '会议在下午三点', rootEvidenceIds: ['msg:15'], now: T0 });
    const correction = correctBelief(world.db, {
      scope: USER, beliefId: wrong.beliefId, byEvidenceId: 'msg:16',
      reason: '用户说会议改到四点了', replacement: '会议在下午四点', now: T0 + MINUTE,
    });
    assertCorrected(world, {
      oldId: wrong.beliefId, newId: correction.replacementId, reason: '用户说会议改到四点了', byEvidenceId: 'msg:16',
    });
    assert.equal(JSON.stringify(currentOf(world)).includes('三点'), false, 'the wrong detail is gone from the current view');
    assert.equal(historyOf(world, wrong.beliefId).proposition, '会议在下午三点', 'but the history still quotes it');
  } finally { world.close(); }
});

test('A05-08: a world-scoped correction never leaks into another world', () => {
  const world = makeWorld(WORLD_A);
  try {
    const inA = assertBelief(world.db, { scope: WORLD_A, proposition: '用户今天很忙', rootEvidenceIds: ['msg:20'], now: T0 });
    const inB = assertBelief(world.db, { scope: WORLD_B, proposition: '用户今天很忙', rootEvidenceIds: ['msg:21'], now: T0 });
    assert.notEqual(inA.beliefId, inB.beliefId, 'the same words in two worlds are two beliefs');
    addDependent(world.db, { scope: WORLD_A, dependentId: 'derived:hold-reply', beliefIds: [inA.beliefId], now: T0 });
    addDependent(world.db, { scope: WORLD_B, dependentId: 'derived:hold-reply', beliefIds: [inB.beliefId], now: T0 });

    const before = rowOf(world, inB.beliefId, WORLD_B);
    const correction = correctBelief(world.db, {
      scope: WORLD_A, beliefId: inA.beliefId, byEvidenceId: 'msg:22',
      reason: '这个世界里用户说不忙', replacement: '用户今天不忙', now: T0 + MINUTE,
    });
    assertCorrected(world, {
      oldId: inA.beliefId, newId: correction.replacementId, reason: '这个世界里用户说不忙', byEvidenceId: 'msg:22',
    });
    assert.deepEqual(rowOf(world, inB.beliefId, WORLD_B), before, 'the other world is untouched');
    assert.deepEqual(propositionsOf(world, WORLD_B), ['用户今天很忙']);
    assert.equal(dependentOf(world, 'derived:hold-reply', inB.beliefId).status, 'current');
    assert.equal(dependentOf(world, 'derived:hold-reply', inA.beliefId).status, 'invalid');
  } finally { world.close(); }
});

test('A05-09: a belief corrected twice keeps both retractions traceable', () => {
  const world = makeWorld();
  try {
    const first = assertBelief(world.db, { scope: USER, proposition: '用户在医院工作', rootEvidenceIds: ['msg:30'], now: T0 });
    const second = correctBelief(world.db, {
      scope: USER, beliefId: first.beliefId, byEvidenceId: 'msg:31', reason: '用户说是在诊所工作',
      replacement: '用户在诊所工作', now: T0 + MINUTE,
    });
    assertCorrected(world, {
      oldId: first.beliefId, newId: second.replacementId, reason: '用户说是在诊所工作', byEvidenceId: 'msg:31',
    });

    const third = correctBelief(world.db, {
      scope: USER, beliefId: second.replacementId, byEvidenceId: 'msg:32', reason: '用户说已经离职了',
      replacement: '用户已经离职', now: T0 + 2 * MINUTE,
    });
    assertCorrected(world, {
      oldId: second.replacementId, newId: third.replacementId, reason: '用户说已经离职了', byEvidenceId: 'msg:32',
    });
    assert.deepEqual(propositionsOf(world), ['用户已经离职']);

    // The first retraction stays readable even though its own successor was retired too.
    const oldest = historyOf(world, first.beliefId);
    assert.equal(oldest.reason, '用户说是在诊所工作');
    assert.equal(oldest.successor.beliefId, second.replacementId);
    assert.equal(oldest.successor.status, 'superseded');

    const chain = historyOf(world, third.replacementId);
    assert.deepEqual(chain.predecessors.map(item => item.beliefId), [second.replacementId]);
    const middle = historyOf(world, second.replacementId);
    assert.deepEqual(middle.predecessors.map(item => item.beliefId), [first.beliefId]);
    assert.equal(middle.reason, '用户说已经离职了');
    assert.equal(middle.predecessors[0].reason, '用户说是在诊所工作', 'each retraction keeps its own reason');
    assert.equal(historyOf(world, first.beliefId).corrections.length, 1);
  } finally { world.close(); }
});

test('A05: a retired belief is never re-corrected into a twin current fact', () => {
  const world = makeWorld();
  try {
    const original = assertBelief(world.db, { scope: USER, proposition: '用户在学钢琴', rootEvidenceIds: ['msg:90'], now: T0 });
    const first = correctBelief(world.db, {
      scope: USER, beliefId: original.beliefId, byEvidenceId: 'msg:91', reason: '其实是吉他',
      replacement: '用户在学吉他', now: T0 + MINUTE,
    });
    assert.throws(
      () => correctBelief(world.db, {
        scope: USER, beliefId: original.beliefId, byEvidenceId: 'msg:92', reason: '其实是贝斯',
        replacement: '用户在学贝斯', now: T0 + 2 * MINUTE,
      }),
      error => error?.code === 'already-superseded',
      'the successor is the belief that may still be corrected',
    );
    // The very same correction replayed is a no-op, not a failure.
    const replay = correctBelief(world.db, {
      scope: USER, beliefId: original.beliefId, byEvidenceId: 'msg:91', reason: '其实是吉他',
      replacement: '用户在学吉他', now: T0 + 3 * MINUTE,
    });
    assert.equal(replay.code, 'already-superseded');
    assert.equal(replay.revision, first.revision);
    assert.deepEqual(propositionsOf(world), ['用户在学吉他']);
  } finally { world.close(); }
});

test('A05-10: correcting an already expired belief still retracts it cleanly', () => {
  const world = makeWorld();
  try {
    const busy = assertBelief(world.db, {
      scope: USER, proposition: '用户今天下午有空', rootEvidenceIds: ['msg:40', 'msg:41'], validUntil: T0 + HOUR, now: T0,
    });
    assert.equal(busy.confidence, 0.75);
    world.advance(2 * HOUR);
    assert.equal(expireBeliefs(world.db, { scope: USER, now: world.now() }).expired, 1);
    assert.equal(rowOf(world, busy.beliefId).status, 'unknown');

    const correction = correctBelief(world.db, {
      scope: USER, beliefId: busy.beliefId, byEvidenceId: 'msg:42',
      reason: '用户其实已经约了人', replacement: '用户今天已有约', now: world.now(),
    });
    const history = assertCorrected(world, {
      oldId: busy.beliefId, newId: correction.replacementId, reason: '用户其实已经约了人', byEvidenceId: 'msg:42',
    });
    assert.equal(history.expired, true, 'the lapsed validity window is preserved');
    assert.equal(history.validUntil, T0 + HOUR);
    assert.ok(history.evidence.some(item => item.evidenceId === 'msg:40' && item.relation === 'support'));
    assert.ok(history.evidence.some(item => item.evidenceId === 'msg:41' && item.relation === 'support'));
    assert.equal(propositionsOf(world).includes('用户今天下午有空'), false);
  } finally { world.close(); }
});

// ----------------------------------------------------------------------------- A06

test('A06: a busy belief expires to unknown — never refuted, never "free"', () => {
  const world = makeWorld();
  try {
    const busy = assertBelief(world.db, {
      scope: USER, proposition: '用户今天很忙', rootEvidenceIds: ['msg:50', 'msg:51'], validUntil: T0 + HOUR, now: T0,
    });
    assert.equal(busy.confidence, 0.75);
    assert.equal(busy.independence, 2);
    addDependent(world.db, { scope: USER, dependentId: 'derived:hold-reply', beliefIds: [busy.beliefId], now: T0 });
    const before = rowOf(world, busy.beliefId);

    world.advance(2 * HOUR);
    const expiry = expireBeliefs(world.db, { scope: USER, now: world.now() });
    assert.equal(expiry.expired, 1);
    assert.deepEqual(expiry.beliefIds, [busy.beliefId]);

    const after = rowOf(world, busy.beliefId);
    assert.equal(after.status, 'unknown');
    assert.notEqual(after.status, 'refuted');
    assert.equal(after.confidence, before.confidence, 'expiry never lowers trust');
    assert.equal(after.independence, before.independence);
    assert.equal(after.revision, before.revision, 'expiry is derived from time, not a new judgment');
    assert.deepEqual(JSON.parse(after.roots), ['msg:50', 'msg:51']);
    assert.equal(after.superseded_by, '');

    const statuses = world.db.all('SELECT DISTINCT status FROM beliefs').map(item => item.status);
    assert.deepEqual(statuses, ['unknown']);
    assert.ok(statuses.every(status => BELIEF_STATUS.includes(status)));

    assert.equal(currentOf(world).length, 0, 'an expired belief is never a current fact');
    const withExpired = currentOf(world, world.scope, { includeExpired: true });
    assert.equal(withExpired.length, 1);
    assert.equal(withExpired[0].status, 'unknown');
    assert.equal(withExpired[0].confidence, 0.75);
    assert.equal(withExpired[0].expired, true);
    const serialized = JSON.stringify(withExpired).toLowerCase();
    for (const forbidden of ['free', 'available', 'rejected', '空闲', '拒绝']) {
      assert.equal(serialized.includes(forbidden), false, `expiry must not infer ${forbidden}`);
    }

    const history = historyOf(world, busy.beliefId);
    assert.equal(history.status, 'unknown');
    assert.equal(history.expired, true);
    assert.equal(history.evidence.filter(item => item.relation === 'support').length, 2, 'evidence survives expiry');
    assert.equal(history.reason, '', 'no correction reason was invented');
    assert.equal(dependentOf(world, 'derived:hold-reply', busy.beliefId).status, 'current', 'expiry is not a retraction');
    assert.equal(expireBeliefs(world.db, { scope: USER, now: world.now() }).expired, 0, 'expiry is idempotent');
  } finally { world.close(); }
});

test('A06: a no-reply payload is refused with a stable code and changes nothing', () => {
  const world = makeWorld();
  try {
    const belief = assertBelief(world.db, { scope: USER, proposition: '用户在忙', rootEvidenceIds: ['msg:60'], now: T0 });
    const before = dumpState(world);

    for (const basis of ['silence', 'no-reply']) {
      for (const kind of ['belief/asserted', 'belief/evidence', 'belief/corrected', 'belief/expired']) {
        const event = normalizeEvent({
          kind, scope: USER, occurredAt: T0 + 5 * MINUTE,
          payload: {
            basis, proposition: '用户不想理我', beliefId: belief.beliefId,
            evidenceId: 'msg:61', byEvidenceId: 'msg:62', reason: '沉默',
          },
        });
        assert.throws(
          () => applyBeliefEvent({ db: world.db, event, slice: {}, now: T0 + 5 * MINUTE }),
          error => error?.code === 'silence-not-evidence',
          `${kind} with basis=${basis} must be refused`,
        );
      }
    }
    assert.deepEqual(dumpState(world), before, 'silence never creates or edits a belief');

    // Through the real fan-out: a deterministic refusal rolls the append back, so the
    // refused event never enters the log (no poisoned replay), no receipt and no row.
    const event = normalizeEvent({
      kind: 'belief/evidence', scope: USER, occurredAt: T0 + 6 * MINUTE,
      payload: { basis: 'no-reply', beliefId: belief.beliefId, evidenceId: 'msg:63' },
    });
    const outcome = dispatchEvent(world.db, event, { handlers: { beliefs: applyBeliefEvent }, generation: 'gen-beliefs' });
    assert.equal(outcome.inserted, false);
    assert.equal(outcome.rejected, true);
    const result = outcome.results.find(item => item.consumer === 'beliefs');
    assert.equal(result.applied, false);
    assert.equal(result.code, 'silence-not-evidence');
    assert.equal(receiptFor(world.db, 'beliefs', event.eventId), null);
    assert.equal(world.db.get('SELECT COUNT(*) AS n FROM domain_events WHERE event_id = ?', event.eventId).n, 0,
      'a deterministically refused event is not kept for replay');
    assert.deepEqual(dumpState(world), before);
    assert.equal(Number(rowOf(world, belief.beliefId).revision), 1, 'no revision was appended for silence');
  } finally { world.close(); }
});

// ------------------------------------------------------- reducer wiring & history

test('the reducer is idempotent: the same event applied twice changes nothing', () => {
  const world = makeWorld();
  try {
    const applyTwice = input => {
      const event = normalizeEvent({ scope: USER, occurredAt: T0, ...input });
      const first = applyBeliefEvent({ db: world.db, event, slice: {}, now: event.occurredAt });
      const afterFirst = dumpState(world);
      const second = applyBeliefEvent({ db: world.db, event, slice: first.slice, now: event.occurredAt + HOUR });
      assert.deepEqual(dumpState(world), afterFirst, `a second application of ${event.kind} changed state`);
      assert.deepEqual(second.slice, first.slice, `the ${event.kind} slice is stable`);
      return first.result;
    };

    const asserted = applyTwice({
      kind: 'belief/asserted',
      payload: { proposition: '用户在赶方案', roots: ['msg:70'], validUntil: T0 + 30 * MINUTE },
    });
    const beliefId = asserted.beliefId;
    applyTwice({ kind: 'belief/evidence', payload: { beliefId, evidenceId: 'msg:71', rootId: 'msg:71', relation: 'supports' } });
    applyTwice({ kind: 'belief/expired', occurredAt: T0 + HOUR, payload: { at: T0 + HOUR } });
    applyTwice({
      kind: 'belief/corrected', occurredAt: T0 + 2 * HOUR,
      payload: { beliefId, byEvidenceId: 'msg:72', reason: '用户说方案已经交了', replacement: '用户方案已交' },
    });

    assert.equal(Number(rowOf(world, beliefId).revision), 3, 'revision: asserted -> evidence -> corrected');
    assert.equal(rowOf(world, beliefId).status, 'superseded');
    assert.equal(rowOf(world, beliefId).reason, '用户说方案已经交了');
  } finally { world.close(); }
});

test('the reducer ignores kinds it does not own', () => {
  const world = makeWorld();
  try {
    const event = normalizeEvent({ kind: 'state/impulse', scope: USER, occurredAt: T0, payload: { amounts: { focus: 0.1 } } });
    assert.deepEqual(applyBeliefEvent({ db: world.db, event, slice: {}, now: T0 }), {});
  } finally { world.close(); }
});

test('currentBeliefs returns only current facts; refuted and superseded stay in history', () => {
  const world = makeWorld();
  try {
    const supported = assertBelief(world.db, { scope: USER, proposition: '用户在学吉他', rootEvidenceIds: ['msg:80'], now: T0 });
    const refuted = assertBelief(world.db, { scope: USER, proposition: '用户讨厌猫', rootEvidenceIds: ['msg:81'], now: T0 });
    const superseded = assertBelief(world.db, { scope: USER, proposition: '用户明天出差', rootEvidenceIds: ['msg:82'], now: T0 });
    const unrelated = assertBelief(world.db, { scope: USER, proposition: '用户在学日语', rootEvidenceIds: ['msg:83'], now: T0 });
    addDependent(world.db, { scope: USER, dependentId: 'derived:avoid-cats', beliefIds: [refuted.beliefId], now: T0 });

    const refutation = addEvidence(world.db, {
      scope: USER, beliefId: refuted.beliefId, evidenceId: 'msg:84', rootId: 'msg:84', relation: 'refutes',
      now: T0 + MINUTE,
    });
    assert.equal(refutation.status, 'refuted');
    assert.equal(refutation.revision, 2);
    assert.equal(refutation.independence, 1, 'a refutation is not a support root');

    const correction = correctBelief(world.db, {
      scope: USER, beliefId: superseded.beliefId, byEvidenceId: 'msg:85', reason: '用户改期了',
      replacement: '用户下周出差', now: T0 + 2 * MINUTE,
    });
    assertCorrected(world, {
      oldId: superseded.beliefId, newId: correction.replacementId, reason: '用户改期了', byEvidenceId: 'msg:85',
    });

    const ids = currentOf(world).map(item => item.beliefId);
    assert.ok(ids.includes(supported.beliefId));
    assert.ok(ids.includes(unrelated.beliefId));
    assert.ok(ids.includes(correction.replacementId));
    assert.equal(ids.includes(refuted.beliefId), false);
    assert.equal(ids.includes(superseded.beliefId), false);
    assert.ok(currentOf(world).every(item => item.status === 'supported'));

    const refutedHistory = historyOf(world, refuted.beliefId);
    assert.equal(refutedHistory.status, 'refuted');
    assert.equal(refutedHistory.reason, '');
    assert.ok(refutedHistory.evidence.some(item => item.evidenceId === 'msg:84' && item.relation === 'refute'));
    assert.deepEqual(refutedHistory.revisions.map(item => item.kind), ['asserted', 'refuted']);
    assert.equal(dependentOf(world, 'derived:avoid-cats', refuted.beliefId).status, 'current',
      'refuting one belief does not invalidate other derivations');

    const otherWorld = scopeKey({ ...USER, worldId: 'world:elsewhere' });
    assert.throws(
      () => beliefHistory(world.db, { scopeKey: otherWorld, beliefId: supported.beliefId }),
      error => error?.code === 'belief-not-found',
      'history is scope-checked, never readable across worlds',
    );
  } finally { world.close(); }
});
