// 跨午夜后上游 `realtime{}` 整块变空时的**读投影兜底**。
//
// 现场（2026-11-04 00:56 实测）：sidecar 只按"今天"取 ByTime，新的一天还没有任何上传样本，
// 于是 `realtime: {}`，三张实时卡全空 —— 而 `health[2026-11-03]` 里的 `last*` 值一个不少。
//
// 它为什么在 `buildToday()` 而不是 `normalize()`：
//   ingest 会把 `at == null` 的实时点**跳过**（不编造 `sample_at` 入库），所以放在采集层等于
//   死代码；而"没有精确时刻"恰恰是投影层该解释的事。这里只要求：兜底必须自报出身。

import test from 'node:test';
import assert from 'node:assert/strict';
import { openHealthDb } from '../lib/db.mjs';
import { buildToday } from '../lib/summaries.mjs';

const TZ = 'Asia/Shanghai';
const DAY = '2026-11-03';

/** 一个当天有 health_day 聚合、但没有 realtime 点的库（就是跨午夜的真实形状）。 */
function dbWithDayAggregate({ points = [], healthDay = null } = {}) {
  const db = openHealthDb({ file: ':memory:' });
  db.migrate();
  if (healthDay) {
    db.run(
      `INSERT INTO health_daily_summaries
        (owner_scope, local_date, timezone_id, metric_kind, summary_json, origin_hash, updated_at)
       VALUES (?, ?, ?, 'health_day', ?, ?, ?)`,
      ['owner-only', DAY, TZ, JSON.stringify(healthDay), 'hash-day', Date.now()],
    );
  }
  for (const point of points) {
    db.run(
      `INSERT INTO health_observations
        (id, source_id, source_key, kind, granularity, sample_at, value, unit,
         observed_value_json, quality, fetched_at)
       VALUES (?, 'huawei-cn', ?, ?, 'point', ?, ?, ?, '{}', 'fresh', ?)`,
      [point.id, point.key ?? point.id, point.kind, point.at, point.value, point.unit ?? '', Date.now()],
    );
  }
  return db;
}

const HEALTH_DAY = {
  heartRate: { avg: 113, max: 113, min: 58, resting: 71 },
  stress: { avg: 67, max: 75, min: 61, last: 75, measurements: 10 },
  spo2: { avg: 97.4, max: 99, min: 95, last: 98 },
  intensity: { moderateHighMinutes: 1 },
};

test('没有实时点时用当日聚合兜底，且明说没有精确时刻', () => {
  const db = dbWithDayAggregate({ healthDay: HEALTH_DAY });
  const today = buildToday({ db, date: DAY, tz: TZ, nowMs: Date.parse('2026-11-04T00:56:00+08:00') });
  for (const [bucket, expected] of [['heartRate', 113], ['stress', 75], ['spo2', 98]]) {
    const sample = today.realtime[bucket];
    assert.ok(sample, `${bucket} 应该被兜底填上`);
    assert.equal(sample.value, expected);
    assert.equal(sample.source, 'day-last-uploaded', `${bucket} 必须自报来自日聚合`);
    assert.equal(sample.at, null, `${bucket} 不许编造时间戳`);
    assert.equal(sample.dayLocalDate, DAY, '要写清是哪一天的最后一条');
  }
  db.close();
});

test('有真实实时点时不覆盖，source 仍是 cloud-last-uploaded 且带时间', () => {
  const at = Date.parse('2026-11-03T20:19:00+08:00');
  const db = dbWithDayAggregate({
    healthDay: HEALTH_DAY,
    points: [{ id: 'p-hr', kind: 'heart_rate', at, value: 95, unit: 'bpm' }],
  });
  const today = buildToday({ db, date: DAY, tz: TZ, nowMs: Date.parse('2026-11-04T00:56:00+08:00') });
  assert.equal(today.realtime.heartRate.value, 95);
  assert.equal(today.realtime.heartRate.source, 'cloud-last-uploaded');
  assert.ok(today.realtime.heartRate.at, '真实点必须带时间');
  assert.equal(today.realtime.stress.source, 'day-last-uploaded', '没点的桶才兜底');
  db.close();
});

test('连当日聚合都没有时三个桶都是 null（不许编任何数）', () => {
  const db = dbWithDayAggregate({});
  const today = buildToday({ db, date: DAY, tz: TZ, nowMs: Date.parse('2026-11-04T00:56:00+08:00') });
  assert.equal(today.realtime.heartRate, null);
  assert.equal(today.realtime.stress, null);
  assert.equal(today.realtime.spo2, null);
  db.close();
});

test('聚合里缺某个指标时只补有的，缺的留 null', () => {
  const db = dbWithDayAggregate({
    healthDay: { heartRate: { avg: 113 }, stress: {}, spo2: {} },
  });
  const today = buildToday({ db, date: DAY, tz: TZ, nowMs: Date.parse('2026-11-04T00:56:00+08:00') });
  assert.equal(today.realtime.heartRate.value, 113);
  assert.equal(today.realtime.stress, null);
  assert.equal(today.realtime.spo2, null);
  db.close();
});

test('刚过午夜：请求今天（还没有聚合）时，实时条从最近一天借并注明日期；今日指标仍为 null', () => {
  const db = dbWithDayAggregate({ healthDay: HEALTH_DAY });
  const today = buildToday({ db, date: '2026-11-04', tz: TZ, nowMs: Date.parse('2026-11-04T00:56:00+08:00') });
  assert.equal(today.metrics.heartRate, null, '今天的指标不许拿昨天的数冒充');
  assert.equal(today.activity, null);
  assert.equal(today.realtime.heartRate.value, 113, '实时条可以借昨天的最后值');
  assert.equal(today.realtime.heartRate.source, 'day-last-uploaded');
  assert.equal(today.realtime.heartRate.dayLocalDate, DAY, '必须写清借的是哪一天');
  assert.equal(today.realtime.heartRate.at, null);
  db.close();
});
