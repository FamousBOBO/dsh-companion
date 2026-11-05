import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mountRuntime } from '../index.mjs';
import { DatabaseSync } from 'node:sqlite';

// soak F1（task-41）：**去重口径**，不是显著性判据。
//
// 缺陷：`isRepeatOfRememberedOutcome` 只查 `status='done'` 的活动，所以"同一 subject 先 failed
// 后 finished"里那条 finished **看不到** 前面的失败，于是写出第二条永久记忆。
// 修法：窗口内**任何终态**（done/failed/abandoned）都算"这个 subject 记过"，且每行按**自己的
// phase** 判显著。
//
// 这一组测试直接对着"决策结果"断言：显著性在 ingest 入队时就定了，所以看 outbox 的 payload
// （`significance`）比等投递更直接，也不依赖投递端口是否存在。

const T0 = Date.UTC(2026, 10, 10, 3, 0, 0);
const DAY = 24 * 3600 * 1000;
const SESSION = 'dedupe-session';

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dedupe-f1-'));
  for (const dir of ['home/companion', 'logs', 'workspace']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, 'workspace/PERSONA.md'), '三月七\n', 'utf8');
  fs.writeFileSync(path.join(root, 'home/companion/runtime.config.json'), JSON.stringify({
    enabled: true, mode: 'active', timeZone: 'Asia/Shanghai',
  }), 'utf8');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ } });
  return root;
}

/** A memory port that says yes to everything: this suite is about the runtime's decision, not memory's. */
function acceptingMemory() {
  return { async ingestDomainEvent() { return { status: 'accepted', receiptId: 'r', recordId: 'm' }; } };
}

async function mounted(t) {
  const root = tempRoot(t);
  const runtime = mountRuntime(null, root, {
    now: () => T0,
    identity: { resolve: sessionId => ({ userId: 'owner-1', persona: 'march7', sessionId }) },
    memory: acceptingMemory(),
  });
  t.after(() => { try { runtime.dispose?.(); } catch { /* disposed */ } });
  const scopeKey = runtime.status({ sessionId: SESSION }).scopeKey;
  const db = new DatabaseSync(path.join(root, 'home/companion/companion-runtime.db'));
  t.after(() => { try { db.close(); } catch { /* closed */ } });
  return { runtime, root, scopeKey, db };
}

function seedActivity(db, { id, scope, kind = 'read', target, status, consumed = 0, total = 0, version = 0, at }) {
  db.prepare(`INSERT INTO p2_activities
    (activity_id, scope, kind, target, status, consumed_prefix, total_units, artifact_version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(activity_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`)
    .run(id, scope, kind, target, status, consumed, total, version, at, at);
}

/** The significance the runtime decided for the most recent ingest (read off the outbox payload). */
function lastSignificance(db) {
  const row = db.prepare("SELECT payload FROM memory_outbox ORDER BY rowid DESC LIMIT 1").get();
  if (!row) return '';
  try { return String(JSON.parse(String(row.payload ?? '{}')).significance ?? ''); } catch { return ''; }
}

test('同一 subject 先 failed 后 finished：第二条走 routine（不再写第二条永久记忆）', async t => {
  const { runtime, scopeKey, db } = await mounted(t);

  // The failure is already a remembered fact about this subject.
  seedActivity(db, { id: 'act-fail', scope: scopeKey, target: 'shelf/rain.md', status: 'failed', consumed: 30, at: T0 - DAY });

  const outcome = await runtime.recordActivityOutcome({
    scopeKey, activityId: 'act-done', kind: 'read', target: 'shelf/rain.md',
    phase: 'finished', consumedPrefix: 60, totalUnits: 120,
  });
  assert.equal(outcome?.ok, true, JSON.stringify(outcome));

  assert.equal(lastSignificance(db), 'routine',
    'a finished outcome for a subject that already has a failed fact is history only, not a second memory');
});

test('零进度的 failed：不写永久记忆，但**事实还在**（活动史 + planner 的「最近做完的事」）', async t => {
  const { runtime, scopeKey, db } = await mounted(t);
  seedActivity(db, { id: 'act-alone', scope: scopeKey, target: 'shelf/tide.md', status: 'failed', consumed: 0, at: T0 });
  const outcome = await runtime.recordActivityOutcome({
    scopeKey, activityId: 'act-alone', kind: 'read', target: 'shelf/tide.md', phase: 'failed',
  });
  assert.equal(outcome?.ok, true, JSON.stringify(outcome));
  // F4: nothing was read, so nothing is remembered ...
  assert.equal(lastSignificance(db), 'routine', 'a zero-progress failure is not a permanent memory');
  // ... but the fact must survive, or the next plan would keep re-scheduling a dead source.
  const row = db.prepare('SELECT status, target FROM p2_activities WHERE activity_id = ?').get('act-alone');
  assert.equal(String(row?.status ?? ''), 'failed', 'the activity history keeps it');
  const materials = await runtime.p2Materials({ scopeKey });
  assert.equal(JSON.stringify(materials ?? {}).includes('shelf/tide.md'), true,
    'the planner can still see what happened (that is the fact, not the memory)');
});

test('不同 subject 各自失败 → 各自 notable（去重只看同一 subject）', async t => {
  const { runtime, scopeKey, db } = await mounted(t);
  seedActivity(db, { id: 'sib-a', scope: scopeKey, target: 'shelf/tide.md', status: 'failed', consumed: 30, at: T0 - DAY });
  const outcome = await runtime.recordActivityOutcome({
    scopeKey, activityId: 'sib-b', kind: 'read', target: 'shelf/light.md', phase: 'failed', consumedPrefix: 30, totalUnits: 900,
  });
  assert.equal(outcome?.ok, true, JSON.stringify(outcome));
  assert.equal(lastSignificance(db), 'notable', 'a different subject is a different fact');
});

test('routine 仍不进永久记忆（修去重不许把 routine 放进来）', async t => {
  const { runtime, scopeKey, db } = await mounted(t);
  // A plain read that covered its whole source and produced nothing: the definition of routine.
  const outcome = await runtime.recordActivityOutcome({
    scopeKey, activityId: 'plain-read', kind: 'read', target: 'shelf/plain.md',
    phase: 'finished', consumedPrefix: 100, totalUnits: 100,
  });
  assert.equal(outcome?.ok, true, JSON.stringify(outcome));
  assert.equal(lastSignificance(db), 'routine', 'a plain finished read stays routine');
});

test('task-46：同一 subject 的两个并发 finish → 只有 1 条永久记忆', async t => {
  const { runtime, scopeKey, db } = await mounted(t);
  // Two finishes of the same subject, started together. The decision is taken inside a transaction,
  // so the second one must see the first one's fact instead of racing it.
  const outcomes = await Promise.allSettled([
    runtime.recordActivityOutcome({ scopeKey, activityId: 'race-a', kind: 'read', target: 'shelf/race.md', phase: 'finished', consumedPrefix: 30, totalUnits: 90 }),
    runtime.recordActivityOutcome({ scopeKey, activityId: 'race-b', kind: 'read', target: 'shelf/race.md', phase: 'finished', consumedPrefix: 30, totalUnits: 90 }),
  ]);
  const fulfilled = outcomes.filter(entry => entry.status === 'fulfilled');
  assert.equal(fulfilled.length, 2, 'both calls were accepted (neither crashed)');
  const significances = db.prepare('SELECT payload FROM memory_outbox ORDER BY rowid ASC').all()
    .map(row => { try { return String(JSON.parse(String(row.payload ?? '{}')).significance ?? ''); } catch { return ''; } });
  const notable = significances.filter(value => value === 'notable');
  assert.equal(notable.length, 1, `exactly one permanent memory for this subject (saw ${JSON.stringify(significances)})`);
});

test('task-52/F3：abandoned（routine）之后 6 天内读到 notable —— 必须写出记忆', async t => {
  const { runtime, scopeKey, db } = await mounted(t);
  // An abandoned attempt on the subject: routine, so it must not reserve the week.
  seedActivity(db, { id: 'act-abandon', scope: scopeKey, target: 'shelf/ember.md', status: 'abandoned', at: T0 - 6 * DAY });
  const abandoned = await runtime.recordActivityOutcome({ scopeKey, activityId: 'act-abandon', kind: 'read', target: 'shelf/ember.md', phase: 'abandoned' });
  assert.equal(abandoned?.ok, true, JSON.stringify(abandoned));
  assert.equal(lastSignificance(db), 'routine', 'abandoning is not a memory');

  // Six days later the same subject is *actually read* (notable: partial coverage + no artifact).
  seedActivity(db, { id: 'act-read', scope: scopeKey, target: 'shelf/ember.md', status: 'done', consumed: 55, total: 967, at: T0 });
  const read = await runtime.recordActivityOutcome({
    scopeKey, activityId: 'act-read', kind: 'read', target: 'shelf/ember.md',
    phase: 'finished', consumedPrefix: 55, totalUnits: 967,
  });
  assert.equal(read?.ok, true, JSON.stringify(read));
  assert.equal(lastSignificance(db), 'notable', 'the routine claim must not suppress the notable read');
});

test('task-52/F3：notable 之后 6 天内再次 notable —— 仍然只 1 条记忆', async t => {
  const { runtime, scopeKey, db } = await mounted(t);
  const first = await runtime.recordActivityOutcome({
    scopeKey, activityId: 'act-n1', kind: 'read', target: 'shelf/pine.md',
    phase: 'finished', consumedPrefix: 10, totalUnits: 900,
  });
  assert.equal(first?.ok, true, JSON.stringify(first));
  assert.equal(lastSignificance(db), 'notable');

  seedActivity(db, { id: 'act-n1', scope: scopeKey, target: 'shelf/pine.md', status: 'done', consumed: 10, total: 900, at: T0 - 6 * DAY });
  const second = await runtime.recordActivityOutcome({
    scopeKey, activityId: 'act-n2', kind: 'read', target: 'shelf/pine.md',
    phase: 'finished', consumedPrefix: 20, totalUnits: 900,
  });
  assert.equal(second?.ok, true, JSON.stringify(second));
  assert.equal(lastSignificance(db), 'routine', 'one book, one memory — the second read is history only');
});

test('零进度失败不占额度：6 天后同一 subject 读到内容 —— 必须写出记忆', async t => {
  const { runtime, scopeKey, db } = await mounted(t);
  // A read that failed before reading anything: a notable fact, but no content.
  seedActivity(db, { id: 'act-empty-fail', scope: scopeKey, target: 'shelf/quartz.md', status: 'failed', at: T0 - 6 * DAY });
  const failed = await runtime.recordActivityOutcome({ scopeKey, activityId: 'act-empty-fail', kind: 'read', target: 'shelf/quartz.md', phase: 'failed' });
  assert.equal(failed?.ok, true, JSON.stringify(failed));
  assert.equal(lastSignificance(db), 'routine', 'F4: no content ⇒ fact only, no permanent memory');

  const read = await runtime.recordActivityOutcome({
    scopeKey, activityId: 'act-real-read', kind: 'read', target: 'shelf/quartz.md',
    phase: 'finished', consumedPrefix: 120, totalUnits: 900,
  });
  assert.equal(read?.ok, true, JSON.stringify(read));
  assert.equal(lastSignificance(db), 'notable', 'a zero-progress failure must not take the week');
});

test('有内容的失败仍占额度（不回归）：同一 subject 6 天内再读完 → routine', async t => {
  const { runtime, scopeKey, db } = await mounted(t);
  seedActivity(db, { id: 'act-fail-partial', scope: scopeKey, target: 'shelf/opal.md', status: 'failed', consumed: 40, at: T0 - 6 * DAY });
  const failed = await runtime.recordActivityOutcome({ scopeKey, activityId: 'act-fail-partial', kind: 'read', target: 'shelf/opal.md', phase: 'failed', consumedPrefix: 40, totalUnits: 900 });
  assert.equal(failed?.ok, true, JSON.stringify(failed));
  assert.equal(lastSignificance(db), 'notable', 'it read 40 units before failing: still a memory');

  const read = await runtime.recordActivityOutcome({
    scopeKey, activityId: 'act-opal-read', kind: 'read', target: 'shelf/opal.md',
    phase: 'finished', consumedPrefix: 40, totalUnits: 900,
  });
  assert.equal(read?.ok, true, JSON.stringify(read));
  assert.equal(lastSignificance(db), 'routine', 'a failure that read something does take the week');
});

test('F4：零进度 missed / finished(0/N) 同样只留事实、不写永久记忆', async t => {
  const { runtime, scopeKey, db } = await mounted(t);
  seedActivity(db, { id: 'act-missed', scope: scopeKey, target: 'shelf/slate.md', status: 'missed', consumed: 0, total: 0, at: T0 });
  const missed = await runtime.recordActivityOutcome({ scopeKey, activityId: 'act-missed', kind: 'read', target: 'shelf/slate.md', phase: 'missed' });
  assert.equal(missed?.ok, true, JSON.stringify(missed));
  assert.equal(lastSignificance(db), 'routine', 'a missed slot read nothing');

  const empty = await runtime.recordActivityOutcome({
    scopeKey, activityId: 'act-empty-finish', kind: 'read', target: 'shelf/basalt.md',
    phase: 'finished', consumedPrefix: 0, totalUnits: 2135,
  });
  assert.equal(empty?.ok, true, JSON.stringify(empty));
  assert.equal(lastSignificance(db), 'routine', 'a finish that covered nothing is not a memory');
});

test('F4：同 subject 多次零进度 + 一次读到内容 → 恰好 1 条永久记忆', async t => {
  const { runtime, scopeKey, db } = await mounted(t);
  const target = 'shelf/deep.md';
  // The soak shape: failed 0/N, missed 0/0, finished 0/N, then one real read.
  seedActivity(db, { id: 'f-fail', scope: scopeKey, target, status: 'failed', consumed: 0, at: T0 - 3 * DAY });
  await runtime.recordActivityOutcome({ scopeKey, activityId: 'f-fail', kind: 'read', target, phase: 'failed' });
  seedActivity(db, { id: 'f-missed', scope: scopeKey, target, status: 'missed', consumed: 0, at: T0 - 2 * DAY });
  await runtime.recordActivityOutcome({ scopeKey, activityId: 'f-missed', kind: 'read', target, phase: 'missed' });
  seedActivity(db, { id: 'f-empty', scope: scopeKey, target, status: 'done', consumed: 0, total: 2135, at: T0 - DAY });
  await runtime.recordActivityOutcome({ scopeKey, activityId: 'f-empty', kind: 'read', target, phase: 'finished', consumedPrefix: 0, totalUnits: 2135 });
  const real = await runtime.recordActivityOutcome({
    scopeKey, activityId: 'f-real', kind: 'read', target, phase: 'finished', consumedPrefix: 400, totalUnits: 2135,
  });
  assert.equal(real?.ok, true, JSON.stringify(real));

  const significances = db.prepare('SELECT payload FROM memory_outbox ORDER BY rowid').all()
    .map(row => { try { return String(JSON.parse(String(row.payload ?? '{}')).significance ?? ''); } catch { return ''; } });
  assert.equal(significances.filter(value => value === 'notable').length, 1,
    `exactly one permanent memory for this subject (saw ${JSON.stringify(significances)})`);
});
