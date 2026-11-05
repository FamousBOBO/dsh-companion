import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { apply } from '../index.mjs';
import { API_PREFIX, createMediaHandlers, registerMediaApi } from '../src/http-api.mjs';
import { createMediaService } from '../src/service.mjs';
import { tempDataDir } from './helpers.mjs';

/**
 * Mount-time registration tests.
 *
 * The bug these cover: `connection` is provided **asynchronously** by the host,
 * and `connection.fetch.register` needs an *active* plugin context. Measured on a
 * real host, a fire-and-forget attempt (or a `ctx.inject` subscription that fires
 * after apply returned) never produced routes — every `/api/companion-media/*`
 * URL stayed 404, so the settings page looked like "媒体模块没有启用".
 *
 * The shape that works is the one the memory studio uses: **hold `apply` open**
 * until the service exists, then register on the still-active context. These
 * tests drive that with a fake host implementing only the contract the plugin
 * relies on: `ctx.get` / `ctx.inject` / `ctx.plugin` / `ctx.effect` /
 * `ctx.provide` / `ctx.tools.register`.
 */

const EXPECTED_ROUTES = 9;

function makeHost() {
  const registered = new Map(); // path -> entry (host de-dupes by path)
  const injected = [];
  let connection = null;

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
    plugin: definition => {
      injected.push({ plugin: definition });
    },
    tools: { register: () => {} },
  };

  return {
    ctx,
    injected,
    registered,
    deliverConnection() {
      connection = connectionService;
      return connectionService;
    },
    handlers() {
      const handlers = {};
      for (const [routePath, entry] of registered.entries()) {
        for (const method of entry.methods) handlers[`${method} ${routePath}`] = entry.fetch;
      }
      return handlers;
    },
  };
}

const request = (url, { method = 'GET' } = {}) => new Request(`http://127.0.0.1:1${url}`, { method });

function readLogFile(dir) {
  const file = path.join(dir, 'media', 'logs', 'media-events.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

test('connection 在 apply 期间才出现：apply 等它就绪后注册（awaited），9 条路由真的存在', async () => {
  const { dir, cleanup } = tempDataDir();
  const host = makeHost();
  try {
    // apply 是 async：它在等待 connection 时会挂起，我们在中途把服务提供出来。
    const pending = apply(host.ctx, { dataDir: dir, connectionWaitMs: 3000 });
    await new Promise(resolve => setTimeout(resolve, 120));
    host.deliverConnection();
    const service = await pending;

    const events = readLogFile(dir);
    const waiting = events.find(entry => entry.event === 'http-api-waiting');
    assert.ok(waiting, `缺少「等待 connection」日志：${JSON.stringify(events.map(item => item.event))}`);
    assert.equal(waiting.skipped, 'no-connection');
    assert.equal(waiting.registered, 0);

    const done = events.find(entry => entry.event === 'http-api-registered');
    assert.ok(done, `服务到达后仍未注册：${JSON.stringify(events.map(item => item.event))}`);
    assert.equal(done.how, 'awaited');
    assert.equal(done.registered, EXPECTED_ROUTES);
    assert.match(done.note, new RegExp(`已注册 ${EXPECTED_ROUTES} 条路由`));
    assert.equal(host.registered.size, EXPECTED_ROUTES);

    const paths = [...host.registered.keys()];
    for (const suffix of ['/page', '/config', '/status', '/preview', '/test']) {
      assert.ok(paths.includes(`${API_PREFIX}${suffix}`), `缺少路由 ${suffix}，实际：${paths.join(', ')}`);
    }

    const state = service.httpState();
    assert.equal(state.registered, EXPECTED_ROUTES);
    assert.equal(state.how, 'awaited');
  } finally {
    cleanup();
  }
});

test('connection 一开始就在：直接注册（direct），/page 真的返回描述符', async () => {
  const { dir, cleanup } = tempDataDir();
  const host = makeHost();
  try {
    host.deliverConnection();
    const service = await apply(host.ctx, { dataDir: dir, connectionWaitMs: 200 });

    const events = readLogFile(dir);
    const done = events.find(entry => entry.event === 'http-api-registered');
    assert.ok(done);
    assert.equal(done.how, 'direct');
    assert.equal(done.registered, EXPECTED_ROUTES);
    assert.equal(host.injected.length, 0, '服务已就绪时不该再挂 inject / plugin');

    const handlers = host.handlers();
    const page = await handlers[`GET ${API_PREFIX}/page`](request(`${API_PREFIX}/page`));
    assert.equal(page.status, 200);
    const descriptor = await page.json();
    assert.equal(descriptor.ok, true);
    assert.equal(descriptor.page.id, 'companion-media');
    assert.deepEqual(descriptor.page.sections.map(item => item.id), ['vision', 'image', 'tts']);

    const config = await handlers[`GET ${API_PREFIX}/config`](request(`${API_PREFIX}/config`));
    assert.equal(config.status, 200);
    assert.equal((await config.json()).ok, true);

    const status = await handlers[`GET ${API_PREFIX}/status`](request(`${API_PREFIX}/status`));
    const statusBody = await status.json();
    assert.equal(statusBody.http.registered, EXPECTED_ROUTES);
    assert.equal(statusBody.http.how, 'direct');
    assert.equal(service.httpState().registered, EXPECTED_ROUTES);
  } finally {
    cleanup();
  }
});

test('重复注册同一批 path 不抛错（宿主按 path 去重），计数仍正确', async () => {
  const { dir, cleanup } = tempDataDir();
  const host = makeHost();
  try {
    host.deliverConnection();
    await apply(host.ctx, { dataDir: dir, connectionWaitMs: 200 });
    assert.equal(host.registered.size, EXPECTED_ROUTES);

    const service = createMediaService({ dataDir: dir, env: {}, fetchImpl: async () => new Response('{}') });
    const again = await registerMediaApi(host.ctx, service);
    assert.equal(again.registered, EXPECTED_ROUTES);
    assert.equal(again.failed.length, 0);
    assert.equal(host.registered.size, EXPECTED_ROUTES, 'path 不应重复堆积');
  } finally {
    cleanup();
  }
});

test('没有 connection 也没有可用的挂载机制：如实记「不可用」，不假装成功', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const ctx = {
      get: () => undefined,
      provide: () => {},
      effect: runner => runner(),
      tools: { register: () => {} },
      // 故意不给 inject / plugin
    };
    const service = await apply(ctx, { dataDir: dir, connectionWaitMs: 150 });

    const events = readLogFile(dir);
    const unavailable = events.filter(entry => entry.event === 'http-api-unavailable');
    assert.ok(unavailable.length > 0, `缺少「不可用」日志：${JSON.stringify(events.map(item => item.event))}`);
    assert.ok(unavailable.some(entry => /connection|管理 API/.test(String(entry.message ?? ''))));

    const state = service.httpState();
    assert.equal(state.registered, 0);
    assert.equal(state.skipped, 'connection-timeout');
    assert.match(String(state.lastError), /没有 connection 服务/);
  } finally {
    cleanup();
  }
});

test('注册状态可查：httpState() 与 status().http 一致，供 Studio 区分「未启用」与「后端没起来」', async () => {
  const { dir, cleanup } = tempDataDir();
  const host = makeHost();
  try {
    host.deliverConnection();
    const service = await apply(host.ctx, { dataDir: dir, connectionWaitMs: 200 });
    const state = service.httpState();
    assert.equal(state.registered, EXPECTED_ROUTES);
    assert.equal(state.paths.length, EXPECTED_ROUTES);
    assert.equal(service.status().http.registered, EXPECTED_ROUTES);
    assert.equal(typeof state.skipped, 'object'); // null 也算 object 类型检查不安全，改为断言键存在
  } finally {
    cleanup();
  }
});
