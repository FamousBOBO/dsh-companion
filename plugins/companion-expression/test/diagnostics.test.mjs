/**
 * 只读诊断面的测试（`src/diagnostics.mjs`）。
 *
 * 这份诊断存在的理由只有一个：**「配图没发生」必须能一句话说清原因**。所以测试盯的是
 * 「口径与真实链路一致」，不是「字段有没有填」：
 *   - 可用素材数用与检索/投递**同一个** `scopesFor` + 可见性硬门；
 *   - 读不出来给 `null`，不给 0（0 是"确实没有"，两者混了就没法排障）；
 *   - 最近一次候选/发图的结局要有结果码；没有回执时 `messageId` 必须是 `null`；
 *   - 输出里不出现 QQ 号、路径、URL。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { openExpressionDb } = await import('../src/db.mjs');
const { createLibrary } = await import('../src/library.mjs');
const { DEFAULT_CONFIG } = await import('../src/config.mjs');
const { createExpressionDiagnostics, candidateView, replyView } = await import('../src/diagnostics.mjs');
const { scopesFor, makeScopeSalt } = await import('../src/scopes.mjs');

/** 一个临时库：`assets` / `asset_visibility` 直接写行（入库流程另有测试覆盖）。 */
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'expression-diag-'));
  const db = openExpressionDb({ file: path.join(dir, 'expression.sqlite') });
  const library = createLibrary({ db, assetsDir: path.join(dir, 'assets') });
  const salt = makeScopeSalt(n => Buffer.alloc(n, 7));
  return { dir, db, library, salt, close: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }) } };
}

/** 写一条素材 + 一条可见性（`approval` 决定它此刻能不能发）。 */
function seed(db, { assetId, sha, scope, approval = 'approved', moderation = 'approved' }) {
  db.run(
    `INSERT INTO assets (id, sha256, kind, mime, file_path, moderation_state, created_at)
     VALUES (?, ?, 'png', 'image/png', ?, ?, ?)`,
    [assetId, sha, `/tmp/${assetId}.png`, moderation, 1_700_000_000_000],
  );
  db.run('INSERT INTO asset_visibility (asset_id, scope, approval) VALUES (?, ?, ?)', [assetId, scope, approval]);
}

function configWith(over = {}) {
  return {
    ...DEFAULT_CONFIG,
    capture: { ...DEFAULT_CONFIG.capture, ...(over.capture ?? {}) },
    delivery: { ...DEFAULT_CONFIG.delivery, ...(over.delivery ?? {}) },
    privacy: { ...DEFAULT_CONFIG.privacy, ...(over.privacy ?? {}) },
  };
}

test('主人私聊：可用素材数只数「批准 + 审核通过」的行', () => {
  const env = fixture();
  try {
    const config = configWith()
    const scope = scopesFor({ kind: 'dm', chatId: 1001, isOwner: true, salt: env.salt, config }).own
    seed(env.db, { assetId: 'ast_ok000000001', sha: 'a'.repeat(64), scope, approval: 'approved', moderation: 'approved' })
    seed(env.db, { assetId: 'ast_review00002', sha: 'b'.repeat(64), scope, approval: 'review' })
    seed(env.db, { assetId: 'ast_quarant0003', sha: 'c'.repeat(64), scope, approval: 'approved', moderation: 'quarantined' })
    const diag = createExpressionDiagnostics({
      db: env.db, library: env.library, config, salt: env.salt,
      isOwnerFor: () => true, events: {}, clock: () => 1_700_000_000_000,
    })
    const report = diag.report({ targets: [{ kind: 'dm', chatId: 1001 }] })
    const target = report.targets[0]
    assert.equal(target.usableScopes, 1)
    assert.equal(target.usableAssets, 1, '只有 approved + approved 的那一张算「可用」')
    assert.equal(target.reason, '', '主人私聊默认能采集，所以没有受阻原因')
    assert.equal(report.module.deliveryEnabled, false, '默认 delivery.enabled 是 false——诊断必须如实反映')
  } finally {
    env.close()
  }
})

test('群聊：没授权的群给原因码，可用素材数为 0 而不是「读不到」', () => {
  const env = fixture();
  try {
    const config = configWith({ capture: { groupEnabled: true } })
    const diag = createExpressionDiagnostics({
      db: env.db, library: env.library, config, salt: env.salt, isOwnerFor: () => false, events: {},
    })
    const blocked = diag.report({ targets: [{ kind: 'group', chatId: 2002 }] }).targets[0]
    assert.equal(blocked.reason, 'group-not-granted')
    assert.equal(blocked.usableScopes, 0)
    assert.equal(blocked.usableAssets, 0)

    // 授权「只收不发」的群：可采集，但可用素材数为 0，原因是 group-use-off。
    const onlyCapture = configWith({
      capture: { groupEnabled: true, groups: [{ chatId: 2002, capture: true, store: true, use: false }] },
    })
    const diag2 = createExpressionDiagnostics({
      db: env.db, library: env.library, config: onlyCapture, salt: env.salt, isOwnerFor: () => false, events: {},
    })
    const off = diag2.report({ targets: [{ kind: 'group', chatId: 2002 }] }).targets[0]
    assert.equal(off.usableScopes, 0, 'use 关着就没有可用作用域')
    assert.equal(off.capture, true, '这个群仍然在采集（capture 与 use 是两件事）')
    assert.equal(off.reason, 'group-use-off', '原因码与 scopesFor 原样一致，排障才查得下去')
  } finally {
    env.close()
  }
})

test('读不出来的计数给 null，不给 0（0 是「确实没有」）', () => {
  const broken = {
    get() { throw new Error('db is gone') },
    all() { throw new Error('db is gone') },
  }
  const diag = createExpressionDiagnostics({
    db: broken, library: { stats() { throw new Error('gone') } },
    config: configWith(), salt: 'salt', isOwnerFor: () => true, events: {},
  })
  const report = diag.report({ targets: [] })
  assert.equal(report.library.available, false)
  assert.equal(report.library.assets, null)
  assert.equal(report.library.visibility.review, null)
  assert.deepEqual(report.targets, [])
})

test('最近一次候选/发图：带结果码；没有回执时 messageId 必须是 null', () => {
  const env = fixture();
  try {
    const diag = createExpressionDiagnostics({
      db: env.db, library: env.library, config: configWith(), salt: env.salt, isOwnerFor: () => true,
      events: {
        observed: 3, queued: 2, dropped: 1, lastAt: 1_700_000_000_000,
        lastCandidate: { ok: true, send: false, reasonCode: 'text-only-no-candidate', candidates: 0, fitScore: 0, at: 1_700_000_000_100 },
        lastReply: { ok: false, reasonCode: 'delivery-disabled', delivered: 0, messageId: null, assetId: null, at: 1_700_000_000_200 },
      },
    })
    const report = diag.report()
    assert.equal(report.lastCandidate.reasonCode, 'text-only-no-candidate')
    assert.equal(report.lastCandidate.candidates, 0)
    assert.equal(report.lastReply.reasonCode, 'delivery-disabled')
    assert.equal(report.lastReply.messageId, null, '没有回执就是没有，不许补一个假的')
    assert.equal(report.ingest.observed, 3)
    assert.equal(report.ingest.dropped, 1)
  } finally {
    env.close()
  }
})

test('最近的投递记录：status / reasonCode / messageId 原样带出，不含消息正文', () => {
  const env = fixture();
  try {
    env.db.run(
      `INSERT INTO deliveries (plan_id, part_index, asset_id, scope, status, idempotency_key, provider_message_id, reason_code, at)
       VALUES ('plan-1', 0, 'ast_ok000000001', 'group:2002', 'confirmed', 'idem-1', '987654', '', 1700000000300)`,
    )
    env.db.run(
      `INSERT INTO deliveries (plan_id, part_index, asset_id, scope, status, idempotency_key, provider_message_id, reason_code, at)
       VALUES ('plan-2', 0, 'ast_ok000000001', 'group:2002', 'skipped', 'idem-2', NULL, 'cooldown', 1700000000400)`,
    )
    const diag = createExpressionDiagnostics({
      db: env.db, library: env.library, config: configWith(), salt: env.salt, isOwnerFor: () => true, events: {},
    })
    const rows = diag.report({ limit: 5 }).recentDeliveries
    assert.equal(rows.length, 2)
    assert.equal(rows[0].messageId, null)
    assert.equal(rows[0].reasonCode, 'cooldown')
    assert.equal(rows[1].messageId, '987654', '回执是「真的发出去了」的证据')
    assert.equal(JSON.stringify(rows).includes('text'), false, '投递记录里不该出现消息正文')
  } finally {
    env.close()
  }
})

test('输出里不出现 QQ 号 / 路径 / URL（作用域只给家族名）', () => {
  const env = fixture();
  try {
    const config = configWith({ capture: { groupEnabled: true, groups: [{ chatId: 2002, capture: true, store: true, use: true }] } })
    const scope = scopesFor({ kind: 'group', chatId: 2002, isOwner: false, salt: env.salt, config }).own
    seed(env.db, { assetId: 'ast_ok000000001', sha: 'a'.repeat(64), scope })
    const diag = createExpressionDiagnostics({
      db: env.db, library: env.library, config, salt: env.salt, isOwnerFor: () => false, events: {},
    })
    const text = JSON.stringify(diag.report({ targets: [{ kind: 'group', chatId: 2002 }] }))
    assert.equal(text.includes('/tmp/'), false, '不许带文件路径')
    assert.equal(/https?:\/\//.test(text), false, '不许带 URL')
    const report = diag.report({ targets: [{ kind: 'group', chatId: 2002 }] })
    assert.deepEqual(report.targets[0].scopes.map(row => row.scopeKind), ['group'])
  } finally {
    env.close()
  }
})

test('view 归一：坏输入不抛，字段形状稳定', () => {
  assert.equal(candidateView(null), null)
  assert.equal(replyView(undefined), null)
  assert.deepEqual(candidateView({ ok: true, reasonCode: 'send', candidates: 3, fitScore: 0.8, at: 5 }), {
    ok: true, reasonCode: 'send', send: false, candidates: 3, fitScore: 0.8, at: 5,
  })
  assert.deepEqual(replyView({ ok: true, delivered: 1, messageId: 42, assetId: 'ast_x' }), {
    ok: true, reasonCode: '', delivered: 1, messageId: '42', assetId: 'ast_x', at: 0,
  })
})
