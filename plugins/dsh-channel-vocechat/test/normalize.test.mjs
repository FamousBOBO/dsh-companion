import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeEvent, targetOfRaw, describeEvent } from '../normalize.mjs';

/** The exact body measured from VoceChat 0.5.40 (evidence/webhook-raw.jsonl). */
function channelBody(overrides = {}) {
  return {
    created_at: 1794892571813,
    detail: {
      content: 'event probe A',
      content_type: 'text/plain',
      expires_in: null,
      properties: null,
      type: 'normal',
    },
    domain: null,
    from_uid: 1,
    mid: 133,
    target: { gid: 1 },
    widget_id: null,
    type: 'chat',
    ...overrides,
  };
}

test('the measured channel body normalizes without losing anything we need', () => {
  const result = normalizeEvent(channelBody());
  assert.equal(result.ok, true);
  const { event } = result;
  assert.equal(event.mid, 133);
  assert.equal(event.fromUid, 1);
  assert.deepEqual(event.target, { channel: 1 });
  assert.equal(event.content, 'event probe A');
  assert.equal(event.contentType, 'text/plain');
  assert.equal(event.detailType, 'normal');
  assert.equal(event.createdAt, 1794892571813);
  assert.equal(event.kind, 'chat');
  assert.equal(typeof event.receivedAt, 'number');
});

test('the measured DM body maps to {user: uid}', () => {
  const result = normalizeEvent(channelBody({ target: { uid: 2 } }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.event.target, { user: 2 });
});

test('targetOfRaw handles gid, uid, and refuses everything else', () => {
  assert.deepEqual(targetOfRaw({ gid: 1 }), { channel: 1 });
  assert.deepEqual(targetOfRaw({ uid: 2 }), { user: 2 });
  assert.equal(targetOfRaw({}), null);
  assert.equal(targetOfRaw({ gid: 'abc' }), null);
  assert.equal(targetOfRaw({ gid: -1 }), null);
  assert.equal(targetOfRaw(null), null);
  assert.equal(targetOfRaw('{"gid":1}'), null);
});

test('a missing mid is refused: it is the idempotency key and must never be invented', () => {
  const noMid = normalizeEvent(channelBody({ mid: undefined }));
  assert.equal(noMid.ok, false);
  assert.equal(noMid.reason, 'missing-mid');

  const zeroMid = normalizeEvent(channelBody({ mid: 0 }));
  assert.equal(zeroMid.ok, false);
  assert.equal(zeroMid.reason, 'missing-mid');
});

test('a missing from_uid is refused', () => {
  const result = normalizeEvent(channelBody({ from_uid: undefined }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing-from-uid');
});

test('an unknown target is refused rather than guessed', () => {
  const result = normalizeEvent(channelBody({ target: { channel: 1 } }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unknown-target');
});

test('non-objects and arrays are refused', () => {
  for (const bad of [null, undefined, 'text', 42, [], true]) {
    const result = normalizeEvent(bad);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not-an-object');
  }
});

test('an unknown event type is PRESERVED, not dropped: the adapter decides', () => {
  const result = normalizeEvent(channelBody({ type: 'reaction' }));
  assert.equal(result.ok, true);
  // kind keeps the platform's string verbatim so the adapter can drop it with a logged reason.
  assert.equal(result.event.kind, 'reaction');
});

test('a missing type becomes an empty kind, still accepted', () => {
  const result = normalizeEvent(channelBody({ type: undefined }));
  assert.equal(result.ok, true);
  assert.equal(result.event.kind, '');
});

test('a future non-text content type is carried through as data', () => {
  const result = normalizeEvent(channelBody({ detail: { content: 'x', content_type: 'image/png', type: 'normal' } }));
  assert.equal(result.ok, true);
  // Filtering is the adapter's job; the transport must not silently swallow it.
  assert.equal(result.event.contentType, 'image/png');
});

test('content over the cap is refused instead of truncated', () => {
  const big = 'a'.repeat(64 * 1024 + 1);
  const result = normalizeEvent(channelBody({ detail: { content: big, content_type: 'text/plain', type: 'normal' } }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'content-too-long');

  const atCap = 'a'.repeat(64 * 1024);
  assert.equal(normalizeEvent(channelBody({ detail: { content: atCap, content_type: 'text/plain', type: 'normal' } })).ok, true);
});

test('a bad created_at becomes null rather than a fake timestamp', () => {
  const result = normalizeEvent(channelBody({ created_at: 'yesterday' }));
  assert.equal(result.ok, true);
  assert.equal(result.event.createdAt, null);
});

test('extra unknown fields are ignored, not fatal: the platform may add fields', () => {
  const result = normalizeEvent(channelBody({ brand_new_field: { nested: true } }));
  assert.equal(result.ok, true);
  assert.equal(result.event.mid, 133);
});

test('describeEvent never contains the message text', () => {
  const event = normalizeEvent(channelBody({ detail: { content: 'SECRET-CONTENT', content_type: 'text/plain', type: 'normal' } })).event;
  const line = describeEvent(event);
  assert.equal(line.includes('SECRET-CONTENT'), false, 'log line must not carry payload');
  assert.ok(line.includes('mid=133'));
  assert.ok(line.includes('chan:1'));
});
