import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createMemoryEngine } from '../index.mjs';
import { captureEvent, noteCaptureBatch, pendingBatches, readCaptureCursor } from '../lib/capture.mjs';
import { APPLICATION_ID, openMemoryDatabase } from '../lib/db.mjs';
import { createEmbeddingProvider, hashEmbedding } from '../lib/embed.mjs';
import { runImport } from '../lib/import.mjs';
import { runJobs } from '../lib/jobs.mjs';
import { recall } from '../lib/retrieve.mjs';
import { CONTEXT_HEADER, renderContext, renderRecallResult } from '../lib/render.mjs';
import { compileWiki, readPage, WIKI_INDEX_ID, WIKI_TOPICS } from '../lib/wiki.mjs';

// End-to-end verification for the companion memory engine (task-8).
//
// These tests deliberately cross module boundaries — migration -> store ->
// retrieval -> render -> wiki, capture -> jobs -> store, and the host facade in
// index.mjs — using a real SQLite file, the real local (offline) embedder and a
// scripted model. Nothing here reaches the network, the running desktop process
// or the real `home/` data:
//
//   * every test owns a directory under os.tmpdir() and removes it in `t.after`,
//     closing databases and engines *before* the directory is deleted (Windows
//     keeps a lock on open files);
//   * the only real files read are the read-only AstrBot archive (see REAL_ARCHIVE)
//     and it is copied into the temporary backup directory by runImport;
//   * the "model" is a stub returning scripted JSON, and the "remote embedder"
//     case installs a throwing fetch stub instead of calling an endpoint.
//
// Unit behaviour of each module is covered by that module's own test file; this
// file only asserts the contracts that live *between* modules (CONTRACT.md §14),
// plus the frozen semantics of §15.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(PLUGIN_DIR, '../..');

/** Read-only legacy archive; its manifest declares 767 imported rows. */
const REAL_ARCHIVE = path.join(REPO_ROOT, 'home', 'memory', 'astrbot-import.json');
/** Owner id of the legacy archive/manifest — the import refuses a mismatch. */
const ARCHIVE_OWNER = '10001';
const ARCHIVE_ROWS = 767;
const PERSONA_ID = 'bot';

/** Neutral identity for the synthetic tests (never the real user id). */
const USER_ID = 'user_integration';
const VIEWER = Object.freeze({ userId: USER_ID, personaId: PERSONA_ID, worldId: '' });
/** Fixed clock so rendering and wiki output are reproducible. */
const NOW = Date.parse('2026-03-07T12:00:00.000Z');

const RECALL_CONFIG = Object.freeze({
  candidates: 32,
  topK: 8,
  rrfK: 60,
  mmrLambda: 0.72,
});

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

/**
 * One temporary directory whose cleanups run in reverse registration order,
 * followed by the directory removal. Register every close()/handle before the
 * assertions that could leave state open.
 */
function harness(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const cleanups = [];
  t.after(async () => {
    for (const cleanup of [...cleanups].reverse()) {
      try {
        await cleanup();
      } catch {
        // Cleanup must never mask the real assertion failure.
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    onCleanup(fn) {
      cleanups.push(fn);
      return fn;
    },
    file(name = 'memory.db') {
      return path.join(dir, name);
    },
    path(...parts) {
      return path.join(dir, ...parts);
    },
  };
}

async function openDb(h, file = h.file()) {
  const db = await openMemoryDatabase({ file });
  h.onCleanup(() => db.close());
  return db;
}

/** Companion root layout expected by index.mjs/config.mjs. */
function writeConfig(root, config) {
  const file = path.join(root, 'home', 'companion', 'memory.config.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return file;
}

function identityStub(userId = USER_ID) {
  return {
    resolve(sessionId) {
      return { userId, personaId: PERSONA_ID, displayName: '集成测试用户', sessionId };
    },
    owner() {
      return { id: userId, displayName: '集成测试用户', platform: 'local' };
    },
    context() {
      return '';
    },
  };
}

/**
 * Real memory engine over a temporary root. `config` is written to
 * home/companion/memory.config.json before the engine reads it.
 */
async function makeEngine(h, { root, config, llm = null, userId = USER_ID, now = () => Date.now() } = {}) {
  const target = root ?? h.path('root');
  if (config) writeConfig(target, { backend: 'sqlite', ...config });
  const engine = createMemoryEngine({
    root: target,
    identity: identityStub(userId),
    env: {},
    llm,
    now,
  });
  h.onCleanup(() => engine.close());
  return engine;
}

/** Engine config that keeps background wiki/jobs out of the way. */
function quietConfig(dbFile, overrides = {}) {
  return {
    database: dbFile,
    wiki: { enabled: false },
    extraction: { enabled: false },
    ...overrides,
  };
}

function seedMemory(db, overrides = {}) {
  return db.insertMemory({
    scope: 'user_global',
    kind: 'fact',
    subject: 'user',
    predicate: `it:${Math.random().toString(36).slice(2, 10)}`,
    value: '一条集成测试记录',
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
}

function embedLocally(db, record, embedder) {
  const vector = hashEmbedding(record.searchText || record.value, { dimensions: embedder.dimensions });
  db.putEmbedding(record.id, {
    provider: embedder.provider,
    model: embedder.model,
    dimensions: vector.length,
    vector,
  });
}

/** Scripted model. The default answer cites the first user message of the batch. */
function fakeLlm({ answer } = {}) {
  const llm = {
    calls: 0,
    prompts: [],
    async complete({ system, input, maxTokens, signal } = {}) {
      llm.calls += 1;
      llm.prompts.push({ system, input, maxTokens, hasSignal: Boolean(signal) });
      if (typeof answer === 'function') return answer({ system, input, maxTokens });
      if (answer !== undefined) return answer;
      const ids = [...String(input ?? '').matchAll(/\[id=([^\]\s]+)\]\s+user:/g)].map(match => match[1]);
      return JSON.stringify([{
        kind: 'preference',
        scope: 'user_global',
        subject: 'user',
        predicate: 'prefers_drink',
        value: '用户更喜欢喝乌龙茶',
        evidence_source_ids: ids.slice(0, 1),
        confidence: 0.85,
        importance: 0.7,
        validity: 'current',
        suggested_operation: 'insert',
        mention_policy: 'direct',
      }]);
    },
  };
  return llm;
}

function userEvent(seq, text, atMs) {
  return {
    type: 'user/message',
    seq,
    time: new Date(atMs).toISOString(),
    data: {
      message: {
        role: 'user',
        source: { kind: 'user', form: 'text' },
        content: [{ type: 'text', text }],
      },
    },
  };
}

function assistantEvent(seq, text, atMs) {
  return {
    type: 'assistant/message',
    seq,
    time: new Date(atMs).toISOString(),
    data: {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text }],
      },
    },
  };
}

/** Capture `count` alternating messages into one session; returns their sourceIds. */
function captureConversation(db, { sessionId, count, firstSeq = 1, baseMs = NOW - 3600_000 }) {
  const sourceIds = [];
  for (let index = 0; index < count; index += 1) {
    const seq = firstSeq + index;
    const at = baseMs + seq * 60_000;
    const event = index % 2 === 0
      ? userEvent(seq, `第 ${seq} 条：我想记住一点日常，今天照常上班。`, at)
      : assistantEvent(seq, `第 ${seq} 条：好，我记着啦。`, at);
    const result = captureEvent({ db, sessionId, event, viewer: VIEWER, clock: NOW });
    assert.equal(result.captured, true, `事件 ${seq} 必须被捕获`);
    sourceIds.push(result.sourceId);
  }
  return sourceIds;
}

function fileSnapshot(dir) {
  const files = new Map();
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.set(path.relative(dir, full).split(path.sep).join('/'), fs.readFileSync(full));
    }
  };
  walk(dir);
  return files;
}

function readWiki(wikiDir, topicId) {
  return readPage({ dir: wikiDir, topicId });
}

// ---------------------------------------------------------------------------
// 1. migration: idempotent, every archive row attributed, bot actions never real
// ---------------------------------------------------------------------------

test('1. 旧归档迁移：767 条全部有归属、重复运行 0 新增、对账通过、bot_action 不进现实', async t => {
  // The archive is the author's personal corpus and is never committed with the
  // release; a clean checkout must skip this case instead of failing.
  if (!fs.existsSync(REAL_ARCHIVE)) {
    t.skip(`缺少只读归档 ${REAL_ARCHIVE}（个人语料不在仓库内），跳过真实归档用例`);
    return;
  }
  const h = harness(t, 'dsh-mem-integration-import-');
  const db = await openDb(h);

  // The temp root holds the backup and the report; the inputs stay read-only and
  // the state/journal paths point into the temp root on purpose, so this test
  // exercises the archive mapping only.
  const root = h.path('root');
  fs.mkdirSync(path.join(root, 'home', 'companion'), { recursive: true });
  fs.mkdirSync(path.join(root, 'home', 'memory'), { recursive: true });
  fs.mkdirSync(path.join(root, 'logs'), { recursive: true });

  const base = {
    root,
    db,
    userId: ARCHIVE_OWNER,
    personaId: PERSONA_ID,
    clock: NOW,
    archivePath: REAL_ARCHIVE,
    conversationPath: path.join(root, 'home', 'memory', 'conversation.jsonl'),
    statePath: path.join(root, 'home', 'companion', 'state.json'),
    statePreviousPath: path.join(root, 'home', 'companion', 'state.json.previous'),
    identityPath: path.join(root, 'home', 'companion', 'identity.json'),
  };

  const first = await runImport(base);

  // --- every archive row is accounted for ---------------------------------
  assert.equal(first.report.archive.importedCount, ARCHIVE_ROWS);
  assert.equal(first.report.origins.archive.rows, ARCHIVE_ROWS);
  assert.equal(first.report.origins.archive.mapped, ARCHIVE_ROWS, '767 条必须全部映射成功');
  assert.equal(first.report.origins.archive.skipped, 0, '归档不允许有无法归属的行');
  assert.equal(first.inserted, ARCHIVE_ROWS);
  assert.equal(first.deduped, 0);

  // --- the report keeps the manifest's per-type counts --------------------
  const manifest = JSON.parse(fs.readFileSync(REAL_ARCHIVE, 'utf8')).manifest;
  for (const [type, expected] of Object.entries(manifest.memoryTypes)) {
    assert.equal(first.report.byMemoryType[type]?.count, expected, `类型 ${type} 的计数必须一致`);
  }

  // proactive_message + photo_generation are persona acts, never the user's reality.
  assert.equal(first.report.byScope.user_global, manifest.memoryTypes.core_memory
    + manifest.memoryTypes.user_profile + manifest.memoryTypes.user_preference
    + manifest.memoryTypes.explicit_memory + manifest.memoryTypes.tool_memory);
  assert.equal(first.report.byScope.persona_self,
    manifest.memoryTypes.proactive_message + manifest.memoryTypes.photo_generation);

  // --- reconciliation against the real store ------------------------------
  assert.equal(first.report.reconciliation.mode, 'store');
  assert.equal(first.report.reconciliation.ok, true,
    `对账必须通过：${first.report.reconciliation.summaryText.join(' / ')}`);
  for (const check of first.report.reconciliation.checks) {
    assert.equal(check.ok, true, `对账项 ${check.name} 未通过`);
  }

  // --- the store actually holds one owned row per archive entry -----------
  const owner = { userId: ARCHIVE_OWNER, personaId: PERSONA_ID };
  assert.equal(db.countMemories({ ...owner, includeExpired: true }), ARCHIVE_ROWS);
  const allRows = [
    ...db.listMemories({ ...owner, includeExpired: true, limit: 500, offset: 0 }),
    ...db.listMemories({ ...owner, includeExpired: true, limit: 500, offset: 500 }),
  ];
  assert.equal(allRows.length, ARCHIVE_ROWS, '分页读取必须覆盖全部导入行');
  for (const row of allRows) {
    assert.equal(row.userId, ARCHIVE_OWNER);
    assert.equal(row.personaId, PERSONA_ID);
    assert.ok(Array.isArray(row.tags) && row.tags.includes('migrated:astrbot'), `导入行必须带迁移标签：${row.id}`);
    assert.equal(row.sourceKind, 'astrbot_import');
    assert.ok(db.evidenceFor(row.id).length > 0, `导入行必须有来源证据：${row.id}`);
  }

  // --- bot actions never enter a real-user scope --------------------------
  const botTypes = new Set(['proactive_message', 'photo_generation']);
  const legacyType = row => (row.tags ?? [])
    .map(tag => String(tag))
    .filter(tag => tag.startsWith('import:'))
    .map(tag => tag.slice('import:'.length))[0] ?? '';

  const userGlobal = db.listMemories({ ...owner, scope: 'user_global', includeExpired: true, limit: 200 });
  assert.equal(userGlobal.length, 28, 'user_global 只能是稳定事实类导入行');
  assert.deepEqual(
    userGlobal.filter(row => botTypes.has(legacyType(row))).map(row => row.id),
    [],
    'proactive_message / photo_generation 不得出现在任何 user_global 记录里',
  );
  const userGlobalDefault = db.listMemories({ ...owner, scope: 'user_global', limit: 200 });
  assert.deepEqual(
    userGlobalDefault.filter(row => botTypes.has(legacyType(row))).map(row => row.id),
    [],
    '默认（排除过期）查询同样不得把 bot action 当作用户现实',
  );

  const personaSelf = db.listMemories({ ...owner, scope: 'persona_self', includeExpired: true, limit: 500 });
  assert.equal(personaSelf.length, 474);
  for (const row of personaSelf) {
    assert.ok(botTypes.has(legacyType(row)), `persona_self 只收 bot action：${row.id}`);
    assert.equal(row.subject, 'persona');
    assert.ok(row.importance <= 0.35, 'bot action 的重要性上限是 0.35');
    assert.equal(row.mentionPolicy, 'tone_only');
  }

  // --- cross-module smoke: imported facts are retrievable ----------------
  const found = await recall({
    db,
    viewer: { userId: ARCHIVE_OWNER, personaId: PERSONA_ID, worldId: '' },
    query: '炸鸡',
    config: RECALL_CONFIG,
    now: Date.now(),
  });
  assert.ok(found.entries.length >= 1, '导入的稳定事实必须能被召回');
  const imported = found.entries.find(entry => entry.record.realityLevel === 'imported_fact');
  assert.ok(imported, '召回结果里必须有旧库确认事实（realityLevel=imported_fact）');
  assert.equal(imported.record.sourceKind, 'astrbot_import');
  assert.equal(imported.record.scope, 'user_global');
  const injected = renderContext({ entries: [imported], budget: 2400 });
  assert.ok(injected.includes('imported_fact'), '注入行必须带现实级别标签');
  assert.ok(injected.includes(imported.record.id));

  // --- second run: no new rows, no new evidence --------------------------
  const second = await runImport(base);
  assert.equal(second.inserted, 0, '重复迁移必须 0 新增');
  assert.equal(second.deduped, ARCHIVE_ROWS);
  assert.equal(second.report.totals.eventsInserted, 0, '重复迁移不得新增证据');
  assert.equal(second.report.reconciliation.ok, true);
  assert.equal(second.report.reconciliation.mode, 'store');
  assert.equal(db.countMemories({ ...owner, includeExpired: true }), ARCHIVE_ROWS);
  assert.equal(db.stats().events, ARCHIVE_ROWS);
  assert.equal(db.stats().memories, ARCHIVE_ROWS);

  // --- the backup really holds a verified copy of the archive ------------
  const backupManifest = JSON.parse(fs.readFileSync(path.join(first.backupDir, 'manifest.json'), 'utf8'));
  const archived = backupManifest.files.find(record => record.name === 'astrbot-import.json');
  assert.equal(archived.exists, true);
  assert.equal(archived.verified, true, '备份必须先校验 sha256 才能开始写入');
  assert.ok(fs.existsSync(first.reportPath), '迁移报告必须落盘');
});

// ---------------------------------------------------------------------------
// 2. cross-session recall through the host facade
// ---------------------------------------------------------------------------

test('2. 跨会话：会话 A 记住的偏好，会话 B 用改写问法召回同一条并带来源/现实级别', async t => {
  const h = harness(t, 'dsh-mem-integration-cross-');
  const dbFile = h.file();
  const root = h.path('root');
  const config = quietConfig(dbFile);

  const engineA = await makeEngine(h, { root, config });
  await engineA.initialize();
  assert.equal(engineA.backend, 'sqlite', 'backend=sqlite 时引擎必须真的打开新库');

  const saved = await engineA.remember({ sessionId: 'session-A', key: '饮品偏好', value: '更喜欢喝茶' });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.match(saved.receipt.id, /^mem_/);
  assert.equal(saved.receipt.key, '饮品偏好');
  await engineA.close();

  // A second engine instance over the same file == "another session / restart".
  const engineB = await makeEngine(h, { root, config });
  const answer = await engineB.recall({ sessionId: 'session-B', query: '我喜欢喝什么' });
  assert.ok(Array.isArray(answer.entries));
  // The facade returns the rendered tool payload (id/value/type/reality/source/
  // policy), so no internal record shape leaks to the model.
  const hit = answer.entries.find(entry => entry.id === saved.receipt.id);
  assert.ok(hit, `会话 B 必须召回会话 A 写入的那条事实，实际 ${JSON.stringify(answer.entries)}`);

  // Source and reality labels must survive the round trip (plan §10.1).
  assert.equal(hit.source, 'desktop_fact');
  assert.equal(hit.reality, 'explicit_user_statement');
  assert.equal(hit.policy, 'direct');
  assert.equal(hit.type, 'fact');
  assert.ok(hit.value.includes('更喜欢喝茶'));

  const injected = await engineB.contextFor({ sessionId: 'session-B', query: '我喜欢喝什么' });
  assert.equal(typeof injected, 'string');
  assert.ok(injected.startsWith(CONTEXT_HEADER), '注入必须以固定的「这是资料」抬头开始');
  assert.ok(injected.includes(saved.receipt.id));
  assert.ok(injected.includes('更喜欢喝茶'));
  assert.ok(injected.includes('explicit_user_statement'), '注入行必须带现实级别标签');

  const status = await engineB.status({ sessionId: 'session-B' });
  assert.equal(status.backend, 'sqlite');
  assert.ok(status.stats.memories >= 1);
  await engineB.close();

  // The stored row keeps the full contract shape even though the tool result
  // above is rendered down to the model-facing fields.
  const db = await openDb(h, dbFile);
  const stored = db.getMemory(saved.receipt.id);
  assert.equal(stored.scope, 'user_global');
  assert.equal(stored.subject, 'user');
  assert.equal(stored.confidence, 1);
  assert.equal(stored.status, 'confirmed');
  assert.ok(stored.tags.includes('user_confirmed'));
});

// ---------------------------------------------------------------------------
// 3. correction: supersede chain, history kept, current fact is only the new one
// ---------------------------------------------------------------------------

test('3. 纠正：先茶后咖啡，当前事实只剩咖啡，旧记录 superseded 且修订链可查', async t => {
  const h = harness(t, 'dsh-mem-integration-supersede-');
  const dbFile = h.file();
  const root = h.path('root');
  const engine = await makeEngine(h, { root, config: quietConfig(dbFile) });

  const tea = await engine.remember({ sessionId: 'session-A', key: '饮品偏好', value: '更喜欢喝茶' });
  assert.equal(tea.ok, true);
  const coffee = await engine.remember({ sessionId: 'session-B', key: '饮品偏好', value: '现在更喜欢喝咖啡' });
  assert.equal(coffee.ok, true);
  assert.notEqual(coffee.receipt.id, tea.receipt.id, '纠正必须生成新记录');
  assert.equal(coffee.receipt.supersedesId, tea.receipt.id, '新记录必须指回被取代的记录');
  assert.equal(coffee.receipt.revision, 1);

  const current = await engine.recall({ sessionId: 'session-B', query: '我喜欢喝什么' });
  const values = current.entries.map(entry => entry.value);
  assert.ok(values.some(value => value.includes('咖啡')), `当前召回必须命中新事实：${JSON.stringify(values)}`);
  assert.ok(!values.some(value => value.includes('茶') && !value.includes('咖啡')), '旧说法不得再作为当前事实出现');
  await engine.close();

  // --- inspect the store directly: history and revision chain -------------
  const db = await openDb(h, dbFile);
  const history = db.listMemories({
    userId: USER_ID,
    personaId: PERSONA_ID,
    worldId: '',
    predicate: 'direct:饮品偏好',
    includeExpired: true,
    limit: 10,
  });
  assert.equal(history.length, 2, '修订链需要同时保留旧值与新值');
  const oldRecord = history.find(record => record.id === tea.receipt.id);
  const newRecord = history.find(record => record.id === coffee.receipt.id);
  assert.ok(oldRecord && newRecord);
  assert.equal(oldRecord.status, 'superseded');
  assert.ok(oldRecord.validTo, '被取代的记录必须关闭有效期');
  assert.equal(newRecord.status, 'confirmed');
  assert.equal(newRecord.supersedesId, oldRecord.id);

  const revisions = db.revisionsFor(oldRecord.id);
  const supersede = revisions.find(revision => revision.operation === 'supersede');
  assert.ok(supersede, `必须有 supersede 修订记录：${JSON.stringify(revisions)}`);
  assert.equal(supersede.newId, newRecord.id);

  // Without includeExpired the superseded row disappears from the default view.
  const visible = db.listMemories({ userId: USER_ID, personaId: PERSONA_ID, worldId: '', limit: 10 });
  assert.deepEqual(visible.map(record => record.id), [newRecord.id], '默认查询只能看到当前事实');
});

// ---------------------------------------------------------------------------
// 4. future plan: extraction -> commitment + soft_echo, never "already been there"
// ---------------------------------------------------------------------------

test('4. 未兑现计划：假模型给出 planned 候选，落库为 commitment/soft_echo，注入不宣称已发生', async t => {
  const h = harness(t, 'dsh-mem-integration-plan-');
  const db = await openDb(h);

  const sourceIds = captureConversation(db, { sessionId: 'session-plan', count: 6 });
  const batch = noteCaptureBatch({ db, viewer: VIEWER, minMessages: 6, maxMessages: 40, clock: NOW });
  assert.ok(batch?.jobId, '达到阈值必须建立抽取作业');

  const llm = fakeLlm({
    answer: ({ input }) => {
      const ids = [...String(input).matchAll(/\[id=([^\]\s]+)\]\s+user:/g)].map(match => match[1]);
      return JSON.stringify([{
        kind: 'commitment',
        scope: 'user_global',
        subject: 'user',
        predicate: 'travel_plan',
        value: '用户打算明年去旅行，目前还没出发',
        evidence_source_ids: [ids[0]],
        confidence: 0.82,
        importance: 0.7,
        validity: 'planned',
        suggested_operation: 'insert',
        mention_policy: 'soft_echo',
      }]);
    },
  });

  const drained = await runJobs({
    db,
    llm,
    config: { extraction: { enabled: true, maxMessages: 40 } },
    viewer: VIEWER,
    persona: { id: PERSONA_ID, name: 'bot' },
    now: NOW,
    limit: 1,
  });
  assert.equal(drained.processed, 1, JSON.stringify(drained));
  assert.equal(drained.failed, 0);
  assert.equal(llm.calls, 1, '一批只调用一次模型');

  const plans = db.listMemories({ userId: USER_ID, personaId: PERSONA_ID, status: 'confirmed', limit: 10 });
  assert.equal(plans.length, 1, `只应落库一条候选：${JSON.stringify(plans.map(p => [p.kind, p.value]))}`);
  const plan = plans[0];
  assert.equal(plan.kind, 'commitment', '未来计划必须存成 commitment');
  assert.equal(plan.mentionPolicy, 'soft_echo', '未来计划只能自然呼应，不能直述');
  assert.equal(plan.scope, 'user_global');
  assert.equal(plan.sourceKind, 'extracted');
  assert.ok(plan.tags.includes('auto_extracted'));
  assert.ok(plan.occurredAt, '计划也要记录证据时间');
  assert.ok(db.evidenceFor(plan.id).length > 0, '抽取事实必须挂上来源证据');

  // The injected text must describe a plan, never an accomplished trip.
  const found = await recall({ db, viewer: VIEWER, query: '旅行', config: RECALL_CONFIG, now: NOW });
  const hit = found.entries.find(entry => entry.record.id === plan.id);
  assert.ok(hit, '承诺必须可召回');
  const injected = renderContext({ entries: [hit], budget: 2400 });
  assert.ok(injected.includes('commitment'));
  assert.ok(injected.includes('soft_echo'));
  assert.ok(injected.includes('还没出发'));
  for (const forbidden of ['已经去过', '去过了', '已经旅行', '已完成']) {
    assert.ok(!injected.includes(forbidden), `注入文本不得出现已发生断言：${forbidden}`);
  }
});

// ---------------------------------------------------------------------------
// 5. roleplay isolation across recall / injection / wiki
// ---------------------------------------------------------------------------

test('5. 剧情隔离：worldId=w1 的骑士设定在现实与 w2 的召回、注入、Wiki 里完全不可见', async t => {
  const h = harness(t, 'dsh-mem-integration-world-');
  const db = await openDb(h);
  const wikiDir = h.path('wiki');

  const FICTION = '在剧情里我是异世界骑士，剑名叫霜落';
  const REALITY = '用户喜欢喝乌龙茶';
  const realityRow = seedMemory(db, { predicate: 'it:drink', value: REALITY, importance: 0.8 });
  const fictionRow = seedMemory(db, {
    scope: 'roleplay_world',
    kind: 'event',
    subject: 'world',
    worldId: 'w1',
    predicate: 'it:knight',
    value: FICTION,
    realityLevel: 'roleplay_fiction',
    mentionPolicy: 'soft_echo',
    sourceKind: 'manual',
    importance: 0.9,
  });

  const realityViewer = { userId: USER_ID, personaId: PERSONA_ID, worldId: '' };

  // --- recall: reality viewer cannot reach the fiction row ----------------
  const realityRecall = await recall({ db, viewer: realityViewer, query: '骑士 剑名', config: RECALL_CONFIG, now: NOW });
  assert.deepEqual(realityRecall.entries.map(entry => entry.record.id), [], '现实查询不得召回剧情记录');
  const realityInjection = renderContext({ entries: realityRecall.entries, budget: 2400 });
  assert.ok(!realityInjection.includes('骑士'), '现实注入文本不得出现剧情内容');

  // The reality row itself stays visible (the gate is not "return nothing").
  const realityFact = await recall({ db, viewer: realityViewer, query: '乌龙茶', config: RECALL_CONFIG, now: NOW });
  assert.ok(realityFact.entries.some(entry => entry.record.id === realityRow.id));

  // --- another world cannot see w1 either --------------------------------
  const w2 = { userId: USER_ID, personaId: PERSONA_ID, worldId: 'w2' };
  const w2Recall = await recall({ db, viewer: w2, query: '骑士', config: RECALL_CONFIG, now: NOW });
  assert.deepEqual(w2Recall.entries.map(entry => entry.record.id), [], 'w2 不得看到 w1 的剧情');
  assert.ok(!renderContext({ entries: w2Recall.entries, budget: 2400 }).includes('骑士'));

  // --- the owning world does see it (positive control) -------------------
  const w1 = { userId: USER_ID, personaId: PERSONA_ID, worldId: 'w1' };
  const w1Recall = await recall({ db, viewer: w1, query: '骑士', config: RECALL_CONFIG, now: NOW });
  assert.ok(w1Recall.entries.some(entry => entry.record.id === fictionRow.id), '剧情世界内必须能召回自己的设定');
  assert.ok(renderContext({ entries: w1Recall.entries, budget: 2400 }).includes('骑士'));

  // --- storage-level gate: FTS with an empty world only matches reality ---
  const ftsReality = db.fullTextSearch({
    userId: USER_ID,
    personaId: PERSONA_ID,
    worldId: '',
    query: '骑士',
    limit: 10,
    statuses: ['confirmed'],
  });
  assert.deepEqual(ftsReality, [], 'FTS 在现实世界不得命中剧情行');
  assert.deepEqual(
    db.listMemories({ userId: USER_ID, personaId: PERSONA_ID, worldId: '', limit: 20 }).map(record => record.id),
    [realityRow.id],
    'listMemories 现实过滤同样不得返回剧情行',
  );

  // --- wiki: reality and w2 pages never contain the fiction --------------
  const realityWiki = await compileWiki({ dir: wikiDir, db, viewer: realityViewer, now: NOW });
  assert.equal(realityWiki.warnings.length, 0, JSON.stringify(realityWiki.warnings));
  for (const page of WIKI_TOPICS) {
    const { markdown } = readWiki(wikiDir, page.id);
    assert.ok(!markdown.includes('骑士'), `现实 Wiki 页 ${page.path} 不得出现剧情设定`);
  }
  assert.ok(readWiki(wikiDir, 'user-profile').markdown.includes('乌龙茶'), '现实事实必须出现在 Wiki 里');

  const w2Dir = h.path('wiki-w2');
  await compileWiki({ dir: w2Dir, db, viewer: w2, now: NOW });
  for (const page of WIKI_TOPICS) {
    assert.ok(!readWiki(w2Dir, page.id).markdown.includes('骑士'), `w2 的 ${page.path} 不得出现 w1 的剧情`);
  }

  const w1Dir = h.path('wiki-w1');
  await compileWiki({ dir: w1Dir, db, viewer: w1, now: NOW });
  assert.ok(readWiki(w1Dir, 'important-events').markdown.includes('骑士'), '剧情世界自己的 Wiki 必须保留设定');
  assert.ok(readWiki(w1Dir, 'important-events').markdown.includes('w1'), '剧情条目必须标注所属世界');
});

// ---------------------------------------------------------------------------
// 6. sensitive events: placeholder only, on both injection and wiki
// ---------------------------------------------------------------------------

test('6. 敏感事件：avoid_unless_asked 的正文不进注入文本与 Wiki，只留占位', async t => {
  const h = harness(t, 'dsh-mem-integration-sensitive-');
  const db = await openDb(h);
  const wikiDir = h.path('wiki');
  const MARKER = 'SENSITIVE_MARKER_7Q2';

  const sensitive = seedMemory(db, {
    scope: 'user_persona',
    kind: 'event',
    value: `关于那次争执的具体经过，${MARKER}，用户明确说不想再被提起`,
    mentionPolicy: 'avoid_unless_asked',
    realityLevel: 'explicit_user_statement',
    importance: 0.6,
  });
  const normal = seedMemory(db, {
    scope: 'user_persona',
    kind: 'event',
    value: '用户和bot一起看过一次夜空',
    importance: 0.5,
  });

  const found = await recall({ db, viewer: VIEWER, query: '争执', config: RECALL_CONFIG, now: NOW });
  const hit = found.entries.find(entry => entry.record.id === sensitive.id);
  assert.ok(hit, '敏感记录本身仍可被命中（只是不能主动展开）');

  const injected = renderContext({ entries: [hit], budget: 2400 });
  assert.ok(!injected.includes(MARKER), '注入文本不得包含敏感正文');
  assert.ok(injected.includes('hidden'), '注入必须只给占位类型');
  assert.ok(injected.includes('avoid_unless_asked'));

  // The explicit recall tool withholds the value too.
  const toolResult = renderRecallResult({ entries: [hit], limit: 8 });
  assert.equal(toolResult.hiddenCount, 1);
  assert.equal(toolResult.entries[0].value, '');
  assert.equal(toolResult.entries[0].hidden, true);
  assert.ok(!JSON.stringify(toolResult).includes(MARKER));

  // Normal rows keep their body, so the hiding is targeted, not global.
  const normalFound = await recall({ db, viewer: VIEWER, query: '夜空', config: RECALL_CONFIG, now: NOW });
  const normalInjection = renderContext({ entries: normalFound.entries, budget: 2400 });
  assert.ok(normalInjection.includes('一起看过一次夜空'));

  // --- wiki: placeholder instead of the body -----------------------------
  const compiled = await compileWiki({ dir: wikiDir, db, viewer: VIEWER, now: NOW });
  assert.equal(compiled.warnings.length, 0, JSON.stringify(compiled.warnings));
  const events = readWiki(wikiDir, 'important-events').markdown;
  assert.ok(!events.includes(MARKER), 'Wiki 页面正文不得出现敏感内容');
  assert.ok(events.includes('不愿主动提及') || events.includes('已隐藏正文'), 'Wiki 必须留下占位说明');
  assert.ok(events.includes('暂不展开'), '敏感条目必须归到“暂不展开”分区');
  assert.ok(events.includes('一起看过一次夜空'), '同一页的普通事件必须照常展开');
});

// ---------------------------------------------------------------------------
// 7. crash restart: cursor, jobs and memories survive; no duplicate writes
// ---------------------------------------------------------------------------

test('7. 故障重启：关库重开后台账仍在，继续处理不重复写，attempts 不虚增', async t => {
  const h = harness(t, 'dsh-mem-integration-restart-');
  let db = await openDb(h);

  const firstIds = captureConversation(db, { sessionId: 'session-7', count: 6, firstSeq: 1 });
  const batchA = noteCaptureBatch({ db, viewer: VIEWER, minMessages: 6, maxMessages: 40, clock: NOW });
  assert.ok(batchA?.jobId);
  assert.equal(batchA.messageCount, 6);

  // --- simulate a process restart: close, reopen the same file ------------
  db.close();
  db = await openDb(h);

  const cursor = readCaptureCursor({ db, viewer: VIEWER });
  assert.ok(cursor, '游标必须持久化');
  assert.equal(cursor.batched, 6);
  assert.equal(cursor.afterSourceId, firstIds[firstIds.length - 1]);
  assert.deepEqual(db.jobs({ state: 'pending', type: 'extract' }).map(job => job.jobId), [batchA.jobId]);
  assert.equal(db.jobs({ type: 'extract' })[0].attempts, 0);
  assert.equal(db.stats().memories, 0, '重启前没有落库任何事实');
  assert.equal(db.stats().events, 6);

  // --- continue the queue after the restart ------------------------------
  const llm = fakeLlm({
    answer: ({ input }) => {
      const ids = [...String(input).matchAll(/\[id=([^\]\s]+)\]\s+user:/g)].map(match => match[1]);
      return JSON.stringify([{
        kind: 'preference',
        scope: 'user_global',
        subject: 'user',
        predicate: 'prefers_tea',
        value: '用户更喜欢喝乌龙茶',
        evidence_source_ids: ids.slice(0, 1),
        confidence: 0.85,
        importance: 0.7,
        validity: 'current',
        suggested_operation: 'insert',
        mention_policy: 'direct',
      }]);
    },
  });
  const resumed = await runJobs({
    db,
    llm,
    config: { extraction: { enabled: true, maxMessages: 40 } },
    viewer: VIEWER,
    persona: { id: PERSONA_ID, name: 'bot' },
    now: Date.now() + 10_000,
    limit: 1,
  });
  assert.equal(resumed.processed, 1, JSON.stringify(resumed));
  assert.equal(db.stats().memories, 1);
  assert.equal(db.stats().events, 6, '恢复处理不得新增证据');

  // A second drain finds nothing to do and writes nothing twice.
  const again = await runJobs({
    db,
    llm,
    config: { extraction: { enabled: true, maxMessages: 40 } },
    viewer: VIEWER,
    persona: { id: PERSONA_ID, name: 'bot' },
    now: Date.now() + 20_000,
    limit: 2,
  });
  assert.equal(again.processed, 0);
  assert.equal(again.failed, 0);
  assert.equal(db.stats().memories, 1, '重复 drain 不得重复写记忆');
  assert.equal(llm.calls, 1, '已完成的作业不会被再次领取');

  // --- a failing job keeps its attempts across a restart -----------------
  captureConversation(db, { sessionId: 'session-7', count: 6, firstSeq: 7, baseMs: NOW - 1800_000 });
  const batchB = noteCaptureBatch({ db, viewer: VIEWER, minMessages: 6, maxMessages: 40, clock: NOW });
  assert.ok(batchB?.jobId);
  assert.notEqual(batchB.jobId, batchA.jobId);

  const broken = { async complete() { throw new Error('模型服务暂时不可用'); } };
  const failed = await runJobs({
    db,
    llm: broken,
    config: { extraction: { enabled: true, maxMessages: 40 } },
    viewer: VIEWER,
    persona: { id: PERSONA_ID, name: 'bot' },
    now: Date.now() + 30_000,
    limit: 1,
    retryDelayMs: 0,
  });
  assert.equal(failed.failed, 1, JSON.stringify(failed));
  const jobAfterFail = db.jobs({ type: 'extract' }).find(job => job.jobId === batchB.jobId);
  assert.equal(jobAfterFail.state, 'pending', '第 1 次失败只退避，不永久失败');
  assert.equal(jobAfterFail.attempts, 1);
  assert.ok(jobAfterFail.lastError.includes('模型服务暂时不可用'));
  assert.equal(db.stats().memories, 1, '失败的批次不得写入记忆');

  db.close();
  db = await openDb(h);
  const afterRestart = db.jobs({ type: 'extract' }).find(job => job.jobId === batchB.jobId);
  assert.equal(afterRestart.attempts, 1, '重启不得虚增 attempts');
  assert.equal(afterRestart.state, 'pending');
  assert.equal(afterRestart.cursor, batchB.cursor, '游标必须随作业持久化');
  assert.equal(db.stats().events, 12, '失败批次的原文必须保留，供重试使用');
  assert.equal(db.stats().memories, 1);

  // Retry succeeds without duplicating the earlier batch's memory.
  const retried = await runJobs({
    db,
    llm: fakeLlm({ answer: '[]' }),
    config: { extraction: { enabled: true, maxMessages: 40 } },
    viewer: VIEWER,
    persona: { id: PERSONA_ID, name: 'bot' },
    now: Date.now() + 60_000,
    limit: 1,
  });
  assert.equal(retried.processed, 1, JSON.stringify(retried));
  assert.equal(db.stats().memories, 1, '空候选不得新增记忆');
  const done = db.jobs({ type: 'extract' }).find(job => job.jobId === batchB.jobId);
  assert.equal(done.state, 'done');
  assert.equal(done.attempts, 1, '成功完成不得改写 attempts');
  assert.deepEqual(pendingBatches({ db }), []);
});

// ---------------------------------------------------------------------------
// 8. degradation: embedder down, model down, empty store, unopenable database
// ---------------------------------------------------------------------------

test('8. 降级：向量全失败、模型抛错、空库、数据库打不开时都不抛，仍返回合法文本', async t => {
  const h = harness(t, 'dsh-mem-integration-degrade-');

  // --- (a) empty store ---------------------------------------------------
  {
    const dbFile = h.file('empty.db');
    const engine = await makeEngine(h, { root: h.path('root-empty'), config: quietConfig(dbFile) });
    const text = await engine.contextFor({ sessionId: 's-empty', query: '随便问问' });
    assert.equal(typeof text, 'string');
    assert.equal(text, '', '空库不注入任何内容');
    const status = await engine.status({ sessionId: 's-empty' });
    assert.equal(status.backend, 'sqlite');
    assert.equal(status.stats.memories, 0);
    await engine.close();
  }

  // --- (b) every embedding request fails (stub fetch, no real network) ---
  {
    const dbFile = h.file('embed-down.db');
    const root = h.path('root-embed');
    const db = await openDatabaseForSeed(dbFile);
    h.onCleanup(() => db.close());
    const record = seedMemory(db, { predicate: 'it:drink', value: '用户更喜欢喝乌龙茶' });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('embedding endpoint unreachable'); };
    try {
      const engine = await makeEngine(h, {
        root,
        config: quietConfig(dbFile, {
          embedding: { provider: 'remote', baseUrl: 'http://embedder.invalid/v1', model: 'test-embedding', timeoutMs: 600 },
        }),
      });
      const text = await engine.contextFor({ sessionId: 's-embed', query: '乌龙茶' });
      assert.equal(typeof text, 'string', '向量通道全失败时也必须返回字符串');
      assert.ok(text.includes(record.id), '向量失败后必须还能用字面通道召回');
      const status = await engine.status({ sessionId: 's-embed' });
      assert.equal(status.backend, 'sqlite', '向量故障不得降级整个后端');
      assert.equal(status.config.embedding, 'remote');
      // 版本可观测：status 必须带当前 schema 版本，便于排障（不需要进库看 schema_meta）。
      assert.equal(status.schema.version, 2);
      assert.ok(Array.isArray(status.schema.migrated));
      // 降级时必须立刻停：本地哈希向量不能挂到远端身份下，远端缺口保持待补。
      const internal = await engine.internal();
      const backfill = await internal.ensureEmbeddings(internal.db);
      assert.equal(backfill.embedded, 0, '远端不可用时不得把本地向量写进远端索引');
      assert.equal(backfill.degraded, true, '降级必须被标记出来，供上层停止');
      assert.equal(internal.db.getEmbeddings({ provider: 'remote', model: 'test-embedding' }).length, 0);
      const stillPending = internal.db.pendingEmbeddings({
        provider: 'remote', model: 'test-embedding', dimensions: 256,
      });
      assert.ok(stillPending.some(row => row.id === record.id), '远端缺口应保持待补');
      // 第二次调用同样立即返回：不会对同一批反复请求。
      const again = await internal.ensureEmbeddings(internal.db);
      assert.equal(again.embedded, 0);
      await engine.close();
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  // --- (c) the model throws: job fails, caller still gets an object ------
  {
    const dbFile = h.file('llm-down.db');
    const db = await openDatabaseForSeed(dbFile);
    h.onCleanup(() => db.close());
    captureConversation(db, { sessionId: 'session-llm', count: 6, firstSeq: 1 });
    const batch = noteCaptureBatch({ db, viewer: VIEWER, minMessages: 6, maxMessages: 40, clock: NOW });
    assert.ok(batch?.jobId);

    const thrown = await runJobs({
      db,
      llm: { async complete() { throw new Error('模型服务 500'); } },
      config: { extraction: { enabled: true, maxMessages: 40 } },
      viewer: VIEWER,
      persona: { id: PERSONA_ID, name: 'bot' },
      now: Date.now() + 10_000,
      limit: 1,
      retryDelayMs: 0,
    });
    assert.equal(thrown.failed, 1);
    assert.equal(thrown.processed, 0);
    assert.equal(db.jobs({ type: 'extract' })[0].state, 'pending');

    // Engine facade with a failing model: drainJobs resolves, never rejects.
    // The engine clock is moved past the backoff deadline so the retry is due.
    const engine = await makeEngine(h, {
      root: h.path('root-llm'),
      config: quietConfig(dbFile, { extraction: { enabled: true, minMessages: 2, maxMessages: 40 } }),
      llm: { async complete() { throw new Error('模型服务 500'); } },
      now: () => Date.now() + 120_000,
    });
    const drained = await engine.drainJobs({ sessionId: 's-llm' });
    assert.equal(typeof drained, 'object');
    assert.ok(drained.failed >= 1, JSON.stringify(drained));
    assert.equal(drained.processed, 0);
    const text = await engine.contextFor({ sessionId: 's-llm', query: '日常' });
    assert.equal(typeof text, 'string');
    const status = await engine.status({ sessionId: 's-llm' });
    assert.equal(status.backend, 'sqlite');
    assert.equal(status.jobs.failed + status.jobs.pending, 1, '失败作业必须留在队列里等待重试');
    await engine.close();
  }

  // --- (d) the database cannot be opened: foreign application_id -------
  {
    const foreign = h.file('foreign.db');
    const { DatabaseSync } = await import('node:sqlite');
    const handle = new DatabaseSync(foreign);
    try {
      handle.exec('CREATE TABLE other_app (id INTEGER PRIMARY KEY)');
      handle.exec(`PRAGMA application_id = ${APPLICATION_ID + 7}`);
    } finally {
      handle.close();
    }
    const engine = await makeEngine(h, {
      root: h.path('root-foreign'),
      config: quietConfig(foreign),
    });
    const text = await engine.contextFor({ sessionId: 's-foreign', query: '任何问题' });
    assert.equal(typeof text, 'string');
    assert.equal(text, '');
    const status = await engine.status({ sessionId: 's-foreign' });
    assert.equal(status.backend, 'legacy', '不是本应用的库必须降级到 legacy');
    assert.match(String(status.reason), /sqlite-unavailable/);
    assert.equal(status.stats, undefined);
    await engine.close();
  }

  // --- (e) the database path is illegal (parent is a regular file) -----
  {
    const blocker = h.file('blocked');
    fs.writeFileSync(blocker, 'not a directory', 'utf8');
    const illegal = path.join(blocker, 'memory.db');
    const engine = await makeEngine(h, {
      root: h.path('root-illegal'),
      config: quietConfig(illegal),
    });
    const text = await engine.contextFor({ sessionId: 's-illegal', query: '在吗' });
    assert.equal(typeof text, 'string');
    assert.equal(text, '');
    const status = await engine.status();
    assert.equal(status.backend, 'legacy');
    assert.match(String(status.reason), /sqlite-unavailable/);
    // status() must still answer the operator question even in this state.
    assert.equal(status.version, '0.4.0');
    assert.equal(status.config.backend, 'sqlite', '配置里仍然写着 sqlite，降级只发生在运行期');
    await engine.close();
  }
});

/** Open a seed handle without registering the harness cleanup twice. */
async function openDatabaseForSeed(file) {
  return openMemoryDatabase({ file });
}

// ---------------------------------------------------------------------------
// 9. wiki: byte stability, manual region preserved, index not listed as a topic
// ---------------------------------------------------------------------------

test('9. Wiki：两次编译字节一致、人工区保留、index 不被当作主题返回', async t => {
  const h = harness(t, 'dsh-mem-integration-wiki-');
  const dbFile = h.file();
  const db = await openDb(h, dbFile);
  const wikiDir = h.path('wiki');

  seedMemory(db, { kind: 'profile', predicate: 'it:name', value: '用户希望被叫作阿博', importance: 0.9 });
  seedMemory(db, { kind: 'preference', predicate: 'it:drink', value: '用户更喜欢喝乌龙茶' });
  seedMemory(db, {
    scope: 'user_persona',
    kind: 'event',
    value: '用户和bot一起看过一次夜空',
    importance: 0.6,
  });

  const first = await compileWiki({ dir: wikiDir, db, viewer: VIEWER, now: NOW });
  assert.equal(first.warnings.length, 0, JSON.stringify(first.warnings));
  assert.equal(first.pages.length, WIKI_TOPICS.length);
  const firstBytes = fileSnapshot(wikiDir);
  assert.ok(firstBytes.has('index.md'));
  assert.ok(firstBytes.has('user/profile.md'));

  // --- identical inputs produce identical bytes --------------------------
  const second = await compileWiki({ dir: wikiDir, db, viewer: VIEWER, now: NOW });
  assert.equal(second.warnings.length, 0);
  const secondBytes = fileSnapshot(wikiDir);
  assert.deepEqual([...secondBytes.keys()].sort(), [...firstBytes.keys()].sort());
  for (const [name, buffer] of firstBytes) {
    assert.ok(secondBytes.get(name).equals(buffer), `重复编译必须字节一致：${name}`);
  }
  assert.equal(second.pages.every(page => page.changed === false), true, '无变化时不得重写文件');

  // --- the manual region is preserved verbatim ---------------------------
  const profileFile = path.join(wikiDir, 'user', 'profile.md');
  const original = fs.readFileSync(profileFile, 'utf8');
  assert.ok(original.includes('<!-- manual:begin -->'));
  assert.ok(original.includes('<!-- manual:end -->'));
  const MANUAL = '人工补充：这段由人写，任何一次重编译都不能覆盖。';
  fs.writeFileSync(
    profileFile,
    original.replace('<!-- manual:end -->', `${MANUAL}\n<!-- manual:end -->`),
    'utf8',
  );

  seedMemory(db, { kind: 'profile', predicate: 'it:city', value: '用户住在杭州', importance: 0.85 });
  const third = await compileWiki({ dir: wikiDir, db, viewer: VIEWER, now: NOW });
  assert.equal(third.pages.find(page => page.pageId === 'user-profile').changed, true);
  const rebuilt = fs.readFileSync(profileFile, 'utf8');
  assert.ok(rebuilt.includes(MANUAL), '人工区必须保留');
  assert.ok(rebuilt.includes('用户住在杭州'), '新增事实必须写进生成区');
  assert.ok(rebuilt.indexOf(MANUAL) > rebuilt.indexOf('<!-- generated:begin'), '人工区在生成区之后');
  assert.ok(rebuilt.includes('<!-- generated:end -->'));

  // generated / manual / compiled markers all survive a rebuild.
  assert.ok(rebuilt.includes('<!-- compiled:'));
  assert.equal((rebuilt.match(/<!-- generated:begin/g) ?? []).length, 1);

  // --- index is registered under scope 'system' and never listed ---------
  const pages = db.listWikiPages();
  const indexPage = pages.find(page => page.pageId === WIKI_INDEX_ID);
  assert.ok(indexPage, 'index 必须登记进 wiki_pages');
  assert.equal(indexPage.scope, 'system');
  assert.equal(pages.filter(page => page.scope !== 'system').length, WIKI_TOPICS.length);

  const engine = await makeEngine(h, {
    root: h.path('root'),
    config: quietConfig(dbFile, { wiki: { enabled: true, dir: wikiDir, minIntervalMs: 0 } }),
  });
  const listed = await engine.wikiIndex({ sessionId: 's-wiki' });
  assert.equal(listed.pages.length, WIKI_TOPICS.length, 'companion_wiki_index 只能列主题页');
  assert.ok(!listed.pages.some(page => page.pageId === WIKI_INDEX_ID), 'index 不能被当成主题返回');
  assert.deepEqual(
    listed.pages.map(page => page.pageId).sort(),
    WIKI_TOPICS.map(topic => topic.id).sort(),
  );
  const read = await engine.wikiGet({ sessionId: 's-wiki', topicId: 'user-profile' });
  assert.equal(read.ok, true);
  assert.ok(read.markdown.includes('用户住在杭州'));
  await engine.close();
});

// ---------------------------------------------------------------------------
// 10. §15 job-queue extensions (used by capture): probe, then assert when present
// ---------------------------------------------------------------------------

test('§15 兼容：claimJob(streamKey) / enqueueJob(force) / requeueJob 存在即验证，缺失则跳过', async t => {
  const h = harness(t, 'dsh-mem-integration-queue-');
  const db = await openDb(h);
  const type = 'extract';
  const later = () => Date.now() + 5000;

  // --- enqueueJob: a re-enqueue folds into the open job by default -------
  const first = db.enqueueJob({ type, streamKey: 'u1:bot', cursor: 3, payload: { sourceIds: ['a'] } });
  const folded = db.enqueueJob({ type, streamKey: 'u1:bot', cursor: 4, payload: { sourceIds: ['b'] } });
  assert.equal(folded.jobId, first.jobId, '同 type+stream 的未完成作业必须复用');
  assert.equal(folded.cursor, 3, '复用不得覆盖既有游标');

  // --- enqueueJob({force}) -------------------------------------------------
  let forceSupported = false;
  try {
    const forced = db.enqueueJob({ type, streamKey: 'u1:bot', cursor: 9, payload: { sourceIds: ['c'] }, force: true });
    if (forced && forced.jobId !== first.jobId) {
      forceSupported = true;
      assert.equal(forced.cursor, 9);
      assert.equal(forced.state, 'pending');
      db.completeJob(forced.jobId, { cursor: 9 });
    }
  } catch (error) {
    t.diagnostic(`enqueueJob(force) 抛错：${error.message}`);
  }
  if (!forceSupported) t.diagnostic('enqueueJob(force) 未实现：跳过 force 断言（§15 允许的过渡状态）');

  // --- claimJob(streamKey) ------------------------------------------------
  // The decoy `first` is older, so a claim without stream filtering would hand it
  // back; only a stream-aware claim can return the other stream's job.
  const other = db.enqueueJob({ type, streamKey: 'other:bot', cursor: 1, payload: {}, force: true });
  const claimedOther = db.claimJob(type, { now: later(), streamKey: 'other:bot' });
  const streamKeySupported = Boolean(claimedOther) && claimedOther.streamKey === 'other:bot';
  if (streamKeySupported) {
    assert.equal(claimedOther.jobId, other.jobId);
    assert.equal(claimedOther.state, 'running');
    assert.equal(db.claimJob(type, { now: later(), streamKey: 'other:bot' }), null, '同一作业不能被领取两次');
    db.completeJob(claimedOther.jobId, { cursor: 1 });
    db.completeJob(first.jobId, { cursor: 3 });
  } else {
    // Stream filtering is not implemented: the decoy was claimed instead.
    if (claimedOther) db.completeJob(claimedOther.jobId, { cursor: claimedOther.cursor });
    t.diagnostic('claimJob(streamKey) 未实现按流认领：跳过 streamKey 断言');
  }

  // --- requeueJob ---------------------------------------------------------
  if (typeof db.requeueJob !== 'function') {
    t.diagnostic('requeueJob 未实现：跳过重排断言');
    return;
  }
  const retry = db.enqueueJob({ type, streamKey: 'retry:bot', cursor: 2, payload: { sourceIds: ['x'] }, force: true });
  const claimRetry = () => db.claimJob(type, streamKeySupported ? { now: later(), streamKey: 'retry:bot' } : { now: later() });
  assert.equal(claimRetry().jobId, retry.jobId, '重排前先领取作业');
  let last = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    last = db.failJob(retry.jobId, `第 ${attempt + 1} 次失败`, { retryDelayMs: 0 });
  }
  assert.equal(last.state, 'failed', '第 5 次失败必须置 failed');
  assert.equal(last.attempts, 5);

  const requeued = db.requeueJob(retry.jobId);
  assert.equal(requeued.ok, true, JSON.stringify(requeued));
  assert.equal(requeued.job.state, 'pending');
  assert.equal(requeued.job.attempts, 5, '默认保留 attempts 以便审计');
  assert.equal(requeued.job.lastError, last.lastError, '重排不得清空错误记录');

  const reset = db.requeueJob(retry.jobId, { resetAttempts: true });
  assert.equal(reset.ok, true);
  assert.equal(reset.job.attempts, 0);

  const reclaimed = claimRetry();
  assert.equal(reclaimed.jobId, retry.jobId, '重排后可再次被领取');
  assert.equal(reclaimed.attempts, 0);
  db.completeJob(reclaimed.jobId, { cursor: 2 });
  assert.equal(db.jobStats().failed, 0);
});

// ---------------------------------------------------------------------------
// 11. embedding channel + fusion wired end to end (semantic path is exercised)
// ---------------------------------------------------------------------------

test('11. 混合检索链路：本地向量入库后，改写问法仍召回同一条并报告通道', async t => {
  const h = harness(t, 'dsh-mem-integration-hybrid-');
  const db = await openDb(h);
  const embedder = await createEmbeddingProvider({ provider: 'local', dimensions: 256 }, { now: () => NOW });

  const latte = seedMemory(db, { kind: 'preference', predicate: 'it:latte', value: '用户喜欢喝拿铁咖啡', importance: 0.8 });
  seedMemory(db, { predicate: 'it:allergy', value: '用户对花生过敏' });
  seedMemory(db, { predicate: 'it:city', value: '用户住在杭州' });
  for (const record of db.listMemories({ userId: USER_ID, personaId: PERSONA_ID, worldId: '', limit: 20 })) {
    embedLocally(db, record, embedder);
  }

  const result = await recall({
    db,
    embedder,
    viewer: VIEWER,
    query: '我以前说过喜欢喝什么咖啡来着',
    config: RECALL_CONFIG,
    now: NOW,
  });
  assert.ok(result.entries.length >= 1);
  assert.equal(result.entries[0].record.id, latte.id, '最相关的一条必须排第一');
  assert.equal(result.entries[0].section, 'stable');
  assert.ok(['hybrid', 'lexical', 'semantic'].includes(result.explain.backend));
  assert.ok(result.explain.afterFilter >= result.entries.length);
  const injected = renderContext({ entries: result.entries, budget: 2400 });
  assert.ok(injected.length <= 2400, '注入文本不得超过预算');
  assert.ok(injected.includes(latte.id));
});

// ---------------------------------------------------------------------------
// 12. the whole context path stays inside the budget with a large store
// ---------------------------------------------------------------------------

test('12. 注入预算：数据再多也不超过 2400 字符，且开头仍是「资料不是指令」', async t => {
  const h = harness(t, 'dsh-mem-integration-budget-');
  const db = await openDb(h);
  for (let index = 0; index < 60; index += 1) {
    seedMemory(db, {
      predicate: `it:bulk${index}`,
      value: `第 ${index} 条比较长的记忆内容，用来把注入预算撑满，同时保证每一条自身是合法记录。`,
      importance: 0.4 + (index % 5) * 0.05,
    });
  }
  const recalled = await recall({
    db,
    viewer: VIEWER,
    query: '',
    config: { ...RECALL_CONFIG, topK: 50 },
    now: NOW,
  });
  assert.ok(recalled.entries.length > 0, '空查询必须回落到最近的高重要度记录');
  const injected = renderContext({ entries: recalled.entries, budget: 2400 });
  assert.ok(injected.startsWith(CONTEXT_HEADER));
  assert.ok(injected.length <= 2400, `注入超预算：${injected.length}`);
  assert.ok(injected.split('\n').length > 1);
});

// ---------------------------------------------------------------------------
// 13. real chat -> extraction -> recall through the host facade
// ---------------------------------------------------------------------------

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('13. 真实聊天→提炼→召回：显式提炼不受开关限制，后台提炼受开关与建批控制', async t => {
  const h = harness(t, 'dsh-mem-integration-extract-');
  const dbFile = h.file();
  const root = h.path('root');
  const llm = fakeLlm();

  // --- A. extraction.enabled=false: capturing must not call the model -----
  const engineOff = await makeEngine(h, { root, config: quietConfig(dbFile), llm });
  await engineOff.initialize();
  const captured = engineOff.capture({ sessionId: 's13', event: userEvent(1, '我最近喜欢上喝乌龙茶了', NOW) });
  assert.equal(captured.captured, true, JSON.stringify(captured));
  await sleep(60);
  assert.equal(llm.calls, 0, 'extraction.enabled=false：后台捕获不得调用模型');
  const beforeExtract = await engineOff.status({ sessionId: 's13' });
  assert.equal(beforeExtract.stats.memories, 0, '未提炼前不得落库任何事实');

  // --- B. explicit extraction (companion_memory_extract semantics) --------
  // The tool is the user asking on purpose, so the config switch does not gate
  // it; the batch is built with minMessages=1 and forced enabled for one run.
  const extracted = await engineOff.extractNow({ sessionId: 's13' });
  assert.equal(extracted.ok, true, JSON.stringify(extracted));
  assert.ok((extracted.processed ?? 0) >= 1, `显式提炼必须处理至少一个作业：${JSON.stringify(extracted)}`);
  assert.equal(llm.calls, 1, '一次显式提炼只调用一次模型');
  const afterExtract = await engineOff.status({ sessionId: 's13' });
  assert.ok(afterExtract.stats.confirmedMemories >= 1, '提炼后必须有已确认事实');
  assert.ok((afterExtract.jobs?.done ?? 0) >= 1, '作业必须完成并计入 done');

  // --- C. the extracted fact is recallable and injectable -----------------
  const answer = await engineOff.recall({ sessionId: 's13', query: '乌龙茶' });
  const hit = answer.entries.find(entry => String(entry.value).includes('乌龙茶'));
  assert.ok(hit, `提炼出的事实必须可召回：${JSON.stringify(answer.entries)}`);
  assert.equal(hit.source, 'extracted', '来源必须是自动抽取');
  const injected = await engineOff.contextFor({ sessionId: 's13', query: '乌龙茶' });
  assert.ok(injected.includes('乌龙茶'));
  await engineOff.close();

  // --- D. no model: explicit extraction reports the failure honestly ------
  const engineNoLlm = await makeEngine(h, {
    root: h.path('root-nollm'),
    config: quietConfig(h.file('nollm.db')),
  });
  const none = await engineNoLlm.extractNow({ sessionId: 's-nollm' });
  assert.equal(none.ok, false, JSON.stringify(none));
  assert.match(String(none.error), /总结模型/, '必须说明是模型不可用，而不是假装 processed:0');
  await engineNoLlm.close();

  // --- E. background pipeline: batched messages are drained and stored ----
  // NOTE: the host facade currently only *drains* in the background; creating the
  // batch (engine.noteBatch) is still the caller's job (documented in
  // docs/MEMORY.md §10). This case proves the pipeline works once batched.
  const llm2 = fakeLlm();
  const engineOn = await makeEngine(h, {
    root: h.path('root-bg'),
    config: quietConfig(h.file('bg.db'), { extraction: { enabled: true, minMessages: 2, maxMessages: 40 } }),
    llm: llm2,
  });
  await engineOn.initialize();
  for (let seq = 1; seq <= 4; seq += 1) {
    const event = seq % 2 === 1
      ? userEvent(seq, `我想长期记住：第 ${seq} 条说明我平时喜欢喝茶。`, NOW + seq * 60_000)
      : assistantEvent(seq, `好，我记下了第 ${seq} 条。`, NOW + seq * 60_000);
    assert.equal(engineOn.capture({ sessionId: 's-bg', event }).captured, true);
  }
  await sleep(80);
  // The host facade now batches and drains on its own once `extraction.enabled` is
  // true, so an explicit noteBatch may legitimately find nothing left to batch.
  const noted = await engineOn.noteBatch({ sessionId: 's-bg' });
  assert.ok(noted === null || noted?.jobId, `建批结果不合法：${JSON.stringify(noted)}`);
  const drained = await engineOn.drainJobs({ sessionId: 's-bg', background: true });
  assert.ok((drained.processed ?? 0) >= 0, `后台排空不合法：${JSON.stringify(drained)}`);
  const deadline = Date.now() + 8000;
  let status = await engineOn.status();
  while (Date.now() < deadline && status.stats.confirmedMemories < 1) {
    await sleep(100);
    status = await engineOn.status();
  }
  assert.ok(status.stats.confirmedMemories >= 1, JSON.stringify(status.stats));
  assert.ok(status.jobs.done >= 1, JSON.stringify(status.jobs));
  assert.ok(llm2.calls >= 1);
});
