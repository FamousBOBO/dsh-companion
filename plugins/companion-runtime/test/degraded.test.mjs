import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mountRuntime } from '../index.mjs';
import { createDb } from '../lib/db.mjs';

const T0 = Date.UTC(2026, 9, 29, 2, 0, 0);

function buildRoot(t, { config = { enabled: true, mode: 'active' }, rawConfig = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-degraded-'));
  for (const dir of ['home/companion', 'home/memory', 'logs']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, 'home/companion/identity.json'), JSON.stringify({
    schemaVersion: 1, persona: 'march7', owner: { id: 'owner-1', displayName: 'o', platform: 'qq' },
    desktop: { mode: 'local-owner', userId: 'owner-1' }, sessions: {},
  }));
  fs.writeFileSync(path.join(root, 'home/companion/memory.config.json'), JSON.stringify({
    schemaVersion: 1, backend: 'sqlite', injection: { budgetChars: 2400 }, extraction: { enabled: false },
    embedding: { provider: 'local', dimensions: 128 }, wiki: { enabled: false },
  }));
  if (rawConfig !== null) fs.writeFileSync(path.join(root, 'home/companion/runtime.config.json'), rawConfig);
  else fs.writeFileSync(path.join(root, 'home/companion/runtime.config.json'), JSON.stringify(config));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });
  return root;
}

const identity = () => ({ resolve: sessionId => ({ userId: 'owner-1', persona: 'march7', sessionId }) });
const ctx = () => ({ tools: { register() {} }, systemPrompt: { section() {} }, on() {}, get() { return undefined; } });

test('A11: a missing memory service degrades injection and never throws in the chat path', t => {
  const root = buildRoot(t);
  const runtime = mountRuntime(ctx(), root, { memory: null, identity: identity(), now: () => T0 });
  assert.equal(runtime.mode, 'active');
  const injected = runtime.injectionFor({ sessionId: 'session-a' });
  assert.equal(injected.text, '');
  assert.equal(injected.state, 'memory-unavailable');
  const created = runtime.proposeGoal({ sessionId: 'session-a', title: '修屋顶' });
  assert.equal(created.ok, true, 'goal state does not depend on the memory service');
  const status = runtime.status({ sessionId: 'session-a' });
  assert.equal(status.memory.available, false);
  assert.equal(status.injection.state, 'memory-unavailable');
  runtime.dispose();
});

test('A11: a memory service that throws is reported, not turned into a fake success', async t => {
  const root = buildRoot(t);
  const throwing = { version: 'broken', async ingestDomainEvent() { throw new Error('memory db is locked'); } };
  const runtime = mountRuntime(ctx(), root, { memory: throwing, identity: identity(), now: () => T0 });
  runtime.recordEvent({ kind: 'memory/ingest-request', sessionId: 'session-a', occurredAt: T0, payload: { namespace: 'companion.event', content: '合成本地测试内容', rootEvidenceIds: ['ev-1'] } });
  const drained = await runtime.drainOutbox({ sessionId: 'session-a' });
  assert.equal(drained.delivered, 0, JSON.stringify(drained));
  assert.ok(drained.retryable >= 1, JSON.stringify(drained));
  const db = createDb({ file: path.join(root, 'home/companion/companion-runtime.db'), now: () => T0 });
  const rows = db.all('SELECT status, attempts, last_error FROM memory_outbox ORDER BY created_at');
  assert.ok(rows.length >= 1, 'the outbox keeps the request');
  assert.ok(rows.every(row => row.status === 'queued'), 'nothing is marked delivered');
  assert.ok(rows.every(row => row.attempts >= 1 && row.last_error.length > 0), 'the failure reason is recorded');
  db.close();
  runtime.dispose();
});

test('A11: an unusable database file leaves the runtime inert but diagnosable', t => {
  const root = buildRoot(t);
  const runtime = mountRuntime(ctx(), root, { memory: null, identity: identity(), dbFile: path.join(root, 'home/companion'), now: () => T0 });
  assert.equal(runtime.mode, 'off');
  assert.equal(runtime.writable, false);
  const status = runtime.status({ sessionId: 'session-a' });
  assert.equal(status.mode, 'off');
  assert.ok(status.errors.length >= 1, JSON.stringify(status.errors));
  assert.ok(status.errors.some(error => error.code === 'db-unavailable'));
  assert.equal(runtime.proposeGoal({ sessionId: 'session-a', title: 'x' }).ok, false);
  assert.equal(runtime.injectionFor({ sessionId: 'session-a' }).text, '');
  runtime.dispose();
});

test('A11: corrupt config falls back to inert defaults and records why', t => {
  const root = buildRoot(t, { rawConfig: '{ this is not json' });
  const runtime = mountRuntime(ctx(), root, { memory: null, identity: identity(), now: () => T0 });
  assert.equal(runtime.mode, 'off');
  const status = runtime.status({});
  assert.ok(status.errors.some(error => error.code === 'config-invalid'), JSON.stringify(status.errors));
  runtime.dispose();
});

test('A11: an identity failure is handled as unbound, not as an exception or a guessed user', t => {
  const root = buildRoot(t);
  const runtime = mountRuntime(ctx(), root, { memory: null, identity: { resolve() { throw new Error('identity.json missing'); } }, now: () => T0 });
  assert.equal(runtime.proposeGoal({ sessionId: 'session-a', title: 'x' }).code, 'unbound');
  assert.equal(runtime.injectionFor({ sessionId: 'session-a' }).text, '');
  assert.equal(runtime.recordEvent({ kind: 'state/impulse', sessionId: 'session-a', payload: { amount: 0.1 } }).code, 'unbound');
  assert.equal(runtime.status({ sessionId: 'session-a' }).mode, 'active', 'diagnostics still answer');
  runtime.dispose();
});

test('A11: disposing twice and disposing an inert runtime are safe', t => {
  const root = buildRoot(t);
  const runtime = mountRuntime(ctx(), root, { memory: null, identity: identity(), now: () => T0 });
  assert.equal(runtime.dispose().ok, true);
  assert.equal(runtime.dispose().ok, true);
  const off = mountRuntime(ctx(), buildRoot(t), { config: { enabled: false }, now: () => T0 });
  assert.equal(off.dispose().ok, true);
});
