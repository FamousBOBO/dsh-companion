// H1 sustainable agenda — definitions, occurrence slots and the authoritative reducer
// (CONTRACT.md §12.2/§12.3/§12.4). Everything formal goes through the event path:
// `applyAgendaEvent` is the only writer of `agenda_items` / `agenda_occurrences`, it
// runs inside the caller's transaction (`extra`) and refuses deterministically with a
// typed RuntimeError so `events.mjs` rolls the whole event back instead of leaving a
// side projection behind.
//
// An agenda is an *opportunity*, not a reminder and not a permission: nothing here
// writes `memory_outbox`, contacts a channel, or claims a delivery. `delivery` is only
// ever `none` or `reminder-owned` (the existing reminders runner keeps the send path).
//
// Planning is pure: `planWindow` reads no database and no clock of its own, so the same
// definition always yields the same slot keys and instants (HH02/HH06/HH15).
import crypto from 'node:crypto';
import { CONSUMERS } from './events.mjs';
import { RuntimeError, ValidationError } from './errors.mjs';
import { normalizeScope, scopeKey as keyOf } from './scope.mjs';
import {
  addLocalDays,
  isValidLocalDate,
  isValidTimeZone,
  isoWeekdayOfDate,
  localDateString,
  normalizeLocalTime,
  resolveLocalInstant,
  startOfLocalDay,
} from './agenda-time.mjs';

export const AGENDA_ITEM_STATUS = Object.freeze(['active', 'cancelled', 'expired']);
/** Alias kept because CONTRACT §12.4 spells the export `AGENDA_STATUS`. */
export const AGENDA_STATUS = AGENDA_ITEM_STATUS;
export const OCCURRENCE_STATUS = Object.freeze(['scheduled', 'due', 'dispatched', 'skipped', 'cancelled', 'expired']);
export const TERMINAL_OCCURRENCE_STATUS = Object.freeze(['dispatched', 'skipped', 'cancelled', 'expired']);
export const RULE_KINDS = Object.freeze(['once', 'daily', 'weekly']);
export const AGENDA_AUTHORIZATION = Object.freeze(['plan', 'reminder', 'tool', 'proactive-contact']);
export const AGENDA_CATEGORIES = Object.freeze(['plan', 'activity', 'routine']);
export const AGENDA_DELIVERY = Object.freeze(['none', 'reminder-owned']);
export const SLOT_LIMITS = Object.freeze({ maxHorizonHours: 720, maxQuerySpanDays: 90, maxSlotsPerPlan: 512 });

const TERMINAL_OCCURRENCE = new Set(TERMINAL_OCCURRENCE_STATUS);
const TERMINAL_ITEM = new Set(['cancelled', 'expired']);
const SLICE = 'agenda';
const TITLE_LIMIT = 120;
const REF_LIMIT = 80;
const SOURCE_LIMIT = 40;
const REQUEST_KEY_LIMIT = 80;
const REASON_LIMIT = 60;
const ERROR_LIMIT = 200;
// A slot is an opportunity window, not an appointment: one hour is the recorded
// default length so `slot_end_at` is never a guess about private content.
const SLOT_MINUTES = 60;
const SLOT_MS = SLOT_MINUTES * 60000;
const HOUR_MS = 3600000;
// Patch keys the reducer will apply. §12.4 freezes the definition fields; `source` is
// provenance only (never authority) and is included because the runtime's update path
// treats it as patchable — refusing it would fail an honest update for no safety gain.
const PATCH_KEYS = new Set([
  'title', 'category', 'source', 'rule', 'timeZone', 'date', 'time', 'weekdays', 'atUtc',
  'validFrom', 'validUntil', 'authorization', 'goalRef', 'commitmentRef', 'resolution',
]);
// Occurrence kinds that move an existing row, with the states each may start from.
// CONTRACT §12.2 reachability, amended by A1-B1: `due → cancelled` (definition
// cancelled) and `due → expired` (retention elapsed) are legal; the terminal set is
// unchanged.
const OCCURRENCE_TARGET = Object.freeze({
  'agenda/occurrence-due': { status: 'due', from: ['scheduled'] },
  'agenda/occurrence-dispatched': { status: 'dispatched', from: ['scheduled', 'due'] },
  'agenda/occurrence-skipped': { status: 'skipped', from: ['scheduled', 'due'] },
  'agenda/occurrence-expired': { status: 'expired', from: ['scheduled', 'due'] },
  'agenda/occurrence-cancelled': { status: 'cancelled', from: ['scheduled', 'due'] },
});

// ---------------------------------------------------------------- small helpers

function atOf(value, db) {
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) return Math.trunc(number);
  if (db && typeof db.now === 'function') return Math.trunc(db.now());
  return Date.now();
}

/**
 * The deterministic instant of an agenda event: the caller's `now` (which `events.mjs`
 * sets to `event.occurredAt`) or the event's own `occurredAt`. There is deliberately no
 * wall-clock fallback — a reducer that reads the clock cannot be replayed (A1-B2).
 */
function eventInstant(now, event) {
  const fromNow = Number(now);
  if (Number.isFinite(fromNow) && fromNow > 0) return Math.trunc(fromNow);
  const fromEvent = Number(event?.occurredAt);
  if (Number.isFinite(fromEvent) && fromEvent > 0) return Math.trunc(fromEvent);
  throw new RuntimeError('invalid-payload', 'agenda events require a deterministic occurredAt');
}

function safeJson(text, fallback) {
  try {
    const value = JSON.parse(text ?? '');
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function code(value, limit = REASON_LIMIT) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function refOf(value) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, REF_LIMIT);
}

function intOf(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new ValidationError(`${field} must be an epoch millisecond`);
  return Math.trunc(number);
}

function keyArgument(scopeKeyValue) {
  if (typeof scopeKeyValue === 'string' && scopeKeyValue.trim()) return scopeKeyValue.trim();
  if (scopeKeyValue && typeof scopeKeyValue === 'object') return keyOf(normalizeScope(scopeKeyValue));
  throw new ValidationError('a scopeKey is required');
}

function limitOf(value, fallback, ceiling) {
  const number = Math.trunc(Number(value));
  if (!Number.isFinite(number) || number <= 0) return Math.min(fallback, ceiling);
  return Math.min(number, ceiling);
}

// --------------------------------------------------------------- normalisation

function noteFor(resolution) {
  if (resolution === 'gap') return 'local time does not exist in this zone (DST gap); no occurrence is generated';
  if (resolution === 'fold') return 'ambiguous local time (DST fold); the earlier UTC instant is used';
  return '';
}

function deriveRequestKey(core) {
  return `req_${sha256(canonicalJson(core)).slice(0, 24)}`;
}

function weekdaysOf(input) {
  const given = Array.isArray(input.weekdays)
    ? input.weekdays
    : typeof input.weekdays === 'string' && input.weekdays.trim()
      ? safeJson(input.weekdays, null)
      : null;
  if (!Array.isArray(given) || given.length === 0) throw new ValidationError('weekly requires weekdays');
  const days = [];
  for (const value of given) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1 || number > 7) throw new ValidationError('weekdays must be ISO 1..7');
    days.push(number);
  }
  return [...new Set(days)].sort((left, right) => left - right);
}

/**
 * Validate one agenda definition and return a frozen plain object.
 *
 * Rejections are ValidationError with stable messages (CONTRACT §12.4.4): an unknown
 * IANA zone is refused (`invalid-timezone`), never replaced by a default. `once` locks
 * one UTC instant (the DST resolution of that wall clock); `daily`/`weekly` keep the
 * local wall clock and resolve it per slot.
 */
export function normalizeDefinition(input = {}, { now = Date.now() } = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('definition must be an object');
  }
  const at = atOf(now, null);

  const title = typeof input.title === 'string' ? input.title.trim().slice(0, TITLE_LIMIT) : '';
  if (!title) throw new ValidationError('title is required');

  const category = input.category === undefined || input.category === null || input.category === '' ? 'plan' : input.category;
  if (!AGENDA_CATEGORIES.includes(category)) throw new ValidationError('unsupported category');

  const rule = input.rule;
  if (!RULE_KINDS.includes(rule)) throw new ValidationError(`unsupported rule: ${String(rule)}`);

  const timeZone = typeof input.timeZone === 'string' ? input.timeZone.trim() : '';
  if (!timeZone || !isValidTimeZone(timeZone)) throw new ValidationError(`invalid-timezone: ${timeZone}`);

  const time = normalizeLocalTime(input.time);
  if (!time) throw new ValidationError('invalid time: HH:MM required');

  let date = '';
  if (rule === 'once') {
    const given = typeof input.date === 'string' ? input.date.trim() : '';
    if (!isValidLocalDate(given)) throw new ValidationError('invalid local date: YYYY-MM-DD required');
    date = given;
  }
  const weekdays = rule === 'weekly' ? weekdaysOf(input) : [];

  const validFromGiven = input.validFrom !== undefined && input.validFrom !== null && input.validFrom !== '';
  // A1-B2/delta 4: the default window starts at the beginning of the local day, so a
  // retry later the same day keeps the same definition instead of drifting with `now`.
  const validFrom = validFromGiven ? intOf(input.validFrom, 'validFrom') : startOfLocalDay(at, timeZone);
  const validUntilGiven = input.validUntil !== undefined && input.validUntil !== null && input.validUntil !== '';
  const validUntil = validUntilGiven ? intOf(input.validUntil, 'validUntil') : null;
  if (validUntil !== null && validUntil <= validFrom) throw new ValidationError('validUntil must be after validFrom');

  const authorization = input.authorization === undefined || input.authorization === null || input.authorization === ''
    ? 'plan'
    : input.authorization;
  if (!AGENDA_AUTHORIZATION.includes(authorization)) throw new ValidationError('unsupported authorization');

  const source = typeof input.source === 'string' && input.source.trim()
    ? input.source.trim().slice(0, SOURCE_LIMIT)
    : 'tool';
  const goalRef = refOf(input.goalRef);
  const commitmentRef = refOf(input.commitmentRef);

  const resolved = rule === 'once'
    ? resolveLocalInstant({ date, time, timeZone })
    : { ok: true, at: null, resolution: 'exact' };
  const resolution = Object.freeze({
    localIntent: Object.freeze({ date, time, zone: timeZone }),
    resolution: resolved.resolution,
    note: noteFor(resolved.resolution),
  });
  const atUtc = rule === 'once' && resolved.ok ? resolved.at : null;

  // Definition-level idempotency (A1 delta 4): the same semantic request collides on
  // purpose, even from another session. `validFrom` is deliberately **not** part of the
  // key — it defaults to "today", so including it would turn every honest retry into a
  // new request. The local intent plus the resolved instant keep the key stable across a
  // DST gap/fold re-run, and an explicit `validUntil` is part of the request.
  const core = {
    title,
    category,
    rule,
    timeZone,
    date,
    time,
    weekdays,
    atUtc,
    validUntil: validUntilGiven ? validUntil : null,
    authorization,
    goalRef,
    commitmentRef,
  };
  const requestKey = typeof input.requestKey === 'string' && input.requestKey.trim()
    ? input.requestKey.trim().slice(0, REQUEST_KEY_LIMIT)
    : deriveRequestKey(core);

  return Object.freeze({
    title,
    category,
    source,
    rule,
    timeZone,
    date,
    time,
    weekdays: Object.freeze(weekdays),
    atUtc,
    validFrom,
    validUntil,
    authorization,
    goalRef,
    commitmentRef,
    requestKey,
    resolution,
  });
}

/**
 * Stable slot identity. Deliberately carries no revision: a revision bump reschedules
 * the same slot in place instead of creating a second row for the same opportunity.
 */
export function slotKeyFor(definition) {
  const rule = definition?.rule;
  if (rule === 'once') {
    const at = Number(definition.atUtc);
    if (Number.isFinite(at)) return `once:${at}`;
    return `once:gap:${definition.date ?? ''}T${definition.time ?? ''}`;
  }
  const localDate = typeof definition?.localDate === 'string' && definition.localDate
    ? definition.localDate
    : String(definition?.date ?? '');
  if (rule === 'daily') return `d:${localDate}`;
  if (rule === 'weekly') return `w:${localDate}`;
  throw new ValidationError(`unsupported rule: ${String(rule)}`);
}

/** Deterministic occurrence id: replay reproduces the same ids from the same slot. */
export function occurrenceIdFor(scopeKey, itemId, slotKey) {
  return 'occ_' + sha256(`${scopeKey}\u0000${itemId}\u0000${slotKey}`).slice(0, 24);
}

// -------------------------------------------------------------------- planning

function planningDefinition(item) {
  if (!item || typeof item !== 'object') throw new ValidationError('planWindow requires an item');
  const read = (...names) => {
    for (const name of names) {
      const value = item[name];
      if (value !== undefined && value !== null) return value;
    }
    return undefined;
  };
  const rule = String(read('rule', 'rule_kind', 'ruleKind') ?? '');
  if (!RULE_KINDS.includes(rule)) throw new ValidationError(`unsupported rule: ${rule}`);
  const timeZone = String(read('timeZone', 'time_zone', 'timezone') ?? '');
  if (!timeZone || !isValidTimeZone(timeZone)) throw new ValidationError(`invalid-timezone: ${timeZone}`);
  const time = normalizeLocalTime(read('time', 'localTime', 'local_time') ?? '');
  if (!time) throw new ValidationError('invalid time: HH:MM required');
  const weekdaysRaw = read('weekdays') ?? [];
  const weekdays = Array.isArray(weekdaysRaw) ? weekdaysRaw.map(Number) : (safeJson(weekdaysRaw, []) ?? []).map(Number);
  const atUtcRaw = read('atUtc', 'at_utc');
  const atUtc = Number.isFinite(Number(atUtcRaw)) ? Math.trunc(Number(atUtcRaw)) : null;
  const validFrom = Math.trunc(Number(read('validFrom', 'valid_from') ?? 0)) || 0;
  const validUntilRaw = read('validUntil', 'valid_until');
  const validUntil = Number.isFinite(Number(validUntilRaw)) ? Math.trunc(Number(validUntilRaw)) : null;
  const date = String(read('date', 'localDate', 'local_date') ?? '');
  const revision = Math.trunc(Number(read('revision', 'definitionRevision', 'definition_revision') ?? 1)) || 1;
  const status = String(read('status') ?? 'active');
  const resolutionRaw = read('resolution');
  const resolution = typeof resolutionRaw === 'string' ? safeJson(resolutionRaw, {}) : (resolutionRaw ?? {});
  return { rule, timeZone, time, weekdays, atUtc, validFrom, validUntil, date, revision, status, resolution };
}

function slotEntry({ slotKey, scheduledAt, slotEndAt, definitionRevision, resolution, localDate, skipped = false, reason = '' }) {
  const entry = { slotKey, scheduledAt, slotEndAt, definitionRevision, resolution, localDate };
  if (skipped) {
    entry.skipped = true;
    entry.reason = reason;
  }
  return Object.freeze(entry);
}

function onceResolution(definition) {
  const stored = definition.resolution?.resolution;
  if (stored === 'exact' || stored === 'gap' || stored === 'fold') return stored;
  if (definition.atUtc === null) return 'gap';
  const resolved = resolveLocalInstant({ date: definition.date, time: definition.time, timeZone: definition.timeZone });
  return resolved.resolution;
}

/**
 * Pure planning: the bounded list of slots a definition offers inside `[from, to]`.
 *
 * - only `status === 'active'` definitions plan anything;
 * - the window is clamped to the definition's own validity and to
 *   `SLOT_LIMITS.maxHorizonHours` from `now`, so no call can materialise an unbounded
 *   future;
 * - a slot whose resolved instant is already before `from` is not returned, which is
 *   what makes the same function usable for reconciliation;
 * - a DST-gap date returns one `skipped:true, reason:'dst-gap'` entry with
 *   `scheduledAt:null` (it counts toward `limit`) instead of inventing an instant.
 *
 * No database, no clock beyond the injected `now`, no mutation of `item`.
 */
export function planWindow({ item, from, to, limit = SLOT_LIMITS.maxSlotsPerPlan, now = Date.now() } = {}) {
  const definition = planningDefinition(item);
  if (definition.status !== 'active') return [];
  const nowMs = Number.isFinite(Number(now)) ? Math.trunc(Number(now)) : Date.now();
  const cap = Math.max(0, Math.min(Math.trunc(Number(limit) || 0), SLOT_LIMITS.maxSlotsPerPlan));
  if (!cap) return [];
  const horizon = nowMs + SLOT_LIMITS.maxHorizonHours * HOUR_MS;
  const rawFrom = Number.isFinite(Number(from)) ? Math.trunc(Number(from)) : nowMs;
  const rawTo = Number.isFinite(Number(to)) ? Math.trunc(Number(to)) : horizon;
  const windowFrom = Math.max(rawFrom, definition.validFrom);
  const ceiling = definition.validUntil === null ? rawTo : Math.min(rawTo, definition.validUntil);
  const windowTo = Math.min(ceiling, horizon);
  if (windowTo < windowFrom) return [];

  const revision = definition.revision;
  if (definition.rule === 'once') {
    const resolution = onceResolution(definition);
    if (definition.atUtc === null || resolution === 'gap') {
      return [slotEntry({
        slotKey: `once:gap:${definition.date}T${definition.time}`,
        scheduledAt: null,
        slotEndAt: null,
        definitionRevision: revision,
        resolution: 'gap',
        localDate: definition.date,
        skipped: true,
        reason: 'dst-gap',
      })];
    }
    if (definition.atUtc < windowFrom || definition.atUtc > windowTo) return [];
    return [slotEntry({
      slotKey: `once:${definition.atUtc}`,
      scheduledAt: definition.atUtc,
      slotEndAt: definition.atUtc + SLOT_MS,
      definitionRevision: revision,
      resolution,
      localDate: definition.date,
    })];
  }

  const entries = [];
  const firstDate = localDateString(windowFrom, definition.timeZone);
  const lastDate = localDateString(windowTo, definition.timeZone);
  const dayCeiling = SLOT_LIMITS.maxQuerySpanDays + 2;
  let date = firstDate;
  for (let guard = 0; guard < dayCeiling; guard += 1) {
    if (entries.length >= cap) break;
    if (date > lastDate) break;
    const weekday = isoWeekdayOfDate(date);
    if (definition.rule === 'daily' || definition.weekdays.includes(weekday)) {
      const prefix = definition.rule === 'daily' ? 'd' : 'w';
      const resolved = resolveLocalInstant({ date, time: definition.time, timeZone: definition.timeZone });
      if (!resolved.ok) {
        entries.push(slotEntry({
          slotKey: `${prefix}:${date}`,
          scheduledAt: null,
          slotEndAt: null,
          definitionRevision: revision,
          resolution: 'gap',
          localDate: date,
          skipped: true,
          reason: 'dst-gap',
        }));
      } else if (resolved.at >= windowFrom && resolved.at <= windowTo) {
        entries.push(slotEntry({
          slotKey: `${prefix}:${date}`,
          scheduledAt: resolved.at,
          slotEndAt: resolved.at + SLOT_MS,
          definitionRevision: revision,
          resolution: resolved.resolution,
          localDate: date,
        }));
      }
    }
    date = addLocalDays(date, 1);
  }
  return entries;
}

// ---------------------------------------------------------------- row mapping

function rowToItem(row) {
  if (!row) return null;
  return {
    itemId: row.item_id,
    scopeKey: row.scope,
    revision: Number(row.revision),
    title: row.title,
    category: row.category,
    source: row.source,
    rule: row.rule_kind,
    timeZone: row.time_zone,
    date: row.local_date ?? '',
    time: row.local_time ?? '',
    weekdays: safeJson(row.weekdays, []),
    atUtc: row.at_utc === null || row.at_utc === undefined ? null : Number(row.at_utc),
    validFrom: Number(row.valid_from),
    validUntil: row.valid_until === null || row.valid_until === undefined ? null : Number(row.valid_until),
    status: row.status,
    authorization: row.authorization,
    delivery: row.delivery,
    reminderDelivery: reminderDeliveryFor(row.authorization),
    goalRef: row.goal_ref ?? '',
    commitmentRef: row.commitment_ref ?? '',
    requestKey: row.request_key ?? '',
    resolution: safeJson(row.resolution, {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function rowToOccurrence(row) {
  if (!row) return null;
  return {
    occurrenceId: row.occurrence_id,
    scopeKey: row.scope,
    itemId: row.item_id,
    slotKey: row.slot_key,
    definitionRevision: Number(row.definition_revision),
    scheduledAt: Number(row.scheduled_at),
    slotEndAt: row.slot_end_at === null || row.slot_end_at === undefined ? null : Number(row.slot_end_at),
    status: row.status,
    reasonCode: row.reason_code ?? '',
    revision: Number(row.revision),
    attempts: Number(row.attempts),
    lastError: row.last_error ?? '',
    causationEventId: row.causation_event_id ?? '',
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function itemToDefinitionInput(row) {
  return {
    title: row.title,
    category: row.category,
    source: row.source,
    rule: row.rule_kind,
    timeZone: row.time_zone,
    date: row.local_date ?? '',
    time: row.local_time ?? '',
    weekdays: safeJson(row.weekdays, []),
    validFrom: Number(row.valid_from),
    validUntil: row.valid_until === null || row.valid_until === undefined ? null : Number(row.valid_until),
    authorization: row.authorization,
    goalRef: row.goal_ref ?? '',
    commitmentRef: row.commitment_ref ?? '',
    requestKey: row.request_key ?? '',
  };
}

function resolutionText(definition, at) {
  return JSON.stringify({
    localIntent: definition.resolution.localIntent,
    rule: definition.rule,
    resolution: definition.resolution.resolution,
    resolvedAt: at,
    note: definition.resolution.note,
  });
}

/**
 * A1-B1 frozen delivery mapping: H1 never creates an external reminder, so the stored
 * `delivery` column is always `'none'` (never `'sent'`). A `reminder`-shaped
 * authorization is reported as `reminderDelivery:'not-wired'` on the read path because
 * the existing reminders runner owns every send; everything else is `'n/a'`.
 */
export function reminderDeliveryFor(authorization) {
  return authorization === 'reminder' ? 'not-wired' : 'n/a';
}

function deliveryFor() {
  return 'none';
}

// -------------------------------------------------------------------- queries

export function getAgendaItem(db, scopeKeyValue, itemId) {
  const scope = keyArgument(scopeKeyValue);
  const id = typeof itemId === 'string' ? itemId.trim() : '';
  if (!id) throw new ValidationError('itemId is required');
  return rowToItem(db.get('SELECT * FROM agenda_items WHERE scope = ? AND item_id = ?', scope, id));
}

export function listAgendaItems(db, { scopeKey, status, limit = 64 } = {}) {
  const scope = keyArgument(scopeKey);
  const clauses = ['scope = ?'];
  const params = [scope];
  if (status) {
    if (!AGENDA_ITEM_STATUS.includes(status)) throw new ValidationError(`unknown agenda item status: ${status}`);
    clauses.push('status = ?');
    params.push(status);
  }
  const rows = db.all(`SELECT * FROM agenda_items WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC, item_id ASC LIMIT ?`,
    ...params, limitOf(limit, 64, 500));
  return rows.map(rowToItem);
}

export function listAgendaOccurrences(db, { scopeKey, itemId, from, to, statuses, limit = 200 } = {}) {
  const scope = keyArgument(scopeKey);
  const clauses = ['scope = ?'];
  const params = [scope];
  if (typeof itemId === 'string' && itemId.trim()) {
    clauses.push('item_id = ?');
    params.push(itemId.trim());
  }
  if (Number.isFinite(Number(from))) {
    clauses.push('scheduled_at >= ?');
    params.push(Math.trunc(Number(from)));
  }
  if (Number.isFinite(Number(to))) {
    clauses.push('scheduled_at <= ?');
    params.push(Math.trunc(Number(to)));
  }
  if (Array.isArray(statuses) && statuses.length) {
    for (const status of statuses) {
      if (!OCCURRENCE_STATUS.includes(status)) throw new ValidationError(`unknown occurrence status: ${status}`);
    }
    clauses.push(`status IN (${statuses.map(() => '?').join(',')})`);
    params.push(...statuses);
  }
  const rows = db.all(`SELECT * FROM agenda_occurrences WHERE ${clauses.join(' AND ')}
    ORDER BY scheduled_at ASC, occurrence_id ASC LIMIT ?`, ...params, limitOf(limit, 200, 2000));
  return rows.map(rowToOccurrence);
}

/** Active definitions that are inside their own validity window at `at`. */
export function activeAgendaItems(db, { scopeKey, at, limit = 64 } = {}) {
  const scope = keyArgument(scopeKey);
  const nowMs = Number.isFinite(Number(at)) ? Math.trunc(Number(at)) : Math.trunc(db.now());
  const rows = db.all(`SELECT * FROM agenda_items
    WHERE scope = ? AND status = 'active' AND valid_from <= ? AND (valid_until IS NULL OR valid_until > ?)
    ORDER BY updated_at ASC, item_id ASC LIMIT ?`, scope, nowMs, nowMs, limitOf(limit, 64, 500));
  return rows.map(rowToItem);
}

/** Unsettled occurrences whose instant has arrived, oldest first, then by stable id. */
export function dueAgendaOccurrences(db, { scopeKey, at, limit = 64 } = {}) {
  const scope = keyArgument(scopeKey);
  const nowMs = Number.isFinite(Number(at)) ? Math.trunc(Number(at)) : Math.trunc(db.now());
  const rows = db.all(`SELECT * FROM agenda_occurrences
    WHERE scope = ? AND status IN ('scheduled','due') AND scheduled_at <= ?
    ORDER BY scheduled_at ASC, occurrence_id ASC LIMIT ?`, scope, nowMs, limitOf(limit, 64, 512));
  return rows.map(rowToOccurrence);
}

/**
 * Bounded counters for diagnostics. `scopeKey` may be omitted (whole database) so the
 * runtime status can answer without inventing a scope.
 */
export function agendaCounts(db, scopeKey) {
  const scope = typeof scopeKey === 'string' && scopeKey.trim() ? scopeKey.trim() : '';
  const items = scope
    ? Number(db.get("SELECT COUNT(*) AS n FROM agenda_items WHERE scope = ? AND status = 'active'", scope)?.n ?? 0)
    : Number(db.get("SELECT COUNT(*) AS n FROM agenda_items WHERE status = 'active'")?.n ?? 0);
  const rows = scope
    ? db.all('SELECT status, COUNT(*) AS n FROM agenda_occurrences WHERE scope = ? GROUP BY status', scope)
    : db.all('SELECT status, COUNT(*) AS n FROM agenda_occurrences GROUP BY status');
  const occurrences = { scheduled: 0, due: 0, dispatched: 0, skipped: 0, cancelled: 0, expired: 0 };
  for (const row of rows) {
    if (Object.hasOwn(occurrences, row.status)) occurrences[row.status] = Number(row.n);
  }
  const next = scope
    ? db.get("SELECT MIN(scheduled_at) AS next FROM agenda_occurrences WHERE scope = ? AND status IN ('scheduled','due')", scope)
    : db.get("SELECT MIN(scheduled_at) AS next FROM agenda_occurrences WHERE status IN ('scheduled','due')");
  const nextOccurrenceAt = next?.next === null || next?.next === undefined ? null : Number(next.next);
  return { items, occurrences, nextOccurrenceAt };
}

// ------------------------------------------------------------- reducer helpers

function requireField(payload, field, kind) {
  const value = typeof payload?.[field] === 'string' ? payload[field].trim() : '';
  if (!value) throw new RuntimeError('invalid-payload', `${kind} requires payload.${field}`);
  return value;
}

// A1-B5: a fenced event without a revision is `revision-required`, not a silent write and
// not a generic payload error — the caller must name the revision it read.
function requireRevision(payload, kind) {
  const value = payload?.expectedRevision;
  if (value === undefined || value === null || value === '') {
    throw new RuntimeError('revision-required', `${kind} requires payload.expectedRevision`);
  }
  const number = Number(value);
  if (!Number.isFinite(number)) throw new RuntimeError('revision-required', `${kind} requires a finite payload.expectedRevision`);
  return Math.trunc(number);
}

function requireInstant(value, field, kind) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new RuntimeError('invalid-payload', `${kind} requires a finite payload.${field}`);
  return Math.trunc(number);
}

function readItemRow(db, scope, itemId) {
  return db.get('SELECT * FROM agenda_items WHERE scope = ? AND item_id = ?', scope, itemId);
}

function readOccurrenceRow(db, scope, occurrenceId) {
  return db.get('SELECT * FROM agenda_occurrences WHERE scope = ? AND occurrence_id = ?', scope, occurrenceId);
}

function asDefinition(payload, field, kind, at) {
  const raw = payload?.[field];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RuntimeError('invalid-payload', `${kind} requires payload.${field}`);
  }
  try {
    return normalizeDefinition(raw, { now: at });
  } catch (error) {
    if (error instanceof RuntimeError) {
      throw new RuntimeError('invalid-payload', `${kind} ${field} is invalid: ${error.message}`);
    }
    throw error;
  }
}

function isUniqueViolation(error) {
  return /UNIQUE constraint failed/i.test(error instanceof Error ? error.message : String(error));
}

// ------------------------------------------------------------ reducer: items

function createdKind(db, { payload, scope, at, event }) {
  const definition = asDefinition(payload, 'item', 'agenda/created', at);
  const itemId = requireField(payload.item, 'itemId', 'agenda/created');
  const requestKey = typeof payload.requestKey === 'string' && payload.requestKey.trim()
    ? payload.requestKey.trim().slice(0, REQUEST_KEY_LIMIT)
    : definition.requestKey;
  if (requestKey) {
    const clash = db.get('SELECT item_id FROM agenda_items WHERE scope = ? AND request_key = ?', scope, requestKey);
    if (clash) {
      throw new RuntimeError('duplicate-request', `request key already created ${clash.item_id} in this scope`);
    }
  }
  if (readItemRow(db, scope, itemId)) {
    throw new RuntimeError('duplicate-request', `item ${itemId} already exists in this scope`);
  }
  const revision = Math.max(1, Math.trunc(Number(payload.item.revision ?? 1)) || 1);
  const createdAt = Number.isFinite(Number(payload.item.createdAt)) ? Math.trunc(Number(payload.item.createdAt)) : at;
  const delivery = deliveryFor(definition.authorization);
  try {
    db.run(`INSERT INTO agenda_items (item_id, scope, revision, title, category, source, rule_kind, time_zone,
              local_date, local_time, weekdays, at_utc, valid_from, valid_until, status, authorization, delivery,
              goal_ref, commitment_ref, request_key, resolution, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`,
    itemId, scope, revision, definition.title, definition.category, definition.source, definition.rule,
    definition.timeZone, definition.date, definition.time, JSON.stringify(definition.weekdays), definition.atUtc,
    definition.validFrom, definition.validUntil, definition.authorization, delivery, definition.goalRef,
    definition.commitmentRef, requestKey, resolutionText(definition, at), createdAt, at);
  } catch (error) {
    if (isUniqueViolation(error)) throw new RuntimeError('duplicate-request', 'request key already used in this scope');
    throw error;
  }
  return {
    itemId,
    occurrenceId: '',
    result: {
      action: 'created',
      itemId,
      revision,
      status: 'active',
      rule: definition.rule,
      delivery,
      causationEventId: event.eventId,
    },
  };
}

function updatedKind(db, { payload, scope, at, event }) {
  const itemId = requireField(payload, 'itemId', 'agenda/updated');
  const expectedRevision = requireRevision(payload, 'agenda/updated');
  const row = readItemRow(db, scope, itemId);
  if (!row) throw new RuntimeError('item-not-found', `item ${itemId} is not in this scope`);
  // The fence comes first: a stale event must fail before any "nothing changes" path.
  if (Number(row.revision) !== expectedRevision) {
    throw new RuntimeError('stale-revision', `item ${itemId} expected revision ${expectedRevision}, current ${row.revision}`);
  }
  if (TERMINAL_ITEM.has(row.status)) throw new RuntimeError('terminal-item', `item ${itemId} is ${row.status}`);
  const patch = payload.patch && typeof payload.patch === 'object' && !Array.isArray(payload.patch) ? payload.patch : {};
  const keys = Object.keys(patch);
  for (const key of keys) {
    if (!PATCH_KEYS.has(key)) throw new RuntimeError('invalid-payload', `patch field is not updatable: ${key}`);
  }
  const merged = itemToDefinitionInput(row);
  for (const key of keys) {
    // `atUtc`/`resolution` are derived from the local intent; a patch may name them but
    // they are always recomputed, never trusted.
    if (key === 'atUtc' || key === 'resolution') continue;
    merged[key] = patch[key];
  }
  const definition = asDefinition({ item: merged }, 'item', 'agenda/updated', at);
  const requested = Number(payload.nextRevision);
  const nextRevision = Number.isFinite(requested) ? Math.trunc(requested) : Number(row.revision) + 1;
  const revision = Math.max(Number(row.revision) + 1, nextRevision);
  const updatedAt = Number.isFinite(Number(payload.updatedAt)) ? Math.trunc(Number(payload.updatedAt)) : at;
  const delivery = deliveryFor(definition.authorization);
  db.run(`UPDATE agenda_items SET revision = ?, title = ?, category = ?, source = ?, rule_kind = ?, time_zone = ?,
            local_date = ?, local_time = ?, weekdays = ?, at_utc = ?, valid_from = ?, valid_until = ?, authorization = ?,
            delivery = ?, goal_ref = ?, commitment_ref = ?, resolution = ?, updated_at = ?
          WHERE scope = ? AND item_id = ?`,
  revision, definition.title, definition.category, definition.source, definition.rule, definition.timeZone,
  definition.date, definition.time, JSON.stringify(definition.weekdays), definition.atUtc, definition.validFrom,
  definition.validUntil, definition.authorization, delivery, definition.goalRef, definition.commitmentRef,
  resolutionText(definition, at), updatedAt, scope, itemId);
  return {
    itemId,
    occurrenceId: '',
    result: {
      action: 'updated',
      itemId,
      revision,
      status: row.status,
      changed: keys.length,
      rule: definition.rule,
      delivery,
      causationEventId: event.eventId,
    },
  };
}

function cancelledKind(db, { payload, scope, at, event }) {
  const itemId = requireField(payload, 'itemId', 'agenda/cancelled');
  const expectedRevision = requireRevision(payload, 'agenda/cancelled');
  const row = readItemRow(db, scope, itemId);
  if (!row) throw new RuntimeError('item-not-found', `item ${itemId} is not in this scope`);
  if (Number(row.revision) !== expectedRevision) {
    throw new RuntimeError('stale-revision', `item ${itemId} expected revision ${expectedRevision}, current ${row.revision}`);
  }
  const reason = code(payload.reason ?? 'definition-cancelled') || 'definition-cancelled';
  if (row.status === 'expired') throw new RuntimeError('terminal-item', `item ${itemId} is expired`);
  if (row.status === 'cancelled') {
    return { itemId, occurrenceId: '', result: { action: 'kept', itemId, revision: Number(row.revision), status: 'cancelled', cancelledOccurrences: 0 } };
  }
  const nowMs = Number.isFinite(Number(payload.now)) ? Math.trunc(Number(payload.now)) : at;
  const revision = Number(row.revision) + 1;
  db.run("UPDATE agenda_items SET status = 'cancelled', revision = ?, updated_at = ? WHERE scope = ? AND item_id = ?",
    revision, at, scope, itemId);
  // A1-B1: cancel every future, not-yet-executed `scheduled` occurrence **and** every
  // live `due` occurrence of this definition in the same transaction. A cancelled plan
  // must not leave due ghosts holding the backlog; history (dispatched/skipped/expired/
  // cancelled, or a scheduled instant already reached) is never rewritten.
  const cancelled = db.run(`UPDATE agenda_occurrences
      SET status = 'cancelled', reason_code = 'definition-cancelled', revision = revision + 1, updated_at = ?
      WHERE scope = ? AND item_id = ?
        AND (status = 'due' OR (status = 'scheduled' AND scheduled_at > ?))`,
  at, scope, itemId, nowMs);
  return {
    itemId,
    occurrenceId: '',
    result: {
      action: 'cancelled',
      itemId,
      revision,
      status: 'cancelled',
      reason,
      cancelledOccurrences: Number(cancelled?.changes ?? 0),
      causationEventId: event.eventId,
    },
  };
}

// ------------------------------------------------------ reducer: occurrences

function generatedKind(db, { payload, scope, at, event }) {
  const itemId = requireField(payload, 'itemId', 'agenda/occurrence-generated');
  const slotKey = requireField(payload, 'slotKey', 'agenda/occurrence-generated');
  const scheduledAt = requireInstant(payload.scheduledAt, 'scheduledAt', 'agenda/occurrence-generated');
  const slotEndAt = payload.slotEndAt === undefined || payload.slotEndAt === null
    ? scheduledAt + SLOT_MS
    : requireInstant(payload.slotEndAt, 'slotEndAt', 'agenda/occurrence-generated');
  const definitionRevision = Math.max(1, Math.trunc(Number(payload.definitionRevision ?? 1)) || 1);
  const occurrenceId = typeof payload.occurrenceId === 'string' && payload.occurrenceId.trim()
    ? payload.occurrenceId.trim()
    : occurrenceIdFor(scope, itemId, slotKey);
  const item = readItemRow(db, scope, itemId);
  if (!item) throw new RuntimeError('item-not-found', `item ${itemId} is not in this scope`);
  if (item.status !== 'active') {
    throw new RuntimeError('terminal-item', `item ${itemId} is ${item.status}; a new slot cannot be generated`);
  }
  const existing = db.get('SELECT * FROM agenda_occurrences WHERE scope = ? AND item_id = ? AND slot_key = ?', scope, itemId, slotKey);
  if (existing) {
    if (TERMINAL_OCCURRENCE.has(existing.status)) {
      throw new RuntimeError('slot-terminal', `slot ${slotKey} is ${existing.status}; it is never revived`);
    }
    if (Number(existing.scheduled_at) === scheduledAt) {
      // A1-B3: re-planning the same window is normal, so a same-slot/same-instant
      // generation is an idempotent success that writes nothing. Throwing here used to
      // roll the whole per-scope transaction back and block the cursor forever.
      return {
        itemId,
        occurrenceId: existing.occurrence_id,
        result: {
          action: 'generated',
          duplicate: true,
          occurrenceId: existing.occurrence_id,
          itemId,
          slotKey,
          status: existing.status,
          revision: Number(existing.revision),
          scheduledAt: Number(existing.scheduled_at),
          definitionRevision: Number(existing.definition_revision),
        },
      };
    }
    throw new RuntimeError('reschedule-required', `slot ${slotKey} is at ${Number(existing.scheduled_at)}, not ${scheduledAt}`);
  }
  if (readOccurrenceRow(db, scope, occurrenceId)) {
    return {
      itemId,
      occurrenceId,
      result: { action: 'generated', duplicate: true, occurrenceId, itemId, slotKey, status: 'scheduled', revision: 1, scheduledAt },
    };
  }
  try {
    db.run(`INSERT INTO agenda_occurrences (occurrence_id, scope, item_id, slot_key, definition_revision, scheduled_at,
              slot_end_at, status, reason_code, revision, attempts, last_error, causation_event_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', '', 1, 0, '', ?, ?, ?)`,
    occurrenceId, scope, itemId, slotKey, definitionRevision, scheduledAt, slotEndAt, event.eventId, at, at);
  } catch (error) {
    if (isUniqueViolation(error)) {
      // Same-slot insertion lost a race inside this transaction: treat it as the
      // idempotent success it is, never as a reason to abort the scope.
      const raced = db.get('SELECT * FROM agenda_occurrences WHERE scope = ? AND item_id = ? AND slot_key = ?', scope, itemId, slotKey);
      if (raced && Number(raced.scheduled_at) === scheduledAt) {
        return {
          itemId,
          occurrenceId: raced.occurrence_id,
          result: { action: 'generated', duplicate: true, occurrenceId: raced.occurrence_id, itemId, slotKey, status: raced.status, revision: Number(raced.revision), scheduledAt },
        };
      }
      throw new RuntimeError('reschedule-required', `slot ${slotKey} is already materialised at a different instant`);
    }
    throw error;
  }
  return {
    itemId,
    occurrenceId,
    result: { action: 'generated', occurrenceId, itemId, slotKey, status: 'scheduled', revision: 1, scheduledAt, definitionRevision },
  };
}

function rescheduledKind(db, { payload, scope, at, event }) {
  const occurrenceId = requireField(payload, 'occurrenceId', 'agenda/occurrence-rescheduled');
  const row = readOccurrenceRow(db, scope, occurrenceId);
  if (!row) throw new RuntimeError('occurrence-not-found', `occurrence ${occurrenceId} is not in this scope`);
  // Transition first, then the fence (CONTRACT §12.3: only `scheduled` is reschedulable).
  if (row.status !== 'scheduled') {
    throw new RuntimeError('invalid-transition', `${row.status} → rescheduled is not allowed`);
  }
  const expectedRevision = requireRevision(payload, 'agenda/occurrence-rescheduled');
  if (Number(row.revision) !== expectedRevision) {
    throw new RuntimeError('stale-revision', `occurrence ${occurrenceId} expected revision ${expectedRevision}, current ${row.revision}`);
  }
  const scheduledAt = requireInstant(payload.scheduledAt, 'scheduledAt', 'agenda/occurrence-rescheduled');
  const slotEndAt = payload.slotEndAt === undefined || payload.slotEndAt === null
    ? scheduledAt + SLOT_MS
    : requireInstant(payload.slotEndAt, 'slotEndAt', 'agenda/occurrence-rescheduled');
  const definitionRevision = Math.max(1, Math.trunc(Number(payload.definitionRevision ?? row.definition_revision)) || 1);
  const revision = Number(row.revision) + 1;
  db.run(`UPDATE agenda_occurrences SET scheduled_at = ?, slot_end_at = ?, definition_revision = ?, revision = ?,
            reason_code = ?, updated_at = ? WHERE scope = ? AND occurrence_id = ?`,
  scheduledAt, slotEndAt, definitionRevision, revision, code(payload.reason), at, scope, occurrenceId);
  return {
    itemId: row.item_id,
    occurrenceId,
    result: { action: 'rescheduled', occurrenceId, itemId: row.item_id, status: 'scheduled', revision, scheduledAt, definitionRevision },
  };
}

function occurrenceStateKind(db, { kind, payload, scope, at, event }) {
  const target = OCCURRENCE_TARGET[kind];
  const occurrenceId = requireField(payload, 'occurrenceId', kind);
  const row = readOccurrenceRow(db, scope, occurrenceId);
  if (!row) throw new RuntimeError('occurrence-not-found', `occurrence ${occurrenceId} is not in this scope`);
  const expectedRevision = requireRevision(payload, kind);
  if (Number(row.revision) !== expectedRevision) {
    throw new RuntimeError('stale-revision', `occurrence ${occurrenceId} expected revision ${expectedRevision}, current ${row.revision}`);
  }
  if (!target.from.includes(row.status)) {
    throw new RuntimeError('invalid-transition', `${row.status} → ${target.status} is not allowed`);
  }
  let reasonCode = code(payload.reasonCode ?? payload.reason);
  if (kind === 'agenda/occurrence-dispatched') {
    const consumer = code(payload.consumer, 60);
    if (!consumer) {
      // No activity consumer is wired in this round (CONTRACT §12.5.4): `dispatched`
      // may never be claimed without one, and never becomes `completed`.
      throw new RuntimeError('invalid-payload', 'agenda/occurrence-dispatched requires payload.consumer; no activity consumer is wired');
    }
    reasonCode = consumer;
  }
  const revision = Number(row.revision) + 1;
  db.run(`UPDATE agenda_occurrences SET status = ?, reason_code = ?, revision = ?, updated_at = ?
          WHERE scope = ? AND occurrence_id = ?`,
  target.status, reasonCode, revision, at, scope, occurrenceId);
  return {
    itemId: row.item_id,
    occurrenceId,
    result: {
      action: target.status,
      occurrenceId,
      itemId: row.item_id,
      status: target.status,
      revision,
      reasonCode,
      causationEventId: event.eventId,
    },
  };
}

function applyAgendaKind(db, { event, kind, payload, scope, at }) {
  switch (kind) {
    case 'agenda/created': return createdKind(db, { payload, scope, at, event });
    case 'agenda/updated': return updatedKind(db, { payload, scope, at, event });
    case 'agenda/cancelled': return cancelledKind(db, { payload, scope, at, event });
    case 'agenda/occurrence-generated': return generatedKind(db, { payload, scope, at, event });
    case 'agenda/occurrence-rescheduled': return rescheduledKind(db, { payload, scope, at, event });
    case 'agenda/occurrence-due':
    case 'agenda/occurrence-dispatched':
    case 'agenda/occurrence-skipped':
    case 'agenda/occurrence-expired':
    case 'agenda/occurrence-cancelled':
      return occurrenceStateKind(db, { kind, payload, scope, at, event });
    default:
      throw new RuntimeError('invalid-payload', `agenda consumer does not handle ${kind}`);
  }
}

/**
 * Authoritative reducer for every `agenda/*` kind (CONTRACT §12.3).
 *
 * Returns `{ slice, result, extra }`: `extra` performs the relational writes inside the
 * caller's transaction, `slice` is a bounded counter projection, and `result` carries
 * ids, versions, statuses and reason codes only — never a title or other private text.
 *
 * Scope comes from `event.scopeKey` and nowhere else: a `userId`/`scopeKey` inside the
 * payload is inert (HH04). Deterministic refusals throw `RuntimeError` with the frozen
 * codes so `events.mjs` vetoes and rolls back the whole event.
 *
 * A1-B2: the instant this reducer writes is always derived from the event itself
 * (`now` is the event's `occurredAt`) or from the payload, **never** from a wall clock.
 * A non-deterministic `occurredAt` would change the content-addressed `eventId` on a
 * retry, so the retry would append a second event instead of topping up the receipt.
 */
export function applyAgendaEvent({ db, event, slice, now } = {}) {
  const kind = typeof event?.kind === 'string' ? event.kind : '';
  if (!CONSUMERS.agenda.includes(kind)) return {};
  const scope = typeof event.scopeKey === 'string' && event.scopeKey
    ? event.scopeKey
    : keyOf(normalizeScope(event.scope));
  const at = eventInstant(now, event);
  const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
  const previous = slice && typeof slice === 'object' ? slice : {};
  const next = { ...previous };
  const result = {};
  const extra = (database) => {
    const outcome = applyAgendaKind(database, { event, kind, payload, scope, at });
    const counts = agendaCounts(database, scope);
    Object.assign(next, {
      revision: Number(previous.revision ?? 0) + 1,
      items: counts.items,
      occurrences: counts.occurrences,
      nextOccurrenceAt: counts.nextOccurrenceAt,
      updatedAt: at,
      lastAction: kind,
      lastEventId: event.eventId,
      lastItemId: outcome.itemId ?? previous.lastItemId ?? '',
      lastOccurrenceId: outcome.occurrenceId ?? previous.lastOccurrenceId ?? '',
    });
    Object.assign(result, outcome.result);
  };
  return { slice: next, result, extra };
}

export { SLICE as AGENDA_SLICE };
