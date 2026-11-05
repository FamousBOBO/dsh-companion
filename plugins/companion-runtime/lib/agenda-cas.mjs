// 3A-4/3A-5 — the runtime half of the agenda CAS seam.
//
// The QQ side owns *sending* the reminder. Before it sends it must confirm the plan is still the
// plan it read (`casOccurrence`), and after it sends it must record that it did
// (`markOccurrenceDispatched`). Both used to be no-ops on this side, so "a cancelled schedule no
// longer sends" and "the event book contains a dispatched" had only unit-test evidence.
//
// Design constraints (task-25):
//   - the compare-and-swap runs inside **one transaction**;
//   - `revision-changed` carries `actualRevision` so the caller can re-read instead of guessing;
//   - `markOccurrenceDispatched` **appends** `agenda/occurrence-dispatched` (payload carries
//     `consumer`, `receipt`, `revision`) and is idempotent per `(occurrenceId, revision)`;
//   - **zero migration**: `agenda_occurrences` has no `dispatched_at` / `dispatch_receipt` column,
//     so the receipt lives in the existing `runtime_meta` table under
//     `agenda_dispatch:<occurrenceId>` (JSON: requestedRevision, revision, receipt, at). The
//     occurrence's own status/revision are moved by the normal reducer, never by hand.
//   - this file never sends anything: `reminderDelivery` stays `not-wired` (CONTRACT §13.8).

import { RuntimeError } from './errors.mjs';

/** `cancelled` as a *reason* is a plan-level fact, so it is reported separately from a CAS miss. */
const CANCELLED_ITEM_STATUS = new Set(['cancelled', 'expired']);

export const DISPATCH_RECEIPT_PREFIX = 'agenda_dispatch:';

export function dispatchReceiptKey(occurrenceId) {
  return `${DISPATCH_RECEIPT_PREFIX}${String(occurrenceId ?? '')}`;
}

/**
 * The receipt row for one occurrence, or null.
 *
 * `runtime_meta` is the zero-migration home for it: the table already exists, is written under the
 * same lease as every other runtime write, and its shape (`meta_key`, `meta_value`, `updated_at`)
 * is exactly "one small JSON blob per key".
 */
export function readDispatchReceipt(db, occurrenceId) {
  try {
    const row = db.get('SELECT meta_value, updated_at FROM runtime_meta WHERE meta_key = ?', dispatchReceiptKey(occurrenceId));
    if (!row) return null;
    let value = {};
    try { value = JSON.parse(String(row.meta_value ?? '{}')); } catch { value = {}; }
    return {
      requestedRevision: Number(value.requestedRevision) || 0,
      revision: Number(value.revision) || 0,
      receipt: String(value.receipt ?? ''),
      at: Number(value.at) || Number(row.updated_at) || 0,
    };
  } catch { return null; }
}

function writeDispatchReceipt(db, occurrenceId, payload) {
  const at = Number(payload.at) || 0;
  const body = JSON.stringify({
    requestedRevision: Number(payload.requestedRevision) || 0,
    revision: Number(payload.revision) || 0,
    receipt: String(payload.receipt ?? '').slice(0, 200),
    at,
  });
  db.run(`INSERT INTO runtime_meta (meta_key, meta_value, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value, updated_at = excluded.updated_at`,
  dispatchReceiptKey(occurrenceId), body, at);
}

function readOccurrence(db, scopeKey, occurrenceId) {
  return db.get(`SELECT occurrence_id, scope, item_id, slot_key, scheduled_at, slot_end_at, status, reason_code,
                        revision, attempts, updated_at
                 FROM agenda_occurrences WHERE scope = ? AND occurrence_id = ?`, scopeKey, occurrenceId) ?? null;
}

function readItemStatus(db, scopeKey, itemId) {
  return String(db.get('SELECT status FROM agenda_items WHERE scope = ? AND item_id = ?', scopeKey, itemId)?.status ?? '');
}

function occurrenceView(row) {
  return {
    id: row.occurrence_id,
    // The agenda's schedule is the item; the contract calls it `scheduleId`.
    scheduleId: row.item_id,
    dueAt: Number(row.scheduled_at) || 0,
    revision: Number(row.revision) || 0,
    status: String(row.status ?? ''),
  };
}

/**
 * Compare-and-swap one occurrence revision.
 *
 * Returns the *current* state when the swap succeeds, and a typed refusal otherwise. A cancelled or
 * expired **schedule** reports `cancelled` (a plan fact the caller can explain), while a stale
 * revision reports `revision-changed` with `actualRevision` (a race the caller can re-read).
 */
export function casOccurrence(db, { scopeKey, occurrenceId, revision, at = 0, enabled = true } = {}) {
  if (enabled !== true) return { ok: false, code: 'disabled' };
  if (!db || typeof db.tx !== 'function') return { ok: false, code: 'not-found' };
  const id = String(occurrenceId ?? '').trim();
  if (!id) return { ok: false, code: 'not-found' };
  const expected = Number(revision);
  if (!Number.isFinite(expected)) return { ok: false, code: 'not-found' };
  try {
    return db.tx(() => {
      const row = readOccurrence(db, scopeKey, id);
      if (!row) return { ok: false, code: 'not-found' };
      const itemStatus = readItemStatus(db, scopeKey, row.item_id);
      if (CANCELLED_ITEM_STATUS.has(itemStatus) || row.status === 'cancelled' || row.status === 'expired') {
        return { ok: false, code: 'cancelled', actualRevision: Number(row.revision) || 0 };
      }
      if (Number(row.revision) !== expected) {
        return { ok: false, code: 'revision-changed', actualRevision: Number(row.revision) || 0 };
      }
      return { ok: true, revision: Number(row.revision) || 0, occurrence: occurrenceView(row) };
    });
  } catch (error) {
    if (error instanceof RuntimeError) return { ok: false, code: error.code };
    return { ok: false, code: 'not-found' };
  }
}

/**
 * Record that the reminder was actually sent for `(occurrenceId, revision)`.
 *
 * The authoritative state change goes through the normal event (`agenda/occurrence-dispatched`) so
 * a replay reproduces it; the receipt goes to `runtime_meta` (zero migration). Both happen in one
 * transaction, and the receipt is written **before** the event, inside the same transaction: a
 * crash between them rolls both back, so "an event exists but no receipt" cannot happen.
 *
 * Idempotency is keyed on the **caller's** revision: calling twice with the same
 * `(occurrenceId, revision)` returns `already-dispatched` and appends nothing.
 */
export function markOccurrenceDispatched(db, {
  scopeKey, occurrenceId, revision, at = 0, receipt = '', consumer = 'reminders', enabled = true, emit = null,
} = {}) {
  if (enabled !== true) return { ok: false, code: 'disabled' };
  if (!db || typeof db.tx !== 'function') return { ok: false, code: 'not-found' };
  const id = String(occurrenceId ?? '').trim();
  if (!id) return { ok: false, code: 'not-found' };
  const expected = Number(revision);
  if (!Number.isFinite(expected)) return { ok: false, code: 'not-found' };
  const stamp = Number(at) || 0;
  const code = String(receipt ?? '').trim().slice(0, 200);
  try {
    return db.tx(() => {
      const row = readOccurrence(db, scopeKey, id);
      if (!row) return { ok: false, code: 'not-found' };
      const prior = readDispatchReceipt(db, id);
      // Same caller revision, already recorded: this is the idempotent second call. It is checked
      // *before* the revision comparison because dispatching bumps the occurrence revision, so a
      // retry would otherwise look like a plain stale-revision race.
      if (prior && prior.requestedRevision === expected) {
        return { ok: false, code: 'already-dispatched', revision: prior.revision };
      }
      if (row.status === 'dispatched' && prior) {
        return { ok: false, code: 'already-dispatched', revision: Number(row.revision) || prior.revision };
      }
      if (Number(row.revision) !== expected) {
        return { ok: false, code: 'revision-changed', actualRevision: Number(row.revision) || 0 };
      }
      const itemStatus = readItemStatus(db, scopeKey, row.item_id);
      if (CANCELLED_ITEM_STATUS.has(itemStatus) || row.status === 'cancelled' || row.status === 'expired') {
        return { ok: false, code: 'revision-changed', actualRevision: Number(row.revision) || 0 };
      }
      if (typeof emit !== 'function') throw new RuntimeError('event-required', 'markOccurrenceDispatched needs an event writer');
      const nextRevision = Number(row.revision) + 1;
      writeDispatchReceipt(db, id, { requestedRevision: expected, revision: nextRevision, receipt: code, at: stamp });
      try {
        emit({
          kind: 'agenda/occurrence-dispatched',
          occurredAt: stamp,
          payload: {
            occurrenceId: id,
            itemId: row.item_id,
            expectedRevision: expected,
            revision: nextRevision,
            consumer: String(consumer || 'reminders').slice(0, 60),
            receipt: code,
            now: stamp,
          },
        });
      } catch (error) {
        // The reducer refused (a stale revision, a forbidden transition): the receipt must not
        // survive a failed dispatch, so let the transaction roll back.
        throw error instanceof RuntimeError ? error : new RuntimeError('event-rejected', error?.message ?? String(error));
      }
      return { ok: true, revision: nextRevision };
    });
  } catch (error) {
    if (error instanceof RuntimeError) return { ok: false, code: error.code };
    return { ok: false, code: 'not-found' };
  }
}
