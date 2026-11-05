import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DOMAIN_EVENT_RECEIPTS_META_KEY,
  DOMAIN_EVENT_RECEIPTS_VERSION,
  SCHEMA_VERSION,
  inspectDomainEventReceipts,
  openMemoryDatabase,
} from '../lib/db.mjs';

// Codex review 2026-10-29, N1: the separate forward-only receipt-table channel did
// not inspect the stored version before writing its marker. These tests pin both
// halves of the fix: an existing v2 database gains the receipt table without a main
// version bump, and a newer unknown receipt schema is never silently overwritten.
//
// The main `SCHEMA_VERSION` deliberately stays 2 (frozen `test/db.test.mjs` asserts
// the exact value); the receipt channel carries its own `domainEventReceiptsVersion`.

function createHarness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-memory-receipts-'));
  const file = path.join(dir, 'memory.db');
  const opened = [];
  const open = async (overrides = {}) => {
    const db = await openMemoryDatabase({ file, integrity: 'skip', ...overrides });
    opened.push(db);
    return db;
  };
  t.after(() => {
    for (const db of opened) {
      try {
        db.close();
      } catch {
        // already closed by the test
      }
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { dir, file, open };
}

function receiptDraft(overrides = {}) {
  return {
    receiptId: 'rcpt_test_1',
    dedupeKey: 'dkev_test_1',
    namespace: 'companion.event',
    scope: 'u:receipt_user|p:march7|w:',
    eventId: 'evt_receipt_1',
    transformVersion: 't1',
    status: 'accepted',
    recordId: 'mem_test_1',
    sourceId: 'evt_test_1',
    contentHash: 'hash_test_1',
    realityStatus: 'actual_tool_activity',
    evidenceStatus: 'confirmed',
    rootEvidenceIds: [],
    reason: 'confirmed-observation',
    ...overrides,
  };
}

function countReceiptsTable(db) {
  return Number(db.handle.prepare('SELECT count(*) AS total FROM domain_event_receipts').get().total);
}

test('a v2 database that predates the receipt channel gains it without a main version bump', async t => {
  const harness = createHarness(t);
  // The frozen compromise: the main schema still reports version 2.
  assert.equal(SCHEMA_VERSION, 2);

  const created = await harness.open();
  const createdStatus = created.domainEventReceiptsStatus();
  assert.deepEqual(
    { version: createdStatus.version, compatible: createdStatus.compatible, tableExists: createdStatus.tableExists },
    { version: 1, compatible: true, tableExists: true },
    '新库可写打开即建出收据表并写入版本 1',
  );
  created.close();

  // Roll the file back to a "v2 database written before the receipt channel":
  // receipt table and its own version marker removed, main schema untouched.
  const strip = await harness.open();
  strip.handle.exec('DROP TABLE domain_event_receipts');
  strip.handle.prepare('DELETE FROM schema_meta WHERE key = ?').run(DOMAIN_EVENT_RECEIPTS_META_KEY);
  assert.equal(inspectDomainEventReceipts(strip.handle).tableExists, false);
  assert.equal(inspectDomainEventReceipts(strip.handle).version, null);
  strip.close();

  const upgraded = await harness.open();
  assert.equal(upgraded.schemaVersion(), 2, '主 schemaVersion 必须保持 2');
  assert.equal(upgraded.meta('schemaVersion'), '2');
  assert.deepEqual(upgraded.migrated, [], '补建收据表不得重放主迁移链');
  const status = upgraded.domainEventReceiptsStatus();
  assert.deepEqual(status, {
    version: 1,
    supportedVersion: 1,
    tableExists: true,
    compatible: true,
    newer: false,
  }, '收据通道必须报告版本 1');
  assert.equal(upgraded.meta(DOMAIN_EVENT_RECEIPTS_META_KEY), '1');
  assert.ok(
    upgraded.handle.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'domain_event_receipts'").get(),
    '收据表必须实际存在',
  );

  // The channel is usable on the upgraded store.
  const receipt = upgraded.putDomainEventReceipt(receiptDraft());
  assert.equal(receipt.receiptId, 'rcpt_test_1');
  assert.equal(upgraded.getDomainEventReceipt('dkev_test_1').status, 'accepted');
  assert.equal(upgraded.countDomainEventReceipts(), 1);
  upgraded.close();

  // A read-only reopen keeps both versions and can still read the receipt.
  const reader = await harness.open({ readOnly: true });
  assert.equal(reader.schemaVersion(), 2);
  assert.equal(reader.domainEventReceiptsStatus().version, 1);
  assert.equal(reader.domainEventReceiptsStatus().compatible, true);
  assert.equal(reader.countDomainEventReceipts(), 1);
  assert.equal(reader.getDomainEventReceipt('dkev_test_1').receiptId, 'rcpt_test_1');
});

test('a newer unknown receipt schema is never overwritten and never written to', async t => {
  const harness = createHarness(t);
  const created = await harness.open();
  created.putDomainEventReceipt(receiptDraft());
  // Simulate a database written by a newer build: version marker ahead of this
  // build and an extra column this build knows nothing about.
  created.setMeta(DOMAIN_EVENT_RECEIPTS_META_KEY, '2');
  created.handle.exec("ALTER TABLE domain_event_receipts ADD COLUMN future_shapes TEXT NOT NULL DEFAULT ''");
  created.close();

  const reopened = await harness.open();
  assert.equal(reopened.schemaVersion(), 2, '主 schema 不受收据通道影响');
  assert.equal(
    reopened.meta(DOMAIN_EVENT_RECEIPTS_META_KEY),
    '2',
    '更新版本的标记不得被静默改写成 1',
  );
  const status = reopened.domainEventReceiptsStatus();
  assert.deepEqual(
    { version: status.version, compatible: status.compatible, newer: status.newer },
    { version: 2, compatible: false, newer: true },
  );
  const columns = reopened.handle.prepare('PRAGMA table_info(domain_event_receipts)').all().map(row => row.name);
  assert.ok(columns.includes('future_shapes'), '未知形状必须原样保留（不执行旧 DDL 重建）');

  // The channel fails closed: no read, no write, no downgrade.
  assert.equal(reopened.getDomainEventReceipt('dkev_test_1'), null);
  assert.throws(
    () => reopened.putDomainEventReceipt(receiptDraft({ receiptId: 'rcpt_test_2', dedupeKey: 'dkev_test_2' })),
    /收据表版本不兼容/,
  );
  assert.equal(reopened.countDomainEventReceipts(), 1, '旧收据既没被删除也没被复制');
  assert.equal(reopened.meta(DOMAIN_EVENT_RECEIPTS_META_KEY), '2', '拒绝写入后标记仍是 2');

  // The rest of the store is unaffected: ordinary memory writes still work.
  const record = reopened.insertMemory({
    scope: 'user_global',
    kind: 'fact',
    subject: 'user',
    predicate: 'note',
    value: '收据通道不兼容时记忆库仍可用',
    userId: 'receipt_user',
    personaId: 'march7',
    worldId: '',
  }).record;
  assert.equal(reopened.getMemory(record.id).value, '收据通道不兼容时记忆库仍可用');
  assert.equal(DOMAIN_EVENT_RECEIPTS_VERSION, 1);
});

test('ensure/inspect are idempotent and the open path never creates a receipt table read-only', async t => {
  const harness = createHarness(t);
  const db = await harness.open();
  const first = inspectDomainEventReceipts(db.handle);
  const second = inspectDomainEventReceipts(db.handle);
  assert.deepEqual(first, second, 'inspect 必须是纯读，两次结果一致');
  assert.equal(first.version, 1);
  db.close();

  const reader = await harness.open({ readOnly: true });
  const readOnlyStatus = reader.domainEventReceiptsStatus();
  assert.equal(readOnlyStatus.version, 1);
  // Read-only handles never run the DDL and never claim writability.
  assert.throws(() => reader.putDomainEventReceipt(receiptDraft()), /只读模式|无法写入|read-only/);
  assert.equal(countReceiptsTable(reader), 0);
});
