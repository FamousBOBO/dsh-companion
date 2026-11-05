import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openRuntimeDb } from '../lib/db.mjs';
import { createP2 } from '../lib/p2.mjs';
import { scopeKey as scopeKeyOf } from '../lib/scope.mjs';

// A4 残留（soak 证实的**数据永久丢失**路径）：`reconcileLegacyOnce` 之前用 `updated_at <= epoch` 决定
// "假定已经写过"。于是 `= epoch` 和 `- 2h` 的行被永久标成 legacy —— 永远不进补偿候选，事实永久丢失。
//
// 现在判据改成**证据**：只有真的存在 P1 事实（`domain_events` 里 `facts.activityId` 命中）才标
// legacy；没有事实的行交给补偿，无论它的时间戳在哪。时间只用于分批顺序。

const T0 = Date.UTC(2026, 10, 15, 3, 0, 0);
const HOUR = 3_600_000;
const SCOPE = Object.freeze({ userId: 'owner-1', personaId: 'march7', worldId: 'world:default' });
const KEY = scopeKeyOf(SCOPE);

function world(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a4-evidence-'));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }); } catch { /* best effort */ } });
  const db = openRuntimeDb({ file: ':memory:', now: () => T0 });
  t.after(() => { try { db.close(); } catch { /* closed */ } });
  db.acquireLease({ owner: 'owner-test', generation: 'gen-1', ttlMs: 365 * 24 * 3600 * 1000 });
  db.commitProjection({ scope: KEY, generation: 'gen-1', payload: {}, updatedAt: T0 });
  return { db, root };
}

function seedDone(db, { activityId, at }) {
  db.run(`INSERT INTO p2_activities (activity_id, scope, plan_slot_id, kind, adapter, capability, reality, status,
            target, source_ref, source_hash, total_units, consumed_prefix, checkpoint, artifact_ref, artifact_hash,
            artifact_version, started_at, paused_at, ended_at, created_at, updated_at)
          VALUES (?, ?, '', 'read', 'read', 'read', 'actual_tool_activity', 'done',
            'shelf/tide.md', 'file:shelf/tide.md', ?, 100, 100, '{}', '', '', 0, ?, 0, ?, ?, ?)`,
  activityId, KEY, 'c'.repeat(64), at, at, at, at);
}

function seedFact(db, activityId, at) {
  db.run(`INSERT INTO domain_events (seq, event_id, schema_version, kind, scope, user_id, persona_id, world_id,
            occurred_at, recorded_at, payload)
          VALUES (?, ?, 1, 'memory/ingest-request', ?, 'owner-1', 'march7', 'world:default', ?, ?, ?)`,
  Math.floor(Math.random() * 1e6) + 1000, `evt_${activityId}`, KEY, at, at,
  JSON.stringify({ namespace: 'p2/activity', facts: { activityId } }));
}

function controller(db, root, replayed) {
  return createP2({
    db, clock: () => T0, owner: 'owner-test', generation: 'gen-1',
    config: { timeZone: 'Asia/Shanghai', p2: { planning: { enabled: false }, activities: { enabled: true, paused: false }, share: { enabled: false } } },
    getMode: () => 'active', isActive: () => true, emit: () => {},
    options: {
      ports: { async readFile() { return { ok: false }; }, async writeFile() { return { ok: false }; }, async fetchPage() { return { ok: false }; } },
      artifactRoot: root,
      onFinished: info => { replayed.push(String(info.activityId)); return { ok: true }; },
      onError: () => {},
    },
  });
}

test('A4：等于 epoch 与早于 epoch 的行，只要没有事实，就必须被补偿', async t => {
  const { db, root } = world(t);
  // One activity defines the epoch (the newest `done` row when the hook mounts).
  seedDone(db, { activityId: 'act-anchor', at: T0 - 6 * HOUR });
  const replayed = [];
  const p2 = controller(db, root, replayed);
  await p2.compensateMemory({ scopeKey: KEY, limit: 5 });   // seeds the epoch + reconciles
  replayed.length = 0;

  // Now the two rows the soak flagged: one exactly at the epoch, one two hours before it. Neither has a
  // fact, so both are compensation's work.
  seedDone(db, { activityId: 'act-edge', at: T0 - 6 * HOUR });
  seedDone(db, { activityId: 'act-below', at: T0 - 8 * HOUR });
  for (let pass = 0; pass < 4; pass += 1) await p2.compensateMemory({ scopeKey: KEY, limit: 10 });

  assert.equal(replayed.includes('act-edge'), true, `a row at the epoch with no fact must be compensated (saw ${JSON.stringify(replayed)})`);
  assert.equal(replayed.includes('act-below'), true, `a row below the epoch with no fact must be compensated (saw ${JSON.stringify(replayed)})`);
});

test('A4：有事实的行被标成 legacy 且不再补（证据判定）', async t => {
  const { db, root } = world(t);
  seedDone(db, { activityId: 'act-anchor', at: T0 - 6 * HOUR });
  seedDone(db, { activityId: 'act-has-fact', at: T0 - 9 * HOUR });
  seedFact(db, 'act-has-fact', T0 - 9 * HOUR);

  const replayed = [];
  const p2 = controller(db, root, replayed);
  for (let pass = 0; pass < 4; pass += 1) await p2.compensateMemory({ scopeKey: KEY, limit: 10 });

  assert.equal(replayed.includes('act-has-fact'), false, 'a row that already has a fact is never replayed');
  assert.equal(String(db.metaGet('p2_p1_act-has-fact', '')), 'legacy', 'it is marked, and the reason is "a fact exists"');
  const detail = JSON.parse(String(db.metaGet('p2_p1_reconciled_detail', '{}') || '{}'));
  assert.equal(detail.ruling, 'evidence', 'the reconciliation records which rule it used');
  assert.equal(typeof detail.ruledOut, 'number', 'and it reports the two counts separately');
  assert.equal(typeof detail.leftForCompensation, 'number');
});
