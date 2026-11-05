// 记忆时间信息：写入、渲染、提炼提示词的回归测试。
//
// 背景（2026-10-28）：新保存的记忆原本没有「发生时间」，召回与注入里看到的 at 是
// 原始 UTC ISO（`2026-10-28T06:38:22.480Z`）。这里锁住三件事：
//   1. 本地时间字符串能正确解析成 UTC ISO（Asia/Shanghai，+08:00）；
//   2. 展示层一律用 `YYYY-MM-DD HH:mm`（本地），不再漏原始 ISO；
//   3. `db.rememberFact` 不传时间时必须落成「现在」，不能留空。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openMemoryDatabase } from '../lib/db.mjs';
import { renderContext, renderRecallResult } from '../lib/render.mjs';
import { formatMoment, parseLocalMoment } from '../lib/text.mjs';

const USER_ID = 'user_local';
const PERSONA_ID = 'march7';

function harness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-memory-time-'));
  const file = path.join(dir, 'memory.db');
  const opened = [];
  t.after(() => {
    for (const db of opened) {
      try { db.close(); } catch { /* 已关闭 */ }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    async open() {
      const db = await openMemoryDatabase({ file });
      opened.push(db);
      return db;
    },
  };
}

function record(overrides = {}) {
  return {
    id: 'mem_time_1',
    kind: 'fact',
    scope: 'user_global',
    status: 'confirmed',
    mentionPolicy: 'direct',
    realityLevel: 'explicit_user_statement',
    sourceKind: 'desktop_fact',
    value: '用户喜欢乌龙茶',
    occurredAt: '2026-10-28T06:38:22.480Z',
    updatedAt: '2026-10-28T06:40:00.000Z',
    ...overrides,
  };
}

test('本地时间字符串按 +08:00 解析，纯日期不会被当成 UTC 零点', () => {
  assert.equal(parseLocalMoment('2026-10-28'), '2026-10-27T16:00:00.000Z');
  assert.equal(parseLocalMoment('2026-10-28 14:38'), '2026-10-28T06:38:00.000Z');
  assert.equal(parseLocalMoment('2026-10-28 14:38:59'), '2026-10-28T06:38:59.000Z');
  // 已经带 Z 的 ISO 原样保留，不再二次平移。
  assert.equal(parseLocalMoment('2026-10-28T06:38:22.480Z'), '2026-10-28T06:38:22.480Z');
  // 无时区的 ISO（旧 AstrBot 快照里常见）按项目时区 +08:00 解释，不随运行环境 TZ 漂移。
  assert.equal(parseLocalMoment('2026-10-27T10:00:00'), '2026-10-27T02:00:00.000Z');
  assert.equal(parseLocalMoment('2026-10-27T10:00:00.123456'), '2026-10-27T02:00:00.123Z');
  assert.equal(parseLocalMoment('2026-10-27T10:00:00+00:00'), '2026-10-27T10:00:00.000Z');
  // 旧快照里的「空格 + 小数秒」也要落在同一时区（评审 P1：之前会回落到运行环境 TZ）。
  assert.equal(parseLocalMoment('2026-10-27 10:00:00.123456'), '2026-10-27T02:00:00.123Z');
  assert.equal(parseLocalMoment('2026-10-27 10:00:00.5'), '2026-10-27T02:00:00.500Z');
  assert.equal(parseLocalMoment('2026-10-27 10:00:00'), '2026-10-27T02:00:00.000Z');
  assert.equal(parseLocalMoment('2026-10-27 10:00'), '2026-10-27T02:00:00.000Z');
  assert.equal(parseLocalMoment('2026-10-27T10:00'), '2026-10-27T02:00:00.000Z');
  // 越界字段绝不能静默进位（13 月/25 点/60 分/60 秒/2 月 30 日都应判非法）。
  for (const bad of ['2026-13-27 10:00', '2026-02-30 10:00', '2026-10-27 25:00',
    '2026-10-27 10:60', '2026-10-27 10:00:60', '0999-01-01 00:00',
    // 纯日期分支同样要校验：2 月 30 日、非闰年 2 月 29 日、4 位年下限。
    '2026-02-30', '2023-02-29', '0999-01-01']) {
    assert.equal(parseLocalMoment(bad), null, `越界时间必须返回 null：${bad}`);
  }
  // 闰年 2 月 29 日是合法日期。
  assert.equal(parseLocalMoment('2024-02-29'), '2024-02-28T16:00:00.000Z');
  assert.equal(parseLocalMoment(''), null);
  assert.equal(parseLocalMoment('不是时间'), null);
});

test('展示时间统一成 YYYY-MM-DD HH:mm（Asia/Shanghai）', () => {
  assert.equal(formatMoment('2026-10-28T06:38:22.480Z'), '2026-10-28 14:38');
  assert.equal(formatMoment('2026-10-27T16:00:00.000Z'), '2026-10-28 00:00');
  assert.equal(formatMoment('2026-10-28T06:38:22.480Z', { withTime: false }), '2026-10-28');
  assert.equal(formatMoment(''), '');
  assert.equal(formatMoment('nope'), '');
});

test('自动注入的时间是本地文本，隐藏行仍然只有占位符', () => {
  const text = renderContext({ entries: [record(), record({ id: 'mem_hidden', mentionPolicy: 'avoid_unless_asked' })], budget: 2400 });
  const lines = text.split('\n').slice(1).map(line => JSON.parse(line));
  const plain = lines.find(line => line.id === 'mem_time_1');
  assert.equal(plain.at, '2026-10-28 14:38');
  assert.equal(plain.value, '用户喜欢乌龙茶');
  const hidden = lines.find(line => line.id === 'mem_hidden');
  assert.equal(hidden.type, 'hidden');
  assert.equal(hidden.at, undefined, '隐藏行不该带时间，也不该带正文');
});

test('companion_recall 的时间同样是本地文本，字段集合保持不变', () => {
  const result = renderRecallResult({ entries: [{ record: record(), score: 0.9, section: 'stable' }], limit: 5 });
  assert.equal(result.entries.length, 1);
  const item = result.entries[0];
  assert.deepEqual(Object.keys(item).sort(), ['at', 'id', 'policy', 'reality', 'score', 'source', 'type', 'value']);
  assert.equal(item.at, '2026-10-28 14:38');
  assert.equal(item.value, '用户喜欢乌龙茶');
});

test('rememberFact 不传时间时落成「现在」，传了则原样保存', async t => {
  const db = await harness(t).open();

  const before = Date.now();
  const auto = db.rememberFact({
    userId: USER_ID, personaId: PERSONA_ID, worldId: '', scope: 'user_global', kind: 'fact',
    subject: 'user', key: 'tea', predicate: 'direct:tea', value: '用户喜欢乌龙茶',
  });
  const autoAt = Date.parse(auto.occurredAt);
  assert.ok(Number.isFinite(autoAt), 'occurredAt 必须存在');
  assert.ok(autoAt >= before - 1000 && autoAt <= Date.now() + 1000, 'occurredAt 应接近写入时刻');
  assert.equal(auto.validFrom, auto.occurredAt, 'valid_from 默认等于发生时间');
  assert.equal(formatMoment(auto.occurredAt).length, 16);

  const explicit = db.rememberFact({
    userId: USER_ID, personaId: PERSONA_ID, worldId: '', scope: 'user_global', kind: 'fact',
    subject: 'user', key: 'hike', predicate: 'direct:hike', value: '用户上周末去爬山了',
    occurredAt: '2026-10-25T02:00:00.000Z',
  });
  assert.equal(explicit.occurredAt, '2026-10-25T02:00:00.000Z');
  assert.equal(formatMoment(explicit.occurredAt), '2026-10-25 10:00');

  // 覆盖（同一 predicate 新说法）：新记录仍然带自己的发生时间。
  const corrected = db.rememberFact({
    userId: USER_ID, personaId: PERSONA_ID, worldId: '', scope: 'user_global', kind: 'fact',
    subject: 'user', key: 'tea', predicate: 'direct:tea', value: '用户改喝普洱了',
    occurredAt: '2026-10-27T12:00:00.000Z',
  });
  assert.equal(corrected.occurredAt, '2026-10-27T12:00:00.000Z');
  assert.equal(corrected.supersedesId, auto.id);
});

test('抽取提示词给每条消息标注发生时间，且不把时间塞进 value', () => {
  // 直接检查 buildExtractionPrompt 的拼装规则（不调用模型）。
  return import('../lib/extract.mjs').then(({ buildExtractionPrompt }) => {
    const prompt = buildExtractionPrompt({
      persona: { name: '三月七' },
      viewer: { userId: USER_ID, personaId: PERSONA_ID, worldId: '' },
      messages: [
        { sourceId: 'm1', role: 'user', content: '今天去爬山了', occurredAt: '2026-10-28T02:30:00.000Z' },
        { sourceId: 'm2', role: 'assistant', content: '真好', occurredAt: '2026-10-28T02:31:00.000Z' },
      ],
      config: {},
    });
    assert.ok(prompt.input.includes('[id=m1] user: 今天去爬山了  〔2026-10-28 10:30〕'));
    assert.ok(prompt.input.includes('[id=m2] assistant: 真好  〔2026-10-28 10:31〕'));
    assert.ok(prompt.input.includes('是这条消息的发生时间'));
  });
});
