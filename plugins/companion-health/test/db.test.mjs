// Storage layer: migrations, WAL, transactions, integrity, backup (INTERFACES.md §3/§4).
//
// Every database in this file is `:memory:` or lives under `os.tmpdir()` and is
// removed afterwards. **Nothing here may touch `<repo>/home/health/health.db`** —
// that file belongs to the running companion, and a test that writes it can wipe
// a real person's health history.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HEALTH_TZ, SCHEMA_VERSION, openHealthDb } from '../lib/db.mjs';
import { MIGRATIONS, applyMigrations } from '../lib/migrations.mjs';

const EXPECTED_TABLES = [
  'health_meta',
  'health_sources',
  'health_sync_runs',
  'health_observations',
  'health_workout_sessions',
  'health_devices',
  'health_daily_summaries',
  'health_sleep_sessions',
  'health_sleep_stages',
  'health_consents',
  'health_care_candidates',
  'health_raw_refs',
  // v2 — live pulse sessions (derived statistics only; see design/pulse-bond-20261103.md)
  'health_pulse_sessions',
];

const EXPECTED_INDEXES = [
  'idx_health_observations_source_at',
  'idx_health_observations_kind_at',
  'idx_health_workout_sessions_start',
  'idx_health_sleep_sessions_date',
  'idx_health_sleep_stages_session_start',
  'idx_health_sync_runs_started',
  'idx_health_care_candidates_status',
  'idx_health_pulse_sessions_started',
  'idx_health_pulse_sessions_open',
];

function withTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-db-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('openHealthDb exposes the contract surface and health timezone', () => {
  const db = openHealthDb({ file: ':memory:' });
  try {
    assert.equal(HEALTH_TZ, 'Asia/Shanghai');
    // v3：主动关怀投递台账（`health_care_delivered`）。版本号只向前走。
    assert.equal(SCHEMA_VERSION, 3);
    for (const key of ['file', 'journalMode', 'migrate', 'tx', 'run', 'all', 'get', 'stats', 'integrity', 'backupTo', 'close']) {
      assert.ok(db[key] !== undefined, `missing db.${key}`);
    }
    assert.equal(typeof db.tx, 'function');
  } finally {
    db.close();
  }
});

test('openHealthDb migrates to the current version on open and migrate() is idempotent', () => {
  const db = openHealthDb({ file: ':memory:' });
  try {
    assert.deepEqual(db.initialMigration.from, 0);
    assert.deepEqual(db.initialMigration.to, SCHEMA_VERSION);
    assert.equal(db.initialMigration.applied.length, MIGRATIONS.length);
    assert.equal(db.schemaVersion, SCHEMA_VERSION);

    // Second call does no work and says so.
    const again = db.migrate();
    assert.deepEqual(again, { from: SCHEMA_VERSION, to: SCHEMA_VERSION, applied: [] });
    assert.equal(db.schemaVersion, SCHEMA_VERSION);
  } finally {
    db.close();
  }
});

test('migration v1 creates exactly the frozen tables and indexes', () => {
  const db = openHealthDb({ file: ':memory:' });
  try {
    const tables = db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .map(row => String(row.name));
    for (const name of EXPECTED_TABLES) assert.ok(tables.includes(name), `missing table ${name}`);
    const indexes = db.all("SELECT name FROM sqlite_master WHERE type = 'index'")
      .map(row => String(row.name));
    for (const name of EXPECTED_INDEXES) assert.ok(indexes.includes(name), `missing index ${name}`);
    assert.equal(MIGRATIONS.length, 3);
    assert.equal(MIGRATIONS[0].version, 1);
    assert.equal(MIGRATIONS[1].version, 2);
    assert.equal(MIGRATIONS[2].version, 3);
  } finally {
    db.close();
  }
});

test('a database written by a newer build is refused, not downgraded', () => {
  const db = openHealthDb({ file: ':memory:' });
  db.exec('PRAGMA user_version = 99');
  try {
    assert.throws(() => applyMigrations({ exec: db.exec, run: db.run, get: db.get, all: db.all }), /高于本代码支持/);
  } finally {
    db.close();
  }
});

test('tx commits, rolls back on throw, and nests through savepoints', () => {
  const db = openHealthDb({ file: ':memory:' });
  try {
    db.setMeta('a', '1');
    const value = db.tx(() => {
      db.setMeta('b', '2');
      return 'committed';
    });
    assert.equal(value, 'committed');
    assert.equal(db.meta('b'), '2');

    assert.throws(() => db.tx(() => {
      db.setMeta('c', '3');
      throw new Error('boom');
    }), /boom/);
    assert.equal(db.meta('c'), null, 'failed transaction must roll back');

    // Inner failure collapses only the inner unit; the outer one still commits.
    db.tx(() => {
      db.setMeta('outer', 'yes');
      try {
        db.tx(() => {
          db.setMeta('inner', 'nope');
          throw new Error('inner');
        });
      } catch { /* handled here */ }
    });
    assert.equal(db.meta('outer'), 'yes');
    assert.equal(db.meta('inner'), null);
  } finally {
    db.close();
  }
});

test('tx rejects an async callback instead of silently committing nothing', () => {
  const db = openHealthDb({ file: ':memory:' });
  try {
    assert.throws(() => db.tx(async () => {}), /同步函数/);
    assert.equal(db.inTransaction(), false);
  } finally {
    db.close();
  }
});

test('run/all/get bind undefined and booleans the way SQLite expects', () => {
  const db = openHealthDb({ file: ':memory:' });
  try {
    db.run(
      `INSERT INTO health_sources
         (id, kind, provider, owner_scope, display_name, capabilities_json, auth_status, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['s1', 'wearable-cloud', 'huawei_cn_cloud', 'owner-only', '来源', '{}', 'unknown', true],
    );
    const row = db.get('SELECT * FROM health_sources WHERE id = ?', ['s1']);
    assert.equal(row.enabled, 1);
    db.run('UPDATE health_sources SET last_success_at = ? WHERE id = ?', [undefined, 's1']);
    assert.equal(db.get('SELECT last_success_at FROM health_sources WHERE id = ?', ['s1']).last_success_at, null);
    assert.equal(db.get('SELECT * FROM health_sources WHERE id = ?', ['nope']), null);
    assert.equal(db.all('SELECT * FROM health_sources', []).length, 1);
  } finally {
    db.close();
  }
});

test('integrity reports quick_check and foreign_key_check without throwing on an empty store', () => {
  const db = openHealthDb({ file: ':memory:' });
  try {
    const report = db.integrity();
    assert.equal(report.ok, true);
    assert.equal(report.quickCheck, true);
    assert.equal(report.foreignKeyViolations, 0);
    assert.deepEqual(report.messages, []);
  } finally {
    db.close();
  }
});

test('integrity catches a dangling sleep stage through the foreign key', () => {
  const db = openHealthDb({ file: ':memory:' });
  try {
    // foreign_keys is ON, so the insert itself is refused — the check would then
    // be vacuously true. Disable it for this one handle to simulate a corrupted file.
    db.exec('PRAGMA foreign_keys = OFF');
    db.run(
      `INSERT INTO health_sleep_stages (session_id, stage_index, stage, start_at, end_at, source_stage_code, fidelity)
       VALUES ('ghost', 0, 'deep', 1, 2, NULL, 'exact')`,
    );
    const report = db.integrity();
    assert.equal(report.foreignKeyViolations, 1);
    assert.equal(report.ok, false);
  } finally {
    db.close();
  }
});

test('stats counts every table and reports sizeBytes', () => {
  const db = openHealthDb({ file: ':memory:' });
  try {
    const empty = db.stats();
    for (const key of ['observations', 'workouts', 'devices', 'dailySummaries', 'sleepSessions',
      'sleepStages', 'rawRefs', 'syncRuns', 'careCandidates', 'sizeBytes']) {
      assert.ok(Object.hasOwn(empty, key), `missing stats.${key}`);
    }
    assert.equal(empty.observations, 0);
    assert.equal(empty.sizeBytes, 0, 'an in-memory database has no file');

    db.run(
      `INSERT INTO health_observations
         (id, source_id, source_key, kind, granularity, sample_at, value, unit,
          observed_value_json, quality, source_updated_at, fetched_at, raw_ref, revision)
       VALUES ('o1', 's', 'k', 'heart_rate', 'day', 1, 95, 'bpm', '{}', 'fresh', NULL, 1, NULL, 1)`,
    );
    assert.equal(db.stats().observations, 1);
  } finally {
    db.close();
  }
});

test('a file-backed database reports wal plus sizeBytes of db and -wal', (t) => {
  const dir = withTempDir(t);
  const file = path.join(dir, 'health.db');
  const db = openHealthDb({ file });
  try {
    assert.equal(db.journalMode, 'wal');
    db.setMeta('k', 'v');
    const stats = db.stats();
    assert.ok(stats.sizeBytes > 0, 'file database must report a size');
    const onDisk = fs.statSync(file).size;
    assert.ok(stats.sizeBytes >= onDisk, 'sizeBytes covers db + -wal');
  } finally {
    db.close();
  }
  assert.ok(fs.existsSync(file));
});

test('backupTo writes a reopenable snapshot outside the source database', (t) => {
  const dir = withTempDir(t);
  const source = path.join(dir, 'health.db');
  const target = path.join(dir, 'nested', "back'up.db");
  const db = openHealthDb({ file: source });
  try {
    db.setMeta('kept', 'yes');
    const receipt = db.backupTo(target);
    assert.equal(receipt.path, path.resolve(target));
    assert.ok(receipt.bytes > 0);
    assert.equal(typeof receipt.at, 'number');
    assert.ok(fs.existsSync(target));

    // Overwriting an existing copy works (VACUUM INTO refuses an existing file,
    // so the implementation must unlink first).
    const second = db.backupTo(target);
    assert.ok(second.bytes > 0);
  } finally {
    db.close();
  }

  const reopened = openHealthDb({ file: target });
  try {
    assert.equal(reopened.meta('kept'), 'yes');
    assert.equal(reopened.integrity().ok, true);
  } finally {
    reopened.close();
  }
});

test('backupTo refuses the live database path and an empty path', (t) => {
  const dir = withTempDir(t);
  const source = path.join(dir, 'health.db');
  const db = openHealthDb({ file: source });
  try {
    assert.throws(() => db.backupTo(source), /不能与当前数据库文件相同/);
    assert.throws(() => db.backupTo(''), /不能为空/);
  } finally {
    db.close();
  }
});

test('close is idempotent and later calls fail loudly', () => {
  const db = openHealthDb({ file: ':memory:' });
  db.close();
  db.close();
  assert.throws(() => db.run('SELECT 1'), /已关闭/);
});

test('openHealthDb rejects an empty path', () => {
  assert.throws(() => openHealthDb({ file: '' }), /不能为空/);
});

test('schema_version is readable through PRAGMA user_version', () => {
  const db = openHealthDb({ file: ':memory:' });
  try {
    assert.equal(db.get('PRAGMA user_version').user_version, SCHEMA_VERSION);
  } finally {
    db.close();
  }
});
