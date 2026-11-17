import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openRuntimeDb } from '../lib/db.mjs';
import { createP2 } from '../lib/p2.mjs';
import { scopeKey as scopeKeyOf } from '../lib/scope.mjs';

// JSONL 降级 sink **不是** contact（首席裁决 2026-11-14）。
//
// 缺陷：`contactSharePort` 在没有 contact 服务时落本地 JSONL 队列，并按 `sink:'jsonl'` 上报
// `ok:true, written:true`（`autonomy-share.mjs:204`）。runtime 只看 `ok`，于是**只写进本地日志的
// 候选被记成 `queued` + `contact-queued`** —— 状态说"已交给 contact"，实际只是本机一行 append。
//
// 裁决：状态词表不变，把它记成 `gated` + `local-only-jsonl`。`gated` 本来就是"没进 contact"，
// 而原因是具名的。恢复（撤回/重新提交）要由人决定，**不自动复活**。
//
// 这一组钉住四件事：
//   1. `sink:'jsonl'` ⇒ `gated` + `local-only-jsonl`，且 `queued` 计数不涨；
//   2. 真 contact（没有 `sink` 或 `sink:'contact'`）⇒ 仍然 `queued` + `contact-queued`（行为不变）；
//   3. `submitShareCandidate` 的单条路径同样分叉；
//   4. 本地候选**不被删除**（它是本地历史），只是不再等投递。

const T0 = Date.UTC(2026, 10, 14, 3, 0, 0);
const SCOPE = Object.freeze({ userId: 'owner-1', personaId: 'bot', worldId: 'world:default' });
const KEY = scopeKeyOf(SCOPE);

function world(t, { shareEnabled = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-share-local-'));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }); } catch { /* best effort */ } });
  const db = openRuntimeDb({ file: ':memory:', now: () => T0 });
  t.after(() => { try { db.close(); } catch { /* closed */ } });
  db.acquireLease({ owner: 'owner-test', generation: 'gen-test', ttlMs: 600000 });
  db.commitProjection({ scope: KEY, generation: 'gen-test', payload: {}, updatedAt: T0 });
  const config = {
    timeZone: 'Asia/Shanghai',
    p2: { planning: { enabled: false }, activities: { enabled: false }, share: { enabled: shareEnabled, maxPending: 50 } },
  };
  return { db, root, config };
}

function controller(db, config, { submit }) {
  const port = { submit };
  return createP2({
    db, config, clock: () => T0, owner: 'owner-test', generation: 'gen-test',
    getMode: () => 'active', isActive: () => true,
    emit: () => {}, options: { sharePort: port, onError: () => {} },
  });
}

const rowOf = (db, id) => db.get('SELECT status, decision_reason FROM p2_share_candidates WHERE candidate_id = ?', id) ?? {};

test('sink:jsonl ⇒ gated + local-only-jsonl（不是 queued、不是 contact-queued）', async t => {
  const { db, config } = world(t);
  const p2 = controller(db, config, {
    submit: async () => ({ ok: true, duplicate: false, written: true, candidateId: 'x', sink: 'jsonl' }),
  });
  const made = p2.createShareCandidate({ scopeKey: KEY, activityId: 'a-local', kind: 'bilibili', title: '看了三段字幕', body: '正文' });
  assert.equal(made.ok, true, JSON.stringify(made));

  const pumped = await p2.deliverShareCandidates({ scopeKey: KEY });
  assert.equal(pumped.queued, 0, 'a local-only sink must not count as queued');
  assert.equal(pumped.localOnly, 1, 'the local-only tally is explicit');
  assert.equal(pumped.reasons['local-only-jsonl'], 1);
  const row = rowOf(db, made.candidateId);
  assert.equal(row.status, 'gated');
  assert.equal(row.decision_reason, 'local-only-jsonl');
});

test('真 contact（没有 sink 字段）仍记 queued + contact-queued（行为不变）', async t => {
  const { db, config } = world(t);
  const p2 = controller(db, config, { submit: async () => ({ ok: true }) });
  const made = p2.createShareCandidate({ scopeKey: KEY, activityId: 'a-contact', kind: 'bilibili', title: '标题', body: '正文' });
  const pumped = await p2.deliverShareCandidates({ scopeKey: KEY });
  assert.equal(pumped.queued, 1);
  assert.equal(pumped.localOnly, 0);
  const row = rowOf(db, made.candidateId);
  assert.equal(row.status, 'queued');
  assert.equal(row.decision_reason, 'contact-queued');
});

test('显式 sink:contact 也按 contact 处理（只有 jsonl 被降级）', async t => {
  const { db, config } = world(t);
  const p2 = controller(db, config, { submit: async () => ({ ok: true, sink: 'contact' }) });
  const made = p2.createShareCandidate({ scopeKey: KEY, activityId: 'a-c2', kind: 'bilibili', title: '标题', body: '正文' });
  await p2.deliverShareCandidates({ scopeKey: KEY });
  const row = rowOf(db, made.candidateId);
  assert.equal(row.status, 'queued');
  assert.equal(row.decision_reason, 'contact-queued');
});

test('单条 submitShareCandidate 走同一规则：journalOnly 时 gated，且返回值不再声称 accepted', async t => {
  const { db, config } = world(t);
  const p2 = controller(db, config, { submit: async () => ({ ok: true, written: true, sink: 'jsonl' }) });
  const made = p2.createShareCandidate({ scopeKey: KEY, activityId: 'a-single', kind: 'bilibili', title: '标题', body: '正文' });

  const submitted = await p2.submitShareCandidate({ scopeKey: KEY, candidateId: made.candidateId });
  assert.equal(submitted.ok, true);
  assert.equal(submitted.accepted, false, 'a local sink is not an acceptance by contact');
  assert.equal(submitted.localOnly, true);
  assert.equal(submitted.code, 'local-only-jsonl');
  assert.equal(submitted.owner, 'local-sink');
  const row = rowOf(db, made.candidateId);
  assert.equal(row.status, 'gated');
  assert.equal(row.decision_reason, 'local-only-jsonl');
});

test('本地候选不被删除：降级只改状态，行还在（可人工撤回或重新提交）', async t => {
  const { db, config } = world(t);
  const p2 = controller(db, config, { submit: async () => ({ ok: true, sink: 'jsonl' }) });
  const made = p2.createShareCandidate({ scopeKey: KEY, activityId: 'a-keep', kind: 'bilibili', title: '标题', body: '正文' });
  await p2.deliverShareCandidates({ scopeKey: KEY });
  const still = db.get('SELECT candidate_id, title, status FROM p2_share_candidates WHERE candidate_id = ?', made.candidateId);
  assert.ok(still, 'the row survives');
  assert.equal(still.status, 'gated');
});

test('开关关着时不碰端口，也不产生 localOnly 计数（零行为）', async t => {
  const { db, config } = world(t, { shareEnabled: false });
  let calls = 0;
  const p2 = controller(db, config, { submit: async () => { calls += 1; return { ok: true, sink: 'jsonl' }; } });
  const made = p2.createShareCandidate({ scopeKey: KEY, title: '标题', body: '正文' });
  assert.equal(made.ok, false, 'share-disabled refuses to create');
  const pumped = await p2.deliverShareCandidates({ scopeKey: KEY });
  assert.equal(calls, 0);
  assert.equal(pumped.localOnly, 0);
});
