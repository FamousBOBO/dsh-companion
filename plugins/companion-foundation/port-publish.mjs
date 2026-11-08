// Generic cross-plugin-row service publisher for the companion suite.
//
// Why this file exists (2026-11-08, P1): `group-persona.mjs` grew a three-path publisher
// (`ctx.provide` + process registry + service-bridge) tuned to one service, and the group-memory
// port needs exactly the same three paths with a different name. Copying that block a second time
// is how the health incident of 2026-11-04 happened in the first place: two publish paths that
// drifted, one of which silently answered nothing.
//
// What every publisher here must get right, learned from that incident and re-confirmed today:
//
//   1. **Sibling plugin rows cannot see `ctx.provide`.** Cordis scopes a provided service to the
//      providing plugin's subtree; `companion-foundation`, `companion-health`, `companion-group`
//      and the QQ channel are siblings. So `process` — which cannot be split by module identity —
//      is the channel that has to work.
//   2. **The bare data-root key is contested.** `companion-health` publishes under the bare data
//      root too, and the registry holds one entry per key: whichever plugin mounts last wins. A
//      publisher therefore writes a namespaced key (`<name>\u0000<root>`) unconditionally and only
//      takes the bare key when nobody else holds it.
//   3. **Never throw, never take the host down.** A missing host API is normal; it is reported, not
//      fatal.
//
// The value shape is `{ service, ready() }` — identical to `health-service-ref.mjs`, because the
// consumers (`dsh-channel-qq`) probe that exact shape.

import { createServiceBridge } from './service-bridge.mjs';

/** The registry key: one symbol for every companion port (same one health and persona use). */
export const COMPANION_PORTS_SYMBOL = Symbol.for('dsh.companion.ports.v1');

/** The process-wide registry (`Map<key, { service, ready }>`). Created on first use. */
function portRegistry() {
  const holder = process;
  if (!holder[COMPANION_PORTS_SYMBOL] || !(holder[COMPANION_PORTS_SYMBOL] instanceof Map)) {
    holder[COMPANION_PORTS_SYMBOL] = new Map();
  }
  return holder[COMPANION_PORTS_SYMBOL];
}

/** Spelling variants of one root, so a junction / trailing separator cannot split one deployment. */
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

/** Keys a consumer should try, most specific first (`companionGroupPersona` et al. read this). */
export function registryKeysFor(name, root) {
  return keyVariants(root).map(variant => `${name}\u0000${variant}`);
}

/**
 * Read a service published by a **sibling** plugin row.
 *
 * The order matters and is the whole point of this helper:
 *
 *   1. `ctx.get(name)` — the cordis way, but it only sees services provided inside the *same*
 *      plugin subtree, so for a sibling it is usually `undefined`;
 *   2. the namespaced registry key (`<name>\u0000<root>`) — always ours, never contested;
 *   3. the bare data-root key — **last**, because `companion-health` publishes there too and
 *      whichever plugin mounted later wins (verified 2026-11-08).
 *
 * Returns `null` when nothing usable is found; never throws. `entry.ready()` is honoured: a
 * service that reports itself unready is treated as absent rather than half-broken.
 *
 * @param {object} input
 * @param {string} input.name
 * @param {string} input.root
 * @param {() => unknown} [input.context] returns the plugin ctx (may itself return undefined)
 * @returns {unknown|null}
 */
export function resolveCompanionService({ name, root, context = null } = {}) {
  if (!name) return null;
  try {
    if (typeof context === 'function') {
      const ctx = context();
      if (ctx && typeof ctx.get === 'function') {
        const local = ctx.get(name);
        if (local !== undefined && local !== null) return local;
      }
    }
  } catch { /* keep going: the registry is the channel that has to work */ }
  try {
    const registry = portRegistry();
    for (const key of [...registryKeysFor(name, root), ...keyVariants(root)]) {
      const entry = registry.get(key);
      if (!entry) continue;
      let usable = true;
      try { usable = typeof entry.ready === 'function' ? entry.ready() !== false : true; } catch { usable = false; }
      if (!usable) continue;
      if (entry.service !== undefined && entry.service !== null) return entry.service;
    }
  } catch { /* absent */ }
  return null;
}

/**
 * Publish one service for sibling plugin rows.
 *
 * @param {object} options
 * @param {string} options.root    suite data root (NOT the suite root, NOT `data/home`)
 * @param {string} options.name    service name, e.g. `companionGroupMemory`
 * @param {object} options.service the value consumers receive
 * @param {() => boolean} [options.ready]
 * @param {(line: string) => void} [options.log]
 * @returns {() => void} idempotent release
 */
export function publishCompanionService({ root, name, service, ready = () => true, log = null } = {}) {
  const say = message => {
    if (typeof log !== 'function') return;
    try { log(message); } catch { /* logging must never break publishing */ }
  };
  if (!service || !name) return () => {};
  const releases = [];
  let released = false;
  try {
    const registry = portRegistry();
    const entry = { service, ready };
    // Namespaced keys first: these can never be taken from another service.
    for (const key of registryKeysFor(name, root)) registry.set(key, entry);
    // Then the bare data-root key, but only when it is free. Overwriting would silently break
    // whichever sibling published first (in practice: the health service).
    for (const key of keyVariants(root)) {
      const occupant = registry.get(key);
      if (occupant !== undefined && occupant !== entry) {
        say(`bare registry key already held by another service; publishing under the namespaced key only`);
        continue;
      }
      registry.set(key, entry);
    }
    releases.push(() => {
      const current = portRegistry();
      for (const key of [...registryKeysFor(name, root), ...keyVariants(root)]) {
        if (current.get(key) === entry) current.delete(key);
      }
    });
  } catch (error) {
    say(`process registry unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    releases.push(createServiceBridge(root).publish(name, service, { ready }));
  } catch (error) {
    say(`service bridge unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  return () => {
    if (released) return;
    released = true;
    for (const release of releases) {
      try { release(); } catch { /* release must be idempotent and silent */ }
    }
  };
}

export default { COMPANION_PORTS_SYMBOL, publishCompanionService, registryKeysFor };
