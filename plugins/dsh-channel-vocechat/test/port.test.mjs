import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createPort } from '../port.mjs';

/** Minimal collaborators: this file tests the port contract, not the pieces under it. */
function makePort(overrides = {}) {
  const sent = [];
  const gaps = [];
  let cursor = 0;
  const store = {
    recordGap: (reason, detail) => { gaps.push({ reason, detail }); return true; },
    setCursor: mid => { cursor = mid; return true; },
    getCursor: () => cursor,
    seenSize: () => 0,
    eventsFile: 'events.jsonl',
    gapFile: 'gap.jsonl',
    ...overrides.store,
  };
  const api = {
    send: async (target, text, contentType) => { sent.push({ target, text, contentType }); return { mid: 7 }; },
    history: async () => [{ mid: 5 }],
    channel: async () => ({ gid: 1, members: [1, 2, 4] }),
    contacts: async () => [{ uid: 1 }],
    me: async () => ({ uid: 4, name: 'companion' }),
    status: async () => ({ ok: true, uid: 4, latencyMs: 5 }),
    describe: () => ({ origin: 'http://127.0.0.1:3009', timeoutMs: 15000 }),
    ...overrides.api,
  };
  const sse = {
    info: () => ({
      running: true,
      cursor: 232,
      counters: {
        connects: 1, disconnects: 0, renewals: 0, chat: 6, skipped: 4,
        rejected: 0, duplicates: 0, errors: 0, lastError: null, lastFrameAt: Date.now(),
      },
    }),
    ...overrides.sse,
  };
  const auth = {
    describe: () => ({
      uid: 4, origin: 'http://127.0.0.1:3009', hasAccessToken: true, hasRefreshToken: true,
      expiresAt: Date.now() + 240000, source: 'vocechat-db', stats: { renewals: 1, failures: 0, readFromDb: 1, readFromFile: 0 },
    }),
    ...overrides.auth,
  };
  const config = { uid: 4, deviceName: 'dsh-companion', outbound: { maxChars: 4000 } };
  const built = createPort({ api, store, sse, auth, config, health: overrides.health });
  return { ...built, sent, gaps, store };
}

const event = mid => ({ mid, fromUid: 1, target: { channel: 1 }, content: 'x', kind: 'chat' });

test('send delegates to the API with the discriminated target', async () => {
  const port = makePort();
  const result = await port.service.send({ channel: 1 }, 'hello');
  assert.deepEqual(result, { mid: 7 });
  assert.deepEqual(port.sent[0].target, { channel: 1 });
  assert.equal(port.sent[0].contentType, 'text/plain');
});

test('subscribe returns an idempotent unsubscribe', async () => {
  const port = makePort();
  const seen = [];
  const off = port.service.subscribe(e => seen.push(e.mid));
  await port.dispatch(event(1));
  assert.deepEqual(seen, [1]);
  off();
  off();
  await port.dispatch(event(2));
  assert.deepEqual(seen, [1]);
  assert.equal(port.subscriberCount(), 0);
});

test('subscribers are called serially in registration order', async () => {
  const port = makePort();
  const order = [];
  port.service.subscribe(async () => {
    await new Promise(r => setTimeout(r, 20));
    order.push('first');
  });
  port.service.subscribe(() => order.push('second'));
  await port.dispatch(event(3));
  assert.deepEqual(order, ['first', 'second']);
});

test('one throwing subscriber does not swallow the event for the others', async () => {
  const port = makePort();
  const seen = [];
  port.service.subscribe(() => { throw new Error('boom'); });
  port.service.subscribe(e => seen.push(e.mid));
  await port.dispatch(event(4));
  assert.deepEqual(seen, [4]);
  assert.equal(port.gaps.length, 1);
  assert.equal(port.gaps[0].reason, 'subscriber-failed');
  assert.equal(port.gaps[0].detail.mid, 4);
});

test('the port does NOT move the cursor: the SSE loop owns that', async () => {
  // In V1 the port advanced the cursor after dispatch. In V2 the SSE client does it, because
  // only the reader knows when the frame was actually consumed. Keeping it in one place avoids
  // two writers racing on last-processed.json.
  const port = makePort();
  port.service.subscribe(() => {});
  await port.dispatch(event(5));
  assert.equal(port.store.getCursor(), 0, 'the port must not touch the cursor');
});

test('the new read verbs are exposed and delegate', async () => {
  const port = makePort();
  assert.deepEqual(await port.service.history({ channel: 1 }, { limit: 3 }), [{ mid: 5 }]);
  assert.equal((await port.service.channel(1)).members.length, 3);
  assert.equal((await port.service.contacts()).length, 1);
  assert.equal((await port.service.me()).uid, 4);
});

test('info() reports facts and never a credential', () => {
  const port = makePort();
  const info = port.service.info();
  assert.equal(info.uid, 4);
  assert.equal(info.deviceName, 'dsh-companion');
  assert.equal(info.sse.running, true);
  assert.equal(info.sse.cursor, 232);
  assert.equal(info.auth.source, 'vocechat-db');
  assert.equal(info.subscribers, 0);
  const text = JSON.stringify(info);
  assert.equal(text.includes('after_mid'), false);
  assert.equal(text.includes('api-key'), false);
});

test('a custom health probe takes precedence over the raw API status', async () => {
  const health = async () => ({ ok: false, state: 'degraded', reasons: ['sse-not-running'] });
  const port = makePort({ health });
  const status = await port.service.status();
  assert.equal(status.ok, false);
  assert.equal(status.state, 'degraded');
});

test('health reports three independent halves', async () => {
  const { createHealthProbe } = await import('../health.mjs');
  const probe = createHealthProbe({
    api: { status: async () => ({ ok: true, uid: 4, latencyMs: 3 }) },
    sse: { info: () => ({ running: true, cursor: 232, counters: { connects: 1, disconnects: 0, chat: 6, skipped: 4, errors: 0, rejected: 0, lastFrameAt: Date.now() } }) },
    auth: { describe: () => ({ uid: 4, hasAccessToken: true, hasRefreshToken: true, expiresAt: Date.now() + 240000, source: 'db', stats: { renewals: 1, failures: 0 } }) },
    enabled: true,
  });
  const result = await probe();
  assert.equal(result.ok, true);
  assert.equal(result.state, 'ok');
  // The three halves are separately visible, which is the point.
  assert.equal(result.outbound.ok, true);
  assert.equal(result.inbound.running, true);
  assert.equal(result.auth.hasAccessToken, true);
});

test('an expired access token degrades health even when the stream is up', async () => {
  const { createHealthProbe } = await import('../health.mjs');
  const probe = createHealthProbe({
    api: { status: async () => ({ ok: true, uid: 4, latencyMs: 3 }) },
    sse: { info: () => ({ running: true, cursor: 1, counters: { connects: 1, disconnects: 0, chat: 0, skipped: 0, errors: 0, rejected: 0, lastFrameAt: Date.now() } }) },
    auth: { describe: () => ({ uid: 4, hasAccessToken: true, hasRefreshToken: true, expiresAt: Date.now() - 1000, source: 'db', stats: { renewals: 0, failures: 0 } }) },
    enabled: true,
  });
  const result = await probe();
  assert.equal(result.ok, false);
  assert.ok(result.reasons.includes('access-token-expired'));
});

test('disabled health says so instead of reporting a failure', async () => {
  const { createHealthProbe } = await import('../health.mjs');
  const probe = createHealthProbe({
    api: { status: async () => ({ ok: true }) },
    sse: { info: () => ({ running: false, cursor: 0, counters: { connects: 0, disconnects: 0, chat: 0, skipped: 0, errors: 0, rejected: 0, lastFrameAt: null } }) },
    auth: { describe: () => ({ uid: 0, hasAccessToken: false, hasRefreshToken: false, expiresAt: null, source: 'none', stats: { renewals: 0, failures: 0 } }) },
    enabled: false,
  });
  const result = await probe();
  assert.equal(result.state, 'disabled');
  assert.deepEqual(result.reasons, ['disabled']);
});
