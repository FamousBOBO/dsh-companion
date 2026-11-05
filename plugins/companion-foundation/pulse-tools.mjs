// `companion_pulse` — the model-facing door to the live heart-rate stream.
//
// Deliberately thin, mirroring `health-tools.mjs`: the health service owns the session state, the
// ring buffer and every derivation; this file only clamps an argument bag, forwards one call and
// scrubs the answer. Two guards live elsewhere and must not be duplicated here:
//
//   * **owner identity** — `index.mjs`'s `register()` wrapper calls `identity.resolve(sessionId)`
//     before `execute` runs, so a group chat or another person's QQ session throws there.
//   * **authorization** — `health.pulse.live` is decided by the service (`pulseGuard`), which
//     answers `{ok:false, code:'pulse-denied'}`. This file must never grow its own consent check:
//     two authorities is how one of them ends up stale.
//
// The one thing this file *does* own is the sentence the model reads when something is missing.
// Every `ok:false` is exactly `{ ok:false, code, message }` with a fixed Chinese message from the
// table below, so no exception text and no stack can reach a prompt.

import { stripPrivate } from './health-tools.mjs';

export const PULSE_TOOL_NAMES = Object.freeze(['companion_pulse']);

export const PULSE_ACTIONS = Object.freeze(['status', 'start', 'stop', 'mark', 'history']);

export const PULSE_LABEL_MAX = 40;
export const PULSE_MINUTES_MIN = 5;
export const PULSE_MINUTES_MAX = 120;

/**
 * The single audit point for every failure this tool can produce (`grep PULSE_FAILURES`).
 * Codes are the service's own, so the two layers cannot drift.
 */
export const PULSE_FAILURES = Object.freeze({
  'health-not-mounted': '健康模块尚未挂载。',
  'health-pulse-unavailable': '实时心率模块尚未就绪。',
  'pulse-denied': '主人尚未授权读取实时心率。',
  'pulse-disabled': '实时心率功能未启用（配置 pulse.enabled=false）。',
  'pulse-unreachable': '心率广播接收端未运行，拿不到读数。',
  'pulse-no-session': '当前没有正在进行的心跳会话。',
  'pulse-bad-action': `不支持的动作，可选：${PULSE_ACTIONS.join(' / ')}。`,
  'pulse-failed': '读取实时心率时出错。',
});

const failure = code => ({ ok: false, code, message: PULSE_FAILURES[code] ?? PULSE_FAILURES['pulse-failed'] });

const TOOL_DESCRIPTION = [
  'Read the owner\'s live heart rate from the local BLE heart-rate broadcast (the `ble-heart-rate`',
  'sidecar on loopback). Nothing scans or polls while idle — a session is what turns the radio on.',
  'Actions:',
  '`start` — make sure the band is connected (this is the only place a Bluetooth scan happens) and',
  'open a session. The session **follows the device**: no timer, it ends by itself about 30 s after',
  'the broadcast stops, so switching the band off removes the reading from the prompt with no call',
  'at all;',
  '`stop` — close the session now and release the BLE link (the band can stop broadcasting);',
  '`status` — current reading, this session\'s baseline, the zone (calm / warming / racing / peak),',
  'the last-minute trend, the session peak and whether the device is connected;',
  '`mark` — stamp the current moment with a short label so a peak can be recalled afterwards;',
  '`history` — past sessions with their peaks and marks.',
  'These are device readings, not a medical assessment: never present them as a diagnosis, and when',
  'the sidecar is not running or the device is disconnected the answer says so — do not claim to',
  'feel a heartbeat you were not given a number for. Nothing leaves this machine and no raw',
  'beat-to-beat series is stored.',
].join(' ');

/**
 * Register the pulse tool on the foundation's existing `register` helper (never re-implemented:
 * the owner-only `identity.resolve` wrapper and the tool `kind` plumbing stay in one place).
 */
export function registerPulseTools({ register, getService } = {}) {
  if (typeof register !== 'function') throw new TypeError('registerPulseTools requires the foundation register helper');
  const serviceOf = typeof getService === 'function' ? getService : () => null;

  const define = (name, description, parameters, execute, kind = 'read') => {
    register(name, description, parameters, execute, kind);
    return name;
  };

  const call = async run => {
    let service;
    try { service = serviceOf(); } catch { service = null; }
    if (!service) return failure('health-not-mounted');
    try {
      const value = await run(service);
      if (!value || typeof value !== 'object') return failure('pulse-failed');
      if (value.ok === false) {
        const code = String(value.code ?? '');
        // Re-word known codes with the fixed table; keep any extra diagnostic fields the service
        // attached (they are codes and counts, never a reading or an identifier).
        return { ...value, ...(PULSE_FAILURES[code] ? { code, message: PULSE_FAILURES[code] } : {}) };
      }
      return stripPrivate(value);
    } catch {
      return failure('pulse-failed');
    }
  };

  const registered = [];

  registered.push(define('companion_pulse', TOOL_DESCRIPTION, {
    action: { type: 'string', enum: [...PULSE_ACTIONS], required: true,
      description: 'status / start / stop / mark / history.' },
    minutes: { type: 'integer',
      description: `start 的会话时长，${PULSE_MINUTES_MIN}..${PULSE_MINUTES_MAX}，越界会被夹取；不给就用配置里的默认值。` },
    label: { type: 'string',
      description: `mark 的标签，最多 ${PULSE_LABEL_MAX} 字（例如“他说了那句话”）。` },
  }, args => call(async service => {
    const action = String(args?.action ?? '').trim().toLowerCase();
    if (!PULSE_ACTIONS.includes(action)) {
      // An unknown action is answered by name; `pulse-bad-action` also covers the service's own check.
      return failure('pulse-bad-action');
    }
    if (typeof service.pulseSession !== 'function') return failure('health-pulse-unavailable');
    if (action === 'history') {
      if (typeof service.pulseHistory !== 'function') return failure('health-pulse-unavailable');
      return service.pulseHistory({ limit: 5 });
    }
    const minutes = args?.minutes == null ? null : Number(args.minutes);
    const label = args?.label == null ? '' : String(args.label).slice(0, PULSE_LABEL_MAX);
    return service.pulseSession({
      action,
      minutes: Number.isFinite(minutes) ? Math.min(PULSE_MINUTES_MAX, Math.max(PULSE_MINUTES_MIN, Math.trunc(minutes))) : null,
      label,
    });
  })));

  return { registered: [...registered] };
}
