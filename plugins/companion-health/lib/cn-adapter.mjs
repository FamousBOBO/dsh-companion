// HTTP boundary to the local Huawei-CN sidecar (INTERFACES.md §5).
//
// The sidecar is a Python process on 127.0.0.1:8765 that already owns the OAuth
// dance and the cloud reverse engineering. This module is the only place in the
// plugin that talks to it, and its whole job is to be a *safe* boundary:
//
//   * loopback only — a config typo must never ship health data to a remote host;
//   * the returned object can never carry an access/refresh token, a raw uid, a
//     device MAC or a device serial: the payload is rebuilt redacted and then
//     self-checked by `assertNoSecrets()` before it is handed to anyone;
//   * no payload ever reaches a log line — callers only get counts and codes.
//
// `assertNoSecrets()` is a regression guard, not decoration: it runs on every
// successful fetch, so a future edit that starts forwarding `payload.token.uid`
// fails here instead of quietly persisting an account identifier.

import { createHash } from 'node:crypto';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8765';
const DEFAULT_TIMEOUT_MS = 20000;

// 127.0.0.0/8 (any 127.x), localhost, and ::1 in both URL spellings.
const LOOPBACK_HOST = /^(?:127(?:\.\d{1,3}){3}|localhost|::1|\[::1\])$/i;

const TOKEN_LEAK = /access_?token|refresh_?token/i;
const UID_LEAK = /"(?:uid|huid|x-huid)"\s*:\s*"?[0-9]{6,}/i;
const MAC_LEAK = /(?:[0-9a-f]{2}:){5}[0-9a-f]{2}/i;

/** Stable 16-hex tag for a value the store must never keep verbatim. */
function shortHash(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 16);
}

function isLoopbackHost(hostname) {
  return LOOPBACK_HOST.test(String(hostname ?? ''));
}

function hostKindOf(...hosts) {
  const list = hosts.filter(value => typeof value === 'string' && value.trim());
  if (!list.length) return 'unknown';
  if (list.some(host => /dbankcloud\.(?:cn|com)$/i.test(host.replace(/^https?:\/\//i, '').replace(/\/.*$/, '')))) {
    return 'cn';
  }
  return 'other';
}

function tokenStatusOf(minutesLeft) {
  if (minutesLeft == null) return 'unknown';
  if (minutesLeft <= 0) return 'expired';
  if (minutesLeft <= 30) return 'expiring';
  return 'valid';
}

/**
 * Numeric coercion that does **not** turn `null` into 0.
 *
 * `Number(null) === 0`, which would make a missing `expires_in_min` report as
 * "expired" and send the user through a pointless re-login.
 */
function numOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function textOrNull(value) {
  return typeof value === 'string' && value.trim() ? value : null;
}

/**
 * Rebuild `payload.token` from scratch.
 *
 * The input object is never mutated and never returned: whatever shape the
 * sidecar grows next, the only token view that leaves this module is this one.
 *
 * The two expiry instants are published as the sidecar's *display text*
 * (`expires_at_text` / `refresh_dies_text`) and passed through unchanged, because
 * they are exactly what an operator needs ("when do I have to log in again?") and
 * they carry no credential. `normalize.mjs` resolves that text against the data
 * timezone; nothing here invents a `Date`.
 */
function redactTokenView(token) {
  const source = token && typeof token === 'object' ? token : {};
  // Idempotent: re-redacting an already-redacted token must not degrade it back to
  // "unknown" (the raw `expires_in_min` / `*_host` fields are gone by then).
  const already = source.redacted === true;
  const minutesLeft = already ? numOrNull(source.minutesLeft) : numOrNull(source.expires_in_min);
  const rotated = typeof source.rotated === 'boolean' ? source.rotated : null;
  const hostKind = already
    ? (['cn', 'other'].includes(source.hostKind) ? source.hostKind : 'unknown')
    : hostKindOf(source.data_host, source.session_host);
  const expiresAtText = textOrNull(source.expiresAtText) ?? textOrNull(source.expires_at_text);
  const refreshExpiresAtText = textOrNull(source.refreshExpiresAtText) ?? textOrNull(source.refresh_dies_text);
  return {
    status: tokenStatusOf(minutesLeft),
    minutesLeft,
    rotated,
    hostKind,
    expiresAtText,
    refreshExpiresAtText,
  };
}

/** The only thing worth keeping out of the vendor `deviceData` blob. */
function modelTextOf(row) {
  const bag = row?.deviceData;
  if (!bag) return null;
  let parsed = bag;
  if (typeof bag === 'string') {
    try {
      parsed = JSON.parse(bag);
    } catch {
      return null;
    }
  }
  const model = parsed?.mMap?.model ?? parsed?.model ?? null;
  return typeof model === 'string' && model.trim() ? model.trim() : null;
}

/** Device rows carry identifiers the store must never keep verbatim. */
function redactDevice(row) {
  if (!row || typeof row !== 'object') return row;
  const out = { ...row };
  // Keep the model name (needed to classify a handset) but drop the blob around it.
  const model = modelTextOf(row);
  if (model) out.model = model;
  // Dropped outright: a MAC/serial/udid is a hardware identifier with no analytic use.
  for (const key of ['mac', 'sn', 'udid', 'deviceData', 'firmwareVersion', 'hardwareVersion', 'softwareVersion']) {
    delete out[key];
  }
  for (const key of ['uniqueId', 'devId']) {
    // Re-redacting an already hashed value must not hash the hash.
    if (typeof out[key] === 'string' && out[key] && !/^[0-9a-f]{16}$/i.test(out[key])) {
      out[key] = shortHash(out[key]);
    }
  }
  return out;
}

/**
 * Rebuild the window payload with every secret-bearing field replaced.
 *
 * Exported because `ingest.mjs` re-checks it before storing a receipt, and because
 * a test that wants a realistic payload must run it through this same function —
 * a hand-redacted fixture would prove nothing about the real path.
 *
 * NOTE (documented deviation, INTERFACES.md §5 says "payload 原样"): keeping the
 * raw device rows verbatim would put plaintext MAC/serial into
 * `health_raw_refs.payload_json`, which §4/§15 forbid. The removed fields are not
 * used by `normalize.mjs`, so nothing downstream loses information.
 */
export function redactWindowPayload(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const out = { ...source };
  const token = redactTokenView(source.token);
  out.token = {
    redacted: true,
    ...token,
    // Sidecar spelling kept on purpose: the status page reads the *display* text
    // from here, and dropping it would silently blank "refresh token expires at".
    expires_at_text: token.expiresAtText,
    refresh_dies_text: token.refreshExpiresAtText,
  };
  out.devices = Array.isArray(source.devices) ? source.devices.map(redactDevice) : [];
  return out;
}

/**
 * Hard self-check. Any of these patterns means the redaction above was bypassed.
 *
 * Throws instead of returning a flag: a payload that reached this point is one
 * someone was about to persist, and "log a warning and carry on" is exactly how
 * a token ends up in a SQLite file.
 */
export function assertNoSecrets(value, label = 'window') {
  let text;
  try {
    text = JSON.stringify(value);
  } catch (error) {
    throw new Error(`健康数据自检失败（${label} 无法序列化）：${error?.message ?? error}`);
  }
  if (text == null) return true;
  if (TOKEN_LEAK.test(text)) throw new Error(`健康数据自检失败（${label} 含 token 字段），已拒绝继续。`);
  if (UID_LEAK.test(text)) throw new Error(`健康数据自检失败（${label} 含明文 uid），已拒绝继续。`);
  if (MAC_LEAK.test(text)) throw new Error(`健康数据自检失败（${label} 含设备 MAC），已拒绝继续。`);
  return true;
}

/**
 * Create the sidecar client.
 *
 * `fetchImpl` is injectable so tests never open a socket, and `now` is injectable
 * so latency numbers are deterministic.
 */
export function createCnAdapter({
  baseUrl = DEFAULT_BASE_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
} = {}) {
  const clock = () => {
    const value = Number(now());
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : Date.now();
  };

  let parsed = null;
  let loopback = false;
  try {
    parsed = new URL(String(baseUrl));
    loopback = isLoopbackHost(parsed.hostname);
  } catch {
    parsed = null;
    loopback = false;
  }

  const trimmedBase = parsed ? `${parsed.protocol}//${parsed.host}` : String(baseUrl ?? '').replace(/\/+$/, '');

  function describe() {
    return { baseUrl: trimmedBase, loopback, timeoutMs };
  }

  async function fetchWindow({ days = 7, force = false } = {}) {
    const startedAt = clock();
    const elapsed = () => Math.max(0, clock() - startedAt);

    // 1. Refuse before any socket is opened.
    if (!loopback) {
      return { ok: false, errorCode: 'non-loopback-refused', httpStatus: 0, latencyMs: 0 };
    }
    if (typeof fetchImpl !== 'function') {
      return { ok: false, errorCode: 'unreachable', httpStatus: 0, latencyMs: 0 };
    }

    const windowDays = Number.isFinite(Number(days)) ? Math.max(1, Math.trunc(Number(days))) : 7;
    const query = new URLSearchParams({ days: String(windowDays) });
    if (force) query.set('force', '1');
    const url = `${trimmedBase}/api/data?${query.toString()}`;

    // 2. One attempt, one timeout. Backoff is the caller's (ingest) decision.
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: typeof AbortSignal?.timeout === 'function'
          ? AbortSignal.timeout(Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS))
          : undefined,
      });
    } catch (error) {
      const name = String(error?.name ?? '');
      const code = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unreachable';
      return { ok: false, errorCode: code, httpStatus: 0, latencyMs: elapsed() };
    }

    const httpStatus = Number(response?.status ?? 0) || 0;
    if (!response || response.ok !== true) {
      return { ok: false, errorCode: 'http-error', httpStatus, latencyMs: elapsed() };
    }

    let payload;
    try {
      const text = await response.text();
      payload = JSON.parse(text);
    } catch {
      return { ok: false, errorCode: 'bad-json', httpStatus, latencyMs: elapsed() };
    }
    if (!payload || typeof payload !== 'object') {
      return { ok: false, errorCode: 'bad-json', httpStatus, latencyMs: elapsed() };
    }

    const fetchedAt = clock();
    const redactedToken = redactTokenView(payload.token);
    const result = {
      ok: true,
      httpStatus,
      latencyMs: elapsed(),
      fetchedAt,
      days: windowDays,
      payload: redactWindowPayload(payload),
      redactedToken,
      errors: Array.isArray(payload.errors) ? payload.errors : [],
    };

    // 3. Fail closed if anything above was bypassed.
    assertNoSecrets(result, 'fetchWindow');
    return result;
  }

  return { describe, fetchWindow };
}

export { DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS, isLoopbackHost, shortHash };
