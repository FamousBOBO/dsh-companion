import test from 'node:test';
import assert from 'node:assert/strict';

import { createSessions } from '../sessions.mjs';

/** A registry whose `get()` deliberately misses, like the real one does after `resume()`. */
function missyHarness() {
  const calls = [];
  let stored = null;
  const agents = {
    get: id => { calls.push(['get', id]); return undefined; }, // <- always misses on purpose
    create: async options => {
      calls.push(['create', options.sessionId]);
      throw new Error(`session "${options.sessionId}" already exists`);
    },
    resume: async options => {
      calls.push(['resume', options.resumeSessionId]);
      stored = {
        status: 'idle',
        session: { id: options.resumeSessionId },
        ctx: { on() {} },
        model: { select() {} },
        followup() {},
      };
      return { agent: stored };
    },
  };
  const agentPresets = { resolve: async id => ({ id }), mount: async () => {} };
  const agentDefaultModel = { currentSelection: () => ({ provider: 'p', model: 'm' }) };
  return { agents, agentPresets, agentDefaultModel, calls, stored: () => stored };
}

test('the first call pays create→resume; the second uses the cached agent', async () => {
  // Measured: `agents.get()` returned undefined even right after `resume()`, so every message
  // paid create → SessionAlreadyExistsError → 1.5 s backoff → resume.
  const { agents, agentPresets, agentDefaultModel, calls, stored } = missyHarness();
  const sessions = createSessions({ agents, agentPresets, agentDefaultModel, setupPerAgent: () => {} });

  const first = await sessions.ensure({ sessionId: 'vc-chan-1', presetId: 'companion', cwd: 'C:/x' });
  assert.equal(first.resumed, true);
  assert.equal(calls.filter(c => c[0] === 'create').length, 1);

  const second = await sessions.ensure({ sessionId: 'vc-chan-1', presetId: 'companion', cwd: 'C:/x' });
  assert.equal(second.cached, true);
  assert.equal(second.agent, stored(), 'the cached agent is the one we were given');
  // No extra create, no extra resume, no extra registry lookup for the second message.
  assert.equal(calls.filter(c => c[0] === 'create').length, 1);
  assert.equal(calls.filter(c => c[0] === 'resume').length, 1);
});

test('a cached agent that lost its status is discarded, not returned', async () => {
  const { agents, agentPresets, agentDefaultModel, calls, stored } = missyHarness();
  const sessions = createSessions({ agents, agentPresets, agentDefaultModel, setupPerAgent: () => {} });
  await sessions.ensure({ sessionId: 'vc-chan-2', presetId: 'companion', cwd: 'C:/x' });

  // Simulate disposal: the harness stops mirroring `status`.
  const agent = stored();
  delete agent.status;

  const again = await sessions.ensure({ sessionId: 'vc-chan-2', presetId: 'companion', cwd: 'C:/x' });
  assert.equal(again.cached, undefined, 'a disposed agent must not be reused');
  assert.equal(calls.filter(c => c[0] === 'resume').length, 2, 'it re-resolves through the registry');
});

test('each session keeps its own cache entry', async () => {
  const { agents, agentPresets, agentDefaultModel, calls } = missyHarness();
  const sessions = createSessions({ agents, agentPresets, agentDefaultModel, setupPerAgent: () => {} });
  await sessions.ensure({ sessionId: 'vc-chan-1', presetId: 'companion', cwd: 'C:/x' });
  await sessions.ensure({ sessionId: 'vc-dm-1', presetId: 'companion', cwd: 'C:/x' });
  assert.equal(calls.filter(c => c[0] === 'resume').length, 2, 'two rooms, two agents');
  const a = await sessions.ensure({ sessionId: 'vc-chan-1', presetId: 'companion', cwd: 'C:/x' });
  const b = await sessions.ensure({ sessionId: 'vc-dm-1', presetId: 'companion', cwd: 'C:/x' });
  assert.equal(a.cached, true);
  assert.equal(b.cached, true);
  assert.notEqual(a.agent, b.agent, 'rooms must not share one agent');
});
