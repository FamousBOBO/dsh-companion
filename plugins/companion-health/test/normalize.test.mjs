// Payload -> facts (INTERFACES.md §6).
//
// The last test in this file reads a captured live snapshot from
// `test/fixtures/health-live-probe.json`. It **skips** when the file is absent (it is a local
// artifact produced by the sidecar, deliberately not committed), so the suite still passes on a
// machine that never ran the sidecar — but when the file is there, the assertions are the real
// numbers the CN contour produced (steps 1112, heart rate 95/112/58, resting 79, stress
// 65/69/61, SpO2 97.11/99/95), not invented ones.

import fs from 'node:fs';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  QUALITY,
  TZ,
  activityTotal,
  addLocalDays,
  canonicalJson,
  deviceClassOf,
  epochToMs,
  freshnessOf,
  fromNaiveLocalIso,
  localDateOf,
  localIsoOf,
  localMidnightMs,
  measured,
  normalizeWindow,
  parseObservationValue,
  encodeObservationValue,
  sha256Hex,
  shortHash,
} from '../lib/normalize.mjs';

const LIVE_PROBE = new URL('./fixtures/health-live-probe.json', import.meta.url);

// 2026-11-03T21:05:00+08:00
const NOW = Date.parse('2026-11-03T21:05:00+08:00');

function minimalPayload(overrides = {}) {
  return {
    synced_at: NOW / 1000,
    newest_cloud: NOW / 1000,
    errors: [],
    daily: [],
    health: [],
    sessions: [],
    devices: [],
    sleep_rows: [],
    sources: [],
    realtime: {},
    token: { uid: '100860***', expires_in_min: 58, expires_at_text: '2026-11-03 21:54:38', rotated: false },
    ...overrides,
  };
}

test('QUALITY is the frozen enum and TZ is the attribution zone', () => {
  assert.deepEqual([...QUALITY], [
    'fresh', 'delayed', 'stale', 'no_data',
    'unsupported', 'auth_required', 'rate_limited', 'error',
  ]);
  assert.equal(TZ, 'Asia/Shanghai');
});

test('epochToMs separates seconds from milliseconds', () => {
  // realtime.*.at and sources[].ms are seconds (float); devices[].modifyTime is ms.
  assert.equal(epochToMs(1793708766.66), 1793708766660);
  assert.equal(epochToMs(1793708340), 1793708340000);
  assert.equal(epochToMs('1793708766.66'), 1793708766660);
  assert.equal(epochToMs(1689588249000), 1689588249000);
  assert.equal(epochToMs('1689588249000'), 1689588249000);
  assert.equal(epochToMs(null), null);
  assert.equal(epochToMs(-1), null);
  assert.equal(epochToMs('not-a-number'), null);
  assert.equal(epochToMs(0), null);
});

test('localDateOf / localIsoOf attribute instants to Asia/Shanghai, not UTC', () => {
  // 2026-10-29T17:30Z is already 2026-10-30 01:30 in Shanghai.
  const at = Date.UTC(2026, 9, 29, 17, 30);
  assert.equal(localDateOf(at, TZ), '2026-10-30');
  assert.equal(localDateOf(at, 'UTC'), '2026-10-29');
  assert.equal(localIsoOf(at, TZ), '2026-10-30T01:30:00+08:00');
  assert.equal(localDateOf(null), null);
});

test('localMidnightMs and addLocalDays land on local midnight', () => {
  const midnight = localMidnightMs('2026-11-03', TZ);
  assert.equal(localIsoOf(midnight, TZ), '2026-11-03T00:00:00+08:00');
  assert.equal(Date.UTC(2026, 10, 2, 16, 0, 0), midnight);
  assert.equal(addLocalDays('2026-11-03', 1), '2026-11-04');
  assert.equal(addLocalDays('2026-11-03', -3), '2026-10-31');
  assert.equal(addLocalDays('2026-03-08', 1), '2026-03-09', 'spring-forward day still advances by one date');
  assert.equal(localMidnightMs('nope'), null);
});

test('fromNaiveLocalIso resolves a zone-less local clock, never as UTC', () => {
  // The sidecar sends `2026-10-30T13:59:00` with no zone. `new Date(text)` would
  // read it in the host zone; the naive expectation is Shanghai wall clock.
  const ms = fromNaiveLocalIso('2026-10-30T13:59:00', TZ);
  assert.equal(ms, Date.UTC(2026, 9, 30, 5, 59, 0));
  assert.equal(ms, Date.parse('2026-10-30T13:59:00+08:00'));
  assert.equal(localIsoOf(ms, TZ), '2026-10-30T13:59:00+08:00');

  // A string that carries an offset is honoured as-is.
  assert.equal(fromNaiveLocalIso('2026-10-30T13:59:00+08:00', TZ), ms);
  assert.equal(fromNaiveLocalIso('2026-10-30T05:59:00Z', TZ), ms);
  assert.equal(fromNaiveLocalIso('2026-10-30 13:59:00', TZ), ms, 'space-separated variant');
  assert.equal(fromNaiveLocalIso('2026-10-30', TZ), localMidnightMs('2026-10-30', TZ));

  assert.equal(fromNaiveLocalIso('nope', TZ), null);
  assert.equal(fromNaiveLocalIso('13:59', TZ), null, 'a bare clock cannot be placed on a timeline');
  assert.equal(fromNaiveLocalIso(null, TZ), null);
});

test('duration between two instants is timezone independent', () => {
  const asShanghai = fromNaiveLocalIso('2026-10-30T01:59:00+08:00', TZ);
  const asUtc = fromNaiveLocalIso('2026-10-29T17:59:00Z', TZ);
  assert.equal(asShanghai, asUtc);
});

test('canonicalJson sorts keys and hashes are stable across key order', () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonicalJson({ a: 2, b: 1 }), canonicalJson({ b: 1, a: 2 }));
  assert.equal(sha256Hex(canonicalJson({ x: [1, { b: 1, a: 2 }] })), sha256Hex(canonicalJson({ x: [1, { a: 2, b: 1 }] })));
  assert.equal(sha256Hex('abc').length, 64);
  assert.equal(shortHash('abc').length, 16);
  assert.match(shortHash('A8:C8:3A:01:AC:16#ANDROID21'), /^[0-9a-f]{16}$/);
});

test('freshnessOf buckets and treats a future timestamp as fresh', () => {
  const now = NOW;
  assert.equal(freshnessOf(null, now), 'no_data');
  assert.equal(freshnessOf(now - 60 * 1000, now), 'fresh');
  assert.equal(freshnessOf(now - 60 * 60 * 1000, now), 'delayed');
  assert.equal(freshnessOf(now - 8 * 60 * 60 * 1000, now), 'stale');
  assert.equal(freshnessOf(now + 10 * 60 * 1000, now), 'fresh', 'clock skew is not staleness');
});

test('deviceClassOf classifies the real fleet without inventing a class', () => {
  assert.equal(deviceClassOf('HUAWEI Band 8-002'), 'band');
  assert.equal(deviceClassOf('honor watch S1-c16'), 'watch');
  assert.equal(deviceClassOf('OnePlus5T'), 'phone');
  assert.equal(deviceClassOf('DBY-W09', 'HUAWEI MatePad 11'), 'tablet');
  assert.equal(deviceClassOf('NOH-AN01'), 'phone');
  assert.equal(deviceClassOf('P30'), 'phone');
  assert.equal(deviceClassOf('手动输入'), 'unknown');
  assert.equal(deviceClassOf(''), 'unknown');
  assert.equal(deviceClassOf(null), 'unknown');
});

test('0 and -1 are "not measured" for health series, never a reading', () => {
  assert.equal(measured(0), null);
  assert.equal(measured(-1), null);
  assert.equal(measured(97.1), 97.1);
  assert.equal(measured(null), null);
  // Activity totals keep 0: a zero-step day is a real measurement.
  assert.equal(activityTotal(0), 0);
  assert.equal(activityTotal(-1), null);
  assert.equal(activityTotal(23), 23);
});

test('normalizeWindow zeroes/-1 sentinels out of daily and health rows', () => {
  const normalized = normalizeWindow(minimalPayload({
    daily: [{ date: '2026-11-03', steps: 0, distance_m: 0, kcal: -1, active_hours: null, exercise_min: null, walk_min: 0, step_goal: 10000, sport_type: 0 }],
    health: [{
      date: '2026-11-03',
      heart_rate: 0,
      max_heart_rate: -1,
      min_heart_rate: 58,
      resting_heart_rate: 0,
      stress_average: 0,
      stress_last: -1,
      stress_max: 69,
      stress_min: 61,
      stress_measurements: 6,
      moderate_high_intensity_minutes: 0,
      spo2_avg: 0,
      spo2_max: -1,
      spo2_min: 95,
      spo2_last: 0,
    }],
  }), { nowMs: NOW, fetchedAt: NOW, sourceId: 'huawei-cn' });

  const daily = normalized.daily[0];
  assert.equal(daily.steps, 0, 'a zero-step day is data, not a gap');
  assert.equal(daily.kcal, null, '-1 is the missing sentinel');
  assert.equal(daily.localDate, '2026-11-03');
  assert.equal(daily.observedAt, localMidnightMs('2026-11-03'), 'day anchor is local midnight, not 23:59:59');

  const health = normalized.healthDays[0];
  assert.equal(health.heartRate.avg, null, '0 bpm would be a fabricated reading');
  assert.equal(health.heartRate.max, null);
  assert.equal(health.heartRate.min, 58);
  assert.equal(health.heartRate.resting, null);
  assert.equal(health.stress.avg, null);
  assert.equal(health.stress.last, null);
  assert.equal(health.stress.max, 69);
  assert.equal(health.stress.measurements, 6);
  assert.equal(health.spo2.avg, null);
  assert.equal(health.spo2.min, 95);
  assert.equal(health.intensity.moderateHighMinutes, null);
  assert.equal(health.sleep.present, false);
});

test('normalizeWindow keeps identifiers hashed and the token uid-free', () => {
  const normalized = normalizeWindow(minimalPayload({
    devices: [{
      deviceCode: 1260900415,
      name: 'HUAWEI Band 8-002',
      productId: 700,
      prodId: 'M0CT',
      deviceTypeId: '06E',
      uniqueId: 'JBTTQ23424001783#ANDROID21',
      devId: '618b708f-5783-4fdb-b820-1cfd9363c15d',
      status: 0,
      priority: 99,
      modifyTime: 1793525169000,
      mac: '50:F9:58:49:60:02',
      sn: 'JBTTQ23424001783',
    }],
    realtime: { 心率: { value: 95, unit: 'bpm', at: 1793708340, at_text: '2026-11-03 20:19:00', device: 1260900415 } },
  }), { nowMs: NOW, fetchedAt: NOW, sourceId: 'huawei-cn' });

  const device = normalized.devices[0];
  assert.match(device.uniqueIdHash, /^[0-9a-f]{16}$/);
  assert.match(device.devIdHash, /^[0-9a-f]{16}$/);
  assert.equal(device.uniqueId, undefined, 'the raw uniqueId is not carried at all');
  assert.equal(device.devId, undefined);
  assert.equal(device.deviceClass, 'band');
  assert.equal(device.sourceUpdatedAt, 1793525169000, 'modifyTime is already milliseconds');
  assert.equal(device.isPrimary, true, 'the device that uploaded the realtime sample is primary');
  assert.equal(device.name, 'HUAWEI Band 8-002', 'the display name survives');

  const serialized = JSON.stringify(normalized);
  assert.doesNotMatch(serialized, /JBTTQ23424001783/, 'device serial must not survive');
  assert.doesNotMatch(serialized, /(?:[0-9a-f]{2}:){5}[0-9a-f]{2}/i, 'device MAC must not survive');
  assert.doesNotMatch(serialized, /"uid"/, 'uid must not survive');
  assert.equal(normalized.token.status, 'valid');
  assert.equal(normalized.token.minutesLeft, 58);
  assert.equal(normalized.token.hostKind, 'unknown');
  assert.equal(normalized.token.expiresAt, fromNaiveLocalIso('2026-11-03 21:54:38', TZ));
});

test('normalizeWindow maps the Chinese realtime constants the sidecar really sends', () => {
  const normalized = normalizeWindow(minimalPayload({
    realtime: {
      心率: { value: 95, unit: 'bpm', at: 1793708340, at_text: '2026-11-03 20:19:00', device: 1260900415 },
      压力: { value: 65, unit: '', at: 1793708119 },
      血氧: { value: 99, unit: '%', at: 1793707920 },
    },
  }), { nowMs: NOW, fetchedAt: NOW });
  assert.equal(normalized.realtime.heartRate.value, 95);
  assert.equal(normalized.realtime.heartRate.unit, 'bpm');
  assert.equal(normalized.realtime.stress.value, 65);
  assert.equal(normalized.realtime.spo2.value, 99);
  assert.equal(normalized.realtime.heartRate.at, 1793708340000);
});

test('a renamed realtime key yields null sub-items instead of a guess or a crash', () => {
  // The classic "upstream changed the wording" trap: English keys, no Chinese
  // constants. We must not silently map `heartRate` onto 心率 and pretend we know.
  const normalized = normalizeWindow(minimalPayload({
    realtime: {
      heartRate: { value: 95, unit: 'bpm', at: 1793708340 },
      stress: { value: 65, unit: '', at: 1793708119 },
      spo2: { value: 99, unit: '%', at: 1793707920 },
    },
  }), { nowMs: NOW, fetchedAt: NOW });
  assert.deepEqual(normalized.realtime, { heartRate: null, stress: null, spo2: null });

  // Missing block, empty block and junk all resolve to the same three nulls.
  for (const realtime of [undefined, null, {}, { 心率: null }, { 心率: { value: null, at: 1793708340 } }]) {
    const other = normalizeWindow(minimalPayload({ realtime }), { nowMs: NOW, fetchedAt: NOW });
    assert.deepEqual(other.realtime, { heartRate: null, stress: null, spo2: null });
  }
  // A literal 0 is passed through untouched: a stress score of 0 is a real reading,
  // so dropping it here would be the mirror-image mistake.
  const zero = normalizeWindow(minimalPayload({
    realtime: { 压力: { value: 0, unit: '', at: 1793708119 } },
  }), { nowMs: NOW, fetchedAt: NOW });
  assert.equal(zero.realtime.stress.value, 0);
});

test('REALTIME_KEYS is the single place the upstream literals are written down', async () => {
  const { REALTIME_KEYS } = await import('../lib/normalize.mjs');
  assert.deepEqual(REALTIME_KEYS, { heartRate: '心率', stress: '压力', spo2: '血氧' });
  assert.equal(Object.isFrozen(REALTIME_KEYS), true);
});

test('normalizeWindow maps a workout through the local-ISO rule and keeps the upstream label', () => {
  const normalized = normalizeWindow(minimalPayload({
    sessions: [{
      sport_type: 2,
      duration_min: 2,
      steps: 174,
      distance_m: 132,
      kcal: 15.5,
      segments: 2,
      device_code: 2323025196,
      start: '2026-11-03T17:13:00',
      end: '2026-11-03T17:15:00',
      sport: 'hill',
    }],
  }), { nowMs: NOW, fetchedAt: NOW, sourceId: 'huawei-cn' });

  const workout = normalized.workouts[0];
  assert.equal(workout.startAt, Date.UTC(2026, 10, 3, 9, 13));
  assert.equal(workout.endAt, Date.UTC(2026, 10, 3, 9, 15));
  assert.equal(localIsoOf(workout.startAt), '2026-11-03T17:13:00+08:00');
  assert.equal(workout.sportTypeRaw, 2, 'the raw code is preserved, not remapped');
  assert.equal(workout.sportTypeLabel, 'hill');
  assert.equal(workout.sportTypeMapping, 'upstream_const', 'the label is the app table, not our fact');
  assert.equal(workout.durationMin, 2);
  assert.equal(workout.segments, 2);
  assert.equal(workout.deviceCode, '2323025196');
  assert.match(workout.sourceRecordKey, /^wkt:/);
});

test('normalizeWindow drops a workout whose window cannot be parsed and keeps the rest', () => {
  const normalized = normalizeWindow(minimalPayload({
    sessions: [
      { sport_type: 2, start: '13:59', end: '14:00' },
      { sport_type: 4, start: '2026-11-03T07:00:00', end: '2026-11-03T07:30:00' },
    ],
  }), { nowMs: NOW, fetchedAt: NOW, sourceId: 'huawei-cn' });
  assert.equal(normalized.workouts.length, 1);
  assert.equal(normalized.workouts[0].sportTypeRaw, 4);
});

test('normalizeWindow passes sleep rows through untouched and never guesses a date', () => {
  const normalized = normalizeWindow(minimalPayload({
    sleep_rows: [{ date: '2026-11-02', allSleepTime: 420 }, { allSleepTime: 300 }],
  }), { nowMs: NOW, fetchedAt: NOW, sourceId: 'huawei-cn' });
  assert.equal(normalized.sleepRows.length, 2);
  assert.equal(normalized.sleepRows[0].localDate, '2026-11-02');
  assert.equal(normalized.sleepRows[0].raw.allSleepTime, 420);
  assert.equal(normalized.sleepRows[1].localDate, null, 'no date means no date attribution');
});

test('normalizeWindow produces a stable rawHash and tolerates junk input', () => {
  const a = normalizeWindow(minimalPayload(), { nowMs: NOW, fetchedAt: NOW });
  const b = normalizeWindow(minimalPayload(), { nowMs: NOW, fetchedAt: NOW });
  assert.equal(a.rawHash, b.rawHash);
  assert.equal(a.rawHash.length, 64);

  const empty = normalizeWindow(null, { nowMs: NOW });
  assert.deepEqual(empty.daily, []);
  assert.deepEqual(empty.healthDays, []);
  assert.deepEqual(empty.workouts, []);
  assert.deepEqual(empty.devices, []);
  assert.deepEqual(empty.errors, []);
  assert.equal(empty.rawHash.length, 64);
});

test('observation value round-trips through the stored envelope', () => {
  const encoded = encodeObservationValue({ hash: 'abc', value: { avg: 95, resting: 79 } });
  assert.deepEqual(parseObservationValue(encoded), { hash: 'abc', value: { avg: 95, resting: 79 } });
  assert.deepEqual(parseObservationValue(JSON.parse(encoded)), { hash: 'abc', value: { avg: 95, resting: 79 } });
  assert.deepEqual(parseObservationValue({ observed_value_json: encoded }), { hash: 'abc', value: { avg: 95, resting: 79 } });
  assert.deepEqual(parseObservationValue('not json'), { hash: null, value: {} });
  assert.deepEqual(parseObservationValue(null), { hash: null, value: {} });
});

test('live CN snapshot normalises to the numbers the account actually produced', (t) => {
  if (!fs.existsSync(LIVE_PROBE)) {
    t.skip('test/fixtures/health-live-probe.json not present (local artifact, not committed)');
    return;
  }
  const payload = JSON.parse(fs.readFileSync(LIVE_PROBE, 'utf8'));
  const normalized = normalizeWindow(payload, { nowMs: NOW, fetchedAt: NOW, sourceId: 'huawei-cn' });

  assert.equal(normalized.daily.length, 7);
  assert.equal(normalized.healthDays.length, 2);
  assert.equal(normalized.workouts.length, 2);
  assert.equal(normalized.devices.length, 9);
  assert.equal(normalized.sleepRows.length, 0, 'this account really has no cloud sleep yet');
  assert.deepEqual(normalized.errors, []);

  const today = normalized.daily.at(-1);
  assert.equal(today.localDate, '2026-11-03');
  assert.equal(today.steps, 1112);
  assert.equal(today.distanceM, 864);
  assert.equal(today.kcal, 53.1);
  assert.equal(today.activeHours, 3);
  assert.equal(today.exerciseMin, 1);
  assert.equal(today.stepGoal, 10000);

  const health = normalized.healthDays.at(-1);
  assert.equal(health.localDate, '2026-11-03');
  assert.deepEqual(health.heartRate, { avg: 95, max: 112, min: 58, resting: 79 });
  assert.deepEqual(health.stress, { avg: 65, max: 69, min: 61, last: 65, measurements: 6 });
  assert.equal(health.spo2.avg, 97.11111111111111);
  assert.equal(health.spo2.max, 99);
  assert.equal(health.spo2.min, 95);
  assert.equal(health.spo2.last, 99);
  assert.equal(health.intensity.moderateHighMinutes, 1);

  // 2026-10-30 only carries the intensity family — no invented zeros for the rest.
  const early = normalized.healthDays.find(row => row.localDate === '2026-10-30');
  assert.equal(early.intensity.moderateHighMinutes, 1);
  assert.deepEqual(early.heartRate, { avg: null, max: null, min: null, resting: null });

  assert.equal(normalized.workouts[0].sportTypeRaw, 2);
  assert.equal(normalized.workouts[0].sportTypeLabel, 'hill');
  assert.equal(normalized.workouts[0].sportTypeMapping, 'upstream_const');

  assert.equal(normalized.realtime.heartRate.value, 95);
  assert.equal(normalized.realtime.stress.value, 65);
  assert.equal(normalized.realtime.spo2.value, 99);
  assert.equal(normalized.token.status, 'valid');
  assert.equal(normalized.token.hostKind, 'cn');

  const classNames = normalized.devices.map(device => device.deviceClass);
  assert.ok(classNames.includes('band'));
  assert.ok(classNames.includes('watch'));
  assert.equal(classNames.filter(name => name === 'phone').length >= 3, true);
  assert.equal(classNames.includes('tablet'), true);

  const serialized = JSON.stringify(normalized);
  assert.doesNotMatch(serialized, /(?:[0-9a-f]{2}:){5}[0-9a-f]{2}/i, 'no MAC anywhere in the normalized window');
  assert.doesNotMatch(serialized, /"uid"/, 'no uid anywhere in the normalized window');
  assert.doesNotMatch(serialized, /access_?token|refresh_?token/i);
  assert.doesNotMatch(serialized, /JBTTQ23424001783/, 'no device serial');
});
