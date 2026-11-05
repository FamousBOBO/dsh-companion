// P2.5 dispatch observability — the read-only answer to two operator questions:
//
//   1. "what is the dispatch loop doing right now?"  → `dispatchMetrics()`
//   2. "what *would* the next heartbeat beat do?"    → `dispatchWatch()`
//
// Why this module exists (and why it is not folded into `p2.status()`):
//
//   * Three callers need exactly the same numbers — `p2.status()` (operator diagnostics),
//     `lib/observability.mjs` (the eight-group projection from plan §4C) and the host's
//     `p2DispatchWatch()` (the pre-enable dry watch). Computing the same metric in three places is
//     precisely how `claim_age_ms` came to measure the wrong thing: it was
//     `now - MAX(occurred_at)` of an `autonomy/plan-slot` event, and `occurredAt` for a claim is
//     the slot's **scheduled** start (`p2.mjs` `claimSlotForHeartbeat`), not the moment the claim
//     was written. That number could only ever say "time since the newest slot was scheduled".
//   * `heartbeat` must not query P2 tables (§13.2: the heartbeat owns no P2 knowledge), so the
//     measurement belongs neither in `heartbeat.mjs` nor in the heartbeat's status.
//
// ## Honesty contract (four labels, same vocabulary as `lib/observability.mjs`)
//
//   * `measured`     — an exact SELECT at the caller's `now`.
//   * `estimated`    — derived from a **bounded** read (the effect ledger sample).
//   * `not-wired`    — the data genuinely does not exist yet (e.g. a claim written before
//                      `recorded_at` was recorded for claims). The value is then `null`.
//   * `unavailable`  — the query threw. The value is then `null`, **never** `0`.
//
// A `0` always means "we looked and found nothing". "We could not look" is `null` +
// `available:false`. This is the rule that `slots_due` broke by counting every open slot ever
// (`status IN ('planned','started')`), i.e. the all-time backlog, under a name that promises
// "due now".
//
// ## Zero writes
//
// Every statement in this file is a SELECT. There is no `INSERT`/`UPDATE`/`DELETE`, no
// `metaSet`, and deliberately no `budget.sweep()` (which `p2.status()` does call, so
// `p2Status()` is **not** a zero-write call; `p2DispatchWatch()` is).
// `test/p2.5-dispatch-observability.test.mjs` proves it by snapshotting every table this loop can
// touch before/after, including `heartbeat_cursor` churn.
//
// ## Field names
//
// The metric names are snake_case (`slots_due`, `dispatch_lag_ms`, `claim_age_ms`) because those
// are the names frozen in the plan (§4C) and quoted by CONTRACT §13.4 row 5. Renaming them to
// camelCase would break the only thing that makes the contract checkable — the identifier itself.

import { effectIndex, effectBlock, jobKeyFor } from './activities.mjs?v=reading-20261101-v1';

const CLAIM_EVENT_KIND = 'autonomy/plan-slot';

// ---------------------------------------------------------------------------
// small safe wrappers: a throwing query is never a zero
// ---------------------------------------------------------------------------

function tryAll(db, sql, ...params) {
  try {
    const rows = db.all(sql, ...params);
    return { ok: true, rows: Array.isArray(rows) ? rows : [] };
  } catch (error) {
    return { ok: false, rows: [], error };
  }
}

function tryGet(db, sql, ...params) {
  try {
    const row = db.get(sql, ...params);
    return { ok: true, row: row ?? null };
  } catch (error) {
    return { ok: false, row: null, error };
  }
}

const asCount = value => (value === null || value === undefined ? 0 : Number(value) || 0);
const optionalMs = value => (value === null || value === undefined ? null : Number(value) || 0);

function normalizeSlot(row) {
  return {
    slotId: String(row?.slot_id ?? ''),
    planId: String(row?.plan_id ?? ''),
    day: String(row?.day ?? ''),
    activity: String(row?.activity ?? ''),
    reality: String(row?.reality ?? ''),
    targetRef: String(row?.target_ref ?? ''),
    status: String(row?.status ?? ''),
    locked: Number(row?.locked ?? 0) === 1,
    startAt: Number(row?.start_at) || 0,
    endAt: Number(row?.end_at) || 0,
  };
}

// The predicate below is the **same** one `p2.mjs` `dueSlotsForHeartbeat()` uses, on purpose: a
// dry watch that can promise a claim the real beat would refuse is worse than no watch at all.
// The two copies are kept honest by a test (the watch must predict the very next real claim), not
// by a shared helper — `dueSlotsForHeartbeat` sits inside the heartbeat's transaction and must stay
// free of any extra call.
const DUE_SQL = `
  SELECT s.slot_id, s.plan_id, s.day, s.start_at, s.end_at, s.activity, s.reality,
         s.target_ref, s.locked, s.status
    FROM p2_plan_slots s
    JOIN p2_plans p ON p.plan_id = s.plan_id AND p.scope = s.scope
   WHERE s.scope = ? AND s.status = 'planned' AND s.kind = 'activity'
     AND s.start_at <= ? AND s.end_at > ?
     AND p.status = 'committed'
     AND NOT EXISTS (SELECT 1 FROM p2_activities a WHERE a.scope = s.scope AND a.plan_slot_id = s.slot_id)
   ORDER BY s.start_at ASC, s.slot_id ASC
   LIMIT ?`;

// A slot the heartbeat already claimed (`planned → started`) that the pump has not turned into an
// activity yet. This is the only window in which a `claim` exists without an execution, which is
// exactly what `claim_age_ms` is about.
const CLAIMED_SQL = `
  SELECT s.slot_id, s.plan_id, s.day, s.start_at, s.end_at, s.activity, s.reality,
         s.target_ref, s.locked, s.status
    FROM p2_plan_slots s
    JOIN p2_plans p ON p.plan_id = s.plan_id AND p.scope = s.scope
   WHERE s.scope = ? AND s.status = 'started' AND s.kind = 'activity'
     AND p.status = 'committed'
     AND NOT EXISTS (SELECT 1 FROM p2_activities a WHERE a.scope = s.scope AND a.plan_slot_id = s.slot_id)
   ORDER BY s.start_at ASC, s.slot_id ASC
   LIMIT ?`;

// Slots whose window already closed while still `planned`: the pump files them as `missed` on its
// next pass, so the watch must show them as "will miss", never as "claimable".
const WILL_MISS_SQL = `
  SELECT s.slot_id, s.plan_id, s.day, s.start_at, s.end_at, s.activity, s.reality,
         s.target_ref, s.locked, s.status
    FROM p2_plan_slots s
    JOIN p2_plans p ON p.plan_id = s.plan_id AND p.scope = s.scope
   WHERE s.scope = ? AND s.status IN ('planned','started') AND s.kind = 'activity'
     AND s.end_at <= ?
     AND p.status = 'committed'
     AND NOT EXISTS (SELECT 1 FROM p2_activities a WHERE a.scope = s.scope AND a.plan_slot_id = s.slot_id)
   ORDER BY s.end_at ASC LIMIT ?`;

// Counts that must be **exact**: the row lists below are capped so memory stays bounded, but a
// capped list reported as `slots_due` would silently under-count a backlog — the same class of lie
// as reporting 0 for a failed query. Same predicate, no LIMIT.
const DUE_COUNT_SQL = `
  SELECT COUNT(*) AS n
    FROM p2_plan_slots s
    JOIN p2_plans p ON p.plan_id = s.plan_id AND p.scope = s.scope
   WHERE s.scope = ? AND s.status = 'planned' AND s.kind = 'activity'
     AND s.start_at <= ? AND s.end_at > ?
     AND p.status = 'committed'
     AND NOT EXISTS (SELECT 1 FROM p2_activities a WHERE a.scope = s.scope AND a.plan_slot_id = s.slot_id)`;

const CLAIMED_COUNT_SQL = `
  SELECT COUNT(*) AS n
    FROM p2_plan_slots s
    JOIN p2_plans p ON p.plan_id = s.plan_id AND p.scope = s.scope
   WHERE s.scope = ? AND s.status = 'started' AND s.kind = 'activity'
     AND p.status = 'committed'
     AND NOT EXISTS (SELECT 1 FROM p2_activities a WHERE a.scope = s.scope AND a.plan_slot_id = s.slot_id)`;

/** Slots that are due right now, by the heartbeat's own predicate. */
export function dueSlotRows(db, { scopeKey, now = Date.now(), limit = 20 } = {}) {
  const scope = String(scopeKey ?? '').trim();
  if (!scope) return { ok: false, code: 'no-scope', rows: [] };
  const cap = Math.max(1, Math.min(200, Math.trunc(Number(limit) || 20)));
  const at = Number(now) || 0;
  const result = tryAll(db, DUE_SQL, scope, at, at, cap);
  if (!result.ok) return { ok: false, code: 'due-query-failed', rows: [] };
  return { ok: true, rows: result.rows.map(normalizeSlot).filter(slot => slot.slotId !== '') };
}

/** The unresolved-effect verdict per job, i.e. exactly the filter `dueSlotsForHeartbeat` applies. */
export function effectBlocksByJob(db, { scopeKey, now = Date.now() } = {}) {
  const scope = String(scopeKey ?? '').trim();
  if (!scope) return { ok: false, code: 'no-scope', blocked: new Map(), unknown: null, prepared: null };
  const at = Number(now) || 0;
  try {
    const { byJob } = effectIndex(db, { scopeKey: scope });
    const blocked = new Map();
    let unknown = 0;
    let prepared = 0;
    for (const [jobKey, record] of byJob.entries()) {
      const phase = String(record?.phase ?? '');
      if (phase === 'unknown') unknown += 1;
      if (phase === 'prepared') prepared += 1;
      // `now` matters: a `prepared` intent is "in flight" before its deadline and "unknown" after
      // it (`effectBlock`, activities.mjs:395-400). Passing 0 would label every live preparation
      // as an expired one — a different fact, and the one that means "a human must decide".
      const verdict = effectBlock({ record, now: at });
      if (verdict?.blocked) blocked.set(jobKey, { code: String(verdict.code ?? ''), reason: String(verdict.reason ?? '') });
    }
    return { ok: true, blocked, unknown, prepared };
  } catch (error) {
    return { ok: false, code: 'effect-index-failed', blocked: new Map(), unknown: null, prepared: null, error };
  }
}

/**
 * The claim recorded for one slot, with its **wall clock**.
 *
 * `domain_events.recorded_at` is the only durable wall clock a claim has. It used to be a copy of
 * `occurred_at` (= the slot's scheduled start) for every event, which made `recorded_at - occurred_at`
 * identically 0 for claims — the exact formula `design/p2.5-baseline-and-contract.md` §4 row 2
 * proposed for latency. `claimSlotForHeartbeat` now passes `recordedAt: clock()`, so claims written
 * from 2026-11-03 on carry a real one. A claim whose two timestamps are equal is a **legacy** claim
 * and is reported as `not-recorded` instead of being turned into a confident (wrong) age.
 */
function claimOfSlot(db, { scopeKey, slotId } = {}) {
  const scope = String(scopeKey ?? '').trim();
  const slot = String(slotId ?? '');
  if (!scope || !slot) return { ok: false, code: 'invalid-input' };
  const result = tryAll(db,
    `SELECT recorded_at, occurred_at FROM domain_events
      WHERE scope = ? AND kind = ?
        AND json_extract(payload, '$.to') = 'started'
        AND json_extract(payload, '$.slotId') = ?
      ORDER BY seq DESC LIMIT 1`,
    scope, CLAIM_EVENT_KIND, slot);
  if (!result.ok) return { ok: false, code: 'claim-query-failed' };
  const row = result.rows[0] ?? null;
  if (!row) return { ok: true, recordedAt: null, occurredAt: null, source: 'none' };
  const recordedAt = optionalMs(row.recorded_at);
  const occurredAt = optionalMs(row.occurred_at);
  // Legacy: recorded_at is still the verbatim copy of occurred_at ⇒ no wall clock was stored.
  const legacy = recordedAt !== null && occurredAt !== null && recordedAt === occurredAt;
  return { ok: true, recordedAt: legacy ? null : recordedAt, occurredAt, source: legacy ? 'not-recorded' : 'recorded_at' };
}

/** Slots already claimed by the heartbeat but not yet materialised by the pump. */
export function claimedAwaitingStart(db, { scopeKey, now = Date.now(), limit = 20 } = {}) {
  const scope = String(scopeKey ?? '').trim();
  if (!scope) return { ok: false, code: 'no-scope', rows: [] };
  const cap = Math.max(1, Math.min(200, Math.trunc(Number(limit) || 20)));
  const at = Number(now) || 0;
  const result = tryAll(db, CLAIMED_SQL, scope, cap);
  if (!result.ok) return { ok: false, code: 'claimed-query-failed', rows: [] };
  const rows = [];
  for (const slot of result.rows.map(normalizeSlot).filter(entry => entry.slotId !== '')) {
    const claim = claimOfSlot(db, { scopeKey: scope, slotId: slot.slotId });
    rows.push({
      ...slot,
      claimedAtMs: claim.ok ? claim.recordedAt : null,
      claimAgeMs: claim.ok && claim.recordedAt !== null ? Math.max(0, at - claim.recordedAt) : null,
      claimAgeSource: claim.ok ? claim.source : 'unavailable',
    });
  }
  return { ok: true, rows };
}

/**
 * The aggregate. `available:false` (with every measurement `null`) when the scope is unknown or a
 * query failed — never a partly-zero "healthy" object.
 */
export function dispatchMetrics(db, { scopeKey, now = Date.now(), effectLimit = 200 } = {}) {
  const scope = String(scopeKey ?? '').trim();
  const at = Number(now) || 0;
  const blank = {
    available: false,
    at,
    scopeKey: scope || null,
    source: 'p2_plan_slots + p2_plans + p2_activities + p2_activity_receipts + domain_events',
    slots_due: null,
    slots_claimable: null,
    slots_effect_blocked: null,
    slots_open: null,
    claimed_awaiting_start: null,
    dispatch_lag_ms: null,
    claim_age_ms: null,
    claim_age_source: 'unavailable',
    claim_oldest_recorded_at: null,
    activities_pending: null,
    activities_running: null,
    effects_unknown: null,
    effects_prepared: null,
    effectIndexAvailable: null,
    truncated: null,
    dispatch_enabled: null,
    activities_enabled: null,
    paused: null,
  };
  if (!scope) return { ...blank, code: 'no-scope' };

  const due = dueSlotRows(db, { scopeKey: scope, now: at, limit: 200 });
  if (!due.ok) return { ...blank, code: due.code };
  const dueCount = tryGet(db, DUE_COUNT_SQL, scope, at, at);
  if (!dueCount.ok) return { ...blank, code: 'due-count-failed' };

  const open = tryGet(db, "SELECT COUNT(*) AS n FROM p2_plan_slots WHERE scope = ? AND status IN ('planned','started')", scope);
  if (!open.ok) return { ...blank, code: 'count-query-failed' };

  const effects = effectBlocksByJob(db, { scopeKey: scope, now: at });
  const blockedJobKeys = new Set(effects.blocked.keys());
  const blockedDue = due.rows.filter(slot => blockedJobKeys.has(jobKeyFor({
    scopeKey: scope, startAt: slot.startAt, endAt: slot.endAt, kind: slot.activity,
  })));

  const claimed = claimedAwaitingStart(db, { scopeKey: scope, now: at, limit: 200 });
  if (!claimed.ok) return { ...blank, code: claimed.code };
  const claimedCount = tryGet(db, CLAIMED_COUNT_SQL, scope);
  if (!claimedCount.ok) return { ...blank, code: 'claimed-count-failed' };

  // `claim_age_ms`: the age of the OLDEST claim that never became an activity — the number that
  // answers "how long has a claim been stuck waiting for the pump?".
  let oldestClaim = null;
  for (const row of claimed.rows) {
    if (row.claimedAtMs === null) continue;
    if (oldestClaim === null || row.claimedAtMs < oldestClaim) oldestClaim = row.claimedAtMs;
  }
  // One source label for the whole measure: if any claim in the set is legacy the aggregate age is
  // a lower bound over a subset, so say so instead of quietly reporting the newest one.
  const claimAgeSource = claimed.rows.length === 0
    ? 'none'
    : (claimed.rows.every(row => row.claimAgeSource === 'recorded_at') ? 'recorded_at'
      : claimed.rows.some(row => row.claimAgeSource === 'unavailable') ? 'unavailable' : 'not-recorded');

  const activityCounts = tryGet(db,
    `SELECT
       SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running
     FROM p2_activities WHERE scope = ?`, scope);
  if (!activityCounts.ok) return { ...blank, code: 'activity-count-failed' };

  // The per-slot verdict needs a row per due slot, so it is computed over a capped list. When the
  // cap is hit the derived numbers are reported as `null` + `truncated:true` instead of a silently
  // short count — `slots_due` itself stays exact because it comes from its own COUNT.
  const truncated = due.rows.length >= 200;
  const claimableCount = due.rows.length - blockedDue.length;
  // A failed effect-ledger read is **not** "no blocked jobs": we cannot tell which due slots are
  // blocked, so `slots_claimable`/`slots_effect_blocked` are `null` (unknown) while `slots_due` —
  // which does not need the ledger — stays measured. Reporting 0 blocked would send an operator
  // into a dispatch loop that then refuses every slot.
  const effectKnown = effects.ok === true;
  const derivedKnown = effectKnown && !truncated;
  return {
    available: true,
    at,
    scopeKey: scope,
    source: blank.source,
    slots_due: asCount(dueCount.row?.n),
    slots_claimable: derivedKnown ? claimableCount : null,
    slots_effect_blocked: derivedKnown ? blockedDue.length : null,
    slots_open: asCount(open.row?.n),
    claimed_awaiting_start: asCount(claimedCount.row?.n),
    // How late the oldest still-due slot already is, for the caller's `now`. `null` when nothing is
    // due — an idle loop has no latency, and 0 would read as "perfectly on time".
    dispatch_lag_ms: due.rows.length === 0 ? null : Math.max(0, at - Math.min(...due.rows.map(slot => slot.startAt))),
    claim_age_ms: oldestClaim === null ? null : Math.max(0, at - oldestClaim),
    claim_age_source: claimAgeSource,
    claim_oldest_recorded_at: oldestClaim,
    activities_pending: asCount(activityCounts.row?.pending),
    activities_running: asCount(activityCounts.row?.running),
    effects_unknown: effectKnown ? effects.unknown : null,
    effects_prepared: effectKnown ? effects.prepared : null,
    effectIndexAvailable: effectKnown,
    // `true` ⇒ more than 200 slots are in one of the sampled sets, so the per-slot-derived numbers
    // above are `null` rather than a lower bound (see the honesty contract in the module header).
    truncated,
    dispatch_enabled: null,   // filled by the caller that owns the config (`p2.status()`)
    activities_enabled: null,
    paused: null,
  };
}

/**
 * The dry watch: every slot the next beat could touch, why it could not, and which beat would take
 * it. Pure read — see the module header.
 *
 * `maxPerBeat` is the heartbeat's `maxDispatchPerCycle`: a beat claims at most that many slots, so
 * the N-th claimable slot is only guaranteed to be reachable on beat `floor(N / maxPerBeat) + 1`.
 */
export function dispatchWatch(db, {
  scopeKey, now = Date.now(), maxPerBeat = 1, intervalMs = 60000, jitterMs = 2500, limit = 20,
} = {}) {
  const scope = String(scopeKey ?? '').trim();
  const at = Number(now) || 0;
  const perBeat = Math.max(1, Math.min(20, Math.trunc(Number(maxPerBeat) || 1)));
  const base = { readOnly: true, at, scopeKey: scope || null, rows: [], counts: null, nextBeatWithinMs: null };
  if (!scope) return { ...base, ok: false, code: 'no-scope' };

  const due = dueSlotRows(db, { scopeKey: scope, now: at, limit });
  if (!due.ok) return { ...base, ok: false, code: due.code };
  const claimed = claimedAwaitingStart(db, { scopeKey: scope, now: at, limit });
  if (!claimed.ok) return { ...base, ok: false, code: claimed.code };
  const effects = effectBlocksByJob(db, { scopeKey: scope, now: at });
  const missResult = tryAll(db, WILL_MISS_SQL, scope, at, Math.max(1, Math.min(50, Math.trunc(Number(limit) || 20))));

  // One row per slot, keyed by slotId: a claimed slot whose window has since closed is *both*
  // "awaiting the pump" and "about to be filed as missed", and reporting it twice would inflate
  // every count below. The later verdict (`will-miss`) wins the state, the claim fields survive.
  const bySlot = new Map();
  const put = row => {
    const prior = bySlot.get(row.slotId);
    bySlot.set(row.slotId, prior ? { ...prior, ...row, claimedAtMs: prior.claimedAtMs ?? row.claimedAtMs, claimAgeMs: prior.claimAgeMs ?? row.claimAgeMs, claimAgeSource: prior.claimAgeSource !== 'none' ? prior.claimAgeSource : row.claimAgeSource } : row);
  };
  let beatIndex = 0;
  for (const slot of due.rows) {
    const jobKey = jobKeyFor({ scopeKey: scope, startAt: slot.startAt, endAt: slot.endAt, kind: slot.activity });
    const verdict = effects.blocked.get(jobKey) ?? null;
    if (verdict) {
      put({
        ...slot,
        state: 'blocked-effect',
        blockReason: verdict.code || 'effect-unresolved',
        blockDetail: verdict.reason || '',
        dueSinceMs: Math.max(0, at - slot.startAt),
        expectedBeat: null,
        claimedAtMs: null,
        claimAgeMs: null,
        claimAgeSource: 'none',
      });
      continue;
    }
    beatIndex += 1;
    put({
      ...slot,
      state: 'claimable',
      blockReason: null,
      blockDetail: '',
      dueSinceMs: Math.max(0, at - slot.startAt),
      expectedBeat: Math.floor((beatIndex - 1) / perBeat) + 1,
      claimedAtMs: null,
      claimAgeMs: null,
      claimAgeSource: 'none',
    });
  }
  for (const slot of claimed.rows) {
    put({
      ...slot,
      state: 'awaiting-start',
      blockReason: null,
      blockDetail: 'claimed by the heartbeat; waiting for the pump to create the activity',
      dueSinceMs: Math.max(0, at - slot.startAt),
      expectedBeat: null,
      claimedAtMs: slot.claimedAtMs,
      claimAgeMs: slot.claimAgeMs,
      claimAgeSource: slot.claimAgeSource,
    });
  }
  if (missResult.ok) {
    for (const slot of missResult.rows.map(normalizeSlot)) {
      put({
        ...slot,
        state: 'will-miss',
        blockReason: 'window-closed',
        blockDetail: 'the slot window closed without an activity; the pump files it as missed',
        dueSinceMs: null,
        expectedBeat: null,
        claimedAtMs: null,
        claimAgeMs: null,
        claimAgeSource: 'none',
      });
    }
  }
  const rows = [...bySlot.values()];

  const claimable = rows.filter(row => row.state === 'claimable');
  const oldestDue = claimable.length ? Math.min(...claimable.map(row => row.startAt)) : null;
  return {
    ...base,
    ok: true,
    effectIndexAvailable: effects.ok,
    rows,
    counts: {
      due: due.rows.length,
      claimable: claimable.length,
      effectBlocked: rows.filter(row => row.state === 'blocked-effect').length,
      awaitingStart: rows.filter(row => row.state === 'awaiting-start').length,
      willMiss: rows.filter(row => row.state === 'will-miss').length,
      beatsToDrain: claimable.length === 0 ? 0 : Math.ceil(claimable.length / perBeat),
    },
    maxPerBeat: perBeat,
    dispatch_lag_ms: oldestDue === null ? null : Math.max(0, at - oldestDue),
    // A projection, not a promise: the heartbeat's timer is `pollIntervalMs ± jitterMs`.
    nextBeatWithinMs: Math.max(1000, Math.trunc(Number(intervalMs) || 60000)) + Math.max(0, Math.trunc(Number(jitterMs) || 0)),
  };
}
