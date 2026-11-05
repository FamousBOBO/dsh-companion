import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULTS, loadConfig, normalizeConfig, sanitizedConfig } from '../config.mjs';
import { createLedger } from '../lib/store.mjs';
import { classifyKind, normalizeMediaInput, sniffImage, writeManaged, readManaged } from '../lib/media.mjs';
import { gifBytes, jpegBytes, pngBytes, webpBytes, tempRoot } from './helpers.mjs';

test('every capability starts disabled and real spend needs a second switch', () => {
  const config = normalizeConfig({});
  assert.equal(config.vision.enabled, false);
  assert.equal(config.speech.enabled, false);
  assert.equal(config.speech.auto.enabled, false);
  assert.equal(config.image.enabled, false);
  assert.equal(config.image.allowRealGeneration, false);
  assert.equal(config.screen.enabled, false);
  assert.equal(config.delivery.mode, 'mock');
});

test('the migration baseline values match the old live configuration', () => {
  const config = DEFAULTS;
  assert.equal(config.vision.local.model, 'nsfwvision-v3:q5');
  assert.match(config.vision.local.baseUrl, /:8139\/ollama/);
  assert.equal(config.vision.cloud.provider, 'opencode-go');
  assert.equal(config.vision.cloud.model, 'deepseek-v4.1-flash');
  assert.equal(config.vision.gifMaxFrames, 4);
  assert.equal(config.vision.cacheMaxItems, 300);
  assert.equal(config.speech.backend.voice, 'march7_B');
  assert.equal(config.speech.backend.cfgScale, 3);
  assert.equal(config.speech.backend.seed, 42);
  assert.equal(config.speech.backend.speed, 0.9);
  assert.match(config.speech.backend.baseUrl, /:8139\/breeze/);
  assert.equal(config.speech.auto.probability, 35);
  assert.equal(config.speech.auto.minIntervalSeconds, 180);
  assert.equal(config.image.model, 'nai-diffusion-5-full');
  assert.equal(config.image.size, '832x1216');
  assert.equal(config.image.steps, 28);
  assert.equal(config.image.flow ?? config.image.generationFlow, 'tag');
  assert.equal(config.screen.cloud.model, 'deepseek-v4.1-flash');
});

test('a missing config file yields safe defaults and reports the miss', () => {
  const root = tempRoot();
  const { config, missing, source } = loadConfig(root);
  assert.equal(missing, true);
  assert.equal(config.vision.enabled, false);
  assert.match(source.replace(/\\/g, '/'), /home\/media\/config\.json$/);
});

test('sanitized config keeps no credential-shaped field', () => {
  const config = normalizeConfig({ image: { configPath: 'C:/secret/path.json' }, speech: { token: 'abc' } });
  const clean = sanitizedConfig(config);
  assert.equal(clean.speech.token, '[redacted]');
  assert.equal(clean.image.configPath, '[local path]');
  assert.equal(JSON.stringify(clean).includes('C:/secret/path.json'), false);
});

test('image container sniffing reads the real geometry', () => {
  assert.deepEqual(pick(sniffImage(pngBytes({ width: 64, height: 48 }))), { mime: 'image/png', format: 'png', width: 64, height: 48 });
  assert.deepEqual(pick(sniffImage(gifBytes({ width: 120, height: 90 }))), { mime: 'image/gif', format: 'gif', width: 120, height: 90 });
  assert.deepEqual(pick(sniffImage(jpegBytes({ width: 200, height: 100 }))), { mime: 'image/jpeg', format: 'jpeg', width: 200, height: 100 });
  assert.deepEqual(pick(sniffImage(webpBytes({ width: 300, height: 200 }))), { mime: 'image/webp', format: 'webp', width: 300, height: 200 });
  assert.equal(sniffImage(Buffer.from('not an image')), null);
});

test('kind classification keeps unknown pictures local', () => {
  assert.equal(classifyKind({ filename: 'cat.png', format: 'png' }), 'image');
  assert.equal(classifyKind({ filename: 'sticker_happy.png', format: 'png' }), 'sticker');
  assert.equal(classifyKind({ filename: 'anim.gif', format: 'gif' }), 'sticker');
  assert.equal(classifyKind({ source: 'screen-fixture', format: 'png' }), 'screen');
  assert.equal(classifyKind({ hint: 'screen', format: 'png' }), 'screen');
});

test('normalization rejects oversize, undersize and non-images', () => {
  const owner = { userId: 'u1', persona: 'march7' };
  const limits = { maxImageBytes: 1000, maxPixels: 1_000_000, minDimension: 16 };
  assert.throws(() => normalizeMediaInput({ bytes: Buffer.from('nope') }, { limits, sessionId: 's', owner }), /not a PNG/);
  assert.throws(() => normalizeMediaInput({ bytes: pngBytes({ width: 8, height: 8 }) }, { limits, sessionId: 's', owner }), /below the/);
  const big = Buffer.concat([pngBytes({ width: 64, height: 48 }), Buffer.alloc(2000)]);
  assert.throws(() => normalizeMediaInput({ bytes: big }, { limits, sessionId: 's', owner }), /limit is 1000/);
  assert.throws(() => normalizeMediaInput({ bytes: pngBytes() }, { limits, owner }), /runtime session/);
  assert.throws(() => normalizeMediaInput({ bytes: pngBytes() }, { limits, sessionId: 's' }), /resolved owner/);
});

test('a normalized input is content addressed and carries the resolved owner', () => {
  const media = normalizeMediaInput({ bytes: pngBytes({ width: 32, height: 32 }) }, {
    limits: { maxImageBytes: 1e6, maxPixels: 1e8, minDimension: 1 },
    sessionId: 'session-1',
    owner: { userId: 'owner-1', persona: 'march7' },
  });
  assert.match(media.mediaId, /^sha256:[0-9a-f]{64}$/);
  assert.equal(media.owner.userId, 'owner-1');
  assert.equal(media.kind, 'image');
  assert.equal(media.width, 32);
});

test('managed writes cannot escape the root', () => {
  const root = tempRoot();
  const relative = writeManaged(root, 'media/inbox', pngBytes(), 'a.png');
  assert.equal(relative, 'media/inbox/a.png');
  assert.equal(readManaged(root, relative).length > 0, true);
  assert.throws(() => writeManaged(root, 'media/inbox', pngBytes(), '../../../evil.png'), /escapes managed root/);
});

test('quota semantics follow -1 unlimited, 0 disabled, N capped', () => {
  const ledger = createLedger({ root: tempRoot() });
  assert.equal(ledger.consumeQuota({ scope: 'private_owner', limit: -1 }).allowed, true);
  const disabled = ledger.consumeQuota({ scope: 'group', limit: 0 });
  assert.equal(disabled.allowed, false);
  assert.equal(disabled.reason, 'disabled');
  assert.equal(ledger.consumeQuota({ scope: 'proactive', limit: 2 }).allowed, true);
  assert.equal(ledger.consumeQuota({ scope: 'proactive', limit: 2 }).allowed, true);
  const exhausted = ledger.consumeQuota({ scope: 'proactive', limit: 2 });
  assert.equal(exhausted.allowed, false);
  assert.equal(exhausted.reason, 'exhausted');
  ledger.refundQuota({ scope: 'proactive' });
  assert.equal(ledger.consumeQuota({ scope: 'proactive', limit: 2 }).allowed, true);
});

test('the ledger is idempotent per key and persists across instances', async () => {
  const root = tempRoot();
  const ledger = createLedger({ root });
  const first = await ledger.createJob({ jobId: 'j1', idempotencyKey: 'k', capability: 'vision', state: 'running', createdAt: new Date().toISOString() });
  const second = await ledger.createJob({ jobId: 'j2', idempotencyKey: 'k', capability: 'vision', state: 'running', createdAt: new Date().toISOString() });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.job.jobId, 'j1');
  const reopened = createLedger({ root });
  assert.equal(reopened.getJob('j1').idempotencyKey, 'k');
});

test('the vision cache is capped and bustable', async () => {
  const ledger = createLedger({ root: tempRoot(), maxCacheItems: 2 });
  await ledger.cacheSet('a', { description: 'a' });
  await ledger.cacheSet('b', { description: 'b' });
  await ledger.cacheSet('c', { description: 'c' });
  assert.equal(ledger.cacheSize(), 2);
  assert.equal(ledger.cacheGet('a'), undefined);
  ledger.cacheBust();
  assert.equal(ledger.cacheSize(), 0);
});

function pick(value) {
  return { mime: value.mime, format: value.format, width: value.width, height: value.height };
}
