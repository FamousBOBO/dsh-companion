import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createMediaService } from './src/service.mjs';
import { resolveDataDir } from './src/persona.mjs';
import { registerMediaApi } from './src/http-api.mjs';
import { mediaPageDescriptor } from './src/ui-page.mjs';
import { createMediaHandlers } from './src/http-api.mjs';
import { createConfigStore } from './src/config-store.mjs';
import { validateConfig, normalizeConfig, DEFAULTS, SCHEMA_VERSION } from './src/schema.mjs';
import { previewResolution } from './src/resolution.mjs';
import { resolvePreset, presetFamilyFor } from './src/presets.mjs';
import { redactText, sanitize, maskSecret } from './src/secrets.mjs';
import { Code, toFailure } from './src/errors.mjs';
import { ADAPTERS, adapterCatalog, imageAdapter, ttsAdapter } from './src/adapters/registry.mjs';
import { createMediaHost } from './src/host-llm.mjs';

/**
 * companion-media — DSH bundle plugin entry.
 *
 * Mount order matters: the service is built first and the tools are registered
 * last, so a failure while registering cannot leave a half-built surface. Nothing
 * in `apply` may throw: a broken media plugin must degrade to "media is
 * unavailable", never to "the companion preset does not load".
 *
 * There is intentionally **no vision tool** and **no model warm/release tool**:
 *  - 识图本期只保留合同，任何入口都不可绕过；
 *  - 本地模型预热/释放与显存协调器不在本期范围（见 docs/media/M0-report.md §1.1）。
 */

export { mediaPageDescriptor };
export { createMediaService, createMediaHandlers, createConfigStore };
export { validateConfig, normalizeConfig, DEFAULTS, SCHEMA_VERSION, previewResolution, resolvePreset, presetFamilyFor };
export { redactText, sanitize, maskSecret, Code, toFailure, adapterCatalog, ADAPTERS, imageAdapter, ttsAdapter };

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const SUITE_ROOT = path.resolve(PLUGIN_ROOT, '..', '..');

export const name = 'companion-media';
export const inject = ['tools'];

const shared = new Map();

/** Process-local service sharing, so a second activation reuses the first. */
export function sharedMediaFor(root) {
  return shared.get(path.resolve(root)) ?? null;
}

function shareMedia(root, service) {
  const key = path.resolve(root);
  const existing = shared.get(key);
  if (existing) return existing;
  shared.set(key, service);
  return service;
}

// The host compiles an author-facing property map into raw JSON Schema through
// `defineTool`. Passing the map straight to the registry ships `{prompt:{…}}` as
// `parameters`, and the provider then rejects every request with
// `schema must be a JSON Schema of 'type: "object"'`. Use the host helper when it
// is reachable and the identical shape otherwise.
const runtimeRoot = process.env.DSH_COMPANION_MODULE_ROOT;
let defineTool = null;
if (runtimeRoot) {
  try {
    const module = await import(pathToFileURL(path.join(runtimeRoot, '@deepseek-ai/dsh-tools/lib/index.js')).href);
    defineTool = module.defineTool ?? null;
  } catch {
    defineTool = null;
  }
}

/** Same projection the host performs for an implicit property map. */
export function parametersToJsonSchema(spec = {}) {
  const properties = {};
  const required = [];
  for (const [key, value] of Object.entries(spec)) {
    if (!value || typeof value !== 'object') continue;
    const { required: isRequired, ...rest } = value;
    properties[key] = rest;
    if (isRequired) required.push(key);
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) };
}

function appendJsonl(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8');
  } catch { /* diagnostics never break a turn */ }
}

function registerTools(ctx, service) {
  const register = (toolName, description, parameters, execute, kind = 'read') => {
    const definition = {
      name: toolName,
      description,
      parameters,
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async (args, exec) => JSON.stringify(await execute(args ?? {}, exec)),
      presentCall: () => ({ card: 'generic', title: toolName, kind }),
    };
    const tool = typeof defineTool === 'function' ? defineTool(definition) : definition;
    if (typeof defineTool !== 'function') tool.parameters = parametersToJsonSchema(parameters);
    ctx.tools.register(tool);
  };

  register('companion_media_status',
    '读取媒体能力状态：哪些能力开着、每个 provider 处于哪个状态（未配置／已保存未测试／测试通过／测试失败／功能关闭／尚未接入）、限额、最近作业与产物。不含任何密钥，也不含图片内容。配置文件改动会在下次调用时生效。',
    {}, async () => service.status());

  register('companion_media_draw',
    '生成一张图片（计费）。默认关闭：未在「媒体能力」里显式打开生图、或没选 provider 时直接返回 MEDIA_DISABLED。prompt 描述画面；开启提示词生成管线后，NovelAI 可将中文要求编排为英文标签。dryRun=true 只做参数与分辨率校验，不发起任何网络请求。本工具不发送图片，只产出本地文件：成功后把 handoff.file 交给当前会话对应的图片发送工具（QQ 场景是 qq_sticker action=send）。失败不会自动重试，避免重复扣费；要重试必须由人显式再次调用。',
    {
      prompt: { type: 'string', required: true, description: '画面描述。英文完整句子，主体与关键要求在前；写清场景、动作、表情、镜头、光线、画风。' },
      negative: { type: 'string', description: '可选的反向提示词（NovelAI 使用；与配置里的基础反向提示词合并）。' },
      context: { type: 'string', description: '可选：本轮画面要求的相关上下文，不传入其他会话或私人记忆。' },
      dryRun: { type: 'boolean', description: 'true 只校验参数（含 NAI 预设族与分辨率），不发起生成。dry-run 成功不代表已产出图片。' },
    },
    async (args,exec) => service.generateImage({ prompt: args.prompt, negative: args.negative, context:args.context??'',sessionId:exec?.agent?.session?.id??null,signal:exec?.signal, dryRun: args.dryRun === true }), 'write');

  register('companion_media_speak',
    '用已配置的 TTS 后端把文本合成为语音文件（可能计费）。默认关闭：未在「媒体能力」里打开语音合成时返回 MEDIA_DISABLED。Index-TTS 尚未接入（缺官方 HTTP 协议），会返回 MEDIA_PROVIDER_NOT_IMPLEMENTED。text 只放要朗读的正文；Breeze 可使用语音导演结合 context 生成表演指令，失败则回退到原台词与已有指令。本工具只产出本地音频文件，不发送；成功后把 handoff.file 交给当前会话的语音发送工具（QQ 场景是 qq_voice action=send_file）。',
    {
      text: { type: 'string', required: true, description: '要朗读的完整文本，保留标点，不要放 Markdown 或 JSON。' },
      context: { type: 'string', description: '可选：当前台词的语境、说话意图与角色表达习惯，供语音导演使用。' },
      instructions: { type: 'string', description: '可选：直接提供 Breeze 的表演指令。语音导演关闭或失败时使用。' },
      provider: { type: 'string', description: '可选：临时指定已启用且已接入的 TTS provider id（默认用配置里的默认后端）。' },
    },
    async (args,exec) => service.synthesize({ text: args.text, provider: args.provider ?? null, context:args.context??'',instructions:args.instructions??'',sessionId:exec?.agent?.session?.id??null,signal:exec?.signal }), 'write');

  register('companion_media_job',
    '读取媒体作业、产物与失败原因。只含元数据（大小、MIME、时长、错误码），不含提示词正文与媒体内容。',
    {
      jobId: { type: 'string', description: '可选：查看单个作业。' },
      limit: { type: 'integer', description: '返回条数，默认 10。' },
    },
    async args => ({
      job: args.jobId ? service.getJob(args.jobId) : undefined,
      ...service.jobs(Number.isInteger(args.limit) ? args.limit : 10),
    }));
}

/**
 * Register the management API, and retry once the `connection` service arrives.
 *
 * `connection` is provided asynchronously by its own row, so it can legitimately
 * be missing while this plugin activates. A single attempt therefore is not
 * enough: if the first try reports `skipped: 'no-connection'`, wait for the
 * service with `ctx.inject(['connection'], …)` and register then. Without this
 * retry the routes never exist and the settings page 404s even though the module
 * is enabled — the page then looks like "媒体模块没有启用".
 *
 * Registration is idempotent per path (the host keys by path), so a second
 * attempt overwrites instead of duplicating.
 */
/**
 * Wait for the host's `connection` service, inside apply.
 *
 * Why inside apply: `connection.fetch.register` creates a Cordis effect internally, so it only
 * works while this plugin's context is active. Measured on a real host:
 *
 *   - direct attempt inside apply, service not ready yet  → `no-connection`, 0 routes
 *   - `ctx.inject(['connection'], cb)`                    → callback never delivered, 0 routes
 *   - later poll of `ctx.get('connection')`               → service found, every route rejected
 *                                                            with "cannot create effect on
 *                                                            inactive context"
 *   - nested `ctx.plugin({ inject: ['connection'] })`     → scheduled, apply never ran
 *
 * Holding apply open until the service appears is the one shape that keeps the context active
 * *and* does not depend on fiber scheduling we cannot observe. It is bounded, so a composition
 * without a connection service is delayed once and then gives up honestly.
 */
async function waitForConnection(ctx, timeoutMs = Number(process.env.DSH_MEDIA_CONNECTION_WAIT_MS || 5000), intervalMs = 100) {
  const started = Date.now();
  for (;;) {
    const connection = typeof ctx?.get === 'function' ? ctx.get('connection') : undefined;
    if (connection) return connection;
    if (Date.now() - started >= timeoutMs) return undefined;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

/**
 * Register the management API on the host's `connection` service.
 *
 * `connection` is provided asynchronously, and registering on it needs an **active** plugin
 * context: `connection.fetch.register` creates a Cordis effect internally, so calling it after
 * apply has returned fails with "cannot create effect on inactive context". Measured on a real
 * host, in this order:
 *
 *   - one direct attempt inside apply        → `no-connection` (service not ready yet), 0 routes
 *   - `ctx.inject(['connection'], cb)`       → callback never delivered for this plugin, 0 routes
 *   - a later poll of `ctx.get('connection')`→ service found, but every route failed with the
 *                                              inactive-context error above
 *
 * So the registrant must itself be a plugin that declares `inject: ['connection']`. Cordis then
 * runs its apply on a live fiber once the service exists, which is the only window where the
 * registration is accepted. Older hosts without `ctx.plugin` keep the best-effort inject path and
 * say so in the log rather than pretending the API exists.
 */
function mountApiOnConnection(ctx, service, log) {
  if (typeof ctx?.plugin === 'function') {
    try {
      ctx.plugin({
        name: 'companion-media/http-api',
        inject: ['connection'],
        apply: async nestedCtx => {
          await registerApiWhenReady(nestedCtx, service, log);
        },
      });
      log({ event: 'http-api-scheduled', how: 'nested-plugin', note: '已挂载 inject:[connection] 的子插件，服务就绪时注册' });
      return 'nested-plugin';
    } catch (error) {
      const message = String(error?.message ?? error).slice(0, 300);
      log({ event: 'http-api-failed', how: 'nested-plugin', message });
    }
  }
  if (typeof ctx?.inject === 'function') {
    try {
      ctx.inject(['connection'], injectedCtx => {
        Promise.resolve(registerApiWhenReady(injectedCtx, service, log)).catch(error => {
          const message = String(error?.message ?? error).slice(0, 300);
          log({ event: 'http-api-failed', how: 'inject', message });
        });
      });
      log({ event: 'http-api-scheduled', how: 'inject', note: '宿主无 ctx.plugin，退回 ctx.inject' });
      return 'inject';
    } catch (error) {
      const message = String(error?.message ?? error).slice(0, 300);
      log({ event: 'http-api-failed', how: 'inject-setup', message });
    }
  }
  log({ event: 'http-api-unavailable', how: 'none', message: '宿主既无 ctx.plugin 也无 ctx.inject，管理 API 不会存在', registered: 0 });
  return 'none';
}


async function registerApiWhenReady(ctx, service, log, { connectionWaitMs = null } = {}) {
  const record = (result, how) => {
    const registered = result?.registered ?? 0;
    const state = service.noteHttpState({
      registered,
      skipped: result?.skipped ?? null,
      how,
      paths: result?.paths ?? [],
      failed: result?.failed ?? [],
      lastError: result?.error ?? null,
    });
    log({
      event: registered > 0 ? 'http-api-registered' : 'http-api-waiting',
      how,
      registered,
      expected: state.paths.length || null,
      skipped: state.skipped,
      paths: registered > 0 ? state.paths : undefined,
      failed: state.failed.length ? state.failed : undefined,
      note: registered > 0 ? `已注册 ${registered} 条路由（${how}）` : '等待 connection 服务就绪',
    });
    return state;
  };

  try {
    let state = record(await registerMediaApi(ctx, service), 'direct');
    if (state.registered > 0) return state;

    if (state.skipped !== 'no-connection') {
      const message = 'connection 服务未就绪，且宿主没有可用的挂载机制';
      service.noteHttpState({ skipped: 'unavailable', lastError: message });
      log({ event: 'http-api-unavailable', message, registered: 0 });
      return state;
    }

    const waitMs = connectionWaitMs ?? Number(process.env.DSH_MEDIA_CONNECTION_WAIT_MS || 5000);
    const appeared = await waitForConnection(ctx, waitMs);
    if (!appeared) {
      const how = mountApiOnConnection(ctx, service, log);
      const message = `等了 ${waitMs} ms 仍没有 connection 服务；已改用 ${how} 兜底`;
      service.noteHttpState({ skipped: 'connection-timeout', lastError: message });
      log({ event: 'http-api-unavailable', how, message, registered: 0 });
      return state;
    }

    state = record(await registerMediaApi(ctx, service), 'awaited');
    if (state.registered === 0) {
      log({ event: 'http-api-failed', how: 'awaited', message: 'connection 就绪但注册 0 条', registered: 0 });
    }
    return state;
  } catch (error) {
    const message = String(error?.message ?? error).slice(0, 300);
    service.noteHttpState({ skipped: 'failed', lastError: message });
    log({ event: 'http-api-failed', how: 'direct', message });
    return service.httpState();
  }
}

export async function apply(ctx, options = {}) {
  // Cordis accepts only a disposer or void from a plugin effect.
  await mountMedia(ctx, options);
}

export async function mountMedia(ctx, options = {}) {
  const dataRoot = options?.dataDir
    ? { dir: path.resolve(String(options.dataDir)), source: 'option' }
    : resolveDataDir({ dataDir: '', env: process.env, suiteRoot: SUITE_ROOT });
  const logFile = path.join(dataRoot.dir, 'media', 'logs', 'media-events.jsonl');
  const log = entry => appendJsonl(logFile, { at: new Date().toISOString(), ...sanitize(entry) });

  try {
    const existing = sharedMediaFor(SUITE_ROOT);
    const service = existing ?? createMediaService({
      dataDir: dataRoot.dir,
      suiteRoot: SUITE_ROOT,
      env: process.env,
      log,
      host: options?.host ?? createMediaHost(ctx),
      ...(options?.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    if (!existing) shareMedia(SUITE_ROOT, service);
    if (typeof ctx?.provide === 'function') {
      try { ctx.provide('companionMedia', service); } catch { /* already provided by a sibling mount */ }
    }
    registerTools(ctx, service);
    // AWAIT it. `ctx.inject(['connection'], …)` only works while apply is still executing: it
    // subscribes the plugin's own fiber. Firing and forgetting here made the retry land in a
    // microtask after apply returned, where the host never delivers it — so the first attempt
    // saw `no-connection`, no retry ever arrived, and every /api/companion-media route stayed
    // 404 on a real host even though the module was enabled. The studio awaits its equivalent
    // (`const api = await mountApi(...)`), which is why only this plugin lost its routes.
    await registerApiWhenReady(ctx, service, log, { connectionWaitMs: options?.connectionWaitMs ?? null });
    const config = service.store.load().config;
    log({
      event: 'mounted',
      pid: process.pid,
      dataDir: dataRoot.dir,
      dataDirSource: dataRoot.source,
      dataDirSourceNote: '与 personaId 一起可通过 DSH_COMPANION_DATA_DIR / config/suite.json 覆盖',
      capabilities: {
        vision: 'reserved-disabled',
        image: { enabled: config.image.enabled, provider: config.image.provider },
        tts: { enabled: config.tts.enabled, provider: config.tts.provider },
      },
    });
    return service;
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    log({ event: 'mount-failed', message: message.slice(0, 400) });
    return { error: message };
  }
}
