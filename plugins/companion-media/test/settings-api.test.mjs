import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createMediaService } from '../src/service.mjs';
import { createMediaHandlers, API_PREFIX } from '../src/http-api.mjs';
import { mediaPageDescriptor } from '../src/ui-page.mjs';
import { tempDataDir, writeConfig, makePng, mockFetch } from './helpers.mjs';
import { Code } from '../src/errors.mjs';

/**
 * API-level tests for the settings page backend.
 *
 * They drive `createMediaHandlers(service)` directly (no host required) and, for
 * connectivity, start a **loopback HTTP server** so the real transport
 * (`src/net.mjs`) is exercised end to end. Two things are asserted separately
 * everywhere, because they answer different questions:
 *   - HTTP status  → was the request acceptable;
 *   - body `ok`    → did the operation succeed.
 */

const KEY = 'sk-settings-0123456789abcdef';
const PNG = makePng();

const BASE_LIMITS = {
  requestBudgetMs: 5000,
  connectTimeoutMs: 400,
  maxResponseBytes: 1 << 20,
  maxImageBytes: 1 << 20,
  maxAudioBytes: 1 << 20,
  maxRedirects: 2,
  maxImagesPerRequest: 1,
  maxTextChars: 500,
};

function jsonRequest(pathname, { method = 'GET', body = null, headers = {} } = {}) {
  return new Request(`http://127.0.0.1:1234${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function imageConfig(extra = {}) {
  return {
    schemaVersion: 2,
    image: {
      enabled: true,
      provider: 'openai-compatible',
      'openai-compatible': { baseUrl: 'https://api.example.test/v1', apiKey: KEY, model: 'm', timeoutMs: 2000 },
    },
    limits: BASE_LIMITS,
    ...extra,
  };
}

function setup(dir, { config = null, fetchImpl } = {}) {
  if (config) writeConfig(dir, config);
  const service = createMediaService({
    dataDir: dir,
    env: {},
    fetchImpl: fetchImpl ?? mockFetch([{ match: () => true, response: { status: 200, json: {} } }]).fetchImpl,
  });
  return { service, handlers: createMediaHandlers(service) };
}

// ───────────────────────────── 密钥只写 ─────────────────────────────

test('GET /config 与 GET /status 都不含密钥明文（深度扫描整个响应体）', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const { handlers } = setup(dir, {
      config: imageConfig({
        tts: {
          enabled: false,
          provider: 'none',
          providers: { 'fish-audio': { apiKey: 'fish_plain_secret_value_1', baseUrl: 'https://api.fish.audio' } },
        },
      }),
    });
    for (const route of ['config', 'status', 'page']) {
      const response = await handlers[`GET ${API_PREFIX}/${route}`](jsonRequest(`${API_PREFIX}/${route}`));
      assert.equal(response.status, 200, `${route} 应当 200`);
      const text = await response.text();
      assert.equal(text.includes(KEY), false, `${route} 响应里出现了明文密钥`);
      assert.equal(text.includes('fish_plain_secret_value_1'), false, `${route} 响应里出现了明文密钥`);
    }
    const payload = await (await handlers[`GET ${API_PREFIX}/config`](jsonRequest(`${API_PREFIX}/config`))).json();
    assert.equal(payload.config.image['openai-compatible'].apiKey.configured, true);
    assert.equal(typeof payload.config.image['openai-compatible'].apiKey.mask, 'string');
  } finally {
    cleanup();
  }
});

// ───────────────────────────── 保存语义 ─────────────────────────────

test('POST /config：空字符串/掩码 = 保留；null 与 {clear:true} = 显式清除', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const { service, handlers } = setup(dir, { config: imageConfig() });
    const save = body => handlers[`POST ${API_PREFIX}/config`](jsonRequest(`${API_PREFIX}/config`, { method: 'POST', body }));
    const secret = () => service.store.secret('openai-compatible').value;

    assert.equal(secret(), KEY);

    // 空字符串：保留
    let response = await save({ patch: { image: { 'openai-compatible': { apiKey: '' } } } });
    assert.equal(response.status, 200);
    assert.equal(secret(), KEY, '空字符串必须保留原密钥');

    // 掩码对象回传：保留
    const masked = (await (await handlers[`GET ${API_PREFIX}/config`](jsonRequest(`${API_PREFIX}/config`))).json()).config.image['openai-compatible'].apiKey;
    response = await save({ patch: { image: { 'openai-compatible': { apiKey: masked } } } });
    assert.equal(response.status, 200);
    assert.equal(secret(), KEY, '掩码回传必须保留原密钥');

    // 能力开着时清空"必填密钥"会被校验挡住：这是有意的（否则会静默变成不可用）
    response = await save({ patch: { image: { 'openai-compatible': { apiKey: { clear: true } } } } });
    assert.equal(response.status, 400);
    assert.equal(secret(), KEY, '校验失败不得改动已存密钥');
    const blocked = await response.json();
    assert.ok(blocked.errors.some(item => item.path === 'image.openai-compatible.apiKey'));

    // 显式关掉能力后，清除就是合法动作
    response = await save({ patch: { image: { enabled: false, 'openai-compatible': { apiKey: { clear: true } } } } });
    assert.equal(response.status, 200, JSON.stringify((await response.clone().json()).errors ?? []));
    assert.equal(secret(), '', '{clear:true} 必须清除');

    // 重新写入，再用 null 清除（同样先关能力）
    await save({ patch: { image: { 'openai-compatible': { apiKey: KEY } } } });
    assert.equal(secret(), KEY);
    response = await save({ patch: { image: { enabled: false, 'openai-compatible': { apiKey: null } } } });
    assert.equal(response.status, 200);
    assert.equal(secret(), '', 'null 必须清除');
  } finally {
    cleanup();
  }
});

test('POST /config 校验失败：HTTP 400、逐字段错误、错误里不含密钥', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const { service, handlers } = setup(dir, { config: imageConfig() });
    const response = await handlers[`POST ${API_PREFIX}/config`](jsonRequest(`${API_PREFIX}/config`, {
      method: 'POST',
      body: { patch: { image: { 'openai-compatible': { model: '', apiKey: KEY } } } },
    }));
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.equal(payload.ok, false);
    assert.equal(payload.saved, false);
    assert.ok(payload.errors.some(item => item.path === 'image.openai-compatible.model'));
    assert.equal(JSON.stringify(payload).includes(KEY), false, '错误信息不得回显密钥');
    assert.equal(service.store.secret('openai-compatible').value, KEY, '校验失败不得改动已存密钥');
  } finally {
    cleanup();
  }
});

// ───────────────────────────── provider 状态 ─────────────────────────────

test('五个 TTS provider 各自独立状态；Index-TTS = not-connected 且禁止启用', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const { service, handlers } = setup(dir, {
      config: {
        schemaVersion: 2,
        tts: {
          enabled: true,
          provider: 'breeze-tts2',
          providers: {
            'breeze-tts2': { enabled: true, baseUrl: 'http://127.0.0.1:7860', timeoutMs: 2000 },
            'gpt-sovits': { enabled: false, baseUrl: '' },
            drama3: { enabled: false },
            'index-tts': { enabled: false },
            'fish-audio': { enabled: false },
          },
        },
        limits: BASE_LIMITS,
      },
    });
    const status = service.status();
    const ids = status.states.tts.providers.map(item => item.id);
    assert.deepEqual(ids.sort(), ['breeze-tts2', 'drama3', 'fish-audio', 'gpt-sovits', 'index-tts']);
    const indexTts = status.states.tts.providers.find(item => item.id === 'index-tts');
    assert.equal(indexTts.state, 'not-connected');
    assert.match(indexTts.reason, /bilibili Model Use License Agreement/);
    // 每个 provider 都有独立配置区 + 独立开关（descriptor）
    const descriptor = mediaPageDescriptor(status);
    const tts = descriptor.sections.find(item => item.id === 'tts');
    assert.equal(tts.providers.length, 5);
    for (const provider of tts.providers) {
      assert.ok(provider.fields.some(field => field.path.endsWith('.enabled')), `${provider.id} 缺少独立开关`);
      assert.equal(provider.canEnable, provider.status === 'connected', `${provider.id} canEnable 与能力表不一致`);
    }
    assert.equal(tts.providers.find(item => item.id === 'index-tts').canEnable, false);

    // 试图启用 Index-TTS → 400，且不落盘
    const response = await handlers[`POST ${API_PREFIX}/config`](jsonRequest(`${API_PREFIX}/config`, {
      method: 'POST',
      body: { patch: { tts: { provider: 'index-tts', providers: { 'index-tts': { enabled: true } } } } },
    }));
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.ok(payload.errors.some(item => item.code === Code.PROVIDER_NOT_IMPLEMENTED));
    assert.notEqual(service.store.load().config.tts.provider, 'index-tts');
  } finally {
    cleanup();
  }
});

test('识图恒为 reserved-disabled，且保存不能打开', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const { service, handlers } = setup(dir);
    const response = await handlers[`POST ${API_PREFIX}/config`](jsonRequest(`${API_PREFIX}/config`, {
      method: 'POST',
      body: { patch: { vision: { enabled: true, model: 'x' } } },
    }));
    const payload = await response.json();
    // enabled 被强制拉回 false，因此保存本身成功，但读回仍是关闭
    assert.equal(payload.config.vision.enabled, false);
    assert.equal(service.status().states.vision.status, 'reserved-disabled');
    assert.equal(service.store.load().config.vision.enabled, false);
  } finally {
    cleanup();
  }
});

// ───────────────────────────── 生图两家 ─────────────────────────────

test('OpenAI 与 NAI 配置互不覆盖；NAI 官方/中转分别校验', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const { service, handlers } = setup(dir);
    const save = patch => handlers[`POST ${API_PREFIX}/config`](jsonRequest(`${API_PREFIX}/config`, { method: 'POST', body: { patch } }));

    // 先写 OpenAI
    let response = await save({ image: { enabled: true, provider: 'openai-compatible', 'openai-compatible': { baseUrl: 'https://api.example.test/v1', apiKey: KEY, model: 'm' } } });
    assert.equal(response.status, 200);
    // 再写 NAI：OpenAI 的字段必须保留
    response = await save({
      image: {
        provider: 'nai',
        nai: { transport: 'official', baseUrl: 'https://image.novelai.net', apiKey: 'nai-token-placeholder', model: 'nai-diffusion-5-full' },
      },
    });
    assert.equal(response.status, 200, JSON.stringify((await response.clone().json()).errors ?? []));
    const config = service.store.load().config;
    assert.equal(config.image['openai-compatible'].baseUrl, 'https://api.example.test/v1');
    assert.equal(config.image['openai-compatible'].model, 'm');
    assert.equal(config.image.nai.model, 'nai-diffusion-5-full');

    // 官方 transport + 中转形态的 Base URL → 400
    response = await save({ image: { nai: { transport: 'official', baseUrl: 'https://relay.example.test/v1' } } });
    assert.equal(response.status, 400);
    assert.ok((await response.json()).errors.some(item => item.path === 'image.nai.baseUrl'));

    // 中转 transport + 官方 Base URL → 400
    response = await save({ image: { nai: { transport: 'openai-relay', baseUrl: 'https://image.novelai.net' } } });
    assert.equal(response.status, 400);
    assert.ok((await response.json()).errors.some(item => item.path === 'image.nai.baseUrl'));

    // 中转 transport 缺 Base URL → 400
    response = await save({ image: { nai: { transport: 'openai-relay', baseUrl: '' } } });
    assert.equal(response.status, 400);

    // 中转 transport + 中转 Base URL → 200
    response = await save({ image: { nai: { transport: 'openai-relay', baseUrl: 'https://relay.example.test' } } });
    assert.equal(response.status, 200);
  } finally {
    cleanup();
  }
});

test('V5 与 4.5 预设分开存储、画师串独立、步数默认 28、预览可复现', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const { service, handlers } = setup(dir, { config: { schemaVersion: 2, limits: BASE_LIMITS } });
    const save = patch => handlers[`POST ${API_PREFIX}/config`](jsonRequest(`${API_PREFIX}/config`, { method: 'POST', body: { patch } }));
    const response = await save({
      image: {
        enabled: false,
        nai: {
          artistString: 'artist-a, artist-b',
          presets: {
            '5': { applyDefaults: true, positive: 'v5-pos', negative: 'v5-neg' },
            '4.5': { applyDefaults: false, positive: 'v45-pos', negative: 'v45-neg' },
          },
        },
      },
    });
    assert.equal(response.status, 200);
    const config = service.store.load().config;
    assert.equal(config.image.nai.steps, 28, '步数默认 28');
    assert.equal(config.image.nai.artistString, 'artist-a, artist-b');
    assert.equal(config.image.nai.presets['5'].positive, 'v5-pos');
    assert.equal(config.image.nai.presets['4.5'].positive, 'v45-pos');
    assert.equal(config.image.nai.presets['5'].applyDefaults, true);
    assert.equal(config.image.nai.presets['4.5'].applyDefaults, false);

    // 清空是合法动作
    await save({ image: { nai: { artistString: '', presets: { '5': { positive: '', negative: '', applyDefaults: false } } } } });
    const cleared = service.store.load().config;
    assert.equal(cleared.image.nai.artistString, '');
    assert.equal(cleared.image.nai.presets['5'].positive, '');
    assert.equal(cleared.image.nai.presets['4.5'].positive, 'v45-pos', '清空 V5 不得影响 4.5');

    // 预览可复现：同输入同输出，且对齐 64
    const previewOnce = async () => (await handlers[`GET ${API_PREFIX}/preview`](jsonRequest(`${API_PREFIX}/preview?mode=auto&aspect=portrait&targetPixels=1011712`))).json();
    const first = await previewOnce();
    const second = await previewOnce();
    assert.equal(first.resolution.ok, true);
    assert.equal(first.resolution.size, second.resolution.size);
    assert.equal(first.resolution.width % 64, 0);
    assert.equal(first.resolution.height % 64, 0);

    // 越界明确报错（不静默改值）
    const outOfRange = await (await handlers[`GET ${API_PREFIX}/preview`](jsonRequest(`${API_PREFIX}/preview?mode=fixed&size=800x800`))).json();
    assert.equal(outOfRange.resolution.ok, false);
    assert.match(outOfRange.resolution.error.message, /multiple of 64/);
  } finally {
    cleanup();
  }
});

test('画师串与预设真正进入 NAI 请求体（dry-run 可核对，无需花钱）', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const { service } = setup(dir, {
      config: {
        schemaVersion: 2,
        image: {
          enabled: true,
          provider: 'nai',
          nai: {
            transport: 'official',
            baseUrl: 'https://image.novelai.net',
            apiKey: 'nai-placeholder-token',
            model: 'nai-diffusion-4-5-full',
            artistString: 'artist-a, artist-b',
            presets: { '4.5': { applyDefaults: true, positive: 'v45-pos', negative: 'v45-neg' }, '5': { applyDefaults: true, positive: 'v5-pos' } },
          },
        },
        limits: BASE_LIMITS,
      },
    });
    const dry = await service.generateImage({ prompt: 'a lighthouse', dryRun: true });
    assert.equal(dry.ok, true);
    assert.equal(dry.preset.family, '4.5');
    assert.equal(dry.preset.positive, 'artist-a, artist-b, a lighthouse');
    assert.equal(dry.preset.negative, 'v45-neg');
    assert.equal(dry.preset.positive.includes('v5-pos'), false, '不得串用 V5 预设');
  } finally {
    cleanup();
  }
});

test('页面加载不触发任何 /test：GET config/status/page/jobs/preview 零网络请求', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const { fetchImpl, calls } = mockFetch([{ match: () => true, response: { status: 200, json: {} } }]);
    const { handlers } = setup(dir, { config: imageConfig(), fetchImpl });
    const readRoutes = ['config', 'status', 'page', 'jobs'];
    for (const route of readRoutes) {
      const response = await handlers[`GET ${API_PREFIX}/${route}`](jsonRequest(`${API_PREFIX}/${route}`));
      assert.equal(response.status, 200, `${route} 应当 200`);
    }
    const preview = await handlers[`GET ${API_PREFIX}/preview`](jsonRequest(`${API_PREFIX}/preview?mode=fixed&size=832x1216`));
    assert.equal(preview.status, 200);
    assert.equal(calls.length, 0, '页面/配置读取不得发起任何外部请求（更不得计费）');
    const descriptor = mediaPageDescriptor(setup(dir, { config: imageConfig() }).service.status());
    assert.equal(descriptor.meta.testPolicy, 'explicit-only');
  } finally {
    cleanup();
  }
});

test('/test：未知 provider 是 400；provider 自身失败是 200 + ok:false + 错误码', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const { fetchImpl } = mockFetch([{ match: () => true, response: { status: 401, json: { error: 'nope' } } }]);
    const { handlers } = setup(dir, { config: imageConfig(), fetchImpl });

    const unknown = await handlers[`POST ${API_PREFIX}/test`](jsonRequest(`${API_PREFIX}/test`, { method: 'POST', body: { kind: 'image', id: 'not-a-provider' } }));
    assert.equal(unknown.status, 400);
    assert.equal((await unknown.json()).error.code, Code.PROVIDER_UNKNOWN);

    const unauthorized = await handlers[`POST ${API_PREFIX}/test`](jsonRequest(`${API_PREFIX}/test`, { method: 'POST', body: { kind: 'image', id: 'openai-compatible' } }));
    assert.equal(unauthorized.status, 200, '动作本身成功');
    const payload = await unauthorized.json();
    assert.equal(payload.ok, false, '但 provider 结果失败');
    assert.equal(payload.code, Code.AUTH_FAILED);
    assert.equal(JSON.stringify(payload).includes(KEY), false, '测试结果不得回显密钥');
  } finally {
    cleanup();
  }
});

// ───────────────────────────── loopback 联通 ─────────────────────────────

/** 一个只讲"错误与服务"的最小 HTTP 服务：五种情形各一条路径。 */
function startLoopbackServer() {
  const server = http.createServer((req, res) => {
    const url = String(req.url ?? '');
    if (url.startsWith('/ok/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'loopback-model' }] }));
      return;
    }
    if (url.startsWith('/unauth/models')) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `bad key ${KEY}` } }));
      return;
    }
    if (url.startsWith('/rate/models')) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7' });
      res.end(JSON.stringify({ error: 'slow down' }));
      return;
    }
    if (url.startsWith('/boom/models')) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'upstream exploded' }));
      return;
    }
    if (url.startsWith('/slow/models')) {
      // 永不响应：用来验证 deadline（客户端必须自己放弃并报 TIMEOUT）
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'no route' }));
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, base: `http://127.0.0.1:${port}` });
    });
  });
}

test('loopback 联通：真实 HTTP 走通 /v1/models，并覆盖 401 / 429 / 500 / 超时', async () => {
  const { dir, cleanup } = tempDataDir();
  const loopback = await startLoopbackServer();
  try {
    const cases = [
      { path: 'ok', expectOk: true, expectCode: null, level: 'metadata' },
      { path: 'unauth', expectOk: false, expectCode: Code.AUTH_FAILED },
      { path: 'rate', expectOk: false, expectCode: Code.RATE_LIMITED },
      { path: 'boom', expectOk: false, expectCode: Code.UPSTREAM },
      { path: 'slow', expectOk: false, expectCode: Code.TIMEOUT },
    ];
    for (const item of cases) {
      writeConfig(dir, {
        schemaVersion: 2,
        image: {
          enabled: true,
          provider: 'openai-compatible',
          'openai-compatible': { baseUrl: `${loopback.base}/${item.path}`, apiKey: KEY, model: 'm', timeoutMs: 400 },
        },
        limits: { ...BASE_LIMITS, connectTimeoutMs: 400 },
      });
      // 用真实 fetch（默认），只把超时压小；服务器在 127.0.0.1
      const service = createMediaService({ dataDir: dir, env: {} });
      const handlers = createMediaHandlers(service);
      const response = await handlers[`POST ${API_PREFIX}/test`](jsonRequest(`${API_PREFIX}/test`, { method: 'POST', body: { kind: 'image', id: 'openai-compatible' } }));
      assert.equal(response.status, 200, `${item.path}: 请求本身有效`);
      const payload = await response.json();
      assert.equal(payload.ok, item.expectOk, `${item.path}: body.ok`);
      if (item.expectCode) assert.equal(payload.code, item.expectCode, `${item.path}: 错误码`);
      if (item.level) assert.equal(payload.level, item.level, `${item.path}: 证据等级`);
      assert.equal(JSON.stringify(payload).includes(KEY), false, `${item.path}: 不得回显密钥`);
      // 状态口径跟着变：test-ok / test-failed
      const state = payload.states.image.providers.find(provider => provider.id === 'openai-compatible').state;
      assert.equal(state, item.expectOk ? 'test-ok' : 'test-failed', `${item.path}: 状态口径`);
    }
  } finally {
    await new Promise(resolve => loopback.server.close(resolve));
    cleanup();
  }
});

test('loopback 联通：生成路径也走真实 HTTP（图片字节经真实 fetch 落盘）', async () => {
  const { dir, cleanup } = tempDataDir();
  const server = http.createServer((req, res) => {
    if (String(req.url).startsWith('/v1/images/generations')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    writeConfig(dir, imageConfig({
      image: {
        enabled: true,
        provider: 'openai-compatible',
        'openai-compatible': { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: KEY, model: 'm', timeoutMs: 3000 },
      },
    }));
    const service = createMediaService({ dataDir: dir, env: {} });
    const handlers = createMediaHandlers(service);
    const response = await handlers[`POST ${API_PREFIX}/image`](jsonRequest(`${API_PREFIX}/image`, { method: 'POST', body: { prompt: 'loopback image', confirm: true } }));
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true, JSON.stringify(payload.error ?? {}));
    assert.equal(payload.artifact.mime, 'image/png');
    assert.equal(payload.handoff.delivered, false);
    assert.ok(fs.existsSync(payload.artifact.absolutePath));
    assert.equal(payload.artifact.absolutePath.startsWith(path.join(dir, 'workspace', 'media')), true);
  } finally {
    await new Promise(resolve => server.close(resolve));
    cleanup();
  }
});

// ───────────────────────────── 页面描述符 ─────────────────────────────

test('页面描述符带当前值（密钥只有掩码）、端点和 canTest/canEnable', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const { service } = setup(dir, { config: imageConfig() });
    const descriptor = mediaPageDescriptor(service.status());
    const image = descriptor.sections.find(item => item.id === 'image');
    const provider = image.providers.find(item => item.id === 'openai-compatible');
    assert.equal(provider.canTest, true);
    assert.equal(provider.canEnable, true);
    const baseUrl = provider.fields.find(field => field.pathParts.at(-1) === 'baseUrl');
    assert.equal(baseUrl.value, 'https://api.example.test/v1');
    assert.deepEqual(baseUrl.pathParts, ['image', 'openai-compatible', 'baseUrl']);
    const apiKey = provider.fields.find(field => field.pathParts.at(-1) === 'apiKey');
    assert.equal(apiKey.type, 'secret');
    assert.equal(apiKey.value.configured, true);
    assert.equal(JSON.stringify(descriptor).includes(KEY), false);
    assert.equal(descriptor.api.save, 'POST /api/companion-media/config');
    assert.equal(image.preview.endpoint, 'GET /api/companion-media/preview');
    assert.equal(image.presets.artistString.path, 'image.nai.artistString');
  } finally {
    cleanup();
  }
});

// ───────────────────────────── 描述符可渲染性（Studio 反馈的两个缺口） ─────────────────────────────

test('生图 provider 不发 enabled 字段（启停走总开关 + selector）；TTS 每个后端保留独立开关', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const { service } = setup(dir, { config: imageConfig() });
    const descriptor = mediaPageDescriptor(service.status());
    const image = descriptor.sections.find(item => item.id === 'image');
    for (const provider of image.providers) {
      const enabledField = provider.fields.find(field => field.pathParts.at(-1) === 'enabled');
      assert.equal(enabledField, undefined, `生图 provider ${provider.id} 不应有 enabled 字段（没有可写键）`);
      assert.equal(image.toggle.path, 'image.enabled');
      assert.equal(image.selector.path, 'image.provider');
    }
    const tts = descriptor.sections.find(item => item.id === 'tts');
    for (const provider of tts.providers) {
      const enabledField = provider.fields.find(field => field.pathParts.at(-1) === 'enabled');
      assert.ok(enabledField, `TTS provider ${provider.id} 必须有独立开关`);
      assert.deepEqual(enabledField.pathParts, ['tts', 'providers', provider.id, 'enabled']);
      assert.equal(enabledField.type, 'boolean');
    }
  } finally {
    cleanup();
  }
});

test('每个 select 字段都带 options（{value,label} 非空），不存在无选项的下拉', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const { service } = setup(dir, {
      config: {
        schemaVersion: 2,
        image: {
          enabled: false,
          provider: 'nai',
          nai: { transport: 'official', baseUrl: 'https://image.novelai.net', model: 'nai-diffusion-4-5-full' },
        },
        tts: {
          enabled: false,
          provider: 'gpt-sovits',
          providers: {
            'gpt-sovits': { enabled: false, baseUrl: 'http://127.0.0.1:9880' },
            'fish-audio': { enabled: false },
            drama3: { enabled: false },
          },
        },
        limits: BASE_LIMITS,
      },
    });
    const descriptor = mediaPageDescriptor(service.status());
    const allFields = descriptor.sections.flatMap(section => [
      ...(section.fields ?? []),
      ...(section.providers ?? []).flatMap(provider => provider.fields ?? []),
    ]);
    const selects = allFields.filter(field => field.type === 'select');
    assert.ok(selects.length >= 6, `select 字段太少：${selects.length}`);
    for (const field of selects) {
      assert.ok(Array.isArray(field.options) && field.options.length > 0, `${field.path} 是 select 但没有 options`);
      for (const option of field.options) {
        assert.equal(typeof option.value, 'string');
        assert.equal(typeof option.label, 'string');
        assert.ok(option.label.length > 0);
      }
    }
    const nai = descriptor.sections.find(item => item.id === 'image').providers.find(item => item.id === 'nai');
    const transport = nai.fields.find(field => field.pathParts.at(-1) === 'transport');
    assert.deepEqual(transport.options.map(item => item.value), ['official', 'openai-relay']);
    const fish = descriptor.sections.find(item => item.id === 'tts').providers.find(item => item.id === 'fish-audio');
    const format = fish.fields.find(field => field.pathParts.at(-1) === 'format');
    assert.deepEqual(format.options.map(item => item.value), ['wav', 'pcm', 'mp3', 'opus']);
  } finally {
    cleanup();
  }
});

// ───────────────────────────── 描述符字段完整性（UI 审核反馈） ─────────────────────────────

/** 按 pathParts 写值，模拟客户端"填表 → 保存"。 */
function patchFromPathParts(pathParts, value) {
  const root = {};
  let cursor = root;
  for (let i = 0; i < pathParts.length - 1; i += 1) {
    cursor[pathParts[i]] = {};
    cursor = cursor[pathParts[i]];
  }
  cursor[pathParts[pathParts.length - 1]] = value;
  return root;
}

function mergeDeep(target, source) {
  for (const [key, value] of Object.entries(source ?? {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      target[key] = mergeDeep(target[key] && typeof target[key] === 'object' ? target[key] : {}, value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

test('NAI 两族预设各发三个字段（positive/negative/applyDefaults），且 pathParts 能拼出真实键', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const { service, handlers } = setup(dir, { config: { schemaVersion: 2, limits: BASE_LIMITS } });
    const descriptor = mediaPageDescriptor(service.status());
    const image = descriptor.sections.find(item => item.id === 'image');

    assert.deepEqual(image.presets.families.map(item => item.family), ['5', '4.5']);
    for (const family of image.presets.families) {
      const byName = Object.fromEntries(family.fields.map(item => [item.pathParts.at(-1), item]));
      assert.deepEqual(Object.keys(byName).sort(), ['applyDefaults', 'negative', 'positive'], `${family.family} 字段不全`);
      assert.deepEqual(byName.positive.pathParts, ['image', 'nai', 'presets', family.family, 'positive']);
      assert.deepEqual(byName.negative.pathParts, ['image', 'nai', 'presets', family.family, 'negative']);
      assert.deepEqual(byName.applyDefaults.pathParts, ['image', 'nai', 'presets', family.family, 'applyDefaults']);
      assert.equal(byName.positive.type, 'textarea');
      assert.equal(byName.negative.type, 'textarea', '反向预设必须是多行输入');
      assert.equal(byName.applyDefaults.type, 'boolean', '启用整族预设需要开关');
      assert.match(byName.applyDefaults.label, /应用这一族的反向预设/);
      // 默认留空、默认不启用（不编造官方文本）
      assert.equal(byName.positive.value, '');
      assert.equal(byName.negative.value, '');
      assert.equal(byName.applyDefaults.value, false);
    }

    // 用 pathParts 拼 patch 保存 → 真的写进各自的族，互不串用
    const families = image.presets.families;
    const build = (family, text, apply) => family.fields.reduce((acc, item) => {
      const name = item.pathParts.at(-1);
      return mergeDeep(acc, patchFromPathParts(item.pathParts, name === 'applyDefaults' ? apply : text));
    }, {});
    const saved = await handlers[`POST ${API_PREFIX}/config`](jsonRequest(`${API_PREFIX}/config`, {
      method: 'POST',
      body: { patch: mergeDeep(build(families[0], 'v5-text', true), build(families[1], 'v45-text', false)) },
    }));
    assert.equal(saved.status, 200, JSON.stringify((await saved.clone().json()).errors ?? []));

    const config = service.store.load().config;
    assert.deepEqual(config.image.nai.presets['5'], { applyDefaults: true, positive: 'v5-text', negative: 'v5-text' });
    assert.deepEqual(config.image.nai.presets['4.5'], { applyDefaults: false, positive: 'v45-text', negative: 'v45-text' });

    // 只改一族不影响另一族
    await handlers[`POST ${API_PREFIX}/config`](jsonRequest(`${API_PREFIX}/config`, {
      method: 'POST',
      body: { patch: { image: { nai: { presets: { '5': { positive: 'only-v5' } } } } } },
    }));
    const after = service.store.load().config;
    assert.equal(after.image.nai.presets['5'].positive, 'only-v5');
    assert.equal(after.image.nai.presets['4.5'].positive, 'v45-text', '改 V5 不得动 4.5');
  } finally {
    cleanup();
  }
});

test('timeoutMs 出现在每个可配置 provider 的字段里（OpenAI-compatible 不再缺超时）', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const { service } = setup(dir, { config: { schemaVersion: 2, limits: BASE_LIMITS } });
    const descriptor = mediaPageDescriptor(service.status());

    const image = descriptor.sections.find(item => item.id === 'image');
    const tts = descriptor.sections.find(item => item.id === 'tts');
    const vision = descriptor.sections.find(item => item.id === 'vision');

    const targets = [
      ...image.providers.map(provider => ({ kind: 'image', provider })),
      ...tts.providers.map(provider => ({ kind: 'tts', provider })),
    ];
    for (const { kind, provider } of targets) {
      const timeout = provider.fields.find(item => item.pathParts.at(-1) === 'timeoutMs');
      assert.ok(timeout, `${kind}/${provider.id} 缺少 timeoutMs 字段`);
      assert.equal(timeout.type, 'number');
      assert.match(timeout.label, /毫秒/);
      assert.match(timeout.label, /1000–600000/);
      assert.equal(typeof timeout.value, 'number');
      const expected = kind === 'image'
        ? ['image', provider.id, 'timeoutMs']
        : ['tts', 'providers', provider.id, 'timeoutMs'];
      assert.deepEqual(timeout.pathParts, expected);
    }

    const visionTimeout = vision.fields.find(item => item.pathParts.at(-1) === 'timeoutMs');
    assert.ok(visionTimeout, '识图区也要能编辑 timeoutMs（虽然不可启用）');
    assert.deepEqual(visionTimeout.pathParts, ['vision', 'timeoutMs']);

    // 自查：schema 里有、描述符以前没发的字段，现在都在
    const openai = image.providers.find(provider => provider.id === 'openai-compatible');
    for (const name of ['baseUrl', 'apiKey', 'model', 'size', 'quality', 'outputFormat', 'background', 'timeoutMs']) {
      assert.ok(openai.fields.some(item => item.pathParts.at(-1) === name), `OpenAI 缺少 ${name}`);
    }
    const nai = image.providers.find(provider => provider.id === 'nai');
    for (const name of ['transport', 'width', 'height', 'steps', 'scale', 'sampler', 'noiseSchedule', 'seed', 'ucPreset', 'negativePrompt', 'timeoutMs']) {
      assert.ok(nai.fields.some(item => item.pathParts.at(-1) === name), `NAI 缺少 ${name}`);
    }
    // 画师串只在预设块出现一次（不能有两个输入框写同一个键）
    assert.equal(nai.fields.some(item => item.pathParts.at(-1) === 'artistString'), false);
    assert.equal(image.presets.artistString.pathParts.at(-1), 'artistString');
  } finally {
    cleanup();
  }
});

test('timeoutMs 的标签约束是真的：越界保存被 400 拒绝', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const { handlers } = setup(dir, { config: imageConfig() });
    for (const bad of [0, 999, 600001]) {
      const response = await handlers[`POST ${API_PREFIX}/config`](jsonRequest(`${API_PREFIX}/config`, {
        method: 'POST',
        body: { patch: { image: { 'openai-compatible': { timeoutMs: bad } } } },
      }));
      assert.equal(response.status, 400, `timeoutMs=${bad} 应被拒`);
      const payload = await response.json();
      assert.ok(payload.errors.some(item => item.path === 'image.openai-compatible.timeoutMs'), `timeoutMs=${bad} 错误路径不对`);
    }
    const ok = await handlers[`POST ${API_PREFIX}/config`](jsonRequest(`${API_PREFIX}/config`, {
      method: 'POST',
      body: { patch: { image: { 'openai-compatible': { timeoutMs: 1000 } } } },
    }));
    assert.equal(ok.status, 200);
  } finally {
    cleanup();
  }
});
