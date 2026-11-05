import fs from 'node:fs';
import path from 'node:path';

// Configuration for the companion memory engine. The file is optional: missing
// fields fall back to documented defaults so that an upgrade never bricks a
// running companion. Only `home/companion/memory.config.json` is authoritative.

export const CONFIG_SCHEMA_VERSION = 1;

export const DEFAULT_CONFIG = Object.freeze({
  schemaVersion: CONFIG_SCHEMA_VERSION,
  // 'legacy' keeps the verified JSON/snapshot path; 'sqlite' enables this engine.
  backend: 'legacy',
  database: 'home/memory/companion-memory.db',
  injection: {
    budgetChars: 2400,
    includeIdentity: true,
    includeWikiSummary: true,
  },
  retrieval: {
    candidates: 32,
    topK: 8,
    rrfK: 60,
    mmrLambda: 0.72,
    semanticEnabled: true,
    // DF-weighted literal coverage floor. Real-corpus tuning (2026-10-27, 777
    // Chinese records): 0.30-0.40 silently killed every long natural question;
    // 0.15 kept long-question recall while still returning zero for unrelated
    // queries whose best garbage coverage was 0.0985.
    coverageFloor: 0.15,
  },
  extraction: {
    // Off by default: the base companion never spends model calls on its own.
    enabled: false,
    minMessages: 6,
    maxMessages: 40,
    maxOutputTokens: 2000,
    // A reasoning-capable route needs real headroom; 30s was not enough for a
    // slow provider and produced empty completions.
    timeoutMs: 120000,
    // A background summary does not need the chat route's deep reasoning; a very
    // high effort can spend the whole token budget on hidden reasoning and return
    // no visible JSON at all.
    reasoningEffort: 'low',
    provider: '',
    model: '',
    maxInputChars: 12000,
  },
  embedding: {
    provider: 'local',
    model: 'hash-bigram-256',
    dimensions: 256,
    baseUrl: '',
    apiKeyEnv: '',
    timeoutMs: 4000,
  },
  // 重排序（契约 §8.1）。默认关闭；关闭时不产生任何网络请求。
  // apiKey 不在这里出现：它只从 home/companion/remote-models.json 合并进内存。
  rerank: {
    enabled: false,
    provider: 'remote',
    baseUrl: '',
    model: '',
    apiKeyEnv: '',
    timeoutMs: 4000,
    topN: 0,
    blend: 0.7,
  },
  wiki: {
    enabled: true,
    dir: 'home/memory/wiki',
    autoCompile: true,
    minIntervalMs: 600000,
    maxEntriesPerTopic: 40,
    maxPageBytes: 32768,
  },
  limits: {
    captureMessageChars: 16000,
    factValueChars: 2000,
  },
});

const BACKENDS = new Set(['legacy', 'sqlite']);
const EMBEDDING_PROVIDERS = new Set(['local', 'remote', 'off']);
const RERANK_PROVIDERS = new Set(['remote', 'off']);

/** 密钥文件（契约 §8.2）：只存 API Key，绝不写进 memory.config.json。 */
export const REMOTE_MODELS_SCHEMA_VERSION = 1;
export const REMOTE_MODELS_FILE = 'remote-models.json';

export function remoteModelsPath(root) {
  return path.join(root, 'home/companion', REMOTE_MODELS_FILE);
}

function emptyRemoteModels() {
  return {
    schemaVersion: REMOTE_MODELS_SCHEMA_VERSION,
    embedding: { apiKey: '' },
    rerank: { apiKey: '' },
  };
}

function apiKeyOf(section) {
  const value = section && typeof section === 'object' ? section.apiKey : '';
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 读取密钥文件；任何异常都退化为「未设置」，绝不抛出，也绝不把内容写进日志。
 * -> { schemaVersion, embedding: { apiKey }, rerank: { apiKey }, error }
 */
export function readRemoteModels(file) {
  const result = emptyRemoteModels();
  result.error = null;
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') result.error = 'remote-models unreadable; keys unavailable';
    return result;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    result.error = 'remote-models is not valid JSON; keys unavailable';
    return result;
  }
  if (!isPlainObject(parsed)) {
    result.error = 'remote-models must be an object; keys unavailable';
    return result;
  }
  result.embedding.apiKey = apiKeyOf(parsed.embedding);
  result.rerank.apiKey = apiKeyOf(parsed.rerank);
  return result;
}

/** 原子写密钥文件（临时文件 + rename）；POSIX 上尽量收紧到 0600。 */
export function writeRemoteModels(file, value = {}) {
  const normalized = emptyRemoteModels();
  normalized.embedding.apiKey = apiKeyOf(value?.embedding);
  normalized.rerank.apiKey = apiKeyOf(value?.rerank);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, file);
    try { fs.chmodSync(file, 0o600); } catch { /* Windows 上不可用，忽略 */ }
  } finally {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { /* 清理失败不影响结果 */ }
  }
  return normalized;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Structural pre-pass: a legal JSON file can still have the wrong shape for a
 * section (for example `"extraction": null`). Wrong shapes are replaced with the
 * defaults and reported instead of throwing, so a typo never disables memory.
 */
function sanitizeShape(raw, notes) {
  const result = structuredClone(raw);
  for (const section of ['injection', 'retrieval', 'extraction', 'embedding', 'rerank', 'wiki', 'limits']) {
    if (result[section] === undefined) continue;
    if (!isPlainObject(result[section])) {
      notes.push(`${section} must be an object; using defaults`);
      delete result[section];
    }
  }
  for (const section of ['injection', 'retrieval', 'extraction', 'embedding', 'rerank', 'wiki', 'limits']) {
    const value = result[section];
    if (!isPlainObject(value)) continue;
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
        notes.push(`${section}.${key} must be a scalar; using default`);
        delete value[key];
      }
    }
  }
  for (const [key, entry] of Object.entries(result)) {
    if (key === 'schemaVersion') continue;
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) continue;
    if (key === 'backend' || key === 'database') continue;
    notes.push(`unknown top level field ${key}; ignored`);
    delete result[key];
  }
  return result;
}

function merge(base, override) {
  if (!isPlainObject(override)) return structuredClone(base);
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(result[key])) result[key] = merge(result[key], value);
    else if (value !== undefined) result[key] = value;
  }
  return result;
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

/** Validate and normalize a config object; invalid values fall back, never throw. */
export function normalizeConfig(raw = {}) {
  const shapeNotes = [];
  const shaped = isPlainObject(raw) ? sanitizeShape(raw, shapeNotes) : {};
  const config = merge(DEFAULT_CONFIG, shaped);
  const notes = [...shapeNotes];
  // Booleans must be real booleans; a string like "false" would be truthy.
  for (const [section, key] of [['injection', 'includeIdentity'], ['injection', 'includeWikiSummary'],
    ['retrieval', 'semanticEnabled'], ['extraction', 'enabled'], ['rerank', 'enabled'],
    ['wiki', 'enabled'], ['wiki', 'autoCompile']]) {
    if (typeof config[section][key] !== 'boolean') {
      notes.push(`${section}.${key} must be a boolean; using default`);
      config[section][key] = DEFAULT_CONFIG[section][key];
    }
  }
  if (!BACKENDS.has(config.backend)) {
    notes.push(`unknown backend ${JSON.stringify(config.backend)}; defaulting to legacy`);
    config.backend = 'legacy';
  }
  if (typeof config.database !== 'string' || !config.database.trim()) {
    notes.push('database path missing; using default');
    config.database = DEFAULT_CONFIG.database;
  }
  config.injection.budgetChars = clampInt(config.injection.budgetChars, 400, 8000, 2400);
  config.retrieval.candidates = clampInt(config.retrieval.candidates, 4, 200, 32);
  config.retrieval.topK = clampInt(config.retrieval.topK, 1, 20, 8);
  config.retrieval.rrfK = clampInt(config.retrieval.rrfK, 1, 200, 60);
  config.retrieval.mmrLambda = clampNumber(config.retrieval.mmrLambda, 0, 1, 0.72);
  config.retrieval.coverageFloor = clampNumber(config.retrieval.coverageFloor, 0.1, 0.9, 0.15);
  config.extraction.minMessages = clampInt(config.extraction.minMessages, 2, 200, 6);
  config.extraction.maxMessages = clampInt(config.extraction.maxMessages, config.extraction.minMessages, 400, 40);
  config.extraction.maxOutputTokens = clampInt(config.extraction.maxOutputTokens, 200, 8000, 2000);
  config.extraction.timeoutMs = clampInt(config.extraction.timeoutMs, 5000, 600000, 120000);
  if (typeof config.extraction.reasoningEffort !== 'string') {
    notes.push('extraction.reasoningEffort must be a string; using default');
    config.extraction.reasoningEffort = DEFAULT_CONFIG.extraction.reasoningEffort;
  }
  config.extraction.maxInputChars = clampInt(config.extraction.maxInputChars, 2000, 100000, 12000);
  if (!EMBEDDING_PROVIDERS.has(config.embedding.provider)) {
    notes.push(`unknown embedding provider ${JSON.stringify(config.embedding.provider)}; using local`);
    config.embedding.provider = 'local';
  }
  // 远端模型可以有更大维度（例如 Qwen3-Embedding-4B 是 2560），上限与 embed.mjs 对齐。
  config.embedding.dimensions = clampInt(config.embedding.dimensions, 64, 4096, 256);
  config.embedding.timeoutMs = clampInt(config.embedding.timeoutMs, 500, 30000, 4000);
  config.wiki.minIntervalMs = clampInt(config.wiki.minIntervalMs, 0, 86400000, 600000);
  config.wiki.maxEntriesPerTopic = clampInt(config.wiki.maxEntriesPerTopic, 1, 2000, 40);
  config.wiki.maxPageBytes = clampInt(config.wiki.maxPageBytes, 2048, 262144, 32768);
  config.limits.captureMessageChars = clampInt(config.limits.captureMessageChars, 500, 60000, 16000);
  config.limits.factValueChars = clampInt(config.limits.factValueChars, 100, 4000, 2000);
  if (config.embedding.provider === 'remote' && !config.embedding.baseUrl) {
    notes.push('remote embedding selected without baseUrl; falling back to local');
    config.embedding.provider = 'local';
  }
  if (config.embedding.provider === 'remote' && (!config.embedding.model || config.embedding.model === DEFAULT_CONFIG.embedding.model)) {
    // Sending the local model name to a remote endpoint would fail every call.
    notes.push('remote embedding requires an explicit model name; falling back to local');
    config.embedding.provider = 'local';
  }

  // 重排序归一化（契约 §8.1）：非法值只降级 + 记一条 note，绝不抛错。
  if (!RERANK_PROVIDERS.has(config.rerank.provider)) {
    notes.push(`unknown rerank provider ${JSON.stringify(config.rerank.provider)}; using remote`);
    config.rerank.provider = 'remote';
  }
  config.rerank.timeoutMs = clampInt(config.rerank.timeoutMs, 500, 30000, 4000);
  config.rerank.topN = clampInt(config.rerank.topN, 0, 50, 0);
  config.rerank.blend = clampNumber(config.rerank.blend, 0, 1, 0.7);
  if (typeof config.rerank.baseUrl !== 'string') {
    notes.push('rerank.baseUrl must be a string; using empty');
    config.rerank.baseUrl = '';
  }
  if (typeof config.rerank.model !== 'string') {
    notes.push('rerank.model must be a string; using empty');
    config.rerank.model = '';
  }
  if (typeof config.rerank.apiKeyEnv !== 'string') {
    notes.push('rerank.apiKeyEnv must be a string; using empty');
    config.rerank.apiKeyEnv = '';
  }
  config.rerank.baseUrl = config.rerank.baseUrl.trim();
  config.rerank.model = config.rerank.model.trim();
  if (config.rerank.enabled) {
    // 启用必须真的可用：provider 不是 off、端点与模型齐备且形如 http(s)。
    if (config.rerank.provider === 'off') {
      notes.push('rerank enabled with provider off; disabling');
      config.rerank.enabled = false;
    } else if (!config.rerank.baseUrl || !config.rerank.model) {
      notes.push('rerank enabled without baseUrl/model; disabling');
      config.rerank.enabled = false;
    } else if (!/^https?:\/\//i.test(config.rerank.baseUrl)) {
      notes.push('rerank.baseUrl must be http(s); disabling');
      config.rerank.enabled = false;
    }
  }
  return { config, notes };
}

function readJson(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const value = JSON.parse(text);
    return isPlainObject(value) ? value : {};
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw new Error(`Invalid memory config at ${file}: ${error.message}`);
  }
}

/** Write the default config once, without ever overwriting an existing file. */
export function ensureConfigFile(file) {
  if (fs.existsSync(file)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', 'utf8');
  fs.renameSync(temporary, file);
  return true;
}

/**
 * Load the effective config.
 * @param root - companion root (contains `home/`).
 * @param env - process environment for overrides.
 */
export function loadConfig(root, env = process.env) {
  const file = path.join(root, 'home/companion/memory.config.json');
  let raw = {};
  let error = null;
  try {
    raw = readJson(file);
  } catch (caught) {
    // A broken config must not disable memory; record it and use defaults.
    error = caught.message;
    raw = {};
  }
  const merged = merge(DEFAULT_CONFIG, raw);
  if (env.DSH_COMPANION_MEMORY_BACKEND) merged.backend = env.DSH_COMPANION_MEMORY_BACKEND;
  if (env.DSH_COMPANION_MEMORY_EXTRACTION === '1' || env.DSH_COMPANION_MEMORY_EXTRACTION === 'true') merged.extraction.enabled = true;
  if (env.DSH_COMPANION_MEMORY_EXTRACTION === '0' || env.DSH_COMPANION_MEMORY_EXTRACTION === 'false') merged.extraction.enabled = false;
  if (env.DSH_COMPANION_MEMORY_EMBEDDING) merged.embedding.provider = env.DSH_COMPANION_MEMORY_EMBEDDING;
  const { config, notes } = normalizeConfig(merged);
  // 密钥只从独立文件合进内存（契约 §8.2），绝不回写 memory.config.json。
  const remoteModelsFile = remoteModelsPath(root);
  const secrets = readRemoteModels(remoteModelsFile);
  config.embedding.apiKey = secrets.embedding.apiKey;
  config.rerank.apiKey = secrets.rerank.apiKey;
  if (secrets.error) notes.push(secrets.error);
  return { config, file, notes, error, remoteModelsFile };
}

export function resolveDatabasePath(root, config) {
  const target = String(config.database ?? DEFAULT_CONFIG.database);
  return path.isAbsolute(target) ? target : path.join(root, target);
}

export function resolveWikiDir(root, config) {
  const target = String(config.wiki?.dir ?? DEFAULT_CONFIG.wiki.dir);
  return path.isAbsolute(target) ? target : path.join(root, target);
}
