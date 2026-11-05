/**
 * Workspace-scoped context window.
 *
 * Some sessions run against the companion workspace and want a smaller context
 * window than the general chat workspace, so the companion can use a cheaper
 * route without changing any other session. The adapter below is a *metadata
 * alias*: it forwards endpoint, credentials, images and session headers to the
 * original provider and only rewrites the provider name and the window.
 *
 * Publication rules (see the release team brief):
 * - Nothing here is on by default. The plugin reads
 *   `<dataRoot>/home/companion/workspace-context.json`; without that file (or with
 *   `enabled: false`) it mounts as a no-op and registers no adapter and no route.
 * - The workspace it guards is the suite's own data workspace, resolved with
 *   `suite-paths.mjs`, never a path from the author's machine.
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveSuitePaths } from './suite-paths.mjs';

/** Provider this guard wraps. Overridable per install. */
export const SOURCE_PROVIDER = 'opencode-go';
/** Alias provider registered for the companion workspace. Purely local. */
export const COMPANION_PROVIDER = 'companion-window';
/** Window (tokens) the companion workspace is capped to. */
export const COMPANION_WINDOW = 262144;
/** Window the general workspace keeps when the source provider reports none. */
export const DEFAULT_WINDOW = 524288;

export const name = 'companion-workspace-context';
export const inject = ['llm'];

const CONFIG_RELATIVE = 'home/companion/workspace-context.json';

let cachedWorkspace = null;
/** The companion workspace directory (the suite's data workspace). */
export function companionWorkspace() {
  if (cachedWorkspace) return cachedWorkspace;
  cachedWorkspace = resolveSuitePaths({ moduleUrl: import.meta.url }).dirs.workspace;
  return cachedWorkspace;
}

/** Read the optional config file. Missing or unreadable means "disabled". */
export function loadGuardConfig({ dataRoot, suiteRoot = null } = {}) {
  const root = dataRoot ?? resolveSuitePaths({ moduleUrl: import.meta.url }).dataRoot;
  const file = path.join(root, CONFIG_RELATIVE);
  const defaults = {
    enabled: false,
    sourceProvider: SOURCE_PROVIDER,
    aliasProvider: COMPANION_PROVIDER,
    window: COMPANION_WINDOW,
    workspace: '',
    notes: [],
  };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') defaults.notes.push(`${CONFIG_RELATIVE} is unreadable (${error?.code ?? error?.message}); the guard stays off`);
    return { ...defaults, file, root, suiteRoot };
  }
  const window = Number(raw?.window);
  const workspace = String(raw?.workspace ?? '').trim();
  if (raw?.enabled !== true) return { ...defaults, file, root, suiteRoot };
  return {
    enabled: true,
    sourceProvider: String(raw?.sourceProvider ?? '').trim() || SOURCE_PROVIDER,
    aliasProvider: String(raw?.aliasProvider ?? '').trim() || COMPANION_PROVIDER,
    window: Number.isFinite(window) && window > 0 ? Math.trunc(window) : COMPANION_WINDOW,
    workspace: workspace ? (path.isAbsolute(workspace) ? workspace : path.resolve(root, workspace)) : companionWorkspace(),
    file,
    root,
    suiteRoot,
    notes: defaults.notes,
  };
}

// The project root can live behind a junction or a symlink, so two spellings of
// the same directory must resolve to the same identity. Resolve once per path and
// cache: this runs on every agent request.
const realPathCache = new Map();
function realPath(value) {
  const key = String(value ?? '');
  if (realPathCache.has(key)) return realPathCache.get(key);
  let resolved = key;
  try { resolved = fs.realpathSync.native(key); } catch { /* not on disk yet: keep the literal */ }
  realPathCache.set(key, resolved);
  return resolved;
}

function normalized(value) {
  return typeof value === 'string' && value !== ''
    ? path.win32.normalize(realPath(value)).replace(/[\\/]+$/, '').toLowerCase()
    : '';
}

export function isCompanionWorkspace(cwd, workspace = companionWorkspace()) {
  return normalized(cwd) !== '' && normalized(cwd) === normalized(workspace);
}

export function workspaceRoute(config, cwd, workspace = companionWorkspace(), { sourceProvider = SOURCE_PROVIDER, aliasProvider = COMPANION_PROVIDER } = {}) {
  if (![sourceProvider, aliasProvider].includes(config.provider)) return config;
  return { ...config, provider: isCompanionWorkspace(cwd, workspace) ? aliasProvider : sourceProvider };
}

/**
 * Forward the source adapter rather than copying endpoint, credentials, image
 * handling or the provider's dynamic session headers into a second configuration.
 * @param llm the host `llm` service
 * @param options.sourceProvider / aliasProvider / window
 */
export function createCompanionAdapter(llm, { sourceProvider = SOURCE_PROVIDER, aliasProvider = COMPANION_PROVIDER, window = COMPANION_WINDOW } = {}) {
  const source = () => llm.registration(sourceProvider).adapter;
  const label = `companion window ${Math.round(window / 1024)}k`;
  const metadata = info => ({ ...info, provider: aliasProvider,
    context: { contextWindow: Math.min(info.context?.contextWindow ?? window, window) } });
  return {
    providerInfo: () => ({ id: aliasProvider, name: label }),
    providerRetryPolicy: () => { try { return source().providerRetryPolicy(sourceProvider); } catch { return undefined; } },
    listModels: async () => (await source().listModels(sourceProvider)).map(info => ({ ...info, provider: aliasProvider })),
    resolveModel: async (_provider, model, signal) => metadata(await source().resolveModel(sourceProvider, model, signal)),
    imagePricing: (_provider, ...args) => source().imagePricing(sourceProvider, ...args),
    imageRequestPricing: (_provider, model) => source().imageRequestPricing(sourceProvider, model),
    imageRequestTarget: (_provider, ...args) => source().imageRequestTarget(sourceProvider, ...args),
    async prepareCall(_provider, model, signal) {
      const prepared = await source().prepareCall(sourceProvider, model, signal);
      return { model: metadata(prepared.model),
        stream: options => prepared.stream({ ...options, provider: sourceProvider }) };
    },
    async *stream(options) {
      const prepared = await this.prepareCall(aliasProvider, options.model, options.signal);
      yield* prepared.stream(options);
    },
  };
}

export function apply(ctx) {
  const paths = resolveSuitePaths({ moduleUrl: import.meta.url });
  const guard = loadGuardConfig({ dataRoot: paths.dataRoot, suiteRoot: paths.suiteRoot });
  for (const note of guard.notes) console.log(`[workspace-context] ${note}`);
  if (!guard.enabled) {
    console.log(`[workspace-context] disabled: no ${CONFIG_RELATIVE} with "enabled": true under ${guard.root}; no provider alias is registered`);
    return;
  }
  const llm = ctx.get('llm');
  if (!llm || typeof llm.registerAdapter !== 'function') {
    console.log('[workspace-context] the host llm service is unavailable; the provider alias was not registered');
    return;
  }
  const adapter = createCompanionAdapter(llm, { sourceProvider: guard.sourceProvider, aliasProvider: guard.aliasProvider, window: guard.window });
  let dispose;
  try {
    dispose = llm.registerAdapter([guard.aliasProvider], adapter);
  } catch (error) {
    console.log(`[workspace-context] could not register ${guard.aliasProvider}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  ctx.on('dispose', dispose);
  // Wrap later per-session model routing, so another plugin restoring a route also
  // obeys the original workspace path. A preset name alone is not a workspace identity.
  ctx.on('agent/request', async ({ agent }, next) => workspaceRoute(await next(), agent.session.header.cwd, guard.workspace, {
    sourceProvider: guard.sourceProvider,
    aliasProvider: guard.aliasProvider,
  }), { prepend: true });
  console.log(`[workspace-context] guarding ${guard.workspace}: ${guard.sourceProvider} -> ${guard.aliasProvider} (${guard.window} tokens)`);
}
