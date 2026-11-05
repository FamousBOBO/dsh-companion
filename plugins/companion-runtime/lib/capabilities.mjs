// P2 capability catalogue (contract logs/p2-autonomous-day/contract-p2.md section 6).
//
// One place that answers "what can the character actually do right now", for the planner
// prompt, for diagnostics and for the life view. It never claims a capability is available
// because a file exists: availability is decided by the injected ports and the switches.
// Missing capabilities are reported with a reason instead of being silently dropped, and
// they never block the three base adapters (read / explore / write).

export const CAPABILITY_IDS = Object.freeze(['read', 'explore', 'write', 'bilibili', 'image', 'media', 'mc']);

const REASONS = Object.freeze({
  PORT_NOT_MOUNTED: 'port-not-mounted',
  CONFIG_OFF: 'config-off',
  NOT_IMPLEMENTED: 'not-implemented',
  DISABLED_BY_MODE: 'disabled-by-mode',
});

function entry({ available, port = null, reason = '', detail = '' }) {
  return Object.freeze({ available: available === true, port: port ?? null, reason: available === true ? '' : reason, detail });
}

/**
 * Detect the capability catalogue for one scope.
 *
 * @param ports   injected ports: `{fetchPage, readFile, writeFile, image?, media?, mc?}`
 * @param config  the runtime config (`config.p2.*`)
 * @param mode    runtime mode (`off|shadow|active`)
 * @param kinds   optional per-kind enable flags resolved by the caller
 */
export function detectCapabilities({ ports = {}, config = {}, mode = 'active', kinds = {} } = {}) {
  const p2 = config.p2 ?? {};
  const activitiesOn = p2.activities?.enabled === true && mode === 'active';
  const offReason = p2.activities?.enabled !== true ? REASONS.CONFIG_OFF : REASONS.DISABLED_BY_MODE;
  const base = (kind, portName) => {
    const port = ports?.[portName];
    if (typeof port !== 'function') return entry({ available: false, reason: REASONS.PORT_NOT_MOUNTED, detail: `${portName} port is not mounted` });
    if (kind === 'bilibili' && port.available?.() === false) return entry({ available: false, reason: 'provider-not-ready' });
    if (!activitiesOn) return entry({ available: false, reason: offReason, detail: 'p2.activities.enabled is off or the runtime is not active' });
    if (kinds?.[kind] === false) return entry({ available: false, reason: REASONS.CONFIG_OFF, detail: `${kind} is disabled for this scope` });
    return entry({ available: true, port: portName });
  };

  const allowlist = Array.isArray(p2.autonomy?.allowedSources) ? p2.autonomy.allowedSources.filter(Boolean) : [];
  const exploreEntry = allowlist.length === 0
    ? entry({ available: false, reason: 'source-allowlist-empty', detail: 'p2.autonomy.allowedSources is empty, so no public page may be opened' })
    : base('explore', 'fetchPage');
  return {
    read: base('read', 'readFile'),
    explore: exploreEntry,
    write: base('write', 'writeFile'),
    bilibili: base('bilibili', 'runBilibili'),
    // Extension capabilities are reported but do not gate the base three.
    image: ports?.image
      ? entry({ available: true, port: 'image' })
      : entry({ available: false, reason: REASONS.NOT_IMPLEMENTED, detail: 'no image generation port was mounted for P2' }),
    media: ports?.media
      ? entry({ available: true, port: 'media' })
      : entry({ available: false, reason: REASONS.NOT_IMPLEMENTED, detail: 'no media tool port was mounted for P2' }),
    mc: ports?.mc
      ? entry({ available: true, port: 'mc' })
      : entry({ available: false, reason: REASONS.NOT_IMPLEMENTED, detail: 'mc-companion controller adapter is not implemented in this round' }),
  };
}

/** A short human/planner-readable summary: only what is really usable now. */
export function describeCapabilities(catalogue) {
  const available = [];
  const missing = [];
  for (const id of CAPABILITY_IDS) {
    const item = catalogue?.[id];
    if (item?.available) available.push(id);
    else missing.push(`${id}(${item?.reason ?? 'unknown'})`);
  }
  return { available, missing, text: `available: ${available.join(', ') || 'none'}; unavailable: ${missing.join(', ') || 'none'}` };
}

export const CAPABILITY_REASONS = REASONS;
