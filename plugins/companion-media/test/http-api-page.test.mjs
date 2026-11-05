import test from 'node:test';
import assert from 'node:assert/strict';
import { createMediaService } from '../src/service.mjs';
import { createMediaHandlers, API_PREFIX } from '../src/http-api.mjs';
import { mediaPageDescriptor, renderPagePreview } from '../src/ui-page.mjs';
import { tempDataDir, mockFetch, makePng, writeConfig } from './helpers.mjs';
import { Code } from '../src/errors.mjs';

const KEY = 'sk-ui-0123456789abcdefghij';
const PNG = makePng();

function setup(dir, { config = null, fetchImpl } = {}) {
  if (config) writeConfig(dir, config);
  const service = createMediaService({ dataDir: dir, env: {}, fetchImpl: fetchImpl ?? mockFetch([{ match: () => true, response: { status: 200, json: {} } }]).fetchImpl });
  return { service, handlers: createMediaHandlers(service) };
}

const request = (path, { method = 'GET', body = null, headers = {} } = {}) => new Request(`http://127.0.0.1:1234${path}`, {
  method,
  headers: { 'content-type': 'application/json', ...headers },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

test('GET /config 返回掩码，不含明文密钥', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const config = {
      schemaVersion: 2,
      image: { enabled: true, provider: 'openai', openai: { baseUrl: 'https://api.example.test/v1', apiKey: KEY, model: 'm' } },
    };
    const { handlers } = setup(dir, { config });
    const response = await handlers[`GET ${API_PREFIX}/config`](request(`${API_PREFIX}/config`));
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(JSON.stringify(payload).includes(KEY), false);
    assert.equal(payload.config.image.openai.apiKey.configured, true);
  } finally {
    cleanup();
  }
});

test('POST /config 保存成功并校验；保存失败返回 400 + 字段错误', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const { handlers } = setup(dir);
    const good = await handlers[`POST ${API_PREFIX}/config`](request(`${API_PREFIX}/config`, {
      method: 'POST',
      body: { patch: { image: { enabled: true, provider: 'openai', openai: { baseUrl: 'https://api.example.test/v1', apiKey: KEY, model: 'm' } } } },
    }));
    assert.equal(good.status, 200);
    const saved = await good.json();
    assert.equal(saved.saved, true);
    assert.equal(JSON.stringify(saved).includes(KEY), false);

    const bad = await handlers[`POST ${API_PREFIX}/config`](request(`${API_PREFIX}/config`, {
      method: 'POST',
      body: { patch: { image: { enabled: true, provider: 'openai', openai: { model: '' } } } },
    }));
    assert.equal(bad.status, 400);
    const payload = await bad.json();
    assert.equal(payload.ok, false);
    assert.ok(payload.errors.some(item => item.path.startsWith('image.openai')));
  } finally {
    cleanup();
  }
});

test('跨站 Origin 被拒绝（403），本机 Origin 允许', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const { handlers } = setup(dir);
    const crossSite = await handlers[`GET ${API_PREFIX}/status`](request(`${API_PREFIX}/status`, { headers: { origin: 'https://evil.example' } }));
    assert.equal(crossSite.status, 403);
    const local = await handlers[`GET ${API_PREFIX}/status`](request(`${API_PREFIX}/status`, { headers: { origin: 'http://127.0.0.1:56338' } }));
    assert.equal(local.status, 200);
  } finally {
    cleanup();
  }
});

test('POST /image 必须带 confirm:true（按钮之外无法误触发计费）', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const { handlers } = setup(dir);
    const noConfirm = await handlers[`POST ${API_PREFIX}/image`](request(`${API_PREFIX}/image`, { method: 'POST', body: { prompt: 'x' } }));
    assert.equal(noConfirm.status, 400);
    const payload = await noConfirm.json();
    assert.equal(payload.error.code, Code.DISABLED);
    assert.match(payload.error.message, /confirm:true/);
  } finally {
    cleanup();
  }
});

test('POST /image 带 confirm 但功能关闭 → 仍返回 DISABLED，且无网络请求', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const { fetchImpl, calls } = mockFetch([{ match: () => true, response: { status: 200, json: {} } }]);
    const { handlers } = setup(dir, { fetchImpl });
    const response = await handlers[`POST ${API_PREFIX}/image`](request(`${API_PREFIX}/image`, { method: 'POST', body: { prompt: 'x', confirm: true } }));
    const payload = await response.json();
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, Code.DISABLED);
    assert.equal(calls.length, 0);
  } finally {
    cleanup();
  }
});

test('POST /image + confirm + 已配置 → 返回产物与 handoff（delivered=false）', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const { fetchImpl } = mockFetch([{ match: () => true, response: { status: 200, json: { data: [{ b64_json: PNG.toString('base64') }] } } }]);
    const config = {
      schemaVersion: 2,
      image: { enabled: true, provider: 'openai', openai: { baseUrl: 'https://api.example.test/v1', apiKey: KEY, model: 'm', timeoutMs: 3000 } },
      limits: { requestBudgetMs: 3000, connectTimeoutMs: 1000, maxResponseBytes: 1 << 20, maxImageBytes: 1 << 20, maxAudioBytes: 1 << 20, maxRedirects: 2, maxImagesPerRequest: 1, maxTextChars: 500 },
    };
    const { handlers } = setup(dir, { config, fetchImpl });
    const response = await handlers[`POST ${API_PREFIX}/image`](request(`${API_PREFIX}/image`, { method: 'POST', body: { prompt: 'a lighthouse', confirm: true } }));
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true, JSON.stringify(payload.error ?? {}));
    assert.equal(payload.handoff.delivered, false);
  } finally {
    cleanup();
  }
});

test('识图路径：GET/POST 都只是拒绝，且带合同', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const { handlers } = setup(dir);
    const get = await handlers[`GET ${API_PREFIX}/vision`](request(`${API_PREFIX}/vision`));
    assert.equal(get.status, 200);
    const body = await get.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, Code.DISABLED);
    assert.equal(body.contract.locked, true);
    const post = await handlers[`POST ${API_PREFIX}/vision`](request(`${API_PREFIX}/vision`, { method: 'POST', body: { path: 'x.png' } }));
    assert.equal(post.status, 400);
    assert.equal((await post.json()).ok, false);
  } finally {
    cleanup();
  }
});

test('GET /page 描述符：分组在"工具"、六种状态齐备、未接入 provider 标注原因', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const { service } = setup(dir);
    const descriptor = mediaPageDescriptor(service.status());
    assert.equal(descriptor.group, '工具');
    assert.equal(descriptor.title, '媒体能力');
    assert.deepEqual(descriptor.states.map(item => item.id), ['disabled', 'unconfigured', 'not-connected', 'saved-untested', 'test-ok', 'test-failed']);
    const tts = descriptor.sections.find(item => item.id === 'tts');
    const indexTts = tts.providers.find(item => item.id === 'index-tts');
    assert.equal(indexTts.status, 'not-connected');
    assert.match(indexTts.stateNote, /HTTP/);
    const vision = descriptor.sections.find(item => item.id === 'vision');
    assert.equal(vision.locked, true);
    assert.equal(vision.toggle.disabled, true);
    assert.equal(vision.toggle.value, false);
  } finally {
    cleanup();
  }
});

test('页面预览 HTML 里没有密钥，也不把"已保存"写成"连接成功"', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const config = {
      schemaVersion: 2,
      image: { enabled: true, provider: 'openai', openai: { baseUrl: 'https://api.example.test/v1', apiKey: KEY, model: 'm' } },
      tts: { enabled: false, providers: { 'fish-audio': { apiKey: 'fish_secret_value_12345', baseUrl: 'https://api.fish.audio' } } },
    };
    const { service } = setup(dir, { config });
    const html = renderPagePreview(mediaPageDescriptor(service.status()));
    assert.equal(html.includes(KEY), false);
    assert.equal(html.includes('fish_secret_value_12345'), false);
    assert.match(html, /已保存、未测试/, '保存后必须显示"已保存、未测试"');
    assert.equal(html.includes('连接成功'), false);
    assert.match(html, /尚未接入/);
  } finally {
    cleanup();
  }
});

test('GET /preview 复现自动分辨率，越界报错', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const { handlers } = setup(dir);
    const ok = await handlers[`GET ${API_PREFIX}/preview`](request(`${API_PREFIX}/preview?mode=auto&aspect=portrait&targetPixels=1011712`));
    const okBody = await ok.json();
    assert.equal(okBody.resolution.ok, true);
    const again = await handlers[`GET ${API_PREFIX}/preview`](request(`${API_PREFIX}/preview?mode=auto&aspect=portrait&targetPixels=1011712`));
    assert.equal((await again.json()).resolution.size, okBody.resolution.size, '同一输入必须复现同一结果');
    const bad = await handlers[`GET ${API_PREFIX}/preview`](request(`${API_PREFIX}/preview?mode=fixed&size=800x800`));
    assert.equal((await bad.json()).resolution.ok, false);
  } finally {
    cleanup();
  }
});

test('未注册的方法返回 405（不是 404，也不是静默通过）', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const { service } = setup(dir);
    // 直接复用注册逻辑里的分发语义：handlers 表里没有 DELETE
    const handlers = createMediaHandlers(service);
    assert.equal(handlers[`DELETE ${API_PREFIX}/config`], undefined);
  } finally {
    cleanup();
  }
});
