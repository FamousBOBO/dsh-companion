import { createHealthService, PLUGIN_ROOT, WORKSPACE_ROOT, VERSION } from './lib/service.mjs';
import { publishHealthService } from '../companion-foundation/health-service-ref.mjs';

// Cordis plugin entry for companion-health.
//
// Mounting rules, in order of importance:
//   1. **A failure here may never take the host down.** Everything below is guarded; a plugin that
//      cannot find its database still mounts, still publishes a service, and explains itself.
//   2. **No service is required.** This composition may contain nothing else at all
//      (`inject: []`), so there is no dependency ordering to get wrong.
//   3. The service is published *before* it is initialised, so a consumer that arrives during
//      activation sees the object (and a typed "not initialised yet" answer) instead of `undefined`.
//   4. Polling starts only after a successful initialisation, and only when `config.enabled` is on.
//   5. **Re-activation is safe.** The host re-runs `apply()` on reload, so exactly one service
//      instance (one SQLite handle, one interval) exists per process: a second activation reuses
//      the singleton and only re-publishes it.
//
// The service is published as `companionHealth` via `ctx.provide` — **not** through
// `companion-foundation/service-bridge.mjs`, whose allow-list is `companionAgenda` /
// `companionContactShare`. `companion-foundation/health-tools.mjs` resolves it with
// `ctx.get('companionHealth')`, so a refused/failed `provide` is exactly the reason those tools
// would answer `health-not-mounted`; that is why the failure branch below always logs a reason.

export const name = 'companion-health';
export const inject = [];
export const version = VERSION;

/** Process-local singleton: one instance, one writer, one timer. */
let singleton = null;
/** Epoch of the activation that owns the lifecycle (the only one allowed to dispose it). */
let ownerEpoch = 0;
let epoch = 0;

/** No network, no filesystem: just a prefixed line. Never contains payload or credentials. */
function note(text) {
  try { console.log(`[companion-health] ${String(text).slice(0, 400)}`); } catch { /* ignore */ }
}

function phaseOf(service) {
  try { return String(service?.describe?.()?.phase ?? 'unknown'); } catch { return 'unknown'; }
}

/**
 * 三通道状态的一行摘要（采集 / 账号 / 心率）。**永远不抛**，读不到就给空串：
 * 它只是日志，不该成为挂载路径上的新风险。
 */
function readinessLine(service) {
  try { return String(service?.readiness?.()?.summary ?? ''); } catch { return ''; }
}

export async function apply(ctx) {
  epoch += 1;
  const mine = epoch;
  ownerEpoch = mine;

  let service = singleton;
  let reused = false;
  if (service && phaseOf(service) !== 'closed') {
    reused = true;
    note('re-activation: reusing the existing service instance (no second database handle, no second timer)');
  } else {
    try {
      service = createHealthService({ root: WORKSPACE_ROOT });
      singleton = service;
    } catch (error) {
      note(`create service failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  // Publish first: a consumer mounted after us can hold the reference even while we are still
  // opening the database.
  //
  // `ctx.provide` alone is **not enough**: in Cordis a provided service is scoped to the providing
  // row's subtree, and the consumers (`companion-foundation`, the Studio bundle) are siblings. That
  // is why the tools and routes answered `health-not-mounted` in production while this service ran.
  // The process-wide bridge is the project's channel across that boundary (see
  // `agent-presets-and-service-bridge` in CONTRACT.md §17.8 and `health-service-ref.mjs`).
  let releaseBridge = () => {};
  try {
    if (typeof ctx?.provide === 'function') {
      ctx.provide('companionHealth', service);
    } else {
      // Loud on purpose: without `provide` a same-subtree consumer can never see the service.
      note("ctx.provide is not available in this composition; 'companionHealth' was NOT published to this ctx");
    }
  } catch (error) {
    note(`provide('companionHealth') failed: ${error instanceof Error ? error.message : String(error)} — `
      + 'sibling plugins will fall back to the service bridge');
  }
  try {
    releaseBridge = publishHealthService(WORKSPACE_ROOT, service, { ready: () => phaseOf(service) !== 'closed' });
    note('published companionHealth to the service bridge (sibling plugins can resolve it)');
  } catch (error) {
    note(`service bridge publish failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Lifetime: Cordis calls the disposer when the row is unloaded. `close()` stops the timer, waits
  // for an in-flight sync and closes the database — never rejects (awaited defensively).
  try {
    if (typeof ctx?.effect === 'function') {
      ctx.effect(() => () => {
        // Only the activation that currently owns the singleton may tear it down; a disposer from a
        // superseded activation must not close the instance the new one is using.
        if (ownerEpoch !== mine) return;
        try { releaseBridge(); } catch { /* already released */ }
        Promise.resolve()
          .then(() => service.close())
          .catch(error => note(`close failed: ${error instanceof Error ? error.message : String(error)}`));
      }, 'companion-health: service lifetime');
    }
  } catch (error) {
    note(`ctx.effect registration failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  let init = null;
  try {
    init = await service.initialize();
  } catch (error) {
    note(`initialize threw: ${error instanceof Error ? error.message : String(error)}`);
    init = { ok: false, code: 'health-db-unavailable', reason: 'initialize-threw' };
  }
  if (init?.ok !== true) {
    // One line, no stack, no payload: the plugin is mounted but unusable, and that is a fact the
    // operator has to be able to read in the host log without a console flooded by retries.
    note(`not ready: ${init?.reason ?? init?.code ?? 'unknown'} — ${init?.message ?? '健康服务未就绪'}`);
    note(`readiness: ${readinessLine(service)}`);
    return;
  }
  if (!init.already) {
    for (const warning of init.warnings ?? []) note(`config: ${warning}`);
  }

  // Start polling. Both `initialize()` and `start()` are idempotent, so a re-activation lands on the
  // `already` branches instead of opening a second interval.
  try {
    const started = await service.start();
    if (started?.ok === true) {
      if (started.already !== true) {
        note(`ready (db ${service.dbPath}); polling every ${Math.round(Number(started.intervalMs) / 60000)} min`);
      }
    } else {
      note(`not polling: ${started?.code ?? 'unknown'} — ${started?.message ?? ''}`);
    }
  } catch (error) {
    note(`start failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (reused) note('reused service is ready');
  // Cordis treats apply() return values as disposers; the bridge already exposes the service.
}

export { createHealthService, PLUGIN_ROOT, WORKSPACE_ROOT };
