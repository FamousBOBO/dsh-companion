import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refreshStoredContexts } from './workspace-context-state.mjs';
import { workspaceRoute, COMPANION_PROVIDER } from './workspace-context.mjs';

test('old 1M projections refresh to per-workspace capacities without modifying old events', async () => {
  const root = 'C:/Users/bobo/Documents/Bot/dsh-companion';
  const data = [root + '/workspace', root].map((cwd, i) => ({ header: { id: String(i), cwd },
    events: [{ seq: 0, time: 1, type: 'request/context', data: { provider: 'opencode-go', model: 'deepseek-v4.1-flash', contextWindow: 1000000 } }] }));
  const before = structuredClone(data);
  const storage = { list: async () => data, open: async id => {
    const row = data[Number(id)];
    return { header: row.header, read: async () => ({ events: row.events }),
      append: async events => row.events.push(...events), flush: async () => {}, close: async () => {} };
  } };
  const services = { sessions: { get: () => undefined }, sessionPersistence: storage,
    llm: { resolveModelInfo: async provider => ({ context: { contextWindow: provider === COMPANION_PROVIDER ? 262144 : 524288 } }) } };
  const ctx = { get: name => services[name] };
  const routeFor = (header, previous) => workspaceRoute(previous, header.cwd);
  assert.deepEqual(await refreshStoredContexts(ctx, routeFor), { updated: 2, skipped: 0 });
  assert.equal(data[0].events.at(-1).data.contextWindow, 262144);
  assert.equal(data[1].events.at(-1).data.contextWindow, 524288);
  assert.deepEqual(data.map(row => row.events[0]), before.map(row => row.events[0]));
  assert.deepEqual(await refreshStoredContexts(ctx, routeFor), { updated: 0, skipped: 0 });
});
