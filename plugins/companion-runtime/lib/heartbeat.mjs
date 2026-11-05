import { RuntimeError } from './errors.mjs';
import { parseScope } from './scope.mjs';

/**
 * H2 zero-model rule heartbeat (CONTRACT §12.5, amended by §12.9 / A1).
 *
 * The heartbeat is a *business* loop over already-persisted, already-authorized
 * scopes. It owns no timer semantics of its own beyond a wake-up interval: every
 * decision is taken by a synchronous, injected-clock `cycle()` so tests never depend
 * on wall time and a slow host can never queue up overlapping rounds.
 *
 * Hard rules encoded here:
 *  - it never invents an identity: only keys already present in `scope_snapshots` are
 *    visited, and a scope key that does not parse back into a real scope is refused;
 *  - it never dispatches `agenda/occurrence-dispatched` (the agenda has no activity consumer
 *    in this round), so `agenda_occurrences` can never become `dispatched`;
 *  - **P2.5-1 (Slice A)**: when — and only when — an `activityDispatch` hook is injected, it
 *    may additionally *claim* P2 plan slots (`autonomy/plan-slot` `planned → started`). A claim
 *    is a single event append inside the scope transaction: the heartbeat still never calls a
 *    model, never runs an activity and never awaits anything. Execution stays with the P2 pump,
 *    which keeps `cycle()` synchronous and the single-flight guarantee intact;
 *  - one bounded transaction **per scope** (A1-B4): a transient failure rolls back that
 *    scope only, then a separate tiny transaction records exponential backoff;
 *  - every dispatched event carries a *deterministic* `occurredAt` (A1-B2: the
 *    instance's `scheduledAt`), so a retry hits the same content-addressed `eventId`
 *    instead of appending a second event that replay would have to reject;
 *  - an idle round writes nothing at all (no event, no queue row, no cursor churn);
 *  - `due` cannot grow without bound: instances older than `dueRetentionHours` are
 *    expired in a bounded batch every cycle (A1-B1).
 *
 * Diagnostics honesty: `lastAttemptAt` means "the loop ran", `lastSuccessAt` means "the
 * loop committed business progress" (at least one generation, due dispatch, catch-up skip
 * or retention expiry in that round) and `lastFailureAt`/`failures.lastCode` describe the
 * failing round. A round in which every selected scope failed therefore never advances
 * `lastSuccessAt`, so a health check cannot read a broken heartbeat as healthy.
 *
 * Dependency injection is deliberate: `agenda.mjs`, `events.mjs` and `index.mjs` are
 * not imported. The Lead wires the real agenda API, the real dispatch path and the
 * lease hooks, which keeps this module testable with fakes and free of import cycles.
 */

export const HEARTBEAT_CONSUMER = 'agenda';
export const PAUSED_KEY = 'heartbeat_paused';
export const PAUSE_REASON_KEY = 'heartbeat_pause_reason';

/** Bounded rejection map: a permanently failing item may never grow the cursor page. */
const REJECTION_LIMIT = 32;
/** Upper bound for the fairness scan (rotation needs more than one batch visible). */
const MAX_SCAN = 256;
const CATCHUP_REASON = 'outside-catchup-window';
const REPEATED_REJECTION = 'repeated-rejection';
const RETENTION_REASON = 'due-retention-elapsed';

/** Codes that mean "this worker may not commit at all": they abort the whole round. */
const GATE_CODES = new Set([
  'runtime-disposed', 'runtime-stopped', 'runtime-off', 'runtime-disabled', 'runtime-inactive',
  'heartbeat-paused', 'agenda-disabled', 'lease-lost', 'lease-expired', 'stale-generation', 'invalid-scope',
]);

/** Monotonic source used only for elapsed-time budgeting, never for scheduling. */
const monoNow = () => (typeof performance !== 'undefined' && typeof performance.now === 'function'
  ? performance.now()
  : Date.now());

class CycleSignal extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'CycleSignal';
    this.code = code;
  }
}

function clampInt(value, low, high, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(low, Math.min(high, Math.trunc(number)));
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function codeOf(error) {
  return typeof error?.code === 'string' && error.code ? error.code : 'heartbeat-failed';
}

function asInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function parseJsonObject(text, fallback) {
  if (typeof text !== 'string' || text === '') return fallback;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function optionalTimestamp(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : null;
}

/**
 * Create one heartbeat instance.
 *
 * @param {object} options
 * @param {object} options.db           open runtime DB handle (tx/get/all/run/assertLeaseHeld/…)
 * @param {object} options.config       whole runtime config (`config.heartbeat`, `config.agenda`)
 * @param {Function} [options.clock]    injected wall clock (epoch ms); `now` is accepted as an alias
 * @param {Function} [options.elapsed]  injected monotonic source for `maxTimeBudgetMs` (test hook)
 * @param {string} options.owner        writer lease owner (pid:…)
 * @param {string} options.generation   writer lease generation
 * @param {Function} options.dispatch   event dispatcher, same contract as `dispatchEvent`
 * @param {object} options.agenda       agenda query API (pure `planWindow` + bounded reads)
 * @param {Function} [options.onError]  `(code, detail)` observer for process-local diagnostics; it never runs
 *                                      inside a transaction and a throwing observer cannot break the loop
 * @param {Function} [options.isActive] mode gate hook
 * @param {Function} [options.isWritable] writer gate hook
 * @param {object|null} [options.activityDispatch] P2.5-1 slice A hook — `null` (the default)
 *        means "no downstream activity consumer", and the round then behaves exactly as it did
 *        before this slice (that is the rollback switch). When present it must expose
 *        `dueSlots({scopeKey, now, limit}) → { slots, deferred }` (pure read) and
 *        `claim({scopeKey, slotId, planId, day, scheduledAt}) → { ok, inserted?, seq?, code? }`
 *        (synchronous; it appends the `autonomy/plan-slot` claim).
 * @param {string|null} [options.activityDispatchDisabled] why the host withheld the hook, when it
 *        knows: `'disabled-by-config'` (the P2.5-1 gray switch or the activities switch is off).
 *        Reported as-is by `status().activityDispatch`, so "switched off" never reads as
 *        "unavailable".
 */
export function createHeartbeat(options = {}) {
  const db = options.db;
  if (!db) throw new RuntimeError('invalid-input', 'heartbeat requires an open runtime db handle');
  const dispatch = options.dispatch;
  if (typeof dispatch !== 'function') throw new RuntimeError('invalid-input', 'heartbeat requires a dispatch function');
  const agenda = options.agenda;
  if (!agenda || typeof agenda.planWindow !== 'function'
    || typeof agenda.activeAgendaItems !== 'function' || typeof agenda.dueAgendaOccurrences !== 'function') {
    throw new RuntimeError('invalid-input', 'heartbeat requires the agenda api (planWindow, activeAgendaItems, dueAgendaOccurrences)');
  }
  const config = options.config ?? {};
  const clock = typeof options.clock === 'function'
    ? options.clock
    : (typeof options.now === 'function' ? options.now : () => Date.now());
  const elapsed = typeof options.elapsed === 'function' ? options.elapsed : monoNow;
  const onError = typeof options.onError === 'function' ? options.onError : () => {};
  const isActive = typeof options.isActive === 'function' ? options.isActive : () => true;
  const isWritable = typeof options.isWritable === 'function' ? options.isWritable : () => true;
  const owner = options.owner ?? null;
  const generation = options.generation ?? null;
  if (!owner || !generation) throw new RuntimeError('invalid-input', 'heartbeat requires the writer owner and generation');
  // P2.5-1: the activity-dispatch hook. `null` is not "unwired by accident" — it is the
  // documented fail-closed state: no hook, no claim, and the round is byte-for-byte the round
  // this module produced before the slice. A hook that is present but malformed is a
  // configuration error and is reported as such instead of being half-used.
  const activityDispatch = options.activityDispatch ?? null;
  if (activityDispatch !== null
    && (typeof activityDispatch !== 'object' || typeof activityDispatch.dueSlots !== 'function' || typeof activityDispatch.claim !== 'function')) {
    throw new RuntimeError('invalid-input', 'activityDispatch must expose dueSlots() and claim()');
  }
  // Why no hook was injected, when the caller knows: `'disabled-by-config'` means the host
  // deliberately withheld it (the activities switch or the P2.5-1 gray switch is off), which is a
  // different fact from "this build has no downstream consumer at all" (`unavailable`). Diagnostics
  // must never merge the two, or a gray release left closed looks like a missing feature.
  const activityDispatchDisabled = typeof options.activityDispatchDisabled === 'string' && options.activityDispatchDisabled
    ? options.activityDispatchDisabled
    : null;

  const diagnostics = {
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastCycle: null,
    lastFailureAt: null,
    failures: { count: 0, lastCode: null, lastAt: null },
    committedScopes: 0,
    // P2.5 observability (CONTRACT §15.2): what the (c2) section decided on the last beat, per
    // process. This is *this* module's own fact — the heartbeat still never queries a P2 table
    // (§13.2) — and it is what `status().activityDispatchLastCycle` reports. `null` until a beat
    // has run: a fresh process has made no dispatch decision, and "0 claims" would be a claim.
    dispatchLastCycle: null,
  };

  let disposed = false;
  let halted = false;
  let inFlight = false;
  let timer = null;
  /** In-memory rotation for the fairness scan: idle scopes write nothing, so the
   *  persisted `updated_at` order alone could pin an empty scope to the front. */
  let scanOffset = 0;
  let pausedFlag = readPersistedPaused();
  let leaseRenewFailures = 0;

  function nowMs() {
    const value = Number(clock());
    return Number.isFinite(value) ? Math.trunc(value) : Date.now();
  }

  function heartbeatConfig() {
    const raw = config?.heartbeat ?? {};
    return {
      enabled: raw.enabled === true,
      pollIntervalMs: clampInt(raw.pollIntervalMs, 1000, 3600000, 60000),
      jitterMs: clampInt(raw.jitterMs, 0, 60000, 2500),
      maxScopesPerCycle: clampInt(raw.maxScopesPerCycle, 1, 64, 8),
      maxDueItemsPerCycle: clampInt(raw.maxDueItemsPerCycle, 1, 512, 64),
      maxNewOccurrencesPerCycle: clampInt(raw.maxNewOccurrencesPerCycle, 1, 512, 128),
      maxCatchupHorizonHours: clampInt(raw.maxCatchupHorizonHours, 1, 720, 24),
      maxAttempts: clampInt(raw.maxAttempts, 1, 20, 5),
      maxTimeBudgetMs: clampInt(raw.maxTimeBudgetMs, 50, 30000, 2000),
      dueRetentionHours: clampInt(raw.dueRetentionHours, 1, 720, 24),
      maxRetryBackoffMs: clampInt(raw.maxRetryBackoffMs, 5000, 86400000, 1800000),
      // P2.5-1: how many P2 plan slots one cycle may claim. 0 disables the (c2) section even
      // when a hook is injected. `activityConsumer` is still ignored on purpose: the agenda
      // never produces `agenda/occurrence-dispatched` (C5 §12.5.4), the P2 claim is a separate,
      // explicitly injected path.
      maxDispatchPerCycle: clampInt(raw.maxDispatchPerCycle, 0, 20, 1),
    };
  }

  function agendaConfig() {
    const raw = config?.agenda ?? {};
    return {
      enabled: raw.enabled === true,
      maxItemsPerScope: clampInt(raw.maxItemsPerScope, 1, 200, 64),
      generationHorizonHours: clampInt(raw.generationHorizonHours, 1, 720, 72),
      maxGeneratePerCall: clampInt(raw.maxGeneratePerCall, 1, 500, 64),
    };
  }

  function readMeta(key, fallback) {
    try {
      const value = db.metaGet(key, fallback);
      return value === null || value === undefined ? fallback : value;
    } catch {
      return fallback;
    }
  }

  function readPersistedPaused() {
    return readMeta(PAUSED_KEY, '0') === '1';
  }

  /** The persisted flag is the only authority (A1); the memory flag is a fallback for
   *  a temporarily unreadable database. `heartbeat_cursor.paused_at` drives nothing. */
  function isPaused() {
    try {
      return db.metaGet(PAUSED_KEY, null) === '1';
    } catch {
      return pausedFlag;
    }
  }

  function pausedReason() {
    if (!isPaused()) return '';
    const reason = readMeta(PAUSE_REASON_KEY, '');
    return typeof reason === 'string' ? reason : '';
  }

  function stopLatched() {
    try {
      return db.isStopped() === true;
    } catch {
      return true;
    }
  }

  // ---------------------------------------------------------------------------
  // cursor helpers
  // ---------------------------------------------------------------------------

  function readCursor(scopeKeyValue) {
    return db.get('SELECT scope, consumer, settled_until, page_anchor, event_seq, cycles, paused_at, updated_at FROM heartbeat_cursor WHERE scope = ? AND consumer = ?',
      scopeKeyValue, HEARTBEAT_CONSUMER) ?? null;
  }

  function readAnchor(cursor) {
    const parsed = parseJsonObject(cursor?.page_anchor, {});
    const rejections = parsed.rejections && typeof parsed.rejections === 'object' && !Array.isArray(parsed.rejections)
      ? parsed.rejections
      : {};
    return {
      scheduledAt: optionalTimestamp(parsed.scheduledAt),
      occurrenceId: typeof parsed.occurrenceId === 'string' && parsed.occurrenceId ? parsed.occurrenceId : null,
      rejections,
      lastError: typeof parsed.lastError === 'string' ? parsed.lastError : '',
      failures: asInteger(parsed.failures, 0),
      nextAttemptAt: optionalTimestamp(parsed.nextAttemptAt),
    };
  }

  /** Bounded, oldest-first eviction: the map keeps the most recent attempts only. */
  function bumpRejection(map, key) {
    const next = asInteger(map.get(key)) + 1;
    map.delete(key);
    if (map.size >= REJECTION_LIMIT) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
    map.set(key, next);
    return next;
  }

  function rejectionsToObject(map) {
    const out = {};
    for (const [key, value] of map) out[key] = value;
    return out;
  }

  function writeCursor(scopeKeyValue, { settledUntil, anchor, eventSeq, cycles, now }) {
    db.run(`INSERT INTO heartbeat_cursor (scope, consumer, settled_until, page_anchor, event_seq, cycles, paused_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, 0, ?)
            ON CONFLICT(scope, consumer) DO UPDATE SET
              settled_until = excluded.settled_until,
              page_anchor = excluded.page_anchor,
              event_seq = excluded.event_seq,
              cycles = excluded.cycles,
              updated_at = excluded.updated_at`,
      scopeKeyValue, HEARTBEAT_CONSUMER, settledUntil, JSON.stringify(anchor), eventSeq, cycles, now);
  }

  // ---------------------------------------------------------------------------
  // gates
  // ---------------------------------------------------------------------------

  /** Commit-time gate: re-checked *inside* every scope transaction (§12.5.2 / A1). */
  function assertScopeGates(now) {
    if (disposed || halted) throw new CycleSignal('runtime-stopped', 'heartbeat halted');
    db.assertLeaseHeld({ owner, generation, at: now });
    if (db.isStopped()) throw new CycleSignal('runtime-stopped', 'the runtime stop latch is set');
    if (isPaused()) throw new CycleSignal('heartbeat-paused', 'heartbeat paused during the cycle');
    if (!isActive()) throw new CycleSignal('runtime-inactive', 'the runtime is not active');
    if (!isWritable()) throw new CycleSignal('runtime-inactive', 'the runtime is not writable');
  }

  /**
   * Persisted fairness order (`heartbeat_cursor.updated_at ASC`, unseen scopes first),
   * bounded to `maxScopesPerCycle` picks. Scopes whose `nextAttemptAt` (exponential
   * backoff written by a failed scope, A1-B4) is still in the future are skipped, and
   * the scan continues so the batch still fills. The scan cap only exists so a rotating
   * start offset can be applied when there are more authorized scopes than one batch;
   * an entirely idle batch writes nothing, so without the rotation an empty scope could
   * hold the front of the queue forever.
   */
  function selectScopes(limitValue, now) {
    const cap = Math.min(MAX_SCAN, Math.max(limitValue, limitValue * 8));
    const rows = db.all(`SELECT s.scope AS scope, c.page_anchor AS page_anchor
                         FROM scope_snapshots s
                         LEFT JOIN heartbeat_cursor c ON c.scope = s.scope AND c.consumer = ?
                         ORDER BY COALESCE(c.updated_at, 0) ASC, s.scope ASC
                         LIMIT ?`, HEARTBEAT_CONSUMER, cap);
    if (!rows || rows.length === 0) return [];
    const eligible = [];
    let skippedForBackoff = 0;
    for (const row of rows) {
      const key = String(row?.scope ?? '');
      if (!key) continue;
      const anchor = readAnchor({ page_anchor: row.page_anchor });
      if (anchor.nextAttemptAt !== null && anchor.nextAttemptAt > now) {
        skippedForBackoff += 1;
        continue;
      }
      eligible.push(key);
    }
    if (eligible.length === 0) return [];
    const start = eligible.length > limitValue ? scanOffset % eligible.length : 0;
    const picked = [];
    for (let index = 0; index < Math.min(limitValue, eligible.length); index += 1) {
      picked.push(eligible[(start + index) % eligible.length]);
    }
    if (eligible.length > limitValue) scanOffset = (start + picked.length) % eligible.length;
    else if (skippedForBackoff > 0) scanOffset = (scanOffset + picked.length) % Math.max(1, eligible.length);
    return picked;
  }

  // ---------------------------------------------------------------------------
  // dispatch inspection
  // ---------------------------------------------------------------------------

  /**
   * Dispatch one event and classify the outcome.
   *
   * `dispatchEvent` may *return* a consumer failure instead of throwing. A
   * deterministic refusal (typed `RuntimeError`, event rolled back) is isolated and
   * quarantined; anything else is a temporary failure that must abort the scope
   * transaction so no watermark can move past an unprocessed item.
   */
  function dispatchChecked(event) {
    let outcome;
    try {
      outcome = dispatch(event);
    } catch (error) {
      throw error instanceof RuntimeError ? error : new RuntimeError(codeOf(error), messageOf(error));
    }
    if (!outcome || typeof outcome !== 'object') throw new RuntimeError('heartbeat-failed', 'dispatch returned no outcome');
    const results = Array.isArray(outcome.results) ? outcome.results : [];
    const failure = results.find(entry => entry && entry.error);
    if (failure && failure.deterministic !== true) {
      const code = typeof failure.code === 'string' && failure.code && failure.code !== 'internal' ? failure.code : 'consumer-failed';
      throw new RuntimeError(code, String(failure.error));
    }
    return {
      rejected: outcome.rejected === true || Boolean(failure),
      inserted: outcome.inserted === true,
      seq: asInteger(outcome.seq, 0),
    };
  }

  /**
   * The un-settled due batch, ordered `(scheduled_at, occurrence_id)`.
   *
   * The injected `dueAgendaOccurrences` also returns rows that are already `due` (the
   * frozen agenda query is `status IN ('scheduled','due')`). Those rows are settled for
   * this round — without an activity consumer they only leave through the retention
   * sweep — so letting them fill the batch limit would crowd un-settled instances out
   * of the window for up to `dueRetentionHours` (exactly the starvation A1-B1 removes).
   * When the API hands back any settled row we re-read the un-settled rows directly from
   * the frozen `agenda_occurrences` table instead.
   */
  function selectDueBatch(scopeKeyValue, now, limit) {
    const fromApi = agenda.dueAgendaOccurrences(db, { scopeKey: scopeKeyValue, at: now, limit });
    const batch = Array.isArray(fromApi) ? fromApi.slice(0, limit) : [];
    const settledMixed = batch.some(row => String(row?.status ?? 'scheduled') !== 'scheduled');
    if (!settledMixed) return batch;
    const rows = db.all(`SELECT occurrence_id, scheduled_at, revision, status FROM agenda_occurrences
                         WHERE scope = ? AND status = 'scheduled' AND scheduled_at <= ?
                         ORDER BY scheduled_at ASC, occurrence_id ASC LIMIT ?`, scopeKeyValue, now, limit);
    return (rows ?? []).map(row => ({
      occurrenceId: row.occurrence_id,
      scheduledAt: Number(row.scheduled_at),
      revision: Number(row.revision),
      status: row.status,
    }));
  }

  /** Existing slots must be known *before* generating (A1-B3), for every status. */
  function existingSlotKeys(scopeKeyValue, itemId) {
    if (typeof agenda.existingSlotKeys === 'function') {
      const provided = agenda.existingSlotKeys(scopeKeyValue, itemId);
      if (provided instanceof Set) return provided;
      if (Array.isArray(provided)) return new Set(provided.map(String));
      return new Set();
    }
    const rows = db.all('SELECT slot_key FROM agenda_occurrences WHERE scope = ? AND item_id = ?', scopeKeyValue, itemId);
    return new Set((rows ?? []).map(row => String(row.slot_key)));
  }

  // ---------------------------------------------------------------------------
  // one bounded scope batch
  // ---------------------------------------------------------------------------

  function runScope(scopeKeyValue, context) {
    const { now, hb, ag, cycleStart, state } = context;
    const scope = parseScope(scopeKeyValue);
    if (!scope) throw new CycleSignal('invalid-scope', `scope ${scopeKeyValue} is not a persisted identity key`);
    const totals = { generated: 0, due: 0, skipped: 0, rejected: 0, expired: 0, dispatched: 0, deferred: 0, remaining: 0, truncated: false, wrote: false };
    const overBudget = () => elapsed() - cycleStart > hb.maxTimeBudgetMs;

    db.tx(() => {
      assertScopeGates(now);

      const cursor = readCursor(scopeKeyValue);
      const anchor = readAnchor(cursor);
      const rejections = new Map(Object.entries(anchor.rejections));
      let maxSeq = asInteger(cursor?.event_seq, 0);
      let lastItem = null;
      let lastError = anchor.lastError;

      // (b) materialise bounded new instances for the generation horizon
      const horizonMs = ag.generationHorizonHours * 3600e3;
      const items = agenda.activeAgendaItems(db, { scopeKey: scopeKeyValue, at: now, limit: ag.maxItemsPerScope });
      const itemList = Array.isArray(items) ? items.slice(0, ag.maxItemsPerScope) : [];
      let generationStopped = false;
      for (const item of itemList) {
        if (state.generatedTotal >= hb.maxNewOccurrencesPerCycle) { totals.truncated = true; break; }
        if (overBudget()) { totals.truncated = true; break; }
        const itemId = String(item?.itemId ?? item?.id ?? '');
        if (!itemId) continue;
        const planned = agenda.planWindow({ item, from: now, to: now + horizonMs, limit: ag.maxGeneratePerCall, now });
        const slots = Array.isArray(planned) ? planned.slice(0, ag.maxGeneratePerCall) : [];
        if (slots.length === 0) continue;
        const existing = existingSlotKeys(scopeKeyValue, itemId);
        for (const slot of slots) {
          // `skipped`/`gap` entries are deliberate non-instances (DST gaps, exhausted
          // rules): generating them would invent an occurrence nobody asked for.
          if (!slot || slot.skipped === true || slot.resolution === 'gap') continue;
          const slotKey = String(slot.slotKey ?? '');
          if (!slotKey) continue;
          if (state.generatedTotal >= hb.maxNewOccurrencesPerCycle) { totals.truncated = true; generationStopped = true; break; }
          if (overBudget()) { totals.truncated = true; generationStopped = true; break; }
          const rejectionKey = `slot:${itemId}:${slotKey}`;
          if (asInteger(rejections.get(rejectionKey)) >= hb.maxAttempts) continue; // quarantined, not a blocker
          if (existing.has(slotKey)) continue;
          const scheduledAt = asInteger(slot.scheduledAt, 0);
          if (scheduledAt <= 0) continue;
          const outcome = dispatchChecked({
            kind: 'agenda/occurrence-generated',
            scope,
            // A1-B2: the instance instant is the deterministic `occurredAt`, never the
            // cycle clock — a retry must reproduce the same content-addressed eventId.
            occurredAt: scheduledAt,
            correlationId: `heartbeat:${HEARTBEAT_CONSUMER}`,
            payload: {
              itemId,
              slotKey,
              definitionRevision: asInteger(slot.definitionRevision, asInteger(item?.revision, 1)),
              scheduledAt,
              slotEndAt: Number.isFinite(Number(slot.slotEndAt)) ? Number(slot.slotEndAt) : null,
              resolution: typeof slot.resolution === 'string' ? slot.resolution : null,
            },
          });
          lastItem = { scheduledAt, occurrenceId: null };
          if (outcome.rejected) {
            totals.rejected += 1;
            bumpRejection(rejections, rejectionKey);
            lastError = 'occurrence-generated:rejected';
            continue;
          }
          if (outcome.inserted) {
            totals.generated += 1;
            state.generatedTotal += 1;
            maxSeq = Math.max(maxSeq, outcome.seq);
            existing.add(slotKey);
          }
        }
        if (generationStopped) break;
        if (state.generatedTotal >= hb.maxNewOccurrencesPerCycle) { totals.truncated = true; break; }
      }

      // (c) due batch, always re-queried by un-settled status (never a time watermark)
      const dueList = selectDueBatch(scopeKeyValue, now, hb.maxDueItemsPerCycle)
        .filter(entry => entry && entry.occurrenceId && String(entry.status ?? 'scheduled') === 'scheduled')
        .sort((left, right) => (asInteger(left.scheduledAt) - asInteger(right.scheduledAt))
          || String(left.occurrenceId).localeCompare(String(right.occurrenceId)));
      const catchupCutoff = now - hb.maxCatchupHorizonHours * 3600e3;
      for (const occurrence of dueList) {
        if (overBudget()) { totals.truncated = true; break; }
        const occurrenceId = String(occurrence.occurrenceId);
        // Re-read the row immediately before acting: a cancel or reschedule committed
        // between the batch query and this dispatch must never be dispatched as due.
        const fresh = db.get('SELECT status, revision, scheduled_at FROM agenda_occurrences WHERE occurrence_id = ? AND scope = ?',
          occurrenceId, scopeKeyValue);
        if (!fresh || fresh.status !== 'scheduled') continue;
        const scheduledAt = asInteger(fresh.scheduled_at, asInteger(occurrence.scheduledAt));
        const revision = asInteger(fresh.revision, 1);
        const outside = scheduledAt < catchupCutoff;
        const kind = outside ? 'agenda/occurrence-skipped' : 'agenda/occurrence-due';
        const payload = outside
          ? { occurrenceId, expectedRevision: revision, reasonCode: CATCHUP_REASON }
          : { occurrenceId, expectedRevision: revision, scheduledAt };
        const outcome = dispatchChecked({
          kind,
          scope,
          occurredAt: scheduledAt,
          correlationId: `heartbeat:${HEARTBEAT_CONSUMER}`,
          payload,
        });
        lastItem = { scheduledAt, occurrenceId };
        if (outcome.rejected) {
          totals.rejected += 1;
          const count = bumpRejection(rejections, occurrenceId);
          lastError = `${kind}:rejected`;
          if (count === hb.maxAttempts) {
            // Quarantine at the limit: one audit event, then the item stops being a
            // repeated cost without ever being silently dropped.
            const expired = dispatchChecked({
              kind: 'agenda/occurrence-expired',
              scope,
              occurredAt: scheduledAt,
              correlationId: `heartbeat:${HEARTBEAT_CONSUMER}`,
              payload: { occurrenceId, expectedRevision: revision, reasonCode: REPEATED_REJECTION },
            });
            if (expired.rejected) {
              lastError = 'occurrence-expired:rejected';
            } else {
              if (expired.inserted) {
                totals.expired += 1;
                maxSeq = Math.max(maxSeq, expired.seq);
              }
              rejections.delete(occurrenceId);
            }
          }
          continue;
        }
        rejections.delete(occurrenceId);
        if (outside) totals.skipped += 1;
        else totals.due += 1;
        if (outcome.inserted) maxSeq = Math.max(maxSeq, outcome.seq);
      }

      // (c2) P2 slot dispatch — the only place the heartbeat touches P2 (P2.5-1 / Slice A).
      //
      // Why here: this position is already inside the scope transaction, *after*
      // `assertScopeGates(now)` proved the full lease (owner + generation + expiry), and it has
      // `overBudget()` and the bounded `rejections` map available. A claim therefore commits or
      // rolls back with the agenda work of this scope, and a takeover cannot split the two.
      //
      // What it does: nothing but *claim* a due plan slot — one `autonomy/plan-slot`
      // `planned → started` append. No model, no IO, no await, no execution. The asynchronous
      // P2 pump starts the activity afterwards, so `cycle()` stays synchronous and single-flight.
      //
      // Honesty rules: every refusal is persisted with a reason (bounded, per item), a deferral is
      // named by the hook instead of being invented here, and a gate-level refusal aborts the
      // round rather than quarantining a slot that was never really attempted.
      //
      // CONTRACT §15.2: the round also *records* what it decided (`diagnostics.dispatchLastCycle`),
      // including the case where the section did not run at all. "The hook was never asked" and
      // "the hook was asked and had nothing due" are different facts, and only the decision record
      // can tell them apart after the fact.
      const dispatchDecision = {
        at: now,
        scope: scopeKeyValue,
        wired: Boolean(activityDispatch) && hb.maxDispatchPerCycle > 0,
        skipped: null,
        deferred: null,
        due: 0,
        claimed: 0,
        idempotent: 0,
        quarantined: 0,
        truncated: false,
        refused: [],
        code: '',
      };
      if (!activityDispatch) dispatchDecision.skipped = 'no-hook';
      else if (hb.maxDispatchPerCycle <= 0) dispatchDecision.skipped = 'cap-zero';
      else if (overBudget()) dispatchDecision.skipped = 'cycle-time-budget';

      if (activityDispatch && hb.maxDispatchPerCycle > 0 && !overBudget()) {
        let dueSlots = [];
        try {
          const batch = activityDispatch.dueSlots({ scopeKey: scopeKeyValue, now, limit: hb.maxDispatchPerCycle });
          if (batch && Array.isArray(batch.slots)) dueSlots = batch.slots;
          dispatchDecision.due = dueSlots.length;
          if (batch && typeof batch.deferred === 'string' && batch.deferred) {
            // A named deferral (chat priority, paused, disabled…) is a *skip*, never a failure:
            // the slot stays due and the reason is visible in `lastError` + `lastCycle`.
            totals.deferred += 1;
            lastError = `dispatch-deferred:${batch.deferred}`.slice(0, 120);
            dispatchDecision.deferred = batch.deferred;
            dispatchDecision.code = String(lastError);
            dueSlots = [];
            dispatchDecision.due = 0;
          }
        } catch (error) {
          throw error instanceof RuntimeError ? error : new RuntimeError(codeOf(error), messageOf(error));
        }
        for (const slot of dueSlots) {
          if (state.dispatchedTotal >= hb.maxDispatchPerCycle) { totals.truncated = true; dispatchDecision.truncated = true; break; }
          if (overBudget()) { totals.truncated = true; dispatchDecision.truncated = true; break; }
          const slotId = String(slot?.slotId ?? '');
          if (!slotId) continue;
          const rejectionKey = `dispatch:${slotId}`;
          if (asInteger(rejections.get(rejectionKey)) >= hb.maxAttempts) { dispatchDecision.quarantined += 1; continue; } // quarantined
          const claimed = activityDispatch.claim({
            scopeKey: scopeKeyValue,
            slotId,
            planId: String(slot.planId ?? ''),
            day: String(slot.day ?? ''),
            scheduledAt: asInteger(slot.startAt, 0),
          });
          if (!claimed || claimed.ok === false) {
            const code = typeof claimed?.code === 'string' && claimed.code ? claimed.code : 'claim-refused';
            // A gate refusal means this worker may not commit at all: abort and let the round's
            // normal backoff handle it. Anything else is this slot's problem, so it is
            // quarantined by count instead of being retried forever.
            if (GATE_CODES.has(code)) throw new RuntimeError(code, String(claimed?.error ?? 'the writer may not claim a P2 slot'));
            totals.rejected += 1;
            bumpRejection(rejections, rejectionKey);
            lastError = `slot-claim:${code}`.slice(0, 120);
            dispatchDecision.code = String(lastError);
            dispatchDecision.refused.push({ slotId, code: String(code).slice(0, 40) });
            if (dispatchDecision.refused.length > 5) dispatchDecision.refused.shift();
            continue;
          }
          rejections.delete(rejectionKey);
          // `inserted === false` means the identical claim already exists in the log (a retried
          // cycle): it is idempotent, not a second dispatch, so the counter must not move.
          if (claimed.inserted !== false) {
            totals.dispatched += 1;
            state.dispatchedTotal += 1;
            maxSeq = Math.max(maxSeq, asInteger(claimed.seq, 0));
            dispatchDecision.claimed += 1;
          } else {
            dispatchDecision.idempotent += 1;
          }
        }
      }
      diagnostics.dispatchLastCycle = dispatchDecision;

      // (d) bounded `due` retention: without an activity consumer, `due` would grow
      // forever, so instances older than `dueRetentionHours` expire here (A1-B1).
      if (hb.dueRetentionHours > 0 && !overBudget()) {
        const retentionCutoff = now - hb.dueRetentionHours * 3600e3;
        const stale = db.all(`SELECT occurrence_id, scheduled_at, revision FROM agenda_occurrences
                              WHERE scope = ? AND status = 'due' AND scheduled_at < ?
                              ORDER BY scheduled_at ASC, occurrence_id ASC LIMIT ?`,
          scopeKeyValue, retentionCutoff, hb.maxDueItemsPerCycle);
        for (const row of stale ?? []) {
          if (overBudget()) { totals.truncated = true; break; }
          const occurrenceId = String(row.occurrence_id);
          const scheduledAt = asInteger(row.scheduled_at, 0);
          if (scheduledAt <= 0) continue;
          const outcome = dispatchChecked({
            kind: 'agenda/occurrence-expired',
            scope,
            occurredAt: scheduledAt,
            correlationId: `heartbeat:${HEARTBEAT_CONSUMER}`,
            payload: { occurrenceId, expectedRevision: asInteger(row.revision, 1), reasonCode: RETENTION_REASON },
          });
          lastItem = { scheduledAt, occurrenceId };
          if (outcome.rejected) {
            totals.rejected += 1;
            lastError = 'occurrence-expired:rejected';
            continue;
          }
          rejections.delete(occurrenceId);
          if (outcome.inserted) {
            totals.expired += 1;
            maxSeq = Math.max(maxSeq, outcome.seq);
          }
        }
      }

      // (e) watermark: settle only what this batch actually drained
      const remainingRow = db.get("SELECT MIN(scheduled_at) AS next_at FROM agenda_occurrences WHERE scope = ? AND status = 'scheduled' AND scheduled_at <= ?",
        scopeKeyValue, now);
      const nextAt = remainingRow?.next_at === null || remainingRow?.next_at === undefined ? null : asInteger(remainingRow.next_at, 0);
      const remainingCount = db.get("SELECT COUNT(*) AS n FROM agenda_occurrences WHERE scope = ? AND status = 'scheduled' AND scheduled_at <= ?",
        scopeKeyValue, now);
      totals.remaining = asInteger(remainingCount?.n, 0);
      const previousSettled = asInteger(cursor?.settled_until, 0);
      // `dispatched` and `deferred` count as work for the *cursor* (a claim or a named deferral
      // is a real decision this round reached, and its reason must be persisted), but only
      // `dispatched` counts as business progress for `lastSuccessAt` in `cycle()` below.
      const worked = totals.generated + totals.due + totals.skipped + totals.rejected + totals.expired
        + totals.dispatched + totals.deferred > 0;
      if (!worked) {
        // Nothing was processed: the cursor must not churn per tick.
        return;
      }
      const settledCandidate = nextAt === null ? now : nextAt;
      const settledUntil = Math.max(previousSettled, settledCandidate);
      const anchorOut = {
        scheduledAt: lastItem?.scheduledAt ?? anchor.scheduledAt,
        occurrenceId: lastItem?.occurrenceId ?? anchor.occurrenceId,
        rejections: rejectionsToObject(rejections),
        lastError: lastError.slice(0, 120),
        // A successful scope round clears the backoff it may have accumulated.
        failures: 0,
        nextAttemptAt: null,
      };
      const eventSeq = Math.max(asInteger(cursor?.event_seq, 0), maxSeq);
      writeCursor(scopeKeyValue, {
        settledUntil,
        anchor: anchorOut,
        eventSeq,
        cycles: asInteger(cursor?.cycles, 0) + 1,
        now,
      });
      totals.wrote = true;
    });
    return totals;
  }

  /**
   * Failure bookkeeping in its own tiny transaction (A1-B4). The failed scope moves to
   * the back of the fairness order and gets exponential backoff; other scopes keep
   * their progress because their transactions already committed.
   */
  function recordScopeFailure(scopeKeyValue, { code, now, hb }) {
    db.tx(() => {
      const cursor = readCursor(scopeKeyValue);
      const anchor = readAnchor(cursor);
      const failures = asInteger(anchor.failures, 0) + 1;
      const exponent = Math.min(20, Math.max(0, failures - 1));
      const backoff = Math.min(hb.maxRetryBackoffMs, Math.max(1000, hb.pollIntervalMs * 2 ** exponent));
      writeCursor(scopeKeyValue, {
        settledUntil: asInteger(cursor?.settled_until, 0),
        anchor: {
          scheduledAt: anchor.scheduledAt,
          occurrenceId: anchor.occurrenceId,
          rejections: rejectionsToObject(new Map(Object.entries(anchor.rejections))),
          lastError: String(code).slice(0, 120),
          failures,
          nextAttemptAt: now + backoff,
        },
        eventSeq: asInteger(cursor?.event_seq, 0),
        cycles: asInteger(cursor?.cycles, 0),
        now,
      });
    });
  }

  // ---------------------------------------------------------------------------
  // cycle
  // ---------------------------------------------------------------------------

  function cycle(hooks = {}) {
    const reason = typeof hooks?.reason === 'string' && hooks.reason ? hooks.reason : 'manual';
    if (disposed) return { ok: false, code: 'runtime-disposed' };
    if (halted) return { ok: false, code: 'runtime-stopped' };
    if (inFlight) return { ok: false, code: 'single-flight' };
    const hb = heartbeatConfig();
    if (hb.enabled !== true) return { ok: false, code: 'heartbeat-disabled' };
    const ag = agendaConfig();
    if (ag.enabled !== true) return { ok: false, code: 'agenda-disabled' };
    if (!isActive()) return { ok: false, code: 'runtime-inactive' };
    if (!isWritable()) return { ok: false, code: 'runtime-inactive' };
    if (stopLatched()) return { ok: false, code: 'runtime-stopped' };
    if (isPaused()) return { ok: false, code: 'heartbeat-paused' };

    inFlight = true;
    const now = nowMs();
    const cycleStart = elapsed();
    const totals = { scopes: 0, generated: 0, due: 0, skipped: 0, rejected: 0, expired: 0, dispatched: 0, deferred: 0, remaining: 0, truncated: false };
    const state = { generatedTotal: 0, dispatchedTotal: 0 };
    const failures = [];
    let aborted = null;
    diagnostics.lastAttemptAt = now;
    try {
      let scopes = [];
      try {
        scopes = selectScopes(hb.maxScopesPerCycle, now);
      } catch (error) {
        aborted = { code: codeOf(error), error };
      }
      for (const scopeKeyValue of scopes) {
        if (aborted) break;
        if (elapsed() - cycleStart > hb.maxTimeBudgetMs) { totals.truncated = true; break; }
        try {
          const outcome = runScope(scopeKeyValue, { now, hb, ag, cycleStart, state });
          totals.scopes += 1;
          diagnostics.committedScopes += 1;
          totals.generated += outcome.generated;
          totals.due += outcome.due;
          totals.skipped += outcome.skipped;
          totals.rejected += outcome.rejected;
          totals.expired += outcome.expired;
          totals.dispatched += outcome.dispatched;
          totals.deferred += outcome.deferred;
          totals.remaining += outcome.remaining;
          if (outcome.truncated) { totals.truncated = true; break; }
        } catch (error) {
          const code = codeOf(error);
          if (GATE_CODES.has(code)) {
            aborted = { code, error };
            break;
          }
          // Per-scope transient failure: that scope rolled back, the others did not.
          failures.push(code);
          const at = nowMs();
          diagnostics.failures.count += 1;
          diagnostics.failures.lastCode = code;
          diagnostics.failures.lastAt = at;
          diagnostics.lastFailureAt = at;
          try {
            recordScopeFailure(scopeKeyValue, { code, now, hb });
          } catch (bookkeeping) {
            aborted = { code: codeOf(bookkeeping), error: bookkeeping };
            break;
          }
          try { onError(code, messageOf(error)); } catch { /* observer only, outside every transaction */ }
        }
      }
      // `lastSuccessAt` is the field a health check reads for "business progress happened",
      // so it advances only when the round actually committed a change (a generation, a due
      // dispatch, a catch-up skip, a retention expiry, or — since P2.5-1 — a P2 slot claim). A
      // round that committed nothing — because every selected scope failed, because everything
      // was deferred (chat priority, paused activities) or because there was genuinely nothing to
      // do — leaves it alone: `lastAttemptAt` is the "we tried" stamp, `lastFailureAt`/`failures`
      // is the failing round, and `lastCycle` describes the empty round (A1-B4).
      const committed = totals.generated + totals.due + totals.skipped + totals.expired + totals.dispatched > 0;
      if (!aborted && committed) diagnostics.lastSuccessAt = nowMs();
    } finally {
      inFlight = false;
      diagnostics.lastCycle = {
        at: now,
        scopes: totals.scopes,
        generated: totals.generated,
        due: totals.due,
        skipped: totals.skipped,
        rejected: totals.rejected,
        expired: totals.expired,
        dispatched: totals.dispatched,
        deferred: totals.deferred,
        remaining: totals.remaining,
        ms: Math.max(0, Math.round((elapsed() - cycleStart) * 100) / 100),
        truncated: totals.truncated === true,
      };
    }

    const result = {
      ok: !aborted,
      code: aborted ? aborted.code : 'ok',
      reason,
      scopes: totals.scopes,
      generated: totals.generated,
      due: totals.due,
      skipped: totals.skipped,
      rejected: totals.rejected,
      expired: totals.expired,
      dispatched: totals.dispatched,
      deferred: totals.deferred,
      remaining: totals.remaining,
      truncated: totals.truncated,
      failures,
      at: now,
    };
    if (aborted) {
      result.error = messageOf(aborted.error);
      try { onError(aborted.code, messageOf(aborted.error)); } catch { /* observer only */ }
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // pause / resume
  // ---------------------------------------------------------------------------

  function pause(reason = '') {
    if (disposed) return { ok: false, code: 'runtime-disposed' };
    const text = String(reason ?? '').slice(0, 120);
    try {
      const already = db.metaGet(PAUSED_KEY, '0') === '1';
      const sameReason = readMeta(PAUSE_REASON_KEY, '') === text;
      if (!already || !sameReason) {
        db.metaSet(PAUSED_KEY, '1');
        db.metaSet(PAUSE_REASON_KEY, text);
      }
      pausedFlag = true;
      return { ok: true, paused: true, reason: text };
    } catch (error) {
      return { ok: false, code: codeOf(error), error: messageOf(error) };
    }
  }

  function resume() {
    if (disposed) return { ok: false, code: 'runtime-disposed' };
    try {
      db.metaSet(PAUSED_KEY, '0');
      db.metaSet(PAUSE_REASON_KEY, '');
      pausedFlag = false;
      return { ok: true, paused: false };
    } catch (error) {
      return { ok: false, code: codeOf(error), error: messageOf(error) };
    }
  }

  // ---------------------------------------------------------------------------
  // wake-up timer (never business progress)
  // ---------------------------------------------------------------------------

  function start() {
    if (disposed) return { ok: false, code: 'runtime-disposed' };
    if (timer) return { ok: true, already: true, timer: 'running' };
    const hb = heartbeatConfig();
    const base = Math.max(1000, hb.pollIntervalMs);
    const jitter = hb.jitterMs > 0 ? Math.round((Math.random() * 2 - 1) * hb.jitterMs) : 0;
    const interval = Math.max(250, base + jitter);
    timer = setInterval(() => {
      try {
        const outcome = cycle({ reason: 'timer' });
        if (outcome.ok === false && outcome.error) {
          try { onError(outcome.code, outcome.error); } catch { /* observer only */ }
        }
      } catch (error) {
        try { onError(codeOf(error), messageOf(error)); } catch { /* a throwing cycle must never crash the process */ }
      }
    }, interval);
    if (typeof timer.unref === 'function') timer.unref();
    return { ok: true, timer: 'running', interval };
  }

  function stop() {
    if (timer) {
      try { clearInterval(timer); } catch { /* already gone */ }
      timer = null;
    }
    halted = true;
    return { ok: true, timer: 'stopped' };
  }

  function dispose() {
    if (disposed) return { ok: true, already: true };
    if (timer) {
      try { clearInterval(timer); } catch { /* already gone */ }
      timer = null;
    }
    halted = true;
    disposed = true;
    return { ok: true, timer: 'stopped' };
  }

  // ---------------------------------------------------------------------------
  // diagnostics
  // ---------------------------------------------------------------------------

  function leaseStatus() {
    const at = nowMs();
    let row = null;
    try { row = db.leaseRow(); } catch { row = null; }
    if (!row) return { state: 'none', expiresAt: null, valid: false, renewFailures: leaseRenewFailures };
    const mine = row.owner === owner && row.generation === generation;
    return {
      state: mine ? 'held' : 'held-elsewhere',
      expiresAt: Number.isFinite(Number(row.expiresAt)) ? Number(row.expiresAt) : null,
      valid: mine && Number(row.expiresAt) > at,
      renewFailures: leaseRenewFailures,
    };
  }

  function backlogStatus() {
    const at = nowMs();
    try {
      // `due` is a backlog too: without an activity consumer it only leaves through the
      // bounded retention sweep (A1-B1), so diagnostics must show it.
      const row = db.get(`SELECT COUNT(*) AS n, MIN(scheduled_at) AS oldest
                           FROM agenda_occurrences
                           WHERE status IN ('scheduled', 'due') AND scheduled_at <= ?
                             AND scope IN (SELECT scope FROM scope_snapshots)`, at);
      const oldest = row?.oldest === null || row?.oldest === undefined ? null : asInteger(row.oldest, 0);
      return {
        due: asInteger(row?.n, 0),
        oldestDueAt: oldest,
        backlogAgeMs: oldest === null ? null : Math.max(0, at - oldest),
      };
    } catch {
      return { due: 0, oldestDueAt: null, backlogAgeMs: null };
    }
  }

  function pageScan() {
    const at = nowMs();
    const out = { rejections: 0, retrying: 0, scopes: 0, settledUntilMin: null, eventSeqMax: null };
    try {
      const row = db.get(`SELECT COUNT(*) AS scopes, MIN(settled_until) AS settled_min, MAX(event_seq) AS seq_max
                          FROM heartbeat_cursor WHERE consumer = ?`, HEARTBEAT_CONSUMER);
      out.scopes = asInteger(row?.scopes, 0);
      out.settledUntilMin = row?.settled_min === null || row?.settled_min === undefined ? null : asInteger(row.settled_min, 0);
      out.eventSeqMax = row?.seq_max === null || row?.seq_max === undefined ? null : asInteger(row.seq_max, 0);
      const pages = db.all('SELECT page_anchor FROM heartbeat_cursor WHERE consumer = ? LIMIT ?', HEARTBEAT_CONSUMER, REJECTION_LIMIT);
      for (const page of pages ?? []) {
        const anchor = readAnchor({ page_anchor: page?.page_anchor });
        out.rejections += Object.keys(anchor.rejections).length;
        if (anchor.nextAttemptAt !== null && anchor.nextAttemptAt > at) out.retrying += 1;
      }
    } catch {
      /* a closed database must still answer with the defaults */
    }
    return out;
  }

  function recoveryState(scan) {
    if (scan.retrying > 0) return 'retry';
    if (diagnostics.lastFailureAt !== null && diagnostics.lastFailureAt > (diagnostics.lastSuccessAt ?? 0)) return 'retry';
    if (diagnostics.lastSuccessAt === null) return 'idle';
    return 'resumed';
  }

  function stateName(heartbeatEnabled, paused, scan) {
    if (disposed || halted) return 'stopped';
    if (!heartbeatEnabled) return 'disabled';
    if (paused) return 'paused';
    if (inFlight) return 'running';
    if (recoveryState(scan) === 'retry') return 'failing';
    if (!isActive() || !isWritable()) return 'inactive';
    return 'idle';
  }

  function status() {
    const hb = heartbeatConfig();
    const paused = isPaused();
    const scan = pageScan();
    return {
      enabled: hb.enabled,
      state: stateName(hb.enabled, paused, scan),
      registered: true,
      paused,
      pausedReason: pausedReason(),
      owner,
      generation,
      lease: leaseStatus(),
      lastAttemptAt: diagnostics.lastAttemptAt,
      lastSuccessAt: diagnostics.lastSuccessAt,
      lastFailureAt: diagnostics.lastFailureAt,
      lastCycle: diagnostics.lastCycle,
      backlog: backlogStatus(),
      cursor: {
        scopes: scan.scopes,
        settledUntilMin: scan.settledUntilMin,
        eventSeqMax: scan.eventSeqMax,
        rejections: scan.rejections,
      },
      failures: { ...diagnostics.failures },
      recovery: recoveryState(scan),
      // P2.5-1 honesty rule — three states, never merged:
      //   'wired'              a real hook is injected and the per-cycle cap allows a claim;
      //   'disabled-by-config' the host withheld the hook (P2.5-1 gray switch off / activities
      //                        off) or the cap is 0: a deliberate configuration decision;
      //   'unavailable'        nothing in this build can dispatch (no hook and no reason given).
      activityDispatch: activityDispatch && hb.maxDispatchPerCycle > 0
        ? 'wired'
        : (activityDispatch || activityDispatchDisabled ? 'disabled-by-config' : 'unavailable'),
      activityDispatchLimit: activityDispatch && hb.maxDispatchPerCycle > 0 ? hb.maxDispatchPerCycle : 0,
      // CONTRACT §15.2: the *measurement* next to the three-state status above. `null` means "this
      // process has not run a beat yet" — not "nothing was due". The durable slot metrics
      // (`slots_due`, `dispatch_lag_ms`, `claim_age_ms`) are not here on purpose: the heartbeat
      // owns no P2 table (§13.2). Read them from `p2Status().activities.dispatch`.
      activityDispatchLastCycle: diagnostics.dispatchLastCycle ? { ...diagnostics.dispatchLastCycle } : null,
      timer: timer ? 'running' : 'stopped',
    };
  }

  return {
    cycle,
    status,
    pause,
    resume,
    start,
    stop,
    dispose,
    isPaused,
    /** The renewal timer feeds this so diagnostics can tell "renewal fine" from "business fine". */
    noteLeaseRenewSuccess() {
      leaseRenewFailures = 0;
      return { ok: true, renewFailures: leaseRenewFailures };
    },
    noteLeaseRenewFailure(code = 'renew-failed') {
      leaseRenewFailures = Math.min(1000, leaseRenewFailures + 1);
      return { ok: false, code: String(code ?? 'renew-failed'), renewFailures: leaseRenewFailures };
    },
    get paused() { return isPaused(); },
    get timer() { return timer ? 'running' : 'stopped'; },
  };
}
