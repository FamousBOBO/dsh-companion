import crypto from 'node:crypto';
import { ValidationError, RuntimeError } from './errors.mjs';
import { normalizeScope, scopeKey, digest } from './scope.mjs';

export const EVENT_SCHEMA_VERSION = 1;
export const CONFIG_VERSION = 'p1-cognitive-continuity-v1';

// Consumers own disjoint projections and their own receipts. A global dedupe flag
// would let one domain swallow a legitimate event for every other domain, so every
// consumer applies and records independently.
export const CONSUMERS = Object.freeze({
  state: Object.freeze(['state/impulse', 'state/recovered']),
  goals: Object.freeze([
    'goal/proposed', 'goal/accepted', 'goal/started', 'goal/paused', 'goal/resumed',
    'goal/completed', 'goal/cancelled', 'goal/step', 'goal/updated', 'goal/overdue',
    'commitment/made', 'commitment/closed',
  ]),
  'working-memory': Object.freeze([
    'goal/proposed', 'goal/accepted', 'goal/started', 'goal/paused', 'goal/resumed',
    'goal/completed', 'goal/cancelled', 'goal/step', 'goal/updated',
    'topic/switch', 'topic/interjection', 'topic/resume',
    'commitment/made', 'commitment/closed',
  ]),
  beliefs: Object.freeze(['belief/asserted', 'belief/evidence', 'belief/corrected', 'belief/expired']),
  bridge: Object.freeze(['memory/ingest-request', 'memory/correction-request']),
  agenda: Object.freeze([
    'agenda/created', 'agenda/updated', 'agenda/cancelled',
    'agenda/occurrence-generated', 'agenda/occurrence-rescheduled', 'agenda/occurrence-cancelled',
    'agenda/occurrence-due', 'agenda/occurrence-skipped', 'agenda/occurrence-expired',
    'agenda/occurrence-dispatched',
  ]),
  // P2 autonomy: plans, opportunity queue, interests/projects, activity lifecycle and
  // operation receipts (contract logs/p2-autonomous-day/contract-p2.md section 3).
  autonomy: Object.freeze([
    'autonomy/plan-committed', 'autonomy/plan-slot', 'autonomy/opportunity',
    'autonomy/interest', 'autonomy/activity', 'autonomy/receipt',
  ]),
});

export const EVENT_KINDS = Object.freeze([...new Set(Object.values(CONSUMERS).flat())]);

export const REALITY_STATUS = Object.freeze(['actual_tool_activity', 'simulated_world', 'hypothetical']);
export const EVIDENCE_STATUS = Object.freeze(['observed', 'inferred', 'confirmed']);

export function consumersFor(kind) {
  return Object.entries(CONSUMERS).filter(([, kinds]) => kinds.includes(kind)).map(([name]) => name);
}

// Kinds with one authoritative owner: if that owner refuses deterministically, the
// secondary consumers (working memory, bridge) must not act on the same event, or a
// refused goal change could still move the focus.
const AUTHORITATIVE = Object.freeze({
  goals: Object.freeze(['goal/', 'commitment/']),
  beliefs: Object.freeze(['belief/']),
  agenda: Object.freeze(['agenda/']),
  autonomy: Object.freeze(['autonomy/']),
});

function authorityFor(kind) {
  for (const [consumer, prefixes] of Object.entries(AUTHORITATIVE)) {
    if (prefixes.some(prefix => kind.startsWith(prefix))) return consumer;
  }
  return null;
}

function isSupportedVersion(declared) {
  // Explicit versions must be the exact number this runtime speaks. Strings, NaN,
  // Infinity and future versions are refused instead of being coerced (B10).
  return typeof declared === 'number' && Number.isFinite(declared) && declared === EVENT_SCHEMA_VERSION;
}

function assertEnvelopeVersion(event) {
  const declared = event?.schemaVersion;
  if (declared === undefined || declared === null) return;
  if (!isSupportedVersion(declared)) {
    throw new ValidationError(`unsupported event schemaVersion ${String(declared)}; this runtime speaks ${EVENT_SCHEMA_VERSION}`);
  }
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new ValidationError(`${field} is required`);
  return value.trim();
}

/**
 * Normalise one incoming event. Identity always comes from a trusted binding, never
 * from payload text. Unknown kinds are rejected before they can reach a consumer.
 */
const snapshotCache = new WeakSet();
/** Snapshot one JSON-only value exactly once. getters/toJSON/class instances/non-JSON primitives are rejected. */
export function snapshotJson(value, path = 'payload', seen = new WeakSet()) {
  if (value === null) return null;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return value;
  if (type === 'number') {
    if (Number.isFinite(value)) return value;
    throw new ValidationError(`${path} contains a non-finite number`);
  }
  if (type !== 'object') throw new ValidationError(`${path} contains non-JSON ${type}`);
  if (snapshotCache.has(value)) return value;
  const toJSON = Object.getOwnPropertyDescriptor(value, 'toJSON');
  if (toJSON !== undefined) throw new ValidationError(`${path} must not define toJSON`);
  if (seen.has(value)) throw new ValidationError(`${path} contains a cycle`);
  seen.add(value);
  let out;
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) throw new ValidationError(`${path} must be a plain array`);
    out = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || descriptor.get || descriptor.set) throw new ValidationError(`${path}[${index}] must be a plain data property`);
      out.push(snapshotJson(descriptor.value, `${path}[${index}]`, seen));
    }
  } else {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new ValidationError(`${path} must be a plain object`);
    out = {};
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.get || descriptor.set) throw new ValidationError(`${path}.${key} must be a plain data property`);
      const item = snapshotJson(descriptor.value, `${path}.${key}`, seen);
      if (item === undefined) continue;
      Object.defineProperty(out, key, { value: item, enumerable: true, writable: false, configurable: false });
    }
  }
  seen.delete(value);
  const frozen = Object.freeze(out);
  snapshotCache.add(frozen);
  return frozen;
}

function snapshotEvent(event) {
  return Object.freeze({ ...event, payload: snapshotJson(event.payload), rootEvidenceIds: Object.freeze([...(event.rootEvidenceIds ?? [])]) });
}

function snapshotEnvelope(input) {
  if (input === null || typeof input !== 'object') throw new ValidationError('event envelope must be a plain object');
  const proto = Object.getPrototypeOf(input);
  if (proto !== Object.prototype && proto !== null) throw new ValidationError('event envelope must be a plain object');
  if (Object.getOwnPropertySymbols(input).length > 0) throw new ValidationError('event envelope must not have symbol fields');
  const out = {};
  for (const key of Object.getOwnPropertyNames(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || descriptor.get || descriptor.set) throw new ValidationError(`event envelope field ${key} must be a plain data property`);
    if (key === 'toJSON' || typeof descriptor.value === 'function') throw new ValidationError(`event envelope field ${key} is not JSON data`);
    Object.defineProperty(out, key, { value: descriptor.value, enumerable: true, writable: false, configurable: false });
  }
  return out;
}

export function normalizeEvent(input = {}) {
  const source = snapshotEnvelope(input);
  const kind = requireString(source.kind, 'kind');
  if (!EVENT_KINDS.includes(kind)) throw new ValidationError(`unknown event kind: ${kind}`);
  if (source.schemaVersion !== undefined && source.schemaVersion !== null) {
    if (!isSupportedVersion(source.schemaVersion)) {
      throw new ValidationError(`unsupported event schemaVersion ${String(source.schemaVersion)}; this runtime speaks ${EVENT_SCHEMA_VERSION}`);
    }
  }
  const rawScope = source.scope ?? source.subject ?? source.binding ?? {};
  const scope = normalizeScope(snapshotJson(rawScope));
  const rawOccurredAt = source.occurredAt ?? source.occurred_at ?? source.at;
  const rawRecordedAt = source.recordedAt ?? source.recorded_at ?? rawOccurredAt;
  if ((typeof rawOccurredAt !== 'number' && typeof rawOccurredAt !== 'string') || (typeof rawRecordedAt !== 'number' && typeof rawRecordedAt !== 'string')) throw new ValidationError('occurredAt/recordedAt must be primitive epochs');
  const occurredAt = Number(rawOccurredAt);
  if (!Number.isFinite(occurredAt) || occurredAt <= 0) throw new ValidationError('occurredAt must be a positive epoch millisecond');
  const recordedAt = Number(rawRecordedAt);
  const payloadDescriptor = Object.getOwnPropertyDescriptor(source, 'payload');
  if (payloadDescriptor?.get || payloadDescriptor?.set) throw new ValidationError('payload must be a plain data property');
  const payloadInput = payloadDescriptor?.value;
  if (payloadInput !== undefined && payloadInput !== null && typeof payloadInput !== 'object') throw new ValidationError('payload must be a JSON object');
  const payload = payloadInput === undefined || payloadInput === null ? {} : snapshotJson(payloadInput);
  const roots = Array.isArray(source.rootEvidenceIds) ? [...new Set(snapshotJson(source.rootEvidenceIds).map(value => String(value)).filter(Boolean))] : [];
  const realityStatus = source.realityStatus ?? 'hypothetical';
  const evidenceStatus = source.evidenceStatus ?? 'observed';
  if (!REALITY_STATUS.includes(realityStatus)) throw new ValidationError(`unknown realityStatus: ${realityStatus}`);
  if (!EVIDENCE_STATUS.includes(evidenceStatus)) throw new ValidationError(`unknown evidenceStatus: ${evidenceStatus}`);
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    eventId: typeof source.eventId === 'string' && source.eventId ? source.eventId : eventIdFor({ kind, scope, occurredAt, sessionId: source.sessionId ?? '', payload }),
    kind,
    scope,
    scopeKey: scopeKey(scope),
    sessionId: typeof source.sessionId === 'string' ? source.sessionId : '',
    occurredAt: Math.trunc(occurredAt),
    recordedAt: Math.max(Math.trunc(recordedAt), Math.trunc(occurredAt)),
    correlationId: typeof source.correlationId === 'string' ? source.correlationId : '',
    causationId: typeof source.causationId === 'string' ? source.causationId : '',
    rootEvidenceIds: roots,
    realityStatus,
    evidenceStatus,
    configVersion: typeof source.configVersion === 'string' && source.configVersion ? source.configVersion : CONFIG_VERSION,
    modelVersion: typeof source.modelVersion === 'string' ? source.modelVersion : '',
    payload,
  };
}

/** Content-addressed id: the same real event re-delivered keeps the same identity. */
export function eventIdFor({ kind, scope, occurredAt, sessionId = '', payload = {} }) {
  const material = [kind, scopeKey(normalizeScope(scope)), Math.trunc(Number(occurredAt)), sessionId ?? '', digest(payload, 32)];
  return 'evt_' + crypto.createHash('sha256').update(material.join('\u0001')).digest('hex').slice(0, 32);
}

export function eventRow(event) {
  return [
    event.eventId, event.schemaVersion ?? EVENT_SCHEMA_VERSION, event.kind, event.scopeKey,
    event.scope.userId, event.scope.personaId, event.scope.worldId, event.sessionId,
    event.occurredAt, event.recordedAt, event.correlationId, event.causationId,
    JSON.stringify(event.rootEvidenceIds), event.realityStatus, event.evidenceStatus,
    event.configVersion, event.modelVersion, JSON.stringify(event.payload),
  ];
}

export function rowToEvent(row) {
  if (!row) return null;
  const scope = normalizeScope({ userId: row.user_id, personaId: row.persona_id, worldId: row.world_id });
  return {
    schemaVersion: Number(row.schema_version),
    seq: Number(row.seq),
    eventId: row.event_id,
    kind: row.kind,
    scope,
    scopeKey: row.scope,
    sessionId: row.session_id,
    occurredAt: Number(row.occurred_at),
    recordedAt: Number(row.recorded_at),
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    rootEvidenceIds: JSON.parse(row.root_evidence || '[]'),
    realityStatus: row.reality_status,
    evidenceStatus: row.evidence_status,
    configVersion: row.config_version,
    modelVersion: row.model_version,
    payload: JSON.parse(row.payload || '{}'),
  };
}

/** Stable structural JSON: object key order is not semantic, array order is. */
function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

/** Idempotent append. A repeated delivery is acknowledged, never duplicated. */
export function appendEvent(db, input, { generation, owner = null } = {}) {
  const event = snapshotEvent(normalizeEvent(input));
  assertEnvelopeVersion(event);
  // P2.5-4A: the append is the single choke point of the whole P1 event log, so it takes the
  // full writer gate (generation **and** lease expiry, plus the owner when the caller knows it)
  // rather than the generation alone.
  db.assertWritable(generation, { owner });
  const existing = db.get('SELECT * FROM domain_events WHERE event_id = ?', event.eventId);
  if (existing) {
    const persisted = rowToEvent(existing);
    if (persisted.kind !== event.kind || Number(persisted.occurredAt) !== Number(event.occurredAt)
      || String(persisted.scopeKey) !== event.scopeKey || String(persisted.sessionId) !== event.sessionId
      || canonicalJson(persisted.payload) !== canonicalJson(event.payload)
      || canonicalJson(persisted.rootEvidenceIds) !== canonicalJson(event.rootEvidenceIds)
      || persisted.realityStatus !== event.realityStatus || persisted.evidenceStatus !== event.evidenceStatus
      || persisted.configVersion !== event.configVersion || persisted.modelVersion !== event.modelVersion) {
      throw new RuntimeError('conflicting-event', `event ${event.eventId} already exists with different content`);
    }
    return { event: persisted, inserted: false, seq: Number(existing.seq) };
  }
  // Log order is assigned here, inside the caller's transaction, so replay follows
  // the order events were recorded even when several share one millisecond.
  const seq = Number(db.get('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM domain_events').next);
  db.run(`INSERT INTO domain_events (seq, event_id, schema_version, kind, scope, user_id, persona_id, world_id,
            session_id, occurred_at, recorded_at, correlation_id, causation_id, root_evidence,
            reality_status, evidence_status, config_version, model_version, payload)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, seq, ...eventRow(event));
  return { event, inserted: true, seq };
}

export function getEvent(db, eventId) {
  return rowToEvent(db.get('SELECT * FROM domain_events WHERE event_id = ?', eventId));
}

export function listEvents(db, { scopeKey: key, kind, since, until, limit = 100, offset = 0 } = {}) {
  const clauses = [];
  const params = [];
  if (key) { clauses.push('scope = ?'); params.push(key); }
  if (kind) { clauses.push('kind = ?'); params.push(kind); }
  if (Number.isFinite(since)) { clauses.push('occurred_at >= ?'); params.push(Math.trunc(since)); }
  if (Number.isFinite(until)) { clauses.push('occurred_at <= ?'); params.push(Math.trunc(until)); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.all(`SELECT * FROM domain_events ${where} ORDER BY seq ASC LIMIT ? OFFSET ?`,
    ...params, Math.trunc(limit), Math.trunc(offset));
  return rows.map(rowToEvent);
}

export function receiptFor(db, consumer, eventId) {
  const row = db.get('SELECT * FROM consumer_receipts WHERE consumer = ? AND event_id = ?', consumer, eventId);
  if (!row) return null;
  let result = {};
  try { result = JSON.parse(row.result || '{}'); } catch { result = {}; }
  return { consumer, eventId: row.event_id, scopeKey: row.scope, appliedAt: Number(row.applied_at), stateVersion: Number(row.state_version), result };
}

/**
 * Apply one event for one consumer inside a single transaction: the projection, the
 * scope version and the receipt commit together. A throw rolls all three back.
 *
 * `apply({ db, event, projection, slice, now })` returns
 *   { slice?: object, result?: object, extra?: (db, event) => void }
 * where `slice` replaces this consumer's namespaced part of the projection payload.
 */
export function applyEvent(db, { consumer, event, generation, owner = null, expectedVersion, apply }) {
  if (!CONSUMERS[consumer]) throw new ValidationError(`unknown consumer: ${consumer}`);
  event = normalizeEvent(event);
  const suppliedRevision = event.payload?.expectedRevision;
  if (event.kind === 'topic/resume' && suppliedRevision !== null && suppliedRevision !== undefined && !Number.isFinite(Number(suppliedRevision))) throw new ValidationError('expectedRevision must be a finite number when supplied');
  if (event.kind === 'topic/switch' || (event.kind === 'topic/resume' && event.payload.goalId)) {
    if (suppliedRevision !== null && suppliedRevision !== undefined && !Number.isFinite(Number(suppliedRevision))) throw new ValidationError('expectedRevision must be a finite number when supplied');
    const goal = db.get('SELECT revision FROM goals WHERE scope = ? AND goal_id = ?', event.scopeKey, String(event.payload.goalId));
    if (!goal) throw new ValidationError('focus target does not exist in this scope');
    if (event.payload.expectedRevision !== null && event.payload.expectedRevision !== undefined && Number.isFinite(Number(event.payload.expectedRevision)) && Number(event.payload.expectedRevision) !== Number(goal.revision)) throw new RuntimeError('stale-revision', 'focus target revision is stale');
  }
  if (event.kind === 'belief/corrected') {
    if (suppliedRevision !== null && suppliedRevision !== undefined && !Number.isFinite(Number(suppliedRevision))) throw new ValidationError('expectedRevision must be a finite number when supplied');
    const belief = db.get('SELECT revision FROM beliefs WHERE scope = ? AND belief_id = ?', event.scopeKey, String(event.payload.beliefId));
    if (!belief) throw new ValidationError('belief does not exist in this scope');
    if (event.payload.expectedRevision !== null && event.payload.expectedRevision !== undefined && Number.isFinite(Number(event.payload.expectedRevision)) && Number(event.payload.expectedRevision) !== Number(belief.revision)) throw new RuntimeError('stale-revision', 'belief revision is stale');
  }
  if (!CONSUMERS[consumer].includes(event.kind)) {
    return { applied: false, skipped: true, reason: 'kind-not-consumed', consumer, eventId: event.eventId };
  }
  return db.tx(() => {
    // The projection write, its version bump and the consumer receipt travel together, so the
    // lease fence belongs here too: a generation whose lease lapsed may not commit a receipt
    // (P2.5-4A).
    db.assertWritable(generation, { owner });
    const existing = receiptFor(db, consumer, event.eventId);
    if (existing) return { applied: false, duplicate: true, consumer, eventId: event.eventId, version: existing.stateVersion, result: existing.result };
    const projection = db.projection(event.scopeKey);
    if (Number.isFinite(expectedVersion) && Number(expectedVersion) !== projection.version) {
      throw new RuntimeError('stale-revision', `scope ${event.scopeKey} expected v${expectedVersion}, current v${projection.version}`);
    }
    const slice = { ...(projection.payload?.[consumer] ?? {}) };
    // Handlers see the event's occurrence instant, never the wall clock: replaying the
    // same log later must reproduce byte-identical rows (A08). Types that need "now"
    // read it from their own payload (e.g. belief/expired carries `at`).
    const outcome = apply({ db, event, projection, slice, now: event.occurredAt }) ?? {};
    if (outcome.extra) outcome.extra(db, event);
    const nextPayload = { ...projection.payload };
    if (outcome.slice !== undefined) nextPayload[consumer] = outcome.slice;
    const version = db.commitProjection({ scope: event.scopeKey, generation, owner, expectedVersion: projection.version, payload: nextPayload, updatedAt: db.now() });
    const result = JSON.stringify(outcome.result ?? {});
    db.run('INSERT INTO consumer_receipts (consumer, event_id, scope, applied_at, state_version, result) VALUES (?, ?, ?, ?, ?, ?)',
      consumer, event.eventId, event.scopeKey, db.now(), version, result);
    return { applied: true, duplicate: false, consumer, eventId: event.eventId, version, result: JSON.parse(result) };
  });
}

/**
 * Append one event and fan it out to every interested consumer.
 *
 * Each consumer runs in a savepoint, so one failing domain rolls back only its own
 * writes (A01/A08). If *every* interested consumer refused the event with a
 * deterministic rejection (a typed RuntimeError: invalid transition, stale revision,
 * silence used as evidence, …) the whole event is rolled back and never enters the
 * log — a refused proposal must not poison replay (A07/A08).
 *
 * `requireConsumers: true` also rolls the event back when a consumer fails
 * non-deterministically. That is the correct trade for a single-authority aggregate
 * (the agenda): an event row without its receipt would be applied by a later replay but
 * never happened live, and the caller's retry would append a near-duplicate that replay
 * rejects for ever (independent review pass 2, BLOCK-2). With the flag the failed event
 * never existed and the caller can retry cleanly. P1 paths keep the default behaviour.
 */
export function dispatchEvent(db, input, { handlers = {}, generation, owner = null, guard = null, requireConsumers = false } = {}) {
  const event = normalizeEvent(input);
  assertEnvelopeVersion(event);
  const authority = authorityFor(event.kind);
  try {
    return db.tx(() => {
      // A caller that needs a stricter write gate than `generation` (the business
      // heartbeat also checks owner + lease expiry) runs it here, inside the same
      // transaction as the append, so the check cannot be bypassed by a takeover that
      // happens between a pre-check and this commit.
      if (typeof guard === 'function') guard();
      const appended = appendEvent(db, event, { generation, owner });
      const effective = appended.event;
      const results = [];
      const order = consumersFor(effective.kind).sort((left, right) => (left === authority ? -1 : right === authority ? 1 : 0));
      let vetoed = false;
      for (const consumer of order) {
        const handler = handlers[consumer];
        if (!handler) { results.push({ consumer, applied: false, reason: 'no-handler' }); continue; }
        if (vetoed) { results.push({ consumer, applied: false, reason: 'authority-rejected' }); continue; }
        try {
          results.push({ ...applyEvent(db, { consumer, event: effective, generation, owner, apply: handler }) });
        } catch (error) {
          const runtimeError = error instanceof RuntimeError ? error : null;
          const deterministic = Boolean(runtimeError) && runtimeError.code !== 'internal';
          results.push({
            consumer,
            applied: false,
            error: error instanceof Error ? error.message : String(error),
            code: runtimeError?.code ?? 'internal',
            deterministic,
          });
          // The authoritative owner of this event kind refused: do not let a
          // secondary consumer act on the same refused change.
          if (consumer === authority && deterministic) vetoed = true;
        }
      }
      const failed = results.filter(result => result.error);
      const applied = results.filter(result => result.applied);
      const allDeterministic = failed.length > 0 && failed.every(result => result.deterministic === true);
      if (requireConsumers && failed.length > 0) {
        // A committed append without the required receipt is unrecoverable for a
        // single-authority aggregate: roll the whole event back instead.
        throw new RejectedEvent(results);
      }
      if (appended.inserted && applied.length === 0 && allDeterministic) {
        throw new RejectedEvent(results);
      }
      return { event, inserted: appended.inserted, seq: appended.seq, results, rejected: false };
    });
  } catch (error) {
    if (error instanceof RejectedEvent) {
      return { event, inserted: false, seq: null, rejected: true, results: error.results };
    }
    throw error;
  }
}

/** Internal signal: roll the append back because every consumer refused deterministically. */
class RejectedEvent extends Error {
  constructor(results) {
    super('every consumer rejected the event');
    this.name = 'RejectedEvent';
    this.results = results;
  }
}

export function eventCount(db, scopeKeyValue) {
  const row = scopeKeyValue
    ? db.get('SELECT COUNT(*) AS n FROM domain_events WHERE scope = ?', scopeKeyValue)
    : db.get('SELECT COUNT(*) AS n FROM domain_events');
  return Number(row?.n ?? 0);
}

export function receiptCount(db, consumer) {
  const row = consumer
    ? db.get('SELECT COUNT(*) AS n FROM consumer_receipts WHERE consumer = ?', consumer)
    : db.get('SELECT COUNT(*) AS n FROM consumer_receipts');
  return Number(row?.n ?? 0);
}
