import test from 'node:test';
import assert from 'node:assert/strict';

import { createTurnObserver } from '../turns.mjs';
import { splitText, inboundLine, defaultCorrection, deliverTo } from '../index.mjs';

const start = (turn = 1) => ({ type: 'start', turn });
const textDelta = text => ({ type: 'chunk', chunk: { type: 'text-delta', text } });
const reasoningDelta = text => ({ type: 'chunk', chunk: { type: 'reasoning-delta', text } });
const toolStart = () => ({ type: 'chunk', chunk: { type: 'block-start', blockType: 'tool-call' } });
const committedEnd = () => ({ type: 'end', outcome: { kind: 'committed', eventType: 'assistant/message' } });
const abortedEnd = () => ({ type: 'end', outcome: { kind: 'aborted' } });

const agent = { status: 'idle', inject: () => {}, followup: () => {} };

function observerWith({ visible = true, onCorrect = () => {} } = {}) {
  const calls = [];
  const observer = createTurnObserver({
    isToolVisible: () => visible,
    correctionText: () => 'go send it',
    onCorrection: text => { calls.push(text); onCorrect(text, agent); },
  });
  return { observer, calls };
}

test('a committed turn with text and no tool call is corrected exactly once', () => {
  const { observer, calls } = observerWith();
  observer.observe(start());
  observer.observe(textDelta('回答在这里'));
  observer.observe(committedEnd());
  assert.equal(observer.maybeCorrect(agent), true);
  assert.deepEqual(calls, ['go send it']);
  // A second attempt must be silent: one correction per turn is the contract.
  assert.equal(observer.maybeCorrect(agent), false);
  assert.equal(calls.length, 1);
});

test('a turn that DID call the tool is never corrected', () => {
  const { observer, calls } = observerWith();
  observer.observe(start());
  observer.observe(textDelta('正文'));
  observer.observe(toolStart());
  observer.observe(committedEnd());
  assert.equal(observer.maybeCorrect(agent), false);
  assert.equal(calls.length, 0);
});

test('a turn with no text is never corrected', () => {
  const { observer, calls } = observerWith();
  observer.observe(start());
  observer.observe(committedEnd());
  assert.equal(observer.maybeCorrect(agent), false);
  assert.equal(calls.length, 0);
});

test('an aborted turn is never corrected', () => {
  const { observer, calls } = observerWith();
  observer.observe(start());
  observer.observe(textDelta('正文'));
  observer.observe(abortedEnd());
  assert.equal(observer.maybeCorrect(agent), false);
});

test('reasoning text does NOT count as an answer', () => {
  // The measured trap: a model that reasons and then answers locally would otherwise look
  // like it had delivered something.
  const { observer, calls } = observerWith();
  observer.observe(start());
  observer.observe(reasoningDelta('我在想……'));
  observer.observe(committedEnd());
  assert.equal(observer.maybeCorrect(), false, 'reasoning must not set sawText');
  assert.equal(observer.state().sawText, false);
});

test('an invisible tool means no correction (never ask for a tool that is not there)', () => {
  const { observer, calls } = observerWith({ visible: false });
  observer.observe(start());
  observer.observe(textDelta('正文'));
  observer.observe(committedEnd());
  assert.equal(observer.maybeCorrect(agent), false);
  assert.equal(calls.length, 0);
});

test('a new turn resets the flags', () => {
  const { observer } = observerWith();
  observer.observe(start(1));
  observer.observe(textDelta('第一轮'));
  observer.observe(committedEnd());
  assert.equal(observer.maybeCorrect(agent), true);

  observer.observe(start(2)); // different turn number resets
  observer.observe(textDelta('第二轮'));
  observer.observe(committedEnd());
  assert.equal(observer.maybeCorrect(), true, 'the new turn gets its own correction');
});

test('the same turn number does not reset (start can repeat within one turn)', () => {
  const { observer } = observerWith();
  observer.observe(start(1));
  observer.observe(textDelta('正文'));
  observer.observe(start(1));
  observer.observe(committedEnd());
  assert.equal(observer.state().sawText, true, 'text seen before the repeated start must survive');
});

test('state() exposes flags without message bodies beyond a short tail', () => {
  const { observer } = observerWith();
  observer.observe(start());
  observer.observe(textDelta('x'.repeat(500)));
  const state = observer.state();
  assert.equal(state.sawText, true);
  assert.equal(state.textTail.length <= 120, true);
});

test('observe() tolerates garbage frames', () => {
  const { observer } = observerWith();
  for (const junk of [null, undefined, 42, 'x', {}, { type: 'start' }, { chunk: null }]) {
    assert.doesNotThrow(() => observer.observe(junk));
  }
});

// ── splitText ─────────────────────────────────────────────────────────────

test('short text is a single chunk', () => {
  assert.deepEqual(splitText('短', 100), ['短']);
  assert.deepEqual(splitText('', 100), ['']);
});

test('long text splits at a newline before the limit', () => {
  const line = 'a'.repeat(50);
  const text = `${line}\n${line}\n${line}`;
  const chunks = splitText(text, 60);
  assert.equal(chunks.every(c => c.length <= 60), true);
  assert.equal(chunks.join('\n').replace(/\n+/g, '').length, text.replace(/\n+/g, '').length);
});

test('unbreakable text is hard-split without exceeding the limit', () => {
  const chunks = splitText('x'.repeat(250), 100);
  assert.equal(chunks.length, 3);
  for (const chunk of chunks) assert.equal(chunk.length <= 100, true);
});

test('Chinese punctuation is preferred over a hard cut', () => {
  const chunks = splitText(`${'字'.repeat(60)}。${'字'.repeat(60)}`, 100);
  assert.equal(chunks[0].endsWith('。'), true);
});

// ── inboundLine / defaultCorrection ───────────────────────────────────────

test('inboundLine names the channel and the sender', () => {
  const line = inboundLine({ mid: 5, fromUid: 1, target: { channel: 1 }, content: 'hi' });
  assert.match(line, /频道 gid=1/);
  assert.match(line, /mid=5 from_uid=1/);
  assert.match(line, /hi$/);
});

test('inboundLine names the peer for a DM', () => {
  const line = inboundLine({ mid: 6, fromUid: 3, target: { user: 4 }, content: 'hi' });
  assert.match(line, /私聊（对方 uid=3）/);
});

test('defaultCorrection names the room and forbids repeating', () => {
  const text = defaultCorrection('vc-chan-1');
  assert.match(text, /频道 1/);
  assert.match(text, /vc_message/);
  assert.match(text, /不要重复/);
});

test('an idle agent gets followup, not inject (inject never wakes anything)', () => {
  // This is the measured bug from the first end-to-end run: `inject` on an idle agent returned
  // without error and the message sat in the inbox, so the session gained a turn-start line and
  // nothing else. The seam must follow the agent's own state.
  const seen = [];
  const idle = { status: 'idle', inject: m => seen.push(['inject', m]), followup: m => seen.push(['followup', m]) };
  assert.equal(deliverTo(idle, 'm'), 'followup');
  assert.deepEqual(seen, [['followup', 'm']]);
});

test('a running agent gets inject so the active turn is not interrupted', () => {
  const seen = [];
  const running = { status: 'running', inject: m => seen.push(['inject', m]), followup: m => seen.push(['followup', m]) };
  assert.equal(deliverTo(running, 'm'), 'inject');
  assert.deepEqual(seen, [['inject', 'm']]);
});

test('followup is used when inject is missing, and inject when followup is missing', () => {
  const seen = [];
  const noInject = { status: 'idle', followup: m => seen.push(['followup', m]) };
  assert.equal(deliverTo(noInject, 'm1'), 'followup');
  const noFollowup = { status: 'running', inject: m => seen.push(['inject', m]) };
  assert.equal(deliverTo(noFollowup, 'm2'), 'inject');
});

test('a throwing primary seam falls back to the other one', () => {
  const seen = [];
  const throwInject = { status: 'idle', inject: () => { throw new Error('no'); }, followup: m => seen.push(['followup', m]) };
  // idle → followup first; the throwing inject is never reached.
  assert.equal(deliverTo(throwInject, 'm'), 'followup');
  const throwFollowup = { status: 'idle', inject: m => seen.push(['inject', m]), followup: () => { throw new Error('no'); } };
  assert.equal(deliverTo(throwFollowup, 'm2'), 'inject');
});

test('an unknown status is treated as idle (wake up beats sit quietly)', () => {
  const seen = [];
  const unknown = { inject: m => seen.push(['inject', m]), followup: m => seen.push(['followup', m]) };
  assert.equal(deliverTo(unknown, 'm'), 'followup');
});

test('nothing deliverable returns null', () => {
  assert.equal(deliverTo(null, 'm1'), null);
  assert.equal(deliverTo({}, 'm2'), null);
});
