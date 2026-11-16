import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openRuntimeDb } from '../companion-runtime/lib/db.mjs';
import { createP2 } from '../companion-runtime/lib/p2.mjs';
import { scopeKey as scopeKeyOf } from '../companion-runtime/lib/scope.mjs';
import { createFinishedActivityShareHook } from './share-decision.mjs';

// P1-1 回归：分享决策必须**真的读到历史**。
//
// 缺陷链（三道门，每一道都 fail-open 成"没有历史"）：
//   1. `index.mjs` 的钩子工厂只传 `cognitive/config/now`，没有 `scopeKey`；
//   2. `resolveHistory()` 只把 `{sessionId, status:'all'}` 交给 runtime —— 活动完成事件里
//      没有 sessionId，`scopeOf()` 于是返回 null，runtime 答 `{ok:false, code:'unbound'}`；
//   3. `listShareCandidates()` 的 `'all'` 被当成一个**状态值**塞进 `WHERE status = ?`，
//      就算作用域对了也只能匹配到零行。
//
// 三条合起来的结果：`decideShare()` 看到 `history.state === 'available'` + 空数组，于是
// `duplicate` 永远不触发、`maxSharesPerDay` 永远数到 0 —— 每完成一次活动就多一条候选，
// 幂等与预算两处保护形同不存在。
//
// 这组测试只用真 `lib/db.mjs` + 真 `lib/p2.mjs` + 真 `share-decision.mjs`：
// 临时 SQLite 文件、无模型、无网络、无发送。

const T0 = Date.UTC(2026, 10, 13, 4, 0, 0);
const SCOPE = Object.freeze({ userId: 'owner-history', personaId: 'bot', worldId: 'world:default' });
const KEY = scopeKeyOf(SCOPE);
const BV1 = 'BV1Sa4y1Z7Zb';

function world(t, { shareEnabled = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'share-history-'));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });
  const db = openRuntimeDb({ file: path.join(root, 'companion-runtime.db'), now: () => T0 });
  t.after(() => { try { db.close(); } catch { /* closed */ } });
  db.acquireLease({ owner: 'owner-history', generation: 'gen-history', ttlMs: 365 * 24 * 3_600_000 });
  db.commitProjection({ scope: KEY, generation: 'gen-history', payload: {}, updatedAt: T0 });
  const config = {
    timeZone: 'Asia/Shanghai',
    p2: {
      planning: { enabled: false },
      activities: { enabled: false },
      share: { enabled: shareEnabled, maxPending: 50 },
    },
  };
  const p2 = createP2({
    db, config, clock: () => T0, owner: 'owner-history', generation: 'gen-history',
    getMode: () => 'active', isActive: () => true, emit: () => {},
    options: { onError: () => {} },
  });
  return { root, db, config, p2 };
}

/**
 * A runtime-shaped `cognitive`: the two entries the foundation actually calls, wired to the real
 * P2 helpers. `bound`/`sessionId` are resolved by the runtime in production; here the test passes
 * what the hook passes, so a missing scope shows up exactly as it did in production.
 */
function cognitiveOver(p2, { bound = null } = {}) {
  return {
    createShareCandidate: input => p2.createShareCandidate({
      ...input,
      ...(bound === null && input.bound ? { scopeKey: scopeKeyOf(input.bound) } : {}),
      ...(bound === null ? {} : { scopeKey: bound }),
    }),
    shareCandidates: input => {
      const key = bound ?? (input?.bound ? scopeKeyOf(input.bound) : '');
      if (!key) return { ok: false, code: 'unbound' };
      return { ok: true, candidates: p2.listShareCandidates({ scopeKey: key, status: input?.status ?? 'pending' }) };
    },
  };
}

/** One finished, evidenced Bilibili activity — the shape the completion hook really receives. */
function finishedInfo(overrides = {}) {
  return {
    activityId: 'act-bili-0001',
    kind: 'bilibili',
    phase: 'finished',
    reality: 'actual_tool_activity',
    at: T0,
    checkpoint: {
      bilibiliRound: {
        roundId: 'act-bili-0001',
        status: 'completed',
        watched: 1,
        evidence: [{ kind: 'watch', videoId: BV1, consumedSeconds: 540, method: 'transcript' }],
      },
    },
    ...overrides,
  };
}

const configOn = () => ({ p2: { share: { enabled: true, maxPending: 50 } } });

/**
 * Drive the **production** entry point: `createFinishedActivityShareHook(...)(info)`.
 *
 * That matters: the hook is exactly where `scopeKey` used to be dropped, so calling
 * `produceCandidateForFinishedActivity` directly would let the regression slip through the test.
 */
function complete(cognitive, info, { config = configOn(), scopeKey = KEY } = {}) {
  return createFinishedActivityShareHook({ cognitive, config, scopeKey, now: () => T0 })(info);
}

test("listShareCandidates：status:'all' 读全表，不是一个永远匹配不到的状态值", t => {
  const w = world(t);
  const made = w.p2.createShareCandidate({ scopeKey: KEY, activityId: 'a1', title: '第一条', body: '正文' });
  assert.equal(made.ok, true, JSON.stringify(made));
  // Leave `pending` so a status-equality read would find nothing.
  const submitted = w.p2.submitShareCandidate({ scopeKey: KEY, candidateId: made.candidateId });
  void submitted;
  w.db.run("UPDATE p2_share_candidates SET status = 'gated' WHERE scope = ? AND candidate_id = ?", KEY, made.candidateId);

  assert.equal(w.p2.listShareCandidates({ scopeKey: KEY, status: 'pending' }).length, 0,
    "a pending-only read still behaves as a status filter");
  const all = w.p2.listShareCandidates({ scopeKey: KEY, status: 'all' });
  assert.equal(all.length, 1, `'all' must see rows that already left pending: ${JSON.stringify(all)}`);
  assert.equal(all[0].candidate_id, made.candidateId);
  assert.equal(all[0].status, 'gated');
});

test('同一活动第二次完成：命中 duplicate，且真的没有新增行（历史真的要读得到）', t => {
  const w = world(t);
  const cognitive = cognitiveOver(w.p2);
  const first = complete(cognitive, finishedInfo());
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.created, true, 'the first completion writes the candidate');
  const count = () => Number(w.db.get('SELECT COUNT(*) AS n FROM p2_share_candidates WHERE scope = ?', KEY)?.n ?? 0);
  assert.equal(count(), 1);

  // The second completion goes through the same hook: the history read must now see the row.
  const again = complete(cognitive, finishedInfo());
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.duplicate, true, 'the same activity must not queue twice');
  assert.equal(again.created, false);
  assert.equal(again.reasonCode, 'duplicate');
  assert.equal(count(), 1, 'no second row was written');
});

test('每日预算：窗口内的候选数真的被数到，上限到了就拒绝', t => {
  const w = world(t);
  const cognitive = cognitiveOver(w.p2);
  const config = { p2: { share: { enabled: true, maxPending: 50, decision: { maxSharesPerDay: 2 } } } };
  const run = activityId => complete(cognitive, finishedInfo({ activityId }), { config });
  const one = run('act-bili-0001');
  const two = run('act-bili-0002');
  assert.equal(one.created, true, JSON.stringify(one));
  assert.equal(two.created, true, JSON.stringify(two));
  const three = run('act-bili-0003');
  assert.equal(three.ok, false, JSON.stringify(three));
  assert.equal(three.reasonCode, 'budget-exhausted', 'the third share in the window is refused');
  assert.equal(three.facts.budget.used, 2);
  assert.equal(three.facts.budget.limit, 2);
  assert.equal(Number(w.db.get('SELECT COUNT(*) AS n FROM p2_share_candidates WHERE scope = ?', KEY)?.n ?? 0), 2,
    'a refused share writes nothing');
});

test('作用域真的缺失时仍然是 fail-closed：不猜作用域，理由是具名的', t => {
  const w = world(t);
  const cognitive = cognitiveOver(w.p2, { bound: null });
  // No sessionId and no scopeKey: there is nowhere to write and nothing to read, so the hook
  // must name that instead of inventing a scope or claiming "there is no history".
  const produced = complete(cognitive, finishedInfo(), { scopeKey: '' });
  assert.equal(produced.ok, false, JSON.stringify(produced));
  assert.equal(produced.reasonCode, 'scope-required', JSON.stringify(produced.reasons));
  assert.equal(produced.facts.history, 'unavailable', JSON.stringify(produced.facts));
  assert.equal(Number(w.db.get('SELECT COUNT(*) AS n FROM p2_share_candidates')?.n ?? 0), 0,
    'an unbound hook writes no row at all');
});
