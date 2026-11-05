// Sleep session normalisation (INTERFACES.md §7).
//
// This is the easiest place in the whole plugin to invent data, so the rules are
// spelled out here rather than buried in the code:
//
//   1. Only aggregate minutes and no parseable start/end => `start_at`/`end_at`
//      are **NULL** and `status = 'aggregate_only'`. Padding a duration onto
//      `sleepDate 00:00` would be a fabricated bedtime.
//   2. Parseable `fall_asleep` / `wakeup` => a normal session. Unparseable => rule 1.
//   3. Stage rows are written only when the source really published stage
//      intervals. `dreamTime` -> `rem`, `deepSleepTime` -> `deep`,
//      `lightSleepTime` -> `light`, `awakeTime` -> `awake`. Missing parts stay
//      missing — no `unknown` filler, and coverage is computed over what exists.
//   4. Durations are UTC differences, never local-clock differences.
//   5. A short session that ends between 10:00 and 20:00 local is a nap.
//   6. Overlapping / out-of-order / out-of-bounds stages are stored but reported
//      and downgraded to `stage_fidelity = 'partial'`.
//   7. An empty array writes nothing and returns `[]`.
//
// The identity of a night is `(sourceId, sourceRecordKey)`; a corrected night is a
// new revision of the same record, not a second night.

import {
  TZ,
  canonicalJson,
  epochToMs,
  fromNaiveLocalIso,
  localDateOf,
  localMidnightMs,
  localPartsOf,
  sha256Hex,
  shortHash,
} from './normalize.mjs';

export const SLEEP_STAGES = Object.freeze(['deep', 'light', 'rem', 'awake', 'unknown']);

const MINUTE_MS = 60000;
const NAP_MAX_MINUTES = 180;
const NAP_EARLIEST_HOUR = 10;
const NAP_LATEST_HOUR = 20; // exclusive: 20:00
const DEFAULT_STAGE_TOLERANCE_MS = 5 * 60 * 1000;

// --- durations and dates -----------------------------------------------------

/** Attribution date of a sleep session: the local date on which it ended. */
export function assignSleepDate(endAtMs, tz = TZ) {
  if (endAtMs == null || !Number.isFinite(Number(endAtMs))) return null;
  return localDateOf(Number(endAtMs), tz);
}

export function crossMidnight(startAt, endAt, tz = TZ) {
  const startDate = startAt == null ? null : localDateOf(Number(startAt), tz);
  const endDate = endAt == null ? null : localDateOf(Number(endAt), tz);
  return {
    spansMidnight: Boolean(startDate && endDate && startDate !== endDate),
    localDateStart: startDate,
    localDateEnd: endDate,
  };
}

function minutesBetween(startAt, endAt) {
  if (startAt == null || endAt == null) return null;
  const span = Number(endAt) - Number(startAt);
  if (!Number.isFinite(span) || span <= 0) return null;
  // UTC difference: the local clock may jump (DST) but the elapsed time does not.
  return span / MINUTE_MS;
}

// --- stage validation -------------------------------------------------------

function stageSpan(stage) {
  const startAt = stage?.startAt ?? stage?.start_at ?? null;
  const endAt = stage?.endAt ?? stage?.end_at ?? null;
  if (startAt == null || endAt == null) return null;
  const start = Number(startAt);
  const end = Number(endAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return { start, end };
}

/**
 * Structural check on a stage list, in the order the source gave it.
 *
 * `gap` is reported but does not make the list invalid: real nights have
 * uncovered stretches, and treating them as a fault would flag every night.
 */
export function validateStages(stages, { startAt = null, endAt = null, toleranceMs = DEFAULT_STAGE_TOLERANCE_MS } = {}) {
  const issues = [];
  const list = Array.isArray(stages) ? stages : [];
  const sessionStart = startAt == null ? null : Number(startAt);
  const sessionEnd = endAt == null ? null : Number(endAt);
  const tolerance = Number.isFinite(Number(toleranceMs)) ? Number(toleranceMs) : DEFAULT_STAGE_TOLERANCE_MS;

  const spans = [];
  list.forEach((stage, index) => {
    const span = stageSpan(stage);
    if (!span) {
      issues.push({ code: 'start-after-end', detail: `第 ${index} 段缺少可用起止时间` });
      return;
    }
    if (span.end <= span.start) {
      issues.push({ code: 'start-after-end', detail: `第 ${index} 段结束不晚于开始` });
    }
    spans.push({ index, ...span });
    if (sessionStart != null && sessionEnd != null) {
      if (span.start < sessionStart - tolerance || span.end > sessionEnd + tolerance) {
        issues.push({ code: 'outside-session', detail: `第 ${index} 段落在会话区间之外` });
      }
    }
  });

  // Compared in source order on purpose: an out-of-order list therefore surfaces
  // as `overlap`, which is exactly what the store would contain.
  for (let i = 1; i < spans.length; i += 1) {
    const previous = spans[i - 1];
    const current = spans[i];
    if (current.start < previous.end - tolerance) {
      issues.push({ code: 'overlap', detail: `第 ${i - 1} 段与第 ${i} 段重叠` });
    } else if (current.start > previous.end + tolerance) {
      issues.push({ code: 'gap', detail: `第 ${i - 1} 段与第 ${i} 段之间有空档` });
    }
  }

  if (sessionStart != null && sessionEnd != null && sessionEnd > sessionStart) {
    const covered = spans.reduce((total, span) => total + Math.max(0, span.end - span.start), 0);
    if (covered > (sessionEnd - sessionStart) + tolerance) {
      issues.push({ code: 'sum-exceeds-session', detail: '阶段总时长超过会话时长' });
    }
  }

  const ok = issues.every(issue => issue.code === 'gap');
  return { ok, issues };
}

/** Union of the stage intervals, clipped to the session when bounds are known. */
export function stageCoverage(stages, { startAt = null, endAt = null } = {}) {
  const sessionStart = startAt == null ? null : Number(startAt);
  const sessionEnd = endAt == null ? null : Number(endAt);
  const hasBounds = sessionStart != null && sessionEnd != null && sessionEnd > sessionStart;

  const spans = (Array.isArray(stages) ? stages : [])
    .map(stageSpan)
    .filter(Boolean)
    .map(span => ({
      start: hasBounds ? Math.max(span.start, sessionStart) : span.start,
      end: hasBounds ? Math.min(span.end, sessionEnd) : span.end,
    }))
    .filter(span => span.end > span.start)
    .sort((left, right) => left.start - right.start);

  const merged = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) {
      last.end = Math.max(last.end, span.end);
    } else {
      merged.push({ ...span });
    }
  }

  const coveredMs = merged.reduce((total, span) => total + (span.end - span.start), 0);
  const totalMs = hasBounds ? sessionEnd - sessionStart : 0;

  const gaps = [];
  if (hasBounds) {
    let cursor = sessionStart;
    for (const span of merged) {
      if (span.start > cursor) gaps.push({ startAt: cursor, endAt: span.start });
      cursor = Math.max(cursor, span.end);
    }
    if (cursor < sessionEnd) gaps.push({ startAt: cursor, endAt: sessionEnd });
  }

  return {
    coveredMinutes: coveredMs / MINUTE_MS,
    totalMinutes: totalMs / MINUTE_MS,
    ratio: hasBounds ? Math.round((coveredMs / totalMs) * 10000) / 10000 : null,
    gaps,
  };
}

// --- source field extraction ------------------------------------------------

const INS = new Set(Object.freeze(['fall_asleep', 'fallAsleep', 'fall_asleep_time', 'fallAsleepTime',
  'sleep_start', 'sleepStart', 'sleep_time', 'sleepTime', 'start', 'start_time', 'startTime', 'probableFallAsleepTime']));
const OUTS = new Set(Object.freeze(['wakeup', 'wakeup_time', 'wakeupTime', 'wakeUpTime', 'wake_up_time',
  'sleep_end', 'sleepEnd', 'end', 'end_time', 'endTime', 'probableWakeupTime']));

function pick(row, keys) {
  if (!row || typeof row !== 'object') return null;
  for (const key of keys) {
    const value = row[key];
    if (value !== null && value !== undefined && value !== '') return value;
  }
  return null;
}

function pickIns(row) {
  return pick(row, [...INS]);
}

function pickOuts(row) {
  return pick(row, [...OUTS]);
}

/**
 * One instant from the many shapes a Python sidecar can emit: epoch seconds,
 * epoch milliseconds, a zone-less local ISO string, or an ISO string with offset.
 * A bare `HH:mm` cannot be placed on a timeline without inventing a date, so it
 * returns null and the caller falls back to "aggregate only".
 */
export function parseSleepInstant(value, tz = TZ) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return epochToMs(value);
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d+(?:\.\d+)?$/.test(text)) return epochToMs(Number(text));
  if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(text)) return null;
  return fromNaiveLocalIso(text, tz);
}

// 键名要同时覆盖两层：client.py **映射之后**的名字（`sleep_deep` / `sleep_rem` …）和它映射
// 之前的 upstream 原名（`deepSleepTime` / `dreamTime` …）。2026-11-04 首夜真数据的教训：
// 只写了 upstream 名，结果 `sleep_duration` 命中、`sleep_deep`/`sleep_light`/`sleep_rem`/
// `sleep_awake` 全部落空 —— 会话与时长进来了，阶段却静默丢了 67/188/44/7 分钟。
const MINUTE_KEYS = Object.freeze({
  asleep: ['asleep_minutes', 'asleepMinutes', 'sleep_duration', 'sleepDuration', 'all_sleep_time',
    'allSleepTime', 'total_sleep_minutes', 'totalSleepTime', 'duration_min', 'duration'],
  awake: ['awake_minutes', 'awakeMinutes', 'sleep_awake', 'awake_time', 'awakeTime', 'wake_time', 'wakeTime'],
  inBed: ['in_bed_minutes', 'inBedMinutes', 'sleep_in_bed', 'in_bed_time', 'inBedTime', 'bed_time', 'bedTime'],
  deep: ['deep_minutes', 'deepMinutes', 'sleep_deep', 'deep_sleep_time', 'deepSleepTime'],
  light: ['light_minutes', 'lightMinutes', 'sleep_light', 'light_sleep_time', 'lightSleepTime'],
  rem: ['rem_minutes', 'remMinutes', 'sleep_rem', 'rem_sleep_time', 'remSleepTime', 'dream_time', 'dreamTime'],
});

function minutesOf(row, keys) {
  for (const key of keys) {
    const value = row?.[key];
    if (value === null || value === undefined || value === '') continue;
    const parsed = Number(value);
    // -1 is the upstream "not measured" sentinel; 0 minutes of deep sleep is a
    // plausible reading only when the source really published 0.
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

const STAGE_ALIASES = Object.freeze([
  [/deep|深/, 'deep'],
  [/light|浅/, 'light'],
  [/rem|dream|梦|快速/, 'rem'],
  [/awake|wake|醒/, 'awake'],
]);

/** Map a source stage label/code onto our enum. Unrecognised stays `unknown`. */
export function stageKindOf(label) {
  if (label === null || label === undefined || label === '') return 'unknown';
  const text = String(label).toLowerCase();
  for (const [pattern, kind] of STAGE_ALIASES) {
    if (pattern.test(text)) return kind;
  }
  return 'unknown';
}

function stageListOf(row) {
  const candidates = [row?.stages, row?.sleep_stages, row?.sleepStages, row?.stageList, row?.segments];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function rawStagesToStages(row, tz) {
  const rows = stageListOf(row);
  const out = [];
  for (const entry of rows) {
    if (!entry || typeof entry !== 'object') continue;
    const startAt = parseSleepInstant(
      entry.startAt ?? entry.start_at ?? entry.start ?? entry.startTime ?? entry.start_time, tz,
    );
    const endAt = parseSleepInstant(
      entry.endAt ?? entry.end_at ?? entry.end ?? entry.endTime ?? entry.end_time, tz,
    );
    if (startAt == null || endAt == null) continue;
    const rawCode = entry.stage ?? entry.type ?? entry.kind ?? entry.stageCode ?? entry.stage_code ?? null;
    out.push({
      stage: stageKindOf(rawCode),
      startAt,
      endAt,
      sourceStageCode: rawCode == null ? null : String(rawCode),
    });
  }
  return out;
}

function sourceRecordKeyOf({ sleepDate, startAt, occurrence }) {
  // Identity = the night it belongs to plus when it started. Content changes
  // (a corrected duration) keep the same key and become a new revision.
  return `slp:${sleepDate}:${startAt == null ? `aggregate${occurrence > 1 ? `#${occurrence}` : ''}` : startAt}`;
}

/** Deterministic session id; a new revision is a new row (the PK is the id). */
export function sleepSessionId(sourceId, sourceRecordKey, revision = 1) {
  return `slp_${shortHash(`${sourceId}|${sourceRecordKey}|${Math.trunc(revision) || 1}`)}`;
}

/**
 * Content fingerprint of one night, built from the comparable fields only.
 *
 * Ingest uses it to answer "is this the same night I already stored?" — a changed
 * duration becomes a new revision, an unchanged re-poll stays a no-op. It is
 * exported so the read-back path (DB row + stage rows) hashes exactly the same
 * field set instead of re-implementing it and drifting.
 */
export function sleepContentHash(fields) {
  const input = fields && typeof fields === 'object' ? fields : {};
  const stages = Array.isArray(input.stages) ? input.stages : [];
  return sha256Hex(canonicalJson({
    sleepDate: input.sleepDate ?? null,
    startAt: input.startAt ?? null,
    endAt: input.endAt ?? null,
    asleepMinutes: input.asleepMinutes ?? null,
    awakeMinutes: input.awakeMinutes ?? null,
    inBedMinutes: input.inBedMinutes ?? null,
    deepMinutes: input.deepMinutes ?? null,
    lightMinutes: input.lightMinutes ?? null,
    remMinutes: input.remMinutes ?? null,
    stageFidelity: input.stageFidelity ?? null,
    status: input.status ?? null,
    isNap: input.isNap ?? 0,
    sourceScore: input.sourceScore ?? null,
    stages: stages.map(stage => [
      stage?.stage ?? null,
      stage?.startAt ?? stage?.start_at ?? null,
      stage?.endAt ?? stage?.end_at ?? null,
    ]),
  }));
}

// --- main normaliser --------------------------------------------------------

/**
 * One session record per source row. Rows we cannot attribute to a date are
 * dropped: `sleep_date` is NOT NULL in the schema and guessing "today" would put
 * a night under the wrong day.
 */
export function normalizeSleepRows(rows, {
  nowMs = Date.now(),
  fetchedAt = null,
  sourceId = 'huawei-cn',
  tz = TZ,
} = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const at = Number.isFinite(Number(fetchedAt)) ? Number(fetchedAt) : Number(nowMs);
  const occurrences = new Map();
  const sessions = [];

  for (const entry of list) {
    const row = entry && typeof entry === 'object' && entry.raw && typeof entry.raw === 'object'
      ? entry.raw
      : entry;
    if (!row || typeof row !== 'object') continue;

    const declaredDate = [entry?.localDate, row.date, row.sleep_date, row.recordDay]
      .find(value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim()));
    const rawStart = parseSleepInstant(pickIns(row), tz);
    const rawEnd = parseSleepInstant(pickOuts(row), tz);

    // Only a coherent window counts as a window.
    const hasWindow = rawStart != null && rawEnd != null && rawEnd > rawStart;
    const startAt = hasWindow ? rawStart : null;
    const endAt = hasWindow ? rawEnd : null;

    const declared = typeof declaredDate === 'string' ? declaredDate.trim() : null;
    const inferred = declared == null ? assignSleepDate(endAt, tz) : null;
    const sleepDate = declared ?? inferred;
    if (sleepDate == null) continue; // no date, no session

    const asleep = minutesOf(row, MINUTE_KEYS.asleep);
    const awake = minutesOf(row, MINUTE_KEYS.awake);
    const inBed = minutesOf(row, MINUTE_KEYS.inBed);
    const deep = minutesOf(row, MINUTE_KEYS.deep);
    const light = minutesOf(row, MINUTE_KEYS.light);
    const rem = minutesOf(row, MINUTE_KEYS.rem);

    const stages = rawStagesToStages(row, tz);
    const validation = validateStages(stages, { startAt, endAt });
    const structuralIssues = validation.issues.filter(issue => issue.code !== 'gap');

    const stageMinutesSum = [deep, light, rem, awake]
      .reduce((total, value) => total + (value == null ? 0 : value), 0);
    const hasStageMinutes = [deep, light, rem, awake].some(value => value != null);
    // 起止跨度先算：阶段覆盖率的分母要用它（见下）。
    const elapsed = minutesBetween(startAt, endAt);

    // Coverage is computed from what the source published, never padded.
    let coverage = null;
    let stageFidelity = 'unknown';
    if (stages.length) {
      const measured = stageCoverage(stages, { startAt, endAt });
      coverage = measured.ratio;
      stageFidelity = structuralIssues.length ? 'partial' : 'exact';
    } else if (hasStageMinutes) {
      // 分子是 deep+light+rem+awake（覆盖了整段睡眠窗），所以分母必须是**起止跨度**，
      // 不能用 asleep：2026-11-04 首夜实测 (67+188+44+7)/299 = 1.0234，一个 >1 的覆盖率
      // 只会让人以为数据坏了。跨度不可得时退回 asleep，并照样夹到 [0,1]。
      const windowMinutes = elapsed ?? inBed ?? asleep;
      const rawRatio = windowMinutes && windowMinutes > 0 ? stageMinutesSum / windowMinutes : null;
      coverage = rawRatio == null ? null : Math.min(1, Math.round(rawRatio * 10000) / 10000);
      if (rawRatio != null && rawRatio > 1.0001) {
        validation.issues.push({
          code: 'stage-sum-exceeds-window',
          detail: `阶段分钟合计 ${stageMinutesSum} 超过睡眠跨度 ${windowMinutes}`,
        });
      }
      stageFidelity = 'partial';
    }

    // A duration the source never published: reported, but labelled as derived
    // rather than claimed as the source's own number.
    const derivedAsleep = asleep == null && elapsed != null;
    const asleepMinutes = asleep ?? elapsed;
    // 上床跨度：来源没有 in-bed 字段时，起止跨度就是契约 §4.1 定义的那个跨度（真实时间，不是编的）。
    const inBedMinutes = inBed ?? (elapsed != null ? elapsed : null);

    // Nap: short *and* ending inside the waking part of the local day.
    let isNap = 0;
    if (endAt != null && asleepMinutes != null && asleepMinutes < NAP_MAX_MINUTES) {
      const parts = localPartsOf(endAt, tz);
      if (parts && parts.hour >= NAP_EARLIEST_HOUR && parts.hour < NAP_LATEST_HOUR) isNap = 1;
    }

    const occurrenceKey = `${sleepDate}:${startAt ?? 'aggregate'}`;
    const occurrence = (occurrences.get(occurrenceKey) ?? 0) + 1;
    occurrences.set(occurrenceKey, occurrence);
    const sourceRecordKey = sourceRecordKeyOf({ sleepDate, startAt, occurrence });

    let status;
    let sessionQuality;
    if (startAt == null || endAt == null) {
      status = 'aggregate_only';
      sessionQuality = 'aggregate-only';
    } else if (declared == null) {
      // The window is real but the night it belongs to is our inference.
      status = 'provisional';
      sessionQuality = 'partial';
    } else if (derivedAsleep) {
      // The window is origin-confirmed; the duration is only our arithmetic.
      status = 'lite';
      sessionQuality = 'origin-confirmed';
    } else {
      status = 'confirmed';
      sessionQuality = 'origin-confirmed';
    }

    const score = minutesOf(row, ['sleep_score', 'sleepScore']);
    const scoreLabel = pick(row, ['sleep_score_label', 'sleepScoreLabel', 'sleep_quality_label', 'sleepQualityLabel']);

    sessions.push({
      id: sleepSessionId(sourceId, sourceRecordKey, 1),
      canonicalGroupId: `${sourceId}:${sleepDate}`,
      sourceId,
      sourceRecordKey,
      startAt,
      endAt,
      sleepDate,
      timezoneId: tz,
      asleepMinutes,
      awakeMinutes: awake,
      inBedMinutes: inBedMinutes,
      deepMinutes: deep,
      lightMinutes: light,
      remMinutes: rem,
      stageCoverage: coverage,
      stageFidelity,
      sessionQuality,
      status,
      isNap,
      sourceScore: score == null || score < 0 ? null : score,
      sourceScoreLabel: typeof scoreLabel === 'string' && scoreLabel.trim() ? scoreLabel.trim() : null,
      rawRef: null,
      fetchedAt: at,
      revision: 1,
      // `stages` is a transport field for the ingest transaction, not a column.
      stages: stages.map((stage, index) => ({
        stageIndex: index,
        stage: stage.stage,
        startAt: stage.startAt,
        endAt: stage.endAt,
        sourceStageCode: stage.sourceStageCode,
        fidelity: stage.stage === 'unknown' ? 'not_reliable' : (structuralIssues.length ? 'partial' : 'exact'),
      })),
      issues: validation.issues,
      // Stable content hash so ingest can tell "same night" from "corrected night".
      contentHash: sleepContentHash({
        sleepDate,
        startAt,
        endAt,
        asleepMinutes,
        awakeMinutes: awake,
        // 必须与写进 `in_bed_minutes` 的是同一个值，否则幂等判断会拿"派生前的 null"去比
        // "派生后的 450"，同一夜每轮同步都当成"被修正"而多出一个 revision。
        inBedMinutes: inBedMinutes,
        deepMinutes: deep,
        lightMinutes: light,
        remMinutes: rem,
        stageFidelity,
        status,
        isNap,
        sourceScore: score == null || score < 0 ? null : score,
        stages: stages.map(stage => ({
          stage: stage.stage,
          startAt: stage.startAt,
          endAt: stage.endAt,
        })),
      }),
    });
  }

  return sessions;
}

/**
 * Why is the sleep panel empty (or only half full)?
 *
 * `awaiting_first_night` means we have never stored a single night — the account
 * may simply not have synced a watch yet (README §10.1). `no_data` means the
 * collector is working and there is genuinely nothing to show. Both must not be
 * reported as "0 minutes slept".
 */
export function classifyAvailability({ sessionCount = 0, newestEndAt = null, expectedNights = 1, nowMs = Date.now() } = {}) {
  const count = Number.isFinite(Number(sessionCount)) ? Number(sessionCount) : 0;
  const nights = Math.max(1, Number(expectedNights) || 1);
  if (count <= 0) return newestEndAt == null ? 'awaiting_first_night' : 'no_data';
  if (newestEndAt == null) return 'partial'; // sessions exist but none has a window
  const age = Number(nowMs) - Number(newestEndAt);
  if (!Number.isFinite(age)) return 'partial';
  // A night we expect but have not received makes the picture partial, not wrong.
  return age <= nights * 2 * 86400000 ? 'present' : 'partial';
}

export { localMidnightMs };
