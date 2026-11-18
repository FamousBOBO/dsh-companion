// Cross-plugin-row publishing for channel-vocechat.
//
// This plugin is a **sibling** cordis row to `companion-foundation` and to the companion services.
// Cordis scopes a provided service to the providing plugin's subtree, so `ctx.get('companionVoceChat')`
// answers `undefined` from a sibling. The 2026-11-04 health incident is exactly this: the service ran
// perfectly and every consumer saw nothing.
//
// So publishing uses the same three paths `companion-foundation/port-publish.mjs` established, and
// **this file is a local copy on purpose**: this plugin must not import from `companion-foundation`,
// because that would make the transport depend on the adaptation layer — the one dependency the
// split design exists to forbid. The copy is small (≈90 lines), has no logic of its own, and the
// shape is pinned by the contract below, so drift is detectable rather than silent.
//
// The value shape is `{ service, ready() }` — identical to what `dsh-channel-qq` probes, and what
// `resolveCompanionService` expects.
//
// Two things the original learned the hard way and are preserved verbatim:
//
//   1. **`process` is the channel that must work.** Module identity differs between plugin rows
//      (different specifier spellings, junctions, preset realms); `process` cannot.
//   2. **The bare data-root key is contested.** `companion-health` publishes there too. We write a
//      namespaced key unconditionally and take the bare key only when it is free.

export const COMPANION_PORTS_SYMBOL = Symbol.for('dsh.companion.ports.v1');

/** The published name. Adding it to `service-bridge.mjs`'s allow-list is a separate, one-line change. */
export const PORT_NAME = 'companionVoceChat';

function portRegistry() {
  const holder = process;
  if (!holder[COMPANION_PORTS_SYMBOL] || !(holder[COMPANION_PORTS_SYMBOL] instanceof Map)) {
    holder[COMPANION_PORTS_SYMBOL] = new Map();
  }
  return holder[COMPANION_PORTS_SYMBOL];
}

function usableEntry(entry) {
  try { return typeof entry.ready === 'function' ? entry.ready() !== false : true; } catch { return false; }
}

/** Spelling variants of one root, so a junction or a trailing separator cannot split one deployment. */
function keyVariants(root) {
  const raw = String(root ?? '').trim();
  if (!raw) return [];
  const variants = new Set([raw]);
  const slashed = raw.replace(/\\/g, '/');
  variants.add(slashed);
  variants.add(slashed.replace(/\/+$/, ''));
  if (process.platform === 'win32') {
    for (const variant of [...variants]) variants.add(variant.toLowerCase());
  }
  variants.delete('');
  return [...variants];
}

/** The namespaced keys this service publishes and resolves under. */
export function registryKeysFor(root) {
  return keyVariants(root).map(variant => `${PORT_NAME}\u0000${variant}`);
}

/**
 * Publish the port.
 * @param {object} input
 * @param {string} input.root     suite data root (`.../data`), NOT `data/home`, NOT the suite root
 * @param {object} input.service  the object consumers receive
 * @param {() => boolean} [input.ready]
 * @param {(line: string) => void} [input.log]
 * @returns {() => void} idempotent release
 */
export function publishPort({ root, service, ready = () => true, log = null } = {}) {
  const say = message => {
    if (typeof log !== 'function') return;
    try { log(message); } catch { /* never break publishing */ }
  };
  if (!service) return () => {};
  const entry = { service, ready, name: PORT_NAME };
  let released = false;

  try {
    const registry = portRegistry();
    // Namespaced keys first: these can never be taken by another service.
    for (const key of registryKeysFor(root)) registry.set(key, entry);
    // Then the bare data-root key, only when it is free. Overwriting would break the sibling that
    // published first (in practice: companion-health).
    for (const key of keyVariants(root)) {
      const occupant = registry.get(key);
      if (occupant !== undefined && occupant !== entry) {
        say('[vocechat] bare data-root registry key already held by another service; namespaced key only');
        continue;
      }
      registry.set(key, entry);
    }
  } catch (error) {
    say(`[vocechat] process registry unavailable: ${String(error?.message ?? error).slice(0, 160)}`);
  }

  return () => {
    if (released) return;
    released = true;
    try {
      const registry = portRegistry();
      for (const key of [...registryKeysFor(root), ...keyVariants(root)]) {
        if (registry.get(key) === entry) registry.delete(key);
      }
    } catch { /* gone */ }
  };
}

/**
 * Resolve the port from the inside — used only by this plugin's own diagnostics and tests.
 * Consumers must use `resolveCompanionService` from their own side.
 */
export function resolvePort({ root, accept = null } = {}) {
  const accepted = value => {
    if (value === undefined || value === null) return false;
    if (typeof accept !== 'function') return true;
    try { return accept(value) === true; } catch { return false; }
  };
  try {
    const registry = portRegistry();
    for (const key of registryKeysFor(root)) {
      const entry = registry.get(key);
      if (!entry || !usableEntry(entry)) continue;
      if (accepted(entry.service)) return entry.service;
    }
    for (const key of keyVariants(root)) {
      const entry = registry.get(key);
      if (!entry || !usableEntry(entry)) continue;
      if (entry.name !== PORT_NAME && typeof accept !== 'function') continue;
      if (accepted(entry.service)) return entry.service;
    }
  } catch { /* absent */ }
  return null;
}

/** The key spellings a consumer on this machine will compute. Diagnostics only. */
export function describeKeys(root) {
  return { namespaced: registryKeysFor(root), bare: keyVariants(root) };
}
