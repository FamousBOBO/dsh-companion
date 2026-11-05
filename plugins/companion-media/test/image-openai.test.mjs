import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createMediaService } from '../src/service.mjs';
import { tempDataDir, mockFetch, makePng, writeConfig } from './helpers.mjs';
import { Code } from '../src/errors.mjs';

const KEY = 'sk-test-openai-0123456789';
const PNG = makePng({ width: 1024, height: 1024 });

function configured(dir, patch = {}) {
  const base = {
    schemaVersion: 2,
    image: {
      enabled: true,
      provider: 'openai',
      openai: { baseUrl: 'https://api.example.test/v1', apiKey: KEY, model: 'gpt-image-test', size: '1024x1024', timeoutMs: 5000 },
    },
    limits: { requestBudgetMs: 5000, connectTimeoutMs: 2000, maxResponseBytes: 1 << 20, maxImageBytes: 1 << 20, maxAudioBytes: 1 << 20, maxRedirects: 2, maxImagesPerRequest: 1, maxTextChars: 500 },
  };
  const merged = { ...base, ...patch };
  writeConfig(dir, merged);
}

test('OpenAI：b64_json 响应 → 落盘 PNG，恰好一次请求，带 Bearer', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    configured(dir);
    const { fetchImpl, calls } = mockFetch([{ match: 'https://api.example.test/v1/images/generations', response: { status: 200, json: { data: [{ b64_json: PNG.toString('base64') }] } } }]);
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl });
    const result = await service.generateImage({ prompt: 'a calm lake at dusk' });
    assert.equal(result.ok, true, JSON.stringify(result.error ?? {}));
    assert.equal(result.provider, 'openai');
    assert.equal(result.artifact.mime, 'image/png');
    assert.equal(result.artifact.width, 1024);
    assert.equal(result.handoff.delivered, false, '生成不等于投递');
    assert.ok(fs.existsSync(result.artifact.absolutePath));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].headers.Authorization, `Bearer ${KEY}`);
    const body = JSON.parse(calls[0].body);
    assert.equal(body.model, 'gpt-image-test');
    assert.equal(body.n, 1);
    // 规范里 response_format 已废弃且 GPT image 总是 base64：不得发送
    assert.equal('response_format' in body, false);
    // prompt 正文不得进账本
    const ledgerText = fs.readFileSync(service.ledger.file, 'utf8');
    assert.equal(ledgerText.includes('a calm lake at dusk'), false);
  } finally {
    cleanup();
  }
});

test('OpenAI：url 响应 → 经有界下载取回图片', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    configured(dir);
    const { fetchImpl, calls } = mockFetch([
      { match: 'https://api.example.test/v1/images/generations', response: { status: 200, json: { data: [{ url: 'https://cdn.example.test/a.png' }] } } },
      { match: 'https://cdn.example.test/a.png', response: { status: 200, bytes: PNG, mime: 'image/png' } },
    ]);
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl });
    const result = await service.generateImage({ prompt: 'x' });
    assert.equal(result.ok, true, JSON.stringify(result.error ?? {}));
    assert.equal(calls.length, 2);
    assert.equal(result.artifact.mime, 'image/png');
  } finally {
    cleanup();
  }
});

test('OpenAI：401 → AUTH_FAILED，且绝不自动重试', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    configured(dir);
    const { fetchImpl, calls } = mockFetch([{ match: () => true, response: { status: 401, json: { error: { message: `bad key ${KEY}` } } } }]);
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl });
    const result = await service.generateImage({ prompt: 'x' });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, Code.AUTH_FAILED);
    assert.equal(result.retried, false);
    assert.equal(calls.length, 1, '失败后不得重试（避免重复扣费）');
    assert.equal(JSON.stringify(result).includes(KEY), false, '错误里不得出现密钥');
    const job = service.ledger.listJobs(1)[0];
    assert.equal(job.state, 'failed');
    assert.equal(job.error.code, Code.AUTH_FAILED);
  } finally {
    cleanup();
  }
});

test('OpenAI：429 限流 → RATE_LIMITED（附 Retry-After），单次请求', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    configured(dir);
    const { fetchImpl, calls } = mockFetch([{ match: () => true, response: { status: 429, json: {}, headers: { 'retry-after': '12' } } }]);
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl });
    const result = await service.generateImage({ prompt: 'x' });
    assert.equal(result.error.code, Code.RATE_LIMITED);
    assert.match(result.error.message, /Retry-After: 12/);
    assert.equal(calls.length, 1);
  } finally {
    cleanup();
  }
});

test('OpenAI：把 HTML 错误页当图片返回 → UNSUPPORTED_TYPE（不落盘）', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    configured(dir);
    const html = Buffer.from('<html>gateway error</html>', 'utf8');
    const { fetchImpl } = mockFetch([{ match: () => true, response: { status: 200, bytes: html, mime: 'text/html', headers: { 'content-type': 'text/html' } } }]);
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl });
    const result = await service.generateImage({ prompt: 'x' });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, Code.UNSUPPORTED_TYPE);
    const artifacts = service.ledger.listArtifacts(5);
    assert.equal(artifacts.length, 0);
  } finally {
    cleanup();
  }
});

test('OpenAI：响应体超过上限 → TOO_LARGE', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    configured(dir, {
      limits: { requestBudgetMs: 5000, connectTimeoutMs: 2000, maxResponseBytes: 64, maxImageBytes: 64, maxAudioBytes: 64, maxRedirects: 2, maxImagesPerRequest: 1, maxTextChars: 100 },
    });
    const { fetchImpl } = mockFetch([{ match: () => true, response: { status: 200, json: { data: [{ b64_json: PNG.toString('base64') }] } } }]);
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl });
    const result = await service.generateImage({ prompt: 'x' });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, Code.TOO_LARGE);
  } finally {
    cleanup();
  }
});

test('OpenAI：dryRun 只校验参数，不发请求', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    configured(dir);
    const { fetchImpl, calls } = mockFetch([{ match: () => true, response: { status: 200, json: {} } }]);
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl });
    const result = await service.generateImage({ prompt: 'x', dryRun: true });
    assert.equal(result.ok, true);
    assert.equal(result.dryRun, true);
    assert.equal(calls.length, 0);
  } finally {
    cleanup();
  }
});

test('配置非法（缺 model）时不会调用远端', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    configured(dir, {
      image: { enabled: true, provider: 'openai', openai: { baseUrl: 'https://api.example.test/v1', apiKey: KEY, model: '' } },
    });
    const { fetchImpl, calls } = mockFetch([{ match: () => true, response: { status: 200, json: {} } }]);
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl });
    const result = await service.generateImage({ prompt: 'x' });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, Code.NOT_CONFIGURED);
    assert.equal(calls.length, 0);
  } finally {
    cleanup();
  }
});

test('连接测试：/models 成功 = metadata 级证据；401 = 失败；不生成图片', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    configured(dir);
    const okFetch = mockFetch([{ match: 'https://api.example.test/v1/models', response: { status: 200, json: { data: [{ id: 'gpt-image-test' }] } } }]);
    const okService = createMediaService({ dataDir: dir, env: {}, fetchImpl: okFetch.fetchImpl });
    const ok = await okService.testProvider({ kind: 'image', id: 'openai' });
    assert.equal(ok.ok, true);
    assert.equal(ok.level, 'metadata');
    assert.deepEqual(ok.models, ['gpt-image-test']);
    assert.equal(ok.states.image.providers.find(item => item.id === 'openai').state, 'test-ok');

    const badFetch = mockFetch([{ match: () => true, response: { status: 401, json: {} } }]);
    const badService = createMediaService({ dataDir: dir, env: {}, fetchImpl: badFetch.fetchImpl });
    const bad = await badService.testProvider({ kind: 'image', id: 'openai' });
    assert.equal(bad.ok, false);
    assert.equal(bad.states.image.providers.find(item => item.id === 'openai').state, 'test-failed');
  } finally {
    cleanup();
  }
});
