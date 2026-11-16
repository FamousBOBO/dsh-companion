import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createMemoryEngine } from '../../companion-memory/index.mjs';
import { createStudioHandlers, API_PREFIX, ROUTES } from '../server.mjs';
import { buildWorksIndex } from '../lib/works-artifacts.mjs';
import { scopeKey } from '../../companion-runtime/lib/scope.mjs';

// W3 路由：只读、fail-closed、不暴露绝对路径。

const USER_ID = 'u1';
const PERSONA_ID = 'bot';
const state = { root: '', engine: null, handlers: null, worksDir: '' };

function writeMemoryConfig(root) {
  const dir = path.join(root, 'home/companion');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory.config.json'), JSON.stringify({
    schemaVersion: 1, backend: 'sqlite', database: 'home/memory/companion-memory.db',
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'runtime.config.json'), JSON.stringify({
    p2: { activities: { artifactRoot: 'home/companion/works' } },
  }, null, 2));
}

function seedRuntime(root, rows) {
  const file = path.join(root, 'home/companion/companion-runtime.db');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE p2_activities (
      activity_id TEXT PRIMARY KEY, scope TEXT NOT NULL, plan_slot_id TEXT, kind TEXT, adapter TEXT,
      capability TEXT, reality TEXT, status TEXT, target TEXT, source_ref TEXT, source_hash TEXT,
      total_units INTEGER, consumed_prefix INTEGER, checkpoint TEXT, artifact_ref TEXT,
      artifact_version INTEGER, artifact_hash TEXT, started_at INTEGER, paused_at INTEGER,
      ended_at INTEGER, created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE p2_activity_receipts (
      receipt_id TEXT PRIMARY KEY, activity_id TEXT, scope TEXT, operation TEXT, ok INTEGER,
      code TEXT, detail TEXT, source_hash TEXT, consumed_from INTEGER, consumed_to INTEGER,
      artifact_ref TEXT, at INTEGER, generation TEXT
    );
  `);
  const scope = scopeKey({ userId: USER_ID, personaId: PERSONA_ID, worldId: 'world:default' });
  const activity = db.prepare(`
    INSERT INTO p2_activities (activity_id, scope, kind, adapter, reality, status, target,
      artifact_ref, artifact_version, artifact_hash, total_units, consumed_prefix, updated_at)
    VALUES (?, ?, 'write', 'write', 'actual_tool_activity', ?, '', ?, ?, ?, 100, 100, ?)
  `);
  const receipt = db.prepare(`
    INSERT INTO p2_activity_receipts (receipt_id, activity_id, scope, operation, ok, code, at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of rows) {
    activity.run(row.activityId, scope, row.status || 'done', row.ref, row.version ?? 1,
      row.hash ?? 'a'.repeat(64), row.updatedAt ?? 1761600000000);
    for (const item of row.receipts || []) {
      receipt.run(`${row.activityId}-${item.operation}-${item.ok ? 'ok' : 'no'}`,
        row.activityId, scope, item.operation, item.ok ? 1 : 0, item.code || null, row.updatedAt ?? 1761600000000);
    }
  }
  db.close();
}

function call(route, query = '') {
  const handler = state.handlers[`GET ${API_PREFIX}/${route}`];
  assert.ok(handler, `路由缺失：${route}`);
  return handler(new Request(`http://localhost${API_PREFIX}/${route}${query}`, { method: 'GET' }));
}

before(async () => {
  state.root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-works-'));
  writeMemoryConfig(state.root);
  // 作品目录 + 两份文件。
  state.worksDir = path.join(state.root, 'home/companion/works');
  fs.mkdirSync(path.join(state.worksDir, 'bot/c1'), { recursive: true });
  fs.writeFileSync(path.join(state.worksDir, 'bot/c1/rain.md'), '# 雨天\n写了一点东西。\n', 'utf8');
  fs.writeFileSync(path.join(state.worksDir, 'bot/c1/sun.txt'), '晴天\n', 'utf8');

  const identity = {
    owner: () => ({ id: USER_ID, displayName: '测试', platform: 'desktop' }),
    resolve: () => ({ userId: USER_ID, displayName: '测试' }),
  };
  state.engine = createMemoryEngine({ root: state.root, identity, env: {}, personaId: PERSONA_ID });
  await state.engine.initialize();
  state.handlers = createStudioHandlers({ engine: state.engine, identity, root: state.root, personaId: PERSONA_ID });
});

after(async () => {
  try { await state.engine?.close?.(); } catch { /* 收尾失败不影响结论 */ }
  try { fs.rmSync(state.root, { recursive: true, force: true }); } catch { /* Windows 文件锁 */ }
});

test('works routes are registered as GET only', () => {
  for (const name of ['works', 'work-detail']) {
    assert.equal(ROUTES.some((route) => route.name === name && route.method === 'GET'), true, name);
    assert.equal(ROUTES.some((route) => route.name === name && route.method === 'POST'), false, `${name} 不该有 POST`);
  }
});

test('an empty evidence set yields an honest empty list, not a fake available:false', async () => {
  const body = await (await call('works')).json();
  assert.equal(body.ok, true);
  assert.equal(body.data.available, true, '作品目录存在 → available');
  assert.equal(body.data.evidence.available, false);
  assert.equal(body.data.evidence.reason, 'runtime-db-missing');
  assert.equal(body.data.total, 0);
});

test('the list carries status, evidence and no absolute paths', async () => {
  seedRuntime(state.root, [
    { activityId: 'a1', ref: 'bot/c1/rain.md', receipts: [{ operation: 'finish', ok: 1 }, { operation: 'review', ok: 1 }] },
    { activityId: 'a2', ref: 'bot/c1/sun.txt', receipts: [{ operation: 'review', ok: 1 }] },
  ]);

  const body = await (await call('works')).json();
  assert.equal(body.ok, true);
  assert.equal(body.data.total, 2);
  const serialized = JSON.stringify(body.data);
  assert.equal(serialized.includes(state.worksDir), false, '绝对路径绝不能出现在响应里');
  assert.equal(serialized.includes('C:\\'), false);

  const rain = body.data.items.find((item) => item.relative === 'bot/c1/rain.md');
  const sun = body.data.items.find((item) => item.relative === 'bot/c1/sun.txt');
  assert.equal(rain.status, 'done');
  assert.equal(rain.statusLabel, '已完成');
  assert.equal(rain.evidence.finishReceipted, true);
  assert.equal(rain.preview.ok, true);
  // 只有 review 收据的不标「已完成」。
  assert.equal(sun.status, 'review');
  assert.equal(sun.statusLabel, '待核对');
  assert.equal(sun.evidence.finishReceipted, false);
});

test('search and filters are applied server-side', async () => {
  // 标题取自文件名（不读正文），所以按文件名搜得到、按正文里的词搜不到——q=雨 不是期望的用法。
  const byQuery = await (await call('works', '?q=rain')).json();
  assert.equal(byQuery.data.total, 1);
  const byBody = await (await call('works', `?q=${encodeURIComponent('雨天')}`)).json();
  assert.equal(byBody.data.total, 0, '正文里的词不该命中：列表只索引文件名与相对路径');
  const byType = await (await call('works', '?type=txt')).json();
  assert.equal(byType.data.total, 1);
  const byStatus = await (await call('works', '?status=review')).json();
  assert.equal(byStatus.data.total, 1);
  // 非法 status 被忽略（回全量），而不是回 0。
  const junk = await (await call('works', '?status=nonsense')).json();
  assert.equal(junk.data.total, 2);
});

test('work-detail previews text and refuses escapes', async () => {
  const good = await (await call('work-detail', `?path=${encodeURIComponent('bot/c1/rain.md')}`)).json();
  assert.equal(good.ok, true);
  assert.equal(good.data.ok, true);
  assert.equal(good.data.text.startsWith('# 雨天'), true);
  assert.equal(good.data.status, 'done');
  assert.equal(good.data.evidence.finishReceipted, true);

  for (const bad of ['../outside.md', '/etc/passwd', 'C:\\Windows\\win.ini', 'bot/../../x.md']) {
    const body = await (await call('work-detail', `?path=${encodeURIComponent(bad)}`)).json();
    assert.equal(body.data.ok, false, `必须拒绝：${bad}`);
    assert.equal(body.data.reason, 'path-denied', `${bad} → ${body.data.reason}`);
  }

  // 文件存在但没有被本 scope 的 activity 引用：先授权再读正文，所以是 not-in-scope，
  // 不是 missing（后者会让人以为"文件不在"，掩盖了授权这一层）。
  const unrelated = await (await call('work-detail', '?path=bot/c1/other.md')).json();
  assert.equal(unrelated.data.ok, false);
  assert.equal(unrelated.data.reason, 'not-in-scope');

  const noPath = await (await call('work-detail')).json();
  assert.equal(noPath.data.ok, false);
  assert.equal(noPath.data.reason, 'path-required');
});

test('work-detail refuses a file that belongs to another scope, and never reads it', async () => {
  // 另一个 scope 的正文 + 没有被本 scope 任何 activity 引用。
  // `artifactRoot` 是所有 scope 共享的目录，所以"路径在根内"根本不等于"这是你的作品"。
  const otherScopeFile = path.join(state.worksDir, 'other-world/secret.md');
  fs.mkdirSync(path.dirname(otherScopeFile), { recursive: true });
  fs.writeFileSync(otherScopeFile, 'SCOPE-B-SECRET 只属于另一个 scope 的作品\n', 'utf8');

  for (const relative of ['other-world/secret.md', 'home/companion/remote-models.json']) {
    const body = await (await call('work-detail', `?path=${encodeURIComponent(relative)}`)).json();
    assert.equal(body.ok, true, '信封本身是 ok:true（HTTP 200）');
    assert.equal(body.data.ok, false, `${relative} 必须拒绝`);
    assert.equal(body.data.reason, 'not-in-scope', `${relative} → ${body.data.reason}`);
    // 关键：正文一个字节都不许回。
    assert.equal('text' in body.data, false, `${relative} 不该带 text 字段`);
    const serialized = JSON.stringify(body.data);
    assert.equal(serialized.includes('SCOPE-B-SECRET'), false, `${relative} 泄漏了另一个 scope 的正文`);
  }

  // 同一条断言在列表这一侧也成立：列表按 scope 过滤，看不到那个文件。
  const list = await (await call('works')).json();
  assert.equal(list.data.items.some((item) => item.relative === 'other-world/secret.md'), false);

  fs.rmSync(path.dirname(otherScopeFile), { recursive: true, force: true });
});

test('an absolute artifactRoot never reaches the browser', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-works-abs-'));
  try {
    const dir = path.join(root, 'home/companion');
    fs.mkdirSync(dir, { recursive: true });
    // 部署可以把它配成绝对本机路径（模块头允许，也确实是运行事实）。
    const absoluteRoot = path.join(root, 'absolute-works');
    fs.mkdirSync(absoluteRoot, { recursive: true });
    fs.writeFileSync(path.join(dir, 'runtime.config.json'), JSON.stringify({
      p2: { activities: { artifactRoot: absoluteRoot } },
    }, null, 2));

    const index = buildWorksIndex({ root, scope: scopeKey({ userId: USER_ID, personaId: PERSONA_ID }) });
    assert.equal(index.available, true);
    // 对外只说"配了绝对路径"，不说是哪一条。
    assert.equal(index.root.configured, '<绝对路径·仅服务端可见>');
    const serialized = JSON.stringify(index);
    assert.equal(serialized.includes(absoluteRoot), false, '绝对 artifactRoot 泄漏进了响应');
    assert.equal(serialized.includes(root), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an unbound viewer is denied on both works routes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-works-denied-'));
  try {
    const handlers = createStudioHandlers({
      engine: { internal: () => ({ viewer: () => null }) },
      root,
    });
    for (const route of ['works', 'work-detail']) {
      const response = await handlers[`GET ${API_PREFIX}/${route}`](
        new Request(`http://localhost${API_PREFIX}/${route}`, { method: 'GET' }),
      );
      const body = await response.json();
      assert.equal(body.ok, false, route);
      assert.equal(body.error.code, 'denied', route);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('total counts filtered hits while totalAll counts the whole directory', async () => {
  // 过滤命中 0 时，前端必须能说"过滤没命中"而不是"目录里没有作品"。
  // 只改措辞不够 —— 服务端得先把全量给出来。
  const all = await (await call('works')).json();
  // `call` 的 query 要单独传（路由名不带查询串）。
  const body = await (await call('works', '?q=' + encodeURIComponent('稳定不存在的词'))).json();
  assert.equal(body.ok, true);
  assert.equal(body.data.total, 0, '过滤命中有 0 条');
  assert.equal(body.data.totalAll, all.data.totalAll, '全量不随过滤变化');
  assert.ok(body.data.totalAll > 0, `目录里应当本来就有作品，实际 ${body.data.totalAll}`);
  // 反过来：没有过滤条件时两者相等。
  assert.equal(all.data.total, all.data.totalAll);
});
