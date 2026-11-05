import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openRuntimeDb } from '../lib/db.mjs';
import { dispatchEvent, listEvents, normalizeEvent, receiptFor } from '../lib/events.mjs';
import { scopeKey } from '../lib/scope.mjs';
import { verifyRecovery } from '../lib/snapshot.mjs';
import {
  agendaCounts,
  applyAgendaEvent,
  getAgendaItem,
  listAgendaItems,
  listAgendaOccurrences,
  normalizeDefinition,
  occurrenceIdFor,
  planWindow,
} from '../lib/agenda.mjs';

// HH03: revision fences, cancellation and re-delivery. A refused event must leave no
// trace at all (no log row, no receipt, no row change) and a terminal row must never
// come back to life.

const T0 = Date.UTC(2026, 9, 30, 0, 0, 0); // 2026-10-30T00:00Z = 08:00 Asia/Shanghai
const SCOPE = Object.freeze({ userId: 'owner-1', personaId: 'march7', worldId: '' });
const KEY = scopeKey(SCOPE);
const HANDLERS = Object.freeze({ agenda: applyAgendaEvent });

function newDb(t) {
  const db = openRuntimeDb({ file: ':memory:', now: () => T0 });
  db.acquireLease({ owner: 'test', generation: 'gen-1', ttlMs: 600000 });
  t.after(() => db.close());
  return db;
}

function fire(db, kind, payload, { at = T0, scope = SCOPE } = {}) {
  return dispatchEvent(db, normalizeEvent({ kind, scope, occurredAt: at, payload }), { handlers: HANDLERS, generation: 'gen-1' });
}

function createItem(db, input, { itemId = 'item-1', at = T0 } = {}) {
  const definition = normalizeDefinition(input, { now: at });
  return fire(db, 'agenda/created', {
    item: { ...definition, itemId, revision: 1, createdAt: at },
    requestKey: definition.requestKey,
  }, { at });
}

function generate(db, { itemId = 'item-1', slot, at = slot.scheduledAt } = {}) {
  return fire(db, 'agenda/occurrence-generated', {
    itemId,
    slotKey: slot.slotKey,
    definitionRevision: slot.definitionRevision,
    scheduledAt: slot.scheduledAt,
    slotEndAt: slot.slotEndAt,
    resolution: slot.resolution,
    occurrenceId: occurrenceIdFor(KEY, itemId, slot.slotKey),
  }, { at });
}

function plan(db, { itemId = 'item-1', from = T0, to = T0 + 3 * 86400000, limit = 8, now = T0 } = {}) {
  return planWindow({ item: getAgendaItem(db, KEY, itemId), from, to, limit, now });
}

function rowCount(db, table) {
  return Number(db.get(`SELECT COUNT(*) AS n FROM ${table}`).n);
}

function codeOf(result) {
  return result.results?.[0]?.code ?? '';
}

test('HH03: a stale revision is rejected with no trace at all', t => {
  const db = newDb(t);
  createItem(db, { title: '散步', rule: 'daily', timeZone: 'Asia/Shanghai', time: '07:00' });
  const before = getAgendaItem(db, KEY, 'item-1');
  const eventsBefore = rowCount(db, 'domain_events');
  const receiptsBefore = rowCount(db, 'consumer_receipts');
  const versionBefore = db.projection(KEY).version;

  const stale = fire(db, 'agenda/updated', {
    itemId: 'item-1',
    expectedRevision: 5,
    nextRevision: 6,
    patch: { title: '被覆盖的标题' },
    updatedAt: T0 + 10,
  }, { at: T0 + 10 });
  assert.equal(stale.rejected, true);
  assert.equal(codeOf(stale), 'stale-revision');
  assert.equal(stale.inserted, false);
  assert.equal(db.get('SELECT * FROM domain_events WHERE event_id = ?', stale.event.eventId), undefined, 'no event row');
  assert.equal(receiptFor(db, 'agenda', stale.event.eventId), null, 'no receipt');
  assert.equal(rowCount(db, 'domain_events'), eventsBefore);
  assert.equal(rowCount(db, 'consumer_receipts'), receiptsBefore);
  assert.equal(db.projection(KEY).version, versionBefore, 'the projection did not move');
  assert.deepEqual(getAgendaItem(db, KEY, 'item-1'), before, 'the row is byte-identical');

  // The fence is checked before any "nothing changes" short circuit.
  const emptyPatch = fire(db, 'agenda/updated', { itemId: 'item-1', expectedRevision: 99, patch: {}, nextRevision: 100 }, { at: T0 + 11 });
  assert.equal(codeOf(emptyPatch), 'stale-revision');

  // A stale cancel and a stale occurrence transition are refused the same way.
  const staleCancel = fire(db, 'agenda/cancelled', { itemId: 'item-1', expectedRevision: 4, reason: 'stale' }, { at: T0 + 12 });
  assert.equal(codeOf(staleCancel), 'stale-revision');
  assert.equal(getAgendaItem(db, KEY, 'item-1').status, 'active');
});

test('HH03: cancel cancels future and due occurrences in the same transaction, keeping history', t => {
  const db = newDb(t);
  createItem(db, { title: '散步', rule: 'daily', timeZone: 'Asia/Shanghai', time: '07:00' });
  const slots = plan(db, { to: T0 + 4 * 86400000 });
  assert.equal(slots.length, 4);
  for (const slot of slots) assert.equal(generate(db, { slot }).inserted, true);

  // The first slot has already fallen due (A1-B1: a due occurrence is a live backlog
  // item, not history), the second is scheduled but already in the past, the last two are
  // future.
  const dueAt = slots[0].scheduledAt;
  const due = fire(db, 'agenda/occurrence-due', {
    occurrenceId: occurrenceIdFor(KEY, 'item-1', slots[0].slotKey),
    expectedRevision: 1,
    scheduledAt: slots[0].scheduledAt,
  }, { at: dueAt });
  assert.equal(due.inserted, true, JSON.stringify(due.results));

  const cancelAt = slots[1].scheduledAt + 60000;
  const cancelled = fire(db, 'agenda/cancelled', {
    itemId: 'item-1',
    expectedRevision: 1,
    reason: 'user-cancelled',
    now: cancelAt,
  }, { at: cancelAt });
  assert.equal(cancelled.inserted, true, JSON.stringify(cancelled.results));
  assert.equal(cancelled.results[0].result.cancelledOccurrences, 3, 'the due ghost plus the two future slots');
  assert.equal(cancelled.results[0].result.status, 'cancelled');
  assert.equal(cancelled.results[0].result.revision, 2);

  const item = getAgendaItem(db, KEY, 'item-1');
  assert.equal(item.status, 'cancelled');
  assert.equal(item.revision, 2);
  const occurrences = listAgendaOccurrences(db, { scopeKey: KEY });
  assert.equal(occurrences.length, 4, 'history is never deleted');
  const bySlot = new Map(occurrences.map(row => [row.slotKey, row]));
  assert.equal(bySlot.get(slots[0].slotKey).status, 'cancelled', 'a due occurrence is cancelled too');
  assert.equal(bySlot.get(slots[0].slotKey).reasonCode, 'definition-cancelled');
  assert.equal(bySlot.get(slots[0].slotKey).revision, 3, 'due (rev 2) → cancelled (rev 3)');
  assert.equal(bySlot.get(slots[1].slotKey).status, 'scheduled', 'an instant already reached is not rewritten');
  assert.equal(bySlot.get(slots[2].slotKey).status, 'cancelled');
  assert.equal(bySlot.get(slots[2].slotKey).reasonCode, 'definition-cancelled');
  assert.equal(bySlot.get(slots[3].slotKey).status, 'cancelled');
  assert.equal(agendaCounts(db, KEY).occurrences.due, 0, 'no due ghost is left behind');
  assert.equal(listAgendaItems(db, { scopeKey: KEY, status: 'active' }).length, 0);
  assert.equal(agendaCounts(db, KEY).items, 0);
});

test('HH03: terminal states never revive', t => {
  const db = newDb(t);
  createItem(db, { title: '散步', rule: 'daily', timeZone: 'Asia/Shanghai', time: '07:00' });
  const slots = plan(db);
  // A slot five days out that was never materialised: after the cancel it must still be
  // refused, so a cancelled definition cannot be resurrected by a late generation event.
  const futureSlot = plan(db, { from: T0 + 5 * 86400000, to: T0 + 6 * 86400000, limit: 1, now: T0 })[0];
  assert.ok(futureSlot, 'a future slot is plannable while the definition is active');
  generate(db, { slot: slots[0], at: T0 + 100 });
  generate(db, { slot: slots[1], at: T0 + 101 });
  const occurrenceId = occurrenceIdFor(KEY, 'item-1', slots[1].slotKey);
  const skipped = fire(db, 'agenda/occurrence-skipped', { occurrenceId, expectedRevision: 1, reasonCode: 'user-skipped' }, { at: T0 + 200 });
  assert.equal(skipped.inserted, true);
  // A terminal slot of a still-active definition is refused as a terminal slot.
  const regenerate = generate(db, { slot: slots[1], at: T0 + 250 });
  assert.equal(regenerate.rejected, true);
  assert.equal(codeOf(regenerate), 'slot-terminal', 'a terminal slot is not regenerated');

  const cancelled = fire(db, 'agenda/cancelled', { itemId: 'item-1', expectedRevision: 1, reason: 'done', now: T0 }, { at: T0 + 300 });
  assert.equal(cancelled.inserted, true, JSON.stringify(cancelled.results));

  // Terminal occurrence: every transition out is refused.
  for (const [kind, payload] of [
    ['agenda/occurrence-due', { occurrenceId, expectedRevision: 2 }],
    ['agenda/occurrence-skipped', { occurrenceId, expectedRevision: 2, reasonCode: 'again' }],
    ['agenda/occurrence-expired', { occurrenceId, expectedRevision: 2, reasonCode: 'again' }],
    ['agenda/occurrence-dispatched', { occurrenceId, expectedRevision: 2, consumer: 'activity' }],
    ['agenda/occurrence-cancelled', { occurrenceId, expectedRevision: 2, reason: 'again' }],
    ['agenda/occurrence-rescheduled', { occurrenceId, expectedRevision: 2, scheduledAt: T0 }],
  ]) {
    const attempt = fire(db, kind, payload, { at: T0 + 400 });
    assert.equal(attempt.rejected, true, `${kind} must be refused`);
    assert.equal(codeOf(attempt), 'invalid-transition', `${kind} → invalid-transition`);
  }
  const regenerateAfterCancel = generate(db, { slot: slots[1], at: T0 + 500 });
  assert.equal(regenerateAfterCancel.rejected, true);
  assert.equal(codeOf(regenerateAfterCancel), 'terminal-item', 'a cancelled definition generates nothing');

  // Terminal item: no update, no new slot, no second cancel that could bump the revision.
  const update = fire(db, 'agenda/updated', { itemId: 'item-1', expectedRevision: 2, nextRevision: 3, patch: { title: 'x' } }, { at: T0 + 600 });
  assert.equal(update.rejected, true);
  assert.equal(codeOf(update), 'terminal-item');
  const newSlot = futureSlot;
  const afterCancel = generate(db, { slot: newSlot, at: T0 + 700 });
  assert.equal(afterCancel.rejected, true);
  assert.equal(codeOf(afterCancel), 'terminal-item', 'a cancelled definition cannot generate new slots');
  const again = fire(db, 'agenda/cancelled', { itemId: 'item-1', expectedRevision: 2, reason: 'again', now: T0 }, { at: T0 + 800 });
  assert.equal(again.inserted, true, 'a repeated cancel is a harmless no-op');
  assert.equal(again.results[0].result.action, 'kept');
  assert.equal(getAgendaItem(db, KEY, 'item-1').revision, 2, 'the revision did not move');
  assert.equal(listAgendaOccurrences(db, { scopeKey: KEY }).length, 2);
});

test('HH03: an occurrence reschedule needs the scheduled state and the right revision', t => {
  const db = newDb(t);
  createItem(db, { title: '散步', rule: 'daily', timeZone: 'Asia/Shanghai', time: '07:00' });
  const [slot] = plan(db);
  generate(db, { slot, at: T0 + 100 });
  const occurrenceId = occurrenceIdFor(KEY, 'item-1', slot.slotKey);
  const moved = fire(db, 'agenda/occurrence-rescheduled', {
    occurrenceId,
    expectedRevision: 1,
    scheduledAt: slot.scheduledAt + 1800000,
    slotEndAt: slot.slotEndAt + 1800000,
    definitionRevision: 2,
    reason: 'definition-updated',
  }, { at: T0 + 200 });
  assert.equal(moved.inserted, true, JSON.stringify(moved.results));
  assert.equal(moved.results[0].result.revision, 2);
  const [row] = listAgendaOccurrences(db, { scopeKey: KEY });
  assert.equal(row.scheduledAt, slot.scheduledAt + 1800000);
  assert.equal(row.reasonCode, 'definition-updated');
  assert.equal(row.definitionRevision, 2);

  const staleReschedule = fire(db, 'agenda/occurrence-rescheduled', { occurrenceId, expectedRevision: 1, scheduledAt: T0 }, { at: T0 + 300 });
  assert.equal(staleReschedule.rejected, true);
  assert.equal(codeOf(staleReschedule), 'stale-revision');

  const due = fire(db, 'agenda/occurrence-due', { occurrenceId, expectedRevision: 2, scheduledAt: row.scheduledAt }, { at: T0 + 400 });
  assert.equal(due.inserted, true);
  const afterDue = fire(db, 'agenda/occurrence-rescheduled', { occurrenceId, expectedRevision: 3, scheduledAt: T0 }, { at: T0 + 500 });
  assert.equal(afterDue.rejected, true);
  assert.equal(codeOf(afterDue), 'invalid-transition', 'a due occurrence is no longer reschedulable');

  const missing = fire(db, 'agenda/occurrence-due', { occurrenceId: 'occ_missing', expectedRevision: 1 }, { at: T0 + 600 });
  assert.equal(missing.rejected, true);
  assert.equal(codeOf(missing), 'occurrence-not-found');
  const missingItem = fire(db, 'agenda/cancelled', { itemId: 'item-missing', expectedRevision: 1 }, { at: T0 + 700 });
  assert.equal(missingItem.rejected, true);
  assert.equal(codeOf(missingItem), 'item-not-found');
});

test('HH03: events, snapshot and table agree after a full lifecycle', t => {
  const db = newDb(t);
  createItem(db, { title: '散步', rule: 'daily', timeZone: 'Asia/Shanghai', time: '07:00' });
  const slots = plan(db);
  generate(db, { slot: slots[0], at: T0 + 100 });
  generate(db, { slot: slots[1], at: T0 + 101 });
  fire(db, 'agenda/occurrence-due', { occurrenceId: occurrenceIdFor(KEY, 'item-1', slots[0].slotKey), expectedRevision: 1 }, { at: T0 + 200 });
  fire(db, 'agenda/occurrence-skipped', { occurrenceId: occurrenceIdFor(KEY, 'item-1', slots[1].slotKey), expectedRevision: 1, reasonCode: 'user-skipped' }, { at: T0 + 201 });
  fire(db, 'agenda/updated', { itemId: 'item-1', expectedRevision: 1, nextRevision: 2, patch: { time: '08:00' } }, { at: T0 + 300 });

  const projection = db.projection(KEY);
  const slice = projection.payload.agenda;
  const counts = agendaCounts(db, KEY);
  assert.equal(slice.items, counts.items);
  assert.deepEqual(slice.occurrences, counts.occurrences);
  assert.equal(slice.nextOccurrenceAt, counts.nextOccurrenceAt);
  assert.equal(slice.revision, 6, 'one slice revision per applied event');
  assert.equal(projection.version, 6);

  const applied = listEvents(db, { scopeKey: KEY }).filter(event => event.kind.startsWith('agenda/'));
  assert.equal(applied.length, 6);
  for (const event of applied) {
    const receipt = receiptFor(db, 'agenda', event.eventId);
    assert.ok(receipt, `missing receipt for ${event.eventId}`);
    assert.equal(receipt.consumer, 'agenda');
  }
  assert.equal(rowCount(db, 'consumer_receipts'), 6);
  // The reducer never puts a title or other private text into the receipt.
  for (const event of applied) {
    const receipt = receiptFor(db, 'agenda', event.eventId);
    assert.equal(JSON.stringify(receipt.result).includes('散步'), false);
    assert.equal(JSON.stringify(receipt.result).includes('被覆盖'), false);
  }
});

test('HH03: verifyRecovery reproduces the same rows after a cancel', t => {
  const db = newDb(t);
  createItem(db, { title: '散步', rule: 'daily', timeZone: 'Asia/Shanghai', time: '07:00' });
  const slots = plan(db);
  generate(db, { slot: slots[0], at: T0 + 100 });
  generate(db, { slot: slots[2], at: T0 + 101 });
  fire(db, 'agenda/cancelled', { itemId: 'item-1', expectedRevision: 1, reason: 'user', now: T0 }, { at: T0 + 200 });
  const report = verifyRecovery(db, { scopeKey: KEY, handlers: HANDLERS, now: () => T0 });
  assert.equal(report.ok, true, JSON.stringify(report.mismatches));
  assert.ok(report.replayed >= 4);
  assert.equal(report.projectionVersion, db.projection(KEY).version);
});

test('HH03: a patch only touches definition fields and never the authority by itself', t => {
  const db = newDb(t);
  createItem(db, { title: '散步', rule: 'daily', timeZone: 'Asia/Shanghai', time: '07:00' }, { itemId: 'item-1' });
  // `source` is provenance, so the runtime's update path may patch it (additive to the
  // frozen §12.4 list); authorization only moves when it is named explicitly.
  const patched = fire(db, 'agenda/updated', {
    itemId: 'item-1',
    expectedRevision: 1,
    nextRevision: 2,
    patch: { source: 'user-edited' },
  }, { at: T0 + 10 });
  assert.equal(patched.inserted, true, JSON.stringify(patched.results));
  const item = getAgendaItem(db, KEY, 'item-1');
  assert.equal(item.source, 'user-edited');
  assert.equal(item.authorization, 'plan', 'provenance is not authorization');
  assert.equal(item.revision, 2);

  const forbidden = fire(db, 'agenda/updated', {
    itemId: 'item-1',
    expectedRevision: 2,
    nextRevision: 3,
    patch: { status: 'cancelled' },
  }, { at: T0 + 20 });
  assert.equal(forbidden.rejected, true, 'status is not patchable; cancelSchedule owns that');
  assert.equal(codeOf(forbidden), 'invalid-payload');
  assert.equal(getAgendaItem(db, KEY, 'item-1').status, 'active');
  // `atUtc`/`resolution` may be named but are always recomputed, never trusted.
  const derived = fire(db, 'agenda/updated', {
    itemId: 'item-1',
    expectedRevision: 2,
    nextRevision: 3,
    patch: { atUtc: 1, resolution: { resolution: 'fold' } },
  }, { at: T0 + 30 });
  assert.equal(derived.inserted, true, JSON.stringify(derived.results));
  const after = getAgendaItem(db, KEY, 'item-1');
  assert.equal(after.atUtc, null, 'a repeating rule has no locked instant');
  assert.equal(after.resolution.resolution, 'exact');
});

test('HH03: a re-delivered event is acknowledged without a second write', t => {
  const db = newDb(t);
  createItem(db, { title: '散步', rule: 'daily', timeZone: 'Asia/Shanghai', time: '07:00' });
  const [slot] = plan(db);
  const event = normalizeEvent({
    kind: 'agenda/occurrence-generated',
    scope: SCOPE,
    occurredAt: T0 + 100,
    payload: { itemId: 'item-1', slotKey: slot.slotKey, definitionRevision: 1, scheduledAt: slot.scheduledAt, slotEndAt: slot.slotEndAt },
  });
  const first = dispatchEvent(db, event, { handlers: HANDLERS, generation: 'gen-1' });
  assert.equal(first.inserted, true);
  const second = dispatchEvent(db, event, { handlers: HANDLERS, generation: 'gen-1' });
  assert.equal(second.inserted, false, 'the append is idempotent');
  assert.equal(second.results[0].duplicate, true);
  assert.equal(rowCount(db, 'agenda_occurrences'), 1);
  assert.equal(rowCount(db, 'consumer_receipts'), 2, 'one receipt for the create, one for the generation');
  assert.equal(db.projection(KEY).version, 2, 'the projection was not advanced twice');
});

test('HH03: invalid payloads and missing revisions are deterministic vetoes, not partial writes', t => {
  const db = newDb(t);
  createItem(db, { title: '散步', rule: 'daily', timeZone: 'Asia/Shanghai', time: '07:00' });
  const cases = [
    ['agenda/created', { item: { title: 'x', rule: 'daily', timeZone: 'Asia/Shanghai', time: '07:00' } }, 'invalid-payload'],
    ['agenda/occurrence-generated', { itemId: 'item-1', slotKey: 'd:2026-10-31' }, 'invalid-payload'],
    ['agenda/occurrence-due', { expectedRevision: 1 }, 'invalid-payload'],
    ['agenda/occurrence-rescheduled', { expectedRevision: 1 }, 'invalid-payload'],
    // A1-B5: a fenced event without a revision is `revision-required`, not a stale write.
    ['agenda/updated', { itemId: 'item-1', patch: { title: 'x' } }, 'revision-required'],
    ['agenda/updated', { itemId: 'item-1', expectedRevision: 'later', patch: { title: 'x' } }, 'revision-required'],
    ['agenda/cancelled', { itemId: 'item-1' }, 'revision-required'],
  ];
  for (const [kind, payload, expected] of cases) {
    const attempt = fire(db, kind, payload, { at: T0 + 500 });
    assert.equal(attempt.rejected, true, `${kind} must be refused`);
    assert.equal(codeOf(attempt), expected, `${kind} → ${expected}`);
  }
  assert.equal(rowCount(db, 'agenda_items'), 1);
  assert.equal(rowCount(db, 'agenda_occurrences'), 0);
  assert.equal(rowCount(db, 'domain_events'), 1, 'only the create survived');
});
