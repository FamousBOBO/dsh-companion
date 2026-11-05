// `health-service-ref.mjs`: how a sibling plugin row finds the health service.
//
// Written after a production incident (2026-11-04): the health service was published only with
// `ctx.provide`, and in this composition the foundation and the Studio bundle are *siblings* of the
// health row, so both consumers answered `health-not-mounted` / `health-unavailable` while the
// service itself was running fine. These tests pin the bridge path that fixes it.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  HEALTH_SERVICE_NAME, publishHealthService, resolveHealthService,
} from './health-service-ref.mjs';
import { createServiceBridge } from './service-bridge.mjs';

function tempRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-ref-test-'));
  fs.mkdirSync(path.join(dir, 'home'), { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('companionHealth is an allowed bridge port', () => {
  assert.equal(HEALTH_SERVICE_NAME, 'companionHealth');
  // The allow-list is what makes `resolve` answer anything at all; an unknown name is always null.
  assert.equal(createServiceBridge(process.cwd()).resolve('somethingElse'), null);
});

test('a published service is resolvable from another plugin and gone after release', t => {
  const root = tempRoot(t);
  const service = { pulsePrompt: async () => ({ ok: true, text: '' }) };
  const release = publishHealthService(root, service);
  assert.equal(resolveHealthService(null, root), service);
  assert.equal(createServiceBridge(root).resolve(HEALTH_SERVICE_NAME), service);
  release();
  assert.equal(resolveHealthService(null, root), null);
  // Releasing twice is harmless.
  release();
});

test('the consumer context wins when it can see the service itself', t => {
  const root = tempRoot(t);
  const fromCtx = { tag: 'ctx' };
  const published = { tag: 'bridge' };
  const release = publishHealthService(root, published);
  t.after(release);
  const ctx = { get: name => (name === HEALTH_SERVICE_NAME ? fromCtx : undefined) };
  assert.equal(resolveHealthService(ctx, root), fromCtx);
  // A ctx that throws must fall through to the bridge instead of breaking the caller.
  const hostile = { get: () => { throw new Error('no such realm'); } };
  assert.equal(resolveHealthService(hostile, root), published);
});

test('a provider that reports itself not-ready is skipped rather than handed out', t => {
  const root = tempRoot(t);
  const release = publishHealthService(root, { tag: 'not-ready' }, { ready: () => false });
  t.after(release);
  assert.equal(resolveHealthService(null, root), null);
});

test('without a publish, resolution is a quiet null (never a throw)', t => {
  const root = tempRoot(t);
  assert.equal(resolveHealthService(null, root), null);
  assert.equal(resolveHealthService({}, root), null);
  // A root that does not exist must not make the resolver explode either.
  assert.equal(resolveHealthService(null, path.join(root, 'nope', 'deeper')), null);
});
