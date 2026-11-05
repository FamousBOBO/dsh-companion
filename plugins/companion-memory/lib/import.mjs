/**
 * Legacy memory migration (CONTRACT.md §7).
 *
 * This module only ever *reads* the legacy files:
 *   home/memory/astrbot-import.json      (767 rows exported from the old AstrBot DB)
 *   home/companion/state.json[.previous] (facts confirmed with companion_remember)
 *   home/memory/conversation.jsonl       (desktop conversation journal)
 *   home/companion/identity.json         (bound owner/persona, copied into the backup)
 *
 * It never writes to them. Before the first write to the new store the caller-visible
 * run creates a checksummed copy under `home/memory/backups/<stamp>/`, and the report
 * it produces under `logs/memory-migration-<stamp>.json` contains ids, types, counts
 * and checksums only — never memory text.
 *
 * Idempotency: every memory row gets a `dedupeKey` and every evidence row an
 * `eventKey` derived from the legacy identity (`sourceId` / `id` / fact key), so a
 * second run inserts nothing and only reports `deduped`.
 *
 * The `db` object is injected and must implement the subset of CONTRACT §6 used
 * here: appendEvent, insertMemory, getMemory, getEvent, addEvidence, evidenceFor,
 * listMemories, transaction. Everything else is optional.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  clamp, contentHash, isoNow, parseLocalMoment, redactSecrets, searchText, stableId, truncate,
} from './text.mjs';
import {
  KINDS, MENTION_POLICIES, REALITY_LEVELS, REAL_USER_SCOPES, SCOPES, SOURCE_KINDS, STATUSES,
  defaultImportance, defaultMentionPolicy,
} from './policy.mjs';

/** Bumped whenever the legacy -> new mapping changes shape (CONTRACT §7). */
export const IMPORT_MANIFEST_VERSION = 2;
export const REPORT_SCHEMA = 'memory-migration-report/v2';
export const BACKUP_MANIFEST_SCHEMA = 'memory-migration-backup/v1';

/** Tag carried by every imported row; reconciliation uses it to isolate imports. */
export const IMPORT_TAG = 'migrated:astrbot';
/** Evidence rows written by the migration are role/kind neutral and clearly labelled. */
export const IMPORT_EVIDENCE_ROLE = 'imported';

const ARCHIVE_SOURCE_KIND = 'astrbot_import';
const STATE_SOURCE_KIND = 'desktop_fact';
const CONVERSATION_SOURCE_KIND = 'desktop_conversation';

const VALUE_MAX_CHARS = 1200;
const EVIDENCE_MAX_CHARS = 2000;
const STATE_VALUE_MAX_CHARS = 2000;
/** Imported bot actions must never look important enough to crowd out user facts. */
const BOT_ACTION_IMPORTANCE_CAP = 0.35;
/** LLM tool assertions are inferred knowledge, never a confident fact. */
const INFERRED_CONFIDENCE_CAP = 0.6;
/**
 * Conversation summaries are derived data and are labelled
 * `imported_summary` ("旧库对话摘要（可能有误）"), so they must not outrank
 * confirmed facts. The old archive rated them 0.612–0.9, which filled the
 * "recent + important" recall window even for unrelated queries and took all 40
 * slots of the wiki important-events page, so the import caps them at 0.6.
 */
export const SUMMARY_IMPORTANCE_CAP = 0.6;
const CONVERSATION_IMPORTANCE = 0.25;
const CONVERSATION_REPLY_IMPORTANCE = 0.15;
const CONVERSATION_CONFIDENCE = 0.4;
const MAX_CONVERSATION_RECORDS = 20000;

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
/** Repository root that holds `home/` and `logs/`. */
export const DEFAULT_ROOT = path.resolve(REPO_ROOT);

export const DEFAULT_PATHS = Object.freeze({
  archive: 'home/memory/astrbot-import.json',
  conversation: 'home/memory/conversation.jsonl',
  state: 'home/companion/state.json',
  statePrevious: 'home/companion/state.json.previous',
  identity: 'home/companion/identity.json',
  backups: 'home/memory/backups',
  reports: 'logs',
  database: 'home/memory/companion-memory.db',
});

/**
 * Legacy `memoryType` -> destination shape.
 *
 * - core_memory / user_profile / user_preference / explicit_memory are stable facts
 *   about the real user: `user_global`, realityLevel `imported_fact`.
 * - relationship_claim belongs to the user+persona pair: `user_persona`/`relationship`.
 * - tool_memory is an LLM tool assertion: usable knowledge, realityLevel `inferred`,
 *   confidence capped at 0.6, and it must be echoed softly (see `mentionPolicy`).
 * - conversation_summary is an old conversation summary, not a confirmed user fact:
 *   `user_persona`/`summary`, realityLevel `imported_summary`, importance capped at
 *   0.6 so derived summaries never displace confirmed facts.
 * - proactive_message / photo_generation are things the persona did: `persona_self`
 *   with subject `persona` only. They can never become `user_global` (CONTRACT §7) —
 *   see `assertNoBotActionInUserScopes` / the reconciliation check of the same name.
 *
 * `mentionPolicy` is derived from `policy.defaultMentionPolicy` unless the entry
 * overrides it, so the import cannot drift away from the read path.
 */
const MEMORY_TYPE_MAP = Object.freeze({
  core_memory: {
    scope: 'user_global', kind: 'profile', realityLevel: 'imported_fact', subject: 'user',
  },
  user_profile: {
    scope: 'user_global', kind: 'profile', realityLevel: 'imported_fact', subject: 'user',
  },
  user_preference: {
    scope: 'user_global', kind: 'preference', realityLevel: 'imported_fact', subject: 'user',
  },
  explicit_memory: {
    scope: 'user_global', kind: 'fact', realityLevel: 'imported_fact', subject: 'user',
  },
  relationship_claim: {
    scope: 'user_persona', kind: 'relationship', realityLevel: 'imported_fact', subject: 'user',
  },
  tool_memory: {
    scope: 'user_global', kind: 'preference', realityLevel: 'inferred', subject: 'user',
    // defaultMentionPolicy keys on kind first, so 'preference' would yield 'direct';
    // an inferred tool assertion must stay a soft echo (task board task-2).
    mentionPolicy: 'soft_echo', confidenceCap: INFERRED_CONFIDENCE_CAP,
  },
  conversation_summary: {
    scope: 'user_persona', kind: 'summary', realityLevel: 'imported_summary', subject: 'user',
    // Derived data must stay below confirmed facts (see SUMMARY_IMPORTANCE_CAP).
    importanceCap: SUMMARY_IMPORTANCE_CAP,
  },
  proactive_message: {
    scope: 'persona_self', kind: 'bot_action', realityLevel: 'bot_action', subject: 'persona',
    importanceCap: BOT_ACTION_IMPORTANCE_CAP,
  },
  photo_generation: {
    scope: 'persona_self', kind: 'artifact', realityLevel: 'bot_action', subject: 'persona',
    importanceCap: BOT_ACTION_IMPORTANCE_CAP,
  },
});

/** Legacy types that must never appear in a real-user scope. */
const BOT_ACTION_TYPES = Object.freeze(['proactive_message', 'photo_generation']);

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/** Collapse whitespace and drop control characters that would poison FTS text. */
function cleanText(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fileSha256(file) {
  return sha256(fs.readFileSync(file));
}

/** Numeric field with a fallback for missing values (null/''/NaN are missing). */
function numberOr(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/** `20261027T163912Z`, matching the existing `home/memory/backups/` naming. */
export function formatStamp(clock = Date.now()) {
  const iso = new Date(Number(clock) || 0).toISOString();
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function legacySourceId(row) {
  const explicit = String(row?.sourceId ?? '').trim();
  if (explicit) return explicit;
  const id = String(row?.id ?? '').trim();
  if (!id) return '';
  return id.startsWith('astrbot:') ? id.slice('astrbot:'.length) : id;
}

/** Describe one input file without touching it. */
function describeInput(name, file) {
  const info = { name, path: file ?? '', exists: false, bytes: 0, sha256: '' };
  if (!file) return info;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return info;
    info.exists = true;
    info.bytes = stat.size;
    info.sha256 = fileSha256(file);
  } catch {
    info.exists = false;
  }
  return info;
}

function warningSink() {
  const entries = new Map();
  return {
    add(code, detail, count = 1) {
      const entry = entries.get(code) ?? { code, count: 0, detail: '' };
      entry.count += count;
      if (detail && entry.detail === '') entry.detail = truncate(cleanText(detail), 200);
      entries.set(code, entry);
    },
    list() {
      return [...entries.values()].sort((a, b) => a.code.localeCompare(b.code));
    },
  };
}

// ---------------------------------------------------------------------------
// draft construction
// ---------------------------------------------------------------------------

/**
 * Build a normalised MemoryRecordDraft plus its evidence event. Every field the
 * new store needs is computed here with `lib/text.mjs` so `search_text` uses the
 * exact same tokenisation as the read path (CONTRACT §4).
 */
function makeDraft(spec) {
  const {
    origin, legacyType, dedupeKey, eventKey, scope, kind, subject, predicate,
    value, content = '', confidence, importance, mentionPolicy, status, realityLevel,
    userId, personaId, worldId = '', sourceKind, validTo = null, occurredAt,
    createdAt, updatedAt, tags = [], event,
  } = spec;
  const id = stableId('mem', dedupeKey);
  const evidenceSourceId = stableId('evt', eventKey);
  const recordedAt = occurredAt ?? createdAt ?? isoNow(0);
  return {
    // --- MemoryRecord columns (CONTRACT §3) ---
    id,
    scope,
    kind,
    subject,
    predicate,
    value,
    content,
    confidence: clamp(confidence, 0, 1),
    importance: clamp(importance, 0, 1),
    mentionPolicy,
    status,
    realityLevel,
    userId,
    personaId,
    worldId,
    sourceKind,
    sourceId: evidenceSourceId,
    dedupeKey,
    validFrom: null,
    validTo,
    occurredAt: occurredAt ?? null,
    createdAt: createdAt ?? recordedAt,
    updatedAt: updatedAt ?? createdAt ?? recordedAt,
    revision: 1,
    supersedesId: '',
    tags: [...new Set([IMPORT_TAG, `import:${legacyType}`, ...tags.filter(tag => typeof tag === 'string' && tag)])],
    searchText: searchText(kind, subject, predicate, value, content),
    // --- non-column migration metadata, used by runImport and never inserted ---
    origin,
    legacyType,
    eventKey,
    event: {
      sourceId: evidenceSourceId,
      eventKey,
      sessionId: event?.sessionId ?? '',
      seq: Number.isInteger(event?.seq) ? event.seq : 0,
      role: IMPORT_EVIDENCE_ROLE,
      sourceKind,
      occurredAt: event?.occurredAt ?? recordedAt,
      content: event?.content ?? truncate(value, EVIDENCE_MAX_CHARS),
      userId,
      personaId,
      worldId,
      meta: event?.meta ?? {},
    },
  };
}

function typeMapping(memoryType) {
  return MEMORY_TYPE_MAP[memoryType] ?? null;
}

// ---------------------------------------------------------------------------
// astrbot-import.json -> drafts
// ---------------------------------------------------------------------------

/**
 * Classify one archive row.
 * @returns {{ok: true, draft: object} | {ok: false, reason: string}}
 */
export function classifyArchiveRow(row, options = {}) {
  const { userId, personaId, worldId = '', now = Date.now() } = options;
  if (!isNonEmptyString(userId) || !isNonEmptyString(personaId)) {
    throw new Error('mapArchiveRow 需要 userId 与 personaId');
  }
  if (!row || typeof row !== 'object') return { ok: false, reason: 'invalid_row' };

  const memoryType = String(row.memoryType ?? '').trim();
  const mapping = typeMapping(memoryType);
  if (!mapping) return { ok: false, reason: 'unknown_memory_type' };

  const sourceId = legacySourceId(row);
  if (!sourceId) return { ok: false, reason: 'missing_source_id' };

  // The archive was exported per owner; importing somebody else's rows would leak
  // private memories across users, so mismatches are skipped instead of coerced.
  if (isNonEmptyString(row.owner) && row.owner !== userId) return { ok: false, reason: 'owner_mismatch' };
  if (isNonEmptyString(row.persona) && row.persona !== personaId) return { ok: false, reason: 'persona_mismatch' };

  const rawValue = String(row.value ?? '');
  if (!cleanText(rawValue)) return { ok: false, reason: 'empty_value' };

  const value = truncate(cleanText(redactSecrets(rawValue)), VALUE_MAX_CHARS);
  const occurredAt = parseLocalMoment(row.occurredAt) ?? parseLocalMoment(row.updatedAt) ?? null;
  const legacyUpdatedAt = parseLocalMoment(row.updatedAt) ?? occurredAt;
  // A row whose validity already ended is imported as archived so it can never be
  // recalled as a current fact (CONTRACT §7); the evidence event is kept anyway.
  const validTo = parseLocalMoment(row.validTo);
  const expired = validTo !== null && Date.parse(validTo) <= Number(now);
  const status = expired ? 'archived' : 'confirmed';

  const kind = mapping.kind;
  const realityLevel = mapping.realityLevel;
  const mentionPolicy = mapping.mentionPolicy
    ?? defaultMentionPolicy({ kind, realityLevel, scope: mapping.scope });
  const baseConfidence = clamp(numberOr(row.confidence, 0.7), 0, 1);
  const confidence = mapping.confidenceCap
    ? Math.min(baseConfidence, mapping.confidenceCap)
    : baseConfidence;
  const baseImportance = clamp(numberOr(row.importance, defaultImportance(kind)), 0, 1);
  const importance = mapping.importanceCap
    ? Math.min(baseImportance, mapping.importanceCap)
    : baseImportance;

  const evidenceText = cleanText(row.evidence) || value;
  const draft = makeDraft({
    origin: 'archive',
    legacyType: memoryType,
    // Stable identity: the legacy row id, never the content.
    dedupeKey: `import:astrbot:${sourceId}`,
    eventKey: `astrbot:${sourceId}`,
    scope: mapping.scope,
    kind,
    subject: mapping.subject,
    // Prefixed so a later extractor never collides with a migrated predicate.
    predicate: `import:${memoryType}`,
    value,
    content: '',
    confidence,
    importance,
    mentionPolicy,
    status,
    realityLevel,
    userId,
    personaId,
    worldId,
    sourceKind: ARCHIVE_SOURCE_KIND,
    validTo,
    occurredAt,
    // Keep legacy timestamps: the migration must not rewrite history.
    createdAt: legacyUpdatedAt ?? occurredAt,
    updatedAt: legacyUpdatedAt ?? occurredAt,
    tags: Array.isArray(row.tags) ? row.tags.slice(0, 12) : [],
    event: {
      sessionId: String(row.sourceSession ?? ''),
      occurredAt: occurredAt ?? legacyUpdatedAt ?? null,
      content: truncate(redactSecrets(evidenceText), EVIDENCE_MAX_CHARS),
      meta: {
        legacyId: String(row.id ?? ''),
        legacyType: memoryType,
        legacyRealityLevel: String(row.realityLevel ?? ''),
        legacySayability: String(row.sayability ?? ''),
      },
    },
  });
  return { ok: true, draft };
}

/** CONTRACT §7 entry point: legacy archive row -> MemoryRecordDraft | null. */
export function mapArchiveRow(row, options = {}) {
  const result = classifyArchiveRow(row, options);
  return result.ok ? result.draft : null;
}

// ---------------------------------------------------------------------------
// state.json facts -> drafts
// ---------------------------------------------------------------------------

/**
 * Classify one `state.json` fact. Those facts were written by `companion_remember`,
 * i.e. the user explicitly confirmed them, so they are the only import source that
 * may carry realityLevel `explicit_user_statement`.
 */
export function classifyStateFact(fact, options = {}) {
  const { userId, personaId, worldId = '', now = Date.now() } = options;
  if (!isNonEmptyString(userId) || !isNonEmptyString(personaId)) {
    throw new Error('mapStateFact 需要 userId 与 personaId');
  }
  if (!fact || typeof fact !== 'object') return { ok: false, reason: 'invalid_fact' };

  const key = String(fact.key ?? '').trim();
  if (!key) return { ok: false, reason: 'missing_key' };
  const rawValue = String(fact.value ?? '');
  if (!cleanText(rawValue)) return { ok: false, reason: 'empty_value' };
  if (isNonEmptyString(fact.userId) && fact.userId !== userId) return { ok: false, reason: 'owner_mismatch' };
  if (isNonEmptyString(fact.persona) && fact.persona !== personaId) return { ok: false, reason: 'persona_mismatch' };

  const value = truncate(cleanText(redactSecrets(rawValue)), STATE_VALUE_MAX_CHARS);
  const updatedAt = parseLocalMoment(fact.updatedAt) ?? isoNow(now);
  const kind = 'fact';
  const realityLevel = 'explicit_user_statement';
  const draft = makeDraft({
    origin: 'state',
    legacyType: 'state_fact',
    dedupeKey: `import:state:${userId}:${personaId}:${key}`,
    eventKey: `state:${userId}:${personaId}:${key}`,
    scope: 'user_global',
    kind,
    subject: 'user',
    predicate: `import:state:${key}`,
    value,
    content: '',
    confidence: 0.95,
    importance: defaultImportance(kind),
    mentionPolicy: defaultMentionPolicy({ kind, realityLevel, scope: 'user_global' }),
    status: 'confirmed',
    realityLevel,
    userId,
    personaId,
    worldId,
    sourceKind: STATE_SOURCE_KIND,
    validTo: null,
    occurredAt: updatedAt,
    createdAt: updatedAt,
    updatedAt,
    tags: ['state_fact'],
    event: {
      sessionId: '',
      occurredAt: updatedAt,
      content: truncate(redactSecrets(`${key}: ${rawValue}`), EVIDENCE_MAX_CHARS),
      meta: { legacyKey: key, legacySource: String(fact.source ?? '') },
    },
  });
  return { ok: true, draft };
}

/** CONTRACT §7 entry point: state.json fact -> MemoryRecordDraft. */
export function mapStateFact(fact, options = {}) {
  const result = classifyStateFact(fact, options);
  return result.ok ? result.draft : null;
}

// ---------------------------------------------------------------------------
// conversation.jsonl -> { event, memory }
// ---------------------------------------------------------------------------

/**
 * Classify one desktop conversation record.
 *
 * The journal is the *new* store's own chat history, so it is preserved as evidence
 * and as low-importance continuity rows: a user line is an unverified utterance
 * (`user_utterance_not_verified_fact`, soft echo) and an assistant line is a bot
 * action (`persona_self`). Neither may be promoted to a confirmed user fact.
 */
export function classifyConversationRecord(record, options = {}) {
  const { userId, personaId, now = Date.now() } = options;
  if (!isNonEmptyString(userId) || !isNonEmptyString(personaId)) {
    throw new Error('mapConversationRecord 需要 userId 与 personaId');
  }
  if (!record || typeof record !== 'object') return { ok: false, reason: 'invalid_record' };

  const declaredId = String(record.id ?? '').trim();
  const sessionId = String(record.sessionId ?? '').trim();
  const seq = Number.isInteger(record.seq) ? record.seq : null;
  const role = String(record.role ?? '').trim();
  if (role !== 'user' && role !== 'assistant') return { ok: false, reason: 'unknown_role' };
  const rawText = String(record.text ?? '');
  if (!cleanText(rawText)) return { ok: false, reason: 'empty_text' };
  if (isNonEmptyString(record.userId) && record.userId !== userId) return { ok: false, reason: 'owner_mismatch' };
  if (isNonEmptyString(record.persona) && record.persona !== personaId) return { ok: false, reason: 'persona_mismatch' };

  // Cross-module contract (Lead decision): capture.toSourceEvent stores
  // `eventKey = ${sessionId}:${seq}`, which is exactly the journal `id`. The
  // importer must reuse that key verbatim, otherwise one message would end up as
  // two `source_events` rows and break "repeat/restart never duplicates".
  const captureKey = sessionId && seq !== null ? `${sessionId}:${seq}` : '';
  let eventKey = '';
  let keyWarning = '';
  if (declaredId && declaredId === captureKey) {
    eventKey = declaredId;
  } else if (captureKey) {
    // Journal id and session/seq disagree: prefer the capture-compatible key so
    // the two writers still meet on one row, and flag the inconsistency.
    eventKey = captureKey;
    keyWarning = 'conversation_event_key_derived';
  } else if (declaredId) {
    // No session/seq at all: keep a unique key, clearly namespaced, and report it.
    eventKey = `conversation:${declaredId}`;
    keyWarning = 'conversation_event_key_prefixed';
  } else {
    return { ok: false, reason: 'missing_event_key' };
  }

  const text = truncate(cleanText(redactSecrets(rawText)), VALUE_MAX_CHARS);
  const occurredAt = parseLocalMoment(record.at) ?? isoNow(now);
  const isUser = role === 'user';
  const kind = isUser ? 'event' : 'bot_action';
  const realityLevel = isUser ? 'user_utterance_not_verified_fact' : 'bot_action';
  const scope = isUser ? 'user_persona' : 'persona_self';
  // defaultMentionPolicy keys on kind first, so an 'event' would be 'direct'; a
  // raw utterance is not a confirmed fact and must stay a soft echo (CONTRACT §7).
  const mentionPolicy = isUser
    ? 'soft_echo'
    : defaultMentionPolicy({ kind, realityLevel, scope });
  const draft = makeDraft({
    origin: 'conversation',
    legacyType: isUser ? 'conversation_user' : 'conversation_assistant',
    dedupeKey: `import:conversation:${eventKey}`,
    eventKey,
    scope,
    kind,
    subject: isUser ? 'user' : 'persona',
    predicate: isUser ? 'import:conversation_record' : 'import:conversation_reply',
    value: text,
    content: '',
    confidence: CONVERSATION_CONFIDENCE,
    importance: isUser ? CONVERSATION_IMPORTANCE : CONVERSATION_REPLY_IMPORTANCE,
    mentionPolicy,
    status: 'confirmed',
    realityLevel,
    userId,
    personaId,
    worldId: '',
    sourceKind: CONVERSATION_SOURCE_KIND,
    validTo: null,
    occurredAt,
    createdAt: occurredAt,
    updatedAt: occurredAt,
    tags: ['conversation_record'],
    event: {
      sessionId,
      seq: seq ?? 0,
      occurredAt,
      content: truncate(redactSecrets(String(rawText)), EVIDENCE_MAX_CHARS),
      meta: { legacyId: declaredId || eventKey, legacySource: String(record.source ?? '') },
    },
  });
  return { ok: true, result: { event: draft.event, memory: draft }, warning: keyWarning };
}

/** CONTRACT §7 entry point: conversation record -> { event, memory } | null. */
export function mapConversationRecord(record, options = {}) {
  const result = classifyConversationRecord(record, options);
  return result.ok ? result.result : null;
}

// ---------------------------------------------------------------------------
// read-only input loading
// ---------------------------------------------------------------------------

/**
 * Read and validate `astrbot-import.json`. Never writes.
 * @returns {{input: object, ok: boolean, reason: string, manifest: object|null, memories: object[]}}
 */
export function readArchive({ file, userId }) {
  const input = describeInput('archive', file);
  if (!input.exists) return { input, ok: false, reason: 'archive_missing', manifest: null, memories: [] };
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { input, ok: false, reason: 'archive_invalid_json', manifest: null, memories: [] };
  }
  const manifest = data && typeof data === 'object' && data.manifest && typeof data.manifest === 'object'
    ? data.manifest : null;
  const memories = data && Array.isArray(data.memories) ? data.memories : null;
  if (!manifest || !memories) {
    return { input, ok: false, reason: 'archive_invalid_shape', manifest, memories: memories ?? [] };
  }
  if (manifest.schemaVersion !== 1) {
    return { input, ok: false, reason: 'archive_manifest_schema', manifest, memories };
  }
  if (isNonEmptyString(manifest.owner) && manifest.owner !== userId) {
    return { input, ok: false, reason: 'archive_owner_mismatch', manifest, memories };
  }
  return { input, ok: true, reason: '', manifest, memories };
}

/**
 * Read `state.json`, falling back to `state.json.previous` when the live file is
 * missing or unreadable. A broken live file is reported, never overwritten.
 */
export function readLegacyState({ file, previousFile, userId }) {
  const inputs = [];
  const candidates = [];
  if (file && fs.existsSync(file)) candidates.push({ label: 'state', file });
  if (previousFile && fs.existsSync(previousFile)) candidates.push({ label: 'state.previous', file: previousFile });
  for (const candidate of candidates) {
    inputs.push(describeInput(candidate.label, candidate.file));
    try {
      const state = JSON.parse(fs.readFileSync(candidate.file, 'utf8'));
      const valid = state && state.schemaVersion === 1 && state.memories
        && typeof state.memories === 'object' && !Array.isArray(state.memories);
      if (!valid) throw new Error('invalid companion state shape');
      const usedPrevious = candidate.label !== 'state';
      return {
        ok: true,
        reason: usedPrevious ? 'state_previous_used' : '',
        state,
        file: candidate.file,
        usedPrevious,
        inputs,
      };
    } catch (error) {
      inputs[inputs.length - 1].error = truncate(cleanText(error?.message), 120);
    }
  }
  return {
    ok: false,
    reason: candidates.length ? 'state_invalid' : 'state_missing',
    state: null,
    file: '',
    usedPrevious: false,
    inputs,
  };
}

/** Read the JSONL conversation journal as `{index, record}` pairs. */
export function readConversationJournal({ file }) {
  const input = describeInput('conversation', file);
  const records = [];
  const result = { input, ok: input.exists, reason: '', records, invalidLines: 0, truncated: false };
  if (!input.exists) {
    result.reason = 'conversation_missing';
    return result;
  }
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      records.push({ index, record: JSON.parse(line) });
    } catch {
      result.invalidLines += 1;
    }
    if (records.length >= MAX_CONVERSATION_RECORDS) {
      result.truncated = true;
      break;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// backup
// ---------------------------------------------------------------------------

function uniqueBackupDir(baseDir) {
  if (!fs.existsSync(baseDir)) return baseDir;
  for (let index = 2; index < 100; index++) {
    const candidate = `${baseDir}-${index}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`无法创建备份目录：${baseDir} 已存在且序号用尽`);
}

/** Never overwrite an existing report: two runs in one second get a suffix. */
function uniqueFilePath(file) {
  if (!fs.existsSync(file)) return file;
  const extension = path.extname(file);
  const base = file.slice(0, file.length - extension.length);
  for (let index = 2; index < 100; index++) {
    const candidate = `${base}-${index}${extension}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`无法写入报告：${file} 已存在且序号用尽`);
}

/**
 * Copy the legacy inputs into `home/memory/backups/<stamp>/` and write a sha256
 * manifest. Must run before any write to the new store, and never modifies the
 * sources. Returns the directory plus per-file checksums.
 */
export function createBackup({ root = DEFAULT_ROOT, clock = Date.now(), files = [], backupsRoot, identity = {}, mode = 'apply' }) {
  const stamp = formatStamp(clock);
  const base = backupsRoot ?? path.join(root, DEFAULT_PATHS.backups, stamp);
  const dir = uniqueBackupDir(base);
  fs.mkdirSync(dir, { recursive: true });
  const copied = [];
  for (const entry of files) {
    if (!entry || !entry.file) continue;
    const target = path.join(dir, entry.name);
    const record = {
      name: entry.name,
      source: path.resolve(entry.file),
      target,
      exists: false,
      bytes: 0,
      sha256: '',
      sourceSha256: '',
      verified: false,
    };
    try {
      const stat = fs.statSync(entry.file);
      if (!stat.isFile()) throw new Error('not a regular file');
      record.sourceSha256 = fileSha256(entry.file);
      fs.copyFileSync(entry.file, target);
      record.exists = true;
      record.bytes = fs.statSync(target).size;
      record.sha256 = fileSha256(target);
      record.verified = record.sha256 === record.sourceSha256 && record.bytes === stat.size;
    } catch (error) {
      record.error = truncate(cleanText(error?.message), 160);
    }
    copied.push(record);
  }
  const manifest = {
    schema: BACKUP_MANIFEST_SCHEMA,
    stamp,
    createdAt: isoNow(clock),
    mode,
    root: path.resolve(root),
    identity: { userId: identity.userId ?? '', personaId: identity.personaId ?? '', worldId: identity.worldId ?? '' },
    note: '迁移前只读快照：原始 home/ 文件未被修改，本目录为副本与校验记录。',
    files: copied,
    inputsSha256: contentHash(copied.map(record => `${record.name}:${record.sourceSha256}`).join('\n')),
  };
  const manifestPath = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { dir, manifestPath, manifest };
}

// ---------------------------------------------------------------------------
// aggregation
// ---------------------------------------------------------------------------

function bump(target, key, count = 1) {
  target[key] = (target[key] ?? 0) + count;
}

/** Counts by legacy type / scope / kind / status / reality / mention policy. */
export function aggregateDrafts(drafts) {
  const byMemoryType = {};
  const byScope = {};
  const byKind = {};
  const byStatus = {};
  const byRealityLevel = {};
  const byMentionPolicy = {};
  for (const draft of drafts) {
    const slot = byMemoryType[draft.legacyType] ?? (byMemoryType[draft.legacyType] = {
      count: 0,
      scope: draft.scope,
      kind: draft.kind,
      realityLevel: draft.realityLevel,
      mentionPolicy: draft.mentionPolicy,
      statuses: {},
    });
    slot.count += 1;
    bump(slot.statuses, draft.status);
    bump(byScope, draft.scope);
    bump(byKind, draft.kind);
    bump(byStatus, draft.status);
    bump(byRealityLevel, draft.realityLevel);
    bump(byMentionPolicy, draft.mentionPolicy);
  }
  return {
    total: drafts.length,
    byMemoryType,
    byScope,
    byKind,
    byStatus,
    byRealityLevel,
    byMentionPolicy,
  };
}

// ---------------------------------------------------------------------------
// runImport
// ---------------------------------------------------------------------------

function sortObject(value) {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}

function insertPayload(draft, sourceId) {
  return {
    id: draft.id,
    scope: draft.scope,
    kind: draft.kind,
    subject: draft.subject,
    predicate: draft.predicate,
    value: draft.value,
    content: draft.content,
    confidence: draft.confidence,
    importance: draft.importance,
    mentionPolicy: draft.mentionPolicy,
    status: draft.status,
    realityLevel: draft.realityLevel,
    userId: draft.userId,
    personaId: draft.personaId,
    worldId: draft.worldId,
    sourceKind: draft.sourceKind,
    sourceId,
    dedupeKey: draft.dedupeKey,
    validFrom: draft.validFrom,
    validTo: draft.validTo,
    occurredAt: draft.occurredAt,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
    revision: 1,
    supersedesId: '',
    tags: draft.tags,
    searchText: draft.searchText,
  };
}

function eventPayload(draft, { userId, personaId }) {
  return {
    sourceId: draft.event.sourceId,
    eventKey: draft.event.eventKey,
    sessionId: draft.event.sessionId ?? '',
    seq: Number.isInteger(draft.event.seq) ? draft.event.seq : 0,
    role: IMPORT_EVIDENCE_ROLE,
    sourceKind: draft.event.sourceKind,
    occurredAt: draft.event.occurredAt,
    content: draft.event.content,
    userId,
    personaId,
    worldId: draft.worldId ?? '',
    meta: draft.event.meta ?? {},
  };
}

function draftViolation(draft) {
  if (!SCOPES.includes(draft.scope)) return 'scope';
  if (!KINDS.includes(draft.kind)) return 'kind';
  if (!MENTION_POLICIES.includes(draft.mentionPolicy)) return 'mentionPolicy';
  if (!STATUSES.includes(draft.status)) return 'status';
  if (!REALITY_LEVELS.includes(draft.realityLevel)) return 'realityLevel';
  if (!SOURCE_KINDS.includes(draft.sourceKind)) return 'sourceKind';
  if (!isNonEmptyString(draft.dedupeKey)) return 'dedupeKey';
  if (!isNonEmptyString(draft.value)) return 'value';
  if (!isNonEmptyString(draft.eventKey)) return 'eventKey';
  return null;
}

/**
 * Fields a migration refresh is allowed to repair on an existing row. Identity
 * (id/dedupeKey/value/occurredAt/subject/predicate/scope/owner) is never touched:
 * a refresh only re-aligns the derived classification with the current mapping.
 */
const REFRESH_FIELDS = Object.freeze(['importance', 'mentionPolicy', 'status']);
const REFRESH_REASON = 'migration-refresh';

/** Patch for an existing row whose mapped classification drifted; {} when clean. */
function refreshPatch(draft, existing) {
  if (!existing) return {};
  const patch = {};
  if (Math.abs(Number(existing.importance ?? 0) - draft.importance) > 1e-9) {
    patch.importance = draft.importance;
  }
  if ((existing.mentionPolicy ?? '') !== draft.mentionPolicy) patch.mentionPolicy = draft.mentionPolicy;
  if ((existing.status ?? '') !== draft.status) patch.status = draft.status;
  return patch;
}

/**
 * Migrate the legacy files into the injected store.
 *
 * @param {object} options
 * @param {object} options.db MemoryDatabase (CONTRACT §6); writes only when not dryRun
 * @param {string} options.root repository root holding `home/` and `logs/`
 * @param {string} options.userId owner id (e.g. the bound desktop user)
 * @param {string} options.personaId persona id (e.g. 'bot')
 * @param {boolean} [options.dryRun] read-only rehearsal: no backup, no db write
 * @param {number} [options.clock] epoch ms used for the stamp and expiry decisions
 * @param {boolean} [options.refresh] also repair existing rows whose mapped
 *   importance/mentionPolicy/status drifted (idempotent; counted in
 *   `report.totals.refreshed`). Without it the run is "0 new, 0 changes".
 * @returns {Promise<{report: object, inserted: number, deduped: number, skipped: number,
 *   reportPath: string, backupDir: string}>}
 */
export async function runImport(options = {}) {
  const {
    root = DEFAULT_ROOT,
    db,
    userId,
    personaId,
    dryRun = false,
    clock = Date.now(),
    now = clock,
    worldId = '',
    refresh = false,
    archivePath,
    conversationPath,
    statePath,
    statePreviousPath,
    identityPath,
    backupsRoot,
    reportPath,
    backup,
    writeReport,
    manifestVersion = IMPORT_MANIFEST_VERSION,
  } = options;

  if (!isNonEmptyString(userId)) throw new Error('runImport 需要 userId');
  if (!isNonEmptyString(personaId)) throw new Error('runImport 需要 personaId');
  if (!dryRun) {
    const usable = db && typeof db.insertMemory === 'function' && typeof db.appendEvent === 'function';
    if (!usable) throw new Error('runImport 需要 CONTRACT §6 的 db 对象（insertMemory/appendEvent）');
  }

  const resolvedRoot = path.resolve(root);
  const stamp = formatStamp(clock);
  const archiveFile = archivePath ?? path.join(resolvedRoot, DEFAULT_PATHS.archive);
  const conversationFile = conversationPath ?? path.join(resolvedRoot, DEFAULT_PATHS.conversation);
  const legacyStateFile = statePath ?? path.join(resolvedRoot, DEFAULT_PATHS.state);
  const legacyStatePrevious = statePreviousPath ?? path.join(resolvedRoot, DEFAULT_PATHS.statePrevious);
  const identityFile = identityPath ?? path.join(resolvedRoot, DEFAULT_PATHS.identity);
  const warnings = warningSink();

  // ---- 1. read the legacy inputs (never written) ----
  const archive = readArchive({ file: archiveFile, userId });
  if (!archive.ok) warnings.add(archive.reason, archive.input.path);
  const stateResult = readLegacyState({ file: legacyStateFile, previousFile: legacyStatePrevious, userId });
  if (!stateResult.ok) warnings.add(stateResult.reason, legacyStateFile);
  else if (stateResult.usedPrevious) warnings.add(stateResult.reason, stateResult.file);
  const conversation = readConversationJournal({ file: conversationFile, userId });
  if (!conversation.ok) warnings.add(conversation.reason, conversationFile);
  if (conversation.invalidLines) warnings.add('conversation_invalid_lines', 'JSONL', conversation.invalidLines);
  if (conversation.truncated) warnings.add('conversation_truncated', `>${MAX_CONVERSATION_RECORDS} lines`);
  const identityInput = describeInput('identity', identityFile);

  // ---- 2. map everything before the first write ----
  const drafts = [];
  const origins = {
    archive: { rows: archive.memories.length, mapped: 0, skipped: 0 },
    state: { rows: 0, mapped: 0, skipped: 0 },
    conversation: { rows: conversation.records.length, mapped: 0, skipped: 0 },
  };
  const skippedByReason = {};
  const skip = (origin, reason) => {
    origins[origin].skipped += 1;
    bump(skippedByReason, `${origin}_${reason}`);
  };

  if (!archive.ok) {
    // Whole-archive failure (missing file, bad JSON, foreign owner): map nothing,
    // but account for every declared row so reconciliation stays honest.
    if (archive.memories.length) {
      origins.archive.skipped = archive.memories.length;
      bump(skippedByReason, archive.reason, archive.memories.length);
    }
  } else {
    for (const row of archive.memories) {
      const result = classifyArchiveRow(row, { userId, personaId, worldId, now });
      if (!result.ok) {
        skip('archive', result.reason);
        continue;
      }
      drafts.push(result.draft);
      origins.archive.mapped += 1;
    }
  }

  const stateFacts = stateResult.ok ? Object.entries(stateResult.state.memories) : [];
  origins.state.rows = stateFacts.length;
  for (const [key, rawFact] of stateFacts) {
    const fact = rawFact && typeof rawFact === 'object' ? { key, ...rawFact } : { key, value: rawFact };
    const result = classifyStateFact(fact, { userId, personaId, worldId, now });
    if (!result.ok) {
      skip('state', result.reason);
      continue;
    }
    drafts.push(result.draft);
    origins.state.mapped += 1;
  }

  for (const entry of conversation.records) {
    const result = classifyConversationRecord(entry.record, { userId, personaId, now });
    if (!result.ok) {
      skip('conversation', result.reason);
      continue;
    }
    if (result.warning) warnings.add(result.warning, `journal#${entry.index}`);
    drafts.push(result.result.memory);
    origins.conversation.mapped += 1;
  }

  // Defensive: never write a row whose enum fields would trip the read path.
  const validDrafts = [];
  for (const draft of drafts) {
    const violation = draftViolation(draft);
    if (violation) {
      skip(draft.origin, `invalid_${violation}`);
      continue;
    }
    validDrafts.push(draft);
  }

  const totals = {
    candidates: validDrafts.length,
    inserted: 0,
    deduped: 0,
    skipped: Object.values(skippedByReason).reduce((sum, value) => sum + value, 0),
    eventsInserted: 0,
    eventsDeduped: 0,
    evidenceLinked: 0,
    evidenceExisting: 0,
    evidenceFailed: 0,
    // Rows whose mapped classification was repaired by `refresh: true`.
    refreshed: 0,
    refreshFailed: 0,
  };

  // ---- 3. backup before the first write ----
  // Default: back up whenever the run may write. An explicit `backup: true`
  // also snapshots the inputs during a dry run (backup-only rehearsal).
  const shouldBackup = backup === undefined ? !dryRun : Boolean(backup);
  let backupInfo = null;
  if (shouldBackup) {
    backupInfo = createBackup({
      root: resolvedRoot,
      clock,
      backupsRoot,
      mode: dryRun ? 'dry_run' : 'apply',
      identity: { userId, personaId, worldId },
      files: [
        { name: 'astrbot-import.json', file: archiveFile },
        { name: 'conversation.jsonl', file: conversationFile },
        { name: 'state.json', file: stateResult.ok ? stateResult.file : legacyStateFile },
        { name: 'identity.json', file: identityFile },
      ],
    });
    const broken = backupInfo.manifest.files.filter(record => record.exists && !record.verified);
    if (broken.length) {
      throw new Error(`备份校验失败，已中止导入：${broken.map(record => record.name).join('、')}`);
    }
    if (!backupInfo.manifest.files.some(record => record.name === 'astrbot-import.json' && record.exists)) {
      throw new Error('备份缺少 astrbot-import.json，已中止导入');
    }
  } else if (!dryRun) {
    warnings.add('backup_skipped');
  }

  // ---- 4. write evidence + memory + evidence link per draft ----
  const applyOne = (draft) => {
    const event = eventPayload(draft, { userId, personaId });
    let sourceId = event.sourceId;
    if (typeof db.appendEvent === 'function') {
      const appended = db.appendEvent(event) ?? {};
      if (appended.inserted) totals.eventsInserted += 1;
      else totals.eventsDeduped += 1;
      if (isNonEmptyString(appended.sourceId)) sourceId = appended.sourceId;
    }
    const result = db.insertMemory(insertPayload(draft, sourceId)) ?? {};
    let record = result.record ?? null;
    if (result.inserted) totals.inserted += 1;
    else totals.deduped += 1;
    if (!record || !isNonEmptyString(record.id)) {
      warnings.add('insert_no_record', draft.legacyType);
      return;
    }
    // Refresh mode: repair an existing row whose mapped classification drifted
    // (e.g. summaries imported before the 0.6 cap). Identity fields stay untouched.
    if (!result.inserted && refresh && typeof db.updateMemory === 'function') {
      const patch = refreshPatch(draft, record);
      if (Object.keys(patch).length) {
        try {
          record = db.updateMemory(record.id, patch, { reason: REFRESH_REASON });
          totals.refreshed += 1;
        } catch (error) {
          totals.refreshFailed += 1;
          warnings.add('refresh_failed', error?.message);
        }
      }
    }
    if (typeof db.addEvidence === 'function') {
      // Evidence links are immutable and keyed by (memory_id, source_id): a repeat
      // run must not rewrite them, so an existing link is counted and skipped.
      let alreadyLinked = false;
      if (typeof db.evidenceFor === 'function') {
        try {
          const existing = db.evidenceFor(record.id);
          alreadyLinked = Array.isArray(existing) && existing.some(item => item?.sourceId === sourceId);
        } catch {
          alreadyLinked = false;
        }
      }
      if (alreadyLinked) {
        totals.evidenceExisting += 1;
      } else {
        try {
          db.addEvidence(record.id, sourceId, {
            evidenceKind: 'supports',
            confidence: clamp(draft.confidence, 0, 1),
          });
          totals.evidenceLinked += 1;
        } catch (error) {
          totals.evidenceFailed += 1;
          warnings.add('evidence_link_failed', error?.message);
        }
      }
    }
  };

  const previewOne = (draft) => {
    const store = db ?? {};
    const existingMemory = typeof store.getMemory === 'function' ? store.getMemory(draft.id) : null;
    const existingEvent = typeof store.getEvent === 'function' ? store.getEvent(draft.event.sourceId) : null;
    if (existingMemory) {
      totals.deduped += 1;
      // Rehearse refresh as well: how many rows would --refresh repair?
      if (refresh && Object.keys(refreshPatch(draft, existingMemory)).length) totals.refreshed += 1;
    } else {
      totals.inserted += 1;
    }
    if (!existingEvent) totals.eventsInserted += 1;
    else totals.eventsDeduped += 1;
  };

  if (dryRun) {
    for (const draft of validDrafts) previewOne(draft);
  } else {
    const applyAll = () => {
      for (const draft of validDrafts) applyOne(draft);
    };
    if (typeof db.transaction === 'function') db.transaction(applyAll);
    else applyAll();
  }

  // ---- 5. report (ids, types, counts, checksums only) ----
  const aggregation = aggregateDrafts(validDrafts);
  const memoryIds = validDrafts.map(draft => draft.id).sort();
  const eventKeys = validDrafts.map(draft => draft.eventKey).sort();
  // Always describe the nominal state path so the report shows its absence too.
  const stateInputs = stateResult.inputs.length
    ? stateResult.inputs
    : [describeInput('state', legacyStateFile)];
  const inputList = [archive.input, ...stateInputs, conversation.input, identityInput];
  const report = {
    schema: REPORT_SCHEMA,
    manifestVersion,
    stamp,
    generatedAt: isoNow(clock),
    mode: dryRun ? 'dry_run' : 'apply',
    refresh: Boolean(refresh),
    root: resolvedRoot,
    identity: { userId, personaId, worldId },
    inputs: inputList,
    archive: archive.manifest
      ? {
        schemaVersion: archive.manifest.schemaVersion ?? null,
        exportedAt: archive.manifest.exportedAt ?? null,
        owner: archive.manifest.owner ?? '',
        persona: archive.manifest.persona ?? '',
        sourceCount: archive.manifest.sourceCount ?? null,
        importedCount: archive.manifest.importedCount ?? null,
        memoryTypes: sortObject(archive.manifest.memoryTypes ?? {}),
        manifestSha256: archive.input.sha256,
      }
      : null,
    origins,
    totals,
    byMemoryType: aggregation.byMemoryType,
    byScope: sortObject(aggregation.byScope),
    byKind: sortObject(aggregation.byKind),
    byStatus: sortObject(aggregation.byStatus),
    byRealityLevel: sortObject(aggregation.byRealityLevel),
    byMentionPolicy: sortObject(aggregation.byMentionPolicy),
    skippedByReason: sortObject(skippedByReason),
    memoryIds,
    eventKeys,
    checksums: {
      memoryIds: contentHash(memoryIds.join('\n')),
      eventKeys: contentHash(eventKeys.join('\n')),
      inputs: contentHash(inputList.map(input => `${input.name}:${input.sha256}`).join('\n')),
    },
    backup: backupInfo
      ? {
        dir: backupInfo.dir,
        manifestPath: backupInfo.manifestPath,
        files: backupInfo.manifest.files.map(record => ({
          name: record.name, exists: record.exists, bytes: record.bytes, sha256: record.sha256, verified: record.verified,
        })),
      }
      : null,
    warnings: warnings.list(),
    reconciliation: null,
  };

  // ---- 6. reconcile against the store ----
  report.reconciliation = reconciliation({ archive: archive.ok ? archive : null, db, report });

  // ---- 7. persist the report (no memory text) ----
  const shouldWriteReport = writeReport ?? !dryRun;
  let writtenReportPath = '';
  if (shouldWriteReport) {
    writtenReportPath = reportPath
      ? path.resolve(reportPath)
      : uniqueFilePath(path.join(resolvedRoot, DEFAULT_PATHS.reports, `memory-migration-${stamp}.json`));
    report.reportPath = writtenReportPath;
    fs.mkdirSync(path.dirname(writtenReportPath), { recursive: true });
    fs.writeFileSync(writtenReportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }

  return {
    report,
    inserted: totals.inserted,
    deduped: totals.deduped,
    skipped: totals.skipped,
    reportPath: writtenReportPath,
    backupDir: backupInfo?.dir ?? '',
  };
}

// ---------------------------------------------------------------------------
// reconciliation
// ---------------------------------------------------------------------------

function readImportedRows(db, { userId, personaId }) {
  if (!db || typeof db.listMemories !== 'function') return null;
  const seen = new Map();
  const pageSize = 500;
  // Paged, and queried twice: with the default status filter and with
  // status='archived'. A store that hides inactive rows by default is then still
  // fully reconciled.
  const collect = (extra) => {
    let offset = 0;
    for (let page = 0; page < 200; page++) {
      let rows;
      try {
        rows = db.listMemories({ userId, personaId, includeExpired: true, limit: pageSize, offset, ...extra });
      } catch {
        return;
      }
      if (!Array.isArray(rows) || rows.length === 0) return;
      const before = seen.size;
      for (const row of rows) if (row && isNonEmptyString(row.id)) seen.set(row.id, row);
      if (rows.length < pageSize || seen.size === before) return;
      offset += rows.length;
    }
  };
  collect({});
  collect({ status: 'archived' });
  return [...seen.values()].filter(row => Array.isArray(row.tags) && row.tags.includes(IMPORT_TAG));
}

function tagsFor(row) {
  return Array.isArray(row.tags) ? row.tags : [];
}

function legacyTypeOfRow(row) {
  for (const tag of tagsFor(row)) {
    if (tag === IMPORT_TAG) continue;
    if (typeof tag === 'string' && tag.startsWith('import:')) return tag.slice('import:'.length);
  }
  return '';
}

/**
 * Human readable reconciliation between the legacy archive and the new store.
 *
 * The report drives the expectations (it was produced by the same mapping), the
 * store drives the actuals. When no store rows are available (dry run) only the
 * report-side checks run and `mode` says so.
 *
 * @returns {{ok: boolean|null, mode: string, checks: object[], summary: object, summaryText: string[]}}
 */
export function reconciliation({ archive = null, db = null, report = null } = {}) {
  if (!report) throw new Error('reconciliation 需要 runImport 产出的 report');
  const checks = [];
  // Canonical comparison: check results must not depend on key insertion order.
  const canonical = (value) => JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
  });
  const add = (name, expected, actual, detail = '') => {
    const ok = canonical(expected) === canonical(actual);
    checks.push({ name, ok, expected, actual, ...(detail ? { detail } : {}) });
    return ok;
  };
  const expectedCounts = report.byMemoryType ?? {};
  const totals = report.totals ?? {};

  // --- report-only checks (also valid for a dry run) ---
  add(
    'candidates_accounted',
    totals.candidates,
    (totals.inserted ?? 0) + (totals.deduped ?? 0),
    '每条候选都必须落在 inserted 或 deduped',
  );
  add(
    'archive_rows_accounted',
    archive ? archive.memories.length : (report.origins?.archive?.rows ?? 0),
    (report.origins?.archive?.mapped ?? 0) + (report.origins?.archive?.skipped ?? 0),
    '旧档案每一行都必须有归属（映射或跳过原因）',
  );
  if (report.archive && report.archive.importedCount != null) {
    add(
      'archive_imported_all',
      report.archive.importedCount,
      report.origins?.archive?.mapped ?? 0,
      '清单声明的导入条数必须全部映射（归属不符或档案损坏会在此暴露）',
    );
  }
  if (archive?.manifest?.memoryTypes) {
    const expectedTypes = sortObject(archive.manifest.memoryTypes);
    const actualTypes = {};
    for (const [type, slot] of Object.entries(expectedCounts)) {
      if (Object.hasOwn(expectedTypes, type)) actualTypes[type] = slot.count;
    }
    add('archive_manifest_type_counts', expectedTypes, sortObject(actualTypes), '清单 memoryType 计数必须与映射一致');
  }
  const dupIds = report.memoryIds.length - new Set(report.memoryIds).size;
  add('stable_ids_unique', 0, dupIds, 'dedupeKey 派生的 id 不得重复');
  const dupEventKeys = report.eventKeys.length - new Set(report.eventKeys).size;
  add('event_keys_unique', 0, dupEventKeys, 'eventKey 不得重复');
  const botInReal = Object.entries(expectedCounts)
    .filter(([type]) => BOT_ACTION_TYPES.includes(type))
    .reduce((sum, [, slot]) => sum + (REAL_USER_SCOPES.has(slot.scope) ? slot.count : 0), 0);
  add('bot_action_not_in_user_scope', 0, botInReal, '主动消息/生图不得进入 user_global 等现实作用域');

  const summary = {
    total: totals.candidates ?? 0,
    byMemoryType: Object.fromEntries(Object.entries(expectedCounts).map(([type, slot]) => [type, slot.count])),
    byScope: report.byScope ?? {},
    archived: report.byStatus?.archived ?? 0,
    duplicates: 0,
    // Evidence bookkeeping: new links, links that already existed (repeat run) and
    // failures. A healthy second run is linked=0 / existing=candidates / failed=0.
    evidence: {
      linked: totals.evidenceLinked ?? 0,
      existing: totals.evidenceExisting ?? 0,
      failed: totals.evidenceFailed ?? 0,
    },
  };

  // --- store checks (skipped for a dry run) ---
  const rows = report.mode === 'dry_run' ? null : readImportedRows(db, report.identity ?? {});
  let mode = 'report_only';
  if (rows) {
    mode = 'store';
    const importedByType = {};
    const importedByScope = {};
    const importedByStatus = {};
    for (const row of rows) {
      bump(importedByType, legacyTypeOfRow(row));
      bump(importedByScope, row.scope);
      bump(importedByStatus, row.status);
    }
    summary.total = rows.length;
    summary.byMemoryType = sortObject(importedByType);
    summary.byScope = sortObject(importedByScope);
    summary.archived = rows.filter(row => row.status === 'archived').length;
    summary.duplicates = rows.length - new Set(rows.map(row => row.dedupeKey)).size;

    add('store_total', totals.candidates ?? 0, rows.length, '新库导入行数必须等于候选数');
    add(
      'store_by_memory_type',
      Object.fromEntries(Object.entries(expectedCounts).map(([type, slot]) => [type, slot.count])),
      sortObject(importedByType),
      '按旧 memoryType 的计数必须一致',
    );
    add(
      'store_by_scope',
      sortObject(report.byScope ?? {}),
      sortObject(importedByScope),
      '按作用域的计数必须一致',
    );
    add(
      'store_archived',
      report.byStatus?.archived ?? 0,
      rows.filter(row => row.status === 'archived').length,
      '过期记录必须保持 archived',
    );
    add(
      'store_duplicates',
      0,
      rows.length - new Set(rows.map(row => row.dedupeKey)).size,
      '新库不得出现重复 dedupeKey',
    );
    add(
      'store_ownership',
      rows.length,
      rows.filter(row => row.userId === report.identity?.userId
        && row.personaId === report.identity?.personaId
        && (row.worldId ?? '') === (report.identity?.worldId ?? '')).length,
      '所有导入行必须归属当前 user/persona/world',
    );
    add(
      'store_bot_action_not_in_user_scope',
      0,
      rows.filter(row => BOT_ACTION_TYPES.includes(legacyTypeOfRow(row)) && REAL_USER_SCOPES.has(row.scope)).length,
      '主动消息/生图行不得出现在现实作用域',
    );
    const reportedIds = new Set(report.memoryIds ?? []);
    add(
      'store_ids_present',
      reportedIds.size,
      rows.filter(row => reportedIds.has(row.id)).length,
      '稳定 id 必须与报告一致',
    );
    // Derived summaries must never outrank confirmed facts in importance-sorted
    // recall windows or on the wiki important-events page.
    const overImportantSummaries = rows.filter(
      row => row.kind === 'summary' && Number(row.importance) > SUMMARY_IMPORTANCE_CAP + 1e-9,
    ).length;
    summary.importanceCapViolations = overImportantSummaries;
    add(
      'store_importance_within_bounds',
      0,
      overImportantSummaries,
      `summary 的 importance 必须 ≤ ${SUMMARY_IMPORTANCE_CAP}（派生数据不得压过已确认事实）`,
    );
    if (typeof db?.evidenceFor === 'function') {
      let withEvidence = 0;
      for (const row of rows) {
        try {
          const evidence = db.evidenceFor(row.id);
          if (Array.isArray(evidence) && evidence.length > 0) withEvidence += 1;
        } catch {
          // A missing evidence query must not break reconciliation; it is reported.
        }
      }
      add('store_evidence_linked', rows.length, withEvidence, '每条导入记忆都必须有 source_events 证据');
      add(
        'store_evidence_accounted',
        totals.candidates ?? 0,
        (totals.evidenceLinked ?? 0) + (totals.evidenceExisting ?? 0),
        '证据关联必须全部落在“新写入”或“已存在”上（幂等跳过不重复写）',
      );
    }
  }

  const summaryText = [];
  summaryText.push(`导入总数 ${summary.total} 条；按类型 ${Object.entries(summary.byMemoryType).map(([type, count]) => `${type}=${count}`).join('、') || '无'}`);
  summaryText.push(`按作用域 ${Object.entries(summary.byScope).map(([scope, count]) => `${scope}=${count}`).join('、') || '无'}；archived ${summary.archived} 条；重复 dedupeKey ${summary.duplicates} 条`);
  if (mode === 'store') {
    summaryText.push(`证据关联 新写入 ${summary.evidence.linked} 条、已存在 ${summary.evidence.existing} 条、失败 ${summary.evidence.failed} 条`);
    summaryText.push(`摘要 importance 上限校验：越界 ${summary.importanceCapViolations ?? 0} 条（上限 ${SUMMARY_IMPORTANCE_CAP}）`);
  } else {
    summaryText.push('证据关联与摘要 importance 上限：演练未检查已有行（--refresh 会在此模式外实际校验）');
  }
  const failed = checks.filter(check => !check.ok);
  summaryText.push(failed.length ? `对账未通过 ${failed.length} 项：${failed.map(check => check.name).join('、')}` : `对账 ${checks.length} 项全部通过（${mode}）`);

  return {
    ok: failed.length === 0,
    mode,
    checks,
    summary,
    summaryText,
    archiveRows: archive ? archive.memories.length : (report.origins?.archive?.rows ?? 0),
  };
}
