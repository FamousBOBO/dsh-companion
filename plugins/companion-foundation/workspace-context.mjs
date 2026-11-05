import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SOURCE_PROVIDER = 'opencode-go';
export const COMPANION_PROVIDER = 'opencode-go-companion-256k';
export const COMPANION_WINDOW = 262144;
export const DEFAULT_WINDOW = 524288;
const companionWorkspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../workspace');
export const name = 'companion-workspace-context';
export const inject = ['llm'];

// The project root can live behind a junction (this install is: the old drive path is a
// junction to the new one), so two spellings of the same directory must resolve to the same
// identity. Resolve once per path and cache: this runs on every agent request.
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
export function isCompanionWorkspace(cwd, workspace = companionWorkspace) {
  return normalized(cwd) !== '' && normalized(cwd) === normalized(workspace);
}
export function workspaceRoute(config, cwd, workspace = companionWorkspace) {
  if (![SOURCE_PROVIDER, COMPANION_PROVIDER].includes(config.provider)) return config;
  return { ...config, provider: isCompanionWorkspace(cwd, workspace) ? COMPANION_PROVIDER : SOURCE_PROVIDER };
}

// Forward the existing adapter rather than copying endpoint, credentials, image
// handling or OpenCode's dynamic session headers into a second configuration.
// registration().adapter is verified against the installed DSH 0.2.1-rc.3 seam.
export function createCompanionAdapter(llm) {
  const source = () => llm.registration(SOURCE_PROVIDER).adapter;
  const metadata = info => ({ ...info, provider: COMPANION_PROVIDER,
    context: { contextWindow: Math.min(info.context?.contextWindow ?? COMPANION_WINDOW, COMPANION_WINDOW) } });
  return {
    providerInfo: () => ({ id: COMPANION_PROVIDER, name: 'OpenCode Go · 三月七陪伴 256k' }),
    providerRetryPolicy: () => { try { return source().providerRetryPolicy(SOURCE_PROVIDER); } catch { return undefined; } },
    listModels: async () => (await source().listModels(SOURCE_PROVIDER)).map(info => ({ ...info, provider: COMPANION_PROVIDER })),
    resolveModel: async (_provider, model, signal) => metadata(await source().resolveModel(SOURCE_PROVIDER, model, signal)),
    imagePricing: (_provider, ...args) => source().imagePricing(SOURCE_PROVIDER, ...args),
    imageRequestPricing: (_provider, model) => source().imageRequestPricing(SOURCE_PROVIDER, model),
    imageRequestTarget: (_provider, ...args) => source().imageRequestTarget(SOURCE_PROVIDER, ...args),
    async prepareCall(_provider, model, signal) {
      const prepared = await source().prepareCall(SOURCE_PROVIDER, model, signal);
      return { model: metadata(prepared.model),
        stream: options => prepared.stream({ ...options, provider: SOURCE_PROVIDER }) };
    },
    async *stream(options) {
      const prepared = await this.prepareCall(COMPANION_PROVIDER, options.model, options.signal);
      yield* prepared.stream(options);
    },
  };
}

export function apply(ctx) {
  const llm = ctx.get('llm');
  const adapter = createCompanionAdapter(llm);
  const dispose = llm.registerAdapter([COMPANION_PROVIDER], adapter);
  ctx.on('dispose', dispose);
  // Wrap later per-session model routing, so QQ's route restoration also obeys
  // the original workspace path. Preset name alone is not a workspace identity.
  ctx.on('agent/request', async ({ agent }, next) => workspaceRoute(await next(), agent.session.header.cwd), { prepend: true });
  const report = async () => {
    try {
      const general = await llm.resolveModelInfo(SOURCE_PROVIDER, 'deepseek-v4.1-flash');
      const companion = await llm.resolveModelInfo(COMPANION_PROVIDER, 'deepseek-v4.1-flash');
      console.log(`[workspace-context] companion=${companion.context.contextWindow} other=${general.context.contextWindow}`);
    } catch { /* Source adapter can be registered later during boot. */ }
  };
  ctx.on('llm/adapters-updated', report);
  void report();
}
