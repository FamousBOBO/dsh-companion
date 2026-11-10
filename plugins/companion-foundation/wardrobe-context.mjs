/** Time-and-life classification for the wardrobe: which scene is the character in *now*.
 *
 * This module answers exactly one question — "given a trustworthy clock and the
 * *currently happening* activity/schedule, which of everyday / home / sleep / outdoor /
 * special applies?" — and it answers it in code, never by asking a model. That is a
 * deliberate boundary from the task brief (§5): the LLM must not be the thing that
 * maintains a wardrobe state machine, because then the state would drift every turn.
 *
 * Two rules matter more than the keyword lists:
 *
 *  1. **A plan is not an occurrence.** `companion_schedule_*` rows and P2 plan slots are
 *     plans. Only an interval that contains *now*, and whose status is not terminal,
 *     counts as evidence of what is happening. A slot scheduled for 20:00 does not put
 *     her in outdoor clothes at 09:00, and a `planned` row does not mean it happened.
 *  2. **The window is local and crosses midnight.** 22:30–07:00 means
 *     `[22:30,24:00) ∪ [00:00,07:00)`, computed from the runtime's real time zone, not
 *     from an offset baked into the source.
 */
import fs from 'node:fs';
import path from 'node:path';
import { WARDROBE_CONTEXTS } from './wardrobe-schema.mjs';

export const DEFAULT_WARDROBE_CONFIG = Object.freeze({
  timeZone: 'Asia/Shanghai',
  nightWindow: Object.freeze({ enabled: true, start: '22:30', end: '07:00' }),
  eveningFrom: '19:00',
  outdoorKeywords: Object.freeze(['出门', '外出', '上班', '上学', '买菜', '散步', '约会', '医院', '旅行', '去到', '逛街', '通勤']),
  sleepKeywords: Object.freeze(['准备睡', '睡前', '洗澡', '换睡衣', '洗漱', '躺下', '关灯']),
  specialKeywords: Object.freeze(['演出', '生日', '节日', '正装', '拍照活动', '聚会', '仪式']),
  indoorActivityKinds: Object.freeze(['read', 'write', 'explore', 'bilibili']),
});

export function wardrobeConfigFile(root) {
  return path.join(root, 'home/companion/wardrobe.config.json');
}

function hhmm(value, fallback) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value ?? '').trim());
  return match ? match[0] : fallback;
}

function keywordList(value, fallback) {
  const rows = Array.isArray(value) ? value : [];
  const clean = [...new Set(rows.map(row => String(row ?? '').trim()).filter(Boolean))].slice(0, 40);
  return clean.length ? clean : [...fallback];
}

function zoneName(value, fallback) {
  const candidate = String(value ?? '').trim();
  if (!candidate) return fallback;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return fallback;
  }
}

/**
 * Read `<root>/home/companion/wardrobe.config.json`, falling back to the built-in
 * defaults. **Read-only**: a missing or broken file never gets rewritten, so the
 * documented defaults stay documented instead of quietly becoming "the file".
 */
export function loadWardrobeConfig(root, { timeZone = '' } = {}) {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(wardrobeConfigFile(root), 'utf8').replace(/^\uFEFF/, '')) ?? {};
  } catch {
    raw = {};
  }
  const zone = zoneName(timeZone, zoneName(raw.timeZone, DEFAULT_WARDROBE_CONFIG.timeZone));
  const night = raw.nightWindow && typeof raw.nightWindow === 'object' ? raw.nightWindow : {};
  return {
    timeZone: zone,
    source: Object.keys(raw).length ? wardrobeConfigFile(root) : 'built-in-default',
    nightWindow: {
      enabled: night.enabled !== false,
      start: hhmm(night.start, DEFAULT_WARDROBE_CONFIG.nightWindow.start),
      end: hhmm(night.end, DEFAULT_WARDROBE_CONFIG.nightWindow.end),
    },
    eveningFrom: hhmm(raw.eveningFrom, DEFAULT_WARDROBE_CONFIG.eveningFrom),
    outdoorKeywords: keywordList(raw.outdoorKeywords, DEFAULT_WARDROBE_CONFIG.outdoorKeywords),
    sleepKeywords: keywordList(raw.sleepKeywords, DEFAULT_WARDROBE_CONFIG.sleepKeywords),
    specialKeywords: keywordList(raw.specialKeywords, DEFAULT_WARDROBE_CONFIG.specialKeywords),
    indoorActivityKinds: keywordList(raw.indoorActivityKinds, DEFAULT_WARDROBE_CONFIG.indoorActivityKinds),
  };
}

function minutesOfDay(hhmmValue) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(hhmmValue ?? ''));
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Local date + minute-of-day in the configured zone. `null` when the zone is unusable. */
export function zoneClock(now, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(new Date(now));
    const pick = type => parts.find(part => part.type === type)?.value ?? '';
    const date = `${pick('year')}-${pick('month')}-${pick('day')}`;
    return { date, minutes: Number(pick('hour')) * 60 + Number(pick('minute')), label: `${pick('hour')}:${pick('minute')}` };
  } catch {
    const at = new Date(now);
    return {
      date: at.toISOString().slice(0, 10),
      minutes: at.getUTCHours() * 60 + at.getUTCMinutes(),
      label: `${String(at.getUTCHours()).padStart(2, '0')}:${String(at.getUTCMinutes()).padStart(2, '0')}`,
    };
  }
}

/**
 * Is `minutes` inside `[start, end)` local? A start greater than the end means the
 * window crosses midnight, which is the normal case for a night window.
 */
export function inWindow(minutes, start, end) {
  const from = minutesOfDay(start);
  const to = minutesOfDay(end);
  if (from === null || to === null || !Number.isFinite(minutes)) return false;
  if (from === to) return false;
  return from < to ? (minutes >= from && minutes < to) : (minutes >= from || minutes < to);
}

function textOf(entry) {
  if (!entry || typeof entry !== 'object') return '';
  return [entry.title, entry.detail, entry.activity, entry.kind, entry.context, entry.note]
    .map(value => String(value ?? '')).join(' ').toLowerCase();
}

function hits(text, keywords) {
  if (!text) return false;
  return keywords.some(keyword => text.includes(String(keyword).toLowerCase()));
}

/**
 * The *currently happening* activity, or `null`.
 *
 * Deliberately strict: an entry with a terminal status is not happening. The list covers
 * both vocabularies that reach this function — the P2 activity lifecycle
 * (`running`/`paused`/`done`/`failed`) and the H1 agenda occurrence lifecycle
 * (`scheduled`/`due`/`dispatched`/`skipped`/`cancelled`/`expired`, where `dispatched` is
 * terminal: it means the occurrence was already handed off, i.e. it is history). An entry
 * whose interval does not contain `now` is not happening either, and a missing interval is
 * **not evidence** — "no window" is unknown, and unknown must never be promoted to a fact
 * about what she is doing.
 */
export const TERMINAL_STATUSES = Object.freeze([
  'done', 'completed', 'finished', 'skipped', 'cancelled', 'canceled', 'expired', 'failed',
  'superseded', 'dispatched', 'abandoned',
]);

export function activeEntry(entry, now) {
  if (!entry || typeof entry !== 'object') return null;
  const status = String(entry.status ?? '').toLowerCase();
  if (TERMINAL_STATUSES.includes(status)) return null;
  const start = Number(entry.startAt ?? entry.start_at ?? entry.startedAt ?? NaN);
  const end = Number(entry.endAt ?? entry.end_at ?? entry.endedAt ?? NaN);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (now < start || now >= end) return null;
  return entry;
}

/**
 * Classify the current context. Pure: every input is explicit, `Date.now()` is only the
 * caller's default.
 *
 * The order is the contract's (§3.3) and the reasons are returned so a report can say
 * *why* she is in sleepwear instead of asserting it.
 */
export function classifyContext({
  now = Date.now(),
  config = DEFAULT_WARDROBE_CONFIG,
  activity = null,
  schedule = null,
  explicit = null,
} = {}) {
  const zone = config.timeZone ?? DEFAULT_WARDROBE_CONFIG.timeZone;
  const clock = zoneClock(now, zone);
  const reasons = [];
  const night = config.nightWindow ?? DEFAULT_WARDROBE_CONFIG.nightWindow;
  const nightActive = night.enabled !== false && inWindow(clock.minutes, night.start, night.end);
  const currentActivity = activeEntry(activity, now);
  const currentSchedule = activeEntry(schedule, now);
  const activityText = textOf(currentActivity);
  const scheduleText = textOf(currentSchedule);

  const finish = (context, reason, notes = []) => ({
    context,
    reason,
    // `reasons` is the decision chain, newest last. `reason` is already the last link, so it
    // is not appended twice: a duplicated tail would read like two independent findings.
    reasons: reason === reasons[reasons.length - 1] ? [...reasons] : [...reasons, reason],
    clock,
    nightWindow: { ...night, timeZone: zone },
    nightActive,
    activity: currentActivity,
    schedule: currentSchedule,
    notes,
  });

  // 1. What the current turn explicitly asked for beats everything else.
  const explicitContext = typeof explicit === 'string'
    ? explicit
    : (explicit && typeof explicit === 'object' ? String(explicit.context ?? '') : '');
  if (explicitContext && WARDROBE_CONTEXTS.includes(explicitContext)) {
    reasons.push('explicit');
    return finish(explicitContext, 'explicit-turn');
  }

  // 2/3/4. Keyword evidence from the activity that is actually running, and from a
  // schedule occurrence whose window contains now. Only then do clocks matter.
  if (hits(activityText, config.specialKeywords)) { reasons.push('activity-special'); return finish('special', 'activity-special'); }
  if (hits(scheduleText, config.specialKeywords)) { reasons.push('schedule-special'); return finish('special', 'schedule-special'); }
  if (hits(activityText, config.outdoorKeywords)) { reasons.push('activity-outdoor'); return finish('outdoor', 'activity-outdoor'); }
  if (hits(scheduleText, config.outdoorKeywords)) { reasons.push('schedule-outdoor'); return finish('outdoor', 'schedule-outdoor'); }
  if (hits(activityText, config.sleepKeywords)) { reasons.push('activity-sleep'); return finish('sleep', 'activity-sleep'); }

  // 5. The configured night window. This is the only source of "sleepwear at 02:40" and
  // it is a statement about clothes, not about sleep having happened.
  if (nightActive) { reasons.push('night-window'); return finish('sleep', 'night-window'); }

  // 6. Evening at home, before the night window.
  if (clock.minutes >= (minutesOfDay(config.eveningFrom) ?? 19 * 60)) { reasons.push('evening-home'); return finish('home', 'evening-home'); }

  // 7. Something indoor and identical to a known adapter kind is running.
  const activityKind = String(currentActivity?.activity ?? currentActivity?.kind ?? '').toLowerCase();
  if (activityKind && config.indoorActivityKinds.includes(activityKind)) {
    reasons.push('activity-home');
    return finish('home', 'activity-home');
  }

  // 8. Daytime with no other evidence.
  reasons.push('daytime-everyday');
  return finish('everyday', 'daytime-everyday');
}

export const WARDROBE_CONTEXT_TEXT = Object.freeze({
  everyday: '日常常服',
  home: '居家服',
  sleep: '睡衣',
  outdoor: '外出服',
  special: '特殊服装',
});
