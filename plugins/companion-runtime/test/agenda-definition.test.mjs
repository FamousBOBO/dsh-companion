import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openRuntimeDb } from '../lib/db.mjs';
import { dispatchEvent, listEvents, normalizeEvent, receiptFor } from '../lib/events.mjs';
import { scopeKey } from '../lib/scope.mjs';
import {
  AGENDA_ITEM_STATUS,
  AGENDA_AUTHORIZATION,
  OCCURRENCE_STATUS,
  RULE_KINDS,
  SLOT_LIMITS,
  TERMINAL_OCCURRENCE_STATUS,
  activeAgendaItems,
  agendaCounts,
  applyAgendaEvent,
  getAgendaItem,
  listAgendaItems,
  listAgendaOccurrences,
  normalizeDefinition,
  occurrenceIdFor,
  planWindow,
  slotKeyFor,
} from '../lib/agenda.mjs';
import { addLocalDays, isoWeekdayOfDate, resolveLocalInstant } from '../lib/agenda-time.mjs';

// HH02: definitions, idempotency and stable slots. Every write goes through
// `dispatchEvent` with the real `agenda` reducer, so the append → receipt →
// projection path is exercised, never a private write path.

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

function fire(db, kind, payload, { at = T0, scope = SCOPE } = {}) {
  return dispatchEvent(db, normalizeEvent({ kind, scope, occurredAt: at, payload }), { handlers: HANDLERS, generation: 'gen-1' });
}

function createItem(db, input, { itemId = 'item-1', at = T0, scope = SCOPE, revision = 1 } = {}) {
  const definition = normalizeDefinition(input, { now: at });
  const result = fire(db, 'agenda/created', {
    item: { ...definition, itemId, revision, createdAt: at },
    requestKey: definition.requestKey,
  }, { at, scope });
  return { definition, result };
}

function generate(db, { itemId, slot, at = slot.scheduledAt, scope = SCOPE }) {
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

function rowCount(db, table) {
  return Number(db.get(`SELECT COUNT(*) AS n FROM ${table}`).n);
}

function codeOf(result) {
  return result.results?.[0]?.code ?? '';
}

test('HH02: the frozen enums are exactly the contract sets', () => {
  assert.deepEqual([...AGENDA_ITEM_STATUS], ['active', 'cancelled', 'expired']);
  assert.deepEqual([...OCCURRENCE_STATUS], ['scheduled', 'due', 'dispatched', 'skipped', 'cancelled', 'expired']);
  assert.deepEqual([...TERMINAL_OCCURRENCE_STATUS], ['dispatched', 'skipped', 'cancelled', 'expired']);
  assert.deepEqual([...RULE_KINDS], ['once', 'daily', 'weekly']);
  assert.deepEqual([...AGENDA_AUTHORIZATION], ['plan', 'reminder', 'tool', 'proactive-contact']);
  assert.deepEqual({ ...SLOT_LIMITS }, { maxHorizonHours: 720, maxQuerySpanDays: 90, maxSlotsPerPlan: 512 });
});

test('HH02: once, daily and weekly normalise and plan the expected slots', t => {
  const db = newDb(t);

  const once = normalizeDefinition({ title: '去文庙', rule: 'once', timeZone: 'Asia/Shanghai', date: '2026-10-31', time: '09:30' }, { now: T0 });
  assert.equal(once.date, '2026-10-31');
  assert.equal(once.time, '09:30');
  assert.equal(once.atUtc, Date.UTC(2026, 9, 31, 1, 30));
  assert.equal(once.resolution.resolution, 'exact');
  assert.equal(once.weekdays.length, 0);
  const onceItem = { ...once, revision: 1, status: 'active' };
  const onceSlots = planWindow({ item: onceItem, from: T0, to: T0 + 5 * 86400000, limit: 8, now: T0 });
  assert.equal(onceSlots.length, 1);
  assert.equal(onceSlots[0].slotKey, `once:${once.atUtc}`);
  assert.equal(onceSlots[0].scheduledAt, once.atUtc);

  const daily = normalizeDefinition({ title: '散步', rule: 'daily', timeZone: 'Asia/Shanghai', time: '07:00' }, { now: T0 });
  assert.equal(daily.date, '');
  assert.equal(daily.atUtc, null);
  assert.equal(daily.resolution.resolution, 'exact');
  const dailyItem = { ...daily, revision: 1, status: 'active' };
  const dailySlots = planWindow({ item: dailyItem, from: T0, to: T0 + 3 * 86400000, limit: 8, now: T0 });
  // T0 is 08:00 local, so 2026-10-30 07:00 is already behind `from` and is not planned.
  assert.equal(dailySlots.length, 3);
  assert.deepEqual(dailySlots.map(slot => slot.slotKey), ['d:2026-10-31', 'd:2026-11-01', 'd:2026-11-02']);

  const weekly = normalizeDefinition({ title: '整理', rule: 'weekly', timeZone: 'Asia/Shanghai', time: '20:00', weekdays: [5, 1, 3, 3] }, { now: T0 });
  assert.deepEqual([...weekly.weekdays], [1, 3, 5], 'sorted and deduplicated');
  const weeklyItem = { ...weekly, revision: 1, status: 'active' };
  const weeklySlots = planWindow({ item: weeklyItem, from: T0, to: T0 + 7 * 86400000, limit: 16, now: T0 });
  for (const slot of weeklySlots) {
    assert.ok([1, 3, 5].includes(isoWeekdayOfDate(slot.localDate)), `${slot.localDate} must be Mon/Wed/Fri`);
    assert.match(slot.slotKey, /^w:\d{4}-\d{2}-\d{2}$/);
  }
  assert.ok(weeklySlots.length > 0);

  // The reducer stores the same shapes it planned with.
  createItem(db, { title: '去文庙', rule: 'once', timeZone: 'Asia/Shanghai', date: '2026-10-31', time: '09:30' }, { itemId: 'once-1' });
  const stored = getAgendaItem(db, KEY, 'once-1');
  assert.equal(stored.rule, 'once');
  assert.equal(stored.date, '2026-10-31');
  assert.equal(stored.atUtc, Date.UTC(2026, 9, 31, 1, 30));
  assert.equal(stored.status, 'active');
  assert.equal(stored.revision, 1);
  assert.equal(stored.resolution.resolution, 'exact');
  assert.equal(stored.resolution.rule, 'once');
});

test('HH02: definition validation rejects bad input with the frozen messages', () => {
  const bad = (input, pattern) => assert.throws(() => normalizeDefinition(input, { now: T0 }), pattern);
  bad({ rule: 'daily', timeZone: 'Asia/Shanghai', time: '09:00' }, /^ValidationError: title is required$|title is required/);
  bad({ title: '  ', rule: 'daily', timeZone: 'Asia/Shanghai', time: '09:00' }, /title is required/);
  bad({ title: 'x', rule: 'hourly', timeZone: 'Asia/Shanghai', time: '09:00' }, /unsupported rule: hourly/);
  bad({ title: 'x', rule: 'daily', timeZone: 'Asia/Shanghai', time: '9:00:00' }, /invalid time: HH:MM required/);
  bad({ title: 'x', rule: 'daily', timeZone: 'Asia/Shanghai', time: '25:00' }, /invalid time: HH:MM required/);
  bad({ title: 'x', rule: 'weekly', timeZone: 'Asia/Shanghai', time: '09:00' }, /weekly requires weekdays/);
  bad({ title: 'x', rule: 'weekly', timeZone: 'Asia/Shanghai', time: '09:00', weekdays: [] }, /weekly requires weekdays/);
  bad({ title: 'x', rule: 'weekly', timeZone: 'Asia/Shanghai', time: '09:00', weekdays: [0] }, /weekdays must be ISO 1\.\.7/);
  bad({ title: 'x', rule: 'weekly', timeZone: 'Asia/Shanghai', time: '09:00', weekdays: [8] }, /weekdays must be ISO 1\.\.7/);
  bad({ title: 'x', rule: 'weekly', timeZone: 'Asia/Shanghai', time: '09:00', weekdays: [1.5] }, /weekdays must be ISO 1\.\.7/);
  bad({ title: 'x', rule: 'once', timeZone: 'Asia/Shanghai', time: '09:00' }, /invalid local date: YYYY-MM-DD required/);
  bad({ title: 'x', rule: 'once', timeZone: 'Asia/Shanghai', time: '09:00', date: '2026-02-30' }, /invalid local date/);
  bad({ title: 'x', rule: 'daily', timeZone: 'Asia/Shanghai', time: '09:00', validFrom: T0, validUntil: T0 }, /validUntil must be after validFrom/);
  bad({ title: 'x', rule: 'daily', timeZone: 'Asia/Shanghai', time: '09:00', category: 'work' }, /unsupported category/);
  bad({ title: 'x', rule: 'daily', timeZone: 'Asia/Shanghai', time: '09:00', authorization: 'send' }, /unsupported authorization/);
  bad({ title: 'x', rule: 'daily', timeZone: 'Mars/Olympus', time: '09:00' }, /invalid-timezone: Mars\/Olympus/);

  // Title is trimmed to 120 chars and refs to 80; nothing silently falls back.
  const long = normalizeDefinition({ title: `  ${'长'.repeat(200)}  `, rule: 'daily', timeZone: 'Asia/Shanghai', time: '09:00', goalRef: `${'g'.repeat(120)}@1`, commitmentRef: `${'c'.repeat(120)}@2` }, { now: T0 });
  assert.equal(long.title.length, 120);
  assert.equal(long.goalRef.length, 80);
  assert.equal(long.commitmentRef.length, 80);
  assert.equal(Object.isFrozen(long), true);
  assert.equal(Object.isFrozen(long.resolution), true);
  assert.equal(Object.isFrozen(long.weekdays), true);
});

test('HH02: a derived request key is stable across retries and distinct per definition', () => {
  const base = { title: '散步', rule: 'daily', timeZone: 'Asia/Shanghai', time: '07:00' };
  const first = normalizeDefinition(base, { now: T0 });
  const later = normalizeDefinition(base, { now: T0 + 9 * 86400000 });
  assert.equal(first.requestKey, later.requestKey, 'a retry days later derives the same key');
  assert.match(first.requestKey, /^req_[0-9a-f]{24}$/);
  // A1 delta 4: `validFrom` is excluded from the key (it defaults to the local day start,
  // which would otherwise turn every honest retry into a brand new request) …
  assert.notEqual(first.validFrom, later.validFrom, 'the default window does follow the day');
  assert.equal(first.validFrom, Date.UTC(2026, 9, 29, 16), 'the default validFrom is the start of the Shanghai day');
  assert.equal(later.validFrom, Date.UTC(2026, 10, 7, 16));
  // … while `validUntil` is part of the request when it is given.
  assert.notEqual(first.requestKey,
    normalizeDefinition({ ...base, validUntil: T0 + 86400000 }, { now: T0 }).requestKey);
  assert.notEqual(first.requestKey, normalizeDefinition({ ...base, title: '夜读' }, { now: T0 }).requestKey);
  assert.notEqual(first.requestKey, normalizeDefinition({ ...base, time: '08:00' }, { now: T0 }).requestKey);
  assert.notEqual(first.requestKey, normalizeDefinition({ ...base, timeZone: 'Asia/Tokyo' }, { now: T0 }).requestKey);
  const explicit = normalizeDefinition({ ...base, requestKey: `  ${'k'.repeat(120)}  ` }, { now: T0 });
  assert.equal(explicit.requestKey.length, 80);
  assert.equal(explicit.requestKey, 'k'.repeat(80));
});

test('HH02: the same request key ten times creates exactly one item', t => {
  const db = newDb(t);
  const definition = normalizeDefinition({ title: '散步', rule: 'daily', timeZone: 'Asia/Shanghai', time: '07:00' }, { now: T0 });
  const outcomes = [];
  for (let i = 0; i < 10; i += 1) {
    outcomes.push(fire(db, 'agenda/created', {
      item: { ...definition, itemId: 'item-1', revision: 1, createdAt: T0 },
      requestKey: definition.requestKey,
    }, { at: T0 + i }));
  }
  assert.equal(outcomes[0].inserted, true);
  assert.equal(outcomes[0].results[0].applied, true);
  for (const attempt of outcomes.slice(1)) {
    assert.equal(attempt.rejected, true, 'a repeated request is a deterministic veto');
    assert.equal(codeOf(attempt), 'duplicate-request');
    assert.equal(attempt.inserted, false);
  }
  assert.equal(rowCount(db, 'agenda_items'), 1, 'one definition, not ten');
  assert.equal(rowCount(db, 'domain_events'), 1, 'a refused duplicate leaves no event row behind');
  assert.equal(receiptFor(db, 'agenda', outcomes[1].event.eventId), null);
  const items = listAgendaItems(db, { scopeKey: KEY });
  assert.equal(items.length, 1);
  assert.equal(items[0].itemId, 'item-1');

  // A different request key is a different definition and is accepted.
  const other = fire(db, 'agenda/created', {
    item: { ...normalizeDefinition({ title: '夜读', rule: 'daily', timeZone: 'Asia/Shanghai', time: '22:00' }, { now: T0 }), itemId: 'item-2', revision: 1, createdAt: T0 },
  }, { at: T0 + 20 });
  assert.equal(other.inserted, true);
  assert.equal(rowCount(db, 'agenda_items'), 2);
});

test('HH02: the same slot generated ten times leaves exactly one occurrence', t => {
  const db = newDb(t);
  createItem(db, { title: '散步', rule: 'daily', timeZone: 'Asia/Shanghai', time: '07:00' });
  const item = getAgendaItem(db, KEY, 'item-1');
  const [slot] = planWindow({ item, from: T0, to: T0 + 86400000, limit: 2, now: T0 });
  const outcomes = [];
  // A1-B2: the canonical instant of a generation event is the slot's own instant; the
  // later attempts stand for retries after a failure and stay deterministic.
  for (let i = 0; i < 10; i += 1) outcomes.push(generate(db, { itemId: 'item-1', slot, at: slot.scheduledAt + i }));
  assert.equal(outcomes[0].inserted, true);
  assert.equal(outcomes[0].results[0].result.duplicate, undefined, 'the first generation really inserted');
  // A1-B3: re-planning the same window is an idempotent success, never a rejection that
  // would roll the per-scope transaction back.
  for (const attempt of outcomes.slice(1)) {
    assert.equal(attempt.rejected, false);
    assert.equal(attempt.results[0].applied, true);
    assert.equal(attempt.results[0].result.duplicate, true);
  }
  assert.equal(rowCount(db, 'agenda_occurrences'), 1);
  const [occurrence] = listAgendaOccurrences(db, { scopeKey: KEY });
  assert.equal(occurrence.occurrenceId, occurrenceIdFor(KEY, 'item-1', slot.slotKey));
  assert.equal(occurrence.slotKey, 'd:2026-10-31');
  assert.equal(occurrence.status, 'scheduled');
  assert.equal(occurrence.revision, 1, 'an idempotent duplicate does not bump the occurrence revision');
  assert.equal(occurrence.definitionRevision, 1);
  assert.equal(agendaCounts(db, KEY).occurrences.scheduled, 1);
});

test('HH02: a revision bump never duplicates a historical slot', t => {
  const db = newDb(t);
  createItem(db, { title: '散步', rule: 'daily', timeZone: 'Asia/Shanghai', time: '07:00' });
  let item = getAgendaItem(db, KEY, 'item-1');
  const slots = planWindow({ item, from: T0, to: T0 + 3 * 86400000, limit: 8, now: T0 });
  assert.equal(slots.length, 3);
  for (const [index, slot] of slots.entries()) {
    const outcome = generate(db, { itemId: 'item-1', slot, at: slot.scheduledAt + index });
    assert.equal(outcome.inserted, true, JSON.stringify(outcome.results));
  }
  const before = listAgendaOccurrences(db, { scopeKey: KEY });
  assert.equal(before.length, 3);

  const updated = fire(db, 'agenda/updated', {
    itemId: 'item-1',
    expectedRevision: 1,
    nextRevision: 2,
    patch: { title: '散步（改）', time: '07:30' },
    updatedAt: T0 + 300,
  }, { at: T0 + 300 });
  assert.equal(updated.inserted, true, JSON.stringify(updated.results));
  item = getAgendaItem(db, KEY, 'item-1');
  assert.equal(item.revision, 2);
  assert.equal(item.time, '07:30');

  // Same slot keys, so the old slots stay the same rows: a revision bump cannot create
  // a second occurrence for a date that was already materialised.
  const replanned = planWindow({ item, from: T0, to: T0 + 3 * 86400000, limit: 8, now: T0 });
  assert.deepEqual(replanned.map(slot => slot.slotKey), slots.map(slot => slot.slotKey));
  assert.notDeepEqual(replanned.map(slot => slot.scheduledAt), slots.map(slot => slot.scheduledAt));
  for (const [index, slot] of replanned.entries()) {
    const again = generate(db, { itemId: 'item-1', slot, at: slot.scheduledAt + index });
    assert.equal(again.rejected, true);
    assert.equal(codeOf(again), 'reschedule-required', 'a moved instant needs an explicit reschedule event');
  }
  assert.equal(listAgendaOccurrences(db, { scopeKey: KEY }).length, 3, 'no historical slot was duplicated');

  // A brand new date after the bump is a new slot with the new definition revision.
  const nextSlot = planWindow({ item, from: T0 + 4 * 86400000, to: T0 + 5 * 86400000, limit: 1, now: T0 })[0];
  assert.ok(nextSlot, 'a later day still plans a slot');
  const fresh = generate(db, { itemId: 'item-1', slot: nextSlot });
  assert.equal(fresh.inserted, true, JSON.stringify(fresh.results));
  assert.equal(listAgendaOccurrences(db, { scopeKey: KEY }).length, 4);
  assert.equal(fresh.results[0].result.definitionRevision, 2);
});

test('HH02: planning is bounded — no unlimited future slots', t => {
  const db = newDb(t);
  createItem(db, { title: '散步', rule: 'daily', timeZone: 'Asia/Shanghai', time: '07:00' });
  const item = getAgendaItem(db, KEY, 'item-1');

  const tenYears = planWindow({ item, from: T0, to: T0 + 3650 * 86400000, limit: SLOT_LIMITS.maxSlotsPerPlan, now: T0 });
  const horizon = T0 + SLOT_LIMITS.maxHorizonHours * 3600000;
  assert.ok(tenYears.length > 0);
  assert.ok(tenYears.length <= 31, `a 720h horizon cannot yield ${tenYears.length} daily slots`);
  for (const slot of tenYears) assert.ok(slot.scheduledAt <= horizon, 'never plan past the horizon');

  assert.equal(planWindow({ item, from: T0, to: T0 + 30 * 86400000, limit: 5, now: T0 }).length, 5);
  assert.equal(planWindow({ item, from: T0, to: T0 + 86400000, limit: 0, now: T0 }).length, 0);
  assert.equal(planWindow({ item, from: T0, to: T0 + 86400000, limit: 99999, now: T0 }).length <= SLOT_LIMITS.maxSlotsPerPlan, true);
  assert.deepEqual(planWindow({ item, from: T0 + 86400000, to: T0, limit: 8, now: T0 }), [], 'an inverted window yields nothing');
  assert.deepEqual(planWindow({ item: { ...item, status: 'cancelled' }, from: T0, to: T0 + 86400000, limit: 8, now: T0 }), [],
    'a cancelled definition plans nothing');

  // Validity window clamps planning as well (2026-10-31T00:00Z … 2026-11-02T00:00Z).
  const bounded = normalizeDefinition({ title: '限时', rule: 'daily', timeZone: 'Asia/Shanghai', time: '07:00', validFrom: T0 + 86400000, validUntil: T0 + 3 * 86400000 }, { now: T0 });
  const boundedSlots = planWindow({ item: { ...bounded, revision: 1, status: 'active' }, from: T0, to: T0 + 10 * 86400000, limit: 32, now: T0 });
  assert.deepEqual(boundedSlots.map(slot => slot.localDate), ['2026-11-01', '2026-11-02']);
});

test('HH02: weekly plans only the named ISO weekdays', () => {
  const weekly = normalizeDefinition({ title: '整理', rule: 'weekly', timeZone: 'Asia/Shanghai', time: '20:00', weekdays: [1, 3, 5] }, { now: T0 });
  const item = { ...weekly, revision: 1, status: 'active' };
  const from = T0;
  const to = T0 + 14 * 86400000;
  const slots = planWindow({ item, from, to, limit: 64, now: T0 });
  // Expected: every Mon/Wed/Fri local date whose resolved instant is inside the window.
  const expected = [];
  let date = '2026-10-30';
  for (let i = 0; i < 20; i += 1) {
    const resolved = resolveLocalInstant({ date, time: '20:00', timeZone: 'Asia/Shanghai' });
    if ([1, 3, 5].includes(isoWeekdayOfDate(date)) && resolved.at >= from && resolved.at <= to) expected.push(date);
    date = addLocalDays(date, 1);
  }
  assert.deepEqual(slots.map(slot => slot.localDate), expected);
  assert.ok(slots.length >= 5, 'two weeks of Mon/Wed/Fri must produce several slots');
  for (const slot of slots) assert.ok([1, 3, 5].includes(isoWeekdayOfDate(slot.localDate)));
  assert.equal(new Set(slots.map(slot => slot.scheduledAt)).size, slots.length, 'one instant per local date');
});

test('HH02: queries stay bounded and scope-scoped', t => {
  const db = newDb(t);
  createItem(db, { title: '散步', rule: 'daily', timeZone: 'Asia/Shanghai', time: '07:00' }, { itemId: 'item-1' });
  createItem(db, { title: '夜读', rule: 'daily', timeZone: 'Asia/Shanghai', time: '22:00' }, { itemId: 'item-2' });
  const item = getAgendaItem(db, KEY, 'item-1');
  const [slot] = planWindow({ item, from: T0, to: T0 + 86400000, limit: 2, now: T0 });
  generate(db, { itemId: 'item-1', slot });

  const active = activeAgendaItems(db, { scopeKey: KEY, at: T0, limit: 1 });
  assert.equal(active.length, 1, 'limit is honoured');
  assert.equal(activeAgendaItems(db, { scopeKey: KEY, at: T0, limit: 8 }).length, 2);
  const counts = agendaCounts(db, KEY);
  assert.equal(counts.items, 2);
  assert.equal(counts.occurrences.scheduled, 1);
  assert.equal(counts.nextOccurrenceAt, slot.scheduledAt);
  assert.equal(agendaCounts(db).items, 2, 'whole-database diagnostics still work');
  assert.equal(listAgendaOccurrences(db, { scopeKey: KEY, limit: 1 }).length, 1);
  assert.equal(listAgendaItems(db, { scopeKey: KEY, status: 'cancelled' }).length, 0);
  assert.throws(() => listAgendaItems(db, { scopeKey: KEY, status: 'gone' }), /unknown agenda item status/);
  assert.throws(() => listAgendaOccurrences(db, { scopeKey: KEY, statuses: ['gone'] }), /unknown occurrence status/);
  assert.throws(() => listAgendaItems(db, {}), /scopeKey is required/);
  assert.equal(listEvents(db, { scopeKey: KEY, kind: 'agenda/occurrence-generated' }).length, 1);
});
