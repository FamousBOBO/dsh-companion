import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { mountRuntime } from '../index.mjs';

// F 包的接线契约：`onActivityFinished` 是 `p2ActivityFinished` 里唯一一条「完成 → 候选」的边。
//
// 这一组用**真 runtime + 真 SQLite + 真活动行**，候选生产者是合成桩，因此它验证的是**接线**
// （钩子被不被调用、拿到什么、在 memory ingest 之前还是之后、抛错会不会传染），不是决策质量
// ——后者由 `companion-foundation/share-decision.test.mjs` 的 35 条用例覆盖。
//
// 三条不能回归的性质：
//   1. 钩子只在结算路径被调用，且**在 memory ingest 之后**（记忆是持久的那一半）；
//   2. 钩子抛错不得让结算失败（返回的 `ok` 仍然是 memory ingest 的结果）；
//   3. 钩子拿到的是**活动行里的真 checkpoint**（B 站的观看证据在那里，不在 consumedPrefix）。

const T0 = Date.UTC(2026, 10, 14, 3, 0, 0);
const SESSION = 'share-hook-session';

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-share-hook-'));
  for (const dir of ['home/companion', 'logs', 'workspace']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, 'workspace/PERSONA.md'), 'bot\n', 'utf8');
  fs.writeFileSync(path.join(root, 'home/companion/runtime.config.json'), JSON.stringify({
    enabled: true, mode: 'active', timeZone: 'Asia/Shanghai',
    p2: { planning: { enabled: false }, activities: { enabled: false }, share: { enabled: true, maxPending: 5 } },
  }), 'utf8');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ } });
  return root;
}

/** A memory port that says yes to everything: this suite is about the runtime's wiring, not memory's. */
function acceptingMemory() {
  return { async ingestDomainEvent() { return { status: 'accepted', receiptId: 'r', recordId: 'm' }; } };
}

async function mounted(t, { onActivityFinished = null } = {}) {
  const root = tempRoot(t);
  const runtime = mountRuntime(null, root, {
    now: () => T0,
    identity: { resolve: sessionId => ({ userId: 'owner-1', persona: 'bot', sessionId }) },
    memory: acceptingMemory(),
    onActivityFinished,
  });
  t.after(() => { try { runtime.dispose?.(); } catch { /* disposed */ } });
  const scopeKey = runtime.status({ sessionId: SESSION }).scopeKey;
  const db = new DatabaseSync(path.join(root, 'home/companion/companion-runtime.db'));
  t.after(() => { try { db.close(); } catch { /* closed */ } });
  return { runtime, root, scopeKey, db };
}

/**
 * Seed one settled activity row. `checkpoint` is written verbatim so the hook's read-back path is
 * exercised with the same shape production stores (`activities.mjs` writes `{bilibiliRound: …}`).
 */
function seedActivity(db, { id, scope, kind = 'read', target, status, consumed = 0, total = 0, version = 0, checkpoint = null, reality = 'actual_tool_activity', at = T0 }) {
  const checkpointText = checkpoint === null ? '' : JSON.stringify(checkpoint);
  db.prepare(`INSERT INTO p2_activities
    (activity_id, scope, kind, target, status, consumed_prefix, total_units, artifact_version, checkpoint, reality, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(activity_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`)
    .run(id, scope, kind, target, status, consumed, total, version, checkpointText, reality, at, at);
}

test('结算一条 write 活动：钩子被调用一次，拿到 activityId / checkpoint / receiptId', async t => {
  const calls = [];
  const { runtime, scopeKey, db } = await mounted(t, {
    onActivityFinished: info => { calls.push(info); return { ok: true, reasonCode: 'share-ok' }; },
  });

  seedActivity(db, { id: 'act-write-1', scope: scopeKey, kind: 'write', target: 'drafts/hook-check.md',
    status: 'done', consumed: 140, total: 140, version: 3,
    checkpoint: { unit: 'chars', adapter: 'write', title: 'hook-check', slug: 'hook-check' } });

  const finished = await runtime.recordActivityOutcome({
    scopeKey, activityId: 'act-write-1', kind: 'write', target: 'drafts/hook-check.md',
    phase: 'finished', reality: 'actual_tool_activity', at: T0 + 60_000,
    consumedPrefix: 0, totalUnits: 0, artifactVersion: 3,
  });
  assert.equal(finished?.ok, true, JSON.stringify(finished));

  assert.equal(calls.length, 1, 'exactly one completion-hook call');
  const info = calls[0];
  assert.equal(info.activityId, 'act-write-1');
  assert.equal(info.phase, 'finished');
  assert.equal(info.kind, 'write');
  assert.equal(info.reality, 'actual_tool_activity');
  assert.equal(info.scopeKey, scopeKey);
  // checkpoint 形状：宁可空对象，不能是 undefined（生产侧要读 `checkpoint.bilibiliRound`）。
  assert.equal(typeof info.checkpoint, 'object');
  assert.ok(info.checkpoint && !Array.isArray(info.checkpoint), 'checkpoint is a plain object');
  assert.equal(info.checkpoint.adapter, 'write', 'the hook reads the row, not the caller');
});

test('B站活动：checkpoint 里的 bilibiliRound 原样到达钩子（消费前缀对它恒为 0）', async t => {
  const calls = [];
  const { runtime, scopeKey, db } = await mounted(t, {
    onActivityFinished: info => { calls.push(info); return { ok: true }; },
  });

  const round = {
    roundId: 'act-bili-1', status: 'completed', watched: 3,
    evidence: [{ kind: 'watch', videoId: 'BV1xx411c7mD', consumedSeconds: 480, method: 'transcript' }],
  };
  seedActivity(db, { id: 'act-bili-1', scope: scopeKey, kind: 'bilibili', target: 'bilibili:duty',
    status: 'done', consumed: 0, total: 0, checkpoint: { unit: 'round', bilibiliRound: round }, at: T0 });

  const finished = await runtime.recordActivityOutcome({
    scopeKey, activityId: 'act-bili-1', kind: 'bilibili', target: 'bilibili:duty',
    phase: 'finished', reality: 'actual_tool_activity', at: T0 + 30_000,
    consumedPrefix: 0, totalUnits: 0,
  });
  assert.equal(finished?.ok, true, JSON.stringify(finished));
  assert.equal(calls.length, 1);
  const passed = calls[0].checkpoint?.bilibiliRound;
  assert.ok(passed, 'the round evidence reaches the hook');
  assert.equal(passed.watched, 3);
  assert.equal(passed.evidence[0].method, 'transcript', 'the transcript marker survives the read-back');
  // 单位陷阱：B 站活动行的 `consumed_prefix` 恒 0，`p2ActivityFinished` 用它自己从 checkpoint 里
  // 读到的 `watched` 覆盖，所以到达钩子的是**视频数**（3），不是秒数、也不是行里的 0。
  assert.equal(calls[0].consumedPrefix, 3, 'the hook receives the watched count, not the row’s 0 prefix');
});

test('钩子抛错不影响结算：返回值仍是 memory ingest 的结果，且失败被记进诊断', async t => {
  const { runtime, scopeKey, db } = await mounted(t, {
    onActivityFinished: () => { throw new Error('hook exploded'); },
  });
  seedActivity(db, { id: 'act-throw', scope: scopeKey, kind: 'write', target: 'drafts/hook-throw.md',
    status: 'done', consumed: 20, version: 1 });

  const finished = await runtime.recordActivityOutcome({
    scopeKey, activityId: 'act-throw', kind: 'write', target: 'drafts/hook-throw.md',
    phase: 'finished', reality: 'actual_tool_activity', at: T0 + 60_000, artifactVersion: 1,
  });
  assert.equal(finished?.ok, true, 'a throwing hook must not fail the settlement');
  const statusText = JSON.stringify(runtime.status({ sessionId: SESSION })?.errors ?? []);
  assert.match(statusText, /p2-share-hook-failed/, 'the hook failure is recorded, not silently swallowed');
});

test('失败的活动也走同一条边，phase 与 reason 如实传下去', async t => {
  const calls = [];
  const { runtime, scopeKey, db } = await mounted(t, {
    onActivityFinished: info => { calls.push(info); return { ok: false, reasonCode: 'not-done' }; },
  });
  seedActivity(db, { id: 'act-fail-1', scope: scopeKey, kind: 'write', target: 'drafts/hook-fail.md',
    status: 'failed', consumed: 0, total: 0 });

  await runtime.recordActivityOutcome({
    scopeKey, activityId: 'act-fail-1', kind: 'write', target: 'drafts/hook-fail.md',
    phase: 'failed', reason: 'workspace-denied', reality: 'actual_tool_activity', at: T0 + 60_000,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].phase, 'failed');
  assert.equal(calls[0].reason, 'workspace-denied');
});

test('没装钩子时结算行为不变：ok 为真、零错误', async t => {
  const { runtime, scopeKey, db } = await mounted(t, { onActivityFinished: null });
  seedActivity(db, { id: 'act-no-hook', scope: scopeKey, kind: 'write', target: 'drafts/no-hook.md',
    status: 'done', consumed: 30, version: 1 });

  const finished = await runtime.recordActivityOutcome({
    scopeKey, activityId: 'act-no-hook', kind: 'write', target: 'drafts/no-hook.md',
    phase: 'finished', reality: 'actual_tool_activity', at: T0 + 60_000, artifactVersion: 1,
  });
  assert.equal(finished?.ok, true, JSON.stringify(finished));
  const statusText = JSON.stringify(runtime.status({ sessionId: SESSION })?.errors ?? []);
  assert.doesNotMatch(statusText, /share-hook/, 'no hook means no hook diagnostics');
});
