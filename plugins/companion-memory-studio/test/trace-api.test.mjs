import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { createMemoryEngine } from '../../companion-memory/index.mjs';
import { createStudioHandlers, API_PREFIX, ROUTES } from '../server.mjs';
import { createTraceWriter, traceFilePath } from '../lib/trace-store.mjs';
import { isSafeEvent } from '../lib/trace-schema.mjs';

// W2 路由：`GET /trace-events` 与 `GET /trace/stream`。
// 这两个都是只读诊断面，因此用例同时验三件事：能读、只读、不泄漏。

const USER_ID = 'u1';
const NOW = 1761600000000;
const state = { root: '', engine: null, handlers: null };

function writeMemoryConfig(root) {
  const dir = path.join(root, 'home/companion');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory.config.json'), JSON.stringify({
    schemaVersion: 1,
    backend: 'sqlite',
    database: 'home/memory/companion-memory.db',
  }, null, 2));
}

function seedEvents(root, count = 5) {
  // 路由端用的是真实时钟（traceFilePath 按当日命名），所以种子也必须落在当天。
  const writer = createTraceWriter({ root });
  const modules = ['memory', 'prompt', 'tool'];
  for (let index = 0; index < count; index += 1) {
    writer.write({
      eventId: `evt_${index}`,
      traceId: index < 3 ? 'tr_A' : 'tr_B',
      module: modules[index % modules.length],
      stage: 'retrieve',
      status: index === 4 ? 'failed' : 'ok',
      reasonCode: index === 4 ? 'tool-threw' : 'low-coverage',
      durationMs: index,
      counts: { candidates: index },
    });
  }
  writer.flush();
}

function call(path, { method = 'GET' } = {}) {
  // handler 键不带 query：路由表按路径注册，过滤条件在 URL 上。
  const pathname = path.split('?')[0];
  const handler = state.handlers[`${method} ${pathname}`];
  assert.ok(handler, `路由缺失：${method} ${pathname}`);
  return handler(new Request(`http://localhost${path}`, { method }));
}

before(async () => {
  state.root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-trace-'));
  writeMemoryConfig(state.root);
  const identity = {
    owner: () => ({ id: USER_ID, displayName: '测试', platform: 'desktop' }),
    resolve: () => ({ userId: USER_ID, displayName: '测试' }),
  };
  state.engine = createMemoryEngine({ root: state.root, identity, env: {} });
  await state.engine.initialize();
  assert.equal((await state.engine.internal()).backend, 'sqlite');
  state.handlers = createStudioHandlers({ engine: state.engine, identity, root: state.root });
  seedEvents(state.root, 5);
});

after(async () => {
  try { await state.engine?.close?.(); } catch { /* 引擎收尾失败不影响结论 */ }
  try { fs.rmSync(state.root, { recursive: true, force: true }); } catch { /* Windows 文件锁 */ }
});

test('both trace routes are registered as GET only', () => {
  for (const name of ['trace-events', 'trace-stream']) {
    assert.equal(ROUTES.some((route) => route.name === name && route.method === 'GET'), true, name);
    assert.equal(ROUTES.some((route) => route.name === name && route.method === 'POST'), false, `${name} 不该有 POST`);
  }
});

test('trace-events returns the seeded events with counts and no content', async () => {
  const response = await call(`${API_PREFIX}/trace-events`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.data.total, 5);
  assert.equal(body.data.events.length, 5);
  assert.deepEqual(body.data.source, [path.basename(traceFilePath(state.root))]);
  assert.equal(body.data.skipped, 0);
  // 每条事件都是 schema 白名单内的形状。
  for (const event of body.data.events) {
    assert.deepEqual(
      Object.keys(event).sort(),
      ['at', 'configRevision', 'counts', 'durationMs', 'eventId', 'module', 'reasonCode', 'stage', 'status', 'traceId'],
    );
  }
});

test('trace-events honors traceId / module / status / reasonCode filters', async () => {
  const cases = [
    ['?traceId=tr_A', 3],
    ['?module=prompt', 2],
    ['?status=failed', 1],
    ['?reasonCode=tool-threw', 1],
    ['?limit=2', 2], // limit 只裁剪 events，total 仍报全量（下面单独用例钉住）
  ];
  for (const [query, expected] of cases) {
    const body = await (await call(`${API_PREFIX}/trace-events${query}`)).json();
    assert.equal(body.ok, true, query);
    const count = query.startsWith('?limit') ? body.data.events.length : body.data.total;
    assert.equal(count, expected, `${query} → ${count}`);
  }
});

test('limit trims the page but total still reports every match', async () => {
  const body = await (await call(`${API_PREFIX}/trace-events?limit=2`)).json();
  assert.equal(body.data.events.length, 2);
  assert.equal(body.data.total, 5);
  // 取的是最新的两条。
  assert.deepEqual(body.data.events.map((event) => event.eventId), ['evt_3', 'evt_4']);
});

test('sinceId skips up to and including that event', async () => {
  // 语义是"这条**及之前**都不要"（增量续读）：evt_0..evt_4 传 evt_2 → 只剩 evt_3、evt_4。
  // 旧实现只跳过命中那一条，于是会回 evt_0、evt_1、evt_3、evt_4 —— 而这里原本的断言
  // （total === 4）正是把错误行为固化成了"通过"。
  const body = await (await call(`${API_PREFIX}/trace-events?sinceId=evt_2`)).json();
  assert.equal(body.data.total, 2, 'evt_2 之后只剩 2 条');
  assert.deepEqual(body.data.events.map((event) => event.eventId), ['evt_3', 'evt_4']);
});

test('trace/stream is an SSE response that emits ready and events', async () => {
  const response = await call(`${API_PREFIX}/trace/stream`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  assert.equal(response.headers.get('cache-control'), 'no-store');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const frames = [];
  const deadline = Date.now() + 2500;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        const name = part.match(/^event: (.+)$/m)?.[1];
        const data = part.match(/^data: (.+)$/m)?.[1];
        if (name && data) frames.push({ event: name, data: JSON.parse(data) });
      }
      if (frames.some((frame) => frame.event === 'trace' && frame.data.events?.length)) break;
    }
  } finally {
    try { await reader.cancel(); } catch { /* 已关 */ }
  }

  assert.equal(frames[0].event, 'ready', '第一个帧必须是 ready');
  const trace = frames.find((frame) => frame.event === 'trace');
  assert.ok(trace, `没有 trace 帧：${frames.map((frame) => frame.event).join(',')}`);
  assert.equal(trace.data.events.length, 5);
  assert.equal(typeof trace.data.drops.parsed, 'number');
});

test('an unbound viewer is denied on both trace routes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-trace-denied-'));
  try {
    const handlers = createStudioHandlers({
      engine: { internal: () => ({ viewer: () => null }) },
      root,
    });
    for (const route of ['trace-events', 'trace/stream']) {
      const response = await handlers[`GET ${API_PREFIX}/${route}`](
        new Request(`http://localhost${API_PREFIX}/${route}`, { method: 'GET' }),
      );
      const body = response.status === 200 && (response.headers.get('content-type') ?? '').includes('event-stream')
        ? null
        : await response.json();
      if (body) {
        assert.equal(body.ok, false, route);
        assert.equal(body.error.code, 'denied', route);
      } else {
        assert.equal(response.status >= 400, true, 'SSE 路由也必须拒绝未绑定 viewer');
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('trace-memory projects the existing recall log without a second write path', async () => {
  // 造一份与生产同形的 memory-recall.jsonl（键集与 data/logs 实测一致）。
  const file = path.join(state.root, 'logs', 'memory-recall.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const records = [
    {
      at: '2026-11-16T09:00:00.000Z', sessionId: 'sess_1', userId: USER_ID, backend: 'sqlite',
      characters: 200, queryCharacters: 10, elapsedMs: 40,
      explain: {
        backend: 'sqlite', candidates: 20, afterFilter: 5, afterDedupe: 4,
        channels: { lexical: 3, semantic: 1 },
        filteredReasons: { 'low-coverage': 15 },
        coverage: { floor: 0.15, best: 0.4, kept: 2, total: 3, terms: 4 },
        elapsedMs: 38, rerank: null,
      },
    },
    {
      at: '2026-11-16T09:01:00.000Z', sessionId: 'sess_2', userId: USER_ID, backend: 'sqlite',
      characters: 0, queryCharacters: 8, elapsedMs: 12,
      explain: {
        backend: 'sqlite', candidates: 0, afterFilter: 0, afterDedupe: 0,
        channels: { lexical: 0, semantic: 0 }, filteredReasons: {},
        coverage: { floor: 0.15, best: 0, kept: 0, total: 0, terms: 0 }, elapsedMs: 10, rerank: null,
      },
    },
  ];
  fs.writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');

  const body = await (await call(`${API_PREFIX}/trace-memory`)).json();
  assert.equal(body.ok, true);
  assert.equal(body.data.source, 'logs/memory-recall.jsonl');
  // 成功面必须与错误面同一个布尔（N12）：否则客户端只能靠 reason 猜是"空"还是"读失败"。
  assert.equal(body.data.readable, true, '成功面必须带 readable:true');
  assert.equal(body.data.records, 2);
  // 每条记录投影成 retrieve + inject，共 4 条事件。
  assert.equal(body.data.events.length, 4);
  for (const event of body.data.events) {
    assert.equal(isSafeEvent(event), true);
    assert.equal(event.module, 'memory');
  }
  // 空注入那一轮必须报 empty（不是 ok）。
  const empties = body.data.events.filter((event) => event.stage === 'inject' && event.status === 'empty');
  assert.equal(empties.length, 1);
  // 会话标识绝不能原样出现在事件里。
  const serialized = JSON.stringify(body.data.events);
  assert.equal(serialized.includes('sess_1'), false);
  assert.equal(serialized.includes('sess_2'), false);
  // 过滤条件同样生效。
  const filtered = await (await call(`${API_PREFIX}/trace-memory?status=empty`)).json();
  assert.equal(filtered.data.events.length, 1);
});

test('trace-memory reports readable:false instead of faking an empty log', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-trace-unreadable-'));
  try {
    // 把 logs/memory-recall.jsonl 做成目录：readFileSync 会抛 EISDIR。
    const file = path.join(root, 'logs', 'memory-recall.jsonl');
    fs.mkdirSync(file, { recursive: true });
    const handlers = createStudioHandlers({ engine: state.engine, root });
    const response = await handlers[`GET ${API_PREFIX}/trace-memory`](
      new Request(`http://localhost${API_PREFIX}/trace-memory`, { method: 'GET' }),
    );
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.data.readable, false);
    assert.equal(body.data.reason, 'read-failed');
    assert.equal(body.data.events.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
