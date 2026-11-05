import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { mountRuntime } from '../index.mjs';

// task-36（runtime 侧）：**"有纠正没生效"必须看得见**。
//
// 记忆侧在 hint 命中多条时不再 superse（fail-closed），但一条"没生效的纠正"如果只是日志里的一行，
// 就等于没人知道。这里证明两件事：
//   1. memory 报告 ambiguous → runtime 把它写成 `runtime_meta` 的待审条目（零 migration）；
//   2. `correctionReview()` 能读出计数与最近条目（候选 id 一起带出来）。
// 同时钉住一条边界：ambiguous **不**进入自动重试队列（重发同一个含糊 hint 只会一直含糊）。

const T0 = Date.UTC(2026, 10, 6, 3, 0, 0);

function mounted(t, { memory = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'correction-review-'));
  for (const dir of ['home/companion', 'logs', 'workspace']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, 'workspace/PERSONA.md'), '三月七\n', 'utf8');
  fs.writeFileSync(path.join(root, 'home/companion/runtime.config.json'), JSON.stringify({
    enabled: true, mode: 'active', timeZone: 'Asia/Shanghai',
  }), 'utf8');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });
  const runtime = mountRuntime(null, root, {
    now: () => T0,
    identity: { resolve: sessionId => ({ userId: 'owner-1', persona: 'march7', sessionId }) },
    ...(memory ? { memory } : {}),
  });
  t.after(() => { try { runtime.dispose?.(); } catch { /* disposed */ } });
  return { runtime, root };
}

/** A memory stub that answers exactly like a fail-closed memory engine would. */
function ambiguousMemory(calls) {
  return {
    engine: {
      async ingestDomainEvent(request) {
        calls.push(request);
        return {
          status: 'accepted',
          receiptId: 'rcpt_ambiguous_1',
          recordId: 'mem_correction_1',
          supersede: {
            superseded: [],
            ambiguous: ['mem_old_a', 'mem_old_b'],
            ambiguousDetails: [
              { recordId: 'mem_old_a', text: '用户喜欢在雨天散步，尤其是小雨', at: T0, kind: 'fact' },
              { recordId: 'mem_old_b', text: '用户喜欢在雨天散步，但不喜欢打伞', at: T0, kind: 'fact' },
            ],
            reason: 'correction-hint-ambiguous',
          },
        };
      },
    },
  };
}

function todoKeys(root) {
  const db = new DatabaseSync(path.join(root, 'home/companion/companion-runtime.db'), { readOnly: true });
  try {
    return db.prepare('SELECT meta_key FROM runtime_meta ORDER BY meta_key').all().map(row => String(row.meta_key));
  } finally { db.close(); }
}

test('memory 报 ambiguous → 既有 drain 真的记下待审条目（且不进自动重试队列）', async t => {
  const calls = [];
  // A fail-closed memory engine, mounted through the documented `memory` option: the drain path is
  // the production one, only the answers are stubbed.
  const { runtime, root } = mounted(t, {
    memory: {
      async ingestDomainEvent(request) {
        calls.push(request);
        if (request?.namespace !== 'companion.correction') return { status: 'accepted', receiptId: 'rcpt_ok', recordId: 'mem_ok' };
        return {
          status: 'accepted',
          receiptId: 'rcpt_ambiguous_1',
          recordId: 'mem_correction_1',
          supersede: {
            superseded: [],
            ambiguous: ['mem_old_a', 'mem_old_b'],
            ambiguousDetails: [
              { recordId: 'mem_old_a', text: '用户喜欢在雨天散步，尤其是小雨', at: T0, kind: 'fact' },
              { recordId: 'mem_old_b', text: '用户喜欢在雨天散步，但不喜欢打伞', at: T0, kind: 'fact' },
            ],
            reason: 'correction-hint-ambiguous',
          },
        };
      },
    },
  });

  runtime.assertBelief({ sessionId: 's', proposition: '用户喜欢在雨天散步', rootEvidenceIds: ['ev-1'], confidence: 0.8, source: 'conversation' });
  const belief = runtime.listBeliefs({ sessionId: 's' }).beliefs[0];
  const corrected = runtime.correctBelief({ sessionId: 's', beliefId: belief.beliefId, byEvidenceId: 'ev-2', reason: '改口', replacement: '用户不喜欢在雨天散步' });
  assert.equal(corrected.memoryCorrection.ok, true, 'the correction is queued');

  const before = await runtime.correctionReview();
  assert.equal(before.count, 0, 'nothing to review before the drain');

  const summary = await runtime.drainOutbox({ sessionId: 's' });
  assert.equal(summary.delivered >= 1, true, JSON.stringify(summary));
  assert.equal(calls.some(request => request.namespace === 'companion.correction'), true, 'the correction was delivered');

  const review = await runtime.correctionReview({ limit: 5 });
  assert.equal(review.ok, true, JSON.stringify(review));
  assert.equal(review.count, 1, 'a delivered-but-not-applied correction becomes a review entry');
  assert.equal(review.recent[0].recordId, 'mem_correction_1');
  assert.deepEqual(review.recent[0].candidates.map(item => item.recordId), ['mem_old_a', 'mem_old_b'], 'the candidates are visible');
  // task-39: the seeded entry carries text, so the reviewer can read what it is choosing between.
  assert.equal(review.recent[0].candidates[0].text, '用户喜欢在雨天散步，尤其是小雨');
  assert.equal(review.recent[0].candidates[0].kind, 'fact');
  assert.equal(review.pendingRetries, 0, 'an ambiguous correction is not in the auto-retry queue');

  // And it is never retried automatically: the fix needs a human, so re-sending would only loop.
  const retried = runtime.retryPendingCorrections({ limit: 5 });
  assert.equal(retried.retried, 0, 'nothing was queued for retry');
});

test('correctionReview() 读得出计数与最近条目（直接种一条待审）', async t => {
  const { runtime, root } = mounted(t);
  const file = path.join(root, 'home/companion/companion-runtime.db');
  const db = new DatabaseSync(file);
  try {
    const at = T0;
    db.prepare(`INSERT INTO runtime_meta (meta_key, meta_value, updated_at) VALUES (?, ?, ?)
                ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value, updated_at = excluded.updated_at`)
      .run('p2_correction_review:mem_correction_1', JSON.stringify({
        recordId: 'mem_correction_1', receiptId: 'rcpt_1', candidates: ['mem_old_a', 'mem_old_b'],
        candidateDetails: [
          { recordId: 'mem_old_a', text: '用户喜欢在雨天散步，尤其是小雨', at: '2026-11-06T03:00:00.000Z', kind: 'fact' },
          { recordId: 'mem_old_b', text: '用户喜欢在雨天散步，但不喜欢打伞', at: '2026-11-06T03:00:00.000Z', kind: 'fact' },
        ],
        namespace: 'companion.correction', eventId: 'evt_1', reason: 'correction-hint-ambiguous', at,
      }), at);
  } finally { db.close(); }

  const review = await runtime.correctionReview({ limit: 5 });
  assert.equal(review.ok, true, JSON.stringify(review));
  assert.equal(review.count, 1, 'one correction is waiting for a human');
  assert.equal(review.recent.length, 1);
  assert.equal(review.recent[0].recordId, 'mem_correction_1');
  assert.deepEqual(review.recent[0].candidates.map(item => item.recordId), ['mem_old_a', 'mem_old_b'], 'candidate ids are visible');
  assert.equal(review.pendingRetries, 0, 'an ambiguous correction is not in the auto-retry queue');
});

test('correctionReview() 空库也能读（不抛、计数为 0）', async t => {
  const { runtime } = mounted(t);
  const review = await runtime.correctionReview();
  assert.equal(review.ok, true);
  assert.equal(review.count, 0);
  assert.deepEqual(review.recent, []);
});
