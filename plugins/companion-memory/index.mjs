import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, resolveDatabasePath, resolveWikiDir } from './config.mjs';
import { scopeMatches, defaultImportance, MENTION_POLICIES, BUDGET } from './lib/policy.mjs';
import { contentHash, parseLocalMoment, parseTime, redactSecrets, stableId } from './lib/text.mjs';

// Memory engine facade used by the companion host plugin. It owns the new
// SQLite backend, the wiki compiler and the extraction queue, and it must never
// propagate an error into a chat turn: every public method degrades to a safe
// empty value and records why in `logs/memory-engine.jsonl`.

export const VERSION = '0.4.0';
/**
 * Default persona id. Nothing about it is character specific: a release install
 * uses `bot` until the operator picks another id (D1: `DSH_COMPANION_PERSONA_ID`
 * → `config/suite.json` `persona.id` → this default). The plugin boundary
 * (`companion-foundation`) resolves the suite config and passes the result in;
 * the engine only needs the documented fallback.
 */
export const DEFAULT_PERSONA_ID = 'bot';
/** @deprecated kept so existing imports keep working; prefer `DEFAULT_PERSONA_ID`. */
export const PERSONA_ID = DEFAULT_PERSONA_ID;

/** Persona id for this process: environment override, else the documented default. */
export function resolvePersonaId(env = process.env) {
  const value = String(env?.DSH_COMPANION_PERSONA_ID ?? '').trim();
  return value || DEFAULT_PERSONA_ID;
}

// C3 cross-database ingest (CONTRACT.md §16). The enums mirror the frozen
// companion-runtime event envelope; they stay local so the memory plugin never
// imports the runtime package.
export const INGEST_STATUS = Object.freeze(['accepted', 'pending', 'rejected', 'duplicate', 'retryable_failure']);
export const INGEST_REALITY_STATUS = Object.freeze(['actual_tool_activity', 'simulated_world', 'hypothetical']);
export const INGEST_EVIDENCE_STATUS = Object.freeze(['observed', 'inferred', 'confirmed']);
/**
 * P2.5-2 (A4 §2.5 E2): the significance levels an ingest request may carry.
 *
 * The *producer* (the P2 runtime) decides which one applies; memory only routes on it:
 * `notable` → a durable memory (confirmed, or pending when `evidenceStatus` is `inferred`),
 * `routine` → no durable memory at all (the producer keeps its own activity history).
 * Any other value is treated as if the field was absent, so an unknown producer cannot silently
 * switch the policy off.
 */
export const INGEST_SIGNIFICANCE = Object.freeze(['notable', 'routine']);

// companion-runtime normalises an empty worldId to `world:default` (runtime
// CONTRACT §2). At the memory boundary both spellings mean reality; anything else
// is a fiction world id and is handled by the roleplay paths, not this entry.
export const RUNTIME_DEFAULT_WORLD = 'world:default';

// 回车/换行以外的控制字符不会出现在正常 id 里，但它们会破坏按分隔符拼接的去重键
// 的唯一性（`u:a\0b` 与 `u:a` + 另一段可以拼出同一条）。所有进入作用域键/证据键的
// 分量都必须先排除控制字符，键才是单射的（CONTRACT.md §16.1）。
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function normalizeIngestWorldId(worldId) {
  const value = typeof worldId === 'string' ? worldId.trim() : '';
  return value === RUNTIME_DEFAULT_WORLD ? '' : value;
}

function appendJsonl(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(value) + '\n', 'utf8');
  } catch { /* diagnostics must never break a turn */ }
}

function safeMessage(error) {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.slice(0, 500);
}

// ---------------------------------------------------------------------------
// 进程内唯一引擎
//
// 桌面是单进程，而「陪伴 preset」与「记忆档案 Studio 插件」都会想拿到引擎。
// 两个引擎会各持一条 SQLite 写连接与一个作业 drainer，所以这里用模块级登记表
// 按 root 归一：先建的人负责登记，后来的人直接复用同一个实例。
// 登记表只活在本进程内（不跨进程、不落盘），因此不会影响 CLI/测试的隔离性。
// ---------------------------------------------------------------------------

const sharedEngines = new Map();

function sharedKey(root) {
  try {
    return path.resolve(root);
  } catch {
    return String(root);
  }
}

/** 取当前进程里已经为这个 root 建好的引擎（没有则返回 null）。 */
export function sharedEngineFor(root) {
  return sharedEngines.get(sharedKey(root)) ?? null;
}

/** 登记一个引擎并返回它；同一个 root 上后登记的不生效（先到先得）。 */
export function shareEngine(root, engine) {
  const key = sharedKey(root);
  const existing = sharedEngines.get(key);
  if (existing) return existing;
  sharedEngines.set(key, engine);
  return engine;
}

/** 注销引擎（只注销自己这一个，避免误删别人登记的实例）。 */
export function releaseSharedEngine(root, engine) {
  const key = sharedKey(root);
  if (sharedEngines.get(key) === engine) sharedEngines.delete(key);
}

/** 诊断用：当前进程登记了几个引擎。 */
export function sharedEngineCount() {
  return sharedEngines.size;
}

/**
 * Build the memory engine for one companion root.
 * @param root - companion root directory (contains `home/` and `workspace/`).
 * @param identity - the companion identity service (`resolve(sessionId)`).
 * @param options.env - environment overrides.
 * @param options.llm - optional `{ complete({system, input, maxTokens, signal}) }`.
 * @param options.personaId - resolved persona id (default: env override or `bot`).
 * @param options.personaName - display name recorded on the persona row (default: the id).
 */
export function createMemoryEngine({ root, identity, env = process.env, llm = null, now = () => Date.now(), personaId = null, personaName = '' }) {
  const configPath = path.join(root, 'home/companion/memory.config.json');
  const logPath = path.join(root, 'logs/memory-engine.jsonl');
  const recallLogPath = path.join(root, 'logs/memory-recall.jsonl');
  // One reason for the persona id per engine instance: every scope key, ingest
  // check and bootstrap row below must agree on it.
  const persona = String(personaId ?? resolvePersonaId(env)).trim() || DEFAULT_PERSONA_ID;
  const personaDisplayName = String(personaName ?? '').trim() || persona;
  const loaded = loadConfig(root, env);
  const config = loaded.config;
  const state = {
    backend: 'legacy',
    reason: loaded.error ? `config-error: ${loaded.error}` : '',
    notes: [...loaded.notes],
    db: null,
    initializing: null,
    wiki: null,
    lastCompileAt: 0,
    jobsPromise: null,
    embedder: null,
    closing: false,
    lastJobAt: 0,
    captures: 0,
    recalls: 0,
    errors: 0,
    capture: null,
  };

  const log = (event, detail = {}) => appendJsonl(logPath, { at: new Date(now()).toISOString(), event, backend: state.backend, ...detail });

  const viewerFor = sessionId => {
    let bound;
    try {
      bound = identity.resolve(sessionId);
    } catch (error) {
      log('identity-failed', { sessionId, error: safeMessage(error) });
      return null;
    }
    return { userId: bound.userId, personaId: persona, worldId: '', sessionId, displayName: bound.displayName };
  };

  const databaseFile = () => resolveDatabasePath(root, config);
  const wikiDir = () => resolveWikiDir(root, config);

  const module = name => import(new URL(`./lib/${name}.mjs`, import.meta.url).href);

  async function initialize() {
    if (state.closing) return state;
    if (state.backend === 'sqlite' && state.db) return state;
    if (state.initializing) return state.initializing;
    if (config.backend !== 'sqlite') {
      state.backend = 'legacy';
      state.reason = state.reason || 'config-backend-legacy';
      return state;
    }
    state.initializing = (async () => {
      try {
        const { openMemoryDatabase } = await module('db');
        // Engine start-up only needs the cheap check; a full integrity sweep is a
        // maintenance action (migration CLI / scripts/check.mjs).
        const db = await openMemoryDatabase({ file: databaseFile(), integrity: 'quick' });
        state.db = db;
        state.backend = 'sqlite';
        state.reason = '';
        try {
          state.capture = await module('capture');
        } catch (error) {
          log('capture-module-failed', { error: safeMessage(error) });
        }
        try {
          // Recover jobs that were left `running` by a crash or a hard stop.
          if (typeof db.resetStaleRunning === 'function') {
            const recovered = db.resetStaleRunning({ staleAfterMs: 15 * 60 * 1000, now: now() });
            if ((recovered?.reset ?? 0) > 0) log('stale-jobs-reset', { reset: recovered.reset });
          }
        } catch (error) {
          log('stale-job-recovery-failed', { error: safeMessage(error) });
        }
        // Backfill vectors in the background so the semantic channel is usable
        // without blocking the first turn.
        if (config.retrieval.semanticEnabled && config.embedding.provider !== 'off') {
          setTimeout(() => { void ensureEmbeddings(db).catch(error => log('embedding-backfill-failed', { error: safeMessage(error) })); }, 0).unref?.();
        }
        log('sqlite-opened', { file: databaseFile(), schemaVersion: db.schemaVersion() });
    if (Array.isArray(db.migrated) && db.migrated.length) {
      log('schema-migrated', { versions: db.migrated.join(','), schemaVersion: db.schemaVersion() });
    }
    if (db.schemaOutdated) log('schema-outdated-readonly', { schemaVersion: db.schemaVersion() });
        try {
          const { upsertFoundationState } = await module('import');
          if (typeof upsertFoundationState === 'function') {
            // Identity and persona rows keep the store self-describing.
            db.upsertIdentity({ userId: identity.owner().id, displayName: identity.owner().displayName, platform: identity.owner().platform ?? '' });
            db.upsertPersona({ personaId: persona, displayName: personaDisplayName, revision: VERSION, personaRef: 'config/persona.md' });
          }
        } catch (error) {
          log('bootstrap-identity-failed', { error: safeMessage(error) });
        }
      } catch (error) {
        state.db = null;
        state.backend = 'legacy';
        state.reason = `sqlite-unavailable: ${safeMessage(error)}`;
        state.errors += 1;
        log('sqlite-unavailable', { error: state.reason });
      } finally {
        state.initializing = null;
      }
      return state;
    })();
    return state.initializing;
  }

  async function withDb(name, fallback, run) {
    await initialize();
    if (!state.db) return fallback;
    try {
      return await run(state.db);
    } catch (error) {
      state.errors += 1;
      log('operation-failed', { operation: name, error: safeMessage(error) });
      return fallback;
    }
  }

  // ---------------------------------------------------------------------------
  // C3 cross-database ingest (CONTRACT.md §16)
  //
  // companion-runtime writes long-term memory only through ingestDomainEvent. The
  // runtime never opens this database and never decides visibility: subject binding,
  // reality gating and the dedupe receipt are all enforced here.
  // ---------------------------------------------------------------------------

  /** Validate one ingest request before any database work. */
  function normalizeIngestInput(input) {
    const source = input && typeof input === 'object' ? input : {};
    const subject = source.subject;
    if (!subject || typeof subject !== 'object' || Array.isArray(subject)) return { ok: false, reason: 'invalid-subject' };
    const userId = typeof subject.userId === 'string' ? subject.userId.trim() : '';
    const personaId = typeof subject.personaId === 'string' ? subject.personaId.trim() : '';
    const worldId = normalizeIngestWorldId(subject.worldId);
    if (!userId || !personaId || userId === '*' || personaId === '*') return { ok: false, reason: 'invalid-subject' };
    if ([userId, personaId, worldId].some(part => CONTROL_CHARS.test(part))) return { ok: false, reason: 'invalid-subject' };
    const namespace = typeof source.namespace === 'string' ? source.namespace.trim() : '';
    if (!namespace || namespace.length > 120) return { ok: false, reason: 'invalid-namespace' };
    if (CONTROL_CHARS.test(namespace)) return { ok: false, reason: 'invalid-namespace' };
    const eventId = typeof source.eventId === 'string' ? source.eventId.trim() : '';
    if (!eventId || eventId.length > 200) return { ok: false, reason: 'invalid-event-id' };
    if (CONTROL_CHARS.test(eventId)) return { ok: false, reason: 'invalid-event-id' };
    const transformVersion = typeof source.transformVersion === 'number' && Number.isFinite(source.transformVersion)
      ? String(source.transformVersion)
      : (typeof source.transformVersion === 'string' ? source.transformVersion.trim() : '');
    if (!transformVersion || transformVersion.length > 80) return { ok: false, reason: 'invalid-transform-version' };
    if (CONTROL_CHARS.test(transformVersion)) return { ok: false, reason: 'invalid-transform-version' };
    const content = typeof source.content === 'string' ? source.content.trim() : '';
    if (!content) return { ok: false, reason: 'content-empty' };
    if (content.length > config.limits.factValueChars) return { ok: false, reason: 'content-too-long' };
    // Never persist credential-looking text, even when an upstream module passes it.
    if (redactSecrets(content) !== content) return { ok: false, reason: 'sensitive-content' };
    let occurredAt = null;
    if (typeof source.occurredAt === 'number') {
      if (Number.isFinite(source.occurredAt)) {
        const date = new Date(source.occurredAt);
        occurredAt = Number.isNaN(date.getTime()) ? null : date.toISOString();
      }
    } else {
      occurredAt = parseTime(source.occurredAt);
    }
    if (!occurredAt) return { ok: false, reason: 'invalid-occurred-at' };
    const realityStatus = source.realityStatus ?? 'hypothetical';
    if (!INGEST_REALITY_STATUS.includes(realityStatus)) return { ok: false, reason: 'invalid-reality-status' };
    const evidenceStatus = source.evidenceStatus ?? 'observed';
    if (!INGEST_EVIDENCE_STATUS.includes(evidenceStatus)) return { ok: false, reason: 'invalid-evidence-status' };
    const mentionPolicy = source.mentionPolicy == null || source.mentionPolicy === '' ? '' : String(source.mentionPolicy);
    if (mentionPolicy && !MENTION_POLICIES.includes(mentionPolicy)) return { ok: false, reason: 'invalid-mention-policy' };
    const rootEvidenceIds = Array.isArray(source.rootEvidenceIds)
      ? [...new Set(source.rootEvidenceIds
        .filter(value => typeof value === 'string' && value.trim())
        .map(value => value.trim()))].slice(0, 64)
      : [];
    // P2.5-2 (A4 §2.5 E2): the *producer* decides significance; memory only routes on the field.
    // An absent or unknown value keeps the pre-existing behaviour (treated as notable), so a caller
    // that knows nothing about this field is never silently downgraded.
    const significanceRaw = typeof source.significance === 'string' ? source.significance.trim() : '';
    const significance = INGEST_SIGNIFICANCE.includes(significanceRaw) ? significanceRaw : '';
    // B (AC: "用户纠正后不会复活旧错误"): the producer names what this ingest replaces — a memory id
    // (`mem_…`) or a text needle from the old statement. Bounded and optional: an absent hint keeps
    // the plain "new fact" behaviour, and an unresolvable hint is *not* an error (see writeIngest).
    const supersedesHintRaw = typeof source.supersedesHint === 'string' ? source.supersedesHint.trim() : '';
    if (supersedesHintRaw && supersedesHintRaw.length > 200) return { ok: false, reason: 'invalid-supersedes-hint' };
    if (supersedesHintRaw && CONTROL_CHARS.test(supersedesHintRaw)) return { ok: false, reason: 'invalid-supersedes-hint' };
    const supersedesHint = supersedesHintRaw;
    // task-38: an operator decision names the exact rows to replace, so it needs no text matching and
    // is never ambiguous. Bounded, id-shaped, and deliberately separate from `supersedesHint`: a
    // human decision must not travel through a heuristic.
    const supersedeIdsRaw = Array.isArray(source.supersedeIds) ? source.supersedeIds : [];
    const supersedeIds = [...new Set(supersedeIdsRaw
      .filter(value => typeof value === 'string' && /^mem_[A-Za-z0-9_-]+$/.test(value.trim()))
      .map(value => value.trim()))].slice(0, 10);
    if (supersedeIdsRaw.length && supersedeIds.length !== new Set(supersedeIdsRaw.map(value => String(value ?? '').trim())).size) {
      return { ok: false, reason: 'invalid-supersede-ids' };
    }
    return {
      ok: true,
      value: {
        subject: { userId, personaId, worldId },
        namespace, eventId, transformVersion, content, occurredAt,
        realityStatus, evidenceStatus, mentionPolicy, rootEvidenceIds, significance, supersedesHint, supersedeIds,
      },
    };
  }

  /**
   * Reality/evidence gate. Inferred content is a pending candidate at most;
   * hypothetical and simulated-world content never becomes a user fact.
   */
  function decideIngest(request) {
    if (request.realityStatus !== 'actual_tool_activity') {
      return { decision: 'reject', reason: 'non-actual-reality' };
    }
    if (request.subject.worldId) {
      return { decision: 'reject', reason: 'world-scope-mismatch' };
    }
    // P2.5-2 (A4 §2.5 E2): a routine outcome stays in the producer's own history. It is still a
    // recorded fact there (P2 keeps the activity row, the receipts and the event), it just must not
    // become a permanent memory — "not every article read is a memory" (plan §P2.5-2 item 2).
    // This is a policy refusal, not an error: the reason is greppable and the receipt is stored.
    if (request.significance === 'routine') {
      return { decision: 'reject', reason: 'routine-activity-not-remembered' };
    }
    if (request.namespace === 'p2/activity' && request.significance !== 'notable') {
      return { decision: 'reject', reason: 'activity-significance-required' };
    }
    if (request.evidenceStatus === 'inferred') {
      return { decision: 'pending', reason: 'inferred-candidate', kind: 'fact', realityLevel: 'inferred', status: 'pending', confidence: 0.35 };
    }
    if (request.evidenceStatus === 'confirmed') {
      return { decision: 'accepted', reason: 'confirmed-observation', kind: 'fact', realityLevel: 'explicit_user_statement', status: 'confirmed', confidence: 0.9 };
    }
    return { decision: 'accepted', reason: 'observed-activity', kind: 'event', realityLevel: 'user_utterance_not_verified_fact', status: 'confirmed', confidence: 0.6 };
  }

  /** A subject is bound when it is the engine owner or a locally registered identity. */
  function subjectBound(db, subject) {
    if (subject.personaId !== persona) return false;
    try {
      const owner = typeof identity?.owner === 'function' ? identity.owner() : null;
      if (owner && owner.id === subject.userId) return true;
    } catch { /* fall through to the registered identity check */ }
    try {
      return db.identityExists(subject.userId);
    } catch {
      return false;
    }
  }

  /**
   * Length-prefixed tuple: every component carries its own length, so no component
   * can shift another one's boundary. A plain `join(':')` is not injective and a
   * hashed separator join is only as strong as "no component contains NUL".
   */
  function scopedTuple(...parts) {
    return parts.map(part => `${String(part).length}:${String(part)}`).join('|');
  }

  /**
   * Evidence key for one ingest request (CONTRACT.md §16.1).
   *
   * The scope is part of the key: two different subjects sending the same
   * namespace/eventId/transformVersion must never share a `source_events` row,
   * otherwise the second user's memory links to — and quotes — the first user's
   * evidence text (Codex review 2026-10-29, B1). The prefix is deliberately
   * different from the legacy unscoped `runtime:<ns>:<id>:<ver>` spelling, so rows
   * written before this fix are never mistaken for a scoped row.
   *
   * The receipt dedupe key keeps its v0.4.1 derivation (see `writeIngest`): receipts
   * already on disk must stay addressable, and both keys are injective because every
   * component is validated against control characters in `normalizeIngestInput`.
   */
  function ingestEvidenceKey(request, scopeKeyValue) {
    const tuple = scopedTuple(request.namespace, scopeKeyValue, request.eventId, request.transformVersion);
    return `runtime-scoped:${stableId('evk', tuple)}`;
  }

  /**
   * An existing evidence row may be reused only by the exact same event key, subject
   * and text. Anything else is an integrity conflict: reject instead of borrowing
   * another subject's evidence.
   */
  function evidenceMatches(row, request, evidenceKey) {
    if (!row) return false;
    return row.eventKey === evidenceKey
      && row.userId === request.subject.userId
      && row.personaId === request.subject.personaId
      && row.worldId === request.subject.worldId
      && row.content === request.content
      && row.contentHash === contentHash(request.content);
  }

  /**
   * One ingest request. Must run inside `db.transaction`: evidence, record, evidence
   * links and receipt commit together or not at all.
   */
  /**
   * Resolve `supersedesHint` and supersede what it names.
   *
   * Accepted hints, in order:
   *   1. a memory id (`mem_…`) — resolved directly;
   *   2. otherwise a text needle — matched against the **confirmed** memories of this same subject
   *      whose value contains it (bounded, newest first).
   *
   * "Nothing matched" is a normal outcome, not an error: the correction is still a useful new fact,
   * and the miss is logged with a stable reason code so it can be explained later. Delivery is
   * idempotent through `db.supersedeMemory` (an already-superseded row is left alone).
   *
   * **Fail-closed** (the important part): a *text* hint that matches more than one confirmed fact
   * supersedes **nothing** and reports `correction-hint-ambiguous` with the candidate ids. Erasing a
   * real memory cannot be undone, so an ambiguous correction waits for a human instead. An id hint
   * (`mem_…`) is exact by construction and keeps the old behaviour.
   */
  /**
   * A short, redacted, honest preview of one candidate for the review list.
   *
   * Rules that matter: at most 120 characters (and `truncated` says so), no credential-looking text
   * (the same `redactSecrets` the ingest path uses), and **no evidence excerpts** — the statement is
   * what the user/planner wrote, the raw source material stays in `source_events`. If the row has no
   * readable text the field is `null` with a reason; it is never filled with a guess.
   */
  function previewCandidate(row) {
    const recordId = String(row?.id ?? '');
    const raw = String(row?.value ?? '').trim();
    if (!raw) return { recordId, text: null, textUnavailable: 'empty-text', at: String(row?.occurred_at ?? ''), kind: String(row?.kind ?? '') };
    const redacted = redactSecrets(raw);
    if (redacted !== raw) {
      // Redaction changed the text, so the preview would be misleading: say so instead of showing a
      // half sentence the reviewer might take for the real statement.
      return { recordId, text: null, textUnavailable: 'redacted', at: String(row?.occurred_at ?? ''), kind: String(row?.kind ?? '') };
    }
    const first = redacted.split(/\r?\n/)[0] ?? '';
    const truncated = first.length > 120;
    return {
      recordId,
      text: truncated ? first.slice(0, 120) : first,
      ...(truncated ? { truncated: true } : {}),
      at: String(row?.occurred_at ?? ''),
      kind: String(row?.kind ?? ''),
    };
  }

  function applySupersedeHint(db, { request, newRecordId } = {}) {
    // An operator decision (`supersedeIds`) bypasses the text heuristic entirely: the ids are exact,
    // so there is nothing to disambiguate. Still one implementation: every row goes through
    // `db.supersedeMemory`.
    const explicitIds = Array.isArray(request?.supersedeIds) ? request.supersedeIds : [];
    if (explicitIds.length) {
      // task-49: **all or nothing**. `supersedeMany` validates every id against the request's own
      // scope before writing anything, so one foreign/absent id means the whole adjudication is
      // refused instead of half-applied (a partial supersede cannot be explained to a user).
      let result = null;
      try {
        result = db.supersedeMany({
          oldIds: explicitIds,
          newId: newRecordId,
          scope: request?.subject ?? null,
          reason: 'operator-adjudication',
          actor: 'operator',
        });
      } catch (error) {
        log('correction-supersede-failed', { reason: safeMessage(error) });
        return { superseded: [], applied: [], duplicate: [], notApplied: explicitIds, reason: 'correction-supersede-failed' };
      }
      if (!result?.ok) {
        log('correction-supersede-refused', { code: String(result?.code ?? ''), oldScope: result?.oldScope, newScope: result?.newScope });
        return {
          superseded: [],
          applied: [],
          duplicate: [],
          notApplied: explicitIds,
          reason: String(result?.code ?? 'correction-supersede-skipped'),
          refused: { code: String(result?.code ?? ''), oldId: String(result?.oldId ?? '') },
        };
      }
      log('correction-superseded', { count: (result.applied ?? []).length, by: 'operator' });
      return {
        // `superseded` keeps its old meaning ("these ids are now superseded") so an idempotent second
        // adjudication still reports its target; `applied` vs `duplicate` says which ones this call
        // actually changed (task-49).
        superseded: [...(result.applied ?? []), ...(result.duplicate ?? [])],
        applied: result.applied ?? [],
        duplicate: result.duplicate ?? [],
        reason: (result.applied ?? []).length ? 'correction-superseded' : 'correction-supersede-skipped',
      };
    }
    const hint = String(request?.supersedesHint ?? '').trim();
    if (!hint) return { superseded: [], reason: 'no-hint' };
    const subject = request.subject;
    let targets = [];
    try {
      if (/^mem_[A-Za-z0-9_-]+$/.test(hint)) {
        const row = db._get('SELECT id, status, value, kind, occurred_at FROM memories WHERE id = ?', [hint]);
        if (row && String(row.id) !== String(newRecordId)) targets = [row];
      } else {
        // No text-normalisation helper is imported here on purpose: the match must be *literal*
        // (the hint is the old statement as the user saw it), and SQLite's `lower()` plus the
        // existing `value` column is enough. Bounded to 5 rows so a broad hint cannot turn into a
        // mass supersede.
        const needle = hint.trim().toLowerCase().slice(0, 120);
        if (needle) {
          targets = db._all(
            `SELECT id, status, value, kind, occurred_at FROM memories
              WHERE user_id = ? AND persona_id = ? AND world_id = ? AND status = 'confirmed'
                AND id <> ?
                AND lower(value) LIKE ?
              ORDER BY created_at DESC, id DESC LIMIT 5`,
            [subject.userId, subject.personaId, subject.worldId, newRecordId, `%${needle}%`],
          ) ?? [];
        }
      }
    } catch (error) {
      log('correction-hint-failed', { reason: safeMessage(error) });
      return { superseded: [], reason: 'correction-hint-failed' };
    }
    if (!targets.length) {
      log('correction-hint-miss', { namespace: request.namespace, hintChars: hint.length });
      return { superseded: [], reason: 'correction-hint-miss' };
    }
    // Fail-closed. Marking a memory superseded is **irreversible** from the user's side: if the hint
    // matched two or more confirmed facts, superseding them all would erase real preferences
    // ("我改主意了" must not wipe three unrelated facts). So a text hint only acts when it is
    // unambiguous: exactly one candidate. Anything else keeps every candidate and asks for a human.
    const byId = /^mem_[A-Za-z0-9_-]+$/.test(hint);
    if (!byId && targets.length > 1) {
      const candidates = targets.slice(0, 5).map(row => String(row.id));
      log('correction-hint-ambiguous', { candidates, count: targets.length });
      // The reviewer has to be able to *see* what it is choosing between — an id alone makes the
      // adjudication channel unusable. So the preview travels with the report: bounded (120 chars
      // per candidate, 5 candidates), redacted (never a credential-looking string), and honest about
      // what it could not read (`text: null` + a reason instead of a made-up summary).
      const ambiguousDetails = targets.slice(0, 5).map(row => previewCandidate(row));
      return { superseded: [], ambiguous: candidates, ambiguousDetails, reason: 'correction-hint-ambiguous' };
    }
    const done = [];
    for (const old of targets.slice(0, byId ? 1 : 1)) {
      try {
        const result = db.supersedeMemory({
          oldId: old.id, newId: newRecordId, reason: 'user-correction', actor: 'user',
        });
        if (result?.ok) done.push(old.id);
      } catch (error) {
        log('correction-supersede-failed', { reason: safeMessage(error) });
      }
    }
    if (done.length) log('correction-superseded', { count: done.length });
    return { superseded: done, reason: done.length ? 'correction-superseded' : 'correction-supersede-skipped' };
  }

  function writeIngest(db, request) {
    if (!subjectBound(db, request.subject)) {
      return { status: 'rejected', receiptId: '', reason: 'unbound-subject' };
    }
    const scopeKeyValue = `u:${request.subject.userId}|p:${request.subject.personaId}|w:${request.subject.worldId}`;
    const dedupeKey = stableId('dkev', request.namespace, scopeKeyValue, request.eventId, request.transformVersion);
    const hash = contentHash(request.content);
    const existing = db.getDomainEventReceipt(dedupeKey);
    if (existing) {
      if (existing.contentHash !== hash) {
        return {
          status: 'rejected',
          receiptId: existing.receiptId,
          ...(existing.recordId ? { recordId: existing.recordId } : {}),
          reason: 'content-conflict',
        };
      }
      if (existing.status === 'rejected') {
        return { status: 'rejected', receiptId: existing.receiptId, reason: existing.reason || 'rejected' };
      }
      const requested = Array.isArray(request.supersedeIds) ? request.supersedeIds.filter(Boolean) : [];
      let supersede;
      if (requested.length) {
        const already = [];
        const stillOpen = [];
        for (const id of requested) {
          let row = null;
          try { row = db._get('SELECT status FROM memories WHERE id = ?', [String(id)]); } catch { row = null; }
          if (String(row?.status ?? '') === 'superseded') already.push(String(id));
          else stillOpen.push(String(id));
        }
        supersede = {
          applied: [], duplicate: already, notApplied: stillOpen, reason: 'duplicate-replay',
        };
      }
      return {
        status: 'duplicate',
        receiptId: existing.receiptId,
        ...(existing.recordId ? { recordId: existing.recordId } : {}),
        ...(supersede ? { supersede } : {}),
        reason: 'dedupe-hit',
      };
    }

    const decision = decideIngest(request);
    const receiptBase = {
      receiptId: stableId('rcpt', dedupeKey),
      dedupeKey,
      namespace: request.namespace,
      scope: scopeKeyValue,
      eventId: request.eventId,
      transformVersion: request.transformVersion,
      contentHash: hash,
      realityStatus: request.realityStatus,
      evidenceStatus: request.evidenceStatus,
      rootEvidenceIds: request.rootEvidenceIds,
    };
    if (decision.decision === 'reject') {
      const receipt = db.putDomainEventReceipt({ ...receiptBase, status: 'rejected', reason: decision.reason });
      return { status: 'rejected', receiptId: receipt?.receiptId ?? receiptBase.receiptId, reason: decision.reason };
    }

    const eventKey = ingestEvidenceKey(request, scopeKeyValue);
    // Reuse is allowed only for the identical event: validate the existing row's
    // event key, subject and text before linking a memory to it (B1).
    const existingEvidence = db.getEventByKey(eventKey);
    if (existingEvidence && !evidenceMatches(existingEvidence, request, eventKey)) {
      return { status: 'rejected', receiptId: '', reason: 'evidence-conflict' };
    }
    const evidence = existingEvidence
      ? { inserted: false, sourceId: existingEvidence.sourceId }
      : db.appendEvent({
        eventKey,
        role: 'runtime',
        sourceKind: 'system',
        occurredAt: request.occurredAt,
        content: request.content,
        userId: request.subject.userId,
        personaId: request.subject.personaId,
        worldId: request.subject.worldId,
        meta: {
          namespace: request.namespace,
          eventId: request.eventId,
          transformVersion: request.transformVersion,
          scope: scopeKeyValue,
          realityStatus: request.realityStatus,
          evidenceStatus: request.evidenceStatus,
          dedupeKey,
        },
      });
    // Another writer may have landed the row between the lookup and the insert (WAL
    // multi-process). Validate that row too instead of trusting it blindly.
    if (!evidence.inserted && !existingEvidence) {
      const landed = db.getEvent(evidence.sourceId);
      if (!evidenceMatches(landed, request, eventKey)) {
        return { status: 'rejected', receiptId: '', reason: 'evidence-conflict' };
      }
    }
    // Pending candidates can never be injected directly, so their mention policy is
    // pinned; observed events default to a softer echo than a confirmed fact.
    const mentionPolicy = decision.status === 'pending'
      ? 'soft_echo'
      : (request.mentionPolicy || (decision.kind === 'event' ? 'soft_echo' : 'direct'));
    const inserted = db.insertMemory({
      id: stableId('mem', dedupeKey),
      dedupeKey,
      scope: request.namespace.startsWith('p2/') ? 'persona_self' : 'user_global',
      kind: request.namespace.startsWith('p2/') ? 'event' : decision.kind,
      subject: request.namespace.startsWith('p2/') ? request.subject.personaId : 'user',
      predicate: `runtime:${request.namespace}`,
      value: request.content,
      content: '',
      confidence: decision.confidence,
      importance: defaultImportance(decision.kind),
      mentionPolicy,
      status: decision.status,
      realityLevel: request.namespace.startsWith('p2/') ? 'bot_action' : decision.realityLevel,
      userId: request.subject.userId,
      personaId: request.subject.personaId,
      worldId: '',
      sourceKind: 'system',
      sourceId: evidence.sourceId,
      occurredAt: request.occurredAt,
      validFrom: request.occurredAt,
      tags: ['runtime', `namespace:${request.namespace}`, `event:${request.eventId}`],
    });
    const record = inserted.record;
    db.addEvidence(record.id, evidence.sourceId, { evidenceKind: 'supports', confidence: 1 });
    const rootConfidence = decision.decision === 'pending' ? 0.4 : 0.6;
    for (const rootId of request.rootEvidenceIds) {
      db.addEvidence(record.id, rootId, { evidenceKind: 'supports', confidence: rootConfidence });
    }
    const receipt = db.putDomainEventReceipt({
      ...receiptBase,
      status: decision.decision === 'pending' ? 'pending' : 'accepted',
      recordId: record.id,
      sourceId: evidence.sourceId,
      reason: decision.reason,
    });
    // B: mark what this fact replaces. The recall layers already filter `status = 'confirmed'`, so a
    // superseded row disappears from keyword, FTS and embedding recall without any query change —
    // that is the whole "零 migration" trick (no new column, no new status value).
    const supersedeOutcome = applySupersedeHint(db, { request, newRecordId: record.id });
    // Ambiguity has to be **visible after the fact**, not just logged: the receipt carries the marker
    // (zero migration — the `reason` column already exists), so diagnostics and a human can find
    // "a correction that did not take effect" without reading the log stream.
    if (supersedeOutcome.reason === 'correction-hint-ambiguous') {
      const marked = `correction-hint-ambiguous|${String(receipt?.receiptId ?? receiptBase.receiptId)}|${(supersedeOutcome.ambiguous ?? []).join(',')}`.slice(0, 400);
      try {
        // The receipt already exists (the insert above used ON CONFLICT DO NOTHING), so the marker is
        // an UPDATE: re-inserting would silently keep the old reason.
        db._run('UPDATE domain_event_receipts SET reason = ?, updated_at = ? WHERE receipt_id = ?',
          [marked, new Date(now()).toISOString(), String(receipt?.receiptId ?? receiptBase.receiptId)]);
      } catch { /* the marker is best effort; the log already recorded it */ }
    }
    return {
      status: receipt?.status ?? decision.status,
      receiptId: receipt?.receiptId ?? receiptBase.receiptId,
      recordId: record.id,
      reason: decision.reason,
      supersede: supersedeOutcome,
      ...(supersedeOutcome.superseded.length ? { superseded: supersedeOutcome.superseded } : {}),
    };
  }

  async function embedderFactory() {
    if (!config.retrieval.semanticEnabled || config.embedding.provider === 'off') return null;
    // One provider per engine: keeps the circuit breaker state across turns.
    if (!state.embedder) {
      const { createEmbeddingProvider } = await module('embed');
      state.embedder = await createEmbeddingProvider(config.embedding);
    }
    return state.embedder;
  }

  /**
   * Derive the index key from what the provider actually produced. A degraded
   * remote provider returns local hash vectors, and those must never be stored
   * under the remote model name.
   */
  function embeddingSource(provider, result) {
    const source = result?.source ?? (
      Array.isArray(result) && result.source ? result.source : null);
    if (source && typeof source.provider === 'string') {
      // `degraded` 必须原样带出来：远端失败时嵌入器会返回本地哈希向量，
      // 这里若把它丢掉，ensureEmbeddings 的「降级就停」判断永远不成立，
      // 同一批 pending 会被反复请求（2026-10-28 评审发现）。
      return {
        provider: source.provider,
        model: source.model,
        dimensions: source.dimensions,
        degraded: Boolean(source.degraded ?? result?.degraded),
        version: source.version,
      };
    }
    return {
      provider: provider.provider,
      model: provider.model,
      dimensions: provider.dimensions,
      degraded: Boolean(result?.degraded),
      version: result?.version,
    };
  }

  function vectorsOf(result) {
    if (Array.isArray(result)) return result;
    if (Array.isArray(result?.vectors)) return result.vectors;
    return [];
  }

  async function ensureEmbeddings(db, { maxBatches = 20 } = {}) {
    if (!config.retrieval.semanticEnabled || config.embedding.provider === 'off') {
      return { embedded: 0, skipped: true, reason: 'disabled' };
    }
    const provider = await embedderFactory();
    if (!provider || !provider.enabled()) return { embedded: 0, skipped: true, reason: 'provider-unavailable' };
    let embedded = 0;
    let degraded = false;
    const attempted = new Set();
    for (let round = 0; round < maxBatches; round++) {
      const pending = db.pendingEmbeddings({
        provider: provider.provider,
        model: provider.model,
        dimensions: provider.dimensions,
        limit: 128,
      });
      if (!pending.length) break;
      // 同一批被再次选中（例如上一轮因为维度不符整批跳过）说明补不动了，立刻收敛，
      // 避免把 maxBatches 全部用在同一条记录上反复请求远端。
      const fresh = pending.filter(record => !attempted.has(record.id));
      if (!fresh.length) break;
      for (const record of fresh) attempted.add(record.id);
      const texts = fresh.map(record => record.searchText || record.value);
      let result = null;
      try {
        result = await provider.embed(texts);
      } catch {
        result = null;
      }
      const vectors = vectorsOf(result);
      const source = embeddingSource(provider, result);
      // 降级 = 远端不可用、嵌入器退回本地哈希：此时写入只会把本地向量挂到别的身份上，
      // 而且远端缺口仍在。记一条固定 code 后立即停止，交给下一轮/熔断退避。
      if (source.degraded || source.provider === 'off'
        || source.provider !== provider.provider || source.model !== provider.model) {
        degraded = true;
        log('embedding-degraded', { provider: source.provider, model: source.model });
        break;
      }
      if (vectors.length !== fresh.length) {
        log('embedding-batch-mismatch', { expected: fresh.length, actual: vectors.length });
        break;
      }
      let written = 0;
      for (let index = 0; index < fresh.length; index++) {
        const vector = vectors[index];
        if (!vector || !vector.length) continue;
        // 请求期间记录可能被撤回/归档：写派生向量前再确认一次状态。
        const current = typeof db.getMemory === 'function' ? db.getMemory(fresh[index].id) : null;
        if (current && current.status && current.status !== 'confirmed') continue;
        db.putEmbedding(fresh[index].id, {
          provider: source.provider,
          model: source.model,
          dimensions: vector.length,
          vector,
        });
        written += 1;
      }
      embedded += written;
      if (!written) break;
    }
    if (embedded) log('embeddings-backfilled', { embedded });
    return { embedded, degraded };
  }

  async function compileWikiIfDue(db, viewer, { force = false } = {}) {
    if (!config.wiki.enabled) return { compiled: false, reason: 'disabled' };
    if (!force && !config.wiki.autoCompile) return { compiled: false, reason: 'auto-compile-disabled' };
    const since = now() - state.lastCompileAt;
    if (!force && state.lastCompileAt && since < config.wiki.minIntervalMs) return { compiled: false, reason: 'debounced' };
    state.lastCompileAt = now();
    try {
      const wiki = await module('wiki');
      const result = await wiki.compileWiki({ dir: wikiDir(), db, viewer, now: now(),
        maxEntriesPerTopic: config.wiki.maxEntriesPerTopic, maxPageBytes: config.wiki.maxPageBytes });
      log('wiki-compiled', { pages: result?.pages?.length ?? 0 });
      return { compiled: true, ...result };
    } catch (error) {
      state.errors += 1;
      log('wiki-compile-failed', { error: safeMessage(error) });
      return { compiled: false, reason: safeMessage(error) };
    }
  }

  return {
    version: VERSION,
    config,
    configPath,
    notes: loaded.notes,
    get backend() { return state.backend; },
    get reason() { return state.reason; },
    resolveViewer: viewerFor,

    /**
     * Maintenance/management handle for the on-disk store, used by the Studio
     * plugin. It shares this engine's single SQLite connection and the owner
     * viewer, so the management UI never opens a second writer and never needs
     * a chat session id.
     */
    async internal() {
      await initialize();
      const owner = typeof identity?.owner === 'function'
        ? identity.owner()
        : { id: 'owner', displayName: 'owner' };
      const viewer = { userId: owner.id, personaId: persona, worldId: '', sessionId: '', displayName: owner.displayName };
      return {
        get db() { return state.db; },
        get backend() { return state.backend; },
        version: VERSION,
        config,
        configPath,
        databaseFile: databaseFile(),
        wikiDir: wikiDir(),
        viewer: () => ({ ...viewer }),
        initialize,
        ensureEmbeddings: handle => ensureEmbeddings(handle),
        compileWiki: async (options = {}) => {
          if (!state.db) return { compiled: false, reason: 'sqlite-unavailable' };
          return compileWikiIfDue(state.db, viewer, options);
        },
        resetStaleRunning: () => {
          if (!state.db) return null;
          return state.db.resetStaleRunning({ staleAfterMs: 15 * 60 * 1000, now: now() });
        },
      };
    },

    async initialize() {
      await initialize();
      return this.status();
    },

    /**
     * Text injected before the first step of a turn. Never throws.
     * Returns `''` when the new backend is not active or nothing is relevant.
     */
    async contextFor({ sessionId, query = '' } = {}) {
      await initialize();
      if (!state.db) return '';
      const viewer = viewerFor(sessionId);
      if (!viewer) return '';
      const started = now();
      try {
        const [retrieve, render] = await Promise.all([module('retrieve'), module('render')]);
        const embedder = await embedderFactory();
        const result = await retrieve.recall({
          db: state.db,
          embedder,
          viewer,
          query,
          config: { ...config.retrieval, budgetChars: config.injection.budgetChars, rerank: config.rerank },
          now: now(),
        });
        state.recalls += 1;
        const text = render.renderContext({ entries: result.entries, budget: config.injection.budgetChars });
        appendJsonl(recallLogPath, {
          at: new Date(now()).toISOString(),
          sessionId,
          userId: viewer.userId,
          backend: 'sqlite',
          characters: text.length,
          queryCharacters: String(query ?? '').length,
          explain: result.explain,
          elapsedMs: now() - started,
        });
        return text;
      } catch (error) {
        state.errors += 1;
        log('context-failed', { sessionId, error: safeMessage(error) });
        return '';
      }
    },

    async recall({ sessionId, query = '', limit = 8 } = {}) {
      const viewer = viewerFor(sessionId);
      if (!viewer) return { entries: [], error: 'identity-unavailable' };
      return withDb('recall', { entries: [], error: 'sqlite-unavailable' }, async db => {
        const [retrieve, render] = await Promise.all([module('retrieve'), module('render')]);
        const embedder = await embedderFactory();
        const result = await retrieve.recall({
          db,
          embedder,
          viewer,
          query,
          config: { ...config.retrieval, topK: limit, rerank: config.rerank },
          now: now(),
        });
        const rendered = render.renderRecallResult({ entries: result.entries, limit });
        return { ...rendered, explain: result.explain };
      });
    },

    /**
     * Review list for corrections that did **not** take effect because the hint was ambiguous.
     *
     * Bounded and read-only; it reads the receipts the ingest wrote (zero migration: the `reason`
     * column carries `correction-hint-ambiguous|<receiptId>|<candidateIds>`), so the answer survives
     * a process restart instead of living in a log echo.
     */
    async correctionReview({ limit = 5 } = {}) {
      return withDb('correction-review', { count: 0, recent: [] }, async db => {
        const size = Math.max(1, Math.min(20, Number(limit) || 5));
        const rows = db._all(
          `SELECT receipt_id, record_id, reason, created_at FROM domain_event_receipts
            WHERE reason LIKE 'correction-hint-ambiguous|%'
            ORDER BY created_at DESC, receipt_id DESC LIMIT ?`,
          [size],
        ) ?? [];
        const total = db._get(
          "SELECT COUNT(*) AS n FROM domain_event_receipts WHERE reason LIKE 'correction-hint-ambiguous|%'",
          [],
        );
        return {
          count: Number(total?.n ?? 0),
          recent: rows.map(row => ({
            receiptId: String(row.receipt_id ?? ''),
            recordId: String(row.record_id ?? ''),
            candidates: String(row.reason ?? '').split('|')[2]?.split(',').filter(Boolean) ?? [],
            at: String(row.created_at ?? ''),
          })),
        };
      });
    },

    /** Explicit user-confirmed fact write; returns an auditable receipt. */
    async remember({ sessionId, key, value, predicate = '', occurredAt = '' } = {}) {
      const viewer = viewerFor(sessionId);
      if (!viewer) return { ok: false, error: '当前会话没有可用的用户绑定，未保存。' };
      if (typeof key !== 'string' || !key.trim() || key.length > 80) return { ok: false, error: '记忆键不合法，未保存。' };
      if (typeof value !== 'string' || !value.trim() || value.length > config.limits.factValueChars) return { ok: false, error: '记忆内容不合法，未保存。' };
      return withDb('remember', { ok: false, error: '新记忆库当前不可用，未保存。' }, async db => {
        // Never store credential-looking content, even when the model passes it.
        if (redactSecrets(value) !== value) return { ok: false, error: '内容疑似包含密钥或密码，已拒绝保存。' };
        // 发生时间：调用方给的就是事实对应的时间（本地时间字符串也接受）；
        // 没给就记这次写入的时刻 —— 新记忆绝不允许「没有时间」。
        const statedAt = parseLocalMoment(occurredAt) ?? new Date(now()).toISOString();
        const record = db.rememberFact({
          userId: viewer.userId,
          personaId: viewer.personaId,
          worldId: viewer.worldId,
          scope: 'user_global',
          kind: 'fact',
          subject: 'user',
          key: key.trim(),
          predicate: predicate || `direct:${key.trim()}`,
          value: value.trim(),
          confidence: 1,
          importance: 0.8,
          mentionPolicy: 'direct',
          realityLevel: 'explicit_user_statement',
          sourceKind: 'desktop_fact',
          occurredAt: statedAt,
          validFrom: statedAt,
          tags: ['user_confirmed', key.trim()],
        });
        log('remembered', { sessionId, id: record?.id, revision: record?.revision });
        void compileWikiIfDue(db, viewer).catch(() => {});
        return { ok: true, receipt: { id: record?.id, key: key.trim(), revision: record?.revision ?? 1, occurredAt: statedAt, savedAt: record?.updatedAt ?? new Date(now()).toISOString(), supersedesId: record?.supersedesId || null } };
      });
    },

    /**
     * C3 cross-database ingest entry (CONTRACT.md §16). `companion-runtime` writes
     * long-term memory only through this method. Never throws: every failure is a
     * status, so a degraded memory service cannot break the caller's chat turn.
     */
    async ingestDomainEvent(input = {}) {
      const normalized = normalizeIngestInput(input);
      if (!normalized.ok) return { status: 'rejected', receiptId: '', reason: normalized.reason };
      const request = normalized.value;
      try {
        await initialize();
      } catch (error) {
        state.errors += 1;
        log('ingest-unavailable', { namespace: request.namespace, reason: 'memory-unavailable' });
        return { status: 'retryable_failure', receiptId: '', reason: 'memory-unavailable' };
      }
      if (!state.db) {
        log('ingest-unavailable', { namespace: request.namespace, reason: 'memory-unavailable' });
        return { status: 'retryable_failure', receiptId: '', reason: 'memory-unavailable' };
      }
      try {
        return state.db.transaction(() => writeIngest(state.db, request));
      } catch (error) {
        // The transaction has rolled back: nothing half-written is claimed.
        state.errors += 1;
        log('ingest-failed', { namespace: request.namespace, eventId: request.eventId, error: safeMessage(error) });
        return { status: 'retryable_failure', receiptId: '', reason: 'memory-write-failed' };
      }
    },

    /** Fire-and-forget capture of a real session event. */
    capture({ sessionId, event } = {}) {
      if (!state.db || !state.capture) return { captured: false, reason: 'backend-legacy' };
      const viewer = viewerFor(sessionId);
      if (!viewer) return { captured: false, reason: 'identity-unavailable' };
      try {
        const row = state.capture.toSourceEvent({ sessionId, event, viewer, clock: now(), maxChars: config.limits.captureMessageChars });
        if (!row) return { captured: false, reason: 'not-capturable' };
        const result = state.db.appendEvent(row);
        if (result.inserted) {
          state.captures += 1;
          // Background extraction needs a batch before it can do anything: note
          // one first, then drain. Both are opt-in through `extraction.enabled`.
          if (config.extraction.enabled) {
            void (async () => {
              try {
                await this.noteBatch({ sessionId });
              } catch { /* batching is best effort */ }
              await this.drainJobs({ sessionId, viewer, background: true });
            })().catch(() => {});
          }
        }
        return { captured: result.inserted, sourceId: result.sourceId };
      } catch (error) {
        state.errors += 1;
        log('capture-failed', { sessionId, error: safeMessage(error) });
        return { captured: false, reason: safeMessage(error) };
      }
    },

    /** Load the capture helpers once; keeps the engine import graph small. */
    async loadCapture() {
      state.capture = state.capture ?? await module('capture');
      return state.capture;
    },

    async noteBatch({ sessionId, minMessages = config.extraction.minMessages } = {}) {
      const viewer = viewerFor(sessionId);
      if (!viewer) return null;
      return withDb('note-batch', null, async db => {
        const capture = await this.loadCapture();
        return capture.noteCaptureBatch({
          db,
          viewer,
          minMessages,
          maxMessages: config.extraction.maxMessages,
        });
      });
    },

    async drainJobs({ sessionId, viewer: given, background = false, force = false } = {}) {
      // Background extraction is opt-in; an explicit request is not.
      if (background && !config.extraction.enabled) return { processed: 0, reason: 'extraction-disabled' };
      if (!llm) return { processed: 0, reason: 'llm-unavailable' };
      // A background drain may already be running; join it instead of reporting "busy",
      // so an explicit extraction request never returns a misleading zero.
      if (state.jobsPromise) return state.jobsPromise;
      const viewer = given ?? viewerFor(sessionId);
      if (!viewer) return { processed: 0, reason: 'identity-unavailable' };
      const jobConfig = force
        ? { ...config, extraction: { ...config.extraction, enabled: true } }
        : config;
      state.jobsPromise = (async () => withDb('drain-jobs', { processed: 0, reason: 'sqlite-unavailable' }, async db => {
        const jobs = await module('jobs');
        // The provider needs the owning session id on background calls; pass the
        // real one through so the extraction is attributable to this conversation.
        const jobLlm = sessionId && typeof llm.complete === 'function'
          ? { ...llm, complete: args => llm.complete({ ...args, sessionId }) }
          : llm;
        const result = await jobs.runJobs({
          db, llm: jobLlm, config: jobConfig, viewer,
          persona: { id: persona, name: personaDisplayName },
          now: now(),
          limit: 2,
        });
        state.lastJobAt = now();
        log('jobs-drained', { processed: result?.processed ?? 0, failed: result?.failed ?? 0 });
        if ((result?.processed ?? 0) > 0) {
          // Newly written facts need vectors before the next semantic recall.
          void ensureEmbeddings(db).catch(error => log('embedding-backfill-failed', { error: safeMessage(error) }));
          void compileWikiIfDue(db, viewer).catch(() => {});
        }
        return result;
      }))();
      try {
        return await state.jobsPromise;
      } finally {
        state.jobsPromise = null;
      }
    },

    /** Explicit, user-visible extraction run (a single model call per batch). */
    async extractNow({ sessionId, limit = 1 } = {}) {
      if (!llm) return { ok: false, error: '未配置总结模型，无法立即提炼。' };
      const viewer = viewerFor(sessionId);
      if (!viewer) return { ok: false, error: '当前会话没有用户绑定。' };
      // An explicit request always batches at least one message.
      const noted = await this.noteBatch({ sessionId, minMessages: 1 });
      const first = await this.drainJobs({ sessionId, viewer, force: true });
      if (noted?.jobId && (first?.processed ?? 0) === 0) {
        const second = await this.drainJobs({ sessionId, viewer, force: true });
        return { ok: true, ...second, noted, secondPass: true };
      }
      if (first?.reason === 'llm-unavailable') return { ok: false, error: '总结模型不可用，未提炼。', ...first };
      return { ok: true, ...first, noted, limit };
    },

    async pending({ sessionId, limit = 20 } = {}) {
      const viewer = viewerFor(sessionId);
      if (!viewer) return { entries: [] };
      return withDb('pending', { entries: [] }, async db => {
        const rows = db.listMemories({ userId: viewer.userId, personaId: viewer.personaId, worldId: viewer.worldId, status: 'pending', limit });
        return {
          entries: rows
            // Pending rows are still subject to the same visibility rules as recall.
            .filter(row => scopeMatches(row, viewer))
            .map(row => {
              const hidden = row.mentionPolicy === 'avoid_unless_asked';
              return {
                id: row.id,
                kind: row.kind,
                scope: row.scope,
                policy: row.mentionPolicy,
                hidden,
                value: hidden ? '' : row.value,
                confidence: row.confidence,
                updatedAt: row.updatedAt,
                reasons: row.tags?.filter(tag => String(tag).startsWith('reason:')).map(tag => String(tag).slice(7)) ?? [],
                ...(hidden ? { note: '用户不愿主动提及，正文需在明确询问时由人工确认后再展示。' } : {}),
              };
            }),
        };
      });
    },

    async forget({ sessionId, id, reason = 'user-request' } = {}) {
      const viewer = viewerFor(sessionId);
      if (!viewer) return { ok: false, error: '当前会话没有用户绑定。' };
      if (typeof id !== 'string' || !id.startsWith('mem_')) return { ok: false, error: '记忆 id 不合法。' };
      return withDb('forget', { ok: false, error: '新记忆库当前不可用。' }, async db => {
        const record = db.getMemory(id);
        if (!record) return { ok: false, error: '没有找到这条记忆。' };
        if (record.userId !== viewer.userId || record.personaId !== viewer.personaId) return { ok: false, error: '这条记忆不属于当前用户，拒绝修改。' };
        db.setStatus(id, 'retracted', { reason: 'user-request', actor: 'user' });
        // Log a reason code, never the caller-supplied free text.
        log('forgotten', { sessionId, id, reason: 'user-request' });
        void compileWikiIfDue(db, viewer, { force: true }).catch(() => {});
        return { ok: true, id, status: 'retracted' };
      });
    },

    async wikiIndex({ sessionId } = {}) {
      const viewer = viewerFor(sessionId);
      if (!viewer) return { pages: [] };
      return withDb('wiki-index', { pages: [] }, async db => {
        const wiki = await module('wiki');
        // The index page itself is registered with scope 'system'; only topics are listed.
        const pages = db.listWikiPages().filter(page => page.scope !== 'system');
        return {
          pages: pages.map(page => ({ pageId: page.pageId, topic: page.topic, scope: page.scope, path: page.path,
            revision: page.sourceRevision, status: page.status, notes: page.notes || '' })),
          count: pages.length,
          dir: wikiDir(),
          topics: wiki.WIKI_TOPICS.map(topic => ({ id: topic.id, topic: topic.topic, path: topic.path })),
          invalid: pages.filter(page => String(page.status ?? '').includes('invalid')).map(page => page.pageId),
        };
      });
    },

    async wikiGet({ sessionId, topicId } = {}) {
      const viewer = viewerFor(sessionId);
      if (!viewer) return { ok: false, error: '当前会话没有用户绑定。' };
      return withDb('wiki-get', { ok: false, error: '新记忆库当前不可用。' }, async () => {
        const wiki = await module('wiki');
        const page = wiki.readPage({ dir: wikiDir(), topicId });
        return { ok: page.exists, ...page };
      });
    },

    async compileWiki({ sessionId, force = true } = {}) {
      const viewer = viewerFor(sessionId);
      if (!viewer) return { ok: false, error: '当前会话没有用户绑定。' };
      return withDb('compile-wiki', { ok: false, error: '新记忆库当前不可用。' }, async db => {
        const result = await compileWikiIfDue(db, viewer, { force });
        return { ok: true, ...result };
      });
    },

    /** Rebuild derived state (FTS + embeddings + wiki) after a restore. */
    async rebuildIndex({ sessionId } = {}) {
      const viewer = viewerFor(sessionId);
      return withDb('rebuild-index', { ok: false }, async db => {
        const search = db.rebuildSearchIndex();
        const embeddings = await ensureEmbeddings(db);
        const wiki = viewer ? await compileWikiIfDue(db, viewer, { force: true }) : { compiled: false };
        return { ok: true, search, embeddings, wiki };
      });
    },

    async status({ sessionId } = {}) {
      await initialize();
      const base = {
        version: VERSION,
        backend: state.backend,
        reason: state.reason || null,
        notes: state.notes,
        // 版本可观测：怎么迁的、有没有因为只读而没迁。
        schema: state.db ? {
          version: state.db.schemaVersion(),
          migrated: Array.isArray(state.db.migrated) ? state.db.migrated : [],
          outdated: Boolean(state.db.schemaOutdated),
        } : null,
        configPath,
        config: {
          backend: config.backend,
          extractionEnabled: config.extraction.enabled,
          embedding: config.embedding.provider,
          embeddingModel: config.embedding.model,
          rerankEnabled: Boolean(config.rerank?.enabled),
          rerankModel: config.rerank?.model ?? '',
          wiki: config.wiki.enabled,
          budgetChars: config.injection.budgetChars,
        },
        captures: state.captures,
        recalls: state.recalls,
        errors: state.errors,
        llm: llm ? (typeof llm.describe === 'function' ? llm.describe() : 'configured') : 'not-configured',
      };
      if (!state.db) return base;
      const stats = state.db.stats();
      let jobs = null;
      try { jobs = state.db.jobStats(); } catch { jobs = null; }
      let pages = 0;
      try { pages = state.db.listWikiPages().length; } catch { pages = 0; }
      return { ...base, database: databaseFile(), stats, jobs, wikiPages: pages };
    },

    async close() {
      state.closing = true;
      // Stop accepting new work, then let the in-flight initialization and job
      // drain settle before the handle goes away.
      try {
        if (state.initializing) await state.initializing.catch(() => {});
      } catch { /* ignore */ }
      try {
        if (state.jobsPromise) await state.jobsPromise.catch(() => {});
      } catch { /* ignore */ }
      if (state.db) {
        try { state.db.close(); } catch { /* already closed */ }
        state.db = null;
      }
      state.capture = null;
      state.embedder = null;
    },
  };
}

