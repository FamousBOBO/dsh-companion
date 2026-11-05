import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeConfig } from '../config.mjs';
import { createLedger } from '../lib/store.mjs';
import { createImageService } from '../lib/imagegen.mjs';
import { createSpeechService } from '../lib/speech.mjs';
import { createVisionService, assertCoordinator } from '../lib/vision.mjs';
import { resolveHostClass, classifyHost } from '../lib/transport.mjs';
import { MANAGED_DIR } from '../lib/paths.mjs';
import { pngBytes, wavBytes, tempRoot, fakeResponse } from './helpers.mjs';

// Regression suite for the review round-1 findings.
//
// Every test here exists because an independent reviewer found the code did not
// do what the report claimed. Keep them; they are the price of the claim.

function imageConfig(overrides = {}) {
  return normalizeConfig({ image: { enabled: true, allowRealGeneration: true, ...overrides } });
}

function fakeBridge(handler) {
  return async (command, args, options) => {
    const request = JSON.parse(String(options.input));
    return handler(request);
  };
}

function okBridge({ alpha = true } = {}) {
  return fakeBridge(request => {
    if (request.mode === 'dry-run') {
      return { code: 0, stdout: Buffer.from(JSON.stringify({ ok: true, paramsDigest: 'digest', summary: { model: 'nai-diffusion-5-full' } })), stderr: Buffer.alloc(0) };
    }
    fs.mkdirSync(path.dirname(request.out), { recursive: true });
    fs.writeFileSync(request.out, pngBytes({ width: 832, height: 1216 }));
    return { code: 0, stdout: Buffer.from(JSON.stringify({ ok: true, file: request.out, bytes: 1000, sha256: 'a', width: 832, height: 1216, alpha, summary: { model: 'nai-diffusion-5-full', steps: 28, scale: 5 } })), stderr: Buffer.alloc(0) };
  });
}

test('an unknown quota scope cannot be selected into unlimited generation', async () => {
  const root = tempRoot();
  const service = createImageService({
    config: imageConfig({ quotas: { private_owner: 0, group: 0 } }),
    ledger: createLedger({ root }),
    root,
    run: okBridge(),
  });
  const bypass = await service.generate({ prompt: '1girl', scope: 'not_a_bucket' });
  assert.equal(bypass.ok, false);
  assert.equal(bypass.error.code, 'MEDIA_BAD_INPUT');
  const fromSource = await service.generate({ prompt: '1girl', source: 'user_request' });
  assert.equal(fromSource.error.code, 'MEDIA_QUOTA_DENIED');
});

test('a timeout keeps the charge and reports unknown, with the ledger agreeing', async () => {
  const root = tempRoot();
  const service = createImageService({
    config: imageConfig({ quotas: { private_owner: 5 } }),
    ledger: createLedger({ root }),
    root,
    run: fakeBridge(() => ({ code: 0, stdout: Buffer.from(JSON.stringify({ ok: false, error: { code: 'MEDIA_TIMEOUT', message: 'exceeded' } })), stderr: Buffer.alloc(0) })),
  });
  const result = await service.generate({ prompt: '1girl', source: 'user_request' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'MEDIA_TIMEOUT');
  assert.equal(result.refunded, false);
  // The ledger is the authority: the quota stayed consumed because the remote may have billed.
  assert.equal(service.ledger.quotaUsed({ scope: 'private_owner' }), 1);
  assert.equal(service.ledger.listJobs(1)[0].state, 'unknown');
});

test('a killed bridge process is unknown, not a refundable failure', async () => {
  const root = tempRoot();
  const service = createImageService({
    config: imageConfig({ quotas: { private_owner: 5 } }),
    ledger: createLedger({ root }),
    root,
    run: async () => ({ code: -1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), timedOut: true }),
  });
  const result = await service.generate({ prompt: '1girl', source: 'user_request' });
  assert.equal(result.error.code, 'MEDIA_TIMEOUT');
  assert.equal(result.refunded, false);
  assert.equal(service.ledger.quotaUsed({ scope: 'private_owner' }), 1);
  assert.equal(service.ledger.listJobs(1)[0].state, 'unknown');
});

test('a proven backend failure is refunded and the ledger says so', async () => {
  const root = tempRoot();
  const service = createImageService({
    config: imageConfig({ quotas: { private_owner: 5 } }),
    ledger: createLedger({ root }),
    root,
    run: fakeBridge(() => ({ code: 0, stdout: Buffer.from(JSON.stringify({ ok: false, error: { code: 'MEDIA_BACKEND_FAILED', message: 'upstream 500' } })), stderr: Buffer.alloc(0) })),
  });
  const result = await service.generate({ prompt: '1girl', source: 'user_request' });
  assert.equal(result.refunded, true);
  assert.equal(service.ledger.quotaUsed({ scope: 'private_owner' }), 0);
  assert.equal(service.ledger.listJobs(1)[0].state, 'failed');
});

test('a retry after failure extends the same job instead of orphaning a new one', async () => {
  const root = tempRoot();
  let attempt = 0;
  const service = createImageService({
    config: imageConfig({ quotas: { private_owner: 5 } }),
    ledger: createLedger({ root }),
    root,
    run: fakeBridge(request => {
      if (request.mode === 'dry-run') return { code: 0, stdout: Buffer.from(JSON.stringify({ ok: true, paramsDigest: 'd', summary: {} })), stderr: Buffer.alloc(0) };
      attempt += 1;
      if (attempt === 1) return { code: 0, stdout: Buffer.from(JSON.stringify({ ok: false, error: { code: 'MEDIA_BACKEND_FAILED', message: 'first failure' } })), stderr: Buffer.alloc(0) };
      fs.mkdirSync(path.dirname(request.out), { recursive: true });
      fs.writeFileSync(request.out, pngBytes());
      return { code: 0, stdout: Buffer.from(JSON.stringify({ ok: true, file: request.out, width: 64, height: 48, alpha: true, summary: {} })), stderr: Buffer.alloc(0) };
    }),
  });
  const first = await service.generate({ prompt: '1girl', source: 'user_request', idempotencyKey: 'same-key' });
  assert.equal(first.ok, false);
  const second = await service.generate({ prompt: '1girl', source: 'user_request', idempotencyKey: 'same-key' });
  assert.equal(second.ok, true, JSON.stringify(second.error));
  const jobs = service.ledger.listJobs(10).filter(job => job.idempotencyKey === 'same-key');
  assert.equal(jobs.length, 1, 'one idempotency key must own exactly one job');
  assert.equal(jobs[0].attempts, 2);
  assert.equal(jobs[0].state, 'succeeded');
});

test('concurrent duplicates share one generation instead of paying twice', async () => {
  const root = tempRoot();
  let generations = 0;
  const service = createImageService({
    config: imageConfig({ quotas: { private_owner: 5 } }),
    ledger: createLedger({ root }),
    root,
    run: fakeBridge(request => {
      if (request.mode === 'dry-run') return { code: 0, stdout: Buffer.from(JSON.stringify({ ok: true, paramsDigest: 'd', summary: {} })), stderr: Buffer.alloc(0) };
      generations += 1;
      fs.mkdirSync(path.dirname(request.out), { recursive: true });
      fs.writeFileSync(request.out, pngBytes());
      return { code: 0, stdout: Buffer.from(JSON.stringify({ ok: true, file: request.out, width: 64, height: 48, alpha: true, summary: {} })), stderr: Buffer.alloc(0) };
    }),
  });
  const [a, b] = await Promise.all([
    service.generate({ prompt: '1girl', source: 'user_request', idempotencyKey: 'dup' }),
    service.generate({ prompt: '1girl', source: 'user_request', idempotencyKey: 'dup' }),
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(generations, 1);
  assert.equal(service.ledger.quotaUsed({ scope: 'private_owner' }), 1);
});

test('concurrent speech duplicates synthesize once', async () => {
  const root = tempRoot();
  let calls = 0;
  const service = createSpeechService({
    config: normalizeConfig({ speech: { enabled: true, backend: { speed: 1 }, director: { enabled: false } } }),
    ledger: createLedger({ root }),
    root,
    fetchImpl: async () => { calls += 1; return fakeResponse({ status: 200, body: wavBytes({ samples: 800 }) }); },
    run: async () => ({ code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }),
  });
  const [a, b] = await Promise.all([
    service.synthesize({ text: '同一句话', sessionId: 's1', useDirector: false }),
    service.synthesize({ text: '同一句话', sessionId: 's1', useDirector: false }),
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(calls, 1);
});

test('speech and image artifacts land under home/media', async () => {
  const root = tempRoot();
  const speech = createSpeechService({
    config: normalizeConfig({ speech: { enabled: true, backend: { speed: 1 }, director: { enabled: false } } }),
    ledger: createLedger({ root }),
    root,
    fetchImpl: async () => fakeResponse({ status: 200, body: wavBytes({ samples: 400 }) }),
    run: async () => ({ code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }),
  });
  const spoken = await speech.synthesize({ text: '你好', sessionId: 's1', useDirector: false });
  assert.equal(spoken.ok, true);
  assert.ok(spoken.artifact.path.startsWith(`${MANAGED_DIR}/artifacts/speech/`), spoken.artifact.path);
  assert.ok(fs.existsSync(path.join(root, spoken.artifact.path)));

  const image = createImageService({ config: imageConfig(), ledger: createLedger({ root }), root, run: okBridge() });
  const drawn = await image.generate({ prompt: '1girl', source: 'user_request', idempotencyKey: 'p1' });
  assert.equal(drawn.ok, true);
  assert.ok(drawn.artifact.path.startsWith(`${MANAGED_DIR}/artifacts/image/`), drawn.artifact.path);
});

test('the coordinator guard refuses a backend that is not 8139', () => {
  assert.doesNotThrow(() => assertCoordinator('http://127.0.0.1:8139/ollama/v1', { expectedPort: 8139, pathPrefix: '/ollama' }));
  assert.throws(() => assertCoordinator('http://127.0.0.1:11434/v1', { expectedPort: 8139 }), /coordinator port 8139/);
  assert.throws(() => assertCoordinator('http://10.0.0.9:8139/ollama/v1', { expectedPort: 8139 }), /local coordinator/);
  assert.throws(() => assertCoordinator('http://127.0.0.1:8139/breeze', { expectedPort: 8139, pathPrefix: '/ollama' }), /path must start with/);
  assert.throws(() => assertCoordinator('not a url', { expectedPort: 8139 }), /invalid backend url/);
});

test('a local vision call pointed away from the coordinator is refused, not executed', async () => {
  const calls = [];
  const service = createVisionService({
    config: normalizeConfig({ vision: { enabled: true, local: { baseUrl: 'http://127.0.0.1:11434/v1' } } }),
    ledger: createLedger({ root: tempRoot() }),
    fetchImpl: async (...args) => { calls.push(args); return fakeResponse({ json: {} }); },
  });
  const bytes = pngBytes();
  const result = await service.inspect({
    media: { mediaId: 'x', sessionId: 's', owner: { userId: 'u' }, kind: 'image', source: 'desktop', mime: 'image/png', format: 'png', sha256: 'x', capturedAt: new Date().toISOString() },
    bytes,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'MEDIA_BAD_INPUT');
  assert.equal(calls.length, 0, 'no request may leave for a non-coordinator backend');
});

test('hostnames that resolve to loopback are refused even though the name looks public', async () => {
  assert.equal(classifyHost('localhost'), 'loopback');
  assert.equal(classifyHost('::ffff:127.0.0.1'), 'loopback');
  assert.equal(classifyHost('::ffff:7f00:1'), 'loopback');
  const resolved = await resolveHostClass('evil.example.com', { resolver: async () => [{ address: '127.0.0.1', family: 4 }] });
  assert.equal(resolved.klass, 'loopback');
  const fine = await resolveHostClass('cdn.example.com', { resolver: async () => [{ address: '93.184.216.34', family: 4 }] });
  assert.equal(fine.klass, 'public');
  const mixed = await resolveHostClass('mixed.example.com', { resolver: async () => [{ address: '93.184.216.34' }, { address: '10.1.2.3' }] });
  assert.equal(mixed.klass, '10.0.0.0/8');
});

test('the vision cache separates owners even when a scope is passed', async () => {
  const root = tempRoot();
  const requests = [];
  const service = createVisionService({
    config: normalizeConfig({ vision: { enabled: true } }),
    ledger: createLedger({ root }),
    fetchImpl: async (url, init) => {
      requests.push(init.body);
      return fakeResponse({ json: { choices: [{ message: { content: '一张图片' } }] } });
    },
  });
  const bytes = pngBytes();
  const base = { mediaId: 'x', sessionId: 's', kind: 'image', source: 'desktop', mime: 'image/png', format: 'png', sha256: 'x', capturedAt: new Date().toISOString() };
  await service.inspect({ media: { ...base, owner: { userId: 'owner-a' } }, bytes });
  await service.inspect({ media: { ...base, owner: { userId: 'owner-b' } }, bytes });
  assert.equal(requests.length, 2, 'a different owner must not read the first owner\'s cached description');
});

test('the same picture with a different question is re-inspected', async () => {
  const root = tempRoot();
  let calls = 0;
  const service = createVisionService({
    config: normalizeConfig({ vision: { enabled: true } }),
    ledger: createLedger({ root }),
    fetchImpl: async () => { calls += 1; return fakeResponse({ json: { choices: [{ message: { content: '一张图片' } }] } }); },
  });
  const bytes = pngBytes();
  const media = { mediaId: 'x', sessionId: 's', owner: { userId: 'u' }, kind: 'image', source: 'desktop', mime: 'image/png', format: 'png', sha256: 'x', capturedAt: new Date().toISOString() };
  await service.inspect({ media, bytes, prompt: '这是什么' });
  await service.inspect({ media, bytes, prompt: '上面写了什么字' });
  assert.equal(calls, 2);
});

test('editing the config file flips a capability without a restart', async () => {
  const sandbox = tempRoot('companion-media-reload-');
  fs.mkdirSync(path.join(sandbox, 'home/media'), { recursive: true });
  fs.mkdirSync(path.join(sandbox, 'home/companion'), { recursive: true });
  const configPath = path.join(sandbox, 'home/media/config.json');
  fs.writeFileSync(configPath, JSON.stringify({ vision: { enabled: false }, speech: { enabled: false } }), 'utf8');
  fs.writeFileSync(path.join(sandbox, 'home/companion/identity.json'), JSON.stringify({
    schemaVersion: 1,
    owner: { id: 'owner-1', displayName: '槑', platform: 'qq' },
    persona: 'march7',
    desktop: { mode: 'local-owner', userId: 'owner-1' },
    sessions: {},
  }), 'utf8');

  const { mountMedia } = await import('../index.mjs');
  const service = mountMedia({ tools: { register() {} }, get() { return undefined; } }, { companionRoot: sandbox });
  assert.equal(service.status().capabilities.vision.enabled, false);
  assert.equal(service.status().dataRoot, sandbox, 'ledger and artifacts must stay inside the sandbox root');

  fs.writeFileSync(configPath, JSON.stringify({ vision: { enabled: true } }), 'utf8');
  assert.equal(service.status().capabilities.vision.enabled, true);
  // A disabled capability still refuses work after the switch is flipped back.
  fs.writeFileSync(configPath, JSON.stringify({ vision: { enabled: false } }), 'utf8');
  const refused = await service.inspectImage({ bytes: pngBytes(), sessionId: 's1' });
  assert.equal(refused.error.code, 'MEDIA_DISABLED');
});
