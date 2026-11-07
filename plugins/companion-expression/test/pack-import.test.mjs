/**
 * `pack-import.mjs` 的离线测试：整条导入路径（解包 → 验字节 → 入库 → 挂来源/可见性 → 写卡）。
 *
 * 这里测的是**产品不变量**，不是实现细节：
 *   1. `dryRun: true` 绝不写库、绝不落文件（预演写了库就不叫预演）；
 *   2. 导入后 `retrieval.mjs` 的硬门真的放行（`moderationState='approved'` + 可见性 approved），
 *      否则「导入成功」等于「导进去也永远发不出来」；
 *   3. 重跑幂等：同一份字节只落一行素材、一行来源，卡被更新而不是插第二条；
 *   4. 清单里写了但包里没有的文件被报出来，而不是让整包失败。
 *
 * 数据库一律 `:memory:`，素材目录 mkdtemp，跑完删掉；绝不碰 data/ 下的真库与真图。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';

import { openExpressionDb } from '../src/db.mjs';
import { createLibrary } from '../src/library.mjs';
import { groupScope, privateScope } from '../src/scopes.mjs';
import { importPack } from '../src/pack-import.mjs';
import { validatePackManifest, CURATED_MODEL_VERSION } from '../src/pack.mjs';
import { hardGate, fromLibrary, retrieve } from '../src/retrieval.mjs';
import { decide } from '../src/decision.mjs';
import { DEFAULT_CONFIG } from '../src/config.mjs';

const SALT = 'test-salt-0123456789abcdef';
const OWNER = privateScope({ kind: 'owner_private', chatId: 10001, salt: SALT });
const GROUP = groupScope(90001);
const NOW = 1_700_000_000_000;

/* ── 造一个真的 PNG（带尺寸）与一个真的 zip ─────────────────────── */
function makePng(width, height) {
  const buffer = Buffer.alloc(64, 0x11);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'latin1');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer[24] = 8;
  buffer[25] = 6;
  return buffer;
}

/** 只写 deflate 条目的最小 zip（够本测试用，边界情形由 zip.test.mjs 覆盖）。 */
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, bytes] of files) {
    const payload = deflateRawSync(Buffer.from(bytes));
    const nameBytes = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    nameBytes.copy(local, 30);
    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);
    locals.push(Buffer.concat([local, payload]));
    centrals.push(central);
    offset += local.length + payload.length;
  }
  const centralDir = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDir, eocd]);
}

const PACK = {
  packId: 'test-pack',
  name: '测试包',
  entries: [
    {
      file: '15-困.png',
      literal: '困 好困 困了 想睡 睡觉 睡着了 疲惫 累 打哈欠',
      intents: ['greet'], emotions: ['tired'], tone: ['warm'], scenes: ['bedtime', 'night'],
    },
    {
      file: '11-开心.png',
      literal: '开心 高兴 快乐 好开心',
      intents: ['laugh'], emotions: ['joy'], tone: ['warm'], scenes: [],
    },
  ],
};

function withLibrary(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-import-'));
  const db = openExpressionDb({ file: ':memory:' });
  const library = createLibrary({ db, assetsDir: path.join(dir, 'assets'), now: () => NOW });
  try {
    return run({ db, library, dir });
  } finally {
    db.close();
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 40 }); } catch { /* windows lock */ }
  }
}

const zipBytes = makeZip([
  ['15-困.png', makePng(126, 126)],
  ['11-开心.png', makePng(127, 126)],
  ['preview.png', makePng(64, 64)],
]);

test('导入两张：素材入库、可见性两行、卡写上 curated 标记', () => {
  withLibrary(({ library }) => {
    const result = importPack({
      library, zipBytes, pack: validatePackManifest(PACK).pack,
      visibility: [{ scope: OWNER, approval: 'approved' }, { scope: GROUP, approval: 'approved' }],
    });
    assert.equal(result.ok, true);
    assert.equal(result.imported, 2);
    assert.equal(result.failed, 0);
    assert.deepEqual(result.unlisted, ['preview.png'], '包里有但清单没写的要被报出来');

    const stats = library.stats();
    assert.equal(stats.assets, 2);
    assert.equal(stats.cards, 2);
    assert.equal(stats.approvals, 4, '两张 × 两行作用域，全部 approved');
    for (const row of result.rows) {
      const asset = library.getAsset(row.assetId);
      assert.equal(asset.moderationState, 'approved');
      assert.equal(asset.card.modelVersion, CURATED_MODEL_VERSION);
      assert.equal(asset.card.ocr, '', '不做 OCR 就不往这一列里塞东西');
      assert.equal(asset.visibility.length, 2);
      assert.equal(asset.sources.length, 1);
      assert.match(String(asset.sources[0].consentRef), /operator-import:test-pack:/);
    }
  });
});

test('dryRun 绝不写库、绝不落文件（预演写了库就不叫预演）', () => {
  withLibrary(({ library, dir }) => {
    const before = library.stats();
    const result = importPack({
      library, zipBytes, pack: validatePackManifest(PACK).pack,
      visibility: [{ scope: OWNER, approval: 'approved' }], dryRun: true,
    });
    assert.equal(result.imported, 2, '预演仍然要报告「会导几张」');
    assert.equal(library.stats().assets, before.assets, '素材数不得变化');
    assert.equal(library.stats().cards, before.cards, '卡数不得变化');
    const assetRoot = path.join(dir, 'assets');
    const written = fs.existsSync(assetRoot) ? fs.readdirSync(assetRoot).length : 0;
    assert.equal(written, 0, '一个素材目录都不该被创建');
  });
});

test('导入之后硬门真的放行：approved + 可见作用域 ⇒ 不再被 review 挡住', () => {
  withLibrary(({ library }) => {
    const result = importPack({
      library, zipBytes, pack: validatePackManifest(PACK).pack,
      visibility: [{ scope: OWNER, approval: 'approved' }],
    });
    const row = result.rows.find(item => item.file === '15-困.png');
    const asset = library.getAsset(row.assetId);
    const gate = hardGate({ candidate: asset, usable: [OWNER] });
    assert.equal(gate.ok, true, `硬门应该放行，实际 ${gate.reasonCode}`);
    // 同一张图在**别的作用域**里仍然不可见：导入不会把授权顺给别人。
    const other = hardGate({ candidate: asset, usable: [groupScope(12345)] });
    assert.equal(other.ok, false);
    assert.equal(other.reasonCode, 'scope-not-visible');
  });
});

test('重跑幂等：同一份字节只落一行素材与一行来源，卡被更新而不是插第二条', () => {
  withLibrary(({ library }) => {
    const pack = validatePackManifest(PACK).pack;
    const first = importPack({ library, zipBytes, pack, visibility: [{ scope: OWNER, approval: 'approved' }] });
    const second = importPack({ library, zipBytes, pack, visibility: [{ scope: OWNER, approval: 'approved' }] });
    assert.equal(second.ok, true);
    assert.equal(second.imported, 2);
    assert.equal(library.stats().assets, 2, '第二次全是去重命中，不该多出素材');
    assert.equal(library.stats().sources, 2, '来源行也不该翻倍');
    assert.equal(second.rows.every(row => row.deduped === true), true, '第二次应全部标记为已存在');
  });
});

test('清单写了但包里没有的文件：记 skipped，其余照导（Quarantine 而不是整包失败）', () => {
  const pack = validatePackManifest({
    packId: 'p2',
    entries: [{ file: '15-困.png', literal: '困 好困 困了 想睡' }, { file: 'gone.png', literal: '不存在' }],
  }).pack;
  withLibrary(({ library }) => {
    const result = importPack({ library, zipBytes, pack, visibility: [{ scope: OWNER, approval: 'approved' }] });
    assert.equal(result.ok, true);
    assert.deepEqual(result.skipped, ['gone.png']);
    assert.equal(result.imported, 1);
  });
});

test('压缩包与清单一张都对不上：整体失败，不装作导成功', () => {
  const pack = validatePackManifest({ packId: 'p3', entries: [{ file: 'nope.png', literal: 'x' }] }).pack;
  withLibrary(({ library }) => {
    const result = importPack({ library, zipBytes, pack, visibility: [{ scope: OWNER, approval: 'approved' }] });
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, 'pack-zip-mismatch');
    assert.equal(result.imported, 0);
    assert.equal(library.stats().assets, 0);
  });
});

test('没有任何可见作用域：拒绝导入（一张谁都看不见的图入库等于没导入）', () => {
  withLibrary(({ library }) => {
    const result = importPack({ library, zipBytes, pack: validatePackManifest(PACK).pack, visibility: [] });
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, 'visibility-empty');
    assert.equal(result.imported, 0);
    assert.equal(library.stats().assets, 0);
  });
});

test('清单里的假图（字节不是图片）单独失败，好图照样导进去', () => {
  const fakeZip = makeZip([['15-困.png', makePng(126, 126)], ['11-开心.png', Buffer.from('not an image at all', 'utf8')]]);
  withLibrary(({ library }) => {
    const result = importPack({ library, zipBytes: fakeZip, pack: validatePackManifest(PACK).pack, visibility: [{ scope: OWNER, approval: 'approved' }] });
    assert.equal(result.ok, false, '有失败条目就不是整体成功');
    const bad = result.rows.find(row => row.file === '11-开心.png');
    assert.equal(bad.ok, false);
    assert.equal(bad.reasonCode, 'unknown-format');
    const good = result.rows.find(row => row.file === '15-困.png');
    assert.equal(good.ok, true);
  });
});

test('端到端：导入的卡真的能被检索到，并按阈值给出 send', () => {
  withLibrary(({ db, library }) => {
    const result = importPack({
      library, zipBytes, pack: validatePackManifest(PACK).pack,
      visibility: [{ scope: OWNER, approval: 'approved' }],
    });
    const found = retrieve({
      library: fromLibrary(library), usable: [OWNER], scope: OWNER,
      context: { query: '好困', intents: ['greet'], emotions: ['tired'], tone: [], scenes: ['bedtime'] },
      limit: 5, minFitScore: 0, now: NOW,
      feedbackScore: () => 0.5, isSuppressed: () => false,
    });
    assert.ok(found.candidates.length > 0, '导入的图必须能被检索到');
    // 这里显式打开投递总闸：测的是「导入的卡能不能被决策层接受」，不是默认关闭的策略。
    const enabled = { ...DEFAULT_CONFIG, delivery: { ...DEFAULT_CONFIG.delivery, enabled: true } };
    const decision = decide({
      db, config: enabled, target: { kind: 'dm', id: '10001' },
      scope: OWNER, candidates: found.candidates, draft: '好困', now: NOW,
    });
    assert.equal(decision.send, true, `应该能发：${decision.reasonCode} ${decision.message}`);
    assert.equal(result.imported, 2);
  });
});
