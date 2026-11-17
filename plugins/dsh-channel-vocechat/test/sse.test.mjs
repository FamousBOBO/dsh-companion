import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSseClient, isChatFrame } from '../sse.mjs';
import { createStore } from '../store.mjs';

function tempStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-sse-'));
  return createStore({ dataRoot: root });
}

const encoder = new TextEncoder();

/**
 * A fake SSE stream: delivers `frames`, then behaves according to `after`.
 *
 *   'hang'  — resolve never (a live connection that has gone quiet). This is the realistic case:
 *             the loop must stay parked instead of reconnecting forever.
 *   'close' — end the stream immediately (a server-side disconnect).
 */
function stream(frames, { after = 'hang' } = {}) {
  let index = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          async read() {
            if (index >= frames.length) {
              if (after === 'hang') return new Promise(() => {});
              return { done: true, value: undefined };
            }
            const frame = frames[index++];
            const payload = typeof frame === 'string' ? frame : `data: ${JSON.stringify(frame)}\n\n`;
            return { done: false, value: encoder.encode(payload) };
          },
          cancel() {},
        };
      },
    },
  };
}

const chatFrame = (mid, extra = {}) => ({
  created_at: 1794892571813,
  detail: { content: `msg ${mid}`, content_type: 'text/plain', expires_in: null, properties: null, type: 'normal' },
  domain: null,
  from_uid: 1,
  mid,
  target: { gid: 1 },
  widget_id: null,
  type: 'chat',
  ...extra,
});

const fakeAuth = () => ({
  token: async () => 'A1',
  refreshNow: async () => 'A2',
  describe: () => ({ uid: 4, hasAccessToken: true, hasRefreshToken: true, expiresAt: Date.now() + 1000, source: 'test', stats: { renewals: 1, failures: 0 } }),
});

/**
 * Run one client until `until()` is true (or a timeout), then stop it.
 * `start()` never resolves while the loop is healthy, so every test must bound it.
 */
async function runClient(client, { until = null, timeoutMs = 3000 } = {}) {
  client.start();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (until && until()) break;
    await new Promise(r => setTimeout(r, 10));
  }
  await client.stop({ stopTimeoutMs: 120 });
}

test('isChatFrame separates messages from state sync', () => {
  assert.equal(isChatFrame(chatFrame(1)), true);
  for (const type of ['users_snapshot', 'ready', 'heartbeat', 'user_settings', 'server_config_changed']) {
    assert.equal(isChatFrame({ type }), false, `${type} must not be treated as a message`);
  }
  assert.equal(isChatFrame(null), false);
});

test('chat frames are normalized, claimed, dispatched, and move the cursor', async () => {
  const store = tempStore();
  const seen = [];
  const client = createSseClient({
    baseUrl: 'http://x',
    auth: fakeAuth(),
    store,
    onEvent: event => seen.push(event.mid),
    fetchImpl: async () => stream([chatFrame(10), chatFrame(11)]),
  });

  await runClient(client, { until: () => seen.length >= 2 });
  assert.deepEqual(seen, [10, 11]);
  assert.equal(store.getCursor(), 11);
  assert.equal(store.claim(10), false, 'mid 10 must be remembered as handled');
});

test('state-sync frames are counted as skipped, not as errors', async () => {
  const store = tempStore();
  const client = createSseClient({
    baseUrl: 'http://x',
    auth: fakeAuth(),
    store,
    onEvent: () => { throw new Error('should not be called'); },
    fetchImpl: async () => stream([
      { type: 'users_snapshot', users: [] },
      { type: 'ready' },
      { type: 'heartbeat' },
    ]),
  });
  await runClient(client, { until: () => client.info().counters.skipped >= 3 });
  const info = client.info();
  assert.equal(info.counters.chat, 0);
  assert.equal(info.counters.skipped, 3);
  assert.equal(info.counters.errors, 0);
});

test('a re-delivered mid is refused as a duplicate (after_mid can resend the boundary frame)', async () => {
  const store = tempStore();
  const seen = [];
  const client = createSseClient({
    baseUrl: 'http://x',
    auth: fakeAuth(),
    store,
    onEvent: event => seen.push(event.mid),
    fetchImpl: async () => stream([chatFrame(20), chatFrame(20)]),
  });
  await runClient(client, { until: () => client.info().counters.duplicates >= 1 });
  assert.deepEqual(seen, [20]);
  assert.equal(client.info().counters.duplicates, 1);
});

test('the connection resumes from the stored cursor', async () => {
  const store = tempStore();
  store.setCursor(99);
  const urls = [];
  const client = createSseClient({
    baseUrl: 'http://127.0.0.1:3009',
    auth: fakeAuth(),
    store,
    onEvent: () => {},
    fetchImpl: async url => { urls.push(url); return stream([]); },
  });
  await runClient(client, { until: () => urls.length >= 1 });
  assert.equal(urls.length, 1, 'a parked stream must not be reconnected');
  assert.match(urls[0], /after_mid=99/);
  assert.match(urls[0], /^http:\/\/127\.0\.0\.1:3009\/api\/user\/events/);
});

test('401 triggers a synchronous renewal, and does NOT retry the same URL', async () => {
  const store = tempStore();
  let renewals = 0;
  const urls = [];
  const auth = {
    token: async () => 'expired',
    refreshNow: async () => { renewals += 1; return 'fresh'; },
    describe: () => ({}),
  };
  const client = createSseClient({
    baseUrl: 'http://x',
    auth,
    store,
    onEvent: () => {},
    reconnectBaseMs: 10,
    reconnectMaxMs: 10,
    fetchImpl: async url => {
      urls.push(url);
      if (urls.length === 1) return { ok: false, status: 401, text: async () => 'authorization error' };
      return stream([]);
    },
  });
  await runClient(client, { until: () => urls.length >= 2, timeoutMs: 1000 });
  assert.equal(renewals, 1, '401 must renew exactly once per attempt');
  assert.equal(urls.length, 2, 'it must reconnect after renewing, exactly once');
});

test('a throwing consumer is recorded as a gap but does not stop the stream', async () => {
  const store = tempStore();
  const seen = [];
  const client = createSseClient({
    baseUrl: 'http://x',
    auth: fakeAuth(),
    store,
    onEvent: event => {
      if (event.mid === 30) throw new Error('boom');
      seen.push(event.mid);
    },
    fetchImpl: async () => stream([chatFrame(30), chatFrame(31)]),
  });
  await runClient(client, { until: () => seen.length >= 1 });
  assert.deepEqual(seen, [31], 'the next frame must still be delivered');
  assert.equal(client.info().counters.errors, 1);
  const text = fs.readFileSync(store.gapFile, 'utf8').trim();
  assert.equal(JSON.parse(text.split('\n')[0]).reason, 'sse-consumer-threw');
});

test('a malformed chat frame is rejected and leaves a gap with a reason', async () => {
  const store = tempStore();
  const client = createSseClient({
    baseUrl: 'http://x',
    auth: fakeAuth(),
    store,
    onEvent: () => {},
    fetchImpl: async () => stream([{ type: 'chat', from_uid: 1, target: { gid: 1 } }]), // no mid
  });
  await runClient(client, { until: () => client.info().counters.rejected >= 1 });
  assert.equal(client.info().counters.rejected, 1);
  const text = fs.readFileSync(store.gapFile, 'utf8').trim();
  assert.equal(JSON.parse(text.split('\n')[0]).reason, 'sse-normalize-rejected');
});

test('a non-JSON data line is skipped without taking the stream down', async () => {
  const store = tempStore();
  const seen = [];
  const client = createSseClient({
    baseUrl: 'http://x',
    auth: fakeAuth(),
    store,
    onEvent: e => seen.push(e.mid),
    fetchImpl: async () => stream(['data: not-json\n\n', `data: ${JSON.stringify(chatFrame(40))}\n\n`]),
  });
  await runClient(client, { until: () => seen.length >= 1 });
  assert.deepEqual(seen, [40]);
});

test('start is idempotent and stop is safe to call twice', async () => {
  const store = tempStore();
  let connections = 0;
  const client = createSseClient({
    baseUrl: 'http://x',
    auth: fakeAuth(),
    store,
    onEvent: () => {},
    fetchImpl: async () => { connections += 1; return stream([]); },
  });
  const first = client.start();
  const second = client.start();
  assert.equal(first, second, 'the second start must return the same promise, not a second loop');
  await new Promise(r => setTimeout(r, 40));
  await client.stop({ stopTimeoutMs: 120 });
  await client.stop({ stopTimeoutMs: 120 });
  assert.equal(connections, 1);
});

test('handleFrame lets a test feed frames without a stream', () => {
  const store = tempStore();
  const seen = [];
  const client = createSseClient({ baseUrl: 'http://x', auth: fakeAuth(), store, onEvent: e => seen.push(e.mid) });
  client.handleFrame(chatFrame(50));
  assert.deepEqual(seen, [50]);
  assert.equal(store.getCursor(), 50);
});
