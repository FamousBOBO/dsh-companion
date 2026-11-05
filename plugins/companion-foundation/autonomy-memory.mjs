// P2 experience -> long-term memory bridge (contract v1.2 section 5).
//
// Two bugs motivated this module:
//
//   1. The scope was parsed with `split(':')` on every segment, so `w:world:default`
//      became `worldId:'world'`. The memory engine treats any non-default world as a
//      fiction scope and rejects the ingest (`world-scope-mismatch`): every experience
//      write silently failed. Scope parsing now uses the runtime's own `parseScope`
//      (with a documented fallback that splits on `|` and then on the *first* `:` only).
//   2. The dedupe key was built from whatever happened to be in scope, so the same
//      finished activity could produce different event ids. The key is now frozen:
//      `sha256(scopeKey|activityId|operation|sourceHash|consumedFrom|consumedTo|artifactVersion)`,
//      prefixed `p2_` to stay recognisable in the memory receipt log.
//
// The port writes only through the existing public entry `engine.ingestDomainEvent`
// (memory CONTRACT section 16) and never touches the memory database. If the engine is
// unavailable at completion time the same request is queued into the runtime's *existing*
// `memory_outbox` through an injected outbox port — there is no second outbox — so the
// next writer drains it exactly once.

import crypto from 'node:crypto';
import { DEFAULT_WORLD, parseScope } from '../companion-runtime/lib/scope.mjs';

export const EXPERIENCE_NAMESPACE = 'p2/experience';
export const EXPERIENCE_TRANSFORM_VERSION = 'p2-experience-v1';
export const EXPERIENCE_REALITY_STATUS = 'actual_tool_activity';
export const EXPERIENCE_EVIDENCE_STATUS = 'observed';
export const EXPERIENCE_OPERATION = 'finish';
export const MAX_CONTENT_CHARS = 600;
export const MAX_TARGET_CHARS = 80;
export const MAX_REF_CHARS = 120;
export const MAX_HASH_CHARS = 64;

/** The ordered tuple the frozen dedupe key is derived from. */
export const EXPERIENCE_KEY_FIELDS = Object.freeze([
  'scopeKey', 'activityId', 'operation', 'sourceHash', 'consumedFrom', 'consumedTo', 'artifactVersion',
]);

function textOf(value) {
  return typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value));
}

export function sha256(text) {
  return crypto.createHash('sha256').update(String(text ?? '')).digest('hex');
}

function safeMessage(error) {
  return (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 200);
}

/**
 * Parse a runtime scope key into its three parts.
 *
 * Uses the runtime `parseScope` first (the same function the runtime and the memory
 * bridge use), then falls back to splitting on `|` and on the first `:` of each segment
 * only — `w:world:default` must stay whole.
 */
export function parseScopeKey(scopeKey) {
  const text = textOf(scopeKey).trim();
  if (!text) return null;
  try {
    const scope = parseScope(text);
    if (scope && scope.userId && scope.personaId) {
      return { userId: scope.userId, personaId: scope.personaId, worldId: scope.worldId || DEFAULT_WORLD, via: 'parseScope' };
    }
  } catch { /* wildcard or malformed: fall through to the local parse */ }
  const segments = text.split('|');
  const parts = {};
  for (const segment of segments) {
    const at = segment.indexOf(':');
    if (at <= 0) continue;
    const key = segment.slice(0, at).trim();
    const value = segment.slice(at + 1).trim();
    if (!key || !value) continue;
    if (key === 'u' || key === 'p' || key === 'w') parts[key] = value;
  }
  const userId = textOf(parts.u).trim();
  const personaId = textOf(parts.p).trim();
  if (!userId || !personaId || userId === '*' || personaId === '*') return null;
  const worldId = textOf(parts.w).trim() || DEFAULT_WORLD;
  if (worldId === '*') return null;
  return { userId, personaId, worldId, via: 'first-colon' };
}

/** A stable surrogate activity key for callers that cannot pass `activityId` yet. */
function surrogateActivityKey({ scopeKey, kind, target, sourceRef, sourceHash, artifactRef }) {
  const tuple = [scopeKey, kind, target, sourceRef, sourceHash, artifactRef].map(value => textOf(value));
  return `surrogate:${sha256(tuple.join('|')).slice(0, 32)}`;
}

/**
 * Build the deterministic experience identity.
 *
 * `basis` is `activityId` when the caller passed a real activity id (the frozen tuple),
 * and `surrogate` when it did not — the surrogate is derived from the activity's own
 * content identity so it stays stable across restarts and still dedupes.
 */
export function experienceIdentity(input = {}) {
  const scopeKey = textOf(input.scopeKey).trim();
  const operation = textOf(input.operation).trim() || EXPERIENCE_OPERATION;
  const sourceHash = textOf(input.sourceHash).trim().slice(0, MAX_HASH_CHARS);
  const activityId = textOf(input.activityId).trim();
  const consumed = Math.max(0, Math.trunc(Number(input.consumed) || 0));
  const from = Number.isFinite(Number(input.consumedFrom)) ? Math.max(0, Math.trunc(Number(input.consumedFrom))) : 0;
  const toRaw = Number.isFinite(Number(input.consumedTo)) ? Math.trunc(Number(input.consumedTo)) : consumed;
  const consumedFrom = Math.min(from, toRaw);
  const consumedTo = Math.max(from, toRaw);
  const artifactVersion = Math.max(0, Math.trunc(Number(input.artifactVersion) || 0));
  const basis = activityId ? 'activityId' : 'surrogate';
  const keyActivity = activityId || surrogateActivityKey({
    scopeKey,
    kind: input.kind,
    target: input.target,
    sourceRef: input.sourceRef,
    sourceHash,
    artifactRef: input.artifactRef,
  });
  const parts = { scopeKey, activityId: keyActivity, operation, sourceHash, consumedFrom, consumedTo, artifactVersion };
  const tuple = EXPERIENCE_KEY_FIELDS.map(field => String(parts[field] ?? ''));
  const eventId = `p2_${sha256(tuple.join('|'))}`;
  return { eventId, tuple, parts, basis };
}

/** Bounded, body-free description of what actually happened. */
export function experienceDescription(input = {}, maxChars = MAX_CONTENT_CHARS) {
  const kind = textOf(input.kind).trim() || 'activity';
  const label = kind === 'read' ? '阅读' : kind === 'explore' ? '探索' : kind === 'write' ? '创作' : '活动';
  const target = textOf(input.target).trim().slice(0, MAX_TARGET_CHARS);
  const consumedTo = Math.max(0, Math.trunc(Number(input.consumedTo ?? input.consumed) || 0));
  const consumedFrom = Math.max(0, Math.trunc(Number(input.consumedFrom) || 0));
  const delta = Math.max(0, consumedTo - consumedFrom);
  const artifactVersion = Math.max(0, Math.trunc(Number(input.artifactVersion) || 0));
  const lines = [
    `${label}: ${target || '（无标题）'}`,
    delta > 0 ? `已处理 ${delta} 字（${consumedFrom}–${consumedTo}）` : '',
    artifactVersion > 0 ? `作品版本 v${artifactVersion}` : '',
    textOf(input.artifactRef).trim() ? `产物 ${textOf(input.artifactRef).trim().slice(0, MAX_REF_CHARS)}` : '',
    textOf(input.sourceRef).trim() ? `来源 ${textOf(input.sourceRef).trim().slice(0, MAX_REF_CHARS)}` : '',
    textOf(input.sourceHash).trim() ? `来源指纹 ${textOf(input.sourceHash).trim().slice(0, 16)}` : '',
  ].filter(Boolean);
  return lines.join('；').slice(0, Math.max(40, Math.trunc(Number(maxChars) || MAX_CONTENT_CHARS)));
}

/**
 * Build one `ingestDomainEvent` request. Never writes: the caller decides.
 *
 * Returns `{ ok:false, code:'no-experience' }` when a finished activity genuinely has
 * nothing worth remembering — that is a legal outcome, not an error.
 */
export function buildExperienceRequest(input = {}, { now = () => Date.now(), maxContentChars = MAX_CONTENT_CHARS } = {}) {
  const reality = textOf(input.reality ?? input.realityStatus).trim() || EXPERIENCE_REALITY_STATUS;
  if (reality !== EXPERIENCE_REALITY_STATUS) {
    // Simulated or hypothetical life never becomes a memory, at any call site.
    return { ok: false, code: 'simulated-not-remembered', reality };
  }
  const scopeKey = textOf(input.scopeKey).trim();
  const scope = parseScopeKey(scopeKey);
  if (!scope) return { ok: false, code: 'unbound', reason: 'scope-unparsed' };
  const identity = experienceIdentity({ ...input, scopeKey });
  const { consumedFrom, consumedTo, artifactVersion } = identity.parts;
  const artifactRef = textOf(input.artifactRef).trim();
  const artifactHash = textOf(input.artifactHash).trim();
  const evidenced = consumedTo > consumedFrom || (artifactVersion > 0 && Boolean(artifactRef || artifactHash));
  if (!evidenced) return { ok: false, code: 'no-experience', reason: 'no-evidence', identity };
  const content = experienceDescription({ ...input, ...identity.parts, kind: input.kind, consumedFrom, consumedTo, artifactVersion }, maxContentChars);
  if (!content.trim()) return { ok: false, code: 'no-experience', reason: 'empty-content', identity };
  const occurredAt = Number(input.at) || Number(now()) || Date.now();
  return {
    ok: true,
    value: {
      subject: { userId: scope.userId, personaId: scope.personaId, worldId: scope.worldId },
      namespace: EXPERIENCE_NAMESPACE,
      eventId: identity.eventId,
      transformVersion: EXPERIENCE_TRANSFORM_VERSION,
      content,
      occurredAt,
      realityStatus: EXPERIENCE_REALITY_STATUS,
      evidenceStatus: EXPERIENCE_EVIDENCE_STATUS,
    },
    meta: {
      scopeKey,
      scopeVia: scope.via,
      worldId: scope.worldId,
      identityBasis: identity.basis,
      keyParts: identity.parts,
      eventId: identity.eventId,
      consumedFrom,
      consumedTo,
      artifactVersion,
    },
  };
}

/**
 * Build the port the runtime calls for one finished activity.
 *
 * @param engine  the shared memory engine (only `ingestDomainEvent` is used)
 * @param outbox  `{ enqueue(request), drain?() }` backed by the runtime `memory_outbox`
 * @param now     injectable clock
 */
export function createMemoryPort({ engine = null, outbox = null, now = () => Date.now(), maxContentChars = MAX_CONTENT_CHARS } = {}) {
  function outboxWired() {
    return Boolean(outbox && typeof outbox.enqueue === 'function');
  }

  function engineAvailable() {
    return Boolean(engine && typeof engine.ingestDomainEvent === 'function');
  }

  /** Queue the unconfirmed request into the runtime's existing outbox (idempotent key). */
  async function enqueue(request, meta, cause, reason) {
    if (!outboxWired()) {
      return { ok: false, code: 'memory-engine-unavailable', written: false, outbox: 'unwired', cause, reason: reason || cause, eventId: request.eventId, ...meta };
    }
    let queued;
    try {
      queued = await outbox.enqueue({
        scopeKey: meta.scopeKey,
        subject: request.subject,
        namespace: request.namespace,
        eventId: request.eventId,
        transformVersion: request.transformVersion,
        realityStatus: request.realityStatus,
        evidenceStatus: request.evidenceStatus,
        content: request.content,
        occurredAt: request.occurredAt,
      });
    } catch (error) {
      queued = { ok: false, code: 'memory-outbox-failed', reason: safeMessage(error) };
    }
    if (!queued || queued.ok !== true) {
      return { ok: false, code: 'memory-outbox-failed', written: false, cause, eventId: request.eventId, reason: textOf(queued?.reason).slice(0, 120) || 'outbox-rejected', ...meta };
    }
    return {
      ok: true,
      status: textOf(queued.status) || 'queued',
      written: false,
      queued: queued.queued !== false,
      duplicate: queued.duplicate === true || queued.queued === false,
      outboxId: textOf(queued.outboxId),
      cause,
      eventId: request.eventId,
      ...meta,
    };
  }

  async function recordExperience(input = {}) {
    const built = buildExperienceRequest(input, { now, maxContentChars });
    if (!built.ok) {
      // A legitimately empty completion is a success with zero writes.
      if (built.code === 'no-experience') return { ok: true, status: 'skipped', written: false, code: 'no-experience', reason: built.reason ?? '' };
      return { ...built, written: false };
    }
    const { value, meta } = built;
    if (!engineAvailable()) return enqueue(value, meta, 'engine-absent', 'memory-engine-absent');
    let result;
    try {
      result = await engine.ingestDomainEvent(value);
    } catch (error) {
      result = { status: 'retryable_failure', reason: safeMessage(error) };
    }
    const status = textOf(result?.status).trim();
    const receiptId = textOf(result?.receiptId);
    if (status === 'accepted' || status === 'pending' || status === 'duplicate') {
      return {
        ok: true,
        status,
        written: status !== 'duplicate',
        duplicate: status === 'duplicate',
        receiptId,
        reason: textOf(result?.reason),
        eventId: value.eventId,
        ...meta,
      };
    }
    if (status === 'rejected') {
      // Permanent refusal (unbound subject, world mismatch, sensitive content ...): queueing
      // it would only replay the same rejection, so report it honestly and write nothing.
      return { ok: false, status, code: 'memory-rejected', written: false, reason: textOf(result?.reason) || 'rejected', receiptId, eventId: value.eventId, ...meta };
    }
    return enqueue(value, meta, status || 'unknown', textOf(result?.reason) || 'memory-unavailable');
  }

  /** Forward the drain when the runtime exposes one; the runtime owns the real drain. */
  async function drain() {
    if (!outbox || typeof outbox.drain !== 'function') return { ok: false, code: 'outbox-unwired', drained: 0 };
    try {
      const result = await outbox.drain();
      return { ok: result?.ok !== false, drained: Number(result?.drained ?? result?.delivered ?? 0) || 0, detail: result ?? null };
    } catch (error) {
      return { ok: false, code: 'outbox-drain-failed', drained: 0, reason: safeMessage(error) };
    }
  }

  return {
    available: engineAvailable(),
    recordExperience,
    drain,
    describe: () => ({
      namespace: EXPERIENCE_NAMESPACE,
      transformVersion: EXPERIENCE_TRANSFORM_VERSION,
      realityStatus: EXPERIENCE_REALITY_STATUS,
      evidenceStatus: EXPERIENCE_EVIDENCE_STATUS,
      engine: engineAvailable() ? 'mounted' : 'absent',
      outbox: outboxWired() ? 'wired' : 'unwired',
      keyFields: [...EXPERIENCE_KEY_FIELDS],
    }),
  };
}
