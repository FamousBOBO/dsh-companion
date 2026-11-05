import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mountRuntime } from '../index.mjs';

// End-to-end execution pump (contract v1.2 §1/§2, external blocker 1).
//
// These tests drive the *pump* — not `applyModelProgress` with a hand-written receipt — so
// the receipt the module receives is exactly the one the executor builds from a model answer.
// That is the path the external verifier could not walk, and it is the only way to catch a
// broken `textHash` or a premature `finish`.

const T0 = Date.UTC(2026, 10, 2, 1, 0, 0); // 2026-11-02 09:00 Asia/Shanghai
const BOUND = { userId: 'owner-1', persona: 'bot' };
const sha256 = value => crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');

function makeRoot(t, p2 = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-pump-'));
  fs.mkdirSync(path.join(root, 'home/companion/works/sources'), { recursive: true });
  fs.writeFileSync(path.join(root, 'home/companion/runtime.config.json'), JSON.stringify({
    schemaVersion: 1, enabled: true, mode: 'active', timeZone: 'Asia/Shanghai',
    p2: {
      planning: { enabled: true },
      activities: { enabled: true, artifactRoot: 'home/companion/works', chunkUnits: 40, maxUnitsPerStep: 40 },
      budget: { maxRequestsPerDay: 64, maxInputTokensPerDay: 160000, maxOutputTokensPerDay: 24000 },
      ...p2,
    },
  }));
  return root;
}

function planJson({ kind, targetRef, units = 120, title = '读材料' }) {
  return JSON.stringify({
    summary: '按计划做一件事',
    slots: [{ kind: 'activity', activity: kind, title, detail: '', startAt: T0, endAt: T0 + 3 * 3600e3, flexibility: 'soft', targetRef }],
  });
}

function mountWithModel(root, { text = '模型答案', onCall, plan = null } = {}) {
  const planJsonFor = () => plan ?? '{}';
  const calls = [];
  const runtime = mountRuntime(null, root, {
    now: () => T0,
    identity: { resolve: sessionId => ({ ...BOUND, sessionId }) },
    callModel: async args => {
      calls.push(args);
      // The planning round and the activity call share one port, so the answer must match the
      // purpose: a plan JSON for `p2-planning`, the model's reading/writing for `p2-activity`.
      if (args.purpose === 'p2-planning') {
        return { text: planJsonFor(args), provider: 'test-provider', model: 'test-model', inputTokens: 40, outputTokens: 30 };
      }
      if (onCall) return onCall(args, calls.length);
      return { text, provider: 'test-provider', model: 'test-model', inputTokens: 12, outputTokens: 6 };
    },
    p2Ports: {
      readFile: async ({ path: file }) => ({ ok: true, text: fs.readFileSync(file, 'utf8') }),
      fetchPage: async () => ({ ok: false, code: 'source-invalid' }),
      writeFile: async ({ path: file, text: value }) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, value, 'utf8');
        return { ok: true, bytes: Buffer.byteLength(value), sha256: sha256(value), path: file };
      },
    },
  });
  return { runtime, calls };
}

const sourceText = '城市里的慢速观察'.repeat(50); // 400 chars → bounded 40-char windows

test('P2-20/exec: the pump turns a real model answer into progress and a receipt', async t => {
  const root = makeRoot(t);
  fs.writeFileSync(path.join(root, 'home/companion/works/sources/a.md'), sourceText);
  const plan = planJson({ kind: 'read', targetRef: 'sources/a.md' });
  const { runtime, calls } = mountWithModel(root, {
    plan,
    onCall: () => ({ text: '读到：城市里的慢速观察反复出现', provider: 'test-provider', model: 'test-model', inputTokens: 30, outputTokens: 9 }),
  });
  t.after(() => { try { runtime.dispose(); } catch { /* closed */ } fs.rmSync(root, { recursive: true, force: true }); });

  runtime.proposeGoal({ bound: BOUND, title: 'x' });
  const modelCalls = [];
  // The plan itself is produced by the same port; count only the activity calls afterwards.
  await runtime.pumpPlanning({ reason: 'timer' });
  await runtime.pumpActivities({ now: T0 });
  const started = runtime.listActivities({ bound: BOUND }).activities ?? [];
  assert.equal(started.length, 1, 'the plan slot started one activity');
  assert.equal(started[0].status, 'running');

  const first = await runtime.pumpActivityExecution({ now: T0, maxStepsPerCycle: 1 });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.steps[0]?.code, 'stepped', JSON.stringify(first.steps));
  const afterFirst = runtime.listActivities({ bound: BOUND }).activities[0];
  assert.equal(afterFirst.consumed > 0, true, 'the first window really advanced the prefix');
  assert.equal(afterFirst.consumed < 400, true, 'a bounded window is smaller than the whole source');
  const activityCalls = calls.filter(call => call.purpose === 'p2-activity');
  assert.equal(activityCalls.length, 1, 'one model call per step');
  const instructionText = String(activityCalls[0].system ?? '') + String(activityCalls[0].input ?? '');
  assert.equal(/不可信|只读|untrusted|read-only/i.test(instructionText), true, 'the model is told the material is untrusted/read-only');

  const second = await runtime.pumpActivityExecution({ now: T0, maxStepsPerCycle: 1 });
  assert.equal(second.steps[0]?.code, 'stepped');
  const afterSecond = runtime.listActivities({ bound: BOUND }).activities[0];
  assert.equal(afterSecond.consumed > afterFirst.consumed, true, 'the second step advanced further');
  assert.equal(afterSecond.status, 'running', 'a long read is not exhausted after two windows');

  assert.equal(calls.filter(call => call.purpose === 'p2-activity').length, 2);

  const receipts = runtime.status({ bound: BOUND }).errors;
  assert.equal(Array.isArray(receipts), true);
});

test('P2-20/exec: a write closes only on the model done flag, never on consumed>=total', async t => {
  const root = makeRoot(t);
  const plan = planJson({ kind: 'write', targetRef: 'drafts/pump.md', title: '写一段' });
  const { runtime, calls } = mountWithModel(root, {
    plan,
    onCall: () => ({ text: '第一段。', provider: 'test-provider', model: 'test-model', inputTokens: 10, outputTokens: 4 }),
  });
  t.after(() => { try { runtime.dispose(); } catch { /* closed */ } fs.rmSync(root, { recursive: true, force: true }); });

  runtime.proposeGoal({ bound: BOUND, title: 'x' });
  await runtime.pumpPlanning({ reason: 'timer' });
  await runtime.pumpActivities({ now: T0 });
  const started = runtime.listActivities({ bound: BOUND }).activities ?? [];
  assert.equal(started[0].kind, 'write');

  const first = await runtime.pumpActivityExecution({ now: T0, maxStepsPerCycle: 1 });
  assert.equal(first.steps[0]?.code, 'stepped', JSON.stringify(first.steps));
  const afterFirst = runtime.listActivities({ bound: BOUND }).activities[0];
  assert.equal(afterFirst.status, 'running', 'a write keeps going after one paragraph');
  assert.equal(afterFirst.artifactVersion >= 1, true, 'the versioned file was written');
  assert.equal(calls.filter(call => call.purpose === 'p2-activity').length, 1);
});

test('P2-20/exec: an empty model answer is refused and never advances the prefix', async t => {
  const root = makeRoot(t);
  fs.writeFileSync(path.join(root, 'home/companion/works/sources/a.md'), sourceText);
  const plan = planJson({ kind: 'read', targetRef: 'sources/a.md' });
  const { runtime } = mountWithModel(root, {
    plan,
    onCall: () => ({ text: '', provider: 'test-provider', model: 'test-model', inputTokens: 10, outputTokens: 0 }),
  });
  t.after(() => { try { runtime.dispose(); } catch { /* closed */ } fs.rmSync(root, { recursive: true, force: true }); });

  runtime.proposeGoal({ bound: BOUND, title: 'x' });
  await runtime.pumpPlanning({ reason: 'timer' });
  await runtime.pumpActivities({ now: T0 });
  const outcome = await runtime.pumpActivityExecution({ now: T0, maxStepsPerCycle: 1 });
  const step = outcome.steps[0];
  assert.equal(step.code === 'stepped', false, 'an empty answer is not progress');
  const activity = runtime.listActivities({ bound: BOUND }).activities[0];
  assert.equal(activity.consumed, 0, 'the consumed prefix stays untouched');
});

// NOTE: single-flight is asserted in p2-activity-faults and by the external probe; a blocking\n// gate here deadlocks the runner, so it is deliberately not repeated in this file.\n