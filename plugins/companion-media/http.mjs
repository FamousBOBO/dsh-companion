/**
 * Media management API — mounted at the TOP LEVEL on purpose.
 *
 * Why a separate mount: the media plugin itself lives inside the agent preset, and preset plugins
 * get an isolate realm. Their `connection` service is a private instance, so routes registered
 * from inside the preset report success and still 404 on the web server. Measured on a real host:
 * `http-api-registered registered: 9 how: "awaited"` in the plugin's own event log, while
 * `GET /api/companion-media/page` answered `404 not found`.
 *
 * Module-level state cannot bridge the realm boundary either (`sharedMediaFor()` returns null
 * here), so this mount builds the same service over the same on-disk config. That stays a single
 * source of truth because the config store reads the file on every access — no cached copy exists
 * to drift — and the schema, validation and provider logic are the same code, not a second
 * implementation. Saving from the settings page is therefore visible to the preset's tools on
 * their next call.
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createMediaService } from './src/service.mjs';
import { createMediaHost } from './src/host-llm.mjs';
import { resolveDataDir } from './src/persona.mjs';
import { registerMediaApi } from './src/http-api.mjs';

export const name = 'companion-media-http';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const SUITE_ROOT = path.resolve(PLUGIN_ROOT, '..', '..');

function serviceFor(ctx) {
  const dataRoot = resolveDataDir({ env: process.env, suiteRoot: SUITE_ROOT });
  const dir = dataRoot?.dir || path.join(SUITE_ROOT, 'data');
  const logDir = path.join(dir, 'media', 'logs');
  const log = (record) => {
    try {
      fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(path.join(logDir, 'media-events.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n');
    } catch {
      /* logging must never take the plugin down */
    }
  };
  return { service: createMediaService({ dataDir: dir, suiteRoot: SUITE_ROOT, env: process.env, log, host: createMediaHost(ctx) }), dataDir: dir, log };
}

export async function apply(ctx) {
  let built;
  try {
    built = serviceFor(ctx);
  } catch (error) {
    // Report it instead of throwing: a broken data root must not stop the whole app from booting.
    console.log(`[companion-media-http] could not build the media service: ${error?.message ?? error}`);
    return { registered: 0, skipped: 'service-failed' };
  }
  const { service, log } = built;
  // Wait for `connection`: at bundle-mount time the service is often not provided yet, and a single
  // attempt would report `no-connection` and leave every route missing. Bounded, inside apply, so
  // the context stays active — registering on an inactive context is rejected by the host.
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    const connection = typeof ctx?.get === 'function' ? ctx.get('connection') : undefined;
    if (connection) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  // `effect: false` on purpose: `ctx.effect` rejects this mount's context with "Invalid effect"
  // (the same shape works for the studio's bundle plugin, but not for a patch-inserted one), and a
  // registration that never happens is far worse than one that is not tied to the fiber's
  // disposal. The host keeps the routes for the process lifetime, which is what the page needs.
  const result = await registerMediaApi(ctx, service, { effect: false });
  service.noteHttpState({
    registered: result.registered ?? 0,
    skipped: result.skipped ?? null,
    how: 'top-level',
    paths: result.paths ?? [],
    failed: result.failed ?? [],
    lastError: result.error ?? null,
  });
  log({
    event: result.registered > 0 ? 'http-api-registered' : 'http-api-unavailable',
    how: 'top-level',
    registered: result.registered ?? 0,
    paths: result.paths ?? [],
    failed: result.failed ?? [],
    note: result.registered > 0 ? `顶层已注册 ${result.registered} 条路由` : '顶层未注册任何路由',
  });
  // Return nothing: Cordis treats a plugin's apply return value as an effect to collect, and a
  // plain object like {registered, paths} makes it throw "Invalid effect" and drop the whole
  // plugin — which is why the routes were missing while this file looked correct.
  return undefined;
}

export default { name, apply };
