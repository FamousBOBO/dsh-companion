/**
 * SQLite helpers for the migration CLI.
 *
 * Everything here is read-only with respect to the *source* database:
 *   - `probeDatabase()` opens it with `{ readOnly: true }`;
 *   - `snapshotDatabase()` produces a standalone single-file copy next to the
 *     bundle, either through `VACUUM INTO` (consistent snapshot, preferred) or —
 *     if the runtime refuses that — by copying the database and its `-wal` /
 *     `-shm` siblings as one group.
 *
 * `node:sqlite` (`DatabaseSync`) is a Node >= 24 builtin. It does not exist on
 * Node 20 and needs `--experimental-sqlite` on Node 22, which is why the suite
 * declares `engines.node >= 24`. When it is unavailable this module reports a
 * clear reason instead of throwing, so `doctor` / `check` can explain the cause.
 */
import fs from 'node:fs';
import path from 'node:path';

let cachedModule;

/** Load `node:sqlite` once. Returns `{ DatabaseSync }` or `null`. */
export async function loadSqlite() {
  if (cachedModule !== undefined) return cachedModule;
  try {
    cachedModule = await import('node:sqlite');
  } catch {
    cachedModule = null;
  }
  return cachedModule;
}

export async function sqliteStatus() {
  const sqlite = await loadSqlite();
  return {
    available: Boolean(sqlite && typeof sqlite.DatabaseSync === 'function'),
    node: process.versions.node,
    reason: sqlite && typeof sqlite.DatabaseSync === 'function'
      ? ''
      : 'node:sqlite 不可用；本套件要求 Node >= 24（Node 20 没有 node:sqlite，Node 22 需要 --experimental-sqlite）。',
  };
}

/** SQLite string literals escape a quote by doubling it. */
function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function firstColumnValue(row) {
  if (!row || typeof row !== 'object') return undefined;
  const keys = Object.keys(row);
  return keys.length ? row[keys[0]] : undefined;
}

/**
 * Read-only health probe of one database.
 * @returns {Promise<{ok:boolean, reason?:string, quickCheck?:string, userVersion?:number, tables?:string[], bytes?:number}>}
 */
export async function probeDatabase(file) {
  const sqlite = await loadSqlite();
  const status = await sqliteStatus();
  if (!status.available) return { ok: false, reason: status.reason };
  if (!fs.existsSync(file)) return { ok: false, reason: `文件不存在：${file}` };

  let db;
  try {
    db = new sqlite.DatabaseSync(file, { readOnly: true });
  } catch (error) {
    return { ok: false, reason: `无法以只读方式打开：${error?.message ?? error}` };
  }

  try {
    const quick = db.prepare('PRAGMA quick_check').all().map(firstColumnValue).map(String);
    const userVersion = Number(firstColumnValue(db.prepare('PRAGMA user_version').get()) ?? 0);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => String(row.name));
    return {
      ok: quick.length > 0 && quick.every((value) => value.toLowerCase() === 'ok'),
      quickCheck: quick.join('; ') || '(empty)',
      userVersion,
      tables,
      bytes: fs.statSync(file).size,
    };
  } catch (error) {
    return { ok: false, reason: `读取校验失败：${error?.message ?? error}` };
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
}

/** Count rows in the first candidate table that exists. Never throws. */
export async function countRows(file, candidates = []) {
  const sqlite = await loadSqlite();
  if (!sqlite?.DatabaseSync) return null;
  let db;
  try {
    db = new sqlite.DatabaseSync(file, { readOnly: true });
    const tables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => String(row.name)),
    );
    for (const table of candidates) {
      if (!tables.has(table)) continue;
      const row = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get();
      return { table, rows: Number(firstColumnValue({ n: row?.n }) ?? row?.n ?? 0) };
    }
    return null;
  } catch {
    return null;
  } finally {
    if (db) { try { db.close(); } catch { /* ignore */ } }
  }
}

/** Copy `src` plus its `-wal` / `-shm` siblings as one group. */
function copyDatabaseGroup(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  let sidecars = 0;
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(src + suffix)) {
      fs.copyFileSync(src + suffix, dest + suffix);
      sidecars += 1;
    }
  }
  return { mode: 'file-copy', sidecars, bytes: fs.statSync(dest).size };
}

/**
 * Snapshot one database into the bundle directory.
 * @returns {Promise<{mode:string, bytes:number, sidecars?:number, warnings?:string[]}>}
 */
export async function snapshotDatabase(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) fs.rmSync(dest, { force: true });
  const warnings = [];
  const sqlite = await loadSqlite();

  if (sqlite?.DatabaseSync) {
    for (const readOnly of [true, false]) {
      let db;
      try {
        db = new sqlite.DatabaseSync(src, readOnly ? { readOnly: true } : undefined);
        db.exec(`VACUUM INTO ${sqlLiteral(dest)}`);
        if (fs.existsSync(dest)) {
          const bytes = fs.statSync(dest).size;
          return { mode: 'vacuum-into', bytes, warnings };
        }
        warnings.push('VACUUM INTO 未产出目标文件，回退为整组文件复制。');
      } catch (error) {
        warnings.push(`VACUUM INTO（${readOnly ? 'readOnly' : 'readWrite'}）失败：${error?.message ?? error}`);
      } finally {
        if (db) { try { db.close(); } catch { /* ignore */ } }
      }
    }
  } else {
    warnings.push((await sqliteStatus()).reason);
  }

  const copied = copyDatabaseGroup(src, dest);
  return { ...copied, warnings };
}

/** Find every text column named like a persona id, for the legacy-id rewrite. */
export async function personaColumns(file) {
  const sqlite = await loadSqlite();
  if (!sqlite?.DatabaseSync) return [];
  let db;
  try {
    db = new sqlite.DatabaseSync(file, { readOnly: true });
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => String(row.name));
    const found = [];
    for (const table of tables) {
      for (const column of db.prepare(`PRAGMA table_info("${table}")`).all()) {
        if (/^(persona|persona_id|personaId|persona$)/i.test(String(column.name))) {
          found.push({ table, column: String(column.name) });
        }
      }
    }
    return found;
  } catch {
    return [];
  } finally {
    if (db) { try { db.close(); } catch { /* ignore */ } }
  }
}

/**
 * Rewrite the legacy persona id inside an imported copy. The file must be the
 * *destination* copy — the source bundle is never modified.
 * @returns {Promise<{table:string, column:string, rows:number}[]>}
 */
export async function rewritePersonaId(file, from, to) {
  const sqlite = await loadSqlite();
  if (!sqlite?.DatabaseSync || !from || !to || from === to) return [];
  const columns = await personaColumns(file);
  if (!columns.length) return [];
  const changes = [];
  let db;
  try {
    db = new sqlite.DatabaseSync(file);
    db.exec('BEGIN IMMEDIATE');
    for (const { table, column } of columns) {
      const result = db
        .prepare(`UPDATE "${table}" SET "${column}" = ? WHERE "${column}" = ?`)
        .run(to, from);
      const rows = Number(result?.changes ?? 0);
      if (rows > 0) changes.push({ table, column, rows });
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db?.exec('ROLLBACK'); } catch { /* ignore */ }
    throw error;
  } finally {
    if (db) { try { db.close(); } catch { /* ignore */ } }
  }
  return changes;
}

/** Conservative "is somebody writing to this database right now" check. */
export function walLooksActive(dbPath, windowMs = 15_000) {
  const wal = `${dbPath}-wal`;
  try {
    const stat = fs.statSync(wal);
    if (stat.size === 0) return false;
    return Date.now() - stat.mtimeMs < windowMs;
  } catch {
    return false;
  }
}

export default {
  loadSqlite,
  sqliteStatus,
  probeDatabase,
  countRows,
  snapshotDatabase,
  personaColumns,
  rewritePersonaId,
  walLooksActive,
};
