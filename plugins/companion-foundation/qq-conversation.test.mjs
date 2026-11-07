import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountQqConversation } from './qq-conversation.mjs';

function harness() {
  const hooks = new Map(); const sections = new Map();
  mountQqConversation({ systemPrompt: {
    section: value => sections.set(value.name, value), context: value => sections.set(value.name, value),
  }, on: (name, hook) => hooks.set(name, hook) });
  const id = 'qq-dm-123';
  const event = (type, data) => hooks.get('session/event')({ id }, { type, data });
  const step = (over = {}) => hooks.get('agent/pre-step')({ agent: { session: { id } }, turn: 1, step: 2, messages: [], ...over }, async () => ({ kind: 'enter' }));
  const receipt = (isError = false, text = '{"message_id":42}', name = 'qq_message', args = { action: 'send' }) => {
    event('tool/call', { turn: 1, name, callId: 'call1', arguments: JSON.stringify(args) });
    event('tool/result', { turn: 1, message: { toolCallId: 'call1', isError, content: [{ type: 'text', text }] } });
  };
  return { step, receipt, sections };
}
test('successful QQ send ends turn before a second model answer', async () => {
  const h = harness(); h.receipt(); assert.equal((await h.step()).kind, 'reject');
});
test('a delivered photo allows follow-up text and the final text closes the turn', async () => {
  const h = harness();
  h.receipt(false, '{"message_id":42}', 'qq_sticker', { action: 'send_image' });
  assert.equal((await h.step()).kind, 'enter');
  h.receipt(false, '{"message_id":43}', 'qq_message', { action: 'send', phase: 'final' });
  assert.equal((await h.step({ step: 3 })).kind, 'reject');
});
test('failed send and handled error allow model recovery', async () => {
  for (const args of [[true], [false, '{"error":"offline"}']]) {
    const h = harness(); h.receipt(...args); assert.equal((await h.step()).kind, 'enter');
  }
});
test('new user input and a new turn are not suppressed by old send', async () => {
  const h = harness(); h.receipt();
  assert.equal((await h.step({ messages: [{ source: { kind: 'user' } }] })).kind, 'enter');
  assert.equal((await h.step({ step: 3 })).kind, 'enter');
  assert.equal((await h.step({ turn: 2, step: 1 })).kind, 'enter');
});
test('QQ instructions are absent from desktop agent scope', () => {
  const h = harness(); const render = h.sections.get('companion:qq-policy').text;
  assert.equal(render({ agent: { session: { id: 'desktop-chat' } } }), '');
  assert.match(render({ agent: { session: { id: 'qq-dm-123' } } }), /发送工具成功后结束/);
});
