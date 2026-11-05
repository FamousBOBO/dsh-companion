// P2 shared autonomous budget (contract logs/p2-autonomous-day/contract-p2.md section 4 and
// the v1.1 amendment section BLOCK-3).
//
// One pool per (scope, role-local day) shared by planning, exploration, reading and writing. A
// plan may borrow quota from an idle afternoon, but the pool can never be overdrawn, retries
// are counted, and a recovery reserve is held back so a failed long activity can still be
// saved and closed.
//
// Hard rules (review pass 1, BLOCK-3):
//   * a reservation occupies quota immediately, including the estimated tokens;
//   * `settle` is mandatory, and a reservation that was issued and never settled is closed as
//     `:unsettled` after UNSETTLED_MS instead of silently freeing quota;
//   * `release` only works for a reservation that never left the process (`issued = 0`);
//   * the recovery reserve is a real gate, not a diagnostic number;
//   * the day key is frozen at mount time, so changing `timeZone` cannot mint a new day.
//
// Accounting lives in `p2_budget_ledger`, deliberately excluded from replay comparison: tokens
// and reservations are operational facts, not cognitive state.

import crypto from 'node:crypto';
import { RuntimeError } from './errors.mjs';

export const BUDGET_KINDS = Object.freeze(['requests', 'input_tokens', 'output_tokens']);
const UNSETTLED_MS = 10 * 60 * 1000;

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function dayKey(now, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
  } catch {
    return new Date(now).toISOString().slice(0, 10);
  }
}

/**
 * @param db          open runtime DB (tx/get/all/run/assertLeaseHeld)
 * @param config      runtime config (`config.p2.budget`)
 * @param clock       injected wall clock (epoch ms)
 * @param timeZone    role time zone, captured once (the day key never follows a later edit)
 * @param owner / generation  writer identity, checked inside the same transaction
 * @param shouldYield optional hook: true while a foreground chat turn needs the model
 */
export function createBudget({ db, config, clock = () => Date.now(), timeZone = 'Asia/Shanghai', owner, generation, shouldYield = () => false }) {
  const frozenTimeZone = timeZone;
  const limits = () => config.p2?.budget ?? {};
  const day = now => dayKey(now, frozenTimeZone);

  function usage(dayValue, scope, now) {
    const spent = { requests: 0, input_tokens: 0, output_tokens: 0 };
    const settled = db.all(`SELECT kind, SUM(amount) AS total FROM p2_budget_ledger
                            WHERE scope = ? AND day = ? AND settled = 1 GROUP BY kind`, scope, dayValue);
    for (const row of settled) {
      if (row.kind in spent) spent[row.kind] = Number(row.total ?? 0);
    }
    // In-flight reservations also occupy the allowance: a request that was issued but not yet
    // settled must never be double-spent.
    // In-flight reservations occupy the allowance immediately: a request counts as one and its
    // estimated tokens count as their estimate, whether or not `markIssued` has happened yet
    // (review pass 2, N-4). `release` deletes a reservation that never left the process, so this
    // cannot be used to park quota forever.
    const inflight = db.all(`SELECT kind, SUM(CASE WHEN kind = 'requests' THEN 1 ELSE amount END) AS total
                             FROM p2_budget_ledger WHERE scope = ? AND day = ? AND settled = 0 AND reserved = 1
                             GROUP BY kind`, scope, dayValue);
    for (const row of inflight) {
      if (row.kind in spent) spent[row.kind] += Number(row.total ?? 0);
    }
    return spent;
  }

  /** Close reservations that were issued and never settled (crash, kill, timeout). */
  function sweep({ scope, now = Number(clock()) } = {}) {
    const cutoff = now - UNSETTLED_MS;
    return db.tx(() => {
      db.assertLeaseHeld({ owner, generation, at: now });
      const stale = db.all(`SELECT entry_id FROM p2_budget_ledger
                            WHERE scope = ? AND settled = 0 AND reserved = 1 AND at < ?`, scope, cutoff);
      for (const row of stale) {
        db.run(`UPDATE p2_budget_ledger SET settled = 1, reserved = 0, amount = CASE WHEN kind = 'requests' THEN 1 ELSE amount END,
                purpose = purpose || ':unsettled' WHERE entry_id = ?`, row.entry_id);
      }
      return { ok: true, closed: stale.length };
    });
  }

  function status({ scope, now = Number(clock()) } = {}) {
    const dayValue = day(now);
    const configLimits = limits();
    const used = scope ? usage(dayValue, scope, now) : { requests: 0, input_tokens: 0, output_tokens: 0 };
    const requestLimit = Number(configLimits.maxRequestsPerDay ?? 0);
    const requestsLeft = Math.max(0, requestLimit - used.requests);
    const recoveryPayments = Math.ceil(requestLimit * Number(configLimits.recoveryReserveRatio ?? 0.2));
    return {
      day: dayValue,
      timeZone: frozenTimeZone,
      requests: { limit: requestLimit, used: used.requests, remaining: requestsLeft },
      inputTokens: { limit: Number(configLimits.maxInputTokensPerDay ?? 0), used: used.input_tokens, remaining: Math.max(0, Number(configLimits.maxInputTokensPerDay ?? 0) - used.input_tokens) },
      outputTokens: { limit: Number(configLimits.maxOutputTokensPerDay ?? 0), used: used.output_tokens, remaining: Math.max(0, Number(configLimits.maxOutputTokensPerDay ?? 0) - used.output_tokens) },
      // Hard gate: normal work may not touch the reserve; recovery/closure may.
      recoveryReserve: { requests: recoveryPayments, usableForNormalWork: Math.max(0, requestsLeft - recoveryPayments) },
      concurrency: { limit: Number(configLimits.maxConcurrent ?? 2), policy: configLimits.chatPriority === false ? 'fair' : 'chat-first' },
      cost: { known: false, limit: Number(configLimits.maxCostPerDay ?? 0), note: 'price unknown; no monetary estimate is invented' },
    };
  }

  /**
   * Reserve one model request plus its estimated tokens.
   * @returns {{ok:true, ref:string, day:string, status:object} | {ok:false, code:string}}
   */
  function reserve({ scope, purpose = 'p2-planning', ref = '', estimatedInputTokens = 0, estimatedOutputTokens = 0, kind = 'normal', now = Number(clock()) } = {}) {
    if (!scope) return { ok: false, code: 'unbound' };
    const requestedBy = now;
    const dayValue = day(now);
    return db.tx(() => {
      db.assertLeaseHeld({ owner, generation, at: now });
      if (config.p2?.budget?.chatPriority !== false && shouldYield() && kind !== 'recovery') {
        return { ok: false, code: 'chat-priority' };
      }
      const current = status({ scope, now });
      const usable = kind === 'recovery' ? current.requests.remaining : current.recoveryReserve.usableForNormalWork;
      if (usable < 1) return { ok: false, code: 'budget-exhausted', remaining: current.requests.remaining };
      if (current.inputTokens.remaining < estimatedInputTokens || current.outputTokens.remaining < estimatedOutputTokens) {
        return { ok: false, code: 'budget-exhausted', tokens: true, remaining: current.requests.remaining };
      }
      // Every *attempt* gets its own reservation row, so a retried segment (or the same segment
      // retried by a new writer after a lease takeover) can never collide with the previous
      // attempt's row (`UNIQUE constraint failed: p2_budget_ledger.entry_id`) and can never be
      // booked for free. Old issued attempts keep their conservative charge: they are settled
      // with their estimate and are never deleted or ignored.
      const baseId = ref || id('budget');
      const attempt = Number(db.get("SELECT COUNT(*) AS n FROM p2_budget_ledger WHERE kind = 'requests' AND (ref = ? OR entry_id = ? OR entry_id LIKE ?)", baseId, baseId, `${baseId}#%`)?.n ?? 0) + 1;
      const entryId = attempt === 1 ? baseId : `${baseId}#${attempt}`;
      db.run(`INSERT INTO p2_budget_ledger (entry_id, scope, day, kind, amount, purpose, ref, at, reserved, settled, issued)
              VALUES (?, ?, ?, 'requests', 1, ?, ?, ?, 1, 0, 0)`, entryId, scope, dayValue, purpose, entryId, requestedBy);
      if (estimatedInputTokens > 0) {
        db.run(`INSERT INTO p2_budget_ledger (entry_id, scope, day, kind, amount, purpose, ref, at, reserved, settled, issued)
                VALUES (?, ?, ?, 'input_tokens', ?, ?, ?, ?, 1, 0, 0)`, `${entryId}_in`, scope, dayValue, Math.trunc(estimatedInputTokens), purpose, entryId, requestedBy);
      }
      if (estimatedOutputTokens > 0) {
        db.run(`INSERT INTO p2_budget_ledger (entry_id, scope, day, kind, amount, purpose, ref, at, reserved, settled, issued)
                VALUES (?, ?, ?, 'output_tokens', ?, ?, ?, ?, 1, 0, 0)`, `${entryId}_out`, scope, dayValue, Math.trunc(estimatedOutputTokens), purpose, entryId, requestedBy);
      }
      return { ok: true, ref: entryId, day: dayValue, status: current };
    });
  }

  /** Mark a reservation as actually sent to the model: from now on it can never be released. */
  function markIssued({ scope, ref, now = Number(clock()) } = {}) {
    if (!scope || !ref) return { ok: false, code: 'invalid-input' };
    return db.tx(() => {
      db.assertLeaseHeld({ owner, generation, at: now });
      const rows = db.all("SELECT entry_id FROM p2_budget_ledger WHERE ref = ? AND scope = ? AND settled = 0", ref, scope);
      if (!rows.length) return { ok: false, code: 'unknown-reservation' };
      db.run("UPDATE p2_budget_ledger SET issued = 1 WHERE ref = ? AND scope = ? AND settled = 0", ref, scope);
      return { ok: true, ref };
    });
  }

  /** Settle a reservation with the real usage. Idempotent per ref. */
  function settle({ scope, ref, inputTokens = 0, outputTokens = 0, ok = true, code = '', now = Number(clock()) } = {}) {
    if (!scope || !ref) return { ok: false, code: 'invalid-input' };
    const dayValue = day(now);
    return db.tx(() => {
      db.assertLeaseHeld({ owner, generation, at: now });
      const request = db.get("SELECT entry_id, settled FROM p2_budget_ledger WHERE entry_id = ? AND kind = 'requests'", ref);
      if (!request) return { ok: false, code: 'unknown-reservation' };
      if (Number(request.settled) === 1) return { ok: true, alreadySettled: true };
      db.run("UPDATE p2_budget_ledger SET settled = 1, amount = 1, reserved = 0, issued = 1 WHERE entry_id = ?", ref);
      db.run(`UPDATE p2_budget_ledger SET settled = 1, amount = ?, reserved = 0 WHERE entry_id = ? AND kind = 'input_tokens'`, Math.max(0, Math.trunc(inputTokens)), `${ref}_in`);
      const outRow = db.get("SELECT entry_id FROM p2_budget_ledger WHERE entry_id = ? AND kind = 'output_tokens'", `${ref}_out`);
      if (outRow) db.run("UPDATE p2_budget_ledger SET settled = 1, amount = ?, reserved = 0 WHERE entry_id = ?", Math.max(0, Math.trunc(outputTokens)), `${ref}_out`);
      else db.run(`INSERT INTO p2_budget_ledger (entry_id, scope, day, kind, amount, purpose, ref, at, reserved, settled, issued)
                   VALUES (?, ?, ?, 'output_tokens', ?, '', ?, ?, 0, 1, 1)`, `${ref}_out`, scope, dayValue, Math.max(0, Math.trunc(outputTokens)), ref, Number(now));
      if (!ok || code) {
        db.run("UPDATE p2_budget_ledger SET purpose = purpose || ':' || ? WHERE entry_id = ?", String(code || 'failed').slice(0, 40), ref);
      }
      return { ok: true, day: dayValue };
    });
  }

  /** Can normal work start without touching the recovery reserve? */
  function canSpend({ scope, requests = 1, inputTokens = 0, now = Number(clock()) } = {}) {
    const current = status({ scope, now });
    return current.recoveryReserve.usableForNormalWork >= requests && current.inputTokens.remaining >= inputTokens;
  }

  /**
   * Release a reservation that never left the process. Anything already issued stays counted:
   * a provider may still bill it, so erasing it would make the pool free to farm.
   */
  function release({ scope, ref, now = Number(clock()) } = {}) {
    if (!scope || !ref) return { ok: false, code: 'invalid-input' };
    return db.tx(() => {
      db.assertLeaseHeld({ owner, generation, at: now });
      const rows = db.all("SELECT entry_id, issued, settled FROM p2_budget_ledger WHERE ref = ? AND scope = ?", ref, scope);
      if (!rows.length) return { ok: false, code: 'unknown-reservation' };
      if (rows.some(row => Number(row.issued) === 1 || Number(row.settled) === 1)) return { ok: false, code: 'already-issued' };
      db.run("DELETE FROM p2_budget_ledger WHERE ref = ? AND scope = ?", ref, scope);
      return { ok: true, released: rows.length };
    });
  }

  return { reserve, markIssued, settle, status, canSpend, release, sweep, dayKey: day, timeZone: frozenTimeZone, limits };
}
