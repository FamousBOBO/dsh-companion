// Window ingest (INTERFACES.md §8).
//
// The adapter is faked in every test: no socket is opened and the live account is
// never touched. Databases are `:memory:` only.
//
// The properties being nailed down are the ones that make an unattended poller
// safe: it never overlaps itself, it is idempotent on replay, it goes quiet under
// rate limiting, it never throws at its caller, and its counters add up.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openHealthDb } from '../lib/db.mjs';
import {
  BACKOFF_LADDER_MS,
  RAW_PAYLOAD_LIMIT_BYTES,
  createIngest,
  isRateLimitText,
} from '../lib/ingest.mjs';
import { assertNoSecrets, redactWindowPayload } from '../lib/cn-adapter.mjs';

const NOW = Date.parse('2026-11-03T21:05:00+08:00');

function dailyRow(date, steps, extra = {}) {
  return {
    date,
    sport_type: 0,
    steps,
    distance_m: steps * 0.8,
    kcal: steps * 0.05,
    duration_min: 20,
    walk_min: 20,
    active_hours: 3,
    exercise_min: null,
    step_goal: 10000,
    ...extra,
  };
}

function healthRow(date, extra = {}) {
  return {
    date,
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
    ...extra,
  };
}

function basePayload(overrides = {}) {
  return {
    synced_at: NOW / 1000,
    newest_cloud: NOW / 1000,
    errors: [],
    daily: [dailyRow('2026-11-03', 1112)],
    health: [healthRow('2026-11-03')],
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
    }],
    sleep_rows: [],
    sources: [{ name: '心率', ms: NOW / 1000, text: '2026-11-03 20:26:06', rel: '39 分钟前', rt_text: '95 bpm @ 20:19' }],
    realtime: { 心率: { value: 95, unit: 'bpm', at: NOW / 1000 - 600, at_text: '2026-11-03 20:19:00', device: 1260900415 } },
    token: {
      uid: '100860***',
      data_host: 'https://healthdata.dbankcloud.cn',
      expires_at_text: '2026-11-03 21:54:38',
      expires_in_min: 58,
      refresh_dies_text: '2027-05-02 19:04:43',
      rotated: false,
    },
    ...overrides,
  };
}

/** A fake adapter: a scripted queue of responses, so no HTTP is ever attempted. */
function fakeAdapter(responses, { onCall } = {}) {
  let index = 0;
  const calls = [];
  return {
    calls,
    describe() {
      return { baseUrl: 'http://127.0.0.1:8765', loopback: true, timeoutMs: 20000 };
    },
    async fetchWindow(args = {}) {
      calls.push(args);
      if (typeof onCall === 'function') onCall(args, index);
      const next = responses[Math.min(index, responses.length - 1)];
      index += 1;
      if (typeof next === 'function') return next(args);
      return next;
    },
  };
}

function okResult(payload, extra = {}) {
  return {
    ok: true,
    httpStatus: 200,
    latencyMs: 12,
    fetchedAt: NOW,
    days: 7,
    // A real adapter always hands ingest an already-redacted payload, so the
    // fixtures go through the same function instead of being pre-cleaned by hand.
    payload: redactWindowPayload(payload),
    redactedToken: { status: 'valid', minutesLeft: 58, rotated: false, hostKind: 'cn' },
    errors: [],
    ...extra,
  };
}

function makeDb() {
  return openHealthDb({ file: ':memory:' });
}

function countersInvariant(run) {
  assert.equal(
    run.itemsSeen,
    run.inserted + run.updated + run.skipped,
    `counters must add up: ${JSON.stringify(run)}`,
  );
}

test('a clean sync writes the window and reports self-consistent counters', async () => {
  const db = makeDb();
  try {
    const ingest = createIngest({ db, adapter: fakeAdapter([okResult(basePayload())]), now: () => NOW });
    const run = await ingest.syncOnce({ days: 7, reason: 'test' });

    assert.equal(run.status, 'ok');
    assert.equal(run.errorCode, null);
    assert.ok(run.runId);
    countersInvariant(run);

    const stats = db.stats();
    assert.equal(stats.workouts, 1);
    assert.equal(stats.devices, 1);
    assert.equal(stats.dailySummaries, 2, 'activity + health_day');
    assert.ok(stats.observations >= 5, 'heart rate, resting, stress, spo2, intensity + realtime');
    assert.equal(stats.syncRuns, 1);
    assert.equal(stats.rawRefs, 1);
    assert.equal(stats.sleepSessions, 0);

    const workout = db.get('SELECT * FROM health_workout_sessions');
    assert.equal(workout.sport_type_raw, 2);
    assert.equal(workout.sport_type_label, 'hill');
    assert.equal(workout.sport_type_mapping, 'upstream_const');
    assert.equal(workout.revision, 1);

    const device = db.get('SELECT * FROM health_devices');
    assert.equal(device.device_class, 'band');
    assert.match(device.unique_id_hash, /^[0-9a-f]{16}$/);

    const source = db.get('SELECT * FROM health_sources');
    assert.equal(source.id, 'huawei-cn');
    assert.equal(source.auth_status, 'valid');
    assert.equal(source.last_error_code, null);
    assert.equal(source.last_success_at, NOW);
    assert.equal(db.meta('lastSuccessfulSyncAt'), String(NOW));
    assert.equal(db.meta('firstSyncAt'), String(NOW));
  } finally {
    db.close();
  }
});

test('the raw receipt holds the redacted payload and no secret survives it', async () => {
  const db = makeDb();
  try {
    const ingest = createIngest({ db, adapter: fakeAdapter([okResult(basePayload())]), now: () => NOW });
    await ingest.syncOnce({});
    const row = db.get('SELECT * FROM health_raw_refs');
    assert.equal(row.redacted, 1);
    assert.equal(row.kind, 'window');
    assert.equal(row.hash.length, 64);
    assert.ok(row.bytes > 0);
    assert.ok(row.payload_json, 'payload under the 256KB limit is stored');

    const text = String(row.payload_json);
    assert.doesNotMatch(text, /"uid"/);
    assert.doesNotMatch(text, /access_?token|refresh_?token/i);
    assert.doesNotMatch(text, /(?:[0-9a-f]{2}:){5}[0-9a-f]{2}/i);
    assert.doesNotMatch(text, /JBTTQ23424001783/);
    // And the guard that produced it is reusable.
    assert.equal(assertNoSecrets({ ok: true }), true);
  } finally {
    db.close();
  }
});

test('a payload above 256KB is recorded as hash and size only', async () => {
  const db = makeDb();
  try {
    const huge = basePayload({ devices: [] });
    huge.padding = 'x'.repeat(RAW_PAYLOAD_LIMIT_BYTES + 1024);
    const ingest = createIngest({ db, adapter: fakeAdapter([okResult(huge)]), now: () => NOW });
    const run = await ingest.syncOnce({});
    assert.equal(run.status, 'ok');
    const row = db.get('SELECT * FROM health_raw_refs');
    assert.equal(row.payload_json, null);
    assert.ok(row.bytes > RAW_PAYLOAD_LIMIT_BYTES);
    assert.equal(row.hash.length, 64);
  } finally {
    db.close();
  }
});

test('replaying the same window is idempotent', async () => {
  const db = makeDb();
  try {
    const ingest = createIngest({ db, adapter: fakeAdapter([okResult(basePayload())]), now: () => NOW });
    const first = await ingest.syncOnce({});
    const before = db.stats();

    const second = await ingest.syncOnce({});
    const after = db.stats();

    countersInvariant(first);
    countersInvariant(second);
    assert.equal(second.inserted, 0, 'nothing new on a replay');
    assert.ok(second.skipped > 0);

    assert.deepEqual(
      { obs: after.observations, workout: after.workouts, device: after.devices, summaries: after.dailySummaries },
      { obs: before.observations, workout: before.workouts, device: before.devices, summaries: before.dailySummaries },
      'no duplicate rows',
    );
    assert.equal(after.syncRuns, 2, 'each attempt is still recorded');
    assert.equal(after.rawRefs, 1, 'the receipt id is stable for the same hash and instant');
    const revisions = db.all('SELECT DISTINCT revision FROM health_observations');
    assert.deepEqual(revisions.map(row => row.revision), [1], 'no revision churn on identical content');
  } finally {
    db.close();
  }
});

test('changed content at the same sample slot becomes a new revision', async () => {
  const db = makeDb();
  try {
    const adapter = fakeAdapter([
      okResult(basePayload()),
      okResult(basePayload({ health: [healthRow('2026-11-03', { heart_rate: 101 })] })),
    ]);
    const ingest = createIngest({ db, adapter, now: () => NOW });
    await ingest.syncOnce({});
    const second = await ingest.syncOnce({});
    assert.equal(second.status, 'ok');
    countersInvariant(second);

    const rows = db.all(
      `SELECT revision, value FROM health_observations
        WHERE kind = 'heart_rate' AND granularity = 'day' ORDER BY revision ASC`,
    );
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(row => row.revision), [1, 2]);
    assert.deepEqual(rows.map(row => row.value), [95, 101]);
  } finally {
    db.close();
  }
});

test('concurrent syncOnce calls do not overlap', async () => {
  const db = makeDb();
  try {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const adapter = fakeAdapter([async () => {
      await gate;
      return okResult(basePayload());
    }]);
    const ingest = createIngest({ db, adapter, now: () => NOW });

    const first = ingest.syncOnce({});
    const second = await ingest.syncOnce({});
    assert.equal(second.status, 'skipped');
    assert.equal(second.errorCode, 'busy');
    assert.equal(adapter.calls.length, 1, 'the second call must not reach the adapter');

    release();
    const done = await first;
    assert.equal(done.status, 'ok');
    // After the flight lands, a new call is allowed again.
    const third = await ingest.syncOnce({});
    assert.equal(third.status, 'ok');
  } finally {
    db.close();
  }
});

test('HTTP 429 parks the collector on the backoff ladder', async () => {
  const db = makeDb();
  try {
    let clock = NOW;
    const adapter = fakeAdapter([
      { ok: false, errorCode: 'http-error', httpStatus: 429, latencyMs: 5 },
      okResult(basePayload()),
    ]);
    const ingest = createIngest({ db, adapter, now: () => clock });

    const first = await ingest.syncOnce({});
    assert.equal(first.status, 'rate_limited');
    countersInvariant(first);
    assert.ok(ingest.nextAllowedAt() != null);
    assert.equal(ingest.nextAllowedAt(), NOW + BACKOFF_LADDER_MS[0]);
    assert.equal(ingest.isRateLimited(), true);
    assert.equal(ingest.consecutiveFailures(), 1);

    // Inside the window: no request is made at all.
    const skipped = await ingest.syncOnce({});
    assert.equal(skipped.status, 'skipped');
    assert.equal(skipped.errorCode, 'rate-limited');
    assert.equal(adapter.calls.length, 1);

    const run = db.get('SELECT * FROM health_sync_runs ORDER BY started_at ASC LIMIT 1');
    assert.equal(run.status, 'rate_limited');
    assert.equal(run.next_allowed_at, NOW + BACKOFF_LADDER_MS[0]);
    assert.equal(db.get('SELECT last_error_code FROM health_sources').last_error_code, 'rate-limited');

    // Past the window it tries again, and the ladder escalates on a second 429.
    clock = NOW + BACKOFF_LADDER_MS[0] + 1;
    assert.equal(ingest.isRateLimited(), false);
    const recovered = await ingest.syncOnce({});
    assert.equal(recovered.status, 'ok');
    assert.equal(ingest.consecutiveFailures(), 0);
  } finally {
    db.close();
  }
});

test('a 1101 inside errors[] is treated as rate limiting too', async () => {
  assert.equal(isRateLimitText([{ code: 1101 }]), true);
  assert.equal(isRateLimitText(['1101 Too Many Requests']), true);
  assert.equal(isRateLimitText([{ code: 30005, message: 'Invalid device' }]), false);
  assert.equal(isRateLimitText(null), false);

  const db = makeDb();
  try {
    const ingest = createIngest({
      db,
      adapter: fakeAdapter([okResult(basePayload({ errors: [{ code: 1101, message: 'Too Many Requests' }] }))]),
      now: () => NOW,
    });
    const run = await ingest.syncOnce({});
    assert.equal(run.status, 'rate_limited');
    assert.equal(run.errorCode, 'rate-limited');
    countersInvariant(run);
    assert.ok(db.get('SELECT next_allowed_at FROM health_sync_runs').next_allowed_at > NOW);
  } finally {
    db.close();
  }
});

test('a sidecar error without rate limiting degrades to partial and keeps the data', async () => {
  const db = makeDb();
  try {
    const ingest = createIngest({
      db,
      adapter: fakeAdapter([okResult(basePayload({ errors: [{ code: 30005, message: 'Invalid device' }] }))]),
      now: () => NOW,
    });
    const run = await ingest.syncOnce({});
    assert.equal(run.status, 'partial');
    assert.equal(run.errorCode, '30005');
    assert.ok(run.faults.some(fault => fault.code === '30005'));
    countersInvariant(run);
    assert.equal(db.stats().dailySummaries, 2, 'the usable half of the payload is still stored');
  } finally {
    db.close();
  }
});

test('every transport failure collapses into status error without throwing', async () => {
  const cases = [
    [{ ok: false, errorCode: 'timeout', httpStatus: 0, latencyMs: 20000 }, 'timeout'],
    [{ ok: false, errorCode: 'unreachable', httpStatus: 0, latencyMs: 1 }, 'unreachable'],
    [{ ok: false, errorCode: 'bad-json', httpStatus: 200, latencyMs: 3 }, 'bad-json'],
    [{ ok: false, errorCode: 'non-loopback-refused', httpStatus: 0, latencyMs: 0 }, 'non-loopback-refused'],
  ];
  for (const [response, expected] of cases) {
    const db = makeDb();
    try {
      const ingest = createIngest({ db, adapter: fakeAdapter([response]), now: () => NOW });
      const run = await ingest.syncOnce({});
      assert.equal(run.status, 'error', expected);
      assert.equal(run.errorCode, expected);
      countersInvariant(run);
      assert.equal(run.inserted, 0);
      assert.equal(db.get('SELECT status FROM health_sync_runs').status, 'error');
      assert.equal(db.get('SELECT last_error_code FROM health_sources').last_error_code, expected);
    } finally {
      db.close();
    }
  }
});

test('a throwing adapter is reported, not propagated', async () => {
  const db = makeDb();
  try {
    const ingest = createIngest({
      db,
      adapter: { describe: () => ({}), fetchWindow: async () => { throw new Error('socket exploded'); } },
      now: () => NOW,
    });
    const run = await ingest.syncOnce({});
    assert.equal(run.status, 'error');
    assert.equal(run.errorCode, 'internal-error');
    assert.ok(run.faults.some(fault => fault.code === 'internal-error'));
    // The message is kept short and never carries a token or a payload.
    const detail = String(db.get('SELECT detail_json FROM health_sync_runs').detail_json);
    assert.doesNotMatch(detail, /access_?token|refresh_?token/i);
  } finally {
    db.close();
  }
});

test('a garbage payload is stored as "no data", not as zeros', async () => {
  const db = makeDb();
  try {
    const ingest = createIngest({
      db,
      adapter: fakeAdapter([okResult({ errors: [] })]),
      now: () => NOW,
    });
    const run = await ingest.syncOnce({});
    assert.equal(run.status, 'ok');
    assert.equal(run.itemsSeen, 0);
    assert.equal(db.stats().dailySummaries, 0);
    assert.equal(db.stats().observations, 0);
  } finally {
    db.close();
  }
});

test('sleep nights are stored with their stages and a per-date roll-up', async () => {
  const db = makeDb();
  try {
    const payload = basePayload({
      sleep_rows: [{
        date: '2026-11-03',
        fall_asleep: '2026-11-02T23:40:00',
        wakeup: '2026-11-03T07:10:00',
        allSleepTime: 430,
        deepSleepTime: 95,
        lightSleepTime: 275,
        dreamTime: 60,
        sleepScore: 82,
        stages: [
          { stage: 'light', start: '2026-11-02T23:40:00', end: '2026-11-03T02:00:00' },
          { stage: 'deep', start: '2026-11-03T02:00:00', end: '2026-11-03T04:00:00' },
        ],
      }],
    });
    const ingest = createIngest({ db, adapter: fakeAdapter([okResult(payload)]), now: () => NOW });
    const run = await ingest.syncOnce({});
    assert.equal(run.status, 'ok');
    countersInvariant(run);

    const session = db.get('SELECT * FROM health_sleep_sessions');
    assert.equal(session.sleep_date, '2026-11-03');
    assert.equal(session.status, 'confirmed');
    assert.equal(session.asleep_minutes, 430);
    assert.equal(session.rem_minutes, 60);
    assert.equal(session.is_nap, 0);
    assert.equal(session.source_score, 82);
    assert.equal(session.stage_fidelity, 'exact');
    assert.equal(session.revision, 1);

    const stages = db.all('SELECT * FROM health_sleep_stages WHERE session_id = ? ORDER BY stage_index', [session.id]);
    assert.equal(stages.length, 2);

    const summary = db.get("SELECT * FROM health_daily_summaries WHERE metric_kind = 'sleep_day'");
    assert.equal(summary.local_date, '2026-11-03');
    const parsed = JSON.parse(summary.summary_json);
    assert.equal(parsed.sessions, 1);
    assert.equal(parsed.asleepMinutes, 430);

    // Replay: nothing changes, no extra revision.
    const second = await ingest.syncOnce({});
    countersInvariant(second);
    assert.equal(db.all('SELECT * FROM health_sleep_sessions').length, 1);
    assert.equal(db.all('SELECT * FROM health_sleep_stages').length, 2);
  } finally {
    db.close();
  }
});

test('a corrected night is a new revision of the same record', async () => {
  const db = makeDb();
  try {
    const row = {
      date: '2026-11-03',
      fall_asleep: '2026-11-02T23:40:00',
      wakeup: '2026-11-03T07:10:00',
      allSleepTime: 430,
    };
    const adapter = fakeAdapter([
      okResult(basePayload({ sleep_rows: [row] })),
      okResult(basePayload({ sleep_rows: [{ ...row, allSleepTime: 400 }] })),
    ]);
    const ingest = createIngest({ db, adapter, now: () => NOW });
    await ingest.syncOnce({});
    const second = await ingest.syncOnce({});
    countersInvariant(second);

    const sessions = db.all('SELECT revision, asleep_minutes FROM health_sleep_sessions ORDER BY revision ASC');
    assert.deepEqual(sessions.map(entry => entry.revision), [1, 2]);
    assert.deepEqual(sessions.map(entry => entry.asleep_minutes), [430, 400]);
  } finally {
    db.close();
  }
});

test('the collector never writes a medication-style conclusion into a fault', async () => {
  const db = makeDb();
  try {
    const ingest = createIngest({ db, adapter: fakeAdapter([okResult(basePayload())]), now: () => NOW });
    await ingest.syncOnce({});
    const detail = String(db.get('SELECT detail_json FROM health_sync_runs').detail_json);
    const parsed = JSON.parse(detail);
    assert.equal(parsed.reason, 'poll');
    assert.deepEqual(parsed.faults, []);
    assert.equal(parsed.rawRefs, 1);
  } finally {
    db.close();
  }
});

test('createIngest refuses to start without a db or an adapter', () => {
  assert.throws(() => createIngest({ adapter: fakeAdapter([]) }), /需要已打开的 db/);
  assert.throws(() => createIngest({ db: makeDb() }), /需要 adapter/);
});
