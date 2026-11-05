import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openRuntimeDb } from '../lib/db.mjs';
import { dispatchEvent, listEvents, normalizeEvent, receiptFor, receiptCount } from '../lib/events.mjs';
import { scopeKey } from '../lib/scope.mjs';
import {
  agendaCounts,
  applyAgendaEvent,
  getAgendaItem,
  listAgendaOccurrences,
  normalizeDefinition,
  occurrenceIdFor,
  planWindow,
} from '../lib/agenda.mjs';

// HH11 (agenda half): fault points and atomicity. A refused event leaves no log row, no
// receipt and no relational write; a consumer that fails after writing leaves the log
// row (so a retry can top the receipt up) but no projection and no row.

const T0 = Date.UTC(2026, 9, 30, 0, 0, 0); // 2026-10-30T00:00Z = 08:00 Asia/Shanghai
const SCOPE = Object.freeze({ userId: 'owner-1', personaId: 'bot', worldId: '' });
const KEY = scopeKey(SCOPE);
const HANDLERS = Object.freeze({ agenda: applyAgendaEvent });

function newDb(t) {
  const db = openRuntimeDb({ file: ':memory:', now: () => T0 });
  db.acquireLease({ owner: 'test', generation: 'gen-1', ttlMs: 600000 });
  t.after(() => db.close());
  return db;
}

function fire(db, kind, payload, { at = T0, handlers = HANDLERS } = {}) {
  return dispatchEvent(db, normalizeEvent({ kind, scope: SCOPE, occurredAt: at, payload }), { handlers, generation: 'gen-1' });
}

function createItem(db, input, { itemId = 'item-1', at = T0, handlers = HANDLERS } = {}) {
  const definition = normalizeDefinition(input, { now: at });
  return fire(db, 'agenda/created', { item: { ...definition, itemId, revision: 1, createdAt: at }, requestKey: definition.requestKey }, { at, handlers });
}

function generate(db, { itemId = 'item-1', slot, at = slot.scheduledAt, handlers = HANDLERS } = {}) {
  return fire(db, 'agenda/occurrence-generated', {
    itemId,
    slotKey: slot.slotKey,
    definitionRevision: slot.definitionRevision,
    scheduledAt: slot.scheduledAt,
    slotEndAt: slot.slotEndAt,
    resolution: slot.resolution,
    occurrenceId: occurrenceIdFor(KEY, itemId, slot.slotKey),
  }, { at, handlers });
}

function counts(db) {
  return {
    events: Number(db.get('SELECT COUNT(*) AS n FROM domain_events').n),
    receipts: Number(db.get('SELECT COUNT(*) AS n FROM consumer_receipts').n),
    items: Number(db.get('SELECT COUNT(*) AS n FROM agenda_items').n),
    occurrences: Number(db.get('SELECT COUNT(*) AS n FROM agenda_occurrences').n),
    version: db.projection(KEY).version,
  };
}

const DAILY = { title: '散步', rule: 'daily', timeZone: 'Asia/Shanghai', time: '07:00' };

// A consumer that writes its row and *then* fails non-deterministically (an internal
// error, not a contract refusal). events.mjs must roll the writes back while keeping the
// log row, so a retry can finish the job instead of losing the event.
function failingAfterWrite(ctx) {
  const outcome = applyAgendaEvent(ctx);
  if (outcome.extra) outcome.extra(ctx.db, ctx.event);
  throw new Error('consumer exploded after writing');
}

test('HH11: a reducer throw rolls the whole event back', t => {
  const db = newDb(t);
  createItem(db, DAILY);
  const [slot] = planWindow({ item: getAgendaItem(db, KEY, 'item-1'), from: T0, to: T0 + 86400000, limit: 2, now: T0 });
  generate(db, { slot });
  const before = counts(db);
  const occurrenceId = occurrenceIdFor(KEY, 'item-1', slot.slotKey);

  // A deterministic refusal in the middle of the transaction: nothing at all is left.
  const stale = fire(db, 'agenda/occurrence-due', { occurrenceId, expectedRevision: 9 }, { at: slot.scheduledAt + 1 });
  assert.equal(stale.rejected, true);
  assert.equal(stale.results[0].code, 'stale-revision');
  assert.equal(stale.results[0].deterministic, true);
  assert.deepEqual(counts(db), before);

  const reschedule = fire(db, 'agenda/occurrence-generated', {
    itemId: 'item-1',
    slotKey: slot.slotKey,
    definitionRevision: 1,
    scheduledAt: slot.scheduledAt + 60000,
  }, { at: slot.scheduledAt + 2 });
  assert.equal(reschedule.rejected, true);
  assert.equal(reschedule.results[0].code, 'reschedule-required');
  assert.deepEqual(counts(db), before);
  assert.equal(listAgendaOccurrences(db, { scopeKey: KEY }).length, 1);
  assert.equal(listAgendaOccurrences(db, { scopeKey: KEY })[0].scheduledAt, slot.scheduledAt);
});

test('HH11: a consumer that fails after writing advances nothing but keeps the log row', t => {
  const db = newDb(t);
  createItem(db, DAILY);
  const before = counts(db);
  const failing = { agenda: failingAfterWrite };
  const [slot] = planWindow({ item: getAgendaItem(db, KEY, 'item-1'), from: T0, to: T0 + 86400000, limit: 2, now: T0 });
  const attempt = generate(db, { slot, handlers: failing });
  assert.equal(attempt.inserted, true, 'the event was appended');
  assert.equal(attempt.rejected, false, 'a non-deterministic failure is not a veto');
  assert.equal(attempt.results[0].applied, false);
  assert.equal(attempt.results[0].code, 'internal');
  assert.equal(attempt.results[0].deterministic, false);

  const after = counts(db);
  assert.equal(after.events, before.events + 1, 'the log row survives for the retry');
  assert.equal(after.receipts, before.receipts, 'no receipt was written');
  assert.equal(after.occurrences, before.occurrences, 'the partial row write was rolled back');
  assert.equal(after.version, before.version, 'the projection did not move');
  assert.equal(receiptFor(db, 'agenda', attempt.event.eventId), null);

  // The retry uses the same deterministic event identity (A1-B2) and finishes the job.
  const retry = dispatchEvent(db, attempt.event, { handlers: HANDLERS, generation: 'gen-1' });
  assert.equal(retry.inserted, false, 'the retry hits the same eventId, it does not append twice');
  assert.equal(retry.results[0].applied, true);
  assert.equal(retry.results[0].duplicate, false, 'a missing receipt is topped up, not treated as a duplicate');
  const settled = counts(db);
  assert.equal(settled.events, after.events, 'exactly one event row for one occurrence');
  assert.equal(settled.receipts, before.receipts + 1);
  assert.equal(settled.occurrences, before.occurrences + 1);
  assert.equal(settled.version, before.version + 1);
  assert.equal(listAgendaOccurrences(db, { scopeKey: KEY }).length, 1);
});

test('HH11: a duplicate delivery is acknowledged without a second receipt', t => {
  const db = newDb(t);
  createItem(db, DAILY);
  const [slot] = planWindow({ item: getAgendaItem(db, KEY, 'item-1'), from: T0, to: T0 + 86400000, limit: 2, now: T0 });
  const event = normalizeEvent({
    kind: 'agenda/occurrence-generated',
    scope: SCOPE,
    occurredAt: slot.scheduledAt,
    payload: { itemId: 'item-1', slotKey: slot.slotKey, definitionRevision: 1, scheduledAt: slot.scheduledAt, slotEndAt: slot.slotEndAt },
  });
  const first = dispatchEvent(db, event, { handlers: HANDLERS, generation: 'gen-1' });
  assert.equal(first.inserted, true);
  const afterFirst = counts(db);
  const second = dispatchEvent(db, event, { handlers: HANDLERS, generation: 'gen-1' });
  assert.equal(second.inserted, false);
  assert.equal(second.results[0].duplicate, true);
  assert.deepEqual(counts(db), afterFirst, 'a re-delivery writes nothing at all');
  assert.equal(receiptCount(db, 'agenda'), 2, 'one receipt for the create, one for the generation');
  assert.equal(receiptCount(db, 'agenda'), listEvents(db, { scopeKey: KEY }).length);
});

test('HH11: an idempotent duplicate generation advances the projection once, not twice', t => {
  const db = newDb(t);
  createItem(db, DAILY);
  const [slot] = planWindow({ item: getAgendaItem(db, KEY, 'item-1'), from: T0, to: T0 + 86400000, limit: 2, now: T0 });
  const first = generate(db, { slot });
  assert.equal(first.results[0].applied, true);
  const afterFirst = counts(db);
  const again = generate(db, { slot, at: slot.scheduledAt + 1 });
  assert.equal(again.results[0].applied, true, 'A1-B3: same slot, same instant ⇒ idempotent success');
  assert.equal(again.results[0].result.duplicate, true);
  const afterSecond = counts(db);
  assert.equal(afterSecond.occurrences, afterFirst.occurrences, 'no second occurrence row');
  assert.equal(afterSecond.version, afterFirst.version + 1, 'the receipt and projection still commit once');
  assert.equal(listAgendaOccurrences(db, { scopeKey: KEY })[0].revision, 1, 'the occurrence revision did not move');
  assert.equal(agendaCounts(db, KEY).occurrences.scheduled, 1);
});

test('HH11: projection version stays consistent with the applied events', t => {
  const db = newDb(t);
  createItem(db, DAILY);
  const item = getAgendaItem(db, KEY, 'item-1');
  const slots = planWindow({ item, from: T0, to: T0 + 2 * 86400000, limit: 4, now: T0 });
  let applied = 1; // the create
  for (const slot of slots) {
    const outcome = generate(db, { slot });
    if (outcome.results[0].applied) applied += 1;
    assert.equal(db.projection(KEY).version, applied, 'each applied event commits exactly one projection version');
  }
  const before = db.projection(KEY).version;
  const refused = fire(db, 'agenda/updated', { itemId: 'item-1', expectedRevision: 99, patch: { title: 'x' } }, { at: T0 + 100 });
  assert.equal(refused.rejected, true);
  assert.equal(db.projection(KEY).version, before, 'a veto does not move the version');
  const missing = fire(db, 'agenda/cancelled', { itemId: 'nope', expectedRevision: 1 }, { at: T0 + 101 });
  assert.equal(missing.rejected, true);
  assert.equal(db.projection(KEY).version, before);
  assert.equal(db.projection(KEY).payload.agenda.revision, applied, 'the slice counts applied events');
  assert.equal(listEvents(db, { scopeKey: KEY }).length, applied, 'log length equals applied count');
});

test('HH11: an unknown or foreign kind is ignored by the reducer', () => {
  const db = openRuntimeDb({ file: ':memory:', now: () => T0 });
  db.acquireLease({ owner: 'test', generation: 'gen-1', ttlMs: 600000 });
  assert.deepEqual(applyAgendaEvent({ db, event: { kind: 'goal/proposed', scopeKey: KEY, payload: {} }, slice: {}, now: T0 }), {});
  assert.deepEqual(applyAgendaEvent({ db, event: { kind: 'agenda/unknown', scopeKey: KEY, payload: {} }, slice: {}, now: T0 }), {});
  assert.deepEqual(applyAgendaEvent({ db }), {});
  db.close();
});
