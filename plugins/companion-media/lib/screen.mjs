import fs from 'node:fs';
import path from 'node:path';
import { Code, mediaError, toFailure } from './errors.mjs';
import { resolveInside } from './ids.mjs';
import { sniffImage } from './media.mjs';

// Screen input.
//
// This module never captures the screen. It accepts an already-provided frame
// (a fixture during migration, a client-delivered frame in production), checks
// that it is fresh and belongs to the asking session, and only then hands it to
// the cloud route marked `source: 'screen'`. A stale or mismatched frame is
// refused instead of being described as if it were the live screen.
//
// Three frame origins exist and they are never mixed up:
//   fixture   `test/fixtures/screen` only, selected by `screen.mode = 'fixture'`
//   external  a caller passes bytes plus its own `capturedAt`
//   host-port a host injects `companionScreenFrame` and this layer asks it for a
//             frame; `screen.mode = 'live'` is required, and if the port is absent
//             the answer is `frame-source-unavailable`, never a fabricated frame.
// The audit line for every accepted/rejected frame is `event: 'screen.frame'`
// with no absolute path and no bytes — only origin, age, size and a sha256 prefix.

/** Stable reason strings a caller can branch on without parsing text. */
export const FRAME_SOURCE_UNAVAILABLE = 'frame-source-unavailable';
export const FRAME_SOURCE_FAILED = 'frame-source-failed';
export const FRAME_SOURCE_EMPTY = 'frame-source-empty';
export const MODE_FIXTURE = 'fixture';
export const MODE_LIVE = 'live';

/**
 * Name of the host-published frame port. The host (desktop / channel / any
 * supervisor that is allowed to hold a screen-capture capability) publishes
 *
 *   ctx.provide('companionScreenFrame', {
 *     name: 'host-screen-capture',
 *     available(): boolean,
 *     async capture({ sessionId, maxAgeSeconds, signal }) {
 *       return { bytes, capturedAt, sessionId?, mime? };   // nothing else is accepted
 *     },
 *   })
 *
 * This media layer only reads that port. It never opens a screen, never spawns a
 * capture helper and never writes a frame it did not receive.
 */
export const FRAME_PORT_NAME = 'companionScreenFrame';

export function evaluateFrame({ capturedAt, frameSessionId, expectedSessionId, maxAgeSeconds = 60, now = Date.now() } = {}) {
  if (!capturedAt) return { usable: false, code: Code.STALE_FRAME, reason: 'frame has no capture time' };
  const at = new Date(capturedAt).getTime();
  if (!Number.isFinite(at)) return { usable: false, code: Code.STALE_FRAME, reason: 'frame capture time is not a date' };
  const age = (now - at) / 1000;
  if (age < -5) return { usable: false, code: Code.STALE_FRAME, reason: 'frame timestamp is in the future' };
  if (age > maxAgeSeconds) return { usable: false, code: Code.STALE_FRAME, reason: `frame is ${Math.round(age)}s old; limit is ${maxAgeSeconds}s` };
  if (expectedSessionId && frameSessionId && frameSessionId !== expectedSessionId) {
    return { usable: false, code: Code.SESSION_MISMATCH, reason: 'frame belongs to another session' };
  }
  return { usable: true, ageSeconds: Math.max(0, Math.round(age)) };
}

/** Read a fixture from inside the plugin's own fixture directory only. */
export function readScreenFixture(root, relative, { maxBytes = 12 * 1024 * 1024 } = {}) {
  const absolute = resolveInside(path.join(root, 'test/fixtures/screen'), relative);
  const stat = fs.statSync(absolute);
  if (stat.size > maxBytes) throw mediaError(Code.TOO_LARGE, `fixture is ${stat.size} bytes`);
  const bytes = fs.readFileSync(absolute);
  const sniffed = sniffImage(bytes);
  if (!sniffed) throw mediaError(Code.UNSUPPORTED_TYPE, 'screen fixture is not a supported image');
  return { bytes, ...sniffed, path: absolute };
}

/**
 * Resolve an injected frame source. Accepts the port itself or a getter, because
 * `ctx.get('companionScreenFrame')` may only answer after the host published it.
 * A missing/invalid port is `null` — never a placeholder object that pretends to
 * be able to capture.
 */
export function resolveFrameSource(candidate) {
  let port = candidate;
  if (typeof port === 'function') {
    try { port = port(); } catch { port = null; }
  }
  return port && typeof port.capture === 'function' ? port : null;
}

/** What the frame port can do right now, in a shape diagnostics can print. */
export function frameSourceState(candidate) {
  const port = resolveFrameSource(candidate);
  if (!port) return { present: false, available: false, name: null, reason: FRAME_SOURCE_UNAVAILABLE };
  let available = true;
  if (typeof port.available === 'function') {
    try { available = port.available() !== false; } catch { available = false; }
  }
  return { present: true, available, name: port.name ?? FRAME_PORT_NAME, reason: available ? '' : FRAME_SOURCE_UNAVAILABLE };
}

/** One definition of "what this build can do with the screen", used by status and tools. */
export function describeScreen(config, frameSource = null) {
  const mode = config.screen.mode;
  const port = frameSourceState(frameSource);
  return {
    enabled: Boolean(config.screen.enabled),
    mode,
    capturesScreen: false,
    backgroundCapture: false,
    maxAgeSeconds: config.screen.maxAgeSeconds,
    frameSource: port,
    // Which origin is accepted right now, stated instead of inferred.
    accepts: config.screen.enabled
      ? (mode === MODE_LIVE ? (port.available ? 'host-frame' : 'none') : 'fixture')
      : 'none',
    route: { provider: config.screen.cloud.provider, model: config.screen.cloud.model },
    egress: {
      when: 'on every accepted frame',
      what: 'the whole frame, base64-encoded inside the image content block',
      to: `${config.screen.cloud.provider}/${config.screen.cloud.model}`,
      // Stated so nobody edits the wrong key: the frame travels on the vision cloud
      // route (`config.vision.cloud`); `screen.cloud` is descriptive. The mounted
      // status overrides `to` with the effective route and flags a mismatch.
      routeKey: 'vision.cloud (screen.cloud is descriptive only)',
      leavesMachine: true,
      off: 'set screen.enabled=false (next call already refuses; no restart needed)',
    },
  };
}

export function createScreenService({ config, vision, root, log = () => {}, now = () => Date.now(), frameSource = null } = {}) {
  const audit = entry => {
    try { log({ event: 'screen.frame', ...entry }); } catch { /* diagnostics never break a turn */ }
  };
  const refused = (code, message, reason) => ({ ok: false, error: { code, message, ...(reason ? { reason } : {}) } });

  async function inspect({ frame, sessionId, expectedSessionId, prompt, origin = 'external', signal } = {}) {
    if (!config.screen.enabled) return refused(Code.DISABLED, 'screen input is disabled');
    if (!frame?.bytes?.length) return refused(Code.BAD_INPUT, 'a screen frame is required');
    const verdict = evaluateFrame({
      capturedAt: frame.capturedAt,
      frameSessionId: frame.sessionId,
      expectedSessionId: expectedSessionId ?? sessionId,
      maxAgeSeconds: config.screen.maxAgeSeconds,
      now: now(),
    });
    if (!verdict.usable) {
      log({ event: 'screen.rejected', code: verdict.code, origin });
      return refused(verdict.code, verdict.reason);
    }
    audit({
      origin,
      accepted: true,
      sessionMatched: Boolean(expectedSessionId ?? sessionId),
      capturedAt: new Date(new Date(frame.capturedAt).getTime()).toISOString(),
      ageSeconds: verdict.ageSeconds,
      bytes: frame.bytes.length,
      mime: frame.mime ?? '',
      sha256: String(frame.sha256 ?? '').slice(0, 16),
    });
    try {
      const result = await vision.inspect({
        media: {
          mediaId: `screen:${frame.capturedAt}`,
          sessionId,
          kind: 'screen',
          // The vision layer refuses `kind: 'screen'` unless the source is exactly
          // 'screen'. A fixture is still a screen frame; its origin is carried by
          // `origin`, not by bending the source field (that combination used to
          // make every screen inspection fail with MEDIA_BAD_INPUT).
          source: 'screen',
          origin,
          mime: frame.mime,
          format: frame.format,
          sha256: frame.sha256 ?? '',
          capturedAt: frame.capturedAt,
          owner: frame.owner,
        },
        bytes: frame.bytes,
        prompt: prompt ?? config.screen.prompt,
        signal,
      });
      return { ...result, frameAgeSeconds: verdict.ageSeconds, frameOrigin: origin };
    } catch (error) {
      return { ok: false, error: toFailure(error) };
    }
  }

  /**
   * Ask the host for a frame and inspect it. Absent port (or a mode that does not
   * allow live frames) is answered with `MEDIA_DISABLED` + an explicit reason; this
   * is the only honest answer when this layer cannot capture anything itself.
   *
   * `accept(frame)` is the caller's normalization hook (size/type limits, owner,
   * managed copy). It runs after acquisition and before inspection, so a frame
   * that fails the media limits is refused instead of being described.
   */
  async function capture({ sessionId, expectedSessionId, prompt, signal, accept } = {}) {
    if (!config.screen.enabled) return refused(Code.DISABLED, 'screen input is disabled');
    if (config.screen.mode !== MODE_LIVE) {
      return refused(Code.DISABLED, `screen.mode is '${config.screen.mode}'; set it to '${MODE_LIVE}' to accept host-delivered frames`, 'mode-fixture-only');
    }
    const port = resolveFrameSource(frameSource);
    if (!port) {
      log({ event: 'screen.rejected', code: Code.DISABLED, reason: FRAME_SOURCE_UNAVAILABLE });
      return refused(
        Code.DISABLED,
        `no screen frame source is wired (this layer never captures the screen; expected a host port named ${FRAME_PORT_NAME})`,
        FRAME_SOURCE_UNAVAILABLE,
      );
    }
    if (typeof port.available === 'function') {
      let available = true;
      try { available = port.available() !== false; } catch { available = false; }
      if (!available) {
        log({ event: 'screen.rejected', code: Code.DISABLED, reason: FRAME_SOURCE_UNAVAILABLE, port: port.name ?? FRAME_PORT_NAME });
        return refused(Code.DISABLED, 'the host frame source reports itself unavailable', FRAME_SOURCE_UNAVAILABLE);
      }
    }
    let frame;
    try {
      frame = await port.capture({ sessionId, maxAgeSeconds: config.screen.maxAgeSeconds, signal });
    } catch (error) {
      const failure = toFailure(error);
      log({ event: 'screen.rejected', code: failure.code, reason: FRAME_SOURCE_FAILED });
      return { ok: false, error: { ...failure, reason: FRAME_SOURCE_FAILED } };
    }
    if (!frame || !frame.bytes?.length) {
      log({ event: 'screen.rejected', code: Code.BAD_INPUT, reason: FRAME_SOURCE_EMPTY });
      return refused(Code.BAD_INPUT, 'the host frame source returned no frame', FRAME_SOURCE_EMPTY);
    }
    if (typeof accept === 'function') {
      try {
        frame = await accept(frame);
      } catch (error) {
        const failure = toFailure(error);
        log({ event: 'screen.rejected', code: failure.code, reason: 'frame-rejected-by-media-limits' });
        return { ok: false, error: failure };
      }
      if (!frame?.bytes?.length) {
        log({ event: 'screen.rejected', code: Code.BAD_INPUT, reason: FRAME_SOURCE_EMPTY });
        return refused(Code.BAD_INPUT, 'the host frame source returned no frame', FRAME_SOURCE_EMPTY);
      }
    }
    return inspect({ frame, sessionId, expectedSessionId: expectedSessionId ?? sessionId, prompt, origin: 'host-port', signal });
  }

  return {
    inspect,
    capture,
    evaluate: evaluateFrame,
    describe: () => describeScreen(config, frameSource),
    frameSource: () => frameSourceState(frameSource),
    readFixture: (relative, options) => readScreenFixture(root ?? config.screen.fixtureRoot ?? '.', relative, options),
  };
}

/** Describe what this build can and cannot do with the screen, for diagnostics. */
export function screenCapabilities(config, { frameSource = null } = {}) {
  return describeScreen(config, frameSource);
}
