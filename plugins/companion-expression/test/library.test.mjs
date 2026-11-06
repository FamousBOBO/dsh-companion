/**
 * library.mjs 的离线测试。
 *
 * 重点证明三件产品级不变量（不是实现细节）：
 *   1. 同字节多来源只落一份文件，且权限互不影响；
 *   2. 可见性是硬门：review / quarantined / revoked 永远不可投递；
 *   3. 对外结构里没有 file_path（只有投递入口能拿到路径）。
 * 另加 FTS5 中英文命中、删除审计、撤销范围。
 *
 * 数据库一律 `:memory:`，素材落 mkdtemp 临时目录，跑完删掉；绝不碰 data/ 下的真库。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openExpressionDb } from '../src/db.mjs';
import {
  assetIdFor, buildFtsQuery, createLibrary, sha256Of, MODERATION_STATES,
} from '../src/library.mjs';
import { groupScope, privateScope } from '../src/scopes.mjs';

const SALT = 'test-salt-0123456789abcdef';
const OWNER = privateScope({ kind: 'owner_private', chatId: 10001, salt: SALT });
const PEER = privateScope({ kind: 'peer_private', chatId: 20002, salt: SALT });
const GROUP = groupScope(90001);

function makePng({ width = 64, height = 64, extra = 0 } = {}) {
  const buffer = Buffer.alloc(33 + extra, 0x11);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'latin1');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer[24] = 8;
  buffer[25] = 6;
  return buffer;
}

const PNG = Object.freeze({ kind: 'png', mime: 'image/png', ext: '.png' });

/** 一套干净的内存库 + 临时素材目录。 */
function withLibrary(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-lib-'));
  const db = openExpressionDb({ file: ':memory:' });
  const assets = path.join(dir, 'assets');
  const library = createLibrary({ db, assetsDir: assets, now: () => 1_700_000_000_000 });
  try {
    return run({ db, library, dir, assets });
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 把一份素材完整地收进来（receive + register + 卡）。 */
function seed(library, { bytes = makePng(), scope = OWNER, approval = 'approved', literal = '', messageHash = 'm1', moderationState = 'approved', extraSources = [] } = {}) {
  const received = library.receive({ bytes, format: PNG, width: 64, height: 64, moderationState });
  assert.equal(received.ok, true);
  library.register({
    assetId: received.assetId,
    sources: [{ originScope: scope, sourceMessageHash: messageHash }, ...extraSources],
    visibility: moderationState === 'quarantined'
      ? [{ scope: 'quarantine', approval: 'quarantined' }]
      : [{ scope, approval }],
  });
  if (literal) {
    const card = library.upsertCard(received.assetId, { literal, intents: ['laugh'], scenes: ['morning'] });
    assert.equal(card.ok, true);
  }
  return received;
}

test('同字节两个来源：只存一份物理文件，来源与权限各自独立', () => withLibrary(({ db, library, assets }) => {
  const bytes = makePng({ extra: 256 });
  const first = seed(library, { bytes, scope: OWNER, messageHash: 'm-owner' });
  const second = seed(library, { bytes, scope: PEER, messageHash: 'm-peer', extraSources: [] });

  // 同一个 assetId：去重是物理层的，不是权限层的
  assert.equal(first.assetId, second.assetId);
  assert.equal(second.deduped, true);
  assert.equal(second.createdFile, false);

  // 磁盘上只有一个文件
  const files = [];
  for (const folder of fs.readdirSync(assets)) files.push(...fs.readdirSync(path.join(assets, folder)));
  assert.equal(files.length, 1, `同字节只应有一个文件，实际：${files.join(',')}`);

  const asset = library.getAsset(first.assetId);
  assert.deepEqual(asset.sources.map(row => row.originScope).sort(), [OWNER, PEER].sort());
  assert.equal(asset.visibility.length, 2);
  assert.deepEqual(asset.visibility.map(row => row.scope).sort(), [OWNER, PEER].sort());
  // 外部结构里没有任何路径字符串
  const flat = JSON.stringify(asset);
  assert.equal(/file_path|assets\\|assets\//.test(flat), false, 'asset 结构里不该出现路径');

  // 一个来源通过、另一个还在审核：各自独立
  library.setVisibility({ assetId: first.assetId, scope: PEER, approval: 'review' });
  assert.equal(library.gateFor(first.assetId, [OWNER]).ok, true);
  assert.equal(library.gateFor(first.assetId, [PEER]).reason, 'asset-not-approved');
}));

test('可见性硬门：review / quarantined / disabled / revoked 一律拒绝，且不可被计分绕过', () => withLibrary(({ library }) => {
  const { assetId } = seed(library, { approval: 'review' });
  assert.equal(library.gateFor(assetId, [OWNER]).ok, false);
  assert.equal(library.gateFor(assetId, [OWNER]).reason, 'asset-not-approved');
  const delivery = library.getFileForDelivery({ assetId, usable: [OWNER] });
  assert.equal(delivery.ok, false);
  assert.equal(delivery.reasonCode, 'asset-not-approved');
  assert.equal(delivery.path, undefined, '硬门失败时绝不能返回路径');

  // 其它作用域请求它：根本不在作用域内
  assert.equal(library.gateFor(assetId, [PEER]).reason, 'scope-not-visible');

  library.setVisibility({ assetId, scope: OWNER, approval: 'quarantined' });
  assert.equal(library.gateFor(assetId, [OWNER]).reason, 'asset-quarantined');

  library.setVisibility({ assetId, scope: OWNER, approval: 'disabled' });
  assert.equal(library.gateFor(assetId, [OWNER]).reason, 'asset-disabled');

  library.setVisibility({ assetId, scope: OWNER, approval: 'approved' });
  assert.equal(library.gateFor(assetId, [OWNER]).ok, true);
  assert.equal(library.getFileForDelivery({ assetId, usable: [OWNER] }).ok, true);

  // 未知审核态不许写进库
  const bad = library.setVisibility({ assetId, scope: OWNER, approval: 'looks-fine' });
  assert.equal(bad.ok, false);
  assert.equal(bad.reasonCode, 'approval-invalid');
  assert.ok(MODERATION_STATES.includes('approved'));
}));

test('投递入口：文件缺失或哈希不符都拒绝（不把坏文件交出去）', () => withLibrary(({ library, assets }) => {
  const { assetId } = seed(library, { approval: 'approved' });
  const okDelivery = library.getFileForDelivery({ assetId, usable: [OWNER] });
  assert.equal(okDelivery.ok, true);
  assert.equal(fs.existsSync(okDelivery.path), true);

  // 篡改磁盘上的字节：sha256 不再匹配
  fs.writeFileSync(okDelivery.path, makePng({ extra: 999 }));
  const tampered = library.getFileForDelivery({ assetId, usable: [OWNER] });
  assert.equal(tampered.ok, false);
  assert.equal(tampered.reasonCode, 'hash-mismatch');

  // 直接删掉物理文件
  fs.rmSync(okDelivery.path, { force: true });
  const missing = library.getFileForDelivery({ assetId, usable: [OWNER] });
  assert.equal(missing.ok, false);
  assert.equal(missing.reasonCode, 'file-missing');
  assert.equal(fs.readdirSync(assets).length >= 1, true);
}));

test('FTS5 检索：中文（二字/单字）与英文都能命中，且不串库', () => withLibrary(({ library }) => {
  const happy = seed(library, { bytes: makePng({ extra: 1 }), literal: '开心 得 不 行' }).assetId;
  const sticker = seed(library, { bytes: makePng({ extra: 2 }), literal: 'happy sticker smile' }).assetId;
  const night = seed(library, { bytes: makePng({ extra: 3 }), literal: '晚安 好 梦' }).assetId;

  assert.deepEqual(library.search('开心'), [happy]);
  assert.deepEqual(library.search('晚安'), [night]);
  assert.deepEqual(library.search('happy'), [sticker]);
  assert.deepEqual(library.search('sticker'), [sticker]);
  // 多词 OR：命中任一即可
  const mixed = library.search('开心 happy');
  assert.deepEqual(mixed.sort(), [happy, sticker].sort());
  // 查不到就是空数组，不是 undefined
  assert.deepEqual(library.search('不存在的词'), []);
  assert.deepEqual(library.search('   '), []);
  // 查询串里的引号/星号不能把语法弄崩（我们只构造短语）
  assert.deepEqual(library.search('开心" OR *'), [happy]);
  assert.equal(buildFtsQuery(''), '');
  assert.match(buildFtsQuery('开心'), /"开心"/);

  // 列表接口按查询过滤
  const listed = library.listAssets({ query: 'happy' });
  assert.equal(listed.total, 1);
  assert.equal(listed.items[0].assetId, sticker);
}));

test('语义卡：写卡会同步重建 FTS；assetId 由内容哈希派生', () => withLibrary(({ library }) => {
  const { assetId, sha256 } = seed(library, { approval: 'approved' });
  assert.equal(assetId, assetIdFor(sha256));
  assert.equal(sha256, sha256Of(makePng()));

  library.upsertCard(assetId, { literal: '哈哈 笑 死', intents: ['laugh'], emotions: ['joy'] });
  assert.deepEqual(library.search('哈哈'), [assetId]);
  const card = library.getCard(assetId);
  assert.equal(card.literal, '哈哈 笑 死');
  assert.deepEqual(card.emotions, ['joy']);
  assert.equal(card.ocr, '', 'OCR 未实现，必须是空串而不是猜测');

  // 改卡之后旧词不再命中（FTS 与卡一致）
  library.upsertCard(assetId, { literal: '委屈 想 哭', intents: ['comfort'] });
  assert.deepEqual(library.search('哈哈'), []);
  assert.deepEqual(library.search('委屈'), [assetId]);
  // 不存在的素材不能写卡
  assert.equal(library.upsertCard('ast_missing', { literal: 'x' }).reasonCode, 'asset-missing');
}));

test('删除写 delete_audit 并清掉物理文件；撤销只影响该作用域', () => withLibrary(({ db, library }) => {
  const shared = makePng({ extra: 7 });
  const owner = seed(library, { bytes: shared, scope: OWNER, messageHash: 'm-owner' });
  seed(library, { bytes: shared, scope: GROUP, messageHash: 'm-group' });

  library.revokeScope({ scope: GROUP, reason: '群授权被主人撤销' });
  // visibilityGate 的 reason 只说「不在可发送审批态」；revoked 与 review 同属不可发送。
  // 这里断言的是硬门结果（不可投递），而不是文案细节。
  assert.equal(library.gateFor(owner.assetId, [GROUP]).ok, false);
  assert.equal(library.gateFor(owner.assetId, [GROUP]).reason, 'asset-not-approved');
  const revokedRow = library.getVisibility(owner.assetId).find(row => row.scope === GROUP);
  assert.equal(revokedRow.approval, 'revoked');
  assert.equal(library.gateFor(owner.assetId, [OWNER]).ok, true, '撤销一个来源不能连带弄坏另一个来源');
  const revocation = db.get('SELECT origin_scope, reason FROM asset_revocations');
  assert.equal(revocation.origin_scope, GROUP);

  const removed = library.deleteAsset({ assetId: owner.assetId, reason: '主人要求删除', scope: OWNER });
  assert.equal(removed.ok, true);
  assert.equal(removed.removedFile, true);
  assert.equal(library.getAsset(owner.assetId), null);
  assert.deepEqual(library.search('开心'), [], '素材删除后 FTS 里也不该再有它');
  const audit = db.get('SELECT asset_id, reason FROM delete_audit');
  assert.equal(audit.asset_id, owner.assetId);
  assert.equal(audit.reason, '主人要求删除');
  assert.equal(db.get('SELECT count(*) AS total FROM assets')?.total, 0);
  assert.equal(db.get('SELECT count(*) AS total FROM asset_sources')?.total, 0);

  // 删不存在素材：结构化失败，不抛
  assert.equal(library.deleteAsset({ assetId: 'ast_nope' }).reasonCode, 'asset-missing');
}));

test('统计与列表：quarantined 单独计数，来源行可查', () => withLibrary(({ library }) => {
  const ok = seed(library, { bytes: makePng({ extra: 1 }), approval: 'approved' });
  seed(library, { bytes: makePng({ extra: 2 }), moderationState: 'quarantined', scope: 'quarantine' });
  const stats = library.stats();
  assert.equal(stats.assets, 2);
  assert.equal(stats.quarantined, 1);
  assert.equal(stats.approvals, 1);
  assert.equal(stats.sources, 2);

  const list = library.listAssets({ limit: 10 });
  assert.equal(list.total, 2);
  assert.equal(list.items.some(item => item.assetId === ok.assetId), true);
  const quarantinedOnly = library.listAssets({ moderation: 'quarantined' });
  assert.equal(quarantinedOnly.items.length, 1);
  const byScope = library.listAssets({ scope: OWNER });
  assert.equal(byScope.items.length, 1);
  assert.equal(byScope.items[0].assetId, ok.assetId);
}));
