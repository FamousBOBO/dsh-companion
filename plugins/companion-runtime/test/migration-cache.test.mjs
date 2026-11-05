import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openRuntimeDb, createDb, SCHEMA_VERSION } from '../lib/db.mjs';

// V7: migration matrix plus the N-cache regression.
//
// The sixth independent review ran the N-cache reproduction by hand: one handle caches
// `SELECT * FROM memory_outbox` while the table still has the v1 width (11 columns), then
// migrates, and the cached statement keeps answering with 11 columns while a fresh prepare
// returns 13. `migrate()` now drops the prepared-statement cache whenever it changed the
// schema, so the assertion below fails on the pre-fix code and passes after it.

const T0 = Date.UTC(2026, 9, 29, 4, 0, 0);

const V1_COLUMNS = Object.freeze([
  'outbox_id', 'scope', 'event_id', 'namespace', 'payload', 'status', 'receipt_id',
  'attempts', 'last_error', 'created_at', 'updated_at',
]);
const CLAIM_COLUMNS = Object.freeze(['claimed_until', 'claim_owner']);
const V1_ROW_PAYLOAD = JSON.stringify({ content: 'synthetic v1 row', transformVersion: 'v1' });

function tempFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-migration-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });
  return { dir, file: path.join(dir, 'runtime.db') };
}

/** v1 database exactly as the previous release wrote it: 11 columns, no claim state. */
function buildV1(file) {
  const db = createDb({ file, now: () => T0, pragmas: false });
  db.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '');
    INSERT INTO schema_migrations (version, applied_at, note) VALUES (1, ${T0}, 'cognitive-continuity v1');
    CREATE TABLE memory_outbox (
      outbox_id TEXT PRIMARY KEY, scope TEXT NOT NULL, event_id TEXT NOT NULL, namespace TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'queued', receipt_id TEXT NOT NULL DEFAULT '',
      attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    INSERT INTO memory_outbox (outbox_id, scope, event_id, namespace, payload, status, receipt_id, attempts, last_error, created_at, updated_at)
      VALUES ('ob-v1', 'u:owner-1|p:bot|w:world:default', 'ev-v1', 'companion.event', '${V1_ROW_PAYLOAD}', 'queued', '', 0, '', ${T0}, ${T0});
    INSERT INTO memory_outbox (outbox_id, scope, event_id, namespace, payload, status, receipt_id, attempts, last_error, created_at, updated_at)
      VALUES ('ob-v1b', 'u:owner-1|p:bot|w:world:default', 'ev-v1b', 'companion.event', '${V1_ROW_PAYLOAD}', 'failed', 'rcpt-1', 3, 'rejected', ${T0 + 5}, ${T0 + 7});`);
  return db;
}

function columnsOf(db) {
  return db.all('PRAGMA table_info(memory_outbox)').map(column => column.name);
}

function shapeOf(row) {
  return {
    outbox_id: row.outbox_id, scope: row.scope, event_id: row.event_id, namespace: row.namespace,
    payload: row.payload, status: row.status, receipt_id: row.receipt_id,
    attempts: Number(row.attempts), last_error: row.last_error,
    created_at: Number(row.created_at), updated_at: Number(row.updated_at),
  };
}

test('N-cache: a statement cached before migrate() sees the new columns after the migration', t => {
  const { file } = tempFile(t);
  const builder = buildV1(file);
  builder.close();
  const handle = createDb({ file, now: () => T0, pragmas: false });
  t.after(() => { try { handle.close(); } catch { /* already closed */ } });

  // 1. The pre-migration query: this is the statement the handle caches.
  const before = handle.all('SELECT * FROM memory_outbox ORDER BY outbox_id');
  assert.equal(before.length, 2);
  assert.equal(Object.keys(before[0]).length, V1_COLUMNS.length, 'the v1 table really has 11 columns');
  assert.deepEqual(Object.keys(before[0]), [...V1_COLUMNS]);

  // 2. Same handle, migration applies the additive ALTER.
  const applied = handle.migrate();
  assert.deepEqual(applied, [{ from: 1, to: SCHEMA_VERSION, at: T0 }]);
  assert.equal(handle.schemaVersion(), SCHEMA_VERSION);
  assert.deepEqual(columnsOf(handle), [...V1_COLUMNS, ...CLAIM_COLUMNS], 'the table now has the claim columns');

  // 3. The cached SQL text is asked again. Before the fix this returned the 11-column
  //    shape and silently hid claimed_until/claim_owner from every later reader.
  const after = handle.all('SELECT * FROM memory_outbox ORDER BY outbox_id');
  assert.equal(Object.keys(after[0]).length, V1_COLUMNS.length + CLAIM_COLUMNS.length,
    'the cached SELECT * is re-prepared and sees all 13 columns');
  assert.equal(Object.keys(after[0]).length, columnsOf(handle).length);
  assert.equal(after[0].claim_owner, '', 'an old row starts unclaimed');
  assert.equal(Number(after[0].claimed_until), 0);
  assert.equal(after[0].outbox_id, before[0].outbox_id);
  assert.equal(after[0].payload, before[0].payload, 'the row content is untouched by the migration');
  handle.close();
});

test('migration matrix: a fresh database opens at schemaVersion 2 with the claim columns', t => {
  const { file } = tempFile(t);
  const db = openRuntimeDb({ file, now: () => T0 });
  assert.equal(db.schemaVersion(), SCHEMA_VERSION);
  const columns = columnsOf(db);
  assert.equal(columns.length, 13);
  for (const column of CLAIM_COLUMNS) assert.ok(columns.includes(column), `fresh schema has ${column}`);
  const versions = db.all('SELECT version FROM schema_migrations ORDER BY version').map(row => Number(row.version));
  assert.deepEqual(versions, [SCHEMA_VERSION], 'exactly one migration row');
  assert.deepEqual(db.migrate(), [], 'migrating an up-to-date database is a no-op');
  assert.deepEqual(db.all('SELECT version FROM schema_migrations ORDER BY version').map(row => Number(row.version)), [SCHEMA_VERSION]);
  db.close();
});

test('migration matrix: a v1 database is upgraded additively and keeps every row unchanged', t => {
  const { file } = tempFile(t);
  const v1 = buildV1(file);
  const before = v1.all('SELECT rowid AS rid, * FROM memory_outbox ORDER BY outbox_id');
  assert.deepEqual(columnsOf(v1), [...V1_COLUMNS], 'the hand-built database is a real v1 schema');
  v1.close();

  const db = openRuntimeDb({ file, now: () => T0 });
  assert.equal(db.schemaVersion(), SCHEMA_VERSION);
  assert.deepEqual(columnsOf(db), [...V1_COLUMNS, ...CLAIM_COLUMNS], 'the new columns are appended, the old order is kept');

  const after = db.all('SELECT rowid AS rid, * FROM memory_outbox ORDER BY outbox_id');
  assert.equal(after.length, before.length, 'no row is lost or duplicated');
  for (let index = 0; index < before.length; index += 1) {
    assert.deepEqual(shapeOf(after[index]), shapeOf(before[index]), `row ${before[index].outbox_id} is byte-identical`);
    assert.equal(Number(after[index].rid), Number(before[index].rid), 'the rowid is preserved (no table rewrite)');
    assert.equal(after[index].claim_owner, '');
    assert.equal(Number(after[index].claimed_until), 0);
  }
  db.close();
});

test('migration matrix: repeated migrate() on the same handle is idempotent', t => {
  const { file } = tempFile(t);
  const v1 = buildV1(file);
  v1.close();

  const db = createDb({ file, now: () => T0, pragmas: false });
  t.after(() => { try { db.close(); } catch { /* already closed */ } });
  const first = db.migrate();
  assert.deepEqual(first, [{ from: 1, to: SCHEMA_VERSION, at: T0 }]);
  const columnsAfterFirst = columnsOf(db);
  for (let attempt = 2; attempt <= 3; attempt += 1) {
    assert.deepEqual(db.migrate(), [], `migrate #${attempt} applies nothing`);
    assert.deepEqual(columnsOf(db), columnsAfterFirst, `migrate #${attempt} adds no duplicate column`);
    assert.equal(db.schemaVersion(), SCHEMA_VERSION);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM schema_migrations').n, 2, 'one v1 row plus one v2 row');
    assert.equal(db.get('SELECT COUNT(*) AS n FROM memory_outbox').n, 2, 'repeated migration never rewrites rows');
  }
  db.close();
});

test('migration matrix: close/reopen keeps v2 and the migrated data, and new queries see 13 columns', t => {
  const { file } = tempFile(t);
  const v1 = buildV1(file);
  v1.close();
  const first = openRuntimeDb({ file, now: () => T0 });
  const before = first.all('SELECT rowid AS rid, * FROM memory_outbox ORDER BY outbox_id');
  first.close();

  const second = openRuntimeDb({ file, now: () => T0 + 60000 });
  assert.equal(second.schemaVersion(), SCHEMA_VERSION, 'the version is durable');
  assert.deepEqual(second.migrate(), [], 'reopening does not re-run the migration');
  const after = second.all('SELECT rowid AS rid, * FROM memory_outbox ORDER BY outbox_id');
  const plain = second.all('SELECT * FROM memory_outbox ORDER BY outbox_id');
  assert.equal(Object.keys(plain[0]).length, 13, 'a query prepared after the reopen sees the v2 width');
  assert.equal(after.length, before.length);
  for (let index = 0; index < before.length; index += 1) {
    assert.deepEqual(shapeOf(after[index]), shapeOf(before[index]));
    assert.equal(Number(after[index].rid), Number(before[index].rid));
  }
  // The v2 claim columns are usable by the drain path after a reopen.
  second.run("UPDATE memory_outbox SET claimed_until = ?, claim_owner = ? WHERE outbox_id = 'ob-v1'", T0 + 60000, 'gen-reopen');
  const claimed = second.get("SELECT claimed_until, claim_owner FROM memory_outbox WHERE outbox_id = 'ob-v1'");
  assert.equal(Number(claimed.claimed_until), T0 + 60000);
  assert.equal(claimed.claim_owner, 'gen-reopen');
  second.close();
});
