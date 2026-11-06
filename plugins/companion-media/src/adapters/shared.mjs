import crypto from 'node:crypto';
import { Code, mapRemoteStatus, mediaError } from '../errors.mjs';
import { redactText } from '../secrets.mjs';

/**
 * Helpers shared by every adapter.
 *
 * These exist so each adapter contains only its protocol, not its plumbing. In
 * particular, **no adapter builds an error message by pasting a body** without
 * going through `remoteFailure()`, which redacts first.
 */

/** Join a user-supplied base URL with an API path exactly once. */
export function joinUrl(baseUrl, apiPath) {
  const base = String(baseUrl ?? '').trim();
  if (!base) throw mediaError(Code.NOT_CONFIGURED, 'Base URL 未填写');
  const trimmed = base.replace(/\/+$/, '');
  const suffix = apiPath.startsWith('/') ? apiPath : `/${apiPath}`;
  return `${trimmed}${suffix}`;
}

/** The Authorization header, or nothing when the service has no auth (local TTS). */
export function authHeaders(key) {
  const value = typeof key === 'string' ? key.trim() : '';
  return value ? { Authorization: `Bearer ${value}` } : {};
}

/** Turn a non-2xx response into a typed MediaError without leaking the body. */
export function remoteFailure(response, { provider, what = 'request' }) {
  const text = redactText(response?.bytes?.toString?.('utf8') ?? '');
  const retryAfter = response?.headers?.get?.('retry-after') ?? null;
  const error = mapRemoteStatus(response?.status ?? 0, { provider, body: text, retryAfter });
  error.message = `${what}: ${error.message}`;
  return error;
}

export function ensureOk(response, context) {
  if (!response?.ok) throw remoteFailure(response, context);
  return response;
}

/** Parse JSON out of a response body, with the HTTP status handled first. */
export function parseJsonBody(response, { provider }) {
  ensureOk(response, { provider });
  const text = response.bytes.toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    // A 200 that is not JSON means the endpoint is not speaking the documented
    // protocol (a proxy error page, a login redirect, an HTML gateway) — that is
    // a protocol violation, not an image and not a transient upstream failure.
    throw mediaError(
      Code.UNSUPPORTED_TYPE,
      `${provider} 返回的不是 JSON（Content-Type: ${response.mime || '空'}；前 80 字符：${redactText(text).slice(0, 80)}）`,
    );
  }
}

/** Reachability probe used by connection tests that must not spend money. */
export async function probeReachability({ net, url, headers = {}, timeoutMs, provider }) {
  try {
    const response = await net.request(url, { headers, timeoutMs, provider, maxBytes: 64 * 1024 });
    return {
      ok: true,
      level: 'reachability',
      status: response.status,
      detail: `端点可达（HTTP ${response.status}）；本测试不发起计费生成，凭据与模型是否可用需操作者手动验证`,
    };
  } catch (error) {
    return { ok: false, level: 'reachability', code: error?.code ?? Code.NETWORK, detail: error?.message ?? String(error) };
  }
}

/** Highest seed the endpoint accepts (`0 … 2^32-1`). */
export const SEED_MAX = 0xffff_ffff;

/**
 * Resolve the seed that is actually sent.
 *
 * Config `seed: -1` means "a fresh seed per image". It must NOT be forwarded as
 * `-1`: NovelAI's V5/V4.5 encoder answers `seed: -1` with a bare
 * `HTTP 500 {"statusCode":500,"message":"Internal Server Error"}`, which looks
 * exactly like an outage. Verified against the live endpoint on 2026-11-06 —
 * identical request body, only the seed changed:
 *
 *     seed: -1                 → 500, 53 bytes of JSON
 *     seed: <random int>       → 200, ZIP with the PNG
 *
 * So the random seed is resolved here, and the value used is reported back in
 * `meta.seed`, which keeps a generated image reproducible.
 */
export function resolveSeed(section, randomInt = max => crypto.randomInt(0, max)) {
  const configured = section?.seed;
  if (Number.isInteger(configured) && configured >= 0 && configured <= SEED_MAX) return configured;
  return randomInt(SEED_MAX + 1);
}

/** Build the `parameters` object for NovelAI transports. Shared by both styles. */
export function buildNaiParameters(section, { prompt, negative, preset }) {
  const family = preset.family;
  const parameters = {
    width: section.width,
    height: section.height,
    scale: section.scale,
    sampler: section.sampler,
    noise_schedule: section.noiseSchedule,
    steps: section.steps,
    n_samples: 1,
    seed: resolveSeed(section),
    negative_prompt: negative,
    ucPreset: section.negativePreset && section.negativePreset !== 'legacy' ? undefined : section.ucPreset,
    qualityToggle: section.qualityPreset && section.qualityPreset !== 'legacy' ? false : Boolean(section.qualityToggle),
    sm: Boolean(section.sm),
    sm_dyn: Boolean(section.smDyn),
  };
  // V4/V5 take the structured caption; V3-era fields stay out of it so an old
  // model cannot receive a shape it does not understand.
  if (family === '5' || family === '4.5') {
    // `params_version: 3` pins the caption-envelope semantics this block sends;
    // the reference client that is verified against the live API always sets it.
    // (Not proven necessary on its own — the 500 above was the seed — but it is
    // part of the shape that is known to work, so it stays.)
    parameters.params_version = 3;
    // `uc` is the V4+/V5 "undesired content" field. `negative_prompt` is kept
    // alongside it for compatibility and carries the same text on purpose, which
    // is how the verified reference client sends it.
    parameters.uc = negative;
    parameters.v4_prompt = {
      caption: { base_caption: prompt, char_captions: [] },
      use_coords: false,
      use_order: false,
    };
    parameters.v4_negative_prompt = {
      caption: { base_caption: negative, char_captions: [] },
      legacy_uc: false,
    };
  }
  return parameters;
}
