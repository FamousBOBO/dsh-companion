-- Companion memory schema v1 (SQLite, WAL, FTS5).
-- Owned by lib/db.mjs. Every statement here is idempotent so that opening an
-- existing database never reshapes or drops data.

-- Arbitrary but stable application id: guards against opening a foreign file.
PRAGMA application_id = 1297303373;

CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS identities (
  user_id TEXT PRIMARY KEY,
  platform TEXT NOT NULL DEFAULT '',
  platform_id TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS personas (
  persona_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  revision TEXT NOT NULL DEFAULT '',
  persona_ref TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_bindings (
  session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  persona_id TEXT NOT NULL,
  world_id TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL DEFAULT 'desktop',
  bound_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_bindings_owner ON session_bindings(user_id, persona_id);

-- Immutable evidence: one row per real message/tool action we captured.
CREATE TABLE IF NOT EXISTS source_events (
  source_id TEXT PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL DEFAULT '',
  seq INTEGER NOT NULL DEFAULT 0,
  role TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  user_id TEXT NOT NULL DEFAULT '',
  persona_id TEXT NOT NULL DEFAULT '',
  world_id TEXT NOT NULL DEFAULT '',
  search_text TEXT NOT NULL DEFAULT '',
  meta TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_source_events_owner ON source_events(user_id, persona_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_source_events_session ON source_events(session_id, seq);

-- Long lived facts, events, commitments and relationship notes.
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT 'user',
  predicate TEXT NOT NULL DEFAULT '',
  value TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  confidence REAL NOT NULL DEFAULT 0.5,
  importance REAL NOT NULL DEFAULT 0.5,
  mention_policy TEXT NOT NULL DEFAULT 'direct',
  status TEXT NOT NULL DEFAULT 'confirmed',
  reality_level TEXT NOT NULL DEFAULT 'imported_fact',
  user_id TEXT NOT NULL,
  persona_id TEXT NOT NULL,
  world_id TEXT NOT NULL DEFAULT '',
  source_kind TEXT NOT NULL DEFAULT 'manual',
  source_id TEXT NOT NULL DEFAULT '',
  dedupe_key TEXT NOT NULL,
  valid_from TEXT,
  valid_to TEXT,
  occurred_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  supersedes_id TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  search_text TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_dedupe ON memories(dedupe_key);
CREATE INDEX IF NOT EXISTS idx_memories_owner ON memories(user_id, persona_id, status, scope);
CREATE INDEX IF NOT EXISTS idx_memories_subject ON memories(user_id, persona_id, scope, subject, predicate);
CREATE INDEX IF NOT EXISTS idx_memories_validity ON memories(status, valid_to);
CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(user_id, updated_at);
-- v2：发生时间成为一等字段（展示、按时间取窗），单独建索引；迁移见 db.mjs MIGRATIONS。
CREATE INDEX IF NOT EXISTS idx_memories_occurred_at ON memories(occurred_at);

CREATE TABLE IF NOT EXISTS memory_evidence (
  memory_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  evidence_kind TEXT NOT NULL DEFAULT 'supports',
  confidence REAL NOT NULL DEFAULT 0.5,
  created_at TEXT NOT NULL,
  PRIMARY KEY (memory_id, source_id)
);
CREATE INDEX IF NOT EXISTS idx_memory_evidence_source ON memory_evidence(source_id);

CREATE TABLE IF NOT EXISTS memory_revisions (
  revision_id TEXT PRIMARY KEY,
  old_id TEXT NOT NULL DEFAULT '',
  new_id TEXT NOT NULL DEFAULT '',
  operation TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_revisions_new ON memory_revisions(new_id, created_at);

CREATE TABLE IF NOT EXISTS memory_embeddings (
  memory_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  vector BLOB NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  PRIMARY KEY (memory_id, provider, model)
);

CREATE TABLE IF NOT EXISTS memory_relations (
  relation_id TEXT PRIMARY KEY,
  source_ref TEXT NOT NULL,
  relation TEXT NOT NULL,
  target_ref TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'user_persona',
  evidence_source_id TEXT NOT NULL DEFAULT '',
  confidence REAL NOT NULL DEFAULT 0.5,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_relations_source ON memory_relations(source_ref, relation);

CREATE TABLE IF NOT EXISTS memory_jobs (
  job_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  stream_key TEXT NOT NULL DEFAULT '',
  cursor INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_jobs_state ON memory_jobs(state, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_memory_jobs_stream ON memory_jobs(type, stream_key);

CREATE TABLE IF NOT EXISTS wiki_pages (
  page_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  topic TEXT NOT NULL,
  path TEXT NOT NULL,
  source_revision INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'compiled',
  compiled_at TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT ''
);

-- Standalone FTS5 index over memories.search_text. Kept in sync by lib/db.mjs
-- (no triggers) so that a rebuild is a plain re-insert loop.
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  memory_id UNINDEXED,
  search_text,
  tokenize = 'unicode61 remove_diacritics 2'
);
