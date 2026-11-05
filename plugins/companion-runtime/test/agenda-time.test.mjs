import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openRuntimeDb } from '../lib/db.mjs';
import { scopeKey } from '../lib/scope.mjs';
import {
  addLocalDays,
  isValidLocalDate,
  isValidLocalTime,
  isValidTimeZone,
  isoWeekdayOfDate,
  localDateString,
  localParts,
  normalizeLocalTime,
  offsetMinutesAt,
  resolveLocalInstant,
} from '../lib/agenda-time.mjs';
import { normalizeDefinition, planWindow, slotKeyFor } from '../lib/agenda.mjs';

// HH06: time zones, DST gaps/folds, cross-midnight `today`, leap day and month end.
// Everything here is a pure function of its arguments: no database, no host zone.

const T0 = Date.UTC(2026, 9, 30, 0, 0, 0); // 2026-10-30T00:00Z = 08:00 Asia/Shanghai

function plannedItem(input, { now = T0 } = {}) {
  const definition = normalizeDefinition(input, { now });
  return { ...definition, revision: 1, status: 'active' };
}

function dayWindow(date, timeZone) {
  const start = resolveLocalInstant({ date, time: '00:00', timeZone });
  const end = resolveLocalInstant({ date, time: '23:59', timeZone });
  assert.equal(start.ok, true);
  assert.equal(end.ok, true);
  return { from: start.at, to: end.at };
}

test('HH06: Asia/Shanghai and UTC disagree about the date across midnight', () => {
  const at = Date.UTC(2026, 9, 29, 17, 30); // 2026-10-30 01:30 in Shanghai, still 10-29 UTC
  const shanghai = localParts(at, 'Asia/Shanghai');
  assert.deepEqual(
    { year: shanghai.year, month: shanghai.month, day: shanghai.day, hour: shanghai.hour, minute: shanghai.minute, second: shanghai.second },
    { year: 2026, month: 10, day: 30, hour: 1, minute: 30, second: 0 },
  );
  assert.equal(shanghai.isoWeekday, 5, '2026-10-30 is a Friday');
  assert.equal(localDateString(at, 'Asia/Shanghai'), '2026-10-30');
  assert.equal(localDateString(at, 'UTC'), '2026-10-29');
  assert.equal(localDateString(at, 'America/New_York'), '2026-10-29');
  assert.equal(localParts(Date.UTC(2026, 9, 30, 4, 0), 'UTC').isoWeekday, 5);
  assert.equal(localParts(Date.UTC(2026, 10, 1, 4, 0), 'UTC').isoWeekday, 7, '2026-11-01 is a Sunday');
  assert.equal(localParts(Date.UTC(2026, 10, 2, 4, 0), 'UTC').isoWeekday, 1, '2026-11-02 is a Monday');
});

test('HH06: offsetMinutesAt reports the zone offset, including both sides of DST', () => {
  assert.equal(offsetMinutesAt(T0, 'UTC'), 0);
  assert.equal(offsetMinutesAt(T0, 'Asia/Shanghai'), 480);
  assert.equal(offsetMinutesAt(Date.UTC(2027, 0, 15, 12), 'America/New_York'), -300, 'winter: EST');
  assert.equal(offsetMinutesAt(Date.UTC(2027, 6, 15, 12), 'America/New_York'), -240, 'summer: EDT');
});

test('HH06: leap day, month end and year end are pure calendar arithmetic', () => {
  assert.equal(addLocalDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addLocalDays('2028-02-29', 1), '2028-03-01');
  assert.equal(addLocalDays('2027-02-28', 1), '2027-03-01', 'no leap day in 2027');
  assert.equal(addLocalDays('2026-01-31', 1), '2026-02-01');
  assert.equal(addLocalDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addLocalDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addLocalDays('2028-02-29', 366), '2029-03-01');
  assert.equal(isValidLocalDate('2028-02-29'), true);
  assert.equal(isValidLocalDate('2027-02-29'), false, 'a non-leap 02-29 is not a calendar date');
  assert.equal(isValidLocalDate('2026-13-01'), false);
  assert.equal(isValidLocalDate('2026-1-1'), false);
  assert.equal(isValidLocalTime('9:05'), true);
  assert.equal(normalizeLocalTime('9:05'), '09:05');
  assert.equal(normalizeLocalTime('24:00'), '');
  assert.equal(isValidLocalTime('23:59'), true);
  assert.equal(isoWeekdayOfDate('2026-10-30'), 5);
  assert.equal(isoWeekdayOfDate('2026-10-31'), 6);
  assert.equal(isoWeekdayOfDate('2026-11-01'), 7);
});

test('HH06: an unknown IANA zone is refused, never replaced by a default', () => {
  assert.equal(isValidTimeZone('Asia/Shanghai'), true);
  assert.equal(isValidTimeZone('UTC'), true);
  assert.equal(isValidTimeZone('America/Argentina/Buenos_Aires'), true);
  assert.equal(isValidTimeZone('Mars/Olympus'), false);
  assert.equal(isValidTimeZone('Not A Zone'), false);
  assert.equal(isValidTimeZone(''), false);
  assert.equal(isValidTimeZone('+05:30'), false, 'a raw offset is not an IANA name');
  assert.equal(isValidTimeZone(undefined), false);
  assert.equal(isValidTimeZone(42), false);

  assert.throws(() => normalizeDefinition({ title: 'x', rule: 'daily', timeZone: 'Mars/Olympus', time: '09:00' }, { now: T0 }),
    error => error.code === 'invalid-input' && /^invalid-timezone: Mars\/Olympus$/.test(error.message));
  assert.throws(() => normalizeDefinition({ title: 'x', rule: 'daily', timeZone: '', time: '09:00' }, { now: T0 }),
    /invalid-timezone/);
  assert.throws(() => resolveLocalInstant({ date: '2026-10-30', time: '09:00', timeZone: 'Mars/Olympus' }),
    /invalid-timezone/);
});

test('HH06: a local wall clock inside a DST gap resolves to nothing (2027-03-14 02:30 New York)', () => {
  const gap = resolveLocalInstant({ date: '2027-03-14', time: '02:30', timeZone: 'America/New_York' });
  assert.equal(gap.ok, false);
  assert.equal(gap.resolution, 'gap');
  assert.equal(gap.at, null, 'no instant is invented for a wall clock that does not exist');
  assert.deepEqual(gap.intent, { date: '2027-03-14', time: '02:30', zone: 'America/New_York' });

  const before = resolveLocalInstant({ date: '2027-03-14', time: '01:30', timeZone: 'America/New_York' });
  assert.equal(before.ok, true);
  assert.equal(before.resolution, 'exact');
  assert.equal(new Date(before.at).toISOString(), '2027-03-14T06:30:00.000Z', '01:30 EST');

  const after = resolveLocalInstant({ date: '2027-03-14', time: '03:30', timeZone: 'America/New_York' });
  assert.equal(new Date(after.at).toISOString(), '2027-03-14T07:30:00.000Z', '03:30 EDT');
});

test('HH06: a DST fold takes the earlier UTC instant (2027-11-07 01:30 New York)', () => {
  const fold = resolveLocalInstant({ date: '2027-11-07', time: '01:30', timeZone: 'America/New_York' });
  assert.equal(fold.ok, true);
  assert.equal(fold.resolution, 'fold');
  assert.equal(new Date(fold.at).toISOString(), '2027-11-07T05:30:00.000Z', 'the earlier (EDT) instant');
  assert.notEqual(new Date(fold.at).toISOString(), '2027-11-07T06:30:00.000Z', 'not the later (EST) instant');
  assert.equal(localDateString(fold.at, 'America/New_York'), '2027-11-07');
  assert.equal(localParts(fold.at, 'America/New_York').hour, 1);
});

test('HH06: the fold rule also holds for a southern-hemisphere zone (Pacific/Auckland)', () => {
  const fold = resolveLocalInstant({ date: '2027-04-04', time: '02:30', timeZone: 'Pacific/Auckland' });
  assert.equal(fold.resolution, 'fold');
  assert.equal(new Date(fold.at).toISOString(), '2027-04-03T13:30:00.000Z', 'NZDT +13: the earlier of the two');
  const gap = resolveLocalInstant({ date: '2027-09-26', time: '02:30', timeZone: 'Pacific/Auckland' });
  assert.equal(gap.resolution, 'gap');
  assert.equal(gap.at, null);
});

test('HH06: `today` is computed in the schedule zone, not the host UTC date', () => {
  // Host UTC says 2026-10-30; Shanghai has already rolled over to 2026-10-31.
  const at = Date.UTC(2026, 9, 30, 16, 30);
  assert.equal(new Date(at).toISOString().slice(0, 10), '2026-10-30');
  assert.equal(localDateString(at, 'Asia/Shanghai'), '2026-10-31');
  const item = plannedItem({ title: '早起', rule: 'daily', timeZone: 'Asia/Shanghai', time: '00:15', validFrom: at - 3 * 86400000 });
  const slots = planWindow({ item, ...dayWindow('2026-10-31', 'Asia/Shanghai'), limit: 4, now: at });
  assert.equal(slots.length, 1, 'exactly the Shanghai day slot');
  assert.equal(slots[0].localDate, '2026-10-31');
  assert.equal(new Date(slots[0].scheduledAt).toISOString(), '2026-10-30T16:15:00.000Z');

  // West of UTC it is the other way round: UTC 2026-10-30, Los Angeles 2026-10-29.
  const west = Date.UTC(2026, 9, 30, 2, 0);
  assert.equal(localDateString(west, 'America/Los_Angeles'), '2026-10-29');
  const westItem = plannedItem({ title: '晚读', rule: 'daily', timeZone: 'America/Los_Angeles', time: '20:00', validFrom: west - 3 * 86400000 });
  const westSlots = planWindow({ item: westItem, ...dayWindow('2026-10-29', 'America/Los_Angeles'), limit: 4, now: west });
  assert.equal(westSlots.length, 1);
  assert.equal(westSlots[0].localDate, '2026-10-29');
  assert.equal(new Date(westSlots[0].scheduledAt).toISOString(), '2026-10-30T03:00:00.000Z');
});

test('HH06: a timezone change keeps slot keys stable and only moves the instants', () => {
  const base = { title: '散步', rule: 'daily', time: '09:00', validFrom: T0 - 3 * 86400000 };
  const shanghai = plannedItem({ ...base, timeZone: 'Asia/Shanghai' });
  const newYork = plannedItem({ ...base, timeZone: 'America/New_York' });
  const limit = 4;

  // Same local date, two zones: identical slot key, different UTC instant. That is what
  // lets an update preview reschedule the existing row instead of duplicating it.
  const inShanghai = planWindow({ item: shanghai, ...dayWindow('2026-10-31', 'Asia/Shanghai'), limit, now: T0 });
  const inNewYork = planWindow({ item: newYork, ...dayWindow('2026-10-31', 'America/New_York'), limit, now: T0 });
  assert.equal(inShanghai.length, 1);
  assert.equal(inNewYork.length, 1);
  assert.equal(inShanghai[0].slotKey, 'd:2026-10-31');
  assert.equal(inNewYork[0].slotKey, inShanghai[0].slotKey);
  assert.equal(slotKeyFor(shanghai), slotKeyFor(newYork), 'the slot key carries no zone and no revision');
  assert.equal(new Date(inShanghai[0].scheduledAt).toISOString(), '2026-10-31T01:00:00.000Z');
  assert.equal(new Date(inNewYork[0].scheduledAt).toISOString(), '2026-10-31T13:00:00.000Z');
  assert.notEqual(inShanghai[0].scheduledAt, inNewYork[0].scheduledAt);

  // Planning is pure and repeatable: same input, byte-identical output, whatever the clock.
  const again = planWindow({ item: shanghai, ...dayWindow('2026-10-31', 'Asia/Shanghai'), limit, now: T0 });
  assert.deepEqual(again, inShanghai);
  const muchLater = planWindow({ item: shanghai, ...dayWindow('2026-10-31', 'Asia/Shanghai'), limit, now: T0 + 3600000 });
  assert.deepEqual(muchLater, inShanghai, 'a moved wall clock does not rewrite a past slot');
});

test('HH06: a DST-gap date yields a skipped slot instead of an invented instant', () => {
  const now = Date.UTC(2027, 2, 13, 0, 0, 0); // 2027-03-13, inside the 720h planning horizon
  const item = plannedItem({ title: '晨跑', rule: 'daily', timeZone: 'America/New_York', time: '02:30', validFrom: now });
  const from = resolveLocalInstant({ date: '2027-03-13', time: '00:00', timeZone: 'America/New_York' }).at;
  const to = resolveLocalInstant({ date: '2027-03-15', time: '23:59', timeZone: 'America/New_York' }).at;
  const slots = planWindow({ item, from, to, limit: 8, now });
  assert.equal(slots.length, 3);
  assert.equal(slots[0].localDate, '2027-03-13');
  assert.equal(slots[0].skipped, undefined);
  assert.equal(slots[1].localDate, '2027-03-14');
  assert.equal(slots[1].skipped, true);
  assert.equal(slots[1].reason, 'dst-gap');
  assert.equal(slots[1].scheduledAt, null);
  assert.equal(slots[1].slotKey, 'd:2027-03-14');
  assert.equal(slots[2].localDate, '2027-03-15');
  assert.equal(slots[2].skipped, undefined);
  // The skipped entry still consumes one slot of the bound.
  const capped = planWindow({ item, from, to, limit: 2, now });
  assert.equal(capped.length, 2);
  assert.equal(capped[1].skipped, true);
});

test('HH06: a once item locks the resolved UTC instant and records its DST resolution', () => {
  const foldNow = Date.UTC(2027, 10, 1, 0, 0, 0); // 2027-11-01
  const foldOnce = normalizeDefinition({ title: '一次', rule: 'once', timeZone: 'America/New_York', date: '2027-11-07', time: '01:30' }, { now: foldNow });
  assert.equal(foldOnce.atUtc, Date.UTC(2027, 10, 7, 5, 30));
  assert.equal(foldOnce.resolution.resolution, 'fold');
  assert.equal(slotKeyFor(foldOnce), `once:${foldOnce.atUtc}`);
  const item = { ...foldOnce, revision: 3, status: 'active' };
  const slots = planWindow({ item, from: foldNow, to: foldNow + 30 * 86400000, limit: 4, now: foldNow });
  assert.equal(slots.length, 1);
  assert.equal(slots[0].resolution, 'fold');
  assert.equal(slots[0].slotKey, `once:${foldOnce.atUtc}`);
  assert.equal(slots[0].definitionRevision, 3);

  const gapNow = Date.UTC(2027, 2, 10, 0, 0, 0); // 2027-03-10
  const gapOnce = normalizeDefinition({ title: '一次', rule: 'once', timeZone: 'America/New_York', date: '2027-03-14', time: '02:30' }, { now: gapNow });
  assert.equal(gapOnce.atUtc, null);
  assert.equal(gapOnce.resolution.resolution, 'gap');
  assert.match(gapOnce.resolution.note, /does not exist/);
  const gapSlots = planWindow({ item: { ...gapOnce, revision: 1, status: 'active' }, from: gapNow, to: gapNow + 30 * 86400000, limit: 4, now: gapNow });
  assert.equal(gapSlots.length, 1);
  assert.equal(gapSlots[0].skipped, true);
  assert.equal(gapSlots[0].reason, 'dst-gap');
  assert.equal(gapSlots[0].scheduledAt, null);
});

test('HH06: the schedule zone is stored on the definition, not inferred from the host', () => {
  const db = openRuntimeDb({ file: ':memory:', now: () => T0 });
  assert.ok(scopeKey({ userId: 'owner-1' }));
  const item = plannedItem({ title: '读经', rule: 'daily', timeZone: 'Asia/Tokyo', time: '07:45' });
  assert.equal(item.timeZone, 'Asia/Tokyo');
  assert.deepEqual(item.resolution.localIntent, { date: '', time: '07:45', zone: 'Asia/Tokyo' });
  const slots = planWindow({ item, ...dayWindow('2026-10-31', 'Asia/Tokyo'), limit: 2, now: T0 });
  assert.equal(slots.length, 1);
  assert.equal(new Date(slots[0].scheduledAt).toISOString(), '2026-10-30T22:45:00.000Z');
  db.close();
});
