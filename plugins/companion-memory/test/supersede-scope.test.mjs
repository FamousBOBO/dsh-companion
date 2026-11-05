import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createMemoryEngine } from '../index.mjs';

// task-49（B5，最危险的一条）：**跨作用域压旧**。
//
// 缺陷：`supersedeMemory` 只按 id 更新，不比较 old/new 的 user/persona/world，也不限制旧状态。
// 公共 ingest 的 `supersedeIds` 因此能压掉**别人的**记忆。
//
// 这一组**只走公开 API**（`ingestDomainEvent` / `recall` 的返回值），不碰内部数据库句柄 —— 之前
// 卡在 `engine.internal().db` 形状不一致上，而"记忆还在不在"本来就能用 recall 回答（所有召回层都
// 只取 `status='confirmed'`，这正是 supersede 的可见效果）。

const T0 = Date.UTC(2026, 10, 5, 3, 0, 0);
const PERSONA = 'bot';
const OWNER = 'scope_owner';
const OTHER = 'scope_other';

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-memory-scope-'));
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

/** An identity that can act as two different users, so a cross-scope request is expressible. */
function identityStub() {
  let current = OWNER;
  return {
    as(userId) { current = userId; return this; },
    owner() { return { id: current, displayName: current, platform: 'local' }; },
    resolve(sessionId) { return { userId: current, personaId: PERSONA, displayName: current, sessionId }; },
  };
}

async function makeEngine(t) {
  const root = makeRoot(t);
  const identity = identityStub();
  const engine = createMemoryEngine({ root, identity, env: {}, now: () => T0 });
  await engine.initialize();
  t.after(async () => {
    try { await engine.close(); } catch { /* cleanup only */ }
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* cleanup only */ }
  });
  return { engine, identity };
}

let seq = 0;
async function ingest(engine, { userId, content, supersedeIds = [], namespace = 'companion.correction' }) {
  seq += 1;
  return engine.ingestDomainEvent({
    subject: { userId, personaId: PERSONA, worldId: '' },
    namespace,
    eventId: `evt_scope_${seq}`,
    transformVersion: 't1',
    rootEvidenceIds: [],
    realityStatus: 'actual_tool_activity',
    evidenceStatus: 'confirmed',
    content,
    occurredAt: T0,
    ...(supersedeIds.length ? { supersedeIds } : {}),
  });
}

/** Is this text still reachable by recall for that user? (all recall layers filter `confirmed`) */
async function recalls(engine, { userId, query }) {
  const found = await engine.recall({ query, scope: { userId, personaId: PERSONA, worldId: '' } });
  return JSON.stringify(found ?? {}).includes(query);
}

test('跨 scope 的 supersedeIds → 拒绝，旧记忆仍可召回', async t => {
  const { engine, identity } = await makeEngine(t);
  identity.as(OTHER);
  const theirs = await ingest(engine, { userId: OTHER, content: '她喜欢细雨里的石阶' });
  assert.equal(theirs.status, 'accepted', JSON.stringify(theirs));
  identity.as(OWNER);

  const attempt = await ingest(engine, { userId: OWNER, content: '其实她不喜欢细雨', supersedeIds: [String(theirs.recordId)] });
  assert.equal(attempt.status, 'accepted', 'the new fact itself is still recorded');
  assert.equal(String(attempt.supersede?.reason ?? ''), 'cross-scope-supersede',
    `the refusal names itself (got ${JSON.stringify(attempt.supersede)})`);
  assert.deepEqual(attempt.supersede?.superseded ?? [], [], 'nothing was superseded');
  assert.equal(await recalls(engine, { userId: OTHER, query: '细雨' }), true, 'the foreign memory is still recallable');
});

test('混合（一半同 scope 一半跨 scope）→ 全不生效，不是部分生效', async t => {
  const { engine, identity } = await makeEngine(t);
  const mine = await ingest(engine, { userId: OWNER, content: '我喜欢黎明时分的水泥桥' });
  identity.as(OTHER);
  const theirs = await ingest(engine, { userId: OTHER, content: '她喜欢暮色里的石桥' });
  identity.as(OWNER);

  const attempt = await ingest(engine, {
    userId: OWNER,
    content: '其实我不想再走桥了',
    supersedeIds: [String(mine.recordId), String(theirs.recordId)],
  });
  assert.equal(String(attempt.supersede?.reason ?? ''), 'cross-scope-supersede', JSON.stringify(attempt.supersede));
  assert.deepEqual(attempt.supersede?.superseded ?? [], []);
  // All-or-nothing: nothing was applied at all — including the in-scope id.
  assert.deepEqual(attempt.supersede?.superseded ?? [], [], 'the in-scope row must not be superseded either');
  assert.equal(String(attempt.supersede?.refused?.code ?? ''), 'cross-scope-supersede', 'the refusal names the foreign id');
});

test('同 scope 的正常纠正：旧的不再召回、新的可召回（不回归）', async t => {
  const { engine } = await makeEngine(t);
  const first = await ingest(engine, { userId: OWNER, content: '我讨厌连雨天' });
  const replaced = await ingest(engine, { userId: OWNER, content: '我其实喜欢连雨天', supersedeIds: [String(first.recordId)] });
  assert.equal(replaced.status, 'accepted', JSON.stringify(replaced));
  assert.deepEqual(replaced.supersede?.superseded ?? [], [String(first.recordId)], JSON.stringify(replaced.supersede));
  assert.equal(await recalls(engine, { userId: OWNER, query: '讨厌连雨' }), false, 'the old fact is gone from recall');
  assert.equal(await recalls(engine, { userId: OWNER, query: '喜欢连雨' }), true);
});

test('已 superseded → 幂等；不存在的 id → 全批拒绝（不许部分生效）', async t => {
  const { engine } = await makeEngine(t);
  const first = await ingest(engine, { userId: OWNER, content: '我讨厌起雾的早晨' });
  const oldId = String(first.recordId);
  const replaced = await ingest(engine, { userId: OWNER, content: '我现在喜欢起雾的早晨', supersedeIds: [oldId] });
  assert.deepEqual(replaced.supersede?.superseded ?? [], [oldId]);

  // Idempotent: the same id again is a no-op, and the batch still succeeds.
  const again = await ingest(engine, { userId: OWNER, content: '再确认一次：我喜欢起雾的早晨', supersedeIds: [oldId] });
  assert.equal(again.status, 'accepted', JSON.stringify(again));
  assert.deepEqual(again.supersede?.applied ?? [], [], 'an already-superseded row is not superseded twice');
  assert.deepEqual(again.supersede?.duplicate ?? [], [oldId], 'it is reported as a duplicate, not as work done');
  assert.equal(await recalls(engine, { userId: OWNER, query: '讨厌起雾' }), false, 'still gone');

  // A batch containing a non-existent id writes nothing at all.
  const other = await ingest(engine, { userId: OWNER, content: '我喜欢雾散之后的阳光' });
  const mixed = await ingest(engine, {
    userId: OWNER,
    content: '雾散之后其实没什么',
    supersedeIds: [String(other.recordId), 'mem_does_not_exist_at_all'],
  });
  assert.equal(String(mixed.supersede?.reason ?? ''), 'not-found', JSON.stringify(mixed.supersede));
  assert.deepEqual(mixed.supersede?.superseded ?? [], [], 'all-or-nothing: the valid id was not applied');
  assert.equal(await recalls(engine, { userId: OWNER, query: '阳光' }), true, 'and it is still recallable');
});
