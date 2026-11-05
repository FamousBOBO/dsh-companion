/**
 * P2.5-4C observability: the eight planned metric groups, computed **read-only** from state that
 * already exists.
 *
 * Rules this file obeys (and the tests pin):
 *   - Every field is `{ value, source, honest }`. `honest` is one of exactly four labels:
 *       `measured`    — the query ran; this is the number (0 is a legitimate measurement);
 *       `estimated`   — derived from a proxy, and the proxy is named in `source`;
 *       `not-wired`   — the capability does not exist in this build (value is `null`);
 *       `unavailable` — the capability exists but the query **failed** (value is `null`).
 *     A failed query is `null` + `unavailable`, **never 0**: "we could not ask" and "the answer is
 *     zero" are different facts, and reporting the first as the second is how a broken database
 *     looks healthy.
 *   - Each group carries `state: 'active' | 'disabled' | 'not-wired'`. `disabled` means the
 *     capability exists and is turned off; `not-wired` means the code path does not exist yet.
 *   - Read-only: no writes, no new tables, no business tables touched, a bounded number of
 *     queries. Text fields are never exposed — ids, counts, durations and reason codes only.
 *   - This is a **projection**, not the authority: the authoritative numbers live in the P2
 *     controller (`lib/p2.mjs status()`) and in the event log.
 */

// P2.5 (CONTRACT §15.1): the dispatch measurements live in one place so the eight groups and the
// P2 controller cannot disagree about what `slots_due` or `claim_age_ms` means.
import { dispatchMetrics } from './dispatch-observability.mjs';

const METRIC_SOURCES = Object.freeze({
  slots: 'p2_plan_slots',
  activities: 'p2_activities',
  receipts: 'p2_activity_receipts (code=lc-effect)',
  events: 'domain_events',
  outbox: 'memory_outbox',
  runs: 'p2_plan_runs',
  ledger: 'p2_budget_ledger',
  lease: 'runtime_lease',
  agenda: 'agenda_occurrences',
  share: 'p2_share_candidates',
  reconcile: 'runtime_meta (p2_p1_reaudit_state / deferred_streak)',
});

/** One metric with its provenance and honesty label. */
export function metric(value, source, honest = 'measured') {
  const resolved = value === undefined ? null : value;
  // round-4 B11: `estimated` / `measured` claim "here is a number". A null value cannot be either, so
  // it is reported as `unavailable` — the fourth label — instead of keeping a label that implies data.
  if (resolved === null && (honest === 'measured' || honest === 'estimated')) {
    return { value: null, source, honest: 'unavailable' };
  }
  return { value: resolved, source, honest };
}

const numberOrNull = value => (value === null || value === undefined ? null : Number(value) || 0);

function safe(fn, fallback) {
  try { return fn(); } catch { return fallback; }
}

/** `null` map = the query failed ⇒ `null`; otherwise the count (0 is a real measurement). */
const countIn = (map, key) => (map === null || map === undefined ? null : Number(map[key] ?? 0));

/**
 * Read `{ status: count }`, distinguishing "no rows" (`{}`) from "the query failed" (`null`).
 * A throw must become `unavailable`, never a healthy zero (round-4 B11).
 */
/** One row, or `null` when the query failed (which is not the same as "no rows"). */
function readRow(db, sql, scope) {
  try {
    const row = db.get(sql, scope);
    // `null` (= "we could not read it"), never `{}`: an empty object reads as a real, empty measurement
    return row === null || row === undefined ? null : row;
  } catch { return null; }
}

function readStatusMap(db, sql, scope) {
  try {
    const rows = db.all(sql, scope) ?? [];
    const out = {};
    for (const row of rows) out[String(row.status)] = Number(row.n) || 0;
    return out;
  } catch { return null; }
}

function countOf(db, sql, ...params) {
  // round-3 B7: a query that *fails* is not a zero. Returning 0 here made a broken database look
  // healthy; callers now get `null` and label the metric `unavailable`.
  try {
    const row = db.get(sql, ...params);
    return row === null || row === undefined ? 0 : Number(row.n ?? 0);
  } catch { return null; }
}

/** A metric whose value is `null` when it could not be measured (never a fake 0). */
function measurable(value, source, honest = 'measured') {
  return value === null || value === undefined
    ? metric(null, source, 'unavailable')
    : metric(Number(value) || 0, source, honest);
}

/**
 * The eight groups from the plan (§4C). `switches` describes what is actually enabled, so a group
 * can say `disabled` instead of pretending to be idle.
 */
export function p2Observability(db, {
  scopeKey = '', now = Date.now(), switches = {}, hasDb = true, agendaPublication = null,
} = {}) {
  const groups = {};
  const scope = String(scopeKey ?? '');
  const activitiesOn = switches.activities === true;
  const planningOn = switches.planning === true;

  if (!hasDb || !db || typeof db.get !== 'function') {
    for (const name of ['slots', 'latency', 'liveness', 'model', 'memory', 'reminders', 'share', 'recovery']) {
      groups[name] = { state: 'not-wired', metrics: {}, note: 'no runtime database handle' };
    }
    return { projection: true, authority: 'lib/p2.mjs status()', generatedAt: Number(now) || 0, groups };
  }

  // ---- 1. slot/activity funnel -------------------------------------------------------------
  const slotStatuses = readStatusMap(db, 'SELECT status, COUNT(*) AS n FROM p2_plan_slots WHERE scope = ? GROUP BY status', scope);
  const activityStatuses = readStatusMap(db, 'SELECT status, COUNT(*) AS n FROM p2_activities WHERE scope = ? GROUP BY status', scope);
  // P2.5 (CONTRACT §15.1): `slots_due` used to count `status IN ('planned','started')`, i.e. the
  // all-time open backlog, under a name that promises "due **now**". Both numbers are useful and
  // they are not the same one, so both are reported: `slots_due` is the heartbeat's own predicate
  // (planned + window covers now + committed plan + no activity row), `slots_open` is the backlog.
  const dispatch = dispatchMetrics(db, { scopeKey: scope, now: Number(now) || 0 });
  const dispatchMetric = (value, source, honest = 'measured') => (
    dispatch.available !== true
      ? metric(null, source, 'unavailable')
      : metric(value, source, honest)
  );
  // An effect whose latest record says "may have happened" is exactly the unreconciled count.
  const unknownEffects = safe(() => Number(db.get(`
    SELECT COUNT(*) AS n FROM p2_activity_receipts r
    WHERE r.scope = ? AND r.code = 'lc-effect'
      AND r.rowid = (SELECT MAX(x.rowid) FROM p2_activity_receipts x
                     WHERE x.scope = r.scope AND x.code = r.code
                       AND json_extract(x.detail, '$.jobKey') = json_extract(r.detail, '$.jobKey'))
      AND (json_extract(r.detail, '$.phase') = 'unknown'
           OR (json_extract(r.detail, '$.phase') = 'prepared'
               AND CAST(json_extract(r.detail, '$.deadline') AS INTEGER) < ?))`, scope, Number(now) || 0)?.n ?? 0), null);
  groups.slots = {
    state: activitiesOn ? 'active' : 'disabled',
    metrics: {
      slots_due: dispatchMetric(dispatch.slots_due, `${METRIC_SOURCES.slots} (status='planned' AND window covers now AND plan committed AND no activity row)`),
      slots_claimable: dispatchMetric(dispatch.slots_claimable, `${METRIC_SOURCES.slots} + ${METRIC_SOURCES.receipts} (due minus unresolved-effect jobs)`),
      slots_effect_blocked: dispatchMetric(dispatch.slots_effect_blocked, `${METRIC_SOURCES.receipts} (lc-effect latest-per-job blocks)`, 'estimated'),
      // The old (mis-named) number, kept so nothing silently disappears from an operator view.
      slots_open: dispatchMetric(dispatch.slots_open, `${METRIC_SOURCES.slots} (status IN ('planned','started'), all time)`),
      dispatched: measurable(countIn(slotStatuses, 'started'), METRIC_SOURCES.slots),
      completed: measurable(countIn(activityStatuses, 'done'), METRIC_SOURCES.activities),
      skipped: measurable(countIn(slotStatuses, 'skipped'), METRIC_SOURCES.slots),
      failed: measurable(countIn(activityStatuses, 'failed'), METRIC_SOURCES.activities),
      unknown: measurable(unknownEffects, METRIC_SOURCES.receipts, 'estimated'),
    },
    note: 'slots_due is "a heartbeat beat could claim it right now"; slots_open is the all-time backlog — they are different questions and are never added together',
  };

  // ---- 2. latency --------------------------------------------------------------------------
  // `{}` used to mean both "no samples" and "the query threw"; `null` now means the query failed, and
  // every lag metric must report `unavailable` in that case (round-4 B11).
  const lag = (() => {
    try {
      const rows = db.all(`SELECT MAX(a.started_at - s.start_at) AS worst, AVG(a.started_at - s.start_at) AS mean, COUNT(*) AS n
                           FROM p2_activities a JOIN p2_plan_slots s ON s.slot_id = a.plan_slot_id
                           WHERE a.scope = ? AND a.started_at > 0 AND s.start_at > 0`, scope) ?? [];
      return rows[0] ?? {};
    } catch { return null; }
  })();
  const claimAt = countOf(db, "SELECT MAX(occurred_at) AS n FROM domain_events WHERE scope = ? AND kind = 'autonomy/plan-slot'", scope);
  // P2.5 (CONTRACT §15.1) — `claim_age_ms` used to be `now - MAX(occurred_at)` of a plan-slot
  // event, and `occurredAt` for a claim is the slot's **scheduled** start, so it measured "time
  // since the newest slot was scheduled" and was labelled `measured`. The honest definitions:
  //   dispatch_lag_ms — how late the oldest still-due slot already is right now (`null` if none);
  //   claim_age_ms    — how long the oldest claim has been waiting for the pump to materialise it,
  //                     measured from the claim's own wall clock (`recorded_at`), and `not-wired`
  //                     for claims written before that timestamp existed.
  const claimAge = (() => {
    if (dispatch.available !== true) return metric(null, `${METRIC_SOURCES.events} (autonomy/plan-slot claim)`, 'unavailable');
    const source = `${METRIC_SOURCES.events} (autonomy/plan-slot, recorded_at - now)`;
    if (dispatch.claim_age_source === 'recorded_at') return metric(dispatch.claim_age_ms, source, 'measured');
    if (dispatch.claim_age_source === 'none') return metric(null, 'no claim is waiting for the pump', 'not-wired');
    if (dispatch.claim_age_source === 'not-recorded') return metric(null, 'the waiting claim predates recorded_at; its wall clock was never stored', 'not-wired');
    return metric(null, source, 'unavailable');
  })();
  groups.latency = {
    state: activitiesOn ? 'active' : 'disabled',
    metrics: {
      // Currently pending: the oldest due slot that has not been claimed yet.
      dispatch_lag_ms: dispatchMetric(dispatch.dispatch_lag_ms, `${METRIC_SOURCES.slots} (now - oldest due slot start_at)`, 'measured'),
      dispatch_lag_max_ms: metric(lag === null ? null : numberOrNull(lag.worst), `${METRIC_SOURCES.activities} + ${METRIC_SOURCES.slots}`, 'estimated'),
      dispatch_lag_avg_ms: metric(lag === null || lag.mean === null || lag.mean === undefined ? null : Math.round(Number(lag.mean)), `${METRIC_SOURCES.activities} + ${METRIC_SOURCES.slots}`, 'estimated'),
      claim_age_ms: claimAge,
      samples: metric(lag === null ? null : Number(lag.n ?? 0), METRIC_SOURCES.activities),
    },
    note: 'dispatch_lag_ms is the pending lag (oldest due slot → now); dispatch_lag_max/avg_ms are historical samples (slot start → activity start); claim_age_ms is the wait for the pump after a heartbeat claim',
  };

  // ---- 3. liveness -------------------------------------------------------------------------
  const lease = safe(() => db.get('SELECT owner, generation, heartbeat_at, expires_at FROM runtime_lease ORDER BY heartbeat_at DESC LIMIT 1') ?? null, null);
  groups.liveness = {
    state: 'active',
    metrics: {
      last_heartbeat: metric(numberOrNull(lease?.heartbeat_at) ?? null, METRIC_SOURCES.lease, lease ? 'measured' : 'not-wired'),
      last_success: metric(safe(() => Number(db.get('SELECT MAX(at) AS n FROM p2_activity_receipts WHERE scope = ? AND ok = 1', scope)?.n ?? 0) || null, null), METRIC_SOURCES.receipts),
      lease_generation: metric(lease ? String(lease.generation ?? '') : null, METRIC_SOURCES.lease, lease ? 'measured' : 'not-wired'),
      lease_expires_at: metric(numberOrNull(lease?.expires_at) ?? null, METRIC_SOURCES.lease, lease ? 'measured' : 'not-wired'),
    },
    note: 'the lease row is the only authority for "who is writing right now"',
  };

  // ---- 4. model usage ----------------------------------------------------------------------
  const runs = readRow(db, `SELECT COUNT(*) AS n, COALESCE(SUM(input_tokens), 0) AS tin, COALESCE(SUM(output_tokens), 0) AS tout,
                                          COALESCE(SUM(input_chars), 0) AS tchars
                                   FROM p2_plan_runs WHERE scope = ?`, scope);
  const budget = readRow(db, `SELECT COALESCE(SUM(amount), 0) AS amount, COALESCE(SUM(settled), 0) AS spent
                                    FROM p2_budget_ledger WHERE scope = ?`, scope);
  groups.model = {
    state: planningOn ? 'active' : 'disabled',
    metrics: {
      model_calls: measurable(runs === null || runs === undefined ? null : Number(runs.n ?? 0), METRIC_SOURCES.runs),
      // A build without a provider-token echo has **no value** here, and `0` would read as "this run
      // really used zero tokens" — the exact lie the honest-metric rule forbids. So the value is
      // `null` whenever nothing was reported, and `0` only when a receipt genuinely said zero.
      // A failed query means these are unknown, not zero (round-4 B11).
      tokens_reported: (() => {
        if (runs === null) return metric(null, METRIC_SOURCES.runs, 'measured');
        const total = Number(runs.tin ?? 0) + Number(runs.tout ?? 0);
        return total > 0 ? metric(total, METRIC_SOURCES.runs, 'measured') : metric(null, METRIC_SOURCES.runs, 'not-wired');
      })(),
      tokens_estimated: metric(runs === null ? null : Math.round(Number(runs.tchars ?? 0) / 4), `${METRIC_SOURCES.runs}.input_chars / 4`, 'estimated'),
      budget_remaining: metric(budget === null ? null : Math.max(0, Number(budget.amount ?? 0) - Number(budget.spent ?? 0)), METRIC_SOURCES.ledger),
    },
    note: 'estimated tokens are a chars/4 heuristic and are NOT a bill; reported tokens come from the provider echo when present',
  };

  // ---- 5. memory pipeline (events vs memories) --------------------------------------------
  const events = countOf(db, "SELECT COUNT(*) AS n FROM domain_events WHERE scope = ? AND kind = 'memory/ingest-request'", scope);
  const outboxStatuses = readStatusMap(db, 'SELECT status, COUNT(*) AS n FROM memory_outbox WHERE scope = ? GROUP BY status', scope);
  const outbox = safe(() => {
    const rows = db.all('SELECT status, COUNT(*) AS n FROM memory_outbox WHERE scope = ? GROUP BY status', scope) ?? [];
    const out = {};
    for (const row of rows) out[String(row.status)] = Number(row.n) || 0;
    // B7: distinguish "memory wrote a new row" from "memory answered duplicate". The bridge marks the
    // latter with `last_error='duplicate-hit'`; a query error here is `null`, not 0.
    try {
      const dup = db.get("SELECT COUNT(*) AS n FROM memory_outbox WHERE scope = ? AND status = 'sent' AND last_error = 'duplicate-hit'", scope);
      out.duplicateHits = dup === null || dup === undefined ? null : Number(dup.n) || 0;
    } catch { out.duplicateHits = null; out.unavailable = true; }
    return out;
  }, { sent: null, queued: null, failed: null, duplicateHits: null, unavailable: true });
  groups.memory = {
    state: 'active',
    metrics: {
      events_written: measurable(events, `${METRIC_SOURCES.events} (kind=memory/ingest-request)`),
      // New writes only: what the user would call "a memory was saved".
      written: measurable(outbox.sent === null || outbox.sent === undefined ? null : Number(outbox.sent ?? 0) - Number(outbox.duplicateHits ?? 0), `${METRIC_SOURCES.outbox} (status=sent, not duplicate)`),
      duplicate_hits: measurable(outbox.duplicateHits, `${METRIC_SOURCES.outbox} (last_error=duplicate-hit)`),
      delivered: measurable(outbox.sent, `${METRIC_SOURCES.outbox} (sent, including duplicates)`),
      pending: measurable(countIn(outboxStatuses, 'queued'), METRIC_SOURCES.outbox),
      rejected: measurable(countIn(outboxStatuses, 'failed'), METRIC_SOURCES.outbox),
    },
    note: 'P1 events ≠ memories: memory de-duplicates and routes on significance, so `delivered` is the only count that means "a memory was written"',
  };

  // ---- 6. reminders (H1 delivery is NOT wired) --------------------------------------------
  const occurrences = readStatusMap(db, 'SELECT status, COUNT(*) AS n FROM agenda_occurrences WHERE scope = ? GROUP BY status', scope);
  groups.reminders = {
    // Reminder *delivery* does not exist in this build: the honest answer is `not-wired`, and the
    // delivery numbers are `null` — reporting 0 delivered would look like "nothing was due".
    state: 'not-wired',
    delivery: 'not-wired',
    metrics: {
      reminder_due: measurable(countIn(occurrences, 'due'), METRIC_SOURCES.agenda),
      delivered: metric(null, 'no delivery path in this build', 'not-wired'),
      skipped: measurable(countIn(occurrences, 'skipped'), METRIC_SOURCES.agenda),
      unknown: metric(null, 'no delivery path in this build', 'not-wired'),
      // Which tier published the agenda service, and whether the host could **read it back**. A publish
      // that "succeeded" but cannot be read is exactly the silent degradation this field exposes; a log
      // line alone is not observable by an operator.
      publication: agendaPublication && typeof agendaPublication === 'object'
        ? metric(Number(agendaPublication.verified === true ? 1 : 0),
          `host context (tier=${String(agendaPublication.via ?? 'none')}, read-back=${agendaPublication.verified === true ? 'hit' : 'MISS'})`)
        : metric(null, 'agenda service not published yet', 'not-wired'),
    },
    note: 'H1 reminder delivery is not wired; scheduled/due counts are read from agenda_occurrences, delivery counts are null on purpose',
  };

  // ---- 7. share candidates ----------------------------------------------------------------
  const shareRows = (() => {
    try { return db.all('SELECT status, COUNT(*) AS n FROM p2_share_candidates WHERE scope = ? GROUP BY status', scope) ?? []; } catch { return null; }
  })();
  const share = {};   // filled from the rows above; a failed read leaves it empty and the metrics null
  for (const row of shareRows ?? []) share[String(row.status)] = Number(row.n) || 0;
  // task-42: a retryable gate leaves a retry-book row; a terminal one does not. Counting the book
  // (rather than guessing from reason strings) keeps the two numbers honest even for old rows.
  const shareRetryable = (() => {
    try {
    const rows = db.all(`SELECT m.scope AS scope FROM runtime_meta k
                         JOIN p2_share_candidates m ON k.meta_key = 'p2_share_retry:' || m.candidate_id
                         WHERE m.scope = ? AND m.status = 'gated'`, scope) ?? [];
    return rows.length;
    } catch { return null; }
  })();
  groups.share = {
    state: 'active',
    metrics: {
      share_candidates: metric(shareRows === null ? null : shareRows.reduce((sum, row) => sum + (Number(row.n) || 0), 0), METRIC_SOURCES.share),
      // P2.5-3B split the old `gated` blob into what the consumer actually produces:
      //   `queued` = handed to the contact owner and stored in **its** queue (not sent);
      //   `gated`  = refused by the switch or by the contact's gate, with a reason code on the row.
      queued: shareRows === null ? metric(null, METRIC_SOURCES.share, 'unavailable')
        : measurable(Number(share.queued ?? 0), METRIC_SOURCES.share),
      // task-42: "wait a while" and "never" are different facts, so they are different numbers.
      // A retryable gate keeps the candidate (there is a retry book row for it); a terminal one does
      // not, which is exactly how the two are counted here.
      gated_retryable: measurable(shareRetryable, `${METRIC_SOURCES.share} + runtime_meta p2_share_retry:*`),
      gated_terminal: metric(shareRows === null ? null : Number(share.gated ?? 0) - shareRetryable + Number(share.withdrawn ?? 0) + Number(share.rejected ?? 0), METRIC_SOURCES.share),
      gated: shareRows === null ? metric(null, METRIC_SOURCES.share, 'unavailable')
        : measurable(Number(share.gated ?? 0) + Number(share.withdrawn ?? 0) + Number(share.rejected ?? 0), METRIC_SOURCES.share),
      pending: shareRows === null ? metric(null, METRIC_SOURCES.share, 'unavailable')
        : measurable(Number(share.pending ?? 0), METRIC_SOURCES.share),
      // B7: a candidate that ran out of attempts is a different fact from one still waiting.
      expired: shareRows === null ? metric(null, `${METRIC_SOURCES.share} (status=expired)`, 'unavailable')
        : measurable(Number(share.expired ?? 0), `${METRIC_SOURCES.share} (status=expired)`),
      // Nothing in this build can observe a real send, so the honest answer stays `null` — never 0.
      sent: metric(null, 'contact side (QQ) is not visible from the runtime database', 'not-wired'),
    },
    note: 'gate reasons are stored as decision_reason codes on the candidate row; the contact side keeps its own send log',
  };

  // ---- 8. recovery ------------------------------------------------------------------------
  const retries = countOf(db, 'SELECT COALESCE(SUM(attempts), 0) AS n FROM memory_outbox WHERE scope = ?', scope);
  // `safe(…, 0)` made a failed query indistinguishable from "no recoveries"; `null` keeps them apart.
  const recovered = (() => {
    try {
      const row = db.get(`SELECT COUNT(*) AS n FROM p2_activity_receipts
                       WHERE scope = ? AND code = 'lc-effect' AND json_extract(detail, '$.phase') = 'not_applied'`, scope);
      return row === null || row === undefined ? 0 : Number(row.n ?? 0);
    } catch { return null; }
  })();
  // round-5 review: the re-audit buckets and the deferred streak only existed in a return value, so an
  // operator could not see "how many marks are stuck" or "compensation has stopped for five passes".
  const reauditState = (() => {
    const row = readRow(db, 'SELECT meta_value FROM runtime_meta WHERE meta_key = ?', `p2_p1_reaudit_state:${scope}`);
    if (row === null || row === undefined) return null;
    if (typeof row.meta_value !== 'string' || !row.meta_value) return null;
    try { return JSON.parse(row.meta_value); } catch { return null; }
  })();
  const deferredStreak = (() => {
    const row = readRow(db, 'SELECT meta_value FROM runtime_meta WHERE meta_key = ?', `p2_p1_deferred_streak:${scope}`);
    if (row === null || row === undefined) return null;
    if (typeof row.meta_value !== 'string' || !row.meta_value) return null;
    const value = Number(row.meta_value);
    return Number.isFinite(value) ? value : null;
  })();
  groups.recovery = {
    state: activitiesOn ? 'active' : 'disabled',
    metrics: {
      retries: measurable(retries, METRIC_SOURCES.outbox),
      recovery_count: measurable(recovered, METRIC_SOURCES.receipts),
      overdue_count: measurable(countOf(db, 'SELECT COUNT(*) AS n FROM p2_plan_slots WHERE scope = ? AND status = ? AND end_at < ?', scope, 'planned', Number(now) || 0), METRIC_SOURCES.slots, 'estimated'),
      // Stuck marks and stalled compensation are operational facts, so they are counted here too.
      reconcile_foreign: reauditState === null ? metric(null, METRIC_SOURCES.reconcile, 'unavailable')
        : measurable(Number(reauditState.foreign ?? 0), METRIC_SOURCES.reconcile),
      reconcile_unowned: reauditState === null ? metric(null, METRIC_SOURCES.reconcile, 'unavailable')
        : measurable(Number(reauditState.unowned ?? 0), METRIC_SOURCES.reconcile),
      compensation_deferred_streak: deferredStreak === null ? metric(null, METRIC_SOURCES.reconcile, 'unavailable')
        : measurable(deferredStreak, METRIC_SOURCES.reconcile),
    },
    note: 'recovery_count counts effects explicitly resolved as "did not happen"; a resolution is never inferred',
  };

  return {
    projection: true,
    authority: 'lib/p2.mjs status()',
    generatedAt: Number(now) || 0,
    scopeKey: scope || null,
    groups,
  };
}
