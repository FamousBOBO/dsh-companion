// companion-health: status assembly (contract §11.1) + a protocol-level probe summary.
//
// This module deliberately has **no imports from `lib/*`**: it is pure assembly over an already
// opened database handle plus a few injected pure functions owned by health-core
// (`freshnessOf`, `classifyAvailability`, `newestSampleAt`). That way a missing health-core module
// can never make this file fail to load, and the service can still report an honest
// "database unavailable" instead of crashing the host.
//
// Every `ok:false` in this project is `{ ok:false, code, message }` with a short Chinese message
// (contract §11 preamble). Exceptions never escape; a failed read degrades to a reported fault.

export const STATUS_FAULT_LIMIT = 5;
/** Recent sync runs inspected for faults (a little more than we report, for dedupe). */
const RUN_SCAN_LIMIT = 10;

export const FRESHNESS_STATUSES = Object.freeze(['fresh', 'delayed', 'stale', 'no_data', 'error']);
export const AUTH_STATUSES = Object.freeze(['valid', 'expiring', 'expired', 'unknown', 'required']);
export const SLEEP_AVAILABILITY = Object.freeze(['awaiting_first_night', 'no_data', 'partial', 'present']);

/** Upstream codes that mean "the cloud no longer accepts our credentials". */
const AUTH_ERROR_CODES = Object.freeze([
  '1002', '1004', '1005', '20020001', '20020003', '20010004', 'auth-required', 'unauthorized',
]);

/**
 * Failures that say nothing about the credentials — the source was not reachable at all.
 *
 * 观测到的真实误报（2026-11-04 00:41）：宿主重启把 sidecar 一起带走了 3 小时，
 * `health_meta.auth_snapshot` 停在 21:25（`expiresAt` 21:54），于是 `expired` 规则生效，
 * 体检输出「已过期，需要重新登录」。而 sidecar 一起来就用 refresh token 续到了 01:40，
 * 主人根本不需要做任何事。**传输层失败时不假装知道鉴权状态**：报 `unknown` 并说明原因，
 * 等下一次成功同步刷新快照。
 */
const TRANSPORT_ERROR_CODES = Object.freeze([
  'unreachable', 'timeout', 'http-error', 'bad-json', 'non-loopback-refused',
]);

/**
 * Chinese short messages for a fault. Never carries payload content: `code` comes either from the
 * adapter's fixed enum or from an upstream numeric code recorded by the ingest layer.
 */
const FAULT_MESSAGES = Object.freeze({
  'non-loopback-refused': '健康源地址不是本机回环地址，采集被拒绝',
  timeout: '访问健康数据服务超时',
  unreachable: '连不上本机健康数据服务（sidecar 可能没在运行）',
  'http-error': '健康数据服务返回了异常状态码',
  'bad-json': '健康数据服务返回的内容不是合法 JSON',
  'auth-required': '华为云鉴权已失效，需要重新登录一次',
  'rate-limited': '华为云限流，正在退避等待',
  busy: '已有一次采集正在进行，本轮跳过',
  'db-unavailable': '健康数据库不可用',
  'db-integrity-failed': '健康数据库完整性校验未通过',
  'db-integrity-unknown': '健康数据库尚未做过完整性校验',
  'consecutive-failures': '连续多次采集失败',
  partial: '本次采集只成功了一部分',
  error: '本次采集失败',
  'rate_limited': '华为云限流，正在退避等待',
  skipped: '本次采集被跳过',
});

function faultMessage(code) {
  const key = String(code ?? '');
  if (FAULT_MESSAGES[key]) return FAULT_MESSAGES[key];
  // An upstream numeric code is a fact, not payload: keep it verbatim but readable.
  return /^\d+$/.test(key) ? `采集失败（上游错误码 ${key}）` : `采集失败（${key || '未知原因'}）`;
}

function iso(ms) {
  if (ms === undefined || ms === null || ms === '') return null;
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const date = new Date(n);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** First 4 characters + ellipsis. The only permitted way to show an account id anywhere. */
export function maskUid(value) {
  const text = String(value ?? '');
  if (!text) return null;
  const head = text.slice(0, 4);
  return text.length > 4 ? `${head}…` : `${head}…`;
}

function safe(fn, fallback = null) {
  try {
    const value = fn();
    return value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pickText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/**
 * Fallback freshness thresholds, used **only** when health-core's `freshnessOf` is not injected
 * (which cannot happen after a successful `initialize()`, since `normalize.mjs` is required there).
 */
function fallbackFreshness(newestMs, nowMs) {
  if (!Number.isFinite(Number(newestMs)) || Number(newestMs) <= 0) return 'no_data';
  const ageMin = Math.max(0, (Number(nowMs) - Number(newestMs)) / 60000);
  if (ageMin <= 90) return 'fresh';
  if (ageMin <= 24 * 60) return 'delayed';
  return 'stale';
}

function zerosStats() {
  return {
    observations: 0, workouts: 0, devices: 0, dailySummaries: 0,
    sleepSessions: 0, sleepStages: 0, rawRefs: 0, syncRuns: 0,
    careCandidates: 0, sizeBytes: 0,
  };
}

/**
 * Assemble `status()` (contract §11.1).
 *
 * @param {object} input
 * @param {object} input.db                  opened health DB handle (contract §3)
 * @param {object} input.config              validated config
 * @param {object|null} input.ingest         `createIngest()` handle (contract §8)
 * @param {boolean} input.running            polling loop state
 * @param {string|null} input.dbPath
 * @param {{state:string, at:number|null, quickCheck:string|null}|null} input.integrity
 * @param {object|null} input.auth           `{status, expiresAt, refreshExpiresAt, minutesLeft, rotated}`
 * @param {object|null} input.consents       `{ [capability]: boolean }`
 * @param {Function|null} input.classifyAvailability
 * @param {Function|null} input.freshnessOf
 * @param {Function|null} input.newestSampleAt
 * @param {number} [input.schemaVersion]
 * @param {number} [input.nowMs]
 * @param {number} [input.faultLimit]
 * @param {object|null} [input.readiness]     `buildReadiness()` 的结论（见 `lib/readiness.mjs`）；
 *                                            调用方给什么就原样透出，这里不重新判定
 */
export function buildStatus(input = {}) {
  const {
    db, config, ingest = null, running = false, dbPath = null,
    integrity = null, auth = null, consents = null,
    classifyAvailability = null, freshnessOf = null, newestSampleAt = null,
    schemaVersion = 1, nowMs = Date.now(), faultLimit = STATUS_FAULT_LIMIT,
    readiness = null,
  } = input;

  const now = Number(nowMs);
  const sourceId = String(config?.source ?? 'huawei-cn');
  const stats = safe(() => db.stats(), null) ?? zerosStats();

  const sourceRow = safe(() => db.get('SELECT * FROM health_sources WHERE id = ?', [sourceId]), null);
  const runs = safe(() => db.all(
    `SELECT id, status, started_at, finished_at, items_seen, inserted, updated, skipped,
            next_allowed_at, error_code
       FROM health_sync_runs ORDER BY started_at DESC LIMIT ?`, [RUN_SCAN_LIMIT],
  ), []) ?? [];

  // ---- newest sample -------------------------------------------------------------------------
  let newest = null;
  if (typeof newestSampleAt === 'function') newest = safe(() => newestSampleAt(), null);
  if (newest === null || newest === undefined) {
    // Bounded fallback: same question, asked directly. Observations are the primary sample store;
    // workouts and sleep sessions count as samples too (a day may only have a workout).
    const row = safe(() => db.get(
      `SELECT MAX(t) AS t FROM (
         SELECT MAX(sample_at) AS t FROM health_observations
         UNION ALL SELECT MAX(start_at) FROM health_workout_sessions
         UNION ALL SELECT MAX(COALESCE(end_at, start_at)) FROM health_sleep_sessions)`,
      [],
    ), null);
    newest = numberOrNull(row?.t);
  }
  const newestMs = numberOrNull(newest);

  const lastRun = runs[0] ?? null;
  let freshnessStatus = newestMs === null
    ? (String(lastRun?.status ?? '') === 'error' ? 'error' : 'no_data')
    : (typeof freshnessOf === 'function' ? safe(() => freshnessOf(newestMs, now), null) : null);
  if (!FRESHNESS_STATUSES.includes(String(freshnessStatus))) {
    freshnessStatus = newestMs === null ? 'no_data' : fallbackFreshness(newestMs, now);
  }
  const ageMinutes = newestMs === null ? null : Math.max(0, Math.round(((now - newestMs) / 60000) * 10) / 10);

  // ---- auth ----------------------------------------------------------------------------------
  let authStatus = 'unknown';
  if (auth && AUTH_STATUSES.includes(String(auth.status))) authStatus = String(auth.status);
  const expiresAtMs = numberOrNull(auth?.expiresAt);
  if (expiresAtMs !== null && expiresAtMs <= now && authStatus !== 'required') authStatus = 'expired';
  const lastErrorCode = sourceRow?.last_error_code ? String(sourceRow.last_error_code) : null;
  // Precedence matters: an auth code means the cloud really rejected us; a transport code means we
  // never got to ask, so a snapshot's `expiresAt` is the only thing we have and it may be hours old
  // (the sidecar can have rotated the pair in the meantime) — reporting `expired / 需要重新登录`
  // there sends the owner chasing a login that is not needed.
  if (AUTH_ERROR_CODES.includes(String(lastErrorCode ?? ''))) authStatus = 'required';
  else if (TRANSPORT_ERROR_CODES.includes(String(lastErrorCode ?? ''))) authStatus = 'unknown';
  // minutesLeft is recomputed from the absolute expiry when we have one: a frozen number copied at
  // fetch time would keep saying "58 minutes left" hours later.
  const minutesLeft = expiresAtMs !== null
    ? Math.max(0, Math.round((expiresAtMs - now) / 60000))
    : numberOrNull(auth?.minutesLeft);

  const lastSuccessAt = iso(sourceRow?.last_success_at ?? runs.find(run => String(run.status) === 'ok')?.finished_at);

  // ---- collector -----------------------------------------------------------------------------
  const cooldown = safe(() => (typeof ingest?.cooldownUntil === 'function' ? ingest.cooldownUntil() : null), null);
  const rateLimited = safe(() => (typeof ingest?.isRateLimited === 'function' ? ingest.isRateLimited() === true : false), false) === true;
  const collector = {
    mode: String(config?.collector?.mode ?? 'local_http'),
    baseUrl: String(config?.collector?.baseUrl ?? ''),
    pollMinutes: numberOrNull(config?.collector?.pollMinutes),
    windowDays: numberOrNull(config?.collector?.windowDays),
    running: running === true,
    singleFlight: config?.collector?.singleFlight !== false,
    lastRunAt: iso(lastRun?.finished_at ?? lastRun?.started_at),
    nextAllowedAt: iso(safe(() => (typeof ingest?.nextAllowedAt === 'function' ? ingest.nextAllowedAt() : null), null)),
    consecutiveFailures: numberOrNull(safe(() => (typeof ingest?.consecutiveFailures === 'function' ? ingest.consecutiveFailures() : 0), 0)) ?? 0,
    cooldownUntil: iso(cooldown),
    rateLimitedUntil: rateLimited ? iso(cooldown) : null,
  };

  // ---- db ------------------------------------------------------------------------------------
  const integrityState = ['ok', 'failed', 'unknown'].includes(String(integrity?.state))
    ? String(integrity.state)
    : 'unknown';
  const dbBlock = {
    path: dbPath ? String(dbPath) : null,
    journalMode: String(safe(() => db.journalMode, null) ?? 'wal'),
    integrity: integrityState,
    sizeBytes: numberOrNull(stats.sizeBytes) ?? 0,
    observations: numberOrNull(stats.observations) ?? 0,
    workouts: numberOrNull(stats.workouts) ?? 0,
    devices: numberOrNull(stats.devices) ?? 0,
    dailySummaries: numberOrNull(stats.dailySummaries) ?? 0,
    sleepSessions: numberOrNull(stats.sleepSessions) ?? 0,
    sleepStages: numberOrNull(stats.sleepStages) ?? 0,
  };

  // ---- sleep ---------------------------------------------------------------------------------
  const sleepCount = numberOrNull(safe(() => db.get('SELECT COUNT(*) AS n FROM health_sleep_sessions', [])?.n, 0)) ?? 0;
  const newestSession = safe(() => db.get(
    `SELECT COALESCE(end_at, start_at) AS at, stage_fidelity
       FROM health_sleep_sessions
      ORDER BY COALESCE(end_at, start_at, fetched_at) DESC LIMIT 1`, [],
  ), null);
  // Aggregate-only sessions have no trustworthy instants (contract §7 rule 1); report null rather
  // than inventing one. `sessions` still shows that rows exist.
  const lastSessionAt = iso(newestSession?.at);
  const stageFidelity = newestSession?.stage_fidelity && ['exact', 'partial', 'not_reliable', 'unknown']
    .includes(String(newestSession.stage_fidelity))
    ? String(newestSession.stage_fidelity)
    : null;
  const expectedNights = config?.sleep?.waitForFirstRealNight === false ? 0 : 1;
  let availability = 'no_data';
  if (typeof classifyAvailability === 'function') {
    const verdict = safe(() => classifyAvailability({
      sessionCount: sleepCount,
      newestEndAt: numberOrNull(newestSession?.at),
      expectedNights,
    }), null);
    if (SLEEP_AVAILABILITY.includes(String(verdict))) availability = String(verdict);
  } else if (sleepCount > 0) {
    availability = lastSessionAt ? 'present' : 'partial';
  }
  const sleep = {
    availability,
    sessions: sleepCount,
    lastSessionAt,
    stageFidelity,
    firstNightPending: availability === 'awaiting_first_night',
  };

  // ---- faults --------------------------------------------------------------------------------
  const faults = [];
  const seen = new Set();
  const pushFault = (code, atMs, message = null) => {
    const key = `${code}@${Number(atMs) || 0}`;
    if (seen.has(key)) return;
    seen.add(key);
    faults.push({ code: String(code), message: message ?? faultMessage(code), at: iso(atMs) });
  };
  for (const run of runs.slice(0, faultLimit)) {
    const status = String(run.status ?? '');
    if (!['error', 'partial', 'rate_limited'].includes(status)) continue;
    pushFault(run.error_code ? String(run.error_code) : status, run.finished_at ?? run.started_at);
  }
  if (cooldown && rateLimited && Number(cooldown) > now) {
    pushFault('rate-limited', cooldown, `华为云限流，退避到 ${iso(cooldown)}`);
  }
  if (collector.consecutiveFailures >= 3) {
    pushFault('consecutive-failures', lastRun?.finished_at ?? lastRun?.started_at,
      `连续 ${collector.consecutiveFailures} 次采集失败`);
  }
  if (integrityState === 'failed') pushFault('db-integrity-failed', integrity?.at ?? now);
  if (lastErrorCode && !faults.some(fault => fault.code === lastErrorCode)) {
    pushFault(lastErrorCode, sourceRow?.last_success_at ?? lastRun?.finished_at ?? now);
  }

  return {
    ok: true,
    schemaVersion: Number(schemaVersion) || 1,
    generatedAt: iso(now),
    source: {
      id: sourceId,
      provider: String(config?.provider ?? 'huawei_cn_cloud'),
      displayName: String(config?.displayName ?? '华为运动健康（CN 云）'),
      enabled: config?.enabled === true,
      auth: {
        status: authStatus,
        expiresAt: iso(expiresAtMs),
        refreshExpiresAt: iso(numberOrNull(auth?.refreshExpiresAt)),
        minutesLeft,
        rotated: typeof auth?.rotated === 'boolean' ? auth.rotated : null,
      },
      lastSuccessAt,
      lastErrorCode,
      freshness: {
        status: freshnessStatus,
        newestSampleAt: iso(newestMs),
        ageMinutes,
      },
    },
    collector,
    db: dbBlock,
    sleep,
    // 三通道「诚实状态」（未配置 / 不可用 / 未启用 / 正常）。由 service 用 `buildReadiness()` 算好
    // 再透出：这里只有组装权，没有判定权 —— 免得同一个事实在两处各说一套。
    readiness: readiness && typeof readiness === 'object' ? readiness : null,
    consents: consents && typeof consents === 'object' ? { ...consents } : {},
    faults: faults.slice(0, Math.max(1, Number(faultLimit) || STATUS_FAULT_LIMIT)),
  };
}

/**
 * A **protocol-level** summary of `GET /api/data?days=N` for the acceptance script's `--probe`.
 *
 * This is not normalisation (health-core owns that, contract §6): it only reads the fields the
 * sidecar documents (`sidecars/huawei-health-cn/README.md` §8) so an operator can compare the live
 * link against what was stored. It never returns device codes, `uniqueId`, `devId`, MACs or tokens.
 */
export function summarizeProbePayload(payload) {
  const data = payload && typeof payload === 'object' ? payload : {};
  const dailyRows = Array.isArray(data.daily) ? data.daily : [];
  const healthRows = Array.isArray(data.health) ? data.health : [];
  const sleepRows = Array.isArray(data.sleep_rows) ? data.sleep_rows : [];
  const sessions = Array.isArray(data.sessions) ? data.sessions : [];
  const devices = Array.isArray(data.devices) ? data.devices : [];

  const pickDaily = () => {
    if (!dailyRows.length) return null;
    const sorted = [...dailyRows].sort((a, b) => String(a?.date ?? '').localeCompare(String(b?.date ?? '')));
    // sport_type 0 is the day total row; prefer it on the newest date that has one.
    const totals = sorted.filter(row => Number(row?.sport_type) === 0);
    return totals.length ? totals[totals.length - 1] : sorted[sorted.length - 1];
  };
  const pickHealth = () => {
    if (!healthRows.length) return null;
    return [...healthRows].sort((a, b) => String(a?.date ?? '').localeCompare(String(b?.date ?? ''))).pop();
  };
  const row = pickDaily();
  const health = pickHealth();
  const realtime = data.realtime && typeof data.realtime === 'object' ? data.realtime : {};
  const rt = (key) => {
    const entry = realtime[key];
    if (!entry || typeof entry !== 'object') return null;
    const value = numberOrNull(entry.value);
    if (value === null) return null;
    const at = numberOrNull(entry.at);
    return {
      value,
      unit: entry.unit === undefined || entry.unit === null ? '' : String(entry.unit),
      at: at === null ? null : iso(at > 1e12 ? at : at * 1000),
      atText: entry.at_text ? String(entry.at_text) : null,
    };
  };

  return {
    syncedAt: numberOrNull(data.synced_at) === null ? null : iso(Number(data.synced_at) * 1000),
    syncedAtText: data.synced_at_text ? String(data.synced_at_text) : null,
    totalMs: numberOrNull(data.total_ms),
    calls: Array.isArray(data.calls) ? data.calls.length : 0,
    window: numberOrNull(data?.scope?.days),
    daily: row ? {
      days: dailyRows.length,
      lastDate: row.date ? String(row.date) : null,
      steps: numberOrNull(row.steps),
      distanceM: numberOrNull(row.distance_m),
      kcal: numberOrNull(row.kcal),
      activeHours: numberOrNull(row.active_hours),
      exerciseMin: numberOrNull(row.exercise_min),
      stepGoal: numberOrNull(row.step_goal),
    } : { days: 0, lastDate: null, steps: null, distanceM: null, kcal: null, activeHours: null, exerciseMin: null, stepGoal: null },
    health: {
      rows: healthRows.length,
      lastDate: health?.date ? String(health.date) : null,
      heartRate: health ? {
        avg: numberOrNull(health.heart_rate),
        max: numberOrNull(health.max_heart_rate),
        min: numberOrNull(health.min_heart_rate),
        resting: numberOrNull(health.resting_heart_rate),
      } : null,
      stress: health ? {
        avg: numberOrNull(health.stress_average),
        max: numberOrNull(health.stress_max),
        min: numberOrNull(health.stress_min),
        last: numberOrNull(health.stress_last),
        measurements: numberOrNull(health.stress_measurements),
      } : null,
      spo2: health ? {
        avg: numberOrNull(health.spo2_avg),
        max: numberOrNull(health.spo2_max),
        min: numberOrNull(health.spo2_min),
        last: numberOrNull(health.spo2_last),
      } : null,
      intensity: health ? { moderateHighMinutes: numberOrNull(health.moderate_high_intensity_minutes) } : null,
    },
    realtime: { heartRate: rt('心率'), stress: rt('压力'), spo2: rt('血氧') },
    sleep: {
      rows: sleepRows.length,
      // "the source gave us no sleep row" is a fact; it is never turned into a fabricated session.
      availability: sleepRows.length > 0 ? 'present' : 'no_data',
    },
    sessions: {
      count: sessions.length,
      last: sessions.length
        ? {
          sportTypeRaw: numberOrNull(sessions[sessions.length - 1]?.sport_type),
          label: sessions[sessions.length - 1]?.sport ? String(sessions[sessions.length - 1].sport) : null,
          startText: sessions[sessions.length - 1]?.start_text ? String(sessions[sessions.length - 1].start_text) : null,
          durationMin: numberOrNull(sessions[sessions.length - 1]?.duration_min),
        }
        : null,
    },
    devices: { count: devices.length },
    auth: {
      // The adapter's redacted view may spell these either way; accept both so a rename upstream
      // cannot silently blank the line (it did once).
      expiresAtText: pickText(data?.token?.expiresAtText, data?.token?.expires_at_text),
      expiresInMin: numberOrNull(data?.token?.expires_in_min ?? data?.token?.minutesLeft),
      refreshDiesText: pickText(data?.token?.refreshExpiresAtText, data?.token?.refresh_dies_text),
      rotated: typeof data?.token?.rotated === 'boolean' ? data.token.rotated : null,
      // Masked, first 4 characters only — the sole permitted form of an account id.
      accountHint: maskUid(data?.token?.uid),
    },
    errors: Array.isArray(data.errors) ? data.errors.slice(0, 5).map(item => String(item).slice(0, 120)) : [],
    newestCloud: numberOrNull(data.newest_cloud) === null ? null : iso(Number(data.newest_cloud) * 1000),
  };
}
