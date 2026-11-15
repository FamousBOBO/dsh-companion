/** Life facts: the bounded, read-only truth about "what is actually happening right now".
 *
 * The old `autonomy.mjs` `lifeSection()` mixes three different statements into one view and lets
 * a model narrate them as one:
 *
 *   1. what a real activity row says is *running* (execution fact);
 *   2. what a plan slot says *should* be happening (a plan, nothing more);
 *   3. what the plan says is *over* (`endAt <= now || status === 'done'` → "今天已结束 N 段").
 *
 * (3) is the bug the plan calls out (§2.3 疑点 4 / §5 E-5): an elapsed window is not evidence
 * that anything happened. This module never makes that inference. A record is `completed` only
 * when its activity row carries execution evidence (consumed text or a versioned artifact); an
 * elapsed window is `window-ended`, and it gets its own wording.
 *
 * Design constraints, all deliberate:
 *
 *   - **Read-only.** Four existing runtime entries are called: `p2Status`, `listActivities`,
 *     `listPlan`, `todaySchedule`. Nothing here writes a file, sends a message or calls a model,
 *     and nothing here can create a plan or start an activity.
 *   - **Never throws.** Every runtime call is wrapped; a thrown call, a missing entry, an
 *     unexpected Promise or a non-object answer all degrade to a named failure plus the
 *     `read-failed` state. A chat turn must not die because the runtime is off.
 *   - **Never falls back to a default world.** When the scope cannot be resolved the answer is
 *     `unknown` + `scope-unresolved`, never `world:default`'s silence presented as "she is idle".
 *   - **Bounded.** Record counts and rendered characters are capped; the caps are contract
 *     values, not accidents of the data.
 *   - **Honest conflict.** When two sources disagree, both are reported (`facts.conflicts[]`)
 *     instead of one being chosen for the reader.
 *
 * Vocabulary: the eight top-level states are
 * `disabled / idle / scheduled / running / paused / completed / unknown / read-failed`.
 * Records additionally carry the *contract-native* status verbatim (`p2_activities.status`,
 * `p2_plan_slots.status`, `agenda_occurrences.status`) plus one extra record-level word,
 * `window-ended`, whose only job is "the time passed, nothing was proven".
 */

/** IANA zone used when the caller does not pass one. */
export const DEFAULT_TIME_ZONE = 'Asia/Shanghai';
/** Snapshot TTL: inside it no runtime read at all happens (the plan's "bounded pre-step snapshot"). */
export const DEFAULT_CACHE_TTL_MS = 60_000;
/** Hard bounds. They are part of the interface, not tuning knobs. */
export const LIMITS = Object.freeze({
  maxActivities: 20,
  maxPlanSlots: 24,
  maxScheduleRows: 24,
  maxRecords: 48,
  maxTitleChars: 60,
  maxRenderLines: 12,
  maxRenderChars: 900,
  maxConflicts: 8,
  maxReasons: 16,
  maxFailures: 8,
});

/** The only top-level states this module may report. */
export const LIFE_STATES = Object.freeze(['disabled', 'idle', 'scheduled', 'running', 'paused', 'completed', 'unknown', 'read-failed']);
/** Record-level states; `window-ended` is additive on purpose (no contract status means "time passed"). */
export const RECORD_STATES = Object.freeze(['running', 'paused', 'scheduled', 'completed', 'window-ended', 'unknown', 'disabled']);
/** Freshness bands: how strongly an observation may be spoken of as "now". */
export const FRESHNESS_BANDS = Object.freeze(['live', 'aging', 'stale', 'unknown']);

const AGING_FACTOR = 15;
const SOURCE_RANK = Object.freeze({ 'p2-activity': 1, 'p2-plan': 2, 'h1-agenda': 2, memory: 3 });
const DISABLED_CODES = Object.freeze([
  'activities-disabled', 'planning-disabled', 'agenda-disabled', 'runtime-off', 'runtime-disabled',
  'runtime-stopped', 'runtime-disposed', 'p2-not-registered',
]);
const SCOPE_CODES = Object.freeze(['unbound', 'scope-invalid', 'invalid-scope']);

// ── small helpers ──────────────────────────────────────────────────────────────

function shortText(value, max = LIMITS.maxTitleChars) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function uniq(values, limit = LIMITS.maxReasons) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const key = String(value ?? '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= limit) break;
  }
  return out;
}

function safeCall(fn, input) {
  if (typeof fn !== 'function') return { ok: false, code: 'not-mounted', value: null, message: '' };
  try {
    const value = fn(input);
    if (value && typeof value.then === 'function') return { ok: false, code: 'async-unexpected', value: null, message: '' };
    if (!value || typeof value !== 'object') return { ok: false, code: 'invalid-response', value: null, message: '' };
    return { ok: true, code: '', value, message: '' };
  } catch (error) {
    const code = shortText(error?.code, 60) || 'call-threw';
    const message = shortText(error instanceof Error ? error.message : error, 120);
    return { ok: false, code, value: null, message };
  }
}

// ── time zone: local arithmetic, no IO, an unknown name is reported ───────────

const zoneFormatters = new Map();
const ZONE_SHAPE = /^[A-Za-z][A-Za-z0-9_+\-/]*$/;

function formatterFor(zone) {
  let formatter = zoneFormatters.get(zone);
  if (formatter) return formatter;
  formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  if (zoneFormatters.size >= 64) zoneFormatters.clear();
  zoneFormatters.set(zone, formatter);
  return formatter;
}

/** True only for a zone `Intl` accepts; an unknown name must be reported, never assumed. */
export function isValidTimeZone(zone) {
  if (typeof zone !== 'string') return false;
  const value = zone.trim();
  if (!value || value.length > 64 || !ZONE_SHAPE.test(value)) return false;
  try { formatterFor(value); return true; } catch { return false; }
}

function localPartsOf(at, zone) {
  const parts = formatterFor(zone).formatToParts(new Date(Math.trunc(at)));
  const pick = type => Number(parts.find(part => part.type === type)?.value ?? 0);
  return { year: pick('year'), month: pick('month'), day: pick('day'), hour: pick('hour') % 24, minute: pick('minute') };
}

/** Local `YYYY-MM-DD` of an instant in `zone` (the zone decides the date, not the host clock). */
export function localDateOf(at, zone) {
  const parts = localPartsOf(at, zone);
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

/** Local `HH:MM` of an instant in `zone`. */
export function localClockOf(at, zone) {
  const parts = localPartsOf(at, zone);
  return `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

function offsetMinutesAt(at, zone) {
  const parts = localPartsOf(at, zone);
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0, 0);
  return Math.round((wall - Math.floor(at / 60_000) * 60_000) / 60_000);
}

/**
 * First instant of the local day that contains `at`.
 *
 * One offset probe against the wall clock read as UTC, then corrected — the local day is decided
 * by the zone, never by the host clock, so a 00:30 Asia/Shanghai observation is *that* local
 * date even while the host is still on the previous UTC day.
 */
export function startOfLocalDay(at, zone) {
  const parts = localPartsOf(at, zone);
  for (const hour of [0, 1, 2, 3]) {
    const guess = Date.UTC(parts.year, parts.month - 1, parts.day, hour, 0, 0, 0);
    const instant = guess - offsetMinutesAt(guess, zone) * 60_000;
    const check = localPartsOf(instant, zone);
    const sameDay = check.year === parts.year && check.month === parts.month && check.day === parts.day;
    if (sameDay && check.hour === hour && check.minute === 0) return instant;
  }
  return Math.trunc(at) - (Math.trunc(at) % 86_400_000);
}

// ── scope ──────────────────────────────────────────────────────────────────────

/**
 * Signature of one identity binding, in the runtime's own `u:…|p:…|w:…` shape, so a cached
 * snapshot can never be reused across a character or a world.
 */
export function scopeSignature(bound) {
  if (!bound || typeof bound !== 'object') return '';
  const userId = shortText(bound.userId ?? bound.user_id, 80);
  if (!userId) return '';
  const personaId = shortText(bound.personaId ?? bound.persona ?? bound.persona_id, 80) || 'bot';
  const worldId = shortText(bound.worldId ?? bound.world_id, 80) || 'world:default';
  return `u:${userId}|p:${personaId}|w:${worldId}`;
}

function describeScope({ scopeKey, bound, sessionId }) {
  const explicit = shortText(scopeKey, 200);
  const boundObject = bound && typeof bound === 'object' ? bound : null;
  const boundSig = scopeSignature(boundObject);
  const session = shortText(sessionId, 200);
  const via = explicit ? 'scopeKey' : boundSig ? 'bound' : session ? 'sessionId' : 'none';
  const signature = explicit || boundSig || (session ? `s:${session}` : '');
  return {
    via, signature, boundObject, boundSig, session,
    boundProvided: Boolean(boundObject), sessionIdProvided: Boolean(session), scopeKeyProvided: Boolean(explicit),
    /** Exactly what the runtime accepts: an explicit key wins, else the binding, else the session. */
    input: explicit ? { scopeKey: explicit } : boundObject ? { bound: boundObject } : session ? { sessionId: session } : {},
  };
}

// ── cache ──────────────────────────────────────────────────────────────────────

/** Process-local snapshot cache, keyed by (scope signature, zone, session-probe). */
const snapshots = new Map();

/** Test / diagnostic hook: forget every cached snapshot. */
export function resetLifeFactsCache() {
  snapshots.clear();
}

function cacheKeyOf(scope, zone) {
  return `${scope.signature}|${scope.sessionIdProvided ? `s:${scope.session}` : 'n'}|${zone}`;
}

function pruneSnapshots(limit = 32) {
  while (snapshots.size > limit) {
    const oldest = [...snapshots.entries()].sort((left, right) => left[1].at - right[1].at)[0];
    if (!oldest) break;
    snapshots.delete(oldest[0]);
  }
}

// ── records ────────────────────────────────────────────────────────────────────

/** Freshness against the snapshot TTL: live ≤ ttl, aging ≤ 15×ttl, stale beyond that. */
export function freshnessOf(observedAt, now, ttlMs = DEFAULT_CACHE_TTL_MS) {
  const at = Number(observedAt);
  if (!Number.isFinite(at) || at <= 0) return { freshness: 'unknown', freshnessAgeMs: null };
  const ttl = Number(ttlMs) > 0 ? Number(ttlMs) : DEFAULT_CACHE_TTL_MS;
  const age = Math.max(0, Math.trunc(now) - Math.trunc(at));
  if (age <= ttl) return { freshness: 'live', freshnessAgeMs: age };
  if (age <= ttl * AGING_FACTOR) return { freshness: 'aging', freshnessAgeMs: age };
  return { freshness: 'stale', freshnessAgeMs: age };
}

/** Execution evidence — the runtime's own part-1 criterion (`consumed_prefix > 0` or a versioned artifact). */
export function evidenceOf(row = {}) {
  const consumed = num(row.consumed);
  const totalUnits = num(row.totalUnits);
  const artifactRef = shortText(row.artifactRef, 120);
  const artifactVersion = num(row.artifactVersion);
  if (consumed > 0) return { kind: 'consumed', consumed, totalUnits, artifactRef, artifactVersion };
  if (artifactRef !== '' && artifactVersion > 0) return { kind: 'artifact', consumed, totalUnits, artifactRef, artifactVersion };
  return { kind: 'none', consumed, totalUnits, artifactRef, artifactVersion };
}

function receiptFor(activityId, evidence, receiptLookup) {
  if (evidence.kind === 'none') return { receiptRef: '', receiptSource: 'none' };
  if (typeof receiptLookup === 'function') {
    try {
      const found = shortText(receiptLookup(activityId), 120);
      if (found) return { receiptRef: `receipt:${found}`, receiptSource: 'receipt-row' };
    } catch { /* the lookup is optional: a failure keeps the weaker reference */ }
  }
  return { receiptRef: `activity:${activityId}`, receiptSource: 'activity-evidence' };
}

function windowOf(startAt, endAt, zone) {
  const start = num(startAt);
  const end = num(endAt);
  const valid = start > 0 && end > 0;
  return {
    startAt: start,
    endAt: end,
    localDate: start > 0 ? localDateOf(start, zone) : '',
    localStart: start > 0 ? localClockOf(start, zone) : '',
    localEnd: end > 0 ? localClockOf(end, zone) : '',
    valid,
  };
}

/** Half-open `[startAt, endAt)`: an instant exactly at `endAt` is already over. */
export function inWindow(window, now) {
  if (!window || !(window.startAt > 0) || !(window.endAt > 0)) return false;
  return now >= window.startAt && now < window.endAt;
}

function carriedOver(window, now, zone) {
  return window.valid && inWindow(window, now) && window.localDate !== localDateOf(now, zone);
}

const NO_EVIDENCE = Object.freeze({ kind: 'none', consumed: 0, totalUnits: 0, artifactRef: '', artifactVersion: 0 });

function activityRecord(row, context) {
  const { scopeSignatureValue, now, zone, ttlMs, receiptLookup } = context;
  const status = shortText(row?.status, 32) || 'unknown';
  const evidence = evidenceOf(row);
  const activityId = shortText(row?.activityId, 120);
  const receipt = receiptFor(activityId, evidence, receiptLookup);
  const observedAt = num(row?.updatedAt) || num(row?.startedAt);
  const { freshness, freshnessAgeMs } = freshnessOf(observedAt, now, ttlMs);
  let state = 'unknown';
  let lifecycleReason = 'status-unmapped';
  if (status === 'running') { state = 'running'; lifecycleReason = 'activity-running'; }
  else if (status === 'paused') { state = 'paused'; lifecycleReason = 'activity-paused'; }
  else if (status === 'pending') { state = 'scheduled'; lifecycleReason = 'row-created-not-started'; }
  else if (status === 'done') {
    if (evidence.kind !== 'none') { state = 'completed'; lifecycleReason = 'done-with-evidence'; }
    else { lifecycleReason = 'done-without-evidence'; }
  } else if (status === 'failed') lifecycleReason = 'failed-without-completion';
  else if (status === 'abandoned') lifecycleReason = 'abandoned-without-completion';
  const window = windowOf(row?.startedAt, 0, zone);
  return {
    kind: 'activity',
    id: activityId,
    source: 'p2-activity',
    sourceRank: SOURCE_RANK['p2-activity'],
    scope: scopeSignatureValue,
    observedAt,
    status,
    state,
    lifecycleReason,
    receiptRef: receipt.receiptRef,
    receiptSource: receipt.receiptSource,
    evidence,
    freshness,
    freshnessAgeMs,
    reality: shortText(row?.reality, 32),
    adapter: shortText(row?.adapter, 40),
    title: shortText(row?.target ?? row?.kind),
    activity: shortText(row?.kind ?? row?.activity, 40),
    consumed: evidence.consumed,
    totalUnits: evidence.totalUnits,
    window,
    carriedOver: false,
  };
}

function buildActivityIndex(records) {
  return {
    /** Resolve a slot to an activity. Only an exact title match can ever prove `completed`. */
    match(slot) {
      const title = shortText(slot?.title, LIMITS.maxTitleChars);
      if (title) {
        const byTarget = records.find(record => record.title === title);
        if (byTarget) return { by: 'target', activity: byTarget };
      }
      const kind = shortText(slot?.activity, 40);
      const startAt = num(slot?.startAt);
      const endAt = num(slot?.endAt);
      if (!kind || !(startAt > 0) || !(endAt > 0)) return null;
      const byWindow = records.find(record => record.activity === kind
        && record.window.startAt > 0 && record.window.startAt >= startAt && record.window.startAt < endAt);
      return byWindow ? { by: 'kind-window', activity: byWindow } : null;
    },
  };
}

function slotRecord(slot, context, index) {
  const { scopeSignatureValue, now, zone, ttlMs } = context;
  const status = shortText(slot?.status, 32) || 'unknown';
  const startAt = num(slot?.startAt);
  const endAt = num(slot?.endAt);
  const window = windowOf(startAt, endAt, zone);
  const observedAt = startAt;
  const { freshness, freshnessAgeMs } = freshnessOf(observedAt, now, ttlMs);
  const match = index.match(slot);
  let state = 'unknown';
  let lifecycleReason = 'status-unmapped';
  if (status === 'planned' || status === 'started') {
    if (window.valid && inWindow(window, now)) {
      state = 'scheduled';
      lifecycleReason = status === 'started' ? 'claimed-in-window-without-activity-evidence' : 'in-window-not-started';
    } else if (endAt > 0 && now >= endAt) {
      // E-5: the window elapsed. That is all it means. It is NOT `completed`.
      state = 'window-ended';
      lifecycleReason = 'window-ended-without-activity';
    } else {
      state = 'scheduled';
      lifecycleReason = 'planned-for-later';
    }
  } else if (status === 'done') {
    if (match?.by === 'target' && match.activity.state === 'completed') {
      state = 'completed';
      lifecycleReason = 'slot-done-with-matching-activity-evidence';
    } else {
      state = 'window-ended';
      lifecycleReason = match ? 'slot-done-without-matching-evidence' : 'slot-done-without-activity-evidence';
    }
  } else if (status === 'skipped') {
    state = 'window-ended';
    lifecycleReason = 'slot-skipped';
  } else if (status === 'expired') {
    state = 'window-ended';
    lifecycleReason = 'slot-expired';
  }
  const evidence = match?.activity?.evidence ?? NO_EVIDENCE;
  return {
    kind: 'plan-slot',
    id: shortText(slot?.slotId, 120),
    source: 'p2-plan',
    sourceRank: SOURCE_RANK['p2-plan'],
    scope: scopeSignatureValue,
    observedAt,
    status,
    state,
    lifecycleReason,
    receiptRef: match?.by === 'target' ? (match.activity.receiptRef ?? '') : '',
    receiptSource: match?.by === 'target' ? (match.activity.receiptSource ?? 'none') : 'none',
    evidence,
    freshness,
    freshnessAgeMs,
    title: shortText(slot?.title ?? slot?.activity),
    activity: shortText(slot?.activity, 40),
    matchActivityId: match ? match.activity.id : '',
    matchBy: match ? match.by : '',
    window,
    carriedOver: carriedOver(window, now, zone),
  };
}

function occurrenceRecord(occurrence, context) {
  const { scopeSignatureValue, now, zone, ttlMs } = context;
  const status = shortText(occurrence?.status, 32) || 'unknown';
  const scheduledAt = num(occurrence?.scheduledAt);
  const endAt = num(occurrence?.slotEndAt) || (scheduledAt > 0 ? scheduledAt + 3_600_000 : 0);
  const window = windowOf(scheduledAt, endAt, zone);
  const { freshness, freshnessAgeMs } = freshnessOf(scheduledAt, now, ttlMs);
  let state = 'scheduled';
  let lifecycleReason = 'occurrence-scheduled';
  if (status === 'due') {
    state = inWindow(window, now) ? 'scheduled' : 'unknown';
    lifecycleReason = 'occurrence-due';
  } else if (status === 'dispatched') {
    // `dispatched` proves the occurrence reached a consumer, never that anything was performed
    // (CONTRACT §12.5: no consumer ⇒ no `completed` on its behalf, and the runtime never records one).
    state = 'unknown';
    lifecycleReason = 'occurrence-dispatched-not-execution-evidence';
  } else if (status === 'skipped') { state = 'window-ended'; lifecycleReason = 'occurrence-skipped'; }
  else if (status === 'cancelled') { state = 'window-ended'; lifecycleReason = 'occurrence-cancelled'; }
  else if (status === 'expired') { state = 'window-ended'; lifecycleReason = 'occurrence-expired'; }
  else if (status === 'unknown') { lifecycleReason = 'occurrence-status-unknown'; }
  return {
    kind: 'agenda-occurrence',
    id: shortText(occurrence?.occurrenceId, 120),
    source: 'h1-agenda',
    sourceRank: SOURCE_RANK['h1-agenda'],
    scope: scopeSignatureValue,
    observedAt: scheduledAt,
    status,
    state,
    lifecycleReason,
    receiptRef: '',
    receiptSource: 'none',
    evidence: NO_EVIDENCE,
    freshness,
    freshnessAgeMs,
    itemId: shortText(occurrence?.itemId, 120),
    title: shortText(occurrence?.title ?? occurrence?.itemId),
    activity: '',
    window,
    carriedOver: carriedOver(window, now, zone),
  };
}

// ── conflicts ─────────────────────────────────────────────────────────────────

function detectConflicts({ activities, planSlots, occurrences, statusCounts }) {
  const conflicts = [];
  const push = conflict => {
    if (conflicts.length >= LIMITS.maxConflicts) return;
    conflicts.push({ ...conflict, sources: uniq(conflict.sources ?? [], 4) });
  };

  if (num(statusCounts?.running) > 0 && !activities.some(record => record.state === 'running')) {
    push({
      code: 'running-count-without-row',
      detail: 'p2Status 报有 running 活动，但活动列表里没有任何 running 行',
      a: { source: 'p2Status', summary: `running=${num(statusCounts?.running)}` },
      b: { source: 'p2-activity', summary: 'no-running-row' },
      sources: ['p2Status', 'p2-activity'],
    });
  }

  const live = activities.find(record => record.state === 'running' || record.state === 'paused') ?? null;
  if (live) {
    const slot = planSlots.find(record => inWindow(record.window, num(live.observedAt)) && record.title) ?? null;
    if (slot && slot.title !== live.title) {
      push({
        code: 'activity-plan-mismatch',
        detail: '正在执行的活动与当前计划槽不是同一件事',
        a: { source: 'p2-activity', summary: live.title, id: live.id },
        b: { source: 'p2-plan', summary: slot.title, id: slot.id },
        sources: ['p2-activity', 'p2-plan'],
      });
    }
    const occurrence = occurrences.find(record => inWindow(record.window, num(live.observedAt)) && record.title) ?? null;
    if (occurrence && occurrence.title !== live.title) {
      push({
        code: 'agenda-activity-mismatch',
        detail: '日程里现在这一项与正在执行的活动不是同一件事',
        a: { source: 'p2-activity', summary: live.title, id: live.id },
        b: { source: 'h1-agenda', summary: occurrence.title, id: occurrence.id },
        sources: ['p2-activity', 'h1-agenda'],
      });
    }
  }

  const ordered = planSlots.filter(record => record.window.startAt > 0 && record.window.endAt > 0)
    .slice()
    .sort((left, right) => left.window.startAt - right.window.startAt);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index].window.startAt < ordered[index - 1].window.endAt) {
      push({
        code: 'plan-slot-double-booked',
        detail: '两个计划槽的窗口互相重叠',
        a: { source: 'p2-plan', summary: ordered[index - 1].title, id: ordered[index - 1].id },
        b: { source: 'p2-plan', summary: ordered[index].title, id: ordered[index].id },
        sources: ['p2-plan'],
      });
      break;
    }
  }
  return conflicts;
}

// ── public entry ──────────────────────────────────────────────────────────────

/**
 * Read one bounded snapshot of the character's real life state.
 *
 * @param {object}   input
 * @param {object|null} input.runtime   the cognitive runtime (may be null / inert)
 * @param {object|null} input.bound     host-resolved identity binding (authoritative)
 * @param {string}   input.sessionId    session id; only used when no binding is given
 * @param {string}   input.scopeKey     already-persisted scope key (wins over both)
 * @param {string}   input.timeZone     IANA name, default Asia/Shanghai
 * @param {number}   input.now          observation instant (tests must inject it)
 * @param {number}   input.cacheTtlMs   snapshot TTL; 0 disables the cache
 * @param {boolean}  input.force        user asked for progress / cache expired ⇒ re-read
 * @param {function} input.receiptLookup optional `activityId => receiptId`
 * @param {number}   input.maxActivities cap on activity rows read
 * @returns {object} facts — see docs/E-life-facts-draft.md §2.2. Never throws.
 */
export function collectLifeFacts({
  runtime = null,
  bound = null,
  sessionId = '',
  scopeKey = '',
  timeZone = DEFAULT_TIME_ZONE,
  now = Date.now(),
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  force = false,
  receiptLookup = null,
  maxActivities = LIMITS.maxActivities,
} = {}) {
  const clock = Number.isFinite(Number(now)) ? truncate(Number(now)) : truncate(Date.now());
  const ttlMs = Number.isFinite(Number(cacheTtlMs)) ? Math.max(0, truncate(Number(cacheTtlMs))) : DEFAULT_CACHE_TTL_MS;
  const zoneOk = isValidTimeZone(timeZone);
  const zone = zoneOk ? String(timeZone).trim() : DEFAULT_TIME_ZONE;
  const scope = describeScope({ scopeKey, bound, sessionId });
  const reasons = [];
  const failures = [];
  if (!zoneOk) reasons.push('timezone-invalid');

  const context = { scope, zone, clock, ttlMs, receiptLookup, maxActivities: Number(maxActivities) || LIMITS.maxActivities };

  if (!runtime || typeof runtime !== 'object') {
    reasons.push('runtime-not-mounted');
    return disabledFacts({ context, reasons, failures });
  }

  const statusCall = safeCall(runtime.p2Status, scope.input);
  if (!statusCall.ok) failures.push({ source: 'p2Status', code: statusCall.code, message: statusCall.message });
  const status = statusCall.ok ? statusCall.value : null;

  if (status && status.ok === false && DISABLED_CODES.includes(shortText(status.code, 60))) {
    reasons.push(shortText(status.code, 60));
    return disabledFacts({ context, reasons, failures });
  }
  if (status && status.activities?.enabled !== true && status.planning?.enabled !== true) {
    reasons.push('activities-disabled', 'planning-disabled');
    return disabledFacts({ context, reasons, failures });
  }

  const key = cacheKeyOf(scope, zone);
  const entry = scope.signature ? snapshots.get(key) : undefined;
  const ageMs = entry ? Math.max(0, clock - entry.at) : 0;
  const expired = Boolean(entry) && ttlMs > 0 && ageMs >= ttlMs;
  const reuse = Boolean(entry) && !force && ttlMs > 0 && !expired;
  const cacheMeta = {
    hit: reuse,
    forced: force === true,
    ageMs,
    ttlMs,
    refreshedAfterExpiry: Boolean(expired) && force !== true,
    reason: reuse ? 'within-ttl' : force === true ? 'forced' : expired ? 'ttl-expired' : entry ? 'cache-disabled' : 'cold',
  };

  if (reuse) {
    return assembleFacts(entry.snapshot, { context, reasons, failures, cacheMeta });
  }

  // ── the four reads, each wrapped ────────────────────────────────────────────
  const activitiesCall = safeCall(runtime.listActivities, context.maxActivities
    ? { ...scope.input, limit: context.maxActivities }
    : scope.input);
  const planCall = safeCall(runtime.listPlan, scope.input);
  const scheduleCall = safeCall(runtime.todaySchedule, scope.input);

  const callFailures = [];
  const noteRead = (source, call) => {
    if (call.ok) return;
    callFailures.push({ source, code: call.code, message: call.message });
    failures.push({ source, code: call.code, message: call.message });
  };
  noteRead('p2Activity', activitiesCall);
  noteRead('p2Plan', planCall);
  noteRead('h1Agenda', scheduleCall);

  const disabledCodes = [];
  const unboundSources = [];
  for (const [source, call] of [['p2Activity', activitiesCall], ['p2Plan', planCall], ['h1Agenda', scheduleCall]]) {
    if (!call.ok || call.value.ok !== false) continue;
    const code = shortText(call.value.code, 60);
    if (DISABLED_CODES.includes(code)) disabledCodes.push(code);
    if (SCOPE_CODES.includes(code)) unboundSources.push(source);
  }
  if (disabledCodes.length) {
    reasons.push(...disabledCodes);
    return disabledFacts({ context, reasons, failures });
  }
  // Scope resolution is decided by the **scope-bearing** reads only.
  //
  // `todaySchedule` cannot prove it: an agenda-disabled installation short-circuits to
  // `{ok:true, enabled:false, items:[], occurrences:[]}` *without ever resolving a scope*, so
  // trusting the agenda here would turn "we do not know whose life this is" into the default
  // world's silence — the exact fallback the plan forbids (E-6). Only an explicit `unbound`
  // from activities/plan (what the runtime says when it cannot resolve an identity) counts.
  const scopeBearingOk = (activitiesCall.ok && activitiesCall.value.ok !== false)
    || (planCall.ok && planCall.value.ok !== false);
  const scopeSayUnbound = unboundSources.filter(source => source === 'p2Activity' || source === 'p2Plan');
  const scopeUnresolved = !scopeBearingOk && scopeSayUnbound.length > 0;
  if (scopeUnresolved) reasons.push('scope-unresolved', ...unboundSources.map(source => `${source}-unbound`));

  // ── cross-session probe (plan §2.3 疑点 3) ─────────────────────────────────
  //
  // When a caller passes BOTH a binding and a session id, the runtime silently prefers the
  // binding. That is exactly how `companion:life` can read one world while the tool reads
  // another, so the disagreement is surfaced instead of absorbed: the session is read on its own
  // and the two fingerprints compared. Two empty answers are indistinguishable by design.
  let scopeConflict = false;
  let otherSignature = '';
  if (scope.boundProvided && scope.sessionIdProvided) {
    const probePlan = safeCall(runtime.listPlan, { sessionId: scope.session });
    const probeActivities = safeCall(runtime.listActivities, { sessionId: scope.session });
    const probeOk = (probePlan.ok && probePlan.value.ok !== false) || (probeActivities.ok && probeActivities.value.ok !== false);
    if (probeOk) {
      otherSignature = `s:${scope.session}`;
      const fingerprint = (planValue, activitiesValue) => {
        const planId = shortText(planValue?.plan?.planId ?? '', 120);
        const slots = (Array.isArray(planValue?.slots) ? planValue.slots : []).map(slot => shortText(slot?.slotId, 120)).filter(Boolean).sort().join(',');
        const rows = (Array.isArray(activitiesValue?.activities) ? activitiesValue.activities : []).map(row => shortText(row?.activityId, 120)).filter(Boolean).sort().join(',');
        return `${planId}#${slots}#${rows}`;
      };
      const sessionPrint = fingerprint(probePlan.value, probeActivities.value);
      const primaryPrint = fingerprint(planCall.ok ? planCall.value : null, activitiesCall.ok ? activitiesCall.value : null);
      if (sessionPrint !== primaryPrint) {
        scopeConflict = true;
        reasons.push('scope-conflict');
      }
    } else {
      reasons.push('session-unresolved');
    }
  }

  // ── records ────────────────────────────────────────────────────────────────
  const activityRows = activitiesCall.ok && Array.isArray(activitiesCall.value.activities)
    ? activitiesCall.value.activities.slice(0, Math.max(1, context.maxActivities))
    : [];
  const slotRows = planCall.ok && Array.isArray(planCall.value.slots) ? planCall.value.slots.slice(0, LIMITS.maxPlanSlots) : [];
  const occurrenceRows = scheduleCall.ok && Array.isArray(scheduleCall.value.occurrences)
    ? scheduleCall.value.occurrences.slice(0, LIMITS.maxScheduleRows)
    : [];
  const scheduleItems = scheduleCall.ok && Array.isArray(scheduleCall.value.items) ? scheduleCall.value.items : [];

  const recordContext = { scopeSignatureValue: scope.signature, now: clock, zone, ttlMs, receiptLookup };
  const activities = activityRows.map(row => activityRecord(row, recordContext)).slice(0, LIMITS.maxRecords);
  const index = buildActivityIndex(activities);
  const planSlots = slotRows.map(slot => slotRecord(slot, recordContext, index)).slice(0, LIMITS.maxRecords);
  const occurrences = occurrenceRows.map(row => occurrenceRecord({
    ...row,
    title: (scheduleItems.find(item => item?.itemId === row?.itemId)?.title) ?? '',
  }, recordContext)).slice(0, LIMITS.maxRecords);

  const snapshot = {
    statusCounts: {
      running: num(status?.activities?.running),
      paused: num(status?.activities?.counts?.paused),
    },
    capabilities: {
      activitiesEnabled: status ? status.activities?.enabled === true : null,
      planningEnabled: status ? status.planning?.enabled === true : null,
      activitiesState: shortText(status?.activities?.state, 32),
      planningState: shortText(status?.planning?.state, 32),
      mounted: status ? status.ok !== false : false,
      agendaEnabled: scheduleCall.ok ? scheduleCall.value.enabled !== false && scheduleCall.value.ok !== false : false,
      agendaState: shortText(scheduleCall.ok ? scheduleCall.value.state : 'unknown', 32) || 'unknown',
    },
    planMeta: planCall.ok && planCall.value.plan ? {
      planId: shortText(planCall.value.plan.planId, 120),
      day: shortText(planCall.value.plan.day, 32),
      version: num(planCall.value.plan.version),
      status: shortText(planCall.value.plan.status, 32),
      summary: shortText(planCall.value.plan.summary, 120),
    } : null,
    activities,
    planSlots,
    occurrences,
    callFailures,
    scopeUnresolved,
    scopeConflict,
    otherSignature,
  };

  if (ttlMs > 0 && scope.signature) {
    snapshots.set(key, { at: clock, snapshot });
    pruneSnapshots();
  }
  return assembleFacts(snapshot, { context, reasons, failures, cacheMeta });
}

function truncate(value) {
  return Number(Math.trunc(value));
}

// ── assembly ──────────────────────────────────────────────────────────────────

function disabledFacts({ context, reasons, failures }) {
  const { scope, zone, clock, ttlMs } = context;
  return baseFacts({
    state: 'disabled', reasons, failures, scope, zone, clock, ttlMs,
    capabilities: { activitiesEnabled: null, planningEnabled: null, activitiesState: '', planningState: '', mounted: false, agendaEnabled: false, agendaState: 'unknown' },
  });
}

function assembleFacts(snapshot, { context, reasons, failures, cacheMeta }) {
  const { scope, zone, clock, ttlMs } = context;
  const activities = snapshot.activities ?? [];
  const planSlots = snapshot.planSlots ?? [];
  const occurrences = snapshot.occurrences ?? [];
  const callFailures = snapshot.callFailures ?? [];
  const readFailed = callFailures.length > 0;
  const scopeUnknown = snapshot.scopeUnresolved === true || snapshot.scopeConflict === true;

  const today = localDateOf(clock, zone);
  const startOfDay = startOfLocalDay(clock, zone);
  const dayWindow = { startAt: startOfDay, endAt: startOfDay + 86_400_000 };

  const running = activities.filter(record => record.state === 'running');
  const paused = activities.filter(record => record.state === 'paused');
  const completedAll = activities.filter(record => record.state === 'completed');
  // Recency, not "today only": a completion whose timestamp is unknown still belongs in the
  // list (with `freshness:'unknown'`), and an older one must not disappear because today
  // happens to be empty. Ordering puts known instants first, unknown timestamps last.
  const recentCompleted = completedAll
    .slice()
    .sort((left, right) => (right.observedAt || 0) - (left.observedAt || 0))
    .slice(0, 5);
  const others = activities
    .filter(record => !['running', 'paused'].includes(record.state) && !recentCompleted.includes(record))
    .slice(0, 8);

  const currentPlanSlot = planSlots.find(record => record.lifecycleReason === 'in-window-not-started'
    || record.lifecycleReason === 'claimed-in-window-without-activity-evidence') ?? null;
  const nextSlot = planSlots
    .filter(record => record.window.startAt >= clock && record.state !== 'window-ended')
    .sort((left, right) => left.window.startAt - right.window.startAt)[0] ?? null;
  const endedSlots = planSlots.filter(record => record.state === 'window-ended');
  const changedSlots = planSlots.filter(record => record.window.startAt > 0
    && record.state !== 'window-ended'
    && record.window.localDate !== today);

  const todaysOccurrences = occurrences.filter(record => record.window.localDate === today);
  const currentOccurrence = todaysOccurrences.find(record => record.state === 'scheduled' && inWindow(record.window, clock)) ?? null;
  const nextOccurrence = todaysOccurrences
    .filter(record => record.window.startAt >= clock)
    .sort((left, right) => left.window.startAt - right.window.startAt)[0] ?? null;

  const conflicts = detectConflicts({ activities, planSlots, occurrences: todaysOccurrences, statusCounts: snapshot.statusCounts });

  let state;
  if (readFailed && activities.length + planSlots.length + occurrences.length === 0) state = 'read-failed';
  else if (scopeUnknown) state = 'unknown';
  else if (readFailed) state = 'read-failed';
  else if (running.length) state = 'running';
  else if (paused.length) state = 'paused';
  else if (currentPlanSlot || currentOccurrence || nextSlot || nextOccurrence
    || planSlots.some(record => record.lifecycleReason === 'in-window-not-started')
    || todaysOccurrences.some(record => record.state === 'scheduled')) state = 'scheduled';
  else if (completedAll.length) state = 'completed';
  else state = 'idle';

  const windowEnded = [...planSlots, ...occurrences].filter(record => record.state === 'window-ended').length;
  const allReasons = uniq([
    ...reasons,
    ...(snapshot.scopeConflict ? ['scope-conflict'] : []),
    ...(snapshot.scopeUnresolved ? ['scope-unresolved'] : []),
    ...callFailures.map(failure => `${failure.source}-${failure.code || 'call-threw'}`),
  ]);

  return baseFacts({
    state,
    ok: state !== 'unknown' && state !== 'read-failed' && state !== 'disabled',
    partial: readFailed && activities.length + planSlots.length + occurrences.length > 0,
    reasons: allReasons,
    failures: callFailures,
    scope, zone, clock, ttlMs,
    cacheMeta,
    capabilities: snapshot.capabilities,
    scopeMeta: {
      resolved: snapshot.scopeUnresolved !== true,
      conflict: snapshot.scopeConflict === true,
      otherSignature: snapshot.otherSignature ?? '',
    },
    activities: {
      current: running[0] ?? null,
      paused: paused[0] ?? null,
      recentCompleted,
      others,
      counts: {
        read: activities.length,
        running: running.length,
        paused: paused.length,
        completedEvidenced: completedAll.length,
        completedUnevidenced: activities.filter(record => record.lifecycleReason === 'done-without-evidence').length,
      },
    },
    plan: {
      available: Boolean(snapshot.planMeta) || planSlots.length > 0,
      planId: snapshot.planMeta?.planId ?? '',
      day: snapshot.planMeta?.day ?? '',
      version: snapshot.planMeta?.version ?? 0,
      status: snapshot.planMeta?.status ?? '',
      summary: snapshot.planMeta?.summary ?? '',
      slots: planSlots,
      current: currentPlanSlot,
      next: nextSlot,
      endedToday: endedSlots,
      changedToday: changedSlots,
    },
    schedule: {
      available: snapshot.capabilities?.agendaEnabled === true || todaysOccurrences.length > 0,
      state: snapshot.capabilities?.agendaState ?? 'unknown',
      today: todaysOccurrences,
      current: currentOccurrence,
      next: nextOccurrence,
    },
    conflicts,
    dayWindow,
    counters: {
      records: activities.length + planSlots.length + occurrences.length,
      windowEnded,
      completedEvidenced: completedAll.length,
      completedUnevidenced: activities.filter(record => record.lifecycleReason === 'done-without-evidence').length,
    },
  });
}

function baseFacts({
  state, ok = false, partial = false, reasons, failures, scope, zone, clock, ttlMs,
  cacheMeta = null, capabilities = null, scopeMeta = null, activities = null, plan = null,
  schedule = null, conflicts = null, dayWindow = null, counters = null,
}) {
  const startOfDay = startOfLocalDay(clock, zone);
  return {
    ok,
    state,
    partial,
    scope: {
      resolved: scopeMeta ? scopeMeta.resolved : false,
      via: scope.via,
      signature: scope.signature,
      boundProvided: scope.boundProvided,
      sessionIdProvided: scope.sessionIdProvided,
      scopeKeyProvided: scope.scopeKeyProvided,
      conflict: scopeMeta ? scopeMeta.conflict : false,
      otherSignature: scopeMeta ? scopeMeta.otherSignature : '',
      reasons: uniq((reasons ?? []).filter(reason => reason === 'scope-unresolved' || reason === 'scope-conflict')),
    },
    timeZone: zone,
    localDate: localDateOf(clock, zone),
    dayWindow: dayWindow ?? { startAt: startOfDay, endAt: startOfDay + 86_400_000 },
    observedAt: clock,
    cached: cacheMeta ?? { hit: false, forced: false, ageMs: 0, ttlMs, refreshedAfterExpiry: false, reason: 'none' },
    capabilities: capabilities ?? { activitiesEnabled: null, planningEnabled: null, activitiesState: '', planningState: '', mounted: false, agendaEnabled: false, agendaState: 'unknown' },
    activities: activities ?? { current: null, paused: null, recentCompleted: [], others: [], counts: { read: 0, running: 0, paused: 0, completedEvidenced: 0, completedUnevidenced: 0 } },
    plan: plan ?? { available: false, planId: '', day: '', version: 0, status: '', summary: '', slots: [], current: null, next: null, endedToday: [], changedToday: [] },
    schedule: schedule ?? { available: false, state: 'unknown', today: [], current: null, next: null },
    conflicts: conflicts ?? [],
    reasons: uniq(reasons ?? []),
    failures: (failures ?? []).slice(0, LIMITS.maxFailures),
    counters: counters ?? { records: 0, windowEnded: 0, completedEvidenced: 0, completedUnevidenced: 0 },
  };
}

// ── rendering ─────────────────────────────────────────────────────────────────

function spanOf(record) {
  const window = record?.window ?? {};
  if (window.localStart && window.localEnd) return `${window.localStart}–${window.localEnd}`;
  return window.localStart ?? '';
}

function freshnessNote(record) {
  if (record?.freshness === 'aging') return '（记录时间较近，但不是此刻）';
  if (record?.freshness === 'stale') return '（这是上一次的记录，不是现在）';
  if (record?.freshness === 'unknown') return '（时间未知）';
  return '';
}

/**
 * Render the facts as prompt text. Never claims a plan happened, never claims an activity the
 * snapshot does not contain. Returns `''` when the input is not a facts object.
 */
export function renderLifeFacts(facts) {
  if (!facts || typeof facts !== 'object' || !Array.isArray(facts.reasons)) return '';
  const lines = [];
  const push = line => {
    const normalized = shortText(line, LIMITS.maxRenderChars);
    if (normalized) lines.push(`- ${normalized}`);
  };

  const state = shortText(facts.state, 32);
  const zone = shortText(facts.timeZone, 40) || DEFAULT_TIME_ZONE;

  if (state === 'disabled') {
    const codes = (facts.reasons ?? []).filter(reason => reason && reason !== 'scope-unresolved').slice(0, 3);
    push(`自主规划与活动当前未启用${codes.length ? `（${codes.join('、')}）` : ''}：这是能力关闭，不是“没有安排”，也不是无事发生。被问到在做什么，如实说这块没开。`);
    return compose(lines);
  }

  if (state === 'unknown' || state === 'read-failed') {
    if (state === 'read-failed') {
      const why = (facts.failures ?? []).map(failure => `${failure.source}:${failure.code}`).slice(0, 3);
      push(`生活状态读取失败${why.length ? `（${why.join('、')}）` : ''}：读不到不等于空闲，不知道现在在做什么就说不知道，不要用猜测补上。`);
      const partial = facts.activities?.current ?? facts.activities?.paused ?? facts.plan?.next ?? null;
      if (partial) push(`失败的读取里仍有一部分可用：${partial.title || partial.activity}（状态 ${partial.state}）${freshnessNote(partial)}`);
      return compose(lines);
    }
    if (facts.scope?.conflict === true) {
      push(`作用域冲突：身份绑定与本次会话指向不同的世界。绑定 ${shortText(facts.scope.signature, 60) || '（空）'}；会话 ${shortText(facts.scope.otherSignature, 60) || '（空）'}。两边不一致，不能把任何一边当成事实；先问清是哪一边。`);
    } else {
      push('无法确定这份生活状态属于谁（作用域没有解析出来），因此没有可报告的活动、日程或计划。不要用默认人物或默认世界补一个状态。');
    }
    return compose(lines);
  }

  const current = facts.activities?.current ?? null;
  if (current) {
    const progress = current.evidence?.totalUnits > 0
      ? `，进度 ${current.evidence.consumed}/${current.evidence.totalUnits}`
      : current.evidence?.consumed > 0 ? `，已处理 ${current.evidence.consumed}` : '，进度未知';
    push(`正在做：${current.activity || current.title}${current.title && current.activity ? ` · ${current.title}` : ''}${progress}${freshnessNote(current)}`);
  }
  const paused = facts.activities?.paused ?? null;
  if (paused) {
    push(`暂停中：${paused.title || paused.activity}（活动是暂停，不是执行中，也没有完成证据）${freshnessNote(paused)}`);
  }
  for (const record of (facts.activities?.recentCompleted ?? []).slice(0, 2)) {
    push(`有执行证据的完成：${record.title || record.activity}（${record.receiptRef || '证据引用缺失'}）${freshnessNote(record)}`);
  }

  for (const record of (facts.plan?.endedToday ?? []).slice(0, 3)) {
    const span = spanOf(record);
    push(`计划窗口已结束、但没有执行证据：${record.title}${span ? `（${span}）` : ''}——只能说这个时间段过去了，不能说做过（${record.lifecycleReason}）`);
  }

  const next = facts.plan?.next ?? facts.schedule?.next ?? null;
  if (next) {
    const span = spanOf(next);
    push(`接下来${span ? `（${span}）` : ''}：${next.title || next.activity}（计划，不是已经做了）`);
  }
  if (facts.plan?.current) {
    push(`计划里现在这一段：${facts.plan.current.title || facts.plan.current.activity}——只是计划，还没有执行证据`);
  }
  if ((facts.schedule?.today ?? []).length) {
    push(`今天日程 ${facts.schedule.today.length} 项（日程只说明打算，不代表做过）`);
  }

  for (const conflict of (facts.conflicts ?? []).slice(0, 2)) {
    const left = `${conflict.a?.source ?? '?'} 说 ${conflict.a?.summary ?? ''}`;
    const right = `${conflict.b?.source ?? '?'} 说 ${conflict.b?.summary ?? ''}`;
    push(`来源冲突（${conflict.code}）：${left}；${right}——两边不一致，如实说两边，不要择一掩盖`);
  }

  if (state === 'idle') push('当前没有正在执行的活动，也没有到点的计划或日程；这是“此刻没有在做”，不能当成“做过什么”的说明。');
  if (facts.plan?.changedToday?.length) push(`计划有改期（${facts.plan.changedToday.length} 段窗口已不在本地当天），按改后的时间说，不要说成今天原定。`);
  if (facts.cached?.refreshedAfterExpiry === true) push('旧快照已过期并按 TTL 重读；上面是重读后的状态。');
  push(`时区 ${zone}，本地日期 ${shortText(facts.localDate, 32)}。计划只是计划：没有执行证据的计划窗口结束，只能说不清楚有没有做。`);

  return compose(lines);
}

function compose(lines) {
  const bounded = [];
  let used = 0;
  for (const line of lines.slice(0, LIMITS.maxRenderLines)) {
    const trimmed = line.length > LIMITS.maxRenderChars ? `${line.slice(0, LIMITS.maxRenderChars - 1)}…` : line;
    if (used + trimmed.length + 1 > LIMITS.maxRenderChars) {
      if (!bounded.length) bounded.push(trimmed);
      break;
    }
    bounded.push(trimmed);
    used += trimmed.length + 1;
  }
  if (!bounded.length) return '';
  return ['【今天的生活·事实快照】', ...bounded].join('\n');
}

export const __internals = Object.freeze({ freshnessOf, evidenceOf, inWindow, activityRecord, slotRecord, occurrenceRecord, detectConflicts, startOfLocalDay });
