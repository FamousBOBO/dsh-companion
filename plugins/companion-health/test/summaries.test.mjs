// Read projections (INTERFACES.md §9 + §11).
//
// This file exists because of a real integration defect: `sources()` returned `[]`
// in the running plugin while `status()` looked fine, since one caller passes
// `(db, config, nowMs)` positionally instead of the contract's options object. The
// first two tests lock both call shapes down.
//
// The other invariant worth a test: a day with no sample must report
// `value: null` / `activity: null`, never 0.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openHealthDb } from '../lib/db.mjs';
import { createIngest } from '../lib/ingest.mjs';
import { redactWindowPayload } from '../lib/cn-adapter.mjs';
import {
  TREND_METRIC_NAMES,
  buildSleep,
  buildSources,
  buildToday,
  buildTrend,
  newestSampleAt,
} from '../lib/summaries.mjs';

const NOW = Date.parse('2026-11-03T21:05:00+08:00');
const TODAY = '2026-11-03';
/** The last uploaded realtime point: 46 minutes before "now", as the real account had. */
const REALTIME_AT = Date.parse('2026-11-03T20:19:00+08:00');

function payload(overrides = {}) {
  return {
    synced_at: NOW / 1000,
    newest_cloud: NOW / 1000,
    errors: [],
    daily: [{
      date: TODAY,
      sport_type: 0,
      steps: 1112,
      distance_m: 864,
      kcal: 53.1,
      duration_min: 32,
      walk_min: 30,
      active_hours: 3,
      exercise_min: 1,
      step_goal: 10000,
    }],
    health: [{
      date: TODAY,
      resting_heart_rate: 79,
      heart_rate: 95,
      max_heart_rate: 112,
      min_heart_rate: 58,
      stress_average: 65,
      stress_last: 65,
      stress_max: 69,
      stress_min: 61,
      stress_measurements: 6,
      moderate_high_intensity_minutes: 1,
      spo2_avg: 97.1,
      spo2_max: 99,
      spo2_min: 95,
      spo2_last: 99,
    }],
    sessions: [{
      sport_type: 2,
      duration_min: 2,
      steps: 174,
      distance_m: 132,
      kcal: 15.5,
      segments: 2,
      device_code: 2323025196,
      start: `${TODAY}T17:13:00`,
      end: `${TODAY}T17:15:00`,
      sport: 'hill',
    }],
    devices: [{ deviceCode: 1260900415, name: 'HUAWEI Band 8-002', priority: 99, modifyTime: 1793525169000 }],
    sleep_rows: [],
    sources: [{ name: '心率', ms: NOW / 1000, text: '2026-11-03 20:26:06', rel: '39 分钟前', rt_text: '95 bpm @ 20:19' }],
    realtime: { 心率: { value: 95, unit: 'bpm', at: REALTIME_AT / 1000, device: 1260900415 } },
    token: { expires_in_min: 58 },
    ...overrides,
  };
}

async function seededDb(data = payload()) {
  const db = openHealthDb({ file: ':memory:' });
  const adapter = {
    describe: () => ({}),
    async fetchWindow() {
      return {
        ok: true,
        httpStatus: 200,
        latencyMs: 1,
        fetchedAt: NOW,
        days: 7,
        payload: redactWindowPayload(data),
        redactedToken: { status: 'valid', minutesLeft: 58, rotated: false, hostKind: 'cn' },
        errors: [],
      };
    },
  };
  const ingest = createIngest({ db, adapter, now: () => NOW });
  await ingest.syncOnce({ days: 7 });
  return db;
}

test('buildSources works with the contract options object', async () => {
  const db = await seededDb();
  try {
    const sources = buildSources({ db, config: {}, nowMs: NOW });
    assert.equal(sources.length, 1);
    assert.equal(sources[0].id, 'huawei-cn');
  } finally {
    db.close();
  }
});

test('buildSources also works with a positional (db, config, nowMs) call', async () => {
  const db = await seededDb();
  try {
    const sources = buildSources(db, { sourceId: 'huawei-cn' }, NOW);
    assert.equal(sources.length, 1, 'a positional call must not silently return an empty list');
    assert.equal(sources[0].id, 'huawei-cn');
    assert.equal(sources[0].provider, 'huawei_cn_cloud');
    assert.equal(sources[0].kind, 'wearable-cloud');
    assert.equal(sources[0].ownerScope, 'owner-only');
    assert.equal(sources[0].enabled, true);
  } finally {
    db.close();
  }
});

test('source capabilities come from stored samples, not from promises', async () => {
  const db = await seededDb();
  try {
    const [source] = buildSources({ db, nowMs: NOW });
    assert.equal(source.capabilities.activity, 'supported');
    assert.equal(source.capabilities.sport, 'supported');
    assert.equal(source.capabilities.heart_rate, 'supported');
    assert.equal(source.capabilities.stress, 'supported');
    assert.equal(source.capabilities.spo2, 'supported');
    assert.equal(source.capabilities.device, 'supported');

    // This account has zero cloud sleep nights: that must read no_data + a
    // first-night note, never `supported`.
    assert.equal(source.capabilities.sleep.status, 'no_data');
    assert.equal(source.capabilities.sleep.stageFidelity, 'unknown');
    assert.equal(source.capabilities.sleep.availability, 'awaiting_first_night');
    assert.ok(source.notes.some(note => note.includes('awaiting_first_night')));

    assert.equal(typeof source.freshness.status, 'string');
    assert.equal(source.freshness.newestSampleAt, '2026-11-03T20:19:00+08:00');
    assert.equal(typeof source.lastErrorCode, 'string' === typeof source.lastErrorCode ? 'string' : 'object');
    assert.equal(source.auth.status, 'valid');
    assert.equal(source.auth.expiresAt, null, 'no snapshot means unknown, not a guessed instant');
  } finally {
    db.close();
  }
});

test('an empty store reports no_data and never "supported"', () => {
  const db = openHealthDb({ file: ':memory:' });
  try {
    const sources = buildSources({ db, nowMs: NOW });
    assert.equal(sources.length, 1, 'the source card exists before the first sync');
    assert.equal(sources[0].capabilities.activity, 'no_data');
    assert.equal(sources[0].capabilities.sport, 'no_data');
    assert.equal(sources[0].capabilities.heart_rate, 'no_data');
    assert.equal(sources[0].capabilities.sleep.status, 'no_data');
    assert.equal(sources[0].freshness.status, 'no_data');
    assert.equal(sources[0].freshness.newestSampleAt, null);
    assert.ok(sources[0].notes.length > 0);
  } finally {
    db.close();
  }
});

test('buildSources survives a missing db', () => {
  assert.deepEqual(buildSources({ db: null }), []);
  assert.deepEqual(buildSources({}), []);
});

test('today() reports the day and uses null for anything not measured', async () => {
  const db = await seededDb();
  try {
    const today = buildToday({ db, date: TODAY, nowMs: NOW });
    assert.equal(today.ok, true);
    assert.equal(today.date, TODAY);
    assert.equal(today.timezone, 'Asia/Shanghai');

    assert.equal(today.activity.steps, 1112);
    assert.equal(today.activity.distanceM, 864);
    assert.equal(today.activity.kcal, 53.1);
    assert.equal(today.activity.activeHours, 3);
    assert.equal(today.activity.exerciseMin, 1);
    assert.equal(today.activity.stepGoal, 10000);
    assert.equal(today.activity.observedAt, `${TODAY}T00:00:00+08:00`);
    assert.equal(today.activity.walkMin, undefined, 'the contract shape has no walkMin');

    assert.deepEqual(today.metrics.heartRate, { avg: 95, max: 112, min: 58, resting: 79 });
    assert.deepEqual(today.metrics.stress, { avg: 65, max: 69, min: 61, last: 65, measurements: 6 });
    assert.deepEqual(today.metrics.spo2, { avg: 97.1, max: 99, min: 95, last: 99 });
    assert.deepEqual(today.metrics.intensity, { moderateHighMinutes: 1 });

    assert.equal(today.realtime.heartRate.value, 95);
    assert.equal(today.realtime.heartRate.source, 'cloud-last-uploaded');
    assert.equal(today.realtime.heartRate.at, '2026-11-03T20:19:00+08:00');
    // 这一行原来断言 `null`：当时没有实时点时整条实时条就是空的。2026-11-04 实测发现，跨过
    // 午夜后上游 realtime 会整块为空（sidecar 只按"今天"取），于是三张实时卡每天 00:00 起全空。
    // 现在的规则：没有真实点时，用**当日聚合的最后一条**兜底，但必须 `at: null` + 自报来源，
    // 绝不伪装成瞬时读数。指标区（metrics）仍然只反映这一天自己测到的值。
    assert.equal(today.realtime.stress.value, 65);
    assert.equal(today.realtime.stress.source, 'day-last-uploaded', '没有实时点时必须自报来自日聚合');
    assert.equal(today.realtime.stress.at, null, '日聚合没有精确时刻，不许编');
    assert.equal(today.realtime.stress.dayLocalDate, TODAY);
    assert.equal(today.realtime.spo2.value, 99);
    assert.equal(today.realtime.spo2.source, 'day-last-uploaded');

    assert.equal(today.workouts.length, 1);
    assert.equal(today.workouts[0].sportTypeRaw, 2);
    assert.equal(today.workouts[0].sportTypeLabel, 'hill');
    assert.equal(today.workouts[0].sportTypeMapping, 'upstream_const');
    assert.equal(today.workouts[0].startAt, `${TODAY}T17:13:00+08:00`);

    assert.equal(today.sleep.availability, 'awaiting_first_night');
    assert.equal(today.sleep.session, null);

    assert.equal(today.freshness.status, 'delayed');
    assert.ok(today.freshness.ageMinutes >= 45);
  } finally {
    db.close();
  }
});

test('today() for an empty day reports null, not zeros', async () => {
  const db = await seededDb();
  try {
    const today = buildToday({ db, date: '2026-10-01', nowMs: NOW });
    assert.equal(today.ok, true);
    assert.equal(today.activity, null);
    assert.deepEqual(today.metrics, { heartRate: null, stress: null, spo2: null, intensity: null });
    assert.deepEqual(today.workouts, []);
    assert.equal(today.sleep.session, null);
  } finally {
    db.close();
  }
});

test('today() refuses an unusable handle without throwing', () => {
  const result = buildToday({ db: null });
  assert.deepEqual(
    { ok: result.ok, code: result.code },
    { ok: false, code: 'health-db-unavailable' },
  );
  assert.equal(typeof result.message, 'string');
});

test('trend() covers the whole window and marks uncovered days as null', async () => {
  const db = await seededDb();
  try {
    const steps = buildTrend({ db, metric: 'steps', days: 7, nowMs: NOW });
    assert.equal(steps.ok, true);
    assert.equal(steps.unit, '步');
    assert.equal(steps.supported, true);
    assert.equal(steps.points.length, 7);
    assert.equal(steps.points.at(-1).date, TODAY);
    assert.equal(steps.points.at(-1).value, 1112);
    assert.equal(steps.points[0].date, '2026-10-28');
    assert.equal(steps.points[0].value, null, 'a missing day is a gap, not a zero');
    assert.equal(steps.aggregate.count, 1);
    assert.equal(steps.aggregate.coveredDays, 1);
    assert.equal(steps.aggregate.missingDays, 6);
    assert.equal(steps.aggregate.min, 1112);
    assert.equal(steps.aggregate.max, 1112);

    // Ascending, one point per local date, no duplicates.
    const dates = steps.points.map(point => point.date);
    assert.deepEqual(dates, [...dates].sort());
    assert.equal(new Set(dates).size, dates.length);
  } finally {
    db.close();
  }
});

test('trend() units match the contract per metric', async () => {
  const db = await seededDb();
  try {
    const expected = {
      steps: '步',
      distance_m: 'm',
      kcal: 'kcal',
      heart_rate: 'bpm',
      resting_heart_rate: 'bpm',
      stress: '',
      spo2: '%',
      intensity: 'min',
    };
    for (const [metric, unit] of Object.entries(expected)) {
      const trend = buildTrend({ db, metric, days: 3, nowMs: NOW });
      assert.equal(trend.unit, unit, metric);
      assert.equal(trend.metric, metric);
    }
    assert.deepEqual(Object.keys(expected).sort(), [...TREND_METRIC_NAMES].sort());

    assert.equal(buildTrend({ db, metric: 'heart_rate', days: 3, nowMs: NOW }).points.at(-1).value, 95);
    assert.equal(buildTrend({ db, metric: 'resting_heart_rate', days: 3, nowMs: NOW }).points.at(-1).value, 79);
  } finally {
    db.close();
  }
});

test('trend() refuses a metric outside the whitelist', () => {
  const db = openHealthDb({ file: ':memory:' });
  try {
    for (const metric of ['sleep_score', 'rem', '', null, 'steps; DROP TABLE x']) {
      const result = buildTrend({ db, metric, days: 7, nowMs: NOW });
      assert.equal(result.ok, false);
      assert.equal(result.code, 'unsupported-metric');
      assert.equal(typeof result.message, 'string');
    }
  } finally {
    db.close();
  }
});

test('sleep() explains an empty panel in words', async () => {
  const db = await seededDb();
  try {
    const sleep = buildSleep({ db, days: 7, nowMs: NOW });
    assert.equal(sleep.ok, true);
    assert.equal(sleep.availability, 'awaiting_first_night');
    assert.equal(sleep.timezone, 'Asia/Shanghai');
    assert.deepEqual(sleep.range, { from: '2026-10-28', to: TODAY });
    assert.deepEqual(sleep.sessions, []);
    assert.deepEqual(sleep.trend, []);
    assert.ok(sleep.notes.length > 0);
    assert.ok(sleep.notes.some(note => note.includes('睡眠')));

    // No fabricated zero-minute night anywhere in the answer.
    assert.doesNotMatch(JSON.stringify(sleep), /"asleepMinutes":0/);
  } finally {
    db.close();
  }
});

test('sleep() lists sessions, keeps revisions current and can include stages', async () => {
  const db = await seededDb(payload({
    sleep_rows: [{
      date: TODAY,
      fall_asleep: '2026-11-02T23:40:00',
      wakeup: '2026-11-03T07:10:00',
      allSleepTime: 430,
      sleepScore: 82,
      stages: [
        { stage: 'light', start: '2026-11-02T23:40:00', end: '2026-11-03T02:00:00' },
        { stage: 'deep', start: '2026-11-03T02:00:00', end: '2026-11-03T04:00:00' },
      ],
    }],
  }));
  try {
    const sleep = buildSleep({ db, days: 7, nowMs: NOW, includeStages: true });
    assert.equal(sleep.availability, 'present');
    assert.equal(sleep.sessions.length, 1);
    const session = sleep.sessions[0];
    assert.equal(session.sleepDate, TODAY);
    assert.equal(session.asleepMinutes, 430);
    assert.equal(session.status, 'confirmed');
    assert.equal(session.stageFidelity, 'exact');
    assert.equal(session.isNap, false);
    assert.equal(session.startAt, '2026-11-02T23:40:00+08:00');
    assert.equal(session.stages.length, 2);
    assert.equal(session.stages[1].stage, 'deep');

    assert.equal(sleep.trend.length, 1);
    assert.equal(sleep.trend[0].quality, 'origin-confirmed');

    const withoutStages = buildSleep({ db, days: 7, nowMs: NOW });
    assert.equal(withoutStages.sessions[0].stages, null);
  } finally {
    db.close();
  }
});

test('newestSampleAt returns UTC ms so callers can mix it with their own clock', async () => {
  const db = await seededDb();
  try {
    const newest = newestSampleAt(db);
    assert.equal(newest, REALTIME_AT, 'the realtime point is the newest sample');
    assert.equal(typeof newest, 'number');
    assert.equal(newestSampleAt(null), null);
  } finally {
    db.close();
  }
});

test('the read layer never writes: a read leaves the store byte-identical', async () => {
  const db = await seededDb();
  try {
    const before = JSON.stringify(db.stats());
    buildToday({ db, date: TODAY, nowMs: NOW });
    buildTrend({ db, metric: 'steps', days: 7, nowMs: NOW });
    buildSleep({ db, days: 7, nowMs: NOW, includeStages: true });
    buildSources({ db, nowMs: NOW });
    newestSampleAt(db);
    assert.equal(JSON.stringify(db.stats()), before);
  } finally {
    db.close();
  }
});
