import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openRuntimeDb } from '../lib/db.mjs';
import { dispatchEvent, listEvents, normalizeEvent } from '../lib/events.mjs';
import { scopeKey } from '../lib/scope.mjs';
import { verifyRecovery } from '../lib/snapshot.mjs';
import {
  applyAgendaEvent,
  getAgendaItem,
  listAgendaOccurrences,
  normalizeDefinition,
  occurrenceIdFor,
  planWindow,
} from '../lib/agenda.mjs';

// HH15: replay and projection comparison for the new tables. Recovery replays the log
// into a throwaway database with the same handlers, so agenda rows are reproduced from
// events alone — never from a model, the network, the wall clock or memory writes.

const T0 = Date.UTC(2026, 9, 30, 0, 0, 0); // 2026-10-30T00:00Z = 08:00 Asia/Shanghai
const SCOPE_A = Object.freeze({ userId: 'owner-1', personaId: 'bot', worldId: '' });
const SCOPE_B = Object.freeze({ userId: 'owner-2', personaId: 'bot', worldId: 'world:game' });
const KEY_A = scopeKey(SCOPE_A);
const KEY_B = scopeKey(SCOPE_B);
const HANDLERS = Object.freeze({ agenda: applyAgendaEvent });
const SOURCE = fs.readFileSync(new URL('../lib/agenda.mjs', import.meta.url), 'utf8');

function newDb(t) {
  const db = openRuntimeDb({ file: ':memory:', now: () => T0 });
  db.acquireLease({ owner: 'test', generation: 'gen-1', ttlMs: 600000 });
  t.after(() => db.close());
  return db;
}

function fire(db, kind, payload, { at = T0, scope = SCOPE_A } = {}) {
  return dispatchEvent(db, normalizeEvent({ kind, scope, occurredAt: at, payload }), { handlers: HANDLERS, generation: 'gen-1' });
}

function createItem(db, input, { itemId, at = T0, scope = SCOPE_A } = {}) {
  const definition = normalizeDefinition(input, { now: at });
  return fire(db, 'agenda/created', { item: { ...definition, itemId, revision: 1, createdAt: at }, requestKey: definition.requestKey }, { at, scope });
}

function generate(db, { itemId, slot, at = slot.scheduledAt, scope = SCOPE_A }) {
  return fire(db, 'agenda/occurrence-generated', {
    itemId,
    slotKey: slot.slotKey,
    definitionRevision: slot.definitionRevision,
    scheduledAt: slot.scheduledAt,
    slotEndAt: slot.slotEndAt,
    resolution: slot.resolution,
    occurrenceId: occurrenceIdFor(scopeKey(scope), itemId, slot.slotKey),
  }, { at, scope });
}

function plan(db, { scope = SCOPE_A, itemId, from = T0, to = T0 + 3 * 86400000, limit = 8, now = T0 } = {}) {
  return planWindow({ item: getAgendaItem(db, scopeKey(scope), itemId), from, to, limit, now });
}

function snapshotCounts(db) {
  return {
    events: Number(db.get('SELECT COUNT(*) AS n FROM domain_events').n),
    receipts: Number(db.get('SELECT COUNT(*) AS n FROM consumer_receipts').n),
    items: Number(db.get('SELECT COUNT(*) AS n FROM agenda_items').n),
    occurrences: Number(db.get('SELECT COUNT(*) AS n FROM agenda_occurrences').n),
    outbox: Number(db.get('SELECT COUNT(*) AS n FROM memory_outbox').n),
    projections: Number(db.get('SELECT COUNT(*) AS n FROM scope_snapshots').n),
  };
}

// One scope with the full lifecycle: create, generate, due, skip, update, cancel.
function seedLifecycle(db, { scope = SCOPE_A, itemId = 'item-1' } = {}) {
  createItem(db, { title: '散步', rule: 'daily', timeZone: 'Asia/Shanghai', time: '07:00' }, { itemId, scope });
  const slots = plan(db, { scope, itemId });
  assert.equal(slots.length, 3);
  generate(db, { itemId, slot: slots[0], scope });
  generate(db, { itemId, slot: slots[1], scope });
  const due = fire(db, 'agenda/occurrence-due', {
    occurrenceId: occurrenceIdFor(scopeKey(scope), itemId, slots[0].slotKey),
    expectedRevision: 1,
    scheduledAt: slots[0].scheduledAt,
  }, { at: slots[0].scheduledAt, scope });
  assert.equal(due.inserted, true, JSON.stringify(due.results));
  const skipped = fire(db, 'agenda/occurrence-skipped', {
    occurrenceId: occurrenceIdFor(scopeKey(scope), itemId, slots[1].slotKey),
    expectedRevision: 1,
    reasonCode: 'user-skipped',
  }, { at: slots[1].scheduledAt, scope });
  assert.equal(skipped.inserted, true, JSON.stringify(skipped.results));
  const updated = fire(db, 'agenda/updated', {
    itemId,
    expectedRevision: 1,
    nextRevision: 2,
    patch: { title: '散步（改）', time: '07:30' },
    updatedAt: T0 + 200000,
  }, { at: T0 + 200000, scope });
  assert.equal(updated.inserted, true, JSON.stringify(updated.results));
  const cancelled = fire(db, 'agenda/cancelled', { itemId, expectedRevision: 2, reason: 'user', now: T0 + 300000 }, { at: T0 + 300000, scope });
  assert.equal(cancelled.inserted, true, JSON.stringify(cancelled.results));
  return slots;
}

test('HH15: replaying the agenda log reproduces items and occurrences', t => {
  const db = newDb(t);
  seedLifecycle(db);
  const report = verifyRecovery(db, { scopeKey: KEY_A, handlers: HANDLERS, now: () => T0 });
  assert.equal(report.ok, true, JSON.stringify(report.mismatches));
  assert.deepEqual(report.mismatches, []);
  assert.equal(report.replayed, 7, 'every event of this scope was replayed');
  assert.equal(report.projectionVersion, db.projection(KEY_A).version);
  assert.ok(report.replayed > 0);
});

test('HH15: replay is deterministic and writes nothing to the live database', t => {
  const db = newDb(t);
  seedLifecycle(db);
  const before = snapshotCounts(db);
  const projectionBefore = JSON.stringify(db.projection(KEY_A).payload);
  const one = verifyRecovery(db, { scopeKey: KEY_A, handlers: HANDLERS, now: () => T0 });
  const two = verifyRecovery(db, { scopeKey: KEY_A, handlers: HANDLERS, now: () => T0 });
  assert.deepEqual(one, two, 'replay is byte-identical when repeated');
  assert.deepEqual(snapshotCounts(db), before, 'no live row, receipt or outbox entry was touched');
  assert.equal(JSON.stringify(db.projection(KEY_A).payload), projectionBefore);
  assert.equal(before.outbox, 0, 'replay queued no memory write');
});

test('HH15: a row written outside the event path is detected as a table mismatch', t => {
  const db = newDb(t);
  seedLifecycle(db);
  const baseline = verifyRecovery(db, { scopeKey: KEY_A, handlers: HANDLERS, now: () => T0 });
  assert.equal(baseline.ok, true, JSON.stringify(baseline.mismatches));

  // A definition that no event ever recorded (the classic "live has a row, replay does not").
  db.run(`INSERT INTO agenda_items (item_id, scope, revision, title, category, source, rule_kind, time_zone,
            local_date, local_time, weekdays, at_utc, valid_from, valid_until, status, authorization, delivery,
            goal_ref, commitment_ref, request_key, resolution, created_at, updated_at)
          VALUES ('item-ghost', ?, 1, '手工写入', 'plan', 'tool', 'daily', 'Asia/Shanghai',
            '', '06:00', '[]', NULL, ?, NULL, 'active', 'plan', 'none', '', '', 'req-ghost', '{}', ?, ?)`,
  KEY_A, T0, T0, T0);
  const itemMismatch = verifyRecovery(db, { scopeKey: KEY_A, handlers: HANDLERS, now: () => T0 });
  assert.equal(itemMismatch.ok, false);
  const itemFinding = itemMismatch.mismatches.find(mismatch => mismatch.kind === 'table-mismatch');
  assert.ok(itemFinding, JSON.stringify(itemMismatch.mismatches));
  assert.equal(itemFinding.table, 'agenda_items');
  assert.equal(itemFinding.live.length, itemFinding.replayed.length + 1);
  db.run("DELETE FROM agenda_items WHERE item_id = 'item-ghost'");

  // A hand-edited occurrence status is caught by the same comparison.
  const occurrence = listAgendaOccurrences(db, { scopeKey: KEY_A })[0];
  db.run("UPDATE agenda_occurrences SET status = 'dispatched' WHERE occurrence_id = ?", occurrence.occurrenceId);
  const occurrenceMismatch = verifyRecovery(db, { scopeKey: KEY_A, handlers: HANDLERS, now: () => T0 });
  assert.equal(occurrenceMismatch.ok, false);
  const occurrenceFinding = occurrenceMismatch.mismatches.find(mismatch => mismatch.kind === 'table-mismatch' && mismatch.table === 'agenda_occurrences');
  assert.ok(occurrenceFinding, JSON.stringify(occurrenceMismatch.mismatches));
  db.run('UPDATE agenda_occurrences SET status = ? WHERE occurrence_id = ?', occurrence.status, occurrence.occurrenceId);
  assert.equal(verifyRecovery(db, { scopeKey: KEY_A, handlers: HANDLERS, now: () => T0 }).ok, true);
});

test('HH15: replay involves no model, network or memory call', t => {
  const db = newDb(t);
  seedLifecycle(db);
  const report = verifyRecovery(db, { scopeKey: KEY_A, handlers: HANDLERS, now: () => T0 });
  assert.equal(report.ok, true);
  assert.equal(snapshotCounts(db).outbox, 0);
  // The reducer and the planner are pure: no transport, no model, no memory client.
  for (const needle of ['node:http', 'node:https', 'node:net', 'node:tls', 'fetch(', 'modelVersion', 'companionMemory']) {
    assert.equal(SOURCE.includes(needle), false, `agenda.mjs must not reference ${needle}`);
  }
  // Replay only needs the agenda handler: the event path is the single authority.
  const withOnlyAgenda = verifyRecovery(db, { scopeKey: KEY_A, handlers: { agenda: applyAgendaEvent }, now: () => T0 });
  assert.equal(withOnlyAgenda.ok, true);
  assert.equal(listEvents(db, { scopeKey: KEY_A }).length, report.replayed);
});

test('HH15: replay is stable after the wall clock moved on', t => {
  let clock = T0;
  const db = openRuntimeDb({ file: ':memory:', now: () => clock });
  db.acquireLease({ owner: 'test', generation: 'gen-1', ttlMs: 600000 });
  seedLifecycle(db);
  const live = JSON.stringify(db.projection(KEY_A).payload);
  clock = T0 + 7 * 86400000;
  const report = verifyRecovery(db, { scopeKey: KEY_A, handlers: HANDLERS, now: () => clock });
  assert.equal(report.ok, true, JSON.stringify(report.mismatches));
  assert.equal(JSON.stringify(db.projection(KEY_A).payload), live, 'the live projection was not rewritten');
  db.close();
});

test('HH15: each scope replays on its own', t => {
  const db = newDb(t);
  seedLifecycle(db, { scope: SCOPE_A, itemId: 'item-a' });
  seedLifecycle(db, { scope: SCOPE_B, itemId: 'item-b' });
  const a = verifyRecovery(db, { scopeKey: KEY_A, handlers: HANDLERS, now: () => T0 });
  const b = verifyRecovery(db, { scopeKey: KEY_B, handlers: HANDLERS, now: () => T0 });
  assert.equal(a.ok, true, JSON.stringify(a.mismatches));
  assert.equal(b.ok, true, JSON.stringify(b.mismatches));
  assert.equal(a.replayed, 7);
  assert.equal(b.replayed, 7);
  const unknown = verifyRecovery(db, { scopeKey: scopeKey({ userId: 'nobody' }), handlers: HANDLERS, now: () => T0 });
  assert.equal(unknown.ok, true);
  assert.equal(unknown.replayed, 0);
  // Cross-scope replay must not resurrect the other scope's rows.
  assert.equal(listAgendaOccurrences(db, { scopeKey: KEY_A }).every(row => row.itemId === 'item-a'), true);
  assert.equal(listAgendaOccurrences(db, { scopeKey: KEY_B }).every(row => row.itemId === 'item-b'), true);
});
