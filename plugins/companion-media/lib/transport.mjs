import fs from 'node:fs';
import dns from 'node:dns/promises';
import { Code, mediaError } from './errors.mjs';
import { sha256Hex } from './ids.mjs';

// Bounded fetching for remote media.
//
// The old stack learned the hard way that a public URL can redirect into the
// LAN, so every hop is re-checked. Loopback is refused unless the caller
// explicitly allows local sources (the QQ client serves attachments from
// 127.0.0.1), and that permission is per-call, not global.

const PRIVATE_V4 = [
  [/^10\./, '10.0.0.0/8'],
  [/^127\./, 'loopback'],
  [/^169\.254\./, 'link-local'],
  [/^192\.168\./, '192.168.0.0/16'],
  [/^172\.(1[6-9]|2\d|3[01])\./, '172.16.0.0/12'],
  [/^0\./, '0.0.0.0/8'],
];

export function classifyHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return 'loopback';
  if (host === '::1') return 'loopback';
  // IPv4-mapped IPv6 (::ffff:127.0.0.1) reaches the same address as its dotted form.
  const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return classifyHost(mapped[1]);
  const mappedHex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const high = parseInt(mappedHex[1], 16);
    const low = parseInt(mappedHex[2], 16);
    const dotted = `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
    return classifyHost(dotted);
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    for (const [pattern, label] of PRIVATE_V4) if (pattern.test(host)) return label;
    return 'public';
  }
  if (/^f[cd][0-9a-f]{2}:/i.test(host)) return 'ipv6-ula';
  if (/^fe80:/i.test(host)) return 'ipv6-link-local';
  return 'public';
}

/**
 * Resolve a hostname and classify every address it answers with.
 * A public-looking name that resolves to loopback is exactly the SSRF shape the
 * old stack guarded against, so the string check alone is not enough.
 */
export async function resolveHostClass(hostname, { resolver } = {}) {
  const literal = classifyHost(hostname);
  if (literal !== 'public') return { klass: literal, addresses: [] };
  const lookup = resolver ?? (async name => dns.lookup(name, { all: true, verbatim: true }));
  let addresses;
  try {
    addresses = await lookup(hostname);
  } catch (error) {
    return { klass: 'unresolved', addresses: [], error: String(error?.message ?? error) };
  }
  const list = Array.isArray(addresses) ? addresses : [addresses];
  for (const entry of list) {
    const address = typeof entry === 'string' ? entry : entry?.address;
    const klass = classifyHost(address);
    if (klass !== 'public') return { klass, addresses: list.map(item => (typeof item === 'string' ? item : item?.address)) };
  }
  return { klass: 'public', addresses: list.map(item => (typeof item === 'string' ? item : item?.address)) };
}

/** Pure policy check; no I/O, so it is cheap to test. */
export function checkUrlAllowed(rawUrl, { allowLocal = false } = {}) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allowed: false, code: Code.DOWNLOAD_BLOCKED, reason: 'invalid url' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { allowed: false, code: Code.DOWNLOAD_BLOCKED, reason: `protocol ${url.protocol} is not allowed` };
  }
  const kind = classifyHost(url.hostname);
  if (kind !== 'public' && !allowLocal) {
    return { allowed: false, code: Code.DOWNLOAD_BLOCKED, reason: `address class ${kind} requires an explicit local allowance` };
  }
  return { allowed: true, kind, url };
}

async function readBounded(response, maxBytes) {
  const chunks = [];
  let total = 0;
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw mediaError(Code.TOO_LARGE, `response exceeds ${maxBytes} bytes`);
    return buffer;
  }
  for await (const chunk of response.body) {
    const buf = Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) throw mediaError(Code.TOO_LARGE, `response exceeds ${maxBytes} bytes`);
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/**
 * Fetch one URL with hop-by-hop policy checks, a byte cap and one deadline for
 * the whole download (not per hop, which previously let a redirect chain spend
 * several times the configured budget).
 * @returns `{bytes, mime, finalUrl, hops}`.
 */
export async function fetchBounded(rawUrl, {
  fetchImpl = globalThis.fetch,
  allowLocal = false,
  maxBytes = 12 * 1024 * 1024,
  maxRedirects = 2,
  timeoutMs = 20_000,
  resolver = null,
} = {}) {
  if (typeof fetchImpl !== 'function') throw mediaError(Code.BACKEND_UNAVAILABLE, 'no fetch implementation');
  const deadline = Date.now() + timeoutMs;
  let current = rawUrl;
  const hops = [];
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const verdict = checkUrlAllowed(current, { allowLocal });
    if (!verdict.allowed) throw mediaError(verdict.code, `${verdict.reason}: ${current}`);
    if (!allowLocal) {
      const resolved = await resolveHostClass(verdict.url.hostname, { resolver });
      if (resolved.klass !== 'public') {
        throw mediaError(Code.DOWNLOAD_BLOCKED, `host resolves to ${resolved.klass}: ${verdict.url.hostname}`);
      }
    }
    hops.push(current);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw mediaError(Code.TIMEOUT, `download timed out after ${timeoutMs} ms`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('media download timed out')), remaining);
    try {
      const response = await fetchImpl(current, { redirect: 'manual', signal: controller.signal });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) throw mediaError(Code.DOWNLOAD_FAILED, `redirect ${response.status} without location`);
        current = new URL(location, current).toString();
        continue;
      }
      if (!response.ok) throw mediaError(Code.DOWNLOAD_FAILED, `HTTP ${response.status} for ${current}`);
      const declared = Number(response.headers.get('content-length') ?? 0);
      if (declared && declared > maxBytes) throw mediaError(Code.TOO_LARGE, `declared length ${declared} exceeds ${maxBytes}`);
      const bytes = await readBounded(response, maxBytes);
      return {
        bytes,
        mime: response.headers.get('content-type') ?? '',
        finalUrl: current,
        hops,
        sha256: sha256Hex(bytes),
      };
    } catch (error) {
      if (error?.name === 'AbortError') throw mediaError(Code.TIMEOUT, `download timed out after ${timeoutMs} ms`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw mediaError(Code.DOWNLOAD_BLOCKED, `more than ${maxRedirects} redirects`);
}

/**
 * Deterministic transport for tests and mock channels.
 * `routes` maps an exact URL to `{bytes, mime}` or a function returning that.
 */
export function createMockTransport(routes = {}) {
  const calls = [];
  const transport = {
    calls,
    async fetchBounded(url, options = {}) {
      calls.push({ url, options });
      const entry = routes[url];
      if (!entry) throw mediaError(Code.DOWNLOAD_FAILED, `mock transport has no route for ${url}`);
      const value = typeof entry === 'function' ? await entry(options) : entry;
      if (value?.error) throw mediaError(value.error.code ?? Code.DOWNLOAD_FAILED, value.error.message ?? 'mock error');
      const bytes = Buffer.isBuffer(value.bytes) ? value.bytes : Buffer.from(value.bytes ?? []);
      return { bytes, mime: value.mime ?? 'application/octet-stream', finalUrl: url, hops: [url], sha256: sha256Hex(bytes) };
    },
  };
  return transport;
}

/** File-path sources still go through the same limits, minus the network checks. */
export function readLocalSource(filePath, { maxBytes = 12 * 1024 * 1024 } = {}) {
  const stat = fs.statSync(filePath);
  if (stat.size > maxBytes) throw mediaError(Code.TOO_LARGE, `file is ${stat.size} bytes; limit is ${maxBytes}`);
  return fs.readFileSync(filePath);
}
