/**
 * SQLite schema for the expression library (v1).
 *
 * The table shapes follow design document §8 verbatim, plus the tables production needs and the
 * document names in one sentence: `ingest_jobs`, `quotas`, `preferences`, `asset_revocations`,
 * `delete_audit` and `meta`.
 *
 * Two invariants are encoded here rather than in comments:
 *   - `assets.sha256` is UNIQUE: the same bytes are stored **once**, no matter how many sources
 *     supplied them.
 *   - `asset_sources` / `asset_visibility` are per-source rows: physical de-duplication never
 *     merges permissions. Revoking one source must not make another source's copy unusable, and
 *     adding a source must never widen another's visibility.
 *
 * Nothing in this file is a string built from user input; parameters are always bound.
 */

export const SCHEMA_VERSION = 1;

/**
 * Migration steps. Each entry runs inside one transaction and bumps `PRAGMA user_version`.
 * Step `n` is applied when `user_version < n`, so a fresh file and an upgraded file converge.
 */
export const MIGRATIONS = Object.freeze([
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS assets (
         id TEXT PRIMARY KEY,
         sha256 TEXT UNIQUE NOT NULL,
         phash TEXT,
         kind TEXT NOT NULL,
         mime TEXT NOT NULL,
         file_path TEXT NOT NULL,
         byte_size INTEGER,
         width INTEGER,
         height INTEGER,
         moderation_state TEXT NOT NULL,
         created_at INTEGER NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS assets_moderation ON assets(moderation_state)`,
      `CREATE INDEX IF NOT EXISTS assets_created ON assets(created_at)`,
      `CREATE TABLE IF NOT EXISTS asset_sources (
         id INTEGER PRIMARY KEY,
         asset_id TEXT NOT NULL,
         origin_scope TEXT NOT NULL,
         source_message_hash TEXT,
         sender_hash TEXT,
         consent_ref TEXT,
         first_seen INTEGER,
         last_seen INTEGER,
         UNIQUE(asset_id, origin_scope, source_message_hash)
       )`,
      `CREATE INDEX IF NOT EXISTS asset_sources_scope ON asset_sources(origin_scope)`,
      `CREATE TABLE IF NOT EXISTS asset_visibility (
         asset_id TEXT NOT NULL,
         scope TEXT NOT NULL,
         approval TEXT NOT NULL,
         PRIMARY KEY (asset_id, scope)
       )`,
      `CREATE TABLE IF NOT EXISTS expression_cards (
         asset_id TEXT PRIMARY KEY,
         literal TEXT,
         ocr TEXT,
         intents_json TEXT,
         emotions_json TEXT,
         tone_json TEXT,
         rhetoric_json TEXT,
         scenes_json TEXT,
         avoid_json TEXT,
         aggression REAL,
         confidence REAL,
         model_version TEXT,
         updated_at INTEGER
       )`,
      `CREATE VIRTUAL TABLE IF NOT EXISTS expression_fts USING fts5(
         asset_id UNINDEXED,
         literal,
         ocr,
         intents,
         scenes,
         tokenize='unicode61'
       )`,
      `CREATE TABLE IF NOT EXISTS deliveries (
         plan_id TEXT NOT NULL,
         part_index INTEGER NOT NULL,
         asset_id TEXT,
         scope TEXT NOT NULL,
         status TEXT NOT NULL,
         idempotency_key TEXT UNIQUE NOT NULL,
         provider_message_id TEXT,
         reason_code TEXT,
         at INTEGER NOT NULL,
         PRIMARY KEY (plan_id, part_index)
       )`,
      `CREATE INDEX IF NOT EXISTS deliveries_asset ON deliveries(asset_id, at)`,
      `CREATE INDEX IF NOT EXISTS deliveries_scope ON deliveries(scope, at)`,
      `CREATE TABLE IF NOT EXISTS expression_feedback (
         id TEXT PRIMARY KEY,
         asset_id TEXT,
         plan_id TEXT,
         scope TEXT NOT NULL,
         signal TEXT,
         confidence REAL,
         note TEXT,
         at INTEGER NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS expression_feedback_asset ON expression_feedback(asset_id, at)`,
      `CREATE TABLE IF NOT EXISTS ingest_jobs (
         id TEXT PRIMARY KEY,
         asset_id TEXT,
         source_key TEXT UNIQUE NOT NULL,
         state TEXT NOT NULL,
         attempts INTEGER NOT NULL DEFAULT 0,
         next_try_at INTEGER,
         last_error TEXT,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS ingest_jobs_state ON ingest_jobs(state, next_try_at)`,
      `CREATE TABLE IF NOT EXISTS quotas (
         bucket TEXT NOT NULL,
         slot TEXT NOT NULL,
         used INTEGER NOT NULL DEFAULT 0,
         PRIMARY KEY (bucket, slot)
       )`,
      `CREATE TABLE IF NOT EXISTS preferences (
         key TEXT PRIMARY KEY,
         value TEXT NOT NULL,
         updated_at INTEGER NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS asset_revocations (
         id INTEGER PRIMARY KEY,
         origin_scope TEXT NOT NULL,
         at INTEGER NOT NULL,
         reason TEXT
       )`,
      `CREATE TABLE IF NOT EXISTS delete_audit (
         id INTEGER PRIMARY KEY,
         asset_id TEXT,
         scope TEXT,
         at INTEGER NOT NULL,
         reason TEXT
       )`,
      `CREATE TABLE IF NOT EXISTS meta (
         key TEXT PRIMARY KEY,
         value TEXT NOT NULL
       )`,
    ],
  },
]);

/**
 * Apply pending migrations. Safe to call repeatedly (the health module's rule: an un-migrated
 * handle fails at a random spot later, so migrating at open time is the cheap option).
 *
 * @param {{exec: Function, get: Function, run: Function}} surface
 * @returns {{from: number, to: number, applied: number[]}}
 */
export function applyMigrations(surface) {
  const from = Number(readUserVersion(surface));
  const applied = [];
  for (const step of MIGRATIONS) {
    if (from >= step.version) continue;
    for (const statement of step.statements) surface.exec(statement);
    surface.exec(`PRAGMA user_version = ${Number(step.version)}`);
    applied.push(step.version);
  }
  return { from, to: Number(readUserVersion(surface)), applied };
}

export function readUserVersion(surface) {
  try {
    const row = surface.get('PRAGMA user_version');
    return Number(row?.user_version ?? 0);
  } catch {
    return 0;
  }
}

export default { SCHEMA_VERSION, MIGRATIONS, applyMigrations, readUserVersion };
