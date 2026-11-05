import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

// P2 blocking-8 leftover: **two real processes**, one database file, real `node:sqlite`.
//
// The claim under test is the single-writer guarantee. A second process must be refused the
// writer role while the first holds it, must be unable to write progress even if it ignores
// that, and must be able to take over — once, cleanly, with no duplicated receipt and no
// replayed interval — after the first one dies without releasing. Nothing here is mocked: the
// fixture processes run the real controller against a real database file on disk.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'p2-writer-fence.mjs');
const DEADLINE_MS = 60000;

function tempRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-fence-'));
  fs.mkdirSync(path.join(dir, 'home/companion'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'home/companion/works'), { recursive: true });
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  return dir;
}

/**
 * Start one fixture process and collect its JSON lines. The child is a real OS process; the
 * test only ever waits on events it emits (no fixed sleeps).
 */
function startChild(root, mode, extraEnv = {}) {
  const child = spawn(process.execPath, [FIXTURE, mode], {
    cwd: path.dirname(path.dirname(HERE)),
    env: { ...process.env, P2_FENCE_ROOT: root, NODE_NO_WARNINGS: '1', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state = { child, lines: [], stderr: '', waiters: [] };
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) {
        try {
          state.lines.push(JSON.parse(line));
        } catch {
          state.lines.push({ event: 'unparsed', line });
        }
        for (const waiter of [...state.waiters]) waiter();
      }
      index = buffer.indexOf('\n');
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { state.stderr += chunk; });
  state.exited = new Promise(resolve => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
  // A child that outlives the test would hang the whole runner, so every child gets a hard
  // deadline and the parent kills it on the way out (test:after, below).
  state.killTimer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } }, DEADLINE_MS + 15000);
  state.killTimer.unref?.();
  state.exited.then(() => clearTimeout(state.killTimer));
  state.waitFor = (event, timeoutMs = DEADLINE_MS) => new Promise((resolve, reject) => {
    const finish = () => {
      const found = state.lines.find(line => line.event === event);
      if (found) { cleanup(); resolve(found); return true; }
      return false;
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error(`timed out waiting for ${event}; stderr=${state.stderr.slice(0, 800)}`)); }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      state.waiters = state.waiters.filter(waiter => waiter !== attempt);
    }
    function attempt() { finish(); }
    if (finish()) return;
    state.waiters.push(attempt);
  });
  return state;
}

/**
 * Inspect the database **without** becoming a writer: a read-only connection cannot take the
 * write lock away from the fixture processes (the studio dashboard reads the same file this
 * way). Migrating here would itself be a write, which is exactly what the fence forbids.
 */
function rows(root) {
  const file = path.join(root, 'home/companion/companion-runtime.db');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    // WAL readers still wait for a writer's brief exclusive moment; never fail on it.
    db.exec('PRAGMA busy_timeout = 5000');
    const all = sql => db.prepare(sql).all();
    const one = sql => db.prepare(sql).get();
    const lease = one('SELECT owner, generation, heartbeat_at, expires_at FROM runtime_lease WHERE lease_id = ?'.replace('?', "'writer'"));
    return {
      lease: lease ? { owner: lease.owner, generation: lease.generation, expiresAt: Number(lease.expires_at) } : null,
      activity: one('SELECT * FROM p2_activities'),
      // start also emits an autonomy/activity event; a *progress* event is the one with
      // phase:'progress'. Counting them separately keeps the claim precise.
      progress: all(`SELECT event_id FROM domain_events WHERE kind = 'autonomy/activity' AND payload LIKE '%"phase":"progress"%' ORDER BY seq`),
      receipts: all("SELECT receipt_id, consumed_from, consumed_to FROM p2_activity_receipts WHERE operation = 'step' ORDER BY consumed_from"),
      events: all('SELECT event_id, kind FROM domain_events ORDER BY seq'),
    };
  } finally {
    db.close();
  }
}

/**
 * Keep the evidence of a failure instead of overwriting it with the next run.
 *
 * The claim under test is about real processes and real leases, so "it went red once" is not enough:
 * we need the assertion, what each child printed, and what the lease looked like at that instant.
 */
function recordFailure(root, children, error, extra = {}) {
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const base = path.join(path.resolve(HERE, '..', '..', '..'), 'logs', 'p2.5', 'fencing-failures');
  const dir = path.join(base, stamp);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'error.txt'), `${String(error?.stack ?? error)}${'\n'}`, 'utf8');
    children.forEach((child, index) => {
      fs.writeFileSync(path.join(dir, `child-${index}.stdout.jsonl`), child.lines.map(line => JSON.stringify(line)).join('\n'), 'utf8');
      fs.writeFileSync(path.join(dir, `child-${index}.stderr.txt`), String(child.stderr ?? ''), 'utf8');
    });
    let snapshot = null;
    try { snapshot = rows(root); } catch (readError) { snapshot = { readFailed: String(readError?.message ?? readError) }; }
    fs.writeFileSync(path.join(dir, 'snapshot.json'), JSON.stringify({ root, snapshot, extra }, null, 2), 'utf8');
    // Keep the newest 20 captures; a failure nobody can look at is not evidence.
    const kept = fs.readdirSync(base, { withFileTypes: true })
      .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
    for (const name of kept.slice(0, Math.max(0, kept.length - 20))) {
      try { fs.rmSync(path.join(base, name), { recursive: true, force: true }); } catch { /* best effort */ }
    }
  } catch { /* evidence must never mask the failure */ }
  return dir;
}

test('P2-08 (blocking-8): two real processes — one writer, a refused second, a clean takeover', async t => {
  const root = tempRoot(t);
  const children = [];
  try {
  t.after(() => { for (const child of children) { try { clearTimeout(child.killTimer); child.child.kill(); } catch { /* already gone */ } } });
  const spawnChild = mode => { const child = startChild(root, mode); children.push(child); return child; };
  const holder = spawnChild('hold');
  const ready = await holder.waitFor('ready');
  assert.ok(ready.activityId, 'the first process really started an activity');
  assert.ok(ready.consumed > 0, 'and consumed a real window');

  // The holder is alive and holds the lease.
  const during = rows(root);
  assert.ok(during.lease, 'the lease row exists');
  assert.equal(during.lease.owner, `${holder.child.pid}:fence`);
  assert.equal(during.lease.generation, ready.generation);
  assert.equal(during.progress.length, 1, 'exactly one progress event so far');

  // A second real process starts against the same database.
  const worker = spawnChild('worker');
  const first = await worker.waitFor('first-attempt');
  assert.equal(first.ok, false, 'the second process is refused the writer role');
  assert.equal(first.holder.generation, ready.generation, 'the refusal names the current writer');

  const attempt = await worker.waitFor('write-attempt');
  assert.equal(attempt.ok, false, 'it cannot write progress either');
  assert.match(String(attempt.code), /generation|stale/iu, `the store refused the write by generation (${attempt.code})`);
  assert.equal(attempt.consumed, ready.consumed, 'the refused writer changed nothing');

  // Kill the holder without letting it release the lease.
  holder.child.kill();
  const killed = await holder.exited;
  assert.ok(killed.code !== 0 || killed.signal !== null, 'the holder did not exit cleanly');
  // One ordered observation, recorded so a failure can be read afterwards:
  //   1) what the worker had already reported (stdout), taken first;
  //   2) then the database.
  // Anything that depends on the interleaving is written down, not inferred.
  const tookOverBeforeRead = worker.lines.some(line => line.event === 'took-over');
  const workerGeneration = String(worker.lines.find(line => line.event === 'took-over')?.generation ?? '');
  const afterKill = rows(root);
  assert.ok(afterKill.lease, 'the dead process left its lease behind (that is the crash case)');
  if (tookOverBeforeRead) {
    // The worker already holds the writer role: the lease must name **its** generation, not just
    // "something else than the old one".
    assert.equal(afterKill.lease.generation, workerGeneration, 'the lease names the worker\'s own generation');
  } else {
    assert.equal(afterKill.lease.generation, ready.generation, 'and it is still marked as the old generation');
  }
  t.diagnostic(`takeover raced the read: ${tookOverBeforeRead}`);

  // A late write **from the dead generation** must be refused. The killed process cannot try, so a
  // third real process impersonates it (mode `stale`): it takes no lease and only attempts a progress
  // write through the same activities API, which is the path a resurrected writer would use.
  {
    const stale = startChild(root, 'stale', { P2_FENCE_GENERATION: String(ready.generation) });
    children.push(stale);
    const lateWrite = await stale.waitFor('stale-write', 30000);
    assert.equal(lateWrite.ok, false, `a write stamped with the dead generation must be refused (got ${JSON.stringify(lateWrite)})`);
    assert.match(String(lateWrite.code), /generation|stale|lease|owner/iu, `the store refused it by generation (${lateWrite.code})`);
    // Observed **inside** the stale process: the prefix before and after its own attempt.
    assert.equal(lateWrite.consumedAfter, lateWrite.consumedBefore, 'and the refused write changed nothing');
  }
  // The second process takes over through the runtime's own takeover path.
  const tookOver = await worker.waitFor('took-over', 30000);
  assert.equal(tookOver.ok, undefined);
  assert.notEqual(tookOver.generation, ready.generation, 'the takeover holds a new generation');
  const done = await worker.waitFor('done', 30000);
  const exit = await worker.exited;
  assert.equal(exit.code, 0, `the worker exited cleanly (stderr=${worker.stderr.slice(0, 400)})`);

  // Exactly one further progress event, continuing where the dead process stopped.
  assert.equal(done.continuedFrom, ready.consumed, 'the takeover continues at the recorded prefix');
  assert.ok(done.consumedAfter > done.consumedBefore);
  assert.equal(done.progressEvents, 2, 'exactly one further progress event');
  assert.equal(new Set(done.eventIds).size, done.eventIds.length, 'no event id repeats');

  // One receipt per interval, never a duplicate.
  assert.equal(done.receipts.length, 2, 'two step receipts, one per consumed interval');
  assert.equal(new Set(done.receipts.map(receipt => receipt.id)).size, 2, 'receipt ids are unique');
  assert.deepEqual(
    done.receipts.map(receipt => [receipt.from, receipt.to]),
    [[0, ready.consumed], [ready.consumed, done.consumedAfter]],
    'the intervals tile without overlap or gap',
  );

  // Recovery replays the event log and agrees with the live tables.
  assert.equal(done.recovery.ok, true, JSON.stringify(done.recovery).slice(0, 900));
  assert.equal(done.recovery.mismatches, 0, 'verifyRecovery reports mismatches:0');
  assert.ok(done.recovery.replayed >= 3, 'it replayed the real event log');

  // And the final on-disk state is what the last writer said it was.
  const final = rows(root);
  assert.equal(Number(final.activity.consumed_prefix), done.consumedAfter);
  assert.equal(final.progress.length, 2);
  assert.equal(final.lease, null, 'the clean worker released the lease on the way out');
  assert.equal(final.receipts.length, 2);
  } catch (error) {
    // Persist the evidence first — a re-run overwrites everything, and a bare "it was red once"
    // cannot tell a scheduling hiccup from a real fencing bug.
    recordFailure(root, children, error);
    throw error;
  }
});

test('P2-08b: 提交时围栏 —— 已通过入口的操作在接管后提交必须被拒', async t => {
  const root = tempRoot(t);
  const children = [];
  t.after(() => {
    for (const child of children) { try { clearTimeout(child.killTimer); child.child.kill(); } catch { /* already gone */ } }
    for (const name of ['sentinel', 'taker-stop']) { try { fs.rmSync(path.join(root, name), { force: true }); } catch { /* best effort */ } }
  });
  const spawnChild = (mode, extraEnv = {}) => { const child = startChild(root, mode, extraEnv); children.push(child); return child; };

  // 1) A real writer takes the lease with a short TTL and parks **inside** the port, i.e. after the
  //    entry gate has already said yes.
  const parked = spawnChild('parked');
  const parkedAt = await parked.waitFor('step-parked', 30000);
  assert.ok(parkedAt.activityId, 'the parked operation really started an activity');

  // 2) A second real process waits for that lease to expire and takes it over, then **holds** it —
  //    that is the barrier: from here on the first process can never be the writer again.
  await parked.waitFor('lease-let-go', 30000);
  const taker = spawnChild('taker');
  const tookOver = await taker.waitFor('took-over', 30000);
  assert.ok(tookOver.generation, 'the takeover happened while the first operation was parked');
  assert.notEqual(tookOver.generation, parkedAt.generation, 'and it is a different generation');

  // 3) Release the parked operation: it now reaches the real dispatch/submit path.
  fs.writeFileSync(path.join(root, 'sentinel'), 'go', 'utf8');
  const commit = await parked.waitFor('commit-attempt', 30000);
  assert.equal(commit.ok, false, `the late commit must be refused (got ${JSON.stringify(commit)})`);
  assert.match(String(commit.code), /generation|stale|lease|owner/iu, `and refused by the fence (${commit.code})`);
  assert.equal(commit.consumedAfter, commit.consumedBefore,
    'the refused commit changed nothing on disk (observed inside the same process)');

  // 4) Nothing was written by the stale operation: the progress count is whatever the takeover left.
  const after = rows(root);
  assert.equal(after.lease.generation, tookOver.generation, 'the lease still names the takeover generation');

  // 5) The barrier was maintained by real renewals (production uses `heartbeatLease`), not by a lucky
  //    `acquireLease` loop that ignored its own result.
  // 6) Let the taker go so the test can finish cleanly.
  fs.writeFileSync(path.join(root, 'taker-stop'), 'stop', 'utf8');
  const renewals = await taker.waitFor('taker-renewals', 30000);
  assert.equal(renewals.renewFailures, 0, `the barrier never lost the lease (got ${JSON.stringify(renewals)})`);
  assert.equal(renewals.renewals >= 1, true, 'and it really renewed');
  await taker.waitFor('taker-done', 30000);
});
