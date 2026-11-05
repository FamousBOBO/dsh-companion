import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { groupIdOf, groupToolDenial, markGroupReady, GROUP_ALLOWED_TOOLS, GROUP_MEDIA_TOOLS } from './core.mjs?v=group-media-20261102-restrict3';
import { apply as boundary } from './boundary.mjs';
import { apply as persona, GROUP_PERSONA } from './index.mjs';
import { createIdentity } from '../companion-foundation/identity.mjs';

const agent = (id = 'qq-group-123') => ({ id, session: { id }, ctx: { tools: { restrict() {} } } });
const send = (a, over = {}) => ({ agent: a, name: 'qq_message', arguments: { action: 'send', isGroup: true, target: 123, text: '你好', phase: 'final', ...over } });

// 媒体根（真实 `home/media` 的绝对路径）与一个"合法的"媒体产物路径。
const MEDIA_ROOT = path.resolve('plugins/companion-group', '../..', 'home', 'media');
const OPTS = { mediaRoot: MEDIA_ROOT };
const mediaFile = name => path.join(MEDIA_ROOT, 'artifacts', name);
const sticker = (a, over = {}) => ({ agent: a, name: 'qq_sticker', arguments: { action: 'send', isGroup: true, target: 123, file: mediaFile('image/abc.png'), ...over } });
const voice = (a, over = {}) => ({ agent: a, name: 'qq_voice', arguments: { action: 'send_file', isGroup: true, target: 123, file: mediaFile('speech/abc.mp3'), ...over } });

test('owner identity refuses group, foreign DM and malformed QQ ids, including old persisted bindings', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'group-identity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'home/companion'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'identity.json');
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, persona: 'march7', owner: { id: '456', displayName: 'Synthetic', platform: 'qq' }, desktop: { mode: 'local-owner', userId: '456' }, sessions: { 'qq-group-123': { userId: '456', persona: 'march7' } } }));
  const identity = createIdentity(root); const before = fs.readFileSync(file, 'utf8');
  for (const id of ['qq-group-123', 'qq-group-999', 'qq-dm-789', 'qq-unknown', 'qq-dm-0456']) {
    assert.throws(() => identity.resolve(id), /Owner memory is unavailable/);
    assert.throws(() => identity.context(id), /Owner memory is unavailable/);
  }
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'denial must not write bindings');
  assert.equal(identity.resolve('qq-dm-456').userId, '456');
  assert.equal(identity.resolve('desktop-synthetic').userId, '456');
});

test('group tool boundary defaults deny, even if tools/policy switches change', () => {
  const a = agent();
  assert.match(groupToolDenial(send(a)), /未就绪/);
  markGroupReady(a);
  assert.equal(groupToolDenial(send(a)), undefined);
  for (const name of ['pwsh', 'bash', 'read', 'write', 'edit', 'run_code', 'subagent_codex', 'bili_run', 'companion_recall', 'companion_remember', 'companion_media_warm', 'qq_lookup', 'qq_group_admin', 'qq_memory', 'qq_file', 'qq_music', 'future_unknown_tool']) {
    assert.match(groupToolDenial({ ...send(a), name }, OPTS), /只开放/);
  }
  assert.equal(groupToolDenial({ ...send(agent('qq-dm-456')), name: 'pwsh' }), undefined, 'owner DM unchanged');
});

test('media tools are open to the group: inspect / draw / speak / job / status never touch QQ directly', () => {
  const a = agent(); markGroupReady(a);
  assert.deepEqual(GROUP_MEDIA_TOOLS, ['companion_media_status', 'companion_media_inspect', 'companion_media_draw', 'companion_media_speak', 'companion_media_job']);
  for (const name of GROUP_MEDIA_TOOLS) {
    assert.equal(groupToolDenial({ agent: a, name, arguments: {} }, OPTS), undefined, name);
  }
  assert.match(groupToolDenial({ agent: a, name: 'companion_media_warm', arguments: { action: 'warm', target: 'voice' } }, OPTS), /只开放/, 'GPU warm/release stays closed');
  assert.equal(typeof groupToolDenial({ agent: agent(), name: 'companion_media_draw', arguments: { prompt: 'x' } }, OPTS), 'string', 'unready preset still refuses');
});

test('image sending: only qq_sticker action=send of a media-layer file inside home/media', () => {
  const a = agent(); markGroupReady(a);
  assert.equal(groupToolDenial(sticker(a), OPTS), undefined);
  assert.equal(groupToolDenial(sticker(a, { file: mediaFile('image/中文 名字.png') }), OPTS), undefined, 'spaces and CJK are fine');
  for (const over of [
    { action: 'send_by_mood' }, { action: 'list' }, { action: 'make' },
    { target: 999 }, { isGroup: false },
    { file: path.join(MEDIA_ROOT, '../secrets.png') },
    { file: path.join(MEDIA_ROOT, '..', 'identity.json') },
    { file: 'C:/Windows/win.ini' },
    { file: 'artifacts/image/abc.png' },
    { file: '[CQ:image,file=x.png]' },
    { file: '' },
    { text: '附带文字' },
  ]) {
    assert.equal(typeof groupToolDenial(sticker(a, over), OPTS), 'string', JSON.stringify(over));
  }
  assert.equal(typeof groupToolDenial(sticker(a), {}), 'string', 'no mediaRoot → fail closed');
  assert.equal(typeof groupToolDenial(sticker(a)), 'string', 'no options at all → fail closed');
});

test('voice sending: only qq_voice action=send_file of a media-layer file inside home/media', () => {
  const a = agent(); markGroupReady(a);
  assert.equal(groupToolDenial(voice(a), OPTS), undefined);
  for (const over of [
    { action: 'tts_send' }, { action: 'ai_send' }, { action: 'tts_save' },
    { target: 999 }, { isGroup: false },
    { file: path.join(MEDIA_ROOT, '..', 'home', 'channel-qq', 'x.mp3') },
    { file: 'C:/Users/bobo/secret.mp3' },
    { file: 'speech/abc.mp3' },
    { voice: 'march7_B' },
  ]) {
    assert.equal(typeof groupToolDenial(voice(a, over), OPTS), 'string', JSON.stringify(over));
  }
  assert.equal(typeof groupToolDenial(voice(a), {}), 'string', 'no mediaRoot → fail closed');
});

test('same-room text only: reject cross-room, spoofing, CQ, wrong types and unexpected fields', () => {
  const a = agent(); markGroupReady(a);
  for (const over of [{ target: 999 }, { isGroup: false }, { action: 'reply', messageId: 42 }, { action: 'code_review' }, { target: '123' }, { text: '[CQ:image,file=C:/secret.png]' }, { text: '' }, { text: 'x'.repeat(4001) }, { file: 'C:/secret' }, { phase: 'unknown' }]) {
    assert.equal(typeof groupToolDenial(send(a, over)), 'string');
  }
  assert.equal(groupToolDenial({ ...send(a), arguments: JSON.stringify(send(a).arguments) }), undefined);
  assert.match(groupToolDenial({ ...send(a), arguments: '{' }), /无效/);
  const mismatch = { id: 'qq-dm-456', session: { id: 'qq-group-123' } };
  assert.equal(groupIdOf(mismatch), false);
  assert.equal(typeof groupToolDenial(send(mismatch)), 'string');
  assert.equal(groupIdOf(agent('qq-group-9007199254740992')), false);
});

test('real mount wiring: monotonic global guard + group scoped restriction and model entry check', async () => {
  let guard, rootHook, groupHook, restriction, section;
  boundary({ get: () => ({ identity: { owner: () => ({ id: '456' }), resolve: id => ({ id }) } }), tools: { guard(fn) { guard = fn; } }, on(name, hook) { if (name === 'agent/pre-step') rootHook = hook; } });
  persona({ tools: { guard() {}, restrict(value) {
    // Mirror the host contract: local media names are not restrictable globals.
    const globals = new Set(['qq_message', 'qq_sticker', 'qq_voice']);
    for (const name of value.allow) assert.ok(globals.has(name), 'unknown global tool: ' + name);
    restriction = value;
  } }, systemPrompt: { section(value) { section = value; } }, on(name, hook) { if (name === 'agent/pre-step') groupHook = hook; } });
  assert.equal(restriction, undefined, 'validation before QQ startup must not fail');
  assert.equal(section.text, GROUP_PERSONA);
  const a = agent();
  a.ctx.tools.restrict = value => {
    const inherited = new Set(GROUP_ALLOWED_TOOLS);
    for (const name of value.allow) assert.ok(inherited.has(name));
    restriction = value;
  };
  const event = { agent: a, step: 1 };
  assert.equal((await rootHook(event, async () => ({ kind: 'enter' }))).kind, 'reject', 'old owner preset cannot run');
  assert.equal((await rootHook(event, () => groupHook(event, async () => ({ kind: 'enter' })))).kind, 'enter');
  assert.deepEqual(restriction, { allow: [...GROUP_ALLOWED_TOOLS] });
  assert.equal(typeof guard({ agent: a, name: 'pwsh', arguments: {} }), 'string');
  assert.equal(guard({ agent: a, name: 'companion_media_status', arguments: {} }), undefined);
  assert.equal(guard(send(a)), undefined);
  assert.equal((await groupHook({ agent: agent('qq-dm-456') }, async () => ({ kind: 'enter' }))).kind, 'reject');
  assert.throws(() => boundary({ tools: {}, on() {} }), /tools.guard/);
  assert.throws(() => persona({ tools: {}, systemPrompt: {}, on() {} }), /tools.restrict/);
});

test('successful group receipt ends turn; failure and fresh user input allow recovery', async () => {
  const hooks = new Map();
  persona({ tools: { guard() {}, restrict() {} }, systemPrompt: { section() {} }, on(name, fn) { hooks.set(name, fn); } });
  const a = agent(); const session = a.session;
  const hook = hooks.get('agent/pre-step');
  const next = async () => ({ kind: 'enter' });
  const event = { agent: a, step: 1, turn: 7, messages: [] };
  await hook(event, next);
  const receipt = (isError, text) => {
    hooks.get('session/event')(session, { type: 'tool/call', data: { callId: 'x', name: 'qq_message', turn: 7 } });
    hooks.get('session/event')(session, { type: 'tool/result', data: { message: { toolCallId: 'x', isError, content: [{ type: 'text', text }] } } });
  };
  receipt(false, '{"error":"offline"}');
  assert.equal((await hook({ ...event, step: 2 }, next)).kind, 'enter');
  receipt(true, '{"message_id":42}');
  assert.equal((await hook({ ...event, step: 2 }, next)).kind, 'enter');
  receipt(false, '{"message_id":42}');
  assert.equal((await hook({ ...event, step: 2 }, next)).kind, 'reject');
  assert.equal((await hook({ ...event, step: 2, messages: [{ source: { kind: 'user' } }] }, next)).kind, 'enter');
});

test('group preset installs its own execution guard even without the optional root boundary', async () => {
  let scopedGuard, step;
  persona({ tools: { guard(fn) { scopedGuard = fn; }, restrict() {} }, systemPrompt: { section() {} }, on(name, fn) { if (name === 'agent/pre-step') step = fn; } });
  const a = agent();
  assert.equal(typeof scopedGuard(send(a)), 'string');
  await step({ agent: a, step: 1, turn: 1 }, async () => ({ kind: 'enter' }));
  assert.equal(scopedGuard(send(a)), undefined);
  assert.equal(typeof scopedGuard(send(a, { target: 999 })), 'string');
  assert.equal(typeof scopedGuard({ ...send(a), name: 'companion_recall' }), 'string');
  assert.throws(() => persona({ tools: { restrict() {} } }), /tools.guard/);
});

test('restrictions bind to each agent scope once, preserving inherited preset media', async () => {
  let step;
  const calls = [];
  persona({ tools: { guard() {}, restrict() { throw Error('Preset-local names cannot be restricted here'); } }, systemPrompt: { section() {} }, on(name, fn) { if (name === 'agent/pre-step') step = fn; } });
  const a = agent('qq-group-123'), b = agent('qq-group-456');
  for (const item of [a, b]) item.ctx.tools.restrict = filter => calls.push({ id: item.id, filter });
  for (const item of [a, a, b]) await step({ agent: item, step: 1, turn: 1 }, async () => ({ kind: 'enter' }));
  assert.deepEqual(calls.map(c => c.id), ['qq-group-123', 'qq-group-456']);
  for (const call of calls) assert.deepEqual(call.filter, { allow: [...GROUP_ALLOWED_TOOLS] });
});