import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAuth, AuthError } from '../auth.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vc-auth-'));
}

/** A fake VoceChat that rotates refresh tokens exactly like the real one does. */
function fakeServer({ failFirst = 0, rejectAll = false } = {}) {
  let calls = 0;
  let refresh = 'R0';
  const log = [];
  const fetchImpl = async (url, init) => {
    calls += 1;
    log.push({ url, body: init?.body });
    if (rejectAll || calls <= failFirst) {
      return { ok: false, status: 401, text: async () => 'authorization error', json: async () => ({}) };
    }
    const body = JSON.parse(init.body);
    // The real server rotates: the presented refresh token is replaced by a new one.
    refresh = `R${calls}`;
    return {
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ token: `A${calls}`, refresh_token: refresh, expired_in: 300 }),
    };
  };
  return { fetchImpl, log, calls: () => calls, refreshNow: () => refresh };
}

test('a fresh auth renews once and hands out a token', async () => {
  const dir = tempDir();
  const cred = path.join(dir, 'cred.json');
  fs.writeFileSync(cred, JSON.stringify({ refreshToken: 'R0' }));

  const server = fakeServer();
  const auth = createAuth({
    baseUrl: 'http://127.0.0.1:3009',
    uid: 4,
    credentialFile: cred,
    fetchImpl: server.fetchImpl,
  });

  const token = await auth.token();
  assert.equal(token, 'A1');
  assert.equal(server.calls(), 1);
  // The rotated refresh token must be written back: the next renew needs the newest value.
  const persisted = JSON.parse(fs.readFileSync(cred, 'utf8'));
  assert.equal(persisted.refreshToken, 'R1');
});

test('a token that is still valid is reused, not renewed again', async () => {
  const dir = tempDir();
  const cred = path.join(dir, 'cred.json');
  fs.writeFileSync(cred, JSON.stringify({ refreshToken: 'R0' }));

  const server = fakeServer();
  const auth = createAuth({ baseUrl: 'http://x', uid: 4, credentialFile: cred, fetchImpl: server.fetchImpl });
  await auth.token();
  await auth.token();
  await auth.token();
  // expired_in=300 → valid for 240 s, so three immediate calls must be one renew.
  assert.equal(server.calls(), 1);
});

test('concurrent callers share a single renewal (two renews would invalidate each other)', async () => {
  const dir = tempDir();
  const cred = path.join(dir, 'cred.json');
  fs.writeFileSync(cred, JSON.stringify({ refreshToken: 'R0' }));

  const server = fakeServer();
  const auth = createAuth({ baseUrl: 'http://x', uid: 4, credentialFile: cred, fetchImpl: server.fetchImpl });

  // The refresh token is single-use in the real server: a second concurrent renew would fail.
  const [a, b, c] = await Promise.all([auth.token(), auth.token(), auth.token()]);
  assert.equal(server.calls(), 1, 'three concurrent callers must produce one renewal');
  assert.equal(a, b);
  assert.equal(b, c);
});

test('refreshNow forces a renewal even with a locally valid token', async () => {
  const dir = tempDir();
  const cred = path.join(dir, 'cred.json');
  fs.writeFileSync(cred, JSON.stringify({ refreshToken: 'R0' }));

  const server = fakeServer();
  const auth = createAuth({ baseUrl: 'http://x', uid: 4, credentialFile: cred, fetchImpl: server.fetchImpl });
  await auth.token();
  const before = server.calls();
  const forced = await auth.refreshNow();
  assert.equal(server.calls(), before + 1);
  assert.equal(forced, `A${before + 1}`);
});

test('a rejected refresh token surfaces as refresh-token-rejected, not a generic error', async () => {
  const dir = tempDir();
  const cred = path.join(dir, 'cred.json');
  fs.writeFileSync(cred, JSON.stringify({ refreshToken: 'bad' }));

  const auth = createAuth({
    baseUrl: 'http://x', uid: 4, credentialFile: cred, fetchImpl: fakeServer({ rejectAll: true }).fetchImpl,
  });
  await assert.rejects(auth.token(), error => {
    assert.ok(error instanceof AuthError);
    assert.equal(error.code, 'refresh-token-rejected');
    assert.equal(error.status, 401);
    return true;
  });
});

test('a network failure is a named code, not a crash', async () => {
  const dir = tempDir();
  const cred = path.join(dir, 'cred.json');
  fs.writeFileSync(cred, JSON.stringify({ refreshToken: 'R0' }));

  const auth = createAuth({
    baseUrl: 'http://x', uid: 4, credentialFile: cred,
    fetchImpl: async () => { throw new TypeError('fetch failed'); },
  });
  await assert.rejects(auth.token(), error => error.code === 'network');
});

test('with no refresh token anywhere, the error says so instead of pretending to work', async () => {
  const auth = createAuth({ baseUrl: 'http://x', uid: 4, fetchImpl: fakeServer().fetchImpl });
  await assert.rejects(auth.token(), error => error.code === 'no-refresh-token');
});

test('a bad baseUrl is refused before any network call', async () => {
  const dir = tempDir();
  const cred = path.join(dir, 'cred.json');
  fs.writeFileSync(cred, JSON.stringify({ refreshToken: 'R0' }));
  const server = fakeServer();
  const auth = createAuth({ baseUrl: '', uid: 4, credentialFile: cred, fetchImpl: server.fetchImpl });
  await assert.rejects(auth.token(), error => error.code === 'not-configured');
  assert.equal(server.calls(), 0);
});

test('a database source is read when no credential file is given', async () => {
  const dir = tempDir();
  const dbFile = path.join(dir, 'db.sqlite');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbFile);
  db.exec(`create table refresh_token (uid integer, device text, token text, updated_at integer, primary key (uid, device))`);
  db.prepare('insert into refresh_token (uid, device, token, updated_at) values (?,?,?,?)').run(4, 'dsh-course', 'RD1', 1);
  db.close();

  const server = fakeServer();
  const auth = createAuth({ baseUrl: 'http://x', uid: 4, dbFile, fetchImpl: server.fetchImpl });
  const token = await auth.token();
  assert.equal(token, 'A1');
  assert.equal(auth.describe().source, 'vocechat-db');
  // The presented refresh token must be the one from the database.
  assert.equal(JSON.parse(server.log[0].body).refresh_token, 'RD1');
});

test('describe never leaks a token value', async () => {
  const dir = tempDir();
  const cred = path.join(dir, 'cred.json');
  fs.writeFileSync(cred, JSON.stringify({ refreshToken: 'R0' }));
  const auth = createAuth({ baseUrl: 'http://x', uid: 4, credentialFile: cred, fetchImpl: fakeServer().fetchImpl });
  await auth.token();
  const d = auth.describe();
  assert.equal(d.hasAccessToken, true);
  assert.equal(d.hasRefreshToken, true);
  assert.equal(d.uid, 4);
  const serialised = JSON.stringify(d);
  assert.equal(serialised.includes('A1'), false, 'access token must not appear');
  assert.equal(serialised.includes('R1'), false, 'refresh token must not appear');
});
