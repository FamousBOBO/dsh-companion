import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MODULES, STAGES, STATUSES, EVENT_KEYS, COUNT_KEYS, REASON_CODES,
  sanitizeEvent, sanitizeCounts, serializeEvent, isSafeEvent,
  looksLikeContent, opaqueId,
} from '../lib/trace-schema.mjs';

// W2：结构化诊断事件 schema。这些用例同时是**脱敏扫描的样例集**——
// 计划 W2 要求「密钥、聊天正文、记忆正文和 reasoning 泄露扫描为 0」，
// 下面每一条"必须被拒"的输入就是扫描用的探针。

const FIXED_NOW = () => 1761600000000;

test('a well-formed event passes through with the fixed key order', () => {
  const { event, rejected } = sanitizeEvent({
    eventId: 'evt_1',
    traceId: 'tr_1',
    at: 1761600000000,
    module: 'memory',
    stage: 'retrieve',
    status: 'ok',
    reasonCode: 'low-coverage',
    durationMs: 42,
    counts: { candidates: 30, filtered: 27, injected: 3, characters: 180 },
    configRevision: 'v3',
  }, { now: FIXED_NOW });

  assert.deepEqual(rejected, []);
  assert.equal(event.module, 'memory');
  assert.equal(event.stage, 'retrieve');
  assert.equal(event.status, 'ok');
  assert.equal(event.reasonCode, 'low-coverage');
  assert.equal(event.at, '2025-10-27T21:20:00.000Z');
  assert.deepEqual(serializeEvent(event), {
    eventId: 'evt_1', traceId: 'tr_1', at: '2025-10-27T21:20:00.000Z',
    module: 'memory', stage: 'retrieve', status: 'ok', reasonCode: 'low-coverage',
    durationMs: 42,
    counts: { candidates: 30, filtered: 27, injected: 3, characters: 180 },
    configRevision: 'v3',
  });
  assert.equal(isSafeEvent(serializeEvent(event)), true);
});

test('unknown enum values degrade the event instead of being silently fixed', () => {
  const { event, rejected } = sanitizeEvent({
    module: 'nope', stage: 'sideways', status: 'great',
  }, { now: FIXED_NOW });
  assert.deepEqual(rejected.sort(), ['unknown-module', 'unknown-stage', 'unknown-status']);
  assert.equal(event.status, 'degraded');
  assert.equal(event.module, 'host');
  assert.equal(event.stage, 'finalize');
});

test('an unrecognized reason code is kept visible as unknown-reason', () => {
  const { event, rejected } = sanitizeEvent({
    module: 'prompt', stage: 'route', status: 'ok', reasonCode: 'brand-new-code',
  }, { now: FIXED_NOW });
  assert.deepEqual(rejected, ['unknown-reason']);
  assert.equal(event.reasonCode, 'unknown-reason');
  // 码本身是合法的短标识，所以状态没被再降一级（已是 degraded）。
  assert.equal(event.status, 'degraded');
  // 已知码不会被改写。
  const known = sanitizeEvent({ module: 'prompt', stage: 'route', status: 'ok', reasonCode: 'route-shadow' }, { now: FIXED_NOW });
  assert.deepEqual(known.rejected, []);
  assert.equal(known.event.reasonCode, 'route-shadow');
});

test('counts keep only whitelisted keys and drop non-integer values', () => {
  assert.deepEqual(sanitizeCounts({ candidates: 10, tokens: 5, secret: 'x' }), { candidates: 10, tokens: 5 });
  assert.deepEqual(sanitizeCounts({ candidates: -3, tokens: 2.7 }), { candidates: 0, tokens: 2 });
  // 非对象或空对象回 null（不猜形状）。
  assert.equal(sanitizeCounts(null), null);
  assert.equal(sanitizeCounts([1, 2]), null);
  assert.equal(sanitizeCounts({}), null);
  assert.equal(sanitizeCounts('nope'), null);
});

test('counts clamp to the documented bounds', () => {
  assert.equal(sanitizeCounts({ candidates: 9_999_999 }).candidates, 1_000_000);
  const { event } = sanitizeEvent({ module: 'memory', stage: 'retrieve', status: 'ok', durationMs: 9_999_999 }, { now: FIXED_NOW });
  assert.equal(event.durationMs, 3_600_000);
});

test('content-shaped payloads are rejected: credentials, chat text, memory text, reasoning', () => {
  const probes = [
    // 凭据
    { reasonCode: 'sk-abcdefgh12345678', why: 'API key 形状' },
    { reasonCode: 'Bearer eyJhbGciOiJIUzI1NiJ9', why: 'Bearer token' },
    { reasonCode: 'password=hunter2', why: 'password=…' },
    // 聊天 / 记忆正文（长中文句子）
    { reasonCode: '今天主人跟我说他很累，让我别再熬夜了，早点睡', why: '聊天正文' },
    // reasoning（长英文句子）
    { reasonCode: 'the model reasoned that the user prefers short replies so we should', why: 'reasoning 片段' },
  ];
  for (const probe of probes) {
    assert.equal(looksLikeContent(probe.reasonCode), true, `应判为正文：${probe.why}`);
    const { event, rejected } = sanitizeEvent({
      module: 'memory', stage: 'inject', status: 'ok', reasonCode: probe.reasonCode,
    }, { now: FIXED_NOW });
    assert.ok(rejected.length > 0, `必须被拒：${probe.why}`);
    assert.equal(event.reasonCode, 'event-rejected');
    assert.notEqual(event.status, 'ok');
    assert.equal(isSafeEvent(event), true, '拒绝后的事件必须是安全形状');
  }
});

test('ids and revisions must be opaque; junk is reported rather than trimmed', () => {
  assert.equal(opaqueId('tr_2026-11-16:001'), 'tr_2026-11-16:001');
  assert.equal(opaqueId('has space'), '');
  assert.equal(opaqueId('长中文标识'), '');
  const { rejected } = sanitizeEvent({
    module: 'host', stage: 'finalize', status: 'ok',
    traceId: 'sess_1429709395',
    configRevision: 'revision with spaces and 中文',
  }, { now: FIXED_NOW });
  assert.ok(rejected.includes('bad-revision'));
  const { event } = sanitizeEvent({ module: 'host', stage: 'finalize', status: 'ok', traceId: 'has space' }, { now: FIXED_NOW });
  assert.equal(event.traceId, '', '不合规的 traceId 被清空而不是截断成半截');
});

test('serializeEvent always emits the full schema key set', () => {
  const serialized = serializeEvent({ module: 'memory', stage: 'retrieve', status: 'ok' });
  assert.deepEqual(Object.keys(serialized), [...EVENT_KEYS]);
  for (const key of ['eventId', 'traceId', 'at', 'durationMs', 'counts', 'configRevision']) {
    assert.equal(Object.hasOwn(serialized, key), true);
  }
});

test('enums stay in sync with the docs (no accidental widening)', () => {
  assert.deepEqual([...MODULES], ['memory', 'prompt', 'router', 'tool', 'studio', 'host']);
  assert.deepEqual([...STAGES], ['retrieve', 'filter', 'inject', 'route', 'compose', 'tool-start', 'tool-end', 'finalize']);
  assert.deepEqual([...STATUSES], ['ok', 'empty', 'filtered', 'degraded', 'failed']);
  assert.equal(COUNT_KEYS.includes('dropped'), true, '依赖计数字段，流层要用');
  assert.ok(REASON_CODES.length >= 25);
  assert.equal(new Set(REASON_CODES).size, REASON_CODES.length, '理由码不许重复');
});

test('a rejected event never carries a content-shaped field after sanitization', () => {
  const { event } = sanitizeEvent({
    module: 'tool', stage: 'tool-end', status: 'failed',
    reasonCode: 'sk-live_abcdefgh12345678',
    counts: { toolsFailed: 1 },
  }, { now: FIXED_NOW });
  const scan = JSON.stringify(serializeEvent(event));
  assert.equal(looksLikeContent(scan), false, `事件正文仍在：${scan}`);
  assert.equal(event.counts.toolsFailed, 1, '拒绝事件保留可用的计数');
});
