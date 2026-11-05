import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openRuntimeDb } from '../lib/db.mjs';
import { scopeKey as keyOfScope } from '../lib/scope.mjs';
import { createHeartbeat, HEARTBEAT_CONSUMER } from '../lib/heartbeat.mjs';

// HH12 鈥?two real OS processes, one database file. Exactly one of them may become the
// writer and commit a business cycle; the loser gets a lease/stale code, and a worker
// that wakes up after a takeover cannot commit either. This is deliberately *not* two
// JavaScript objects inside one process: the single-writer claim only means something
// if the other side is another process holding its own SQLite handle.
//
// Flake hardening (measured, not guessed):
//  * the parent鈫攃hild handshake is an **append-only JSONL journal**: the child appends one
//    line per phase with `fs.appendFileSync`, the parent polls the file and reads the last
//    complete line. There is no rename and no lock, which removes the Windows `EPERM` that
//    used to kill the child when the parent held the old status file open for reading.
//  * every handshake is polled against a 60 s deadline (status line or the authoritative
//    `runtime_lease` row), never a fixed sleep or a 1鈥? s "settle" window.
//  * a child that never produces a status line is retried a bounded number of times
//    (spawn-level failures only), and every failure message carries the journal, stderr and
//    exit code.
//  * the child's own wake wait reports a terminal `wake-timeout` instead of silently
//    committing while it still owns the lease, so a broken handshake can never pass.

const here = path.dirname(fileURLToPath(import.meta.url));
const dbModule = path.join(here, '..', 'lib', 'db.mjs');
const heartbeatModule = path.join(here, '..', 'lib', 'heartbeat.mjs');
const eventsModule = path.join(here, '..', 'lib', 'events.mjs');
const scopeModule = path.join(here, '..', 'lib', 'scope.mjs');

const T0 = Date.UTC(2026, 9, 30, 0, 0, 0);
const MINUTE = 60000;
const HOUR = 3600000;
const SCOPE_A = Object.freeze({ userId: 'owner-1', personaId: 'march7', worldId: '' });
const KEY_A = keyOfScope(SCOPE_A);

/** Generous handshake deadline: the suite runs ~20 file processes in parallel. */
const HANDSHAKE_MS = 60000;
/** The child's own wake deadline. Longer than the parent's: a slow parent is not a bug. */
const CHILD_WAKE_MS = 90000;
/** Bounded retries for "the OS never started the child", never for a semantic mismatch. */
const SPAWN_ATTEMPTS = 3;

/** The child program: real `openRuntimeDb` + real `createHeartbeat`, fake agenda slots. */
const CHILD_SOURCE = String.raw`
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const sleeper = new Int32Array(new SharedArrayBuffer(4));

function pause(ms) { Atomics.wait(sleeper, 0, 0, ms); }

/**
 * Append one status line to the journal. Append-only on purpose: no rename, no lock, no
 * "publish then replace" window. A reader may observe a partial trailing line and simply
 * ignores it, so the writer can never be blocked by a reader (Windows returns EPERM for a
 * rename onto a file another process has open 鈥?that is exactly what broke the old
 * write-tmp-then-rename protocol under full-suite parallelism).
 */
function publish(base, phase, payload) {
  const journal = base + '.jsonl';
  fs.appendFileSync(journal, JSON.stringify({ phase, at: Date.now(), pid: process.pid, ...payload }) + '\n');
}

/** Poll a file against a deadline (a file that already exists is honoured immediately). */
function waitForFile(target, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(target)) {
    if (Date.now() >= deadline) return false;
    pause(20);
  }
  return true;
}

async function load(key) {
  return import(pathToFileURL(process.env[key]).href);
}

const base = process.env.RUNTIME_OUT;

try {
  const { openRuntimeDb } = await load('RUNTIME_DB_MODULE');
  const { createHeartbeat } = await load('RUNTIME_HEARTBEAT_MODULE');
  const { appendEvent } = await load('RUNTIME_EVENTS_MODULE');
  const { scopeKey } = await load('RUNTIME_SCOPE_MODULE');

  const now = Number(process.env.RUNTIME_NOW);
  const owner = process.env.RUNTIME_OWNER;
  const generation = process.env.RUNTIME_GENERATION;
  const slotKey = process.env.RUNTIME_SLOT_KEY;
  const slotAt = Number(process.env.RUNTIME_SLOT_AT);
  const mode = process.env.RUNTIME_MODE || 'race';
  const wakeMs = Number(process.env.RUNTIME_WAKE_MS || '90000');

  const db = openRuntimeDb({ file: process.env.RUNTIME_DB_FILE, now: () => now });
  const lease = db.acquireLease({ owner, generation, ttlMs: Number(process.env.RUNTIME_TTL) });
  const out = {
    phase: 'result',
    lease: lease.ok === true,
    owner,
    generation,
    visibleOwner: lease.owner ?? null,
    visibleGeneration: lease.generation ?? null,
    expiresAt: lease.expiresAt ?? null,
  };

  const config = {
    enabled: true,
    mode: 'active',
    agenda: { enabled: true, maxItemsPerScope: 8, generationHorizonHours: 72, maxGeneratePerCall: 8 },
    heartbeat: {
      enabled: true, pollIntervalMs: 60000, jitterMs: 0, maxScopesPerCycle: 4, maxDueItemsPerCycle: 8,
      maxNewOccurrencesPerCycle: 8, maxCatchupHorizonHours: 24, maxAttempts: 3, maxTimeBudgetMs: 2000,
      dueRetentionHours: 24, maxRetryBackoffMs: 1800000, activityConsumer: '',
    },
  };

  const agenda = {
    activeAgendaItems(handle, { scopeKey: key, at, limit }) {
      return handle.all("SELECT * FROM agenda_items WHERE scope = ? AND status = 'active' ORDER BY item_id ASC LIMIT ?", key, limit)
        .map(row => ({ itemId: row.item_id, revision: Number(row.revision), rule: row.rule_kind }));
    },
    planWindow({ item }) {
      return [{
        slotKey,
        scheduledAt: slotAt,
        slotEndAt: slotAt + 1800000,
        definitionRevision: item.revision,
        resolution: 'exact',
      }];
    },
    dueAgendaOccurrences() { return []; },
    agendaCounts() { return { items: 0, occurrences: {}, nextOccurrenceAt: null }; },
  };

  const dispatch = event => {
    if (event.kind === 'agenda/occurrence-generated') {
      const payload = event.payload;
      const key = scopeKey(event.scope);
      const occurrenceId = 'occ_' + slotKey;
      db.run('INSERT OR IGNORE INTO agenda_occurrences (occurrence_id, scope, item_id, slot_key, definition_revision, scheduled_at, slot_end_at, status, reason_code, revision, attempts, last_error, causation_event_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        occurrenceId, key, payload.itemId, payload.slotKey, payload.definitionRevision, payload.scheduledAt,
        payload.slotEndAt ?? null, 'scheduled', '', 1, 0, '', event.eventId ?? '', now, now);
      const appended = appendEvent(db, event, { generation });
      return { event: appended.event, inserted: appended.inserted, seq: appended.seq, rejected: false, results: [{ consumer: 'agenda', applied: true }] };
    }
    const appended = appendEvent(db, event, { generation });
    return { event: appended.event, inserted: appended.inserted, seq: appended.seq, rejected: false, results: [{ consumer: 'agenda', applied: true }] };
  };

  const codeOf = outcome => (outcome.ok ? 'ok' : outcome.code);
  const gated = createHeartbeat({ db, config, clock: () => now, owner, generation, dispatch, agenda, isWritable: () => lease.ok === true });
  const hard = createHeartbeat({ db, config, clock: () => now, owner, generation, dispatch, agenda, isWritable: () => true });

  if (mode === 'park') {
    // Take the lease, announce readiness, then fall asleep until the parent wakes us.
    publish(base, 'ready', { phase: 'ready', lease: out.lease, owner, generation, expiresAt: out.expiresAt });
    if (!waitForFile(process.env.RUNTIME_WAKE, wakeMs)) {
      // A handshake that never completes is reported, never silently committed through:
      // a stale worker must not "pass" by running while it still owns the lease.
      out.after = 'wake-timeout';
      out.afterGenerated = 0;
    } else {
      const woken = hard.cycle({ reason: 'woken' });
      out.after = codeOf(woken);
      out.afterGenerated = woken.generated ?? 0;
    }
    publish(base, 'result', out);
  } else {
    const gatedOutcome = gated.cycle({ reason: 'child-gated' });
    out.gated = codeOf(gatedOutcome);
    out.gatedGenerated = gatedOutcome.generated ?? 0;
    const hardOutcome = hard.cycle({ reason: 'child-hard' });
    out.hard = codeOf(hardOutcome);
    out.hardGenerated = hardOutcome.generated ?? 0;
    publish(base, 'result', out);
    // Stay alive until the parent releases us, so both racers provably overlapped.
    if (process.env.RUNTIME_HOLD) waitForFile(process.env.RUNTIME_HOLD, 180000);
  }
} catch (error) {
  try { publish(base, 'result', { phase: 'result', failed: true, error: String((error && error.stack) || error) }); } catch { /* last resort */ }
}
`;

// ---------------------------------------------------------------------------
// parent-side harness
// ---------------------------------------------------------------------------

function tempDir(t, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `runtime-heartbeat-xproc-${label}-`));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });
  return dir;
}

function seedItem(db, itemId) {
  db.run(`INSERT INTO agenda_items (item_id, scope, revision, title, category, source, rule_kind, time_zone,
            local_date, local_time, weekdays, at_utc, valid_from, valid_until, status, authorization, delivery,
            goal_ref, commitment_ref, request_key, resolution, created_at, updated_at)
          VALUES (?, ?, 1, 'cross process schedule', 'plan', 'tool', 'daily', 'Asia/Shanghai', '', '09:00', '[]', NULL, 0, NULL,
            'active', 'plan', 'none', '', '', '', '{}', 0, 0)`, itemId, KEY_A);
}

/** Parent-side bootstrap: schema + authorized scope + one definition, then close. */
function bootstrap(t, label) {
  const dir = tempDir(t, label);
  const file = path.join(dir, 'runtime.db');
  const db = openRuntimeDb({ file, now: () => T0 });
  db.commitProjection({ scope: KEY_A, generation: 'gen-bootstrap', payload: {} });
  seedItem(db, 'item-cross');
  db.close();
  const script = path.join(dir, 'child.mjs');
  fs.writeFileSync(script, CHILD_SOURCE);
  return { dir, file, script };
}

/** Poll a predicate against a deadline; `describe()` explains the timeout. */
async function waitFor(predicate, { timeoutMs = HANDSHAKE_MS, intervalMs = 25, describe = () => '' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value = null;
    try { value = predicate(); } catch { value = null; }
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs} ms: ${describe()}`);
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

function spawnChild({ t, file, script, dir, name, attempt = 1, mode = 'race', now = T0, ttl = 60000, slotKey, slotAt, wake = null, hold = null }) {
  const base = path.join(dir, `${name}.${attempt}.json`);
  const errorLog = path.join(dir, `${name}.${attempt}.stderr.log`);
  const errorFd = fs.openSync(errorLog, 'w');
  const child = spawn(process.execPath, [script], {
    env: {
      ...process.env,
      RUNTIME_DB_MODULE: dbModule,
      RUNTIME_HEARTBEAT_MODULE: heartbeatModule,
      RUNTIME_EVENTS_MODULE: eventsModule,
      RUNTIME_SCOPE_MODULE: scopeModule,
      RUNTIME_DB_FILE: file,
      RUNTIME_NOW: String(now),
      RUNTIME_TTL: String(ttl),
      RUNTIME_OWNER: name,
      RUNTIME_GENERATION: `gen-${name}`,
      RUNTIME_SLOT_KEY: slotKey,
      RUNTIME_SLOT_AT: String(slotAt),
      RUNTIME_MODE: mode,
      RUNTIME_OUT: base,
      RUNTIME_WAKE: wake ?? '',
      RUNTIME_HOLD: hold ?? '',
      RUNTIME_WAKE_MS: String(CHILD_WAKE_MS),
      NODE_NO_WARNINGS: '1',
    },
    stdio: ['ignore', 'ignore', errorFd],
  });
  const entry = {
    name,
    base,
    journal: `${base}.jsonl`,
    errorLog,
    errorFd,
    child,
    attempt,
    exit: null,
    // Resolve on exit **or** on a spawn error: a child that never started must not hang
    // the suite waiting for an 'exit' that will never come.
    done: new Promise(resolve => {
      child.on('exit', (code, signal) => { entry.exit = { code, signal }; resolve(entry.exit); });
      child.on('error', error => { entry.exit = { code: null, signal: null, spawnError: String(error) }; resolve(entry.exit); });
    }),
    readError: () => { try { return fs.readFileSync(errorLog, 'utf8').slice(-1200); } catch { return ''; } },
    readPublished: () => {
      try {
        if (!fs.existsSync(entry.journal)) return '<no journal>';
        return fs.readFileSync(entry.journal, 'utf8').slice(-600) || '<empty journal>';
      } catch { return '<journal unreadable>'; }
    },
  };
  t.after(() => {
    try { child.kill(); } catch { /* already gone */ }
    try { fs.closeSync(errorFd); } catch { /* already closed */ }
  });
  return entry;
}

/** Parse every complete JSONL line; a partial trailing line is simply ignored. */
function readJournalLines(entry) {
  let text = '';
  try {
    if (!fs.existsSync(entry.journal)) return [];
    text = fs.readFileSync(entry.journal, 'utf8');
  } catch {
    return [];
  }
  const lines = [];
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') lines.push(parsed);
    } catch { /* the writer is mid-append: ignore this fragment */ }
  }
  return lines;
}

/** Wait for one published status line (`ready` or `result`) from the child. */
async function waitForPhase(entry, phase) {
  assert.ok(phase === 'ready' || phase === 'result', `unknown phase ${phase}`);
  return waitFor(() => {
    const lines = readJournalLines(entry);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (lines[index].phase === phase) return lines[index];
    }
    return null;
  }, {
    describe: () => `${entry.name} never appended phase "${phase}" (attempt ${entry.attempt}); exit=${JSON.stringify(entry.exit)}; `
      + `journal: ${entry.readPublished()}; stderr: ${entry.readError() || '<empty>'}`,
  });
}

async function finish(entry) {
  const result = await entry.done;
  try { fs.closeSync(entry.errorFd); } catch { /* already closed */ }
  return result;
}

/** Spawn + handshake with bounded retries for a child that never produced a status line. */
async function spawnUntilReady({ label, attempts = SPAWN_ATTEMPTS, build, handshake }) {
  const problems = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const entry = build(attempt);
    try {
      const value = await handshake(entry);
      return { entry, value, attempt, problems };
    } catch (error) {
      problems.push(`attempt ${attempt}: ${error.message}`);
      try { entry.child.kill(); } catch { /* already gone */ }
      await Promise.race([entry.done, new Promise(resolve => setTimeout(resolve, 5000))]);
    }
  }
  throw new Error(`${label} could not be started after ${attempts} attempts:\n${problems.join('\n')}`);
}

function parentHeartbeat({ db, now, generation = 'gen-parent', owner = 'parent-writer', slotKey = 'slot-parent', slotAt }) {
  const agenda = {
    activeAgendaItems(handle, { scopeKey, at, limit }) {
      return handle.all("SELECT * FROM agenda_items WHERE scope = ? AND status = 'active' LIMIT ?", scopeKey, limit)
        .map(row => ({ itemId: row.item_id, revision: Number(row.revision), rule: row.rule_kind }));
    },
    planWindow() {
      return [{ slotKey, scheduledAt: slotAt, slotEndAt: null, definitionRevision: 1, resolution: 'exact' }];
    },
    dueAgendaOccurrences() { return []; },
    agendaCounts() { return { items: 0, occurrences: {}, nextOccurrenceAt: null }; },
  };
  let seq = 0;
  const dispatch = event => {
    seq += 1;
    if (event.kind === 'agenda/occurrence-generated') {
      db.run(`INSERT OR IGNORE INTO agenda_occurrences (occurrence_id, scope, item_id, slot_key, definition_revision, scheduled_at,
                slot_end_at, status, reason_code, revision, attempts, last_error, causation_event_id, created_at, updated_at)
              VALUES (?, ?, ?, ?, 1, ?, NULL, 'scheduled', '', 1, 0, '', '', ?, ?)`,
      `occ_${slotKey}`, KEY_A, event.payload.itemId, event.payload.slotKey, event.payload.scheduledAt, now, now);
    }
    return { event, inserted: true, seq, rejected: false, results: [{ consumer: 'agenda', applied: true }] };
  };
  return createHeartbeat({
    db,
    config: {
      enabled: true, mode: 'active',
      agenda: { enabled: true, generationHorizonHours: 72, maxItemsPerScope: 8, maxGeneratePerCall: 8 },
      heartbeat: {
        enabled: true, pollIntervalMs: 60000, jitterMs: 0, maxScopesPerCycle: 4, maxDueItemsPerCycle: 8,
        maxNewOccurrencesPerCycle: 8, maxCatchupHorizonHours: 24,
      },
    },
    clock: () => now,
    owner,
    generation,
    dispatch,
    agenda,
  });
}

function lifecycle(db) {
  return {
    occurrences: Number(db.get('SELECT COUNT(*) AS n FROM agenda_occurrences').n),
    generatedEvents: Number(db.get("SELECT COUNT(*) AS n FROM domain_events WHERE kind = 'agenda/occurrence-generated'").n),
    cursors: Number(db.get('SELECT COUNT(*) AS n FROM heartbeat_cursor WHERE consumer = ?', HEARTBEAT_CONSUMER).n),
    generation: db.metaGet('generation', ''),
  };
}

// ---------------------------------------------------------------------------
// HH12
// ---------------------------------------------------------------------------

test('HH12: two real processes race for the writer and exactly one commits a cycle', async t => {
  const { dir, file, script } = bootstrap(t, 'race');
  const hold = path.join(dir, 'release');

  const problems = [];
  let race = null;
  for (let attempt = 1; attempt <= SPAWN_ATTEMPTS && !race; attempt += 1) {
    const a = spawnChild({ t, file, script, dir, name: 'worker-a', attempt, hold, slotKey: 'slot-a', slotAt: T0 + HOUR });
    const b = spawnChild({ t, file, script, dir, name: 'worker-b', attempt, hold, slotKey: 'slot-b', slotAt: T0 + HOUR });
    try {
      // Both children publish their own result before either is released, so both were
      // provably alive while the other one tried to become the writer.
      const [resultA, resultB] = await Promise.all([waitForPhase(a, 'result'), waitForPhase(b, 'result')]);
      fs.writeFileSync(hold, 'go');
      const [exitA, exitB] = await Promise.all([finish(a), finish(b)]);
      race = { resultA, resultB, exitA, exitB };
    } catch (error) {
      problems.push(`attempt ${attempt}: ${error.message}`);
      fs.writeFileSync(hold, 'go');
      await Promise.all([finish(a), finish(b)]);
    }
  }
  assert.ok(race, `the race could not be started after ${SPAWN_ATTEMPTS} attempts:\n${problems.join('\n')}`);

  const { resultA, resultB, exitA, exitB } = race;
  for (const [name, payload] of [['worker-a', resultA], ['worker-b', resultB]]) {
    assert.equal(payload.failed, undefined, `${name} failed: ${payload.error ?? ''}`);
    assert.ok(['ok', 'runtime-inactive', 'stale-generation'].includes(payload.gated), `${name} gated=${payload.gated}`);
  }
  for (const [name, exit] of [['worker-a', exitA], ['worker-b', exitB]]) {
    assert.equal(exit.code, 0, `${name} exited with ${exit.code}${exit.spawnError ? ` (${exit.spawnError})` : ''}`);
  }

  const winners = [resultA, resultB].filter(payload => payload.lease === true);
  const losers = [resultA, resultB].filter(payload => payload.lease === false);
  assert.equal(winners.length, 1, JSON.stringify([resultA, resultB]));
  assert.equal(losers.length, 1);
  const winner = winners[0];
  const loser = losers[0];

  assert.equal(winner.gated, 'ok', JSON.stringify(winner));
  assert.equal(winner.gatedGenerated, 1, 'the winner committed one generated instance');
  assert.equal(loser.gated, 'runtime-inactive', 'the loser refuses before writing');
  assert.equal(loser.hard, 'stale-generation', 'the hard gate refuses inside the transaction');
  assert.equal(loser.visibleGeneration, winner.generation, 'the loser sees the winner as the active generation');

  const db = openRuntimeDb({ file, now: () => T0 });
  t.after(() => { try { db.close(); } catch { /* closed */ } });
  const after = lifecycle(db);
  assert.equal(after.occurrences, 1, 'exactly one instance was generated');
  assert.equal(after.generatedEvents, 1);
  assert.equal(after.cursors, 1);
  assert.equal(after.generation, winner.generation);
  const occurrence = db.get('SELECT scope, status FROM agenda_occurrences');
  assert.equal(occurrence.scope, KEY_A);
  assert.equal(occurrence.status, 'scheduled');
});

test('HH12: a worker that wakes after a takeover cannot commit anything', async t => {
  const { dir, file, script } = bootstrap(t, 'sleeper');
  const wake = path.join(dir, 'wake');
  const takeoverAt = T0 + 10 * MINUTE;

  // The parent's handle exists before the child leases, so every precondition below is
  // read from the authoritative store rather than inferred from the clock.
  const db = openRuntimeDb({ file, now: () => takeoverAt });
  t.after(() => { try { db.close(); } catch { /* closed */ } });

  const started = await spawnUntilReady({
    label: 'the parked sleeper',
    build: attempt => spawnChild({
      t, file, script, dir, name: 'sleeper', attempt, mode: 'park',
      now: T0, ttl: 60000, slotKey: 'slot-sleeper', slotAt: T0 + HOUR, wake,
    }),
    handshake: async entry => {
      const ready = await waitForPhase(entry, 'ready');
      // Database-driven precondition: the child really holds the lease row.
      await waitFor(() => {
        const row = db.leaseRow();
        return row && row.owner === 'sleeper' && row.generation === 'gen-sleeper' ? row : null;
      }, { describe: () => `runtime_lease never showed the sleeper; current row: ${JSON.stringify(db.leaseRow())}` });
      return ready;
    },
  });
  const sleeper = started.entry;
  assert.equal(started.value.lease, true, `the sleeper holds the lease before the takeover: ${JSON.stringify(started.value)}`);

  // Take the lease over: the sleeper's 60 s TTL is long gone at T0+10min.
  const owner = 'parent-writer';
  const generation = 'gen-parent';
  const acquired = db.acquireLease({ owner, generation, ttlMs: 60000 });
  assert.equal(acquired.ok, true, `an expired lease is taken over: ${JSON.stringify({ acquired, row: db.leaseRow() })}`);

  const heartbeat = parentHeartbeat({ db, now: takeoverAt, generation, owner, slotAt: takeoverAt + HOUR });
  const live = heartbeat.cycle({ reason: 'takeover' });
  assert.equal(live.ok, true, JSON.stringify(live));
  assert.equal(live.generated, 1, 'the new writer commits its own cycle');

  // Wake the sleeper. The wake file may already be visible to a slow child: it polls and
  // honours it either way, and reports a terminal phase instead of guessing.
  fs.writeFileSync(wake, 'go');
  const woken = await waitForPhase(sleeper, 'result');
  const exit = await finish(sleeper);
  assert.equal(exit.code, 0, `the sleeper exited with ${exit.code}: ${sleeper.readError()}`);
  assert.equal(woken.failed, undefined, woken.error ?? '');
  assert.equal(woken.after, 'stale-generation',
    `a woken stale worker must be fenced out, got "${woken.after}" (a "wake-timeout" means the handshake broke)`);
  assert.equal(woken.afterGenerated, 0);

  const after = lifecycle(db);
  assert.equal(after.occurrences, 1, 'the stale worker added no instance');
  const rows = db.all('SELECT occurrence_id FROM agenda_occurrences');
  assert.deepEqual(rows.map(row => row.occurrence_id), ['occ_slot-parent']);
  assert.equal(after.generation, generation, 'the takeover generation is authoritative');
  assert.equal(db.leaseRow().owner, owner);
  const anchor = JSON.parse(db.get('SELECT page_anchor FROM heartbeat_cursor WHERE scope = ? AND consumer = ?', KEY_A, HEARTBEAT_CONSUMER).page_anchor);
  assert.equal(anchor.failures, 0);
});
