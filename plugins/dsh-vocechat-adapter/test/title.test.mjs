// 会话标题：`vc-dm-1` 这种内部键在侧栏里认不出是谁，QQ 那条通道显示的是 `QQ 私聊1429709395`。
//
// 这层只影响显示，所以三条硬要求：
//   1. 没有 `sessionTitle`（profile 里没这一行）时**什么都不做**，也不抛；
//   2. 标题已经对时**不再写**，否则每来一条消息都会往会话日志里追加一条 `session/title`；
//   3. `rename()` 抛（会话不 live、标题非法）时只记一行日志，消息照发。

import test from 'node:test';
import assert from 'node:assert/strict';

import { sessionTitleOf } from '../index.mjs';
import { createSessions } from '../sessions.mjs';

function harness({ titles } = {}) {
  const renamed = [];
  const agent = { session: { id: 'vc-dm-1' }, status: 'idle', ctx: {}, model: { select() {} } };
  const agents = { get: () => agent, create: async () => ({ agent }), resume: async () => ({ agent }) };
  const agentPresets = { resolve: async id => ({ id }), mount: async () => {} };
  const lines = [];
  const sessions = createSessions({
    agents,
    agentPresets,
    setupPerAgent: () => {},
    titles: titles === undefined
      ? { get: () => undefined, rename: (session, title) => { renamed.push([session.id, title]); } }
      : titles,
    titleOf: sessionTitleOf,
    log: line => lines.push(line),
  });
  return { sessions, renamed, lines, agent };
}

test('a DM room is titled by its peer uid, a channel by its gid', () => {
  assert.equal(sessionTitleOf('vc-dm-1'), 'VoceChat 私聊1');
  assert.equal(sessionTitleOf('vc-chan-1'), 'VoceChat 频道1');
  // Anything that is not one of our rooms gets no title at all rather than a made-up one.
  assert.equal(sessionTitleOf('qq-dm-1'), '');
  assert.equal(sessionTitleOf(''), '');
});

test('ensure() names the session once, and does not rewrite an already-correct title', async () => {
  const { sessions, renamed } = harness();
  await sessions.ensure({ sessionId: 'vc-dm-1', presetId: 'companion', cwd: 'C:/x', provider: 'p', model: 'm' });
  assert.deepEqual(renamed, [['vc-dm-1', 'VoceChat 私聊1']]);
});

test('an unchanged title is not appended again on the next turn', async () => {
  let current;
  const titles = {
    get: () => (current === undefined ? undefined : { title: current }),
    rename: (_session, title) => { current = title; },
  };
  const { sessions } = harness({ titles });
  await sessions.ensure({ sessionId: 'vc-dm-1', presetId: 'companion', cwd: 'C:/x', provider: 'p', model: 'm' });
  await sessions.ensure({ sessionId: 'vc-dm-1', presetId: 'companion', cwd: 'C:/x', provider: 'p', model: 'm' });
  assert.equal(current, 'VoceChat 私聊1');
});

test('a title a human already chose is never overwritten', async () => {
  // vc-chan-1 上真有人工标题「VoceChat 生产入站验证」；自动命名只能补空缺，不能盖掉它。
  const renamed = [];
  const titles = {
    get: () => ({ title: 'VoceChat 生产入站验证' }),
    rename: (_session, title) => { renamed.push(title); },
  };
  const { sessions } = harness({ titles });
  await sessions.ensure({ sessionId: 'vc-dm-1', presetId: 'companion', cwd: 'C:/x', provider: 'p', model: 'm' });
  assert.deepEqual(renamed, [], 'an existing title must survive, even when it does not match the generated one');
});

test('a throwing rename never blocks the turn', async () => {
  const titles = { get: () => undefined, rename: () => { throw new Error('session "vc-dm-1" is not live in this store'); } };
  const { sessions, lines } = harness({ titles });
  const result = await sessions.ensure({ sessionId: 'vc-dm-1', presetId: 'companion', cwd: 'C:/x', provider: 'p', model: 'm' });
  assert.equal(result.agent.status, 'idle');
  assert.ok(lines.some(line => line.includes('起名失败')), 'the failure must be visible in the log');
});

test('a profile without sessionTitle still runs turns', async () => {
  const { sessions, renamed } = harness({ titles: null });
  const result = await sessions.ensure({ sessionId: 'vc-dm-1', presetId: 'companion', cwd: 'C:/x', provider: 'p', model: 'm' });
  assert.equal(result.agent.session.id, 'vc-dm-1');
  assert.deepEqual(renamed, []);
});
