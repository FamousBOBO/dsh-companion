import test from 'node:test';
import assert from 'node:assert/strict';

import { createGate, idList, MAX_TEXT } from '../gate.mjs';

const chat = (overrides = {}) => ({
  kind: 'chat', mid: 1, fromUid: 1, target: { channel: 1 }, content: 'hello', contentType: 'text/plain', ...overrides,
});

function gateOf({ users = [1], groups = [1], self = 4 } = {}) {
  return createGate({ allowUsers: idList(users), allowGroups: idList(groups), selfUid: self });
}

test('an empty whitelist denies everything — fail-closed, not fail-open', () => {
  const gate = createGate({ allowUsers: [], allowGroups: [1], selfUid: 4 });
  const decision = gate.decide(chat());
  assert.equal(decision.allow, false);
  assert.equal(decision.reason, 'user-not-allowed:1');
  assert.equal(gate.describe().failClosed, true);
});

test('a whitelisted user in a whitelisted channel passes', () => {
  assert.equal(gateOf().decide(chat()).allow, true);
});

test('a whitelisted user outside the channel whitelist is refused', () => {
  const gate = createGate({ allowUsers: [1], allowGroups: [2], selfUid: 4 });
  const decision = gate.decide(chat({ target: { channel: 1 } }));
  assert.equal(decision.allow, false);
  assert.equal(decision.reason, 'channel-not-allowed:1');
});

test('our own message is dropped even if we are whitelisted', () => {
  const gate = createGate({ allowUsers: [1, 4], allowGroups: [1], selfUid: 4 });
  const decision = gate.decide(chat({ fromUid: 4 }));
  assert.equal(decision.allow, false);
  assert.equal(decision.reason, 'from-self');
});

test('a non-chat event is refused before any other rule runs', () => {
  const gate = gateOf();
  const decision = gate.decide(chat({ kind: 'users_snapshot', content: '' }));
  assert.equal(decision.allow, false);
  assert.equal(decision.reason, 'kind:users_snapshot');
});

test('an event with no sender is refused', () => {
  assert.equal(gateOf({ self: 0 }).decide(chat({ fromUid: 0 })).reason, 'no-sender');
  assert.equal(gateOf({ self: 0 }).decide(chat({ fromUid: 'x' })).reason, 'no-sender');
});

test('a DM only needs the user whitelist, not a group', () => {
  const gate = createGate({ allowUsers: [1], allowGroups: [], selfUid: 4 });
  const decision = gate.decide(chat({ target: { user: 4 } }));
  assert.equal(decision.allow, true);
});

test('an event with neither channel nor user target is refused', () => {
  const decision = gateOf().decide(chat({ target: {} }));
  assert.equal(decision.allow, false);
  assert.equal(decision.reason, 'no-target');
});

test('empty text does not start a turn', () => {
  const decision = gateOf().decide(chat({ content: '   \n\t ' }));
  assert.equal(decision.allow, false);
  assert.equal(decision.reason, 'empty-text');
});

test('absurdly large text is refused rather than fed to the model', () => {
  const decision = gateOf().decide(chat({ content: 'x'.repeat(MAX_TEXT + 1) }));
  assert.equal(decision.allow, false);
  assert.equal(decision.reason, 'text-too-large');
});

test('null and garbage events never throw', () => {
  const gate = gateOf();
  assert.equal(gate.decide(null).allow, false);
  assert.equal(gate.decide(undefined).allow, false);
  assert.equal(gate.decide('nope').allow, false);
  assert.equal(gate.decide(42).allow, false);
});

test('idList accepts numbers, numeric strings, and comma lists', () => {
  assert.deepEqual([...idList([1, 2, '3'])], [1, 2, 3]);
  assert.deepEqual([...idList('4, 5,6')], [4, 5, 6]);
  assert.deepEqual([...idList([0, -1, 'x', null, undefined])], []);
  assert.deepEqual([...idList(undefined)], []);
});

test('describe() is what an operator reads when nothing happens', () => {
  const gate = createGate({ allowUsers: [3, 1], allowGroups: [2], selfUid: 4 });
  const d = gate.describe();
  assert.deepEqual(d.allowUsers, [1, 3]);
  assert.deepEqual(d.allowGroups, [2]);
  assert.equal(d.selfUid, 4);
  assert.equal(d.failClosed, false);
});
