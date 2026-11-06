import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CAPABILITY_TO_CONSENT, CONSENTS_SEEDED, SOURCE_ID, HEALTH_TZ,
  loadConfig, defaultConfig, configFileOf, dbFileOf, healthDirOf, stampOf,
} from './config.mjs';
import { buildStatus, summarizeProbePayload, maskUid } from './status.mjs';
import { buildReadiness } from './readiness.mjs';
import { CARE_MAX_AGE_HOURS, CARE_MAX_CHARS, buildCareItems, careLine } from './care.mjs';

// companion-health service facade (contract §12).
//
// Design rules that matter more than the feature list:
//
//  1. **Nothing here may take the host down.** Every entry point returns a typed result; the only
//     throws are programming errors inside our own code, and even those are caught at the boundary.
//  2. **Reads never touch the network.** `syncNow()` and `probeSource()` are the only network paths.
//  3. **health-core is loaded dynamically.** `lib/{db,cn-adapter,ingest,summaries,consents,sleep,
//     normalize}.mjs` belong to another owner and may legitimately be absent while this side is
//     being built. A static import would make the whole plugin (and therefore the host's
//     composition) fail to load; a dynamic import lets us report `health-db-unavailable` with a
//     reason instead. It also gives tests a seam (`options.modules`) that never ships in `lib/`.
//  4. **No credential ever leaves.** The adapter's `redactedToken` is the only auth input; we never
//     store or return `access_token` / `refresh_token` / a plain uid.

export const VERSION = '0.2.0';

/** `plugins/companion-health` — the directory holding `index.mjs` and `lib/`. */
export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Workspace root: `plugins/companion-health/../..` (contract §2). Note it is **three** levels up
 *  from `lib/`, not two — `dirname(lib)` is the plugin, one more is `plugins/`. */
export const WORKSPACE_ROOT = path.resolve(PLUGIN_ROOT, '..', '..');

/** health-core modules, loaded lazily at `initialize()` (see rule 3 above). */
const HEALTH_MODULES = Object.freeze({
  db: './db.mjs',
  normalize: './normalize.mjs',
  adapter: './cn-adapter.mjs',
  ingest: './ingest.mjs',
  summaries: './summaries.mjs',
  consents: './consents.mjs',
  sleep: './sleep.mjs',
});

const SYNC_STATUSES = Object.freeze(['ok', 'partial', 'error', 'rate_limited', 'skipped']);
const METRICS = Object.freeze([
  'steps', 'distance_m', 'kcal', 'heart_rate', 'resting_heart_rate', 'stress', 'spo2', 'intensity',
]);
/** Integrity is measured at most this often, and only from a background poke — never inline in
 *  `status()`, where `PRAGMA quick_check` on a large database would blow the 100 ms budget. */
const INTEGRITY_TTL_MS = 60 * 1000;
/** Above this size a quick_check is skipped unless someone asked explicitly. */
const INTEGRITY_MAX_QUICKCHECK_BYTES = 256 * 1024 * 1024;
const PROBE_DAYS_DEFAULT = 7;

function defaultLog(line) {
  try { console.log(line); } catch { /* nothing to do */ }
}

function shortError(error) {
  const text = error instanceof Error ? (error.message || error.code || '') : String(error ?? '');
  return String(text).replace(/\s+/g, ' ').slice(0, 160) || 'unknown error';
}

function iso(ms) {
  if (ms === undefined || ms === null || ms === '') return null;
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const date = new Date(n);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * companion home resolution, aligned with the suite convention (`tools/lib/paths.mjs`).
 *
 * Order: explicit `home` option → `DSH_COMPANION_HEALTH_HOME` (the suite launcher sets this) →
 * `$DSH_COMPANION_DATA_DIR/home` → `<root>/data/home`.
 *
 * Nothing here is tied to a machine: the old behaviour (`<root>/home`) made runtime data land in
 * the repository root instead of the suite's git-ignored `data/`.
 */
function resolveHome(root, homeOption) {
  if (homeOption) return path.resolve(String(homeOption));
  const envHome = process.env.DSH_COMPANION_HEALTH_HOME;
  if (envHome && String(envHome).trim()) return path.resolve(String(envHome).trim());
  const envData = process.env.DSH_COMPANION_DATA_DIR;
  if (envData && String(envData).trim()) {
    return path.join(path.resolve(String(envData).trim()), 'home');
  }
  return path.join(root, 'data', 'home');
}

/**
 * Sidecar 地址的环境变量覆盖。套件配置里的 `services.health.sidecarUrl` 由启动脚本翻译成这两个
 * 变量之一；两个地址都只允许回环，非回环会被 `validateConfig()` 打回默认值并留下 warning。
 */
function sidecarEnvOverride() {
  const override = {};
  const health = process.env.DSH_COMPANION_HEALTH_SIDECAR_URL;
  if (health && String(health).trim()) override.collector = { baseUrl: String(health).trim() };
  const pulse = process.env.DSH_COMPANION_PULSE_SIDECAR_URL;
  if (pulse && String(pulse).trim()) override.pulse = { baseUrl: String(pulse).trim() };
  return override;
}

/**
 * @param {object} [options]
 * @param {string} [options.root]        workspace root (default: `plugins/companion-health/../..`)
 * @param {string} [options.home]        companion home (default `<root>/data/home`, see `resolveHome`)
 * @param {object} [options.config]      override merged over the file, then validated
 * @param {Function} [options.fetchImpl] injected fetch (adapter/tests)
 * @param {Function} [options.now]
 * @param {Function} [options.log]
 * @param {boolean} [options.readOnly]   acceptance/CLI mode: never create files, never migrate,
 *                                       never seed consents, never poll. `syncNow` refuses.
 * @param {object} [options.modules]     test seam: overrides for the health-core modules.
 */
export function createHealthService(options = {}) {
  const {
    root: rootOption, home: homeOption, config: configOverride,
    fetchImpl, now = () => Date.now(), log, readOnly = false, modules: moduleOverrides = null,
  } = options && typeof options === 'object' ? options : {};

  const root = path.resolve(String(rootOption ?? WORKSPACE_ROOT));
  const home = resolveHome(root, homeOption);
  // 环境变量只补「没写进配置的那一层」：显式 options.config 仍然最高优先级。
  const mergedOverride = { ...sidecarEnvOverride(), ...(configOverride && typeof configOverride === 'object' ? configOverride : {}) };
  const healthDir = healthDirOf(home);
  const dbPath = dbFileOf(home);
  const configPath = configFileOf(home);
  const clock = typeof now === 'function' ? now : () => Date.now();
  const logSink = typeof log === 'function' ? log : defaultLog;
  const logLine = (text) => {
    try { logSink(`[companion-health] ${String(text).slice(0, 400)}`); } catch { /* logging must never throw */ }
  };

  /** 'idle' | 'ready' | 'failed' | 'closed' */
  let phase = 'idle';
  let config = defaultConfig();
  let configMeta = { warnings: [], created: false, read: false };
  let modules = null;
  let db = null;
  let adapter = null;
  let ingest = null;
  let migration = null;
  let initPromise = null;
  let initFailure = null;
  let timer = null;
  let running = false;
  let inflight = null;
  let integrityTimer = null;
  let integrityCache = { state: 'unknown', at: null, quickCheck: null, durationMs: null };
  let authSnapshot = null;
  let lastRun = null;
  let consentsSeed = { seeded: false, reason: 'not-initialized' };

  // Live pulse (BLE heart-rate broadcast). Built in `doInitialize()` from a dynamic import, so a
  // partially deployed plugin still mounts: without these three, every pulse path answers
  // `health-pulse-unavailable` and nothing else in the service notices.
  let pulseModules = null;
  let pulseAdapter = null;
  let pulseEngine = null;
  let pulseTimer = null;
  let pulsePollGeneration = 0;
  let pulseFailure = null;
  let pulseLastPoll = { at: null, code: null };

  // ---------------------------------------------------------------------------------------------
  // small helpers
  // ---------------------------------------------------------------------------------------------

  function unavailable(code = 'health-db-unavailable', message = '健康数据库尚未就绪', extra = {}) {
    return { ok: false, code, message, ...extra };
  }

  /**
   * Uniform guard: contract §12 requires *every* method to answer
   * `{ok:false, code:'health-db-unavailable'}` when `initialize()` never succeeded.
   */
  function readyGuard() {
    if (phase === 'ready' && db) return null;
    if (initFailure) return { ...initFailure };
    if (phase === 'closed') return unavailable('health-db-unavailable', '健康服务已关闭');
    return unavailable('health-db-unavailable', '健康服务尚未初始化');
  }

  function readMetaJson(key) {    try {
      const row = db?.get('SELECT value FROM health_meta WHERE key = ?', [key]);
      if (!row || row.value === null || row.value === undefined) return null;
      const parsed = JSON.parse(String(row.value));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch { return null; }
  }

  function writeMetaJson(key, value) {
    if (!db || readOnly) return false;
    try {
      db.run(
        `INSERT INTO health_meta (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [key, JSON.stringify(value), Number(clock())],
      );
      return true;
    } catch (error) {
      logLine(`meta write failed (${key}): ${shortError(error)}`);
      return false;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // proactive care (`health.care.proactive`) — local only, one line per night, never advice
  // ---------------------------------------------------------------------------------------------

  /**
   * Consent gate for care.
   *
   * Whitelist, not "not false": `undefined !== false` used to let an unreadable consent map pass as
   * allowed (the fail-open bug fixed on 2026-11-03). Anything other than a literal `true` is a no.
   */
  function careConsentOn() {
    try {
      const consents = modules?.consents;
      if (!consents || typeof consents.isAllowed !== 'function') return false;
      return consents.isAllowed(db, 'health.care.proactive') === true;
    } catch {
      return false;
    }
  }

  /** Rows already delivered, keyed by dedupe key. Used for the read view (never claims anything). */
  function deliveredCareKeys(limit = 20) {
    const out = new Map();
    try {
      const rows = db?.all(
        `SELECT dedupe_key, kind, sleep_date, channel, text, delivered_at
           FROM health_care_delivered ORDER BY delivered_at DESC LIMIT ?`,
        [clampInt(limit, 1, 100, 20)],
      ) ?? [];
      for (const row of rows) {
        out.set(String(row.dedupe_key), {
          kind: row.kind,
          sleepDate: row.sleep_date ?? null,
          channel: row.channel,
          text: row.text,
          deliveredAt: Number(row.delivered_at),
        });
      }
    } catch { /* a missing ledger is "nothing delivered yet", not a failure */ }
    return out;
  }

  /**
   * Claim a care item for delivery. Returns true only for the caller that actually inserted the row
   * (primary key = dedupe key), so two callers racing on the same night cannot both speak.
   */
  function claimCareDelivery(item, channel) {
    if (!db || readOnly) return false;
    try {
      const result = db.run(
        `INSERT OR IGNORE INTO health_care_delivered
           (dedupe_key, kind, sleep_date, channel, text, delivered_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [String(item.dedupeKey), String(item.kind), item.sleepDate ?? null, String(channel),
          String(item.text), Number(clock())],
      );
      const changes = Number(result?.changes ?? 0);
      return changes > 0;
    } catch (error) {
      logLine(`care claim failed: ${shortError(error)}`);
      return false;
    }
  }

  /** `GET /api/companion-health/care` — what care *would* say right now, and what it already said. */
  function care({ nowMs = null } = {}) {
    const guard = readyGuard();
    if (guard) return guard;
    // `Number(null) === 0`：缺省值必须先判空，否则 `nowMs` 会变成 1970，每一夜都被判成"未来"。
    // （同一个坑在 pulsePrompt 的 maxChars 上也踩过一次，所以这里显式判空。）
    const requested = nowMs == null || nowMs === '' ? NaN : Number(nowMs);
    const at = Number.isFinite(requested) ? requested : Number(clock());
    const enabled = careConsentOn();
    const view = sleep({ days: 7, includeStages: false });
    const items = view?.ok === false
      ? []
      : buildCareItems({ sleep: view, nowMs: at, tz: HEALTH_TZ });
    const delivered = deliveredCareKeys();
    return {
      ok: true,
      enabled,
      // 只有开了授权才给出"会说什么"；关着的时候连候选文本都不给，避免界面把未授权的东西显示成待发。
      items: enabled
        ? items.map(item => ({
          kind: item.kind,
          sleepDate: item.sleepDate,
          text: item.text,
          dedupeKey: item.dedupeKey,
          at: item.at == null ? null : new Date(item.at).toISOString(),
          delivered: delivered.has(item.dedupeKey),
        }))
        : [],
      delivered: [...delivered.entries()].map(([key, value]) => ({ dedupeKey: key, ...value })),
      channel: 'conversation-inject',
      rules: { maxAgeHours: CARE_MAX_AGE_HOURS, maxChars: CARE_MAX_CHARS },
      note: '主动关怀只把来源报过的事实说一遍，不外发到任何平台，也不给建议。',
    };
  }

  // Internal read port. QQ owns disclosure consent, recipient binding and delivery state.
  function qqCareCandidate() {
    if (readyGuard() || !careConsentOn()) return null;
    const view = sleep({ days: 7, includeStages: false });
    if (view?.ok !== true) return null;
    return buildCareItems({
      sleep: view, nowMs: Number(clock()), tz: HEALTH_TZ, qqSummary: true,
    })[0] ?? null;
  }

  /**
   * One short line for the next conversation turn.
   *
   * Answers `{ok:true, text:''}` with a `reason` whenever anything is off — consent, no fresh night,
   * already said tonight, read-only handle. It never throws and never speaks twice for one night.
   * The caller (companion-foundation) treats `text === ''` as "add nothing".
   */
  async function carePrompt({ maxChars = null, channel = 'conversation-inject' } = {}) {
    try {
      const guard = readyGuard();
      if (guard) return { ok: true, text: '', reason: String(guard.code ?? 'unavailable') };
      if (!careConsentOn()) return { ok: true, text: '', reason: 'consent-off' };
      const view = sleep({ days: 7, includeStages: false });
      if (view?.ok === false) return { ok: true, text: '', reason: String(view.code ?? 'sleep-unavailable') };
      const items = buildCareItems({ sleep: view, nowMs: Number(clock()), tz: HEALTH_TZ });
      if (!items.length) return { ok: true, text: '', reason: 'nothing-fresh' };
      const limit = Number.isFinite(Number(maxChars)) && Number(maxChars) > 0
        ? clampInt(Number(maxChars), 40, 400, CARE_MAX_CHARS)
        : CARE_MAX_CHARS;
      for (const item of items) {
        const text = careLine(item, { maxChars: limit });
        if (!text) continue;
        if (!claimCareDelivery({ ...item, text }, channel)) {
          // Someone already said this one. Do not repeat it; try nothing else for this turn.
          return { ok: true, text: '', reason: 'already-delivered' };
        }
        return { ok: true, text, reason: 'ok', kind: item.kind, sleepDate: item.sleepDate, channel };
      }
      return { ok: true, text: '', reason: 'nothing-to-say' };
    } catch (error) {
      logLine(`care prompt failed: ${shortError(error)}`);
      return { ok: true, text: '', reason: 'render-failed' };
    }
  }

  // ---------------------------------------------------------------------------------------------
  // integrity: measured off the hot path, cached, mirrored into health_meta
  // ---------------------------------------------------------------------------------------------

  function recordIntegrity(result, durationMs) {
    // health-core reports `quickCheck` as a boolean; an older/other shape might be a message. Keep
    // whatever type it gave us instead of stringifying `true` into `"true"`.
    const quickCheck = typeof result?.quickCheck === 'boolean'
      ? result.quickCheck
      : (result?.quickCheck === undefined || result?.quickCheck === null ? null : String(result.quickCheck).slice(0, 120));
    integrityCache = {
      state: result && result.ok === true ? 'ok' : 'failed',
      at: Number(clock()),
      quickCheck,
      foreignKeyViolations: Number.isFinite(Number(result?.foreignKeyViolations)) ? Number(result.foreignKeyViolations) : null,
      messages: Array.isArray(result?.messages) ? result.messages.slice(0, 5).map(item => String(item).slice(0, 160)) : [],
      durationMs: Number.isFinite(Number(durationMs)) ? Number(durationMs) : null,
    };
    writeMetaJson('last_integrity', {
      state: integrityCache.state,
      at: integrityCache.at,
      quickCheck: integrityCache.quickCheck,
      foreignKeyViolations: integrityCache.foreignKeyViolations,
      durationMs: integrityCache.durationMs,
    });
    if (integrityCache.state !== 'ok') logLine('integrity check reported a problem');
    return integrityCache;
  }

  function runIntegrityCheck({ force = false } = {}) {
    if (!db) return integrityCache;
    let bytes = 0;
    try { bytes = fs.statSync(dbPath).size; } catch { bytes = 0; }
    if (!force && bytes > INTEGRITY_MAX_QUICKCHECK_BYTES) {
      logLine('integrity check skipped: database larger than the quick-check budget');
      return integrityCache;
    }
    const started = Number(clock());
    try {
      const result = db.integrity();
      return recordIntegrity(result, Number(clock()) - started);
    } catch (error) {
      logLine(`integrity check failed: ${shortError(error)}`);
      integrityCache = { state: 'failed', at: Number(clock()), quickCheck: null, durationMs: null };
      return integrityCache;
    }
  }

  /** Poke the checker after returning, so `status()` stays inside its latency budget. */
  function scheduleIntegrityRefresh() {
    if (readOnly || integrityTimer) return;
    integrityTimer = setTimeout(() => {
      integrityTimer = null;
      try { runIntegrityCheck(); } catch { /* already reported */ }
    }, 0);
    if (typeof integrityTimer.unref === 'function') integrityTimer.unref();
  }

  function integritySnapshot() {
    const stale = integrityCache.at === null || (Number(clock()) - Number(integrityCache.at)) > INTEGRITY_TTL_MS;
    if (stale) scheduleIntegrityRefresh();
    return { ...integrityCache };
  }

  // ---------------------------------------------------------------------------------------------
  // auth: derived from the adapter's redacted token, persisted as a redacted snapshot only
  // ---------------------------------------------------------------------------------------------

  function parseLocalTimestamp(text) {
    const value = String(text ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(value)) return null;
    // The sidecar prints local (Asia/Shanghai) wall-clock text. Parse it in that zone explicitly so
    // the result does not depend on the host's TZ setting.
    const parsed = Date.parse(`${value.replace(' ', 'T')}+08:00`);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function normaliseAuthStatus(status) {
    const value = String(status ?? '');
    return ['valid', 'expiring', 'expired', 'unknown'].includes(value) ? value : 'unknown';
  }

  /**
   * Turn one adapter result into the redacted snapshot `status()` reports.
   *
   * Everything here comes from `redactedToken` (contract §5) plus the sidecar's own *display*
   * timestamps. `payload.token.uid` is never read, never stored, never returned.
   */
  function captureAuth(result) {
    const redacted = result?.redactedToken;
    if (!redacted || typeof redacted !== 'object') return;
    const at = Number(result?.fetchedAt ?? clock());
    const minutesLeft = redacted.minutesLeft != null && redacted.minutesLeft !== '' && Number.isFinite(Number(redacted.minutesLeft)) ? Number(redacted.minutesLeft) : null;
    const tokenBlock = result?.payload?.token && typeof result.payload.token === 'object' ? result.payload.token : null;
    // The adapter's redacted view is the authority; it currently carries the sidecar's display
    // timestamps under both the camelCase and the sidecar spelling. Prefer the adapter's own field,
    // then the payload's, then derive from `minutesLeft` — never guess further than that.
    const absolute = parseLocalTimestamp(redacted.expiresAtText ?? tokenBlock?.expires_at_text);
    const expiresAt = absolute ?? (minutesLeft === null ? null : at + minutesLeft * 60000);
    const refreshExpiresAt = parseLocalTimestamp(redacted.refreshExpiresAtText ?? tokenBlock?.refresh_dies_text);
    const snapshot = {
      status: normaliseAuthStatus(redacted.status),
      expiresAt: expiresAt != null && Number.isFinite(Number(expiresAt)) ? Number(expiresAt) : null,
      refreshExpiresAt: refreshExpiresAt != null && Number.isFinite(Number(refreshExpiresAt)) ? Number(refreshExpiresAt) : null,
      minutesLeft,
      rotated: typeof redacted.rotated === 'boolean' ? redacted.rotated : null,
      hostKind: ['cn', 'other', 'unknown'].includes(String(redacted.hostKind)) ? String(redacted.hostKind) : 'unknown',
      at,
    };
    authSnapshot = snapshot;
    // A snapshot is written only by a real fetch (child of syncNow), never by a read path.
    writeMetaJson('auth_snapshot', snapshot);
  }

  /**
   * Wrap the health-core adapter so **we** observe the redacted token without asking health-core to
   * change its contract. The wrapper is transparent: same `fetchWindow` result, same `describe()`.
   */
  function createAdapter() {
    const inner = modules.adapter.createCnAdapter({
      baseUrl: config.collector.baseUrl,
      timeoutMs: config.collector.requestTimeoutMs,
      fetchImpl,
      now: clock,
    });
    let described = null;
    try { described = typeof inner.describe === 'function' ? inner.describe() : null; } catch { described = null; }
    return {
      describe: () => described ?? {
        baseUrl: config.collector.baseUrl, loopback: true, timeoutMs: config.collector.requestTimeoutMs,
      },
      async fetchWindow(args = {}) {
        const result = await inner.fetchWindow(args);
        try { captureAuth(result); } catch (error) { logLine(`auth snapshot failed: ${shortError(error)}`); }
        return result;
      },
    };
  }

  function currentAuth() {
    if (!authSnapshot) return null;
    return {
      status: normaliseAuthStatus(authSnapshot.status),
      expiresAt: authSnapshot.expiresAt ?? null,
      refreshExpiresAt: authSnapshot.refreshExpiresAt ?? null,
      minutesLeft: authSnapshot.minutesLeft ?? null,
      rotated: typeof authSnapshot.rotated === 'boolean' ? authSnapshot.rotated : null,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // consents: config seeds the table exactly once (lead ruling 2026-11-03)
  // ---------------------------------------------------------------------------------------------

  function readConsents() {
    try {
      const loaded = modules?.consents?.loadConsents?.(db);
      return loaded && typeof loaded === 'object' ? { ...loaded } : {};
    } catch (error) {
      logLine(`consents read failed: ${shortError(error)}`);
      return {};
    }
  }

  /**
   * Strict variant used by the public `consents()` entry.
   *
   * A consent **gate** must never see a partial map: `map['health.read.on_demand'] === undefined`
   * makes `if (x === false) deny` fall through to *allow* — a silent fail-open. `loadConsents()`
   * (health-core) always overlays the full `CAPABILITIES` set on its defaults, so a successful read
   * cannot miss a key; a **failed** read must therefore be a typed refusal, not `{}`.
   */
  function loadConsentMapStrict() {
    if (!modules?.consents || typeof modules.consents.loadConsents !== 'function') {
      throw Object.assign(new Error('consents-unavailable'), { code: 'consents-unavailable' });
    }
    const loaded = modules.consents.loadConsents(db);
    if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) {
      throw Object.assign(new Error('consents-unreadable'), { code: 'consents-unreadable' });
    }
    return { ...loaded };
  }

  /**
   * Seed `health_consents` from `config.capabilities` on the first initialisation only.
   *
   * The table is the runtime authority: after the marker exists, editing `config.json` (or
   * `health-stop.mjs`) can never silently re-grant something the owner turned off. That is the
   * whole point of the marker — "user turned it off, host restarted, it came back on" is an
   * incident, not a convenience.
   */
  function seedConsentsOnce() {
    if (readOnly) return { seeded: false, reason: 'read-only' };
    if (!db || typeof modules?.consents?.setConsent !== 'function') return { seeded: false, reason: 'consents-unavailable' };
    const marker = readMetaJson(CONSENTS_SEEDED);
    if (marker) return { seeded: false, reason: 'already-seeded', at: iso(marker.at) };
    const applied = [];
    for (const [key, capability] of Object.entries(CAPABILITY_TO_CONSENT)) {
      const wanted = config.capabilities?.[key] === true;
      try {
        modules.consents.setConsent(db, capability, wanted);
        applied.push({ capability, enabled: wanted });
      } catch (error) {
        logLine(`consents seed refused (${capability}): ${shortError(error)}`);
      }
    }
    const wrote = writeMetaJson(CONSENTS_SEEDED, {
      at: Number(clock()), configVersion: config.version, seeds: applied,
    });
    const result = { seeded: applied.length > 0, reason: wrote ? 'seeded' : 'marker-write-failed', applied };
    logLine(`consents seeded from config (${applied.length} capabilities)`);
    return result;
  }

  // ---------------------------------------------------------------------------------------------
  // initialize
  // ---------------------------------------------------------------------------------------------

  function failInit(reason, message, error = null, extra = {}) {
    if (error) logLine(`${reason}: ${shortError(error)}`);
    if (db) { try { db.close(); } catch { /* already gone */ } db = null; }
    if (timer) { try { clearInterval(timer); } catch { /* gone */ } timer = null; }
    running = false;
    phase = 'failed';
    initFailure = { ok: false, code: 'health-db-unavailable', message, reason, ...extra };
    return { ...initFailure };
  }

  async function loadHealthModules() {
    const mods = {};
    const missing = [];
    for (const [key, spec] of Object.entries(HEALTH_MODULES)) {
      if (moduleOverrides && moduleOverrides[key]) { mods[key] = moduleOverrides[key]; continue; }
      try {
        mods[key] = await import(new URL(spec, import.meta.url));
      } catch (error) {
        const notFound = error?.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find module/i.test(String(error?.message ?? ''));
        missing.push({ module: key, file: spec, message: notFound ? '模块文件不存在' : shortError(error) });
      }
    }
    return { mods, missing };
  }

  async function doInitialize() {
    // 1. config (never rewritten once it exists; only created on first run of a writable service)
    let loaded;
    try {
      loaded = loadConfig({ home, override: mergedOverride, writeDefaults: !readOnly, now: clock });
    } catch (error) {
      return failInit('config-invalid', '读取健康配置失败', error);
    }
    config = loaded.config;
    configMeta = { warnings: loaded.warnings ?? [], created: loaded.created === true, read: loaded.read === true };
    if (configMeta.created) logLine(`created default config at ${configPath}`);
    if (loaded.error) logLine(loaded.error);

    // 2. health-core modules (dynamic: a missing one must not break the host composition)
    const { mods, missing } = await loadHealthModules();
    if (missing.length) {
      const names = missing.map(item => item.module).join('、');
      return failInit('modules-missing', `健康模块尚未就绪（缺少 ${names}）`, null, { missing });
    }
    modules = mods;

    // 3. adapter first: `openHealthDb` creates the file, so a probe must not depend on the database
    //    existing. Construction performs no I/O (no socket is opened until `fetchWindow`).
    try {
      adapter = createAdapter();
    } catch (error) {
      return failInit('adapter-unavailable', '健康数据适配器初始化失败', error);
    }

    // 4. database. Never create it in readOnly mode, and never after the owner disabled collection.
    const dbExists = fs.existsSync(dbPath);
    if (!dbExists && (readOnly || config.enabled !== true)) {
      return failInit('not-initialized', '还没有采集数据（健康数据库不存在）', null, { dbExists: false });
    }
    const shouldMigrate = readOnly !== true && config.enabled === true;

    try {
      // `migrate:false` for a read-only or disabled service: opening must not create tables in a
      // database we are only inspecting (contract §2: nothing writes the real health.db by accident).
      db = modules.db.openHealthDb({ file: dbPath, now: clock, migrate: shouldMigrate });
    } catch (error) {
      return failInit('open-failed', '无法打开健康数据库', error, { dbExists });
    }

    if (!shouldMigrate) {
      // A file that exists but was never migrated is "not initialised", not "broken".
      const schemaRow = (() => {
        try { return db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'health_meta'", []); }
        catch { return null; }
      })();
      if (!schemaRow) {
        return failInit('not-initialized', '健康数据库还没有表结构（尚未初始化）', null, { dbExists: true });
      }
    } else {
      migration = db.initialMigration ?? null;
      if (migration && Number(migration.to) > Number(migration.from)) {
        logLine(`migrated health db ${migration.from} -> ${migration.to}`);
      }
    }

    // 5. ingest (constructed even when collection is disabled: it holds no timer of its own)
    try {
      ingest = modules.ingest.createIngest({ db, adapter, config, now: clock, log: text => logLine(text) });
    } catch (error) {
      return failInit('ingest-unavailable', '采集器初始化失败', error, { dbExists });
    }

    // 5. persisted, redacted snapshots
    const storedAuth = readMetaJson('auth_snapshot');
    if (storedAuth) authSnapshot = storedAuth;
    const storedIntegrity = readMetaJson('last_integrity');
    if (storedIntegrity) {
      integrityCache = {
        state: ['ok', 'failed', 'unknown'].includes(String(storedIntegrity.state)) ? String(storedIntegrity.state) : 'unknown',
        at: Number.isFinite(Number(storedIntegrity.at)) ? Number(storedIntegrity.at) : null,
        quickCheck: storedIntegrity.quickCheck === undefined ? null : storedIntegrity.quickCheck,
        foreignKeyViolations: Number.isFinite(Number(storedIntegrity.foreignKeyViolations)) ? Number(storedIntegrity.foreignKeyViolations) : null,
        messages: [],
        durationMs: Number.isFinite(Number(storedIntegrity.durationMs)) ? Number(storedIntegrity.durationMs) : null,
      };
    }
    // Seed the in-memory "last run" from the store so `heartbeat()` can answer after a restart
    // without querying `health_sync_runs` on every call.
    const newestRun = (() => {
      try {
        return db.get(
          'SELECT status, started_at, finished_at, error_code FROM health_sync_runs ORDER BY started_at DESC LIMIT 1',
          [],
        );
      } catch { return null; }
    })();
    if (newestRun) {
      lastRun = {
        status: String(newestRun.status ?? ''),
        startedAt: Number(newestRun.started_at) || null,
        finishedAt: Number(newestRun.finished_at) || null,
        errorCode: newestRun.error_code === null || newestRun.error_code === undefined ? null : String(newestRun.error_code),
      };
    }

    // 6. consents seed (writable only)
    try { consentsSeed = seedConsentsOnce(); }
    catch (error) { logLine(`consents seed failed: ${shortError(error)}`); }

    // 6b. live pulse (design/pulse-bond-20261103.md). Dynamic import + own guard: a missing or
    //     broken pulse module is reported in `describe()`, never as a mount failure.
    try {
      const problem = await initPulse();
      if (problem) logLine(`not ready: ${problem.code} — ${problem.message}`);
    } catch (error) {
      pulseFailure = { code: 'pulse-unavailable', message: PULSE_FAILURES['health-pulse-unavailable'] };
      logLine(`pulse init threw: ${shortError(error)}`);
    }

    // 7. one integrity measurement, so `status()` never has to do it inline
    if (integrityCache.at === null) { try { runIntegrityCheck(); } catch { /* reported inside */ } }

    phase = 'ready';
    initFailure = null;
    return {
      ok: true,
      dbPath,
      configPath,
      configCreated: configMeta.created,
      warnings: configMeta.warnings,
      migrated: migration ? { from: Number(migration.from), to: Number(migration.to) } : null,
      consents: consentsSeed,
      readOnly,
    };
  }

  async function initialize() {
    if (phase === 'ready') return { ok: true, already: true, dbPath, configPath, warnings: configMeta.warnings };
    // A failed initialization is a cached verdict, not a retry loop: retrying on every tool call
    // would hammer a broken database (and, worse, could recreate a file an operator just deleted).
    if (phase === 'failed') return { ...initFailure };
    if (phase === 'closed') return unavailable('health-db-unavailable', '健康服务已关闭');
    if (initPromise) return initPromise;
    initPromise = (async () => {
      try {
        return await doInitialize();
      } catch (error) {
        return failInit('initialize-failed', '健康服务初始化失败', error);
      } finally {
        initPromise = null;
      }
    })();
    return initPromise;
  }

  // ---------------------------------------------------------------------------------------------
  // lifecycle
  // ---------------------------------------------------------------------------------------------

  async function start() {
    const guard = readyGuard();
    if (guard) return guard;
    if (readOnly) return unavailable('health-readonly', '只读实例不启动轮询');
    // Live pulse deliberately does **not** start a timer here (owner decision 2026-11-04): nothing
    // scans or polls while nobody is using it. The poller starts when a session opens and stops
    // when it closes — "only scan when a tool is called".
    const pulseStart = { ok: false, code: 'idle-until-session' };
    if (config.enabled !== true) return unavailable('health-disabled', '健康采集已被关闭（config.enabled=false）');
    if (timer) return { ok: true, running: true, already: true, intervalMs: pollIntervalMs(), pulse: pulseStart };
    running = true;
    // Fire and forget: `start()` must return immediately, or a slow sidecar would hold up activate().
    void syncNow({ reason: 'startup' }).catch(error => logLine(`startup sync failed: ${shortError(error)}`));
    timer = setInterval(() => {
      void syncNow({ reason: 'poll' }).catch(error => logLine(`poll sync failed: ${shortError(error)}`));
    }, pollIntervalMs());
    if (typeof timer.unref === 'function') timer.unref();
    logLine(`polling every ${Math.round(pollIntervalMs() / 60000)} min`);
    return { ok: true, running: true, intervalMs: pollIntervalMs(), pulse: pulseStart };
  }

  function pollIntervalMs() {
    return Math.max(60000, (Number(config.collector?.pollMinutes) || 15) * 60000);
  }

  async function stop() {
    running = false;
    if (timer) { try { clearInterval(timer); } catch { /* gone */ } timer = null; }
    if (integrityTimer) { try { clearTimeout(integrityTimer); } catch { /* gone */ } integrityTimer = null; }
    // A session cannot outlive the poller: without a running timer the ring buffer would freeze
    // and every later turn would read a number that is silently hours old. Close it as a reload.
    stopPulsePolling();
    try {
      if (pulseEngine?.active?.()?.active === true) {
        const summary = pulseEngine.close('host-reload');
        if (summary) persistPulseSummary(summary);
      }
    } catch (error) { logLine(`pulse stop failed: ${shortError(error)}`); }
    // Wait for the in-flight sync so `close()` cannot pull the database out from under it.
    const pending = inflight;
    if (pending) { try { await pending; } catch { /* it is already logged where it happened */ } }
    return { ok: true, stopped: true };
  }

  async function close() {
    await stop();
    if (db) { try { db.close(); } catch (error) { logLine(`db close failed: ${shortError(error)}`); } }
    db = null;
    adapter = null;
    ingest = null;
    pulseAdapter = null;
    pulseEngine = null;
    phase = 'closed';
    return { ok: true, closed: true };
  }

  // ---------------------------------------------------------------------------------------------
  // live pulse — BLE heart-rate broadcast (design/pulse-bond-20261103.md)
  //
  // Fenced three times over, on purpose: the `pulse.enabled` switch, the `health.pulse.live`
  // consent row, **and** an explicitly opened session. On top of that the sidecar is a separate
  // process the owner starts by hand, so "no sidecar" is the normal resting state — it must be a
  // typed answer, never an error path and never a reason for a chat turn to fail.
  //
  // The raw series never leaves this process: the engine keeps ≤30 min in memory and only a
  // derived summary (baseline / peak / zone counts / marks) is persisted.
  // ---------------------------------------------------------------------------------------------

  /** Pulse-layer failure codes are shared with `companion-foundation/pulse-tools.mjs`. */
  const PULSE_FAILURES = Object.freeze({
    'health-pulse-unavailable': '实时心率模块尚未就绪。',
    'pulse-disabled': '实时心率功能未启用（配置 pulse.enabled=false）。',
    'pulse-denied': '主人尚未授权读取实时心率。',
    'pulse-unreachable': '心率广播接收端未运行，拿不到读数。',
    'pulse-no-session': '当前没有正在进行的心跳会话。',
    'pulse-bad-action': '不支持的动作，可选：status / start / stop / mark。',
    'pulse-failed': '读取实时心率时出错。',
  });

  function pulseUnavailable(code) {
    return unavailable(code, PULSE_FAILURES[code] ?? PULSE_FAILURES['pulse-failed']);
  }

  /** Consent is a whitelist: a failed or partial read is a denial, never a pass. */
  function pulseConsentAllowed() {
    try {
      return loadConsentMapStrict()['health.pulse.live'] === true;
    } catch {
      return false;
    }
  }

  /** `null` means "go ahead". Anything else is the typed refusal to hand back. */
  function pulseGuard() {
    const guard = readyGuard();
    if (guard) return guard;
    if (!pulseEngine || !pulseAdapter) {
      return unavailable('health-pulse-unavailable', pulseFailure?.message ?? PULSE_FAILURES['health-pulse-unavailable']);
    }
    if (config?.pulse?.enabled !== true) return pulseUnavailable('pulse-disabled');
    if (!pulseConsentAllowed()) return pulseUnavailable('pulse-denied');
    return null;
  }

  async function loadPulseModules() {
    if (pulseModules) return pulseModules;
    // Dynamic for the same reason as health-core: a missing file must not take the host down.
    const [adapterModule, engineModule] = await Promise.all([
      import('./pulse-adapter.mjs'),
      import('./pulse.mjs'),
    ]);
    pulseModules = {
      createPulseAdapter: adapterModule.createPulseAdapter,
      createPulseEngine: engineModule.createPulseEngine,
    };
    return pulseModules;
  }

  /**
   * Build the adapter + engine once per process. Returns `null` on success, or the failure to
   * record — a broken pulse layer must leave every other health feature untouched.
   */
  async function initPulse() {
    try {
      const mods = await loadPulseModules();
      const described = `http://127.0.0.1:8151`;
      const baseUrl = String(config?.pulse?.baseUrl ?? described);
      pulseAdapter = mods.createPulseAdapter({ baseUrl, now: clock, fetchImpl });
      pulseEngine = mods.createPulseEngine({
        now: clock,
        timeZone: HEALTH_TZ,
        policy: {
          // No timer by default: the session follows the device (owner decision 2026-11-04).
          sessionMinutesCeiling: 120,
          deviceOffMs: Number(config?.pulse?.deviceOffMs) || 30000,
          lineMaxChars: Number(config?.pulse?.maxChars) || 200,
        },
      });
      pulseEngine.setEnabled(config?.pulse?.enabled !== false);
      closeOrphanPulseSessions();
      pulseFailure = null;
      return null;
    } catch (error) {
      pulseFailure = { code: 'pulse-unavailable', message: PULSE_FAILURES['health-pulse-unavailable'] };
      logLine(`pulse init failed: ${shortError(error)}`);
      return pulseFailure;
    }
  }

  /**
   * A session row without `ended_at` can only mean the previous process died/reloaded mid-scene.
   * Closing it here keeps "one open row at a time" true and makes the gap visible in history.
   */
  function closeOrphanPulseSessions() {
    if (!db || readOnly) return 0;
    try {
      const result = db.run(
        `UPDATE health_pulse_sessions
            SET ended_at = ?, stop_reason = 'host-reload'
          WHERE ended_at IS NULL`,
        [Number(clock())],
      );
      const changed = Number(result?.changes ?? 0);
      if (changed > 0) logLine(`closed ${changed} pulse session(s) left open by the previous process`);
      return changed;
    } catch (error) {
      logLine(`pulse orphan close failed: ${shortError(error)}`);
      return 0;
    }
  }

  function persistPulseSummary(summary) {
    if (!db || readOnly || !summary || !summary.id) return false;
    try {
      db.run(
        `INSERT INTO health_pulse_sessions
           (id, owner_scope, started_at, ended_at, stop_reason, baseline_bpm, peak_bpm, peak_at,
            samples, zone_counts_json, marks_json, device_label)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           ended_at = excluded.ended_at,
           stop_reason = excluded.stop_reason,
           baseline_bpm = excluded.baseline_bpm,
           peak_bpm = excluded.peak_bpm,
           peak_at = excluded.peak_at,
           samples = excluded.samples,
           zone_counts_json = excluded.zone_counts_json,
           marks_json = excluded.marks_json,
           device_label = excluded.device_label`,
        [
          String(summary.id).slice(0, 80),
          'owner-only',
          Number(summary.startedAt) || Number(clock()),
          Number(summary.endedAt) || Number(clock()),
          String(summary.stopReason ?? 'manual').slice(0, 20),
          summary.baselineBpm == null ? null : Math.round(Number(summary.baselineBpm)),
          summary.peakBpm == null ? null : Math.round(Number(summary.peakBpm)),
          summary.peakAt == null ? null : Number(summary.peakAt),
          Math.max(0, Number(summary.samples) || 0),
          JSON.stringify(summary.zoneCounts ?? {}),
          JSON.stringify(Array.isArray(summary.marks) ? summary.marks.slice(0, 20) : []),
          pulseEngine?.view()?.deviceLabel ?? null,
        ],
      );
      return true;
    } catch (error) {
      logLine(`pulse persist failed: ${shortError(error)}`);
      return false;
    }
  }

  /**
   * One poll: read the sidecar, feed the engine, persist anything the engine closed.
   *
   * ⚠️ INCIDENT 2026-11-03 23:30 — this function took the whole desktop host down.
   * `pulseEngine` can be nulled by `close()` **while this function is awaiting the sidecar**; the
   * `applyState` call was inside a try but `drainClosed()` on the next line was not, so the
   * rejection escaped the timer callback and the host reported `fatal load failure` and refused to
   * boot. Two rules follow, and both are load-bearing:
   *   1. capture the engine/adapter into locals and re-check they are still the live ones after
   *      every `await` — never read the mutable closure variables again;
   *   2. the whole body is inside a try, and every fire-and-forget call goes through `kickPoll()`,
   *      which is the only place allowed to swallow a rejection.
   */
  async function pollPulseOnce() {
    const engine = pulseEngine;
    const adapter = pulseAdapter;
    if (!engine || !adapter) return null;
    const generation = pulsePollGeneration;
    let result;
    try {
      result = await adapter.state();
    } catch (error) {
      result = { ok: false, code: 'unreachable' };
      logLine(`pulse poll threw: ${shortError(error)}`);
    }
    // A reload/close can finish while the request is in flight: the engine may be gone.
    if (generation !== pulsePollGeneration || engine !== pulseEngine) return null;
    try {
      pulseLastPoll = { at: Number(clock()), code: result?.ok === true ? null : String(result?.code ?? 'unreachable') };
      engine.applyState(result);
      for (const summary of engine.drainClosed()) persistPulseSummary(summary);
      // The engine closes a session on its own when the device stops (device-off). Nobody else will
      // stop the timer, so this is where an idle plugin goes back to being completely inert.
      if (engine.active?.().active !== true) stopPulsePolling();
      return pulseLastPoll.code;
    } catch (error) {
      logLine(`pulse poll failed: ${shortError(error)}`);
      return null;
    }
  }

  /**
   * Fire-and-forget poll. The host treats an unhandled rejection as a fatal load failure, so this
   * wrapper — not the caller — owns the `.catch()`.
   */
  function kickPoll(reason = 'interval') {
    Promise.resolve()
      .then(() => pollPulseOnce())
      .catch(error => logLine(`pulse poll unhandled (${reason}): ${shortError(error)}`));
  }

  function startPulsePolling() {
    if (readOnly) return { ok: false, code: 'health-readonly' };
    if (config?.pulse?.enabled !== true) return { ok: false, code: 'pulse-disabled' };
    if (!pulseEngine || !pulseAdapter) return { ok: false, code: 'health-pulse-unavailable' };
    if (pulseTimer) return { ok: true, already: true, intervalMs: pulsePollIntervalMs() };
    kickPoll('startup');
    pulseTimer = setInterval(() => kickPoll('interval'), pulsePollIntervalMs());
    if (typeof pulseTimer.unref === 'function') pulseTimer.unref();
    logLine(`pulse polling every ${pulsePollIntervalMs()} ms (sidecar ${safePulseDescribe()?.baseUrl ?? '?'})`);
    return { ok: true, intervalMs: pulsePollIntervalMs() };
  }

  function pulsePollIntervalMs() {
    return Math.max(250, Math.min(10000, Number(config?.pulse?.pollMs) || 1000));
  }

  function stopPulsePolling() {
    pulsePollGeneration++;
    if (pulseTimer) { try { clearInterval(pulseTimer); } catch { /* gone */ } pulseTimer = null; }
  }

  function safePulseDescribe() {
    try { return pulseAdapter?.describe?.() ?? null; } catch { return null; }
  }

  /** The status view shared by `pulse()` and `pulsePrompt()`. */
  function pulseView() {
    const view = pulseEngine.view();
    const described = safePulseDescribe();
    return {
      ...view,
      enabled: config?.pulse?.enabled === true,
      // The configured label is an alias for the *display*, never a claim about which device it is:
      // when the strap advertises its own name, that name wins.
      deviceLabel: view.deviceLabel ?? (config?.pulse?.deviceLabel ? String(config.pulse.deviceLabel) : null),
      sidecar: {
        ...view.sidecar,
        baseUrl: described?.baseUrl ?? null,
        lastPollAt: pulseLastPoll.at,
        pollErrorCode: pulseLastPoll.code,
      },
      session: { ...view.session, inject: config?.pulse?.inject === true },
      authorized: true,
    };
  }

  /** `GET /api/companion-health/pulse` + `companion_pulse action=status`. */
  async function pulse() {
    const guard = pulseGuard();
    if (guard) return guard;
    try {
      const view = pulseView();
      return { ...view, line: pulseEngine.line({ maxChars: Number(config?.pulse?.maxChars) || 200 }) };
    } catch (error) {
      logLine(`pulse view failed: ${shortError(error)}`);
      return pulseUnavailable('pulse-failed');
    }
  }

  /**
   * The prompt line for one turn.
   *
   * Never fails a turn: every problem is `{ok:true, text:'', reason}`. `reason` is for
   * diagnostics and acceptance, not for the model.
   */
  async function pulsePrompt({ maxChars = null } = {}) {
    const guard = pulseGuard();
    if (guard) return { ok: true, text: '', reason: String(guard.code ?? 'unavailable') };
    if (config?.pulse?.inject !== true) return { ok: true, text: '', reason: 'inject-disabled' };
    if (pulseEngine.active()?.active !== true) return { ok: true, text: '', reason: 'no-session' };
    try {
      // `Number(null) === 0`: an absent maxChars must fall back to the configured budget, not be
      // clamped to the 80-char floor (that bug silently cut every line at 80 characters).
      const configured = Number(config?.pulse?.maxChars) || 200;
      const requested = Number(maxChars);
      const limit = Number.isFinite(requested) && requested > 0
        ? clampInt(requested, 80, 400, configured)
        : clampInt(configured, 80, 400, 200);
      const text = pulseEngine.line({ maxChars: limit });
      if (typeof text !== 'string' || !text) return { ok: true, text: '', reason: 'nothing-to-say' };
      return { ok: true, text: text.slice(0, limit), reason: 'ok' };
    } catch (error) {
      logLine(`pulse prompt failed: ${shortError(error)}`);
      return { ok: true, text: '', reason: 'render-failed' };
    }
  }

  /** One immediate poll instead of waiting for the next tick (freshness right after a session start). */
  async function pulsePollNow() {
    const guard = pulseGuard();
    if (guard) return guard;
    const code = await pollPulseOnce();
    return { ok: true, pollErrorCode: code ?? null };
  }

  /**
   * Make sure the sidecar has a live device, **on demand only**.
   *
   * Called from `start` (the one action that needs a device) and from a poll when a session is
   * already open and the link went quiet. Never called at mount: an idle plugin must not turn the
   * Bluetooth radio on.
   */
  async function ensurePulseLink() {
    const adapter = pulseAdapter;
    if (!adapter) return { ok: false, code: 'health-pulse-unavailable' };
    const probe = async () => {
      try { return await adapter.state(); } catch { return { ok: false, code: 'unreachable' }; }
    };
    let state = await probe();
    if (state.ok === true && state.connected === true) {
      return { ok: true, already: true, deviceLabel: state.deviceLabel ?? null, bpm: state.bpm ?? null };
    }
    if (state.ok !== true && state.code === 'non-loopback-refused') return { ok: false, code: 'non-loopback-refused' };

    // The sidecar scans here — this is the only place a scan is triggered.
    const connected = await (async () => {
      try { return await adapter.connect({ nameHint: config?.pulse?.nameHint ?? null }); } catch { return { ok: false, code: 'unreachable' }; }
    })();
    if (connected?.ok !== true || connected?.connected !== true) {
      // `device-not-found` / `connect-timeout` come straight from the sidecar and reach the UI as
      // `errorCode`, so the card can say "turn the broadcast on" instead of "sidecar is down".
      return {
        ok: false,
        code: String(connected?.code ?? (connected?.ok === true ? 'connect-timeout' : 'unreachable')),
      };
    }
    // Wall-clock deadline on purpose: `clock()` is injectable and may be frozen in tests, and a
    // frozen clock would turn this wait into an infinite loop.
    const deadline = Date.now() + Math.max(1000, Number(config?.pulse?.connectTimeoutMs) || 8000);
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 250));
      state = await probe();
      if (state.ok === true && state.connected === true && state.bpm != null) {
        return { ok: true, already: false, deviceLabel: state.deviceLabel ?? null, bpm: state.bpm };
      }
    }
    return { ok: false, code: 'connect-timeout' };
  }

  /** Feed one snapshot straight into the engine without waiting for the timer (post-connect). */
  async function primePulseOnce() {
    const adapter = pulseAdapter;
    if (!adapter) return null;
    try {
      const state = await adapter.state();
      pulseEngine?.applyState(state);
      return state?.ok === true ? (state.bpm ?? null) : null;
    } catch { return null; }
  }

  /** `companion_pulse action=start|stop|mark` + `POST /api/companion-health/pulse`. */
  async function pulseSession({ action = 'status', minutes = null, label = '' } = {}) {
    const name = String(action ?? '').trim().toLowerCase();
    if (!['status', 'start', 'stop', 'mark'].includes(name)) return pulseUnavailable('pulse-bad-action');
    const guard = pulseGuard();
    if (guard) return guard;
    if (name === 'status') return pulse();
    try {
      if (name === 'start') {
        // A session is only opened once the device really delivers something: "started" must mean
        // "there is a heartbeat behind it", otherwise every later turn gets an honest-but-useless
        // line and the owner cannot tell "band off" from "not connected yet".
        const link = await ensurePulseLink();
        if (link.ok !== true) {
          logLine(`pulse start could not reach a device (${link.code})`);
          return {
            ok: false,
            code: 'pulse-unreachable',
            message: PULSE_FAILURES['pulse-unreachable'],
            errorCode: link.code,
          };
        }
        const started = pulseEngine.startSession({ minutes });
        if (started?.ok !== true) return pulseUnavailable('pulse-failed');
        if (started.already !== true) {
          await primePulseOnce();
          startPulsePolling();
          logLine(`pulse session started (${started.session?.mode === 'timer' ? `${started.session?.minutes} min` : 'follows the device'})`);
        }
        return {
          ok: true,
          already: started.already === true,
          session: { ...started.session, inject: config?.pulse?.inject === true },
          baseline: null,
          device: { label: link.deviceLabel ?? null, firstBpm: link.bpm ?? null },
          note: started.already === true
            ? '会话本来就在进行，没有重新开始计时。'
            : '已开始记录。关掉设备的心率广播后，会话会在约 30 秒内自动结束，提示词里的读数也会跟着消失；要提前结束用 action=stop。',
        };
      }
      if (name === 'stop') {
        const stopped = pulseEngine.stopSession('manual');
        if (stopped?.ok !== true) {
          // Stopping an idle layer still releases the radio: the owner expects "stop" to let go.
          stopPulsePolling();
          await releasePulseDevice();
          return pulseUnavailable('pulse-no-session');
        }
        stopPulsePolling();
        const persisted = persistPulseSummary(stopped.summary);
        await releasePulseDevice();
        return { ok: true, session: null, summary: stopped.summary, persisted, note: '会话已结束，已断开设备。' };
      }
      const marked = pulseEngine.mark(label);
      if (marked?.ok !== true) return pulseUnavailable('pulse-no-session');
      return { ok: true, mark: marked.mark, count: marked.count };
    } catch (error) {
      logLine(`pulse session failed: ${shortError(error)}`);
      return pulseUnavailable('pulse-failed');
    }
  }

  /** Disconnect the BLE link so the band can stop broadcasting (and save its battery). */
  async function releasePulseDevice() {
    const adapter = pulseAdapter;
    if (!adapter) return { ok: false };
    try { return await adapter.disconnect(); } catch { return { ok: false }; }
  }

  /** Past sessions, newest first. Derived statistics only — there is no stored curve. */
  async function pulseHistory({ limit = 5 } = {}) {
    const guard = readyGuard();
    if (guard) return guard;
    if (!pulseConsentAllowed()) return pulseUnavailable('pulse-denied');
    try {
      const rows = db.all(
        `SELECT id, started_at, ended_at, stop_reason, baseline_bpm, peak_bpm, peak_at, samples,
                zone_counts_json, marks_json
           FROM health_pulse_sessions
          ORDER BY started_at DESC
          LIMIT ?`,
        [clampInt(limit, 1, 20, 5)],
      );
      const parse = text => {
        try { const value = JSON.parse(String(text ?? 'null')); return value ?? null; } catch { return null; }
      };
      const sessions = (Array.isArray(rows) ? rows : []).map(row => ({
        id: String(row.id ?? ''),
        startedAt: Number(row.started_at) || null,
        endedAt: Number(row.ended_at) || null,
        stopReason: row.stop_reason == null ? null : String(row.stop_reason),
        baselineBpm: row.baseline_bpm == null ? null : Number(row.baseline_bpm),
        peakBpm: row.peak_bpm == null ? null : Number(row.peak_bpm),
        peakAt: row.peak_at == null ? null : Number(row.peak_at),
        samples: Number(row.samples) || 0,
        zoneCounts: parse(row.zone_counts_json) ?? {},
        marks: parse(row.marks_json) ?? [],
      }));
      return { ok: true, sessions, note: '只保存派生统计（基线 / 峰值 / 档位计数 / 标记），没有原始曲线。' };
    } catch (error) {
      logLine(`pulse history failed: ${shortError(error)}`);
      return pulseUnavailable('pulse-failed');
    }
  }

  /** Candidate broadcasters from the sidecar's last scan (hashes only). */
  async function pulseDevices() {
    const guard = pulseGuard();
    if (guard) return guard;
    try {
      const result = await pulseAdapter.devices();
      if (result?.ok !== true) {
        return unavailable('pulse-unreachable', String(PULSE_FAILURES['pulse-unreachable']), { errorCode: result?.code ?? null });
      }
      return { ok: true, scannedAt: result.scannedAt ?? null, devices: result.devices ?? [] };
    } catch (error) {
      logLine(`pulse devices failed: ${shortError(error)}`);
      return pulseUnavailable('pulse-failed');
    }
  }

  /** Written into the service log at most once per session; no numbers, no device identity. */
  function pulseDiagnostics() {
    return {
      enabled: config?.pulse?.enabled === true,
      ready: Boolean(pulseEngine && pulseAdapter),
      polling: pulseTimer !== null,
      intervalMs: pulsePollIntervalMs(),
      consented: pulseConsentAllowed(),
      failure: pulseFailure,
      lastPoll: { ...pulseLastPoll },
      sidecar: safePulseDescribe(),
    };
  }


  // ---------------------------------------------------------------------------------------------
  // the only network entry point for collection
  // ---------------------------------------------------------------------------------------------

  async function syncNow({ days, force = false, reason = 'manual' } = {}) {
    const guard = readyGuard();
    if (guard) return guard;
    if (readOnly) return unavailable('health-readonly', '只读实例不允许同步');
    if (config.enabled !== true) return unavailable('health-disabled', '健康采集已被关闭（config.enabled=false）');
    if (!ingest) return unavailable('health-db-unavailable', '采集器尚未就绪');
    const windowDays = clampInt(days, 1, 30, Number(config.collector?.windowDays) || 7);
    const promise = (async () => {
      try {
        return await ingest.syncOnce({
          days: windowDays,
          force: force === true,
          reason: String(reason ?? 'manual').slice(0, 40),
        });
      } catch (error) {
        // Contract §8 says syncOnce never throws; this is the belt-and-braces branch so a bug in
        // that layer cannot become an unhandled rejection in the host.
        logLine(`sync threw: ${shortError(error)}`);
        return {
          runId: null, status: 'error', itemsSeen: 0, inserted: 0, updated: 0, skipped: 0,
          errorCode: 'internal-error', startedAt: Number(clock()), finishedAt: Number(clock()),
          faults: [{ code: 'internal-error', message: '采集过程中出现内部错误' }],
        };
      }
    })();
    inflight = promise;
    try {
      const result = await promise;
      lastRun = result && typeof result === 'object' ? result : null;
      const status = String(result?.status ?? '');
      if (!SYNC_STATUSES.includes(status)) {
        logLine(`sync returned an unexpected status: ${status || 'empty'}`);
      }
      const ok = status === 'ok' || status === 'partial';
      return {
        ...(result && typeof result === 'object' ? result : {}),
        ok,
        ...(ok ? {} : { code: result?.errorCode ?? (status || 'health-sync-failed') }),
      };
    } finally {
      if (inflight === promise) inflight = null;
    }
  }

  /**
   * One low-frequency, read-only probe of the sidecar for acceptance (`check-health --probe`).
   *
   * It re-uses the adapter (so it really exercises the same code path the collector uses), performs
   * no database writes, and returns only the redacted protocol summary built by `status.mjs`.
   * `force` is left false on purpose: within the sidecar's 15 s cache this costs no cloud call.
   */
  async function probeSource({ days = PROBE_DAYS_DEFAULT, force = false } = {}) {
    // Deliberately **not** `readyGuard()`: verifying the live link is exactly what an operator wants
    // before the first successful collection, so a missing database must not block the probe.
    if (!adapter) return unavailable('health-adapter-unavailable', '健康数据适配器尚未就绪');
    const windowDays = clampInt(days, 1, 30, PROBE_DAYS_DEFAULT);
    const started = Number(clock());
    let result;
    try {
      result = await adapter.fetchWindow({ days: windowDays, force: force === true });
    } catch (error) {
      logLine(`probe threw: ${shortError(error)}`);
      return { ok: false, code: 'probe-failed', message: '探测健康数据服务时出错', latencyMs: Number(clock()) - started };
    }
    if (!result || result.ok !== true) {
      return {
        ok: false,
        code: result?.errorCode ?? 'probe-failed',
        message: '本机健康数据服务不可用或返回了错误',
        httpStatus: result?.httpStatus ?? null,
        latencyMs: Number(result?.latencyMs ?? (Number(clock()) - started)),
      };
    }
    return {
      ok: true,
      httpStatus: result.httpStatus ?? null,
      latencyMs: Number(result.latencyMs ?? (Number(clock()) - started)),
      fetchedAt: iso(result.fetchedAt),
      days: windowDays,
      forced: force === true,
      adapter: (() => { try { return adapter.describe(); } catch { return null; } })(),
      token: (() => {
        const redacted = result.redactedToken ?? null;
        if (!redacted) return null;
        return {
          status: normaliseAuthStatus(redacted.status),
          minutesLeft: redacted.minutesLeft != null && redacted.minutesLeft !== '' && Number.isFinite(Number(redacted.minutesLeft)) ? Number(redacted.minutesLeft) : null,
          rotated: typeof redacted.rotated === 'boolean' ? redacted.rotated : null,
          hostKind: ['cn', 'other', 'unknown'].includes(String(redacted.hostKind)) ? String(redacted.hostKind) : 'unknown',
        };
      })(),
      summary: summarizeProbePayload(result.payload),
      errors: Array.isArray(result.errors) ? result.errors.slice(0, 5).map(item => String(item).slice(0, 120)) : [],
    };
  }

  // ---------------------------------------------------------------------------------------------
  // read paths (synchronous, database only, never the network)
  // ---------------------------------------------------------------------------------------------

  function fromSummaries(method, build, fallbackMessage = '读取健康数据失败') {
    if (!modules?.summaries || typeof modules.summaries[method] !== 'function') {
      return unavailable('health-db-unavailable', '健康汇总模块尚未就绪');
    }
    try {
      const value = build(modules.summaries);
      if (value === undefined || value === null) return unavailable('health-no-data', '暂时没有可返回的健康数据');
      return value;
    } catch (error) {
      logLine(`${method} failed: ${shortError(error)}`);
      return unavailable('health-read-failed', fallbackMessage);
    }
  }

  function normaliseDate(value) {
    if (value === undefined || value === null || value === '') return { ok: true, date: null };
    const text = String(value).trim();
    if (!DATE_RE.test(text)) return { ok: false, code: 'invalid-date', message: '日期格式必须是 YYYY-MM-DD' };
    return { ok: true, date: text };
  }

  /** `health_sources.last_error_code`；库没开、表还没有 → null（不是「没错误」的证明，只是读不到）。 */
  function lastSourceErrorCode() {
    if (!db) return null;
    try {
      const row = db.get('SELECT last_error_code FROM health_sources WHERE id = ?', [String(config?.source ?? SOURCE_ID)]);
      return row?.last_error_code === undefined || row?.last_error_code === null ? null : String(row.last_error_code);
    } catch {
      return null;
    }
  }

  /**
   * 「未配置 / 不可用 / 未启用 / 正常」三通道状态。
   *
   * 和其它读方法不同，它**在任何阶段都能回答**：库还没建、sidecar 没起、用户从没配置过的时候，
   * 上层最需要的恰恰是这张表。因此它不联网、不建文件、不抛，只做诚实翻译（判定逻辑在
   * `lib/readiness.mjs`，那份代码没有任何 `lib/*` 依赖，可被单测直接调用）。
   */
  function readinessNow() {
    let pulse = null;
    try {
      const diagnostics = pulseDiagnostics();
      pulse = {
        enabled: diagnostics?.enabled === true,
        ready: diagnostics?.ready === true,
        failure: diagnostics?.failure ?? null,
        lastPollCode: pulseLastPoll?.code ?? null,
        sessionActive: pulseEngine?.active?.()?.active === true,
        bpm: pulseEngine?.view?.()?.bpm ?? null,
      };
    } catch { pulse = null; }
    let hasDatabase = false;
    try { hasDatabase = fs.existsSync(dbPath); } catch { hasDatabase = false; }
    return buildReadiness({
      config,
      phase,
      readOnly,
      auth: authSnapshot,
      lastRun,
      lastErrorCode: lastSourceErrorCode(),
      hasDatabase,
      pulse,
    });
  }

  function status() {
    const guard = readyGuard();
    if (guard) return guard;
    try {
      const summaries = modules?.summaries ?? null;
      return buildStatus({
        db,
        config,
        ingest,
        running,
        dbPath,
        integrity: integritySnapshot(),
        auth: currentAuth(),
        consents: readConsents(),
        classifyAvailability: typeof modules?.sleep?.classifyAvailability === 'function'
          ? modules.sleep.classifyAvailability
          : null,
        freshnessOf: typeof modules?.normalize?.freshnessOf === 'function' ? modules.normalize.freshnessOf : null,
        newestSampleAt: typeof summaries?.newestSampleAt === 'function'
          ? () => summaries.newestSampleAt(db, HEALTH_TZ)
          : null,
        schemaVersion: Number(safeCall(() => db.schemaVersion, 0)) || Number(modules?.db?.SCHEMA_VERSION) || 1,
        nowMs: Number(clock()),
        readiness: readinessNow(),
      });
    } catch (error) {
      logLine(`status failed: ${shortError(error)}`);
      return unavailable('health-status-failed', '读取健康状态失败');
    }
  }

  function sources() {
    const guard = readyGuard();
    if (guard) return guard;
    if (!modules?.summaries || typeof modules.summaries.buildSources !== 'function') {
      return unavailable('health-db-unavailable', '健康来源模块尚未就绪');
    }
    try {
      // health-core takes a single options object here (contract §9 lists it positionally, but both
      // owners agreed the object form is what shipped; call it the way it is implemented).
      return modules.summaries.buildSources({ db, config, nowMs: Number(clock()) });
    } catch (error) {
      logLine(`sources failed: ${shortError(error)}`);
      return unavailable('health-read-failed', '读取健康来源失败');
    }
  }

  function today({ date } = {}) {
    const guard = readyGuard();
    if (guard) return guard;
    const parsed = normaliseDate(date);
    if (!parsed.ok) return parsed;
    return fromSummaries('buildToday', summaries => summaries.buildToday({
      db, date: parsed.date ?? undefined, tz: HEALTH_TZ, nowMs: Number(clock()),
    }), '读取今日健康数据失败');
  }

  function trend({ metric, days } = {}) {
    const guard = readyGuard();
    if (guard) return guard;
    const wanted = String(metric ?? 'steps');
    if (!METRICS.includes(wanted)) {
      return { ok: false, code: 'invalid-metric', message: `metric 只支持 ${METRICS.join(' / ')}` };
    }
    const window = clampInt(days, 1, 30, 7);
    return fromSummaries('buildTrend', summaries => summaries.buildTrend({
      db, metric: wanted, days: window, tz: HEALTH_TZ, nowMs: Number(clock()),
    }), '读取健康趋势失败');
  }

  function sleep({ date, days, includeStages } = {}) {
    const guard = readyGuard();
    if (guard) return guard;
    const parsed = normaliseDate(date);
    if (!parsed.ok) return parsed;
    const window = clampInt(days, 1, 30, 7);
    return fromSummaries('buildSleep', summaries => summaries.buildSleep({
      db,
      date: parsed.date ?? undefined,
      days: window,
      includeStages: includeStages === true,
      tz: HEALTH_TZ,
      nowMs: Number(clock()),
    }), '读取睡眠数据失败');
  }

  function heartbeat() {
    const at = iso(clock());
    if (!db || phase !== 'ready') {
      return {
        ok: false, at, running: false, initialized: false,
        lastRunAt: null, nextAllowedAt: null, consecutiveFailures: 0, rateLimitedUntil: null,
      };
    }
    const cooldown = safeCall(() => (typeof ingest?.cooldownUntil === 'function' ? ingest.cooldownUntil() : null));
    return {
      ok: true,
      at,
      running,
      initialized: true,
      lastRunAt: iso(lastRun?.finishedAt ?? lastRun?.startedAt ?? null),
      nextAllowedAt: iso(safeCall(() => (typeof ingest?.nextAllowedAt === 'function' ? ingest.nextAllowedAt() : null))),
      consecutiveFailures: Number(safeCall(() => (typeof ingest?.consecutiveFailures === 'function' ? ingest.consecutiveFailures() : 0)) ?? 0),
      rateLimitedUntil: safeCall(() => (typeof ingest?.isRateLimited === 'function' ? ingest.isRateLimited() === true : false)) === true
        ? iso(cooldown)
        : null,
    };
  }

  function safeCall(fn, fallback = null) {
    try { const value = fn(); return value === undefined ? fallback : value; } catch { return fallback; }
  }

  /**
   * The consent map — **bare**, exactly what `status().consents` holds (contract §12 / §11.1).
   *
   * This shape is load-bearing: a consumer gates on
   * `service.consents()['health.read.on_demand'] === false`, so wrapping it in an envelope (or
   * returning `{}` on failure) turns the gate into a silent fail-open. Extra display data lives in
   * `consentsDetail()`; a failed read is a typed refusal, never a partial map.
   */
  function consents() {
    const guard = readyGuard();
    if (guard) return guard;
    try {
      return loadConsentMapStrict();
    } catch (error) {
      logLine(`consents unavailable: ${shortError(error)}`);
      return unavailable('health-consent-read-failed', '读取授权状态失败');
    }
  }

  /**
   * Display view for the studio panel: the same map plus the capability list, which capabilities
   * this round cannot act on, and the one-time seed record. Read-only.
   */
  function consentsDetail() {
    const guard = readyGuard();
    if (guard) return guard;
    let current;
    try {
      current = loadConsentMapStrict();
    } catch (error) {
      logLine(`consents unavailable: ${shortError(error)}`);
      return unavailable('health-consent-read-failed', '读取授权状态失败');
    }
    const capabilities = Array.isArray(modules?.consents?.CAPABILITIES) ? [...modules.consents.CAPABILITIES] : [];
    // The four "no code path this round" capabilities are reported exactly as the table says, with
    // `enforced:false` in `setConsent` — the service deliberately contains no branch reading them.
    const notEnforced = ['health.context.auto', 'health.memory.habits', 'health.schedule.adjust'];
    return {
      ok: true,
      consents: current,
      capabilities,
      notEnforced,
      seed: consentsSeed,
    };
  }

  async function setConsent(capability, enabled) {
    const guard = readyGuard();
    if (guard) return guard;
    if (readOnly) return unavailable('health-readonly', '只读实例不允许改授权');
    if (!modules?.consents || typeof modules.consents.setConsent !== 'function') {
      return unavailable('health-db-unavailable', '授权模块尚未就绪');
    }
    const name = String(capability ?? '');
    try {
      modules.consents.setConsent(db, name, enabled === true);
    } catch (error) {
      const code = String(error?.code ?? error?.name ?? '');
      logLine(`setConsent refused: ${shortError(error)}`);
      return {
        ok: false,
        code: code === 'bad-capability' ? 'health-consent-unknown' : 'health-consent-failed',
        message: code === 'bad-capability' ? '未知的授权能力' : '修改授权失败',
      };
    }
    const current = readConsents();
    const notEnforced = ['health.context.auto', 'health.memory.habits', 'health.schedule.adjust'];
    const requested = enabled === true;
    return {
      ok: true,
      capability: name,
      enabled: current[name] === true,
      requested,
      // Recorded honestly: the row changed, but nothing in this round acts on it.
      enforced: !notEnforced.includes(name),
      consents: current,
    };
  }

  /**
   * WAL-consistent snapshot of the health database (studio `POST /maintenance {action:'backup'}`).
   * Returns `{ok:true, path, bytes, at}`; on failure a typed refusal, never a throw.
   */
  async function backup({ dest = null, at = null } = {}) {
    const guard = readyGuard();
    if (guard) return guard;
    if (readOnly) return unavailable('health-readonly', '只读实例不允许备份');
    if (!db || typeof db.backupTo !== 'function') return unavailable('health-db-unavailable', '健康数据库不可用');
    const stamp = Number(at ?? clock());
    const target = dest
      ? path.resolve(String(dest))
      : path.join(healthDir, 'backups', `health-${stampOf(stamp)}.db`);
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const result = db.backupTo(target);
      let bytes = Number(result?.bytes);
      if (!Number.isFinite(bytes)) {
        try { bytes = fs.statSync(target).size; } catch { bytes = 0; }
      }
      return {
        ok: true,
        path: String(result?.path ?? target),
        bytes,
        at: iso(Number(result?.at ?? stamp)),
      };
    } catch (error) {
      logLine(`backup failed: ${shortError(error)}`);
      return unavailable('health-backup-failed', '健康数据库备份失败');
    }
  }

  function describe() {
    return {
      name: 'companion-health',
      version: VERSION,
      sourceId: String(config?.source ?? SOURCE_ID),
      dbPath,
      configPath,
      root,
      home,
      readOnly,
      phase,
      timezone: HEALTH_TZ,
      modules: modules
        ? { loaded: Object.keys(HEALTH_MODULES), missing: [] }
        : { loaded: [], missing: Object.keys(HEALTH_MODULES) },
      config: {
        enabled: config?.enabled === true,
        collector: { ...(config?.collector ?? {}) },
        warnings: configMeta.warnings,
      },
      // Diagnostics only: switch/consent/poller state and the sidecar address. No reading, no
      // device identity — `pulse()` is the one place a number is handed out.
      pulse: (() => { try { return pulseDiagnostics(); } catch { return null; } })(),
      // 三通道诚实状态：未配置 / 不可用 / 未启用 / 正常。面板与体检脚本都读这一份。
      readiness: (() => { try { return readinessNow(); } catch { return null; } })(),
    };
  }

  // ---------------------------------------------------------------------------------------------
  // facade (contract §12 + `backup`/`probeSource` additions documented in CONTRACT.md)
  // ---------------------------------------------------------------------------------------------

  return {
    get root() { return root; },
    get home() { return home; },
    get dbPath() { return dbPath; },
    get configPath() { return configPath; },
    get config() { return config; },
    get readOnly() { return readOnly; },
    initialize,
    start,
    stop,
    close,
    isRunning: () => running === true && timer !== null,
    status,
    sources,
    today,
    trend,
    sleep,
    syncNow,
    probeSource,
    backup,
    heartbeat,
    // Live pulse (design/pulse-bond-20261103.md §4.4). Every one of these returns a typed result:
    // `pulsePrompt` in particular always resolves `{ok:true, text}` so a turn can never fail on it.
    pulse,
    pulseSession,
    pulseHistory,
    pulseDevices,
    pulsePrompt,
    pulsePollNow,
    pulseDiagnostics,
    // 主动关怀（`health.care.proactive`）：本地生成、一夜一次、不外发。
    care,
    carePrompt,
    qqCareCandidate,
    consents,
    consentsDetail,
    setConsent,
    describe,
    // 三通道诚实状态：任何阶段可调（含未初始化时），不联网、不建文件、不抛。
    readiness: readinessNow,
    // Extras used by the acceptance/mount code; harmless for any other consumer.
    pluginRoot: PLUGIN_ROOT,
    maskUid,
    lastIntegrity: () => ({ ...integrityCache }),
  };
}
