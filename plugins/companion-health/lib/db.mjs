// SQLite storage for companion-health (INTERFACES.md §3).
//
// Everything here is synchronous on purpose: the read API is called from inside
// a chat turn / an HTTP GET handler, and an await boundary there buys nothing but
// lets two calls interleave on one handle. `syncOnce` is the only async writer and
// it funnels every statement through `tx()`.
//
// Two rules keep this layer honest:
//   1. Table shapes live in `migrations.mjs` and are frozen by the interface
//      contract. This file only opens, configures, transacts, inspects and backs up.
//   2. Nothing secret ever reaches a column: the schema has no token/uid/MAC field,
//      and `cn-adapter.mjs` redacts before anything gets here.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { SCHEMA_VERSION, applyMigrations, readUserVersion } from './migrations.mjs';

// INTERFACES.md §3 puts `SCHEMA_VERSION` on this module, so it is re-exported here
// from the single definition in `migrations.mjs`. One number, two entry points.
export { SCHEMA_VERSION };

/** Display/attribution timezone. Storage is always UTC milliseconds. */
export const HEALTH_TZ = 'Asia/Shanghai';

const BUSY_TIMEOUT_MS = 5000;

/** Bind helper: `node:sqlite` rejects `undefined`, and booleans must become 0/1. */
function bindParams(params) {
  const list = Array.isArray(params) ? params : params === undefined ? [] : [params];
  return list.map(value => {
    if (value === undefined) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    return value;
  });
}

function fileBytes(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * Open (and by default migrate) the health database.
 *
 * `file === ':memory:'` skips directory creation — and WAL is a no-op there, so
 * the pragma is attempted and swallowed: an in-memory database legitimately
 * reports `journal_mode = memory`.
 */
export function openHealthDb({ file, now = () => Date.now(), migrate = true } = {}) {
  if (typeof file !== 'string' || !file.trim()) throw new Error('健康数据库路径不能为空。');
  const inMemory = file === ':memory:';
  const resolved = inMemory ? ':memory:' : path.resolve(file);
  if (!inMemory) fs.mkdirSync(path.dirname(resolved), { recursive: true });

  let raw;
  try {
    raw = new DatabaseSync(resolved);
  } catch (error) {
    throw new Error(`无法打开健康数据库 ${resolved}：${error?.message ?? error}`);
  }

  const clock = () => {
    const value = Number(now());
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : Date.now();
  };

  // WAL is attempted on its own: an in-memory database settles on `memory`, and a
  // failure there must not stop the other pragmas from being applied.
  let journalMode = inMemory ? 'memory' : 'unknown';
  try {
    raw.exec('PRAGMA journal_mode = WAL');
    const row = raw.prepare('PRAGMA journal_mode').get();
    journalMode = String(row?.journal_mode ?? journalMode).toLowerCase();
  } catch {
    journalMode = inMemory ? 'memory' : 'unknown';
  }
  try {
    raw.exec('PRAGMA synchronous = NORMAL');
    raw.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    raw.exec('PRAGMA foreign_keys = ON');
  } catch {
    // A pragma this build does not support must never make the plugin unusable.
  }

  const statements = new Map();
  const prepared = sql => {
    let statement = statements.get(sql);
    if (!statement) {
      statement = raw.prepare(sql);
      statements.set(sql, statement);
    }
    return statement;
  };

  let depth = 0;
  let closed = false;

  const assertOpen = () => {
    if (closed) throw new Error('健康数据库已关闭。');
  };

  const run = (sql, params = []) => {
    assertOpen();
    return prepared(sql).run(...bindParams(params));
  };
  const all = (sql, params = []) => {
    assertOpen();
    return prepared(sql).all(...bindParams(params));
  };
  const get = (sql, params = []) => {
    assertOpen();
    const row = prepared(sql).get(...bindParams(params));
    return row === undefined ? null : row;
  };
  const exec = sql => {
    assertOpen();
    raw.exec(sql);
  };

  /**
   * BEGIN IMMEDIATE / COMMIT / ROLLBACK. Nested calls use SAVEPOINT so an inner
   * failure cannot leave half a batch behind while the outer block still commits.
   */
  const tx = fn => {
    if (typeof fn !== 'function') throw new Error('事务需要传入同步函数。');
    assertOpen();
    if (depth > 0) {
      const name = `sp_${depth}`;
      depth += 1;
      exec(`SAVEPOINT ${name}`);
      try {
        const value = fn();
        if (value && typeof value.then === 'function') throw new Error('事务回调必须是同步函数。');
        exec(`RELEASE ${name}`);
        return value;
      } catch (error) {
        try {
          exec(`ROLLBACK TO ${name}`);
          exec(`RELEASE ${name}`);
        } catch { /* the original error wins */ }
        throw error;
      } finally {
        depth -= 1;
      }
    }
    exec('BEGIN IMMEDIATE');
    depth = 1;
    try {
      const value = fn();
      if (value && typeof value.then === 'function') throw new Error('事务回调必须是同步函数。');
      exec('COMMIT');
      return value;
    } catch (error) {
      try {
        exec('ROLLBACK');
      } catch {
        // A failed ROLLBACK must not mask the original error.
      }
      throw error;
    } finally {
      depth = 0;
    }
  };

  const migrationSurface = { exec, run, get, all };

  // Opening a fresh database without a schema would make every later call fail at
  // a random spot, so `migrate()` runs once here and again on demand (idempotent).
  let initialMigration = { from: 0, to: 0, applied: [] };
  if (migrate) {
    initialMigration = tx(() => applyMigrations(migrationSurface));
  }

  const countRows = table => {
    try {
      return Number(get(`SELECT count(*) AS total FROM ${table}`)?.total ?? 0);
    } catch {
      // An unmigrated handle reports zeros instead of throwing during a health probe.
      return 0;
    }
  };

  const db = {
    file: resolved,
    inMemory,
    get journalMode() {
      return journalMode;
    },
    get schemaVersion() {
      try {
        return readUserVersion(migrationSurface);
      } catch {
        return 0;
      }
    },    /** Migration report from the open itself (empty `applied` when already current). */
    initialMigration,

    migrate() {
      return tx(() => applyMigrations(migrationSurface));
    },

    tx,
    run,
    all,
    get,
    exec,

    inTransaction() {
      return depth > 0;
    },

    stats() {
      assertOpen();
      const sizeBytes = inMemory ? 0 : fileBytes(resolved) + fileBytes(`${resolved}-wal`);
      return {
        observations: countRows('health_observations'),
        workouts: countRows('health_workout_sessions'),
        devices: countRows('health_devices'),
        dailySummaries: countRows('health_daily_summaries'),
        sleepSessions: countRows('health_sleep_sessions'),
        sleepStages: countRows('health_sleep_stages'),
        rawRefs: countRows('health_raw_refs'),
        syncRuns: countRows('health_sync_runs'),
        careCandidates: countRows('health_care_candidates'),
        sizeBytes,
      };
    },

    /**
     * `quick_check` is the b-tree/page validation (much cheaper than a full
     * `integrity_check`) and `foreign_key_check` proves the sleep-stage cascade
     * still points at real sessions.
     */
    integrity() {
      assertOpen();
      const messages = [];
      let quickCheck = false;
      try {
        const rows = raw.prepare('PRAGMA quick_check').all();
        const texts = rows.map(row => String(Object.values(row)[0] ?? ''));
        quickCheck = texts.length === 1 && texts[0].toLowerCase() === 'ok';
        if (!quickCheck) messages.push(...texts);
      } catch (error) {
        messages.push(String(error?.message ?? error));
      }
      let foreignKeyViolations = 0;
      try {
        const rows = raw.prepare('PRAGMA foreign_key_check').all();
        foreignKeyViolations = rows.length;
        for (const row of rows.slice(0, 20)) {
          messages.push(`fk ${String(row?.table ?? '')} rowid=${String(row?.rowid ?? '')}`);
        }
      } catch (error) {
        messages.push(String(error?.message ?? error));
      }
      return {
        ok: quickCheck && foreignKeyViolations === 0 && messages.length === 0,
        quickCheck,
        foreignKeyViolations,
        messages,
      };
    },

    /**
     * Consistent single-file copy. `VACUUM INTO` folds the WAL into the copy, so
     * the result is a reopenable database rather than a torn page image.
     */
    backupTo(destPath) {
      assertOpen();
      if (depth > 0) throw new Error('不能在事务中执行备份。');
      if (typeof destPath !== 'string' || !destPath.trim()) throw new Error('备份路径不能为空。');
      const target = path.resolve(destPath);
      if (!inMemory && target.toLowerCase() === resolved.toLowerCase()) {
        throw new Error('备份路径不能与当前数据库文件相同。');
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      // VACUUM INTO refuses an existing destination, so stale copies are unlinked.
      for (const suffix of ['', '-wal', '-shm']) {
        const candidate = target + suffix;
        if (fs.existsSync(candidate)) fs.rmSync(candidate, { force: true });
      }
      const escaped = target.replaceAll("'", "''");
      raw.exec(`VACUUM INTO '${escaped}'`);
      return { path: target, bytes: fileBytes(target), at: clock() };
    },

    /** Small key/value side table; used for first-sync / policy bookkeeping. */
    meta(key) {
      const row = get('SELECT value FROM health_meta WHERE key = ?', [String(key)]);
      return row ? String(row.value) : null;
    },

    setMeta(key, value) {
      const name = String(key ?? '').trim();
      if (!name) throw new Error('meta key 不能为空。');
      run(
        `INSERT INTO health_meta (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [name, String(value ?? ''), clock()],
      );
      return String(value ?? '');
    },

    close() {
      if (closed) return;
      closed = true;
      statements.clear();
      try {
        raw.close();
      } catch (error) {
        if (!/not open|already closed/i.test(String(error?.message ?? ''))) throw error;
      }
    },
  };

  return db;
}

export { BUSY_TIMEOUT_MS };
