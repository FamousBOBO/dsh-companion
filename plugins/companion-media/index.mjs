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
    '生成一张图片（计费）。默认关闭：未在「媒体能力」里显式打开生图、或没选 provider 时直接返回 MEDIA_DISABLED。prompt 用英文完整句子描述画面（OpenAI 兼容后端与 NovelAI 都是英文提示词更稳）。dryRun=true 只做参数与分辨率校验，不发起任何网络请求。本工具不发送图片，只产出本地文件：成功后把 handoff.file 交给当前会话对应的图片发送工具（QQ 场景是 qq_sticker action=send）。失败不会自动重试，避免重复扣费；要重试必须由人显式再次调用。',
    {
      prompt: { type: 'string', required: true, description: '画面描述。英文完整句子，主体与关键要求在前；写清场景、动作、表情、镜头、光线、画风。' },
      negative: { type: 'string', description: '可选的反向提示词（NovelAI 使用；与配置里的基础反向提示词合并）。' },
      dryRun: { type: 'boolean', description: 'true 只校验参数（含 NAI 预设族与分辨率），不发起生成。dry-run 成功不代表已产出图片。' },
    },
    async args => service.generateImage({ prompt: args.prompt, negative: args.negative, dryRun: args.dryRun === true }), 'write');

  register('companion_media_speak',
    '用已配置的 TTS 后端把文本合成为语音文件（可能计费）。默认关闭：未在「媒体能力」里打开语音合成时返回 MEDIA_DISABLED。Index-TTS 尚未接入（缺官方 HTTP 协议），会返回 MEDIA_PROVIDER_NOT_IMPLEMENTED。text 只放要朗读的正文；Breeze 的表演指令请在配置里填写。本工具只产出本地音频文件，不发送；成功后把 handoff.file 交给当前会话的语音发送工具（QQ 场景是 qq_voice action=send_file）。',
    {
      text: { type: 'string', required: true, description: '要朗读的完整文本，保留标点，不要放 Markdown 或 JSON。' },
      provider: { type: 'string', description: '可选：临时指定已启用且已接入的 TTS provider id（默认用配置里的默认后端）。' },
    },
    async args => service.synthesize({ text: args.text, provider: args.provider ?? null }), 'write');

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

export function apply(ctx, options = {}) {
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
      ...(options?.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    if (!existing) shareMedia(SUITE_ROOT, service);
    if (typeof ctx?.provide === 'function') {
      try { ctx.provide('companionMedia', service); } catch { /* already provided by a sibling mount */ }
    }
    registerTools(ctx, service);
    Promise.resolve(registerMediaApi(ctx, service)).then(result => {
      log({ event: 'http-api', registered: result?.registered ?? 0, skipped: result?.skipped ?? null });
    }).catch(error => {
      log({ event: 'http-api-failed', message: String(error?.message ?? error).slice(0, 300) });
    });
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
