import { test } from 'node:test';
import assert from 'node:assert/strict';

import { consumerCounts, goalCounts, beliefCounts, outboxCounts } from '../lib/diagnostics.mjs';

// 第五轮收尾 A4：旧 `diagnostics` 的计数曾经把**查询失败**变成 `0` —— 那正是四档契约禁止的谎
// （"健康且为空"）。现在：查询失败 → `null`；表为空 / 表还不存在 → `0`（"有多少行"的答案确实是 0）。

const boom = { get() { throw new Error('database is locked'); } };

test('查询失败 → null（不是健康的 0）', () => {
  const consumers = consumerCounts(boom, 'u:owner-1|p:bot|w:world:a');
  for (const [name, value] of Object.entries(consumers)) {
    assert.equal(value, null, `consumer count ${name} must be null when the query failed`);
  }
  const goals = goalCounts(boom, 'u:owner-1|p:bot|w:world:a');
  assert.equal(goals.active, null);
  assert.equal(goals.overdue, null);
  const beliefs = beliefCounts(boom, 'u:owner-1|p:bot|w:world:a');
  assert.equal(beliefs.current, null);
  const outbox = outboxCounts(boom, 'u:owner-1|p:bot|w:world:a');
  for (const value of Object.values(outbox)) {
    assert.equal(value, null, 'outbox counts are null when the query failed');
  }
});

test('"表不存在"仍是合法的 0（新库）', () => {
  const fresh = { get() { const error = new Error('no such table: goals'); error.code = 'ERR_SQLITE_ERROR'; throw error; } };
  assert.equal(goalCounts(fresh, 'u:owner-1|p:bot|w:world:a').active, 0);
  assert.equal(beliefCounts(fresh, 'u:owner-1|p:bot|w:world:a').current, 0);
});

test('有行时就是真实计数', () => {
  const db = { get: sql => ({ n: /beliefs/.test(sql) ? 3 : 7 }) };
  assert.equal(goalCounts(db, 'u:owner-1|p:bot|w:world:a').active, 7);
  assert.equal(beliefCounts(db, 'u:owner-1|p:bot|w:world:a').current, 3);
});
