import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createMemoryEngine } from '../index.mjs';

// task-33（B）：**纠正真的生效** —— 记忆侧把旧事实标成 superseded，`recall` 不再把它带回来。
//
// 这里刻意不用 prompt、不用 materials：直接跑真 memory 引擎 + 真 `recall()`（它内部会走
// retrieve 的关键词/FTS/向量融合），断言**召回结果里没有旧事实**。FTS 路径单独再断言一次，
// 因为 A4 审计的教训是"一层接住了、另一层没接住"。

const T0 = Date.UTC(2026, 10, 5, 3, 0, 0);
const PERSONA = 'bot';
const USER = 'correction_user';
const NAMESPACE = 'companion.correction';

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-memory-correction-'));
  const configFile = path.join(root, 'home', 'companion', 'memory.config.json');
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify({
    backend: 'sqlite',
    database: 'home/memory/companion-memory.db',
    wiki: { enabled: false },
    extraction: { enabled: false },
    // Lexical recall on purpose: a real embedding provider would be a network/model call, which
    // this suite must never make. The semantic channel shares the same `status = 'confirmed'`
    // filter, which is asserted directly through `fullTextSearch` below.
    retrieval: { semanticEnabled: false },
  }, null, 2), 'utf8');
  return root;
}

function identityStub() {
  return {
    owner() { return { id: USER, displayName: '纠正测试用户', platform: 'local' }; },
    resolve(sessionId) { return { userId: USER, personaId: PERSONA, displayName: '纠正测试用户', sessionId }; },
  };
}

async function makeEngine(t) {
  const root = makeRoot(t);
  const engine = createMemoryEngine({ root, identity: identityStub(), env: {}, now: () => T0 });
  t.after(async () => {
    try { await engine.close(); } catch { /* cleanup only */ }
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* cleanup only */ }
  });
  await engine.initialize();
  const internal = await engine.internal();
  assert.ok(internal.db, 'the engine must open a temporary sqlite database');
  return { engine, db: internal.db, root };
}

function factRequest(overrides = {}) {
  return {
    subject: { userId: USER, personaId: PERSONA, worldId: '' },
    namespace: 'companion.event',
    eventId: 'evt_fact_1',
    transformVersion: 't1',
    rootEvidenceIds: [],
    realityStatus: 'actual_tool_activity',
    evidenceStatus: 'confirmed',
    content: '用户喜欢在雨天散步',
    occurredAt: T0,
    ...overrides,
  };
}

function correctionRequest(overrides = {}) {
  return {
    subject: { userId: USER, personaId: PERSONA, worldId: '' },
    namespace: NAMESPACE,
    eventId: 'evt_correction_1',
    transformVersion: 't1',
    rootEvidenceIds: [],
    realityStatus: 'actual_tool_activity',
    evidenceStatus: 'confirmed',
    content: '用户纠正（旧：用户喜欢在雨天散步）现在是「用户不喜欢在雨天散步」',
    supersedesHint: '用户喜欢在雨天散步',
    // Same instant as the clock: a future `occurredAt` is (correctly) not yet valid, and this suite
    // is about the supersede rule, not about clock skew.
    occurredAt: T0,
    ...overrides,
  };
}

const statusOf = (db, id) => db.handle.prepare('SELECT status FROM memories WHERE id = ?').get(id)?.status ?? '';

test('纠正后 recall 不再返回旧事实，并返回新版本', async t => {
  const { engine, db } = await makeEngine(t);
  const first = await engine.ingestDomainEvent(factRequest());
  assert.equal(first.status, 'accepted', JSON.stringify(first));

  const before = await engine.recall({ sessionId: 's1', query: '雨天散步', limit: 5 });
  assert.equal(before.entries.some(entry => String(entry.text ?? entry.value ?? '').includes('喜欢在雨天散步')), true,
    'the old fact is recallable before the correction');

  const correction = await engine.ingestDomainEvent(correctionRequest());
  assert.equal(correction.status, 'accepted', JSON.stringify(correction));
  assert.deepEqual(correction.superseded, [first.recordId], 'the ingest reports what it superseded');
  assert.equal(statusOf(db, first.recordId), 'superseded', 'the old memory row is superseded');

  const after = await engine.recall({ sessionId: 's1', query: '雨天散步', limit: 5 });
  const ids = after.entries.map(entry => String(entry.memoryId ?? entry.id ?? ''));
  const texts = after.entries.map(entry => String(entry.text ?? entry.value ?? ''));
  // Structural, not substring-based: the correction record deliberately *quotes* the old statement
  // (that is how memory knows what to replace), so "the string is absent" would be the wrong test.
  // What must be absent is the old **record**.
  assert.equal(ids.includes(first.recordId), false, 'the superseded record is not recalled');
  assert.equal(statusOf(db, first.recordId), 'superseded');
  assert.equal(texts.some(text => text.includes('现在是「用户不喜欢在雨天散步」')), true, 'the new version is what recall returns');
});

test('FTS 召回路径同样不带旧事实', async t => {
  const { engine, db } = await makeEngine(t);
  const first = await engine.ingestDomainEvent(factRequest());
  await engine.ingestDomainEvent(correctionRequest());

  // The keyword/FTS index is a separate path from the fused recall: assert it directly.
  const hits = db.fullTextSearch({
    userId: USER, personaId: PERSONA, worldId: '', query: '雨天散步', limit: 10,
  });
  const texts = (hits ?? []).map(hit => String(hit.value ?? hit.content ?? ''));
  assert.equal(texts.some(text => text.includes('用户喜欢在雨天散步')), false, 'FTS no longer returns the old fact');
  assert.equal(statusOf(db, first.recordId), 'superseded');
});

test('同一条纠正重复投递只 superse 一次', async t => {
  const { engine, db } = await makeEngine(t);
  const first = await engine.ingestDomainEvent(factRequest());

  const one = await engine.ingestDomainEvent(correctionRequest());
  assert.deepEqual(one.superseded, [first.recordId]);

  // Same event id + same content → the receipt dedupe answers `duplicate` and nothing is rewritten.
  const again = await engine.ingestDomainEvent(correctionRequest());
  assert.equal(again.status, 'duplicate', JSON.stringify(again));

  const revisions = db.handle.prepare(
    "SELECT COUNT(*) AS n FROM memory_revisions WHERE old_id = ? AND operation = 'supersede'",
  ).get(first.recordId)?.n;
  assert.equal(Number(revisions), 1, 'exactly one supersede revision was recorded');
  assert.equal(statusOf(db, first.recordId), 'superseded');
});

test('supersedesHint 指向不存在的记忆：不报错，按普通事实入库', async t => {
  const { engine, db } = await makeEngine(t);
  const result = await engine.ingestDomainEvent(correctionRequest({ supersedesHint: '用户从没说过这句话' }));
  assert.equal(result.status, 'accepted', JSON.stringify(result));
  assert.equal(result.superseded, undefined, 'nothing was superseded');
  assert.equal(statusOf(db, result.recordId), 'confirmed', 'the correction is stored as a normal fact');
});

test('supersedesHint 超长 / 带控制字符 → 拒绝而不是截断', async t => {
  const { engine } = await makeEngine(t);
  const tooLong = await engine.ingestDomainEvent(correctionRequest({ eventId: 'evt_x1', supersedesHint: 'x'.repeat(201) }));
  assert.equal(tooLong.status, 'rejected');
  assert.equal(tooLong.reason, 'invalid-supersedes-hint');
  const control = await engine.ingestDomainEvent(correctionRequest({ eventId: 'evt_x2', supersedesHint: 'bad\u0007hint' }));
  assert.equal(control.status, 'rejected');
  assert.equal(control.reason, 'invalid-supersedes-hint');
});
