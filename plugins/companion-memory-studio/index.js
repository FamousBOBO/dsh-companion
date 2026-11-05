import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIdentity } from '../companion-foundation/identity.mjs?v=0.4.0';
import { createHostLlmAdapter } from '../companion-foundation/host-llm.mjs?v=0.4.0';
import { resolveSuitePaths } from '../companion-foundation/suite-paths.mjs';
import {
  createMemoryEngine,
  releaseSharedEngine,
  shareEngine,
  sharedEngineFor,
  VERSION as MEMORY_VERSION,
} from '../companion-memory/index.mjs?v=0.4.0';
import { registerStudioApi } from './server.mjs';

// Host half of the memory studio bundle. It owns the single memory engine of the
// process (registered in the engine module's process-local registry, so the
// companion preset reuses it instead of opening a second writer), exposes it as
// the `companionMemory` service, and mounts the authenticated management API the
// sidebar panel reads.

export const name = 'companion-memory-studio';
/**
 * The studio and the companion preset must agree on one root, otherwise the
 * engine registry hands out two SQLite writers. Both sides call
 * `resolveSuitePaths()` (D2), so the value never depends on where the source sits.
 */
const suitePaths = resolveSuitePaths({ moduleUrl: import.meta.url });
const packageRoot = suitePaths.dataRoot;
const logPath = path.join(packageRoot, 'logs/memory-studio.jsonl');

function appendJsonl(value) {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, JSON.stringify(value) + '\n', 'utf8');
  } catch { /* diagnostics never break activation */ }
}

function describeError(error) {
  return String(error?.message ?? error).slice(0, 300);
}

/**
 * The extraction adapter is shared by every consumer of this engine, so it is
 * built once and only when a summary model is actually needed. A missing model
 * degrades to `failure` instead of breaking activation.
 */
function createLazyExtractionLlm(ctx, getConfig) {
  let adapter = null;
  let failure = null;
  const ensure = async () => {
    if (adapter) return adapter;
    if (failure) return null;
    const extraction = getConfig()?.extraction ?? {};
    try {
      adapter = await createHostLlmAdapter(ctx, {
        provider: extraction.provider,
        model: extraction.model,
        reasoningEffort: extraction.reasoningEffort,
      });
    } catch (error) {
      failure = describeError(error);
      return null;
    }
    return adapter;
  };
  return {
    async complete(input) {
      const ready = await ensure();
      if (!ready) throw new Error(`总结模型不可用：${failure ?? 'host llm service missing'}`);
      return ready.complete({ ...input, sessionId: input?.sessionId });
    },
    describe() {
      return { provider: adapter?.provider ?? 'lazy', model: adapter?.model ?? 'lazy', failure };
    },
  };
}

/**
 * Mount the management API. `connection` is provided asynchronously by its own
 * row, so it can legitimately be missing while this plugin activates: the first
 * attempt handles "already available", and `ctx.inject` waits for the service in
 * compositions where it arrives later. A failure never keeps the companion from
 * booting.
 */
async function mountApi(ctx, service) {
  const attempt = async (target, how) => {
    const result = await registerStudioApi(target, service);
    if (result?.registered > 0) {
      appendJsonl({ at: new Date().toISOString(), event: 'api-registered', how, routes: result.registered });
      return result;
    }
    return result || { registered: 0, skipped: 'unknown' };
  };

  let first;
  try {
    first = await attempt(ctx, 'direct');
  } catch (error) {
    appendJsonl({ at: new Date().toISOString(), event: 'api-failed', how: 'direct', error: describeError(error) });
    first = { registered: 0, skipped: 'failed' };
  }
  if (first.registered > 0) return first;

  if (first.skipped === 'no-connection' && typeof ctx.inject === 'function') {
    ctx.inject(['connection'], injectedCtx => {
      attempt(injectedCtx, 'inject').catch(error => {
        appendJsonl({ at: new Date().toISOString(), event: 'api-failed', how: 'inject', error: describeError(error) });
      });
    });
  }
  return first;
}

export async function apply(ctx) {
  const mountedAt = new Date().toISOString();

  // A second activation (reload, or two sources for one package) must not open
  // another engine: reuse the one registered for this root and only re-mount the API.
  const registered = sharedEngineFor(packageRoot);
  if (registered) {
    const existingService = typeof ctx.get === 'function' ? ctx.get('companionMemory') : undefined;
    const service = existingService?.engine === registered
      ? existingService
      : { engine: registered, identity: existingService?.identity ?? null, root: packageRoot };
    if (typeof ctx.provide === 'function') {
      try { ctx.provide('companionMemory', service); } catch { /* already provided */ }
    }
    const api = await mountApi(ctx, service);
    appendJsonl({
      at: mountedAt,
      event: 'mounted',
      reused: true,
      routes: api?.registered ?? 0,
      apiSkipped: api?.skipped ?? null,
      backend: registered.backend,
    });
    return;
  }

  const identity = createIdentity(packageRoot, { personaId: suitePaths.personaId });
  const llm = createLazyExtractionLlm(ctx, () => engine?.config);
  const engine = createMemoryEngine({ root: packageRoot, identity, llm, personaId: suitePaths.personaId });
  shareEngine(packageRoot, engine);
  const status = await engine.initialize();
  const service = { engine, identity, root: packageRoot, version: MEMORY_VERSION };
  try {
    ctx.provide('companionMemory', service);
  } catch { /* the registry above already carries the sharing contract */ }
  ctx.effect(() => () => {
    // Only the creator of the engine closes it.
    releaseSharedEngine(packageRoot, engine);
    void engine.close().catch(() => {});
  }, 'companion-memory-studio: engine lifetime');

  const api = await mountApi(ctx, service);
  appendJsonl({
    at: mountedAt,
    event: 'mounted',
    reused: false,
    routes: api?.registered ?? 0,
    apiSkipped: api?.skipped ?? null,
    backend: status?.backend ?? engine.backend,
    extractionEnabled: Boolean(engine.config?.extraction?.enabled),
  });
}
