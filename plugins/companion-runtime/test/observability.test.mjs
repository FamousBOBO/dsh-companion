import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openRuntimeDb } from '../lib/db.mjs';
import { p2Observability, metric } from '../lib/observability.mjs';
import { status } from '../lib/diagnostics.mjs';
import { scopeKey } from '../lib/scope.mjs';
import { normalizeEvent, dispatchEvent } from '../lib/events.mjs';
import { enqueueIngest } from '../lib/bridge.mjs';

// P2.5-4C：八类观测指标。核心要求是**诚实**：能算的标 measured，估算的标 estimated，
// 没接线的标 not-wired 且 value 为 null —— 不许用 0 冒充"一切正常"。

const T0 = Date.UTC(2026, 10, 4, 3, 0, 0);
const HOUR = 3600000;
const SCOPE = Object.freeze({ userId: 'owner-1', personaId: 'march7', worldId: 'world:default' });
const KEY = scopeKey(SCOPE);

function world(t) {
  const db = openRuntimeDb({ file: ':memory:', now: () => T0 });
  t.after(() => { try { db.close(); } catch { /* closed */ } });
  db.acquireLease({ owner: '999999:tester:test', generation: 'gen-1', ttlMs: 600000 });
  db.commitProjection({ scope: KEY, generation: 'gen-1', payload: {}, updatedAt: T0 });
  return db;
}

function seedEvidence(db) {
  db.run(`INSERT INTO p2_plans (plan_id, scope, day, version, status, time_zone, window_start, window_end, summary, source_run_id, supersedes, created_at, committed_at)
          VALUES ('plan-1', ?, '2026-11-04', 1, 'committed', 'Asia/Shanghai', ?, ?, '', '', '', ?, ?)`,
  KEY, T0 - 6 * HOUR, T0 + 6 * HOUR, T0, T0);
  db.run(`INSERT INTO p2_plan_slots (slot_id, plan_id, scope, day, start_at, end_at, kind, activity, title, detail,
            flexibility, intent, target_ref, status, locked, created_at, updated_at)
          VALUES ('slot-done', 'plan-1', ?, '2026-11-04', ?, ?, 'read', 'read', '深处', '{}', 'soft', '', 'shelf/deep.md', 'started', 0, ?, ?)`,
  KEY, T0 - HOUR, T0 + HOUR, T0, T0);
  db.run(`INSERT INTO p2_plan_slots (slot_id, plan_id, scope, day, start_at, end_at, kind, activity, title, detail,
            flexibility, intent, target_ref, status, locked, created_at, updated_at)
          VALUES ('slot-overdue', 'plan-1', ?, '2026-11-04', ?, ?, 'read', 'read', '深处', '{}', 'soft', '', 'shelf/deep.md', 'planned', 0, ?, ?)`,
  KEY, T0 - 4 * HOUR, T0 - 3 * HOUR, T0, T0);
  db.run(`INSERT INTO p2_activities (activity_id, scope, plan_slot_id, kind, adapter, capability, reality, status,
            target, source_ref, source_hash, total_units, consumed_prefix, checkpoint, artifact_ref, artifact_hash,
            artifact_version, started_at, paused_at, ended_at, created_at, updated_at)
          VALUES ('act-1', ?, 'slot-done', 'read', 'read', 'read', 'actual_tool_activity', 'done',
            'shelf/deep.md', 'file:shelf/deep.md', ?, 400, 400, '{}', '', '', 0, ?, 0, ?, ?, ?)`,
  KEY, 'a'.repeat(64), T0 - HOUR + 1500, T0, T0, T0);
  db.run(`INSERT INTO p2_activity_receipts (receipt_id, activity_id, scope, operation, ok, code, detail, at, generation)
          VALUES ('rcpt-1', 'act-1', ?, 'finish', 1, '', '', ?, 'gen-1')`, KEY, T0);
  // An unanswered outward call: this is what `unknown` must count.
  db.run(`INSERT INTO p2_activity_receipts (receipt_id, activity_id, scope, operation, ok, code, detail, at, generation)
          VALUES ('rcpt-eff-1', 'act-1', ?, 'prepare', 0, 'lc-effect', ?, ?, 'gen-1')`,
  KEY, JSON.stringify({ lifecycleVersion: 1, effectKey: 'e1', jobKey: 'job-1', phase: 'prepared', deadline: T0 + 100, generation: 'gen-1', operation: 'prepare' }), T0);
  db.run(`INSERT INTO p2_activity_receipts (receipt_id, activity_id, scope, operation, ok, code, detail, at, generation)
          VALUES ('rcpt-eff-2', 'act-1', ?, 'prepare', 0, 'lc-effect', ?, ?, 'gen-1')`,
  KEY, JSON.stringify({ lifecycleVersion: 1, effectKey: 'e1', jobKey: 'job-1', phase: 'unknown', deadline: T0 + 100, generation: 'gen-1', operation: 'prepare' }), T0 + 1);
  db.run(`INSERT INTO p2_plan_runs (run_id, scope, day, kind, status, model_purpose, input_chars, output_chars, input_tokens, output_tokens, started_at)
          VALUES ('run-1', ?, '2026-11-04', 'planning', 'ok', 'p2-planning', 1000, 200, 0, 0, ?)`, KEY, T0);
  db.run(`INSERT INTO p2_budget_ledger (entry_id, scope, day, kind, amount, purpose, ref, at, reserved, settled, issued)
          VALUES ('bg-1', ?, '2026-11-04', 'planning', 10, 'p2-planning', 'run-1', ?, 0, 3, 0)`, KEY, T0);
  db.run(`INSERT INTO p2_share_candidates (candidate_id, scope, activity_id, kind, title, body, source_ref, status, created_at,
            decision_at, decision_reason)
          VALUES ('cand-1', ?, 'act-1', 'activity', '深处', '正文不应出现在指标里', 'file:shelf/deep.md', 'pending', ?, 0, '')`, KEY, T0);
  db.run(`INSERT INTO agenda_occurrences (occurrence_id, scope, item_id, slot_key, definition_revision, scheduled_at, status, created_at, updated_at)
          VALUES ('occ-1', ?, 'item-1', 'k1', 1, ?, 'due', ?, ?)`, KEY, T0 - 1000, T0, T0);
  const event = normalizeEvent({
    kind: 'memory/ingest-request', scope: SCOPE, occurredAt: T0,
    realityStatus: 'actual_tool_activity', evidenceStatus: 'observed',
    payload: { namespace: 'p2/activity', content: '完成了一次阅读', transformVersion: 'p2-activity-v1' },
  });
  dispatchEvent(db, event, { handlers: {}, generation: 'gen-1', owner: '999999:tester:test' });
  enqueueIngest(db, { event, scope: SCOPE, generation: 'gen-1', owner: '999999:tester:test', at: T0 });
}

test('八类指标都在，且每条字段都带 {value, source, honest}', t => {
  const db = world(t);
  seedEvidence(db);
  const snapshot = p2Observability(db, { scopeKey: KEY, now: T0 + 2 * HOUR, switches: { activities: true, planning: true } });
  assert.equal(snapshot.projection, true, 'it announces itself as a projection');
  assert.equal(snapshot.authority, 'lib/p2.mjs status()', 'and names the authority');
  const names = ['slots', 'latency', 'liveness', 'model', 'memory', 'reminders', 'share', 'recovery'];
  assert.deepEqual(Object.keys(snapshot.groups).sort(), [...names].sort(), 'all eight groups are present');
  for (const name of names) {
    const group = snapshot.groups[name];
    assert.ok(['active', 'disabled', 'not-wired'].includes(group.state), `${name}.state is honest`);
    for (const [field, entry] of Object.entries(group.metrics)) {
      assert.ok(entry && typeof entry === 'object', `${name}.${field} is an object`);
      assert.ok('value' in entry, `${name}.${field} has value`);
      assert.equal(typeof entry.source, 'string', `${name}.${field} names its source`);
      assert.ok(entry.source.length > 0, `${name}.${field} source is not empty`);
      assert.ok(['measured', 'estimated', 'not-wired', 'unavailable'].includes(entry.honest), `${name}.${field} honest is one of four`);
      // B7: an unavailable metric must be null, never a healthy-looking 0.
      if (entry.honest === 'unavailable') {
        assert.equal(entry.value, null, `${name}.${field} unavailable ⇒ value must be null`);
      }
      // The soak invariant, as a test: a `not-wired` metric has **no value**, so it must be `null`.
      // `0` reads as "this run really was zero" — the exact lie the honest-metric rule forbids
      // (`model.tokens_reported` shipped as 0 for a while and only the soak caught it).
      if (entry.honest === 'not-wired') {
        assert.equal(entry.value, null, `${name}.${field} is not-wired ⇒ value must be null, never 0`);
      }
    }
  }
});

process.on('exit', () => console.log('OBSERR', JSON.stringify(globalThis.__obsErr ?? [])));
test('指标是真算出来的：未收敛 effect 记 unknown、滞后与预算都读得出来', t => {
  const db = world(t);
  seedEvidence(db);
  const g = p2Observability(db, { scopeKey: KEY, now: T0 + 2 * HOUR, switches: { activities: true, planning: true } }).groups;
  assert.equal(g.slots.metrics.unknown.value, 1, 'the effect whose latest record says unknown is counted');
  assert.equal(g.slots.metrics.unknown.honest, 'estimated');
  assert.equal(g.slots.metrics.completed.value, 1);
  assert.equal(g.slots.metrics.dispatched.value, 1);
  assert.equal(g.latency.metrics.dispatch_lag_max_ms.value, 1500, 'slot start → activity start');
  assert.equal(g.latency.metrics.dispatch_lag_max_ms.honest, 'estimated');
  assert.equal(g.model.metrics.model_calls.value, 1);
  assert.equal(g.model.metrics.budget_remaining.value, 7);
  assert.equal(g.model.metrics.tokens_estimated.value, 250, 'chars/4 heuristic stays separate from reported tokens');
  assert.equal(g.model.metrics.tokens_reported.honest, 'not-wired', 'no provider echo ⇒ not-wired, not 0');
  // The soak-found bug, pinned directly: the *value* must be null. `honest` alone was not enough
  // (it was already `not-wired` while the value said 0).
  assert.equal(g.model.metrics.tokens_reported.value, null, 'not-wired means no number at all — never 0');
  assert.equal(g.memory.metrics.events_written.value, 1);
  assert.equal(g.memory.metrics.pending.value, 1);
  assert.equal(g.recovery.metrics.overdue_count.value, 1);
  assert.equal(g.share.metrics.pending.value, 1);
  assert.equal(g.share.metrics.sent.honest, 'not-wired');
  assert.equal(g.share.metrics.sent.value, null, 'the contact side is not visible ⇒ null, not 0');
});

test('第 6 类：提醒投递没接线，必须显示 not-wired（value 为 null），绝不伪报 0', t => {
  const db = world(t);
  seedEvidence(db);
  const reminders = p2Observability(db, { scopeKey: KEY, now: T0 + 2 * HOUR }).groups.reminders;
  assert.equal(reminders.state, 'not-wired', 'the group itself says it is not wired');
  assert.equal(reminders.delivery, 'not-wired');
  assert.equal(reminders.metrics.delivered.value, null, 'null, never 0 — 0 would read as "nothing was due"');
  assert.equal(reminders.metrics.delivered.honest, 'not-wired');
  assert.equal(reminders.metrics.unknown.value, null);
  assert.equal(reminders.metrics.reminder_due.value, 1, 'what IS readable is still reported');
  assert.notEqual(reminders.metrics.reminder_due.honest, 'not-wired');
});

test('能力存在但关着 → state=disabled，而不是看起来健康的 active', t => {
  const db = world(t);
  seedEvidence(db);
  const g = p2Observability(db, { scopeKey: KEY, now: T0, switches: { activities: false, planning: false } }).groups;
  assert.equal(g.slots.state, 'disabled');
  assert.equal(g.latency.state, 'disabled');
  assert.equal(g.model.state, 'disabled');
  assert.equal(g.recovery.state, 'disabled');
  assert.equal(g.memory.state, 'active', 'the outbox does not depend on those switches');
});

test('脱敏：快照里不出现正文，只有 id/计数/时长/错误码', t => {
  const db = world(t);
  seedEvidence(db);
  const text = JSON.stringify(p2Observability(db, { scopeKey: KEY, now: T0 + 2 * HOUR }));
  assert.equal(text.includes('正文不应出现在指标里'), false, 'a share candidate body never leaks');
  assert.equal(text.includes('完成了一次阅读'), false, 'experience text never leaks');
  assert.ok(text.length < 20000, 'bounded snapshot');
});

test('空库也能出快照，且不会把"没数据"说成 measured 的 0', t => {
  const db = world(t);
  const g = p2Observability(db, { scopeKey: KEY, now: T0 }).groups;
  assert.equal(g.slots.metrics.completed.value, 0);
  assert.equal(g.slots.metrics.completed.honest, 'measured');
  assert.equal(g.latency.metrics.claim_age_ms.value, null);
  assert.equal(g.latency.metrics.claim_age_ms.honest, 'not-wired');
  assert.equal(g.liveness.metrics.lease_generation.honest, 'measured', 'world() holds the lease, so it is measurable');
});

test('status() 暴露只读投影，且明确是投影', t => {
  const db = world(t);
  seedEvidence(db);
  const snapshot = status(db, { scopeKey: KEY, config: { p2: { activities: { enabled: true }, planning: { enabled: true } } } });
  assert.equal(snapshot.observability.projection, true);
  assert.equal(snapshot.observability.authority, 'lib/p2.mjs status()');
  assert.equal(snapshot.observability.groups.reminders.state, 'not-wired');
});

test('metric() 的三件套不会被缺省值骗过', () => {
  assert.deepEqual(metric(0, 'x'), { value: 0, source: 'x', honest: 'measured' });
  assert.deepEqual(metric(undefined, 'x'), { value: null, source: 'x', honest: 'unavailable' }, 'a null value cannot be labelled measured');
  assert.deepEqual(metric(0, 'x', 'estimated'), { value: 0, source: 'x', honest: 'estimated' }, 'a real 0 keeps its label');
  assert.deepEqual(metric(null, 'x', 'not-wired'), { value: null, source: 'x', honest: 'not-wired' });
});

// B1（round-3）：发布成功但**读不回来**必须是可观测的，不能只靠日志。
test('B1：agenda publication 进观测（未发布 = not-wired，发布未验证 = 0/measured）', t => {
  const db = world(t);   // world() returns the handle itself
  const notYet = { groups: p2Observability(db, { scopeKey: 's:1', now: 1 }).groups };
  const before = notYet.groups.reminders.metrics.publication;
  assert.equal(before.value, null, 'before publishing there is no measurement to report');
  assert.equal(before.honest, 'not-wired');

  const verified = p2Observability(db, { scopeKey: 's:1', now: 1, agendaPublication: { via: 'provide', verified: true } }).groups.reminders.metrics.publication;
  assert.equal(verified.value, 1);
  assert.equal(verified.honest, 'measured');
  assert.equal(verified.source.includes('tier=provide'), true);

  const unreadable = p2Observability(db, { scopeKey: 's:1', now: 1, agendaPublication: { via: 'property', verified: false } }).groups.reminders.metrics.publication;
  assert.equal(unreadable.value, 0, 'published but unreadable is a 0, and it is visible');
  assert.equal(unreadable.honest, 'measured');
  assert.equal(unreadable.source.includes('MISS'), true);
});

// round-4 B11：查询失败必须是 null/unavailable —— 之前 completed / model_calls / pending / rejected
// 在"所有查询都抛错"时仍然报 0/measured，也就是数据库坏掉看起来像健康。
test('B11：所有查询抛错 → 全部 null/unavailable（绝不 0/measured）', t => {
  const handle = world(t);
  const boom = {
    all() { throw new Error('the database is gone'); },
    get() { throw new Error('the database is gone'); },
  };
  const g = p2Observability(boom, { scopeKey: KEY, now: T0, switches: { activities: true, planning: true } }).groups;
  assert.equal(handle !== null, true);
  for (const [group, metrics] of Object.entries(g)) {
    for (const [name, field] of Object.entries(metrics.metrics ?? {})) {
      const label = `${group}.${name}`;
      if (field.honest === 'not-wired') continue;   // a capability that does not exist is not a failure
      assert.equal(field.value, null, `${label} must be null when the query failed (got ${JSON.stringify(field)})`);
      assert.equal(field.honest, 'unavailable', `${label} must be labelled unavailable (got ${field.honest})`);
    }
  }
});

test('B11：查询正常但没有数据 → 0/measured（这是合法测量，不是 unavailable）', t => {
  const db = world(t);
  const g = p2Observability(db, { scopeKey: KEY, now: T0, switches: { activities: true, planning: true } }).groups;
  assert.equal(g.slots.metrics.completed.value, 0);
  assert.equal(g.slots.metrics.completed.honest, 'measured');
  assert.equal(g.model.metrics.model_calls.value, 0);
  assert.equal(g.model.metrics.model_calls.honest, 'measured');
  assert.equal(g.memory.metrics.pending.value, 0);
  assert.equal(g.memory.metrics.pending.honest, 'measured');
  assert.equal(g.share.metrics.expired.value, 0, 'no expired rows is a legitimate zero');
  assert.equal(g.share.metrics.expired.honest, 'measured');
});
