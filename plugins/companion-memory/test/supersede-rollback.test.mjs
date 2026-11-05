import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createMemoryEngine } from '../index.mjs';

// 第四轮 B1（实证缺陷）：`supersedeMany` 的"全成或全不成"曾经是假的。
//
// 真实原因不是缺校验，而是**事务嵌套**：`MemoryDatabase.transaction()` 在 `_depth > 0` 时直接 `fn()`，
// 而 ingest 早已在外层事务里 ⇒ `supersedeMany` 的"事务"只是复用外层；`applySupersedeHint` 又吞掉了
// 异常并正常返回 ⇒ 外层 COMMIT 把**已经压掉的第一条**提交了。
//
// 现在的修法：嵌套事务用 **SAVEPOINT**（零 migration），所以内层失败会真的回滚到保存点。
//
// 本文件的断言按审查的要求加强：失败后**立即查两条的 status 与 revision**，再压第一条必须
// `applied:[id]` / `duplicate:[]` —— 上一版只看 `superseded`（applied 与 duplicate 合并的字段），
// 所以"第一条已被压掉"也能让测试通过。

const T0 = Date.UTC(2026, 10, 16, 3, 0, 0);
const PERSONA = 'bot';
const USER = 'rollback_user';
const SCOPE = { userId: USER, personaId: PERSONA, worldId: '' };

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-memory-rollback-'));
  const configFile = path.join(root, 'home', 'companion', 'memory.config.json');
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify({
    backend: 'sqlite',
    database: 'home/memory/companion-memory.db',
    wiki: { enabled: false },
    extraction: { enabled: false },
    retrieval: { semanticEnabled: false },
  }, null, 2), 'utf8');
  return root;
}

async function makeEngine(t) {
  const root = makeRoot(t);
  const identity = {
    owner() { return { id: USER, displayName: USER, platform: 'local' }; },
    resolve(sessionId) { return { userId: USER, personaId: PERSONA, displayName: USER, sessionId }; },
  };
  const engine = createMemoryEngine({ root, identity, env: {}, now: () => T0 });
  await engine.initialize();
  t.after(async () => {
    try { await engine.close(); } catch { /* cleanup only */ }
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* cleanup only */ }
  });
  return engine;
}

let seq = 0;
async function ingest(engine, { content, supersedeIds = [] }) {
  seq += 1;
  return engine.ingestDomainEvent({
    subject: { userId: USER, personaId: PERSONA, worldId: '' },
    namespace: 'companion.correction',
    eventId: `evt_rb4_${seq}`,
    transformVersion: 't1',
    rootEvidenceIds: [],
    realityStatus: 'actual_tool_activity',
    evidenceStatus: 'confirmed',
    content,
    occurredAt: T0,
    ...(supersedeIds.length ? { supersedeIds } : {}),
  });
}

async function storeOf(engine) {
  const internal = await engine.internal();
  const candidates = [internal?.db, internal?.db?.db, internal?.store, internal?.db?.store].filter(Boolean);
  for (const candidate of candidates) {
    if (typeof candidate.supersedeMemory === 'function' && typeof candidate.transaction === 'function') return candidate;
  }
  return null;
}

/** Read a memory row's status + revision through the store's own read path. */
function rowOf(store, id) {
  const row = store.get?.('SELECT id, status, revision FROM memories WHERE id = ?', id)
    ?? store.handle?.prepare('SELECT id, status, revision FROM memories WHERE id = ?').get(id)
    ?? null;
  return row ? { id: String(row.id), status: String(row.status), revision: Number(row.revision) } : null;
}

test('B1：第二步写失败 → 整批不生效（第一条仍 confirmed、revision 不变）', async t => {
  const engine = await makeEngine(t);
  const first = await ingest(engine, { content: '我喜欢琥珀' });
  const second = await ingest(engine, { content: '我喜欢珊瑚' });
  assert.equal(first.status, 'accepted', JSON.stringify(first));
  assert.equal(second.status, 'accepted', JSON.stringify(second));

  const store = await storeOf(engine);
  assert.ok(store, 'the store that owns supersedeMemory must be reachable for this test');
  const before = rowOf(store, String(first.recordId));
  assert.ok(before, 'the first row must be readable');
  assert.equal(before.status, 'confirmed');

  const original = store.supersedeMemory.bind(store);
  let calls = 0;
  store.supersedeMemory = options => {
    calls += 1;
    if (calls === 2) throw new Error('simulated write failure on the second row');
    return original(options);
  };
  t.after(() => { store.supersedeMemory = original; });

  const attempt = await ingest(engine, {
    content: '其实我不喜欢这两样了',
    supersedeIds: [String(first.recordId), String(second.recordId)],
  });
  assert.equal(calls >= 2, true, `the second write was really attempted (calls=${calls})`);

  // The strengthened assertions the review asked for: look at the ROWS, not at the summary field.
  const afterFirst = rowOf(store, String(first.recordId));
  const afterSecond = rowOf(store, String(second.recordId));
  assert.equal(afterFirst.status, 'confirmed', `the first row must NOT stay superseded (got ${JSON.stringify(afterFirst)})`);
  assert.equal(afterFirst.revision, before.revision, 'and its revision must be untouched');
  assert.equal(afterSecond.status, 'confirmed', 'the second row was never written');

  // The failed request must not carry a success receipt for the supersede it could not apply.
  assert.deepEqual(attempt.supersede?.applied ?? [], [], `no id may be reported as applied (got ${JSON.stringify(attempt.supersede)})`);
  assert.deepEqual(attempt.supersede?.superseded ?? [], [], 'and nothing may be reported as superseded');

  // …and a later single-id correction must still apply the first row (it is confirmed, not superseded).
  store.supersedeMemory = original;
  const retry = await ingest(engine, { content: '其实我更喜欢琥珀', supersedeIds: [String(first.recordId)] });
  assert.deepEqual(retry.supersede?.applied ?? [], [String(first.recordId)], `the first row is still confirmable (got ${JSON.stringify(retry.supersede)})`);
  assert.deepEqual(retry.supersede?.duplicate ?? [], [], 'and it was applied now, not a duplicate');
});
