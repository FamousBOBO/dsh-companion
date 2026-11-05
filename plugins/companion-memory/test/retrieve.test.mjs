// Recall + injection rendering tests (CONTRACT.md §12, plan §7).
//
// Every test below is self contained: it creates its own temporary SQLite file and
// a local (offline, deterministic) embedder, and removes both in t.after — nothing
// here touches the network, the user's home/ data or the running desktop app.
//
// The ONE exception is the real corpus acceptance case ("真实库验收：… 10 条真实查询"):
// it reads the local `home/memory/companion-memory.db` read-only and asserts on the
// live archive, so it needs that file to exist on this machine. When the file is
// missing (fresh checkout, CI, another user's machine) the case skips itself with
// `t.skip` instead of failing.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { openMemoryDatabase } from '../lib/db.mjs';
import { createEmbeddingProvider, hashEmbedding } from '../lib/embed.mjs';
import { explainLine, recall, sectionFor } from '../lib/retrieve.mjs';
import {
  CONTEXT_HEADER,
  DEFAULT_BUDGET,
  HIDDEN_ENTRY_TYPE,
  renderContext,
  renderRecallResult,
} from '../lib/render.mjs';

const USER_ID = 'user_local';
const PERSONA_ID = 'march7';
const NOW = Date.parse('2026-03-07T12:00:00.000Z');
const VIEWER = Object.freeze({ userId: USER_ID, personaId: PERSONA_ID, worldId: '' });
const CONFIG = Object.freeze({ candidates: 32, topK: 8, rrfK: 60, mmrLambda: 0.72 });

// Every synthetic test owns a throwaway SQLite file plus a local (offline,
// deterministic) embedder and removes both in t.after. Nothing here touches the
// network, the real home/ data or the running desktop app.
async function createHarness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-retrieve-'));
  const file = path.join(dir, 'memory.db');
  const db = await openMemoryDatabase({ file });
  const embedder = await createEmbeddingProvider(
    { provider: 'local', dimensions: 256 },
    { now: () => NOW },
  );
  t.after(() => {
    try {
      db.close();
    } catch {
      // already closed by the test
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, file, db, embedder };
}

let sequence = 0;

/** Insert one memory and index its vector exactly like the engine does. */
function seed(ctx, overrides = {}) {
  sequence += 1;
  const record = ctx.db.insertMemory({
    scope: 'user_global',
    kind: 'fact',
    subject: 'user',
    predicate: `test:${sequence}`,
    value: `第 ${sequence} 条示例记忆`,
    userId: USER_ID,
    personaId: PERSONA_ID,
    worldId: '',
    confidence: 0.9,
    importance: 0.7,
    mentionPolicy: 'direct',
    realityLevel: 'explicit_user_statement',
    sourceKind: 'desktop_fact',
    occurredAt: '2026-03-01T08:00:00.000Z',
    ...overrides,
  }).record;
  const vector = hashEmbedding(record.searchText || record.value, {
    dimensions: ctx.embedder.dimensions,
  });
  ctx.db.putEmbedding(record.id, {
    provider: ctx.embedder.provider,
    model: ctx.embedder.model,
    dimensions: vector.length,
    vector,
  });
  return record;
}

/** Wrap the real store so individual methods can be replaced or broken. */
function stubDb(db, overrides = {}) {
  return {
    getMemory: id => db.getMemory(id),
    getEmbeddings: options => db.getEmbeddings(options),
    listMemories: filter => db.listMemories(filter),
    fullTextSearch: options => db.fullTextSearch(options),
    ...overrides,
  };
}

function ids(entries) {
  return entries.map(entry => entry.record.id);
}

test('改写问法召回同一条已确认事实（字面 + 向量双通道）', async t => {
  const ctx = await createHarness(t);
  const latte = seed(ctx, { value: '用户喜欢喝拿铁咖啡', kind: 'preference', importance: 0.85 });
  seed(ctx, { value: '用户对花生过敏' });
  seed(ctx, { value: '用户住在杭州' });

  // Paraphrase: different wording, same bigrams (coverage gate satisfied).
  const reworded = await recall({
    db: ctx.db,
    embedder: ctx.embedder,
    viewer: VIEWER,
    query: '喜欢喝拿铁',
    config: CONFIG,
    now: NOW,
  });
  assert.ok(reworded.entries.length >= 1, '改写问法必须至少召回一条');
  assert.equal(reworded.entries[0].record.id, latte.id, '最相关的那条必须排第一');
  assert.equal(reworded.entries[0].section, 'stable');
  assert.ok(reworded.entries[0].channels.includes('lexical'));
  assert.equal(reworded.explain.afterDedupe, reworded.entries.length);
  assert.ok(reworded.explain.channels.lexical >= 1);

  // Short paraphrase: strong vector overlap as well, so both channels agree.
  const short = await recall({
    db: ctx.db,
    embedder: ctx.embedder,
    viewer: VIEWER,
    query: '想喝拿铁',
    config: CONFIG,
    now: NOW,
  });
  assert.equal(short.entries[0].record.id, latte.id);
  assert.deepEqual([...short.entries[0].channels].sort(), ['lexical', 'semantic']);
  assert.equal(short.explain.backend, 'hybrid');
  assert.ok(short.explain.channels.semantic >= 1);
});

test('无关查询不会靠哈希碰撞混入记忆（本地向量噪声闸门）', async t => {
  const ctx = await createHarness(t);
  // This pair scores ≈ 0.22 on the local hash channel purely from collisions
  // while sharing no bigram, i.e. FTS does not match it either.
  seed(ctx, { value: '用户对花生过敏', kind: 'fact', importance: 0.95 });
  seed(ctx, { value: '用户喜欢喝拿铁咖啡', kind: 'preference' });

  const result = await recall({
    db: ctx.db,
    embedder: ctx.embedder,
    viewer: VIEWER,
    query: '我电脑有点卡',
    config: CONFIG,
    now: NOW,
  });

  assert.deepEqual(result.entries, [], '不相关的内容宁可不注入');
  assert.equal(result.explain.backend, 'none');
  assert.ok(result.explain.filteredReasons['semantic-no-overlap'] >= 2);
  assert.equal(renderContext({ entries: result.entries }), '');
});

test('短查询也不会被单个哈希碰撞带偏（重合闸门 + 余弦闸门）', async t => {
  const ctx = await createHarness(t);
  const sensitive = seed(ctx, {
    value: '用户提过一段不愿被主动提起的经历：住院手术',
    kind: 'event',
    mentionPolicy: 'avoid_unless_asked',
    importance: 0.9,
  });
  const plan = seed(ctx, { value: '约定周末一起整理上次旅行的照片', kind: 'commitment' });

  const result = await recall({
    db: ctx.db,
    embedder: ctx.embedder,
    viewer: VIEWER,
    query: '住院手术',
    config: CONFIG,
    now: NOW,
  });

  const found = ids(result.entries);
  assert.ok(found.includes(sensitive.id));
  assert.ok(!found.includes(plan.id), '没有共享词元时不得靠碰撞混入');
  assert.ok(!renderContext({ entries: result.entries }).includes('住院手术'));
});

test('跨 user / persona / world 的记录不会被召回', async t => {
  const ctx = await createHarness(t);
  const mine = seed(ctx, { value: '用户喜欢喝拿铁咖啡', kind: 'preference' });
  const otherUser = seed(ctx, { value: '用户喜欢喝拿铁咖啡', userId: 'user_other' });
  const otherPersona = seed(ctx, { value: '用户喜欢喝拿铁咖啡', personaId: 'other_persona' });
  const otherWorld = seed(ctx, {
    value: '用户在骑士世界喜欢喝拿铁咖啡',
    scope: 'roleplay_world',
    worldId: 'world_knight',
    realityLevel: 'roleplay_fiction',
    mentionPolicy: 'soft_echo',
  });

  const result = await recall({
    db: ctx.db,
    embedder: ctx.embedder,
    viewer: VIEWER,
    query: '拿铁咖啡',
    config: CONFIG,
    now: NOW,
  });

  const found = ids(result.entries);
  assert.ok(found.includes(mine.id));
  assert.ok(!found.includes(otherUser.id), '别的用户不可见');
  assert.ok(!found.includes(otherPersona.id), '别的角色不可见');
  assert.ok(!found.includes(otherWorld.id), '剧情世界在现实视图不可见');

  // Inside the world, reality rows stay visible but the other world stays out.
  const inWorld = await recall({
    db: ctx.db,
    embedder: ctx.embedder,
    viewer: { userId: USER_ID, personaId: PERSONA_ID, worldId: 'world_knight' },
    query: '拿铁咖啡',
    config: CONFIG,
    now: NOW,
  });
  assert.ok(ids(inWorld.entries).includes(otherWorld.id));
  assert.ok(ids(inWorld.entries).includes(mine.id));
});

test('存储层返回越权行时，policy 二次过滤仍然生效', async t => {
  const ctx = await createHarness(t);
  const mine = seed(ctx, { value: '用户喜欢喝拿铁咖啡', kind: 'preference' });
  const foreignUser = seed(ctx, { value: '用户喜欢喝拿铁咖啡', userId: 'user_other' });
  const foreignWorld = seed(ctx, {
    value: '用户喜欢喝拿铁咖啡',
    scope: 'roleplay_world',
    worldId: 'world_knight',
    realityLevel: 'roleplay_fiction',
  });
  const pending = seed(ctx, { value: '用户喜欢喝拿铁咖啡', status: 'pending' });
  const archived = seed(ctx, { value: '用户喜欢喝拿铁咖啡' });
  ctx.db.setStatus(archived.id, 'archived', { reason: 'test' });
  const everywhere = [mine, foreignUser, foreignWorld, pending, archived];
  // A deliberately leaky store: it ignores owner/world/status filtering entirely.
  const leaky = stubDb(ctx.db, {
    fullTextSearch: () => everywhere.map((record, index) => ({ id: record.id, score: index + 1 })),
    listMemories: () => everywhere,
  });

  const result = await recall({
    db: leaky,
    embedder: ctx.embedder,
    viewer: VIEWER,
    query: '拿铁咖啡',
    config: CONFIG,
    now: NOW,
  });

  assert.deepEqual(ids(result.entries), [mine.id]);
  assert.ok(result.explain.filteredReasons['scope-mismatch'] >= 2);
  assert.equal(result.explain.filteredReasons['status-pending'], 1);
  assert.equal(result.explain.filteredReasons['status-archived'], 1);
});

test('pending / archived / 过期 / 未生效记录不参与召回', async t => {
  const ctx = await createHarness(t);
  const confirmed = seed(ctx, { value: '用户养了一只橘猫' });
  const pending = seed(ctx, { value: '用户养了一只橘猫，名字叫团子', status: 'pending' });
  const archived = seed(ctx, { value: '用户养过一只橘猫' });
  ctx.db.setStatus(archived.id, 'archived', { reason: 'test' });
  const expired = seed(ctx, { value: '用户养了一只橘猫，后来送人了', validTo: '2026-02-01T00:00:00.000Z' });
  const future = seed(ctx, { value: '用户计划养一只橘猫', validFrom: '2026-06-01T00:00:00.000Z' });

  const result = await recall({
    db: ctx.db,
    embedder: ctx.embedder,
    viewer: VIEWER,
    query: '橘猫',
    config: CONFIG,
    now: NOW,
  });

  const found = ids(result.entries);
  assert.ok(found.includes(confirmed.id));
  assert.ok(!found.includes(pending.id), '待确认记录不进普通召回');
  assert.ok(!found.includes(archived.id), '归档记录不进召回');
  assert.ok(!found.includes(expired.id), '过期记录不进召回');
  assert.ok(!found.includes(future.id), '尚未生效的记录不进召回');
  // pending/archived are already dropped by the SQL status filter; the validity
  // window is only enforced by policy, so those two reasons must be visible.
  assert.equal(result.explain.filteredReasons.expired, 1);
  assert.equal(result.explain.filteredReasons['not-yet-valid'], 1);
});

test('空查询只返回最近的高重要度 confirmed 记录（不超过 topK）', async t => {
  const ctx = await createHarness(t);
  const seeded = [];
  for (let index = 0; index < 12; index += 1) {
    seeded.push(seed(ctx, {
      value: `示例记忆第${index}条`,
      importance: 0.3 + index * 0.05,
      updatedAt: `2026-03-0${(index % 5) + 1}T08:00:00.000Z`,
    }));
  }
  const pendingTop = seed(ctx, { value: '待确认的高重要度记忆', importance: 0.99, status: 'pending' });
  const archivedTop = seed(ctx, { value: '已归档的高重要度记忆', importance: 0.98 });
  ctx.db.setStatus(archivedTop.id, 'archived', { reason: 'test' });

  const result = await recall({
    db: ctx.db,
    embedder: ctx.embedder,
    viewer: VIEWER,
    query: '   ',
    config: { ...CONFIG, topK: 5 },
    now: NOW,
  });

  assert.equal(result.explain.backend, 'recent');
  assert.equal(result.entries.length, 5, '空查询不得倒出整个库');
  const importances = result.entries.map(entry => entry.record.importance);
  assert.deepEqual(importances, [...importances].sort((left, right) => right - left));
  assert.equal(result.entries[0].record.importance, seeded[11].importance);
  const found = ids(result.entries);
  assert.ok(!found.includes(pendingTop.id));
  assert.ok(!found.includes(archivedTop.id));
  for (const entry of result.entries) assert.equal(entry.record.status, 'confirmed');
});

test('注入文本严格不超过预算，且逐行 JSON 保持既有格式', async t => {
  const ctx = await createHarness(t);
  for (let index = 0; index < 24; index += 1) {
    seed(ctx, {
      value: `用户偏好条目${index}：` + '需要记住的偏好细节'.repeat(12),
      kind: index % 4 === 0 ? 'relationship' : 'preference',
      scope: index % 4 === 0 ? 'user_persona' : 'user_global',
      importance: 0.5 + (index % 5) * 0.05,
    });
  }
  const result = await recall({
    db: ctx.db,
    embedder: ctx.embedder,
    viewer: VIEWER,
    query: '用户偏好条目',
    config: { ...CONFIG, topK: 20 },
    now: NOW,
  });
  assert.ok(result.entries.length > 3);

  const text = renderContext({ entries: result.entries, budget: DEFAULT_BUDGET });
  assert.ok(text.length <= DEFAULT_BUDGET, `注入长度 ${text.length} 超过预算 ${DEFAULT_BUDGET}`);
  assert.ok(text.startsWith(CONTEXT_HEADER), '抬头必须与既有注入一致');
  const lines = text.slice(CONTEXT_HEADER.length + 1).split('\n');
  assert.ok(lines.length >= 2);
  for (const line of lines) {
    const item = JSON.parse(line);
    assert.deepEqual(Object.keys(item), ['id', 'type', 'reality', 'at', 'policy', 'value']);
    assert.ok(typeof item.id === 'string' && item.id.startsWith('mem_'));
    assert.ok(!JSON.stringify(item).includes('\n'));
  }

  // A smaller budget must also hold, and the header is never truncated away.
  for (const budget of [2400, 1200, 600]) {
    const smaller = renderContext({ entries: result.entries, budget });
    assert.ok(smaller.length <= budget, `预算 ${budget} 被突破：${smaller.length}`);
    if (smaller) assert.ok(smaller.startsWith(CONTEXT_HEADER));
  }
  assert.ok(renderContext({ entries: result.entries, budget: 400 }).length <= 400);
  assert.equal(renderContext({ entries: [], budget: DEFAULT_BUDGET }), '', '没有内容时返回空串');
  assert.equal(renderContext({ entries: result.entries, budget: 0 }), '');

  // Optional identity line shares the same budget and JSON shape.
  const withIdentity = renderContext({ entries: [], identityText: '你是三月七，陪用户聊天。' });
  assert.ok(withIdentity.startsWith(CONTEXT_HEADER));
  const identityLine = JSON.parse(withIdentity.slice(CONTEXT_HEADER.length + 1));
  assert.equal(identityLine.type, 'identity');
  assert.equal(identityLine.value, '你是三月七，陪用户聊天。');
  assert.ok(withIdentity.length <= DEFAULT_BUDGET);
});

test('avoid_unless_asked 只输出占位，不泄露正文', async t => {
  const ctx = await createHarness(t);
  const secret = '用户提过一段不愿被主动提起的经历：旧伤疤和转学';
  const sensitive = seed(ctx, {
    value: secret,
    kind: 'event',
    mentionPolicy: 'avoid_unless_asked',
    importance: 0.9,
  });
  seed(ctx, { value: '用户喜欢喝拿铁咖啡', kind: 'preference' });

  const result = await recall({
    db: ctx.db,
    embedder: ctx.embedder,
    viewer: VIEWER,
    query: '旧伤疤',
    config: CONFIG,
    now: NOW,
  });
  assert.ok(ids(result.entries).includes(sensitive.id), '敏感记录本身可被召回');

  const text = renderContext({ entries: result.entries, budget: DEFAULT_BUDGET });
  assert.ok(!text.includes('旧伤疤'), '注入正文不得包含敏感内容');
  assert.ok(!text.includes('转学'), '注入正文不得包含敏感内容');
  assert.ok(!text.includes('不愿被主动提起'));
  const hiddenLines = text.split('\n').filter(line => line.includes(`"${HIDDEN_ENTRY_TYPE}"`));
  assert.equal(hiddenLines.length, 1);
  const placeholder = JSON.parse(hiddenLines[0]);
  assert.deepEqual(Object.keys(placeholder), ['id', 'type', 'reality', 'policy']);
  assert.equal(placeholder.id, sensitive.id);
  assert.equal(placeholder.policy, 'avoid_unless_asked');

  const payload = renderRecallResult({ entries: result.entries, limit: 8 });
  const item = payload.entries.find(entry => entry.id === sensitive.id);
  assert.ok(item, '工具结果仍然告知这条记录存在');
  assert.equal(item.value, '');
  assert.equal(item.hidden, true);
  assert.equal(item.policy, 'avoid_unless_asked');
  assert.ok(!JSON.stringify(payload).includes('旧伤疤'));
  assert.equal(payload.hiddenCount, 1);
});

test('FTS 表达式异常时降级到向量通道且不抛', async t => {
  const ctx = await createHarness(t);
  const latte = seed(ctx, { value: '用户喜欢喝拿铁咖啡', kind: 'preference' });
  const brokenFts = stubDb(ctx.db, {
    fullTextSearch: () => {
      throw new Error('fts5: syntax error near "OR"');
    },
  });

  const result = await recall({
    db: brokenFts,
    embedder: ctx.embedder,
    viewer: VIEWER,
    query: '拿铁咖啡',
    config: CONFIG,
    now: NOW,
  });

  assert.ok(result.entries.length >= 1, '字面通道坏了，向量通道必须顶上');
  assert.equal(result.entries[0].record.id, latte.id);
  assert.equal(result.explain.backend, 'semantic');
  assert.equal(result.explain.filteredReasons['lexical-error'], 1);
  assert.equal(result.explain.channels.lexical, 0);
});

test('embedder 抛错时降级到字面通道且不抛', async t => {
  const ctx = await createHarness(t);
  const latte = seed(ctx, { value: '用户喜欢喝拿铁咖啡', kind: 'preference' });
  const brokenEmbedder = {
    provider: 'local',
    model: 'broken-model',
    dimensions: 256,
    enabled: () => true,
    embed: async () => {
      throw new Error('模型不可用');
    },
  };

  const result = await recall({
    db: ctx.db,
    embedder: brokenEmbedder,
    viewer: VIEWER,
    query: '拿铁咖啡',
    config: CONFIG,
    now: NOW,
  });

  assert.equal(result.entries[0].record.id, latte.id);
  assert.equal(result.explain.backend, 'lexical');
  assert.equal(result.explain.filteredReasons['semantic-error'], 1);
});

test('向量缺失时按字面通道返回，且记录缺失原因', async t => {
  const ctx = await createHarness(t);
  const withoutVector = seed(ctx, { value: '用户喜欢喝拿铁咖啡', kind: 'preference' });
  ctx.db.clearEmbeddings();

  const result = await recall({
    db: ctx.db,
    embedder: ctx.embedder,
    viewer: VIEWER,
    query: '拿铁咖啡',
    config: CONFIG,
    now: NOW,
  });

  assert.equal(result.entries[0].record.id, withoutVector.id);
  assert.equal(result.explain.backend, 'lexical');
  assert.ok(result.explain.filteredReasons['missing-vector'] >= 1);
});

test('向量读取只按候选 id 批量查询，不扫全表（新签名）', async t => {
  const ctx = await createHarness(t);
  const seeded = ['甲', '乙', '丙'].map(suffix => seed(ctx, {
    value: `用户偏好示例${suffix}`,
    kind: 'preference',
  }));
  const calls = [];
  const spy = stubDb(ctx.db, {
    getEmbeddings: options => {
      calls.push({
        ...options,
        memoryIds: Array.isArray(options?.memoryIds) ? [...options.memoryIds] : undefined,
      });
      return ctx.db.getEmbeddings(options);
    },
  });

  const result = await recall({
    db: spy,
    embedder: ctx.embedder,
    viewer: VIEWER,
    query: '偏好示例',
    config: CONFIG,
    now: NOW,
  });

  assert.ok(result.explain.channels.semantic >= 1, '向量必须真的读到了');
  const byId = calls.filter(call => Array.isArray(call.memoryIds) && call.memoryIds.length);
  assert.equal(byId.length, 1, '候选向量只读一次');
  assert.deepEqual(
    [...byId[0].memoryIds].sort(),
    seeded.map(record => record.id).sort(),
    '只请求候选集里的 3 个 id',
  );
  assert.equal(byId[0].limit, byId[0].memoryIds.length, 'limit 与候选数一致');
  assert.ok(
    calls.every(call => Array.isArray(call.memoryIds)),
    '不得回退成不带 memoryIds 的全表读取',
  );
});

test('getEmbeddings 老签名（忽略 memoryIds）时回退到有界读取，向量不丢', async t => {
  const ctx = await createHarness(t);
  seed(ctx, { value: '用户偏好示例甲', kind: 'preference' });
  seed(ctx, { value: '用户偏好示例乙', kind: 'preference' });
  const calls = [];
  const legacy = stubDb(ctx.db, {
    getEmbeddings: options => {
      calls.push({ ...options });
      // A store from before the update: `memoryIds` is unknown, so it always
      // answers with a window of its own.
      return ctx.db.getEmbeddings({
        provider: options?.provider,
        model: options?.model,
        limit: 1000,
      });
    },
  });

  const result = await recall({
    db: legacy,
    embedder: ctx.embedder,
    viewer: VIEWER,
    query: '偏好示例',
    config: CONFIG,
    now: NOW,
  });

  assert.ok(result.explain.channels.semantic >= 1, '回退路径必须仍能读到向量');
  assert.equal(result.explain.filteredReasons['vector-error'], undefined, '老签名不算错误');
  assert.ok(calls.some(call => !Array.isArray(call.memoryIds)), '必须发生一次有界全表读取');
  assert.equal(calls[0].limit, 1, '能力探测只取一行');
});

test('getEmbeddings 抛错时只走字面通道且不抛', async t => {
  const ctx = await createHarness(t);
  const latte = seed(ctx, { value: '用户喜欢喝拿铁咖啡', kind: 'preference' });
  const broken = stubDb(ctx.db, {
    getEmbeddings: () => {
      throw new Error('向量表损坏');
    },
  });

  const result = await recall({
    db: broken,
    embedder: ctx.embedder,
    viewer: VIEWER,
    query: '拿铁咖啡',
    config: CONFIG,
    now: NOW,
  });

  assert.equal(result.entries[0].record.id, latte.id);
  assert.equal(result.explain.backend, 'lexical');
  assert.equal(result.explain.filteredReasons['vector-error'], 1);
});

test('无关问题不注入无关旧记忆（匹配覆盖闸门，合成库 20 条噪声）', async t => {
  const ctx = await createHarness(t);
  const relevant = seed(ctx, { value: '用户喜欢喝茶，尤其是茉莉花茶', kind: 'preference' });
  // 20 rows that each match the query on exactly one low information bigram
  // ("喜欢") and therefore look like a rank-1 hit to bm25 + RRF.
  for (let index = 0; index < 20; index += 1) {
    seed(ctx, {
      value: `三月七喜欢第${index}种天气，还喜欢记录当天的心情`,
      kind: 'note',
      importance: 0.9 - index * 0.01,
    });
  }

  const result = await recall({
    db: ctx.db,
    embedder: ctx.embedder,
    viewer: VIEWER,
    query: '我喜欢喝什么',
    config: CONFIG,
    now: NOW,
  });

  assert.equal(result.entries.length, 1, '只应留下真正相关的那一条');
  assert.equal(result.entries[0].record.id, relevant.id);
  assert.ok(result.explain.filteredReasons['low-coverage'] >= 20, '每条噪声都要被覆盖率闸门拦下');
  const text = renderContext({ entries: result.entries });
  assert.ok(text.includes('茉莉花茶'));
  assert.ok(!text.includes('天气'), '无关旧记忆不得进入注入');
});

test('完全无关的问题返回空结果，不退回 recent 池', async t => {
  const ctx = await createHarness(t);
  // Every row matches the query on a cheap bigram ("问题"/"完全"), none shares the
  // real subject; the old behaviour injected the least bad three.
  for (let index = 0; index < 12; index += 1) {
    seed(ctx, {
      value: `第${index}次对话摘要：用户讨论了日程安排和完全不同的生活琐事，问题不大`,
      kind: 'summary',
      scope: 'user_persona',
      realityLevel: 'imported_summary',
      importance: 0.8,
    });
  }

  const result = await recall({
    db: ctx.db,
    embedder: ctx.embedder,
    viewer: VIEWER,
    query: '完全无关的量子力学问题',
    config: CONFIG,
    now: NOW,
  });

  assert.deepEqual(result.entries, []);
  assert.equal(result.explain.backend, 'none');
  assert.ok(result.explain.filteredReasons['low-coverage'] >= 1);
  assert.equal(renderContext({ entries: result.entries }), '', '无关问题必须注入空字符串');
});

// Real corpus acceptance (plan §10.1). The database is opened read-only and the
// case is skipped when a checkout has no home/memory/companion-memory.db, so the
// suite stays runnable on a clean machine and never writes user data.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL_DB = path.resolve(HERE, '../../../home/memory/companion-memory.db');
const REAL_VIEWER = Object.freeze({ userId: '1429709395', personaId: 'march7', worldId: '' });

test('真实库验收：无关问题不注入，10 条真实查询的精度与召回', async t => {
  if (!fs.existsSync(REAL_DB)) {
    t.skip('真实记忆库不存在，跳过');
    return;
  }
  const db = await openMemoryDatabase({ file: REAL_DB, readOnly: true });
  const embedder = await createEmbeddingProvider({ provider: 'local', dimensions: 256 });
  t.after(() => {
    try {
      db.close();
    } catch {
      // already closed
    }
  });
  const run = query => recall({
    db,
    embedder,
    viewer: REAL_VIEWER,
    query,
    config: { ...CONFIG, topK: 8 },
    now: Date.now(),
  });
  const first = result => result.entries[0]?.record?.value ?? '';

  // 1-2. Nothing in the archive is about this at all: OR-ed bigrams used to return
  //      "least bad" summaries; the df-weighted coverage gate must return nothing.
  for (const query of ['完全无关的量子力学问题', '量子力学']) {
    const unrelated = await run(query);
    assert.deepEqual(unrelated.entries, [], `${query} 不得注入任何旧记忆`);
    assert.equal(unrelated.explain.backend, 'none');
    assert.equal(renderContext({ entries: unrelated.entries }), '');
  }
  const unrelated = await run('完全无关的量子力学问题');
  assert.ok(unrelated.explain.filteredReasons['low-coverage'] >= 1);
  assert.ok(unrelated.explain.coverage.best < unrelated.explain.coverage.floor, '最佳覆盖度必须低于闸门');

  // 3. A concrete proper noun: recalled, top row really is about it.
  const duck = await run('北京烤鸭');
  assert.ok(duck.entries.length >= 1 && duck.entries.length <= 3);
  assert.ok(first(duck).includes('北京烤鸭'));

  // 4. The same topic phrased as a long natural question (this used to return 0).
  const duckLong = await run('我们上次聊到的那个北京的烤鸭');
  assert.ok(duckLong.entries.length >= 1, '长自然问句必须能召回');
  assert.ok(first(duckLong).includes('北京烤鸭'));

  // 5. Long question about a nightly habit. NOTE: the row that literally says
  //    "熬夜" scores coverage 0.0869, while the best unrelated row reaches 0.0985,
  //    so no floor keeps unrelated questions empty *and* promotes that row; the
  //    gate returns the late-night summaries instead (measured, reported).
  const lateNight = await run('我最近是不是经常熬夜到很晚');
  assert.ok(lateNight.entries.length >= 1, '作息类问题必须能召回');
  assert.ok(
    lateNight.entries.some(entry => /熬夜|作息|很晚/.test(entry.record.value)),
    '召回内容必须与作息相关',
  );

  // 6. The archive has no drink record; a short question still returns summaries.
  const drink = await run('你还记得我平时喜欢喝什么吗');
  assert.ok(drink.entries.length >= 1);
  assert.ok(['summary', 'fact', 'profile', 'preference'].includes(drink.entries[0].record.kind));

  // 7-8. Single keyword topics.
  const friedChicken = await run('炸鸡');
  assert.ok(friedChicken.entries.length >= 1);
  assert.ok(first(friedChicken).includes('炸鸡'));
  const noodles = await run('螺蛳粉');
  assert.ok(noodles.entries.length >= 1);
  assert.ok(first(noodles).includes('螺蛳粉'));

  // 9. Two-word topic about the relationship.
  const love = await run('关系 女朋友');
  assert.ok(love.entries.length >= 1);
  assert.ok(first(love).includes('恋爱') || first(love).includes('女朋友'));

  // 10. Persona + behaviour topic.
  const persona = await run('三月七 主动消息');
  assert.ok(persona.entries.length >= 1);
});

test('P1-7：远端降级批次关闭语义通道，不读远端键也不比哈希向量', async t => {
  const ctx = await createHarness(t);
  const latte = seed(ctx, { value: '用户喜欢喝拿铁咖啡', kind: 'preference' });
  // A stale neural index entry for the same row: it must never be compared with a
  // degraded (hash) query vector.
  ctx.db.putEmbedding(latte.id, {
    provider: 'remote',
    model: 'text-embedding-3-small',
    dimensions: 256,
    vector: hashEmbedding('拿铁咖啡', { dimensions: 256 }),
  });
  const calls = [];
  // Configured target is remote, but the batch reports a degraded local fallback.
  const degraded = {
    provider: 'remote',
    model: 'text-embedding-3-small',
    dimensions: 256,
    enabled: () => true,
    health: () => ({ provider: 'remote', model: 'text-embedding-3-small', degradedCount: 1 }),
    embed: async texts => {
      const vectors = texts.map(value => hashEmbedding(value, { dimensions: 256 }));
      Object.defineProperty(vectors, 'source', {
        value: { provider: 'local', model: 'hash-bigram-256', dimensions: 256, degraded: true },
        enumerable: false,
      });
      return vectors;
    },
  };
  const spy = stubDb(ctx.db, {
    getEmbeddings: options => {
      calls.push({ ...options });
      return ctx.db.getEmbeddings(options);
    },
  });

  const result = await recall({
    db: spy,
    embedder: degraded,
    viewer: VIEWER,
    query: '拿铁咖啡',
    config: CONFIG,
    now: NOW,
  });

  assert.equal(result.explain.channels.semantic, 0, '降级批次不得进入向量通道');
  assert.equal(result.explain.backend, 'lexical');
  assert.equal(result.explain.filteredReasons['semantic-degraded'], 1);
  assert.deepEqual(calls, [], '不得用配置身份（remote 键）去读向量');
  assert.equal(result.entries[0].record.id, latte.id, '字面通道照常召回');
  assert.deepEqual(result.entries[0].channels, ['lexical']);
});

test('P1-7：source.provider=local 时继续走本地双闸门', async t => {
  const ctx = await createHarness(t);
  seed(ctx, { value: '用户喜欢喝拿铁咖啡', kind: 'preference' });
  seed(ctx, { value: '用户对花生过敏', kind: 'fact', importance: 0.95 });
  const calls = [];
  const local = {
    // Configured identity is deliberately "remote" to prove the batch wins.
    provider: 'remote',
    model: 'text-embedding-3-small',
    dimensions: 256,
    enabled: () => true,
    embed: async texts => {
      const vectors = texts.map(value => hashEmbedding(value, { dimensions: 256 }));
      Object.defineProperty(vectors, 'source', {
        value: { provider: 'local', model: 'hash-bigram-256', dimensions: 256, degraded: false },
        enumerable: false,
      });
      return vectors;
    },
  };
  const spy = stubDb(ctx.db, {
    getEmbeddings: options => {
      calls.push({ ...options });
      return ctx.db.getEmbeddings(options);
    },
  });

  const strong = await recall({
    db: spy, embedder: local, viewer: VIEWER, query: '想喝拿铁', config: CONFIG, now: NOW,
  });
  assert.ok(strong.explain.channels.semantic >= 1, '共享词元 + 余弦过闸 → 允许');
  assert.ok(calls.length >= 1);
  assert.deepEqual(
    calls.filter(call => Array.isArray(call.memoryIds) && call.memoryIds.length)
      .map(call => `${call.provider}/${call.model}`),
    ['local/hash-bigram-256'],
    '索引键必须取自 batch.source，而不是配置的 remote',
  );

  // Collision-only query: the local gates still reject it.
  const collision = await recall({
    db: spy, embedder: local, viewer: VIEWER, query: '我电脑有点卡', config: CONFIG, now: NOW,
  });
  assert.equal(collision.explain.channels.semantic, 0);
  assert.deepEqual(collision.entries, []);
});

test('P1-7：source.provider=remote 时只受 minScore 约束并读 remote 键', async t => {
  const ctx = await createHarness(t);
  const latte = seed(ctx, { value: '用户喜欢喝拿铁咖啡', kind: 'preference' });
  const queryText = '我电脑有点卡';
  // A neural index row under the remote key. The vector is built from the query so
  // the cosine is exactly 1: what is under test is *which gate identity* applies
  // (minScore only), not vector realism.
  ctx.db.putEmbedding(latte.id, {
    provider: 'remote',
    model: 'text-embedding-3-small',
    dimensions: 256,
    vector: hashEmbedding(queryText, { dimensions: 256 }),
  });
  const calls = [];
  const remote = {
    provider: 'remote',
    model: 'text-embedding-3-small',
    dimensions: 256,
    enabled: () => true,
    embed: async texts => {
      const vectors = texts.map(value => hashEmbedding(value, { dimensions: 256 }));
      Object.defineProperty(vectors, 'source', {
        value: {
          provider: 'remote', model: 'text-embedding-3-small', dimensions: 256, degraded: false,
        },
        enumerable: false,
      });
      return vectors;
    },
  };
  const spy = stubDb(ctx.db, {
    getEmbeddings: options => {
      calls.push({ ...options });
      return ctx.db.getEmbeddings(options);
    },
  });

  // A query with no shared bigram at all: the local hash gates would reject this,
  // a real model's minScore-only path must admit it (proving the gate switched).
  const result = await recall({
    db: spy,
    embedder: remote,
    viewer: VIEWER,
    query: queryText,
    config: CONFIG,
    now: NOW,
  });

  assert.ok(result.explain.channels.semantic >= 1, '远程源不套用本地重合/余弦闸门');
  assert.equal(result.explain.backend, 'semantic');
  assert.equal(result.explain.filteredReasons['semantic-no-overlap'], undefined);
  assert.deepEqual(
    calls.filter(call => Array.isArray(call.memoryIds) && call.memoryIds.length)
      .map(call => `${call.provider}/${call.model}`),
    ['remote/text-embedding-3-small'],
    'getEmbeddings 必须收到 remote 索引键',
  );
});

test('所有通道同时故障时返回空结果，绝不抛', async t => {
  const ctx = await createHarness(t);
  seed(ctx, { value: '用户喜欢喝拿铁咖啡', kind: 'preference' });
  const broken = {
    getMemory: () => {
      throw new Error('getMemory 失败');
    },
    getEmbeddings: () => {
      throw new Error('getEmbeddings 失败');
    },
    listMemories: () => {
      throw new Error('listMemories 失败');
    },
    fullTextSearch: () => {
      throw new Error('fullTextSearch 失败');
    },
  };
  const throwingEmbedder = {
    provider: 'local',
    model: 'broken',
    dimensions: 256,
    enabled: () => true,
    embed: async () => {
      throw new Error('不可用');
    },
  };

  const result = await recall({
    db: broken,
    embedder: throwingEmbedder,
    viewer: VIEWER,
    query: '拿铁咖啡',
    config: CONFIG,
    now: NOW,
  });

  assert.deepEqual(result.entries, []);
  assert.equal(result.explain.backend, 'none');
  assert.equal(renderContext({ entries: result.entries }), '');
});

test('调用参数缺失或非法时安全返回', async () => {
  const noDatabase = await recall({});
  assert.deepEqual(noDatabase.entries, []);
  assert.equal(noDatabase.explain.backend, 'none');
  assert.equal(noDatabase.explain.filteredReasons['no-database'], 1);

  const noViewer = await recall({ db: {}, viewer: null, query: '拿铁' });
  assert.deepEqual(noViewer.entries, []);
  assert.equal(noViewer.explain.filteredReasons['no-viewer'], 1);

  const halfViewer = await recall({ db: {}, viewer: { userId: 'u1' }, query: '拿铁' });
  assert.deepEqual(halfViewer.entries, []);
});

test('空库安全', async t => {
  const ctx = await createHarness(t);

  const text = await recall({
    db: ctx.db,
    embedder: ctx.embedder,
    viewer: VIEWER,
    query: '拿铁咖啡',
    config: CONFIG,
    now: NOW,
  });
  assert.deepEqual(text.entries, []);
  assert.equal(text.explain.backend, 'none');
  assert.equal(text.explain.afterDedupe, 0);
  assert.equal(renderContext({ entries: text.entries }), '');

  const emptyQuery = await recall({
    db: ctx.db,
    embedder: ctx.embedder,
    viewer: VIEWER,
    query: '',
    config: CONFIG,
    now: NOW,
  });
  assert.deepEqual(emptyQuery.entries, []);
  assert.equal(emptyQuery.explain.backend, 'none');

  const payload = renderRecallResult({ entries: emptyQuery.entries });
  assert.equal(payload.total, 0);
  assert.equal(payload.returned, 0);
  assert.equal(payload.truncated, false);
  assert.deepEqual(payload.entries, []);
});

test('近重复条目只注入一次（MMR 去重）', async t => {
  const ctx = await createHarness(t);
  seed(ctx, { value: '用户喜欢喝拿铁咖啡', kind: 'preference', importance: 0.9 });
  seed(ctx, { value: '用户喜欢喝拿铁咖啡', kind: 'preference', importance: 0.5 });
  seed(ctx, { value: '用户喜欢喝美式咖啡', kind: 'preference', importance: 0.6 });

  const result = await recall({
    db: ctx.db,
    embedder: ctx.embedder,
    viewer: VIEWER,
    query: '咖啡',
    config: CONFIG,
    now: NOW,
  });

  const values = result.entries.map(entry => entry.record.value);
  assert.equal(values.filter(value => value === '用户喜欢喝拿铁咖啡').length, 1, '同文重复只留一条');
  assert.ok(values.includes('用户喜欢喝美式咖啡'), '语义不同项必须保留');
  assert.ok(result.explain.afterDedupe <= result.explain.afterFilter);
});

test('分节映射覆盖 stable / related / current', async t => {
  const ctx = await createHarness(t);
  const stable = seed(ctx, { scope: 'user_global', kind: 'preference', value: '用户偏好示例甲' });
  const related = seed(ctx, {
    scope: 'user_persona',
    kind: 'relationship',
    value: '用户偏好示例乙',
    mentionPolicy: 'soft_echo',
  });
  const current = seed(ctx, {
    scope: 'session_recent',
    kind: 'note',
    value: '用户偏好示例丙',
    occurredAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
  });

  const result = await recall({
    db: ctx.db,
    embedder: ctx.embedder,
    viewer: VIEWER,
    query: '偏好示例',
    config: CONFIG,
    now: NOW,
  });
  const sections = new Map(result.entries.map(entry => [entry.record.id, entry.section]));
  assert.equal(sections.get(stable.id), 'stable');
  assert.equal(sections.get(related.id), 'related');
  assert.equal(sections.get(current.id), 'current');
  assert.equal(sectionFor(null), 'related');
  assert.equal(sectionFor({ scope: 'persona_self', kind: 'bot_action' }), 'related');
});

test('explain 与 explainLine 不含任何正文', async t => {
  const ctx = await createHarness(t);
  seed(ctx, { value: '用户喜欢喝拿铁咖啡', kind: 'preference' });
  seed(ctx, { value: '用户的秘密代号是蓝鲸', kind: 'note' });

  const result = await recall({
    db: ctx.db,
    embedder: ctx.embedder,
    viewer: VIEWER,
    query: '拿铁咖啡',
    config: CONFIG,
    now: NOW,
  });

  const serialized = JSON.stringify(result.explain);
  for (const needle of ['拿铁', '咖啡', '蓝鲸', '用户', '秘密']) {
    assert.ok(!serialized.includes(needle), `explain 泄露了正文片段：${needle}`);
  }
  assert.deepEqual(
    Object.keys(result.explain).sort(),
    ['afterDedupe', 'afterFilter', 'backend', 'candidates', 'channels', 'coverage', 'elapsedMs', 'filteredReasons'],
  );
  assert.deepEqual(Object.keys(result.explain.channels).sort(), ['lexical', 'semantic']);
  assert.deepEqual(
    Object.keys(result.explain.coverage).sort(),
    ['best', 'floor', 'kept', 'terms', 'total'],
  );
  assert.ok(Number.isFinite(result.explain.elapsedMs) && result.explain.elapsedMs >= 0);

  const line = explainLine(result.explain);
  assert.ok(!line.includes('\n'), 'explainLine 必须是单行');
  assert.ok(line.length <= 600);
  const parsed = JSON.parse(line);
  assert.equal(parsed.backend, result.explain.backend);

  // A poisoned explain object must not smuggle text or newlines into the log.
  const hostile = explainLine({
    backend: 'hybrid\n{"value":"秘密"}',
    filteredReasons: { 'a b': 2, 'status-pending': 3, OK: 4 },
    candidates: 'NaN',
  });
  assert.ok(!hostile.includes('\n'));
  assert.ok(!hostile.includes('秘密'));
  const hostileParsed = JSON.parse(hostile);
  assert.deepEqual(Object.keys(hostileParsed.filteredReasons), ['status-pending']);
  assert.equal(hostileParsed.candidates, 0);
  assert.ok(/^[a-z-]*$/.test(hostileParsed.backend));
});

test('semanticEnabled=false 关闭向量通道，semanticMinScore 可调余弦门槛', async t => {
  const ctx = await createHarness(t);
  const latte = seed(ctx, { value: '用户喜欢喝拿铁咖啡', kind: 'preference' });

  const noSemantic = await recall({
    db: ctx.db,
    embedder: ctx.embedder,
    viewer: VIEWER,
    query: '想喝拿铁',
    config: { ...CONFIG, semanticEnabled: false },
    now: NOW,
  });
  assert.equal(noSemantic.entries[0].record.id, latte.id);
  assert.equal(noSemantic.explain.channels.semantic, 0);
  assert.equal(noSemantic.explain.backend, 'lexical');

  // Default local floor (0.3) admits the genuinely overlapping record …
  const defaulted = await recall({
    db: ctx.db,
    embedder: ctx.embedder,
    viewer: VIEWER,
    query: '想喝拿铁',
    config: CONFIG,
    now: NOW,
  });
  assert.equal(defaulted.explain.channels.semantic, 1);

  // … a stricter operator threshold rejects it, a looser one still admits it.
  const strict = await recall({
    db: ctx.db,
    embedder: ctx.embedder,
    viewer: VIEWER,
    query: '想喝拿铁',
    config: { ...CONFIG, semanticMinScore: 0.9 },
    now: NOW,
  });
  assert.equal(strict.explain.channels.semantic, 0);
  assert.equal(strict.explain.backend, 'lexical');

  const loosened = await recall({
    db: ctx.db,
    embedder: ctx.embedder,
    viewer: VIEWER,
    query: '想喝拿铁',
    config: { ...CONFIG, semanticMinScore: 0.05 },
    now: NOW,
  });
  assert.equal(loosened.explain.channels.semantic, 1);
});

test('renderRecallResult 给出总数、截断标记与来源字段', async t => {
  const ctx = await createHarness(t);
  for (const suffix of ['甲', '乙', '丙']) {
    seed(ctx, { value: `用户示例记忆${suffix}`, kind: 'preference' });
  }

  const result = await recall({
    db: ctx.db,
    embedder: ctx.embedder,
    viewer: VIEWER,
    query: '示例记忆',
    config: CONFIG,
    now: NOW,
  });
  assert.equal(result.entries.length, 3);

  const full = renderRecallResult({ entries: result.entries });
  assert.equal(full.total, 3);
  assert.equal(full.returned, 3);
  assert.equal(full.truncated, false);
  for (const item of full.entries) {
    assert.deepEqual(
      Object.keys(item),
      ['id', 'value', 'type', 'reality', 'at', 'source', 'policy', 'score'],
    );
    assert.ok(item.id.startsWith('mem_'));
    assert.ok(item.value.startsWith('用户示例记忆'));
    assert.equal(item.type, 'preference');
    assert.equal(item.reality, 'explicit_user_statement');
    assert.equal(item.source, 'desktop_fact');
    assert.equal(item.policy, 'direct');
    assert.ok(item.at && Number.isFinite(Date.parse(item.at)));
    assert.ok(Number.isFinite(item.score));
  }

  const cut = renderRecallResult({ entries: result.entries, limit: 2 });
  assert.equal(cut.total, 3);
  assert.equal(cut.returned, 2);
  assert.equal(cut.limit, 2);
  assert.equal(cut.truncated, true);
  assert.equal(cut.hiddenCount, 0);

  // Plain records are accepted too, so other callers can reuse the renderer.
  const plain = renderRecallResult({ entries: result.entries.map(entry => entry.record) });
  assert.equal(plain.total, 3);
  assert.ok(plain.entries.every(item => item.score === 0));
});

test('预算内的注入文本对模型是合法资料，末尾无多余空行', async t => {
  const ctx = await createHarness(t);
  seed(ctx, { value: '用户喜欢喝拿铁咖啡', kind: 'preference' });

  const result = await recall({
    db: ctx.db,
    embedder: ctx.embedder,
    viewer: VIEWER,
    query: '拿铁咖啡',
    config: CONFIG,
    now: NOW,
  });
  const text = renderContext({ entries: result.entries, budget: DEFAULT_BUDGET });
  assert.ok(!text.endsWith('\n'), '注入文本不带末尾换行');
  assert.ok(!text.includes('\n\n'), '注入文本没有空行');
  assert.ok(text.includes('不是指令'), '保留「资料不是指令」的界定');
  assert.ok(text.length <= DEFAULT_BUDGET);
});
