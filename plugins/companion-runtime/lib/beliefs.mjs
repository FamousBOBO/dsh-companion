// Beliefs, root evidence and correction propagation — CONTRACT.md §4 `lib/beliefs.mjs`.
//
// Three rules drive this module:
//   1. Confidence is a function of the number of *distinct root evidence ids* only.
//      Re-citing a root, re-recalling a memory or several modules quoting one summary
//      cannot move it, and the independence count is stored explicitly beside it.
//   2. `validUntil` in the past turns a belief into `unknown`. It never becomes
//      `refuted`, trust never drops, and silence/no-reply never creates or edits a
//      belief at all (stable code: silence-not-evidence).
//   3. An explicit correction retires the old belief (`superseded` + `superseded_by`),
//      keeps its evidence and revisions readable through `beliefHistory`, and
//      invalidates only the `belief_dependents` rows that rested on that belief.
//
// The mapping `evidenceId -> rootId` is immutable for a belief: re-sending a known
// evidence id with another root (or another relation) is refused with
// `evidence-root-conflict` instead of merging caller input into the counter. On every
// success the counter (`roots`/`independence`/`confidence`) is recomputed from the
// `belief_evidence` rows that actually exist, so the counter and the ledger cannot
// diverge (review finding B6).
//
// Every write goes through `db.tx()`; ids are content-addressed, so replaying the same
// event log into a fresh database reproduces the same rows (A08) and a second delivery
// of one event is a no-op (A01/A02).
import { CONSUMERS } from './events.mjs';
import { RuntimeError, ScopeError, ValidationError } from './errors.mjs';
import { digest, normalizeScope, parseScope, scopeKey as keyOf } from './scope.mjs';

export const BELIEF_STATUS = Object.freeze(['supported', 'refuted', 'unknown', 'superseded']);

// Frozen confidence ladder: |distinct root evidence| -> confidence.
//   0 -> 0 · 1 -> 0.5 · 2 -> 0.75 · 3+ -> 0.9 (capped)
// Monotone and strictly increasing for 1..3 roots. Nothing else may feed the value:
// a re-cited root, a re-recalled memory or several modules quoting one summary all
// resolve to the same root id and therefore cannot raise it.
const CONFIDENCE_LADDER = Object.freeze([0, 0.5, 0.75, 0.9]);
const RETIRED_STATUSES = Object.freeze(['superseded', 'refuted']);
const TEXT_LIMIT = 400;
const CODE_LIMIT = 80;
const REVISION_RELATION = 'revision';
const SUPPORT_RELATIONS = new Set(['support', 'supports', 'corroborate', 'corroborates', 'observed', 'confirmed', 'evidence']);
const REFUTE_RELATIONS = new Set(['refute', 'refutes', 'contradict', 'contradicts', 'denies', 'disconfirm', 'disconfirms']);
const SOURCE_RELATIONS = new Set(['source', 'provenance', 'origin']);
// Silence is not evidence about a person's state. These payload bases are refused
// before a single row can be created or edited.
const SILENCE_BASES = new Set(['silence', 'no-reply', 'no_reply', 'no-replies', 'no-response', 'no_answer', 'no-answer', 'unanswered']);

// ------------------------------------------------------------------ small helpers

function jsonArray(value) {
  try {
    const parsed = JSON.parse(value ?? '[]');
    return Array.isArray(parsed) ? parsed.map(item => String(item)) : [];
  } catch { return []; }
}

function text(value, field, limit = TEXT_LIMIT) {
  if (typeof value !== 'string' || value.trim() === '') throw new ValidationError(`${field} is required`);
  const trimmed = value.trim();
  if (trimmed.length > limit) throw new ValidationError(`${field} is longer than ${limit} characters`);
  return trimmed;
}

function code(value, limit = CODE_LIMIT) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function intOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value instanceof Date ? value.getTime() : value);
  return Number.isFinite(number) ? Math.trunc(number) : null;
}

function atOf(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

/** Scope is the only address; a bare scope key is parsed, never invented. */
function address(input = {}) {
  if (input.scope) {
    const scope = normalizeScope(input.scope);
    return { scope, scopeKey: keyOf(scope) };
  }
  const parsed = parseScope(input.scopeKey);
  if (!parsed) throw new ValidationError('belief operations require a trusted scope or scope key');
  return { scope: parsed, scopeKey: keyOf(parsed) };
}

function distinctRoots(list) {
  const values = list instanceof Set ? [...list] : Array.isArray(list) ? list : [];
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const id = typeof value === 'string' ? value.trim() : String(value ?? '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** Merge root evidence ids in first-seen order, dropping duplicates. */
function rootList(...sources) {
  return distinctRoots(sources.flatMap(source => (Array.isArray(source) ? source : [])));
}

/**
 * Distinct support roots read back from `belief_evidence`: the counter is a projection
 * of the ledger, never of caller input. Order is first appearance, then id, so the same
 * log replayed into a fresh database rebuilds the same array (A08).
 */
function ledgerRootsFor(db, beliefId) {
  return db.all(`SELECT root_id FROM belief_evidence
      WHERE belief_id = ? AND relation = 'support' AND root_id <> ''
      GROUP BY root_id
      ORDER BY MIN(added_at) ASC, root_id ASC`, beliefId)
    .map(row => String(row.root_id));
}

/** Set equality: the counter is a count, so a reordering alone is not new evidence. */
function sameRootSet(left, right) {
  const a = distinctRoots(left).slice().sort();
  const b = distinctRoots(right).slice().sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * An evidence id names exactly one root (and one relation) for one belief. Re-sending
 * the same evidenceId with another root is a conflict, not new support: `INSERT OR
 * IGNORE` would keep the original row while the counter moved (review finding B6).
 */
function assertEvidenceMapping(db, beliefId, evidenceId, relation, rootId) {
  const rows = db.all('SELECT root_id, relation FROM belief_evidence WHERE belief_id = ? AND evidence_id = ?',
    beliefId, evidenceId);
  for (const row of rows) {
    if (row.relation === relation && String(row.root_id ?? '') === rootId) continue;
    throw new RuntimeError('evidence-root-conflict',
      `evidence ${evidenceId} is already bound to root "${row.root_id}" (${row.relation}) on ${beliefId}; `
      + `it cannot be re-pointed at root "${rootId}" (${relation})`);
  }
}

/**
 * The only confidence source: the count of distinct root evidence ids.
 * A number is accepted as an already-counted size (used by history views).
 */
export function confidenceForRoots(roots) {
  const count = typeof roots === 'number' && Number.isFinite(roots)
    ? Math.max(0, Math.trunc(roots))
    : distinctRoots(roots).length;
  return CONFIDENCE_LADDER[Math.min(count, CONFIDENCE_LADDER.length - 1)];
}

function beliefIdFor(scopeKeyValue, proposition) {
  return `belief_${digest({ scopeKey: scopeKeyValue, proposition }, 16)}`;
}

function beliefRow(db, scopeKeyValue, beliefId) {
  return db.get('SELECT * FROM beliefs WHERE belief_id = ? AND scope = ?', beliefId, scopeKeyValue) ?? null;
}

function requireBelief(db, scopeKeyValue, beliefId) {
  const id = code(beliefId);
  if (!id) throw new ValidationError('beliefId is required');
  const row = beliefRow(db, scopeKeyValue, id);
  if (!row) throw new RuntimeError('belief-not-found', `no belief ${id} in ${scopeKeyValue}`);
  return row;
}

function publicBelief(row, now) {
  const roots = jsonArray(row.roots);
  const validUntil = row.valid_until === null || row.valid_until === undefined ? null : Number(row.valid_until);
  return {
    beliefId: row.belief_id,
    proposition: row.proposition,
    status: BELIEF_STATUS.includes(row.status) ? row.status : 'unknown',
    confidence: Number(row.confidence),
    independence: Number(row.independence),
    roots,
    rootCount: roots.length,
    validUntil,
    expired: validUntil !== null && validUntil <= now,
    revision: Number(row.revision),
    supersededBy: row.superseded_by || '',
    reason: row.reason || '',
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function writeEvidenceRows(db, beliefId, rows, at) {
  for (const row of rows) {
    const evidenceId = code(row.evidenceId);
    if (!evidenceId) continue;
    db.run(`INSERT OR IGNORE INTO belief_evidence (belief_id, evidence_id, root_id, relation, event_id, added_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      beliefId, evidenceId, code(row.rootId), row.relation, code(row.eventId), at);
  }
}

/**
 * Revision ledger: one immutable marker row per appended revision. The marker is not
 * evidence (root_id stays empty) and never counts toward independence; it keeps the
 * revision number, the transition kind and the evidence that triggered it readable.
 */
function markRevision(db, { beliefId, revision, kind, eventId = '', at }) {
  writeEvidenceRows(db, beliefId, [{
    evidenceId: `rev-${revision}:${kind}`,
    rootId: '',
    relation: REVISION_RELATION,
    eventId,
  }], at);
}

function normalizeRelation(value) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!raw) return 'support';
  if (SUPPORT_RELATIONS.has(raw)) return 'support';
  if (REFUTE_RELATIONS.has(raw)) return 'refute';
  if (SOURCE_RELATIONS.has(raw)) return 'source';
  throw new ValidationError(`unsupported evidence relation: ${raw}`);
}

function replacementOf(value, byEvidenceId) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string') {
    return { proposition: text(value, 'replacement'), roots: [byEvidenceId], validUntil: null, source: 'correction' };
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('replacement must be a proposition string or an object');
  }
  const proposition = text(value.proposition ?? '', 'replacement.proposition');
  const roots = rootList([byEvidenceId], value.rootEvidenceIds, value.roots);
  return {
    proposition,
    roots: roots.length ? roots : [byEvidenceId],
    validUntil: intOrNull(value.validUntil),
    source: code(value.source, 40) || 'correction',
  };
}

function scopeSummary(db, scopeKeyValue) {
  const counts = db.get(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'supported' THEN 1 ELSE 0 END) AS supported,
      SUM(CASE WHEN status = 'unknown' THEN 1 ELSE 0 END) AS unknown,
      SUM(CASE WHEN status = 'superseded' THEN 1 ELSE 0 END) AS superseded,
      SUM(CASE WHEN status = 'refuted' THEN 1 ELSE 0 END) AS refuted
    FROM beliefs WHERE scope = ?`, scopeKeyValue);
  const latest = db.get('SELECT belief_id, status FROM beliefs WHERE scope = ? ORDER BY updated_at DESC, belief_id ASC LIMIT 1', scopeKeyValue);
  const supported = Number(counts?.supported ?? 0);
  const unknown = Number(counts?.unknown ?? 0);
  return {
    total: Number(counts?.total ?? 0),
    current: supported + unknown,
    supported,
    unknown,
    superseded: Number(counts?.superseded ?? 0),
    refuted: Number(counts?.refuted ?? 0),
    lastBeliefId: latest?.belief_id ?? '',
    lastStatus: latest?.status ?? '',
  };
}

function rejectSilenceBasis(event) {
  const payload = event?.payload && typeof event.payload === 'object' ? event.payload : {};
  if (payload.silence === true) {
    throw new RuntimeError('silence-not-evidence', 'silence cannot create or change a belief');
  }
  const candidates = [payload.basis, payload.evidenceBasis, payload.sourceBasis, payload.observationBasis, payload.evidence?.basis];
  for (const candidate of candidates) {
    const label = typeof candidate === 'string' ? candidate.trim().toLowerCase() : '';
    if (SILENCE_BASES.has(label)) {
      throw new RuntimeError('silence-not-evidence', `belief events based on ${label} are refused: silence is not evidence`);
    }
  }
}

/** Only the derivations of this belief, in this scope, lose their validity. */
function invalidateDependents(db, scopeKeyValue, beliefId, at) {
  const result = db.run(`UPDATE belief_dependents SET status = 'invalid', updated_at = ?
    WHERE belief_id = ? AND status <> 'invalid'
      AND EXISTS (SELECT 1 FROM beliefs b WHERE b.belief_id = belief_dependents.belief_id AND b.scope = ?)`,
    at, beliefId, scopeKeyValue);
  return Number(result.changes ?? 0);
}

function insertBelief(db, { scopeKeyValue, beliefId, proposition, roots, status, validUntil, now }) {
  db.run(`INSERT INTO beliefs (belief_id, scope, proposition, status, confidence, roots, independence,
            valid_until, revision, superseded_by, reason, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, '', '', ?, ?)`,
    beliefId, scopeKeyValue, proposition, status, confidenceForRoots(roots), JSON.stringify(roots), roots.length, validUntil, now, now);
  writeEvidenceRows(db, beliefId, roots.map(rootId => ({ evidenceId: rootId, rootId, relation: 'support' })), now);
}

// ------------------------------------------------------------------- public API

/**
 * Assert a belief. The stored confidence is derived from the distinct root evidence
 * ids; a caller-supplied `confidence` is accepted for signature compatibility but can
 * never inflate the value. Re-asserting the same proposition returns the same row:
 * an already retired belief is never resurrected by mere repetition.
 */
export function assertBelief(db, options = {}) {
  const { scopeKey: key } = address(options);
  const proposition = text(options.proposition, 'proposition');
  const now = atOf(options.now, db.now());
  const roots = rootList(options.rootEvidenceIds, options.roots);
  const validUntil = intOrNull(options.validUntil);
  const source = code(options.source, 40) || 'conversation';
  const beliefId = beliefIdFor(key, proposition);

  return db.tx(() => {
    const existing = beliefRow(db, key, beliefId);
    if (!existing) {
      const status = validUntil !== null && validUntil <= now ? 'unknown' : 'supported';
      insertBelief(db, { scopeKeyValue: key, beliefId, proposition, roots, status, validUntil, now });
      writeEvidenceRows(db, beliefId, [{ evidenceId: `source:${source}`, rootId: '', relation: 'source' }], now);
      return { beliefId, status, confidence: confidenceForRoots(roots), independence: roots.length, revision: 1, created: true };
    }

    const current = publicBelief(existing, now);
    if (RETIRED_STATUSES.includes(current.status)) {
      // A retracted judgment stays retracted; new episodes need a new statement.
      return { beliefId, status: current.status, confidence: current.confidence, independence: current.independence, revision: current.revision, created: false };
    }

    const candidate = rootList(current.roots, roots);
    const additions = candidate.filter(rootId => !current.roots.includes(rootId));
    // Every assert path obeys the same immutable evidence -> root mapping (B6): a root
    // id already used as an evidence id may not silently become a second root.
    for (const rootId of additions) assertEvidenceMapping(db, beliefId, rootId, 'support', rootId);
    if (additions.length) {
      writeEvidenceRows(db, beliefId, additions.map(rootId => ({ evidenceId: rootId, rootId, relation: 'support' })), now);
    }
    // The ledger is authoritative: count only support rows that actually exist.
    const ledger = ledgerRootsFor(db, beliefId);
    const merged = sameRootSet(ledger, current.roots) ? current.roots : ledger;
    const nextValidUntil = validUntil === null ? current.validUntil : validUntil;
    const grew = merged.length !== current.roots.length;
    const renewed = current.status === 'unknown' && (nextValidUntil === null || nextValidUntil > now);
    const rescheduled = nextValidUntil !== current.validUntil;
    if (!grew && !renewed && !rescheduled && sameRootSet(ledger, current.roots)) {
      return { beliefId, status: current.status, confidence: current.confidence, independence: current.independence, revision: current.revision, created: false };
    }
    const revision = current.revision + 1;
    const confidence = confidenceForRoots(merged);
    const status = renewed ? 'supported' : current.status;
    db.run(`UPDATE beliefs SET status = ?, confidence = ?, roots = ?, independence = ?, valid_until = ?,
              revision = ?, updated_at = ? WHERE belief_id = ? AND scope = ?`,
      status, confidence, JSON.stringify(merged), merged.length, nextValidUntil, revision, now, beliefId, key);
    markRevision(db, { beliefId, revision, kind: renewed ? 'renewed' : 'evidence', at: now });
    return { beliefId, status, confidence, independence: merged.length, revision, created: false };
  });
}

/**
 * Record one piece of evidence. Only a *new distinct root* changes confidence and
 * independence; a second citation of a known root, or a second recall of the same
 * memory, leaves both untouched. A refutation retires the belief as `refuted`; a
 * provenance row records where the belief came from and never affects confidence.
 *
 * `evidenceId -> rootId` is immutable per belief: re-sending a known evidence id with
 * a different root or relation throws `evidence-root-conflict`, a deterministic
 * rejection the consumer savepoint rolls back (review finding B6).
 */
export function addEvidence(db, options = {}) {
  const { scopeKey: key } = address(options);
  const beliefId = code(options.beliefId);
  if (!beliefId) throw new ValidationError('beliefId is required');
  const evidenceId = code(options.evidenceId ?? options.evidence);
  if (!evidenceId) throw new ValidationError('evidenceId is required');
  const relation = normalizeRelation(options.relation);
  const rootId = code(options.rootId) || evidenceId;
  const storedRootId = relation === 'source' ? '' : rootId;
  const now = atOf(options.now, db.now());

  return db.tx(() => {
    const row = requireBelief(db, key, beliefId);
    const current = publicBelief(row, now);
    assertEvidenceMapping(db, beliefId, evidenceId, relation, storedRootId);
    writeEvidenceRows(db, beliefId, [{ evidenceId, rootId: storedRootId, relation, eventId: code(options.eventId) }], now);

    if (RETIRED_STATUSES.includes(current.status)) {
      // History keeps the evidence; a retired belief is never revived or re-scored.
      return { beliefId, status: current.status, confidence: current.confidence, independence: current.independence, revision: current.revision, relation, added: false };
    }

    if (relation === 'refute') {
      const revision = current.revision + 1;
      db.run('UPDATE beliefs SET status = ?, revision = ?, updated_at = ? WHERE belief_id = ? AND scope = ?',
        'refuted', revision, now, beliefId, key);
      markRevision(db, { beliefId, revision, kind: 'refuted', eventId: evidenceId, at: now });
      return { beliefId, status: 'refuted', confidence: current.confidence, independence: current.independence, revision, relation, added: true };
    }

    if (relation === 'source') {
      return { beliefId, status: current.status, confidence: current.confidence, independence: current.independence, revision: current.revision, relation, added: false };
    }

    // The counter is a projection of the ledger: read the roots back from the rows that
    // were actually accepted, never from the caller's `rootId`.
    const roots = ledgerRootsFor(db, beliefId);
    if (sameRootSet(roots, current.roots)) {
      return { beliefId, status: current.status, confidence: current.confidence, independence: current.independence, revision: current.revision, relation, added: false };
    }
    const revision = current.revision + 1;
    const confidence = confidenceForRoots(roots);
    db.run('UPDATE beliefs SET confidence = ?, roots = ?, independence = ?, revision = ?, updated_at = ? WHERE belief_id = ? AND scope = ?',
      confidence, JSON.stringify(roots), roots.length, revision, now, beliefId, key);
    markRevision(db, { beliefId, revision, kind: 'evidence', eventId: evidenceId, at: now });
    return { beliefId, status: current.status, confidence, independence: roots.length, revision, relation, added: true };
  });
}

/**
 * Retire a belief because the user (or a confirmed observation) corrected it.
 * The old row keeps its proposition, roots, evidence and revisions; `superseded_by`
 * and the appended revision point at the replacement; unrelated beliefs and
 * dependents of other beliefs are untouched.
 */
export function correctBelief(db, options = {}) {
  const { scopeKey: key } = address(options);
  const beliefId = code(options.beliefId);
  if (!beliefId) throw new ValidationError('beliefId is required');
  const byEvidenceId = code(options.byEvidenceId);
  if (!byEvidenceId) throw new ValidationError('byEvidenceId is required');
  const reason = code(options.reason, 200);
  const now = atOf(options.now, db.now());
  const replacement = replacementOf(options.replacement, byEvidenceId);

  return db.tx(() => {
    const row = requireBelief(db, key, beliefId);
    const current = publicBelief(row, now);
    const replacementId = replacement ? replacementIdFor(db, key, replacement.proposition, byEvidenceId) : '';
    const alreadyRefuted = Boolean(db.get(
      'SELECT 1 AS present FROM belief_evidence WHERE belief_id = ? AND evidence_id = ? AND relation = ?',
      beliefId, byEvidenceId, 'refute'));
    if (current.status === 'superseded') {
      if (current.supersededBy === replacementId && (alreadyRefuted || !replacement)) {
        // Idempotent: the same correction delivered twice is one retraction.
        return {
          beliefId, status: current.status, revision: current.revision, confidence: current.confidence,
          independence: current.independence, supersededBy: current.supersededBy, replacementId,
          invalidatedDependents: 0, code: 'already-superseded',
        };
      }
      // Correcting a retired belief twice would leave two current judgments for the
      // same claim; the caller corrects the current successor instead (A05-09 chain).
      throw new RuntimeError('already-superseded', `belief ${beliefId} is already superseded; correct its successor ${current.supersededBy || '(retracted)'}`);
    }

    // 1. keep the refuting evidence on the old belief — it is never a support root.
    writeEvidenceRows(db, beliefId, [{ evidenceId: byEvidenceId, rootId: byEvidenceId, relation: 'refute' }], now);

    // 2. the replacement becomes the current judgment (its own roots, no inheritance).
    if (replacement && !beliefRow(db, key, replacementId)) {
      const status = replacement.validUntil !== null && replacement.validUntil <= now ? 'unknown' : 'supported';
      insertBelief(db, {
        scopeKeyValue: key, beliefId: replacementId, proposition: replacement.proposition,
        roots: replacement.roots, status, validUntil: replacement.validUntil, now,
      });
      writeEvidenceRows(db, replacementId, [{ evidenceId: `source:${replacement.source}`, rootId: '', relation: 'source' }], now);
    }

    // 3. retire the old judgment and append its revision.
    const revision = current.revision + 1;
    db.run(`UPDATE beliefs SET status = 'superseded', superseded_by = ?, reason = ?, revision = ?, updated_at = ?
            WHERE belief_id = ? AND scope = ?`,
      replacementId, reason, revision, now, beliefId, key);
    markRevision(db, { beliefId, revision, kind: 'corrected', eventId: byEvidenceId, at: now });

    // 4. only the derivations of this belief lose validity.
    const invalidatedDependents = invalidateDependents(db, key, beliefId, now);

    return {
      beliefId, status: 'superseded', revision, confidence: current.confidence,
      independence: current.independence, supersededBy: replacementId, replacementId,
      invalidatedDependents, code: 'corrected',
    };
  });
}

/**
 * A replacement that already exists as a current fact is reused; one that was retired
 * earlier is a different episode and gets its own id, so an old judgment can never be
 * silently restored by citing it again.
 */
function replacementIdFor(db, scopeKeyValue, proposition, byEvidenceId) {
  const plain = beliefIdFor(scopeKeyValue, proposition);
  const existing = beliefRow(db, scopeKeyValue, plain);
  if (!existing || !RETIRED_STATUSES.includes(existing.status)) return plain;
  return beliefIdFor(`${scopeKeyValue}\u0001${byEvidenceId}`, proposition);
}

/**
 * Time-driven expiry only: `supported` becomes `unknown`, evidence and revision stay.
 * Never `refuted`, never a trust drop, never an inferred "free"/"rejected".
 */
export function expireBeliefs(db, options = {}) {
  const { scopeKey: key } = address(options);
  const now = atOf(options.now, db.now());
  return db.tx(() => {
    const rows = db.all(`SELECT belief_id FROM beliefs
      WHERE scope = ? AND status = 'supported' AND valid_until IS NOT NULL AND valid_until <= ?
      ORDER BY belief_id`, key, now);
    if (!rows.length) return { scopeKey: key, expired: 0, beliefIds: [] };
    db.run(`UPDATE beliefs SET status = 'unknown', updated_at = ?
      WHERE scope = ? AND status = 'supported' AND valid_until IS NOT NULL AND valid_until <= ?`, now, key, now);
    return { scopeKey: key, expired: rows.length, beliefIds: rows.map(row => row.belief_id) };
  });
}

/**
 * Register a derived conclusion that rests on one or more beliefs. Corrections flip
 * the matching rows to `invalid`; a dependent of a retired belief starts invalid.
 */
export function addDependent(db, options = {}) {
  const { scopeKey: key } = address(options);
  const dependentId = code(options.dependentId);
  if (!dependentId) throw new ValidationError('dependentId is required');
  const beliefIds = rootList(options.beliefIds);
  if (!beliefIds.length) throw new ValidationError('at least one beliefId is required');
  const kind = code(options.kind, 40) || 'inference';
  const now = atOf(options.now, db.now());

  return db.tx(() => {
    let added = 0;
    const statuses = {};
    for (const beliefId of beliefIds) {
      const row = beliefRow(db, key, beliefId);
      if (!row) {
        // A forward reference is allowed, but never across a scope boundary.
        const foreign = db.get('SELECT scope FROM beliefs WHERE belief_id = ?', beliefId);
        if (foreign) throw new ScopeError(`belief ${beliefId} belongs to another scope`);
        statuses[beliefId] = 'current';
      } else {
        statuses[beliefId] = RETIRED_STATUSES.includes(row.status) ? 'invalid' : 'current';
      }
      const result = db.run(`INSERT OR IGNORE INTO belief_dependents (dependent_id, belief_id, kind, status, updated_at)
        VALUES (?, ?, ?, ?, ?)`, dependentId, beliefId, kind, statuses[beliefId], now);
      if (Number(result.changes ?? 0) > 0) added += 1;
    }
    return { dependentId, beliefIds, kind, added, statuses };
  });
}

/**
 * Injection-safe view: unexpired `supported`/`unknown` beliefs only. Superseded and
 * refuted rows are history; expired rows are excluded by default so a lapsed deadline
 * can never be injected as a current fact (`includeExpired` is for diagnostics).
 */
export function currentBeliefs(db, options = {}) {
  const { scopeKey: key } = address(options);
  const now = atOf(options.now, db.now());
  const includeExpired = options.includeExpired === true;
  const rows = db.all(`SELECT * FROM beliefs WHERE scope = ? AND status IN ('supported', 'unknown')
    ORDER BY CASE status WHEN 'supported' THEN 0 ELSE 1 END, confidence DESC, updated_at DESC, belief_id ASC`, key);
  return rows
    .map(row => publicBelief(row, now))
    .filter(belief => includeExpired || !belief.expired);
}

/**
 * Full audit trail for one belief: the judgment and its status, every piece of
 * evidence, every appended revision, the correction reason, the dependents and the
 * supersession links in both directions.
 */
export function beliefHistory(db, options = {}) {
  const { scopeKey: key } = address(options);
  const beliefId = code(options.beliefId);
  if (!beliefId) throw new ValidationError('beliefId is required');
  const now = atOf(options.now, db.now());
  const belief = publicBelief(requireBelief(db, key, beliefId), now);

  const evidence = db.all(`SELECT evidence_id, root_id, relation, event_id, added_at FROM belief_evidence
    WHERE belief_id = ? ORDER BY added_at ASC, evidence_id ASC, relation ASC`, beliefId)
    .map(row => ({
      evidenceId: row.evidence_id,
      rootId: row.root_id,
      relation: row.relation,
      eventId: row.event_id,
      addedAt: Number(row.added_at),
    }));

  const revisions = [{ revision: 1, at: belief.createdAt, kind: 'asserted', byEvidenceId: '', confidence: confidenceForRoots(belief.roots) }];
  for (const marker of evidence.filter(item => item.relation === REVISION_RELATION)) {
    const match = /^rev-(\d+):(.+)$/.exec(marker.evidenceId);
    revisions.push({
      revision: match ? Number(match[1]) : revisions.length + 1,
      at: marker.addedAt,
      kind: match ? match[2] : 'updated',
      byEvidenceId: marker.eventId || '',
    });
  }
  revisions.sort((a, b) => a.revision - b.revision || a.at - b.at);

  const lastRevision = revisions.at(-1).revision;
  const corrections = revisions
    .filter(item => item.kind === 'corrected')
    .map(item => ({ ...item, reason: item.revision === lastRevision ? belief.reason : '' }));

  const dependents = db.all('SELECT dependent_id, kind, status, updated_at FROM belief_dependents WHERE belief_id = ? ORDER BY dependent_id', beliefId)
    .map(row => ({ dependentId: row.dependent_id, kind: row.kind, status: row.status, updatedAt: Number(row.updated_at) }));

  const successorRow = belief.supersededBy ? beliefRow(db, key, belief.supersededBy) : null;
  const predecessorRows = db.all('SELECT * FROM beliefs WHERE scope = ? AND superseded_by = ? ORDER BY updated_at ASC, belief_id ASC', key, beliefId);

  return {
    scopeKey: key,
    ...belief,
    evidence,
    revisions,
    corrections,
    dependents,
    successor: successorRow
      ? { beliefId: successorRow.belief_id, proposition: successorRow.proposition, status: successorRow.status, reason: successorRow.reason || '' }
      : null,
    predecessors: predecessorRows.map(row => ({
      beliefId: row.belief_id,
      proposition: row.proposition,
      status: row.status,
      reason: row.reason || '',
      supersededBy: row.superseded_by || '',
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    })),
  };
}

// --------------------------------------------------------------- consumer reducer

const RESULT_KEYS = Object.freeze([
  'beliefId', 'status', 'confidence', 'independence', 'revision', 'created', 'relation', 'added',
  'supersededBy', 'replacementId', 'invalidatedDependents', 'code', 'expired', 'beliefIds',
  'dependentId', 'kind',
]);

/** Receipts only carry IDs, versions, counts and reason codes — never private text. */
function receiptOf(outcome = {}) {
  const result = {};
  for (const key of RESULT_KEYS) {
    if (outcome[key] !== undefined) result[key] = outcome[key];
  }
  return result;
}

/**
 * Reducer for the `beliefs` consumer: one event, one transaction.
 *
 * Writes happen in the reducer body (which `applyEvent` already wraps in a
 * transaction), so a direct call is as safe as an integrated one and a second delivery
 * of the same event changes nothing. Time comes from `event.occurredAt`, so replaying
 * the recorded log rebuilds identical rows.
 */
export function applyBeliefEvent({ db, event, slice, now } = {}) {
  const kind = typeof event?.kind === 'string' ? event.kind : '';
  if (!CONSUMERS.beliefs.includes(kind)) return {};
  rejectSilenceBasis(event);

  const { scopeKey: key } = address({ scope: event.scope, scopeKey: event.scopeKey });
  const at = atOf(event.occurredAt, atOf(now, db.now()));
  const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
  const roots = rootList(event.rootEvidenceIds, payload.rootEvidenceIds, payload.roots);

  const outcome = db.tx(() => {
    switch (kind) {
      case 'belief/asserted':
        return assertBelief(db, {
          scopeKey: key,
          proposition: payload.proposition,
          rootEvidenceIds: roots,
          validUntil: payload.validUntil,
          source: payload.source,
          now: at,
        });
      case 'belief/evidence':
        return addEvidence(db, {
          scopeKey: key,
          beliefId: payload.beliefId,
          evidenceId: payload.evidenceId,
          rootId: payload.rootId || payload.evidenceId,
          relation: payload.relation,
          eventId: event.eventId,
          now: at,
        });
      case 'belief/corrected':
        return correctBelief(db, {
          scopeKey: key,
          beliefId: payload.beliefId,
          byEvidenceId: payload.byEvidenceId || roots[0],
          reason: payload.reason,
          replacement: payload.replacement ?? '',
          now: at,
        });
      case 'belief/expired':
        return expireBeliefs(db, { scopeKey: key, now: atOf(payload.at, at) });
      default:
        return {};
    }
  });

  const summary = scopeSummary(db, key);
  return {
    // Counts only: the slice is a projection, the propositions live in the tables.
    slice: { ...summary, lastAction: kind, observedAt: at },
    result: { action: kind, ...receiptOf(outcome) },
  };
}
