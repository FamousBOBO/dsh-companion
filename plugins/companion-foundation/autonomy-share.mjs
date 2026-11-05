// P2 share-candidate sink (contract v1.2 section 6).
//
// What the contact owner actually exposes was checked before writing this file: channel-qq
// registers its contact service into its **own** sub-plugin ServiceBag
// (`plugins/dsh-channel-qq/src/features/plugin-kit.ts:108` `interface ServiceBag`,
// `:230` `provide`, `:269` `createHost`; `plugins/dsh-channel-qq/src/features/contact/index.ts:396`
// `host.provide('contact', service)`). That bag is per-section and never reaches the DSH
// plugin context, so `ctx.get('companionContact')` / `ctx.get('companionContactShare')` can
// never resolve, and the P2 share port used to be permanently `unavailable`.
//
// This module is the minimal receiver the contract asks for instead of a fake service:
//
//   * a durable JSONL candidate inbox under the companion home
//     (`home/companion/share-candidates.jsonl`);
//   * it never sends anything, never touches the contact ledger, never changes the
//     outbound switches — it only appends candidate lines and reads them back;
//   * it reports `degraded:'contact-service-absent'` so nobody mistakes it for a wired
//     contact path.
//
// Reader contract (for the future contact owner):
//   every line is one JSON object, `schema: 'p2-share-candidate/v1'`, append-only.
//     candidate  : { type:'candidate', seq, candidateId, scopeKey, activityId, kind, title,
//                    body, sourceRef, submittedAt, source:'p2' }
//     withdrawal : { type:'withdrawal', seq, candidateId, scopeKey, reason, at }
//   Current state is the fold of all lines in file order: the last record for one
//   `candidateId` decides (`pending` after a candidate line, `withdrawn` after a withdrawal
//   line). Withdrawal **appends** a record; it never rewrites or deletes history.
//   One live candidate per `(scopeKey, activityId, kind)` — the same identity P2 uses for
//   its own pending queue — so a repeated submit is a no-op and never appends twice.

import fs from 'node:fs';
import path from 'node:path';

export const SHARE_SCHEMA = 'p2-share-candidate/v1';
export const SHARE_SINK_RELATIVE = 'home/companion/share-candidates.jsonl';
export const SHARE_SINK_KIND = 'jsonl';
export const SHARE_DEGRADED = 'contact-service-absent';
export const MAX_TITLE_CHARS = 200;
export const MAX_BODY_CHARS = 2000;
export const MAX_REF_CHARS = 300;
export const MAX_ID_CHARS = 120;

const SCOPE_KEY = /^u:.+\|p:.+\|w:.+$/;

function textOf(value) {
  return typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value));
}

function insideRoot(target, base) {
  const resolved = path.resolve(target);
  const relative = path.relative(base, resolved);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function normalizeStatus(value) {
  const status = textOf(value).trim().toLowerCase();
  return status === 'withdrawn' || status === 'all' || status === 'pending' ? status : 'pending';
}

/**
 * Build the candidate sink.
 *
 * @param root          companion root (`home/companion` lives under it)
 * @param sinkRelative  sink path relative to `root`
 * @param enabled       boolean or `() => boolean`; the P2 share switch. Off ⇒ zero writes.
 * @param now           injectable clock
 */
export function createShareCandidatePort({ root, sinkRelative = SHARE_SINK_RELATIVE, enabled = true, now = () => Date.now() } = {}) {
  const base = path.resolve(root);
  const sink = path.resolve(base, sinkRelative);
  if (!insideRoot(sink, base)) throw new Error(`share sink escapes the companion root: ${sinkRelative}`);

  function on() {
    try { return typeof enabled === 'function' ? enabled() === true : enabled === true; } catch { return false; }
  }

  function readRecords() {
    let raw = '';
    try { raw = fs.readFileSync(sink, 'utf8'); } catch { return { records: [], corrupt: 0 }; }
    const records = [];
    let corrupt = 0;
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && parsed.schema === SHARE_SCHEMA) records.push(parsed);
        else corrupt += 1;
      } catch { corrupt += 1; }
    }
    return { records, corrupt };
  }

  function dedupeKey(record) {
    const activity = textOf(record.activityId).trim();
    return [textOf(record.scopeKey).trim(), activity || `candidate:${textOf(record.candidateId).trim()}`, textOf(record.kind).trim() || 'activity'].join('|');
  }

  /** Fold the append-only log into the current state (last record per candidate wins). */
  function fold(records) {
    const candidates = new Map();
    let withdrawals = 0;
    let seq = 0;
    for (const record of records) {
      const candidateId = textOf(record.candidateId).trim();
      if (!candidateId) continue;
      seq = Math.max(seq, Number(record.seq) || 0);
      if (record.type === 'withdrawal') {
        withdrawals += 1;
        const current = candidates.get(candidateId);
        if (current) { current.status = 'withdrawn'; current.withdrawnAt = Number(record.at) || 0; current.withdrawReason = textOf(record.reason); }
        else candidates.set(candidateId, { candidateId, scopeKey: textOf(record.scopeKey), status: 'withdrawn', withdrawnAt: Number(record.at) || 0, withdrawReason: textOf(record.reason), seq });
        continue;
      }
      candidates.set(candidateId, {
        candidateId,
        scopeKey: textOf(record.scopeKey).trim(),
        activityId: textOf(record.activityId).trim(),
        kind: textOf(record.kind).trim() || 'activity',
        title: textOf(record.title),
        body: textOf(record.body),
        sourceRef: textOf(record.sourceRef),
        status: 'pending',
        submittedAt: Number(record.submittedAt) || 0,
        seq: Number(record.seq) || 0,
      });
    }
    // Live = one pending candidate per (scope, activity, kind). Rebuilt after the fold so a
    // withdrawal really frees the identity: a later candidate for the same activity is allowed.
    const live = new Map();
    for (const entry of candidates.values()) {
      if (entry.status !== 'pending') continue;
      live.set(dedupeKey(entry), entry.candidateId);
    }
    return { candidates, live, withdrawals, seq };
  }

  function append(record) {
    try {
      fs.mkdirSync(path.dirname(sink), { recursive: true });
      fs.appendFileSync(sink, `${JSON.stringify(record)}\n`, 'utf8');
      return { ok: true };
    } catch (error) {
      return { ok: false, code: 'share-sink-failed', reason: (error instanceof Error ? error.message : String(error)).slice(0, 160) };
    }
  }

  function validate(candidate) {
    const scopeKey = textOf(candidate?.scopeKey ?? candidate?.scope).trim();
    if (!scopeKey) return { ok: false, code: 'invalid-candidate', reason: 'scope-required' };
    // Scope-bound: a candidate that does not carry a complete runtime scope is refused
    // rather than written into an unreadable line.
    if (!SCOPE_KEY.test(scopeKey)) return { ok: false, code: 'invalid-candidate', reason: 'scope-malformed' };
    const candidateId = textOf(candidate?.candidateId).trim();
    if (!candidateId || candidateId.length > MAX_ID_CHARS) return { ok: false, code: 'invalid-candidate', reason: 'candidate-id-required' };
    const title = textOf(candidate?.title).trim();
    if (!title) return { ok: false, code: 'invalid-candidate', reason: 'title-required' };
    return {
      ok: true,
      value: {
        scopeKey,
        candidateId,
        activityId: textOf(candidate?.activityId).trim().slice(0, MAX_ID_CHARS),
        kind: (textOf(candidate?.kind).trim() || 'activity').slice(0, 40),
        title: title.slice(0, MAX_TITLE_CHARS),
        body: textOf(candidate?.body).slice(0, MAX_BODY_CHARS),
        sourceRef: textOf(candidate?.sourceRef).slice(0, MAX_REF_CHARS),
      },
    };
  }

  /**
   * Hand one candidate to the sink. Never sends: this is the whole delivery surface.
   * Idempotent per `(scopeKey, activityId, kind)`.
   */
  async function submit(candidate) {
    if (!on()) return { ok: false, code: 'share-disabled', written: false };
    const valid = validate(candidate);
    if (!valid.ok) return { ...valid, written: false };
    const value = valid.value;
    const { records } = readRecords();
    const state = fold(records);
    const duplicateId = state.live.get(dedupeKey(value));
    if (duplicateId) {
      const existing = state.candidates.get(duplicateId);
      return { ok: true, duplicate: true, written: false, candidateId: duplicateId, line: existing?.seq ?? 0, sink: SHARE_SINK_KIND, path: sink };
    }
    const record = {
      schema: SHARE_SCHEMA,
      type: 'candidate',
      seq: state.seq + 1,
      candidateId: value.candidateId,
      scopeKey: value.scopeKey,
      activityId: value.activityId,
      kind: value.kind,
      title: value.title,
      body: value.body,
      sourceRef: value.sourceRef,
      submittedAt: Number(now()) || Date.now(),
      source: 'p2',
    };
    const written = append(record);
    if (!written.ok) return { ...written, written: false };
    return { ok: true, duplicate: false, written: true, candidateId: value.candidateId, line: record.seq, sink: SHARE_SINK_KIND, path: sink };
  }

  /**
   * Retire one candidate. Appends a withdrawal record (history is never rewritten);
   * a reader folds the log and sees `withdrawn`.
   */
  async function withdraw({ scopeKey, candidateId, reason = '' } = {}) {
    if (!on()) return { ok: false, code: 'share-disabled', written: false };
    const scope = textOf(scopeKey).trim();
    const id = textOf(candidateId).trim();
    if (!scope || !id) return { ok: false, code: 'invalid-candidate', reason: 'scope-and-candidate-required', written: false };
    const { records } = readRecords();
    const state = fold(records);
    const entry = state.candidates.get(id);
    if (!entry) return { ok: false, code: 'candidate-not-found', written: false };
    if (entry.scopeKey !== scope) return { ok: false, code: 'scope-mismatch', written: false };
    if (entry.status !== 'pending') return { ok: false, code: 'candidate-not-pending', status: entry.status, written: false };
    const record = {
      schema: SHARE_SCHEMA,
      type: 'withdrawal',
      seq: state.seq + 1,
      candidateId: id,
      scopeKey: scope,
      reason: textOf(reason).slice(0, 120),
      at: Number(now()) || Date.now(),
    };
    const written = append(record);
    if (!written.ok) return { ...written, written: false };
    return { ok: true, status: 'withdrawn', written: true, line: record.seq, sink: SHARE_SINK_KIND, path: sink };
  }

  /** Read the sink back. Scope-bound and bounded; never trusts a corrupt line. */
  function read({ scopeKey, status = 'pending', limit = 20 } = {}) {
    const scope = textOf(scopeKey).trim();
    const wanted = normalizeStatus(status);
    const cap = Math.min(50, Math.max(1, Math.trunc(Number(limit) || 20)));
    const { records, corrupt } = readRecords();
    const state = fold(records);
    const rows = [...state.candidates.values()]
      .filter(entry => (!scope || entry.scopeKey === scope) && (wanted === 'all' || entry.status === wanted))
      .sort((left, right) => (right.seq || 0) - (left.seq || 0))
      .slice(0, cap);
    return { ok: true, candidates: rows, total: state.candidates.size, live: state.live.size, corrupt, sink: SHARE_SINK_KIND, path: sink };
  }

  function describe() {
    const on_ = on();
    const { records, corrupt } = readRecords();
    const state = fold(records);
    return {
      available: on_,
      port: 'share-candidates',
      sink: SHARE_SINK_KIND,
      path: sink,
      enabled: on_,
      degraded: on_ ? SHARE_DEGRADED : 'share-disabled',
      contactSeam: 'absent',
      counts: { candidates: state.candidates.size, live: state.live.size, withdrawals: state.withdrawals, corrupt },
    };
  }

  return { available: on(), submit, withdraw, read, describe };
}

export { insideRoot };
