// Read-only projections for the studio, the foundation tools and check-health
// (INTERFACES.md §9 + §11). Nothing in this file writes, polls or awaits — a GET
// route must never touch the network, so these are plain synchronous queries.
//
// Two shapes matter and are easy to get subtly wrong:
//
//   * timestamps leave as `+08:00` ISO strings (null when unknown) — the whole
//     read API is consistent about that, while storage stays UTC ms;
//   * a day with no sample reports `value: null`, **never 0**, and `missingDays`
//     counts it. Turning a gap into a zero-reading would invent health data.

import {
  TZ,
  addLocalDays,
  freshnessOf,
  isLocalDate,
  localDateOf,
  localIsoOf,
  localMidnightMs,
  parseObservationValue,
} from './normalize.mjs';
import { classifyAvailability } from './sleep.mjs';

export { parseObservationValue };

const DEFAULT_OWNER_SCOPE = 'owner-only';

/** metric -> unit. This whitelist is the contract (§11.4); anything else is refused. */
const TREND_METRICS = Object.freeze({
  steps: { unit: '步', source: 'activity', field: 'steps' },
  distance_m: { unit: 'm', source: 'activity', field: 'distanceM' },
  kcal: { unit: 'kcal', source: 'activity', field: 'kcal' },
  heart_rate: { unit: 'bpm', source: 'health_day', field: ['heartRate', 'avg'] },
  resting_heart_rate: { unit: 'bpm', source: 'health_day', field: ['heartRate', 'resting'] },
  stress: { unit: '', source: 'health_day', field: ['stress', 'avg'] },
  spo2: { unit: '%', source: 'health_day', field: ['spo2', 'avg'] },
  intensity: { unit: 'min', source: 'health_day', field: ['intensity', 'moderateHighMinutes'] },
});

export const TREND_METRIC_NAMES = Object.freeze(Object.keys(TREND_METRICS));

/** All `ok:false` answers share this shape; an exception message is never one of them. */
function fail(code, message) {
  return { ok: false, code, message };
}

function dbUsable(db) {
  return Boolean(db) && typeof db.get === 'function' && typeof db.all === 'function';
}

/**
 * Accept **both** call shapes.
 *
 * The contract (§9) specifies a single options object, and that is what callers
 * should use. One in-tree caller passes `(db, config, nowMs)` positionally
 * instead, and a silently-empty result is a terrible way to discover that — so a
 * first argument that *is* a db handle is recognised and the remaining positional
 * arguments are mapped back onto the named fields for that function.
 */
function optionsFrom(args, positionalKeys = []) {
  const [first] = args;
  if (dbUsable(first)) {
    const out = { db: first };
    positionalKeys.forEach((key, index) => {
      if (args[index + 1] !== undefined) out[key] = args[index + 1];
    });
    return out;
  }
  return first && typeof first === 'object' ? first : {};
}

function scopeOf(db, ownerScope) {
  if (typeof ownerScope === 'string' && ownerScope.trim()) return ownerScope.trim();
  try {
    const row = db.get('SELECT owner_scope FROM health_sources LIMIT 1');
    if (row && typeof row.owner_scope === 'string' && row.owner_scope.trim()) return row.owner_scope.trim();
  } catch {
    // fall through to the default contract scope
  }
  return DEFAULT_OWNER_SCOPE;
}

function isoOrNull(ms, tz = TZ) {
  if (ms == null || !Number.isFinite(Number(ms))) return null;
  return localIsoOf(Number(ms), tz);
}

function numOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function hasAny(object) {
  if (!object || typeof object !== 'object') return false;
  return Object.values(object).some(value => value !== null && value !== undefined);
}

function readSummary(db, scope, localDate, tz, metricKind) {
  try {
    const row = db.get(
      `SELECT summary_json FROM health_daily_summaries
        WHERE owner_scope = ? AND local_date = ? AND timezone_id = ? AND metric_kind = ?`,
      [scope, localDate, tz, metricKind],
    );
    if (!row) return null;
    const parsed = JSON.parse(String(row.summary_json ?? '{}'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The most recent date that actually has a daily summary (activity or health_day) on or before
 * `localDate`.
 *
 * Right after midnight "today" legitimately has nothing yet (the band has not uploaded a new day),
 * and a UI that only ever asks for today shows four empty cards for hours. Telling the UI which
 * day **does** have data lets it offer that day explicitly — with its date printed on screen —
 * instead of either showing blanks or silently pretending yesterday is today.
 */
function latestDataDate(db, scope, localDate, tz) {
  try {
    const row = db.get(
      `SELECT MAX(local_date) AS d FROM health_daily_summaries
        WHERE owner_scope = ? AND timezone_id = ? AND local_date <= ?
          AND metric_kind IN ('activity', 'health_day')`,
      [scope, tz, localDate],
    );
    const value = row && row.d ? String(row.d) : null;
    return value && value.length === 10 ? value : null;
  } catch {
    return null;
  }
}

/**
 * The most recent `health_day` summary **on or before** `localDate`.
 *
 * Needed by the realtime projection: right after midnight the requested day has no summary yet,
 * while yesterday's still holds the last uploaded values. Cards for the day itself stay `null`
 * (we never show yesterday's numbers as today's), but the "最新已上传" strip may borrow them —
 * and it says which day it borrowed from.
 */
function latestHealthDayBefore(db, scope, localDate, tz) {
  try {
    const row = db.get(
      `SELECT local_date, summary_json FROM health_daily_summaries
        WHERE owner_scope = ? AND timezone_id = ? AND metric_kind = 'health_day' AND local_date <= ?
        ORDER BY local_date DESC LIMIT 1`,
      [scope, tz, localDate],
    );
    if (!row) return null;
    const parsed = JSON.parse(String(row.summary_json ?? '{}'));
    if (!parsed || typeof parsed !== 'object') return null;
    return { localDate: String(row.local_date), health: parsed };
  } catch {
    return null;
  }
}

/**
 * Newest sample we hold, as UTC ms.
 *
 * Returned as a number (not an ISO string) because callers mix it with their own
 * clocks; convert with `localIsoOf(ms)` for display. `null` means "nothing yet",
 * which the UI must show as `no_data` rather than as an empty chart.
 */
export function newestSampleAt(db, tz = TZ) {
  if (!dbUsable(db)) return null;
  let newest = null;
  const consider = value => {
    const parsed = numOrNull(value);
    if (parsed != null && (newest == null || parsed > newest)) newest = parsed;
  };
  try {
    consider(db.get('SELECT MAX(sample_at) AS at FROM health_observations')?.at);
    consider(db.get('SELECT MAX(end_at) AS at FROM health_workout_sessions')?.at);
    consider(db.get('SELECT MAX(end_at) AS at FROM health_sleep_sessions')?.at);
    consider(db.get('SELECT MAX(source_updated_at) AS at FROM health_devices')?.at);
  } catch {
    return null;
  }
  return newest == null ? null : newest;
}

function freshnessBlock(db, nowMs, tz) {
  const newest = newestSampleAt(db, tz);
  return {
    status: freshnessOf(newest, nowMs),
    newestSampleAt: isoOrNull(newest, tz),
    ageMinutes: newest == null ? null : Math.max(0, Math.round((nowMs - newest) / 60000)),
  };
}

/** Latest realtime point of one kind, as the pre-chewed shape the UI shows. */
function latestPoint(db, kind, tz) {
  try {
    const row = db.get(
      `SELECT value, unit, sample_at FROM health_observations
        WHERE kind = ? AND granularity = 'point'
        ORDER BY sample_at DESC, revision DESC LIMIT 1`,
      [kind],
    );
    if (!row || numOrNull(row.sample_at) == null) return null;
    return {
      value: numOrNull(row.value),
      unit: String(row.unit ?? ''),
      at: isoOrNull(Number(row.sample_at), tz),
      source: 'cloud-last-uploaded',
    };
  } catch {
    return null;
  }
}

/**
 * Day-aggregate stand-in for a realtime bucket.
 *
 * The frozen sidecar queries its "newest uploaded sample" block for **today only**, so between
 * 00:00 and the first upload of the new day `realtime{}` is empty even though yesterday's
 * `health[]` row still carries `lastHeartRate` / `lastScore` / `lastSaturation`
 * (measured 2026-11-04 00:56: `realtime: {}`, `health[2026-11-03]` complete → three realtime
 * cards went blank every midnight).
 *
 * It is projected here, at read time, on purpose: the value has **no known instant**, and the
 * storage layer (`ingest`) must never persist a point with an invented `sample_at`. So this
 * entry carries `at: null` plus an explicit `source`, and a genuine realtime point always wins.
 */
function dayAggregatePoint(health, bucket, localDate) {
  if (!health || typeof health !== 'object') return null;
  const pick = {
    heartRate: { value: health.heartRate?.avg, unit: 'bpm' },
    stress: { value: health.stress?.last ?? health.stress?.avg, unit: '' },
    spo2: { value: health.spo2?.last ?? health.spo2?.avg, unit: '%' },
  }[bucket];
  const value = numOrNull(pick?.value);
  if (value === null) return null;
  return { value, unit: pick.unit, at: null, source: 'day-last-uploaded', dayLocalDate: localDate };
}

/**
 * Latest revision of every sleep session in a date range.
 *
 * A corrected night is a new row with a higher revision, so a naive read would
 * show the same night twice. The correlated MAX picks the winner per record key.
 */
function latestSleepSessions(db, from, to) {
  try {
    return db.all(
      `SELECT s.* FROM health_sleep_sessions AS s
        WHERE s.sleep_date >= ? AND s.sleep_date <= ?
          AND s.revision = (SELECT MAX(x.revision) FROM health_sleep_sessions AS x
                             WHERE x.source_id = s.source_id
                               AND x.source_record_key = s.source_record_key)
        ORDER BY s.sleep_date ASC, COALESCE(s.start_at, 0) ASC, s.id ASC`,
      [from, to],
    );
  } catch {
    return [];
  }
}

function stagesFor(db, sessionId) {
  try {
    return db.all(
      `SELECT stage, start_at, end_at, fidelity FROM health_sleep_stages
        WHERE session_id = ? ORDER BY stage_index ASC`,
      [sessionId],
    );
  } catch {
    return [];
  }
}

/**
 * One day: activity totals, health metrics, the last uploaded realtime reading,
 * the workouts that started that day, and whether a sleep night exists at all.
 */
export function buildToday(...args) {
  const { db, date, tz = TZ, nowMs = Date.now(), ownerScope } = optionsFrom(args, ['date']);
  if (!dbUsable(db)) return fail('health-db-unavailable', '健康数据库尚未就绪');
  const scope = scopeOf(db, ownerScope);
  const localDate = isLocalDate(date) ? String(date).trim() : localDateOf(nowMs, tz);
  if (localDate == null) return fail('bad-date', '日期格式不正确');

  const dayStart = localMidnightMs(localDate, tz);
  const nextDate = addLocalDays(localDate, 1);
  const dayEnd = nextDate == null ? null : localMidnightMs(nextDate, tz);

  const activitySummary = readSummary(db, scope, localDate, tz, 'activity');
  const activity = activitySummary
    ? {
      steps: numOrNull(activitySummary.steps),
      distanceM: numOrNull(activitySummary.distanceM),
      kcal: numOrNull(activitySummary.kcal),
      activeHours: numOrNull(activitySummary.activeHours),
      exerciseMin: numOrNull(activitySummary.exerciseMin),
      stepGoal: numOrNull(activitySummary.stepGoal),
      quality: activitySummary.quality ?? 'no_data',
      observedAt: isoOrNull(activitySummary.observedAt, tz),
    }
    : null;

  const health = readSummary(db, scope, localDate, tz, 'health_day');
  const metrics = {
    heartRate: health && hasAny(health.heartRate) ? {
      avg: numOrNull(health.heartRate.avg),
      max: numOrNull(health.heartRate.max),
      min: numOrNull(health.heartRate.min),
      resting: numOrNull(health.heartRate.resting),
    } : null,
    stress: health && hasAny(health.stress) ? {
      avg: numOrNull(health.stress.avg),
      max: numOrNull(health.stress.max),
      min: numOrNull(health.stress.min),
      last: numOrNull(health.stress.last),
      measurements: numOrNull(health.stress.measurements),
    } : null,
    spo2: health && hasAny(health.spo2) ? {
      avg: numOrNull(health.spo2.avg),
      max: numOrNull(health.spo2.max),
      min: numOrNull(health.spo2.min),
      last: numOrNull(health.spo2.last),
    } : null,
    intensity: health && health.intensity && health.intensity.moderateHighMinutes != null
      ? { moderateHighMinutes: numOrNull(health.intensity.moderateHighMinutes) }
      : null,
  };

  const workouts = (dayStart != null && dayEnd != null
    ? (() => {
      try {
        return db.all(
          `SELECT sport_type_raw, sport_type_label, sport_type_mapping, start_at, end_at,
                  duration_min, steps, distance_m, kcal, quality
             FROM health_workout_sessions
            WHERE start_at >= ? AND start_at < ?
            ORDER BY start_at ASC, revision DESC`,
          [dayStart, dayEnd],
        );
      } catch {
        return [];
      }
    })()
    : []).map(row => ({
    sportTypeRaw: numOrNull(row.sport_type_raw),
    sportTypeLabel: row.sport_type_label ?? null,
    sportTypeMapping: row.sport_type_mapping ?? 'unknown',
    startAt: isoOrNull(row.start_at, tz),
    endAt: isoOrNull(row.end_at, tz),
    durationMin: numOrNull(row.duration_min),
    steps: numOrNull(row.steps),
    distanceM: numOrNull(row.distance_m),
    kcal: numOrNull(row.kcal),
    quality: row.quality ?? 'no_data',
  }));

  const nightRows = latestSleepSessions(db, localDate, localDate);
  const newestNight = nightRows.reduce(
    (best, row) => (row.end_at != null && (best == null || Number(row.end_at) > best) ? Number(row.end_at) : best),
    null,
  );
  const sleepAvailability = classifyAvailability({
    sessionCount: nightRows.length,
    newestEndAt: newestNight,
    nowMs,
  });
  const mainNight = nightRows.find(row => Number(row.is_nap ?? 0) === 0) ?? nightRows[0] ?? null;

  // 当日没有 health_day 时（跨过午夜的第一小时）从最近一天借"最后上传值"，只用于实时条。
  let realtimeDayHealth = health;
  let realtimeDayDate = localDate;
  if (!realtimeDayHealth) {
    const previous = latestHealthDayBefore(db, scope, localDate, tz);
    if (previous) { realtimeDayHealth = previous.health; realtimeDayDate = previous.localDate; }
  }

  return {
    ok: true,
    date: localDate,
    timezone: tz,
    // 让前端能诚实地处理"今天还没有数据"：这一天自己有没有读数、以及最近有数据的是哪天。
    hasTodayData: Boolean(activity) || Object.values(metrics).some(value => value !== null && value !== undefined),
    latestDataDate: latestDataDate(db, scope, localDate, tz),
    activity,
    metrics,
    realtime: {
      heartRate: latestPoint(db, 'heart_rate', tz) ?? dayAggregatePoint(realtimeDayHealth, 'heartRate', realtimeDayDate),
      stress: latestPoint(db, 'stress', tz) ?? dayAggregatePoint(realtimeDayHealth, 'stress', realtimeDayDate),
      spo2: latestPoint(db, 'spo2', tz) ?? dayAggregatePoint(realtimeDayHealth, 'spo2', realtimeDayDate),
    },
    workouts,
    sleep: {
      availability: sleepAvailability,
      session: mainNight ? {
        sleepDate: mainNight.sleep_date,
        startAt: isoOrNull(mainNight.start_at, tz),
        endAt: isoOrNull(mainNight.end_at, tz),
        asleepMinutes: numOrNull(mainNight.asleep_minutes),
        awakeMinutes: numOrNull(mainNight.awake_minutes),
        stageFidelity: mainNight.stage_fidelity ?? 'unknown',
        status: mainNight.status ?? 'provisional',
        sourceScore: numOrNull(mainNight.source_score),
      } : null,
    },
    freshness: freshnessBlock(db, nowMs, tz),
  };
}

function trendValueOf(summary, definition) {
  if (!summary) return null;
  const field = definition.field;
  if (Array.isArray(field)) {
    const bucket = summary[field[0]];
    if (!bucket || typeof bucket !== 'object') return null;
    return numOrNull(bucket[field[1]]);
  }
  return numOrNull(summary[field]);
}

/**
 * `days` points, oldest first, one per local date. A date without a sample is a
 * `null` value — a gap, not a zero.
 */
export function buildTrend(...args) {
  const { db, metric, days = 7, tz = TZ, nowMs = Date.now(), ownerScope } = optionsFrom(args, ['metric', 'days']);
  if (!dbUsable(db)) return fail('health-db-unavailable', '健康数据库尚未就绪');
  if (!Object.hasOwn(TREND_METRICS, String(metric ?? ''))) {
    return fail('unsupported-metric', '不支持的趋势指标');
  }
  const definition = TREND_METRICS[metric];
  const scope = scopeOf(db, ownerScope);
  const span = Math.min(30, Math.max(1, Math.trunc(Number(days) || 7)));
  const to = localDateOf(nowMs, tz);
  if (to == null) return fail('bad-date', '日期格式不正确');

  const points = [];
  for (let offset = span - 1; offset >= 0; offset -= 1) {
    const date = addLocalDays(to, -offset);
    if (date == null) continue;
    const summary = readSummary(db, scope, date, tz, definition.source);
    const value = trendValueOf(summary, definition);
    points.push({
      date,
      value,
      quality: summary?.quality ?? (value == null ? 'no_data' : 'fresh'),
      observedAt: isoOrNull(summary?.observedAt, tz),
    });
  }

  const values = points.map(point => point.value).filter(value => value != null);
  const coveredDays = values.length;
  const mean = coveredDays ? values.reduce((total, value) => total + value, 0) / coveredDays : null;

  return {
    ok: true,
    metric,
    days: span,
    unit: definition.unit,
    supported: true,
    points,
    aggregate: {
      count: coveredDays,
      mean: mean == null ? null : Math.round(mean * 100) / 100,
      min: coveredDays ? Math.min(...values) : null,
      max: coveredDays ? Math.max(...values) : null,
      coveredDays,
      missingDays: span - coveredDays,
    },
  };
}

/**
 * Sleep sessions in a window, plus the sentence explaining an empty panel.
 *
 * `notes` is the point of this function: "0 minutes slept" and "the watch has
 * never synced a night" look identical in a chart and mean opposite things.
 */
export function buildSleep(...args) {
  const { db, date, days = 7, includeStages = false, tz = TZ, nowMs = Date.now() } = optionsFrom(args, ['date', 'days']);
  if (!dbUsable(db)) return fail('health-db-unavailable', '健康数据库尚未就绪');
  const span = Math.min(30, Math.max(1, Math.trunc(Number(days) || 7)));
  const to = isLocalDate(date) ? String(date).trim() : localDateOf(nowMs, tz);
  if (to == null) return fail('bad-date', '日期格式不正确');
  const from = addLocalDays(to, -(span - 1)) ?? to;

  const rows = latestSleepSessions(db, from, to);
  const allRows = latestSleepSessions(db, '0000-01-01', '9999-12-31');
  const newestEndAt = allRows.reduce(
    (best, row) => (row.end_at != null && (best == null || Number(row.end_at) > best) ? Number(row.end_at) : best),
    null,
  );
  const availability = classifyAvailability({
    sessionCount: allRows.length,
    newestEndAt,
    nowMs,
  });

  const sessions = rows.map(row => ({
    sourceId: row.source_id,
    sleepDate: row.sleep_date,
    startAt: isoOrNull(row.start_at, tz),
    endAt: isoOrNull(row.end_at, tz),
    asleepMinutes: numOrNull(row.asleep_minutes),
    awakeMinutes: numOrNull(row.awake_minutes),
    inBedMinutes: numOrNull(row.in_bed_minutes),
    stageFidelity: row.stage_fidelity ?? 'unknown',
    sessionQuality: row.session_quality ?? 'partial',
    status: row.status ?? 'provisional',
    isNap: Number(row.is_nap ?? 0) === 1,
    sourceScore: numOrNull(row.source_score),
    sourceScoreLabel: row.source_score_label ?? null,
    // 分期**分钟数**（来源只给总数、不给逐段区间时，这是唯一诚实的说法）。
    // 与 `stages` 区别：`stages` 是时间轴（可空），`stageMinutes` 是各类时长合计。
    stageMinutes: {
      deep: numOrNull(row.deep_minutes),
      light: numOrNull(row.light_minutes),
      rem: numOrNull(row.rem_minutes),
      awake: numOrNull(row.awake_minutes),
    },
    stageCoverage: numOrNull(row.stage_coverage),
    stages: includeStages
      ? stagesFor(db, row.id).map(stage => ({
        stage: stage.stage,
        startAt: isoOrNull(stage.start_at, tz),
        endAt: isoOrNull(stage.end_at, tz),
        fidelity: stage.fidelity ?? 'unknown',
      }))
      : null,
    rawRef: row.raw_ref ?? null,
  }));

  const trend = rows.map(row => ({
    sleepDate: row.sleep_date,
    asleepMinutes: numOrNull(row.asleep_minutes),
    startAt: isoOrNull(row.start_at, tz),
    endAt: isoOrNull(row.end_at, tz),
    quality: row.session_quality ?? 'partial',
  }));

  const notes = [];
  if (availability === 'awaiting_first_night') {
    notes.push('云端还没有任何睡眠记录：华为 CN 云的睡眠（type 9）当前为空，手表把某一晚同步到手机 App 后这里才会有数据。');
  } else if (availability === 'no_data') {
    notes.push('采集正常，但所选区间内没有睡眠记录。');
  }
  if (availability === 'partial') {
    notes.push('只有部分夜晚有可解析的起止时间，缺失的夜晚不会用 0 分钟补齐。');
  }
  if (rows.length) {
    const aggregateOnly = rows.filter(row => row.status === 'aggregate_only');
    if (aggregateOnly.length) {
      notes.push(`${aggregateOnly.length} 个夜晚只有聚合时长，来源没有给可信的入睡/醒来时刻，因此不显示时间轴。`);
    }
    const withStages = rows.filter(row => row.stage_fidelity === 'exact' || row.stage_fidelity === 'partial');
    if (!withStages.length) {
      notes.push('来源没有提供睡眠阶段（深睡/浅睡/REM），这些字段保持为空，不做推断。');
    } else if (withStages.some(row => row.stage_fidelity === 'partial')) {
      notes.push('部分夜晚的睡眠阶段不完整或有重叠，阶段覆盖率只按来源实际给出的部分计算。');
    }
  }
  if (!rows.length && availability === 'present') {
    notes.push('整个库里有睡眠数据，但所选区间内没有。');
  }

  return {
    ok: true,
    availability,
    timezone: tz,
    range: { from, to },
    sessions,
    trend,
    notes,
  };
}

/**
 * Auth view for the sources card.
 *
 * The token itself is never stored, so the only source of expiry instants is the
 * redacted snapshot the collector writes into `health_meta.auth_snapshot` after a
 * real fetch (`{status, expiresAt, refreshExpiresAt, minutesLeft, rotated}`). When
 * that is absent we fall back to the source row's `auth_status` and report the
 * rest as unknown instead of guessing.
 */
function readAuthSnapshot(db) {
  try {
    const row = db.get('SELECT value FROM health_meta WHERE key = ?', ['auth_snapshot']);
    if (!row) return null;
    const parsed = JSON.parse(String(row.value));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function authBlock(row, snapshot, tz = TZ) {
  const name = snapshot?.status
    ?? (row?.auth_status && row.auth_status !== 'unknown' ? row.auth_status : 'unknown');
  return {
    status: String(name),
    expiresAt: isoOrNull(snapshot?.expiresAt, tz),
    refreshExpiresAt: isoOrNull(snapshot?.refreshExpiresAt, tz),
    minutesLeft: numOrNull(snapshot?.minutesLeft),
    rotated: typeof snapshot?.rotated === 'boolean' ? snapshot.rotated : null,
  };
}

function capabilityStatus({ hasData, declared, authStatus, lastErrorCode }) {
  if (hasData) return 'supported';
  if (authStatus === 'expired' || authStatus === 'required') return 'auth_required';
  if (lastErrorCode) return 'error';
  if (declared === false) return 'unsupported';
  return 'no_data';
}

/**
 * Per-capability reality check.
 *
 * The status comes from **rows that exist**, not from what the provider promises:
 * claiming `supported` for sleep when the store holds zero nights is the exact
 * failure mode this function exists to prevent.
 */
export function buildSources(...args) {
  const { db, config = {}, nowMs = Date.now(), tz = TZ } = optionsFrom(args, ['config', 'nowMs']);
  if (!dbUsable(db)) return [];
  const cfg = config && typeof config === 'object' ? config : {};
  let row = null;
  try {
    row = db.get('SELECT * FROM health_sources ORDER BY id ASC LIMIT 1');
  } catch {
    row = null;
  }

  let declared = {};
  try {
    declared = row?.capabilities_json ? JSON.parse(String(row.capabilities_json)) : {};
  } catch {
    declared = {};
  }

  const countOf = (sql, params = []) => {
    try {
      return Number(db.get(sql, params)?.total ?? 0);
    } catch {
      return 0;
    }
  };

  const observations = kind => countOf(
    'SELECT count(*) AS total FROM health_observations WHERE kind = ?',
    [kind],
  );
  const activityDays = countOf("SELECT count(*) AS total FROM health_daily_summaries WHERE metric_kind = 'activity'");
  const workouts = countOf('SELECT count(*) AS total FROM health_workout_sessions');
  const devices = countOf('SELECT count(*) AS total FROM health_devices');
  const sleepSessions = countOf('SELECT count(*) AS total FROM health_sleep_sessions');
  const stageRows = countOf('SELECT count(*) AS total FROM health_sleep_stages');
  const newest = newestSampleAt(db, tz);
  const authStatus = row?.auth_status ?? 'unknown';
  const lastErrorCode = row?.last_error_code ?? null;

  const stagesFidelity = (() => {
    if (!sleepSessions) return 'unknown';
    try {
      const counts = db.all(
        'SELECT stage_fidelity AS fidelity, count(*) AS total FROM health_sleep_sessions GROUP BY stage_fidelity',
      );
      const order = ['exact', 'partial', 'not_reliable', 'unknown'];
      for (const candidate of order) {
        if (counts.some(entry => entry.fidelity === candidate)) return candidate;
      }
    } catch {
      // fall through
    }
    return 'unknown';
  })();

  const sleepAvailability = classifyAvailability({
    sessionCount: sleepSessions,
    newestEndAt: (() => {
      try {
        const value = Number(db.get('SELECT MAX(end_at) AS at FROM health_sleep_sessions')?.at);
        return Number.isFinite(value) && value > 0 ? value : null;
      } catch {
        return null;
      }
    })(),
    nowMs,
  });

  const notes = [];
  if (!activityDays) notes.push('还没有活动数据（步数/热量），等待第一次成功同步。');
  if (!observations('heart_rate')) notes.push('还没有心率数据。');
  if (!observations('stress')) notes.push('还没有压力数据。');
  if (!observations('spo2')) notes.push('还没有血氧数据。');
  if (!workouts) notes.push('所选同步窗口内没有训练记录。');
  if (!devices) notes.push('还没有读到绑定设备列表。');
  if (!sleepSessions) {
    notes.push('云端没有睡眠记录（awaiting_first_night）：需要在手机 App 里把某一晚同步到云。');
  } else if (!stageRows) {
    notes.push('有睡眠会话，但来源没有提供阶段明细，深睡/浅睡/REM 保持为空。');
  }
  if (lastErrorCode) notes.push(`最近一次同步的错误码：${lastErrorCode}`);

  return [{
    id: row?.id ?? String(cfg.sourceId ?? 'huawei-cn'),
    name: row?.display_name ?? String(cfg.displayName ?? '华为运动健康（CN 云）'),
    kind: row?.kind ?? String(cfg.kind ?? 'wearable-cloud'),
    provider: row?.provider ?? String(cfg.provider ?? 'huawei_cn_cloud'),
    ownerScope: row?.owner_scope ?? DEFAULT_OWNER_SCOPE,
    enabled: Number(row?.enabled ?? 1) === 1,
    capabilities: {
      activity: capabilityStatus({ hasData: activityDays > 0, declared: declared.activity !== false, authStatus, lastErrorCode }),
      sport: capabilityStatus({ hasData: workouts > 0, declared: declared.sport !== false, authStatus, lastErrorCode }),
      heart_rate: capabilityStatus({ hasData: observations('heart_rate') > 0, declared: declared.heart_rate !== false, authStatus, lastErrorCode }),
      stress: capabilityStatus({ hasData: observations('stress') > 0, declared: declared.stress !== false, authStatus, lastErrorCode }),
      spo2: capabilityStatus({ hasData: observations('spo2') > 0, declared: declared.spo2 !== false, authStatus, lastErrorCode }),
      device: capabilityStatus({ hasData: devices > 0, declared: declared.device !== false, authStatus, lastErrorCode }),
      sleep: {
        supported: declared.sleep !== false,
        status: sleepSessions > 0 ? 'present' : (authStatus === 'expired' ? 'error' : 'no_data'),
        stageFidelity: stagesFidelity,
        availability: sleepAvailability,
      },
    },
    auth: authBlock(row, readAuthSnapshot(db), tz),
    freshness: {
      status: freshnessOf(newest, nowMs),
      newestSampleAt: isoOrNull(newest, tz),
      ageMinutes: newest == null ? null : Math.max(0, Math.round((nowMs - newest) / 60000)),
    },
    lastSuccessAt: isoOrNull(row?.last_success_at, tz),
    lastErrorCode,
    notes,
  }];
}
