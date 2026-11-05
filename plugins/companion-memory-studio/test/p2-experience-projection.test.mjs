import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildExperience, buildLife, companionDashboard } from '../lib/companion-dashboard.mjs';

// P2.5-2 E7：UI 只读经历投影。
// 三件事各一组断言：
//   ① 投影本身的口径（完成/失败/跳过/待复核、running 不算经历、模拟要标出来）；
//   ② **零写语句**（把 `node:sqlite` 的 prepare/exec 全录下来，逐条判读；再比对数据库字节）；
//   ③ 空库给「暂无经历」，而不是让人看见一块空白。

const NOW = Date.UTC(2026, 10, 2, 6, 0, 0);

const ACTIVITY = (over = {}) => ({
  activity_id: 'a1', kind: 'read', adapter: 'file-read', reality: 'actual_tool_activity',
  status: 'done', target: 'sources/a.md', consumed_prefix: 10, total_units: 10,
  artifact_version: 0, source_hash: 'hash', started_at: NOW - 3000, paused_at: null,
  ended_at: NOW - 1000, updated_at: NOW - 1000, ...over,
});

// ── ① 投影口径 ──────────────────────────────────────────────────────────────

test('E7-1 四种结果各自认对：完成 / 失败 / 跳过 / 待复核', () => {
  const experience = buildExperience([
    ACTIVITY({ activity_id: 'ok', status: 'done', ended_at: NOW - 4000 }),
    ACTIVITY({ activity_id: 'bad', status: 'failed', kind: 'write', target: 'notes/b.md', ended_at: NOW - 3000 }),
    ACTIVITY({ activity_id: 'gone', status: 'abandoned', kind: 'explore', target: '某站', ended_at: NOW - 2000 }),
    ACTIVITY({ activity_id: 'wait', status: 'paused', ended_at: NOW - 1000 }),
  ], [], NOW);

  assert.equal(experience.authority, 'projection', '必须自报"这是投影"');
  assert.match(experience.note, /不是权威状态/);
  assert.deepEqual(experience.items.map(item => item.result), ['review', 'skipped', 'failed', 'completed'],
    '按时间倒序，且四种结果各自归位');
  assert.deepEqual(experience.items.map(item => item.resultLabel), ['待复核', '跳过', '失败', '完成']);
  assert.deepEqual(experience.counts, { completed: 1, failed: 1, skipped: 1, review: 1 });
  assert.equal(experience.items[3].target, 'sources/a.md', '目标要带上');
  assert.equal(experience.items[3].source, 'file-read', '来源要带上');
  assert.equal(experience.items[3].at, NOW - 4000, '时间要带上');
});

test('E7-2 回执优先于 status：finish ok=1 的 running 算完成，review ok=0 算待复核', () => {
  const experience = buildExperience([
    ACTIVITY({ activity_id: 'a-run', status: 'running', ended_at: 0, updated_at: NOW }),
    ACTIVITY({ activity_id: 'a-rev', status: 'running', ended_at: 0, updated_at: NOW - 500 }),
  ], [
    { activity_id: 'a-run', operation: 'finish', ok: 1, at: NOW },
    { activity_id: 'a-rev', operation: 'review', ok: 0, code: 'needs-human', at: NOW },
  ], NOW);
  assert.deepEqual(experience.items.map(item => [item.activityId, item.result]),
    [['a-run', 'completed'], ['a-rev', 'review']],
    '有回执就以回执为据，不能只看 status');
});

test('E7-3 还在跑的不算"经历"，模拟活动必须标出来', () => {
  const experience = buildExperience([
    ACTIVITY({ activity_id: 'live', status: 'running', ended_at: 0, updated_at: NOW }),
    ACTIVITY({ activity_id: 'fake', status: 'done', reality: 'simulated_world', ended_at: NOW - 1000 }),
  ], [], NOW);
  assert.deepEqual(experience.items.map(item => item.activityId), ['fake'], 'running 属于"现在在做"，不在这里');
  assert.equal(experience.items[0].simulated, true);
  assert.equal(experience.items[0].reality, 'simulated_world');
});

test('E7-4 空库：items 为空且给出「暂无经历」文案', () => {
  const experience = buildExperience([], [], NOW);
  assert.deepEqual(experience.items, []);
  assert.equal(experience.total, 0);
  assert.equal(experience.emptyNote, '暂无经历');
  assert.deepEqual(experience.counts, { completed: 0, failed: 0, skipped: 0, review: 0 });
  // 没有 sections 时也不能炸（新库/老库都可能缺这几段）。
  assert.deepEqual(buildExperience().items, []);
});

test('E7-5 life 视图带着 experience（页面从 life.experience 取）', () => {
  const life = buildLife({
    sections: {
      p2_plan: [], p2_slots: [],
      p2_activities: [ACTIVITY({ activity_id: 'a1', status: 'done', ended_at: NOW - 1000 })],
      p2_receipts: [],
      p2_share: [], p2_interests: [], p2_opportunities: [],
    },
  }, { p2: { planning: { enabled: true } } }, NOW);
  assert.equal(life.experience.authority, 'projection');
  assert.equal(life.experience.items.length, 1);
  assert.equal(life.experience.items[0].resultLabel, '完成');
});

// ── ② 零写语句（运行时证明） ────────────────────────────────────────────────

test('E7-6 投影与整个 dashboard 读取过程：一条写语句都没有，数据库字节不变', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-e7-'));
  const file = path.join(root, 'home/companion/companion-runtime.db');
  const kernel = { root, internal: async () => ({}), viewer: () => ({ userId: 'owner', personaId: 'bot' }), ok: x => x };
  const scope = 'u:owner|p:bot|w:world:default';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 建库与塞行用可写连接（这是测试自己的准备工作，不是被测代码做的）。
    const writer = new DatabaseSync(file);
    // 这张表要跟 `companion-runtime/lib/schema.sql` 的 `p2_activities` 对齐：dashboard 的
    // 查询会读 `checkpoint`（B 站进度在 json_extract 里），少一列整条查询会被跳过、
    // 面板静默变空。这里按真实列名插入，schema 再变时测试会当场红。
    writer.exec(`CREATE TABLE p2_activities (scope TEXT, activity_id TEXT, plan_slot_id TEXT, kind TEXT, adapter TEXT,
      capability TEXT, reality TEXT, status TEXT, target TEXT, consumed_prefix INTEGER, total_units INTEGER,
      artifact_version INTEGER, source_hash TEXT, checkpoint TEXT NOT NULL DEFAULT '{}', started_at INTEGER, paused_at INTEGER, ended_at INTEGER, updated_at INTEGER)`);
    writer.exec('CREATE TABLE p2_activity_receipts (scope TEXT, activity_id TEXT, operation TEXT, ok INTEGER, code TEXT, at INTEGER)');
    const insertActivity = writer.prepare(`INSERT INTO p2_activities
      (scope, activity_id, plan_slot_id, kind, adapter, capability, reality, status, target, consumed_prefix,
       total_units, artifact_version, source_hash, checkpoint, started_at, paused_at, ended_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    insertActivity.run(scope, 'a-done', null, 'read', 'file-read', null, 'actual_tool_activity', 'done', 'sources/a.md', 10, 10, 0, 'h', '{}', NOW - 5000, null, NOW - 1000, NOW - 1000);
    insertActivity.run(scope, 'a-fail', null, 'write', 'file-write', null, 'actual_tool_activity', 'failed', 'notes/b.md', 3, 10, 0, 'h', '{}', NOW - 4000, null, NOW - 2000, NOW - 2000);
    insertActivity.run(scope, 'a-review', null, 'read', 'file-read', null, 'actual_tool_activity', 'paused', 'c.md', 5, 10, 0, 'h', '{}', NOW - 3000, NOW - 2500, 0, NOW - 2500);
    writer.prepare('INSERT INTO p2_activity_receipts VALUES (?,?,?,?,?,?)').run(scope, 'a-done', 'finish', 1, null, NOW - 1000);
    writer.close();

    const bytesBefore = fs.readFileSync(file);

    // 把 node:sqlite 的入口全部录下来：被测代码执行过的每一条 SQL 都会被看到。
    const statements = [];
    const original = { prepare: DatabaseSync.prototype.prepare, exec: DatabaseSync.prototype.exec };
    DatabaseSync.prototype.prepare = function recordPrepare(sql, ...rest) {
      statements.push(String(sql));
      return original.prepare.call(this, sql, ...rest);
    };
    DatabaseSync.prototype.exec = function recordExec(sql, ...rest) {
      statements.push(String(sql));
      return original.exec.call(this, sql, ...rest);
    };
    let result;
    try {
      result = await companionDashboard(null, kernel);
    } finally {
      DatabaseSync.prototype.prepare = original.prepare;
      DatabaseSync.prototype.exec = original.exec;
    }

    assert.ok(statements.length > 0, '应当真的读过库（否则这条测试什么都没证明）');
    const writes = statements.filter(sql => /(^|\s)(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|VACUUM|ATTACH)\s/i.test(sql));
    assert.deepEqual(writes, [], `读取过程里出现了写语句：${writes.join(' | ')}`);
    const writeAttempts = statements.filter(sql => /^\s*INSERT\s+INTO\s+p2_/i.test(sql));
    assert.deepEqual(writeAttempts, [], 'p2_* 表被写过');

    const bytesAfter = fs.readFileSync(file);
    assert.equal(Buffer.compare(bytesBefore, bytesAfter), 0, '数据库字节必须一模一样');
    for (const suffix of ['-wal', '-journal', '-shm']) {
      assert.equal(fs.existsSync(file + suffix), false, `不许留下 ${suffix} 文件（说明有写事务）`);
    }

    // 顺带确认投影真的出来了（不是"没读库所以没写"）。按时间倒序：完成 → 失败 → 待复核。
    const experience = result.life.experience;
    assert.deepEqual(experience.items.map(item => item.resultLabel), ['完成', '失败', '待复核']);
    assert.equal(experience.counts.completed, 1);
    assert.equal(experience.counts.failed, 1);
    assert.equal(experience.counts.review, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── ③ 源码级护栏 ───────────────────────────────────────────────────────────

test('E7-7 源码护栏：dashboard 只开只读连接，且没有任何写 SQL', () => {
  const source = fs.readFileSync(new URL('../lib/companion-dashboard.mjs', import.meta.url), 'utf8');
  assert.match(source, /new DatabaseSync\(file, \{ readOnly: true \}\)/, '必须用只读连接');
  assert.ok(!/(^|\s)(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+TABLE|DROP\s+TABLE|ALTER\s+TABLE)/i.test(source),
    'dashboard 里不该出现写 SQL');
  // 查询串只允许 SELECT（这一段是"以后谁加了写语句，这条会红"的护栏）。
  const queries = [...source.matchAll(/'((?:SELECT|INSERT|UPDATE|DELETE)[^']*)'/g)].map(match => match[1]);
  assert.ok(queries.length >= 15, `应当找到查询串（实际 ${queries.length} 条）`);
  assert.deepEqual(queries.filter(sql => !/^\s*SELECT\s/i.test(sql)), [], '查询串里出现了非 SELECT');
});
