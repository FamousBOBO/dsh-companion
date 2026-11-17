import test from 'node:test';
import assert from 'node:assert/strict';

import { roomKeyOf, describeRoom, targetOfRoom, isVoceChatRoom, dmPeerOf } from '../room.mjs';

test('a channel event maps to vc-chan-<gid>', () => {
  assert.equal(roomKeyOf({ target: { channel: 1 }, fromUid: 7 }), 'vc-chan-1');
  assert.equal(roomKeyOf({ target: { channel: 42 }, fromUid: 7 }), 'vc-chan-42');
});

test('a DM maps to the OTHER party, not to ourselves', () => {
  // `target.user` is who receives it (us). `fromUid` is who sent it (them).
  // Using target.user would merge every DM into one room named after ourselves.
  assert.equal(roomKeyOf({ target: { user: 4 }, fromUid: 1 }), 'vc-dm-1');
  assert.equal(roomKeyOf({ target: { user: 4 }, fromUid: 9 }), 'vc-dm-9');
});

test('a DM without a sender has no room at all', () => {
  assert.equal(roomKeyOf({ target: { user: 4 }, fromUid: 0 }), null);
  assert.equal(roomKeyOf({ target: { user: 4 } }), null);
});

test('a namespace moves the prefix but keeps the suffix', () => {
  assert.equal(roomKeyOf({ target: { channel: 1 }, namespace: 'a' }), 'vc-a-chan-1');
  assert.equal(roomKeyOf({ target: { user: 4 }, fromUid: 2, namespace: 'b2' }), 'vc-b2-dm-2');
});

test('a dirty namespace is cleaned, not trusted', () => {
  // Everything outside [a-z0-9-] is dropped, so path separators and punctuation cannot reach the
  // session id. `A!/../B` → `ab` (not `a-b`): dropping beats substituting, because a substituted
  // character could collide with a real namespace.
  assert.equal(roomKeyOf({ target: { channel: 1 }, namespace: 'A!/../B' }), 'vc-ab-chan-1');
  assert.equal(roomKeyOf({ target: { channel: 1 }, namespace: '   ' }), 'vc-chan-1');
  assert.equal(roomKeyOf({ target: { channel: 1 }, namespace: 'x'.repeat(40) }).includes('x'.repeat(17)), false);
});

test('describeRoom is the inverse', () => {
  assert.deepEqual(describeRoom('vc-chan-1'), { namespace: '', kind: 'chan', id: 1 });
  assert.deepEqual(describeRoom('vc-dm-9'), { namespace: '', kind: 'dm', id: 9 });
  assert.deepEqual(describeRoom('vc-a-chan-3'), { namespace: 'a', kind: 'chan', id: 3 });
});

test('describeRoom refuses anything that is not ours', () => {
  for (const bad of ['qq-dm-1', 'vc-chan-0', 'vc-chan-x', 'vc--chan-1', '', null, undefined, 'vc-chan-']) {
    assert.equal(describeRoom(bad), null, `${bad} must not parse`);
  }
});

test('targetOfRoom gives the send target back', () => {
  assert.deepEqual(targetOfRoom('vc-chan-1'), { channel: 1 });
  assert.deepEqual(targetOfRoom('vc-dm-7'), { user: 7 });
  assert.equal(targetOfRoom('nonsense'), null);
});

test('isVoceChatRoom respects the namespace', () => {
  assert.equal(isVoceChatRoom('vc-chan-1'), true);
  assert.equal(isVoceChatRoom('vc-a-chan-1', 'a'), true);
  assert.equal(isVoceChatRoom('vc-a-chan-1', 'b'), false);
  assert.equal(isVoceChatRoom('qq-dm-1'), false);
});

test('dmPeerOf only answers for DMs', () => {
  assert.equal(dmPeerOf('vc-dm-7'), 7);
  assert.equal(dmPeerOf('vc-chan-1'), 0);
  assert.equal(dmPeerOf('junk'), 0);
});

test('round-trip: key → describe → target', () => {
  for (const input of [
    { target: { channel: 3 }, fromUid: 1 },
    { target: { user: 4 }, fromUid: 8 },
  ]) {
    const room = roomKeyOf(input);
    const info = describeRoom(room);
    const target = targetOfRoom(room);
    assert.equal(room, info.kind === 'chan' ? `vc-chan-${info.id}` : `vc-dm-${info.id}`);
    assert.equal(target.channel ?? target.user, info.id);
  }
});
