import test from 'node:test';
import assert from 'node:assert/strict';

import { createQueue } from '../queue.mjs';
import { createSentLog } from '../sent-log.mjs';
import { createSessions } from '../sessions.mjs';
import { isVoceChatPort, resolveVoceChatPort, watchVoceChatPort } from '../subscribe.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── queue ────────────────────────────────────────────────────────────────

test('the same room runs serially', async () => {
  const order = [];
  const queue = createQueue({ concurrency: 4 });
  const first = queue.run('room-a', async () => { order.push('a1-start'); await sleep(30); order.push('a1-end'); });
  const second = queue.run('room-a', async () => { order.push('a2-start'); order.push('a2-end'); });
  await Promise.all([first, second]);
  assert.deepEqual(order, ['a1-start', 'a1-end', 'a2-start', 'a2-end']);
});

test('different rooms run concurrently', async () => {
  const order = [];
  const queue = createQueue({ concurrency: 4 });
  await Promise.all([
    queue.run('room-a', async () => { order.push('a-start'); await sleep(30); order.push('a-end'); }),
    queue.run('room-b', async () => { order.push('b-start'); await sleep(30); order.push('b-end'); }),
  ]);
  // b must have started before a finished, otherwise this is serial across rooms.
  assert.equal(order[0].startsWith('a'), true);
  assert.equal(order[1].startsWith('b'), true);
});

test('global concurrency is honoured', async () => {
  let active = 0;
  let peak = 0;
  const queue = createQueue({ concurrency: 2 });
  const task = () => async () => {
    active += 1;
    peak = Math.max(peak, active);
    await sleep(20);
    active -= 1;
  };
  await Promise.all([1, 2, 3, 4, 5].map(i => queue.run(`room-${i}`, task())));
  assert.equal(peak <= 2, true, `peak was ${peak}, limit is 2`);
});

test('a full queue refuses instead of growing without bound', async () => {
  const queue = createQueue({ concurrency: 1, maxPending: 1 });
  const held = queue.run('room-a', () => sleep(50));
  const refused = await queue.run('room-b', async () => 'never');
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'queue-full');
  await held;
  assert.equal(queue.info().stats.rejected, 1);
});

test('a throwing task does not poison its room', async () => {
  const queue = createQueue({ concurrency: 1 });
  const bad = await queue.run('room-a', async () => { throw new Error('boom'); });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'task-threw');
  const good = await queue.run('room-a', async () => 'fine');
  assert.equal(good.ok, true);
  assert.equal(good.value, 'fine');
});

test('run never rejects, even for a broken task reference', async () => {
  const queue = createQueue();
  const result = await queue.run('room-a', null);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not-a-task');
});

test('info() reports the counters an operator needs', async () => {
  const queue = createQueue({ concurrency: 1, maxPending: 5 });
  await Promise.all([queue.run('a', async () => 1), queue.run('b', async () => 2)]);
  const info = queue.info();
  assert.equal(info.stats.completed, 2);
  assert.equal(info.pending, 0);
  assert.equal(info.cap, 5);
  assert.equal(info.rooms, 0, 'idle rooms are forgotten');
});

// ── sentLog ──────────────────────────────────────────────────────────────

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vc-sentlog-'));
}

test('sentLog records sends, skips, and undelivered turns', () => {
  const log = createSentLog({ dataRoot: tempRoot() });
  log.sent({ room: 'vc-chan-1', target: { channel: 1 }, mid: 5, text: 'hello', phase: 'final' });
  log.skipped({ room: 'vc-chan-1', mid: 6, reason: 'user-not-allowed:9', fromUid: 9 });
  log.undelivered({ room: 'vc-dm-1', mid: 7, reason: 'turn-timeout' });
  const lines = fs.readFileSync(log.file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(lines[0].kind, 'sent');
  assert.equal(lines[0].mid, 5);
  assert.equal(lines[1].kind, 'skipped');
  assert.equal(lines[1].reason, 'user-not-allowed:9');
  assert.equal(lines[2].kind, 'undelivered');
});

test('sentLog keeps only a short preview, never the whole message', () => {
  const log = createSentLog({ dataRoot: tempRoot() });
  log.sent({ room: 'r', text: '字'.repeat(300), phase: 'final' });
  const row = JSON.parse(fs.readFileSync(log.file, 'utf8').trim());
  assert.equal(row.chars, 300);
  assert.equal(row.preview.length <= 61, true);
});

test('sentLog refuses a relative dataRoot rather than writing somewhere surprising', () => {
  assert.throws(() => createSentLog({ dataRoot: 'relative/path' }), error => /绝对路径/.test(error.message));
});

test('a failed send is recorded with its error, not swallowed', () => {
  const log = createSentLog({ dataRoot: tempRoot() });
  log.sent({ room: 'r', text: 'x', ok: false, error: 'unauthorized' });
  const row = JSON.parse(fs.readFileSync(log.file, 'utf8').trim());
  assert.equal(row.ok, false);
  assert.equal(row.error, 'unauthorized');
});

// ── sessions ─────────────────────────────────────────────────────────────

function fakeHarness({ existing = null, createThrows = null, resumeThrows = null } = {}) {
  const calls = [];
  let live = existing;
  const agents = {
    get: id => { calls.push(['get', id]); return live ?? undefined; },
    create: async options => {
      calls.push(['create', options.sessionId]);
      if (createThrows) throw createThrows;
      return { agent: { session: { id: options.sessionId } } };
    },
    resume: async options => {
      calls.push(['resume', options.resumeSessionId]);
      if (resumeThrows) throw resumeThrows;
      live = { session: { id: options.resumeSessionId }, ctx: { on() {} } };
      return { agent: live };
    },
  };
  const agentPresets = {
    resolve: async id => ({ id }),
    mount: async () => {},
  };
  return { agents, agentPresets, calls };
}

test('sessions.ensure returns a live agent without creating a second one', async () => {
  const live = { session: { id: 'vc-chan-1' }, ctx: { on() {} } };
  const { agents, agentPresets, calls } = fakeHarness({ existing: live });
  const setup = [];
  const sessions = createSessions({
    agents, agentPresets, setupPerAgent: (ctx, agent, id) => setup.push([ctx === live.ctx, agent === live, id]),
  });
  const result = await sessions.ensure({ sessionId: 'vc-chan-1', presetId: 'companion', cwd: 'C:/x', provider: 'p', model: 'm' });
  assert.equal(result.agent, live);
  assert.equal(result.resumed, true);
  assert.equal(result.created, false);
  assert.equal(calls.filter(c => c[0] === 'create').length, 0);
  assert.deepEqual(setup, [[true, true, 'vc-chan-1']]);
});

test('sessions.ensure creates a fresh session when none exists', async () => {
  const { agents, agentPresets, calls } = fakeHarness();
  const sessions = createSessions({ agents, agentPresets, setupPerAgent: () => {} });
  const result = await sessions.ensure({ sessionId: 'vc-chan-2', presetId: 'companion', cwd: 'C:/x', provider: 'p', model: 'm' });
  assert.equal(result.created, true);
  assert.deepEqual(calls.map(c => c[0]), ['get', 'create']);
});

test('an "already exists" create falls back to resume, not to a hard failure', async () => {
  const { agents, agentPresets, calls } = fakeHarness({ createThrows: new Error('session vc-chan-3 already exists') });
  const sessions = createSessions({
    agents, agentPresets, setupPerAgent: () => {},
    // The retry backoff is real (1.5s × attempt); shrink it for the test by hitting the live path:
    // `resume` sets `live`, so the very next `get` finds it and no sleep is paid beyond one.
    log: () => {},
  });
  // Patch the first retry: `resume` returns a live agent immediately.
  const result = await sessions.ensure({ sessionId: 'vc-chan-3', presetId: 'companion', cwd: 'C:/x', provider: 'p', model: 'm' });
  assert.equal(result.resumed, true);
  assert.equal(calls.some(c => c[0] === 'resume'), true);
});

test('a create failure that is NOT "already exists" surfaces immediately', async () => {
  const { agents, agentPresets, calls } = fakeHarness({ createThrows: new Error('preset not found') });
  const sessions = createSessions({ agents, agentPresets, setupPerAgent: () => {} });
  await assert.rejects(
    sessions.ensure({ sessionId: 'vc-chan-4', presetId: 'nope', cwd: 'C:/x', provider: 'p', model: 'm' }),
    error => /preset not found/.test(error.message),
  );
  assert.equal(calls.some(c => c[0] === 'resume'), false, 'a validation error must not be retried');
});

test('sessions refuses to construct without agents or presets', () => {
  assert.throws(() => createSessions({ agents: null, agentPresets: {} }), /agents 不可用/);
  // `agents` must look usable for the presets check to be the one that fires.
  assert.throws(
    () => createSessions({ agents: { create: async () => {} }, agentPresets: null }),
    /agentPresets 不可用/,
  );
});

// ── subscribe ────────────────────────────────────────────────────────────

const SYMBOL = Symbol.for('dsh.companion.ports.v1');

// process, not globalThis: that is where the real publishers write (see subscribe.mjs).
function registry() {
  if (!(process[SYMBOL] instanceof Map)) process[SYMBOL] = new Map();
  return process[SYMBOL];
}

function publishFake(root, service, { name = 'companionVoceChat', ready = () => true } = {}) {
  const map = registry();
  const key = `${name}\u0000${root}`;
  map.set(key, { name, service, ready, publishedAt: Date.now() });
  map.set(root, { name, service, ready, publishedAt: Date.now() });
}

function clearRegistry() {
  registry().clear();
}

test('isVoceChatPort requires send + subscribe + info', () => {
  assert.equal(isVoceChatPort({ send() {}, subscribe() {}, info() {} }), true);
  assert.equal(isVoceChatPort({ send() {} }), false);
  assert.equal(isVoceChatPort(null), false);
  assert.equal(isVoceChatPort('x'), false);
});

test('resolveVoceChatPort finds a published service by its namespaced key', () => {
  clearRegistry();
  const service = { send() {}, subscribe() {}, info() {} };
  publishFake('D:\\DSH\\dsh-production\\data', service);
  const found = resolveVoceChatPort({ root: 'D:\\DSH\\dsh-production\\data' });
  assert.equal(found, service);
});

test('resolveVoceChatPort refuses an object that merely sits on the bare key', () => {
  clearRegistry();
  // The health service lives on the bare key in production; asking for ours must not return it.
  const health = { status: async () => ({ ok: true }) };
  registry().set('D:\\data', { name: 'companionHealth', service: health, ready: () => true });
  assert.equal(resolveVoceChatPort({ root: 'D:\\data' }), null);
});

test('resolveVoceChatPort skips an unready publisher', () => {
  clearRegistry();
  const service = { send() {}, subscribe() {}, info() {} };
  publishFake('D:\\data2', service, { ready: () => false });
  assert.equal(resolveVoceChatPort({ root: 'D:\\data2' }), null);
});

test('watchVoceChatPort fires immediately when the port already exists', () => {
  clearRegistry();
  const service = { send() {}, subscribe() {}, info() {} };
  publishFake('D:\\data3', service);
  const seen = [];
  const watcher = watchVoceChatPort({ root: 'D:\\data3', onFound: p => seen.push(p) });
  assert.deepEqual(seen, [service]);
  assert.equal(watcher.port, service);
  watcher.stop();
});

test('watchVoceChatPort keeps looking and fires exactly once when it appears', async () => {
  clearRegistry();
  const service = { send() {}, subscribe() {}, info() {} };
  const seen = [];
  const watcher = watchVoceChatPort({ root: 'D:\\data4', retryMs: 20, onFound: p => seen.push(p) });
  assert.deepEqual(seen, []);
  await sleep(10);
  publishFake('D:\\data4', service);
  await sleep(60);
  assert.deepEqual(seen, [service]);
  // Publishing a second one must not fire again.
  publishFake('D:\\data4', { send() {}, subscribe() {}, info() {} });
  await sleep(60);
  assert.equal(seen.length, 1);
  watcher.stop();
});
