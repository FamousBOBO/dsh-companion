import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openRuntimeDb } from '../lib/db.mjs';

// A real second process, not a second handle: the single-writer claim is only worth
// anything if another OS process cannot take the lease while ours is alive.
// Children communicate through files because piped stdio is restricted in the
// sandbox; they never touch the network.

const here = path.dirname(fileURLToPath(import.meta.url));
const dbModule = path.join(here, '..', 'lib', 'db.mjs');

function childScript() {
  return `
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const { openRuntimeDb } = await import(pathToFileURL(process.env.RUNTIME_DB_MODULE).href);
const db = openRuntimeDb({ file: process.env.RUNTIME_DB_FILE, now: () => Number(process.env.RUNTIME_NOW) });
const lease = db.acquireLease({ owner: process.env.RUNTIME_OWNER, generation: process.env.RUNTIME_GENERATION, ttlMs: 60000 });
const out = { ok: lease.ok === true, generation: lease.generation ?? null, owner: lease.owner ?? null, current: db.currentGeneration() };
if (lease.ok) {
  try {
    db.tx(() => {
      db.run("INSERT INTO runtime_meta (meta_key, meta_value, updated_at) VALUES ('child-probe', '1', 1) ON CONFLICT(meta_key) DO UPDATE SET meta_value = '1'");
      db.assertWritable(process.env.RUNTIME_GENERATION);
    });
    out.commit = 'ok';
  } catch (error) {
    out.commit = error.code ?? 'failed';
  }
  db.releaseLease(process.env.RUNTIME_GENERATION, process.env.RUNTIME_OWNER);
}
db.close();
fs.writeFileSync(process.env.RUNTIME_OUT + '.tmp', JSON.stringify(out));
fs.renameSync(process.env.RUNTIME_OUT + '.tmp', process.env.RUNTIME_OUT);
`;
}

async function runChild({ file, owner, generation, out, now = Date.now() }) {
  const script = childScript();
  const errorLog = `${out}.stderr.log`;
  const errorFd = fs.openSync(errorLog, 'w');
  try {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: {
        ...process.env,
        RUNTIME_DB_MODULE: dbModule,
        RUNTIME_DB_FILE: file,
        RUNTIME_OWNER: owner,
        RUNTIME_GENERATION: generation,
        RUNTIME_NOW: String(now),
        RUNTIME_OUT: out,
        NODE_NO_WARNINGS: '1',
      },
      stdio: ['ignore', 'ignore', errorFd],
    });
    const code = await new Promise(resolve => child.on('exit', resolve));
    const result = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : { failed: true, code };
    if (result.failed) {
      result.stderr = fs.existsSync(errorLog) ? fs.readFileSync(errorLog, 'utf8').slice(-800) : '';
    }
    return result;
  } finally {
    try { fs.closeSync(errorFd); } catch { /* already closed */ }
  }
}

function tempFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-xproc-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });
  return { dir, file: path.join(dir, 'runtime.db') };
}

test('A10: another OS process cannot steal a live lease and its commit is refused', async t => {
  const { dir, file } = tempFile(t);
  const now = Date.now();
  const parent = openRuntimeDb({ file, now: () => now });
  assert.equal(parent.acquireLease({ owner: 'parent', generation: 'gen-parent', ttlMs: 60000 }).ok, true);

  const child = await runChild({ file, owner: 'child', generation: 'gen-child', out: path.join(dir, 'child.json'), now });
  assert.equal(child.ok, false, JSON.stringify(child));
  assert.equal(child.owner, 'parent');
  assert.equal(child.current, 'gen-parent');

  parent.releaseLease('gen-parent', 'parent');
  const second = await runChild({ file, owner: 'child', generation: 'gen-child', out: path.join(dir, 'child2.json'), now });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.commit, 'ok', 'the new generation can commit after taking over');

  // Our handle is now stale: it must not commit behind the child's back.
  const eventScope = 'u:owner-1|p:bot|w:world:default';
  assert.throws(
    () => parent.commitProjection({ scope: eventScope, generation: 'gen-parent', payload: {} }),
    /no longer the writer/,
  );
  parent.close();
});

test('A10: two child processes racing for the lease — exactly one wins', async t => {
  const { dir, file } = tempFile(t);
  const now = Date.now();
  const bootstrap = openRuntimeDb({ file, now: () => now });
  bootstrap.close(); // schema only, no lease

  // Both children start together and hold their lease until the parent releases them,
  // so a "win" really means "won while the other was running".
  const releaseFile = path.join(dir, 'release');
  const holdScript = childScript().replace(
    '  db.releaseLease(process.env.RUNTIME_GENERATION, process.env.RUNTIME_OWNER);',
    `  // Publish the decision atomically (temp + rename) so the parent never reads a
  // half-written file under concurrent load.
  fs.writeFileSync(process.env.RUNTIME_OUT + '.tmp', JSON.stringify(out));
  fs.renameSync(process.env.RUNTIME_OUT + '.tmp', process.env.RUNTIME_OUT);
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(process.env.RUNTIME_RELEASE) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  db.releaseLease(process.env.RUNTIME_GENERATION, process.env.RUNTIME_OWNER);`,
  );
  const spawnHold = (owner, generation, out) => {
    const errorFd = fs.openSync(`${out}.stderr.log`, 'w');
    const child = spawn(process.execPath, ['--input-type=module', '-e', holdScript], {
      env: {
        ...process.env,
        RUNTIME_DB_MODULE: dbModule,
        RUNTIME_DB_FILE: file,
        RUNTIME_OWNER: owner,
        RUNTIME_GENERATION: generation,
        RUNTIME_NOW: String(now),
        RUNTIME_OUT: out,
        RUNTIME_RELEASE: releaseFile,
        NODE_NO_WARNINGS: '1',
      },
      stdio: ['ignore', 'ignore', errorFd],
    });
    // Attach the exit listener immediately: a child that loses the race can exit
    // before the parent gets around to awaiting it.
    const exited = new Promise(resolve => child.on('exit', resolve));
    return { child, out, errorFd, exited };
  };
  const a = spawnHold('A', 'gen-a', path.join(dir, 'a.json'));
  const b = spawnHold('B', 'gen-b', path.join(dir, 'b.json'));
  const waitForFile = async (target, timeoutMs = 10000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (fs.existsSync(target)) return JSON.parse(fs.readFileSync(target, 'utf8'));
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return null;
  };
  const [resultA, resultB] = await Promise.all([waitForFile(a.out), waitForFile(b.out)]);
  fs.writeFileSync(releaseFile, 'go');
  await Promise.all([a.exited, b.exited]);
  for (const entry of [a, b]) { try { fs.closeSync(entry.errorFd); } catch { /* closed */ } }

  const winners = [resultA, resultB].filter(result => result?.ok === true);
  assert.equal(winners.length, 1, JSON.stringify({ resultA, resultB }));
  const loser = [resultA, resultB].find(result => result?.ok === false);
  assert.equal(loser.current, winners[0].generation, 'the loser sees the winner as the active generation');
  const db = openRuntimeDb({ file, now: () => now });
  assert.equal(db.get('SELECT COUNT(*) AS n FROM runtime_lease').n, 0, 'the winner released its lease');
  db.close();
});

test('A10: the lease latch survives a restart of the process group', async t => {
  const { dir, file } = tempFile(t);
  const now = Date.now();
  const first = openRuntimeDb({ file, now: () => now });
  first.acquireLease({ owner: 'A', generation: 'gen-a', ttlMs: 60000 });
  first.close();

  // Same wall clock: the lease is still live for a fresh handle in another process.
  const blocked = await runChild({ file, owner: 'B', generation: 'gen-b', out: path.join(dir, 'blocked.json'), now });
  assert.equal(blocked.ok, false, JSON.stringify(blocked));

  // After expiry a fresh process may take over.
  const takeover = await runChild({ file, owner: 'B', generation: 'gen-b', out: path.join(dir, 'takeover.json'), now: now + 61000 });
  assert.equal(takeover.ok, true, JSON.stringify(takeover));
});
