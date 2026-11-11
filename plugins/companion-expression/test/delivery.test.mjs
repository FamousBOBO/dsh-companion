/**
 * delivery.mjs 的离线测试（E2 §3 / §6.3 / §12「群图出站」「断线不重复」）。
 *
 * 全部用假实现：假 library（只实现 getFileForDelivery 这一个窄接口）、假 qqSender（记录每次
 * 调用），数据库 `:memory:`，素材与 stage 目录都在 mkdtemp 里。**没有任何一个真实网络请求，
 * 也没有任何真实 QQ 调用。**
 *
 * 覆盖任务要求的验收点：
 *   - stage 必须落在 `home/media` 内（配置越界时回退默认目录，不是放宽守卫）；
 *   - 二次校验：作用域拒绝 / 实体文件缺失 / sha256 不符 / 冷却；
 *   - 文件缺失 → 退化纯文字（fail closed，且不二次选图）；
 *   - unknown 不重试，并且后续 part 停止（顺序错乱比少发一段更糟）；
 *   - 回执逐行落 `deliveries`，幂等键 UNIQUE：重放同一计划不会重发。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { openExpressionDb } from '../src/db.mjs';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { plan, partJobs } from '../src/planner.mjs';
import { quotaBucketFor } from '../src/decision.mjs';
import { groupScope, privateScope } from '../src/scopes.mjs';
import {
  DELIVERY_STATES, STAGE_PREFIX, alreadyDelivered, cleanStage, deliver, extensionForKind,
  execute, prepare, recordDelivery, stageAsset, statusOf,
} from '../src/delivery.mjs';

const NOW = 1_700_000_000_000;
const SALT = 'test-salt-0123456789abcdef';
const OWNER_SCOPE = privateScope({ kind: 'owner_private', chatId: 10001, salt: SALT });
const GROUP_SCOPE = groupScope(90001);

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(64, 7)]);

function configWith(delivery = {}) {
  return { ...DEFAULT_CONFIG, delivery: { ...DEFAULT_CONFIG.delivery, enabled: true, ...delivery } };
}

/** 一份假图库：只给 delivery 需要的窄接口。`files` 是 assetId → {path, sha256, kind, mime}。 */
function fakeLibrary({ files = {}, denied = {} } = {}) {
  return {
    getFileForDelivery({ assetId }) {
      const reason = denied[assetId];
      if (reason) return { ok: false, reasonCode: reason, message: `假图库拒绝：${reason}` };
      const entry = files[assetId];
      if (!entry) return { ok: false, reasonCode: 'asset-missing', message: '假图库里没有这张图。' };
      if (!fs.existsSync(entry.path)) return { ok: false, reasonCode: 'file-missing', message: '文件已不在磁盘上。' };
      const actual = sha(fs.readFileSync(entry.path));
      if (entry.sha256 && actual !== entry.sha256) return { ok: false, reasonCode: 'hash-mismatch', message: '哈希不符。' };
      return { ok: true, path: entry.path, sha256: actual, kind: entry.kind ?? 'png', mime: entry.mime ?? 'image/png', scope: OWNER_SCOPE };
    },
  };
}

/** 一份假发送器：记录调用，按脚本返回结果。 */
function fakeSender(script = []) {
  const calls = [];
  const next = () => (script.length ? script.shift() : { ok: true, messageId: 111 });
  return {
    calls,
    async sendText({ text, idempotencyKey, target }) {
      calls.push({ kind: 'text', text, idempotencyKey, target });
      return next();
    },
    async sendSticker({ file, assetId, idempotencyKey, target }) {
      calls.push({ kind: 'sticker', file, assetId, idempotencyKey, target });
      return next();
    },
  };
}

/** 临时目录 + 内存库 + 假图库：一个干净的投递环境。
 *
 * 关键细节：**回调的返回值要先 await 再关库**。投递是异步的（`deliver` 是 async），如果不等
 * 回调结束就 `db.close()`，后续查询会撞上「数据库已关闭」——这条纪律本身也是被测行为的一部分
 * （真实运行时投递完成之前，库不能先关）。
 */
async function harness(run, { files = {}, denied = {}, delivery = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-del-'));
  const dataRoot = dir;
  const assetsDir = path.join(dir, 'home', 'expression', 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });
  const written = {};
  for (const [assetId, options] of Object.entries(files)) {
    const file = path.join(assetsDir, `${assetId}.png`);
    const bytes = options.bytes ?? PNG_BYTES;
    fs.writeFileSync(file, bytes);
    written[assetId] = {
      path: file, sha256: options.breakHash ? 'deadbeef' : sha(bytes),
      kind: 'png', mime: 'image/png', ...(options.extra ?? {}),
    };
  }
  const db = openExpressionDb({ file: ':memory:' });
  const library = fakeLibrary({ files: written, denied });
  const config = configWith(delivery);
  try {
    return await run({ db, library, config, dataRoot, assetsDir, dir });
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 造一个「文字 + 图」的计划，并把投递需要的会话字段挂上去。 */
function makePlan({ text = '好耶', assetId = 'ast_abc123456', kind = 'dm', id = 10001, scope = OWNER_SCOPE, now = NOW, mode = 'text_then_sticker' } = {}) {
  const base = plan({ turnId: `turn-${assetId}`, target: { kind, id }, draft: text, assetId, mode, now });
  return { ...base, scope, bucketKey: quotaBucketFor({ kind, id, scope }) };
}

test('扩展名与状态映射都是显式的', () => {
  assert.equal(extensionForKind('gif'), '.gif');
  assert.equal(extensionForKind('jpeg'), '.jpg');
  assert.equal(extensionForKind('webp'), '.webp');
  assert.equal(extensionForKind('png'), '.png');
  assert.equal(extensionForKind('unknown', 'image/gif'), '.gif');
  assert.equal(statusOf({ ok: true, messageId: 42 }), 'confirmed');
  // 没有回执 = unknown，不是 sent（docs/11 P2 第 10 条）：`ok:true` 但没 message_id 什么也证明不了，
  // 记成 sent 会让「发过没有」永远说不清，也会让配额按一次并不存在的发送来算。
  assert.equal(statusOf({ ok: true }), 'unknown');
  assert.equal(statusOf({ ok: true, status: 'sent' }), 'unknown', 'sender 自己说 sent 也不算：要有 id');
  assert.equal(statusOf({ ok: true, status: 'failed' }), 'failed', '显式失败照它自己的话');
  assert.equal(statusOf({ ok: false, code: 'unknown' }), 'unknown', 'unknown 单独成态');
  assert.equal(statusOf({ ok: false, code: 'failed' }), 'failed');
  assert.equal(statusOf(null), 'failed');
  assert.deepEqual([...DELIVERY_STATES], ['sent', 'confirmed', 'unknown', 'failed', 'skipped']);
});

test('stage：落在 home/media/expression-out，文件名带前缀且不越界', async () => {
  await harness(({ dataRoot, assetsDir }) => {
    const source = path.join(assetsDir, 'ast_abc123456.png');
    const staged = stageAsset({ dataRoot, sourcePath: source, assetId: 'ast_abc123456', sha256: sha(PNG_BYTES), kind: 'png', mime: 'image/png' });
    assert.equal(staged.ok, true);
    const mediaRoot = path.join(dataRoot, 'home', 'media');
    assert.ok(staged.path.startsWith(mediaRoot), `stage 必须在 home/media 内：${staged.path}`);
    assert.ok(path.basename(staged.path).startsWith(STAGE_PREFIX), '文件名带前缀，群守卫与清理都认它');
    assert.ok(!staged.path.startsWith(assetsDir), 'stage 不在图库目录里');
    assert.deepEqual(fs.readFileSync(staged.path), PNG_BYTES);
    // 越界配置回退默认目录（不是放宽 home/media 的守卫）。
    const escaped = stageAsset({ dataRoot, configured: '../../etc', sourcePath: source, assetId: 'ast_abc123456', sha256: sha(PNG_BYTES) });
    assert.equal(escaped.ok, true, '越界配置回退到默认 stage 目录');
    assert.ok(escaped.path.startsWith(mediaRoot));
  }, { files: { ast_abc123456: {} } });
});

test('stage：sha256 不符 / 源文件缺失 → 结构化失败，不留半截文件', async () => {
  await harness(({ dataRoot, assetsDir }) => {
    const source = path.join(assetsDir, 'ast_abc123456.png');
    const mismatch = stageAsset({ dataRoot, sourcePath: source, assetId: 'ast_abc123456', sha256: 'deadbeef' });
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.reasonCode, 'hash-mismatch');
    const missing = stageAsset({ dataRoot, sourcePath: path.join(assetsDir, 'nope.png'), assetId: 'ast_x' });
    assert.equal(missing.ok, false);
    assert.equal(missing.reasonCode, 'file-missing');
    // 没有残留临时文件。
    const stageRoot = path.join(dataRoot, 'home', 'media', 'expression-out');
    const leftovers = fs.existsSync(stageRoot) ? fs.readdirSync(stageRoot).filter(name => name.endsWith('.tmp')) : [];
    assert.deepEqual(leftovers, []);
  }, { files: { ast_abc123456: {} } });
});

test('二次校验：作用域拒绝 → 整轮退化纯文字（绝不发图）', async () => {
  await harness(({ db, library, config, dataRoot }) => {
    const sender = fakeSender();
    return deliver({
      plan: makePlan(), library, db, config, dataRoot, qqSender: sender,
      scope: OWNER_SCOPE, usable: [OWNER_SCOPE], kind: 'dm', target: { kind: 'dm', id: 10001 }, now: NOW,
    }).then(result => {
      assert.equal(result.mode, 'text_only', '图被拒绝时退化成纯文字');
      assert.equal(result.degraded, true);
      assert.equal(result.reasonCode, 'scope-not-visible');
      assert.equal(sender.calls.filter(call => call.kind === 'sticker').length, 0, '一张图都没发');
      assert.equal(sender.calls.filter(call => call.kind === 'text').length, 1, '文字照发');
      assert.match(result.warnings.join(' '), /退化/);
    });
  }, { files: { ast_abc123456: {} }, denied: { ast_abc123456: 'scope-not-visible' } });
});

test('二次校验：实体文件被删 → 退化纯文字（不是「发个损坏的图」）', async () => {
  await harness(async ({ db, library, config, dataRoot, assetsDir }) => {
    fs.rmSync(path.join(assetsDir, 'ast_abc123456.png'));
    const sender = fakeSender();
    const result = await deliver({
      plan: makePlan(), library, db, config, dataRoot, qqSender: sender,
      scope: OWNER_SCOPE, usable: [OWNER_SCOPE], kind: 'dm', target: { kind: 'dm', id: 10001 }, now: NOW,
    });
    assert.equal(result.degraded, true);
    assert.equal(result.reasonCode, 'file-missing');
    assert.equal(result.mode, 'text_only');
    assert.ok(sender.calls.every(call => call.kind === 'text'), '只发文字');
    assert.equal(db.all('SELECT count(*) AS n FROM deliveries')[0].n, 1, '只留一条文字回执');
  }, { files: { ast_abc123456: {} } });
});

test('二次校验：sha256 不符 → 拒绝投递（假图库自己就拦下）', async () => {
  await harness(async ({ db, library, config, dataRoot }) => {
    const sender = fakeSender();
    const result = await deliver({
      plan: makePlan(), library, db, config, dataRoot, qqSender: sender,
      scope: OWNER_SCOPE, usable: [OWNER_SCOPE], kind: 'dm', target: { kind: 'dm', id: 10001 }, now: NOW,
    });
    assert.equal(result.reasonCode, 'hash-mismatch');
    assert.equal(sender.calls.length, 1, '只有文字');
  }, { files: { ast_abc123456: { breakHash: true } } });
});

test('未知 sender 结果（unknown）不重试，并停止后续 part', async () => {
  await harness(async ({ db, library, config, dataRoot }) => {
    const sender = fakeSender([{ ok: true, messageId: 1 }, { ok: false, code: 'unknown' }]);
    const result = await deliver({
      plan: makePlan({ mode: 'text_then_sticker' }), library, db, config, dataRoot, qqSender: sender,
      scope: OWNER_SCOPE, usable: [OWNER_SCOPE], kind: 'dm', target: { kind: 'dm', id: 10001 }, now: NOW,
    });
    assert.equal(sender.calls.length, 2, '文字发了一次、图尝试了一次');
    assert.equal(result.status, 'unknown');
    const rows = db.all('SELECT part_index, status FROM deliveries ORDER BY part_index');
    assert.deepEqual(rows.map(row => [Number(row.part_index), String(row.status)]), [[0, 'confirmed'], [1, 'unknown']]);
    // 再投一次同一份计划：已落终态的 part 全部跳过（unknown 也算终态，绝不能重投）。
    const again = await deliver({
      plan: makePlan({ mode: 'text_then_sticker' }), library, db, config, dataRoot, qqSender: fakeSender(),
      scope: OWNER_SCOPE, usable: [OWNER_SCOPE], kind: 'dm', target: { kind: 'dm', id: 10001 }, now: NOW + 1000,
    });
    assert.equal(again.results.every(row => row.status === 'skipped'), true, '同一计划的每个 part 都已落终态');
    assert.equal(alreadyDelivered({ db, idempotencyKey: partJobs(makePlan())[0].idempotencyKey }), true);
  }, { files: { ast_abc123456: {} } });
});

test('part 顺序固定：文字先发、图后发；图文顺序与计划一致', async () => {
  await harness(async ({ db, library, config, dataRoot }) => {
    const sender = fakeSender();
    const result = await deliver({
      plan: makePlan({ mode: 'text_then_sticker' }), library, db, config, dataRoot, qqSender: sender,
      scope: OWNER_SCOPE, usable: [OWNER_SCOPE], kind: 'dm', target: { kind: 'dm', id: 10001 }, now: NOW,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(sender.calls.map(call => call.kind), ['text', 'sticker']);
    assert.equal(sender.calls[0].idempotencyKey, partJobs(makePlan())[0].idempotencyKey);
    assert.ok(sender.calls[1].file.startsWith(path.join(dataRoot, 'home', 'media')), '发出去的是 stage 后的 home/media 路径');
    assert.equal(result.delivered, 2);
    assert.equal(result.status, 'sent');
  }, { files: { ast_abc123456: {} } });
});

test('冷却与小时配额在投递层再查一次（上层算漏了也不会超发）', async () => {
  await harness(async ({ db, library, config, dataRoot }) => {
    db.run(
      `INSERT INTO deliveries (plan_id, part_index, asset_id, scope, status, idempotency_key, provider_message_id, reason_code, at)
         VALUES ('old', 0, 'ast_old000000', ?, 'confirmed', 'old:0', 5, '', ?)`,
      [OWNER_SCOPE, NOW - 5_000],
    );
    const sender = fakeSender();
    const result = await deliver({
      plan: makePlan({ assetId: 'ast_abc123456' }), library, db, config, dataRoot, qqSender: sender,
      scope: OWNER_SCOPE, usable: [OWNER_SCOPE], kind: 'dm', target: { kind: 'dm', id: 10001 }, now: NOW,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, 'cooldown');
    assert.equal(sender.calls.length, 0, '冷却中一个 part 都不发（连文字也不发，由上层决定怎么回）');
  }, { files: { ast_abc123456: {} } });
});

test('重复窗口：同一张图刚发过 → 退化纯文字（不换一张图，也不硬发）', async () => {
  await harness(async ({ db, library, config, dataRoot }) => {
    db.run(
      `INSERT INTO deliveries (plan_id, part_index, asset_id, scope, status, idempotency_key, provider_message_id, reason_code, at)
         VALUES ('old', 0, 'ast_abc123456', ?, 'confirmed', 'old:0', 5, '', ?)`,
      [OWNER_SCOPE, NOW - 3_600_000],
    );
    const sender = fakeSender();
    const result = await deliver({
      plan: makePlan({ delivery: {} }), library, db, config, dataRoot, qqSender: sender,
      scope: OWNER_SCOPE, usable: [OWNER_SCOPE], kind: 'dm', target: { kind: 'dm', id: 10001 }, now: NOW,
    });
    assert.equal(result.degraded, true);
    assert.equal(result.reasonCode, 'repeat-window');
    assert.deepEqual(sender.calls.map(call => call.kind), ['text']);
  }, { files: { ast_abc123456: {} } });
});

test('组图与群：stage 路径仍在 home/media，群会话用群 bucket', async () => {
  await harness(async ({ db, library, config, dataRoot }) => {
    const sender = fakeSender();
    const groupPlan = makePlan({ kind: 'group', id: 90001, scope: GROUP_SCOPE });
    const result = await deliver({
      plan: groupPlan, library, db, config, dataRoot, qqSender: sender,
      scope: GROUP_SCOPE, usable: [GROUP_SCOPE], kind: 'group', target: { kind: 'group', id: 90001 }, now: NOW,
    });
    assert.equal(result.ok, true);
    const sticker = sender.calls.find(call => call.kind === 'sticker');
    assert.ok(sticker.file.startsWith(path.join(dataRoot, 'home', 'media')), '群发图走的是 home/media 下的文件');
    const row = db.get("SELECT scope FROM deliveries WHERE part_index = 1");
    assert.equal(String(row.scope), GROUP_SCOPE, '回执作用域是群作用域');
  }, { files: { ast_abc123456: {} } });
});

test('sender 抛异常 / 缺失 → 结构化 failed，不重试、不假装发过', async () => {
  await harness(async ({ db, library, config, dataRoot }) => {
    const throwing = { sendText: async () => { throw new Error('napcat down'); }, sendSticker: async () => ({ ok: true, messageId: 9 }) };
    const result = await deliver({
      plan: makePlan(), library, db, config, dataRoot, qqSender: throwing,
      scope: OWNER_SCOPE, usable: [OWNER_SCOPE], kind: 'dm', target: { kind: 'dm', id: 10001 }, now: NOW,
    });
    assert.equal(result.ok, false);
    assert.equal(result.results[0].status, 'failed');
    assert.equal(result.results[0].reasonCode, 'sender-threw');
    assert.equal(result.results[1].status, 'skipped', '文字失败后不再发图');
    const rows = db.all('SELECT status FROM deliveries ORDER BY part_index');
    assert.deepEqual(rows.map(row => String(row.status)), ['failed', 'skipped']);
  }, { files: { ast_abc123456: {} } });
});

test('delivery.enabled=false：prepare 直接拒绝（第二道闸）', async () => {
  await harness(({ db, library, dataRoot }) => {
    const result = prepare({
      plan: makePlan(), library, db, config: { ...DEFAULT_CONFIG, delivery: { ...DEFAULT_CONFIG.delivery, enabled: false } },
      dataRoot, scope: OWNER_SCOPE, usable: [OWNER_SCOPE], now: NOW,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, 'delivery-disabled');
  }, { files: { ast_abc123456: {} } });
});

test('过期计划不投递（半轮计划不该出现在对话里）', async () => {
  await harness(async ({ db, library, config, dataRoot }) => {
    const sender = fakeSender();
    const result = await deliver({
      plan: makePlan(), library, db, config, dataRoot, qqSender: sender,
      scope: OWNER_SCOPE, usable: [OWNER_SCOPE], kind: 'dm', target: { kind: 'dm', id: 10001 }, now: NOW + 10_000_000,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, 'plan-expired');
    assert.equal(sender.calls.length, 0);
  }, { files: { ast_abc123456: {} } });
});

test('cleanStage 只删本前缀的过期文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-clean-'));
  try {
    const stageRoot = path.join(dir, 'stage');
    fs.mkdirSync(stageRoot, { recursive: true });
    const old = path.join(stageRoot, `${STAGE_PREFIX}ast_old.png`);
    const fresh = path.join(stageRoot, `${STAGE_PREFIX}ast_new.png`);
    const foreign = path.join(stageRoot, 'keep-me.txt');
    for (const file of [old, fresh, foreign]) fs.writeFileSync(file, 'x');
    const past = new Date(NOW - 3_600_000);
    fs.utimesSync(old, past, past);
    const result = cleanStage({ stageRoot, ttlMs: 600_000, now: NOW });
    assert.deepEqual(result.removed, [path.basename(old)]);
    assert.equal(fs.existsSync(fresh), true, '没到期的不删');
    assert.equal(fs.existsSync(foreign), true, '不是本前缀的文件一概不碰');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recordDelivery 是幂等 upsert：同一幂等键只更新状态，不插第二行', () => {
  const db = openExpressionDb({ file: ':memory:' });
  try {
    const job = { index: 0, idempotencyKey: 'k1', kind: 'text' };
    const planLike = { planId: 'p1', scope: OWNER_SCOPE };
    recordDelivery({ db, plan: planLike, part: job, status: 'sent', now: NOW });
    recordDelivery({ db, plan: planLike, part: job, status: 'confirmed', providerMessageId: 77, now: NOW + 1 });
    const rows = db.all('SELECT status, provider_message_id FROM deliveries WHERE idempotency_key = ?', ['k1']);
    assert.equal(rows.length, 1);
    assert.equal(String(rows[0].status), 'confirmed');
    assert.equal(Number(rows[0].provider_message_id), 77);
  } finally {
    db.close();
  }
});

test('execute 逐 part 判重：已 sent 的直接 skipped，不再调 sender', async () => {
  const db = openExpressionDb({ file: ':memory:' });
  try {
    const p = makePlan();
    const jobs = partJobs(p).map(job => ({ ...job }));
    db.run(
      `INSERT INTO deliveries (plan_id, part_index, asset_id, scope, status, idempotency_key, at)
         VALUES (?, 0, NULL, ?, 'confirmed', ?, ?)`,
      [p.planId, OWNER_SCOPE, jobs[0].idempotencyKey, NOW],
    );
    const sender = fakeSender();
    const prepared = { mode: 'text_then_sticker', parts: jobs, prepared: [], degraded: false, reasonCode: '' };
    const result = await execute({ plan: p, preparedPlan: prepared, db, qqSender: sender, now: NOW, kind: 'dm', target: { kind: 'dm', id: 10001 } });
    assert.equal(sender.calls.length, 0, '第一个 part 已确认，第二个 part 因为没有 stage 文件而 skipped');
    assert.deepEqual(result.results.map(row => row.status), ['skipped', 'skipped']);
  } finally {
    db.close();
  }
});
