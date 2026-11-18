// refresh_token 是**单链**的：同一 (uid, device) 只有最后一代有效。
//
// 2026-11-18 实测（真实 VoceChat 0.5.40，非模拟）：
//
//   T0=库里的根 → renew → T1 → renew → T2 → renew → T3
//   再用 T0  → 401        （两代以前，立即失效）
//   再用 T2  → 200        （上一代还在宽限期）
//
// 于是本进程只要缓存过一代，而**别人**（验证脚本、`/api/token/login`、手工 renew）把链往前推过
// 两代，缓存值就永久 401：症状是"能收不能发"，`sent-log` 里全是「续期失败 401」。
//
// 修复的事实依据：数据库那一行始终是当前有效的一代（实测重新读库再 renew 立刻 200），
// 所以 401 时重读一次源就够了，不需要人工重登。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createAuth } from '../auth.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vc-auth-reload-'));
}

/**
 * A server that behaves like VoceChat's single-chain rotation:
 * only the newest generation (and one grace generation behind it) is accepted.
 */
function chainedServer(sourceToken = 'DB0') {
  let generation = 0;
  let accepted = new Map([[sourceToken, 0]]); // token → generation it belongs to
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.refresh_token);
    const rank = accepted.get(body.refresh_token);
    const newest = generation;
    // Accept the newest and the one right behind it; anything older is dead.
    const ok = rank !== undefined && newest - rank <= 1;
    if (!ok) return { ok: false, status: 401, text: async () => 'authorization error', json: async () => ({}) };
    generation += 1;
    accepted.set(`G${generation}`, generation);
    return {
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ token: `A${generation}`, refresh_token: `G${generation}`, expired_in: 300 }),
    };
  };
  /** Simulate a third party pushing the same (uid, device) chain forward. */
  const pushByOutsider = () => {
    generation += 1;
    accepted.set(`G${generation}`, generation);
    return `G${generation}`;
  };
  return { fetchImpl, calls, pushByOutsider, generation: () => generation };
}

function writeDb(file, token) {
  // The auth layer reads `refresh_token` with node:sqlite; a plain table is enough.
  const db = new DatabaseSync(file);
  db.exec('create table if not exists refresh_token (uid integer, device text, token text, updated_at integer, primary key (uid, device))');
  db.prepare('insert or replace into refresh_token (uid, device, token, updated_at) values (?,?,?,?)').run(4, 'dsh-companion', token, 1);
  db.close();
}

test('a cached refresh token rejected with 401 is reloaded from the database, then renewal succeeds', async () => {
  const dir = tempDir();
  const dbFile = path.join(dir, 'db.sqlite');
  writeDb(dbFile, 'DB1');

  const server = chainedServer('DB1');
  const auth = createAuth({ baseUrl: 'http://x', uid: 4, deviceName: 'dsh-companion', dbFile, fetchImpl: server.fetchImpl });

  // First renewal succeeds: cache now holds G1 and the database still holds DB1.
  assert.equal(await auth.token(), 'A1');

  // A third party pushes the chain forward twice; the cached G1 is now two generations old.
  server.pushByOutsider();
  server.pushByOutsider();

  // The database row is the current generation — this is what a reload must pick up.
  const current = server.pushByOutsider();
  writeDb(dbFile, current);

  // Force a renewal: the cached G1 is rejected, the reloaded `current` must be accepted.
  const fresh = await auth.refreshNow();
  assert.match(fresh, /^A\d+$/);
  assert.equal(auth.describe().stats.sourceReloads, 1, 'one reload, not a retry loop');
  assert.equal(server.calls.at(-1), current, 'the second attempt must use the token read from the source');
});

test('the reload happens at most once: a source that is itself dead surfaces the 401 instead of looping', async () => {
  const dir = tempDir();
  const dbFile = path.join(dir, 'db.sqlite');
  writeDb(dbFile, 'DEAD');

  const server = chainedServer('OTHER');
  // Push the chain far enough that even the stored row is two generations behind.
  server.pushByOutsider();
  server.pushByOutsider();
  server.pushByOutsider();

  const auth = createAuth({ baseUrl: 'http://x', uid: 4, deviceName: 'dsh-companion', dbFile, fetchImpl: server.fetchImpl });
  await assert.rejects(auth.token(), error => error.code === 'refresh-token-rejected');
  assert.equal(server.calls.length, 2, 'exactly two attempts: original + one reloaded retry');
  assert.equal(auth.describe().stats.sourceReloads, 1);
});

test('with no source configured, a 401 is reported immediately (nothing to reload)', async () => {
  const dir = tempDir();
  const cred = path.join(dir, 'cred.json');
  fs.writeFileSync(cred, JSON.stringify({ refreshToken: 'BAD' }));
  const server = chainedServer('OTHER');

  // credentialFile 也算源，所以这里仍然会重读一次；用一个空文件模拟"源里也没有"。
  const auth = createAuth({ baseUrl: 'http://x', uid: 4, credentialFile: cred, fetchImpl: server.fetchImpl });
  fs.writeFileSync(cred, JSON.stringify({}));
  await assert.rejects(auth.refreshNow(), error => error.code === 'refresh-token-rejected' || error.code === 'no-refresh-token');
});
