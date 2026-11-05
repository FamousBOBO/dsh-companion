import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTENT_KINDS, DELIVERY_MODES, mergeItems, orderItems, planDelivery, createDeliveryService,
} from '../lib/delivery.mjs';

// Delivery, for real (CONTRACT §5 `desktop`/`onebot`, §6.7 "tool returned ≠ delivered").
//
// The rules under test are the ones that decide whether a claim about sending is honest:
//   * a plan's step order follows the configured kind order, and text really merges;
//   * `voice_only` means the voice *is* the message (no double text);
//   * a channel must prove arrival with a `platformMessageId`, otherwise the receipt is
//     `unknown` — never `confirmed`;
//   * a throwing channel is `unknown` (the send may have reached the platform), not `failed`;
//   * the first non-confirmation stops the plan: the rest is `cancelled`, never silently sent
//     later and never retried by this layer;
//   * mock mode and a missing channel refuse *before* anything is sent (`delivery-mock`,
//     `channel-unavailable`);
//   * `status()` reports `channelWired` from the injected channel, not from hope.

function fakeLedger() {
  const receipts = [];
  return {
    putReceipt(receipt) { receipts.push(receipt); return receipt; },
    receipts,
  };
}

/** A channel that answers like OneBot: every send returns a real message id. */
function confirmingChannel({ mode = 'onebot', name = 'fake-onebot' } = {}) {
  const sent = [];
  return {
    mode,
    name,
    sent,
    async send(step, context) {
      sent.push({ step, context });
      return { ok: true, platformMessageId: `msg-${sent.length}` };
    },
  };
}

test('delivery: plan order follows the configured kind order', () => {
  const plan = planDelivery({
    sessionId: 's-1', channel: 'onebot', target: 'dm-1', mode: 'onebot',
    text: '在海边拍照', voice: { artifactId: 'a1', path: 'x.wav', durationSeconds: 2 }, images: [{ artifactId: 'a2', path: 'y.png' }],
  });
  assert.deepEqual(plan.steps.map(step => step.kind), ['voice', 'text', 'image'], `default order is ${CONTENT_KINDS.join('/')}`);
  assert.equal(plan.steps[0].step, 1, 'steps are numbered from 1');
  assert.equal(plan.mode, 'onebot');
  // A custom order is honoured verbatim.
  const custom = planDelivery({
    sessionId: 's-1', text: 'x', voice: { artifactId: 'a1', path: 'x.wav' }, mode: 'onebot',
    order: ['text', 'voice', 'image'],
  });
  assert.deepEqual(custom.steps.map(step => step.kind), ['text', 'voice']);
});

test('delivery: text merges, voice_only replaces the text, images keep their order', () => {
  const merged = mergeItems([{ kind: 'text', text: '第一段' }, { kind: 'text', text: '第二段' }, { kind: 'image', artifactId: 'i1' }, { kind: 'text', text: '第三段' }]);
  assert.deepEqual(merged.map(item => item.kind), ['text', 'image', 'text'], 'adjacent texts collapse, images split the run');
  assert.equal(merged[0].text, '第一段\n第二段');

  const voiceOnly = planDelivery({
    sessionId: 's-1', mode: 'onebot', voiceOnly: true,
    text: '这句话会念出来', voice: { artifactId: 'a1', path: 'x.wav' },
  });
  assert.deepEqual(voiceOnly.steps.map(step => step.kind), ['voice'], 'voice_only never doubles the same text');
  assert.equal(voiceOnly.voiceOnly, true);

  const voiceOnlyWithoutVoice = planDelivery({ sessionId: 's-1', mode: 'onebot', voiceOnly: true, text: '只有文字' });
  assert.deepEqual(voiceOnlyWithoutVoice.steps.map(step => step.kind), ['text'], 'voice_only without a voice still speaks');
});

test('delivery: an unknown mode is refused, never guessed', () => {
  assert.throws(() => planDelivery({ sessionId: 's-1', mode: 'telepathy' }), /unsupported delivery mode/);
  assert.deepEqual(DELIVERY_MODES, ['mock', 'desktop', 'onebot']);
});

test('delivery: mock mode refuses to send and downgrades a confirmed claim', () => {
  const ledger = fakeLedger();
  const channel = confirmingChannel();
  const service = createDeliveryService({ ledger, mode: 'mock', channelProvider: () => channel });
  return service.deliver({ sessionId: 's-1', text: 'hi', channel: 'onebot', target: 'dm-1' }).then(result => {
    assert.equal(result.ok, false);
    assert.equal(result.code, 'delivery-mock');
    assert.equal(channel.sent.length, 0, 'mock mode must not touch the channel');
    // Even an explicit "confirmed" report cannot become a confirmed receipt in mock mode.
    const receipt = service.record({ planId: 'p', sessionId: 's-1', channel: 'onebot', target: 'dm-1', state: 'confirmed', platformMessageId: 'msg-1' });
    assert.equal(receipt.state, 'unknown');
    assert.match(String(receipt.detail), /mock/);
    assert.equal(service.status().mode, 'mock');
  });
});

test('delivery: a real mode without a channel fails closed', async () => {
  const service = createDeliveryService({ ledger: fakeLedger(), mode: 'onebot', channelProvider: () => null });
  const result = await service.deliver({ sessionId: 's-1', text: 'hi', target: 'dm-1' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'channel-unavailable');
  assert.equal(result.steps.length, 0);
  const status = service.status();
  assert.equal(status.mode, 'onebot', 'the configured mode is reported as-is');
  assert.equal(status.channelWired, false, 'no channel means not wired — never assumed');
});

test('delivery: a confirming channel produces ordered confirmed receipts with platform ids', async () => {
  const ledger = fakeLedger();
  const channel = confirmingChannel();
  const service = createDeliveryService({ ledger, mode: 'onebot', channelProvider: () => channel });
  const result = await service.deliver({
    sessionId: 's-1', channel: 'onebot', target: 'dm-1',
    text: '看这张', voice: { artifactId: 'a1', path: 'x.wav' }, images: [{ artifactId: 'a2', path: 'y.png' }],
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.state, 'confirmed');
  assert.deepEqual(result.steps.map(step => step.state), ['confirmed', 'confirmed', 'confirmed']);
  assert.deepEqual(result.steps.map(step => step.platformMessageId), ['msg-1', 'msg-2', 'msg-3']);
  assert.deepEqual(channel.sent.map(entry => entry.step.kind), ['voice', 'text', 'image'], 'the channel receives the planned order');
  assert.equal(ledger.receipts.length, 3);
  assert.ok(ledger.receipts.every(receipt => receipt.state === 'confirmed' && receipt.platformMessageId));
  const status = service.status();
  assert.equal(status.channelWired, true);
  assert.equal(status.receipts.confirmed, 3);
  assert.equal(status.lastRun.state, 'confirmed');
});

test('delivery: a send without a platform id is submitted, not confirmed', async () => {
  const ledger = fakeLedger();
  const channel = { mode: 'onebot', name: 'silent', async send() { return { ok: true }; } };
  const service = createDeliveryService({ ledger, mode: 'onebot', channelProvider: () => channel });
  const result = await service.deliver({ sessionId: 's-1', text: 'hi', target: 'dm-1', items: [{ kind: 'text', text: 'a' }, { kind: 'image', artifactId: 'i1' }] });
  assert.equal(result.ok, false, 'no proof of arrival');
  // "The call returned but nothing proves arrival" is exactly `submitted` in the frozen
  // DeliveryState union — not `confirmed`, and not `unknown` (which is reserved for no answer).
  assert.equal(result.state, 'submitted');
  assert.equal(result.steps[0].state, 'submitted');
  assert.equal(result.steps[1].state, 'cancelled', 'the remainder is not attempted after a non-confirmation');
  assert.equal(service.status().receipts.confirmed, 0);
  assert.deepEqual(service.reconcile({ receipt: ledger.receipts[0] }).action, 'await-confirmation', 'submitted waits, it is not re-sent');
});

test('delivery: a channel that speaks another transport is refused', async () => {
  const desktopChannel = { mode: 'desktop', async send() { throw new Error('should not be called'); } };
  const service = createDeliveryService({ ledger: fakeLedger(), mode: 'onebot', channelProvider: () => desktopChannel });
  const result = await service.deliver({ sessionId: 's-1', text: 'x', target: 'dm-1' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'channel-mode-mismatch');
  assert.equal(result.channelMode, 'desktop');
});

test('delivery: a definite failure stops the plan, a throwing channel is unknown', async () => {
  const failing = { mode: 'onebot', async send() { return { ok: false, state: 'failed', detail: 'qq rejects: not a friend' }; } };
  const serviceA = createDeliveryService({ ledger: fakeLedger(), mode: 'onebot', channelProvider: () => failing });
  const failed = await serviceA.deliver({ sessionId: 's-1', text: 'x', target: 'dm-1', items: [{ kind: 'text', text: 'a' }, { kind: 'image', artifactId: 'i' }] });
  assert.equal(failed.state, 'failed');
  assert.equal(failed.steps[0].state, 'failed');
  assert.equal(failed.steps[1].state, 'cancelled');
  assert.equal(failed.receipts[0].detail, 'qq rejects: not a friend');

  const throwing = { mode: 'onebot', async send() { throw new Error('socket closed mid-send'); } };
  const serviceB = createDeliveryService({ ledger: fakeLedger(), mode: 'onebot', channelProvider: () => throwing });
  const unknown = await serviceB.deliver({ sessionId: 's-1', text: 'x', target: 'dm-1' });
  assert.equal(unknown.state, 'unknown', 'a throw is "no answer": it may have reached the platform');
  assert.match(String(unknown.receipts[0].detail), /socket closed mid-send/);
});

test('delivery: record() refuses an invented state and a confirmed claim without proof', () => {
  const service = createDeliveryService({ ledger: fakeLedger(), mode: 'onebot', channelProvider: () => confirmingChannel() });
  assert.throws(() => service.record({ state: 'delivered', sessionId: 's-1' }), /unsupported delivery state/);
  const noProof = service.record({ sessionId: 's-1', channel: 'onebot', target: 'dm-1', state: 'confirmed' });
  assert.equal(noProof.state, 'unknown');
  assert.match(String(noProof.detail), /no platform message id/);
  const proven = service.record({ sessionId: 's-1', channel: 'onebot', target: 'dm-1', state: 'confirmed', platformMessageId: 'msg-9' });
  assert.equal(proven.state, 'confirmed');
  assert.equal(proven.platformMessageId, 'msg-9');
});

test('delivery: the mode is re-read on every call (config kill switch)', async () => {
  let configured = 'mock';
  const channel = confirmingChannel();
  const service = createDeliveryService({ ledger: fakeLedger(), mode: 'mock', modeProvider: () => configured, channelProvider: () => channel });
  const blocked = await service.deliver({ sessionId: 's-1', text: 'x', target: 'dm-1' });
  assert.equal(blocked.code, 'delivery-mock');
  configured = 'onebot';
  const allowed = await service.deliver({ sessionId: 's-1', text: 'x', target: 'dm-1' });
  assert.equal(allowed.ok, true, 'flipping the config takes effect without a restart');
  assert.equal(service.status().mode, 'onebot');
});

test('delivery: orderItems is stable for equal ranks and unknown kinds go last', () => {
  const items = [{ kind: 'other', n: 1 }, { kind: 'text', n: 2 }, { kind: 'image', n: 3 }, { kind: 'mystery', n: 4 }, { kind: 'image', n: 5 }];
  assert.deepEqual(orderItems(items).map(item => item.n), [2, 3, 5, 1, 4], 'text → images (stable) → other → unknown');
});
