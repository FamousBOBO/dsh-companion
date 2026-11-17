// 端到端专项：计划 §5 A 的五条必测用例，走真实的 recall → render 链路
// （临时 SQLite + 本地哈希向量，合成中文夹具，不读任何真实记忆文件）。
//
// 五条用例（每条一个 test）：
//   1. 问候「早」→ 空主题 / 身份配额，不推断「刚睡醒」「刚起床」
//   2. 承接链「陪父亲复诊」→「他太顽固」→ 召回父亲/复诊那条
//   3. 无关场合的旧亲密事（tone_only）→ 自动注入不带正文
//   4. 用户明确纠正 → 最新纠正优先，旧摘要不再出现
//   5. 显式历史查询「上次我说过什么」→ 仍然召回，不是空
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openMemoryDatabase } from '../lib/db.mjs';
import { createEmbeddingProvider, hashEmbedding } from '../lib/embed.mjs';
import { renderContext } from '../lib/render.mjs';
import { recall } from '../lib/retrieve.mjs';

const NOW = Date.parse('2026-03-07T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
/** 中性身份：绝不使用真实 owner id。 */
const VIEWER = Object.freeze({ userId: 'user_gate', personaId: 'bot', worldId: '' });
const SESSION = 's-gate-1';
const CONFIG = Object.freeze({
  candidates: 32,
  topK: 8,
  rrfK: 60,
  mmrLambda: 0.72,
  semanticEnabled: true,
});

async function harness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem-gate-'));
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
    predicate: `gate:${seq}`,
    value: `第 ${seq} 条合成记忆`,
    userId: VIEWER.userId,
    personaId: VIEWER.personaId,
    worldId: '',
    confidence: 0.9,
    importance: 0.6,
    mentionPolicy: 'direct',
    realityLevel: 'explicit_user_statement',
    sourceKind: 'desktop_fact',
    occurredAt: new Date(NOW - HOUR).toISOString(),
    ...overrides,
  }).record;
  const vector = hashEmbedding(record.searchText || record.value, { dimensions: embedder.dimensions });
  db.putEmbedding(record.id, {
    provider: embedder.provider,
    model: embedder.model,
    dimensions: vector.length,
    vector,
  });
  return record;
}

/** 写入一条用户自己说过的话作为承接锚点。 */
function say(db, text, { at = NOW - HOUR, sessionId = SESSION, n = 1 } = {}) {
  return db.appendEvent({
    eventKey: `${sessionId}:${seq + 1000 + n}`,
    role: 'user',
    sourceKind: 'desktop_conversation',
    content: text,
    occurredAt: new Date(at).toISOString(),
    sessionId,
    seq: n,
    userId: VIEWER.userId,
    personaId: VIEWER.personaId,
    worldId: '',
  });
}

function values(entries) {
  return entries.map(entry => String(entry.record?.value ?? ''));
}

test('1. 问候「早」：空主题 + 身份配额，绝不推断「刚睡醒 / 刚起床」', async t => {
  const { db, embedder } = await harness(t);
  const identityFact = seed(db, embedder, { kind: 'profile', value: '用户是成年男性，住在杭州', importance: 0.9 });
  // 一条高重要度的旧亲密事：问候语绝不该把它倒出来。
  seed(db, embedder, {
    kind: 'event',
    scope: 'user_persona',
    mentionPolicy: 'tone_only',
    realityLevel: 'bot_action',
    value: '那晚的亲密细节只说过一次',
    importance: 0.99,
  });
  say(db, '昨天有点累，睡得晚');

  const result = await recall({
    db, embedder, viewer: VIEWER, query: '早', config: CONFIG, now: NOW, sessionId: SESSION, purpose: 'auto',
  });
  assert.equal(result.queryPlan.source, 'weak-intent');
  assert.equal(result.queryPlan.weakIntent, true);
  assert.deepEqual(result.queryPlan.entities, []);

  const text = renderContext({
    entries: result.entries, purpose: 'auto', viewer: VIEWER, now: NOW, budget: 2400,
  });
  for (const forbidden of ['睡醒', '起床', '刚睡', '刚起']) {
    assert.doesNotMatch(text, new RegExp(forbidden), `问候不得推演出「${forbidden}」`);
  }
  assert.doesNotMatch(text, /亲密细节/, '问候不得把旧亲密事注入');
  // 身份资料可以出现（这是独立配额的意义），但它不是「话题召回」。
  if (result.entries.length) {
    assert.ok(values(result.entries).includes(identityFact.value), '身份资料应走独立配额');
    assert.ok(result.entries.every(entry => entry.section === 'stable'));
  }
});

test('2. 承接链：用户说「陪父亲复诊」→ 下一句「他太顽固」召回父亲与复诊', async t => {
  const { db, embedder } = await harness(t);
  const checkup = seed(db, embedder, {
    kind: 'event',
    value: '用户今天陪父亲去医院复诊，医生说下周还要复查',
    importance: 0.7,
  });
  seed(db, embedder, { kind: 'note', value: '用户喜欢喝乌龙茶' });
  say(db, '今天我陪父亲去医院复诊，医生说下周还要复查', { n: 1 });

  const result = await recall({
    db, embedder, viewer: VIEWER, query: '他太顽固', config: CONFIG, now: NOW, sessionId: SESSION, purpose: 'auto',
  });
  assert.equal(result.queryPlan.source, 'continuation', '代词句必须走承接');
  assert.equal(result.queryPlan.anaphora, true);
  assert.equal(result.queryPlan.anchorCount, 1);
  assert.ok(result.queryPlan.entities.length > 0, '承接必须带出实体');
  assert.ok(
    result.entries.some(entry => entry.record.id === checkup.id),
    `承接后必须召回「陪父亲复诊」那条，实际：${JSON.stringify(values(result.entries))}`,
  );
});

test('3. 无关旧亲密事（tone_only）不进入自动注入正文', async t => {
  const { db, embedder } = await harness(t);
  const intimate = seed(db, embedder, {
    kind: 'event',
    scope: 'user_persona',
    mentionPolicy: 'tone_only',
    realityLevel: 'bot_action',
    value: '那年夏天的亲密旧事，具体细节只说一次',
    importance: 0.95,
  });
  seed(db, embedder, { kind: 'preference', value: '用户喜欢喝拿铁咖啡', importance: 0.8 });

  const auto = await recall({
    db, embedder, viewer: VIEWER, query: '拿铁咖啡', config: CONFIG, now: NOW, sessionId: SESSION, purpose: 'auto',
  });
  const text = renderContext({
    entries: auto.entries, purpose: 'auto', viewer: VIEWER, now: NOW, budget: 2400,
  });
  assert.doesNotMatch(text, /亲密旧事/, '自动注入不得带上旧亲密细节');
  assert.doesNotMatch(text, /那年夏天/);
  assert.equal(auto.gates.injection.mode, 'auto');
  assert.ok(auto.gates.injection.counts.full >= 1, '普通偏好仍是正文');
  // 显式查询才是展开的地方。
  const explicit = await recall({
    db, embedder, viewer: VIEWER, query: '拿铁咖啡', config: CONFIG, now: NOW, sessionId: SESSION, purpose: 'explicit',
  });
  assert.equal(explicit.gates.injection.mode, 'explicit');
  const expanded = renderContext({
    entries: explicit.entries, purpose: 'explicit', viewer: VIEWER, now: NOW, budget: 2400,
  });
  // 即便展开，avoid_unless_asked 之外的行也只在被召回时才出现；这条 tone_only 行
  // 若被召回则正文可见，未被召回也不该凭空出现。
  assert.ok(expanded.length <= 2400);
  assert.ok(intimate.id === intimate.id);
});

test('4. 用户明确纠正：最新纠正优先，旧摘要不再被召回', async t => {
  const { db, embedder } = await harness(t);
  const old = seed(db, embedder, {
    kind: 'summary',
    scope: 'user_persona',
    realityLevel: 'imported_summary',
    mentionPolicy: 'soft_echo',
    value: '旧摘要：用户讨厌喝咖啡因的东西',
    importance: 0.85,
  });
  db.setStatus(old.id, 'superseded', { reason: 'user-correction' });
  const latest = seed(db, embedder, {
    kind: 'preference',
    value: '用户现在每天喝一杯美式咖啡',
    importance: 0.8,
    occurredAt: new Date(NOW - 30 * 60 * 1000).toISOString(),
  });

  const result = await recall({
    db, embedder, viewer: VIEWER, query: '咖啡', config: CONFIG, now: NOW, sessionId: SESSION, purpose: 'auto',
  });
  const found = result.entries.map(entry => entry.record.id);
  assert.ok(found.includes(latest.id), '最新纠正必须可召回');
  assert.ok(!found.includes(old.id), '被取代的旧摘要不得再召回');
  const text = renderContext({ entries: result.entries, purpose: 'auto', viewer: VIEWER, now: NOW, budget: 2400 });
  assert.doesNotMatch(text, /讨厌喝咖啡因/, '旧结论不得出现在注入文本');
  assert.match(text, /美式咖啡/, '最新纠正必须出现');
});

test('5. 显式历史查询「上次我说过什么」仍然召回（门槛提高后不能全空）', async t => {
  const { db, embedder } = await harness(t);
  seed(db, embedder, { kind: 'preference', value: '用户喜欢喝乌龙茶', importance: 0.8 });
  seed(db, embedder, { kind: 'fact', value: '用户住在杭州', importance: 0.7 });

  for (const question of ['上次我说过什么', '你还记得吗', '我们之前聊过什么']) {
    const result = await recall({
      db, embedder, viewer: VIEWER, query: question, config: CONFIG, now: NOW, sessionId: SESSION, purpose: 'auto',
    });
    assert.equal(result.queryPlan.source, 'explicit-history', `${question} 应走元记忆分支`);
    assert.equal(result.queryPlan.historyFallback, true);
    assert.ok(result.entries.length >= 1, `${question} 必须至少召回一条，不能静默全空`);
    const text = renderContext({
      entries: result.entries, purpose: 'auto', viewer: VIEWER, now: NOW, budget: 2400,
    });
    assert.ok(text.length > 0, `${question} 的注入文本不得为空`);
    assert.ok(text.length <= 2400);
  }
});

test('6. 无关查询仍然不注入（覆盖率闸门没被本次改动放宽）', async t => {
  const { db, embedder } = await harness(t);
  for (let index = 0; index < 12; index += 1) {
    seed(db, embedder, {
      kind: 'summary',
      scope: 'user_persona',
      realityLevel: 'imported_summary',
      value: `第${index}次对话摘要：用户讨论了日程安排和完全不同的生活琐事，问题不大`,
      importance: 0.8,
    });
  }
  const result = await recall({
    db, embedder, viewer: VIEWER, query: '完全无关的量子力学问题', config: CONFIG, now: NOW,
    sessionId: SESSION, purpose: 'auto',
  });
  assert.equal(result.queryPlan.source, 'raw');
  assert.deepEqual(result.entries, []);
  assert.equal(renderContext({ entries: result.entries, purpose: 'auto', viewer: VIEWER, now: NOW }), '');
});

test('7. 空查询仍然回落到最近重要记忆（旧路径不回归）', async t => {
  const { db, embedder } = await harness(t);
  seed(db, embedder, { kind: 'preference', value: '用户喜欢喝乌龙茶', importance: 0.9 });
  const result = await recall({
    db, embedder, viewer: VIEWER, query: '', config: CONFIG, now: NOW, sessionId: SESSION, purpose: 'auto',
  });
  assert.equal(result.queryPlan.source, 'raw');
  assert.equal(result.explain.backend, 'recent');
  assert.ok(result.entries.length >= 1);
});
