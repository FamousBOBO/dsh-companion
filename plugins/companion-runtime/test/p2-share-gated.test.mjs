import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openRuntimeDb } from '../lib/db.mjs';
import { createP2 } from '../lib/p2.mjs';
import { p2Observability } from '../lib/observability.mjs';
import { retryBackoffMs } from '../lib/bridge.mjs';
import { scopeKey as scopeKeyOf } from '../lib/scope.mjs';

// task-42：`gated` 不是一种东西。
//
// 缺陷：把所有 gate 拒绝都写成终态 `gated` = **永久丢候选**。可免打扰（明天早上就好）、配额（明天
// 重置）、冷却（等一会儿）这三类，等一等就能发；只有"开关关着/重复/没主人/太久"才是真的不该重试。
//
// 这组测试的核心是第 1 条：`quiet-hours` 之后**推进时钟**，候选必须真的被再次选中并投递成功。

const T0 = Date.UTC(2026, 10, 11, 3, 0, 0);
const MINUTE = 60_000;
const DAY = 24 * 3600_000;
const SCOPE = Object.freeze({ userId: 'owner-1', personaId: 'march7', worldId: 'world:default' });
const KEY = scopeKeyOf(SCOPE);

function world(t, { shareEnabled = true, now = () => T0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-share-gated-'));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }); } catch { /* best effort */ } });
  const db = openRuntimeDb({ file: ':memory:', now });
  t.after(() => { try { db.close(); } catch { /* closed */ } });
  db.acquireLease({ owner: 'owner-test', generation: 'gen-test', ttlMs: 365 * 24 * 3600 * 1000 });
  db.commitProjection({ scope: KEY, generation: 'gen-test', payload: {}, updatedAt: T0 });
  const config = {
    timeZone: 'Asia/Shanghai',
    p2: { planning: { enabled: false }, activities: { enabled: false }, share: { enabled: shareEnabled, maxPending: 50 } },
  };
  return { db, root, config };
}

function controller(db, config, { clock = () => T0, submit = null, calls } = {}) {
  const seen = calls ?? [];
  const port = { async submit(payload) { seen.push(payload); return submit ? submit(payload, seen.length) : { ok: true }; } };
  return createP2({
    db, config, clock, owner: 'owner-test', generation: 'gen-test',
    getMode: () => 'active', isActive: () => true,
    emit: () => {}, options: { sharePort: port, onError: () => {} },
  });
}

const rowOf = (db, id) => db.get('SELECT status, decision_reason, created_at FROM p2_share_candidates WHERE candidate_id = ?', id) ?? {};
const retryOf = (db, id) => {
  const row = db.get('SELECT meta_value FROM runtime_meta WHERE meta_key = ?', `p2_share_retry:${id}`);
  return row ? JSON.parse(String(row.meta_value)) : null;
};

test('quiet-hours → 可重试：退避到期后真的被再次选中并投递', async t => {
  const { db, config } = world(t);
  const calls = [];
  let now = T0;
  const p2 = controller(db, config, {
    clock: () => now,
    calls,
    submit: () => (now === T0 ? { ok: false, code: 'quiet-hours' } : { ok: true }),
  });

  const made = p2.createShareCandidate({ scopeKey: KEY, title: '想分享的发现', body: '正文' });
  assert.equal(made.ok, true, JSON.stringify(made));

  const first = await p2.deliverShareCandidates({ scopeKey: KEY });
  assert.equal(first.retryableGated, 1, JSON.stringify(first));
  assert.equal(calls.length, 1);
  const state = retryOf(db, made.candidateId);
  assert.ok(state, 'a retryable gate leaves a retry-book row');
  assert.equal(state.attempts, 1);
  assert.equal(state.nextAttemptAt, T0 + retryBackoffMs(1), 'next attempt uses the outbox backoff curve');
  assert.equal(rowOf(db, made.candidateId).status, 'gated', 'the row is not lost, it is waiting');

  // Before the backoff elapses it is not retried.
  now = T0 + 1000;
  const tooEarly = await p2.deliverShareCandidates({ scopeKey: KEY });
  assert.equal(tooEarly.examined, 0, 'not eligible yet');
  assert.equal(calls.length, 1);

  // After the quiet hours are over it really is picked up and delivered.
  now = T0 + retryBackoffMs(1) + MINUTE;
  const second = await p2.deliverShareCandidates({ scopeKey: KEY });
  assert.equal(second.queued, 1, JSON.stringify(second));
  assert.equal(calls.length, 2, 'the candidate was offered again — it was not dropped');
  assert.equal(rowOf(db, made.candidateId).status, 'queued');
  assert.equal(retryOf(db, made.candidateId), null, 'the retry book is cleared once it is queued');
});

test('quota → 同样可重试（配额重置后能发出去）', async t => {
  const { db, config } = world(t);
  const calls = [];
  let now = T0;
  const p2 = controller(db, config, {
    clock: () => now,
    calls,
    submit: () => (now === T0 ? { ok: false, code: 'quota' } : { ok: true }),
  });
  const made = p2.createShareCandidate({ scopeKey: KEY, title: '配额用完了', body: '正文' });

  await p2.deliverShareCandidates({ scopeKey: KEY });
  assert.equal(retryOf(db, made.candidateId)?.attempts, 1);

  now = T0 + retryBackoffMs(1) + MINUTE;
  const again = await p2.deliverShareCandidates({ scopeKey: KEY });
  assert.equal(again.queued, 1, JSON.stringify(again));
  assert.equal(rowOf(db, made.candidateId).status, 'queued');
});

test('share-disabled → 终态：推进 7 天也不重试', async t => {
  const { db, config } = world(t, { shareEnabled: false });
  const calls = [];
  let now = T0;
  const p2 = controller(db, config, { clock: () => now, calls });
  const made = p2.createShareCandidate({ scopeKey: KEY, title: '开关关着', body: '正文', activityId: 'seed-1' });

  // A candidate produced while enabled (the switch can be turned off afterwards).
  const enabled = controller(db, { ...config, p2: { ...config.p2, share: { enabled: true } } }, { clock: () => now, calls });
  const queued = enabled.createShareCandidate({ scopeKey: KEY, activityId: 'seed-2', title: '旧的候选', body: '正文' });
  assert.equal(queued.ok, true, JSON.stringify(queued));

  const result = await p2.deliverShareCandidates({ scopeKey: KEY });
  assert.equal(result.terminalGated, 1, JSON.stringify(result));
  assert.equal(retryOf(db, queued.candidateId), null, 'a terminal gate leaves no retry book');
  assert.equal(rowOf(db, queued.candidateId).status, 'gated');
  assert.equal(calls.length, 0, 'the contact owner is never called while sharing is off');

  now = T0 + 7 * DAY;
  const later = await p2.deliverShareCandidates({ scopeKey: KEY });
  assert.equal(later.examined, 0, 'a terminal gate is never picked up again');
  assert.equal(calls.length, 0);
  assert.equal(made.ok, false, 'and while disabled no new candidate can be created either');
});

test('连续失败到 maxAttempts → 转 expired，原因可查', async t => {
  const { db, config } = world(t);
  let now = T0;
  const calls = [];
  const p2 = controller(db, config, { clock: () => now, calls, submit: () => ({ ok: false, code: 'cooldown' }) });
  const made = p2.createShareCandidate({ scopeKey: KEY, title: '一直被冷却', body: '正文' });

  let last = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    last = await p2.deliverShareCandidates({ scopeKey: KEY });
    const state = retryOf(db, made.candidateId);
    if (!state) break;
    now = state.nextAttemptAt + 1;
  }
  assert.equal(last.expired >= 1, true, JSON.stringify(last));
  const row = rowOf(db, made.candidateId);
  assert.equal(row.status, 'expired');
  assert.equal(String(row.decision_reason).startsWith('expired:cooldown'), true, `reason is kept: ${row.decision_reason}`);
  assert.equal(retryOf(db, made.candidateId), null, 'an expired candidate has no retry book');
});

test('超过 expiresAt → 直接 expired（不看 attempts）', async t => {
  const { db, config } = world(t);
  let now = T0;
  const calls = [];
  const p2 = controller(db, config, { clock: () => now, calls, submit: () => ({ ok: false, code: 'quiet-hours' }) });
  const made = p2.createShareCandidate({ scopeKey: KEY, title: '太久了', body: '正文' });

  await p2.deliverShareCandidates({ scopeKey: KEY });
  const state = retryOf(db, made.candidateId);
  assert.equal(state.attempts, 1);

  // Jump past the TTL: one more refusal must expire it even though attempts is far from the cap.
  now = state.expiresAt + 1;
  const result = await p2.deliverShareCandidates({ scopeKey: KEY });
  assert.equal(result.expired, 1, JSON.stringify(result));
  const row = rowOf(db, made.candidateId);
  assert.equal(row.status, 'expired');
  assert.equal(String(row.decision_reason).startsWith('expired:quiet-hours'), true);
});

test('诊断：gated_retryable 与 gated_terminal 分开计数，sent 仍 not-wired', async t => {
  const { db, config } = world(t);
  let now = T0;
  const calls = [];
  let submitCount = 0;
  const p2 = controller(db, config, {
    clock: () => now,
    calls,
    submit: () => {
      submitCount += 1;
      // First candidate → retryable gate, second → terminal gate.
      return submitCount === 1 ? { ok: false, code: 'quiet-hours' } : { ok: false, code: 'dedupe' };
    },
  });
  p2.createShareCandidate({ scopeKey: KEY, activityId: 'a1', title: '可重试', body: '正文' });
  p2.createShareCandidate({ scopeKey: KEY, activityId: 'a2', title: '终态', body: '正文' });

  const result = await p2.deliverShareCandidates({ scopeKey: KEY });
  assert.equal(result.retryableGated, 1, JSON.stringify(result));
  assert.equal(result.terminalGated, 1, JSON.stringify(result));

  const share = p2Observability(db, { scopeKey: KEY, now: now + 1000, switches: { activities: false, planning: false } }).groups.share;
  assert.equal(share.metrics.gated_retryable.value, 1, 'the one that is waiting for the window');
  assert.equal(share.metrics.gated_retryable.honest, 'measured');
  assert.equal(share.metrics.gated_terminal.value, 1, 'the one that will never be sent');
  assert.equal(share.metrics.gated_terminal.honest, 'measured');
  assert.equal(share.metrics.sent.value, null);
  assert.equal(share.metrics.sent.honest, 'not-wired');
});
