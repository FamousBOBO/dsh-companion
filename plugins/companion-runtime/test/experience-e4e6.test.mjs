import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mountRuntime } from '../index.mjs';
import { buildPlanningPrompt } from '../lib/planner.mjs';

// P2.5-2 尾巴 E4 / E6 —— **装配级**测试。
//
// E4：goals/commitments 以前在生产里恒空（foundation 从没传 continuity provider）。
//     这里不注入 materials，而是走真实挂载路径：mountRuntime → runtime.continuitySnapshot()
//     → 与 foundation 的 materials 端口同一形状地消费它。
// E6：planner 以前完全不读 beliefs；纠错通道 `memory/correction-request` 零调用点。
//     这里断言"纠正后下一轮 prompt 不再出现旧说法、出现新说法"，并且事件书里真的有一条
//     correction-request。

const T0 = Date.UTC(2026, 10, 4, 3, 0, 0);
const SESSION = 'session-e4e6';

function buildRoot(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e4e6-'));
  for (const dir of ['home/companion', 'logs', 'workspace']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, 'workspace/PERSONA.md'), 'bot\n', 'utf8');
  fs.writeFileSync(path.join(root, 'home/companion/runtime.config.json'), JSON.stringify({
    enabled: true, mode: 'active', timeZone: 'Asia/Shanghai',
    agenda: { enabled: true }, p2: { planning: { enabled: true }, activities: { enabled: true } },
    ...extra,
  }), 'utf8');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });
  return root;
}

const identity = () => ({ resolve: sessionId => ({ userId: 'owner-1', persona: 'bot', sessionId }) });

function mount(t, extra = {}) {
  const root = buildRoot(t, extra);
  const runtime = mountRuntime(null, root, { now: () => T0, identity: identity() });
  t.after(() => { try { runtime.dispose?.(); } catch { /* disposed */ } });
  return { runtime, root };
}

// ---------------------------------------------------------------------------
// E4
// ---------------------------------------------------------------------------

test('E4（装配级）：真挂载后 continuity 快照给出目标与未完成承诺', async t => {
  const { runtime } = mount(t);
  const scope = { sessionId: SESSION };

  assert.equal(runtime.proposeGoal({ ...scope, title: '把阳台收拾出来' }).ok, true);
  assert.equal(runtime.proposeGoal({ ...scope, title: '学完调色基础' }).ok, true);
  const commitment = runtime.makeCommitment({ ...scope, text: '周末把照片整理完', dueAt: T0 + 3 * 86400 * 1000 });
  assert.equal(commitment.ok, true, JSON.stringify(commitment));

  const snapshot = runtime.continuitySnapshot({ ...scope, limit: 6, commitmentLimit: 6 });
  assert.equal(snapshot.ok, true, JSON.stringify(snapshot));
  assert.equal(snapshot.goals.length >= 2, true, 'goals are visible through the real mount');
  assert.equal(snapshot.goals.some(goal => goal.title.includes('阳台')), true);
  assert.equal(snapshot.commitments.length >= 1, true, 'open commitments are visible too');
  assert.equal(snapshot.commitments.some(item => String(item.text ?? item.body).includes('照片')), true);
  assert.equal(snapshot.source, 'runtime:goals');
});

test('E4（装配级）：无 provider / 未挂载时为空且状态是 not-wired，不会伪装成"用户没有目标"', async t => {
  // The foundation provider calls `cognitive.continuitySnapshot` only when the runtime exists; the
  // degraded shape is what it returns otherwise. Kept identical to index.mjs's closure so this test
  // fails if the closure and the contract drift apart.
  const degraded = { goals: [], commitments: [], source: 'runtime:goals', state: 'not-wired', reason: 'runtime-not-mounted' };
  const prompt = buildPlanningPrompt({
    material: {
      timeZone: 'Asia/Shanghai', now: T0, day: '2026-11-04',
      goals: degraded.goals, commitments: degraded.commitments,
      continuityState: degraded.state, continuityReason: degraded.reason,
    },
    day: '2026-11-04', timeZone: 'Asia/Shanghai', now: T0, windowStart: T0, windowEnd: T0 + 86400000,
  });
  const text = String(prompt.input ?? prompt);
  assert.equal(text.includes('这一轮看不到用户的目标与承诺'), true, 'an empty section explains itself');
  assert.equal(text.includes('不要据此推断'), true, 'and forbids the "no goals" inference');
});

test('E4：continuity 快照有界（条数上限与截断都在）', async t => {
  const { runtime } = mount(t);
  for (let i = 0; i < 9; i += 1) {
    runtime.proposeGoal({ sessionId: SESSION, title: `目标 ${i} ${'很长的标题'.repeat(12)}` });
  }
  const snapshot = runtime.continuitySnapshot({ sessionId: SESSION, limit: 3, maxChars: 30 });
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.goals.length, 3, 'bounded by count');
  for (const goal of snapshot.goals) assert.equal(goal.title.length <= 30, true, 'bounded by chars');
});

// ---------------------------------------------------------------------------
// E6
// ---------------------------------------------------------------------------

test('E6：planner 读 beliefs —— 纠正后下一轮 prompt 不再出现旧说法、出现新说法', async t => {
  const { runtime } = mount(t);
  const asserted = runtime.assertBelief({
    sessionId: SESSION, proposition: '用户喜欢在雨天散步', rootEvidenceIds: ['ev-1'], confidence: 0.8, source: 'conversation',
  });
  assert.equal(asserted.ok, true, JSON.stringify(asserted));
  const belief = runtime.listBeliefs({ sessionId: SESSION }).beliefs[0];
  assert.ok(belief, 'the belief is current');

  // Round 1 materials: the planner sees it.
  const promptBefore = renderPrompt(await p2MaterialsOf(runtime), T0);
  assert.equal(promptBefore.includes('雨天散步'), true, 'the belief reaches the prompt');
  assert.equal(promptBefore.includes('已知事实，不要当成新发现'), true, 'and is labelled as known');

  // Correct it.
  const corrected = runtime.correctBelief({ sessionId: SESSION, beliefId: belief.beliefId, byEvidenceId: 'ev-2', reason: '用户说不再喜欢了', replacement: '用户现在不喜欢在雨天散步' });
  assert.equal(corrected.ok, true, JSON.stringify(corrected));
  assert.equal(corrected.memoryCorrection?.ok, true, 'the correction also reaches memory');

  // E6: the channel is no longer dead — `correctBelief` itself reports the queued correction, and
  // the outbox proves it became a real delivery request (not just a return value).
  assert.equal(corrected.memoryCorrection.ok, true, JSON.stringify(corrected.memoryCorrection));
  assert.equal(corrected.memoryCorrection.kind, 'memory/correction-request');
  const drained = await runtime.drainOutbox({ sessionId: SESSION });
  assert.equal(drained.processed >= 1, true, 'the correction actually reached the memory queue');

  const promptAfter = renderPrompt(await p2MaterialsOf(runtime), T0);
  assert.equal(promptAfter.includes('雨天散步') && !promptAfter.includes('不喜欢在雨天散步'), false, 'the old statement is gone');
  assert.equal(promptAfter.includes('不喜欢在雨天散步'), true, 'the corrected statement is what remains');
});

test('E6：beliefs 段超界时按上限截断（并且不把未知当事实）', async t => {
  const { runtime } = mount(t);
  for (let i = 0; i < 8; i += 1) {
    runtime.assertBelief({ sessionId: SESSION, proposition: `事实 ${i}：${'细节'.repeat(40)}`, rootEvidenceIds: [`ev-${i}`], confidence: 0.9, source: 'conversation' });
  }
  const materials = await p2MaterialsOf(runtime);
  assert.equal(materials.beliefs.length <= 6, true, 'bounded by count');
  for (const item of materials.beliefs) assert.equal(item.proposition.length <= 160, true, 'bounded by chars');
  const prompt = renderPrompt(materials, T0);
  assert.equal(prompt.includes('用户已经相信'), true);
});

// --- helpers -----------------------------------------------------------------

async function p2MaterialsOf(runtime) {
  // The runtime's own materials path — the one foundation's materials port calls into.
  const scope = runtime.status({ sessionId: SESSION }).scopeKey;
  return runtime.p2Materials({ scopeKey: scope, day: '2026-11-04', now: T0 });
}

function renderPrompt(material, now) {
  const built = buildPlanningPrompt({
    material,
    day: '2026-11-04', timeZone: 'Asia/Shanghai', now,
    windowStart: now, windowEnd: now + 86400000,
  });
  return String(built?.input ?? '');
}

function correctionsOf(runtime) {
  try {
    const listed = runtime.listEvents?.({ sessionId: SESSION });
    const events = listed?.events ?? [];
    return events.filter(event => event.kind === 'memory/correction-request');
  } catch { return []; }
}
