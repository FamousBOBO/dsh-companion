// Working memory — the bounded, retractable view for one scope (CONTRACT.md §4/§6).
// One focus per scope, checkpoints on every switch, partial updates for interjections
// and a fixed-order render that spends its budget on whole commitments first and says
// how many did not fit. Checkpoint ids and payloads are replay-stable (B4/A08), so a
// recovery replay reproduces byte-identical rows. Recovery reads the persisted rows;
// nothing here keeps per-process state.
import crypto from 'node:crypto';
import { CONSUMERS } from './events.mjs';
import { RuntimeError, ScopeError, StaleRevisionError, ValidationError } from './errors.mjs';
import { normalizeScope, scopeKey as keyOf } from './scope.mjs';
import { getGoal, listCommitments, listGoals } from './goals.mjs';
import { currentBeliefs } from './beliefs.mjs';

const SLICE = 'working-memory';
const TERMINAL = new Set(['completed', 'cancelled']);
// Goals that "继续刚才的" may resume. proposed is a draft, not resumable work.
const RESUME = new Set(['accepted', 'running', 'paused']);
const NOTE_LIMIT = 120;
const DEFAULT_BUDGET = 320;
// Below this nothing meaningful fits (not even the overflow marker plus a label), so
// the render is empty instead of an unusable fragment.
const MIN_BUDGET = 40;
const SHANGHAI_OFFSET_MS = 8 * 3600000;
const LABEL = Object.freeze({
  commitments: '【承诺】',
  goal: '【目标】',
  next: '下一步：',
  waiting: '【等待】',
  steps: '【已完成】',
  belief: '【判断】',
});
const STATUS_LABEL = Object.freeze({
  proposed: '待确认',
  accepted: '已接受',
  running: '进行中',
  paused: '已暂停',
  completed: '已完成',
  cancelled: '已取消',
});

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

function text(value, field, limit = 400) {
  if (typeof value !== 'string' || value.trim() === '') throw new ValidationError(`${field} is required`);
  const trimmed = value.trim();
  if (trimmed.length > limit) throw new ValidationError(`${field} is longer than ${limit} characters`);
  return trimmed;
}

function atOf(nowValue, db) {
  const number = Number(nowValue);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : db.now();
}

function revisionOf(expectedRevision, mode = 'api') {
  if (expectedRevision === undefined || expectedRevision === null) {
    if (mode === 'event') return null;
    throw new ValidationError('expectedRevision is required');
  }
  const number = Number(expectedRevision);
  if (!Number.isFinite(number)) throw new ValidationError('expectedRevision must be an integer');
  return Math.trunc(number);
}

function assertRevision(expected, actual) {
  if (expected === null) return;
  if (expected !== actual) throw new StaleRevisionError(SLICE, expected, actual);
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

function goalIdArgument(value, field = 'goalId') {
  if (value === undefined || value === null || value === '') return '';
  return text(value, field, 120);
}

// --------------------------------------------------------------- persisted view

function readRow(db, scope) {
  return db.get('SELECT * FROM working_memory WHERE scope = ?', scope) ?? {
    scope,
    focus_goal_id: '',
    focus_kind: '',
    pending_goal: '',
    revision: 0,
    updated_at: 0,
    view: '{}',
  };
}

function readView(row) {
  const view = jsonOr(row.view, {});
  return view && typeof view === 'object' ? view : {};
}

/** `pending_goal` carries the short local-update note; it is never a goal pointer. */
function pendingOf(row) {
  const pending = jsonOr(row.pending_goal, null);
  return pending && typeof pending === 'object' ? pending : null;
}

function writeRow(db, { scopeKey: scope, focusGoalId, focusKind, pending, revision, at, view }) {
  const pendingJson = JSON.stringify(pending ?? null);
  const viewJson = JSON.stringify(view ?? {});
  if (db.get('SELECT scope FROM working_memory WHERE scope = ?', scope)) {
    db.run(`UPDATE working_memory SET focus_goal_id = ?, focus_kind = ?, pending_goal = ?, revision = ?, updated_at = ?, view = ?
            WHERE scope = ?`, focusGoalId, focusKind, pendingJson, revision, at, viewJson, scope);
  } else {
    db.run(`INSERT INTO working_memory (scope, focus_goal_id, focus_kind, pending_goal, revision, updated_at, view)
            VALUES (?, ?, ?, ?, ?, ?, ?)`, scope, focusGoalId, focusKind, pendingJson, revision, at, viewJson);
  }
}

function readSliceState(db, scope) {
  const projection = db.projection(scope);
  const slice = projection.payload?.[SLICE];
  return { projection, slice: slice && typeof slice === 'object' ? slice : {} };
}

function openCommitmentCount(db, scope) {
  return Number(db.get("SELECT COUNT(*) AS n FROM commitments WHERE scope = ? AND status = 'open'", scope)?.n ?? 0);
}

function syncSlice(db, scope, { at, action, focusGoalId, revision, checkpointId }) {
  const { projection, slice } = readSliceState(db, scope);
  const next = {
    ...slice,
    focusGoalId: focusGoalId ?? '',
    revision: Number(revision ?? slice.revision ?? 0),
    openCommitments: openCommitmentCount(db, scope),
    updatedAt: at,
    lastEventAt: at,
    lastAction: action,
    lastCheckpointId: checkpointId || slice.lastCheckpointId || '',
  };
  db.commitProjection({ scope, expectedVersion: projection.version, payload: { ...projection.payload, [SLICE]: next }, updatedAt: at });
  return next;
}

/**
 * Content-addressed checkpoint id (B4/A08). The material is stable across runs:
 * scope key, goal id, the goal revision that was snapshotted, the checkpoint instant
 * (event time whenever the checkpoint comes from the event path) and the reason code.
 * The ordinal inside the scope keeps two legitimate checkpoints apart when they share
 * one millisecond; it is itself replay-stable because rows are inserted in log order.
 * Nothing random and no wall clock enters the id.
 */
function checkpointIdFor({ scope, goalId, revision, at, reason, ordinal }) {
  const material = [
    scope,
    goalId,
    Math.trunc(Number(revision) || 0),
    Math.trunc(Number(at) || 0),
    reason,
    Math.trunc(Number(ordinal) || 0),
  ].join('\u0001');
  return `wmc_${crypto.createHash('sha256').update(material).digest('hex').slice(0, 32)}`;
}

/**
 * Snapshot the goal before the focus moves. Both the id and the payload are free of
 * random and wall-clock values, so replaying the same event log writes byte-identical
 * rows (`verifyRecovery` must not report a projection mismatch on a clean log).
 */
function commitCheckpoint(db, { scopeKey: scope, goal, reason, at }) {
  const reasonCode = code(reason, 60);
  const ordinal = Number(db.get('SELECT COUNT(*) AS n FROM wm_checkpoints WHERE scope = ?', scope)?.n ?? 0) + 1;
  const id = checkpointIdFor({ scope, goalId: goal.goalId, revision: goal.revision, at, reason: reasonCode, ordinal });
  if (db.get('SELECT checkpoint_id FROM wm_checkpoints WHERE checkpoint_id = ?', id)) return id;
  const payload = {
    goalId: goal.goalId,
    title: goal.title,
    status: goal.status,
    overdue: Boolean(goal.overdue),
    revision: goal.revision,
    nextStep: goal.nextStep,
    waitingOn: goal.waitingOn,
    doneSteps: [...(goal.completedSteps ?? [])],
  };
  db.run(`INSERT INTO wm_checkpoints (checkpoint_id, scope, goal_id, revision, reason, created_at, payload)
          VALUES (?, ?, ?, ?, ?, ?, ?)`, id, scope, goal.goalId, goal.revision, reasonCode, at, JSON.stringify(payload));
  // Derived convenience copy; it does not move the goal revision.
  db.run('UPDATE goals SET checkpoint = ? WHERE scope = ? AND goal_id = ?', JSON.stringify(payload), scope, goal.goalId);
  return id;
}

function checkpointOfGoal(db, scope, goal, reason, at) {
  if (!goal || TERMINAL.has(goal.status)) return '';
  return commitCheckpoint(db, { scopeKey: scope, goal, reason, at });
}

// ------------------------------------------------------------------ public API

/** Point the focus at a goal (or clear it with an empty goalId). No checkpoint. */
export function focusGoal(db, options = {}) {
  const scope = resolveKey(options);
  const at = atOf(options.now, db);
  return db.tx(() => {
    const row = readRow(db, scope);
    const goalId = goalIdArgument(options.goalId);
    if (goalId) {
      const goal = getGoal(db, scope, goalId);
      if (!goal) throw new RuntimeError('unknown-goal', `goal ${goalId} is not in this scope`);
      if (TERMINAL.has(goal.status)) return { ok: false, code: 'terminal-goal', goalId, status: goal.status };
    }
    if (row.focus_goal_id === goalId) return { ok: true, kept: true, focusGoalId: goalId, revision: Number(row.revision) };
    assertRevision(revisionOf(options.expectedRevision), Number(row.revision));
    const revision = Number(row.revision) + 1;
    const view = readView(row);
    writeRow(db, {
      scopeKey: scope,
      focusGoalId: goalId,
      focusKind: goalId ? 'goal' : '',
      pending: null,
      revision,
      at,
      view: { ...view, pending: null, lastFocusAt: at },
    });
    syncSlice(db, scope, { at, action: goalId ? 'focus' : 'clear', focusGoalId: goalId, revision });
    return { ok: true, kept: false, focusGoalId: goalId, revision };
  });
}

/** Snapshot a goal into wm_checkpoints without moving the focus. */
export function checkpointGoal(db, options = {}) {
  const scope = resolveKey(options);
  const at = atOf(options.now, db);
  const goalId = text(options.goalId, 'goalId', 120);
  return db.tx(() => {
    const goal = getGoal(db, scope, goalId);
    if (!goal) throw new RuntimeError('unknown-goal', `goal ${goalId} is not in this scope`);
    const row = readRow(db, scope);
    assertRevision(revisionOf(options.expectedRevision, 'event'), Number(row.revision));
    const checkpointId = commitCheckpoint(db, { scopeKey: scope, goal, reason: options.reason ?? 'manual', at });
    const revision = Number(row.revision) + 1;
    const view = readView(row);
    writeRow(db, {
      scopeKey: scope,
      focusGoalId: row.focus_goal_id || '',
      focusKind: row.focus_kind || '',
      pending: pendingOf(row),
      revision,
      at,
      view: { ...view, lastCheckpointId: checkpointId, lastCheckpointAt: at },
    });
    syncSlice(db, scope, { at, action: 'checkpoint', focusGoalId: row.focus_goal_id || '', revision, checkpointId });
    return { ok: true, checkpointId, goalId, revision, goalRevision: goal.revision };
  });
}

/** Switch focus: checkpoint the previous goal first, then move. */
export function switchGoal(db, options = {}) {
  const scope = resolveKey(options);
  const at = atOf(options.now, db);
  const goalId = text(options.goalId, 'goalId', 120);
  return db.tx(() => {
    const row = readRow(db, scope);
    const goal = getGoal(db, scope, goalId);
    if (!goal) throw new RuntimeError('unknown-goal', `goal ${goalId} is not in this scope`);
    if (TERMINAL.has(goal.status)) return { ok: false, code: 'terminal-goal', goalId, status: goal.status };
    if (row.focus_goal_id === goalId) return { ok: true, kept: true, focusGoalId: goalId, revision: Number(row.revision) };
    assertRevision(revisionOf(options.expectedRevision), Number(row.revision));
    const previous = row.focus_goal_id ? getGoal(db, scope, row.focus_goal_id) : null;
    const checkpointId = checkpointOfGoal(db, scope, previous, 'switch', at);
    const revision = Number(row.revision) + 1;
    const view = readView(row);
    writeRow(db, {
      scopeKey: scope,
      focusGoalId: goalId,
      focusKind: 'goal',
      pending: null,
      revision,
      at,
      view: { ...view, pending: null, lastSwitchAt: at, lastCheckpointId: checkpointId || view.lastCheckpointId || '' },
    });
    syncSlice(db, scope, { at, action: 'switch', focusGoalId: goalId, revision, checkpointId });
    return { ok: true, kept: false, focusGoalId: goalId, revision, checkpointId, previousGoalId: row.focus_goal_id || '' };
  });
}

/**
 * Return to work. With several candidate goals and no goalId the caller must
 * disambiguate: { ok:false, code:'ambiguous-resume', candidates:[...] } — never a guess.
 */
export function resumeGoal(db, options = {}) {
  const scope = resolveKey(options);
  const at = atOf(options.now, db);
  return db.tx(() => {
    const row = readRow(db, scope);
    let goalId = goalIdArgument(options.goalId);
    if (!goalId) {
      const candidates = listGoals(db, { scopeKey: scope }).filter(goal => RESUME.has(goal.status));
      if (candidates.length === 0) return { ok: false, code: 'no-candidate', candidates: [] };
      if (candidates.length > 1) {
        return {
          ok: false,
          code: 'ambiguous-resume',
          candidates: candidates.map(goal => ({
            goalId: goal.goalId,
            title: goal.title,
            status: goal.status,
            overdue: goal.overdue,
            updatedAt: goal.updatedAt,
          })),
        };
      }
      goalId = candidates[0].goalId;
    }
    const goal = getGoal(db, scope, goalId);
    if (!goal) return { ok: false, code: 'unknown-goal', goalId };
    if (TERMINAL.has(goal.status)) return { ok: false, code: 'terminal-goal', goalId, status: goal.status };
    if (row.focus_goal_id === goalId) {
      return { ok: true, kept: true, focusGoalId: goalId, revision: Number(row.revision), resumed: true };
    }
    assertRevision(revisionOf(options.expectedRevision), Number(row.revision));
    const previous = row.focus_goal_id ? getGoal(db, scope, row.focus_goal_id) : null;
    const checkpointId = checkpointOfGoal(db, scope, previous, 'resume', at);
    const revision = Number(row.revision) + 1;
    const view = readView(row);
    writeRow(db, {
      scopeKey: scope,
      focusGoalId: goalId,
      focusKind: 'goal',
      pending: null,
      revision,
      at,
      view: { ...view, pending: null, lastResumeAt: at, lastCheckpointId: checkpointId || view.lastCheckpointId || '' },
    });
    syncSlice(db, scope, { at, action: 'resume', focusGoalId: goalId, revision, checkpointId });
    return { ok: true, kept: false, focusGoalId: goalId, revision, checkpointId, previousGoalId: row.focus_goal_id || '', resumed: true };
  });
}

/** The stored focus for one scope. A focus on a closed/missing goal reads as empty. */
export function currentFocus(db, scopeKeyValue) {
  const scope = keyArgument(scopeKeyValue);
  const row = readRow(db, scope);
  const view = readView(row);
  const goal = row.focus_goal_id ? getGoal(db, scope, row.focus_goal_id) : null;
  const active = goal && !TERMINAL.has(goal.status) ? goal : null;
  return {
    scopeKey: scope,
    focusGoalId: active ? goal.goalId : '',
    storedFocusGoalId: row.focus_goal_id || '',
    focusKind: active ? (row.focus_kind || 'goal') : '',
    revision: Number(row.revision),
    updatedAt: Number(row.updated_at),
    pending: pendingOf(row),
    lastCheckpointId: typeof view.lastCheckpointId === 'string' ? view.lastCheckpointId : '',
  };
}

function lastActivityAt(db, scope, rowUpdatedAt) {
  const event = db.get('SELECT MAX(recorded_at) AS t FROM domain_events WHERE scope = ?', scope);
  const goal = db.get('SELECT MAX(updated_at) AS t FROM goals WHERE scope = ?', scope);
  const commitment = db.get('SELECT MAX(updated_at) AS t FROM commitments WHERE scope = ?', scope);
  return Math.max(Number(event?.t ?? 0), Number(goal?.t ?? 0), Number(commitment?.t ?? 0), Number(rowUpdatedAt ?? 0));
}

/**
 * The bounded view for injection. `revision` is the focus revision callers pass back
 * as expectedRevision; `overdue` is read-time (persisted flag OR a passed deadline).
 */
export function workingMemoryState(db, { scopeKey, scope, now } = {}) {
  const key = resolveKey({ scope, scopeKey });
  const at = atOf(now, db);
  const focus = currentFocus(db, key);
  const goal = focus.focusGoalId ? getGoal(db, key, focus.focusGoalId) : null;
  const commitments = listCommitments(db, { scopeKey: key, status: 'open' })
    .map(commitment => ({ text: commitment.text, dueAt: commitment.dueAt, status: commitment.status }));
  const overdue = goal ? Boolean(goal.overdue) || (goal.deadlineAt !== null && goal.deadlineAt <= at) : false;
  return {
    focusGoalId: focus.focusGoalId,
    goal: goal ? {
      goalId: goal.goalId,
      title: goal.title,
      status: goal.status,
      overdue,
      nextStep: goal.nextStep,
      waitingOn: goal.waitingOn,
      doneSteps: [...goal.completedSteps],
    } : null,
    commitments,
    lastEventAt: lastActivityAt(db, key, focus.updatedAt),
    revision: focus.revision,
  };
}

// --------------------------------------------------------------- render (A04)

function truncate(value, max) {
  const limit = Math.trunc(max);
  if (limit <= 0) return '';
  if (value.length <= limit) return value;
  if (limit === 1) return '…';
  return value.slice(0, limit - 1) + '…';
}

/** Fixed offset so the rendered day never depends on the host time zone. */
function formatDay(epoch) {
  return new Date(Number(epoch) + SHANGHAI_OFFSET_MS).toISOString().slice(5, 10);
}

function formatCommitment(commitment) {
  return commitment.dueAt === null ? commitment.text : `${commitment.text}（截止${formatDay(commitment.dueAt)}）`;
}

const ENTRY_SEP = '；';

function overflowMarker(omitted) {
  return `（另有${omitted}条承诺）`;
}

/**
 * Fill the room left after the commitment block with 目标 → 下一步 → 等待 → 已完成步骤.
 * Trimming order (CONTRACT §4: only the completed-step list may be truncated):
 * shorten the step list, drop it, drop the waiting line, shorten the next step, then
 * shorten the goal line. Every candidate is measured before it is accepted, so the
 * result is never longer than `room`.
 */
function fitTail({ room, goal, goalLine, nextLine, waitingLine, stepsText, stepsLine }) {
  if (room <= 0) return '';
  const join = parts => parts.filter(Boolean).join('\n');
  const full = join([goalLine, nextLine, waitingLine, stepsLine]);
  if (full.length <= room) return full;
  // 1) keep 已完成步骤 but cut its tail (the one section the contract lets truncate).
  const head = join([goalLine, nextLine, waitingLine]);
  if (stepsLine) {
    const stepsRoom = room - (head ? head.length + 1 : 0) - LABEL.steps.length;
    if (stepsRoom > 1) {
      const candidate = join([head, LABEL.steps + truncate(stepsText, stepsRoom)]);
      if (candidate.length <= room) return candidate;
    }
  }
  // 2) drop the completed-steps section.
  if (head.length <= room) return head;
  // 3) drop the waiting condition and shorten the next step.
  if (goalLine && nextLine) {
    const nextRoom = room - goalLine.length - 1 - LABEL.next.length;
    if (nextRoom > 1) {
      const candidate = join([goalLine, LABEL.next + truncate(goal.nextStep, nextRoom)]);
      if (candidate.length <= room) return candidate;
    }
  }
  // 4) shorten the goal line itself.
  if (goalLine) {
    const goalRoom = room - LABEL.goal.length;
    if (goalRoom > 1) {
      const body = `${goal.title}（${STATUS_LABEL[goal.status] ?? goal.status}${goal.overdue ? '·超期' : ''}）`;
      const candidate = LABEL.goal + truncate(body, goalRoom);
      if (candidate.length <= room) return candidate;
    }
  }
  return '';
}

/**
 * Render the working memory for injection and report how it was produced.
 *
 * Policy (B5, CONTRACT §4/§6):
 *  - the text is hard-capped at `budgetChars` for every budget ≥ 0;
 *  - commitments come first and always as whole entries — an entry is never cut
 *    mid-sentence; when not all of them fit, whole trailing entries are dropped and an
 *    explicit `（另有N条承诺）` marker accounts for the rest (the marker must fit too);
 *  - if not even the marker fits, nothing is rendered;
 *  - a budget below `MIN_BUDGET` (40) renders nothing: `state: 'budget-too-small'`;
 *  - the remaining room is filled in the fixed order 目标 → 下一步 → 等待 → 已完成步骤.
 *
 * `state` is one of `budget-too-small`, `commitments-do-not-fit`, `empty`, `full`,
 * `commitments-omitted`, `trimmed`. The returned text never carries a random or
 * wall-clock value, so the same rows render the same string on every run.
 */
export function renderWorkingMemoryDetailed(db, { scopeKey, scope, budgetChars = DEFAULT_BUDGET, now } = {}) {
  const key = resolveKey({ scope, scopeKey });
  const requested = Number(budgetChars);
  const budget = Number.isFinite(requested) ? Math.max(0, Math.trunc(requested)) : DEFAULT_BUDGET;
  const nothing = state => ({ text: '', state, budget, chars: 0, shownCommitments: 0, omittedCommitments: 0, shownBeliefs: 0, omittedBeliefs: 0 });
  if (budget < MIN_BUDGET) return nothing('budget-too-small');

  const state = workingMemoryState(db, { scopeKey: key, now });
  const goal = state.goal;
  // `workingMemoryState.commitments` is already the open commitments in render order.
  const entries = state.commitments.map(formatCommitment);

  // 1) Commitments: whole entries only, overflow accounted for by an explicit marker.
  let commitmentBlock = '';
  let shown = 0;
  if (entries.length) {
    const all = LABEL.commitments + entries.join(ENTRY_SEP);
    if (all.length <= budget) {
      shown = entries.length;
      commitmentBlock = all;
    } else {
      for (let keep = entries.length - 1; keep >= 0; keep -= 1) {
        const marker = overflowMarker(entries.length - keep);
        const head = LABEL.commitments + (keep ? entries.slice(0, keep).join(ENTRY_SEP) : '');
        if (head.length + marker.length <= budget) {
          shown = keep;
          commitmentBlock = head + marker;
          break;
        }
      }
      if (!commitmentBlock) return nothing('commitments-do-not-fit');
    }
  }
  const omitted = entries.length - shown;

  // 2) Remaining room for the goal view, in the frozen order.
  const goalLine = goal
    ? `${LABEL.goal}${goal.title}（${STATUS_LABEL[goal.status] ?? goal.status}${goal.overdue ? '·超期' : ''}）`
    : '';
  const nextLine = goal && goal.nextStep ? LABEL.next + goal.nextStep : '';
  const waitingLine = goal && goal.waitingOn ? LABEL.waiting + goal.waitingOn : '';
  const stepsText = goal && goal.doneSteps.length ? goal.doneSteps.join('、') : '';
  const stepsLine = stepsText ? LABEL.steps + stepsText : '';
  const room = budget - (commitmentBlock ? commitmentBlock.length + 1 : 0);
  const fullTail = [goalLine, nextLine, waitingLine, stepsLine].filter(Boolean).join('\n');
  const tail = fitTail({ room, goal, goalLine, nextLine, waitingLine, stepsText, stepsLine });
  let assembled = [commitmentBlock, tail].filter(Boolean).join('\n');
  // 3) Current beliefs last: whole lines only, never cutting a judgment mid-sentence.
  //    `currentBeliefs` already excludes superseded/refuted and expired rows.
  const beliefRows = currentBeliefs(db, { scopeKey: key, now }).filter(belief => belief.status === 'supported');
  const beliefLines = beliefRows.map(belief => LABEL.belief + belief.proposition + (belief.roots?.length ? `（依据${belief.roots[0]}）` : ''));
  let shownBeliefs = 0;
  for (const line of beliefLines) {
    const candidate = assembled ? assembled + '\n' + line : line;
    if (candidate.length > budget) break;
    assembled = candidate;
    shownBeliefs += 1;
  }
  const omittedBeliefs = beliefLines.length - shownBeliefs;
  // Defence in depth: every candidate above is measured, but the cap is a hard promise.
  const text = assembled.length <= budget ? assembled : (commitmentBlock.length <= budget ? commitmentBlock : '');
  if (!text) return { ...nothing('empty'), shownCommitments: shown, omittedCommitments: omitted, shownBeliefs, omittedBeliefs };
  const stateName = omitted > 0 ? 'commitments-omitted' : (tail === fullTail && omittedBeliefs === 0 ? 'full' : 'trimmed');
  return { text, state: stateName, budget, chars: text.length, shownCommitments: shown, omittedCommitments: omitted, shownBeliefs, omittedBeliefs };
}

/**
 * Render the working memory for injection. Output is ≤ `budgetChars` characters and
 * keeps the fixed order 承诺 → 目标+下一步 → 等待 → 已完成步骤 (see the detailed variant
 * for the exact trimming policy). `timeZone` is accepted for call-site compatibility;
 * day labels use a fixed Asia/Shanghai offset so output never depends on the host.
 */
export function renderWorkingMemory(db, { scopeKey, scope, budgetChars = DEFAULT_BUDGET, now, timeZone } = {}) {
  void timeZone;
  return renderWorkingMemoryDetailed(db, { scopeKey, scope, budgetChars, now }).text;
}

// -------------------------------------------------------------- consumer reducer

function localUpdate(db, { row, view, pending, at }) {
  const revision = Number(row.revision) + 1;
  const nextPending = pending === undefined ? pendingOf(row) : pending;
  writeRow(db, {
    scopeKey: row.scope,
    focusGoalId: row.focus_goal_id || '',
    focusKind: row.focus_kind || '',
    pending: nextPending,
    revision,
    at,
    view,
  });
  return {
    focusGoalId: row.focus_goal_id || '',
    revision,
    result: { action: nextPending ? 'partial-update' : 'touch', focusGoalId: row.focus_goal_id || '' },
  };
}

function applyWorkingMemoryKind(db, { event, kind, payload, scopeKey: scope, at }) {
  const row = readRow(db, scope);
  const view = readView(row);
  // Replay guard: a re-delivered event never re-applies (receipts normally catch it).
  if (view.lastEventId === event.eventId) {
    return { focusGoalId: row.focus_goal_id || '', revision: Number(row.revision), result: { action: 'replay', focusGoalId: row.focus_goal_id || '' } };
  }
  view.lastEventId = event.eventId;
  view.lastEventAt = at;
  const goalId = typeof payload.goalId === 'string' ? payload.goalId.trim() : '';

  const moveFocus = (targetId, reason) => {
    if (!targetId) return localUpdate(db, { row, view, at });
    const goal = getGoal(db, scope, targetId);
    if (!goal) throw new ValidationError('focus target does not exist in this scope');
    if ((kind === 'topic/switch' || kind === 'topic/resume') && payload.expectedRevision !== null && payload.expectedRevision !== undefined && Number.isFinite(Number(payload.expectedRevision)) && Number(payload.expectedRevision) !== Number(goal.revision)) {
      throw new StaleRevisionError('focus target', Number(payload.expectedRevision), goal.revision);
    }
    if (row.focus_goal_id === targetId) {
      return { focusGoalId: targetId, revision: Number(row.revision), result: { action: 'kept', focusGoalId: targetId } };
    }
    if (TERMINAL.has(goal.status)) return localUpdate(db, { row, view, pending: { kind: 'terminal-goal', goalId: targetId, at }, at });
    const previous = row.focus_goal_id ? getGoal(db, scope, row.focus_goal_id) : null;
    const checkpointId = checkpointOfGoal(db, scope, previous, reason, at);
    const revision = Number(row.revision) + 1;
    writeRow(db, {
      scopeKey: scope,
      focusGoalId: targetId,
      focusKind: 'goal',
      pending: null,
      revision,
      at,
      view: { ...view, pending: null, lastCheckpointId: checkpointId || view.lastCheckpointId || '' },
    });
    return { focusGoalId: targetId, revision, checkpointId, result: { action: reason, focusGoalId: targetId } };
  };

  const clearFocus = reason => {
    if (!row.focus_goal_id) return localUpdate(db, { row, view, at });
    const goal = getGoal(db, scope, row.focus_goal_id);
    // Keep the final snapshot of a finished goal; the completion itself skips it.
    const checkpointId = goal ? commitCheckpoint(db, { scopeKey: scope, goal, reason, at }) : '';
    const revision = Number(row.revision) + 1;
    writeRow(db, {
      scopeKey: scope,
      focusGoalId: '',
      focusKind: '',
      pending: null,
      revision,
      at,
      view: { ...view, pending: null, lastCheckpointId: checkpointId || view.lastCheckpointId || '' },
    });
    return { focusGoalId: '', revision, checkpointId, result: { action: 'cleared', focusGoalId: '' } };
  };

  switch (kind) {
    case 'topic/interjection':
      // Partial update only: the focus never moves on an interjection.
      return localUpdate(db, {
        row,
        view,
        pending: { kind: 'interjection', note: code(payload.note ?? payload.text ?? '', NOTE_LIMIT), at },
        at,
      });
    case 'topic/switch':
      if (!goalId) throw new ValidationError('topic/switch requires payload.goalId');
      return moveFocus(goalId, 'switch');
    case 'topic/resume': {
      if (goalId) return moveFocus(goalId, 'resume');
      const candidates = listGoals(db, { scopeKey: scope }).filter(goal => RESUME.has(goal.status));
      if (candidates.length === 1) return moveFocus(candidates[0].goalId, 'resume');
      if (candidates.length > 1) {
        return localUpdate(db, {
          row,
          view,
          pending: { kind: 'ambiguous-resume', candidates: candidates.map(candidate => candidate.goalId), at },
          at,
        });
      }
      return localUpdate(db, { row, view, pending: { kind: 'no-candidate', at }, at });
    }
    case 'goal/accepted':
    case 'goal/started':
    case 'goal/resumed':
      if (!goalId) throw new ValidationError(`${kind} requires payload.goalId`);
      return moveFocus(goalId, kind);
    case 'goal/paused':
      // Focus stays where it is; only the note records the pause.
      return localUpdate(db, { row, view, pending: { kind: 'paused', goalId, at }, at });
    case 'goal/completed':
    case 'goal/cancelled':
      if (goalId && row.focus_goal_id && goalId !== row.focus_goal_id) {
        return localUpdate(db, { row, view, pending: { kind: 'other-goal-closed', goalId, at }, at });
      }
      if (!row.focus_goal_id) return localUpdate(db, { row, view, at });
      return clearFocus(kind);
    case 'commitment/made':
    case 'commitment/closed':
    case 'goal/proposed':
    case 'goal/step':
    case 'goal/updated':
      return localUpdate(db, { row, view, at });
    default:
      throw new ValidationError(`working-memory consumer does not handle ${kind}`);
  }
}

/**
 * Reducer for the `working-memory` consumer. Mirrors the focus into `working_memory`
 * and `wm_checkpoints` inside the caller's transaction (`extra`), so a reader after a
 * restart recovers from rows — never from a summary.
 */
export function applyWorkingMemoryEvent({ db, event, slice, now } = {}) {
  const kind = typeof event?.kind === 'string' ? event.kind : '';
  if (!CONSUMERS['working-memory'].includes(kind)) return {};
  const scope = event.scopeKey ?? resolveKey({ scope: event.scope });
  const at = atOf(now, db);
  const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
  const previous = slice && typeof slice === 'object' ? slice : {};
  const next = { ...previous };
  const result = {};
  const extra = (database) => {
    const outcome = applyWorkingMemoryKind(database, { event, kind, payload, scopeKey: scope, at });
    Object.assign(next, {
      focusGoalId: outcome.focusGoalId ?? '',
      revision: outcome.revision ?? Number(previous.revision ?? 0),
      openCommitments: openCommitmentCount(database, scope),
      updatedAt: at,
      lastEventAt: at,
      lastEventId: event.eventId,
      lastAction: kind,
      lastCheckpointId: outcome.checkpointId || previous.lastCheckpointId || '',
    });
    Object.assign(result, outcome.result);
  };
  return { slice: next, result, extra };
}
