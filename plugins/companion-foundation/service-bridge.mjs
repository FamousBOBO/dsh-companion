import fs from 'node:fs';
import path from 'node:path';

// Explicit in-process ports across the preset/host isolation boundary. Never a sender.
// Canonical home paths prevent the C: junction and D: checkout from splitting one service.
//
// `companionHealth` joined 2026-11-04 for a concrete reason: a service published with
// `ctx.provide()` is scoped to the providing plugin's subtree in Cordis, and `companion-health`,
// `companion-foundation` and the Studio bundle are **sibling** rows — so `ctx.get('companionHealth')`
// answered `undefined` for both consumers and the whole health feature (tools, routes, the injected
// pulse line) was inert in production while the service itself ran fine. The bridge is the project's
// sanctioned way across that boundary; the name below is what makes it reachable.
const homes = new Map();
const names = new Set(['companionAgenda', 'companionContactShare', 'companionHealth']);
function keyOf(root) {
  const home = path.resolve(root, 'home');
  let canonical = home;
  try {
    canonical = fs.realpathSync.native(home);
  } catch {
    // The data directory may not exist yet (first mount, or a read-only probe from
    // a test): falling back to the literal path keeps one canonical spelling per
    // home instead of throwing and taking the whole plugin down.
  }
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}
export function createServiceBridge(root) {
  const key = keyOf(root);
  return {
    publish(name, value, { ready = () => true, priority = () => 0 } = {}) {
      if (!names.has(name) || !value) throw new Error('invalid-companion-port');
      const token = {};
      const services = homes.get(key) ?? new Map();
      homes.set(key, services);
      const providers = services.get(name) ?? new Map();
      services.set(name, providers);
      providers.set(token, { value, ready, priority });
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        providers.delete(token);
        if (!providers.size) services.delete(name);
        if (!services.size) homes.delete(key);
      };
    },
    resolve(name) {
      if (!names.has(name)) return null;
      const eligible = [...(homes.get(key)?.get(name)?.values() ?? [])].filter(p => {
        try { return p.ready() === true; } catch { return false; }
      });
      if (!eligible.length) return null;
      const rank = p => { try { return Number(p.priority()) || 0; } catch { return 0; } };
      const max = Math.max(...eligible.map(rank));
      const winners = eligible.filter(p => rank(p) === max);
      // Multiple equally eligible owners are ambiguous: refuse rather than pick a stale one.
      return winners.length === 1 ? winners[0].value : null;
    },
  };
}
