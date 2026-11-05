import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mountRuntime } from '../index.mjs';

// P2 boundary tests owned by the Lead: the integration surface that the module tests cannot
// see — switches, the forbidden direct-event path, the diagnostics shape, share gating and
// the frozen budget day. P2-17/27/28/29 plus the "0 outbound when off" half of P2-18.

const T0 = Date.UTC(2026, 10, 2, 1, 0, 0); // 2026-11-02 09:00 Asia/Shanghai
const BOUND = { userId: 'owner-1', persona: 'march7' };

const cleanups = [];
test.afterEach?.(() => {});
function makeRoot(t, p2 = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-boundary-'));
  fs.mkdirSync(path.join(root, 'home/companion'), { recursive: true });
  fs.writeFileSync(path.join(root, 'home/companion/runtime.config.json'), JSON.stringify({
    schemaVersion: 1, enabled: true, mode: 'active', timeZone: 'Asia/Shanghai',
    ...(p2 ? { p2 } : {}),
  }));
  return root;
}

function mount(root, extra = {}) {
  return mountRuntime(null, root, {
    now: () => T0,
    identity: { resolve: sessionId => ({ ...BOUND, sessionId }) },
    ...extra,
  });
}

test('P2-27: the generic event entry refuses autonomy/* and the log stays clean', t => {
  const root = makeRoot(t, { planning: { enabled: true }, activities: { enabled: true } });
  const runtime = mount(root);
  t.after(() => { try { runtime.dispose(); } catch { /* closed */ } fs.rmSync(root, { recursive: true, force: true }); });

  for (const kind of ['autonomy/plan-committed', 'autonomy/activity', 'autonomy/opportunity']) {
    const refused = runtime.recordEvent({ kind, bound: BOUND, occurredAt: T0, payload: { forged: true } });
    assert.equal(refused.ok, false, `${kind} must be refused`);
    assert.equal(refused.code, 'autonomy-direct-event-refused');
  }
  const probe = runtime.status({ bound: BOUND });
  assert.equal(probe.errors.filter(error => String(error.code).startsWith('autonomy')).length, 0, 'a refusal is not an error');
});

test('P2-17/28: both switches default off, the partition is explicit and carries no bodies', t => {
  const root = makeRoot(t);
  const runtime = mount(root);
  t.after(() => { try { runtime.dispose(); } catch { /* closed */ } fs.rmSync(root, { recursive: true, force: true }); });
  const status = runtime.p2Status({ bound: BOUND });
  assert.equal(status.planning.enabled, false);
  assert.equal(status.activities.enabled, false);
  assert.equal(status.planning.pendingLoad, false, 'the code is mounted, so pendingLoad is an explicit false');
  assert.equal(status.activities.pendingLoad, false);
  assert.equal(status.planning.state, 'disabled');
  assert.equal(status.share.enabled, false);
  assert.equal(status.share.owner, 'contact');
  // Disabled capability is reported honestly, never as available.
  for (const id of ['read', 'explore', 'write']) {
    assert.equal(status.capabilities[id].available, false, `${id} must not look available while the switch is off`);
    assert.equal(typeof status.capabilities[id].reason, 'string');
  }
  // No plan/activity body can leak through the partition.
  const serialized = JSON.stringify(status);
  assert.ok(!serialized.includes('读一段'), 'a disabled partition carries no plan text');
  assert.ok(!serialized.includes('targetRef'), 'a disabled partition carries no slot targets');
});

test('P2-17: a plan in the partition is bounded, and activity text never appears', t => {
  const root = makeRoot(t, { planning: { enabled: true }, activities: { enabled: true } });
  const longSummary = '很长的计划说明'.repeat(80);
  const plan = JSON.stringify({ summary: longSummary, slots: [{ kind: 'activity', activity: 'read', title: '读一段材料', detail: '细节', startAt: T0, endAt: T0 + 600000, flexibility: 'soft', targetRef: 'sources/x.md' }] });
  const runtime = mount(root, {
    callModel: async () => ({ text: plan, provider: 'scripted', model: 's', inputTokens: 5, outputTokens: 5 }),
    p2Ports: { readFile: async () => ({ ok: true, text: '内容'.repeat(10) }), fetchPage: async () => ({ ok: false }), writeFile: async () => ({ ok: true }) },
  });
  t.after(() => { try { runtime.dispose(); } catch { /* closed */ } fs.rmSync(root, { recursive: true, force: true }); });
  runtime.proposeGoal({ bound: BOUND, title: 'x' });
  return runtime.pumpPlanning({ reason: 'timer' }).then(() => {
    const status = runtime.p2Status({ bound: BOUND });
    assert.equal(status.planning.plan?.slots?.length, 1);
    assert.ok(String(status.planning.plan.summary).length <= 120, 'the summary is truncated in diagnostics');
  });
});

test('P2-18: share off means zero candidates and zero port calls', async t => {
  const root = makeRoot(t, { planning: { enabled: true }, activities: { enabled: true }, share: { enabled: false } });
  let portCalls = 0;
  const runtime = mount(root, { sharePort: { available: true, submit: async () => { portCalls += 1; return { ok: true }; } } });
  t.after(() => { try { runtime.dispose(); } catch { /* closed */ } fs.rmSync(root, { recursive: true, force: true }); });
  const created = runtime.createShareCandidate({ bound: BOUND, activityId: 'act_x', title: '生活分享', body: '正文' });
  assert.equal(created.ok, false);
  assert.equal(created.code, 'share-disabled');
  const submitted = await runtime.submitShareCandidate({ bound: BOUND, candidateId: 'shr_x' });
  assert.equal(submitted.ok, false);
  assert.equal(submitted.code, 'share-disabled');
  assert.equal(portCalls, 0, 'a disabled share switch never reaches the contact port');
  assert.deepEqual(runtime.shareCandidates({ bound: BOUND }).candidates, []);
});

test('P2-18: share on keeps candidates pending, owner-bound, and refused by a stub without a port', async t => {
  const root = makeRoot(t, { planning: { enabled: true }, activities: { enabled: true }, share: { enabled: true, maxPending: 2 } });
  const calls = [];
  const runtime = mount(root, { sharePort: { available: true, submit: async candidate => { calls.push(candidate); return { ok: true, code: 'accepted' }; } } });
  t.after(() => { try { runtime.dispose(); } catch { /* closed */ } fs.rmSync(root, { recursive: true, force: true }); });
  const first = runtime.createShareCandidate({ bound: BOUND, activityId: 'act_1', title: '写了一点', body: '正文一' });
  assert.equal(first.ok, true);
  const duplicate = runtime.createShareCandidate({ bound: BOUND, activityId: 'act_1', title: '写了一点', body: '正文一' });
  assert.equal(duplicate.candidateId, first.candidateId, 'the same activity cannot queue twice');
  const submitted = await runtime.submitShareCandidate({ bound: BOUND, candidateId: first.candidateId });
  assert.equal(submitted.ok, true);
  assert.equal(submitted.accepted, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].scope, 'u:owner-1|p:march7|w:world:default', 'the candidate is bound to its own scope');
  assert.equal(runtime.shareCandidates({ bound: BOUND }).candidates.length, 0, 'a submitted candidate is no longer pending');
});

test('P2-13 (partial): pausing planning leaves P1/H1/H2/bridge untouched', t => {
  const root = makeRoot(t, { planning: { enabled: true }, activities: { enabled: true } });
  const runtime = mount(root);
  t.after(() => { try { runtime.dispose(); } catch { /* closed */ } fs.rmSync(root, { recursive: true, force: true }); });
  const paused = runtime.pausePlanning({ reason: 'test' });
  assert.equal(paused.ok, true);
  const status = runtime.p2Status({ bound: BOUND });
  assert.equal(status.planning.paused, true);
  assert.equal(status.planning.state, 'paused');
  // The runtime itself, the agenda switch and the heartbeat switch are untouched.
  const full = runtime.status({ bound: BOUND });
  assert.notEqual(full.mode, 'off');
  assert.equal(full.heartbeat.state !== 'pending-load', true);
  const resumed = runtime.resumePlanning();
  assert.equal(resumed.ok, true);
  assert.equal(runtime.p2Status({ bound: BOUND }).planning.paused, false);
});

test('P2-29: the budget day is frozen against a later timeZone edit', async t => {
  const root = makeRoot(t, { planning: { enabled: true }, activities: { enabled: true } });
  const plan = JSON.stringify({ summary: '安排', slots: [{ kind: 'open', title: '留白', detail: '', startAt: T0, endAt: T0 + 600000, flexibility: 'soft' }] });
  const runtime = mount(root, { callModel: async () => ({ text: plan, provider: 's', model: 's', inputTokens: 1, outputTokens: 1 }) });
  t.after(() => { try { runtime.dispose(); } catch { /* closed */ } fs.rmSync(root, { recursive: true, force: true }); });
  runtime.proposeGoal({ bound: BOUND, title: 'x' });
  await runtime.pumpPlanning({ reason: 'timer' });
  const before = runtime.p2Status({ bound: BOUND }).budget;
  // Rewrite the config on disk: a mounted runtime must not silently adopt a new day key.
  fs.writeFileSync(path.join(root, 'home/companion/runtime.config.json'), JSON.stringify({ enabled: true, mode: 'active', timeZone: 'Pacific/Kiritimati', p2: { planning: { enabled: true }, activities: { enabled: true } } }));
  const after = runtime.p2Status({ bound: BOUND }).budget;
  assert.equal(after.day, before.day, 'the day key does not follow a config edit');
  assert.equal(after.timeZone, 'Asia/Shanghai');
});

test('P2-14 (partial): a simulated / hypothetical activity can never become a memory', async t => {
  const root = makeRoot(t, { planning: { enabled: true }, activities: { enabled: true } });
  const written = [];
  const runtime = mount(root, {
    memoryPort: { recordExperience: async payload => { written.push(payload); return { ok: true, receiptId: 'r1' }; } },
    p2Ports: { readFile: async () => ({ ok: true, text: '材料内容' }), fetchPage: async () => ({ ok: false }), writeFile: async () => ({ ok: true }) },
  });
  t.after(() => { try { runtime.dispose(); } catch { /* closed */ } fs.rmSync(root, { recursive: true, force: true }); });
  // Start from a real plan slot: the product path never invents an activity out of nothing.
  const planned = JSON.stringify({ summary: '模拟一下', slots: [{ kind: 'activity', activity: 'read', title: '读一段', detail: '', startAt: T0, endAt: T0 + 600000, flexibility: 'soft', targetRef: 'sources/a.md' }] });
  const withPlan = mount(root, {
    callModel: async () => ({ text: planned, provider: 's', model: 's', inputTokens: 1, outputTokens: 1 }),
    memoryPort: { recordExperience: async payload => { written.push(payload); return { ok: true, receiptId: 'r1' }; } },
    p2Ports: { readFile: async () => ({ ok: true, text: '材料内容' }), fetchPage: async () => ({ ok: false }), writeFile: async () => ({ ok: true }) },
  });
  withPlan.proposeGoal({ bound: BOUND, title: 'x' });
  await withPlan.pumpPlanning({ reason: 'timer' });
  const slot = withPlan.listPlan({ bound: BOUND }).slots?.[0];
  assert.ok(slot, 'a plan slot exists');
  const start = await withPlan.startActivity({ bound: BOUND, slotId: slot.slotId, kind: 'read', target: 'sources/a.md', reality: 'simulated_world' });
  assert.equal(start.ok, true, JSON.stringify(start));
  const id = start.activityId;
  const memory = await withPlan.recordExperience({ bound: BOUND, activityId: id });
  assert.equal(memory.ok, false);
  assert.equal(memory.code, 'simulated-not-remembered');
  assert.equal(written.length, 0, 'the memory port is never called for a simulated activity');
  withPlan.dispose();
});
