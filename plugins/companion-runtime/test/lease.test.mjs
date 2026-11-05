import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openRuntimeDb, createDb, SCHEMA_VERSION } from '../lib/db.mjs';
import { normalizeEvent, dispatchEvent } from '../lib/events.mjs';
import { scopeKey } from '../lib/scope.mjs';
import { StaleGenerationError } from '../lib/errors.mjs';

const SCOPE = Object.freeze({ userId: 'owner-1', personaId: 'march7', worldId: '' });
const KEY = scopeKey(SCOPE);
const T0 = Date.UTC(2026, 9, 29, 2, 0, 0);

function tempFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-lease-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });
  return path.join(dir, 'runtime.db');
}

function handlers() {
  return { goals: ({ slice }) => ({ slice: { applied: Number(slice.applied ?? 0) + 1 } }) };
}

test('A10: five reloads keep exactly one lease row and one writer', t => {
  const file = tempFile(t);
  let clock = T0;
  const generations = [];
  for (let i = 0; i < 5; i += 1) {
    const db = openRuntimeDb({ file, now: () => clock });
    const generation = `gen-${i}`;
    const lease = db.acquireLease({ owner: `owner-${i}`, generation, ttlMs: 60000 });
    assert.equal(lease.ok, true, `reload ${i} acquires the free lease`);
    generations.push(generation);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM runtime_lease').n, 1, 'never more than one lease row');
    assert.equal(db.get('SELECT generation FROM runtime_lease').generation, generation);
    db.releaseLease(generation);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM runtime_lease').n, 0);
    db.close();
    clock += 1000;
  }
  const verify = openRuntimeDb({ file, now: () => clock });
  assert.equal(verify.get('SELECT COUNT(*) AS n FROM runtime_lease').n, 0);
  assert.equal(verify.get('SELECT COUNT(*) AS n FROM domain_events').n, 0, 'reloads alone write no events');
  verify.close();
});

test('A10: a live lease owned elsewhere is not stolen; an expired lease is taken over', t => {
  const file = tempFile(t);
  let clock = T0;
  const first = openRuntimeDb({ file, now: () => clock });
  assert.equal(first.acquireLease({ owner: 'A', generation: 'gen-a', ttlMs: 60000 }).ok, true);

  const second = openRuntimeDb({ file, now: () => clock });
  const denied = second.acquireLease({ owner: 'B', generation: 'gen-b', ttlMs: 60000 });
  assert.equal(denied.ok, false);
  assert.equal(denied.owner, 'A');
  assert.equal(second.currentGeneration(), 'gen-a', 'the active generation is unchanged');

  clock += 61000;
  const takeover = second.acquireLease({ owner: 'B', generation: 'gen-b', ttlMs: 60000 });
  assert.equal(takeover.ok, true);
  assert.equal(second.currentGeneration(), 'gen-b');

  const event = normalizeEvent({ kind: 'goal/proposed', scope: SCOPE, occurredAt: clock, payload: { title: 'after reload' } });
  assert.throws(
    () => dispatchEvent(first, event, { handlers: handlers(), generation: 'gen-a' }),
    error => error instanceof StaleGenerationError,
  );
  const accepted = dispatchEvent(second, event, { handlers: handlers(), generation: 'gen-b' });
  assert.equal(accepted.inserted, true);
  assert.equal(second.projection(KEY).version, 1);
  first.close();
  second.close();
});

test('A10: heartbeat extends the lease, release from a stale generation is refused', t => {
  const file = tempFile(t);
  let clock = T0;
  const db = openRuntimeDb({ file, now: () => clock });
  db.acquireLease({ owner: 'A', generation: 'gen-a', ttlMs: 30000 });
  clock += 20000;
  assert.equal(db.heartbeatLease({ owner: 'A', generation: 'gen-a', ttlMs: 30000 }), true);
  assert.equal(db.heartbeatLease({ owner: 'B', generation: 'gen-b', ttlMs: 30000 }), false);
  clock += 20000;
  const other = openRuntimeDb({ file, now: () => clock });
  assert.equal(other.acquireLease({ owner: 'B', generation: 'gen-b', ttlMs: 30000 }).ok, false, 'the heartbeat kept the lease alive');
  assert.equal(other.releaseLease('gen-a', 'B'), false, 'another owner cannot release the live lease');
  assert.equal(db.releaseLease('gen-a', 'A'), true);
  db.close();
  other.close();
});

test('A10: stop latches and no further commit is accepted, including from a live generation', t => {
  const file = tempFile(t);
  const db = openRuntimeDb({ file, now: () => T0 });
  db.acquireLease({ owner: 'A', generation: 'gen-a', ttlMs: 60000 });
  db.setStopped(true, 'operator-stop');
  const event = normalizeEvent({ kind: 'goal/proposed', scope: SCOPE, occurredAt: T0, payload: { title: 'x' } });
  assert.throws(() => dispatchEvent(db, event, { handlers: handlers(), generation: 'gen-a' }), /stopped/);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM domain_events').n, 0);
  // Stopping survives a reload: the latch is persisted, not process-local.
  db.close();
  const reopened = openRuntimeDb({ file, now: () => T0 });
  assert.equal(reopened.isStopped(), true);
  reopened.setStopped(false);
  assert.equal(reopened.isStopped(), false);
  reopened.close();
});

test('R3: a v1 database receives the drain-claim columns by additive migration', t => {
  const file = tempFile(t);
  const old = createDb({ file, now: () => T0, pragmas: false });
  old.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '');
    INSERT INTO schema_migrations (version, applied_at, note) VALUES (1, ${T0}, 'cognitive-continuity v1');
    CREATE TABLE memory_outbox (
      outbox_id TEXT PRIMARY KEY, scope TEXT NOT NULL, event_id TEXT NOT NULL, namespace TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'queued', receipt_id TEXT NOT NULL DEFAULT '',
      attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    INSERT INTO memory_outbox (outbox_id, scope, event_id, namespace, created_at, updated_at)
      VALUES ('ob-1', 'u:owner-1|p:march7|w:world:default', 'ev-1', 'companion.event', ${T0}, ${T0});`);
  old.close();

  const db = openRuntimeDb({ file, now: () => T0 });
  assert.equal(db.schemaVersion(), SCHEMA_VERSION);
  const columns = db.all('PRAGMA table_info(memory_outbox)').map(column => column.name);
  assert.ok(columns.includes('claimed_until'), 'the claim column is added');
  assert.ok(columns.includes('claim_owner'));
  const row = db.get("SELECT * FROM memory_outbox WHERE outbox_id = 'ob-1'");
  assert.equal(row.status, 'queued', 'existing rows survive the migration');
  assert.equal(Number(row.claimed_until), 0, 'an old row starts unclaimed');
  assert.equal(row.claim_owner, '');
  db.close();
});

test('migrations are forward-only, idempotent and versioned', t => {
  const file = tempFile(t);
  const first = openRuntimeDb({ file, now: () => T0 });
  assert.equal(first.schemaVersion(), SCHEMA_VERSION);
  first.close();
  const raw = createDb({ file, now: () => T0, pragmas: false });
  raw.migrate();
  assert.equal(raw.schemaVersion(), SCHEMA_VERSION, 're-running migrate does not duplicate the version');
  const tables = raw.all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map(row => row.name);
  for (const table of ['belief_dependents', 'belief_evidence', 'beliefs', 'commitments', 'consumer_receipts',
    'domain_events', 'goals', 'memory_outbox', 'role_state', 'runtime_lease', 'runtime_meta',
    'schema_migrations', 'scope_snapshots', 'shadow_proposals', 'wm_checkpoints', 'working_memory',
    'agenda_items', 'agenda_occurrences', 'heartbeat_cursor']) {
    assert.ok(tables.includes(table), `missing table ${table}`);
  }
  raw.close();
});
