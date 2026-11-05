// One place that knows how to find the `companion-health` service from *another* plugin row.
//
// Why this file exists (2026-11-04): `ctx.provide('companionHealth', …)` is scoped to the providing
// plugin's subtree, and `companion-health`, `companion-foundation` and the Studio bundle are sibling
// rows in the same composition. Every consumer's `ctx.get('companionHealth')` therefore answered
// `undefined`, and three things were dead in production while the service itself ran perfectly:
// the `companion_health_*` tools, the Studio health routes, and the per-turn pulse line.
//
// Resolution order, cheapest and most certain first:
//   1. `ctx.get('companionHealth')` — correct when the consumer really is a child of the provider;
//   2. a registry stashed on **`process`** (not a module-level Map). Module identity can differ
//      between two plugin rows (different specifier spellings, a junction, a preset realm), but the
//      `process` object cannot: it is the process itself. This is the path that has to work;
//   3. the project's service bridge (module-level, canonical-home keyed) — kept because it is the
//      sanctioned channel for `companionAgenda`, and because it costs one map lookup.
//
// Both writers drop a small diagnostics file under `home/health/`, so "which process published and
// which process failed to find it" is answerable from disk instead of by guessing. No values, no
// identifiers: pid, timestamp, reason code.

import fs from 'node:fs';
import path from 'node:path';

import { createServiceBridge } from './service-bridge.mjs';

export const HEALTH_SERVICE_NAME = 'companionHealth';
export const HEALTH_PORT_SYMBOL = Symbol.for('dsh.companion.ports.v1');

const MISS_LOG_MIN_INTERVAL_MS = 60_000;

/** The process-wide registry. A symbol key keeps it out of everyone else's namespace. */
function portRegistry() {
  const holder = process;
  if (!holder[HEALTH_PORT_SYMBOL] || typeof holder[HEALTH_PORT_SYMBOL] !== 'object') {
    holder[HEALTH_PORT_SYMBOL] = new Map();
  }
  return holder[HEALTH_PORT_SYMBOL];
}

function diagPath(root, name) {
  return path.join(String(root ?? ''), 'home', 'health', name);
}

function writeDiag(root, name, payload) {
  try {
    const file = diagPath(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...payload, pid: process.pid, at: new Date().toISOString() }, null, 2));
  } catch { /* diagnostics must never break a mount */ }
}

/** Publish the service for sibling plugins. Returns a release function (idempotent). */
export function publishHealthService(root, service, { ready = () => true } = {}) {
  if (!service) return () => {};
  const key = String(root ?? '');
  let released = false;
  try {
    portRegistry().set(key, { service, ready });
  } catch { /* the bridge below is the fallback */ }
  let releaseBridge = () => {};
  try {
    releaseBridge = createServiceBridge(root).publish(HEALTH_SERVICE_NAME, service, { ready });
  } catch { /* not fatal: the process registry already holds it */ }
  writeDiag(root, 'bridge-publish.json', {
    step: 'publish', key, via: 'process-registry+bridge',
    registrySize: (() => { try { return portRegistry().size; } catch { return null; } })(),
  });
  return () => {
    if (released) return;
    released = true;
    try { portRegistry().delete(key); } catch { /* gone */ }
    try { releaseBridge(); } catch { /* gone */ }
  };
}

/** Resolve the service from a consumer's context. Never throws. */
export function resolveHealthService(ctx, root) {
  // 1. same-subtree context
  try {
    if (ctx && typeof ctx.get === 'function') {
      const local = ctx.get(HEALTH_SERVICE_NAME);
      if (local) return local;
    }
  } catch { /* fall through */ }

  const key = String(root ?? '');
  const reasons = [];
  // 2. process-wide registry
  try {
    const entry = portRegistry().get(key);
    if (entry) {
      let usable = false;
      try { usable = entry.ready() !== false; } catch { usable = false; }
      if (usable) return entry.service;
      reasons.push('registry-entry-not-ready');
    } else {
      reasons.push('registry-miss');
    }
  } catch { reasons.push('registry-threw'); }

  // 3. the sanctioned bridge
  try {
    const viaBridge = createServiceBridge(root).resolve(HEALTH_SERVICE_NAME);
    if (viaBridge) return viaBridge;
    reasons.push('bridge-miss');
  } catch { reasons.push('bridge-threw'); }

  maybeLogMiss(root, reasons);
  return null;
}

let lastMissAt = 0;
function maybeLogMiss(root, reasons) {
  const now = Date.now();
  if (now - lastMissAt < MISS_LOG_MIN_INTERVAL_MS) return;
  lastMissAt = now;
  writeDiag(root, 'bridge-miss.json', {
    step: 'resolve-miss',
    key: String(root ?? ''),
    reasons,
    registryKeys: (() => {
      try { return [...portRegistry().keys()]; } catch { return null; }
    })(),
  });
}
