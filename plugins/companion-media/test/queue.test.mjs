import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadConfig, normalizeConfig } from '../config.mjs';
import { buildImageParams, buildBridgeRequest } from '../lib/imagegen.mjs';
import { tempRoot } from './helpers.mjs';

// The NovelAI queue service is a shared resource (st-chatu/novelai-queue on HF
// Spaces) that serialises concurrent generations. The media layer owns its
// settings; the bridge applies them in memory and never rewrites the old AstrBot
// config, so these tests pin the contract in both directions.

const QUEUE_URL = 'https://st-chatu-novelai-queue.hf.space';

test('the queue is enabled by default and points at the HF space', () => {
  const config = normalizeConfig({});
  assert.equal(config.image.queue.enabled, true);
  assert.equal(config.image.queue.baseUrl, QUEUE_URL);
  assert.equal(config.image.queue.failOpen, true);
  assert.equal(config.image.queue.userId, 'bobo-march7');
  assert.equal(config.image.queue.greeting, '三月七');
  assert.equal(config.image.queue.joinTimeoutSeconds, 180);
  assert.equal(config.image.queue.pollIntervalSeconds, 1.5);
  assert.equal(config.image.queue.requestTimeoutSeconds, 10);
});

test('every bridge request carries the queue block', () => {
  const config = normalizeConfig({ image: { queue: { enabled: true, baseUrl: QUEUE_URL, userId: 'tester' } } });
  const request = buildBridgeRequest({ mode: 'dry-run', params: buildImageParams({ prompt: 'x' }, config), config });
  assert.equal(request.queue.baseUrl, QUEUE_URL);
  assert.equal(request.queue.userId, 'tester');
  assert.equal(request.queue.enabled, true);
});

test('an operator can turn the queue off without touching the backend config', () => {
  const root = tempRoot();
  fs.mkdirSync(path.join(root, 'home/media'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'home/media/config.json'),
    JSON.stringify({ image: { queue: { enabled: false } } }),
    'utf8',
  );
  const { config } = loadConfig(root);
  assert.equal(config.image.queue.enabled, false);
  // Everything else keeps its default so the rest of the block still travels.
  const request = buildBridgeRequest({ mode: 'dry-run', params: buildImageParams({ prompt: 'x' }, config), config });
  assert.equal(request.queue.enabled, false);
  assert.equal(request.queue.baseUrl, QUEUE_URL);
});
