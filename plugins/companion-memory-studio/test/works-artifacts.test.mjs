import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  workStatusOf, titleOf, typeOf, previewableOf, resolveArtifactRoot,
  buildWorksIndex, filterWorks, readWorkPreview, MAX_PREVIEW_BYTES,
} from '../lib/works-artifacts.mjs';

// W3 的读取层：状态判据、路径 fail-closed、搜索过滤、预览三道闸。
// 全部离线：临时目录 + 临时 SQLite，绝不碰真实 data/。

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'works-'));
}

const SCOPE = 'persona:bot|user:u1|world:world:default';

/** 造一个最小的 runtime DB，只放工作集需要的两张表与列。 */
function seedRuntime(root, rows) {
  const dir = path.join(root, 'home/companion');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'companion-runtime.db');
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
  const insertActivity = db.prepare(`
    INSERT INTO p2_activities (activity_id, scope, kind, adapter, reality, status, target, artifact_ref,
      artifact_version, artifact_hash, total_units, consumed_prefix, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?)
  `);
  const insertReceipt = db.prepare(`
    INSERT INTO p2_activity_receipts (receipt_id, activity_id, scope, operation, ok, code, at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of rows) {
    insertActivity.run(
      row.activityId, SCOPE, row.kind || 'write', row.adapter || 'write',
      row.reality || 'actual_tool_activity', row.status || 'done',
      row.ref || '', row.version ?? 1, row.hash ?? null,
      row.totalUnits ?? 100, row.consumed ?? 100,
      row.updatedAt ?? 1761600000000,
    );
    for (const receipt of row.receipts || []) {
      insertReceipt.run(
        `${row.activityId}-${receipt.operation}-${receipt.ok ? 'ok' : 'fail'}`,
        row.activityId, SCOPE, receipt.operation, receipt.ok ? 1 : 0, receipt.code || null,
        row.updatedAt ?? 1761600000000,
      );
    }
  }
  db.close();
  return file;
}

/** 造一个 artifactRoot + 配置，让 resolveArtifactRoot 指向它。 */
function seedWorkspace(root, files) {
  const worksDir = path.join(root, 'home/companion/works');
  fs.mkdirSync(worksDir, { recursive: true });
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(worksDir, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  fs.writeFileSync(path.join(root, 'home/companion/runtime.config.json'),
    JSON.stringify({ p2: { activities: { artifactRoot: 'home/companion/works' } } }), 'utf8');
  return worksDir;
}

test('status is decided by receipts, never by "the file exists"', () => {
  const activity = { activity_id: 'a1', status: 'done', adapter: 'write' };
  // 没有收据 → 不标「已完成」。
  assert.equal(workStatusOf(activity, []), 'review');
  // 有 ok 的 finish 收据才是真的完成。
  assert.equal(workStatusOf(activity, [{ activity_id: 'a1', operation: 'finish', ok: 1 }]), 'done');
  // 有失败收据 → 失败（即使 status 写着 done）。
  assert.equal(workStatusOf(activity, [{ activity_id: 'a1', operation: 'finish', ok: 0, code: 'workspace-denied' }]), 'failed');
  // 别的 activity 的收据不算数。
  assert.equal(workStatusOf(activity, [{ activity_id: 'a2', operation: 'finish', ok: 1 }]), 'review');
  // 运行中 / 暂停 → 进行中。
  assert.equal(workStatusOf({ activity_id: 'a3', status: 'running' }, []), 'running');
  assert.equal(workStatusOf({ activity_id: 'a3', status: 'paused' }, []), 'running');
  // 放弃 → 草稿。
  assert.equal(workStatusOf({ activity_id: 'a4', status: 'abandoned' }, []), 'draft');
});

test('title, type and preview gates are derived, not guessed', () => {
  assert.equal(titleOf('bot/chat-1/雨天.md'), '雨天');
  assert.equal(titleOf('bot\\chat-1\\雨天.txt'), '雨天');
  assert.equal(titleOf(''), '(未命名)');
  assert.equal(typeOf('a.MD'), 'md', '扩展名大小写归一');
  assert.equal(typeOf('noext'), 'unknown');
  assert.deepEqual(previewableOf('a.md', 100), { ok: true, reason: '' });
  assert.deepEqual(previewableOf('a.exe', 100), { ok: false, reason: 'unsupported-type' });
  assert.deepEqual(previewableOf('a.md', MAX_PREVIEW_BYTES + 1), { ok: false, reason: 'too-large' });
  assert.deepEqual(previewableOf('a.md', -1), { ok: false, reason: 'stat-unavailable' });
});

test('an index lists only referenced, in-root, existing files and never exposes absolute paths', () => {
  const root = tmpRoot();
  try {
    seedWorkspace(root, {
      'bot/c1/a.md': '# 一\n',
      'bot/c1/b.txt': '二\n',
      // 二进制类型：不该出现在"可预览"里，但仍在列表（只标 preview.ok=false）。
      'bot/c1/c.bin': 'x',
    });
    seedRuntime(root, [
      { activityId: 'a1', ref: 'bot/c1/a.md', receipts: [{ operation: 'finish', ok: 1 }] },
      { activityId: 'a2', ref: 'bot/c1/b.txt', receipts: [{ operation: 'review', ok: 1 }] },
      { activityId: 'a3', ref: 'bot/c1/c.bin', receipts: [{ operation: 'finish', ok: 1 }] },
      // 引用指向不存在的文件：跳过并计数。
      { activityId: 'a4', ref: 'bot/c1/missing.md', receipts: [] },
      // 越界引用：跳过并计数（由 runtime 判据拒绝）。
      { activityId: 'a5', ref: '../outside.md', receipts: [] },
      { activityId: 'a6', ref: '/etc/passwd', receipts: [] },
    ]);

    const index = buildWorksIndex({ root, scope: SCOPE });
    assert.equal(index.available, true);
    assert.equal(index.total, 3, `应有 3 份作品，实际 ${index.total}`);
    assert.equal(index.items.some((item) => item.relative === 'bot/c1/missing.md'), false);
    assert.equal(index.skipped >= 3, true, `跳过的计数不对：${JSON.stringify(index.skippedReasons)}`);
    assert.ok(index.skippedReasons['path-denied'] >= 2, '越界引用必须计入 path-denied');
    assert.ok(index.skippedReasons.missing >= 1);

    for (const item of index.items) {
      // 绝对路径绝不能出现在对外结构里。
      assert.equal(Object.hasOwn(item, 'absolute'), false);
      assert.equal(item.relative.includes(':\\'), false);
      assert.equal(item.relative.startsWith('/'), false);
    }
    // 状态来自收据：a.md 有 finish+ok → done；b.txt 只有 review → review。
    const a = index.items.find((item) => item.relative === 'bot/c1/a.md');
    const b = index.items.find((item) => item.relative === 'bot/c1/b.txt');
    assert.equal(a.status, 'done');
    assert.equal(a.evidence.finishReceipted, true);
    assert.equal(b.status, 'review');
    assert.equal(b.evidence.finishReceipted, false);
    // 不可预览的类型要在列表里标出来。
    const c = index.items.find((item) => item.relative === 'bot/c1/c.bin');
    assert.deepEqual(c.preview, { ok: false, reason: 'unsupported-type' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a missing artifact root is reported as unavailable, not as an empty list', () => {
  const root = tmpRoot();
  try {
    seedRuntime(root, []);
    // 不建 works 目录，也不写配置 → 用默认相对路径，目录不存在。
    const index = buildWorksIndex({ root, scope: SCOPE });
    assert.equal(index.available, false);
    assert.equal(index.reason, 'artifact-root-missing');
    assert.equal(index.items.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a missing runtime DB is reported, and the root still resolves', () => {
  const root = tmpRoot();
  try {
    seedWorkspace(root, { 'bot/c1/a.md': '# x\n' });
    // 不建 DB。
    const index = buildWorksIndex({ root, scope: SCOPE });
    assert.equal(index.available, true, '作品目录在就算可用（只是没有证据）');
    assert.equal(index.evidence.available, false);
    assert.equal(index.evidence.reason, 'runtime-db-missing');
    assert.equal(index.total, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the same file written many times collapses into one row with a version count', () => {
  const root = tmpRoot();
  try {
    seedWorkspace(root, { 'bot/c1/a.md': '# v8\n' });
    const rows = [];
    for (let version = 1; version <= 8; version += 1) {
      rows.push({
        activityId: `a${version}`, ref: 'bot/c1/a.md', version,
        receipts: [{ operation: 'finish', ok: 1 }],
        updatedAt: 1761600000000 + version,
      });
    }
    seedRuntime(root, rows);
    const index = buildWorksIndex({ root, scope: SCOPE });
    assert.equal(index.total, 1, '同一份文件只占一行');
    assert.equal(index.items[0].version, 8, '取最新版本');
    assert.equal(index.items[0].otherVersions, 7);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('filter by title, type, status and date window', () => {
  const items = [
    { title: '雨天', relative: 'bot/c1/雨天.md', type: 'md', status: 'done', modifiedAt: '2026-11-16T09:00:00.000Z' },
    { title: '晴天', relative: 'bot/c1/晴天.txt', type: 'txt', status: 'review', modifiedAt: '2026-11-10T09:00:00.000Z' },
    { title: 'notes', relative: 'bot/c2/notes.md', type: 'md', status: 'failed', modifiedAt: '2026-10-01T09:00:00.000Z' },
  ];
  assert.equal(filterWorks(items, { q: '雨' }).length, 1);
  assert.equal(filterWorks(items, { q: 'c1' }).length, 2, '也能按相对路径搜');
  assert.equal(filterWorks(items, { type: 'md' }).length, 2);
  assert.equal(filterWorks(items, { status: 'review' }).length, 1);
  assert.equal(filterWorks(items, { from: '2026-11-01', to: '2026-11-30' }).length, 2);
  assert.equal(filterWorks(items, {}).length, 3);
  // 无法解析的日期不当作"命中全部"，而是被忽略（与 from/to 为空同义）。
  assert.equal(filterWorks(items, { from: 'not-a-date' }).length, 3);
});

test('preview refuses escape paths, symlinks, binaries and oversized files', () => {
  const root = tmpRoot();
  try {
    seedWorkspace(root, {
      'bot/c1/a.md': '# 正文\n',
      'bot/c1/big.md': 'x'.repeat(MAX_PREVIEW_BYTES + 10),
      'bot/c1/c.bin': 'binary',
    });
    seedRuntime(root, [
      { activityId: 'a1', ref: 'bot/c1/a.md', receipts: [{ operation: 'finish', ok: 1 }] },
    ]);

    const good = readWorkPreview({ root, scope: SCOPE, relative: 'bot/c1/a.md' });
    assert.equal(good.ok, true);
    assert.equal(good.text, '# 正文\n');
    assert.equal(good.status, 'done', '预览页也要带状态证据');
    assert.equal(good.evidence.finishReceipted, true);

    for (const bad of ['../outside.md', '/etc/passwd', 'C:\\Windows\\win.ini', 'bot/../../x.md', '']) {
      const result = readWorkPreview({ root, scope: SCOPE, relative: bad });
      assert.equal(result.ok, false, `必须拒绝：${bad}`);
      assert.equal(result.reason, 'path-denied', `拒绝理由不对：${bad} → ${result.reason}`);
    }

    const missing = readWorkPreview({ root, scope: SCOPE, relative: 'bot/c1/nope.md' });
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, 'missing');

    const big = readWorkPreview({ root, scope: SCOPE, relative: 'bot/c1/big.md' });
    assert.equal(big.ok, false);
    assert.equal(big.reason, 'too-large');
    // 拒绝时仍要给元信息，UI 才能说明"为什么读不了"。
    assert.equal(big.meta.size > MAX_PREVIEW_BYTES, true);
    assert.equal(big.meta.type, 'md');

    const bin = readWorkPreview({ root, scope: SCOPE, relative: 'bot/c1/c.bin' });
    assert.equal(bin.ok, false);
    assert.equal(bin.reason, 'unsupported-type');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a symlink pointing outside the root is refused', () => {
  const root = tmpRoot();
  try {
    seedWorkspace(root, { 'bot/c1/a.md': 'ok\n' });
    // 根外的真文件 + 根内的符号链接。
    const outside = path.join(root, 'secret.txt');
    fs.writeFileSync(outside, 'secret\n', 'utf8');
    const link = path.join(root, 'home/companion/works/bot/c1/link.md');
    try {
      fs.symlinkSync(outside, link);
    } catch {
      // 没有符号链接权限（Windows 需管理员/开发者模式）：跳过这一条，而不是假装通过。
      return;
    }
    const result = readWorkPreview({ root, scope: SCOPE, relative: 'bot/c1/link.md' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'symlink-escapes-root');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveArtifactRoot honors an absolute configured root', () => {
  const root = tmpRoot();
  try {
    const chosen = path.join(root, 'custom-works');
    fs.mkdirSync(chosen, { recursive: true });
    fs.mkdirSync(path.join(root, 'home/companion'), { recursive: true });
    fs.writeFileSync(path.join(root, 'home/companion/runtime.config.json'),
      JSON.stringify({ p2: { activities: { artifactRoot: chosen } } }), 'utf8');
    const resolved = resolveArtifactRoot(root);
    assert.equal(resolved.exists, true);
    assert.equal(path.isAbsolute(resolved.absolute), true);
    // 对外只回配置值，不回绝对路径。
    assert.equal(resolved.configured, chosen);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
