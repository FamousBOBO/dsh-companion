// 记忆档案 Studio · Host API 测试。
//
// 每个用例都打真引擎、真 SQLite（临时 root），不 mock 数据层：
//   - home/companion/memory.config.json 指向临时目录里的 sqlite 库；
//   - identity 提供一个 owner（u1），全部 API 都以它作用域查询；
//   - 引擎在 before 里启动一次，after 里先 close 再删目录（Windows 文件锁）。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { createMemoryEngine } from '../../companion-memory/index.mjs';
import { EDITABLE_KEYS } from '../lib/read.mjs';
import { ROUTES, createStudioHandlers, registerStudioApi } from '../server.mjs';

const USER_ID = 'u1';
const PERSONA_ID = 'bot';

const state = {
  root: '',
  engine: null,
  identity: null,
  handlers: null,
  internal: null,
  db: null,
  ids: {},
  jobId: '',
  eventId: '',
};

function writeConfig(root) {
  const dir = path.join(root, 'home/companion');
  fs.mkdirSync(dir, { recursive: true });
  // customNote 是"未知键"，用来验证设置写回时不会丢掉它。
  const config = {
    schemaVersion: 1,
    backend: 'sqlite',
    database: 'home/memory/companion-memory.db',
    customNote: 'keep-me',
    embedding: { provider: 'off' },
    retrieval: { semanticEnabled: false },
    extraction: { enabled: false, minMessages: 6 },
    wiki: { enabled: true, autoCompile: false, maxEntriesPerTopic: 40 },
  };
  fs.writeFileSync(path.join(dir, 'memory.config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function insertMemory(db, fields) {
  return db.insertMemory({
    userId: USER_ID,
    personaId: PERSONA_ID,
    worldId: '',
    subject: 'user',
    ...fields,
  }).record;
}

function seed(db) {
  const ids = state.ids;
  ids.tea = insertMemory(db, {
    scope: 'user_global', kind: 'fact', predicate: 'drink',
    value: '用户喜欢乌龙茶', confidence: 0.9, importance: 0.8,
  });
  ids.hike = insertMemory(db, {
    scope: 'user_global', kind: 'preference', predicate: 'weekend',
    value: '用户喜欢在周末去爬山', importance: 0.6,
  });
  ids.hidden = insertMemory(db, {
    scope: 'user_global', kind: 'profile', predicate: 'private',
    value: '用户有一段不愿提起的旧伤', mentionPolicy: 'avoid_unless_asked', importance: 0.9,
  });
  ids.pending = insertMemory(db, {
    scope: 'user_global', kind: 'fact', predicate: 'gate',
    value: '用户可能喜欢摄影', status: 'pending', confidence: 0.3,
    tags: ['reason:low-confidence'],
  });
  ids.hiddenPending = insertMemory(db, {
    scope: 'user_global', kind: 'note', predicate: 'gate-private',
    value: '用户不愿公开的私事', status: 'pending',
    mentionPolicy: 'avoid_unless_asked', tags: ['reason:gate-policy'],
  });
  ids.archived = insertMemory(db, {
    scope: 'user_global', kind: 'note', predicate: 'old', value: '用户以前喜欢喝咖啡',
  });
  db.setStatus(ids.archived.id, 'archived', { reason: 'studio-archive', actor: 'user' });
  ids.superseded = insertMemory(db, {
    scope: 'user_global', kind: 'fact', predicate: 'old', value: '用户以前住在北京',
  });
  db.setStatus(ids.superseded.id, 'superseded', { reason: 'studio-archive', actor: 'user' });
  ids.practice = insertMemory(db, {
    scope: 'user_global', kind: 'commitment', predicate: 'plan',
    value: '用户计划学习指弹吉他', importance: 0.7,
  });
  ids.relationship = insertMemory(db, {
    scope: 'user_persona', kind: 'relationship', predicate: 'bond',
    value: 'bot和用户一起看过流星雨', importance: 0.5,
  });
  // 另一个 owner 的记录：详情接口必须当作不存在。
  ids.foreign = db.insertMemory({
    userId: 'u2', personaId: PERSONA_ID, worldId: '',
    scope: 'user_global', kind: 'fact', subject: 'user', predicate: 'foreign',
    value: '别人的记忆',
  }).record;

  const first = db.appendEvent({
    eventKey: 'studio:1', sessionId: 'studio-session', seq: 1, role: 'user',
    sourceKind: 'desktop_conversation', occurredAt: '2026-03-01T10:00:00.000Z',
    content: '今天喝了乌龙茶，想去爬山', userId: USER_ID, personaId: PERSONA_ID,
  });
  db.appendEvent({
    eventKey: 'studio:2', sessionId: 'studio-session', seq: 2, role: 'assistant',
    sourceKind: 'desktop_conversation', occurredAt: '2026-03-01T10:01:00.000Z',
    content: '那下次一起去', userId: USER_ID, personaId: PERSONA_ID,
  });
  state.eventId = first.sourceId;
  db.addEvidence(ids.tea.id, first.sourceId, { confidence: 0.9 });
  db.addEvidence(ids.hidden.id, first.sourceId, { confidence: 0.7 });

  // 一个真正失败的作业：连续失败 5 次后 state='failed'。
  const job = db.enqueueJob({
    type: 'extract',
    streamKey: `${USER_ID}:${PERSONA_ID}:studio`,
    payload: { sourceIds: [first.sourceId] },
  });
  state.jobId = job.jobId;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const claimed = db.claimJob('extract', {
      streamKey: job.streamKey,
      now: Date.now() + attempt * 600_000,
    });
    if (claimed) db.failJob(claimed.jobId, `模拟失败 ${attempt}`, { retryDelayMs: 1000 });
  }
}

before(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-api-'));
  state.root = root;
  writeConfig(root);

  const identity = {
    owner: () => ({ id: USER_ID, displayName: '测试', platform: 'desktop' }),
    resolve: () => ({ userId: USER_ID, displayName: '测试' }),
  };
  state.identity = identity;

  const engine = createMemoryEngine({ root, identity, env: {} });
  state.engine = engine;
  await engine.initialize();
  const internal = await engine.internal();
  assert.equal(internal.backend, 'sqlite', '测试必须跑在真 SQLite 后端上');
  state.internal = internal;
  state.db = internal.db;

  seed(internal.db);
  const compiled = await internal.compileWiki({ force: true });
  assert.equal(compiled.compiled, true);

  state.handlers = createStudioHandlers({ engine, identity, root });
});

after(async () => {
  try { await state.engine?.close(); } catch { /* 已关闭 */ }
  if (state.root) {
    try { fs.rmSync(state.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* Windows 偶发占用 */ }
  }
});

function urlFor(key, search = '') {
  return `http://studio.local${key.split(' ')[1]}${search}`;
}

/** 调用一个处理器，返回 { response, json }。 */
async function call(key, { search = '', body } = {}) {
  const handler = state.handlers[key];
  assert.equal(typeof handler, 'function', `缺少处理器：${key}`);
  const init = { method: key.split(' ')[0] };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    init.headers = { 'content-type': 'application/json' };
  }
  const response = await handler(new Request(urlFor(key, search), init));
  const json = await response.json();
  return { response, json };
}

const q = value => `?q=${encodeURIComponent(value)}`;

// ---------------------------------------------------------------------------
// 总览
// ---------------------------------------------------------------------------

test('summary 返回计数、通道、完整性与脱敏后的最近记录', async () => {
  const { response, json } = await call('GET /api/companion-memory/summary');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(json.ok, true);
  assert.equal(json.meta.source, 'companion-memory');
  assert.equal(json.meta.schemaVersion, 1);
  assert.ok(Number.isFinite(Date.parse(json.meta.observedAt)));

  const data = json.data;
  assert.equal(data.backend, 'sqlite');
  assert.equal(data.config.backend, 'sqlite');
  assert.ok(String(data.database).endsWith('companion-memory.db'));
  assert.ok(data.counts.memories >= 9);
  assert.equal(data.counts.pending, 2);
  assert.equal(data.counts.superseded, 1);
  assert.equal(data.counts.archived, 1);
  assert.ok(data.counts.events >= 2);
  assert.ok(data.counts.embeddings >= 0);
  assert.ok(data.scopeCounts.some(item => item.scope === 'user_global' && item.count >= 8));
  assert.ok(data.kindCounts.some(item => item.kind === 'preference' && item.count === 1));
  assert.equal(data.jobs.failed, 1);
  assert.ok(data.jobs.lastError);
  assert.ok(data.integrity && data.integrity.ok === true);
  assert.ok(Number.isFinite(Date.parse(data.integrity.checkedAt)));
  assert.equal(data.channels.fts, 'ok');
  assert.equal(data.channels.wiki.pages, 4);
  assert.equal(data.channels.extraction.enabled, false);
  assert.equal(data.config.budgetChars, 2400);
  assert.equal(data.config.topK, 8);

  assert.ok(data.recent.length > 0 && data.recent.length <= 8);
  // 视图策略回归守卫（A 决策）：`mentionPolicy=avoid_unless_asked` 只约束模型是否主动提及，
  // 不约束主人能不能在管理台看自己的记忆。最近记录里这条必须可见，且 `hidden` 恒为 false。
  const policyRecent = data.recent.find(item => item.id === state.ids.hidden.id);
  assert.ok(policyRecent, '最近记录里必须包含带 mentionPolicy 的那条');
  assert.equal(policyRecent.hidden, false, 'mentionPolicy 不是管理台的视图过滤器');
  assert.ok(policyRecent.preview.length > 0, '主人能在管理台看到正文预览');
});

// ---------------------------------------------------------------------------
// 记忆库列表 / 搜索
// ---------------------------------------------------------------------------

test('memories 支持 scope/kind/status 过滤与分页', async () => {
  const scoped = await call('GET /api/companion-memory/memories', { search: '?scope=user_global&limit=3' });
  assert.equal(scoped.json.ok, true);
  assert.equal(scoped.json.data.items.length, 3);
  assert.equal(scoped.json.data.limit, 3);
  assert.equal(scoped.json.data.offset, 0);
  assert.equal(scoped.json.data.total, 8);
  assert.ok(scoped.json.data.items.every(item => item.scope === 'user_global'));

  const byKind = await call('GET /api/companion-memory/memories', { search: '?kind=preference' });
  assert.ok(byKind.json.data.items.length >= 1);
  assert.ok(byKind.json.data.items.every(item => item.kind === 'preference'));
  assert.ok(byKind.json.data.items.some(item => item.id === state.ids.hike.id));

  const pending = await call('GET /api/companion-memory/memories', { search: '?status=pending' });
  const pendingDebug = JSON.stringify({
    total: pending.json.data.total,
    limit: pending.json.data.limit,
    items: pending.json.data.items.map(item => [item.id, item.status, item.kind]),
    expected: [state.ids.pending.id, state.ids.hiddenPending.id],
    raw: state.db.handle.prepare('SELECT id, kind, status FROM memories WHERE status = ?').all('pending'),
  });
  // 未传 limit 时必须用默认 25，而不是被 Number(null)=0 夹成 1（回归用例）。
  assert.equal(pending.json.data.limit, 25, pendingDebug);
  assert.equal(pending.json.data.total, 2, pendingDebug);
  assert.equal(pending.json.data.items.length, 2, pendingDebug);
  assert.ok(pending.json.data.items.some(item => item.id === state.ids.pending.id), pendingDebug);

  const offset = await call('GET /api/companion-memory/memories', { search: '?limit=2&offset=2' });
  assert.equal(offset.json.data.items.length, 2);
  assert.equal(offset.json.data.offset, 2);
});

test('memories 的 query 走 FTS，无关查询返回空', async () => {
  const hit = await call('GET /api/companion-memory/memories', { search: `?query=${encodeURIComponent('爬山')}` });
  assert.equal(hit.json.ok, true);
  assert.equal(hit.json.data.query, '爬山');
  assert.ok(hit.json.data.total >= 1);
  assert.ok(hit.json.data.items.some(item => item.id === state.ids.hike.id));

  const miss = await call('GET /api/companion-memory/memories', { search: `?query=${encodeURIComponent('量子力学')}` });
  assert.deepEqual(miss.json.data.items, []);
  assert.equal(miss.json.data.total, 0);
});

test('列表：mentionPolicy=avoid_unless_asked 的行照样可见（视图策略不随提及策略改变）', async () => {
  const { json } = await call('GET /api/companion-memory/memories', { search: `?query=${encodeURIComponent('旧伤')}` });
  assert.equal(json.ok, true);
  const item = json.data.items.find(entry => entry.id === state.ids.hidden.id);
  assert.ok(item, '带提及策略的行应当出现在管理列表里');
  // A 决策：模型不许主动提，不等于主人不许看。
  assert.equal(item.hidden, false);
  assert.ok(item.preview.length > 0, '列表预览必须给出正文');
  assert.equal(item.policy, 'avoid_unless_asked');
});

// ---------------------------------------------------------------------------
// 详情与 reveal
// ---------------------------------------------------------------------------

test('memory 详情：mentionPolicy 不影响正文与证据摘录的可见性', async () => {
  const { response, json } = await call('GET /api/companion-memory/memory', {
    search: `?id=${state.ids.hidden.id}`,
  });
  assert.equal(response.status, 200);
  assert.equal(json.ok, true);
  // A 决策：管理台给主人看自己的数据，正文与证据摘录都返回。
  assert.equal(json.data.hidden, false);
  assert.equal(json.data.revealable, false, '没有“可揭露”这回事：一直可见');
  assert.equal(json.data.value, '用户有一段不愿提起的旧伤');
  assert.equal(json.data.evidence.length, 1);
  assert.ok(json.data.evidence[0].excerpt.length > 0);
  assert.equal(json.data.evidence[0].role, 'user');
  assert.equal(json.data.evidence[0].sessionId, 'studio-session');
  assert.equal(json.data.evidence[0].seq, 1);
  assert.ok(Array.isArray(json.data.revisions));
  assert.ok(Array.isArray(json.data.related));
});

test('memory 详情：旧的 reveal=1 参数仍被接受，但不再改变任何可见性', async () => {
  const { json } = await call('GET /api/companion-memory/memory', {
    search: `?id=${state.ids.hidden.id}&reveal=1`,
  });
  assert.equal(json.ok, true);
  assert.equal(json.data.hidden, false);
  assert.equal(json.data.value, '用户有一段不愿提起的旧伤');
  assert.ok(json.data.evidence[0].excerpt.length > 0);

  const plain = await call('GET /api/companion-memory/memory', { search: `?id=${state.ids.tea.id}` });
  assert.equal(plain.json.data.hidden, false);
  assert.equal(plain.json.data.revealable, false);
  assert.equal(plain.json.data.value, '用户喜欢乌龙茶');
  assert.equal(plain.json.meta.revealed, undefined);
});

test('memory 详情对未知 id、别人的 id 与缺失参数给出正确状态码', async () => {
  const missing = await call('GET /api/companion-memory/memory', { search: '?id=mem_00000000000000000000' });
  assert.equal(missing.response.status, 404);
  assert.equal(missing.json.ok, false);
  assert.equal(missing.json.error.code, 'not-found');

  const foreign = await call('GET /api/companion-memory/memory', { search: `?id=${state.ids.foreign.id}` });
  assert.equal(foreign.response.status, 404);
  assert.equal(foreign.json.error.code, 'not-found');

  const bad = await call('GET /api/companion-memory/memory');
  assert.equal(bad.response.status, 400);
  assert.equal(bad.json.error.code, 'bad-request');
});

// ---------------------------------------------------------------------------
// 检索预览
// ---------------------------------------------------------------------------

test('preview 返回真实渲染文本、预算与 explain', async () => {
  const { json } = await call('GET /api/companion-memory/preview', { search: `${q('爬山')}&limit=5` });
  assert.equal(json.ok, true);
  const data = json.data;
  assert.equal(data.query, '爬山');
  assert.equal(data.budgetChars, 2400);
  assert.equal(data.characters, data.rendered.length);
  assert.ok(data.rendered.startsWith('【长期记忆资料】'));
  assert.ok(data.truncated === false || data.truncated === true);
  assert.ok(data.entries.length >= 1 && data.entries.length <= 5);
  const entry = data.entries[0];
  assert.ok(entry.id);
  assert.ok(entry.kind);
  assert.ok(entry.scope);
  assert.ok(entry.policy);
  assert.ok(Number.isFinite(entry.score));
  assert.ok(typeof entry.reason === 'string' && entry.reason.length > 0);
  assert.ok(data.explain && typeof data.explain === 'object');

  // A 决策的分界线：**诊断/管理**看得到（主人要能审核），**注给模型**的文本仍然受
  // mentionPolicy 约束（模型不许主动提起）。两个面各按各的规则，不是同一个开关。
  const policyEntry = await call('GET /api/companion-memory/preview', { search: q('旧伤') });
  assert.equal(policyEntry.json.ok, true);
  const policyRow = policyEntry.json.data.entries.find(item => item.id === state.ids.hidden.id);
  assert.ok(policyRow, '带提及策略的行应当出现在检索诊断里');
  assert.ok(policyRow.preview.length > 0, '诊断里给出正文，主人才审得动');
  assert.equal(policyEntry.json.data.rendered.includes('旧伤'), false,
    '注入文本仍按 mentionPolicy 隐藏正文（约束的是模型，不是主人）');
});

// ---------------------------------------------------------------------------
// 审核
// ---------------------------------------------------------------------------

test('reviews 返回 pending 与失败作业；提及策略不影响审核时看到正文', async () => {
  const { json } = await call('GET /api/companion-memory/reviews');
  assert.equal(json.ok, true);
  const pending = json.data.pending;
  assert.ok(pending.some(item => item.id === state.ids.pending.id));
  const visible = pending.find(item => item.id === state.ids.pending.id);
  assert.equal(visible.hidden, false);
  assert.equal(visible.value, '用户可能喜欢摄影');
  assert.deepEqual(visible.reasons, ['low-confidence']);

  const policyRow = pending.find(item => item.id === state.ids.hiddenPending.id);
  assert.ok(policyRow);
  // A 决策：审核页要看懂“为什么需要审”，所以正文必须可见；hidden 恒 false。
  assert.equal(policyRow.hidden, false);
  assert.ok(policyRow.value.length > 0, '审核时能看到待审正文');
  assert.deepEqual(policyRow.reasons, ['gate-policy']);

  const job = json.data.failedJobs.find(item => item.id === state.jobId);
  assert.ok(job, '失败作业必须出现在审核列表');
  assert.equal(job.attempts, 5);
  assert.ok(job.lastError.length > 0);
});

test('review requeue 把失败作业恢复为 pending，坏请求返回 400/404', async () => {
  const { json } = await call('POST /api/companion-memory/review', {
    body: { action: 'requeue', jobId: state.jobId },
  });
  assert.equal(json.ok, true);
  assert.equal(json.data.state, 'pending');
  const pendingJobs = state.db.jobs({ state: 'pending' });
  assert.ok(pendingJobs.some(job => job.jobId === state.jobId));

  const missing = await call('POST /api/companion-memory/review', {
    body: { action: 'requeue', jobId: 'job_00000000000000000000' },
  });
  assert.equal(missing.response.status, 404);
  assert.equal(missing.json.error.code, 'not-found');

  const bad = await call('POST /api/companion-memory/review', { body: { action: 'bogus' } });
  assert.equal(bad.response.status, 400);
  assert.equal(bad.json.error.code, 'bad-request');
});

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------

test('settings GET 暴露白名单键与当前值', async () => {
  const { json } = await call('GET /api/companion-memory/settings');
  assert.equal(json.ok, true);
  assert.equal(json.data.configPath, path.join(state.root, 'home/companion/memory.config.json'));
  assert.equal(json.data.backend, 'sqlite');
  assert.equal(json.data.restartRequiredHint, true);
  assert.deepEqual(Object.keys(json.data.editable).sort(), [...EDITABLE_KEYS].sort());
  assert.equal(json.data.editable.topK, 8);
  assert.equal(json.data.editable.budgetChars, 2400);
  assert.equal(json.data.editable.embeddingProvider, 'off');
  assert.equal(json.data.editable.semanticEnabled, false);
});

test('settings POST 拒绝非法键、非法值与空 patch', async () => {
  const unknown = await call('POST /api/companion-memory/settings', { body: { patch: { customNote: 'x' } } });
  assert.equal(unknown.response.status, 400);
  assert.equal(unknown.json.error.code, 'bad-request');

  const outOfRange = await call('POST /api/companion-memory/settings', { body: { patch: { topK: 999 } } });
  assert.equal(outOfRange.response.status, 400);
  assert.match(outOfRange.json.error.message, /topK/);

  const smallBudget = await call('POST /api/companion-memory/settings', { body: { patch: { budgetChars: 100 } } });
  assert.equal(smallBudget.response.status, 400);

  const empty = await call('POST /api/companion-memory/settings', { body: { patch: {} } });
  assert.equal(empty.response.status, 400);

  // 拒绝之后磁盘上的配置必须原样。
  const raw = JSON.parse(fs.readFileSync(path.join(state.root, 'home/companion/memory.config.json'), 'utf8'));
  assert.equal(raw.retrieval.topK, undefined);
});

test('settings POST 写回文件、保留未知键、不热改内存配置', async () => {
  const { json } = await call('POST /api/companion-memory/settings', {
    body: { patch: { topK: 12, minMessages: 4, wikiAutoCompile: true } },
  });
  assert.equal(json.ok, true);
  assert.equal(json.data.restartRequired, true);
  assert.deepEqual([...json.data.changed].sort(), ['minMessages', 'topK', 'wikiAutoCompile']);

  const raw = JSON.parse(fs.readFileSync(path.join(state.root, 'home/companion/memory.config.json'), 'utf8'));
  assert.equal(raw.retrieval.topK, 12);
  assert.equal(raw.extraction.minMessages, 4);
  assert.equal(raw.wiki.autoCompile, true);
  assert.equal(raw.customNote, 'keep-me');
  assert.equal(raw.backend, 'sqlite');
  assert.equal(raw.embedding.provider, 'off');
  assert.equal(fs.readFileSync(path.join(state.root, 'home/companion/memory.config.json'), 'utf8').endsWith('\n'), true);

  // 运行中的引擎不会因为磁盘配置改变而热更新。
  assert.equal(state.engine.config.retrieval.topK, 8);
  assert.equal(state.engine.config.extraction.minMessages, 6);
});

// ---------------------------------------------------------------------------
// 远端模型配置与连接探测（契约 §8.2 / §8.3）
// ---------------------------------------------------------------------------

const configFile = () => path.join(state.root, 'home/companion/memory.config.json');
const remoteModelsFile = () => path.join(state.root, 'home/companion/remote-models.json');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** 用注入的 fetchImpl 打一次 POST /settings/test。 */
async function probe(body, fetchImpl) {
  const handlers = createStudioHandlers({
    engine: state.engine, identity: state.identity, root: state.root, fetchImpl,
  });
  const key = 'POST /api/companion-memory/settings/test';
  const response = await handlers[key](new Request(urlFor(key), {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  }));
  return { response, json: await response.json() };
}

test('settings GET 只报告密钥是否已配置，绝不回显 key', async () => {
  const { json } = await call('GET /api/companion-memory/settings');
  assert.equal(json.ok, true);
  assert.equal(json.data.embeddingKeySet, false);
  assert.equal(json.data.rerankKeySet, false);
  assert.equal(/apiKey/i.test(JSON.stringify(json)), false, 'GET /settings 不得出现 apiKey 字段');
});

test('settings POST 写入远端向量与重排序，key 只落 remote-models.json', async () => {
  const { response, json } = await call('POST /api/companion-memory/settings', {
    body: {
      patch: {
        embeddingProvider: 'remote',
        embeddingBaseUrl: 'https://api.example.com/v1',
        embeddingModel: 'text-embedding-3-small',
        embeddingDimensions: 1024,
        rerankEnabled: true,
        rerankBaseUrl: 'https://rerank.example.com',
        rerankModel: 'bge-reranker-v2-m3',
        rerankTimeoutMs: 6000,
        rerankTopN: 20,
        rerankBlend: 0.6,
        embeddingApiKey: 'sk-embedding-test-key-123456',
        rerankApiKey: 'sk-rerank-test-key-abcdefgh',
      },
    },
  });
  assert.equal(response.status, 200);
  assert.equal(json.ok, true);
  assert.deepEqual([...json.data.changed].sort(), [
    'embeddingApiKey', 'embeddingBaseUrl', 'embeddingDimensions', 'embeddingModel',
    'embeddingProvider', 'rerankApiKey', 'rerankBaseUrl', 'rerankBlend', 'rerankEnabled',
    'rerankModel', 'rerankTimeoutMs', 'rerankTopN',
  ]);
  assert.equal(json.data.restartRequired, true);

  const config = readJson(configFile());
  assert.equal(config.embedding.provider, 'remote');
  assert.equal(config.embedding.baseUrl, 'https://api.example.com/v1');
  assert.equal(config.embedding.model, 'text-embedding-3-small');
  assert.equal(config.embedding.dimensions, 1024);
  assert.equal('apiKey' in config.embedding, false, 'memory.config.json 绝不能出现 embedding.apiKey');
  assert.equal(config.rerank.enabled, true);
  assert.equal(config.rerank.baseUrl, 'https://rerank.example.com');
  assert.equal(config.rerank.model, 'bge-reranker-v2-m3');
  assert.equal(config.rerank.timeoutMs, 6000);
  assert.equal(config.rerank.topN, 20);
  assert.equal(config.rerank.blend, 0.6);
  assert.equal('apiKey' in config.rerank, false, 'memory.config.json 绝不能出现 rerank.apiKey');
  // 既有未知键仍然保留。
  assert.equal(config.customNote, 'keep-me');

  const secrets = readJson(remoteModelsFile());
  assert.equal(secrets.embedding.apiKey, 'sk-embedding-test-key-123456');
  assert.equal(secrets.rerank.apiKey, 'sk-rerank-test-key-abcdefgh');

  // 保存后无需重启就能读回「已保存的值」，但运行中的引擎没有被热改。
  const after = await call('GET /api/companion-memory/settings');
  assert.equal(after.json.data.embeddingKeySet, true);
  assert.equal(after.json.data.rerankKeySet, true);
  assert.equal(after.json.data.editable.embeddingProvider, 'remote');
  assert.equal(after.json.data.editable.embeddingBaseUrl, 'https://api.example.com/v1');
  assert.equal(after.json.data.editable.embeddingModel, 'text-embedding-3-small');
  assert.equal(after.json.data.editable.embeddingDimensions, 1024);
  assert.equal(after.json.data.editable.rerankEnabled, true);
  assert.equal(after.json.data.editable.rerankModel, 'bge-reranker-v2-m3');
  assert.equal(after.json.data.editable.rerankTimeoutMs, 6000);
  assert.equal(after.json.data.editable.rerankTopN, 20);
  assert.equal(after.json.data.editable.rerankBlend, 0.6);
  assert.equal(/apiKey/i.test(JSON.stringify(after.json)), false);
  assert.equal(state.engine.config.embedding.provider, 'off', '运行中的引擎不应被热改');
});

test('settings POST 拒绝非法地址、缺必填项与非法 key，且失败时两个文件都不动', async () => {
  const configBefore = fs.readFileSync(configFile(), 'utf8');
  const secretsBefore = fs.readFileSync(remoteModelsFile(), 'utf8');

  const badUrl = await call('POST /api/companion-memory/settings', {
    body: { patch: { embeddingBaseUrl: 'ftp://nope.example.com' } },
  });
  assert.equal(badUrl.response.status, 400);
  assert.equal(badUrl.json.error.code, 'bad-request');

  const badDimensions = await call('POST /api/companion-memory/settings', {
    body: { patch: { embeddingDimensions: 4 } },
  });
  assert.equal(badDimensions.response.status, 400);

  // 先切到 local 才能清空模型名（remote 模式下清空会被判成缺必填项）。
  await call('POST /api/companion-memory/settings', { body: { patch: { embeddingProvider: 'local' } } });
  const clearModel = await call('POST /api/companion-memory/settings', {
    body: { patch: { embeddingModel: '' } },
  });
  assert.equal(clearModel.json.ok, true);
  const missingModel = await call('POST /api/companion-memory/settings', {
    body: { patch: { embeddingProvider: 'remote' } },
  });
  assert.equal(missingModel.response.status, 400);
  assert.match(missingModel.json.error.message, /模型名/);

  const missingRerankUrl = await call('POST /api/companion-memory/settings', {
    body: { patch: { rerankBaseUrl: '' } },
  });
  assert.equal(missingRerankUrl.response.status, 400);
  assert.match(missingRerankUrl.json.error.message, /API 地址/);

  const shortKey = await call('POST /api/companion-memory/settings', {
    body: { patch: { embeddingApiKey: 'short' } },
  });
  assert.equal(shortKey.response.status, 400);

  const spaceKey = await call('POST /api/companion-memory/settings', {
    body: { patch: { rerankApiKey: 'sk-has space 1234' } },
  });
  assert.equal(spaceKey.response.status, 400);

  const unknownKey = await call('POST /api/companion-memory/settings', {
    body: { patch: { embeddingApiKeys: 'sk-whatever-1234' } },
  });
  assert.equal(unknownKey.response.status, 400);

  // 失败的那几次一律不落盘；中间成功的那一次（provider=local、清空模型）除外。
  const configAfter = readJson(configFile());
  assert.equal(configAfter.embedding.baseUrl, 'https://api.example.com/v1');
  assert.equal(configAfter.embedding.provider, 'local');
  assert.equal(configAfter.embedding.model, '');
  assert.equal(configAfter.rerank.baseUrl, 'https://rerank.example.com');
  assert.equal(fs.readFileSync(remoteModelsFile(), 'utf8'), secretsBefore);

  // 恢复成 remote 模式，供后面的探测用例使用。
  await call('POST /api/companion-memory/settings', {
    body: { patch: { embeddingProvider: 'remote', embeddingModel: 'text-embedding-3-small' } },
  });
  assert.ok(configBefore.length > 0);
});

test('settings POST 用 null 清除 key，空串表示不改', async () => {
  const cleared = await call('POST /api/companion-memory/settings', {
    body: { patch: { rerankApiKey: null } },
  });
  assert.equal(cleared.json.ok, true);
  assert.ok(cleared.json.data.changed.includes('rerankApiKey'));
  assert.equal(readJson(remoteModelsFile()).rerank.apiKey, '');
  assert.equal(readJson(remoteModelsFile()).embedding.apiKey, 'sk-embedding-test-key-123456');

  const flagged = await call('GET /api/companion-memory/settings');
  assert.equal(flagged.json.data.rerankKeySet, false);
  assert.equal(flagged.json.data.embeddingKeySet, true);

  // 空串 = 不改：既不报错，也不清掉已有 key。
  const untouched = await call('POST /api/companion-memory/settings', {
    body: { patch: { embeddingApiKey: '' } },
  });
  assert.equal(untouched.json.ok, true);
  assert.equal(untouched.json.data.changed.includes('embeddingApiKey'), false);
  assert.equal(readJson(remoteModelsFile()).embedding.apiKey, 'sk-embedding-test-key-123456');

  // 恢复 rerank key，后面的探测用例需要它。
  await call('POST /api/companion-memory/settings', {
    body: { patch: { rerankApiKey: 'sk-rerank-test-key-abcdefgh' } },
  });
});

test('settings/test 用最小请求探测向量端点，错误码固定且不回显 key', async () => {
  // 1) 正常：草稿里带地址/模型/维度，key 用磁盘上已保存的。
  const calls = [];
  const ok = await probe({ target: 'embedding', draft: {
    provider: 'remote', baseUrl: 'https://probe.example.com/v1', model: 'probe-embed', dimensions: 256,
  } }, (url, init) => {
    calls.push({ url, init });
    return jsonResponse(200, { model: 'probe-embed', data: [{ embedding: new Array(256).fill(0.01) }] });
  });
  assert.equal(ok.json.ok, true);
  assert.equal(ok.json.data.ok, true);
  assert.equal(ok.json.data.target, 'embedding');
  assert.equal(ok.json.data.dimensions, 256);
  assert.equal(ok.json.data.model, 'probe-embed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://probe.example.com/v1/embeddings');
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk-embedding-test-key-123456');
  assert.deepEqual(JSON.parse(calls[0].init.body), { model: 'probe-embed', input: ['ping'] });

  // 2) 草稿里刚粘贴、还没保存的 key 可以直接用来探测，但绝不回显、也不落盘。
  let captured = null;
  const draftKey = await probe({ target: 'embedding', draft: {
    provider: 'remote', baseUrl: 'https://probe.example.com', model: 'm2', dimensions: 512,
    apiKey: 'sk-draft-only-key-0001',
  } }, (url, init) => {
    captured = init;
    return jsonResponse(200, { data: [{ embedding: new Array(512).fill(0.02) }] });
  });
  assert.equal(draftKey.json.data.ok, true);
  assert.equal(captured.headers.authorization, 'Bearer sk-draft-only-key-0001');
  assert.equal(JSON.stringify(draftKey.json).includes('sk-draft-only'), false);
  assert.equal(readJson(remoteModelsFile()).embedding.apiKey, 'sk-embedding-test-key-123456');

  // 3) 维度不一致：把实际维度带回去，UI 才能提示改成多少。
  const mismatch = await probe({ target: 'embedding', draft: {
    provider: 'remote', baseUrl: 'https://probe.example.com', model: 'm3', dimensions: 1024,
  } }, () => jsonResponse(200, { data: [{ embedding: new Array(384).fill(0.03) }] }));
  assert.equal(mismatch.json.data.ok, false);
  assert.equal(mismatch.json.data.error, 'dimension-mismatch');
  assert.equal(mismatch.json.data.dimensions, 384);

  // 4) 鉴权失败 / 网络不可达 / 响应形状不对。
  const unauthorized = await probe({ target: 'embedding', draft: { provider: 'remote' } },
    () => jsonResponse(401, { error: 'bad key' }));
  assert.equal(unauthorized.json.data.error, 'http-401');

  const forbidden = await probe({ target: 'embedding', draft: { provider: 'remote' } },
    () => jsonResponse(403, { error: 'forbidden' }));
  assert.equal(forbidden.json.data.error, 'http-403');

  const network = await probe({ target: 'embedding', draft: { provider: 'remote' } },
    () => { throw new Error('ECONNREFUSED'); });
  assert.equal(network.json.data.error, 'network');

  const shape = await probe({ target: 'embedding', draft: { provider: 'remote' } },
    () => jsonResponse(200, { nope: true }));
  assert.equal(shape.json.data.error, 'bad-shape');

  // 5) 没配置（本地向量 / 关闭）与缺 key。
  const local = await probe({ target: 'embedding', draft: { provider: 'off' } }, () => {
    throw new Error('不应发出请求');
  });
  assert.equal(local.json.data.error, 'not-configured');

  await call('POST /api/companion-memory/settings', { body: { patch: { embeddingApiKey: null } } });
  const noKey = await probe({ target: 'embedding', draft: { provider: 'remote' } }, () => {
    throw new Error('不应发出请求');
  });
  assert.equal(noKey.json.data.error, 'no-key');
  await call('POST /api/companion-memory/settings', {
    body: { patch: { embeddingApiKey: 'sk-embedding-test-key-123456' } },
  });
});

test('settings/test 探测重排序端点，覆盖成功、404 与超时', async () => {
  // 1) 正常：走 /v1/rerank，返回 relevance_score。
  const calls = [];
  const ok = await probe({ target: 'rerank' }, (url, init) => {
    calls.push({ url, init });
    return jsonResponse(200, {
      model: 'bge-reranker-v2-m3',
      results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.1 }],
    });
  });
  assert.equal(ok.json.data.ok, true, JSON.stringify(ok.json));
  assert.equal(ok.json.data.target, 'rerank');
  assert.equal(ok.json.data.model, 'bge-reranker-v2-m3');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://rerank.example.com/v1/rerank');
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk-rerank-test-key-abcdefgh');
  const payload = JSON.parse(calls[0].init.body);
  assert.equal(payload.model, 'bge-reranker-v2-m3');
  assert.equal(payload.query, 'ping');
  assert.equal(payload.documents.length, 2);
  assert.equal(JSON.stringify(ok.json).includes('sk-rerank-test'), false);

  // 2) 两个候选 URL 都 404：最终收敛成固定 http-4xx。
  const notFound = await probe({ target: 'rerank' }, () => jsonResponse(404, { error: 'no route' }));
  assert.equal(notFound.json.data.ok, false);
  assert.equal(notFound.json.data.error, 'http-4xx');

  // 3) 形状不对。
  const shape = await probe({ target: 'rerank' }, () => jsonResponse(200, { nope: true }));
  assert.equal(shape.json.data.error, 'bad-shape');

  // 4) 超时：用最小 timeoutMs（500ms）跑一次真的 abort。
  const started = Date.now();
  const timeout = await probe({ target: 'rerank', draft: { timeoutMs: 500 } }, (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    });
  }));
  assert.equal(timeout.json.data.error, 'timeout');
  assert.ok(Date.now() - started >= 400);

  // 5) 未配置与非法目标。
  const off = await probe({ target: 'rerank', draft: { provider: 'off' } }, () => {
    throw new Error('不应发出请求');
  });
  assert.equal(off.json.data.error, 'not-configured');

  const bad = await probe({ target: 'wiki' }, () => {
    throw new Error('不应发出请求');
  });
  assert.equal(bad.response.status, 400);
  assert.equal(bad.json.error.code, 'bad-request');
});

// ---------------------------------------------------------------------------
// 维护
// ---------------------------------------------------------------------------

test('maintenance 支持 integrity/rebuild，extract 需要对话上下文', async () => {
  const integrity = await call('POST /api/companion-memory/maintenance', { body: { action: 'integrity' } });
  assert.equal(integrity.json.ok, true);
  assert.equal(integrity.json.data.action, 'integrity');
  assert.equal(integrity.json.data.result.ok, true);
  assert.deepEqual(integrity.json.data.result.messages, []);

  const rebuild = await call('POST /api/companion-memory/maintenance', { body: { action: 'rebuild' } });
  assert.equal(rebuild.json.ok, true);
  assert.ok(rebuild.json.data.result.search.memories >= 9);
  assert.equal(rebuild.json.data.result.wiki.compiled, true);
  assert.ok(rebuild.json.data.result.embeddings);

  const extract = await call('POST /api/companion-memory/maintenance', { body: { action: 'extract' } });
  assert.equal(extract.response.status, 400);
  assert.equal(extract.json.error.code, 'bad-request');
  assert.match(extract.json.error.message, /对话/);

  const unknown = await call('POST /api/companion-memory/maintenance', { body: { action: 'nope' } });
  assert.equal(unknown.response.status, 400);
});

// ---------------------------------------------------------------------------
// 写入
// ---------------------------------------------------------------------------

test('revise 更新正文、递增 revision、刷新 FTS 与修订记录', async () => {
  const before = await call('GET /api/companion-memory/memory', { search: `?id=${state.ids.practice.id}` });
  assert.equal(before.json.data.value, '用户计划学习指弹吉他');

  const { json } = await call('POST /api/companion-memory/memory', {
    body: {
      id: state.ids.practice.id,
      action: 'revise',
      value: '用户计划学习指弹与古典吉他',
      reason: 'studio-ui',
    },
  });
  assert.equal(json.ok, true);
  assert.equal(json.data.id, state.ids.practice.id);
  assert.equal(json.data.status, 'confirmed');
  assert.equal(json.data.revision, before.json.data.revision + 1);

  const detail = await call('GET /api/companion-memory/memory', { search: `?id=${state.ids.practice.id}` });
  assert.equal(detail.json.data.value, '用户计划学习指弹与古典吉他');
  assert.equal(detail.json.data.revisions.length, 1);
  assert.equal(detail.json.data.revisions[0].operation, 'update');

  const search = await call('GET /api/companion-memory/memories', {
    search: `?query=${encodeURIComponent('古典吉他')}`,
  });
  assert.ok(search.json.data.items.some(item => item.id === state.ids.practice.id));

  // 同值重复提交不升 revision（updateMemory 内部的不动点判断）。
  const again = await call('POST /api/companion-memory/memory', {
    body: { id: state.ids.practice.id, action: 'revise', value: '用户计划学习指弹与古典吉他' },
  });
  assert.equal(again.json.data.revision, json.data.revision);
});

test('revise 拒绝空值、超长内容与疑似密钥', async () => {
  const empty = await call('POST /api/companion-memory/memory', {
    body: { id: state.ids.practice.id, action: 'revise', value: '   ' },
  });
  assert.equal(empty.response.status, 400);

  const tooLong = await call('POST /api/companion-memory/memory', {
    body: { id: state.ids.practice.id, action: 'revise', value: '长'.repeat(3000) },
  });
  assert.equal(tooLong.response.status, 400);

  const secret = await call('POST /api/companion-memory/memory', {
    body: { id: state.ids.practice.id, action: 'revise', value: 'api_key: sk-abcdefghijklmnop' },
  });
  assert.equal(secret.response.status, 400);
  assert.match(secret.json.error.message, /密钥/);
});

test('policy/archive/restore/delete 改变状态但不物理删除', async () => {
  const policy = await call('POST /api/companion-memory/memory', {
    body: { id: state.ids.tea.id, action: 'policy', policy: 'soft_echo' },
  });
  assert.equal(policy.json.ok, true);
  let detail = await call('GET /api/companion-memory/memory', { search: `?id=${state.ids.tea.id}` });
  assert.equal(detail.json.data.policy, 'soft_echo');

  const archive = await call('POST /api/companion-memory/memory', {
    body: { id: state.ids.tea.id, action: 'archive' },
  });
  assert.equal(archive.json.data.status, 'archived');
  detail = await call('GET /api/companion-memory/memory', { search: `?id=${state.ids.tea.id}` });
  assert.equal(detail.json.data.status, 'archived');

  const restore = await call('POST /api/companion-memory/memory', {
    body: { id: state.ids.tea.id, action: 'restore' },
  });
  assert.equal(restore.json.data.status, 'confirmed');

  const remove = await call('POST /api/companion-memory/memory', {
    body: { id: state.ids.tea.id, action: 'delete' },
  });
  assert.equal(remove.json.data.status, 'retracted');
  detail = await call('GET /api/companion-memory/memory', { search: `?id=${state.ids.tea.id}` });
  assert.equal(detail.json.ok, true);
  assert.equal(detail.json.data.status, 'retracted');

  const badPolicy = await call('POST /api/companion-memory/memory', {
    body: { id: state.ids.practice.id, action: 'policy', policy: 'shout' },
  });
  assert.equal(badPolicy.response.status, 400);

  const badAction = await call('POST /api/companion-memory/memory', {
    body: { id: state.ids.practice.id, action: 'explode' },
  });
  assert.equal(badAction.response.status, 400);
});

// ---------------------------------------------------------------------------
// Wiki
// ---------------------------------------------------------------------------

test('wiki 列表返回四个主题页与目录', async () => {
  const { json } = await call('GET /api/companion-memory/wiki');
  assert.equal(json.ok, true);
  assert.equal(json.data.pages.length, 4);
  assert.equal(json.data.topics.length, 4);
  assert.ok(json.data.dir.includes('wiki'));
  const profile = json.data.pages.find(page => page.pageId === 'user-profile');
  assert.ok(profile);
  assert.ok(profile.revision >= 0);
  assert.equal(profile.status, 'compiled');
});

test('wiki-page 读取整页，notes 只改人工区且保留生成区', async () => {
  const first = await call('GET /api/companion-memory/wiki-page', { search: '?page=user-profile' });
  assert.equal(first.json.ok, true);
  assert.equal(first.json.data.exists, true);
  assert.ok(first.json.data.content.includes('<!-- generated:begin'));
  assert.ok(first.json.data.generatedBytes > 0);
  assert.equal(first.json.data.manualNotes, '');

  const beginMarker = '<!-- generated:begin';
  const endMarker = '<!-- generated:end -->';
  const generatedSlice = content => {
    const start = content.indexOf(beginMarker);
    const end = content.indexOf(endMarker) + endMarker.length;
    return content.slice(start, end);
  };
  const beforeGenerated = generatedSlice(first.json.data.content);

  const written = await call('POST /api/companion-memory/wiki-page', {
    body: { pageId: 'user-profile', notes: '这里是我的手写备注。' },
  });
  assert.equal(written.json.ok, true);
  assert.equal(written.json.data.notes, '这里是我的手写备注。');

  const second = await call('GET /api/companion-memory/wiki-page', { search: '?page=user-profile' });
  assert.equal(second.json.data.manualNotes, '这里是我的手写备注。');
  assert.equal(generatedSlice(second.json.data.content), beforeGenerated, '生成区必须逐字保留');
  assert.ok(second.json.data.content.includes('<!-- manual:begin -->'));
  assert.equal(second.json.data.notes, '这里是我的手写备注。');

  // 清空人工区同样只动 manual 段。
  await call('POST /api/companion-memory/wiki-page', { body: { pageId: 'user-profile', notes: '' } });
  const third = await call('GET /api/companion-memory/wiki-page', { search: '?page=user-profile' });
  assert.equal(third.json.data.manualNotes, '');
  assert.equal(generatedSlice(third.json.data.content), beforeGenerated);

  // 控制标记不能被用户输入伪造。
  await call('POST /api/companion-memory/wiki-page', {
    body: { pageId: 'user-profile', notes: '<!-- generated:end --> 伪造区' },
  });
  const fourth = await call('GET /api/companion-memory/wiki-page', { search: '?page=user-profile' });
  assert.equal(fourth.json.data.content.match(/<!-- generated:end -->/g).length, 1);
  assert.equal(fourth.json.data.content.includes('伪造区'), true);

  const unknown = await call('GET /api/companion-memory/wiki-page', { search: '?page=no-such-page' });
  assert.equal(unknown.response.status, 404);
});

// ---------------------------------------------------------------------------
// 时间线
// ---------------------------------------------------------------------------

test('timeline 只返回短预览，不含完整正文', async () => {
  const { json } = await call('GET /api/companion-memory/timeline', { search: '?limit=10' });
  assert.equal(json.ok, true);
  assert.ok(json.data.items.length >= 2);
  for (const item of json.data.items) {
    assert.ok(Number.isFinite(Date.parse(item.at)));
    assert.ok(item.preview.length <= 160);
    assert.equal(Object.hasOwn(item, 'content'), false);
    assert.equal(item.hidden, false);
    assert.ok(item.sessionId);
    assert.ok(Number.isFinite(item.seq));
    assert.ok(item.type);
    assert.ok(item.role);
  }

  const onlyAssistant = await call('GET /api/companion-memory/timeline', { search: '?limit=10&kind=assistant' });
  assert.ok(onlyAssistant.json.data.items.length >= 1);
  assert.ok(onlyAssistant.json.data.items.every(item => item.role === 'assistant'));
});

// ---------------------------------------------------------------------------
// 注册与降级
// ---------------------------------------------------------------------------

test('registerStudioApi 在没有 connection 时静默跳过', async () => {
  const none = await registerStudioApi({ get: () => undefined }, { engine: state.engine, identity: state.identity, root: state.root });
  assert.deepEqual(none, { registered: 0, skipped: 'no-connection' });

  const noGet = await registerStudioApi({}, { engine: state.engine });
  assert.deepEqual(noGet, { registered: 0, skipped: 'no-connection' });
});

test('registerStudioApi 按路径合并注册，同路径 GET/POST 都能调用', async () => {
  const registered = [];
  const labels = [];
  const ctx = {
    get: name => (name === 'connection'
      ? { fetch: { register: route => { registered.push(route); return () => {}; } } }
      : undefined),
    effect: (runner, label) => { labels.push(label); return runner(); },
  };
  const result = await registerStudioApi(ctx, { engine: state.engine, identity: state.identity, root: state.root });
  // Connection 的 Exact Fetch 登记表按 path 去重：同一路径只能登记一条路由。
  // 期望值取自服务端实际注册的完整路径表（记忆 + 健康；健康路由按契约 §13 无条件挂载），
  // 不再从 `ROUTES` 推导，也不再写死数字。
  const uniquePaths = [...new Set(result.paths)];
  assert.equal(result.registered, uniquePaths.length);
  assert.equal(registered.length, uniquePaths.length);
  assert.equal(labels.length, uniquePaths.length);
  assert.equal(new Set(registered.map(route => route.path)).size, uniquePaths.length);
  // 健康路径确实在这张表里（不是一个只有记忆路由的旧表）。
  assert.ok(uniquePaths.includes('/api/companion-health/status'));
  assert.ok(uniquePaths.includes('/api/companion-health/sync'));
  assert.ok(labels.every(label => label.startsWith('companion-memory-studio:')));

  const summary = registered.find(route => route.path === '/api/companion-memory/summary');
  assert.deepEqual(summary.methods, ['GET']);
  assert.equal(summary.requestBody, 'buffered');
  const response = await summary.fetch(new Request('http://studio.local/api/companion-memory/summary'));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  // 同路径另一个方法必须返回 405，而不是掉进 404 或误跑 GET 处理器。
  const wrongMethod = await summary.fetch(new Request('http://studio.local/api/companion-memory/summary', { method: 'POST' }));
  assert.equal(wrongMethod.status, 405);
  assert.equal((await wrongMethod.json()).ok, false);

  const memory = registered.find(route => route.path === '/api/companion-memory/memory');
  assert.deepEqual([...memory.methods].sort(), ['GET', 'POST']);
  const detail = await memory.fetch(new Request('http://studio.local/api/companion-memory/memory?id=mem_missing'));
  // 不存在的记忆：允许 200+ok:false 或 404，但绝不能是 500 或成功。
  assert.ok([200, 404].includes(detail.status));
  assert.equal((await detail.json()).ok, false);
  const writeResult = await memory.fetch(new Request('http://studio.local/api/companion-memory/memory', {
    method: 'POST',
    body: JSON.stringify({ id: 'mem_missing', action: 'archive' }),
    headers: { 'content-type': 'application/json' },
  }));
  assert.ok([200, 404].includes(writeResult.status));
  assert.equal((await writeResult.json()).ok, false);
});

test('db 为 null 时所有接口返回 db-unavailable 信封（HTTP 200）', async () => {
  const fakeEngine = {
    version: '0.0.0',
    internal: async () => ({
      db: null,
      config: {},
      configPath: '',
      databaseFile: '',
      wikiDir: '',
      viewer: () => ({ userId: USER_ID, personaId: PERSONA_ID, worldId: '' }),
    }),
  };
  const handlers = createStudioHandlers({ engine: fakeEngine, identity: null, root: '' });
  for (const key of [
    'GET /api/companion-memory/summary',
    'GET /api/companion-memory/memories',
    'GET /api/companion-memory/settings',
    'GET /api/companion-memory/reviews',
    'POST /api/companion-memory/maintenance',
  ]) {
    const init = { method: key.split(' ')[0] };
    if (init.method === 'POST') {
      init.body = JSON.stringify({ action: 'integrity' });
      init.headers = { 'content-type': 'application/json' };
    }
    const response = await handlers[key](new Request(urlFor(key), init));
    assert.equal(response.status, 200, key);
    const body = await response.json();
    assert.equal(body.ok, false, key);
    assert.equal(body.error.code, 'db-unavailable', key);
  }

  const noEngine = createStudioHandlers({});
  const response = await noEngine['GET /api/companion-memory/summary'](
    new Request('http://studio.local/api/companion-memory/summary'),
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).error.code, 'db-unavailable');
});
