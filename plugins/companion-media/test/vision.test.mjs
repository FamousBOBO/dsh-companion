import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeConfig } from '../config.mjs';
import { createLedger } from '../lib/store.mjs';
import { createVisionService, visionCacheKey, visionRouteFor, buildVisionPrompt } from '../lib/vision.mjs';
import { checkUrlAllowed, fetchBounded, classifyHost, createMockTransport } from '../lib/transport.mjs';
import { evaluateFrame } from '../lib/screen.mjs';
import { pngBytes, tempRoot, fakeResponse } from './helpers.mjs';

const fixture = name => fs.readFileSync(new URL(`./fixtures/vision/${name}`, import.meta.url));

function visionConfig(overrides = {}) {
  return normalizeConfig({ vision: { enabled: true, ...overrides } });
}

function mediaFor({ kind = 'image', owner = 'owner-1', bytes }) {
  return {
    mediaId: 'sha256:x', sessionId: 'session-1', owner: { userId: owner, persona: 'march7' },
    kind, source: kind === 'screen' ? 'screen-fixture' : 'desktop', mime: 'image/png', format: 'png',
    sha256: 'deadbeef', capturedAt: new Date().toISOString(), bytes: bytes.length,
  };
}

test('routing keeps ordinary pictures local and sends stickers/screen to the cloud', () => {
  const config = visionConfig();
  const ordinary = visionRouteFor('image', config);
  assert.equal(ordinary.backend, 'local-ollama');
  assert.equal(ordinary.model, 'nsfwvision-v3:q5');
  assert.match(ordinary.baseUrl, /8139\/ollama/);
  for (const kind of ['sticker', 'screen']) {
    const route = visionRouteFor(kind, config);
    assert.equal(route.backend, 'host-llm');
    assert.equal(route.provider, 'opencode-go');
    assert.equal(route.model, 'deepseek-v4.1-flash');
  }
  const unknown = visionRouteFor('unknown-kind', config);
  assert.equal(unknown.backend, 'local-ollama');
});

test('the cache key separates owner scopes', () => {
  const route = visionRouteFor('image', normalizeConfig({}));
  const a = visionCacheKey({ sha256: 'abc', route, promptVersion: 'v1', scope: 'owner:1' });
  const b = visionCacheKey({ sha256: 'abc', route, promptVersion: 'v1', scope: 'owner:2' });
  const c = visionCacheKey({ sha256: 'abc', route, promptVersion: 'v2', scope: 'owner:1' });
  assert.notEqual(a, b);
  assert.notEqual(a, c);
});

test('a disabled layer never reaches a backend', async () => {
  const calls = [];
  const service = createVisionService({
    config: normalizeConfig({}),
    ledger: createLedger({ root: tempRoot() }),
    fetchImpl: async (...args) => { calls.push(args); return fakeResponse({ json: {} }); },
  });
  const result = await service.inspect({ media: mediaFor({ bytes: pngBytes() }), bytes: pngBytes() });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'MEDIA_DISABLED');
  assert.equal(calls.length, 0);
});

test('local vision sends a real image block and caches the answer per owner', async () => {
  const requests = [];
  const service = createVisionService({
    config: visionConfig(),
    ledger: createLedger({ root: tempRoot() }),
    fetchImpl: async (url, init) => {
      requests.push({ url, init, body: JSON.parse(init.body) });
      return fakeResponse({ json: { model: 'nsfwvision-v3:q5', choices: [{ message: { content: '白色背景上有一个红色圆形和一个数字 7。' } }] } });
    },
  });
  const bytes = fixture('sample-a.png');
  const first = await service.inspect({ media: mediaFor({ bytes }), bytes });
  assert.equal(first.ok, true);
  assert.equal(first.route.backend, 'local-ollama');
  assert.match(first.description, /红/);
  assert.equal(first.cached, false);

  const body = requests[0].body;
  assert.equal(body.model, 'nsfwvision-v3:q5');
  const imagePart = body.messages[0].content.find(part => part.type === 'image_url');
  assert.ok(imagePart, 'the request must carry an image part, not a URL in text');
  assert.match(imagePart.image_url.url, /^data:image\/png;base64,/);

  const second = await service.inspect({ media: mediaFor({ bytes }), bytes });
  assert.equal(second.cached, true);
  assert.equal(requests.length, 1);

  const otherOwner = await service.inspect({ media: mediaFor({ bytes, owner: 'owner-2' }), bytes });
  assert.equal(otherOwner.cached, false);
  assert.equal(requests.length, 2);
});

test('a failed inspection reports the failure and invents no description', async () => {
  const service = createVisionService({
    config: visionConfig(),
    ledger: createLedger({ root: tempRoot() }),
    fetchImpl: async () => fakeResponse({ status: 500, body: 'model crashed' }),
  });
  const bytes = fixture('sample-b.png');
  const result = await service.inspect({ media: mediaFor({ bytes }), bytes });
  assert.equal(result.ok, false);
  assert.equal(result.description, '', 'a failed inspection must carry no description at all');
  assert.equal(result.error.code, 'MEDIA_BACKEND_FAILED');
});

test('sticker inspection goes through the host LLM with image content blocks', async () => {
  const seen = [];
  const host = {
    available: () => true,
    async inspectImages(options) {
      seen.push(options);
      return { text: '黄色圆形笑脸贴纸，适合表达开心。', model: options.model };
    },
  };
  const service = createVisionService({
    config: visionConfig({ gifMaxFrames: 1 }),
    ledger: createLedger({ root: tempRoot() }),
    host,
  });
  const bytes = fixture('sticker_sample.png');
  const result = await service.inspect({ media: mediaFor({ kind: 'sticker', bytes }), bytes });
  assert.equal(result.ok, true);
  assert.equal(result.route.backend, 'host-llm');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].provider, 'opencode-go');
  assert.equal(seen[0].model, 'deepseek-v4.1-flash');
  assert.equal(seen[0].images.length, 1);
});

test('a missing host LLM is reported, not silently downgraded to the local model', async () => {
  const service = createVisionService({
    config: visionConfig(),
    ledger: createLedger({ root: tempRoot() }),
    host: { available: () => false, async inspectImages() { throw new Error('should not be called'); } },
  });
  const bytes = fixture('sticker_sample.png');
  const result = await service.inspect({ media: mediaFor({ kind: 'sticker', bytes }), bytes });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'MEDIA_HOST_LLM_UNAVAILABLE');
});

test('the prompt carries kind guidance without reordering the user prompt', () => {
  const config = normalizeConfig({});
  const base = buildVisionPrompt({ kind: 'image', prompt: '自定义提示', config });
  assert.ok(base.startsWith('自定义提示'));
  const screen = buildVisionPrompt({ kind: 'screen', prompt: '', config });
  assert.match(screen, /屏幕截图/);
});

test('url policy refuses loopback by default and allows it only when asked', () => {
  assert.equal(checkUrlAllowed('http://127.0.0.1:3000/a.png').allowed, false);
  assert.equal(checkUrlAllowed('http://127.0.0.1:3000/a.png', { allowLocal: true }).allowed, true);
  assert.equal(checkUrlAllowed('http://192.168.1.5/a.png').allowed, false);
  assert.equal(checkUrlAllowed('http://10.0.0.4/a.png').allowed, false);
  assert.equal(checkUrlAllowed('file:///C:/secret.png').allowed, false);
  assert.equal(checkUrlAllowed('ftp://example.com/a.png').allowed, false);
  assert.equal(checkUrlAllowed('https://example.com/a.png').allowed, true);
  assert.equal(classifyHost('example.com'), 'public');
});

test('a redirect into the LAN is refused and byte caps hold', async () => {
  const redirecting = async () => fakeResponse({ status: 302, headers: { location: 'http://127.0.0.1:9/secret.png' } });
  await assert.rejects(() => fetchBounded('https://example.com/a.png', { fetchImpl: redirecting }), /requires an explicit local allowance/);

  const big = async () => fakeResponse({ status: 200, body: Buffer.alloc(5000), headers: { 'content-length': '5000' } });
  await assert.rejects(() => fetchBounded('https://example.com/a.png', { fetchImpl: big, maxBytes: 1000 }), /exceeds 1000/);

  const missing = async () => fakeResponse({ status: 404, body: 'nope' });
  await assert.rejects(() => fetchBounded('https://example.com/a.png', { fetchImpl: missing }), /HTTP 404/);
});

test('a hanging download becomes a timeout', async () => {
  const hanging = (url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  await assert.rejects(() => fetchBounded('https://example.com/a.png', { fetchImpl: hanging, timeoutMs: 20 }), /timed out/);
});

test('the mock transport serves scripted bytes', async () => {
  const transport = createMockTransport({ 'https://example.com/a.png': { bytes: pngBytes(), mime: 'image/png' } });
  const result = await transport.fetchBounded('https://example.com/a.png');
  assert.equal(result.mime, 'image/png');
  await assert.rejects(() => transport.fetchBounded('https://example.com/b.png'), /no route/);
});

test('screen frames are refused when stale, future-dated or from another session', () => {
  const now = Date.parse('2026-10-28T12:00:00Z');
  assert.equal(evaluateFrame({ capturedAt: '2026-10-28T11:59:30Z', maxAgeSeconds: 60, now }).usable, true);
  assert.equal(evaluateFrame({ capturedAt: '2026-10-28T11:55:00Z', maxAgeSeconds: 60, now }).code, 'MEDIA_STALE_FRAME');
  assert.equal(evaluateFrame({ capturedAt: '2026-10-28T12:05:00Z', maxAgeSeconds: 60, now }).code, 'MEDIA_STALE_FRAME');
  assert.equal(evaluateFrame({ capturedAt: '2026-10-28T11:59:30Z', frameSessionId: 'a', expectedSessionId: 'b', maxAgeSeconds: 60, now }).code, 'MEDIA_SESSION_MISMATCH');
  assert.equal(evaluateFrame({ maxAgeSeconds: 60, now }).usable, false);
});

test('the screen device fixture lands inside the plugin fixture directory', () => {
  const root = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  assert.ok(fs.existsSync(path.join(root, 'test/fixtures/screen/synthetic-desktop.png')));
});
