import test from 'node:test';
import assert from 'node:assert/strict';

import { createSessions } from '../sessions.mjs';

function fakeHarness({ existing = null, createThrows = null, defaultRoute = null } = {}) {
  const calls = [];
  let live = existing;
  const agents = {
    get: id => { calls.push(['get', id]); return live ?? undefined; },
    create: async options => {
      calls.push(['create', options.sessionId, options.agentOptions]);
      if (createThrows) throw createThrows;
      return { agent: { session: { id: options.sessionId } } };
    },
    resume: async options => {
      calls.push(['resume', options.resumeSessionId, options.agentOptions]);
      live = { session: { id: options.resumeSessionId }, ctx: { on() {} } };
      return { agent: live };
    },
  };
  const agentPresets = { resolve: async id => ({ id }), mount: async () => {} };
  const agentDefaultModel = defaultRoute === null
    ? undefined
    : { currentSelection: () => defaultRoute };
  return { agents, agentPresets, agentDefaultModel, calls };
}

test('an explicit provider/model is used verbatim', async () => {
  const { agents, agentPresets, agentDefaultModel, calls } = fakeHarness();
  const sessions = createSessions({ agents, agentPresets, agentDefaultModel, setupPerAgent: () => {} });
  const result = await sessions.ensure({
    sessionId: 'vc-chan-1', presetId: 'companion', cwd: 'C:/x', provider: 'deepseek', model: 'v4',
  });
  assert.deepEqual(result.route, { provider: 'deepseek', model: 'v4' });
  const create = calls.find(c => c[0] === 'create');
  assert.deepEqual(create[2].provider, 'deepseek');
});

test('with no explicit route, the host default is resolved — an empty route makes turns fail', async () => {
  // Measured: `provider: ''`/`model: ''` reached `agents.create`, the turn errored with an opaque
  // "unknown", and nothing was written to the session log.
  const { agents, agentPresets, agentDefaultModel, calls } = fakeHarness({ defaultRoute: { provider: 'deepseek', model: 'v4-pro' } });
  const sessions = createSessions({ agents, agentPresets, agentDefaultModel, setupPerAgent: () => {} });
  const result = await sessions.ensure({ sessionId: 'vc-chan-2', presetId: 'companion', cwd: 'C:/x', provider: '', model: '' });
  assert.deepEqual(result.route, { provider: 'deepseek', model: 'v4-pro' });
  const create = calls.find(c => c[0] === 'create');
  assert.equal(create[2].model, 'v4-pro');
});

test('a partial route (only provider) also falls back to the default pair', async () => {
  const { agents, agentPresets, agentDefaultModel } = fakeHarness({ defaultRoute: { provider: 'p', model: 'm' } });
  const sessions = createSessions({ agents, agentPresets, agentDefaultModel, setupPerAgent: () => {} });
  const result = await sessions.ensure({ sessionId: 'vc-chan-3', presetId: 'companion', cwd: 'C:/x', provider: 'x', model: '' });
  assert.deepEqual(result.route, { provider: 'p', model: 'm' });
});

test('reasoningEffort from the host selection is carried through', async () => {
  const { agents, agentPresets, agentDefaultModel } = fakeHarness({ defaultRoute: { provider: 'p', model: 'm', reasoningEffort: 'high' } });
  const sessions = createSessions({ agents, agentPresets, agentDefaultModel, setupPerAgent: () => {} });
  const result = await sessions.ensure({ sessionId: 'vc-chan-4', presetId: 'companion', cwd: 'C:/x', provider: '', model: '' });
  assert.equal(result.route.reasoningEffort, 'high');
});

test('no route available at all fails loudly instead of creating a broken session', async () => {
  const { agents, agentPresets, agentDefaultModel, calls } = fakeHarness();
  const sessions = createSessions({ agents, agentPresets, agentDefaultModel, setupPerAgent: () => {} });
  await assert.rejects(
    sessions.ensure({ sessionId: 'vc-chan-5', presetId: 'companion', cwd: 'C:/x', provider: '', model: '' }),
    error => /没有可用的模型路由/.test(error.message),
  );
  assert.equal(calls.some(c => c[0] === 'create'), false, 'it must not create a session it cannot run');
});

test('maxTokens rides along when given', async () => {
  const { agents, agentPresets, agentDefaultModel } = fakeHarness({ defaultRoute: { provider: 'p', model: 'm' } });
  const sessions = createSessions({ agents, agentPresets, agentDefaultModel, setupPerAgent: () => {} });
  const result = await sessions.ensure({
    sessionId: 'vc-chan-6', presetId: 'companion', cwd: 'C:/x', provider: '', model: '', maxTokens: 512,
  });
  assert.equal(result.route.maxTokens, 512);
});
