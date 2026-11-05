// Sleep normalisation (INTERFACES.md §7).
//
// ⚠️ SIMULATED FIXTURE — every sleep row below is hand-written for this test. It
// is **not** real account data: the live CN account has zero cloud sleep records
// today (HUAWEI_HEALTH_README §10.1). These fixtures exist to prove the rules, not
// to describe a real night, and nothing here is a medical reading.
//
// The rules under test are the ones that decide whether the store is honest:
//   1. aggregate minutes with no parseable window => NULL start/end, status
//      'aggregate_only' (never `sleepDate 00:00 + duration`);
//   2. a real window => a normal session;
//   3. stages only when the source published intervals, nothing padded;
//   4. durations from UTC differences, not local clock differences;
//   5. naps; 6. overlapping/out-of-bounds stages degrade to 'partial';
//   7. an empty array writes nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TZ,
  fromNaiveLocalIso,
  localDateOf,
  localIsoOf,
  localMidnightMs,
} from '../lib/normalize.mjs';
import {
  SLEEP_STAGES,
  assignSleepDate,
  classifyAvailability,
  crossMidnight,
  normalizeSleepRows,
  sleepContentHash,
  sleepSessionId,
  stageCoverage,
  stageKindOf,
  validateStages,
} from '../lib/sleep.mjs';

// 2026-11-03T21:05:00+08:00
const NOW = Date.parse('2026-11-03T21:05:00+08:00');
const OPTS = { nowMs: NOW, fetchedAt: NOW, sourceId: 'huawei-cn', tz: TZ };

/** A normal night: 2026-11-02 23:40 -> 2026-11-03 07:10 Shanghai. */
const MAIN_NIGHT = {
  date: '2026-11-03',
  fall_asleep: '2026-11-02T23:40:00',
  wakeup: '2026-11-03T07:10:00',
  allSleepTime: 430,
  awakeTime: 20,
  deepSleepTime: 95,
  lightSleepTime: 275,
  dreamTime: 60,
  sleepScore: 82,
};

test('SLEEP_STAGES is the frozen enum', () => {
  assert.deepEqual([...SLEEP_STAGES], ['deep', 'light', 'rem', 'awake', 'unknown']);
});

test('assignSleepDate attributes a night to the local date it ended on', () => {
  const endAt = fromNaiveLocalIso('2026-11-03T07:10:00', TZ);
  assert.equal(assignSleepDate(endAt, TZ), '2026-11-03');
  // ...which is NOT the date it started on.
  const startAt = fromNaiveLocalIso('2026-11-02T23:40:00', TZ);
  assert.equal(assignSleepDate(startAt, TZ), '2026-11-02');
  assert.equal(assignSleepDate(null, TZ), null);
});

test('crossMidnight reports the date boundary without inventing one', () => {
  const startAt = fromNaiveLocalIso('2026-11-02T23:40:00', TZ);
  const endAt = fromNaiveLocalIso('2026-11-03T07:10:00', TZ);
  assert.deepEqual(crossMidnight(startAt, endAt, TZ), {
    spansMidnight: true,
    localDateStart: '2026-11-02',
    localDateEnd: '2026-11-03',
  });
  const daySleep = fromNaiveLocalIso('2026-11-03T13:00:00', TZ);
  assert.equal(crossMidnight(daySleep, fromNaiveLocalIso('2026-11-03T14:00:00', TZ), TZ).spansMidnight, false);
  assert.deepEqual(crossMidnight(null, null, TZ), { spansMidnight: false, localDateStart: null, localDateEnd: null });
});

test('a normal night becomes one confirmed session with real start and end', () => {
  const [session] = normalizeSleepRows([MAIN_NIGHT], OPTS);
  assert.equal(session.sleepDate, '2026-11-03');
  assert.equal(session.startAt, fromNaiveLocalIso('2026-11-02T23:40:00', TZ));
  assert.equal(session.endAt, fromNaiveLocalIso('2026-11-03T07:10:00', TZ));
  assert.equal(localIsoOf(session.startAt), '2026-11-02T23:40:00+08:00');
  assert.equal(session.status, 'confirmed');
  assert.equal(session.sessionQuality, 'origin-confirmed');
  assert.equal(session.asleepMinutes, 430);
  assert.equal(session.awakeMinutes, 20);
  assert.equal(session.deepMinutes, 95);
  assert.equal(session.lightMinutes, 275);
  assert.equal(session.remMinutes, 60, 'dreamTime is REM');
  assert.equal(session.isNap, 0);
  assert.equal(session.sourceScore, 82);
  assert.equal(session.timezoneId, TZ);
  assert.equal(session.stages.length, 0, 'aggregate minutes are not stage intervals');
  assert.equal(session.stageFidelity, 'partial', 'aggregate stage minutes are partial fidelity');
  // 覆盖率的分母是**起止跨度**（430 分钟沉睡 + 20 分钟清醒 = 450 跨度），分子是
  // deep+light+rem+awake —— 所以这里正好 450/450 = 1。
  // 旧断言用 asleep(430) 当分母，算出来 1.0465（>1）；2026-11-04 首夜真数据出现过 1.0234，
  // 一个大于 1 的覆盖率只会让人以为数据坏了，现在夹到 [0,1]。
  assert.equal(session.inBedMinutes, 450, '起止跨度就是契约 §4.1 的跨度');
  assert.equal(session.stageCoverage, 1);
});

test('duration comes from the UTC difference, not the local clock', () => {
  // Same instant expressed two ways must yield the same elapsed minutes.
  const asNaive = normalizeSleepRows([{
    date: '2026-11-03',
    fall_asleep: '2026-11-02T23:40:00',
    wakeup: '2026-11-03T07:10:00',
  }], OPTS)[0];
  const asOffsets = normalizeSleepRows([{
    date: '2026-11-03',
    fall_asleep: '2026-11-02T23:40:00+08:00',
    wakeup: '2026-11-02T23:10:00Z',
  }], OPTS)[0];
  const minutesOf = session => (session.endAt - session.startAt) / 60000;
  assert.equal(minutesOf(asNaive), 450);
  assert.equal(minutesOf(asOffsets), 450);
  assert.equal(asNaive.startAt, asOffsets.startAt);
  assert.equal(asNaive.endAt, asOffsets.endAt);
});

test('a DST-shaped window is still measured in real elapsed time', () => {
  // 2026-03-08 is US spring-forward; Shanghai has no DST, so the same wall-clock
  // numbers are a plain 8h. The point of the test is that the helper never reads
  // the local clock to compute a duration.
  const session = normalizeSleepRows([{
    date: '2026-03-08',
    fall_asleep: '2026-03-07T23:00:00',
    wakeup: '2026-03-08T07:00:00',
  }], OPTS)[0];
  assert.equal(session.endAt - session.startAt, 8 * 60 * 60 * 1000);
  // Cross-check against the same window from a zone that *does* shift: the UTC
  // instant difference is what matters and must still be 8h.
  const shifted = normalizeSleepRows([{
    date: '2026-03-08',
    fall_asleep: '2026-03-07T15:00:00Z',
    wakeup: '2026-03-07T23:00:00Z',
  }], OPTS)[0];
  assert.equal(shifted.endAt - shifted.startAt, 8 * 60 * 60 * 1000);
  assert.equal(shifted.startAt, session.startAt);
});

test('aggregate-only rows never get a manufactured time window', () => {
  const [session] = normalizeSleepRows([{ date: '2026-11-02', allSleepTime: 420 }], OPTS);
  assert.equal(session.startAt, null, 'no fall_asleep => no start');
  assert.equal(session.endAt, null, 'no wakeup => no end');
  assert.equal(session.status, 'aggregate_only');
  assert.equal(session.sessionQuality, 'aggregate-only');
  assert.equal(session.asleepMinutes, 420);
  assert.equal(session.stageFidelity, 'unknown');
  assert.equal(session.stageCoverage, null);
  // The forbidden shortcut: sleepDate 00:00 + duration.
  assert.notEqual(session.startAt, localMidnightMs('2026-11-02'));
  assert.notEqual(session.endAt, localMidnightMs('2026-11-02') + 420 * 60000);
});

test('an unparseable window falls back to aggregate-only instead of guessing', () => {
  const [session] = normalizeSleepRows([{
    date: '2026-11-02',
    fall_asleep: '23:40',
    wakeup: '07:10',
    allSleepTime: 450,
  }], OPTS);
  assert.equal(session.startAt, null);
  assert.equal(session.endAt, null);
  assert.equal(session.status, 'aggregate_only');
});

test('an empty array or a row without a date writes nothing', () => {
  assert.deepEqual(normalizeSleepRows([], OPTS), []);
  assert.deepEqual(normalizeSleepRows(null, OPTS), []);
  assert.deepEqual(normalizeSleepRows([{ allSleepTime: 400 }], OPTS), [], 'no sleep_date, no row');
  assert.deepEqual(normalizeSleepRows([{}, 'junk', 42], OPTS), []);
});

test('stage intervals are stored when the source publishes them', () => {
  const [session] = normalizeSleepRows([{
    date: '2026-11-03',
    fall_asleep: '2026-11-02T23:00:00',
    wakeup: '2026-11-03T07:00:00',
    allSleepTime: 480,
    stages: [
      { stage: 'light', start: '2026-11-02T23:00:00', end: '2026-11-03T01:00:00' },
      { stage: 'deep', start: '2026-11-03T01:00:00', end: '2026-11-03T03:00:00' },
      { stage: 'rem', start: '2026-11-03T03:00:00', end: '2026-11-03T04:00:00' },
      { stage: 'awake', start: '2026-11-03T04:00:00', end: '2026-11-03T04:30:00' },
      { stage: 'light', start: '2026-11-03T04:30:00', end: '2026-11-03T07:00:00' },
    ],
  }], OPTS);
  assert.equal(session.stages.length, 5);
  assert.equal(session.stageFidelity, 'exact');
  assert.equal(session.stages[1].stage, 'deep');
  assert.equal(session.stages[1].stageIndex, 1);
  assert.equal(session.stages[1].fidelity, 'exact');
  assert.equal(session.stageCoverage, 1, 'the fixture covers the whole window');
  assert.equal(session.status, 'confirmed');
});

test('overlapping stages are stored but downgraded to partial', () => {
  const stages = [
    { stage: 'light', startAt: 0, endAt: 120 * 60000 },
    { stage: 'deep', startAt: 60 * 60000, endAt: 180 * 60000 },
  ];
  const report = validateStages(stages, { startAt: 0, endAt: 480 * 60000 });
  assert.equal(report.ok, false);
  assert.ok(report.issues.some(issue => issue.code === 'overlap'));

  const [session] = normalizeSleepRows([{
    date: '2026-11-03',
    fall_asleep: '2026-11-02T23:00:00',
    wakeup: '2026-11-03T07:00:00',
    stages: [
      { stage: 'light', start: '2026-11-02T23:00:00', end: '2026-11-03T01:00:00' },
      { stage: 'deep', start: '2026-11-03T00:00:00', end: '2026-11-03T02:00:00' },
    ],
  }], OPTS);
  assert.equal(session.stageFidelity, 'partial');
  assert.equal(session.stages.length, 2);
  assert.ok(session.issues.some(issue => issue.code === 'overlap'));
});

test('stages outside the session window are reported', () => {
  const report = validateStages(
    [{ stage: 'deep', startAt: -60 * 60000, endAt: 30 * 60000 }],
    { startAt: 0, endAt: 480 * 60000 },
  );
  assert.equal(report.ok, false);
  assert.ok(report.issues.some(issue => issue.code === 'outside-session'));
});

test('a stage that ends before it starts is a start-after-end issue', () => {
  const report = validateStages([{ stage: 'deep', startAt: 10, endAt: 5 }], {});
  assert.deepEqual(report.issues.map(issue => issue.code), ['start-after-end']);
});

test('a gap is reported but does not invalidate the night', () => {
  const report = validateStages([
    { stage: 'deep', startAt: 0, endAt: 60 * 60000 },
    { stage: 'light', startAt: 120 * 60000, endAt: 180 * 60000 },
  ], { startAt: 0, endAt: 480 * 60000 });
  assert.equal(report.ok, true, 'a real night has uncovered stretches');
  assert.deepEqual(report.issues.map(issue => issue.code), ['gap']);

  const coverage = stageCoverage(
    [{ startAt: 0, endAt: 60 * 60000 }, { startAt: 120 * 60000, endAt: 180 * 60000 }],
    { startAt: 0, endAt: 480 * 60000 },
  );
  assert.equal(coverage.coveredMinutes, 120);
  assert.equal(coverage.totalMinutes, 480);
  assert.equal(coverage.ratio, 0.25);
  assert.equal(coverage.gaps.length, 2);
});

test('stage totals above the session length are flagged', () => {
  const report = validateStages([
    { stage: 'deep', startAt: 0, endAt: 120 * 60000 },
    { stage: 'light', startAt: 120 * 60000, endAt: 240 * 60000 },
    { stage: 'rem', startAt: 240 * 60000, endAt: 360 * 60000 },
  ], { startAt: 0, endAt: 300 * 60000, toleranceMs: 0 });
  assert.ok(report.issues.some(issue => issue.code === 'sum-exceeds-session'));
});

test('stageCoverage clips to the session and unions overlaps', () => {
  const coverage = stageCoverage([
    { startAt: -10 * 60000, endAt: 30 * 60000 },
    { startAt: 20 * 60000, endAt: 50 * 60000 },
  ], { startAt: 0, endAt: 60 * 60000 });
  assert.equal(coverage.coveredMinutes, 50);
  assert.equal(coverage.ratio, Math.round((50 / 60) * 10000) / 10000);
  assert.equal(coverage.gaps.length, 1);

  const unbounded = stageCoverage([{ startAt: 0, endAt: 60 * 60000 }], {});
  assert.equal(unbounded.totalMinutes, 0);
  assert.equal(unbounded.ratio, null);
  assert.deepEqual(unbounded.gaps, []);
});

test('stageKindOf maps source labels and leaves the unrecognised as unknown', () => {
  assert.equal(stageKindOf('deepSleepTime'), 'deep');
  assert.equal(stageKindOf('DEEP'), 'deep');
  assert.equal(stageKindOf('深睡'), 'deep');
  assert.equal(stageKindOf('light'), 'light');
  assert.equal(stageKindOf('浅睡'), 'light');
  assert.equal(stageKindOf('dreamTime'), 'rem');
  assert.equal(stageKindOf('REM'), 'rem');
  assert.equal(stageKindOf('awake'), 'awake');
  assert.equal(stageKindOf('清醒'), 'awake');
  assert.equal(stageKindOf(7), 'unknown', 'a bare numeric code is not guessed');
  assert.equal(stageKindOf(null), 'unknown');
});

test('a short sleep ending in the waking day is a nap', () => {
  const [nap] = normalizeSleepRows([{
    date: '2026-11-03',
    fall_asleep: '2026-11-03T13:00:00',
    wakeup: '2026-11-03T14:00:00',
    allSleepTime: 60,
  }], OPTS);
  assert.equal(nap.isNap, 1);
  assert.equal(nap.status, 'confirmed');

  const [night] = normalizeSleepRows([MAIN_NIGHT], OPTS);
  assert.equal(night.isNap, 0, 'a 7h night is never a nap');

  const [evening] = normalizeSleepRows([{
    date: '2026-11-03',
    fall_asleep: '2026-11-03T20:30:00',
    wakeup: '2026-11-03T21:00:00',
    allSleepTime: 30,
  }], OPTS);
  assert.equal(evening.isNap, 0, 'after 20:00 it is the start of the night, not a nap');
});

test('multi-segment nights keep every segment and group them under one date', () => {
  const sessions = normalizeSleepRows([
    { date: '2026-11-03', fall_asleep: '2026-11-02T23:00:00', wakeup: '2026-11-03T03:00:00', allSleepTime: 240 },
    { date: '2026-11-03', fall_asleep: '2026-11-03T03:40:00', wakeup: '2026-11-03T07:00:00', allSleepTime: 200 },
  ], OPTS);
  assert.equal(sessions.length, 2);
  assert.notEqual(sessions[0].sourceRecordKey, sessions[1].sourceRecordKey, 'distinct segments stay distinct');
  assert.equal(sessions[0].canonicalGroupId, sessions[1].canonicalGroupId, 'same night groups together');
  assert.equal(sessions[0].sleepDate, '2026-11-03');
  assert.equal(sessions[1].sleepDate, '2026-11-03');
});

test('duplicate aggregate rows on one date get distinct record keys', () => {
  const sessions = normalizeSleepRows([
    { date: '2026-11-02', allSleepTime: 100 },
    { date: '2026-11-02', allSleepTime: 200 },
  ], OPTS);
  assert.equal(sessions.length, 2);
  assert.notEqual(sessions[0].sourceRecordKey, sessions[1].sourceRecordKey);
});

test('a corrected night keeps its record key but changes its content hash and revision id', () => {
  const original = normalizeSleepRows([MAIN_NIGHT], OPTS)[0];
  const corrected = normalizeSleepRows([{ ...MAIN_NIGHT, allSleepTime: 400 }], OPTS)[0];
  assert.equal(corrected.sourceRecordKey, original.sourceRecordKey, 'same night, same identity');
  assert.notEqual(corrected.contentHash, original.contentHash, 'different content');
  assert.equal(corrected.revision, 1, 'normalisation always produces revision 1');

  assert.notEqual(sleepSessionId('huawei-cn', original.sourceRecordKey, 1), sleepSessionId('huawei-cn', original.sourceRecordKey, 2));
  assert.equal(
    sleepSessionId('huawei-cn', original.sourceRecordKey, 1),
    sleepSessionId('huawei-cn', original.sourceRecordKey, 1),
    'the id is deterministic',
  );
  // An identical re-poll hashes the same, which is what makes the replay a no-op.
  assert.equal(normalizeSleepRows([MAIN_NIGHT], OPTS)[0].contentHash, original.contentHash);
});

test('sleepContentHash ignores fields that are not part of the night', () => {
  const base = { sleepDate: '2026-11-03', startAt: 1, endAt: 2, asleepMinutes: 3 };
  assert.equal(sleepContentHash(base), sleepContentHash({ ...base, fetchedAt: 999, rawRef: 'x' }));
  assert.notEqual(sleepContentHash(base), sleepContentHash({ ...base, asleepMinutes: 4 }));
  assert.equal(sleepContentHash(null).length, 64);
});

test('an inferred date makes the session provisional, not confirmed', () => {
  const [session] = normalizeSleepRows([{
    // no `date`: the night is attributed from the local end date
    fall_asleep: '2026-11-02T23:40:00',
    wakeup: '2026-11-03T07:10:00',
    allSleepTime: 430,
  }], OPTS);
  assert.equal(session.sleepDate, '2026-11-03');
  assert.equal(session.status, 'provisional');
  assert.equal(session.sessionQuality, 'partial');
});

test('a window with no duration is lite, not confirmed', () => {
  const [session] = normalizeSleepRows([{
    date: '2026-11-03',
    fall_asleep: '2026-11-02T23:40:00',
    wakeup: '2026-11-03T07:10:00',
  }], OPTS);
  assert.equal(session.status, 'lite');
  // The elapsed window is still reported as the night's length — that is an
  // arithmetic fact about the two instants, not an invented reading.
  assert.equal(session.asleepMinutes, 450);
});

test('classifyAvailability separates "no watch synced yet" from "nothing to show"', () => {
  assert.equal(classifyAvailability({ sessionCount: 0, newestEndAt: null, nowMs: NOW }), 'awaiting_first_night');
  assert.equal(classifyAvailability({ sessionCount: 0, newestEndAt: 1, nowMs: NOW }), 'no_data');
  assert.equal(
    classifyAvailability({ sessionCount: 2, newestEndAt: NOW - 6 * 60 * 60 * 1000, nowMs: NOW }),
    'present',
  );
  assert.equal(
    classifyAvailability({ sessionCount: 2, newestEndAt: NOW - 10 * 86400000, nowMs: NOW }),
    'partial',
    'an old night means the picture is partial, not absent',
  );
  assert.equal(classifyAvailability({ sessionCount: 3, newestEndAt: null, nowMs: NOW }), 'partial');
  assert.equal(classifyAvailability(), 'awaiting_first_night');
});

test('the session id and dates survive a round trip through the store shape', () => {
  const [session] = normalizeSleepRows([MAIN_NIGHT], OPTS);
  assert.equal(localDateOf(session.endAt, TZ), session.sleepDate);
  assert.match(session.id, /^slp_[0-9a-f]{16}$/);
  assert.equal(session.sourceId, 'huawei-cn');
  assert.equal(session.revision, 1);
  assert.equal(session.rawRef, null);
});
