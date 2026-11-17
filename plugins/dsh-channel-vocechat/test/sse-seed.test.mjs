import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSseClient } from '../sse.mjs';
import { createStore } from '../store.mjs';

function tempStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-seed-'));
  return createStore({ dataRoot: root });
}

const encoder = new TextEncoder();

function stream(frames) {
  let index = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          async read() {
            if (index >= frames.length) return new Promise(() => {});
            const f = frames[index++];
            return { done: false, value: encoder.encode(`data: ${JSON.stringify(f)}\n\n`) };
          },
          cancel() {},
        };
      },
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

test('on a fresh store the client seeds the cursor from history instead of replaying history', async () => {
  const store = tempStore();
  const seen = [];
  const urls = [];
  const client = createSseClient({
    baseUrl: 'http://x',
    auth,
    store,
    // This is the whole point: `after_mid=0` would deliver the entire backlog.
    api: { history: async () => [{ mid: 232 }] },
    seedChannel: 1,
    onEvent: e => seen.push(e.mid),
    fetchImpl: async url => { urls.push(url); return stream([chat(233)]); },
  });

  await run(client, { until: () => seen.length >= 1 });
  assert.equal(store.getCursor() >= 232, true, 'the cursor must be seeded before connecting');
  assert.match(urls[0], /after_mid=232/, 'the first connection must NOT use after_mid=0');
  assert.deepEqual(seen, [233], 'only the new message is delivered, not the backlog');
});

test('a store that already has a cursor is never re-seeded', async () => {
  const store = tempStore();
  store.setCursor(300);
  const urls = [];
  let historyCalls = 0;
  const client = createSseClient({
    baseUrl: 'http://x',
    auth,
    store,
    api: { history: async () => { historyCalls += 1; return [{ mid: 999 }]; } },
    onEvent: () => {},
    fetchImpl: async url => { urls.push(url); return stream([]); },
  });
  await run(client, { until: () => urls.length >= 1 });
  assert.equal(historyCalls, 0, 'seeding must not run when a cursor exists');
  assert.match(urls[0], /after_mid=300/);
});

test('a failing seed falls back to 0 and says so, rather than swallowing the error', async () => {
  const store = tempStore();
  const notes = [];
  const client = createSseClient({
    baseUrl: 'http://x',
    auth,
    store,
    api: { history: async () => { throw new Error('403 forbidden'); } },
    onEvent: () => {},
    log: line => notes.push(line),
    fetchImpl: async () => stream([]),
  });
  await run(client, { until: () => notes.some(n => n.includes('seed 失败')) });
  assert.equal(store.getCursor(), 0);
  assert.ok(notes.some(n => n.includes('补播历史')), 'the fallback must be logged');
});

test('with no api at all, seeding is skipped and the reason is logged', async () => {
  const store = tempStore();
  const notes = [];
  const client = createSseClient({
    baseUrl: 'http://x', auth, store, api: null, onEvent: () => {}, log: l => notes.push(l),
    fetchImpl: async () => stream([]),
  });
  await run(client, { until: () => notes.some(n => n.includes('没有 history 能力')) });
  assert.equal(store.getCursor(), 0);
});

test('an unusable history row leaves the cursor at 0 rather than inventing a value', async () => {
  const store = tempStore();
  const notes = [];
  const client = createSseClient({
    baseUrl: 'http://x', auth, store,
    api: { history: async () => [] },
    onEvent: () => {}, log: l => notes.push(l),
    fetchImpl: async () => stream([]),
  });
  await run(client, { until: () => notes.some(n => n.includes('无法确定当前最大 mid')) });
  assert.equal(store.getCursor(), 0);
});
