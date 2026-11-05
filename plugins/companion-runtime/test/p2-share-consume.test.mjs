import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openRuntimeDb } from '../lib/db.mjs';
import { createP2 } from '../lib/p2.mjs';
import { p2Observability } from '../lib/observability.mjs';
import { scopeKey as scopeKeyOf } from '../lib/scope.mjs';

// P2.5-3B（runtime 侧）：`p2_share_candidates` 终于有消费者，而且**回执语义诚实**。
//
// 关键点（QQ 侧明确说过）：`submitShareCandidate` 的 `ok:true` 只代表**已入库**，不代表已发出，
// 也不代表闸门评估过。所以这里钉的全是"不许冒充已发送"：
//   - 成功 → 候选标 `queued`（**不是 `sent`**）；
//   - 被拒/开关关闭 → `gated` + 具体 reason；
//   - 每 tick 有界（≤5）、同一候选只提交一次；
//   - `share.enabled=false` 时不调端口；
//   - 诊断里 `queued`/`gated` 是 measured，`sent` 仍是 `not-wired`。

const T0 = Date.UTC(2026, 10, 9, 3, 0, 0);
const SCOPE = Object.freeze({ userId: 'owner-1', personaId: 'bot', worldId: 'world:default' });
const KEY = scopeKeyOf(SCOPE);

function world(t, { shareEnabled = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-share3b-'));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }); } catch { /* best effort */ } });
  const db = openRuntimeDb({ file: ':memory:', now: () => T0 });
  t.after(() => { try { db.close(); } catch { /* closed */ } });
  // The P2 writer must hold the lease: every candidate update asserts it.
  db.acquireLease({ owner: 'owner-test', generation: 'gen-test', ttlMs: 600000 });
  db.commitProjection({ scope: KEY, generation: 'gen-test', payload: {}, updatedAt: T0 });
  const config = {
    timeZone: 'Asia/Shanghai',
    p2: {
      planning: { enabled: false },
      activities: { enabled: false },
      share: { enabled: shareEnabled, maxPending: 50 },
    },
  };
  return { db, root, config };
}

function controller(db, config, { sharePort = null, calls = [] } = {}) {
  const port = sharePort ?? {
    async submit(payload) { calls.push(payload); return { ok: true }; },
  };
  return createP2({
    db, config, clock: () => T0, owner: 'owner-test', generation: 'gen-test',
    getMode: () => 'active', isActive: () => true,
    emit: () => {}, options: { sharePort: port, onError: () => {} },
  });
}

const statusOf = (db, id) => db.get('SELECT status, decision_reason FROM p2_share_candidates WHERE candidate_id = ?', id) ?? {};

test('候选 → 投递一次 → 标 queued（不是 sent）', async t => {
  const { db, config } = world(t);
  const calls = [];
  const p2 = controller(db, config, { calls });

  const created = p2.createShareCandidate({ scopeKey: KEY, title: '今天的路边', body: '看到一只猫' });
  assert.equal(created.ok, true, JSON.stringify(created));

  const result = await p2.deliverShareCandidates({ scopeKey: KEY, limit: 5 });
  assert.equal(result.queued, 1, JSON.stringify(result));
  assert.equal(calls.length, 1, 'the contact owner saw exactly one candidate');
  assert.equal(calls[0].candidateId, created.candidateId);

  const row = statusOf(db, created.candidateId);
  assert.equal(row.status, 'queued', 'a receipt means "stored in the contact queue", not "sent"');
  assert.equal(row.decision_reason, 'contact-queued');
  assert.notEqual(row.status, 'sent');
});

test('share 关闭 → 标 gated + reason=share-disabled，且不调端口', async t => {
  const { db, config } = world(t, { shareEnabled: false });
  const calls = [];
  const p2 = controller(db, config, { calls });

  // A candidate produced while enabled (the switch can be turned off afterwards).
  const enabledConfig = { ...config, p2: { ...config.p2, share: { enabled: true } } };
  const enabled = controller(db, enabledConfig, { calls });
  const created = enabled.createShareCandidate({ scopeKey: KEY, title: '旧的候选', body: '正文' });
  assert.equal(created.ok, true);

  const result = await p2.deliverShareCandidates({ scopeKey: KEY, limit: 5 });
  assert.equal(result.gated, 1, JSON.stringify(result));
  assert.equal(result.skipped, 'share-disabled');
  assert.equal(calls.length, 0, 'the contact owner is never called while share is off');

  const row = statusOf(db, created.candidateId);
  assert.equal(row.status, 'gated');
  assert.equal(row.decision_reason, 'share-disabled');
});

test('端口拒绝（闸门）→ gated + 端口给的 reason', async t => {
  const { db, config } = world(t);
  const calls = [];
  const p2 = controller(db, config, {
    calls,
    sharePort: { async submit(payload) { calls.push(payload); return { ok: false, code: 'quiet-hours' }; } },
  });
  const created = p2.createShareCandidate({ scopeKey: KEY, title: '深夜候选', body: '正文' });
  const result = await p2.deliverShareCandidates({ scopeKey: KEY, limit: 5 });
  assert.equal(result.gated, 1, JSON.stringify(result));
  assert.equal(result.reasons['quiet-hours'], 1, 'the reason code is kept, not overwritten by "rejected"');
  const row = statusOf(db, created.candidateId);
  assert.equal(row.status, 'gated');
  assert.equal(row.decision_reason, 'quiet-hours');
});

test('同一候选重复 tick → 只提交一次（幂等）', async t => {
  const { db, config } = world(t);
  const calls = [];
  const p2 = controller(db, config, { calls });
  const created = p2.createShareCandidate({ scopeKey: KEY, title: '只该投一次', body: '正文' });

  await p2.deliverShareCandidates({ scopeKey: KEY, limit: 5 });
  await p2.deliverShareCandidates({ scopeKey: KEY, limit: 5 });
  await p2.deliverShareCandidates({ scopeKey: KEY, limit: 5 });

  assert.equal(calls.length, 1, 'a queued candidate leaves `pending`, so it is never offered twice');
  assert.equal(statusOf(db, created.candidateId).status, 'queued');
});

test('每 tick 有界：塞 10 条只处理 ≤5 条', async t => {
  const { db, config } = world(t);
  const calls = [];
  const p2 = controller(db, config, { calls });
  for (let index = 0; index < 10; index += 1) {
    const made = p2.createShareCandidate({ scopeKey: KEY, activityId: `act-${index}`, title: `候选 ${index}`, body: '正文' });
    assert.equal(made.ok, true, JSON.stringify(made));
  }
  const first = await p2.deliverShareCandidates({ scopeKey: KEY, limit: 5 });
  assert.equal(first.examined, 5, 'bounded to five per call');
  assert.equal(calls.length, 5);
  const stillPending = Number(db.get("SELECT COUNT(*) AS n FROM p2_share_candidates WHERE scope = ? AND status = 'pending'", KEY)?.n ?? 0);
  assert.equal(stillPending, 5, 'the rest stays pending for the next tick');

  const tooBig = await p2.deliverShareCandidates({ scopeKey: KEY, limit: 99 });
  assert.equal(tooBig.examined, 5, 'the cap is enforced even when the caller asks for more');
});

test('share.enabled=false 时不产生候选', async t => {
  const { db, config } = world(t, { shareEnabled: false });
  const p2 = controller(db, config);
  const made = p2.createShareCandidate({ scopeKey: KEY, title: '不该被创建', body: '正文' });
  assert.equal(made.ok, false);
  assert.equal(made.code, 'share-disabled');
  assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM p2_share_candidates WHERE scope = ?', KEY)?.n ?? 0), 0);
});

test('诊断第 7 类：queued/gated 是 measured，sent 仍是 not-wired', async t => {
  const { db, config } = world(t);
  const p2 = controller(db, config);
  const okOne = p2.createShareCandidate({ scopeKey: KEY, activityId: 'a1', title: '会被排队', body: '正文' });
  const gatedOne = p2.createShareCandidate({ scopeKey: KEY, activityId: 'a2', title: '会被拒', body: '正文' });
  assert.equal(okOne.ok, true);
  assert.equal(gatedOne.ok, true);

  // One queued, one gated: two different port answers in the same tick.
  let call = 0;
  const p2b = controller(db, config, {
    sharePort: { async submit() { call += 1; return call === 1 ? { ok: true } : { ok: false, code: 'quota' }; } },
  });
  const result = await p2b.deliverShareCandidates({ scopeKey: KEY, limit: 5 });
  assert.equal(result.queued, 1, JSON.stringify(result));
  assert.equal(result.gated, 1, JSON.stringify(result));

  const share = p2Observability(db, { scopeKey: KEY, now: T0 + 1000, switches: { activities: false, planning: false } }).groups.share;
  assert.equal(share.metrics.queued.value, 1);
  assert.equal(share.metrics.queued.honest, 'measured');
  assert.equal(share.metrics.gated.value, 1);
  assert.equal(share.metrics.gated.honest, 'measured');
  assert.equal(share.metrics.sent.value, null, 'a real send is not observable here ⇒ null');
  assert.equal(share.metrics.sent.honest, 'not-wired');
});
