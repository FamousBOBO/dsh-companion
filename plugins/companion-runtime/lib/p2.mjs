// P2 subsystem wiring (contract logs/p2-autonomous-day/contract-p2.md).
//
// This module is the only place where the P2 pieces meet: it owns the autonomy consumer
// (one handler that fans out to the planner and the activities reducers), the model port,
// the shared budget, the capability catalogue and the background tick. The runtime
// (`index.mjs`) only injects its writer gate, scope helpers and ports, so nothing here can
// bypass the lease, the event path or the existing P1/H1/H2 ownership.

import crypto from 'node:crypto';
import { RuntimeError } from './errors.mjs';
import { digest, scopeKey as scopeKeyOf } from './scope.mjs';
import { createBudget } from './budget.mjs';
import { detectCapabilities, describeCapabilities } from './capabilities.mjs';
import { createPlanner, applyPlanEvent } from './planner.mjs?v=reading-20261101-v1';
import { createActivities, applyActivityEvent, missedReceiptEvent, effectIndex, effectBlock, jobKeyFor } from './activities.mjs?v=reading-20261101-v1';
import { dispatchMetrics as measureDispatch, dispatchWatch as watchDispatch } from './dispatch-observability.mjs';
import { retryBackoffMs } from './bridge.mjs';
import { startRetryGate, recordStartFailure } from './start-retry.mjs';

export function canAutoResumeActivity(rawCheckpoint) {
  try {
    const checkpoint = JSON.parse(rawCheckpoint || '{}');
    return checkpoint?.needsReview !== true && checkpoint?.reason === 'window-closed';
  } catch { return false; }
}

const PLANNER_KINDS = new Set(['autonomy/plan-committed', 'autonomy/plan-slot', 'autonomy/opportunity', 'autonomy/interest']);
const ACTIVITY_KINDS = new Set(['autonomy/activity', 'autonomy/receipt']);

// Canonical autopilot tick: cheap, bounded, and it never calls a model on its own — the
// planner decides that and the budget can refuse it.
const PLANNER_TICK_MS = 60000;
// round-5: how many consecutive deferred passes (fact query unusable) before compensation is reported
// as stalled. Five ticks is long enough to ride out a transient lock and short enough to be noticed.
const DEFERRED_STREAK_ALERT = 5;
// P2.5-B2: the source failures that can never be retried from the recorded offset. `segment()`
// proves this one by re-hashing the source (`source-changed`), so the only honest continuation is a
// review park. `source-invalid` is deliberately **not** here: it also covers transient I/O
// (a file locked by another writer, a momentarily unreadable path), and parking those would turn a
// hiccup into an operator task. Those keep the pre-existing bounded retry and end as a
// `window-closed` pause, which is bounded by the slot's own `end_at`.
const PARKABLE_SOURCE_CODES = new Set(['source-changed']);

/**
 * Build the P2 subsystem.
 *
 * @param db            open runtime DB
 * @param config        runtime config (already sanitised)
 * @param clock         injected wall clock
 * @param owner/generation  writer identity
 * @param getMode       () => 'off'|'shadow'|'active'
 * @param isActive      () => boolean (mounted, active, not stopped/disposed)
 * @param emit          (event) => {ok, seq} — the runtime's checked dispatcher for autonomy events
 * @param agendaFixed   ({ scopeKey, from, to }) => [{startAt,endAt,title,authorization}]
 * @param shadow        (kind, payload) => void — record a shadow proposal instead of committing
 * @param materials     ({ scopeKey, day, now }) => planning material object (bounded by the planner)
 * @param ports         injected IO ports: { fetchPage, readFile, writeFile }
 * @param memoryPort    { recordExperience(experience) => {ok, receiptId} } | null
 * @param options       { artifactRoot, onError }
 */
export function createP2({
  db, config, clock = () => Date.now(), owner, generation,
  getMode = () => 'active', isActive = () => true, emit, emitActivity = null, agendaFixed = () => [],
  shadow = () => {}, materials = () => ({}), ports = {}, memoryPort = null, options = {},
}) {
  const noteError = typeof options.onError === 'function' ? options.onError : () => {};
  const timeZone = config.timeZone || 'Asia/Shanghai';
  const artifactRoot = options.artifactRoot || config.p2?.activities?.artifactRoot || 'workspace/companion-works';
  const ownerOf = input => (input?.scope ? input.scope : input?.scopeKey ? null : null);
  // P2.5-1: the heartbeat's claim route. It is a separate *name* for the same checked dispatcher
  // (the runtime adds an activities-switch guard), so a claim and a pump start can never reach
  // the log through two different write paths.
  const dispatchClaim = typeof emitActivity === 'function' ? emitActivity : emit;
  // Codex pre-release review R3: exactly **one** experience write path per finished activity.
  //
  // When the runtime injects the P1 hook (`options.onFinished` → one `memory/ingest-request`,
  // namespace `p2/activity`), the legacy `memoryPort` write (namespace `p2/experience`) is turned
  // off entirely. The two produce different idempotency keys and memory cannot merge them, so
  // keeping both would silently write two experiences for one activity.
  const p1Hook = typeof options.onFinished === 'function' ? options.onFinished : null;
  // The one-time boundary is written **now**, before any activity can finish under the new scheme;
  // if it were seeded lazily on the first compensation, rows that finished in between would be
  // silently treated as pre-scheme and never backfilled (round-2 §二.4b).
  if (p1Hook) { try { p1Epoch(); } catch (error) { noteError('p2-p1-epoch-seed-failed', error?.message ?? String(error)); } }
  // P2.5-2 (A4 §1.4 E1-d): the "this never started" fact. Separate name from the finish hook
  // because its input has no activity row — a missed slot is a plan outcome, not an activity.
  const onMissed = typeof options.onMissed === 'function' ? options.onMissed : null;
  // Outbox drainer (see the review note in the runtime): the `memory/ingest-request` rows only
  // become memories when somebody drains `memory_outbox`. Nothing did, periodically, before this
  // change — the pump tick is the existing background async slot, so it drains there.
  const drainOutboxHook = typeof options.drainOutbox === 'function' ? options.drainOutbox : null;
  if (typeof options.p1Hook === 'function' || p1Hook) {
    try { p1Epoch(); } catch (error) { noteError('p2-p1-epoch-seed-failed', error?.message ?? String(error)); }
  }

  const budget = createBudget({
    db, config, clock, timeZone, owner, generation,
    // A real foreground turn beats all background work: the plugin supplies the signal from the
    // host's own agent state, and getMode() alone cannot see a chat turn in progress.
    //
    // R4: an unreadable signal yields (fail-closed) instead of throwing into the budget code.
    shouldYield: () => {
      if (getMode() !== 'active') return true;
      if (typeof options.isForegroundBusy !== 'function') return false;
      try { return options.isForegroundBusy() === true; } catch { return true; }
    },
  });

  // ---- autonomy consumer: one handler, two reducers -------------------------------------
  function autonomyHandler({ db: handlerDb, event, slice, now }) {
    if (PLANNER_KINDS.has(event.kind)) return applyPlanEvent({ db: handlerDb, event, slice, now });
    if (ACTIVITY_KINDS.has(event.kind)) return applyActivityEvent({ db: handlerDb, event, slice, now });
    throw new RuntimeError('invalid-payload', `unknown autonomy event kind: ${event.kind}`);
  }
  const handlers = { autonomy: autonomyHandler };

  // ---- model port ----------------------------------------------------------------------
  function callModel({ purpose = 'p2-planning', system = '', input = '', maxTokens = 2048, signal, sessionId } = {}) {
    const port = options.callModel;
    if (typeof port !== 'function') throw new RuntimeError('model-unavailable', 'no P2 model port was injected');
    return port({ purpose, system, input, maxTokens, signal, sessionId });
  }

  function capabilitiesFor(scope) {
    return detectCapabilities({ ports, config, mode: getMode(), kinds: options.capabilityKinds?.(scope) ?? {} });
  }

  // ---- controllers ---------------------------------------------------------------------
  const planner = createPlanner({
    db, config, clock, owner, generation,
    dispatch: emit,
    callModel,
    budget,
    materials: input => materials(input),
    pause: {
      isPaused: () => config.p2?.planning?.paused === true || db.metaGet?.('p2_planning_paused', '0') === '1',
      mode: getMode(),
      shadows: shadow,
    },
    onError: (code, detail) => noteError(`p2-plan-${code}`, detail),
  });

  const workspaceRoot = options.resolveArtifactRoot ? options.resolveArtifactRoot(artifactRoot) : artifactRoot;
  const activities = createActivities({
    db, config, clock, owner, generation,
    dispatch: emit,
    ports,
    workspace: workspaceRoot,
    pause: {
      isPaused: () => config.p2?.activities?.paused === true || db.metaGet?.('p2_activities_paused', '0') === '1',
      mode: getMode(),
    },
    // P2.5-1 jump 2: the finished-activity → P1 event hook, owned by the runtime (see
    // index.mjs `p2ActivityFinished`). Absent means "no P1 experience is recorded", which is the
    // pre-slice behaviour. When present, the hook is wrapped so a successful write also records
    // the `p2_p1_<activityId>` mark that the compensation scan below reads (R3).
    onFinished: p1Hook
      ? (info) => {
        const written = p1Hook(info);
        if (written?.ok === true) markP1EventWritten(info?.scopeKey, info?.activityId);
        return written;
      }
      : null,
    onError: (code, detail) => noteError(`p2-activity-${code}`, detail),
  });

  let timer = null;
  let disposed = false;
  // R4: single-flight flag for the activity-start pump (see `pumpActivityStarts`).
  let startsInFlight = false;
  let lastTick = { at: 0, reason: '', planning: null, activities: null };
  let lastStart = { at: 0, slotId: '', activityId: '', code: '' };
  // P2.5 observability: the outcome of the last claim **this process** attempted, and its refusal
  // code. Deliberately process-local: it answers "what did the dispatcher try last, and why did it
  // fail?" — a question no table records. The durable half (`slots_due`, `dispatch_lag_ms`,
  // `claim_age_ms`) comes from `lib/dispatch-observability.mjs`, so a restart resets this to
  // `ok:null` instead of showing a stale success.
  let lastClaim = { at: 0, slotId: '', ok: null, code: '' };

  function pauseKey(kind) {
    return kind === 'planning' ? 'p2_planning_paused' : 'p2_activities_paused';
  }

  function pause(kind, reason = '') {
    const key = pauseKey(kind);
    if (typeof db.metaSet !== 'function') return { ok: false, code: 'meta-unavailable' };
    db.tx(() => {
      db.assertLeaseHeld({ owner, generation, at: Number(clock()) });
      db.metaSet(key, '1');
      db.metaSet(`${key}_reason`, String(reason).slice(0, 120));
    });
    return { ok: true, paused: true, kind, reason };
  }

  function resume(kind) {
    const key = pauseKey(kind);
    if (typeof db.metaSet !== 'function') return { ok: false, code: 'meta-unavailable' };
    db.tx(() => {
      db.assertLeaseHeld({ owner, generation, at: Number(clock()) });
      db.metaSet(key, '0');
      db.metaSet(`${key}_reason`, '');
    });
    return { ok: true, paused: false, kind };
  }

  /**
   * P2.5-1 / Slice A, jump 1 of the closed loop: which plan slots may the **heartbeat** claim?
   *
   * Pure read, no write, no model. The heartbeat runs synchronously inside its own transaction,
   * so this hook must never await anything: it answers with slot rows and a *named* deferral
   * reason, and the caller persists that reason instead of inventing one.
   *
   * The predicates are deliberately the same ones `startDueActivities` uses, so "the heartbeat
   * claimed it" and "the pump can start it" can never disagree:
   *   - `status = 'planned'` and the window covers `now` (the pump's own due window),
   *   - the plan is still `committed` (a superseded plan's slots are never dispatched),
   *   - no activity row exists for the slot yet (the pump is the only creator).
   *
   * @returns {{slots: Array<{slotId:string,planId:string,day:string,startAt:number,endAt:number,activity:string,reality:string}>, deferred: string|null}}
   */
  function dueSlotsForHeartbeat({ scopeKey, now = Number(clock()), limit = 1 } = {}) {
    if (disposed) return { slots: [], deferred: 'runtime-disposed' };
    if (!isActive() || getMode() !== 'active') return { slots: [], deferred: 'runtime-inactive' };
    if (config.p2?.activities?.enabled !== true) return { slots: [], deferred: 'activities-disabled' };
    // P2.5-1 gray release (plan §6): the *hook injection* is the primary gate, but the same switch
    // is re-checked here so a host that reaches the controller's hooks directly cannot dispatch
    // around it. Default false ⇒ upgrading the code never starts dispatching on its own.
    if (config.p2?.activities?.dispatchEnabled !== true) return { slots: [], deferred: 'dispatch-disabled' };
    if (config.p2?.activities?.paused === true || db.metaGet?.('p2_activities_paused', '0') === '1') return { slots: [], deferred: 'activities-paused' };
    // Foreground conversation always wins (P2.5 §2 principle 5). The slot stays due and a later
    // beat may claim it; it is never executed alongside the user.
    //
    // R4: a foreground signal that *throws* is not permission to dispatch. The old code swallowed
    // the error and continued, which is the fail-open the comment above denies; an unreadable
    // "is the user talking?" signal must defer, exactly like a `true` answer.
    if (typeof options.isForegroundBusy === 'function') {
      try {
        if (options.isForegroundBusy() === true) return { slots: [], deferred: 'chat-priority' };
      } catch (error) {
        noteError('p2-foreground-signal-failed', error?.message ?? String(error));
        return { slots: [], deferred: 'foreground-signal-unavailable' };
      }
    }
    const scope = String(scopeKey ?? '').trim();
    if (!scope) return { slots: [], deferred: 'invalid-scope' };
    const cap = Math.max(1, Math.min(20, Math.trunc(Number(limit) || 1)));
    let rows;
    try {
      rows = db.all(`SELECT s.slot_id, s.plan_id, s.day, s.start_at, s.end_at, s.activity, s.reality
                     FROM p2_plan_slots s
                     JOIN p2_plans p ON p.plan_id = s.plan_id AND p.scope = s.scope
                     WHERE s.scope = ? AND s.status = 'planned' AND s.kind = 'activity'
                       AND s.start_at <= ? AND s.end_at > ?
                       AND p.status = 'committed'
                       AND NOT EXISTS (SELECT 1 FROM p2_activities a WHERE a.scope = s.scope AND a.plan_slot_id = s.slot_id)
                     ORDER BY s.start_at ASC, s.slot_id ASC LIMIT ?`, scope, now, now, cap);
    } catch (error) {
      noteError('p2-due-slots-failed', error?.message ?? String(error));
      return { slots: [], deferred: 'due-query-failed' };
    }
    // R4: a job with an unresolved external effect (a `prepared` intent that is still in flight or
    // past its deadline, or a human-unresolved `unknown`) must not be dispatched again — the claim
    // is what eventually turns into a second external call. Filtering happens here, not in SQL,
    // because the job identity is a hash over (scope, window, kind) that SQL cannot compute.
    const blocked = blockedJobKeys(scope, now);
    const usable = (rows ?? []).filter(row => !blocked.has(jobKeyFor({
      scopeKey: scope, startAt: Number(row.start_at), endAt: Number(row.end_at), kind: String(row.activity ?? ''),
    })));
    return {
      slots: usable.map(row => ({
        slotId: String(row.slot_id ?? ''),
        planId: String(row.plan_id ?? ''),
        day: String(row.day ?? ''),
        startAt: Number(row.start_at) || 0,
        endAt: Number(row.end_at) || 0,
        activity: String(row.activity ?? ''),
        reality: String(row.reality ?? ''),
      })).filter(slot => slot.slotId !== ''),
      deferred: null,
    };
  }

  /**
   * R4: the jobKeys of this scope that may not be dispatched again.
   *
   * Read-only and bounded (`effectIndex` caps the number of rows it parses). A failure to read the
   * ledger returns nothing rather than blocking everything: the `start()` gate is the authoritative
   * check, and it fails closed on its own.
   */
  function blockedJobKeys(scope, now) {
    try {
      const { byJob } = effectIndex(db, { scopeKey: scope });
      const out = new Set();
      for (const [jobKey, record] of byJob.entries()) {
        if (effectBlock({ record, now }).blocked) out.add(jobKey);
      }
      return out;
    } catch (error) {
      noteError('p2-effect-index-failed', error?.message ?? String(error));
      return new Set();
    }
  }

  /**
   * P2.5-1 / Slice A, jump 1 (the write half): claim one due slot for the heartbeat.
   *
   * The claim is exactly **one existing event edge** — `autonomy/plan-slot` `planned → started`,
   * whose reducer (`planner.mjs` `planSlotKind`) validates the transition, the plan ownership and
   * the scope. Nothing else is written here: no activity row, no budget, no model. The
   * asynchronous pump (`startDueActivities`) still owns execution, which is what keeps
   * `heartbeat.cycle()` synchronous.
   *
   * `occurredAt` is the slot's own `start_at`, so a retried claim reproduces the same
   * content-addressed `eventId` instead of appending a second event replay would reject.
   */
  function claimSlotForHeartbeat({ scopeKey, slotId, planId = '', day = '', scheduledAt = 0 } = {}) {
    const refused = code => {
      lastClaim = { at: Number(clock()), slotId: String(slotId ?? ''), ok: false, code };
      return { ok: false, code };
    };
    if (disposed) return refused('runtime-disposed');
    if (!isActive() || getMode() !== 'active') return refused('runtime-inactive');
    if (config.p2?.activities?.enabled !== true) return refused('activities-disabled');
    // Same gray-release re-check as `dueSlotsForHeartbeat`: a claim is refused before it can
    // append anything while `p2.activities.dispatchEnabled` is not explicitly true.
    if (config.p2?.activities?.dispatchEnabled !== true) return refused('dispatch-disabled');
    const slot = String(slotId ?? '').trim();
    const scope = String(scopeKey ?? '').trim();
    if (!slot) return refused('invalid-input');
    if (!scope) return refused('invalid-scope');
    try {
      const outcome = dispatchClaim({
        kind: 'autonomy/plan-slot',
        scopeKey: scope,
        occurredAt: Math.max(1, Math.trunc(Number(scheduledAt) || Number(clock()))),
        // The claim is the one place where the *scheduled* time and the *decision* time differ,
        // and `claim_age_ms` / `dispatch_lag_ms` (CONTRACT §15) need both. `occurredAt` stays the
        // slot's own start so a retried claim keeps reproducing the same content-addressed
        // `eventId`; `recordedAt` is when this runtime actually wrote it, which is durable
        // information the event row did not have before (it defaulted to `occurredAt`, making
        // `recorded_at - occurred_at` identically 0).
        recordedAt: Math.max(1, Math.trunc(Number(clock()))),
        payload: {
          slotId: slot,
          planId: String(planId ?? ''),
          day: String(day ?? ''),
          from: 'planned',
          to: 'started',
          detail: 'heartbeat-dispatch',
        },
      });
      lastClaim = { at: Number(clock()), slotId: slot, ok: true, code: outcome?.inserted === false ? 'already-claimed' : 'claimed' };
      return {
        ok: true,
        inserted: outcome?.inserted !== false,
        eventId: String(outcome?.eventId ?? ''),
        seq: Number(outcome?.seq ?? 0) || 0,
      };
    } catch (error) {
      // Typed refusal, reported as a code: the heartbeat decides whether it is a quarantineable
      // refusal (bounded, reason persisted) or a gate that must abort the round. It must never be
      // swallowed here, or a broken claim would look like a successful one.
      const code = String(error?.code ?? 'claim-failed');
      lastClaim = { at: Number(clock()), slotId: slot, ok: false, code };
      return {
        ok: false,
        code,
        error: String(error?.message ?? error).slice(0, 160),
      };
    }
  }

  /**
   * P2.5 observability (CONTRACT §15): the durable dispatch metrics for one scope.
   *
   * Pure read — no sweep, no meta write, no event. `p2Status()` embeds this object, but note that
   * `p2Status()` as a whole is **not** write-free (`status()` calls `budget.sweep`); the zero-write
   * entry point is `dispatchWatch()` below / `runtime.p2DispatchWatch()`.
   */
  function dispatchMetrics({ scopeKey, now = Number(clock()) } = {}) {
    const scope = String(scopeKey ?? '').trim();
    const measured = measureDispatch(db, { scopeKey: scope, now: Number(now) || Number(clock()) });
    return {
      ...measured,
      // The switch state is this controller's fact, not a table's.
      dispatch_enabled: config.p2?.activities?.dispatchEnabled === true,
      activities_enabled: config.p2?.activities?.enabled === true,
      paused: config.p2?.activities?.paused === true || db.metaGet?.('p2_activities_paused', '0') === '1',
      lastClaim: { ...lastClaim },
      lastStart: { ...lastStart },
    };
  }

  /**
   * P2.5 dry watch (CONTRACT §15.3): what the *next* heartbeat beat would claim, and why it could
   * not. Zero writes — this is the call an operator makes **before** flipping
   * `p2.activities.dispatchEnabled` on, and a watch that writes would defeat its own purpose.
   *
   * The P2 side answers the slot-level question; the host (`index.mjs`) merges the heartbeat's own
   * gates (heartbeat/agenda switches, pause, per-cycle cap, interval) on top, because the heartbeat
   * is the component that will actually run the beat.
   */
  function dispatchWatch({ scopeKey, now = Number(clock()), limit = 20 } = {}) {
    const scope = String(scopeKey ?? '').trim();
    const at = Number(now) || Number(clock());
    const raw = config.heartbeat ?? {};
    const intervalMs = Math.max(1000, Math.min(3600000, Math.trunc(Number(raw.pollIntervalMs) || 60000)));
    const jitterMs = Math.max(0, Math.min(60000, Math.trunc(Number(raw.jitterMs ?? 2500) || 0)));
    const maxPerBeat = Math.max(0, Math.min(20, Math.trunc(Number(raw.maxDispatchPerCycle ?? 1) || 1)));
    const watched = watchDispatch(db, { scopeKey: scope, now: at, limit, maxPerBeat: Math.max(1, maxPerBeat), intervalMs, jitterMs });
    // Why this scope would not be claimed even if it had due slots: the same ordered gate list
    // `dueSlotsForHeartbeat()` walks, reported instead of returned early.
    const deferred = (() => {
      if (disposed) return 'runtime-disposed';
      if (!isActive() || getMode() !== 'active') return 'runtime-inactive';
      if (config.p2?.activities?.enabled !== true) return 'activities-disabled';
      if (config.p2?.activities?.dispatchEnabled !== true) return 'dispatch-disabled';
      if (config.p2?.activities?.paused === true || db.metaGet?.('p2_activities_paused', '0') === '1') return 'activities-paused';
      if (typeof options.isForegroundBusy === 'function') {
        try { if (options.isForegroundBusy() === true) return 'chat-priority'; } catch { return 'foreground-signal-unavailable'; }
      }
      if (!scope) return 'invalid-scope';
      if (maxPerBeat === 0) return 'dispatch-cap-zero';
      return null;
    })();
    return {
      ...watched,
      dispatchEnabled: config.p2?.activities?.dispatchEnabled === true,
      activitiesEnabled: config.p2?.activities?.enabled === true,
      paused: config.p2?.activities?.paused === true || db.metaGet?.('p2_activities_paused', '0') === '1',
      // `null` = nothing blocks this scope; a string is the *named* deferral the heartbeat would
      // persist as `dispatch-deferred:<code>`.
      deferred,
      claimableNow: deferred === null && watched.ok === true && Number(watched.counts?.claimable ?? 0) > 0,
      metrics: dispatchMetrics({ scopeKey: scope, now: at }),
    };
  }

  /**
   * Start activities whose soft plan slot window covers now. Bounded and single-flight.
   *
   * Async on purpose: the activity ports do real IO, so a start can genuinely fail *after* the
   * slot was selected. It is therefore never folded into the synchronous planner tick — the
   * timer fires it separately and a failed start must not be reported as `started`.
   */
  async function startDueActivities({ scopeKey, now }) {
    const started = [];
    if (!isActive() || config.p2?.activities?.enabled !== true || getMode() !== 'active') return started;
    // A slot whose window is already past and that never started is a miss, not a backlog: mark
    // it expired with a receipt instead of silently dropping it (amendment BLOCK-6).
    //
    // P2.5-1: `started` is included on purpose. The heartbeat may have *claimed* a slot
    // (`planned → started`) and then died before the pump started it; without this branch that
    // claim would sit in `started` forever, which is exactly the orphan state A3 found in the
    // production database. A claimed slot with no activity row is therefore filed as a miss too —
    // with the slot's own status as `from`, so the frozen transition table stays honest.
    try {
      const missed = db.all(`SELECT s.slot_id, s.plan_id, s.day, s.activity, s.end_at, s.status, s.title, s.target_ref, s.reality FROM p2_plan_slots s
                             JOIN p2_plans p ON p.plan_id = s.plan_id AND p.scope = s.scope
                             WHERE s.scope = ? AND s.status IN ('planned','started') AND s.kind = 'activity' AND s.end_at <= ?
                               AND p.status = 'committed'
                               AND NOT EXISTS (SELECT 1 FROM p2_activities a WHERE a.scope = s.scope AND a.plan_slot_id = s.slot_id)
                             LIMIT 8`, scopeKey, now);
      for (const slot of missed) {
        emit({
          kind: 'autonomy/plan-slot', scopeKey,
          occurredAt: now,
          payload: { slotId: slot.slot_id, planId: slot.plan_id ?? '', day: slot.day ?? '', from: slot.status, to: 'expired', detail: 'missed' },
        });
        // A missed window also files its evidence: one `missed` receipt against the activity the
        // slot would have produced, written by the activities reducer (the only writer of
        // `p2_activity_receipts`). Deterministic, so a repeated tick cannot duplicate it.
        if (typeof missedReceiptEvent === 'function') {
          try {
            const event = missedReceiptEvent({ scopeKey, slotId: slot.slot_id, kind: slot.activity ?? '', generation, at: Number(slot.end_at ?? now) || now });
            if (event) emit(event);
          } catch (error) { noteError('p2-missed-receipt-failed', error?.message ?? String(error)); }
        }
        // P2.5-2 (A4 §1.4 E1-d): "the planned thing did not happen" is a fact tomorrow's plan has
        // to see, not just a slot status. There is no activity row, so it cannot go through the
        // transition hook; the pump reports it here. Failure is only reported, never fatal.
        if (typeof onMissed === 'function') {
          try {
            const written = onMissed({
              scopeKey,
              slotId: slot.slot_id,
              kind: slot.activity ?? '',
              target: slot.target_ref || slot.title || '',
              reality: slot.reality,
              reason: 'window-closed',
              at: Number(slot.end_at ?? now) || now,
            });
            void written;
          } catch (error) { noteError('p2-missed-fact-failed', error?.message ?? String(error)); }
        }
      }
    } catch { /* expiry is best effort; a failed attempt is retried next tick */ }
    let due;
    try {
      // P2.5-1: `started` is a *claim* the heartbeat (or a previous pump tick) already made, and
      // it is only executable while no activity row exists for the slot. The plan join and the
      // `NOT EXISTS` are what make "claimed by the heartbeat" and "started by the pump" one
      // logical job: a superseded plan's slots and an already-created activity are both excluded.
      due = db.all(`SELECT s.slot_id, s.plan_id, s.day, s.start_at, s.end_at, s.status, s.activity, s.title, s.target_ref, s.intent, s.reality
                    FROM p2_plan_slots s
                    JOIN p2_plans p ON p.plan_id = s.plan_id AND p.scope = s.scope
                    WHERE s.scope = ? AND s.status IN ('planned','started') AND s.kind = 'activity'
                      AND s.start_at <= ? AND s.end_at > ?
                      AND p.status = 'committed'
                      AND NOT EXISTS (SELECT 1 FROM p2_activities a WHERE a.scope = s.scope AND a.plan_slot_id = s.slot_id)
                    ORDER BY s.start_at ASC LIMIT 2`, scopeKey, now, now);
    } catch { return started; }
    // R4: same block as `dueSlotsForHeartbeat` — a job whose external effect is unresolved must not
    // be handed to `start()` a second time from the pump path either.
    const blocked = blockedJobKeys(scopeKey, now);
    for (const slot of due) {
      if (!slot.activity) continue;
      if (blocked.has(jobKeyFor({ scopeKey, startAt: Number(slot.start_at) || 0, endAt: Number(slot.end_at) || 0, kind: String(slot.activity) }))) {
        lastStart = { at: now, slotId: slot.slot_id, activityId: '', code: 'effect-unresolved' };
        noteError('p2-activity-start-effect-unresolved', `slot ${slot.slot_id} is blocked by an unresolved external effect`);
        continue;
      }
      if (activities.status().running >= 1) break; // real-environment activity stays single-flight
      // Carry the slot's own reality label into the activity: a planned activity slot is
      // ctual_tool_activity, a rest/open slot was never labelled and stays fail-closed.
      const paused = db.get(`SELECT activity_id, checkpoint FROM p2_activities WHERE scope=? AND kind=? AND target=? AND status='paused' ORDER BY updated_at DESC LIMIT 1`, scopeKey, slot.activity, slot.target_ref || slot.title);
      // Only an automatic time-window pause may resume itself; manual and review pauses stay parked.
      if (paused && !canAutoResumeActivity(paused.checkpoint)) {
        lastStart = { at: now, slotId: slot.slot_id, activityId: paused.activity_id, code: 'continuation-parked' };
        continue;
      }
      const retry = startRetryGate(db, scopeKey, slot.slot_id, now);
      if (!retry.allowed) continue;
      let result;
      try {
        result = paused
          ? await activities.resume({ activityId: paused.activity_id, scopeKey, slotId: slot.slot_id, reason: 'planned-continuation' })
          : await activities.start({ slotId: slot.slot_id, scopeKey, kind: slot.activity, target: slot.target_ref || slot.title, reality: slot.reality });
      } catch (error) {
        recordStartFailure(db, retry, now, error?.code);
        lastStart = { at: now, slotId: slot.slot_id, activityId: '', code: error?.code ?? 'start-failed' };
        noteError('p2-activity-start-failed', String(error?.message ?? error));
        continue;
      }
      lastStart = { at: now, slotId: slot.slot_id, activityId: result?.activityId ?? '', code: result?.ok === false ? result.code : 'started' };
      if (result?.ok === false) {
        recordStartFailure(db, retry, now, result.code);
        noteError(`p2-activity-start-${result.code ?? 'failed'}`, `slot ${slot.slot_id} could not start`);
        continue;
      }
      const upto = slot.intent ? String(slot.intent).trim() : slot.title;
      // P2.5-1: only a slot the pump itself has to claim gets the `planned → started` edge. A
      // slot the heartbeat already claimed is *already* started, and re-emitting the edge would
      // be refused by the reducer (`started → started` is not a legal transition) — the pump
      // must not read that refusal as "the start failed" when the activity really was created.
      if (String(slot.status ?? 'planned') === 'planned') {
        emit({
          kind: 'autonomy/plan-slot', scopeKey,
          occurredAt: Number(slot.start_at ?? now),
          payload: { slotId: slot.slot_id, planId: slot.plan_id ?? '', day: slot.day ?? '', from: 'planned', to: 'started', detail: String(upto ?? '').slice(0, 120) },
        });
      }
      started.push(result.activityId);
    }
    return started;
  }

  /**
   * Async companion of `tick()`: performs the real activity starts for every persisted scope.
   * Kept out of the synchronous tick so a slow port can never stall planning, and so a failed
   * start is reported as a failure instead of an optimistic "started".
   */
  async function pumpActivityStarts({ now = Number(clock()) } = {}) {
    const started = [];
    if (disposed) return { ok: false, code: 'runtime-disposed', started };
    if (!isActive() || getMode() !== 'active') return { ok: false, code: 'runtime-inactive', started };
    if (config.p2?.activities?.enabled !== true) return { ok: false, code: 'activities-disabled', started };
    // R4: single-flight. Two overlapping passes (the timer plus a manual `pumpActivities`) each
    // scan the same due slots *before* the first `start()` has created a row, so without this they
    // both enter `start()` for one slot. The durable execution intent is the real guard; this lock
    // keeps the cheap case cheap and stops the second pass from racing the first for no reason.
    if (startsInFlight) return { ok: true, code: 'starts-in-flight', started };
    startsInFlight = true;
    try { return await runActivityStarts({ now, started }); }
    finally { startsInFlight = false; }
  }

  async function runActivityStarts({ now, started }) {
    let scopes = [];
    try { scopes = db.all('SELECT scope FROM scope_snapshots ORDER BY scope').map(row => row.scope); }
    catch { return { ok: false, code: 'runtime-off', started }; }
    for (const scopeKey of scopes) {
      if (disposed) break;
      try { started.push(...await startDueActivities({ scopeKey, now })); }
      catch (error) { noteError('p2-activity-pump-failed', error?.message ?? String(error)); }
    }
    return { ok: true, at: now, started };
  }

  // Per-activity backoff for the execution pump: a failing model call must not be retried on
  // every timer tick, and the retry must not hammer the shared budget.
  const executionState = new Map();
  const bilibiliAbort = new AbortController();

  function executionGate(activityId, now) {
    const state = executionState.get(activityId) ?? { failures: 0, nextAttemptAt: 0, inflight: false };
    executionState.set(activityId, state);
    return state;
  }

  /**
   * The real execution pump (contract v1.2 section 1).
   *
   * A started activity is not a finished activity: this is the only place that turns a
   * `running` row into real progress, and it does so strictly in this order — reserve budget,
   * take the exact segment, call the `p2-activity` model, validate the answer, apply model
   * progress (which writes the interval and its receipt in one transaction), settle budget.
   * Any failure leaves the prefix untouched and backs the activity off.
   */
  /**
   * Parse a writing answer. The protocol is explicit: `{"text":"…","done":true|false}` (a fenced
   * JSON block is accepted too). A plain paragraph is kept as the body with `done:false`, so an
   * ordinary "stop" can never be mistaken for a finished project.
   */
  function parseWriteAnswer(raw) {
    const value = String(raw ?? '').trim();
    const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = (fenced ? fenced[1] : value).trim();
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const body = String(parsed.text ?? parsed.body ?? parsed.content ?? '').trim();
        const done = parsed.done === true || parsed.finished === true || parsed.complete === true;
        if (body) return { text: body, done };
      }
    } catch { /* not JSON: fall through to the plain-text rule */ }
    const marker = /\[\[\s*done\s*\]\]\s*$/i.test(value);
    return { text: marker ? value.replace(/\[\[\s*done\s*\]\]\s*$/i, '').trim() : value, done: marker };
  }
  async function pumpActivityExecution({ now = Number(clock()), maxStepsPerCycle = Number(config.p2?.activities?.maxStepsPerCycle ?? 2) } = {}) {
    const steps = [];
    if (disposed) return { ok: false, code: 'runtime-disposed', steps };
    if (!isActive() || getMode() !== 'active') return { ok: false, code: 'runtime-inactive', steps };
    if (config.p2?.activities?.enabled !== true) return { ok: false, code: 'activities-disabled', steps };
    if (config.p2?.activities?.paused === true || db.metaGet?.('p2_activities_paused', '0') === '1') return { ok: false, code: 'activities-paused', steps };
    // The pump may be called by a host that no longer holds the writer lease: that is a refusal,
    // not a crash, so it is reported with the same code the budget uses.
    try {
      if (typeof db.assertLeaseHeld === 'function') db.assertLeaseHeld({ owner, generation, at: Number(clock()) });
    } catch (error) {
      const code = String(error?.code ?? '');
      return { ok: false, code: code === 'lease-expired' || code === 'lease-held' || code === 'not-writer' ? code : 'lease-expired', steps, reason: (error?.message ?? String(error)).slice(0, 120) };
    }
    const activityApi = activities;
    if (typeof activityApi?.segment !== 'function' || typeof activityApi?.applyModelProgress !== 'function') {
      // Honest degradation: the model-gated API is what makes progress real.
      return { ok: false, code: 'execution-api-unavailable', steps };
    }
    let scopes = [];
    try { scopes = db.all('SELECT scope FROM scope_snapshots ORDER BY scope').map(row => row.scope); }
    catch { return { ok: false, code: 'runtime-off', steps }; }
    let budgetUsed = 0;
    for (const scopeKey of scopes) {
      if (disposed || steps.length >= maxStepsPerCycle) break;
      let running = [];
      try {
        running = db.all(`SELECT a.activity_id, a.kind, a.reality, a.consumed_prefix, a.total_units, a.updated_at, a.checkpoint,
                                 s.slot_id, s.end_at
                          FROM p2_activities a
                          LEFT JOIN p2_plan_slots s ON s.slot_id = a.plan_slot_id AND s.scope = a.scope
                          WHERE a.scope = ? AND a.status = 'running'
                            AND (a.checkpoint IS NULL OR a.checkpoint NOT LIKE '%"needsReview":true%')
                          ORDER BY a.updated_at ASC LIMIT ?`, scopeKey, Math.max(1, Number(config.p2?.activities?.maxConcurrent ?? 1)));
      } catch { continue; }
      // Compensation runs before new work: an unremembered finished activity is a real loss.
      try { await compensateMemory({ scopeKey }); } catch (error) { noteError('p2-memory-compensate-threw', error?.message ?? String(error)); }
      for (const row of running) {
        if (disposed || steps.length >= maxStepsPerCycle) break;
        // A review gate is absolute (contract v1.2 §1, external host Phase B): `reconcile` parks an
        // activity in `needsReview`, and nobody may advance it until an operator explicitly
        // resumes or re-plans it. Without this the pump happily continued a parked write while the
        // resumed read starved.
        let checkpoint = {};
        try { checkpoint = JSON.parse(String(row.checkpoint ?? '{}')) ?? {}; } catch { checkpoint = {}; }
        if (checkpoint.needsReview === true) {
          steps.push({ activityId: row.activity_id, code: 'needs-review' });
          continue;
        }
        const state = executionGate(row.activity_id, now);
        if (state.inflight) { steps.push({ activityId: row.activity_id, code: 'single-flight' }); continue; }
        // Claim the flight before any await: the timer and a concurrent caller overlap around
        // a 90 s model call, and a late claim would let the same activity spend twice.
        state.inflight = true;
        if (state.nextAttemptAt > now) { state.inflight = false; steps.push({ activityId: row.activity_id, code: 'backoff', until: state.nextAttemptAt }); continue; }
        // A window that already closed is finished (with evidence) or paused, never advanced forever.
        // A resume after the planned window gets a fresh allowance recorded on the checkpoint, so
        // an explicitly resumed activity is not paused again for a window that is already past.
        const checkpointGate = (() => { try { return JSON.parse(String(row.checkpoint ?? '{}')) ?? {}; } catch { return {}; } })();
        const effectiveEnd = Number(checkpointGate.windowExtendedUntil ?? row.end_at ?? 0);
        const windowClosed = effectiveEnd > 0 && now >= effectiveEnd;
        if (row.kind === 'bilibili') {
          const roundId = row.activity_id;
          let result = { roundId, status: 'failed', evidence: [] };
          try {
            if (row.reality === 'actual_tool_activity' && effectiveEnd > 0 && typeof ports.runBilibili === 'function') {
              result = await ports.runBilibili({ roundId, deadlineAt: effectiveEnd, signal: bilibiliAbort.signal });
            }
          } catch (error) {
            result = { roundId, status: 'unknown', evidence: [] };
            noteError('p2-bilibili-execution', String(error?.code ?? 'execution-error'));
          }
          try {
            if (!disposed) steps.push(await activityApi.settleBilibili({ activityId: roundId, scopeKey, result }));
          } finally {
            state.inflight = false;
          }
          continue;
        }
        let segmentOutcome;
        // The module serves every scope from one controller, so the caller must hand back the
        // scope it resolved: without it a row from another scope could be advanced (BLOCK-7).
        try { segmentOutcome = await activityApi.segment({ activityId: row.activity_id, scopeKey }); }
        catch (error) { segmentOutcome = { ok: false, code: error?.code ?? 'no-segment' }; }
        if (!segmentOutcome?.ok) {
          const segmentCode = String(segmentOutcome?.code ?? 'no-segment');
          steps.push({ activityId: row.activity_id, code: segmentCode });
          // P2.5-B2 invalidation recovery. `segment()` re-reads and re-hashes the source before
          // every model call, so a failure here is the executor discovering that the material it was
          // reading is no longer the material it recorded. `source-changed` is the one that can never
          // be resumed from the old offset (that is exactly what the adapter refuses), so without
          // parking it the pump would re-report the same deterministic failure on every tick and the
          // row would sit in `running` for ever — the state the P2.5 plan forbids. `source-invalid` is
          // deliberately left on the old path (see `PARKABLE_SOURCE_CODES`): it also covers transient
          // I/O, and a temporary lock must not become an operator task. Parking uses the same gate as
          // the model-progress path (`paused` + `needsReview` + one `review` receipt + one `failed`
          // fact), so both entry points leave identical evidence.
          const parked = PARKABLE_SOURCE_CODES.has(segmentCode) && typeof activityApi.park === 'function'
            ? activityApi.park({ activityId: row.activity_id, scopeKey, code: segmentCode, detail: segmentOutcome?.error ?? '' })
            : null;
          if (parked && parked.ok === true) {
            steps.push({ activityId: row.activity_id, code: 'parked', reason: segmentCode });
          } else if (windowClosed) {
            await safeClose({ scopeKey, activityId: row.activity_id, kind: row.kind, now, windowClosed: true });
          }
          state.inflight = false;
        continue;
        }
        const segment = segmentOutcome;
        const finalSegment = Number(segment.to ?? 0) >= Number(segment.totalUnits ?? 0);
        const reserve = budget.reserve({
          scope: scopeKey, purpose: 'p2-activity', ref: `act:${row.activity_id}:${segment.expectedConsumed}:${segment.from}-${segment.to}`,
          estimatedInputTokens: Math.ceil(String(segment.prompt ?? '').length / 4),
          estimatedOutputTokens: Number(config.p2?.activities?.maxOutputTokensPerStep ?? 1200),
          now,
        });
        if (!reserve.ok) {
          steps.push({ activityId: row.activity_id, code: reserve.code });
          if (windowClosed || finalSegment) await safeClose({ scopeKey, activityId: row.activity_id, kind: row.kind, now, windowClosed });
          state.inflight = false;
          state.inflight = false;
        continue;
        }
        budgetUsed += 1;
        let modelResult = null;
        try {
          budget.markIssued?.({ scope: scopeKey, ref: reserve.ref, now });
          modelResult = await callModel({
            purpose: 'p2-activity', system: String(segment.system ?? ''),
            input: String(segment.prompt ?? '') + (String(segment.kind ?? segment.adapter) === 'write'
              // The explicit completion protocol: the executor parses this JSON, so a plain
              // finish_reason=stop can never be mistaken for a finished project.
              ? '\n\n只输出 JSON：{"text":"这一版的正文","done":false}；整篇写完后把 done 设为 true。'
              : ''),
            maxTokens: Number(config.p2?.activities?.maxOutputTokensPerStep ?? 1200),
          });
        } catch (error) {
          state.failures += 1;
          state.nextAttemptAt = now + Math.min(Number(config.p2?.budget?.maxRetryBackoffMs ?? 1800000), 60000 * 2 ** (state.failures - 1));
          state.inflight = false;
          try { budget.settle({ scope: scopeKey, ref: reserve.ref, ok: false, code: error?.code ?? 'model-error', now }); } catch { /* accounting is best effort here */ }
          steps.push({ activityId: row.activity_id, code: error?.code ?? 'model-error' });
          state.inflight = false;
          state.inflight = false;
        continue;
        }
        const rawAnswer = String(modelResult?.text ?? '');
        // A write has no exhaustible source, so the finish signal must come from the answer
        // itself — never from a plain `finish_reason = stop`, or one paragraph would count as a
        // finished project. The write prompt asks for {"text":…,"done":…}; anything else is
        // treated as body text with `done:false`.
        let text = rawAnswer;
        let doneFlag = modelResult?.done === true;
        if (String(segment.kind ?? segment.adapter) === 'write') {
          const parsed = parseWriteAnswer(rawAnswer);
          text = parsed.text;
          doneFlag = parsed.done;
        }
        // An empty answer is an unknown answer: it must never advance the prefix, for reads as
        // much as for writes (a read receipt without any model output attests nothing).
        if (!text.trim()) {
          state.failures += 1;
          state.nextAttemptAt = now + Math.min(Number(config.p2?.budget?.maxRetryBackoffMs ?? 1800000), 60000 * 2 ** (state.failures - 1));
          state.inflight = false;
          try { budget.settle({ scope: scopeKey, ref: reserve.ref, ok: false, code: 'model-empty', now }); } catch { /* best effort */ }
          steps.push({ activityId: row.activity_id, code: 'model-empty' });
          state.inflight = false;
          state.inflight = false;
        continue;
        }
        // The receipt hash is the full sha256 of what the receipt attests (contract v1.2 §2):
        // the exact source window for read/explore, the generated body for write. `digest()`
        // truncates, so it can never satisfy the 64-hex requirement.
        const isWriteSegment = String(segment.kind ?? segment.adapter) === 'write';
        const textHash = isWriteSegment
          ? (text ? crypto.createHash('sha256').update(text, 'utf8').digest('hex') : '')
          : crypto.createHash('sha256').update(String(segment.text ?? ''), 'utf8').digest('hex');
        const applied = await (async () => {
          try {
            return await activityApi.applyModelProgress({
              activityId: row.activity_id,
              scopeKey,
              expectedConsumed: segment.expectedConsumed,
              modelReceipt: {
                purpose: 'p2-activity', provider: modelResult?.provider ?? '', model: modelResult?.model ?? '',
                textHash, inputTokens: modelResult?.inputTokens ?? 0, outputTokens: modelResult?.outputTokens ?? 0,
                at: now, text, done: doneFlag === true,
              },
            });
          } catch (error) { return { ok: false, code: error?.code ?? 'model-receipt-invalid', error: error?.message ?? String(error) }; }
        })();
        state.inflight = false;
        try { budget.settle({ scope: scopeKey, ref: reserve.ref, inputTokens: modelResult?.inputTokens ?? 0, outputTokens: modelResult?.outputTokens ?? 0, ok: applied?.ok === true, code: applied?.ok === true ? '' : (applied?.code ?? 'apply-failed'), now }); } catch { /* settled best effort */ }
        if (!applied?.ok) {
          state.failures += 1;
          state.nextAttemptAt = now + Math.min(Number(config.p2?.budget?.maxRetryBackoffMs ?? 1800000), 60000 * 2 ** (state.failures - 1));
          steps.push({ activityId: row.activity_id, code: applied?.code ?? 'apply-failed' });
          if ((state.failures >= Number(config.p2?.activities?.maxAttempts ?? 5)) && typeof activityApi.fail === 'function') {
            try { await activityApi.fail({ activityId: row.activity_id, scopeKey, code: 'failed-unknown', reason: applied?.code ?? 'apply-failed' }); } catch { /* surfaced by status */ }
          }
          state.inflight = false;
          state.inflight = false;
        continue;
        }
        state.failures = 0;
        state.nextAttemptAt = 0;
        steps.push({ activityId: row.activity_id, code: 'stepped', consumed: applied.consumedPrefix, total: applied.totalUnits, artifactVersion: applied.artifactVersion ?? null });
        // A write has no exhaustible source: its `totalUnits` is the current artifact length, so
        // `consumed >= total` would close it after a single paragraph. Only the model's own
        // `done` (surfaced as `complete`) may finish a write.
        const isWriteActivity = String(applied.kind ?? row.kind ?? '') === 'write';
        const done = applied.complete === true
          || (!isWriteActivity && Number(applied.totalUnits ?? 0) > 0 && Number(applied.consumedPrefix ?? 0) >= Number(applied.totalUnits ?? 0));
        if (done || windowClosed) await safeClose({ scopeKey, activityId: row.activity_id, kind: row.kind, now, windowClosed, done });
      }
    }
    return { ok: true, at: now, steps, budgetUsed };
  }

  /** Close an activity honestly: finish when there is evidence, pause when there is not. */
  async function safeClose({ scopeKey, activityId, kind, now, windowClosed = false, done = false }) {
    try {
      if (done) {
        await activities.finish({ activityId, scopeKey });
        // The finish transition itself now writes the experience through the P1 hook
        // (`memory/ingest-request`, namespace `p2/activity`). The legacy `memoryPort` write is a
        // SECOND experience with a different idempotency key and memory cannot merge them
        // (Codex review R3), so it is only kept for runtimes that were never wired to the hook.
        if (!p1Hook) {
          try { await recordExperience({ scopeKey, activityId }); }
          catch (error) { noteError('p2-memory-after-finish-failed', error?.message ?? String(error)); }
        }
        return;
      }
      await activities.pause({ activityId, scopeKey, reason: windowClosed ? 'window-closed' : 'segment-exhausted' });
    } catch (error) { noteError('p2-activity-close-failed', error?.message ?? String(error)); }
  }

  /**
   * Compensation pass (contract v1.2 §5): a real `done` activity that was never remembered —
   * because the process died between the finish and the mark, or the engine/outbox was down —
   * is remembered now, through the same deterministic key, so a retry can never double-write.
   */
  /**
   * H5 minimal plan control (contract v1.2 §7): lock or skip one future slot. Both go through
   * the `autonomy/plan-slot` event so state stays replayable; only a `planned` slot can be
   * skipped, and locking is a property the planner must respect on the next version.
   */
  function controlPlanSlot({ scopeKey, slotId, action, now = Number(clock()) } = {}) {
    if (!slotId) return { ok: false, code: 'invalid-slot' };
    const slot = db.get('SELECT * FROM p2_plan_slots WHERE scope = ? AND slot_id = ?', scopeKey, slotId);
    if (!slot) return { ok: false, code: 'unknown-slot' };
    if (action !== 'lock' && action !== 'unlock' && action !== 'skip') return { ok: false, code: 'invalid-action' };
    if (action === 'skip' && String(slot.status) !== 'planned') return { ok: false, code: 'invalid-transition', status: String(slot.status) };
    if (action === 'skip') {
      emit({
        kind: 'autonomy/plan-slot', scopeKey, occurredAt: now,
        payload: { slotId, planId: slot.plan_id ?? '', day: slot.day ?? '', from: 'planned', to: 'skipped', detail: 'manual-skip' },
      });
      return { ok: true, slotId, action, status: 'skipped' };
    }
    emit({
      kind: 'autonomy/plan-slot', scopeKey, occurredAt: now,
      payload: { slotId, planId: slot.plan_id ?? '', day: slot.day ?? '', from: String(slot.status), to: String(slot.status), detail: action === 'lock' ? 'manual-lock' : 'manual-unlock', locked: action === 'lock' },
    });
    return { ok: true, slotId, action, locked: action === 'lock' };
  }
  /**
   * Record that the P1 experience event for this activity was written (R3).
   *
   * The mark is what makes the compensation scan cheap and safe: `status='done'` without this key
   * means "the finish committed but its `memory/ingest-request` may be missing". Failure to mark
   * is reported and *not* fatal — a missing mark merely means the next scan replays the same hook,
   * and replaying it is idempotent (content-addressed event + outbox key).
   */
  function markP1EventWritten(scopeKey, activityId) {
    const id = String(activityId ?? '').trim();
    const scope = String(scopeKey ?? '').trim();
    if (!id || !scope) return false;
    try {
      db.tx(() => {
        db.assertLeaseValid({ owner, generation, at: Number(clock()), requireRow: true });
        db.metaSet(`p2_p1_${id}`, '1');
      });
      return true;
    } catch (error) {
      noteError('p2-p1-mark-failed', error?.message ?? String(error));
      return false;
    }
  }

  /**
   * When did this installation start writing experiences through the P1 event path?
   *
   * Compensation must never backfill activities that finished **before** the switch: their
   * experience was already written through the legacy `memoryPort` (namespace `p2/experience`),
   * so replaying the P1 hook for them would create the very double write R3 is about — just
   * delayed by one deploy. The cutoff is persisted once (`p2_p1_scheme_since`) and reused by every
   * later process, so a crash *under the new scheme* stays compensable while old rows stay out.
   */
  function p1Epoch() {
    // The boundary records **when the P1 hook went live**, and it is derived from data that already
    // exists — never from the wall clock (round-3 A4): a clock that jumps backwards would otherwise
    // plant a boundary in the future and hide every activity finished after the jump.
    //
    // Both meta writes happen in one transaction AND the value is re-read inside it, so two
    // concurrent seeds cannot produce two different boundaries: whoever enters the write transaction
    // second sees the committed pair and returns it.
    const read = () => ({
      at: Number(db.metaGet?.('p2_p1_epoch_at', '') ?? '') || 0,
      activityId: String(db.metaGet?.('p2_p1_epoch_activity', '') ?? ''),
    });
    const stored = read();
    if (stored.at > 0) return stored;
    const now = Number(clock());
    try {
      const seeded = db.tx(() => {
        // Re-read: a racing seed may have committed while we were queued for the write lock.
        const inside = read();
        if (inside.at > 0) return inside;
        const newest = db.get("SELECT activity_id, updated_at FROM p2_activities WHERE status = 'done' ORDER BY updated_at DESC, activity_id DESC LIMIT 1") ?? null;
        const at = newest ? Math.max(1, Number(newest.updated_at) || 0) : 1; // 1 = "no rows yet", not the clock
        const activityId = newest ? String(newest.activity_id ?? '') : '';
        db.assertLeaseValid({ owner, generation, at: now, requireRow: true });
        db.metaSet('p2_p1_epoch_at', String(at));
        db.metaSet('p2_p1_epoch_activity', activityId);
        return { at, activityId };
      });
      return seeded;
    } catch (error) {
      // Without a readable boundary we must not guess a wall-clock one: report it and let the caller
      // treat compensation as unavailable (fail-closed) instead of silently hiding rows.
      noteError('p2-p1-epoch-failed', error?.message ?? String(error));
      return { at: 0, activityId: '', unavailable: true };
    }
  }

  /**
   * Compensation for "terminal committed, P1 event missing" (R3):
   * a `done` activity whose `p2_p1_<id>` mark is absent is replayed through the **same** hook.
   *
   * Bounded by `limit`, failures only reported, and idempotent: the hook derives the event from the
   * activity row (kind/target/coverage/version + the closing instant), and `eventIdFor` +
   * `outboxIdFor` make a second attempt land on the same rows.
   */
  /**
   * One-time history reconciliation for the P1 hook (round-3 A4).
   *
   * Rows finished before the hook went live were already written through the legacy experience path.
   * They are marked `p2_p1_<id>='legacy'` — a mark, not a clock comparison — so compensation can
   * afterwards scan **every unmarked row** without depending on `updated_at` being monotonic, and the
   * legacy rows can never be double-written. Runs once; the outcome (and why rows were ruled out) is
   * recorded, so nothing is excluded silently.
   */
  /**
   * One-time reconciliation of "rows that finished before the P1 hook existed".
   *
   * round-4 A4: this used to run **once globally** — a single 2000-row batch followed by a global
   * `p2_p1_reconciled` flag. Anything past the batch (or in another scope, or read while the fact
   * query happened to fail) was silently left to replay for ever, and the flag made sure nobody ever
   * looked again. Now the work is **per scope, batched, with a persisted cursor**:
   *   - `p2_p1_reconciled:<scope>` marks one scope as completely reconciled;
   *   - `p2_p1_reconcile_cursor:<scope>` is the `(updated_at, activity_id)` position of the last row
   *     this scope finished, so the next round continues instead of restarting;
   *   - a truncated or unavailable fact scan **never** marks the scope done (we cannot tell "no fact"
   *     from "fact we did not read", and guessing wrong hands a remembered row to compensation);
   *   - marks written by the old buggy rule are **re-audited**: a `legacy` row with no fact gets its
   *     mark removed so compensation can pick it up.
   */
  function reconcileLegacyOnce(scopeKey, epoch, { batch = 500 } = {}) {
    const doneKey = `p2_p1_reconciled:${scopeKey}`;
    const cursorKey = `p2_p1_reconcile_cursor:${scopeKey}`;
    const done = db.metaGet?.(doneKey, '');
    if (done) return { already: true, ruledOut: 0, reason: 'facts-exist', at: Number(done) || 0 };
    try {
      return db.tx(() => {
        const again = db.metaGet?.(doneKey, '');
        if (again) return { already: true, ruledOut: 0, reason: 'facts-exist', at: Number(again) || 0 };
        const cursor = (() => {
          try { return JSON.parse(String(db.metaGet?.(cursorKey, '') || '{}')); } catch { return {}; }
        })();
        const cursorAt = Number(cursor?.at ?? 0) || 0;
        const cursorId = String(cursor?.id ?? '');
        const limit = Math.max(1, Math.min(2000, Math.trunc(Number(batch) || 500)));
        const rows = db.all(`SELECT a.activity_id, a.updated_at FROM p2_activities a
                             LEFT JOIN runtime_meta m ON m.meta_key = 'p2_p1_' || a.activity_id
                             WHERE a.scope = ? AND a.status = 'done'
                               AND m.meta_value IS NULL
                               AND a.updated_at <= ?
                               AND (a.updated_at > ? OR (a.updated_at = ? AND a.activity_id > ?))
                             ORDER BY a.updated_at ASC, a.activity_id ASC LIMIT ?`,
        scopeKey, epoch.at, cursorAt, cursorAt, cursorId, limit + 1) ?? [];
        const more = rows.length > limit;
        const page = more ? rows.slice(0, limit) : rows;
        // A5: the fact scan reports truncation/unavailability; both mean "we do not know", and an
        // unknown answer must never be treated as "this row was never written".
        const factScan = listFactActivityIds(scopeKey);
        const recordDeferred = (reason, extra = {}) => {
          db.metaSet('p2_p1_reconciled_detail', JSON.stringify({
            at: Number(clock()), ruling: 'evidence', scope: scopeKey, deferred: true, reason, ...extra,
            epochAt: epoch.at, epochActivityId: epoch.activityId,
          }));
        };
        if (factScan.unavailable) {
          noteError('p2-p1-reconcile-unavailable', `the fact scan for ${scopeKey} failed; the scope stays unreconciled`);
          recordDeferred('fact-scan-unavailable', { unavailable: true });
          return { already: false, ruledOut: 0, leftForCompensation: 0, reason: 'fact-scan-unavailable', deferred: true };
        }
        if (factScan.truncated) {
          noteError('p2-p1-reconcile-truncated', `the fact scan for ${scopeKey} hit its limit (${Number(factScan.scanned) || 0} rows); the scope stays unreconciled`);
          recordDeferred('fact-scan-truncated', { truncated: true, scanned: Number(factScan.scanned) || 0 });
          return { already: false, ruledOut: 0, leftForCompensation: 0, reason: 'fact-scan-truncated', deferred: true };
        }
        const withFacts = new Set(factScan.ids);
        const ruled = [];
        const leftForCompensation = [];
        for (const row of page) {
          if (withFacts.has(String(row.activity_id))) {
            db.metaSet(`p2_p1_${row.activity_id}`, 'legacy');
            ruled.push(String(row.activity_id));
          } else {
            leftForCompensation.push(String(row.activity_id));
          }
        }
        const at = Number(clock());
        const last = page[page.length - 1];
        if (last) db.metaSet(cursorKey, JSON.stringify({ at: Number(last.updated_at) || 0, id: String(last.activity_id) }));
        const complete = !more;
        if (complete) db.metaSet(doneKey, String(at));
        db.metaSet('p2_p1_reconciled_detail', JSON.stringify({
          at, ruling: 'evidence', scope: scopeKey, batch: page.length, more,
          ruledOut: ruled.length, leftForCompensation: leftForCompensation.length,
          truncated: factScan.truncated === true, unavailable: factScan.unavailable === true,
          scanned: Number(factScan.scanned) || 0,
          reason: complete ? 'fact-exists' : 'batch-continues',
          epochAt: epoch.at, epochActivityId: epoch.activityId,
        }));
        return {
          already: false, ruledOut: ruled.length, leftForCompensation: leftForCompensation.length,
          complete, more, reason: complete ? 'fact-exists' : 'batch-continues', at,
        };
      });
    } catch (error) {
      noteError('p2-p1-reconcile-failed', error?.message ?? String(error));
      return { already: false, ruledOut: 0, reason: 'reconcile-failed', error: true };
    }
  }

  /**
   * round-4 A4: re-audit marks the old (clock-based) rule wrote. A `legacy` row with **no** fact is a
   * row that was never written, and the mark alone would exclude it from compensation for ever.
   */
  /**
   * Live counters for the operator: how many marks were looked at, how many belong to somebody else,
   * how many have no owning activity any more, and how many consecutive passes were deferred.
   * They are persisted so a diagnostics read can show them without re-running an audit.
   */
  function reauditStateKey(scopeKey) { return `p2_p1_reaudit_state:${scopeKey}`; }

  function reauditLegacyMarks(scopeKey, { batch = 500, includeUnowned = false, operator = '', evidence = '' } = {}) {
    const out = { checked: 0, revoked: 0, kept: 0, foreign: 0, unowned: 0, deferred: false, more: false };
    const cursorKey = `p2_p1_reaudit_cursor:${scopeKey}`;
    try {
      // The manual exit: an operator can ask for the marks whose activity row is gone. It requires
      // evidence, and it is recorded — otherwise those marks are stuck for ever ("data that exists
      // but can never be found").
      const forced = includeUnowned === true;
      if (forced && (!String(operator).trim() || !String(evidence).trim())) {
        return { ...out, deferred: true, reason: 'operator-and-evidence-required' };
      }
      const factScan = listFactActivityIds(scopeKey);
      if (factScan.unavailable || factScan.truncated) {
        noteError(factScan.unavailable ? 'p2-p1-reconcile-unavailable' : 'p2-p1-reconcile-truncated',
          `legacy re-audit for ${scopeKey} cannot see every fact; keeping the marks until it can`);
        out.deferred = true;
        return out;
      }
      const withFacts = new Set(factScan.ids);
      const cursor = (() => {
        try { return JSON.parse(String(db.metaGet?.(cursorKey, '') || '{}')); } catch { return {}; }
      })();
      if (cursor.done && !forced) { out.done = true; return out; }
      // A finished sweep may be run again from the start; a **partially** finished one continues where
      // it stopped, otherwise a small `batch` would reprocess the first page for ever.
      const after = cursor.done === true ? '' : String(cursor?.key ?? '');

      const limit = Math.max(1, Math.min(2000, Math.trunc(Number(batch) || 500)));
      const rows = db.all(`SELECT meta_key, meta_value FROM runtime_meta
                           WHERE meta_key LIKE 'p2_p1_%' AND meta_value = 'legacy' AND meta_key > ?
                             AND meta_key NOT LIKE 'p2_p1_reconciled%'
                             AND meta_key NOT LIKE 'p2_p1_reconcile_cursor:%'
                             AND meta_key NOT LIKE 'p2_p1_reaudit_%'
                             AND meta_key NOT LIKE 'p2_p1_deferred_streak:%'
                           ORDER BY meta_key ASC LIMIT ?`,
      after, limit + 1) ?? [];
      const more = rows.length > limit;
      const page = more ? rows.slice(0, limit) : rows;
      const last = page[page.length - 1];
      // One transaction for the batch: the read of ownership, the conditional write and the cursor move
      // either all happen or none do, so a concurrent writer cannot leave a half-audited page.
      const applied = db.tx(() => {
        for (const row of page) {
          const key = String(row.meta_key);
          if (key === 'p2_p1_reconciled' || key.startsWith('p2_p1_reconciled:') || key.startsWith('p2_p1_reconcile_cursor:') || key.startsWith('p2_p1_reaudit_cursor:') || key.startsWith('p2_p1_reaudit_state:') || key.startsWith('p2_p1_deferred_streak:')) continue;
          if (String(row.meta_value) !== 'legacy') continue;
          const activityId = key.slice('p2_p1_'.length);
          // Whose mark is this? The key carries no scope, so ask the activity row itself.
          let owner = null;
          try { owner = db.get('SELECT scope FROM p2_activities WHERE activity_id = ?', activityId)?.scope ?? null; } catch { owner = null; }
          const ownerless = owner === null || owner === undefined || owner === '';
          if (ownerless) {
            // No owning activity any more: by default we do **not** guess (a wrong revoke hands a
            // remembered row to compensation). Only a forced, evidenced pass may touch it.
            if (!forced) { out.unowned += 1; continue; }
            noteError('p2-p1-legacy-unowned-forced', `operator ${String(operator).slice(0, 40)} forced the re-audit of ${activityId}: ${String(evidence).slice(0, 120)}`);
          } else if (String(owner) !== String(scopeKey)) {
            // **Never** touch another scope's mark — that was the defect.
            out.foreign += 1; continue;
          }
          out.checked += 1;
          if (withFacts.has(activityId)) { out.kept += 1; continue; }
          // Conditional write: only revoke if it is *still* `legacy` (a concurrent pass may have moved it).
          const changed = db.run(`UPDATE runtime_meta SET meta_value = 'revoked' WHERE meta_key = ? AND meta_value = 'legacy'`, key);
          if (Number(changed?.changes ?? 0) > 0) out.revoked += 1;
        }
        if (more && last) db.metaSet(cursorKey, JSON.stringify({ key: String(last.meta_key) }));
        else db.metaSet(cursorKey, JSON.stringify({ key: '', done: true }));
        // Visibility: the two "skipped" buckets must be readable by an operator, not only returned.
        db.metaSet(reauditStateKey(scopeKey), JSON.stringify({
          at: Number(clock()), checked: out.checked, revoked: out.revoked, kept: out.kept,
          foreign: out.foreign, unowned: out.unowned, more, forced,
          operator: forced ? String(operator).slice(0, 80) : '',
        }));
        return true;
      });
      if (applied !== true) out.deferred = true;
      out.more = more;
      if (out.revoked) noteError('p2-p1-legacy-revoked', `${out.revoked} legacy mark(s) of ${scopeKey} had no fact and were handed back to compensation`);
      if (out.unowned) {
        noteError('p2-p1-legacy-unowned', `${out.unowned} legacy mark(s) have no owning activity; they stay until an operator re-audits them with evidence`);
      }
    } catch (error) {
      noteError('p2-p1-legacy-reaudit-failed', error?.message ?? String(error));
      out.deferred = true;
    }
    return out;
  }
  function listFactActivityIds(scopeKey) {
    const out = [];
    let rows = [];
    const limit = 20000;
    try {
      rows = db.all(`SELECT payload FROM domain_events WHERE scope = ? AND kind = 'memory/ingest-request'
                     ORDER BY rowid ASC LIMIT ?`, scopeKey, limit + 1) ?? [];
    } catch (error) { noteError('p2-fact-scan-error', String(error?.message ?? error)); return { ids: out, truncated: false, unavailable: true, scanned: 0 }; }
    // Lead ruling: no silent degradation. Past the scan limit we cannot tell "no fact" from "fact we
    // did not read", so the caller must be told (`reconcile-truncated`) rather than quietly deciding
    // that rows without a visible fact are compensation's work.
    const truncated = rows.length > limit;
    if (truncated) rows = rows.slice(0, limit);
    for (const row of rows) {
      try {
        const payload = JSON.parse(String(row.payload ?? '{}'));
        const id = String(payload?.facts?.activityId ?? '');
        if (id) out.push(id);
      } catch { /* a malformed payload is not evidence of a fact */ }
    }
    return { ids: out, truncated, unavailable: false, scanned: rows.length };
  }

  async function compensateFinishedEvents({ scopeKey, limit = 2 } = {}) {
    const replayed = [];
    // round-5 review: this returned `reaudit`, which is declared **below** — a ReferenceError instead of
    // the documented `no-p1-hook` answer (the function is exported, so callers saw a throw).
    if (!p1Hook) return { ok: true, replayed, reaudit: null, skipped: 'no-p1-hook' };
    if (typeof scopeKey !== 'string' || !scopeKey) return { ok: true, replayed, skipped: 'invalid-scope' };
    // "Is it already marked?" is decided by SQL, never by taking the oldest N rows and skipping
    // some of them: that shape made the 21st activity unreachable once the first twenty were marked.
    //
    // round-3 A4: the scan no longer uses "greater than the epoch tuple" as its filter. That filter
    // made correctness depend on the wall clock being monotonic — after a backwards jump every new
    // activity had `updated_at` below the boundary and was skipped **forever**. The scan is now
    // convergent: every `done` row of the scope that is not yet marked is a candidate, oldest first,
    // bounded per call. The marked set only grows, so each call strictly shrinks the remaining work.
    //
    // Cost: a compensate call may look at rows that predate the hook (it walks unmarked rows in
    // time order until it finds work). The epoch still exists — as the audit record of when the hook
    // went live and as the cutoff for the *legacy* path — but it no longer decides what is skipped.
    const epoch = p1Epoch();
    if (epoch.unavailable) return { ok: false, code: 'epoch-unavailable', replayed };
    // One-time reconciliation of history (round-3 A4). Rows finished **before** the hook went live were
    // already written through the legacy experience path; replaying them would double-write (R3). They
    // are excluded by a **mark of their own** (`p2_p1_<id>='legacy'`), not by a clock comparison — so a
    // rolled-back clock cannot resurrect them, and it cannot hide a genuinely new row either. The pass
    // runs once, is bounded, and records how many rows it ruled out and why.
    const reconciliation = reconcileLegacyOnce(scopeKey, epoch);
    // round-4 A4: the old rule could have marked rows `legacy` that never produced a fact. Re-auditing
    // hands those back to compensation instead of excluding them for ever.
    // Round-4 follow-up: runs until its cursor reaches the end of the table, not once per scope.
    const reaudit = reauditLegacyMarks(scopeKey);
    // round-5 review (P1, measured): "deferred" was returned and then ignored, so a scope whose facts
    // could not be read was compensated anyway — and "we do not know whether a fact exists" is not the
    // same as "it does not exist". Stop the whole pass instead of writing a second fact.
    if (reconciliation?.deferred || reaudit?.deferred) {
      const reason = reconciliation?.reason || 'reaudit-deferred';
      // A stall must be **visible**: if the fact query stays broken, compensation stops for ever and
      // nothing else in the system says so. Count consecutive deferrals and shout once they pile up.
      const streakKey = `p2_p1_deferred_streak:${scopeKey}`;
      let streak = 0;
      try { streak = Number(db.metaGet?.(streakKey, '0')) || 0; } catch { streak = 0; }
      streak += 1;
      try { db.metaSet(streakKey, String(streak)); } catch { /* visibility only */ }
      if (streak >= DEFERRED_STREAK_ALERT) {
        noteError('p2-p1-compensation-stalled',
          `compensation for ${scopeKey} has been deferred ${streak} passes in a row (${reason}); it will not write anything until the fact query recovers`);
      }
      return {
        ok: true, replayed, reaudit, reconciliation, deferred: true,
        skipped: 'reconcile-deferred', reason, deferredStreak: streak,
      };
    }
    // A pass that ran clears the streak: the stall (if any) is over.
    try {
      if (Number(db.metaGet?.(`p2_p1_deferred_streak:${scopeKey}`, '0')) > 0) db.metaSet(`p2_p1_deferred_streak:${scopeKey}`, '0');
    } catch { /* visibility only */ }
    let rows = [];
    try {
      rows = db.all(`SELECT a.activity_id, a.plan_slot_id, a.kind, a.adapter, a.target, a.source_ref, a.reality,
                            a.consumed_prefix, a.total_units, a.artifact_version, a.updated_at, a.checkpoint
                     FROM p2_activities a
                     LEFT JOIN runtime_meta m ON m.meta_key = 'p2_p1_' || a.activity_id
                     WHERE a.scope = ? AND a.status = 'done'
                       AND (a.kind <> 'bilibili' OR (a.reality = 'actual_tool_activity'
                         AND CASE WHEN json_valid(a.checkpoint) THEN json_extract(a.checkpoint, '$.bilibiliRound.watched') > 0 ELSE 0 END))
                       AND (m.meta_value IS NULL OR (m.meta_value <> '1' AND m.meta_value <> 'legacy'))
                     ORDER BY a.updated_at ASC, a.activity_id ASC LIMIT ?`,
      scopeKey, Math.max(1, limit));
    } catch { return { ok: false, code: 'db-unavailable', replayed }; }
    for (const row of rows) {
      if (db.metaGet?.(`p2_p1_${row.activity_id}`, '') === '1') continue;
      try {
        const written = p1Hook({
          scopeKey,
          activityId: row.activity_id,
          // F5: reproduce the decision the **live** write made. Re-deriving it here computed a
          // different significance (the live attempt had already taken the dedupe claim), the content
          // differed, and therefore so did the content-addressed event id — one activity, two facts.
          significance: String(db.metaGet?.(`p2_p1_sig_${String(row.activity_id)}`, '') ?? ''),
          // Every field the live hook received must be reproduced here, or the replay would mint a
          // different (content-addressed) event instead of finding the one already written.
          slotId: String(row.plan_slot_id ?? ''),
          kind: row.kind,
          adapter: row.adapter || row.kind,
          target: row.target,
          sourceRef: String(row.source_ref ?? ''),
          reality: row.reality,
          phase: 'finished',
          reason: '',
          consumedPrefix: row.kind === 'bilibili' ? JSON.parse(row.checkpoint).bilibiliRound.watched : Number(row.consumed_prefix) || 0,
          totalUnits: row.kind === 'bilibili' ? JSON.parse(row.checkpoint).bilibiliRound.watched : Number(row.total_units) || 0,
          artifactVersion: Number(row.artifact_version) || 0,
          // The closing instant the hook piggy-backs on must be *the same value* the live path
          // used, or the replay would mint a different (content-addressed) event. The finish
          // transition stamps `updated_at` with exactly the instant it passed to the hook.
          at: Number(row.updated_at) || Number(clock()),
        });
        if (written?.ok === true) {
          markP1EventWritten(scopeKey, row.activity_id);
          replayed.push(row.activity_id);
          if (replayed.length >= Math.max(1, limit)) break;
        }
      } catch (error) { noteError('p2-p1-compensate-failed', error?.message ?? String(error)); }
    }
    return { ok: true, replayed };
  }

  /**
   * Bounded outbox drain (one tick's worth).
   *
   * The `memory/ingest-request` chain is only real if something drains `memory_outbox`: the event
   * and the outbox row are written by the bridge consumer, but the delivery to the memory engine
   * happens in `drainOutbox`. Before this change nothing called it periodically, so experiences
   * would have accumulated as rows forever (and, with the legacy port switched off, silently).
   * The injected hook owns the memory engine, the writer identity and the `DRAIN_LOCKS` semantics;
   * this function only schedules it, bounds it and reports failures.
   */
  async function drainMemoryOnce() {
    if (!drainOutboxHook) return { ok: true, skipped: 'no-drainer' };
    if (disposed) return { ok: false, code: 'runtime-disposed' };
    try {
      const summary = await drainOutboxHook({ now: Number(clock()) });
      if (summary && summary.ok === false && summary.code && summary.code !== 'runtime-inactive') {
        noteError('p2-outbox-drain-refused', String(summary.code));
      }
      return summary ?? { ok: true };
    } catch (error) {
      noteError('p2-outbox-drain-failed', error?.message ?? String(error));
      return { ok: false, code: 'drain-failed' };
    }
  }

  async function compensateMemory({ scopeKey, limit = 2 } = {}) {
    // R3: with the P1 hook wired, the experience is an event, and the compensation that matters is
    // "did that event land?". The legacy port path is retired here on purpose — running both is
    // exactly the double write this review blocks.
    if (p1Hook) {
      const compensated = await compensateFinishedEvents({ scopeKey, limit });
      return { ...compensated, remembered: [], skipped: 'superseded-by-p1-hook' };
    }
    const remembered = [];
    let rememberedCount = 0;
    if (!memoryPort || config.p2?.activities?.enabled !== true) return { ok: true, remembered, skipped: 'port-unavailable' };
    let rows = [];
    try {
      // Read a wider window than `limit` and drop the already-remembered rows *here*: a
      // remembered activity must never consume the limit, or a third activity would starve
      // forever behind two remembered ones.
      rows = db.all(`SELECT activity_id FROM p2_activities
                     WHERE scope = ? AND status = 'done' AND reality = 'actual_tool_activity'
                       AND (consumed_prefix > 0 OR (artifact_hash <> '' AND artifact_version > 0))
                     ORDER BY updated_at ASC LIMIT ?`, scopeKey, Math.max(1, limit) * 10);
    } catch { return { ok: false, code: 'db-unavailable', remembered }; }
    for (const row of rows) {
      if (db.metaGet?.(`p2_memory_${row.activity_id}`, '') === '1') continue;
      try {
        const written = await recordExperience({ scopeKey, activityId: row.activity_id });
        if (written?.ok) {
          remembered.push(row.activity_id);
          rememberedCount += 1;
          if (rememberedCount >= Math.max(1, limit)) break;
        }
      } catch (error) { noteError('p2-memory-compensate-failed', error?.message ?? String(error)); }
    }
    return { ok: true, remembered };
  }

  /**
   * Async planning pass. A planning round may await the model, so it cannot live inside the
   * synchronous tick: the timer fires it, and tests drive it directly for determinism.
   */
  async function pumpPlanning({ now = Number(clock()), reason = 'timer' } = {}) {    if (disposed) return { ok: false, code: 'runtime-disposed', rounds: [] };
    if (!isActive() || getMode() !== 'active') return { ok: false, code: 'runtime-inactive', rounds: [] };
    if (config.p2?.planning?.enabled !== true) return { ok: false, code: 'planning-disabled', rounds: [] };
    let scopes = [];
    try { scopes = db.all('SELECT scope FROM scope_snapshots ORDER BY scope').map(row => row.scope); }
    catch { return { ok: false, code: 'runtime-off', rounds: [] }; }
    const rounds = [];
    for (const scopeKey of scopes) {
      if (disposed) break;
      try {
        let round = await planner.tick({ scopeKey, reason, now });
        // A worn-out day must not be a dead day: after the ordinary refusal, one supplement
        // attempt is allowed. The planner gate decides with zero model calls when the day is not
        // worn out, is before wakeHour, is capped, or has too little window left.
        if (round && round.code === 'plan-exists' && reason === 'timer') {
          try {
            const supplement = await planner.tick({ scopeKey, reason: 'supplement', now });
            if (supplement && supplement.code !== 'plan-exists') round = supplement;
          } catch (error) { noteError('p2-supplement-threw', error?.message ?? String(error)); }
        }
        rounds.push(round ?? null);
        if (round) {
          // Whitelist on purpose: the round carries the plan body, and diagnostics must never
          // serve it to the model or the page (P2-28 / review pass 2, B-2).
          lastTick.planning = {
            at: now, ok: round.ok === true, code: round.code ?? '', status: round.status ?? '',
            day: round.day ?? '', attempts: Number(round.attempts ?? 0),
            tokens: round.tokens ? { inputTokens: Number(round.tokens.inputTokens ?? 0), outputTokens: Number(round.tokens.outputTokens ?? 0) } : null,
          };
        }
      } catch (error) {
        const code = error?.code ?? 'plan-failed';
        noteError(`p2-${code}`, error?.message ?? String(error));
        rounds.push({ ok: false, code });
      }
    }
    return { ok: true, at: now, rounds };
  }

  /** One cheap background tick: planning request (bounded) + activity start/reconcile. */
  function tick({ reason = 'timer' } = {}) {
    const now = Number(clock());
    const out = { ok: true, at: now, reason, planning: null, activities: null };
    if (disposed) return { ok: false, code: 'runtime-disposed' };
    if (!isActive() || getMode() !== 'active') return { ok: false, code: 'runtime-inactive' };
    // P2 acts only on scopes that are already persisted and authorised, and it never invents
    // a scope from a synthetic session (same rule as H2).
    const scopes = db.all('SELECT scope FROM scope_snapshots ORDER BY scope').map(row => row.scope);
    for (const scopeKey of scopes) {
      if (disposed) break;
      try {
        if (config.p2?.planning?.enabled === true) {
          // The actual planning round is async (it may call the model): `pumpPlanning` runs it.
          out.planning = { deferred: true, scopeKey };
        }
        if (config.p2?.activities?.enabled === true) {
          out.activities = { deferred: true, reconcile: activities.reconcile() };
          lastTick.activities = { at: now, ...out.activities };
        }
        // P2.5-3B: share delivery is an async port call, so the tick only schedules it. The step is
        // also worth running when share is off but candidates are waiting — that is exactly when the
        // rows should become `gated/share-disabled` instead of pending forever.
        const waiting = Number(db.get("SELECT COUNT(*) AS n FROM p2_share_candidates WHERE scope = ? AND status = 'pending'", scopeKey)?.n ?? 0);
        if (config.p2?.share?.enabled === true || waiting > 0) out.share = { deferred: true, pending: waiting };
      } catch (error) {
        const code = error?.code ?? 'p2-tick-failed';
        noteError(`p2-${code}`, error?.message ?? String(error));
        out[code] = true;
      }
    }
    lastTick = { ...lastTick, at: now, reason };
    return out;
  }

  function startTimer() {
    if (timer || disposed) return;
    if (config.p2?.planning?.enabled !== true && config.p2?.activities?.enabled !== true && config.p2?.share?.enabled !== true) return;
    if (getMode() !== 'active') return;
    timer = setInterval(() => {
      try { tick({ reason: 'timer' }); } catch (error) { noteError('p2-tick-threw', error?.message ?? String(error)); }
      // Activity starts do real IO, so they run on their own async pass instead of inside the
      // synchronous planner tick; exactly one timer exists (amendment BLOCK-8).
      void pumpPlanning().catch(error => noteError('p2-plan-pump-threw', error?.message ?? String(error)));
      void pumpActivityExecution().catch(error => noteError('p2-exec-threw', error?.message ?? String(error)));
      void pumpActivityStarts().catch(error => noteError('p2-pump-threw', error?.message ?? String(error)));
      // P2.5-3B: the share hand-off is bounded (<=5 candidates per scope per pump).
      void pumpShareDelivery().catch(error => noteError('p2-share-pump-threw', error?.message ?? String(error)));
      // The memory outbox only becomes memories when somebody drains it; this tick is the
      // existing bounded background slot, so the drain rides here (R3). One drain at a time is
      // already guaranteed by `DRAIN_LOCKS` inside the bridge.
      void drainMemoryOnce().catch(error => noteError('p2-outbox-drain-threw', error?.message ?? String(error)));
    }, PLANNER_TICK_MS);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stopTimer() {
    if (!timer) return;
    try { clearInterval(timer); } catch { /* already gone */ }
    timer = null;
  }

  // ---- public API ----------------------------------------------------------------------
  function createShareCandidate({ scopeKey, activityId = '', kind = 'activity', title = '', body = '', sourceRef = '' } = {}) {
    if (config.p2?.share?.enabled !== true) return { ok: false, code: 'share-disabled' };
    if (!scopeKey || !title) return { ok: false, code: 'invalid-input' };
    const candidateId = `shr_${crypto.randomBytes(8).toString('hex')}`;
    const now = Number(clock());
    // Dedupe before opening the transaction: a same-activity candidate must not queue twice.
    const duplicate = db.get("SELECT candidate_id FROM p2_share_candidates WHERE scope = ? AND activity_id = ? AND kind = ? AND status = 'pending'", scopeKey, String(activityId ?? ''), String(kind ?? 'activity'));
    if (duplicate) return { ok: true, candidateId: duplicate.candidate_id, duplicate: true };
    db.tx(() => {
      db.assertLeaseHeld({ owner, generation, at: now });
      const pending = Number(db.get("SELECT COUNT(*) AS n FROM p2_share_candidates WHERE scope = ? AND status = 'pending'", scopeKey)?.n ?? 0);
      if (pending >= Number(config.p2.share.maxPending ?? 5)) throw new RuntimeError('share-queue-full', 'too many pending share candidates');
      db.run(`INSERT INTO p2_share_candidates (candidate_id, scope, activity_id, kind, title, body, source_ref, status, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        candidateId, scopeKey, activityId, kind, String(title).slice(0, 200), String(body).slice(0, 2000), sourceRef, now);
    });
    return { ok: true, candidateId };
  }

  function listShareCandidates({ scopeKey, status = 'pending', limit = 20 } = {}) {
    if (!scopeKey) return [];
    return db.all('SELECT candidate_id, activity_id, kind, title, body, source_ref, status, created_at FROM p2_share_candidates WHERE scope = ? AND status = ? ORDER BY created_at DESC LIMIT ?', scopeKey, status, Math.min(50, Number(limit) || 20));
  }

  /** Submit one candidate to the injected contact/share owner. P2 never sends anything. */
  async function submitShareCandidate({ scopeKey, candidateId } = {}) {
    if (config.p2?.share?.enabled !== true) return { ok: false, code: 'share-disabled' };
    const port = options.sharePort;
    if (!port || typeof port.submit !== 'function') return { ok: false, code: 'share-port-unavailable' };
    const row = db.get('SELECT * FROM p2_share_candidates WHERE candidate_id = ?', candidateId);
    if (!row) return { ok: false, code: 'candidate-not-found' };
    // A candidate can only ever be handed to the contact owner of its own scope.
    if (row.scope !== scopeKey) return { ok: false, code: 'scope-mismatch' };
    if (row.status !== 'pending') return { ok: false, code: 'candidate-not-pending', status: row.status };
    const acceptance = await port.submit({ scope: row.scope, candidateId: row.candidate_id, kind: row.kind, title: row.title, body: row.body, sourceRef: row.source_ref });
    const now = Number(clock());
    db.tx(() => {
      db.assertLeaseHeld({ owner, generation, at: now });
      db.run(`UPDATE p2_share_candidates SET status = ?, decision_at = ?, decision_reason = ? WHERE scope = ? AND candidate_id = ?`,
        acceptance?.ok ? 'submitted' : 'rejected', now, String(acceptance?.code ?? 'share-rejected').slice(0, 60), scopeKey, candidateId);
    });
    return { ok: true, accepted: acceptance?.ok === true, code: acceptance?.code ?? '', owner: 'contact' };
  }

  // ------------------------------------------------------------------ share gate classes
  //
  // task-42: a gated candidate used to be a **terminal** state, which silently threw the candidate
  // away. The gate's reasons are not one kind of thing, though:
  //
  //   retryable — the refusal is about *when*, not *whether*. Retrying later is exactly what a human
  //               would do, and dropping the candidate loses something the user might have wanted.
  //   terminal  — the refusal is about *whether*. Retrying would either be pointless or actively
  //               wrong (sending the same thing twice, or sharing while sharing is switched off).
  //
  // The table is explicit so a new reason cannot silently inherit "retry forever" or "drop it".
  const SHARE_GATE_RETRYABLE = Object.freeze({
    'quiet-hours': 'the contact owner is asleep — the same candidate is welcome after the window',
    quota: 'the daily allowance is spent; it resets, so tomorrow can still send it',
    cooldown: 'a minimum interval between shares; it elapses',
    'rate-limited': 'the contact side is throttling; waiting is the remedy',
    timeout: 'the answer did not arrive — unknown outcome, and memory-side dedupe makes a retry safe',
    'share-port-threw': 'the port raised before deciding; the same retry applies',
    'memory-timeout': 'a slow delivery, not a refusal',
    'share-sink-failed': 'our own sink could not write (disk/IO); the same candidate is welcome later',
    // P2.5-share: contact's gate really emits these strings (`share-port.ts` gateReasonOf <-
    // `evaluateOutboundBudget`), and they were missing here => a deferral was read as a refusal and
    // the candidate was dropped for good ("can send later" became "never sends"). One rule only:
    // a `defer` from the gate belongs here (wait), a `drop` belongs to the terminal table below.
    'cooldown:room': 'the room-level cooldown elapses',
    'cooldown:global': 'the global cooldown elapses',
    'quota:global': 'the daily global allowance resets tomorrow',
    'quota:room': 'the daily room allowance resets tomorrow',
    'settle:user-active': 'the user just spoke; waiting for this turn to finish is correct',
    'turn-running': 'this room already has a turn in flight',
    'tool-running': 'a tool is running; interjecting would break the rhythm',
    'backoff:unanswered': 'several unanswered messages: stop until the user comes back (streak resets)',
    'no-channel': 'OneBot is not connected; it will be again',
    'timezone-invalid': 'the configured zone is wrong; fixing it makes this sendable',
    disabled: 'the contact subsystem is off; switching it on makes this sendable',
    'not-due': 'the earliest allowed instant has not arrived yet',
  });
  const SHARE_GATE_TERMINAL = Object.freeze({
    'share-disabled': 'sharing is switched off: this is "no", not "not yet"',
    dedupe: 'this exact candidate was already queued/sent — retrying would duplicate it',
    'no-target': 'there is no owner to share with; that will not change by waiting',
    expired: 'the candidate outlived its usefulness',
    'share-port-unavailable': 'no contact owner is mounted; retrying cannot conjure one',
    'scope-mismatch': 'a programming error, not a transient condition',
  });
  const SHARE_MAX_ATTEMPTS = 8;
  const SHARE_CANDIDATE_TTL_MS = 7 * 24 * 3600 * 1000;

  const shareRetryKey = candidateId => `p2_share_retry:${String(candidateId ?? '')}`;

  /** Retry book for one candidate (zero migration: `runtime_meta`, next to the correction todos). */
  /**
   * round-8 review: one rotation key per scope grows without bound. Keep the newest 200 and drop the
   * rest — the state is one word per scope and losing it only costs one extra turn.
   */
  const ROTATION_KEY_LIMIT = 200;
  const ROTATION_PRUNE_INTERVAL_MS = 24 * 3600 * 1000;
  let lastRotationPruneAt = 0;
  /**
   * round-9 review: this used to run on **every** non-empty pump, and it swallowed its own errors. Two
   * costs: a `SCAN runtime_meta` + sort on the delivery path even when there was nothing to prune, and a
   * silent failure the caller could not report. It is throttled to once a day now, and it **throws** —
   * the caller already has a handler that records rotation problems.
   */
  function pruneRotationKeys({ force = false } = {}) {
    const at = Number(clock());
    if (!force && at - lastRotationPruneAt < ROTATION_PRUNE_INTERVAL_MS) return 0;
    lastRotationPruneAt = at;
    const rows = db.all("SELECT meta_key FROM runtime_meta WHERE meta_key LIKE 'p2_share_rotation:%' ORDER BY updated_at DESC") ?? [];
    if (rows.length <= ROTATION_KEY_LIMIT) return 0;
    let removed = 0;
    for (const row of rows.slice(ROTATION_KEY_LIMIT)) {
      db.run('DELETE FROM runtime_meta WHERE meta_key = ?', String(row.meta_key));
      removed += 1;
    }
    return removed;
  }

  function shareRetryState(candidateId) {
    try {
      const row = db.get('SELECT meta_value FROM runtime_meta WHERE meta_key = ?', shareRetryKey(candidateId));
      if (!row) return null;
      const parsed = JSON.parse(String(row.meta_value ?? '{}'));
      return {
        attempts: Math.max(0, Number(parsed.attempts) || 0),
        nextAttemptAt: Number(parsed.nextAttemptAt) || 0,
        expiresAt: Number(parsed.expiresAt) || 0,
        lastReason: String(parsed.lastReason ?? ''),
      };
    } catch { return null; }
  }

  function writeShareRetryState(candidateId, state) {
    try {
      db.run(`INSERT INTO runtime_meta (meta_key, meta_value, updated_at) VALUES (?, ?, ?)
              ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value, updated_at = excluded.updated_at`,
      shareRetryKey(candidateId), JSON.stringify(state), Number(clock()));
      return true;
    } catch (error) {
      // round-3 B6: a swallow here used to leave a row marked `gated` with **no retry index** — i.e.
      // permanently lost while looking retryable. The caller must know, so it can leave the row
      // pending instead of lying about its state.
      noteError('p2-share-retry-write-failed', error?.message ?? String(error));
      return false;
    }
  }

  function clearShareRetryState(candidateId) {
    try { db.run('DELETE FROM runtime_meta WHERE meta_key = ?', shareRetryKey(candidateId)); }
    catch { /* best effort */ }
  }

  /**
   * P2.5-3B: hand pending share candidates to the contact owner. **Bounded** (≤5 per call) and
   * honest about what a receipt means.
   *
   * The contact side (task-32) answers `ok:true` when the candidate is **stored in its own queue**.
   * That is not a send: the gate (quiet hours / quota / dedupe) has not necessarily run, and nothing
   * left the process. So this step records `queued` — never `sent`. A refusal becomes `gated` with
   * the contact's reason code, and `share-disabled` means the switch is off, not that the user has
   * nothing worth sharing.
   *
   * task-42: a **retryable** refusal (`quiet-hours`, `quota`, `cooldown`, …) is not a loss — the row
   * goes back into the eligible set after a backoff (same curve as the memory outbox: 30 s doubling,
   * capped at 30 min), and becomes `expired` only after `SHARE_MAX_ATTEMPTS` or its TTL. A terminal
   * refusal stays terminal.
   *
   * Idempotent by status: a row leaves `pending` on the first attempt, and only becomes selectable
   * again through the retry book, so a repeated tick cannot submit the same candidate twice.
   */
  async function deliverShareCandidates({ scopeKey = '', limit = 5 } = {}) {
    const max = Math.max(1, Math.min(5, Number(limit) || 5));
    const only = String(scopeKey ?? '');
    const now = Number(clock());
    const out = { ok: true, examined: 0, queued: 0, gated: 0, retryableGated: 0, terminalGated: 0, expired: 0, skipped: '', reasons: {} };

    // Eligible = still pending, or gated for a *retryable* reason whose backoff has elapsed.
    //
    // round-3 B6: `pending` used to take the whole quota first, so a permanently busy queue starved
    // every due `gated` row forever — and its TTL was only checked *after* being selected, so it
    // never even expired. The two sets now get **separate halves** of the quota and are merged
    // oldest-first, so neither class can be starved. `created_at` is selected too: the TTL is the
    // candidate's own age, not the moment this function happened to look at it.
    const half = max; // fetch up to the full quota; the fair split happens when merging
    const pendingRows = (only
      ? db.all(`SELECT candidate_id, scope, kind, title, body, source_ref, created_at FROM p2_share_candidates
                WHERE scope = ? AND status = 'pending' ORDER BY created_at ASC, candidate_id ASC LIMIT ?`, only, half)
      : db.all(`SELECT candidate_id, scope, kind, title, body, source_ref, created_at FROM p2_share_candidates
                WHERE status = 'pending' ORDER BY created_at ASC, candidate_id ASC LIMIT ?`, half)) ?? [];
    const rows = [...pendingRows];
    const dueGated = [];
    {
      // round-4 B10: gated rows used to be read only into `max - pending` slots, so a full queue of
      // pendings meant `remaining === 0` and **no** due gated row was ever looked at. Read them
      // independently (up to the full quota) and let the merge below decide.
      const retryKeys = db.all(`SELECT meta_key, meta_value FROM runtime_meta
                                 WHERE meta_key LIKE 'p2_share_retry:%' ORDER BY updated_at ASC`) ?? [];
      for (const key of retryKeys) {
        if (dueGated.length >= max) break;
        const candidateId = String(key.meta_key).slice('p2_share_retry:'.length);
        if (rows.some(row => row.candidate_id === candidateId)) continue;
        const state = shareRetryState(candidateId);
        if (!state || state.nextAttemptAt > now) continue;
        const row = db.get(`SELECT candidate_id, scope, kind, title, body, source_ref, status, created_at FROM p2_share_candidates
                            WHERE candidate_id = ?`, candidateId);
        if (!row || String(row.status) !== 'gated') continue;
        if (only && String(row.scope) !== only) continue;
        dueGated.push(row);
        if (dueGated.length >= half) break;
      }
    }
    // Oldest first across both classes: age decides which, the quota decides how many.
    const merged = [...rows, ...dueGated].sort((left, right) => (Number(left.created_at) || 0) - (Number(right.created_at) || 0));
    const chosen = merged.slice(0, max);
    // …but age alone is not enough fairness: if every pending is older than every due gated row, the
    // gated class would still wait for ever. With room for two selections, reserve **one** slot for a
    // due gated row that did not make the cut. With a single slot there is nothing to reserve, so the
    // two classes **rotate**: whoever was served last yields this tick (persisted, so it survives a
    // restart and a pod that only ever runs `limit: 1`).
    const gatedIds = new Set(dueGated.map(row => String(row.candidate_id)));
    const hasGatedSlot = chosen.some(row => gatedIds.has(String(row.candidate_id)));
    const rotationKey = `p2_share_rotation:${only || '*'}`;
    const lastServed = (() => {
      try { return String(db.metaGet?.(rotationKey, '') || ''); } catch { return ''; }
    })();
    if (max > 1) {
      if (!hasGatedSlot && gatedIds.size) {
        const oldestGated = merged.find(row => gatedIds.has(String(row.candidate_id)));
        if (oldestGated) {
          const tail = chosen.pop();
          chosen.push(oldestGated);
          void tail;
        }
      }
    } else if (gatedIds.size) {
      // One slot, two classes: **alternate**. If last tick served gated, this tick belongs to a
      // pending (when there is one), and vice versa — so neither class can be starved, whichever
      // one happens to be older.
      const oldestGated = merged.find(row => gatedIds.has(String(row.candidate_id)));
      const oldestPending = merged.find(row => !gatedIds.has(String(row.candidate_id)));
      if (lastServed === 'gated' && oldestPending) {
        chosen.length = 0;
        chosen.push(oldestPending);
      } else if (lastServed !== 'gated' && oldestGated) {
        chosen.length = 0;
        chosen.push(oldestGated);
      }
    }
    // Record which class actually got the slot, so the next tick can hand it to the other one.
    // Only when something **was** selected: an empty tick says nothing about fairness, and writing it
    // would silently flip the next turn.
    if (chosen.length) {
      try {
        const servedClass = chosen.some(row => gatedIds.has(String(row.candidate_id))) ? 'gated' : 'pending';
        db.metaSet?.(rotationKey, servedClass);
        pruneRotationKeys();
      } catch (error) {
        // Not fatal (a delivery must not fail on a bookkeeping write) but no longer silent.
        noteError('p2-share-rotation-write-failed', error?.message ?? String(error));
      }
    }
    rows.length = 0;
    rows.push(...chosen);
    out.examined = rows.length;
    if (!rows.length) return out;

    // Share switched off: do **not** call the owner, and this refusal is terminal by definition.
    if (config.p2?.share?.enabled !== true) {
      db.tx(() => {
        db.assertLeaseHeld({ owner, generation, at: now });
        for (const row of rows) {
          db.run(`UPDATE p2_share_candidates SET status = 'gated', decision_at = ?, decision_reason = ?
                  WHERE scope = ? AND candidate_id = ? AND status IN ('pending','gated')`,
          now, 'share-disabled', row.scope, row.candidate_id);
        }
      });
      for (const row of rows) clearShareRetryState(row.candidate_id);
      out.gated = rows.length;
      out.terminalGated = rows.length;
      out.skipped = 'share-disabled';
      out.reasons['share-disabled'] = rows.length;
      return out;
    }

    const port = options.sharePort;
    if (!port || typeof port.submit !== 'function') {
      db.tx(() => {
        db.assertLeaseHeld({ owner, generation, at: now });
        for (const row of rows) {
          db.run(`UPDATE p2_share_candidates SET status = 'gated', decision_at = ?, decision_reason = ?
                  WHERE scope = ? AND candidate_id = ? AND status IN ('pending','gated')`,
          now, 'share-port-unavailable', row.scope, row.candidate_id);
        }
      });
      for (const row of rows) clearShareRetryState(row.candidate_id);
      out.gated = rows.length;
      out.terminalGated = rows.length;
      out.skipped = 'share-port-unavailable';
      out.reasons['share-port-unavailable'] = rows.length;
      return out;
    }

    for (const row of rows) {
      let answer = null;
      try {
        answer = await port.submit({
          scope: row.scope,
          candidateId: row.candidate_id,
          kind: row.kind,
          title: row.title,
          body: row.body,
          sourceRef: row.source_ref,
        });
      } catch (error) {
        answer = { ok: false, code: error?.code ?? 'share-port-threw' };
      }
      const accepted = answer?.ok === true;
      const reason = String(accepted ? 'contact-queued' : (answer?.code ?? 'share-rejected')).slice(0, 60);
      const at = Number(clock());

      if (accepted) {
        try {
          db.tx(() => {
            db.assertLeaseHeld({ owner, generation, at });
            db.run(`UPDATE p2_share_candidates SET status = 'queued', decision_at = ?, decision_reason = ?
                    WHERE scope = ? AND candidate_id = ? AND status IN ('pending','gated')`,
            at, reason, row.scope, row.candidate_id);
          });
        } catch (error) { noteError('p2-share-mark-failed', error?.message ?? String(error)); continue; }
        clearShareRetryState(row.candidate_id);
        out.queued += 1;
        continue;
      }

      const retryable = Object.hasOwn(SHARE_GATE_RETRYABLE, reason);
      const previous = shareRetryState(row.candidate_id);
      const attempts = (previous?.attempts ?? 0) + 1;
      const expiresAt = previous?.expiresAt || (Number(row.created_at ?? 0) || at) + SHARE_CANDIDATE_TTL_MS;
      const exhausted = retryable && (attempts >= SHARE_MAX_ATTEMPTS || at >= expiresAt);
      if (retryable && !exhausted) {
        // Back in the eligible set after a backoff — the same curve the memory outbox uses.
        const nextAttemptAt = at + retryBackoffMs(attempts);
        const bookWritten = writeShareRetryState(row.candidate_id, { attempts, nextAttemptAt, expiresAt, lastReason: reason });
        if (!bookWritten) {
          // round-3 B6: without the retry book there is no index that would ever select this row
          // again, so marking it `gated` would be a lie. Leave it `pending` — the next tick retries
          // it — and say so in the counters.
          out.reasons['retry-book-failed'] = (out.reasons['retry-book-failed'] ?? 0) + 1;
          out.retryBookFailed = (out.retryBookFailed ?? 0) + 1;
          continue;
        }
        try {
          db.tx(() => {
            db.assertLeaseHeld({ owner, generation, at });
            db.run(`UPDATE p2_share_candidates SET status = 'gated', decision_at = ?, decision_reason = ?
                    WHERE scope = ? AND candidate_id = ? AND status IN ('pending','gated')`,
            at, reason, row.scope, row.candidate_id);
          });
        } catch (error) { noteError('p2-share-mark-failed', error?.message ?? String(error)); continue; }
        out.gated += 1;
        out.retryableGated += 1;
        out.reasons[reason] = (out.reasons[reason] ?? 0) + 1;
        continue;
      }

      // Terminal (or exhausted retryable): record why, and keep the reason greppable.
      const finalStatus = exhausted ? 'expired' : 'gated';
      const finalReason = exhausted ? `expired:${reason}`.slice(0, 60) : reason;
      try {
        db.tx(() => {
          db.assertLeaseHeld({ owner, generation, at });
          db.run(`UPDATE p2_share_candidates SET status = ?, decision_at = ?, decision_reason = ?
                  WHERE scope = ? AND candidate_id = ? AND status IN ('pending','gated')`,
          finalStatus, at, finalReason, row.scope, row.candidate_id);
        });
      } catch (error) { noteError('p2-share-mark-failed', error?.message ?? String(error)); continue; }
      clearShareRetryState(row.candidate_id);
      out.gated += 1;
      if (exhausted) out.expired += 1;
      out.terminalGated += 1;
      out.reasons[reason] = (out.reasons[reason] ?? 0) + 1;
    }
    return out;
  }

  /** The async pump slot for share delivery (the tick itself must stay synchronous). */
  async function pumpShareDelivery() {
    if (disposed) return { ok: false, code: 'runtime-disposed' };
    const scopes = db.all('SELECT scope FROM scope_snapshots ORDER BY scope').map(row => row.scope);
    const result = { ok: true, scopes: 0, queued: 0, gated: 0, expired: 0, reasons: {} };
    for (const scopeKey of scopes) {
      if (disposed) break;
      try {
        const one = await deliverShareCandidates({ scopeKey, limit: 5 });
        result.scopes += 1;
        result.queued += one.queued;
        result.gated += one.gated;
        // P2.5-share: an expiry must not evaporate inside this return value (CONTRACT §13.11.4).
        // The only caller used to be `void pumpShareDelivery().catch(...)`, i.e. nobody read it.
        result.expired += Number(one.expired) || 0;
        for (const [reason, count] of Object.entries(one.reasons ?? {})) {
          result.reasons[reason] = (result.reasons[reason] ?? 0) + Number(count || 0);
        }
        if (Number(one.expired) > 0) {
          noteError('p2-share-candidate-expired', `scope=${scopeKey} expired=${one.expired} reasons=${JSON.stringify(one.reasons ?? {})}`);
        }
      } catch (error) { noteError('p2-share-delivery-failed', error?.message ?? String(error)); }
    }
    lastTick = { ...lastTick, share: result };
    return result;
  }

  /** Withdraw a pending candidate: P2 stops offering it, contact never sees it. */
  function withdrawShareCandidate({ scopeKey, candidateId, reason = '' } = {}) {
    if (!scopeKey || !candidateId) return { ok: false, code: 'invalid-input' };
    const now = Number(clock());
    return db.tx(() => {
      db.assertLeaseHeld({ owner, generation, at: now });
      const row = db.get('SELECT status FROM p2_share_candidates WHERE scope = ? AND candidate_id = ?', scopeKey, candidateId);
      if (!row) return { ok: false, code: 'candidate-not-found' };
      if (row.status !== 'pending') return { ok: false, code: 'candidate-not-pending', status: row.status };
      db.run("UPDATE p2_share_candidates SET status = 'withdrawn', decision_at = ?, decision_reason = ? WHERE scope = ? AND candidate_id = ?", now, String(reason).slice(0, 60), scopeKey, candidateId);
      return { ok: true, status: 'withdrawn' };
    });
  }

  /**
   * Memory write for a finished actual activity, only through the injected public entry.
   *
   * Fail-closed on four independent conditions (review pass 2, B-4): the activity must be
   * `done`, it must carry evidence (consumed text or a versioned artifact), it must have an
   * ok receipt, and each activity may be remembered at most once. Without these a running,
   * abandoned or empty activity could write an irreversible "she read it" memory.
   */
  async function recordExperience({ scopeKey, activityId, allowLegacy = false } = {}) {
    const row = db.get('SELECT * FROM p2_activities WHERE scope = ? AND activity_id = ?', scopeKey, activityId);
    if (!row) return { ok: false, code: 'activity-not-found' };
    if (row.reality !== 'actual_tool_activity') return { ok: false, code: 'simulated-not-remembered', reality: row.reality };
    if (row.status !== 'done') return { ok: false, code: 'activity-not-done', status: row.status };
    const evidenced = Number(row.consumed_prefix) > 0 || (String(row.artifact_hash ?? '') !== '' && Number(row.artifact_version) > 0);
    if (!evidenced) return { ok: false, code: 'no-evidence' };
    const receipt = db.get("SELECT receipt_id FROM p2_activity_receipts WHERE activity_id = ? AND ok = 1 AND operation IN ('finish','step') LIMIT 1", activityId);
    if (!receipt) return { ok: false, code: 'no-receipt' };
    const rememberedKey = `p2_memory_${row.activity_id}`;
    if (db.metaGet?.(rememberedKey, '') === '1') return { ok: false, code: 'already-remembered' };
    // P2.5 (Codex round-2 §二.5): while the P1 hook is wired this path would be a *second*
    // experience with a different idempotency key, so it refuses explicitly instead of silently
    // double-writing. It sits **after** the eligibility checks on purpose: `simulated-not-remembered`
    // and the other named refusals must keep their own reasons (the reality red line stays
    // diagnosable), and only a genuinely-legacy *usable* write hits the bypass guard.
    // `allowLegacy` exists for diagnostics only and has to be asked for on purpose.
    if (p1Hook && allowLegacy !== true) {
      return { ok: false, code: 'superseded-by-p1-hook', hook: 'memory/ingest-request' };
    }
    if (!memoryPort || typeof memoryPort.recordExperience !== 'function') return { ok: false, code: 'memory-port-unavailable' };
    // Codex review R6: this is an **external side effect** (a memory write), so the writer fence
    // has to be checked *before* the call. The check further down (when marking the meta) is after
    // the fact and cannot undo a write that already happened.
    try {
      db.assertLeaseValid({ owner, generation, at: Number(clock()), requireRow: true });
    } catch (error) {
      const code = String(error?.code ?? 'lease-lost');
      noteError('p2-memory-lease-fence', `${code}: refusing to write memory without the writer lease`);
      return { ok: false, code };
    }
    const written = await memoryPort.recordExperience({
      // The frozen tuple (contract v1.2 §5): a real activity id, the closing operation and the
      // exact coverage. The port derives its dedupe key from these, so a retry after a crash
      // reproduces the same key instead of a second memory.
      scopeKey, activityId: row.activity_id, operation: 'finish', reality: row.reality,
      kind: row.kind, target: row.target, sourceRef: row.source_ref, sourceHash: row.source_hash,
      consumedFrom: 0, consumedTo: Number(row.consumed_prefix), consumed: Number(row.consumed_prefix),
      artifactRef: row.artifact_ref, artifactVersion: Number(row.artifact_version), artifactHash: row.artifact_hash,
      at: Number(row.updated_at) || Number(clock()),
    });
    if (written?.ok) {
      try {
        db.tx(() => {
          db.assertLeaseHeld({ owner, generation, at: Number(clock()) });
          db.metaSet(rememberedKey, '1');
        });
      } catch (error) { noteError('p2-memory-mark-failed', error?.message ?? String(error)); }
    }
    return written;
  }

  function status({ scopeKey } = {}) {
    // Close issued-but-unsettled reservations so a lost lease cannot hold the day's quota.
    if (scopeKey) { try { budget.sweep({ scope: scopeKey }); } catch { /* lease not held: next writer sweeps */ } }
    const planningPaused = db.metaGet?.('p2_planning_paused', '0') === '1' || config.p2?.planning?.paused === true;
    const activitiesPaused = db.metaGet?.('p2_activities_paused', '0') === '1' || config.p2?.activities?.paused === true;
    let plan = null;
    let slots = [];
    let pendingShare = 0;
    let shareCounts = {};
    let shareExpired = {};
    let shareExpiredReasons = [];
    let shareDropReasons = [];
    let sharePending = {};
    let running = 0;
    let counts = { activities: 0, done: 0, failed: 0, paused: 0 };
    try {
      if (scopeKey) {
        plan = db.get(`SELECT plan_id, day, version, status, time_zone, window_start, window_end, summary, committed_at
                       FROM p2_plans WHERE scope = ? AND status IN ('committed','empty') ORDER BY version DESC LIMIT 1`, scopeKey) ?? null;
        if (plan) slots = db.all('SELECT slot_id, start_at, end_at, kind, activity, title, flexibility, status FROM p2_plan_slots WHERE plan_id = ? ORDER BY start_at', plan.plan_id);
        pendingShare = Number(db.get("SELECT COUNT(*) AS n FROM p2_share_candidates WHERE scope = ? AND status = 'pending'", scopeKey)?.n ?? 0);
        // P2.5-share (CONTRACT §13.11.4): an expired or dropped candidate must be visible.
        // Zero migration: everything below is computed from the rows that already exist.
        shareCounts = Object.fromEntries((db.all('SELECT status, COUNT(*) AS n FROM p2_share_candidates WHERE scope = ? GROUP BY status', scopeKey) ?? [])
          .map(row => [String(row.status), Number(row.n) || 0]));
        shareExpired = db.get("SELECT COUNT(*) AS n, MAX(decision_at) AS last FROM p2_share_candidates WHERE scope = ? AND status = 'expired'", scopeKey) ?? {};
        shareExpiredReasons = db.all("SELECT decision_reason AS reason, COUNT(*) AS n, MAX(decision_at) AS last FROM p2_share_candidates WHERE scope = ? AND status = 'expired' GROUP BY decision_reason ORDER BY n DESC LIMIT 8", scopeKey) ?? [];
        shareDropReasons = db.all("SELECT status, decision_reason AS reason, COUNT(*) AS n, MAX(decision_at) AS last FROM p2_share_candidates WHERE scope = ? AND status IN ('gated','rejected','withdrawn','expired') GROUP BY status, decision_reason ORDER BY n DESC LIMIT 12", scopeKey) ?? [];
        sharePending = db.get("SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM p2_share_candidates WHERE scope = ? AND status = 'pending'", scopeKey) ?? {};
        running = Number(db.get("SELECT COUNT(*) AS n FROM p2_activities WHERE scope = ? AND status = 'running'", scopeKey)?.n ?? 0);
        counts = {
          activities: Number(db.get('SELECT COUNT(*) AS n FROM p2_activities WHERE scope = ?', scopeKey)?.n ?? 0),
          done: Number(db.get("SELECT COUNT(*) AS n FROM p2_activities WHERE scope = ? AND status = 'done'", scopeKey)?.n ?? 0),
          failed: Number(db.get("SELECT COUNT(*) AS n FROM p2_activities WHERE scope = ? AND status = 'failed'", scopeKey)?.n ?? 0),
          paused: Number(db.get("SELECT COUNT(*) AS n FROM p2_activities WHERE scope = ? AND status = 'paused'", scopeKey)?.n ?? 0),
        };
      }
    } catch (error) {
      noteError('p2-status-failed', error?.message ?? String(error));
    }
    const capabilities = capabilitiesFor(scopeKey);
    return {
      planning: {
        enabled: config.p2?.planning?.enabled === true,
        paused: planningPaused,
        state: config.p2?.planning?.enabled !== true ? 'disabled' : planningPaused ? 'paused' : getMode() === 'active' ? 'idle' : getMode(),
        pendingLoad: false,
        lastRun: planner.status?.() ?? null,
        plan: plan ? {
          planId: plan.plan_id, day: plan.day, version: Number(plan.version), status: plan.status,
          windowStart: Number(plan.window_start), windowEnd: Number(plan.window_end),
          // Bounded on purpose: diagnostics never carry plan bodies (P2-28).
          summary: String(plan.summary ?? '').slice(0, 120),
          slots: slots.map(slot => ({
            slotId: slot.slot_id, startAt: Number(slot.start_at), endAt: Number(slot.end_at), minutes: Math.round((Number(slot.end_at) - Number(slot.start_at)) / 60000),
            kind: slot.kind, activity: slot.activity, title: slot.title, flexibility: slot.flexibility, status: slot.status,
          })),
        } : null,
      },
      activities: {
        enabled: config.p2?.activities?.enabled === true,
        paused: activitiesPaused,
        state: config.p2?.activities?.enabled !== true ? 'disabled' : activitiesPaused ? 'paused' : running > 0 ? 'running' : 'idle',
        pendingLoad: false,
        running,
        counts,
        lastStart,
        reconcile: activities.status?.().reconcile ?? null,
        // P2.5 observability (CONTRACT §15.1). A metrics block, not a status: `available:false`
        // and `null` fields when the scope is unknown or a query failed, so an operator never
        // reads a broken read as a healthy zero.
        dispatch: (() => {
          try { return dispatchMetrics({ scopeKey: scopeKey ?? '' }); }
          catch (error) {
            noteError('p2-dispatch-metrics-failed', error?.message ?? String(error));
            return { available: false, code: 'metrics-failed', slots_due: null, slots_claimable: null, dispatch_lag_ms: null, claim_age_ms: null, claim_age_source: 'unavailable' };
          }
        })(),
      },
      budget: budget.status({ scope: scopeKey }),
      capabilities,
      capabilityText: describeCapabilities(capabilities).text,
      share: {
        enabled: config.p2?.share?.enabled === true,
        pending: pendingShare,
        owner: 'contact',
        port: options.sharePort ? 'mounted' : 'unavailable',
        // A status outside the frozen vocabulary (typically somebody renaming queued → sent) must
        // be shouted about, not silently folded into a total.
        counts: shareCounts,
        expired: {
          count: Number(shareExpired.n) || 0,
          lastAt: Number(shareExpired.last) || 0,
          reasons: (shareExpiredReasons ?? []).map(row => ({
            reason: String(row.reason ?? '').replace(/^expired:/, ''),
            count: Number(row.n) || 0,
            lastAt: Number(row.last) || 0,
          })),
        },
        dropped: {
          reasons: (shareDropReasons ?? []).map(row => ({
            state: String(row.status), reason: String(row.reason ?? ''), count: Number(row.n) || 0, lastAt: Number(row.last) || 0,
          })),
        },
        pendingOldestAgeMs: Number(sharePending.oldest) ? Math.max(0, Number(clock()) - Number(sharePending.oldest)) : null,
        // `queued` only proves "the candidate entered the contact ledger"; after the TTL contact may
        // have expired it and this row would not change. Runtime never knows "the user saw it".
        contactAckAfterQueued: 'unknown',
        sent: 'not-wired',
      },
      autonomy: { scopeAcknowledged: Number(config.p2?.autonomy?.scopeAcknowledgedAt ?? 0) > 0, allowedSources: config.p2?.autonomy?.allowedSources ?? [] },
      lastTick,
    };
  }

  return {
    handlers,
    budget,
    planner,
    activities,
    tick,
    pumpPlanning,
    pump: pumpActivityStarts,
    pumpExecution: pumpActivityExecution,
    // P2.5-1 heartbeat hooks (read + claim only; execution stays with the pump above).
    dueSlotsForHeartbeat,
    claimSlotForHeartbeat,
    // P2.5 observability (CONTRACT §15): the durable metrics and the zero-write dry watch.
    dispatchMetrics,
    dispatchWatch,
    compensateMemory,
    // R3: exposed so the host (and tests) can drive/observe the outbox drain deterministically;
    // the pump timer calls exactly this function.
    drainMemory: drainMemoryOnce,
    compensateFinishedEvents,
    // round-9: exposed so the daily sweep (and tests) can prune without waiting for the throttle.
    pruneRotationKeys,
    /**
     * round-5 review: the manual exit for marks whose activity row is gone. They are skipped by design
     * (a wrong revoke hands a remembered row to compensation), so without an evidenced override they
     * would be stuck for ever — "data that exists but can never be found".
     */
    reauditLegacy: input => {
      const scopeKey = typeof input?.scopeKey === 'string' ? input.scopeKey.trim() : '';
      if (!scopeKey) return { ok: false, code: 'invalid-scope' };
      const operator = String(input?.operator ?? '').trim();
      const evidence = String(input?.evidence ?? '').trim();
      if (!operator || !evidence) return { ok: false, code: 'operator-and-evidence-required' };
      const result = reauditLegacyMarks(scopeKey, {
        batch: input?.batch, includeUnowned: input?.includeUnowned === true, operator, evidence,
      });
      return { ok: true, ...result };
    },
    controlPlanSlot,
    start: startTimer,
    stop: stopTimer,
    dispose() { disposed = true; bilibiliAbort.abort(); stopTimer(); try { planner.dispose?.(); } catch { /* never surface */ } try { activities.dispose?.(); } catch { /* never surface */ } },
    pause,
    resume,
    status,
    capabilities: capabilitiesFor,
    createShareCandidate,
    listShareCandidates,
    submitShareCandidate,
    deliverShareCandidates,
    pumpShareDelivery,
    withdrawShareCandidate,
    recordExperience,
    callModel,
    get disposed() { return disposed; },
  };
}

export { PLANNER_KINDS, ACTIVITY_KINDS, applyPlanEvent, applyActivityEvent, scopeKeyOf, digest };
