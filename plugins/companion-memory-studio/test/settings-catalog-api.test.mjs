import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { createMemoryEngine } from '../../companion-memory/index.mjs';
import { createStudioHandlers, API_PREFIX, ROUTES } from '../server.mjs';
import { CATALOG_META_KEYS, HOT_LEVELS, STATUSES, PERMISSIONS } from '../lib/settings-catalog.mjs';

// W1-3：`GET /settings-catalog` 的端到端行为。
// 打真引擎（临时 root），不打真实 data 目录、不发任何外网请求。

const USER_ID = 'u1';
const PERSONA_ID = 'bot';
const state = { root: '', engine: null, handlers: null };

function writeMemoryConfig(root) {
  const dir = path.join(root, 'home/companion');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory.config.json'), JSON.stringify({
    schemaVersion: 1,
    backend: 'sqlite',
    database: 'home/memory/companion-memory.db',
    // 故意写两个键：目录应把它们报成 configured，没写的报 default。
    retrieval: { topK: 6, semanticEnabled: true },
  }, null, 2));
  // **哨兵**：把密钥明文真的写进权威密钥文件，否则"目录不泄漏密钥"这条断言恒真
  // （审查报告 M12：夹具从没把哨兵写进任何密钥文件，`includes(...) === false` 永远成立）。
  // 位置与形状必须走 companion-memory 自己的约定 —— 目录的 `secretSetOf()` 读的就是这一份。
  fs.writeFileSync(path.join(dir, 'remote-models.json'), JSON.stringify({
    embedding: { apiKey: '' },
    rerank: { apiKey: 'sk-test-secret-value' },
  }, null, 2));
}

function call(route, { method = 'GET', body, query = '' } = {}) {
  const key = `${method} ${API_PREFIX}/${route}`;
  const handler = state.handlers[key];
  assert.ok(handler, `路由缺失：${key}`);
  const url = `http://localhost${API_PREFIX}/${route}${query}`;
  return handler(new Request(url, {
    method,
    ...(body ? { body: JSON.stringify(body) } : {}),
  }));
}

async function json(route, options) {
  const response = await call(route, options);
  return { status: response.status, ...(await response.json()) };
}

before(async () => {
  state.root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-catalog-'));
  writeMemoryConfig(state.root);
  const identity = {
    owner: () => ({ id: USER_ID, displayName: '测试', platform: 'desktop' }),
    resolve: () => ({ userId: USER_ID, displayName: '测试' }),
  };
  state.engine = createMemoryEngine({ root: state.root, identity, env: {} });
  await state.engine.initialize();
  const internal = await state.engine.internal();
  assert.equal(internal.backend, 'sqlite', '目录测试也要跑在真 SQLite 后端上');
  state.handlers = createStudioHandlers({ engine: state.engine, identity, root: state.root });
});

after(async () => {
  try { await state.engine?.close?.(); } catch { /* 引擎收尾失败不影响结论 */ }
  try { fs.rmSync(state.root, { recursive: true, force: true }); } catch { /* Windows 文件锁 */ }
});

test('settings-catalog is registered as a read-only GET route', () => {
  assert.ok(ROUTES.some((route) => route.name === 'settings-catalog' && route.method === 'GET'));
  // 只有 GET：搜索不写配置，因此不该有同名 POST。
  assert.equal(ROUTES.some((route) => route.name === 'settings-catalog' && route.method === 'POST'), false);
});

test('catalog returns the mandated meta shape and never leaks stored secret values', async () => {
  const result = await json('settings-catalog');
  assert.equal(result.ok, true);
  assert.equal(result.data.catalog.metaKeys.length, CATALOG_META_KEYS.length);
  assert.ok(Array.isArray(result.data.matches));
  for (const match of result.data.matches) {
    assert.ok(HOT_LEVELS.includes(match.hotLevel), match.hotLevel);
    assert.ok(STATUSES.includes(match.status), match.status);
    assert.ok(PERMISSIONS.includes(match.permission), match.permission);
  }
  // 搜索结果是目录元信息，不是配置值：整包不能出现测试里写进配置的密钥字样。
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('sk-test-secret-value'), false);
  // 这条断言必须**非空**：哨兵真的写进了配置文件，而目录确实读到了它（状态变成
  // secret-set）—— 两件事都成立，"不泄漏"才是有意义的证据（审查报告 M12）。
  const secret = result.data.matches.find((match) => match.id === 'studio:rerankApiKey');
  assert.ok(secret, '目录里应该有 rerankApiKey 这一项（否则哨兵没被读到，断言恒真）');
  assert.equal(secret.status, 'secret-set', `目录没读到哨兵：${secret.status}`);
  assert.equal(secret.secret, true);
});

test('studio side reports configured vs default from the real config layer', async () => {
  const result = await json('settings-catalog', { query: '?kind=studio' });
  assert.equal(result.ok, true);
  const topK = result.data.matches.find((match) => match.id === 'studio:topK');
  assert.ok(topK, 'studio 侧应该有 retrieval.topK');
  assert.equal(topK.status, 'configured');
  const rrf = result.data.matches.find((match) => match.id === 'studio:rrfK');
  assert.ok(rrf, 'studio 侧应该有 retrieval.rrfK');
  assert.equal(rrf.status, 'default');
  // secrets 是只写字段：目录只报有没有，不给值。
  const secret = result.data.matches.find((match) => match.id === 'studio:embeddingApiKey');
  assert.equal(secret.secret, true);
  assert.ok(['secret-set', 'secret-unset'].includes(secret.status), secret.status);
});

test('catalog degrades honestly when one source is unavailable instead of inventing fields', async () => {
  const result = await json('settings-catalog', { query: '?kind=qq' });
  // QQ build 产物缺席时：404/400 都不该出现——要么加载，要么如实报 unavailable。
  if (result.ok === true) {
    assert.ok(result.data.catalog.totalFields >= 0);
    const source = result.data.catalog.sources.find((item) => item.source === 'qq-schema');
    assert.ok(source);
    assert.ok(['loaded', 'unavailable'].includes(source.status), source.status);
    if (source.status === 'unavailable') assert.equal(source.reason, 'qq-build-missing');
  } else {
    // 整个目录没有任何来源时才是 bad-request，且必须说明原因。
    assert.equal(result.error.code, 'bad-request');
    assert.match(result.error.message, /宿主安装与插件构建/);
  }
});

test('empty query returns a stable listing, and limit only trims the page', async () => {
  const all = await json('settings-catalog');
  const limited = await json('settings-catalog', { query: '?limit=3' });
  assert.equal(limited.data.matches.length, 3);
  assert.equal(limited.data.total, all.data.total);
  assert.ok(all.data.total > 0);
});

test('search finds a field by its Chinese label and reports a deep link', async () => {
  const result = await json('settings-catalog', { query: `?q=${encodeURIComponent('召回条数')}` });
  const top = result.data.matches[0];
  assert.ok(top, '应该能按别名「召回条数」命中');
  assert.equal(top.id, 'studio:topK');
  assert.equal(top.deepLink, 'studio:settings');
  assert.equal(top.path, 'retrieval.topK');
});

test('an unbound viewer is denied before any catalog work happens', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-catalog-denied-'));
  try {
    const handlers = createStudioHandlers({
      engine: { internal: () => ({ viewer: () => null }) },
      root,
    });
    const response = await handlers[`GET ${API_PREFIX}/settings-catalog`](
      new Request(`http://localhost${API_PREFIX}/settings-catalog`, { method: 'GET' }),
    );
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'denied');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
