// 重排序适配器 + 检索接入的单元测试（契约 §8.4）。
//
// 全部离线：fetch 一律注入假实现，db 用最小桩对象，不碰真实网络与数据库。

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RerankError, createReranker, parseRerankResponse, resolveRerankUrls,
} from '../lib/rerank.mjs';
import { recall } from '../lib/retrieve.mjs';

const VIEWER = { userId: 'u1', personaId: 'bot', worldId: '' };
const NOW = Date.parse('2026-03-01T00:00:00.000Z');

/** 最小 MemoryRecord，覆盖 recall 需要的字段。 */
function record(id, value, extra = {}) {
  return {
    id,
    userId: VIEWER.userId,
    personaId: VIEWER.personaId,
    worldId: '',
    scope: 'user_global',
    kind: 'fact',
    subject: 'user',
    predicate: '',
    value,
    content: '',
    status: 'confirmed',
    mentionPolicy: 'direct',
    realityLevel: 'imported_fact',
    confidence: 0.8,
    importance: 0.5,
    validFrom: null,
    validTo: null,
    occurredAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-02-01T00:00:00.000Z',
    revision: 1,
    supersedesId: '',
    tags: [],
    searchText: '用户 喜欢 茶',
    ...extra,
  };
}

/** recall 需要的最小 db 桩：命中列表固定，覆盖度探针也能回答。 */
function createDb(records, hits) {
  return {
    fullTextSearch: () => hits,
    countMemories: () => records.length,
    listMemories: () => records,
    getMemory: id => records.find(item => item.id === id) ?? null,
    getEmbeddings: () => [],
  };
}

const BASE_CONFIG = Object.freeze({
  candidates: 10,
  topK: 5,
  rrfK: 60,
  mmrLambda: 1,
  coverageFloor: 0.15,
  minScore: 0,
  semanticEnabled: false,
});

function rerankConfig(blend = 0.7) {
  return { enabled: true, provider: 'remote', baseUrl: 'https://api.test', model: 'rerank-model', timeoutMs: 1000, topN: 0, blend };
}

function okResponse(payload) {
  return { ok: true, status: 200, json: async () => payload };
}

// ---------------------------------------------------------------------------
// 端点解析
// ---------------------------------------------------------------------------

test('resolveRerankUrls 覆盖完整地址、版本根与裸根三种形态', () => {
  assert.deepEqual(resolveRerankUrls('https://api.test/v1/rerank'), ['https://api.test/v1/rerank']);
  assert.deepEqual(resolveRerankUrls('https://api.test/v1'), [
    'https://api.test/v1/rerank',
    'https://api.test/rerank',
  ]);
  assert.deepEqual(resolveRerankUrls('https://api.test/'), [
    'https://api.test/v1/rerank',
    'https://api.test/rerank',
  ]);
  assert.deepEqual(resolveRerankUrls(''), []);
  assert.deepEqual(resolveRerankUrls(null), []);
});

// ---------------------------------------------------------------------------
// 响应解析
// ---------------------------------------------------------------------------

test('parseRerankResponse 兼容 results / data / output.results 三种形状', () => {
  const first = parseRerankResponse({ results: [{ index: 0, relevance_score: 0.2 }, { index: 2, relevance_score: 0.9 }] });
  assert.deepEqual([...first.entries()], [[0, 0.2], [2, 0.9]]);

  const second = parseRerankResponse({ data: [{ index: 1, score: 0.7 }] });
  assert.deepEqual([...second.entries()], [[1, 0.7]]);

  const third = parseRerankResponse({ output: { results: [{ index: 0, relevance_score: 0.4 }, { index: 1, score: 0.6 }] } });
  assert.deepEqual([...third.entries()], [[0, 0.4], [1, 0.6]]);

  assert.throws(() => parseRerankResponse({ nope: true }), error => error instanceof RerankError && error.code === 'rerank-bad-shape');
  assert.throws(() => parseRerankResponse({ results: [] }), error => error instanceof RerankError && error.code === 'rerank-bad-shape');
  assert.throws(() => parseRerankResponse(null), error => error instanceof RerankError && error.code === 'rerank-bad-shape');
});

// ---------------------------------------------------------------------------
// 请求构造 / 认证 / topN / 延迟
// ---------------------------------------------------------------------------

test('rerank 发送最小请求：Bearer、documents、top_n 与延迟', async () => {
  const calls = [];
  let tick = 0;
  const reranker = createReranker({
    settings: {
      enabled: true, provider: 'remote', baseUrl: 'https://api.test/v1',
      model: 'rerank-model', apiKey: 'sk-test-12345678', timeoutMs: 1000, topN: 2, blend: 0.7,
    },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return okResponse({
        model: 'rerank-model-v2',
        results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.2 }],
      });
    },
    now: () => { tick += 5; return tick; },
  });

  assert.equal(reranker.enabled(), true);
  const result = await reranker.rerank({ query: '喝茶', candidates: ['用户喜欢乌龙茶', '用户喜欢黑咖啡', '用户喜欢白茶'] });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.test/v1/rerank');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk-test-12345678');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'rerank-model');
  assert.equal(body.query, '喝茶');
  assert.deepEqual(body.documents, ['用户喜欢乌龙茶', '用户喜欢黑咖啡']);
  assert.equal(body.top_n, 2);
  assert.equal(result.scores.get(0), 0.2);
  assert.equal(result.scores.get(1), 0.9);
  assert.equal(result.model, 'rerank-model-v2');
  assert.ok(result.latencyMs > 0);
});

test('rerank 在 404 时换一种端点拼法重试一次', async () => {
  const urls = [];
  const reranker = createReranker({
    settings: {
      enabled: true, provider: 'remote', baseUrl: 'https://api.test',
      model: 'm', apiKey: 'sk-test-12345678', timeoutMs: 1000, topN: 0, blend: 0.7,
    },
    fetchImpl: async (url) => {
      urls.push(url);
      if (url.endsWith('/v1/rerank')) return { ok: false, status: 404, json: async () => ({}) };
      return okResponse({ results: [{ index: 0, relevance_score: 0.5 }] });
    },
  });
  const result = await reranker.rerank({ query: 'q', candidates: ['a', 'b'] });
  assert.deepEqual(urls, ['https://api.test/v1/rerank', 'https://api.test/rerank']);
  assert.equal(result.scores.get(0), 0.5);
});

// ---------------------------------------------------------------------------
// 失败码
// ---------------------------------------------------------------------------

test('rerank 把 401 / 超时 / 无 key / 坏形状映射成固定 code', async () => {
  const base = {
    enabled: true, provider: 'remote', baseUrl: 'https://api.test/v1', model: 'm', timeoutMs: 500, topN: 0, blend: 0.7,
  };

  const unauthorized = createReranker({
    settings: { ...base, apiKey: 'sk-test-12345678' },
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }),
  });
  await assert.rejects(unauthorized.rerank({ query: 'q', candidates: ['a'] }), error => error.code === 'rerank-http-401');

  const badShape = createReranker({
    settings: { ...base, apiKey: 'sk-test-12345678' },
    fetchImpl: async () => okResponse({ unexpected: true }),
  });
  await assert.rejects(badShape.rerank({ query: 'q', candidates: ['a'] }), error => error.code === 'rerank-bad-shape');

  const noKey = createReranker({
    settings: { ...base, apiKey: '', apiKeyEnv: 'STUDIO_TEST_NO_SUCH_KEY' },
    fetchImpl: async () => { throw new Error('must not be called'); },
  });
  await assert.rejects(noKey.rerank({ query: 'q', candidates: ['a'] }), error => error.code === 'rerank-no-key');

  const timedOut = createReranker({
    settings: { ...base, apiKey: 'sk-test-12345678' },
    fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    }),
  });
  await assert.rejects(timedOut.rerank({ query: 'q', candidates: ['a'] }), error => error.code === 'rerank-timeout');
});

// ---------------------------------------------------------------------------
// 检索接入：混合、单调性、fail-open、跳过条件
// ---------------------------------------------------------------------------

function recallInput(records, hits, config) {
  return {
    db: createDb(records, hits),
    viewer: VIEWER,
    query: '茶',
    config: { ...BASE_CONFIG, rerank: config },
    now: NOW,
  };
}

test('blend 混合：rerank 分数高者排在前面，blend=0 时保持融合顺序', async () => {
  const records = [record('m1', '用户喜欢乌龙茶'), record('m2', '用户喜欢黑咖啡'), record('m3', '用户喜欢白茶')];
  const hits = [{ id: 'm1', score: 3 }, { id: 'm2', score: 2 }, { id: 'm3', score: 1 }];
  const reranker = {
    enabled: () => true,
    rerank: async ({ query, candidates }) => {
      assert.equal(query, '茶');
      assert.equal(candidates.length, 3);
      return { scores: new Map([[0, 0.05], [1, 0.5], [2, 0.95]]), model: 'fake', latencyMs: 7 };
    },
  };

  const blended = await recall({ ...recallInput(records, hits, rerankConfig(0.9)), reranker });
  assert.deepEqual(blended.entries.map(entry => entry.record.id), ['m3', 'm2', 'm1']);
  assert.equal(blended.explain.rerank.applied, true);
  assert.equal(blended.explain.rerank.model, 'fake');
  assert.equal(blended.explain.rerank.candidates, 3);
  assert.equal(blended.explain.filteredReasons['rerank-unavailable'], undefined);

  const pureFusion = await recall({ ...recallInput(records, hits, rerankConfig(0)), reranker });
  assert.deepEqual(pureFusion.entries.map(entry => entry.record.id), ['m1', 'm2', 'm3']);
});

test('远端失败 fail-open：保持融合顺序并记 rerank-unavailable', async () => {
  const records = [record('m1', '用户喜欢乌龙茶'), record('m2', '用户喜欢黑咖啡'), record('m3', '用户喜欢白茶')];
  const hits = [{ id: 'm1', score: 3 }, { id: 'm2', score: 2 }, { id: 'm3', score: 1 }];

  const baseline = await recall(recallInput(records, hits, null));
  const logs = [];
  const failing = {
    enabled: () => true,
    rerank: async () => { throw new RerankError('rerank-http-401'); },
  };
  const result = await recall({ ...recallInput(records, hits, rerankConfig(0.7)), reranker: failing, log: entry => logs.push(entry) });

  assert.deepEqual(
    result.entries.map(entry => entry.record.id),
    baseline.entries.map(entry => entry.record.id),
  );
  assert.equal(result.explain.filteredReasons['rerank-unavailable'], 1);
  assert.equal(result.explain.rerank.applied, false);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].stage, 'recall');
  assert.equal(logs[0].code, 'rerank:rerank-http-401');
});

test('候选 ≤1 或查询为空时跳过重排序', async () => {
  let calls = 0;
  const reranker = { enabled: () => true, rerank: async () => { calls += 1; return { scores: new Map([[0, 1]]), model: 'x', latencyMs: 1 }; } };

  const single = [record('m1', '用户喜欢乌龙茶')];
  const singleResult = await recall({ ...recallInput(single, [{ id: 'm1', score: 1 }], rerankConfig(0.7)), reranker });
  assert.equal(calls, 0);
  assert.equal(singleResult.explain.rerank, undefined);

  const records = [record('m1', '用户喜欢乌龙茶'), record('m2', '用户喜欢黑咖啡')];
  const hits = [{ id: 'm1', score: 2 }, { id: 'm2', score: 1 }];
  const emptyQuery = await recall({
    db: createDb(records, hits),
    viewer: VIEWER,
    query: '',
    config: { ...BASE_CONFIG, rerank: rerankConfig(0.7) },
    reranker,
    now: NOW,
  });
  assert.equal(calls, 0);
  assert.ok(emptyQuery.entries.length >= 1);
});

test('未启用重排序时 explain 不含 rerank 字段', async () => {
  const records = [record('m1', '用户喜欢乌龙茶'), record('m2', '用户喜欢黑咖啡')];
  const hits = [{ id: 'm1', score: 2 }, { id: 'm2', score: 1 }];
  const result = await recall(recallInput(records, hits, null));
  assert.equal(result.explain.rerank, undefined);
  assert.equal(result.explain.filteredReasons['rerank-unavailable'], undefined);
});
