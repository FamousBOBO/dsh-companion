import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openMemoryDatabase } from '../lib/db.mjs';
import { createEmbeddingProvider, hashEmbedding } from '../lib/embed.mjs';
import { recall } from '../lib/retrieve.mjs';

// P2-4 回归：`historyFallbackEnabled` 必须有一个真的消费者。
//
// 缺陷：这个开关从 `config.mjs` 一路传到 `buildQueryPlan()`，写进 `plan.historyFallback`，
// 然后……没有任何人读它。`retrieve.mjs` 只是把布尔值原样放进 `queryPlan` 的输出，
// 纯元记忆查询（"上次我说过什么"）的兜底路径根本不看它。关掉开关 = 什么都没发生，
// 这比"没有这个开关"更糟：配置里写着一条承诺，行为上不存在。
//
// 修法：没有话题时的兜底分支先读它。关掉 ⇒ 返回空结果 + 具名理由 `history-fallback-disabled`；
// 打开（默认）⇒ 行为与关掉前逐字相同。

const NOW = Date.parse('2026-03-07T12:00:00.000Z');
const VIEWER = Object.freeze({ userId: 'user_fallback', personaId: 'bot', worldId: '' });
const SESSION = 's-fallback-1';
const CONFIG = Object.freeze({ candidates: 32, topK: 8, rrfK: 60, mmrLambda: 0.72, semanticEnabled: true });

async function harness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-fallback-'));
  const db = await openMemoryDatabase({ file: path.join(dir, 'memory.db') });
  const embedder = await createEmbeddingProvider({ provider: 'local', dimensions: 256 }, { now: () => NOW });
  t.after(() => {
    try { db.close(); } catch { /* 已关闭 */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { db, embedder };
}

function seed(db, embedder, overrides = {}) {
  const record = db.insertMemory({
    scope: 'user_global',
    kind: 'preference',
    subject: 'user',
    predicate: 'fallback:1',
    value: '用户喜欢喝乌龙茶',
    userId: VIEWER.userId,
    personaId: VIEWER.personaId,
    worldId: '',
    confidence: 0.9,
    importance: 0.9,
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

test('默认（开关打开）：元记忆查询仍然走兜底，行为与改动前一致', async t => {
  const { db, embedder } = await harness(t);
  seed(db, embedder);
  const result = await recall({
    db, embedder, viewer: VIEWER, query: '上次我说过什么', config: CONFIG, now: NOW, sessionId: SESSION, purpose: 'auto',
  });
  assert.equal(result.queryPlan.source, 'explicit-history');
  assert.equal(result.queryPlan.historyFallback, true);
  assert.ok(result.entries.length >= 1, '兜底打开时不该静默全空');
});

test('开关关掉：元记忆查询返回空，并留下具名理由（不是"没有记忆"）', async t => {
  const { db, embedder } = await harness(t);
  seed(db, embedder);
  const result = await recall({
    db, embedder, viewer: VIEWER, query: '上次我说过什么',
    config: { ...CONFIG, historyFallbackEnabled: false }, now: NOW, sessionId: SESSION, purpose: 'auto',
  });
  assert.equal(result.queryPlan.source, 'explicit-history');
  assert.equal(result.queryPlan.historyFallback, false);
  assert.deepEqual(result.entries, [], '开关关掉就等于"这条部署不这样回答"');
  assert.equal((result.explain.filteredReasons ?? {}).hasOwnProperty('history-fallback-disabled'), true,
    JSON.stringify(result.explain.filteredReasons));
});

test('开关关掉不影响有话题的查询（不是把整个召回关掉）', async t => {
  const { db, embedder } = await harness(t);
  const tea = seed(db, embedder);
  const result = await recall({
    db, embedder, viewer: VIEWER, query: '乌龙茶',
    config: { ...CONFIG, historyFallbackEnabled: false }, now: NOW, sessionId: SESSION, purpose: 'auto',
  });
  assert.notEqual(result.queryPlan.source, 'explicit-history', '有话题就不走元记忆分支');
  assert.ok(result.entries.some(entry => entry.record.id === tea.id), '话题召回照常工作');
});
