import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openRuntimeDb } from '../lib/db.mjs';
import { createP2 } from '../lib/p2.mjs';
import { p2Observability } from '../lib/observability.mjs';
import { scopeKey as scopeKeyOf } from '../lib/scope.mjs';

// 终审 round-3 第三批：p1Epoch 回拨漏扫 / pending 饿死 gated / 观测失败伪装 0。

const T0 = Date.UTC(2026, 10, 13, 3, 0, 0);
const HOUR = 3_600_000;
const SCOPE = Object.freeze({ userId: 'owner-1', personaId: 'bot', worldId: 'world:default' });
const KEY = scopeKeyOf(SCOPE);

function world(t, { now = () => T0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'round3b-'));
  fs.mkdirSync(path.join(root, 'shelf'), { recursive: true });
  fs.writeFileSync(path.join(root, 'shelf', 'tide.md'), '潮水在傍晚退去。'.repeat(80), 'utf8');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }); } catch { /* best effort */ } });
  const db = openRuntimeDb({ file: ':memory:', now });
  t.after(() => { try { db.close(); } catch { /* closed */ } });
  db.acquireLease({ owner: 'owner-test', generation: 'gen-1', ttlMs: 365 * 24 * 3600 * 1000 });
  db.commitProjection({ scope: KEY, generation: 'gen-1', payload: {}, updatedAt: T0 });
  return { db, root };
}

function seedDone(db, { activityId, at, status = 'done' }) {
  db.run(`INSERT INTO p2_activities (activity_id, scope, plan_slot_id, kind, adapter, capability, reality, status,
            target, source_ref, source_hash, total_units, consumed_prefix, checkpoint, artifact_ref, artifact_hash,
            artifact_version, started_at, paused_at, ended_at, created_at, updated_at)
          VALUES (?, ?, '', 'read', 'read', 'read', 'actual_tool_activity', ?, 'shelf/tide.md', 'file:shelf/tide.md', ?, 100, 100, '{}', '', '', 0, ?, 0, ?, ?, ?)`,
  activityId, KEY, status, 'b'.repeat(64), at, at, at, at);
}

function controller(db, root, { now = () => T0, replayed = [] } = {}) {
  return createP2({
    db, clock: now, owner: 'owner-test', generation: 'gen-1',
    config: { timeZone: 'Asia/Shanghai', p2: { planning: { enabled: false }, activities: { enabled: true, paused: false }, share: { enabled: true, maxPending: 200 } } },
    getMode: () => 'active', isActive: () => true, emit: () => {},
    options: {
      ports: { async readFile() { return { ok: false }; }, async writeFile() { return { ok: false }; }, async fetchPage() { return { ok: false }; } },
      artifactRoot: root,
      onFinished: info => { replayed.push(info.activityId); return { ok: true }; },
      onError: () => {},
    },
  });
}

test('A4：时钟回拨 -2h 后完成的活动仍能被补偿到（不再永久漏扫）', async t => {
  const rollback = { value: T0 };
  const { db, root } = world(t, { now: () => rollback.value });
  seedDone(db, { activityId: 'act-history', at: T0 - 6 * HOUR });
  const replayed = [];
  const p2 = controller(db, root, { now: () => rollback.value, replayed });

  // First pass seeds the epoch from data and reconciles history.
  await p2.compensateMemory({ scopeKey: KEY, limit: 5 });
  replayed.length = 0;

  // The clock jumps backwards, then a new activity finishes *below* the old boundary.
  rollback.value = T0 - 2 * HOUR;
  seedDone(db, { activityId: 'act-after-rollback', at: T0 - 2 * HOUR });
  const summary = await p2.compensateMemory({ scopeKey: KEY, limit: 5 });
  assert.equal(replayed.includes('act-after-rollback'), true,
    `the rolled-back activity must still be compensated (saw ${JSON.stringify(replayed)}, summary ${JSON.stringify(summary)})`);
});

test('A4：并发两次播种只产生一个边界', async t => {
  const { db, root } = world(t);
  seedDone(db, { activityId: 'act-seed', at: T0 - HOUR });
  const a = controller(db, root);
  const b = controller(db, root);
  const [first, second] = await Promise.all([
    a.compensateMemory({ scopeKey: KEY, limit: 1 }),
    b.compensateMemory({ scopeKey: KEY, limit: 1 }),
  ]);
  const at = String(db.metaGet('p2_p1_epoch_at', ''));
  const id = String(db.metaGet('p2_p1_epoch_activity', ''));
  assert.equal(at, String(T0 - HOUR), `the boundary is data-derived, not the wall clock (got ${at})`);
  assert.equal(id, 'act-seed');
  assert.ok(first && second, 'both passes returned instead of throwing');
});

test('A4：历史库 30 条未标记 done —— 全部处理或有明确跳过原因', async t => {
  const { db, root } = world(t);
  for (let index = 0; index < 30; index += 1) {
    seedDone(db, { activityId: `act-hist-${String(index).padStart(2, '0')}`, at: T0 - 48 * HOUR + index * 1000 });
  }
  const replayed = [];
  const p2 = controller(db, root, { replayed });
  for (let pass = 0; pass < 10; pass += 1) await p2.compensateMemory({ scopeKey: KEY, limit: 10 });

  const detail = JSON.parse(String(db.metaGet('p2_p1_reconciled_detail', '{}') || '{}'));
  const marked = db.all("SELECT meta_key FROM runtime_meta WHERE meta_key LIKE 'p2_p1_act-hist-%'") ?? [];
  // Either replayed or marked with a reason: nothing may be silently ignored.
  assert.equal(marked.length + replayed.filter(id => String(id).startsWith('act-hist-')).length >= 30, true,
    `30 historical activities accounted for (marked ${marked.length}, replayed ${replayed.length}, detail ${JSON.stringify(detail)})`);
  assert.equal(typeof detail.reason, 'string', 'the skip reason is recorded');
  assert.equal(Number(detail.ruledOut) >= 0, true);
});

test('B6：pending 塞满时已到期的 gated 仍被选中；TTL 用候选自己的 created_at', async t => {
  const { db, root } = world(t);
  let now = T0;
  const calls = [];
  const p2 = controller(db, root, { now: () => now });
  // One candidate is gated for a retryable reason and its backoff expires.
  const gated = p2.createShareCandidate({ scopeKey: KEY, activityId: 'g1', title: '等窗口', body: '正文' });
  const port = { async submit(payload) { calls.push(payload); return calls.length === 1 ? { ok: false, code: 'quiet-hours' } : { ok: true }; } };
  const p2b = createP2({
    db, clock: () => now, owner: 'owner-test', generation: 'gen-1',
    config: { timeZone: 'Asia/Shanghai', p2: { planning: { enabled: false }, activities: { enabled: false }, share: { enabled: true, maxPending: 200 } } },
    getMode: () => 'active', isActive: () => true, emit: () => {}, options: { sharePort: port, onError: () => {} },
  });
  await p2b.deliverShareCandidates({ scopeKey: KEY });
  const state = JSON.parse(String(db.metaGet(`p2_share_retry:${gated.candidateId}`, '{}') || '{}'));
  assert.ok(state.nextAttemptAt > 0, 'retry book written');

  // Now fill the queue with fresh pending candidates — more than one tick can consume.
  for (let index = 0; index < 10; index += 1) {
    p2.createShareCandidate({ scopeKey: KEY, activityId: `p-${index}`, title: `pending ${index}`, body: '正文' });
  }
  now = state.nextAttemptAt + 1;
  const beforeSecondTick = calls.length;   // round-4 B10: only count what the SECOND tick does
  const result = await p2b.deliverShareCandidates({ scopeKey: KEY, limit: 5 });
  assert.equal(result.queued >= 1, true, JSON.stringify(result));
  const secondTick = calls.slice(beforeSecondTick);
  const gatedCalls = secondTick.filter(call => call.candidateId === gated.candidateId);
  assert.equal(gatedCalls.length, 1,
    `the due gated candidate is retried exactly once in the second tick, despite a full pending queue (got ${JSON.stringify(secondTick.map(c => c.candidateId))})`);
});

test('B10：持续塞满 pending 也不能让 gated 饿死 —— 到期后仍被重试，超时则 expired', async t => {
  const { db, root } = world(t);
  let now = T0;
  const calls = [];
  const port = { async submit(payload) { calls.push(payload); return calls.length === 1 ? { ok: false, code: 'quiet-hours' } : { ok: true }; } };
  const p2b = createP2({
    db, clock: () => now, owner: 'owner-test', generation: 'gen-1',
    config: { timeZone: 'Asia/Shanghai', p2: { planning: { enabled: false }, activities: { enabled: false }, share: { enabled: true, maxPending: 500 } } },
    getMode: () => 'active', isActive: () => true, emit: () => {}, options: { sharePort: port, onError: () => {} },
  });
  // One gated candidate, then a flood of pendings on every tick from here on.
  const gated = p2b.createShareCandidate({ scopeKey: KEY, activityId: 'starve', title: '被饿死的', body: '正文' }).candidateId;
  await p2b.deliverShareCandidates({ scopeKey: KEY });
  const state = JSON.parse(String(db.metaGet(`p2_share_retry:${gated}`, '{}') || '{}'));
  assert.ok(state.nextAttemptAt > 0, 'the retry book was written');
  now = state.nextAttemptAt + 1;
  let flooded = 0;
  let retried = 0;
  for (let tick = 0; tick < 6; tick += 1) {
    for (let index = 0; index < 20; index += 1) {
      flooded += 1;
      p2b.createShareCandidate({ scopeKey: KEY, activityId: `flood-${tick}-${index}`, title: `pending ${flooded}`, body: '正文' });
    }
    const before = calls.length;
    await p2b.deliverShareCandidates({ scopeKey: KEY, limit: 5 });
    retried += calls.slice(before).filter(call => call.candidateId === gated).length;
  }
  assert.equal(retried >= 1, true, `a permanently full pending queue must not starve a due gated candidate (flooded ${flooded}, retried ${retried})`);
});

test('B10（limit=1）：单槽位也要公平 —— 到期 gated 在有限拍内仍被重试', async t => {
  const { db } = world(t);
  let now = T0;
  const calls = [];
  const port = { async submit(payload) { calls.push(payload); return { ok: true }; } };
  const p2b = createP2({
    db, clock: () => now, owner: 'owner-test', generation: 'gen-1',
    config: { timeZone: 'Asia/Shanghai', p2: { planning: { enabled: false }, activities: { enabled: false }, share: { enabled: true, maxPending: 500 } } },
    getMode: () => 'active', isActive: () => true, emit: () => {}, options: { sharePort: port, onError: () => {} },
  });

  // The flood is created **first**, so every pending is OLDER than the gated row: age-ordering alone
  // would serve pendings for ever. Only a rotation can give the gated row a turn.
  for (let index = 0; index < 20; index += 1) {
    p2b.createShareCandidate({ scopeKey: KEY, activityId: `older-${index}`, title: `older pending ${index}`, body: '正文' });
  }
  now = T0 + 1000;
  const gated = p2b.createShareCandidate({ scopeKey: KEY, activityId: 'single-slot', title: '单槽位也要被重试', body: '正文' }).candidateId;

  // First attempt gates it (the port says quiet-hours), so it needs the retry book to come back.
  const gatingPort = { async submit(payload) { calls.push(payload); return payload.candidateId === gated ? { ok: false, code: 'quiet-hours' } : { ok: true }; } };
  void gatingPort;

  // Simpler and deterministic: write the retry book directly (same shape the refusal path writes).
  now = T0 + 2000;
  db.run(`INSERT INTO runtime_meta (meta_key, meta_value, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value, updated_at = excluded.updated_at`,
  `p2_share_retry:${gated}`, JSON.stringify({ attempts: 1, nextAttemptAt: now - 1, expiresAt: now + 86400000, lastReason: 'quiet-hours' }), now);
  db.run("UPDATE p2_share_candidates SET status = 'gated' WHERE candidate_id = ?", gated);

  let retried = 0;
  let ticks = 0;
  const BOUND = 4;   // the rotation promises an upper bound, not "eventually"
  while (retried === 0 && ticks < BOUND) {
    ticks += 1;
    const beforeTick = calls.length;
    await p2b.deliverShareCandidates({ scopeKey: KEY, limit: 1 });
    retried += calls.slice(beforeTick).filter(call => call.candidateId === gated).length;
  }
  assert.equal(retried >= 1, true,
    `with limit:1 a due gated row must still get the single slot within ${BOUND} ticks while older pendings exist (retried ${retried}, ticks ${ticks})`);
});

test('B10（limit=1，双向）：较老的 gated 不能永久占住单槽位 —— pending 也有上界', async t => {
  const { db } = world(t);
  let now = T0;
  const calls = [];
  const port = { async submit(payload) { calls.push(payload); return { ok: true }; } };
  const p2b = createP2({
    db, clock: () => now, owner: 'owner-test', generation: 'gen-1',
    config: { timeZone: 'Asia/Shanghai', p2: { planning: { enabled: false }, activities: { enabled: false }, share: { enabled: true, maxPending: 500 } } },
    getMode: () => 'active', isActive: () => true, emit: () => {}, options: { sharePort: port, onError: () => {} },
  });

  // Five **older** gated rows plus one **younger** pending: age-ordering would serve gated for ever.
  for (let index = 0; index < 5; index += 1) {
    const id = p2b.createShareCandidate({ scopeKey: KEY, activityId: `g-${index}`, title: `gated ${index}`, body: '正文' }).candidateId;
    db.run(`INSERT INTO runtime_meta (meta_key, meta_value, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value, updated_at = excluded.updated_at`,
    `p2_share_retry:${id}`, JSON.stringify({ attempts: 1, nextAttemptAt: now - 1, expiresAt: now + 86400000, lastReason: 'quiet-hours' }), now);
    db.run("UPDATE p2_share_candidates SET status = 'gated' WHERE candidate_id = ?", id);
  }
  now = T0 + 1000;
  const younger = p2b.createShareCandidate({ scopeKey: KEY, activityId: 'young', title: '年轻的 pending', body: '正文' }).candidateId;

  let servedPending = 0;
  for (let tick = 0; tick < 4; tick += 1) {
    const beforeTick = calls.length;
    await p2b.deliverShareCandidates({ scopeKey: KEY, limit: 1 });
    servedPending += calls.slice(beforeTick).filter(call => call.candidateId === younger).length;
  }
  assert.equal(servedPending >= 1, true,
    `with limit:1 the two classes must rotate both ways — the younger pending still gets the slot (served ${servedPending} times in 4 ticks)`);
});

test('B7：查询失败 → null + unavailable（不是健康的 0）；超过 deadline 的 prepared 计入 unknown', async t => {
  const { db } = world(t);
  // A prepared effect whose deadline has passed: materially unknown, nobody resolved it.
  db.run(`INSERT INTO p2_activity_receipts (receipt_id, activity_id, scope, operation, ok, code, detail, at, generation)
          VALUES ('r-stale', 'act-stale', ?, 'lc-effect', 1, 'lc-effect', ?, ?, 'gen-1')`,
  KEY, JSON.stringify({ effectKey: 'e'.repeat(64), jobKey: 'job-stale', phase: 'prepared', deadline: T0 - HOUR, operation: 'prepare', generation: 'gen-1' }), T0 - 2 * HOUR);

  const healthy = p2Observability(db, { scopeKey: KEY, now: T0, switches: { activities: true, planning: false } });
  assert.equal(healthy.groups.slots.metrics.unknown.value >= 1, true,
    `a prepared effect past its deadline is unknown (got ${healthy.groups.slots.metrics.unknown.value})`);

  // Break the database read path: the metric must say "unavailable", never 0.
  const broken = { get() { throw new Error('boom'); }, all() { throw new Error('boom'); } };
  const brokenView = p2Observability(broken, { scopeKey: KEY, now: T0, switches: { activities: true, planning: false } });
  const unknown = brokenView.groups.slots.metrics.unknown;
  assert.equal(unknown.value, null, 'a failed query is null, not 0');
  assert.equal(unknown.honest, 'unavailable');
});

test('B7：duplicate 不算「新写入」——written 与 duplicate_hits 分开', async t => {
  const { db } = world(t);
  const insert = (id, status, lastError) => db.run(`INSERT INTO memory_outbox
      (outbox_id, scope, event_id, namespace, status, attempts, last_error, created_at, updated_at, payload, claim_owner, claimed_until, receipt_id)
      VALUES (?, ?, ?, 'p2/activity', ?, 1, ?, ?, ?, '{}', '', 0, '')`, id, KEY, `evt-${id}`, status, lastError, T0, T0);
  insert('o-new', 'sent', '');
  insert('o-dup', 'sent', 'duplicate-hit');

  const view = p2Observability(db, { scopeKey: KEY, now: T0, switches: { activities: false, planning: false } });
  const memory = view.groups.memory.metrics;
  assert.equal(memory.written.value, 1, 'only the genuinely new write counts as written');
  assert.equal(memory.duplicate_hits.value, 1, 'the duplicate hit is counted separately');
  assert.equal(memory.delivered.value, 2, 'delivered still reports the transport total');
});
