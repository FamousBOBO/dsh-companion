import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createAuth } from '../auth.mjs';

/**
 * The DB lookup must be pinned to OUR device.
 *
 * `refresh_token` is keyed on `(uid, device)`, so one uid can hold several rows — phone, browser,
 * this plugin, a one-off evidence script. The old query was
 * `where uid = ? order by updated_at desc limit 1`, i.e. "whichever client touched it last".
 *
 * Measured failure 2026-11-17: the host-side verification script used that query for uid=1 and
 * called `/api/token/renew`; renew ROTATES the refresh token, so each run pushed the owner's phone
 * one generation further out until every phone request returned 401 — "can log in, cannot send
 * messages or change the avatar". Two clients renewing each other's credentials is also the
 * intermittent-401 pattern that is much harder to diagnose than a loud failure.
 */

/** A db.sqlite with just the table this code reads. */
function fixtureDb(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-auth-'));
  const file = path.join(dir, 'db.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`
    create table refresh_token (
      uid integer not null,
      device text not null,
      token text not null,
      created_at text,
      updated_at text,
      previous_token text,
      previous_token_valid_until integer
    );
  `);
  const insert = db.prepare('insert into refresh_token (uid, device, token, updated_at) values (?, ?, ?, ?)');
  for (const row of rows) insert.run(row.uid, row.device, row.token, row.updatedAt ?? '2026-11-17 00:00:00');
  db.close();
  return file;
}

test('with deviceName set, only that device row is used', async () => {
  // The other row is NEWER, so the old query would have picked it.
  const dbFile = fixtureDb([
    { uid: 1, device: 'flutter', token: 'PHONE-TOKEN', updatedAt: '2026-11-17 13:00:00' },
    { uid: 1, device: 'web:abc', token: 'BROWSER-TOKEN', updatedAt: '2026-11-17 12:00:00' },
  ]);

  const sent = [];
  const auth = createAuth({
    baseUrl: 'http://127.0.0.1:1',
    uid: 1,
    deviceName: 'flutter',
    dbFile,
    fetchImpl: async (_url, init) => {
      sent.push(JSON.parse(init.body));
      return {
        ok: true,
        status: 200,
        json: async () => ({ token: 'ACCESS', refresh_token: 'ROTATED', expired_in: 300 }),
      };
    },
    log: () => {},
  });

  await auth.token();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].refresh_token, 'PHONE-TOKEN', 'must use the named device, not the newest row');
});

test('with deviceName set, a missing row fails instead of borrowing another client', async () => {
  const dbFile = fixtureDb([
    { uid: 1, device: 'flutter', token: 'PHONE-TOKEN' },
    { uid: 1, device: 'web:abc', token: 'BROWSER-TOKEN' },
  ]);

  let fetched = 0;
  const auth = createAuth({
    baseUrl: 'http://127.0.0.1:1',
    uid: 1,
    deviceName: 'dsh-companion', // not present
    dbFile,
    fetchImpl: async () => {
      fetched += 1;
      return { ok: true, status: 200, json: async () => ({ token: 'x' }) };
    },
    log: () => {},
  });

  await assert.rejects(() => auth.token(), error => {
    assert.equal(error.code, 'no-refresh-token');
    // The message must name the situation, otherwise the next person borrows a row again.
    assert.match(error.message, /refresh_token/);
    return true;
  });
  assert.equal(fetched, 0, 'must not renew at all when it has no credential of its own');
});

test('without deviceName the old behaviour is kept, but it is no longer what production uses', async () => {
  const dbFile = fixtureDb([
    { uid: 1, device: 'flutter', token: 'OLD' },
    { uid: 1, device: 'web:abc', token: 'NEW', updatedAt: '2026-11-17 13:00:00' },
  ]);

  const sent = [];
  const auth = createAuth({
    baseUrl: 'http://127.0.0.1:1',
    uid: 1,
    dbFile,
    fetchImpl: async (_url, init) => {
      sent.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ token: 'ACCESS', refresh_token: 'R', expired_in: 300 }) };
    },
    log: () => {},
  });

  await auth.token();
  assert.equal(sent[0].refresh_token, 'NEW', 'nearest-updated row when nothing is pinned');
});

test('a credential file still wins over the database', async () => {
  const dbFile = fixtureDb([{ uid: 4, device: 'dsh-companion', token: 'FROM-DB' }]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-auth-file-'));
  const credentialFile = path.join(dir, 'cred.json');
  fs.writeFileSync(credentialFile, JSON.stringify({ refreshToken: 'FROM-FILE' }));

  const sent = [];
  const auth = createAuth({
    baseUrl: 'http://127.0.0.1:1',
    uid: 4,
    deviceName: 'dsh-companion',
    dbFile,
    credentialFile,
    fetchImpl: async (_url, init) => {
      sent.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ token: 'A', refresh_token: 'R', expired_in: 300 }) };
    },
    log: () => {},
  });

  await auth.token();
  assert.equal(sent[0].refresh_token, 'FROM-FILE');
  // And the rotation is written back so the next run does not read a stale value.
  assert.equal(JSON.parse(fs.readFileSync(credentialFile, 'utf8')).refreshToken, 'R');
});
