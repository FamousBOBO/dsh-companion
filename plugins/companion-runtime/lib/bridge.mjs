import crypto from 'node:crypto';
import { ValidationError } from './errors.mjs';
import { normalizeScope, parseScope, scopeKey as scopeKeyOf, digest } from './scope.mjs';

// C3 cross-database bridge: the runtime queues what memory should learn, and a
// later drain hands each queued request to the memory public entry
// (`engine.ingestDomainEvent`, memory CONTRACT.md §16). Two rules keep it honest:
//
//   1. The runtime never writes memory tables and never decides visibility. It
//      only queues a request and stores the receipt memory hands back.
//   2. A drain that cannot reach memory reports "still queued". It never marks a
//      row delivered, never fabricates a receipt and never lets a memory failure
//      escape into a chat path (A11).
//
// When memory is missing, reloading or degraded, the queued rows stay in
// `memory_outbox` where diagnostics can see them; they are retried on the next
// drain instead of being dropped or double-written.

export const MEMORY_INGEST_METHOD = 'ingestDomainEvent';
// Queue lifecycle: queued -> sent (memory accepted/pending/duplicate, receipt kept)
// or queued -> failed (memory rejected permanently). Retryable deliveries stay
// queued with an attempt counter. These names match lib/diagnostics.mjs
// (`outbox.sent` / `outbox.failed`) so status reading and writing cannot drift.
export const MEMORY_OUTBOX_STATUS = Object.freeze(['queued', 'sent', 'failed']);
export const DEFAULT_NAMESPACE = 'companion.event';
export const CORRECTION_NAMESPACE = 'companion.correction';
export const DEFAULT_DRAIN_LIMIT = 20;
export const MAX_DRAIN_LIMIT = 200;

/** Stable outbox id: re-enqueuing the same ingest request keeps one row. */
export function outboxIdFor({ scopeKey, eventId, namespace, transformVersion }) {
  const material = [scopeKey, eventId, namespace, transformVersion].map(value => String(value ?? ''));
  return 'out_' + crypto.createHash('sha256').update(material.join('\u0001')).digest('hex').slice(0, 32);
}

function clockOf(now, db) {
  if (typeof now === 'function') {
    const value = Number(now());
    return Number.isFinite(value) ? Math.trunc(value) : db.now();
  }
  if (now !== undefined && now !== null && now !== '' && Number.isFinite(Number(now))) {
    return Math.trunc(Number(now));
  }
  return db.now();
}

function resolveScope({ scope, scopeKey } = {}) {
  if (scope && typeof scope === 'object') return normalizeScope(scope);
  if (typeof scopeKey === 'string' && scopeKey.trim()) {
    const parsed = parseScope(scopeKey.trim());
    if (parsed) return parsed;
  }
  throw new ValidationError('a resolved scope or scopeKey is required to queue a memory ingest');
}

function transformVersionOf(payload, event) {
  const raw = payload?.transformVersion ?? payload?.transform_version ?? event?.configVersion ?? '';
  const text = typeof raw === 'number' && Number.isFinite(raw)
    ? String(raw)
    : (typeof raw === 'string' ? raw.trim() : '');
  return text || 'v1';
}

function eventIdOf(event, payload) {
  if (typeof event === 'string' && event.trim()) return event.trim();
  if (event && typeof event.eventId === 'string' && event.eventId.trim()) return event.eventId.trim();
  const fromPayload = payload?.eventId;
  return typeof fromPayload === 'string' ? fromPayload.trim() : '';
}

function optionalMentionPolicy(payload) {
  const value = payload?.mentionPolicy ?? payload?.mention_policy;
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

/**
 * Queue one memory ingest request. The runtime-side dedupe key is the same tuple
 * memory will use (namespace, scopeKey, eventId, transformVersion), so an enqueue
 * repeated after a crash never creates a second outbox row.
 *
 * `owner`/`generation` are optional here and **required** for the standalone entry points that
 * are reached without an enclosing event transaction (the runtime's `enqueueMemoryIngest`): this
 * is the real INSERT of the outbox row, so it is a writer-mutating path that must be fenced by
 * the lease, not just by a generation label (Codex review R6). Consumers that run *inside*
 * `dispatchEvent` already had their append fenced there, so they may omit them.
 */
export function enqueueIngest(db, { scope, scopeKey, event, namespace, payload, now, owner = null, generation = null } = {}) {
  if (!db || typeof db.tx !== 'function') throw new ValidationError('a runtime database handle is required');
  const body = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload
    : (event?.payload && typeof event.payload === 'object' && !Array.isArray(event.payload) ? event.payload : {});
  const eventId = eventIdOf(event, body);
  if (!eventId) throw new ValidationError('eventId is required to queue a memory ingest');
  const target = resolveScope({ scope, scopeKey });
  const key = scopeKeyOf(target);
  const requested = typeof namespace === 'string' && namespace.trim() ? namespace.trim() : '';
  const fromPayload = typeof body.namespace === 'string' && body.namespace.trim() ? body.namespace.trim() : '';
  const state = requested || fromPayload || DEFAULT_NAMESPACE;
  const content = String(body.content ?? event?.payload?.content ?? '').trim();
  if (!content) throw new ValidationError('memory ingest payload requires non-empty content');
  const transformVersion = transformVersionOf(body, event);
  const envelope = {
    content,
    transformVersion,
    realityStatus: event?.realityStatus ?? body.realityStatus ?? 'hypothetical',
    evidenceStatus: event?.evidenceStatus ?? body.evidenceStatus ?? 'observed',
    rootEvidenceIds: Array.isArray(event?.rootEvidenceIds)
      ? [...event.rootEvidenceIds]
      : (Array.isArray(body.rootEvidenceIds) ? [...body.rootEvidenceIds] : []),
    occurredAt: Number.isFinite(Number(event?.occurredAt))
      ? Math.trunc(Number(event.occurredAt))
      : (Number.isFinite(Number(body.occurredAt)) ? Math.trunc(Number(body.occurredAt)) : clockOf(now, db)),
  };
  const mentionPolicy = optionalMentionPolicy(body);
  if (mentionPolicy) envelope.mentionPolicy = mentionPolicy;
  // P2.5-2 (A4 §2.5 E2): carry the producer's significance verdict into the outbox row, so the
  // drain hands memory the same field the producer decided on. `routine` is meaningful (it means
  // "history only"), so an absent value and an explicit one must stay distinguishable.
  if (body.significance === 'notable' || body.significance === 'routine') envelope.significance = body.significance;
  // Correction seam (A/B): what this ingest replaces must survive the outbox round-trip, otherwise
  // memory receives a plain "new fact" and the old one keeps coming back from recall.
  if (typeof body.supersedesHint === 'string' && body.supersedesHint.trim()) {
    envelope.supersedesHint = body.supersedesHint.trim().slice(0, 200);
  }
  // task-38: an operator's exact-id decision must reach memory unchanged (no text matching).
  if (Array.isArray(body.supersedeIds) && body.supersedeIds.length) {
    envelope.supersedeIds = body.supersedeIds.map(value => String(value ?? '').trim()).filter(Boolean).slice(0, 10);
  }
  const outboxId = outboxIdFor({ scopeKey: key, eventId, namespace: state, transformVersion });
  const at = clockOf(now, db);
  return db.tx(() => {
    // R6: the outbox INSERT is a production-reachable write outside the event path. When the
    // caller knows its writer identity, the lease is checked *inside* this transaction and at
    // the transaction's own instant (never a stale `at` captured before the await/tx began).
    if (owner || generation) {
      if (typeof db.assertLeaseValid === 'function') db.assertLeaseValid({ owner, generation, at: db.now(), requireRow: true });
      else db.assertWritable(generation, { owner });
    }
    const inserted = db.run(
      `INSERT INTO memory_outbox
         (outbox_id, scope, event_id, namespace, payload, status, receipt_id, attempts, last_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'queued', '', 0, '', ?, ?)
       ON CONFLICT(outbox_id) DO NOTHING`,
      outboxId, key, eventId, state, JSON.stringify(envelope), at, at,
    );
    const row = db.get('SELECT status, receipt_id, attempts FROM memory_outbox WHERE outbox_id = ?', outboxId);
    return {
      outboxId,
      queued: Number(inserted?.changes ?? 0) > 0,
      status: row?.status ?? 'queued',
      receiptId: row?.receipt_id ?? '',
      attempts: Number(row?.attempts ?? 0),
    };
  });
}

/**
 * `bridge` consumer reducer. It records the ingest request in the outbox inside the
 * same transaction that commits the consumer receipt (`extra`), so an event can
 * never be marked consumed while its memory request was lost.
 */
export function applyBridgeEvent({ db, event, slice, now } = {}) {
  if (!db || !event) throw new ValidationError('applyBridgeEvent requires db and event');
  const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
  const requested = typeof payload.namespace === 'string' && payload.namespace.trim() ? payload.namespace.trim() : '';
  const fallback = event.kind === 'memory/correction-request' ? CORRECTION_NAMESPACE : DEFAULT_NAMESPACE;
  const namespace = requested || fallback;
  const content = typeof payload.content === 'string' ? payload.content.trim() : '';
  if (!content) {
    // Nothing to queue: report why instead of writing a placeholder record.
    return { result: { namespace, eventId: event.eventId, queued: false, reason: 'missing-content' } };
  }
  return {
    result: {
      namespace,
      eventId: event.eventId,
      queued: true,
      contentDigest: digest(content, 16),
    },
    extra(handle) {
      enqueueIngest(handle, { scope: event.scope, scopeKey: event.scopeKey, event, namespace, payload, now });
    },
  };
}

function parsePayload(row) {
  try {
    const parsed = JSON.parse(row.payload || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Rebuild exactly the public ingest request memory expects from one outbox row. */
function requestFromRow(row) {
  const payload = parsePayload(row);
  const parsed = parseScope(row.scope);
  const subject = parsed
    ? { userId: parsed.userId, personaId: parsed.personaId, worldId: parsed.worldId }
    : { userId: '', personaId: '', worldId: '' };
  const occurredAt = Number(payload.occurredAt);
  const request = {
    subject,
    namespace: String(row.namespace ?? ''),
    eventId: String(row.event_id ?? ''),
    transformVersion: payload.transformVersion ?? 'v1',
    rootEvidenceIds: Array.isArray(payload.rootEvidenceIds) ? payload.rootEvidenceIds : [],
    realityStatus: payload.realityStatus ?? 'hypothetical',
    evidenceStatus: payload.evidenceStatus ?? 'observed',
    content: typeof payload.content === 'string' ? payload.content : '',
    occurredAt: Number.isFinite(occurredAt) ? occurredAt : 0,
  };
  if (typeof payload.mentionPolicy === 'string' && payload.mentionPolicy) request.mentionPolicy = payload.mentionPolicy;
  if (typeof payload.supersedesHint === 'string' && payload.supersedesHint) request.supersedesHint = payload.supersedesHint;
  if (Array.isArray(payload.supersedeIds) && payload.supersedeIds.length) request.supersedeIds = payload.supersedeIds;
  // P2.5-2 (A4 §2.5 E2): the producer's significance verdict must reach memory, otherwise memory
  // cannot route on it and every activity lands as a durable memory again. Only the frozen values
  // are forwarded; anything else is dropped so an unknown producer cannot switch the policy.
  if (payload.significance === 'notable' || payload.significance === 'routine') request.significance = payload.significance;
  return request;
}

/** Stable reason codes only: never persist memory error text or record content. */
function safeCode(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim().toLowerCase();
  if (!text || text.length > 80) return '';
  return /^[a-z0-9._:-]+$/.test(text) ? text : '';
}

function errorCode(error) {
  const code = error && typeof error === 'object' ? error.code : '';
  return safeCode(code) || 'memory-threw';
}

function countQueued(db, scopeKey) {
  const row = scopeKey
    ? db.get("SELECT COUNT(*) AS n FROM memory_outbox WHERE status = 'queued' AND scope = ?", scopeKey)
    : db.get("SELECT COUNT(*) AS n FROM memory_outbox WHERE status = 'queued'");
  return Number(row?.n ?? 0);
}

const CLAIM_TTL_MS = 60_000;
const DEFAULT_CALL_TIMEOUT_MS = 30_000;

/** A hung memory call must not block this handle forever (validation V6 / N-hang). */
function withCallTimeout(promise, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`memory call timed out after ${timeoutMs} ms`);
      error.code = 'memory-timeout';
      reject(error);
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => { try { clearTimeout(timer); } catch { /* ignore */ } });
}

/**
 * Give up this drain's claim after a timeout. Releasing the claim is the fence: the
 * late answer can no longer match `claim_owner = token`, so it cannot write `sent`,
 * `attempts` or `last_error` (validation V6 late-result fence).
 */
function abandonClaim(db, outboxId, code, at, generation, token, owner = null) {
  return db.tx(() => {
    db.assertWritable(generation, { owner });
    const result = db.run(
      `UPDATE memory_outbox SET last_error = ?, attempts = attempts + 1, updated_at = ?,
              claimed_until = 0, claim_owner = ''
        WHERE outbox_id = ? AND status = 'queued' AND claim_owner = ?`,
      code, at, outboxId, token,
    );
    return Number(result?.changes ?? 0) > 0;
  });
}

// Drains on the same database handle run one at a time, so a slow memory call cannot
// let a second drain expire the first one's claim and deliver the same record again
// (R3, fourth review). Cross-database concurrency is still fenced by the single-writer
// lease plus the per-claim token below.
const DRAIN_LOCKS = new WeakMap();

function withDrainLock(db, work) {
  const previous = DRAIN_LOCKS.get(db) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(work);
  DRAIN_LOCKS.set(db, current.catch(() => {}));
  return current;
}

function claimToken(generation) {
  return `${String(generation ?? 'drain')}:${crypto.randomUUID()}`;
}

/**
 * The retry delay after `attempts` failures (Codex round-2 §二.8).
 *
 * Exponential with a 30 s base and a 30 min ceiling: a permanently failing row stops occupying the
 * head of every batch, while a transient failure is still retried within the same minute.
 */
export function retryBackoffMs(attempts) {
  const count = Math.max(1, Math.trunc(Number(attempts) || 1));
  return Math.min(RETRY_BACKOFF_MAX_MS, RETRY_BACKOFF_BASE_MS * (2 ** Math.min(8, count - 1)));
}

const RETRY_BACKOFF_BASE_MS = 30_000;
const RETRY_BACKOFF_MAX_MS = 30 * 60_000;

/**
 * Ledger a failed attempt and **back off** (round-2 §二.8).
 *
 * The claim is not released for immediate reuse: `claimed_until` is pushed into the future with an
 * exponential backoff, and `claimRows` already selects `status='queued' AND claimed_until <= now`.
 * An existing column therefore expresses "do not touch this row before T" with **no schema
 * change**, and the rows behind the failing one get their turn instead of starving.
 */
function markAttempt(db, outboxId, code, at, generation, token, owner = null) {
  return db.tx(() => {
    // A failure report is still a write: after stop or takeover it must be fenced like
    // any other write, otherwise a dead drain rewrites attempts/last_error and clears
    // the claim of a live one (fifth review, B2).
    db.assertWritable(generation, { owner });
    const prior = db.get('SELECT attempts FROM memory_outbox WHERE outbox_id = ? AND status = ?', outboxId, 'queued');
    const nextAttempts = Number(prior?.attempts ?? 0) + 1;
    const result = db.run(
      `UPDATE memory_outbox SET last_error = ?, attempts = attempts + 1, updated_at = ?,
              claimed_until = ?, claim_owner = ''
        WHERE outbox_id = ? AND status = 'queued' AND claim_owner = ?`,
      code, at, at + retryBackoffMs(nextAttempts), outboxId, token,
    );
    return Number(result?.changes ?? 0) > 0;
  });
}

// Once a request is terminal (sent or failed) the runtime no longer needs the
// experience text: memory owns the record from then on. Keep an envelope with the
// digest so a later audit can prove which text was handed over, without copying the
// user's words into a second database indefinitely.
function scrubbedPayload(db, outboxId, at) {
  let payload = {};
  try { payload = JSON.parse(db.get('SELECT payload FROM memory_outbox WHERE outbox_id = ?', outboxId)?.payload || '{}'); } catch { payload = {}; }
  const content = typeof payload.content === 'string' ? payload.content : '';
  return JSON.stringify({
    transformVersion: payload.transformVersion ?? 'v1',
    realityStatus: payload.realityStatus ?? '',
    evidenceStatus: payload.evidenceStatus ?? '',
    rootEvidenceIds: Array.isArray(payload.rootEvidenceIds) ? payload.rootEvidenceIds : [],
    occurredAt: payload.occurredAt ?? null,
    contentDigest: content ? digest(content, 32) : '',
    scrubbedAt: at,
  });
}

function markDelivered(db, outboxId, outcome, at, generation, token, owner = null, eventId = '') {
  const receiptId = typeof outcome?.receiptId === 'string' ? outcome.receiptId : '';
  // round-3 B7: "memory answered duplicate" is not a new write, and the two must be countable apart.
  // `last_error` is free text in the existing schema (zero migration); the observability layer counts
  // this marker as a duplicate hit instead of a delivered memory.
  const duplicateMark = String(outcome?.status ?? '') === 'duplicate' || outcome?.duplicate === true ? 'duplicate-hit' : '';
  // round-4 follow-up: `sent` alone does not mean "the correction took effect", and squeezing the
  // receipt into the free-text `last_error` column was brittle (`not-applied=` contains `applied=`).
  // The receipt is structured and lives in `runtime_meta` — zero migration, nothing to parse.
  const supersedeReceipt = outcome && typeof outcome.supersede === 'object' && outcome.supersede
    ? {
      applied: Array.isArray(outcome.supersede.applied) ? outcome.supersede.applied.map(String).filter(Boolean) : [],
      duplicate: Array.isArray(outcome.supersede.duplicate) ? outcome.supersede.duplicate.map(String).filter(Boolean) : [],
      notApplied: Array.isArray(outcome.supersede.notApplied) ? outcome.supersede.notApplied.map(String).filter(Boolean) : [],
      reason: String(outcome.supersede.reason ?? ''),
      at,
    }
    : null;
  return db.tx(() => {
    // `sent` is the most sensitive delivery fact in the system, so it takes the full writer
    // gate: a drain whose lease lapsed must not record a delivery it is no longer entitled
    // to write (P2.5-4A).
    db.assertWritable(generation, { owner });
    // The claim query does not always select `event_id`; read it here rather than threading a column
    // through (a missing id would silently skip the receipt — measured in correction-e2e).
    let receiptKey = String(eventId ?? '').trim();
    if (supersedeReceipt && !receiptKey) {
      try { receiptKey = String(db.get('SELECT event_id FROM memory_outbox WHERE outbox_id = ?', outboxId)?.event_id ?? ''); } catch { receiptKey = ''; }
    }
    if (supersedeReceipt && receiptKey) {
      db.run(`INSERT INTO runtime_meta (meta_key, meta_value, updated_at) VALUES (?, ?, ?)
              ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value, updated_at = excluded.updated_at`,
      `p2_correction_apply:${receiptKey}`, JSON.stringify(supersedeReceipt), at);
    }
    const result = db.run(
      `UPDATE memory_outbox
          SET status = 'sent',
              receipt_id = CASE WHEN ? <> '' THEN ? ELSE receipt_id END,
              last_error = ?,
              attempts = attempts + 1,
              claimed_until = 0,
              claim_owner = '',
              payload = ?,
              updated_at = ?
        WHERE outbox_id = ? AND status = 'queued' AND claim_owner = ?`,
      receiptId, receiptId, duplicateMark, scrubbedPayload(db, outboxId, at), at, outboxId, token,
    );
    return Number(result?.changes ?? 0) > 0;
  });
}

function markRejected(db, outboxId, outcome, at, generation, token, owner = null) {
  const receiptId = typeof outcome?.receiptId === 'string' ? outcome.receiptId : '';
  const reason = safeCode(outcome?.reason) || 'rejected';
  return db.tx(() => {
    db.assertWritable(generation, { owner });
    const result = db.run(
      `UPDATE memory_outbox
          SET status = 'failed',
              receipt_id = CASE WHEN ? <> '' THEN ? ELSE receipt_id END,
              last_error = ?,
              attempts = attempts + 1,
              claimed_until = 0,
              claim_owner = '',
              payload = ?,
              updated_at = ?
        WHERE outbox_id = ? AND status = 'queued' AND claim_owner = ?`,
      receiptId, receiptId, reason, scrubbedPayload(db, outboxId, at), at, outboxId, token,
    );
    return Number(result?.changes ?? 0) > 0;
  });
}

/**
 * Claim queued rows for this drain, in one write transaction.
 *
 * Two drains (same process, another process, or a reloaded generation) must not hand
 * the same record to memory twice, so the snapshot is only taken by whoever wins the
 * claim: rows carry `claimed_until` and a claimant, and a concurrent drain sees none.
 * A crashed claimant's rows become eligible again after the TTL and memory's idempotent
 * receipt makes that retry safe.
 */
function claimRows(db, { scopeKey, size, at, generation, token, owner = null }) {
  return db.tx(() => {
    db.assertWritable(generation, { owner });
    const rows = scopeKey
      ? db.all(`SELECT * FROM memory_outbox
          WHERE status = 'queued' AND claimed_until <= ? AND scope = ?
          ORDER BY created_at ASC, outbox_id ASC LIMIT ?`, at, scopeKey, size)
      : db.all(`SELECT * FROM memory_outbox
          WHERE status = 'queued' AND claimed_until <= ?
          ORDER BY created_at ASC, outbox_id ASC LIMIT ?`, at, size);
    if (!rows.length) return [];
    const claimedUntil = at + CLAIM_TTL_MS;
    for (const row of rows) {
      db.run('UPDATE memory_outbox SET claimed_until = ?, claim_owner = ? WHERE outbox_id = ? AND status = ?',
        claimedUntil, token, row.outbox_id, 'queued');
    }
    return rows;
  });
}

/**
 * Extend and re-assert this drain's claim on `outboxId` right before an external call.
 *
 * A claim that has meanwhile expired, been taken over, or whose row already reached a
 * terminal status is not ours any more: return false and let the caller stop without
 * handing the record to memory (R3/R4).
 *
 * Codex review R6: this UPDATE re-arms the delivery window for the *next* external call, so it is
 * a write that must be fenced by the lease too — and by the transaction's own instant, never by
 * the `at` that was captured when the drain started (a drain can outlive its lease while a slow
 * memory call is in flight).
 */
function refreshClaim(db, outboxId, token, at, { generation = null, owner = null } = {}) {
  return db.tx(() => {
    if (generation || owner) {
      if (typeof db.assertLeaseValid === 'function') db.assertLeaseValid({ owner, generation, at: db.now(), requireRow: true });
      else db.assertWritable(generation, { owner });
    }
    const result = db.run(
      'UPDATE memory_outbox SET claimed_until = ? WHERE outbox_id = ? AND status = ? AND claim_owner = ?',
      at + CLAIM_TTL_MS, outboxId, 'queued', token,
    );
    return Number(result?.changes ?? 0) > 0;
  });
}

/**
 * Deliver queued requests to the memory public entry.
 *
 * Idempotent and single-claimant: only `status='queued'` rows that nobody else has
 * claimed are touched, sent/failed rows are never re-sent, and a concurrent drain gets
 * an empty batch. When `memory` is null, misses `ingestDomainEvent` or throws, every
 * processed row stays queued with its attempt counter incremented — the drain never
 * claims a success it did not receive (A11).
 */
export async function drainOutbox({ db, memory, scopeKey, now, limit, generation, owner = null, callTimeoutMs, onAmbiguousCorrection = null } = {}) {
  if (!db || typeof db.all !== 'function') throw new ValidationError('a runtime database handle is required');
  return withDrainLock(db, () => drainOnce({ db, memory, scopeKey, now, limit, generation, owner, callTimeoutMs, onAmbiguousCorrection }));
}

async function drainOnce({ db, memory, scopeKey, now, limit, generation, owner = null, callTimeoutMs, onAmbiguousCorrection = null }) {
  const timeoutMs = Number.isFinite(Number(callTimeoutMs)) && Number(callTimeoutMs) > 0
    ? Number(callTimeoutMs) : DEFAULT_CALL_TIMEOUT_MS;
  const size = Math.min(
    MAX_DRAIN_LIMIT,
    Math.max(1, Math.trunc(Number.isFinite(Number(limit)) ? Number(limit) : DEFAULT_DRAIN_LIMIT)),
  );
  const at = clockOf(now, db);
  const token = claimToken(generation);
  const rows = claimRows(db, { scopeKey, size, at, generation, token, owner });
  const summary = { processed: 0, delivered: 0, rejected: 0, retryable: 0, lostClaim: 0, skipped: '', queued: 0 };
  if (!rows.length) {
    summary.queued = countQueued(db, scopeKey);
    return summary;
  }
  // A drain that lost the writer role must stop quietly and report it, never throw: since
  // P2.5-4A the write gate also refuses an expired lease, which is the same "not ours any
  // more" situation as a takeover.
  const fenced = error => {
    const code = error && typeof error === 'object' ? String(error.code ?? '') : '';
    return code === 'stale-generation' || code === 'runtime-stopped' || code === 'db-closed'
      || code === 'lease-expired' || code === 'lease-lost';
  };
  const available = Boolean(memory) && typeof memory[MEMORY_INGEST_METHOD] === 'function';
  if (!available) {
    for (const row of rows) {
      try {
        const released = markAttempt(db, row.outbox_id, 'memory-unavailable', at, generation, token, owner);
        if (!released) { summary.lostClaim += 1; summary.skipped = 'claim-lost'; break; }
        summary.retryable += 1;
      } catch (error) {
        if (!fenced(error)) throw error;
        summary.skipped = 'writer-fenced';
        break;
      }
      summary.processed += 1;
    }
    if (!summary.skipped) summary.skipped = 'memory-unavailable';
    summary.queued = countQueued(db, scopeKey);
    return summary;
  }
  for (const row of rows) {
    // Eligibility and ownership are re-checked before each external call, not only after
    // it: a stopped/superseded generation, an expired claim or a row already handled by
    // another drain must not hand the record to memory again (B2/R3/R4).
    try {
      db.assertWritable(generation, { owner });
    } catch (error) {
      if (!fenced(error)) throw error;
      summary.skipped = 'writer-fenced';
      break;
    }
    let refreshed;
    try {
      refreshed = refreshClaim(db, row.outbox_id, token, at, { generation, owner });
    } catch (error) {
      // The claim refresh is now lease-fenced (R6): a drain that lost the lease must stop like
      // any other fenced write instead of escalating an error at the host.
      if (!fenced(error)) throw error;
      summary.skipped = 'writer-fenced';
      break;
    }
    if (!refreshed) {
      summary.lostClaim += 1;
      summary.skipped = 'claim-lost';
      break;
    }
    summary.processed += 1;
    let outcome;
    const call = Promise.resolve().then(() => memory[MEMORY_INGEST_METHOD](requestFromRow(row)));
    // Never leave a rejection unhandled when the timeout wins the race.
    call.catch?.(() => {});
    try {
      outcome = await withCallTimeout(call, timeoutMs);
    } catch (error) {
      if (error?.code === 'memory-timeout') {
        // The call may still be running inside memory. Release the claim first, so a late
        // success/failure cannot rewrite the row; the next drain retries and memory's
        // idempotent receipt dedupes a second delivery.
        try {
          const abandoned = abandonClaim(db, row.outbox_id, 'memory-timeout', at, generation, token, owner);
          if (!abandoned) { summary.lostClaim += 1; summary.skipped = 'claim-lost'; break; }
          summary.retryable += 1;
          summary.timedOut = (summary.timedOut ?? 0) + 1;
          summary.skipped = 'drain-timeout';
        } catch (abandonError) {
          if (!fenced(abandonError)) throw abandonError;
          summary.skipped = 'writer-fenced';
        }
        break;
      }
      try {
        const released = markAttempt(db, row.outbox_id, errorCode(error), at, generation, token, owner);
        if (!released) { summary.lostClaim += 1; summary.skipped = 'claim-lost'; break; }
        summary.retryable += 1;
      } catch (markError) {
        if (!fenced(markError)) throw markError;
        summary.skipped = 'writer-fenced';
        break;
      }
      continue;
    }
    const status = outcome && typeof outcome === 'object' ? String(outcome.status ?? '') : '';
    try {
      let changed;
      if (status === 'accepted' || status === 'pending' || status === 'duplicate') {
        changed = markDelivered(db, row.outbox_id, outcome, at, generation, token, owner, row.event_id);
        if (changed) summary.delivered += 1;
        // task-36: memory refused to supersede because the hint matched several facts. The delivery
        // itself succeeded (the new fact is stored), so this is **not** a retry — it is a correction
        // that did not take effect. Report it so it becomes visible instead of silently ignored.
        if (changed && outcome?.supersede?.reason === 'correction-hint-ambiguous' && typeof onAmbiguousCorrection === 'function') {
          try { onAmbiguousCorrection({ outcome, namespace: row.namespace, eventId: row.event_id }); }
          catch { /* reporting must never fail a delivery */ }
        }
      } else if (status === 'rejected') {
        changed = markRejected(db, row.outbox_id, outcome, at, generation, token, owner);
        if (changed) summary.rejected += 1;
      } else {
        // retryable_failure, an unknown status or a non-object answer: keep it queued.
        const reason = status === 'retryable_failure' ? (safeCode(outcome.reason) || 'retryable-failure') : 'invalid-response';
        changed = markAttempt(db, row.outbox_id, reason, at, generation, token, owner);
        if (changed) summary.retryable += 1;
      }
      // The status update is the authority: a stale drain that no longer owns the claim
      // counts nothing and stops instead of inflating the delivery statistics.
      if (!changed) { summary.lostClaim += 1; summary.skipped = 'claim-lost'; break; }
    } catch (error) {
      if (!fenced(error)) throw error;
      // Another generation took the lease while we awaited memory: never record a
      // delivery we are no longer entitled to write, and stop this round (B2).
      summary.skipped = 'writer-fenced';
      break;
    }
  }
  summary.queued = countQueued(db, scopeKey);
  return summary;
}

/** Diagnostics: counts, attempt total and reason codes only (never content). */
export function outboxStats(db, scopeKey) {
  if (!db || typeof db.all !== 'function') throw new ValidationError('a runtime database handle is required');
  const filter = scopeKey ? 'scope = ?' : '';
  const params = scopeKey ? [String(scopeKey)] : [];
  const where = filter ? `WHERE ${filter}` : '';
  const counts = { queued: 0, sent: 0, failed: 0 };
  let attempts = 0;
  for (const row of db.all(`SELECT status, COUNT(*) AS n, COALESCE(SUM(attempts), 0) AS attempts FROM memory_outbox ${where} GROUP BY status`, ...params)) {
    if (row.status in counts) counts[row.status] = Number(row.n);
    attempts += Number(row.attempts ?? 0);
  }
  const and = filter ? `${where} AND ` : 'WHERE ';
  const last = db.get(`SELECT last_error FROM memory_outbox ${and}last_error <> '' ORDER BY updated_at DESC, outbox_id ASC LIMIT 1`, ...params);
  const oldest = db.get(`SELECT MIN(created_at) AS at FROM memory_outbox ${and}status = 'queued'`, ...params);
  return {
    scopeKey: scopeKey ? String(scopeKey) : null,
    total: counts.queued + counts.sent + counts.failed,
    queued: counts.queued,
    sent: counts.sent,
    failed: counts.failed,
    attempts,
    lastError: last?.last_error ?? '',
    oldestQueuedAt: oldest?.at ?? null,
  };
}
