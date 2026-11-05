import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createMediaService } from '../src/service.mjs';
import { tempDataDir, mockFetch, makePcm, makeWav, writeConfig, makeResponse } from './helpers.mjs';
import { Code } from '../src/errors.mjs';
import { drama3, fishAudio } from '../src/adapters/fish.mjs';
import { createNet } from '../src/net.mjs';

const LIMITS = { requestBudgetMs: 5000, connectTimeoutMs: 2000, maxResponseBytes: 1 << 20, maxImageBytes: 1 << 20, maxAudioBytes: 1 << 20, maxRedirects: 2, maxImagesPerRequest: 1, maxTextChars: 500 };

function ttsConfig(dir, provider, section, extra = {}) {
  writeConfig(dir, {
    schemaVersion: 2,
    tts: {
      enabled: true,
      provider,
      providers: { [provider]: { enabled: true, timeoutMs: 5000, ...section } },
    },
    limits: LIMITS,
    ...extra,
  });
}

test('Breeze：multipart 请求 + audio/pcm 响应封装成 WAV（24 kHz）', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    ttsConfig(dir, 'breeze-tts-2', { baseUrl: 'http://127.0.0.1:7860', instruction: '轻轻说', cfgScale: 4, seed: 7 });
    const pcm = makePcm({ samples: 24_000 });
    const { fetchImpl, calls } = mockFetch([{
      match: 'http://127.0.0.1:7860/v1/audio/speech',
      response: { status: 200, bytes: pcm, headers: { 'content-type': 'audio/pcm', 'x-sample-rate': '24000' }, mime: 'audio/pcm' },
    }]);
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl });
    const result = await service.synthesize({ text: '你好啊' });
    assert.equal(result.ok, true, JSON.stringify(result.error ?? {}));
    assert.equal(result.artifact.mime, 'audio/wav');
    assert.equal(result.handoff.delivered, false);
    const contentType = calls[0].headers['content-type'];
    assert.match(contentType, /multipart\/form-data; boundary=/);
    const bodyBytes = Buffer.from(calls[0].body);
    assert.ok(bodyBytes.includes(Buffer.from('name="text"')), 'multipart 必须带 text 字段');
    assert.ok(bodyBytes.includes(Buffer.from('name="instruction"')), 'multipart 必须带 instruction 字段');
    assert.ok(bodyBytes.includes(Buffer.from('name="cfg_scale"')), 'multipart 必须带 cfg_scale 字段');
    assert.ok(bodyBytes.includes(Buffer.from('轻轻说', 'utf8')), 'UTF-8 表演指令必须原样编码');
    // WAV 头合法
    const bytes = fs.readFileSync(result.artifact.absolutePath);
    assert.equal(bytes.subarray(0, 4).toString('latin1'), 'RIFF');
    assert.ok(result.artifact.durationSeconds > 0.9);
  } finally {
    cleanup();
  }
});

test('Breeze：参考音频与逐字稿只给一个 → 本地就拒绝（不打扰服务端）', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const ref = path.join(dir, 'ref.wav');
    fs.writeFileSync(ref, makeWav());
    ttsConfig(dir, 'breeze-tts-2', { baseUrl: 'http://127.0.0.1:7860', refAudioPath: ref });
    const { fetchImpl, calls } = mockFetch([{ match: () => true, response: { status: 200, bytes: makePcm(), mime: 'audio/pcm' } }]);
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl });
    const result = await service.synthesize({ text: 'x' });
    assert.equal(result.ok, false);
    assert.ok([Code.CONFIG_INVALID, Code.NOT_CONFIGURED, Code.CONFIG_INVALID].includes(result.error.code));
    assert.equal(calls.length, 0);
  } finally {
    cleanup();
  }
});

test('Breeze：409（单并发占用）→ BACKEND_BUSY', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    ttsConfig(dir, 'breeze-tts-2', { baseUrl: 'http://127.0.0.1:7860' });
    const { fetchImpl, calls } = mockFetch([{ match: () => true, response: { status: 409, json: { detail: 'An inference request is already running.' } } }]);
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl });
    const result = await service.synthesize({ text: 'x' });
    assert.equal(result.error.code, Code.BACKEND_BUSY);
    assert.equal(calls.length, 1);
  } finally {
    cleanup();
  }
});

test('GPT-SoVITS：JSON /tts，ref_audio_path 是服务端路径（不上传文件）', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    ttsConfig(dir, 'gpt-sovits', {
      baseUrl: 'http://127.0.0.1:9880',
      refAudioPath: '/srv/refs/speaker.wav',
      promptText: '参考音频的文字',
      promptLang: 'zh',
      textLang: 'zh',
      mediaType: 'wav',
    });
    const wav = makeWav({ samples: 12_000 });
    const { fetchImpl, calls } = mockFetch([{
      match: 'http://127.0.0.1:9880/tts',
      response: { status: 200, bytes: wav, mime: 'audio/wav', headers: { 'content-type': 'audio/wav' } },
    }]);
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl });
    const result = await service.synthesize({ text: '你好' });
    assert.equal(result.ok, true, JSON.stringify(result.error ?? {}));
    const body = JSON.parse(calls[0].body);
    assert.equal(body.ref_audio_path, '/srv/refs/speaker.wav');
    assert.equal(body.text, '你好');
    assert.equal(body.media_type, 'wav');
    assert.equal(body.streaming_mode, false);
    // 没有上传任何二进制
    assert.equal(typeof calls[0].body, 'string');
    assert.equal(result.artifact.mime, 'audio/wav');
  } finally {
    cleanup();
  }
});

test('GPT-SoVITS：media_type=raw 被本地拒绝（没有可靠采样率）', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    ttsConfig(dir, 'gpt-sovits', { baseUrl: 'http://127.0.0.1:9880', refAudioPath: '/srv/a.wav', promptText: 'p', mediaType: 'raw' });
    const { fetchImpl, calls } = mockFetch([{ match: () => true, response: { status: 200, bytes: makeWav(), mime: 'audio/wav' } }]);
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl });
    const result = await service.synthesize({ text: 'x' });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, Code.PARAM_OUT_OF_RANGE);
    assert.equal(calls.length, 0);
  } finally {
    cleanup();
  }
});

test('Fish Audio：header 带 model，body 带 reference_id/format', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    ttsConfig(dir, 'fish-audio', { baseUrl: 'https://api.fish.audio', apiKey: 'fish_test_key_1234567890', referenceId: 'voice-model-1', model: 's2.1-pro', format: 'wav' });
    const { fetchImpl, calls } = mockFetch([{
      match: 'https://api.fish.audio/v1/tts',
      response: { status: 200, bytes: makeWav(), mime: 'audio/wav', headers: { 'content-type': 'audio/wav' } },
    }]);
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl });
    const result = await service.synthesize({ text: 'hello there' });
    assert.equal(result.ok, true, JSON.stringify(result.error ?? {}));
    assert.equal(calls[0].headers.model, 's2.1-pro');
    assert.equal(calls[0].headers.Authorization, 'Bearer fish_test_key_1234567890');
    const body = JSON.parse(calls[0].body);
    assert.equal(body.reference_id, 'voice-model-1');
    assert.equal(body.format, 'wav');
    assert.equal(result.artifact.provider, 'fish-audio');
  } finally {
    cleanup();
  }
});

test('Drama3：reference_id 支持逗号分隔的多说话人数组，模型固定 drama-3', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    ttsConfig(dir, 'drama3', { baseUrl: 'https://api.fish.audio', apiKey: 'fish_test_key_1234567890', referenceId: 'alice, bob', model: 'drama-3' });
    const { fetchImpl, calls } = mockFetch([{
      match: 'https://api.fish.audio/v1/tts',
      response: { status: 200, bytes: makeWav(), mime: 'audio/wav', headers: { 'content-type': 'audio/wav' } },
    }]);
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl });
    const result = await service.synthesize({ text: '<|speaker:0|>Hi<|speaker:1|>Hello' });
    assert.equal(result.ok, true, JSON.stringify(result.error ?? {}));
    assert.equal(calls[0].headers.model, 'drama-3');
    const body = JSON.parse(calls[0].body);
    assert.deepEqual(body.reference_id, ['alice', 'bob']);
    assert.deepEqual(result.artifact.voice, ['alice', 'bob']);
  } finally {
    cleanup();
  }
});

test('Fish Audio：pcm 格式被本地拒绝（缺采样率），不浪费一次计费请求', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    ttsConfig(dir, 'fish-audio', { baseUrl: 'https://api.fish.audio', apiKey: 'k', referenceId: 'v', format: 'pcm' });
    const { fetchImpl, calls } = mockFetch([{
      match: () => true,
      response: { status: 200, bytes: makePcm(), mime: 'audio/pcm', headers: { 'content-type': 'audio/pcm' } },
    }]);
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl });
    const result = await service.synthesize({ text: 'x' });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, Code.UNSUPPORTED_TYPE);
  } finally {
    cleanup();
  }
});

test('Index-TTS：五个适配器里唯一"尚未接入"，返回 PROVIDER_NOT_IMPLEMENTED', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    ttsConfig(dir, 'index-tts', { baseUrl: 'http://127.0.0.1:9999' });
    const { fetchImpl, calls } = mockFetch([{ match: () => true, response: { status: 200, json: {} } }]);
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl });
    const result = await service.synthesize({ text: 'x' });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, Code.PROVIDER_NOT_IMPLEMENTED);
    assert.match(result.error.message, /没有官方 HTTP/);
    assert.equal(calls.length, 0, '未接入的 provider 不得发请求');
    const state = service.status().states.tts.providers.find(item => item.id === 'index-tts');
    assert.equal(state.state, 'not-connected');
  } finally {
    cleanup();
  }
});

test('语音适配器直接调用：fish 与 drama3 的差异只在 model 与多说话人', async () => {
  const net = createNet({ fetchImpl: async (url, init) => {
    assert.match(url, /\/v1\/tts$/);
    // 两个适配器都必须把 model 放在请求头 `model:` 上（Fish Audio 协议）
    assert.ok(init.headers.model === 's2.1-pro' || init.headers.model === 'drama-3');
    JSON.parse(init.body);
    return makeResponse({ status: 200, bytes: makeWav(), mime: 'audio/wav', headers: { 'content-type': 'audio/wav' } });
  } });
  const single = await fishAudio.generate({
    section: { baseUrl: 'https://api.fish.audio', model: 's2.1-pro', referenceId: 'v1', format: 'wav', timeoutMs: 1000 },
    limits: LIMITS, key: 'k', net, text: 'hi',
  });
  assert.equal(single.meta.multiSpeaker, false);
  const dialogue = await drama3.generate({
    section: { baseUrl: 'https://api.fish.audio', model: 'drama-3', referenceId: 'a,b', format: 'wav', timeoutMs: 1000 },
    limits: LIMITS, key: 'k', net, text: 'hi',
  });
  assert.equal(dialogue.meta.multiSpeaker, true);
});

test('TTS 连接测试：Breeze /health 成功即 health 级证据', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    ttsConfig(dir, 'breeze-tts-2', { baseUrl: 'http://127.0.0.1:7860' });
    const { fetchImpl } = mockFetch([{
      match: 'http://127.0.0.1:7860/health',
      response: { status: 200, json: { status: 'ok', sample_rate: 24000 } },
    }]);
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl });
    const result = await service.testProvider({ kind: 'tts', id: 'breeze-tts-2' });
    assert.equal(result.ok, true);
    assert.equal(result.level, 'health');
    assert.match(result.detail, /sample_rate=24000/);
  } finally {
    cleanup();
  }
});

test('TTS 连接测试：Fish Audio /model 401 → 失败并给出可操作提示', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    ttsConfig(dir, 'fish-audio', { baseUrl: 'https://api.fish.audio', apiKey: 'bad', referenceId: 'v' });
    const { fetchImpl } = mockFetch([{ match: () => true, response: { status: 401, json: { message: 'unauthorized' } } }]);
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl });
    const result = await service.testProvider({ kind: 'tts', id: 'fish-audio' });
    assert.equal(result.ok, false);
    assert.equal(result.code, Code.AUTH_FAILED);
  } finally {
    cleanup();
  }
});
