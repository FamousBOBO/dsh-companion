import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// companion-health: configuration file + validation.
//
// The file is `<home>/health/config.json`. It is written **only** when it does not exist yet
// (first load), atomically (temp file + fsync + rename), and never silently rewritten afterwards:
// an operator who edited (or `health-stop.mjs` who disabled) it must not be overridden by a
// later load. Invalid values fall back to the default **and** surface as `warnings`, so a broken
// file degrades into "runs with known defaults, says so" rather than "runs with a wrong number".
//
// Field names here are the ones the studio UI displays (plan v1.1 §11.4); do not rename them.

export const CONFIG_VERSION = 1;
export const SOURCE_ID = 'huawei-cn';
export const PROVIDER = 'huawei_cn_cloud';
export const DISPLAY_NAME = '华为运动健康（CN 云）';
export const HEALTH_TZ = 'Asia/Shanghai';

/** The sidecar is only ever reached on loopback (hard rule, also enforced by the adapter). */
export const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * Capabilities this round must never be switched on. `capabilities` in the config file is not a
 * consent grant — the `health_consents` table is the runtime authority (lead ruling, 2026-11-03):
 * the config only seeds the table once (see `CONSENTS_SEEDED` in `service.mjs`). These four have
 * no code path behind them in A0–A2 at all, so they are forced back to false on every load.
 */
export const LOCKED_OFF_CAPABILITIES = Object.freeze([
  'injectHealthContext', 'rememberHabits', 'adjustSchedule', 'proactiveCare',
]);

/**
 * `config.capabilities` key → `health_consents.capability` row (contract §10 names).
 * The five keys below are verbatim plan v1.1 §11.4 field names; the UI displays them by name.
 * `health.connect` / `health.dashboard` / `health.sleep.read` have no config field (this round they
 * are simply on), and `health.export` / `health.delete` have none either (this round off).
 */
export const CAPABILITY_TO_CONSENT = Object.freeze({
  readOnDemand: 'health.read.on_demand',
  injectHealthContext: 'health.context.auto',
  rememberHabits: 'health.memory.habits',
  adjustSchedule: 'health.schedule.adjust',
  proactiveCare: 'health.care.proactive',
});

/** `health_meta` key proving the one-time config→consents seed already happened. */
export const CONSENTS_SEEDED = 'consents_seeded';

/**
 * Defaults, exactly as plan v1.1 §11.4 describes them.
 *
 * `capabilities` carries the five field names the UI shows and only those. On the very first
 * initialisation they seed the `health_consents` rows (via CAPABILITY_TO_CONSENT) **once**; after
 * that the table is the authority and editing this file never silently re-grants a capability the
 * user turned off. `connect` / `dashboard` / `sleep.read` have no field here (on this round), and
 * `export` / `delete` have none either (off this round).
 */
export const DEFAULT_CONFIG = Object.freeze({
  version: CONFIG_VERSION,
  // 发布默认值：**关闭**。健康采集会让本机 sidecar 去访问华为云，属于「有没有授权」由人决定的事，
  // 所以新装一律先不采集；用户在自己的 config.json 里显式改成 true 才算同意（见 README「安全默认」）。
  // 关着的时候 `start()`/`syncNow()` 立刻返回 `health-disabled`，不建库、不联网、不轮询。
  enabled: false,
  source: SOURCE_ID,
  provider: PROVIDER,
  displayName: DISPLAY_NAME,
  timezone: HEALTH_TZ,
  collector: Object.freeze({
    mode: 'local_http',
    baseUrl: 'http://127.0.0.1:8765',
    pollMinutes: 15,
    singleFlight: true,
    windowDays: 7,
    backfillDays: 30,
    requestTimeoutMs: 20000,
  }),
  capabilities: Object.freeze({
    readOnDemand: true,
    injectHealthContext: false,
    rememberHabits: false,
    adjustSchedule: false,
    proactiveCare: false,
  }),
  /**
   * Live pulse (BLE heart-rate broadcast). `enabled` is the switch for the whole feature;
   * the *session* is still an explicit runtime action and the sidecar is still started by hand,
   * so three independent things must all be true before a single number can reach a prompt.
   * `baseUrl` is loopback-only, validated below and again by `pulse-adapter.mjs`.
   *
   * `deviceLabel` is a **display alias only** (used when the device does not advertise a name);
   * choosing *which* device to connect to belongs to the sidecar (its `--name-hint` / `--address`
   * flags或者 start-sidecar 脚本的同名参数)，because that is the process that scans. Keeping a scan
   * hint here would be config that nothing reads.
   */
  pulse: Object.freeze({
    // 同样默认关闭：BLE 心率要连真硬件、要单独起 sidecar，属于「用户自己说要测」的功能。
    // 关着时所有 pulse 入口返回 `pulse-disabled`，不扫描、不轮询、不联网。
    enabled: false,
    baseUrl: 'http://127.0.0.1:8151',
    deviceLabel: null,
    pollMs: 1000,
    /** No session timer: the session follows the device and closes this long after the last beat. */
    deviceOffMs: 30000,
    /** How long `start` waits for the on-demand scan+connect to produce a first reading. */
    connectTimeoutMs: 8000,
    inject: true,
    maxChars: 200,
  }),
  sleep: Object.freeze({
    schemaEnabled: true,
    displayEmptyState: true,
    waitForFirstRealNight: true,
    altSourcesEnabled: false,
    trendMinVerifiedNights: 3,
    proactiveRulesEnabled: false,
  }),
  privacy: Object.freeze({
    ownerOnly: true,
    exposeToGroup: false,
    exposeToBili: false,
    redactTokens: true,
  }),
});

/** A mutable deep copy of the defaults (never hand out the frozen constant itself). */
export function defaultConfig() {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

export function configFileOf(home) {
  return path.join(String(home ?? ''), 'health', 'config.json');
}

export function healthDirOf(home) {
  return path.join(String(home ?? ''), 'health');
}

export function dbFileOf(home) {
  return path.join(String(home ?? ''), 'health', 'health.db');
}

/** `20261103T205912` — local time, filename-safe, sortable. */
export function stampOf(ms = Date.now()) {
  const d = new Date(Number(ms));
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
    + `T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Atomic JSON write: temp file in the same directory, fsync, rename.
 * A crash therefore leaves either the old file or the new one, never a truncated one.
 */
export function writeConfigAtomic(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, 'wx');
    try {
      fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n', 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) { try { fs.unlinkSync(temporary); } catch { /* best effort */ } }
  }
  const stat = fs.statSync(file);
  return { path: file, bytes: stat.size };
}

/**
 * Copy the current config aside. Returns the backup path, or null when there was no file.
 *
 * The name is `<file>.bak-<stamp>`; two operations inside the same second (exactly what
 * disable-then-restore does) must not overwrite each other, and the restore path must never back
 * the current file up **onto the very backup it is reading from** — otherwise a rollback destroys
 * its own evidence. `avoid` names paths that must stay untouched.
 */
export function backupConfig(file, { at = Date.now(), avoid = [] } = {}) {
  if (!fs.existsSync(file)) return null;
  const base = `${file}.bak-${stampOf(at)}`;
  const taken = new Set((Array.isArray(avoid) ? avoid : []).filter(Boolean).map(item => path.resolve(String(item))));
  let target = base;
  let suffix = 1;
  while (fs.existsSync(target) || taken.has(path.resolve(target))) {
    target = `${base}-${suffix}`;
    suffix += 1;
  }
  fs.copyFileSync(file, target);
  return target;
}

function objOf(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function boolOf(value, fallback, label, warnings) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  warnings.push(`${label} 必须是 true/false，已回落默认值 ${fallback}`);
  return fallback;
}

/** Short free text (device alias, name hint). Blank/absent falls back; long text is clipped. */
function textOf(value, max, fallback, label, warnings) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') {
    warnings.push(`${label} 必须是字符串，已回落默认值`);
    return fallback;
  }
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return fallback;
  if (text.length > max) {
    warnings.push(`${label} 超过 ${max} 字，已截断`);
    return text.slice(0, max);
  }
  return text;
}

function intOf(value, min, max, fallback, label, warnings) {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    warnings.push(`${label} 不是数字，已回落默认值 ${fallback}`);
    return fallback;
  }
  const rounded = Math.round(n);
  if (rounded < min || rounded > max) {
    const clamped = Math.min(max, Math.max(min, rounded));
    warnings.push(`${label}=${rounded} 超出 ${min}..${max}，已收敛为 ${clamped}`);
    return clamped;
  }
  return rounded;
}

/**
 * The base URL must stay on loopback. A non-loopback URL is refused here (and again by the
 * adapter) so that "the sidecar" can never silently become "some host on the network".
 */
export function baseUrlOf(value, fallback, warnings, label = 'collector.baseUrl') {
  const fallbackUrl = String(fallback);
  if (value === undefined || value === null || value === '') return fallbackUrl;
  if (typeof value !== 'string') {
    warnings.push(`${label} 不是字符串，已回落 ${fallbackUrl}`);
    return fallbackUrl;
  }
  const text = value.trim().replace(/\/+$/, '');
  let parsed = null;
  try { parsed = new URL(text); } catch { parsed = null; }
  if (!parsed) {
    warnings.push(`${label} 不是合法 URL，已回落 ${fallbackUrl}`);
    return fallbackUrl;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    warnings.push(`${label} 只允许 http/https，已回落 ${fallbackUrl}`);
    return fallbackUrl;
  }
  // `URL` normalises `[::1]` to `[::1]`; compare both forms.
  const host = parsed.hostname.toLowerCase();
  if (!LOOPBACK_HOSTS.includes(host)) {
    warnings.push(`${label} 只能是 loopback（127.0.0.1 / localhost / ::1），已回落 ${fallbackUrl}`);
    return fallbackUrl;
  }
  return text;
}

/**
 * Validate an arbitrary parsed object into the canonical config shape.
 *
 * Never throws: every problem becomes a warning and a default. `settings.changed` tells the
 * caller whether anything had to be corrected, which `health-stop.mjs` reports.
 */
export function validateConfig(raw = {}) {
  const warnings = [];
  const input = objOf(raw);
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    warnings.push('配置顶层不是对象，已整体回落默认值');
  }
  const base = defaultConfig();
  const config = { ...base };

  // version / timezone / provider / source are owned by the code, not by the file.
  if (input.version !== undefined && Number(input.version) !== CONFIG_VERSION) {
    warnings.push(`配置 version=${input.version} 与当前 ${CONFIG_VERSION} 不一致，已按当前版本解释`);
  }
  config.version = CONFIG_VERSION;
  config.timezone = HEALTH_TZ;
  if (input.source !== undefined && input.source !== SOURCE_ID) {
    warnings.push(`source 本轮只支持 ${SOURCE_ID}，已回落`);
  }
  config.source = SOURCE_ID;
  if (input.provider !== undefined && input.provider !== PROVIDER) {
    warnings.push(`provider 本轮只支持 ${PROVIDER}，已回落`);
  }
  config.provider = PROVIDER;
  config.displayName = typeof input.displayName === 'string' && input.displayName.trim()
    ? input.displayName.trim().slice(0, 60)
    : DISPLAY_NAME;
  config.enabled = boolOf(input.enabled, base.enabled, 'enabled', warnings);

  const collectorIn = objOf(input.collector);
  const collector = { ...base.collector };
  if (collectorIn.mode !== undefined && collectorIn.mode !== 'local_http') {
    warnings.push('collector.mode 本轮只支持 local_http，已回落');
  }
  collector.mode = 'local_http';
  collector.baseUrl = baseUrlOf(collectorIn.baseUrl, base.collector.baseUrl, warnings);
  collector.pollMinutes = intOf(collectorIn.pollMinutes, 1, 1440, base.collector.pollMinutes, 'collector.pollMinutes', warnings);
  collector.singleFlight = boolOf(collectorIn.singleFlight, base.collector.singleFlight, 'collector.singleFlight', warnings);
  collector.windowDays = intOf(collectorIn.windowDays, 1, 30, base.collector.windowDays, 'collector.windowDays', warnings);
  collector.backfillDays = intOf(collectorIn.backfillDays, 1, 90, base.collector.backfillDays, 'collector.backfillDays', warnings);
  collector.requestTimeoutMs = intOf(collectorIn.requestTimeoutMs, 1000, 120000, base.collector.requestTimeoutMs, 'collector.requestTimeoutMs', warnings);
  config.collector = collector;

  const capsIn = objOf(input.capabilities);
  const capabilities = { ...base.capabilities };
  for (const key of Object.keys(base.capabilities)) {
    const wanted = boolOf(capsIn[key], base.capabilities[key], `capabilities.${key}`, warnings);
    if (wanted && LOCKED_OFF_CAPABILITIES.includes(key)) {
      warnings.push(`capabilities.${key} 本轮不可启用（没有实现代码路径），已强制为 false`);
      capabilities[key] = false;
      continue;
    }
    capabilities[key] = wanted;
  }
  for (const key of Object.keys(capsIn)) {
    if (!Object.hasOwn(base.capabilities, key)) warnings.push(`未知的 capabilities.${key} 已忽略`);
  }
  config.capabilities = capabilities;

  const sleepIn = objOf(input.sleep);
  const sleep = { ...base.sleep };
  sleep.schemaEnabled = boolOf(sleepIn.schemaEnabled, base.sleep.schemaEnabled, 'sleep.schemaEnabled', warnings);
  if (sleep.schemaEnabled === false) {
    // Honest: migration v1 always creates the sleep tables. Turning the switch off hides the
    // feature; it does not remove storage, and saying otherwise would be a lie in the UI.
    warnings.push('sleep.schemaEnabled=false 只隐藏睡眠读路径：v1 迁移仍会建睡眠表（不会删数据）');
  }
  sleep.displayEmptyState = boolOf(sleepIn.displayEmptyState, base.sleep.displayEmptyState, 'sleep.displayEmptyState', warnings);
  sleep.waitForFirstRealNight = boolOf(sleepIn.waitForFirstRealNight, base.sleep.waitForFirstRealNight, 'sleep.waitForFirstRealNight', warnings);
  sleep.altSourcesEnabled = boolOf(sleepIn.altSourcesEnabled, base.sleep.altSourcesEnabled, 'sleep.altSourcesEnabled', warnings);
  if (sleep.altSourcesEnabled) {
    warnings.push('sleep.altSourcesEnabled 本轮不可启用（没有其它睡眠来源），已强制为 false');
    sleep.altSourcesEnabled = false;
  }
  sleep.trendMinVerifiedNights = intOf(sleepIn.trendMinVerifiedNights, 1, 15, base.sleep.trendMinVerifiedNights, 'sleep.trendMinVerifiedNights', warnings);
  sleep.proactiveRulesEnabled = boolOf(sleepIn.proactiveRulesEnabled, base.sleep.proactiveRulesEnabled, 'sleep.proactiveRulesEnabled', warnings);
  if (sleep.proactiveRulesEnabled) {
    warnings.push('sleep.proactiveRulesEnabled 本轮不可启用（主动外发本轮关闭），已强制为 false');
    sleep.proactiveRulesEnabled = false;
  }
  config.sleep = sleep;

  const pulseIn = objOf(input.pulse);
  const pulse = { ...base.pulse };
  pulse.enabled = boolOf(pulseIn.enabled, base.pulse.enabled, 'pulse.enabled', warnings);
  pulse.baseUrl = baseUrlOf(pulseIn.baseUrl, base.pulse.baseUrl, warnings, 'pulse.baseUrl');
  pulse.deviceLabel = textOf(pulseIn.deviceLabel, 40, base.pulse.deviceLabel, 'pulse.deviceLabel', warnings);
  pulse.pollMs = intOf(pulseIn.pollMs, 250, 10000, base.pulse.pollMs, 'pulse.pollMs', warnings);
  pulse.deviceOffMs = intOf(pulseIn.deviceOffMs, 10000, 300000, base.pulse.deviceOffMs, 'pulse.deviceOffMs', warnings);
  pulse.connectTimeoutMs = intOf(pulseIn.connectTimeoutMs, 3000, 30000, base.pulse.connectTimeoutMs, 'pulse.connectTimeoutMs', warnings);
  pulse.inject = boolOf(pulseIn.inject, base.pulse.inject, 'pulse.inject', warnings);
  pulse.maxChars = intOf(pulseIn.maxChars, 80, 400, base.pulse.maxChars, 'pulse.maxChars', warnings);
  for (const key of Object.keys(pulseIn)) {
    if (!Object.hasOwn(base.pulse, key)) warnings.push(`未知的 pulse.${key} 已忽略`);
  }
  config.pulse = pulse;

  const privacyIn = objOf(input.privacy);  const privacy = { ...base.privacy };
  if (privacyIn.ownerOnly === false) warnings.push('privacy.ownerOnly 不可关闭，已强制为 true');
  privacy.ownerOnly = true;
  for (const key of ['exposeToGroup', 'exposeToBili']) {
    if (privacyIn[key] === true) warnings.push(`privacy.${key} 本轮不可开启，已强制为 false`);
    privacy[key] = false;
  }
  if (privacyIn.redactTokens === false) warnings.push('privacy.redactTokens 不可关闭，已强制为 true');
  privacy.redactTokens = true;
  config.privacy = privacy;

  return { config, warnings };
}

/**
 * Load (and on first run create) the config for one home.
 *
 * @param {object} options
 * @param {string} options.home        companion home directory
 * @param {object|null} options.override shallow-ish override, validated like the file
 * @param {boolean} options.writeDefaults  create the file when missing (false = read-only callers)
 * @param {Function} options.now
 * @returns {{file:string, config:object, warnings:string[], created:boolean, read:boolean,
 *            error:string|null, overridden:boolean}}
 */
export function loadConfig({ home, override = null, writeDefaults = true, now = Date.now } = {}) {
  const file = configFileOf(home);
  const out = { file, config: defaultConfig(), warnings: [], created: false, read: false, error: null, overridden: false };
  let raw = null;
  if (fs.existsSync(file)) {
    out.read = true;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      out.error = '配置文件不是合法 JSON，已按默认值运行（原文件未被改动）';
      raw = null;
    }
  }

  let validated = validateConfig(raw ?? {});
  if (override && typeof override === 'object' && !Array.isArray(override)) {
    out.overridden = true;
    const merged = mergeOverrides(validated.config, override);
    const again = validateConfig(merged);
    validated = { config: again.config, warnings: [...validated.warnings, ...again.warnings] };
  }
  out.config = validated.config;
  out.warnings = validated.warnings;

  if (!out.read && writeDefaults) {
    try {
      writeConfigAtomic(file, defaultConfig());
      out.created = true;
    } catch (error) {
      out.error = `无法写入默认配置（${shortError(error)}）`;
    }
  }
  return out;
}

/** One level of nested override, validated afterwards. Internal fields stay code-owned. */
function mergeOverrides(base, override) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      merged[key] = { ...base[key], ...value };
      continue;
    }
    if (value === undefined) continue;
    merged[key] = value;
  }
  return merged;
}

function shortError(error) {
  const text = error instanceof Error ? (error.message || error.code || '') : String(error ?? '');
  return String(text).replace(/\s+/g, ' ').slice(0, 120) || 'unknown error';
}
