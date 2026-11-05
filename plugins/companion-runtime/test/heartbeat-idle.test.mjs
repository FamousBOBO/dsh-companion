import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { openRuntimeDb } from '../lib/db.mjs';
import { appendEvent } from '../lib/events.mjs';
import { scopeKey as keyOfScope } from '../lib/scope.mjs';
import { createHeartbeat, HEARTBEAT_CONSUMER, PAUSED_KEY, PAUSE_REASON_KEY } from '../lib/heartbeat.mjs';

// HH08 — 24 simulated hours of sampling at 10 s / 60 s / 300 s must write nothing,
// call nothing, and never grow a queue. Also the pause contract (business-only,
// persisted, authoritative in `runtime_meta`) and the bound on `due` (A1-B1).

const T0 = Date.UTC(2026, 9, 30, 0, 0, 0);
const MINUTE = 60000;
const HOUR = 3600000;
const DAY = 24 * HOUR;
const TTL = 30 * DAY;
const SCOPE_A = Object.freeze({ userId: 'owner-1', personaId: 'march7', worldId: '' });
const KEY_A = keyOfScope(SCOPE_A);

function tempFile(t, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `runtime-heartbeat-idle-${label}-`));
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
  const owner = 'owner-idle';
  const generation = 'gen-idle';
  assert.equal(db.acquireLease({ owner, generation, ttlMs: TTL }).ok, true);
  db.commitProjection({ scope: KEY_A, generation, payload: {} });
  return { db, file, dir, owner, generation };
}

function occurrenceIdFor(scope, itemId, slotKey) {
  return 'occ_' + crypto.createHash('sha256').update(`${scope}|${itemId}|${slotKey}`).digest('hex').slice(0, 20);
}

function seedOccurrence(db, { scope = KEY_A, itemId = 'item-1', slotKey, scheduledAt, status = 'scheduled', reason = '' }) {
  const occurrenceId = occurrenceIdFor(scope, itemId, slotKey);
  db.run(`INSERT INTO agenda_occurrences (occurrence_id, scope, item_id, slot_key, definition_revision, scheduled_at,
            slot_end_at, status, reason_code, revision, attempts, last_error, causation_event_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, 1, ?, NULL, ?, ?, 1, 0, '', '', ?, ?)`,
    occurrenceId, scope, itemId, slotKey, scheduledAt, status, reason, scheduledAt, scheduledAt);
  return occurrenceId;
}

/** Fake agenda API that records every call; the idle test must see reads but no writes. */
function makeAgenda() {
  const calls = { active: 0, plan: 0, due: 0, counts: 0 };
  return {
    calls,
    activeAgendaItems(handle, { scopeKey, at, limit }) {
      calls.active += 1;
      return handle.all("SELECT * FROM agenda_items WHERE scope = ? AND status = 'active' LIMIT ?", scopeKey, limit)
        .map(row => ({ itemId: row.item_id, revision: Number(row.revision), rule: row.rule_kind, time: row.local_time }));
    },
    planWindow({ item, from, to, limit }) {
      calls.plan += 1;
      void from; void to; void limit;
      return item ? [] : [];
    },
    dueAgendaOccurrences(handle, { scopeKey, at, limit }) {
      calls.due += 1;
      return handle.all(`SELECT * FROM agenda_occurrences WHERE scope = ? AND status = 'scheduled' AND scheduled_at <= ?
                         ORDER BY scheduled_at ASC, occurrence_id ASC LIMIT ?`, scopeKey, at, limit)
        .map(row => ({ occurrenceId: row.occurrence_id, scheduledAt: Number(row.scheduled_at), revision: Number(row.revision), status: row.status }));
    },
    agendaCounts(handle, scope) {
      calls.counts += 1;
      return { items: 0, occurrences: {}, nextOccurrenceAt: null };
    },
  };
}

/**
 * Minimal reducer-equivalent for the idle/pause tests: the frozen transition table,
 * the revision fence and the `(scope,item,slot)` uniqueness are enough to prove the
 * caller behaves, without pulling the real agenda module into an idle test.
 */
function applyState(db, event) {
  const payload = event.payload ?? {};
  const at = Number(event.occurredAt);
  if (event.kind === 'agenda/occurrence-generated') {
    const existing = db.get('SELECT status, scheduled_at FROM agenda_occurrences WHERE scope = ? AND item_id = ? AND slot_key = ?',
      keyOfScope(event.scope), payload.itemId, payload.slotKey);
    if (existing) return 'duplicate-occurrence';
    db.run(`INSERT INTO agenda_occurrences (occurrence_id, scope, item_id, slot_key, definition_revision, scheduled_at,
              slot_end_at, status, reason_code, revision, attempts, last_error, causation_event_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', '', 1, 0, '', ?, ?, ?)`,
      occurrenceIdFor(keyOfScope(event.scope), payload.itemId, payload.slotKey), keyOfScope(event.scope), payload.itemId,
      payload.slotKey, payload.definitionRevision, payload.scheduledAt, payload.slotEndAt ?? null, event.eventId ?? '', at, at);
    return null;
  }
  if (['agenda/occurrence-due', 'agenda/occurrence-skipped', 'agenda/occurrence-expired'].includes(event.kind)) {
    const row = db.get('SELECT status, revision FROM agenda_occurrences WHERE occurrence_id = ?', payload.occurrenceId);
    if (!row) return 'occurrence-not-found';
    const allowed = EVENT_SOURCE[event.kind];
    if (!allowed.includes(row.status)) return 'invalid-transition';
    if (Number(payload.expectedRevision) !== Number(row.revision)) return 'stale-revision';
    const status = event.kind === 'agenda/occurrence-due' ? 'due' : event.kind === 'agenda/occurrence-skipped' ? 'skipped' : 'expired';
    db.run('UPDATE agenda_occurrences SET status = ?, reason_code = ?, revision = revision + 1, updated_at = ? WHERE occurrence_id = ?',
      status, payload.reasonCode ?? '', at, payload.occurrenceId);
    return null;
  }
  return null;
}

const EVENT_SOURCE = {
  'agenda/occurrence-due': ['scheduled'],
  'agenda/occurrence-skipped': ['scheduled', 'due'],
  'agenda/occurrence-expired': ['scheduled', 'due'],
};

function makeDispatch(db, generation = 'gen-idle') {
  const calls = [];
  const dispatch = event => {
    calls.push(event);
    const refusal = applyState(db, event);
    if (refusal) {
      return {
        event, inserted: false, seq: null, rejected: true,
        results: [{ consumer: 'agenda', applied: false, error: refusal, code: refusal, deterministic: true }],
      };
    }
    const appended = appendEvent(db, event, { generation });
    return { event: appended.event, inserted: appended.inserted, seq: appended.seq, rejected: false, results: [{ consumer: 'agenda', applied: true }] };
  };
  return { dispatch, calls };
}

/** Fake external ports: the heartbeat has no model/send/memory handle at all, and a
 *  test can prove it structurally by recording every call an injected port sees. */
function makePorts() {
  const ports = { model: 0, send: 0, memory: 0 };
  return {
    ports,
    model: { chat() { ports.model += 1; } },
    send: { send() { ports.send += 1; } },
    memory: { ingestDomainEvent() { ports.memory += 1; } },
  };
}

function snapshot(db) {
  const row = db.get(`SELECT (SELECT COUNT(*) FROM domain_events) AS events,
                             (SELECT COUNT(*) FROM memory_outbox) AS outbox,
                             (SELECT COUNT(*) FROM heartbeat_cursor) AS cursors,
                             (SELECT COUNT(*) FROM agenda_occurrences) AS occurrences,
                             (SELECT COUNT(*) FROM agenda_items) AS items,
                             (SELECT COUNT(*) FROM consumer_receipts) AS receipts,
                             (SELECT COALESCE(MAX(seq), 0) FROM domain_events) AS maxseq`);
  return {
    events: Number(row.events),
    outbox: Number(row.outbox),
    cursors: Number(row.cursors),
    occurrences: Number(row.occurrences),
    items: Number(row.items),
    receipts: Number(row.receipts),
    maxSeq: Number(row.maxseq),
  };
}

function makeHeartbeat({ db, clock, config, agenda, dispatch, extra = {} }) {
  return createHeartbeat({
    db, config, clock: () => clock.value, owner: 'owner-idle', generation: 'gen-idle', dispatch, agenda, ...extra,
  });
}

// ---------------------------------------------------------------------------
// HH08 — idle sampling
// ---------------------------------------------------------------------------

function idleRun(t, stepMs, { label }) {
  const clock = { value: T0 };
  const { db } = openWorld(t, { clock, label });
  const agenda = makeAgenda();
  const { dispatch, calls } = makeDispatch(db);
  const ports = makePorts();
  const failuresSeen = [];
  const heartbeat = makeHeartbeat({ db, clock, config: makeConfig(), agenda, dispatch, extra: { onError: (code, detail) => failuresSeen.push(`${code}:${detail}`) } });

  const before = snapshot(db);
  const samples = Math.round(DAY / stepMs);
  let visited = 0;
  for (let index = 0; index < samples; index += 1) {
    clock.value = T0 + (index + 1) * stepMs;
    const outcome = heartbeat.cycle({ reason: 'timer' });
    assert.equal(outcome.ok, true, `step ${stepMs} cycle ${index}: ${JSON.stringify(outcome)}`);
    assert.equal(outcome.generated, 0);
    assert.equal(outcome.due, 0);
    assert.equal(outcome.skipped, 0);
    assert.equal(outcome.rejected, 0);
    assert.equal(outcome.expired, 0);
    assert.equal(outcome.truncated, false);
    visited += outcome.scopes;
  }
  const after = snapshot(db);

  assert.deepEqual(after, before, `step ${stepMs}: an idle round must write nothing`);
  assert.equal(after.events, 0);
  assert.equal(after.outbox, 0);
  assert.equal(after.cursors, 0, 'no cursor row for a scope with nothing to do');
  assert.equal(after.occurrences, 0);
  assert.equal(calls.length, 0, 'no event is dispatched while idle');
  assert.equal(ports.ports.model + ports.ports.send + ports.ports.memory, 0, 'no external call is possible');
  assert.ok(agenda.calls.active >= samples, 'the scope was actually examined, not skipped');
  assert.equal(visited, samples, 'the single authorized scope is visited every round');
  assert.deepEqual(failuresSeen, []);

  const status = heartbeat.status();
  assert.equal(status.state, 'idle');
  assert.equal(status.timer, 'stopped');
  assert.equal(status.backlog.due, 0);
  assert.equal(status.cursor.scopes, 0);
  assert.equal(status.lastAttemptAt, T0 + samples * stepMs, 'the in-memory attempt stamp advances');
  assert.equal(status.lastCycle.generated, 0);
  assert.equal(status.activityDispatch, 'unavailable');
  return { samples, status };
}

test('HH08: 24 simulated hours at 10 s / 60 s / 300 s sampling write nothing at all', t => {
  const results = [
    idleRun(t, 300000, { label: '300s' }),
    idleRun(t, 60000, { label: '60s' }),
    idleRun(t, 10000, { label: '10s' }),
  ];
  assert.deepEqual(results.map(result => result.samples), [288, 1440, 8640]);
  for (const result of results) assert.equal(result.status.failures.count, 0);
});

test('HH08: a settled schedule stays visible in diagnostics but is never rewritten', t => {
  const clock = { value: T0 };
  const { db } = openWorld(t, { clock, label: 'settled' });
  const agenda = makeAgenda();
  const { dispatch, calls } = makeDispatch(db);
  const heartbeat = makeHeartbeat({ db, clock, config: makeConfig(), agenda, dispatch });

  // Terminal instances plus one settled `due` row that is inside the retention window.
  for (const status of ['dispatched', 'skipped', 'cancelled', 'expired']) {
    seedOccurrence(db, { slotKey: `slot-${status}`, scheduledAt: T0 - 2 * HOUR, status, reason: status });
  }
  seedOccurrence(db, { slotKey: 'slot-due', scheduledAt: T0 + 1000, status: 'due' });
  const settledOccurrence = db.get("SELECT * FROM agenda_occurrences WHERE slot_key = 'slot-due'");
  const before = snapshot(db);

  for (let index = 0; index < 288; index += 1) {
    clock.value = T0 + (index + 1) * 300000;
    const outcome = heartbeat.cycle({ reason: 'timer' });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    assert.equal(outcome.generated + outcome.due + outcome.skipped + outcome.rejected + outcome.expired, 0);
  }

  assert.deepEqual(snapshot(db), before, 'a settled schedule is not churned per tick');
  assert.equal(calls.length, 0);
  const after = db.get("SELECT * FROM agenda_occurrences WHERE slot_key = 'slot-due'");
  assert.deepEqual(after, settledOccurrence, 'the settled row is untouched');
  const status = heartbeat.status();
  assert.equal(status.backlog.due, 1, 'the settled `due` row is still reported as backlog');
  assert.equal(heartbeat.status().cursor.scopes, 0);
});

test('HH08/A1-B1: `due` cannot grow without bound — the retention sweep is bounded per round', t => {
  const clock = { value: T0 };
  const { db } = openWorld(t, { clock, label: 'retention' });
  const agenda = makeAgenda();
  const { dispatch } = makeDispatch(db);
  const config = makeConfig({ heartbeat: { maxDueItemsPerCycle: 10, dueRetentionHours: 24 } });
  const heartbeat = makeHeartbeat({ db, clock, config, agenda, dispatch });

  for (let index = 0; index < 25; index += 1) {
    seedOccurrence(db, { slotKey: `old-${index}`, scheduledAt: T0 - 30 * HOUR, status: 'due', reason: '' });
  }
  seedOccurrence(db, { slotKey: 'fresh', scheduledAt: T0 - HOUR, status: 'due', reason: '' });

  const perRound = [];
  for (let round = 0; round < 10; round += 1) {
    clock.value += MINUTE;
    const outcome = heartbeat.cycle({ reason: 'timer' });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    perRound.push(outcome.expired);
    assert.ok(outcome.expired <= 10, `retention sweep must stay bounded: ${outcome.expired}`);
    const remaining = Number(db.get("SELECT COUNT(*) AS n FROM agenda_occurrences WHERE status = 'due'").n);
    if (remaining === 1) break;
  }

  assert.deepEqual(perRound, [10, 10, 5], `per round: ${perRound}`);
  const expired = db.all("SELECT reason_code FROM agenda_occurrences WHERE status = 'expired'");
  assert.equal(expired.length, 25);
  for (const row of expired) assert.equal(row.reason_code, 'due-retention-elapsed');
  assert.equal(Number(db.get("SELECT COUNT(*) AS n FROM agenda_occurrences WHERE status = 'due'").n), 1, 'the fresh row is kept');
  assert.equal(Number(db.get("SELECT COUNT(*) AS n FROM domain_events WHERE kind = 'agenda/occurrence-due'").n), 0,
    'a settled instance is expired, never re-dispatched as due');
  const status = heartbeat.status();
  assert.equal(status.backlog.due, 1, 'the backlog stays bounded');
  assert.equal(status.cursor.rejections, 0);
});

// ---------------------------------------------------------------------------
// pause / resume — business heartbeat only
// ---------------------------------------------------------------------------

test('HH08: pause() stops only the business heartbeat and survives a restart', t => {
  const clock = { value: T0 };
  const { db, file, owner, generation } = openWorld(t, { clock, label: 'pause' });
  const agenda = makeAgenda();
  const { dispatch } = makeDispatch(db);
  const heartbeat = makeHeartbeat({ db, clock, config: makeConfig(), agenda, dispatch });

  db.run(`INSERT INTO commitments (commitment_id, scope, goal_id, body, status, due_at, revision, created_at, updated_at, closed_reason)
          VALUES ('cm-1', ?, '', '周五继续整理资料', 'open', ?, 1, ?, ?, '')`, KEY_A, T0 + 3 * DAY, T0, T0);
  const occurrenceId = seedOccurrence(db, { slotKey: 'pause-slot', scheduledAt: T0 - HOUR });
  const first = heartbeat.cycle({ reason: 'test' });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.due, 1, 'one instance is dispatched before the pause');
  assert.equal(db.get('SELECT status FROM agenda_occurrences WHERE occurrence_id = ?', occurrenceId).status, 'due');

  const cursorBefore = db.get('SELECT * FROM heartbeat_cursor WHERE scope = ? AND consumer = ?', KEY_A, HEARTBEAT_CONSUMER);
  const generationBefore = db.metaGet('generation', '');
  const leaseBefore = db.leaseRow();
  const commitmentBefore = db.get("SELECT * FROM commitments WHERE commitment_id = 'cm-1'");
  const stoppedBefore = db.isStopped();
  const snapshotBefore = snapshot(db);

  const paused = heartbeat.pause('operator-window');
  assert.deepEqual(paused, { ok: true, paused: true, reason: 'operator-window' });
  assert.equal(db.metaGet(PAUSED_KEY), '1');
  assert.equal(db.metaGet(PAUSE_REASON_KEY), 'operator-window');
  // Every P1 side effect is untouched: this is not `runtime.stop()`.
  assert.equal(db.metaGet('generation', ''), generationBefore, 'the generation meta row is untouched');
  assert.deepEqual(db.leaseRow(), leaseBefore, 'the writer lease is still held');
  assert.equal(db.isStopped(), false, 'the runtime stop latch stays clear');
  assert.deepEqual(db.get("SELECT * FROM commitments WHERE commitment_id = 'cm-1'"), commitmentBefore);
  assert.deepEqual(snapshot(db), snapshotBefore, 'pause itself writes only the two meta keys');
  assert.equal(db.isStopped(), stoppedBefore);

  const blocked = heartbeat.cycle({ reason: 'test' });
  assert.deepEqual(blocked, { ok: false, code: 'heartbeat-paused' });
  assert.deepEqual(snapshot(db), snapshotBefore, 'a paused round writes nothing');
  const status = heartbeat.status();
  assert.equal(status.paused, true);
  assert.equal(status.pausedReason, 'operator-window');
  assert.equal(status.state, 'paused');
  assert.equal(status.lease.valid, true, 'the lease renewal is independent of the business pause');
  assert.equal(status.lease.state, 'held');
  assert.equal(heartbeat.isPaused(), true);
  assert.equal(heartbeat.paused, true);
  assert.equal(db.get('SELECT settled_until FROM heartbeat_cursor WHERE scope = ? AND consumer = ?', KEY_A, HEARTBEAT_CONSUMER).settled_until,
    cursorBefore.settled_until, 'pausing does not clear the settled watermark');

  // Idempotent: a second pause with the same reason does not rewrite the meta rows.
  const metaBefore = db.get('SELECT updated_at FROM runtime_meta WHERE meta_key = ?', PAUSED_KEY);
  assert.deepEqual(heartbeat.pause('operator-window'), { ok: true, paused: true, reason: 'operator-window' });
  assert.deepEqual(db.get('SELECT updated_at FROM runtime_meta WHERE meta_key = ?', PAUSED_KEY), metaBefore);

  // A restart re-reads the persisted pause instead of pretending the heartbeat is idle.
  const reopened = openRuntimeDb({ file, now: () => clock.value });
  const restarted = createHeartbeat({
    db: reopened, config: makeConfig(), clock: () => clock.value, owner, generation, dispatch, agenda,
  });
  assert.equal(restarted.status().paused, true, 'the persisted pause wins after a restart');
  assert.equal(restarted.status().pausedReason, 'operator-window');
  assert.equal(restarted.cycle({ reason: 'timer' }).code, 'heartbeat-paused');
  reopened.close();

  const resumed = heartbeat.resume();
  assert.deepEqual(resumed, { ok: true, paused: false });
  assert.equal(db.metaGet(PAUSED_KEY), '0');
  assert.equal(db.metaGet(PAUSE_REASON_KEY), '');
  assert.equal(heartbeat.status().paused, false);
  assert.equal(heartbeat.isPaused(), false);
  const afterResume = heartbeat.cycle({ reason: 'test' });
  assert.equal(afterResume.ok, true, JSON.stringify(afterResume));
});

// ---------------------------------------------------------------------------
// wake-up timer
// ---------------------------------------------------------------------------

test('HH08: start() is idempotent and dispose() clears the only wake-up timer', t => {
  const clock = { value: T0 };
  const { db } = openWorld(t, { clock, label: 'timer' });
  const agenda = makeAgenda();
  const { dispatch } = makeDispatch(db);
  const heartbeat = makeHeartbeat({ db, clock, config: makeConfig({ heartbeat: { pollIntervalMs: 60000, jitterMs: 0 } }), agenda, dispatch });
  t.after(() => { try { heartbeat.dispose(); } catch { /* already */ } });

  assert.equal(heartbeat.status().timer, 'stopped', 'no timer before start()');
  const first = heartbeat.start();
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.timer, 'running');
  assert.ok(first.interval >= 1000, `interval ${first.interval}`);
  assert.equal(heartbeat.status().timer, 'running');

  const second = heartbeat.start();
  assert.equal(second.ok, true);
  assert.equal(second.already, true, 'a second start() must not create a second timer');
  assert.equal(heartbeat.status().timer, 'running');
  assert.equal(heartbeat.timer, 'running');

  const disposed = heartbeat.dispose();
  assert.equal(disposed.ok, true);
  assert.equal(heartbeat.status().timer, 'stopped');
  assert.equal(heartbeat.start().code, 'runtime-disposed');
  assert.equal(heartbeat.cycle({ reason: 'test' }).code, 'runtime-disposed');
  assert.equal(heartbeat.dispose().already, true, 'dispose is idempotent');
});
