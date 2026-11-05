import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refreshStoredContexts } from './workspace-context-state.mjs';
import { workspaceRoute, COMPANION_PROVIDER, COMPANION_WINDOW, SOURCE_PROVIDER, DEFAULT_WINDOW } from './workspace-context.mjs';

// Synthetic paths: the module under test never knows where the suite lives.
const root = 'C:/synthetic/suite/data';
const workspace = `${root}/workspace`;

test('old 1M projections refresh to per-workspace capacities without modifying old events', async () => {
  const data = [workspace, root].map((cwd, i) => ({ header: { id: String(i), cwd },
    events: [{ seq: 0, time: 1, type: 'request/context', data: { provider: SOURCE_PROVIDER, model: 'synthetic-model', contextWindow: 1000000 } }] }));
  const before = structuredClone(data);
  const storage = { list: async () => data, open: async id => {
    const row = data[Number(id)];
    return { header: row.header, read: async () => ({ events: row.events }),
      append: async events => row.events.push(...events), flush: async () => {}, close: async () => {} };
  } };
  const services = { sessions: { get: () => undefined }, sessionPersistence: storage,
    llm: { resolveModelInfo: async provider => ({ context: { contextWindow: provider === COMPANION_PROVIDER ? COMPANION_WINDOW : DEFAULT_WINDOW } }) } };
  const ctx = { get: name => services[name] };
  const routeFor = (header, previous) => workspaceRoute(previous, header.cwd, workspace);
  assert.deepEqual(await refreshStoredContexts(ctx, routeFor), { updated: 2, skipped: 0 });
  assert.equal(data[0].events.at(-1).data.contextWindow, COMPANION_WINDOW);
  assert.equal(data[1].events.at(-1).data.contextWindow, DEFAULT_WINDOW);
  assert.deepEqual(data.map(row => row.events[0]), before.map(row => row.events[0]));
  assert.deepEqual(await refreshStoredContexts(ctx, routeFor), { updated: 0, skipped: 0 });
});
