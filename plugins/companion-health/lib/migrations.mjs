// Schema for the companion-health store (INTERFACES.md §4).
//
// One rule decides everything in this file: **the column names are a frozen
// contract**. The studio API, the foundation tools and scripts/check-health.mjs
// all read these tables by name, so renaming a column here is a silent breakage
// over there. Migrations are forward-only — never edit a version that already
// shipped, add a new one.
//
// This file deliberately touches no filesystem: `db.mjs` owns open/lifecycle, a
// migration only speaks SQL through the narrow surface it is handed
// (`exec` / `run` / `get` / `all`). That keeps it testable against a bare
// `:memory:` handle.

export const SCHEMA_VERSION = 3;

// `health_meta` is the only place free-form key/value state lives (first sync,
// last successful sync, policy version). Everything user-visible is a real column.
const V1_DDL = `
CREATE TABLE IF NOT EXISTS health_meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS health_sources (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,
  provider        TEXT NOT NULL,
  owner_scope     TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  auth_status     TEXT NOT NULL,
  last_success_at INTEGER,
  last_error_code TEXT,
  enabled         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS health_sync_runs (
  id              TEXT PRIMARY KEY,
  source_id       TEXT NOT NULL,
  started_at      INTEGER NOT NULL,
  finished_at     INTEGER,
  status          TEXT NOT NULL,
  items_seen      INTEGER NOT NULL DEFAULT 0,
  inserted        INTEGER NOT NULL DEFAULT 0,
  updated         INTEGER NOT NULL DEFAULT 0,
  skipped         INTEGER NOT NULL DEFAULT 0,
  next_allowed_at INTEGER,
  error_code      TEXT,
  detail_json     TEXT
);

-- One row per metric per day-granule, plus one row per realtime point sample.
-- observed_value_json holds {"hash": <sha256>, "value": {<flat fields>}}: the
-- hash drives idempotency (there is no content_hash column in the frozen schema)
-- and "value" carries the breakdown the read layer hands back verbatim.
CREATE TABLE IF NOT EXISTS health_observations (
  id                  TEXT PRIMARY KEY,
  source_id           TEXT NOT NULL,
  source_key          TEXT NOT NULL,
  kind                TEXT NOT NULL,
  granularity         TEXT NOT NULL,
  sample_at           INTEGER NOT NULL,
  value               REAL,
  unit                TEXT,
  observed_value_json TEXT NOT NULL,
  quality             TEXT NOT NULL,
  source_updated_at   INTEGER,
  fetched_at          INTEGER NOT NULL,
  raw_ref             TEXT,
  revision            INTEGER NOT NULL DEFAULT 1,
  UNIQUE(source_id, source_key, kind, sample_at, revision)
);

CREATE TABLE IF NOT EXISTS health_workout_sessions (
  id                 TEXT PRIMARY KEY,
  source_id          TEXT NOT NULL,
  source_record_key  TEXT NOT NULL,
  start_at           INTEGER NOT NULL,
  end_at             INTEGER NOT NULL,
  sport_type_raw     INTEGER NOT NULL,
  sport_type_label   TEXT,
  sport_type_mapping TEXT NOT NULL,
  duration_min       REAL,
  steps              INTEGER,
  distance_m         REAL,
  kcal               REAL,
  segments           INTEGER,
  device_code        TEXT,
  quality            TEXT NOT NULL,
  raw_ref            TEXT,
  fetched_at         INTEGER NOT NULL,
  revision           INTEGER NOT NULL DEFAULT 1,
  UNIQUE(source_id, source_record_key, revision)
);

CREATE TABLE IF NOT EXISTS health_devices (
  id                TEXT PRIMARY KEY,
  source_id         TEXT NOT NULL,
  device_code       TEXT,
  name              TEXT,
  device_class      TEXT NOT NULL,
  product_id        INTEGER,
  prod_id           TEXT,
  device_type_id    TEXT,
  unique_id_hash    TEXT,
  dev_id_hash       TEXT,
  status            INTEGER,
  priority          INTEGER,
  is_primary        INTEGER NOT NULL DEFAULT 0,
  source_updated_at INTEGER,
  raw_ref           TEXT,
  fetched_at        INTEGER NOT NULL,
  revision          INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS health_daily_summaries (
  owner_scope   TEXT NOT NULL,
  local_date    TEXT NOT NULL,
  timezone_id   TEXT NOT NULL,
  metric_kind   TEXT NOT NULL,
  summary_json  TEXT NOT NULL,
  origin_hash   TEXT NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (owner_scope, local_date, timezone_id, metric_kind)
);

-- start_at / end_at are NULLable on purpose: when the source only published an
-- aggregate duration, inventing midnight+duration would be a fabricated fact.
CREATE TABLE IF NOT EXISTS health_sleep_sessions (
  id                 TEXT PRIMARY KEY,
  canonical_group_id TEXT,
  source_id          TEXT NOT NULL,
  source_record_key  TEXT NOT NULL,
  start_at           INTEGER,
  end_at             INTEGER,
  sleep_date         TEXT NOT NULL,
  timezone_id        TEXT NOT NULL,
  asleep_minutes     REAL,
  awake_minutes      REAL,
  in_bed_minutes     REAL,
  deep_minutes       REAL,
  light_minutes      REAL,
  rem_minutes        REAL,
  stage_coverage     REAL,
  stage_fidelity     TEXT NOT NULL,
  session_quality    TEXT NOT NULL,
  status             TEXT NOT NULL,
  is_nap             INTEGER NOT NULL DEFAULT 0,
  source_score       REAL,
  source_score_label TEXT,
  raw_ref            TEXT,
  fetched_at         INTEGER NOT NULL,
  revision           INTEGER NOT NULL DEFAULT 1,
  UNIQUE(source_id, source_record_key, revision)
);

CREATE TABLE IF NOT EXISTS health_sleep_stages (
  session_id        TEXT NOT NULL,
  stage_index       INTEGER NOT NULL,
  stage             TEXT NOT NULL,
  start_at          INTEGER NOT NULL,
  end_at            INTEGER NOT NULL,
  source_stage_code TEXT,
  fidelity          TEXT NOT NULL,
  PRIMARY KEY (session_id, stage_index),
  FOREIGN KEY (session_id) REFERENCES health_sleep_sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS health_consents (
  capability      TEXT PRIMARY KEY,
  enabled         INTEGER NOT NULL,
  consent_version INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS health_care_candidates (
  id                  TEXT PRIMARY KEY,
  owner_scope         TEXT NOT NULL,
  pattern             TEXT NOT NULL,
  evidence_hash       TEXT NOT NULL,
  policy_version      TEXT NOT NULL,
  status              TEXT NOT NULL,
  reason              TEXT,
  created_at          INTEGER NOT NULL,
  expires_at          INTEGER NOT NULL,
  outbox_id           TEXT,
  platform_message_id TEXT,
  UNIQUE(owner_scope, pattern, evidence_hash, policy_version)
);

CREATE TABLE IF NOT EXISTS health_raw_refs (
  id           TEXT PRIMARY KEY,
  source_id    TEXT NOT NULL,
  kind         TEXT NOT NULL,
  hash         TEXT NOT NULL,
  fetched_at   INTEGER NOT NULL,
  bytes        INTEGER NOT NULL,
  redacted     INTEGER NOT NULL DEFAULT 1,
  payload_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_health_observations_source_at
  ON health_observations(source_id, sample_at);
CREATE INDEX IF NOT EXISTS idx_health_observations_kind_at
  ON health_observations(kind, sample_at);
CREATE INDEX IF NOT EXISTS idx_health_workout_sessions_start
  ON health_workout_sessions(start_at);
CREATE INDEX IF NOT EXISTS idx_health_sleep_sessions_date
  ON health_sleep_sessions(sleep_date);
CREATE INDEX IF NOT EXISTS idx_health_sleep_stages_session_start
  ON health_sleep_stages(session_id, start_at);
CREATE INDEX IF NOT EXISTS idx_health_sync_runs_started
  ON health_sync_runs(started_at);
CREATE INDEX IF NOT EXISTS idx_health_care_candidates_status
  ON health_care_candidates(status);
`;

/**
 * v2: live pulse sessions (`health.pulse.live`).
 *
 * Only derived statistics are persisted. The raw beat-to-beat series never reaches the database:
 * a pulse session is a memory of *how* it went (baseline, peak, when, how the zones split, what
 * the two of you marked), not a recording of the body. `marks_json` is a bounded array written by
 * `pulse.mjs`; `zone_counts_json` is `{calm,warming,racing,peak}`.
 */
const V2_DDL = `
CREATE TABLE IF NOT EXISTS health_pulse_sessions (
  id               TEXT PRIMARY KEY,
  owner_scope      TEXT NOT NULL,
  started_at       INTEGER NOT NULL,
  ended_at         INTEGER,
  stop_reason      TEXT,
  baseline_bpm     INTEGER,
  peak_bpm         INTEGER,
  peak_at          INTEGER,
  samples          INTEGER NOT NULL DEFAULT 0,
  zone_counts_json TEXT,
  marks_json       TEXT,
  device_label     TEXT
);

CREATE INDEX IF NOT EXISTS idx_health_pulse_sessions_started
  ON health_pulse_sessions(started_at);
CREATE INDEX IF NOT EXISTS idx_health_pulse_sessions_open
  ON health_pulse_sessions(owner_scope, ended_at);
`;

// v3：主动关怀的**投递台账**。它不存健康数据，只回答"这句话今天有没有说过"。
// 没有这张表，`health.care.proactive` 就只能在每次开会话时重复同一句"昨晚睡了 4h59m"，
// 那不叫关怀，叫噪音。主键就是去重键（kind + 那一夜），INSERT OR IGNORE 的 changes 就是"我抢到了"。
const V3_DDL = `
CREATE TABLE IF NOT EXISTS health_care_delivered (
  dedupe_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  sleep_date TEXT,
  channel TEXT NOT NULL,
  text TEXT NOT NULL,
  delivered_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_health_care_delivered_at
  ON health_care_delivered(delivered_at);
`;

export const MIGRATIONS = Object.freeze([
  Object.freeze({
    version: 1,
    description: 'initial schema (observations / workouts / devices / summaries / sleep / consents / raw refs)',
    up(db) {
      db.exec(V1_DDL);
    },
  }),
  Object.freeze({
    version: 2,
    description: 'live pulse sessions (derived statistics only, no raw series)',
    up(db) {
      db.exec(V2_DDL);
    },
  }),
  Object.freeze({
    version: 3,
    description: 'proactive care delivery ledger (once per night per kind)',
    up(db) {
      db.exec(V3_DDL);
    },
  }),
]);

/** `PRAGMA user_version` is the migration ledger; there is no bookkeeping table. */
export function readUserVersion(db) {
  const row = db.get('PRAGMA user_version');
  const value = Number(row?.user_version ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function writeUserVersion(db, version) {
  // PRAGMA does not accept bound parameters; the value is an integer built here.
  db.exec(`PRAGMA user_version = ${Math.trunc(version)}`);
}

/**
 * Walk the ledger up to `targetVersion`, running each step exactly once.
 *
 * Returns `{ from, to, applied }` where `applied` holds one human-readable line
 * per executed step, so `migrate()` on an up-to-date database reports an empty
 * list instead of pretending to have done work.
 *
 * A database written by a *newer* build is refused rather than downgraded: we
 * cannot know what columns a future version added, and silently operating on it
 * would corrupt rows we do not understand.
 */
export function applyMigrations(db, { targetVersion = SCHEMA_VERSION } = {}) {
  const from = readUserVersion(db);
  if (from > targetVersion) {
    throw new Error(
      `健康数据库版本 ${from} 高于本代码支持的 ${targetVersion}，已拒绝打开以免写坏数据。`,
    );
  }
  const applied = [];
  for (const migration of MIGRATIONS) {
    if (migration.version <= from) continue;
    if (migration.version > targetVersion) break;
    migration.up(db);
    writeUserVersion(db, migration.version);
    applied.push(`v${migration.version} ${migration.description}`);
  }
  return { from, to: readUserVersion(db), applied };
}
