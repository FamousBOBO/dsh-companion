import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb, openRuntimeDb, SCHEMA_VERSION } from '../lib/db.mjs';
import { RuntimeError } from '../lib/errors.mjs';

// HH14 (first half): the v2 -> v3 upgrade must be additive and atomic. A new database,
// an existing v2 database, an aborted migration and a future schema are all covered
// here; the consistency-backup half lives in backup-restore.test.mjs.

const T0 = Date.UTC(2026, 9, 29, 2, 0, 0);

function tempDir(t, label = 'migration-v3') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });
  return dir;
}

/** Build a database that looks exactly like a v2 runtime: v3 tables absent, v2 rows present. */
function buildV2Fixture(dir, now = T0) {
  const file = path.join(dir, 'runtime-v2.db');
  const db = openRuntimeDb({ file, now: () => now });
  db.tx(() => {
    db.exec('DROP TABLE agenda_items');
    db.exec('DROP TABLE agenda_occurrences');
    db.exec('DROP TABLE heartbeat_cursor');
    db.run('DELETE FROM schema_migrations WHERE version > 2');
    db.run("INSERT INTO schema_migrations (version, applied_at, note) VALUES (2, ?, 'cognitive-continuity v2 (outbox claims)')", now);
    // P1 state that must survive the upgrade untouched.
    db.run(`INSERT INTO goals (goal_id, scope, title, source, authorization, status, overdue, deadline_at, revision, created_at, updated_at, completed_steps, next_step, waiting_on, checkpoint, superseded_by, history)
            VALUES ('goal_v2', 'u:owner-1|p:bot|w:world:default', 'v2 goal', 'conversation', 'none', 'running', 0, NULL, 3, ?, ?, '[]', 'next', '', '{}', '', '[]')`, now, now);
    db.run(`INSERT INTO domain_events (seq, event_id, schema_version, kind, scope, user_id, persona_id, world_id, session_id, occurred_at, recorded_at, correlation_id, causation_id, root_evidence, reality_status, evidence_status, config_version, model_version, payload)
            VALUES (1, 'evt_v2', 1, 'goal/proposed', 'u:owner-1|p:bot|w:world:default', 'owner-1', 'bot', 'world:default', 's1', ?, ?, '', '', '[]', 'actual_tool_activity', 'observed', 'p1-cognitive-continuity-v1', '', '{"title":"v2 goal"}')`, now, now);
    db.run(`INSERT INTO consumer_receipts (consumer, event_id, scope, applied_at, state_version, result)
            VALUES ('goals', 'evt_v2', 'u:owner-1|p:bot|w:world:default', ?, 1, '{}')`, now);
  });
  db.metaSet('generation', 'gen-v2');
  db.close();
  return file;
}

function tableNames(db) {
  return db.all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map(row => row.name);
}

test('HH14: a fresh database opens at v3 with every P1 and agenda table', t => {
  const file = path.join(tempDir(t), 'fresh.db');
  const db = openRuntimeDb({ file, now: () => T0 });
  assert.equal(db.schemaVersion(), SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, 4, 'schema version only ever moves forward');
  const tables = tableNames(db);
  for (const table of ['agenda_items', 'agenda_occurrences', 'heartbeat_cursor', 'goals', 'beliefs', 'memory_outbox', 'runtime_lease', 'runtime_meta', 'scope_snapshots']) {
    assert.ok(tables.includes(table), `missing table ${table}`);
  }
  const migration = db.all('SELECT version FROM schema_migrations ORDER BY version');
  assert.deepEqual(migration.map(row => Number(row.version)), [SCHEMA_VERSION], 'one migration row, not one per statement');
  db.close();
});

test('HH14: v2 upgrades in place, keeps goals/events/receipts/outbox rows and adds empty agenda tables', t => {
  const dir = tempDir(t);
  const file = buildV2Fixture(dir);
  const db = openRuntimeDb({ file, now: () => T0 });
  assert.equal(db.schemaVersion(), SCHEMA_VERSION);
  assert.deepEqual(db.all('SELECT version FROM schema_migrations ORDER BY version').map(row => Number(row.version)), [2, SCHEMA_VERSION]);

  const goal = db.get("SELECT * FROM goals WHERE goal_id = 'goal_v2'");
  assert.equal(goal.title, 'v2 goal', 'the P1 goal row is preserved byte for byte');
  assert.equal(Number(goal.revision), 3);
  assert.equal(Number(db.get("SELECT COUNT(*) AS n FROM domain_events WHERE event_id = 'evt_v2'").n), 1);
  assert.equal(Number(db.get("SELECT COUNT(*) AS n FROM consumer_receipts WHERE event_id = 'evt_v2'").n), 1);
  assert.equal(db.metaGet('generation'), 'gen-v2', 'the generation meta row survives');

  // The new tables exist and are empty: upgrading never fabricates agenda state.
  assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM agenda_items').n), 0);
  assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM agenda_occurrences').n), 0);
  assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM heartbeat_cursor').n), 0);
  db.close();

  // Re-opening is idempotent: no third migration row, no error.
  const again = openRuntimeDb({ file, now: () => T0 });
  assert.equal(again.schemaVersion(), SCHEMA_VERSION);
  assert.deepEqual(again.all('SELECT version FROM schema_migrations ORDER BY version').map(row => Number(row.version)), [2, SCHEMA_VERSION]);
  again.close();
});

test('HH14: an aborted migration leaves no half-built schema and no v3 row', t => {
  const dir = tempDir(t);
  const file = buildV2Fixture(dir);
  // Force the migration to fail after it has already started creating tables: a view with
  // the name of one of the new tables makes CREATE TABLE IF NOT EXISTS throw. The whole
  // migration transaction must roll back, including the tables created before the failure.
  const raw = createDb({ file, now: () => T0, pragmas: false });
  raw.exec('CREATE VIEW heartbeat_cursor AS SELECT 1 AS scope');
  raw.close();

  assert.throws(() => {
    const broken = createDb({ file, now: () => T0, pragmas: false });
    try { broken.migrate(); } finally { broken.close(); }
  }, /view|already exists|index/i);

  const after = createDb({ file, now: () => T0, pragmas: false });
  assert.equal(after.schemaVersion(), 2, 'the failed migration did not record the new version');
  assert.ok(!tableNames(after).includes('agenda_items'), 'no half-created agenda_items table');
  const goal = after.get("SELECT title FROM goals WHERE goal_id = 'goal_v2'");
  assert.equal(goal.title, 'v2 goal', 'the failed migration did not damage P1 rows');
  after.close();
});

test('HH14: a database from a newer runtime is refused, not silently opened', t => {
  const dir = tempDir(t);
  const file = buildV2Fixture(dir);
  const raw = createDb({ file, now: () => T0, pragmas: false });
  raw.run("INSERT INTO schema_migrations (version, applied_at, note) VALUES (99, ?, 'from-the-future')", T0);
  raw.close();

  let thrown = null;
  try { openRuntimeDb({ file, now: () => T0 }); } catch (error) { thrown = error; }
  assert.ok(thrown instanceof RuntimeError, 'a future schema throws a typed runtime error');
  assert.equal(thrown.code, 'schema-newer');

  const verify = createDb({ file, now: () => T0, pragmas: false });
  assert.equal(verify.schemaVersion(), 99, 'the refused open did not alter the version table');
  assert.equal(verify.get("SELECT title FROM goals WHERE goal_id = 'goal_v2'").title, 'v2 goal');
  verify.close();
});
