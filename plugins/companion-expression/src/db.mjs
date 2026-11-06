/**
 * The single SQLite handle for the expression library.
 *
 * Deliberately synchronous, exactly like `companion-health/lib/db.mjs`: the read API is called from
 * inside a chat turn or an HTTP GET handler, and an `await` boundary there buys nothing but lets
 * two callers interleave on one connection.
 *
 * Rules:
 *   1. Table shapes live in `schema.mjs`; this file only opens, configures, transacts and inspects.
 *   2. Nothing secret ever reaches a column: scopes and senders are stored as salted hashes
 *      (`scopes.mjs`), never as raw QQ numbers.
 *   3. `:memory:` is supported so tests never touch the real library file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { SCHEMA_VERSION, applyMigrations, readUserVersion } from './schema.mjs';

export { SCHEMA_VERSION };

const BUSY_TIMEOUT_MS = 5000;

/** `node:sqlite` rejects `undefined` and cannot bind booleans; both are normalised here. */
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
 * Open (and by default migrate) the expression database.
 *
 * @param {{file: string, now?: () => number, migrate?: boolean}} options
 */
export function openExpressionDb({ file, now = () => Date.now(), migrate = true } = {}) {
  if (typeof file !== 'string' || !file.trim()) throw new Error('表情包数据库路径不能为空。');
  const inMemory = file === ':memory:';
  const resolved = inMemory ? ':memory:' : path.resolve(file);
  if (!inMemory) fs.mkdirSync(path.dirname(resolved), { recursive: true });

  let raw;
  try {
    raw = new DatabaseSync(resolved);
  } catch (error) {
    throw new Error(`无法打开表情包数据库 ${resolved}：${error?.message ?? error}`);
  }

  const clock = () => {
    const value = Number(now());
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : Date.now();
  };

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
  } catch { /* an unsupported pragma must not make the module unusable */ }

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
    if (closed) throw new Error('表情包数据库已关闭。');
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

  /** BEGIN IMMEDIATE / COMMIT / ROLLBACK with SAVEPOINT nesting. */
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
      try { exec('ROLLBACK'); } catch { /* a failed rollback must not mask the error */ }
      throw error;
    } finally {
      depth = 0;
    }
  };

  const migrationSurface = { exec, run, get, all };
  let initialMigration = { from: 0, to: 0, applied: [] };
  if (migrate) initialMigration = tx(() => applyMigrations(migrationSurface));

  const countRows = table => {
    try {
      return Number(get(`SELECT count(*) AS total FROM ${table}`)?.total ?? 0);
    } catch {
      return 0;
    }
  };

  const db = {
    file: resolved,
    inMemory,
    get journalMode() { return journalMode; },
    get schemaVersion() {
      try { return readUserVersion(migrationSurface); } catch { return 0; }
    },
    initialMigration,
    migrate() { return tx(() => applyMigrations(migrationSurface)); },
    tx, run, all, get, exec,
    inTransaction() { return depth > 0; },
    clock,

    stats() {
      assertOpen();
      const sizeBytes = inMemory ? 0 : fileBytes(resolved) + fileBytes(`${resolved}-wal`);
      return {
        assets: countRows('assets'),
        sources: countRows('asset_sources'),
        cards: countRows('expression_cards'),
        deliveries: countRows('deliveries'),
        feedback: countRows('expression_feedback'),
        ingestJobs: countRows('ingest_jobs'),
        sizeBytes,
      };
    },

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
      return { ok: quickCheck && messages.length === 0, quickCheck, messages };
    },

    meta(key) {
      const row = get('SELECT value FROM meta WHERE key = ?', [String(key)]);
      return row ? String(row.value) : null;
    },

    setMeta(key, value) {
      const name = String(key ?? '').trim();
      if (!name) throw new Error('meta key 不能为空。');
      run(
        `INSERT INTO meta (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [name, String(value ?? '')],
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
export default { openExpressionDb, SCHEMA_VERSION, BUSY_TIMEOUT_MS };
