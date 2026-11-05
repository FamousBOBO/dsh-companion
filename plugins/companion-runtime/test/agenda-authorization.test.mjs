import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openRuntimeDb } from '../lib/db.mjs';
import { dispatchEvent, normalizeEvent } from '../lib/events.mjs';
import { scopeKey } from '../lib/scope.mjs';
import {
  AGENDA_AUTHORIZATION,
  AGENDA_DELIVERY,
  OCCURRENCE_STATUS,
  TERMINAL_OCCURRENCE_STATUS,
  applyAgendaEvent,
  dueAgendaOccurrences,
  getAgendaItem,
  listAgendaOccurrences,
  normalizeDefinition,
  occurrenceIdFor,
  planWindow,
  reminderDeliveryFor,
} from '../lib/agenda.mjs';

// HH05: authorization is separated from delivery, and H1 has no outbound path at all.
// A `reminder` definition stores the intent and reports `reminderDelivery:'not-wired'`;
// nothing in this module may queue a memory write, contact a channel or claim a send.

const T0 = Date.UTC(2026, 9, 30, 0, 0, 0); // 2026-10-30T00:00Z = 08:00 Asia/Shanghai
const SCOPE = Object.freeze({ userId: 'owner-1', personaId: 'march7', worldId: '' });
const KEY = scopeKey(SCOPE);
const HANDLERS = Object.freeze({ agenda: applyAgendaEvent });
const SOURCE = fs.readFileSync(new URL('../lib/agenda.mjs', import.meta.url), 'utf8');
// Comments legitimately *talk* about the outbox and the contact ledger (to explain what
// this module must never do), so the static check looks at code only.
const CODE = SOURCE
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\s\/\/.*$/gm, '')
  .replace(/^\s*\/\/.*$/gm, '');

function newDb(t) {
  const db = openRuntimeDb({ file: ':memory:', now: () => T0 });
  db.acquireLease({ owner: 'test', generation: 'gen-1', ttlMs: 600000 });
  t.after(() => db.close());
  return db;
}

function fire(db, kind, payload, { at = T0 } = {}) {
  return dispatchEvent(db, normalizeEvent({ kind, scope: SCOPE, occurredAt: at, payload }), { handlers: HANDLERS, generation: 'gen-1' });
}

function createItem(db, input, { itemId = 'item-1', at = T0 } = {}) {
  const definition = normalizeDefinition(input, { now: at });
  return fire(db, 'agenda/created', { item: { ...definition, itemId, revision: 1, createdAt: at }, requestKey: definition.requestKey }, { at });
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

function outboxCount(db) {
  return Number(db.get('SELECT COUNT(*) AS n FROM memory_outbox').n);
}

test('HH05: authorization is stored per definition and never inferred from the title', t => {
  const db = newDb(t);
  const planText = '明天提醒我去文庙'; // the text asks for a reminder; the authorization does not
  createItem(db, { title: planText, rule: 'once', timeZone: 'Asia/Shanghai', date: '2026-10-31', time: '09:00', authorization: 'plan' }, { itemId: 'item-plan' });
  createItem(db, { title: planText, rule: 'once', timeZone: 'Asia/Shanghai', date: '2026-10-31', time: '09:00', authorization: 'reminder', source: 'explicit-request' }, { itemId: 'item-reminder' });

  const planned = getAgendaItem(db, KEY, 'item-plan');
  const reminder = getAgendaItem(db, KEY, 'item-reminder');
  assert.equal(planned.authorization, 'plan');
  assert.equal(reminder.authorization, 'reminder');
  assert.equal(planned.title, reminder.title, 'the same wording, two different authorizations');
  assert.equal(reminder.source, 'explicit-request');
  for (const item of [planned, reminder]) assert.ok(AGENDA_AUTHORIZATION.includes(item.authorization));

  // A `tool`/`proactive-contact` authorization is storable but equally inert.
  createItem(db, { title: '查资料', rule: 'daily', timeZone: 'Asia/Shanghai', time: '21:00', authorization: 'tool' }, { itemId: 'item-tool' });
  assert.equal(getAgendaItem(db, KEY, 'item-tool').authorization, 'tool');
  assert.throws(() => normalizeDefinition({ title: 'x', rule: 'daily', timeZone: 'Asia/Shanghai', time: '09:00', authorization: 'send' }, { now: T0 }),
    /unsupported authorization/);
});

test('HH05: delivery is always none and a reminder reports reminderDelivery not-wired (A1-B1)', t => {
  const db = newDb(t);
  createItem(db, { title: '去文庙', rule: 'once', timeZone: 'Asia/Shanghai', date: '2026-10-31', time: '09:00', authorization: 'plan' }, { itemId: 'item-plan' });
  createItem(db, { title: '明早提醒我', rule: 'once', timeZone: 'Asia/Shanghai', date: '2026-10-31', time: '07:00', authorization: 'reminder' }, { itemId: 'item-reminder' });

  const rows = db.all('SELECT item_id, authorization, delivery FROM agenda_items ORDER BY item_id');
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.delivery, 'none', 'H1 never claims a delivery');
    assert.notEqual(row.delivery, 'sent');
  }
  assert.deepEqual([...AGENDA_DELIVERY], ['none', 'reminder-owned']);
  assert.equal(reminderDeliveryFor('reminder'), 'not-wired');
  assert.equal(reminderDeliveryFor('plan'), 'n/a');
  assert.equal(reminderDeliveryFor('tool'), 'n/a');
  assert.equal(reminderDeliveryFor('proactive-contact'), 'n/a');

  const reminder = getAgendaItem(db, KEY, 'item-reminder');
  const planned = getAgendaItem(db, KEY, 'item-plan');
  assert.equal(reminder.delivery, 'none');
  assert.equal(reminder.reminderDelivery, 'not-wired', 'the read path says the reminder is not wired');
  assert.equal(planned.reminderDelivery, 'n/a');
  assert.equal(CODE.includes("'wired'"), false, 'the module never claims a wired reminder');
  assert.equal(CODE.includes('sent'), false, 'the module never claims a sent delivery');
  assert.equal(CODE.includes('delivered'), false);
});

test('HH05: no agenda event creates a memory_outbox row or writes outside its tables', t => {
  const db = newDb(t);
  const before = {
    outbox: outboxCount(db),
    goals: Number(db.get('SELECT COUNT(*) AS n FROM goals').n),
    beliefs: Number(db.get('SELECT COUNT(*) AS n FROM beliefs').n),
    wm: Number(db.get('SELECT COUNT(*) AS n FROM working_memory').n),
    shadow: Number(db.get('SELECT COUNT(*) AS n FROM shadow_proposals').n),
  };
  createItem(db, { title: '明早提醒我', rule: 'daily', timeZone: 'Asia/Shanghai', time: '07:00', authorization: 'reminder' }, { itemId: 'item-1' });
  const item = getAgendaItem(db, KEY, 'item-1');
  const [slot] = planWindow({ item, from: T0, to: T0 + 86400000, limit: 2, now: T0 });
  generate(db, { slot });
  const occurrenceId = occurrenceIdFor(KEY, 'item-1', slot.slotKey);
  fire(db, 'agenda/occurrence-due', { occurrenceId, expectedRevision: 1, scheduledAt: slot.scheduledAt }, { at: slot.scheduledAt });
  fire(db, 'agenda/occurrence-expired', { occurrenceId, expectedRevision: 2, reasonCode: 'due-retention-elapsed' }, { at: slot.scheduledAt + 60000 });
  fire(db, 'agenda/updated', { itemId: 'item-1', expectedRevision: 1, nextRevision: 2, patch: { time: '07:30' } }, { at: T0 + 120000 });
  fire(db, 'agenda/cancelled', { itemId: 'item-1', expectedRevision: 2, reason: 'user', now: T0 + 130000 }, { at: T0 + 130000 });

  assert.equal(outboxCount(db), before.outbox, 'no memory_outbox row is ever queued by an agenda event');
  assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM goals').n), before.goals);
  assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM beliefs').n), before.beliefs);
  assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM working_memory').n), before.wm);
  assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM shadow_proposals').n), before.shadow);
  assert.equal(CODE.includes('memory_outbox'), false, 'the module never names the outbox');
});

test('HH05: dispatched is unreachable without a wired consumer, and never becomes completed', t => {
  const db = newDb(t);
  createItem(db, { title: '散步', rule: 'daily', timeZone: 'Asia/Shanghai', time: '07:00' }, { itemId: 'item-1' });
  const item = getAgendaItem(db, KEY, 'item-1');
  const [slot] = planWindow({ item, from: T0, to: T0 + 86400000, limit: 2, now: T0 });
  generate(db, { slot });
  const occurrenceId = occurrenceIdFor(KEY, 'item-1', slot.slotKey);
  fire(db, 'agenda/occurrence-due', { occurrenceId, expectedRevision: 1 }, { at: slot.scheduledAt });

  // Planning yields opportunities, never a dispatched/completed state.
  for (const planned of planWindow({ item, from: T0, to: T0 + 2 * 86400000, limit: 8, now: T0 })) {
    assert.equal(Object.hasOwn(planned, 'status'), false, 'a slot has no execution status');
  }
  assert.equal(OCCURRENCE_STATUS.includes('completed'), false, 'there is no completed status');
  assert.deepEqual([...TERMINAL_OCCURRENCE_STATUS], ['dispatched', 'skipped', 'cancelled', 'expired']);

  // No consumer wired (config.heartbeat.activityConsumer defaults to ''): refused.
  const noConsumer = fire(db, 'agenda/occurrence-dispatched', { occurrenceId, expectedRevision: 2 }, { at: slot.scheduledAt + 1 });
  assert.equal(noConsumer.rejected, true);
  assert.equal(noConsumer.results[0].code, 'invalid-payload');
  const emptyConsumer = fire(db, 'agenda/occurrence-dispatched', { occurrenceId, expectedRevision: 2, consumer: '   ' }, { at: slot.scheduledAt + 2 });
  assert.equal(emptyConsumer.rejected, true);
  assert.equal(listAgendaOccurrences(db, { scopeKey: KEY })[0].status, 'due', 'the occurrence was not advanced');

  // Only an explicit consumer name may record the downstream intent, and that is H2's
  // call, never a side effect of planning or of a due tick.
  const withConsumer = fire(db, 'agenda/occurrence-dispatched', { occurrenceId, expectedRevision: 2, consumer: 'activity' }, { at: slot.scheduledAt + 3 });
  assert.equal(withConsumer.inserted, true, JSON.stringify(withConsumer.results));
  assert.equal(withConsumer.results[0].result.reasonCode, 'activity');
  assert.equal(outboxCount(db), 0);
  assert.equal(getAgendaItem(db, KEY, 'item-1').delivery, 'none');
});

test('HH05: a reminder definition does not gain a send path through any event', t => {
  const db = newDb(t);
  createItem(db, { title: '明早提醒我', rule: 'once', timeZone: 'Asia/Shanghai', date: '2026-10-31', time: '07:00', authorization: 'reminder' }, { itemId: 'item-reminder' });
  const item = getAgendaItem(db, KEY, 'item-reminder');
  const [slot] = planWindow({ item, from: T0, to: T0 + 2 * 86400000, limit: 2, now: T0 });
  assert.equal(slot.slotKey, `once:${slot.scheduledAt}`);
  generate(db, { itemId: 'item-reminder', slot });
  const occurrenceId = occurrenceIdFor(KEY, 'item-reminder', slot.slotKey);

  // Due, skipped and expired are bookkeeping only: the delivery column and the outbox
  // stay untouched and there is no `dispatched` transition without a consumer.
  fire(db, 'agenda/occurrence-due', { occurrenceId, expectedRevision: 1 }, { at: slot.scheduledAt });
  fire(db, 'agenda/occurrence-skipped', { occurrenceId, expectedRevision: 2, reasonCode: 'no-time' }, { at: slot.scheduledAt + 1 });
  const [occurrence] = listAgendaOccurrences(db, { scopeKey: KEY });
  assert.equal(occurrence.status, 'skipped');
  assert.equal(occurrence.reasonCode, 'no-time');
  assert.equal(outboxCount(db), 0);
  const after = getAgendaItem(db, KEY, 'item-reminder');
  assert.equal(after.delivery, 'none');
  assert.equal(after.reminderDelivery, 'not-wired');
  assert.equal(after.authorization, 'reminder');

  // The reducer's receipt never carries private text or a delivery claim.
  const receipts = db.all("SELECT result FROM consumer_receipts WHERE consumer = 'agenda'");
  for (const row of receipts) {
    assert.equal(row.result.includes('提醒'), false, 'no title text in a receipt');
    assert.equal(row.result.includes('sent'), false);
    assert.equal(row.result.includes('delivered'), false);
  }
  // And nothing here opens a network, channel or contact handle.
  for (const needle of ['node:http', 'node:net', 'node:tls', 'fetch(', 'sendMessage', 'companionContact', 'contactLedger', 'allowExternalSend', 'dryRun']) {
    assert.equal(CODE.includes(needle), false, `agenda.mjs must not reference ${needle}`);
  }
});

test('HH05: a due occurrence is backlog bookkeeping, not a delivery', t => {
  const db = newDb(t);
  createItem(db, { title: '散步', rule: 'daily', timeZone: 'Asia/Shanghai', time: '07:00' }, { itemId: 'item-1' });
  const item = getAgendaItem(db, KEY, 'item-1');
  const [slot] = planWindow({ item, from: T0, to: T0 + 86400000, limit: 2, now: T0 });
  generate(db, { slot });
  const occurrenceId = occurrenceIdFor(KEY, 'item-1', slot.slotKey);
  fire(db, 'agenda/occurrence-due', { occurrenceId, expectedRevision: 1, scheduledAt: slot.scheduledAt }, { at: slot.scheduledAt });
  const due = dueAgendaOccurrences(db, { scopeKey: KEY, at: slot.scheduledAt + 60000 });
  assert.equal(due.length, 1);
  assert.equal(due[0].status, 'due');
  assert.equal(due[0].reasonCode, '');
  assert.equal(outboxCount(db), 0, 'a due item never queues anything');
  // A due occurrence is still cancellable by its definition (A1-B1) and then leaves the backlog.
  fire(db, 'agenda/cancelled', { itemId: 'item-1', expectedRevision: 1, reason: 'user', now: slot.scheduledAt + 120000 }, { at: slot.scheduledAt + 120000 });
  assert.equal(dueAgendaOccurrences(db, { scopeKey: KEY, at: slot.scheduledAt + 600000 }).length, 0);
  assert.equal(outboxCount(db), 0);
});
