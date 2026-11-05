// The bridge timeout must be wired through the public runtime, not only through the
// low-level drain function (independent review blocker #1). Two cases:
//   - below-min config is clamped to 1000ms by config.mjs;
//   - a legal 1200ms value is preserved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mountRuntime } from '../index.mjs';

const T0 = Date.parse('2026-10-28T01:00:00Z');

function makeRoot(t, configured) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mount-timeout-'));
  fs.mkdirSync(path.join(dir, 'home/companion'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'home/companion/runtime.config.json'), JSON.stringify({
    enabled: true, mode: 'active', bridge: { enabled: true, callTimeoutMs: configured },
  }));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* ignore */ } });
  return dir;
}

async function timeoutRun(t, configured) {
  const dir = makeRoot(t, configured);
  let release;
  const hung = { async ingestDomainEvent() { return new Promise((resolve) => { release = resolve; }); } };
  const healthy = { async ingestDomainEvent() { return { status: 'accepted', receiptId: 'rcpt_mount_timeout' }; } };
  const identity = { resolve() { return { userId: 'mount-timeout', personaId: 'bot', worldId: '' }; } };
  const ctx = { tools: { register() {} }, systemPrompt: { section() {} }, on() {}, get() { return undefined; } };
  const runtime = mountRuntime(ctx, dir, { memory: hung, identity, now: () => T0 });
  assert.equal(runtime.mode, 'active');
  const bound = identity.resolve('s1');
  runtime.requestMemoryIngest({ bound, sessionId: 's1', content: '合成内容：挂起超时集成', namespace: 'companion.event', realityStatus: 'actual_tool_activity', evidenceStatus: 'confirmed' });
  const startedAt = Date.now();
  const drained = await runtime.drainOutbox({ bound, sessionId: 's1' });
  const elapsedMs = Date.now() - startedAt;
  assert.equal(drained.processed, 1);
  assert.equal(drained.timedOut, 1);
  assert.equal(drained.skipped, 'drain-timeout');
  assert.equal(runtime.status({ bound }).outbox.queued, 1);
  release?.({ status: 'accepted', receiptId: 'late' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(runtime.status({ bound }).outbox.queued, 1, 'the late answer cannot write after the timeout');
  runtime.setMemory(healthy);
  const retried = await runtime.drainOutbox({ bound, sessionId: 's1' });
  assert.equal(retried.delivered, 1);
  runtime.dispose();
  return elapsedMs;
}

test('below-minimum 20ms config is clamped to 1000ms through the public runtime', async (t) => {
  const elapsedMs = await timeoutRun(t, 20);
  assert.ok(elapsedMs >= 900 && elapsedMs <= 2600, `elapsed ${elapsedMs}ms should reflect the clamped 1000ms timeout, not the 30s default`);
});

test('legal 1200ms config is preserved and applied through the public runtime', async (t) => {
  const elapsedMs = await timeoutRun(t, 1200);
  assert.ok(elapsedMs >= 1100 && elapsedMs <= 2800, `elapsed ${elapsedMs}ms should reflect 1200ms, not a fallback to 30s`);
});
