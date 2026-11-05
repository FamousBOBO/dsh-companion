import { redactText } from './secrets.mjs';

/**
 * Stable error codes for every media capability.
 *
 * The point of a fixed code list is that the UI, the docs and the tests can
 * agree on what a failure means without parsing English sentences. Every code
 * here is used by at least one adapter or by the config layer.
 */
export const Code = Object.freeze({
  DISABLED: 'MEDIA_DISABLED',
  BAD_INPUT: 'MEDIA_BAD_INPUT',
  NOT_CONFIGURED: 'MEDIA_NOT_CONFIGURED',
  PROVIDER_UNKNOWN: 'MEDIA_PROVIDER_UNKNOWN',
  PROVIDER_NOT_IMPLEMENTED: 'MEDIA_PROVIDER_NOT_IMPLEMENTED',
  VISION_LOCKED: 'MEDIA_VISION_LOCKED',
  CONFIG_INVALID: 'MEDIA_CONFIG_INVALID',
  PARAM_OUT_OF_RANGE: 'MEDIA_PARAM_OUT_OF_RANGE',
  AUTH_FAILED: 'MEDIA_AUTH_FAILED',
  ENTITLEMENT: 'MEDIA_ENTITLEMENT',
  RATE_LIMITED: 'MEDIA_RATE_LIMITED',
  TIMEOUT: 'MEDIA_TIMEOUT',
  NETWORK: 'MEDIA_NETWORK',
  UPSTREAM: 'MEDIA_UPSTREAM',
  BACKEND_BUSY: 'MEDIA_BACKEND_BUSY',
  TOO_LARGE: 'MEDIA_TOO_LARGE',
  UNSUPPORTED_TYPE: 'MEDIA_UNSUPPORTED_TYPE',
  DOWNLOAD_BLOCKED: 'MEDIA_DOWNLOAD_BLOCKED',
  NO_TEXT: 'MEDIA_NO_TEXT',
  ARTIFACT_FAILED: 'MEDIA_ARTIFACT_FAILED',
  CANCELLED: 'MEDIA_CANCELLED',
  UNKNOWN: 'MEDIA_UNKNOWN',
});

export class MediaError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'MediaError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function mediaError(code, message, details) {
  return new MediaError(code, message, details);
}

/** Convert any thrown value into the `{ code, message }` shape every API returns. */
export function toFailure(error, fallback = Code.UNKNOWN) {
  if (error instanceof MediaError) {
    return { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) };
  }
  if (error?.name === 'AbortError') return { code: Code.CANCELLED, message: 'request aborted' };
  const message = error instanceof Error ? error.message : String(error);
  const code = typeof error?.code === 'string' && error.code.startsWith('MEDIA_') ? error.code : fallback;
  return { code, message: String(message).slice(0, 500) };
}

/**
 * Map a remote HTTP failure onto a code plus an actionable, secret-free hint.
 *
 * `body` is deliberately truncated and must already be redacted by the caller
 * (`secrets.redactText`); this function never echoes a raw body longer than the
 * limit, because an upstream error body can quote the request that carried the
 * key.
 */
export function mapRemoteStatus(status, { provider = 'provider', body = '', retryAfter = null } = {}) {
  // Redact here, not only at the call sites: this is the single choke point for
  // "an upstream body becomes a message", and an upstream body can quote the
  // request that carried the key.
  const clipped = redactText(String(body ?? '')).replace(/\s+/g, ' ').slice(0, 200);
  const suffix = clipped ? ` — upstream said: ${clipped}` : '';
  if (status === 400 || status === 422) {
    return mediaError(Code.BAD_INPUT, `${provider} rejected the request parameters (HTTP ${status})${suffix}`);
  }
  if (status === 401) {
    return mediaError(Code.AUTH_FAILED, `${provider} rejected the credential (HTTP 401). Save the API key again in 媒体能力 setting.${suffix}`);
  }
  if (status === 402) {
    return mediaError(Code.ENTITLEMENT, `${provider} says the account has no active entitlement for this model (HTTP 402).${suffix}`);
  }
  if (status === 403) {
    return mediaError(Code.AUTH_FAILED, `${provider} refused access to this model or project (HTTP 403).${suffix}`);
  }
  if (status === 404) {
    return mediaError(Code.BAD_INPUT, `${provider} has no such endpoint (HTTP 404). Check the Base URL — this plugin appends the API path itself.${suffix}`);
  }
  if (status === 409) {
    return mediaError(Code.BACKEND_BUSY, `${provider} is busy (HTTP 409): the service accepts one request at a time.${suffix}`);
  }
  if (status === 429) {
    const wait = retryAfter ? ` Retry-After: ${retryAfter}.` : '';
    return mediaError(Code.RATE_LIMITED, `${provider} rate-limited the request (HTTP 429).${wait} This plugin does not auto-retry billable generation.${suffix}`);
  }
  if (status === 410) {
    return mediaError(Code.PROVIDER_NOT_IMPLEMENTED, `${provider} retired this endpoint (HTTP 410).${suffix}`);
  }
  if (status >= 500) {
    return mediaError(Code.UPSTREAM, `${provider} failed on its side (HTTP ${status}).${suffix}`);
  }
  return mediaError(Code.UPSTREAM, `${provider} returned HTTP ${status}.${suffix}`);
}

/** Wrap a thrown fetch failure into a network/timeout code with a usable hint. */
export function mapNetworkError(error, { provider = 'provider', timeoutMs = null } = {}) {
  if (error instanceof MediaError) return error;
  if (error?.name === 'AbortError') {
    return mediaError(Code.TIMEOUT, `${provider} did not answer within ${timeoutMs ?? '?'} ms.`);
  }
  const message = String(error?.message ?? error);
  if (/timed? ?out|aborted/i.test(message)) {
    return mediaError(Code.TIMEOUT, `${provider} did not answer within ${timeoutMs ?? '?'} ms.`);
  }
  if (/fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|EAI_AGAIN|other side closed|socket hang up/i.test(message)) {
    return mediaError(
      Code.NETWORK,
      `${provider} is unreachable (${message.slice(0, 120)}). Check that the service is running and the Base URL is right.`,
    );
  }
  return mediaError(Code.NETWORK, `${provider} request failed: ${message.slice(0, 160)}`);
}
