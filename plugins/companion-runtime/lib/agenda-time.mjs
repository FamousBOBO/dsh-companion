// Pure local-time arithmetic for the H1 agenda (CONTRACT §12.4, HH06).
//
// Deliberately dependency-free: no IO, no database, no clock of its own. Every
// function is a pure function of its arguments, so planning a window twice (or
// replaying it a week later) produces the same instants. Nothing here ever falls
// back to a default zone: an unknown IANA name is an error the caller must surface.
//
// The DST rules are the interesting part. A wall clock either exists once (exact),
// does not exist at all (gap: spring forward) or exists twice (fold: fall back). The
// contract says a gap slot is skipped and a fold slot takes the *earlier* UTC instant,
// and both decisions have to be reproducible from the definition alone.

const MS_PER_MINUTE = 60000;
const MS_PER_DAY = 86400000;
const FORMATTER_LIMIT = 64;
const ZONE_SHAPE = /^[A-Za-z][A-Za-z0-9_+\-/]*$/;

const formatters = new Map();

function pad2(value) {
  return String(Math.trunc(value)).padStart(2, '0');
}

function assertZone(timeZone) {
  if (typeof timeZone !== 'string') throw new RangeError('invalid-timezone: a time zone string is required');
  const value = timeZone.trim();
  if (!value || !ZONE_SHAPE.test(value) || !isValidTimeZone(value)) {
    throw new RangeError(`invalid-timezone: ${String(timeZone)}`);
  }
  return value;
}

function formatterFor(timeZone) {
  let formatter = formatters.get(timeZone);
  if (formatter) return formatter;
  formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  if (formatters.size >= FORMATTER_LIMIT) formatters.clear();
  formatters.set(timeZone, formatter);
  return formatter;
}

// ------------------------------------------------------------------ civil dates
// Proleptic Gregorian day arithmetic, independent of `Date` and of the host zone.
// `epochDay` is the number of days since 1970-01-01 (Howard Hinnant's algorithm).

function epochDayFromCivil(year, month, day) {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (month + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromEpochDay(epochDay) {
  const shifted = epochDay + 719468;
  const era = Math.floor(shifted / 146097);
  const doe = shifted - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return { year: month <= 2 ? y + 1 : y, month, day };
}

function isoWeekdayFromEpochDay(epochDay) {
  // 1970-01-01 was a Thursday (ISO 4).
  return ((epochDay + 3) % 7 + 7) % 7 + 1;
}

function formatCivil({ year, month, day }) {
  return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
}

/** `'YYYY-MM-DD'` → `{year, month, day}`; `null` when it is not a real calendar date. */
export function parseLocalDate(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const civil = civilFromEpochDay(epochDayFromCivil(year, month, day));
  if (civil.year !== year || civil.month !== month || civil.day !== day) return null;
  return { year, month, day };
}

export function isValidLocalDate(value) {
  return parseLocalDate(value) !== null;
}

/** `'HH:MM'` (one- or two-digit hour accepted) → `'HH:MM'`; `''` when it is not a wall time. */
export function normalizeLocalTime(value) {
  if (typeof value !== 'string') return '';
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return '';
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return '';
  return `${pad2(hour)}:${pad2(minute)}`;
}

export function isValidLocalTime(value) {
  return normalizeLocalTime(value) !== '';
}

/** ISO weekday of a calendar date string: 1=Mon … 7=Sun. */
export function isoWeekdayOfDate(value) {
  const civil = parseLocalDate(value);
  if (!civil) throw new RangeError(`invalid local date: ${String(value)}`);
  return isoWeekdayFromEpochDay(epochDayFromCivil(civil.year, civil.month, civil.day));
}

// ------------------------------------------------------------------- time zones

/** True only for a zone `Intl` accepts; an unknown name is `false`, never a default. */
export function isValidTimeZone(timeZone) {
  if (typeof timeZone !== 'string') return false;
  const value = timeZone.trim();
  if (!value || value.length > 64 || !ZONE_SHAPE.test(value)) return false;
  try {
    formatterFor(value);
    return true;
  } catch {
    return false;
  }
}

/** The local wall clock of `at` in `timeZone`. */
export function localParts(at, timeZone) {
  const ms = Number(at);
  if (!Number.isFinite(ms)) throw new RangeError('localParts requires a finite epoch millisecond');
  const parts = formatterFor(assertZone(timeZone)).formatToParts(new Date(Math.trunc(ms)));
  const pick = (type) => {
    const found = parts.find(part => part.type === type);
    return found ? Number(found.value) : 0;
  };
  const year = pick('year');
  const month = pick('month');
  const day = pick('day');
  // Some ICU builds render midnight as 24:00 under h23; normalise it to 00:00.
  const hour = pick('hour') % 24;
  return Object.freeze({
    year,
    month,
    day,
    hour,
    minute: pick('minute'),
    second: pick('second'),
    isoWeekday: isoWeekdayFromEpochDay(epochDayFromCivil(year, month, day)),
  });
}

/** The local calendar date of `at` in `timeZone` as `'YYYY-MM-DD'`. */
export function localDateString(at, timeZone) {
  const parts = localParts(at, timeZone);
  return formatCivil(parts);
}

/** Zone offset in minutes at that instant (local minus UTC; +480 for Asia/Shanghai). */
export function offsetMinutesAt(at, timeZone) {
  const ms = Number(at);
  if (!Number.isFinite(ms)) throw new RangeError('offsetMinutesAt requires a finite epoch millisecond');
  const parts = localParts(ms, timeZone);
  const wallAsUtc = epochDayFromCivil(parts.year, parts.month, parts.day) * MS_PER_DAY
    + ((parts.hour * 60 + parts.minute) * 60 + parts.second) * 1000;
  const wholeSecond = Math.floor(ms / 1000) * 1000;
  return Math.round((wallAsUtc - wholeSecond) / MS_PER_MINUTE);
}

// -------------------------------------------------------------- local → instant

function wallClockOf(at, timeZone) {
  const parts = localParts(at, timeZone);
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute };
}

function sameWall(a, b) {
  return a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute;
}

/**
 * Resolve one local wall clock to a UTC instant.
 *
 *   { ok:true, at, resolution:'exact'|'fold', intent:{date,time,zone} }
 *   { ok:false, at:null, resolution:'gap', intent:{date,time,zone} }
 *
 * A fold resolves to the **earlier** instant and reports `'fold'`; a gap resolves to
 * nothing at all and reports `'gap'` so the caller can skip the slot instead of
 * inventing a time. Both are decided from the zone's own offsets, never guessed.
 */
export function resolveLocalInstant({ date, time, timeZone } = {}) {
  const zone = assertZone(timeZone);
  const civil = parseLocalDate(date);
  if (!civil) throw new RangeError(`invalid local date: ${String(date)}`);
  const wall = normalizeLocalTime(time);
  if (!wall) throw new RangeError(`invalid time: ${String(time)}`);
  const [hour, minute] = wall.split(':').map(Number);
  const intent = Object.freeze({ date: formatCivil(civil), time: wall, zone });

  // The wall clock read as if it were UTC: the starting point of every candidate.
  const guess = epochDayFromCivil(civil.year, civil.month, civil.day) * MS_PER_DAY
    + (hour * 60 + minute) * MS_PER_MINUTE;

  // Collect every zone offset that could apply to this wall clock. A DST transition
  // sits within ±14h of the naive guess, so probing the guess, the first corrected
  // instant and that instant ±30h always sees both sides of the transition.
  const offsets = new Set();
  const probe = (at) => { offsets.add(offsetMinutesAt(at, zone)); };
  probe(guess);
  const firstGuessOffset = offsetMinutesAt(guess, zone);
  const firstGuess = guess - firstGuessOffset * MS_PER_MINUTE;
  probe(firstGuess);
  probe(firstGuess - 30 * 3600000);
  probe(firstGuess + 30 * 3600000);

  const candidates = [];
  for (const offset of offsets) {
    const at = guess - offset * MS_PER_MINUTE;
    if (sameWall(wallClockOf(at, zone), { ...civil, hour, minute })) candidates.push(at);
  }
  if (!candidates.length) return Object.freeze({ ok: false, at: null, resolution: 'gap', intent });
  candidates.sort((left, right) => left - right);
  return Object.freeze({
    ok: true,
    at: candidates[0],
    resolution: candidates.length > 1 ? 'fold' : 'exact',
    intent,
  });
}

/** Pure calendar arithmetic on a local date string; no zone, no DST, no month overflow. */
export function addLocalDays(dateString, days) {
  const civil = parseLocalDate(dateString);
  if (!civil) throw new RangeError(`invalid local date: ${String(dateString)}`);
  const count = Math.trunc(Number(days));
  if (!Number.isFinite(count)) throw new RangeError('addLocalDays requires a finite day count');
  const next = civilFromEpochDay(epochDayFromCivil(civil.year, civil.month, civil.day) + count);
  return formatCivil(next);
}

/**
 * The first instant of the local day that contains `at`. Used as the deterministic
 * default `validFrom`: a retry on the same local day keeps the same window instead of
 * drifting with the wall clock. A zone whose local midnight is skipped by a DST gap
 * starts at the transition, so the first existing wall time wins.
 */
export function startOfLocalDay(at, timeZone) {
  const ms = Number(at);
  if (!Number.isFinite(ms)) throw new RangeError('startOfLocalDay requires a finite epoch millisecond');
  const date = localDateString(ms, timeZone);
  for (const time of ['00:00', '01:00', '02:00', '03:00']) {
    const resolved = resolveLocalInstant({ date, time, timeZone });
    if (resolved.ok) return resolved.at;
  }
  return Math.trunc(ms);
}

export const AGENDA_TIME_MS = Object.freeze({ minute: MS_PER_MINUTE, day: MS_PER_DAY, hour: 3600000 });
