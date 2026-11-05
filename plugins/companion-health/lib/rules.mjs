// Care-candidate rules (INTERFACES.md §10 / §15).
//
// **This module is pure evaluation.** It reads the store, matches a handful of
// product heuristics, and returns candidates. It:
//   * never sends a message,
//   * never calls a model,
//   * never writes to `health_care_candidates` (or any outbox),
//   * returns `[]` when the conditions are not met — no "maybe" rows.
//
// The caller decides whether anything happens with the list, and in this round
// nothing does: `health.care.proactive` defaults to false and has no code path
// that turns it on. Ingest only ever calls this behind an explicit config flag.
//
// Every threshold below is a **product parameter**. None of them is a medical
// conclusion, and the emitted `reason` strings are worded so a model repeating
// them cannot turn them into one.

import { TZ, addLocalDays, localDateOf, localMidnightMs } from './normalize.mjs';
import { classifyAvailability } from './sleep.mjs';

export const POLICY_VERSION = 'care-rules-v1';

/** Tunable parameters. Not advice, not diagnosis — just knobs. */
export const DEFAULT_POLICY = Object.freeze({
  sleepDebtNights: 3,
  sleepShortMinutes: 360, // below this counts as a short night
  restingHeartRateRiseBpm: 7,
  restingHeartRateLookbackDays: 7,
  activityDropRatio: 0.4,
  activityLookbackDays: 7,
  stressHighScore: 75,
  stressHighDays: 3,
  candidateTtlMs: 12 * 60 * 60 * 1000,
  cooldownMs: 24 * 60 * 60 * 1000,
});

export const PATTERNS = Object.freeze([
  'sleep_debt',
  'resting_heart_rate_rise',
  'activity_drop',
  'stress_persistent',
]);

function nums(list) {
  return list.map(value => Number(value)).filter(value => Number.isFinite(value));
}

function mean(list) {
  const values = nums(list);
  if (!values.length) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
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

function recentDates(to, count) {
  const out = [];
  for (let offset = 0; offset < count; offset += 1) {
    const date = addLocalDays(to, -offset);
    if (date != null) out.push(date);
  }
  return out;
}

function candidate({ ownerScope, pattern, evidenceHash, status, reason, nowMs, ttlMs }) {
  return {
    ownerScope,
    pattern,
    evidenceHash: String(evidenceHash),
    policyVersion: POLICY_VERSION,
    status,
    reason: String(reason),
    createdAt: nowMs,
    expiresAt: nowMs + ttlMs,
  };
}

/**
 * Evaluate every pattern once. Read-only.
 *
 * Returns `[]` when the store has nothing to say — an empty array is the honest
 * answer for "no pattern fired", and it must not be papered over with a
 * placeholder candidate.
 */
export function evaluateCareRules({
  db,
  ownerScope = 'owner-only',
  nowMs = Date.now(),
  tz = TZ,
  policy = {},
} = {}) {
  if (!db || typeof db.get !== 'function' || typeof db.all !== 'function') return [];
  const rules = { ...DEFAULT_POLICY, ...(policy && typeof policy === 'object' ? policy : {}) };
  const scope = String(ownerScope ?? 'owner-only');
  const today = localDateOf(nowMs, tz);
  if (today == null) return [];

  const out = [];

  // --- 1. sleep debt: N recent nights, each short -------------------------
  const nights = recentDates(today, Math.max(1, Number(rules.sleepDebtNights) || 3))
    .map(date => readSummary(db, scope, date, tz, 'sleep_day'))
    .filter(Boolean);
  const shortNights = nights.filter(night => {
    const minutes = Number(night.asleepMinutes);
    return Number.isFinite(minutes) && minutes > 0 && minutes < Number(rules.sleepShortMinutes);
  });
  if (shortNights.length >= Number(rules.sleepDebtNights)) {
    out.push(candidate({
      ownerScope: scope,
      pattern: 'sleep_debt',
      evidenceHash: `sleep_debt|${today}|${shortNights.length}`,
      status: 'observe',
      reason: `最近连续 ${shortNights.length} 个夜晚的云端睡眠时长低于产品参数阈值（不是医学结论）。`,
      nowMs,
      ttlMs: rules.candidateTtlMs,
    }));
  }

  // --- 2. resting heart rate rising over the lookback window --------------
  const lookback = recentDates(today, Math.max(2, Number(rules.restingHeartRateLookbackDays) || 7));
  const restingSeries = lookback
    .map(date => ({ date, value: Number(readSummary(db, scope, date, tz, 'health_day')?.heartRate?.resting) }))
    .filter(entry => Number.isFinite(entry.value) && entry.value > 0);
  if (restingSeries.length >= 3) {
    const newest = restingSeries[0];
    const baseline = mean(restingSeries.slice(1).map(entry => entry.value));
    if (baseline != null && newest.value - baseline >= Number(rules.restingHeartRateRiseBpm)) {
      out.push(candidate({
        ownerScope: scope,
        pattern: 'resting_heart_rate_rise',
        evidenceHash: `rhr_rise|${newest.date}|${Math.round(newest.value)}|${Math.round(baseline)}`,
        status: 'observe',
        reason: '最近一次静息心率比过去几天均值高出一个产品参数阈值（不是医学结论）。',
        nowMs,
        ttlMs: rules.candidateTtlMs,
      }));
    }
  }

  // --- 3. activity drop against the lookback average ----------------------
  const activityDates = recentDates(today, Math.max(2, Number(rules.activityLookbackDays) || 7));
  const activitySeries = activityDates
    .map(date => ({ date, value: Number(readSummary(db, scope, date, tz, 'activity')?.steps) }))
    .filter(entry => Number.isFinite(entry.value) && entry.value >= 0);
  if (activitySeries.length >= 3) {
    const newest = activitySeries[0];
    const baseline = mean(activitySeries.slice(1).map(entry => entry.value));
    if (baseline != null && baseline > 0 && newest.value <= baseline * Number(rules.activityDropRatio)) {
      out.push(candidate({
        ownerScope: scope,
        pattern: 'activity_drop',
        evidenceHash: `activity_drop|${newest.date}|${newest.value}|${Math.round(baseline)}`,
        status: 'observe',
        reason: '最近一天步数明显低于过去几天均值（产品参数，不是医学结论）。',
        nowMs,
        ttlMs: rules.candidateTtlMs,
      }));
    }
  }

  // --- 4. persistent high stress -----------------------------------------
  const stressDates = recentDates(today, Math.max(1, Number(rules.stressHighDays) || 3));
  const highStress = stressDates.filter(date => {
    const value = Number(readSummary(db, scope, date, tz, 'health_day')?.stress?.avg);
    return Number.isFinite(value) && value >= Number(rules.stressHighScore);
  });
  if (highStress.length >= Number(rules.stressHighDays)) {
    out.push(candidate({
      ownerScope: scope,
      pattern: 'stress_persistent',
      evidenceHash: `stress_persistent|${today}|${highStress.length}`,
      status: 'observe',
      reason: `最近 ${highStress.length} 天的平均压力分都高于产品参数阈值（不是医学结论）。`,
      nowMs,
      ttlMs: rules.candidateTtlMs,
    }));
  }

  return out.filter(entry => PATTERNS.includes(entry.pattern));
}

/**
 * Why is the care capability quiet right now? A single sentence the status page
 * can show without implying anything was suppressed silently.
 */
export function explainCareState({ db, ownerScope = 'owner-only', nowMs = Date.now(), tz = TZ } = {}) {
  const scope = String(ownerScope ?? 'owner-only');
  let sessions = 0;
  try {
    sessions = Number(db.get('SELECT count(*) AS total FROM health_sleep_sessions')?.total ?? 0);
  } catch {
    sessions = 0;
  }
  const sleepAvailability = classifyAvailability({ sessionCount: sessions, newestEndAt: null, nowMs });
  const today = localDateOf(nowMs, tz);
  const hasActivity = today == null ? false : Boolean(readSummary(db, scope, today, tz, 'activity'));
  return {
    evaluated: false,
    reason: '本轮不启用 proactive care：没有任何发送、调度或模型调用路径。',
    sleepAvailability,
    hasActivityToday: hasActivity,
    sleepAnchorMs: today == null ? null : localMidnightMs(today, tz),
  };
}
