// `companion_pulse`: argument convergence, fixed failure table, and "never throw at the model".

import test from 'node:test';
import assert from 'node:assert/strict';

import { registerPulseTools, PULSE_ACTIONS, PULSE_FAILURES, PULSE_TOOL_NAMES } from './pulse-tools.mjs';

/** Capture what `registerPulseTools` would hand the host. */
function harness(service) {
  const calls = [];
  const register = (name, description, parameters, execute, kind) => {
    calls.push({ name, description, parameters, execute, kind });
  };
  const result = registerPulseTools({ register, getService: () => service });
  return { ...result, calls, tool: calls[0] };
}

function fakeService(overrides = {}) {
  const seen = [];
  return {
    seen,
    pulseSession: async args => { seen.push(['pulseSession', args]); return { ok: true, session: { active: args.action === 'start' } }; },
    pulseHistory: async args => { seen.push(['pulseHistory', args]); return { ok: true, sessions: [] }; },
    ...overrides,
  };
}

test('registers exactly one read-kind tool with the contract name', () => {
  const { registered, calls } = harness(fakeService());
  assert.deepEqual([...PULSE_TOOL_NAMES], ['companion_pulse']);
  assert.deepEqual(registered, ['companion_pulse']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'companion_pulse');
  assert.equal(calls[0].kind, 'read');
  assert.deepEqual(calls[0].parameters.action.enum, [...PULSE_ACTIONS]);
});

test('an unknown action is refused by name and never reaches the service', async () => {
  const service = fakeService();
  const { tool } = harness(service);
  const result = await tool.execute({ action: 'dance' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'pulse-bad-action');
  assert.equal(result.message, PULSE_FAILURES['pulse-bad-action']);
  assert.equal(service.seen.length, 0);
});

test('an action is normalised before dispatch', async () => {
  const service = fakeService();
  const { tool } = harness(service);
  await tool.execute({ action: '  START ' });
  assert.equal(service.seen[0][0], 'pulseSession');
  assert.equal(service.seen[0][1].action, 'start');
});

test('a missing service is a typed answer, not a crash', async () => {
  const { tool } = harness(null);
  const result = await tool.execute({ action: 'status' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'health-not-mounted');
  assert.equal(result.message, PULSE_FAILURES['health-not-mounted']);
});

test('service refusals keep their code and get the fixed Chinese sentence', async () => {
  const { tool } = harness(fakeService({
    pulseSession: async () => ({ ok: false, code: 'pulse-denied', secret: 'should-not-be-forwarded' }),
  }));
  const result = await tool.execute({ action: 'status' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'pulse-denied');
  assert.equal(result.message, PULSE_FAILURES['pulse-denied']);
  assert.equal(result.secret, 'should-not-be-forwarded');
});

test('every documented failure code has a fixed message', () => {
  for (const code of ['health-not-mounted', 'health-pulse-unavailable', 'pulse-denied', 'pulse-disabled',
    'pulse-unreachable', 'pulse-no-session', 'pulse-bad-action', 'pulse-failed']) {
    assert.equal(typeof PULSE_FAILURES[code], 'string', `missing message for ${code}`);
    assert.ok(PULSE_FAILURES[code].length > 0);
  }
});

test('minutes are clamped into the supported window and labels are truncated', async () => {
  const service = fakeService();
  const { tool } = harness(service);

  await tool.execute({ action: 'start', minutes: 999 });
  assert.equal(service.seen.at(-1)[1].minutes, 120);

  await tool.execute({ action: 'start', minutes: 1 });
  assert.equal(service.seen.at(-1)[1].minutes, 5);

  await tool.execute({ action: 'start', minutes: 'not a number' });
  assert.equal(service.seen.at(-1)[1].minutes, null, 'non-numeric minutes defer to the configured default');

  await tool.execute({ action: 'mark', label: 'x'.repeat(200) });
  assert.equal(service.seen.at(-1)[1].label.length, 40);
});

test('history takes its own path with a bounded limit', async () => {
  const service = fakeService();
  const { tool } = harness(service);
  const result = await tool.execute({ action: 'history' });
  assert.equal(result.ok, true);
  assert.deepEqual(service.seen[0], ['pulseHistory', { limit: 5 }]);
});

test('a service that throws still yields a typed answer', async () => {
  const { tool } = harness(fakeService({ pulseSession: async () => { throw new Error('db gone'); } }));
  const result = await tool.execute({ action: 'start' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'pulse-failed');
  assert.doesNotMatch(JSON.stringify(result), /db gone/, 'exception text never reaches the model');
});

test('private-looking keys are stripped from a successful answer', async () => {
  const { tool } = harness(fakeService({
    pulseSession: async () => ({ ok: true, uid: '123456', token: 'abc', bpm: 96 }),
  }));
  const result = await tool.execute({ action: 'status' });
  assert.equal(result.ok, true);
  assert.equal(result.bpm, 96);
  assert.equal(result.uid, undefined);
  assert.equal(result.token, undefined);
});
