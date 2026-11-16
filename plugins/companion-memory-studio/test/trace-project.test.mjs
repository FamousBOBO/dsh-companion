import test from 'node:test';
import assert from 'node:assert/strict';
import {
  recallRecordToEvents, recallRecordsToEvents, dominantReason, traceIdOf, isTraceId,
} from '../lib/trace-project.mjs';
import { EVENT_KEYS, isSafeEvent, looksLikeContent } from '../lib/trace-schema.mjs';

// W2 的记忆侧投影：把既有的 memory-recall.jsonl 记录映射成 10 字段事件。
// 关键约束：不泄漏 sessionId、不泄漏正文、不重组语义（status 要真的反映成没成）。

const RECORD = {
  at: '2026-11-16T09:00:00.000Z',
  sessionId: 'sess_very_secret_identifier',
  userId: 'u1',
  backend: 'sqlite',
  characters: 180,
  queryCharacters: 12,
  elapsedMs: 42,
  explain: {
    backend: 'sqlite',
    candidates: 30,
    afterFilter: 4,
    afterDedupe: 3,
    channels: { lexical: 3, semantic: 1 },
    filteredReasons: { 'low-coverage': 26, expired: 2 },
    coverage: { floor: 0.15, best: 0.31, kept: 2, total: 5, terms: 4 },
    elapsedMs: 40,
  },
};

test('a normal recall becomes a retrieve + inject pair under one traceId', () => {
  const { events, rejected } = recallRecordToEvents(RECORD, { configRevision: 'c1' });
  assert.deepEqual(rejected, []);
  assert.equal(events.length, 2);

  const [retrieve, inject] = events;
  assert.deepEqual(Object.keys(retrieve), [...EVENT_KEYS], 'retrieve 事件必须是完整 schema 形状');
  assert.equal(retrieve.stage, 'retrieve');
  assert.equal(retrieve.status, 'ok');
  assert.equal(retrieve.reasonCode, 'low-coverage', '取计数最多的那个理由');
  assert.equal(retrieve.counts.candidates, 30);
  assert.equal(retrieve.counts.filtered, 26);
  assert.equal(retrieve.module, 'memory');
  assert.equal(retrieve.configRevision, 'c1');

  assert.equal(inject.stage, 'inject');
  assert.equal(inject.status, 'ok');
  assert.equal(inject.counts.injected, 3);
  assert.equal(inject.counts.characters, 180);
  assert.equal(inject.traceId, retrieve.traceId, '同一轮必须同一个 traceId');
});

test('the trace id is opaque and stable, never the session id', () => {
  const { events } = recallRecordToEvents(RECORD);
  const traceId = events[0].traceId;
  assert.match(traceId, /^tr_[0-9a-z]{7,}$/);
  assert.equal(isTraceId(traceId), true);
  assert.equal(traceId.includes('sess'), false, '不能把 sessionId 原样当 traceId');
  // 同一条记录两次投影必须同一个 id（否则前端无法按 trace 聚合）。
  assert.equal(recallRecordToEvents(RECORD).events[0].traceId, traceId);
  // 不同会话必须不同 id。
  assert.notEqual(traceId, traceIdOf({ ...RECORD, sessionId: 'sess_other' }));
  // 空记录给空 id，不编造。
  assert.equal(traceIdOf({}), '');
  assert.equal(isTraceId('sess_123'), false, '不是 tr_ 形状的一律不算 traceId');
});

test('an empty injection is reported as empty, not as success', () => {
  const { events, rejected } = recallRecordToEvents({
    at: '2026-11-16T09:00:00.000Z', sessionId: 's', characters: 0, elapsedMs: 3,
    explain: { candidates: 0, afterFilter: 0, afterDedupe: 0, filteredReasons: {} },
  });
  assert.deepEqual(rejected, []);
  assert.equal(events[1].stage, 'inject');
  assert.equal(events[1].status, 'empty');
  assert.equal(events[1].reasonCode, 'empty-candidate-pool');
  assert.equal(events[1].counts.characters, 0);
  // 检索本身没失败（explain 存在），所以 retrieve 仍是 ok。
  assert.equal(events[0].status, 'ok');
});

test('a record without explain is a failed retrieval with a reason code', () => {
  const { events, rejected } = recallRecordToEvents({ at: '2026-11-16T09:00:00.000Z', sessionId: 's', characters: 0 });
  assert.equal(rejected.includes('missing-explain'), true);
  assert.equal(events[0].status, 'failed');
  assert.ok(['recall-error', 'no-database'].includes(events[0].reasonCode), events[0].reasonCode);
});

test('junk input never throws and never emits an unsafe event', () => {
  for (const input of [null, undefined, 'nope', 42, [], { explain: 'not-an-object' }]) {
    const projected = recallRecordToEvents(input);
    for (const event of projected.events) {
      assert.equal(isSafeEvent(event), true, `不安全事件：${JSON.stringify(projected)}`);
    }
    assert.equal(Array.isArray(projected.rejected), true);
  }
  // 完全没有 explain 且字符为 0 的输入，事件仍然是安全形状。
  const empty = recallRecordToEvents({});
  assert.equal(empty.events.length, 2);
  for (const event of empty.events) assert.equal(isSafeEvent(event), true);
});

test('filteredReasons dominance is deterministic and order-independent', () => {
  assert.equal(dominantReason({ a: 3, b: 3 }).reason, 'a', '并列时取字典序最小');
  assert.equal(dominantReason({ b: 5, a: 1 }).reason, 'b');
  assert.deepEqual(dominantReason({}).all, {});
  assert.equal(dominantReason({}).reason, '');
  assert.deepEqual(dominantReason({ a: 3, b: 3 }).all, { a: 3, b: 3 });
  // 非正数不计入（上游可能留 0）。
  assert.equal(dominantReason({ a: 0, b: 2 }).reason, 'b');
});

test('batch projection skips unprojectable records and counts them', () => {
  const { events, skipped } = recallRecordsToEvents([RECORD, null, { explain: null }]);
  // RECORD 正常 → 2 条；{explain:null} → 仍投影 2 条（标 failed）；null → 不产生事件。
  assert.equal(events.length, 4);
  assert.equal(skipped, 2, 'null 与缺 explain 的记录要被计入 skipped');
  for (const event of events) assert.equal(isSafeEvent(event), true);
});

test('no projection output carries chat or memory text', () => {
  const hostile = {
    ...RECORD,
    at: '2026-11-16T09:00:00.000Z',
    sessionId: 'sess_1',
    // 上游如果有天把正文塞进来（不该，但契约要防），投影必须把它挡在外面。
    query: '今天主人跟我说他很累，让我别再熬夜了',
    // 让正文形状的理由码**成为主导**（否则它只排在后面，根本不会被选中，测不到拒收路径）。
    explain: { ...RECORD.explain, filteredReasons: { 'low-coverage': 1, '今天主人跟我说他很累，让我别再熬夜了': 26 } },
  };
  const { events } = recallRecordToEvents(hostile);
  const serialized = JSON.stringify(events);
  assert.equal(serialized.includes('今天主人'), false);
  assert.equal(serialized.includes('别再熬夜'), false);
  for (const event of events) assert.equal(isSafeEvent(event), true);
  // 中文理由码被拒后收敛成 event-rejected，而不是原样留下。
  const rejected = events.find((event) => event.reasonCode === 'event-rejected');
  assert.ok(rejected, `应按内容拒收：${serialized}`);
});
