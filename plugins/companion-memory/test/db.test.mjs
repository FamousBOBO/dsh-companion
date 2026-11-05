import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  APPLICATION_ID, MemoryDatabase, SCHEMA_VERSION, migrateSchema, openMemoryDatabase,
} from '../lib/db.mjs';

const USER_ID = 'user_local';
const PERSONA_ID = 'march7';

// Every test owns a throwaway directory and closes its handles before the
// directory is removed (Windows keeps a lock on open SQLite files).
function createHarness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-memory-db-'));
  const file = path.join(dir, 'memory.db');
  const opened = [];
  const open = async (overrides = {}) => {
    const db = await openMemoryDatabase({ file, ...overrides });
    opened.push(db);
    return db;
  };
  t.after(() => {
    for (const db of opened) {
      try {
        db.close();
      } catch {
        // already closed by the test
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, file, open };
}

function draft(overrides = {}) {
  return {
    scope: 'user_global',
    kind: 'fact',
    subject: 'user',
    predicate: 'note',
    value: '用户的示例记忆',
    userId: USER_ID,
    personaId: PERSONA_ID,
    worldId: '',
    ...overrides,
  };
}

async function seedMemory(db, overrides = {}) {
  return db.insertMemory(draft(overrides)).record;
}

test('openMemoryDatabase creates the schema, persists the version and reopens cleanly', async t => {
  const harness = createHarness(t);
  const db = await harness.open({ timeoutMs: 2500 });

  assert.equal(db.schemaVersion(), SCHEMA_VERSION);
  assert.equal(db.file, path.resolve(harness.file));
  assert.equal(db.readOnly, false);
  assert.equal(db.journalMode, 'wal');
  const createdAt = db.meta('createdAt');
  assert.ok(createdAt && Number.isFinite(Date.parse(createdAt)));
  assert.equal(db.journalMode, String(db.handle.prepare('PRAGMA journal_mode').get().journal_mode).toLowerCase());
  assert.equal(Number(db.handle.prepare('PRAGMA application_id').get().application_id), APPLICATION_ID);
  assert.equal(Number(db.handle.prepare('PRAGMA busy_timeout').get().timeout), 2500);
  assert.equal(Number(db.handle.prepare('PRAGMA foreign_keys').get().foreign_keys), 1);

  await seedMemory(db, { value: '用户喜欢喝热可可' });
  db.close();

  const reopened = await harness.open();
  assert.equal(reopened.schemaVersion(), SCHEMA_VERSION);
  assert.equal(reopened.meta('createdAt'), createdAt);
  assert.equal(reopened.stats().memories, 1);
  assert.equal(reopened.integrityCheck().ok, true);
  assert.equal(reopened.handle.prepare("SELECT count(*) AS total FROM memories").get().total, 1);
});

test('openMemoryDatabase refuses foreign, corrupt and newer databases', async t => {
  const harness = createHarness(t);
  const { DatabaseSync } = await import('node:sqlite');

  const foreign = path.join(harness.dir, 'foreign.db');
  const foreignHandle = new DatabaseSync(foreign);
  foreignHandle.exec('PRAGMA application_id = 424242');
  foreignHandle.exec('CREATE TABLE their_table (x TEXT)');
  foreignHandle.close();
  await assert.rejects(openMemoryDatabase({ file: foreign }), /application_id/);

  const unclaimed = path.join(harness.dir, 'unclaimed.db');
  const unclaimedHandle = new DatabaseSync(unclaimed);
  unclaimedHandle.exec('CREATE TABLE someone_else (x TEXT)');
  unclaimedHandle.close();
  await assert.rejects(openMemoryDatabase({ file: unclaimed }), /已被其它应用占用/);

  const junk = path.join(harness.dir, 'junk.db');
  fs.writeFileSync(junk, 'not a sqlite database '.repeat(400));
  await assert.rejects(openMemoryDatabase({ file: junk }), /无法打开记忆数据库/);

  const future = await harness.open();
  future.setMeta('schemaVersion', '99');
  future.close();
  await assert.rejects(openMemoryDatabase({ file: harness.file }), /版本不兼容/);

  await assert.rejects(openMemoryDatabase({ file: '   ' }), /路径不能为空/);
});

test('旧版本库按迁移链升级：v1 -> v2 补发生时间索引，只读打开不迁移', async t => {
  const harness = createHarness(t);
  const db = await harness.open();
  const memory = await seedMemory(db, { value: '用户喜欢在雨天散步', occurredAt: '2026-10-20T02:00:00.000Z' });
  db.close();

  // 手工退回 v1：删掉 v2 的索引并改版本号，模拟上一版写出的库。
  const raw = await harness.open();
  raw.handle.exec('DROP INDEX IF EXISTS idx_memories_occurred_at');
  raw.handle.prepare("UPDATE schema_meta SET value = '1' WHERE key = 'schemaVersion'").run();
  raw.close();

  // 只读打开：允许读，但不迁移，标记 outdated。
  const reader = await harness.open({ readOnly: true });
  assert.equal(reader.schemaVersion(), 1);
  assert.equal(reader.schemaOutdated, true);
  assert.deepEqual(reader.migrated, []);
  assert.equal(reader.getMemory(memory.id).value, '用户喜欢在雨天散步');
  reader.close();

  // 可写打开：跑迁移、版本升到当前、索引存在、数据不变。
  const upgraded = await harness.open();
  assert.equal(upgraded.schemaVersion(), SCHEMA_VERSION);
  assert.equal(upgraded.schemaOutdated, false);
  assert.deepEqual(upgraded.migrated, [SCHEMA_VERSION]);
  const index = upgraded.handle.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_memories_occurred_at'",
  ).get();
  assert.ok(index, 'v2 迁移必须建出 occurred_at 索引');
  assert.equal(upgraded.getMemory(memory.id).occurredAt, '2026-10-20T02:00:00.000Z');
  upgraded.close();

  // 再开一次：已经是当前版本，不重复迁移。
  const again = await harness.open();
  assert.deepEqual(again.migrated, []);
  again.close();
});

test('migrateSchema 可以直接调用且幂等（不依赖 schema.sql 顺手建索引）', async t => {
  const harness = createHarness(t);
  const db = await harness.open();
  db.handle.exec('DROP INDEX IF EXISTS idx_memories_occurred_at');
  const missing = db.handle.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_memories_occurred_at'",
  ).get();
  assert.equal(missing, undefined);

  assert.deepEqual(migrateSchema(db.handle, 1), [2]);
  const created = db.handle.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_memories_occurred_at'",
  ).get();
  assert.ok(created, 'migrateSchema(1) 必须建出索引');
  // 幂等：已经迁移过的版本不再执行。
  assert.deepEqual(migrateSchema(db.handle, SCHEMA_VERSION), []);
  db.close();
});

test('read-only connections can read but never write', async t => {
  const harness = createHarness(t);
  const writer = await harness.open();
  const record = await seedMemory(writer, { value: '用户喜欢听爵士乐' });
  writer.close();

  const reader = await harness.open({ readOnly: true });
  assert.equal(reader.readOnly, true);
  assert.equal(reader.getMemory(record.id).value, '用户喜欢听爵士乐');
  assert.equal(reader.integrityCheck().ok, true);
  assert.throws(() => reader.insertMemory(draft()), /只读模式/);
  assert.throws(() => reader.setMeta('k', 'v'), /只读模式/);
});

test('appendEvent is idempotent and never rewrites the original evidence', async t => {
  const harness = createHarness(t);
  const db = await harness.open();

  const base = {
    eventKey: 'session-1:user:1',
    sessionId: 'session-1',
    seq: 1,
    role: 'user',
    sourceKind: 'desktop_conversation',
    occurredAt: '2026-03-01T10:00:00.000Z',
    content: '今天想吃点甜的',
    userId: USER_ID,
    personaId: PERSONA_ID,
    meta: { source: 'desktop' },
  };

  const first = db.appendEvent(base);
  assert.equal(first.inserted, true);
  assert.match(first.sourceId, /^evt_[0-9a-f]{20}$/);

  const second = db.appendEvent({ ...base, content: '被改写的内容', meta: { source: 'other' } });
  assert.equal(second.inserted, false);
  assert.equal(second.sourceId, first.sourceId);
  assert.equal(db.stats().events, 1);

  const stored = db.getEvent(first.sourceId);
  assert.equal(stored.content, '今天想吃点甜的');
  assert.deepEqual(stored.meta, { source: 'desktop' });
  assert.equal(stored.seq, 1);
  assert.equal(stored.searchText.includes('想吃'), true);

  const later = db.appendEvent({
    ...base,
    eventKey: 'session-1:assistant:2',
    seq: 2,
    role: 'assistant',
    occurredAt: '2026-03-01T10:05:00.000Z',
    content: '那就去吃蛋糕吧',
  });
  assert.equal(later.inserted, true);

  const sessionRows = db.eventsForSession('session-1');
  assert.deepEqual(sessionRows.map(row => row.seq), [1, 2]);
  assert.equal(db.eventsForSession('session-1', { limit: 1 }).length, 1);
  assert.equal(db.eventsForSession('session-1', { afterSeq: 1 }).length, 1);
  assert.equal(db.eventsSince({ userId: USER_ID, personaId: PERSONA_ID }).length, 2);
  assert.equal(db.eventsSince({ userId: USER_ID, personaId: PERSONA_ID, afterOccurredAt: '2026-03-01T10:00:00.000Z' }).length, 1);
  assert.equal(db.eventsSince({ userId: 'someone-else', personaId: PERSONA_ID }).length, 0);
});

test('insertMemory dedupes by derived dedupe key and keeps policy defaults', async t => {
  const harness = createHarness(t);
  const db = await harness.open();

  const first = db.insertMemory(draft({ value: '用户喜欢喝拿铁', kind: 'preference' }));
  assert.equal(first.inserted, true);
  assert.match(first.record.id, /^mem_[0-9a-f]{20}$/);
  assert.match(first.record.dedupeKey, /^dedupe_[0-9a-f]{20}$/);
  assert.equal(first.record.revision, 1);
  assert.equal(first.record.status, 'confirmed');
  assert.equal(first.record.realityLevel, 'imported_fact');
  assert.equal(first.record.importance, 0.75);
  assert.equal(first.record.mentionPolicy, 'direct');
  assert.equal(first.record.confidence, 0.5);
  assert.deepEqual(first.record.tags, []);
  assert.equal(first.record.searchText.includes('拿铁'), true);

  const duplicate = db.insertMemory(draft({ value: '用户喜欢喝拿铁', kind: 'preference' }));
  assert.equal(duplicate.inserted, false);
  assert.equal(duplicate.record.id, first.record.id);
  assert.equal(db.stats().memories, 1);

  const other = db.insertMemory(draft({ value: '用户喜欢喝美式', kind: 'preference' }));
  assert.equal(other.inserted, true);
  assert.notEqual(other.record.id, first.record.id);

  // Kind drives the importance fallback; tags survive a round trip.
  const tagged = db.insertMemory(draft({
    value: '用户对花生过敏', kind: 'profile', tags: ['健康', '健康', ' 饮食 '], importance: undefined,
  }));
  assert.equal(tagged.record.importance, 0.9);
  assert.deepEqual(tagged.record.tags, ['健康', '饮食']);
  assert.deepEqual(db.getMemory(tagged.record.id).tags, ['健康', '饮食']);
});

test('updateMemory bumps revision, reindexes FTS and writes memory_revisions', async t => {
  const harness = createHarness(t);
  const db = await harness.open();

  const record = await seedMemory(db, { value: '用户早餐喜欢吃包子', predicate: 'breakfast_food' });
  assert.deepEqual(db.fullTextSearch({ userId: USER_ID, personaId: PERSONA_ID, query: '包子' }).map(hit => hit.id), [record.id]);

  const updated = db.updateMemory(record.id, { value: '用户早餐喜欢吃面包', confidence: 0.9 }, { reason: '用户更正', actor: 'user' });
  assert.equal(updated.id, record.id);
  assert.equal(updated.revision, 2);
  assert.equal(updated.value, '用户早餐喜欢吃面包');
  assert.equal(updated.confidence, 0.9);
  assert.ok(Date.parse(updated.updatedAt) >= Date.parse(updated.createdAt));

  assert.equal(db.fullTextSearch({ userId: USER_ID, personaId: PERSONA_ID, query: '包子' }).length, 0);
  const hits = db.fullTextSearch({ userId: USER_ID, personaId: PERSONA_ID, query: '面包' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, record.id);
  assert.ok(hits[0].score > 0, 'score must be a positive -bm25 value');
  assert.equal(hits[0].rank, hits[0].score);

  const revisions = db.revisionsFor(record.id);
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0].operation, 'update');
  assert.equal(revisions[0].reason, '用户更正');
  assert.equal(revisions[0].actor, 'user');
  assert.equal(revisions[0].newId, record.id);

  assert.throws(() => db.updateMemory('mem_missing', { value: 'x' }), /记忆不存在/);
});

test('setStatus retires a record and closes its validity window', async t => {
  const harness = createHarness(t);
  const db = await harness.open();

  const record = await seedMemory(db, { value: '用户暂时住在北京', predicate: 'residence' });
  const retired = db.setStatus(record.id, 'retracted', { reason: '用户否认', actor: 'user' });
  assert.equal(retired.status, 'retracted');
  assert.ok(retired.validTo);
  assert.equal(retired.revision, 2);
  assert.equal(db.revisionsFor(record.id)[0].operation, 'status');
  assert.equal(db.listMemories({ userId: USER_ID, personaId: PERSONA_ID }).length, 0);
  assert.equal(db.listMemories({ userId: USER_ID, personaId: PERSONA_ID, includeExpired: true }).length, 1);
  assert.throws(() => db.setStatus(record.id, 'nonsense'), /status 取值非法/);
});

test('rememberFact supersedes the previous value of a stable predicate', async t => {
  const harness = createHarness(t);
  const db = await harness.open();

  const first = db.rememberFact({ userId: USER_ID, personaId: PERSONA_ID, key: 'breakfast_food', value: '用户早餐喜欢吃包子' });
  assert.equal(first.status, 'confirmed');
  assert.equal(first.scope, 'user_global');
  assert.equal(first.realityLevel, 'explicit_user_statement');
  assert.ok(first.validFrom);

  const second = db.rememberFact({ userId: USER_ID, personaId: PERSONA_ID, key: 'breakfast_food', value: '用户早餐喜欢吃面包' });
  assert.notEqual(second.id, first.id);
  assert.equal(second.supersedesId, first.id);
  assert.equal(second.status, 'confirmed');

  const old = db.getMemory(first.id);
  assert.equal(old.status, 'superseded');
  assert.ok(old.validTo);
  assert.equal(old.revision, 2);

  const supersedeRevisions = db.revisionsFor(first.id);
  assert.equal(supersedeRevisions.length, 1);
  assert.equal(supersedeRevisions[0].operation, 'supersede');
  assert.equal(supersedeRevisions[0].oldId, first.id);
  assert.equal(supersedeRevisions[0].newId, second.id);

  assert.deepEqual(db.fullTextSearch({ userId: USER_ID, personaId: PERSONA_ID, query: '包子' }), []);
  assert.deepEqual(db.fullTextSearch({ userId: USER_ID, personaId: PERSONA_ID, query: '面包' }).map(hit => hit.id), [second.id]);

  // Repeating the current value is a no-op, not a new generation.
  const repeat = db.rememberFact({ userId: USER_ID, personaId: PERSONA_ID, key: 'breakfast_food', value: '用户早餐喜欢吃面包' });
  assert.equal(repeat.id, second.id);
  // The retired row is kept for audit but excluded from the live view.
  assert.equal(db.countMemories({ userId: USER_ID, personaId: PERSONA_ID, predicate: 'breakfast_food' }), 1);
  assert.equal(db.countMemories({ userId: USER_ID, personaId: PERSONA_ID, predicate: 'breakfast_food', includeExpired: true }), 2);

  // Old value -> new -> old again must revive a live row, not return the dead one.
  const revived = db.rememberFact({ userId: USER_ID, personaId: PERSONA_ID, key: 'breakfast_food', value: '用户早餐喜欢吃包子' });
  assert.equal(revived.status, 'confirmed');
  assert.notEqual(revived.id, first.id);
  assert.equal(revived.supersedesId, second.id);
  assert.equal(db.getMemory(second.id).status, 'superseded');
  assert.equal(db.countMemories({ userId: USER_ID, personaId: PERSONA_ID, predicate: 'breakfast_food' }), 1);
  assert.equal(db.countMemories({ userId: USER_ID, personaId: PERSONA_ID, predicate: 'breakfast_food', includeExpired: true }), 3);
});

test('rememberFact keeps every distinct value for multi: predicates', async t => {
  const harness = createHarness(t);
  const db = await harness.open();

  const blue = db.rememberFact({ userId: USER_ID, personaId: PERSONA_ID, key: 'multi:favorite_color', value: '用户喜欢蓝色' });
  const red = db.rememberFact({ userId: USER_ID, personaId: PERSONA_ID, key: 'multi:favorite_color', value: '用户喜欢红色' });
  assert.notEqual(blue.id, red.id);
  assert.equal(db.getMemory(blue.id).status, 'confirmed');
  assert.equal(db.getMemory(red.id).status, 'confirmed');

  const repeat = db.rememberFact({ userId: USER_ID, personaId: PERSONA_ID, key: 'multi:favorite_color', value: '用户喜欢蓝色' });
  assert.equal(repeat.id, blue.id);
  assert.equal(db.countMemories({ userId: USER_ID, personaId: PERSONA_ID, predicate: 'multi:favorite_color' }), 2);
  assert.deepEqual(db.revisionsFor(blue.id), []);
});

test('fullTextSearch recalls Chinese bigrams and returns nothing for unrelated text', async t => {
  const harness = createHarness(t);
  const db = await harness.open();

  const hike = await seedMemory(db, { value: '用户喜欢在周末去爬山', predicate: 'weekend_activity' });
  const cat = await seedMemory(db, { value: '用户养了一只叫团子的橘猫', predicate: 'pet' });
  const work = await seedMemory(db, { value: '用户每天早上查看 GitHub Actions 构建日志', predicate: 'workflow' });

  assert.deepEqual(db.fullTextSearch({ userId: USER_ID, personaId: PERSONA_ID, query: '爬山' }).map(hit => hit.id), [hike.id]);
  assert.deepEqual(db.fullTextSearch({ userId: USER_ID, personaId: PERSONA_ID, query: '团子' }).map(hit => hit.id), [cat.id]);
  assert.deepEqual(db.fullTextSearch({ userId: USER_ID, personaId: PERSONA_ID, query: 'github' }).map(hit => hit.id), [work.id]);

  assert.deepEqual(db.fullTextSearch({ userId: USER_ID, personaId: PERSONA_ID, query: '量子力学' }), []);
  assert.deepEqual(db.fullTextSearch({ userId: USER_ID, personaId: PERSONA_ID, query: '' }), []);
  assert.deepEqual(db.fullTextSearch({ userId: USER_ID, personaId: PERSONA_ID, query: '的了吗' }), []);
  // Punctuation and quotes must never reach FTS5 as syntax.
  assert.deepEqual(db.fullTextSearch({ userId: USER_ID, personaId: PERSONA_ID, query: '"爬" 山* (x' }), []);
});

test('fullTextSearch isolates owners, statuses, scopes and worlds', async t => {
  const harness = createHarness(t);
  const db = await harness.open();

  const mine = await seedMemory(db, { value: '用户喜欢猫' });
  const other = db.insertMemory(draft({ value: '用户喜欢猫', userId: 'user_other', personaId: 'other_persona' }));
  assert.equal(other.inserted, true);

  assert.deepEqual(db.fullTextSearch({ userId: USER_ID, personaId: PERSONA_ID, query: '喜欢猫' }).map(hit => hit.id), [mine.id]);
  assert.deepEqual(
    db.fullTextSearch({ userId: 'user_other', personaId: 'other_persona', query: '喜欢猫' }).map(hit => hit.id),
    [other.record.id],
  );

  const pending = await seedMemory(db, { value: '用户计划学习钢琴', status: 'pending' });
  assert.deepEqual(db.fullTextSearch({ userId: USER_ID, personaId: PERSONA_ID, query: '钢琴' }), []);
  assert.deepEqual(
    db.fullTextSearch({ userId: USER_ID, personaId: PERSONA_ID, query: '钢琴', statuses: ['confirmed', 'pending'] }).map(hit => hit.id),
    [pending.id],
  );

  const selfNote = await seedMemory(db, { value: '三月七喜欢给用户拍照', scope: 'persona_self', kind: 'bot_action', realityLevel: 'bot_action' });
  assert.deepEqual(db.fullTextSearch({ userId: USER_ID, personaId: PERSONA_ID, query: '拍照', scopes: ['user_global'] }), []);
  assert.deepEqual(
    db.fullTextSearch({ userId: USER_ID, personaId: PERSONA_ID, query: '拍照', scopes: ['persona_self'] }).map(hit => hit.id),
    [selfNote.id],
  );

  const worldOne = await seedMemory(db, { value: '剧情里用户是骑士团团长', scope: 'roleplay_world', worldId: 'world_one' });
  const worldTwo = await seedMemory(db, { value: '剧情里用户是骑士团团长', scope: 'roleplay_world', worldId: 'world_two' });
  assert.equal(worldOne.id !== worldTwo.id, true);
  assert.deepEqual(
    db.fullTextSearch({ userId: USER_ID, personaId: PERSONA_ID, worldId: 'world_one', query: '骑士团' }).map(hit => hit.id),
    [worldOne.id],
  );
  assert.deepEqual(
    db.fullTextSearch({ userId: USER_ID, personaId: PERSONA_ID, worldId: 'world_two', query: '骑士团' }).map(hit => hit.id),
    [worldTwo.id],
  );
  // The reality layer stays visible inside a world, fiction does not leak out.
  assert.deepEqual(db.fullTextSearch({ userId: USER_ID, personaId: PERSONA_ID, worldId: '', query: '骑士团' }), []);
  const insideWorld = db.fullTextSearch({ userId: USER_ID, personaId: PERSONA_ID, worldId: 'world_one', query: '喜欢猫' }).map(hit => hit.id);
  assert.equal(insideWorld.includes(mine.id), true);
  assert.equal(insideWorld.includes(worldTwo.id), false);
});

test('transaction rolls back on throw and composes when nested', async t => {
  const harness = createHarness(t);
  const db = await harness.open();

  assert.throws(() => db.transaction(() => {
    db.insertMemory(draft({ value: '用户喜欢登山' }));
    throw new Error('boom');
  }), /boom/);
  assert.equal(db.stats().memories, 0);
  assert.equal(db.handle.prepare('SELECT count(*) AS total FROM memory_fts').get().total, 0);

  const nested = db.transaction(() => {
    db.insertMemory(draft({ value: '用户喜欢露营' }));
    return db.transaction(() => db.insertMemory(draft({ value: '用户喜欢钓鱼' })).inserted);
  });
  assert.equal(nested, true);
  assert.equal(db.stats().memories, 2);

  assert.throws(() => db.transaction(() => {
    db.insertMemory(draft({ value: '用户喜欢潜水' }));
    db.transaction(() => {
      throw new Error('inner');
    });
  }), /inner/);
  assert.equal(db.stats().memories, 2);
  const survivors = db.listMemories({ userId: USER_ID, personaId: PERSONA_ID, predicate: 'note' })
    .map(row => row.value)
    .sort();
  assert.deepEqual(survivors, ['用户喜欢露营', '用户喜欢钓鱼'].sort());
  assert.equal(db.handle.prepare('SELECT count(*) AS total FROM memory_fts').get().total, 2);

  assert.throws(() => db.transaction(async () => {}), /同步函数/);
});

test('claimJob hands each job to exactly one caller', async t => {
  const harness = createHarness(t);
  const db = await harness.open();

  const one = db.enqueueJob({ type: 'extract', streamKey: 'chat-a', payload: { from: 1 } });
  const two = db.enqueueJob({ type: 'extract', streamKey: 'chat-b' });
  assert.notEqual(one.jobId, two.jobId);
  assert.equal(one.state, 'pending');
  assert.deepEqual(one.payload, { from: 1 });

  const claimed = [db.claimJob('extract'), db.claimJob('extract'), db.claimJob('extract')];
  assert.ok(claimed[0] && claimed[1]);
  assert.equal(claimed[2], null);
  assert.notEqual(claimed[0].jobId, claimed[1].jobId);
  assert.deepEqual(new Set([claimed[0].jobId, claimed[1].jobId]), new Set([one.jobId, two.jobId]));
  assert.equal(claimed[0].state, 'running');
  assert.equal(db.jobStats().running, 2);
  assert.equal(db.jobStats().pending, 0);

  const done = db.completeJob(claimed[0].jobId, { cursor: 42 });
  assert.equal(done.state, 'done');
  assert.equal(done.cursor, 42);
  assert.equal(done.lastError, '');

  const jobs = db.jobs({ state: 'done' });
  assert.deepEqual(jobs.map(job => job.jobId), [claimed[0].jobId]);
  assert.equal(db.jobs({ type: 'extract' }).length, 2);
});

test('enqueueJob reuses the unfinished job of one stream', async t => {
  const harness = createHarness(t);
  const db = await harness.open();

  const first = db.enqueueJob({ type: 'extract', streamKey: 'chat-a' });
  const again = db.enqueueJob({ type: 'extract', streamKey: 'chat-a', payload: { ignored: true } });
  assert.equal(again.jobId, first.jobId);
  assert.equal(db.jobStats().pending, 1);

  db.claimJob('extract');
  const whileRunning = db.enqueueJob({ type: 'extract', streamKey: 'chat-a' });
  assert.equal(whileRunning.jobId, first.jobId);

  db.completeJob(first.jobId);
  const afterDone = db.enqueueJob({ type: 'extract', streamKey: 'chat-a' });
  assert.notEqual(afterDone.jobId, first.jobId);
});

test('failJob backs off exponentially and gives up after five attempts', async t => {
  const harness = createHarness(t);
  const db = await harness.open();

  const job = db.enqueueJob({ type: 'extract', streamKey: 'chat-a' });
  const claimed = db.claimJob('extract');
  assert.equal(claimed.jobId, job.jobId);

  const failedOnce = db.failJob(job.jobId, '模型调用超时');
  assert.equal(failedOnce.attempts, 1);
  assert.equal(failedOnce.state, 'pending');
  assert.match(failedOnce.lastError, /模型调用超时/);
  const firstDelay = Date.parse(failedOnce.nextRetryAt) - Date.now();
  assert.ok(firstDelay > 0 && firstDelay <= 2000, `unexpected first delay ${firstDelay}`);

  // Not due yet: the queue must stay empty.
  assert.equal(db.claimJob('extract'), null);
  const due = db.claimJob('extract', { now: Date.now() + 60_000 });
  assert.equal(due.jobId, job.jobId);

  const failedTwice = db.failJob(job.jobId, '模型调用超时');
  assert.equal(failedTwice.attempts, 2);
  const secondDelay = Date.parse(failedTwice.nextRetryAt) - Date.now();
  assert.ok(secondDelay > firstDelay, `expected exponential growth, got ${secondDelay}`);

  for (let attempt = 3; attempt <= 5; attempt += 1) {
    const current = db.claimJob('extract', { now: Date.now() + attempt * 600_000 });
    assert.ok(current, `attempt ${attempt} should be claimable`);
    const failed = db.failJob(current.jobId, `第 ${attempt} 次失败`, { retryDelayMs: 1000 });
    assert.equal(failed.attempts, attempt);
    if (attempt < 5) {
      assert.equal(failed.state, 'pending');
      assert.ok(failed.nextRetryAt);
    } else {
      assert.equal(failed.state, 'failed');
      assert.equal(failed.nextRetryAt, null);
      assert.match(failed.lastError, /第 5 次失败/);
    }
  }

  assert.equal(db.claimJob('extract', { now: Date.now() + 86_400_000 }), null);
  assert.equal(db.jobStats().failed, 1);
  assert.equal(db.jobs({ state: 'failed' }).length, 1);
  assert.equal(db.failJob('job_missing', 'x'), null);
});

test('claimJob can be scoped to one stream', async t => {
  const harness = createHarness(t);
  const db = await harness.open();

  const plain = db.enqueueJob({ type: 'extract', streamKey: '' });
  const chatA = db.enqueueJob({ type: 'extract', streamKey: 'chat-a' });
  const chatB = db.enqueueJob({ type: 'extract', streamKey: 'chat-b' });

  const claimedB = db.claimJob('extract', { streamKey: 'chat-b' });
  assert.equal(claimedB.jobId, chatB.jobId);
  assert.equal(claimedB.streamKey, 'chat-b');
  assert.equal(db.claimJob('extract', { streamKey: 'chat-b' }), null);
  assert.equal(db.claimJob('extract', { streamKey: 'chat-unknown' }), null);

  // Omitting streamKey keeps the original cross-stream behaviour.
  assert.equal(db.claimJob('extract').jobId, plain.jobId);
  assert.equal(db.claimJob('extract', { streamKey: 'chat-a' }).jobId, chatA.jobId);
  assert.equal(db.claimJob('extract'), null);
});

test('two connections never claim the same job', async t => {
  const harness = createHarness(t);
  const writer = await harness.open();
  const worker = await harness.open();

  const queued = [];
  for (let index = 0; index < 4; index += 1) {
    // force so four independent batches exist; without it the queue folds
    // every enqueue into the one pending job of the stream.
    queued.push(writer.enqueueJob({ type: 'extract', streamKey: 'chat-shared', payload: { index }, force: true }));
  }

  const claimed = [];
  for (let round = 0; round < 6; round += 1) {
    const db = round % 2 === 0 ? writer : worker;
    const job = db.claimJob('extract', { streamKey: 'chat-shared' });
    if (job) claimed.push(job.jobId);
  }

  assert.equal(claimed.length, 4);
  assert.equal(new Set(claimed).size, 4);
  assert.deepEqual(new Set(claimed), new Set(queued.map(job => job.jobId)));
  // Both connections agree on the result; nothing is left claimable.
  assert.equal(writer.jobStats().running, 4);
  assert.equal(worker.jobStats().running, 4);
  assert.equal(worker.claimJob('extract', { streamKey: 'chat-shared' }), null);
});

test('enqueueJob force starts a second job for the same stream', async t => {
  const harness = createHarness(t);
  const db = await harness.open();

  const first = db.enqueueJob({ type: 'extract', streamKey: 'chat-a', payload: { batch: 1 } });
  const reused = db.enqueueJob({ type: 'extract', streamKey: 'chat-a', payload: { batch: 99 } });
  assert.equal(reused.jobId, first.jobId);
  assert.deepEqual(reused.payload, { batch: 1 });

  const forced = db.enqueueJob({ type: 'extract', streamKey: 'chat-a', payload: { batch: 2 }, force: true });
  assert.notEqual(forced.jobId, first.jobId);
  assert.equal(forced.state, 'pending');
  assert.deepEqual(forced.payload, { batch: 2 });
  assert.equal(db.jobStats().pending, 2);
  assert.equal(db.jobs({ type: 'extract' }).length, 2);

  // The presence of a forced job must not turn the default path into force.
  const folded = db.enqueueJob({ type: 'extract', streamKey: 'chat-a' });
  assert.equal(folded.jobId, first.jobId);
  assert.equal(db.jobStats().pending, 2);

  // Both pending jobs of the stream are claimable, oldest first.
  assert.equal(db.claimJob('extract', { streamKey: 'chat-a' }).jobId, first.jobId);
  assert.equal(db.claimJob('extract', { streamKey: 'chat-a' }).jobId, forced.jobId);
});

test('requeueJob revives a failed job and clears its backoff', async t => {
  const harness = createHarness(t);
  const db = await harness.open();

  const job = db.enqueueJob({ type: 'extract', streamKey: 'chat-a' });
  let failed = null;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const claimed = db.claimJob('extract', { streamKey: 'chat-a', now: Date.now() + attempt * 600_000 });
    assert.ok(claimed, `attempt ${attempt} should be claimable`);
    failed = db.failJob(claimed.jobId, '模型多次失败', { retryDelayMs: 1000 });
  }
  assert.equal(failed.state, 'failed');
  assert.equal(failed.attempts, 5);

  const revived = db.requeueJob(job.jobId);
  assert.equal(revived.ok, true);
  assert.equal(revived.job.state, 'pending');
  assert.equal(revived.job.nextRetryAt, null);
  assert.equal(revived.job.attempts, 5);
  assert.equal(revived.job.lastError, failed.lastError);

  const reclaimed = db.claimJob('extract', { streamKey: 'chat-a' });
  assert.equal(reclaimed.jobId, job.jobId);
  assert.equal(reclaimed.attempts, 5);

  // resetAttempts gives the batch a clean retry budget without losing payload.
  const failedAgain = db.failJob(job.jobId, '再次失败', { retryDelayMs: 1000 });
  assert.equal(failedAgain.attempts, 6);
  const reset = db.requeueJob(job.jobId, { resetAttempts: true });
  assert.equal(reset.ok, true);
  assert.equal(reset.job.attempts, 0);
  assert.equal(reset.job.state, 'pending');
  assert.equal(db.claimJob('extract', { streamKey: 'chat-a' }).jobId, job.jobId);

  // A pending job that is still backing off becomes immediately claimable too.
  const waiting = db.enqueueJob({ type: 'summarize', streamKey: 'chat-b' });
  db.claimJob('summarize', { streamKey: 'chat-b' });
  db.failJob(waiting.jobId, '等待重试', { retryDelayMs: 600_000 });
  assert.equal(db.claimJob('summarize', { streamKey: 'chat-b' }), null);
  const early = db.requeueJob(waiting.jobId);
  assert.equal(early.ok, true);
  assert.equal(early.job.nextRetryAt, null);
  assert.equal(db.claimJob('summarize', { streamKey: 'chat-b' }).jobId, waiting.jobId);
});

test('requeueJob refuses unknown and terminal jobs without throwing', async t => {
  const harness = createHarness(t);
  const db = await harness.open();

  assert.deepEqual(db.requeueJob('job_missing'), { ok: false, reason: 'job-not-found' });
  assert.deepEqual(db.requeueJob(), { ok: false, reason: 'job-not-found' });
  assert.equal(db.requeueJob('   ').ok, false);

  const done = db.enqueueJob({ type: 'extract', streamKey: 'chat-a' });
  db.claimJob('extract', { streamKey: 'chat-a' });
  db.completeJob(done.jobId);
  const refusedDone = db.requeueJob(done.jobId);
  assert.equal(refusedDone.ok, false);
  assert.match(refusedDone.reason, /job-not-requeueable:done/);

  const running = db.enqueueJob({ type: 'embed', streamKey: 'chat-a' });
  db.claimJob('embed', { streamKey: 'chat-a' });
  const refusedRunning = db.requeueJob(running.jobId);
  assert.equal(refusedRunning.ok, false);
  assert.match(refusedRunning.reason, /job-not-requeueable:running/);
  // Refusals must not disturb the queue.
  assert.equal(db.jobStats().running, 1);
  assert.equal(db.jobStats().done, 1);
});

test('requeueJob and resetStaleRunning recover crashed running jobs', async t => {
  const harness = createHarness(t);
  const db = await harness.open();

  // Nothing to sweep on a fresh queue.
  assert.deepEqual(db.resetStaleRunning(), { reset: 0 });

  // A job claimed 20 minutes ago is a crash leftover.
  const job = db.enqueueJob({ type: 'extract', streamKey: 'chat-a' });
  db.claimJob('extract', { streamKey: 'chat-a', now: Date.now() - 20 * 60 * 1000 });

  // allowRunning is opt-in: by default running stays protected.
  const refused = db.requeueJob(job.jobId);
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /job-not-requeueable:running/);

  const revived = db.requeueJob(job.jobId, { allowRunning: true });
  assert.equal(revived.ok, true);
  assert.equal(revived.job.state, 'pending');
  assert.equal(revived.job.nextRetryAt, null);
  assert.equal(revived.job.attempts, 0);

  // It can be claimed again; this run is fresh, so neither path may touch it.
  assert.equal(db.claimJob('extract', { streamKey: 'chat-a' }).jobId, job.jobId);
  assert.deepEqual(
    db.requeueJob(job.jobId, { allowRunning: true }),
    { ok: false, reason: 'job-running-not-stale' },
  );
  assert.deepEqual(db.resetStaleRunning(), { reset: 0 });
  assert.equal(db.jobs({ state: 'running' }).length, 1);

  // staleAfterMs can be tightened for tests or aggressive recovery.
  const immediate = db.requeueJob(job.jobId, { allowRunning: true, staleAfterMs: 0 });
  assert.equal(immediate.ok, true);
  assert.equal(immediate.job.state, 'pending');

  // The sweep resets crashed rows without counting a failure.
  const crashed = db.enqueueJob({ type: 'summarize', streamKey: 'chat-c' });
  db.claimJob('summarize', { streamKey: 'chat-c', now: Date.now() - 60 * 60 * 1000 });
  assert.equal(db.resetStaleRunning().reset, 1);
  const crashedRow = db.jobs({ type: 'summarize' }).find(row => row.jobId === crashed.jobId);
  assert.equal(crashedRow.state, 'pending');
  assert.equal(crashedRow.attempts, 0);
  assert.equal(crashedRow.nextRetryAt, null);
  assert.equal(db.jobs({ state: 'running' }).length, 0);

  // Idempotent: a second sweep finds nothing, and the job is claimable again.
  assert.deepEqual(db.resetStaleRunning(), { reset: 0 });
  assert.equal(db.claimJob('summarize', { streamKey: 'chat-c' }).jobId, crashed.jobId);
});

test('backup produces a standalone copy that opens and reads back', async t => {
  const harness = createHarness(t);
  const db = await harness.open();
  const record = await seedMemory(db, { value: '用户喜欢收集黑胶唱片', predicate: 'hobby' });
  await seedMemory(db, { value: '用户养了一只橘猫', predicate: 'pet' });

  const target = path.join(harness.dir, 'nested', "备份 'v1'.db");
  const backup = db.backup(target);
  assert.equal(backup.path, path.resolve(target));
  assert.ok(backup.bytes > 0);
  assert.equal(fs.existsSync(target), true);
  assert.equal(fs.existsSync(target + '-wal'), false);

  // Overwriting an older snapshot is allowed.
  const second = db.backup(target);
  assert.ok(second.bytes > 0);

  const copy = await openMemoryDatabase({ file: target });
  try {
    assert.equal(copy.schemaVersion(), SCHEMA_VERSION);
    assert.equal(copy.integrityCheck().ok, true);
    assert.equal(copy.stats().memories, 2);
    assert.equal(copy.getMemory(record.id).value, '用户喜欢收集黑胶唱片');
    assert.equal(copy.fullTextSearch({ userId: USER_ID, personaId: PERSONA_ID, query: '黑胶' }).length, 1);
  } finally {
    copy.close();
  }

  assert.throws(() => db.backup(''), /备份路径不能为空/);
  assert.throws(() => db.transaction(() => db.backup(path.join(harness.dir, 'txn.db'))), /事务/);
});

test('integrityCheck reports ok for a healthy database', async t => {
  const harness = createHarness(t);
  const db = await harness.open();
  await seedMemory(db);
  assert.deepEqual(db.integrityCheck(), { ok: true, messages: [] });
});

test('open-time integrity policy supports full, quick and skip', async t => {
  const harness = createHarness(t);

  const full = await harness.open();
  assert.equal(full.integrityMode, 'full');
  assert.ok(Number.isFinite(Date.parse(full.integrityCheckedAt)));
  const fullResult = full.integrityCheck();
  const quickResult = full.integrityCheck({ quick: true });
  assert.deepEqual(fullResult, { ok: true, messages: [] });
  assert.deepEqual(quickResult, { ok: true, messages: [] });
  assert.deepEqual(Object.keys(fullResult).sort(), Object.keys(quickResult).sort());
  full.close();

  const quick = await harness.open({ integrity: 'quick' });
  assert.equal(quick.integrityMode, 'quick');
  assert.ok(Number.isFinite(Date.parse(quick.integrityCheckedAt)));
  assert.deepEqual(quick.integrityCheck({ quick: true }), { ok: true, messages: [] });
  quick.close();

  const skipped = await harness.open({ integrity: 'skip' });
  assert.equal(skipped.integrityMode, 'skip');
  assert.equal(skipped.integrityCheckedAt, null);
  assert.equal(skipped.stats().integrityMode, 'skip');
  assert.equal(skipped.stats().integrityCheckedAt, null);
  assert.equal(skipped.insertMemory(draft({ value: '用户喜欢烤茶' })).inserted, true);
  // A manual check is still possible and fills the marker in.
  assert.deepEqual(skipped.integrityCheck({ quick: true }), { ok: true, messages: [] });
  assert.ok(Number.isFinite(Date.parse(skipped.integrityCheckedAt)));

  await assert.rejects(
    openMemoryDatabase({ file: path.join(harness.dir, 'other.db'), integrity: 'loose' }),
    /integrity 取值非法/,
  );
  // The default stays 'full' so existing callers keep the strong guarantee;
  // an empty value also means the default rather than an error.
  const blank = await harness.open({ integrity: '' });
  assert.equal(blank.integrityMode, 'full');
  blank.close();
});

test('vectors survive the BLOB round trip and pending lookups shrink', async t => {
  const harness = createHarness(t);
  const db = await harness.open();

  const first = await seedMemory(db, { value: '用户喜欢喝手冲咖啡' });
  const second = await seedMemory(db, { value: '用户喜欢喝冷萃咖啡' });

  const pendingBefore = db.pendingEmbeddings({ provider: 'local', model: 'hash-256' });
  assert.deepEqual(pendingBefore.map(row => row.id).sort(), [first.id, second.id].sort());

  const vector = new Float32Array([0.5, -0.25, 0.125, 1, -1]);
  db.putEmbedding(first.id, { provider: 'local', model: 'hash-256', dimensions: 5, vector });

  const stored = db.getEmbeddings({ provider: 'local', model: 'hash-256' });
  assert.equal(stored.length, 1);
  assert.equal(stored[0].memoryId, first.id);
  assert.equal(stored[0].dimensions, 5);
  assert.ok(stored[0].vector instanceof Float32Array);
  assert.deepEqual(Array.from(stored[0].vector), Array.from(vector));

  assert.deepEqual(db.pendingEmbeddings({ provider: 'local', model: 'hash-256' }).map(row => row.id), [second.id]);
  assert.deepEqual(db.pendingEmbeddings({ provider: 'remote', model: 'text-embedding-3-small' }).length, 2);

  // Upsert replaces the existing vector instead of duplicating the row.
  db.putEmbedding(first.id, { provider: 'local', model: 'hash-256', dimensions: 3, vector: new Float32Array([1, 2, 3]) });
  const replaced = db.getEmbeddings({ provider: 'local', model: 'hash-256' });
  assert.equal(replaced.length, 1);
  assert.equal(replaced[0].dimensions, 3);
  assert.deepEqual(Array.from(replaced[0].vector), [1, 2, 3]);

  assert.throws(() => db.putEmbedding(first.id, { provider: 'local', model: 'hash-256', dimensions: 9, vector: new Float32Array([1, 2, 3]) }), /维度不足/);
  assert.equal(db.clearEmbeddings('local'), 1);
  assert.equal(db.getEmbeddings({ provider: 'local', model: 'hash-256' }).length, 0);
});

test('pendingEmbeddings 按维度过滤，deleteEmbeddings 精确删除一组向量', async t => {
  const harness = createHarness(t);
  const db = await harness.open();

  const first = await seedMemory(db, { value: '用户喜欢喝手冲咖啡' });
  const second = await seedMemory(db, { value: '用户喜欢喝冷萃咖啡' });

  // 同名模型但维度不同：给了 dimensions 就必须重新补，不能因为同名就跳过。
  db.putEmbedding(first.id, { provider: 'remote', model: 'qwen-embed', dimensions: 256, vector: new Float32Array(256).fill(0.1) });
  db.putEmbedding(second.id, { provider: 'remote', model: 'qwen-embed', dimensions: 2560, vector: new Float32Array(2560).fill(0.1) });

  const wrongDim = db.pendingEmbeddings({ provider: 'remote', model: 'qwen-embed', dimensions: 2560 });
  assert.deepEqual(wrongDim.map(row => row.id), [first.id], '维度不符的那条必须仍然待补');

  const sameDim = db.pendingEmbeddings({ provider: 'remote', model: 'qwen-embed', dimensions: 2560 });
  assert.ok(!sameDim.some(row => row.id === second.id));

  // 不给 dimensions 时保持旧语义（只看 provider/model）。
  assert.deepEqual(db.pendingEmbeddings({ provider: 'remote', model: 'qwen-embed' }), []);

  // 精确删除：只动指定 provider/model，别的模型与记忆行不受影响。
  db.putEmbedding(first.id, { provider: 'local', model: 'hash-bigram-256', dimensions: 256, vector: new Float32Array(256).fill(0.2) });
  assert.equal(db.deleteEmbeddings({ provider: 'remote', model: 'qwen-embed' }), 2);
  assert.equal(db.getEmbeddings({ provider: 'remote', model: 'qwen-embed' }).length, 0);
  assert.equal(db.getEmbeddings({ provider: 'local', model: 'hash-bigram-256' }).length, 1);
  assert.ok(db.getMemory(first.id), '删向量不能删记忆');
  assert.throws(() => db.deleteEmbeddings({ provider: 'remote', model: '' }), /model/);
});

test('getEmbeddings returns exactly the requested memory ids', async t => {
  const harness = createHarness(t);
  const db = await harness.open();

  const first = await seedMemory(db, { value: '用户喜欢手冲咖啡' });
  const second = await seedMemory(db, { value: '用户喜欢冷萃咖啡' });
  const third = await seedMemory(db, { value: '用户喜欢虹吸咖啡' });
  const vector = new Float32Array([0.5, -0.25, 0.125]);
  for (const record of [first, second, third]) {
    db.putEmbedding(record.id, { provider: 'local', model: 'hash-256', dimensions: 3, vector });
  }
  // The same memory under another provider must not leak into a selection.
  db.putEmbedding(first.id, { provider: 'remote', model: 'text-embedding-3-small', dimensions: 2, vector: new Float32Array([1, 0]) });

  const allIds = [first.id, second.id, third.id].sort();
  const subset = db.getEmbeddings({ provider: 'local', model: 'hash-256', memoryIds: [third.id, first.id] });
  assert.deepEqual(subset.map(row => row.memoryId), [first.id, third.id].sort());
  assert.deepEqual(Array.from(subset[0].vector), [0.5, -0.25, 0.125]);

  const remote = db.getEmbeddings({ provider: 'remote', model: 'text-embedding-3-small', memoryIds: [first.id, second.id] });
  assert.deepEqual(remote.map(row => row.memoryId), [first.id]);
  assert.equal(remote[0].dimensions, 2);

  assert.equal(db.getEmbeddings({ provider: 'local', model: 'hash-256', memoryIds: [second.id] }).length, 1);
  assert.deepEqual(db.getEmbeddings({ provider: 'local', model: 'hash-256', memoryIds: ['mem_unknown'] }), []);
  assert.deepEqual(db.getEmbeddings({ provider: 'remote', model: 'other-model', memoryIds: [first.id] }), []);

  // limit caps the selection as well.
  const limited = db.getEmbeddings({ provider: 'local', model: 'hash-256', memoryIds: [first.id, second.id, third.id], limit: 2 });
  assert.equal(limited.length, 2);
  assert.deepEqual(limited.map(row => row.memoryId), allIds.slice(0, 2));

  // The unfiltered path keeps its bounded, memory_id-ordered behaviour.
  const all = db.getEmbeddings({ provider: 'local', model: 'hash-256' });
  assert.deepEqual(all.map(row => row.memoryId), allIds);
  assert.equal(db.getEmbeddings({ provider: 'local', model: 'hash-256', limit: 2 }).length, 2);
});

test('getEmbeddings handles empty and large id selections', async t => {
  const harness = createHarness(t);
  const db = await harness.open();

  assert.deepEqual(db.getEmbeddings({ provider: 'local', model: 'hash-256', memoryIds: [] }), []);
  assert.deepEqual(db.getEmbeddings({ provider: 'local', model: 'hash-256', memoryIds: [], limit: 10 }), []);
  assert.deepEqual(db.getEmbeddings({ memoryIds: [] }), []);
  assert.deepEqual(db.getEmbeddings({ provider: 'local', model: 'hash-256', memoryIds: ['', null, undefined] }), []);

  // 620 pointers cross a 500-id chunk boundary; every one must come back.
  const ids = Array.from({ length: 620 }, (_, index) => `mem_bulk_${String(index).padStart(4, '0')}`);
  const insert = db.handle.prepare(
    `INSERT INTO memory_embeddings (memory_id, provider, model, dimensions, vector, version, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)`,
  );
  const vector = new Float32Array([1, 0]);
  const blob = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
  const now = new Date().toISOString();
  db.transaction(() => {
    for (const id of ids) insert.run(id, 'local', 'hash-256', 2, blob, now);
  });

  const chunked = db.getEmbeddings({ provider: 'local', model: 'hash-256', memoryIds: ids });
  assert.equal(chunked.length, ids.length);
  assert.deepEqual(chunked.map(row => row.memoryId), ids);
  assert.equal(chunked[chunked.length - 1].dimensions, 2);

  const capped = db.getEmbeddings({ provider: 'local', model: 'hash-256', memoryIds: ids, limit: 7 });
  assert.equal(capped.length, 7);
  assert.deepEqual(capped.map(row => row.memoryId), ids.slice(0, 7));
  assert.equal(db.getEmbeddings({ provider: 'local', model: 'hash-256' }).length, 620);
});

test('an update without real changes keeps revision and timestamps', async t => {
  const harness = createHarness(t);
  const db = await harness.open();

  const record = await seedMemory(db, { value: '用户喜欢乌龙茶', predicate: 'tea', tags: ['饮品'] });
  const before = db.getMemory(record.id);

  const same = db.updateMemory(record.id, {
    value: '用户喜欢乌龙茶',
    content: '',
    confidence: before.confidence,
    importance: before.importance,
    mentionPolicy: before.mentionPolicy,
    status: before.status,
    predicate: 'tea',
    tags: ['饮品'],
    validTo: null,
  }, { reason: '无变化' });
  assert.equal(same.revision, before.revision);
  assert.equal(same.updatedAt, before.updatedAt);
  assert.deepEqual(same.tags, ['饮品']);
  assert.deepEqual(db.revisionsFor(record.id), []);

  // Unsupported keys are not changes either (§15 only accepts the listed fields).
  const unsupported = db.updateMemory(record.id, { subject: 'persona' });
  assert.equal(unsupported.revision, before.revision);
  assert.deepEqual(db.revisionsFor(record.id), []);

  // Exactly one changed column bumps revision exactly once.
  const changed = db.updateMemory(record.id, { confidence: 0.9 }, { reason: '提高置信度' });
  assert.equal(changed.revision, 2);
  assert.equal(changed.confidence, 0.9);
  assert.equal(db.revisionsFor(record.id).length, 1);
  assert.equal(db.revisionsFor(record.id)[0].reason, '提高置信度');

  // Repeating the same value after a real change stays a no-op.
  const repeated = db.updateMemory(record.id, { confidence: 0.9 });
  assert.equal(repeated.revision, 2);
  assert.equal(db.revisionsFor(record.id).length, 1);

  // Repeating a status write does not rewrite valid_to or add a revision.
  const retired = db.setStatus(record.id, 'retracted', { reason: '用户否认' });
  assert.equal(retired.status, 'retracted');
  assert.equal(retired.revision, 3);
  assert.ok(retired.validTo);
  const retiredAgain = db.setStatus(record.id, 'retracted', { reason: '重复' });
  assert.equal(retiredAgain.revision, 3);
  assert.equal(retiredAgain.validTo, retired.validTo);
  assert.equal(db.revisionsFor(record.id).length, 2);
});

test('changing memory text retires vectors and stale vectors are reportable', async t => {
  const harness = createHarness(t);
  const db = await harness.open();

  const tea = await seedMemory(db, { value: '用户喜欢乌龙茶', predicate: 'tea' });
  const coffee = await seedMemory(db, { value: '用户喜欢黑咖啡', predicate: 'coffee' });
  const third = await seedMemory(db, { value: '用户喜欢白茶', predicate: 'white_tea' });
  const renamed = await seedMemory(db, { value: '用户喜欢花茶', predicate: 'flower_tea' });

  const vector = new Float32Array([0.25, 0.5]);
  for (const record of [tea, coffee, third, renamed]) {
    db.putEmbedding(record.id, { provider: 'local', model: 'hash-256', dimensions: 2, vector });
  }

  // Freshly written vectors are not stale and nothing is pending.
  assert.deepEqual(db.staleEmbeddings({ provider: 'local', model: 'hash-256' }), []);
  assert.deepEqual(db.pendingEmbeddings({ provider: 'local', model: 'hash-256' }), []);

  // Rewriting the sentence retires its vector so the old wording cannot match.
  const updated = db.updateMemory(tea.id, { value: '用户喜欢黑咖啡' }, { reason: '用户更正' });
  assert.equal(updated.value, '用户喜欢黑咖啡');
  assert.deepEqual(db.getEmbeddings({ provider: 'local', model: 'hash-256', memoryIds: [tea.id] }), []);
  assert.equal(db.getEmbeddings({ provider: 'local', model: 'hash-256', memoryIds: [coffee.id] }).length, 1);
  assert.deepEqual(
    db.pendingEmbeddings({ provider: 'local', model: 'hash-256' }).map(row => row.id),
    [tea.id],
  );

  // content and predicate changes are textual as well.
  db.updateMemory(third.id, { content: '补充：只喝无糖的' });
  db.updateMemory(renamed.id, { predicate: 'herbal_tea' });
  assert.deepEqual(db.getEmbeddings({ provider: 'local', model: 'hash-256', memoryIds: [third.id] }), []);
  assert.deepEqual(db.getEmbeddings({ provider: 'local', model: 'hash-256', memoryIds: [renamed.id] }), []);

  // A metadata-only update keeps the vector but marks it stale by timestamp.
  db.updateMemory(coffee.id, { importance: 0.95 });
  assert.equal(db.getEmbeddings({ provider: 'local', model: 'hash-256', memoryIds: [coffee.id] }).length, 1);
  db.handle.prepare('UPDATE memory_embeddings SET created_at = ? WHERE memory_id = ? AND provider = ?')
    .run('2000-01-01T00:00:00.000Z', coffee.id, 'local');
  assert.deepEqual(db.staleEmbeddings({ provider: 'local', model: 'hash-256' }), [coffee.id]);
  assert.deepEqual(db.staleEmbeddings({ provider: 'other', model: 'hash-256' }), []);
  assert.deepEqual(db.staleEmbeddings(), [coffee.id]);

  // Re-embedding clears the stale flag; the lexical index stays independent.
  db.putEmbedding(tea.id, { provider: 'local', model: 'hash-256', dimensions: 2, vector });
  assert.equal(db.staleEmbeddings({ provider: 'local', model: 'hash-256' }).includes(tea.id), false);
  assert.deepEqual(db.rebuildSearchIndex(), { memories: 4 });
});

test('staleEmbeddings ignores retired rows unless asked', async t => {
  const harness = createHarness(t);
  const db = await harness.open();

  const confirmed = await seedMemory(db, { value: '用户喜欢岩茶' });
  const retired = await seedMemory(db, { value: '用户喜欢陈茶' });
  const vector = new Float32Array([0.1, 0.2]);
  db.putEmbedding(confirmed.id, { provider: 'local', model: 'hash-256', dimensions: 2, vector });
  db.putEmbedding(retired.id, { provider: 'local', model: 'hash-256', dimensions: 2, vector });
  // Pin the vector timestamps so "memory touched after embedding" is
  // deterministic instead of racing the millisecond clock.
  db.handle.prepare('UPDATE memory_embeddings SET created_at = ? WHERE memory_id = ?')
    .run('2000-01-01T00:00:00.000Z', retired.id);

  db.setStatus(retired.id, 'superseded', { reason: '被取代' });
  // The vector row survives the status change, but the default view is confirmed-only.
  assert.equal(db.getEmbeddings({ provider: 'local', model: 'hash-256', memoryIds: [retired.id] }).length, 1);
  assert.deepEqual(db.staleEmbeddings({ provider: 'local', model: 'hash-256' }), []);
  assert.deepEqual(
    db.staleEmbeddings({ provider: 'local', model: 'hash-256', statuses: ['superseded'] }),
    [retired.id],
  );
  assert.deepEqual(
    db.staleEmbeddings({ provider: 'local', model: 'hash-256', statuses: [] }),
    [retired.id],
  );

  // A confirmed row touched after its vector was written is still reported.
  db.updateMemory(confirmed.id, { importance: 0.99 });
  db.handle.prepare('UPDATE memory_embeddings SET created_at = ? WHERE memory_id = ? AND provider = ?')
    .run('2000-01-01T00:00:00.000Z', confirmed.id, 'local');
  assert.deepEqual(db.staleEmbeddings({ provider: 'local', model: 'hash-256' }), [confirmed.id]);
  assert.deepEqual(
    db.staleEmbeddings({ provider: 'local', model: 'hash-256', statuses: [] }).sort(),
    [confirmed.id, retired.id].sort(),
  );
});

test('evidence links, revisions, relations and wiki pages round trip', async t => {
  const harness = createHarness(t);
  const db = await harness.open();

  const event = db.appendEvent({
    eventKey: 'session-9:user:1',
    sessionId: 'session-9',
    seq: 1,
    role: 'user',
    sourceKind: 'desktop_conversation',
    occurredAt: '2026-03-02T08:00:00.000Z',
    content: '我其实对花粉过敏',
    userId: USER_ID,
    personaId: PERSONA_ID,
  });
  const record = await seedMemory(db, { value: '用户对花粉过敏', kind: 'profile', predicate: 'allergy' });

  db.addEvidence(record.id, event.sourceId, { evidenceKind: 'supports', confidence: 0.8 });
  db.addEvidence(record.id, event.sourceId, { evidenceKind: 'supports', confidence: 0.95 });
  const evidence = db.evidenceFor(record.id);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].sourceId, event.sourceId);
  assert.equal(evidence[0].role, 'user');
  assert.equal(evidence[0].occurredAt, '2026-03-02T08:00:00.000Z');
  assert.equal(evidence[0].content, '我其实对花粉过敏');
  assert.equal(evidence[0].confidence, 0.95);

  const revisionId = db.recordRevision({ oldId: '', newId: record.id, operation: 'insert', reason: '首次记录', actor: 'user' });
  assert.match(revisionId, /^rev_[0-9a-f]{20}$/);
  assert.equal(db.revisionsFor(record.id).length, 1);
  assert.equal(db.revisionsFor(record.id)[0].operation, 'insert');

  const relation = db.addRelation({ sourceRef: record.id, relation: 'related_to', targetRef: 'mem_other', confidence: 0.6 });
  assert.match(relation.relationId, /^rel_[0-9a-f]{20}$/);
  const again = db.addRelation({ sourceRef: record.id, relation: 'related_to', targetRef: 'mem_other', confidence: 0.9 });
  assert.equal(again.relationId, relation.relationId);
  assert.equal(again.confidence, 0.9);
  assert.equal(db.relationsFor(record.id).length, 1);
  assert.equal(db.relationsFor(record.id, 'related_to').length, 1);
  assert.equal(db.relationsFor(record.id, 'contradicts').length, 0);

  const page = db.upsertWikiPage({
    pageId: 'user-profile', scope: 'user_global', topic: '用户画像', path: 'user/profile.md',
    sourceRevision: 3, contentHash: 'abc123', status: 'compiled', notes: 'first',
  });
  assert.equal(page.sourceRevision, 3);
  assert.ok(page.compiledAt);
  const pageAgain = db.upsertWikiPage({
    pageId: 'user-profile', scope: 'user_global', topic: '用户画像', path: 'user/profile.md',
    sourceRevision: 4, contentHash: 'def456', status: 'compiled', notes: 'second',
  });
  assert.equal(pageAgain.sourceRevision, 4);
  assert.equal(pageAgain.contentHash, 'def456');
  assert.equal(db.wikiPage('user-profile').notes, 'second');
  assert.equal(db.wikiPage('missing'), null);
  db.upsertWikiPage({ pageId: 'relationship-march7', scope: 'user_persona', topic: '关系', path: 'relationships/march7-user.md' });
  assert.equal(db.listWikiPages().length, 2);
  assert.deepEqual(db.listWikiPages('user_global').map(item => item.pageId), ['user-profile']);
});

test('identity, persona and session bindings upsert instead of duplicating', async t => {
  const harness = createHarness(t);
  const db = await harness.open();

  const identity = db.upsertIdentity({ userId: USER_ID, displayName: '小明', platform: 'desktop', platformId: 'p-1' });
  assert.equal(identity.displayName, '小明');
  const renamed = db.upsertIdentity({ userId: USER_ID, displayName: '小明改' });
  assert.equal(renamed.displayName, '小明改');
  assert.equal(renamed.platform, 'desktop');
  assert.equal(db.handle.prepare('SELECT count(*) AS total FROM identities').get().total, 1);

  const persona = db.upsertPersona({ personaId: PERSONA_ID, displayName: '三月七', revision: 'r1' });
  assert.equal(persona.revision, 'r1');
  const personaAgain = db.upsertPersona({ personaId: PERSONA_ID, displayName: '三月七', personaRef: 'preset:memory' });
  assert.equal(personaAgain.revision, 'r1');
  assert.equal(personaAgain.personaRef, 'preset:memory');

  const bound = db.bindSession({ sessionId: 'session-1', userId: USER_ID, personaId: PERSONA_ID });
  assert.equal(bound.channel, 'desktop');
  assert.ok(bound.boundAt);
  const rebound = db.bindSession({ sessionId: 'session-1', userId: USER_ID, personaId: PERSONA_ID, worldId: 'world_one', channel: 'desktop' });
  assert.equal(rebound.worldId, 'world_one');
  assert.equal(rebound.boundAt, bound.boundAt);
  assert.equal(db.sessionBinding('session-1').worldId, 'world_one');
  assert.equal(db.sessionBinding('session-missing'), null);
});

test('listMemories and countMemories apply filters, limits and offsets', async t => {
  const harness = createHarness(t);
  const db = await harness.open();

  await seedMemory(db, { value: '用户喜欢猫', scope: 'user_global', kind: 'preference', predicate: 'pet' });
  await seedMemory(db, { value: '用户喜欢狗', scope: 'user_global', kind: 'preference', predicate: 'pet' });
  await seedMemory(db, { value: '三月七喜欢拍照', scope: 'persona_self', kind: 'bot_action', predicate: 'action' });
  await seedMemory(db, { value: '用户计划旅行', scope: 'user_global', kind: 'commitment', predicate: 'plan', status: 'pending' });

  assert.equal(db.countMemories({ userId: USER_ID, personaId: PERSONA_ID }), 4);
  assert.equal(db.countMemories({ userId: USER_ID, personaId: PERSONA_ID, scope: 'user_global' }), 3);
  assert.equal(db.countMemories({ userId: USER_ID, personaId: PERSONA_ID, kind: 'preference' }), 2);
  assert.equal(db.countMemories({ userId: USER_ID, personaId: PERSONA_ID, status: 'pending' }), 1);
  assert.equal(db.countMemories({ userId: USER_ID, personaId: PERSONA_ID, predicate: 'pet' }), 2);

  const globalRows = db.listMemories({ userId: USER_ID, personaId: PERSONA_ID, scope: 'user_global' });
  assert.equal(globalRows.length, 3);
  assert.equal(db.listMemories({ userId: USER_ID, personaId: PERSONA_ID, limit: 2 }).length, 2);
  const offsetRows = db.listMemories({ userId: USER_ID, personaId: PERSONA_ID, limit: 2, offset: 3 });
  assert.equal(offsetRows.length, 1);
  assert.throws(() => db.listMemories({}), /userId 不能为空/);

  const duplicates = db.findDuplicates({
    userId: USER_ID, personaId: PERSONA_ID, scope: 'user_global', subject: 'user', predicate: 'pet', value: '用户喜欢猫',
  });
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].value, '用户喜欢猫');
  assert.equal(db.findDuplicates({
    userId: USER_ID, personaId: PERSONA_ID, scope: 'user_global', subject: 'user', predicate: 'pet',
  }).length, 2);
  assert.equal(db.findDuplicates({
    userId: USER_ID, personaId: PERSONA_ID, scope: 'user_global', subject: 'user', predicate: 'pet', value: '用户喜欢兔子',
  }).length, 0);
});

test('rebuildSearchIndex restores FTS rows after index loss', async t => {
  const harness = createHarness(t);
  const db = await harness.open();

  const hike = await seedMemory(db, { value: '用户喜欢在周末去爬山' });
  await seedMemory(db, { value: '用户养了一只橘猫' });

  db.handle.exec('DELETE FROM memory_fts');
  assert.equal(db.handle.prepare('SELECT count(*) AS total FROM memory_fts').get().total, 0);
  assert.deepEqual(db.fullTextSearch({ userId: USER_ID, personaId: PERSONA_ID, query: '爬山' }), []);

  const rebuilt = db.rebuildSearchIndex();
  assert.equal(rebuilt.memories, 2);
  assert.equal(db.handle.prepare('SELECT count(*) AS total FROM memory_fts').get().total, 2);
  assert.deepEqual(db.fullTextSearch({ userId: USER_ID, personaId: PERSONA_ID, query: '爬山' }).map(hit => hit.id), [hike.id]);
});

test('stats aggregates the store and schemaVersion stays pinned', async t => {
  const harness = createHarness(t);
  const db = await harness.open();

  await seedMemory(db, { value: '用户喜欢猫' });
  await seedMemory(db, { value: '用户计划旅行', status: 'pending' });
  const record = await seedMemory(db, { value: '用户喜欢狗' });
  db.appendEvent({ eventKey: 'e1', role: 'user', sourceKind: 'desktop_conversation', content: '你好' });
  db.putEmbedding(record.id, { provider: 'local', model: 'hash', dimensions: 2, vector: new Float32Array([1, 0]) });
  db.enqueueJob({ type: 'extract' });
  db.upsertWikiPage({ pageId: 'p1', scope: 'user_global', topic: 't', path: 'p.md' });

  const stats = db.stats();
  assert.equal(stats.memories, 3);
  assert.equal(stats.confirmedMemories, 2);
  assert.equal(stats.pendingMemories, 1);
  assert.equal(stats.events, 1);
  assert.equal(stats.embeddings, 1);
  assert.equal(stats.jobs, 1);
  assert.equal(stats.wikiPages, 1);
  assert.equal(stats.schemaVersion, SCHEMA_VERSION);
  assert.equal(stats.file, path.resolve(harness.file));
  assert.equal(stats.integrityMode, 'full');
  assert.ok(Number.isFinite(Date.parse(stats.integrityCheckedAt)));
  assert.deepEqual(
    Object.keys(stats).sort(),
    [
      'confirmedMemories', 'embeddings', 'events', 'file', 'integrityCheckedAt', 'integrityMode',
      'jobs', 'memories', 'pendingMemories', 'schemaVersion', 'wikiPages',
    ],
  );

  assert.equal(db.meta('schemaVersion'), String(SCHEMA_VERSION));
  assert.equal(db.meta('missing'), null);
  assert.equal(db.setMeta('schemaVersion', String(SCHEMA_VERSION)), String(SCHEMA_VERSION));
});

test('MemoryDatabase is exported for type checks and degrades safely after close', async t => {
  const harness = createHarness(t);
  const db = await harness.open();
  assert.ok(db instanceof MemoryDatabase);

  db.close();
  db.close(); // idempotent
  assert.throws(() => db.getMemory('mem_any'), /已关闭/);
  assert.throws(() => db.integrityCheck(), /已关闭/);
});

test('management reads return newest first (memories by updated_at, events by occurred_at)', async t => {
  const harness = createHarness(t);
  const db = await harness.open();

  // 每次插入之间留出毫秒级间隔，保证 updated_at 严格递增。
  const oldest = await seedMemory(db, { predicate: 'order-a', value: '最早写入的一条记忆' });
  await new Promise(resolve => setTimeout(resolve, 8));
  const middle = await seedMemory(db, { predicate: 'order-b', value: '中间写入的一条记忆' });
  await new Promise(resolve => setTimeout(resolve, 8));
  const newest = await seedMemory(db, { predicate: 'order-c', value: '最新写入的一条记忆' });

  const byTime = db.listMemoriesByTime({ userId: USER_ID, personaId: PERSONA_ID, limit: 10 });
  assert.deepEqual(byTime.map(row => row.id), [newest.id, middle.id, oldest.id]);

  // 重要度优先的既有排序不受影响（召回与旧调用依赖它）。
  const byImportance = db.listMemories({ userId: USER_ID, personaId: PERSONA_ID, limit: 10 });
  assert.equal(byImportance.length, 3);

  // 时间线：倒序 + 键集游标只取更早的行。
  const stamps = ['2026-03-01T10:00:00.000Z', '2026-03-02T10:00:00.000Z', '2026-03-03T10:00:00.000Z'];
  for (const [index, at] of stamps.entries()) {
    db.appendEvent({
      eventKey: `order:${index}`,
      sessionId: 'order-session',
      seq: index + 1,
      role: 'user',
      sourceKind: 'desktop_conversation',
      occurredAt: at,
      content: `第 ${index} 条证据`,
      userId: USER_ID,
      personaId: PERSONA_ID,
    });
  }
  const newestFirst = db.recentEvents({ userId: USER_ID, personaId: PERSONA_ID, limit: 10 });
  assert.deepEqual(newestFirst.map(row => row.occurredAt), [...stamps].reverse());
  const olderOnly = db.recentEvents({
    userId: USER_ID, personaId: PERSONA_ID, beforeOccurredAt: stamps[1], limit: 10,
  });
  assert.deepEqual(olderOnly.map(row => row.occurredAt), [stamps[0]]);
});

