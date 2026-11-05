import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  KINDS, MENTION_POLICIES, REALITY_LEVELS, SCOPES, SOURCE_KINDS, STATUSES,
  defaultImportance, defaultMentionPolicy,
} from './policy.mjs';
import {
  clamp, contentHash, isoNow, matchExpression, normalizeText, parseTime,
  redactSecrets, searchText, stableId, truncate,
} from './text.mjs';

// SQLite storage for the companion memory engine. Everything here is
// synchronous on purpose: the host injects memories inside a chat turn and an
// await boundary there buys nothing. `node:sqlite` is loaded dynamically so the
// plugin can still boot (degraded) on a Node build without it.
//
// Two rules keep this layer honest:
//   1. Table shapes live in schema.sql, with one documented exception: the
//      cross-database ingest receipt table is created by an idempotent, forward-only
//      DDL block below (CONTRACT.md §16.6), because schema.sql is frozen for this
//      work package. We execute schema.sql on open and never reshape existing tables.
//   2. Recall text is written by text.searchText() and queried by
//      text.matchExpression(). Anything else silently breaks Chinese recall.

export const SCHEMA_VERSION = 2;
export const APPLICATION_ID = 1297303373;

/**
 * 版本迁移（每次只前进一步，全部幂等）。
 *
 * v1 -> v2：给 memories.occurred_at 加索引。发生时间从 2026-10-28 起成为展示与
 * 过滤的一等字段；没有索引时按时间取窗会全表扫（当前 776 行无感，但先把机制建好）。
 * 只用 `CREATE INDEX IF NOT EXISTS`，不动任何行，失败可安全重跑。
 */
export const MIGRATIONS = Object.freeze([
  Object.freeze({
    version: 2,
    description: 'index memories(occurred_at)',
    apply(handle) {
      handle.exec('CREATE INDEX IF NOT EXISTS idx_memories_occurred_at ON memories(occurred_at)');
    },
  }),
]);

/** 把 handle 从 fromVersion 迁到 SCHEMA_VERSION；返回实际执行的版本号列表。 */
export function migrateSchema(handle, fromVersion) {
  const applied = [];
  for (const migration of MIGRATIONS) {
    if (migration.version <= fromVersion) continue;
    migration.apply(handle);
    applied.push(migration.version);
  }
  return applied;
}

/**
 * Cross-database ingest receipts (`engine.ingestDomainEvent`, CONTRACT.md §16).
 *
 * This table deliberately lives here instead of schema.sql: that file is a frozen
 * Lead-owned contract for this work package, and the main `SCHEMA_VERSION` chain is
 * covered by exact assertions in test/db.test.mjs (also out of scope). The DDL is
 * idempotent and forward-only, tracked under its own
 * `schema_meta.domainEventReceiptsVersion` key, so an existing v2 database picks the
 * table up on its next writable open without replaying the main migration chain.
 *
 * Documented compromise (CONTRACT.md §16.1 / §16.6): the main schema version stays
 * pinned at 2 even after the receipt table exists, because frozen tests assert that
 * exact value. The receipt channel therefore owns a real version of its own: it
 * reads the stored marker first, and a *newer* unknown receipt schema is left
 * exactly as it is — no DDL, no marker overwrite — and reports itself incompatible
 * so the ingest entry degrades to `retryable_failure` instead of writing a row into
 * a shape it does not understand (Codex review 2026-10-29, N1).
 */
export const DOMAIN_EVENT_RECEIPTS_VERSION = 1;
export const DOMAIN_EVENT_RECEIPTS_META_KEY = 'domainEventReceiptsVersion';
export const DOMAIN_EVENT_RECEIPT_STATUSES = Object.freeze(['accepted', 'pending', 'rejected']);

const DOMAIN_EVENT_RECEIPTS_DDL = `
CREATE TABLE IF NOT EXISTS domain_event_receipts (
  receipt_id        TEXT PRIMARY KEY,
  dedupe_key        TEXT NOT NULL UNIQUE,
  namespace         TEXT NOT NULL,
  scope             TEXT NOT NULL,
  event_id          TEXT NOT NULL,
  transform_version TEXT NOT NULL,
  status            TEXT NOT NULL,
  record_id         TEXT NOT NULL DEFAULT '',
  source_id         TEXT NOT NULL DEFAULT '',
  content_hash      TEXT NOT NULL DEFAULT '',
  reality_status    TEXT NOT NULL DEFAULT '',
  evidence_status   TEXT NOT NULL DEFAULT '',
  root_evidence     TEXT NOT NULL DEFAULT '[]',
  reason            TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_domain_event_receipts_tuple
  ON domain_event_receipts(namespace, scope, event_id, transform_version);
CREATE INDEX IF NOT EXISTS idx_domain_event_receipts_status
  ON domain_event_receipts(status, updated_at);
`;

/** Read the receipt-channel version marker; null when absent or unparsable. */
function readDomainEventReceiptsVersion(handle) {
  try {
    const row = handle
      .prepare('SELECT value FROM schema_meta WHERE key = ?')
      .get(DOMAIN_EVENT_RECEIPTS_META_KEY);
    if (!row) return null;
    const parsed = Number(row.value);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    // No schema_meta yet (bare handle) reads as "never initialised".
    return null;
  }
}

/**
 * Inspect the receipt channel without touching it. `compatible === false` means the
 * on-disk receipt schema is newer than this build understands; callers must neither
 * read nor write receipts then, and must never downgrade the marker.
 */
export function inspectDomainEventReceipts(handle) {
  const tableExists = userTables(handle).includes('domain_event_receipts');
  const storedVersion = readDomainEventReceiptsVersion(handle);
  const newer = storedVersion != null && storedVersion > DOMAIN_EVENT_RECEIPTS_VERSION;
  return {
    version: storedVersion,
    supportedVersion: DOMAIN_EVENT_RECEIPTS_VERSION,
    tableExists,
    compatible: !newer,
    newer,
  };
}

/**
 * Create (once) the ingest receipt table. Safe to call on every writable open and
 * from `putDomainEventReceipt` as a lazy fallback; never called on read-only handles.
 *
 * Returns the resulting state: `{ version, supportedVersion, tableExists, compatible,
 * newer, created, wrote }`. For a newer unknown receipt schema nothing is executed
 * and the stored marker is preserved (`compatible:false, wrote:false`).
 */
export function ensureDomainEventReceipts(handle) {
  const status = inspectDomainEventReceipts(handle);
  if (!status.compatible) return { ...status, created: false, wrote: false };
  handle.exec(DOMAIN_EVENT_RECEIPTS_DDL);
  handle
    .prepare(`INSERT INTO schema_meta (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(DOMAIN_EVENT_RECEIPTS_META_KEY, String(DOMAIN_EVENT_RECEIPTS_VERSION));
  return {
    ...status,
    version: DOMAIN_EVENT_RECEIPTS_VERSION,
    tableExists: true,
    created: !status.tableExists,
    wrote: true,
  };
}


const SCHEMA_URL = new URL('./schema.sql', import.meta.url);
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_JOB_ATTEMPTS = 5;
const MAX_ERROR_LENGTH = 2000;
const MAX_TAGS = 64;
const DEFAULT_LIST_LIMIT = 100;
const MAX_PAGE_SIZE = 1000;
// Keep IN (...) well under SQLite's 32766 host-parameter ceiling.
const EMBEDDING_ID_CHUNK = 500;
// A job still "running" after this long is assumed to be a crash leftover.
const STALE_RUNNING_MS = 15 * 60 * 1000;
// Open-time integrity policy: full check, quick structural check, or none.
const INTEGRITY_MODES = ['full', 'quick', 'skip'];

/** Normalise a stale-window argument; null/undefined falls back to 15 min. */
function staleWindow(value) {
  if (value == null) return STALE_RUNNING_MS;
  return Math.max(0, Number(value) || 0);
}

function normalizeIntegrityMode(value) {
  if (value == null || value === '') return 'full';
  const mode = String(value).toLowerCase();
  if (!INTEGRITY_MODES.includes(mode)) {
    throw new Error(`integrity 取值非法：${String(value)}；允许：${INTEGRITY_MODES.join('/')}`);
  }
  return mode;
}

let schemaCache = null;

/** schema.sql is read once per process; it is tiny and frozen. */
function readSchemaSql() {
  if (schemaCache == null) schemaCache = fs.readFileSync(SCHEMA_URL, 'utf8');
  return schemaCache;
}

let sqliteLoader = null;

/** Dynamic import so a missing node:sqlite is a caught error, never a crash. */
function loadSqlite() {
  if (sqliteLoader == null) {
    sqliteLoader = import('node:sqlite')
      .then(module => {
        if (!module || typeof module.DatabaseSync !== 'function') {
          throw new Error('node:sqlite 缺少 DatabaseSync 导出');
        }
        return module;
      })
      .catch(error => {
        sqliteLoader = null; // allow a later retry instead of caching the failure
        throw new Error(`当前运行时不支持 node:sqlite，记忆存储已降级：${error?.message ?? error}`);
      });
  }
  return sqliteLoader;
}

// --- small shared helpers ---------------------------------------------------

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

/** Objects and JSON strings both survive a round trip through a TEXT column. */
function encodeJsonObject(value, fallbackJson = '{}') {
  if (value == null) return fallbackJson;
  if (typeof value === 'string') {
    const parsed = parseJson(value, undefined);
    if (parsed === undefined) return JSON.stringify({ text: value });
    return JSON.stringify(parsed);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return fallbackJson;
  }
}

function normalizeTags(tags) {
  let list = tags;
  if (typeof list === 'string') list = parseJson(list, []);
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const result = [];
  for (const raw of list) {
    const tag = String(raw ?? '').trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    result.push(tag);
    if (result.length >= MAX_TAGS) break;
  }
  return result;
}

function decodeTags(value) {
  const parsed = parseJson(value, []);
  return Array.isArray(parsed) ? parsed.map(tag => String(tag)) : [];
}

const GENERIC_SUBJECTS = new Set(['user', 'persona', 'world', 'assistant', 'bot', '']);

/**
 * The one place a memory's FTS token string is produced. Insert, update and
 * rebuild must agree or recall silently drifts; generic subjects ('user',
 * 'persona') are dropped because they would match every row.
 */
function buildMemorySearchText({ value, content, subject, tags }) {
  const subjectTerm = GENERIC_SUBJECTS.has(normalizeText(subject)) ? '' : subject;
  return searchText(value, content, subjectTerm, (tags ?? []).join(' '));
}

function isoOrNull(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  return parseTime(value);
}

function randomHex(length) {
  return randomUUID().replaceAll('-', '').slice(0, length);
}

function asClock(value, fallback = Date.now()) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : fallback;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}不能为空。`);
  return value.trim();
}

function assertEnum(value, allowed, label) {
  if (!allowed.includes(value)) {
    throw new Error(`${label}取值非法：${String(value)}；允许：${allowed.join('/')}`);
  }
  return value;
}

/** SQLite reports both UNIQUE (2067) and PRIMARY KEY (1555) violations here. */
function isUniqueViolation(error) {
  const code = Number(error?.errcode);
  if (code === 2067 || code === 1555) return true;
  return /UNIQUE constraint failed|PRIMARY KEY constraint failed/i.test(String(error?.message ?? ''));
}

function bindParams(params) {
  return params.map(value => {
    if (value === undefined) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    return value;
  });
}

function pushInClause(clauses, params, column, value) {
  const list = (Array.isArray(value) ? value : [value])
    .filter(item => item != null && item !== '')
    .map(item => String(item));
  if (!list.length) return false;
  clauses.push(`${column} IN (${list.map(() => '?').join(', ')})`);
  params.push(...list);
  return true;
}

function encodeVector(vector) {
  if (vector instanceof Float32Array) {
    // Byte offset and length matter: a subarray shares the parent buffer.
    return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
  }
  if (Array.isArray(vector) || ArrayBuffer.isView(vector)) {
    const floats = Float32Array.from(vector);
    return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength);
  }
  throw new Error('向量必须是 Float32Array。');
}

/**
 * node:sqlite hands BLOBs back as Uint8Array views that may be misaligned and
 * may share a pooled buffer, so only a byteOffset % 4 === 0 view is used in
 * place; otherwise the bytes are copied into an aligned buffer first.
 */
function decodeVector(value, dimensions) {
  if (value == null) throw new Error('向量数据缺失。');
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  const expected = dimensions * 4;
  if (bytes.byteLength < expected) {
    throw new Error(`向量长度不足：需要 ${expected} 字节，实际 ${bytes.byteLength} 字节。`);
  }
  if (bytes.byteOffset % 4 === 0 && bytes.buffer.byteLength - bytes.byteOffset >= expected) {
    return new Float32Array(bytes.buffer, bytes.byteOffset, dimensions);
  }
  const aligned = new Uint8Array(expected);
  aligned.set(bytes.subarray(0, expected));
  return new Float32Array(aligned.buffer, 0, dimensions);
}

// --- row mappers (snake_case columns -> contract MemoryRecord) ---------------

function mapMemoryRow(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    scope: row.scope,
    kind: row.kind,
    subject: row.subject ?? 'user',
    predicate: row.predicate ?? '',
    value: row.value ?? '',
    content: row.content ?? '',
    confidence: Number(row.confidence ?? 0.5),
    importance: Number(row.importance ?? 0.5),
    mentionPolicy: row.mention_policy ?? 'direct',
    status: row.status ?? 'confirmed',
    realityLevel: row.reality_level ?? 'imported_fact',
    userId: row.user_id ?? '',
    personaId: row.persona_id ?? '',
    worldId: row.world_id ?? '',
    sourceKind: row.source_kind ?? 'manual',
    sourceId: row.source_id ?? '',
    dedupeKey: row.dedupe_key ?? '',
    validFrom: row.valid_from ?? null,
    validTo: row.valid_to ?? null,
    occurredAt: row.occurred_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: Number(row.revision ?? 1),
    supersedesId: row.supersedes_id ?? '',
    tags: decodeTags(row.tags),
    searchText: row.search_text ?? '',
  };
}

function mapEventRow(row) {
  if (!row) return null;
  return {
    sourceId: row.source_id,
    eventKey: row.event_key,
    sessionId: row.session_id ?? '',
    seq: Number(row.seq ?? 0),
    role: row.role,
    sourceKind: row.source_kind,
    occurredAt: row.occurred_at,
    content: row.content ?? '',
    contentHash: row.content_hash ?? '',
    userId: row.user_id ?? '',
    personaId: row.persona_id ?? '',
    worldId: row.world_id ?? '',
    searchText: row.search_text ?? '',
    meta: parseJson(row.meta, {}),
    createdAt: row.created_at,
  };
}

function mapJobRow(row) {
  if (!row) return null;
  return {
    jobId: row.job_id,
    type: row.type,
    streamKey: row.stream_key ?? '',
    cursor: Number(row.cursor ?? 0),
    state: row.state,
    attempts: Number(row.attempts ?? 0),
    nextRetryAt: row.next_retry_at ?? null,
    lastError: row.last_error ?? '',
    payload: parseJson(row.payload, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapWikiRow(row) {
  if (!row) return null;
  return {
    pageId: row.page_id,
    scope: row.scope,
    topic: row.topic,
    path: row.path,
    sourceRevision: Number(row.source_revision ?? 0),
    contentHash: row.content_hash ?? '',
    status: row.status ?? 'compiled',
    compiledAt: row.compiled_at ?? '',
    notes: row.notes ?? '',
  };
}

function mapRelationRow(row) {
  if (!row) return null;
  return {
    relationId: row.relation_id,
    sourceRef: row.source_ref,
    relation: row.relation,
    targetRef: row.target_ref,
    scope: row.scope ?? 'user_persona',
    evidenceSourceId: row.evidence_source_id ?? '',
    confidence: Number(row.confidence ?? 0.5),
    createdAt: row.created_at,
  };
}

function mapRevisionRow(row) {
  if (!row) return null;
  return {
    revisionId: row.revision_id,
    oldId: row.old_id ?? '',
    newId: row.new_id ?? '',
    operation: row.operation,
    reason: row.reason ?? '',
    actor: row.actor ?? 'system',
    createdAt: row.created_at,
  };
}

function mapReceiptRow(row) {
  if (!row) return null;
  return {
    receiptId: row.receipt_id,
    dedupeKey: row.dedupe_key,
    namespace: row.namespace,
    scope: row.scope,
    eventId: row.event_id,
    transformVersion: row.transform_version,
    status: row.status,
    recordId: row.record_id ?? '',
    sourceId: row.source_id ?? '',
    contentHash: row.content_hash ?? '',
    realityStatus: row.reality_status ?? '',
    evidenceStatus: row.evidence_status ?? '',
    rootEvidenceIds: parseJson(row.root_evidence, []),
    reason: row.reason ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// --- database handle -------------------------------------------------------

/** The (user, persona, world) triple a memory belongs to. */
function scopeOfRow(row) {
  return {
    userId: String(row?.user_id ?? ''),
    personaId: String(row?.persona_id ?? ''),
    worldId: String(row?.world_id ?? ''),
  };
}

function scopeSummary(scope) {
  const trim = value => String(value ?? '').slice(0, 40);
  return { userId: trim(scope?.userId), personaId: trim(scope?.personaId), worldId: trim(scope?.worldId) };
}

function sameScope(left, right) {
  return String(left?.userId ?? '') === String(right?.userId ?? '')
    && String(left?.personaId ?? '') === String(right?.personaId ?? '')
    && String(left?.worldId ?? '') === String(right?.worldId ?? '');
}

/**
 * Resolve the scope a supersede must stay inside.
 *
 * An explicit `scope` is used as given (that is the ingest caller's own scope); otherwise it is read
 * from the **new record** — a correction cannot legitimately cross a boundary its own replacement does
 * not cross.
 */
function normalizeSupersedeScope(scope, db, newId) {
  if (scope && typeof scope === 'object' && scope.userId) return scopeOfRow({
    user_id: scope.userId, persona_id: scope.personaId, world_id: scope.worldId,
  });
  const id = String(newId ?? '').trim();
  if (!id) return null;
  const row = db._get('SELECT user_id, persona_id, world_id FROM memories WHERE id = ?', [id]);
  return row ? scopeOfRow(row) : null;
}
export class MemoryDatabase {
  constructor(handle, {
    file, readOnly = false, journalMode = '', integrityMode = 'full', integrityCheckedAt = null,
    migrated = [], schemaOutdated = false,
  } = {}) {
    this.handle = handle;
    this.file = file;
    this.readOnly = Boolean(readOnly);
    this.journalMode = journalMode;
    // Observable trace of the open-time policy: 'full' | 'quick' | 'skip'.
    this.integrityMode = integrityMode;
    // ISO timestamp of the last successful check, or null when skipped.
    this.integrityCheckedAt = integrityCheckedAt;
    /** 本次打开实际执行的迁移版本号（可观测，便于日志与排障）。 */
    this.migrated = Array.isArray(migrated) ? [...migrated] : [];
    /** 只读打开旧库时不会迁移；调用方据此决定是否提示「需要一次可写启动」。 */
    this.schemaOutdated = Boolean(schemaOutdated);
    this._statements = new Map();
    this._depth = 0;
    this._closed = false;
    // Lazily flipped once the ingest receipt table exists on this handle.
    this._receiptsReady = false;
  }

  // -- lifecycle ------------------------------------------------------------

  _assertOpen() {
    if (this._closed) throw new Error('记忆数据库已关闭。');
  }

  _assertWritable() {
    this._assertOpen();
    if (this.readOnly) throw new Error('记忆数据库为只读模式，无法写入。');
  }

  _stmt(sql) {
    this._assertOpen();
    const cached = this._statements.get(sql);
    if (cached) return cached;
    const statement = this.handle.prepare(sql);
    this._statements.set(sql, statement);
    return statement;
  }

  _all(sql, params = []) {
    return this._stmt(sql).all(...bindParams(params));
  }

  _get(sql, params = []) {
    const row = this._stmt(sql).get(...bindParams(params));
    return row === undefined ? null : row;
  }

  _run(sql, params = []) {
    return this._stmt(sql).run(...bindParams(params));
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    this._statements.clear();
    try {
      this.handle.close();
    } catch (error) {
      // Closing twice is a no-op; anything else is a real failure.
      if (!/not open|already closed/i.test(String(error?.message ?? ''))) throw error;
    }
  }

  /**
   * BEGIN IMMEDIATE / COMMIT / ROLLBACK. Nested calls use a **SAVEPOINT**, so a failing inner batch
   * cannot leave partial writes behind even though the outer transaction later commits (round-4 B1).
   */
  transaction(fn) {
    if (typeof fn !== 'function') throw new Error('事务需要传入同步函数。');
    this._assertOpen();
    if (this._depth > 0) {
      // Round-4 B1: reusing the outer transaction made "all-or-nothing" a lie — an inner failure was
      // swallowed by the caller and the outer COMMIT persisted the partial batch. A savepoint makes
      // the inner batch really atomic *and* keeps the outer transaction usable.
      const name = `sp_${(this._savepointSeq = (this._savepointSeq ?? 0) + 1)}`;
      this.handle.exec(`SAVEPOINT ${name}`);
      this._depth += 1;
      try {
        const result = fn();
        if (result && typeof result.then === 'function') throw new Error('事务回调必须是同步函数。');
        this.handle.exec(`RELEASE ${name}`);
        return result;
      } catch (error) {
        try {
          this.handle.exec(`ROLLBACK TO ${name}`);
          this.handle.exec(`RELEASE ${name}`);
        } catch { /* the original error wins */ }
        throw error;
      } finally {
        this._depth -= 1;
      }
    }
    this._assertWritable();
    this.handle.exec('BEGIN IMMEDIATE');
    this._depth = 1;
    try {
      const result = fn();
      if (result && typeof result.then === 'function') throw new Error('事务回调必须是同步函数。');
      this.handle.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.handle.exec('ROLLBACK');
      } catch {
        // A failed ROLLBACK must not mask the original error.
      }
      throw error;
    } finally {
      this._depth = 0;
    }
  }

  /**
   * Run an integrity check on demand. `quick: true` asks SQLite for
   * `PRAGMA quick_check` (same b-tree/page validation, skips the slower
   * cross-index content verification); the result shape is identical.
   * A successful run also refreshes the observable integrityCheckedAt stamp.
   */
  integrityCheck({ quick = false } = {}) {
    this._assertOpen();
    const rows = this.handle.prepare(quick ? 'PRAGMA quick_check' : 'PRAGMA integrity_check').all();
    const messages = rows.map(row => String(Object.values(row)[0] ?? ''));
    const ok = messages.length === 1 && messages[0].toLowerCase() === 'ok';
    if (ok) this.integrityCheckedAt = isoNow();
    return { ok, messages: ok ? [] : messages };
  }

  /** Single-file copy via VACUUM INTO: WAL is merged, result is reopenable. */
  backup(target) {
    this._assertOpen();
    if (this._depth > 0) throw new Error('不能在事务中执行备份。');
    if (typeof target !== 'string' || !target.trim()) throw new Error('备份路径不能为空。');
    const resolved = path.resolve(target);
    if (this.file !== ':memory:' && resolved.toLowerCase() === this.file.toLowerCase()) {
      throw new Error('备份路径不能与当前数据库文件相同。');
    }
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    // VACUUM INTO refuses to overwrite, so stale copies are unlinked first.
    for (const suffix of ['', '-wal', '-shm']) {
      const candidate = resolved + suffix;
      if (fs.existsSync(candidate)) fs.rmSync(candidate, { force: true });
    }
    const escaped = resolved.replaceAll("'", "''");
    this.handle.exec(`VACUUM INTO '${escaped}'`);
    const stats = fs.statSync(resolved);
    return { path: resolved, bytes: stats.size };
  }

  meta(key) {
    this._assertOpen();
    const row = this._get('SELECT value FROM schema_meta WHERE key = ?', [String(key)]);
    return row ? String(row.value) : null;
  }

  setMeta(key, value) {
    this._assertWritable();
    const name = assertNonEmptyString(String(key), 'meta key ');
    this.transaction(() => {
      this._run(
        'INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        [name, String(value ?? '')],
      );
    });
    return String(value ?? '');
  }

  schemaVersion() {
    const raw = this.meta('schemaVersion');
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : SCHEMA_VERSION;
  }

  // -- identity and sessions ------------------------------------------------

  upsertIdentity({ userId, displayName, platform, platformId } = {}) {
    this._assertWritable();
    const id = assertNonEmptyString(userId, 'userId ');
    const name = assertNonEmptyString(String(displayName ?? ''), 'displayName ');
    const now = isoNow();
    this.transaction(() => {
      // Omitted optional fields keep whatever the row already had, so a
      // display-name refresh cannot silently drop the platform identity.
      const existing = this._get('SELECT * FROM identities WHERE user_id = ?', [id]);
      const platformValue = platform !== undefined ? String(platform ?? '') : String(existing?.platform ?? '');
      const platformIdValue = platformId !== undefined ? String(platformId ?? '') : String(existing?.platform_id ?? '');
      this._run(
        `INSERT INTO identities (user_id, platform, platform_id, display_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           platform = excluded.platform,
           platform_id = excluded.platform_id,
           display_name = excluded.display_name,
           updated_at = excluded.updated_at`,
        [id, platformValue, platformIdValue, name, now, now],
      );
    });
    return this._identityRow(id);
  }

  _identityRow(userId) {
    const row = this._get('SELECT * FROM identities WHERE user_id = ?', [userId]);
    if (!row) return null;
    return {
      userId: row.user_id,
      platform: row.platform ?? '',
      platformId: row.platform_id ?? '',
      displayName: row.display_name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  upsertPersona({ personaId, displayName, revision, personaRef } = {}) {
    this._assertWritable();
    const id = assertNonEmptyString(personaId, 'personaId ');
    const name = assertNonEmptyString(String(displayName ?? ''), 'displayName ');
    const now = isoNow();
    this.transaction(() => {
      const existing = this._get('SELECT * FROM personas WHERE persona_id = ?', [id]);
      const revisionValue = revision !== undefined ? String(revision ?? '') : String(existing?.revision ?? '');
      const refValue = personaRef !== undefined ? String(personaRef ?? '') : String(existing?.persona_ref ?? '');
      this._run(
        `INSERT INTO personas (persona_id, display_name, revision, persona_ref, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(persona_id) DO UPDATE SET
           display_name = excluded.display_name,
           revision = excluded.revision,
           persona_ref = excluded.persona_ref,
           updated_at = excluded.updated_at`,
        [id, name, revisionValue, refValue, now, now],
      );
    });
    const row = this._get('SELECT * FROM personas WHERE persona_id = ?', [id]);
    return {
      personaId: row.persona_id,
      displayName: row.display_name,
      revision: row.revision ?? '',
      personaRef: row.persona_ref ?? '',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  bindSession({ sessionId, userId, personaId, worldId = '', channel = 'desktop' } = {}) {
    this._assertWritable();
    const session = assertNonEmptyString(sessionId, 'sessionId ');
    const user = assertNonEmptyString(userId, 'userId ');
    const persona = assertNonEmptyString(personaId, 'personaId ');
    const now = isoNow();
    this.transaction(() => {
      this._run(
        `INSERT INTO session_bindings (session_id, user_id, persona_id, world_id, channel, bound_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           user_id = excluded.user_id,
           persona_id = excluded.persona_id,
           world_id = excluded.world_id,
           channel = excluded.channel,
           last_seen_at = excluded.last_seen_at`,
        [session, user, persona, String(worldId ?? ''), String(channel ?? 'desktop'), now, now],
      );
    });
    return this.sessionBinding(session);
  }

  sessionBinding(sessionId) {
    this._assertOpen();
    const row = this._get('SELECT * FROM session_bindings WHERE session_id = ?', [String(sessionId ?? '')]);
    if (!row) return null;
    return {
      sessionId: row.session_id,
      userId: row.user_id,
      personaId: row.persona_id,
      worldId: row.world_id ?? '',
      channel: row.channel ?? 'desktop',
      boundAt: row.bound_at,
      lastSeenAt: row.last_seen_at,
    };
  }

  /** True when this user id is registered locally; used to reject unbound subjects. */
  identityExists(userId) {
    this._assertOpen();
    const id = typeof userId === 'string' ? userId.trim() : '';
    if (!id) return false;
    return Boolean(this._get('SELECT 1 AS ok FROM identities WHERE user_id = ?', [id]));
  }

  // -- evidence events ------------------------------------------------------

  /**
   * Immutable evidence row. Repeated capture of the same event key is a no-op
   * and never rewrites the stored text; {inserted:false} is the answer.
   */
  appendEvent(input = {}) {
    this._assertWritable();
    const eventKey = assertNonEmptyString(input.eventKey, '事件 eventKey ');
    const role = assertNonEmptyString(input.role, '事件 role ');
    const sourceKind = assertEnum(input.sourceKind ?? 'desktop_conversation', SOURCE_KINDS, '事件 sourceKind ');
    const content = String(input.content ?? '');
    const occurredAt = isoOrNull(input.occurredAt) ?? isoNow();
    const sourceId = typeof input.sourceId === 'string' && input.sourceId.trim()
      ? input.sourceId.trim()
      : stableId('evt', eventKey);
    const row = {
      sourceId,
      eventKey,
      sessionId: String(input.sessionId ?? ''),
      seq: clampInt(input.seq, 0, Number.MAX_SAFE_INTEGER, 0),
      role,
      sourceKind,
      occurredAt,
      content,
      contentHash: contentHash(content),
      userId: String(input.userId ?? ''),
      personaId: String(input.personaId ?? ''),
      worldId: String(input.worldId ?? ''),
      searchText: searchText(content),
      meta: encodeJsonObject(input.meta),
      createdAt: isoNow(),
    };
    return this.transaction(() => {
      try {
        this._run(
          `INSERT INTO source_events
             (source_id, event_key, session_id, seq, role, source_kind, occurred_at, content,
              content_hash, user_id, persona_id, world_id, search_text, meta, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [row.sourceId, row.eventKey, row.sessionId, row.seq, row.role, row.sourceKind,
            row.occurredAt, row.content, row.contentHash, row.userId, row.personaId, row.worldId,
            row.searchText, row.meta, row.createdAt],
        );
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        const existing = this._get(
          'SELECT source_id FROM source_events WHERE event_key = ? OR source_id = ? LIMIT 1',
          [row.eventKey, row.sourceId],
        );
        if (!existing) throw error;
        return { inserted: false, sourceId: String(existing.source_id) };
      }
      return { inserted: true, sourceId: row.sourceId };
    });
  }

  getEvent(sourceId) {
    this._assertOpen();
    return mapEventRow(this._get('SELECT * FROM source_events WHERE source_id = ?', [String(sourceId ?? '')]));
  }

  /**
   * Evidence lookup by exact event key. The cross-database ingest entry uses this to
   * prove that an existing evidence row belongs to the same subject and text before
   * reusing it (CONTRACT.md §16.1, Codex review B1).
   */
  getEventByKey(eventKey) {
    this._assertOpen();
    const key = typeof eventKey === 'string' ? eventKey.trim() : '';
    if (!key) return null;
    return mapEventRow(this._get('SELECT * FROM source_events WHERE event_key = ?', [key]));
  }

  eventsForSession(sessionId, { limit = 50, afterSeq = 0 } = {}) {
    this._assertOpen();
    const rows = this._all(
      `SELECT * FROM source_events
        WHERE session_id = ? AND seq > ?
        ORDER BY seq ASC, occurred_at ASC, created_at ASC
        LIMIT ?`,
      [String(sessionId ?? ''), clampInt(afterSeq, 0, Number.MAX_SAFE_INTEGER, 0),
        clampInt(limit, 1, MAX_PAGE_SIZE, 50)],
    );
    return rows.map(mapEventRow);
  }

  eventsSince({ userId, personaId, afterOccurredAt = '', limit = 200 } = {}) {
    this._assertOpen();
    const user = assertNonEmptyString(userId, 'userId ');
    const persona = assertNonEmptyString(personaId, 'personaId ');
    const cutoff = isoOrNull(afterOccurredAt) ?? '';
    const rows = this._all(
      `SELECT * FROM source_events
        WHERE user_id = ? AND persona_id = ? AND occurred_at > ?
        ORDER BY occurred_at ASC, created_at ASC
        LIMIT ?`,
      [user, persona, cutoff, clampInt(limit, 1, MAX_PAGE_SIZE, 200)],
    );
    return rows.map(mapEventRow);
  }

  /**
   * 按「发生时间倒序」（最新在前）读取证据事件，供管理界面的时间线使用。
   * `eventsSince` 保持游标正序语义不变（后台建批依赖它）；`beforeOccurredAt`
   * 是做「加载更多」用的键集游标，取严格更早的行。
   */
  recentEvents({ userId, personaId, beforeOccurredAt = '', limit = 200 } = {}) {
    this._assertOpen();
    const user = assertNonEmptyString(userId, 'userId ');
    const persona = assertNonEmptyString(personaId, 'personaId ');
    const cutoff = isoOrNull(beforeOccurredAt);
    const size = clampInt(limit, 1, MAX_PAGE_SIZE, 200);
    const rows = cutoff
      ? this._all(
        `SELECT * FROM source_events
          WHERE user_id = ? AND persona_id = ? AND occurred_at < ?
          ORDER BY occurred_at DESC, created_at DESC, source_id ASC
          LIMIT ?`,
        [user, persona, cutoff, size],
      )
      : this._all(
        `SELECT * FROM source_events
          WHERE user_id = ? AND persona_id = ?
          ORDER BY occurred_at DESC, created_at DESC, source_id ASC
          LIMIT ?`,
        [user, persona, size],
      );
    return rows.map(mapEventRow);
  }

  // -- memories -------------------------------------------------------------

  /**
   * Turn a loose caller draft into a fully specified record: policy defaults,
   * deterministic ids and the FTS token string all get filled in here.
   */
  _normalizeMemoryInput(input = {}) {
    const scope = assertEnum(input.scope, SCOPES, '记忆 scope ');
    const kind = assertEnum(input.kind, KINDS, '记忆 kind ');
    const value = assertNonEmptyString(String(input.value ?? ''), '记忆 value ');
    const userId = assertNonEmptyString(input.userId, '记忆 userId ');
    const personaId = assertNonEmptyString(input.personaId, '记忆 personaId ');
    const subject = String(input.subject ?? 'user');
    const predicate = String(input.predicate ?? '');
    const worldId = String(input.worldId ?? '');
    const realityLevel = assertEnum(input.realityLevel ?? 'imported_fact', REALITY_LEVELS, '记忆 realityLevel ');
    const status = assertEnum(input.status ?? 'confirmed', STATUSES, '记忆 status ');
    const sourceKind = assertEnum(input.sourceKind ?? 'manual', SOURCE_KINDS, '记忆 sourceKind ');
    const mentionPolicy = assertEnum(
      input.mentionPolicy ?? defaultMentionPolicy({ kind, realityLevel, scope }),
      MENTION_POLICIES,
      '记忆 mentionPolicy ',
    );
    const importance = clamp(input.importance ?? defaultImportance(kind), 0, 1);
    const confidence = clamp(input.confidence ?? 0.5, 0, 1);
    const content = String(input.content ?? '');
    const tags = normalizeTags(input.tags);
    const occurredAt = isoOrNull(input.occurredAt);
    const validFrom = isoOrNull(input.validFrom);
    const validTo = isoOrNull(input.validTo);
    const createdAt = isoOrNull(input.createdAt) ?? isoNow();
    const updatedAt = isoOrNull(input.updatedAt) ?? createdAt;

    // Events repeat legitimately, so their timestamp is part of the identity.
    const timeScoped = kind === 'event' || kind === 'bot_action' || kind === 'artifact'
      || scope === 'session_recent';
    const dedupeMaterial = [userId, personaId, worldId, scope, subject, predicate, normalizeText(value)];
    if (timeScoped) dedupeMaterial.push(occurredAt ?? '');
    const dedupeKey = typeof input.dedupeKey === 'string' && input.dedupeKey.trim()
      ? input.dedupeKey.trim()
      : stableId('dedupe', ...dedupeMaterial);
    const id = typeof input.id === 'string' && input.id.trim()
      ? input.id.trim()
      : stableId('mem', dedupeKey);

    // Generic subjects ('user', 'persona', ...) are noise in the index; a
    // concrete subject name is signal, so only then is it indexed.
    const searchTextValue = typeof input.searchText === 'string' && input.searchText.trim()
      ? input.searchText.trim()
      : buildMemorySearchText({ value, content, subject, tags });

    return {
      id,
      scope,
      kind,
      subject,
      predicate,
      value,
      content,
      confidence,
      importance,
      mentionPolicy,
      status,
      realityLevel,
      userId,
      personaId,
      worldId,
      sourceKind,
      sourceId: String(input.sourceId ?? ''),
      dedupeKey,
      validFrom,
      validTo,
      occurredAt,
      createdAt,
      updatedAt,
      revision: clampInt(input.revision, 1, Number.MAX_SAFE_INTEGER, 1),
      supersedesId: String(input.supersedesId ?? ''),
      tags,
      searchText: searchTextValue,
    };
  }

  _insertMemoryRow(record) {
    try {
      this._run(
        `INSERT INTO memories
           (id, scope, kind, subject, predicate, value, content, confidence, importance,
            mention_policy, status, reality_level, user_id, persona_id, world_id, source_kind,
            source_id, dedupe_key, valid_from, valid_to, occurred_at, created_at, updated_at,
            revision, supersedes_id, tags, search_text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [record.id, record.scope, record.kind, record.subject, record.predicate, record.value,
          record.content, record.confidence, record.importance, record.mentionPolicy, record.status,
          record.realityLevel, record.userId, record.personaId, record.worldId, record.sourceKind,
          record.sourceId, record.dedupeKey, record.validFrom, record.validTo, record.occurredAt,
          record.createdAt, record.updatedAt, record.revision, record.supersedesId,
          JSON.stringify(record.tags), record.searchText],
      );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = this._get(
        'SELECT * FROM memories WHERE dedupe_key = ? OR id = ? LIMIT 1',
        [record.dedupeKey, record.id],
      );
      if (!existing) throw error;
      return { record: mapMemoryRow(existing), inserted: false };
    }
    this._syncSearchRow(record.id, record.searchText);
    return { record: this._rowById(record.id), inserted: true };
  }

  _rowById(id) {
    return mapMemoryRow(this._get('SELECT * FROM memories WHERE id = ?', [String(id)]));
  }

  /** FTS5 rows are maintained by hand (no triggers) so rebuild is a re-insert. */
  _syncSearchRow(id, searchTextValue) {
    this._run('DELETE FROM memory_fts WHERE memory_id = ?', [id]);
    this._run('INSERT INTO memory_fts (memory_id, search_text) VALUES (?, ?)', [id, String(searchTextValue ?? '')]);
  }

  insertMemory(input = {}) {
    this._assertWritable();
    const record = this._normalizeMemoryInput(input);
    return this.transaction(() => this._insertMemoryRow(record));
  }

  /**
   * Patch the mutable fields, bump revision, refresh FTS text and write an
   * audit row into memory_revisions. Indexed fields (value/content/predicate/
   * tags) force a re-tokenise; a pure status change leaves FTS untouched.
   *
   * CONTRACT §15: a patch that changes nothing stored must not bump revision,
   * refresh updated_at, touch the FTS row or append a revision record. Every
   * requested column is therefore compared in its stored normalised form
   * before the write.
   */
  _applyUpdate(id, patch, { reason = '', actor = 'system', operation = 'update', missing = 'error' } = {}) {
    const row = this._get('SELECT * FROM memories WHERE id = ?', [id]);
    if (!row) {
      if (missing === 'null') return null;
      throw new Error(`记忆不存在：${id}`);
    }
    const current = mapMemoryRow(row);
    const changes = {};
    if (patch.value !== undefined) changes.value = assertNonEmptyString(String(patch.value ?? ''), '记忆 value ');
    if (patch.content !== undefined) changes.content = String(patch.content ?? '');
    if (patch.confidence !== undefined) changes.confidence = clamp(patch.confidence, 0, 1);
    if (patch.importance !== undefined) changes.importance = clamp(patch.importance, 0, 1);
    if (patch.mentionPolicy !== undefined) {
      changes.mention_policy = assertEnum(patch.mentionPolicy, MENTION_POLICIES, '记忆 mentionPolicy ');
    }
    if (patch.status !== undefined) changes.status = assertEnum(patch.status, STATUSES, '记忆 status ');
    if (patch.validTo !== undefined) changes.valid_to = isoOrNull(patch.validTo);
    if (patch.validFrom !== undefined) changes.valid_from = isoOrNull(patch.validFrom);
    if (patch.predicate !== undefined) changes.predicate = String(patch.predicate ?? '');
    if (patch.tags !== undefined) changes.tags = JSON.stringify(normalizeTags(patch.tags));

    const dropIfSame = (column, currentValue) => {
      if (column in changes && changes[column] === currentValue) delete changes[column];
    };
    dropIfSame('value', current.value);
    dropIfSame('content', current.content);
    dropIfSame('confidence', current.confidence);
    dropIfSame('importance', current.importance);
    dropIfSame('mention_policy', current.mentionPolicy);
    dropIfSame('status', current.status);
    dropIfSame('predicate', current.predicate);
    dropIfSame('valid_to', current.validTo);
    dropIfSame('valid_from', current.validFrom);
    dropIfSame('tags', JSON.stringify(current.tags));

    if (Object.keys(changes).length === 0) return current;

    const indexedChanged = 'value' in changes || 'content' in changes
      || 'predicate' in changes || 'tags' in changes;
    if (indexedChanged) {
      const tags = changes.tags !== undefined ? JSON.parse(changes.tags) : current.tags;
      changes.search_text = buildMemorySearchText({
        value: changes.value ?? current.value,
        content: changes.content ?? current.content,
        subject: current.subject,
        tags,
      });
    }
    // A stored vector describes the old text; retire it so the semantic
    // channel cannot keep matching a sentence the memory no longer says.
    // pendingEmbeddings() then hands the row back to the embedder.
    const invalidateEmbedding = 'value' in changes || 'content' in changes || 'predicate' in changes;

    const assignments = [];
    const params = [];
    for (const [column, value] of Object.entries(changes)) {
      assignments.push(`${column} = ?`);
      params.push(value);
    }
    assignments.push('revision = revision + 1');
    const now = isoNow();
    assignments.push('updated_at = ?');
    params.push(now);
    params.push(id);
    this._run(`UPDATE memories SET ${assignments.join(', ')} WHERE id = ?`, params);

    if (changes.search_text !== undefined) this._syncSearchRow(id, changes.search_text);
    if (invalidateEmbedding) this._run('DELETE FROM memory_embeddings WHERE memory_id = ?', [id]);
    this.recordRevision({ oldId: id, newId: id, operation, reason, actor });
    return this._rowById(id);
  }

  updateMemory(id, patch = {}, { reason = '', actor = 'system' } = {}) {
    this._assertWritable();
    assertNonEmptyString(String(id), '记忆 id ');
    return this.transaction(() => this._applyUpdate(
      String(id),
      patch ?? {},
      { reason, actor, operation: 'update' },
    ));
  }

  getMemory(id) {
    this._assertOpen();
    if (typeof id !== 'string' || !id) return null;
    return this._rowById(id);
  }

  findDuplicates({ userId, personaId, worldId = '', scope, subject, predicate, value } = {}) {
    this._assertOpen();
    const clauses = ['user_id = ?', 'persona_id = ?'];
    const params = [assertNonEmptyString(userId, 'userId '), assertNonEmptyString(personaId, 'personaId ')];
    if (worldId !== undefined && worldId !== null) {
      clauses.push('world_id = ?');
      params.push(String(worldId));
    }
    if (scope) {
      clauses.push('scope = ?');
      params.push(String(scope));
    }
    if (subject !== undefined && subject !== null) {
      clauses.push('subject = ?');
      params.push(String(subject));
    }
    if (predicate !== undefined && predicate !== null) {
      clauses.push('predicate = ?');
      params.push(String(predicate));
    }
    const rows = this._all(
      `SELECT * FROM memories WHERE ${clauses.join(' AND ')} ORDER BY created_at ASC, id ASC`,
      params,
    ).map(mapMemoryRow);
    if (value == null) return rows;
    const needle = normalizeText(value);
    return rows.filter(record => normalizeText(record.value) === needle);
  }

  _memoryFilter(filter = {}) {
    const clauses = ['user_id = ?', 'persona_id = ?'];
    const params = [
      assertNonEmptyString(filter.userId, 'userId '),
      assertNonEmptyString(filter.personaId, 'personaId '),
    ];
    const worldId = filter.worldId;
    if (worldId !== undefined && worldId !== null) {
      if (String(worldId) === '') {
        clauses.push('world_id = ?');
        params.push('');
      } else {
        // Reality rows (world_id '') stay visible inside any world; fiction
        // rows only inside their own world.
        clauses.push('(world_id = ? OR world_id = ?)');
        params.push(String(worldId), '');
      }
    }
    pushInClause(clauses, params, 'scope', filter.scope);
    pushInClause(clauses, params, 'kind', filter.kind);
    pushInClause(clauses, params, 'status', filter.status);
    if (filter.subject !== undefined && filter.subject !== null) {
      clauses.push('subject = ?');
      params.push(String(filter.subject));
    }
    if (filter.predicate !== undefined && filter.predicate !== null) {
      clauses.push('predicate = ?');
      params.push(String(filter.predicate));
    }
    if (!filter.includeExpired) {
      clauses.push('(valid_to IS NULL OR valid_to > ?)');
      params.push(isoNow());
    }
    return { clause: `WHERE ${clauses.join(' AND ')}`, params };
  }

  listMemories(filter = {}) {
    this._assertOpen();
    const { clause, params } = this._memoryFilter(filter);
    const limit = clampInt(filter.limit, 1, MAX_PAGE_SIZE, DEFAULT_LIST_LIMIT);
    const offset = clampInt(filter.offset, 0, Number.MAX_SAFE_INTEGER, 0);
    const rows = this._all(
      `SELECT * FROM memories ${clause} ORDER BY importance DESC, updated_at DESC, id ASC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    return rows.map(mapMemoryRow);
  }

  countMemories(filter = {}) {
    this._assertOpen();
    const { clause, params } = this._memoryFilter(filter);
    const row = this._get(`SELECT count(*) AS total FROM memories ${clause}`, params);
    return Number(row?.total ?? 0);
  }

  /**
   * 按「最近更新」倒序（最新在前）分页读取记忆，供管理界面使用。
   * `listMemories` 保持重要度优先的既有语义不变，避免影响召回与既有调用；
   * 这里只是同一个过滤器的另一种排序，同样只读。
   */
  listMemoriesByTime(filter = {}) {
    this._assertOpen();
    const { clause, params } = this._memoryFilter(filter);
    const limit = clampInt(filter.limit, 1, MAX_PAGE_SIZE, DEFAULT_LIST_LIMIT);
    const offset = clampInt(filter.offset, 0, Number.MAX_SAFE_INTEGER, 0);
    const rows = this._all(
      `SELECT * FROM memories ${clause} ORDER BY updated_at DESC, id ASC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    return rows.map(mapMemoryRow);
  }

  setStatus(id, status, { reason = '', actor = 'system' } = {}) {
    this._assertWritable();
    const nextStatus = assertEnum(status, STATUSES, '记忆 status ');
    return this.transaction(() => {
      const row = this._get('SELECT status FROM memories WHERE id = ?', [String(id)]);
      if (!row) throw new Error(`记忆不存在：${id}`);
      const patch = { status: nextStatus };
      // Leaving the active set closes the validity window. Repeating the same
      // status must stay a no-op (§15) rather than rewriting valid_to.
      if (row.status !== nextStatus && (nextStatus === 'superseded' || nextStatus === 'retracted')) {
        patch.validTo = isoNow();
      }
      return this._applyUpdate(String(id), patch, { reason, actor, operation: 'status' });
    });
  }

  /**
   * companion_remember entry point. Stable predicates form a single-valued
   * chain (old row superseded, new row links back); `multi:` predicates keep
   * every distinct value and only dedupe exact repeats.
   */
  /**
   * Mark one memory as superseded by another. **One implementation** for every supersede path
   * (explicit `remember` corrections and inbound correction requests alike), so the two can never
   * drift.
   *
   * Zero migration: it reuses the existing `status = 'superseded'` value, the existing `valid_to`
   * column and the existing revision log (`recordRevision`), which is what the recall layers already
   * filter on (`status = 'confirmed'`) — so a superseded fact disappears from keyword, FTS and
   * embedding recall without touching any query.
   *
   * Idempotent: a row that is already superseded is left alone (and reported as such), so a
   * correction delivered twice supersedes once.
   */

  supersedeMemory({ oldId, newId, reason = '', actor = 'system', at = null, scope = null } = {}) {
    this._assertWritable();
    const old = this._get('SELECT id, status, user_id, persona_id, world_id FROM memories WHERE id = ?', [String(oldId ?? '')]);
    if (!old) return { ok: false, code: 'not-found', oldId: String(oldId ?? '') };
    // round-3 B5 (the dangerous one): this used to update **by id alone**. The public ingest path can
    // be reached without the runtime's candidate check, so "supersede this id" from another
    // user/persona/world would erase a memory that person never agreed to change. The scope is now
    // part of the decision, not a comment.
    const target = scopeOfRow(old);
    const wanted = normalizeSupersedeScope(scope, this, newId);
    if (!wanted) return { ok: false, code: 'new-record-not-found', oldId: old.id, newId: String(newId ?? '') };
    if (!sameScope(target, wanted)) {
      return {
        ok: false,
        code: 'cross-scope-supersede',
        oldId: old.id,
        oldScope: scopeSummary(target),
        newScope: scopeSummary(wanted),
      };
    }
    if (String(old.status) === 'superseded') return { ok: true, duplicate: true, oldId: old.id };
    if (String(old.status) !== 'confirmed') {
      // A draft/redacted/expired row is not the thing a correction is about; refusing is the only
      // honest answer (silently rewriting it would change a state nobody asked to change).
      return { ok: false, code: 'not-confirmed', oldId: old.id, status: String(old.status) };
    }
    const now = isoOrNull(at) ?? isoNow();
    this._run(
      `UPDATE memories SET status = 'superseded', valid_to = ?, updated_at = ?, revision = revision + 1
        WHERE id = ? AND status = 'confirmed'`,
      [now, now, old.id],
    );
    this.recordRevision({
      oldId: old.id,
      newId: String(newId ?? ''),
      operation: 'supersede',
      reason: String(reason ?? '').slice(0, 120),
      actor: String(actor ?? 'system').slice(0, 40),
    });
    return { ok: true, duplicate: false, oldId: old.id };
  }

  /**
   * All-or-nothing supersede of several memories (round-3 B5).
   *
   * The validation pass runs first: if **any** id is missing, out of scope, or not confirmed, nothing
   * is written. A partial supersede is worse than a refusal — the caller cannot tell which halves of
   * a correction took effect.
   */
  supersedeMany({ oldIds = [], newId, reason = '', actor = 'system', at = null, scope = null } = {}) {
    this._assertWritable();
    const ids = [...new Set((Array.isArray(oldIds) ? oldIds : []).map(value => String(value ?? '').trim()).filter(Boolean))];
    if (!ids.length) return { ok: true, applied: [], skipped: [], duplicate: [] };
    const wanted = normalizeSupersedeScope(scope, this, newId);
    if (!wanted) return { ok: false, code: 'new-record-not-found', newId: String(newId ?? '') };
    // Pass 1: nothing is written.
    const plan = [];
    const skipped = [];
    const duplicate = [];
    for (const id of ids) {
      const row = this._get('SELECT id, status, user_id, persona_id, world_id FROM memories WHERE id = ?', [id]);
      if (!row) return { ok: false, code: 'not-found', oldId: id, applied: [], skipped, duplicate };
      if (!sameScope(scopeOfRow(row), wanted)) {
        return {
          ok: false, code: 'cross-scope-supersede', oldId: id,
          oldScope: scopeSummary(scopeOfRow(row)), newScope: scopeSummary(wanted),
          applied: [], skipped, duplicate,
        };
      }
      if (String(row.status) === 'superseded') { duplicate.push(id); continue; }
      if (String(row.status) !== 'confirmed') {
        return { ok: false, code: 'not-confirmed', oldId: id, status: String(row.status), applied: [], skipped, duplicate };
      }
      plan.push(id);
    }
    if (!plan.length) return { ok: true, applied: [], skipped, duplicate };
    // Pass 2: one transaction, so "all" really means all.
    const applied = [];
    this.transaction(() => {
      for (const id of plan) {
        const result = this.supersedeMemory({ oldId: id, newId, reason, actor, at, scope: wanted });
        if (result?.ok !== true) throw Object.assign(new Error(result?.code || 'supersede-failed'), { result });
        applied.push(id);
      }
    });
    return { ok: true, applied, skipped, duplicate };
  }

  rememberFact(input = {}) {
    this._assertWritable();
    const userId = assertNonEmptyString(input.userId, 'userId ');
    const personaId = assertNonEmptyString(input.personaId, 'personaId ');
    const key = assertNonEmptyString(input.key, 'rememberFact 的 key ');
    const value = assertNonEmptyString(String(input.value ?? ''), 'rememberFact 的 value ');
    const scope = assertEnum(input.scope ?? 'user_global', SCOPES, 'rememberFact 的 scope ');
    const kind = assertEnum(input.kind ?? 'fact', KINDS, 'rememberFact 的 kind ');
    const subject = String(input.subject ?? 'user');
    const worldId = String(input.worldId ?? '');
    const predicate = String(input.predicate ?? key);
    const multi = predicate.startsWith('multi:');
    const needle = normalizeText(value);

    return this.transaction(() => {
      const activeRows = this._all(
        `SELECT * FROM memories
          WHERE user_id = ? AND persona_id = ? AND world_id = ? AND scope = ?
            AND subject = ? AND predicate = ? AND status = 'confirmed'
          ORDER BY created_at ASC, id ASC`,
        [userId, personaId, worldId, scope, subject, predicate],
      ).map(mapMemoryRow);

      const duplicate = activeRows.find(record => normalizeText(record.value) === needle);
      if (duplicate) return duplicate;

      const supersedeTargets = multi ? [] : activeRows;
      const now = isoNow();
      // 每条新记忆都必须带「发生时间」：显式传入优先，否则就是这次写入的时刻。
      // 召回与注入靠 occurred_at 展示时间（render.mjs 的 at 字段），所以这里不能留空。
      const occurredAt = isoOrNull(input.occurredAt) ?? now;
      const newId = typeof input.id === 'string' && input.id.trim()
        ? input.id.trim()
        : `mem_${randomHex(20)}`;
      const record = this._normalizeMemoryInput({
        ...input,
        id: newId,
        scope,
        kind,
        subject,
        predicate,
        value,
        userId,
        personaId,
        worldId,
        realityLevel: input.realityLevel ?? 'explicit_user_statement',
        occurredAt,
        validFrom: input.validFrom ?? occurredAt,
        supersedesId: supersedeTargets.length ? supersedeTargets[supersedeTargets.length - 1].id : '',
      });

      let result = this._insertMemoryRow(record);
      if (!result.inserted) {
        // The deterministic dedupe key can already belong to a superseded row
        // (A -> B -> A). Re-inserting the old value is legitimate, so the key
        // gets a generation suffix instead of surfacing a fake duplicate.
        if (result.record.status === 'confirmed' && normalizeText(result.record.value) === needle) {
          return result.record;
        }
        result = this._insertMemoryRow({ ...record, dedupeKey: `${record.dedupeKey}:${newId}` });
      }

      for (const old of supersedeTargets) {
        this.supersedeMemory({
          oldId: old.id,
          newId: result.record.id,
          reason: String(input.reason ?? '新值取代旧值'),
          actor: String(input.actor ?? 'system'),
          at: now,
        });
      }
      return this._rowById(result.record.id);
    });
  }

  // -- evidence links and revisions -----------------------------------------

  addEvidence(memoryId, sourceId, { evidenceKind = 'supports', confidence = 0.5 } = {}) {
    this._assertWritable();
    const memory = assertNonEmptyString(memoryId, 'memoryId ');
    const source = assertNonEmptyString(sourceId, 'sourceId ');
    const now = isoNow();
    this.transaction(() => {
      this._run(
        `INSERT INTO memory_evidence (memory_id, source_id, evidence_kind, confidence, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(memory_id, source_id) DO UPDATE SET
           evidence_kind = excluded.evidence_kind,
           confidence = excluded.confidence`,
        [memory, source, String(evidenceKind ?? 'supports'), clamp(confidence, 0, 1), now],
      );
    });
    return { memoryId: memory, sourceId: source, evidenceKind: String(evidenceKind ?? 'supports'), confidence: clamp(confidence, 0, 1) };
  }

  evidenceFor(memoryId) {
    this._assertOpen();
    const rows = this._all(
      `SELECT e.source_id, e.confidence, s.role, s.occurred_at, s.content
         FROM memory_evidence AS e
         LEFT JOIN source_events AS s ON s.source_id = e.source_id
        WHERE e.memory_id = ?
        ORDER BY COALESCE(s.occurred_at, e.created_at) ASC, e.source_id ASC`,
      [String(memoryId ?? '')],
    );
    return rows.map(row => ({
      sourceId: row.source_id,
      role: row.role ?? '',
      occurredAt: row.occurred_at ?? null,
      content: row.content ?? '',
      confidence: Number(row.confidence ?? 0.5),
    }));
  }

  recordRevision({ oldId = '', newId = '', operation, reason = '', actor = 'system' } = {}) {
    this._assertWritable();
    const op = assertNonEmptyString(operation, 'revision operation ');
    const revisionId = `rev_${randomHex(20)}`;
    this.transaction(() => {
      this._run(
        `INSERT INTO memory_revisions (revision_id, old_id, new_id, operation, reason, actor, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [revisionId, String(oldId ?? ''), String(newId ?? ''), op, String(reason ?? ''),
          String(actor ?? 'system'), isoNow()],
      );
    });
    return revisionId;
  }

  revisionsFor(id) {
    this._assertOpen();
    const rows = this._all(
      `SELECT * FROM memory_revisions
        WHERE old_id = ? OR new_id = ?
        ORDER BY created_at ASC, revision_id ASC`,
      [String(id ?? ''), String(id ?? '')],
    );
    return rows.map(mapRevisionRow);
  }

  // -- domain event ingest receipts (CONTRACT.md §16) -----------------------

  /** Idempotent DDL; called on writable open and lazily before the first put. */
  _ensureDomainEventReceipts() {
    this._assertWritable();
    if (this._receiptsReady) return;
    const status = ensureDomainEventReceipts(this.handle);
    if (!status.compatible) {
      // Newer unknown receipt schema: refuse to guess. The channel stays closed and
      // ingestDomainEvent folds this into `retryable_failure` without claiming a write.
      throw new Error(`收据表版本不兼容：支持 ≤ ${DOMAIN_EVENT_RECEIPTS_VERSION}，实际 ${status.version}。`);
    }
    this._receiptsReady = true;
  }

  /**
   * Observable state of the receipt channel (CONTRACT.md §16.6). Read-only and
   * side-effect free: it never creates the table and never rewrites the marker, so a
   * diagnostics caller can prove that a v2 database keeps its main version while the
   * receipt channel reports its own.
   */
  domainEventReceiptsStatus() {
    this._assertOpen();
    return inspectDomainEventReceipts(this.handle);
  }

  /**
   * Receipt lookup by dedupe key. Returns null for a missing table (read-only or
   * never-written database) or for an incompatible newer receipt schema, so callers
   * can fall through to a fresh ingest — which then fails closed on the write path.
   */
  getDomainEventReceipt(dedupeKey) {
    this._assertOpen();
    const key = typeof dedupeKey === 'string' ? dedupeKey.trim() : '';
    if (!key) return null;
    try {
      if (!inspectDomainEventReceipts(this.handle).compatible) return null;
      return mapReceiptRow(this._get('SELECT * FROM domain_event_receipts WHERE dedupe_key = ?', [key]));
    } catch {
      return null;
    }
  }

  /**
   * Persist one ingest receipt. The dedupe key is the idempotency anchor: a second
   * put for the same key keeps the first row and returns it unchanged.
   */
  putDomainEventReceipt(input = {}) {
    this._assertWritable();
    const receiptId = assertNonEmptyString(input.receiptId, '收据 receiptId ');
    const dedupeKey = assertNonEmptyString(input.dedupeKey, '收据 dedupeKey ');
    const namespace = assertNonEmptyString(input.namespace, '收据 namespace ');
    const scope = assertNonEmptyString(input.scope, '收据 scope ');
    const eventId = assertNonEmptyString(input.eventId, '收据 eventId ');
    const transformVersion = assertNonEmptyString(String(input.transformVersion ?? ''), '收据 transformVersion ');
    const status = assertEnum(input.status, DOMAIN_EVENT_RECEIPT_STATUSES, '收据 status ');
    const now = isoNow();
    const createdAt = isoOrNull(input.createdAt) ?? now;
    const updatedAt = isoOrNull(input.updatedAt) ?? createdAt;
    const roots = Array.isArray(input.rootEvidenceIds)
      ? [...new Set(input.rootEvidenceIds.map(value => String(value ?? '').trim()).filter(Boolean))].slice(0, 64)
      : [];
    return this.transaction(() => {
      this._ensureDomainEventReceipts();
      this._run(
        `INSERT INTO domain_event_receipts
           (receipt_id, dedupe_key, namespace, scope, event_id, transform_version, status,
            record_id, source_id, content_hash, reality_status, evidence_status, root_evidence,
            reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(dedupe_key) DO NOTHING`,
        [receiptId, dedupeKey, namespace, scope, eventId, transformVersion, status,
          String(input.recordId ?? ''), String(input.sourceId ?? ''), String(input.contentHash ?? ''),
          String(input.realityStatus ?? ''), String(input.evidenceStatus ?? ''),
          JSON.stringify(roots), String(input.reason ?? ''), createdAt, updatedAt],
      );
      return mapReceiptRow(this._get('SELECT * FROM domain_event_receipts WHERE dedupe_key = ?', [dedupeKey]));
    });
  }

  countDomainEventReceipts({ scope = '', status = '' } = {}) {
    this._assertOpen();
    const clauses = [];
    const params = [];
    if (scope) { clauses.push('scope = ?'); params.push(String(scope)); }
    if (status) { clauses.push('status = ?'); params.push(String(status)); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    try {
      return Number(this._get(`SELECT count(*) AS total FROM domain_event_receipts ${where}`, params)?.total ?? 0);
    } catch {
      return 0;
    }
  }

  // -- retrieval ------------------------------------------------------------

  /**
   * FTS5 candidate list. score = -bm25 (bigger is better); the raw rank is
   * kept as an alias because the contract names the field both ways. Owner
   * identity is filtered here; scope visibility stays with the caller.
   */
  fullTextSearch({ userId, personaId, worldId = '', query, limit = 32, scopes, statuses = ['confirmed'] } = {}) {
    this._assertOpen();
    const expression = matchExpression(String(query ?? ''));
    if (!expression) return [];
    const clauses = ['memory_fts MATCH ?', 'm.user_id = ?', 'm.persona_id = ?'];
    const params = [expression, assertNonEmptyString(userId, 'userId '), assertNonEmptyString(personaId, 'personaId ')];
    const world = String(worldId ?? '');
    if (world === '') {
      clauses.push('m.world_id = ?');
      params.push('');
    } else {
      clauses.push('(m.world_id = ? OR m.world_id = ?)');
      params.push(world, '');
    }
    pushInClause(clauses, params, 'm.scope', scopes);
    // An explicit empty array means "every status"; the default is confirmed.
    pushInClause(clauses, params, 'm.status', statuses);
    const boundedLimit = clampInt(limit, 1, 500, 32);
    const sql = `SELECT memory_fts.memory_id AS id, bm25(memory_fts) AS rank
                   FROM memory_fts
                   JOIN memories AS m ON m.id = memory_fts.memory_id
                  WHERE ${clauses.join(' AND ')}
                  ORDER BY rank ASC, id ASC
                  LIMIT ?`;
    const rows = this._all(sql, [...params, boundedLimit]);
    return rows.map(row => {
      const rawRank = Number(row.rank);
      // -0 must not survive: it compares fine but serialises oddly.
      const score = Number.isFinite(rawRank) ? (rawRank === 0 ? 0 : -rawRank) : 0;
      return { id: String(row.id), score, rank: score };
    });
  }

  rebuildSearchIndex() {
    this._assertWritable();
    return this.transaction(() => {
      this._run('DELETE FROM memory_fts');
      const rows = this._all('SELECT id, search_text FROM memories', []);
      const insert = this._stmt('INSERT INTO memory_fts (memory_id, search_text) VALUES (?, ?)');
      for (const row of rows) insert.run(String(row.id), String(row.search_text ?? ''));
      return { memories: rows.length };
    });
  }

  // -- vectors --------------------------------------------------------------

  putEmbedding(memoryId, { provider, model, dimensions, vector } = {}) {
    this._assertWritable();
    const memory = assertNonEmptyString(memoryId, 'memoryId ');
    const providerName = assertNonEmptyString(provider, '向量 provider ');
    const modelName = assertNonEmptyString(model, '向量 model ');
    const floats = vector instanceof Float32Array
      ? vector
      : Array.isArray(vector) || ArrayBuffer.isView(vector)
        ? Float32Array.from(vector)
        : null;
    if (!floats || !floats.length) throw new Error('向量必须是非空 Float32Array。');
    const dims = clampInt(dimensions ?? floats.length, 1, 65536, floats.length);
    if (floats.length < dims) throw new Error(`向量维度不足：声明 ${dims}，实际 ${floats.length}。`);
    const view = floats.subarray(0, dims);
    const blob = encodeVector(view);
    this.transaction(() => {
      this._run(
        `INSERT INTO memory_embeddings (memory_id, provider, model, dimensions, vector, version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(memory_id, provider, model) DO UPDATE SET
           dimensions = excluded.dimensions,
           vector = excluded.vector,
           version = excluded.version,
           created_at = excluded.created_at`,
        [memory, providerName, modelName, dims, blob, 1, isoNow()],
      );
    });
    return { memoryId: memory, provider: providerName, model: modelName, dimensions: dims };
  }

  /**
   * Read stored vectors. Without `memoryIds` this is the original bounded
   * scan ordered by memory_id (default cap 1000). With `memoryIds` only the
   * named rows are returned, chunked so a retriever asking for thousands of
   * candidates never trips SQLite's host-parameter limit; `limit` still caps
   * the answer. An explicitly empty selection returns [] instead of reading
   * the whole table.
   */
  getEmbeddings({ provider, model, memoryIds, limit = 1000 } = {}) {
    this._assertOpen();
    const filters = [];
    const baseParams = [];
    if (provider != null && provider !== '') {
      filters.push('provider = ?');
      baseParams.push(String(provider));
    }
    if (model != null && model !== '') {
      filters.push('model = ?');
      baseParams.push(String(model));
    }
    const boundedLimit = clampInt(limit, 1, MAX_PAGE_SIZE, 1000);
    const requested = Array.isArray(memoryIds)
      ? [...new Set(memoryIds.map(id => String(id ?? '')).filter(Boolean))].sort()
      : null;
    // An explicit empty selection means "no vectors", not "no filter".
    if (requested && requested.length === 0) return [];

    const rows = [];
    const collect = (extraClauses = [], extraParams = []) => {
      const remaining = boundedLimit - rows.length;
      if (remaining <= 0) return;
      const clauses = [...filters, ...extraClauses];
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      rows.push(...this._all(
        `SELECT memory_id, dimensions, vector FROM memory_embeddings ${where}
          ORDER BY memory_id ASC LIMIT ?`,
        [...baseParams, ...extraParams, remaining],
      ));
    };

    if (!requested) {
      collect();
    } else {
      for (let offset = 0; offset < requested.length && rows.length < boundedLimit; offset += EMBEDDING_ID_CHUNK) {
        const chunk = requested.slice(offset, offset + EMBEDDING_ID_CHUNK);
        collect([`memory_id IN (${chunk.map(() => '?').join(', ')})`], chunk);
      }
      // Chunk reads run per slice; restore the documented memory_id ordering.
      rows.sort((left, right) => String(left.memory_id).localeCompare(String(right.memory_id)));
    }

    return rows.map(row => {
      const dimensions = Number(row.dimensions);
      return {
        memoryId: String(row.memory_id),
        dimensions,
        vector: decodeVector(row.vector, dimensions),
      };
    });
  }

  pendingEmbeddings({ provider, model, dimensions = null, limit = 200 } = {}) {
    this._assertOpen();
    const providerName = assertNonEmptyString(provider, '向量 provider ');
    const modelName = assertNonEmptyString(model, '向量 model ');
    // `dimensions` 可选：给了就只把「同 provider/model 但维度不对」的向量视为已存在，
    // 这样换模型维度后不会因为旧行同名就永远跳过（Codex 评审第 5/7 项）。
    const dims = dimensions == null ? null : clampInt(dimensions, 1, 65536, 0);
    const joinExtra = dims == null ? '' : ' AND e.dimensions = ?';
    const params = dims == null ? [providerName, modelName] : [providerName, modelName, dims];
    const rows = this._all(
      `SELECT m.* FROM memories AS m
         LEFT JOIN memory_embeddings AS e
                ON e.memory_id = m.id AND e.provider = ? AND e.model = ?${joinExtra}
        WHERE m.status = 'confirmed' AND e.memory_id IS NULL
        ORDER BY m.importance DESC, m.updated_at DESC, m.id ASC
        LIMIT ?`,
      [...params, clampInt(limit, 1, MAX_PAGE_SIZE, 200)],
    );
    return rows.map(mapMemoryRow);
  }

  /**
   * Vectors that no longer describe their memory: the memory row is gone or it
   * was touched after the vector was written. The rebuild path uses this to
   * re-embed only outdated rows instead of trusting an old vector forever.
   *
   * `statuses` defaults to ['confirmed'] so retired rows are not re-embedded on
   * every rebuild; pass [] to inspect every status. Orphan vectors (no memory
   * row) are always reported so a cleanup pass can delete them.
   */
  staleEmbeddings({ provider, model, limit = 1000, statuses = ['confirmed'] } = {}) {
    this._assertOpen();
    const clauses = ['(m.id IS NULL OR m.updated_at > e.created_at)'];
    const params = [];
    if (provider != null && provider !== '') {
      clauses.push('e.provider = ?');
      params.push(String(provider));
    }
    if (model != null && model !== '') {
      clauses.push('e.model = ?');
      params.push(String(model));
    }
    const statusList = (Array.isArray(statuses) ? statuses : [statuses])
      .filter(item => item != null && item !== '')
      .map(item => String(item));
    if (statusList.length) {
      // A missing memory has no status to match; keep it visible regardless.
      clauses.push(`(m.id IS NULL OR m.status IN (${statusList.map(() => '?').join(', ')}))`);
      params.push(...statusList);
    }
    const rows = this._all(
      `SELECT DISTINCT e.memory_id AS memory_id
         FROM memory_embeddings AS e
         LEFT JOIN memories AS m ON m.id = e.memory_id
        WHERE ${clauses.join(' AND ')}
        ORDER BY memory_id ASC
        LIMIT ?`,
      [...params, clampInt(limit, 1, MAX_PAGE_SIZE, 1000)],
    );
    return rows.map(row => String(row.memory_id));
  }

  clearEmbeddings(provider) {
    this._assertWritable();
    if (provider == null || provider === '') {
      const result = this.transaction(() => this._run('DELETE FROM memory_embeddings'));
      return Number(result.changes ?? 0);
    }
    const result = this.transaction(() => this._run('DELETE FROM memory_embeddings WHERE provider = ?', [String(provider)]));
    return Number(result.changes ?? 0);
  }

  /**
   * 精确删除某一组向量（provider + model 必填）。
   * `clearEmbeddings()` 不带参数会清空整张表，绝不能用于常规维护；清理旧模型一律走这里。
   */
  deleteEmbeddings({ provider, model } = {}) {
    this._assertWritable();
    const providerName = assertNonEmptyString(provider, '向量 provider ');
    const modelName = assertNonEmptyString(model, '向量 model ');
    const result = this.transaction(() => this._run(
      'DELETE FROM memory_embeddings WHERE provider = ? AND model = ?',
      [providerName, modelName],
    ));
    return Number(result.changes ?? 0);
  }

  // -- relations ------------------------------------------------------------

  addRelation({ sourceRef, relation, targetRef, scope = 'user_persona', evidenceSourceId = '', confidence = 0.5 } = {}) {
    this._assertWritable();
    const source = assertNonEmptyString(sourceRef, 'relation sourceRef ');
    const kind = assertNonEmptyString(relation, 'relation ');
    const target = assertNonEmptyString(targetRef, 'relation targetRef ');
    const scopeValue = String(scope ?? 'user_persona');
    const evidence = String(evidenceSourceId ?? '');
    const relationId = stableId('rel', source, kind, target, scopeValue, evidence);
    this.transaction(() => {
      this._run(
        `INSERT INTO memory_relations
           (relation_id, source_ref, relation, target_ref, scope, evidence_source_id, confidence, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(relation_id) DO UPDATE SET confidence = excluded.confidence`,
        [relationId, source, kind, target, scopeValue, evidence, clamp(confidence, 0, 1), isoNow()],
      );
    });
    return mapRelationRow(this._get('SELECT * FROM memory_relations WHERE relation_id = ?', [relationId]));
  }

  relationsFor(sourceRef, relation) {
    this._assertOpen();
    const clauses = ['source_ref = ?'];
    const params = [String(sourceRef ?? '')];
    if (relation != null && relation !== '') {
      clauses.push('relation = ?');
      params.push(String(relation));
    }
    return this._all(
      `SELECT * FROM memory_relations WHERE ${clauses.join(' AND ')} ORDER BY created_at ASC, relation_id ASC`,
      params,
    ).map(mapRelationRow);
  }

  // -- job queue ------------------------------------------------------------

  enqueueJob({ type, streamKey = '', cursor = 0, payload = {}, force = false } = {}) {
    this._assertWritable();
    const jobType = assertNonEmptyString(type, '作业 type ');
    const stream = String(streamKey ?? '');
    return this.transaction(() => {
      // force means "this batch is new even if the stream has work in
      // flight"; the default still folds a re-enqueue into the open job.
      if (!force) {
        const existing = this._get(
          `SELECT * FROM memory_jobs
            WHERE type = ? AND stream_key = ? AND state IN ('pending', 'running')
            ORDER BY created_at ASC, rowid ASC LIMIT 1`,
          [jobType, stream],
        );
        if (existing) return mapJobRow(existing);
      }
      const now = isoNow();
      const jobId = `job_${randomHex(20)}`;
      this._run(
        `INSERT INTO memory_jobs
           (job_id, type, stream_key, cursor, state, attempts, next_retry_at, last_error, payload, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', 0, NULL, '', ?, ?, ?)`,
        [jobId, jobType, stream, clampInt(cursor, 0, Number.MAX_SAFE_INTEGER, 0),
          encodeJsonObject(payload), now, now],
      );
      return mapJobRow(this._get('SELECT * FROM memory_jobs WHERE job_id = ?', [jobId]));
    });
  }

  /**
   * Exactly one pending job becomes running. The UPDATE ... RETURNING is a
   * single statement, so two callers (or two connections) can never win the
   * same row. `streamKey` narrows the claim to one stream so a shared database
   * cannot hand another viewer's batch to this worker.
   */
  claimJob(type, { now = Date.now(), streamKey } = {}) {
    this._assertWritable();
    const jobType = assertNonEmptyString(type, '作业 type ');
    const stamp = isoNow(asClock(now));
    const clauses = [
      'type = ?',
      "state = 'pending'",
      "(next_retry_at IS NULL OR next_retry_at = '' OR next_retry_at <= ?)",
    ];
    const params = [jobType, stamp];
    if (streamKey !== undefined && streamKey !== null) {
      clauses.push('stream_key = ?');
      params.push(String(streamKey));
    }
    const row = this._get(
      `UPDATE memory_jobs
          SET state = 'running', updated_at = ?
        WHERE job_id = (
                SELECT job_id FROM memory_jobs
                 WHERE ${clauses.join(' AND ')}
                 ORDER BY created_at ASC, rowid ASC
                 LIMIT 1
              )
          AND state = 'pending'
        RETURNING *`,
      [stamp, ...params],
    );
    return row ? mapJobRow(row) : null;
  }

  completeJob(jobId, { cursor } = {}) {
    this._assertWritable();
    const id = assertNonEmptyString(String(jobId), 'jobId ');
    const now = isoNow();
    const row = cursor === undefined
      ? this._get(
        `UPDATE memory_jobs
            SET state = 'done', last_error = '', next_retry_at = NULL, updated_at = ?
          WHERE job_id = ?
          RETURNING *`,
        [now, id],
      )
      : this._get(
        `UPDATE memory_jobs
            SET state = 'done', cursor = ?, last_error = '', next_retry_at = NULL, updated_at = ?
          WHERE job_id = ?
          RETURNING *`,
        [clampInt(cursor, 0, Number.MAX_SAFE_INTEGER, 0), now, id],
      );
    return row ? mapJobRow(row) : null;
  }

  /**
   * attempts+1 with exponential backoff (n * 2^(n-1) seconds); the sixth
   * failure would exceed MAX_JOB_ATTEMPTS and parks the job as failed while
   * keeping the (redacted) error text for the operator.
   */
  failJob(jobId, error, { retryDelayMs } = {}) {
    this._assertWritable();
    const id = assertNonEmptyString(String(jobId), 'jobId ');
    return this.transaction(() => {
      const row = this._get('SELECT * FROM memory_jobs WHERE job_id = ?', [id]);
      if (!row) return null;
      const attempts = Number(row.attempts ?? 0) + 1;
      const message = truncate(redactSecrets(String(error ?? '')), MAX_ERROR_LENGTH, '…');
      const exhausted = attempts >= MAX_JOB_ATTEMPTS;
      const delay = retryDelayMs == null
        ? attempts * 2 ** (attempts - 1) * 1000
        : Math.max(0, Number(retryDelayMs) || 0);
      const nextRetryAt = exhausted ? null : isoNow(Date.now() + delay);
      const state = exhausted ? 'failed' : 'pending';
      const updated = this._get(
        `UPDATE memory_jobs
            SET state = ?, attempts = ?, next_retry_at = ?, last_error = ?, updated_at = ?
          WHERE job_id = ?
          RETURNING *`,
        [state, attempts, nextRetryAt, message, isoNow(), id],
      );
      return mapJobRow(updated);
    });
  }

  /**
   * Bring a parked batch back into the queue: a failed job (or a pending one
   * still waiting out its backoff) returns to pending with no retry deadline.
   * Attempts are preserved unless resetAttempts is set so audit stays honest;
   * the payload and the linked evidence are never touched.
   *
   * `running` rows are normally refused because they may still be worked on.
   * With allowRunning they are recovered only when they have been untouched
   * for staleAfterMs (default 15 min), which is the crash-leftover case.
   * Unknown or disallowed jobs return { ok:false, reason } instead of throwing.
   */
  requeueJob(jobId, { resetAttempts = false, allowRunning = false, staleAfterMs } = {}) {
    this._assertWritable();
    const id = String(jobId ?? '');
    return this.transaction(() => {
      if (!id) return { ok: false, reason: 'job-not-found' };
      const row = this._get('SELECT * FROM memory_jobs WHERE job_id = ?', [id]);
      if (!row) return { ok: false, reason: 'job-not-found' };
      const state = String(row.state ?? '');
      if (state !== 'failed' && state !== 'pending') {
        if (state !== 'running' || !allowRunning) {
          return { ok: false, reason: `job-not-requeueable:${state}` };
        }
        const touchedAt = Date.parse(String(row.updated_at ?? ''));
        // updated_at <= now - window means the worker is gone for good.
        if (!Number.isFinite(touchedAt) || touchedAt > Date.now() - staleWindow(staleAfterMs)) {
          return { ok: false, reason: 'job-running-not-stale' };
        }
      }
      const attempts = resetAttempts ? 0 : Number(row.attempts ?? 0);
      const updated = this._get(
        `UPDATE memory_jobs
            SET state = 'pending', attempts = ?, next_retry_at = NULL, updated_at = ?
          WHERE job_id = ?
          RETURNING *`,
        [attempts, isoNow(), id],
      );
      return { ok: true, job: mapJobRow(updated) };
    });
  }

  /**
   * Startup/manual sweep for crash-leftover `running` rows: everything that
   * has not been touched for staleAfterMs goes back to pending. Attempts are
   * deliberately untouched so a crash loop is not counted as model failures;
   * the sweep is idempotent and returns { reset: 0 } when nothing matches.
   */
  resetStaleRunning({ staleAfterMs, now = Date.now() } = {}) {
    this._assertWritable();
    const clock = asClock(now);
    const cutoff = isoNow(clock - staleWindow(staleAfterMs));
    const result = this._run(
      `UPDATE memory_jobs
          SET state = 'pending', next_retry_at = NULL, updated_at = ?
        WHERE state = 'running' AND updated_at <= ?`,
      [isoNow(clock), cutoff],
    );
    return { reset: Number(result.changes ?? 0) };
  }

  jobs({ state, type, limit = 50 } = {}) {
    this._assertOpen();
    const clauses = [];
    const params = [];
    pushInClause(clauses, params, 'state', state);
    pushInClause(clauses, params, 'type', type);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this._all(
      `SELECT * FROM memory_jobs ${where} ORDER BY updated_at DESC, created_at DESC, job_id ASC LIMIT ?`,
      [...params, clampInt(limit, 1, MAX_PAGE_SIZE, 50)],
    ).map(mapJobRow);
  }

  jobStats() {
    this._assertOpen();
    const stats = { pending: 0, running: 0, failed: 0, done: 0 };
    for (const row of this._all('SELECT state, count(*) AS total FROM memory_jobs GROUP BY state', [])) {
      if (Object.hasOwn(stats, row.state)) stats[row.state] = Number(row.total ?? 0);
    }
    return stats;
  }

  // -- wiki registry --------------------------------------------------------

  upsertWikiPage({ pageId, scope, topic, path: pagePath, sourceRevision = 0, contentHash: hash = '', status = 'compiled', notes = '' } = {}) {
    this._assertWritable();
    const id = assertNonEmptyString(pageId, 'pageId ');
    const now = isoNow();
    this.transaction(() => {
      this._run(
        `INSERT INTO wiki_pages
           (page_id, scope, topic, path, source_revision, content_hash, status, compiled_at, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(page_id) DO UPDATE SET
           scope = excluded.scope,
           topic = excluded.topic,
           path = excluded.path,
           source_revision = excluded.source_revision,
           content_hash = excluded.content_hash,
           status = excluded.status,
           compiled_at = excluded.compiled_at,
           notes = excluded.notes`,
        [id, String(scope ?? ''), String(topic ?? ''), String(pagePath ?? ''),
          clampInt(sourceRevision, 0, Number.MAX_SAFE_INTEGER, 0), String(hash ?? ''),
          String(status ?? 'compiled'), now, String(notes ?? '')],
      );
    });
    return this.wikiPage(id);
  }

  wikiPage(pageId) {
    this._assertOpen();
    return mapWikiRow(this._get('SELECT * FROM wiki_pages WHERE page_id = ?', [String(pageId ?? '')]));
  }

  listWikiPages(scope) {
    this._assertOpen();
    if (scope == null || scope === '') {
      return this._all('SELECT * FROM wiki_pages ORDER BY page_id ASC', []).map(mapWikiRow);
    }
    return this._all('SELECT * FROM wiki_pages WHERE scope = ? ORDER BY page_id ASC', [String(scope)]).map(mapWikiRow);
  }

  // -- aggregates -----------------------------------------------------------

  stats() {
    this._assertOpen();
    const count = (sql, params = []) => Number(this._get(sql, params)?.total ?? 0);
    return {
      memories: count('SELECT count(*) AS total FROM memories'),
      confirmedMemories: count("SELECT count(*) AS total FROM memories WHERE status = 'confirmed'"),
      pendingMemories: count("SELECT count(*) AS total FROM memories WHERE status = 'pending'"),
      events: count('SELECT count(*) AS total FROM source_events'),
      embeddings: count('SELECT count(*) AS total FROM memory_embeddings'),
      jobs: count('SELECT count(*) AS total FROM memory_jobs'),
      wikiPages: count('SELECT count(*) AS total FROM wiki_pages'),
      schemaVersion: this.schemaVersion(),
      file: this.file,
      // Observable open-time integrity policy: 'full' | 'quick' | 'skip' and
      // the timestamp of the last successful check (null when skipped).
      integrityMode: this.integrityMode,
      integrityCheckedAt: this.integrityCheckedAt,
    };
  }
}

// --- open -------------------------------------------------------------------

function readApplicationId(handle) {
  const row = handle.prepare('PRAGMA application_id').get();
  return Number(row?.application_id ?? 0) || 0;
}

function userTables(handle) {
  return handle
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map(row => String(row.name));
}

function configurePragmas(handle, { readOnly, timeoutMs }) {
  const timeout = clampInt(timeoutMs, 0, 60000, DEFAULT_TIMEOUT_MS);
  handle.exec(`PRAGMA busy_timeout = ${timeout}`);
  handle.exec('PRAGMA foreign_keys = ON');
  if (readOnly) {
    handle.exec('PRAGMA query_only = ON');
    const row = handle.prepare('PRAGMA journal_mode').get();
    return String(row?.journal_mode ?? '').toLowerCase();
  }
  handle.exec('PRAGMA synchronous = NORMAL');
  const row = handle.prepare('PRAGMA journal_mode = WAL').get();
  return String(row?.journal_mode ?? '').toLowerCase();
}

/**
 * Open (and migrate in place) the companion memory database. Throws when the
 * file belongs to another application, is corrupt, or when node:sqlite is
 * missing; callers are expected to degrade instead of failing a chat turn.
 */
export async function openMemoryDatabase(options = {}) {
  const settings = options ?? {};
  const readOnly = Boolean(settings.readOnly);
  const rawFile = settings.file;
  if (typeof rawFile !== 'string' || !rawFile.trim()) throw new Error('记忆数据库路径不能为空。');
  // Validate the policy before touching the filesystem so a bad config never
  // creates a database.
  const integrityMode = normalizeIntegrityMode(settings.integrity);
  const inMemory = rawFile === ':memory:';
  const file = inMemory ? ':memory:' : path.resolve(rawFile);

  const { DatabaseSync } = await loadSqlite();
  if (!inMemory && !readOnly) fs.mkdirSync(path.dirname(file), { recursive: true });

  let handle;
  try {
    handle = new DatabaseSync(file, { readOnly });
  } catch (error) {
    throw new Error(`无法打开记忆数据库 ${file}：${error?.message ?? error}`);
  }

  try {
    let journalMode;
    try {
      journalMode = configurePragmas(handle, { readOnly, timeoutMs: settings.timeoutMs });
    } catch (error) {
      // A non-SQLite (or truncated) file only fails on the first read, not at
      // construction time, so the header check happens here.
      throw new Error(`无法打开记忆数据库 ${file}：${error?.message ?? error}`);
    }

    const applicationId = readApplicationId(handle);
    if (applicationId !== APPLICATION_ID) {
      if (applicationId !== 0) {
        throw new Error(`该文件不是陪伴记忆数据库（application_id=${applicationId}），已拒绝打开。`);
      }
      const tables = userTables(handle);
      if (tables.length) {
        throw new Error(`该 SQLite 文件已被其它应用占用（表：${tables.slice(0, 3).join(', ')}），已拒绝打开。`);
      }
      if (readOnly) throw new Error('只读模式无法初始化新的记忆数据库。');
    }

    if (readOnly) {
      const tables = userTables(handle);
      if (!tables.includes('memories') || !tables.includes('schema_meta')) {
        throw new Error('只读模式要求记忆数据库已完成初始化。');
      }
    } else {
      // Frozen DDL, every statement IF NOT EXISTS: safe on every open.
      handle.exec(readSchemaSql());
    }

    const versionRow = handle.prepare("SELECT value FROM schema_meta WHERE key = 'schemaVersion'").get();
    const storedVersion = versionRow ? Number(versionRow.value) : null;
    if (Number.isFinite(storedVersion) && storedVersion > SCHEMA_VERSION) {
      throw new Error(`记忆数据库版本不兼容：期望 ${SCHEMA_VERSION}，实际 ${storedVersion}。`);
    }

    if (!readOnly) {
      // Ingest receipts ride a separate forward-only track (CONTRACT.md §16.6) and are
      // created only after the main version check passed, so opening a database written
      // by a *newer* build never adds a table (or a marker) to it. A failure here must
      // not disable the whole memory store: the first putDomainEventReceipt retries the
      // same idempotent DDL. A newer unknown receipt schema is left untouched (the call
      // reports compatible:false), so an open never downgrades it either.
      try {
        ensureDomainEventReceipts(handle);
      } catch {
        // reported through ingestDomainEvent -> retryable_failure instead of bricking open
      }
    }
    // 旧库：只读模式下允许打开（索引缺失只影响性能），可写模式先迁移再写版本号。
    let migrated = [];
    const wasOutdated = Number.isFinite(storedVersion) && storedVersion < SCHEMA_VERSION;
    if (wasOutdated && !readOnly) migrated = migrateSchema(handle, storedVersion);
    // 迁移成功后就不再算 outdated；只有「旧库 + 只读」才把这个标记留给调用方。
    const schemaOutdated = wasOutdated && migrated.length === 0;

    if (!readOnly) {
      handle
        .prepare("INSERT INTO schema_meta (key, value) VALUES ('schemaVersion', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(String(SCHEMA_VERSION));
      handle
        .prepare("INSERT INTO schema_meta (key, value) VALUES ('createdAt', ?) ON CONFLICT(key) DO NOTHING")
        .run(isoNow());
    }

    // 'full' / 'quick' check the file before use; 'skip' trades the guarantee
    // for startup latency and leaves integrityCheckedAt === null as the marker.
    let integrityCheckedAt = null;
    if (integrityMode !== 'skip') {
      const pragma = integrityMode === 'quick' ? 'PRAGMA quick_check' : 'PRAGMA integrity_check';
      const integrityRows = handle.prepare(pragma).all();
      const integrityMessages = integrityRows.map(row => String(Object.values(row)[0] ?? ''));
      const integrityOk = integrityMessages.length === 1 && integrityMessages[0].toLowerCase() === 'ok';
      if (!integrityOk) {
        throw new Error(`记忆数据库完整性校验失败（${integrityMode}）：${truncate(integrityMessages.join('; '), 400)}`);
      }
      integrityCheckedAt = isoNow();
    }

    return new MemoryDatabase(handle, {
      file, readOnly, journalMode, integrityMode, integrityCheckedAt, migrated, schemaOutdated,
    });
  } catch (error) {
    try {
      handle.close();
    } catch {
      // The open failure is the error worth reporting.
    }
    throw error;
  }
}
