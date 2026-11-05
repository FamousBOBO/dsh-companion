import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { mountRuntime } from '../index.mjs';

// task-38：**含糊纠正的裁决通道**。
//
// task-36 的 fail-closed 只做到"看得见"——含糊的纠正永远停在待审、旧事实仍被 recall 带回来，
// 那等于纠正没生效。这里证明：裁决是**显式**的（谁、凭什么、压哪几条）、**幂等**的、**可审计**的，
// 而压掉的那几条从 recall 里真的消失（记忆侧由 `correction-resolve.test.mjs` 用真引擎证明）。

const T0 = Date.UTC(2026, 10, 7, 3, 0, 0);

function mounted(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'correction-resolve-'));
  for (const dir of ['home/companion', 'logs', 'workspace']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, 'workspace/PERSONA.md'), 'bot\n', 'utf8');
  fs.writeFileSync(path.join(root, 'home/companion/runtime.config.json'), JSON.stringify({
    enabled: true, mode: 'active', timeZone: 'Asia/Shanghai',
  }), 'utf8');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });
  const runtime = mountRuntime(null, root, {
    now: () => T0,
    identity: { resolve: sessionId => ({ userId: 'owner-1', persona: 'bot', sessionId }) },
  });
  t.after(() => { try { runtime.dispose?.(); } catch { /* disposed */ } });
  return { runtime, root };
}

/** Seed a pending review entry the way the drain would (the candidates are what matters here). */
function seedReview(root, recordId, candidates) {
  const db = new DatabaseSync(path.join(root, 'home/companion/companion-runtime.db'));
  try {
    db.prepare(`INSERT INTO runtime_meta (meta_key, meta_value, updated_at) VALUES (?, ?, ?)
                ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value, updated_at = excluded.updated_at`)
      .run(`p2_correction_review:${recordId}`, JSON.stringify({
        recordId, receiptId: 'rcpt_1', candidates, namespace: 'companion.correction', eventId: 'evt_1',
        reason: 'correction-hint-ambiguous', at: T0,
      }), T0);
  } finally { db.close(); }
}

function correctionOutbox(root) {
  const db = new DatabaseSync(path.join(root, 'home/companion/companion-runtime.db'), { readOnly: true });
  try {
    return db.prepare("SELECT payload FROM memory_outbox WHERE namespace = 'companion.correction' ORDER BY rowid ASC").all()
      .map(row => { try { return JSON.parse(String(row.payload ?? '{}')); } catch { return {}; } });
  } finally { db.close(); }
}

test('裁决压其中 1 条：出队的是精确 id、待审减 1、可审计', async t => {
  const { runtime, root } = mounted(t);
  seedReview(root, 'mem_correction_1', ['mem_old_a', 'mem_old_b']);

  const before = await runtime.correctionReview();
  assert.equal(before.count, 1);

  const resolved = runtime.resolveAmbiguousCorrection({
    recordId: 'mem_correction_1',
    supersedeIds: ['mem_old_a'],
    sessionId: 'owner-session', operator: 'owner',
    evidence: '用户在 11-07 明确说"改成不喜欢了"，只针对第一条',
  });
  assert.equal(resolved.ok, true, JSON.stringify(resolved));
  assert.equal(resolved.outcome, 'resolved-pending-apply');
  assert.deepEqual(resolved.superseded, ['mem_old_a']);

  // What leaves the runtime is an **exact-id** correction request (no text matching downstream).
  const queued = correctionOutbox(root);
  assert.equal(queued.some(payload => JSON.stringify(payload.supersedeIds ?? []) === '["mem_old_a"]'), true,
    'the exact id list travels in the payload');

  const after = await runtime.correctionReview();
  assert.equal(after.count, 0, 'the entry left the pending list');
  assert.equal(after.resolved, 0, 'not yet: an enqueue is not an application (task-49)');

  assert.equal(after.pendingApply, 1, 'it is in flight, and it says so');

  // Promotion needs proof from the delivery layer; without a confirmed `sent` row it must stay pending.


  assert.equal(after.pendingApply, 1, 'it is in flight, and it says so');

  const audit = runtime.correctionResolution({ recordId: 'mem_correction_1' });
  assert.equal(audit.ok, true);
  assert.equal(audit.resolved.operator, 'owner');
  assert.equal(String(audit.resolved.evidence).includes('不喜欢了'), true, 'the evidence is kept verbatim');
  assert.deepEqual(audit.resolved.supersedeIds, ['mem_old_a']);
  assert.equal(audit.resolved.outcome, 'resolved-pending-apply');
});

test('supersedeIds: [] → 一条都不压，转 resolved-none，待审减 1', async t => {
  const { runtime, root } = mounted(t);
  seedReview(root, 'mem_correction_2', ['mem_old_c', 'mem_old_d']);

  const resolved = runtime.resolveAmbiguousCorrection({
    recordId: 'mem_correction_2', supersedeIds: [], sessionId: 'owner-session', operator: 'owner', evidence: '用户确认这是补充，不是替换',
  });
  assert.equal(resolved.ok, true, JSON.stringify(resolved));
  assert.equal(resolved.outcome, 'resolved-none');
  assert.deepEqual(resolved.superseded, []);
  assert.equal(correctionOutbox(root).length, 0, 'nothing was sent to memory');

  const after = await runtime.correctionReview();
  assert.equal(after.count, 0);
  assert.equal(after.resolved, 1);
  const audit = runtime.correctionResolution({ recordId: 'mem_correction_2' });
  assert.equal(audit.resolved.outcome, 'resolved-none');
});

test('候选集之外的 id → not-a-candidate，零副作用', async t => {
  const { runtime, root } = mounted(t);
  seedReview(root, 'mem_correction_3', ['mem_old_e']);

  const rejected = runtime.resolveAmbiguousCorrection({
    recordId: 'mem_correction_3', supersedeIds: ['mem_old_e', 'mem_someone_else'], sessionId: 'owner-session', operator: 'owner', evidence: '越界测试',
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'not-a-candidate');
  assert.deepEqual(rejected.rejected, ['mem_someone_else']);

  assert.equal(correctionOutbox(root).length, 0, 'nothing queued');
  const review = await runtime.correctionReview();
  assert.equal(review.count, 1, 'the entry is still pending');
  assert.equal(review.resolved, 0, 'and nothing was adjudicated');
});

test('空 operator / 空 evidence → 拒绝（与 resolveEffect 同口径）', async t => {
  const { runtime, root } = mounted(t);
  seedReview(root, 'mem_correction_4', ['mem_old_f']);

  const noOperator = runtime.resolveAmbiguousCorrection({ recordId: 'mem_correction_4', supersedeIds: ['mem_old_f'], sessionId: 'owner-session', operator: '   ', evidence: 'x' });
  assert.equal(noOperator.ok, false);
  assert.equal(noOperator.code, 'operator-required');

  const noEvidence = runtime.resolveAmbiguousCorrection({ recordId: 'mem_correction_4', supersedeIds: ['mem_old_f'], sessionId: 'owner-session', operator: 'owner', evidence: '' });
  assert.equal(noEvidence.ok, false);
  assert.equal(noEvidence.code, 'evidence-required');

  const notArray = runtime.resolveAmbiguousCorrection({ recordId: 'mem_correction_4', supersedeIds: 'mem_old_f', sessionId: 'owner-session', operator: 'owner', evidence: 'x' });
  assert.equal(notArray.ok, false);
  assert.equal(notArray.code, 'invalid-input');

  assert.equal((await runtime.correctionReview()).count, 1, 'still pending, zero side effects');
});

test('重复裁决 → already-resolved，不重复压，审计只有一条', async t => {
  const { runtime, root } = mounted(t);
  seedReview(root, 'mem_correction_5', ['mem_old_g', 'mem_old_h']);

  const first = runtime.resolveAmbiguousCorrection({ recordId: 'mem_correction_5', supersedeIds: ['mem_old_g'], sessionId: 'owner-session', operator: 'owner', evidence: '第一次裁决' });
  assert.equal(first.ok, true);
  const queuedAfterFirst = correctionOutbox(root).length;

  const second = runtime.resolveAmbiguousCorrection({ recordId: 'mem_correction_5', supersedeIds: ['mem_old_h'], sessionId: 'owner-session', operator: 'owner', evidence: '第二次裁决' });
  assert.equal(second.ok, false);
  assert.equal(second.code, 'already-resolved');
  assert.deepEqual(second.resolution.supersedeIds, ['mem_old_g'], 'the earlier decision is what stands');
  assert.equal(correctionOutbox(root).length, queuedAfterFirst, 'nothing was queued twice');

  const audit = runtime.correctionResolution({ recordId: 'mem_correction_5' });
  assert.equal(audit.resolved.evidence, '第一次裁决', 'the first adjudication is the recorded one');
});

test('裁决不存在的记录 → not-found；空 recordId → invalid-input', async t => {
  const { runtime } = mounted(t);
  const missing = runtime.resolveAmbiguousCorrection({ recordId: 'mem_nope', supersedeIds: [], sessionId: 'owner-session', operator: 'owner', evidence: 'x' });
  assert.equal(missing.code, 'not-found');
  const empty = runtime.resolveAmbiguousCorrection({ supersedeIds: [], sessionId: 'owner-session', operator: 'owner', evidence: 'x' });
  assert.equal(empty.code, 'invalid-input');
});
