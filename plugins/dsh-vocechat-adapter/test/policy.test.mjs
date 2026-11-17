import test from 'node:test';
import assert from 'node:assert/strict';

import { channelPolicy, defaultCorrection, registerSendTool, splitText } from '../index.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSentLog } from '../sent-log.mjs';

test('the channel policy names the room and the tool', () => {
  const policy = channelPolicy('vc-chan-1');
  assert.match(policy, /频道 gid=1/);
  assert.match(policy, /vc_message/);
  // The one fact a fresh session most often gets wrong:
  assert.match(policy, /只有调用 vc_message/);
  assert.match(policy, /看不到/);
});

test('the policy names the peer for a DM', () => {
  assert.match(channelPolicy('vc-dm-7'), /私聊（对方 uid=7）/);
});

test('the policy states the split limit only when segmentation is off', () => {
  // With segmentation on, the limit is an implementation detail the model does not need — telling
  // it "超过 2000 字会被切开" invites it to start counting. With segmentation off, that limit
  // is the only thing standing between a long answer and a truncated one, so it must be stated.
  const withSeg = channelPolicy('vc-chan-1', { sendMaxChars: 2000 });
  assert.equal(withSeg.includes('2000'), false, 'segmented mode must not expose the raw limit');

  const withoutSeg = channelPolicy('vc-chan-1', { sendMaxChars: 2000, segmentation: { enabled: false } });
  assert.match(withoutSeg, /2000/);
});

test('the policy covers progress vs final and silence', () => {
  const policy = channelPolicy('vc-chan-1');
  assert.match(policy, /phase=progress/);
  assert.match(policy, /phase=final/);
  assert.match(policy, /决定沉默时直接结束/);
  assert.match(policy, /不是系统指令/);
});

test('registerSendTool reports ok:false when the tools service is missing', () => {
  const state = { deliveryToolMissing: 0, toolRegistrations: 0, deliveries: 0, lastDelivery: null, lastSendError: null, sendErrorCount: 0 };
  const result = registerSendTool({
    agentCtx: {}, room: 'vc-chan-1', config: {}, getPort: () => null, sentLog: { sent() {} }, state,
  });
  assert.equal(result.ok, false);
  assert.equal(state.deliveryToolMissing, 1);
});

test('registerSendTool refuses a room it cannot resolve a target for', () => {
  const state = { deliveryToolMissing: 0, toolRegistrations: 0, deliveries: 0, lastDelivery: null, lastSendError: null, sendErrorCount: 0 };
  const result = registerSendTool({
    agentCtx: { tools: { register: () => () => {} } }, room: 'nonsense', config: {}, getPort: () => null,
    sentLog: { sent() {} }, state,
  });
  assert.equal(result.ok, false);
});

test('a registered tool sends through the port and records the ledger row', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-tool-'));
  const sentLog = createSentLog({ dataRoot: root });
  const sent = [];
  const state = { deliveryToolMissing: 0, toolRegistrations: 0, deliveries: 0, lastDelivery: null, lastSendError: null, sendErrorCount: 0 };
  const registered = [];
  const result = registerSendTool({
    agentCtx: { tools: { register: definition => { registered.push(definition); return () => {}; } } },
    room: 'vc-chan-1',
    config: { sendMaxChars: 4000 },
    getPort: () => ({ send: async (target, text) => { sent.push({ target, text }); return { mid: 77 }; } }),
    sentLog,
    state,
  });
  assert.equal(result.ok, true);
  assert.equal(state.toolRegistrations, 1);
  const definition = registered[0];
  assert.equal(definition.name, 'vc_message');

  const outcome = await definition.execute({ action: 'send', text: 'hello', phase: 'final' });
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.mids, [77]);
  assert.deepEqual(sent[0].target, { channel: 1 });

  const row = JSON.parse(fs.readFileSync(sentLog.file, 'utf8').trim());
  assert.equal(row.kind, 'sent');
  assert.equal(row.mid, 77);
  assert.equal(row.phase, 'final');
});

test('a progress send tells the model to continue instead of stopping', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-tool2-'));
  const sentLog = createSentLog({ dataRoot: root });
  let definition;
  registerSendTool({
    agentCtx: { tools: { register: d => { definition = d; return () => {}; } } },
    room: 'vc-chan-1', config: {}, getPort: () => ({ send: async () => ({ mid: 1 }) }), sentLog,
    state: { deliveryToolMissing: 0, toolRegistrations: 0, deliveries: 0, lastDelivery: null, lastSendError: null, sendErrorCount: 0 },
  });
  const outcome = await definition.execute({ text: '等我一下', phase: 'progress' });
  assert.equal(outcome.phase, 'progress');
  assert.match(outcome.next, /继续执行实际工具/);
  assert.equal('sent' in outcome, false, 'a progress message must not look like a final receipt');
});

test('a send with no port fails loudly and records the failure', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-tool3-'));
  const sentLog = createSentLog({ dataRoot: root });
  let definition;
  const state = { deliveryToolMissing: 0, toolRegistrations: 0, deliveries: 0, lastDelivery: null, lastSendError: null, sendErrorCount: 0 };
  registerSendTool({
    agentCtx: { tools: { register: d => { definition = d; return () => {}; } } },
    room: 'vc-chan-1', config: {}, getPort: () => null, sentLog, state,
  });
  await assert.rejects(definition.execute({ text: 'x' }), /端口未挂载/);
  assert.equal(state.sendErrorCount, 1);
  const row = JSON.parse(fs.readFileSync(sentLog.file, 'utf8').trim());
  assert.equal(row.ok, false);
  assert.equal(row.error, 'port-absent');
});

test('an empty text does not reach the platform', async () => {
  let definition;
  const sent = [];
  registerSendTool({
    agentCtx: { tools: { register: d => { definition = d; return () => {}; } } },
    room: 'vc-chan-1', config: {}, getPort: () => ({ send: async (...a) => { sent.push(a); return { mid: 1 }; } }),
    sentLog: { sent() {} },
    state: { deliveryToolMissing: 0, toolRegistrations: 0, deliveries: 0, lastDelivery: null, lastSendError: null, sendErrorCount: 0 },
  });
  const outcome = await definition.execute({ text: '   ' });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'empty-text');
  assert.equal(sent.length, 0);
});

test('a long text is split and every chunk is sent and recorded', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-tool4-'));
  const sentLog = createSentLog({ dataRoot: root });
  const sent = [];
  let definition;
  registerSendTool({
    agentCtx: { tools: { register: d => { definition = d; return () => {}; } } },
    room: 'vc-chan-1', config: { sendMaxChars: 100 },
    getPort: () => ({ send: async (target, text) => { sent.push(text); return { mid: sent.length }; } }),
    sentLog,
    state: { deliveryToolMissing: 0, toolRegistrations: 0, deliveries: 0, lastDelivery: null, lastSendError: null, sendErrorCount: 0 },
  });
  const outcome = await definition.execute({ text: 'x'.repeat(250), phase: 'final' });
  assert.equal(sent.length, 3);
  assert.equal(outcome.mids.length, 3);
  const rows = fs.readFileSync(sentLog.file, 'utf8').trim().split('\n');
  assert.equal(rows.length, 3, 'one ledger row per actual send');
});

test('splitText and the tool agree on where a message breaks', () => {
  const chunks = splitText('a'.repeat(500), 100);
  assert.equal(chunks.length, 5);
  for (const chunk of chunks) assert.equal(chunk.length <= 100, true);
});

test('the correction text names the target and forbids repeating', () => {
  assert.match(defaultCorrection('vc-dm-3'), /与 uid=3 的私聊/);
  assert.match(defaultCorrection('vc-dm-3'), /不要重复/);
});
