import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openRuntimeDb } from '../lib/db.mjs';
import { scopeKey as scopeKeyOf } from '../lib/scope.mjs';
import { createP2 } from '../lib/p2.mjs';
import { mountRuntime } from '../index.mjs';

// 第五轮复审的三条数据正确性 P1：
//   A. 重审用本 scope 的事实，却撤销**别人**的 legacy 标记；
//   B. 对账 deferred 之后仍然继续补偿（"不知道有没有事实" 被当成 "没有事实"）；
//   C. `claimKey` 作用域错 ⇒ 结算抛 ReferenceError 被空 catch 吞掉 ⇒ 去重 claim 永不结算。

const T0 = Date.UTC(2026, 10, 23, 3, 0, 0);
const HOUR = 3_600_000;
const A = Object.freeze({ userId: 'owner-1', personaId: 'bot', worldId: 'world:a' });
const B = Object.freeze({ userId: 'owner-1', personaId: 'bot', worldId: 'world:b' });
const KEY_A = scopeKeyOf(A);
const KEY_B = scopeKeyOf(B);

function world(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-round5-'));
  const db = openRuntimeDb({ file: ':memory:', now: () => T0 });
  t.after(() => {
    try { db.close(); } catch { /* closed */ }
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }); } catch { /* best effort */ }
  });
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
          VALUES (?, ?, 1, 'memory/ingest-request', ?, 'owner-1', 'bot', 'x', ?, ?, ?)`,
  seq, `evt_${activityId}_${seq}`, scopeKey, at, at, JSON.stringify({ namespace: 'p2/activity', facts: { activityId } }));
}

function markLegacy(db, activityId) {
  db.run(`INSERT INTO runtime_meta (meta_key, meta_value, updated_at) VALUES (?, 'legacy', ?)
          ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value, updated_at = excluded.updated_at`,
  `p2_p1_${activityId}`, T0);
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
      onError: () => {},
    },
  });
}

test('1. 重审只动本 scope：A 的重审不会撤销 B 的 legacy 标记', async t => {
  const { db, root } = world(t);
  // Both scopes: one row WITH a fact (must keep its mark), one row WITHOUT (may be revoked).
  seedDone(db, { scopeKey: KEY_A, activityId: 'a-withfact', at: T0 - 10 * HOUR });
  seedFact(db, { scopeKey: KEY_A, activityId: 'a-withfact', at: T0 - 10 * HOUR, seq: 1 });
  seedDone(db, { scopeKey: KEY_A, activityId: 'a-nofact', at: T0 - 9 * HOUR });
  seedDone(db, { scopeKey: KEY_B, activityId: 'b-withfact', at: T0 - 10 * HOUR });
  seedFact(db, { scopeKey: KEY_B, activityId: 'b-withfact', at: T0 - 10 * HOUR, seq: 2 });
  markLegacy(db, 'a-withfact');
  markLegacy(db, 'a-nofact');
  markLegacy(db, 'b-withfact');

  const replayed = [];
  const p2 = controller(db, root, replayed);

  // Alternate: A, B, A, B — the old code revoked everything it could see, whichever scope it belonged to.
  for (let pass = 0; pass < 4; pass += 1) {
    const r = await p2.compensateMemory({ scopeKey: pass % 2 === 0 ? KEY_A : KEY_B, limit: 10 });
  }

  const markOf = id => String(db.get('SELECT meta_value FROM runtime_meta WHERE meta_key = ?', `p2_p1_${id}`)?.meta_value ?? '');
  assert.equal(markOf('b-withfact'), 'legacy', 'B 这条有事实，它的标记不许被 A 的重审撤销');
  assert.equal(markOf('a-withfact'), 'legacy', 'A 自己那条有事实的也保持不变');
  assert.notEqual(markOf('a-nofact'), 'legacy', 'A 自己那条没有事实的不许保持 legacy（撤销后会被补偿写回 1）');
  assert.equal(markOf('a-nofact'), '1', '而且它真的被补偿了，标记变成已写入');
  assert.equal(replayed.includes('b-withfact'), false, 'B 的行没有被重放（没有第二份事实）');
  assert.equal(db.all("SELECT COUNT(*) AS n FROM domain_events WHERE kind = 'memory/ingest-request'")[0].n, 2,
    '没有新增事实（这一条用的替身 hook 不写事件，只有手工种下的 2 条）');
});

test('2. 事实查询持续抛错 → 本轮不补偿，hook 零调用', async t => {
  const { db, root } = world(t);
  seedDone(db, { scopeKey: KEY_A, activityId: 'a-one', at: T0 - 10 * HOUR });
  seedDone(db, { scopeKey: KEY_A, activityId: 'a-two', at: T0 - 9 * HOUR });

  let thrown = 0;
  const flaky = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'all') {
        return (sql, ...params) => {
          if (String(sql).includes("kind = 'memory/ingest-request'")) {
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
  const result = await p2.compensateMemory({ scopeKey: KEY_A, limit: 10 });

  assert.equal(thrown >= 1, true, 'the broken fact scan really ran');
  assert.equal(replayed.length, 0, `"不知道有没有事实" 不是 "没有事实"：hook 必须零调用（saw ${JSON.stringify(replayed)}）`);
  assert.equal(result?.deferred === true || result?.skipped === 'reconcile-deferred', true,
    `the pass reports why it stopped (got ${JSON.stringify(result)})`);
  assert.equal(db.all("SELECT COUNT(*) AS n FROM domain_events WHERE kind = 'memory/ingest-request'")[0].n, 0,
    '没有写出任何事实');
});

test('3. 成功 ingest 之后去重 claim 必须结算（eventPending === false）', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-claim-'));
  fs.mkdirSync(path.join(root, 'home', 'companion'), { recursive: true });
  fs.writeFileSync(path.join(root, 'home', 'companion', 'runtime.config.json'), JSON.stringify({
    enabled: true, mode: 'active', timeZone: 'Asia/Shanghai',
    p2: { activities: { enabled: true }, planning: { enabled: false }, share: { enabled: false } },
  }, null, 2), 'utf8');
  const identity = {
    owner: () => ({ id: 'owner-1', displayName: 'owner-1', platform: 'local' }),
    resolve: sessionId => ({ userId: 'owner-1', personaId: 'bot', displayName: 'owner-1', sessionId }),
  };
  const dbFile = path.join(root, 'home', 'companion', 'runtime.db');
  const runtime = mountRuntime(null, root, { memory: null, identity, dbFile, now: () => T0 });
  t.after(() => {
    try { runtime.dispose?.(); } catch { /* disposed */ }
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ }
  });

  const outcome = runtime.recordActivityOutcome({
    scopeKey: 'u:owner-1|p:bot|w:world:default',
    activityId: 'act-claim-1',
    slotId: 'slot-1',
    kind: 'read',
    target: 'shelf/claim.md',
    phase: 'finished',
    reality: 'actual_tool_activity',
    consumedPrefix: 120,
    totalUnits: 400,
    artifactVersion: 1,
    sourceRef: 'file:shelf/claim.md',
    at: T0,
  });
  assert.equal(outcome?.ok, true, `the outcome was recorded (got ${JSON.stringify(outcome)})`);

  // Read the claim from a second handle on the same file: the runtime keeps its own handle private, and
  // a persistence claim deserves a read of the bytes on disk rather than of a returned object.
  const reader = openRuntimeDb({ file: dbFile, now: () => T0 });
  t.after(() => { try { reader.close(); } catch { /* closed */ } });
  const claims = reader.all("SELECT meta_key, meta_value FROM runtime_meta WHERE meta_key LIKE 'p2_dedupe:%'");
  assert.equal(claims.length >= 1, true, `a dedupe claim was taken (saw ${claims.length})`);
  for (const row of claims) {
    const claim = JSON.parse(String(row.meta_value));
    assert.equal(claim.eventPending, false,
      `the claim must settle after a successful ingest (${row.meta_key} = ${JSON.stringify(claim)})`);
  }
});
