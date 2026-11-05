import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULTS,
  IMAGE_PROVIDERS,
  SCHEMA_VERSION,
  TTS_PROVIDERS,
  migrateLegacyConfig,
  normalizeConfig,
  validateConfig,
} from '../src/schema.mjs';
import { presetFamilyFor } from '../src/presets.mjs';
import { Code } from '../src/errors.mjs';

test('默认值：所有计费能力关闭，识图恒关闭，步数默认 28', () => {
  const config = normalizeConfig({});
  assert.equal(config.schemaVersion, SCHEMA_VERSION);
  assert.equal(config.image.enabled, false);
  assert.equal(config.image.provider, 'none');
  assert.equal(config.tts.enabled, false);
  assert.equal(config.tts.provider, 'none');
  assert.equal(config.vision.enabled, false, '识图必须默认关闭');
  assert.equal(config.image.nai.steps, 28, 'NAI 步数默认 28');
  for (const [id, section] of Object.entries(config.tts.providers)) {
    assert.equal(section.enabled, false, `${id} 必须默认关闭`);
  }
  // 没有任何"自动重试"开关存在，避免误开重复扣费
  assert.equal('autoRetry' in config.image, false);
  assert.equal(JSON.stringify(config).includes('retry'), false);
});

test('normalizeConfig 强制把 vision.enabled 拉回 false，并按族重建预设', () => {
  const config = normalizeConfig({ vision: { enabled: true }, image: { nai: { presets: { '5': { positive: 'p5' } } } } });
  assert.equal(config.vision.enabled, false);
  assert.equal(config.image.nai.presets['5'].positive, 'p5');
  assert.deepEqual(config.image.nai.presets['4.5'], { applyDefaults: false, positive: '', negative: '' });
});

test('校验：未配置不算错误（插件必须能在没有远端时加载）', () => {
  const verdict = validateConfig(normalizeConfig({}));
  assert.equal(verdict.ok, true, JSON.stringify(verdict.errors));
});

test('校验：vision.enabled=true 被拒（不可绕过）', () => {
  const config = normalizeConfig({});
  config.vision.enabled = true;
  const verdict = validateConfig(config);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.errors[0].code, Code.VISION_LOCKED);
});

test('校验：开启生图但缺必填项 → 逐字段报错', () => {
  const config = normalizeConfig({ image: { enabled: true, provider: 'openai' } });
  const verdict = validateConfig(config);
  assert.equal(verdict.ok, false);
  const paths = verdict.errors.map(item => item.path);
  assert.ok(paths.includes('image.openai.baseUrl'));
  assert.ok(paths.includes('image.openai.apiKey'));
  assert.ok(paths.includes('image.openai.model'));
});

test('校验：参数边界（步骤/scale/分辨率/sampler）', () => {
  const base = normalizeConfig({
    image: { enabled: true, provider: 'nai', nai: { baseUrl: 'https://image.novelai.net', apiKey: 'k', model: 'nai-diffusion-5-full' } },
  });
  const cases = [
    [{ steps: 0 }, 'image.nai.steps'],
    [{ steps: 51 }, 'image.nai.steps'],
    [{ scale: 25 }, 'image.nai.scale'],
    [{ width: 800 }, 'image.nai.width'], // 800 不是 64 的倍数
    [{ height: 64 }, 'image.nai.height'],
    [{ sampler: 'dreamshaper' }, 'image.nai.sampler'],
    [{ noiseSchedule: 'warp' }, 'image.nai.noiseSchedule'],
  ];
  for (const [patch, expected] of cases) {
    const config = structuredClone(base);
    Object.assign(config.image.nai, patch);
    const verdict = validateConfig(config);
    assert.equal(verdict.ok, false, `应当拒绝 ${JSON.stringify(patch)}`);
    assert.ok(verdict.errors.some(item => item.path === expected), `缺少 ${expected} 的错误：${JSON.stringify(verdict.errors)}`);
  }
});

test('校验：开启 TTS 但选 Index-TTS → PROVIDER_NOT_IMPLEMENTED', () => {
  const config = normalizeConfig({
    tts: { enabled: true, provider: 'index-tts', providers: { 'index-tts': { enabled: true } } },
  });
  const verdict = validateConfig(config);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some(item => item.code === Code.PROVIDER_NOT_IMPLEMENTED));
});

test('校验：Breeze 参考音频与逐字稿必须成对', () => {
  const config = normalizeConfig({
    tts: {
      enabled: true,
      provider: 'breeze-tts-2',
      providers: { 'breeze-tts-2': { enabled: true, baseUrl: 'http://127.0.0.1:7860', refAudioPath: '/tmp/a.wav' } },
    },
  });
  const verdict = validateConfig(config);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some(item => item.message.includes('参考音频')));
});

test('能力表：只有协议已核实的 provider 是 connected', () => {
  for (const [id, record] of Object.entries(TTS_PROVIDERS)) {
    if (id === 'index-tts') {
      assert.equal(record.status, 'not-connected');
      assert.match(record.reason, /没有官方 HTTP/);
    } else {
      assert.equal(record.status, 'connected', `${id} 应为已接入`);
    }
    assert.ok(record.evidence?.level, `${id} 必须有证据等级`);
    assert.ok(Array.isArray(record.evidence?.sources) && record.evidence.sources.length > 0, `${id} 必须有来源 URL`);
  }
  assert.equal(IMAGE_PROVIDERS.openai.status, 'connected');
  assert.equal(IMAGE_PROVIDERS.nai.status, 'connected');
});

test('迁移：旧生产配置只保留可确认的 API 选项，其余进 dropped', () => {
  const legacy = {
    schemaVersion: 1,
    image: {
      enabled: true,
      backend: 'novelai-pipeline-bridge',
      pythonPath: 'C:/Python314/python.exe',
      imagePipelineRoot: 'C:/Users/someone/pipeline',
      configPath: 'C:/Users/someone/cfg.json',
      runtime: { baseUrl: 'http://127.0.0.1:8139' },
      queue: { enabled: true, userId: 'legacy-owner-id', greeting: 'old-persona' },
      model: 'nai-diffusion-5-full',
      steps: 30,
      scale: 4,
      size: '832x1216',
      style: { applyDefaults: true, artist: 'some artist', defaultPrompt: 'p', defaultNegative: 'n' },
      generationFlow: 'tag',
      quotas: { private_owner: -1 },
    },
    speech: {
      enabled: true,
      backend: { baseUrl: 'http://127.0.0.1:8139/breeze', model: 'breeze-tts-2', voice: 'REF_B', cfgScale: 3, seed: 7, speed: 0.9, timeoutMs: 600000 },
      presetsFile: 'C:/Users/someone/presets.json',
      emotionPresets: { happy: 'x' },
      director: { enabled: true },
      auto: { enabled: true },
      ffmpegPath: 'ffmpeg',
    },
    screen: { enabled: true },
    delivery: { mode: 'mock' },
    vision: { enabled: true, local: { baseUrl: 'http://127.0.0.1:8139/ollama/v1', model: 'vision:q5' } },
  };
  const { config, dropped, warnings } = migrateLegacyConfig(legacy);
  assert.equal(config.vision.enabled, false, '迁移不得打开识图');
  assert.equal(config.image.provider, 'nai');
  assert.equal(config.image.nai.model, 'nai-diffusion-5-full');
  assert.equal(config.image.nai.steps, 30);
  assert.equal(config.image.nai.width, 832);
  assert.equal(config.image.nai.presets['5'].positive, 'p');
  assert.equal(config.tts.provider, 'breeze-tts-2');
  assert.equal(config.tts.providers['breeze-tts-2'].baseUrl, 'http://127.0.0.1:8139', '旧 /breeze 路径被去掉');
  assert.equal(config.tts.providers['breeze-tts-2'].apiKey, '', '旧密钥不读取');
  // 与个人身份、作者机器相关的字段不迁移
  const text = JSON.stringify({ config, dropped });
  for (const mine of ['legacy-owner-id', 'old-persona', 'C:/Users', 'some artist']) {
    assert.equal(text.includes(mine), false, `迁移结果不应含 ${mine}`);
  }
  assert.ok(dropped.some(item => item.includes('novelai-pipeline-bridge')));
  assert.ok(dropped.some(item => item.includes('screen')));
  assert.ok(warnings.some(item => item.includes('音色')));
});

test('DEFAULTS 不含任何绝对机器路径或个人标识', () => {
  const text = JSON.stringify(DEFAULTS);
  for (const needle of ['C:/', 'C:\\\\', 'D:/', 'D:\\\\', '/Users/', 'legacy-owner-id', '8139']) {
    assert.equal(text.includes(needle), false, `默认值里出现 ${needle}`);
  }
});

test('帧族解析：V5/4.5/其他 分开', () => {
  assert.equal(presetFamilyFor('nai-diffusion-5-full'), '5');
  assert.equal(presetFamilyFor('nai-diffusion-5-curated'), '5');
  assert.equal(presetFamilyFor('nai-diffusion-4-5-full'), '4.5');
  assert.equal(presetFamilyFor('nai-diffusion-3'), 'other');
  assert.equal(presetFamilyFor(''), 'other');
});
