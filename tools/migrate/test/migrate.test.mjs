/**
 * Offline tests for the migration CLI.
 *
 * Everything runs against a throwaway data directory pointed to by
 * `DSH_COMPANION_DATA_DIR`; the real suite data directory is never touched and no
 * network call is made. `node --test` (no dependencies).
 *
 * Run:  node --test tools/migrate/test/migrate.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, before, after } from 'node:test';

import { parseArgs, runMigrateCli, EXIT } from '../cli.mjs';
import { loadSqlite } from '../sqlite.mjs';

let sqliteAvailable = false;
try {
  const sqlite = await loadSqlite();
  sqliteAvailable = Boolean(sqlite?.DatabaseSync);
} catch {
  sqliteAvailable = false;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-migrate-test-'));
const dataA = path.join(root, 'data-a');
const dataB = path.join(root, 'data-b');

function silence() {
  const out = [];
  const err = [];
  return {
    out,
    err,
    io: {
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
    },
  };
}

function run(argv, env) {
  const sink = silence();
  return runMigrateCli(argv, { ...sink.io, env }).then((code) => ({
    code,
    json: JSON.parse(sink.out.join('') || '{}'),
    stderr: sink.err.join(''),
  }));
}

async function makeSqlite(file, rows) {
  const sqlite = await loadSqlite();
  if (!sqlite?.DatabaseSync) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new sqlite.DatabaseSync(file);
  try {
    db.exec('CREATE TABLE memories (id INTEGER PRIMARY KEY, persona TEXT NOT NULL, body TEXT)');
    db.exec('PRAGMA user_version = 1');
    const insert = db.prepare('INSERT INTO memories (persona, body) VALUES (?, ?)');
    for (const row of rows) insert.run(row.persona, row.body);
  } finally {
    db.close();
  }
  return true;
}

function seedData(dir, { ownerId, persona = 'legacy-x', reminderId = 'r_1' }) {
  fs.mkdirSync(path.join(dir, 'home', 'companion'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'home', 'memory'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'home', 'channel-qq'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'workspace'), { recursive: true });

  fs.writeFileSync(
    path.join(dir, 'home', 'companion', 'identity.json'),
    JSON.stringify({
      schemaVersion: 1,
      persona,
      owner: { id: ownerId, platform: 'qq', displayName: 'tester' },
      desktop: { mode: 'local-owner', userId: ownerId },
      sessions: { 'session-a': { userId: ownerId, persona, channel: 'desktop' } },
      boundAt: '2026-01-01T00:00:00.000Z',
    }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, 'home', 'channel-qq', 'reminders.json'),
    JSON.stringify({ version: 1, reminders: [{ id: reminderId, text: '鏃ф彁閱?, at: 1, room: 'dm', target: ownerId, fired: false }] }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, 'home', 'channel-qq', `sent-dm-${ownerId}.json`),
    JSON.stringify([{ messageId: 1, quotedId: null, text: '涓嶈琚鍑虹殑姝ｆ枃', time: 100 }]),
    'utf8',
  );
}

before(async () => {
  seedData(dataA, { ownerId: 10001 });
  seedData(dataB, { ownerId: 20002, reminderId: 'r_local' });
  if (sqliteAvailable) {
    await makeSqlite(path.join(dataA, 'home', 'memory', 'companion-memory.db'), [
      { persona: 'legacy-x', body: 'a' },
      { persona: 'legacy-x', body: 'b' },
    ]);
  }
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test('parseArgs: rejects unknown command, unknown flag, bad identity value', () => {
  assert.equal(parseArgs(['nope']).errors.length, 1);
  assert.equal(parseArgs(['export', '--wat']).errors.length, 1);
  assert.equal(parseArgs(['import', '--identity', 'merge']).errors.length, 1);
  assert.equal(parseArgs(['import', '--identity', 'adopt']).identity, 'adopt');
  assert.equal(parseArgs(['export', '--out', 'x']).out, 'x');
  assert.equal(parseArgs(['check', '--from=x']).from, 'x');
});

test('export: refuses credentials domain with exit 2 and never writes', async () => {
  const dir = path.join(root, 'forbidden-out');
  const result = await run(['export', '--out', dir, '--domains', 'credentials'], {
    ...process.env,
    DSH_COMPANION_DATA_DIR: dataA,
  });
  assert.equal(result.code, EXIT.invalid);
  assert.equal(result.json.ok, false);
  assert.equal(result.json.error.code, 'forbidden-domain');
  assert.equal(fs.existsSync(dir), false);
});

test('export: writes a bundle, redacts identity sessions and message bodies', async () => {
  const outDir = path.join(root, 'bundle-1');
  const result = await run(['export', '--out', outDir], { ...process.env, DSH_COMPANION_DATA_DIR: dataA });
  assert.equal(result.code, EXIT.ok, JSON.stringify(result.json.problems ?? result.json.error));
  assert.equal(result.json.ok, true);

  const bundle = JSON.parse(fs.readFileSync(path.join(outDir, 'bundle.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'MANIFEST.json'), 'utf8'));
  assert.equal(bundle.format, 'dsh-companion-migration');
  assert.equal(bundle.formatVersion, 1);
  assert.ok(manifest.files.length >= 3);
  for (const entry of manifest.files) {
    assert.match(entry.sha256, /^[0-9a-f]{64}$/);
  }

  const identity = JSON.parse(fs.readFileSync(path.join(outDir, 'domains', 'identity', 'identity.json'), 'utf8'));
  assert.equal(identity.sessions, undefined, '浼氳瘽缁戝畾涓嶅緱杩涘叆杩佺Щ鍖?);
  assert.ok(bundle.source.identityFingerprint.startsWith('sha256:'));

  const suppression = JSON.parse(fs.readFileSync(path.join(outDir, 'domains', 'qq', 'suppression.json'), 'utf8'));
  assert.deepEqual(suppression.entries, [{ messageId: 1, time: 100 }]);
  assert.doesNotMatch(JSON.stringify(suppression), /涓嶈琚鍑虹殑姝ｆ枃/);

  const reminders = JSON.parse(fs.readFileSync(path.join(outDir, 'domains', 'reminders', 'reminders.json'), 'utf8'));
  assert.equal(reminders.reminders[0].fired, true);
  assert.equal(reminders.reminders[0].paused, true);

  assert.ok(!JSON.stringify(manifest).includes('credentials'));
});

test('check: passes on a fresh bundle and reports the plan', async () => {
  const result = await run(['check', '--from', path.join(root, 'bundle-1')], {
    ...process.env,
    DSH_COMPANION_DATA_DIR: dataB,
  });
  assert.equal(result.code, EXIT.refused, '韬唤涓嶅悓搴斿綋瑕佹眰鎿嶄綔鑰呰鍐?);
  assert.equal(result.json.ok, false);
  assert.ok(result.json.conflicts.identity.length >= 1);
});

test('check: rejects a tampered bundle with exit 2', async () => {
  const tampered = path.join(root, 'bundle-tampered');
  fs.cpSync(path.join(root, 'bundle-1'), tampered, { recursive: true });
  const target = path.join(tampered, 'domains', 'identity', 'identity.json');
  fs.writeFileSync(target, `${fs.readFileSync(target, 'utf8')}\n`, 'utf8');
  const result = await run(['check', '--from', tampered], { ...process.env, DSH_COMPANION_DATA_DIR: dataA });
  assert.equal(result.code, EXIT.invalid);
  assert.ok(result.json.problems.some((item) => item.code === 'checksum-mismatch' || item.code === 'size-mismatch'));
});

test('import --dry-run: writes nothing', async () => {
  const before = fs.readFileSync(path.join(dataB, 'home', 'companion', 'identity.json'), 'utf8');
  const result = await run(
    ['import', '--from', path.join(root, 'bundle-1'), '--dry-run'],
    { ...process.env, DSH_COMPANION_DATA_DIR: dataB },
  );
  assert.equal(result.code, EXIT.refused, '韬唤鏈鍐虫椂蹇呴』鍏堟嫆缁?);
  const withIdentity = await run(
    ['import', '--from', path.join(root, 'bundle-1'), '--dry-run', '--identity', 'adopt'],
    { ...process.env, DSH_COMPANION_DATA_DIR: dataB },
  );
  assert.equal(withIdentity.code, EXIT.ok, JSON.stringify(withIdentity.json.error));
  assert.equal(withIdentity.json.dryRun, true);
  assert.equal(fs.readFileSync(path.join(dataB, 'home', 'companion', 'identity.json'), 'utf8'), before);
});

test('import: backs up first, adopts identity, maps persona id, never replays reminders', async () => {
  const result = await run(
    ['import', '--from', path.join(root, 'bundle-1'), '--identity', 'adopt'],
    { ...process.env, DSH_COMPANION_DATA_DIR: dataB },
  );
  assert.equal(result.code, EXIT.ok, JSON.stringify(result.json.error ?? result.json.warnings));
  assert.equal(result.json.ok, true);

  const backupDir = result.json.backup.dir;
  assert.ok(fs.existsSync(backupDir), '蹇呴』瀛樺湪 pre-import 澶囦唤鐩綍');
  assert.ok(fs.existsSync(path.join(backupDir, 'home', 'companion', 'identity.json')));

  const identity = JSON.parse(fs.readFileSync(path.join(dataB, 'home', 'companion', 'identity.json'), 'utf8'));
  assert.equal(identity.persona, 'bot', '浜烘牸 id 蹇呴』鏄犲皠涓虹洰鏍?id');
  assert.ok(identity.sessions, '鏈満浼氳瘽缁戝畾蹇呴』淇濈暀');
  assert.ok(Object.keys(identity.sessions).length >= 1);

  const reminders = JSON.parse(fs.readFileSync(path.join(dataB, 'home', 'channel-qq', 'reminders.json'), 'utf8'));
  const importedReminder = reminders.reminders.find((item) => item.id === 'r_1');
  assert.ok(importedReminder, '瀵煎叆鐨勬彁閱掓潯鐩繀椤诲瓨鍦?);
  assert.equal(importedReminder.fired, true, '瀵煎叆鐨勬彁閱掑繀椤荤疆涓哄凡鍙戯紝缁濅笉琛ュ彂');
  assert.equal(importedReminder.paused, true);
  const localReminder = reminders.reminders.find((item) => item.id === 'r_local');
  assert.equal(localReminder.fired, false, '鏈満鍘熸湁鎻愰啋涓嶅彈瀵煎叆褰卞搷');
  assert.ok(result.json.notReplayed.some((item) => item.kind === 'reminder'));

  const rebindKinds = new Set(result.json.rebind.map((item) => item.kind));
  for (const kind of ['path', 'auth', 'device', 'service']) assert.ok(rebindKinds.has(kind), `rebind 缂?${kind}`);

  if (sqliteAvailable) {
    assert.equal(result.json.personaMapping.from, 'legacy-x');
    assert.equal(result.json.personaMapping.to, 'bot');
    const rows = result.json.personaMapping.targets.reduce((sum, item) => sum + item.rows, 0);
    assert.ok(rows >= 2, `搴斿綋鏀瑰啓 2 琛?persona 鍒楋紝瀹為檯 ${rows}`);
  }

  assert.ok(fs.existsSync(result.json.report), '蹇呴』鍐欏鍏ユ姤鍛?);
  const report = JSON.parse(fs.readFileSync(result.json.report, 'utf8'));
  assert.equal(report.dryRun, false);
  assert.equal(report.identityMode, 'adopt');
});

test('import: refuses while a launcher record still points at a live pid', async () => {
  const logs = path.join(dataB, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  // Start-Desktop.ps1 writes this record; a live pid means the profile is in use.
  const record = path.join(logs, 'desktop-launch.json');
  fs.writeFileSync(record, JSON.stringify({ pid: process.pid, launchedAt: new Date().toISOString() }), 'utf8');
  try {
    const result = await run(
      ['import', '--from', path.join(root, 'bundle-1'), '--identity', 'adopt'],
      { ...process.env, DSH_COMPANION_DATA_DIR: dataB },
    );
    assert.equal(result.code, EXIT.refused);
    assert.equal(result.json.error.code, 'host-running');
    assert.ok(result.json.conflicts.running.length >= 1);
  } finally {
    fs.rmSync(record, { force: true });
  }
});

test('detectLiveHost: a fresh WAL is treated as "database still open"', async () => {
  const db = path.join(dataB, 'home', 'memory', 'companion-memory.db');
  fs.mkdirSync(path.dirname(db), { recursive: true });
  fs.writeFileSync(db, '');
  fs.writeFileSync(`${db}-wal`, 'x');
  const { buildContext, detectLiveHost } = await import('../context.mjs');
  const ctx = buildContext({ ...process.env, DSH_COMPANION_DATA_DIR: dataB });
  const live = detectLiveHost(ctx, { walWindowMs: 60_000 });
  assert.equal(live.live, true);
  assert.ok(live.signals.some((item) => item.kind === 'wal'));
  fs.rmSync(`${db}-wal`, { force: true });
});

test('help: exits with a JSON document and a usage string', async () => {
  const result = await run(['help'], process.env);
  assert.equal(result.code, EXIT.ok);
  assert.equal(result.json.ok, true);
  assert.match(result.json.usage, /npm run migrate/);
});

