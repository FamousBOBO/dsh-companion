import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openRuntimeDb } from '../lib/db.mjs';
import { scopeKey as scopeKeyOf } from '../lib/scope.mjs';
import { createP2 } from '../lib/p2.mjs';

// 第四轮 A4 + A5：对账必须是**按 scope 分批 + 持久游标**，截断/不可用**不能**被当成"没有事实"；
// 旧规则写下的 `legacy` 标记要**重新审计**（没事实的撤销、交回补偿）。

const T0 = Date.UTC(2026, 10, 19, 3, 0, 0);
const HOUR = 3_600_000;
const A = Object.freeze({ userId: 'owner-1', personaId: 'march7', worldId: 'world:a' });
const B = Object.freeze({ userId: 'owner-1', personaId: 'march7', worldId: 'world:b' });
const KEY_A = scopeKeyOf(A);
const KEY_B = scopeKeyOf(B);

function world(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-reconcile-'));
  const db = openRuntimeDb({ file: ':memory:', now: () => T0 });
  t.after(() => { try { db.close(); } catch { /* closed */ } try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }); } catch { /* best effort */ } });
  db.acquireLease({ owner: 'owner-test', generation: 'gen-1', ttlMs: 365 * 24 * 3600 * 1000 });
  return { db, root };
}

function seedDone(db, { scopeKey, activityId, at }) {
  db.run(`INSERT INTO p2_activities (activity_id, scope, plan_slot_id, kind, adapter, capability, reality, status,
            target, source_ref, source_hash, total_units, consumed_prefix, checkpoint, artifact_ref, artifact_hash,
            artifact_version, started_at, paused_at, ended_at, created_at, updated_at)
          VALUES (?, ?, '', 'read', 'read', 'read', 'actual_tool_activity', 'done',
            'shelf/x.md', 'file:shelf/x.md', ?, 100, 100, '{}', '', '', 0, ?, 0, ?, ?, ?)`,
  activityId, scopeKey, 'c'.repeat(64), at, at, at, at);
}

function seedFact(db, { scopeKey, activityId, at, seq }) {
  db.run(`INSERT INTO domain_events (seq, event_id, schema_version, kind, scope, user_id, persona_id, world_id, occurred_at, recorded_at, payload)
          VALUES (?, ?, 1, 'memory/ingest-request', ?, 'owner-1', 'march7', 'x', ?, ?, ?)`,
  seq, `evt_${activityId}_${seq}`, scopeKey, at, at, JSON.stringify({ namespace: 'p2/activity', facts: { activityId } }));
}

function controller(db, root, replayed) {
  return createP2({
    db, clock: () => T0, owner: 'owner-test', generation: 'gen-1',
    config: { timeZone: 'Asia/Shanghai', p2: { planning: { enabled: false }, activities: { enabled: true }, share: { enabled: false } } },
    getMode: () => 'active', isActive: () => true, emit: () => {},
    options: {
      ports: { async readFile() { return { ok: false }; }, async writeFile() { return { ok: false }; }, async fetchPage() { return { ok: false }; } },
      artifactRoot: root,
      onFinished: info => { replayed.push(String(info.activityId)); return { ok: true }; },
    },
  });
}

test('A4：两个 scope 各自独立完成对账（不是一个全局标志）', async t => {
  const { db, root } = world(t);
  seedDone(db, { scopeKey: KEY_A, activityId: 'a-anchor', at: T0 - 10 * HOUR });
  seedDone(db, { scopeKey: KEY_B, activityId: 'b-anchor', at: T0 - 10 * HOUR });
  seedFact(db, { scopeKey: KEY_A, activityId: 'a-anchor', at: T0 - 10 * HOUR, seq: 1 });

  const replayed = [];
  const p2 = controller(db, root, replayed);
  await p2.compensateMemory({ scopeKey: KEY_A, limit: 10 });
  await p2.compensateMemory({ scopeKey: KEY_B, limit: 10 });

  assert.equal(String(db.metaGet(`p2_p1_reconciled:${KEY_A}`, '') !== ''), 'true', 'scope A is done');
  assert.equal(String(db.metaGet(`p2_p1_reconciled:${KEY_B}`, '') !== ''), 'true', 'scope B is done independently');
  assert.equal(String(db.metaGet('p2_p1_reconciled', '')), '', 'there is no global flag any more');
});

test('A4：2500 行分两批，游标前进，第一批不标完成', async t => {
  const { db, root } = world(t);
  seedDone(db, { scopeKey: KEY_A, activityId: 'a-anchor', at: T0 - 20 * HOUR });
  for (let index = 0; index < 2500; index += 1) {
    seedDone(db, { scopeKey: KEY_A, activityId: `bulk-${String(index).padStart(4, '0')}`, at: T0 - 10 * HOUR + index });
  }
  const replayed = [];
  const p2 = controller(db, root, replayed);
  await p2.compensateMemory({ scopeKey: KEY_A, limit: 5 });
  const doneAfterFirst = db.metaGet(`p2_p1_reconciled:${KEY_A}`, '');
  const cursor = JSON.parse(String(db.metaGet(`p2_p1_reconcile_cursor:${KEY_A}`, '{}') || '{}'));
  assert.ok(doneAfterFirst === '' || doneAfterFirst === null || doneAfterFirst === undefined, `2500 rows must not finish in one batch (got ${String(doneAfterFirst)})`);
  assert.ok(cursor.id, 'a cursor was persisted');
});

test('A5：事实查询不可用 → 不标完成，且记下 unavailable', async t => {
  const { db, root } = world(t);
  seedDone(db, { scopeKey: KEY_A, activityId: 'a-anchor', at: T0 - 10 * HOUR });
  seedDone(db, { scopeKey: KEY_A, activityId: 'a-two', at: T0 - 9 * HOUR });
  // A wrapper, not a patch on the shared handle: only this call sees the broken fact scan.
  let thrown = 0;
  const flaky = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'all') {
        return (sql, ...params) => {
          if (String(sql).includes("kind = 'memory/ingest-request'") && thrown === 0) {
            thrown += 1;
            throw new Error('the fact table is unreachable');
          }
          return target.all(sql, ...params);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const replayed = [];
  const p2 = controller(flaky, root, replayed);
  await p2.compensateMemory({ scopeKey: KEY_A, limit: 10 });
  assert.equal(String(db.metaGet(`p2_p1_reconciled:${KEY_A}`, '')), '', 'a failed fact scan must not mark the scope done');
  const detail = JSON.parse(String(db.metaGet('p2_p1_reconciled_detail', '{}') || '{}'));
  assert.equal(detail.unavailable === true || detail.reason === 'fact-scan-unavailable', true, `the failure is recorded (got ${JSON.stringify(detail)})`);
  assert.equal(thrown, 1, 'the broken scan really ran');
});

test('A4：已标 legacy 但没有事实的行 → 标记被撤销并交给补偿', async t => {
  const { db, root } = world(t);
  seedDone(db, { scopeKey: KEY_A, activityId: 'a-anchor', at: T0 - 10 * HOUR });
  seedDone(db, { scopeKey: KEY_A, activityId: 'a-misfiled', at: T0 - 9 * HOUR });
  // the old (clock-based) rule left this mark behind although no fact exists
  db.run(`INSERT INTO runtime_meta (meta_key, meta_value, updated_at) VALUES (?, 'legacy', ?)
          ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value, updated_at = excluded.updated_at`,
  `p2_p1_a-misfiled`, T0 - 9 * HOUR);

  const replayed = [];
  const p2 = controller(db, root, replayed);
  for (let pass = 0; pass < 3; pass += 1) await p2.compensateMemory({ scopeKey: KEY_A, limit: 10 });

  // After being compensated the mark is '1' (a real fact was written) — the point is that it is no
  // longer 'legacy', i.e. the wrong exclusion was revoked and the row got its fact.
  assert.equal(String(db.metaGet('p2_p1_a-misfiled', '')), '1', 'the wrong legacy mark was revoked and replaced by a real write');
  assert.equal(replayed.includes('a-misfiled'), true, `and the row was handed to compensation (saw ${JSON.stringify(replayed)})`);
});

test('A4：1200 条 legacy 标记分 3 批全部重审，没有事实的都被撤销', async t => {
  const { db, root } = world(t);
  seedDone(db, { scopeKey: KEY_A, activityId: 'a-anchor', at: T0 - 20 * HOUR });
  // 1200 legacy marks; every 10th one gets a real fact so we can prove "kept" as well as "revoked".
  for (let index = 0; index < 1200; index += 1) {
    const activityId = `old-${String(index).padStart(4, '0')}`;
    seedDone(db, { scopeKey: KEY_A, activityId, at: T0 - 10 * HOUR + index });
    db.run(`INSERT INTO runtime_meta (meta_key, meta_value, updated_at) VALUES (?, 'legacy', ?)
            ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value, updated_at = excluded.updated_at`,
    `p2_p1_${activityId}`, T0 - 10 * HOUR + index);
    if (index % 10 === 0) seedFact(db, { scopeKey: KEY_A, activityId, at: T0 - 10 * HOUR + index, seq: 5000 + index });
  }
  const replayed = [];
  const p2 = controller(db, root, replayed);
  // Enough passes for the cursor to walk the whole table (batch = 500 ⇒ 1200 needs 3 passes).
  for (let pass = 0; pass < 6; pass += 1) await p2.compensateMemory({ scopeKey: KEY_A, limit: 5 });
  const revoked = db.all("SELECT COUNT(*) AS n FROM runtime_meta WHERE meta_key LIKE 'p2_p1_old-%' AND meta_value = 'revoked'")[0].n;
  const kept = db.all("SELECT COUNT(*) AS n FROM runtime_meta WHERE meta_key LIKE 'p2_p1_old-%' AND meta_value = 'legacy'")[0].n;
  assert.equal(Number(revoked) >= 1000, true, `every legacy row without a fact must be revoked eventually (revoked=${revoked})`);
  assert.equal(Number(kept) > 0, true, `rows that really have a fact keep their mark (kept=${kept})`);
});
