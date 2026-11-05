import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeConfig } from '../config.mjs';
import { createLedger } from '../lib/store.mjs';
import {
  buildSpeechPayload, buildWav, consumeEmotionTags, createSpeechService, decideAutoVoice, parseWav,
} from '../lib/speech.mjs';
import { directSpeech, parseDirection } from '../lib/director.mjs';
import { createImageService, resolveQuotaScope, quotaFor, buildImageParams } from '../lib/imagegen.mjs';
import { composeTurnText, createTurnAggregator } from '../lib/batching.mjs';
import { createDeliveryService, orderItems, planDelivery } from '../lib/delivery.mjs';
import { pngBytes, tempRoot, wavBytes, fakeResponse } from './helpers.mjs';

function speechConfig(overrides = {}) {
  return normalizeConfig({ speech: { enabled: true, ...overrides } });
}

const silentRunner = async () => ({ code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });

test('wav parsing tolerates the placeholder sizes the backend streams', () => {
  const parsed = parseWav(wavBytes({ samples: 1000, placeholderSize: true }));
  assert.equal(parsed.channels, 1);
  assert.equal(parsed.rate, 44100);
  assert.equal(parsed.bitsPerSample, 16);
  assert.equal(parsed.pcm.length, 2000);
  assert.ok(Math.abs(parsed.durationSeconds - 2000 / (44100 * 2)) < 1e-9);
  const rebuilt = parseWav(buildWav({ pcm: parsed.pcm, channels: parsed.channels, rate: parsed.rate }));
  assert.equal(rebuilt.pcm.length, 2000);
  assert.throws(() => parseWav(Buffer.from('RIFF')), /too short/);
  assert.throws(() => parseWav(Buffer.concat([Buffer.from('NOTARIFF'), Buffer.alloc(64)])), /not a RIFF/);
});

test('emotion tags choose the preset and never reach the spoken text', () => {
  const result = consumeEmotionTags('[开心]今天天气真好！', '自然');
  assert.equal(result.emotion, '开心');
  assert.equal(result.text, '今天天气真好！');
  const kept = consumeEmotionTags('[不确定的标签]嗯', '自然');
  assert.equal(kept.text, '[不确定的标签]嗯');
});

test('the speech payload keeps the verified Breeze parameters', () => {
  const payload = buildSpeechPayload({
    text: '你好', voice: 'march7_B', cfgScale: 3, seed: 42, instructions: '自然地说',
    maxNewTokens: 500, model: 'breeze-tts-2',
  });
  assert.deepEqual(payload, {
    model: 'breeze-tts-2', voice: 'march7_B', input: '你好', instructions: '自然地说',
    response_format: 'wav', cfg_scale: 3, seed: 42, max_new_tokens: 500,
  });
});

test('synthesis writes a playable WAV and applies tempo once', async () => {
  const root = tempRoot();
  const calls = [];
  const service = createSpeechService({
    config: speechConfig(),
    ledger: createLedger({ root }),
    root,
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return fakeResponse({ status: 200, body: wavBytes({ samples: 4410 }) });
    },
    run: async (command, args) => {
      calls.push({ command, args });
      const pcm = wavBytes({ samples: 4410 }).subarray(44);
      return { code: 0, stdout: pcm, stderr: Buffer.alloc(0) };
    },
    host: { available: () => false },
  });
  const result = await service.synthesize({ text: '今天也要加油哦', sessionId: 's1' });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(result.artifact.mime, 'audio/wav');
  assert.equal(result.artifact.sampleRate, 44100);
  assert.equal(result.artifact.channels, 1);
  assert.ok(result.artifact.durationSeconds > 0.05);
  assert.equal(result.tempoApplied, true);
  const onDisk = fs.readFileSync(path.join(root, result.artifact.path));
  assert.equal(onDisk.subarray(0, 4).toString('latin1'), 'RIFF');
  assert.equal(onDisk.length, result.artifact.bytes);

  const speechCall = calls.find(call => call.url);
  assert.match(speechCall.url, /:8139\/breeze\/v1\/audio\/speech$/);
  assert.equal(speechCall.body.voice, 'march7_B');
  assert.equal(speechCall.body.cfg_scale, 3);
  assert.equal(speechCall.body.seed, 42);
  const tempoCall = calls.find(call => call.args);
  assert.ok(tempoCall.args.join(' ').includes('atempo=0.9'));
});

test('speed 1.0 skips ffmpeg entirely, so tempo is never applied twice', async () => {
  const root = tempRoot();
  let ran = false;
  const service = createSpeechService({
    config: speechConfig({ backend: { speed: 1 } }),
    ledger: createLedger({ root }),
    root,
    fetchImpl: async () => fakeResponse({ status: 200, body: wavBytes({ samples: 2205 }) }),
    run: async () => { ran = true; return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }; },
    host: { available: () => false },
  });
  const result = await service.synthesize({ text: '嗯', sessionId: 's1' });
  assert.equal(result.ok, true);
  assert.equal(result.tempoApplied, false);
  assert.equal(ran, false);
});

test('a tempo failure is reported instead of shipping fast audio', async () => {
  const root = tempRoot();
  const service = createSpeechService({
    config: speechConfig(),
    ledger: createLedger({ root }),
    root,
    fetchImpl: async () => fakeResponse({ status: 200, body: wavBytes() }),
    run: async () => ({ code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('ffmpeg broke') }),
    host: { available: () => false },
  });
  const result = await service.synthesize({ text: '嗯', sessionId: 's1' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'MEDIA_TEMPO_FAILED');
});

test('a backend failure and a disabled layer both return structured errors', async () => {
  const root = tempRoot();
  const failing = createSpeechService({
    config: speechConfig(),
    ledger: createLedger({ root }),
    root,
    fetchImpl: async () => fakeResponse({ status: 503, body: 'breeze is not loaded' }),
    run: silentRunner,
  });
  const failure = await failing.synthesize({ text: '嗯', sessionId: 's1' });
  assert.equal(failure.ok, false);
  assert.equal(failure.error.code, 'MEDIA_BACKEND_FAILED');

  const off = createSpeechService({ config: normalizeConfig({}), ledger: createLedger({ root }), root });
  const disabled = await off.synthesize({ text: '嗯', sessionId: 's1' });
  assert.equal(disabled.error.code, 'MEDIA_DISABLED');
});

test('a repeated request replays the stored artifact instead of paying twice', async () => {
  const root = tempRoot();
  let hits = 0;
  const service = createSpeechService({
    config: speechConfig({ backend: { speed: 1 } }),
    ledger: createLedger({ root }),
    root,
    fetchImpl: async () => { hits += 1; return fakeResponse({ status: 200, body: wavBytes({ samples: 1000 }) }); },
    run: silentRunner,
  });
  const first = await service.synthesize({ text: '同一句', sessionId: 's1', useDirector: false });
  const second = await service.synthesize({ text: '同一句', sessionId: 's1', useDirector: false });
  assert.equal(first.ok, true);
  assert.equal(second.replay, true);
  assert.equal(hits, 1);
});

test('the auto-voice rule is one decision with a hard 180s interval', () => {
  assert.equal(decideAutoVoice({ enabled: false, probability: 35, minIntervalSeconds: 180 }).speak, false);
  const recent = new Date(Date.now() - 60_000).toISOString();
  const blocked = decideAutoVoice({ enabled: true, probability: 100, minIntervalSeconds: 180, lastTriggeredAt: recent, random: () => 0 });
  assert.equal(blocked.speak, false);
  assert.match(blocked.reason, /interval/);
  const old = new Date(Date.now() - 200_000).toISOString();
  assert.equal(decideAutoVoice({ enabled: true, probability: 35, minIntervalSeconds: 180, lastTriggeredAt: old, random: () => 0.1 }).speak, true);
  assert.equal(decideAutoVoice({ enabled: true, probability: 35, minIntervalSeconds: 180, random: () => 0.9 }).speak, false);
  assert.equal(decideAutoVoice({ enabled: true, probability: 100, minIntervalSeconds: 0, maxChars: 10, text: '这是一句很长很长的回复' }).speak, false);
});

test('the director contract rejects rewritten dialogue and extra fields', () => {
  const original = '今天有点累，我先躺一会儿。';
  const ok = parseDirection(original, JSON.stringify({ input: '今天有点累，我先躺一会儿。', instructions: '放慢语速，以疲惫但放松的语气说。' }));
  assert.equal(ok.instructions.length > 0, true);
  const fenced = parseDirection(original, '```json\n{"input":"今天有点累，我先躺一会儿。","instructions":"轻声说。"}\n```');
  assert.equal(fenced.input.endsWith('。'), true);
  assert.throws(() => parseDirection(original, '{"input":"我心情很好！","instructions":"轻快。"}'), /changed the original dialogue/);
  assert.throws(() => parseDirection(original, '{"input":"今天有点累，我先躺一会儿。","instructions":"轻声说。","model":"x"}'), /only input and instructions/);
  assert.throws(() => parseDirection(original, 'not json'), /not valid JSON/);
  assert.throws(() => parseDirection(original, '{"input":"今天有点累，我先躺一会儿。","instructions":""}'), /empty/);
  // A whitelisted sound event may be added; it is not a dialogue rewrite.
  assert.equal(parseDirection(original, JSON.stringify({ input: '今天有点累，我先躺一会儿。[笑]', instructions: '笑着说。' })).input.endsWith('[笑]'), true);
  assert.equal(parseDirection(original, JSON.stringify({ input: '今天有点累，我先躺一会儿。[叹气]', instructions: '叹口气。' })).input.endsWith('[叹气]'), true);
});

test('a director failure falls back to the plain original line', async () => {
  const fallback = await directSpeech({
    host: { available: () => true, async completeText() { return { text: '{"input":"改写过的台词","instructions":"x"}' }; } },
    text: '原台词',
    config: speechConfig(),
  });
  assert.equal(fallback.used, false);
  assert.equal(fallback.reason, 'invalid-direction');

  const thrown = await directSpeech({
    host: { available: () => true, async completeText() { throw new Error('model down'); } },
    text: '原台词',
    config: speechConfig(),
  });
  assert.equal(thrown.used, false);
  assert.equal(thrown.reason, 'director-failed');
});

test('a failed director never reads JSON or an exception aloud', async () => {
  const root = tempRoot();
  const sent = [];
  const service = createSpeechService({
    config: speechConfig({ backend: { speed: 1 } }),
    ledger: createLedger({ root }),
    root,
    fetchImpl: async (url, init) => { sent.push(JSON.parse(init.body)); return fakeResponse({ status: 200, body: wavBytes({ samples: 500 }) }); },
    run: silentRunner,
    host: { available: () => true, async completeText() { return { text: 'I am not JSON at all' }; } },
  });
  const result = await service.synthesize({ text: '原台词在这里', sessionId: 's1' });
  assert.equal(result.ok, true);
  assert.equal(sent[0].input, '原台词在这里');
  assert.equal(sent[0].instructions, service.presets['自然'] ?? normalizeConfig({}).speech.defaultInstructions);
  assert.equal(sent[0].input.includes('{'), false);
});

// --- image generation -------------------------------------------------------

function imageConfig(overrides = {}) {
  return normalizeConfig({ image: { enabled: true, ...overrides } });
}

function fakeBridge({ mode = 'success', alpha = true } = {}) {
  return async (command, args, options) => {
    const request = JSON.parse(String(options.input));
    if (request.mode === 'dry-run') {
      return { code: 0, stdout: Buffer.from(JSON.stringify({ ok: true, mode: 'dry-run', paramsDigest: 'deadbeefcafe', summary: { model: 'nai-diffusion-5-full', size: 832, height: 1216, steps: 28 } })), stderr: Buffer.alloc(0) };
    }
    if (mode === 'fail') {
      return { code: 0, stdout: Buffer.from(JSON.stringify({ ok: false, error: { code: 'MEDIA_BACKEND_FAILED', message: 'upstream 500' } })), stderr: Buffer.alloc(0) };
    }
    if (mode === 'timeout') {
      return { code: 0, stdout: Buffer.from(JSON.stringify({ ok: false, error: { code: 'MEDIA_TIMEOUT', message: 'generation exceeded 240s' } })), stderr: Buffer.alloc(0) };
    }
    fs.mkdirSync(path.dirname(request.out), { recursive: true });
    fs.writeFileSync(request.out, pngBytes({ width: 832, height: 1216 }));
    return { code: 0, stdout: Buffer.from(JSON.stringify({ ok: true, file: request.out, bytes: 1000, sha256: 'abc', width: 832, height: 1216, alpha, summary: { model: 'nai-diffusion-5-full', steps: 28, scale: 5, sampler: 'k_euler_ancestral', seed: 42 } })), stderr: Buffer.alloc(0) };
  };
}

test('quota scopes and semantics follow the old configuration', () => {
  const config = imageConfig();
  assert.equal(resolveQuotaScope({ source: 'user_request' }), 'private_owner');
  assert.equal(resolveQuotaScope({ source: 'proactive' }), 'proactive');
  assert.equal(resolveQuotaScope({ source: 'natural_language' }), 'natural_language');
  // A caller-supplied scope must be a real bucket; an unknown one cannot become unlimited.
  assert.throws(() => resolveQuotaScope({ scope: 'free_money' }), /unknown quota scope/);
  assert.throws(() => resolveQuotaScope({ source: 'made_up' }), /unknown image source/);
  assert.throws(() => quotaFor(normalizeConfig({}), 'free_money'), /unknown quota scope/);
  assert.equal(quotaFor(config, 'private_owner'), -1);
  assert.equal(quotaFor(normalizeConfig({ image: { quotas: { group: 0 } } }), 'group'), 0);
});

test('image parameters keep the tag flow defaults', () => {
  const config = imageConfig();
  const params = buildImageParams({ prompt: '1girl, solo', style: '二次元' }, config);
  assert.equal(params.model, 'nai-diffusion-5-full');
  assert.equal(params.size, '832x1216');
  assert.equal(params.steps, 28);
  assert.equal(params.scale, 5);
  assert.match(params.tag, /1girl, solo/);
  assert.throws(() => buildImageParams({ prompt: '   ' }, config), /prompt is empty/);
});

test('without the real-generation switch a draw only produces a dry-run', async () => {
  const root = tempRoot();
  const service = createImageService({ config: imageConfig(), ledger: createLedger({ root }), root, run: fakeBridge() });
  const result = await service.generate({ prompt: '1girl', sessionId: 's1' });
  assert.equal(result.dryRun, true);
  assert.equal(result.realGeneration, false);
  assert.match(result.note, /allowRealGeneration/);
});

test('a zero quota denies before the bridge is invoked', async () => {
  const root = tempRoot();
  let invoked = false;
  const service = createImageService({
    config: imageConfig({ allowRealGeneration: true, quotas: { private_owner: 0 } }),
    ledger: createLedger({ root }),
    root,
    run: async (...args) => { invoked = true; return fakeBridge()(...args); },
  });
  const result = await service.generate({ prompt: '1girl', sessionId: 's1' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'MEDIA_QUOTA_DENIED');
  assert.equal(invoked, false);
});

test('a successful draw records an artifact, charges quota and replays idempotently', async () => {
  const root = tempRoot();
  const service = createImageService({
    config: imageConfig({ allowRealGeneration: true, quotas: { private_owner: 2 } }),
    ledger: createLedger({ root }),
    root,
    run: fakeBridge(),
  });
  const first = await service.generate({ prompt: '1girl, solo', sessionId: 's1' });
  assert.equal(first.ok, true, JSON.stringify(first.error));
  assert.equal(first.artifact.origin, 'novelai');
  assert.equal(first.artifact.width, 832);
  assert.ok(fs.existsSync(path.join(root, first.artifact.path)));
  assert.equal(first.quota.used, 1);

  const replay = await service.generate({ prompt: '1girl, solo', sessionId: 's1' });
  assert.equal(replay.replay, true);
  assert.equal(service.ledger.quotaUsed({ scope: 'private_owner' }), 1);
});

test('a failed draw refunds the quota, a timeout stays unknown without refund', async () => {
  const root = tempRoot();
  const failing = createImageService({
    config: imageConfig({ allowRealGeneration: true, quotas: { private_owner: 3 } }),
    ledger: createLedger({ root: path.join(root, 'a') }),
    root: path.join(root, 'a'),
    run: fakeBridge({ mode: 'fail' }),
  });
  const failure = await failing.generate({ prompt: '1girl', sessionId: 's1' });
  assert.equal(failure.ok, false);
  assert.equal(failure.refunded, true);
  assert.equal(failing.ledger.quotaUsed({ scope: 'private_owner' }), 0);

  const timingOut = createImageService({
    config: imageConfig({ allowRealGeneration: true, quotas: { private_owner: 3 } }),
    ledger: createLedger({ root: path.join(root, 'b') }),
    root: path.join(root, 'b'),
    run: fakeBridge({ mode: 'timeout' }),
  });
  const timeout = await timingOut.generate({ prompt: '1girl, solo', sessionId: 's1' });
  assert.equal(timeout.ok, false);
  assert.equal(timeout.error.code, 'MEDIA_TIMEOUT');
  assert.equal(timeout.refunded, false);
  const job = timingOut.ledger.listJobs(1)[0];
  assert.equal(job.state, 'unknown');
  const retry = await timingOut.generate({ prompt: '1girl, solo', sessionId: 's1' });
  assert.equal(retry.error.code, 'MEDIA_UNKNOWN_RESULT');
});

test('transparency is verified, not assumed, for sticker generation', async () => {
  const root = tempRoot();
  const service = createImageService({
    config: imageConfig({ allowRealGeneration: true }),
    ledger: createLedger({ root }),
    root,
    run: fakeBridge({ alpha: false }),
  });
  const result = await service.generate({ prompt: 'sticker, smile', source: 'sticker', straightAlpha: true, sessionId: 's1' });
  assert.equal(result.ok, true);
  assert.equal(result.artifact.meta.alpha, false);
  assert.match(result.artifact.meta.alphaWarning, /no alpha channel/);
});

// --- batching / delivery ----------------------------------------------------

test('aggregation deduplicates events and holds the window open for pictures', () => {
  let clock = 1000;
  const aggregator = createTurnAggregator({ trailingWindowMs: 7000, maxWaitMs: 15000, imageWindowMs: 8000, now: () => clock });
  assert.equal(aggregator.push('s', { eventId: 'e1', kind: 'text', text: '看这个', at: clock }).duplicated, false);
  assert.equal(aggregator.push('s', { eventId: 'e1', kind: 'text', text: '看这个', at: clock }).duplicated, true);
  assert.equal(aggregator.take('s'), null);
  clock += 7000;
  aggregator.push('s', { eventId: 'e2', kind: 'image', text: '', at: clock });
  clock += 7001;
  assert.equal(aggregator.take('s'), null, 'an image keeps the window open longer');
  clock += 1000;
  const batch = aggregator.take('s');
  assert.equal(batch.hasImage, true);
  assert.equal(batch.text, '看这个');
  assert.equal(batch.images.length, 1);
});

test('a failed inspection leaves a placeholder instead of caption-only text', () => {
  const text = composeTurnText({ text: '给你看', visionResults: [{ ok: false, error: { code: 'MEDIA_TIMEOUT' } }] });
  assert.match(text, /给你看/);
  assert.match(text, /没看清/);
  const described = composeTurnText({ text: '', visionResults: [{ ok: true, description: '白色背景上的红色圆形' }] });
  assert.match(described, /【图片内容】/);
});

test('delivery ordering keeps voice before text and voice_only does not duplicate it', () => {
  const ordered = orderItems([
    { kind: 'image' }, { kind: 'text' }, { kind: 'voice' },
  ], ['voice', 'at', 'text', 'face', 'image', 'other']);
  assert.deepEqual(ordered.map(item => item.kind), ['voice', 'text', 'image']);
  const plan = planDelivery({ sessionId: 's1', text: '晚安', voice: { artifactId: 'a', path: 'p', durationSeconds: 2 }, voiceOnly: true, mode: 'mock' });
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].kind, 'voice');
});

test('a mock channel can never claim a confirmed delivery', () => {
  const ledger = createLedger({ root: tempRoot() });
  const delivery = createDeliveryService({ ledger, mode: 'mock' });
  const receipt = delivery.record({ planId: 'p1', sessionId: 's1', channel: 'qq', target: '1', state: 'confirmed' });
  assert.equal(receipt.state, 'unknown');
  assert.equal(delivery.reconcile({ receipt }).action, 'ask-user');
  const real = createDeliveryService({ ledger, mode: 'onebot' });
  const confirmed = real.record({ planId: 'p2', sessionId: 's1', channel: 'qq', target: '1', state: 'confirmed', platformMessageId: '42' });
  assert.equal(confirmed.state, 'confirmed');
  assert.equal(confirmed.platformMessageId, '42');
});
