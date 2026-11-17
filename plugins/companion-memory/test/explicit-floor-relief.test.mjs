import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openMemoryDatabase } from '../lib/db.mjs';
import { createEmbeddingProvider, hashEmbedding } from '../lib/embed.mjs';
import { recall, DEFAULT_COVERAGE_FLOOR } from '../lib/retrieve.mjs';

// P2-3 回归：`purpose:'explicit'` 必须真的影响检索，而不只是影响渲染。
//
// 缺陷：`purpose` 只被写进 `explain`/`gates` 的展示字段，`minScore`/`coverageFloor`/语义门限
// 一处都没读它。于是"用户自己开口问"和"agent 自动注入"用的是同一套严格门槛，
// 只是拿到结果之后渲染得宽松一点 —— 参数看起来像旋钮，实际没有消费者。
//
// 修法：显式查询把那道**词法覆盖率**门槛下调一次（固定倍数、有硬下限），
// 自动注入保持不变。这组用例钉三件事：
//   1. 显式查询的门槛确实更低，且自动注入的门槛没动；
//   2. 下调是有界的（不会变成"库里有什么就给什么"）；
//   3. 每一次下调都在 `filteredReasons` 里留下 `explicit-floor-relief`。

const NOW = Date.parse('2026-03-07T12:00:00.000Z');
const VIEWER = Object.freeze({ userId: 'user_floor', personaId: 'bot', worldId: '' });
const SESSION = 's-floor-1';
const CONFIG = Object.freeze({
  candidates: 32,
  topK: 8,
  rrfK: 60,
  mmrLambda: 0.72,
  semanticEnabled: true,
  // The default floor (0.15) is the interesting one: relief lands on 0.075.
});

async function harness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-floor-'));
  const db = await openMemoryDatabase({ file: path.join(dir, 'memory.db') });
  const embedder = await createEmbeddingProvider({ provider: 'local', dimensions: 256 }, { now: () => NOW });
  t.after(() => {
    try { db.close(); } catch { /* 已关闭 */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { db, embedder };
}

let seq = 0;
function seed(db, embedder, overrides = {}) {
  seq += 1;
  const record = db.insertMemory({
    scope: 'user_global',
    kind: 'fact',
    subject: 'user',
    predicate: `floor:${seq}`,
    value: `第 ${seq} 条合成记忆`,
    userId: VIEWER.userId,
    personaId: VIEWER.personaId,
    worldId: '',
    confidence: 0.9,
    importance: 0.6,
    mentionPolicy: 'direct',
    realityLevel: 'explicit_user_statement',
    sourceKind: 'desktop_fact',
    occurredAt: new Date(NOW - 3_600_000).toISOString(),
    ...overrides,
  }).record;
  const vector = hashEmbedding(record.searchText || record.value, { dimensions: embedder.dimensions });
  db.putEmbedding(record.id, { provider: embedder.provider, model: embedder.model, dimensions: vector.length, vector });
  return record;
}

test('显式查询的词法门槛真的低于自动注入，且自动注入没有被放宽', async t => {
  const { db, embedder } = await harness(t);
  seed(db, embedder, { value: '用户住在杭州，喜欢喝乌龙茶' });

  const auto = await recall({
    db, embedder, viewer: VIEWER, query: '杭州的乌龙茶', config: CONFIG, now: NOW, sessionId: SESSION, purpose: 'auto',
  });
  const explicit = await recall({
    db, embedder, viewer: VIEWER, query: '杭州的乌龙茶', config: CONFIG, now: NOW, sessionId: SESSION, purpose: 'explicit',
  });

  assert.equal(auto.explain.coverage.floor, DEFAULT_COVERAGE_FLOOR, '自动注入用配置的门槛');
  assert.equal(explicit.explain.coverage.floor, DEFAULT_COVERAGE_FLOOR * 0.5, '显式查询下调一次');
  assert.equal(explicit.explain.coverage.floor < auto.explain.coverage.floor, true);

  // The relief is recorded, not silent.
  assert.equal((explicit.explain.filteredReasons ?? {}).hasOwnProperty('explicit-floor-relief'), true,
    JSON.stringify(explicit.explain.filteredReasons));
  assert.equal((auto.explain.filteredReasons ?? {}).hasOwnProperty('explicit-floor-relief'), false,
    '自动注入不该声称自己放宽了门槛');
});

test('相关的那条在两条路径里都被召回（门槛下调不改变已通过的行）', async t => {
  const { db, embedder } = await harness(t);
  const tea = seed(db, embedder, { kind: 'preference', value: '用户每天喝一杯乌龙茶', importance: 0.8 });
  const auto = await recall({
    db, embedder, viewer: VIEWER, query: '乌龙茶', config: CONFIG, now: NOW, sessionId: SESSION, purpose: 'auto',
  });
  const explicit = await recall({
    db, embedder, viewer: VIEWER, query: '乌龙茶', config: CONFIG, now: NOW, sessionId: SESSION, purpose: 'explicit',
  });
  assert.ok(auto.entries.some(entry => entry.record.id === tea.id), '单术语查询本来就过得了严门槛');
  assert.ok(explicit.entries.some(entry => entry.record.id === tea.id));
});

test('下调是有界的：无关内容在显式查询下也不会被塞进来', async t => {
  const { db, embedder } = await harness(t);
  for (let index = 0; index < 12; index += 1) {
    seed(db, embedder, {
      kind: 'summary',
      scope: 'user_persona',
      realityLevel: 'imported_summary',
      value: `第${index}次对话摘要：聊了日程安排和完全不同的生活琐事`,
      importance: 0.8,
    });
  }
  const explicit = await recall({
    db, embedder, viewer: VIEWER, query: '完全无关的量子力学问题', config: CONFIG, now: NOW, sessionId: SESSION, purpose: 'explicit',
  });
  assert.deepEqual(explicit.entries, [], '显式查询不是"库里有什么就给什么"');
  assert.equal(explicit.explain.coverage.best < explicit.explain.coverage.floor, true,
    `最佳覆盖度 ${explicit.explain.coverage.best} 必须仍低于（已下调的）门槛 ${explicit.explain.coverage.floor}`);
});

test('下调有硬下限：即便配置把 floor 放到最低，也不会掉到零', async t => {
  const { db, embedder } = await harness(t);
  seed(db, embedder, { value: '用户住在杭州' });
  const explicit = await recall({
    db, embedder, viewer: VIEWER, query: '杭州', config: { ...CONFIG, coverageFloor: 0.1 }, now: NOW, sessionId: SESSION, purpose: 'explicit',
  });
  assert.equal(explicit.explain.coverage.floor, 0.06, '0.1 × 0.5 = 0.05 → 被硬下限抬回 0.06');
  assert.equal(explicit.explain.coverage.floor > 0, true, '下限存在，不会掉到零');
});
