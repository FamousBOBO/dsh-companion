/** Evidence gathering for the wardrobe resolver: what is *actually happening* right now.
 *
 * The resolver must never treat a plan as an occurrence (brief §5.2, §10). This module is
 * the only place that reads the runtime for wardrobe purposes, and it is deliberately
 * narrow:
 *
 *   - it reads the **P2 plan** and asks for the slot whose window contains `now`, plus the
 *     **running/paused P2 activity** (a real row with a real status, not a plan);
 *   - it reads the **H1 agenda** and asks for an occurrence whose window contains `now`
 *     and whose status is not terminal;
 *   - a plan slot that is merely `planned` for later today is *never* returned as evidence
 *     of what she is doing now. It comes back in `plan` only so a report can say "there is
 *     a plan, and it has not happened yet";
 *   - every runtime call is wrapped: a missing runtime, a disabled switch, an unbound
 *     scope or a thrown error all degrade to `null` evidence plus a reason code. The
 *     wardrobe must never fail a chat turn because the runtime is off.
 *
 * `reminderDelivery` is reported as `not-wired` on purpose — nothing here delivers, and
 * nothing here may claim it does.
 */
import { activeEntry } from './wardrobe-context.mjs';

const MAX_TEXT = 160;

function shortText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
}

function callSafely(fn, input) {
  if (typeof fn !== 'function') return { ok: false, code: 'not-mounted' };
  try {
    const value = fn(input);
    if (value && typeof value.then === 'function') return { ok: false, code: 'async-unexpected' };
    return { ok: true, value };
  } catch (error) {
    return { ok: false, code: String(error?.code ?? 'call-failed').slice(0, 60) };
  }
}

/**
 * Read the runtime once and describe the current life state.
 *
 * @param {object} input
 * @param {object|null} input.runtime   the cognitive runtime (may be null / inert)
 * @param {object} [input.bound]        identity binding for the scope
 * @param {string} [input.sessionId]    session used to resolve the scope
 * @param {number} [input.now]
 * @returns {{
 *   activity: object|null, schedule: object|null, plan: object|null,
 *   reasons: string[], state: 'ok'|'inactive'|'unbound'|'error', notes: string[]
 * }}
 */
export function collectLifeEvidence({ runtime = null, bound = null, sessionId = '', now = Date.now() } = {}) {
  const out = { activity: null, schedule: null, plan: null, reasons: [], state: 'inactive', notes: [] };
  if (!runtime || typeof runtime !== 'object') {
    out.notes.push('runtime-not-mounted');
    return out;
  }
  const scopeInput = { ...(bound ? { bound } : {}), ...(sessionId ? { sessionId } : {}) };

  // ── P2 activity: a real row, not a plan slot ────────────────────────────────
  const activities = callSafely(runtime.listActivities, scopeInput);
  if (activities.ok) {
    const rows = Array.isArray(activities.value?.activities) ? activities.value.activities : [];
    const running = rows.find(row => row.status === 'running' || row.status === 'paused');
    if (running) {
      // `startedAt` with no `endAt` is an open interval: an activity that is running now is
      // happening now, which is exactly the evidence the resolver wants.
      out.activity = {
        kind: shortText(running.kind),
        adapter: shortText(running.adapter),
        activity: shortText(running.kind),
        status: shortText(running.status),
        title: shortText(running.target),
        detail: shortText(running.target),
        startAt: Number(running.startedAt) || 0,
        endAt: Math.max(now + 1, Number(running.updatedAt) || 0),
        source: 'p2-activity',
      };
      out.reasons.push('p2-activity-running');
    } else {
      out.reasons.push('p2-activity-none');
    }
  } else if (activities.code !== 'not-mounted') {
    out.reasons.push(`p2-activity-${activities.code}`);
  }

  // ── P2 plan: only the slot that contains *now* counts as happening ──────────
  const plan = callSafely(runtime.listPlan, scopeInput);
  if (plan.ok) {
    const slots = Array.isArray(plan.value?.slots) ? plan.value.slots : [];
    const happening = slots.find(slot => activeEntry(slot, now));
    if (happening) {
      out.plan = {
        slotId: shortText(happening.slotId),
        title: shortText(happening.title),
        detail: shortText(happening.title),
        kind: shortText(happening.kind),
        activity: shortText(happening.activity),
        status: shortText(happening.status),
        startAt: Number(happening.startAt) || 0,
        endAt: Number(happening.endAt) || 0,
        source: 'p2-plan',
      };
      out.reasons.push('p2-slot-current');
    } else {
      const upcoming = slots.filter(slot => Number(slot.startAt) > now);
      out.reasons.push(upcoming.length ? 'p2-slot-planned-not-happening' : 'p2-slot-none');
    }
  } else if (plan.code !== 'not-mounted') {
    out.reasons.push(`p2-plan-${plan.code}`);
  }

  // ── H1 agenda: an occurrence whose window contains now, not terminal ────────
  //
  // `todaySchedule` is the runtime's agenda **read** API (`companion_schedule_today` uses the
  // same one). Two honest notes about it:
  //
  //   1. When the runtime is the active writer it first *materialises* not-yet-generated
  //      occurrences for this scope (`materializeAgendaScope`, bounded by
  //      `config.agenda.maxGeneratePerCall` and idempotent per slot key). That is a write
  //      from a read path, and it is the runtime's own long-standing behaviour — without it
  //      a freshly created schedule would have no occurrences at all and every reader would
  //      see "nothing scheduled". It does **not** dispatch, send, or mark anything done;
  //      the wardrobe still only *reads* `status`.
  //   2. It returns occurrences for "today" in each schedule's own zone, which is exactly the
  //      window this resolver cares about.
  const today = callSafely(runtime.todaySchedule, scopeInput);
  if (today.ok && today.value?.ok !== false && today.value?.enabled !== false) {
    const rows = Array.isArray(today.value?.occurrences) ? today.value.occurrences : [];
    const live = rows
      .map(row => ({
        ...row,
        startAt: Number(row.scheduledAt) || 0,
        // A schedule may have no explicit end; give it a bounded, honest default window
        // (the slot model has no duration, so an occurrence is "now" for an hour at most).
        endAt: Number(row.slotEndAt) || (Number(row.scheduledAt) || 0) + 3600_000,
      }))
      .find(row => activeEntry(row, now));
    if (live) {
      const group = (today.value.items ?? []).find(item => item.itemId === live.itemId);
      out.schedule = {
        itemId: shortText(live.itemId),
        title: shortText(group?.title ?? ''),
        detail: shortText(group?.title ?? ''),
        kind: shortText(group?.category ?? 'plan'),
        status: shortText(live.status),
        startAt: live.startAt,
        endAt: live.endAt,
        source: 'h1-agenda',
      };
      out.reasons.push('agenda-occurrence-current');
    } else {
      out.reasons.push('agenda-occurrence-none');
    }
  } else {
    out.reasons.push(`agenda-${today.ok ? (today.value?.state ?? 'unavailable') : today.code}`);
  }

  // The schedule is the stronger statement when both exist ("a scheduled outing is
  // running" beats "she is reading"), so it is offered to the resolver in the `schedule`
  // slot and the plan slot is used only when the agenda has nothing happening.
  if (!out.schedule && out.plan) out.schedule = out.plan;
  out.state = out.activity || out.schedule ? 'ok' : 'inactive';
  return out;
}

/** True when the evidence carries something the resolver may use as "happening now". */
export function hasLiveEvidence(evidence) {
  return Boolean(evidence?.activity || evidence?.schedule);
}

export const reminderDelivery = 'not-wired';
