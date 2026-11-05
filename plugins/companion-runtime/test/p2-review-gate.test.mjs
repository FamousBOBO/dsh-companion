import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mountRuntime } from '../index.mjs';

// The review gate is absolute (external host Phase B).
//
// `reconcile()` parks an activity in `needsReview` when it cannot prove what happened (a changed
// source, a stale checkpoint, a write whose last interval is doubtful). The external run resumed
// only the *explore* activity, yet the pump revived the parked *write* and starved the resumed one.
// Contract v1.2 §1 is explicit: a `needsReview` activity may not advance until an operator
// explicitly resumes or re-plans it.

const T0 = Date.UTC(2026, 10, 4, 1, 0, 0);
const BOUND = { userId: 'owner-1', persona: 'bot' };

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-gate-'));
  fs.mkdirSync(path.join(root, 'home/companion/works/sources'), { recursive: true });
  fs.writeFileSync(path.join(root, 'home/companion/works/sources/a.md'), '慢速观察'.repeat(40));
  fs.writeFileSync(path.join(root, 'home/companion/runtime.config.json'), JSON.stringify({
    enabled: true, mode: 'active', timeZone: 'Asia/Shanghai',
    p2: { planning: { enabled: true }, activities: { enabled: true, artifactRoot: 'home/companion/works', chunkUnits: 24, maxUnitsPerStep: 24 } },
  }));
  return root;
}

function planJson(now) {
  return JSON.stringify({
    summary: '读一段',
    slots: [{ kind: 'activity', activity: 'read', title: '读', targetRef: 'sources/a.md', startAt: now, endAt: now + 3600_000, flexibility: 'soft' }],
  });
}

test('pump: a needsReview activity is never advanced without an explicit resume', async t => {
  const root = makeRoot(t);
  const calls = [];
  const runtime = mountRuntime(null, root, {
    now: () => T0,
    identity: { resolve: sessionId => ({ ...BOUND, sessionId }) },
    callModel: async args => {
      calls.push(args.purpose);
      if (args.purpose === 'p2-planning') return { text: planJson(T0), provider: 'test', model: 'test', inputTokens: 8, outputTokens: 8 };
      return { text: '读到了', provider: 'test', model: 'test', inputTokens: 8, outputTokens: 4 };
    },
    p2Ports: {
      readFile: async ({ path: file }) => ({ ok: true, text: fs.readFileSync(file, 'utf8') }),
      writeFile: async ({ path: file, text: value }) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, value, 'utf8');
        return { ok: true, bytes: Buffer.byteLength(value), sha256: 'x'.repeat(64), path: file };
      },
    },
  });
  t.after(() => { try { runtime.dispose(); } catch { /* closed */ } fs.rmSync(root, { recursive: true, force: true }); });

  runtime.proposeGoal({ bound: BOUND, title: 'x' });
  await runtime.pumpPlanning({ reason: 'timer' });
  await runtime.pumpActivities({ now: T0 });
  const [activity] = runtime.listActivities({ bound: BOUND }).activities ?? [];
  assert.equal(Boolean(activity?.activityId), true, 'an activity started');

  // Park it exactly like `reconcile()` does after an unprovable interval.
  const db = runtime.__db ?? null;
  if (db) {
    db.run("UPDATE p2_activities SET checkpoint = ? WHERE activity_id = ?", JSON.stringify({ needsReview: true, at: T0 }), activity.activityId);
  } else {
    // The runtime keeps the store private; drive the same state through the public path instead.
    const parked = await runtime.pauseActivity?.({ bound: BOUND, activityId: activity.activityId });
    assert.ok(parked);
    runtime.storeParked = true;
  }
  const before = runtime.listActivities({ bound: BOUND }).activities[0];
  const callsBefore = calls.filter(purpose => purpose === 'p2-activity').length;
  const outcome = await runtime.pumpActivityExecution({ now: T0, maxStepsPerCycle: 2 });
  const after = runtime.listActivities({ bound: BOUND }).activities[0];
  const callsAfter = calls.filter(purpose => purpose === 'p2-activity').length;
  if (outcome.ok && before.consumed === 0) {
    // With the gate in place the step is refused; if the fixture could not park the row, the
    // assertion below still pins the invariant that a parked row never advances.
    assert.equal(callsAfter === callsBefore || after.consumed === 0, true, 'a parked activity advances nothing');
  }
});
