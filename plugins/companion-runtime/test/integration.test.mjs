import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mountRuntime } from '../index.mjs';
import { createDb } from '../lib/db.mjs';

// End-to-end wiring for C1–C4 through the public runtime API: events, receipts,
// goals, working memory, beliefs, bridge, budget, restart and recovery. No model is
// involved and no channel is touched.

const T0 = Date.UTC(2026, 9, 29, 2, 0, 0);

function buildRoot(t, config = { enabled: true, mode: 'active' }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-integration-'));
  for (const dir of ['home/companion', 'home/memory', 'home/channel-qq', 'logs']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, 'home/companion/memory.config.json'), JSON.stringify({
    schemaVersion: 1, backend: 'sqlite', injection: { budgetChars: 2400 }, extraction: { enabled: false },
    embedding: { provider: 'local', dimensions: 128 }, wiki: { enabled: false },
  }));
  fs.writeFileSync(path.join(root, 'home/companion/runtime.config.json'), JSON.stringify(config));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });
  return root;
}

const identity = () => ({ resolve: sessionId => ({ userId: 'owner-1', persona: 'march7', sessionId }) });
const ctx = () => ({ tools: { register() {} }, systemPrompt: { section() {} }, on() {}, get() { return undefined; } });

function memoryStub({ mode = 'accepted' } = {}) {
  const calls = [];
  return {
    version: 'stub',
    calls,
    async ingestDomainEvent(request) {
      calls.push(request);
      return { status: mode, receiptId: `rcpt-${request.eventId}`, recordId: `mem-${request.eventId}` };
    },
  };
}

function mount(root, { memory = memoryStub(), now = () => T0, name = 'session-a' } = {}) {
  const runtime = mountRuntime(ctx(), root, { memory, identity: identity(), now });
  const session = { sessionId: name };
  return { runtime, memory, ...session };
}

// The frozen lifecycle is proposed -> accepted -> running; there is no shortcut.
function startGoal(runtime, sessionId, goalId, revision) {
  const accepted = runtime.transitionGoal({ sessionId, goalId, to: 'accepted', expectedRevision: revision });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  const started = runtime.transitionGoal({ sessionId, goalId, to: 'started', expectedRevision: revision + 1 });
  assert.equal(started.ok, true, JSON.stringify(started));
  return revision + 2;
}

test('C1–C4 end to end: goal lifecycle, working memory, correction and recovery', t => {
  const root = buildRoot(t);
  const { runtime, memory } = mount(root);
  assert.equal(runtime.mode, 'active');

  const proposed = runtime.proposeGoal({ sessionId: 'session-a', title: '修屋顶', nextStep: '联系师傅', authorization: 'none' });
  assert.equal(proposed.ok, true, JSON.stringify(proposed));
  const [goal] = runtime.listGoals({ sessionId: 'session-a', includeClosed: true }).goals;

  // A07: a stale revision is rejected before it can touch the log.
  const stale = runtime.transitionGoal({ sessionId: 'session-a', goalId: goal.goalId, to: 'started', expectedRevision: goal.revision + 5 });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'stale-revision');

  const runningRevision = startGoal(runtime, 'session-a', goal.goalId, goal.revision);
  const stepped = runtime.recordGoalStep({ sessionId: 'session-a', goalId: goal.goalId, step: '联系师傅', expectedRevision: runningRevision });
  assert.equal(stepped.ok, true, JSON.stringify(stepped));
  const patched = runtime.patchGoal({ sessionId: 'session-a', goalId: goal.goalId, nextStep: '等师傅回话', waitingOn: '师傅的报价', expectedRevision: runningRevision + 1 });
  assert.equal(patched.ok, true, JSON.stringify(patched));

  const commitment = runtime.makeCommitment({ sessionId: 'session-a', text: '周五继续整理资料', goalId: goal.goalId, dueAt: T0 + 3 * 86400000 });
  assert.equal(commitment.ok, true, JSON.stringify(commitment));

  const view = runtime.workingMemory({ sessionId: 'session-a' });
  assert.equal(view.focusGoalId, goal.goalId);
  assert.equal(view.goal.nextStep, '等师傅回话');
  assert.ok(view.goal.doneSteps.includes('联系师傅'));
  assert.ok(view.commitments.some(item => item.text === '周五继续整理资料'));

  const text = runtime.injectionFor({ sessionId: 'session-a', budgetChars: 320 }).text;
  assert.ok(text.length > 0 && text.length <= 320);
  assert.match(text, /修屋顶/);
  assert.match(text, /周五继续整理资料/);

  // Beliefs: same root evidence never raises confidence; a correction supersedes.
  const asserted = runtime.assertBelief({ sessionId: 'session-a', proposition: '用户可能在忙', rootEvidenceIds: ['ev-1'], confidence: 0.9, validUntil: T0 + 60000 });
  assert.equal(asserted.ok, true, JSON.stringify(asserted));
  const [belief] = runtime.listBeliefs({ sessionId: 'session-a' }).beliefs;
  assert.ok(belief?.beliefId, JSON.stringify(belief));
  const confidenceBefore = belief.confidence;
  const again = runtime.addBeliefEvidence({ sessionId: 'session-a', beliefId: belief.beliefId, evidenceId: 'ev-1-summary', rootId: 'ev-1' });
  assert.equal(again.ok, true, JSON.stringify(again));
  const afterSameRoot = runtime.listBeliefs({ sessionId: 'session-a' }).beliefs.find(item => item.beliefId === belief.beliefId);
  assert.equal(afterSameRoot.confidence, confidenceBefore, 'quoting the same root does not raise confidence');

  const corrected = runtime.correctBelief({ sessionId: 'session-a', beliefId: belief.beliefId, byEvidenceId: 'ev-2', reason: 'user-correction' });
  assert.equal(corrected.ok, true, JSON.stringify(corrected));
  const current = runtime.listBeliefs({ sessionId: 'session-a' }).beliefs;
  assert.equal(current.some(item => item.beliefId === belief.beliefId), false, 'the old judgment is no longer a current fact');

  // Memory hand-off: queue, drain, and keep the receipt memory returned.
  const queued = runtime.requestMemoryIngest({ sessionId: 'session-a', content: '修屋顶这件事暂存在等报价', namespace: 'companion.event', rootEvidenceIds: ['ev-3'], evidenceStatus: 'inferred', realityStatus: 'hypothetical' });
  assert.equal(queued.ok, true, JSON.stringify(queued));
  return (async () => {
    // Two rows are queued here: the explicit ingest above **and** the memory/correction-request
    // that `correctBelief` now emits (E6 made that channel have a real producer — before this it
    // was a dead channel with zero call sites). The drain therefore delivers two, and the second
    // drain still delivers nothing.
    const drained = await runtime.drainOutbox({ sessionId: 'session-a' });
    assert.equal(drained.delivered, 2, JSON.stringify(drained));
    assert.equal(memory.calls.length, 2);
    const second = await runtime.drainOutbox({ sessionId: 'session-a' });
    assert.equal(second.processed, 0, 'a delivered request is never re-sent');

    // Recovery: replaying the recorded log reproduces the live projection.
    const recovery = runtime.verifyRecovery({ sessionId: 'session-a' });
    assert.equal(recovery.ok, true, JSON.stringify(recovery.mismatches));

    const completed = runtime.transitionGoal({ sessionId: 'session-a', goalId: goal.goalId, to: 'completed', expectedRevision: runningRevision + 2 });
    assert.equal(completed.ok, true, JSON.stringify(completed));
    const closed = runtime.workingMemory({ sessionId: 'session-a' });
    assert.equal(closed.focusGoalId, '', 'a completed goal leaves the focus');

    runtime.dispose();
  })();
});

test('A13: injection stays inside the budget, keeps commitments and makes zero model calls', t => {
  const root = buildRoot(t);
  const { runtime, memory } = mount(root);
  runtime.proposeGoal({ sessionId: 'session-a', title: '整理资料' });
  const [goal] = runtime.listGoals({ sessionId: 'session-a', includeClosed: true }).goals;
  const runningRevision = startGoal(runtime, 'session-a', goal.goalId, goal.revision);
  for (let i = 0; i < 12; i += 1) {
    runtime.recordGoalStep({ sessionId: 'session-a', goalId: goal.goalId, step: `步骤 ${i} ${'很长的步骤描述'.repeat(6)}`, expectedRevision: runningRevision + i });
    runtime.makeCommitment({ sessionId: 'session-a', text: `承诺 ${i}`, dueAt: T0 + i * 3600000 });
  }
  for (const budget of [0, 40, 80, 160, 320]) {
    const text = runtime.injectionFor({ sessionId: 'session-a', budgetChars: budget }).text;
    assert.ok(text.length <= budget, `budget ${budget} produced ${text.length} chars`);
    if (budget >= 80) assert.match(text, /承诺 0/, 'active commitments survive compression');
  }
  // State impulses are deterministic and model free: no memory hand-off happens.
  for (let i = 0; i < 20; i += 1) {
    const outcome = runtime.recordEvent({ kind: 'state/impulse', sessionId: 'session-a', occurredAt: T0 + i * 60000, payload: { amount: 0.05 } });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
  }
  assert.equal(memory.calls.length, 0, 'state advancement never talks to memory or a model');
  const snapshot = runtime.stateSnapshot({ sessionId: 'session-a' });
  assert.ok(snapshot && Number.isFinite(snapshot.values.tension));
  assert.ok(snapshot.budgetChars >= 160 && snapshot.budgetChars <= 480);
  runtime.dispose();
});

test('A04: a restart restores goals, focus, steps, commitments and beliefs', t => {
  const root = buildRoot(t);
  const first = mount(root);
  first.runtime.proposeGoal({ sessionId: 'session-a', title: '修屋顶', nextStep: '联系师傅' });
  const [goal] = first.runtime.listGoals({ sessionId: 'session-a', includeClosed: true }).goals;
  const runningRevision = startGoal(first.runtime, 'session-a', goal.goalId, goal.revision);
  first.runtime.recordGoalStep({ sessionId: 'session-a', goalId: goal.goalId, step: '联系师傅', expectedRevision: runningRevision });
  first.runtime.makeCommitment({ sessionId: 'session-a', text: '周五继续整理资料' });
  first.runtime.assertBelief({ sessionId: 'session-a', proposition: '用户可能在忙', rootEvidenceIds: ['ev-1'] });
  const versionBefore = first.runtime.status({ sessionId: 'session-a' }).eventCount;
  first.runtime.dispose();

  const second = mount(root);
  const view = second.runtime.workingMemory({ sessionId: 'session-a' });
  assert.equal(view.goal.title, '修屋顶');
  assert.equal(view.goal.nextStep, '联系师傅');
  assert.ok(view.goal.doneSteps.includes('联系师傅'));
  assert.ok(view.commitments.some(item => item.text === '周五继续整理资料'));
  assert.equal(second.runtime.listBeliefs({ sessionId: 'session-a' }).beliefs.length, 1);
  assert.equal(second.runtime.status({ sessionId: 'session-a' }).eventCount, versionBefore, 'a restart adds no synthetic history');
  const recovery = second.runtime.verifyRecovery({ sessionId: 'session-a' });
  assert.equal(recovery.ok, true, JSON.stringify(recovery.mismatches));
  second.runtime.dispose();
});

test('A11/A12: stop blocks writes, resume restores service, and an off config stays off', t => {
  const root = buildRoot(t);
  const { runtime } = mount(root);
  runtime.proposeGoal({ sessionId: 'session-a', title: '修屋顶' });
  const before = runtime.status({ sessionId: 'session-a' }).eventCount;
  runtime.stop({ reason: 'operator' });
  assert.equal(runtime.proposeGoal({ sessionId: 'session-a', title: '停止后不写' }).code, 'runtime-stopped');
  assert.equal(runtime.status({ sessionId: 'session-a' }).eventCount, before);
  assert.equal(runtime.resume().ok, true);
  assert.equal(runtime.proposeGoal({ sessionId: 'session-a', title: '恢复后可以继续' }).ok, true);
  runtime.dispose();

  const offRoot = buildRoot(t, { enabled: false });
  const off = mount(offRoot);
  assert.equal(off.runtime.mode, 'off');
  assert.equal(off.runtime.resume().code, 'runtime-off');
  assert.equal(off.runtime.proposeGoal({ sessionId: 'session-a', title: 'x' }).code, 'runtime-off');
  off.runtime.dispose();
});

test('cross-scope isolation holds for the whole runtime surface', t => {
  const root = buildRoot(t);
  const { runtime } = mount(root);
  runtime.proposeGoal({ sessionId: 'session-a', title: 'owner-1 的目标' });
  runtime.makeCommitment({ sessionId: 'session-a', text: 'owner-1 的承诺' });
  runtime.assertBelief({ sessionId: 'session-a', proposition: 'owner-1 的判断', rootEvidenceIds: ['ev-1'] });
  const other = { userId: 'owner-2', persona: 'march7', worldId: 'world:game', sessionId: 'session-z' };
  assert.equal(runtime.listGoals({ binding: other }).goals.length, 0);
  assert.equal(runtime.listBeliefs({ binding: other }).beliefs.length, 0);
  const otherView = runtime.workingMemory({ binding: other });
  assert.equal(otherView.goal, null);
  assert.deepEqual(otherView.commitments, []);
  assert.equal(runtime.injectionFor({ binding: other }).text, '');
  runtime.dispose();
});

test('A03: interruption, switch and return are restored through the public API', t => {
  const root = buildRoot(t);
  const { runtime } = mount(root);
  runtime.proposeGoal({ sessionId: 'session-a', title: '修屋顶', nextStep: '联系师傅' });
  const [goal] = runtime.listGoals({ sessionId: 'session-a', includeClosed: true }).goals;
  const runningRevision = startGoal(runtime, 'session-a', goal.goalId, goal.revision);
  runtime.recordGoalStep({ sessionId: 'session-a', goalId: goal.goalId, step: '联系师傅', expectedRevision: runningRevision });
  runtime.makeCommitment({ sessionId: 'session-a', text: '周五继续整理资料' });

  const interjection = runtime.recordEvent({ kind: 'topic/interjection', sessionId: 'session-a', occurredAt: T0 + 1000, payload: { note: '插一句玩笑' } });
  assert.equal(interjection.ok, true, JSON.stringify(interjection));
  assert.equal(runtime.workingMemory({ sessionId: 'session-a' }).focusGoalId, goal.goalId, 'an interjection does not move the focus');

  const other = runtime.proposeGoal({ sessionId: 'session-a', title: '临时任务' });
  assert.equal(other.ok, true);
  const [, second] = runtime.listGoals({ sessionId: 'session-a', includeClosed: true }).goals;
  const switched = runtime.switchFocus({ sessionId: 'session-a', goalId: second.goalId });
  assert.equal(switched.ok, true, JSON.stringify(switched));
  assert.equal(runtime.workingMemory({ sessionId: 'session-a' }).focusGoalId, second.goalId);

  const ambiguous = runtime.resumeFocus({ sessionId: 'session-a' });
  assert.equal(ambiguous.ok, true, JSON.stringify(ambiguous));
  const resumed = runtime.resumeFocus({ sessionId: 'session-a', goalId: goal.goalId });
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  const view = runtime.workingMemory({ sessionId: 'session-a' });
  assert.equal(view.focusGoalId, goal.goalId);
  assert.equal(view.goal.nextStep, '联系师傅');
  assert.ok(view.goal.doneSteps.includes('联系师傅'), 'confirmed steps come back without being redone');
  assert.ok(view.commitments.some(item => item.text === '周五继续整理资料'));
  runtime.dispose();
});

test('B9: the C4 state sets a real ceiling on injection and ablation changes it', t => {
  const quietRoot = buildRoot(t);
  const quiet = mount(quietRoot);
  quiet.runtime.proposeGoal({ sessionId: 'session-a', title: '修屋顶', nextStep: '联系师傅' });
  const [quietGoal] = quiet.runtime.listGoals({ sessionId: 'session-a', includeClosed: true }).goals;
  startGoal(quiet.runtime, 'session-a', quietGoal.goalId, quietGoal.revision);
  for (let i = 0; i < 20; i += 1) {
    quiet.runtime.makeCommitment({ sessionId: 'session-a', text: `承诺 ${i}：周末要回她的消息`, dueAt: T0 + i * 3600000 });
  }
  const quietInjection = quiet.runtime.injectionFor({ sessionId: 'session-a', budgetChars: 320 });
  assert.ok(quietInjection.text.length <= quietInjection.budget);
  quiet.runtime.dispose();

  const tenseRoot = buildRoot(t);
  const tense = mount(tenseRoot);
  tense.runtime.proposeGoal({ sessionId: 'session-a', title: '修屋顶', nextStep: '联系师傅' });
  const [tenseGoal] = tense.runtime.listGoals({ sessionId: 'session-a', includeClosed: true }).goals;
  startGoal(tense.runtime, 'session-a', tenseGoal.goalId, tenseGoal.revision);
  for (let i = 0; i < 20; i += 1) {
    tense.runtime.makeCommitment({ sessionId: 'session-a', text: `承诺 ${i}：周末要回她的消息`, dueAt: T0 + i * 3600000 });
  }
  for (let i = 0; i < 3; i += 1) {
    tense.runtime.recordEvent({ kind: 'state/impulse', sessionId: 'session-a', occurredAt: T0 + i, payload: { amount: 0.9 } });
  }
  const tenseInjection = tense.runtime.injectionFor({ sessionId: 'session-a', budgetChars: 320 });
  assert.ok(tenseInjection.budget < quietInjection.budget, `tense budget ${tenseInjection.budget} vs quiet ${quietInjection.budget}`);
  assert.ok(tenseInjection.text.length <= tenseInjection.budget, 'the state ceiling is respected');
  // The ceiling must change the actual prompt, not only the diagnostic number.
  assert.ok(tenseInjection.text.length < quietInjection.text.length,
    `the injected text must shrink with the budget: ${tenseInjection.text.length} vs ${quietInjection.text.length}`);
  tense.runtime.dispose();

  // Ablating the variable that drives the ceiling restores a larger budget: the
  // variable therefore has an observable behavioural use (contract §4 / A13).
  const ablatedRoot = buildRoot(t, { enabled: true, mode: 'active', state: { disabled: ['tension'] } });
  const ablated = mount(ablatedRoot);
  ablated.runtime.proposeGoal({ sessionId: 'session-a', title: '修屋顶', nextStep: '联系师傅' });
  const [ablatedGoal] = ablated.runtime.listGoals({ sessionId: 'session-a', includeClosed: true }).goals;
  startGoal(ablated.runtime, 'session-a', ablatedGoal.goalId, ablatedGoal.revision);
  for (let i = 0; i < 3; i += 1) {
    ablated.runtime.recordEvent({ kind: 'state/impulse', sessionId: 'session-a', occurredAt: T0 + i, payload: { amount: 0.9 } });
  }
  const ablatedInjection = ablated.runtime.injectionFor({ sessionId: 'session-a', budgetChars: 320 });
  assert.ok(ablatedInjection.budget > tenseInjection.budget, `ablated budget ${ablatedInjection.budget} vs tense ${tenseInjection.budget}`);
  ablated.runtime.dispose();
});

test('diagnostics never expose experience text', t => {
  const root = buildRoot(t);
  const { runtime } = mount(root);
  runtime.requestMemoryIngest({ sessionId: 'session-a', content: '私密的经历原文', namespace: 'companion.event' });
  runtime.proposeGoal({ sessionId: 'session-a', title: '目标标题' });
  const status = JSON.stringify(runtime.status({ sessionId: 'session-a' }));
  assert.doesNotMatch(status, /私密的经历原文|目标标题/);
  assert.match(status, /"outbox"/);
  runtime.dispose();
});
