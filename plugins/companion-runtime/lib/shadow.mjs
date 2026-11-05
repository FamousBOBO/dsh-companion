import crypto from 'node:crypto';
import { scopeKey as scopeKeyOf } from './scope.mjs';

const MAX_PAYLOAD_CHARS = 2000;

function proposalId(parts) {
  return 'prop_' + crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24);
}

function compact(payload) {
  const text = JSON.stringify(payload ?? {});
  if (text.length <= MAX_PAYLOAD_CHARS) return text;
  return JSON.stringify({ truncated: true, chars: text.length, digest: crypto.createHash('sha256').update(text).digest('hex').slice(0, 16) });
}

/**
 * Shadow records what the runtime *would* have done without touching authoritative
 * state. Nothing here is injected, sent or promoted automatically.
 */
export function recordProposal(db, {
  scope, scopeKey, kind, payload = {}, expectedRevision = null, observedRevision = null,
  decision = 'accepted-shadow', detail = '', now = Date.now(),
} = {}) {
  const key = scopeKey ?? (scope ? scopeKeyOf(scope) : '');
  if (!key) throw new Error('recordProposal requires a scope');
  const at = Number(now);
  const id = proposalId([key, kind, at, payload]);
  db.run(`INSERT OR IGNORE INTO shadow_proposals
            (proposal_id, scope, kind, payload, expected_revision, observed_revision, decision, detail, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, key, kind, compact(payload), expectedRevision, observedRevision, decision, String(detail ?? '').slice(0, 200), at);
  return { proposalId: id, decision, kind };
}

export function listProposals(db, { scopeKey, kind, limit = 50 } = {}) {
  const clauses = [];
  const params = [];
  if (scopeKey) { clauses.push('scope = ?'); params.push(scopeKey); }
  if (kind) { clauses.push('kind = ?'); params.push(kind); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.all(`SELECT * FROM shadow_proposals ${where} ORDER BY created_at DESC LIMIT ?`, ...params, Math.trunc(limit))
    .map(row => ({
      proposalId: row.proposal_id,
      scopeKey: row.scope,
      kind: row.kind,
      payload: safeParse(row.payload),
      expectedRevision: row.expected_revision === null ? null : Number(row.expected_revision),
      observedRevision: row.observed_revision === null ? null : Number(row.observed_revision),
      decision: row.decision,
      detail: row.detail,
      createdAt: Number(row.created_at),
    }));
}

export function proposalCount(db, { scopeKey, decision } = {}) {
  const clauses = [];
  const params = [];
  if (scopeKey) { clauses.push('scope = ?'); params.push(scopeKey); }
  if (decision) { clauses.push('decision = ?'); params.push(decision); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return Number(db.get(`SELECT COUNT(*) AS n FROM shadow_proposals ${where}`, ...params)?.n ?? 0);
}

/** Keep the shadow log bounded; the newest proposals win. */
export function pruneProposals(db, max = 200) {
  const limit = Math.max(10, Number(max) || 200);
  const removed = db.run(`DELETE FROM shadow_proposals WHERE proposal_id NOT IN (
      SELECT proposal_id FROM shadow_proposals ORDER BY created_at DESC LIMIT ?)`, limit);
  return Number(removed.changes ?? 0);
}

function safeParse(text) {
  try { return JSON.parse(text || '{}'); } catch { return {}; }
}
