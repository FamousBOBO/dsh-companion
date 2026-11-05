// Window ingest: sidecar payload -> rows (INTERFACES.md §8).
//
// Contract of this module, in one place:
//
//   * **Single flight.** Two concurrent `syncOnce()` calls never overlap; the
//     second one returns `status:'skipped'` / `errorCode:'busy'` immediately. A
//     module-level promise is the lock — a boolean flag would leak on a throw.
//   * **Idempotent.** The identity of an observation is
//     `(source_id, source_key, kind, sample_at)`. Unchanged content is reported as
//     `updated` but does not bump the revision (INTERFACES.md §8 wording); changed
//     content inserts `revision + 1` and leaves the old row in place as history.
//   * **Rate limited, then quiet.** `1101` or HTTP 429 parks the collector on an
//     exponential ladder (60s -> 120s -> 300s -> 600s cap) written to
//     `health_sync_runs.next_allowed_at`; during the window `syncOnce` is a no-op.
//   * **Never throws.** Any fault collapses into `status:'error'` + `error_code`,
//     recorded in the run table and on the source row. Only a bad *argument* throws,
//     because that is a programming error the caller must see.
//   * **Every run leaves a receipt.** One `health_raw_refs` row holds the redacted
//     payload (or, above 256KB, just its hash and size) so an operator can prove
//     what the cloud actually said without a token ever being written.

import {
  TZ,
  canonicalJson,
  encodeObservationValue,
  hasValues,
  normalizeWindow,
  parseObservationValue,
  sha256Hex,
  shortHash,
} from './normalize.mjs';
import {
  classifyAvailability,
  normalizeSleepRows,
  sleepContentHash,
  sleepSessionId,
} from './sleep.mjs';
import { assertNoSecrets } from './cn-adapter.mjs';

/** Rate-limit ladder, in ms. Escalates per consecutive rate-limited run. */
export const BACKOFF_LADDER_MS = Object.freeze([60000, 120000, 300000, 600000]);

/** A payload larger than this is stored as hash + size only. */
export const RAW_PAYLOAD_LIMIT_BYTES = 256 * 1024;

const MAX_WINDOW_DAYS = 30;
const MAX_FAULTS = 20;
const MAX_MESSAGE = 200;

const REALTIME_KIND = Object.freeze({ heartRate: 'heart_rate', stress: 'stress', spo2: 'spo2' });

function clampDays(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 7;
  return Math.min(MAX_WINDOW_DAYS, Math.max(1, Math.trunc(parsed)));
}

function shortText(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE)}…` : text;
}

/** `1101` / "too many requests" anywhere in the sidecar error list. */
export function isRateLimitText(errors) {
  const list = Array.isArray(errors) ? errors : [];
  return list.some(entry => {
    const text = typeof entry === 'string' ? entry : JSON.stringify(entry ?? '');
    return /\b1101\b/.test(text) || /too many requests/i.test(text);
  });
}

function errorToFault(entry) {
  if (entry && typeof entry === 'object') {
    const code = shortText(entry.code ?? entry.errorCode ?? 'sidecar-error');
    const message = shortText(entry.message ?? entry.msg ?? entry.detail ?? JSON.stringify(entry));
    return { code, message };
  }
  return { code: 'sidecar-error', message: shortText(entry) };
}

/**
 * Create the ingest engine.
 *
 * `adapter` is injected (see `cn-adapter.mjs`), which is what lets the tests run
 * a whole sync — including the rate-limit path — without a socket.
 */
export function createIngest({ db, adapter, config = {}, now = () => Date.now(), log = () => {} } = {}) {
  if (!db || typeof db.run !== 'function') throw new Error('createIngest 需要已打开的 db。');
  if (!adapter || typeof adapter.fetchWindow !== 'function') throw new Error('createIngest 需要 adapter.fetchWindow。');

  const cfg = config && typeof config === 'object' ? config : {};
  const sourceId = String(cfg.sourceId ?? 'huawei-cn');
  const ownerScope = String(cfg.ownerScope ?? 'owner-only');
  const provider = String(cfg.provider ?? 'huawei_cn_cloud');
  const sourceKind = String(cfg.kind ?? 'wearable-cloud');
  const displayName = String(cfg.displayName ?? '华为运动健康（CN 云）');
  const defaultDays = clampDays(cfg.windowDays ?? 7);
  const pollCooldownMs = Number.isFinite(Number(cfg.minIntervalMs)) ? Math.max(0, Number(cfg.minIntervalMs)) : 0;

  const clock = () => {
    const value = Number(now());
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : Date.now();
  };
  const emit = typeof log === 'function' ? log : () => {};

  let inFlight = null;
  let sequence = 0;

  // --- run bookkeeping ------------------------------------------------------

  function skipResult(startedAt, errorCode) {
    return {
      runId: null,
      status: 'skipped',
      itemsSeen: 0,
      inserted: 0,
      updated: 0,
      skipped: 0,
      errorCode,
      startedAt,
      finishedAt: clock(),
      faults: [{ code: errorCode, message: errorCode === 'busy' ? '上一轮同步尚未结束' : '处于限流退避窗口内' }],
    };
  }

  function nextAllowedAt() {
    try {
      const row = db.get(
        `SELECT next_allowed_at FROM health_sync_runs
          WHERE next_allowed_at IS NOT NULL ORDER BY started_at DESC LIMIT 1`,
      );
      const value = Number(row?.next_allowed_at);
      if (!Number.isFinite(value) || value <= 0) return null;
      return value > clock() ? value : null;
    } catch {
      return null;
    }
  }

  function isRateLimited() {
    return nextAllowedAt() != null;
  }

  function cooldownUntil() {
    if (pollCooldownMs <= 0) return null;
    const last = Number(db.meta('lastSuccessfulSyncAt'));
    if (!Number.isFinite(last) || last <= 0) return null;
    const deadline = last + pollCooldownMs;
    return deadline > clock() ? deadline : null;
  }

  function consecutiveFailures() {
    try {
      const rows = db.all('SELECT status FROM health_sync_runs ORDER BY started_at DESC LIMIT 20');
      let count = 0;
      for (const row of rows) {
        if (row.status === 'error' || row.status === 'rate_limited') count += 1;
        else break;
      }
      return count;
    } catch {
      return 0;
    }
  }

  function consecutiveRateLimited() {
    try {
      const rows = db.all('SELECT status FROM health_sync_runs ORDER BY started_at DESC LIMIT 20');
      let count = 0;
      for (const row of rows) {
        if (row.status === 'rate_limited') count += 1;
        else break;
      }
      return count;
    } catch {
      return 0;
    }
  }

  function backoffMs() {
    const index = Math.min(consecutiveRateLimited(), BACKOFF_LADDER_MS.length - 1);
    return BACKOFF_LADDER_MS[index];
  }

  // --- source row -----------------------------------------------------------

  const DECLARED_CAPABILITIES = Object.freeze({
    activity: 'supported',
    sport: 'supported',
    heart_rate: 'supported',
    stress: 'supported',
    spo2: 'supported',
    device: 'supported',
    sleep: 'supported',
  });

  function ensureSourceRow() {
    const existing = db.get('SELECT id FROM health_sources WHERE id = ?', [sourceId]);
    if (existing) return false;
    db.run(
      `INSERT INTO health_sources
         (id, kind, provider, owner_scope, display_name, capabilities_json, auth_status,
          last_success_at, last_error_code, enabled)
       VALUES (?, ?, ?, ?, ?, ?, 'unknown', NULL, NULL, ?)`,
      [sourceId, sourceKind, provider, ownerScope, displayName,
        JSON.stringify(DECLARED_CAPABILITIES), cfg.enabled === false ? 0 : 1],
    );
    return true;
  }

  // --- writers --------------------------------------------------------------
  //
  // Every writer *returns* an outcome ('inserted' | 'updated' | 'skipped') instead
  // of incrementing counters itself. The caller tallies one item per source record,
  // which is what keeps `itemsSeen === inserted + updated + skipped` true: a health
  // day is one item even though it fans out into one summary plus four observations.

  function writeObservation(row) {
    const hash = sha256Hex(canonicalJson({
      kind: row.kind,
      value: row.value,
      values: row.values,
      unit: row.unit,
      quality: row.quality,
    }));
    const existing = db.get(
      `SELECT id, revision, observed_value_json FROM health_observations
        WHERE source_id = ? AND source_key = ? AND kind = ? AND sample_at = ?
        ORDER BY revision DESC LIMIT 1`,
      [sourceId, row.sourceKey, row.kind, row.sampleAt],
    );
    if (existing) {
      const previous = parseObservationValue(existing).hash;
      if (previous === hash) {
        // INTERFACES.md §8: same content is reported as `updated`, no revision bump.
        return 'updated';
      }
    }
    const revision = existing ? Number(existing.revision) + 1 : 1;
    const id = `obs_${shortHash(`${sourceId}|${row.sourceKey}|${row.kind}|${row.sampleAt}|${revision}`)}`;
    db.run(
      `INSERT INTO health_observations
         (id, source_id, source_key, kind, granularity, sample_at, value, unit,
          observed_value_json, quality, source_updated_at, fetched_at, raw_ref, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      [id, sourceId, row.sourceKey, row.kind, row.granularity, row.sampleAt, row.value,
        row.unit, encodeObservationValue({ hash, value: row.values }), row.quality,
        row.sourceUpdatedAt ?? null, row.fetchedAt, revision],
    );
    return 'inserted';
  }

  const WORKOUT_FIELDS = Object.freeze([
    'start_at', 'end_at', 'sport_type_raw', 'sport_type_label', 'duration_min',
    'steps', 'distance_m', 'kcal', 'segments', 'device_code',
  ]);

  function workoutHash(input) {
    return sha256Hex(canonicalJson(WORKOUT_FIELDS.map(field => input?.[field] ?? null)));
  }

  function writeWorkout(row, fetchedAt) {
    const stored = Object.fromEntries(WORKOUT_FIELDS.map(field => [field, null]));
    Object.assign(stored, {
      start_at: row.startAt,
      end_at: row.endAt,
      sport_type_raw: row.sportTypeRaw,
      sport_type_label: row.sportTypeLabel,
      duration_min: row.durationMin,
      steps: row.steps,
      distance_m: row.distanceM,
      kcal: row.kcal,
      segments: row.segments,
      device_code: row.deviceCode,
    });
    const existing = db.get(
      `SELECT * FROM health_workout_sessions
        WHERE source_id = ? AND source_record_key = ? ORDER BY revision DESC LIMIT 1`,
      [sourceId, row.sourceRecordKey],
    );
    if (existing && workoutHash(existing) === workoutHash(stored)) return 'skipped';
    const revision = existing ? Number(existing.revision) + 1 : 1;
    const id = `wkt_${shortHash(`${sourceId}|${row.sourceRecordKey}|${revision}`)}`;
    db.run(
      `INSERT INTO health_workout_sessions
         (id, source_id, source_record_key, start_at, end_at, sport_type_raw, sport_type_label,
          sport_type_mapping, duration_min, steps, distance_m, kcal, segments, device_code,
          quality, raw_ref, fetched_at, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      [id, sourceId, row.sourceRecordKey, row.startAt, row.endAt, row.sportTypeRaw,
        row.sportTypeLabel, row.sportTypeMapping, row.durationMin, row.steps, row.distanceM,
        row.kcal, row.segments, row.deviceCode, row.quality, fetchedAt, revision],
    );
    return existing ? 'updated' : 'inserted';
  }

  const DEVICE_FIELDS = Object.freeze([
    'device_code', 'name', 'device_class', 'product_id', 'prod_id', 'device_type_id',
    'unique_id_hash', 'dev_id_hash', 'status', 'priority', 'is_primary', 'source_updated_at',
  ]);

  function deviceHash(input) {
    return sha256Hex(canonicalJson(DEVICE_FIELDS.map(field => input?.[field] ?? null)));
  }

  function writeDevice(row, fetchedAt) {
    const stored = {
      device_code: row.deviceCode,
      name: row.name,
      device_class: row.deviceClass,
      product_id: row.productId,
      prod_id: row.prodId,
      device_type_id: row.deviceTypeId,
      unique_id_hash: row.uniqueIdHash,
      dev_id_hash: row.devIdHash,
      status: row.status,
      priority: row.priority,
      is_primary: row.isPrimary ? 1 : 0,
      source_updated_at: row.sourceUpdatedAt,
    };
    const identity = row.deviceCode ?? row.uniqueIdHash ?? row.name ?? 'unknown';
    const id = `dev_${shortHash(`${sourceId}|${identity}`)}`;
    const existing = db.get('SELECT * FROM health_devices WHERE id = ?', [id]);
    if (existing && deviceHash(existing) === deviceHash(stored)) return 'skipped';
    if (existing) {
      db.run(
        `UPDATE health_devices SET
           device_code = ?, name = ?, device_class = ?, product_id = ?, prod_id = ?,
           device_type_id = ?, unique_id_hash = ?, dev_id_hash = ?, status = ?, priority = ?,
           is_primary = ?, source_updated_at = ?, fetched_at = ?, revision = revision + 1
         WHERE id = ?`,
        [...DEVICE_FIELDS.map(field => stored[field]), fetchedAt, id],
      );
      return 'updated';
    }
    db.run(
      `INSERT INTO health_devices
         (id, source_id, device_code, name, device_class, product_id, prod_id, device_type_id,
          unique_id_hash, dev_id_hash, status, priority, is_primary, source_updated_at,
          raw_ref, fetched_at, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 1)`,
      [id, sourceId, ...DEVICE_FIELDS.map(field => stored[field]), fetchedAt],
    );
    return 'inserted';
  }

  function storedSleepSignature(row, stages) {
    return sleepContentHash({
      sleepDate: row.sleep_date,
      startAt: row.start_at,
      endAt: row.end_at,
      asleepMinutes: row.asleep_minutes,
      awakeMinutes: row.awake_minutes,
      inBedMinutes: row.in_bed_minutes,
      deepMinutes: row.deep_minutes,
      lightMinutes: row.light_minutes,
      remMinutes: row.rem_minutes,
      stageFidelity: row.stage_fidelity,
      status: row.status,
      isNap: row.is_nap,
      sourceScore: row.source_score,
      stages: stages.map(stage => ({
        stage: stage.stage,
        startAt: stage.start_at,
        endAt: stage.end_at,
      })),
    });
  }

  function writeSleepSession(session, fetchedAt) {
    const existing = db.get(
      `SELECT * FROM health_sleep_sessions
        WHERE source_id = ? AND source_record_key = ? ORDER BY revision DESC LIMIT 1`,
      [sourceId, session.sourceRecordKey],
    );
    if (existing) {
      const storedStages = db.all(
        'SELECT stage, start_at, end_at FROM health_sleep_stages WHERE session_id = ? ORDER BY stage_index ASC',
        [existing.id],
      );
      if (storedSleepSignature(existing, storedStages) === session.contentHash) {
        return { outcome: 'skipped', id: existing.id, sleepDate: existing.sleep_date, endAt: existing.end_at };
      }
    }
    const revision = existing ? Number(existing.revision) + 1 : 1;
    const id = sleepSessionId(sourceId, session.sourceRecordKey, revision);
    db.run(
      `INSERT INTO health_sleep_sessions
         (id, canonical_group_id, source_id, source_record_key, start_at, end_at, sleep_date,
          timezone_id, asleep_minutes, awake_minutes, in_bed_minutes, deep_minutes, light_minutes,
          rem_minutes, stage_coverage, stage_fidelity, session_quality, status, is_nap,
          source_score, source_score_label, raw_ref, fetched_at, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      [id, session.canonicalGroupId, sourceId, session.sourceRecordKey, session.startAt,
        session.endAt, session.sleepDate, session.timezoneId, session.asleepMinutes,
        session.awakeMinutes, session.inBedMinutes, session.deepMinutes, session.lightMinutes,
        session.remMinutes, session.stageCoverage, session.stageFidelity, session.sessionQuality,
        session.status, session.isNap, session.sourceScore, session.sourceScoreLabel,
        fetchedAt, revision],
    );
    for (const stage of session.stages) {
      db.run(
        `INSERT INTO health_sleep_stages
           (session_id, stage_index, stage, start_at, end_at, source_stage_code, fidelity)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, stage.stageIndex, stage.stage, stage.startAt, stage.endAt,
          stage.sourceStageCode, stage.fidelity],
      );
    }
    return {
      outcome: existing ? 'updated' : 'inserted',
      id,
      sleepDate: session.sleepDate,
      endAt: session.endAt,
    };
  }

  function writeSummary(metricKind, localDate, summary) {
    const json = JSON.stringify(summary);
    const hash = sha256Hex(canonicalJson(summary));
    const existing = db.get(
      `SELECT origin_hash FROM health_daily_summaries
        WHERE owner_scope = ? AND local_date = ? AND timezone_id = ? AND metric_kind = ?`,
      [ownerScope, localDate, TZ, metricKind],
    );
    if (existing && String(existing.origin_hash) === hash) return 'skipped';
    db.run(
      `INSERT INTO health_daily_summaries
         (owner_scope, local_date, timezone_id, metric_kind, summary_json, origin_hash, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner_scope, local_date, timezone_id, metric_kind) DO UPDATE SET
         summary_json = excluded.summary_json,
         origin_hash = excluded.origin_hash,
         updated_at = excluded.updated_at`,
      [ownerScope, localDate, TZ, metricKind, json, hash, clock()],
    );
    return existing ? 'updated' : 'inserted';
  }

  /**
   * One `health_raw_refs` row per run: the redacted payload, or only its hash and
   * size above 256KB. Counted separately from items — it is a receipt, not data.
   */
  function writeRawRef(normalized, payload, fetchedAt, faults) {
    let json = null;
    let bytes = 0;
    try {
      assertNoSecrets(payload, 'raw-ref');
      json = JSON.stringify(payload ?? {});
      bytes = Buffer.byteLength(json, 'utf8');
      if (bytes > RAW_PAYLOAD_LIMIT_BYTES) json = null;
    } catch (error) {
      // A payload that fails the secret scan is never stored. The derived rows are
      // already written from the redacted object, so the run itself stays useful.
      json = null;
      bytes = 0;
      faults.push({ code: 'raw-ref-rejected', message: shortText(error?.message) });
    }
    const id = `raw_${shortHash(`${sourceId}|${normalized.rawHash}|${fetchedAt}`)}`;
    db.run(
      `INSERT OR REPLACE INTO health_raw_refs
         (id, source_id, kind, hash, fetched_at, bytes, redacted, payload_json)
       VALUES (?, ?, 'window', ?, ?, ?, 1, ?)`,
      [id, sourceId, normalized.rawHash, fetchedAt, bytes, json],
    );
  }

  /**
   * Observations implied by one health-day record: one row per metric family.
   *
   * Kept per-day rather than flattened because the *day* is the item an operator
   * counts; four observation rows from one day is an implementation detail.
   */
  function dayObservationCandidates(day, fetchedAt) {
    if (day.observedAt == null) return [];
    const rows = [];
    const sourceKey = `day:${day.localDate}`;
    const base = {
      granularity: 'day', sampleAt: day.observedAt, sourceKey,
      quality: day.quality, fetchedAt, sourceUpdatedAt: null,
    };
    if (hasValues(day.heartRate)) {
      rows.push({
        ...base,
        kind: 'heart_rate',
        value: day.heartRate.avg ?? day.heartRate.max ?? day.heartRate.min,
        unit: 'bpm',
        values: { ...day.heartRate },
      });
    }
    if (day.heartRate?.resting != null) {
      rows.push({
        ...base,
        kind: 'resting_heart_rate',
        value: day.heartRate.resting,
        unit: 'bpm',
        values: { resting: day.heartRate.resting },
      });
    }
    if (hasValues(day.stress)) {
      rows.push({
        ...base,
        kind: 'stress',
        value: day.stress.avg ?? day.stress.last,
        unit: '',
        values: { ...day.stress },
      });
    }
    if (hasValues(day.spo2)) {
      rows.push({
        ...base,
        kind: 'spo2',
        value: day.spo2.avg ?? day.spo2.last,
        unit: '%',
        values: { ...day.spo2 },
      });
    }
    if (day.intensity?.moderateHighMinutes != null) {
      rows.push({
        ...base,
        kind: 'intensity',
        value: day.intensity.moderateHighMinutes,
        unit: 'min',
        values: { ...day.intensity },
      });
    }
    return rows;
  }

  /** The three "last uploaded" points — one item each, with their own identity. */
  function realtimeObservationCandidates(normalized, fetchedAt) {
    const rows = [];
    for (const [bucket, sample] of Object.entries(normalized.realtime)) {
      const kind = REALTIME_KIND[bucket];
      if (!kind || !sample || sample.value == null || sample.at == null) continue;
      rows.push({
        kind,
        granularity: 'point',
        sampleAt: sample.at,
        sourceKey: `rt:${kind}`,
        value: sample.value,
        unit: sample.unit,
        values: { value: sample.value, unit: sample.unit, device: sample.device, at: sample.at },
        quality: sample.quality,
        fetchedAt,
        sourceUpdatedAt: null,
      });
    }
    return rows;
  }

  /** One item per source record: its own observations win over a same-content replay. */
  function combineOutcomes(outcomes) {
    if (outcomes.includes('inserted')) return 'inserted';
    if (outcomes.includes('updated')) return 'updated';
    return 'skipped';
  }

  // --- the run --------------------------------------------------------------

  function finalize({ runId, status, counters, errorCode, startedAt, faults, nextAllowed, detail }) {
    const finishedAt = clock();
    try {
      db.run(
        `UPDATE health_sync_runs SET
           finished_at = ?, status = ?, items_seen = ?, inserted = ?, updated = ?, skipped = ?,
           next_allowed_at = ?, error_code = ?, detail_json = ?
         WHERE id = ?`,
        [finishedAt, status, counters.itemsSeen, counters.inserted, counters.updated,
          counters.skipped, nextAllowed, errorCode, JSON.stringify(detail ?? {}), runId],
      );
      if (status === 'ok' || status === 'partial') {
        db.run(
          `UPDATE health_sources
              SET last_success_at = ?, last_error_code = NULL, capabilities_json = ?
            WHERE id = ?`,
          [finishedAt, JSON.stringify(DECLARED_CAPABILITIES), sourceId],
        );
        db.setMeta('lastSuccessfulSyncAt', String(finishedAt));
        if (!db.meta('firstSyncAt')) db.setMeta('firstSyncAt', String(finishedAt));
      } else if (errorCode) {
        db.run('UPDATE health_sources SET last_error_code = ? WHERE id = ?', [errorCode, sourceId]);
      }
    } catch (error) {
      faults.push({ code: 'run-finalize-failed', message: shortText(error?.message) });
    }
    return {
      runId,
      status,
      itemsSeen: counters.itemsSeen,
      inserted: counters.inserted,
      updated: counters.updated,
      skipped: counters.skipped,
      errorCode,
      startedAt,
      finishedAt,
      faults: faults.slice(0, MAX_FAULTS),
    };
  }

  async function runSync({ days, force, reason, startedAt }) {
    const windowDays = clampDays(days ?? defaultDays);
    const runId = `sync_${startedAt.toString(36)}_${(sequence += 1).toString(36)}`;
    const counters = { itemsSeen: 0, inserted: 0, updated: 0, skipped: 0, rawRefs: 0, faults: [] };
    const faults = counters.faults;
    let status = 'ok';
    let errorCode = null;
    let nextAllowed = null;

    try {
      db.run(
        `INSERT INTO health_sync_runs
           (id, source_id, started_at, finished_at, status, items_seen, inserted, updated,
            skipped, next_allowed_at, error_code, detail_json)
         VALUES (?, ?, ?, NULL, 'partial', 0, 0, 0, 0, NULL, NULL, ?)`,
        [runId, sourceId, startedAt, JSON.stringify({ reason: String(reason ?? 'poll'), days: windowDays })],
      );
    } catch (error) {
      // Cannot even record the attempt: report it, do not throw at the caller.
      return {
        runId: null,
        status: 'error',
        itemsSeen: 0,
        inserted: 0,
        updated: 0,
        skipped: 0,
        errorCode: 'db-unavailable',
        startedAt,
        finishedAt: clock(),
        faults: [{ code: 'db-unavailable', message: shortText(error?.message) }],
      };
    }

    try {
      ensureSourceRow();
      const response = await adapter.fetchWindow({ days: windowDays, force: Boolean(force) });

      if (!response || response.ok !== true) {
        const httpStatus = Number(response?.httpStatus ?? 0);
        const limited = httpStatus === 429;
        status = limited ? 'rate_limited' : 'error';
        // A 429 is a rate limit whatever the adapter called it; keep the transport
        // code only for the non-limit failures.
        errorCode = limited ? 'rate-limited' : String(response?.errorCode ?? 'unreachable');
        if (limited) nextAllowed = clock() + backoffMs();
        faults.push({
          code: errorCode,
          message: limited ? '上游返回 429，已进入退避' : '本地 sidecar 取数失败',
        });
      } else {
        const nowMs = clock();
        const fetchedAt = Number.isFinite(Number(response.fetchedAt)) ? Number(response.fetchedAt) : nowMs;
        const normalized = normalizeWindow(response.payload, { nowMs, fetchedAt, sourceId, timezone: TZ });
        const sidecarFaults = normalized.errors.map(errorToFault);

        if (isRateLimitText(normalized.errors) || isRateLimitText(response.errors)) {
          status = 'rate_limited';
          errorCode = 'rate-limited';
          nextAllowed = clock() + backoffMs();
          faults.push({ code: 'rate-limited', message: '上游报告 1101（Too Many Requests），已进入退避' });
        } else if (sidecarFaults.length) {
          status = 'partial';
          errorCode = sidecarFaults[0].code;
          faults.push(...sidecarFaults);
        }

        const sessions = normalizeSleepRows(normalized.sleepRows, { nowMs, fetchedAt, sourceId, tz: TZ });
        const realtimePoints = realtimeObservationCandidates(normalized, fetchedAt);

        // One transaction for the whole window: a half-written window would be a
        // lie about what the cloud said.
        const writeResult = db.tx(() => {
          const inner = { itemsSeen: 0, inserted: 0, updated: 0, skipped: 0, rawRefs: 0, faults: [] };
          const tally = outcome => {
            inner.itemsSeen += 1;
            if (outcome === 'inserted') inner.inserted += 1;
            else if (outcome === 'updated') inner.updated += 1;
            else inner.skipped += 1;
          };

          // 1. Activity days (one summary each) — the item is the day.
          for (const day of normalized.daily) {
            tally(writeSummary('activity', day.localDate, {
              steps: day.steps,
              distanceM: day.distanceM,
              kcal: day.kcal,
              activeHours: day.activeHours,
              exerciseMin: day.exerciseMin,
              walkMin: day.walkMin,
              stepGoal: day.stepGoal,
              sportTypeRaw: day.sportTypeRaw,
              quality: day.quality,
              observedAt: day.observedAt,
            }));
          }

          // 2. Health days: one summary plus its metric observations, one item.
          for (const day of normalized.healthDays) {
            const outcomes = [writeSummary('health_day', day.localDate, {
              heartRate: day.heartRate,
              stress: day.stress,
              spo2: day.spo2,
              intensity: day.intensity,
              sleepPresent: day.sleep.present,
              quality: day.quality,
              observedAt: day.observedAt,
            })];
            for (const row of dayObservationCandidates(day, fetchedAt)) {
              outcomes.push(writeObservation(row));
            }
            tally(combineOutcomes(outcomes));
          }

          // 3. Realtime points: each uploaded sample is its own item.
          for (const row of realtimePoints) tally(writeObservation(row));

          // 4. Workouts and devices.
          for (const row of normalized.workouts) tally(writeWorkout(row, fetchedAt));
          for (const row of normalized.devices) tally(writeDevice(row, fetchedAt));

          // 5. Sleep nights (plus their per-date roll-up summary, which is derived).
          const sleepByDate = new Map();
          for (const session of sessions) {
            const written = writeSleepSession(session, fetchedAt);
            tally(written.outcome);
            const entry = sleepByDate.get(session.sleepDate) ?? {
              sessionIds: [], newestEndAt: null, sessions: 0, asleepMinutes: null,
            };
            entry.sessionIds.push(written.id);
            entry.sessions += 1;
            // Nap minutes do not count towards a night's sleep debt.
            if (session.isNap !== 1 && session.asleepMinutes != null) {
              entry.asleepMinutes = (entry.asleepMinutes ?? 0) + session.asleepMinutes;
            }
            if (session.endAt != null && (entry.newestEndAt == null || session.endAt > entry.newestEndAt)) {
              entry.newestEndAt = session.endAt;
            }
            sleepByDate.set(session.sleepDate, entry);
          }
          for (const [sleepDate, entry] of sleepByDate) {
            writeSummary('sleep_day', sleepDate, {
              sessions: entry.sessions,
              newestEndAt: entry.newestEndAt,
              asleepMinutes: entry.asleepMinutes,
              sessionIds: entry.sessionIds.slice(0, 20),
              availability: classifyAvailability({
                sessionCount: entry.sessions,
                newestEndAt: entry.newestEndAt,
                nowMs,
              }),
            });
          }

          // 6. The receipt. Counted on its own: it is not a health item.
          writeRawRef(normalized, response.payload, fetchedAt, inner.faults);
          inner.rawRefs = 1;
          return inner;
        });

        counters.itemsSeen = writeResult.itemsSeen;
        counters.inserted = writeResult.inserted;
        counters.updated = writeResult.updated;
        counters.skipped = writeResult.skipped;
        counters.rawRefs = writeResult.rawRefs;
        faults.push(...writeResult.faults.slice(0, MAX_FAULTS));

        // Auth state is a fact about the window, not our opinion.
        if (status === 'ok' || status === 'partial') {
          const tokenStatus = response.redactedToken?.status ?? 'unknown';
          db.run('UPDATE health_sources SET auth_status = ? WHERE id = ?', [String(tokenStatus), sourceId]);
        }
      }
    } catch (error) {
      status = 'error';
      errorCode = errorCode ?? 'internal-error';
      faults.push({ code: 'internal-error', message: shortText(error?.message) });
    }

    const result = finalize({
      runId,
      status,
      counters,
      errorCode,
      startedAt,
      faults,
      nextAllowed,
      detail: {
        reason: String(reason ?? 'poll'),
        days: windowDays,
        // Derived rows deliberately excluded from the item counters above, so
        // itemsSeen === inserted + updated + skipped stays an exact identity.
        rawRefs: counters.rawRefs ?? 0,
        faults: faults.slice(0, MAX_FAULTS).map(fault => fault.code),
      },
    });
    emit('health.sync', {
      runId: result.runId,
      status: result.status,
      itemsSeen: result.itemsSeen,
      inserted: result.inserted,
      updated: result.updated,
      skipped: result.skipped,
      errorCode: result.errorCode,
    });
    return result;
  }

  async function syncOnce({ days, force = false, reason = 'poll' } = {}) {
    const startedAt = clock();
    if (inFlight) return skipResult(startedAt, 'busy');
    const gate = nextAllowedAt();
    if (gate != null && startedAt < gate) return skipResult(startedAt, 'rate-limited');

    const promise = runSync({ days, force, reason, startedAt })
      .then(value => value)
      .finally(() => {
        inFlight = null;
      });
    inFlight = promise;
    return promise;
  }

  return {
    syncOnce,
    cooldownUntil,
    nextAllowedAt,
    isRateLimited,
    consecutiveFailures,
    /** True while a run is in flight — the service heartbeat reports this. */
    isRunning() {
      return inFlight != null;
    },
    sourceId,
  };
}
