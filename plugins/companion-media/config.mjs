import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = path.dirname(fileURLToPath(import.meta.url));

// NovelAI style defaults migrated from the old pipeline (artist string, positive
// preset, negative preset). They live in a data file rather than in this module
// so the exact strings stay auditable and can be edited without touching code.
export const STYLE_FILE = 'presets/nai-style.json';

export function loadStyleDefaults(pluginRoot = PLUGIN_ROOT) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(pluginRoot, STYLE_FILE), 'utf8').replace(/^\uFEFF/, ''));
    return {
      applyDefaults: raw.applyDefaults !== false,
      artist: String(raw.artist ?? '').trim(),
      defaultPrompt: String(raw.defaultPrompt ?? '').trim(),
      defaultNegative: String(raw.defaultNegative ?? '').trim(),
      source: path.join(pluginRoot, STYLE_FILE),
      migratedAt: raw.migratedAt ?? null,
    };
  } catch {
    return null;
  }
}

// Configuration for the shared media layer.
//
// Two rules drive this file:
//  1. Every capability is off until the operator turns it on (`enabled: false`).
//  2. Real spend (NovelAI, cloud vision) needs a second explicit switch, so a
//     careless enable cannot bill an account.
//
// Values mirror what is actually on disk in the old stack (see
// logs/media-migration/M0-report.md); the README of that stack is not trusted
// over the live config.

export const CONFIG_RELATIVE_PATH = 'home/media/config.json';

export const DEFAULTS = Object.freeze({
  schemaVersion: 1,
  enabled: true, // the plugin mounts and exposes read-only status; capabilities stay off below
  managedDir: 'media',
  logFile: 'logs/media-migration/media-events.jsonl',
  limits: {
    maxImageBytes: 12 * 1024 * 1024,
    maxImagesPerTurn: 4,
    maxPixels: 40_000_000,
    minDimension: 16,
    downloadTimeoutMs: 20_000,
    maxRedirects: 2,
  },
  vision: {
    enabled: false,
    promptVersion: 'v1',
    maxChars: 2400,
    gifMaxFrames: 4,
    probeMaxDimension: 384,
    cacheMaxItems: 300,
    cacheScope: 'owner',
    timeoutMs: 90_000,
    local: {
      baseUrl: 'http://127.0.0.1:8139/ollama/v1',
      model: 'nsfwvision-v3:q5',
      // The 8139 coordinator is the only path to the local vision weights.
      // Bypassing it would break the vision<->speech GPU mutex, so the URL is
      // enforced in code, not merely documented.
      requireCoordinator: true,
    },
    cloud: {
      provider: 'opencode-go',
      model: 'deepseek-v4.1-flash',
      timeoutMs: 90_000,
    },
    stickerKindSource: 'filename-prefix-or-mime',
  },
  speech: {
    enabled: false,
    backend: {
      baseUrl: 'http://127.0.0.1:8139/breeze',
      model: 'breeze-tts-2',
      voice: 'march7_B',
      cfgScale: 3,
      seed: 42,
      speed: 0.9,
      maxNewTokens: 500,
      timeoutMs: 600_000,
    },
    presetsFile: 'C:/Users/bobo/Documents/Bot/breeze-tts2/march7-emotion-presets.json',
    emotionPresets: {},
    defaultInstructions: '保持参考说话人的音色。自然亲切地说话，语速适中，吐字清楚，句末自然收住，不额外叹气或呼气。',
    ffmpegPath: 'ffmpeg',
    atempoTimeoutMs: 60_000,
    director: {
      enabled: true,
      provider: 'opencode-go',
      model: 'deepseek-v4.1-flash',
      timeoutMs: 60_000,
      maxInstructionChars: 2000,
    },
    auto: {
      enabled: false,
      probability: 35,
      minIntervalSeconds: 180,
      deliveryMode: 'voice_only',
      maxChars: 0,
    },
  },
  image: {
    enabled: false,
    allowRealGeneration: false,
    backend: 'novelai-pipeline-bridge',
    pythonPath: 'C:/Python314/python.exe',
    imagePipelineRoot: 'C:/Users/bobo/Documents/Bot/astrbot/data/plugins/astrbot_plugin_image_pipeline',
    configPath: 'C:/Users/bobo/Documents/Bot/astrbot/data/config/astrbot_plugin_image_pipeline_config.json',
    generationFlow: 'tag',
    model: 'nai-diffusion-5-full',
    size: '832x1216',
    steps: 28,
    scale: 5,
    cloudQueue: true,
    timeoutMs: 240_000,
    // Shared 8139 GPU coordinator. Models load on demand and are released after
    // `idleReleaseSeconds` of quiet; the media layer can also warm or release them
    // explicitly through `companion_media_warm`. Voice and vision never load at
    // the same time — the coordinator serialises them and so does this layer.
    runtime: {
      baseUrl: 'http://127.0.0.1:8139',
      idleReleaseSeconds: 300,
      loadTimeoutMs: 300_000,
      pollIntervalMs: 500,
    },
    // NovelAI queue service (st-chatu/novelai-queue on Hugging Face Spaces).
    // The old pipeline already wraps the HTTP call in this queue to avoid 429s
    // when several instances generate at once; these values override the old
    // config in memory only.
    queue: {
      enabled: true,
      baseUrl: 'https://st-chatu-novelai-queue.hf.space',
      userId: 'bobo-march7',
      greeting: '三月七',
      keyHash: '',
      joinTimeoutSeconds: 180,
      pollIntervalSeconds: 1.5,
      requestTimeoutSeconds: 10,
      failOpen: true,
    },
    promptFile: 'src/prompts/advanced.txt',
    tagProvider: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
    tagTimeoutMs: 120_000,
    // Fallback only: the tool asks the model to write English natively. This hop
    // catches the case where a Chinese prompt slips through anyway, so it never
    // reaches NovelAI's caption untranslated.
    translatePrompt: { enabled: true },
    // Filled from presets/nai-style.json when that file exists (migrated from the
    // live old config). Empty here means "no extra style"; the loader fills it.
    style: {
      applyDefaults: true,
      artist: '',
      defaultPrompt: '',
      defaultNegative: '',
    },
    quotas: {
      private_owner: -1,
      private_friend: -1,
      group: -1,
      proactive: -1,
      natural_language: -1,
    },
  },
  screen: {
    enabled: false,
    mode: 'fixture',
    maxAgeSeconds: 60,
    prompt: '请用尽量少的字分析这张屏幕截图，只输出高价值信息。优先判断：1. 用户当前在做什么任务 2. 进行到哪一步 3. 画面里最关键的线索或异常 4. 如果需要互动，最值得给出的一个任务相关建议点。',
    cloud: { provider: 'opencode-go', model: 'deepseek-v4.1-flash', timeoutMs: 90_000 },
  },
  delivery: {
    mode: 'mock',
    order: ['voice', 'at', 'text', 'face', 'image', 'other'],
    trailingWindowMs: 7000,
    maxWaitMs: 15000,
    imageWindowMs: 8000,
  },
});

function merge(base, patch) {
  if (patch === undefined || patch === null) return base;
  if (Array.isArray(base) || Array.isArray(patch)) return Array.isArray(patch) ? patch : base;
  if (typeof base !== 'object' || typeof patch !== 'object') return patch;
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = key in base ? merge(base[key], value) : value;
  }
  return out;
}

/** Deep-merge a stored config over the defaults; unknown keys are kept (forward compatible). */
export function normalizeConfig(raw) {
  return merge(structuredClone(DEFAULTS), raw ?? {});
}

/** Read the config file. A missing file yields defaults plus a `missing` marker. */
export function loadConfig(root, { file } = {}) {
  const configPath = file ?? path.join(root, CONFIG_RELATIVE_PATH);
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
    return { config: withStyle(normalizeConfig(raw)), source: configPath, missing: false };
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      return { config: withStyle(normalizeConfig({})), source: configPath, missing: true, error: error instanceof Error ? error.message : String(error) };
    }
    return { config: withStyle(normalizeConfig({})), source: configPath, missing: true };
  }
}

/**
 * Apply the migrated NovelAI style defaults when the operator has not overridden
 * them in the config file. An explicit `applyDefaults: false` wins.
 */
export function withStyle(config, pluginRoot = PLUGIN_ROOT) {
  const style = config.image?.style;
  if (!style || style.applyDefaults === false) return config;
  if (style.defaultPrompt && style.defaultNegative) return config;
  const migrated = loadStyleDefaults(pluginRoot);
  if (!migrated) return config;
  return {
    ...config,
    image: {
      ...config.image,
      style: {
        ...migrated,
        ...style,
        // Only fill blanks; an operator-edited value in the config file stays.
        defaultPrompt: style.defaultPrompt || migrated.defaultPrompt,
        defaultNegative: style.defaultNegative || migrated.defaultNegative,
        artist: style.artist || migrated.artist,
        applyDefaults: true,
      },
    },
  };
}

const SECRET_KEY = /(token|key|secret|password|cookie|auth|credential)/i;
// Value-level patterns as well as key names: an unexpected field must not leak a
// token just because its name did not look sensitive (review round 1).
const SECRET_VALUE = /\b(pst-[A-Za-z0-9_-]{16,}|oc_sk_[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._-]{16,})\b/g;

/** Remove credential-shaped substrings from any text before it is logged or returned. */
export function redactText(value) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return text.replace(SECRET_VALUE, '[redacted]');
}

function stripSecrets(value, depth = 0) {
  if (value === null) return value;
  if (typeof value === 'string') return redactText(value);
  if (typeof value !== 'object') return value;
  if (depth > 16) return '[depth-limit]';
  if (Array.isArray(value)) return value.map(item => stripSecrets(item, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SECRET_KEY.test(key) ? '[redacted]' : stripSecrets(item, depth + 1);
  }
  return out;
}

/** Config as it may appear in a report, a log line or a model prompt. */
export function sanitizedConfig(config) {
  const copy = stripSecrets(config);
  if (copy?.image) {
    copy.image = { ...copy.image, configPath: '[local path]', pythonPath: '[local path]', imagePipelineRoot: '[local path]' };
  }
  return copy;
}
