// Owner-only, read-only bridges to the companion health module (INTERFACES.md §14).
//
// These five tools are *thin*: the health service facade (`lib/service.mjs`) owns the
// database, the loopback collector and every summary shape. Nothing here opens the DB,
// touches the network, or re-implements a summary — a tool only forwards a clamped
// argument bag to one read method and scrubs the answer.
//
// Two guards live outside this file on purpose:
//   * owner identity: `index.mjs`'s `register()` wrapper calls `identity.resolve(sessionId)`
//     before `execute` ever runs. A group chat or another person's QQ session throws there,
//     and that throw is *not* caught here — this file must never grow a second identity check.
//   * authorization: the health module's own consent table decides `health.read.on_demand`.
//
// ⚠️ THE CONSENT GATE IS A WHITELIST, NOT A BLACKLIST: read data only when the facade says
// `health.read.on_demand === true`. Anything else — `false`, `undefined`, `null`, an empty
// object, a missing `consents()` method, a shape we do not recognise — is a denial. When in
// doubt, deny. A blacklist (`=== false` → deny) silently fails open as soon as either side
// changes shape, and "the owner switched health off but the tools keep reading" is the one
// failure this file exists to prevent.
//
// Nothing in this file may fabricate a value. When the source has no data we say so and
// leave the numbers out, because a recorded metric is not a medical conclusion.

export const HEALTH_TOOL_NAMES = Object.freeze([
  'companion_health_status',
  'companion_health_today',
  'companion_health_trend',
  'companion_health_sleep',
  'companion_health_sources',
]);

/** §11.4, verbatim. The tool enum must never drift from the summary enum. */
export const TREND_METRICS = Object.freeze([
  'steps', 'distance_m', 'kcal', 'heart_rate', 'resting_heart_rate', 'stress', 'spo2', 'intensity',
]);

export const DAYS_MIN = 1;
export const DAYS_MAX = 30;
export const DAYS_DEFAULT = 7;
const HEALTH_TZ = 'Asia/Shanghai';

/**
 * §11: every `ok:false` is exactly `{ ok:false, code, message }` — a fixed Chinese sentence,
 * never an exception message. This table is the single place to audit (grep
 * `HEALTH_FAILURES`) every failure the five tools can produce; `failure()` is the only
 * constructor, so a new code cannot be invented inline somewhere down the file.
 */
export const HEALTH_FAILURES = Object.freeze({
  'health-not-mounted': '健康模块尚未挂载。',
  'health-read-denied': '主人尚未授权按需读取健康数据。',
  'health-method-missing': '健康模块未提供该读取能力。',
  'health-read-failed': '读取健康数据时出错。',
  'health-metric-unsupported': `不支持的指标，可选：${TREND_METRICS.join(' / ')}。`,
});

const failure = code => ({ ok: false, code, message: HEALTH_FAILURES[code] });

const SLEEP_EMPTY_MESSAGE = '尚无睡眠记录：等待首次华为云睡眠同步。';

// Key names that must never reach the model: account ids, tokens, hardware identity and
// raw payload handles. Normalising away underscores makes one rule cover both spellings
// (`raw_ref` and `rawRef`, `uniqueId` and `unique_id`).
const PRIVATE_KEY = /uid|token|uniqueid|devid|rawref|payload/;
const normalizeKey = key => String(key).replace(/[_\-\s]/g, '').toLowerCase();

/**
 * Deep-copy `value`, dropping every field whose *name* looks like an identifier, a
 * credential or a raw payload handle. The copy matters: the service hands out live
 * objects and a tool must never mutate what another reader is about to use.
 */
export function stripPrivate(value) {
  if (Array.isArray(value)) return value.map(stripPrivate);
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  const clean = {};
  for (const [key, item] of Object.entries(value)) {
    if (PRIVATE_KEY.test(normalizeKey(key))) continue;
    clean[key] = stripPrivate(item);
  }
  return clean;
}

function localToday(nowMs) {
  // en-CA renders ISO-like YYYY-MM-DD, so no manual padding.
  return new Intl.DateTimeFormat('en-CA', { timeZone: HEALTH_TZ }).format(new Date(nowMs));
}

function isRealDate(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
}

/**
 * §8 argument convergence. A date the model could not have meant is replaced by today and
 * reported through `note`, never silently reinterpreted. `supplied` tells the caller whether
 * the request carried a date at all, because an absent date must keep the service default
 * range (asking for a 7-day sleep trend is not the same as asking for one night).
 */
function resolveDate(value, nowMs) {
  const today = localToday(nowMs);
  if (value === undefined || value === null || value === '') return { date: today, supplied: false };
  if (typeof value === 'string' && isRealDate(value)) return { date: value, supplied: true };
  return { date: today, supplied: false, note: `日期参数不是有效的 YYYY-MM-DD，已改用今天（${today}）。` };
}

function clampDays(value) {
  const days = Number(value);
  if (!Number.isFinite(days)) return DAYS_DEFAULT;
  return Math.min(DAYS_MAX, Math.max(DAYS_MIN, Math.trunc(days)));
}

function withNote(result, note) {
  if (!note || !result || typeof result !== 'object' || Array.isArray(result)) return result;
  if (Array.isArray(result.notes) && result.notes.includes(note)) return result;
  const notes = Array.isArray(result.notes) ? [...result.notes, note] : [note];
  return { ...result, note, notes };
}

/**
 * Register the five read-only health tools on the foundation's existing `register`
 * helper. `register` is passed in, never re-implemented, so the owner-only `identity.resolve`
 * wrapper and the tool `kind` plumbing stay in exactly one place.
 *
 * `getService` is lazy because the health plugin may mount after the foundation plugin;
 * looking the service up at call time is the only way to see it.
 */
export function registerHealthTools({ register, getService, now = () => Date.now() } = {}) {
  if (typeof register !== 'function') throw new TypeError('registerHealthTools requires the foundation register helper');
  const serviceOf = typeof getService === 'function' ? getService : () => null;
  const registered = [];

  const define = (name, description, parameters, execute) => {
    register(name, description, parameters, execute, 'read');
    registered.push(name);
  };

  // Resolve the facade and the on-demand read consent once per call. Any failure becomes a
  // fixed code: an exception message is never handed to the model (§11).
  //
  // `consents()` may answer synchronously or with a Promise, as a bare map
  // (`{ 'health.read.on_demand': true }`) or as the facade's wrapper
  // (`{ ok, consents: {...}, capabilities, notEnforced, seed }`). Both shapes are accepted,
  // and only an explicit `true` opens the gate — see the whitelist note at the top.
  const call = async run => {
    let service;
    try { service = serviceOf(); } catch { service = null; }
    if (!service) return failure('health-not-mounted');
    try {
      const raw = typeof service.consents === 'function' ? await Promise.resolve(service.consents()) : null;
      const map = raw && typeof raw === 'object' && raw.consents && typeof raw.consents === 'object'
        ? raw.consents
        : raw;
      const allowed = Boolean(map) && typeof map === 'object' && map['health.read.on_demand'] === true;
      if (!allowed) return failure('health-read-denied');
      const value = await run(service);
      return stripPrivate(value);
    } catch { return failure('health-read-failed'); }
  };

  const method = (service, key) => (typeof service?.[key] === 'function' ? service[key] : null);

  define('companion_health_status',
    'Read the owner-only companion health bridge status: the Huawei Health CN cloud source '
    + '(account auth state, last successful sync time and data freshness), the local loopback '
    + 'collector (poll interval, last run, cooldown, consecutive failures), the read-only local '
    + 'store counters, the sleep availability flag and which health capabilities are enabled. '
    + 'These are device/cloud metric records synced from Huawei Health, not a medical assessment. '
    + 'Use it to answer "when did health data last sync and how fresh is it?". Read-only: no '
    + 'network request, no credential, token or account identifier is returned.',
    {},
    () => call(async service => {
      const status = method(service, 'status');
      return status ? status.call(service) : failure('health-method-missing');
    }));

  define('companion_health_today',
    'Read the owner health record for one local day (Asia/Shanghai, default today) from the '
    + 'Huawei Health CN cloud: activity (steps, distance, kcal, active hours, exercise minutes, '
    + 'step goal), heart rate / stress / SpO2 / moderate-high intensity with their measurement '
    + 'times, the last realtime upload per metric, workout sessions, and whether a sleep session '
    + 'exists for that night. date must be YYYY-MM-DD; anything else falls back to today and adds '
    + 'a note. Values are device/cloud metric records, not medical conclusions, and a measurement '
    + 'the watch did not record stays null instead of being filled in. Read-only.',
    { date: { type: 'string', description: 'Local day in Asia/Shanghai as YYYY-MM-DD. Omit for today.' } },
    args => call(async service => {
      const today = method(service, 'today');
      if (!today) return failure('health-method-missing');
      const date = resolveDate(args?.date, now());
      return withNote(await today.call(service, { date: date.date }), date.note);
    }));

  define('companion_health_trend',
    'Read a 1-30 day trend (default 7) for one metric from the Huawei Health CN cloud: steps, '
    + 'distance_m, kcal, heart_rate, resting_heart_rate, stress, spo2 or intensity. Returns '
    + 'ascending per-day points, with value null on days the source has no measurement, plus '
    + 'count/mean/min/max and covered/missing day counts. These are device/cloud metric records, '
    + 'not medical conclusions: a rising or falling line is record coverage, not a diagnosis. '
    + 'Read-only.',
    {
      metric: { type: 'string', enum: [...TREND_METRICS], required: true,
        description: 'Metric to plot. Must be one of the listed values.' },
      days: { type: 'integer',
        description: `Window length in days, integer ${DAYS_MIN}..${DAYS_MAX} (default ${DAYS_DEFAULT}). Out-of-range values are clamped.` },
    },
    args => call(async service => {
      const trend = method(service, 'trend');
      if (!trend) return failure('health-method-missing');
      const metric = String(args?.metric ?? '');
      if (!TREND_METRICS.includes(metric)) return failure('health-metric-unsupported');
      return trend.call(service, { metric, days: clampDays(args?.days) });
    }));

  define('companion_health_sleep',
    'Read the owner sleep record from the Huawei Health CN cloud: sessions over a date range '
    + '(default the last 7 days) with asleep/awake/in-bed minutes, stage fidelity, session quality '
    + 'and the original source score label, plus sleep stages when includeStages is true. sleepDate '
    + 'follows the end date of the main sleep. When nothing was synced the answer says availability '
    + 'awaiting_first_night or no_data with a Chinese message and no invented zero-minute night; '
    + 'deep/light/REM/score are never fabricated. These are device/cloud records, not medical '
    + 'conclusions. Read-only: nothing is sent anywhere.',
    {
      date: { type: 'string', description: 'Local day in Asia/Shanghai as YYYY-MM-DD. Omit to use the default range.' },
      days: { type: 'integer',
        description: `Range length in days, integer ${DAYS_MIN}..${DAYS_MAX} (default ${DAYS_DEFAULT}). Out-of-range values are clamped.` },
      includeStages: { type: 'boolean',
        description: 'Include per-stage segments when the source really recorded them.' },
    },
    args => call(async service => {
      const sleep = method(service, 'sleep');
      if (!sleep) return failure('health-method-missing');
      const date = resolveDate(args?.date, now());
      const query = { days: clampDays(args?.days), includeStages: args?.includeStages === true };
      if (date.supplied) query.date = date.date;
      const result = await sleep.call(service, query);
      if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
      const sessions = Array.isArray(result.sessions) ? result.sessions : null;
      const shaped = { ...result, session: sessions && sessions.length ? sessions[0] : null };
      if (result.availability === 'present') return withNote(shaped, date.note);
      // Empty state: say it in words. A `0` here would read as "slept zero minutes", which is
      // a claim the source never made.
      const noted = withNote(shaped, date.note);
      return Array.isArray(noted.notes) && noted.notes.includes(SLEEP_EMPTY_MESSAGE)
        ? noted
        : { ...noted, message: SLEEP_EMPTY_MESSAGE, notes: [...(Array.isArray(noted.notes) ? noted.notes : []), SLEEP_EMPTY_MESSAGE] };
    }));

  define('companion_health_sources',
    'List every health capability the Huawei Health CN cloud bridge supports (activity, sport, '
    + 'heart_rate, stress, spo2, device, sleep with its stage fidelity), each with support status, '
    + 'auth state, data freshness, last success time, last error code and Chinese notes explaining '
    + 'why something is missing. Check this before promising a metric exists. These are device/cloud '
    + 'records, not medical conclusions. Read-only: no credential or raw payload is returned.',
    {},
    () => call(async service => {
      const sources = method(service, 'sources');
      if (!sources) return failure('health-method-missing');
      const value = await sources.call(service);
      if (Array.isArray(value)) return { ok: true, sources: value };
      if (value && typeof value === 'object' && Array.isArray(value.sources)) return value;
      return { ok: true, sources: [] };
    }));

  return { registered: [...registered] };
}
