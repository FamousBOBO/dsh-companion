import { Code, mediaError } from './errors.mjs';
import { normalizePresets } from './presets.mjs';
import { validateGenerationLibrary } from './generation-presets.mjs';
import { NAI_SIZE_RULES } from './resolution.mjs';

/**
 * The single source of truth for the media configuration.
 *
 * Everything the UI, the adapters and the tests need is declared here:
 * defaults, provider capability records (including the *evidence level* of the
 * protocol research), required fields, and the ranges the plugin accepts.
 *
 * Two policy switches are intentionally NOT configurable:
 *  - `vision.enabled` is always false (contract only, non-bypassable);
 *  - image generation never auto-retries (there is no field to enable it).
 */

export const SCHEMA_VERSION = 2;

/**
 * Enumerations that the page renders as `<select>`.
 *
 * Declared before `DEFAULTS`/the capability registry because provider records
 * reference them; they are the same lists the adapters and validation use, so a
 * dropdown can never offer a value the backend rejects for a *format* reason.
 * Options are a convenience, not a gate: a value typed into the config file still
 * reaches the adapter, which is where the real check happens (e.g. GPT-SoVITS
 * refuses `raw` because it has no sample rate).
 */
export const NAI_SAMPLERS = Object.freeze([
  'k_euler',
  'k_euler_ancestral',
  'k_dpmpp_2m',
  'k_dpmpp_2s_ancestral',
  'k_dpmpp_2m_sde',
  'k_dpmpp_sde',
  'ddim',
]);
export const NAI_NOISE_SCHEDULES = Object.freeze(['native', 'karras', 'exponential', 'polyexponential']);
export const TTS_FORMATS = Object.freeze(['wav', 'pcm', 'mp3', 'opus']);
export const IMAGE_OUTPUT_FORMATS = Object.freeze(['png', 'jpeg', 'webp']);
export const IMAGE_QUALITIES = Object.freeze(['auto', 'low', 'medium', 'high', 'xhigh', 'max']);
export const IMAGE_BACKGROUNDS = Object.freeze(['auto', 'opaque', 'transparent']);
export const NAI_TRANSPORTS = Object.freeze(['official', 'openai-relay']);
export const GPT_SOVITS_MEDIA_TYPES = Object.freeze(['wav', 'ogg', 'aac']);
export const GPT_SOVITS_LANGS = Object.freeze(['auto', 'zh', 'en', 'ja', 'ko', 'yue']);
export const FISH_LATENCIES = Object.freeze(['normal', 'balanced']);

export const DEFAULTS = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  enabled: true,
  personaId: '',
  paths: {
    // 交付给通道的产物必须落在「用户可见、通道可读」的共同地带。默认
    // `<dataDir>/workspace/media`；留空即默认值，填相对路径按 dataDir 解析。
    artifactsDir: '',
  },
  limits: {
    requestBudgetMs: 240_000,
    connectTimeoutMs: 10_000,
    maxResponseBytes: 16 * 1024 * 1024,
    maxImageBytes: 16 * 1024 * 1024,
    maxAudioBytes: 32 * 1024 * 1024,
    maxRedirects: 2,
    maxImagesPerRequest: 1,
    maxTextChars: 4_000,
  },
  vision: {
    enabled: false,
    baseUrl: '',
    apiKey: '',
    model: '',
    timeoutMs: 60_000,
  },
  image: {
    enabled: false,
    provider: 'none',
    'openai-compatible': {
      baseUrl: '',
      apiKey: '',
      model: '',
      timeoutMs: 180_000,
      size: '1024x1024',
      quality: 'auto',
      outputFormat: 'png',
      background: 'auto',
    },
    nai: {
      autoResolution: false,
      aspect: 'portrait',
      activePresetId: '',
      generationPresets: [],
      transport: 'official',
      baseUrl: '',
      apiKey: '',
      model: 'nai-diffusion-4-5-full',
      timeoutMs: 240_000,
      width: 832,
      height: 1216,
      steps: 28,
      scale: 5,
      sampler: 'k_euler_ancestral',
      noiseSchedule: 'karras',
      seed: -1,
      ucPreset: 0,
      qualityToggle: true,
      sm: false,
      smDyn: false,
      negativePrompt: '',
      // 画师串：与预设分开存，方便单独编辑；写进正向提示词最前面。
      artistString: '',
      presets: normalizePresets(null),
    },
  },
  tts: {
    enabled: false,
    provider: 'none',
    providers: {
      'breeze-tts2': {
        enabled: false,
        baseUrl: '',
        apiKey: '',
        model: 'breeze-tts2',
        timeoutMs: 600_000,
        instruction: '',
        cfgScale: 1,
        seed: 42,
        refAudioPath: '',
        refText: '',
      },
      'gpt-sovits': {
        enabled: false,
        baseUrl: '',
        apiKey: '',
        model: '',
        timeoutMs: 300_000,
        refAudioPath: '',
        promptText: '',
        promptLang: 'zh',
        textLang: 'zh',
        mediaType: 'wav',
        speedFactor: 1,
        topK: 15,
        topP: 1,
        temperature: 1,
        seed: -1,
      },
      drama3: {
        enabled: false,
        baseUrl: 'https://api.fish.audio',
        apiKey: '',
        model: 'drama-3',
        timeoutMs: 300_000,
        referenceId: '',
        format: 'wav',
        latency: 'normal',
        temperature: 0.7,
        topP: 0.7,
      },
      'index-tts': {
        enabled: false,
        baseUrl: '',
        apiKey: '',
        model: '',
        timeoutMs: 300_000,
        refAudioPath: '',
      },
      'fish-audio': {
        enabled: false,
        baseUrl: 'https://api.fish.audio',
        apiKey: '',
        model: 's2.1-pro',
        timeoutMs: 300_000,
        referenceId: '',
        format: 'wav',
        latency: 'normal',
        temperature: 0.7,
        topP: 0.7,
      },
    },
  },
});

export const VERIFIED_AT = '2026-11-05';

/**
 * Capability registry. `status` has exactly three values, and only `connected`
 * may be presented as usable in the UI:
 *   connected      — 协议已核实，adapter 已实现
 *   not-connected  — 协议证据不足，adapter 只返回带原因的拒绝
 * `evidence` records HOW the protocol was verified (see docs/media/M0-report.md).
 */
export const IMAGE_PROVIDERS = Object.freeze({
  'openai-compatible': {
    id: 'openai-compatible',
    label: 'OpenAI-compatible 生图',
    status: 'connected',
    endpoint: 'POST {baseUrl}/images/generations',
    auth: 'Authorization: Bearer <apiKey>',
    responseFormat: 'JSON：data[].b64_json（GPT image 模型总是 base64）或 data[].url（受控下载）',
    voiceListing: null,
    rateLimit: '官方规范只给出 429，具体额度未公开',
    license: 'OpenAI 服务条款（闭源商业 API）',
    version: 'openai-openapi @ 2026-11-05',
    evidence: {
      level: 'A',
      sources: ['https://raw.githubusercontent.com/openai/openai-openapi/master/openapi.yaml'],
    },
    requiredFields: ['baseUrl', 'apiKey', 'model'],
    fieldLabels: {
      baseUrl: 'Base URL（例：https://api.openai.com/v1）',
      apiKey: 'API Key',
      model: '模型（例：gpt-image-2.5-flare）',
      size: '画幅（auto / 1024x1024 / 1536x1024 / 1024x1536 / WxH）',
      quality: 'quality（low/medium/high/xhigh/max/auto）',
      outputFormat: '输出格式（png/jpeg/webp）',
      background: '背景（auto/opaque/transparent）',
    },
    fieldOptions: {
      outputFormat: IMAGE_OUTPUT_FORMATS,
      quality: IMAGE_QUALITIES,
      background: IMAGE_BACKGROUNDS,
    },
    defaults: { timeoutMs: 180_000, size: '1024x1024', quality: 'auto', outputFormat: 'png', background: 'auto' },
  },
  nai: {
    id: 'nai',
    label: 'NovelAI（官方直连 / 中转站）',
    status: 'connected',
    endpoint: 'official: POST {baseUrl}/ai/generate-image · openai-relay: POST {baseUrl}/v1/images/generations',
    auth: 'Authorization: Bearer <apiKey>',
    responseFormat: 'SSE / ZIP 附件（内含 PNG）；中转站为 JSON data[].b64_json',
    voiceListing: null,
    rateLimit: '官方未公开具体数值；402 = 无有效订阅，409 = 冲突',
    license: 'NovelAI 订阅条款（闭源商业服务）',
    version: 'api.novelai.net Swagger @ 2026-11-05（model enum 已过期，见 M0 报告）',
    evidence: {
      level: 'A',
      sources: [
        'https://api.novelai.net/docs/docs/swagger-ui-init.js',
        'https://docs.novelai.net/en/image/models/',
        'https://github.com/woakato/astrbot_plugin_nai_image （MIT，C 级：parameters 明细）',
      ],
    },
    requiredFields: ['baseUrl', 'apiKey', 'model'],
    fieldLabels: {
      transport: 'transport（official / openai-relay）',
      baseUrl: 'Base URL（官方：https://image.novelai.net）',
      apiKey: 'Access Token',
      model: '模型（nai-diffusion-5-full / -curated / 4-5-full / 4-5-curated）',
      width: '宽（64 的倍数）',
      height: '高（64 的倍数）',
      steps: '步数（默认 28）',
      scale: '提示词引导（scale）',
      sampler: '采样器',
      noiseSchedule: '噪声调度',
      negativePrompt: '反向提示词（基础）',
    },
    fieldOptions: {
      transport: NAI_TRANSPORTS,
      sampler: NAI_SAMPLERS,
      noiseSchedule: NAI_NOISE_SCHEDULES,
    },
    defaults: { steps: 28, scale: 5, sampler: 'k_euler_ancestral', noiseSchedule: 'karras', width: 832, height: 1216 },
  },
});

export const TTS_PROVIDERS = Object.freeze({
  'breeze-tts2': {
    id: 'breeze-tts2',
    label: 'Breeze TTS 2',
    status: 'connected',
    endpoint: 'POST {baseUrl}/v1/audio/speech（multipart/form-data），GET {baseUrl}/health',
    auth: '无（官方服务无鉴权，须只监听本机/内网）',
    responseFormat: '流式 audio/pcm（mono 24 kHz s16le，X-Sample-Rate 头）；本层封装成 WAV',
    voiceListing: '无音色列表接口：音色 = 参考音频（ref_audio + ref_text）或自然语言 instruction',
    rateLimit: '无显式限流；单并发，占用中返回 409',
    license: '代码 Apache-2.0；权重为非商业研究许可（BreezeBlue Research and Non-Commercial License）',
    version: 'Breeze TTS 2（2026-08-25 发布）',
    evidence: {
      level: 'A',
      sources: ['https://github.com/breezeblue-ai/breeze-tts', 'https://github.com/breezeblue-ai/breeze-tts/blob/main/breeze_infer/api.py'],
    },
    requiredFields: ['baseUrl'],
    fieldLabels: {
      baseUrl: '服务地址（例：http://127.0.0.1:7860）',
      instruction: '表演指令（自然语言，Voice Direction）',
      cfgScale: 'cfg_scale（默认 1.0，设计音色时官方建议 4）',
      seed: 'seed',
      refAudioPath: '参考音频（可选，本机文件路径，会作为 multipart 上传）',
      refText: '参考音频逐字稿（与参考音频必须同时给）',
    },
    defaults: { timeoutMs: 600_000, cfgScale: 1, seed: 42 },
  },
  'gpt-sovits': {
    id: 'gpt-sovits',
    label: 'GPT-SoVITS',
    status: 'connected',
    endpoint: 'POST {baseUrl}/tts（JSON）',
    auth: '无（官方 api_v2.py 无鉴权，须只监听本机/内网）',
    responseFormat: 'audio/<media_type>（wav/raw/ogg/aac）音频流；失败 400 + JSON {message}',
    voiceListing: '无列表接口：音色 = 服务器上的参考音频路径 + prompt_text/prompt_lang',
    rateLimit: '无；单进程推理',
    license: 'MIT（Copyright (c) 2024 RVC-Boss）',
    version: 'RVC-Boss/GPT-SoVITS main（api_v2.py，默认端口 9880）',
    evidence: {
      level: 'A',
      sources: ['https://github.com/RVC-Boss/GPT-SoVITS/blob/main/api_v2.py', 'https://github.com/RVC-Boss/GPT-SoVITS/blob/main/LICENSE'],
    },
    requiredFields: ['baseUrl', 'refAudioPath', 'promptText', 'promptLang', 'textLang'],
    fieldLabels: {
      baseUrl: '服务地址（例：http://127.0.0.1:9880）',
      refAudioPath: '参考音频路径（服务端路径，不是本机文件）',
      promptText: '参考音频逐字稿',
      promptLang: '逐字稿语种（zh/en/ja/ko/yue/auto）',
      textLang: '合成文本语种',
      mediaType: '返回格式（wav/raw/ogg/aac）',
      speedFactor: '语速（speed_factor）',
    },
    fieldOptions: {
      mediaType: GPT_SOVITS_MEDIA_TYPES,
      promptLang: GPT_SOVITS_LANGS,
      textLang: GPT_SOVITS_LANGS,
    },
    defaults: { timeoutMs: 300_000, mediaType: 'wav', textLang: 'zh', promptLang: 'zh' },
  },
  drama3: {
    id: 'drama3',
    label: 'Drama3（Fish Audio drama-3）',
    status: 'connected',
    endpoint: 'POST {baseUrl}/v1/tts，header model: drama-3',
    auth: 'Authorization: Bearer <apiKey>',
    responseFormat: '音频字节（format=wav/pcm/mp3/opus）；错误 JSON {status,message,reason}',
    voiceListing: '音色 = reference_id（语音模型 ID，来自 fish.audio）；多说话人用 reference_id 数组 + <|speaker:N|> 标签',
    rateLimit: '官方页面未给数值（未核实）',
    license: 'Fish Audio 商业 API 条款；drama-3 为托管模型，权重不开源',
    version: 'Fish Audio TTS v1 @ 2026-11-05（model enum 含 drama-3）',
    evidence: {
      level: 'B',
      sources: ['https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech'],
    },
    requiredFields: ['baseUrl', 'apiKey', 'referenceId'],
    fieldLabels: {
      baseUrl: '服务地址（默认 https://api.fish.audio）',
      referenceId: 'reference_id（语音模型 ID；多说话人用逗号分隔多个）',
      model: '模型（固定 drama-3）',
      format: '返回格式（wav/pcm/mp3/opus）',
    },
    fieldOptions: {
      format: TTS_FORMATS,
      latency: FISH_LATENCIES,
    },
    defaults: { timeoutMs: 300_000, format: 'wav', latency: 'normal', temperature: 0.7, topP: 0.7 },
  },
  'index-tts': {
    id: 'index-tts',
    label: 'Index-TTS',
    status: 'not-connected',
    reason:
      '已核实（2026-11-05）：上游 index-tts/index-tts 的许可为 bilibili Model Use License Agreement（自定义模型使用协议，非开源许可），且仓库里没有文档化的 HTTP JSON 合成接口——可交互面只有 Gradio WebUI、Triton 后端与内部 openvoice 模块，没有请求字段/响应/鉴权契约可核实。按规格「不能因项目都叫 TTS 就共用一套请求体」与项目纪律，不猜 Gradio 内部协议，因此不实现 adapter。',
    endpoint: '—（无文档化 HTTP 契约；Gradio 的 /api/predict 属未文档化内部协议，不实现）',
    auth: '—',
    responseFormat: '—',
    voiceListing: '—',
    rateLimit: '—',
    license: 'bilibili Model Use License Agreement（自定义模型使用协议，非 OSS；GitHub API license.spdx_id = NOASSERTION）',
    version: 'index-tts/index-tts @ main（24,952 stars，默认分支 main，pushed 2026-09-29）',
    evidence: {
      level: 'A',
      sources: [
        'https://api.github.com/repos/index-tts/index-tts （license.spdx_id=NOASSERTION；tree 419 项，truncated=false）',
        'https://raw.githubusercontent.com/index-tts/index-tts/main/LICENSE （首行：bilibili Model Use License Agreement）',
        'https://raw.githubusercontent.com/index-tts/index-tts/main/api.py 不存在；可交互面：webui.py(55,404B) / backends/trt/serving/triton_server.py(16,151B) / indextts/s2mel/modules/openvoice/api.py(7,116B)',
      ],
      note: '核实时点 2026-11-05；口径与 THIRD-PARTY-NOTICES.md 的「Index-TTS 为什么标尚未接入」一节一致。',
    },
    requiredFields: [],
    fieldLabels: {},
    defaults: { timeoutMs: 300_000 },
  },
  'fish-audio': {
    id: 'fish-audio',
    label: 'Fish Audio',
    status: 'connected',
    endpoint: 'POST {baseUrl}/v1/tts，header model: s2.1-pro',
    auth: 'Authorization: Bearer <apiKey>',
    responseFormat: '音频字节（format=wav/pcm/mp3/opus）；错误 JSON {status,message,reason}',
    voiceListing: '音色 = reference_id（fish.audio 语音模型 ID）；Models 列表 API 本轮未取得页面证据',
    rateLimit: '官方页面未给数值（未核实）',
    license: 'Fish Audio 商业 API 条款',
    version: 'Fish Audio TTS v1 @ 2026-11-05',
    evidence: {
      level: 'B',
      sources: ['https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech'],
    },
    requiredFields: ['baseUrl', 'apiKey', 'referenceId'],
    fieldLabels: {
      baseUrl: '服务地址（默认 https://api.fish.audio）',
      referenceId: 'reference_id（语音模型 ID）',
      model: '模型（s1/s2-pro/s2.1-pro/s2.1-pro-free）',
      format: '返回格式（wav/pcm/mp3/opus）',
    },
    fieldOptions: {
      format: TTS_FORMATS,
      latency: FISH_LATENCIES,
    },
    defaults: { timeoutMs: 300_000, format: 'wav', latency: 'normal', temperature: 0.7, topP: 0.7 },
  },
});

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Deep merge `patch` over `base`; arrays are replaced, not concatenated. */
export function mergeConfig(base, patch) {
  if (patch === undefined || patch === null) return base;
  if (Array.isArray(base) || Array.isArray(patch)) return Array.isArray(patch) ? patch : base;
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch;
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = key in base ? mergeConfig(base[key], value) : value;
  }
  return out;
}

/**
 * Provider id aliases.
 *
 * The outward ids (what `/status`, `/page` and `/test` speak) are the contract
 * ids from the migration plan: `openai-compatible`, `nai`, `breeze-tts2`,
 * `gpt-sovits`, `drama3`, `index-tts`, `fish-audio`. Earlier versions of this
 * plugin used `openai` and `breeze-tts-2`; those are still accepted on input so
 * an existing local config keeps working, but they are normalized away on load.
 */
export const IMAGE_PROVIDER_ALIASES = Object.freeze({ openai: 'openai-compatible' });
export const TTS_PROVIDER_ALIASES = Object.freeze({ 'breeze-tts-2': 'breeze-tts2' });

export function canonicalImageProvider(id) {
  const key = String(id ?? '').trim();
  return IMAGE_PROVIDER_ALIASES[key] ?? key;
}

export function canonicalTtsProvider(id) {
  const key = String(id ?? '').trim();
  return TTS_PROVIDER_ALIASES[key] ?? key;
}

/** `image['openai-compatible']` / `tts.providers.breeze-tts2` — never dot-access a hyphenated key. */
export function imageSection(config, id) {
  const key = canonicalImageProvider(id);
  if (key === 'none') return {};
  return config?.image?.[key] ?? {};
}

export function ttsSection(config, id) {
  const key = canonicalTtsProvider(id);
  if (key === 'none') return {};
  return config?.tts?.providers?.[key] ?? {};
}

/**
 * Normalize stored config onto the defaults.
 *
 * `vision.enabled` is forced back to false and the NAI presets are re-shaped per
 * family, so an old or hand-edited file cannot re-enable vision or share one
 * preset bag between V5 and 4.5. Legacy provider ids are folded into the
 * canonical ones.
 */
export function normalizeConfig(raw = {}) {
  const merged = mergeConfig(structuredClone(DEFAULTS), isPlainObject(raw) ? raw : {});
  merged.schemaVersion = SCHEMA_VERSION;
  merged.vision = { ...merged.vision, enabled: false };

  // Fold legacy image section keys (`openai`) into the canonical one.
  merged.image = { ...merged.image };
  for (const [alias, canonical] of Object.entries(IMAGE_PROVIDER_ALIASES)) {
    if (!isPlainObject(merged.image[alias])) continue;
    merged.image[canonical] = mergeConfig({ ...(merged.image[canonical] ?? {}) }, merged.image[alias]);
    delete merged.image[alias];
  }
  merged.image.provider = canonicalImageProvider(merged.image.provider);
  merged.image.nai = { ...merged.image.nai, presets: normalizePresets(merged.image?.nai?.presets) };
  if (merged.image.nai.transport === 'official' && !String(merged.image.nai.baseUrl || '').trim()) merged.image.nai.baseUrl = 'https://image.novelai.net';

  // Same folding for TTS provider sections.
  merged.tts = { ...merged.tts, providers: { ...merged.tts.providers } };
  for (const [alias, canonical] of Object.entries(TTS_PROVIDER_ALIASES)) {
    if (!isPlainObject(merged.tts.providers[alias])) continue;
    merged.tts.providers[canonical] = mergeConfig({ ...(merged.tts.providers[canonical] ?? {}) }, merged.tts.providers[alias]);
    delete merged.tts.providers[alias];
  }
  merged.tts.provider = canonicalTtsProvider(merged.tts.provider);
  return merged;
}

export function isHttpUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Validate a normalized config.
 *
 * Validation is *conditional on intent*: an unconfigured provider is not an
 * error (the plugin must load with no remote at all), while an enabled provider
 * with a missing required field is.
 */
export function validateConfig(config) {
  const errors = [];
  const warnings = [];
  const add = (path, code, message) => errors.push({ path, code, message });

  if (!isPlainObject(config)) {
    add('$', Code.CONFIG_INVALID, 'config must be an object');
    return { ok: false, errors, warnings };
  }

  if (config.vision?.enabled === true) {
    add('vision.enabled', Code.VISION_LOCKED, '识图本期只保留合同，enabled 必须为 false，且不能通过任何界面或工具打开');
  }
  if (typeof config.paths?.artifactsDir === 'string' && config.paths.artifactsDir.trim() && !/^[A-Za-z]:[\\/]|^\//.test(config.paths.artifactsDir.trim())) {
    // 相对路径是允许的（按 dataDir 解析），但空字符串以外的非字符串必须拒绝
    warnings.push(`paths.artifactsDir 是相对路径，将按 dataDir 解析为 <dataDir>/${config.paths.artifactsDir.trim()}`);
  }
  if (config.paths?.artifactsDir !== undefined && config.paths?.artifactsDir !== null && typeof config.paths.artifactsDir !== 'string') {
    add('paths.artifactsDir', Code.CONFIG_INVALID, 'paths.artifactsDir 必须是字符串（留空 = <dataDir>/workspace/media）');
  }
  for (const [key, label] of [
    ['requestBudgetMs', 'requestBudgetMs'],
    ['connectTimeoutMs', 'connectTimeoutMs'],
    ['maxResponseBytes', 'maxResponseBytes'],
    ['maxImageBytes', 'maxImageBytes'],
    ['maxAudioBytes', 'maxAudioBytes'],
    ['maxImagesPerRequest', 'maxImagesPerRequest'],
    ['maxTextChars', 'maxTextChars'],
  ]) {
    const value = config.limits?.[key];
    if (!Number.isInteger(value) || value <= 0) add(`limits.${key}`, Code.CONFIG_INVALID, `${label} 必须是正整数`);
  }
  if (config.limits?.maxImagesPerRequest > 4) {
    add('limits.maxImagesPerRequest', Code.PARAM_OUT_OF_RANGE, 'maxImagesPerRequest 上限为 4（一次请求最多 4 张，避免重复扣费）');
  }

  const image = config.image ?? {};
  // 页面把超时标成「1000–600000 毫秒」，所以这里必须真的按这个范围校验——
  // 标签上写的约束不能只是装饰。
  const TIMEOUT_RANGE = { min: 1_000, max: 600_000 };
  const checkTimeout = (path, section) => {
    if (section?.timeoutMs === undefined) return;
    const value = section.timeoutMs;
    if (!Number.isInteger(value) || value < TIMEOUT_RANGE.min || value > TIMEOUT_RANGE.max) {
      add(path, Code.PARAM_OUT_OF_RANGE, `timeoutMs 必须是 ${TIMEOUT_RANGE.min}–${TIMEOUT_RANGE.max} 的整数（毫秒）`);
    }
  };
  checkTimeout('vision.timeoutMs', config.vision);
  for (const [id, section] of Object.entries(image)) {
    if (section && typeof section === 'object') checkTimeout(`image.${id}.timeoutMs`, section);
  }
  for (const [id, section] of Object.entries(config.tts?.providers ?? {})) {
    checkTimeout(`tts.providers.${id}.timeoutMs`, section);
  }
  if (!['none', 'openai-compatible', 'nai'].includes(image.provider)) {
    add('image.provider', Code.PROVIDER_UNKNOWN, `未知生图 provider：${image.provider}`);
  }
  if (image.enabled === true) {
    if (image.provider === 'none') {
      add('image.enabled', Code.NOT_CONFIGURED, '生图已开启但未选择 provider');
    } else {
      const record = IMAGE_PROVIDERS[image.provider];
      const section = image[image.provider] ?? {};
      for (const field of record?.requiredFields ?? []) {
        const value = section[field];
        if (typeof value !== 'string' || !value.trim()) {
          add(`image.${image.provider}.${field}`, Code.NOT_CONFIGURED, `${record.label} 缺少必填项：${record.fieldLabels[field] ?? field}`);
        }
      }
      if (section.baseUrl && !isHttpUrl(section.baseUrl)) {
        add(`image.${image.provider}.baseUrl`, Code.CONFIG_INVALID, 'Base URL 必须是 http(s) 绝对地址');
      }
    }
  }
  if (image.provider === 'nai') {
    const nai = image.nai ?? {};
    errors.push(...validateGenerationLibrary(nai));
    if (!['official', 'openai-relay'].includes(nai.transport)) {
      add('image.nai.transport', Code.PROVIDER_UNKNOWN, 'transport 只能是 official 或 openai-relay');
    }
    if (!NAI_SAMPLERS.includes(nai.sampler)) {
      add('image.nai.sampler', Code.PARAM_OUT_OF_RANGE, `sampler 必须是：${NAI_SAMPLERS.join(' / ')}`);
    }
    if (!NAI_NOISE_SCHEDULES.includes(nai.noiseSchedule)) {
      add('image.nai.noiseSchedule', Code.PARAM_OUT_OF_RANGE, `noiseSchedule 必须是：${NAI_NOISE_SCHEDULES.join(' / ')}`);
    }
    if (!Number.isInteger(nai.steps) || nai.steps < 1 || nai.steps > 50) {
      add('image.nai.steps', Code.PARAM_OUT_OF_RANGE, 'steps 必须是 1–50 的整数（官方默认档 28）');
    }
    if (typeof nai.scale !== 'number' || nai.scale < 0 || nai.scale > 20) {
      add('image.nai.scale', Code.PARAM_OUT_OF_RANGE, 'scale 必须是 0–20 的数字');
    }
    if (!Number.isInteger(nai.seed) || nai.seed < -1) {
      add('image.nai.seed', Code.PARAM_OUT_OF_RANGE, 'seed 必须是 -1（随机）或非负整数');
    }
    for (const edge of ['width', 'height']) {
      const value = nai[edge];
      if (!Number.isInteger(value) || value < NAI_SIZE_RULES.minEdge || value > NAI_SIZE_RULES.maxEdge || value % NAI_SIZE_RULES.multipleOf !== 0) {
        add(
          `image.nai.${edge}`,
          Code.PARAM_OUT_OF_RANGE,
          `${edge} 必须是 ${NAI_SIZE_RULES.minEdge}–${NAI_SIZE_RULES.maxEdge} 之间、${NAI_SIZE_RULES.multipleOf} 的倍数（不静默改值）`,
        );
      }
    }
    if (Number.isInteger(nai.width) && Number.isInteger(nai.height) && nai.width * nai.height > NAI_SIZE_RULES.maxPixels) {
      add('image.nai.width', Code.PARAM_OUT_OF_RANGE, `分辨率面积上限 ${NAI_SIZE_RULES.maxPixels}px，当前 ${nai.width * nai.height}px`);
    }
    if (typeof nai.artistString !== 'string') {
      add('image.nai.artistString', Code.CONFIG_INVALID, '画师串必须是字符串（留空 = 不加画师串）');
    } else if (nai.artistString.length > 500) {
      add('image.nai.artistString', Code.PARAM_OUT_OF_RANGE, '画师串超过 500 字符');
    }
    // 两种 transport 的字段面不同，分开校验：一种服务商的专属选项不能误发给另一种。
    const transport = String(nai.transport ?? 'official');
    if (transport === 'official') {
      if (nai.model && !/^nai-diffusion-/i.test(String(nai.model))) {
        add('image.nai.model', Code.CONFIG_INVALID, 'official 直连要求 NovelAI 模型 ID（nai-diffusion-*）；中转站请把 transport 切到 openai-relay');
      }
      if (nai.baseUrl && /\/v1\/?$/i.test(String(nai.baseUrl).trim())) {
        add('image.nai.baseUrl', Code.CONFIG_INVALID, 'official 直连的 Base URL 不要带 /v1（那是中转站的形态）；例如 https://image.novelai.net');
      }
    }
    if (transport === 'openai-relay') {
      if (nai.baseUrl && /^https?:\/\/image\.novelai\.net\/?$/i.test(String(nai.baseUrl).trim())) {
        add('image.nai.baseUrl', Code.CONFIG_INVALID, 'openai-relay 用于中转站，Base URL 不能是官方直连地址；官方直连请把 transport 切到 official');
      }
      if (!String(nai.baseUrl ?? '').trim()) {
        add('image.nai.baseUrl', Code.NOT_CONFIGURED, 'openai-relay 必须填写中转站的 Base URL');
      }
    }
  }
  if (image.provider === 'openai-compatible') {
    const openai = image['openai-compatible'] ?? {};
    if (!['png', 'jpeg', 'webp'].includes(openai.outputFormat)) {
      add('image.openai-compatible.outputFormat', Code.PARAM_OUT_OF_RANGE, 'outputFormat 必须是 png / jpeg / webp');
    }
    if (!['auto', 'low', 'medium', 'high', 'xhigh', 'max'].includes(openai.quality)) {
      add('image.openai-compatible.quality', Code.PARAM_OUT_OF_RANGE, 'quality 必须是 auto/low/medium/high/xhigh/max');
    }
  }

  const tts = config.tts ?? {};
  if (!['none', ...Object.keys(TTS_PROVIDERS)].includes(tts.provider)) {
    add('tts.provider', Code.PROVIDER_UNKNOWN, `未知 TTS provider：${tts.provider}`);
  }
  if (tts.enabled === true) {
    if (tts.provider === 'none') {
      add('tts.enabled', Code.NOT_CONFIGURED, 'TTS 已开启但未选择默认 provider');
    } else {
      const record = TTS_PROVIDERS[tts.provider];
      if (record.status !== 'connected') {
        add(`tts.provider`, Code.PROVIDER_NOT_IMPLEMENTED, `${record.label} 尚未接入：${record.reason}`);
      }
      const section = tts.providers?.[tts.provider] ?? {};
      if (section.enabled !== true) {
        add(`tts.providers.${tts.provider}.enabled`, Code.DISABLED, `默认 provider ${record.label} 未启用`);
      }
      for (const field of record.requiredFields) {
        const value = section[field];
        if (typeof value !== 'string' || !value.trim()) {
          add(`tts.providers.${tts.provider}.${field}`, Code.NOT_CONFIGURED, `${record.label} 缺少必填项：${record.fieldLabels[field] ?? field}`);
        }
      }
      if (section.baseUrl && !isHttpUrl(section.baseUrl)) {
        add(`tts.providers.${tts.provider}.baseUrl`, Code.CONFIG_INVALID, 'Base URL 必须是 http(s) 绝对地址');
      }
    }
  }
  for (const [id, record] of Object.entries(TTS_PROVIDERS)) {
    const section = tts.providers?.[id] ?? {};
    if (section.enabled === true && record.status !== 'connected') {
      add(`tts.providers.${id}.enabled`, Code.PROVIDER_NOT_IMPLEMENTED, `${record.label} 尚未接入，不能启用`);
    }
    if (section.enabled === true && section.baseUrl && !isHttpUrl(section.baseUrl)) {
      add(`tts.providers.${id}.baseUrl`, Code.CONFIG_INVALID, 'Base URL 必须是 http(s) 绝对地址');
    }
    if (id === 'breeze-tts2' && section.enabled === true) {
      const hasRef = Boolean(String(section.refAudioPath ?? '').trim());
      const hasText = Boolean(String(section.refText ?? '').trim());
      if (hasRef !== hasText) {
        add('tts.providers.breeze-tts2.refText', Code.CONFIG_INVALID, '参考音频与逐字稿必须同时填写或同时留空（官方服务端同样校验）');
      }
    }
    if ((id === 'fish-audio' || id === 'drama3') && section.format && !TTS_FORMATS.includes(section.format)) {
      add(`tts.providers.${id}.format`, Code.PARAM_OUT_OF_RANGE, `format 必须是 ${TTS_FORMATS.join(' / ')}`);
    }
  }

  if (warnings.length === 0) {
    if (image.enabled === true) warnings.push('生图是计费能力：本插件不会自动重试，失败即返回错误，重试必须由人显式发起');
    if (tts.enabled === true) warnings.push('TTS 可能计费（Fish Audio / Drama3）；本插件不发送任何消息');
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** Throw the first validation error, for callers that want exception style. */
export function assertValidConfig(config) {
  const verdict = validateConfig(config);
  if (!verdict.ok) {
    const first = verdict.errors[0];
    throw mediaError(first.code, `${first.path}: ${first.message}`);
  }
  return config;
}

/**
 * Legacy → new config migration.
 *
 * The old production file was machine-specific (absolute python paths, a local
 * GPU coordinator, a HF-space queue, personal voice ids). Only options a user
 * can actually confirm are carried over; everything else is reported in
 * `dropped[]` instead of silently disappearing.
 */
export function migrateLegacyConfig(raw = {}) {
  const dropped = [];
  const warnings = [];
  const next = structuredClone(DEFAULTS);

  const legacyVision = isPlainObject(raw.vision) ? raw.vision : null;
  if (legacyVision) {
    if (legacyVision.local?.baseUrl || legacyVision.cloud?.provider) {
      dropped.push('vision.local / vision.cloud（本地模型与宿主 LLM 云路由不随插件发布）');
    }
    next.vision = {
      ...next.vision,
      enabled: false,
      baseUrl: typeof legacyVision.local?.baseUrl === 'string' ? legacyVision.local.baseUrl : '',
      model: typeof legacyVision.local?.model === 'string' ? legacyVision.local.model : '',
      timeoutMs: Number(legacyVision.timeoutMs) || next.vision.timeoutMs,
      apiKey: '',
    };
  }

  const legacyImage = isPlainObject(raw.image) ? raw.image : null;
  if (legacyImage) {
    if (legacyImage.backend && legacyImage.backend !== 'openai' && legacyImage.backend !== 'openai-compatible' && legacyImage.backend !== 'nai') {
      dropped.push(`image.backend=${legacyImage.backend}（python 桥/本地管线不再随插件发布，标记 unsupported）`);
    }
    for (const key of ['pythonPath', 'imagePipelineRoot', 'configPath', 'runtime', 'queue', 'tagProvider', 'translatePrompt', 'promptFile', 'generationFlow', 'quotas', 'allowRealGeneration']) {
      if (key in legacyImage) dropped.push(`image.${key}`);
    }
    const looksNai = typeof legacyImage.model === 'string' && legacyImage.model.startsWith('nai-diffusion');
    if (looksNai) {
      next.image.provider = 'nai';
      next.image.nai = {
        ...next.image.nai,
        model: legacyImage.model,
        steps: Number.isInteger(legacyImage.steps) ? legacyImage.steps : next.image.nai.steps,
        scale: typeof legacyImage.scale === 'number' ? legacyImage.scale : next.image.nai.scale,
        negativePrompt: typeof legacyImage.negativePrompt === 'string' ? legacyImage.negativePrompt : '',
      };
      if (typeof legacyImage.size === 'string') {
        const match = /^(\d+)x(\d+)$/.exec(legacyImage.size);
        if (match) {
          next.image.nai.width = Number(match[1]);
          next.image.nai.height = Number(match[2]);
        }
      }
      if (isPlainObject(legacyImage.style)) {
        next.image.nai.presets['5'].positive = String(legacyImage.style.defaultPrompt ?? '');
        next.image.nai.presets['5'].negative = String(legacyImage.style.defaultNegative ?? '');
        next.image.nai.presets['5'].applyDefaults = legacyImage.style.applyDefaults === true;
        dropped.push('image.style.artist（个人画师串不随发布树迁移）');
      }
      warnings.push('旧配置的生图后端已迁移为 nai；API Key 需要重新填写（旧密钥不读取）');
    }
  }

  const legacySpeech = isPlainObject(raw.speech) ? raw.speech : null;
  if (legacySpeech) {
    const backend = legacySpeech.backend ?? {};
    if (backend.baseUrl || backend.voice) {
      next.tts.enabled = legacySpeech.enabled === true;
      next.tts.provider = 'breeze-tts2';
      next.tts.providers['breeze-tts2'] = {
        ...next.tts.providers['breeze-tts2'],
        enabled: legacySpeech.enabled === true,
        // The old value pointed at a local coordinator (`/breeze`); keep only the origin.
        baseUrl: String(backend.baseUrl ?? '').replace(/\/breeze\/?$/, ''),
        model: typeof backend.model === 'string' ? backend.model : 'breeze-tts2',
        cfgScale: typeof backend.cfgScale === 'number' ? backend.cfgScale : 1,
        seed: Number.isInteger(backend.seed) ? backend.seed : 42,
        timeoutMs: Number(backend.timeoutMs) || next.tts.providers['breeze-tts2'].timeoutMs,
      };
    }
    for (const key of ['presetsFile', 'emotionPresets', 'defaultInstructions', 'ffmpegPath', 'atempoTimeoutMs', 'director', 'auto']) {
      if (key in legacySpeech) dropped.push(`speech.${key}`);
    }
    warnings.push('旧配置里的音色 ID（个人参考音色）不被搬移：请在你的 Breeze 服务里重新指定参考音频');
  }

  for (const key of ['screen', 'delivery', 'managedDir', 'logFile']) {
    if (key in raw) dropped.push(key);
  }

  return { config: normalizeConfig(next), dropped, warnings };
}
