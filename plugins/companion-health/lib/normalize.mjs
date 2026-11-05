// Turn the sidecar's `/api/data` snapshot into facts this plugin can store
// (INTERFACES.md §6).
//
// Three rules shape every line below, because this is where a health plugin
// usually starts lying:
//
//   1. **Never invent a precision the source does not have.** `daily[].date` and
//      `health[].date` are local *date strings*; they become a local-midnight
//      anchor plus their own `date` field, never "date + 23:59:59".
//   2. **0 and -1 mean "not measured", not "a reading of zero"** (README §6.4).
//      They become `null`. Writing 0 bpm of resting heart rate would be a
//      fabricated observation.
//   3. **Identifiers leave as hashes.** `uniqueId` / `devId` keep only the first
//      16 hex chars of a sha256; the raw value is dropped on the floor.

import { createHash } from 'node:crypto';

/** Display/attribution timezone. Storage is always UTC milliseconds. */
export const TZ = 'Asia/Shanghai';

export const QUALITY = Object.freeze([
  'fresh', 'delayed', 'stale', 'no_data',
  'unsupported', 'auth_required', 'rate_limited', 'error',
]);

// Recency thresholds. These are product parameters, not medical judgements.
const FRESH_MS = 30 * 60 * 1000;
const DELAYED_MS = 6 * 60 * 60 * 1000;

const DAY_MS = 86400000;

// Epoch values above this are milliseconds; below it they are seconds.
// 1e11 ms ≈ 1973, 1e11 s ≈ year 5138 — the split is unambiguous for health data.
const MILLIS_THRESHOLD = 1e11;

export function sha256Hex(input) {
  return createHash('sha256').update(String(input ?? ''), 'utf8').digest('hex');
}

/** First 16 hex chars of a sha256 — the only form an identifier may be stored in. */
export function shortHash(input) {
  return sha256Hex(input).slice(0, 16);
}

/**
 * Deterministic JSON with sorted keys. Hashes must not change because an upstream
 * object happened to serialise its keys in a different order.
 */
export function canonicalJson(value) {
  const walk = node => {
    if (node === null || node === undefined) return null;
    if (typeof node === 'number') return Number.isFinite(node) ? node : null;
    if (typeof node === 'string' || typeof node === 'boolean') return node;
    if (Array.isArray(node)) return node.map(walk);
    if (typeof node === 'object') {
      const out = {};
      for (const key of Object.keys(node).sort()) {
        const next = walk(node[key]);
        if (next !== undefined) out[key] = next;
      }
      return out;
    }
    return null;
  };
  return JSON.stringify(walk(value));
}

/**
 * Seconds *or* milliseconds, as number or numeric string.
 *
 * `realtime.*.at` and `sources[].ms` are epoch **seconds** (float);
 * `devices[].modifyTime` is epoch **milliseconds**. Both arrive here.
 */
export function epochToMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  const ms = parsed > MILLIS_THRESHOLD ? parsed : parsed * 1000;
  return Number.isFinite(ms) ? Math.round(ms) : null;
}

const formatterCache = new Map();

function formatterFor(tz) {
  const key = String(tz || TZ);
  let formatter = formatterCache.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: key,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(key, formatter);
  }
  return formatter;
}

/** Wall-clock fields of `ms` in `tz`. */
export function localPartsOf(ms, tz = TZ) {
  const instant = typeof ms === 'number' && Number.isFinite(ms) ? ms : epochToMs(ms);
  if (instant == null) return null;
  const parts = formatterFor(tz).formatToParts(new Date(instant));
  const bag = {};
  for (const part of parts) {
    if (part.type && part.type !== 'literal') bag[part.type] = part.value;
  }
  // Some ICU builds render midnight as hour 24 on the same date.
  const hour = Number(bag.hour) % 24;
  return {
    year: Number(bag.year),
    month: Number(bag.month),
    day: Number(bag.day),
    hour,
    minute: Number(bag.minute),
    second: Number(bag.second),
  };
}

/** Offset (ms) that turns a UTC instant into the wall clock in `tz`. */
export function offsetMsAt(ms, tz = TZ) {
  const parts = localPartsOf(ms, tz);
  if (!parts) return 0;
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

const reduce2 = pad => String(pad).padStart(2, '0');

export function localDateOf(ms, tz = TZ) {
  const parts = localPartsOf(ms, tz);
  if (!parts) return null;
  return `${parts.year}-${reduce2(parts.month)}-${reduce2(parts.day)}`;
}

export function localIsoOf(ms, tz = TZ) {
  const parts = localPartsOf(ms, tz);
  if (!parts) return null;
  const offset = offsetMsAt(ms, tz);
  const totalMinutes = Math.round(offset / 60000);
  const sign = totalMinutes < 0 ? '-' : '+';
  const abs = Math.abs(totalMinutes);
  const offsetText = `${sign}${reduce2(Math.floor(abs / 60))}:${reduce2(abs % 60)}`;
  return `${parts.year}-${reduce2(parts.month)}-${reduce2(parts.day)}`
    + `T${reduce2(parts.hour)}:${reduce2(parts.minute)}:${reduce2(parts.second)}${offsetText}`;
}

const LOCAL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAIVE_ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/;
const EXPLICIT_OFFSET_RE = /[+-]\d{2}:?\d{2}$|Z$/;

export function isLocalDate(value) {
  if (typeof value !== 'string') return false;
  const match = LOCAL_DATE_RE.exec(value.trim());
  if (!match) return false;
  const month = Number(match[2]);
  const day = Number(match[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

/** Local midnight of `YYYY-MM-DD` in `tz`, in UTC ms. */
export function localMidnightMs(localDate, tz = TZ) {
  const match = LOCAL_DATE_RE.exec(String(localDate ?? '').trim());
  if (!match) return null;
  const naive = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 0, 0, 0);
  // Two passes: the offset at the naive instant may differ from the offset at the
  // resolved instant (DST folds). Asia/Shanghai never folds, but the helper is
  // shared with tests that deliberately use a DST zone.
  let ms = naive - offsetMsAt(naive, tz);
  ms = naive - offsetMsAt(ms, tz);
  return Number.isFinite(ms) ? ms : null;
}

/** `YYYY-MM-DD` shifted by whole local days. */
export function addLocalDays(localDate, delta) {
  const base = localMidnightMs(localDate);
  if (base == null) return null;
  return localDateOf(base + Math.trunc(delta) * DAY_MS);
}

/**
 * `'2026-10-30T13:59:00'` (no zone, local wall clock) -> UTC ms.
 *
 * `new Date(text)` is wrong twice over: for a naive string V8 treats it as local
 * time (fine only when the host zone *is* the data zone) and for `...Z` as UTC.
 * This helper resolves the wall clock against `tz` explicitly. A string that does
 * carry an offset (`+08:00`, `Z`) is honoured as-is.
 */
export function fromNaiveLocalIso(text, tz = TZ) {
  if (text === null || text === undefined) return null;
  if (typeof text === 'number') return epochToMs(text);
  const raw = String(text).trim();
  if (!raw) return null;
  if (EXPLICIT_OFFSET_RE.test(raw)) {
    const direct = Date.parse(raw);
    return Number.isFinite(direct) ? direct : null;
  }
  const match = NAIVE_ISO_RE.exec(raw);
  if (!match) return null;
  const naive = Date.UTC(
    Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    Number(match[4] ?? 0), Number(match[5] ?? 0), Number(match[6] ?? 0),
    Number((match[7] ?? '0').padEnd(3, '0')),
  );
  if (!Number.isFinite(naive)) return null;
  let ms = naive - offsetMsAt(naive, tz);
  ms = naive - offsetMsAt(ms, tz);
  return Number.isFinite(ms) ? ms : null;
}

/** Recency bucket for a sample time. `null` means "we have never seen a sample". */
export function freshnessOf(newestMs, nowMs = Date.now()) {
  if (newestMs == null || !Number.isFinite(Number(newestMs))) return 'no_data';
  const age = Number(nowMs) - Number(newestMs);
  if (!Number.isFinite(age)) return 'no_data';
  if (age < 0) return 'fresh'; // clock skew must not read as stale
  if (age < FRESH_MS) return 'fresh';
  if (age < DELAYED_MS) return 'delayed';
  return 'stale';
}

// --- small value helpers -----------------------------------------------------

function numOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A health-series reading. 0 and -1 mean "not measured" (README §6.4); anything
 * else is a real number.
 */
function measured(value) {
  const parsed = numOrNull(value);
  if (parsed === null || parsed === 0 || parsed === -1) return null;
  return parsed;
}

/**
 * An activity total. Only -1 is the sentinel here: a day with 0 steps is a real
 * measurement ("you did not walk"), not a missing one — dropping it would make a
 * sedentary day look like a sync gap.
 */
function activityTotal(value) {
  const parsed = numOrNull(value);
  if (parsed === null || parsed === -1) return null;
  return parsed;
}

function intOrNull(value) {
  const parsed = numOrNull(value);
  return parsed === null ? null : Math.round(parsed);
}

function hasValues(object) {
  if (!object || typeof object !== 'object') return false;
  return Object.values(object).some(value => value !== null && value !== undefined);
}

/**
 * Device class from the name stem. `unknown` is a legitimate answer — better than
 * guessing "band" for a device we cannot identify.
 *
 * `extraText` is the source's own model string (`deviceData.mMap.model`, or the
 * `model` the adapter lifted out of it); it is only consulted when the display
 * name says nothing, so `NOH-AN01` with model "HUAWEI Mate 40 Pro" is a phone.
 *
 * ⚠️ Known limitation (一次性的、有意的不完备): the Huawei handset model-code
 * prefixes (`NOH-`, `ANA-`, `BLA-`, …) are a hand-written list, not a complete
 * table. A prefix missing from it yields `device_class = 'unknown'`, which is
 * allowed by the contract (band|watch|phone|tablet|unknown) and is *correct*
 * behaviour — we would rather say "unknown" than mislabel a device. If a new
 * prefix shows up, add it to `HUAWEI_PHONE_PREFIX` rather than loosening the rule.
 */
const HUAWEI_PHONE_PREFIX = /\b(?:noh|ana|bla|aln|ele|lio|vog|clt|dub|mrd|stk|tas|fne|lya|jad|nco|pot|pra|els|abr|ada|kem|bkl|nam|jkm|jny|mna|seg|sea|him|ett|tah|abn|bra|ene|fcp|cet)-[a-z0-9]{2,}/i;

export function deviceClassOf(name, extraText = '') {
  const text = `${name ?? ''} ${extraText ?? ''}`.toLowerCase();
  if (!text.trim()) return 'unknown';
  if (/band/.test(text)) return 'band';
  if (/watch|wrist/.test(text)) return 'watch';
  // 'matepad' contains 'mate', so tablets are matched before phones.
  if (/\bpad\b|tablet|matepad/.test(text)) return 'tablet';
  if (/mate|phone|oneplus|redmi|xiaomi|oppo|vivo|pixel|^\s*mi\s|\bp\d{1,2}\b|nova|honor\s*\d/.test(text)) return 'phone';
  if (HUAWEI_PHONE_PREFIX.test(text)) return 'phone';
  return 'unknown';
}

/**
 * The model string the source gave us, if any.
 *
 * `model` is what `cn-adapter.mjs` lifts out before it drops the rest of
 * `deviceData`; the raw blob is accepted too so a fixture can be fed straight in.
 */
function deviceModelText(row) {
  if (typeof row?.model === 'string' && row.model.trim()) return row.model.trim();
  const bag = row?.deviceData;
  if (!bag) return '';
  let parsed = bag;
  if (typeof bag === 'string') {
    try {
      parsed = JSON.parse(bag);
    } catch {
      return bag;
    }
  }
  const model = parsed?.mMap?.model ?? parsed?.model ?? '';
  return typeof model === 'string' ? model : '';
}

function deviceName(row) {
  const name = row?.name;
  if (typeof name === 'string' && name.trim()) return name.trim();
  const model = deviceModelText(row);
  return model || null;
}

/** 16-hex identifier, whether the adapter already hashed it or not. */
function hashIfPlain(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (/^[0-9a-f]{16}$/i.test(text)) return text.toLowerCase();
  return shortHash(text);
}

/**
 * The three realtime buckets, keyed by the **exact Chinese constants the sidecar
 * publishes**.
 *
 * The sidecar's `realtime{}` object and `sources[].name` are Chinese literals
 * (`心率` / `压力` / `血氧`), so those strings are the contract with it. They live
 * here as named constants instead of scattered literals, and the lookup is exact
 * on purpose: if upstream renames a key, the sub-item becomes `null` and the gap is
 * visible, rather than us guessing a mapping and silently showing the wrong metric
 * under the right label.
 */
export const REALTIME_KEYS = Object.freeze({
  heartRate: '心率',
  stress: '压力',
  spo2: '血氧',
});

/** Which bucket a raw realtime key belongs to. Unknown keys are ignored, not guessed. */
function realtimeBucket(key) {
  const text = typeof key === 'string' ? key.trim() : '';
  if (!text) return null;
  for (const [bucket, literal] of Object.entries(REALTIME_KEYS)) {
    if (text === literal) return bucket;
  }
  return null;
}

/** The whole-window upload time: the only honest "how new is this snapshot" fact. */
function newestCloudMs(payload) {
  const direct = epochToMs(payload?.newest_cloud);
  if (direct != null) return direct;
  const sources = Array.isArray(payload?.sources) ? payload.sources : [];
  let newest = null;
  for (const row of sources) {
    const at = epochToMs(row?.ms);
    if (at != null && (newest == null || at > newest)) newest = at;
  }
  return newest ?? epochToMs(payload?.synced_at);
}

// --- per-section normalisers -------------------------------------------------

function normalizeDailyRow(row, { quality }) {
  const localDate = isLocalDate(row?.date) ? String(row.date).trim() : null;
  return {
    localDate,
    steps: activityTotal(row?.steps),
    distanceM: activityTotal(row?.distance_m),
    kcal: activityTotal(row?.kcal),
    activeHours: activityTotal(row?.active_hours),
    exerciseMin: activityTotal(row?.exercise_min),
    walkMin: activityTotal(row?.walk_min),
    stepGoal: activityTotal(row?.step_goal),
    sportTypeRaw: intOrNull(row?.sport_type),
    quality,
    observedAt: localDate == null ? null : localMidnightMs(localDate),
  };
}

const SLEEP_PRESENCE_KEYS = Object.freeze([
  'allSleepTime', 'deepSleepTime', 'lightSleepTime', 'dreamTime', 'awakeTime',
  'sleepScore', 'sleepEfficiency', 'sleepLatency', 'wakeupCnt',
]);

function normalizeHealthDayRow(row, { quality }) {
  const localDate = isLocalDate(row?.date) ? String(row.date).trim() : null;
  const heartRate = {
    avg: measured(row?.heart_rate),
    max: measured(row?.max_heart_rate),
    min: measured(row?.min_heart_rate),
    resting: measured(row?.resting_heart_rate),
  };
  const stress = {
    avg: measured(row?.stress_average),
    max: measured(row?.stress_max),
    min: measured(row?.stress_min),
    last: measured(row?.stress_last),
    measurements: measured(row?.stress_measurements),
  };
  const spo2 = {
    avg: measured(row?.spo2_avg),
    max: measured(row?.spo2_max),
    min: measured(row?.spo2_min),
    last: measured(row?.spo2_last),
  };
  const intensity = {
    moderateHighMinutes: measured(row?.moderate_high_intensity_minutes),
  };
  const sleepPresent = SLEEP_PRESENCE_KEYS.some(key => measured(row?.[key]) !== null);
  return {
    localDate,
    heartRate,
    stress,
    spo2,
    intensity,
    sleep: { present: sleepPresent },
    quality,
    observedAt: localDate == null ? null : localMidnightMs(localDate),
  };
}

/**
 * One workout. `start` / `end` are zone-less local ISO strings produced by the
 * sidecar (`2026-10-30T13:59:00`) and must be resolved against the data zone.
 */
function normalizeWorkoutRow(row, { quality, timezone }) {
  const startAt = fromNaiveLocalIso(row?.start ?? row?.start_time ?? row?.startTime, timezone);
  const endAt = fromNaiveLocalIso(row?.end ?? row?.end_time ?? row?.endTime, timezone);
  if (startAt == null || endAt == null || endAt < startAt) return null;
  const sportTypeRaw = intOrNull(row?.sport_type);
  const deviceCode = row?.device_code == null ? null : String(row.device_code);
  const label = typeof row?.sport === 'string' && row.sport.trim() ? row.sport.trim() : null;
  const rawDuration = numOrNull(row?.duration_min);
  return {
    // Identity of a session is "when it started, what it was, which device".
    // Content (steps/kcal) can be revised; that is a new revision, not a new row.
    sourceRecordKey: `wkt:${startAt}:${endAt}:${sportTypeRaw ?? 'na'}:${deviceCode ?? 'na'}`,
    sportTypeRaw: sportTypeRaw ?? 0,
    sportTypeLabel: label,
    // The enum table is the *upstream app's* constant, not our fact.
    sportTypeMapping: label ? 'upstream_const' : 'unknown',
    startAt,
    endAt,
    durationMin: rawDuration ?? Math.round((endAt - startAt) / 60000),
    steps: intOrNull(row?.steps),
    distanceM: numOrNull(row?.distance_m),
    kcal: numOrNull(row?.kcal),
    segments: intOrNull(row?.segments),
    deviceCode,
    quality,
  };
}

function normalizeDeviceRow(row, { primaryCodes, fetchedAt }) {
  const deviceCode = row?.deviceCode == null ? null : String(row.deviceCode);
  return {
    deviceCode,
    name: deviceName(row),
    deviceClass: deviceClassOf(row?.name, deviceModelText(row)),
    productId: intOrNull(row?.productId),
    prodId: row?.prodId == null ? null : String(row.prodId),
    deviceTypeId: row?.deviceTypeId == null ? null : String(row.deviceTypeId),
    uniqueIdHash: hashIfPlain(row?.uniqueId),
    devIdHash: hashIfPlain(row?.devId),
    status: intOrNull(row?.status),
    priority: intOrNull(row?.priority),
    // The primary device is the one the cloud actually uploaded samples from —
    // evidence, not "the lowest priority number".
    isPrimary: deviceCode != null && primaryCodes.has(deviceCode),
    sourceUpdatedAt: epochToMs(row?.modifyTime),
    fetchedAt,
  };
}

/**
 * The last uploaded sample per realtime bucket.
 *
 * Always returns all three keys, `null` where the source has nothing. A missing or
 * renamed upstream key therefore shows up as an empty slot — never as a crash and
 * never as another metric's number under this label.
 *
 * A literal `0` is *kept*: the health-series sentinel rule (README §6.4) is about
 * daily aggregates, while a stress score of 0 is a plausible single reading. The
 * only thing dropped here is a sample with no usable `value` or `at`.
 */
function normalizeRealtime(payload, { quality, timezone }) {
  const source = payload?.realtime;
  const out = { heartRate: null, stress: null, spo2: null };
  if (!source || typeof source !== 'object') return out;
  for (const [key, sample] of Object.entries(source)) {
    const bucket = realtimeBucket(key);
    if (!bucket || !sample || typeof sample !== 'object') continue;
    const value = numOrNull(sample.value);
    const at = epochToMs(sample.at);
    if (value === null || at === null) continue;
    out[bucket] = {
      value,
      unit: typeof sample.unit === 'string' ? sample.unit : '',
      at,
      atText: typeof sample.at_text === 'string' ? sample.at_text : localIsoOf(at, timezone),
      device: sample.device == null ? null : String(sample.device),
      quality,
    };
  }
  return out;
}

function normalizeSources(payload, { quality, timezone }) {
  const rows = Array.isArray(payload?.sources) ? payload.sources : [];
  return rows.map(row => {
    const at = epochToMs(row?.ms);
    return {
      name: typeof row?.name === 'string' ? row.name : '',
      at,
      atText: typeof row?.text === 'string' ? row.text : (at == null ? null : localIsoOf(at, timezone)),
      rel: typeof row?.rel === 'string' ? row.rel : '',
      rtText: typeof row?.rt_text === 'string' ? row.rt_text : '',
      quality,
    };
  });
}

/**
 * Token view. Never a uid, never a token value — only the shape an operator needs:
 * how long it lives, whether it rotated, and which contour it belongs to.
 *
 * Both expiry instants are exposed because the status page has to answer "when do
 * I need to log in again?" for the access token *and* the 180-day refresh token.
 */
function normalizeToken(payload, timezone = TZ) {
  // The adapter already rebuilt this; re-derive defensively so a payload fed in
  // straight from a fixture cannot smuggle a uid through.
  const source = payload?.token && typeof payload.token === 'object' ? payload.token : {};
  const instants = (expiresAtRaw, refreshRaw) => ({
    expiresAt: Number.isFinite(Number(expiresAtRaw)) ? Number(expiresAtRaw)
      : fromNaiveLocalIso(expiresAtRaw, timezone),
    refreshExpiresAt: Number.isFinite(Number(refreshRaw)) ? Number(refreshRaw)
      : fromNaiveLocalIso(refreshRaw, timezone),
  });

  if (source.redacted === true) {
    const { expiresAt, refreshExpiresAt } = instants(
      source.expiresAt ?? source.expiresAtText ?? source.expires_at_text,
      source.refreshExpiresAt ?? source.refreshExpiresAtText ?? source.refresh_dies_text,
    );
    return {
      status: typeof source.status === 'string' ? source.status : 'unknown',
      minutesLeft: numOrNull(source.minutesLeft),
      rotated: typeof source.rotated === 'boolean' ? source.rotated : null,
      hostKind: ['cn', 'other'].includes(source.hostKind) ? source.hostKind : 'unknown',
      expiresAt,
      refreshExpiresAt,
    };
  }

  const minutesLeft = numOrNull(source.expires_in_min);
  const hostText = `${source.data_host ?? ''} ${source.session_host ?? ''}`;
  const hostKind = !hostText.trim()
    ? 'unknown'
    : /dbankcloud\.(?:cn|com)/i.test(hostText) ? 'cn' : 'other';
  const status = minutesLeft == null ? 'unknown' : minutesLeft <= 0 ? 'expired' : minutesLeft <= 30 ? 'expiring' : 'valid';
  const rotated = typeof source.rotated === 'boolean' ? source.rotated : null;
  const { expiresAt, refreshExpiresAt } = instants(source.expires_at_text, source.refresh_dies_text);
  return { status, minutesLeft, rotated, hostKind, expiresAt, refreshExpiresAt };
}

/**
 * Unpack a stored `health_observations.observed_value_json`.
 *
 * Stored shape is `{"hash": <sha256>, "value": {<flat fields>}}`: the hash is the
 * idempotency anchor (the frozen schema has no content_hash column) and `value` is
 * exactly the flat breakdown the read layer hands back. Accepts either the row or
 * the raw JSON string/text.
 */
export function parseObservationValue(row) {
  const raw = row && typeof row === 'object' && !Array.isArray(row)
    ? (row.observed_value_json ?? row.observedValueJson ?? row)
    : row;
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { hash: null, value: {} };
    }
  }
  if (!parsed || typeof parsed !== 'object') return { hash: null, value: {} };
  const hash = typeof parsed.hash === 'string'
    ? parsed.hash
    : typeof parsed._hash === 'string' ? parsed._hash : null;
  const value = parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value)
    ? parsed.value
    : {};
  return { hash, value };
}

/** Serialise an observation payload. Kept here so write and read cannot drift. */
export function encodeObservationValue({ hash, value }) {
  return JSON.stringify({ hash: hash ?? null, value: value ?? {} });
}

/**
 * Normalise one sidecar window.
 *
 * `nowMs` decides freshness; `fetchedAt` is stored on every row so a later audit
 * can tell "when we heard this" from "when it happened".
 */
export function normalizeWindow(payload, {
  nowMs = Date.now(),
  fetchedAt = null,
  sourceId = 'huawei-cn',
  timezone = TZ,
} = {}) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const at = Number.isFinite(Number(fetchedAt)) ? Number(fetchedAt) : Number(nowMs);
  const newest = newestCloudMs(source);
  // Day-granule rows carry no trustworthy instant of their own, so their quality
  // is the freshness of the whole upload rather than a number we made up per row.
  const windowQuality = freshnessOf(newest, Number(nowMs));

  const daily = (Array.isArray(source.daily) ? source.daily : [])
    .map(row => normalizeDailyRow(row, { quality: windowQuality }))
    .filter(row => row.localDate != null);

  const healthDays = (Array.isArray(source.health) ? source.health : [])
    .map(row => normalizeHealthDayRow(row, { quality: windowQuality }))
    .filter(row => row.localDate != null);

  const realtime = normalizeRealtime(source, { quality: freshnessOf(newest, Number(nowMs)), timezone });

  const primaryCodes = new Set(
    Object.values(realtime)
      .map(sample => (sample && sample.device != null ? String(sample.device) : null))
      .filter(Boolean),
  );

  const workouts = (Array.isArray(source.sessions) ? source.sessions : [])
    .map(row => normalizeWorkoutRow(row, { quality: freshnessOf(newest, Number(nowMs)), timezone }))
    .filter(Boolean);

  const devices = (Array.isArray(source.devices) ? source.devices : [])
    .map(row => normalizeDeviceRow(row, { primaryCodes, fetchedAt: at }));

  const sleepRows = (Array.isArray(source.sleep_rows) ? source.sleep_rows : [])
    .filter(row => row && typeof row === 'object')
    .map(row => ({
      localDate: isLocalDate(row.date) ? String(row.date).trim() : (isLocalDate(row.sleep_date) ? String(row.sleep_date).trim() : null),
      raw: row,
    }));

  return {
    sourceId,
    fetchedAt: at,
    timezone,
    rawHash: sha256Hex(canonicalJson(source)),
    daily,
    healthDays,
    workouts,
    devices,
    sleepRows,
    realtime,
    sources: normalizeSources(source, { quality: windowQuality, timezone }),
    token: normalizeToken(source, timezone),
    errors: Array.isArray(source.errors) ? source.errors.slice() : [],
  };
}

export { DAY_MS, FRESH_MS, DELAYED_MS, hasValues, measured, activityTotal };
