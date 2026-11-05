import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createMemoryEngine } from '../../companion-memory/index.mjs';

// 第五轮复审 C4 的跨库崩溃恢复：**重投**（dedupe 命中）时必须带回"哪些 id 真的被压掉"，
// 否则 runtime 永远重建不出回执 ⇒ 裁决永久停在 needs-review。
//
// 这里直接对记忆侧断言（真引擎、真 SQLite），因为要证明的是"重复投递的答案里带着 supersede 结果"。

const T0 = Date.UTC(2026, 10, 22, 3, 0, 0);
const PERSONA = 'march7';
const USER = 'replay_user';
const SCOPE = { userId: USER, personaId: PERSONA, worldId: '' };

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-replay-'));
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
    try { await engine.close(); } catch { /* cleanup */ }
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* cleanup */ }
  });
  return engine;
}

let seq = 0;
function request({ content, supersedeIds, eventId }) {
  seq += 1;
  return {
    subject: SCOPE,
    namespace: 'companion.correction',
    eventId: eventId ?? `evt_replay_${seq}`,
    transformVersion: 't1',
    rootEvidenceIds: [],
    realityStatus: 'actual_tool_activity',
    evidenceStatus: 'confirmed',
    content,
    occurredAt: T0,
    ...(supersedeIds ? { supersedeIds } : {}),
  };
}

test('重投（duplicate）带回真实 supersede 状态：已压的算 duplicate，没压的算 notApplied', async t => {
  const engine = await makeEngine(t);
  const first = await engine.ingestDomainEvent(request({ content: '我喜欢琥珀' }));
  const second = await engine.ingestDomainEvent(request({ content: '我喜欢珊瑚' }));
  assert.equal(first.status, 'accepted', JSON.stringify(first));
  assert.equal(second.status, 'accepted', JSON.stringify(second));

  // The correction really applies (so the replay has something to report).
  const appliedEventId = 'evt_replay_applied';
  const applied = await engine.ingestDomainEvent(request({
    content: '其实我不喜欢这两样了', supersedeIds: [String(first.recordId)], eventId: appliedEventId,
  }));
  assert.equal(applied.status, 'accepted', JSON.stringify(applied));
  assert.deepEqual(applied.supersede?.applied ?? [], [String(first.recordId)]);

  // Now the *same* request arrives again — this is what a crash-then-redeliver looks like.
  const replayed = await engine.ingestDomainEvent(request({
    content: '其实我不喜欢这两样了', supersedeIds: [String(first.recordId), String(second.recordId)],
    eventId: appliedEventId,
  }));
  assert.equal(replayed.status, 'duplicate', `the second delivery is a dedupe hit (got ${JSON.stringify(replayed)})`);
  assert.ok(replayed.supersede, 'and it still carries supersede information');
  assert.deepEqual(replayed.supersede.duplicate ?? [], [String(first.recordId)], 'the id that really was applied is reported');
  assert.deepEqual(replayed.supersede.notApplied ?? [], [String(second.recordId)], 'and the one that never was is named');
  assert.deepEqual(replayed.supersede.applied ?? [], [], 'a replay applies nothing new');
});
