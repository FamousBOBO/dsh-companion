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

// HH09 — 8 h and >24 h downtime. Nothing older than the catch-up horizon may be marked
// due, there must be no backfill burst, and old P1 rows (commitments/goals) are
// untouched by the business heartbeat.

const T0 = Date.UTC(2026, 9, 30, 0, 0, 0);
const MINUTE = 60000;
const HOUR = 3600000;
const DAY = 24 * HOUR;
const TTL = 30 * DAY;
const SCOPE_A = Object.freeze({ userId: 'owner-1', personaId: 'march7', worldId: '' });
const KEY_A = keyOfScope(SCOPE_A);

// ---------------------------------------------------------------------------
// harness (same injection surface as heartbeat-batch.test.mjs)
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
      dueRetentionHours: 24, maxRetryBackoffMs: 1800000, activityConsumer: '', ...(overrides.heartbeat ?? {}),
    },
  };
}

function openWorld(t, { clock, label }) {
  const { dir, file } = tempFile(t, label);
  const db = openRuntimeDb({ file, now: () => clock.value });
  t.after(() => { try { db.close(); } catch { /* already closed */ } });
  const owner = 'owner-sleeper';
  const generation = 'gen-sleeper';
  assert.equal(db.acquireLease({ owner, generation, ttlMs: TTL }).ok, true);
  db.commitProjection({ scope: KEY_A, generation, payload: {} });
  return { db, file, dir, owner, generation };
}

function seedItem(db, { itemId, localTime = '09:00', ruleKind = 'daily' }) {
  db.run(`INSERT INTO agenda_items (item_id, scope, revision, title, category, source, rule_kind, time_zone,
            local_date, local_time, weekdays, at_utc, valid_from, valid_until, status, authorization, delivery,
            goal_ref, commitment_ref, request_key, resolution, created_at, updated_at)
          VALUES (?, ?, 1, '晨间例行', 'plan', 'tool', ?, 'Asia/Shanghai', '', ?, '[]', NULL, 0, NULL, 'active', 'plan', 'none', '', '', '', '{}', 0, 0)`,
    itemId, KEY_A, ruleKind, localTime);
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

function makeDispatch(db, generation) {
  const calls = [];
  const dispatch = event => {
    calls.push(event);
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
  return createHeartbeat({ db, config, clock: () => clock.value, owner: 'owner-sleeper', generation: 'gen-sleeper', dispatch, agenda });
}

function eventsOf(db, kind) {
  return db.all('SELECT * FROM domain_events WHERE kind = ? ORDER BY seq ASC', kind);
}

function statusCounts(db) {
  const out = {};
  for (const row of db.all('SELECT status, COUNT(*) AS n FROM agenda_occurrences GROUP BY status')) out[row.status] = Number(row.n);
  return out;
}

// ---------------------------------------------------------------------------
// HH09
// ---------------------------------------------------------------------------

test('HH09: an 8 h outage drains in bounded rounds instead of one backfill burst', t => {
  const clock = { value: T0 };
  const { db, generation } = openWorld(t, { clock, label: 'eight-hours' });
  const agenda = makeAgenda();
  const { dispatch } = makeDispatch(db, generation);
  const config = makeConfig({ heartbeat: { maxDueItemsPerCycle: 10, dueRetentionHours: 48 } });
  const heartbeat = makeHeartbeat({ db, clock, config, agenda, dispatch });

  // 100 instances that came due while the process was down (spread over eight hours),
  // then the first round happens with the clock already eight hours later.
  for (let index = 0; index < 100; index += 1) {
    seedOccurrence(db, { slotKey: `outage-${String(index).padStart(3, '0')}`, scheduledAt: T0 + index * 288000 });
  }
  assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM domain_events').n), 0, 'downtime writes nothing');

  clock.value = T0 + 8 * HOUR;
  const rounds = [];
  for (let round = 0; round < 20; round += 1) {
    clock.value += MINUTE;
    const outcome = heartbeat.cycle({ reason: 'timer' });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    rounds.push({ due: outcome.due, skipped: outcome.skipped, remaining: outcome.remaining });
    assert.ok(outcome.due <= 10, `per-round burst: ${outcome.due}`);
    assert.equal(outcome.skipped, 0, 'everything is inside the 24 h catch-up horizon');
    if (outcome.remaining === 0) break;
  }

  assert.deepEqual(rounds[0], { due: 10, skipped: 0, remaining: 90 });
  assert.equal(rounds.reduce((sum, round) => sum + round.due, 0), 100);
  assert.equal(rounds.length, 10, `ten bounded rounds: ${rounds.length}`);
  assert.deepEqual(statusCounts(db), { due: 100 });
  assert.equal(eventsOf(db, 'agenda/occurrence-skipped').length, 0);
  assert.equal(eventsOf(db, 'agenda/occurrence-dispatched').length, 0);

  const cursor = db.get('SELECT settled_until, cycles FROM heartbeat_cursor WHERE scope = ? AND consumer = ?', KEY_A, HEARTBEAT_CONSUMER);
  assert.equal(Number(cursor.settled_until), clock.value, 'the watermark settles once the backlog is empty');
  assert.ok(Number(cursor.cycles) >= 10);
});

test('HH09: more than 24 h offline skips stale instances instead of marking them due', t => {
  const clock = { value: T0 };
  const { db, generation } = openWorld(t, { clock, label: 'stale' });
  const agenda = makeAgenda();
  const { dispatch } = makeDispatch(db, generation);
  const config = makeConfig({ heartbeat: { maxDueItemsPerCycle: 10, maxCatchupHorizonHours: 24 } });
  const heartbeat = makeHeartbeat({ db, clock, config, agenda, dispatch });

  const stale = [
    seedOccurrence(db, { slotKey: 'stale-30h', scheduledAt: T0 - 30 * HOUR }),
    seedOccurrence(db, { slotKey: 'stale-25h', scheduledAt: T0 - 25 * HOUR }),
  ];
  const fresh = [
    seedOccurrence(db, { slotKey: 'fresh-23h', scheduledAt: T0 - 23 * HOUR }),
    seedOccurrence(db, { slotKey: 'fresh-1h', scheduledAt: T0 - HOUR }),
  ];

  const outcome = heartbeat.cycle({ reason: 'timer' });
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(outcome.due, 2);
  assert.equal(outcome.skipped, 2);
  assert.ok(outcome.due + outcome.skipped <= 10, 'bounded work per round');

  const skipped = eventsOf(db, 'agenda/occurrence-skipped').map(row => JSON.parse(row.payload));
  assert.deepEqual(new Set(skipped.map(payload => payload.occurrenceId)), new Set(stale));
  for (const payload of skipped) assert.equal(payload.reasonCode, 'outside-catchup-window');
  const due = eventsOf(db, 'agenda/occurrence-due').map(row => JSON.parse(row.payload));
  assert.deepEqual(new Set(due.map(payload => payload.occurrenceId)), new Set(fresh));
  assert.equal(statusCounts(db).skipped, 2);
  assert.equal(statusCounts(db).due, 2);
  // Nothing stale is ever marked due: the skip is the only transition they get.
  for (const occurrenceId of stale) {
    assert.equal(db.get('SELECT status FROM agenda_occurrences WHERE occurrence_id = ?', occurrenceId).status, 'skipped');
  }
  const cursor = db.get('SELECT settled_until FROM heartbeat_cursor WHERE scope = ? AND consumer = ?', KEY_A, HEARTBEAT_CONSUMER);
  assert.equal(Number(cursor.settled_until), clock.value);
});

test('HH09: a >24 h outage leaves every P1 row untouched', t => {
  const clock = { value: T0 };
  const { db, generation } = openWorld(t, { clock, label: 'p1-rows' });
  const agenda = makeAgenda();
  const { dispatch } = makeDispatch(db, generation);
  const heartbeat = makeHeartbeat({ db, clock, config: makeConfig(), agenda, dispatch });

  db.run(`INSERT INTO commitments (commitment_id, scope, goal_id, body, status, due_at, revision, created_at, updated_at, closed_reason)
          VALUES ('cm-old', ?, '', '上周答应的事', 'open', ?, 2, ?, ?, '')`, KEY_A, T0 - 30 * HOUR, T0 - 40 * HOUR, T0 - 40 * HOUR);
  db.run(`INSERT INTO goals (goal_id, scope, title, source, authorization, status, overdue, deadline_at, revision, created_at, updated_at,
            completed_steps, next_step, waiting_on, checkpoint, superseded_by, history)
          VALUES ('goal-old', ?, '旧目标', 'conversation', 'none', 'running', 0, ?, 3, ?, ?, '[]', '', '', '{}', '', '[]')`,
  KEY_A, T0 - 30 * HOUR, T0 - 40 * HOUR, T0 - 40 * HOUR);
  const commitmentBefore = db.get("SELECT * FROM commitments WHERE commitment_id = 'cm-old'");
  const goalBefore = db.get("SELECT * FROM goals WHERE goal_id = 'goal-old'");

  seedOccurrence(db, { slotKey: 'old-1', scheduledAt: T0 - 26 * HOUR });
  seedOccurrence(db, { slotKey: 'old-2', scheduledAt: T0 - 25 * HOUR });
  for (let round = 0; round < 3; round += 1) {
    clock.value += MINUTE;
    assert.equal(heartbeat.cycle({ reason: 'timer' }).ok, true);
  }

  assert.deepEqual(db.get("SELECT * FROM commitments WHERE commitment_id = 'cm-old'"), commitmentBefore, 'an old commitment is not truncated or closed');
  assert.deepEqual(db.get("SELECT * FROM goals WHERE goal_id = 'goal-old'"), goalBefore);
  const kinds = new Set(db.all('SELECT DISTINCT kind FROM domain_events').map(row => row.kind));
  assert.deepEqual([...kinds].sort(), ['agenda/occurrence-skipped'], 'only the stale instances were touched');
  assert.equal(db.all("SELECT 1 FROM domain_events WHERE kind LIKE 'state/%'").length, 0, 'the heartbeat writes no affect events');
});

test('HH09: generation after an outage never backfills the past', t => {
  const clock = { value: T0 };
  const { db, generation } = openWorld(t, { clock, label: 'no-backfill' });
  const agenda = makeAgenda();
  const { dispatch } = makeDispatch(db, generation);
  const config = makeConfig({ heartbeat: { maxNewOccurrencesPerCycle: 3 } });
  const heartbeat = makeHeartbeat({ db, clock, config, agenda, dispatch });

  seedItem(db, { itemId: 'daily-item', localTime: '09:00' });
  clock.value = T0 + 26 * HOUR;
  const rounds = [];
  for (let round = 0; round < 6; round += 1) {
    const outcome = heartbeat.cycle({ reason: 'timer' });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    rounds.push({ generated: outcome.generated, due: outcome.due, skipped: outcome.skipped });
    assert.ok(outcome.generated <= 3, `generation burst: ${outcome.generated}`);
    if (round >= 2 && outcome.generated === 0) break;
  }
  const horizonDays = Number(db.get('SELECT COUNT(*) AS n FROM agenda_occurrences').n);
  assert.ok(horizonDays >= 3, `the horizon is generated in bounded rounds: ${horizonDays}`);
  for (const row of db.all('SELECT scheduled_at FROM agenda_occurrences')) {
    assert.ok(Number(row.scheduled_at) >= T0 + 26 * HOUR, 'no instance is invented for the offline window');
  }
  assert.equal(eventsOf(db, 'agenda/occurrence-generated').length, horizonDays, 'no duplicate generation');
  // Instances older than the catch-up horizon do not exist at all, so nothing is skipped.
  assert.equal(eventsOf(db, 'agenda/occurrence-skipped').length, 0);
});
