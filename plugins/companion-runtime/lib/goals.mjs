// Goals and commitments — the authoritative lifecycle store (CONTRACT.md §4/§5).
// Every mutation validates expectedRevision — on the public API path and on the event
// path, where a missing revision is its own deterministic rejection
// (`revision-required`) instead of an unversioned write — appends a compact
// {action, at, revision, reason} history entry and never rewrites a terminal goal.
// Authorization is stored next to the plan but never inferred from text.
// The bounded view (focus, render) belongs to lib/working-memory.mjs.
import crypto from 'node:crypto';
import { CONSUMERS } from './events.mjs';
import { RuntimeError, ScopeError, StaleRevisionError, ValidationError } from './errors.mjs';
import { normalizeScope, scopeKey as keyOf } from './scope.mjs';

export const GOAL_STATUS = Object.freeze(['proposed', 'accepted', 'running', 'paused', 'completed', 'cancelled']);
export const AUTHORIZATION = Object.freeze(['none', 'reminder', 'tool', 'proactive-contact']);

const TERMINAL = new Set(['completed', 'cancelled']);
// The frozen matrix (CONTRACT.md §4): proposed→accepted→running→paused→running, plus
// →completed and →cancelled. There is no proposed→running shortcut: "just start it"
// records the legal accepted and running steps, each with its own history entry.
// completed/cancelled are terminal: a follow-up needs a new goal with causation.
const TRANSITIONS = Object.freeze({
  proposed: Object.freeze(['accepted', 'cancelled']),
  accepted: Object.freeze(['running', 'cancelled']),
  running: Object.freeze(['paused', 'completed', 'cancelled']),
  paused: Object.freeze(['running', 'completed', 'cancelled']),
  completed: Object.freeze([]),
  cancelled: Object.freeze([]),
});
const KIND_STATUS = Object.freeze({
  'goal/accepted': 'accepted',
  'goal/started': 'running',
  'goal/paused': 'paused',
  'goal/resumed': 'running',
  'goal/completed': 'completed',
  'goal/cancelled': 'cancelled',
});
// Event kinds that change an existing goal line. The event path has no other fence, so
// each of these must carry `payload.expectedRevision`; `goal/proposed` only inserts a
// row and `goal/overdue` only sets a derived flag, so both stay exempt (CONTRACT.md §4).
// Derived from KIND_STATUS so a new transition kind cannot silently escape the fence.
const FENCED_EVENT_KINDS = Object.freeze(new Set([...Object.keys(KIND_STATUS), 'goal/step', 'goal/updated']));
const SLICE = 'goals';
const HISTORY_LIMIT = 40;
const TEXT_LIMIT = 400;
const PATCH_KEYS = new Set(['title', 'nextStep', 'waitingOn', 'deadlineAt', 'source', 'authorization']);

// ---------------------------------------------------------------- small helpers

function jsonOr(text, fallback) {
  try {
    const value = JSON.parse(text ?? '');
    return value ?? fallback;
  } catch { return fallback; }
}

function code(value, limit = 60) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function text(value, field, limit = TEXT_LIMIT) {
  if (typeof value !== 'string' || value.trim() === '') throw new ValidationError(`${field} is required`);
  const trimmed = value.trim();
  if (trimmed.length > limit) throw new ValidationError(`${field} is longer than ${limit} characters`);
  return trimmed;
}

function intOrNull(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new ValidationError(`${field} must be an epoch millisecond`);
  return Math.trunc(number);
}

function atOf(nowValue, db) {
  const number = Number(nowValue);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : db.now();
}

// API path: the caller must name the revision it read; bad input is `invalid-input`.
function revisionOf(expectedRevision) {
  if (expectedRevision === undefined || expectedRevision === null || expectedRevision === '') {
    throw new ValidationError('expectedRevision is required');
  }
  const number = Number(expectedRevision);
  if (!Number.isFinite(number)) throw new ValidationError('expectedRevision must be an integer');
  return Math.trunc(number);
}

// The frozen signature of `closeCommitment` has no revision slot; when one is supplied
// it is honoured, never guessed.
function optionalRevisionOf(expectedRevision) {
  if (expectedRevision === undefined || expectedRevision === null || expectedRevision === '') return null;
  return revisionOf(expectedRevision);
}

// Event path: `payload.expectedRevision` is the fence, so its absence is a typed
// deterministic rejection rather than a silent unversioned write (A07).
function eventRevision(payload, kind) {
  const value = payload?.expectedRevision;
  if (value === undefined || value === null || value === '') {
    throw new RuntimeError('revision-required', `${kind} requires payload.expectedRevision`);
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new RuntimeError('revision-required', `${kind} requires a finite payload.expectedRevision`);
  }
  return Math.trunc(number);
}

function assertRevision(kind, expected, actual) {
  if (expected === null) return;
  if (expected !== actual) throw new StaleRevisionError(kind, expected, actual);
}

function resolveKey({ scope, scopeKey } = {}) {
  const fromScope = scope ? keyOf(normalizeScope(scope)) : '';
  const given = typeof scopeKey === 'string' ? scopeKey.trim() : '';
  if (fromScope && given && fromScope !== given) throw new ScopeError('scope and scopeKey disagree');
  const key = fromScope || given;
  if (!key) throw new ValidationError('a scope or scopeKey is required');
  return key;
}

function keyArgument(scopeKeyValue) {
  if (typeof scopeKeyValue === 'string' && scopeKeyValue.trim()) return scopeKeyValue.trim();
  if (scopeKeyValue && typeof scopeKeyValue === 'object') return resolveKey({ scope: scopeKeyValue });
  throw new ValidationError('a scopeKey is required');
}

// ---------------------------------------------------------------- row mapping

function rowToGoal(row, { withHistory = true } = {}) {
  if (!row) return null;
  const goal = {
    goalId: row.goal_id,
    scopeKey: row.scope,
    title: row.title,
    source: row.source,
    authorization: row.authorization,
    status: row.status,
    overdue: Number(row.overdue) === 1,
    deadlineAt: row.deadline_at === null ? null : Number(row.deadline_at),
    revision: Number(row.revision),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    completedSteps: jsonOr(row.completed_steps, []),
    nextStep: row.next_step,
    waitingOn: row.waiting_on,
    supersededBy: row.superseded_by,
  };
  if (withHistory) goal.history = jsonOr(row.history, []);
  return goal;
}

function rowToCommitment(row) {
  if (!row) return null;
  return {
    commitmentId: row.commitment_id,
    scopeKey: row.scope,
    goalId: row.goal_id,
    text: row.body ?? row.text,
    status: row.status,
    dueAt: row.due_at === null ? null : Number(row.due_at),
    revision: Number(row.revision),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    closedReason: row.closed_reason,
  };
}

// schema v1 names the commitment text column `body`; tolerate the `text` spelling so a
// rename inside the frozen schema cannot silently break writes.
const commitmentColumns = new WeakMap();
function commitmentTextColumn(db) {
  const cached = commitmentColumns.get(db);
  if (cached) return cached;
  const names = db.all('PRAGMA table_info(commitments)').map(column => column.name);
  const column = names.includes('body') ? 'body' : names.includes('text') ? 'text' : '';
  if (!column) throw new RuntimeError('schema-mismatch', 'commitments has no text column');
  commitmentColumns.set(db, column);
  return column;
}

function pushHistory(history, entry) {
  const compact = { action: entry.action, at: entry.at, revision: entry.revision, reason: entry.reason ?? '' };
  const next = Array.isArray(history) ? history.slice(-(HISTORY_LIMIT - 1)) : [];
  next.push(compact);
  return next;
}

function readGoal(db, scope, goalId) {
  return rowToGoal(db.get('SELECT * FROM goals WHERE scope = ? AND goal_id = ?', scope, goalId));
}

function readCommitmentRow(db, scope, commitmentId) {
  return db.get('SELECT * FROM commitments WHERE scope = ? AND commitment_id = ?', scope, commitmentId);
}

// ------------------------------------------------------- goals namespace slice

// The projection slice carries only counters and the collection revision: it is an
// optimistic-concurrency anchor for `proposeGoal`, not a copy of plan content.
function readSlice(db, scope) {
  const projection = db.projection(scope);
  const slice = projection.payload?.[SLICE];
  return { projection, slice: slice && typeof slice === 'object' ? slice : {} };
}

function scopeCounts(db, scope) {
  const goals = db.get(
    "SELECT COUNT(*) AS n, SUM(CASE WHEN overdue = 1 THEN 1 ELSE 0 END) AS overdue FROM goals WHERE scope = ? AND status NOT IN ('completed','cancelled')",
    scope);
  const commitments = db.get("SELECT COUNT(*) AS n FROM commitments WHERE scope = ? AND status = 'open'", scope);
  return { active: Number(goals?.n ?? 0), overdue: Number(goals?.overdue ?? 0), openCommitments: Number(commitments?.n ?? 0) };
}

function syncSlice(db, scope, { at, action, goalId }) {
  const { projection, slice } = readSlice(db, scope);
  const next = {
    ...slice,
    revision: Number(slice.revision ?? 0) + 1,
    ...scopeCounts(db, scope),
    updatedAt: at,
    lastAction: action,
    lastGoalId: goalId ?? slice.lastGoalId ?? '',
  };
  db.commitProjection({ scope, expectedVersion: projection.version, payload: { ...projection.payload, [SLICE]: next }, updatedAt: at });
  return next;
}

// ------------------------------------------------------------- row-level writes
// The row helpers below never touch the projection: callers either wrap them in a
// public API (which syncs the slice) or run them inside a consumer `extra`.

function insertGoalRow(db, { scopeKey: scope, goalId, title, source, authorization, deadlineAt, nextStep, waitingOn = '', at }) {
  const history = [{ action: 'proposed', at, revision: 1, reason: code(source, 40) }];
  db.run(`INSERT INTO goals (goal_id, scope, title, source, authorization, status, overdue, deadline_at,
            revision, created_at, updated_at, completed_steps, next_step, waiting_on, checkpoint, superseded_by, history)
          VALUES (?, ?, ?, ?, ?, 'proposed', 0, ?, 1, ?, ?, '[]', ?, ?, '{}', '', ?)`,
  goalId, scope, title, source, authorization, deadlineAt, at, at, nextStep, waitingOn, JSON.stringify(history));
  return readGoal(db, scope, goalId);
}

function transitionRow(db, { scopeKey: scope, goalId, to, expectedRevision, reason, at }) {
  if (!GOAL_STATUS.includes(to)) throw new ValidationError(`unknown goal status: ${to}`);
  const goal = readGoal(db, scope, goalId);
  if (!goal) throw new RuntimeError('unknown-goal', `goal ${goalId} is not in this scope`);
  // The revision fence comes first: a *new* event may not use "already in that status"
  // as a shortcut around it (B3). Re-delivery is handled by the consumer receipt.
  assertRevision('goal', revisionOf(expectedRevision), goal.revision);
  if (goal.status === to) return { kept: true, goal };
  if (TERMINAL.has(goal.status)) {
    throw new RuntimeError('terminal-state', `${goalId} is ${goal.status}; a new goal with a cause is required`);
  }
  if (!(TRANSITIONS[goal.status] ?? []).includes(to)) {
    throw new RuntimeError('invalid-transition', `${goal.status} → ${to} is not allowed`);
  }
  const revision = goal.revision + 1;
  const history = pushHistory(goal.history, { action: to, at, revision, reason: code(reason) });
  db.run('UPDATE goals SET status = ?, revision = ?, updated_at = ?, history = ? WHERE scope = ? AND goal_id = ?',
    to, revision, at, JSON.stringify(history), scope, goalId);
  return { kept: false, goal: { ...goal, status: to, revision, updatedAt: at, history } };
}

function recordStepRow(db, { scopeKey: scope, goalId, step, expectedRevision, at }) {
  const goal = readGoal(db, scope, goalId);
  if (!goal) throw new RuntimeError('unknown-goal', `goal ${goalId} is not in this scope`);
  const body = text(step, 'step');
  // Fence first, then duplicate detection: an old plan may not replay a step into a
  // newer revision just because the text happens to match (B3).
  assertRevision('goal', revisionOf(expectedRevision), goal.revision);
  if (goal.completedSteps.includes(body)) return { duplicated: true, goal };
  if (TERMINAL.has(goal.status)) throw new RuntimeError('terminal-state', `${goalId} is ${goal.status}; no step is accepted`);
  const revision = goal.revision + 1;
  const completedSteps = [...goal.completedSteps, body].slice(-100);
  const history = pushHistory(goal.history, { action: 'step', at, revision, reason: '' });
  db.run('UPDATE goals SET completed_steps = ?, revision = ?, updated_at = ?, history = ? WHERE scope = ? AND goal_id = ?',
    JSON.stringify(completedSteps), revision, at, JSON.stringify(history), scope, goalId);
  return { duplicated: false, goal: { ...goal, completedSteps, revision, updatedAt: at, history } };
}

function updateRow(db, { scopeKey: scope, goalId, patch, expectedRevision, at }) {
  const goal = readGoal(db, scope, goalId);
  if (!goal) throw new RuntimeError('unknown-goal', `goal ${goalId} is not in this scope`);
  // Same rule as the transitions: the fence is checked before any "nothing changes"
  // early return, so an empty or unchanged patch cannot bypass it (B3).
  assertRevision('goal', revisionOf(expectedRevision), goal.revision);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new ValidationError('patch must be an object');
  const keys = Object.keys(patch);
  if (!keys.length) return { kept: true, goal, changed: [] };
  for (const key of keys) {
    if (!PATCH_KEYS.has(key)) {
      throw new ValidationError(key === 'status'
        ? 'status is not patchable; use transitionGoal'
        : `patch field is not updatable: ${key}`);
    }
  }
  const next = {
    title: goal.title,
    nextStep: goal.nextStep,
    waitingOn: goal.waitingOn,
    deadlineAt: goal.deadlineAt,
    source: goal.source,
    authorization: goal.authorization,
  };
  const changed = [];
  if ('title' in patch) {
    const value = text(patch.title, 'title');
    if (value !== next.title) { next.title = value; changed.push('title'); }
  }
  if ('nextStep' in patch) {
    const value = patch.nextStep === null ? '' : text(patch.nextStep, 'nextStep');
    if (value !== next.nextStep) { next.nextStep = value; changed.push('nextStep'); }
  }
  if ('waitingOn' in patch) {
    const value = patch.waitingOn === null ? '' : text(patch.waitingOn, 'waitingOn');
    if (value !== next.waitingOn) { next.waitingOn = value; changed.push('waitingOn'); }
  }
  if ('deadlineAt' in patch) {
    const value = intOrNull(patch.deadlineAt, 'deadlineAt');
    if (value !== next.deadlineAt) { next.deadlineAt = value; changed.push('deadlineAt'); }
  }
  if ('source' in patch) {
    const value = code(patch.source, 40);
    if (value !== next.source) { next.source = value; changed.push('source'); }
  }
  // Authorization only moves when it is named explicitly; wording in title/nextStep
  // ("提醒我…") is plan text and never an upgrade path.
  if ('authorization' in patch) {
    if (!AUTHORIZATION.includes(patch.authorization)) throw new ValidationError(`unknown authorization: ${patch.authorization}`);
    if (patch.authorization !== next.authorization) { next.authorization = patch.authorization; changed.push('authorization'); }
  }
  if (!changed.length) return { kept: true, goal, changed };
  if (TERMINAL.has(goal.status)) throw new RuntimeError('terminal-state', `${goalId} is ${goal.status}; the plan is closed`);
  const revision = goal.revision + 1;
  const overdue = next.deadlineAt !== null && next.deadlineAt <= at ? 1 : 0;
  const history = pushHistory(goal.history, { action: 'updated', at, revision, reason: code(changed.join(','), 60) });
  db.run(`UPDATE goals SET title = ?, source = ?, authorization = ?, deadline_at = ?, overdue = ?, next_step = ?,
            waiting_on = ?, revision = ?, updated_at = ?, history = ? WHERE scope = ? AND goal_id = ?`,
  next.title, next.source, next.authorization, next.deadlineAt, overdue, next.nextStep,
  next.waitingOn, revision, at, JSON.stringify(history), scope, goalId);
  return { kept: false, changed, goal: { ...goal, ...next, overdue: overdue === 1, revision, updatedAt: at, history } };
}

function markOverdueRows(db, { scopeKey: scope, at }) {
  const rows = db.all(`SELECT goal_id FROM goals WHERE scope = ? AND overdue = 0 AND deadline_at IS NOT NULL
    AND deadline_at <= ? AND status NOT IN ('completed','cancelled')`, scope, at);
  if (!rows.length) return { marked: 0, goalIds: [] };
  for (const row of rows) {
    const goal = readGoal(db, scope, row.goal_id);
    // Derived flag: recorded in history but does not advance `revision`, so a client
    // that read revision N can still commit its next step after a deadline sweep.
    const history = pushHistory(goal.history, { action: 'overdue', at, revision: goal.revision, reason: 'deadline' });
    db.run('UPDATE goals SET overdue = 1, updated_at = ?, history = ? WHERE scope = ? AND goal_id = ?',
      at, JSON.stringify(history), scope, row.goal_id);
  }
  return { marked: rows.length, goalIds: rows.map(row => row.goal_id) };
}

function insertCommitmentRow(db, { scopeKey: scope, commitmentId, goalId, body, dueAt, at }) {
  const existing = readCommitmentRow(db, scope, commitmentId);
  if (existing) return { kept: true, commitment: rowToCommitment(existing) };
  if (goalId) {
    const goal = readGoal(db, scope, goalId);
    if (!goal) throw new RuntimeError('unknown-goal', `goal ${goalId} is not in this scope`);
  }
  const column = commitmentTextColumn(db);
  db.run(`INSERT INTO commitments (commitment_id, scope, goal_id, ${column}, status, due_at, revision, created_at, updated_at, closed_reason)
          VALUES (?, ?, ?, ?, 'open', ?, 1, ?, ?, '')`, commitmentId, scope, goalId, body, dueAt, at, at);
  return { kept: false, commitment: rowToCommitment(readCommitmentRow(db, scope, commitmentId)) };
}

function closeCommitmentRow(db, { scopeKey: scope, commitmentId, reason, expectedRevision, at }) {
  const row = readCommitmentRow(db, scope, commitmentId);
  if (!row) throw new RuntimeError('unknown-commitment', `commitment ${commitmentId} is not in this scope`);
  const commitment = rowToCommitment(row);
  if (commitment.status === 'closed') return { kept: true, commitment };
  assertRevision('commitment', optionalRevisionOf(expectedRevision), commitment.revision);
  const revision = commitment.revision + 1;
  db.run("UPDATE commitments SET status = 'closed', closed_reason = ?, revision = ?, updated_at = ? WHERE scope = ? AND commitment_id = ?",
    code(reason, 60), revision, at, scope, commitmentId);
  return { kept: false, commitment: { ...commitment, status: 'closed', closedReason: code(reason, 60), revision, updatedAt: at } };
}

// ------------------------------------------------------------------ public API

/** Create a goal. `expectedRevision` is the goals collection revision (listGoals). */
export function proposeGoal(db, options = {}) {
  const scope = resolveKey(options);
  const at = atOf(options.now, db);
  const title = text(options.title, 'title');
  const source = code(options.source ?? 'conversation', 40) || 'conversation';
  const authorization = options.authorization ?? 'none';
  if (!AUTHORIZATION.includes(authorization)) throw new ValidationError(`unknown authorization: ${authorization}`);
  const deadlineAt = intOrNull(options.deadlineAt, 'deadlineAt');
  const nextStep = typeof options.nextStep === 'string' && options.nextStep.trim() ? text(options.nextStep, 'nextStep') : '';
  const waitingOn = typeof options.waitingOn === 'string' && options.waitingOn.trim() ? text(options.waitingOn, 'waitingOn') : '';
  const expectedRevision = revisionOf(options.expectedRevision);
  const goalId = typeof options.goalId === 'string' && options.goalId.trim() ? options.goalId.trim() : `goal_${crypto.randomUUID()}`;
  return db.tx(() => {
    const { slice } = readSlice(db, scope);
    assertRevision(SLICE, expectedRevision, Number(slice.revision ?? 0));
    const goal = insertGoalRow(db, { scopeKey: scope, goalId, title, source, authorization, deadlineAt, nextStep, waitingOn, at });
    const next = syncSlice(db, scope, { at, action: 'goal/proposed', goalId });
    return { ok: true, goalId, status: goal.status, revision: goal.revision, scopeKey: scope, goalsRevision: next.revision };
  });
}

export function transitionGoal(db, options = {}) {
  const scope = resolveKey(options);
  const at = atOf(options.now, db);
  const goalId = text(options.goalId, 'goalId', 120);
  return db.tx(() => {
    const outcome = transitionRow(db, {
      scopeKey: scope, goalId, to: options.to, expectedRevision: options.expectedRevision, reason: options.reason, at,
    });
    if (outcome.kept) return { ok: true, kept: true, goalId, status: outcome.goal.status, revision: outcome.goal.revision };
    const next = syncSlice(db, scope, { at, action: `goal/${options.to}`, goalId });
    return { ok: true, kept: false, goalId, status: outcome.goal.status, revision: outcome.goal.revision, goalsRevision: next.revision };
  });
}

export function recordStep(db, options = {}) {
  const scope = resolveKey(options);
  const at = atOf(options.now, db);
  const goalId = text(options.goalId, 'goalId', 120);
  return db.tx(() => {
    const outcome = recordStepRow(db, { scopeKey: scope, goalId, step: options.step, expectedRevision: options.expectedRevision, at });
    const next = outcome.duplicated ? null : syncSlice(db, scope, { at, action: 'goal/step', goalId });
    return {
      ok: true,
      goalId,
      duplicated: outcome.duplicated,
      revision: outcome.goal.revision,
      completedSteps: outcome.goal.completedSteps.length,
      ...(next ? { goalsRevision: next.revision } : {}),
    };
  });
}

export function updateGoal(db, options = {}) {
  const scope = resolveKey(options);
  const at = atOf(options.now, db);
  const goalId = text(options.goalId, 'goalId', 120);
  return db.tx(() => {
    const outcome = updateRow(db, { scopeKey: scope, goalId, patch: options.patch, expectedRevision: options.expectedRevision, at });
    if (outcome.kept) {
      return { ok: true, kept: true, goalId, revision: outcome.goal.revision, changed: [], authorization: outcome.goal.authorization };
    }
    const next = syncSlice(db, scope, { at, action: 'goal/updated', goalId });
    return {
      ok: true,
      kept: false,
      goalId,
      revision: outcome.goal.revision,
      changed: outcome.changed,
      authorization: outcome.goal.authorization,
      goalsRevision: next.revision,
    };
  });
}

/** Deadline sweep: sets overdue=1 only. Never completes, never deletes. */
export function markOverdue(db, options = {}) {
  const scope = resolveKey(options);
  const at = atOf(options.now, db);
  return db.tx(() => {
    const outcome = markOverdueRows(db, { scopeKey: scope, at });
    if (outcome.marked) syncSlice(db, scope, { at, action: 'goal/overdue', goalId: outcome.goalIds[0] });
    return { ok: true, marked: outcome.marked, goalIds: outcome.goalIds };
  });
}

export function getGoal(db, scopeKeyValue, goalId) {
  const scope = keyArgument(scopeKeyValue);
  return readGoal(db, scope, text(goalId, 'goalId', 120));
}

/** Goals of one scope. The returned array carries the collection revision as `.revision`. */
export function listGoals(db, { scope, scopeKey, status, includeClosed = false, limit = 50 } = {}) {
  const key = resolveKey({ scope, scopeKey });
  const clauses = ['scope = ?'];
  const params = [key];
  if (status) {
    if (!GOAL_STATUS.includes(status)) throw new ValidationError(`unknown goal status: ${status}`);
    clauses.push('status = ?');
    params.push(status);
  } else if (!includeClosed) {
    clauses.push("status NOT IN ('completed','cancelled')");
  }
  const rows = db.all(`SELECT * FROM goals WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC, goal_id ASC LIMIT ?`,
    ...params, Math.max(1, Math.trunc(Number(limit) || 50)));
  const list = rows.map(row => rowToGoal(row, { withHistory: false }));
  list.revision = Number(readSlice(db, key).slice.revision ?? 0);
  return list;
}

/** Commitment of one scope. Each item carries a read-time `overdue` flag; `status` never moves on its own. */
export function listCommitments(db, { scope, scopeKey, status } = {}) {
  const key = resolveKey({ scope, scopeKey });
  const params = [key];
  let where = 'scope = ?';
  if (status) {
    if (status !== 'open' && status !== 'closed') throw new ValidationError(`unknown commitment status: ${status}`);
    where += ' AND status = ?';
    params.push(status);
  }
  const at = db.now();
  return db.all(`SELECT * FROM commitments WHERE ${where}
    ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, COALESCE(due_at, created_at) ASC, created_at ASC`, ...params)
    .map(rowToCommitment)
    .map(commitment => ({
      ...commitment,
      overdue: commitment.status === 'open' && commitment.dueAt !== null && commitment.dueAt <= at,
    }));
}

export function createCommitment(db, options = {}) {
  const scope = resolveKey(options);
  const at = atOf(options.now, db);
  const body = text(options.text, 'text', 300);
  const dueAt = intOrNull(options.dueAt, 'dueAt');
  const goalId = options.goalId ? text(options.goalId, 'goalId', 120) : '';
  const commitmentId = typeof options.commitmentId === 'string' && options.commitmentId.trim()
    ? options.commitmentId.trim()
    : `cm_${crypto.randomUUID()}`;
  return db.tx(() => {
    if (options.expectedRevision !== undefined && options.expectedRevision !== null) {
      const { slice } = readSlice(db, scope);
      assertRevision(SLICE, revisionOf(options.expectedRevision), Number(slice.revision ?? 0));
    }
    const outcome = insertCommitmentRow(db, { scopeKey: scope, commitmentId, goalId, body, dueAt, at });
    if (outcome.kept) {
      return { ok: true, kept: true, commitmentId, status: outcome.commitment.status, revision: outcome.commitment.revision };
    }
    const next = syncSlice(db, scope, { at, action: 'commitment/made', goalId });
    return { ok: true, kept: false, commitmentId, status: outcome.commitment.status, revision: outcome.commitment.revision, goalsRevision: next.revision };
  });
}

/**
 * Explicit close. Silence, a missing reply or a passed dueAt never closes or expires
 * a commitment; only this call does. `expectedRevision` is optional (frozen signature
 * has no slot for it) and is checked against the commitment revision when supplied.
 */
export function closeCommitment(db, options = {}) {
  const scope = resolveKey(options);
  const at = atOf(options.now, db);
  const commitmentId = text(options.commitmentId, 'commitmentId', 120);
  return db.tx(() => {
    const outcome = closeCommitmentRow(db, {
      scopeKey: scope, commitmentId, reason: options.reason, expectedRevision: options.expectedRevision, at,
    });
    if (outcome.kept) {
      return { ok: true, kept: true, commitmentId, status: 'closed', revision: outcome.commitment.revision };
    }
    const next = syncSlice(db, scope, { at, action: 'commitment/closed', goalId: outcome.commitment.goalId });
    return { ok: true, kept: false, commitmentId, status: 'closed', revision: outcome.commitment.revision, goalsRevision: next.revision };
  });
}

// -------------------------------------------------------------- consumer reducer

function goalIdFrom(payload, event) {
  const given = typeof payload.goalId === 'string' ? payload.goalId.trim() : '';
  return given || `goal_${String(event.eventId ?? '').slice(-16)}`;
}

function requiredGoalId(payload, kind) {
  const given = typeof payload.goalId === 'string' ? payload.goalId.trim() : '';
  if (!given) throw new ValidationError(`${kind} requires payload.goalId`);
  return given;
}

function commitmentIdFrom(payload, event) {
  const given = typeof payload.commitmentId === 'string' ? payload.commitmentId.trim() : '';
  return given || `cm_${String(event.eventId ?? '').slice(-16)}`;
}

function requiredCommitmentId(payload, kind) {
  const given = typeof payload.commitmentId === 'string' ? payload.commitmentId.trim() : '';
  if (!given) throw new ValidationError(`${kind} requires payload.commitmentId`);
  return given;
}

function eventPatch(payload) {
  if (payload.patch && typeof payload.patch === 'object') return payload.patch;
  return Object.fromEntries(Object.entries(payload).filter(([key, value]) => PATCH_KEYS.has(key) && value !== undefined));
}

function applyGoalKind(db, { event, kind, payload, scopeKey: scope, at }) {
  // The event path must name the revision it was planned against; without that fence an
  // old suggestion could rewrite a newer plan (B3/A07). Enforced before any row is read,
  // so a refused event leaves no trace even when the goal itself is well formed.
  const expectedRevision = FENCED_EVENT_KINDS.has(kind) ? eventRevision(payload, kind) : undefined;
  if (kind === 'goal/proposed') {
    const goalId = goalIdFrom(payload, event);
    const existing = readGoal(db, scope, goalId);
    if (existing) return { goalId, result: { action: 'kept', goalId, status: existing.status, revision: existing.revision } };
    const authorization = payload.authorization ?? 'none';
    if (!AUTHORIZATION.includes(authorization)) throw new ValidationError(`unknown authorization: ${authorization}`);
    const goal = insertGoalRow(db, {
      scopeKey: scope,
      goalId,
      title: text(payload.title, 'title'),
      source: code(payload.source ?? 'event', 40) || 'event',
      authorization,
      deadlineAt: intOrNull(payload.deadlineAt, 'deadlineAt'),
      nextStep: typeof payload.nextStep === 'string' && payload.nextStep.trim() ? text(payload.nextStep, 'nextStep') : '',
      waitingOn: typeof payload.waitingOn === 'string' && payload.waitingOn.trim() ? text(payload.waitingOn, 'waitingOn') : '',
      at,
    });
    return { goalId, result: { action: 'proposed', goalId, status: goal.status, revision: goal.revision } };
  }

  const to = KIND_STATUS[kind];
  if (to) {
    const goalId = requiredGoalId(payload, kind);
    const outcome = transitionRow(db, {
      scopeKey: scope, goalId, to, expectedRevision, reason: payload.reason, at,
    });
    return {
      goalId,
      result: { action: outcome.kept ? 'kept' : to, goalId, status: outcome.goal.status, revision: outcome.goal.revision },
    };
  }

  if (kind === 'goal/step') {
    const goalId = requiredGoalId(payload, kind);
    const outcome = recordStepRow(db, { scopeKey: scope, goalId, step: payload.step, expectedRevision, at });
    return { goalId, result: { action: outcome.duplicated ? 'kept' : 'step', goalId, revision: outcome.goal.revision } };
  }

  if (kind === 'goal/updated') {
    const goalId = requiredGoalId(payload, kind);
    const outcome = updateRow(db, { scopeKey: scope, goalId, patch: eventPatch(payload), expectedRevision, at });
    return { goalId, result: { action: outcome.kept ? 'kept' : 'updated', goalId, revision: outcome.goal.revision, changed: outcome.changed.length } };
  }

  if (kind === 'goal/overdue') {
    const outcome = markOverdueRows(db, { scopeKey: scope, at });
    return { goalId: undefined, result: { action: 'overdue', marked: outcome.marked } };
  }

  if (kind === 'commitment/made') {
    const commitmentId = commitmentIdFrom(payload, event);
    const outcome = insertCommitmentRow(db, {
      scopeKey: scope,
      commitmentId,
      goalId: payload.goalId ? text(payload.goalId, 'goalId', 120) : '',
      body: text(payload.text, 'text', 300),
      dueAt: intOrNull(payload.dueAt, 'dueAt'),
      at,
    });
    return { goalId: payload.goalId, result: { action: outcome.kept ? 'kept' : 'made', commitmentId, status: outcome.commitment.status, revision: outcome.commitment.revision } };
  }

  if (kind === 'commitment/closed') {
    const commitmentId = requiredCommitmentId(payload, kind);
    const outcome = closeCommitmentRow(db, { scopeKey: scope, commitmentId, reason: payload.reason, expectedRevision: payload.expectedRevision, at });
    return { goalId: outcome.commitment.goalId, result: { action: outcome.kept ? 'kept' : 'closed', commitmentId, revision: outcome.commitment.revision } };
  }

  throw new ValidationError(`goal consumer does not handle ${kind}`);
}

/**
 * Reducer for the `goals` consumer. Returns `{ slice, result, extra }`; row writes and
 * counter fill happen in `extra` so they share the caller's transaction. Called twice
 * with the same event it is a no-op (duplicate detection lives in the row helpers).
 */
export function applyGoalEvent({ db, event, slice, now } = {}) {
  const kind = typeof event?.kind === 'string' ? event.kind : '';
  if (!CONSUMERS.goals.includes(kind)) return {};
  const scope = event.scopeKey ?? resolveKey({ scope: event.scope });
  const at = atOf(now, db);
  const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
  const previous = slice && typeof slice === 'object' ? slice : {};
  const next = { ...previous };
  const result = {};
  const extra = (database) => {
    const outcome = applyGoalKind(database, { event, kind, payload, scopeKey: scope, at });
    // `applyEvent` reads slice/result after `extra`, so filling them here keeps the
    // counters honest without a second write path.
    Object.assign(next, {
      revision: Number(previous.revision ?? 0) + 1,
      ...scopeCounts(database, scope),
      updatedAt: at,
      lastEventId: event.eventId,
      lastAction: kind,
      lastGoalId: outcome.goalId ?? previous.lastGoalId ?? '',
    });
    Object.assign(result, outcome.result);
  };
  return { slice: next, result, extra };
}
