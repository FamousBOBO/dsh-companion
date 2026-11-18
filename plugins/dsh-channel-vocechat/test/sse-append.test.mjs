import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSseClient } from '../sse.mjs';
import { createStore } from '../store.mjs';

function tempStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-append-'));
  return { store: createStore({ dataRoot: root }), root };
}

const encoder = new TextEncoder();

function stream(frames) {
  let i = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        async read() {
          if (i >= frames.length) return new Promise(() => {});
          const f = frames[i++];
          return { done: false, value: encoder.encode(`data: ${JSON.stringify(f)}\n\n`) };
        },
        cancel() {},
      }),
    },
  };
}

const chat = mid => ({
  created_at: 1,
  detail: { content: `m${mid}`, content_type: 'text/plain', expires_in: null, properties: null, type: 'normal' },
  from_uid: 1, mid, target: { gid: 1 }, widget_id: null, type: 'chat',
});

const auth = { token: async () => 'T', refreshNow: async () => 'T2', describe: () => ({}) };

async function run(client, { until, timeoutMs = 1500 }) {
  client.start();
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (until()) break;
    await new Promise(r => setTimeout(r, 10));
  }
  await client.stop({ stopTimeoutMs: 120 });
}

test('every accepted frame is appended to events.jsonl before the consumer runs', async () => {
  const { store } = tempStore();
  const order = [];
  const client = createSseClient({
    baseUrl: 'http://x', auth, store,
    onEvent: e => order.push(e.mid),
    fetchImpl: async () => stream([chat(10), chat(11)]),
  });
  await run(client, { until: () => order.length >= 2 });
  const lines = fs.readFileSync(store.eventsFile, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).event.mid, 10);
  assert.equal(JSON.parse(lines[1]).event.mid, 11);
});

test('the raw frame is kept alongside the normalized event, for later forensics', async () => {
  const { store } = tempStore();
  const client = createSseClient({
    baseUrl: 'http://x', auth, store, onEvent: () => {},
    fetchImpl: async () => stream([chat(12)]),
  });
  await run(client, { until: () => store.getCursor() >= 12 });
  const row = JSON.parse(fs.readFileSync(store.eventsFile, 'utf8').trim().split('\n')[0]);
  assert.equal(row.raw.type, 'chat');
  assert.equal(row.raw.mid, 12);
  assert.equal(row.event.content, 'm12');
});

test('a cold start rebuilds idempotency from the log, not from the warm cache', async () => {
  const { root, store } = tempStore();
  const client = createSseClient({
    baseUrl: 'http://x', auth, store, onEvent: () => {},
    fetchImpl: async () => stream([chat(20)]),
  });
  await run(client, { until: () => store.getCursor() >= 20 });
  // Deliberately do NOT flush the warm cache: this is the crash case that used to lose mids.
  const reopened = createStore({ dataRoot: root });
  assert.equal(reopened.claim(20), false, 'mid 20 must be known from events.jsonl alone');
});

test('an append failure is recorded as a gap instead of silently degrading', async () => {
  const { store, root } = tempStore();
  const gaps = [];
  const brokenStore = {
    ...store,
    appendEvent: () => ({ ok: false, reason: 'disk-full' }),
    recordGap: (reason, detail) => { gaps.push({ reason, detail }); return true; },
  };
  const client = createSseClient({
    baseUrl: 'http://x', auth, store: brokenStore, onEvent: () => {},
    fetchImpl: async () => stream([chat(30)]),
  });
  await run(client, { until: () => gaps.length >= 1 });
  assert.equal(gaps[0].reason, 'sse-append-failed');
  assert.equal(gaps[0].detail.reason, 'disk-full');
  // The message itself must still be delivered and the cursor must still advance: a read-only
  // disk must not turn into "no messages at all".
  assert.equal(brokenStore.getCursor(), 30);
});
