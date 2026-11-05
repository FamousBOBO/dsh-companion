import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb, openRuntimeDb, SCHEMA_VERSION } from '../lib/db.mjs';

// HH14 (second half): a production migration must be preceded by a *consistent* SQLite
// backup. Copying the live main database file while a WAL is pending is not a backup; this
// file proves the difference and verifies that a VACUUM INTO snapshot restores with the
// same rows and a passing integrity_check.

const T0 = Date.UTC(2026, 9, 30, 1, 0, 0);
const SCOPE = 'u:owner-1|p:bot|w:world:default';

function tempDir(t, label = 'backup-restore') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });
  return dir;
}

/** A v2-shaped database with P1 rows that must survive the upgrade. */
function seedV2(dir) {
  const file = path.join(dir, 'live-v2.db');
  const db = openRuntimeDb({ file, now: () => T0 });
  db.tx(() => {
    db.exec('DROP TABLE agenda_items');
    db.exec('DROP TABLE agenda_occurrences');
    db.exec('DROP TABLE heartbeat_cursor');
    db.run('DELETE FROM schema_migrations WHERE version > 2');
    db.run("INSERT INTO schema_migrations (version, applied_at, note) VALUES (2, ?, 'v2')", T0);
    db.run(`INSERT INTO goals (goal_id, scope, title, source, authorization, status, overdue, deadline_at, revision, created_at, updated_at, completed_steps, next_step, waiting_on, checkpoint, superseded_by, history)
            VALUES ('goal_backup', ?, '备份前目标', 'conversation', 'none', 'running', 0, NULL, 2, ?, ?, '[]', 'next', '', '{}', '', '[]')`, SCOPE, T0, T0);
    for (let index = 0; index < 40; index += 1) {
      db.run(`INSERT INTO domain_events (seq, event_id, schema_version, kind, scope, user_id, persona_id, world_id, session_id, occurred_at, recorded_at, correlation_id, causation_id, root_evidence, reality_status, evidence_status, config_version, model_version, payload)
              VALUES (?, ?, 1, 'goal/step', ?, 'owner-1', 'bot', 'world:default', 's1', ?, ?, '', '', '[]', 'actual_tool_activity', 'observed', 'p1-cognitive-continuity-v1', '', ?)`,
      index + 1, `evt_backup_${index}`, SCOPE, T0 + index, T0 + index, JSON.stringify({ goalId: 'goal_backup', step: `s${index}` }));
      db.run(`INSERT INTO consumer_receipts (consumer, event_id, scope, applied_at, state_version, result)
              VALUES ('goals', ?, ?, ?, ?, '{}')`, `evt_backup_${index}`, SCOPE, T0 + index, index + 1);
    }
  });
  // Keep the pending WAL pending: a plain main-file copy must not be mistaken for a backup.
  db.exec('PRAGMA wal_autocheckpoint = 0');
  db.tx(() => {
    db.run(`INSERT INTO commitments (commitment_id, scope, goal_id, body, status, due_at, revision, created_at, updated_at, closed_reason)
            VALUES ('cm_backup', ?, 'goal_backup', '备份前承诺', 'open', NULL, 1, ?, ?, '')`, SCOPE, T0, T0);
  });
  return { file, db };
}

function counts(db) {
  return {
    goals: Number(db.get('SELECT COUNT(*) AS n FROM goals').n),
    commitments: Number(db.get('SELECT COUNT(*) AS n FROM commitments').n),
    events: Number(db.get('SELECT COUNT(*) AS n FROM domain_events').n),
    receipts: Number(db.get('SELECT COUNT(*) AS n FROM consumer_receipts').n),
  };
}

function integrity(file) {
  const probe = createDb({ file, now: () => T0, pragmas: false });
  try {
    return { integrity: probe.get('PRAGMA integrity_check').integrity_check, counts: counts(probe) };
  } finally {
    probe.close();
  }
}

test('HH14: VACUUM INTO produces a consistent single-file backup of a live WAL database', t => {
  const dir = tempDir(t);
  const { file, db } = seedV2(dir);
  t.after(() => { try { db.close(); } catch { /* already closed */ } });

  const live = counts(db);
  assert.equal(live.events, 40);
  const walFile = `${file}-wal`;
  assert.ok(fs.existsSync(walFile), 'the WAL file exists');
  const walSize = fs.statSync(walFile).size;
  assert.ok(walSize > 0, `the WAL actually holds pending pages (${walSize} bytes)`);

  // Proof that a main-file-only copy is not a backup: with autocheckpoint disabled the new
  // rows (here: the whole schema, because the fixture was created after the switch) live
  // only in the WAL, so a plain copy is stale or unusable.
  const naive = path.join(dir, 'naive-copy.db');
  fs.copyFileSync(file, naive);
  let naiveCounts = null;
  let naiveError = null;
  try { naiveCounts = integrity(naive).counts; } catch (error) { naiveError = error.message; }
  assert.ok(
    naiveError !== null
      || naiveCounts.commitments < live.commitments
      || naiveCounts.events < live.events,
    `a plain main-file copy must not look complete (live ${JSON.stringify(live)} vs copy ${JSON.stringify(naiveCounts ?? naiveError)})`,
  );

  const backup = path.join(dir, 'consistent-backup.db');
  db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
  assert.ok(fs.existsSync(backup));
  assert.ok(!fs.existsSync(`${backup}-wal`), 'a VACUUM INTO snapshot is a single file with no pending WAL');

  const snap = integrity(backup);
  assert.equal(snap.integrity, 'ok');
  assert.deepEqual(snap.counts, live, 'the snapshot has exactly the live row counts, including WAL-resident rows');
});

test('HH14: restoring the consistent snapshot upgrades it to v3 and preserves every P1 row', t => {
  const dir = tempDir(t);
  const { file, db } = seedV2(dir);
  const live = counts(db);
  const backup = path.join(dir, 'consistent-backup.db');
  db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
  db.close();

  const restoredFile = path.join(dir, 'restored.db');
  fs.copyFileSync(backup, restoredFile);

  const restored = openRuntimeDb({ file: restoredFile, now: () => T0 });
  try {
    assert.equal(restored.schemaVersion(), SCHEMA_VERSION, 'the restore migrates forward, never sidewards');
    assert.deepEqual(counts(restored), live, 'no P1 row is lost by backup + restore + migration');
    assert.equal(restored.get("SELECT title FROM goals WHERE goal_id = 'goal_backup'").title, '备份前目标');
    assert.equal(restored.get("SELECT body FROM commitments WHERE commitment_id = 'cm_backup'").body, '备份前承诺');
    assert.equal(Number(restored.get('SELECT COUNT(*) AS n FROM agenda_items').n), 0, 'the upgrade fabricates no agenda row');
    assert.equal(restored.get('PRAGMA integrity_check').integrity_check, 'ok');
  } finally {
    restored.close();
  }

  // The backup itself is still a v2 file: an old runtime could read it, which is what makes
  // it a usable rollback artifact rather than a forward-only trap.
  assert.equal(integrity(backup).integrity, 'ok');
  const raw = createDb({ file: backup, now: () => T0, pragmas: false });
  assert.equal(raw.schemaVersion(), 2);
  raw.close();
  assert.ok(fs.existsSync(file));
});

test('HH14: an open write transaction is never snapshotted as if it were committed', t => {
  const dir = tempDir(t);
  const { file, db } = seedV2(dir);
  t.after(() => { try { db.close(); } catch { /* already closed */ } });
  const live = counts(db);
  const backup = path.join(dir, 'in-tx-backup.db');
  // VACUUM INTO cannot run inside a write transaction; the migration/backup procedure must
  // therefore be quiescent. Assert the failure is explicit instead of silently half-written.
  assert.throws(() => {
    db.tx(() => {
      db.run(`INSERT INTO commitments (commitment_id, scope, goal_id, body, status, due_at, revision, created_at, updated_at, closed_reason)
              VALUES ('cm_tx', ?, 'goal_backup', 'in-tx', 'open', NULL, 1, ?, ?, '')`, SCOPE, T0, T0);
      db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
    });
  }, /cannot VACUUM|transaction/i);
  assert.ok(!fs.existsSync(backup), 'no partial backup file was left behind');
  assert.deepEqual(counts(db), live, 'the failed backup did not change the live database');
});
