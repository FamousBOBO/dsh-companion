import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readWorkspaceGuard, effectiveRoute } from '../route.mjs';

function tempRoot(config) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-route-'));
  fs.mkdirSync(path.join(root, 'home', 'companion'), { recursive: true });
  if (config !== null) {
    fs.writeFileSync(path.join(root, 'home', 'companion', 'workspace-context.json'), JSON.stringify(config));
  }
  return root;
}

test('a missing config means no mapping at all', () => {
  const root = tempRoot(null);
  assert.equal(readWorkspaceGuard(root), null);
  const route = { provider: 'opencode-go', model: 'm' };
  assert.equal(effectiveRoute(route, 'C:/x', null), route);
});

test('enabled:false is honoured, not ignored', () => {
  const root = tempRoot({ enabled: false, sourceProvider: 'a', aliasProvider: 'b', workspace: 'C:/x' });
  assert.equal(readWorkspaceGuard(root), null);
});

test('a config with the same source and alias is a no-op', () => {
  const root = tempRoot({ enabled: true, sourceProvider: 'a', aliasProvider: 'a', workspace: 'C:/x' });
  assert.equal(readWorkspaceGuard(root), null);
});

test('the guarded workspace gets the alias; anything else keeps the source', () => {
  const root = tempRoot({
    enabled: true,
    sourceProvider: 'opencode-go',
    aliasProvider: 'opencode-go-companion-256k',
    workspace: 'D:\\DSH\\dsh-production\\data\\workspace',
  });
  const guard = readWorkspaceGuard(root);
  assert.equal(guard.aliasProvider, 'opencode-go-companion-256k');

  const inside = effectiveRoute({ provider: 'opencode-go', model: 'v4' }, 'D:/DSH/dsh-production/data/workspace', guard);
  assert.equal(inside.provider, 'opencode-go-companion-256k');
  assert.equal(inside.model, 'v4', 'the model must not be rewritten');

  const outside = effectiveRoute({ provider: 'opencode-go', model: 'v4' }, 'D:/other/place', guard);
  assert.equal(outside.provider, 'opencode-go');
});

test('an unrelated provider is never rewritten', () => {
  const root = tempRoot({
    enabled: true, sourceProvider: 'opencode-go', aliasProvider: 'alias', workspace: 'D:/w',
  });
  const guard = readWorkspaceGuard(root);
  const route = effectiveRoute({ provider: 'deepseek', model: 'm' }, 'D:/w', guard);
  assert.equal(route.provider, 'deepseek');
});

test('the alias already being in place is stable (idempotent)', () => {
  const root = tempRoot({
    enabled: true, sourceProvider: 'opencode-go', aliasProvider: 'alias', workspace: 'D:/w',
  });
  const guard = readWorkspaceGuard(root);
  const once = effectiveRoute({ provider: 'opencode-go', model: 'm' }, 'D:/w', guard);
  const twice = effectiveRoute(once, 'D:/w', guard);
  assert.deepEqual(once, twice);
});

test('windows spelling differences still match', () => {
  const root = tempRoot({
    enabled: true, sourceProvider: 's', aliasProvider: 'a',
    workspace: 'D:\\DSH\\dsh-production\\data\\workspace',
  });
  const guard = readWorkspaceGuard(root);
  const route = effectiveRoute({ provider: 's', model: 'm' }, 'D:/DSH/dsh-production/data/workspace/', guard);
  assert.equal(route.provider, 'a');
});

test('an empty workspace in the config does not guess', () => {
  const root = tempRoot({ enabled: true, sourceProvider: 's', aliasProvider: 'a', workspace: '' });
  const guard = readWorkspaceGuard(root);
  assert.equal(guard.workspace, '');
  const route = effectiveRoute({ provider: 's', model: 'm' }, 'D:/anything', guard);
  assert.equal(route.provider, 's', 'without a workspace there is no mapping to apply');
});
