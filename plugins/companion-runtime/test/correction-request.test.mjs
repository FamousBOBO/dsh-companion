import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { mountRuntime } from '../index.mjs';

// task-33（A + D）——纠正从 runtime 出发时的两件事：
//   A：`memory/correction-request` 的正文带**旧命题原文**，并把 `supersedesHint` 一路送到 payload
//      （记忆侧靠它找到要 superse 的那条；只带新说法是做不到的）。
//   D：投递失败时写进 `runtime_meta` 当待办，由**既有 drain 路径**补发，补发成功后待办清掉；
//      已提交的 belief 纠正**不回滚**。

const T0 = Date.UTC(2026, 10, 5, 3, 0, 0);
const SESSION = 'session-correction';

function mounted(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'correction-runtime-'));
  for (const dir of ['home/companion', 'logs', 'workspace']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, 'workspace/PERSONA.md'), '三月七\n', 'utf8');
  fs.writeFileSync(path.join(root, 'home/companion/runtime.config.json'), JSON.stringify({
    enabled: true, mode: 'active', timeZone: 'Asia/Shanghai',
  }), 'utf8');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });
  const runtime = mountRuntime(null, root, {
    now: () => T0,
    identity: { resolve: sessionId => ({ userId: 'owner-1', persona: 'march7', sessionId }) },
  });
  t.after(() => { try { runtime.dispose?.(); } catch { /* disposed */ } });
  return { runtime, root };
}

/**
 * Read the queued correction rows straight from the runtime database.
 *
 * No delivery target is involved: this is exactly what the bridge will hand to memory, so it is the
 * honest boundary for "the runtime did its half" (memory's half is covered by its own suite).
 */
function outboxCorrections(root) {
  const file = path.join(root, 'home/companion/companion-runtime.db');
  if (!fs.existsSync(file)) return [];
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare("SELECT payload FROM memory_outbox WHERE namespace = 'companion.correction' ORDER BY rowid ASC").all()
      .map(row => { try { return JSON.parse(String(row.payload ?? '{}')); } catch { return {}; } });
  } finally { db.close(); }
}

test('A：纠正正文带旧命题原文，并且 supersedesHint 进了 payload', async t => {
  const { runtime, root } = mounted(t);
  runtime.assertBelief({ sessionId: SESSION, proposition: '用户喜欢在雨天散步', rootEvidenceIds: ['ev-1'], confidence: 0.8, source: 'conversation' });
  const belief = runtime.listBeliefs({ sessionId: SESSION }).beliefs[0];

  const corrected = runtime.correctBelief({
    sessionId: SESSION, beliefId: belief.beliefId, byEvidenceId: 'ev-2',
    reason: '用户说不再喜欢了', replacement: '用户现在不喜欢在雨天散步',
  });
  assert.equal(corrected.ok, true, JSON.stringify(corrected));
  assert.equal(corrected.memoryCorrection.ok, true, JSON.stringify(corrected.memoryCorrection));

  // The correction is a real queued request: read the outbox row the bridge will hand to memory.
  const queued = outboxCorrections(root);
  assert.equal(queued.length >= 1, true, 'a memory/correction-request row was queued');
  const payload = queued[0];
  assert.equal(String(payload.content).includes('旧：用户喜欢在雨天散步'), true, 'the old statement travels in the body');
  assert.equal(String(payload.content).includes('现在是「用户现在不喜欢在雨天散步」'), true, 'and the new one too');
  assert.equal(payload.supersedesHint, '用户喜欢在雨天散步', 'the hint reaches the payload');
});

/**
 * Seed a due correction todo directly.
 *
 * Honest note: a *real* "belief committed but the memory enqueue failed" state cannot be produced
 * from the public API without breaking the database (an unwritable page fails the belief commit
 * first, which by design records no todo). So this seeding stands in for that window, and the tests
 * below prove the **retry book** — the part that has to work when the window does happen.
 */
function seedTodo(root, { content, supersedesHint = '', at = T0 }) {
  const file = path.join(root, 'home/companion/companion-runtime.db');
  const db = new DatabaseSync(file);
  try {
    db.prepare(`INSERT INTO runtime_meta (meta_key, meta_value, updated_at) VALUES (?, ?, ?)
                 ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value, updated_at = excluded.updated_at`)
      .run('p2_correction_pending:seeded-belief', JSON.stringify({
        namespace: 'companion.correction', content, supersedesHint, sessionId: SESSION, reason: 'seeded', at,
      }), at);
  } finally { db.close(); }
}

function todoCount(root) {
  const file = path.join(root, 'home/companion/companion-runtime.db');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return Number(db.prepare("SELECT COUNT(*) AS n FROM runtime_meta WHERE meta_key LIKE 'p2_correction_pending:%'").get()?.n ?? 0);
  } finally { db.close(); }
}

test('D：待办被既有重试路径补发，补发成功后待办清掉', async t => {
  const { runtime, root } = mounted(t);
  assert.equal(todoCount(root), 0, 'no todo to begin with');

  seedTodo(root, { content: '用户纠正（旧：用户讨厌猫）现在是「用户喜欢猫」', supersedesHint: '用户讨厌猫' });
  assert.equal(todoCount(root), 1, 'the todo exists');

  const retried = runtime.retryPendingCorrections({ limit: 5 });
  assert.equal(retried.retried, 1, JSON.stringify(retried));
  assert.equal(retried.cleared, 1, JSON.stringify(retried));
  assert.equal(retried.failed, 0, JSON.stringify(retried));
  assert.equal(todoCount(root), 0, 'the todo is cleared after a successful resend');

  // And the resend really reached the outbox, with the hint intact.
  const queued = outboxCorrections(root);
  assert.equal(queued.some(payload => payload.supersedesHint === '用户讨厌猫'), true, 'the retry kept the hint');

  const again = runtime.retryPendingCorrections({ limit: 5 });
  assert.equal(again.retried, 0, 'nothing left to retry');
});

test('D：重试不吞掉失败——队列不可写时待办保留', async t => {
  const { runtime, root } = mounted(t);
  seedTodo(root, { content: '用户纠正（旧：用户怕黑）现在是「用户不怕黑」', supersedesHint: '用户怕黑' });

  // Close the runtime's writer: a stopped runtime cannot queue, so the retry must fail **and keep**
  // the todo instead of silently dropping the correction.
  runtime.stop?.();
  const retried = runtime.retryPendingCorrections({ limit: 5 });
  assert.equal(retried.failed >= 1, true, JSON.stringify(retried));
  assert.equal(retried.cleared, 0, 'a failed retry keeps the todo');
  assert.equal(todoCount(root), 1, 'the todo is still there');
});
