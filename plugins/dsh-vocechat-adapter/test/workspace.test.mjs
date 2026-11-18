// 工作区归属：`vc-*` 会话必须挂进它 cwd 对应的那个工作区，否则侧栏里只能落到「未分组」。
//
// 三条实测约束（2026-11-18）：
//   1. `attachSession` 会 realpath 比较会话头里的 cwd 与工作区路径，不一致就抛 → 只能挂到匹配的那个；
//   2. 重复登记不报错，所以启动重扫是安全的；
//   3. 归属失败只影响显示，绝不能挡住消息 → 这条路径永不抛，只返回 `{attached, reason}`。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { listStoredSessions, attachToWorkspace } from '../workspace.mjs';

function homeWith(ids) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-ws-'));
  const project = path.join(home, 'sessions', '--C-Data-workspace--');
  fs.mkdirSync(project, { recursive: true });
  for (const id of ids) fs.mkdirSync(path.join(project, id), { recursive: true });
  // A foreign session must never be picked up.
  fs.mkdirSync(path.join(project, 'qq-dm-1429709395'), { recursive: true });
  return home;
}

test('only vc-* session directories are listed', () => {
  const home = homeWith(['vc-dm-1', 'vc-chan-1']);
  assert.deepEqual(listStoredSessions({ homeDir: home }).sort(), ['vc-chan-1', 'vc-dm-1']);
});
test('a namespaced instance lists only its own namespace', () => {
  const home = homeWith(['vc-dm-1', 'vc-alt-dm-2']);
  assert.deepEqual(listStoredSessions({ homeDir: home, namespace: 'alt' }), ['vc-alt-dm-2']);
  // The default instance sees the plain rooms, and must not claim the namespaced ones.
  assert.deepEqual(listStoredSessions({ homeDir: home, namespace: '' }), ['vc-dm-1']);
});

test('a missing sessions root is not an error', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-ws-empty-'));
  assert.deepEqual(listStoredSessions({ homeDir: home }), []);
});

test('attach creates the workspace for the cwd and attaches the session', async () => {
  const calls = [];
  const registry = {
    create: async cwd => {
      calls.push(['create', cwd]);
      return { attachSession: async id => { calls.push(['attach', id]); } };
    },
  };
  const result = await attachToWorkspace({ registry, cwd: 'C:/ws', sessionId: 'vc-dm-1' });
  assert.deepEqual(result, { attached: true, reason: 'ok' });
  assert.deepEqual(calls, [['create', 'C:/ws'], ['attach', 'vc-dm-1']]);
});

test('a realpath mismatch is reported, not thrown (the message path must survive)', async () => {
  const lines = [];
  const registry = { create: async () => ({ attachSession: async () => { throw new Error("cannot attach session 'vc-dm-1' to workspace 'C:/ws': its cwd resolves to 'C:/other'"); } }) };
  const result = await attachToWorkspace({ registry, cwd: 'C:/ws', sessionId: 'vc-dm-1', log: line => lines.push(line) });
  assert.equal(result.attached, false);
  assert.match(result.reason, /its cwd resolves to/);
  assert.ok(lines.some(line => line.includes('挂工作区失败')));
});

test('already exists counts as attached', async () => {
  const registry = { create: async () => ({ attachSession: async () => { throw new Error('already exists'); } }) };
  assert.deepEqual(await attachToWorkspace({ registry, cwd: 'C:/ws', sessionId: 'vc-dm-1' }), { attached: true, reason: 'already' });
});

test('a profile without workspaceRegistry is a no-op, not a failure', async () => {
  assert.deepEqual(await attachToWorkspace({ registry: null, cwd: 'C:/ws', sessionId: 'vc-dm-1' }), { attached: false, reason: 'no-registry' });
});
