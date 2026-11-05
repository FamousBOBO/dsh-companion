import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openRuntimeDb } from '../lib/db.mjs';
import { scopeKey as scopeKeyOf } from '../lib/scope.mjs';
import { createP2 } from '../lib/p2.mjs';
import { p2Observability } from '../lib/observability.mjs';

// 第五轮收尾：滞留必须有出口，停摆必须有可见性。
//   1. `unowned`（activity 行已被清理）默认跳过，但**有带证据的人工出口**；
//   2. `foreign` / `unowned` 进诊断，而不是只进返回值；
//   3. 连续 deferral 计数 → 超过阈值报警，恢复后清零。

const T0 = Date.UTC(2026, 10, 25, 3, 0, 0);
const SCOPE_KEY = scopeKeyOf({ userId: 'owner-1', personaId: 'bot', worldId: 'world:a' });

function world(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-visibility-'));
  const db = openRuntimeDb({ file: ':memory:', now: () => T0 });
  t.after(() => {
    try { db.close(); } catch { /* closed */ }
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }); } catch { /* best effort */ }
  });
  db.acquireLease({ owner: 'owner-test', generation: 'gen-1', ttlMs: 365 * 24 * 3600 * 1000 });
  return { db, root };
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

function seedDone(db, activityId, at) {
  db.run(`INSERT INTO p2_activities (activity_id, scope, plan_slot_id, kind, adapter, capability, reality, status,
            target, source_ref, source_hash, total_units, consumed_prefix, checkpoint, artifact_ref, artifact_hash,
            artifact_version, started_at, paused_at, ended_at, created_at, updated_at)
          VALUES (?, ?, '', 'read', 'read', 'read', 'actual_tool_activity', 'done',
            'shelf/x.md', 'file:shelf/x.md', ?, 100, 100, '{}', '', '', 0, ?, 0, ?, ?, ?)`,
  activityId, SCOPE_KEY, 'c'.repeat(64), at, at, at, at);
}

function legacy(db, activityId) {
  db.run(`INSERT INTO runtime_meta (meta_key, meta_value, updated_at) VALUES (?, 'legacy', ?)
          ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value, updated_at = excluded.updated_at`,
  `p2_p1_${activityId}`, T0);
}

const stateOf = (db) => {
  try {
    return JSON.parse(String(db.metaGet(`p2_p1_reaudit_state:${SCOPE_KEY}`, '') || '{}'));
  } catch { return {}; }
};

test('1. unowned 标记默认跳过，但有带证据的人工出口', async t => {
  const { db, root } = world(t);
  // A mark whose activity row no longer exists at all.
  legacy(db, 'ghost-1');
  const seen = [];
  const p2 = createP2({
    db, clock: () => T0, owner: 'owner-test', generation: 'gen-1',
    config: { timeZone: 'Asia/Shanghai', p2: { planning: { enabled: false }, activities: { enabled: true }, share: { enabled: false } } },
    getMode: () => 'active', isActive: () => true, emit: () => {},
    options: {
      ports: { async readFile() { return { ok: false }; }, async writeFile() { return { ok: false }; }, async fetchPage() { return { ok: false }; } },
      artifactRoot: root,
      onFinished: () => ({ ok: true }),
      onError: (code, detail) => seen.push(`${code}: ${String(detail).slice(0, 40)}`),
    },
  });

  await p2.compensateMemory({ scopeKey: SCOPE_KEY, limit: 5 });
  assert.equal(String(db.metaGet('p2_p1_ghost-1', '')), 'legacy', 'default pass does not guess');
  assert.equal(Number(stateOf(db).unowned ?? 0) >= 1, true, `and it is visible in the state record (got ${JSON.stringify(stateOf(db))})`);
  assert.equal(seen.some(line => line.startsWith('p2-p1-legacy-unowned')), true, 'the operator is told');

  // The evidenced exit: without operator+evidence nothing happens.
  const refused = p2.reauditLegacy({ scopeKey: SCOPE_KEY, includeUnowned: true });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'operator-and-evidence-required');
  assert.equal(String(db.metaGet('p2_p1_ghost-1', '')), 'legacy', 'and the mark is untouched');

  const forced = p2.reauditLegacy({
    scopeKey: SCOPE_KEY, includeUnowned: true, operator: 'owner', evidence: 'activity row was pruned by the operator on 2026-11-25',
  });
  assert.equal(forced.ok, true, JSON.stringify(forced));
  assert.equal(forced.revoked >= 1, true, `the forced pass revokes it (got ${JSON.stringify(forced)})`);
  assert.equal(String(db.metaGet('p2_p1_ghost-1', '')), 'revoked');
  assert.equal(seen.some(line => line.startsWith('p2-p1-legacy-unowned-forced')), true, 'and the override is recorded');
});

test('2. foreign / unowned 计数进诊断（p2Observability）', async t => {
  const { db } = world(t);
  db.metaSet(`p2_p1_reaudit_state:${SCOPE_KEY}`, JSON.stringify({
    at: T0, checked: 3, revoked: 0, kept: 3, foreign: 7, unowned: 2, more: false, forced: false, operator: '',
  }));
  db.metaSet(`p2_p1_deferred_streak:${SCOPE_KEY}`, '5');
  const view = p2Observability(db, {
    scopeKey: SCOPE_KEY, now: T0,
    switches: { activities: true, planning: false },
  });
  const metrics = view.groups.recovery.metrics;
  assert.equal(metrics.reconcile_foreign.value, 7, `foreign is counted (got ${JSON.stringify(metrics.reconcile_foreign)})`);
  assert.equal(metrics.reconcile_foreign.honest, 'measured');
  assert.equal(metrics.reconcile_unowned.value, 2);
  assert.equal(metrics.compensation_deferred_streak.value, 5);

  // …and a scope that never audited reports unavailable, never a fake 0.
  const empty = p2Observability(db, {
    scopeKey: scopeKeyOf({ userId: 'owner-2', personaId: 'bot', worldId: 'world:z' }), now: T0,
    switches: { activities: true, planning: false },
  });
  assert.equal(empty.groups.recovery.metrics.reconcile_unowned.value, null);
  assert.equal(empty.groups.recovery.metrics.reconcile_unowned.honest, 'unavailable');
});

test('3. 连续 deferral 计数：到第 5 次报警，恢复后清零', async t => {
  const { db, root } = world(t);
  seedDone(db, 'a-one', T0 - 10 * 3600 * 1000);
  const seen = [];
  const flaky = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'all') {
        return (sql, ...params) => {
          if (String(sql).includes("kind = 'memory/ingest-request'")) throw new Error('fact table unreachable');
          return target.all(sql, ...params);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const broken = createP2({
    db: flaky, clock: () => T0, owner: 'owner-test', generation: 'gen-1',
    config: { timeZone: 'Asia/Shanghai', p2: { planning: { enabled: false }, activities: { enabled: true }, share: { enabled: false } } },
    getMode: () => 'active', isActive: () => true, emit: () => {},
    options: {
      ports: { async readFile() { return { ok: false }; }, async writeFile() { return { ok: false }; }, async fetchPage() { return { ok: false }; } },
      artifactRoot: root, onFinished: () => ({ ok: true }), onError: (code, detail) => seen.push(`${code}: ${String(detail).slice(0, 60)}`),
    },
  });

  for (let pass = 0; pass < 5; pass += 1) await broken.compensateMemory({ scopeKey: SCOPE_KEY, limit: 5 });
  assert.equal(Number(db.metaGet(`p2_p1_deferred_streak:${SCOPE_KEY}`, '0')), 5, 'the streak is persisted');
  assert.equal(seen.some(line => line.startsWith('p2-p1-compensation-stalled')), true,
    `five deferrals in a row must be reported, not silent (saw ${JSON.stringify(seen.slice(-3))})`);

  // …and once the query works again the streak resets (compensation is no longer stalled).
  const healthy = controller(db, root, []);
  await healthy.compensateMemory({ scopeKey: SCOPE_KEY, limit: 5 });
  assert.equal(Number(db.metaGet(`p2_p1_deferred_streak:${SCOPE_KEY}`, '0')), 0, 'a healthy pass clears the streak');
});
