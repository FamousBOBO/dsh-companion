import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { StaleGenerationError, StaleRevisionError, RuntimeStoppedError, RuntimeError } from './errors.mjs';

export const SCHEMA_VERSION = 4;
export const GENERATION_KEY = 'generation';
export const STOPPED_KEY = 'stopped';
export const LEASE_ID = 'writer';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = fs.readFileSync(path.join(here, 'schema.sql'), 'utf8');

function safeInt(value, fallback = 0) {
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function ownerPid(owner) {
  const pid = Number(String(owner ?? '').split(':')[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** A numeric owner prefix is the process that mounted the runtime. Treat a dead PID as crash evidence, not a live lease. */
function ownerProcessAlive(owner) {
  const pid = ownerPid(owner);
  if (pid === null) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code !== 'ESRCH'; }
}

/**
 * Authoritative store for cognitive continuity state.
 *
 * The runtime is the only writer of these tables. Every mutation goes through
 * `tx()` — a synchronous BEGIN IMMEDIATE transaction — so state, version and the
 * consumer receipt travel in one commit. An exception rolls the whole unit back.
 */
export function createDb({ file, now = () => Date.now(), pragmas = true } = {}) {
  if (!file) throw new RuntimeError('invalid-input', 'a database file is required');
  const memory = file === ':memory:';
  if (!memory) fs.mkdirSync(path.dirname(file), { recursive: true });
  let raw;
  try {
    raw = new DatabaseSync(file);
  } catch (error) {
    throw new RuntimeError('db-unavailable', error instanceof Error ? error.message : String(error));
  }
  if (pragmas) {
    try {
      raw.exec('PRAGMA journal_mode = WAL');
      raw.exec('PRAGMA synchronous = NORMAL');
      raw.exec('PRAGMA busy_timeout = 5000');
      raw.exec('PRAGMA foreign_keys = ON');
    } catch { /* pragma support varies; never fatal */ }
  }

  const cache = new Map();
  const prepared = sql => {
    let statement = cache.get(sql);
    if (!statement) {
      statement = raw.prepare(sql);
      cache.set(sql, statement);
    }
    return statement;
  };

  let depth = 0;
  const state = { closed: false, migrations: [] };

  const db = {
    file,
    memory,
    raw,
    now: () => safeInt(now()),

    exec(sql) { raw.exec(sql); },
    run(sql, ...params) { return prepared(sql).run(...params); },
    get(sql, ...params) { return prepared(sql).get(...params); },
    all(sql, ...params) { return prepared(sql).all(...params); },

    /** Run `fn` in one transaction; nesting uses savepoints, so a failing inner block rolls back only itself. */
    tx(fn) {
      if (state.closed) throw new RuntimeError('db-closed', 'the runtime database is closed');
      if (depth > 0) {
        depth += 1;
        const name = `sp_${depth}`;
        raw.exec(`SAVEPOINT ${name}`);
        try {
          const value = fn();
          raw.exec(`RELEASE ${name}`);
          return value;
        } catch (error) {
          try { raw.exec(`ROLLBACK TO ${name}`); raw.exec(`RELEASE ${name}`); } catch { /* already unwound */ }
          throw error;
        } finally {
          depth -= 1;
        }
      }
      raw.exec('BEGIN IMMEDIATE');
      depth = 1;
      try {
        const value = fn();
        raw.exec('COMMIT');
        return value;
      } catch (error) {
        try { raw.exec('ROLLBACK'); } catch { /* already rolled back */ }
        throw error;
      } finally {
        depth = 0;
      }
    },

    inTransaction() { return depth > 0; },

    migrate() {
      const applied = db.tx(() => {
        db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, note TEXT NOT NULL DEFAULT \'\')');
        const current = db.get('SELECT MAX(version) AS version FROM schema_migrations');
        const version = Number(current?.version ?? 0);
        // A database written by a newer runtime may contain tables or columns this
        // code cannot interpret. Refuse it explicitly instead of silently returning
        // and then mis-reading a future schema (C5).
        if (version > SCHEMA_VERSION) {
          throw new RuntimeError('schema-newer', `database schema v${version} is newer than this runtime (v${SCHEMA_VERSION}); refusing to open`);
        }
        if (version === SCHEMA_VERSION) {
          // A database that claims the current version but lost one of the v3/v4 tables (a
          // manual DROP, a truncated restore) must be repaired instead of quietly failing
          // every agenda or autonomy query forever. This is a repair, not a new version.
          const present = db.get(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN (
            'agenda_items','agenda_occurrences','heartbeat_cursor',
            'p2_plans','p2_plan_slots','p2_opportunities','p2_interests','p2_activities',
            'p2_activity_receipts','p2_share_candidates','p2_plan_runs','p2_budget_ledger')`);
          if (Number(present?.n ?? 0) === 12) return [];
          db.exec(SCHEMA);
          state.migrations.push({ from: version, to: version, repaired: true, at: db.now() });
          return state.migrations.slice();
        }
        db.exec(SCHEMA);
        // v1 stored no drain claim, so two concurrent drains could deliver the same
        // queued record twice. v2 adds the claim columns; an existing v1 database gets
        // them by additive ALTER (never by rewriting rows).
        if (version > 0) {
          const columns = new Set(db.all('PRAGMA table_info(memory_outbox)').map(column => column.name));
          if (!columns.has('claimed_until')) db.exec('ALTER TABLE memory_outbox ADD COLUMN claimed_until INTEGER NOT NULL DEFAULT 0');
          if (!columns.has('claim_owner')) db.exec('ALTER TABLE memory_outbox ADD COLUMN claim_owner TEXT NOT NULL DEFAULT \'\'');
        }
        // v3 is purely additive (agenda_items / agenda_occurrences / heartbeat_cursor
        // are created by the SCHEMA block above with IF NOT EXISTS): no ALTER, no row
        // rewrite, so a v2 database keeps every P1 row and every receipt untouched.
        db.run('INSERT INTO schema_migrations (version, applied_at, note) VALUES (?, ?, ?)',
          SCHEMA_VERSION, db.now(), version >= 3 ? 'autonomy v4 (additive)' : version === 2 ? 'agenda+heartbeat v3 (additive)' : 'cognitive-continuity v4');
        state.migrations.push({ from: version, to: SCHEMA_VERSION, at: db.now() });
        return state.migrations.slice();
      });

      // A prepared statement keeps the result columns it was compiled with, so a handle
      // that ran `SELECT *` before this migration would keep returning the old width
      // (N-cache, sixth review). Schema changes are rare: drop the cache once the schema
      // actually changed so the next query re-prepares against the real column set.
      if (applied.length) cache.clear();
      return applied;
    },

    schemaVersion() {
      try {
        const row = db.get('SELECT MAX(version) AS version FROM schema_migrations');
        return Number(row?.version ?? 0);
      } catch { return 0; }
    },

    metaGet(key, fallback = null) {
      const row = db.get('SELECT meta_value FROM runtime_meta WHERE meta_key = ?', key);
      return row ? row.meta_value : fallback;
    },

    metaSet(key, value) {
      db.run(`INSERT INTO runtime_meta (meta_key, meta_value, updated_at) VALUES (?, ?, ?)
              ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value, updated_at = excluded.updated_at`,
        key, String(value), db.now());
      return String(value);
    },

    /** False when a host-level stop switch is latched; commits must refuse. */
    isStopped() {
      return db.metaGet(STOPPED_KEY, '0') === '1';
    },

    setStopped(stopped, reason = '') {
      db.metaSet(STOPPED_KEY, stopped ? '1' : '0');
      if (reason) db.metaSet('stopped_reason', reason);
      return db.isStopped();
    },

    currentGeneration() {
      return db.metaGet(GENERATION_KEY, '');
    },

    /**
     * Claim the single-writer lease. Returns the active generation. A live lease
     * owned by another generation wins; an expired lease is taken over and the new
     * generation immediately becomes the only accepted writer.
     */
    acquireLease({ owner, generation, ttlMs = 120000 }) {
      if (!owner || !generation) throw new RuntimeError('invalid-input', 'lease requires owner and generation');
      return db.tx(() => {
        const at = db.now();
        const existing = db.get('SELECT * FROM runtime_lease WHERE lease_id = ?', 'writer');
        const sameProcess = ownerPid(existing?.owner) === process.pid;
        if (existing && Number(existing.expires_at) > at && existing.owner !== owner && existing.generation !== generation && !sameProcess && ownerProcessAlive(existing.owner)) {
          return { ok: false, generation: existing.generation, owner: existing.owner, expiresAt: Number(existing.expires_at) };
        }
        const expiresAt = at + Math.max(1000, safeInt(ttlMs, 120000));
        if (existing) {
          db.run('UPDATE runtime_lease SET owner = ?, generation = ?, heartbeat_at = ?, expires_at = ?, acquired_at = CASE WHEN generation = ? THEN acquired_at ELSE ? END WHERE lease_id = ?',
            owner, generation, at, expiresAt, generation, at, 'writer');
        } else {
          db.run('INSERT INTO runtime_lease (lease_id, owner, generation, acquired_at, heartbeat_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
            'writer', owner, generation, at, at, expiresAt);
        }
        db.metaSet(GENERATION_KEY, generation);
        return { ok: true, generation, owner, expiresAt };
      });
    },

    /**
     * Renew the lease only while it is still ours **and still unexpired**.
     *
     * Renewing an expired row would let a process that was suspended past its TTL wake up and
     * write as a ghost writer in the window before the next owner takes over (P2.5-4A /
     * A1 §4.4 #15). Refusing is the honest answer: the caller is no longer the writer, so it
     * must stop committing and let `acquireLease` decide the next generation.
     */
    heartbeatLease({ owner, generation, ttlMs = 120000 }) {
      const at = db.now();
      const changed = db.run(`UPDATE runtime_lease SET heartbeat_at = ?, expires_at = ?
        WHERE lease_id = ? AND owner = ? AND generation = ? AND expires_at > ?`,
        at, at + Math.max(1000, safeInt(ttlMs, 120000)), 'writer', owner, generation, at);
      return Number(changed.changes ?? 0) > 0;
    },

    releaseLease(generation, owner = null) {
      const row = db.get('SELECT generation, owner FROM runtime_lease WHERE lease_id = ?', 'writer');
      if (!row || row.generation !== generation) return false;
      if (owner !== null && row.owner !== owner) return false;
      db.run('DELETE FROM runtime_lease WHERE lease_id = ?', 'writer');
      return true;
    },

    /**
     * Single lease primitive behind every write gate (P2.5-4A).
     *
     * `assertWritable` used to ask only "is this still the current generation?", which is not
     * enough: a process suspended past its lease TTL — or one that woke up in the gap between
     * the expiry and the next takeover — could still commit as a ghost writer (A1 §4.4 lists
     * fifteen such write paths). Both halves of the fence are decided here, once:
     *   1. the host stop latch is not set;
     *   2. the generation is still the writer generation (`runtime_meta.generation`);
     *   3. when the lease row still names that generation, the row is **unexpired**, and if the
     *      caller knows its `owner`, the row names that owner too;
     *   4. `requireRow` also refuses a missing row, for callers that must hold the lease.
     *
     * A generation-less call keeps the historical "stop latch only" meaning, so replay and
     * read-only tooling (`lib/snapshot.mjs`) are unaffected.
     */
    assertLeaseValid({ owner = null, generation = null, at = null, requireRow = false } = {}) {
      if (db.isStopped()) throw new RuntimeStoppedError();
      if (!generation) {
        if (requireRow) throw new RuntimeError('invalid-input', 'lease check requires owner and generation');
        return { ok: true, checked: 'stop' };
      }
      // `Number(null)` is 0, so an explicit null must mean "the handle's own clock", never epoch 0.
      const when = at === null || at === undefined || !Number.isFinite(Number(at))
        ? db.now()
        : Math.trunc(Number(at));
      const current = db.currentGeneration();
      if (current && current !== generation) throw new StaleGenerationError(generation, current);
      const row = db.get('SELECT owner, generation, expires_at FROM runtime_lease WHERE lease_id = ?', LEASE_ID);
      if (!row) {
        if (requireRow) throw new RuntimeError('lease-lost', 'no writer lease is held');
        // No row and a matching generation meta is the historical "released, not yet
        // re-acquired" state: the generation fence above already refused a takeover.
        return { ok: true, checked: 'generation' };
      }
      if (row.generation !== generation) {
        // Meta and lease row disagree (hand-edited state, truncated restore): fail closed
        // instead of picking whichever half happens to look healthy.
        throw new StaleGenerationError(generation, String(row.generation));
      }
      if (owner && row.owner !== owner) throw new RuntimeError('lease-lost', 'the writer lease is held by another owner');
      if (Number(row.expires_at) <= when) throw new RuntimeError('lease-expired', `writer lease expired at ${Number(row.expires_at)}`);
      return { ok: true, checked: owner ? 'owner+expiry' : 'generation+expiry' };
    },

    /**
     * Commit gate: the stop latch, a generation that is no longer the writer, and — since
     * P2.5-4A — an expired lease row that still carries this generation. Callers that know
     * their `owner` pass `{ owner }` and get the owner match as well; the owner-less form is
     * kept for the many internal writes that only carried a generation.
     */
    assertWritable(generation, { owner = null, at = null } = {}) {
      return db.assertLeaseValid({ owner, generation, at });
    },

    /**
     * Strict single-writer gate for a commit that must not be written by a stale worker: the
     * stop latch, the generation meta row, **and** a lease row that still names this
     * owner+generation and is still unexpired (C5 §12.5.2). `assertWritable` is its weaker
     * sibling; both now share the same expiry fence.
     */
    assertLeaseHeld({ owner, generation, at = db.now() } = {}) {
      if (db.isStopped()) throw new RuntimeStoppedError();
      if (!owner || !generation) throw new RuntimeError('invalid-input', 'lease check requires owner and generation');
      return db.assertLeaseValid({ owner, generation, at, requireRow: true });
    },

    leaseRow() {
      const row = db.get('SELECT owner, generation, heartbeat_at, expires_at FROM runtime_lease WHERE lease_id = ?', LEASE_ID);
      return row
        ? { owner: row.owner, generation: row.generation, heartbeatAt: Number(row.heartbeat_at), expiresAt: Number(row.expires_at) }
        : null;
    },

    projection(scope) {
      const row = db.get('SELECT * FROM scope_snapshots WHERE scope = ?', scope);
      if (!row) return { scope, version: 0, generation: db.currentGeneration(), payload: {}, exists: false };
      let payload = {};
      try { payload = JSON.parse(row.payload || '{}'); } catch { payload = {}; }
      return { scope, version: Number(row.version), generation: row.generation, payload, exists: true };
    },

    /**
     * Commit a projection update atomically. `expectedVersion` (optional) rejects a
     * stale writer; `generation` (optional) rejects a previous run generation; `owner`
     * (optional) additionally requires the lease row to still name this owner (P2.5-4A).
     */
    commitProjection({ scope, generation, owner = null, expectedVersion, payload, updatedAt }) {
      return db.tx(() => {
        db.assertWritable(generation, { owner });
        const row = db.get('SELECT version, generation FROM scope_snapshots WHERE scope = ?', scope);
        const current = row ? Number(row.version) : 0;
        if (expectedVersion !== undefined && expectedVersion !== null && Number(expectedVersion) !== current) {
          throw new StaleRevisionError('scope-projection', Number(expectedVersion), current);
        }
        const next = current + 1;
        const at = safeInt(updatedAt, db.now());
        const text = JSON.stringify(payload ?? {});
        if (row) {
          db.run('UPDATE scope_snapshots SET version = ?, generation = ?, payload = ?, updated_at = ? WHERE scope = ?',
            next, generation ?? row.generation, text, at, scope);
        } else {
          db.run('INSERT INTO scope_snapshots (scope, version, generation, payload, updated_at) VALUES (?, ?, ?, ?, ?)',
            scope, next, generation ?? db.currentGeneration(), text, at);
        }
        return next;
      });
    },

    close() {
      if (state.closed) return;
      state.closed = true;
      cache.clear();
      try { raw.close(); } catch { /* already closed */ }
    },

    isOpen() { return !state.closed; },
    migrations() { return state.migrations.slice(); },
  };

  return db;
}

export function openRuntimeDb({ file, now, pragmas = true } = {}) {
  // Refuse a database written by a newer runtime *before* touching its journal mode or
  // running any pragma: opening a future schema must be a read-only decision, not an
  // unrequested write to the user's file (C5 §12.9 / A1).
  if (file !== ':memory:' && fs.existsSync(file)) {
    let declared = 0;
    let probe = null;
    try {
      probe = new DatabaseSync(file, { readOnly: true });
      const row = probe.prepare('SELECT MAX(version) AS version FROM schema_migrations').get();
      declared = Number(row?.version ?? 0);
    } catch {
      // No reachable schema table yet (fresh or damaged file): let createDb decide.
      declared = 0;
    } finally {
      try { probe?.close(); } catch { /* already closed */ }
    }
    if (declared > SCHEMA_VERSION) {
      throw new RuntimeError('schema-newer', `database schema v${declared} is newer than this runtime (v${SCHEMA_VERSION}); refusing to open`);
    }
  }
  const db = createDb({ file, now, pragmas });
  db.migrate();
  return db;
}
