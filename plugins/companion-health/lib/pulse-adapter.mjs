// HTTP boundary to the local BLE heart-rate sidecar (design/pulse-bond-20261103.md §3).
//
// Same three rules as `cn-adapter.mjs`, for the same reasons:
//
//   * loopback only — a config typo must never ship a body signal to a remote host;
//   * one attempt, one timeout — the caller owns retry/backoff, and a pulse poll that hangs is
//     worse than a poll that fails;
//   * **fail closed on anything unexpected.** The payload is rebuilt field by field from a
//     whitelist, so a future sidecar field cannot leak into a prompt, a database row or a log.
//     A MAC address in the reply is treated as a bug and the whole answer is dropped rather than
//     cleaned up — an address that reached this point is one someone was about to persist.
//
// `bpm` is never invented: `null` in means `null` out. Nothing here computes a heart rate.

import { isLoopbackHost, shortHash } from './cn-adapter.mjs';

export const DEFAULT_PULSE_BASE_URL = 'http://127.0.0.1:8151';
export const DEFAULT_PULSE_TIMEOUT_MS = 1500;
/** `/api/connect` scans and connects in one call; anything below the sidecar's own 12 s is a lie. */
export const CONNECT_TIMEOUT_MS = 15000;

/** Bluetooth address in any common spelling (`aa:bb:…`, `AA-BB-…`, no separators). */
const MAC_LEAK = /(?:[0-9a-f]{2}[:\-]){5}[0-9a-f]{2}|\b[0-9a-f]{12}\b/i;

/** Error codes the sidecar is allowed to report. Anything else becomes `null`. */
export const PULSE_ERROR_CODES = Object.freeze([
  'scan-timeout',
  'connect-failed',
  'notify-failed',
  'disconnected',
]);

export const PULSE_QUALITIES = Object.freeze(['ok', 'sparse', 'no-contact']);
export const CONTACT_STATES = Object.freeze(['yes', 'no', 'unsupported']);

function intOrNull(value, min, max) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const rounded = Math.round(parsed);
  if (rounded < min || rounded > max) return null;
  return rounded;
}

function shortTextOrNull(value, max) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

/**
 * Rebuild one `/api/state` reply from a whitelist.
 *
 * `nowMs` is used to recompute `sampleAgeMs` locally instead of trusting the sidecar's clock:
 * the age is what decides between "sparse" and "stale" in a prompt, and that decision must not
 * depend on the helper process having a correct clock.
 */
export function sanitizeState(raw, { nowMs = Date.now(), freshMs = 15000, sparseMs = 5000 } = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const connected = source.connected === true;
  const bpm = intOrNull(source.bpm, 20, 250);
  const sampleAt = intOrNull(source.sampleAt, 1, Number.MAX_SAFE_INTEGER);
  const sampleAgeMs = sampleAt == null ? null : Math.max(0, Math.trunc(Number(nowMs) - sampleAt));
  const contact = CONTACT_STATES.includes(source.contact) ? source.contact : 'unsupported';
  const rrMs = Array.isArray(source.rrMs)
    ? source.rrMs.map(value => intOrNull(value, 250, 2500)).filter(value => value != null).slice(-30)
    : [];
  const addressHash = typeof source.addressHash === 'string' && /^[0-9a-f]{16}$/i.test(source.addressHash)
    ? source.addressHash.toLowerCase()
    : null;

  // Quality is derived here, not taken from the wire: the sidecar's own notion of "recent" is
  // allowed to drift, the prompt's is not.
  let quality = 'ok';
  if (bpm != null && sampleAgeMs != null && sampleAgeMs > sparseMs) quality = 'sparse';
  if (contact === 'no') quality = 'no-contact';
  if (bpm == null) quality = 'sparse';

  return {
    ok: true,
    connected,
    deviceLabel: shortTextOrNull(source.deviceLabel, 40),
    addressHash,
    bpm,
    rrMs,
    contact,
    sensorLocation: shortTextOrNull(source.sensorLocation, 20),
    sampleAt,
    sampleAgeMs,
    quality,
    freshMs,
    sparseMs,
    lastErrorCode: PULSE_ERROR_CODES.includes(source.lastErrorCode) ? source.lastErrorCode : null,
    scanning: source.scanning === true,
  };
}

/** True when the rebuilt object still carries something address-shaped. */
export function containsAddress(value) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    return true;
  }
  return text != null && MAC_LEAK.test(text);
}

/**
 * Create the pulse client. `fetchImpl` is injectable so tests never open a socket.
 */
export function createPulseAdapter({
  baseUrl = DEFAULT_PULSE_BASE_URL,
  timeoutMs = DEFAULT_PULSE_TIMEOUT_MS,
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
  const trimmedBase = parsed
    ? `${parsed.protocol}//${parsed.host}`
    : String(baseUrl ?? '').replace(/\/+$/, '');

  function describe() {
    return { baseUrl: trimmedBase, loopback, timeoutMs };
  }

  async function request(pathname, { method = 'GET', body = null, timeoutOverride = null } = {}) {
    const startedAt = clock();
    const elapsed = () => Math.max(0, clock() - startedAt);

    // Refuse before any socket is opened.
    if (!loopback) return { ok: false, code: 'non-loopback-refused', latencyMs: 0 };
    if (typeof fetchImpl !== 'function') return { ok: false, code: 'unreachable', latencyMs: 0 };

    const budget = Math.max(1, Number(timeoutOverride) || Number(timeoutMs) || DEFAULT_PULSE_TIMEOUT_MS);
    let response;
    try {
      response = await fetchImpl(`${trimmedBase}${pathname}`, {
        method,
        headers: body
          ? { accept: 'application/json', 'content-type': 'application/json' }
          : { accept: 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: typeof AbortSignal?.timeout === 'function'
          ? AbortSignal.timeout(budget)
          : undefined,
      });
    } catch (error) {
      const name = String(error?.name ?? '');
      const code = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unreachable';
      return { ok: false, code, latencyMs: elapsed() };
    }

    const httpStatus = Number(response?.status ?? 0) || 0;
    if (!response || response.ok !== true) return { ok: false, code: 'http-error', httpStatus, latencyMs: elapsed() };

    let payload;
    try {
      payload = JSON.parse(await response.text());
    } catch {
      return { ok: false, code: 'bad-json', httpStatus, latencyMs: elapsed() };
    }
    if (!payload || typeof payload !== 'object') return { ok: false, code: 'bad-json', httpStatus, latencyMs: elapsed() };
    return { ok: true, payload, httpStatus, latencyMs: elapsed(), at: clock() };
  }

  /** One `/api/state` read, sanitized. Failure is a code, never an exception. */
  async function state() {
    const result = await request('/api/state');
    if (result.ok !== true) return result;
    if (result.payload.ok === false) {
      return { ok: false, code: String(result.payload.code ?? 'internal').slice(0, 40), latencyMs: result.latencyMs };
    }
    const clean = sanitizeState(result.payload, { nowMs: clock() });
    if (containsAddress(clean)) {
      // Fail closed: the field list above should have made this impossible.
      return { ok: false, code: 'payload-rejected', latencyMs: result.latencyMs };
    }
    return { ok: true, ...clean, at: result.at, latencyMs: result.latencyMs };
  }

  /** Candidate devices from the last scan. Addresses are hash-only. */
  async function devices() {
    const result = await request('/api/devices');
    if (result.ok !== true) return result;
    const rows = Array.isArray(result.payload.devices) ? result.payload.devices : [];
    const devices = rows.map(row => ({
      label: shortTextOrNull(row?.label, 40),
      addressHash: typeof row?.addressHash === 'string' && /^[0-9a-f]{16}$/i.test(row.addressHash)
        ? row.addressHash.toLowerCase()
        : (typeof row?.address === 'string' ? shortHash(row.address) : null),
      rssi: intOrNull(row?.rssi, -120, 0),
      hasHrs: row?.hasHrs === true,
    })).filter(row => row.label || row.addressHash).slice(0, 20);
    if (containsAddress(devices)) return { ok: false, code: 'payload-rejected' };
    return {
      ok: true,
      scannedAt: intOrNull(result.payload.scannedAt, 1, Number.MAX_SAFE_INTEGER),
      devices,
    };
  }

  async function connect({ address = null, nameHint = null } = {}) {
    const body = {};
    if (typeof address === 'string' && address.trim()) body.address = address.trim().slice(0, 120);
    if (typeof nameHint === 'string' && nameHint.trim()) body.nameHint = nameHint.trim().slice(0, 40);
    // The sidecar scans and then connects inside this one call, so it needs a far bigger budget than
    // an ordinary state poll (its own `--connect-timeout` defaults to 12 s).
    const result = await request('/api/connect', { method: 'POST', body, timeoutOverride: CONNECT_TIMEOUT_MS });
    if (result.ok !== true) return result;
    return { ok: result.payload.ok !== false, code: result.payload.code ?? null, connected: result.payload.connected === true };
  }

  async function disconnect() {
    const result = await request('/api/disconnect', { method: 'POST', body: {} });
    if (result.ok !== true) return result;
    return { ok: result.payload.ok !== false, code: result.payload.code ?? null, connected: false };
  }

  return { describe, state, devices, connect, disconnect };
}

export { isLoopbackHost, shortHash, MAC_LEAK };
