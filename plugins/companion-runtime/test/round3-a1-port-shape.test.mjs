import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openRuntimeDb } from '../lib/db.mjs';
import { applyActivityEvent, createActivities, prepareFailurePhase } from '../lib/activities.mjs';
import { dispatchEvent } from '../lib/events.mjs';
import { scopeKey as scopeKeyOf } from '../lib/scope.mjs';

// round-3 A1：真实 FD 网页端口的**两种返回值**必须走两条不同的路。
//
//   { ok:false, noAnswer:true }   → 没拿到答案 → `unknown`，**不许重试**（可能已经打到对方）
//   { ok:false, status:404, … }   → 拿到了否定答案 → `failed`，允许重试
//
// 这里造的不是"注入一个抛错的 port"（那种形状之前已覆盖），而是
// `autonomy-web.mjs` / `autonomy-host-web.mjs` 真正返回的对象。

const T0 = Date.UTC(2026, 10, 14, 3, 0, 0);
const HOUR = 3_600_000;
const SCOPE = Object.freeze({ userId: 'owner-1', personaId: 'march7', worldId: 'world:default' });
const KEY = scopeKeyOf(SCOPE);

function world(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'round3-a1-'));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }); } catch { /* best effort */ } });
  const db = openRuntimeDb({ file: ':memory:', now: () => T0 });
  t.after(() => { try { db.close(); } catch { /* closed */ } });
  db.acquireLease({ owner: 'owner-test', generation: 'gen-1', ttlMs: 365 * 24 * 3600 * 1000 });
  db.commitProjection({ scope: KEY, generation: 'gen-1', payload: {}, updatedAt: T0 });
  db.run(`INSERT INTO p2_plans (plan_id, scope, day, version, status, time_zone, window_start, window_end, summary, source_run_id, supersedes, created_at, committed_at)
          VALUES ('plan-1', ?, '2026-11-14', 1, 'committed', 'Asia/Shanghai', ?, ?, '', '', '', ?, ?)`,
  KEY, T0 - 6 * HOUR, T0 + 6 * HOUR, T0, T0);
  db.run(`INSERT INTO p2_plan_slots (slot_id, plan_id, scope, day, start_at, end_at, kind, activity, title, detail,
            flexibility, intent, target_ref, status, locked, created_at, updated_at)
          VALUES ('slot-a1', 'plan-1', ?, '2026-11-14', ?, ?, 'activity', 'explore', '看一页', '{}', 'soft', '', 'https://example.test/a', 'planned', 0, ?, ?)`,
  KEY, T0 - HOUR, T0 + HOUR, T0, T0);
  return { db, root };
}

/** The real dispatcher: the effect ledger is written by the `autonomy` handler, not by a stub. */
function dispatcher(db) {
  return event => dispatchEvent(db, event, { handlers: { autonomy: applyActivityEvent }, generation: 'gen-1' });
}

function controller(db, root, fetchPage) {
  return createActivities({
    db, dispatch: dispatcher(db), owner: 'owner-test', generation: 'gen-1', clock: () => T0,
    workspace: root, onError: () => {},
    ports: { fetchPage, async readFile() { return { ok: false }; }, async writeFile() { return { ok: false }; } },
    config: {
      timeZone: 'Asia/Shanghai',
      p2: {
        activities: { enabled: true, paused: false, effectDeadlineMs: 60000, chunkUnits: 100, maxUnitsPerStep: 3000, maxSourceBytes: 200000, maxTotalUnits: 200000, maxExcerptChars: 400, draftsDir: 'drafts' },
        planning: { enabled: true },
        autonomy: { allowedSources: ['example.test'] },
      },
    },
  });
}

/** What the lifecycle layer would record for the failure the adapter raised. */
function recordedPhase(error) {
  return prepareFailurePhase({
    kind: 'explore',
    code: String(error?.code ?? ''),
    ioStarted: true,
    noEffect: error?.noEffect === true,
    // A `noAnswer` failure is explicitly "we learned nothing", never "the site said no".
    typed: error?.noAnswer === true ? false : true,
  });
}

const cases = [
  ['noAnswer:true（没拿到答案）', { ok: false, code: 'source-fetch-failed', reason: 'ECONNRESET', noAnswer: true }, 'unknown'],
  ['host-fetch-unavailable（没有 transport）', { ok: false, code: 'host-fetch-unavailable', reason: 'DSH Fetch not mounted', noAnswer: true }, 'unknown'],
  ['status 404（拿到了否定答案）', { ok: false, code: 'source-fetch-failed', status: 404, reason: 'http-404' }, 'failed'],
];

for (const [label, answer, expected] of cases) {
  test(`A1：真实 FD 端口返回 ${label} → 记成 ${expected}`, async t => {
    const { db, root } = world(t);
    const calls = [];
    const activities = controller(db, root, async () => { calls.push(1); return answer; });
    let error = null;
    try {
      await Promise.resolve(activities.start({ slotId: 'slot-a1', kind: 'explore' }));
    } catch (caught) {
      error = caught;
    }
    assert.equal(calls.length, 1, 'the real port was called once');
    assert.ok(error, 'the activity did not silently succeed');
    // The adapter must carry the distinction it was given; without this the lifecycle layer cannot
    // classify the failure and every "no answer" would look like a definite one (A1's whole point).
    if (expected === 'unknown') {
      assert.equal(error?.noAnswer, true, 'the adapter keeps "no answer" on the failure');
    } else {
      assert.notEqual(error?.noAnswer, true, 'a definite answer must not be labelled "no answer"');
    }
    assert.equal(recordedPhase(error), expected,
      `a ${expected === 'unknown' ? 'missing answer' : 'definite refusal'} must be recorded as ${expected} (got ${recordedPhase(error)}, code ${error?.code})`);
  });
}

// ⚠️ KNOWN DEFECT（未修完）：实测 phases=[]、calls=2 —— noAnswer 之后**没有落任何生命周期记录**，
// 所以第二次 start 仍会外呼。断言保留在这里，作为“这条没修好”的证据；修好后把 .skip 去掉。
test('A1 的核心：noAnswer → unknown → **第二次 start 被拒**，外呼计数仍为 1', async t => {
  const { db, root } = world(t);
  let calls = 0;
  const activities = controller(db, root, async () => {
    calls += 1;
    return { ok: false, code: 'source-fetch-failed', reason: 'ECONNRESET', noAnswer: true };
  });

  let first = null;
  try { await Promise.resolve(activities.start({ slotId: 'slot-a1', kind: 'explore' })); }
  catch (error) { first = error; }
  assert.ok(first, 'the first attempt failed');
  assert.equal(first.noAnswer, true, 'and it was classified as "no answer"');
  assert.equal(calls, 1);

  // The effects ledger must say unknown — that is what blocks the retry.
  const effects = activities.effects({ scopeKey: KEY }).effects ?? [];
  const phases = effects.map(item => String(item.phase));

  // The point of the whole fix: a retry must be refused, or "no answer" still causes a second call.
  let second = null;
  try { await Promise.resolve(activities.start({ slotId: 'slot-a1', kind: 'explore' })); }
  catch (error) { second = error; }
  assert.equal(calls, 1, `the outside world was called exactly once (phases ${JSON.stringify(phases)}, second ${String(second?.code ?? 'SUCCEEDED')})`);
  assert.ok(second, 'the second start was refused');
  assert.equal(['effect-unknown', 'effect-in-flight'].includes(String(second.code)), true,
    'refused with a code that means "we do not know", got ' + String(second.code));
});
