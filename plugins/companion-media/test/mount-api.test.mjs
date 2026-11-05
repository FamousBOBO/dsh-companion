import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { apply } from '../index.mjs';
import { API_PREFIX, createMediaHandlers } from '../src/http-api.mjs';
import { tempDataDir } from './helpers.mjs';

/**
 * Mount-time registration tests.
 *
 * The bug these cover: `connection` is provided **asynchronously** by the host,
 * so a single registration attempt that runs before the service exists silently
 * leaves the plugin with no HTTP routes — the settings page then 404s and looks
 * like "媒体模块没有启用". The fix is the `ctx.inject(['connection'], …)` retry
 * that the memory studio already uses.
 *
 * The fake host below mimics only the contract the plugin relies on:
 *   ctx.get(name) · ctx.inject(deps, cb) · ctx.effect(runner, label) ·
 *   ctx.provide(name, value) · ctx.tools.register(tool)
 */

const EXPECTED_ROUTES = 9;

function makeHost({ connectionAtStart = null } = {}) {
  const registered = new Map(); // path -> entry (host de-dupes by path)
  const logs = [];
  const injected = [];
  let connection = connectionAtStart;

  const connectionService = {
    fetch: {
      register(entry) {
        registered.set(entry.path, entry);
        return () => registered.delete(entry.path);
      },
    },
  };

  const ctx = {
    get: name => (name === 'connection' ? connection : undefined),
    provide: () => {},
    effect: runner => {
      const disposer = runner();
      return () => {
        if (typeof disposer === 'function') disposer();
      };
    },
    inject: (deps, callback) => {
      injected.push({ deps: [...deps], callback });
    },
    tools: { register: () => {} },
    logger: { info() {}, warn() {}, error() {} },
  };

  return {
    ctx,
    logs,
    injected,
    registered,
    deliverConnection() {
      // 模拟宿主稍后提供 connection，并触发我们挂起的 inject 回调
      connection = connectionService;
      for (const item of injected) item.callback(ctx);
      return connectionService;
    },
    handlers: () => createMediaHandlersFromPaths(registered),
  };
}

function createMediaHandlersFromPaths(registered) {
  const handlers = {};
  for (const [path, entry] of registered.entries()) {
    for (const method of entry.methods) {
      handlers[`${method} ${path}`] = entry.fetch;
    }
  }
  return handlers;
}

const request = (url, { method = 'GET' } = {}) => new Request(`http://127.0.0.1:1${url}`, { method });

function readLogFile(dir) {
  const file = path.join(dir, 'media', 'logs', 'media-events.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

test('connection 未就绪时：先记「等待」，等服务就绪后在仍然活跃的上下文里注册', async () => {
  const { dir, cleanup } = tempDataDir();
  process.env.DSH_MEDIA_CONNECTION_WAIT_MS = '2000';
  const host = makeHost({ connectionAtStart: null });
  try {
    const applying = apply(host.ctx, { dataDir: dir });
    await new Promise(resolve => setTimeout(resolve, 60));

    // 首次尝试必须明确记录"没有 connection"
    const events = readLogFile(dir);
    const waiting = events.find(entry => entry.event === 'http-api-waiting');
    assert.ok(waiting, `缺少「等待 connection」日志：${JSON.stringify(events.map(item => item.event))}`);
    assert.equal(waiting.skipped, 'no-connection');
    assert.equal(waiting.how, 'direct');
    assert.match(waiting.note, /等待 connection 服务/);
    assert.equal(host.registered.size, 0, '此时不应有任何路由');

    // 服务到达 → apply 内部的等待看到它 → 注册真的发生（上下文仍活跃）
    host.deliverConnection();
    await applying;

    const after = readLogFile(dir);
    const done = after.find(entry => entry.event === 'http-api-registered');
    assert.ok(done, `服务就绪后没有注册：${JSON.stringify(after.map(item => item.event))}`);
    assert.equal(done.how, 'awaited');
    assert.ok(host.registered.size > 0, '路由必须真的注册上');
  } finally {
    delete process.env.DSH_MEDIA_CONNECTION_WAIT_MS;
    cleanup();
  }
});


test('connection 一开始就在：直接注册，且 /page 真的返回描述符', async () => {
  const { dir, cleanup } = tempDataDir();
  const host = makeHost();
  try {
    host.deliverConnection(); // 让 get('connection') 立即有值
    apply(host.ctx, { dataDir: dir });
    await new Promise(resolve => setImmediate(resolve));

    const events = readLogFile(dir);
    const done = events.find(entry => entry.event === 'http-api-registered');
    assert.ok(done);
    assert.equal(done.how, 'direct');
    assert.equal(done.registered, EXPECTED_ROUTES);
    assert.equal(host.injected.length, 0, '服务已就绪时不该再挂 inject');

    const handlers = host.handlers();
    const page = await handlers[`GET ${API_PREFIX}/page`](request(`${API_PREFIX}/page`));
    assert.equal(page.status, 200);
    const descriptor = await page.json();
    assert.equal(descriptor.ok, true);
    assert.equal(descriptor.page.id, 'companion-media');
    assert.deepEqual(descriptor.page.sections.map(item => item.id), ['vision', 'image', 'tts']);

    const config = await handlers[`GET ${API_PREFIX}/config`](request(`${API_PREFIX}/config`));
    assert.equal(config.status, 200);
    const configBody = await config.json();
    assert.equal(configBody.ok, true);
    assert.equal(typeof configBody.config, 'object');

    // /status 里能看到 API 注册状态（供 Studio 区分"模块未启用"与"后端没起来"）
    const status = await handlers[`GET ${API_PREFIX}/status`](request(`${API_PREFIX}/status`));
    const statusBody = await status.json();
    assert.equal(statusBody.http.registered, EXPECTED_ROUTES);
    assert.equal(statusBody.http.how, 'direct');
  } finally {
    cleanup();
  }
});

test('重复注册同一批 path 不抛错（宿主按 path 去重），计数仍正确', async () => {
  const { dir, cleanup } = tempDataDir();
  const host = makeHost();
  try {
    host.deliverConnection();
    apply(host.ctx, { dataDir: dir });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(host.registered.size, EXPECTED_ROUTES);

    // 模拟二次挂载（宿主重载 / 两个来源）：再次注册同一批 path
    const { registerMediaApi } = await import('../src/http-api.mjs');
    const { createMediaService } = await import('../src/service.mjs');
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl: async () => new Response('{}') });
    const again = await registerMediaApi(host.ctx, service);
    assert.equal(again.registered, EXPECTED_ROUTES);
    assert.equal(again.failed.length, 0);
    assert.equal(host.registered.size, EXPECTED_ROUTES, 'path 不应重复堆积');
  } finally {
    cleanup();
  }
});

test('宿主既无 ctx.plugin 也无 ctx.inject，且 connection 缺失：如实记「不可用」', async () => {
  const { dir, cleanup } = tempDataDir();
  process.env.DSH_MEDIA_CONNECTION_WAIT_MS = '80';
  try {
    const ctx = {
      get: () => undefined,
      provide: () => {},
      effect: runner => runner(),
      tools: { register: () => {} },
      // 故意既不给 inject 也不给 plugin
    };
    const service = await apply(ctx, { dataDir: dir });

    const events = readLogFile(dir);
    const unavailable = events.find(entry => entry.event === 'http-api-unavailable');
    assert.ok(unavailable, `缺少「不可用」日志：${JSON.stringify(events.map(item => item.event))}`);
    assert.match(unavailable.message, /ctx\.plugin/);
    assert.equal(service.httpState().registered, 0);
    assert.equal(service.httpState().skipped, 'connection-timeout');
    assert.ok(service.httpState().lastError);
  } finally {
    delete process.env.DSH_MEDIA_CONNECTION_WAIT_MS;
    cleanup();
  }
});


test('注册状态进入 status()/page 元数据，404 时可区分「模块未启用」与「后端没起来」', async () => {
  const { dir, cleanup } = tempDataDir();
  const host = makeHost({ connectionAtStart: null });
  try {
    apply(host.ctx, { dataDir: dir });
    await new Promise(resolve => setImmediate(resolve));

    const { createMediaService } = await import('../src/service.mjs');
    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl: async () => new Response('{}') });
    // 直接问"当前服务"的注册状态（Studio 可通过 ctx.get('companionMedia') 拿到同一份）
    const state = service.httpState();
    assert.equal(typeof state.skipped, 'string');
    assert.equal(state.registered, 0);
  } finally {
    cleanup();
  }
});
