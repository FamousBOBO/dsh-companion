import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { openRuntimeDb } from '../lib/db.mjs';
import { appendEvent } from '../lib/events.mjs';
import { scopeKey as keyOfScope } from '../lib/scope.mjs';
import { createHeartbeat, HEARTBEAT_CONSUMER } from '../lib/heartbeat.mjs';

// HH10 — clock jumps and cancellation interleaving. A forward jump settles in bounded
// ranges; a backward jump never rewinds `settled_until` and never regenerates history;
// an instance cancelled between the due query and the dispatch is never dispatched.

const T0 = Date.UTC(2026, 9, 30, 0, 0, 0);
const MINUTE = 60000;
const HOUR = 3600000;
const DAY = 24 * HOUR;
const TTL = 30 * DAY;
const SCOPE_A = Object.freeze({ userId: 'owner-1', personaId: 'march7', worldId: '' });
const KEY_A = keyOfScope(SCOPE_A);

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

function tempFile(t, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `runtime-heartbeat-${label}-`));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });
  return { dir, file: path.join(dir, 'runtime.db') };
}

function makeConfig(overrides = {}) {
  return {
    enabled: true,
    mode: 'active',
    leaseTtlMs: TTL,
    agenda: {
      enabled: true, maxItemsPerScope: 64, generationHorizonHours: 72, maxGeneratePerCall: 64, querySpanDays: 14,
      ...(overrides.agenda ?? {}),
    },
    heartbeat: {
      enabled: true, pollIntervalMs: 60000, jitterMs: 0, maxScopesPerCycle: 8, maxDueItemsPerCycle: 64,
      maxNewOccurrencesPerCycle: 128, maxCatchupHorizonHours: 24, maxAttempts: 3, maxTimeBudgetMs: 2000,
      dueRetentionHours: 48, maxRetryBackoffMs: 1800000, activityConsumer: '', ...(overrides.heartbeat ?? {}),
    },
  };
}

function openWorld(t, { clock, label }) {
  const { dir, file } = tempFile(t, label);
  const db = openRuntimeDb({ file, now: () => clock.value });
  t.after(() => { try { db.close(); } catch { /* already closed */ } });
  const owner = 'owner-clock';
  const generation = 'gen-clock';
  assert.equal(db.acquireLease({ owner, generation, ttlMs: TTL }).ok, true);
  db.commitProjection({ scope: KEY_A, generation, payload: {} });
  return { db, file, dir, owner, generation };
}

function seedItem(db, { itemId, localTime = '09:00' }) {
  db.run(`INSERT INTO agenda_items (item_id, scope, revision, title, category, source, rule_kind, time_zone,
            local_date, local_time, weekdays, at_utc, valid_from, valid_until, status, authorization, delivery,
            goal_ref, commitment_ref, request_key, resolution, created_at, updated_at)
          VALUES (?, ?, 1, '晨间例行', 'plan', 'tool', 'daily', 'Asia/Shanghai', '', ?, '[]', NULL, 0, NULL, 'active', 'plan', 'none', '', '', '', '{}', 0, 0)`,
    itemId, KEY_A, localTime);
}

function occurrenceIdFor(scope, itemId, slotKey) {
  return 'occ_' + crypto.createHash('sha256').update(`${scope}|${itemId}|${slotKey}`).digest('hex').slice(0, 20);
}

function seedOccurrence(db, { itemId = 'item-1', slotKey, scheduledAt, status = 'scheduled', reason = '' }) {
  const occurrenceId = occurrenceIdFor(KEY_A, itemId, slotKey);
  db.run(`INSERT INTO agenda_occurrences (occurrence_id, scope, item_id, slot_key, definition_revision, scheduled_at,
            slot_end_at, status, reason_code, revision, attempts, last_error, causation_event_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, 1, ?, NULL, ?, ?, 1, 0, '', '', ?, ?)`,
    occurrenceId, KEY_A, itemId, slotKey, scheduledAt, status, reason, scheduledAt, scheduledAt);
  return occurrenceId;
}

function makeAgenda() {
  return {
    activeAgendaItems(handle, { scopeKey, at, limit }) {
      return handle.all(`SELECT * FROM agenda_items WHERE scope = ? AND status = 'active' ORDER BY item_id ASC LIMIT ?`, scopeKey, limit)
        .map(row => ({ itemId: row.item_id, revision: Number(row.revision), rule: row.rule_kind, time: row.local_time }));
    },
    planWindow({ item, from, to, limit }) {
      const [hour, minute] = String(item.time ?? '09:00').split(':').map(Number);
      const slots = [];
      let day = Math.floor(from / DAY) * DAY;
      for (let guard = 0; slots.length < limit && guard < 400; guard += 1) {
        const scheduledAt = day + (Number(hour) || 0) * HOUR + (Number(minute) || 0) * MINUTE;
        if (scheduledAt > to) break;
        if (scheduledAt >= from) {
          slots.push({ slotKey: `${item.itemId}@${scheduledAt}`, scheduledAt, slotEndAt: scheduledAt + 1800000, definitionRevision: item.revision, resolution: 'exact' });
        }
        day += DAY;
      }
      return slots;
    },
    dueAgendaOccurrences(handle, { scopeKey, at, limit }) {
      return handle.all(`SELECT * FROM agenda_occurrences WHERE scope = ? AND status IN ('scheduled','due') AND scheduled_at <= ?
                         ORDER BY scheduled_at ASC, occurrence_id ASC LIMIT ?`, scopeKey, at, limit)
        .map(row => ({ occurrenceId: row.occurrence_id, scheduledAt: Number(row.scheduled_at), revision: Number(row.revision), status: row.status }));
    },
    agendaCounts(handle, scope) {
      const rows = handle.all('SELECT status, COUNT(*) AS n FROM agenda_occurrences WHERE scope = ? GROUP BY status', scope);
      return { items: 0, occurrences: Object.fromEntries(rows.map(row => [row.status, Number(row.n)])), nextOccurrenceAt: null };
    },
  };
}

function previewAgenda(db, event) {
  const payload = event.payload ?? {};
  if (event.kind === 'agenda/occurrence-generated') {
    const existing = db.get('SELECT status, scheduled_at FROM agenda_occurrences WHERE scope = ? AND item_id = ? AND slot_key = ?',
      KEY_A, payload.itemId, payload.slotKey);
    if (!existing) return null;
    if (existing.status === 'scheduled' || existing.status === 'due') {
      return Number(existing.scheduled_at) === Number(payload.scheduledAt) ? 'duplicate-occurrence' : 'reschedule-required';
    }
    return 'slot-terminal';
  }
  if (['agenda/occurrence-due', 'agenda/occurrence-skipped', 'agenda/occurrence-expired'].includes(event.kind)) {
    const row = db.get('SELECT status, revision FROM agenda_occurrences WHERE occurrence_id = ?', payload.occurrenceId);
    if (!row) return 'occurrence-not-found';
    if (Number(payload.expectedRevision) !== Number(row.revision)) return 'stale-revision';
    if (event.kind === 'agenda/occurrence-due') return row.status === 'scheduled' ? null : 'invalid-transition';
    return row.status === 'scheduled' || row.status === 'due' ? null : 'invalid-transition';
  }
  return null;
}

function applyAgenda(db, event) {
  const payload = event.payload ?? {};
  const at = Number(event.occurredAt);
  if (event.kind === 'agenda/occurrence-generated') {
    db.run(`INSERT INTO agenda_occurrences (occurrence_id, scope, item_id, slot_key, definition_revision, scheduled_at,
              slot_end_at, status, reason_code, revision, attempts, last_error, causation_event_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', '', 1, 0, '', ?, ?, ?)`,
      occurrenceIdFor(KEY_A, payload.itemId, payload.slotKey), KEY_A, payload.itemId, payload.slotKey,
      payload.definitionRevision, payload.scheduledAt, payload.slotEndAt ?? null, event.eventId ?? '', at, at);
    return;
  }
  const status = event.kind === 'agenda/occurrence-due' ? 'due'
    : event.kind === 'agenda/occurrence-skipped' ? 'skipped'
      : event.kind === 'agenda/occurrence-expired' ? 'expired' : null;
  if (!status) return;
  db.run('UPDATE agenda_occurrences SET status = ?, reason_code = ?, revision = revision + 1, updated_at = ? WHERE occurrence_id = ?',
    status, payload.reasonCode ?? '', at, payload.occurrenceId);
}

function makeDispatch(db, generation, policy = null) {
  const calls = [];
  const dispatch = event => {
    calls.push(event);
    if (policy) policy(event, calls.length);
    const refusal = previewAgenda(db, event);
    if (refusal) {
      return { event, inserted: false, seq: null, rejected: true, results: [{ consumer: 'agenda', applied: false, error: refusal, code: refusal, deterministic: true }] };
    }
    const appended = appendEvent(db, event, { generation });
    applyAgenda(db, appended.event);
    return { event: appended.event, inserted: appended.inserted, seq: appended.seq, rejected: false, results: [{ consumer: 'agenda', applied: true }] };
  };
  return { dispatch, calls };
}

function makeHeartbeat({ db, clock, config, agenda, dispatch }) {
  return createHeartbeat({ db, config, clock: () => clock.value, owner: 'owner-clock', generation: 'gen-clock', dispatch, agenda });
}

function eventsOf(db, kind) {
  return db.all('SELECT * FROM domain_events WHERE kind = ? ORDER BY seq ASC', kind);
}

// ---------------------------------------------------------------------------
// HH10
// ---------------------------------------------------------------------------

test('HH10: a six-hour forward jump settles in bounded ranges', t => {
  const clock = { value: T0 };
  const { db, generation } = openWorld(t, { clock, label: 'forward' });
  const agenda = makeAgenda();
  const { dispatch } = makeDispatch(db, generation);
  const config = makeConfig({ heartbeat: { maxDueItemsPerCycle: 6 } });
  const heartbeat = makeHeartbeat({ db, clock, config, agenda, dispatch });

  for (let index = 0; index < 20; index += 1) {
    seedOccurrence(db, { slotKey: `slot-${String(index).padStart(2, '0')}`, scheduledAt: T0 - 30 * MINUTE });
  }
  clock.value = T0 + 6 * HOUR;

  const rounds = [];
  for (let round = 0; round < 10; round += 1) {
    clock.value += MINUTE;
    const outcome = heartbeat.cycle({ reason: 'timer' });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    rounds.push(outcome.due);
    assert.ok(outcome.due <= 6, `bounded range: ${outcome.due}`);
    assert.equal(outcome.skipped, 0, 'a six-hour jump stays inside the catch-up horizon');
    if (outcome.remaining === 0) break;
  }
  assert.deepEqual(rounds, [6, 6, 6, 2]);
  assert.equal(Number(db.get("SELECT COUNT(*) AS n FROM agenda_occurrences WHERE status = 'due'").n), 20);
  assert.equal(eventsOf(db, 'agenda/occurrence-skipped').length, 0);
  const cursor = db.get('SELECT settled_until FROM heartbeat_cursor WHERE scope = ? AND consumer = ?', KEY_A, HEARTBEAT_CONSUMER);
  assert.equal(Number(cursor.settled_until), clock.value);
});

test('HH10: a backward jump never rewinds settled_until and never regenerates history', t => {
  const clock = { value: T0 };
  const { db, generation } = openWorld(t, { clock, label: 'backward' });
  const agenda = makeAgenda();
  const { dispatch, calls } = makeDispatch(db, generation);
  const heartbeat = makeHeartbeat({ db, clock, config: makeConfig(), agenda, dispatch });

  seedItem(db, { itemId: 'daily-item', localTime: '09:00' });
  const forwards = heartbeat.cycle({ reason: 'timer' });
  assert.equal(forwards.ok, true, JSON.stringify(forwards));
  assert.equal(forwards.generated, 3);
  const cursorAfterForward = db.get('SELECT * FROM heartbeat_cursor WHERE scope = ? AND consumer = ?', KEY_A, HEARTBEAT_CONSUMER);
  assert.equal(Number(cursorAfterForward.settled_until), T0);
  const occurrencesAfterForward = db.all('SELECT occurrence_id, scheduled_at, status FROM agenda_occurrences ORDER BY occurrence_id');
  const generatedEvents = eventsOf(db, 'agenda/occurrence-generated').length;
  const dispatchCalls = calls.length;

  // Clock rollback by three hours: nothing is due in the rewound window, so the round
  // is idle and must not touch the cursor at all.
  clock.value = T0 - 3 * HOUR;
  const backwards = heartbeat.cycle({ reason: 'timer' });
  assert.equal(backwards.ok, true, JSON.stringify(backwards));
  assert.equal(backwards.generated, 0, 'historical slots are not regenerated');
  assert.equal(backwards.due, 0);
  assert.deepEqual(db.get('SELECT * FROM heartbeat_cursor WHERE scope = ? AND consumer = ?', KEY_A, HEARTBEAT_CONSUMER), cursorAfterForward,
    'an idle rewound round rewrites nothing');
  assert.deepEqual(db.all('SELECT occurrence_id, scheduled_at, status FROM agenda_occurrences ORDER BY occurrence_id'), occurrencesAfterForward);
  assert.equal(eventsOf(db, 'agenda/occurrence-generated').length, generatedEvents);
  assert.equal(calls.length, dispatchCalls);

  // Work after a rollback still must not move the watermark backwards.
  const rewoundOccurrence = seedOccurrence(db, { slotKey: 'rewound', scheduledAt: T0 - 2 * HOUR });
  clock.value = T0 - HOUR;
  const afterRollbackWork = heartbeat.cycle({ reason: 'timer' });
  assert.equal(afterRollbackWork.ok, true, JSON.stringify(afterRollbackWork));
  assert.equal(afterRollbackWork.due, 1, JSON.stringify(afterRollbackWork));
  assert.equal(db.get('SELECT status FROM agenda_occurrences WHERE occurrence_id = ?', rewoundOccurrence).status, 'due');
  const cursorAfterWork = db.get('SELECT settled_until, event_seq FROM heartbeat_cursor WHERE scope = ? AND consumer = ?', KEY_A, HEARTBEAT_CONSUMER);
  assert.equal(Number(cursorAfterWork.settled_until), T0, 'settled_until is monotonic: a rollback cannot rewind it');
  assert.ok(Number(cursorAfterWork.event_seq) >= Number(cursorAfterForward.event_seq), 'event_seq never decreases');
});

test('HH10: an instance cancelled between the due query and the dispatch is never dispatched', t => {
  const clock = { value: T0 };
  const { db, generation } = openWorld(t, { clock, label: 'cancel' });
  const agenda = makeAgenda();
  // The first dispatch simulates a concurrent cancel that commits for the *next*
  // instance in the same batch, exactly between the batch query and that dispatch.
  let cancelled = null;
  const policy = (event, callIndex) => {
    if (callIndex === 1 && event.kind === 'agenda/occurrence-due' && cancelled) {
      db.run("UPDATE agenda_occurrences SET status = 'cancelled', reason_code = 'definition-cancelled', updated_at = ? WHERE occurrence_id = ?",
        Number(event.occurredAt), cancelled);
    }
  };
  const { dispatch, calls } = makeDispatch(db, generation, policy);
  const heartbeat = makeHeartbeat({ db, clock, config: makeConfig(), agenda, dispatch });

  const first = seedOccurrence(db, { slotKey: 'slot-a', scheduledAt: T0 - 3 * HOUR });
  cancelled = seedOccurrence(db, { slotKey: 'slot-b', scheduledAt: T0 - 2 * HOUR });
  const third = seedOccurrence(db, { slotKey: 'slot-c', scheduledAt: T0 - HOUR });

  const outcome = heartbeat.cycle({ reason: 'timer' });
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(outcome.due, 2, 'only the two live instances are dispatched');
  assert.equal(outcome.rejected, 0, 'the cancelled instance is skipped, not refused by the reducer');

  const dueEvents = eventsOf(db, 'agenda/occurrence-due').map(row => JSON.parse(row.payload).occurrenceId);
  assert.deepEqual(new Set(dueEvents), new Set([first, third]));
  assert.equal(dueEvents.includes(cancelled), false, 'a cancelled instance is never dispatched as due');
  assert.equal(db.get('SELECT status FROM agenda_occurrences WHERE occurrence_id = ?', cancelled).status, 'cancelled');
  assert.equal(db.get('SELECT reason_code FROM agenda_occurrences WHERE occurrence_id = ?', cancelled).reason_code, 'definition-cancelled');
  assert.equal(db.get('SELECT status FROM agenda_occurrences WHERE occurrence_id = ?', first).status, 'due');
  assert.equal(eventsOf(db, 'agenda/occurrence-expired').length, 0, 'nothing is quarantined by the interleaving');
  assert.equal(calls.filter(event => event.kind === 'agenda/occurrence-due').length, 2);
});
