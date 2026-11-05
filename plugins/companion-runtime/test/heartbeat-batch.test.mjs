import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openRuntimeDb } from '../lib/db.mjs';
import { appendEvent, dispatchEvent } from '../lib/events.mjs';
import { scopeKey as keyOfScope } from '../lib/scope.mjs';
import { createHeartbeat, HEARTBEAT_CONSUMER } from '../lib/heartbeat.mjs';

// HH07 — bounded batches, several scopes, late insertions and fair rotation.
//
// The heartbeat is exercised through its frozen injection surface: a fake agenda API
// reads the real `agenda_items` / `agenda_occurrences` tables (schema v3 is frozen in
// CONTRACT §12.2) and a fake dispatch applies the frozen reducer transitions in SQL.
// That keeps the *scheduling* logic under test — batch bounds, watermark, fairness —
// while the real `lib/agenda.mjs` reducer stays owned by another module.

const here = path.dirname(fileURLToPath(import.meta.url));
const agendaModule = path.join(here, '..', 'lib', 'agenda.mjs');

const T0 = Date.UTC(2026, 9, 30, 0, 0, 0); // 2026-10-30T00:00:00Z
const HOUR = 3600000;
const DAY = 24 * HOUR;
const TTL = 7 * DAY;
const SCOPE_A = Object.freeze({ userId: 'owner-1', personaId: 'bot', worldId: '' });
const KEY_A = keyOfScope(SCOPE_A);

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

function tempFile(t, label = 'batch') {
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
      activityConsumer: '', ...(overrides.heartbeat ?? {}),
    },
  };
}

function openWorld(t, { clock, scopes = [KEY_A], label = 'batch' } = {}) {
  const { dir, file } = tempFile(t, label);
  const db = openRuntimeDb({ file, now: () => clock.value });
  t.after(() => { try { db.close(); } catch { /* already closed */ } });
  const owner = 'owner-test';
  const generation = 'gen-test';
  assert.equal(db.acquireLease({ owner, generation, ttlMs: TTL }).ok, true, 'the test writer holds the lease');
  for (const scope of scopes) db.commitProjection({ scope, generation, payload: {} });
  return { db, file, dir, owner, generation };
}

function seedItem(db, { scope = KEY_A, itemId, localTime = '09:00', ruleKind = 'daily', revision = 1, status = 'active', validUntil = null } = {}) {
  db.run(`INSERT INTO agenda_items (item_id, scope, revision, title, category, source, rule_kind, time_zone,
            local_date, local_time, weekdays, at_utc, valid_from, valid_until, status, authorization, delivery,
            goal_ref, commitment_ref, request_key, resolution, created_at, updated_at)
          VALUES (?, ?, ?, '晨间例行', 'plan', 'tool', ?, 'Asia/Shanghai', '', ?, '[]', NULL, 0, ?, ?, 'plan', 'none', '', '', '', '{}', 0, 0)`,
    itemId, scope, revision, ruleKind, localTime, validUntil, status);
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

/** Fake agenda API: reads the frozen v3 tables, plans a plain daily rule at a fixed local time. */
function makeAgenda() {
  const calls = { active: 0, plan: 0, due: 0, counts: 0, planned: 0 };
  const mapItem = row => ({
    itemId: row.item_id,
    scope: row.scope,
    revision: Number(row.revision),
    ruleKind: row.rule_kind,
    timeZone: row.time_zone,
    localTime: row.local_time,
    validUntil: row.valid_until === null ? null : Number(row.valid_until),
    status: row.status,
  });
  return {
    calls,
    activeAgendaItems(handle, { scopeKey, at, limit }) {
      calls.active += 1;
      return handle.all(`SELECT * FROM agenda_items
                         WHERE scope = ? AND status = 'active' AND (valid_until IS NULL OR valid_until > ?)
                         ORDER BY item_id ASC LIMIT ?`, scopeKey, at, limit).map(mapItem);
    },
    planWindow({ item, from, to, limit }) {
      calls.plan += 1;
      const [hour, minute] = String(item.localTime ?? '09:00').split(':').map(Number);
      const slots = [];
      let day = Math.floor(from / DAY) * DAY;
      for (let guard = 0; slots.length < limit && guard < 400; guard += 1) {
        const scheduledAt = day + (Number(hour) || 0) * HOUR + (Number(minute) || 0) * 60000;
        if (scheduledAt > to) break;
        if (scheduledAt >= from && (item.validUntil === null || scheduledAt <= item.validUntil)) {
          slots.push({
            slotKey: `${item.itemId}@${scheduledAt}`,
            scheduledAt,
            slotEndAt: scheduledAt + 1800000,
            definitionRevision: item.revision,
            resolution: 'exact',
          });
        }
        day += DAY;
      }
      calls.planned += slots.length;
      return slots;
    },
    dueAgendaOccurrences(handle, { scopeKey, at, limit }) {
      calls.due += 1;
      return handle.all(`SELECT * FROM agenda_occurrences
                         WHERE scope = ? AND status = 'scheduled' AND scheduled_at <= ?
                         ORDER BY scheduled_at ASC, occurrence_id ASC LIMIT ?`, scopeKey, at, limit)
        .map(row => ({
          occurrenceId: row.occurrence_id,
          itemId: row.item_id,
          slotKey: row.slot_key,
          scheduledAt: Number(row.scheduled_at),
          revision: Number(row.revision),
          status: row.status,
        }));
    },
    agendaCounts(handle, scope) {
      calls.counts += 1;
      const rows = handle.all('SELECT status, COUNT(*) AS n FROM agenda_occurrences WHERE scope = ? GROUP BY status', scope);
      return { items: 0, occurrences: Object.fromEntries(rows.map(row => [row.status, Number(row.n)])) };
    },
  };
}

/** Deterministic refusal a real reducer would return for the same row state. */
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
    const row = db.get('SELECT status FROM agenda_occurrences WHERE occurrence_id = ?', payload.occurrenceId);
    if (!row) return 'unknown-occurrence';
    if (row.status === 'scheduled') return null;
    if (row.status === 'due') return null;
    return 'invalid-transition';
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
      occurrenceIdFor(event.scopeKey, payload.itemId, payload.slotKey), event.scopeKey, payload.itemId, payload.slotKey,
      payload.definitionRevision, payload.scheduledAt, payload.slotEndAt ?? null, event.eventId ?? '', at, at);
    return;
  }
  if (event.kind === 'agenda/occurrence-due') {
    db.run("UPDATE agenda_occurrences SET status = 'due', updated_at = ? WHERE occurrence_id = ?", at, payload.occurrenceId);
    return;
  }
  if (event.kind === 'agenda/occurrence-skipped') {
    db.run("UPDATE agenda_occurrences SET status = 'skipped', reason_code = ?, updated_at = ? WHERE occurrence_id = ?",
      payload.reasonCode ?? '', at, payload.occurrenceId);
    return;
  }
  if (event.kind === 'agenda/occurrence-expired') {
    db.run("UPDATE agenda_occurrences SET status = 'expired', reason_code = ?, updated_at = ? WHERE occurrence_id = ?",
      payload.reasonCode ?? '', at, payload.occurrenceId);
    return;
  }
  if (event.kind === 'agenda/occurrence-cancelled') {
    db.run("UPDATE agenda_occurrences SET status = 'cancelled', reason_code = ?, updated_at = ? WHERE occurrence_id = ?",
      payload.reason ?? 'cancelled', at, payload.occurrenceId);
  }
}

function makeDispatch(db, { generation = 'gen-test', policy = null } = {}) {
  const calls = [];
  const dispatch = event => {
    calls.push(event);
    const decision = (policy ? policy(event, calls.length) : null) ?? { mode: 'apply' };
    if (decision.mode === 'throw') throw new Error(decision.message ?? 'simulated dispatch failure');
    if (decision.mode === 'temporary') {
      // The event row is written, then the consumer fails non-deterministically: the
      // caller must roll the whole scope transaction back.
      const appended = appendEvent(db, event, { generation });
      return {
        event: appended.event, inserted: true, seq: appended.seq, rejected: false,
        results: [{ consumer: 'agenda', applied: false, error: decision.message ?? 'simulated consumer failure', code: 'internal', deterministic: false }],
      };
    }
    const refusal = decision.mode === 'reject' ? (decision.code ?? 'invalid-transition') : previewAgenda(db, event);
    if (refusal) {
      return {
        event, inserted: false, seq: null, rejected: true,
        results: [{ consumer: 'agenda', applied: false, error: refusal, code: refusal, deterministic: true }],
      };
    }
    const appended = appendEvent(db, event, { generation });
    applyAgenda(db, appended.event);
    return { event: appended.event, inserted: appended.inserted, seq: appended.seq, rejected: false, results: [{ consumer: 'agenda', applied: true }] };
  };
  return { dispatch, calls };
}

function makeHeartbeat({ db, clock, config, agenda, dispatch, owner = 'owner-test', generation = 'gen-test', extra = {} }) {
  return createHeartbeat({
    db,
    config,
    clock: () => clock.value,
    owner,
    generation,
    dispatch,
    agenda,
    ...extra,
  });
}

function counts(db) {
  return {
    events: Number(db.get('SELECT COUNT(*) AS n FROM domain_events').n),
    occurrences: Number(db.get('SELECT COUNT(*) AS n FROM agenda_occurrences').n),
    cursors: Number(db.get('SELECT COUNT(*) AS n FROM heartbeat_cursor').n),
    outbox: Number(db.get('SELECT COUNT(*) AS n FROM memory_outbox').n),
    receipts: Number(db.get('SELECT COUNT(*) AS n FROM consumer_receipts').n),
  };
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
// HH07
// ---------------------------------------------------------------------------

test('HH07: 129 due occurrences sharing one scheduled_at drain in bounded, duplicate-free batches', t => {
  const clock = { value: T0 };
  const { db, generation } = openWorld(t, { clock, label: 'bulk' });
  const agenda = makeAgenda();
  const { dispatch, calls } = makeDispatch(db, { generation });
  const config = makeConfig({ heartbeat: { maxDueItemsPerCycle: 32, maxScopesPerCycle: 4 } });
  const heartbeat = makeHeartbeat({ db, clock, config, agenda, dispatch });

  const dueAt = T0 - 60000;
  const ids = [];
  for (let index = 0; index < 129; index += 1) {
    ids.push(seedOccurrence(db, { slotKey: `slot-${String(index).padStart(3, '0')}`, scheduledAt: dueAt }));
  }
  assert.equal(counts(db).occurrences, 129);

  const perCycle = [];
  for (let round = 0; round < 10; round += 1) {
    clock.value += 60000;
    const outcome = heartbeat.cycle({ reason: 'test' });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    perCycle.push(outcome.due);
    assert.ok(outcome.due <= 32, `bounded batch violated: ${outcome.due}`);
    if (outcome.remaining === 0) break;
  }

  assert.equal(perCycle.reduce((sum, value) => sum + value, 0), 129, `per-cycle: ${perCycle}`);
  assert.equal(perCycle.length, 5, '129 items at 32 per cycle need exactly five bounded rounds');
  assert.deepEqual(statusCounts(db), { due: 129 });
  assert.equal(eventsOf(db, 'agenda/occurrence-due').length, 129);
  assert.equal(eventsOf(db, 'agenda/occurrence-dispatched').length, 0, 'there is no activity consumer');
  assert.equal(eventsOf(db, 'agenda/occurrence-skipped').length, 0);

  const cursor = db.get('SELECT * FROM heartbeat_cursor WHERE scope = ? AND consumer = ?', KEY_A, HEARTBEAT_CONSUMER);
  assert.ok(cursor, 'the scope has a committed cursor');
  assert.equal(Number(cursor.settled_until), clock.value, 'a fully drained scope settles to now');
  assert.equal(Number(cursor.cycles), 5);
  const anchor = JSON.parse(cursor.page_anchor);
  assert.ok(Object.prototype.hasOwnProperty.call(anchor, 'rejections'));
  assert.ok(Object.keys(anchor.rejections).length <= 32);
  assert.equal(anchor.lastError, '');

  // Every dispatched due event is for a distinct occurrence, and none is repeated.
  const dispatched = eventsOf(db, 'agenda/occurrence-due').map(row => JSON.parse(row.payload).occurrenceId);
  assert.equal(new Set(dispatched).size, 129);
  assert.deepEqual(new Set(dispatched), new Set(ids));
  assert.equal(calls.length, 129);
  assert.equal(calls.filter(event => event.kind === 'agenda/occurrence-dispatched').length, 0);

  const status = heartbeat.status();
  // A1-B1: `due` stays in the backlog until the bounded retention sweep expires it —
  // that is the point of the retention rule, so diagnostics must show it.
  assert.equal(status.backlog.due, 129);
  assert.equal(status.backlog.oldestDueAt, dueAt);
  assert.equal(status.cursor.scopes, 1);
  assert.equal(status.lastCycle.due, 1, 'the final round handled the single remaining item');
});

test('HH07: several scopes drain without starvation and the fairness cursor rotates', t => {
  const clock = { value: T0 };
  const scopes = ['owner-a', 'owner-b', 'owner-c', 'owner-d', 'owner-e'].map(userId => keyOfScope({ userId, personaId: 'bot', worldId: '' }));
  const { db, generation } = openWorld(t, { clock, scopes, label: 'fair' });
  const agenda = makeAgenda();
  const { dispatch, calls } = makeDispatch(db, { generation });
  const config = makeConfig({ heartbeat: { maxDueItemsPerCycle: 4, maxScopesPerCycle: 2 } });
  const heartbeat = makeHeartbeat({ db, clock, config, agenda, dispatch });

  for (const scope of scopes) {
    for (let index = 0; index < 10; index += 1) {
      seedOccurrence(db, { scope, itemId: `item-${scope.slice(-1)}`, slotKey: `slot-${index}`, scheduledAt: T0 - 60000 });
    }
  }
  assert.equal(counts(db).occurrences, 50);

  const touchedPerCycle = [];
  for (let round = 0; round < 30; round += 1) {
    clock.value += 60000;
    const before = calls.length;
    const outcome = heartbeat.cycle({ reason: 'test' });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    assert.ok(outcome.scopes <= 2, `scope batch is bounded: ${outcome.scopes}`);
    const touched = new Set(calls.slice(before).map(event => event.scope.userId));
    touchedPerCycle.push([...touched].sort());
    const backlog = Number(db.get("SELECT COUNT(*) AS n FROM agenda_occurrences WHERE status = 'scheduled'").n);
    if (backlog === 0) break;
  }

  assert.deepEqual(statusCounts(db), { due: 50 }, 'every scope drained');
  assert.equal(eventsOf(db, 'agenda/occurrence-due').length, 50);
  assert.equal(eventsOf(db, 'agenda/occurrence-skipped').length, 0);
  assert.ok(touchedPerCycle.length >= 3, `rounds: ${touchedPerCycle.length}`);
  assert.equal(touchedPerCycle[0].length, 2, 'the first batch holds exactly two scopes');
  assert.notDeepEqual(touchedPerCycle[0], touchedPerCycle[1], 'the second round starts with other scopes');
  // No scope monopolises the loop: 50 items at (2 scopes × 4 items) per round need at
  // least seven rounds, and the fairness cursor keeps every round bounded.
  assert.ok(touchedPerCycle.length >= Math.ceil(50 / 8), `bounded per-round work: ${touchedPerCycle.length}`);
  assert.ok(touchedPerCycle.length <= 20, `work per round stays bounded: ${touchedPerCycle.length}`);

  const cursors = db.all('SELECT scope, updated_at, cycles FROM heartbeat_cursor ORDER BY updated_at ASC, scope ASC');
  assert.equal(cursors.length, 5, 'one bounded cursor row per authorized scope');
  for (const cursor of cursors) assert.ok(Number(cursor.cycles) >= 1);
  const seen = new Set(cursors.map(row => row.scope));
  assert.deepEqual(seen, new Set(scopes));
});

test('HH07: an instance that becomes due earlier than the watermark is still processed', t => {
  const clock = { value: T0 };
  const { db, generation } = openWorld(t, { clock, label: 'late' });
  const agenda = makeAgenda();
  const { dispatch, calls } = makeDispatch(db, { generation });
  const config = makeConfig({ heartbeat: { maxDueItemsPerCycle: 8, maxScopesPerCycle: 2 } });
  const heartbeat = makeHeartbeat({ db, clock, config, agenda, dispatch });

  for (let index = 0; index < 40; index += 1) {
    seedOccurrence(db, { slotKey: `slot-${String(index).padStart(2, '0')}`, scheduledAt: T0 - 60000 });
  }
  const first = heartbeat.cycle({ reason: 'test' });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.due, 8);
  const cursorAfterFirst = db.get('SELECT settled_until FROM heartbeat_cursor WHERE scope = ? AND consumer = ?', KEY_A, HEARTBEAT_CONSUMER);
  assert.equal(Number(cursorAfterFirst.settled_until), T0 - 60000, 'the watermark stops at the earliest unprocessed instant');

  // Insert an instance that is due *before* the settled watermark: a watermark-only
  // scan would never look at it again, a status+index query always does.
  clock.value += 60000;
  const lateId = seedOccurrence(db, { slotKey: 'late-arrival', scheduledAt: T0 - 2 * HOUR });
  const offset = calls.length;
  for (let round = 0; round < 10; round += 1) {
    clock.value += 60000;
    const outcome = heartbeat.cycle({ reason: 'test' });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    if (outcome.remaining === 0) break;
  }

  const dispatched = eventsOf(db, 'agenda/occurrence-due').map(row => JSON.parse(row.payload).occurrenceId);
  assert.equal(dispatched.length, 41, 'all 40 original instances plus the late one');
  assert.ok(dispatched.includes(lateId), 'the late, earlier-due instance is never skipped');
  assert.ok(calls.slice(offset).some(event => event.payload?.occurrenceId === lateId), 'it was dispatched after the insertion');
  assert.deepEqual(statusCounts(db), { due: 41 });
  assert.equal(eventsOf(db, 'agenda/occurrence-skipped').length, 0);

  const cursor = db.get('SELECT settled_until, cycles FROM heartbeat_cursor WHERE scope = ? AND consumer = ?', KEY_A, HEARTBEAT_CONSUMER);
  assert.equal(Number(cursor.settled_until), clock.value, 'settles to now once the backlog is empty');
});

test('HH07: generation is bounded per cycle across scopes and never duplicates a slot', t => {
  const clock = { value: T0 };
  const scopes = ['owner-a', 'owner-b', 'owner-c'].map(userId => keyOfScope({ userId, personaId: 'bot', worldId: '' }));
  const { db, generation } = openWorld(t, { clock, scopes, label: 'generate' });
  const agenda = makeAgenda();
  const { dispatch, calls } = makeDispatch(db, { generation });
  const config = makeConfig({ heartbeat: { maxNewOccurrencesPerCycle: 2, maxScopesPerCycle: 3 } });
  const heartbeat = makeHeartbeat({ db, clock, config, agenda, dispatch });

  scopes.forEach((scope, index) => seedItem(db, { scope, itemId: `item-${index}` }));

  const generatedPerCycle = [];
  for (let round = 0; round < 12; round += 1) {
    clock.value += 60000;
    const outcome = heartbeat.cycle({ reason: 'test' });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    generatedPerCycle.push(outcome.generated);
    assert.ok(outcome.generated <= 2, `generation cap violated: ${outcome.generated}`);
    if (counts(db).occurrences >= 9) break;
  }

  assert.equal(counts(db).occurrences, 9, 'three scopes, three horizon days each');
  assert.ok(generatedPerCycle.reduce((sum, value) => sum + value, 0) <= 9 + 3);
  assert.equal(eventsOf(db, 'agenda/occurrence-generated').length, 9, 'no duplicate generation');
  const perScope = db.all('SELECT scope, COUNT(*) AS n FROM agenda_occurrences GROUP BY scope ORDER BY scope');
  assert.equal(perScope.length, 3);
  for (const row of perScope) assert.equal(Number(row.n), 3);
  for (const row of db.all('SELECT scheduled_at FROM agenda_occurrences')) {
    assert.ok(Number(row.scheduled_at) >= T0, 'nothing is generated in the past');
  }
  // Repeated rounds are idempotent: the unique (scope, item, slot) key is authoritative.
  const before = counts(db);
  clock.value += 60000;
  const idle = heartbeat.cycle({ reason: 'test' });
  assert.equal(idle.ok, true, JSON.stringify(idle));
  assert.equal(idle.generated, 0, 'existing slots are not regenerated');
  assert.deepEqual(counts(db), before);
  assert.equal(calls.filter(event => event.kind === 'agenda/occurrence-generated').length, 9);
});

test('HH07: an exhausted time budget commits the current scope and leaves the rest for the next round', t => {
  const clock = { value: T0 };
  const scopes = ['owner-a', 'owner-b', 'owner-c'].map(userId => keyOfScope({ userId, personaId: 'bot', worldId: '' }));
  const { db, generation } = openWorld(t, { clock, scopes, label: 'budget' });
  const agenda = makeAgenda();
  const { dispatch, calls } = makeDispatch(db, { generation });
  const config = makeConfig({ heartbeat: { maxTimeBudgetMs: 100, maxDueItemsPerCycle: 8, maxScopesPerCycle: 8 } });
  // Elapsed time is injected: 40 ms per sample, so a 100 ms budget allows one scope and
  // one due item before the round truncates.
  let ticks = 0;
  const elapsed = () => { ticks += 40; return ticks; };
  const heartbeat = makeHeartbeat({ db, clock, config, agenda, dispatch, extra: { elapsed } });

  for (const scope of scopes) {
    for (let index = 0; index < 5; index += 1) {
      seedOccurrence(db, { scope, itemId: `item-${scope.slice(-1)}`, slotKey: `slot-${index}`, scheduledAt: T0 - 60000 });
    }
  }

  ticks = 0;
  const first = heartbeat.cycle({ reason: 'test' });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.truncated, true, 'the round reports that it ran out of budget');
  assert.equal(first.scopes, 1, 'the round stops after the scope it was working on');
  assert.equal(first.due, 1);
  assert.equal(first.remaining, 4, 'the remaining items of that scope are left for the next round');
  assert.equal(eventsOf(db, 'agenda/occurrence-due').length, 1, 'the partial work was committed, not lost');
  const cursor = db.get('SELECT settled_until FROM heartbeat_cursor WHERE scope = ? AND consumer = ?', scopes[0], HEARTBEAT_CONSUMER);
  assert.equal(Number(cursor.settled_until), T0 - 60000, 'the watermark stops at the earliest unprocessed instant');
  assert.equal(heartbeat.status().lastCycle.truncated, true);
  assert.ok(heartbeat.status().lastCycle.ms >= 40);

  const visited = new Set([calls[0].scope.userId]);
  for (let round = 0; round < 20; round += 1) {
    ticks = 0;
    clock.value += 60000;
    const before = calls.length;
    const outcome = heartbeat.cycle({ reason: 'test' });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    for (const event of calls.slice(before)) visited.add(event.scope.userId);
    const backlog = Number(db.get("SELECT COUNT(*) AS n FROM agenda_occurrences WHERE status = 'scheduled'").n);
    if (backlog === 0) break;
  }
  assert.deepEqual(new Set(db.all("SELECT scope FROM agenda_occurrences WHERE status = 'due'").map(row => row.scope)), new Set(scopes));
  assert.equal(eventsOf(db, 'agenda/occurrence-due').length, 15, 'a truncated round starves no item');
  assert.deepEqual(visited, new Set(['owner-a', 'owner-b', 'owner-c']), 'the rotation still visits every scope');
});

test('HH07: the real agenda module drives one end-to-end cycle', t => {
  if (!fs.existsSync(agendaModule)) {
    t.skip('lib/agenda.mjs is not landed yet (owned by h1-agenda); the fake API covers the same surface');
    return;
  }
  return (async () => {
    const real = await import(new URL('../lib/agenda.mjs', import.meta.url).href);
    for (const name of ['normalizeDefinition', 'planWindow', 'activeAgendaItems', 'dueAgendaOccurrences', 'agendaCounts', 'applyAgendaEvent']) {
      assert.equal(typeof real[name], 'function', `lib/agenda.mjs must export ${name}`);
    }
    const clock = { value: T0 };
    const { db, generation } = openWorld(t, { clock, label: 'real' });
    const agenda = {
      planWindow: real.planWindow,
      activeAgendaItems: real.activeAgendaItems,
      dueAgendaOccurrences: real.dueAgendaOccurrences,
      agendaCounts: real.agendaCounts,
    };
    const realDispatch = event => dispatchEvent(db, event, { handlers: { agenda: real.applyAgendaEvent }, generation });

    // The definition arrives through the real event path, exactly like a tool call.
    const definition = real.normalizeDefinition({
      title: '晨间例行', rule: 'daily', timeZone: 'Asia/Shanghai', time: '09:00',
    }, { now: T0 });
    const item = { ...definition, itemId: 'item-real-1', revision: 1, createdAt: T0 };
    const created = realDispatch({
      kind: 'agenda/created', scope: SCOPE_A, occurredAt: T0,
      payload: { item, requestKey: definition.requestKey },
    });
    assert.equal(created.rejected, false, JSON.stringify(created.results));
    assert.equal(created.inserted, true);

    const heartbeat = makeHeartbeat({ db, clock, config: makeConfig(), agenda, dispatch: realDispatch });
    const outcome = heartbeat.cycle({ reason: 'test' });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    assert.equal(outcome.generated, 3, 'the 72h horizon holds three local days');
    assert.equal(counts(db).occurrences, 3);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM consumer_receipts WHERE consumer = ?', HEARTBEAT_CONSUMER).n, 4,
      'one receipt for the definition plus one per generated instance');

    // Advancing past the first slot turns exactly that instance due through the real
    // reducer; the other two stay scheduled.
    clock.value = T0 + 10 * HOUR;
    const second = heartbeat.cycle({ reason: 'test' });
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(second.due, 1, JSON.stringify(second));
    assert.equal(statusCounts(db).due, 1);
    assert.ok(statusCounts(db).scheduled >= 2, 'the future instances stay scheduled');

    // The real due query also returns the settled `due` row; the batch must not re-dispatch
    // it (and must not let it crowd out the scheduled rows).
    const third = heartbeat.cycle({ reason: 'test' });
    assert.equal(third.ok, true, JSON.stringify(third));
    assert.equal(third.due, 0, 'a settled instance is never dispatched twice');
    assert.equal(eventsOf(db, 'agenda/occurrence-due').length, 1);
    assert.equal(eventsOf(db, 'agenda/occurrence-dispatched').length, 0, 'no activity consumer exists');
    assert.equal(eventsOf(db, 'agenda/occurrence-expired').length, 0, 'nothing is older than the retention window yet');

    // Past `dueRetentionHours` the settled instance leaves the backlog through the
    // bounded retention sweep instead of growing it forever (A1-B1).
    clock.value = T0 + 40 * HOUR;
    const swept = heartbeat.cycle({ reason: 'test' });
    assert.equal(swept.ok, true, JSON.stringify(swept));
    assert.equal(swept.expired, 1, JSON.stringify(swept));
    const expiredRows = db.all("SELECT occurrence_id, reason_code FROM agenda_occurrences WHERE status = 'expired'");
    assert.equal(expiredRows.length, 1);
    assert.equal(expiredRows[0].reason_code, 'due-retention-elapsed');
  })();
});
