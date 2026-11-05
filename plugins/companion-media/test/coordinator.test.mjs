import assert from 'node:assert/strict';
import test from 'node:test';
import { createCoordinator } from '../lib/coordinator.mjs';
import { normalizeConfig } from '../config.mjs';

// The coordinator is single-flight: voice and vision share one GPU, so warming
// them "before or after" is fine but never at the same time. The idle watchdog
// must release the weights (including the in-memory model) after five quiet
// minutes, and any real media call must push that deadline back.

function fakeFetch(calls) {
  return async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null });
    if (url.endsWith('/health')) {
      return { ok: true, json: async () => ({ active: 'vision', busy: false, idle_seconds: 300, vision_models: ['nsfwvision-v3:q5'] }) };
    }
    if (url.endsWith('/unload')) return { ok: true, json: async () => ({ status: 'ok', active: null }) };
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(8), json: async () => ({}) };
  };
}

const baseConfig = normalizeConfig({});

test('a loaded idle backend does not block warming the other one', async () => {
  // The coordinator switches backends on POST; waiting for the other model to
  // unload first would deadlock, so only `busy` may hold a warm call back.
  const calls = [];
  const coordinator = createCoordinator({ config: baseConfig, fetchImpl: fakeFetch(calls) });
  const result = await coordinator.warm({ target: 'voice' });
  assert.equal(result.ok, true);
  assert.equal(result.switchedFrom, 'vision');
  assert.ok(calls.some(call => call.url.endsWith('/breeze/v1/audio/speech')));
});

test('a busy coordinator is waited out, and gives up with MEDIA_BACKEND_BUSY', async () => {
  const coordinator = createCoordinator({
    config: normalizeConfig({ runtime: { loadTimeoutMs: 60, pollIntervalMs: 10 } }),
    fetchImpl: async (url) => {
      if (url.endsWith('/health')) return { ok: true, json: async () => ({ active: 'breeze', busy: true }) };
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(8), json: async () => ({}) };
    },
  });
  await assert.rejects(() => coordinator.warm({ target: 'vision' }), /still busy/);
});

test('a dead coordinator is reported as unavailable, not as a model failure', async () => {
  // Live symptom on 2026-10-31: with 8139 stopped, speech failed with
  // "MEDIA_BACKEND_FAILED: fetch failed", which hides the real cause.
  const { unreachableBackend } = await import('../lib/errors.mjs');
  const mapped = unreachableBackend(new TypeError('fetch failed'), { what: 'Breeze TTS', baseUrl: 'http://127.0.0.1:8139/breeze' });
  assert.equal(mapped.code, 'MEDIA_BACKEND_UNAVAILABLE');
  assert.match(mapped.message, /127\.0\.0\.1:8139/);
  assert.match(mapped.message, /gpu_model_gateway/);
  // Anything that is not a connection problem stays with the caller.
  assert.equal(unreachableBackend(new Error('HTTP 500: boom'), { what: 'x', baseUrl: 'y' }), null);
});

test('a cold coordinator answering 504 is retried instead of reported as broken', async () => {
  // Observed on the live 8139: the first vision request during Ollama startup
  // returns 504. Warmup must ride that out.
  const calls = [];
  let attempts = 0;
  const coordinator = createCoordinator({
    config: normalizeConfig({ runtime: { warmRetry: { attempts: 3, delayMs: 1 } } }),
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.endsWith('/health')) return { ok: true, json: async () => ({ active: null, busy: false }) };
      if (url.endsWith('/ollama/api/generate')) {
        attempts += 1;
        if (attempts < 3) return { ok: false, status: 504, text: async () => 'Gateway Timeout' };
        return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
      }
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(8), json: async () => ({}) };
    },
  });
  const result = await coordinator.warm({ target: 'vision' });
  assert.equal(result.ok, true);
  assert.equal(attempts, 3, 'two 504s then a success');
});

test('warming vision sends the smallest real request to the vision route', async () => {
  const calls = [];
  const coordinator = createCoordinator({ config: baseConfig, fetchImpl: fakeFetch(calls) });
  const result = await coordinator.warm({ target: 'vision' });
  assert.equal(result.ok, true);
  assert.equal(result.target, 'vision');
  const generate = calls.find(call => call.url.endsWith('/ollama/api/generate'));
  assert.ok(generate, 'vision warmup must hit /ollama/api/generate');
  assert.equal(generate.method, 'POST');
  assert.equal(generate.body.model, baseConfig.vision.local.model);
  assert.equal(generate.body.stream, false);
  assert.deepEqual(generate.body.options, { num_predict: 1, temperature: 0 });
  assert.equal(result.idleReleaseSeconds, 300);
});

test('warming voice posts a one-character synthesis to the speech route', async () => {
  const calls = [];
  const coordinator = createCoordinator({ config: baseConfig, fetchImpl: fakeFetch(calls) });
  const result = await coordinator.warm({ target: 'voice' });
  assert.equal(result.ok, true);
  const speech = calls.find(call => call.url.endsWith('/breeze/v1/audio/speech'));
  assert.ok(speech, 'voice warmup must hit the TTS route');
  assert.equal(speech.body.voice, baseConfig.speech.backend.voice);
  assert.equal(speech.body.input.length, 1);
});

test('two warming calls never overlap, and a second one is refused while the first runs', async () => {
  const calls = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const fetchImpl = async (url, init = {}) => {
    calls.push(url);
    if (url.endsWith('/ollama/api/generate')) await gate;
    if (url.endsWith('/health')) {
      return { ok: true, json: async () => ({ active: null, busy: false, vision_models: [] }) };
    }
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(8), json: async () => ({}) };
  };
  const coordinator = createCoordinator({ config: baseConfig, fetchImpl });
  const first = coordinator.warm({ target: 'vision' });
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(() => coordinator.warm({ target: 'voice' }), /already warming vision/);
  release();
  const settled = await first;
  assert.equal(settled.ok, true);
  // Voice never started while vision was loading.
  assert.equal(calls.filter(url => url.endsWith('/breeze/v1/audio/speech')).length, 0);
});

test('the idle watchdog releases weights, and a new call pushes the deadline back', async () => {
  const calls = [];
  const coordinator = createCoordinator({
    config: normalizeConfig({ runtime: { idleReleaseSeconds: 0.05, pollIntervalMs: 10 } }),
    fetchImpl: fakeFetch(calls),
  });
  await coordinator.warm({ target: 'vision' });
  await new Promise(resolve => setTimeout(resolve, 120));
  const unloads = calls.filter(call => call.url.endsWith('/unload'));
  assert.equal(unloads.length, 1, 'exactly one idle release');

  // Touching the layer again re-arms the timer instead of unloading immediately.
  calls.length = 0;
  coordinator.touch();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(calls.filter(call => call.url.endsWith('/unload')).length, 0);
});

test('release is explicit and idempotent', async () => {
  const calls = [];
  const coordinator = createCoordinator({ config: baseConfig, fetchImpl: fakeFetch(calls) });
  await coordinator.warm({ target: 'vision' });
  const first = await coordinator.release();
  const second = await coordinator.release();
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(calls.filter(call => call.url.endsWith('/unload')).length, 2);
});

test('status reports the idle countdown without touching the model', async () => {
  const calls = [];
  const coordinator = createCoordinator({ config: baseConfig, fetchImpl: fakeFetch(calls) });
  await coordinator.warm({ target: 'vision' });
  const status = await coordinator.status();
  assert.equal(status.action, 'status');
  assert.equal(status.idleSeconds, 300);
  assert.equal(status.active, 'vision');
  assert.ok(status.idleRemainingSeconds <= 300);
  // status must not send a generation request
  assert.equal(calls.filter(call => call.url.includes('/api/generate')).length, 1);
});

test('an unknown target is rejected before any request', async () => {
  const calls = [];
  const coordinator = createCoordinator({ config: baseConfig, fetchImpl: fakeFetch(calls) });
  await assert.rejects(() => coordinator.warm({ target: 'image' }), /voice.*vision|vision.*voice/);
  assert.equal(calls.length, 0);
});
