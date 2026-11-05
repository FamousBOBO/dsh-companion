import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openRuntimeDb } from '../lib/db.mjs';
import { dispatchEvent } from '../lib/events.mjs';
import { applyAgendaEvent } from '../lib/agenda.mjs';
import { casOccurrence, markOccurrenceDispatched, readDispatchReceipt } from '../lib/agenda-cas.mjs';
import { scopeKey } from '../lib/scope.mjs';

// 3A-4 / 3A-5：日程侧 CAS 接缝（真跑 DB）。
//
//   casOccurrence            — 发送前确认"这份计划还是我读到的那份"
//   markOccurrenceDispatched — 发送后记账（事件 + receipt，零 migration）
//
// 这一组测试只碰数据库与事件日志：不发 QQ、不调模型、不写 home/。

const T0 = Date.UTC(2026, 10, 4, 3, 0, 0);
const SCOPE = Object.freeze({ userId: 'owner-1', personaId: 'bot', worldId: 'world:default' });
const KEY = scopeKey(SCOPE);

function world(t) {
  const db = openRuntimeDb({ file: ':memory:', now: () => T0 });
  t.after(() => { try { db.close(); } catch { /* closed */ } });
  db.acquireLease({ owner: '999999:tester:test', generation: 'gen-1', ttlMs: 600000 });
  db.commitProjection({ scope: KEY, generation: 'gen-1', payload: {}, updatedAt: T0 });
  return db;
}

function emitFor(db) {
  return event => {
    // The production wrapper adds the scope (runtime/index.mjs); the harness must do the same,
    // otherwise normalizeEvent refuses the event for a missing scope.
    const dispatched = dispatchEvent(db, { ...event, scope: SCOPE }, {
      handlers: { agenda: applyAgendaEvent }, generation: 'gen-1', owner: '999999:tester:test', requireConsumers: true,
    });
    const failure = (dispatched.results ?? []).find(result => result.error);
    if (dispatched.rejected || failure) throw new Error(failure?.code ?? 'event-rejected');
    return dispatched;
  };
}

function seedItem(db, { status = 'active', revision = 1 } = {}) {
  db.run(`INSERT INTO agenda_items (item_id, scope, revision, title, category, source, rule_kind, time_zone,
            local_date, local_time, weekdays, at_utc, valid_from, valid_until, status, created_at, updated_at)
          VALUES ('item-1', ?, ?, '散步', 'plan', 'tool', 'daily', 'Asia/Shanghai', '', '07:00', '[]', NULL, 0, 0, ?, ?, ?)`,
  KEY, revision, status, T0, T0);
}

function seedOccurrence(db, { status = 'scheduled', revision = 1, dueAt = T0 + 3600000, slotKey = 'k-1' } = {}) {
  db.run(`INSERT INTO agenda_occurrences (occurrence_id, scope, item_id, slot_key, definition_revision, scheduled_at,
            slot_end_at, status, reason_code, revision, created_at, updated_at)
          VALUES ('occ-1', ?, 'item-1', ?, 1, ?, ?, ?, '', ?, ?, ?)`,
  KEY, slotKey, dueAt, dueAt + 600000, status, revision, T0, T0);
}

const occurrenceRow = db => db.get("SELECT * FROM agenda_occurrences WHERE scope = ? AND occurrence_id = 'occ-1'", KEY);
const dispatchedEvents = db => db.all("SELECT * FROM domain_events WHERE scope = ? AND kind = 'agenda/occurrence-dispatched'", KEY);

test('1. 取消后不再投递：日程取消 → casOccurrence 返回 cancelled', t => {
  const db = world(t);
  seedItem(db);
  seedOccurrence(db);
  assert.equal(casOccurrence(db, { scopeKey: KEY, occurrenceId: 'occ-1', revision: 1, enabled: true }).ok, true, 'active plan passes');

  db.run("UPDATE agenda_items SET status = 'cancelled' WHERE scope = ? AND item_id = 'item-1'", KEY);
  const refused = casOccurrence(db, { scopeKey: KEY, occurrenceId: 'occ-1', revision: 1, enabled: true });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'cancelled', 'a cancelled plan is a plan fact, not a race');

  // And `markOccurrenceDispatched` refuses too: nothing is recorded for a cancelled plan.
  const marked = markOccurrenceDispatched(db, { scopeKey: KEY, occurrenceId: 'occ-1', revision: 1, at: T0, receipt: 'r1', enabled: true, emit: emitFor(db) });
  assert.equal(marked.ok, false);
  assert.equal(dispatchedEvents(db).length, 0, 'no dispatched event for a cancelled plan');
  assert.equal(readDispatchReceipt(db, 'occ-1'), null, 'and no receipt');
});

test('2. 改期后旧 revision 失效：revision-changed 且 actualRevision 正确', t => {
  const db = world(t);
  seedItem(db);
  seedOccurrence(db);
  db.run("UPDATE agenda_occurrences SET revision = 4 WHERE scope = ? AND occurrence_id = 'occ-1'", KEY);
  const refused = casOccurrence(db, { scopeKey: KEY, occurrenceId: 'occ-1', revision: 1, enabled: true });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'revision-changed');
  assert.equal(refused.actualRevision, 4, 'the caller can re-read instead of guessing');
});

test('3. 时区变更：旧 revision 失效（时区改动会重算并抬 revision）', t => {
  const db = world(t);
  seedItem(db);
  seedOccurrence(db);
  assert.equal(casOccurrence(db, { scopeKey: KEY, occurrenceId: 'occ-1', revision: 1, enabled: true }).ok, true);
  // A timezone change re-plans the slot: same occurrence id, new instant, bumped revision.
  const newDueAt = T0 + 7200000;
  db.run("UPDATE agenda_occurrences SET revision = revision + 1, scheduled_at = ?, slot_end_at = ? WHERE scope = ? AND occurrence_id = 'occ-1'", newDueAt, newDueAt + 600000, KEY);
  const stale = casOccurrence(db, { scopeKey: KEY, occurrenceId: 'occ-1', revision: 1, enabled: true });
  assert.equal(stale.code, 'revision-changed');
  assert.equal(stale.actualRevision, 2);
  const fresh = casOccurrence(db, { scopeKey: KEY, occurrenceId: 'occ-1', revision: 2, enabled: true });
  assert.equal(fresh.ok, true);
  assert.equal(fresh.occurrence.dueAt, newDueAt, 'the verified instant is the new one');
});

test('4. DST gap / fold：dueAt 是既存事实，同一 revision 仍能通过', t => {
  const db = world(t);
  seedItem(db);
  // 2026-03-08 02:30 America/New_York does not exist (gap); 2026-11-01 01:30 happens twice (fold).
  const gapDueAt = Date.UTC(2026, 2, 8, 7, 30, 0);
  const foldDueAt = Date.UTC(2026, 10, 1, 5, 30, 0);
  seedOccurrence(db, { dueAt: gapDueAt, slotKey: 'gap' });
  const gap = casOccurrence(db, { scopeKey: KEY, occurrenceId: 'occ-1', revision: 1, enabled: true });
  assert.equal(gap.ok, true, 'a DST gap does not make the occurrence unverifiable');
  assert.equal(gap.occurrence.dueAt, gapDueAt, 'the stored UTC instant is what the caller sends against');

  db.run("UPDATE agenda_occurrences SET scheduled_at = ?, slot_end_at = ? WHERE scope = ? AND occurrence_id = 'occ-1'", foldDueAt, foldDueAt + 600000, KEY);
  const fold = casOccurrence(db, { scopeKey: KEY, occurrenceId: 'occ-1', revision: 1, enabled: true });
  assert.equal(fold.ok, true, 'a fold does not change the revision either');
  assert.equal(fold.occurrence.dueAt, foldDueAt);
});

test('5. 幂等：同一 (occurrenceId, revision) 第二次 already-dispatched，且只有一条事件', t => {
  const db = world(t);
  seedItem(db);
  seedOccurrence(db);
  const first = markOccurrenceDispatched(db, { scopeKey: KEY, occurrenceId: 'occ-1', revision: 1, at: T0, receipt: 'rcpt-1', enabled: true, emit: emitFor(db) });
  assert.equal(first.ok, true);
  assert.equal(first.revision, 2, 'the reducer bumped the occurrence revision');
  assert.equal(occurrenceRow(db).status, 'dispatched');
  assert.equal(occurrenceRow(db).reason_code, 'reminders', 'the consumer is recorded on the row');

  const second = markOccurrenceDispatched(db, { scopeKey: KEY, occurrenceId: 'occ-1', revision: 1, at: T0 + 1000, receipt: 'rcpt-1', enabled: true, emit: emitFor(db) });
  assert.equal(second.ok, false);
  assert.equal(second.code, 'already-dispatched');
  assert.equal(dispatchedEvents(db).length, 1, 'exactly one agenda/occurrence-dispatched event');

  const receipt = readDispatchReceipt(db, 'occ-1');
  assert.equal(receipt.requestedRevision, 1, 'the receipt is keyed by the caller revision');
  assert.equal(receipt.receipt, 'rcpt-1');
  assert.equal(JSON.parse(dispatchedEvents(db)[0].payload).consumer, 'reminders');
});

test('6. disabled：agenda.enabled=false 时两个方法都 disabled 且不写行', t => {
  const db = world(t);
  seedItem(db);
  seedOccurrence(db);
  const before = { row: occurrenceRow(db), events: dispatchedEvents(db).length, meta: db.all("SELECT meta_key FROM runtime_meta WHERE meta_key LIKE 'agenda_dispatch:%'").length };

  const cas = casOccurrence(db, { scopeKey: KEY, occurrenceId: 'occ-1', revision: 1, enabled: false });
  assert.equal(cas.ok, false);
  assert.equal(cas.code, 'disabled');
  const marked = markOccurrenceDispatched(db, { scopeKey: KEY, occurrenceId: 'occ-1', revision: 1, at: T0, receipt: 'r', enabled: false, emit: emitFor(db) });
  assert.equal(marked.ok, false);
  assert.equal(marked.code, 'disabled');

  assert.deepEqual(occurrenceRow(db), before.row, 'no row was touched');
  assert.equal(dispatchedEvents(db).length, before.events, 'no event was appended');
  assert.equal(db.all("SELECT meta_key FROM runtime_meta WHERE meta_key LIKE 'agenda_dispatch:%'").length, before.meta, 'no receipt was written');
});

test('7. not-found 与"事件失败时 receipt 不残留"（事务回滚）', t => {
  const db = world(t);
  seedItem(db);
  seedOccurrence(db);
  assert.equal(casOccurrence(db, { scopeKey: KEY, occurrenceId: 'occ-missing', revision: 1, enabled: true }).code, 'not-found');
  assert.equal(markOccurrenceDispatched(db, { scopeKey: KEY, occurrenceId: 'occ-missing', revision: 1, at: T0, receipt: 'r', enabled: true, emit: emitFor(db) }).code, 'not-found');

  // The writer refuses: the receipt must roll back with it, otherwise a later retry would be told
  // "already dispatched" for a dispatch that never happened.
  const exploding = () => { throw new Error('lease lost'); };
  const failed = markOccurrenceDispatched(db, { scopeKey: KEY, occurrenceId: 'occ-1', revision: 1, at: T0, receipt: 'r', enabled: true, emit: exploding });
  assert.equal(failed.ok, false);
  assert.equal(readDispatchReceipt(db, 'occ-1'), null, 'no receipt survived the failed dispatch');
  assert.equal(occurrenceRow(db).status, 'scheduled', 'and the occurrence is still scheduled');
  assert.equal(dispatchedEvents(db).length, 0);
});
