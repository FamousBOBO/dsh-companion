/** Stable error codes shared by every media capability. */
export const Code = Object.freeze({
  DISABLED: 'MEDIA_DISABLED',
  BAD_INPUT: 'MEDIA_BAD_INPUT',
  UNSUPPORTED_TYPE: 'MEDIA_UNSUPPORTED_TYPE',
  TOO_LARGE: 'MEDIA_TOO_LARGE',
  TOO_MANY_IMAGES: 'MEDIA_TOO_MANY_IMAGES',
  PATH_ESCAPE: 'MEDIA_PATH_ESCAPE',
  DOWNLOAD_BLOCKED: 'MEDIA_DOWNLOAD_BLOCKED',
  DOWNLOAD_FAILED: 'MEDIA_DOWNLOAD_FAILED',
  TIMEOUT: 'MEDIA_TIMEOUT',
  CANCELLED: 'MEDIA_CANCELLED',
  BACKEND_UNAVAILABLE: 'MEDIA_BACKEND_UNAVAILABLE',
  BACKEND_FAILED: 'MEDIA_BACKEND_FAILED',
  ATTACHMENTS_UNAVAILABLE: 'MEDIA_ATTACHMENTS_UNAVAILABLE',
  HOST_LLM_UNAVAILABLE: 'MEDIA_HOST_LLM_UNAVAILABLE',
  ROUTE_TEXT_ONLY: 'MEDIA_ROUTE_TEXT_ONLY',
  QUOTA_DENIED: 'MEDIA_QUOTA_DENIED',
  QUOTA_EXHAUSTED: 'MEDIA_QUOTA_EXHAUSTED',
  NOT_FOUND: 'MEDIA_NOT_FOUND',
  IDEMPOTENT_REPLAY: 'MEDIA_IDEMPOTENT_REPLAY',
  STALE_FRAME: 'MEDIA_STALE_FRAME',
  SESSION_MISMATCH: 'MEDIA_SESSION_MISMATCH',
  NO_TEXT: 'MEDIA_NO_TEXT',
  DIRECTOR_INVALID: 'MEDIA_DIRECTOR_INVALID',
  TEMPO_FAILED: 'MEDIA_TEMPO_FAILED',
  WAV_INVALID: 'MEDIA_WAV_INVALID',
  UNKNOWN_RESULT: 'MEDIA_UNKNOWN_RESULT',
  // The shared GPU coordinator is single-flight: one backend at a time.
  BACKEND_BUSY: 'MEDIA_BACKEND_BUSY',
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

/** Convert any thrown value into the `{ code, message }` shape the contract returns. */
export function toFailure(error, fallback = Code.BACKEND_FAILED) {
  if (error instanceof MediaError) return { code: error.code, message: error.message };
  if (error?.name === 'AbortError') return { code: Code.CANCELLED, message: 'request aborted' };
  const message = error instanceof Error ? error.message : String(error);
  return { code: error?.code && typeof error.code === 'string' ? error.code : fallback, message: message.slice(0, 500) };
}

/**
 * Turn a bare connection failure into something actionable.
 *
 * A dead 8139 coordinator used to surface as `MEDIA_BACKEND_FAILED: fetch failed`,
 * which reads like a model problem and hides the real cause (no process
 * listening). Anything that is not a connection problem returns null so callers
 * can keep their own error.
 */
export function unreachableBackend(error, { what, baseUrl }) {
  const message = String(error?.message ?? error ?? '');
  if (!/fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|other side closed/i.test(message)) return null;
  return mediaError(
    Code.BACKEND_UNAVAILABLE,
    `${what} unreachable at ${baseUrl} (${message.slice(0, 120)}); start runtime/gpu_model_gateway.py (port 8139) and retry`,
  );
}
