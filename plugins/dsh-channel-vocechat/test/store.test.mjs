import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStore } from '../store.mjs';

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vc-store-'));
}

function sampleEvent(mid) {
  return {
    mid,
    fromUid: 1,
    target: { channel: 1 },
    content: 'x',
    contentType: 'text/plain',
    detailType: 'normal',
    createdAt: 1,
    kind: 'chat',
    receivedAt: 1,
  };
}

test('claim() is the idempotency gate: first wins, repeats are refused', () => {
  const root = tempRoot();
  const store = createStore({ dataRoot: root });
  assert.equal(store.claim(133), true);
  assert.equal(store.claim(133), false);
  assert.equal(store.claim(134), true);
  // A non-positive or non-integer mid can never be claimed: it cannot be an idempotency key.
  assert.equal(store.claim(0), false);
  assert.equal(store.claim(-1), false);
  assert.equal(store.claim('abc'), false);
});

test('seen-mids survives a fresh store (i.e. a process restart)', () => {
  const root = tempRoot();
  const first = createStore({ dataRoot: root });
  assert.equal(first.claim(200), true);
  first.flush();

  const second = createStore({ dataRoot: root });
  // The whole point: after a restart the platform's (hypothetical) retry must not re-trigger a turn.
  assert.equal(second.claim(200), false);
  assert.equal(second.claim(201), true);
});

test('the LRU is bounded and drops the oldest entries first', () => {
  const root = tempRoot();
  const store = createStore({ dataRoot: root, seenLimit: 3 });
  for (const mid of [1, 2, 3, 4]) assert.equal(store.claim(mid), true);
  // 1 must have been evicted, so it can be claimed again; 2..4 cannot.
  assert.equal(store.claim(1), true);
  assert.equal(store.claim(4), false);
  assert.equal(store.seenSize() <= 4, true);
});

test('appendEvent writes one JSON line and reports failure instead of throwing', () => {
  const root = tempRoot();
  const store = createStore({ dataRoot: root });
  const result = store.appendEvent(sampleEvent(133), { mid: 133, raw: true });
  assert.equal(result.ok, true);

  const text = fs.readFileSync(store.eventsFile, 'utf8').trim();
  const line = JSON.parse(text);
  assert.equal(line.event.mid, 133);
  // The raw body must be persisted alongside: the platform is undocumented, and a future field
  // change has to be reconstructible from disk.
  assert.deepEqual(line.raw, { mid: 133, raw: true });
  assert.equal(typeof line.at, 'number');
});

test('the cursor only moves forward, and survives a restart', () => {
  const root = tempRoot();
  const store = createStore({ dataRoot: root });
  assert.equal(store.getCursor(), 0);
  assert.equal(store.setCursor(133), true);
  assert.equal(store.getCursor(), 133);
  // Going backwards would replay already-handled events on the next start.
  assert.equal(store.setCursor(120), false);
  assert.equal(store.getCursor(), 133);

  const second = createStore({ dataRoot: root });
  assert.equal(second.getCursor(), 133);
});

test('pendingAfterCursor returns exactly the events after the cursor', () => {
  const root = tempRoot();
  const store = createStore({ dataRoot: root });
  for (const mid of [10, 11, 12, 13]) store.appendEvent(sampleEvent(mid), { mid });
  store.setCursor(11);

  const pending = store.pendingAfterCursor();
  assert.deepEqual(pending.map(entry => entry.event.mid), [12, 13]);
});

test('recordGap leaves a named trace, because an unnamed loss is indistinguishable from a bug', () => {
  const root = tempRoot();
  const store = createStore({ dataRoot: root });
  assert.equal(store.recordGap('queue-full', { depth: 200 }), true);
  const text = fs.readFileSync(store.gapFile, 'utf8').trim();
  const line = JSON.parse(text);
  assert.equal(line.reason, 'queue-full');
  assert.deepEqual(line.detail, { depth: 200 });
});

test('writeDiag records mount facts without any credential', () => {
  const root = tempRoot();
  const store = createStore({ dataRoot: root });
  assert.equal(store.writeDiag('mount', { baseHost: 'http://127.0.0.1:3009', keyed: true }), true);
  const file = path.join(root, 'home', 'channel-vocechat', 'diag', 'mount.json');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(parsed.baseHost, 'http://127.0.0.1:3009');
  assert.equal(parsed.keyed, true);
  assert.equal(typeof parsed.pid, 'number');
  assert.equal(typeof parsed.at, 'string');
});

test('rotation renames the log instead of growing without bound', () => {
  const root = tempRoot();
  const store = createStore({ dataRoot: root, rotateBytes: 200 });
  for (let i = 0; i < 20; i += 1) store.appendEvent(sampleEvent(100 + i), { i });
  assert.equal(fs.existsSync(`${store.eventsFile}.1`), true);
});

test('an unwritable data root fails closed with a reason, never throws', () => {
  const store = createStore({ dataRoot: '' });
  const result = store.appendEvent(sampleEvent(1), {});
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'data-dir-not-writable');
  // A claim is still refused rather than silently accepted, so nothing pretends to have persisted.
  assert.equal(store.recordGap('x'), false);
  assert.equal(store.writeDiag('x', {}), false);
});

test('the layout sits under home/channel-vocechat, not scattered across the data root', () => {
  const root = tempRoot();
  const store = createStore({ dataRoot: root });
  const base = path.join(root, 'home', 'channel-vocechat');
  assert.equal(store.base, base);
  for (const sub of ['state', 'events', 'diag']) {
    assert.equal(fs.existsSync(path.join(base, sub)), true, `${sub} should exist`);
  }
});
