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

// HH11 — fault points. Every fault is either fully rolled back or fully committed and
// recoverable; a required-consumer failure never advances the watermark; the retry of a
// half-applied event reuses the same content-addressed event id (A1-B2); repeated
// rejections quarantine an item instead of blocking the scope forever (A1-B4).

const T0 = Date.UTC(2026, 9, 30, 0, 0, 0);
const MINUTE = 60000;
const HOUR = 3600000;
const DAY = 24 * HOUR;
const TTL = 30 * DAY;
const KEY_A = keyOfScope({ userId: 'owner-a', personaId: 'bot', worldId: '' });
const KEY_B = keyOfScope({ userId: 'owner-b', personaId: 'bot', worldId: '' });

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

function openWorld(t, { clock, scopes = [KEY_A], label }) {
  const { dir, file } = tempFile(t, label);
  const db = openRuntimeDb({ file, now: () => clock.value });
  t.after(() => { try { db.close(); } catch { /* already closed */ } });
  const owner = 'owner-faults';
  const generation = 'gen-faults';
  assert.equal(db.acquireLease({ owner, generation, ttlMs: TTL }).ok, true);
  for (const scope of scopes) db.commitProjection({ scope, generation, payload: {} });
  return { db, file, dir, owner, generation };
}

function seedItem(db, { scope = KEY_A, itemId, localTime = '09:00' }) {
  db.run(`INSERT INTO agenda_items (item_id, scope, revision, title, category, source, rule_kind, time_zone,
            local_date, local_time, weekdays, at_utc, valid_from, valid_until, status, authorization, delivery,
            goal_ref, commitment_ref, request_key, resolution, created_at, updated_at)
          VALUES (?, ?, 1, 'morning routine', 'plan', 'tool', 'daily', 'Asia/Shanghai', '', ?, '[]', NULL, 0, NULL,
            'active', 'plan', 'none', '', '', '', '{}', 0, 0)`,
    itemId, scope, localTime);
}

function occurrenceIdFor(scope, itemId, slotKey) {
  return 'occ_' + crypto.createHash('sha256').update(`${scope}|${itemId}|${slotKey}`).digest('hex').slice(0, 20);
}

function seedOccurrence(db, { scope = KEY_A, itemId = 'item-1', slotKey, scheduledAt, status = 'scheduled', revision = 1 }) {
  const occurrenceId = occurrenceIdFor(scope, itemId, slotKey);
  db.run(`INSERT INTO agenda_occurrences (occurrence_id, scope, item_id, slot_key, definition_revision, scheduled_at,
            slot_end_at, status, reason_code, revision, attempts, last_error, causation_event_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, 1, ?, NULL, ?, '', ?, 0, '', '', ?, ?)`,
    occurrenceId, scope, itemId, slotKey, scheduledAt, status, revision, scheduledAt, scheduledAt);
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
  const scope = event.scopeKey ?? keyOfScope(event.scope);
  if (event.kind === 'agenda/occurrence-generated') {
    const existing = db.get('SELECT status, scheduled_at FROM agenda_occurrences WHERE scope = ? AND item_id = ? AND slot_key = ?',
      scope, payload.itemId, payload.slotKey);
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
  const scope = event.scopeKey ?? keyOfScope(event.scope);
  if (event.kind === 'agenda/occurrence-generated') {
    db.run(`INSERT INTO agenda_occurrences (occurrence_id, scope, item_id, slot_key, definition_revision, scheduled_at,
              slot_end_at, status, reason_code, revision, attempts, last_error, causation_event_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', '', 1, 0, '', ?, ?, ?)`,
      occurrenceIdFor(scope, payload.itemId, payload.slotKey), scope, payload.itemId, payload.slotKey,
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

/** Dispatch with injectable decisions; `policy` may throw, refuse or report "temporary". */
function makeDispatch(handle, generation, policy = null) {
  const calls = [];
  const dispatch = event => {
    calls.push(event);
    const decision = (policy ? policy(event, calls.length) : null) ?? { mode: 'apply' };
    if (decision.mode === 'throw') throw new Error(decision.message ?? 'simulated dispatch failure');
    if (decision.mode === 'temporary') {
      const appended = appendEvent(handle, event, { generation });
      return {
        event: appended.event, inserted: true, seq: appended.seq, rejected: false,
        results: [{ consumer: 'agenda', applied: false, error: decision.message ?? 'simulated consumer failure', code: 'internal', deterministic: false }],
      };
    }
    const refusal = decision.mode === 'reject' ? (decision.code ?? 'invalid-transition') : previewAgenda(handle, event);
    if (refusal) {
      return { event, inserted: false, seq: null, rejected: true, results: [{ consumer: 'agenda', applied: false, error: refusal, code: refusal, deterministic: true }] };
    }
    const appended = appendEvent(handle, event, { generation });
    applyAgenda(handle, appended.event);
    return { event: appended.event, inserted: appended.inserted, seq: appended.seq, rejected: false, results: [{ consumer: 'agenda', applied: true }] };
  };
  return { dispatch, calls };
}

/** Storage-level fault injection; the wrapper keeps every other handle method intact. */
function faultingDb(db, match, { once = false } = {}) {
  const state = { hits: 0 };
  const wrapped = {
    ...db,
    run(sql, ...params) {
      if ((!once || state.hits === 0) && match(sql, params)) {
        state.hits += 1;
        throw new Error('injected storage failure');
      }
      return db.run(sql, ...params);
    },
  };
  return { db: wrapped, state };
}

function makeHeartbeat({ db, clock, config, agenda, dispatch, extra = {} }) {
  return createHeartbeat({
    db, config, clock: () => clock.value, owner: 'owner-faults', generation: 'gen-faults', dispatch, agenda, ...extra,
  });
}

function counts(db) {
  return {
    events: Number(db.get('SELECT COUNT(*) AS n FROM domain_events').n),
    occurrences: Number(db.get('SELECT COUNT(*) AS n FROM agenda_occurrences').n),
    cursors: Number(db.get('SELECT COUNT(*) AS n FROM heartbeat_cursor').n),
  };
}

function eventsOf(db, kind) {
  return db.all('SELECT * FROM domain_events WHERE kind = ? ORDER BY seq ASC', kind);
}

function anchorOf(db, scope = KEY_A) {
  const row = db.get('SELECT page_anchor FROM heartbeat_cursor WHERE scope = ? AND consumer = ?', scope, HEARTBEAT_CONSUMER);
  return row ? JSON.parse(row.page_anchor) : null;
}

/** A gate refusal: `ok:false` with the frozen code and nothing committed. */
function assertGate(outcome, code) {
  assert.equal(outcome.ok, false, JSON.stringify(outcome));
  assert.equal(outcome.code, code, JSON.stringify(outcome));
}

// ---------------------------------------------------------------------------
// HH11
// ---------------------------------------------------------------------------

test('HH11/A1-B4: a transient generation fault rolls back that scope only and backs it off', t => {
  const clock = { value: T0 };
  const { db, generation } = openWorld(t, { clock, scopes: [KEY_A, KEY_B], label: 'generation-fault' });
  const agenda = makeAgenda();
  seedItem(db, { scope: KEY_A, itemId: 'item-a' });
  seedItem(db, { scope: KEY_B, itemId: 'item-b' });

  let failing = true;
  const { dispatch } = makeDispatch(db, generation, (event, callIndex) => (
    failing && event.scope.userId === 'owner-a' && callIndex === 1 ? { mode: 'throw' } : { mode: 'apply' }
  ));
  const failures = [];
  const heartbeat = makeHeartbeat({ db, clock, config: makeConfig(), agenda, dispatch, extra: { onError: (code, detail) => failures.push(`${code}:${detail}`) } });

  const outcome = heartbeat.cycle({ reason: 'timer' });
  assert.equal(outcome.ok, true, 'a per-scope failure is not a cycle failure');
  assert.deepEqual(outcome.failures, ['heartbeat-failed'], JSON.stringify(outcome));
  assert.equal(outcome.scopes, 1, 'only the healthy scope committed');
  assert.equal(failures.length, 1, 'the observer saw the failure once');
  assert.match(failures[0], /^heartbeat-failed:/, 'the observer receives the code and the detail');

  // Scope A: rolled back, no events, no instances, and a backoff record only.
  assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM domain_events WHERE scope = ?', KEY_A).n), 0);
  assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM agenda_occurrences WHERE scope = ?', KEY_A).n), 0);
  const anchorA = anchorOf(db, KEY_A);
  assert.equal(anchorA.failures, 1);
  assert.equal(anchorA.nextAttemptAt, T0 + 60000, 'the first backoff equals one poll interval');
  assert.equal(anchorA.lastError, 'heartbeat-failed');
  const cursorA = db.get('SELECT settled_until, cycles FROM heartbeat_cursor WHERE scope = ? AND consumer = ?', KEY_A, HEARTBEAT_CONSUMER);
  assert.equal(Number(cursorA.settled_until), 0, 'a failed scope never advances the watermark');
  assert.equal(Number(cursorA.cycles), 0, 'a failed scope does not count as a business cycle');

  // Scope B: fully committed, untouched by A's failure.
  assert.ok(Number(db.get('SELECT COUNT(*) AS n FROM agenda_occurrences WHERE scope = ?', KEY_B).n) >= 1);
  assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM heartbeat_cursor WHERE scope = ?', KEY_B).n), 1);
  assert.equal(anchorOf(db, KEY_B).failures, 0);

  const status = heartbeat.status();
  assert.equal(status.failures.count, 1);
  assert.equal(status.failures.lastCode, 'heartbeat-failed');
  assert.equal(status.recovery, 'retry');
  assert.equal(status.state, 'failing');

  // While the backoff runs, the broken scope is skipped without touching the database.
  const before = counts(db);
  clock.value = T0 + 30000;
  const skipped = heartbeat.cycle({ reason: 'timer' });
  assert.equal(skipped.ok, true);
  assert.deepEqual(skipped.failures, []);
  assert.deepEqual(counts(db), before, 'a scope in backoff is not even opened');

  // After the backoff the scope is retried and recovers.
  failing = false;
  clock.value = T0 + 61000;
  const recovered = heartbeat.cycle({ reason: 'timer' });
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.deepEqual(recovered.failures, []);
  assert.ok(recovered.generated >= 1, JSON.stringify(recovered));
  const anchorRecovered = anchorOf(db, KEY_A);
  assert.equal(anchorRecovered.failures, 0, 'a successful round clears the failure counter');
  assert.equal(anchorRecovered.nextAttemptAt, null);
  assert.equal(heartbeat.status().recovery, 'resumed');
  assert.ok(Number(db.get('SELECT COUNT(*) AS n FROM agenda_occurrences WHERE scope = ?', KEY_A).n) >= 1);
});

test('HH11/A1-B4: status() never claims success for a round that committed nothing', t => {
  const clock = { value: T0 };
  const { db, generation } = openWorld(t, { clock, label: 'honest-status' });
  const agenda = makeAgenda();
  seedItem(db, { itemId: 'item-a' });
  let failing = true;
  const { dispatch } = makeDispatch(db, generation, event => (
    failing && event.kind === 'agenda/occurrence-generated' ? { mode: 'throw' } : { mode: 'apply' }
  ));
  const heartbeat = makeHeartbeat({ db, clock, config: makeConfig(), agenda, dispatch });

  const failed = heartbeat.cycle({ reason: 'timer' });
  assert.equal(failed.ok, true, JSON.stringify(failed));
  assert.deepEqual(failed.failures, ['heartbeat-failed']);
  let status = heartbeat.status();
  assert.equal(status.lastAttemptAt, T0, 'we tried');
  assert.equal(status.lastSuccessAt, null, 'no business progress was committed, so it must not advance');
  assert.equal(status.lastFailureAt, T0, 'the failing round is visible');
  assert.equal(status.failures.lastCode, 'heartbeat-failed');
  assert.equal(status.failures.count, 1);
  assert.equal(status.recovery, 'retry');
  assert.equal(status.state, 'failing');

  // While the scope sits in its backoff the loop still runs, but commits nothing: neither
  // stamp may move towards "healthy".
  clock.value = T0 + 30000;
  const skipped = heartbeat.cycle({ reason: 'timer' });
  assert.deepEqual(skipped.failures, []);
  status = heartbeat.status();
  assert.equal(status.lastAttemptAt, T0 + 30000);
  assert.equal(status.lastSuccessAt, null);
  assert.equal(status.lastFailureAt, T0);

  // After the backoff the scope commits real work: only now does lastSuccessAt move.
  failing = false;
  clock.value = T0 + 120000;
  const recovered = heartbeat.cycle({ reason: 'timer' });
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.ok(recovered.generated >= 1, JSON.stringify(recovered));
  status = heartbeat.status();
  assert.equal(status.lastSuccessAt, T0 + 120000, 'a committing round advances it');
  assert.equal(status.lastFailureAt, T0, 'the earlier failure stays visible');
  assert.equal(status.recovery, 'resumed');
  assert.equal(status.state, 'idle');

  // A genuinely empty round (everything generated, nothing due) is not progress either.
  clock.value = T0 + 180000;
  const empty = heartbeat.cycle({ reason: 'timer' });
  assert.equal(empty.ok, true, JSON.stringify(empty));
  assert.equal(empty.generated + empty.due + empty.skipped + empty.expired, 0);
  status = heartbeat.status();
  assert.equal(status.lastAttemptAt, T0 + 180000);
  assert.equal(status.lastSuccessAt, T0 + 120000, 'an empty round does not claim progress');
});

test('HH11/A1-B2: a retried half-applied event keeps one event id and still takes effect', t => {
  const clock = { value: T0 };
  const { db, generation } = openWorld(t, { clock, label: 'event-id' });
  const agenda = makeAgenda();
  const { dispatch } = makeDispatch(db, generation);
  const heartbeat = makeHeartbeat({ db, clock, config: makeConfig(), agenda, dispatch });

  const scheduledAt = T0 - HOUR;
  const occurrenceId = seedOccurrence(db, { slotKey: 'slot-a', scheduledAt });
  // Simulate a previous attempt that committed the event but lost the receipt before the
  // state write (the A1-B2 crash shape). occurredAt is the instance instant, so the
  // retry must reproduce the same content-addressed event id.
  const replay = appendEvent(db, {
    kind: 'agenda/occurrence-due',
    scope: { userId: 'owner-a', personaId: 'bot', worldId: '' },
    occurredAt: scheduledAt,
    payload: { occurrenceId, expectedRevision: 1, scheduledAt },
  }, { generation });
  assert.equal(replay.inserted, true);
  const eventIdBefore = replay.event.eventId;

  const outcome = heartbeat.cycle({ reason: 'timer' });
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(outcome.due, 1);
  assert.equal(db.get('SELECT status FROM agenda_occurrences WHERE occurrence_id = ?', occurrenceId).status, 'due');
  const events = eventsOf(db, 'agenda/occurrence-due');
  assert.equal(events.length, 1, 'the retry reuses the event instead of appending a second one');
  assert.equal(events[0].event_id, eventIdBefore);
  assert.equal(Number(events[0].occurred_at), scheduledAt, 'occurredAt is the instance instant, not the cycle clock');
});

test('HH11/A1-B4: a non-deterministic consumer failure does not advance the watermark', t => {
  const clock = { value: T0 };
  const { db, generation } = openWorld(t, { clock, label: 'consumer-failure' });
  const agenda = makeAgenda();
  let failing = false;
  let dueCallsThisRound = 0;
  const { dispatch } = makeDispatch(db, generation, event => {
    if (event.kind !== 'agenda/occurrence-due') return { mode: 'apply' };
    dueCallsThisRound += 1;
    return failing && dueCallsThisRound === 2 ? { mode: 'temporary' } : { mode: 'apply' };
  });
  const config = makeConfig({ heartbeat: { maxDueItemsPerCycle: 2 } });
  const heartbeat = makeHeartbeat({ db, clock, config, agenda, dispatch });

  const ids = [];
  for (let index = 0; index < 4; index += 1) {
    ids.push(seedOccurrence(db, { slotKey: `slot-${index}`, scheduledAt: T0 - (4 - index) * HOUR }));
  }

  const first = heartbeat.cycle({ reason: 'timer' });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.due, 2);
  const cursorAfterFirst = db.get('SELECT settled_until, event_seq FROM heartbeat_cursor WHERE scope = ? AND consumer = ?', KEY_A, HEARTBEAT_CONSUMER);
  assert.equal(Number(cursorAfterFirst.settled_until), T0 - 2 * HOUR, 'the watermark stops at the earliest unprocessed instant');
  const eventsAfterFirst = counts(db).events;

  failing = true;
  dueCallsThisRound = 0;
  clock.value += MINUTE;
  const second = heartbeat.cycle({ reason: 'timer' });
  assert.equal(second.ok, true, 'the failure is reported per scope, not thrown');
  assert.deepEqual(second.failures, ['consumer-failed'], JSON.stringify(second));
  assert.equal(second.due, 0);
  // Zero half-commit: the first event of the failed round was rolled back with the rest.
  assert.equal(counts(db).events, eventsAfterFirst, 'no event survives the rolled-back scope');
  const cursorAfterFailure = db.get('SELECT settled_until, event_seq FROM heartbeat_cursor WHERE scope = ? AND consumer = ?', KEY_A, HEARTBEAT_CONSUMER);
  assert.equal(Number(cursorAfterFailure.settled_until), Number(cursorAfterFirst.settled_until), 'the watermark never moves on failure');
  assert.equal(Number(cursorAfterFailure.event_seq), Number(cursorAfterFirst.event_seq));
  const statuses = db.all('SELECT occurrence_id, status FROM agenda_occurrences ORDER BY occurrence_id');
  assert.equal(statuses.filter(row => row.status === 'scheduled').length, 2, 'the failed round left both instances un-settled');

  failing = false;
  clock.value += 60000;
  const recovered = heartbeat.cycle({ reason: 'timer' });
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.equal(recovered.due, 2, 'nothing was skipped or lost by the failed round');
  assert.equal(Number(db.get("SELECT COUNT(*) AS n FROM agenda_occurrences WHERE status = 'due'").n), 4);
  const dispatched = eventsOf(db, 'agenda/occurrence-due').map(row => JSON.parse(row.payload).occurrenceId);
  assert.deepEqual(new Set(dispatched), new Set(ids), 'every instance is dispatched exactly once after recovery');
  assert.equal(dispatched.length, 4);
});

test('HH11: an event-write fault and a cursor-write fault both roll the scope back', t => {
  const clock = { value: T0 };
  const { db, generation } = openWorld(t, { clock, label: 'storage-faults' });
  const agenda = makeAgenda();
  seedOccurrence(db, { slotKey: 'slot-a', scheduledAt: T0 - HOUR });
  seedOccurrence(db, { slotKey: 'slot-b', scheduledAt: T0 - HOUR });

  // 1) The event row cannot be written.
  const eventFault = faultingDb(db, sql => sql.includes('INSERT INTO domain_events'));
  const first = makeDispatch(eventFault.db, generation);
  const firstHeartbeat = makeHeartbeat({ db: eventFault.db, clock, config: makeConfig(), agenda, dispatch: first.dispatch });
  const eventOutcome = firstHeartbeat.cycle({ reason: 'timer' });
  assert.equal(eventOutcome.ok, true);
  assert.deepEqual(eventOutcome.failures, ['heartbeat-failed'], JSON.stringify(eventOutcome));
  assert.equal(eventFault.state.hits, 1);
  assert.equal(counts(db).events, 0, 'no partial event row');
  assert.equal(Number(db.get("SELECT COUNT(*) AS n FROM agenda_occurrences WHERE status = 'scheduled'").n), 2);
  assert.equal(Number(db.get('SELECT settled_until FROM heartbeat_cursor WHERE scope = ? AND consumer = ?', KEY_A, HEARTBEAT_CONSUMER).settled_until), 0);

  // 2) The cursor write fails after the events were applied: the whole scope rolls back.
  const cursorFault = faultingDb(db, sql => sql.includes('INSERT INTO heartbeat_cursor') && sql.includes('ON CONFLICT'), { once: true });
  const second = makeDispatch(cursorFault.db, generation);
  const secondClock = { value: T0 + 10 * MINUTE };
  const secondHeartbeat = makeHeartbeat({ db: cursorFault.db, clock: secondClock, config: makeConfig(), agenda, dispatch: second.dispatch });
  const cursorOutcome = secondHeartbeat.cycle({ reason: 'timer' });
  assert.equal(cursorOutcome.ok, true);
  assert.deepEqual(cursorOutcome.failures, ['heartbeat-failed'], JSON.stringify(cursorOutcome));
  assert.equal(cursorFault.state.hits, 1);
  assert.equal(counts(db).events, 0, 'the applied events were rolled back with the cursor write');
  assert.equal(Number(db.get("SELECT COUNT(*) AS n FROM agenda_occurrences WHERE status = 'scheduled'").n), 2);
  const anchor = anchorOf(db);
  assert.equal(anchor.failures, 2, 'the second failure accumulates on the first');
  // Exponential backoff from one poll interval, capped by `maxRetryBackoffMs`.
  assert.equal(anchor.nextAttemptAt, T0 + 10 * MINUTE + 120000);
  assert.equal(anchor.lastError, 'heartbeat-failed');

  // 2b) If even the failure bookkeeping cannot be written, the round cannot pretend it
  // recorded anything: it reports the abort instead of a per-scope failure list.
  const brokenFault = faultingDb(db, sql => sql.includes('INSERT INTO heartbeat_cursor') && sql.includes('ON CONFLICT'));
  const third = makeDispatch(brokenFault.db, generation);
  const thirdClock = { value: T0 + 3 * HOUR };
  const thirdHeartbeat = makeHeartbeat({ db: brokenFault.db, clock: thirdClock, config: makeConfig(), agenda, dispatch: third.dispatch });
  const aborted = thirdHeartbeat.cycle({ reason: 'timer' });
  assert.equal(aborted.ok, false, JSON.stringify(aborted));
  assert.equal(aborted.code, 'heartbeat-failed');
  assert.equal(aborted.error, 'injected storage failure');
  assert.equal(counts(db).events, 0, 'an unbookkeepable failure commits nothing');
  assert.equal(Number(db.get('SELECT settled_until FROM heartbeat_cursor WHERE scope = ? AND consumer = ?', KEY_A, HEARTBEAT_CONSUMER).settled_until), 0);

  // 3) A throwing observer must never break the loop or resurrect a commit.
  const fourth = makeDispatch(db, generation);
  const throwingObserver = makeHeartbeat({
    db, clock: thirdClock, config: makeConfig(), agenda, dispatch: fourth.dispatch,
    extra: { onError: () => { throw new Error('observer exploded'); } },
  });
  throwingObserver.pause('probe');
  assert.equal(throwingObserver.cycle({ reason: 'timer' }).code, 'heartbeat-paused');
  assert.equal(throwingObserver.resume().ok, true);
});

test('HH11: repeated rejections quarantine an instance without blocking the scope', t => {
  const clock = { value: T0 };
  const { db, generation } = openWorld(t, { clock, label: 'quarantine' });
  const agenda = makeAgenda();
  const poison = occurrenceIdFor(KEY_A, 'item-1', 'slot-poison');
  const { dispatch } = makeDispatch(db, generation, event => (
    event.kind === 'agenda/occurrence-due' && event.payload?.occurrenceId === poison ? { mode: 'reject' } : { mode: 'apply' }
  ));
  const config = makeConfig({ heartbeat: { maxAttempts: 3 } });
  const heartbeat = makeHeartbeat({ db, clock, config, agenda, dispatch });

  const healthy = [
    seedOccurrence(db, { slotKey: 'slot-a', scheduledAt: T0 - 3 * HOUR }),
    seedOccurrence(db, { slotKey: 'slot-poison', scheduledAt: T0 - 2 * HOUR }),
    seedOccurrence(db, { slotKey: 'slot-b', scheduledAt: T0 - HOUR }),
  ];
  assert.equal(healthy[1], poison);

  const rejects = [];
  for (let round = 0; round < 4; round += 1) {
    clock.value += MINUTE;
    const outcome = heartbeat.cycle({ reason: 'timer' });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    rejects.push(outcome.rejected);
  }
  assert.deepEqual(rejects, [1, 1, 1, 0], 'the poison instance is retried up to maxAttempts only');

  assert.equal(db.get('SELECT status FROM agenda_occurrences WHERE occurrence_id = ?', poison).status, 'expired');
  assert.equal(db.get('SELECT reason_code FROM agenda_occurrences WHERE occurrence_id = ?', poison).reason_code, 'repeated-rejection');
  const expired = eventsOf(db, 'agenda/occurrence-expired');
  assert.equal(expired.length, 1, 'quarantine emits exactly one audit event');
  assert.equal(JSON.parse(expired[0].payload).reasonCode, 'repeated-rejection');
  assert.equal(Number(expired[0].occurred_at), T0 - 2 * HOUR, 'the audit event carries the instance instant');
  // The healthy siblings were dispatched in the very first round and never starved.
  assert.equal(eventsOf(db, 'agenda/occurrence-due').filter(row => JSON.parse(row.payload).occurrenceId !== poison).length, 2);
  assert.equal(eventsOf(db, 'agenda/occurrence-due').filter(row => JSON.parse(row.payload).occurrenceId === poison).length, 0);
  assert.equal(anchorOf(db).rejections[poison], undefined, 'a terminated instance leaves the rejection map');
  const cursor = db.get('SELECT settled_until FROM heartbeat_cursor WHERE scope = ? AND consumer = ?', KEY_A, HEARTBEAT_CONSUMER);
  assert.equal(Number(cursor.settled_until), T0 + 3 * MINUTE, 'the scope settles once the quarantined instance leaves the backlog');
  // The two dispatched siblings are settled-but-`due`: without an activity consumer they
  // stay in the backlog until the retention sweep, which is the bounded state A1-B1 wants.
  assert.equal(heartbeat.status().backlog.due, 2);
});

test('HH11: every lease or stop failure aborts the round before a single write', t => {
  const clock = { value: T0 };
  const { db, generation } = openWorld(t, { clock, label: 'lease-gates' });
  const agenda = makeAgenda();
  const { dispatch } = makeDispatch(db, generation);
  const heartbeat = makeHeartbeat({ db, clock, config: makeConfig(), agenda, dispatch });
  seedOccurrence(db, { slotKey: 'slot-a', scheduledAt: T0 - HOUR });
  seedOccurrence(db, { slotKey: 'slot-b', scheduledAt: T0 - HOUR });
  const baseline = counts(db);

  // 1) The lease row is gone: this worker may not commit.
  assert.equal(db.releaseLease('gen-faults', 'owner-faults'), true);
  assertGate(heartbeat.cycle({ reason: 'timer' }), 'lease-lost');
  assert.deepEqual(counts(db), baseline);
  assert.equal(heartbeat.status().lease.state, 'none');
  assert.equal(heartbeat.status().lease.valid, false);

  // 2) The lease expired while the worker was busy elsewhere.
  clock.value += MINUTE;
  assert.equal(db.acquireLease({ owner: 'owner-faults', generation: 'gen-faults', ttlMs: 1000 }).ok, true);
  clock.value += 5000;
  assertGate(heartbeat.cycle({ reason: 'timer' }), 'lease-expired');
  assert.deepEqual(counts(db), baseline);
  assert.equal(heartbeat.status().lease.state, 'held');
  assert.equal(heartbeat.status().lease.valid, false, 'a held but expired lease is not valid');

  // 3) Another generation took the writer role.
  clock.value += MINUTE;
  assert.equal(db.acquireLease({ owner: '999999:checker', generation: 'gen-other', ttlMs: 600000 }).ok, true);
  assertGate(heartbeat.cycle({ reason: 'timer' }), 'stale-generation');
  assert.deepEqual(counts(db), baseline);
  assert.equal(heartbeat.status().lease.state, 'held-elsewhere');
  assert.equal(heartbeat.status().lease.valid, false);

  // 4) The host stop latch. The other owner above carries a dead pid, so this worker may
  // take the lease back instead of waiting for the TTL (crash evidence, not a live holder).
  const reacquired = db.acquireLease({ owner: 'owner-faults', generation: 'gen-faults', ttlMs: 600000 });
  assert.equal(reacquired.ok, true, JSON.stringify(reacquired));
  db.setStopped(true, 'operator-stop');
  assertGate(heartbeat.cycle({ reason: 'timer' }), 'runtime-stopped');
  assert.deepEqual(counts(db), baseline);
  db.setStopped(false);
  const resumed = heartbeat.cycle({ reason: 'timer' });
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  assert.equal(resumed.due, 2);
});

test('HH11: the rejection map is bounded to 32 entries with oldest-first eviction', t => {
  const clock = { value: T0 };
  const { db, generation } = openWorld(t, { clock, label: 'rejection-map' });
  const agenda = makeAgenda();
  const { dispatch } = makeDispatch(db, generation, event => (
    event.kind === 'agenda/occurrence-due' ? { mode: 'reject' } : { mode: 'apply' }
  ));
  const config = makeConfig({ heartbeat: { maxAttempts: 20, maxDueItemsPerCycle: 64 } });
  const heartbeat = makeHeartbeat({ db, clock, config, agenda, dispatch });

  for (let index = 0; index < 40; index += 1) {
    seedOccurrence(db, { slotKey: `slot-${String(index).padStart(2, '0')}`, scheduledAt: T0 - HOUR + index });
  }
  const outcome = heartbeat.cycle({ reason: 'timer' });
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(outcome.rejected, 40);
  const anchor = anchorOf(db);
  const keys = Object.keys(anchor.rejections);
  assert.equal(keys.length, 32, 'the map never grows past 32 entries');
  // Oldest-first eviction: the eight earliest slots are gone, the newest are kept.
  for (let index = 0; index < 8; index += 1) {
    assert.equal(anchor.rejections[occurrenceIdFor(KEY_A, 'item-1', `slot-${String(index).padStart(2, '0')}`)], undefined);
  }
  for (let index = 8; index < 40; index += 1) {
    assert.equal(anchor.rejections[occurrenceIdFor(KEY_A, 'item-1', `slot-${String(index).padStart(2, '0')}`)], 1);
  }
  assert.equal(heartbeat.status().cursor.rejections, 32);
  assert.equal(Number(db.get('SELECT settled_until FROM heartbeat_cursor WHERE scope = ? AND consumer = ?', KEY_A, HEARTBEAT_CONSUMER).settled_until),
    T0 - HOUR, 'rejected instances keep the watermark at the earliest un-settled instant');
});
