import { Code, mapNetworkError, mediaError } from './errors.mjs';
import { redactText } from './secrets.mjs';

/**
 * The only way this plugin talks to the network.
 *
 * Guarantees, all of which are proven by tests:
 *  - a total deadline for the whole request (redirects included), not per hop;
 *  - a hard byte cap while reading, so a hostile or broken upstream cannot fill
 *    memory or disk;
 *  - one redirect budget, re-checked per hop (no https → file, no metadata IP);
 *  - the response body is never echoed verbatim into an error message without
 *    redaction.
 *
 * Local addresses are allowed on purpose: every TTS server in scope (Breeze
 * FastAPI, GPT-SoVITS) is expected to run on 127.0.0.1. That is a *local
 * service* allowance, not a general SSRF allowance — link-local/metadata
 * addresses stay blocked and non-http(s) protocols stay blocked.
 */

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 2;
/** Defaults are exported so tests and the docs can prove the numbers instead of quoting them. */
export { DEFAULT_MAX_BYTES, DEFAULT_MAX_REDIRECTS };
export const DEFAULT_TIMEOUT_MS = 60_000;

export class NetError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function assertAllowedUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    throw mediaError(Code.DOWNLOAD_BLOCKED, 'request URL is not a valid absolute URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw mediaError(Code.DOWNLOAD_BLOCKED, `protocol ${url.protocol} is not allowed (http/https only)`);
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === '169.254.169.254' || /^169\.254\./.test(host)) {
    throw mediaError(Code.DOWNLOAD_BLOCKED, 'link-local / cloud metadata addresses are blocked');
  }
  return url;
}

async function readBounded(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length') ?? 0);
  if (declared && declared > maxBytes) {
    throw mediaError(Code.TOO_LARGE, `response declares ${declared} bytes; the limit is ${maxBytes}`);
  }
  if (!response.body || typeof response.body[Symbol.asyncIterator] !== 'function') {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw mediaError(Code.TOO_LARGE, `response is ${buffer.length} bytes; the limit is ${maxBytes}`);
    return buffer;
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    const buf = Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) throw mediaError(Code.TOO_LARGE, `response exceeds the ${maxBytes} byte limit`);
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/**
 * Build a transport. `fetchImpl` is injectable so the tests never touch a
 * socket, and `now` is injectable so the deadline can be tested without sleeping.
 */
export function createNet({ fetchImpl = globalThis.fetch, now = () => Date.now(), defaultMaxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('createNet needs a fetch implementation');

  /**
   * @returns {Promise<{status:number, ok:boolean, bytes:Buffer, mime:string,
   *   headers:Map<string,string>, finalUrl:string, hops:string[]}>}
   */
  async function request(rawUrl, options = {}) {
    const {
      method = 'GET',
      headers = {},
      body = undefined,
      timeoutMs = DEFAULT_TIMEOUT_MS,
      maxBytes = defaultMaxBytes,
      maxRedirects = DEFAULT_MAX_REDIRECTS,
      provider = 'provider',
      signal = null,
    } = options;

    const deadline = now() + timeoutMs;
    let current = String(rawUrl);
    const hops = [];

    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      assertAllowedUrl(current);
      hops.push(current);
      const remaining = deadline - now();
      if (remaining <= 0) throw mediaError(Code.TIMEOUT, `${provider} request timed out after ${timeoutMs} ms`);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('media request timed out')), remaining);
      const abortFromCaller = () => controller.abort(new Error('media request cancelled'));
      if (signal) {
        if (signal.aborted) abortFromCaller();
        else signal.addEventListener('abort', abortFromCaller, { once: true });
      }
      try {
        let response;
        try {
          response = await fetchImpl(current, {
            method,
            headers,
            body,
            redirect: 'manual',
            signal: controller.signal,
          });
        } catch (error) {
          throw mapNetworkError(error, { provider, timeoutMs });
        }

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers?.get?.('location');
          if (!location) throw mediaError(Code.DOWNLOAD_BLOCKED, `${provider} answered ${response.status} without a Location header`);
          current = new URL(location, current).toString();
          continue;
        }

        const bytes = await readBounded(response, maxBytes);
        const headerMap = new Map();
        if (response.headers?.forEach) response.headers.forEach((value, key) => headerMap.set(String(key).toLowerCase(), String(value)));
        return {
          status: response.status,
          ok: Boolean(response.ok),
          bytes,
          mime: headerMap.get('content-type') ?? '',
          headers: headerMap,
          finalUrl: current,
          hops,
        };
      } catch (error) {
        // An abort raised by our own deadline is a TIMEOUT, whatever shape the
        // runtime hands back (`AbortError`, or a `fetch failed` wrapper around
        // the abort reason).
        if (controller.signal.aborted) {
          throw mediaError(Code.TIMEOUT, `${provider} request timed out after ${timeoutMs} ms`);
        }
        if (error instanceof Error && error.name === 'AbortError') {
          throw mediaError(Code.TIMEOUT, `${provider} request timed out after ${timeoutMs} ms`);
        }
        throw error;
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener?.('abort', abortFromCaller);
      }
    }
    throw mediaError(Code.DOWNLOAD_BLOCKED, `${provider} redirected more than ${maxRedirects} times`);
  }

  /** Fetch a URL and parse JSON, keeping the same byte cap and deadline. */
  async function json(rawUrl, options = {}) {
    const response = await request(rawUrl, options);
    const text = response.bytes.toString('utf8');
    if (!response.ok) {
      throw mediaError(
        Code.UPSTREAM,
        `${options.provider ?? 'provider'} answered HTTP ${response.status}: ${redactText(text).slice(0, 200)}`,
      );
    }
    try {
      return { ...response, json: JSON.parse(text) };
    } catch {
      throw mediaError(Code.UPSTREAM, `${options.provider ?? 'provider'} returned a non-JSON body`);
    }
  }

  return { request, json, fetchImpl };
}

/** Convenience for callers that only have a config object. */
export function netFromOptions(options = {}) {
  return options.net ?? createNet(options);
}
