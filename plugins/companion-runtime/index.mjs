import crypto from 'node:crypto';
import path from 'node:path';
import { openRuntimeDb } from './lib/db.mjs?v=reading-20261101-v1';
import { dispatchEvent, normalizeEvent, CONSUMERS, CONFIG_VERSION, snapshotJson } from './lib/events.mjs?v=reading-20261101-v1';
import { loadConfig, effectiveMode, MODES, DEFAULT_CONFIG, formatInstant } from './lib/config.mjs?v=reading-20261101-v1';
import { normalizeScope, scopeKey as scopeKeyOf, parseScope, digest, databaseFile, packageRoot as packageRootOf } from './lib/scope.mjs';
import { RuntimeError, RuntimeStoppedError, asRuntimeError } from './lib/errors.mjs';
import { createStateSlice, applyStateEvent, describe as describeState } from './lib/state.mjs';
import { applyGoalEvent, getGoal, listGoals, listCommitments } from './lib/goals.mjs';
import { applyWorkingMemoryEvent, renderWorkingMemoryDetailed, workingMemoryState } from './lib/working-memory.mjs';
import { applyBeliefEvent, currentBeliefs } from './lib/beliefs.mjs';
import { applyBridgeEvent, drainOutbox, enqueueIngest } from './lib/bridge.mjs?v=reading-20261101-v1';
import { recordProposal, proposalCount, listProposals, pruneProposals } from './lib/shadow.mjs';
import { status as statusOf, emptyAgendaStatus, emptyHeartbeatStatus } from './lib/diagnostics.mjs';
import { verifyRecovery as verifyRecoveryOf } from './lib/snapshot.mjs';
import {
  applyAgendaEvent, normalizeDefinition as normalizeAgendaDefinition, planWindow as planAgendaWindow,
  occurrenceIdFor, slotKeyFor, getAgendaItem, listAgendaItems, listAgendaOccurrences,
  activeAgendaItems, dueAgendaOccurrences, agendaCounts,
} from './lib/agenda.mjs';
import { casOccurrence as casOccurrenceOf, markOccurrenceDispatched as markOccurrenceDispatchedOf } from './lib/agenda-cas.mjs';
import { localDateString } from './lib/agenda-time.mjs';
import { createHeartbeat } from './lib/heartbeat.mjs';
import { canAutoResumeActivity, createP2 } from './lib/p2.mjs?v=reading-20261101-v1';
import { createBilibiliProviderPort } from './lib/bilibili-provider.mjs';
// P2.5-2 (A4): significance and the memory "subject" are runtime decisions, so they are imported
// from the activities module that owns the outcome record rather than re-derived here.
import { activitySignificance as significanceOf, ingestSubjectKey } from './lib/activities.mjs?v=reading-20261101-v1';

/** The phases a P1 activity fact may carry (A4 §1.4 E1). `paused` is deliberately absent. */
const P2_FACT_PHASES = Object.freeze(['finished', 'failed', 'abandoned', 'missed']);

export const name = 'companion-runtime';
export const VERSION = '0.1.0';
export const inject = [];

export function apply(ctx) {
  try {
    return mountRuntime(ctx, packageRootOf());
  } catch (error) {
    // Mounting must never take the chat turn down; keep a diagnosable inert handle.
    console.log(`[companion-runtime] mount failed: ${error instanceof Error ? error.message : String(error)}`);
    return { mode: 'off', writable: false, version: VERSION, status: () => ({ mode: 'off', error: 'mount-failed' }) };
  }
}

const SESSION_IMPULSES = Object.freeze({
  'user/message': 0.08,
  'assistant/message': 0.03,
});

function bindingToScope(binding) {
  if (!binding || !binding.userId) return null;
  return normalizeScope({
    userId: binding.userId,
    personaId: binding.personaId ?? binding.persona,
    worldId: binding.worldId,
  });
}

/**
 * Mount the cognitive runtime.
 *
 * Ordering guarantees: nothing is written unless a writer lease is held, the
 * configured mode allows it and the runtime has not been stopped. Failures degrade
 * into diagnostics — the chat and memory paths keep working.
 */
export function mountRuntime(ctx, root, options = {}) {
  const loaded = loadConfig(root, { override: options.config ?? null, env: options.env ?? process.env });
  const config = loaded.config;
  const clock = options.now ?? (() => Date.now());
  const identity = options.identity ?? null;
  const memory = { engine: options.memory ?? null };
  const errors = [];
  const dbFile = options.dbFile ?? databaseFile(root);
  const owner = `${process.pid}:${Date.now().toString(36)}:${crypto.randomBytes(4).toString('hex')}`;
  const generation = crypto.randomUUID();

  let db = null;
  let writable = false;
  let stopped = false;
  let disposed = false;
  let leaseInfo = { state: 'none' };
  let mode = 'off';
  let injections = 0;
  let lastInjection = { state: 'idle', chars: 0, at: 0 };
  let heartbeatController = null;
  let p2Controller = null;
  // C4-3: set by the foundation right after it publishes the agenda service (`companionAgenda`).
  let agendaPublication = null;

  const noteError = (code, detail) => {
    errors.unshift({ at: new Date(Number(clock())).toISOString(), code, detail: String(detail ?? '').slice(0, 200) });
    errors.length = Math.min(errors.length, 20);
  };

  /**
   * A **persistent** error record for failures an operator has to be able to find afterwards.
   *
   * The in-memory ring above is deliberately cheap and volatile; this one survives a restart and is not
   * truncated to a screenful. It keeps the last 20 entries under one `runtime_meta` key (zero
   * migration), each `{at, code, summary, subject}`, and never stores raw SQL or user content.
   */
  const PERSISTENT_ERRORS_KEY = 'p2_error_log';
  const CRITICAL_ERRORS_KEY = 'p2_error_log_critical';
  const REVIEW_FAILED_KEY = 'p2_error_log_review_failed';
  /**
   * round-10 review: severity is explicit instead of a single implicit bucket.
   *
   *   - known-critical codes (a refused adjudication) also land in their own key, so the wider critical
   *     ring can never push them out;
   *   - **unknown** codes are treated as critical (conservative: a code nobody classified is more likely
   *     to be a failure than noise);
   *   - routine codes stay in the ordinary ring only.
   */
  const KNOWN_CRITICAL_CODES = new Set(['p2-correction-review-failed', 'p2-correction-reviewed']);
  const ROUTINE_CODES = new Set(['p2-share-rotation-write-failed', 'p2-error-log-write-failed']);
  const severityOf = code => (KNOWN_CRITICAL_CODES.has(String(code)) ? 'critical'
    : (ROUTINE_CODES.has(String(code)) ? 'routine' : 'critical'));
  const appendErrorRecord = (key, entry, limit) => {
    let entries = [];
    try { entries = JSON.parse(String(db.get('SELECT meta_value FROM runtime_meta WHERE meta_key = ?', key)?.meta_value ?? '[]')); } catch { entries = []; }
    if (!Array.isArray(entries)) entries = [];
    entries.unshift(entry);
    const kept = entries.slice(0, limit);
    db.run(`INSERT INTO runtime_meta (meta_key, meta_value, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value, updated_at = excluded.updated_at`,
    key, JSON.stringify(kept), Number(clock()));
  };
  const noteErrorPersistent = (code, detail, subject = '', severity = '') => {
    noteError(code, detail);
    if (!db) return;
    const level = severity || severityOf(code);
    const entry = {
      at: Number(clock()), code: String(code).slice(0, 60),
      summary: String(detail ?? '').slice(0, 200), subject: String(subject).slice(0, 80),
      severity: level,
    };
    try {
      appendErrorRecord(PERSISTENT_ERRORS_KEY, entry, 20);
      if (level === 'critical') {
        appendErrorRecord(CRITICAL_ERRORS_KEY, entry, 20);
        // The adjudication failure is the one an operator must always be able to find, so it also
        // gets a key of its own — no other code can evict it.
        if (String(code) === 'p2-correction-review-failed') appendErrorRecord(REVIEW_FAILED_KEY, entry, 5);
      }
    } catch (error) {
      noteError('p2-error-log-write-failed', error?.message ?? String(error));
    }
  };
  if (loaded.error) noteError('config-invalid', loaded.error);

  // A configured `off` (or a disabled runtime) must not even open the database: the
  // contract says no tables, no lease, no writes.
  const configuredMode = config.enabled === true && MODES.includes(config.mode) && config.mode !== 'off' ? config.mode : 'off';

  let heartbeatTimer = null;
  if (configuredMode !== 'off') {
    try {
      db = openRuntimeDb({ file: dbFile, now: clock });
      const lease = db.acquireLease({ owner, generation, ttlMs: config.leaseTtlMs });
      writable = lease.ok === true;
      leaseInfo = writable
        ? { state: 'held', owner, generation, expiresAt: lease.expiresAt }
        : { state: 'held-elsewhere', owner: lease.owner, generation: lease.generation, expiresAt: lease.expiresAt };
      if (!writable) noteError('lease-held-elsewhere', lease.owner);
      if (writable) {
        // Keep the single-writer lease alive while mounted; cleared on dispose. This is
        // renewal only: it is never evidence that a business heartbeat cycle ran (C5
        // §12.5.1 keeps those two diagnostics separate).
        const interval = Math.max(5000, Math.floor(config.leaseTtlMs / 3));
        heartbeatTimer = setInterval(() => {
          try {
            if (!db || disposed) return;
            const renewed = db.heartbeatLease({ owner, generation, ttlMs: config.leaseTtlMs });
            if (renewed) {
              leaseInfo = { ...leaseInfo, expiresAt: Number(clock()) + config.leaseTtlMs };
              heartbeatController?.noteLeaseRenewSuccess?.();
            } else {
              heartbeatController?.noteLeaseRenewFailure?.('lease-renew-rejected');
            }
          } catch (error) {
            // A missed heartbeat only risks a takeover, never a crash; it must however be
            // visible instead of reporting a healthy lease.
            noteError('lease-renew-failed', error instanceof Error ? error.message : String(error));
            heartbeatController?.noteLeaseRenewFailure?.('lease-renew-failed');
          }
        }, interval);
        if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
      }
    } catch (error) {
      noteError('db-unavailable', error instanceof Error ? error.message : String(error));
      db = null;
      writable = false;
      leaseInfo = { state: 'unavailable' };
    }
  }
  mode = effectiveMode(config, { writable: writable && Boolean(db) });

  const resolveBinding = (input = {}) => {
    const provided = input.bound ?? input.binding ?? input.scope;
    if (provided) return provided;
    if (identity && input.sessionId) {
      try { return identity.resolve(input.sessionId); } catch (error) { noteError('identity-unavailable', error instanceof Error ? error.message : String(error)); return null; }
    }
    return null;
  };

  const scopeOf = input => {
    const binding = resolveBinding(input);
    return binding ? bindingToScope(binding) : null;
  };

  const stateHandler = ({ event, slice, now }) => {
    const disabled = config.state?.disabled ?? [];
    const base = slice && Array.isArray(slice.defs) ? slice : createStateSlice(event.occurredAt, { disabled });
    return applyStateEvent({ event, slice: base, now });
  };

  const handlers = {
    state: stateHandler,
    goals: applyGoalEvent,
    'working-memory': applyWorkingMemoryEvent,
    beliefs: applyBeliefEvent,
    bridge: applyBridgeEvent,
    agenda: applyAgendaEvent,
  };

  function requireActive() {
    if (disposed) return { ok: false, code: 'runtime-disposed' };
    if (mode === 'off') return { ok: false, code: 'runtime-disabled' };
    if (stopped) return { ok: false, code: 'runtime-stopped' };
    return null;
  }

  function shadowOrReject(kind, payload, { scopeKey, expectedRevision, observedRevision } = {}) {
    if (mode === 'off' || !db) return { ok: false, code: config.enabled === true ? 'runtime-disabled' : 'runtime-off', mode };
    if (stopped || disposed) return { ok: false, code: 'runtime-stopped', mode };
    try {
      // Shadow writes obey the same writer gate as authoritative writes (A10/A12) — including
      // the lease expiry half since P2.5-4A.
      db.assertWritable(generation, { owner });
      const record = recordProposal(db, { scopeKey, kind, payload, expectedRevision, observedRevision, decision: 'accepted-shadow', now: Number(clock()) });
      pruneProposals(db, config.shadow?.maxProposals);
      return { ok: true, shadow: true, enabled: false, mode, decision: record.decision, proposalId: record.proposalId };
    } catch (error) {
      const runtimeError = error instanceof RuntimeError ? error : new RuntimeError('internal', error instanceof Error ? error.message : String(error));
      noteError(runtimeError.code, runtimeError.message);
      return { ok: false, code: runtimeError.code, error: runtimeError.message };
    }
  }

  function commitEvent(input) {
    const blocked = requireActive();
    if (blocked) return blocked;
    if (mode !== 'active') return { ok: false, code: 'runtime-inactive', mode };
    // Agenda state has exactly one write path (the schedule API). Letting the generic
    // `recordEvent` entry accept `agenda/*` would bypass the definition validation, the
    // deterministic instants and the required-consumer rollback — and could recreate the
    // receiptless-event state that review pass 2 called BLOCK-2 (review pass 3).
    if (String(input.kind ?? '').startsWith('agenda/')) {
      return { ok: false, code: 'agenda-direct-event-refused', error: 'agenda events are written only through the schedule API' };
    }
    // Same rule for P2: autonomy state has one write path (the P2 controller), so a forged
    // payload or instant cannot reach the log through the generic event entry.
    if (String(input.kind ?? '').startsWith('autonomy/')) {
      return { ok: false, code: 'autonomy-direct-event-refused', error: 'autonomy events are written only through the P2 API' };
    }
    try {
      const event = normalizeEvent({ ...input, occurredAt: input.occurredAt ?? Number(clock()) });
      // P2.5-4A: this is the generic P1 event entry, and it used to be fenced by the
      // generation meta row only (A1 §4.4 #11). The guard runs inside the append
      // transaction, so a lease that lapsed between the mode check and the commit is
      // refused there rather than discovered by the next reader.
      const outcome = dispatchEvent(db, event, {
        handlers,
        generation,
        owner,
        guard: () => db.assertLeaseValid({ owner, generation, at: Number(clock()) }),
      });
      const failure = outcome.results.find(result => result.error);
      if (failure) return { ok: false, code: failure.code ?? 'consumer-failed', error: failure.error, eventId: event.eventId, results: outcome.results };
      return { ok: true, eventId: event.eventId, inserted: outcome.inserted, results: outcome.results };
    } catch (error) {
      const runtimeError = error instanceof RuntimeError ? error : new RuntimeError('internal', error instanceof Error ? error.message : String(error));
      noteError(runtimeError.code, runtimeError.message);
      return { ok: false, code: runtimeError.code, error: runtimeError.message };
    }
  }

  function directEventGuard(input, scope, { dedupe = false } = {}) {
    const payload = input.payload ?? {};
    const kind = String(input.kind ?? '').trim();
    if (!['topic/switch', 'topic/resume', 'belief/corrected'].includes(kind)) return null;
    if (dedupe && input.eventId && db?.get('SELECT 1 AS present FROM domain_events WHERE event_id = ?', String(input.eventId))) return null;
    const scopeKey = scopeKeyOf(scope);
    if (kind === 'topic/resume' && !payload.goalId) return { ok: false, code: 'invalid-input', error: 'direct topic/resume requires payload.goalId' };
    if (kind === 'topic/switch' || (kind === 'topic/resume' && payload.goalId)) {
      if (!payload.goalId) return { ok: false, code: 'invalid-input', error: 'topic/switch requires payload.goalId' };
      const goal = getGoal(db, scopeKey, String(payload.goalId ?? ''));
      if (!goal) return { ok: false, code: 'goal-not-found', goalId: payload.goalId };
      if (!Number.isFinite(Number(payload.expectedRevision))) return { ok: false, code: 'revision-required', currentRevision: goal.revision };
      if (Number(payload.expectedRevision) !== Number(goal.revision)) return { ok: false, code: 'stale-revision', currentRevision: goal.revision };
    }
    if (kind === 'belief/corrected') {
      const current = listRuntimeBeliefs(input).beliefs.find(item => item.beliefId === String(payload.beliefId ?? ''));
      if (!current) return { ok: false, code: 'belief-not-found', beliefId: payload.beliefId };
      if (!Number.isFinite(Number(payload.expectedRevision))) return { ok: false, code: 'revision-required', currentRevision: current.revision };
      if (Number(payload.expectedRevision) !== Number(current.revision)) return { ok: false, code: 'stale-revision', currentRevision: current.revision };
    }
    return null;
  }

  function recordEvent(input = {}) {
    const scope = scopeOf(input);
    if (!scope) return { ok: false, code: 'unbound' };
    const kind = String(input.kind ?? '').trim();
    let payload;
    try { payload = input.payload === undefined || input.payload === null ? {} : snapshotJson(input.payload); } catch (error) { return { ok: false, code: error?.code ?? 'invalid-input', error: error instanceof Error ? error.message : String(error) }; }
    const safeInput = { ...input, kind, payload };
    const at = input.occurredAt ?? Number(clock());
    if (mode === 'off') return { ok: false, code: config.enabled === true ? 'runtime-disabled' : 'runtime-off' };
    const guarded = directEventGuard(safeInput, scope, { dedupe: mode === 'active' });
    if (guarded) return guarded;
    if (mode === 'shadow') {
      return shadowOrReject(kind, { ...payload, note: 'event-not-applied' }, { scopeKey: scopeKeyOf(scope) });
    }
    return commitEvent({ ...safeInput, scope, occurredAt: at });
  }

  function proposeGoal(input = {}) {
    const scope = scopeOf(input);
    if (!scope) return { ok: false, code: 'unbound' };
    const scopeKey = scopeKeyOf(scope);
    const payload = {
      title: String(input.title ?? '').trim().slice(0, 120),
      source: String(input.source ?? 'conversation').slice(0, 40),
      authorization: String(input.authorization ?? 'none').slice(0, 24),
      deadlineAt: Number.isFinite(input.deadlineAt) ? input.deadlineAt : null,
      nextStep: String(input.nextStep ?? '').slice(0, 200),
      waitingOn: String(input.waitingOn ?? '').slice(0, 200),
    };
    if (!payload.title) return { ok: false, code: 'invalid-input', error: 'title is required' };
    if (mode !== 'active') return shadowOrReject('goal/proposed', payload, { scopeKey });
    return commitEvent({ kind: 'goal/proposed', scope, sessionId: input.sessionId ?? '', payload, rootEvidenceIds: input.rootEvidenceIds ?? [] });
  }

  function goalRevisionCheck(scopeKey, goalId, expectedRevision) {
    const goal = getGoal(db, scopeKey, goalId);
    if (!goal) return { ok: false, code: 'goal-not-found' };
    const expected = Number(expectedRevision);
    if (!Number.isFinite(expected)) return { ok: false, code: 'revision-required', currentRevision: goal.revision };
    if (expected !== goal.revision) return { ok: false, code: 'stale-revision', currentRevision: goal.revision };
    return { ok: true, goal };
  }

  const GOAL_TRANSITIONS = Object.freeze({
    proposed: Object.freeze(['accepted', 'cancelled']),
    accepted: Object.freeze(['running', 'cancelled']),
    running: Object.freeze(['paused', 'completed', 'cancelled']),
    paused: Object.freeze(['running', 'completed', 'cancelled']),
    completed: Object.freeze([]),
    cancelled: Object.freeze([]),
  });

  function goalMutation(kind, input = {}, payloadExtra = {}) {
    const scope = scopeOf(input);
    if (!scope) return { ok: false, code: 'unbound' };
    const scopeKey = scopeKeyOf(scope);
    if (mode !== 'active') {
      const observed = input.goalId ? getGoal(db, scopeKey, input.goalId)?.revision ?? null : null;
      return shadowOrReject(kind, { ...payloadExtra, goalId: input.goalId ?? null }, { scopeKey, expectedRevision: input.expectedRevision ?? null, observedRevision: observed });
    }
    const goalId = String(input.goalId ?? '');
    if (!goalId) return { ok: false, code: 'invalid-input', error: 'goalId is required' };
    const check = goalRevisionCheck(scopeKey, goalId, input.expectedRevision);
    if (!check.ok) return check;
    return commitEvent({ kind, scope, sessionId: input.sessionId ?? '', payload: { goalId, expectedRevision: check.goal.revision, ...payloadExtra }, rootEvidenceIds: input.rootEvidenceIds ?? [] });
  }

  function transitionGoal(input = {}) {
    const to = String(input.to ?? '');
    const kinds = { accepted: 'goal/accepted', started: 'goal/started', paused: 'goal/paused', resumed: 'goal/resumed', completed: 'goal/completed', cancelled: 'goal/cancelled' };
    if (!kinds[to]) return { ok: false, code: 'invalid-input', error: `unsupported transition: ${to}` };
    const scope = scopeOf(input);
    if (!scope) return { ok: false, code: 'unbound' };
    const scopeKey = scopeKeyOf(scope);
    if (mode === 'active' && db) {
      const goal = input.goalId ? getGoal(db, scopeKey, String(input.goalId)) : null;
      if (goal) {
        // A stale proposal is rejected as stale before its transition is judged (A07).
        const expected = Number(input.expectedRevision);
        if (!Number.isFinite(expected)) return { ok: false, code: 'revision-required', currentRevision: goal.revision };
        if (expected !== goal.revision) return { ok: false, code: 'stale-revision', currentRevision: goal.revision };
        const target = to === 'started' || to === 'resumed' ? 'running' : to;
        if (!(GOAL_TRANSITIONS[goal.status] ?? []).includes(target)) {
          return { ok: false, code: 'invalid-transition', error: `${goal.status} → ${target} is not allowed`, currentRevision: goal.revision };
        }
      }
    }
    return goalMutation(kinds[to], input, { reason: String(input.reason ?? '').slice(0, 120) });
  }

  function recordGoalStep(input = {}) {
    const step = String(input.step ?? '').trim().slice(0, 160);
    if (!step) return { ok: false, code: 'invalid-input', error: 'step is required' };
    return goalMutation('goal/step', input, { step });
  }

  function patchGoal(input = {}) {
    const patch = {};
    if (typeof input.nextStep === 'string') patch.nextStep = input.nextStep.slice(0, 200);
    if (typeof input.waitingOn === 'string') patch.waitingOn = input.waitingOn.slice(0, 200);
    if (Number.isFinite(input.deadlineAt)) patch.deadlineAt = input.deadlineAt;
    if (typeof input.title === 'string') patch.title = input.title.slice(0, 120);
    if (!Object.keys(patch).length) return { ok: false, code: 'invalid-input', error: 'empty patch' };
    return goalMutation('goal/updated', input, { patch });
  }

  function makeCommitment(input = {}) {
    const scope = scopeOf(input);
    if (!scope) return { ok: false, code: 'unbound' };
    const text = String(input.text ?? '').trim().slice(0, 200);
    if (!text) return { ok: false, code: 'invalid-input', error: 'text is required' };
    const payload = { text, dueAt: Number.isFinite(input.dueAt) ? Number(input.dueAt) : null, goalId: String(input.goalId ?? '') };
    if (mode !== 'active') return shadowOrReject('commitment/made', payload, { scopeKey: scopeKeyOf(scope) });
    return commitEvent({ kind: 'commitment/made', scope, sessionId: input.sessionId ?? '', payload });
  }

  function endCommitment(input = {}) {
    const scope = scopeOf(input);
    if (!scope) return { ok: false, code: 'unbound' };
    if (!input.commitmentId) return { ok: false, code: 'invalid-input', error: 'commitmentId is required' };
    const payload = { commitmentId: String(input.commitmentId), reason: String(input.reason ?? 'closed').slice(0, 120) };
    if (mode !== 'active') return shadowOrReject('commitment/closed', payload, { scopeKey: scopeKeyOf(scope) });
    return commitEvent({ kind: 'commitment/closed', scope, sessionId: input.sessionId ?? '', payload });
  }

  function assertBelief(input = {}) {
    const scope = scopeOf(input);
    if (!scope) return { ok: false, code: 'unbound' };
    const proposition = String(input.proposition ?? '').trim().slice(0, 200);
    if (!proposition) return { ok: false, code: 'invalid-input', error: 'proposition is required' };
    const payload = {
      proposition,
      roots: Array.isArray(input.rootEvidenceIds) ? input.rootEvidenceIds.map(String).slice(0, 32) : [],
      confidence: Number.isFinite(input.confidence) ? input.confidence : null,
      validUntil: Number.isFinite(input.validUntil) ? input.validUntil : null,
      source: String(input.source ?? 'conversation').slice(0, 40),
    };
    if (mode !== 'active') return shadowOrReject('belief/asserted', payload, { scopeKey: scopeKeyOf(scope) });
    return commitEvent({ kind: 'belief/asserted', scope, sessionId: input.sessionId ?? '', payload, rootEvidenceIds: payload.roots, realityStatus: input.realityStatus ?? 'hypothetical', evidenceStatus: input.evidenceStatus ?? 'inferred' });
  }

  function addBeliefEvidence(input = {}) {
    const scope = scopeOf(input);
    if (!scope) return { ok: false, code: 'unbound' };
    if (!input.beliefId || !input.evidenceId) return { ok: false, code: 'invalid-input', error: 'beliefId and evidenceId are required' };
    const payload = {
      beliefId: String(input.beliefId),
      evidenceId: String(input.evidenceId),
      rootId: String(input.rootId ?? input.evidenceId),
      relation: String(input.relation ?? 'supports'),
      note: String(input.note ?? '').slice(0, 120),
    };
    if (mode !== 'active') return shadowOrReject('belief/evidence', payload, { scopeKey: scopeKeyOf(scope) });
    return commitEvent({ kind: 'belief/evidence', scope, sessionId: input.sessionId ?? '', payload, rootEvidenceIds: [payload.rootId] });
  }

  function correctBelief(input = {}) {
    const scope = scopeOf(input);
    if (!scope) return { ok: false, code: 'unbound' };
    if (!input.beliefId) return { ok: false, code: 'invalid-input', error: 'beliefId is required' };
    const current = listRuntimeBeliefs({ sessionId: input.sessionId }).beliefs.find(item => item.beliefId === input.beliefId);
    if (!current) return { ok: false, code: 'belief-not-found', beliefId: input.beliefId };
    if (input.expectedRevision !== undefined && Number(input.expectedRevision) !== Number(current.revision)) {
      return { ok: false, code: 'stale-revision', beliefId: input.beliefId, expectedRevision: input.expectedRevision, actualRevision: current.revision };
    }
    const evidenceId = String(input.byEvidenceId ?? `correction:${input.beliefId}:${Number(clock())}`).slice(0, 80);
    const payload = {
      beliefId: String(input.beliefId),
      byEvidenceId: evidenceId,
      reason: String(input.reason ?? 'user-correction').slice(0, 120),
      replacement: typeof input.replacement === 'string' ? input.replacement.slice(0, 200) : '',
    };
    if (mode !== 'active') return shadowOrReject('belief/corrected', payload, { scopeKey: scopeKeyOf(scope), expectedRevision: input.expectedRevision ?? null });
    const corrected = commitEvent({ kind: 'belief/corrected', scope, sessionId: input.sessionId ?? '', payload, rootEvidenceIds: [evidenceId], evidenceStatus: 'confirmed' });
    // E6 (A4 §3, plan line 190): the correction must also reach **memory**, otherwise the runtime
    // belief is superseded while the memory-side fact stays current and the next plan re-reads the
    // old one. `memory/correction-request` existed as a channel with no producer at all; this is
    // that producer. Bounded and best effort: a correction that cannot be queued must not undo the
    // belief correction (which is already committed and authoritative).
    let memoryCorrection = { ok: false, code: 'not-queued' };
    if (corrected?.ok !== false) {
      try {
        const currentRecord = listRuntimeBeliefs({ sessionId: input.sessionId }).beliefs.find(item => item.beliefId === input.beliefId) ?? null;
        const replacement = String(payload.replacement ?? '').trim();
        // A: the **old** statement travels with the correction. Without it memory cannot know what to
        // supersede, and the old fact keeps coming back from recall (task-33's whole point).
        const previous = String(current?.proposition ?? currentRecord?.proposition ?? '').trim();
        const statement = [
          previous ? `用户纠正（旧：${previous}）` : '用户纠正',
          replacement ? `现在是「${replacement}」` : '不再成立',
          payload.reason ? `（原因：${payload.reason}）` : '',
        ].join('');
        const correctionRequest = {
          sessionId: input.sessionId ?? '',
          namespace: 'companion.correction',
          content: statement,
          correction: true,
          rootEvidenceIds: [evidenceId],
          realityStatus: 'actual_tool_activity',
          evidenceStatus: 'confirmed',
          // The corrected belief is a *confirmed* user fact, not an inference.
          significance: 'notable',
          // Memory resolves this hint to the row it must mark superseded: the old proposition text
          // (beliefs carry root evidence ids, not memory ids, so text is the honest hint).
          supersedesHint: previous,
        };
        memoryCorrection = requestMemoryIngest(correctionRequest);
        if (memoryCorrection?.ok !== true) {
          // D: keep it as a due todo and let the existing drain resend it. The belief correction
          // itself stays committed — rolling it back would undo what the user just said.
          queueCorrectionTodo(correctionRequest, { beliefId: String(input.beliefId), reason: String(memoryCorrection?.code ?? 'not-queued') });
        }
        memoryCorrection = { ...memoryCorrection, kind: 'memory/correction-request' };
        if (currentRecord) memoryCorrection.beliefId = currentRecord.beliefId;
      } catch (error) {
        memoryCorrection = { ok: false, code: String(asRuntimeError(error).code ?? 'correction-queue-failed') };
      }
    }
    return { ...corrected, memoryCorrection };
  }

  function expireBeliefs(input = {}) {
    const scope = scopeOf(input);
    if (!scope) return { ok: false, code: 'unbound' };
    const at = input.at ?? Number(clock());
    if (mode !== 'active') return { ok: false, code: 'runtime-inactive', mode };
    return commitEvent({ kind: 'belief/expired', scope, occurredAt: at, payload: { at } });
  }

  /**
   * Queue one experience for the memory public entry. The runtime never writes memory
   * tables itself: it records the request, the bridge drains it, and only the receipt
   * memory returns is treated as persistence.
   */
  function switchFocus(input = {}) {
    const scope = scopeOf(input);
    if (!scope) return { ok: false, code: 'unbound' };
    const goalId = String(input.goalId ?? '');
    if (!goalId) return { ok: false, code: 'invalid-input', error: 'goalId is required' };
    const goal = listRuntimeGoals({ sessionId: input.sessionId, includeClosed: true, limit: 100 }).goals.find(item => item.goalId === goalId);
    if (!goal) return { ok: false, code: 'goal-not-found', goalId };
    if (input.expectedRevision !== undefined && Number(input.expectedRevision) !== Number(goal.revision)) {
      return { ok: false, code: 'stale-revision', goalId, expectedRevision: input.expectedRevision, actualRevision: goal.revision };
    }
    if (mode !== 'active') return shadowOrReject('topic/switch', { goalId }, { scopeKey: scopeKeyOf(scope) });
    return commitEvent({ kind: 'topic/switch', scope, sessionId: input.sessionId ?? '', payload: { goalId, expectedRevision: input.expectedRevision ?? null } });
  }

  function resumeFocus(input = {}) {
    const scope = scopeOf(input);
    if (!scope) return { ok: false, code: 'unbound' };
    const listed = listRuntimeGoals({ sessionId: input.sessionId, includeClosed: true, limit: 100 }).goals;
    const goalId = input.goalId ? String(input.goalId) : '';
    const goal = goalId ? listed.find(item => item.goalId === goalId) : listed.filter(item => ['paused', 'running', 'accepted'].includes(item.status)).sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (!goal) return { ok: false, code: 'goal-not-found', goalId };
    if (input.expectedRevision !== undefined && Number(input.expectedRevision) !== Number(goal.revision)) {
      return { ok: false, code: 'stale-revision', goalId: goal.goalId, expectedRevision: input.expectedRevision, actualRevision: goal.revision };
    }
    const payload = { goalId: goal.goalId };
    if (mode !== 'active') return shadowOrReject('topic/resume', payload, { scopeKey: scopeKeyOf(scope) });
    return commitEvent({ kind: 'topic/resume', scope, sessionId: input.sessionId ?? '', payload });
  }

  /**
   * task-39: how candidates look to a human reviewer.
   *
   * `[{recordId, text, at, kind}]`, text bounded to 120 characters (with `truncated`), taken verbatim
   * from what memory reported — the runtime never invents a preview. A candidate memory could not
   * describe comes back as `text: null` + `textUnavailable`, and an entry written before this feature
   * existed says `legacy-entry` rather than pretending the text is empty.
   */
  function candidateView(entry) {
    const details = Array.isArray(entry?.candidateDetails) ? entry.candidateDetails : [];
    const ids = Array.isArray(entry?.candidates) ? entry.candidates.map(String) : [];
    if (!ids.length) return [];
    return ids.map(id => {
      const detail = details.find(item => String(item?.recordId ?? '') === id) ?? null;
      if (!detail) return { recordId: id, text: null, at: '', kind: '', textUnavailable: 'legacy-entry' };
      const truncated = detail.truncated === true;
      const text = typeof detail.text === 'string' ? (truncated ? detail.text.slice(0, 120) : detail.text.slice(0, 120)) : null;
      return {
        recordId: id,
        text,
        at: String(detail.at ?? ''),
        kind: String(detail.kind ?? ''),
        ...(truncated ? { truncated: true } : {}),
        ...(text === null ? { textUnavailable: String(detail.textUnavailable ?? 'unavailable') } : {}),
      };
    });
  }

  /**
   * task-38: adjudicate an ambiguous correction — "these are the rows this correction replaces".
   *
   * Why an explicit API instead of a smarter matcher: a wrong supersede is **irreversible**, so the
   * decision belongs to a human who can see the candidates. Rules mirror `resolveEffect` (operator and
   * evidence mandatory, no empty strings) and are deliberately strict:
   *   - `supersedeIds` must be a subset of that entry's candidates (`not-a-candidate` otherwise);
   *   - an empty list is legal and means "the new statement is an addition, not a replacement"
   *     (`resolved-none`) — the entry stops being pending without erasing anything;
   *   - adjudicating twice returns `already-resolved` and supersedes nothing again;
   *   - the decision is written to `runtime_meta` (who / when / which ids / why), zero migration.
   */
  function resolveAmbiguousCorrection(input = {}) {
    if (!db) return { ok: false, code: 'db-unavailable' };
    const recordId = String(input.recordId ?? '').trim();
    if (!recordId) return { ok: false, code: 'invalid-input', error: 'recordId is required' };
    const operator = String(input.operator ?? '').trim();
    if (!operator) return { ok: false, code: 'operator-required' };
    const evidence = String(input.evidence ?? '').trim();
    // Same standard as `resolveEffect`: an adjudication without evidence is a way to launder a
    // memory erasure, so it is refused outright.
    if (!evidence) return { ok: false, code: 'evidence-required' };
    if (!Array.isArray(input.supersedeIds)) return { ok: false, code: 'invalid-input', error: 'supersedeIds must be an array' };
    const wanted = [...new Set(input.supersedeIds.map(value => String(value ?? '').trim()).filter(Boolean))];

    const reviewKey = `${CORRECTION_REVIEW_PREFIX}${recordId}`;
    const resolvedKey = `${CORRECTION_RESOLVED_PREFIX}${recordId}`;

    // Idempotency first: a second adjudication must not supersede anything again, and it must still
    // be able to answer "what was decided before?".
    let previous = null;
    try {
      const done = db.get('SELECT meta_value FROM runtime_meta WHERE meta_key = ?', resolvedKey);
      if (done) { try { previous = JSON.parse(String(done.meta_value ?? '{}')); } catch { previous = {}; } }
    } catch { previous = null; }
    if (previous) return { ok: false, code: 'already-resolved', recordId, resolution: previous };

    let entry = null;
    try {
      const row = db.get('SELECT meta_value FROM runtime_meta WHERE meta_key = ?', reviewKey);
      if (row) { try { entry = JSON.parse(String(row.meta_value ?? '{}')); } catch { entry = null; } }
    } catch { entry = null; }
    if (!entry) return { ok: false, code: 'not-found', recordId };

    const candidates = Array.isArray(entry.candidates) ? entry.candidates.map(String) : [];
    const foreign = wanted.filter(id => !candidates.includes(id));
    if (foreign.length) return { ok: false, code: 'not-a-candidate', recordId, rejected: foreign, candidates };

    const sessionId = String(input.sessionId ?? '').trim();
    if (wanted.length && !sessionId) return { ok: false, code: 'session-required', recordId };
    // task-49: an enqueue is not an application. The audit says `resolved-pending-apply` until the
    // memory side confirms it actually superseded; `resolved-applied` is written by
    // `settleCorrectionResolutions` once the outbox row for this request is genuinely sent.
    const outcome = wanted.length ? 'resolved-pending-apply' : 'resolved-none';
    const at = Number(clock());
    const audit = {
      recordId,
      supersedeIds: wanted,
      operator: operator.slice(0, 80),
      evidence: evidence.slice(0, 200),
      outcome,
      candidates,
      at,
    };
    if (wanted.length) {
      // Execution goes through the **existing** memory write seam: an exact-id correction request
      // travels the bridge and lands in `db.supersedeMemory` (the single supersede entry point).
      const queued = requestMemoryIngest({
        sessionId,
        namespace: 'companion.correction',
        content: `人工裁决：纠正 ${recordId} 取代 ${wanted.length} 条旧事实（操作者 ${audit.operator}）`,
        correction: true,
        supersedeIds: wanted,
        realityStatus: 'actual_tool_activity',
        evidenceStatus: 'confirmed',
        significance: 'notable',
      });
      if (queued?.ok !== true) {
        // Nothing is recorded as adjudicated when the execution could not be queued: the entry stays
        // pending, which is the honest state ("still waiting, and the write failed").
        queueCorrectionTodo({
          namespace: 'companion.correction',
          content: `人工裁决：纠正 ${recordId} 取代 ${wanted.join(',')}`,
          supersedeIds: wanted,
        }, { beliefId: recordId, reason: String(queued?.code ?? 'adjudication-not-queued') });
        return { ok: false, code: 'not-queued', recordId, reason: String(queued?.code ?? 'not-queued') };
      }
      audit.requestId = String(queued.eventId ?? '');
    }
    try {
      db.tx(() => {
        db.run(`INSERT INTO runtime_meta (meta_key, meta_value, updated_at) VALUES (?, ?, ?)
                ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value, updated_at = excluded.updated_at`,
        resolvedKey, JSON.stringify(audit), at);
        db.run('DELETE FROM runtime_meta WHERE meta_key = ?', reviewKey);
      });
    } catch (error) {
      return { ok: false, code: 'audit-write-failed', recordId, reason: String(error?.message ?? error).slice(0, 120) };
    }
    noteError('p2-correction-resolved', `${outcome} by ${audit.operator} (${wanted.length} ids)`);
    return { ok: true, recordId, outcome, superseded: wanted, audit };
  }

  /** task-39: enumerate recent adjudications (bounded) so "what was resolved" is answerable. */
  function listResolved({ limit = 5 } = {}) {
    const size = Math.max(1, Math.min(20, Number(limit) || 5));
    try {
      const rows = db.all(`SELECT meta_key, meta_value, updated_at FROM runtime_meta
                            WHERE meta_key LIKE '${CORRECTION_RESOLVED_PREFIX}%'
                            ORDER BY updated_at DESC LIMIT ?`, size) ?? [];
      return {
        ok: true,
        resolved: rows.map(row => {
          let audit = {};
          try { audit = JSON.parse(String(row.meta_value ?? '{}')); } catch { audit = {}; }
          return {
            recordId: String(audit.recordId ?? String(row.meta_key ?? '').slice(CORRECTION_RESOLVED_PREFIX.length)),
            supersededIds: Array.isArray(audit.supersedeIds) ? audit.supersedeIds : [],
            operator: String(audit.operator ?? ''),
            at: Number(audit.at) || 0,
            outcome: String(audit.outcome ?? ''),
          };
        }),
      };
    } catch { return { ok: false, code: 'review-unavailable', resolved: [] }; }
  }

  /** task-38: read back one adjudication (so a resolved entry never just "disappears"). */
  function correctionResolution({ recordId = '' } = {}) {
    const id = String(recordId ?? '').trim();
    if (!id) return { ok: false, code: 'invalid-input', error: 'recordId is required' };
    try {
      const row = db.get('SELECT meta_value FROM runtime_meta WHERE meta_key = ?', `${CORRECTION_RESOLVED_PREFIX}${id}`);
      if (!row) return { ok: true, resolved: null, recordId: id };
      let audit = {};
      try { audit = JSON.parse(String(row.meta_value ?? '{}')); } catch { audit = {}; }
      return { ok: true, resolved: audit, recordId: id };
    } catch { return { ok: false, code: 'review-unavailable', recordId: id }; }
  }

  const CORRECTION_REVIEW_PREFIX = 'p2_correction_review:';
  const CORRECTION_RESOLVED_PREFIX = 'p2_correction_resolved:';

  /**
   * task-36: a correction that memory refused to apply (the hint matched several facts) becomes a
   * **reviewable todo** here, not a log line nobody reads.
   *
   * Zero migration (`runtime_meta`), keyed by the memory record so a redelivery of the same
   * correction updates the entry instead of growing the list. It is deliberately *not* retried by
   * `retryPendingCorrections`: the fix needs a human to choose the target, and re-sending the same
   * ambiguous hint forever would only hide the problem.
   */
  function queueCorrectionReview({ outcome, namespace = '', eventId = '' } = {}) {
    try {
      const superse = outcome?.supersede ?? {};
      const key = `${CORRECTION_REVIEW_PREFIX}${String(outcome?.recordId ?? eventId ?? '').slice(0, 120)}`;
      db.run(`INSERT INTO runtime_meta (meta_key, meta_value, updated_at) VALUES (?, ?, ?)
              ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value, updated_at = excluded.updated_at`,
      key, JSON.stringify({
        recordId: String(outcome?.recordId ?? ''),
        receiptId: String(outcome?.receiptId ?? ''),
        candidates: Array.isArray(superse.ambiguous) ? superse.ambiguous.slice(0, 5) : [],
        // The reviewer must be able to read what it is choosing between; memory supplies bounded,
        // redacted previews (and `null` + a reason when it cannot). Kept even when empty so a legacy
        // entry is distinguishable from "memory had nothing to say".
        candidateDetails: Array.isArray(superse.ambiguousDetails) ? superse.ambiguousDetails.slice(0, 5) : [],
        namespace: String(namespace ?? '').slice(0, 60),
        eventId: String(eventId ?? '').slice(0, 120),
        reason: 'correction-hint-ambiguous',
        at: Number(clock()),
      }), Number(clock()));
      noteError('p2-correction-ambiguous', `a correction did not take effect (${(superse.ambiguous ?? []).length} candidates)`);
    } catch { /* best effort: the receipt in memory is the durable record */ }
  }

  /**
   * task-36: what the operator needs to know — how many corrections are waiting for a human, and
   * which ones (bounded). Read-only.
   */
  function correctionReview({ limit = 5 } = {}) {
    const size = Math.max(1, Math.min(20, Number(limit) || 5));
    try {
      const rows = db.all(`SELECT meta_key, meta_value, updated_at FROM runtime_meta
                            WHERE meta_key LIKE '${CORRECTION_REVIEW_PREFIX}%'
                            ORDER BY updated_at DESC LIMIT ?`, size) ?? [];
      const total = db.get(`SELECT COUNT(*) AS n FROM runtime_meta WHERE meta_key LIKE '${CORRECTION_REVIEW_PREFIX}%'`);
      // task-38: adjudicated corrections leave the pending list, so `count` must be **pending only**;
      // the resolved total keeps them findable instead of letting them vanish.
      const resolvedRow = db.get(`SELECT COUNT(*) AS n FROM runtime_meta WHERE meta_key LIKE '${CORRECTION_RESOLVED_PREFIX}%'
                                     AND (meta_value LIKE '%"outcome":"resolved-applied"%'
                                          OR meta_value LIKE '%"outcome":"resolved-none"%')`);
      const pendingApplyRow = db.get(`SELECT COUNT(*) AS n FROM runtime_meta WHERE meta_key LIKE '${CORRECTION_RESOLVED_PREFIX}%'
                                            AND meta_value LIKE '%"outcome":"resolved-pending-apply"%'`);
      return {
        ok: true,
        count: Number(total?.n ?? 0),
        // Only genuinely applied adjudications count as resolved (task-49).
        resolved: Number(resolvedRow?.n ?? 0),
        pendingApply: Number(pendingApplyRow?.n ?? 0),
        recent: rows.map(row => {
          let entry = {};
          try { entry = JSON.parse(String(row.meta_value ?? '{}')); } catch { entry = {}; }
          return {
            recordId: String(entry.recordId ?? ''),
            // task-39: candidates carry their text so the reviewer can actually decide. Legacy entries
            // (written before this change) only have ids, and they say so instead of showing a blank.
            candidates: candidateView(entry),
            at: Number(entry.at) || 0,
          };
        }),
        pendingRetries: (() => {
          try {
            const n = db.get(`SELECT COUNT(*) AS n FROM runtime_meta WHERE meta_key LIKE '${CORRECTION_TODO_PREFIX}%'`);
            return Number(n?.n ?? 0);
          } catch { return 0; }
        })(),
      };
    } catch {
      return { ok: false, code: 'review-unavailable', count: 0, recent: [], pendingRetries: 0 };
    }
  }

  const CORRECTION_TODO_PREFIX = 'p2_correction_pending:';

  /**
   * D: remember a correction that could not be queued, so the existing drain can retry it.
   *
   * Zero migration — `runtime_meta` already exists and is written under the same lease. The key is
   * derived from the belief, so correcting the same belief again replaces its todo instead of
   * growing a log. Never throws: failing to record the todo must not break the correction that
   * already succeeded.
   */
  function queueCorrectionTodo(request, { beliefId = '', reason = '' } = {}) {
    try {
      const key = `${CORRECTION_TODO_PREFIX}${String(beliefId || request.content).slice(0, 120)}`;
      db.run(`INSERT INTO runtime_meta (meta_key, meta_value, updated_at) VALUES (?, ?, ?)
              ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value, updated_at = excluded.updated_at`,
      key, JSON.stringify({
        namespace: request.namespace,
        content: request.content,
        supersedesHint: request.supersedesHint ?? '',
        supersedeIds: Array.isArray(request.supersedeIds) ? request.supersedeIds.slice(0, 10) : [],
        sessionId: request.sessionId ?? '',
        reason: String(reason ?? '').slice(0, 60),
        at: Number(clock()),
      }), Number(clock()));
      noteError('p2-correction-todo', `queued a correction retry (${String(reason ?? '').slice(0, 40)})`);
    } catch { /* the todo is best effort */ }
  }

  /**
   * D: resend corrections that never reached the queue. Called by the **existing** memory drain,
   * bounded, and a todo is cleared **only** once the request is actually queued again.
   */
  /**
   * task-49: promote `resolved-pending-apply` to `resolved-applied` **only** once the outbox row for
   * that request is genuinely `sent`. Until then the adjudication is honest about being in flight —
   * and if the delivery fails, it stays pending instead of claiming a supersede that never happened.
   */
  function settleCorrectionResolutions({ limit = 10, now = null } = {}) {
    const at = Number(now ?? clock());
    const out = { applied: 0, stillPending: 0, needsReview: 0, skipped: 0 };
    // round-4 B2: open adjudications are scanned **fairly**. The previous version always took the oldest
    // ten and left permanently failing items in place, so ten stuck corrections blocked every later
    // (already delivered) adjudication for ever. Now:
    //   - a delivered request whose supersede did NOT take effect becomes `needs-review` (terminal);
    //   - a request that stays undelivered past its deadline also becomes `needs-review`;
    //   - only genuinely in-flight items stay pending, ordered by their last attempt.
    const SETTLE_TIMEOUT_MS = 24 * 3600 * 1000;
    const MAX_SETTLE_ATTEMPTS = 5;
    const writeMeta = (meta) => db.run(`INSERT INTO runtime_meta (meta_key, meta_value, updated_at) VALUES (?, ?, ?)
                    ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value, updated_at = excluded.updated_at`,
    meta.__key, JSON.stringify(meta.value), at);
    try {
      const rows = db.all(`SELECT meta_key, meta_value, updated_at FROM runtime_meta
                            WHERE meta_key LIKE '${CORRECTION_RESOLVED_PREFIX}%'
                              AND meta_value LIKE '%"outcome":"resolved-pending-apply"%'
                            ORDER BY updated_at ASC LIMIT ?`, Math.max(1, Math.min(50, Number(limit) || 10))) ?? [];
      for (const row of rows) {
        let audit = {};
        try { audit = JSON.parse(String(row.meta_value ?? '{}')); } catch { audit = {}; }
        const put = (value) => db.tx(() => writeMeta({ __key: row.meta_key, value }));
        const requestId = String(audit.requestId ?? '');
        const attempts = Math.max(0, Math.trunc(Number(audit.settleAttempts ?? 0))) + 1;
        if (!requestId) {
          try { put({ ...audit, outcome: 'needs-review', reason: 'no-request-id', reviewedAt: at }); } catch { out.skipped += 1; continue; }
          out.needsReview += 1;
          continue;
        }
        let delivery = null;
        try {
          delivery = db.get('SELECT status, last_error, receipt_id FROM memory_outbox WHERE event_id = ? ORDER BY rowid DESC LIMIT 1', requestId);
        } catch { delivery = null; }
        const since = Number(audit.requestedAt ?? audit.at ?? row.updated_at ?? 0) || 0;
        if (!delivery || String(delivery.status) !== 'sent') {
          // Not delivered (yet). Escalate only when it has clearly stalled; otherwise leave it pending.
          if ((since && at - since > SETTLE_TIMEOUT_MS) || attempts > MAX_SETTLE_ATTEMPTS) {
            const reason = attempts > MAX_SETTLE_ATTEMPTS ? 'settle-attempts-exhausted' : 'settle-timeout';
            try { put({ ...audit, outcome: 'needs-review', reason, settleAttempts: attempts, reviewedAt: at }); } catch { out.skipped += 1; continue; }
            out.needsReview += 1;
          } else {
            try { put({ ...audit, settleAttempts: attempts, settleLastAt: at }); } catch { /* the audit stays readable */ }
            out.stillPending += 1;
          }
          continue;
        }
        // Delivered — but "sent" is not "superseded" (round-4 B2). The memory side records the ids it
        // really applied in the outbox row's `last_error`; the adjudication is only `applied` when every
        // requested id appears there.
        // round-4 follow-up: the receipt is structured, stored by the delivery step in `runtime_meta`
        // (`p2_correction_apply:<requestId>`). No free-text parsing: `not-applied=` used to be read as
        // `applied=` and turned a failed supersede into a successful one.
        let receipt = null;
        try {
          const raw = db.get('SELECT meta_value FROM runtime_meta WHERE meta_key = ?', `p2_correction_apply:${requestId}`)?.meta_value;
          if (raw) receipt = JSON.parse(String(raw));
        } catch { receipt = null; }
        const appliedIds = Array.isArray(receipt?.applied) ? receipt.applied.map(String).filter(Boolean) : [];
        const duplicateIds = Array.isArray(receipt?.duplicate) ? receipt.duplicate.map(String).filter(Boolean) : [];
        const notAppliedIds = Array.isArray(receipt?.notApplied) ? receipt.notApplied.map(String).filter(Boolean) : [];
        const wanted = Array.isArray(audit.supersedeIds) ? audit.supersedeIds.map(id => String(id)).filter(Boolean) : [];
        const effective = new Set([...appliedIds, ...duplicateIds]);
        const missing = wanted.filter(id => !effective.has(id));
        const refusal = !receipt
          ? { reason: 'no-supersede-receipt', missingIds: wanted }
          : (missing.length ? { reason: 'supersede-not-applied', missingIds: notAppliedIds.length ? notAppliedIds : missing } : null);
        if (refusal) {
          try {
            put({
              ...audit, outcome: 'needs-review', reason: refusal.reason,
              appliedIds, duplicateIds, missingIds: refusal.missingIds,
              receiptId: String(delivery.receipt_id ?? ''), settleAttempts: attempts, reviewedAt: at,
            });
          } catch { out.skipped += 1; continue; }
          out.needsReview += 1;
          continue;
        }
        try {
          put({
            ...audit, outcome: 'resolved-applied', appliedAt: at,
            receiptId: String(delivery.receipt_id ?? audit.receiptId ?? ''),
            appliedIds, duplicateIds, settleAttempts: attempts,
          });
          out.applied += 1;
        } catch { out.skipped += 1; }
      }
      if (out.applied) noteError('p2-correction-applied', `${out.applied} adjudication(s) confirmed by the memory side`);
      if (out.needsReview) noteError('p2-correction-needs-review', `${out.needsReview} adjudication(s) did not take effect and need a human`);
    } catch { /* best effort: the pending state stays visible */ }
    return out;
  }

  /**
   * round-4 follow-up: a `needs-review` adjudication must have an **exit**. Without one it is a
   * terminal state that nothing can leave, which is the same failure shape as the "crashed generation
   * waits for ever" bug we fixed earlier.
   *
   * `decision`:
   *   - `retry`          → back to `resolved-pending-apply` (the settle step will look again);
   *   - `accept-partial` → `resolved-applied`, explicitly marked as a partial acceptance;
   *   - `reject`         → `failed` (terminal, and it says the adjudication was refused).
   *
   * Every transition needs a named operator **and** evidence, and keeps the previous state in
   * `reviewHistory`, so an operator decision is never invisible.
   */
  function resolveCorrection(input = {}) {
    // The adjudication key is global (runtime_meta), so an operator decision does not need a session
    // scope: requiring one would make the exit unusable from an admin surface.
    if (!db) return { ok: false, code: 'unbound' };
    const resolutionId = String(input.resolutionId ?? input.recordId ?? '').trim();
    if (!resolutionId) return { ok: false, code: 'invalid-input' };
    const decision = String(input.decision ?? '').trim();
    if (!['retry', 'accept-partial', 'reject'].includes(decision)) return { ok: false, code: 'invalid-decision' };
    const operator = String(input.operator ?? '').trim();
    if (!operator) return { ok: false, code: 'operator-required' };
    const evidence = String(input.evidence ?? '').trim();
    if (!evidence) return { ok: false, code: 'evidence-required' };
    const key = `${CORRECTION_RESOLVED_PREFIX}${resolutionId}`;
    /** The memory side's receipt for this request, if the delivery ever produced one. */
    const receiptOf = requestId => {
      try {
        const raw = db.get('SELECT meta_value FROM runtime_meta WHERE meta_key = ?', `p2_correction_apply:${String(requestId)}`)?.meta_value;
        return raw ? JSON.parse(String(raw)) : null;
      } catch { return null; }
    };
    try {
      return db.tx(() => {
        let audit = null;
        try { audit = JSON.parse(String(db.get('SELECT meta_value FROM runtime_meta WHERE meta_key = ?', key)?.meta_value ?? '')); } catch { audit = null; }
        if (!audit) return { ok: false, code: 'not-found' };
        const at = Number(clock());
        const requestId = String(audit.requestId ?? '');
        // round-5 review: `accept-partial` used to accept *nothing* and still claim `resolved-applied`.
        // A partial acceptance only makes sense when at least one id really was applied or was already
        // a duplicate — otherwise the operator is confirming an outcome that does not exist.
        if (decision === 'accept-partial') {
          const receipt = receiptOf(requestId);
          const effective = [...(receipt?.applied ?? []), ...(receipt?.duplicate ?? [])].filter(Boolean);
          if (!effective.length) return { ok: false, code: 'nothing-applied', reason: 'no applied or duplicate id to accept' };
        }
        // round-5 review: `retry` used to be a counter reset. It now really re-drives the correction:
        // the outbox row is put back to `queued` (so the next drain re-delivers it) and the stale
        // receipt is dropped, so the settle step cannot read the same old failure again.
        if (decision === 'retry') {
          // Nothing is written unless the requeue **actually happened**: the check runs first, so a
          // refusal leaves the row and the receipt exactly as they were.
          if (!requestId) {
            return { ok: false, code: 'not-retryable', reason: 'the record names no request to re-send' };
          }
          // A write error here must **abort the whole adjudication** (round-6 probe 2: a swallowed
          // failure committed `queued` while reporting `not-retryable`).
          const changed = db.run(`UPDATE memory_outbox SET status = 'queued', claimed_until = 0, claim_owner = '', last_error = '', updated_at = ?
                                      WHERE event_id = ? AND status = 'sent'`, at, requestId);
          if (Number(changed?.changes ?? 0) === 0) {
            return { ok: false, code: 'not-retryable', reason: 'there is no delivered request to re-send' };
          }
          db.run('DELETE FROM runtime_meta WHERE meta_key = ?', `p2_correction_apply:${String(requestId)}`);
        }
        const outcome = decision === 'retry' ? 'resolved-pending-apply' : decision === 'accept-partial' ? 'resolved-applied' : 'failed';
        const history = Array.isArray(audit.reviewHistory) ? audit.reviewHistory.slice(-9) : [];
        const next = {
          ...audit,
          outcome,
          ...(decision === 'retry' ? { settleAttempts: 0, reason: 'operator-retry', retriedAt: at } : {}),
          ...(decision === 'accept-partial' ? { acceptedPartial: true, acceptedAt: at } : {}),
          ...(decision === 'reject' ? { failedAt: at } : {}),
          reviewedBy: operator.slice(0, 80),
          reviewedAt: at,
          reviewEvidence: evidence.slice(0, 200),
          reviewDecision: decision,
          reviewHistory: [...history, { from: String(audit.outcome ?? ''), decision, operator: operator.slice(0, 80), at }],
        };
        db.run(`INSERT INTO runtime_meta (meta_key, meta_value, updated_at) VALUES (?, ?, ?)
                ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value, updated_at = excluded.updated_at`,
        key, JSON.stringify(next), at);
        noteError('p2-correction-reviewed', `adjudication ${resolutionId} ${decision} by ${operator.slice(0, 40)}`);
        return { ok: true, resolutionId, outcome, decision };
      });
    } catch (error) {
      // Anything that reaches here is a **write failure** (the refusals return before writing), so the
      // documented answer is `review-failed`. `asRuntimeError` would label a bare SQLite error
      // `internal`, which is not the contract this call promises (round-7 review).
      noteErrorPersistent('p2-correction-review-failed', error?.message ?? String(error), resolutionId);
      return { ok: false, code: 'review-failed' };
    }
  }
  function retryPendingCorrections({ limit = 5 } = {}) {
    const out = { retried: 0, cleared: 0, failed: 0 };
    try {
      const rows = db.all(`SELECT meta_key, meta_value FROM runtime_meta
                            WHERE meta_key LIKE '${CORRECTION_TODO_PREFIX}%' ORDER BY updated_at ASC LIMIT ?`,
      Math.max(1, Math.min(20, Number(limit) || 5))) ?? [];
      for (const row of rows) {
        let todo = {};
        try { todo = JSON.parse(String(row.meta_value ?? '{}')); } catch { todo = {}; }
        if (!todo.content) { db.run('DELETE FROM runtime_meta WHERE meta_key = ?', row.meta_key); out.cleared += 1; continue; }
        const retried = requestMemoryIngest({
          sessionId: todo.sessionId ?? '',
          namespace: todo.namespace || 'companion.correction',
          content: String(todo.content),
          correction: true,
          realityStatus: 'actual_tool_activity',
          evidenceStatus: 'confirmed',
          significance: 'notable',
          supersedesHint: todo.supersedesHint ?? '',
          supersedeIds: Array.isArray(todo.supersedeIds) ? todo.supersedeIds : [],
        });
        if (retried?.ok === true) {
          db.run('DELETE FROM runtime_meta WHERE meta_key = ?', row.meta_key);
          out.cleared += 1;
        } else { out.failed += 1; }
        out.retried += 1;
      }
    } catch (error) {
      noteError('p2-correction-retry-failed', error?.message ?? String(error));
    }
    return out;
  }

  function requestMemoryIngest(input = {}) {
    const scope = scopeOf(input);
    if (!scope) return { ok: false, code: 'unbound' };
    const content = String(input.content ?? '').trim();
    if (!content) return { ok: false, code: 'invalid-input', error: 'content is required' };
    const payload = {
      namespace: String(input.namespace ?? 'companion.event').slice(0, 60),
      content: content.slice(0, 2000),
      rootEvidenceIds: Array.isArray(input.rootEvidenceIds) ? input.rootEvidenceIds.map(String).slice(0, 32) : [],
      transformVersion: String(input.transformVersion ?? config.bridge?.transformVersion ?? 'v1').slice(0, 20),
      mentionPolicy: String(input.mentionPolicy ?? '').slice(0, 40),
    };
    // P2.5-2 (A4 §1.4 E1-c): additive structured facts. They live in the event payload (audit, UI,
    // tomorrow's plan) and are ignored by memory's whitelist — they are not a memory contract
    // change, and they never replace `content` as the thing a human reads.
    if (input.facts && typeof input.facts === 'object' && !Array.isArray(input.facts)) {
      payload.facts = input.facts;
    }
    // A4 §2.5 E2: the significance verdict travels with the request so memory can route on the
    // field instead of re-deriving P2 semantics.
    if (typeof input.significance === 'string' && input.significance.trim()) {
      payload.significance = input.significance.trim().slice(0, 24);
    }
    // Correction seam (A): name what this ingest replaces, in the payload the bridge forwards to
    // memory. Without it memory stores a plain new fact and the old one keeps coming back.
    if (typeof input.supersedesHint === 'string' && input.supersedesHint.trim()) {
      payload.supersedesHint = input.supersedesHint.trim().slice(0, 200);
    }
    // task-38: an operator decision names exact ids, never a text hint — it must not go through the
    // (deliberately) fail-closed matcher.
    if (Array.isArray(input.supersedeIds) && input.supersedeIds.length) {
      payload.supersedeIds = input.supersedeIds.map(value => String(value ?? '').trim()).filter(Boolean).slice(0, 10);
    }
    const kind = input.correction === true ? 'memory/correction-request' : 'memory/ingest-request';
    if (mode !== 'active') return shadowOrReject(kind, { namespace: payload.namespace, chars: payload.content.length, rootCount: payload.rootEvidenceIds.length }, { scopeKey: scopeKeyOf(scope) });
    return commitEvent({
      kind, scope, sessionId: input.sessionId ?? '', occurredAt: input.occurredAt ?? Number(clock()),
      payload, rootEvidenceIds: payload.rootEvidenceIds,
      realityStatus: input.realityStatus ?? 'hypothetical',
      evidenceStatus: input.evidenceStatus ?? 'inferred',
    });
  }

  /**
   * A4 §2.5 E2: was this exact subject already remembered *recently*?
   *
   * It re-uses `activitySignificance` on the stored rows instead of keeping a second notion of
   * "notable", so the dedupe rule can never drift from the significance rule. Bounded (7 days,
   * 10 rows) and read-only; a query failure means "not a repeat" (fail-open on the *dedupe* only —
   * the memory side still refuses anything it is told is routine).
   */
  /**
   * Did this outcome actually leave something behind? (lead ruling after soak F4)
   *
   * Only an outcome with content may become a **permanent memory** or reserve the subject's week. A
   * zero-progress attempt is still recorded as a fact (activity row, event, planner history) — it
   * just is not "something about the world worth remembering".
   */
  function traitProducedContent({ consumedPrefix = 0, artifactVersion = 0 } = {}) {
    return (Number(consumedPrefix) || 0) > 0 || (Number(artifactVersion) || 0) > 0;
  }

  function isRepeatOfRememberedOutcome({ scopeKey, kind, target, activityId, at }) {
    const subjectTarget = String(target ?? '').trim();
    if (!subjectTarget || !db) return false;
    const since = Math.max(0, Number(at) - 7 * 24 * 3600 * 1000);
    let rows = [];
    try {
      // soak F1 (task-41): the window used to be `status = 'done'` only, so "failed first, finished
      // later" on the same subject wrote **two** permanent memories — the failed one was invisible to
      // the dedupe that produced the finished one. The question this answers is "has this subject
      // already been remembered this week?", which has nothing to do with the row's status, so every
      // terminal outcome that **can** be notable is considered and each row is judged with its own
      // phase.
      //
      // task-46: `abandoned` is deliberately **not** in this list. `activitySignificance()` maps
      // `abandoned` to `routine`, so a row with that status can never make the predicate below true —
      // keeping it here made the condition look meaningful while it was a no-op, and one false
      // positive (a "kept for symmetry" status that does nothing) is worse than a shorter list. If
      // abandoned ever becomes notable, it has to be added back *together with* that change.
      rows = db.all(`SELECT kind, status, consumed_prefix, total_units, artifact_version FROM p2_activities
                     WHERE scope = ? AND kind = ? AND target = ?
                       AND status IN ('done', 'failed')
                       AND (consumed_prefix > 0 OR artifact_version > 0)
                       AND activity_id <> ? AND updated_at >= ?
                     ORDER BY updated_at DESC LIMIT 10`, scopeKey, kind, subjectTarget, activityId, since) ?? [];
    } catch { return false; }
    return rows.some(row => significanceOf({
      phase: row.status === 'failed' ? 'failed' : (row.status === 'abandoned' ? 'abandoned' : 'finished'),
      kind: row.kind,
      consumedPrefix: row.consumed_prefix,
      totalUnits: row.total_units,
      artifactVersion: row.artifact_version,
    }) === 'notable');
  }

  function observeSessionEvent(input = {}) {
    if (mode !== 'active') return { ok: false, code: 'runtime-inactive', mode };
    const scope = scopeOf(input);
    if (!scope) return { ok: false, code: 'unbound' };
    const amount = SESSION_IMPULSES[input.type];
    if (!Number.isFinite(amount)) return { ok: false, code: 'unsupported-event' };
    return commitEvent({ kind: 'state/impulse', scope, sessionId: input.sessionId ?? '', occurredAt: input.at ?? Number(clock()), payload: { amount, source: String(input.type) } });
  }

  // ---------------------------------------------------------------------------
  // H1 agenda + H2 zero-model heartbeat (C5 contract section 12)
  //
  // Everything below writes through the event path only: `dispatchEventChecked`
  // appends the event, runs the authoritative `agenda` reducer and lands the receipt,
  // projection version and agenda row in one transaction. Nothing here sends a
  // message, calls a model, touches the contact ledger, writes memory or takes over
  // the existing reminders runner.
  // ---------------------------------------------------------------------------

  const agendaEnabled = () => config.agenda?.enabled === true;
  const writersReady = () => Boolean(db) && writable && !stopped && !disposed && mode === 'active';

  /**
   * Renew our own writer lease **if the stored row is still ours and still unexpired**.
   *
   * This heals the ordinary "the renewal timer was a little late" case. It deliberately does
   * **not** revive an expired row (P2.5-4A): a process suspended past its TTL is no longer the
   * writer, and letting it renew would make it a ghost writer in the window before the next
   * owner takes over. The renewal then fails, `assertLeaseHeld` below refuses the commit with
   * `lease-expired`, and recovery is the next owner's job (A4 `acquireLease` takeover).
   */
  function renewWriterLeaseIfOwned() {
    if (!db || disposed || !writable) return false;
    try {
      const row = db.leaseRow?.() ?? null;
      if (!row || row.owner !== owner || row.generation !== generation) return false;
      const renewed = db.heartbeatLease({ owner, generation, ttlMs: config.leaseTtlMs });
      if (renewed) leaseInfo = { ...leaseInfo, expiresAt: Number(clock()) + config.leaseTtlMs };
      else heartbeatController?.noteLeaseRenewFailure?.('lease-expired');
      return renewed;
    } catch { return false; }
  }

  /** Full writer gate for one agenda commit: mode, switch, stop latch, owner+generation+lease. */
  function requireAgendaWriter() {
    if (disposed) throw new RuntimeError('runtime-disposed', 'the runtime is disposed');
    if (!db) throw new RuntimeError('runtime-off', 'the cognitive runtime is not mounted');
    if (!agendaEnabled()) throw new RuntimeError('agenda-disabled', 'the agenda switch is off');
    if (mode === 'shadow') throw new RuntimeError('runtime-inactive', 'shadow mode does not write the authoritative agenda');
    if (mode !== 'active') throw new RuntimeError('runtime-disabled', `runtime mode is ${mode}`);
    if (stopped) throw new RuntimeStoppedError();
    renewWriterLeaseIfOwned();
    db.assertLeaseHeld({ owner, generation, at: Number(clock()) });
    return true;
  }

  function dispatchEventChecked(input) {
    const event = normalizeEvent({ occurredAt: Number(clock()), ...input });
    // The owner+generation+lease check runs inside the append transaction (A1): a
    // pre-check alone would leave a takeover window between the check and the commit.
    const outcome = dispatchEvent(db, event, {
      handlers, generation, owner,
      guard: () => db.assertLeaseHeld({ owner, generation, at: Number(clock()) }),
      // The agenda is a single-authority aggregate: an append whose reducer failed would be
      // applied by replay but never happened live, and the retry would append a near-duplicate
      // that replay then rejects for ever. Roll back instead (review pass 2, BLOCK-2).
      requireConsumers: true,
    });
    const failure = outcome.results.find(result => result.error);
    if (outcome.rejected) {
      throw new RuntimeError(failure?.code ?? 'event-rejected', failure?.error ?? 'the authoritative consumer rejected the event', { results: outcome.results });
    }
    // dispatchEvent may return a consumer failure instead of throwing. A caller must
    // never treat "no throw" as success, so surface it as a typed failure.
    if (failure) throw new RuntimeError(failure.code ?? 'consumer-failed', failure.error ?? 'a consumer failed');
    return { ok: true, eventId: event.eventId, inserted: outcome.inserted, seq: outcome.seq, results: outcome.results };
  }

  /** Async twin of `agendaTry`: same typed-failure mapping for P2 activity calls. */
  async function agendaTryAsync(fn) {
    try {
      return await fn();
    } catch (error) {
      const runtimeError = asRuntimeError(error);
      noteError(runtimeError.code, runtimeError.message);
      const code = runtimeError.code === 'invalid-input' && /^invalid-timezone/.test(runtimeError.message) ? 'invalid-timezone' : runtimeError.code;
      return { ok: false, code, error: runtimeError.message };
    }
  }

  /** Run one agenda write, mapping the typed failure to a code instead of throwing at the tool boundary. */
  function agendaTry(fn) {
    try {
      return fn();
    } catch (error) {
      const runtimeError = asRuntimeError(error);
      noteError(runtimeError.code, runtimeError.message);
      // The contract names invalid-timezone as a passthrough rejection code; the domain layer
      // raises it as a ValidationError whose message starts with that prefix (review N1).
      const code = runtimeError.code === 'invalid-input' && /^invalid-timezone/.test(runtimeError.message) ? 'invalid-timezone' : runtimeError.code;
      return { ok: false, code, error: runtimeError.message };
    }
  }

  /** Public view of one agenda definition (the domain shape comes from lib/agenda.mjs). */
  function agendaRowToItem(item) {
    if (!item) return null;
    return {
      itemId: item.itemId,
      revision: Number(item.revision),
      title: item.title,
      category: item.category,
      source: item.source,
      rule: item.rule,
      timeZone: item.timeZone,
      localDate: item.date ?? '',
      localTime: item.time ?? '',
      weekdays: item.weekdays ?? [],
      atUtc: item.atUtc ?? null,
      validFrom: Number(item.validFrom),
      validUntil: item.validUntil ?? null,
      status: item.status,
      authorization: item.authorization,
      delivery: 'none',
      goalRef: item.goalRef ?? '',
      commitmentRef: item.commitmentRef ?? '',
      // Delivery capability is a fact, not a promise: the existing reminders runner owns
      // sending, and H1 has no second sender (C5 §12.4 rule 5 / A1-B1).
      reminderDelivery: item.authorization === 'reminder' ? 'not-wired' : 'n/a',
      updatedAt: Number(item.updatedAt ?? 0),
    };
  }

  function agendaRowToOccurrence(occurrence, timeZone) {
    if (!occurrence) return null;
    const zone = timeZone ?? config.timeZone;
    return {
      occurrenceId: occurrence.occurrenceId,
      itemId: occurrence.itemId,
      slotKey: occurrence.slotKey,
      definitionRevision: Number(occurrence.definitionRevision),
      scheduledAt: Number(occurrence.scheduledAt),
      scheduledLocal: formatInstant(Number(occurrence.scheduledAt), zone),
      timeZone: zone,
      slotEndAt: occurrence.slotEndAt ?? null,
      status: occurrence.status,
      reasonCode: occurrence.reasonCode ?? '',
      revision: Number(occurrence.revision),
      attempts: Number(occurrence.attempts ?? 0),
    };
  }

  /** Rebuild the normalizeDefinition input from a stored domain item (used by edit/reconcile). */
  function agendaDefinitionFromRow(item) {
    return {
      title: item.title,
      category: item.category,
      source: item.source,
      rule: item.rule,
      timeZone: item.timeZone,
      date: item.date ?? '',
      time: item.time ?? '',
      weekdays: item.weekdays ?? [],
      validFrom: Number(item.validFrom),
      validUntil: item.validUntil ?? null,
      authorization: item.authorization,
      goalRef: item.goalRef ?? '',
      commitmentRef: item.commitmentRef ?? '',
      // Reuse the stored key on update so an edit never collides with a later create.
      requestKey: item.requestKey,
    };
  }

  const AGENDA_PATCH_KEYS = Object.freeze(['title', 'category', 'source', 'rule', 'timeZone', 'date', 'time', 'weekdays', 'validFrom', 'validUntil', 'authorization', 'goalRef', 'commitmentRef']);

  /**
   * The identity of a create request. `validFrom` is deliberately excluded: it defaults
   * to "now", so including it would make every honest retry a different request and
   * defeat definition-level idempotency (A1).
   */
  function sameAgendaDefinition(left, right) {
    const pick = value => JSON.stringify({
      title: value.title, category: value.category, rule: value.rule, timeZone: value.timeZone,
      date: value.date, time: value.time, weekdays: [...(value.weekdays ?? [])].map(Number).sort((a, b) => a - b),
      atUtc: value.atUtc ?? null, validUntil: value.validUntil ?? null,
      authorization: value.authorization, goalRef: value.goalRef ?? '', commitmentRef: value.commitmentRef ?? '',
    });
    return pick(left) === pick(right);
  }

  function pickAgendaPatch(input = {}) {
    const patch = {};
    for (const key of AGENDA_PATCH_KEYS) {
      if (input[key] !== undefined && input[key] !== null) patch[key] = input[key];
    }
    return patch;
  }

  /**
   * Find the active definition that "is" this create request. Base keys are
   * content-addressed, but a plan re-arranged after a cancellation keeps a suffixed key
   * (`<base>#<hex>`), so a retry has to match that suffix family as well — otherwise every
   * retry would mint yet another definition (review pass 2, BLOCK-1).
   */
  function findActiveAgendaDefinition(scopeKey, definition) {
    const base = String(definition.requestKey ?? '');
    if (!base) return null;
    // Escape LIKE wildcards: content-addressed keys legitimately contain '_' and could contain '%'.
    const pattern = `${base.replace(/[\\%_]/g, match => `\\${match}`)}#%`;
    const rows = db.all("SELECT item_id FROM agenda_items WHERE scope = ? AND status = 'active' AND (request_key = ? OR request_key LIKE ? ESCAPE '\\') ORDER BY created_at ASC, item_id ASC", scopeKey, base, pattern);
    for (const row of rows) {
      const item = getAgendaItem(db, scopeKey, row.item_id);
      if (item && sameAgendaDefinition(agendaDefinitionFromRow(item), definition)) return item;
    }
    return null;
  }

  function agendaPatchToken(scopeKey, itemId, expectedRevision, definition) {
    return digest({
      scopeKey, itemId, expectedRevision,
      title: definition.title, category: definition.category, rule: definition.rule, timeZone: definition.timeZone,
      date: definition.date, time: definition.time, weekdays: definition.weekdays, validFrom: definition.validFrom,
      validUntil: definition.validUntil, authorization: definition.authorization,
      goalRef: definition.goalRef, commitmentRef: definition.commitmentRef,
    }, 32);
  }

  function agendaHorizon(now) {
    const hours = Math.max(1, Number(config.agenda.generationHorizonHours) || 72);
    return Number(now) + hours * 3600 * 1000;
  }

  /**
   * Materialise the bounded near-future window for one persisted scope. Only slots
   * that have no row at all are created: a cancelled/skipped/expired slot is terminal
   * and is never revived by a regenerate pass (C5 §12.4 rule 3).
   */
  function materializeAgendaScope(scopeKey, { scope = null, now = Number(clock()), to = null, limit = null } = {}) {
    const report = { generated: 0, daylightSkipped: 0, planned: 0, errors: [] };
    if (!writersReady()) return report;
    const resolvedScope = scope ?? parseScope(scopeKey);
    if (!resolvedScope) return report;
    const at = Number(now);
    const until = Number(to ?? agendaHorizon(at));
    const maxNew = Math.max(0, Number(limit ?? config.agenda.maxGeneratePerCall) || 0);
    if (maxNew === 0) return report;
    let items;
    try {
      items = activeAgendaItems(db, { scopeKey, at, limit: config.agenda.maxItemsPerScope });
    } catch (error) {
      noteError('agenda-plan-failed', error instanceof Error ? error.message : String(error));
      return report;
    }
    const existing = new Set(db.all('SELECT item_id, slot_key FROM agenda_occurrences WHERE scope = ?', scopeKey)
      .map(row => `${row.item_id}\u0000${row.slot_key}`));
    for (const item of items) {
      if (report.generated >= maxNew) break;
      let slots;
      try {
        slots = planAgendaWindow({ item, from: at, to: until, limit: maxNew, now: at });
      } catch (error) {
        noteError('agenda-plan-failed', error instanceof Error ? error.message : String(error));
        continue;
      }
      report.planned += slots.length;
      for (const slot of slots) {
        if (report.generated >= maxNew) break;
        if (slot.skipped) { report.daylightSkipped += 1; continue; }
        const key = `${item.itemId}\u0000${slot.slotKey}`;
        if (existing.has(key)) continue;
        const outcome = agendaTry(() => dispatchEventChecked({
          kind: 'agenda/occurrence-generated',
          scope: resolvedScope,
          // Deterministic instant (A1-B2): a retry after a transient failure must keep the
          // same eventId so it lands the receipt instead of appending a second event.
          occurredAt: Number(slot.scheduledAt),
          payload: {
            occurrenceId: occurrenceIdFor(scopeKey, item.itemId, slot.slotKey),
            itemId: item.itemId,
            slotKey: slot.slotKey,
            definitionRevision: Number(item.revision),
            scheduledAt: Number(slot.scheduledAt),
            slotEndAt: slot.slotEndAt === undefined || slot.slotEndAt === null ? null : Number(slot.slotEndAt),
            resolution: String(slot.resolution ?? 'exact'),
          },
        }));
        if (outcome.ok) {
          // An idempotent duplicate is not a new slot (review N7).
          if (outcome.inserted !== false) report.generated += 1;
          existing.add(key);
        } else if (['duplicate-occurrence', 'slot-terminal', 'reschedule-required'].includes(outcome.code)) {
          // Somebody already materialised it (or it is terminal): not an error.
          existing.add(key);
        } else {
          report.errors.push(outcome.code);
          break;
        }
      }
    }
    return report;
  }

  /**
   * Reconcile unexecuted future slots against a changed definition: reschedule a slot
   * that still exists in the plan (same stable slot key), explicitly cancel the ones
   * that no longer exist. Terminal history is never touched, so no ghost due items.
   */
  function reconcileAgendaOccurrences(scope, scopeKey, item, now) {
    const result = { rescheduled: 0, cancelled: 0, errors: [] };
    if (!writersReady()) return result;
    const at = Number(now);
    let planned;
    try {
      planned = planAgendaWindow({ item, from: at, to: agendaHorizon(at), limit: config.agenda.maxGeneratePerCall, now: at });
    } catch (error) {
      result.errors.push(error?.code ?? 'plan-failed');
      return result;
    }
    const plannedBySlot = new Map();
    for (const slot of planned) if (!slot.skipped) plannedBySlot.set(slot.slotKey, slot);
    const rows = db.all("SELECT * FROM agenda_occurrences WHERE scope = ? AND item_id = ? AND status IN ('scheduled','due') AND scheduled_at > ?", scopeKey, item.itemId, at);
    for (const row of rows) {
      const want = plannedBySlot.get(row.slot_key);
      if (!want) {
        // A `due` occurrence already reached its time; it stays due and is settled by the
        // heartbeat. Only unexecuted future slots are cancelled here.
        if (row.status !== 'scheduled') continue;
        const cancelled = agendaTry(() => dispatchEventChecked({
          kind: 'agenda/occurrence-cancelled',
          scope, occurredAt: Number(row.scheduled_at),
          payload: { occurrenceId: row.occurrence_id, expectedRevision: Number(row.revision), reason: 'definition-updated' },
        }));
        if (cancelled.ok) result.cancelled += 1; else result.errors.push(cancelled.code);
        continue;
      }
      if (Number(row.scheduled_at) === Number(want.scheduledAt)) continue;
      const moved = agendaTry(() => dispatchEventChecked({
        kind: 'agenda/occurrence-rescheduled',
        scope, occurredAt: Number(want.scheduledAt),
        payload: {
          occurrenceId: row.occurrence_id,
          expectedRevision: Number(row.revision),
          scheduledAt: Number(want.scheduledAt),
          slotEndAt: want.slotEndAt === undefined || want.slotEndAt === null ? null : Number(want.slotEndAt),
          definitionRevision: Number(item.revision),
          reason: 'definition-updated',
        },
      }));
      if (moved.ok) result.rescheduled += 1; else result.errors.push(moved.code);
    }
    return result;
  }

  /**
   * The occurrence that belongs to **this** schedule definition — resolved by identity, never by
   * looking for a nearby instant.
   *
   * The occurrence id is content-addressed from (scope, itemId, slotKey), so the definition's own
   * slot key names exactly one row. Preference order:
   *   1. the row whose id equals the computed one → `chosen: 'slot'` (exact, no ambiguity);
   *   2. the only row the item has               → `chosen: 'only'`;
   *   3. nothing matches                         → `occurrence: null`, `chosen: 'none'`.
   * Pattern rules (daily/weekly) with several future slots are deliberately **not** guessed: a
   * reminder is one instant, and a wrong binding would make every later CAS compare the wrong
   * revision — worse than no binding, because it would look verified.
   */
  function occurrenceForDefinition(scopeKey, itemId, definition, timeZone, now) {
    const occurrences = agendaOccurrencesFor(scopeKey, itemId, timeZone, now);
    if (occurrences.length === 0) return { occurrence: null, chosen: 'none', occurrences };
    let slotKey = '';
    try { slotKey = slotKeyFor(definition); } catch { slotKey = ''; }
    const expectedId = slotKey ? occurrenceIdFor(scopeKey, itemId, slotKey) : '';
    const exact = expectedId ? occurrences.find(entry => entry.occurrenceId === expectedId) ?? null : null;
    if (exact) {
      return {
        occurrence: { id: exact.occurrenceId, revision: Number(exact.revision), dueAt: Number(exact.scheduledAt) },
        chosen: 'slot', occurrences,
      };
    }
    if (occurrences.length === 1) {
      const only = occurrences[0];
      return {
        occurrence: { id: only.occurrenceId, revision: Number(only.revision), dueAt: Number(only.scheduledAt) },
        chosen: 'only', occurrences,
      };
    }
    return { occurrence: null, chosen: 'none', occurrences };
  }

  function createSchedule(input = {}) {
    const scope = scopeOf(input);
    if (!scope) return { ok: false, code: 'unbound' };
    const scopeKey = scopeKeyOf(scope);
    if (disposed) return { ok: false, code: 'runtime-disposed' };
    if (!db) return { ok: false, code: 'runtime-off' };
    if (!agendaEnabled()) return { ok: false, code: 'agenda-disabled', enabled: false };
    if (mode !== 'active') return shadowOrReject('agenda/created', { rule: input.rule ?? null, chars: String(input.title ?? '').length }, { scopeKey });
    return agendaTry(() => {
      requireAgendaWriter();
      const now = Number(clock());
      let definition = normalizeAgendaDefinition({ ...input, source: input.source ?? 'tool' }, { now });
      // Only an *active* definition owns its idempotency key: after a cancellation the user
      // may legitimately arrange the same plan again, which must mint a new itemId instead of
      // resurrecting the cancelled definition (C5 §12.4 rule 3). A re-arranged plan keeps a
      // suffixed key, so the lookup below must also match those suffixes — otherwise every
      // retry after a cancellation would mint yet another definition (review pass 2, BLOCK-1).
      const activeMatch = findActiveAgendaDefinition(scopeKey, definition);
      if (activeMatch) {
        const report = materializeAgendaScope(scopeKey, { scope, now });
        const resolved = occurrenceForDefinition(scopeKey, activeMatch.itemId, definition, activeMatch.timeZone, now);
        return {
          ok: true, enabled: true, idempotent: true, itemId: activeMatch.itemId, revision: Number(activeMatch.revision),
          item: agendaRowToItem(activeMatch),
          occurrences: resolved.occurrences,
          occurrence: resolved.occurrence,
          chosen: resolved.chosen,
          generated: report.generated,
        };
      }
      // An active definition stored under exactly this key but with a different plan means the
      // caller supplied a requestKey it did not really own: refuse instead of duplicating.
      const exactActive = db.get("SELECT item_id FROM agenda_items WHERE scope = ? AND request_key = ? AND status = 'active'", scopeKey, definition.requestKey);
      if (exactActive) {
        return { ok: false, code: 'request-key-conflict', itemId: exactActive.item_id, requestKey: definition.requestKey };
      }
      // A terminal definition still holds the stored key row: mint a fresh key for the new
      // definition instead of violating the unique index.
      if (db.get('SELECT item_id FROM agenda_items WHERE scope = ? AND request_key = ?', scopeKey, definition.requestKey)) {
        definition = normalizeAgendaDefinition({ ...input, source: input.source ?? 'tool', requestKey: `${definition.requestKey}#${crypto.randomBytes(4).toString('hex')}` }, { now });
      }
      const itemId = `ag_${digest({ scopeKey, requestKey: definition.requestKey }, 20)}`;
      const prior = db.get("SELECT payload, occurred_at FROM domain_events WHERE kind = 'agenda/created' AND scope = ? AND json_extract(payload, '$.itemId') = ? ORDER BY seq ASC LIMIT 1", scopeKey, itemId);
      if (prior) {
        // An append that committed without its receipt left an event-only creation. Replay
        // that exact event instead of appending a near-duplicate.
        const priorPayload = safeJson(prior.payload, null);
        if (!priorPayload?.item || !sameAgendaDefinition(priorPayload.item, definition)) {
          return { ok: false, code: 'request-key-conflict', itemId, requestKey: definition.requestKey };
        }
        dispatchEventChecked({ kind: 'agenda/created', scope, sessionId: input.sessionId ?? '', occurredAt: Number(prior.occurred_at), payload: priorPayload });
      } else {
        dispatchEventChecked({
          kind: 'agenda/created',
          scope,
          sessionId: input.sessionId ?? '',
          occurredAt: now,
          payload: { itemId, requestKey: definition.requestKey, item: { ...definition, itemId, revision: 1, createdAt: now } },
        });
      }
      const report = materializeAgendaScope(scopeKey, { scope, now });
      const row = getAgendaItem(db, scopeKey, itemId);
      const resolved = occurrenceForDefinition(scopeKey, itemId, definition, row?.time_zone ?? definition.timeZone, now);
      return {
        ok: true, enabled: true, idempotent: false, itemId, revision: 1,
        item: agendaRowToItem(row),
        occurrences: resolved.occurrences,
        occurrence: resolved.occurrence,
        chosen: resolved.chosen,
        generated: report.generated,
        daylightSkipped: report.daylightSkipped,
        reminderDelivery: definition.authorization === 'reminder' ? 'not-wired' : 'n/a',
        delivery: 'none',
      };
    });
  }

  function agendaOccurrencesFor(scopeKey, itemId, timeZone, now) {
    try {
      return listAgendaOccurrences(db, { scopeKey, itemId, from: Number(now) - 86400 * 1000, to: agendaHorizon(now) + 86400 * 1000, limit: 200 })
        .map(row => agendaRowToOccurrence(row, timeZone));
    } catch { return []; }
  }

  function updateSchedule(input = {}) {
    const scope = scopeOf(input);
    if (!scope) return { ok: false, code: 'unbound' };
    const scopeKey = scopeKeyOf(scope);
    if (disposed) return { ok: false, code: 'runtime-disposed' };
    if (!db) return { ok: false, code: 'runtime-off' };
    if (!agendaEnabled()) return { ok: false, code: 'agenda-disabled', enabled: false };
    const itemId = String(input.itemId ?? '').trim();
    if (!itemId) return { ok: false, code: 'invalid-input', error: 'itemId is required' };
    if (mode !== 'active') return shadowOrReject('agenda/updated', { itemId }, { scopeKey, expectedRevision: input.expectedRevision ?? null });
    return agendaTry(() => {
      requireAgendaWriter();
      const now = Number(clock());
      const row = getAgendaItem(db, scopeKey, itemId);
      if (!row) return { ok: false, code: 'item-not-found', itemId };
      const expected = Number(input.expectedRevision);
      if (!Number.isFinite(expected)) return { ok: false, code: 'revision-required', currentRevision: Number(row.revision) };
      if (expected !== Number(row.revision)) return { ok: false, code: 'stale-revision', currentRevision: Number(row.revision) };
      if (row.status !== 'active') return { ok: false, code: 'terminal-item', status: row.status };
      const patch = pickAgendaPatch(input.patch ?? input);
      if (!Object.keys(patch).length) return { ok: false, code: 'invalid-input', error: 'empty patch' };
      const merged = { ...agendaDefinitionFromRow(row), ...patch };
      const definition = normalizeAgendaDefinition(merged, { now });
      const nextRevision = expected + 1;
      const token = agendaPatchToken(scopeKey, itemId, expected, definition);
      const timeZoneChanged = definition.timeZone !== row.timeZone;
      // A timezone change is the one edit that silently rewrites every future instant, so
      // it needs an explicit preview handshake before it is committed (C5 §12.4 rule 3).
      const preview = {
        itemId, currentRevision: expected, nextRevision, timeZoneChanged,
        from: row.timeZone, to: definition.timeZone,
        previewToken: token,
        futurePlanned: (() => {
          try {
            return planAgendaWindow({ item: { ...agendaRowToItem(row), ...definition, status: 'active', revision: nextRevision }, from: now, to: agendaHorizon(now), limit: config.agenda.maxGeneratePerCall, now })
              .map(slot => ({ slotKey: slot.slotKey, scheduledAt: slot.scheduledAt, local: formatInstant(slot.scheduledAt, definition.timeZone), skipped: slot.skipped === true, reason: slot.reason ?? null }));
          } catch { return []; }
        })(),
      };
      if (timeZoneChanged) {
        if (!input.previewToken) return { ok: false, code: 'preview-required', preview };
        if (String(input.previewToken) !== token) return { ok: false, code: 'preview-stale', preview };
      } else if (input.previewToken && String(input.previewToken) !== token) {
        return { ok: false, code: 'preview-stale', preview };
      }
      const patchPayload = {};
      for (const key of Object.keys(patch)) {
        if (JSON.stringify(patch[key]) !== JSON.stringify(agendaDefinitionFromRow(row)[key])) patchPayload[key] = patch[key];
      }
      patchPayload.rule = definition.rule;
      patchPayload.timeZone = definition.timeZone;
      patchPayload.date = definition.date;
      patchPayload.time = definition.time;
      patchPayload.weekdays = definition.weekdays;
      patchPayload.validUntil = definition.validUntil;
      dispatchEventChecked({
        kind: 'agenda/updated',
        scope, sessionId: input.sessionId ?? '', occurredAt: now,
        payload: { itemId, expectedRevision: expected, nextRevision, patch: patchPayload, updatedAt: now, resolution: definition.resolution },
      });
      const updated = getAgendaItem(db, scopeKey, itemId);
      const reconciled = reconcileAgendaOccurrences(scope, scopeKey, agendaRowToItem(updated), now);
      const report = materializeAgendaScope(scopeKey, { scope, now });
      return {
        ok: true, enabled: true, previewRequired: false, timeZoneChanged,
        item: agendaRowToItem(updated),
        occurrences: agendaOccurrencesFor(scopeKey, itemId, updated.timeZone, now),
        rescheduled: reconciled.rescheduled, cancelled: reconciled.cancelled, generated: report.generated,
      };
    });
  }

  function cancelSchedule(input = {}) {
    const scope = scopeOf(input);
    if (!scope) return { ok: false, code: 'unbound' };
    const scopeKey = scopeKeyOf(scope);
    if (disposed) return { ok: false, code: 'runtime-disposed' };
    if (!db) return { ok: false, code: 'runtime-off' };
    if (!agendaEnabled()) return { ok: false, code: 'agenda-disabled', enabled: false };
    const itemId = String(input.itemId ?? '').trim();
    if (!itemId) return { ok: false, code: 'invalid-input', error: 'itemId is required' };
    if (mode !== 'active') return shadowOrReject('agenda/cancelled', { itemId }, { scopeKey, expectedRevision: input.expectedRevision ?? null });
    return agendaTry(() => {
      requireAgendaWriter();
      const now = Number(clock());
      const row = getAgendaItem(db, scopeKey, itemId);
      if (!row) return { ok: false, code: 'item-not-found', itemId };
      const expected = Number(input.expectedRevision);
      if (!Number.isFinite(expected)) return { ok: false, code: 'revision-required', currentRevision: Number(row.revision) };
      if (expected !== Number(row.revision)) return { ok: false, code: 'stale-revision', currentRevision: Number(row.revision) };
      if (row.status !== 'active') return { ok: false, code: 'terminal-item', status: row.status };
      dispatchEventChecked({
        kind: 'agenda/cancelled',
        scope, sessionId: input.sessionId ?? '', occurredAt: now,
        payload: { itemId, expectedRevision: expected, reason: String(input.reason ?? 'user-cancelled').slice(0, 120), now },
      });
      const updated = getAgendaItem(db, scopeKey, itemId);
      const cancelled = Number(db.get("SELECT COUNT(*) AS n FROM agenda_occurrences WHERE scope = ? AND item_id = ? AND status = 'cancelled'", scopeKey, itemId)?.n ?? 0);
      return {
        ok: true, enabled: true, item: agendaRowToItem(updated), cancelledOccurrences: cancelled,
        occurrences: agendaOccurrencesFor(scopeKey, itemId, updated.timeZone, now),
        // Cancelling a schedule removes a plan, not a reminder: nothing is unsent, because
        // nothing was ever sent by this module.
        reminderDelivery: 'not-wired',
      };
    });
  }

  /**
   * 3A-4: "is this plan still the plan?" — called by the reminder side immediately before sending.
   *
   * Read-only: it never writes a row. It returns the current occurrence state so the caller sends
   * with the values it just verified, and a typed refusal otherwise (`revision-changed` carries
   * `actualRevision` so the caller can re-read instead of guessing).
   */
  function casOccurrence(input = {}) {
    if (disposed) return { ok: false, code: 'disabled' };
    if (!db) return { ok: false, code: 'not-found' };
    if (!agendaEnabled()) return { ok: false, code: 'disabled' };
    const scope = scopeOf(input);
    if (!scope) return { ok: false, code: 'not-found' };
    return casOccurrenceOf(db, {
      scopeKey: scopeKeyOf(scope),
      occurrenceId: input.occurrenceId,
      revision: input.revision,
      at: Number(input.at ?? clock()),
      enabled: true,
    });
  }

  /**
   * 3A-5: "record that the reminder really went out" — the receipt plus the authoritative event.
   *
   * Idempotent per (occurrenceId, revision). This does **not** make reminder delivery wired: the
   * sending itself stays with the existing reminder channel (CONTRACT §13.8), and
   * `reminderDelivery` is still reported as `not-wired` everywhere.
   */
  function markOccurrenceDispatched(input = {}) {
    if (disposed) return { ok: false, code: 'disabled' };
    if (!db) return { ok: false, code: 'not-found' };
    if (!agendaEnabled()) return { ok: false, code: 'disabled' };
    const scope = scopeOf(input);
    if (!scope) return { ok: false, code: 'not-found' };
    const scopeKey = scopeKeyOf(scope);
    return agendaTry(() => {
      requireAgendaWriter();
      return markOccurrenceDispatchedOf(db, {
        scopeKey,
        occurrenceId: input.occurrenceId,
        revision: input.revision,
        at: Number(input.at ?? clock()),
        receipt: input.receipt,
        consumer: input.consumer ?? 'reminders',
        enabled: true,
        emit: event => dispatchEventChecked({ ...event, scope, sessionId: input.sessionId ?? '' }),
      });
    });
  }

  /**
   * The *next* occurrence of a recurring schedule (P2.5 3A-4, third seam method).
   *
   * A reminder that repeats asks this every round: the channel advances its own `at`, and without a
   * next occurrence it would keep CAS-ing against a revision that a past dispatch already moved —
   * the second round would look like a stale plan and land in `unknown`.
   *
   * The answer is **read out of the agenda**, never invented: occurrences are materialised by the
   * existing reducer (`materializeAgendaScope`), whose ids are content-addressed from
   * (scope, itemId, slotKey). So "the same (scheduleId, dueAt)" maps to the same row by construction
   * — calling this twice cannot append a second occurrence or a second event.
   *
   * Codes: `not-recurring` (a `once` schedule has no next), `exhausted` (the rule produces nothing
   * more), `not-found`, `disabled`.
   */
  function nextOccurrence(input = {}) {
    if (disposed) return { ok: false, code: 'not-found' };
    if (!db) return { ok: false, code: 'not-found' };
    if (!agendaEnabled()) return { ok: false, code: 'disabled' };
    const scope = scopeOf(input);
    if (!scope) return { ok: false, code: 'not-found' };
    const scopeKey = scopeKeyOf(scope);
    const occurrenceId = String(input.occurrenceId ?? '').trim();
    if (!occurrenceId) return { ok: false, code: 'not-found' };
    const row = db.get(`SELECT occurrence_id, item_id, scheduled_at, revision, status
                         FROM agenda_occurrences WHERE scope = ? AND occurrence_id = ?`, scopeKey, occurrenceId);
    if (!row) return { ok: false, code: 'not-found' };
    const item = getAgendaItem(db, scopeKey, row.item_id);
    if (!item) return { ok: false, code: 'not-found' };
    // `getAgendaItem` returns the mapped item (`rule`); raw rows carry `rule_kind`. Accept both so
    // this cannot silently fall through to `exhausted` for a one-off schedule.
    const rule = String(item.rule ?? item.rule_kind ?? '');
    if (rule === 'once') return { ok: false, code: 'not-recurring', itemId: row.item_id };
    const from = Number(input.at ?? clock());
    const after = Math.max(Number(row.scheduled_at) || 0, Number(from) || 0);
    const view = candidate => ({
      id: candidate.occurrenceId,
      scheduleId: candidate.itemId,
      dueAt: Number(candidate.scheduledAt),
      revision: Number(candidate.revision),
      status: String(candidate.status ?? ''),
    });
    const pick = () => listAgendaOccurrences(db, { scopeKey, itemId: row.item_id, from: after + 1, to: agendaHorizon(after) + 7 * 86400 * 1000, limit: 64 })
      .filter(candidate => Number(candidate.scheduledAt) > after)
      .sort((a, b) => Number(a.scheduledAt) - Number(b.scheduledAt))[0] ?? null;
    let found = pick();
    if (!found) {
      // The horizon may simply not have been materialised yet. Extend it once through the existing
      // writer (idempotent), then read again: still nothing ⇒ the rule is exhausted.
      try { materializeAgendaScope(scopeKey, { scope, now: after }); } catch (error) { noteError('agenda-next-materialize-failed', error instanceof Error ? error.message : String(error)); }
      found = pick();
    }
    if (!found) return { ok: false, code: 'exhausted', itemId: row.item_id };
    return { ok: true, occurrence: view(found) };
  }

  function listSchedule(input = {}) {
    if (disposed) return { ok: false, code: 'runtime-disposed' };
    if (!db) return { ok: false, code: 'runtime-off' };
    if (!agendaEnabled()) return { ok: true, enabled: false, state: 'disabled', timeZone: config.timeZone, items: [], occurrences: [], generated: 0 };
    if (mode === 'off') return { ok: false, code: 'runtime-disabled' };
    const scope = scopeOf(input);
    if (!scope) return { ok: false, code: 'unbound' };
    const scopeKey = scopeKeyOf(scope);
    const now = Number(clock());
    let generated = 0;
    if (writersReady()) {
      try { generated = materializeAgendaScope(scopeKey, { scope, now }).generated; } catch (error) { noteError('agenda-materialize-failed', error instanceof Error ? error.message : String(error)); }
    }
    const from = Number.isFinite(input.from) ? Number(input.from) : now - 86400 * 1000;
    const to = Number.isFinite(input.to) ? Number(input.to) : now + Math.min(90, Number(config.agenda.querySpanDays) || 14) * 86400 * 1000;
    const items = listAgendaItems(db, { scopeKey, status: input.status, limit: input.limit ?? config.agenda.maxItemsPerScope }).map(agendaRowToItem);
    const byItem = new Map(items.map(item => [item.itemId, item.timeZone]));
    const occurrences = listAgendaOccurrences(db, { scopeKey, from, to, statuses: input.statuses, limit: Number(input.occurrenceLimit ?? 400) })
      .map(row => agendaRowToOccurrence(row, byItem.get(row.itemId)));
    return { ok: true, enabled: true, state: mode === 'active' ? 'active' : mode, timeZone: config.timeZone, generated, items, occurrences };
  }

  function todaySchedule(input = {}) {
    const listed = listSchedule({ ...input, from: Number(clock()) - 2 * 86400 * 1000, to: Number(clock()) + 2 * 86400 * 1000, occurrenceLimit: 400 });
    if (!listed.ok || !listed.enabled) return listed;
    const now = Number(clock());
    const requested = String(input.date ?? '').trim();
    if (requested && !/^\d{4}-\d{2}-\d{2}$/.test(requested)) return { ok: false, code: 'invalid-input', error: 'date must be YYYY-MM-DD' };
    const groups = [];
    const flat = [];
    for (const item of listed.items) {
      // "Today" is resolved in the schedule's own zone, so a 00:30 Asia/Shanghai item is
      // still tomorrow's item while the host clock is on the previous UTC day.
      const localDate = requested || localDateString(now, item.timeZone);
      const occurrences = listed.occurrences
        .filter(row => row.itemId === item.itemId && localDateString(row.scheduledAt, item.timeZone) === localDate)
        .sort((a, b) => a.scheduledAt - b.scheduledAt);
      if (!requested || occurrences.length) groups.push({ itemId: item.itemId, title: item.title, timeZone: item.timeZone, localDate, status: item.status, authorization: item.authorization, reminderDelivery: item.reminderDelivery, occurrences });
      flat.push(...occurrences);
    }
    return {
      ok: true, enabled: true, state: listed.state, timeZone: config.timeZone, requestedDate: requested || null,
      localDates: [...new Set(groups.map(group => group.localDate))], items: groups, occurrences: flat, generated: listed.generated,
    };
  }

  // ---------------------------------------------------------------------------
  // H2: rule heartbeat controller
  // ---------------------------------------------------------------------------

  const agendaApi = Object.freeze({
    planWindow: planAgendaWindow,
    activeAgendaItems,
    dueAgendaOccurrences,
    agendaCounts,
    // Frozen-slot lookup so the heartbeat skips already-materialised slots instead of
    // relying on the reducer to reject a duplicate (A1-B3).
    existingSlotKeys: (scopeKey, itemId) => new Set(
      db.all('SELECT slot_key FROM agenda_occurrences WHERE scope = ? AND item_id = ?', scopeKey, itemId).map(row => row.slot_key),
    ),
  });

  function dispatchForHeartbeat(input = {}) {
    // The heartbeat owns no scope of its own: it may only act on an already-persisted
    // scope key handed to it by the query results (never a resolved session).
    const scope = input.scope ?? parseScope(input.scopeKey);
    if (!scope) throw new RuntimeError('unbound', 'heartbeat dispatch requires a persisted scope');
    requireAgendaWriter();
    return dispatchEventChecked({ ...input, scope });
  }

  /**
   * P2.5-1 (Slice A): the heartbeat's only window into P2 — a pair of closures, on purpose.
   *
   * The heartbeat is mounted *before* the P2 controller exists (see the two blocks below), and
   * the controller may fail to mount at all, so both halves must be lazy and must fail closed:
   *   - `p2Controller === null` → no due slots, and a claim answers `p2-unmounted`;
   *   - the P2 hooks themselves refuse when activities are disabled/paused or when this runtime
   *     is not the active writer, and they *name* the deferral instead of returning silently.
   *
   * **Two independent switches, and both must be on:**
   *   - `p2.activities.enabled` — an activity may run at all (this is the old, pre-P2.5 switch);
   *   - `p2.activities.dispatchEnabled` — the heartbeat may *claim* a due slot so the pump picks
   *     it up. This is the P2.5-1 gray-release switch and it defaults to **false** (plan §6: watch
   *     the due decisions in dry-run first). An installation that already had `enabled: true`
   *     therefore does **not** start dispatching just by upgrading the code.
   *
   * With no hook injected the heartbeat behaves exactly as it did before this slice, and it says
   * *why* it has no hook (`activityDispatchDisabled`) so diagnostics never answer "unavailable"
   * when the honest answer is "the operator has not turned the gray release on".
   */
  const activityDispatchWired = config.p2?.activities?.enabled === true && config.p2?.activities?.dispatchEnabled === true;
  const heartbeatActivityDispatch = activityDispatchWired
    ? {
      dueSlots: (input) => {
        if (!p2Controller) return { slots: [], deferred: 'p2-unmounted' };
        try {
          return p2Controller.dueSlotsForHeartbeat(input);
        } catch (error) {
          noteError('p2-due-slots-failed', error instanceof Error ? error.message : String(error));
          return { slots: [], deferred: 'due-query-failed' };
        }
      },
      claim: (input) => {
        if (!p2Controller) return { ok: false, code: 'p2-unmounted' };
        try {
          return p2Controller.claimSlotForHeartbeat(input);
        } catch (error) {
          const runtimeError = asRuntimeError(error);
          noteError(runtimeError.code, runtimeError.message);
          return { ok: false, code: runtimeError.code, error: runtimeError.message.slice(0, 160) };
        }
      },
    }
    : null;

  if (db) {
    try {
      heartbeatController = createHeartbeat({
        db,
        config,
        clock,
        owner,
        generation,
        dispatch: dispatchForHeartbeat,
        agenda: agendaApi,
        // `null` unless **both** the activities switch and the P2.5-1 gray switch are on. The
        // reason travels with it, so `status().activityDispatch` can tell "the operator has not
        // turned the gray release on" (`disabled-by-config`) apart from "there is no consumer at
        // all" (`unavailable`).
        activityDispatch: heartbeatActivityDispatch,
        activityDispatchDisabled: activityDispatchWired ? null : 'disabled-by-config',
        isActive: () => mode === 'active' && !stopped && !disposed && Boolean(db),
        isWritable: () => writable && !disposed && Boolean(db),
        onError: (code, detail) => noteError(code, detail),
      });
      if (config.heartbeat?.enabled === true && mode === 'active' && writable) heartbeatController.start();
    } catch (error) {
      noteError('heartbeat-mount-failed', error instanceof Error ? error.message : String(error));
      heartbeatController = null;
    }
  }

  // ---------------------------------------------------------------------------
  // P2: autonomous day + real activities (contract logs/p2-autonomous-day/contract-p2.md)
  // ---------------------------------------------------------------------------

  const p2ArtifactRoot = path.resolve(root, config.p2?.activities?.artifactRoot ?? 'home/companion/works');

  function p2Enabled() {
    return config.p2?.planning?.enabled === true || config.p2?.activities?.enabled === true;
  }

  /** Writer gate for P2 state: same lease/owner/generation rules as the agenda, own switch. */
  function requireAutonomyWriter() {
    if (disposed) throw new RuntimeError('runtime-disposed', 'the runtime is disposed');
    if (!db) throw new RuntimeError('runtime-off', 'the cognitive runtime is not mounted');
    if (!p2Enabled()) throw new RuntimeError('p2-disabled', 'the P2 autonomy switches are off');
    if (mode === 'shadow') throw new RuntimeError('runtime-inactive', 'shadow mode does not write autonomy state');
    if (mode !== 'active') throw new RuntimeError('runtime-disabled', `runtime mode is ${mode}`);
    if (stopped) throw new RuntimeStoppedError();
    renewWriterLeaseIfOwned();
    db.assertLeaseHeld({ owner, generation, at: Number(clock()) });
    return true;
  }

  function dispatchForAutonomy(input = {}) {
    // Only an already-persisted scope may be written to; a synthetic session is never turned
    // into an autonomous scope (same rule as the H2 heartbeat).
    const scope = input.scope ?? parseScope(input.scopeKey);
    if (!scope) throw new RuntimeError('unbound', 'autonomy dispatch requires a persisted scope');
    requireAutonomyWriter();
    const { scopeKey: _scopeKey, ...rest } = input;
    return dispatchEventChecked({ ...rest, scope });
  }

  /**
   * P2.5-1: the claim route used by the heartbeat (`autonomy/plan-slot` `planned → started`).
   *
   * It is deliberately the *same* event path and the *same* writer gate as
   * `dispatchForAutonomy` — there is exactly one append for that kind, so the claim cannot
   * become a second write path behind the autonomy consumer's back. The only thing it adds is
   * the activities switch: claiming a slot when nothing would ever execute it is not a claim,
   * it is an orphan (exactly the state A3 found in the production database).
   */
  function dispatchForActivity(input = {}) {
    if (config.p2?.activities?.enabled !== true) {
      throw new RuntimeError('activities-disabled', 'p2.activities.enabled is false; nothing would execute a claimed slot');
    }
    return dispatchForAutonomy(input);
  }

  /** Fixed appointments the planner must not schedule over (read-only H1 view). */
  function p2FixedAgenda({ scopeKey, from, to }) {
    try {
      return db.all(`SELECT o.occurrence_id, o.item_id, o.scheduled_at, o.slot_end_at, o.status, i.title, i.authorization
                     FROM agenda_occurrences o JOIN agenda_items i ON i.item_id = o.item_id AND i.scope = o.scope
                     WHERE o.scope = ? AND o.status IN ('scheduled','due','dispatched') AND o.slot_end_at > ? AND o.scheduled_at < ?
                     ORDER BY o.scheduled_at ASC LIMIT 20`, scopeKey, from, to)
        .map(row => ({
          occurrenceId: row.occurrence_id, itemId: row.item_id, startAt: Number(row.scheduled_at), endAt: Number(row.slot_end_at),
          title: String(row.title ?? '').slice(0, 120), authorization: row.authorization, status: row.status,
        }));
    } catch { return []; }
  }

  /** Bounded planning material. The planner enforces the character budget; we only bound rows. */
  /**
   * The planner's bounded belief view (E6).
   *
   * Three rules, all about not lying to the model:
   *   1. only `supported` claims — an `unknown` belief is a guess, and a plan must not be built on
   *      a guess;
   *   2. only the **current** version: `currentBeliefs` already drops rows superseded by a
   *      correction, so a corrected statement never comes back;
   *   3. bounded: at most `limit` items, each text truncated.
   * `corrected` is flagged so the prompt can tell the model "the user already fixed this".
   */
  function beliefsForPlanning(scopeKey, now, limit = 6) {
    try {
      const all = currentBeliefs(db, { scopeKey, now }) ?? [];
      const active = all.filter(belief => String(belief.status) === 'supported');
      return active.slice(0, Math.max(1, Math.trunc(Number(limit) || 6))).map(belief => ({
        beliefId: String(belief.beliefId ?? ''),
        proposition: String(belief.proposition ?? '').slice(0, 160),
        confidence: Number(belief.confidence) || 0,
        revision: Number(belief.revision) || 0,
        corrected: Boolean(belief.reason) || Number(belief.revision) > 1,
        reason: String(belief.reason ?? '').slice(0, 60),
      }));
    } catch { return []; }
  }

  /**
   * E4: the goals/open-commitments snapshot the planning materials use.
   *
   * Bounded on purpose — this runs on the planning path, so it is a fixed-size read, not a query
   * that grows with the user's history. Only *open* work is exposed: a completed goal is history
   * (and the runtime already feeds history to the planner through `recentOutcomes`), while a
   * cancelled one is noise. Text is truncated for the same reason.
   */
  function continuitySnapshot(input = {}) {
    // Accept a bare `scopeKey` (like `p2Status` and the other P2 reads): the materials port has a
    // scope key, not a session, and requiring a session would have made this silently `unbound`.
    const scope = input?.scope ?? (input?.scopeKey ? parseScope(input.scopeKey) : scopeOf(input));
    if (!scope) return { ok: false, code: 'unbound' };
    if (!db) return { ok: false, code: 'runtime-off' };
    if (mode !== 'active') return { ok: false, code: 'runtime-inactive', mode };
    const scopeKey = scopeKeyOf(scope);
    const limit = Math.max(1, Math.min(12, Math.trunc(Number(input.limit) || 6)));
    const commitmentLimit = Math.max(1, Math.min(12, Math.trunc(Number(input.commitmentLimit) || 6)));
    const chars = Math.max(20, Math.min(400, Math.trunc(Number(input.maxChars) || 120)));
    const cut = value => String(value ?? '').slice(0, chars);
    let goals = [];
    let commitments = [];
    try {
      goals = listGoals(db, { scopeKey, includeClosed: false, limit }).map(goal => ({
        goalId: String(goal.goalId ?? ''),
        title: cut(goal.title),
        status: String(goal.status ?? ''),
        nextStep: cut(goal.nextStep ?? ''),
        waitingOn: cut(goal.waitingOn ?? ''),
        deadlineAt: Number(goal.deadlineAt) || 0,
        revision: Number(goal.revision) || 0,
      }));
    } catch { goals = []; }
    try {
      commitments = listCommitments(db, { scopeKey, status: 'open' }).slice(0, commitmentLimit).map(item => ({
        commitmentId: String(item.commitmentId ?? ''),
        text: cut(item.text ?? item.body ?? item.title ?? ''),
        body: cut(item.text ?? item.body ?? item.title ?? ''),
        status: String(item.status ?? ''),
        dueAt: Number(item.dueAt) || 0,
      }));
    } catch { commitments = []; }
    return { ok: true, goals, commitments, source: 'runtime:goals' };
  }

  async function p2Materials({ scopeKey, day, now }) {
    const dayEnd = now + 36 * 3600 * 1000;
    const rows = (sql, ...params) => { try { return db.all(sql, ...params); } catch { return []; } };
    const base = {
      timeZone: config.timeZone || 'Asia/Shanghai',
      now,
      day,
      fixedAgenda: p2FixedAgenda({ scopeKey, from: now, to: dayEnd }),
      runningActivities: rows(`SELECT activity_id, kind, status, target, consumed_prefix, total_units, artifact_version
                                FROM p2_activities WHERE scope = ? AND status IN ('running','paused') ORDER BY updated_at DESC LIMIT 5`, scopeKey),
      blockedActivityTargets: [
        ...rows(`SELECT kind, target, checkpoint FROM (
                   SELECT kind, target, checkpoint,
                          ROW_NUMBER() OVER (PARTITION BY kind, target ORDER BY updated_at DESC) AS position
                   FROM p2_activities WHERE scope = ? AND status = 'paused'
                 ) WHERE position = 1 ORDER BY kind, target`, scopeKey)
          .filter(row => !canAutoResumeActivity(row.checkpoint))
          .map(({ kind, target }) => ({ kind, target })),
        // A same-day supplement should pick another source after a reading window was missed.
        ...rows(`SELECT DISTINCT activity AS kind, target_ref AS target
                 FROM p2_plan_slots s WHERE scope = ? AND day = ? AND status = 'expired'
                   AND activity IN ('read', 'explore') AND target_ref <> ''
                   AND NOT EXISTS (SELECT 1 FROM p2_activities a WHERE a.scope = s.scope AND a.plan_slot_id = s.slot_id)
                 ORDER BY kind, target`, scopeKey, day),
      ],
      finishedActivities: rows(`SELECT kind, target, consumed_prefix, total_units FROM p2_activities WHERE scope = ? AND status = 'done' ORDER BY updated_at DESC LIMIT 24`, scopeKey),
      // P2.5-2 (A4 §3.6 E3): "what actually happened recently", including the outcomes that are
      // not successes. `finishedActivities` stays done-only on purpose: it feeds the *hard exclude*
      // list, and excluding a source after one transient failure would lose it for ever (E4-c is
      // the "≥2 consecutive failures" rule and lives in the foundation's materials port).
      recentOutcomes: (() => {
        const activities = rows(`SELECT kind, target,
                                        CASE WHEN status = 'paused' THEN 'review' ELSE status END AS outcome,
                                        consumed_prefix, total_units, artifact_version, updated_at AS at, activity_id AS source_id
                                  FROM p2_activities
                                  WHERE scope = ?
                                    AND (status IN ('done','failed','abandoned')
                                         -- A review park is the most common real failure (the source
                                         -- broke mid-read); the row stays paused, so it must be
                                         -- selected explicitly or tomorrow would not see it.
                                         OR (status = 'paused' AND checkpoint LIKE '%"needsReview":true%'))
                                  ORDER BY updated_at DESC LIMIT 8`, scopeKey)
          .map(row => ({ ...row, source: 'activity' }));
        const missed = rows(`SELECT s.activity AS kind, COALESCE(s.target_ref, s.title) AS target, 'missed' AS outcome,
                                    0 AS consumed_prefix, 0 AS total_units, 0 AS artifact_version, s.end_at AS at,
                                    'slot:' || s.slot_id AS source_id
                             FROM p2_plan_slots s JOIN p2_plans p ON p.plan_id = s.plan_id AND p.scope = s.scope
                             WHERE s.scope = ? AND s.status IN ('expired','skipped') AND s.kind = 'activity'
                               AND p.status = 'committed'
                             ORDER BY s.end_at DESC LIMIT 4`, scopeKey)
          .map(row => ({ ...row, source: 'slot' }));
        return [...activities, ...missed]
          .sort((left, right) => Number(right.at) - Number(left.at))
          .slice(0, 8);
      })(),
      // P2.5-2 (A4 §4.4 E5-a): repeated failures per target, so the next plan can route around a
      // source that keeps failing instead of re-scheduling it every day.
      recentFailures: rows(`SELECT a.target AS target, a.kind AS kind, r.code AS code, COUNT(*) AS failures,
                                   MAX(r.at) AS last_at
                            FROM p2_activity_receipts r
                            JOIN p2_activities a ON a.activity_id = r.activity_id AND a.scope = r.scope
                            WHERE r.scope = ? AND r.ok = 0 AND r.operation IN ('review','finish','missed')
                              AND r.at >= ?
                              AND a.target <> ''
                            GROUP BY a.target, r.code
                            ORDER BY failures DESC, last_at DESC LIMIT 6`, scopeKey, now - 3 * 24 * 3600 * 1000),
      planningPreferences: { maxSlots: config.p2?.planning?.maxSlots ?? 8, targetActivities: config.p2?.planning?.targetActivities ?? 0 },
      lastReceipts: rows(`SELECT r.activity_id, r.operation, r.ok, r.code, r.at, a.kind AS kind, a.target AS target
                          FROM p2_activity_receipts r
                          LEFT JOIN p2_activities a ON a.activity_id = r.activity_id AND a.scope = r.scope
                          WHERE r.scope = ? AND r.code <> 'lc-effect' ORDER BY r.at DESC LIMIT 5`, scopeKey),
      interests: rows(`SELECT interest_id, kind, title, note, status, strength FROM p2_interests
                       WHERE scope = ? AND status = 'active' ORDER BY last_touched DESC LIMIT 8`, scopeKey),
      opportunities: rows(`SELECT opportunity_id, kind, source, weight, created_at FROM p2_opportunities
                           WHERE scope = ? AND status = 'open' ORDER BY created_at ASC LIMIT 8`, scopeKey),
      recentPlans: rows(`SELECT day, version, status, summary FROM p2_plans WHERE scope = ? ORDER BY created_at DESC LIMIT 3`, scopeKey),
      // Contract section 4.2: the planner sees what is really usable and what is really left.
      capabilities: p2Controller ? p2Controller.capabilities(scopeKey) : null,
      budget: p2Controller ? p2Controller.budget.status({ scope: scopeKey }) : null,
      preferences: typeof options.p2Preferences === 'function' ? options.p2Preferences({ scopeKey }) : [],
      persona: typeof options.p2Persona === 'function' ? options.p2Persona({ scopeKey }) : null,
      continuity: typeof options.p2Continuity === 'function' ? options.p2Continuity({ scopeKey }) : null,
      // E6 (A4 §3, plan line 190): what the user currently believes / has already corrected, so the
      // planner stops re-"discovering" known facts and never repeats a corrected one. Only the
      // current version of each supersede chain, only *supported* claims, and bounded.
      beliefs: beliefsForPlanning(scopeKey, now, 6),
      beliefsSource: 'beliefs',
    };
    let extension = {};
    try {
      // The plugin owns persona/preferences/continuity/entry points (it reads the real
      // workspace files); the runtime owns plan/agenda/activities/budget. Merge both so the
      // planner never sees an empty object and never invents a target that cannot execute.
      const source = options.p2RuntimeMaterials ?? options.materials ?? null;
      if (typeof source === 'function') extension = (await source({ scopeKey, day, now, runtime: base })) ?? {};
    } catch { extension = { materialsSource: 'failed' }; }
    // P2.5-2 (A4 §3.1/§3.5): the materials port returns its **own** whitelisted object, so a key the
    // runtime adds here can silently disappear between the query and the prompt — the audit's
    // "tests are green, production is empty" pattern. The runtime owns "what actually happened",
    // so those keys are re-applied after the merge instead of trusting the port to forward them.
    return {
      ...base,
      ...extension,
      blockedActivityTargets: base.blockedActivityTargets,
      recentOutcomes: base.recentOutcomes,
      recentFailures: base.recentFailures,
      lastReceipts: Array.isArray(extension?.lastReceipts) && extension.lastReceipts.length
        ? extension.lastReceipts
        : base.lastReceipts,
      // Runtime-owned, re-applied after the merge (the port's whitelist would drop them).
      beliefs: base.beliefs,
      beliefsSource: base.beliefsSource,
      // E4: goals/commitments come from the continuity provider. When it is absent the section is
      // empty **and** says why — "the user has no goals" and "we cannot see goals" are different
      // facts, and the planner prompt renders them differently.
      continuityState: String(extension?.continuity?.state ?? base.continuity?.state ?? 'not-wired'),
      continuityReason: String(extension?.continuity?.reason ?? base.continuity?.reason ?? 'no-continuity-provider'),
      goals: Array.isArray(extension?.goals) && extension.goals.length ? extension.goals : (base.continuity?.goals ?? []),
      commitments: Array.isArray(extension?.commitments) && extension.commitments.length ? extension.commitments : (base.continuity?.commitments ?? []),
    };
  }
  function p2Ports() {
    const source = options.p2Ports ?? options.ports ?? {};
    const dshHome = options.env?.DSH_HOME ?? process.env.DSH_HOME ?? path.join(root, 'home');
    return {
      runBilibili: typeof source.runBilibili === 'function' ? source.runBilibili
        : createBilibiliProviderPort(path.join(dshHome, 'bili-duty'), { now: clock }),
      fetchPage: typeof source.fetchPage === 'function' ? source.fetchPage : undefined,
      search: typeof source.search === 'function' ? source.search : undefined,
      discoverLinks: typeof source.discoverLinks === 'function' ? source.discoverLinks : undefined,
      readFile: typeof source.readFile === 'function' ? source.readFile : undefined,
      writeFile: typeof source.writeFile === 'function' ? source.writeFile : undefined,
    };
  }

  function p2MemoryPort() {
    if (options.memoryPort && typeof options.memoryPort.recordExperience === 'function') return options.memoryPort;
    return null;
  }

  /**
   * P2 experience write-through (contract v1.2 section 5): queue into the existing
   * `memory_outbox`, never a second queue and never a direct memory write here. The insert is
   * keyed by (scope, event, namespace, transformVersion), so a crash after a successful direct
   * ingest and before the mark simply retries the same key on the next run.
   */
  function enqueueMemoryIngest(input = {}) {
    if (!db) return { ok: false, code: 'db-unavailable' };
    const scope = typeof input.scopeKey === 'string' && input.scopeKey.trim()
      ? parseScope(input.scopeKey.trim())
      : (input.scope ? normalizeScope(input.scope) : null);
    if (!scope) return { ok: false, code: 'invalid-scope' };
    const eventId = typeof input.eventId === 'string' ? input.eventId.trim() : '';
    if (!eventId) return { ok: false, code: 'invalid-event-id' };
    const content = typeof input.content === 'string' ? input.content.trim() : '';
    if (!content) return { ok: false, code: 'invalid-content' };
    try {
      const queued = enqueueIngest(db, {
        scope,
        event: eventId,
        namespace: input.namespace ?? 'p2/experience',
        payload: {
          content,
          transformVersion: input.transformVersion ?? 'p2-experience-v1',
          realityStatus: input.realityStatus ?? 'actual_tool_activity',
          evidenceStatus: input.evidenceStatus ?? 'observed',
          occurredAt: Number(input.occurredAt) || Number(clock()),
        },
        // R6: this entry point is reached *outside* any event transaction, so the outbox INSERT
        // must carry its own writer fence (owner + generation + unexpired lease).
        owner,
        generation,
      });
      return { ok: true, outboxId: queued.outboxId, queued: queued.queued, duplicate: queued.queued === false, status: queued.status };
    } catch (error) {
      noteError('p2-memory-enqueue-failed', error instanceof Error ? error.message : String(error));
      return { ok: false, code: 'enqueue-failed', reason: (error instanceof Error ? error.message : String(error)).slice(0, 120) };
    }
  }

  /**
   * P2.5-1 (Slice A) jump 2: a **finished** real activity becomes a P1-visible fact.
   *
   * This is the hook `lib/activities.mjs` calls after the finish transition has already
   * committed. It appends one normal `memory/ingest-request`, so the existing `bridge` consumer
   * queues it into `memory_outbox` — no second queue, no direct memory write, no new event kind.
   *
   * Identity is derived from the activity itself: same activity, same kind/target/coverage, same
   * closing instant and the same `finish` receipt → same content-addressed `eventId` → the same
   * `outboxId`. A retried close therefore cannot enqueue twice (events.mjs `eventIdFor`,
   * bridge.mjs `outboxIdFor`).
   *
   * It only ever states what the record proves (kind, coverage, artifact version). It never
   * claims content the activity did not read or write — that distinction is P2.5-2's job.
   */
  function p2ActivityFinished(input = {}) {
    const scopeKeyValue = typeof input.scopeKey === 'string' ? input.scopeKey.trim() : '';
    const scope = scopeKeyValue ? parseScope(scopeKeyValue) : null;
    if (!scope) return { ok: false, code: 'invalid-scope' };
    const activityId = String(input.activityId ?? '').trim();
    if (!activityId) return { ok: false, code: 'invalid-input' };
    let receiptId = String(input.receiptId ?? '').trim();
    if (!receiptId) {
      try {
        receiptId = String(db.get(`SELECT receipt_id FROM p2_activity_receipts
                                   WHERE scope = ? AND activity_id = ? AND operation IN ('finish','abandon')
                                   ORDER BY at DESC, receipt_id DESC LIMIT 1`, scopeKeyValue, activityId)?.receipt_id ?? '');
      } catch { receiptId = ''; }
    }
    const kind = ['read', 'explore', 'write', 'bilibili'].includes(String(input.kind)) ? String(input.kind) : 'read';
    const label = kind === 'bilibili' ? '刷 B 站' : kind === 'write' ? '写作' : kind === 'explore' ? '探索' : '阅读';
    const target = String(input.target ?? '').trim().slice(0, 80);
    let covered = Math.max(0, Math.trunc(Number(input.consumedPrefix) || 0));
    if (kind === 'bilibili') {
      try {
        const row = db.get('SELECT reality, checkpoint FROM p2_activities WHERE scope = ? AND activity_id = ? AND kind = ?', scopeKeyValue, activityId, kind);
        covered = row?.reality === 'actual_tool_activity' ? Number(JSON.parse(row.checkpoint).bilibiliRound?.watched) || 0 : 0;
      } catch { covered = 0; }
    }
    const total = Math.max(0, Math.trunc(Number(input.totalUnits) || 0));
    const version = Math.max(0, Math.trunc(Number(input.artifactVersion) || 0));
    const phase = P2_FACT_PHASES.includes(String(input.phase)) ? String(input.phase) : 'finished';
    const outcome = phase === 'finished' ? 'ok' : phase === 'missed' ? 'skipped' : 'failed';
    const code = String(input.reason ?? input.code ?? '').trim().slice(0, 60);
    const where = `${label}${target ? `《${target}》` : ''}`;
    if (kind === 'bilibili' && (covered === 0 || input.reality !== 'actual_tool_activity')) {
      return { ok: false, code: 'no-watch-evidence' };
    }
    const coverage = kind === 'bilibili' ? `确认消费 ${covered} 个视频`
      : covered > 0 ? `覆盖 ${covered} 字${total > 0 ? `（共 ${total}）` : ''}` : '';
    const versionText = version > 0 ? `草稿版本 v${version}` : '';
    // A4 §1.4 E1-b: one sentence per outcome, and the sentence never upgrades a failure into a
    // completion. It states coverage only as far as the record proves it.
    const content = (phase === 'finished'
      ? [`自主${where}结束`, coverage, versionText]
      : phase === 'failed'
        ? [`自主${where}**失败**，未完成`, code ? `原因：${code}` : '', coverage, '已标记待复核']
        : phase === 'abandoned'
          ? [`自主${where}被放弃`, code ? `原因：${code}` : '', coverage]
          : [`计划中的${where}没有开始（窗口已过）`, code ? `原因：${code}` : ''])
      .filter(Boolean).join('，') + '。';
    // `reality` must already be one of the envelope's labels; anything else stays fail-closed as
    // `hypothetical` so a simulated slot can never be recorded as a real experience.
    const reality = ['actual_tool_activity', 'simulated_world', 'hypothetical'].includes(String(input.reality))
      ? String(input.reality)
      : 'hypothetical';
    // A4 §2.5 E2 (dedupe half): `eventId` alone cannot stop "the same book stays one memory".
    // Two readings have different closing instants, so their content-addressed ids differ and
    // memory would keep both. If the same (kind, target) already produced a *notable* outcome in
    // the last week, this repetition is history only — it is still recorded as an activity fact,
    // it just does not become a second long-term memory.
    // task-46: the decision and the **claim** share one transaction. Reading activity rows first and
    // writing later left a window where two concurrent finishes of one subject both saw "not
    // remembered yet" and each wrote a permanent memory (measured: two `notable` ingests). The claim
    // lives in the existing `runtime_meta` table — zero migration — and is written by the same
    // savepoint that decides, so a second finish inside the week sees it immediately.
    // F3 (soak, task-52): the claim used to be written **before** the significance was known, so a
    // routine outcome (an abandoned read, say) reserved the subject for a week and the genuinely
    // notable read that followed was suppressed — a memory silently lost. The claim now carries what
    // it was claiming: only a **notable** claim can suppress a later finish, and only a notable
    // finish writes one.
    let repeated = false;
    let significance = 'routine';
    // Declared **outside** the transaction: the settlement after the event write needs it too. Inside
    // the callback the name was block-scoped, so the settlement threw a ReferenceError that the bare
    // catch below silently turned into "leave it pending" — the claim never settled.
    let claimKey = '';
    // F5: a compensation replay hands us the decision the live write already made. Reuse it verbatim
    // so the fact content — and its content-addressed id — is identical instead of being re-derived
    // (re-deriving is what produced a second fact for the same activity).
    const inheritedSignificance = String(input.significance ?? '').trim();
    const inherits = inheritedSignificance === 'notable' || inheritedSignificance === 'routine';
    if (inherits) {
      repeated = inheritedSignificance === 'routine';
      significance = inheritedSignificance;
    }
    if (!inherits) db.tx(() => {
      const decisionAt = Number(input.at) || Number(clock());
      const computed = significanceOf({ phase, kind, consumedPrefix: covered, totalUnits: total, artifactVersion: version });
      if (isRepeatOfRememberedOutcome({ scopeKey: scopeKeyValue, kind, target, activityId, at: decisionAt })) {
        repeated = true;
        significance = 'routine';
        return;
      }
      claimKey = `p2_dedupe:${scopeKeyValue}:${kind}:${String(target).slice(0, 80)}`;
      let prior = null;
      try { prior = JSON.parse(String(db.get('SELECT meta_value FROM runtime_meta WHERE meta_key = ?', claimKey)?.meta_value ?? '')); } catch { prior = null; }
      const priorAt = Number(prior?.at ?? 0);
      // Only a previous **notable** claim suppresses; a routine claim is not evidence that this
      // subject was ever remembered.
      // round-4 B4: an unfinished claim (`eventPending`) suppresses only while it is plausibly *in
      // flight* — two concurrent finishes land within milliseconds, whereas a compensation replay
      // happens much later. Counting a stale pending claim as "already remembered" is exactly how a
      // crash between claim and event used to lose the memory for ever.
      const PENDING_CLAIM_HORIZON_MS = 60 * 1000;
      const priorSettled = prior?.eventPending !== true || (priorAt > 0 && decisionAt - priorAt < PENDING_CLAIM_HORIZON_MS);
      if (prior?.notable === true && priorSettled && priorAt > 0 && decisionAt - priorAt < 7 * 24 * 3600 * 1000) {
        repeated = true;
        significance = 'routine';
        return;
      }
      significance = computed;
      if (computed !== 'notable') return;
      // One predicate, two uses (lead ruling, soak F4): "did this outcome actually leave something
      // behind?" A zero-progress attempt is still a **fact** (the activity row, the event and the
      // planner's recent-history all keep it), but it must neither become a permanent memory nor
      // reserve the subject's week. Dropping the fact would be a different bug (the next plan would
      // keep scheduling a dead source), so only the *memory* side is gated here.
      const producedContent = traitProducedContent({ consumedPrefix: covered, artifactVersion: version });
      if (!producedContent) {
        significance = 'routine'; // fact stays, memory does not
        return;
      }
      db.run(`INSERT INTO runtime_meta (meta_key, meta_value, updated_at) VALUES (?, ?, ?)
              ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value, updated_at = excluded.updated_at`,
      claimKey, JSON.stringify({ notable: true, eventPending: true, activityId, kind, target: String(target).slice(0, 80), at: decisionAt }), decisionAt);
    });
    // Replay metadata cannot upgrade a zero-progress/missed activity into durable memory.
    if (!traitProducedContent({ consumedPrefix: covered, artifactVersion: version })) significance = 'routine';
    const evidenceStatus = (kind === 'explore' || phase !== 'finished') ? 'inferred' : 'observed';
    // F5: remember the decision next to the activity, so a compensation replay reproduces the same
    // content (and therefore the same content-addressed event id) instead of deriving a different
    // significance — which is how one activity produced two facts.
    if (!inherits) {
      try { db.metaSet(`p2_p1_sig_${activityId}`, significance); } catch { /* best effort */ }
    }
    // round-4 B4: the claim must be written **before** the event (two concurrent finishes must not
    // both win), so it starts as `eventPending` and only a successful event write settles it. Without
    // this, a crash here left a "notable" claim for a memory that was never written, and the
    // compensation replay then downgraded the outcome to routine — the memory was lost for ever.
    const ingestResult = requestMemoryIngest({
      bound: scope,
      occurredAt: Number(input.at) || Number(clock()),
      namespace: 'p2/activity',
      transformVersion: 'p2-activity-v1',
      content,
      rootEvidenceIds: receiptId ? [receiptId] : [],
      realityStatus: reality,
      evidenceStatus,
      significance,
      // Structured, additive keys (A4 §1.4 E1-c). Memory ignores unknown keys; the event log and
      // the UI read them, so "what was attempted, with what result, on what source" is answerable
      // without parsing the prose.
      facts: {
        activityId,
        slotId: String(input.slotId ?? '').slice(0, 80),
        kind,
        phase,
        result: outcome,
        code,
        target,
        sourceRef: String(input.sourceRef ?? '').slice(0, 200),
        consumedFrom: 0,
        consumedTo: covered,
        totalUnits: total,
        artifactVersion: version,
        reality,
        subjectKey: ingestSubjectKey({ namespace: 'p2/activity', kind, target }),
      },
    });;
    try {
      if (ingestResult?.ok === true && claimKey) {
        db.tx(() => {
          let current = null;
          try { current = JSON.parse(String(db.get('SELECT meta_value FROM runtime_meta WHERE meta_key = ?', claimKey)?.meta_value ?? '')); } catch { current = null; }
          if (!current || current.notable !== true) return;
          db.run(`INSERT INTO runtime_meta (meta_key, meta_value, updated_at) VALUES (?, ?, ?)
                  ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value, updated_at = excluded.updated_at`,
          claimKey, JSON.stringify({ ...current, eventPending: false, eventId: String(ingestResult.eventId ?? '') }), Number(clock()));
        });
      }
    } catch (error) {
      // Leaving it pending is the safe direction (a replay will not be suppressed), but the reason
      // must not vanish: the round-5 defect was exactly a swallowed ReferenceError here.
      noteError('p2-dedupe-claim-unsettled', error?.message ?? String(error));
    }
    return ingestResult;  }

  /**
   * A4 §1.4 E1-d: a slot whose window closed without ever starting is a fact too.
   *
   * It has no activity row (nothing ran), so it cannot go through `p2ActivityFinished`; the pump
   * reports it and the same ingest path records "the planned thing did not happen".
   */
  function p2ActivityMissed(input = {}) {
    const scopeKeyValue = typeof input.scopeKey === 'string' ? input.scopeKey.trim() : '';
    const scope = scopeKeyValue ? parseScope(scopeKeyValue) : null;
    if (!scope) return { ok: false, code: 'invalid-scope' };
    const slotId = String(input.slotId ?? '').trim();
    if (!slotId) return { ok: false, code: 'invalid-input' };
    return p2ActivityFinished({
      scopeKey: scopeKeyValue,
      activityId: `missed:${slotId}`,
      slotId,
      kind: input.kind,
      target: input.target,
      phase: 'missed',
      reason: input.reason ?? 'window-closed',
      reality: input.reality,
      at: Number(input.at) || Number(clock()),
      consumedPrefix: 0,
      totalUnits: 0,
      artifactVersion: 0,
    });
  }

  if (db) {
    try {
      p2Controller = createP2({
        db,
        config,
        clock,
        owner,
        generation,
        getMode: () => (stopped || disposed ? 'off' : mode),
        isActive: () => mode === 'active' && !stopped && !disposed && Boolean(db),
        emit: dispatchForAutonomy,
        // P2.5-1: the heartbeat's claim route (same append, plus the activities switch).
        emitActivity: dispatchForActivity,
        agendaFixed: p2FixedAgenda,
        shadow: (kind, payload) => recordProposal(db, { kind, scope: scopeKeyOf(payload?.scope ?? {}), payload, source: 'p2-planning' }),
        materials: p2Materials,
        ports: p2Ports(),
        memoryPort: p2MemoryPort(),
        options: {
          artifactRoot: p2ArtifactRoot,
          callModel: options.callModel,
          sharePort: options.sharePort,
          // The budget's shouldYield reads options.isForegroundBusy, so it must live in this
          // object — a top-level createP2 field is silently ignored.
          isForegroundBusy: typeof options.isForegroundBusy === 'function' ? options.isForegroundBusy : undefined,
          // P2.5-1 jump 2: the finished-activity → P1 event hook (activities.mjs calls it).
          onFinished: p2ActivityFinished,
          // P2.5-2 (A4 §1.4 E1-d): a slot that never started is a fact too, but it has no activity
          // row, so it arrives through its own hook.
          onMissed: p2ActivityMissed,
          // R3: the periodic outbox drain rides on the P2 pump tick. `drainOutboxTick` needs the
          // memory engine and the writer identity, both of which live here, not in `p2.mjs`.
          drainOutbox: () => {
            // D: the existing drain is also the retry path for corrections that never reached the
            // queue. It runs first and stays bounded, so a stuck correction cannot starve the
            // ordinary outbox drain.
            try { settleCorrectionResolutions({ limit: 10 }); } catch { /* settled on the next tick */ }
      try { retryPendingCorrections({ limit: 3 }); } catch { /* retried on the next tick */ }
            return drainOutboxTick();
          },
          onError: (code, detail) => noteError(code, detail),
        },
      });
      // The autonomy consumer must be in the runtime's handler table, otherwise an
      // `autonomy/*` event is appended without any consumer and its projection never runs
      // (that is exactly the "planning succeeded with no plan row" failure the reviewer
      // predicted). Merged after mount so the P2 handler is the single owner of that slice.
      Object.assign(handlers, p2Controller.handlers);
      if (writable && mode === 'active') p2Controller.start();
    } catch (error) {
      noteError('p2-mount-failed', error instanceof Error ? error.message : String(error));
      p2Controller = null;
    }
  }

  function p2Unavailable(code = 'p2-not-registered') {
    return { ok: false, code, planningEnabled: config.p2?.planning?.enabled === true, activitiesEnabled: config.p2?.activities?.enabled === true };
  }

  function p2Status(input = {}) {
    const scope = scopeOf(input);
    if (!p2Controller) {
      return {
        planning: { enabled: config.p2?.planning?.enabled === true, paused: true, state: 'pending-load', pendingLoad: true },
        activities: { enabled: config.p2?.activities?.enabled === true, paused: true, state: 'pending-load', pendingLoad: true },
        budget: null,
        capabilities: null,
        share: { enabled: config.p2?.share?.enabled === true, owner: 'contact', port: 'unavailable' },
      };
    }
    try {
      const reported = p2Controller.status({ scopeKey: scope ? scopeKeyOf(scope) : null });
      // `pendingLoad` is always explicit: the code is mounted even when both switches are off.
      return { ...reported, planning: { ...reported.planning, pendingLoad: false }, activities: { ...reported.activities, pendingLoad: false } };
    } catch (error) {
      noteError('p2-status-failed', error instanceof Error ? error.message : String(error));
      return p2Unavailable('p2-status-failed');
    }
  }

  /**
   * P2.5 dry watch (CONTRACT §15.3): "what would the next heartbeat beat do, and if it would do
   * nothing, why?"
   *
   * This is the call an operator makes **before** turning `p2.activities.dispatchEnabled` on, so
   * it is read-only by construction: it never sweeps the budget (which `p2Status()` does), never
   * appends an event, never touches `heartbeat_cursor`. See
   * `test/p2.5-dispatch-observability.test.mjs` for the zero-write proof.
   *
   * It composes two halves that deliberately know different things:
   *   - `p2Controller.dispatchWatch()` — the slots, the P2 switches, the effect ledger, the claim
   *     ages (durable, from `lib/dispatch-observability.mjs`);
   *   - the heartbeat's own gates below — because a P2 side that says "claimable" while the
   *     heartbeat is disabled, paused or has a zero cap would be a promise nothing can keep.
   */
  function p2DispatchWatch(input = {}) {
    const now = Number(input.now) || Number(clock());
    const scope = scopeOf(input);
    const scopeKeyValue = scope ? scopeKeyOf(scope) : '';
    const hbStatus = heartbeatStatus();
    const hbCfg = config.heartbeat ?? {};
    // The **configured** per-beat cap, not `activityDispatchLimit`: that field is defined as
    // "0 unless the hook is wired", so using it here would report a zero cap for an installation
    // that simply has the gray switch off — one cause described twice, the second time wrongly.
    const configuredCap = Math.max(0, Math.min(20, Math.trunc(Number(hbCfg.maxDispatchPerCycle ?? 1))));
    const heartbeatGates = {
      mounted: Boolean(heartbeatController),
      enabled: config.heartbeat?.enabled === true,
      agendaEnabled: config.agenda?.enabled === true,
      paused: hbStatus?.paused === true,
      state: hbStatus?.state ?? 'pending-load',
      maxPerBeat: configuredCap,
      limit: Number(hbStatus?.activityDispatchLimit ?? 0) || 0,
      wiring: hbStatus?.activityDispatch ?? 'unavailable',
      lastAttemptAt: hbStatus?.lastAttemptAt ?? null,
      lastCycle: hbStatus?.lastCycle ?? null,
      lastDispatch: hbStatus?.activityDispatchLastCycle ?? null,
    };
    // The same ordered refusals `heartbeat.cycle()` applies before it ever reaches the (c2)
    // section. Named, so the answer is "disabled" rather than an unexplained empty slot list.
    const blockedBy = [];
    if (!heartbeatGates.mounted) blockedBy.push('heartbeat-unmounted');
    else {
      if (!heartbeatGates.enabled) blockedBy.push('heartbeat-disabled');
      if (!heartbeatGates.agendaEnabled) blockedBy.push('agenda-disabled');
      if (heartbeatGates.paused) blockedBy.push('heartbeat-paused');
      if (configuredCap <= 0) blockedBy.push('dispatch-cap-zero');
    }
    const runtimeReady = mode === 'active' && !stopped && !disposed && Boolean(db);
    if (!runtimeReady) blockedBy.push(mode === 'active' ? 'runtime-inactive' : `runtime-${mode}`);
    if (!p2Controller) blockedBy.push('p2-unmounted');

    if (!p2Controller || !db) {
      return {
        ok: true, readOnly: true, at: now, scopeKey: scopeKeyValue || null,
        p2: null, heartbeat: heartbeatGates, blockedBy: blockedBy.length ? blockedBy : ['p2-unmounted'],
        claimableNow: false, rows: [], counts: null, metrics: null,
        code: 'p2-not-registered',
      };
    }
    try {
      const watched = p2Controller.dispatchWatch({ scopeKey: scopeKeyValue, now });
      // P2-side refusals join the heartbeat-side ones: one list, each entry a name.
      if (watched.deferred) blockedBy.push(watched.deferred);
      const intervalMs = Math.max(1000, Math.min(3600000, Math.trunc(Number(hbCfg.pollIntervalMs) || 60000)));
      const jitterMs = Math.max(0, Math.min(60000, Math.trunc(Number(hbCfg.jitterMs ?? 2500) || 0)));
      const lastAttemptAt = Number(heartbeatGates.lastAttemptAt) || 0;
      // One "what went wrong last" for the three layers that can refuse, most recent first. Each
      // candidate is a fact some layer recorded itself; nothing is inferred, and `null` means none
      // of them has failed — not "we did not look".
      const lastError = (() => {
        const candidates = [
          { at: Number(heartbeatGates.lastDispatch?.at) || 0, from: 'heartbeat', code: String(heartbeatGates.lastDispatch?.code ?? '').trim() },
          {
            at: Number(watched.metrics?.lastClaim?.at) || 0,
            from: 'claim',
            code: watched.metrics?.lastClaim?.ok === false ? `slot-claim:${String(watched.metrics.lastClaim.code ?? '')}` : '',
          },
          {
            at: Number(watched.metrics?.lastStart?.at) || 0,
            from: 'start',
            code: String(watched.metrics?.lastStart?.code ?? '').trim() && watched.metrics.lastStart.code !== 'started'
              ? `activity-start:${String(watched.metrics.lastStart.code)}`
              : '',
          },
        ].filter(entry => entry.at > 0 && entry.code);
        if (candidates.length === 0) return null;
        candidates.sort((left, right) => right.at - left.at);
        return candidates[0];
      })();
      return {
        ok: true,
        readOnly: true,
        at: now,
        scopeKey: scopeKeyValue || null,
        // Never claim "it will happen at T": the heartbeat timer is `interval ± jitter`, so the
        // honest answer is a bound plus the last beat that actually ran.
        nextBeatWithinMs: intervalMs + jitterMs,
        nextBeatNoLaterThan: lastAttemptAt > 0 ? lastAttemptAt + intervalMs + jitterMs : null,
        blockedBy,
        claimableNow: blockedBy.length === 0 && watched.claimableNow === true,
        lastError,
        rows: watched.rows,
        counts: watched.counts,
        metrics: watched.metrics,
        p2: {
          dispatchEnabled: watched.dispatchEnabled,
          activitiesEnabled: watched.activitiesEnabled,
          paused: watched.paused,
          deferred: watched.deferred,
          maxPerBeat: watched.maxPerBeat,
        },
        heartbeat: heartbeatGates,
        note: 'read-only projection; a claim only happens when a heartbeat beat actually runs',
      };
    } catch (error) {
      const runtimeError = asRuntimeError(error);
      noteError(runtimeError.code, runtimeError.message);
      return {
        ok: false, code: runtimeError.code, readOnly: true, at: now,
        scopeKey: scopeKeyValue || null, blockedBy: [...blockedBy, 'watch-failed'],
        claimableNow: false, rows: [], counts: null, metrics: null, heartbeat: heartbeatGates,
      };
    }
  }

  function p2Tick(input = {}) {
    if (!p2Controller) return p2Unavailable();
    if (!p2Enabled()) return { ok: false, code: 'p2-disabled' };
    if (mode !== 'active') return { ok: false, code: 'runtime-inactive', mode };
    return p2Controller.tick({ reason: String(input.reason ?? 'manual').slice(0, 60) });
  }

  /** Async pass that turns running activities into real, model-gated progress. */
  /** H5 plan control (v1.2 §7): lock / unlock / skip one future slot of the current scope. */
  function controlPlanSlot(input = {}) {
    if (!p2Controller) return p2Unavailable();
    const scope = scopeOf(input);
    if (!scope) return { ok: false, code: 'unbound' };
    return p2Controller.controlPlanSlot({ scopeKey: scopeKeyOf(scope), slotId: input.slotId ?? '', action: input.action ?? '' });
  }
  async function pumpActivityExecution(input = {}) {
    if (!p2Controller) return p2Unavailable();
    if (!p2Enabled()) return { ok: false, code: 'p2-disabled' };
    if (mode !== 'active') return { ok: false, code: 'runtime-inactive', mode };
    return p2Controller.pumpExecution({ now: input.now ?? Number(clock()), maxStepsPerCycle: input.maxStepsPerCycle });
  }

  /** Async pass that runs one planning round per persisted scope (may call the model). */
  async function pumpPlanning(input = {}) {
    if (!p2Controller) return p2Unavailable();
    if (!p2Enabled()) return { ok: false, code: 'p2-disabled' };
    if (mode !== 'active') return { ok: false, code: 'runtime-inactive', mode };
    return p2Controller.pumpPlanning({ now: input.now ?? Number(clock()), reason: String(input.reason ?? 'manual').slice(0, 60) });
  }

  /** Async pass that starts due activity slots (real IO, never inside the sync tick). */
  async function pumpActivities(input = {}) {
    if (!p2Controller) return p2Unavailable();
    if (!p2Enabled()) return { ok: false, code: 'p2-disabled' };
    if (mode !== 'active') return { ok: false, code: 'runtime-inactive', mode };
    return p2Controller.pump({ now: input.now ?? Number(clock()) });
  }

  function pausePlanning(input = {}) {
    if (!p2Controller) return p2Unavailable();
    if (config.p2?.planning?.enabled !== true) return { ok: false, code: 'planning-disabled' };
    return p2Controller.pause('planning', String(input.reason ?? 'operator-pause'));
  }

  function resumePlanning() {
    if (!p2Controller) return p2Unavailable();
    if (config.p2?.planning?.enabled !== true) return { ok: false, code: 'planning-disabled' };
    return p2Controller.resume('planning');
  }

  function pauseActivities(input = {}) {
    if (!p2Controller) return p2Unavailable();
    if (config.p2?.activities?.enabled !== true) return { ok: false, code: 'activities-disabled' };
    return p2Controller.pause('activities', String(input.reason ?? 'operator-pause'));
  }

  function resumeActivities() {
    if (!p2Controller) return p2Unavailable();
    if (config.p2?.activities?.enabled !== true) return { ok: false, code: 'activities-disabled' };
    return p2Controller.resume('activities');
  }

  async function planToday(input = {}) {
    if (!p2Controller) return p2Unavailable();
    if (config.p2?.planning?.enabled !== true) return { ok: false, code: 'planning-disabled' };
    const scope = scopeOf(input);
    if (!scope) return { ok: false, code: 'unbound' };
    const scopeKey = scopeKeyOf(scope);
    return agendaTryAsync(async () => {
      requireAutonomyWriter();
      return await p2Controller.planner.tick({ scopeKey, reason: String(input.reason ?? 'tool').slice(0, 60), now: Number(clock()), force: input.force === true });
    });
  }

  function listPlan(input = {}) {
    const scope = scopeOf(input);
    if (!scope || !db) return { ok: false, code: 'unbound' };
    const scopeKey = scopeKeyOf(scope);
    try {
      const plan = db.get(`SELECT plan_id, day, version, status, time_zone, window_start, window_end, summary, committed_at
                           FROM p2_plans WHERE scope = ? AND status IN ('committed','empty') ORDER BY version DESC LIMIT 1`, scopeKey);
      if (!plan) return { ok: true, plan: null, slots: [] };
      const slots = db.all('SELECT slot_id, start_at, end_at, kind, activity, title, flexibility, status FROM p2_plan_slots WHERE plan_id = ? ORDER BY start_at', plan.plan_id);
      return {
        ok: true,
        plan: { planId: plan.plan_id, day: plan.day, version: Number(plan.version), status: plan.status, summary: String(plan.summary ?? '').slice(0, 120), windowStart: Number(plan.window_start), windowEnd: Number(plan.window_end) },
        slots: slots.map(row => ({ slotId: row.slot_id, startAt: Number(row.start_at), endAt: Number(row.end_at), kind: row.kind, activity: row.activity, title: row.title, flexibility: row.flexibility, status: row.status })),
      };
    } catch (error) {
      return { ok: false, code: asRuntimeError(error).code };
    }
  }

  function activityApi(input = {}) {
    if (!p2Controller) return p2Unavailable();
    if (config.p2?.activities?.enabled !== true) return { ok: false, code: 'activities-disabled' };
    const scope = scopeOf(input);
    if (!scope) return { ok: false, code: 'unbound' };
    return { ok: true, scopeKey: scopeKeyOf(scope) };
  }

  async function startActivity(input = {}) {
    const ready = activityApi(input);
    if (!ready.ok) return ready;
    return agendaTryAsync(async () => {
      requireAutonomyWriter();
      return { ok: true, ...(await p2Controller.activities.start({ slotId: input.slotId ?? '', scopeKey: ready.scopeKey, kind: input.kind ?? '', target: input.target ?? '', reality: input.reality })) };
    });
  }

  async function stepActivity(input = {}) {
    const ready = activityApi(input);
    if (!ready.ok) return ready;
    return agendaTryAsync(async () => {
      requireAutonomyWriter();
      return { ok: true, ...(await p2Controller.activities.step({
        activityId: input.activityId ?? '',
        scopeKey: ready.scopeKey,
        units: Number(input.units ?? 0),
        // A write step carries the text to append; a read step carries how much was consumed.
        ...(input.append !== undefined ? { append: String(input.append) } : {}),
        ...(input.expectedConsumed !== undefined ? { expectedConsumed: Number(input.expectedConsumed) } : {}),
      })) };
    });
  }

  async function pauseActivity(input = {}) {
    const ready = activityApi(input);
    if (!ready.ok) return ready;
    return agendaTryAsync(async () => {
      requireAutonomyWriter();
      return { ok: true, ...(await p2Controller.activities.pause({ activityId: input.activityId ?? '', scopeKey: ready.scopeKey })) };
    });
  }

  async function resumeActivity(input = {}) {
    const ready = activityApi(input);
    if (!ready.ok) return ready;
    return agendaTryAsync(async () => {
      requireAutonomyWriter();
      return { ok: true, ...(await p2Controller.activities.resume({ activityId: input.activityId ?? '', scopeKey: ready.scopeKey })) };
    });
  }

  async function finishActivity(input = {}) {
    const ready = activityApi(input);
    if (!ready.ok) return ready;
    return agendaTryAsync(async () => {
      requireAutonomyWriter();
      return { ok: true, ...(await p2Controller.activities.finish({ activityId: input.activityId ?? '', scopeKey: ready.scopeKey })) };
    });
  }

  async function abandonActivity(input = {}) {
    const ready = activityApi(input);
    if (!ready.ok) return ready;
    return agendaTryAsync(async () => {
      requireAutonomyWriter();
      return { ok: true, ...(await p2Controller.activities.abandon({ activityId: input.activityId ?? '', scopeKey: ready.scopeKey, reason: input.reason ?? '' })) };
    });
  }

  function reconcileActivities(input = {}) {
    if (!p2Controller) return p2Unavailable();
    const scope = scopeOf(input);
    if (scope && mode !== 'active') return { ok: false, code: 'runtime-inactive' };
    return p2Controller.activities.reconcile();
  }

  /**
   * R4: human resolution of an unresolved external effect (design §3 "人工收敛").
   *
   * Append-only by construction: it adds one `lc-effect` record (`confirmed` or `not_applied`) and
   * never edits or deletes the earlier `prepared`/`unknown` one. A `not_applied` outcome lets the
   * job pass the gates again; a `confirmed` one keeps it settled.
   */
  function resolveEffect(input = {}) {
    const scope = scopeOf(input);
    if (!scope || !db) return { ok: false, code: 'unbound' };
    if (!p2Controller || typeof p2Controller.activities?.resolveEffect !== 'function') return { ok: false, code: 'runtime-inactive' };
    // round-3 review A6: the guards live in the controller, but they must not depend on the caller
    // remembering to pass them. `operator` and `evidence` are forwarded verbatim (the controller
    // refuses empty ones) — there is no default that could quietly look like a decision.
    return p2Controller.activities.resolveEffect({
      scopeKey: scopeKeyOf(scope),
      effectKey: input.effectKey,
      outcome: input.outcome,
      evidence: typeof input.evidence === 'string' ? input.evidence : '',
      operator: typeof input.operator === 'string' ? input.operator : '',
      // round-4 A3: `reason` must reach the controller, or the public API can never complete a
      // same-generation timeout convergence (`reason:'worker-abandoned'`).
      ...(typeof input.reason === 'string' && input.reason ? { reason: input.reason } : {}),
    });
  }

  /** R4: read-only view of the effect ledger for one scope (diagnostics / operators). */
  function listEffects(input = {}) {
    const scope = scopeOf(input);
    if (!scope) return { ok: false, code: 'unbound', effects: [] };
    if (!p2Controller || typeof p2Controller.activities?.effects !== 'function') return { ok: true, effects: [] };
    return { ok: true, ...p2Controller.activities.effects({ scopeKey: scopeKeyOf(scope) }) };
  }

  function listActivities(input = {}) {
    const scope = scopeOf(input);
    if (!scope || !db) return { ok: false, code: 'unbound' };
    try {
      const rows = db.all(`SELECT activity_id, kind, adapter, reality, status, target, source_hash, consumed_prefix, total_units,
                                  artifact_ref, artifact_version, started_at, updated_at
                           FROM p2_activities WHERE scope = ? ORDER BY updated_at DESC LIMIT 20`, scopeKeyOf(scope));
      return { ok: true, activities: rows.map(row => ({ activityId: row.activity_id, kind: row.kind, adapter: row.adapter, reality: row.reality, status: row.status, target: row.target, sourceHash: row.source_hash, consumed: Number(row.consumed_prefix), totalUnits: Number(row.total_units), artifactRef: row.artifact_ref, artifactVersion: Number(row.artifact_version), startedAt: Number(row.started_at), updatedAt: Number(row.updated_at) })) };
    } catch (error) { return { ok: false, code: asRuntimeError(error).code }; }
  }

  function capabilitiesOf(input = {}) {
    if (!p2Controller) return p2Unavailable();
    const scope = scopeOf(input);
    return { ok: true, capabilities: p2Controller.capabilities(scope ? scopeKeyOf(scope) : null) };
  }

  function shareCandidates(input = {}) {
    if (!p2Controller) return p2Unavailable();
    const scope = scopeOf(input);
    if (!scope) return { ok: false, code: 'unbound' };
    return { ok: true, candidates: p2Controller.listShareCandidates({ scopeKey: scopeKeyOf(scope), status: input.status ?? 'pending' }) };
  }

  function createShareCandidate(input = {}) {
    if (!p2Controller) return p2Unavailable();
    if (config.p2?.share?.enabled !== true) return { ok: false, code: 'share-disabled' };
    const scope = scopeOf(input);
    if (!scope) return { ok: false, code: 'unbound' };
    return agendaTry(() => { requireAutonomyWriter(); return p2Controller.createShareCandidate({ scopeKey: scopeKeyOf(scope), activityId: input.activityId ?? '', kind: input.kind ?? 'activity', title: input.title ?? '', body: input.body ?? '', sourceRef: input.sourceRef ?? '' }); });
  }

  function withdrawShareCandidate(input = {}) {
    if (!p2Controller) return p2Unavailable();
    const scope = scopeOf(input);
    if (!scope) return { ok: false, code: 'unbound' };
    return p2Controller.withdrawShareCandidate({ scopeKey: scopeKeyOf(scope), candidateId: input.candidateId ?? '', reason: input.reason ?? '' });
  }

  async function submitShareCandidate(input = {}) {
    if (!p2Controller) return p2Unavailable();
    const scope = scopeOf(input);
    if (!scope) return { ok: false, code: 'unbound' };
    return p2Controller.submitShareCandidate({ scopeKey: scopeKeyOf(scope), candidateId: input.candidateId ?? '' });
  }

  async function failActivity(input = {}) {
    const ready = activityApi(input);
    if (!ready.ok) return ready;
    return agendaTryAsync(async () => {
      requireAutonomyWriter();
      return { ok: true, ...(await p2Controller.activities.fail({ activityId: input.activityId ?? '', scopeKey: ready.scopeKey, code: input.code ?? 'failed', reason: input.reason ?? '' })) };
    });
  }

  async function recordExperience(input = {}) {
    if (!p2Controller) return p2Unavailable();
    const scope = scopeOf(input);
    if (!scope) return { ok: false, code: 'unbound' };
    // P2.5 (round-2 §二.5): the legacy path refuses while the P1 hook is wired. `allowLegacy` was a
    // diagnostics escape hatch, but round-3 review A5 showed the public API forwarded whatever the
    // caller passed — anyone could open it. Now the *configuration* decides (an operator setting a
    // plugin caller cannot fabricate), and every use is recorded.
    const allowed = config.diagnostics?.allowLegacy === true;
    const askedForLegacy = input.allowLegacy === true;
    if (askedForLegacy && !allowed) {
      noteError('p2-legacy-refused', 'allowLegacy was requested by a caller but diagnostics.allowLegacy is off');
      return { ok: false, code: 'legacy-not-authorised' };
    }
    if (askedForLegacy && allowed) {
      noteError('p2-legacy-used', `legacy experience write authorised by config.diagnostics.allowLegacy (activity ${String(input.activityId ?? '').slice(0, 40)})`);
    }
    return await p2Controller.recordExperience({
      scopeKey: scopeKeyOf(scope),
      activityId: input.activityId ?? '',
      allowLegacy: askedForLegacy && allowed,
    });
  }

  function heartbeatStatus() {
    if (!heartbeatController) return emptyHeartbeatStatus(config.heartbeat?.enabled === true);
    try {
      const reported = heartbeatController.status();
      // The controller is mounted here, so the capability is loaded even if its own switch is
      // off: pendingLoad must be an explicit false, never undefined (contract §12.5.10, review N9).
      return { pendingLoad: false, state: reported.enabled === true ? 'idle' : 'disabled', ...reported };
    } catch (error) {
      noteError('heartbeat-status-failed', error instanceof Error ? error.message : String(error));
      return emptyHeartbeatStatus(config.heartbeat?.enabled === true);
    }
  }

  function pauseHeartbeat(input = {}) {
    if (!heartbeatController) return { ok: false, code: 'heartbeat-not-registered', enabled: config.heartbeat?.enabled === true };
    // Pausing only stops the rule cycle: the runtime, the writer lease, the memory bridge,
    // the contact path and the chat turn keep running (C5 §12.5.9). A pause must never look
    // like a way to enable a disabled heartbeat.
    if (config.heartbeat?.enabled !== true) return { ok: false, code: 'heartbeat-disabled', enabled: false };
    return heartbeatController.pause(String(input.reason ?? 'operator-pause').slice(0, 120));
  }

  function resumeHeartbeat() {
    if (!heartbeatController) return { ok: false, code: 'heartbeat-not-registered', enabled: config.heartbeat?.enabled === true };
    if (config.heartbeat?.enabled !== true) return { ok: false, code: 'heartbeat-disabled', enabled: false };
    return heartbeatController.resume();
  }

  function runHeartbeatCycle(input = {}) {
    if (!heartbeatController) return { ok: false, code: 'heartbeat-not-registered', enabled: config.heartbeat?.enabled === true };
    // A manual/embedded cycle renews our own lease first so a suspended host does not have to
    // wait for the renewal timer; a takeover still fences the commit.
    renewWriterLeaseIfOwned();
    return heartbeatController.cycle({ reason: String(input.reason ?? 'manual') });
  }

  function injectionFor(input = {}) {
    if (mode !== 'active' || !db) {
      lastInjection = { state: mode === 'off' ? 'disabled' : 'inactive', chars: 0, at: Number(clock()) };
      return { text: '', state: lastInjection.state };
    }
    const scope = scopeOf(input);
    if (!scope) { lastInjection = { state: 'unbound', chars: 0, at: Number(clock()) }; return { text: '', state: 'unbound' }; }
    if (!memory.engine) { lastInjection = { state: 'memory-unavailable', chars: 0, at: Number(clock()) }; return { text: '', state: 'memory-unavailable' }; }
    try {
      const scopeKey = scopeKeyOf(scope);
      const configured = Math.max(0, Math.min(Number(input.budgetChars ?? config.injection.budgetChars), config.injection.budgetChars));
      // C4 has to change real behaviour: the short-term state sets a ceiling on the
      // working-memory section, so a tense/低精力 state injects less (or nothing),
      // and ablating a variable must visibly change this decision (A13/B9).
      let stateBudget = configured;
      const projection = db.projection(scopeKey);
      const slice = projection.payload?.state;
      if (slice && Array.isArray(slice.defs)) {
        try {
          stateBudget = describeState(slice, Number(clock())).budgetChars;
        } catch (error) {
          noteError('state-budget-failed', error instanceof Error ? error.message : String(error));
          stateBudget = configured;
        }
      }
      const budget = Math.max(0, Math.min(configured, stateBudget));
      const rendered = renderWorkingMemoryDetailed(db, { scopeKey, budgetChars: budget, now: Number(clock()), timeZone: config.timeZone });
      const text = rendered.text;
      injections += text ? 1 : 0;
      // The caller can tell "nothing to say" apart from "the budget was too small" and
      // from "some commitments were omitted from the prompt but are still stored" (N7).
      lastInjection = {
        state: rendered.state, chars: text.length, at: Number(clock()), budget, stateBudget, configured,
        shownCommitments: rendered.shownCommitments, omittedCommitments: rendered.omittedCommitments,
        shownBeliefs: rendered.shownBeliefs, omittedBeliefs: rendered.omittedBeliefs,
      };
      return {
        text, state: rendered.state, budget,
        shownCommitments: rendered.shownCommitments, omittedCommitments: rendered.omittedCommitments,
        shownBeliefs: rendered.shownBeliefs, omittedBeliefs: rendered.omittedBeliefs,
      };
    } catch (error) {
      noteError('injection-failed', error instanceof Error ? error.message : String(error));
      lastInjection = { state: 'failed', chars: 0, at: Number(clock()) };
      return { text: '', state: 'failed' };
    }
  }

  /**
   * Operator/embedded renewal: keep the writer lease alive without waiting for the
   * timer. Renewal success is **not** business cycle success — `status().heartbeat`
   * reports them separately (C5 §12.5.1).
   */
  function heartbeat() {
    if (!db || !writable || disposed) return { ok: false, code: 'not-writable' };
    try {
      const renewed = db.heartbeatLease({ owner, generation, ttlMs: config.leaseTtlMs });
      if (renewed) {
        leaseInfo = { ...leaseInfo, expiresAt: Number(clock()) + config.leaseTtlMs };
        heartbeatController?.noteLeaseRenewSuccess?.();
      } else {
        heartbeatController?.noteLeaseRenewFailure?.('lease-renew-rejected');
      }
      return { ok: renewed, expiresAt: leaseInfo.expiresAt ?? null };
    } catch (error) {
      noteError('heartbeat-failed', error instanceof Error ? error.message : String(error));
      heartbeatController?.noteLeaseRenewFailure?.('heartbeat-failed');
      return { ok: false, code: 'heartbeat-failed' };
    }
  }

  function agendaStatus(scopeKey) {
    if (!db) return emptyAgendaStatus(config.agenda?.enabled === true);
    let counts = { items: 0, occurrences: {}, nextOccurrenceAt: null };
    try { counts = agendaCounts(db, scopeKey); } catch (error) { noteError('agenda-status-failed', error instanceof Error ? error.message : String(error)); }
    const enabled = config.agenda?.enabled === true;
    return {
      enabled,
      state: enabled ? (mode === 'active' ? 'active' : mode) : 'disabled',
      pendingLoad: false,
      items: Number(counts.items ?? 0),
      occurrences: { scheduled: 0, due: 0, dispatched: 0, skipped: 0, cancelled: 0, expired: 0, ...counts.occurrences },
      nextOccurrenceAt: counts.nextOccurrenceAt ?? null,
      delivery: 'none',
      reminderDelivery: enabled ? 'not-wired' : 'disabled',
    };
  }

  /**
   * C4-3: the assembly hands the publication result back here, so diagnostics can report it.
   * Unknown extra fields are ignored; only `{via, verified, reason}` are read.
   */
  function setAgendaPublication(publication) {
    if (!publication || typeof publication !== 'object') {
      agendaPublication = null;
      return { ok: false, code: 'invalid-publication' };
    }
    agendaPublication = {
      via: String(publication.via ?? 'none'),
      verified: publication.verified === true,
      reason: String(publication.reason ?? ''),
      at: Number(clock()),
    };
    return { ok: true, publication: agendaPublication };
  }

  /**
   * Report a failure into the persistent error record.
   *
   * `severity` is `critical` | `routine` | empty. Empty means "classify it": known codes keep their
   * known level and an **unknown** code is treated as critical (conservative — a code nobody
   * classified is more likely to matter than to be noise).
   */
  function reportError({ code, detail, subject, severity } = {}) {
    const clean = String(code ?? '').trim();
    if (!clean) return { ok: false, code: 'invalid-code' };
    if (!db) return { ok: false, code: 'unbound' };
    noteErrorPersistent(clean, String(detail ?? ''), String(subject ?? ''), String(severity ?? ''));
    return { ok: true };
  }

  /** round-10: the persistent error records, newest first. Read-only, bounded, no SQL details. */
  function errorLog() {
    const read = key => {
      try { return JSON.parse(String(db?.get('SELECT meta_value FROM runtime_meta WHERE meta_key = ?', key)?.meta_value ?? '[]')); } catch { return []; }
    };
    return {
      all: read(PERSISTENT_ERRORS_KEY),
      critical: read(CRITICAL_ERRORS_KEY),
      reviewFailed: read(REVIEW_FAILED_KEY),
    };
  }

  function runtimeStatus(input = {}) {
    if (!db) {
      return statusOf(db ?? emptyDb(), {
        mode, writable, generation, dbFile, stopped, errors, config,
        agenda: emptyAgendaStatus(false),
        heartbeat: emptyHeartbeatStatus(config.heartbeat?.enabled === true),
        p2: p2Status(input),
        agendaPublication,
      });
    }
    const scope = scopeOf(input);
    const scopeKey = scope ? scopeKeyOf(scope) : undefined;
    return statusOf(db, {
      scopeKey, mode, config, lease: leaseInfo, generation, writable, stopped, dbFile,
      schemaVersion: db.schemaVersion(),
      injection: { state: lastInjection.state, chars: lastInjection.chars, count: injections },
      memory: { available: Boolean(memory.engine), version: memory.engine?.version ?? null },
      shadow: { count: proposalCount(db, { scopeKey }), mode, lastDecision: listProposals(db, { scopeKey, limit: 1 })[0]?.decision ?? null },
      errors,
      agenda: agendaStatus(scopeKey),
      heartbeat: heartbeatStatus(),
      p2: p2Status({ scopeKey }),
      agendaPublication,
    });
  }

  function verifyRecovery(input = {}) {
    const scope = scopeOf(input);
    if (!scope) return { ok: false, code: 'unbound' };
    if (!db) return { ok: false, code: 'db-unavailable' };
    return verifyRecoveryOf(db, { scopeKey: scopeKeyOf(scope), handlers, now: clock });
  }

  async function drain(input = {}) {
    if (!db) return { ok: false, code: 'db-unavailable', processed: 0, delivered: 0 };
    if (mode === 'off') return { ok: false, code: 'runtime-disabled', processed: 0, delivered: 0 };
    if (stopped || disposed) return { ok: false, code: 'runtime-stopped', processed: 0, delivered: 0 };
    const scope = scopeOf(input);
    try {
      // The bridge re-checks the writer gate inside every write transaction, so a
      // takeover during the `await` cannot be committed by this generation.
      return await drainOutbox({
        db, memory: memory.engine, generation, owner,
        scopeKey: scope ? scopeKeyOf(scope) : undefined,
        now: Number(clock()), limit: input.limit ?? 20,
        callTimeoutMs: config.bridge?.callTimeoutMs,
        // task-36: a delivered-but-not-applied correction becomes a reviewable todo.
        onAmbiguousCorrection: payload => queueCorrectionReview(payload),
      });
    } catch (error) {
      const runtimeError = error instanceof RuntimeError ? error : new RuntimeError('internal', error instanceof Error ? error.message : String(error));
      noteError(runtimeError.code, runtimeError.message);
      return { ok: false, code: runtimeError.code, processed: 0, delivered: 0 };
    }
  }

  /**
   * One bounded background drain for the P2 pump tick (Codex review R3).
   *
   * `memory/ingest-request` only becomes a memory when `memory_outbox` is drained, and nothing
   * drained it periodically — the chain had never run in production. This is the thunk the P2
   * timer calls once per tick:
   *   - no memory engine → skip quietly (`memory-unavailable`); we never burn the attempt counter
   *     of queued rows just because the engine is not mounted;
   *   - nothing queued → skip before opening a write transaction (an idle tick must stay idle);
   *   - otherwise the normal `drain()` path runs with its own limit, owner/generation fence,
   *     per-claim token and `DRAIN_LOCKS` serialisation.
   */
  function drainOutboxTick() {
    if (!db) return Promise.resolve({ ok: false, code: 'db-unavailable', processed: 0, delivered: 0 });
    if (disposed || stopped || mode === 'off') return Promise.resolve({ ok: true, skipped: 'inactive', processed: 0, delivered: 0 });
    const engine = memory.engine;
    if (!engine || typeof engine.ingestDomainEvent !== 'function') {
      return Promise.resolve({ ok: true, skipped: 'memory-unavailable', processed: 0, delivered: 0 });
    }
    let queued = 0;
    try { queued = Number(db.get("SELECT COUNT(*) AS n FROM memory_outbox WHERE status = 'queued'")?.n ?? 0); } catch { queued = 0; }
    if (queued <= 0) return Promise.resolve({ ok: true, skipped: 'idle', processed: 0, delivered: 0, queued: 0 });
    return drain({ limit: 5 });
  }

  function observeWorkingMemory(input = {}) {
    const scope = scopeOf(input);
    if (!scope || !db) return null;
    return workingMemoryState(db, { scopeKey: scopeKeyOf(scope), now: Number(clock()) });
  }

  function listRuntimeGoals(input = {}) {
    const scope = scopeOf(input);
    if (!scope || !db) return { goals: [] };
    return { goals: listGoals(db, { scopeKey: scopeKeyOf(scope), includeClosed: input.includeClosed === true, limit: input.limit ?? 20 }) };
  }

  function listRuntimeBeliefs(input = {}) {
    const scope = scopeOf(input);
    if (!scope || !db) return { beliefs: [] };
    return { beliefs: currentBeliefs(db, { scopeKey: scopeKeyOf(scope), now: Number(clock()) }) };
  }

  function stateSnapshot(input = {}) {
    const scope = scopeOf(input);
    if (!scope || !db) return null;
    const projection = db.projection(scopeKeyOf(scope));
    const slice = projection.payload?.state;
    return slice ? describeState(slice, Number(clock())) : null;
  }

  function stop(input = {}) {
    stopped = true;
    if (heartbeatController) { try { heartbeatController.stop(); } catch { /* never surface */ } }
    if (p2Controller) { try { p2Controller.stop(); } catch { /* never surface */ } }
    if (db) {
      try { db.setStopped(true, String(input.reason ?? 'operator-stop')); } catch (error) { noteError('stop-failed', error instanceof Error ? error.message : String(error)); }
    }
    return { ok: true, stopped: true };
  }

  /** Operator resume: clears the persisted stop latch. Never re-enables an `enabled:false` config. */
  function resume() {
    if (config.enabled !== true) return { ok: false, code: 'runtime-off' };
    if (db) {
      try { db.setStopped(false); } catch (error) { noteError('resume-failed', error instanceof Error ? error.message : String(error)); return { ok: false, code: 'resume-failed' }; }
    }
    stopped = false;
    return { ok: true, stopped: false, mode };
  }

  function dispose() {
    if (disposed) return { ok: true, already: true };
    disposed = true;
    if (heartbeatTimer) { try { clearInterval(heartbeatTimer); } catch { /* already gone */ } heartbeatTimer = null; }
    if (heartbeatController) { try { heartbeatController.dispose(); } catch { /* never surface */ } }
    if (p2Controller) { try { p2Controller.dispose(); } catch { /* never surface */ } }
    if (db) {
      try { db.releaseLease(generation, owner); } catch { /* best effort */ }
      try { db.close(); } catch { /* already closed */ }
    }
    db = null;
    return { ok: true };
  }

  function setMemory(engine) {
    memory.engine = engine ?? null;
    return { ok: true, available: Boolean(memory.engine) };
  }

  return {
    version: VERSION,
    root,
    dbFile,
    owner,
    generation,
    get mode() { return mode; },
    get writable() { return writable; },
    get stopped() { return stopped; },
    get enabled() { return config.enabled === true; },
    config,
    configFile: loaded.file,
    recordEvent,
    proposeGoal,
    transitionGoal,
    recordGoalStep,
    patchGoal,
    switchFocus,
    resumeFocus,
    makeCommitment,
    endCommitment,
    assertBelief,
    addBeliefEvidence,
    correctBelief,
    expireBeliefs,
    requestMemoryIngest,
    observeSessionEvent,
    // H1 agenda (C5 §12.4)
    listSchedule,
    todaySchedule,
    createSchedule,
    casOccurrence,
    markOccurrenceDispatched,
    nextOccurrence,
    continuitySnapshot,
    retryPendingCorrections,
    correctionReview,
    settleCorrectionResolutions,
    resolveAmbiguousCorrection,
    resolveCorrection,
    setAgendaPublication,
    errorLog,
    reportError,
    correctionResolution,
    listResolved,
    // P2 autonomy (contract logs/p2-autonomous-day/contract-p2.md section 5)
    p2Status,
    // P2.5 dry watch (CONTRACT §15.3): zero-write "what would the next beat claim, and why not".
    p2DispatchWatch,
    // The material the planner consumes, exposed for diagnostics and for tests that must not drift
    // from what the model actually receives.
    p2Materials,
    p2Tick,
    pumpPlanning,
    pumpActivities,
    pumpActivityExecution,
    controlPlanSlot,
    planToday,
    listPlan,
    pausePlanning,
    resumePlanning,
    pauseActivities,
    resumeActivities,
    startActivity,
    stepActivity,
    pauseActivity,
    resumeActivity,
    finishActivity,
    abandonActivity,
    failActivity,
    withdrawShareCandidate,
    reconcileActivities,
    /**
     * round-5 review: the evidenced manual exit for legacy marks whose activity row is gone. Without it
     * those rows are unreachable for ever (skipped by design, and no operator surface to override).
     */
    reauditLegacy: input => {
      if (!p2Controller || typeof p2Controller.reauditLegacy !== 'function') return p2Unavailable();
      const explicit = typeof input?.scopeKey === 'string' ? input.scopeKey.trim() : '';
      const scope = explicit ? parseScope(explicit) : scopeOf(input);
      if (!scope) return { ok: false, code: 'unbound' };
      return p2Controller.reauditLegacy({ ...input, scopeKey: scopeKeyOf(scope) });
    },
    listActivities,
    /**
     * P2.5-2 (A4 §1.4 E1): record one activity outcome as a P1 fact.
     *
     * These are the same functions `activities.mjs` calls as its hooks; exposing them lets a host
     * (and a test) state an outcome that no transition produced — e.g. a slot that never started.
     * They are the only way in: the fact is a normal `memory/ingest-request`, never a direct write.
     */
    recordActivityOutcome: p2ActivityFinished,
    recordMissedSlot: p2ActivityMissed,
    // R4: append-only human resolution of an unresolved external effect, plus its ledger view.
    resolveEffect,
    listEffects,
    capabilitiesOf,
    shareCandidates,
    createShareCandidate,
    submitShareCandidate,
    recordExperience,
    updateSchedule,
    cancelSchedule,
    // H2 rule heartbeat (C5 §12.5)
    heartbeatStatus,
    pauseHeartbeat,
    resumeHeartbeat,
    runHeartbeatCycle,
    injectionFor,
    status: runtimeStatus,
    heartbeat,
    verifyRecovery,
    drainOutbox: drain,
    // R3: one bounded background drain, exactly what the P2 pump tick calls (exposed so an
    // operator/host can force the same path and so tests can drive it deterministically).
    drainOutboxNow: drainOutboxTick,
    enqueueMemoryIngest,
    workingMemory: observeWorkingMemory,
    listGoals: listRuntimeGoals,
    listBeliefs: listRuntimeBeliefs,
    stateSnapshot,
    shadowProposals: input => (db ? listProposals(db, { scopeKey: input?.scopeKey, limit: input?.limit ?? 50 }) : []),
    stop,
    resume,
    dispose,
    setMemory,
    handlers,
    diagnostics: () => errors.slice(),
    formatInstant: ms => formatInstant(ms, config.timeZone),
  };
}

function emptyDb() {
  // A status query on a disabled runtime still returns the same shape.
  return {
    get: () => undefined,
    all: () => [],
    run: () => ({ changes: 0 }),
    projection: () => ({ version: 0, generation: '', payload: {} }),
  };
}

function safeJson(text, fallback) {
  try {
    const parsed = JSON.parse(text ?? '');
    return parsed ?? fallback;
  } catch { return fallback; }
}

export { DEFAULT_CONFIG, CONFIG_VERSION, CONSUMERS, normalizeScope, scopeKeyOf };
