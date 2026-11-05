// 用假 ctx 单测 Host 半：路由注册、图片/附件落盘、任务书、工作区挂载、回合结束后的重命名。
import { readFile, readdir } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const mod = await import('file:///D:/Bot/dsh-companion/plugins/dsh-paste-search/index.js');

const ROOT = path.join(os.tmpdir(), 'ps-selftest', 'paste-search-sessions');
const calls = { attach: [], rename: [], created: [], followup: [], select: [] };
const listeners = new Map();

const workspaceStub = {
  path: ROOT,
  attachSession: async (sessionId) => { calls.attach.push(sessionId); },
};

const fakeCtx = {
  logger: { info: (message) => console.log('[log]', message), warn: () => {} },
  effect(fn) {
    const dispose = fn();
    return typeof dispose === 'function' ? dispose : () => {};
  },
  on(name, handler) {
    listeners.set(name, handler);
    return () => listeners.delete(name);
  },
  inject() {},
  get(name) {
    if (name === 'connection') {
      return { fetch: { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path); } } };
    }
    if (name === 'workingDirectory') return { defaultDirectory: path.join(os.tmpdir(), 'ps-selftest') };
    if (name === 'workspaceRegistry') {
      return {
        list: () => [{ id: 'ws-1', path: ROOT, title: '搜图', sessionIds: [] }],
        resolveByPath: async () => workspaceStub,
        create: async () => workspaceStub,
        delete: async () => {},
      };
    }
    if (name === 'agents') {
      return {
        create: async (options) => {
          calls.created.push(options);
          const agent = {
            id: options.sessionId,
            session: { id: options.sessionId, append() {} },
            status: 'idle',
            followup: (message) => calls.followup.push(message),
            ctx: { tools: { restrict: () => {}, guard: () => {} } },
          };
          return { agent };
        },
        get: () => undefined,
      };
    }
    if (name === 'agentPresets') {
      return { list: async () => [{ id: 'standard' }, { id: 'companion' }], select: async (agent, id) => { calls.select.push(id); return id; } };
    }
    if (name === 'sessionTitle') {
      return { rename: (session, title) => calls.rename.push(title) };
    }
    if (name === 'agentDefaultModel') {
      return { currentSelection: () => ({ provider: 'p', model: 'm' }) };
    }
    return undefined;
  },
};

const routes = new Map();
mod.apply(fakeCtx);
console.log('routes:', [...routes.keys()]);

async function call(pathname, init) {
  const route = [...routes.values()].find((entry) => entry.path === pathname.split('?')[0]);
  const request = new Request(`http://127.0.0.1:1${pathname}`, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  const response = await route.fetch(request);
  return { status: response.status, json: await response.json() };
}

const image = await readFile('D:/Bot/dsh-companion/tmp/probe/sample.jpg');
const dataUrl = `data:image/jpeg;base64,${image.toString('base64')}`;

const start = await call('/api/dsh-paste-search/search', {
  method: 'POST',
  body: JSON.stringify({
    notes: '只查 P 站',
    attachments: [
      { name: '输入 图片.jpg', dataUrl },
      { name: '线索.txt', dataUrl: `data:text/plain;base64,${Buffer.from('角色 kouhai-chan', 'utf8').toString('base64')}` },
    ],
  }),
});
console.log('POST /search ->', JSON.stringify(start.json).slice(0, 260));

const { searchId, sessionId, dir } = start.json.search;
console.log('sessionId:', sessionId);
console.log('attach 调用:', calls.attach);
console.log('preset select:', calls.select);
console.log('followup 文本前 60:', String(calls.followup[0]?.content?.[0]?.text ?? '').slice(0, 60));

console.log('工作区文件:', (await readdir(dir)).join(','), '| meta:', (await readdir(path.join(dir, '.paste-search'))).join(','));
console.log('附件:', (await readdir(path.join(dir, 'files'))).join(','));

// 结果文件写好后模拟一次回合结束 → 应该触发重命名
fs.writeFileSync(path.join(dir, '.paste-search', 'result.json'), JSON.stringify({
  status: 'done',
  summary: 'pixiv 原作 #130756078，作者 うどん。',
  items: [{ source: 'SauceNAO · Yande.re', similarity: 93.11, target: 'https://yande.re/post/show/1272058' }],
}), 'utf8');

const handler = listeners.get('session/event');
console.log('有 session/event 监听:', typeof handler === 'function');
handler?.({ id: sessionId }, { type: 'turn/end' });
console.log('rename 调用:', calls.rename);

const status = await call(`/api/dsh-paste-search/search?id=${searchId}`);
console.log('GET /search ->', JSON.stringify({
  status: status.json.search.status,
  workspace: status.json.search.workspace,
  agentPreset: status.json.search.agentPreset,
  title: status.json.search.title,
  items: status.json.search.result?.items?.length,
}));
